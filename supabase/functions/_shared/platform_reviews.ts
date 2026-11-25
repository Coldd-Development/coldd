// Reviews left on BuiltByBit, the Roblox Creator Store and Parcel, stored in public.reviews
// (admin-bbb-v2-sync, creator-store-sync and the Parcel Discord feed call this).
//
// Matching uses the admin's sales rules (admin.js matchProduct), against the products on the
// site (is_active): a BuiltByBit listing imported through bbb_imports is that product; else the
// listing name, after product_name_aliases, exact first, then one name's words all inside the
// other with only generic extra words, numbers agreeing. A wrong match is worse than none.
//
// A review with no product is stored hidden (hidden_reason 'unmatched'); sweepUnmatched runs
// every sync and publishes it as soon as a product with that name is on the site. BuiltByBit
// passes skipUnmatched instead: a listing that is not on the catalog keeps no reviews here
// (the sync re-reads every review each run, so one is imported once its product is added).
// New reviews have admin_reviewed_at null (the admin's "New reviews needing a look" task);
// a backfill passes markSeen so old reviews never raise it.

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export type PlatformReview = {
  external_id: string;
  source: "BuiltByBit" | "Creator Store" | "Parcel";
  listing_name: string;
  listing_ref: string;
  bbb_resource_id?: number | null;
  price_usd?: number | null;
  stars: number | null;
  recommended: boolean | null;
  text: string;
  user_name: string | null;
  avatar_url: string | null;
  reply: string | null;
  reply_at: string | null;
  created_at: string;
};

const untag = (s: unknown) => String(s ?? "").replace(/^\s*(?:\[[^\]]*\]\s*)+/, "");
const nrm = (s: unknown) => untag(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
const STOP = ["the", "a", "an", "and", "of", "for", "with", "roblox", "asset", "assets"];
const SAME: Record<string, string> = { bundle: "pack", bundles: "pack", packs: "pack", kit: "pack" };
const GENERIC = ["pack", "vfx", "template", "templates", "system", "map", "game", "full", "complete", "mega", "set", "collection",
  "model", "models", "animation", "animations", "effect", "effects", "edition", "version", "premium", "ultimate", "hd", "free", "custom", "scripted"];

function words(s: unknown): string[] {
  const out: string[] = [];
  untag(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").forEach((w0) => {
    const w = SAME[w0] || w0;
    if (w && !STOP.includes(w) && !out.includes(w)) out.push(w);
  });
  return out;
}
function extraOk(longer: string, shorter: string) {
  const rest = longer.replace(shorter, "");
  if (!/\d/.test(rest)) return true;
  return rest.replace(/\d+/g, "").length >= 4;
}

type Prod = { id: string; n: string; w: string[] };
export type Matcher = { match: (r: { listing_name: string; bbb_resource_id?: number | null; price_usd?: number | null }) => string | null };

export async function buildMatcher(admin: Obj): Promise<Matcher> {
  const [prodsQ, aliasQ, importsQ] = await Promise.all([
    admin.from("products").select("id, title").eq("is_active", true).limit(20000),
    admin.from("product_name_aliases").select("alias, canonical, price_usd").limit(20000),
    admin.from("bbb_imports").select("resource_id, product_id").limit(20000),
  ]);
  const prods: Prod[] = ((prodsQ.data ?? []) as Obj[]).map((p) => ({ id: String(p.id), n: nrm(p.title), w: words(p.title) }));
  const active = new Set(prods.map((p) => p.id));
  const imported = new Map<number, string>();
  for (const r of (importsQ.data ?? []) as Obj[]) if (r.product_id && active.has(String(r.product_id))) imported.set(Number(r.resource_id), String(r.product_id));
  const alias = new Map<string, { any: string | null; priced: Array<{ price: number; name: string }> }>();
  for (const r of (aliasQ.data ?? []) as Obj[]) {
    if (!r.alias || !r.canonical) continue;
    const k = nrm(r.alias);
    const e = alias.get(k) ?? { any: null, priced: [] };
    if (r.price_usd != null && Number(r.price_usd) > 0) e.priced.push({ price: Number(r.price_usd), name: String(r.canonical) });
    else e.any = String(r.canonical);
    alias.set(k, e);
  }
  const canon = (t: string, usd?: number | null) => {
    const e = alias.get(nrm(t));
    if (!e) return untag(t);
    if (usd && usd > 0) for (const p of e.priced) if (Math.abs(usd - p.price) <= Math.max(0.5, p.price * 0.1)) return p.name;
    return e.any || untag(t);
  };
  const byName = (title0: string, usd?: number | null): string | null => {
    const title = canon(title0, usd);
    const t = nrm(title);
    if (!t) return null;
    const exact = prods.find((x) => x.n === t);
    if (exact) return exact.id;
    const tw = words(title);
    if (!tw.length) return null;
    let hit: string | null = null, best = 0, bestLen = 0;
    for (const x of prods) {
      if (!x.w.length) continue;
      const aInB = tw.every((w) => x.w.includes(w)), bInA = x.w.every((w) => tw.includes(w));
      if (!aInB && !bInA) continue;
      const extra = aInB ? x.w.filter((w) => !tw.includes(w)) : tw.filter((w) => !x.w.includes(w));
      const tail = x.n.length >= 8 && t.length >= 8 && ((t.indexOf(x.n) === 0 && extraOk(t, x.n)) || (x.n.indexOf(t) === 0 && extraOk(x.n, t)));
      const ok = extra.every((w) => (/\d/.test(w) ? tail : GENERIC.includes(w) || tail));
      if (!ok) continue;
      const inter = Math.min(tw.length, x.w.length), score = inter / (tw.length + x.w.length - inter);
      if (score > best || (score === best && x.n.length > bestLen)) { best = score; bestLen = x.n.length; hit = x.id; }
    }
    return hit;
  };
  return {
    match(r) {
      if (r.bbb_resource_id && imported.has(Number(r.bbb_resource_id))) return imported.get(Number(r.bbb_resource_id))!;
      return byName(r.listing_name, r.price_usd);
    },
  };
}

