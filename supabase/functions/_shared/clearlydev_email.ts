// Reads a ClearlyDev "new order" notification email into one sale.
//
// Reads both layouts ClearlyDev has used:
// - the WooCommerce/WCFM email sent until August 2025 (subject "[Clearly
//   Development] New Store Order (1124791) - 28th August 2025", an item table
//   with span.item-name + td.line_cost, "Gross Total:");
// - the current "New Order Received!" email (2026): "#1293638", "Your store has
//   received a new order from Noah Gibbs.", Customer / Roblox Username / Order
//   Date (11/22/2026, US order) / Order Value ($19.99), then "Products Ordered"
//   with name, licence tier, "Quantity: 1" and price per product.
// Kept loose on purpose: it also takes "Order 1234567" ids, any "Total" line
// and $ / £ / € / US$ / A$ amounts. Anything it cannot read comes back as { ok: false, error } and the
// email is kept for a re-read.
//
// Pure (no Deno APIs) so it can be tested with plain Node.

export interface ParsedItem { name: string; qty: number; amount: number | null }
export interface ParsedOrder {
  ok: true;
  orderId: string;
  currency: string;
  total: number;
  items: ParsedItem[];
  buyer: string | null;
  // The order date printed in the email: the subject ("... - 28th August 2025")
  // or the "Order Date" field (11/22/2026), noon in Sydney. Used instead of the
  // email's own date when the email was forwarded.
  subjectDate: string | null;
}
export type ParseResult = ParsedOrder | { ok: false; error: string };

const SYMBOLS: [RegExp, string][] = [
  [/US\$|USD/i, "USD"], [/A\$|AU\$|AUD/i, "AUD"], [/CA\$|C\$|CAD/i, "CAD"],
  [/£|GBP/i, "GBP"], [/€|EUR/i, "EUR"], [/\$/, "USD"],
];

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&pound;/gi, "£").replace(/&euro;/gi, "€").replace(/&times;/gi, "×")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d|table|td|th)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t ]+/g, " ").replace(/\n\s+/g, "\n").trim();
}

// "£1.49", "$ 12.00", "US$4.99", "4.99 USD" -> { amount, currency }
export function readMoney(s: string): { amount: number; currency: string } | null {
  const m = s.match(/(US\$|A\$|AU\$|CA\$|C\$|[$£€])\s?(\d{1,6}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)|(\d{1,6}(?:[.,]\d{1,2})?)\s?(USD|GBP|EUR|AUD|CAD)\b/i);
  if (!m) return null;
  const sym = m[1] || m[4] || "$";
  let num = (m[2] || m[3] || "").replace(/,(?=\d{3}\b)/g, "");
  if (/,\d{1,2}$/.test(num)) num = num.replace(",", ".");
  const amount = Number(num);
  if (!Number.isFinite(amount)) return null;
  const currency = (SYMBOLS.find(([re]) => re.test(sym)) || [null, "USD"])[1];
  return { amount: Math.round(amount * 100) / 100, currency };
}

