// supabase/functions/_shared/sale_alerts.ts
//
// Sends queued sale alerts (public.sale_alerts) to every phone added in Site Management >
// Phone alerts, through the free Bark iOS app. Used by the sale-alerts function (trigger
// poke, cron safety net, Send test) and at the end of each sync that writes sales, so an
// alert goes out the moment its sale is saved.
//
// Each push is encrypted with the phone's own key (AES-256-CBC, a fresh 16-character IV
// per push), so Bark's relay and Apple only carry ciphertext. Bark replaces the push it
// receives with the decrypted fields, so everything it needs goes inside; the harmless
// ones (sound, level, id) go outside too for the relay.

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export const PLATFORM_LABEL: Record<string, string> = {
  site: "coldd.dev", builtbybit: "BuiltByBit", creatorstore: "Creator Store",
  clearlydev: "ClearlyDev", payhip: "Payhip", parcel: "Parcel",
};
const ICON_URL = "https://coldd.dev/mp-logos/sale-alert.png";
const OPEN_URL = "https://coldd.dev/admin/orders/";
const SYMBOL: Record<string, string> = { USD: "$", AUD: "A$", EUR: "€", GBP: "£", CAD: "C$", NZD: "NZ$" };
// Rough US$ value, only for the "minimum amount" setting.
const TO_USD: Record<string, number> = { USD: 1, AUD: 0.65, EUR: 1.08, GBP: 1.27, CAD: 0.73, NZD: 0.6, ROBUX: 0.0125 };

export function money(amount: number, currency: string): string {
  const c = String(currency || "USD").toUpperCase();
  if (c === "ROBUX") return "R$" + Math.round(amount).toLocaleString("en-US");
  const v = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return SYMBOL[c] ? SYMBOL[c] + v : v + " " + c;
}

// "Sale for $24.99!" / "Catch a Fish just sold for $24.99 on BuiltByBit!"
export function alertText(a: { source: string; product: string | null; more: number; amount: number; currency: string }) {
  const price = money(Number(a.amount), a.currency);
  const where = PLATFORM_LABEL[a.source] || a.source;
  const what = a.product ? a.product + (a.more > 0 ? ` + ${a.more} more` : "") : `A ${where} product`;
  return { title: `Sale for ${price}!`, body: `${what} just sold for ${price} on ${where}!` };
}

const enc = new TextEncoder();
function randomIv(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => chars[x % chars.length]).join("");
}
async function encrypt(plain: string, key: string, iv: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "AES-CBC" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: enc.encode(iv) }, k, enc.encode(plain)));
  let s = "";
  for (const x of ct) s += String.fromCharCode(x);
  return btoa(s);
}

// Is it inside the quiet hours (Sydney time)? Alerts then arrive silently.
function isQuiet(st: Obj): boolean {
  if (!st?.quiet_start || !st?.quiet_end) return false;
  const now = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const t = now.replace(/[^\d:]/g, ""), a = String(st.quiet_start).slice(0, 5), b = String(st.quiet_end).slice(0, 5);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

// One push to one phone. Returns null when Bark accepted it, else the error.
export async function pushTo(dev: Obj, fields: { title: string; body: string; pushId: string; silent: boolean }, st: Obj): Promise<string | null> {
  const level = fields.silent ? "passive" : (st?.level || "timeSensitive");
  const inner: Obj = { title: fields.title, body: fields.body, group: "Sales", icon: ICON_URL, url: OPEN_URL, level, isArchive: "1" };
  if (!fields.silent) {
    inner.sound = st?.sound || "paymentsuccess";
    if (st?.sound_url) inner.soundUrl = st.sound_url;
  }
  const iv = randomIv();
  const outer: Obj = { ciphertext: await encrypt(JSON.stringify(inner), dev.enc_key, iv), iv, id: fields.pushId, level };
  if (inner.sound) outer.sound = inner.sound;
  try {
    const r = await fetch(String(dev.server || "https://api.day.app").replace(/\/+$/, "") + "/" + encodeURIComponent(dev.bark_key), {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(outer),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && (j.code === undefined || j.code === 200)) return null;
    return String(j.message || `HTTP ${r.status}`).slice(0, 200);
  } catch (e) {
    return String((e as Error)?.message || e).slice(0, 200);
  }
}

// Sends every due alert. Safe to call from several places at once (alerts are claimed).
// deno-lint-ignore no-explicit-any
export async function flushSaleAlerts(admin: any): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const { data: due, error } = await admin.rpc("sale_alerts_claim", { p_limit: 20 });
  if (error || !due?.length) return out;
  const [{ data: st }, { data: devs }] = await Promise.all([
    admin.from("sale_alert_settings").select("*").eq("id", true).maybeSingle(),
    admin.from("sale_alert_devices").select("*").eq("enabled", true),
  ]);
  const quietHours = isQuiet(st);
  const now = () => new Date().toISOString();
  for (const a of due as Obj[]) {
    let skip: string | null = null;
    if (!st?.enabled) skip = "Phone alerts are off";
    else if (st.platforms && st.platforms[a.source] === false) skip = `${PLATFORM_LABEL[a.source] || a.source} alerts are off`;
    else if (Number(st.min_usd) > 0 && Number(a.amount) * (TO_USD[a.currency] ?? 1) < Number(st.min_usd)) skip = "Under the minimum amount";
    else if (!devs?.length) skip = "No phone added";
    if (skip) {
      await admin.from("sale_alerts").update({ sent_at: now(), claimed_at: null, error: skip }).eq("id", a.id);
      out.skipped++;
      continue;
    }
    const text = alertText({ source: a.source, product: a.product, more: a.more, amount: Number(a.amount), currency: a.currency });
    const results = await Promise.all((devs as Obj[]).map(async (d) => {
      const err = await pushTo(d, { ...text, pushId: a.push_id, silent: a.quiet || quietHours }, st);
      await admin.from("sale_alert_devices").update(err ? { last_error: err } : { last_sent_at: now(), last_error: null }).eq("id", d.id);
      return err;
    }));
    const ok = results.some((e) => !e);
    if (ok) {
      await admin.from("sale_alerts").update({ sent_at: now(), claimed_at: null, error: results.find((e) => e) || null }).eq("id", a.id);
      out.sent++;
    } else {
      // Try again later: 1, 2, 4, 8 minutes (5 tries in all).
      const wait = Math.pow(2, Math.max(0, (a.attempts || 1) - 1)) * 60000;
      await admin.from("sale_alerts").update({ claimed_at: null, error: results[0], send_after: new Date(Date.now() + wait).toISOString() }).eq("id", a.id);
      out.failed++;
    }
  }
  return out;
}
