import { emailFrame, emailHeading } from "./email_design.ts";
// supabase/functions/_shared/email.ts
//
// Thin Resend client + branded HTML templates. Shared by admin-send-campaign,
// cron-lifecycle-emails, marketing-signup, send-contact-message, and the
// order-receipt path in every payment webhook.
//
// Gated behind RESEND_API_KEY. Until that secret is set, sendBatch and
// sendSingle return { ok: false, code: "NOT_CONFIGURED" } for every
// call rather than throwing - callers (the admin UI, the cron job) show
// that as a clear "email sending isn't set up yet" state instead of a
// crash, same pattern as ROBLOX_FALLBACK_COOKIE/ADBLOX_API_KEY elsewhere in
// this codebase.

const RESEND_API_BASE = "https://api.resend.com";
const FROM_ADDRESS = "coldd <noreply@coldd.dev>";
const REPLY_TO = "support@coldd.dev";

/**
 * Crude HTML -> text so every send carries a real text/plain part. A missing
 * one is a measurable spam signal. Not a parser: keeps link URLs, turns
 * block tags into newlines, strips the rest, decodes the entities the
 * templates use.
 */
export function htmlToText(html: string): string {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
      const t = String(txt).replace(/<[^>]+>/g, "").trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h1|h2|h3|li|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, " - ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, "·").replace(/&times;/g, "x")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ")
    .trim();
}

function apiKey(): string | undefined {
  return Deno.env.get("RESEND_API_KEY") || undefined;
}

export function emailConfigured(): boolean {
  return !!apiKey();
}

export type SendResult = { ok: true } | { ok: false; error: string; code?: string };

/**
 * RFC 8058 one-click unsubscribe headers for a bulk/marketing send. Gmail
 * and Yahoo require List-Unsubscribe + List-Unsubscribe-Post on bulk mail;
 * without them a sender's reputation degrades and messages land in spam.
 * The mailbox provider POSTs `List-Unsubscribe=One-Click` to the URL, which
 * email-unsubscribe handles without any confirmation step.
 *
 * URL only - no `mailto:` form, so there's no unsubscribe inbox to run. The
 * https one-click endpoint alone satisfies the bulk-sender requirements.
 *
 * Transactional mail (receipts, OTP, contact form) must NOT carry these -
 * it isn't subject to unsubscribe.
 */
export function unsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** Sends one email immediately. `headers` for bulk sends - see unsubscribeHeaders(). */
export async function sendSingle(to: string, subject: string, html: string, headers?: Record<string, string>, idempotencyKey?: string, transport?: { replyTo?: string; from?: string; campaignId?: string }): Promise<SendResult> {
  const key = apiKey();
  if (!key) return { ok: false, error: "Email sending is not configured yet.", code: "NOT_CONFIGURED" };

  const payload: Record<string, unknown> = { from: transport?.from || FROM_ADDRESS, reply_to: transport?.replyTo || REPLY_TO, to, subject, html, text: htmlToText(html) };
  if (transport?.campaignId) payload.tags = [{ name: "campaign_id", value: transport.campaignId }];
  if (headers && Object.keys(headers).length) payload.headers = headers;

  const res = await fetch(`${RESEND_API_BASE}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Resend returned HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

export type BatchEmail = {
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
  // Resend tags - surfaced back on the delivery webhook payloads, which is
  // how email_events rows get linked to the campaign that sent them.
  tags?: { name: string; value: string }[];
};

/**
 * Sends up to 100 emails in one Resend batch call. Larger lists must be
 * chunked by the caller - this function does not paginate on its own,
 * since callers need per-chunk error handling (a chunk failing shouldn't
 * silently drop the rest of the list).
 */
export async function sendBatch(emails: BatchEmail[]): Promise<{ ok: true; sent: number } | { ok: false; error: string; code?: string }> {
  if (!emails.length) return { ok: true, sent: 0 };
  const key = apiKey();
  if (!key) return { ok: false, error: "Email sending is not configured yet.", code: "NOT_CONFIGURED" };
  if (emails.length > 100) return { ok: false, error: "Batch of more than 100 - caller must chunk." };

  const res = await fetch(`${RESEND_API_BASE}/emails/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(emails.map((e) => {
      const item: Record<string, unknown> = { from: FROM_ADDRESS, reply_to: REPLY_TO, to: e.to, subject: e.subject, html: e.html, text: htmlToText(e.html) };
      if (e.headers && Object.keys(e.headers).length) item.headers = e.headers;
      if (e.tags && e.tags.length) item.tags = e.tags;
      return item;
    })),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Resend returned HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true, sent: emails.length };
}

