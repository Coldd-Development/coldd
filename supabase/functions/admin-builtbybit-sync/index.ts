// supabase/functions/admin-builtbybit-sync/index.ts
//
// Deploy with:
//   supabase functions deploy admin-builtbybit-sync
//
// Pulls our BuiltByBit listings, purchases, reviews and latest versions through
// the Ultimate API (https://api.builtbybit.com/v1) into bbb_purchases,
// bbb_reviews, bbb_resource_snapshots and bbb_resource_state (see
// supabase/builtbybit.sql), which the admin Marketplaces / Dashboard / Analytics
// panels read directly.
//
// Secret (a Private token from https://builtbybit.com/account/api):
//   supabase secrets set BUILTBYBIT_API_TOKEN=...
// Returns { ok: true, configured: false } when it is not set, so the panels show a
// clean "not connected" state instead of an error.
//
// The account owns hundreds of listings, so one call cannot read everything. A sync
// is therefore RESUMABLE: each call works through a queue (listings whose stored
// purchases/reviews lag BuiltByBit's own counters, or that still have pending
// purchases) for at most BUDGET_MS, saves each listing as it goes, and returns how
// many are still `remaining`. The admin panel keeps calling with continue=true until
// that reaches 0.
//
// Body:
//   { action: "sync", continue?: boolean }
//   { action: "reply_review", resourceId, reviewId, message }
//
// The API's response field names are read tolerantly (pick()) and the keys actually
// seen are returned as `seen`. Admin only, like the other admin-* functions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";
const API = "https://api.builtbybit.com/v1";
const MAX_PAGES = 60;
const MAX_WAIT_MS = 15000;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 15000;
const BUDGET_MS = 100000; // well inside the edge function wall-clock limit
const POOL = 2; // BuiltByBit rate-limits hard; fewer parallel calls beat constant 429s
const RECHECK_MS = 20 * 60 * 1000; // a listing is not re-read more often than this
// A listing whose only reason to be re-read is that it holds pending purchases (the
// stored count already matches BuiltByBit's) is checked far less often.
const PENDING_RECHECK_MS = 6 * 60 * 60 * 1000;

let DEADLINE = Infinity;
// Shared by every worker: once one request is told to slow down, all of them wait.
let COOLDOWN_UNTIL = 0;
function overBudget() { return Date.now() > DEADLINE; }

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

