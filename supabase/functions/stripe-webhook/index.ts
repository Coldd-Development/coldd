// supabase/functions/stripe-webhook/index.ts
//
// IMPORTANT: this function is called by Stripe's servers directly, so it
// never receives a Supabase user JWT. It MUST be deployed with the JWT
// verification switch turned off, or every delivery will 401 before this
// code even runs:
//
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Required secrets (set once):
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...          <- from the
//     Stripe Dashboard webhook endpoint you create pointing at this
//     function's URL, subscribed to checkout.session.completed.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Functions runtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17?target=deno";
import { sendOrderReceipt } from "../_shared/email.ts";
import { resolveGiftReceipt } from "../_shared/gift.ts";
import { recordMarketingOptIn } from "../_shared/marketing.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  httpClient: Stripe.createFetchHttpClient(),
  apiVersion: "2024-06-20",
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const signature = req.headers.get("stripe-signature") ?? "";
  // Signature verification needs the exact raw byte string Stripe signed -
  // read as text, never as parsed-then-reserialized JSON.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    // constructEventAsync (not the sync constructEvent) - the sync version
    // calls into Node's crypto module and does not work in Deno. This is the
    // single easiest thing to get wrong here.
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
    );
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.order_id;
      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

      if (orderId) {
        // Idempotent: only rows still not 'paid' get flipped, so a replayed
        // webhook delivery (Stripe retries on anything but a 2xx) is a no-op -
        // .select() lets us tell whether this delivery was the one that
        // actually transitioned the order, so the coupon usage bump below
        // only ever fires once per order.
        const { data: updated, error } = await admin
          .from("orders")
          .update({ status: "paid", stripe_payment_intent_id: paymentIntentId, paid_at: new Date().toISOString() })
          .eq("id", orderId)
          .neq("status", "paid")
          .select("coupon_code, user_id, purchased_by_user_id, marketing_opt_in")
          .single();
        if (error && error.code !== "PGRST116") throw error;

        if (updated) {
          if (updated.coupon_code) {
            const { data: coupon } = await admin.from("coupons").select("usage_count").eq("code", updated.coupon_code).single();
            if (coupon) {
              await admin.from("coupons").update({ usage_count: coupon.usage_count + 1 }).eq("code", updated.coupon_code);
            }
          }
          // Awaited, not fire-and-forget: a Deno Edge Function's isolate can
          // be torn down as soon as the response below is sent, which would
          // silently drop an un-awaited send before Resend ever received it.
          // Stripe Checkout always collects an email on its own hosted page,
          // even for guests, so this is present regardless of account status.
          const guestEmail = session.customer_details?.email || session.customer_email || null;
          // For a gift order the buyer's own email (from Stripe's own
          // hosted page) already IS the correct receipt address - but the
          // gift lookup below also fires the recipient's "you received a
          // gift" notification, so it always runs; its returned email only
          // overrides guestEmail when actually present.
          const giftEmail = await resolveGiftReceipt(admin, { id: orderId, user_id: updated.user_id, purchased_by_user_id: updated.purchased_by_user_id });
          const receipt = await sendOrderReceipt(admin, orderId, giftEmail || guestEmail);
          if (!receipt.ok) console.error("[stripe-webhook] receipt email failed:", receipt.error);
          if (updated.marketing_opt_in) await recordMarketingOptIn(admin, guestEmail, updated.user_id);
        }
      }
    } else if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.order_id;
      if (orderId) {
        await admin.from("orders").update({ status: "failed" }).eq("id", orderId).in("status", ["pending"]);
      }
    }
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    return new Response("Payment processing failed; please retry.", {status:500});
  }

  // Always ack quickly so Stripe doesn't retry unhandled event types.
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
