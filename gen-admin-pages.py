#!/usr/bin/env python3
"""Regenerate the real per-section admin pages under /admin/<section>/.

Why this exists: admin/index.html is one page with every panel in the DOM,
shown/hidden by admin.js's showPanel(). Pressing the browser's Back button
inside it just leaves /admin entirely, since nothing ever changed the URL.
admin.js now does real client-side routing (pushState per panel, a
popstate listener, PANEL_PATH/routeFromLocation) - but that routing only
has something to land on for a hard refresh or a direct/shared link if a
real file exists at that path. This script writes those files.

Unlike gen-product-pages.py, nothing here is crawled or needs per-page
<head> content baked in (admin is behind auth and disallowed in
robots.txt) - every generated file is a byte-for-byte copy of
admin/index.html. admin.js reads location.pathname itself to decide which
panel to show; the file's job is only to exist so the static host doesn't
404 before admin.js gets a chance to run.

Per-product pages (/admin/products/<slug>/) mirror the storefront's
/product/<slug>/ pattern, fetching slugs from the same public REST
endpoint gen-product-pages.py uses. Everything else that isn't a
top-level section (a specific order, a reseller, the unreleased-files
drawer) intentionally has no static file - IDs there are unbounded, and
admin.js's router falls back to that state's parent list on a direct hit.

Usage:  python3 gen-admin-pages.py
Run it (alongside gen-product-pages.py) after adding, renaming or
retiring a product, and commit the result.
"""
import json
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
SUPABASE_URL = 'https://ekinmytmudjwfaqaqswp.supabase.co'
SUPABASE_KEY = 'sb_publishable_q5JwjFnMT_0Uhu5rAlAkQA_DEGnhwV7'
TIMEOUT = 20

TEMPLATE = ROOT / 'admin' / 'index.html'
ADMIN_DIR = ROOT / 'admin'

# Must match PANEL_PATH's keys in admin.js (minus 'home', which is
# admin/index.html itself).
TOP_LEVEL_SECTIONS = [
    'products', 'sales', 'marketing', 'marketplaces', 'analytics',
    'orders', 'resellers', 'reviews', 'content', 'sitemgmt',
]
# Single fixed sub-pages under /admin/products/ that aren't per-product.
PRODUCT_SUBPAGES = ['new', 'unreleased']


def fetch_product_slugs():
    url = SUPABASE_URL + '/rest/v1/products?select=slug&is_active=eq.true'
    req = urllib.request.Request(url, headers={'apikey': SUPABASE_KEY, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return [p['slug'] for p in json.load(r) if p.get('slug')]


def write_shell(template, dest_dir):
    dest_dir.mkdir(parents=True, exist_ok=True)
    (dest_dir / 'index.html').write_text(template, encoding='utf-8')


def main():
    template = TEMPLATE.read_text(encoding='utf-8')

    for section in TOP_LEVEL_SECTIONS:
        write_shell(template, ADMIN_DIR / section)
    for sub in PRODUCT_SUBPAGES:
        write_shell(template, ADMIN_DIR / 'products' / sub)

    try:
        slugs = fetch_product_slugs()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print('  ! products unavailable (%s) - per-product admin pages left untouched' % e, file=sys.stderr)
        slugs = None

    pruned = 0
    if slugs is not None:
        active = set(slugs) | set(PRODUCT_SUBPAGES)
        for slug in slugs:
            write_shell(template, ADMIN_DIR / 'products' / slug)
        products_dir = ADMIN_DIR / 'products'
        for child in products_dir.iterdir():
            if child.is_dir() and child.name not in active and (child / 'index.html').exists():
                shutil.rmtree(child)
                pruned += 1

    total = len(TOP_LEVEL_SECTIONS) + len(PRODUCT_SUBPAGES) + (len(slugs) if slugs is not None else 0)
    print('Wrote %d admin pages%s' % (total, (', pruned %d stale product pages' % pruned) if pruned else ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
