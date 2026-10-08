// supabase/functions/admin-manage-user/index.ts
//
// Deploy with:
//   supabase functions deploy admin-manage-user
//
// Account tools for the admin panel's user profile view. Admin or owner only.
//   updateProfile { userId, username?, clearAvatar? }  -> change a username or remove their profile picture
//   setPassword   { userId, password }                 -> set a new password (8 to 72 characters)
// Staff accounts (owner / admin / support) can only be edited by an owner, and an owner account can
// only be edited by that owner themselves, so these tools cannot be used to take over a staff account.
// Every change is written to admin_audit_log.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: caller } = await admin.from("profiles").select("is_admin, role, username, email").eq("id", userData.user.id).single();
    const callerRole = caller?.role || (caller?.is_admin ? "admin" : "");
    if (!caller?.is_admin || (callerRole !== "admin" && callerRole !== "owner")) {
      return json({ ok: false, error: "Admin access required." }, 403);
    }
    const callerName = caller.username || caller.email || "admin";

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const targetId = String(body.userId || "").slice(0, 64);
    if (!targetId) return json({ ok: false, error: "Missing userId." }, 400);

    const { data: target } = await admin.from("profiles").select("id, is_admin, role, username, email").eq("id", targetId).single();
    if (!target) return json({ ok: false, error: "User not found." }, 404);
    const targetRole = target.role || (target.is_admin ? "admin" : "");
    const targetIsStaff = !!target.is_admin || targetRole === "owner" || targetRole === "admin" || targetRole === "support";
    if (targetRole === "owner" && target.id !== userData.user.id) return json({ ok: false, error: "Only that owner can change their own account." }, 403);
    if (targetIsStaff && target.id !== userData.user.id && callerRole !== "owner") {
      return json({ ok: false, error: "Only an owner can change a staff account." }, 403);
    }
    const label = target.username || target.email || target.id;

    if (action === "updateProfile") {
      const patch: Record<string, unknown> = {};
      if (body.username != null) {
        const username = String(body.username).trim();
        if (!USERNAME_RE.test(username)) return json({ ok: false, error: "Usernames are 3 to 32 characters: letters, numbers, dots, dashes and underscores." }, 400);
        const { data: taken } = await admin.from("profiles").select("id").ilike("username", username).neq("id", targetId).limit(1);
        if (taken && taken.length) return json({ ok: false, error: "That username is already taken." }, 409);
        patch.username = username;
      }
      if (body.clearAvatar === true) patch.avatar_url = null;
      if (!Object.keys(patch).length) return json({ ok: false, error: "Nothing to change." }, 400);
      const { error: upErr } = await admin.from("profiles").update(patch).eq("id", targetId);
      if (upErr) return json({ ok: false, error: "Could not update the profile." }, 500);
      await admin.from("admin_audit_log").insert({
        actor_id: userData.user.id, actor_name: callerName,
        action: "Updated profile for " + label + (patch.username ? " (username -> " + patch.username + ")" : "") + (body.clearAvatar === true ? " (removed profile picture)" : ""),
      });
      return json({ ok: true });
    }

    if (action === "setPassword") {
      const password = String(body.password || "");
      if (password.length < 8 || password.length > 72) return json({ ok: false, error: "Use 8 to 72 characters for the password." }, 400);
      const { error: pwErr } = await admin.auth.admin.updateUserById(targetId, { password });
      if (pwErr) return json({ ok: false, error: "Could not set the password." }, 500);
      await admin.from("admin_audit_log").insert({
        actor_id: userData.user.id, actor_name: callerName, action: "Set a new password for " + label,
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[admin-manage-user] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
