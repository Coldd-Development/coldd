# Legal and privacy compliance checklist

Internal notes that sit behind the public legal pages (terms-of-service, privacy-policy, refund-policy, resell-license). Not published. This is a working checklist, not legal advice; have a lawyer review the items marked "ask a lawyer".

Last reviewed: 2026-10-14.

## 1. When you ship a feature, check these

Update the pages in the same commit as the feature.

| If the feature... | Update |
|---|---|
| stores or sends a new kind of personal data | Privacy section 1 (what we collect), section 2 (lawful basis), section 5 (retention) |
| adds a new third-party service | Privacy sections 3 and 4, and sign a data processing agreement (section 3 below) |
| sets a new cookie or localStorage key | The storage table in Privacy section 1. Gate it behind analytics consent unless it is strictly needed for the site to work |
| widens what analytics collects | Privacy section 1, the cookie banner text in `supabase-init.js`, and bump `CONSENT_VERSION` so everyone is asked again |
| sends a new kind of email | Privacy section 1 ("Emails we send"). Anything promotional needs marketing opt-in |
| changes money flows (referrals, payouts, gifts, refunds) | Terms section 3.7 / 3.8 / 2.1, and the Refund Policy |
| changes who can use a product commercially | Terms section 1 and the product FAQ |
| moves hosting or a processor | Privacy sections 3 and 4 |

Then bump the "Last updated" date on every page you touched and bump the `?v=` cache tags.

## 2. Data subject requests (access, deletion, etc.)

GDPR deadline: one month from receipt, extendable by up to two further months for complex or numerous requests (tell the person within the first month).

1. Requests arrive at support@coldd.dev, the contact form or Discord tickets. Log the date received.
2. Verify identity: the request must come from the email on the account, or the person must prove control of it.
3. Access / portability: the dashboard "Download my data" button gives a JSON file. For anything else, export from Supabase (profiles, orders, reviews, wishlist, notifications, cart_snapshots, consent_log, referral_payouts).
4. Deletion: dashboard "Delete my account" (calls `delete-account`). Orders are kept for tax (about five years) and disassociated. Check `resellers` and `client_events` rows by hand if the person asks.
5. Reply in writing, keep a note of what was done.

## 3. Processors: agreements to have on file

Each of these handles personal data for you and should have a signed or accepted data processing agreement (DPA). Most offer one in their dashboard or legal pages. Check the box once and file the PDF.

- Supabase (database, auth, storage; EU region)
- Resend (email)
- Stripe, PayPal (payments)
- NOWPayments (crypto payments; confirm applicable data processing terms and international transfer safeguards)
- Cloudflare (CDN / proxy)
- Your web host (the Hestia server). Confirm the country it runs in and state it in Privacy section 4 if it is outside Australia.
- Google, Discord, Roblox (sign-in providers; their own terms apply)

## 4. Records of processing (GDPR Art. 30 starter)

| Activity | Data | Basis | Where | Retention |
|---|---|---|---|---|
| Accounts and sign-in | email, hashed password, username, provider ids | contract | Supabase EU | while account is active |
| Orders and payments | order, items, amount, processor reference | contract, legal obligation | Supabase EU | about 5 years |
| Support | emails, tickets, Discord messages | contract, legitimate interests | email, Discord | as long as needed |
| Reviews | username, avatar, text | contract, legitimate interests | Supabase EU | until account deleted |
| Referrals | referral code, attributed orders, payout requests | contract, legitimate interests | Supabase EU | with order records |
| Gifts | recipient account id | contract | Supabase EU | with order records |
| Analytics beacons | random visitor and session ids, pages, search terms, events | consent | Supabase EU | in aggregate, indefinitely |
| Abandoned-cart reminders | cart, account email | consent | Supabase EU | until checkout or empty cart |
| Marketing email | email, opt-in text and time | consent | Supabase EU, Resend | until unsubscribed |
| Consent log | random id, choice, banner version, account id if signed in | legal obligation, legitimate interests | Supabase EU | as long as relied on |
| Fraud / abuse | IP, rate-limit records, error logs | legitimate interests | Supabase EU | as needed |

## 5. If personal data is exposed (breach plan)

GDPR: notify the supervisory authority within 72 hours of becoming aware, unless the breach is unlikely to put people at risk. Notify the people affected without undue delay if the risk is high. Australia: notify the OAIC and affected people where an eligible data breach is likely to cause serious harm.

1. Contain it: rotate the leaked key or secret, revoke sessions, disable the affected function.
2. Write down what happened, when, and which data and people were involved.
3. Decide whether it is notifiable (ask a lawyer if unsure) and send the notices.
4. Fix the cause and note it in the repo history.

## 6. Open items

- [ ] Confirm the web host's country and add it to Privacy section 4 if it is outside Australia.
- [ ] Confirm each processor in section 3 has a DPA on file.
- [ ] Ask a lawyer: do you need an EU and UK representative (GDPR Art. 27)? You sell to people there without an establishment there.
- [ ] Ask a lawyer: does Privacy need a postal address for the controller (GDPR Art. 13)? Today it gives an email address and an ABN.
- [ ] Ask a lawyer: review the gifting clause 3.8(c) (refunds on gifts) and the referral clauses 3.7(c) and (e).
- [ ] Decide whether the analytics tables (`page_views`, `client_events`) should be pruned after a fixed period. The Privacy Policy currently says "as long as useful".
- [ ] Keep an eye on how the Hestia server stores request logs (IP addresses) and add a retention period.
