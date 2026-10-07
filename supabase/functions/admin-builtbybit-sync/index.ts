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
    const res = await fetch(API + path, {
      method,
      headers: {
        "Authorization": `Private ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
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
    const errors: string[] = [];
    const seen: Record<string, string[]> = {};
    const noteKeys = (kind: string, row: Obj | undefined) => {
      if (row && !seen[kind]) seen[kind] = Object.keys(row);
    };

    let resources: Obj[];
    try {
      resources = await listAll(token, "/resources/owned");
    } catch (e) {
      const f = e as ApiFail;
      if (f.status === 401 || f.status === 403) {
        return json({ ok: false, error: "BuiltByBit rejected the token. Create a new Private token and set BUILTBYBIT_API_TOKEN again." }, 502);
      }
      console.error("[admin-builtbybit-sync] resources failed:", f.status, f.message);
      return json({ ok: false, error: `Could not read your BuiltByBit listings (${f.status}): ${f.message}` }, 502);
    }
    noteKeys("resource", resources[0]);

    const today = new Date().toISOString().slice(0, 10);
    const snapshots: Obj[] = [];
    const purchaseRows: Obj[] = [];
    const reviewRows: Obj[] = [];

    for (const r of resources) {
      const rid = str(pick(r, ["resource_id", "id"]));
      if (!rid) continue;
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
