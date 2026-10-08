// supabase/functions/cron-lifecycle-emails/index.ts
//
// Deploy with:
//   supabase functions deploy cron-lifecycle-emails --no-verify-jwt
//
// Called on a schedule by pg_cron/pg_net (see lifecycle_emails_cron.sql),
// not by a user - verifies a shared secret header instead of a Supabase
// JWT, same pattern as every other cron-invoked function in this codebase.
//
// Replaces cron-abandoned-cart-emails (single-step, hardcoded copy) with
// three admin-configurable automations, all driven by the
// email_automations table an admin edits from the Marketing panel -
// nothing here is hardcoded copy or timing, so a config change takes
// effect on the next tick with no deploy. Each automation is independently
// enabled/disabled; a disabled row is skipped entirely, including its
// per-recipient bookkeeping (so re-enabling later doesn't fire off a
// backlog of everything that would have sent while it was off).
//
// 1. ABANDONED CART (abandoned_cart_1/2/3) - a 3-step sequence over
//    cart_snapshots. abandoned_step_sent tracks progress per cart (0 = none
//    sent). Each run advances at most one step per cart, in order - a cart
//    can't skip from step 0 straight to step 3 even if the cron job were
//    down for days, since sending step 2 requires abandoned_step_sent = 1
//    already. The row disappearing (real purchase, or cart emptied) is
//    itself what stops the sequence - no separate check needed.
//
// 2. POST-PURCHASE REVIEW (post_purchase_review) - one email per paid
//    order, delay_hours after paid_at, linking to that order's items with
//    the same ?tab=reviews deep link the dashboard's own Review buttons use.
//
// 3. RE-ENGAGEMENT (reengagement) - one email per account whose last paid
//    order (or account creation, if they never bought) is older than
//    delay_hours, sent once (reengagement_email_sent_at gates repeats).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ctaButtonHtml, emailConfigured, itemsTableHtml, renderAutomationEmail, sendSingle, unsubscribeHeaders } from "../_shared/email.ts";
import { mintOneTimeCoupon, mintBundleDeal } from "../_shared/discount_codes.ts";

const MAX_PER_AUTOMATION = 50;
const SITE_URL = "https://coldd.dev";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
type Config = { key: string; enabled: boolean; delay_hours: number; subject: string; body_md: string };

