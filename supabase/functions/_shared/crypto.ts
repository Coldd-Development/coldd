// Crypto payment provider adapter.
//
// Everything above this file talks to CryptoProvider, never to a vendor
// directly. That boundary exists for a specific reason: Coinbase Commerce was
// the original choice and turned out to be unavailable to Australian
// merchants, NOWPayments (the second) settles to a wallet with no automated
// bank payout, and the same kind of surprise could happen again. Swapping
// provider should be one implementation here plus new secrets - not a
// rewrite of the order flow.
//
// The interface is deliberately the narrowest thing that supports a hosted
// redirect checkout:
//   createCharge  - mint a payment page for an order we have already priced
//   verifyWebhook - prove an inbound status callback really came from them
//
// RelayPay is the active implementation: AUSTRAC-registered, and settles
// same-day to an Australian bank account rather than leaving funds sitting
// in a crypto wallet. NOWPayments is kept below, dormant, as a fallback -
// see activeProvider().

import { usdTo } from "./fx.ts";

export type ChargeResult =
  | { ok: true; url: string; providerId: string; settleAmount: number; settleCurrency: string }
  | { ok: false; error: string };

export interface CryptoProvider {
  readonly name: string;
  createCharge(input: {
    orderId: string;
    amountUsd: number;
    description: string;
    returnUrl: string;
    cancelUrl: string;
    callbackUrl: string;
    /** Required by RelayPay; ignored by providers that don't need it. */
    customerName: string;
    customerEmail: string;
  }): Promise<ChargeResult>;
  /**
   * Returns the coldd order id when the payload is authentic AND represents a
   * settled payment. Anything else returns null - the caller must never
   * fulfil on an unverified or non-final callback.
   *
   * settleAmount/settleCurrency are whatever currency the charge was actually
   * created in (see createCharge's return) - NOT always USD. NOWPayments
   * invoices in USD, so the two happen to be the same there; RelayPay invoices
   * (and settles) in AUD, converted from the order's USD total at charge time.
   * The caller must compare this against the order's own stored
   * crypto_settle_amount/crypto_settle_currency, never against total_usd
   * directly - comparing an AUD figure to a USD total would either reject
   * every real payment or (worse) accept a short one.
   */
  verifyWebhook(rawBody: string, headers: Headers): Promise<
    // outcomeAmount/outcomeCurrency: what the provider actually passes on to us, when it says.
    { orderId: string; providerId: string; settleAmount: number; settleCurrency: string; outcomeAmount?: number; outcomeCurrency?: string } | null
  >;
}

const NOWPAY_BASE = "https://api.nowpayments.io/v1";

/** Statuses NOWPayments uses for "the money is actually there". */
const SETTLED = new Set(["finished", "confirmed"]);

function nowpaymentsKey(): string {
  const k = (Deno.env.get("NOWPAYMENTS_API_KEY") ?? "").trim();
  if (!k) throw new Error("Crypto payments are not configured.");
  return k;
}

/** HMAC-SHA512 over the JSON body, keys sorted - NOWPayments' IPN scheme. */
async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Recursively key-sorted stringify. The IPN signature is computed over this
 *  exact form, so re-serialising the parsed body any other way will not match. */
function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(sortedStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k])).join(",") + "}";
}

