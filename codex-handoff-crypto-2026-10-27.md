# Codex handoff: coldd crypto checkout (NOWPayments), 2026-10-27

Repo: C:\Users\User\coldd (coldd.dev, auto-deploys on `git push` to main via Hestia webhook; do NOT use wrangler). No em-dashes anywhere. Commit then push automatically. Python is not installed; use node.

## Done
- User created a NEW NOWPayments account (frchrono) and set Supabase secrets NOWPAYMENTS_API_KEY (08:12Z) and NOWPAYMENTS_IPN_SECRET (08:12Z) on 2026-10-27. Never print or ask for secret values.
- checkout/index.html: removed `co-pay-disabled`, `aria-disabled`, the COMING SOON badge and the stale RelayPay comment on the crypto button; restored `<span class="co-pay-amt" data-pay-amt="crypto">`. Pushed to main.
- Functions create-crypto-charge + crypto-webhook + _shared/crypto.ts are unchanged and already default to NOWPayments (CRYPTO_PROVIDER unset = nowpayments).

## Still to verify (not done)
1. Live checkout: open https://coldd.dev/checkout/ with an item in cart, confirm Crypto is selectable, no badge, "Place order" enabled, guest name/email block shows.
2. Create a real invoice through create-crypto-charge (guest order) and confirm it returns a NOWPayments invoice URL on the NEW account (check the order row's crypto_charge_id).
3. Signed webhook test: `scratchpad/test-crypto-webhook.js` prompts for the IPN secret locally, HMAC-signs a callback and posts it to /functions/v1/crypto-webhook. Have the USER run it (secret must not reach chat). Confirm order flips to paid and licences are delivered, then clean up the test order.
4. Check app.js around lines 6432, 7157-7206 for leftover "Crypto checkout coming soon"/RelayPay-disabled comments (code paths already treat crypto like stripe/paypal; only comments are stale).

## User-side tasks to remind them of
- NOWPayments: finish account verification, enable coins (Settings > Coins), set primary balance to a stablecoin, link Switchere for AUD bank payouts, enable 2FA.
- Old account's pending invoices (pre-2026-10-27) will still complete there but their webhooks will now FAIL signature checks against the new IPN secret.

## Update (end of Claude session)
- Live checkout verified: crypto button has no co-pay-disabled class and no badge.
- Invoice creation NOT yet verified: create-crypto-charge returned 503 "coldd is temporarily down for maintenance" for a guest call, because the site is in maintenance mode (site_status row). Do not toggle it without the user. Test either as a signed-in admin/tester-access user, or ask the user to switch to open mode, then rerun step 2 above.