function pick(o: Obj | null | undefined, keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
function str(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as Obj;
    return str(pick(o, ["title", "name", "label"]));
  }
  return v === undefined || v === null || v === "" ? null : String(v);
}
function numOr(v: unknown, d: number | null = null): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
// BuiltByBit dates are unix seconds; tolerate milliseconds and ISO strings too.
function toIso(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function norm(s: string | null | undefined): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

class ApiFail extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function bbb(token: string, method: string, path: string, body?: Obj): Promise<Obj> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (overBudget()) throw new ApiFail(408, "Ran out of time.");
    const pause = COOLDOWN_UNTIL - Date.now();
    if (pause > 0) {
      if (Date.now() + pause > DEADLINE) throw new ApiFail(408, "Ran out of time.");
      await new Promise((r) => setTimeout(r, pause));
    }
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(API + path, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method,
        headers: {
          "Authorization": `Private ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      console.error("[admin-builtbybit-sync]", method, path, "failed after", Date.now() - t0, "ms:", (e as Error).name);
      throw new ApiFail(504, "BuiltByBit did not answer in time.");
    }
    if (res.status === 429) {
      const hinted = Number(res.headers.get("Retry-After") ?? "0") * 1000;
      const wait = Math.min(MAX_WAIT_MS, Math.max(hinted, 1000 * 2 ** attempt));
      COOLDOWN_UNTIL = Math.max(COOLDOWN_UNTIL, Date.now() + wait);
      console.warn("[admin-builtbybit-sync] 429 on", path, "cooling down", wait, "ms");
      if (attempt === MAX_ATTEMPTS - 1) throw new ApiFail(429, "BuiltByBit rate limit hit.");
      continue;
    }
    const text = await res.text();
    let data: Obj = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
    if (!res.ok || data?.result === "error") {
      const msg = data?.error?.message || data?.message || `BuiltByBit returned ${res.status}.`;
      console.warn("[admin-builtbybit-sync]", method, path, res.status, Date.now() - t0, "ms", String(msg).slice(0, 120));
      throw new ApiFail(res.status, String(msg));
    }
    return data;
  }
  throw new ApiFail(500, "BuiltByBit request failed.");
}

// Walks ?page=N until a page comes back empty (or repeats), capped.
async function listAll(token: string, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await bbb(token, "GET", `${path}${sep}page=${page}`);
    const rows: Obj[] = Array.isArray(data?.data) ? data.data : [];
    if (!rows.length) break;
    // Guard against an API that ignores `page` and repeats the same rows.
    const sig = JSON.stringify(rows[0]) + "|" + rows.length;
    if (seen.has(sig)) break;
    seen.add(sig);
    out.push(...rows);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: profile, error: profileErr } = await admin
      .from("profiles").select("is_admin").eq("id", userData.user.id).single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const token = Deno.env.get("BUILTBYBIT_API_TOKEN");
    if (!token) return json({ ok: true, configured: false });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "sync");

    // ---- reply to a review --------------------------------------------------
    if (action === "reply_review") {
      const resourceId = String(body.resourceId || "").replace(/[^0-9]/g, "");
      const reviewId = String(body.reviewId || "").replace(/[^0-9]/g, "");
      const message = String(body.message || "").trim();
      if (!resourceId || !reviewId) return json({ ok: false, error: "Missing review." }, 400);
      if (message.length < 2 || message.length > 5000) return json({ ok: false, error: "Reply must be 2 to 5000 characters." }, 400);
      DEADLINE = Date.now() + 30000;
      try {
        await bbb(token, "PATCH", `/resources/${resourceId}/reviews/${reviewId}`, { response: message });
      } catch (e) {
        const f = e as ApiFail;
        console.error("[admin-builtbybit-sync] reply failed:", f.status, f.message);
        return json({ ok: false, error: `BuiltByBit refused the reply (${f.status}): ${f.message}` }, 502);
      }
      await admin.from("bbb_reviews").update({ response: message }).eq("review_id", reviewId);
      return json({ ok: true, configured: true });
    }

    // ---- sync ---------------------------------------------------------------
    DEADLINE = Date.now() + BUDGET_MS;
    const errors: string[] = [];
    const seen: Record<string, string[]> = {};
    const noteKeys = (kind: string, row: Obj | undefined) => {
      if (row && !seen[kind]) seen[kind] = Object.keys(row);
    };
    const today = new Date().toISOString().slice(0, 10);

    // 1) The listing list. A first call reads it from BuiltByBit and saves it; later
    //    calls (continue=true) reuse today's saved copy, which saves ~dozens of requests.
    let listings: Obj[] = []; // normalised snapshot rows
    if (body.continue) {
      const { data } = await admin.from("bbb_resource_snapshots")
        .select("resource_id, title, price, currency, downloads, purchases, reviews, rating, category")
        .eq("snapshot_date", today).limit(5000);
      listings = data ?? [];
    }
    if (!listings.length) {
      let rows: Obj[];
      try {
        rows = await listAll(token, "/resources/owned");
      } catch (e) {
        const f = e as ApiFail;
        if (f.status === 401 || f.status === 403) {
          return json({ ok: false, error: "BuiltByBit rejected the token. Create a new Private token and set BUILTBYBIT_API_TOKEN again." }, 502);
        }
        console.error("[admin-builtbybit-sync] listings failed:", f.status, f.message);
        return json({ ok: false, error: `Could not read your BuiltByBit listings (${f.status}): ${f.message}` }, 502);
      }
      noteKeys("resource", rows[0]);
      try {
        const collab = await listAll(token, "/resources/collaborated");
        const have = new Set(rows.map((r) => String(pick(r, ["resource_id", "id"]))));
        for (const c of collab) if (!have.has(String(pick(c, ["resource_id", "id"])))) rows.push(c);
      } catch { /* collaborated is optional */ }

      listings = rows.map((r) => ({
        resource_id: str(pick(r, ["resource_id", "id"])),
        snapshot_date: today,
        title: str(pick(r, ["title", "name"])),
        price: numOr(pick(r, ["price"])),
        currency: str(pick(r, ["currency"])),
        downloads: numOr(pick(r, ["download_count", "downloads"])),
        purchases: numOr(pick(r, ["purchase_count", "purchases"])),
        reviews: numOr(pick(r, ["review_count", "reviews"])),
        rating: numOr(pick(r, ["review_average", "rating", "average_rating"])),
        category: str(pick(r, ["category_title", "category", "category_name"])),
        synced_at: new Date().toISOString(),
      })).filter((x) => x.resource_id);
      for (let i = 0; i < listings.length; i += 500) {
        const { error } = await admin.from("bbb_resource_snapshots")
          .upsert(listings.slice(i, i + 500), { onConflict: "resource_id,snapshot_date" });
        if (error) errors.push("save listings: " + error.message);
      }
    }

    // 2) Work queue: listings whose stored purchases/reviews lag BuiltByBit's counters,
    //    or that still have pending purchases. Nothing is re-read within RECHECK_MS.
    const { data: countRows } = await admin.rpc("bbb_detail_counts");
    const stored = new Map<string, Obj>();
    for (const c of (countRows ?? []) as Obj[]) stored.set(String(c.resource_id), c);
    const { data: stateRows } = await admin.from("bbb_resource_state").select("resource_id, detail_at").limit(5000);
    const state = new Map<string, string | null>();
    for (const s of (stateRows ?? []) as Obj[]) state.set(String(s.resource_id), s.detail_at);

    const nowMs = Date.now();
    const lagOf = (l: Obj) => {
      const st = stored.get(String(l.resource_id)) ?? { purchases_n: 0, pending_n: 0, reviews_n: 0 };
      return {
        missingP: Math.max(0, (l.purchases ?? 0) - Number(st.purchases_n)),
        pending: Number(st.pending_n) > 0,
        needR: (l.reviews ?? 0) > Number(st.reviews_n),
      };
    };
    const queue = listings.filter((l) => {
      const done = state.get(String(l.resource_id));
      const age = done ? nowMs - new Date(done).getTime() : Infinity;
      const g = lagOf(l);
      if (g.missingP > 0 || g.needR) return age >= RECHECK_MS;
      return g.pending && age >= PENDING_RECHECK_MS;
    }).sort((a, b) => {
      // Listings that are missing purchases come first, biggest gap first.
      const ga = lagOf(a), gb = lagOf(b);
      return (gb.missingP - ga.missingP) || ((b.purchases ?? 0) - (a.purchases ?? 0));
    });

    let next = 0;
    let processed = 0;
    async function processListing(l: Obj) {
      const rid = String(l.resource_id);
      const title = l.title ?? `Resource ${rid}`;
      const st = stored.get(rid) ?? { purchases_n: 0, pending_n: 0, reviews_n: 0 };
      let note: string | null = null;
      let retryLater = false; // a rate limit / timeout: leave it at the front of the queue

      if ((l.purchases ?? 0) > Number(st.purchases_n) || Number(st.pending_n) > 0) {
        try {
          const ps = await listAll(token!, `/resources/${rid}/purchases`);
          noteKeys("purchase", ps[0]);
          const rows: Obj[] = [];
          for (const p of ps) {
            const pid = str(pick(p, ["purchase_id", "id"]));
            const at = toIso(pick(p, ["purchase_date", "date", "created_date", "creation_date", "purchased_at"]));
            if (!pid || !at) continue;
            rows.push({
              purchase_id: `${rid}:${pid}`,
              resource_id: rid,
              resource_title: title,
              purchaser_id: str(pick(p, ["purchaser_id", "member_id", "buyer_id"])),
              price: numOr(pick(p, ["price", "amount", "paid"]), 0),
              currency: str(pick(p, ["currency"])) ?? l.currency,
              status: str(pick(p, ["status"])),
              renewal: Boolean(pick(p, ["renewal", "is_renewal"])),
              purchased_at: at,
            });
          }
          for (let i = 0; i < rows.length; i += 500) {
            const { error } = await admin.from("bbb_purchases").upsert(rows.slice(i, i + 500), { onConflict: "purchase_id" });
            if (error) { errors.push(`save purchases ${rid}: ${error.message}`); note = "purchases save failed"; }
          }
        } catch (e) {
          const f = e as ApiFail;
          if (f.status === 408) throw e; // out of time: leave it in the queue
          note = `purchases ${f.status}`;
          if (f.status === 429 || f.status === 504) retryLater = true;
          errors.push(`purchases ${rid}: ${f.message}`);
        }
      }

      if ((l.reviews ?? 0) > Number(st.reviews_n)) {
        try {
          const rv = await listAll(token!, `/resources/${rid}/reviews`);
          noteKeys("review", rv[0]);
          const rows: Obj[] = [];
          for (const x of rv) {
            const id = str(pick(x, ["review_id", "id"]));
            if (!id) continue;
            rows.push({
              review_id: id,
              resource_id: rid,
              resource_title: title,
              reviewer_id: str(pick(x, ["reviewer_id", "member_id", "author_id"])),
              rating: numOr(pick(x, ["rating", "score"])),
              message: str(pick(x, ["message", "text", "content"])),
              response: str(pick(x, ["response", "reply"])),
              reviewed_at: toIso(pick(x, ["review_date", "date", "created_date"])),
            });
          }
          if (rows.length) {
            const { error } = await admin.from("bbb_reviews").upsert(rows, { onConflict: "review_id" });
            if (error) errors.push(`save reviews ${rid}: ${error.message}`);
          }
        } catch (e) {
          const f = e as ApiFail;
          if (f.status === 408) throw e;
          note = (note ? note + "; " : "") + `reviews ${f.status}`;
          if (f.status === 429 || f.status === 504) retryLater = true;
          errors.push(`reviews ${rid}: ${f.message}`);
        }
      }

      await admin.from("bbb_resource_state").upsert({ resource_id: rid, detail_at: retryLater ? null : new Date().toISOString(), note }, { onConflict: "resource_id" });
      if (!retryLater) processed++;
    }
    async function worker() {
      while (next < queue.length && !overBudget()) {
        const l = queue[next++];
        try { await processListing(l); } catch (e) { if ((e as ApiFail).status !== 408) errors.push(String((e as Error).message)); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));
    const remaining = Math.max(0, queue.length - processed);

    // 3) Latest version, only for listings that match one of our own products by title.
    if (!overBudget()) {
      try {
        const { data: prods } = await admin.from("products").select("title");
        const ours = new Set((prods ?? []).map((p: Obj) => norm(p.title)));
        const matched = listings.filter((l) => ours.has(norm(l.title)));
        for (const l of matched) {
          if (overBudget()) break;
          try {
            const v = await bbb(token, "GET", `/resources/${l.resource_id}/versions/latest`);
            const vd: Obj = Array.isArray(v?.data) ? v.data[0] : v?.data;
            noteKeys("version", vd);
            const ver = str(pick(vd, ["name", "version", "title"]));
            if (ver) await admin.from("bbb_resource_snapshots").update({ latest_version: ver }).eq("resource_id", l.resource_id).eq("snapshot_date", today);
          } catch (e) { errors.push(`version ${l.resource_id}: ${(e as Error).message}`); }
        }
      } catch (e) { errors.push("versions: " + (e as Error).message); }
    }

    if (errors.length) console.warn("[admin-builtbybit-sync] partial:", errors.slice(0, 10));
    return json({
      ok: true,
      configured: true,
      syncedAt: new Date().toISOString(),
      listings: listings.length,
      processed,
      remaining,
      seen,
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    console.error("[admin-builtbybit-sync] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