/** Constant-time compare, so a bad signature cannot be brute-forced by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const nowPayments: CryptoProvider = {
  name: "nowpayments",

  async createCharge(input) {
    const res = await fetch(`${NOWPAY_BASE}/invoice`, {
      method: "POST",
      headers: { "x-api-key": nowpaymentsKey(), "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: Math.round(input.amountUsd * 100) / 100,
        price_currency: "usd",
        // Our order id round-trips through the provider so the webhook can be
        // correlated without trusting anything the browser sends back.
        order_id: input.orderId,
        order_description: input.description,
        ipn_callback_url: input.callbackUrl,
        success_url: input.returnUrl,
        cancel_url: input.cancelUrl,
      }),
    });

    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }

    if (!res.ok || !data?.invoice_url) {
      // Never echo the provider body - it can quote request fields back and
      // this lands in function logs.
      return { ok: false, error: `Crypto provider rejected the charge (${res.status}).` };
    }
    return {
      ok: true,
      url: String(data.invoice_url),
      providerId: String(data.id ?? ""),
      settleAmount: Math.round(input.amountUsd * 100) / 100,
      settleCurrency: "usd",
    };
  },

  async verifyWebhook(rawBody, headers) {
    const secret = (Deno.env.get("NOWPAYMENTS_IPN_SECRET") ?? "").trim();
    if (!secret) return null;

    const sent = headers.get("x-nowpayments-sig") ?? "";
    if (!sent) return null;

    let parsed: any;
    try { parsed = JSON.parse(rawBody); } catch { return null; }

    const expected = await hmacSha512Hex(secret, sortedStringify(parsed));
    if (!timingSafeEqual(sent.toLowerCase(), expected.toLowerCase())) return null;

    // Authentic, but only settled states may fulfil. "waiting", "confirming",
    // "sending", "partially_paid", "failed" and "expired" all mean the funds
    // are not (or never will be) fully there.
    const status = String(parsed.payment_status ?? "").toLowerCase();
    if (!SETTLED.has(status)) return null;

    // Second underpayment guard, independent of status. `partially_paid`
    // normally catches a short send, but the crypto-side figures are the
    // authoritative record of what actually arrived, so check them directly
    // when present. A dust-level shortfall is tolerated because exchanges and
    // network fees routinely shave the last decimal places off a transfer.
    const due = Number(parsed.pay_amount ?? NaN);
    const got = Number(parsed.actually_paid ?? NaN);
    if (Number.isFinite(due) && Number.isFinite(got) && due > 0) {
      if (got < due * 0.995) return null;
    }

    const orderId = String(parsed.order_id ?? "");
    if (!orderId) return null;

    return {
      orderId,
      providerId: String(parsed.payment_id ?? parsed.invoice_id ?? ""),
      // price_amount is the USD figure WE set on the invoice. The caller still
      // re-checks it against the order's stored charge amount, so a
      // tampered-but-signed payload cannot under-pay.
      settleAmount: Number(parsed.price_amount ?? NaN),
      settleCurrency: "usd",
      outcomeAmount: Number(parsed.outcome_amount ?? NaN),
      outcomeCurrency: String(parsed.outcome_currency ?? ""),
    };
  },
};

const RELAYPAY_HOSTS: Record<string, string> = {
  sandbox: "https://api.sandbox.relaypay.io",
  production: "https://api.relaypay.io",
};

function relaypayBase(): string {
  const env = (Deno.env.get("RELAYPAY_ENV") ?? "sandbox").trim().toLowerCase();
  return RELAYPAY_HOSTS[env] ?? RELAYPAY_HOSTS.sandbox;
}

function relaypayCreds(): { publicKey: string; privateKey: string; merchantId: string; storeName: string } {
  const publicKey = (Deno.env.get("RELAYPAY_PUBLIC_KEY") ?? "").trim();
  const privateKey = (Deno.env.get("RELAYPAY_PRIVATE_KEY") ?? "").trim();
  const merchantId = (Deno.env.get("RELAYPAY_MERCHANT_ID") ?? "").trim();
  const storeName = (Deno.env.get("RELAYPAY_STORE_NAME") ?? "coldd").trim();
  if (!publicKey || !privateKey || !merchantId) throw new Error("Crypto payments are not configured.");
  return { publicKey, privateKey, merchantId, storeName };
}

/** RelayPay's signing scheme: hex SHA-256 of the exact request-body string
 *  concatenated with the private key (not HMAC - see their merchant docs).
 *  The same string used to sign must be the exact string sent, so callers
 *  build the JSON once and reuse it for both. */
