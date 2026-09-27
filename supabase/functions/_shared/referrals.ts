// Shared by the referral Edge Functions.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const REFERRAL_RATE = 0.20;

export function makeReferralCode(seed: string): string {
  const base = (seed || "user").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "user";
  const suffix = Math.random().toString(36).slice(2, 6);
  return base + suffix;
}

// Referrals are per-product only (no more account-wide "referred_by" -
// whoever's link a buyer used only earns on THAT product's line item, not
// the rest of the cart). Mirrors resolveCampaignCode's "fail open, silently
// drop an unrecognized code" posture: a stale/bogus ref never blocks
// checkout, it just doesn't attribute anything.
export async function resolveProductReferral(
  admin: SupabaseClient,
  rawCode: unknown,
  rawSlug: unknown,
  lines: { slug: string }[],
  buyerId: string | null,
): Promise<{ referrerId: string; slug: string } | null> {
  const code = String(rawCode || "").trim().toLowerCase();
  const slug = String(rawSlug || "").trim();
  if (!code || !slug) return null;
  // The referred product has to actually be in this order - clicking a
  // link for product A but checking out with only product B earns nothing.
  if (!lines.some((l) => l.slug === slug)) return null;
  const { data } = await admin.from("profiles").select("id").eq("referral_code", code).maybeSingle();
  if (!data) return null;
  if (buyerId && data.id === buyerId) return null; // no self-referrals
  return { referrerId: data.id, slug };
}
