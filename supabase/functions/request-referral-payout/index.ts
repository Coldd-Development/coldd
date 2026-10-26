import { referralContext, reply, paymentDetails } from "../_shared/referral_api.ts";
import { dispatchReferralEmails } from "../_shared/referral_emails.ts";
Deno.serve(async (req) => {
  try {
    const ctx = await referralContext(req);
    if (ctx.response) return ctx.response;
    const body = await req.json();
    const details = paymentDetails(body);
    const { data, error } = await ctx.admin!.rpc("request_referral_payout", {
      p_user_id: ctx.user!.id, p_method: String(body.method || ""), p_amount: Number(body.amount),
      p_source: String(body.sourceCurrency || ""), p_paypal: details.paypal, p_gamepass: details.gamepass,
      p_key: body.idempotencyKey || null,
    });
    if (error) throw error;
    if (!data?.ok) return reply(data, 400);
    await dispatchReferralEmails(ctx.admin).catch((error) => console.error("[payout-email] queued", error));
    return reply({ ...data, processingHours: 72 });
  } catch (error) {
    console.error("[request-referral-payout]", error);
    return reply({ ok: false, error: "Could not submit payout request. Please try again." }, 500);
  }
});
