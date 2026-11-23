// Reads a ClearlyDev "new order" notification email into one sale.
//
// Written against the WooCommerce/WCFM email ClearlyDev sent until August 2025
// (subject "[Clearly Development] New Store Order (1124791) - 28th August 2025",
// an item table with span.item-name + td.line_cost, "Gross Total:"), and kept
// loose on purpose: the current platform's email may differ, so it also takes
// "#1234567" / "Order 1234567" ids, any "Total" line and $ / £ / € / US$ / A$
// amounts. Anything it cannot read comes back as { ok: false, error } and the
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

export function parseClearlyDevOrder(email: { subject?: string; html?: string; text?: string }): ParseResult {
  const subject = email.subject || "";
  const html = email.html || "";
  const text = email.text || (html ? htmlToText(html) : "");
  const hay = subject + "\n" + text + "\n" + html;
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
      const here = readMoney(lines[i]) || (lines[i + 1] ? readMoney(lines[i + 1]) : null);
      if (here) return here;
    }
    return null;
  };
  const total = pick(/gross total/i) || pick(/order total|total paid|amount paid|^total\b/i) || pick(/\btotal\b/i) || pick(/subtotal/i);
  let amount = total ? total.amount : null;
  let currency = total ? total.currency : null;
  if (amount == null && items.length && items.every((it) => it.amount != null)) {
    amount = Math.round(items.reduce((s, it) => s + (it.amount || 0), 0) * 100) / 100;
  }
  if (!currency) { const any = readMoney(text); currency = any ? any.currency : "USD"; }
  if (amount == null) return { ok: false, error: "no total found" };

  // Item names when there was no WooCommerce table: "Product: X" lines.
  if (!items.length) {
    lines.forEach((l) => {
      const m = l.match(/^(?:product|item)s?\s*[:\-]\s*(.+)$/i);
      if (m) items.push({ name: m[1].replace(/\s*[x×]\s*\d+\s*$/, "").trim(), qty: 1, amount: null });
    });
  }
  const buyer = (text.match(/([^\n]{2,80}?) has just placed a new order/i) || [])[1] || null;
  return { ok: true, orderId, currency, total: amount, items, buyer: buyer ? buyer.trim() : null };
}
