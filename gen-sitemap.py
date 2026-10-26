#!/usr/bin/env python3
"""Regenerate sitemap.xml.

The catalog lives in Supabase, not in the repo, so the product URLs cannot be
derived from the checked-in files. This pulls the active products over the
public REST endpoint with the same publishable key the site itself ships, and
falls back to the static pages alone if the network is unavailable.

Usage:  python3 gen-sitemap.py
"""
import json
import sys
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).parent
ORIGIN = 'https://coldd.dev'
SUPABASE_URL = 'https://ekinmytmudjwfaqaqswp.supabase.co'
SUPABASE_KEY = 'sb_publishable_q5JwjFnMT_0Uhu5rAlAkQA_DEGnhwV7'
TIMEOUT = 20

# Kept in sync with gen-product-pages.py: is_active products that must stay
# out of search (test rows, staging dupes). Deactivate them in the admin
# panel when possible; this is the stopgap.
SKIP_SLUGS = {'guess-the-number-test'}

# path, changefreq, priority. Auth, checkout, dashboard and success are
# deliberately absent: they carry noindex and are disallowed in robots.txt.
STATIC_PAGES = [
    ('/', 'weekly', '1.0'),
    ('/shop', 'weekly', '0.9'),
    ('/faq', 'monthly', '0.6'),
    ('/about', 'monthly', '0.5'),
    ('/resell-license', 'yearly', '0.3'),
    ('/terms-of-service', 'yearly', '0.2'),
    ('/privacy-policy', 'yearly', '0.2'),
    ('/refund-policy', 'yearly', '0.2'),
]


def fetch(path):
    req = urllib.request.Request(
        SUPABASE_URL + '/rest/v1/' + path,
        headers={'apikey': SUPABASE_KEY, 'Accept': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def iso_day(value):
    """Normalise a Postgres timestamp to YYYY-MM-DD, or None."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).date().isoformat()
    except ValueError:
        return str(value)[:10] or None


def products():
    try:
        rows = fetch('products?select=slug,updated_at,created_at,is_active&is_active=eq.true&price_usd=gt.0')
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print('  ! products unavailable (%s) - writing static pages only' % e, file=sys.stderr)
        return []
    out = []
    for r in rows:
        if not r.get('slug') or r['slug'] in SKIP_SLUGS:
            continue
        out.append(('/product/' + r['slug'],
                    'weekly', '0.8',
                    iso_day(r.get('updated_at') or r.get('created_at'))))
    return out


def esc(u):
    return u.replace('&', '&amp;')


def main():
    today = date.today().isoformat()
    entries = [(p, f, pr, today) for p, f, pr in STATIC_PAGES]
    entries += products()

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for path, freq, prio, lastmod in entries:
        lines.append('  <url>')
        lines.append('    <loc>%s%s</loc>' % (ORIGIN, esc(path)))
        if lastmod:
            lines.append('    <lastmod>%s</lastmod>' % lastmod)
        lines.append('    <changefreq>%s</changefreq>' % freq)
        lines.append('    <priority>%s</priority>' % prio)
        lines.append('  </url>')
    lines.append('</urlset>')

    (ROOT / 'sitemap.xml').write_text('\n'.join(lines) + '\n')
    print('Wrote sitemap.xml  (%d URLs: %d static, %d dynamic)'
          % (len(entries), len(STATIC_PAGES), len(entries) - len(STATIC_PAGES)))


if __name__ == '__main__':
    main()