Deno.serve(async (req: Request) => {
  try {
    const cronSecret = Deno.env.get("LIFECYCLE_CRON_SECRET");
    if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }

    if (!emailConfigured()) return json({ ok: true, skipped: true, reason: "RESEND_API_KEY not set" });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: configRows } = await admin.from("email_automations").select("*");
    const configs = new Map<string, Config>((configRows || []).map((c: Config) => [c.key, c]));

    const results = {
      abandonedCart: await runAbandonedCart(admin, configs, supabaseUrl),
      postPurchase: await runPostPurchaseReview(admin, configs.get("post_purchase_review"), supabaseUrl),
      reengagement: await runReengagement(admin, configs.get("reengagement"), supabaseUrl),
      wishlistReminder: await runWishlistReminder(admin, configs.get("wishlist_reminder"), supabaseUrl),
      signupNudge: await runSignupNudge(admin, configs.get("signup_nudge"), supabaseUrl),
      wishlistPriceDrop: await runWishlistPriceDrop(admin, configs.get("wishlist_price_drop"), supabaseUrl),
      gettingStarted: await runGettingStarted(admin, configs.get("getting_started"), supabaseUrl),
      resellUpgrade: await runResellUpgrade(admin, configs.get("resell_upgrade"), supabaseUrl),
      reviewIncentive: await runReviewIncentive(admin, configs.get("review_incentive"), supabaseUrl),
      repeatBuyer: await runRepeatBuyer(admin, configs.get("repeat_buyer"), supabaseUrl),
      winback: await runWinback(admin, configs.get("winback"), supabaseUrl),
      newForYou: await runNewForYou(admin, configs.get("new_for_you"), supabaseUrl),
    };

    return json({ ok: true, ...results });
  } catch (err) {
    console.error("[cron-lifecycle-emails] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function eligibleProfile(admin: any, userId: string): Promise<{ email: string; email_unsub_token: string; hasMarketingOptIn: boolean } | null> {
  const { data } = await admin
    .from("profiles")
    .select("email, email_unsub_token, marketing_unsubscribed, banned, notification_prefs")
    .eq("id", userId)
    .maybeSingle();
  if (!data || !data.email || data.marketing_unsubscribed || data.banned) return null;
  return { email: data.email, email_unsub_token: data.email_unsub_token, hasMarketingOptIn: !!data.notification_prefs?.promotions };
}

// deno-lint-ignore no-explicit-any
async function runAbandonedCart(admin: any, configs: Map<string, Config>, supabaseUrl: string) {
  const steps = [1, 2, 3].map((n) => configs.get(`abandoned_cart_${n}`)).filter(Boolean) as Config[];
  if (!steps.some((s) => s.enabled)) return { sent: 0, skipped: 0 };

  const { data: carts } = await admin
    .from("cart_snapshots")
    .select("session_id, user_id, items, updated_at, abandoned_step_sent, discount_code")
    .not("user_id", "is", null)
    .lt("abandoned_step_sent", 3)
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_AUTOMATION);

  let sent = 0, skipped = 0;
  for (const cart of carts || []) {
    const ageHours = (Date.now() - new Date(cart.updated_at).getTime()) / 3_600_000;
    const nextStepNum = cart.abandoned_step_sent + 1;
    const step = steps.find((s) => Number(s.key.slice(-1)) === nextStepNum);
    if (!step || !step.enabled || ageHours < step.delay_hours) continue;

    const prof = await eligibleProfile(admin, cart.user_id);
    if (!prof) { skipped++; await admin.from("cart_snapshots").update({ abandoned_step_sent: nextStepNum }).eq("session_id", cart.session_id); continue; }

    const items = Array.isArray(cart.items)
      ? cart.items.map((i: { title?: string; qty?: number }) => ({ title: String(i.title || "Item"), qty: Number(i.qty) || 1 }))
      : [];
    if (!items.length) { skipped++; await admin.from("cart_snapshots").update({ abandoned_step_sent: nextStepNum }).eq("session_id", cart.session_id); continue; }

    // Steps 2/3 carry a real discount - only for someone who's actually
    // opted into marketing (a plain "your cart's still here" nudge is
    // defensible without that, a discount offer is unambiguously
    // promotional). Everyone else still gets the same reminder, just
    // without a code attached. The SAME code is reused for step 3 if step
    // 2 already minted one, rather than a new one each time.
    let discountCode: string | null = cart.discount_code || null;
    const updatePayload: Record<string, unknown> = { abandoned_step_sent: nextStepNum };
    if (nextStepNum >= 2 && prof.hasMarketingOptIn && !discountCode) {
      discountCode = await mintOneTimeCoupon(admin, { prefix: "CART", pct: nextStepNum === 2 ? 10 : 15, expiresInDays: 7 });
      if (discountCode) updatePayload.discount_code = discountCode;
    }

    const extraBlocks = [itemsTableHtml(items)];
    if (nextStepNum >= 2 && discountCode) {
      extraBlocks.push(`<p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#d7d7d7;">Use code <strong style="color:#ff3344;letter-spacing:0.03em;">${discountCode}</strong> at checkout.</p>`);
    }
    extraBlocks.push(ctaButtonHtml(`${SITE_URL}/checkout`, "Finish checkout"));

    const unsubscribeUrl = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const html = renderAutomationEmail(step.body_md, extraBlocks, unsubscribeUrl);
    const result = await sendSingle(prof.email, step.subject, html, unsubscribeHeaders(unsubscribeUrl));
    if (result.ok) {
      sent++;
      // Recorded only on a real send, so the admin's "Email sent" marker is
      // accurate (a skipped or failed step advances abandoned_step_sent but
      // never sets this).
      updatePayload.abandoned_email_sent_at = new Date().toISOString();
    } else console.error("[cron-lifecycle-emails] abandoned-cart send failed:", result.error);
    await admin.from("cart_snapshots").update(updatePayload).eq("session_id", cart.session_id);
  }
  return { sent, skipped };
}

