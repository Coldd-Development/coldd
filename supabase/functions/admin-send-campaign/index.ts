import { emailHeading } from "../_shared/email_design.ts";
import { queueEmail, drainEmailQueue } from "../_shared/email_delivery.ts";
// supabase/functions/admin-send-campaign/index.ts
//
// Deploy with:
//   supabase functions deploy admin-send-campaign
//
// Three actions:
//
//   { action: "status" }
//   Returns whether RESEND_API_KEY is set, for the admin panel's
//   "email sending isn't configured yet" banner.
//
//   { action: "test", subject, bodyHtml, testEmail }
//   Sends one email to testEmail only. Never touches email_campaigns.
//
//   { action: "send", subject, bodyHtml, audience }
//   audience 'marketing' (default): sends only to real opt-ins
//   (marketing_optins where unsubscribed_at is null), minus banned and
//   synthetic Roblox addresses. audience 'announcement': sends to every
//   account with a real, non-synthetic email regardless of marketing
//   consent - restricted to the site owner's linked accounts
//   (callerCanAnnounce). Writes one email_campaigns row up front (status
//   'sending'), sends in batches of 100 via Resend's batch endpoint, then
//   updates the row with final counts/status.
//
// Runs synchronously inside the request - fine for the audience sizes this
// site has today (dozens to low hundreds of accounts). A list in the tens
// of thousands would need a queue instead of one request doing every batch
// inline; not built here because there's no audience anywhere near that
// size yet, and building a queue for load that doesn't exist is exactly
// the kind of premature machinery this codebase avoids elsewhere.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emailConfigured, sendBatch, sendSingle, unsubscribeHeaders, wrapAnnouncementEmail, wrapCampaignEmail, type BatchEmail } from "../_shared/email.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const BATCH_SIZE = 100;
const SYNTH_EMAIL_RE = /@roblox\.coldd\.internal$/i;

// An announcement goes to EVERY account regardless of marketing consent
// (ToS changes, outages), so who can send one is locked to the site
// owner's own linked accounts - checked here server-side, not just hidden
// in the UI. Discord id is the stable check; the handle checks are a
// convenience if the owner links a Roblox account later.
const ANNOUNCE_ALLOWED_DISCORD_IDS = ["1327350011054526505"];
const ANNOUNCE_ALLOWED_DISCORD_USERNAMES = ["frchrono."];
const ANNOUNCE_ALLOWED_ROBLOX_USERNAMES = ["frchrono"];

