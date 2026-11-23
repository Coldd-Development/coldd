// ==UserScript==
// @name         coldd ClearlyDev Sync
// @namespace    https://coldd.dev
// @version      1.0
// @description  While the ClearlyDev vendor dashboard is open, sends your ClearlyDev orders to the coldd admin dashboard
// @author       coldd
// @match        https://dashboard.clearlydev.com/*
// @icon         https://clearlydev.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      ekinmytmudjwfaqaqswp.supabase.co
// @run-at       document-idle
// ==/UserScript==

/*
 * Reads the same orders API the ClearlyDev dashboard uses (your own session,
 * nothing stored) and posts completed and refunded orders to coldd's
 * platform-sales-ingest. Failed orders are skipped. The server-side
 * clearlydev-sync job does the same every 5 minutes; both key on the ClearlyDev
 * order number, so an order is only ever one row.
 *
 * First sync sends the whole history; after that only the last few days.
 * Set the key once: Tampermonkey menu "Set coldd sync key", or click the
 * "coldd" pill in the bottom-right corner of the dashboard.
 */
(function () {
  'use strict';

  const API = 'https://api.clearlydev.com/api/v1/vendor/orders';
  const INGEST_URL = 'https://ekinmytmudjwfaqaqswp.supabase.co/functions/v1/platform-sales-ingest';
  const KEY_STORE = 'coldd_ingest_key';
  const SYNCED_UPTO = 'coldd_cd_synced_upto';
  const EVERY_MS = 5 * 60 * 1000;
  const OVERLAP_MS = 3 * 86400000;

  let busy = false, note = '';

  function gmPost(url, body, headers) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url, data: JSON.stringify(body), timeout: 60000,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        onload: resolve, onerror: () => reject(new Error('Network error')), ontimeout: () => reject(new Error('Timed out')),
      });
    });
  }

  // ---------- small status pill ----------
  function pill() {
    let el = document.getElementById('coldd-cd-sync');
    if (!el) {
      el = document.createElement('button');
      el.id = 'coldd-cd-sync';
      el.type = 'button';
      el.title = 'coldd sync: click to set or change the sync key';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(20,21,26,.92);color:#e2e6ec;font:600 12px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px -10px rgba(0,0,0,.6);';
      el.addEventListener('click', askForKey);
      document.body.appendChild(el);
    }
    const key = GM_getValue(KEY_STORE, '');
    el.textContent = key ? 'coldd: ' + (note || 'waiting') : 'Connect coldd';
    el.style.color = /failed|wrong/.test(note) ? '#ff6b6b' : '#e2e6ec';
  }
  function setNote(n) { note = n; pill(); }

  function askForKey() {
    const k = prompt('Paste the coldd sync key (PLATFORM_INGEST_KEY). It is saved in Tampermonkey on this browser only.', GM_getValue(KEY_STORE, '') || '');
    if (k === null) return;
    GM_setValue(KEY_STORE, k.trim());
    GM_setValue(SYNCED_UPTO, 0); // a new key re-sends the full history once
    sync();
  }
  GM_registerMenuCommand('Set coldd sync key', askForKey);

  // ---------- sync ----------
  async function fetchOrders(since) {
    const out = [];
    let page = 1, pages = 1;
    while (page <= pages) {
      const r = await fetch(`${API}?page=${page}&limit=100`, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('ClearlyDev returned ' + r.status);
      const j = await r.json();
      const list = (j && j.data && j.data.orders) || [];
      pages = Number(j && j.data && j.data.pagination && j.data.pagination.pages) || 1;
      out.push(...list);
      const oldest = list.reduce((m, o) => Math.min(m, Date.parse(o.created_at) || Infinity), Infinity);
      if (since && oldest < since) break;
      page++;
      await new Promise((res) => setTimeout(res, 250));
    }
    return out;
  }

  async function sync() {
    const key = GM_getValue(KEY_STORE, '');
    if (!key) { setNote(''); return; }
    if (busy) return;
    busy = true;
    setNote('syncing…');
    try {
      const upto = Number(GM_getValue(SYNCED_UPTO, 0)) || 0;
      const orders = await fetchOrders(upto ? upto - OVERLAP_MS : 0);
      const sales = orders.filter((o) => o.status === 'completed' || o.status === 'refunded').map((o) => {
        const names = Array.isArray(o.products) ? o.products.map(String) : [];
        return {
          external_id: String(o.order_id),
          sold_at: o.created_at,
          product_name: names.join(', ') || 'ClearlyDev order',
          amount: Number(o.vendor_amount) || 0,
          currency: 'USD',
          quantity: Math.max(1, Number(o.item_count) || names.length || 1),
          status: o.status === 'refunded' || o.has_refunds ? 'refunded' : 'paid',
        };
      });
      for (let i = 0; i < sales.length; i += 500) {
        const r = await gmPost(INGEST_URL, { platform: 'clearlydev', source: 'userscript', sales: sales.slice(i, i + 500) }, { 'x-ingest-key': key });
        if (r.status === 401) { setNote('wrong key'); return; }
        if (r.status >= 300) throw new Error('coldd returned ' + r.status);
      }
      const newest = orders.reduce((m, o) => Math.max(m, Date.parse(o.created_at) || 0), upto);
      GM_setValue(SYNCED_UPTO, newest || Date.now());
      setNote('synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      console.error('[coldd ClearlyDev sync]', e);
      setNote('sync failed');
    } finally {
      busy = false;
    }
  }

  pill();
  sync();
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
})();