// deno-lint-ignore no-explicit-any
async function runPostPurchaseReview(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };

  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: orders } = await admin
    .from("orders")
    .select("id, user_id, paid_at")
    .eq("status", "paid")
    .is("review_email_sent_at", null)
    .not("user_id", "is", null)
    .lt("paid_at", cutoff)
    .limit(MAX_PER_AUTOMATION);

  let sent = 0, skipped = 0;
  for (const order of orders || []) {
    const prof = await eligibleProfile(admin, order.user_id);
    if (!prof) { skipped++; await admin.from("orders").update({ review_email_sent_at: new Date().toISOString() }).eq("id", order.id); continue; }

    const { data: items } = await admin.from("order_items").select("title, product_slug, qty").eq("order_id", order.id);
    const lineItems = (items || []).map((i: { title: string; product_slug: string; qty: number }) => ({
      title: i.title,
      qty: i.qty,
      linkUrl: i.product_slug ? `${SITE_URL}/product?id=${encodeURIComponent(i.product_slug)}&tab=reviews` : undefined,
      linkLabel: "Leave a review",
    }));
    if (!lineItems.length) { skipped++; await admin.from("orders").update({ review_email_sent_at: new Date().toISOString() }).eq("id", order.id); continue; }

    const unsubscribeUrl = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const reviewBlocks = [itemsTableHtml(lineItems)];
    if (prof.hasMarketingOptIn) {
      const picks = await pickedForYouBlock(admin, order.user_id, (items || []).map((i: { product_slug: string }) => i.product_slug).filter(Boolean));
      if (picks) reviewBlocks.push(picks);
    }
    const html = renderAutomationEmail(config.body_md, reviewBlocks, unsubscribeUrl);
    const result = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsubscribeUrl));
    if (result.ok) sent++; else console.error("[cron-lifecycle-emails] review-request send failed:", result.error);
    await admin.from("orders").update({ review_email_sent_at: new Date().toISOString() }).eq("id", order.id);
  }
  return { sent, skipped };
}

// deno-lint-ignore no-explicit-any
async function runReengagement(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };

  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: candidates } = await admin
    .from("profiles")
    .select("id, email, email_unsub_token, marketing_unsubscribed, banned, created_at")
    .eq("marketing_unsubscribed", false)
    .is("reengagement_email_sent_at", null)
    .not("email", "is", null)
    .lt("created_at", cutoff)
    .limit(MAX_PER_AUTOMATION * 3); // over-fetch, some get filtered below by recent-order

  const pool = (candidates || []).filter((p: { banned?: boolean }) => !p.banned).slice(0, MAX_PER_AUTOMATION * 3);
  if (!pool.length) return { sent: 0, skipped: 0 };

  const ids = pool.map((p: { id: string }) => p.id);
  const { data: recentOrders } = await admin
    .from("orders")
    .select("user_id")
    .eq("status", "paid")
    .gte("paid_at", cutoff)
    .in("user_id", ids);
  const recentBuyers = new Set((recentOrders || []).map((o: { user_id: string }) => o.user_id));

  let sent = 0, skipped = 0;
  for (const prof of pool) {
    if (sent >= MAX_PER_AUTOMATION) break;
    if (recentBuyers.has(prof.id)) continue; // still active - not lapsed, leave sent_at null for a future check

    const unsubscribeUrl = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const html = renderAutomationEmail(config.body_md, [ctaButtonHtml(`${SITE_URL}/shop`, "See what's new")], unsubscribeUrl);
    const result = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsubscribeUrl));
    if (result.ok) sent++; else { skipped++; console.error("[cron-lifecycle-emails] reengagement send failed:", result.error); }
    await admin.from("profiles").update({ reengagement_email_sent_at: new Date().toISOString() }).eq("id", prof.id);
  }
  return { sent, skipped };
}

// WISHLIST REMINDER (wishlist_reminder) - one per account with wishlist
// items sitting untouched for delay_hours, offering each at item_pct off
// (bundle_pct more if every one shown is bought together), same
// per-user bundle_deals mechanism the post-purchase upsell uses. Unlike
// the abandoned-cart plain-reminder step, this ALWAYS carries a
// discount - there's no non-promotional version of "here's a nudge about
// something you never even started buying" - so it requires real
// marketing consent, no exceptions, rather than just being opt-out.
const WISHLIST_ITEM_PCT = 12;
const WISHLIST_BUNDLE_PCT = 8;

