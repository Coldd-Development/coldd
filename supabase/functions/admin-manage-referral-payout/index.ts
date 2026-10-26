import { referralContext, reply } from "../_shared/referral_api.ts";
import { dispatchReferralEmails } from "../_shared/referral_emails.ts";
Deno.serve(async (req) => {
  try {
    const ctx = await referralContext(req, true);
    if (ctx.response) return ctx.response;
    const body = await req.json();
    const { data, error } = await ctx.admin!.rpc("manage_referral_payout", {
      p_actor: ctx.user!.id, p_id: body.id, p_action: body.action,
      p_note: String(body.note || "").slice(0,500), p_reference: String(body.reference || "").slice(0,200),
    });
    if (error) throw error;
    if (!data?.ok) return reply(data, 409);
    await dispatchReferralEmails(ctx.admin).catch((error) => console.error("[payout-email] queued", error));
    return reply(data);
  } catch (error) {
    console.error("[admin-manage-referral-payout]", error);
    return reply({ ok:false, error:"Could not update payout. Please try again." },500);
  }
});
