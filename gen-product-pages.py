#!/usr/bin/env python3
"""Regenerate the pre-rendered product shells under /product/<slug>/.

Why this exists: the catalog is single-page-app rendered from Supabase, and
/product/<slug> is a "pretty" URL with no file behind it. On GitHub Pages a
request for it 404s, then 404.html bounces the visitor to /product/?id=<slug>.
Humans barely notice, but crawlers that honour the status code (Googlebot,
Bingbot, GPTBot, PerplexityBot) see the 404 and drop the URL before they ever
render the JS - so every product in sitemap.xml was effectively dead for search.

This writes a real file at /product/<slug>/index.html for each active product:
a byte-for-byte copy of the /product shell with the <head> (title, canonical,
description, Open Graph, Twitter, Product + BreadcrumbList JSON-LD) baked in for
that specific product, plus the visible <h1>/description/breadcrumb pre-filled
so a non-JS crawler still gets real content. app.js then hydrates the rest
client-side exactly as it does today (it already reads the slug from the path).

Data comes from the same public REST endpoint and publishable key the site
itself ships (protected by RLS, not secrecy). Falls back to leaving the existing
shells untouched if the network is unavailable.

Usage:  python3 gen-product-pages.py
Run it (and gen-sitemap.py) after adding, renaming, retiring or re-describing a
product, and commit the result.
"""
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
ORIGIN = 'https://coldd.dev'
SUPABASE_URL = 'https://ekinmytmudjwfaqaqswp.supabase.co'
SUPABASE_KEY = 'sb_publishable_q5JwjFnMT_0Uhu5rAlAkQA_DEGnhwV7'
TIMEOUT = 20

TEMPLATE = ROOT / 'product' / 'index.html'
OUT_DIR = ROOT / 'product'

# Products that are is_active in Supabase but must never be pre-rendered or
# listed in the sitemap - test rows, staging dupes. Deactivate them properly
# in the admin panel when you can; this list just keeps them out of search
# in the meantime. gen-sitemap.py reads the same list.
SKIP_SLUGS = {'guess-the-number-test'}

# Mirrors catSlugFor() in app.js - the shop category filter matches the
# catalog's own slug, which is not always what you get by slugifying the label.
CAT_SLUG = {
    'Finished Games & Templates': 'game-templates',
    'Maps': 'maps',
    'Scripts & UI': 'scripts-ui',
    'Graphics': 'graphics',
    'Buildings': 'buildings',
    'Assets': 'assets',
    'Uniforms & Gear': 'uniforms-gear',
    'Boats': 'boats',
    'Weapons': 'weapons',
    'Vehicles': 'vehicles',
    'Animations & VFX': 'animations-vfx',
}