// deno-lint-ignore no-explicit-any
async function runWishlistReminder(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };

  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: rows } = await admin
    .from("wishlist_items")
    .select("user_id, product_id, created_at, products(slug, title, price_usd, image)")
    .is("reminder_sent_at", null)
    .lt("created_at", cutoff)
    .limit(MAX_PER_AUTOMATION * 4); // over-fetch: several rows can belong to one user

  // deno-lint-ignore no-explicit-any
  const byUser = new Map<string, any[]>();
  for (const row of rows || []) {
    if (!row.products) continue;
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id)!.push(row);
  }
  if (!byUser.size) return { sent: 0, skipped: 0 };

  let sent = 0, skipped = 0;
  for (const [userId, userRows] of byUser) {
    if (sent >= MAX_PER_AUTOMATION) break;

    const prof = await eligibleProfile(admin, userId);
    const productIds = userRows.map((r) => r.product_id);
    if (!prof || !prof.hasMarketingOptIn) {
      skipped++;
      // Not eligible for a discount-bearing email at all - stop
      // re-checking these specific rows every run, but this is a
      // permanent skip, not "try again later", so sent_at is set the
      // same as a real send would.
      await admin.from("wishlist_items").update({ reminder_sent_at: new Date().toISOString() }).eq("user_id", userId).in("product_id", productIds);
      continue;
    }

    // Drop anything they've since actually bought - a wishlist item that
    // already converted isn't a reminder candidate any more.
    const { data: owned } = await admin
      .from("order_items")
      .select("product_id, orders!inner(user_id, status)")
      .eq("orders.user_id", userId)
      .eq("orders.status", "paid")
      .in("product_id", productIds);
    // deno-lint-ignore no-explicit-any
    const ownedIds = new Set((owned || []).map((o: any) => o.product_id));
    const stillWanted = userRows.filter((r) => !ownedIds.has(r.product_id));

    if (!stillWanted.length) {
      await admin.from("wishlist_items").update({ reminder_sent_at: new Date().toISOString() }).eq("user_id", userId).in("product_id", productIds);
      continue;
    }

    // deno-lint-ignore no-explicit-any
    const slugs: string[] = stillWanted.map((r: any) => r.products.slug);
    const token = await mintBundleDeal(admin, {
      slugs,
      itemPct: WISHLIST_ITEM_PCT,
      bundlePct: WISHLIST_BUNDLE_PCT,
      source: "wishlist_reminder",
      userId,
      email: prof.email,
      expiresInDays: 7,
    });
    if (!token) { skipped++; continue; }

    // deno-lint-ignore no-explicit-any
    const lineItems = stillWanted.map((r: any) => ({ title: r.products.title }));
    const discountNote = `<p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#d7d7d7;">${WISHLIST_ITEM_PCT}% off each, or ${WISHLIST_ITEM_PCT + WISHLIST_BUNDLE_PCT}% off if you get all ${stillWanted.length}. This applies automatically at checkout - no code needed.</p>`;
    const unsubscribeUrl = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const html = renderAutomationEmail(
      config.body_md,
      [itemsTableHtml(lineItems), discountNote, ctaButtonHtml(`${SITE_URL}/dashboard?panel=wishlist&bundle=${token}`, "See your wishlist")],
      unsubscribeUrl,
    );
    const result = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsubscribeUrl));
    if (result.ok) sent++; else { skipped++; console.error("[cron-lifecycle-emails] wishlist-reminder send failed:", result.error); }
    await admin.from("wishlist_items").update({ reminder_sent_at: new Date().toISOString() }).eq("user_id", userId).in("product_id", productIds);
  }
  return { sent, skipped };
}

/* ============================================================================
   SECOND WAVE (2026-09) - all deduped via email_automation_sends rather than
   a per-automation *_sent_at column. Plain nudges (no offer) go to anyone not
   unsubscribed; anything carrying a discount requires real marketing consent
   (eligibleProfile().hasMarketingOptIn), same rule the wishlist reminder uses.
   ========================================================================= */

// deno-lint-ignore no-explicit-any
async function dedupeSeen(admin: any, key: string, dedupe: string): Promise<boolean> {
  const { data } = await admin.from("email_automation_sends").select("dedupe_key")
    .eq("automation_key", key).eq("dedupe_key", dedupe).maybeSingle();
  return !!data;
}
// deno-lint-ignore no-explicit-any
async function dedupeMark(admin: any, key: string, dedupe: string) {
  await admin.from("email_automation_sends").upsert({ automation_key: key, dedupe_key: dedupe });
}
// deno-lint-ignore no-explicit-any
async function mintCoupon(admin: any, prefix: string, pct: number, days: number): Promise<string | null> {
  try { return await mintOneTimeCoupon(admin, { prefix, pct, expiresInDays: days }); }
  catch (e) { console.error("[cron-lifecycle-emails] coupon mint failed:", e instanceof Error ? e.message : e); return null; }
}
function couponBlockHtml(code: string, pct: number): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;"><tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:6px;padding:16px 18px;text-align:center;">
<p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#7a7a7a;">${pct}% off your next order</p>
<p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#ff3344;">${code}</p></td></tr></table>`;
}

