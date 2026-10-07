// supabase/functions/admin-builtbybit-sync/index.ts
//
// Deploy with:
//   supabase functions deploy admin-builtbybit-sync
//
// Pulls our BuiltByBit listings, purchases, reviews and latest versions through
// the Ultimate API (https://api.builtbybit.com/v1) into bbb_purchases,
// bbb_reviews and bbb_resource_snapshots (see supabase/builtbybit.sql), which the
// admin Marketplaces / Dashboard / Analytics panels read directly.
//
// Secret (a Private token from https://builtbybit.com/account/api):
//   supabase secrets set BUILTBYBIT_API_TOKEN=...
// Returns { ok: true, configured: false } when it is not set, so the panels show a
// clean "not connected" state instead of an error.
//
// Body:
//   { action: "sync" }                                   (default)
//   { action: "reply_review", resourceId, reviewId, message }
//
// The API's response field names are read tolerantly (pick()) and the keys that
// were actually seen are returned as `seen`, so a mismatch is visible at a glance.
// Admin only, like the other admin-* functions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";
const API = "https://api.builtbybit.com/v1";
const MAX_PAGES = 40;
const MAX_WAIT_MS = 8000;
const REQUEST_TIMEOUT_MS = 15000;
const BUDGET_MS = 100000; // stay well inside the edge function wall-clock limit
const POOL = 3;

let DEADLINE = Infinity;
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

class ApiFail extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function bbb(token: string, method: string, path: string, body?: Obj): Promise<Obj> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (overBudget()) throw new ApiFail(408, "Ran out of time.");
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
    console.log("[admin-builtbybit-sync]", method, path, res.status, Date.now() - t0, "ms");
    if (res.status === 429) {
      const wait = Math.min(MAX_WAIT_MS, Math.max(500, Number(res.headers.get("Retry-After") ?? "1") * 1000));
      if (attempt === 2) throw new ApiFail(429, "BuiltByBit rate limit hit.");
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    let data: Obj = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
    if (!res.ok || data?.result === "error") {
      const msg = data?.error?.message || data?.message || `BuiltByBit returned ${res.status}.`;
      throw new ApiFail(res.status, String(msg));
    }
    return data;
  }
  throw new ApiFail(500, "BuiltByBit request failed.");
}

// Walks ?page=N until a page comes back empty (or short of a repeat), capped.
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

const AUTHOR_KEYS = ["author_id", "author_member_id", "member_id", "owner_id"];

