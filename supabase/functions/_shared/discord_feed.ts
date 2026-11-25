// coldd's Discord bot (coldd-dc-bot, cogs/coldd_feed.py) forwards every message Parcel's
// bot posts in the purchases and reviews channels. platform-sales-ingest hands any body
// with a `bot` field to handleBot.
//
// Sign-in: the bot makes its own key and sends it in x-bot-key. Only its SHA-256 is
// stored (bot_ingest_keys). A new key is 'pending' until the owner approves it by
// matching the pairing code in the bot's console with the fingerprint.
//
//   { bot: 'pair', label?, bot_user? }        -> { status, fingerprint }
//   { bot: 'state' }                          -> { channels: { <channel id>: <newest stored message id> } }
//   { bot: 'messages', messages: [...] }      -> { ok, stored, parsed }
//
// Messages are stored as they came (discord_feed_messages) and read by parcel_feed.ts.

import { processFeed, retryWaiting } from "./parcel_feed.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export const FEED_CHANNELS: Record<string, "purchase" | "review"> = {
  "1254069976437096529": "purchase",
  "1247416021862711398": "review",
  // Parcel's purchase log in coldd's old server (Dec 2024 to Feb 2026): history only.
  "1331866660528717886": "purchase",
};
const MAX_MESSAGES = 200;
const MAX_PENDING = 10;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
async function sha256(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function fingerprintOf(hash: string) { return (hash.slice(0, 4) + "-" + hash.slice(4, 8)).toUpperCase(); }
const snowflake = (v: unknown) => /^\d{5,25}$/.test(String(v ?? "")) ? String(v) : null;
function when(v: unknown) {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function cut(v: unknown, max: number) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

export async function handleBot(req: Request, body: Obj, sb: Obj): Promise<Response> {
  const key = req.headers.get("x-bot-key") || "";
  if (key.length < 32 || key.length > 200) return json({ error: "x-bot-key missing." }, 401);
  const hash = await sha256(key);
  const fingerprint = fingerprintOf(hash);
  const { data: row, error: rowErr } = await sb.from("bot_ingest_keys").select("status, last_used_at").eq("key_hash", hash).maybeSingle();
  if (rowErr) return json({ error: "Key check failed." }, 500);

  if (body.bot === "pair") {
    if (row) return json({ status: row.status, fingerprint });
    const { count } = await sb.from("bot_ingest_keys").select("key_hash", { count: "exact", head: true }).eq("status", "pending");
    if ((count ?? 0) >= MAX_PENDING) return json({ error: "Too many keys waiting for approval." }, 429);
    const { error } = await sb.from("bot_ingest_keys").insert({
      key_hash: hash, fingerprint, label: cut(body.label, 80), status: "pending",
      meta: { bot_user: cut(body.bot_user, 120), bot_user_id: snowflake(body.bot_user_id) },
    });
    if (error) return json({ error: "Could not save the key." }, 500);
    return json({ status: "pending", fingerprint });
  }

  if (!row) return json({ error: "Unknown key. Pair it first.", fingerprint }, 401);
  if (row.status !== "active") return json({ error: "Key is " + row.status + ".", status: row.status, fingerprint }, 403);
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await sb.from("bot_ingest_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", hash);
  }

  if (body.bot === "state") {
    // The bot asks every few minutes: purchases waiting for the group ledger are retried here.
    let retried: Obj = {};
    try { retried = await retryWaiting(sb, 800); } catch (e) { retried = { error: (e as Error).message }; }
    const channels: Record<string, string | null> = {};
    for (const id of Object.keys(FEED_CHANNELS)) {
      const { data } = await sb.from("discord_feed_messages").select("message_id").eq("channel_id", id)
        .order("posted_at", { ascending: false }).limit(1);
      channels[id] = data?.[0]?.message_id ?? null;
    }
    return json({ channels, retried });
  }

  if (body.bot === "messages") {
    const list = Array.isArray(body.messages) ? body.messages : null;
    if (!list) return json({ error: "messages must be an array." }, 400);
    if (list.length > MAX_MESSAGES) return json({ error: `At most ${MAX_MESSAGES} messages per call.` }, 400);
    const rows: Obj[] = [];
    const skipped: { index: number; reason: string }[] = [];
    const now = new Date().toISOString();
    list.forEach((m: Obj, i: number) => {
      const id = snowflake(m?.id), channel = snowflake(m?.channel_id);
      const posted = when(m?.created_at);
      if (!id || !channel || !posted) { skipped.push({ index: i, reason: "missing id, channel or time" }); return; }
      const kind = FEED_CHANNELS[channel];
      if (!kind) { skipped.push({ index: i, reason: "not a feed channel" }); return; }
      const embeds = Array.isArray(m.embeds) ? m.embeds.slice(0, 10) : [];
      rows.push({
        message_id: id, guild_id: snowflake(m.guild_id), channel_id: channel, kind,
        author_id: snowflake(m.author?.id), author_name: cut(m.author?.name, 120), author_bot: !!m.author?.bot,
        posted_at: posted, edited_at: when(m.edited_at), content: cut(m.content, 8000), embeds,
        extra: { webhook_id: snowflake(m.webhook_id), components: Array.isArray(m.components) ? m.components.slice(0, 10) : null,
          attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 10) : null, deleted: !!m.deleted },
        updated_at: now, parse_status: "new", parse_error: null,
      });
    });
    let stored = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const { error } = await sb.from("discord_feed_messages").upsert(chunk, { onConflict: "message_id" });
      if (error) return json({ error: "Could not save messages: " + error.message, stored }, 500);
      stored += chunk.length;
    }
    let parsed: Obj = {};
    try { parsed = await processFeed(sb, rows.map((r) => r.message_id)); }
    catch (e) { parsed = { error: (e as Error).message }; }
    return json({ ok: true, stored, skipped, parsed });
  }

  return json({ error: "Unknown bot action." }, 400);
}
