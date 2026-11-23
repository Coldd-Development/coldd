// ==UserScript==
// @name         coldd Creator Store Analytics
// @namespace    https://coldd.dev
// @version      6.0
// @description  Your Creator Store earnings in AU$ on the transactions page: what you earned, sales, next payout, a chart and top products
// @author       coldd
// @match        https://create.roblox.com/*
// @icon         https://www.roblox.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.frankfurter.dev
// @connect      thumbnails.roblox.com
// @sandbox      JavaScript
// @run-at       document-idle
// ==/UserScript==

/*
 * 6.0: a smaller panel, and it no longer sends sales to coldd.dev (the server
 *      reads the same sales list every minute by itself now).
 *      Kept: earned (after Roblox's fee), sales, next payout, one earnings chart,
 *      top 5 products. Removed: status pills, the coldd connect button and key,
 *      the fees / upcoming payout / average order cards, exchange-rate notes,
 *      coloured numbers and the Recent sales table (Roblox's own table right
 *      below lists every sale). Chart.js is gone too: the chart is a few SVG bars.
 * Payouts: a sale sits in escrow for 30 days and is paid on the 1st of the
 * month after it clears (sold 28 Nov, clears 28 Dec, paid 1 Jan).
 */
(function () {
  'use strict';

  const CONFIG = Object.freeze({
    TARGET_PATH: '/dashboard/transactions',
    TARGET_TAB: 'store',
    TARGET_PAYMENT: 'IncomingPayments',
    REFRESH_INTERVAL_MS: 3 * 60 * 1000,
    FOCUS_THROTTLE_MS: 60 * 1000,
    API_PAGE_SIZE: 100,
    API_BASE_URL: 'https://apis.roblox.com/marketplace-fiat-service/v1/seller/payments',
    CURRENCY_DIVISOR: 1_000_000_000,
    ESCROW_DAYS: 30,
    FX_FALLBACK: 1.52,
    FX_TTL_MS: 12 * 60 * 60 * 1000,
    TOP_ROWS: 5,
    ROOT: 'coldd-cs-analytics',
  });
  const FX_STORE = 'coldd_fx_usd_aud';
  const RANGE_STORE = 'coldd_cs_range';
  const RANGES = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['year', 'This year'], ['all', 'All time']];

  const state = {
    payments: [],          // normalised, newest first
    range: GM_getValue(RANGE_STORE, '30d'),
    isFetching: false,
    refreshTimer: null,
    lastFetchTime: 0,
    audRate: CONFIG.FX_FALLBACK,
    assetThumbs: new Map(), // assetId -> image url ('' = none)
    cardClass: '',
    status: 'Loading sales…',
  };
  if (!RANGES.some((r) => r[0] === state.range)) state.range = '30d';

  // ---------- helpers ----------
  const root = () => document.getElementById(CONFIG.ROOT);
  const q = (sel) => root()?.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const aud = (usd) => (Number(usd) || 0) * state.audRate;
  const fmtA = (v) => 'A$' + (Number(v) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDay = (d) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const plural = (n, w) => `${n.toLocaleString('en-AU')} ${w}${n === 1 ? '' : 's'}`;
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET', url: opts.url, headers: opts.headers || {}, data: opts.data, timeout: 30000, anonymous: !!opts.anonymous,
        onload: (r) => resolve(r), onerror: () => reject(new Error('Network error')), ontimeout: () => reject(new Error('Timed out')),
      });
    });
  }

  // ---------- routing ----------
  function isTargetPage() {
    const url = new URL(location.href);
    return url.pathname === CONFIG.TARGET_PATH && url.searchParams.get('tab') === CONFIG.TARGET_TAB && url.searchParams.get('paymentType') === CONFIG.TARGET_PAYMENT;
  }
  // Roblox's React app can drop the panel when it re-renders or when you switch
  // tabs and come back, so it is put back whenever it goes missing.
  let ensureQueued = false;
  function ensurePanel() {
    if (ensureQueued) return;
    ensureQueued = true;
    requestAnimationFrame(() => {
      ensureQueued = false;
      if (!isTargetPage()) { stopAutoRefresh(); root()?.remove(); return; }
      if (root()) return;
      const container = document.querySelector('[data-testid="creator-store-transactions-id"]');
      const sampleCard = container?.querySelector('.MuiCard-root');
      if (!container || !sampleCard) return;
      buildPanel(container, sampleCard);
      startAutoRefresh();
      if (state.payments.length) render(); else refresh(true);
    });
  }
  function startAutoRefresh() {
    stopAutoRefresh();
    state.refreshTimer = setInterval(() => refresh(true), CONFIG.REFRESH_INTERVAL_MS);
  }
  function stopAutoRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  function refresh(force) {
    if (!isTargetPage()) return;
    if (force || Date.now() - state.lastFetchTime > CONFIG.FOCUS_THROTTLE_MS) fetchAndRender();
  }

  // ---------- data ----------
  function normalise(p) {
    const base = p.basePayment || {};
    // Money is significand x 10^exponent (the exponent has always been -9 so far).
    const money = (m) => {
      if (!m) return 0;
      const sig = Number(m.significand) || 0;
      return typeof m.exponent === 'number' ? sig * Math.pow(10, m.exponent) : sig / CONFIG.CURRENCY_DIVISOR;
    };
    return {
      when: new Date(base.paymentDateTime || 0),
      gross: money(base.totalAmount?.quantity),
      net: money(p.netAmount?.quantity),
      name: base.productName || 'Unknown asset',
      assetId: String(base.productKey?.productTargetId || base.assetId || base.productId || ''),
    };
  }
  async function fetchAllPayments() {
    const out = [];
    let cursor = '', hasMore = true;
    while (hasMore) {
      const url = `${CONFIG.API_BASE_URL}?pageInfo.cursor=${encodeURIComponent(cursor)}&pageInfo.pageSize=${CONFIG.API_PAGE_SIZE}&pageInfo.previous=false&purchasePriceFilter=PURCHASE_PRICE_FILTER_ALL`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} reading payments`);
      const data = await res.json();
      if (Array.isArray(data.sellerPayments)) out.push(...data.sellerPayments.map(normalise));
      hasMore = Boolean(data.pageInfo?.hasMore);
      cursor = data.pageInfo?.nextCursor || '';
      if (hasMore) await new Promise((r) => setTimeout(r, 150));
    }
    return out.filter((p) => !isNaN(p.when.getTime())).sort((a, b) => b.when - a.when);
  }
  async function loadAudRate() {
    const cached = GM_getValue(FX_STORE, null);
    if (cached && Date.now() - cached.at < CONFIG.FX_TTL_MS) { state.audRate = cached.rate; return; }
    try {
      const r = await gmRequest({ url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD' });
      const rate = Number(JSON.parse(r.responseText)?.rates?.AUD);
      if (rate > 0) { state.audRate = rate; GM_setValue(FX_STORE, { rate, at: Date.now() }); }
    } catch (_) { if (cached) state.audRate = cached.rate; }
  }
  async function fetchAndRender() {
    if (state.isFetching) return;
    state.isFetching = true;
    try {
      await loadAudRate();
      state.payments = await fetchAllPayments();
      state.lastFetchTime = Date.now();
      state.status = 'Updated ' + new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
      render();
    } catch (err) {
      console.error('[coldd analytics] could not read sales:', err);
      state.status = 'Couldn’t load sales, trying again soon';
      renderStatus();
    } finally {
      state.isFetching = false;
    }
  }

  // ---------- numbers ----------
  function rangeStart(key, now) {
    const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    switch (key) {
      case '7d': return new Date(day0.getTime() - 6 * 86400000);
      case '30d': return new Date(day0.getTime() - 29 * 86400000);
      case '90d': return new Date(day0.getTime() - 89 * 86400000);
      case 'year': return new Date(now.getFullYear(), 0, 1);
      default: return null;
    }
  }
  // A sale clears 30 days after purchase and is paid on the 1st of the month after.
  function payoutDate(when) {
    const cleared = new Date(when.getTime() + CONFIG.ESCROW_DAYS * 86400000);
    return new Date(cleared.getFullYear(), cleared.getMonth() + 1, 1);
  }
  function numbers() {
    const now = new Date();
    const start = rangeStart(state.range, now);
    const inRange = start ? state.payments.filter((p) => p.when >= start) : state.payments;
    let gross = 0, net = 0;
    inRange.forEach((p) => { gross += p.gross; net += p.net; });

    const payDay = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const payout = { date: payDay, net: 0, n: 0 };
    state.payments.forEach((p) => { if (payoutDate(p.when).getTime() === payDay.getTime()) { payout.net += p.net; payout.n++; } });

    // Bars: one per day for up to 90 days, else one per month.
    const daily = state.range !== 'year' && state.range !== 'all';
    const keyOf = (d) => daily ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : `${d.getFullYear()}-${d.getMonth()}`;
    const bars = new Map();
    const first = start || (inRange.length ? inRange[inRange.length - 1].when : now);
    if (daily) {
      for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d <= now; d.setDate(d.getDate() + 1)) {
        bars.set(keyOf(d), { when: new Date(d), net: 0, n: 0 });
      }
    } else {
      for (let d = new Date(first.getFullYear(), first.getMonth(), 1); d <= now; d.setMonth(d.getMonth() + 1)) {
        bars.set(keyOf(d), { when: new Date(d), net: 0, n: 0 });
      }
    }
    const products = new Map();
    inRange.forEach((p) => {
      const b = bars.get(keyOf(p.when));
      if (b) { b.net += p.net; b.n++; }
      const a = products.get(p.name) || { name: p.name, assetId: p.assetId, n: 0, net: 0 };
      a.n++; a.net += p.net; products.set(p.name, a);
    });
    const top = [...products.values()].sort((a, b) => b.net - a.net).slice(0, CONFIG.TOP_ROWS);
    return { gross, net, n: inRange.length, payout, daily, bars: [...bars.values()], top };
  }

  // ---------- UI ----------
  const R = '#' + CONFIG.ROOT;
  const STYLE = `
    ${R} { display: flex; flex-direction: column; gap: 12px; width: 100%; margin-bottom: 24px; box-sizing: border-box; }
    ${R} * { box-sizing: border-box; }
    ${R} button { font: inherit; color: inherit; }
    ${R} .cs-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    ${R} .cs-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 8px; background: color-mix(in srgb, currentColor 7%, transparent); }
    ${R} .cs-seg button { border: 0; background: none; padding: 5px 12px; border-radius: 6px; font-size: .8125rem; cursor: pointer; opacity: .7; }
    ${R} .cs-seg button:hover { opacity: 1; }
    ${R} .cs-seg button[aria-pressed="true"] { opacity: 1; background: color-mix(in srgb, currentColor 13%, transparent); font-weight: 600; }
    ${R} .cs-status { font-size: .8125rem; opacity: .55; }
    ${R} .cs-figs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; padding: 0; }
    ${R} .cs-fig { padding: 16px 20px; min-width: 0; }
    ${R} .cs-fig + .cs-fig { border-left: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
    ${R} .cs-fig span { display: block; font-size: .8125rem; opacity: .65; }
    ${R} .cs-fig strong { display: block; font-size: 1.5rem; font-weight: 600; margin: 4px 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    ${R} .cs-fig small { display: block; font-size: .8125rem; opacity: .55; }
    ${R} .cs-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; }
    @media (max-width: 900px) { ${R} .cs-row { grid-template-columns: 100%; } ${R} .cs-figs { grid-template-columns: 100%; } ${R} .cs-fig + .cs-fig { border-left: 0; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); } }
    ${R} .cs-panel { padding: 16px 20px; margin: 0; min-width: 0; display: flex; flex-direction: column; }
    ${R} .cs-panel h3 { margin: 0 0 12px; font-size: .9375rem; font-weight: 600; }
    ${R} .cs-chart { position: relative; flex: 1 1 auto; min-height: 180px; }
    ${R} .cs-chart svg { display: block; width: 100%; height: 100%; overflow: visible; }
    ${R} .cs-chart rect.b { fill: #3b82f6; }
    ${R} .cs-chart rect.hit { fill: transparent; }
    ${R} .cs-chart rect.b.on { fill: #60a5fa; }
    ${R} .cs-chart line { stroke: currentColor; stroke-opacity: .12; }
    ${R} .cs-chart text { fill: currentColor; fill-opacity: .55; font-size: 11px; }
    ${R} .cs-tip { position: absolute; pointer-events: none; padding: 6px 10px; border-radius: 6px; font-size: .8125rem; white-space: nowrap; background: #1f2023; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.3); transform: translate(-50%, calc(-100% - 8px)); }
    ${R} .cs-empty { font-size: .875rem; opacity: .55; padding: 8px 0; }
    ${R} .cs-top { display: flex; flex-direction: column; }
    ${R} .cs-top a, ${R} .cs-top div.cs-item { display: flex; align-items: center; gap: 10px; padding: 7px 0; color: inherit; text-decoration: none; min-width: 0; }
    ${R} .cs-top > * + * { border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
    ${R} .cs-top a:hover .cs-name { text-decoration: underline; }
    ${R} .cs-top img, ${R} .cs-top .cs-pic { width: 32px; height: 32px; border-radius: 6px; object-fit: cover; flex: 0 0 auto; background: color-mix(in srgb, currentColor 8%, transparent); }
    ${R} .cs-top .cs-txt { flex: 1 1 auto; min-width: 0; }
    ${R} .cs-name { display: block; font-size: .875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ${R} .cs-top small { display: block; font-size: .75rem; opacity: .55; }
    ${R} .cs-amt { font-size: .875rem; font-weight: 600; flex: 0 0 auto; }
  `;

  function buildPanel(container, sampleCard) {
    const card = sampleCard.className;
    state.cardClass = card; // Roblox's own card look, so the panel matches the page
    const el = document.createElement('div');
    el.id = CONFIG.ROOT;
    el.className = 'MuiTypography-root';
    el.innerHTML = `
      <style>${STYLE}</style>
      <div class="cs-bar">
        <div class="cs-seg" role="group" aria-label="Timeframe">${RANGES.map(([k, label]) => `<button type="button" data-range="${k}" aria-pressed="${k === state.range}">${label}</button>`).join('')}</div>
        <span class="cs-status"></span>
      </div>
      <div class="${card} cs-figs"></div>
      <div class="cs-row">
        <div class="${card} cs-panel"><h3 class="cs-chart-title">Earnings</h3><div class="cs-chart"></div></div>
        <div class="${card} cs-panel"><h3>Top products</h3><div class="cs-top"></div></div>
      </div>`;
    container.insertBefore(el, container.firstChild);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-range]');
      if (!b) return;
      state.range = b.getAttribute('data-range');
      GM_setValue(RANGE_STORE, state.range);
      el.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    });
    renderStatus();
  }
  function renderStatus() {
    const s = q('.cs-status');
    if (s) s.textContent = state.status;
  }
  function fig(label, value, sub) {
    return `<div class="cs-fig"><span>${esc(label)}</span><strong>${value}</strong><small>${sub}</small></div>`;
  }
  function render() {
    if (!root()) return;
    renderStatus();
    const m = numbers();
    q('.cs-figs').innerHTML = [
      fig('Earned', fmtA(aud(m.net)), m.gross ? `${fmtA(aud(m.gross))} before Roblox’s fee` : 'No sales in this time'),
      fig('Sales', m.n.toLocaleString('en-AU'), m.n ? `${fmtA(aud(m.net / m.n))} each on average` : '&nbsp;'),
      fig('Next payout', fmtA(aud(m.payout.net)), `${esc(m.payout.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' }))} · ${plural(m.payout.n, 'sale')}`),
    ].join('');
    q('.cs-chart-title').textContent = m.daily ? 'Earnings per day' : 'Earnings per month';
    // The list first: it sets the row's height, which the chart is sized to.
    renderTop(m.top);
    renderChart(m.bars, m.daily);
  }

  // A plain bar chart: one bar per day (or month), hover for the figure.
  function renderChart(bars, daily) {
    const box = q('.cs-chart');
    if (!box) return;
    // Sized to the box (it grows to match the Top products card next to it).
    const W = Math.max(240, box.clientWidth || 600), H = Math.max(180, box.clientHeight || 180), padL = 44, padB = 20, padT = 6;
    const max = Math.max(...bars.map((b) => aud(b.net)), 0);
    if (!bars.length || max <= 0) { box.innerHTML = '<div class="cs-empty">No sales in this time.</div>'; return; }
    const step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const plotW = W - padL, plotH = H - padB - padT;
    const slot = plotW / bars.length, bw = Math.max(1, Math.min(28, slot * 0.7));
    const y = (v) => padT + plotH - (v / top) * plotH;
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Earnings per ${daily ? 'day' : 'month'}">`;
    for (let v = 0; v <= top + 1e-9; v += step) {
      svg += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">A$${v.toLocaleString('en-AU')}</text>`;
    }
    const every = Math.max(1, Math.ceil(bars.length / (daily ? 8 : 10)));
    let hits = '';
    bars.forEach((b, i) => {
      const v = aud(b.net), x = padL + i * slot + (slot - bw) / 2, h = Math.max(v > 0 ? 2 : 0, (v / top) * plotH);
      svg += `<rect class="b" data-i="${i}" x="${x}" y="${padT + plotH - h}" width="${bw}" height="${h}" rx="${Math.min(3, bw / 2)}"/>`;
      // A full-height hover area per bar, drawn last so it sits on top of the bars.
      hits += `<rect class="hit" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"/>`;
      if (i % every === 0) svg += `<text x="${padL + i * slot + slot / 2}" y="${H - 4}" text-anchor="middle">${esc(daily ? fmtDay(b.when) : b.when.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }))}</text>`;
    });
    box.innerHTML = svg + hits + '</svg><div class="cs-tip" hidden></div>';
    const tip = box.querySelector('.cs-tip'), svgEl = box.querySelector('svg');
    let on = null;
    const clear = () => { tip.hidden = true; if (on) on.classList.remove('on'); on = null; };
    svgEl.addEventListener('mousemove', (e) => {
      const hit = e.target.closest('rect.hit');
      if (!hit) { clear(); return; }
      const i = +hit.getAttribute('data-i'), b = bars[i];
      const bar = svgEl.querySelector(`rect.b[data-i="${i}"]`);
      if (on !== bar) { if (on) on.classList.remove('on'); on = bar; if (bar) bar.classList.add('on'); }
      const r = box.getBoundingClientRect();
      const label = daily ? b.when.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : b.when.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
      tip.textContent = `${label} · ${fmtA(aud(b.net))} · ${plural(b.n, 'sale')}`;
      tip.style.left = Math.min(r.width - 90, Math.max(90, e.clientX - r.left)) + 'px';
      tip.style.top = Math.max(18, (+(bar ? bar.getAttribute('y') : padT) / H) * r.height) + 'px';
      tip.hidden = false;
    });
    svgEl.addEventListener('mouseleave', clear);
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  async function renderTop(top) {
    const box = q('.cs-top');
    if (!box) return;
    if (!top.length) { box.innerHTML = '<div class="cs-empty">No sales in this time.</div>'; return; }
    const draw = () => {
      box.innerHTML = top.map((a) => {
        const img = a.assetId && state.assetThumbs.get(a.assetId);
        const pic = img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<span class="cs-pic"></span>';
        const inner = `${pic}<span class="cs-txt"><span class="cs-name">${esc(a.name)}</span><small>${plural(a.n, 'sale')}</small></span><span class="cs-amt">${fmtA(aud(a.net))}</span>`;
        return a.assetId ? `<a href="https://create.roblox.com/store/asset/${esc(a.assetId)}" title="${esc(a.name)}">${inner}</a>` : `<div class="cs-item">${inner}</div>`;
      }).join('');
    };
    draw();
    const missing = [...new Set(top.map((a) => a.assetId).filter((id) => id && !state.assetThumbs.has(id)))];
    if (!missing.length) return;
    try {
      const r = await gmRequest({ anonymous: true, url: `https://thumbnails.roblox.com/v1/assets?assetIds=${missing.join(',')}&size=150x150&format=Png&isCircular=false` });
      (JSON.parse(r.responseText).data || []).forEach((t) => { if (t.state === 'Completed' && t.imageUrl) state.assetThumbs.set(String(t.targetId), t.imageUrl); });
    } catch (_) { /* pictures are a nicety; the list still works */ }
    missing.forEach((id) => { if (!state.assetThumbs.has(id)) state.assetThumbs.set(id, ''); });
    if (q('.cs-top') === box) draw();
  }

  // ---------- start ----------
  ['pushState', 'replaceState'].forEach((m) => {
    const orig = history[m];
    history[m] = function (...args) { const r = orig.apply(this, args); ensurePanel(); return r; };
  });
  window.addEventListener('popstate', ensurePanel);
  window.addEventListener('focus', () => refresh(false));
  window.addEventListener('resize', () => { if (root() && state.payments.length) render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
  new MutationObserver(ensurePanel).observe(document.body, { childList: true, subtree: true });
  ensurePanel();
})();