/**
 * Wraps campaign body HTML in the same dark/red-accent shell as every other
 * coldd transactional email (see email-otp's emailHtml()), so a marketing
 * send doesn't look like a different product. bodyHtml is trusted, admin-
 * authored content, not user input - no escaping here.
 */
export function wrapCampaignEmail(bodyHtml: string, unsubscribeUrl: string): string {
  return emailFrame(bodyHtml, { unsubscribeUrl, preview: htmlToText(bodyHtml).slice(0, 140) });
}

/**
 * Service announcement shell (ToS changes, outages, policy updates). Same
 * visual frame as wrapCampaignEmail, but the footer says plainly that this
 * is a required service message that goes to every account, not marketing -
 * so it isn't dressed up as something the recipient opted into. A
 * List-Unsubscribe link is still included because Gmail/Yahoo require one
 * on any bulk send for it to land in the inbox at all; it points at the
 * normal endpoint (which only stops *marketing*), and the footer is honest
 * about that.
 */
export function wrapAnnouncementEmail(bodyHtml: string, unsubscribeUrl: string): string {
  return emailFrame(bodyHtml, { unsubscribeUrl, announcement: true, preview: htmlToText(bodyHtml).slice(0, 140) });
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Same rules as admin.js's simpleMarkdownToHtml (blank line = paragraph,
// **bold**) - kept in sync deliberately so an admin previews and gets
// exactly what a lifecycle automation (rendered here, server-side, at send
// time) will actually look like.
export function renderBodyMd(text: string): string {
  const paras = String(text || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras
    .map((p) => {
      const line = escapeHtml(p.trim()).replace(/\n/g, "<br>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      return line ? `<p style="margin:0 0 16px;">${line}</p>` : "";
    })
    .join("");
}

export function ctaButtonHtml(url: string, label: string): string {
  const safeUrl = escapeHtml(url); const safeLabel = escapeHtml(label);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#e2382f" style="border-radius:10px;mso-padding-alt:16px 24px;"><a href="${safeUrl}" style="display:block;padding:16px 24px;color:#ffffff;font-size:15px;line-height:22px;font-weight:700;text-align:center;text-decoration:none;">${safeLabel}</a></td></tr></table>`;
}

export type LineItem = { title: string; qty?: number; linkUrl?: string; linkLabel?: string; imageUrl?: string };

export function productHeroHtml(image: string, title: string): string {
  const url = image?.startsWith("/") ? "https://coldd.dev" + image : image;
  if (!url || !/^https:\/\//i.test(url)) return "";
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" width="520" style="display:block;width:100%;max-width:520px;height:auto;margin:0 0 28px;">`;
}

export function itemsTableHtml(items: LineItem[]): string {
  return '<table role="presentation" width="100%" style="margin:0 0 24px;">'+items.map(i => {
    const image = i.imageUrl?.startsWith('/') ? 'https://coldd.dev'+i.imageUrl : i.imageUrl;
    const thumbnail = image && /^https:\/\//i.test(image) ? '<td width="90" style="padding:18px 18px 18px 0;border-top:1px solid #33363f;border-bottom:1px solid #33363f;"><img src="'+escapeHtml(image)+'" alt="" width="72" style="display:block;width:72px;height:auto;border-radius:4px;"></td>' : '';
    return '<tr>'+thumbnail+'<td'+(thumbnail?'':' colspan="2"')+' style="padding:18px 0;border-top:1px solid #33363f;border-bottom:1px solid #33363f;font-size:15px;color:#e2e6ec;">'+escapeHtml(i.title)+(i.qty && i.qty > 1 ? ' &times; '+Number(i.qty) : '')+(i.linkUrl ? '<br><a href="'+escapeHtml(i.linkUrl)+'" style="font-size:14px;color:#ff8079;">'+escapeHtml(i.linkLabel || 'View product')+'</a>' : '')+'</td></tr>';
  }).join('')+'</table>';
}

/**
 * Builds a lifecycle automation email from an admin-authored config row
 * (subject + body_md) plus optional extra HTML (an item list, a CTA
 * button) appended after the body text. Used by cron-lifecycle-emails for
 * all three automation types - the only thing that differs between an
 * abandoned-cart nudge, a review request, and a re-engagement email is
 * which config row and which extra blocks get passed in.
 */
export function renderAutomationEmail(bodyMd: string, extraHtmlBlocks: string[], unsubscribeUrl: string, title?: string, heroHtml = ""): string {
  return wrapCampaignEmail(heroHtml + (title ? emailHeading(title) : '') + renderBodyMd(bodyMd) + extraHtmlBlocks.join('\n'), unsubscribeUrl);
}

/**
 * Same visual shell as wrapCampaignEmail (marketing), minus the unsubscribe
 * link/footer - a receipt is a transactional record of a purchase, not a
 * marketing send, and must go out regardless of profiles.marketing_unsubscribed.
 * Separate function rather than an optional param so a future edit to the
 * marketing footer can't accidentally leak into transactional mail or vice
 * versa.
 */
export function wrapTransactionalEmail(bodyHtml: string): string {
  return emailFrame(bodyHtml, { preview: htmlToText(bodyHtml).slice(0, 140) });
}

/**
 * Fetches an order + its items and emails a receipt via the transactional
 * shell. Called from every payment path (Stripe/PayPal/crypto/Robux) right
 * after the same idempotency-guarded UPDATE that flips an order to 'paid',
 * so it only ever fires once per order regardless of webhook retries.
 *
 * Email resolution: a signed-in buyer's address comes from auth.users
 * (always present, never missing). A guest buyer only has an address if the
 * caller passes one in explicitly (guestEmail) - Stripe Checkout always
 * collects one on its own hosted page, so the Stripe webhook can pass
 * session.customer_details.email. PayPal/crypto/Robux currently capture no
 * guest email anywhere in the checkout flow, so a guest paying by one of
 * those methods will not receive a receipt until that gap is closed
 * separately - this function silently no-ops rather than erroring when no
 * address is available, since a missing receipt must never fail or retry
 * the payment webhook that triggered it.
 */
export async function buildOrderReceipt(
  admin: any,
  orderId: string,
  guestEmail?: string | null,
): Promise<{ ok: true; to: string; subject: string; html: string } | { ok: false; error: string; code?: string }> {
  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id, user_id, purchased_by_user_id, receipt_email, total_usd, total_robux, currency, stripe_charge_currency, stripe_charge_amount, created_at")
    .eq("id", orderId)
    .single();
  if (orderErr || !order) return { ok: false, error: "Order not found for receipt." };

  let to = guestEmail || order.receipt_email || null;
  if (!to && order.purchased_by_user_id) {
    const { data } = await admin.auth.admin.getUserById(order.purchased_by_user_id);
    to = data?.user?.email || null;
  }
  if (!to && order.user_id && !order.purchased_by_user_id) {
    const { data: userRes } = await admin.auth.admin.getUserById(order.user_id);
    to = userRes?.user?.email || null;
  }
  if (!to) return { ok: false, error: "No email address available for this order.", code: "NO_EMAIL" };

  const { data: items, error: itemsError } = await admin
    .from("order_items")
    .select("title, qty, product_slug, products(image)")
    .eq("order_id", orderId);
  if (itemsError) return { ok: false, error: "Could not load receipt items." };

  // Add-ons are best-effort: a failure here (or the table not existing yet)
  // must never stop a receipt going out.
  const { data: addonRows } = await admin
    .from("order_addons")
    .select("title, product_slug, needs_ticket")
    .eq("order_id", orderId);
  const addons: any[] = addonRows || [];
  const needsTicket = addons.some((a) => a.needs_ticket);

  const itemsHtml = itemsTableHtml(
    (items || []).map((i: any) => ({
      title: i.title,
      imageUrl: i.products?.image,
      qty: i.qty,
      linkUrl: `https://coldd.dev/product?id=${encodeURIComponent(i.product_slug)}`,
      linkLabel: "View",
    })).concat(addons.map((a: any) => ({
      title: `Add-on: ${a.title}`,
      qty: 1,
      linkUrl: "",
      linkLabel: "",
    }))),
  );
  // Setup-style add-ons don't start on their own: the buyer opens a ticket.
  const ticketNote = needsTicket
    ? `<p style="margin:0 0 24px;padding:14px 16px;background:#1f2127;border:1px solid #33363f;border-radius:6px;font-size:13px;color:#d7d7d7;"><strong style="color:#ffffff;">Next step for your setup service:</strong> open a support ticket in our <a href="https://discord.gg/coldd" style="color:#ff8079;text-decoration:none;">Discord</a> so we can get started. We aim to respond within 48 hours.</p>`
    : "";

  const total = String(order.currency).toUpperCase() === "ROBUX" ? `${Number(order.total_robux || 0).toLocaleString("en-US")} Robux` : `${Number(order.total_usd).toFixed(2)} USD`;
  const shortId = String(order.id).slice(0, 8).toUpperCase();

  const body = `
${emailHeading(order.purchased_by_user_id ? "Gift order confirmed" : "Order confirmed")}
<p style="margin:0 0 24px;">${order.purchased_by_user_id ? 'Your gift order is confirmed. The files are available in the recipient&#39;s account.' : 'Your order is confirmed. Open your downloads to get the files.'}</p>
${itemsHtml}
${ticketNote}
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
<tr><td class="receipt-meta" style="padding-right:18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#aab2c0;">Order #${shortId} &middot; Total charged</td>
<td class="receipt-amount" align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;color:#ffffff;">${total}</td></tr>
</table>
${order.purchased_by_user_id ? ctaButtonHtml("https://coldd.dev/dashboard?panel=purchases", "View your gift purchase") : order.user_id ? ctaButtonHtml("https://coldd.dev/dashboard?panel=owned", "Open your downloads") : ""}
${order.user_id ? "" : `<p style="margin:20px 0 0;font-size:12px;color:#aab2c0;">Bought as a guest - create an account with this email any time to see this order and re-download later.</p>`}
`;

  const html = wrapTransactionalEmail(body);
  return { ok: true, to, subject: `Your coldd order #${shortId} is confirmed`, html };
}

export async function sendOrderReceipt(admin: any, orderId: string, guestEmail?: string | null): Promise<SendResult> {
  if (guestEmail) { const { error } = await admin.from('orders').update({ receipt_email: guestEmail }).eq('id', orderId); if (error) return { ok: false, error: 'Could not persist receipt address.' }; }
  const { queueEmail, drainEmailQueue } = await import('./email_delivery.ts');
  const result = await queueEmail(admin, { dedupe_key: 'receipt/'+orderId, category: 'receipt', kind: 'service', order_id: orderId });
  if (result.ok) {
    try { await drainEmailQueue(admin, 'receipt/'+orderId); }
    catch (error) { console.error('[receipt] delivery queued', String(error)); }
  }
  return result;
}