// Slugs of everything this user has paid for - the context the relevance engine matches against.
// deno-lint-ignore no-explicit-any
async function boughtSlugs(admin: any, userId: string): Promise<string[]> {
  const { data } = await admin.from("order_items").select("product_slug, orders!inner(status, user_id)")
    .eq("orders.status", "paid").eq("orders.user_id", userId);
  // deno-lint-ignore no-explicit-any
  return Array.from(new Set((data || []).map((r: any) => r.product_slug).filter(Boolean)));
}

// "Picked for you": the shared relevance engine (style/genre tags first, then category, demand,
// quality, price fit), excluding anything the user already owns. Empty string when there is nothing.
// deno-lint-ignore no-explicit-any
async function pickedForYouBlock(admin: any, userId: string, contextSlugs: string[], limit = 3): Promise<string> {
  if (!contextSlugs.length) return "";
  const { data: recs } = await admin.rpc("get_checkout_cross_sell", { p_slugs: contextSlugs, p_limit: limit, p_user_id: userId });
  // deno-lint-ignore no-explicit-any
  const slugs: string[] = (recs || []).map((r: any) => r.product_slug);
  if (!slugs.length) return "";
  const { data: prods } = await admin.from("products").select("slug, title").in("slug", slugs);
  const titleBySlug = new Map((prods || []).map((p: { slug: string; title: string }) => [p.slug, p.title]));
  const items = slugs.filter((sl) => titleBySlug.has(sl)).map((sl) => ({
    title: String(titleBySlug.get(sl)),
    linkUrl: `${SITE_URL}/product/${sl}`,
    linkLabel: "View",
  }));
  if (!items.length) return "";
  return `<p style="margin:18px 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#ffffff;">Picked for you, based on what you've bought</p>` + itemsTableHtml(items);
}

// 1. SIGNUP NUDGE - signed up, never bought, delay_hours ago. Plain, opt-out.
// deno-lint-ignore no-explicit-any
async function runSignupNudge(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: profs } = await admin.from("profiles")
    .select("id, email, email_unsub_token, marketing_unsubscribed, banned")
    .eq("marketing_unsubscribed", false).not("email", "is", null).lt("created_at", cutoff)
    .limit(MAX_PER_AUTOMATION * 3);
  let sent = 0, skipped = 0;
  for (const p of (profs || []).filter((x: { banned?: boolean }) => !x.banned)) {
    if (sent >= MAX_PER_AUTOMATION) break;
    if (await dedupeSeen(admin, "signup_nudge", p.id)) continue;
    const { count } = await admin.from("orders").select("id", { count: "exact", head: true }).eq("user_id", p.id).eq("status", "paid");
    if ((count || 0) > 0) { await dedupeMark(admin, "signup_nudge", p.id); continue; } // bought since - never nudge
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${p.email_unsub_token}`;
    const html = renderAutomationEmail(config.body_md, [ctaButtonHtml(`${SITE_URL}/shop`, "Browse the catalog")], unsub);
    const r = await sendSingle(p.email, config.subject, html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "signup_nudge", p.id);
  }
  return { sent, skipped };
}

// 2. WISHLIST PRICE DROP - a wishlisted product that's on sale right now.
// Discount-adjacent -> requires marketing consent. Dedupe per user+product+price.
// deno-lint-ignore no-explicit-any
async function runWishlistPriceDrop(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const { data: rows } = await admin.from("wishlist_items")
    .select("user_id, products(slug, title, price_usd, was_price, is_active)")
    .limit(MAX_PER_AUTOMATION * 4);
  let sent = 0, skipped = 0;
  for (const row of rows || []) {
    if (sent >= MAX_PER_AUTOMATION) break;
    const pr = row.products;
    if (!pr || !pr.is_active || pr.was_price == null || Number(pr.was_price) <= Number(pr.price_usd)) continue;
    const dedupe = `${row.user_id}:${pr.slug}:${pr.price_usd}`;
    if (await dedupeSeen(admin, "wishlist_price_drop", dedupe)) continue;
    const prof = await eligibleProfile(admin, row.user_id);
    if (!prof || !prof.hasMarketingOptIn) { await dedupeMark(admin, "wishlist_price_drop", dedupe); skipped++; continue; }
    const off = Math.round((1 - Number(pr.price_usd) / Number(pr.was_price)) * 100);
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const note = `<p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#d7d7d7;"><strong>${pr.title}</strong> is ${off}% off right now - $${Number(pr.price_usd).toFixed(2)}, was $${Number(pr.was_price).toFixed(2)}.</p>`;
    const html = renderAutomationEmail(config.body_md, [note, ctaButtonHtml(`${SITE_URL}/product/${encodeURIComponent(pr.slug)}`, "See the deal")], unsub);
    const r = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "wishlist_price_drop", dedupe);
  }
  return { sent, skipped };
}

