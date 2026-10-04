# Security headers - Cloudflare setup

As of 2026-08-07 coldd.dev sends **no** security headers. Verified:

```
curl -sI https://coldd.dev/ | grep -iE 'content-security|x-frame|x-content-type|strict-transport|referrer'
# (no output)
```

These cannot be fixed in this repo. GitHub Pages does not let you set response
headers, and it ignores a `_headers` file (that is a Netlify / Cloudflare Pages
feature). Cloudflare sits in front of the origin, so that is where they go.

**Dashboard path:** your domain → Rules → **Transform Rules** → *Modify Response
Header* → Create rule. Set the filter to `Hostname equals coldd.dev` so it
applies site-wide, then add each header as a *Set static* action.

---

## Ship these now - no downside, no testing needed

| Header | Value | What it stops |
|---|---|---|
| `X-Frame-Options` | `DENY` | Clickjacking. Nothing on coldd needs to be framed by anyone. |
| `X-Content-Type-Options` | `nosniff` | Browsers guessing a response is a script when it isn't. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Leaking full URLs (including order/product paths) to third parties. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Downgrade / SSL-strip attacks on the first request. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` | Silently granting hardware access the site never uses. |

**One caution on HSTS:** `max-age=31536000` commits every visiting browser to
HTTPS-only for a year, and that is not revocable from their side. That is correct
for coldd - it is HTTPS-only already - but start at `max-age=300` for a day if you
want an escape hatch, then raise it. Do **not** add `preload` unless you are
certain, as removal from the preload list takes months.

---

## CSP - needs its own pass, do not paste blind

A Content-Security-Policy is the highest-value header here and the one most
likely to break checkout if rushed. Two facts make it tractable:

**1. The `js` bootstrap is byte-identical on all 25 pages**, so one hash covers it
rather than resorting to `'unsafe-inline'` (which would defeat most of the point):

```
<script>document.documentElement.classList.add('js');</script>
sha256-/x7W7R75k8Roq0WaVRQX9blP4OufE5xbAdzklGxsgpw=
```

**2. Six pages carry a second inline script** and each needs its own hash:
`callback.html`, `dashboard/`, `lock.html`, `privacy-policy/`, `reset/`,
`roblox-callback.html`.

Origins the site actually depends on, from a full sweep of the markup:

- **scripts** - `cdn.jsdelivr.net` (supabase-js, now version-pinned with SRI)
- **styles / fonts** - none (Archivo is self-hosted in `/fonts`)
- **connect** - `ekinmytmudjwfaqaqswp.supabase.co` (REST, Auth, Edge Functions, Storage)
- **images** - Supabase Storage, plus `data:` URIs
- **frames** - `youtube.com` / `youtube-nocookie.com` for product video embeds
- **navigation only, not CSP-relevant** - Stripe Checkout, Roblox and Discord OAuth
  are top-level redirects, so `form-action` / `frame-src` do not need them

Starting policy:

```
Content-Security-Policy-Report-Only:
  default-src 'self';
  script-src 'self' https://cdn.jsdelivr.net 'sha256-/x7W7R75k8Roq0WaVRQX9blP4OufE5xbAdzklGxsgpw=';
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  img-src 'self' data: https://ekinmytmudjwfaqaqswp.supabase.co;
  connect-src 'self' https://ekinmytmudjwfaqaqswp.supabase.co;
  frame-src https://www.youtube.com https://www.youtube-nocookie.com;
  frame-ancestors 'none';
  base-uri 'self';
  object-src 'none'
```

**Run it as `-Report-Only` first** and watch the browser console across the
homepage, catalog, product, checkout, dashboard and admin before switching to the
enforcing header. `style-src` keeps `'unsafe-inline'` because the codebase uses
inline `style=` attributes for product images and backgrounds; removing that is a
larger refactor and is not worth blocking the rest of the policy on.

`frame-ancestors 'none'` supersedes `X-Frame-Options` in modern browsers, but keep
both - `X-Frame-Options` still covers older ones.

---

## Not a header, but same layer

**Rate limiting.** Guest-callable Edge Functions (`validate-coupon`,
`track-pageview`, `roblox-signin`) have none. `validate-coupon` is the pointed one:
it confirms whether a code is valid to an unauthenticated caller, so it can be
brute-forced to discover working discounts. Cloudflare Rate Limiting Rules on
`/functions/v1/*` are the cheapest fix.
