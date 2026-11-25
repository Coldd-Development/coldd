// Reads the Parcel messages coldd's Discord bot forwarded (discord_feed_messages).
//
// Purchases: Parcel's "New Purchase" embed names the product, the payment method and the
// buyer (Roblox name + id, Discord name + id). For a Robux purchase the money comes from
// the group ledger (robux_sales): the DeveloperProduct sale by the same Roblox buyer a
// few seconds before the message. Its price is the product's Robux price (the dev product
// is named after it, else net / 0.7) and its amount is what the group received. The order
// is saved in platform_sales (platform 'parcel', source 'discord', external_id dc:<message>)
// linked to that ledger sale (ledger_ref), so the admin never counts it twice.
// A gift names the receiver, so it takes the free ledger sale closest before the message.
// A card purchase ("Stripe (USD)") has no ledger sale and no price in the message: it links
// to a sale entered by hand, else takes the product's coldd.dev price.
// A purchase whose ledger sale has not synced yet waits (status 'new') and is retried
// every few minutes; after LEDGER_GIVE_UP it is marked failed.
//
// Reviews: Parcel's "New Product Review" embed (product, Roblox and Discord reviewer, star
// emojis, feedback in a code block) is saved like the BuiltByBit and Creator Store reviews
// (source 'Parcel', external_id parcel:<message>): on its product, or hidden until the
// product is on the site. Old reviews (a backfill) never raise the admin's new-review task.
//
// A reviewer's newer review on the same product replaces their older one (keepNewestPerReviewer).
//
// Gifts and revokes by staff, statistics and other bots' posts are 'ignored'.

import { buildMatcher, savePlatformReviews, type Matcher, type PlatformReview } from "./platform_reviews.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export const PARCEL_BOT_ID = "965646811941437520";
const DEVEX_USD_PER_ROBUX = 0.0038;
const LEDGER_BEFORE_MS = 3 * 60_000;
const LEDGER_AFTER_MS = 60_000;
const LEDGER_GIVE_UP_MS = 12 * 3600_000;
const GIFT_BEFORE_MS = 60_000;
const GIFT_AFTER_MS = 10_000;
const REVIEW_FRESH_MS = 3 * 86400_000;

// A product name that reads as a vehicle: a model year, a maker, or a vehicle word. Parcel
// reviews of vehicles are only kept when that vehicle is a product on coldd.dev.
const VEHICLE_WORDS = [
  "honda", "toyota", "ford", "chevrolet", "chevy", "dodge", "ram", "jeep", "gmc", "cadillac", "buick", "lincoln", "chrysler", "tesla",
  "bmw", "mercedes", "benz", "amg", "audi", "volkswagen", "vw", "porsche", "lamborghini", "ferrari", "maserati", "alfa romeo", "fiat",
  "bugatti", "mclaren", "aston martin", "bentley", "rolls royce", "jaguar", "land rover", "range rover", "mini cooper", "volvo",
  "nissan", "infiniti", "lexus", "acura", "mazda", "subaru", "mitsubishi", "suzuki", "hyundai", "kia", "koenigsegg", "pagani",
  "mustang", "corvette", "camaro", "charger", "challenger", "tahoe", "suburban", "silverado", "f-?150", "f-?250", "crown vic(toria)?",
  "explorer", "impala", "durango", "wrangler", "civic", "accord", "camry", "corolla", "supra", "skyline", "gt-?r", "aventador", "huracan",
  "harley", "kawasaki", "yamaha", "ducati", "freightliner", "peterbilt", "kenworth", "scania",
  "car", "cars", "sedan", "coupe", "suv", "truck", "trucks", "pickup", "van", "bus", "limo", "limousine", "motorcycle", "motorbike", "dirt ?bike",
  "vehicle", "vehicles", "chassis", "helicopter", "heli", "mi-?8", "mi-?24", "uh-?60", "black ?hawk", "apache", "chinook",
  "ambulance", "firetruck", "fire truck", "golf ?cart", "go-?kart", "f1", "formula ?1", "red ?bull ?rb\\d+", "rb\\d+", "sauber", "gt3", "gt3 ?rs", "scooter", "tractor", "forklift", "bobcat", "excavator", "bulldozer",
  "jet", "airplane", "aircraft", "boeing", "airbus", "cessna", "f-?16", "f-?35", "tank", "humvee", "apc", "boat", "rhib", "yacht",
];
const VEHICLE = new RegExp("\\b(19[5-9]\\d|20[0-4]\\d)\\b|\\b(" + VEHICLE_WORDS.join("|") + ")\\b", "i");
export function looksLikeVehicle(name: string) { return VEHICLE.test(name); }

