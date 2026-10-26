import { queueEmail } from "./email_delivery.ts";
import { wrapTransactionalEmail, ctaButtonHtml } from "./email.ts";

function escape(value: string) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function dispatchReferralEmails(admin: any) {
  const { data: messages, error } = await admin.rpc("claim_referral_emails");
  if (error) throw error;
  let sent = 0;
  for (const item of messages || []) {
    try {
      const adminMessage = item.subject.startsWith("Admin:");
      const link = adminMessage ? "https://coldd.dev/admin/marketing/" : "https://coldd.dev/dashboard?panel=referrals";
      const html = wrapTransactionalEmail('<h1 style="font-size:32px;line-height:1.15;color:#f4f6f9;margin:0 0 22px;">'+escape(item.subject)+'</h1><p>'+escape(item.body)+'</p>'+ctaButtonHtml(link, adminMessage ? 'Review payout requests' : 'View your referrals'));
      const result = await queueEmail(admin, { dedupe_key: `referral/${item.id}`, kind: "service", category: "referral", recipient: item.recipient, subject: item.subject, html });
      if (!result.ok) throw new Error(result.error);
      const { error: updateError } = await admin.from("referral_email_outbox").update({ sent_at: new Date().toISOString(), last_error: null }).eq("id", item.id);
      if (updateError) throw updateError;
      sent++;
    } catch (error) {
      await admin.from("referral_email_outbox").update({ last_error: String(error).slice(0, 500) }).eq("id", item.id);
      console.error("[referral-email] delivery pending", item.id);
    }
  }
  return { sent, queued: (messages || []).length - sent };
}