// 3. GETTING STARTED - delay_hours after a paid order. Plain, opt-out.
// deno-lint-ignore no-explicit-any
async function runGettingStarted(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: orders } = await admin.from("orders")
    .select("id, user_id, paid_at").eq("status", "paid").not("user_id", "is", null).lt("paid_at", cutoff)
    .order("paid_at", { ascending: false }).limit(MAX_PER_AUTOMATION * 2);
  let sent = 0, skipped = 0;
  for (const o of orders || []) {
    if (sent >= MAX_PER_AUTOMATION) break;
    if (await dedupeSeen(admin, "getting_started", o.id)) continue;
    const prof = await eligibleProfile(admin, o.user_id);
    if (!prof) { await dedupeMark(admin, "getting_started", o.id); skipped++; continue; }
    const { data: items } = await admin.from("order_items").select("title, product_slug").eq("order_id", o.id);
    const lineItems = (items || []).map((i: { title: string; product_slug: string }) => ({
      title: i.title,
      linkUrl: i.product_slug ? `${SITE_URL}/product/${encodeURIComponent(i.product_slug)}` : undefined,
      linkLabel: "Product page",
    }));
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const html = renderAutomationEmail(config.body_md, [
      itemsTableHtml(lineItems),
      ctaButtonHtml(`${SITE_URL}/dashboard?panel=owned`, "Open your files"),
      `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9a9a9a;">Stuck on setup? Ask in the <a href="https://discord.gg/coldd" style="color:#ff3344;text-decoration:none;">Discord</a>.</p>`,
    ], unsub);
    const r = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "getting_started", o.id);
  }
  return { sent, skipped };
}

// 4. RESELL UPGRADE - owns a standard licence for a resell-eligible product,
// hasn't bought the resell licence. Upsell, no coupon -> opt-out.
// deno-lint-ignore no-explicit-any
async function runResellUpgrade(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: rows } = await admin.from("order_items")
    .select("id, licence, product_id, orders!inner(user_id, status, paid_at), products!inner(slug, title, resell_available, price_usd)")
    .eq("licence", "standard").eq("orders.status", "paid").lt("orders.paid_at", cutoff)
    .limit(MAX_PER_AUTOMATION * 3);
  let sent = 0, skipped = 0;
  for (const it of rows || []) {
    if (sent >= MAX_PER_AUTOMATION) break;
    if (!it.products?.resell_available) continue;
    if (await dedupeSeen(admin, "resell_upgrade", it.id)) continue;
    const userId = it.orders.user_id;
    // This buyer already owns a resell licence for this product? nothing to upsell.
    const { count: hasResell } = await admin.from("order_items")
      .select("id, orders!inner(user_id, status)", { count: "exact", head: true })
      .eq("licence", "resell").eq("product_id", it.product_id)
      .eq("orders.user_id", userId).eq("orders.status", "paid");
    const prof = await eligibleProfile(admin, userId);
    if (!prof || (hasResell || 0) > 0) { await dedupeMark(admin, "resell_upgrade", it.id); skipped++; continue; }
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const note = `<p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#d7d7d7;">Resell licence for <strong>${it.products.title}</strong>: pick "Resell licence" on the product page at checkout.</p>`;
    const html = renderAutomationEmail(config.body_md, [note, ctaButtonHtml(`${SITE_URL}/product/${encodeURIComponent(it.products.slug)}`, "Upgrade the licence")], unsub);
    const r = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "resell_upgrade", it.id);
  }
  return { sent, skipped };
}

