// supabase/functions/sale-alerts/index.ts
//
// Sale alerts to the owner's iPhone through the free Bark app (see
// migrations/20261125a_sale_alerts.sql for the whole flow).
//
//   POST {"action":"flush"}   (or "sync")   send every queued alert. Called by the
//        database trigger the moment a sale is saved, and by the sale-alerts cron job
//        every minute as a safety net. Auth: x-cron-secret.
//   POST {"action":"test", "device_id"?}     send a sample alert to one phone (or all)
//        and report what each phone's Bark said. Auth: a signed-in admin.
//
//   supabase functions deploy sale-alerts --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { alertText, audRates, flushSaleAlerts, inAud, pushTo } from "../_shared/sale_alerts.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "flush");

  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Please sign in." }, 401);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!prof?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
  }

  if (action === "flush" || action === "sync") {
    return json({ ok: true, ...(await flushSaleAlerts(admin)) });
  }

  if (action === "test") {
    let q = admin.from("sale_alert_devices").select("*");
    if (body.device_id) q = q.eq("id", String(body.device_id));
    const [{ data: devs }, { data: st }] = await Promise.all([q, admin.from("sale_alert_settings").select("*").eq("id", true).maybeSingle()]);
    if (!devs?.length) return json({ ok: false, error: "Add a phone first." }, 400);
    // A sample US$24.99 BuiltByBit sale, shown the way real alerts are (in AU$).
    const sample = alertText({ source: "builtbybit", product: "Catch a Fish", more: 0, ...inAud(24.99, "USD", await audRates(["USD"])) });
    const results = await Promise.all(devs.map(async (d: { id: string; name: string }) => {
      const err = await pushTo(d, { ...sample, pushId: "sale-test", silent: false }, st || {});
      await admin.from("sale_alert_devices").update(err ? { last_error: err } : { last_sent_at: new Date().toISOString(), last_error: null }).eq("id", d.id);
      return { id: d.id, name: d.name, ok: !err, error: err };
    }));
    // ok: the test ran; each phone's own result is in results.
    return json({ ok: true, sent: results.some((r) => r.ok), results });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
