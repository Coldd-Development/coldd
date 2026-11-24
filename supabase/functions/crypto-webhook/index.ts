// Settlement webhook for crypto payments. THIS is what marks an order paid.
//
// Deploy with --no-verify-jwt: the provider posts here server-to-server and has
// no Supabase token. The endpoint is therefore publicly reachable, and its only
// gate is the HMAC signature - so every branch below assumes the caller is
// hostile until the signature proves otherwise.
//
// Why fulfilment lives here and not on the return page: crypto confirms
// on-chain minutes after the buyer pays, frequently after they have closed the
// tab. A browser-driven capture (fine for PayPal) would simply lose those
// orders. The success page only polls; it can never mark anything paid.
//
// Defences, in the order they run:
//   1. Signature   - HMAC-SHA512 over the key-sorted body, constant-time compare.
//   2. Finality    - only settled statuses. "partially_paid" is NOT one: crypto
//                    buyers really can send less than the invoice.
//   3. Correlation - the order id round-tripped through the provider, never
//                    anything a browser supplied.
//   4. Amount      - re-checked against the server-computed total, and against
//                    what was actually received.
//   5. Replay      - the paid transition is conditional, so repeated callbacks
//                    cannot double-fulfil or double-count a coupon.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { activeProvider } from "../_shared/crypto.ts";
import { sendOrderReceipt } from "../_shared/email.ts";
import { resolveGiftReceipt } from "../_shared/gift.ts";
import { recordMarketingOptIn } from "../_shared/marketing.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  // No CORS block: this is not called from a browser. Anything that reaches
  // here is either the provider or an attacker.
  if (req.method !== "POST") return json({ ok: false }, 405);

  try {
    const raw = await req.text();
    const provider = activeProvider();

    // 1. Authenticity. An unsigned or mis-signed payload is indistinguishable
    // from a forgery, so it is dropped without touching the database. 200 is
    // deliberate - a 4xx invites probing for which payloads are "interesting".
    const verified = await provider.verifyWebhook(raw, req.headers);
    if (!verified) return json({ ok: true, ignored: true });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: order } = await admin
      .from("orders")
      .select("id, status, coupon_code, crypto_charge_id, crypto_settle_amount, crypto_settle_currency")
      .eq("id", verified.orderId)
      .maybeSingle();
    if (!order) {
      console.error("crypto-webhook: unknown order", verified.orderId);
      return json({ ok: true, ignored: true });
    }

    if (order.status === "paid") return json({ ok: true, alreadyPaid: true });

    // 4. The invoice amount we set must still match what this order is worth.
    // Compared against crypto_settle_amount/currency (what was actually
    // invoiced to the provider), NEVER total_usd - RelayPay settles in AUD,
    // so total_usd is the wrong currency to compare against and would either
    // reject every real payment or silently accept a short one.
    const expected = Number(order.crypto_settle_amount);
    const currencyMatches = String(order.crypto_settle_currency ?? "").toLowerCase() === verified.settleCurrency.toLowerCase();
    if (!currencyMatches || !Number.isFinite(verified.settleAmount) || Math.abs(verified.settleAmount - expected) > 0.005) {
      // Deliberately loud: a signed payload whose amount disagrees with our own
      // stored charge means either a pricing bug or a compromised secret.
      console.error("crypto-webhook: amount mismatch", {
        orderId: order.id, got: verified.settleAmount, gotCurrency: verified.settleCurrency,
        expected, expectedCurrency: order.crypto_settle_currency,
      });
      return json({ ok: true, ignored: true });
    }

    // The processor's real fee when the provider says what it passed on in a US-dollar coin
    // (NOWPayments "outcome"): invoice less outcome = service fee + network costs.
    const outCur = String(verified.outcomeCurrency || "").toLowerCase();
    const outAmt = Number(verified.outcomeAmount);
    const feeUsd = Number.isFinite(outAmt) && outAmt > 0 && /^(usd|usdt|usdc)/.test(outCur) && Number.isFinite(verified.settleAmount)
      ? Math.max(0, Math.round((verified.settleAmount - outAmt) * 100) / 100) : null;

    // 5. Conditional transition doubles as the replay guard.
    const { data: updated } = await admin
      .from("orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
        crypto_payment_id: verified.providerId || null,
        payment_method: "crypto",
        ...(feeUsd != null ? { processor_fee: feeUsd, processor_fee_currency: "USD" } : {}),
      })
      .eq("id", order.id)
      .neq("status", "paid")
      .select()
      .maybeSingle();

    // Null means another delivery of the same callback won the race and already
    // settled it. Not an error, and specifically not a reason to increment the
    // coupon a second time.
    if (!updated) return json({ ok: true, alreadyPaid: true });

    if (updated.coupon_code) {
      const { data: coupon } = await admin
        .from("coupons").select("code, usage_count").eq("code", updated.coupon_code).maybeSingle();
      if (coupon) {
        await admin.from("coupons")
          .update({ usage_count: (coupon.usage_count ?? 0) + 1 })
          .eq("code", updated.coupon_code);
      }
    }

    // No guest email: nothing in the crypto checkout flow captures one
    // today (create-crypto-charge takes no email field). Signed-in buyers
    // still get a receipt via their account email; sendOrderReceipt no-ops
    // cleanly for a guest order rather than erroring. Gift orders are the
    // one exception - the buyer's email comes from their account via
    // resolveGiftReceipt, same as every other payment path.
    const giftEmail = await resolveGiftReceipt(admin, { id: order.id, user_id: updated.user_id, purchased_by_user_id: updated.purchased_by_user_id });
    const receipt = await sendOrderReceipt(admin, order.id, giftEmail);
    if (!receipt.ok && receipt.code !== "NO_EMAIL") console.error("[crypto-webhook] receipt email failed:", receipt.error);
    if (updated.marketing_opt_in) await recordMarketingOptIn(admin, giftEmail, updated.user_id);

    return json({ ok: true, status: "paid" });
  } catch (e) {
    console.error("crypto-webhook error", e instanceof Error ? e.message : e);
    // 500 so the provider retries. Losing a settlement callback loses a paid
    // order, which is far worse than handling one twice - the replay guard
    // above makes duplicates harmless.
    return json({ ok: false }, 500);
  }
});
