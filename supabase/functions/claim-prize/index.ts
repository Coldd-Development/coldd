// supabase/functions/claim-prize/index.ts
//
// Deploy with:
//   supabase functions deploy claim-prize
//
// Backend for coldd.dev/claim, the giveaway / prize claim portal. Every
// action needs a signed-in coldd account (the claim is tied to it so the
// winner gets nav-bell updates and product prizes land in their Licenses).
//
//   action "upload-url"  -> signed upload URL for the proof screenshot,
//                           into the private prize-claims bucket under
//                           <caller id>/<random>.<ext>
//   action "bbb-start"   -> BuiltByBit OAuth authorize URL (state is signed
//                           and bound to the caller)
//   action "bbb-finish"  -> exchanges the OAuth code, reads /v2/members/self
//                           and returns a short-lived signed proof token
//                           that "submit" accepts for BuiltByBit prizes
//   action "submit"      -> validates the whole claim server-side, writes a
//                           'pending' prize_claims row, notifies the winner
//
// Discord prizes require a Discord identity on the caller's Supabase auth
// user (signed in with Discord, or Discord linked to the account). It is
// read with the service role from auth, never from client-writable
// profile columns.
//
// BuiltByBit OAuth needs these secrets (BuiltByBit account -> API / OAuth
// apps, redirect URI https://coldd.dev/claim/):
//   supabase secrets set BBB_OAUTH_CLIENT_ID=... BBB_OAUTH_CLIENT_SECRET=...
// Until they are set "bbb-start" answers code BBB_NOT_CONFIGURED.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyUser } from "../_shared/notify.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const BUCKET = "prize-claims";
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const PROOF_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const SOURCES = ["discord_giveaway", "discord_event", "builtbybit", "other"];
const PRIZES = ["robux", "product", "currency", "other"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BBB_AUTHORIZE = "https://builtbybit.com/account/external/authorize";
const BBB_TOKEN = "https://api.builtbybit.com/oauth2/token";
const BBB_REVOKE = "https://api.builtbybit.com/oauth2/token/revoke";
const BBB_SELF = "https://api.builtbybit.com/v2/members/self";
const BBB_PROOF_TTL = 2 * 60 * 60;     // seconds a BuiltByBit verification stays valid
const STATE_TTL = 15 * 60;
const MAX_OPEN_CLAIMS = 10;

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

function clean(v: unknown, max: number): string {
  return String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

// ---- signed tokens (OAuth state + BuiltByBit proof) ----------------------

function b64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
async function hmacKey() {
  const secret = Deno.env.get("CLAIM_SIGNING_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return crypto.subtle.importKey("raw", new TextEncoder().encode("claim-prize:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(payload: Record<string, unknown>): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(body)));
  return body + "." + b64url(sig);
}
async function readToken(token: string, kind: string, uid: string): Promise<Record<string, unknown> | null> {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), b64urlDecode(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (p.k !== kind || p.uid !== uid || typeof p.exp !== "number" || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}

// ---- helpers ---------------------------------------------------------------

function bbbConfig() {
  const id = Deno.env.get("BBB_OAUTH_CLIENT_ID") || "";
  const secret = Deno.env.get("BBB_OAUTH_CLIENT_SECRET") || "";
  const redirect = Deno.env.get("BBB_OAUTH_REDIRECT_URI") || "https://coldd.dev/claim/";
  return id && secret ? { id, secret, redirect } : null;
}

function discordIdentity(user: { identities?: Array<{ provider: string; identity_data?: Record<string, unknown> }> }) {
  const ident = (user.identities || []).find((i) => i.provider === "discord");
  if (!ident) return null;
  const d = (ident.identity_data || {}) as Record<string, any>;
  const id = String(d.provider_id || d.sub || "");
  if (!id) return null;
  const handle = String(d.name || d.user_name || d.full_name || "").replace(/#0$/, "");
  const display = String((d.custom_claims && d.custom_claims.global_name) || d.full_name || handle || "");
  const name = display && handle && display !== handle ? `${display} (@${handle})` : (display || handle || id);
  return { id, name: name.slice(0, 200) };
}

function parseGamepassId(raw: string): string | null {
  const m = raw.match(/roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?game-pass(?:es)?\/(\d{1,20})/i);
  return m ? m[1] : null;
}

async function gamepassInfo(id: string): Promise<{ found: boolean; info: Record<string, unknown> | null }> {
  try {
    const res = await fetch(`https://apis.roblox.com/game-passes/v1/game-passes/${id}/product-info`, { signal: AbortSignal.timeout(6000) });
    const text = await res.text();
    if (/not found/i.test(text) && !text.trim().startsWith("{")) return { found: false, info: null };
    if (!res.ok) return { found: true, info: null };     // unknown upstream state: don't block the winner
    const j = JSON.parse(text);
    return {
      found: true,
      info: {
        name: j.Name ?? null,
        price: j.PriceInRobux ?? null,
        forSale: j.IsForSale ?? null,
        creatorName: j.Creator?.Name ?? null,
        creatorType: j.Creator?.CreatorType ?? null,
        creatorId: j.Creator?.CreatorTargetId ?? null,
      },
    };
  } catch {
    return { found: true, info: null };
  }
}

function newRef(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "CLM-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const PRIZE_LABEL: Record<string, string> = { robux: "Robux", product: "Product", currency: "Real currency", other: "Prize" };

// ---- handler ---------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in to claim your prize." }, 401);
    const uid = userData.user.id;

    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    const { data: banned } = await admin.from("profiles").select("banned").eq("id", uid).maybeSingle();
    if (banned && (banned as { banned?: boolean }).banned) return json({ ok: false, error: "This account can't submit prize claims." }, 403);

    // ---- proof screenshot upload ---------------------------------------
    if (action === "upload-url") {
      const { data: allowed } = await admin.rpc("check_rate_limit", { p_key: `claim-upload:${uid}`, p_max: 20, p_window_seconds: 3600 });
      if (allowed === false) return json({ ok: false, error: "Too many uploads. Please wait a bit and try again." }, 429);
      const ext = PROOF_EXT[String(body.contentType || "")];
      if (!ext) return json({ ok: false, error: "Please upload a PNG, JPG, WEBP or GIF image." }, 400);
      const size = Number(body.size) || 0;
      if (size <= 0 || size > MAX_PROOF_BYTES) return json({ ok: false, error: "Screenshots must be 8 MB or smaller." }, 400);
      const path = `${uid}/${crypto.randomUUID()}.${ext}`;
      const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
      if (signErr || !signed) return json({ ok: false, error: "Could not prepare the upload. Please try again." }, 500);
      return json({ ok: true, bucket: BUCKET, path, token: signed.token });
    }

    // ---- BuiltByBit OAuth ------------------------------------------------
    if (action === "bbb-start") {
      const cfg = bbbConfig();
      if (!cfg) return json({ ok: false, code: "BBB_NOT_CONFIGURED", error: "BuiltByBit sign-in isn't available yet. Please contact us on Discord to claim this prize." }, 503);
      const state = await signToken({ k: "bbb-state", uid, n: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + STATE_TTL });
      const q = new URLSearchParams({ client_id: cfg.id, redirect_uri: cfg.redirect, response_type: "code", state });
      return json({ ok: true, url: `${BBB_AUTHORIZE}?${q}` });
    }

    if (action === "bbb-finish") {
      const cfg = bbbConfig();
      if (!cfg) return json({ ok: false, code: "BBB_NOT_CONFIGURED", error: "BuiltByBit sign-in isn't available yet." }, 503);
      const code = clean(body.code, 2000);
      const state = await readToken(String(body.state || ""), "bbb-state", uid);
      if (!code || !state) return json({ ok: false, error: "That BuiltByBit sign-in expired or belongs to another account. Please try again." }, 400);

      const basic = btoa(`${cfg.id}:${cfg.secret}`);
      const tokRes = await fetch(BBB_TOKEN, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cfg.redirect }),
      });
      const tok = await tokRes.json().catch(() => null);
      const accessToken = tok?.access_token || tok?.data?.access_token;
      if (!tokRes.ok || !accessToken) {
        console.error("[claim-prize] bbb token exchange failed:", tokRes.status, JSON.stringify(tok).slice(0, 300));
        return json({ ok: false, error: "BuiltByBit didn't accept that sign-in. Please try again." }, 502);
      }

      const selfRes = await fetch(BBB_SELF, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
      const selfJson = await selfRes.json().catch(() => null);
      // Revoke straight away - we only needed to know who they are.
      fetch(BBB_REVOKE, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }),
      }).catch(() => {});
      const m = selfJson?.data?.self ?? selfJson?.data ?? selfJson?.self ?? null;
      const bbbId = m && (m.user_id ?? m.member_id ?? m.id);
      if (!selfRes.ok || !bbbId) {
        console.error("[claim-prize] bbb self lookup failed:", selfRes.status, JSON.stringify(selfJson).slice(0, 300));
        return json({ ok: false, error: "Couldn't read your BuiltByBit account. Please try again." }, 502);
      }
      const member = {
        id: String(bbbId),
        username: String(m.username || "").slice(0, 120),
        avatar: String(m.avatar_url_small || m.avatar_url_medium || "").slice(0, 500),
        url: String(m.user_url || "").slice(0, 300),
      };
      const proof = await signToken({ k: "bbb-proof", uid, bid: member.id, bun: member.username, exp: Math.floor(Date.now() / 1000) + BBB_PROOF_TTL });
      return json({ ok: true, member, proof });
    }

    // ---- submit ----------------------------------------------------------
    if (action === "submit") {
      const { data: allowed } = await admin.rpc("check_rate_limit", { p_key: `claim-submit:${uid}`, p_max: 6, p_window_seconds: 3600 });
      if (allowed === false) return json({ ok: false, error: "Too many claims in a short time. Please wait a bit and try again." }, 429);

      const { count: openCount } = await admin.from("prize_claims").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "pending");
      if ((openCount || 0) >= MAX_OPEN_CLAIMS) return json({ ok: false, error: "You already have several claims awaiting confirmation. Please wait for those to be reviewed." }, 429);

      const source = String(body.source || "");
      const prize = String(body.prizeType || "");
      if (!SOURCES.includes(source)) return json({ ok: false, field: "source", error: "Choose where you received this prize." }, 400);
      if (!PRIZES.includes(prize)) return json({ ok: false, field: "prize", error: "Choose what the prize was." }, 400);

      const row: Record<string, unknown> = { user_id: uid, source, prize_type: prize, status: "pending" };

      if (source === "other") {
        const t = clean(body.sourceOther, 500);
        if (t.length < 3) return json({ ok: false, field: "sourceOther", error: "Tell us where you won this prize." }, 400);
        row.source_other = t;
      }
      if (prize === "other") {
        const t = clean(body.prizeOther, 500);
        if (t.length < 3) return json({ ok: false, field: "prizeOther", error: "Tell us what you won." }, 400);
        row.prize_other = t;
      }

      // Identity the source requires.
      if (source === "discord_giveaway" || source === "discord_event") {
        const { data: full, error: fullErr } = await admin.auth.admin.getUserById(uid);
        const d = !fullErr && full?.user ? discordIdentity(full.user as any) : null;
        if (!d) return json({ ok: false, field: "verify", error: "Sign in with Discord to claim a Discord prize." }, 403);
        row.verified_discord_id = d.id;
        row.verified_discord_name = d.name;
      } else if (source === "builtbybit") {
        const p = await readToken(String(body.bbbProof || ""), "bbb-proof", uid);
        if (!p) return json({ ok: false, field: "verify", error: "Sign in with BuiltByBit to claim a BuiltByBit prize." }, 403);
        row.verified_bbb_id = String(p.bid);
        row.verified_bbb_name = String(p.bun || "");
      }

      // Payout detail for the prize.
      if (prize === "robux") {
        const url = clean(body.gamepassUrl, 300);
        const gp = parseGamepassId(url);
        if (!gp) return json({ ok: false, field: "gamepass", error: "Paste the full gamepass link, like https://www.roblox.com/game-pass/123456789." }, 400);
        const look = await gamepassInfo(gp);
        if (!look.found) return json({ ok: false, field: "gamepass", error: "We couldn't find that gamepass on Roblox. Check the link and try again." }, 400);
        if (look.info && look.info.forSale === false) return json({ ok: false, field: "gamepass", error: "That gamepass isn't on sale yet. Put it on sale, then submit again." }, 400);
        row.gamepass_url = `https://www.roblox.com/game-pass/${gp}`;
        row.gamepass_id = Number(gp);
        row.gamepass_info = look.info;
      } else if (prize === "currency") {
        const email = clean(body.paypalEmail, 254).toLowerCase();
        if (!EMAIL_RE.test(email)) return json({ ok: false, field: "paypal", error: "Enter the email address on your PayPal account." }, 400);
        row.paypal_email = email;
      } else if (prize === "product") {
        const slug = clean(body.productSlug, 200);
        const { data: list } = await admin.rpc("claimable_products");
        const hit = (list || []).find((p: { slug: string }) => p.slug === slug);
        if (!hit) return json({ ok: false, field: "product", error: "The product you're searching for may be unavailable for giveaway claims, please try again." }, 400);
        row.product_id = hit.id;
        row.product_slug = hit.slug;
        row.product_title = hit.title;
      }

      // Proof screenshot: must be the caller's own upload, and really there.
      const proof = String(body.proofPath || "");
      const proofRe = new RegExp(`^${uid}/[0-9a-f-]{36}\\.(png|jpg|webp|gif)$`);
      if (!proofRe.test(proof)) return json({ ok: false, field: "proof", error: "Upload a screenshot showing you won the prize." }, 400);
      const fileName = proof.split("/")[1];
      const { data: listed } = await admin.storage.from(BUCKET).list(uid, { search: fileName, limit: 1 });
      if (!listed || !listed.some((o: { name: string }) => o.name === fileName)) {
        return json({ ok: false, field: "proof", error: "Your screenshot didn't finish uploading. Please add it again." }, 400);
      }
      row.proof_path = proof;

      const { data: prof } = await admin.from("profiles").select("username").eq("id", uid).maybeSingle();
      row.account_email = userData.user.email || null;
      row.account_name = (prof as { username?: string } | null)?.username || null;

      let inserted: { id: string; ref: string } | null = null;
      for (let i = 0; i < 4 && !inserted; i++) {
        const { data, error } = await admin.from("prize_claims").insert({ ...row, ref: newRef() }).select("id, ref").single();
        if (!error && data) inserted = data;
        else if (error && error.code !== "23505") {
          console.error("[claim-prize] insert failed:", error.message);
          return json({ ok: false, error: "Could not save your claim. Please try again." }, 500);
        }
      }
      if (!inserted) return json({ ok: false, error: "Could not save your claim. Please try again." }, 500);

      const what = prize === "product" ? String(row.product_title) : PRIZE_LABEL[prize];
      await notifyUser(
        admin,
        uid,
        "Prize claim received",
        `${inserted.ref} (${what}) is awaiting confirmation. We usually respond within 3 business days.`,
        "/claim/#claims",
      );

      return json({ ok: true, ref: inserted.ref, id: inserted.id });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[claim-prize] error:", err);
    return json({ ok: false, error: "Server error. Please try again." }, 500);
  }
});
