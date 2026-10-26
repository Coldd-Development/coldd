// supabase/functions/verify-robux-order/index.ts
//
// Deploy with:
//   supabase functions deploy verify-robux-order
//
// Confirms a Robux order after the buyer says they've bought the gamepass.
//
// POOL MODEL. The order was served ONE pooled pass, priced to its exact total,
// leased for a fixed window. Proving payment therefore means proving a SALE of
// that pass, for that amount, after that lease began.
//
// Inventory ownership is deliberately no longer used. Pooled passes are reused
// across buyers and orders, and gamepass ownership is permanent - so a buyer who
// legitimately paid for a pass last week still owns it forever, and an ownership
// check would hand them every later order that happened to draw the same pass,
// for free. That is not a hardening detail; it is the reason the old approach
// cannot survive pooling.
//
// Consequence worth knowing: the group sale ledger (ROBLOX_FALLBACK_COOKIE) is
// now REQUIRED, not a fallback. Without it there is no safe way to confirm a
// pooled purchase, so verification fails closed and the order waits for the
// admin override in the Orders panel rather than being auto-confirmed.
//
// Body: { orderId }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { findPoolSale, getValidRobloxToken } from "../_shared/roblox.ts";
import { getLeasedPass, releasePass } from "../_shared/roblox_pool.ts";
import { sendOrderReceipt } from "../_shared/email.ts";
import { resolveGiftReceipt } from "../_shared/gift.ts";
import { recordMarketingOptIn } from "../_shared/marketing.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    const orderId = String((await req.json().catch(() => ({}))).orderId || "");
    if (!orderId) return json({ ok: false, error: "Missing orderId." }, 400);

    const { data: order, error: orderErr } = await admin
      .from("orders").select("*").eq("id", orderId).single();
    if (orderErr || !order) return json({ ok: false, error: "Order not found." }, 404);
    // A gift order's user_id is the recipient, not the buyer - but it's
    // still the buyer who goes to Roblox and pays, so the buyer is who
    // calls verify. purchased_by_user_id is only ever set for gift orders,
    // so this doesn't loosen the check for a normal (non-gift) order.
    if (order.user_id !== userData.user.id && order.purchased_by_user_id !== userData.user.id) {
      return json({ ok: false, error: "This isn't your order." }, 403);
    }
    if (order.currency !== "robux") return json({ ok: false, error: "Not a Robux order." }, 400);

    if (order.status === "paid") return json({ ok: true, verified: true, status: "paid" });
    if (order.status !== "pending") {
      return json({ ok: false, error: `Order is ${order.status}, not pending.` }, 400);
    }

    // The lease is the source of truth for which pass and which price. If it
    // has already been reclaimed, the window closed and the order must be
    // restarted - re-pricing a pass mid-flight is exactly what the lease exists
    // to prevent.
    const pass = await getLeasedPass(admin, orderId);
    if (!pass) {
      return json({
        ok: true,
        verified: false,
        status: "pending",
        code: "LEASE_EXPIRED",
        message: "This order's payment window expired. Please start the order again - you have not been charged.",
      });
    }

    const tokenSet = await getValidRobloxToken(admin, userData.user.id);
    const buyerId = order.roblox_buyer_id || (tokenSet ? tokenSet.robloxId : null);
    if (!buyerId) {
      return json({ ok: false, error: "Link your Roblox account first.", code: "NOT_LINKED" }, 400);
    }

    // Prefer the price actually set on Roblox for this lease over the order
    // total. If those ever disagree, the buyer could only have paid the former.
    const expectedRobux = Number(pass.lease_price_robux ?? order.total_robux ?? 0);
    if (!(expectedRobux > 0)) {
      return json({ ok: false, error: "This order has no confirmed price to verify against." }, 500);
    }

    const sale = await findPoolSale(
      String(pass.gamepass_id),
      String(buyerId),
      expectedRobux,
      String(pass.leased_at ?? order.created_at),
    );

    if (!sale.found) {
      if (sale.reason === "NOT_CONFIGURED" || sale.reason === "COOKIE_BROKEN" || sale.reason === "LOOKUP_FAILED") {
        // Fail closed. There is no ownership fallback under pooling, so an
        // unavailable ledger means "cannot confirm", never "assume paid".
        // LOOKUP_FAILED belongs here too - it means the Roblox request itself
        // broke (bad response, timeout, parse error), not that the sale
        // genuinely isn't there yet. Lumping it in with a real "not found"
        // told buyers to just keep waiting on a check that was never going
        // to succeed.
        console.error("[verify-robux-order] sale ledger unavailable:", sale.reason, orderId);
        return json({
          ok: false,
          code: "VERIFY_UNAVAILABLE",
          error: "We can't confirm Robux payments right now. Contact support and we'll complete your order manually - your payment is safe.",
        }, 503);
      }
      // Used to fall back to a live inventory check here (does the buyer's
      // Roblox inventory already show this exact pass?) and auto-switch
      // them to a fresh one if so. Removed: Roblox's inventory-items API
      // reported a pass created under a second earlier - with zero sale
      // transactions for it, ever - as already owned. It appears to
      // surface passes an account has management/edit rights over (which
      // every pool pass's group-owner/admin account has, by definition),
      // not just ones actually purchased - exactly backwards for a check
      // whose entire job is distinguishing "bought" from "not bought".
      // leasePassForOrder's own paid-order-history exclusion (see
      // roblox_pool.ts) is the reliable version of this same protection,
      // applied before a pass is ever served instead of after.
      return json({
        ok: true,
        verified: false,
        status: "pending",
        message: "We haven't seen your purchase yet. Roblox can take a few minutes to report it - try again shortly.",
      });
    }

    // Conditional update doubles as the guard against two verify calls racing.
    // .select() lets us tell whether THIS call is the one that actually won
    // the race, same idempotency pattern as the other payment paths - without
    // it, two racing verify calls could both fall through and double-send.
    const { data: updated } = await admin
      .from("orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString(),
        roblox_verification_method: "pool_sale",
      })
      .eq("id", orderId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    // Hand the pass back and take it off sale, so nobody can pay this order's
    // price in the gap before it is re-leased and re-priced.
    await releasePass(admin, orderId, String(pass.universe_id), String(pass.gamepass_id));

    // Robux checkout requires a linked (signed-in) Roblox account, so this
    // always has a user_id - no guest path to worry about here. For a gift
    // order, order.user_id is the recipient, not the buyer who actually
    // paid on Roblox's side - resolveGiftReceipt redirects the receipt to
    // the buyer's account email and notifies the recipient separately.
    if (updated) {
      const giftEmail = await resolveGiftReceipt(admin, { id: orderId, user_id: order.user_id, purchased_by_user_id: order.purchased_by_user_id });
      const receipt = await sendOrderReceipt(admin, orderId, giftEmail);
      if (!receipt.ok) console.error("[verify-robux-order] receipt email failed:", receipt.error);
      if (order.marketing_opt_in) await recordMarketingOptIn(admin, giftEmail, order.user_id);
    }

    return json({ ok: true, verified: true, status: "paid" });
  } catch (err) {
    console.error("[verify-robux-order] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