// deno-lint-ignore no-explicit-any
function callerCanAnnounce(p: any): boolean {
  if (!p) return false;
  if (p.discord_id && ANNOUNCE_ALLOWED_DISCORD_IDS.includes(String(p.discord_id))) return true;
  const discordUser = String(p.member_info?.user || "").toLowerCase();
  if (discordUser && ANNOUNCE_ALLOWED_DISCORD_USERNAMES.includes(discordUser)) return true;
  const uname = String(p.username || "").toLowerCase();
  if (p.roblox_id && ANNOUNCE_ALLOWED_ROBLOX_USERNAMES.includes(uname)) return true;
  return false;
}

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
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("is_admin, email_unsub_token, discord_id, roblox_id, username, member_info")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const canAnnounce = callerCanAnnounce(profile);
    const unsubUrl = (token: string) => `${supabaseUrl}/functions/v1/email-unsubscribe?t=${token}`;

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "status") return json({ ok: true, configured: emailConfigured(), canAnnounce });

    // 'marketing'    - only real opt-ins (marketing_optins, not withdrawn)
    // 'announcement' - every account with a real email, ignores consent
    const audience = body.audience === "announcement" ? "announcement" : "marketing";

    const subject = String(body.subject || "").trim();
    const bodyHtml = String(body.bodyHtml || "").trim();
    if (!subject || !bodyHtml) return json({ ok: false, error: "Subject and body are required." }, 400);

    const wrap = audience === "announcement" ? wrapAnnouncementEmail : wrapCampaignEmail;

    if (action === "test") {
      const testEmail = String(body.testEmail || "").trim();
      if (!testEmail) return json({ ok: false, error: "Enter an email to send the test to." }, 400);
      const testUnsubUrl = unsubUrl(profile.email_unsub_token);
      const html = wrap((/<h1\b/i.test(bodyHtml) ? "" : emailHeading(subject)) + bodyHtml, testUnsubUrl);
      const result = await sendSingle(testEmail, `[Test] ${subject}`, html, unsubscribeHeaders(testUnsubUrl));
      if (!result.ok) return json({ ok: false, error: result.error, code: result.code }, result.code === "NOT_CONFIGURED" ? 400 : 502);
      return json({ ok: true });
    }

    if (action !== "send") return json({ ok: false, error: "Unknown action." }, 400);

    if (audience === "announcement" && !canAnnounce) {
      return json({ ok: false, error: "Announcements can only be sent from the site owner's account." }, 403);
    }

    if (!emailConfigured()) {
      return json({ ok: false, error: "Email sending is not configured yet - RESEND_API_KEY is not set.", code: "NOT_CONFIGURED" }, 400);
    }

    // { to, token } pairs. `token` builds the unsubscribe link - a profile
    // token for announcements, a marketing_optins token for marketing.
    let recipientList: { to: string; token: string }[] = [];

    if (audience === "announcement") {
      const { data: rows, error: recErr } = await admin
        .from("profiles")
        .select("email, email_unsub_token")
        .not("email", "is", null)
        .not("email", "ilike", "%@roblox.coldd.internal")
        .or("banned.is.null,banned.eq.false");
      if (recErr) return json({ ok: false, error: "Could not load recipients." }, 500);
      recipientList = (rows || [])
        .filter((r) => !!r.email && !SYNTH_EMAIL_RE.test(r.email))
        .map((r) => ({ to: r.email as string, token: r.email_unsub_token as string }));
    } else {
      // Marketing: real opt-ins only, minus withdrawals and banned accounts.
      const { data: rows, error: recErr } = await admin
        .from("marketing_optins")
        .select("email, unsub_token")
        .is("unsubscribed_at", null);
      if (recErr) return json({ ok: false, error: "Could not load recipients." }, 500);
      // An account can also withdraw via the dashboard Notifications toggle
      // (profiles.marketing_unsubscribed) without touching marketing_optins,
      // or be banned - exclude both.
      const { data: profRows, error: profileError } = await admin
        .from("profiles").select("email, email_unsub_token, banned, marketing_unsubscribed, notification_prefs").not("email", "is", null);
      if (profileError) return json({ ok: false, error: "Could not check marketing preferences." }, 503);
      const blocked = new Set(
        (profRows || [])
          .filter((p) => p.banned || p.marketing_unsubscribed || p.notification_prefs?.promotions === false)
          .map((p) => String(p.email).toLowerCase()),
      );
      const seen = new Set<string>();
      recipientList = (rows || [])
        .filter((r) => {
          const e = String(r.email || "").toLowerCase();
          if (!e || SYNTH_EMAIL_RE.test(e) || blocked.has(e) || seen.has(e)) return false;
          seen.add(e);
          return true;
        })
        .map((r) => ({ to: r.email as string, token: r.unsub_token as string }));
      for (const p of profRows || []) {
        const email = String(p.email || "").toLowerCase();
        if (p.notification_prefs?.promotions === true && !blocked.has(email) && !seen.has(email) && !SYNTH_EMAIL_RE.test(email)) {
          recipientList.push({ to: email, token: p.email_unsub_token });
          seen.add(email);
        }
      }
    }

    if (!recipientList.length) return json({ ok: false, error: "No recipients for this audience." }, 400);

    const { data: campaign, error: campaignErr } = await admin
      .from("email_campaigns")
      .insert({
        subject,
        body_html: bodyHtml,
        status: "sending",
        recipient_count: recipientList.length,
        audience,
        created_by: userData.user.id,
      })
      .select()
      .single();
    if (campaignErr || !campaign) return json({ ok: false, error: "Could not create campaign." }, 500);

    let queuedCount = 0;
    for (const recipient of recipientList) {
      const u = unsubUrl(recipient.token);
      const result = await queueEmail(admin, { dedupe_key: 'campaign/'+campaign.id+'/'+recipient.to.toLowerCase(), recipient: recipient.to.toLowerCase(), kind: audience === 'marketing' ? 'marketing' : 'service', category: audience, campaign_id: campaign.id, subject, html: wrap((/<h1\b/i.test(bodyHtml) ? "" : emailHeading(subject)) + bodyHtml, u), headers: unsubscribeHeaders(u) });
      if (!result.ok) return json({ ok: false, error: result.error, queuedCount }, 503);
      queuedCount++;
    }
    return json({ ok: true, queuedCount, sentCount: 0, failedCount: 0, recipientCount: recipientList.length, audience });
  } catch (err) {
    console.error("[admin-send-campaign] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