async function ownListings(token: string, noteKeys: (k: string, r: Obj | undefined) => void): Promise<Obj[]> {
  const me = await bbb(token, "GET", "/members/self");
  const meRow: Obj = Array.isArray(me?.data) ? me.data[0] : me?.data;
  noteKeys("member", meRow);
  const selfId = str(pick(meRow, ["member_id", "id"]));
  if (!selfId) throw new ApiFail(502, "Could not read your BuiltByBit member id.");

  const byId = new Map<string, Obj>();
  const add = (rows: Obj[]) => { for (const r of rows) { const id = str(pick(r, ["resource_id", "id"])); if (id && !byId.has(id)) byId.set(id, r); } };

  // 1) everything published under our author id
  try { add(await listAll(token, `/resources/authors/${selfId}`)); } catch (e) { console.warn("[admin-builtbybit-sync] authors list failed:", (e as Error).message); }
  // 2) listings we collaborate on
  try { add(await listAll(token, "/resources/collaborated")); } catch (e) { console.warn("[admin-builtbybit-sync] collaborated list failed:", (e as Error).message); }
  // 3) fallback: the bought list, keeping only rows we authored
  if (!byId.size) {
    const owned = await listAll(token, "/resources/owned");
    noteKeys("owned", owned[0]);
    const withAuthor = owned.filter((r) => AUTHOR_KEYS.some((k) => r[k] !== undefined && r[k] !== null));
    if (!withAuthor.length) throw new ApiFail(502, "Could not tell which BuiltByBit listings are yours.");
    add(withAuthor.filter((r) => AUTHOR_KEYS.some((k) => String(r[k]) === selfId)));
  }
  return [...byId.values()];
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

    // ---- full sync ----------------------------------------------------------
    DEADLINE = Date.now() + BUDGET_MS;
    const errors: string[] = [];
    const seen: Record<string, string[]> = {};
    const noteKeys = (kind: string, row: Obj | undefined) => {
      if (row && !seen[kind]) seen[kind] = Object.keys(row);
    };

    // "/resources/owned" is what this account has BOUGHT (hundreds of other sellers'
    // products), not what it sells. Our own listings are the ones we author (plus any
    // we collaborate on), so work out our member id and filter to those.
    let resources: Obj[];
    try {
      resources = await ownListings(token, noteKeys);
    } catch (e) {
      const f = e as ApiFail;
      if (f.status === 401 || f.status === 403) {
        return json({ ok: false, error: "BuiltByBit rejected the token. Create a new Private token and set BUILTBYBIT_API_TOKEN again." }, 502);
      }
      console.error("[admin-builtbybit-sync] listings failed:", f.status, f.message);
      return json({ ok: false, error: `Could not read your BuiltByBit listings (${f.status}): ${f.message}` }, 502);
    }
    noteKeys("resource", resources[0]);

    // Earlier versions crawled every product this account has bought. Drop anything that
    // is not one of our own listings.
    {
      const mine = resources.map((r) => str(pick(r, ["resource_id", "id"]))).filter((x): x is string => !!x);
      if (mine.length) {
        const list = `(${mine.map((i) => '"' + i.replace(/[^0-9a-zA-Z_-]/g, "") + '"').join(",")})`;
        for (const t of ["bbb_purchases", "bbb_reviews", "bbb_resource_snapshots"]) {
          const { error } = await admin.from(t).delete().not("resource_id", "in", list);
          if (error) errors.push("cleanup " + t + ": " + error.message);
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const snapshots: Obj[] = [];
    const purchaseRows: Obj[] = [];
    const reviewRows: Obj[] = [];

    // Save the bare listings straight away (title, price, download and rating totals
    // BuiltByBit already gives us) so the panel has something even if the detail
    // calls below run out of time.
    {
      const basic = resources.map((r) => ({
        resource_id: str(pick(r, ["resource_id", "id"])),
        snapshot_date: today,
        title: str(pick(r, ["title", "name"])),
        price: numOr(pick(r, ["price"])),
        currency: str(pick(r, ["currency"])),
        downloads: numOr(pick(r, ["download_count", "downloads"])),
        purchases: numOr(pick(r, ["purchase_count", "purchases"])),
        reviews: numOr(pick(r, ["review_count", "reviews"])),
        rating: numOr(pick(r, ["review_average", "rating", "average_rating"])),
        synced_at: new Date().toISOString(),
      })).filter((x) => x.resource_id);
      if (basic.length) {
        const { error } = await admin.from("bbb_resource_snapshots").upsert(basic, { onConflict: "resource_id,snapshot_date" });
        if (error) errors.push("save listings: " + error.message);
      }
    }

    async function processResource(r: Obj) {
      const rid = str(pick(r, ["resource_id", "id"]));
      if (!rid) return;
      const title = str(pick(r, ["title", "name"])) ?? `Resource ${rid}`;
      const currency = str(pick(r, ["currency"]));

      let latestVersion: string | null = null;
      try {
        const v = await bbb(token, "GET", `/resources/${rid}/versions/latest`);
        const vd: Obj = Array.isArray(v?.data) ? v.data[0] : v?.data;
        noteKeys("version", vd);
        latestVersion = str(pick(vd, ["name", "version", "title"]));
      } catch (e) { errors.push(`version ${rid}: ${(e as Error).message}`); }

      try {
        const ps = await listAll(token, `/resources/${rid}/purchases`);
        noteKeys("purchase", ps[0]);
        for (const p of ps) {
          const pid = str(pick(p, ["purchase_id", "id"]));
          const at = toIso(pick(p, ["purchase_date", "date", "created_date", "creation_date", "purchased_at"]));
          if (!pid || !at) continue;
          purchaseRows.push({
            purchase_id: `${rid}:${pid}`,
            resource_id: rid,
            resource_title: title,
            purchaser_id: str(pick(p, ["purchaser_id", "member_id", "buyer_id"])),
            price: numOr(pick(p, ["price", "amount", "paid"]), 0),
            currency: str(pick(p, ["currency"])) ?? currency,
            status: str(pick(p, ["status"])),
            renewal: Boolean(pick(p, ["renewal", "is_renewal"])),
            purchased_at: at,
          });
        }
      } catch (e) { errors.push(`purchases ${rid}: ${(e as Error).message}`); }

      let reviewCount = numOr(pick(r, ["review_count", "reviews"]));
      let rating = numOr(pick(r, ["review_average", "rating", "average_rating"]));
      try {
        const rv = await listAll(token, `/resources/${rid}/reviews`);
        noteKeys("review", rv[0]);
        for (const x of rv) {
          const id = str(pick(x, ["review_id", "id"]));
          if (!id) continue;
          reviewRows.push({
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
        if (reviewCount == null) reviewCount = rv.length;
        if (rating == null && rv.length) {
          const rs = rv.map((x) => numOr(pick(x, ["rating", "score"]))).filter((n): n is number => n != null);
          if (rs.length) rating = Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100;
        }
      } catch (e) { errors.push(`reviews ${rid}: ${(e as Error).message}`); }

      snapshots.push({
        resource_id: rid,
        snapshot_date: today,
        title,
        price: numOr(pick(r, ["price"])),
        currency,
        downloads: numOr(pick(r, ["download_count", "downloads"])),
        purchases: numOr(pick(r, ["purchase_count", "purchases"])),
        reviews: reviewCount,
        rating,
        latest_version: latestVersion,
        synced_at: new Date().toISOString(),
      });
    }

    let next = 0;
    async function worker() {
      while (next < resources.length && !overBudget()) await processResource(resources[next++]);
    }
    await Promise.all(Array.from({ length: Math.min(POOL, resources.length) }, worker));
    if (next < resources.length) errors.push("Stopped early: ran out of time before every listing was read.");

    if (purchaseRows.length) {
      const { error } = await admin.from("bbb_purchases").upsert(purchaseRows, { onConflict: "purchase_id" });
      if (error) errors.push("save purchases: " + error.message);
    }
    if (reviewRows.length) {
      const { error } = await admin.from("bbb_reviews").upsert(reviewRows, { onConflict: "review_id" });
      if (error) errors.push("save reviews: " + error.message);
    }
    if (snapshots.length) {
      const { error } = await admin.from("bbb_resource_snapshots").upsert(snapshots, { onConflict: "resource_id,snapshot_date" });
      if (error) errors.push("save snapshots: " + error.message);
    }

    if (errors.length) console.warn("[admin-builtbybit-sync] partial:", errors.slice(0, 10));
    return json({
      ok: true,
      configured: true,
      syncedAt: new Date().toISOString(),
      counts: { resources: snapshots.length, purchases: purchaseRows.length, reviews: reviewRows.length },
      seen,
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    console.error("[admin-builtbybit-sync] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