export function parseClearlyDevOrder(email: { subject?: string; html?: string; text?: string; from?: string }): ParseResult {
  const subject = email.subject || "";
  const html = email.html || "";
  const text = email.text || (html ? htmlToText(html) : "");
  const hay = (email.from || "") + "\n" + subject + "\n" + text + "\n" + html;
  if (!/clearly\s?dev/i.test(hay)) return { ok: false, error: "not a ClearlyDev email" };
  if (!/order/i.test(subject + "\n" + text)) return { ok: false, error: "not an order email" };

  const idMatch =
    subject.match(/\((\d{5,})\)/) || subject.match(/#\s?(\d{5,})/) || subject.match(/order\s+#?(\d{5,})/i) ||
    html.match(/orders?(?:-details)?\/(\d{5,})/i) || text.match(/order\s*#?\s*(\d{5,})/i) || text.match(/#(\d{5,})/);
  if (!idMatch) return { ok: false, error: "no order number found" };
  const orderId = idMatch[1];

  // Items: the WooCommerce table first (span.item-name ... td.line_cost).
  const items: ParsedItem[] = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html))) {
    const r = row[0];
    const name = r.match(/class="item-name"[^>]*>\s*(?:<a[^>]*>)?([\s\S]*?)<\/(?:a|span)>/i);
    if (!name) continue;
    // The real email has a tag between the sign and the number ("×</small> 1").
    const qty = htmlToText(r).match(/×\s*(\d+)/);
    const cost = r.match(/class="line_cost"[\s\S]*?<\/td>/i);
    const money = cost ? readMoney(htmlToText(cost[0])) : readMoney(htmlToText(r));
    items.push({ name: htmlToText(name[1]).trim(), qty: qty ? Number(qty[1]) : 1, amount: money ? money.amount : null });
  }

  // Total: the most specific total line wins.
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const pick = (re: RegExp) => {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      // The figure sits on the label's line or just below it; a two-column
      // layout can put another label in between ("Order Date / Order Value").
      for (let j = i; j <= i + 3 && j < lines.length; j++) {
        const here = readMoney(lines[j]);
        if (here) return here;
      }
    }
    return null;
  };
  const total = pick(/gross total/i) || pick(/order total|order value|total paid|amount paid|^total\b/i) || pick(/\btotal\b/i) || pick(/subtotal/i);
  let amount = total ? total.amount : null;
  let currency = total ? total.currency : null;
  if (amount == null && items.length && items.every((it) => it.amount != null)) {
    amount = Math.round(items.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;
  }
  if (!currency) { const any = readMoney(text); currency = any ? any.currency : "USD"; }
  if (amount == null) return { ok: false, error: "no total found" };

  // Forwarded copies (Gmail strips class names) and any other layout: the item
  // names are the links to clearlydev.com/product/... pages.
  if (!items.length) {
    const seen = new Set<string>();
    const linkRe = /href="https?:\/\/(?:www\.)?clearlydev\.com\/product\/[^"]+"[^>]*>([\s\S]{1,200}?)<\/a>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(html))) {
      const nm = htmlToText(lm[1]).trim();
      if (nm && !seen.has(nm.toLowerCase())) { seen.add(nm.toLowerCase()); items.push({ name: nm, qty: 1, amount: null }); }
    }
    if (items.length === 1) {
      const q1 = text.match(/×\s*(\d+)/);
      items[0].qty = q1 ? Number(q1[1]) : 1;
      items[0].amount = amount;
    }
  }
  // The 2026 email: after "Products Ordered", each product is its name, an
  // optional licence tier ("standard"), "Quantity: N" and its price.
  if (!items.length) {
    const start = lines.findIndex((l) => /^products? ordered\b/i.test(l));
    if (start >= 0) {
      let cur: ParsedItem | null = null;
      for (let i = start + 1; i < lines.length && items.length < 50; i++) {
        const l = lines[i];
        if (/^\[image:/i.test(l)) continue;
        if (/^[-=_*\s]{3,}$/.test(l)) { if (!cur && items.length) break; continue; }
        if (/^(order (summary|total|value)|sub ?total|total\b|your earnings|platform fee|view (your )?order|payment|thanks|thank you|need help|questions\?|©)/i.test(l)) break;
        const q = l.match(/^(?:quantity|qty)\s*[:x×]?\s*(\d+)/i);
        const money = readMoney(l);
        const onlyMoney = money && !/[a-z]{3,}/i.test(l.replace(/\b(USD|AUD|GBP|EUR|CAD)\b/gi, ""));
        if (q) { if (cur) cur.qty = Number(q[1]); continue; }
        if (onlyMoney) { if (cur) { cur.amount = money.amount; items.push(cur); cur = null; } continue; }
        // the first line is the name; any other line under it is the licence tier
        if (!cur) cur = { name: l.replace(/\s*[x×]\s*\d+\s*$/, "").trim(), qty: 1, amount: null };
      }
      if (cur) items.push(cur);
      if (items.length === 1 && items[0].amount == null) items[0].amount = amount;
    }
  }
  // Item names when there was no WooCommerce table: "Product: X" lines.
  if (!items.length) {
    lines.forEach((l) => {
      const m = l.match(/^(?:product|item)s?\s*[:\-]\s*(.+)$/i);
      if (m) items.push({ name: m[1].replace(/\s*[x×]\s*\d+\s*$/, "").trim(), qty: 1, amount: null });
    });
  }
  const buyer = (text.match(/([^\n]{2,80}?) has just placed a new order/i) || text.match(/new order from ([^\n]{2,80}?)\.?[ \t]*$/im) || [])[1] || null;
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const dm = subject.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  let subjectDate = dm ? new Date(Date.UTC(Number(dm[3]), MONTHS.indexOf(dm[2].toLowerCase()), Number(dm[1]), 1, 0, 0)).toISOString() : null;
  if (!subjectDate) {
    // "Order Date" then 11/22/2026 (month first) on the same line or just below.
    const di = lines.findIndex((l) => /^order date\b/i.test(l));
    for (let j = di; di >= 0 && j <= di + 3 && j < lines.length; j++) {
      const d = lines[j].match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
      if (d && Number(d[1]) <= 12 && Number(d[2]) <= 31) { subjectDate = new Date(Date.UTC(Number(d[3]), Number(d[1]) - 1, Number(d[2]), 1, 0, 0)).toISOString(); break; }
    }
  }
  // The plain-text part marks bold as *Noah Gibbs*.
  return { ok: true, orderId, currency, total: amount, items, buyer: buyer ? buyer.trim().replace(/^[*_]+|[*_]+$/g, "").trim() || null : null, subjectDate };
}