const clean = (v: unknown) => String(v ?? "").replace(/`/g, "").replace(/\*\*/g, "").trim();

function fieldsOf(embed: Obj | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of (embed?.fields ?? []) as Obj[]) if (f?.name) out[clean(f.name).toLowerCase()] = String(f.value ?? "");
  return out;
}
// "Nitrogolzy\n`908165702`" -> { name, id }
function person(v: string | undefined) {
  const lines = clean(v).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const id = lines.find((l) => /^\d{3,20}$/.test(l)) ?? null;
  const name = lines.find((l) => l !== id) ?? null;
  return { name, id };
}
// Same rule as the database's parcel_robux_price(): a developer product named after its price
// is that price; otherwise the price is worked back from the group's take, and of the prices
// that leave that take (99 and 100 both give 70) the one ending in 9 wins.
export function ledgerPrice(row: { item_name?: string | null; amount: number }) {
  const m = /^\s*(\d+)(\s*-\s*\d+)?\s*$/.exec(String(row.item_name ?? ""));
  if (m) return Number(m[1]);
  const net = Number(row.amount);
  if (!(net > 0)) return 0;
  const base = Math.round(net / 0.7);
  let best = 0;
  for (let p = Math.max(1, base - 3); p <= base + 3; p++) {
    if (p - Math.floor(p * 3 / 10) !== net) continue;
    if (p % 10 === 9) return p;
    if (!best) best = p;
  }
  return best || base;
}
function money(text: string | undefined) {
  const m = /([$€£]|usd|aud|eur|gbp)?\s*(\d+(?:[.,]\d{1,2})?)/i.exec(clean(text));
  if (!m) return null;
  const cur = (m[1] || "").toLowerCase();
  const currency = cur === "€" || cur === "eur" ? "EUR" : cur === "£" || cur === "gbp" ? "GBP" : cur === "aud" ? "AUD" : "USD";
  return { amount: Number(m[2].replace(",", ".")), currency };
}

type Msg = Obj & { message_id: string; posted_at: string; kind: string; author_id: string | null; author_name: string | null; embeds: Obj[] };
type Result = { status: "parsed" | "ignored" | "failed" | "new"; parsed?: Obj; error?: string | null; sale_id?: string | null };

export async function processFeed(sb: Obj, ids: string[]) {
  const summary = { read: 0, sales: 0, waiting: 0, ignored: 0, failed: 0 };
  if (!ids.length) return summary;
  const msgs: Msg[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("discord_feed_messages")
      .select("message_id, channel_id, kind, author_id, author_name, posted_at, content, embeds, parse_status, sale_id")
      .in("message_id", ids.slice(i, i + 200)).eq("parse_status", "new");
    if (error) throw new Error("read messages: " + error.message);
    msgs.push(...(data ?? []) as Msg[]);
  }
  msgs.sort((a, b) => a.posted_at.localeCompare(b.posted_at) || a.message_id.localeCompare(b.message_id));
  summary.read = msgs.length;
  if (!msgs.length) return summary;

  const results = new Map<string, Result>();
  const purchases: Array<{ m: Msg; f: Record<string, string> }> = [];
  const reviews: Array<{ m: Msg; f: Record<string, string> }> = [];
  for (const m of msgs) {
    const embed = m.embeds?.[0];
    const title = clean(embed?.title);
    if (m.author_id !== PARCEL_BOT_ID) { results.set(m.message_id, { status: "ignored", parsed: { why: "not Parcel", author: m.author_name } }); continue; }
    if (m.kind === "purchase" && /^new purchase$/i.test(title)) { purchases.push({ m, f: fieldsOf(embed) }); continue; }
    if (m.kind === "review" && /^new product review$/i.test(title)) { reviews.push({ m, f: fieldsOf(embed) }); continue; }
    results.set(m.message_id, { status: "ignored", parsed: { why: title || "no title" } });
  }

  if (purchases.length || reviews.length) {
    const matcher = await buildMatcher(sb);
    if (purchases.length) await readPurchases(sb, purchases, matcher, results);
    if (reviews.length) await readReviews(sb, reviews, matcher, results);
  }

  // One upsert per 200 results; every row carries the same columns (an upsert fills a
  // missing column with null).
  const byId = new Map(msgs.map((m) => [m.message_id, m]));
  const out: Obj[] = [];
  for (const [id, r] of results) {
    const m = byId.get(id)!;
    out.push({
      message_id: id, channel_id: m.channel_id, kind: m.kind, posted_at: m.posted_at,
      parse_status: r.status, parsed: r.parsed ?? null, parse_error: r.error ?? null, sale_id: r.sale_id ?? m.sale_id ?? null,
    });
    if (r.status === "parsed") summary.sales++;
    else if (r.status === "new") summary.waiting++;
    else if (r.status === "ignored") summary.ignored++;
    else summary.failed++;
  }
  for (let i = 0; i < out.length; i += 200) {
    const { error } = await sb.from("discord_feed_messages").upsert(out.slice(i, i + 200), { onConflict: "message_id" });
    if (error) throw new Error("save results: " + error.message);
  }
  return summary;
}

async function readPurchases(sb: Obj, list: Array<{ m: Msg; f: Record<string, string> }>, matcher: Matcher, results: Map<string, Result>) {
  // Ledger sales for every Robux buyer in this batch, in one read.
  const buyers = new Set<string>();
  let lo = Infinity, hi = -Infinity;
  for (const { m, f } of list) {
    const rb = person(f["roblox"]);
    if (rb.id) buyers.add(rb.id);
    const t = new Date(m.posted_at).getTime();
    lo = Math.min(lo, t); hi = Math.max(hi, t);
  }
  const ledger: Obj[] = [];
  if (buyers.size) {
    const { data, error } = await sb.from("robux_sales").select("id_hash, created_at, amount, item_name, buyer_id")
      .eq("item_type", "DeveloperProduct").in("buyer_id", [...buyers].map(Number))
      .gte("created_at", new Date(lo - LEDGER_BEFORE_MS).toISOString()).lte("created_at", new Date(hi + LEDGER_AFTER_MS).toISOString())
      .limit(5000);
    if (error) throw new Error("read ledger: " + error.message);
    ledger.push(...(data ?? []) as Obj[]);
  }
  // Ledger sales already taken by another order (an earlier run or another message).
  const taken = new Set<string>();
  const own = new Map<string, string>();
  if (ledger.length) {
    const refs = ledger.map((r) => r.id_hash);
    for (let i = 0; i < refs.length; i += 200) {
      const { data } = await sb.from("platform_sales").select("external_id, ledger_ref").in("ledger_ref", refs.slice(i, i + 200));
      for (const r of (data ?? []) as Obj[]) { taken.add(r.ledger_ref); own.set(r.external_id, r.ledger_ref); }
    }
  }

  const rows: Obj[] = [];
  const now = Date.now();
  for (const { m, f } of list) {
    const product = clean(f["product name"]).split("\n")[0].trim();
    const method = clean(f["method"]);
    const saleType = clean(f["sale type"]);
    const roblox = person(f["roblox"]);
    const discord = person(f["discord"]);
    const parsed: Obj = { product, method, sale_type: saleType, roblox, discord };
    const externalId = "dc:" + m.message_id;
    if (!product) { results.set(m.message_id, { status: "failed", parsed, error: "no product name" }); continue; }
    const posted = new Date(m.posted_at).getTime();
    const base = {
      platform: "parcel", source: "discord", external_id: externalId, product_name: product,
      product_id: matcher.match({ listing_name: product }), quantity: 1,
      buyer_name: roblox.name || discord.name, buyer_ref: roblox.id ? "roblox:" + roblox.id : discord.id ? "discord:" + discord.id : null,
      status: "paid", updated_at: new Date().toISOString(),
    };

    if (/^robux$/i.test(method)) {
      if (!roblox.id) { results.set(m.message_id, { status: "failed", parsed, error: "Robux purchase with no Roblox id" }); continue; }
      let hit: Obj | null = null;
      const mine = own.get(externalId);
      if (mine) hit = ledger.find((r) => r.id_hash === mine) ?? null;
      if (!hit) {
        let best = Infinity;
        for (const r of ledger) {
          if (String(r.buyer_id) !== roblox.id || taken.has(r.id_hash)) continue;
          const d = new Date(r.created_at).getTime() - posted;
          if (d < -LEDGER_BEFORE_MS || d > LEDGER_AFTER_MS) continue;
          // The ledger sale comes a few seconds before the message; one after it is a worse fit.
          const score = d <= 0 ? -d : d * 4;
          if (score < best) { best = score; hit = r; }
        }
      }
      // A gift names the receiver, not the account that paid: take the free ledger sale (any
      // buyer) closest before the message, within a minute.
      if (!hit && /^gift$/i.test(saleType)) {
        const { data: near } = await sb.from("robux_sales").select("id_hash, created_at, amount, item_name, buyer_id")
          .eq("item_type", "DeveloperProduct")
          .gte("created_at", new Date(posted - GIFT_BEFORE_MS).toISOString()).lte("created_at", new Date(posted + GIFT_AFTER_MS).toISOString());
        const free = ((near ?? []) as Obj[]).filter((r) => !taken.has(r.id_hash));
        if (free.length) {
          const { data: linked } = await sb.from("platform_sales").select("ledger_ref").in("ledger_ref", free.map((r) => r.id_hash));
          for (const r of (linked ?? []) as Obj[]) taken.add(r.ledger_ref);
        }
        let best = Infinity;
        for (const r of free) {
          if (taken.has(r.id_hash)) continue;
          const d = Math.abs(new Date(r.created_at).getTime() - posted);
          if (d < best) { best = d; hit = r; }
        }
        if (hit) parsed.payer_roblox_id = String(hit.buyer_id);
      }
      if (!hit) {
        const late = now - posted > LEDGER_GIVE_UP_MS;
        results.set(m.message_id, { status: late ? "failed" : "new", parsed, error: late ? "no group ledger sale for this buyer" : "waiting for the group ledger" });
        continue;
      }
      taken.add(hit.id_hash);
      const price = ledgerPrice({ item_name: hit.item_name, amount: Number(hit.amount) });
      const net = Number(hit.amount);
      parsed.ledger = { id: hit.id_hash, item: hit.item_name, net, price };
      rows.push({
        ...base, ledger_ref: hit.id_hash, sold_at: hit.created_at, currency: "ROBUX",
        amount: price, amount_usd: Math.round(price * DEVEX_USD_PER_ROBUX * 10000) / 10000,
        net_amount: net, net_usd: Math.round(net * DEVEX_USD_PER_ROBUX * 10000) / 10000,
        raw: { via: "parcel-discord", message_id: m.message_id, method, sale_type: saleType, roblox, discord, ledger_item: hit.item_name,
          ...(parsed.payer_roblox_id ? { payer_roblox_id: parsed.payer_roblox_id } : {}) },
      });
      results.set(m.message_id, { status: "parsed", parsed });
      continue;
    }

    // Card purchases ("Stripe (USD)") are not in the group ledger and Parcel's message has no
    // price. A sale already entered by hand for that product around then is that purchase (it
    // gets the buyer); otherwise the price is the message's, else the product's coldd.dev price
    // (Parcel's card prices match it), else its last Parcel card sale.
    const raw = { via: "parcel-discord", message_id: m.message_id, method, sale_type: saleType, roblox, discord };
    const { data: hand } = await sb.from("platform_sales").select("id, raw").eq("platform", "parcel").eq("source", "manual")
      .ilike("product_name", product).is("buyer_name", null)
      .gte("sold_at", new Date(posted - 36 * 3600_000).toISOString()).lte("sold_at", new Date(posted + 36 * 3600_000).toISOString()).limit(1);
    if (hand?.length) {
      const { error } = await sb.from("platform_sales").update({ buyer_name: base.buyer_name, buyer_ref: base.buyer_ref, raw: { ...(hand[0].raw ?? {}), ...raw }, updated_at: base.updated_at }).eq("id", hand[0].id);
      if (error) throw new Error("link hand-entered sale: " + error.message);
      parsed.linked_sale = hand[0].id;
      results.set(m.message_id, { status: "parsed", parsed, sale_id: hand[0].id });
      continue;
    }
    const cur = /\(([A-Z]{3})\)/.exec(method)?.[1] ?? "USD";
    let priced = money(f["price"] ?? f["amount"] ?? f["total"]);
    let priceFrom = "message";
    if (!priced && base.product_id) {
      const { data: p } = await sb.from("products").select("price_usd").eq("id", base.product_id).maybeSingle();
      if (Number(p?.price_usd) > 0 && cur === "USD") { priced = { amount: Number(p!.price_usd), currency: "USD" }; priceFrom = "coldd.dev price"; }
    }
    if (!priced) {
      const { data: last } = await sb.from("platform_sales").select("amount, currency").eq("platform", "parcel").neq("currency", "ROBUX")
        .ilike("product_name", product).lt("sold_at", m.posted_at).order("sold_at", { ascending: false }).limit(1);
      if (last?.length) { priced = { amount: Number(last[0].amount), currency: String(last[0].currency) }; priceFrom = "last Parcel card sale"; }
    }
    if (!priced) { results.set(m.message_id, { status: "failed", parsed, error: "no price for a " + (method || "non-Robux") + " purchase" }); continue; }
    parsed.price = { ...priced, from: priceFrom };
    rows.push({
      ...base, ledger_ref: null, sold_at: m.posted_at, currency: priced.currency, amount: priced.amount,
      amount_usd: priced.currency === "USD" ? priced.amount : null, net_amount: null, net_usd: null,
      raw: { ...raw, price_from: priceFrom },
    });
    results.set(m.message_id, { status: "parsed", parsed });
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await sb.from("platform_sales").upsert(rows.slice(i, i + 200), { onConflict: "platform,external_id" }).select("id, external_id");
    if (error) throw new Error("save sales: " + error.message);
    for (const r of (data ?? []) as Obj[]) {
      const res = results.get(String(r.external_id).slice(3));
      if (res) res.sale_id = r.id;
    }
  }
}

async function readReviews(sb: Obj, list: Array<{ m: Msg; f: Record<string, string> }>, matcher: Matcher, results: Map<string, Result>) {
  const fresh: PlatformReview[] = [], old: PlatformReview[] = [];
  const now = Date.now();
  for (const { m, f } of list) {
    const product = clean(f["product name"]).split("\n")[0].trim();
    const roblox = person(f["roblox"]);
    const discord = person(f["discord"]);
    const rating = String(f["star rating"] ?? "");
    const filled = (rating.match(/star_filled/gi) ?? []).length || (rating.match(/⭐|★/g) ?? []).length;
    const text0 = String(f["additional feedback"] ?? "").replace(/```/g, "").trim();
    // Parcel writes "None" when the reviewer left no feedback.
    const text = /^(none|n\/a|no feedback|-)$/i.test(text0) ? "" : text0;
    const parsed = { product, roblox, discord, stars: filled || null, text };
    if (!product) { results.set(m.message_id, { status: "failed", parsed, error: "no product name" }); continue; }
    if (looksLikeVehicle(product) && !matcher.match({ listing_name: product })) {
      results.set(m.message_id, { status: "ignored", parsed: { ...parsed, why: "vehicle not on coldd.dev" } });
      continue;
    }
    const at = String(m.embeds?.[0]?.timestamp || m.posted_at);
    const review: PlatformReview = {
      external_id: "parcel:" + m.message_id, source: "Parcel", listing_name: product, listing_ref: m.message_id,
      stars: filled >= 1 && filled <= 5 ? filled : null, recommended: null, text,
      user_name: roblox.name || discord.name, avatar_url: roblox.id ? "uid:" + roblox.id : null,
      external_author: roblox.id ? "roblox:" + roblox.id : discord.id ? "discord:" + discord.id : null,
      reply: null, reply_at: null, created_at: new Date(at).toISOString(),
    };
    (now - new Date(m.posted_at).getTime() > REVIEW_FRESH_MS ? old : fresh).push(review);
    results.set(m.message_id, { status: "parsed", parsed });
  }
  // Reviewer headshots from Roblox's public thumbnails API (100 users a request).
  const all = [...fresh, ...old];
  const uids = [...new Set(all.map((r) => String(r.avatar_url || "").replace(/^uid:/, "")).filter((u) => /^\d+$/.test(u)))];
  const shot = new Map<string, string>();
  for (let i = 0; i < uids.length; i += 100) {
    try {
      const res = await fetch("https://thumbnails.roblox.com/v1/users/avatar-headshot?size=150x150&format=Png&isCircular=false&userIds=" + uids.slice(i, i + 100).join(","));
      const d = res.ok ? await res.json() : null;
      for (const t of (d?.data ?? []) as Obj[]) if (t.state === "Completed" && t.imageUrl) shot.set(String(t.targetId), String(t.imageUrl));
    } catch { /* no picture is fine */ }
  }
  for (const r of all) r.avatar_url = shot.get(String(r.avatar_url || "").replace(/^uid:/, "")) ?? null;
  if (fresh.length) await savePlatformReviews(sb, fresh, { matcher });
  if (old.length) await savePlatformReviews(sb, old, { matcher, markSeen: true });
  await keepNewestPerReviewer(sb, all.map((r) => r.external_author).filter((a): a is string => !!a));
}