// 5. REVIEW INCENTIVE - paid order, no review, delay_hours later. Mints a
// coupon -> requires marketing consent.
// deno-lint-ignore no-explicit-any
async function runReviewIncentive(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: orders } = await admin.from("orders")
    .select("id, user_id, paid_at").eq("status", "paid").not("user_id", "is", null).lt("paid_at", cutoff)
    .order("paid_at", { ascending: false }).limit(MAX_PER_AUTOMATION * 2);
  let sent = 0, skipped = 0;
  for (const o of orders || []) {
    if (sent >= MAX_PER_AUTOMATION) break;
    if (await dedupeSeen(admin, "review_incentive", o.id)) continue;
    const prof = await eligibleProfile(admin, o.user_id);
    if (!prof || !prof.hasMarketingOptIn) { await dedupeMark(admin, "review_incentive", o.id); skipped++; continue; }
    const { data: items } = await admin.from("order_items").select("product_id, product_slug, title").eq("order_id", o.id);
    const pids = (items || []).map((i: { product_id: string }) => i.product_id).filter(Boolean);
    if (!pids.length) { await dedupeMark(admin, "review_incentive", o.id); continue; }
    const { count: reviewCount } = await admin.from("reviews")
      .select("id", { count: "exact", head: true }).eq("user_id", o.user_id).in("product_id", pids);
    if ((reviewCount || 0) > 0) { await dedupeMark(admin, "review_incentive", o.id); continue; } // already reviewed one
    const code = await mintCoupon(admin, "REVIEW", 15, 30);
    if (!code) { skipped++; continue; }
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const lineItems = (items || []).map((i: { title: string; product_slug: string }) => ({
      title: i.title,
      linkUrl: i.product_slug ? `${SITE_URL}/product/${encodeURIComponent(i.product_slug)}?tab=reviews` : undefined,
      linkLabel: "Write a review",
    }));
    const html = renderAutomationEmail(config.body_md, [itemsTableHtml(lineItems), couponBlockHtml(code, 15),
      `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7a7a7a;">The code is yours to use whether or not you leave a review - but a review really does help.</p>`], unsub);
    const r = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "review_incentive", o.id);
  }
  return { sent, skipped };
}

// 6. REPEAT BUYER - has >=2 paid orders, most recent one delay_hours ago.
// Mints a coupon -> requires marketing consent. Once per account.
// deno-lint-ignore no-explicit-any
async function runRepeatBuyer(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: orders } = await admin.from("orders")
    .select("user_id, paid_at").eq("status", "paid").not("user_id", "is", null)
    .order("paid_at", { ascending: false }).limit(MAX_PER_AUTOMATION * 6);
  // deno-lint-ignore no-explicit-any
  const byUser = new Map<string, any[]>();
  for (const o of orders || []) { if (!byUser.has(o.user_id)) byUser.set(o.user_id, []); byUser.get(o.user_id)!.push(o); }
  let sent = 0, skipped = 0;
  for (const [userId, list] of byUser) {
    if (sent >= MAX_PER_AUTOMATION) break;
    if (list.length < 2) continue;
    if (new Date(list[0].paid_at).toISOString() > cutoff) continue; // newest order too fresh
    if (await dedupeSeen(admin, "repeat_buyer", userId)) continue;
    const prof = await eligibleProfile(admin, userId);
    if (!prof || !prof.hasMarketingOptIn) { await dedupeMark(admin, "repeat_buyer", userId); skipped++; continue; }
    const code = await mintCoupon(admin, "AGAIN", 15, 45);
    if (!code) { skipped++; continue; }
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const html = renderAutomationEmail(config.body_md, [couponBlockHtml(code, 15), ctaButtonHtml(`${SITE_URL}/shop`, "Browse the catalog")], unsub);
    const r = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "repeat_buyer", userId);
  }
  return { sent, skipped };
}

