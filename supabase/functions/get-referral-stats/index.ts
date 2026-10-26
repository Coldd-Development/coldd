import { referralContext, reply } from "../_shared/referral_api.ts";
Deno.serve(async (req) => {
  try {
    const ctx = await referralContext(req);
    if (ctx.response) return ctx.response;
    const admin=ctx.admin!; const id=ctx.user!.id;
    const results = await Promise.all([
      admin.rpc("referral_balances", {p_user_id:id}),
      admin.from("referral_order_earnings").select("product,created_at,currency,amount").eq("referrer_id",id).order("created_at",{ascending:false}).limit(25),
      admin.from("referral_payouts").select("id,method,source_currency,amount_usd,amount_robux,status,requested_at,updated_at,resolved_at,paypal_email,gamepass_url,change_reason,note,transfer_reference").eq("user_id",id).order("requested_at",{ascending:false}).limit(100),
      admin.from("referral_payment_details").select("paypal_email,gamepass_url").eq("user_id",id).maybeSingle(),
      admin.from("store_credit_ledger").select("currency,amount").eq("user_id",id),
    ]);
    for (const result of results) if(result.error) throw result.error;
    const balances=results[0].data; const credit={usd:0,robux:0};
    for(const row of results[4].data||[]) credit[row.currency as 'usd'|'robux']+=Number(row.amount);
    credit.usd=Math.round(credit.usd*100)/100;
    return reply({ok:true,balances,credit,paymentDetails:results[3].data||{},processingHours:72,
      earnedUsd:balances.usd.earned,availableUsd:balances.usd.available,paidUsd:balances.usd.paid,
      payouts:results[2].data||[],recentSales:(results[1].data||[]).map((r:any)=>({product:r.product,date:r.created_at,earned:r.amount,currency:r.currency}))});
  } catch(error) {
    console.error("[get-referral-stats]",error);
    return reply({ok:false,error:"Could not load your referral balances. Please retry."},500);
  }
});