// Saves platform reviews by external_id. A new one is published on its product (or hidden as
// unmatched); one already stored gets its text and rating refreshed (the reviewer can edit it)
// but keeps its product, status and any reply, so an admin's own hide or reply is never undone.
export async function savePlatformReviews(admin: Obj, list: PlatformReview[], opts: { markSeen?: boolean; matcher?: Matcher; skipUnmatched?: boolean } = {}) {
  const out = { read: list.length, added: 0, updated: 0, matched: 0, unmatched: 0, skipped: 0 };
  if (!list.length) return out;
  const seen = new Set<string>();
  list = list.filter((r) => r.external_id && !seen.has(r.external_id) && seen.add(r.external_id));
  // Reviews an admin deleted for good (review_blocks) are never imported again.
  const blocked = new Set<string>();
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await admin.from("review_blocks").select("external_id").in("external_id", list.slice(i, i + 200).map((r) => r.external_id));
    if (error) throw new Error("read review blocks: " + error.message);
    for (const r of (data ?? []) as Obj[]) blocked.add(String(r.external_id));
  }
  if (blocked.size) list = list.filter((r) => !blocked.has(r.external_id));
  const have = new Map<string, Obj>();
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await admin.from("reviews").select("id, external_id, text, stars, recommended, reply, user_name, avatar_url")
      .in("external_id", list.slice(i, i + 200).map((r) => r.external_id));
    if (error) throw new Error("read reviews: " + error.message);
    for (const r of (data ?? []) as Obj[]) have.set(String(r.external_id), r);
  }
  const matcher = opts.matcher ?? await buildMatcher(admin);
  const now = new Date().toISOString();
  const inserts: Obj[] = [];
  for (const r of list) {
    const old = have.get(r.external_id);
    if (old) {
      // A reply written on coldd.dev is never replaced: the platform's own reply only fills an
      // empty one.
      const takeReply = !!r.reply && !old.reply;
      const changed = old.text !== r.text || old.stars !== r.stars || old.recommended !== r.recommended || takeReply ||
        old.user_name !== r.user_name || (r.avatar_url && old.avatar_url !== r.avatar_url);
      if (!changed) continue;
      const { error } = await admin.from("reviews").update({
        text: r.text, stars: r.stars, recommended: r.recommended,
        ...(takeReply ? { reply: r.reply, reply_at: r.reply_at ?? now } : {}),
        user_name: r.user_name, ...(r.avatar_url ? { avatar_url: r.avatar_url } : {}), updated_at: now,
      }).eq("id", old.id);
      if (error) throw new Error("update review: " + error.message);
      out.updated++;
      continue;
    }
    const pid = matcher.match(r);
    if (!pid && opts.skipUnmatched) { out.skipped++; continue; }
    if (pid) out.matched++; else out.unmatched++;
    inserts.push({
      product_id: pid, user_id: null, stars: r.stars, recommended: r.recommended, text: r.text,
      status: pid ? "approved" : "hidden", hidden_reason: pid ? null : "unmatched",
      user_name: r.user_name, avatar_url: r.avatar_url, reply: r.reply, reply_at: r.reply ? (r.reply_at ?? r.created_at) : null,
      created_at: r.created_at, updated_at: now, source: r.source, external_id: r.external_id,
      listing_name: r.listing_name, listing_ref: r.listing_ref, auto_imported: true,
      admin_reviewed_at: opts.markSeen ? now : null,
    });
  }
  for (let i = 0; i < inserts.length; i += 200) {
    const { error } = await admin.from("reviews").upsert(inserts.slice(i, i + 200), { onConflict: "external_id", ignoreDuplicates: true });
    if (error) throw new Error("save reviews: " + error.message);
  }
  out.added = inserts.length;
  return out;
}

// Publishes unmatched reviews whose product is now on the site.
export async function sweepUnmatched(admin: Obj, matcher?: Matcher) {
  const { data, error } = await admin.from("reviews").select("id, source, listing_name, listing_ref")
    .eq("hidden_reason", "unmatched").limit(2000);
  if (error || !data?.length) return 0;
  matcher = matcher ?? await buildMatcher(admin);
  let n = 0;
  for (const r of data as Obj[]) {
    const pid = matcher.match({
      listing_name: String(r.listing_name || ""),
      bbb_resource_id: r.source === "BuiltByBit" && /^\d+$/.test(String(r.listing_ref || "")) ? Number(r.listing_ref) : null,
    });
    if (!pid) continue;
    const { error: e } = await admin.from("reviews").update({ product_id: pid, status: "approved", hidden_reason: null, updated_at: new Date().toISOString() })
      .eq("id", r.id).eq("hidden_reason", "unmatched");
    if (!e) n++;
  }
  return n;
}