// 7. WIN-BACK - last paid order older than delay_hours, escalating coupon by
// how long they've been gone. Mints a coupon -> requires marketing consent.
// deno-lint-ignore no-explicit-any
// NEW FOR YOU - a product added in the last 7 days is emailed to past buyers whose own purchase
// history ranks it in their top matches in the relevance engine (so someone who bought stud-style
// maps hears about a new stud-style map, and nobody gets emails about things they won't care about).
// One email per user per product, max one new-for-you email per user per run, opt-in only.
// deno-lint-ignore no-explicit-any
async function runNewForYou(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: fresh } = await admin.from("products").select("slug, title").eq("is_active", true).gte("created_at", since);
  if (!fresh?.length) return { sent: 0, skipped: 0 };
  const freshBySlug = new Map(fresh.map((p: { slug: string; title: string }) => [p.slug, p.title]));
  const { data: buyers } = await admin.from("orders").select("user_id").eq("status", "paid").not("user_id", "is", null).limit(MAX_PER_AUTOMATION * 8);
  const userIds = Array.from(new Set((buyers || []).map((b: { user_id: string }) => b.user_id)));
  let sent = 0, skipped = 0;
  for (const userId of userIds as string[]) {
    if (sent >= MAX_PER_AUTOMATION) break;
    const prof = await eligibleProfile(admin, userId);
    if (!prof || !prof.hasMarketingOptIn) { skipped++; continue; }
    const ctx = await boughtSlugs(admin, userId);
    if (!ctx.length) continue;
    const { data: recs } = await admin.rpc("get_checkout_cross_sell", { p_slugs: ctx, p_limit: 5, p_user_id: userId });
    // deno-lint-ignore no-explicit-any
    const hit = (recs || []).map((r: any) => r.product_slug).find((sl: string) => freshBySlug.has(sl));
    if (!hit) continue;
    if (await dedupeSeen(admin, "new_for_you", `${userId}:${hit}`)) continue;
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const title = String(freshBySlug.get(hit));
    const html = renderAutomationEmail(config.body_md, [itemsTableHtml([{ title, linkUrl: `${SITE_URL}/product/${hit}`, linkLabel: "View" }]), ctaButtonHtml(`${SITE_URL}/product/${hit}`, "Take a look")], unsub);
    const r = await sendSingle(prof.email, config.subject.replace("{product}", title), html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "new_for_you", `${userId}:${hit}`);
  }
  return { sent, skipped };
}

async function runWinback(admin: any, config: Config | undefined, supabaseUrl: string) {
  if (!config || !config.enabled) return { sent: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - config.delay_hours * 3_600_000).toISOString();
  const { data: orders } = await admin.from("orders")
    .select("user_id, paid_at").eq("status", "paid").not("user_id", "is", null)
    .order("paid_at", { ascending: false }).limit(MAX_PER_AUTOMATION * 8);
  const lastByUser = new Map<string, string>();
  for (const o of orders || []) { if (!lastByUser.has(o.user_id)) lastByUser.set(o.user_id, o.paid_at); }
  let sent = 0, skipped = 0;
  for (const [userId, lastPaid] of lastByUser) {
    if (sent >= MAX_PER_AUTOMATION) break;
    if (new Date(lastPaid).toISOString() > cutoff) continue; // still recent enough
    if (await dedupeSeen(admin, "winback", userId)) continue;
    const prof = await eligibleProfile(admin, userId);
    if (!prof || !prof.hasMarketingOptIn) { await dedupeMark(admin, "winback", userId); skipped++; continue; }
    const monthsGone = Math.floor((Date.now() - new Date(lastPaid).getTime()) / (30 * 86_400_000));
    const pct = monthsGone >= 9 ? 25 : monthsGone >= 6 ? 20 : 15;
    const code = await mintCoupon(admin, "BACK", pct, 30);
    if (!code) { skipped++; continue; }
    const unsub = `${supabaseUrl}/functions/v1/email-unsubscribe?t=${prof.email_unsub_token}`;
    const winBlocks = [couponBlockHtml(code, pct)];
    const winPicks = await pickedForYouBlock(admin, userId, await boughtSlugs(admin, userId));
    if (winPicks) winBlocks.push(winPicks);
    winBlocks.push(ctaButtonHtml(`${SITE_URL}/shop`, "See what's new"));
    const html = renderAutomationEmail(config.body_md, winBlocks, unsub);
    const r = await sendSingle(prof.email, config.subject, html, unsubscribeHeaders(unsub));
    if (r.ok) sent++; else skipped++;
    await dedupeMark(admin, "winback", userId);
  }
  return { sent, skipped };
}