// A reviewer's newer Parcel review on a product replaces their older one: the older reviews
// are deleted and blocked (review_blocks) so re-reading old messages never brings them back.
export async function keepNewestPerReviewer(sb: Obj, authors: string[]) {
  const list = [...new Set(authors)];
  let removed = 0;
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await sb.from("reviews").select("id, external_id, external_author, listing_name, user_name, created_at, reply, home_pin")
      .eq("source", "Parcel").in("external_author", list.slice(i, i + 100));
    if (error) throw new Error("read reviewer reviews: " + error.message);
    const groups = new Map<string, Obj[]>();
    for (const r of (data ?? []) as Obj[]) {
      const k = r.external_author + "|" + String(r.listing_name || "").trim().toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      for (const old of g.slice(1)) {
        await sb.from("review_blocks").upsert({ external_id: old.external_id, source: "Parcel", listing_name: old.listing_name, user_name: old.user_name, deleted_at: new Date().toISOString() }, { onConflict: "external_id" });
        const { error: delErr } = await sb.from("reviews").delete().eq("id", old.id);
        if (delErr) throw new Error("remove older review: " + delErr.message);
        removed++;
      }
    }
  }
  return removed;
}

// Messages still waiting (ledger not synced yet, or saved before the reading existed),
// oldest first, 200 at a time.
export async function retryWaiting(sb: Obj, limit = 400) {
  const { data } = await sb.from("discord_feed_messages").select("message_id").eq("parse_status", "new")
    .order("posted_at", { ascending: true }).limit(limit);
  const ids = ((data ?? []) as Obj[]).map((r) => String(r.message_id));
  const total: Record<string, number> = { read: 0, sales: 0, waiting: 0, ignored: 0, failed: 0 };
  for (let i = 0; i < ids.length; i += 200) {
    const s = await processFeed(sb, ids.slice(i, i + 200)) as Record<string, number>;
    for (const k of Object.keys(total)) total[k] += s[k] ?? 0;
  }
  return total;
}