def fetch_products():
    url = (SUPABASE_URL + '/rest/v1/products'
           '?select=slug,title,description,long_description,image,cat,platform,'
           'page,subcat,price_usd,was_price,reviews_count,rating,updated_at,video'
           '&is_active=eq.true')
    req = urllib.request.Request(url, headers={'apikey': SUPABASE_KEY, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def clamp(text, limit=300):
    t = re.sub(r'\s+', ' ', str(text or '')).strip()
    if len(t) <= limit:
        return t
    cut = t[:limit]
    sp = cut.rfind(' ')
    return (cut[:sp] if sp > limit * 0.6 else cut).rstrip(',;:. ') + '…'


def esc_attr(s):
    return (str(s if s is not None else '')
            .replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def esc_text(s):
    return (str(s if s is not None else '')
            .replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def describe(p):
    d = p.get('description') or ''
    if not d:
        d = re.sub(r'<[^>]+>', '', p.get('long_description') or '')
    if not d:
        d = '%s, a %s asset for %s from coldd.' % (
            p['title'], p.get('cat') or 'game', p.get('platform') or 'Roblox')
    return re.sub(r'\s+', ' ', d).strip()


def abs_img(url):
    if not url:
        return ORIGIN + '/banner.jpg'
    if re.match(r'^https?://', url):
        return url
    return ORIGIN + ('' if url.startswith('/') else '/') + url


def meta_block(p, url, title, desc, img):
    return '\n'.join([
        '  <!-- meta:start -->',
        '  <meta name="description" content="%s" />' % esc_attr(desc),
        '  <link rel="canonical" href="%s" />' % esc_attr(url),
        '',
        '  <meta property="og:type" content="product" />',
        '  <meta property="og:site_name" content="coldd Development" />',
        '  <meta property="og:url" content="%s" />' % esc_attr(url),
        '  <meta property="og:title" content="%s" />' % esc_attr(title),
        '  <meta property="og:description" content="%s" />' % esc_attr(desc),
        '  <meta property="og:image" content="%s" />' % esc_attr(img),
        '  <meta property="og:image:alt" content="%s" />' % esc_attr(p['title']),
        '',
        '  <meta name="twitter:card" content="summary_large_image" />',
        '  <meta name="twitter:site" content="@ColddDev" />',
        '  <meta name="twitter:title" content="%s" />' % esc_attr(title),
        '  <meta name="twitter:description" content="%s" />' % esc_attr(desc),
        '  <meta name="twitter:image" content="%s" />' % esc_attr(img),
        '  <meta name="theme-color" content="#15161b" />',
        '  <!-- meta:end -->',
    ])


def ld_block(p, url, desc, img):
    cat = p.get('cat') or ''
    cat_slug = CAT_SLUG.get(cat, re.sub(r'[^a-z0-9]+', '-', cat.lower()).strip('-'))
    shop_page = p.get('page') or '/shop'
    price = p.get('price_usd')
    offer = {
        '@type': 'Offer',
        'url': url,
        'price': str(price if price is not None else 0),
        'priceCurrency': 'USD',
        'availability': 'https://schema.org/InStock',
        'itemCondition': 'https://schema.org/NewCondition',
        'seller': {'@type': 'Organization', 'name': 'coldd Development'},
    }
    product = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        'name': p['title'],
        'description': clamp(desc, 300),
        'image': [img],
        'sku': p['slug'],
        'category': cat,
        'brand': {'@type': 'Brand', 'name': 'coldd Development'},
        'offers': offer,
    }
    reviews = p.get('reviews_count') or 0
    rating = p.get('rating') or 0
    if reviews and rating:
        product['aggregateRating'] = {
            '@type': 'AggregateRating',
            'ratingValue': str(rating),
            'reviewCount': str(reviews),
            'bestRating': '5', 'worstRating': '1',
        }
    trail = [{'name': 'Home', 'path': '/'},
             {'name': p.get('platform') or 'Shop', 'path': shop_page}]
    if cat:
        trail.append({'name': cat, 'path': shop_page + '?cat=' + cat_slug})
    trail.append({'name': p['title'], 'path': '/product/' + p['slug']})
    crumbs = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        'itemListElement': [
            {'@type': 'ListItem', 'position': i + 1, 'name': it['name'],
             'item': ORIGIN + it['path']}
            for i, it in enumerate(trail)
        ],
    }
    dump = lambda d: json.dumps(d, ensure_ascii=False, separators=(',', ':'))
    # ids match coldSeo.jsonLd() in app.js so hydration REPLACES these rather
    # than appending a second copy.
    return ('  <!-- ld:start -->\n'
            '  <script type="application/ld+json" id="ld-product">%s</script>\n'
            '  <script type="application/ld+json" id="ld-crumbs">%s</script>\n'
            '  <!-- ld:end -->' % (dump(product), dump(crumbs)))


def visible_crumb(p):
    cat = p.get('cat') or ''
    cat_slug = CAT_SLUG.get(cat, re.sub(r'[^a-z0-9]+', '-', cat.lower()).strip('-'))
    shop_page = p.get('page') or '/shop'
    parts = ['<a href="/">Home</a><span>›</span>',
             '<a href="%s">%s</a><span>›</span>' % (esc_attr(shop_page), esc_text(p.get('platform') or 'Shop'))]
    if cat:
        parts.append('<a href="%s?cat=%s">%s</a><span>›</span>' % (esc_attr(shop_page), esc_attr(cat_slug), esc_text(cat)))
    parts.append('<span class="pd-crumb-cur">%s</span>' % esc_text(p['title']))
    return ''.join(parts)


def build_one(template, p):
    slug = p['slug']
    url = ORIGIN + '/product/' + slug
    title = p['title'] + ' - coldd'
    desc = clamp(describe(p))
    img = abs_img(p.get('image'))

    out = template
    out = re.sub(r'<title>[^<]*</title>', '<title>%s</title>' % esc_text(title), out, count=1)
    out = re.sub(r'  <!-- meta:start -->.*?  <!-- meta:end -->',
                 lambda _m: meta_block(p, url, title, desc, img), out, count=1, flags=re.S)
    # The shell has no <!-- ld:* --> block of its own; add one before </head>.
    out = out.replace('</head>', ld_block(p, url, desc, img) + '\n</head>', 1)

    # Pre-fill the visible shell so a non-JS crawler gets real content; app.js
    # overwrites these with the identical values on hydration.
    out = out.replace('<nav class="pd-crumb" id="pdCrumb" aria-label="Breadcrumb"></nav>',
                      '<nav class="pd-crumb" id="pdCrumb" aria-label="Breadcrumb">%s</nav>' % visible_crumb(p), 1)
    out = out.replace('<h1 class="pd-title" id="pdTitle"></h1>',
                      '<h1 class="pd-title" id="pdTitle">%s</h1>' % esc_text(p['title']), 1)
    out = out.replace('<p class="pd-sub" id="pdSub"></p>',
                      '<p class="pd-sub" id="pdSub">%s</p>' % esc_text(p.get('description') or desc), 1)
    return out


def main():
    try:
        products = fetch_products()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print('  ! products unavailable (%s) - leaving existing shells untouched' % e, file=sys.stderr)
        return 1

    template = TEMPLATE.read_text(encoding='utf-8')
    active = set()
    for p in products:
        if not p.get('slug') or p['slug'] in SKIP_SLUGS:
            continue
        active.add(p['slug'])
        dest = OUT_DIR / p['slug'] / 'index.html'
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not (float(p.get('price_usd') or 0) > 0):
            dest.write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><meta http-equiv="refresh" content="0;url=/shop?free=1"><title>Free products - coldd</title></head><body><a href="/shop?free=1">Join Discord to unlock free products</a></body></html>', encoding='utf-8')
        else:
            dest.write_text(build_one(template, p), encoding='utf-8')

    # Prune shells for products that are no longer active.
    pruned = 0
    for child in OUT_DIR.iterdir():
        if child.is_dir() and child.name not in active and (child / 'index.html').exists():
            shutil.rmtree(child)
            pruned += 1

    print('Wrote %d product shells%s' % (len(active), (', pruned %d' % pruned) if pruned else ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
