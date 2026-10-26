import { referralContext, reply, paymentDetails } from "../_shared/referral_api.ts";
import { dispatchReferralEmails } from "../_shared/referral_emails.ts";

Deno.serve(async (req) => {
  try {
    const ctx = await referralContext(req);
    if (ctx.response) return ctx.response;
    const body = await req.json();
    const details = paymentDetails(body);
    const { data, error } = await ctx.admin!.rpc("revise_referral_payout", {
      p_user_id: ctx.user!.id, p_id: body.id, p_paypal: details.paypal, p_gamepass: details.gamepass,
    });
    if (error) throw error;
    if (!data?.ok) return reply(data, 400);
    await dispatchReferralEmails(ctx.admin).catch((error) => console.error("[payout-email] queued", error));
    return reply(data);
  } catch (error) {
    console.error("[update-referral-payout]", error);
    return reply({ ok: false, error: "Could not update payment details. Please try again." }, 500);
  }
});
