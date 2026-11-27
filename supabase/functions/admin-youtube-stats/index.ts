// supabase/functions/admin-youtube-stats/index.ts
//
// Deploy with:
//   supabase functions deploy admin-youtube-stats
//
// Real subscriber/view counts via the YouTube Data API v3 channels.list
// endpoint (public statistics, no OAuth needed - just an API key). Needs
// two secrets set (`supabase secrets set YOUTUBE_API_KEY=... YOUTUBE_CHANNEL_ID=...`):
// a Data API key from Google Cloud Console, and the channel's ID (the
// UC... string, not the @handle - found via the channel's "About" page
// or the API's forHandle lookup).
//
// Returns { ok: true, configured: false } rather than an error when the
// secrets aren't set yet, so the Marketing tab can show a clean
// "not connected" state instead of a red error banner.
//
// Body: {} (auth only - is_admin gated like the other admin-* functions)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { upsertSocialSnapshot, getSocialHistory } from "../_shared/social.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";

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
      .select("is_admin")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const apiKey = Deno.env.get("YOUTUBE_API_KEY");
    const channelId = Deno.env.get("YOUTUBE_CHANNEL_ID");
    if (!apiKey || !channelId) return json({ ok: true, configured: false });

    const key = encodeURIComponent(apiKey);
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,contentDetails&id=${encodeURIComponent(channelId)}&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[admin-youtube-stats] YouTube API error:", res.status, await res.text().catch(() => ""));
      return json({ ok: false, error: "Could not reach YouTube." }, 502);
    }
    const data = await res.json();
    const channel = data?.items?.[0];
    const stats = channel?.statistics;
    if (!stats) return json({ ok: false, error: "Channel not found." }, 404);

    const subscriberCount = stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount ?? 0);
    const viewCount = Number(stats.viewCount ?? 0);
    const videoCount = Number(stats.videoCount ?? 0);
    const lifetimeViewsPerVideo = videoCount > 0 ? Math.round(viewCount / videoCount) : 0;

    // Recent-upload engagement: walk the uploads playlist for the latest
    // video ids, then pull their per-video statistics in one videos.list
    // call. Pure Data API (the key already in hand) - no OAuth. Best
    // effort: if any step fails the base channel stats still return.
    let engagement: Record<string, number | null> | null = null;
    let recentVideos: Array<Record<string, unknown>> = [];
    const uploadsId = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (uploadsId) {
      try {
        const plRes = await fetch(
          `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploadsId)}&key=${key}`,
        );
        if (plRes.ok) {
          const plJson = await plRes.json();
          const ids: string[] = (plJson?.items ?? [])
            .map((it: any) => it?.contentDetails?.videoId)
            .filter(Boolean);
          if (ids.length) {
            const vRes = await fetch(
              `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${ids.join(",")}&key=${key}`,
            );
            if (vRes.ok) {
              const vJson = await vRes.json();
              const vids: any[] = vJson?.items ?? [];
              let vViews = 0, vLikes = 0, vComments = 0;
              recentVideos = vids.map((v) => {
                const s = v.statistics ?? {};
                const views = Number(s.viewCount ?? 0);
                const likes = Number(s.likeCount ?? 0);
                const comments = Number(s.commentCount ?? 0);
                vViews += views; vLikes += likes; vComments += comments;
                // Length from the ISO 8601 duration (PT1M5S). YouTube Shorts run up to 3 minutes.
                const dm = String(v?.contentDetails?.duration ?? "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
                const durationSec = dm ? (Number(dm[1] ?? 0) * 86400 + Number(dm[2] ?? 0) * 3600 + Number(dm[3] ?? 0) * 60 + Number(dm[4] ?? 0)) : null;
                const isShort = durationSec != null && durationSec > 0 && durationSec <= 180;
                return { id: v.id, title: v?.snippet?.title ?? "", publishedAt: v?.snippet?.publishedAt ?? null, views, likes, comments, durationSec, isShort };
              });
              const n = vids.length;
              const interactions = vLikes + vComments;
              engagement = {
                sampleSize: n,
                views: vViews,
                likes: vLikes,
                comments: vComments,
                interactions,
                avgViewsPerVideo: n ? Math.round(vViews / n) : 0,
                avgLikesPerVideo: n ? Math.round((vLikes / n) * 10) / 10 : 0,
                avgCommentsPerVideo: n ? Math.round((vComments / n) * 10) / 10 : 0,
                engagementRate: vViews > 0 ? Math.round((interactions / vViews) * 10000) / 100 : null,
              };
            }
          }
        }
      } catch (e) {
        console.warn("[admin-youtube-stats] engagement fetch failed:", e);
      }
    }

    const extra: Record<string, unknown> = { viewCount, videoCount, lifetimeViewsPerVideo };
    if (engagement) {
      extra.recentViews = engagement.views;
      extra.recentInteractions = engagement.interactions;
      extra.engagementRate = engagement.engagementRate;
    }
    await upsertSocialSnapshot(admin, "youtube", subscriberCount, extra);
    const history = await getSocialHistory(admin, "youtube");

    const latestPostAt = recentVideos
      .map((v) => v.publishedAt as string | null)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    return json({ ok: true, configured: true, subscriberCount, viewCount, videoCount, lifetimeViewsPerVideo, latestPostAt, engagement, recentVideos, history });
  } catch (err) {
    console.error("[admin-youtube-stats] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
