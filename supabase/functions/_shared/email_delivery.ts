import { buildOrderReceipt, sendSingle, type SendResult } from "./email.ts";

export async function queueEmail(admin: any, message: Record<string, unknown>): Promise<SendResult> {
  const { error } = await admin.from("email_delivery_queue").upsert(message, { onConflict: "dedupe_key", ignoreDuplicates: true });
  return error ? { ok: false, error: "Could not queue email: " + error.message } : { ok: true };
}

export async function drainEmailQueue(admin: any, key: string | null = null) {
  const { data: messages, error } = await admin.rpc("claim_email_delivery", { p_key: key });
  if (error) throw error;
  let sent = 0;
  for (const item of messages || []) {
    try {
      let payload = item;
      if (item.category === "receipt" && !item.html) {
        payload = await buildOrderReceipt(admin, item.order_id);
        if (!payload.ok) throw new Error(payload.error);
        payload.recipient = payload.to;
        const { error: persistError } = await admin.from("email_delivery_queue").update({ recipient: payload.recipient, subject: payload.subject, html: payload.html }).eq("id", item.id);
        if (persistError) throw persistError;
      }
      if (item.kind === "marketing") {
        const { data: allowed, error: prefError } = await admin.rpc("email_marketing_allowed", { p_email: payload.recipient });
        if (prefError) throw prefError;
        if (!allowed) {
          await admin.from("email_delivery_queue").update({ status: "suppressed", locked_at: null, last_error: "Marketing preference disabled" }).eq("id", item.id);
          continue;
        }
        if (item.category.startsWith("cart/")) {
          const session = item.category.slice(5);
          const { data: cart, error: cartError } = await admin.from("cart_snapshots").select("session_id").eq("session_id", session).maybeSingle();
          if (cartError) throw cartError;
          if (!cart) {
            await admin.from("email_delivery_queue").update({ status: "suppressed", locked_at: null, last_error: "Cart completed or removed" }).eq("id", item.id);
            continue;
          }
        }
      }
      const { data: suppression, error: suppressionError } = await admin.from("email_suppressions").select("email").eq("email", String(payload.recipient).toLowerCase()).maybeSingle();
      if (suppressionError) throw suppressionError;
      if (suppression) {
        await admin.from("email_delivery_queue").update({ status: "suppressed", locked_at: null, last_error: "Address suppressed" }).eq("id", item.id);
        continue;
      }
      const result = await sendSingle(payload.recipient, payload.subject, payload.html, payload.headers || undefined, `delivery/${item.id}`, { replyTo: item.reply_to || undefined, from: item.from_address || undefined, campaignId: item.campaign_id || undefined });
      if (!result.ok) throw new Error(result.error);
      const { error: updateError } = await admin.from("email_delivery_queue").update({ status: "sent", recipient: payload.recipient, sent_at: new Date().toISOString(), locked_at: null, last_error: null }).eq("id", item.id);
      if (updateError) throw updateError;
      if (item.category.startsWith("cart/")) await admin.from("cart_snapshots").update({ abandoned_email_sent_at: new Date().toISOString() }).eq("session_id", item.category.slice(5));
      sent++;
    } catch (err) {
      const message = String(err).slice(0, 500);
      const permanent = /HTTP 4\d\d/.test(message) && !/HTTP 429|HTTP 409/.test(message);
      await admin.from("email_delivery_queue").update({ status: permanent ? "failed" : "pending", locked_at: null, available_at: new Date(Date.now() + Math.min(360, 5 * 2 ** item.attempts) * 60_000).toISOString(), last_error: message }).eq("id", item.id);
      console.error("[email-delivery] delivery pending", item.id);
    }
  }
  return { sent, claimed: (messages || []).length };
}
