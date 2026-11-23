// ==UserScript==
// @name         coldd Creator Store Analytics
// @namespace    https://coldd.dev
// @version      5.1
// @description  Creator Store sales analytics in AU$ (revenue, fees, payouts, top products) that also syncs every sale to the coldd admin
// @author       coldd
// @match        https://create.roblox.com/*
// @icon         https://www.roblox.com/favicon.ico
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      ekinmytmudjwfaqaqswp.supabase.co
// @connect      api.frankfurter.dev
// @connect      thumbnails.roblox.com
// @connect      users.roblox.com
// @sandbox      JavaScript
// @run-at       document-idle
// ==/UserScript==

/*
 * 5.1: buyer pictures work (the payload has no buyer id, so buyers are looked up
 *      by username on users.roblox.com), Roblox's own font again, and the
 *      payment's field layout (types only) is logged to the console once.
 *
 * What changed from 4.2
 * - It no longer writes rows into Roblox's own transactions table. That table
 *   is React-controlled: rows added from outside got reordered and recycled by
 *   React (old orders mixed in with new ones, the wrong buyer pictures). The
 *   newest sales now show in a "Recent sales" list inside this panel instead.
 * - Buyer pictures come from thumbnails.roblox.com (the old headshot-thumbnail
 *   image URL no longer resolves).
 * - Every figure is AU$ (live USD rate from frankfurter.dev, cached 12 hours).
 * - Cards: Total revenue, Processing fees (net earnings under it), Next payout,
 *   Upcoming payout, AOV, Orders. Payouts: each sale sits in escrow for 30 days
 *   and is paid on the 1st of the month after it clears (a sale on 28 Nov
 *   clears 28 Dec and is paid 1 Jan). Payout cards ignore the timeframe.
 * - Peak buying hours is gone; Asset Revenue Breakdown is now Top Products.
 * - Each sync also sends the sales to coldd (platform-sales-ingest), so they
 *   count on the admin dashboard. Set the key once from the Tampermonkey menu
 *   ("Set coldd sync key") or the "Connect coldd" button on the panel.
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
    INGEST_URL: 'https://ekinmytmudjwfaqaqswp.supabase.co/functions/v1/platform-sales-ingest',
    INGEST_BATCH: 500,
    FX_FALLBACK: 1.52,
    FX_TTL_MS: 12 * 60 * 60 * 1000,
    RECENT_ROWS: 10,
    IDS: Object.freeze({
      ROOT: 'coldd-cs-analytics',
      BADGE: 'coldd-cs-badge',
      SYNC: 'coldd-cs-sync',
      SELECT: 'coldd-cs-range',
      CARDS: 'coldd-cs-cards',
      VELOCITY_TITLE: 'coldd-cs-velocity-title',
      VELOCITY_CANVAS: 'coldd-cs-velocity',
      TOP: 'coldd-cs-top',
      RECENT: 'coldd-cs-recent',
    }),
  });
  const KEY_STORE = 'coldd_ingest_key';
  const SYNCED_UPTO = 'coldd_synced_upto';
  const FX_STORE = 'coldd_fx_usd_aud';

  const state = {
    payments: [],          // normalised, newest first
    selectedRange: '28d',
    velocityChart: null,
    isFetching: false,
    refreshTimer: null,
    lastFetchTime: 0,
    audRate: CONFIG.FX_FALLBACK,
    headshots: new Map(),  // userId -> image url
    syncNote: '',
    cardClass: '',
    userIds: new Map(),   // lower-case username -> user id ('' = not found)
    loggedShape: false,
  };

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const aud = (usd) => (Number(usd) || 0) * state.audRate;
  const fmtA = (v) => 'A$' + (Number(v) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDay = (d) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const plural = (n, w) => `${n.toLocaleString('en-AU')} ${w}${n === 1 ? '' : 's'}`;
  function relTime(d) {
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
    return fmtDay(d);
  }
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
  // One observer for the life of the tab: Roblox's React app can drop our
  // panel when it re-renders or when you switch tabs and come back, so the
  // panel is put back whenever it goes missing on the target page.
  let ensureQueued = false;
  function ensurePanel() {
    if (ensureQueued) return;
    ensureQueued = true;
    requestAnimationFrame(() => {
      ensureQueued = false;
      if (!isTargetPage()) { stopAutoRefresh(); $(CONFIG.IDS.ROOT)?.remove(); return; }
      if ($(CONFIG.IDS.ROOT)) return;
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
  // The live payload does not carry the purchaserId / assetId / paymentId
  // fields 4.2 assumed, so ids are searched for by name instead of assumed.
  function findId(obj, re, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3) return '';
    for (const [k, v] of Object.entries(obj)) {
      if (re.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) return String(v);
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') { const f = findId(v, re, depth + 1); if (f) return f; }
    }
    return '';
  }
  // Key names and value types only (no values), for working out the payload.
  function shapeOf(v, d = 0) {
    if (Array.isArray(v)) return [v.length ? shapeOf(v[0], d + 1) : 'empty'];
    if (v && typeof v === 'object') {
      if (d > 4) return '{...}';
      const o = {};
      Object.keys(v).forEach((k) => { o[k] = shapeOf(v[k], d + 1); });
      return o;
    }
    return typeof v;
  }
  function normalise(p) {
    const base = p.basePayment || {};
    const gross = (base.totalAmount?.quantity?.significand || 0) / CONFIG.CURRENCY_DIVISOR;
    const net = (p.netAmount?.quantity?.significand || 0) / CONFIG.CURRENCY_DIVISOR;
    const when = new Date(base.paymentDateTime || 0);
    // The stored sale key must never change (coldd matches re-sent sales on it),
    // so it is still built from exactly the fields 5.0 used.
    const keyAsset = base.assetId || base.productId || '';
    const assetId = keyAsset || findId(base, /^(asset|item|target|product)Id$/i);
    const buyerId = p.purchaserId || findId(p.purchaser, /^(id|userId)$/i) || findId(p, /^(purchaser|buyer)(User)?Id$/i);
    return {
      id: String(base.paymentId || `${base.paymentDateTime}|${p.purchaserId || p.purchaserName}|${keyAsset}`),
      when, gross, net,
      currency: String(base.totalAmount?.currencyCode || base.totalAmount?.currency || 'USD').toUpperCase(),
      name: base.productName || 'Unknown asset',
      assetId: String(assetId || ''),
      assetType: base.assetType || '',
      buyer: p.purchaserName || 'Unknown buyer',
      buyerId: buyerId ? String(buyerId) : '',
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
      if (Array.isArray(data.sellerPayments)) {
        if (!state.loggedShape && data.sellerPayments[0]) {
          state.loggedShape = true;
          console.info('[coldd analytics] payment layout (types only):', JSON.stringify(shapeOf(data.sellerPayments[0])));
        }
        out.push(...data.sellerPayments.map(normalise));
      }
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
    setBadge('Syncing ledger…', 'info');
    try {
      await loadAudRate();
      state.payments = await fetchAllPayments();
      state.lastFetchTime = Date.now();
      render();
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setBadge(`${plural(state.payments.length, 'order')} analysed · ${t}`, 'ok');
      syncToColdd();
    } catch (err) {
      console.error('[coldd analytics] sync failed:', err);
      setBadge('Could not read your sales', 'err');
    } finally {
      state.isFetching = false;
    }
  }

  // ---------- coldd sync ----------
  function ingestKey() { return GM_getValue(KEY_STORE, ''); }
  function askForKey() {
    const k = prompt('Paste the coldd sync key (PLATFORM_INGEST_KEY). It is saved in Tampermonkey on this browser only.', ingestKey() || '');
    if (k === null) return;
    GM_setValue(KEY_STORE, k.trim());
    GM_setValue(SYNCED_UPTO, 0); // first sync after a new key sends the full history
    renderSyncState();
    syncToColdd();
  }
  GM_registerMenuCommand('Set coldd sync key', askForKey);

  async function syncToColdd() {
    const key = ingestKey();
    if (!key) { state.syncNote = 'not connected'; renderSyncState(); return; }
    // After the first full send, only the last 45 days go up each time
    // (re-sending is harmless: coldd updates the same row by payment id).
    const upto = Number(GM_getValue(SYNCED_UPTO, 0)) || 0;
    const since = upto ? upto - 45 * 86400000 : 0;
    const list = state.payments.filter((p) => p.when.getTime() >= since);
    if (!list.length) { state.syncNote = 'up to date'; renderSyncState(); return; }
    state.syncNote = 'sending…'; renderSyncState();
    try {
      let written = 0;
      for (let i = 0; i < list.length; i += CONFIG.INGEST_BATCH) {
        const batch = list.slice(i, i + CONFIG.INGEST_BATCH).map((p) => ({
          external_id: p.id, sold_at: p.when.toISOString(), product_name: p.name,
          amount: Math.round(p.gross * 100) / 100, net_amount: Math.round(p.net * 100) / 100, currency: p.currency,
          buyer_name: p.buyer, buyer_ref: p.buyerId, raw: { assetId: p.assetId, assetType: p.assetType },
        }));
        const r = await gmRequest({
          method: 'POST', url: CONFIG.INGEST_URL, data: JSON.stringify({ platform: 'creatorstore', source: 'userscript', sales: batch }),
          headers: { 'Content-Type': 'application/json', 'x-ingest-key': key },
        });
        const body = (() => { try { return JSON.parse(r.responseText); } catch (_) { return {}; } })();
        if (r.status === 401) { state.syncNote = 'wrong key'; renderSyncState(); return; }
        if (r.status >= 300) throw new Error(body.error || `HTTP ${r.status}`);
        written += body.written || 0;
      }
      GM_setValue(SYNCED_UPTO, state.payments[0]?.when.getTime() || Date.now());
      state.syncNote = `synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (err) {
      console.error('[coldd analytics] coldd sync failed:', err);
      state.syncNote = 'sync failed';
    }
    renderSyncState();
  }

  // ---------- metrics ----------
  function rangeStart(key, now) {
    const d = new Date(now);
    switch (key) {
      case '28d': d.setDate(d.getDate() - 27); d.setHours(0, 0, 0, 0); return d;
      case 'mtd': return new Date(now.getFullYear(), now.getMonth(), 1);
      case 'ytd': return new Date(now.getFullYear(), 0, 1);
      case '60d': return new Date(now.getTime() - 60 * 86400000);
      case '90d': return new Date(now.getTime() - 90 * 86400000);
      case '6m': d.setMonth(d.getMonth() - 6); return d;
      case '1y': d.setFullYear(d.getFullYear() - 1); return d;
      default: return null;
    }
  }
  // Escrow: a sale clears 30 days after purchase and is paid on the 1st of the
  // month after it clears.
  function payoutDate(when) {
    const cleared = new Date(when.getTime() + CONFIG.ESCROW_DAYS * 86400000);
    return new Date(cleared.getFullYear(), cleared.getMonth() + 1, 1);
  }
  function metrics() {
    const now = new Date();
    const start = rangeStart(state.selectedRange, now);
    const inRange = start ? state.payments.filter((p) => p.when >= start) : state.payments;
    let gross = 0, net = 0;
    inRange.forEach((p) => { gross += p.gross; net += p.net; });

    const nextDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const afterDate = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const next = { date: nextDate, net: 0, n: 0 }, upcoming = { date: afterDate, net: 0, n: 0 };
    state.payments.forEach((p) => {
      const pd = payoutDate(p.when).getTime();
      if (pd === nextDate.getTime()) { next.net += p.net; next.n++; }
      else if (pd === afterDate.getTime()) { upcoming.net += p.net; upcoming.n++; }
    });

    const daily = state.selectedRange === '28d' || state.selectedRange === 'mtd';
    const series = new Map();
    if (daily) {
      for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= now; d.setDate(d.getDate() + 1)) {
        series.set(dayKey(d, true), { label: fmtDay(d), gross: 0, net: 0 });
      }
    }
    const assets = new Map();
    inRange.slice().reverse().forEach((p) => {
      const k = dayKey(p.when, daily);
      if (!series.has(k)) series.set(k, { label: daily ? fmtDay(p.when) : p.when.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }), gross: 0, net: 0 });
      const s = series.get(k); s.gross += p.gross; s.net += p.net;
      const a = assets.get(p.name) || { name: p.name, assetId: p.assetId, sold: 0, gross: 0 };
      a.sold++; a.gross += p.gross; assets.set(p.name, a);
    });
    const top = [...assets.values()].sort((a, b) => b.gross - a.gross);
    return { gross, net, fees: gross - net, orders: inRange.length, next, upcoming, daily, series, top };
  }
  function dayKey(d, daily) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return daily ? `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}` : `${d.getFullYear()}-${m}`;
  }

  // ---------- UI ----------
  const STYLE = `
    #${CONFIG.IDS.ROOT} { display: flex; flex-direction: column; gap: 16px; width: 100%; margin-bottom: 24px; box-sizing: border-box; font-variant-numeric: tabular-nums; }
    #${CONFIG.IDS.ROOT} * { box-sizing: border-box; }
    #${CONFIG.IDS.ROOT} select, #${CONFIG.IDS.ROOT} button, #${CONFIG.IDS.ROOT} table { font-family: inherit; }
    #${CONFIG.IDS.ROOT} .cs-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    #${CONFIG.IDS.ROOT} .cs-head h2 { font-size: 1.25rem; font-weight: 600; margin: 0; }
    #${CONFIG.IDS.ROOT} .cs-pill { font-size: .75rem; font-weight: 700; padding: 2px 9px; border-radius: 12px; }
    #${CONFIG.IDS.ROOT} .cs-pill.info { background: rgba(0,133,255,.2); color: #4aa3ff; }
    #${CONFIG.IDS.ROOT} .cs-pill.ok { background: rgba(76,175,80,.2); color: #5fd068; }
    #${CONFIG.IDS.ROOT} .cs-pill.err { background: rgba(255,82,82,.2); color: #ff6b6b; }
    #${CONFIG.IDS.ROOT} .cs-pill.mute { background: rgba(255,255,255,.08); color: rgba(255,255,255,.7); }
    #${CONFIG.IDS.ROOT} button.cs-pill { border: 0; cursor: pointer; font-family: inherit; }
    #${CONFIG.IDS.ROOT} select { background: rgba(255,255,255,.08); color: inherit; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; padding: 6px 12px; font-size: .85rem; font-weight: 500; cursor: pointer; }
    #${CONFIG.IDS.ROOT} select option { background: #232527; color: #fff; }
    #${CONFIG.IDS.ROOT} .cs-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    #${CONFIG.IDS.ROOT} .cs-card { padding: 16px; display: flex; flex-direction: column; gap: 6px; margin: 0; min-width: 0; }
    #${CONFIG.IDS.ROOT} .cs-label { font-size: .95rem; font-weight: 500; opacity: .85; }
    #${CONFIG.IDS.ROOT} .cs-value { font-size: 1.6rem; font-weight: 700; white-space: nowrap; }
    #${CONFIG.IDS.ROOT} .cs-sub { font-size: .8rem; opacity: .65; }
    #${CONFIG.IDS.ROOT} .cs-green { color: #4caf50; } #${CONFIG.IDS.ROOT} .cs-red { color: #ff5252; } #${CONFIG.IDS.ROOT} .cs-blue { color: #29b6f6; }
    #${CONFIG.IDS.ROOT} .cs-row { display: grid; grid-template-columns: 2fr 1.2fr; gap: 16px; }
    @media (max-width: 1000px) { #${CONFIG.IDS.ROOT} .cs-row { grid-template-columns: 100%; } }
    #${CONFIG.IDS.ROOT} .cs-panel { padding: 20px; display: flex; flex-direction: column; margin: 0; min-width: 0; }
    #${CONFIG.IDS.ROOT} .cs-panel h3 { margin: 0 0 14px; font-size: 1.1rem; font-weight: 500; }
    #${CONFIG.IDS.ROOT} .cs-list { display: flex; flex-direction: column; gap: 6px; font-size: .85rem; overflow-y: auto; max-height: 260px; }
    #${CONFIG.IDS.ROOT} .cs-top { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
    #${CONFIG.IDS.ROOT} .cs-top div { display: flex; justify-content: space-between; gap: 12px; }
    #${CONFIG.IDS.ROOT} .cs-top b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #${CONFIG.IDS.ROOT} .cs-top small { font-size: .75rem; opacity: .65; }
    #${CONFIG.IDS.ROOT} .cs-recent { width: 100%; border-collapse: collapse; font-size: .85rem; }
    #${CONFIG.IDS.ROOT} .cs-recent th { text-align: left; font-weight: 500; opacity: .65; padding: 0 10px 8px 0; }
    #${CONFIG.IDS.ROOT} .cs-recent td { padding: 8px 10px 8px 0; border-top: 1px solid rgba(255,255,255,.06); vertical-align: middle; }
    #${CONFIG.IDS.ROOT} .cs-recent td:last-child, #${CONFIG.IDS.ROOT} .cs-recent th:last-child { text-align: right; padding-right: 0; }
    #${CONFIG.IDS.ROOT} .cs-buyer { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
    #${CONFIG.IDS.ROOT} .cs-buyer img, #${CONFIG.IDS.ROOT} .cs-buyer span.cs-av { width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,.08); flex: 0 0 auto; }
    #${CONFIG.IDS.ROOT} a.cs-link { color: inherit; text-decoration: none; } #${CONFIG.IDS.ROOT} a.cs-link:hover, #${CONFIG.IDS.ROOT} .cs-buyer:hover { text-decoration: underline; }
  `;

  function buildPanel(container, sampleCard) {
    const card = sampleCard.className;
    state.cardClass = card; // borrow Roblox's own card look so the panel matches the page
    const root = document.createElement('div');
    root.id = CONFIG.IDS.ROOT;
    // Roblox's own typeface (4.2 got it from the MuiTypography class on every label).
    const typo = container.querySelector('.MuiTypography-root') || document.querySelector('.MuiTypography-root');
    if (typo) root.style.fontFamily = getComputedStyle(typo).fontFamily;
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="cs-head">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <h2 class="MuiTypography-root">Store Analytics</h2>
          <span id="${CONFIG.IDS.BADGE}" class="cs-pill info">Syncing ledger…</span>
          <span id="${CONFIG.IDS.SYNC}"></span>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:.85rem;">
          <span style="opacity:.8;font-weight:500;">Timeframe</span>
          <select id="${CONFIG.IDS.SELECT}">
            <option value="28d">Last 28 days</option><option value="mtd">Month to date</option><option value="ytd">Year to date</option>
            <option value="60d">Last 60 days</option><option value="90d">Last 90 days</option><option value="6m">Last 6 months</option>
            <option value="1y">Last year</option><option value="all">All time</option>
          </select>
        </label>
      </div>
      <div class="cs-cards" id="${CONFIG.IDS.CARDS}"></div>
      <div class="cs-row">
        <div class="${card} cs-panel"><h3 class="MuiTypography-root" id="${CONFIG.IDS.VELOCITY_TITLE}">Daily Revenue Velocity</h3><div style="position:relative;height:260px;width:100%;"><canvas id="${CONFIG.IDS.VELOCITY_CANVAS}"></canvas></div></div>
        <div class="${card} cs-panel"><h3 class="MuiTypography-root">Top Products</h3><div class="cs-list" id="${CONFIG.IDS.TOP}"><span style="opacity:.6">Calculating…</span></div></div>
      </div>
      <div class="${card} cs-panel"><h3 class="MuiTypography-root">Recent sales</h3><div id="${CONFIG.IDS.RECENT}"></div></div>`;
    container.insertBefore(root, container.firstChild);
    const sel = $(CONFIG.IDS.SELECT);
    sel.value = state.selectedRange;
    sel.addEventListener('change', (e) => { state.selectedRange = e.target.value; render(); });
    root.addEventListener('click', (e) => { if (e.target.closest('[data-connect]')) askForKey(); });
    renderSyncState();
  }

  function setBadge(text, tone) {
    const b = $(CONFIG.IDS.BADGE);
    if (!b) return;
    b.textContent = text;
    b.className = 'cs-pill ' + tone;
  }
  function renderSyncState() {
    const el = $(CONFIG.IDS.SYNC);
    if (!el) return;
    if (!ingestKey()) { el.innerHTML = '<button type="button" class="cs-pill mute" data-connect>Connect coldd</button>'; return; }
    const tone = /failed|wrong/.test(state.syncNote) ? 'err' : 'mute';
    el.innerHTML = `<button type="button" class="cs-pill ${tone}" data-connect title="Change the coldd sync key">coldd: ${esc(state.syncNote || 'waiting')}</button>`;
  }

  function cardHtml(label, value, sub, cls) {
    return `<div class="${state.cardClass} cs-card"><span class="MuiTypography-root cs-label">${esc(label)}</span><span class="MuiTypography-root cs-value ${cls || ''}">${value}</span><span class="MuiTypography-root cs-sub">${sub}</span></div>`;
  }
  function render() {
    if (!$(CONFIG.IDS.ROOT)) return;
    const m = metrics();
    const feePct = m.gross ? (m.fees / m.gross * 100).toFixed(1) : '0.0';
    $(CONFIG.IDS.CARDS).innerHTML = [
      cardHtml('Total revenue', fmtA(aud(m.gross)), `Gross before fees · US$1 = A$${state.audRate.toFixed(2)}`),
      cardHtml('Processing fees', '-' + fmtA(aud(m.fees)), `Net earnings <b class="cs-green">${fmtA(aud(m.net))}</b> · ${feePct}% fees`, 'cs-red'),
      cardHtml(`Next payout · ${fmtDay(m.next.date)}`, fmtA(aud(m.next.net)), `${plural(m.next.n, 'sale')} out of escrow by then`, 'cs-green'),
      cardHtml(`Upcoming payout · ${fmtDay(m.upcoming.date)}`, fmtA(aud(m.upcoming.net)), `${plural(m.upcoming.n, 'sale')} so far, still collecting`, 'cs-blue'),
      cardHtml('AOV', fmtA(aud(m.orders ? m.gross / m.orders : 0)), `Net ${fmtA(aud(m.orders ? m.net / m.orders : 0))} per order`),
      cardHtml('Orders', m.orders.toLocaleString('en-AU'), `${new Set(state.payments.map((p) => p.buyer)).size.toLocaleString('en-AU')} buyers all time`),
    ].join('');
    $(CONFIG.IDS.VELOCITY_TITLE).textContent = m.daily ? 'Daily Revenue Velocity' : 'Monthly Revenue Velocity';
    renderTop(m.top);
    renderVelocity(m.series, m.daily);
    renderRecent();
  }
  function renderTop(top) {
    const box = $(CONFIG.IDS.TOP);
    if (!top.length) { box.innerHTML = '<span style="opacity:.6">No sales in this range</span>'; return; }
    const total = top.reduce((s, a) => s + a.gross, 0);
    box.innerHTML = top.map((a) => `
      <div class="MuiTypography-root cs-top">
        <div><b title="${esc(a.name)}">${a.assetId ? `<a class="cs-link" href="https://create.roblox.com/store/asset/${esc(a.assetId)}">${esc(a.name)}</a>` : esc(a.name)}</b><span class="cs-green" style="font-weight:600">${fmtA(aud(a.gross))}</span></div>
        <div><small>${plural(a.sold, 'sale')}</small><small>${total ? (a.gross / total * 100).toFixed(1) : '0.0'}% of revenue</small></div>
      </div>`).join('');
  }
  function renderVelocity(series, daily) {
    const ctx = $(CONFIG.IDS.VELOCITY_CANVAS);
    if (!ctx || typeof Chart === 'undefined') return;
    const keys = [...series.keys()].sort();
    const rows = keys.map((k) => series.get(k));
    if (state.velocityChart) state.velocityChart.destroy();
    state.velocityChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: rows.length ? rows.map((r) => r.label) : ['No data'],
        datasets: [{
          label: 'Revenue (A$)', data: rows.length ? rows.map((r) => aud(r.gross)) : [0],
          borderColor: '#0085ff', backgroundColor: 'rgba(0,133,255,.1)', fill: true, tension: 0.25, borderWidth: 2,
          pointRadius: daily ? 2 : 4, pointHoverRadius: 5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `Revenue ${fmtA(c.raw)} · net ${fmtA(aud(rows[c.dataIndex]?.net || 0))}` } },
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: 'rgba(255,255,255,.7)', maxTicksLimit: daily ? 14 : 12, maxRotation: 45 } },
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: 'rgba(255,255,255,.7)', callback: (v) => 'A$' + v } },
        },
      },
    });
  }
  async function renderRecent() {
    const box = $(CONFIG.IDS.RECENT);
    const rows = state.payments.slice(0, CONFIG.RECENT_ROWS);
    if (!rows.length) { box.innerHTML = '<span style="opacity:.6">No sales yet</span>'; return; }
    const draw = () => {
      box.innerHTML = `<table class="MuiTypography-root cs-recent"><thead><tr><th>Buyer</th><th>Product</th><th>Paid</th><th>Net</th><th>When</th></tr></thead><tbody>${rows.map((p) => {
        const img = p.buyerId && state.headshots.get(p.buyerId);
        const av = img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<span class="cs-av"></span>';
        const buyer = p.buyerId ? `<a class="cs-buyer" href="https://www.roblox.com/users/${esc(p.buyerId)}/profile">${av}${esc(p.buyer)}</a>` : `<span class="cs-buyer">${av}${esc(p.buyer)}</span>`;
        const prod = p.assetId ? `<a class="cs-link" href="https://create.roblox.com/store/asset/${esc(p.assetId)}">${esc(p.name)}</a>` : esc(p.name);
        return `<tr><td>${buyer}</td><td>${prod}</td><td>${fmtA(aud(p.gross))}</td><td class="cs-green">${fmtA(aud(p.net))}</td><td title="${esc(p.when.toLocaleString('en-AU'))}">${esc(relTime(p.when))}</td></tr>`;
      }).join('')}</tbody></table>`;
    };
    draw();
    // No buyer id in the payload: look the usernames up (public endpoint, sent
    // without cookies so it needs no CSRF token).
    const names = [...new Set(rows.filter((p) => !p.buyerId && p.buyer && !state.userIds.has(p.buyer.toLowerCase())).map((p) => p.buyer))];
    if (names.length) {
      try {
        const r = await gmRequest({ method: 'POST', url: 'https://users.roblox.com/v1/usernames/users', anonymous: true,
          headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ usernames: names, excludeBannedUsers: false }) });
        (JSON.parse(r.responseText).data || []).forEach((u) => { if (u && Number(u.id) > 0) state.userIds.set(String(u.requestedUsername || u.name).toLowerCase(), String(u.id)); });
      } catch (_) { /* fall through: no pictures for these */ }
      names.forEach((n) => { if (!state.userIds.has(n.toLowerCase())) state.userIds.set(n.toLowerCase(), ''); });
    }
    rows.forEach((p) => { if (!p.buyerId && p.buyer) p.buyerId = state.userIds.get(p.buyer.toLowerCase()) || ''; });
    const missing = [...new Set(rows.map((p) => p.buyerId).filter((id) => id && !state.headshots.has(id)))];
    if (!missing.length) { if (names.length && $(CONFIG.IDS.RECENT) === box) draw(); return; }
    try {
      const r = await gmRequest({ anonymous: true, url: `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${missing.join(',')}&size=48x48&format=Png&isCircular=true` });
      (JSON.parse(r.responseText).data || []).forEach((t) => { if (t.state === 'Completed' && t.imageUrl) state.headshots.set(String(t.targetId), t.imageUrl); });
      if ($(CONFIG.IDS.RECENT) === box) draw();
    } catch (_) { /* pictures are a nicety; the list still works */ }
  }

  // ---------- start ----------
  function hookHistory() {
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      history[m] = function (...args) { const r = orig.apply(this, args); ensurePanel(); return r; };
    });
  }
  hookHistory();
  window.addEventListener('popstate', ensurePanel);
  window.addEventListener('focus', () => refresh(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
  new MutationObserver(ensurePanel).observe(document.body, { childList: true, subtree: true });
  ensurePanel();
})();
