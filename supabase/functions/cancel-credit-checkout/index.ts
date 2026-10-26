import Stripe from "https://esm.sh/stripe@16.5.0?target=deno";
import {referralContext,reply} from "../_shared/referral_api.ts";
Deno.serve(async req=>{try{
 const ctx=await referralContext(req);if(ctx.response)return ctx.response;
 const {orderId}=await req.json();const {data:order,error}=await ctx.admin!.from('orders').select('id,status,user_id,purchased_by_user_id,store_credit_applied,stripe_checkout_session_id').eq('id',String(orderId||'')).maybeSingle();
 if(error)throw error;if(!order||String(order.purchased_by_user_id||order.user_id)!==ctx.user!.id)return reply({ok:false,error:'Order not found.'},404);
 if(order.status==='canceled'||order.status==='failed')return reply({ok:true});
 if(order.status!=='pending'||!(Number(order.store_credit_applied)>0))return reply({ok:false,error:'This checkout cannot be canceled. Check your order status.'},409);
 if(order.stripe_checkout_session_id){const stripe=new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!,{httpClient:Stripe.createFetchHttpClient(),apiVersion:'2024-06-20'});const session=await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);if(session.status==='complete')return reply({ok:false,error:'Payment is already being processed. Check your dashboard.'},409);if(session.status==='open')await stripe.checkout.sessions.expire(session.id);}
 const {error:updateError}=await ctx.admin!.from('orders').update({status:'canceled'}).eq('id',order.id).eq('status','pending');if(updateError)throw updateError;
 return reply({ok:true});
}catch(error){console.error('[cancel-credit-checkout]',error);return reply({ok:false,error:'Could not cancel checkout yet. Your credit stays reserved until checkout expires.'},500);}});