async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const relayPay: CryptoProvider = {
  name: "relaypay",

  async createCharge(input) {
    // RelayPay settles in the fiat currency the charge was created in (there
    // is no separate invoice-vs-settlement currency), so a USD order total
    // has to become an AUD figure before it reaches them.
    let amountAud: number;
    try {
      amountAud = await usdTo(input.amountUsd, "AUD");
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Currency conversion failed." };
    }

    const { publicKey, privateKey, merchantId, storeName } = relaypayCreds();
    const payload = {
      amount: amountAud,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      storeName,
      merchantId,
      currency: "AUD",
      orderId: input.orderId,
      callbackUrlRedirect: input.returnUrl,
      callbackCancelUrlRedirect: input.cancelUrl,
      webHookUrl: input.callbackUrl,
    };
    // Sign the exact string we send - re-stringifying after signing (even
    // with identical data) can reorder keys and produce a different string,
    // which would make RelayPay's own signature check fail on their end.
    const body = JSON.stringify(payload);
    const signature = await sha256Hex(body + privateKey);

    const res = await fetch(`${relaypayBase()}/api/e-commerce/request`, {
      method: "POST",
      headers: {
        "x-api-key": publicKey,
        "x-merchant-id": merchantId,
        "x-api-signature": signature,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!res.ok) {
      // Never echo the provider body - it can quote request fields back and
      // this lands in function logs.
      return { ok: false, error: `Crypto provider rejected the charge (${res.status}).` };
    }

    // Docs specify "Status 200: redirect url" without pinning down whether
    // that's a bare string or a JSON envelope - handle both rather than
    // guessing one and breaking silently the day it's the other.
    const text = await res.text();
    let redirectUrl = text.trim();
    try {
      const data = JSON.parse(text);
      redirectUrl = String(data?.redirectUrl ?? data?.url ?? data?.checkoutUrl ?? data?.paymentUrl ?? text).trim();
    } catch { /* plain-text body, keep as-is */ }
    if (!/^https?:\/\//.test(redirectUrl)) {
      return { ok: false, error: "Crypto provider did not return a checkout URL." };
    }

    return {
      ok: true,
      url: redirectUrl,
      // Not returned by this endpoint (only the webhook and the transaction
      // lookup endpoints carry RelayPay's own transactionId) - the webhook
      // fills this in on the order once the first status update arrives.
      providerId: "",
      settleAmount: amountAud,
      settleCurrency: "aud",
    };
  },

  async verifyWebhook(rawBody, headers) {
    const { privateKey } = relaypayCreds();
    const sent = headers.get("x-api-signature") ?? "";
    if (!sent) return null;

    const expected = await sha256Hex(rawBody + privateKey);
    if (!timingSafeEqual(sent.toLowerCase(), expected.toLowerCase())) return null;

    let parsed: any;
    try { parsed = JSON.parse(rawBody); } catch { return null; }

    // Authentic, but only a completed transaction may fulfil. "Pending" is
    // the normal in-flight state; "Cancelled"/"Failed"/"Expired" never settle.
    if (String(parsed.orderStatus ?? "") !== "Success") return null;

    const orderId = String(parsed.orderId ?? "");
    if (!orderId) return null;

    return {
      orderId,
      providerId: String(parsed.transactionId ?? ""),
      settleAmount: Number(parsed.amount ?? NaN),
      settleCurrency: "aud",
    };
  },
};

export function activeProvider(): CryptoProvider {
  // One switch point. A second provider is a new object above plus a case here.
  // Stays on nowpayments (the one already live and configured) until
  // RELAYPAY_* secrets are set and CRYPTO_PROVIDER=relaypay is flipped on -
  // that way this deploys with zero risk to live crypto checkout, and the
  // switch itself is a config change, not a code change.
  const name = (Deno.env.get("CRYPTO_PROVIDER") ?? "nowpayments").trim().toLowerCase();
  switch (name) {
    case "relaypay":
      return relayPay;
    case "nowpayments":
    default:
      return nowPayments;
  }
}
