(function () {
  'use strict';

  /* ================================================================
     ACCESS GATE
     Real check against the signed-in user's profiles.is_admin/role - the
     same flag every admin-* Edge Function checks server-side, not a
     separate client-side list. Async (needs a query), so the panel stays
     hidden until it resolves rather than optimistically showing it.
     ================================================================ */
  var gate = document.getElementById('admGate');
  var shell = document.getElementById('admShell');

  if (!window.coldAuth || !window.coldAuth.checkIsAdmin) {
    if (gate) gate.hidden = false;
    return;
  }
  window.coldAuth.checkIsAdmin().then(function (info) {
    if (!info.isAdmin) {
      if (gate) gate.hidden = false;
      if (shell) shell.hidden = true;
      return;
    }
    if (gate) gate.hidden = true;
    if (shell) shell.hidden = false;
    boot(info);
  });

  function boot(ADMIN) {
  window.__ADMIN_ID = ADMIN.id;

  // A focused <input type="number"> silently changes value on mouse wheel
  // scroll in every major browser - scroll the page while the cursor
  // happens to be over a still-focused price field (easy to do on a form
  // this long) and the number underneath it changes with no visual cue.
  // That's the most likely way a real robux_price ended up saved as a
  // flat 0 - blurring on wheel lets the page scroll normally without the
  // input eating it.
  document.addEventListener('wheel', function (e) {
    var el = document.activeElement;
    if (el && el.tagName === 'INPUT' && el.type === 'number' && e.target === el) el.blur();
  }, { passive: true });

  /* ================================================================
     UTILITIES
     ================================================================ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dialogAlert(message) {
    return window.coldDialog.alert(message, { title: 'Something went wrong' });
  }
  // Keep existing error paths concise while routing every former native alert
  // through the shared, styled dialog.
  function alert(message) { return dialogAlert(message); }
  function dialogConfirm(message, options) {
    return window.coldDialog.confirm(message, options || {});
  }
  function dialogPrompt(message, value, options) {
    return window.coldDialog.prompt(message, value, options || {});
  }
  function hsh(s) {
    var h = 5381; s = String(s);
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function rnd(seed) { return (hsh(seed) % 10000) / 10000; }
  function pick(arr, seed) { return arr[hsh(seed) % arr.length]; }

  // Sticky corner toast for save/failure feedback - a real transient popup
  // instead of static "Saved." text that's easy to miss. Auto-dismisses on
  // success, stays until clicked on failure.
  var admToastEl = null, admToastTimer = null;
  function admToast(message, ok) {
    if (!admToastEl) {
      admToastEl = document.createElement('div');
      admToastEl.className = 'adm-toast';
      admToastEl.addEventListener('click', function () { admToastEl.classList.remove('show'); });
      document.body.appendChild(admToastEl);
    }
    clearTimeout(admToastTimer);
    admToastEl.textContent = message;
    admToastEl.className = 'adm-toast show ' + (ok ? 'ok' : 'err');
    // force reflow so re-triggering restarts the slide-in animation
    void admToastEl.offsetWidth;
    admToastEl.classList.add('show');
    if (ok) admToastTimer = setTimeout(function () { admToastEl.classList.remove('show'); }, 3200);
  }
  var ROBUX_PER_USD = 80;
  var DEVEX_USD_PER_ROBUX = 0.0038;
  var AUD_RATE = 1.52;
  function usd(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function usd0(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
  function aud(n) { return 'A$' + (Math.round((Number(n) || 0) * AUD_RATE * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function robux(n) { return 'R$ ' + Math.round((Number(n) || 0) * ROBUX_PER_USD).toLocaleString('en-US'); }
  // Unlike robux(), which converts a USD figure into its Robux equivalent
  // for display, this formats a value that's already a real Robux amount
  // (e.g. websiteRevenue().robux, summed from orders.total_robux) - do not
  // multiply it by ROBUX_PER_USD again.
  function robuxRaw(n) { return 'R$ ' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
  function pct(n) { return (Math.round((Number(n) || 0) * 10) / 10) + '%'; }
  // Real robux orders were actually charged in Robux (via a Roblox
  // gamepass, not our checkout) - showing usd(o.total) for them would
  // display the USD-equivalent record-keeping figure as if it were the
  // real charge. Order-history amounts are fixed historical facts, not
  // live prices, so this never routes through the flat-conversion
  // window.__robux() either.
  function orderAmount(o) { return o.currency === 'robux' ? ('R$ ' + Math.round(o.totalRobux).toLocaleString('en-US')) : usd(o.total); }
  function fmtDate(d) { return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtDateTime(d) { return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  // A <input type="datetime-local">'s .value is always local wall-clock
  // time with no timezone info attached - the browser applies zero
  // conversion. Feeding it .toISOString() (always UTC) mislabels a UTC
  // instant as if it were already local, off by the admin's own UTC
  // offset; saving that value back then genuinely (and correctly)
  // interprets it as local and converts to UTC again, drifting the
  // stored instant by the offset on every single save. Building the
  // string from the Date's own local getters instead is what actually
  // round-trips.
  function toDatetimeLocalValue(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // AdBlox's /servers and /logs endpoints return timestamps with no
  // timezone designator (e.g. "2026-08-12T14:25:15.268322"), even though
  // the account itself is UTC (confirmed via /stats, which does include an
  // explicit +00:00 on the same kind of field). Per the JS Date spec, a
  // date-time string with no offset parses as LOCAL time, not UTC - so
  // without this, every AdBlox time shown here was off by the browser's
  // UTC offset. Appending Z (only if nothing's there already) fixes the
  // parse without touching fields that already carry a real offset.
  function parseAdbloxUtc(s) {
    return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
  }
  function daysAgo(n) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; }
  function $(id) { return document.getElementById(id); }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }

  // .adm-row-menu-list (the ⋮ action menu on order/user rows) is
  // position:absolute inside a table wrapped in .dash-tablewrap, which
  // sets overflow-x:auto - and per the CSS overflow spec, setting only
  // overflow-x to a non-visible value forces the browser to compute
  // overflow-y as auto too, so the wrapper clips vertically as well. Any
  // row past the wrapper's visible height opened a menu that was clipped
  // right where its background should have painted, reading as
  // transparent. Portals the menu to <body> as position:fixed while open,
  // positioned from the trigger button's real screen coordinates, and
  // puts it back exactly where it came from on close - same technique the
  // mobile shop filter sheet already uses for the same class of problem.
  function closeAllRowMenus() {
    document.querySelectorAll('.adm-row-menu.open').forEach(function (m) { m.classList.remove('open'); });
    // NOT m.querySelector('.adm-row-menu-list') per menu - while open, the
    // list has been moved (portaled) to <body> by openRowMenu below, so
    // it's no longer a descendant of its .adm-row-menu wrapper at all.
    // Querying for it as a child silently found nothing, so the
    // hide/restore step below never ran on ANY close attempt once a menu
    // had been portaled even once - only the wrapper's 'open' class (a
    // cosmetic hover-state thing) actually came off. The list itself
    // stayed visible at its fixed screen position forever, which is what
    // "can't click off it, stays stuck open" actually was: every call to
    // this function, from every close path (outside click, action taken,
    // opening a different row), looked like it worked but silently did
    // nothing to the thing actually on screen. Iterating every currently-
    // visible list directly (wherever it now lives) and restoring it via
    // its own __ownerMenu back-reference (set in openRowMenu) instead of
    // trying to find it as a child fixes every one of those paths at once.
    document.querySelectorAll('.adm-row-menu-list').forEach(function (list) {
      if (list.hidden) return;
      list.hidden = true;
      list.removeAttribute('style');
      var owner = list.__ownerMenu;
      if (owner && owner.__rmHome) {
        owner.__rmHome.insertBefore(list, owner.__rmHomeNext);
        owner.__rmHome = null;
        owner.__rmHomeNext = null;
      }
    });
  }
  function openRowMenu(menu) {
    closeAllRowMenus();
    var btn = menu.querySelector('.adm-row-menu-btn');
    var list = menu.querySelector('.adm-row-menu-list');
    if (!btn || !list) return;
    menu.__rmHome = list.parentNode;
    menu.__rmHomeNext = list.nextSibling;
    list.__ownerMenu = menu;
    list.hidden = false;
    document.body.appendChild(list);
    var r = btn.getBoundingClientRect();
    var listW = list.offsetWidth || 180;
    var left = Math.max(8, Math.min(r.right - listW, window.innerWidth - listW - 8));
    var top = Math.min(r.bottom + 6, window.innerHeight - list.offsetHeight - 8);
    // right:auto is required, not decorative - .adm-row-menu-list's own CSS
    // sets right:0 for its normal (non-portaled) absolute position, and this
    // cssText assignment only overrides position/top/left. Left unset, that
    // leftover right:0 stretches the fixed-position box all the way to the
    // viewport's right edge with no explicit width - it becomes enormous
    // (looks like a plain rectangle) and, since it's real and clickable, ANY
    // "outside" click still lands inside .adm-row-menu-list and the
    // click-outside handler's closest() check sees it as an inside click
    // and never closes the menu.
    list.style.cssText = 'position:fixed; z-index:250; top:' + top + 'px; left:' + left + 'px; right:auto;';
    menu.classList.add('open');
  }
  // Every panel's own click listener (orders/users rows) only ever
  // reacts to clicks that land on ITS menu's trigger or items, then returns
  // without touching anything else - there was no handler anywhere that
  // closed an open menu on a genuine click elsewhere on the page, so once
  // opened it stayed open (and, since the list is portaled to <body> while
  // open, kept intercepting clicks) until something else happened to call
  // closeAllRowMenus. One global listener for the actual "outside" case.
  document.addEventListener('click', function (e) {
    if (e.target.closest('.adm-row-menu-btn') || e.target.closest('.adm-row-menu-list')) return;
    closeAllRowMenus();
  });

  // supabase-js's functions.invoke() does NOT put the parsed JSON body
  // into res.data on a non-2xx response - res.data is null and res.error
  // is a generic FunctionsHttpError whose .message is always literally
  // "Edge Function returned a non-2xx status code". The real error body
  // has to be read from res.error.context (the raw Response) instead, or
  // every custom error message from every admin Edge Function call gets
  // silently replaced by that one generic string. This wraps
  // functions.invoke() so every call site gets the real message.
  function logFnError(name, msg, status) {
    if (window.coldAuth && window.coldAuth.logClientError) {
      window.coldAuth.logClientError('edge_function', msg, null, { fnName: name, context: { status: status } });
    }
  }
  function invokeAdminFn(name, body, fallback) {
    return window.coldSupabase.functions.invoke(name, { body: body || {} }).then(function (res) {
      if (res.error) {
        var ctx = res.error.context;
        var parsed = (ctx && typeof ctx.json === 'function') ? ctx.json().catch(function () { return null; }) : Promise.resolve(null);
        return parsed.then(function (data) {
          var msg = (data && data.error) || res.error.message || fallback || 'Request failed.';
          logFnError(name, msg, ctx && ctx.status);
          var e = new Error(msg);
          // Some functions (admin-adblox-stats) flag a 429 from the
          // upstream API explicitly, distinct from any other failure, so
          // a caller polling on an interval can back off instead of
          // hammering an API that just told it to slow down.
          if (data && data.rateLimited) e.rateLimited = true;
          throw e;
        });
      }
      if (!res.data || !res.data.ok) {
        var failMsg = (res.data && res.data.error) || fallback || 'Request failed.';
        logFnError(name, failMsg);
        var e2 = new Error(failMsg);
        if (res.data && res.data.rateLimited) e2.rateLimited = true;
        throw e2;
      }
      return res.data;
    });
  }

  function lsGet(k, fallback) {
    try { var v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function seedIfEmpty(key, gen) {
    var existing = null;
    try { existing = localStorage.getItem(key); } catch (_) {}
    if (existing != null) return lsGet(key, []);
    var data = gen();
    lsSet(key, data);
    return data;
  }

  /* ================================================================
     LIVE DATA - users, referrals, traffic, and abandoned carts below
     are all read from Supabase (see refreshUsers/refreshAdminReferrals/
     refreshTraffic/refreshAbandoned), same as Orders/Coupons/Reviews/
     Roblox containers/Posts/Staff. lsGet/lsSet now only persist
     harmless per-browser UI prefs (sort order, date-range selector),
     not the panel data itself.
     ================================================================ */
  var CATALOG = window.__CATALOG || [];

  // Real data from public.profiles, read via the signed-in admin's own
  // session (RLS: profiles_select_admin lets is_admin=true profiles see
  // every profile, not just their own). Writes (ban/unban) go through
  // admin-set-user-banned (service role, re-checks is_admin server-side).
  var USERS = [];
  function mapProfileRow(row) {
    return {
      id: row.id,
      name: row.username || (row.email ? row.email.split('@')[0] : 'user'),
      email: row.email || '',
      joined: row.created_at || new Date().toISOString(),
      status: row.banned ? 'banned' : 'active',
      banReason: row.ban_reason || null,
      isAdmin: !!row.is_admin,
      discordId: row.discord_id || null,
      robloxId: row.roblox_id || null,
      role: row.role || (row.is_admin ? 'admin' : 'customer'),
      emailVerified: !!row.email_verified,
      marketingUnsubscribed: !!row.marketing_unsubscribed,
      referralCode: row.referral_code || null
    };
  }
  function refreshUsers() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load users:', res.error.message); return; }
      USERS = (res.data || []).map(mapProfileRow);
      if (curPanel === 'sitemgmt') renderUsers();
      try { populateTesterOptions(); } catch (e) {}
    });
  }

  // Real data from public.coupons, read via the signed-in admin's own
  // session (RLS: coupons_select_admin). Writes go through
  // admin-upsert-coupon / admin-delete-coupon (service role).
  var COUPONS = [];
  function mapCouponRow(row) {
    return {
      code: row.code,
      type: row.type,
      val: Number(row.val) || 0,
      active: !!row.active,
      limit: row.usage_limit,
      usageCount: row.usage_count || 0,
      expiresAt: row.expires_at,
      scope: row.scope,
      platform: row.platform,
      category: row.category
    };
  }
  function refreshCoupons() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('coupons').select('*').order('code').then(function (res) {
      if (res.error) { console.error('[admin] failed to load coupons:', res.error.message); return; }
      COUPONS = (res.data || []).map(mapCouponRow);
      if (curPanel === 'sales') { renderEvents(); renderCoupons(); }
    });
  }

  // Sale Events replace the site's hardcoded "Spring Sale" announcement
  // banner with real admin-managed data - the
  // seed below matches that banner's original copy so nothing visually
  // changes until an admin edits or adds an event.
  var SALE_EVENTS = [];
  function mapSaleEventRow(row) {
    return Object.assign({ id: row.id, slug: row.slug, active: row.visible }, row.data || {});
  }
  function refreshSaleEvents() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('content').select('*').eq('type', 'sale_event').order('created_at', { ascending: false }).then(function (res) {
      if (res.error) { console.error('[admin] failed to load sale events:', res.error.message); return; }
      SALE_EVENTS = (res.data || []).map(mapSaleEventRow);
      if (curPanel === 'sales') renderEvents();
    });
  }

  // Real data from public.profiles (is_admin=true) - the same flag every
  // admin-* Edge Function checks server-side, not separate mock data.
  var STAFF = [];
  function refreshStaff() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('profiles').select('id, username, email, discord_id, role').eq('is_admin', true).then(function (res) {
      if (res.error) { console.error('[admin] failed to load staff:', res.error.message); return; }
      STAFF = (res.data || []).map(function (p) {
        return { id: p.id, name: p.username || (p.email ? p.email.split('@')[0] : 'user'), email: p.email, discordId: p.discord_id, role: p.role || 'admin' };
      });
      if (curPanel === 'sitemgmt') renderStaff();
    });
  }

  // Real data from public.profiles (referral_code) and public.orders
  // (referrer_id/ref_product_slug, set at checkout - see
  // _shared/referrals.ts), read via the signed-in admin's own session.
  // Referrals are per-product only: an order only counts if its
  // ref_product_slug matches one of its own order_items, and only that
  // line item's price earns 20% - never the rest of the cart. Earnings
  // are computed client-side as a display aggregate, not a ledger - the
  // actual source of truth for payouts is referral_payouts.
  var REFERRALS = [];
  function refreshAdminReferrals() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('profiles').select('id, username, email, referral_code').limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load referrals:', res.error.message); return; }
      var rows = res.data || [];
      var referrers = rows.filter(function (p) { return p.referral_code; });
      return window.coldSupabase.from('orders')
        .select('referrer_id, ref_product_slug, status, order_items(product_slug, unit_price_usd, qty)')
        .not('referrer_id', 'is', null).limit(20000).then(function (orderRes) {
        var refOrders = orderRes.data || [];
        return window.coldSupabase.from('referral_payouts').select('user_id, amount_usd, status').limit(20000).then(function (payRes) {
          var paidByUser = {};
          (payRes.data || []).forEach(function (pay) {
            if (pay.status !== 'paid') return;
            paidByUser[pay.user_id] = (paidByUser[pay.user_id] || 0) + Number(pay.amount_usd || 0);
          });
          REFERRALS = referrers.map(function (r) {
            var sales = 0;
            var earnedUSD = 0;
            refOrders.forEach(function (o) {
              if (o.referrer_id !== r.id || o.status !== 'paid') return;
              var match = (o.order_items || []).filter(function (it) { return it.product_slug === o.ref_product_slug; })[0];
              if (!match) return;
              sales++;
              earnedUSD += Number(match.unit_price_usd || 0) * match.qty * 0.2;
            });
            return {
              ownerId: r.id,
              code: r.referral_code,
              owner: r.username || (r.email ? r.email.split('@')[0] : 'user'),
              sales: sales,
              earnedUSD: Math.round(earnedUSD * 100) / 100,
              paidUSD: Math.round((paidByUser[r.id] || 0) * 100) / 100
            };
          });
          if (curPanel === 'analytics') renderAnalytics();
          if (curPanel === 'marketing') renderMarketing();
        });
      });
    });
  }

  var PAYOUTS = [];
  function refreshPayouts() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('referral_payouts').select('*').order('requested_at', { ascending: false }).limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load payouts:', res.error.message); return; }
      var rows = res.data || [];
      var userIds = rows.map(function (p) { return p.user_id; }).filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
      function apply(byId) {
        PAYOUTS = rows.map(function (p) {
          var prof = byId[p.user_id];
          return Object.assign({ owner: prof ? (prof.username || prof.email || 'user') : 'user' }, p);
        });
        if (curPanel === 'analytics') renderPayouts();
        if (curPanel === 'home') renderHome();
      }
      if (!userIds.length) { apply({}); return; }
      return window.coldSupabase.from('profiles').select('id,username,email').in('id', userIds).then(function (pRes) {
        var byId = {};
        (pRes.data || []).forEach(function (p) { byId[p.id] = p; });
        apply(byId);
      });
    });
  }
  // Total earned-but-unpaid commission across every 'requested' payout,
  // converted to a single USD figure (robux via the real DevEx rate, same
  // as everywhere else money gets compared across currencies) so it can be
  // shown as one AUD number. store_credit counts too - it's commission
  // already earned and awaiting fulfillment, not yet a null cost just
  // because it isn't a bank transfer.
  function referralsOwedInfo() {
    var requested = PAYOUTS.filter(function (p) { return p.status === 'requested'; });
    var usdTotal = requested.reduce(function (sum, p) {
      return sum + (p.method === 'robux' ? (p.amount_robux || 0) * DEVEX_USD_PER_ROBUX : (p.amount_usd || 0));
    }, 0);
    var names = requested.map(function (p) { return p.owner; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; });
    return { usdTotal: usdTotal, count: requested.length, names: names };
  }
  function renderPayouts() {
    var el = $('admPayoutsBody'); if (!el) return;
    el.innerHTML = PAYOUTS.map(function (p) {
      var amount = p.method === 'robux' ? (Math.round(p.amount_robux || 0) + ' R$') : usd(p.amount_usd || 0);
      var method = p.method === 'usd' ? 'USD' : p.method === 'robux' ? 'Robux' : 'Store credit';
      var status = p.status === 'paid' ? '<span class="dt-badge ok">Paid</span>' : p.status === 'denied' ? '<span class="dt-badge err">Denied</span>' : '<span class="dt-badge warn">Requested</span>';
      var actions = p.status === 'requested' && can('admin')
        ? '<button class="btn btn-ghost adm-btn-sm adm-payout-paid" type="button">Mark paid</button><button class="btn btn-ghost adm-btn-sm adm-payout-deny" type="button">Deny</button>'
        : '';
      return '<tr data-id="' + p.id + '"><td>' + fmtDateTime(new Date(p.requested_at)) + '</td><td>' + esc(p.owner) + '</td><td>' + method + '</td><td>' + amount + '</td><td>' + status + '</td><td class="adm-row-actions">' + actions + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="adm-empty">No payout requests yet.</td></tr>';
  }
  function callManageReferralPayout(id, action) {
    return invokeAdminFn('admin-manage-referral-payout', { id: id, action: action }, 'Could not update payout.');
  }
  var payoutsBody = $('admPayoutsBody');
  if (payoutsBody) payoutsBody.addEventListener('click', async function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var p = PAYOUTS.filter(function (x) { return x.id === id; })[0]; if (!p) return;
    if (!can('admin')) return;
    if (e.target.classList.contains('adm-payout-paid')) {
      if (!(await dialogConfirm('Mark this payout as sent to ' + p.owner + '?', { title: 'Mark payout as paid', acceptLabel: 'Mark paid' }))) return;
      callManageReferralPayout(id, 'mark_paid')
        .then(function () { logAudit('Marked referral payout to ' + p.owner + ' as paid'); return Promise.all([refreshPayouts(), refreshAdminReferrals()]); })
        .catch(function (err) { alert(err.message || 'Could not update payout.'); });
    } else if (e.target.classList.contains('adm-payout-deny')) {
      if (!(await dialogConfirm('Deny this payout request from ' + p.owner + '?', { title: 'Deny payout', acceptLabel: 'Deny payout' }))) return;
      callManageReferralPayout(id, 'deny')
        .then(function () { logAudit('Denied referral payout request from ' + p.owner); return refreshPayouts(); })
        .catch(function (err) { alert(err.message || 'Could not update payout.'); });
    }
  });

  // Real data from public.orders/order_items, read via the signed-in
  // admin's own session (RLS: orders_select_admin / order_items_select_admin
  // let is_admin=true profiles see every order, not just their own).
  // profiles are fetched separately (orders.user_id references auth.users,
  // not public.profiles, so PostgREST can't embed it directly) via
  // profiles_select_admin. Writes (complete/refund) go through the
  // admin-manage-order Edge Function (service role) - never written
  // directly from here.
  var ORDERS = [];
  // Flips true the first time refreshOrders() settles (success or error).
  // Until then the stat panels render a "Loading…" placeholder instead of
  // computing every figure from an empty ORDERS array and painting a
  // misleading 0 that only "fixes itself" once the fetch lands.
  var ORDERS_LOADED = false;
  function mapOrderRow(row, profile) {
    var items = row.order_items || [];
    var first = items[0] || {};
    var product = first.product_slug ? findProduct(first.product_slug) : null;
    var status = row.status === 'paid' ? 'completed' : (row.status === 'failed' || row.status === 'canceled') ? 'failed' : row.status;
    return {
      id: row.id,
      dbId: row.id,
      date: row.created_at,
      paidAt: row.paid_at || null,
      userId: row.user_id,
      userName: profile ? (profile.username || profile.email || 'user') : 'guest',
      userEmail: profile ? (profile.email || null) : null,
      productId: first.product_slug || null,
      title: items.length > 1 ? (first.title + ' +' + (items.length - 1) + ' more') : (first.title || 'Unknown item'),
      image: product ? product.image : '',
      cat: product ? product.cat : null,
      platform: product ? product.platform : null,
      licence: first.licence || 'standard',
      qty: items.reduce(function (s, it) { return s + (it.qty || 1); }, 0),
      unitPrice: Number(first.unit_price_usd) || 0,
      subtotal: Number(row.subtotal_usd) || 0,
      couponCode: row.coupon_code || null,
      discount: Number(row.discount_usd) || 0,
      total: Number(row.total_usd) || 0,
      totalRobux: Number(row.total_robux) || 0,
      currency: row.currency || 'usd',
      status: status,
      refCode: null,
      refundReason: row.refund_reason || null,
      stripePaymentIntentId: row.stripe_payment_intent_id,
      stripeCheckoutSessionId: row.stripe_checkout_session_id,
      paymentProvider: row.payment_provider || null,
      paypalOrderId: row.paypal_order_id || null,
      paypalCaptureId: row.paypal_capture_id || null,
      cryptoProvider: row.crypto_provider || null,
      cryptoChargeId: row.crypto_charge_id || null,
      cryptoPaymentId: row.crypto_payment_id || null,
      externalTransactionId: row.external_transaction_id || null,
      robloxGamepassId: row.roblox_gamepass_id || null,
      robloxBuyerId: row.roblox_buyer_id || null,
      robloxVerificationMethod: row.roblox_verification_method || null,
      source: row.source || 'website',
      // Real customer-to-customer gift (buyer paid, order was assigned to a
      // different user_id) - not to be confused with source:'granted' above,
      // which is the admin-tool free comp. purchased_by_user_id is only
      // ever set for a genuine paid gift order.
      purchasedByUserId: row.purchased_by_user_id || null,
      items: items
    };
  }
  function refreshOrders() {
    if (!window.coldSupabase) return Promise.resolve();
    // Excludes 'parcel'/'robux' source rows - synthetic order records the
    // reverted Roblox group-revenue-sync feature wrote during testing (see
    // supabase/roblox_group_sync_teardown.sql, which deleted the ones that
    // had already accumulated). Belt-and-suspenders: keeps this list real
    // even if that function is ever re-invoked without being re-enabled here.
    return window.coldSupabase.from('orders').select('*, order_items(*)').not('source', 'in', '("parcel","robux")').order('created_at', { ascending: false }).limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load orders:', res.error.message); ORDERS_LOADED = true; renderAll(); return; }
      var rows = res.data || [];
      var userIds = rows.map(function (o) { return o.user_id; }).filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
      if (!userIds.length) {
        ORDERS = rows.map(function (o) { return mapOrderRow(o, null); });
        ORDERS_LOADED = true;
        renderAll();
        return;
      }
      return window.coldSupabase.from('profiles').select('id,username,email').in('id', userIds).then(function (pRes) {
        var byId = {};
        (pRes.data || []).forEach(function (p) { byId[p.id] = p; });
        ORDERS = rows.map(function (o) { return mapOrderRow(o, byId[o.user_id]); });
        ORDERS_LOADED = true;
        renderAll();
      });
    });
  }
  function callManageOrder(orderId, action, reason) {
    var body = { orderId: orderId, action: action };
    if (reason) body.reason = reason;
    return invokeAdminFn('admin-manage-order', body);
  }

  // Real data from public.reviews, read via the signed-in admin's own
  // session (RLS: reviews_select_admin). Writes (hide/reply/seen) go
  // through admin-moderate-review (service role).
  var REVIEWS = [];
  function mapReviewRow(row, profile) {
    return {
      id: row.id,
      dbId: row.id,
      productId: row.products ? row.products.slug : null,
      productTitle: row.products ? row.products.title : 'Unknown product',
      user: profile ? (profile.username || profile.email || 'user') : 'user',
      stars: row.stars,
      text: row.text,
      date: row.created_at,
      status: row.status,
      adminReviewedAt: row.admin_reviewed_at,
      reply: row.reply ? { text: row.reply, date: row.reply_at } : null
    };
  }
  function refreshReviews() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('reviews').select('*, products(title, slug)').order('created_at', { ascending: false }).limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load reviews:', res.error.message); return; }
      var rows = res.data || [];
      var userIds = rows.map(function (r) { return r.user_id; }).filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
      function apply(byId) {
        REVIEWS = rows.map(function (r) { return mapReviewRow(r, byId[r.user_id]); });
        if (curPanel === 'reviews') renderReviews();
        if (curPanel === 'home') renderHome();
      }
      if (!userIds.length) { apply({}); return; }
      return window.coldSupabase.from('profiles').select('id,username,email').in('id', userIds).then(function (pRes) {
        var byId = {};
        (pRes.data || []).forEach(function (p) { byId[p.id] = p; });
        apply(byId);
      });
    });
  }
  function callModerateReview(id, action, reply) {
    var body = { id: id, action: action };
    if (reply != null) body.reply = reply;
    return invokeAdminFn('admin-moderate-review', body, 'Could not update review.');
  }

  // Real data from public.page_views (a row per page load, no PII - see
  // catalog.js's trackPageview beacon), read via the signed-in admin's own
  // session (RLS: page_views_select_admin). Grouped into one {date,
  // sessions, pageviews} bucket per day client-side.
  var TRAFFIC = [];
  var TRAFFIC_PAGES = [];   // [{ path, views, sessions }] over the 120d pull, top first
  var TOP_PAGES_OPEN = false, ABANDONED_OPEN = false;
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#admTopPagesMore, #admAbandonedMore') : null;
    if (!t) return;
    if (t.id === 'admTopPagesMore') TOP_PAGES_OPEN = !TOP_PAGES_OPEN; else ABANDONED_OPEN = !ABANDONED_OPEN;
    renderAnalytics();
  });
  var TRAFFIC_VISITORS = null; // { total, returning, rate } over the 120d pull
  var TRAFFIC_ROWS = [];    // [{ s: session_id, p: path, d: created_at }] - for the range-aware funnel
  // Pages that are not storefront traffic: the admin panel itself, sign-in and
  // OAuth callback plumbing, the maintenance gate. Dropped from every traffic
  // figure so analytics describe real visitors, not staff and redirects.
  var INTERNAL_PATH_RE = /^\/(admin|lock|callback|roblox-callback|tiktok-callback|youtube-callback|signin|signup|forgot|reset)(\/|\.html|$)/i;
  function normPath(p) { p = String(p || '/').split('?')[0].split('#')[0]; if (p.length > 1) p = p.replace(/\/+$/, ''); return p || '/'; }
  function isInternalPath(p) { return INTERNAL_PATH_RE.test(normPath(p)); }
  function refreshTraffic() {
    if (!window.coldSupabase) return Promise.resolve();
    var cutoff = daysAgo(119).toISOString();
    return window.coldSupabase.from('page_views').select('session_id, created_at, path, visitor_id').gte('created_at', cutoff).limit(50000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load traffic:', res.error.message); return; }
      var trafficData = (res.data || []).filter(function (r) { return !isInternalPath(r.path); });
      TRAFFIC_ROWS = trafficData.map(function (r) { return { s: r.session_id, p: normPath(r.path), d: r.created_at }; });
      var byDay = {}, byPath = {}, visitorDays = {};
      trafficData.forEach(function (row) {
        var day = row.created_at.slice(0, 10);
        if (!byDay[day]) byDay[day] = { pageviews: 0, sessions: {} };
        byDay[day].pageviews++;
        byDay[day].sessions[row.session_id] = true;
        var p = normPath(row.path);
        if (!byPath[p]) byPath[p] = { path: p, views: 0, sessions: {} };
        byPath[p].views++;
        byPath[p].sessions[row.session_id] = true;
        if (row.visitor_id) {
          if (!visitorDays[row.visitor_id]) visitorDays[row.visitor_id] = {};
          visitorDays[row.visitor_id][day] = true;
        }
      });
      var out = [];
      for (var d = 119; d >= 0; d--) {
        var iso = daysAgo(d).toISOString();
        var key = iso.slice(0, 10);
        var bucket = byDay[key];
        out.push({ date: iso, sessions: bucket ? Object.keys(bucket.sessions).length : 0, pageviews: bucket ? bucket.pageviews : 0 });
      }
      TRAFFIC = out;
      TRAFFIC_PAGES = Object.keys(byPath).map(function (k) {
        return { path: byPath[k].path, views: byPath[k].views, sessions: Object.keys(byPath[k].sessions).length };
      }).sort(function (a, b) { return b.views - a.views; });
      var vids = Object.keys(visitorDays);
      var returning = vids.filter(function (v) { return Object.keys(visitorDays[v]).length > 1; }).length;
      TRAFFIC_VISITORS = vids.length ? { total: vids.length, returning: returning, rate: returning / vids.length * 100 } : null;
      if (curPanel === 'analytics') renderAnalytics();
    if (curPanel === 'marketing') renderMarketing();
      if (curPanel === 'home') renderHome();
    });
  }

  // Funnel + on-site search, from public.client_events (add_to_cart /
  // checkout_started / search - written by track-event). Same 120-day
  // window as traffic; the render filters to the active range.
  var CLIENT_EVENT_ROWS = [];
  function refreshClientEvents() {
    if (!window.coldSupabase) return Promise.resolve();
    var cutoff = daysAgo(119).toISOString();
    return window.coldSupabase.from('client_events').select('type, session_id, meta, created_at').gte('created_at', cutoff).limit(50000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load client events:', res.error.message); return; }
      CLIENT_EVENT_ROWS = (res.data || []).map(function (r) { return { type: r.type, s: r.session_id, meta: r.meta || {}, d: r.created_at }; });
      if (curPanel === 'analytics') renderAnalytics();
    });
  }

  var LIVE_SESSIONS = 0;
  function refreshLiveSessions() {
    if (!window.coldSupabase) return Promise.resolve();
    var cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    return window.coldSupabase.from('page_views').select('session_id, path').gte('created_at', cutoff).limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load live sessions:', res.error.message); return; }
      var set = {}; (res.data || []).forEach(function (r) { if (!isInternalPath(r.path)) set[r.session_id] = true; });
      LIVE_SESSIONS = Object.keys(set).length;
      if (curPanel === 'home') renderHome();
      if (curPanel === 'analytics') renderAnalytics();
    if (curPanel === 'marketing') renderMarketing();
    });
  }

  var DISCORD_STATS = { memberCount: null, onlineCount: null, history: [] };
  function refreshDiscordStats() {
    return invokeAdminFn('admin-discord-stats', {}, 'Could not load Discord stats.').then(function (data) {
      DISCORD_STATS = { memberCount: data.memberCount, onlineCount: data.onlineCount, history: data.history || [] };
      if (curPanel === 'home') renderHome();
      if (curPanel === 'analytics') renderAnalytics();
    if (curPanel === 'marketing') renderMarketing();
    }).catch(function (err) { console.error('[admin] discord stats:', err.message); });
  }
  // Net members gained/lost over the selected range. Discord's API has no
  // history of its own - only the current total - so this diffs against
  // our own daily snapshots (discord_member_snapshots). When the range
  // starts before our earliest snapshot, it falls back to that earliest
  // snapshot and flags the result `partial` so the label can say "since
  // <date>" instead of pretending to cover the whole range.
  // Returns { joins, sinceKey, partial } or null when there's no history
  // at all yet.
  function discordJoinsInRange() {
    var hist = DISCORD_STATS.history || [];
    if (DISCORD_STATS.memberCount == null || !hist.length) return null;
    var startKey = (RANGE_DAYS ? rangeStart() : new Date(hist[0].snapshot_date)).toISOString().slice(0, 10);
    var baseline = null, baseKey = null;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].snapshot_date <= startKey) { baseline = hist[i].member_count; baseKey = hist[i].snapshot_date; }
      else break;
    }
    var partial = false;
    if (baseline == null) { baseline = hist[0].member_count; baseKey = hist[0].snapshot_date; partial = RANGE_DAYS ? true : false; }
    return { joins: DISCORD_STATS.memberCount - baseline, sinceKey: baseKey, partial: partial };
  }

  var ADBLOX_STATS = null;
  var ADBLOX_ERROR = null;
  var ADBLOX_SERVERS = [];
  var ADBLOX_LOGS = [];
  var ADBLOX_NEXT_CURSOR = null;
  // AdBlox's documented budget is 60 requests/minute per API key
  // (docs.adblox.xyz/errors-and-rate-limits), shared across every
  // endpoint - this one call already spends 3 of that (stats+servers+
  // logs via Promise.all server-side). ADBLOX_COOLDOWN_UNTIL backs the
  // auto-refresh interval off for a minute if AdBlox ever actually
  // returns a 429 (e.g. a second admin tab polling at the same time),
  // instead of wiping the last-good numbers or immediately retrying
  // into the same limit.
  var ADBLOX_COOLDOWN_UNTIL = 0;
  var ADBLOX_STAT_PREV = null; // {today,last7d,last30d,allTime} from the last render, or null before the first one
  function refreshAdbloxStats() {
    return invokeAdminFn('admin-adblox-stats', {}, 'Could not load AdBlox stats.').then(function (data) {
      ADBLOX_STATS = data; ADBLOX_ERROR = null;
      ADBLOX_SERVERS = data.servers || [];
      ADBLOX_LOGS = data.logs || [];
      ADBLOX_NEXT_CURSOR = data.nextLogCursor || null;
      if (curPanel === 'marketing') renderMarketing();
    }).catch(function (err) {
      if (err.rateLimited) {
        ADBLOX_COOLDOWN_UNTIL = Date.now() + 60000;
        ADBLOX_ERROR = 'AdBlox rate limit hit - showing the last numbers pulled, will retry automatically.';
      } else {
        ADBLOX_STATS = null; ADBLOX_ERROR = err.message;
        ADBLOX_SERVERS = []; ADBLOX_LOGS = []; ADBLOX_NEXT_CURSOR = null;
      }
      if (curPanel === 'marketing') renderMarketing();
    });
  }
  var adbloxRefreshBtn = $('admAdbloxRefresh');
  if (adbloxRefreshBtn) adbloxRefreshBtn.addEventListener('click', function () {
    var label = adbloxRefreshBtn.querySelector('.btn-label'), spinner = adbloxRefreshBtn.querySelector('.btn-spinner');
    adbloxRefreshBtn.disabled = true; if (label) label.hidden = true; if (spinner) spinner.hidden = false;
    refreshAdbloxStats().then(function () {
      adbloxRefreshBtn.disabled = false; if (label) label.hidden = false; if (spinner) spinner.hidden = true;
    });
  });
  // Appends the next page of the audit log rather than replacing it, so
  // "Load more" grows the table instead of resetting scroll position.
  function loadMoreAdbloxLogs() {
    if (!ADBLOX_NEXT_CURSOR) return Promise.resolve();
    return invokeAdminFn('admin-adblox-stats', { logCursor: ADBLOX_NEXT_CURSOR }, 'Could not load more activity.').then(function (data) {
      ADBLOX_LOGS = ADBLOX_LOGS.concat(data.logs || []);
      ADBLOX_NEXT_CURSOR = data.nextLogCursor || null;
      if (curPanel === 'marketing') renderMarketing();
    });
  }

  // Real data from public.cart_snapshots - a row per checkout-page visit
  // with items in cart, deleted the moment an order actually gets created
  // (see app.js's deleteCartSnapshot()). Anything still here is, by
  // definition, an abandoned cart.
  var ABANDONED = [];
  function refreshAbandoned() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('cart_snapshots').select('*').order('updated_at', { ascending: false }).limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load abandoned carts:', res.error.message); return; }
      ABANDONED = (res.data || []).map(function (row) {
        var items = row.items || [];
        var first = items[0] || {};
        var title = items.length > 1 ? ((first.title || 'Item') + ' +' + (items.length - 1) + ' more') : (first.title || 'Unknown item');
        return {
          id: row.session_id, date: row.updated_at, title: title, image: first.image || '', value: Number(row.value_usd) || 0, email: row.email || null,
          // Added for the account-detail modal's cart activity section -
          // existing callers only ever read the fields above, so this is
          // purely additive.
          userId: row.user_id || null,
          items: items,
          abandonedStep: row.abandoned_step_sent != null ? row.abandoned_step_sent : null,
          recoveryEmailSentAt: row.abandoned_email_sent_at || null
        };
      });
      if (curPanel === 'analytics') renderAnalytics();
    if (curPanel === 'marketing') renderMarketing();
    });
  }

  // Real data from public.admin_audit_log (see supabase/admin_audit_log.sql)
  // - shared across every admin's browser, not per-device localStorage.
  var AUDIT = [];
  var AUDIT_PERSIST_ERROR = null;

  function logAudit(action) {
    var entry = { ts: new Date().toISOString(), actor: currentRole().name, action: action };
    AUDIT.unshift(entry);
    if (AUDIT.length > 300) AUDIT.length = 300;
    if (curPanel === 'sitemgmt') renderAudit();
    window.coldSupabase.from('admin_audit_log').insert({
      actor_id: ADMIN.id, actor_name: entry.actor, action: action
    }).then(function (res) {
      if (res.error) {
        console.error('[logAudit] failed to persist:', res.error.message);
        // Silently falling back to the in-memory copy is how this ends up
        // looking like a session-only log: the entries are right there on
        // screen, they just evaporate on reload. Say so instead.
        AUDIT_PERSIST_ERROR = res.error.message || 'unknown error';
        if (curPanel === 'sitemgmt') renderAudit();
      }
    });
  }

  // client_errors rows (see supabase/client_errors.sql) merge into the
  // same feed as staff actions, sorted chronologically together - kind:
  // 'error' distinguishes them for rendering (a code badge instead of a
  // staff name, and a Details button that opens the full report).
  function refreshAuditLog() {
    return Promise.all([
      window.coldSupabase.from('admin_audit_log')
        .select('actor_name, action, created_at')
        .order('created_at', { ascending: false })
        .limit(300),
      window.coldSupabase.from('client_errors')
        .select('code, kind, message, stack, fn_name, page_url, user_agent, user_id, context, created_at')
        .order('created_at', { ascending: false })
        .limit(300)
    ]).then(function (results) {
      var auditRes = results[0], errRes = results[1];
      if (auditRes.error) {
        console.error('[refreshAuditLog] failed:', auditRes.error.message);
        AUDIT_PERSIST_ERROR = auditRes.error.message || 'unknown error';
        if (curPanel === 'sitemgmt') renderAudit();
        return;
      }
      AUDIT_PERSIST_ERROR = null;
      var staffRows = (auditRes.data || []).map(function (row) {
        return { ts: row.created_at, actor: row.actor_name, action: row.action, kind: 'staff' };
      });
      var errorRows = errRes.error ? [] : (errRes.data || []).map(function (row) {
        return {
          ts: row.created_at, kind: 'error', errKind: row.kind, code: row.code,
          action: row.message, fnName: row.fn_name, stack: row.stack,
          pageUrl: row.page_url, userAgent: row.user_agent, userId: row.user_id, context: row.context
        };
      });
      AUDIT = staffRows.concat(errorRows).sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
      if (curPanel === 'sitemgmt') renderAudit();
    });
  }

  /* ================================================================
     ROLE - real, from profiles.is_admin/role (ADMIN, resolved by the
     access gate above before boot() ever runs).
     ================================================================ */
  var ROLES = { owner: 3, admin: 2, support: 1 };
  function currentRole() { return { name: ADMIN.username || 'You', role: ADMIN.role || 'admin' }; }
  function can(minRole) { return ROLES[currentRole().role] >= ROLES[minRole]; }

  /* ================================================================
     PRODUCT VIEW MODEL - real data from public.products/product_legal,
     read via the signed-in admin's own session (RLS: products_select_admin
     / product_legal_select_admin let is_admin=true profiles see everything,
     not just is_active=true rows). Writes go through the admin-upsert-product
     / admin-delete-product Edge Functions (service role, re-checks is_admin
     server-side) - never written directly from here.
     ================================================================ */
  function defaultLegal() {
    return { tos: '', proofFiles: [], devProofFiles: [], contacts: [], licenseCost: 0, licenseCostCurrency: 'usd', licensePurchasedAt: '', minSaleUsd: 0, minSaleRobux: 0, maxDiscountPct: 0, canBeFree: false, disallowSales: false };
  }
  function toYouTubeEmbed(url) {
    url = (url || '').trim();
    if (!url) return '';
    var m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{6,})/);
    return m ? ('https://www.youtube.com/embed/' + m[1]) : url;
  }
  function defaultTech() {
    return { format: '', size: '', fileName: '', parts: '', meshParts: '', unions: '', scripts: '' };
  }
  function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }
  var PRODUCTS_CACHE = [];
  function mapProductRow(row) {
    var legalRaw = Array.isArray(row.product_legal) ? (row.product_legal[0] || {}) : (row.product_legal || {});
    return {
      id: row.slug,
      dbId: row.id,
      title: row.title,
      price: Number(row.price_usd) || 0,
      priceNum: Number(row.price_usd) || 0,
      cat: row.cat,
      subcat: row.subcat,
      desc: row.description || '',
      longDesc: row.long_description || '',
      image: window.imgUrl(row.image),
      gallery: row.gallery || [],
      video: row.video || '',
      resell: !!row.resell_available,
      resellPrice: row.resell_price_usd != null ? Number(row.resell_price_usd) : null,
      resellRobuxPrice: row.resell_robux_price != null ? Number(row.resell_robux_price) : null,
      robuxPrice: row.robux_price != null ? Number(row.robux_price) : null,
      wasPrice: row.was_price != null ? Number(row.was_price) : null,
      priority: !!row.priority,
      featured: !!row.featured,
      featuredOrder: Number(row.featured_order) || 0,
      weeklyDeal: !!row.weekly_deal,
      weeklyDealPct: row.weekly_deal_pct != null ? Number(row.weekly_deal_pct) : null,
      weeklyDealAuto: !!row.weekly_deal_auto,
      weeklyDealExcluded: !!row.weekly_deal_excluded,
      tech: Object.assign(defaultTech(), row.tech || {}),
      legal: Object.assign(defaultLegal(), {
        tos: legalRaw.tos, proofFiles: legalRaw.proof_files, devProofFiles: legalRaw.dev_proof_files,
        contacts: legalRaw.contacts, licenseCost: legalRaw.license_cost, licenseCostCurrency: legalRaw.license_cost_currency,
        licensePurchasedAt: legalRaw.license_purchased_at, minSaleUsd: legalRaw.min_sale_usd, minSaleRobux: legalRaw.min_sale_robux,
        maxDiscountPct: legalRaw.max_discount_pct,
        canBeFree: legalRaw.can_be_free, disallowSales: legalRaw.disallow_sales
      }),
      versions: row.versions || [],
      siteVersion: row.last_released_version || row.version || '',
      storagePath: row.storage_path || '',
      visible: !!row.is_active,
      platform: row.platform,
      page: row.page,
      createdAt: row.created_at || null,
      reviews: row.reviews_count || 0,
      rating: Number(row.rating) || 0
    };
  }
  function refreshProducts() {
    if (!window.coldSupabase) return Promise.resolve();
    // storage_path (the internal download path) isn't readable through the public
    // API, so '*' is out; admins get the paths from an admin-only RPC and merge them.
    var cols = 'id, slug, title, description, long_description, image, gallery, video, cat, subcat, platform, page, tech, price_usd, was_price, robux_price, resell_available, resell_price_usd, resell_robux_price, roblox_gamepass_id, roblox_universe_id, version, versions, changelog, last_released_version, featured, featured_order, priority, rating, reviews_count, is_active, weekly_deal, weekly_deal_auto, weekly_deal_excluded, weekly_deal_pct, created_at, updated_at, product_legal(*)';
    return Promise.all([
      window.coldSupabase.from('products').select(cols).order('title'),
      window.coldSupabase.rpc('admin_product_storage_paths')
    ]).then(function (both) {
      var res = both[0];
      if (res.error) { console.error('[admin] failed to load products:', res.error.message); return; }
      var paths = {};
      ((both[1] && !both[1].error && both[1].data) || []).forEach(function (r) { paths[r.id] = r.storage_path; });
      (res.data || []).forEach(function (r) { r.storage_path = paths[r.id] || ''; });
      PRODUCTS_CACHE = (res.data || []).map(mapProductRow);
      renderAll();
    });
  }
  function allProducts() { return PRODUCTS_CACHE; }
  function findProduct(id) { return allProducts().filter(function (p) { return p.id === id; })[0]; }

  // Builds the full admin-upsert-product payload from a product's current
  // view-model plus whatever's changing - the Edge Function replaces every
  // field on each call (it's a full upsert, not a patch), so every call site
  // must always send the complete current state, not just a delta.
  function upsertPayloadFor(p, overrides) {
    return Object.assign({
      id: p.dbId,
      title: p.title,
      platform: p.platform,
      price: p.priceNum,
      cat: p.cat,
      subcat: p.subcat,
      desc: p.desc,
      longDesc: p.longDesc,
      image: p.image,
      gallery: p.gallery,
      video: p.video,
      resell: p.resell,
      resellPrice: p.resellPrice,
      resellRobuxPrice: p.resellRobuxPrice,
      robuxPrice: p.robuxPrice,
      wasPrice: p.wasPrice,
      priority: p.priority,
      featured: p.featured,
      featuredOrder: p.featuredOrder,
      visible: p.visible,
      tech: p.tech,
      versions: p.versions,
      legal: p.legal
    }, overrides || {});
  }
  function callUpsertProduct(payload) {
    return invokeAdminFn('admin-upsert-product', payload, 'Save failed.');
  }
  function callDeleteProduct(dbId) {
    return invokeAdminFn('admin-delete-product', { id: dbId }, 'Delete failed.');
  }

  /* ================================================================
     PRODUCT LIST SORT (persisted across sessions, default newest)
     ================================================================ */
  var PROD_SORT = lsGet('coldd_admin_prod_sort_v1', 'newest');

  /* ================================================================
     DATE RANGE
     ================================================================ */
  var RANGE_DAYS = lsGet('coldd_admin_range_v1', 30); // 1, 7, 30, 90, 0(=all)
  function inRange(iso) {
    if (!RANGE_DAYS) return true;
    return new Date(iso) >= rangeStart();
  }
  function daysAgoStart(n) { var d = daysAgo(n - 1); d.setHours(0, 0, 0, 0); return d; }
  // Start of the active range. data-range=1 is a true rolling 24-hour
  // window (not "since local midnight"); every other value is N calendar
  // days back to local midnight.
  function rangeStart() {
    if (RANGE_DAYS === 1) return new Date(Date.now() - 24 * 60 * 60 * 1000);
    return daysAgoStart(RANGE_DAYS);
  }
  // The window immediately before the current range, same length - e.g.
  // for the last 7 days, this is the 7 days before that. No meaningful
  // comparison for "All time", so callers should skip % change there.
  function prevRangeWindow() {
    if (RANGE_DAYS === 1) {
      var now = Date.now();
      return { start: new Date(now - 48 * 60 * 60 * 1000), end: new Date(now - 24 * 60 * 60 * 1000) };
    }
    var n = RANGE_DAYS || 1;
    return { start: daysAgoStart(n * 2), end: daysAgoStart(n) };
  }
  function pctDelta(cur, prev) {
    if (!RANGE_DAYS) return '';
    if (!prev) return cur ? '<span class="ds-delta up">▲ New</span>' : '';
    var pct = ((cur - prev) / prev) * 100;
    var cls = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
    var arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '–';
    return '<span class="ds-delta ' + cls + '">' + arrow + ' ' + Math.abs(Math.round(pct * 10) / 10) + '%</span>';
  }
  function setRange(n) {
    RANGE_DAYS = n; lsSet('coldd_admin_range_v1', n);
    document.querySelectorAll('.adm-range button').forEach(function (b) { b.classList.toggle('active', +b.getAttribute('data-range') === n); });
    if (curPanel === 'analytics') renderAnalytics();
    if (curPanel === 'marketing') renderMarketing();
    if (curPanel === 'home') renderHome();
  }

  /* ================================================================
     CHART HELPER (inline SVG, no external deps)
     ================================================================ */
  // Round axis for the bar charts: about 4 steps on a 1/2/2.5/5 x 10^n scale, so
  // the numbers down the left are real values you can read each bar against.
  function niceScale(max) {
    if (!(max > 0)) return { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
    var raw = max / 4, pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / pow;
    var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
    var top = Math.ceil(max / step - 1e-9) * step, ticks = [];
    for (var t = 0; t <= top + step / 2; t += step) ticks.push(+t.toFixed(10));
    return { top: top, ticks: ticks };
  }
  function axisNum(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return Math.round(v / 1e3) + 'k';
    if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(+v.toFixed(2));
  }
  function axisUsd(v) { return '$' + axisNum(v); }
  function svgBars(data, opts) {
    opts = opts || {};
    var w = opts.width || 640, h = opts.height || 140;
    var rawMax = Math.max.apply(null, data.map(function (d) { return d.v; }).concat([0]));
    var sc = niceScale(rawMax);
    var fmt = opts.fmt || axisNum;
    var n = data.length || 1;
    var gap = 2;
    var bw = Math.max(1, (w / n) - gap);
    var grid = sc.ticks.map(function (t) {
      var y = h - (t / sc.top) * h;
      return '<line class="adm-chart-grid" x1="0" x2="' + w + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" vector-effect="non-scaling-stroke"></line>';
    }).join('');
    var bars = data.map(function (d, i) {
      var bh = Math.max(1.5, (d.v / sc.top) * h);
      var x = i * (w / n);
      var y = h - bh;
      var op = 0.42 + 0.58 * (rawMax ? d.v / rawMax : 0);
      var tipText = esc(d.label) + ': ' + esc(d.tip != null ? d.tip : d.v);
      return '<rect class="adm-chart-bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" fill="' + (opts.color || 'var(--accent)') + '" opacity="' + op.toFixed(2) + '" data-tip="' + tipText + '"></rect>';
    }).join('');
    var labels = sc.ticks.map(function (t) { return esc(fmt(t)); });
    var axisW = Math.max.apply(null, labels.map(function (l) { return l.length; })) + 1;
    var axis = sc.ticks.map(function (t, i) {
      return '<span style="bottom:' + (t / sc.top * 100).toFixed(2) + '%">' + labels[i] + '</span>';
    }).join('');
    var xl = (data.length > 1 && data[0].label)
      ? '<div class="adm-chart-x"><span>' + esc(data[0].label) + '</span><span>' + esc(data[data.length - 1].label) + '</span></div>' : '';
    return '<div class="adm-chart-wrap"><div class="adm-chart-axis" style="height:' + h + 'px;min-width:' + axisW + 'ch">' + axis + '</div>' +
      '<div class="adm-chart-main"><svg viewBox="0 0 ' + w + ' ' + h + '" class="adm-chart" style="height:' + h + 'px" preserveAspectRatio="none">' + grid + bars + '</svg>' + xl + '</div></div>';
  }

  // Donut / pie with a legend. segments: [{ label, value, color, display?,
  // tip? }] - `display` is trusted markup for the legend value cell,
  // `tip` overrides the hover text. Zero/negative segments are dropped.
  function donutChart(segments, opts) {
    opts = opts || {};
    segments = (segments || []).filter(function (s) { return s.value > 0; });
    var total = segments.reduce(function (a, s) { return a + s.value; }, 0);
    if (!total) return '<p class="adm-empty">No data in this range.</p>';
    var size = 168, c = size / 2, r = 64, sw = 28, circ = 2 * Math.PI * r, off = 0;
    var arcs = segments.map(function (s) {
      var dash = (s.value / total) * circ;
      var pctS = Math.round(s.value / total * 100);
      var tip = s.tip || (s.label + ' · ' + (s.plain != null ? s.plain : s.value) + ' · ' + pctS + '%');
      var seg = '<circle class="adm-donut-seg" cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="' + s.color + '" stroke-width="' + sw +
        '" stroke-dasharray="' + dash.toFixed(2) + ' ' + (circ - dash).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) +
        '" data-tip="' + esc(tip) + '"></circle>';
      off += dash;
      return seg;
    }).join('');
    var center = opts.centerLabel
      ? '<text x="' + c + '" y="' + (c - 3) + '" class="adm-donut-c1">' + esc(opts.centerLabel) + '</text>' +
        '<text x="' + c + '" y="' + (c + 13) + '" class="adm-donut-c2">' + esc(opts.centerSub || '') + '</text>'
      : '';
    var legend = '<div class="adm-donut-key">' + segments.map(function (s) {
      return '<span><i style="background:' + s.color + '"></i><span class="adm-donut-lbl">' + esc(s.label) + '</span>' +
        '<b>' + (s.display != null ? s.display : esc(String(s.value))) + '</b>' +
        '<em>' + Math.round(s.value / total * 100) + '%</em></span>';
    }).join('') + '</div>';
    return '<div class="adm-donut-wrap"><svg class="adm-donut" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<g transform="rotate(-90 ' + c + ' ' + c + ')">' + arcs + '</g>' + center + '</svg>' + legend + '</div>';
  }

  // One delegated cursor-following tooltip for every chart on the page -
  // bars, donut segments, sparkline points. Survives the panel re-renders
  // (Marketing polls every 10s, Analytics on data refresh) that a
  // per-container listener wouldn't. The native <title> is dropped in
  // favour of this since it's slow and unstyled.
  var CHART_HIT = '.adm-chart-bar, .adm-donut-seg, .adm-spark-pt, .adm-hbar';
  (function () {
    var tipEl = null;
    function tip() {
      if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'adm-chart-tip'; tipEl.hidden = true; document.body.appendChild(tipEl); }
      return tipEl;
    }
    function clearHover() {
      document.querySelectorAll('.adm-chart-bar.hover, .adm-donut-seg.hover, .adm-spark-pt.hover, .adm-hbar.hover').forEach(function (x) { x.classList.remove('hover'); });
    }
    document.addEventListener('mousemove', function (e) {
      var t = e.target.closest ? e.target.closest(CHART_HIT) : null;
      var box = tip();
      if (!t || !t.getAttribute('data-tip')) {
        if (!box.hidden) { box.hidden = true; clearHover(); }
        return;
      }
      box.hidden = false;
      box.textContent = t.getAttribute('data-tip');
      box.style.left = (e.clientX + 14) + 'px';
      box.style.top = (e.clientY + 14) + 'px';
      if (!t.classList.contains('hover')) {
        clearHover();
        t.classList.add('hover');
      }
    });
    document.addEventListener('mouseleave', function () { var box = tip(); box.hidden = true; clearHover(); }, true);
  })();
  // Kept as a no-op - charts are wired globally now, but call sites still
  // invoke it.
  function attachChartTooltip() {}

  /* ================================================================
     AGGREGATION (all computed live from ORDERS for the active range)
     ================================================================ */
  function ordersInRange() { return ORDERS.filter(function (o) { return inRange(o.date); }); }
  // Sales-performance aggregations (revenue, order count, AOV, conversion,
  // best sellers, coupon stats) count real purchases only. A source:'granted'
  // row is a free admin comp - $0, no coupon, no checkout - and folding it in
  // inflated the order count over what Recent Orders shows and pulled AOV /
  // conversion toward zero. Grants still appear in full in the Orders panel.
  function completedInRange() {
    return ordersInRange().filter(function (o) { return o.status === 'completed' && o.source !== 'granted'; });
  }
  function completedInWindow(start, end) {
    return ORDERS.filter(function (o) { var d = new Date(o.date); return o.status === 'completed' && o.source !== 'granted' && d >= start && d < end; });
  }
  // Real USD and real Robux totals (not the USD-equivalent record-keeping
  // figure robux orders also carry) - for revenue stat tiles, not display
  // of any single order's actual charge.
  function websiteRevenue(list) {
    var usdTotal = 0, robuxTotal = 0;
    list.forEach(function (o) { if (o.currency === 'robux') robuxTotal += o.totalRobux; else usdTotal += o.total; });
    return { usd: usdTotal, robux: robuxTotal };
  }
  // Flattens completed orders' line items for product/category-level
  // aggregation (an order can contain multiple items, unlike the old
  // one-product-per-order mock ledger).
  function completedItemsInRange() {
    var out = [];
    completedInRange().forEach(function (o) {
      (o.items || []).forEach(function (it) {
        var product = findProduct(it.product_slug);
        out.push({
          productId: it.product_slug,
          title: it.title,
          image: product ? product.image : o.image,
          cat: product ? product.cat : o.cat,
          qty: it.qty || 1,
          revenue: (Number(it.unit_price_usd) || 0) * (it.qty || 1)
        });
      });
    });
    return out;
  }

  function revenueTotals() {
    var comp = completedInRange();
    var totalUSD = 0, byCurrency = { usd: 0, aud: 0, robux: 0 };
    comp.forEach(function (o) { totalUSD += o.total; byCurrency[o.currency] = (byCurrency[o.currency] || 0) + o.total; });
    return { totalUSD: totalUSD, byCurrency: byCurrency, count: comp.length };
  }
  function bestSellers(limit) {
    var map = {};
    completedItemsInRange().forEach(function (it) {
      map[it.productId] = map[it.productId] || { id: it.productId, title: it.title, image: it.image, units: 0, revenue: 0 };
      map[it.productId].units += it.qty;
      map[it.productId].revenue += it.revenue;
    });
    // BuiltByBit sales join the same list; a listing that matches a site product by
    // title adds to that product's row, otherwise it gets its own row.
    if (BBB.configured) {
      var bprods = allProducts();
      bbbBestSellers(RANGE_DAYS ? rangeStart() : null, new Date(Date.now() + 1000)).forEach(function (e) {
        var prod = bprods.filter(function (p) { return bbbNorm(p.title) === bbbNorm(e.title); })[0];
        var key = prod ? prod.id : 'bbb:' + e.id;
        var m = map[key] = map[key] || { id: key, title: prod ? prod.title : e.title, image: prod ? prod.image : '/mp-logos/builtbybit.png', units: 0, revenue: 0 };
        m.units += e.units; m.revenue += e.revenue;
        m.bbbUnits = (m.bbbUnits || 0) + e.units;
      });
    }
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.revenue - a.revenue; }).slice(0, limit || 6);
  }
  function revenueByCategory() {
    var map = {};
    completedItemsInRange().forEach(function (it) {
      map[it.cat] = (map[it.cat] || 0) + it.revenue;
    });
    if (BBB.configured) {
      var bc = bbbCategoryRevenue(RANGE_DAYS ? rangeStart() : null, new Date(Date.now() + 1000));
      Object.keys(bc).forEach(function (k) { map[k] = (map[k] || 0) + bc[k]; });
    }
    return Object.keys(map).map(function (k) { return { label: k, v: map[k] }; }).sort(function (a, b) { return b.v - a.v; });
  }
  function dailyRevenueSeries() {
    var days = RANGE_DAYS || 120;
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = daysAgo(i);
      var key = d.toDateString();
      var v = 0;
      ORDERS.forEach(function (o) { if (o.status === 'completed' && new Date(o.date).toDateString() === key) v += o.total; });
      out.push({ label: fmtDate(d), v: Math.round(v * 100) / 100, tip: usd(v) });
    }
    return out;
  }
  function trafficSeries() {
    var days = RANGE_DAYS || 120;
    var rows = TRAFFIC.slice(Math.max(0, TRAFFIC.length - days));
    return rows.map(function (r) { return { label: fmtDate(new Date(r.date)), v: r.pageviews, tip: r.pageviews + ' views' }; });
  }

  /* ----------------------------------------------------------------
     SITE ANALYTICS: payment mix, customer mix, refunds, AOV trend.
     All USD figures use o.total (the USD or USD-equivalent record-
     keeping value), matching the rest of the Analytics panel, so a
     Robux order still counts toward the mix at its book value.
     ---------------------------------------------------------------- */
  function paymentMethodLabel(o) {
    if (o.currency === 'robux') return 'Robux';
    var p = String(o.paymentProvider || '').toLowerCase();
    if (p === 'paypal') return 'PayPal';
    if (p === 'crypto' || p === 'nowpayments' || p === 'coinbase') return 'Crypto';
    if (!p || p === 'stripe' || p === 'card') return 'Card';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }
  function methodColor(label) {
    return ({ Card: 'var(--accent)', PayPal: '#3b7bbf', Crypto: '#e8b84b', Robux: 'var(--price)' })[label] || 'var(--fg-3)';
  }
  function revenueByMethod() {
    var map = {};
    completedInRange().forEach(function (o) {
      var k = paymentMethodLabel(o);
      if (!map[k]) map[k] = { usd: 0, robux: 0 };
      map[k].usd += Number(o.total) || 0;
      if (o.currency === 'robux') map[k].robux += Number(o.totalRobux) || 0;
    });
    var total = Object.keys(map).reduce(function (s, k) { return s + map[k].usd; }, 0);
    return Object.keys(map).map(function (k) {
      return { label: k, v: map[k].usd, robux: map[k].robux, pct: total ? map[k].usd / total * 100 : 0 };
    }).sort(function (a, b) { return b.v - a.v; });
  }
  function repeatCustomerStats() {
    var byUser = {};
    ORDERS.forEach(function (o) {
      if (o.status === 'completed' && o.source !== 'granted' && o.userId) byUser[o.userId] = (byUser[o.userId] || 0) + 1;
    });
    var ids = Object.keys(byUser);
    var repeat = ids.filter(function (id) { return byUser[id] >= 2; }).length;
    return { payers: ids.length, repeat: repeat, rate: ids.length ? repeat / ids.length * 100 : 0 };
  }
  function refundStats() {
    var inr = ordersInRange().filter(function (o) { return o.source !== 'granted'; });
    var refunded = inr.filter(function (o) { return o.status === 'refunded'; });
    var completed = inr.filter(function (o) { return o.status === 'completed'; });
    var denom = completed.length + refunded.length;
    return {
      count: refunded.length,
      rate: denom ? refunded.length / denom * 100 : 0,
      usd: refunded.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0)
    };
  }
  function aovDailySeries() {
    var days = RANGE_DAYS || 120;
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = daysAgo(i), key = d.toDateString();
      var rev = 0, n = 0;
      ORDERS.forEach(function (o) {
        if (o.status === 'completed' && o.source !== 'granted' && new Date(o.date).toDateString() === key) { rev += Number(o.total) || 0; n++; }
      });
      var v = n ? rev / n : 0;
      out.push({ label: fmtDate(d), v: Math.round(v * 100) / 100, tip: usd(v) + (n ? ' · ' + n + ' order' + (n === 1 ? '' : 's') : '') });
    }
    return out;
  }
  function categoryRevenueWindow(list) {
    var map = {};
    (list || []).forEach(function (o) {
      (o.items || []).forEach(function (it) {
        var product = findProduct(it.product_slug);
        var cat = product ? product.cat : o.cat;
        map[cat] = (map[cat] || 0) + (Number(it.unit_price_usd) || 0) * (it.qty || 1);
      });
    });
    return map;
  }

  // Visit -> product -> cart -> checkout -> paid, by distinct session over
  // the active range. Visitors/product/checkout come from page_views;
  // "added to cart" from client_events; "paid" is the completed order
  // count (orders carry no session id, so that last step isn't session-
  // deduped - it's a straight count).
  function funnelCounts() {
    var start = RANGE_DAYS ? rangeStart() : new Date(0);
    var sess = {}, prod = {}, chk = {}, cart = {};
    TRAFFIC_ROWS.forEach(function (r) {
      if (!r.s || new Date(r.d) < start) return;
      sess[r.s] = true;
      if (r.p === '/product' || r.p.indexOf('/product/') === 0) prod[r.s] = true;
      if (r.p === '/checkout') chk[r.s] = true;
    });
    // A session that added to cart or began checkout is a visitor, even if its
    // page view wasn't logged, so no later step can ever exceed "visited".
    CLIENT_EVENT_ROWS.forEach(function (e) {
      if (!e.s || new Date(e.d) < start) return;
      if (e.type === 'add_to_cart') { cart[e.s] = true; sess[e.s] = true; }
      if (e.type === 'checkout_started') { chk[e.s] = true; sess[e.s] = true; }
    });
    return {
      visitors: Object.keys(sess).length,
      product: Object.keys(prod).length,
      cart: Object.keys(cart).length,
      checkout: Object.keys(chk).length,
      paid: completedInRange().length
    };
  }
  function topSearches(limit) {
    var start = RANGE_DAYS ? rangeStart() : new Date(0);
    var map = {};
    CLIENT_EVENT_ROWS.forEach(function (e) {
      if (e.type !== 'search' || !e.meta || !e.meta.q || new Date(e.d) < start) return;
      var q = String(e.meta.q).toLowerCase().trim();
      if (!map[q]) map[q] = { q: q, count: 0, noResults: 0 };
      map[q].count++;
      if (e.meta.results === 0) map[q].noResults++;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, limit || 15);
  }
  function howHeard() {
    var start = RANGE_DAYS ? rangeStart() : new Date(0);
    var LABELS = { youtube: 'YouTube', tiktok: 'TikTok', discord: 'Discord', friend: 'A friend',
      search: 'Google / search', roblox: 'In a Roblox game', other: 'Somewhere else' };
    var map = {}, total = 0;
    CLIENT_EVENT_ROWS.forEach(function (e) {
      if (e.type !== 'how_heard' || !e.meta || !e.meta.id || new Date(e.d) < start) return;
      var k = String(e.meta.id);
      map[k] = (map[k] || 0) + 1; total++;
    });
    return Object.keys(map).map(function (k) {
      return { label: LABELS[k] || k, count: map[k], pct: total ? Math.round(map[k] / total * 100) : 0 };
    }).sort(function (a, b) { return b.count - a.count; });
  }
  function conversionRate() {
    var days = RANGE_DAYS || 120;
    var rows = TRAFFIC.slice(Math.max(0, TRAFFIC.length - days));
    var sessions = rows.reduce(function (s, r) { return s + r.sessions; }, 0);
    var orders = completedInRange().length;
    return sessions ? (orders / sessions) * 100 : 0;
  }
  function avgOrderValue() {
    var comp = completedInRange();
    if (!comp.length) return 0;
    return comp.reduce(function (s, o) { return s + o.total; }, 0) / comp.length;
  }
  function couponStats() {
    // usage_count/limit come straight off the coupons table (incremented
    // server-side in create-checkout-session). discountGiven/revenue are
    // computed live from the real orders table's coupon_code/discount_usd.
    // Every one-time WELCOME-xxxx code (one is minted per signup) is folded
    // into a single "Welcome offer" line, otherwise the list is one row per
    // subscriber.
    function key(code) { return /^WELCOME-/i.test(String(code)) ? 'WELCOME' : code; }
    var byCode = {};
    completedInRange().forEach(function (o) {
      if (!o.couponCode) return;
      var k = key(o.couponCode);
      byCode[k] = byCode[k] || { discountGiven: 0, revenue: 0 };
      byCode[k].discountGiven += o.discount;
      byCode[k].revenue += o.total;
    });
    var rows = [], welcome = null;
    COUPONS.forEach(function (c) {
      if (key(c.code) === 'WELCOME') {
        if (!welcome) { welcome = { code: 'WELCOME', label: 'Welcome offer', active: false, limit: 0, uses: 0, issued: 0 }; rows.push(welcome); }
        welcome.issued++; welcome.uses += c.usageCount || 0; welcome.active = welcome.active || c.active;
        return;
      }
      rows.push({ code: c.code, active: c.active, limit: c.limit, uses: c.usageCount });
    });
    return rows.map(function (r) {
      var s = byCode[r.code];
      r.discountGiven = s ? s.discountGiven : 0;
      r.revenue = s ? s.revenue : 0;
      return r;
    });
  }

  /* ================================================================
     NAV / PANEL SWITCHING
     ================================================================ */
  var PANELS = ['home', 'analytics', 'marketing', 'marketplaces', 'products', 'unreleased', 'product-edit', 'product-update', 'orders', 'order-detail', 'resellers', 'reseller-edit', 'reviews', 'sales', 'sitemgmt', 'content'];
  var curPanel = 'home';

  /* ---- URL routing ----
     Real per-section URLs so browser back/forward moves between admin
     sections instead of leaving /admin entirely. Top-level sections each
     get their own address; product-edit additionally nests the product's
     slug (/admin/products/<slug>/, pre-generated as a real file by
     gen-admin-pages.py, mirroring gen-product-pages.py for the storefront).
     Everything else that isn't a top-level section (a specific order, a
     reseller, the unreleased-files drawer) still gets a working pushState
     URL for back/forward during normal use, but has no static file of its
     own - those IDs are unbounded and not worth pre-rendering, so a hard
     refresh on one of those exact deep URLs falls back to its parent list. */
  var PANEL_PATH = {
    home: '/admin/', products: '/admin/products/', sales: '/admin/sales/',
    marketing: '/admin/marketing/', marketplaces: '/admin/marketplaces/', analytics: '/admin/analytics/', orders: '/admin/orders/',
    resellers: '/admin/resellers/', reviews: '/admin/reviews/', content: '/admin/content/',
    sitemgmt: '/admin/sitemgmt/'
  };
  var PANEL_PARENT = { 'product-edit': 'products', 'product-update': 'products', unreleased: 'products', 'order-detail': 'orders', 'reseller-edit': 'resellers' };
  function urlForPanel(name, extra) {
    if (PANEL_PATH[name]) return PANEL_PATH[name];
    var parent = PANEL_PARENT[name];
    if (parent && PANEL_PATH[parent]) return PANEL_PATH[parent] + (extra ? extra + '/' : '');
    return PANEL_PATH.home;
  }
  function showPanel(name, opts) {
    opts = opts || {};
    if (PANELS.indexOf(name) < 0) name = 'home';
    curPanel = name;
    PANELS.forEach(function (p) {
      var sec = $('adm-panel-' + p);
      if (sec) sec.hidden = (p !== name);
    });
    var navTarget = PANEL_PARENT[name] || name;
    document.querySelectorAll('.dash-nav a').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-panel') === navTarget); });
    renderPanel(name);
    window.scrollTo(0, 0);
    if (typeof autoGrowAll === 'function') setTimeout(autoGrowAll, 0);
    if (!opts.skipUrl) {
      var url = urlForPanel(name, opts.extra);
      if (location.pathname !== url) history.pushState({ panel: name, extra: opts.extra || null }, '', url);
    }
  }
  function findProductBySlug(slug) { return allProducts().filter(function (p) { return p.slug === slug; })[0]; }
  // Re-derives the panel from the current URL - used on boot and whenever
  // the user navigates with the browser's own back/forward buttons.
  function routeFromLocation() {
    var parts = location.pathname.replace(/^\/admin\/?/, '').replace(/\/$/, '').split('/').filter(Boolean);
    var section = parts[0], sub = parts[1];
    if (!section || !PANEL_PATH[section]) { showPanel('home', { skipUrl: true }); return; }
    if (section === 'products' && sub) {
      if (sub === 'new') { openProductCreate({ skipUrl: true }); return; }
      if (sub === 'unreleased') { showPanel('unreleased', { skipUrl: true, extra: 'unreleased' }); return; }
      // Products load asynchronously - poll the same way the older
      // ?product= query-param deep link already does further below.
      var tries = 0;
      (function wait() {
        var prod = findProductBySlug(sub);
        if (prod) openProductEdit(prod.id, { skipUrl: true });
        else if (tries++ < 40) setTimeout(wait, 150);
        else showPanel('products', { skipUrl: true });
      })();
      return;
    }
    showPanel(section, { skipUrl: true });
  }
  window.addEventListener('popstate', function () { routeFromLocation(); });
  function renderPanel(name) {
    if (name === 'home') renderHome();
    else if (name === 'analytics') renderAnalytics();
    else if (name === 'marketing') renderMarketing();
    else if (name === 'marketplaces') renderMarketplaces();
    else if (name === 'products') renderProducts();
    else if (name === 'unreleased') renderUnreleasedFiles();
    else if (name === 'orders') renderOrders();
    else if (name === 'order-detail') renderOrderDetail();
    else if (name === 'resellers') renderResellers();
    else if (name === 'reviews') renderReviews();
    else if (name === 'sales') { renderEvents(); renderCoupons(); }
    else if (name === 'sitemgmt') {
      refreshSiteStatus(); renderRobloxContainers(); refreshRobloxCookieHealth(); refreshRobloxPool();
      renderStaff(); renderUsers(); renderAudit(); refreshAuditLog();
    }
    else if (name === 'content') { renderPosts(); renderTutorials(); renderReleases(); }
  }
  function renderAll() { renderPanel(curPanel); }

  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-panel]');
    if (a) { e.preventDefault(); showPanel(a.getAttribute('data-panel')); }
  });

  document.querySelectorAll('.adm-range button').forEach(function (b) {
    b.addEventListener('click', function () { setRange(+b.getAttribute('data-range')); });
  });

  /* ================================================================
     HOME PANEL
     ================================================================ */
  function pageviewsInWindow(start, end) {
    return TRAFFIC.filter(function (r) { var d = new Date(r.date); return d >= start && d < end; }).reduce(function (s, r) { return s + r.pageviews; }, 0);
  }
  function statTile(label, main, sub, deltaHtml, opts) {
    opts = opts || {};
    var attrs = opts.panel ? ' data-panel="' + esc(opts.panel) + '" style="cursor:pointer;"' : '';
    var title = opts.title ? ' title="' + esc(opts.title) + '"' : '';
    // opts.flash plays a brief "just updated" pulse on the number - only
    // ever passed true by a caller that already diffed against the
    // previous value, so a stat that hasn't actually changed (which is
    // most of them, most 10s ticks) never animates.
    var numClass = opts.flash ? ' ds-num-flash' : '';
    return '<div class="dash-stat glass"' + attrs + title + '><span class="ds-label">' + esc(label) + '</span><span class="ds-num' + numClass + '">' + main + '</span>' +
      (sub ? '<span class="ds-sub">' + sub + '</span>' : '') + (deltaHtml || '') + '</div>';
  }
  // Placeholder tiles shown while ORDERS is still loading, so the panels
  // never flash a computed-from-nothing 0.
  function loadingStats(n) {
    var one = '<div class="dash-stat glass"><span class="ds-label">Loading…</span><span class="ds-num"> - </span></div>';
    return new Array(n + 1).join(one);
  }
  function renderHome() {
    if (!ORDERS_LOADED) { $('admHomeStatsTop').innerHTML = loadingStats(4); return; }
    var curOrders = completedInRange();
    var curRev = websiteRevenue(curOrders);
    var win = RANGE_DAYS ? prevRangeWindow() : null;
    var prevOrders = win ? completedInWindow(win.start, win.end) : [];
    var prevRev = websiteRevenue(prevOrders);

    var curVisits = RANGE_DAYS ? pageviewsInWindow(rangeStart(), new Date()) : TRAFFIC.reduce(function (s, r) { return s + r.pageviews; }, 0);
    var prevVisits = win ? pageviewsInWindow(win.start, win.end) : 0;

    // "Overall" and "Website" were both computed from the same websiteRevenue()
    // call, so the dashboard showed each figure twice under two names and
    // implied an off-site revenue stream that is not tracked anywhere. One
    // set of numbers, named for what they are.
    $('admHomeStatsTop').innerHTML = [
      statTile('Revenue', aud(curRev.usd), usd(curRev.usd) + ' USD', pctDelta(curRev.usd, prevRev.usd)),
      statTile('Robux revenue', robuxRaw(curRev.robux), null, pctDelta(curRev.robux, prevRev.robux)),
      statTile('Order count', curOrders.length, null, pctDelta(curOrders.length, prevOrders.length)),
      bbbRevTile()
    ].join('');

    var owed = referralsOwedInfo();
    // Audience and Discord growth live in the Marketing tab; the home row
    // shows marketplace orders and site traffic instead.
    $('admHomeStatsSecondary').innerHTML = [
      statTile('Live sessions', LIVE_SESSIONS, 'active in the last 5 min', ''),
      bbbOrdersTile(),
      statTile('Site visits', curVisits.toLocaleString('en-US'), null, pctDelta(curVisits, prevVisits)),
      statTile('Referrals owed', aud(owed.usdTotal), owed.count ? (owed.count + ' request' + (owed.count === 1 ? '' : 's') + ' pending') : 'Nothing pending', '', { panel: 'analytics', title: owed.names.length ? 'Requested by: ' + owed.names.join(', ') : '' })
    ].join('');

    var todo = [];
    var newReviews = REVIEWS.filter(function (r) { return !r.adminReviewedAt; }).length;
    if (newReviews) todo.push({ text: newReviews + ' new review' + (newReviews > 1 ? 's' : '') + ' to look at', panel: 'reviews', badge: 'warn' });
    var pendingPayouts = PAYOUTS.filter(function (p) { return p.status === 'requested'; }).length;
    if (pendingPayouts) todo.push({ text: pendingPayouts + ' referral payout request' + (pendingPayouts > 1 ? 's' : '') + ' pending', panel: 'analytics', badge: 'warn' });
    mpTodoLines().forEach(function (t) { todo.push(t); });
    if (UNRELEASED_FILES.length) todo.push({ text: 'You have ' + UNRELEASED_FILES.length + ' product' + (UNRELEASED_FILES.length > 1 ? 's' : '') + ' to release', panel: 'unreleased', badge: 'warn' });
    if (ROBLOX_COOKIE_BROKEN) todo.push({ text: 'Robux fallback cookie is broken - group-transaction verification won\'t work until it\'s refreshed', panel: 'sitemgmt', badge: 'err' });
    if (ROBLOX_CONTAINERS.length && ROBLOX_CONTAINERS.every(function (c) { return !c.active || c.gamepass_count >= 50; })) {
      todo.push({ text: 'All Roblox container games are full - add a new one before creating more Robux products', panel: 'sitemgmt', badge: 'err' });
    }
    $('admHomeTodo').innerHTML = todo.length ? todo.map(function (t) {
      return '<div class="adm-todo-row"><span class="adm-todo-text">' + esc(t.text) + '</span><a href="#" class="btn btn-ghost adm-btn-sm" data-panel="' + t.panel + '">Review</a></div>';
    }).join('') : '<p class="adm-empty">Nothing needs your attention right now.</p>';

    // Recent orders is meant as a snapshot of real sales activity - a free
    // admin-granted comp isn't that, and mixing $0.00 "Completed" rows in
    // with actual purchases made the widget read as broken/fake ("orders
    // showing free grants"). Grants still show up in full in the Orders
    // panel itself, just not on this home-page summary.
    var recent = ORDERS.filter(function (o) { return o.status === 'completed' && o.source !== 'granted'; }).slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); }).slice(0, 6);
    $('admHomeRecent').innerHTML = recent.map(orderRowHTML).join('') || '<p class="adm-empty">No completed orders yet.</p>';

    // Keep the range buttons in sync with the persisted RANGE_DAYS. The
    // markup hard-codes 30D as active, so without this the Home dashboard
    // could show 30D highlighted while actually rendering a different
    // stored range - the figures looked "stuck" until a click ran setRange.
    document.querySelectorAll('#admHomeRange button').forEach(function (b) { b.classList.toggle('active', +b.getAttribute('data-range') === RANGE_DAYS); });
  }
  function orderRowHTML(o) {
    return '<div class="dash-row"><span class="dr-thumb" style="background-image:url(\'' + o.image + '\')"></span>' +
      '<div class="dr-main"><div class="dr-title">' + esc(o.title) + '</div><div class="dr-sub">' + fmtDateTime(new Date(o.date)) + ' · ' + esc(o.id) + ' · ' + esc(o.userName) + '</div></div>' +
      statusBadge(o.status) + '<span class="p-price" style="margin-left:12px;">' + orderAmount(o) + '</span></div>';
  }
  function statusBadge(status) {
    var cls = status === 'completed' ? 'ok' : (status === 'refunded' || status === 'revoked') ? 'err' : 'warn';
    var label = status.charAt(0).toUpperCase() + status.slice(1);
    return '<span class="dt-badge ' + cls + '">' + label + '</span>';
  }

  /* ================================================================
     MARKETING PANEL

     Split out of Analytics, which had grown to hold two unrelated jobs:
     how the store is performing, and how the audience is reached. The
     channel and email blocks state plainly that nothing is connected yet
     rather than rendering invented numbers.
     ================================================================ */
  var MKT_CHANNELS = [
    { key: 'discord', name: 'Discord', note: 'Members, presence, growth and daily swings.' },
    { key: 'x', name: 'X (Twitter)', note: 'Followers, posting cadence and recent-post engagement.', needs: 'Needs TWITTER_BEARER_TOKEN + TWITTER_USERNAME secrets' },
    { key: 'youtube', name: 'YouTube', note: 'Subscribers, views, uploads and per-video engagement.', needs: 'Needs YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID secrets' },
    { key: 'tiktok', name: 'TikTok', note: 'Followers, likes, uploads and per-video engagement.', needs: 'Not connected yet - click Connect TikTok to authorize.' }
  ];

  // TIKTOK_CLIENT_KEY is the public half of the OAuth pair (as opposed to
  // TIKTOK_CLIENT_SECRET, which never leaves the server - see
  // tiktok-oauth-exchange). Safe to embed client-side, same as any OAuth
  // app's client ID. Builds the same authorize URL TikTok's own docs show
  // for the Display API; scope covers exactly the two fields
  // admin-tiktok-stats reads (follower_count, likes_count, video_count).
  var TIKTOK_CLIENT_KEY = 'sbawte4ixv4nx3rgkb';
  var TIKTOK_REDIRECT_URI = 'https://coldd.dev/tiktok-callback';
  function tiktokAuthorizeUrl() {
    var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var params = new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      // video.list is what lets admin-tiktok-stats read per-video
      // view/like/comment/share counts for the engagement tiles; the two
      // user.info scopes cover the follower/likes/video totals.
      scope: 'user.info.basic,user.info.stats,video.list',
      response_type: 'code',
      redirect_uri: TIKTOK_REDIRECT_URI,
      state: state
    });
    return 'https://www.tiktok.com/v2/auth/authorize/?' + params.toString();
  }

  // Populated by refreshSocialStats(); each admin-*-stats function returns
  // { configured: false } when its secrets aren't set yet, rather than an
  // error, so the channel row can show a real "what's missing" hint
  // instead of a bare "Not connected" badge with no next step.
  var YOUTUBE_STATS = null, X_STATS = null, TIKTOK_STATS = null, YT_ANALYTICS = null;
  function refreshSocialStats() {
    return Promise.all([
      invokeAdminFn('admin-youtube-stats', {}).then(function (d) { YOUTUBE_STATS = d; }).catch(function () { YOUTUBE_STATS = null; }),
      invokeAdminFn('admin-x-stats', {}).then(function (d) { X_STATS = d; }).catch(function () { X_STATS = null; }),
      invokeAdminFn('admin-tiktok-stats', {}).then(function (d) { TIKTOK_STATS = d; }).catch(function () { TIKTOK_STATS = null; }),
      invokeAdminFn('admin-youtube-analytics', { days: 28 }).then(function (d) { YT_ANALYTICS = d; }).catch(function () { YT_ANALYTICS = null; })
    ]).then(function () {
      if (curPanel === 'marketing') renderMarketing();
    });
  }
  // Kicks off the Google OAuth consent flow for the YouTube Analytics API.
  // The client id lives in a secret, so the authorize URL is built
  // server-side (youtube-oauth-url) and we just redirect to it.
  function connectYoutubeAnalytics(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Opening Google…'; }
    invokeAdminFn('youtube-oauth-url', { redirectUri: 'https://coldd.dev/youtube-callback' }, 'Could not start the YouTube connect flow.')
      .then(function (d) { if (d && d.url) location.href = d.url; else throw new Error('No URL returned.'); })
      .catch(function (err) { if (btn) { btn.disabled = false; btn.textContent = 'Connect YouTube Analytics'; } alert(err.message); });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('#admConnectYtAnalytics');
    if (b) { e.preventDefault(); connectYoutubeAnalytics(b); }
  });

  /* ----------------------------------------------------------------
     SOCIAL: range-aware history maths

     Every platform stores one daily snapshot (social_media_stats /
     discord_member_snapshots). followers/member_count sit on the row;
     the richer counts (posts, views, videos, likes, engagement rate)
     live in the row's `extra` blob. These helpers turn that series into
     the "over the selected range" deltas, averages and sparklines the
     channel dropdowns show.
     ---------------------------------------------------------------- */
  function socialRangeStartKey() {
    return (RANGE_DAYS ? rangeStart() : new Date(0)).toISOString().slice(0, 10);
  }
  function socialRangeLabel() { return RANGE_DAYS ? 'over selected range' : 'since tracking began'; }
  function histRange(history) {
    var k = socialRangeStartKey();
    return (history || []).filter(function (r) { return r.snapshot_date >= k; });
  }
  function histBaseline(history, get) {
    var k = socialRangeStartKey(), base = null;
    for (var i = 0; i < (history || []).length; i++) {
      if (history[i].snapshot_date <= k) base = history[i]; else break;
    }
    if (!base && history && history.length) base = history[0];
    var v = base ? get(base) : null;
    return (v == null || isNaN(v)) ? null : Number(v);
  }
  function histCurrent(history, get) {
    if (!history || !history.length) return null;
    var v = get(history[history.length - 1]);
    return (v == null || isNaN(v)) ? null : Number(v);
  }
  // { abs, pct, cur, base } for a numeric getter over the active range, or
  // null when there isn't enough history yet to say.
  function histDelta(history, get) {
    var cur = histCurrent(history, get), base = histBaseline(history, get);
    if (cur == null || base == null) return null;
    return { abs: cur - base, pct: base ? (cur - base) / base * 100 : null, cur: cur, base: base };
  }
  function rangeDayCount(history) {
    var rows = histRange(history);
    if (rows.length >= 2) {
      var a = new Date(rows[0].snapshot_date), b = new Date(rows[rows.length - 1].snapshot_date);
      return Math.max(1, Math.round((b - a) / 86400000));
    }
    return RANGE_DAYS || Math.max(1, rows.length);
  }
  function biggestSwing(history, get) {
    var rows = histRange(history);
    if (rows.length < 2) return null;
    var up = null, down = null;
    for (var i = 1; i < rows.length; i++) {
      var diff = Number(get(rows[i])) - Number(get(rows[i - 1]));
      if (isNaN(diff)) continue;
      if (up == null || diff > up.diff) up = { diff: diff, date: rows[i].snapshot_date };
      if (down == null || diff < down.diff) down = { diff: diff, date: rows[i].snapshot_date };
    }
    return up ? { up: up, down: down } : null;
  }
  function socialDeltaSpan(d) {
    if (!d || d.abs == null) return '';
    var cls = d.abs > 0 ? 'up' : d.abs < 0 ? 'down' : 'flat';
    var arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '–';
    var pctPart = (d.pct != null && isFinite(d.pct)) ? ' · ' + Math.abs(Math.round(d.pct * 10) / 10) + '%' : '';
    return '<span class="ds-delta ' + cls + '">' + arrow + ' ' + (d.abs > 0 ? '+' : '') + Math.round(d.abs).toLocaleString('en-US') + pctPart + '</span>';
  }
  function num(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function signed(n) { n = Math.round(Number(n) || 0); return (n > 0 ? '+' : '') + n.toLocaleString('en-US'); }
  function signed1(n) { n = Math.round((Number(n) || 0) * 10) / 10; return (n > 0 ? '+' : '') + n.toLocaleString('en-US'); }
  function deltaTile(label, main, d, sub) { return statTile(label, main, sub || socialRangeLabel(), socialDeltaSpan(d)); }

  // Minimal inline sparkline (no axes/labels - the tile above carries the
  // number). Returns '' for < 2 points so a brand-new channel doesn't
  // render an empty box.
  function sparkline(values, opts) {
    values = (values || []).map(Number).filter(function (v) { return !isNaN(v); });
    if (values.length < 2) return '';
    opts = opts || {};
    var n = values.length;
    var w = 600, h = 90, padX = 8, padY = 14;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var stepX = (w - padX * 2) / (n - 1);
    var color = opts.color || 'var(--accent)';
    var co = values.map(function (v, i) {
      return { x: padX + i * stepX, y: h - padY - ((v - min) / span) * (h - padY * 2), v: v };
    });
    var line = co.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    var base = (h - padY + 5).toFixed(1);
    var area = 'M' + co[0].x.toFixed(1) + ',' + base + ' L' + co.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' L') + ' L' + co[n - 1].x.toFixed(1) + ',' + base + ' Z';
    var lbl = opts.label ? opts.label + ': ' : '';
    var pts = co.map(function (p) {
      return '<circle class="adm-spark-pt" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="9" data-tip="' + esc(lbl + num(p.v)) + '"></circle>' +
        '<circle class="adm-spark-dot" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2" fill="' + color + '"></circle>';
    }).join('');
    return '<svg class="adm-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<path d="' + area + '" fill="' + color + '" fill-opacity="0.10" />' +
      '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />' +
      pts + '</svg>';
  }
  function sparkCard(title, values, opts) {
    opts = opts || {};
    if (!opts.label) opts.label = title;
    var clean = (values || []).map(Number).filter(function (v) { return !isNaN(v); });
    var s = sparkline(values, opts);
    if (!s) return '';
    return '<div class="adm-spark-card"><div class="adm-spark-head"><span>' + esc(title) + '</span>' +
      '<span class="adm-sub">' + num(clean[0]) + ' → ' + num(clean[clean.length - 1]) + '</span></div>' + s + '</div>';
  }
  // Per-day positive change of a cumulative-ish metric across the range -
  // e.g. impressions on the trailing-100-posts window snapshotted daily,
  // where the day-over-day rise ≈ impressions picked up that day.
  function dailyDeltaSeries(history, get) {
    var rows = histRange(history);
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var a = Number(get(rows[i - 1])), b = Number(get(rows[i]));
      var v = (isNaN(a) || isNaN(b)) ? 0 : Math.max(0, b - a);
      out.push({ label: fmtDate(new Date(rows[i].snapshot_date)), v: v, tip: num(v) });
    }
    return out;
  }
  function statGrid(tiles) { return '<div class="dash-stats">' + tiles.filter(Boolean).join('') + '</div>'; }
  // Horizontal label|bar|value rows - reads cleanly with any number of
  // series (1 to 4), unlike svgBars which turns 1-2 series into giant slabs.
  function hbars(rows, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r.v) || 0; }).concat([1]));
    return '<div class="adm-hbars">' + rows.map(function (r) {
      var w = max ? ((Number(r.v) || 0) / max * 100) : 0;
      return '<div class="adm-hbar" data-tip="' + esc(r.label + ' · ' + (r.display != null ? r.display : r.v)) + '">' +
        '<span class="adm-hbar-lbl">' + esc(r.label) + '</span>' +
        '<span class="adm-hbar-track"><span class="adm-hbar-fill" style="width:' + w.toFixed(1) + '%;background:' + (r.color || opts.color || 'var(--accent)') + '"></span></span>' +
        '<span class="adm-hbar-val">' + esc(r.display != null ? r.display : String(r.v)) + '</span></div>';
    }).join('') + '</div>';
  }
  function engagementSection(title, sub, tiles) {
    tiles = tiles.filter(Boolean);
    if (!tiles.length) return '';
    return '<div class="adm-social-sub"><span>' + esc(title) + '</span>' + (sub ? '<span class="adm-sub">' + esc(sub) + '</span>' : '') + '</div>' + statGrid(tiles);
  }

  // Each connected channel expands into its own stat block: the primary
  // grid (followers/growth/cadence), a recent-content engagement grid
  // where the API allows it, and trend sparklines.
  function socialPanelBody(key) {
    if (key === 'discord') return discordPanel();
    if (key === 'x') return xPanel();
    if (key === 'youtube') return youtubePanel();
    if (key === 'tiktok') return tiktokPanel();
    return '';
  }

  function discordPanel() {
    var h = DISCORD_STATS.history || [];
    var mem = function (r) { return r.member_count; };
    var onl = function (r) { return r.online_count; };
    var dMem = histDelta(h, mem);
    var inr = histRange(h);
    var onlineVals = inr.map(function (r) { return r.online_count; }).filter(function (v) { return v != null && !isNaN(v); }).map(Number);
    var avgOnline = onlineVals.length ? Math.round(onlineVals.reduce(function (s, v) { return s + v; }, 0) / onlineVals.length) : null;
    var peakOnline = onlineVals.length ? Math.max.apply(null, onlineVals) : null;
    var perDay = dMem ? dMem.abs / rangeDayCount(h) : null;
    var swing = biggestSwing(h, mem);
    // Engagement = share of members online on an average day over the range
    // (a rough "how alive is the server" number, comparable week to week).
    var engagement = (avgOnline != null && DISCORD_STATS.memberCount)
      ? Math.round(avgOnline / DISCORD_STATS.memberCount * 1000) / 10 : null;
    var tiles = [
      deltaTile('Members', num(DISCORD_STATS.memberCount), dMem),
      statTile('Online now', DISCORD_STATS.onlineCount != null ? num(DISCORD_STATS.onlineCount) : '–', null, ''),
      statTile('Net members', dMem ? signed(dMem.abs) : '–', socialRangeLabel(), dMem && dMem.pct != null ? socialDeltaSpan(dMem) : ''),
      statTile('Members / day', perDay == null ? '–' : signed1(perDay), socialRangeLabel(), ''),
      statTile('Avg online', avgOnline == null ? '–' : num(avgOnline), socialRangeLabel(), ''),
      statTile('Peak online', peakOnline == null ? '–' : num(peakOnline), socialRangeLabel(), ''),
      statTile('Engagement', engagement == null ? '–' : engagement + '%', 'avg online ÷ members', ''),
      statTile('Biggest day', swing && swing.up ? signed(swing.up.diff) : '–',
        swing && swing.down && swing.down.diff < 0 ? signed(swing.down.diff) + ' worst' : null, '')
    ];
    return '<div class="dash-stats adm-grid-4">' + tiles.join('') + '</div>' +
      sparkCard('Members', inr.map(function (r) { return r.member_count; })) +
      sparkCard('Online', onlineVals, { color: 'var(--price)' });
  }

  function xPanel() {
    var s = X_STATS, h = s.history || [];
    var dFollow = histDelta(h, function (r) { return r.followers; });
    var dPosts = histDelta(h, function (r) { return r.extra && r.extra.tweetCount; });
    var tiles = [
      deltaTile('Followers', num(s.followersCount), dFollow),
      statTile('Follower growth', dFollow ? signed(dFollow.abs) : '–', socialRangeLabel(), dFollow && dFollow.pct != null ? socialDeltaSpan(dFollow) : ''),
      statTile('Posts published', dPosts ? signed(dPosts.abs) : '–', socialRangeLabel(), ''),
      statTile('Posts', num(s.tweetCount), 'lifetime', ''),
      statTile('Last post', relTime(s.latestPostAt), s.latestPostAt ? '' : 'no recent post', '')
    ];
    var eng = s.engagement;
    var engTiles = eng ? [
      statTile('Impressions', num(eng.impressions), 'last ' + eng.sampleSize + ' posts', ''),
      statTile('Interactions', num(eng.interactions), 'likes + reposts + replies + quotes', ''),
      statTile('Engagement rate', eng.engagementRate != null ? eng.engagementRate + '%' : '–',
        eng.engagementRate == null ? 'X did not report impressions' : 'interactions ÷ impressions', ''),
      statTile('Impressions / post', num(eng.avgImpressionsPerPost), 'average, last ' + eng.sampleSize + ' posts', ''),
      statTile('Interactions / post', num(eng.avgInteractionsPerPost), 'average, last ' + eng.sampleSize + ' posts', ''),
      statTile('Bookmarks', num(eng.bookmarks), 'last ' + eng.sampleSize + ' posts', '')
    ] : [];
    var profileTiles = [
      statTile('Following', num(s.followingCount), null, ''),
      statTile('Times listed', num(s.listedCount), 'X Lists including this account', ''),
      statTile('Likes given', num(s.likeCount), 'lifetime', '')
    ];
    var impSeries = dailyDeltaSeries(h, function (r) { return r.extra && r.extra.recentImpressions; });
    var impChart = impSeries.some(function (d) { return d.v > 0; })
      ? '<div class="adm-mini-head">Impressions gained · daily (recent posts)</div>' + svgBars(impSeries, { height: 108, color: 'var(--price)' })
      : '';
    return statGrid(tiles) +
      engagementSection('Recent post engagement', eng ? '' : 'Needs the paid X API tier that allows reading posts', engTiles) +
      engagementSection('Profile', '', profileTiles) +
      sparkCard('Followers', histRange(h).map(function (r) { return r.followers; })) +
      impChart;
  }

  function youtubePanel() {
    var s = YOUTUBE_STATS, h = s.history || [];
    // Empty channel (no videos / views / subs yet) - a wall of "–" tiles
    // reads as broken. Show one honest line + the analytics connect prompt.
    if (!s.videoCount && !s.viewCount && !s.subscriberCount) {
      return '<p class="adm-note" style="margin:4px 0 0;">This YouTube channel has no public videos or views yet - stats will populate once it does.</p>' +
        youtubeAnalyticsSection();
    }
    var dSubs = histDelta(h, function (r) { return r.followers; });
    var dViews = histDelta(h, function (r) { return r.extra && r.extra.viewCount; });
    var dVideos = histDelta(h, function (r) { return r.extra && r.extra.videoCount; });
    var viewsPerNewVid = (dViews && dVideos && dVideos.abs > 0) ? Math.round(dViews.abs / dVideos.abs) : null;
    var subsPerNewVid = (dSubs && dVideos && dVideos.abs > 0) ? Math.round(dSubs.abs / dVideos.abs) : null;
    var tiles = [
      deltaTile('Subscribers', s.subscriberCount != null ? num(s.subscriberCount) : '–', dSubs),
      deltaTile('Total views', num(s.viewCount), dViews),
      statTile('Videos published', dVideos ? signed(dVideos.abs) : '–', socialRangeLabel(), ''),
      statTile('Lifetime views / video', num(s.lifetimeViewsPerVideo), 'all ' + num(s.videoCount) + ' videos', ''),
      statTile('Views / new video', viewsPerNewVid == null ? '–' : num(viewsPerNewVid), socialRangeLabel(), ''),
      statTile('Subs / new video', subsPerNewVid == null ? '–' : num(subsPerNewVid), socialRangeLabel(), ''),
      statTile('Last upload', relTime(s.latestPostAt), s.latestPostAt ? '' : 'no recent upload', '')
    ];
    var eng = s.engagement;
    var engTiles = eng ? [
      statTile('Recent views', num(eng.views), 'last ' + eng.sampleSize + ' videos', ''),
      statTile('Likes', num(eng.likes), num(eng.avgLikesPerVideo) + ' avg / video', ''),
      statTile('Comments', num(eng.comments), num(eng.avgCommentsPerVideo) + ' avg / video', ''),
      statTile('Engagement rate', eng.engagementRate != null ? eng.engagementRate + '%' : '–', '(likes + comments) ÷ views', ''),
      statTile('Avg views / video', num(eng.avgViewsPerVideo), 'last ' + eng.sampleSize + ' videos', '')
    ] : [];
    return statGrid(tiles) +
      engagementSection('Recent video engagement', '', engTiles) +
      youtubeAnalyticsSection() +
      sparkCard('Subscribers', histRange(h).map(function (r) { return r.followers; })) +
      sparkCard('Total views', histRange(h).map(function (r) { return r.extra && r.extra.viewCount; }), { color: 'var(--price)' }) +
      videoTable((s.recentVideos || []).map(function (v) { return { title: v.title, publishedAt: v.publishedAt, views: v.views, likes: v.likes, comments: v.comments }; }), ['views', 'likes', 'comments']);
  }
  // The OAuth-only YouTube Analytics block: watch time, retention, traffic
  // sources. Shows a connect button until /youtube-callback has run.
  function youtubeAnalyticsSection() {
    var connectBtn = '<div class="adm-social-sub"><span>Audience &amp; retention</span></div>' +
      '<p class="adm-note" style="margin:0 0 10px;">Watch time, average view duration, % viewed and traffic sources need a one-time Google sign-in.</p>' +
      '<button type="button" id="admConnectYtAnalytics" class="btn btn-ghost adm-btn-sm">Connect YouTube Analytics</button>';
    if (!YT_ANALYTICS || !YT_ANALYTICS.ok || !YT_ANALYTICS.configured || !YT_ANALYTICS.watch) {
      return (YT_ANALYTICS && YT_ANALYTICS.configured === false) || !YT_ANALYTICS ? connectBtn : '';
    }
    var w = YT_ANALYTICS.watch;
    function hms(sec) { sec = Math.round(sec); var m = Math.floor(sec / 60); return m + ':' + String(sec % 60).padStart(2, '0'); }
    var tiles = [
      statTile('Watch time', num(Math.round(w.minutesWatched)) + ' min', 'last ' + w.days + ' days', ''),
      statTile('Avg view duration', hms(w.avgViewDuration), null, ''),
      statTile('Avg % viewed', (Math.round(w.avgViewPercentage * 10) / 10) + '%', 'retention', ''),
      statTile('Net subscribers', signed(w.subscribersGained - w.subscribersLost), '+' + num(w.subscribersGained) + ' / -' + num(w.subscribersLost), '')
    ];
    var ts = YT_ANALYTICS.trafficSources || [];
    var tsTable = ts.length
      ? '<div class="adm-mini-head">Traffic sources · last ' + w.days + ' days</div><div class="dash-tablewrap"><table class="dash-table"><thead><tr><th>Source</th><th>Views</th><th>Watch min</th></tr></thead><tbody>' +
        ts.map(function (r) { return '<tr><td>' + esc(r.source) + '</td><td>' + num(r.views) + '</td><td>' + num(Math.round(r.minutesWatched)) + '</td></tr>'; }).join('') + '</tbody></table></div>'
      : '';
    return '<div class="adm-social-sub"><span>Audience &amp; retention</span><span class="adm-sub">YouTube Analytics · ~2-day lag</span></div>' + statGrid(tiles) + tsTable;
  }

  function tiktokPanel() {
    var s = TIKTOK_STATS, h = s.history || [];
    var dFollow = histDelta(h, function (r) { return r.followers; });
    var dLikes = histDelta(h, function (r) { return r.extra && r.extra.likesCount; });
    var dVideos = histDelta(h, function (r) { return r.extra && r.extra.videoCount; });
    var tiles = [
      deltaTile('Followers', num(s.followerCount), dFollow),
      statTile('Follower growth', dFollow ? signed(dFollow.abs) : '–', socialRangeLabel(), dFollow && dFollow.pct != null ? socialDeltaSpan(dFollow) : ''),
      deltaTile('Total likes', num(s.likesCount), dLikes),
      statTile('Videos posted', dVideos ? signed(dVideos.abs) : '–', socialRangeLabel(), ''),
      statTile('Likes / video', num(s.lifetimeLikesPerVideo), 'lifetime average', ''),
      statTile('Last post', relTime(s.latestPostAt), s.latestPostAt ? '' : 'no recent post', '')
    ];
    var eng = s.engagement;
    var engTiles = eng ? [
      statTile('Recent views', num(eng.views), 'last ' + eng.sampleSize + ' videos', ''),
      statTile('Avg views / video', num(eng.avgViewsPerVideo), null, ''),
      statTile('Interactions', num(eng.interactions), 'likes + comments + shares', ''),
      statTile('Engagement rate', eng.engagementRate != null ? eng.engagementRate + '%' : '–', 'interactions ÷ views', ''),
      statTile('Shares', num(eng.shares), 'last ' + eng.sampleSize + ' videos', '')
    ] : [];
    return statGrid(tiles) +
      engagementSection('Recent video engagement', eng ? '' : 'Reconnect TikTok to grant the video.list scope', engTiles) +
      sparkCard('Followers', histRange(h).map(function (r) { return r.followers; })) +
      videoTable(s.recentVideos, ['views', 'likes', 'comments', 'shares']);
  }

  /* ----------------------------------------------------------------
     SOCIAL: cross-channel roll-ups (Audience overview card) + shared
     helpers for the per-video tables and "last post" tiles.
     ---------------------------------------------------------------- */
  function relTime(iso) {
    if (!iso) return '–';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '–';
    var s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
    return Math.round(s / (86400 * 30)) + 'mo ago';
  }
  function videoTable(vids, cols) {
    if (!Array.isArray(vids) || !vids.length) return '';
    var head = '<th>Video</th><th>Posted</th>' + cols.map(function (c) { return '<th>' + esc(c.charAt(0).toUpperCase() + c.slice(1)) + '</th>'; }).join('');
    var rows = vids.slice(0, 12).map(function (v) {
      var title = (v.title && String(v.title).trim()) || v.id || 'Untitled';
      return '<tr><td title="' + esc(title) + '">' + esc(title.length > 44 ? title.slice(0, 42) + '…' : title) + '</td>' +
        '<td>' + esc(relTime(v.postedAt || v.publishedAt)) + '</td>' +
        cols.map(function (c) { return '<td>' + num(v[c]) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="adm-mini-head">Recent videos</div><div class="dash-tablewrap"><table class="dash-table adm-vidtable"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // Every connected channel with its current audience size, range history
  // (normalised to {snapshot_date, followers, extra}), engagement rate and
  // last-post time. Channels that aren't connected are simply absent.
  function connectedChannels() {
    var out = [];
    if (DISCORD_STATS.memberCount != null) out.push({
      key: 'discord', name: 'Discord', color: '#5865F2', count: DISCORD_STATS.memberCount,
      history: (DISCORD_STATS.history || []).map(function (r) { return { snapshot_date: r.snapshot_date, followers: r.member_count }; }),
      engRate: null, latestPostAt: null
    });
    if (X_STATS && X_STATS.configured) out.push({
      key: 'x', name: 'X', color: '#8a8f98', count: X_STATS.followersCount, history: X_STATS.history || [],
      engRate: X_STATS.engagement ? X_STATS.engagement.engagementRate : null, latestPostAt: X_STATS.latestPostAt || null
    });
    if (YOUTUBE_STATS && YOUTUBE_STATS.configured && YOUTUBE_STATS.subscriberCount != null) out.push({
      key: 'youtube', name: 'YouTube', color: '#f0555a', count: YOUTUBE_STATS.subscriberCount, history: YOUTUBE_STATS.history || [],
      engRate: YOUTUBE_STATS.engagement ? YOUTUBE_STATS.engagement.engagementRate : null, latestPostAt: YOUTUBE_STATS.latestPostAt || null
    });
    if (TIKTOK_STATS && TIKTOK_STATS.configured) out.push({
      key: 'tiktok', name: 'TikTok', color: '#45cf8e', count: TIKTOK_STATS.followerCount, history: TIKTOK_STATS.history || [],
      engRate: TIKTOK_STATS.engagement ? TIKTOK_STATS.engagement.engagementRate : null, latestPostAt: TIKTOK_STATS.latestPostAt || null
    });
    return out;
  }
  // { total, delta, channels } - delta is null unless every channel has a
  // baseline snapshot at/before the range start.
  function totalAudience() {
    var chans = connectedChannels();
    var total = 0, prevTotal = 0, havePrev = chans.length > 0;
    chans.forEach(function (c) {
      total += c.count || 0;
      var d = histDelta(c.history, function (r) { return r.followers; });
      if (d) prevTotal += d.base; else { havePrev = false; }
    });
    return {
      total: total,
      delta: havePrev ? { abs: total - prevTotal, pct: prevTotal ? (total - prevTotal) / prevTotal * 100 : null } : null,
      channels: chans
    };
  }
  function contentPublishedInRange(c) {
    var d = histDelta(c.history, function (r) {
      if (!r.extra) return null;
      return r.extra.tweetCount != null ? r.extra.tweetCount : r.extra.videoCount;
    });
    return d && d.abs > 0 ? d.abs : 0;
  }

  function renderAudienceOverview() {
    var el = $('admAudienceOverview'); if (!el) return;
    var ta = totalAudience();
    var chans = ta.channels;
    if (!chans.length) { el.innerHTML = '<p class="adm-empty">No channels connected yet.</p>'; return; }

    var rates = chans.filter(function (c) { return c.engRate != null; });
    var blended = rates.length
      ? Math.round(rates.reduce(function (s, c) { return s + c.engRate; }, 0) / rates.length * 100) / 100
      : null;

    var tiles = [
      deltaTile('Total audience', num(ta.total), ta.delta),
      statTile('Audience growth', ta.delta ? signed(ta.delta.abs) : '–', socialRangeLabel(),
        ta.delta && ta.delta.pct != null ? socialDeltaSpan(ta.delta) : ''),
      statTile('Blended engagement', blended != null ? blended + '%' : '–',
        rates.length ? rates.length + ' of ' + chans.length + ' channels' : 'no engagement data yet', '')
    ];

    // R3 - audience mix (donut)
    var mix = '<div class="adm-mini-head">Audience mix</div>' + donutChart(chans.map(function (c) {
      return { label: c.name, value: c.count, color: c.color, display: esc(num(c.count)), plain: num(c.count) };
    }), { centerLabel: num(ta.total), centerSub: 'total' });

    // R5 - content published this range, by channel
    var outRows = chans.map(function (c) { return { label: c.name, v: contentPublishedInRange(c), color: c.color, display: String(contentPublishedInRange(c)) }; });
    var r5 = outRows.some(function (d) { return d.v > 0; })
      ? '<div class="adm-mini-head">Content published · ' + esc(socialRangeLabel()) + '</div>' + hbars(outRows)
      : '';

    // R7 - engagement rate by channel
    var engRows = rates.map(function (c) { return { label: c.name, v: c.engRate, color: c.color, display: c.engRate + '%' }; });
    var r7 = engRows.length
      ? '<div class="adm-mini-head">Engagement rate by channel</div>' + hbars(engRows)
      : '';

    // R6 - new followers by channel
    var r6rows = chans.map(function (c) {
      var d = histDelta(c.history, function (r) { return r.followers; });
      return { name: c.name, count: c.count, d: d, last: c.latestPostAt };
    }).sort(function (a, b) { return (b.d ? b.d.abs : -1e12) - (a.d ? a.d.abs : -1e12); });
    var r6 = '<div class="adm-mini-head">Growth by channel</div><div class="dash-tablewrap"><table class="dash-table"><thead><tr><th>Channel</th><th>Audience</th><th>Change</th><th>Last post</th></tr></thead><tbody>' +
      r6rows.map(function (r) {
        return '<tr><td>' + esc(r.name) + '</td><td>' + num(r.count) + '</td><td>' +
          (r.d ? socialDeltaSpan(r.d) : '<span class="adm-sub"> - </span>') + '</td><td>' +
          (r.last ? esc(relTime(r.last)) : '<span class="adm-sub"> - </span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    el.innerHTML = statGrid(tiles) + mix + r5 + r7 + r6;
  }

  // Re-rendering a container via innerHTML throws away the open/closed
  // state of every <details> inside it. renderMarketing() runs on a 10s
  // poll (AdBlox auto-refresh), so an expanded channel dropdown would snap
  // shut a few seconds after you opened it. Snapshot which
  // <details data-collapse-key> are open, swap the HTML, then restore them.
  function setHtmlPreservingCollapse(el, html) {
    if (!el) return;
    var wasOpen = {};
    el.querySelectorAll('details[data-collapse-key]').forEach(function (d) {
      if (d.open) wasOpen[d.getAttribute('data-collapse-key')] = true;
    });
    el.innerHTML = html;
    el.querySelectorAll('details[data-collapse-key]').forEach(function (d) {
      if (wasOpen[d.getAttribute('data-collapse-key')]) d.open = true;
    });
  }

  function channelRow(c) {
    var connected = false, value = '', sub = c.note;
    if (c.key === 'discord' && DISCORD_STATS.memberCount != null) {
      connected = true;
      value = DISCORD_STATS.memberCount.toLocaleString('en-US') + ' members';
      sub = (DISCORD_STATS.onlineCount != null ? DISCORD_STATS.onlineCount.toLocaleString('en-US') + ' online' : c.note);
    } else if (c.key === 'youtube' && YOUTUBE_STATS && YOUTUBE_STATS.configured && YOUTUBE_STATS.subscriberCount != null) {
      connected = true;
      value = YOUTUBE_STATS.subscriberCount.toLocaleString('en-US') + ' subscribers';
      sub = YOUTUBE_STATS.viewCount.toLocaleString('en-US') + ' total views';
    } else if (c.key === 'x' && X_STATS && X_STATS.configured) {
      connected = true;
      value = X_STATS.followersCount.toLocaleString('en-US') + ' followers';
      sub = X_STATS.tweetCount.toLocaleString('en-US') + ' posts';
    } else if (c.key === 'tiktok' && TIKTOK_STATS && TIKTOK_STATS.configured) {
      connected = true;
      value = TIKTOK_STATS.followerCount.toLocaleString('en-US') + ' followers';
      sub = TIKTOK_STATS.videoCount.toLocaleString('en-US') + ' videos';
    } else if (c.needs) {
      sub = c.needs;
    }

    var summaryInner = '<div class="adm-channel-main"><span class="adm-channel-name">' + esc(c.name) + '</span>' +
      '<span class="adm-sub">' + esc(sub) + '</span></div>' +
      '<span class="adm-channel-trail">' +
      (connected
        ? '<span class="adm-channel-val">' + esc(value) + '</span><span class="dt-badge ok">Connected</span>'
        : (c.key === 'tiktok'
            ? '<a class="btn btn-ghost adm-btn-sm" href="' + esc(tiktokAuthorizeUrl()) + '">Connect TikTok</a>'
            : '<span class="dt-badge">Not connected</span>')) +
      (connected ? '<svg class="adm-collapse-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' : '') +
      '</span>';

    if (!connected) return '<div class="adm-channel-row">' + summaryInner + '</div>';

    return '<details class="adm-collapse adm-channel-collapse" data-collapse-key="chan-' + esc(c.key) + '">' +
      '<summary class="adm-channel-row">' + summaryInner + '</summary>' +
      '<div class="adm-collapse-body">' + socialPanelBody(c.key) + '</div>' +
      '</details>';
  }

  /* ================================================================
     CAMPAIGN LINKS

     Admin-managed trackable links (?cmp=CODE), separate from the
     user-to-user referral program. A click is counted the moment the
     link is visited (track-campaign-click); a conversion is any paid
     order whose campaign_code matches, which works for guest checkouts
     too since it isn't tied to a signed-in profile the way referrals are.
     ================================================================ */
  var CAMPAIGNS = [];
  function refreshCampaigns() {
    return invokeAdminFn('admin-campaign-links', { action: 'list' }).then(function (d) {
      CAMPAIGNS = d.links || [];
      if (curPanel === 'marketing') renderMarketing();
    }).catch(function (err) { console.error('[admin] failed to load campaigns:', err.message); });
  }
  function campaignUrl(c) {
    return location.origin + c.destination + (c.destination.indexOf('?') >= 0 ? '&' : '?') + 'cmp=' + encodeURIComponent(c.code);
  }
  function renderCampaigns() {
    var body = $('admCampaignsBody'); if (!body) return;
    body.innerHTML = CAMPAIGNS.map(function (c) {
      var rate = c.conversionRate == null ? '–' : (c.conversionRate * 100).toFixed(1) + '%';
      return '<tr data-id="' + esc(c.id) + '" data-code="' + esc(c.code) + '">' +
        '<td><strong>' + esc(c.label) + '</strong><div class="adm-sub adm-campaign-url">' + esc(campaignUrl(c)) + '</div></td>' +
        '<td>' + c.clicks.toLocaleString('en-US') + '</td>' +
        '<td>' + c.conversions.toLocaleString('en-US') + '</td>' +
        '<td>' + rate + '</td>' +
        '<td>' + usd(c.revenue) + '</td>' +
        '<td>' + (c.active ? statusBadge('completed') : statusBadge('refunded')) + '</td>' +
        '<td class="adm-row-actions">' +
          '<button class="adm-icon-btn adm-campaign-copy" type="button" title="Copy link" aria-label="Copy link">' + ADM_ICON_COPY + '</button>' +
          '<button class="adm-icon-btn adm-campaign-info" type="button" title="Details" aria-label="Details">' + ADM_ICON_INFO + '</button>' +
          '<button class="adm-icon-btn adm-campaign-toggle" type="button" title="' + (c.active ? 'Deactivate' : 'Activate') + '">' + (c.active ? ADM_ICON_PAUSE : ADM_ICON_PLAY) + '</button>' +
          '<button class="adm-icon-btn adm-campaign-rename" type="button" title="Rename">' + ADM_ICON_EDIT + '</button>' +
          '<button class="adm-icon-btn adm-campaign-delete" type="button" title="Delete">' + ADM_ICON_TRASH + '</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="adm-empty">No campaign links yet - add one above.</td></tr>';
  }

  var campaignCreateForm = $('admCampaignCreateForm');
  if (campaignCreateForm) campaignCreateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var codeEl = $('admCampaignCode'), labelEl = $('admCampaignLabel'), destEl = $('admCampaignDestination'), msgEl = $('admCampaignCreateMsg');
    var label = labelEl.value;
    invokeAdminFn('admin-campaign-links', { action: 'create', code: codeEl.value, label: label, destination: destEl.value || '/' }, 'Could not create campaign.').then(function () {
      codeEl.value = ''; labelEl.value = ''; destEl.value = ''; if (msgEl) msgEl.textContent = '';
      logAudit('Created campaign link "' + label + '"');
      return refreshCampaigns();
    }).catch(function (err) { if (msgEl) msgEl.textContent = err.message || 'Could not create campaign.'; });
  });

  var campaignsBody = $('admCampaignsBody');
  if (campaignsBody) campaignsBody.addEventListener('click', async function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id'), code = tr.getAttribute('data-code');
    var c = CAMPAIGNS.filter(function (x) { return x.id === id; })[0]; if (!c) return;

    if (e.target.closest('.adm-campaign-copy')) {
      copyCampaignLink(campaignUrl(c), e.target.closest('.adm-campaign-copy'));
    } else if (e.target.closest('.adm-campaign-info')) {
      openCampaignDetail(c);
    } else if (e.target.closest('.adm-campaign-toggle')) {
      invokeAdminFn('admin-campaign-links', { action: 'update', id: id, patch: { active: !c.active } }, 'Could not update campaign.').then(function () {
        logAudit((c.active ? 'Deactivated' : 'Activated') + ' campaign link "' + c.label + '"');
        return refreshCampaigns();
      }).catch(function (err) { alert(err.message || 'Could not update campaign.'); });
    } else if (e.target.closest('.adm-campaign-rename')) {
      var newLabel = await dialogPrompt('Choose a clear internal label for this campaign link.', c.label, { title: 'Rename campaign link', inputLabel: 'Link label', acceptLabel: 'Rename' });
      if (newLabel == null || !newLabel.trim() || newLabel === c.label) return;
      invokeAdminFn('admin-campaign-links', { action: 'update', id: id, patch: { label: newLabel.trim() } }, 'Could not rename campaign.').then(function () {
        logAudit('Renamed campaign link "' + c.label + '" to "' + newLabel.trim() + '"');
        return refreshCampaigns();
      }).catch(function (err) { alert(err.message || 'Could not rename campaign.'); });
    } else if (e.target.closest('.adm-campaign-delete')) {
      if (!(await dialogConfirm('Delete “' + c.label + '” (?cmp=' + code + ')? This will not affect past orders, only future click tracking.', { title: 'Delete campaign link', acceptLabel: 'Delete link' }))) return;
      invokeAdminFn('admin-campaign-links', { action: 'delete', id: id }, 'Could not delete campaign.').then(function () {
        logAudit('Deleted campaign link "' + c.label + '"');
        return refreshCampaigns();
      }).catch(function (err) { alert(err.message || 'Could not delete campaign.'); });
    }
  });

  function copyCampaignLink(url, btn) {
    var done = function () {
      if (!btn) return;
      var prev = btn.innerHTML;
      btn.innerHTML = ADM_ICON_CHECK;
      setTimeout(function () { btn.innerHTML = prev; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { dialogPrompt('Copy this link from the field below.', url, { title: 'Copy campaign link', inputLabel: 'Campaign URL', acceptLabel: 'Close' }); });
    } else {
      dialogPrompt('Copy this link from the field below.', url, { title: 'Copy campaign link', inputLabel: 'Campaign URL', acceptLabel: 'Close' });
    }
  }

  function openCampaignDetail(c) {
    var overlay = $('admCampaignDetailOverlay'); if (!overlay) return;
    $('admCampaignDetailTitle').textContent = c.label;
    $('admCampaignDetailSub').innerHTML = '<span class="adm-campaign-url">' + esc(campaignUrl(c)) + '</span> · added ' + fmtDate(new Date(c.createdAt));
    var rate = c.conversionRate == null ? '–' : (c.conversionRate * 100).toFixed(1) + '%';
    $('admCampaignDetailStats').innerHTML = [
      statTile('Clicks', c.clicks.toLocaleString('en-US'), null, ''),
      statTile('Conversions', c.conversions.toLocaleString('en-US'), null, ''),
      statTile('Conversion rate', rate, null, ''),
      statTile('Revenue', usd(c.revenue), null, '')
    ].join('');
    $('admCampaignDetailBody').innerHTML = '<tr><td colspan="4" class="adm-empty">Loading…</td></tr>';
    overlay.hidden = false;

    invokeAdminFn('admin-campaign-links', { action: 'detail', code: c.code }, 'Could not load details.').then(function (d) {
      var orders = d.orders || [];
      $('admCampaignDetailBody').innerHTML = orders.map(function (o) {
        return '<tr><td>' + fmtDate(new Date(o.createdAt)) + '</td><td>' + esc(o.buyer) + '</td><td>' + usd(o.totalUsd) + '</td>' +
          '<td>' + statusBadge(o.status === 'paid' ? 'completed' : o.status) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="adm-empty">No orders attributed to this link yet.</td></tr>';
    }).catch(function (err) {
      $('admCampaignDetailBody').innerHTML = '<tr><td colspan="4" class="adm-empty">' + esc(err.message || 'Could not load details.') + '</td></tr>';
    });
  }
  var campaignDetailClose = $('admCampaignDetailClose');
  if (campaignDetailClose) campaignDetailClose.addEventListener('click', function () { $('admCampaignDetailOverlay').hidden = true; });
  var campaignDetailOverlay = $('admCampaignDetailOverlay');
  if (campaignDetailOverlay) campaignDetailOverlay.addEventListener('click', function (e) { if (e.target === campaignDetailOverlay) campaignDetailOverlay.hidden = true; });

  function renderMarketing() {
    var sales = REFERRALS.reduce(function (s, r) { return s + r.sales; }, 0);
    var owed = REFERRALS.reduce(function (s, r) { return s + (r.earnedUSD - r.paidUSD); }, 0);

    if ($('admMktStats')) {
      $('admMktStats').innerHTML = [
        statTile('Discord members', DISCORD_STATS.memberCount != null ? DISCORD_STATS.memberCount.toLocaleString('en-US') : '–', DISCORD_STATS.onlineCount != null ? (DISCORD_STATS.onlineCount.toLocaleString('en-US') + ' online') : '', ''),
        statTile('Referral sales', sales.toLocaleString('en-US'), null, ''),
        statTile('Owed to affiliates', usd(owed), null, '')
      ].join('');
    }

    renderAudienceOverview();

    if ($('admMktChannels')) {
      setHtmlPreservingCollapse($('admMktChannels'), MKT_CHANNELS.map(channelRow).join(''));
    }

    renderCampaigns();

    if ($('admAdbloxStats')) {
      var adMsg = $('admAdbloxMsg');
      if (ADBLOX_STATS) {
        if (adMsg) adMsg.textContent = '';
        var s = ADBLOX_STATS.sent;
        // Auto-refreshing every 10s means most ticks change nothing - only
        // flash the tiles whose number actually moved since the last
        // render, not all four every time regardless.
        var adNow = { today: s ? s.today : 0, last7d: s ? s.last_7d : 0, last30d: s ? s.last_30d : 0, allTime: s ? s.all_time : 0 };
        var adPrev = ADBLOX_STAT_PREV;
        $('admAdbloxStats').innerHTML = [
          statTile('Ads sent today', adNow.today.toLocaleString('en-US'), s ? (s.yesterday.toLocaleString('en-US') + ' yesterday') : null, '', { flash: adPrev && adPrev.today !== adNow.today }),
          statTile('Ads sent (7d)', adNow.last7d.toLocaleString('en-US'), null, '', { flash: adPrev && adPrev.last7d !== adNow.last7d }),
          statTile('Ads sent (30d)', adNow.last30d.toLocaleString('en-US'), null, '', { flash: adPrev && adPrev.last30d !== adNow.last30d }),
          statTile('Ads sent (all-time)', adNow.allTime.toLocaleString('en-US'), null, '', { flash: adPrev && adPrev.allTime !== adNow.allTime })
        ].join('');
        ADBLOX_STAT_PREV = adNow;
      } else {
        $('admAdbloxStats').innerHTML = '';
        if (adMsg) adMsg.textContent = ADBLOX_ERROR || 'Loading…';
      }
    }

    if ($('admAdbloxServersBody')) {
      var serversSorted = ADBLOX_SERVERS.slice().sort(function (a, b) { return (b.sent || 0) - (a.sent || 0); });
      $('admAdbloxServersBody').innerHTML = serversSorted.map(function (sv) {
        return '<tr><td>' +
          (sv.guild_icon_url ? '<span style="background-image:url(\'' + esc(sv.guild_icon_url) + '\');background-size:cover;width:20px;height:20px;border-radius:50%;display:inline-block;vertical-align:middle;margin-right:8px;"></span>' : '') +
          esc(sv.guild_name || sv.guild_id) + '</td>' +
          '<td>' + (sv.sent || 0).toLocaleString('en-US') + '</td>' +
          '<td>' + (sv.failed ? esc(sv.failed) : '0') + '</td>' +
          '<td>' + (sv.last_sent_at ? fmtDateTime(parseAdbloxUtc(sv.last_sent_at)) : '–') + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="adm-empty">No server activity yet.</td></tr>';
    }

    if ($('admAdbloxLogsBody')) {
      $('admAdbloxLogsBody').innerHTML = ADBLOX_LOGS.map(function (lg) {
        var status = lg.status === 'sent' ? '<span class="dt-badge ok">Sent</span>' : lg.status === 'failed' ? '<span class="dt-badge err">Failed</span>' : '<span class="dt-badge warn">' + esc(lg.status) + '</span>';
        return '<tr><td>' + (lg.sent_at ? fmtDateTime(parseAdbloxUtc(lg.sent_at)) : '–') + '</td>' +
          '<td>' + esc(lg.ad_title || '') + '</td>' +
          '<td>' + esc(lg.guild_name || lg.guild_id || '') + '</td>' +
          '<td>' + esc(lg.channel_name || lg.channel_id || '') + '</td>' +
          '<td>' + status + (lg.error_message ? ' <span class="adm-sub" title="' + esc(lg.error_message) + '">⚠</span>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="adm-empty">No activity yet.</td></tr>';
      var loadMoreBtn = $('admAdbloxLoadMore');
      if (loadMoreBtn) loadMoreBtn.hidden = !ADBLOX_NEXT_CURSOR;
    }

    renderEmailMarketing();
    renderAutomations();

    if ($('admReferralBody')) {
      $('admReferralBody').innerHTML = REFERRALS.map(function (r) {
        return '<tr><td class="dt-mono">' + esc(r.code) + '</td><td>' + esc(r.owner) + '</td><td>' + r.sales + '</td><td>' + usd(r.earnedUSD) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="adm-empty">No referral codes yet.</td></tr>';
      if ($('admAffiliateOwed')) $('admAffiliateOwed').textContent = usd(owed);
      renderPayouts();
    }
  }

  /* ================================================================
     EMAIL MARKETING (part of the Marketing panel)
     ================================================================ */
  var EMAIL_STATS = { total: 0, optedIn: 0, unsubscribed: 0, allAccounts: 0 };
  var EMAIL_CAMPAIGNS = [];
  var EMAIL_RECIPIENTS = []; // consented addresses only: { email, username, status, joined, provider, optInSource, optInAt, unsubscribed }
  var EMAIL_CONFIGURED = null; // null = not checked yet
  var EMAIL_CAN_ANNOUNCE = false; // caller is whitelisted to send announcements
  var SYNTH_EMAIL_RE = /@roblox\.coldd\.internal$/i;

  var MARKETING_OPTINS = []; // [{ email, source, subscribed_at, discount_code, unsubscribed_at }]
  function refreshMarketingOptins() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('marketing_optins')
      .select('email, source, subscribed_at, discount_code, unsubscribed_at').limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load marketing opt-ins:', res.error.message); return; }
      MARKETING_OPTINS = (res.data || []).filter(function (r) { return r.email; });
    });
  }
  function refreshEmailStats() {
    if (!window.coldSupabase) return Promise.resolve();
    // The email list is the marketing CONSENT ledger - marketing_optins
    // (checkout box / discount popup / signup form) plus any account whose
    // Notifications > promotions toggle is on. Non-consented accounts and
    // synthetic Roblox logins are not part of it. profiles is loaded only
    // to enrich each consented address with account facts (name, provider,
    // ban state) and to fold in toggle-based opt-ins.
    return refreshMarketingOptins().then(function () {
    return window.coldSupabase.from('profiles')
      .select('id, email, username, marketing_unsubscribed, banned, created_at, discord_id, roblox_id, notification_prefs')
      .limit(20000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load subscriber stats:', res.error.message); return; }
      var profiles = (res.data || []).filter(function (r) { return r.email; });
      var byEmail = {};
      profiles.forEach(function (r) { byEmail[r.email.toLowerCase()] = r; });
      EMAIL_STATS.allAccounts = profiles.filter(function (r) { return !SYNTH_EMAIL_RE.test(r.email); }).length;

      // Start from the opt-in rows, keyed by lowercased email.
      var merged = {};
      MARKETING_OPTINS.forEach(function (o) {
        var lc = o.email.toLowerCase();
        if (SYNTH_EMAIL_RE.test(lc)) return;
        merged[lc] = { email: o.email, optInSource: o.source || 'unknown', optInAt: o.subscribed_at || null, unsubscribed: !!o.unsubscribed_at };
      });
      // Fold in accounts opted in via the promotions toggle only.
      profiles.forEach(function (r) {
        var lc = r.email.toLowerCase();
        if (SYNTH_EMAIL_RE.test(lc)) return;
        var promos = !!(r.notification_prefs && r.notification_prefs.promotions);
        if (!promos || merged[lc]) return;
        merged[lc] = { email: r.email, optInSource: 'account settings', optInAt: null, unsubscribed: !!r.marketing_unsubscribed };
      });

      EMAIL_RECIPIENTS = Object.keys(merged).map(function (lc) {
        var m = merged[lc];
        var p = byEmail[lc] || null;
        var unsub = m.unsubscribed || !!(p && p.marketing_unsubscribed);
        var banned = !!(p && p.banned);
        return {
          email: m.email,
          username: p ? (p.username || null) : null,
          provider: p ? (p.roblox_id ? 'Roblox' : p.discord_id ? 'Discord' : 'Email / Google') : 'Guest (no account)',
          optInSource: m.optInSource,
          optInAt: m.optInAt,
          joined: p ? (p.created_at || null) : (m.optInAt || null),
          unsubscribed: unsub,
          status: banned ? 'banned' : unsub ? 'unsubscribed' : 'optedin'
        };
      }).sort(function (a, b) { return (b.optInAt || b.joined || '').localeCompare(a.optInAt || a.joined || ''); });

      EMAIL_STATS.total = EMAIL_RECIPIENTS.length;
      EMAIL_STATS.optedIn = EMAIL_RECIPIENTS.filter(function (r) { return r.status === 'optedin'; }).length;
      EMAIL_STATS.unsubscribed = EMAIL_RECIPIENTS.filter(function (r) { return r.unsubscribed; }).length;
      if (curPanel === 'marketing') renderEmailMarketing();
    });
    });
  }
  // Every address in this list is a real marketing opt-in - the popout
  // just shows where/when it came from and whether it was later withdrawn.
  function emailConsentInfo(r) {
    var lines = [];
    lines.push(['Account', (r.username || (r.provider === 'Guest (no account)' ? 'Guest checkout / popup - no account' : '–'))]);
    if (r.joined) lines.push(['Signed up', fmtDateTime(new Date(r.joined)) + ' · via ' + r.provider]);
    lines.push(['Opted in', (r.optInAt ? fmtDateTime(new Date(r.optInAt)) + ' · ' : '') + 'via ' + (r.optInSource || 'unknown') +
      (r.unsubscribed ? ' (later unsubscribed)' : '')]);
    lines.push(['Consent basis', 'Explicit marketing opt-in.' + (r.unsubscribed ? ' Withdrawn - excluded from all marketing sends.' : ' Receives marketing and discount emails.')]);
    lines.push(['Marketing status', r.status === 'optedin' ? 'Opted in'
      : r.status === 'unsubscribed' ? 'Unsubscribed'
      : 'Banned (excluded)']);
    return lines;
  }
  // Per-recipient campaign history from email_events (Resend webhook).
  function emailEventsFor(email) {
    var lc = String(email || '').toLowerCase();
    var mine = EMAIL_EVENT_ROWS.filter(function (e) { return (e.recipient || '').toLowerCase() === lc; });
    var totals = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 };
    var byCampaign = {};
    mine.forEach(function (e) {
      var t = (e.type || '').replace('email.', '');
      if (totals[t] != null) totals[t]++;
      var k = e.campaign_id || '_none';
      if (!byCampaign[k]) byCampaign[k] = { campaignId: e.campaign_id, first: e.occurred_at, types: {} };
      byCampaign[k].types[t] = e.occurred_at;
      if (e.occurred_at < byCampaign[k].first) byCampaign[k].first = e.occurred_at;
    });
    var campaigns = Object.keys(byCampaign).map(function (k) {
      var c = byCampaign[k];
      var meta = EMAIL_CAMPAIGNS.filter(function (x) { return x.id === c.campaignId; })[0];
      return {
        subject: meta ? meta.subject : (c.campaignId ? 'Campaign ' + String(c.campaignId).slice(0, 8) : 'Lifecycle / automated email'),
        sentAt: c.types.sent || c.types.delivered || c.first,
        delivered: !!c.types.delivered,
        opened: c.types.opened || null,
        clicked: c.types.clicked || null,
        bounced: !!c.types.bounced
      };
    }).sort(function (a, b) { return (b.sentAt || '').localeCompare(a.sentAt || ''); });
    var openRate = totals.delivered ? totals.opened / totals.delivered * 100 : null;
    var clickRate = totals.delivered ? totals.clicked / totals.delivered * 100 : null;
    return { totals: totals, openRate: openRate, clickRate: clickRate, campaigns: campaigns, any: mine.length > 0 };
  }
  function refreshEmailCampaigns() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('email_campaigns').select('*').order('created_at', { ascending: false }).limit(200).then(function (res) {
      if (res.error) { console.error('[admin] failed to load campaigns:', res.error.message); return; }
      EMAIL_CAMPAIGNS = res.data || [];
      if (curPanel === 'marketing') renderEmailMarketing();
    });
  }
  // Resend delivery events (public.email_events, written by resend-webhook).
  // Grouped per campaign for open/click rates, kept raw for the
  // revenue-attribution window.
  var EMAIL_EVENTS_BY_CAMPAIGN = {};
  var EMAIL_EVENT_ROWS = [];
  function refreshEmailEvents() {
    if (!window.coldSupabase) return Promise.resolve();
    var cutoff = daysAgo(180).toISOString();
    return window.coldSupabase.from('email_events').select('type, recipient, campaign_id, occurred_at').gte('occurred_at', cutoff).limit(50000).then(function (res) {
      if (res.error) { console.error('[admin] failed to load email events:', res.error.message); return; }
      EMAIL_EVENT_ROWS = res.data || [];
      var by = {};
      EMAIL_EVENT_ROWS.forEach(function (e) {
        var k = e.campaign_id || '_none';
        if (!by[k]) by[k] = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, openers: {}, clickers: {} };
        var r = (e.recipient || '').toLowerCase();
        if (e.type === 'email.sent') by[k].sent++;
        else if (e.type === 'email.delivered') by[k].delivered++;
        else if (e.type === 'email.opened') { by[k].opened++; if (r) by[k].openers[r] = true; }
        else if (e.type === 'email.clicked') { by[k].clicked++; if (r) by[k].clickers[r] = true; }
        else if (e.type === 'email.bounced') by[k].bounced++;
        else if (e.type === 'email.complained') by[k].complained++;
      });
      EMAIL_EVENTS_BY_CAMPAIGN = by;
      if (curPanel === 'marketing') renderEmailMarketing();
    });
  }
  // Completed orders in range whose buyer received a marketing email in the
  // 7 days before the order. A directional attribution, not a hard claim -
  // last-touch-ish within a window.
  function emailAttributedRevenue() {
    var byRcpt = {};
    EMAIL_EVENT_ROWS.forEach(function (e) {
      if ((e.type !== 'email.delivered' && e.type !== 'email.sent') || !e.recipient) return;
      var r = e.recipient.toLowerCase();
      (byRcpt[r] = byRcpt[r] || []).push(new Date(e.occurred_at).getTime());
    });
    var WIN = 7 * 86400000, rev = 0, count = 0;
    completedInRange().forEach(function (o) {
      if (!o.userEmail) return;
      var sends = byRcpt[o.userEmail.toLowerCase()];
      if (!sends) return;
      var ot = new Date(o.date).getTime();
      if (sends.some(function (t) { return t <= ot && ot - t <= WIN; })) { rev += Number(o.total) || 0; count++; }
    });
    return { usd: rev, count: count };
  }
  function refreshEmailConfigStatus() {
    return invokeAdminFn('admin-send-campaign', { action: 'status' }, '').then(function (data) {
      EMAIL_CONFIGURED = !!data.configured;
      EMAIL_CAN_ANNOUNCE = !!data.canAnnounce;
      var aw = $('admCampaignAudienceWrap');
      if (aw) aw.hidden = !EMAIL_CAN_ANNOUNCE;
      if (curPanel === 'marketing') renderEmailMarketing();
    }).catch(function () { EMAIL_CONFIGURED = null; });
  }

  // Minimal formatting for campaign bodies: blank line = new paragraph,
  // **bold**. Anything richer would need a real editor, which this doesn't
  // have yet - this covers the actual shape of a newsletter/announcement.
  function simpleMarkdownToHtml(text) {
    var paras = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
    return paras.map(function (p) {
      var line = esc(p.trim()).replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      return line ? '<p style="margin:0 0 16px;">' + line + '</p>' : '';
    }).join('');
  }

  function renderEmailMarketing() {
    var warnEl = $('admEmailConfigWarning');
    if (warnEl) {
      warnEl.innerHTML = EMAIL_CONFIGURED === false
        ? '<div class="dt-badge err" style="display:inline-block;margin-bottom:14px;">Email sending is not configured - set the RESEND_API_KEY secret to enable sends.</div>'
        : '';
    }

    if ($('admEmailStats')) {
      var att = emailAttributedRevenue();
      $('admEmailStats').innerHTML = [
        statTile('Opted in', EMAIL_STATS.optedIn.toLocaleString('en-US'), 'consented - every marketing send goes here', ''),
        statTile('Unsubscribed', EMAIL_STATS.unsubscribed.toLocaleString('en-US'), 'opted in, then withdrew', ''),
        statTile('All accounts', EMAIL_STATS.allAccounts.toLocaleString('en-US'), 'reachable by an announcement, regardless of opt-in', ''),
        statTile('Revenue from email', usd(att.usd), att.count + ' order' + (att.count === 1 ? '' : 's') + ' within 7d of a send', '')
      ].join('');
    }

    renderEmailList();

    // NB: id is admEmailCampaignsBody, not admCampaignsBody - the Campaigns
    // (trackable links) card higher up the same panel already owns that id,
    // and getElementById returning the first match meant these rows used to
    // land in the wrong table.
    var body = $('admEmailCampaignsBody');
    if (body) {
      body.innerHTML = EMAIL_CAMPAIGNS.map(function (c) {
        var status = c.status === 'sent' ? '<span class="dt-badge ok">Sent</span>' : c.status === 'failed' ? '<span class="dt-badge err">Failed</span>' : c.status === 'sending' ? '<span class="dt-badge warn">Sending</span>' : '<span class="dt-badge">Draft</span>';
        var ev = EMAIL_EVENTS_BY_CAMPAIGN[c.id];
        var base = ev ? (ev.delivered || ev.sent || c.sent_count || 0) : (c.sent_count || 0);
        function rate(users) {
          if (!ev || !base) return '<span class="adm-sub"> - </span>';
          var n = Object.keys(users).length;
          return pct(n / base * 100) + ' <span class="adm-sub">(' + n + ')</span>';
        }
        return '<tr><td>' + fmtDateTime(new Date(c.created_at)) + '</td><td>' + esc(c.subject) + '</td><td>' + status + '</td><td>' + (c.sent_count || 0) + ' / ' + (c.recipient_count || 0) + '</td><td>' + (c.failed_count || 0) + '</td><td>' + rate(ev ? ev.openers : {}) + '</td><td>' + rate(ev ? ev.clickers : {}) + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="adm-empty">No campaigns sent yet.</td></tr>';
    }
  }

  var EMAIL_LIST_CAP = 500; // render ceiling; search still spans the whole list
  function emailListFiltered() {
    var q = ($('admEmailListSearch') && $('admEmailListSearch').value || '').trim().toLowerCase();
    if (!q) return EMAIL_RECIPIENTS;
    return EMAIL_RECIPIENTS.filter(function (r) { return r.email.toLowerCase().indexOf(q) !== -1; });
  }
  function renderEmailList() {
    var body = $('admEmailListBody');
    if (!body) return;
    var badge = {
      optedin: '<span class="dt-badge ok">Opted in</span>',
      unsubscribed: '<span class="dt-badge">Unsubscribed</span>',
      banned: '<span class="dt-badge err">Banned</span>'
    };
    var rows = emailListFiltered();
    var shown = rows.slice(0, EMAIL_LIST_CAP);
    body.innerHTML = shown.map(function (r) {
      return '<tr><td><button type="button" class="adm-email-info" data-email="' + esc(r.email) + '" title="Consent &amp; email history">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>' +
        '</button><span class="adm-email-addr">' + esc(r.email) + '</span></td>' +
        '<td>' + (badge[r.status] || '') + '</td><td>' +
        (r.joined ? fmtDate(new Date(r.joined)) : '–') + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="adm-empty">No matching addresses.</td></tr>';
    var note = $('admEmailListNote');
    if (note) {
      var base = EMAIL_STATS.optedIn.toLocaleString('en-US') + ' opted in' +
        (EMAIL_STATS.unsubscribed ? ' · ' + EMAIL_STATS.unsubscribed.toLocaleString('en-US') + ' later unsubscribed' : '') +
        '. Consented addresses only - non-opted-in accounts and Roblox logins are not shown.';
      note.textContent = rows.length > shown.length
        ? 'Showing first ' + shown.length + ' of ' + rows.length.toLocaleString('en-US') + ' matches - narrow the search to see the rest. ' + base
        : base;
    }
  }

  // Per-address consent + email-history popout.
  function openEmailInfo(email) {
    var r = EMAIL_RECIPIENTS.filter(function (x) { return x.email === email; })[0];
    if (!r) return;
    var ov = $('admEmailInfoOverlay'); if (!ov) return;
    $('admEmailInfoTitle').textContent = r.email;
    var stLabel = { optedin: 'Opted in', unsubscribed: 'Unsubscribed', banned: 'Banned' }[r.status] || r.status;
    $('admEmailInfoSub').innerHTML = (r.username ? esc(r.username) + ' · ' : '') + esc(r.provider) +
      ' · <span class="dt-badge ' + (r.status === 'optedin' ? 'ok' : r.status === 'banned' ? 'err' : '') + '">' + esc(stLabel) + '</span>';

    $('admEmailInfoConsent').innerHTML = emailConsentInfo(r).map(function (row) {
      return '<div class="adm-kv"><span>' + esc(row[0]) + '</span><span>' + esc(row[1]) + '</span></div>';
    }).join('');

    var ev = emailEventsFor(r.email);
    var t = ev.totals;
    if (!ev.any) {
      $('admEmailInfoStats').innerHTML = '<p class="adm-sub" style="margin:0;">No campaign emails have been sent to this address yet' +
        (EMAIL_EVENT_ROWS.length ? '.' : ' (delivery tracking starts once the Resend webhook is connected).') + '</p>';
      $('admEmailInfoHistory').innerHTML = '';
    } else {
      $('admEmailInfoStats').innerHTML = statGrid([
        statTile('Sent', num(t.sent || t.delivered), null, ''),
        statTile('Delivered', num(t.delivered), t.bounced ? num(t.bounced) + ' bounced' : null, ''),
        statTile('Opened', num(t.opened), ev.openRate != null ? pct(ev.openRate) + ' rate' : null, ''),
        statTile('Clicked', num(t.clicked), ev.clickRate != null ? pct(ev.clickRate) + ' rate' : null, ''),
        statTile('Marked spam', num(t.complained), null, '')
      ]);
      $('admEmailInfoHistory').innerHTML = '<div class="adm-mini-head">Emails sent to this address</div>' +
        ev.campaigns.map(function (c) {
          var chips = [];
          if (c.bounced) chips.push('<span class="dt-badge err">Bounced</span>');
          else if (c.delivered) chips.push('<span class="dt-badge ok">Delivered</span>');
          if (c.opened) chips.push('<span class="dt-badge">Opened</span>');
          if (c.clicked) chips.push('<span class="dt-badge">Clicked</span>');
          return '<details class="adm-collapse" data-collapse-key="em-' + esc(c.subject) + '" style="border:1px solid var(--hairline);border-radius:10px;padding:12px 14px;margin-top:8px;">' +
            '<summary style="display:flex;justify-content:space-between;gap:12px;align-items:center;cursor:pointer;list-style:none;">' +
              '<span>' + esc(c.subject) + '</span>' +
              '<span class="adm-sub" style="flex:0 0 auto;">' + (c.sentAt ? fmtDate(new Date(c.sentAt)) : '–') + '</span>' +
            '</summary>' +
            '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">' + (chips.join('') || '<span class="adm-sub">No delivery events recorded</span>') + '</div>' +
            (c.opened ? '<p class="adm-sub" style="margin:8px 0 0;">Opened ' + fmtDateTime(new Date(c.opened)) + '</p>' : '') +
            (c.clicked ? '<p class="adm-sub" style="margin:4px 0 0;">Clicked a link ' + fmtDateTime(new Date(c.clicked)) + '</p>' : '') +
          '</details>';
        }).join('');
    }
    ov.hidden = false;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.adm-email-info');
    if (b) { e.preventDefault(); openEmailInfo(b.getAttribute('data-email')); return; }
    var ov = $('admEmailInfoOverlay');
    if (ov && !ov.hidden && (e.target === ov || e.target.closest('#admEmailInfoClose'))) ov.hidden = true;
  });

  // Two source modes share one textarea: 'simple' runs it through the
  // markdown-lite converter above, 'html' sends it through untouched (the
  // admin is authoring real markup directly). Whichever mode is active
  // decides what bodyHtml() returns and what the preview iframe renders.
  var campaignMode = 'simple';
  var campaignAudience = 'marketing'; // 'marketing' | 'announcement'
  function campaignBodyHtml() {
    var raw = $('admCampaignBody').value;
    return campaignMode === 'html' ? raw : simpleMarkdownToHtml(raw);
  }
  var campaignAudienceSwitch = document.querySelector('.adm-campaign-audience');
  if (campaignAudienceSwitch) campaignAudienceSwitch.addEventListener('click', function (e) {
    var btn = e.target.closest('.bt-opt');
    if (!btn) return;
    campaignAudience = btn.getAttribute('data-audience');
    campaignAudienceSwitch.querySelectorAll('.bt-opt').forEach(function (o) {
      var active = o === btn;
      o.classList.toggle('active', active);
      o.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var sendLabel = $('admCampaignSendBtn') && $('admCampaignSendBtn').querySelector('.btn-label');
    if (sendLabel) sendLabel.textContent = campaignAudience === 'announcement' ? 'Send announcement' : 'Send to opted-in subscribers';
    var hint = $('admCampaignAudienceHint');
    if (hint) hint.textContent = campaignAudience === 'announcement'
      ? 'Goes to every account (' + (EMAIL_STATS.allAccounts || 0).toLocaleString('en-US') + ') regardless of opt-in. For service messages only - ToS changes, outages.'
      : 'Goes to the ' + (EMAIL_STATS.optedIn || 0).toLocaleString('en-US') + ' opted-in subscribers only.';
  });
  var campaignModeSwitch = document.querySelector('.adm-campaign-mode');
  function setCampaignMode(mode) {
    campaignMode = mode === 'html' ? 'html' : 'simple';
    if (campaignModeSwitch) campaignModeSwitch.querySelectorAll('.bt-opt').forEach(function (o) {
      var active = o.getAttribute('data-mode') === campaignMode;
      o.classList.toggle('active', active);
      o.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var bodyEl = $('admCampaignBody');
    var labelEl = $('admCampaignBodyLabel');
    if (bodyEl) bodyEl.placeholder = campaignMode === 'html'
      ? '<p>Write raw HTML here. It is sent to Resend exactly as written.</p>'
      : 'Write your email. Blank lines start a new paragraph, **text** for bold.';
    if (labelEl) labelEl.textContent = campaignMode === 'html' ? 'Body (raw HTML)' : 'Body';
    updateCampaignPreview();
  }
  if (campaignModeSwitch) campaignModeSwitch.addEventListener('click', function (e) {
    var btn = e.target.closest('.bt-opt');
    if (btn) setCampaignMode(btn.getAttribute('data-mode'));
  });

  /* ---- Email templates (reusable subject + body, stored per account) ---- */
  var TEMPLATES = [];
  var templateDropdown = makeDropdown($('admTemplateDD'), {
    valueInput: $('admTemplateSel'), placeholder: 'No saved templates',
    searchable: true
  });
  function templateMsg(text, ok) {
    var m = $('admTemplateMsg'); if (!m) return;
    m.textContent = text || '';
    m.style.color = text ? (ok ? 'var(--price)' : 'var(--accent)') : '';
  }
  function refreshTemplates() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('email_templates').select('*').order('name').then(function (res) {
      if (res.error) { console.error('[admin] templates load failed:', res.error.message); return; }
      TEMPLATES = res.data || [];
      var sel = templateDropdown.getValue();
      templateDropdown.setOptions(TEMPLATES.map(function (t) { return { value: t.id, label: t.name }; }),
        TEMPLATES.some(function (t) { return t.id === sel; }) ? sel : (TEMPLATES[0] ? TEMPLATES[0].id : ''));
      var bar = $('admTemplateBar');
      if (bar) bar.querySelector('#admTemplateDD .adm-dd-val').classList.toggle('placeholder', !TEMPLATES.length);
    });
  }
  var tplLoadBtn = $('admTemplateLoadBtn');
  if (tplLoadBtn) tplLoadBtn.addEventListener('click', function () {
    if (!can('admin')) return;
    var t = TEMPLATES.filter(function (x) { return x.id === templateDropdown.getValue(); })[0];
    if (!t) { templateMsg('Pick a template first.'); return; }
    $('admCampaignSubject').value = t.subject || '';
    $('admCampaignBody').value = t.body_text || '';
    setCampaignMode(t.mode || 'simple');
    updateCampaignPreview();
    templateMsg('Loaded "' + t.name + '".', true);
  });
  var tplSaveBtn = $('admTemplateSaveBtn');
  if (tplSaveBtn) tplSaveBtn.addEventListener('click', async function () {
    if (!can('admin')) return;
    var subject = $('admCampaignSubject').value.trim();
    var body = $('admCampaignBody').value;
    if (!subject && !body.trim()) { templateMsg('Nothing to save - write a subject or body first.'); return; }
    var existing = TEMPLATES.filter(function (x) { return x.id === templateDropdown.getValue(); })[0];
    var suggested = existing ? existing.name : '';
    var name = (await dialogPrompt('Name this email template so the team can find it later.', suggested, { title: 'Save email template', inputLabel: 'Template name', acceptLabel: 'Save template' }) || '').trim();
    if (!name) return;
    var match = TEMPLATES.filter(function (x) { return x.name.toLowerCase() === name.toLowerCase(); })[0];
    var row = { name: name, subject: subject, body_text: body, mode: campaignMode, updated_at: new Date().toISOString() };
    var q = match
      ? window.coldSupabase.from('email_templates').update(row).eq('id', match.id).select('id')
      : window.coldSupabase.from('email_templates').insert(row).select('id');
    tplSaveBtn.disabled = true;
    q.then(function (res) {
      tplSaveBtn.disabled = false;
      if (res.error || !res.data || !res.data.length) { templateMsg(res.error && res.error.message || 'Could not save the template.'); return; }
      logAudit((match ? 'Updated' : 'Saved') + ' email template "' + name + '"');
      templateMsg((match ? 'Updated' : 'Saved') + ' "' + name + '".', true);
      templateDropdown.setValue(res.data[0].id, true);
      refreshTemplates();
    });
  });
  var tplDelBtn = $('admTemplateDelBtn');
  if (tplDelBtn) tplDelBtn.addEventListener('click', async function () {
    if (!can('admin')) return;
    var t = TEMPLATES.filter(function (x) { return x.id === templateDropdown.getValue(); })[0];
    if (!t) { templateMsg('Pick a template first.'); return; }
    if (!(await dialogConfirm('Delete “' + t.name + '”?', { title: 'Delete email template', acceptLabel: 'Delete template' }))) return;
    window.coldSupabase.from('email_templates').delete().eq('id', t.id).select('id').then(function (res) {
      if (res.error) { templateMsg(res.error.message || 'Could not delete.'); return; }
      if (!res.data || !res.data.length) { templateMsg('Could not delete - you may not have permission.'); return; }
      logAudit('Deleted email template "' + t.name + '"');
      templateMsg('Deleted "' + t.name + '".', true);
      templateDropdown.setValue('', true);
      refreshTemplates();
    });
  });

  // Shared by the campaign composer and each automation's own preview -
  // same shell either way, since both send through the same Resend path.
  function emailPreviewDoc(bodyHtml) {
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<style>body{margin:0;padding:20px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;' +
      'font-size:15px;line-height:1.5;color:#1a1a1a;background:#fff;} img{max-width:100%;}</style>' +
      '</head><body>' + bodyHtml + '</body></html>';
  }
  function updateCampaignPreview() {
    var frame = $('admCampaignPreviewFrame');
    if (!frame || $('admCampaignPreviewWrap').hidden) return;
    frame.srcdoc = emailPreviewDoc(campaignBodyHtml());
  }
  // Delegated rather than bound once to the button itself - this whole
  // panel re-renders sub-sections of itself repeatedly (every stats/
  // campaigns/automations refresh calls back into renderMarketing()), and
  // a listener bound directly to a node that later gets replaced by an
  // innerHTML rebuild elsewhere silently stops firing. Delegating from
  // document survives that regardless of which nodes get rebuilt.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('#admCampaignPreviewBtn');
    if (!btn) return;
    var wrap = $('admCampaignPreviewWrap');
    if (!wrap) return;
    var open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Hide preview' : 'Preview';
    if (open) updateCampaignPreview();
  });
  document.addEventListener('input', function (e) {
    if (!e.target.closest('#admCampaignBody')) return;
    var wrap = $('admCampaignPreviewWrap');
    if (wrap && !wrap.hidden) updateCampaignPreview();
  });

  // Typed-code confirmation before a real send - same "type it out, no
  // paste" gate the account-deletion flow uses, because a campaign send
  // is just as irreversible and reaches far more people. The modal also
  // states the exact recipient count.
  function genCampaignCode() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789', groups = [];
    for (var g = 0; g < 4; g++) { var s = ''; for (var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length)); groups.push(s); }
    return groups.join('-');
  }
  var campaignConfirm = (function () {
    var ov = $('admCampaignConfirmOverlay');
    if (!ov) return { open: function () {} };
    var codeEl = $('admCampaignConfirmCode'), inp = $('admCampaignConfirmInput'),
        goBtn = $('admCampaignConfirmGo'), cancelBtn = $('admCampaignConfirmCancel'),
        closeBtn = $('admCampaignConfirmClose'), cmsg = $('admCampaignConfirmMsg'),
        countEl = $('admCampaignConfirmCount'), summaryEl = $('admCampaignConfirmSummary'),
        warnEl = $('admCampaignConfirmWarn');
    var code = '', onConfirm = null;
    if (inp) inp.addEventListener('paste', function (e) { e.preventDefault(); });
    if (inp) inp.addEventListener('input', function () {
      goBtn.disabled = inp.value.trim().toLowerCase() !== code;
    });
    function close() { ov.hidden = true; onConfirm = null; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    if (goBtn) goBtn.addEventListener('click', function () {
      if (goBtn.disabled || !onConfirm) return;
      var fn = onConfirm;
      goBtn.disabled = true;
      if (cmsg) cmsg.textContent = 'Sending…';
      fn(function (resultText, isErr) {
        if (isErr) { if (cmsg) { cmsg.textContent = resultText; cmsg.style.color = 'var(--accent)'; } goBtn.disabled = false; return; }
        close();
      });
    });
    return {
      open: function (opts) {
        code = genCampaignCode();
        onConfirm = opts.onConfirm;
        codeEl.textContent = code;
        inp.value = ''; goBtn.disabled = true;
        if (cmsg) { cmsg.textContent = ''; cmsg.style.color = ''; }
        countEl.textContent = 'This sends to ' + opts.count.toLocaleString('en-US') + ' ' + opts.audienceLabel + '.';
        summaryEl.textContent = 'Subject: "' + opts.subject + '"';
        warnEl.hidden = !opts.warn;
        if (opts.warn) warnEl.textContent = opts.warn;
        ov.hidden = false;
        document.addEventListener('keydown', onKey);
        setTimeout(function () { inp.focus(); }, 30);
      }
    };
  })();

  var campaignForm = $('admCampaignForm');
  if (campaignForm) {
    campaignForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var subject = $('admCampaignSubject').value.trim();
      var bodyText = $('admCampaignBody').value;
      var msg = $('admCampaignMsg');
      if (msg) msg.textContent = '';
      if (!subject || !bodyText.trim()) { if (msg) msg.textContent = 'Write a subject and body first.'; return; }
      var isAnnounce = campaignAudience === 'announcement';
      if (isAnnounce && !EMAIL_CAN_ANNOUNCE) { if (msg) msg.textContent = 'Announcements can only be sent from the site owner account.'; return; }
      var count = isAnnounce ? (EMAIL_STATS.allAccounts || 0) : (EMAIL_STATS.optedIn || 0);
      if (!count) { if (msg) msg.textContent = 'No recipients for this audience.'; return; }

      var sendBtn = $('admCampaignSendBtn');
      campaignConfirm.open({
        subject: subject,
        count: count,
        audienceLabel: isAnnounce ? ('account' + (count === 1 ? '' : 's') + ' - opted in or not') : ('opted-in subscriber' + (count === 1 ? '' : 's')),
        warn: isAnnounce ? 'Announcement - this is not a marketing email. Send it only for things every user must know (ToS changes, outages).' : '',
        onConfirm: function (done) {
          sendBtn.disabled = true;
          if (msg) msg.textContent = 'Sending…';
          invokeAdminFn('admin-send-campaign', { action: 'send', subject: subject, bodyHtml: campaignBodyHtml(), audience: campaignAudience }, 'Could not send campaign.').then(function (data) {
            if (msg) msg.textContent = 'Sent to ' + data.sentCount + ' of ' + data.recipientCount + (data.failedCount ? ' (' + data.failedCount + ' failed)' : '') + '.';
            logAudit('Sent ' + (isAnnounce ? 'announcement' : 'marketing') + ' email "' + subject + '" to ' + data.sentCount + ' recipients');
            campaignForm.reset();
            sendBtn.disabled = false;
            done();
            return refreshEmailCampaigns();
          }).catch(function (err) {
            sendBtn.disabled = false;
            if (msg) msg.textContent = err.message;
            done(err.message, true);
          });
        }
      });
    });
  }
  var campaignTestBtn = $('admCampaignTestBtn');
  if (campaignTestBtn) campaignTestBtn.addEventListener('click', function () {
    var subject = $('admCampaignSubject').value.trim();
    var bodyText = $('admCampaignBody').value;
    var testEmail = $('admCampaignTestEmail').value.trim();
    var msg = $('admCampaignMsg');
    if (!subject || !bodyText.trim()) { if (msg) msg.textContent = 'Write a subject and body first.'; return; }
    if (!testEmail) { if (msg) msg.textContent = 'Enter a test email address.'; return; }
    campaignTestBtn.disabled = true;
    if (msg) msg.textContent = 'Sending test…';
    invokeAdminFn('admin-send-campaign', { action: 'test', subject: subject, bodyHtml: campaignBodyHtml(), testEmail: testEmail }, 'Could not send test.').then(function () {
      if (msg) msg.textContent = 'Test sent to ' + testEmail + '.';
    }).catch(function (err) {
      if (msg) msg.textContent = err.message;
    }).then(function () {
      campaignTestBtn.disabled = false;
    });
  });

  /* ---- Broadcast notification (in-app bell, everyone at once) ---- */
  (function () {
    var form = $('admBroadcastForm');
    if (!form) return;
    var audienceSw = $('admBroadcastAudience'), kindSw = $('admBroadcastKind');
    var kindHint = $('admBroadcastKindHint'), msg = $('admBroadcastMsg');
    var sendBtn = $('admBroadcastSendBtn');
    var audience = 'all', kind = 'general';
    function wireSwitch(el, attr, set) {
      if (!el) return;
      el.addEventListener('click', function (e) {
        var b = e.target.closest('.bt-opt'); if (!b) return;
        el.querySelectorAll('.bt-opt').forEach(function (o) { var on = o === b; o.classList.toggle('active', on); o.setAttribute('aria-selected', on ? 'true' : 'false'); });
        set(b.getAttribute(attr));
      });
    }
    wireSwitch(audienceSw, 'data-audience', function (v) { audience = v; });
    wireSwitch(kindSw, 'data-kind', function (v) {
      kind = v;
      if (kindHint) kindHint.textContent = v === 'sale'
        ? 'Goes only to accounts that keep "Site-wide sale alerts" on.'
        : 'Goes to every account in the audience.';
    });

    var ov = $('admBroadcastConfirmOverlay');
    var codeEl = $('admBroadcastConfirmCode'), inp = $('admBroadcastConfirmInput'),
        goBtn = $('admBroadcastConfirmGo'), cancelBtn = $('admBroadcastConfirmCancel'),
        cmsg = $('admBroadcastConfirmMsg'), summaryEl = $('admBroadcastConfirmSummary'),
        warnEl = $('admBroadcastConfirmWarn');
    var code = '', pendingPayload = null;
    if (inp) { inp.addEventListener('paste', function (e) { e.preventDefault(); }); inp.addEventListener('input', function () { goBtn.disabled = inp.value.trim().toLowerCase() !== code; }); }
    function closeConfirm() { if (ov) ov.hidden = true; pendingPayload = null; }
    if (cancelBtn) cancelBtn.addEventListener('click', closeConfirm);
    if (ov) ov.addEventListener('click', function (e) { if (e.target === ov) closeConfirm(); });
    if (goBtn) goBtn.addEventListener('click', function () {
      if (goBtn.disabled || !pendingPayload) return;
      goBtn.disabled = true; if (cmsg) { cmsg.textContent = 'Sending…'; cmsg.style.color = ''; }
      var payload = pendingPayload;
      invokeAdminFn('admin-broadcast-notification', Object.assign({ action: 'send' }, payload), 'Could not send broadcast.').then(function (d) {
        if (msg) msg.textContent = 'Sent to ' + (d.sent || 0).toLocaleString('en-US') + ' account(s).';
        logAudit('Broadcast notification "' + payload.title + '" to ' + (d.sent || 0) + ' accounts');
        form.reset(); closeConfirm();
      }).catch(function (err) {
        if (cmsg) { cmsg.textContent = err.message || 'Failed.'; cmsg.style.color = 'var(--accent)'; }
        goBtn.disabled = false;
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!can('admin')) { if (msg) msg.textContent = 'Admin access required.'; return; }
      var title = $('admBroadcastTitle').value.trim();
      var body = $('admBroadcastBody').value.trim();
      var url = $('admBroadcastUrl').value.trim();
      if (msg) msg.textContent = '';
      if (!title) { if (msg) msg.textContent = 'Enter a title.'; return; }
      sendBtn.disabled = true;
      invokeAdminFn('admin-broadcast-notification', { action: 'count', audience: audience }, 'Could not check the audience.').then(function (d) {
        sendBtn.disabled = false;
        var count = d.count || 0;
        if (!count) { if (msg) msg.textContent = 'No accounts in that audience.'; return; }
        pendingPayload = { audience: audience, kind: kind, title: title, body: body || null, url: url || null };
        code = genCampaignCode();
        if (codeEl) codeEl.textContent = code;
        if (inp) inp.value = '';
        if (goBtn) goBtn.disabled = true;
        if (cmsg) { cmsg.textContent = ''; cmsg.style.color = ''; }
        if (summaryEl) summaryEl.textContent = '"' + title + '" → ' + count.toLocaleString('en-US') + (audience === 'customers' ? ' customer' : ' account') + (count === 1 ? '' : 's') + (kind === 'sale' ? ' (minus opt-outs)' : '') + '.';
        if (warnEl) { warnEl.hidden = false; warnEl.textContent = 'Every one of them sees this in their notification bell. There is no undo.'; }
        if (ov) ov.hidden = false;
        setTimeout(function () { if (inp) inp.focus(); }, 30);
      }).catch(function (err) {
        sendBtn.disabled = false;
        if (msg) msg.textContent = err.message || 'Could not check the audience.';
      });
    });
  })();

  var emailListSearch = $('admEmailListSearch');
  if (emailListSearch) emailListSearch.addEventListener('input', renderEmailList);
  var emailListCopyBtn = $('admEmailListCopyBtn');
  if (emailListCopyBtn) emailListCopyBtn.addEventListener('click', function () {
    var addrs = EMAIL_RECIPIENTS.filter(function (r) { return r.status === 'optedin'; })
      .map(function (r) { return r.email; });
    if (!addrs.length) { emailListCopyBtn.textContent = 'No opted-in addresses'; }
    else {
      var text = addrs.join(', ');
      var done = function () { emailListCopyBtn.textContent = 'Copied ' + addrs.length + ' addresses'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    }
    setTimeout(function () { emailListCopyBtn.textContent = 'Copy sendable addresses'; }, 2500);
  });

  /* ================================================================
     LIFECYCLE AUTOMATIONS (abandoned cart steps, review request,
     re-engagement) - admin-editable rows in email_automations, all
     evaluated by the same cron-lifecycle-emails run every 30 min.
     ================================================================ */
  var AUTOMATIONS = {};
  var AUTOMATION_META = [
    { key: 'abandoned_cart_1', label: 'Abandoned cart · step 1', hint: 'Hours after a cart goes stale.' },
    { key: 'abandoned_cart_2', label: 'Abandoned cart · step 2', hint: 'Hours after step 1 would have sent.' },
    { key: 'abandoned_cart_3', label: 'Abandoned cart · step 3', hint: 'Hours after step 2 would have sent.' },
    { key: 'post_purchase_review', label: 'Post-purchase review request', hint: 'Hours after an order is marked paid.' },
    { key: 'reengagement', label: 'Re-engagement', hint: 'Hours since last purchase (or signup, if they never bought) before we call the account lapsed. Sent once.' },
    { key: 'wishlist_reminder', label: 'Wishlist reminder', hint: 'Hours a wishlist item sits with no purchase since. Always includes a discount, so it only sends to accounts with real marketing consent.' },
    { key: 'signup_nudge', label: 'Signup nudge (no purchase)', hint: 'Hours after signup with no order yet. Plain nudge, no offer - sends to anyone not unsubscribed.' },
    { key: 'wishlist_price_drop', label: 'Wishlist price drop', hint: 'A wishlisted item is on sale right now. Promotional, so marketing consent required. One email per sale price.' },
    { key: 'getting_started', label: 'Getting started', hint: 'Hours after a paid order. Setup help + links to files and Discord. No offer - sends to anyone not unsubscribed.' },
    { key: 'resell_upgrade', label: 'Resell licence upgrade', hint: 'Hours after buying a standard licence for a resell-eligible product, if they don’t already own the resell licence. Upsell, no code - sends to anyone not unsubscribed.' },
    { key: 'review_incentive', label: 'Review incentive', hint: 'Hours after a paid order with no review yet. Mints a discount code, so marketing consent required.' },
    { key: 'repeat_buyer', label: 'Repeat buyer thank-you', hint: 'Hours after a 2nd (or later) paid order. Mints a discount code, so marketing consent required. Once per account.' },
    { key: 'winback', label: 'Win-back (lapsed)', hint: 'Hours since the last paid order. Discount scales with how long they’ve been gone (15/20/25%). Marketing consent required. Once per account.' }
  ];

  function refreshAutomations() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('email_automations').select('*').then(function (res) {
      if (res.error) { console.error('[admin] failed to load automations:', res.error.message); return; }
      AUTOMATIONS = {};
      (res.data || []).forEach(function (row) { AUTOMATIONS[row.key] = row; });
      if (curPanel === 'marketing') renderAutomations();
    });
  }

  function renderAutomations() {
    var el = $('admAutomationsBody'); if (!el) return;
    var html = AUTOMATION_META.map(function (meta) {
      var a = AUTOMATIONS[meta.key] || { enabled: false, delay_hours: 24, subject: '', body_md: '' };
      var statusBadge = a.enabled ? '<span class="dt-badge ok">On</span>' : '<span class="dt-badge">Off</span>';
      return '<details class="adm-collapse" data-collapse-key="auto-' + esc(meta.key) + '" style="background:rgba(255,255,255,0.02);margin-top:14px;padding:16px 18px;border-radius:10px;">' +
        '<summary class="dash-card-head" style="margin-bottom:0;"><div><h2 style="font-size:14px;">' + esc(meta.label) + '</h2></div><span style="display:flex;align-items:center;gap:10px;">' + statusBadge + '<svg class="adm-collapse-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span></summary>' +
        '<div class="adm-form adm-collapse-body" style="flex-direction:column;align-items:stretch;gap:10px;max-height:none;margin-top:14px;" data-automation-key="' + meta.key + '">' +
        '<label class="adm-field-check"><input type="checkbox" class="am-enabled"' + (a.enabled ? ' checked' : '') + ' /><span>Enabled</span></label>' +
        '<label class="adm-field"><span>Delay (hours) - ' + esc(meta.hint) + '</span><input type="number" class="adm-input am-delay" min="1" value="' + esc(a.delay_hours) + '" style="max-width:140px;" /></label>' +
        '<label class="adm-field"><span>Subject</span><input type="text" class="adm-input am-subject" value="' + esc(a.subject) + '" /></label>' +
        '<label class="adm-field"><span>Body</span><textarea class="adm-input adm-textarea am-body" rows="4">' + esc(a.body_md) + '</textarea></label>' +
        '<div style="display:flex;gap:8px;align-items:center;"><button class="btn btn-primary adm-btn-sm am-save" type="button">Save</button>' +
        '<button class="btn btn-ghost adm-btn-sm am-preview" type="button" aria-expanded="false">Preview</button><span class="adm-edit-msg am-msg"></span></div>' +
        '<div class="adm-campaign-preview am-preview-wrap" hidden><div class="adm-campaign-preview-head">Preview</div>' +
        '<iframe class="adm-campaign-preview-frame am-preview-frame" title="Automation email preview" sandbox=""></iframe></div>' +
        '</div></details>';
    }).join('');
    setHtmlPreservingCollapse(el, html);

    el.querySelectorAll('.am-save').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var wrap = btn.closest('[data-automation-key]');
        var key = wrap.getAttribute('data-automation-key');
        var msg = wrap.querySelector('.am-msg');
        var payload = {
          key: key,
          enabled: wrap.querySelector('.am-enabled').checked,
          delayHours: parseInt(wrap.querySelector('.am-delay').value, 10) || 1,
          subject: wrap.querySelector('.am-subject').value.trim(),
          bodyMd: wrap.querySelector('.am-body').value.trim()
        };
        btn.disabled = true;
        if (msg) msg.textContent = 'Saving…';
        invokeAdminFn('admin-update-automation', payload, 'Could not save.').then(function () {
          if (msg) msg.textContent = 'Saved.';
          logAudit((payload.enabled ? 'Enabled' : 'Updated') + ' automation "' + key + '"');
          return refreshAutomations();
        }).catch(function (err) {
          if (msg) msg.textContent = err.message;
        }).then(function () {
          btn.disabled = false;
        });
      });
    });

    // Renders live from whatever is currently typed, not the last-saved
    // body_md - same "preview what you're about to send" as campaigns.
    el.querySelectorAll('.am-preview').forEach(function (btn) {
      var row = btn.closest('[data-automation-key]');
      var previewWrap = row.querySelector('.am-preview-wrap');
      var frame = row.querySelector('.am-preview-frame');
      var bodyEl = row.querySelector('.am-body');
      function update() { frame.srcdoc = emailPreviewDoc(simpleMarkdownToHtml(bodyEl.value)); }
      btn.addEventListener('click', function () {
        var open = previewWrap.hidden;
        previewWrap.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? 'Hide preview' : 'Preview';
        if (open) update();
      });
      bodyEl.addEventListener('input', function () { if (!previewWrap.hidden) update(); });
    });
  }

  /* ================================================================
     ANALYTICS PANEL
     ================================================================ */
  function renderAnalytics() {
    if (!ORDERS_LOADED) { $('admAnStats').innerHTML = loadingStats(6); return; }
    var aov = avgOrderValue();
    var conv = conversionRate();

    var curOrders = completedInRange();
    var curRev = websiteRevenue(curOrders);
    var win = RANGE_DAYS ? prevRangeWindow() : null;
    var prevOrders = win ? completedInWindow(win.start, win.end) : [];
    var prevRev = websiteRevenue(prevOrders);
    var curVisits = RANGE_DAYS ? pageviewsInWindow(rangeStart(), new Date()) : TRAFFIC.reduce(function (s, r) { return s + r.pageviews; }, 0);
    var prevVisits = win ? pageviewsInWindow(win.start, win.end) : 0;

    // Store performance only. Audience and channel numbers live in Marketing.
    var anSessions = TRAFFIC.slice(Math.max(0, TRAFFIC.length - (RANGE_DAYS || 120))).reduce(function (sum, r) { return sum + r.sessions; }, 0);
    var anAbandoned = ABANDONED.reduce(function (sum, a) { return sum + a.value; }, 0);
    $('admAnStats').innerHTML = [
      statTile('Revenue', aud(curRev.usd), usd(curRev.usd) + ' USD', pctDelta(curRev.usd, prevRev.usd)),
      statTile('Robux revenue', robuxRaw(curRev.robux), null, pctDelta(curRev.robux, prevRev.robux)),
      statTile('Order count', curOrders.length, null, pctDelta(curOrders.length, prevOrders.length)),
      statTile('Avg order value', usd(aov), null, ''),
      statTile('Conversion rate', pct(conv), null, ''),
      bbbRevTile(),
      bbbOrdersTile(),
      statTile('Site visits', curVisits.toLocaleString('en-US'), null, pctDelta(curVisits, prevVisits)),
      statTile('Revenue per session', anSessions ? usd(curRev.usd / anSessions) : ' - ', anSessions.toLocaleString('en-US') + ' sessions', ''),
      statTile('Abandoned carts', usd(anAbandoned), ABANDONED.length + ' cart' + (ABANDONED.length === 1 ? '' : 's') + ' at risk', '')
    ].join('');

    var revLines = [{ name: 'Site', color: 'var(--accent)', data: dailyRevenueSeries() }];
    if (BBB.configured) revLines.push({ name: 'BuiltByBit', color: 'var(--price)', data: bbbDailySeries(RANGE_DAYS || 120) });
    $('admRevChart').innerHTML = svgTrend(revLines, { height: 150, fmt: axisUsd });
    attachChartTooltip($('admRevChart'));

    if ($('admRevBreakdown')) {
      var methods = revenueByMethod();
      var rc = repeatCustomerStats();
      var rf = refundStats();
      var bd = statGrid([
        statTile('Repeat customers', pct(rc.rate), rc.repeat + ' of ' + rc.payers + ' buyers · lifetime', ''),
        statTile('Refund rate', pct(rf.rate), rf.count + ' refunded · ' + usd(rf.usd), ''),
        statTile('Avg order value', usd(avgOrderValue()), 'over selected range', '')
      ]);
      if (methods.length) {
        bd += '<div class="adm-mini-head">Revenue by payment method · USD-equivalent</div>' +
          donutChart(methods.map(function (m) {
            var disp = m.label === 'Robux' ? robuxRaw(m.robux) : usd(m.v);
            return { label: m.label, value: m.v, color: methodColor(m.label), display: esc(disp), plain: disp };
          }), { centerLabel: usd(methods.reduce(function (s, m) { return s + m.v; }, 0)), centerSub: 'total' });
      }
      bd += '<div class="adm-mini-head">Average order value · daily</div>' + svgBars(aovDailySeries(), { height: 110, color: 'var(--price)', fmt: axisUsd });
      $('admRevBreakdown').innerHTML = bd;
    }

    var best = bestSellers(6);
    $('admBestSellers').innerHTML = best.length ? best.map(function (p, i) {
      return '<div class="dash-row"><span class="adm-rank">#' + (i + 1) + '</span><span class="dr-thumb" style="background-image:url(\'' + p.image + '\')"></span>' +
        '<div class="dr-main"><div class="dr-title">' + esc(p.title) + '</div><div class="dr-sub">' + p.units + ' sold' + (p.bbbUnits ? ' · ' + p.bbbUnits + ' on BuiltByBit' : '') + '</div></div>' +
        '<span class="p-price">' + usd(p.revenue) + '</span></div>';
    }).join('') : '<p class="adm-empty">No completed orders in this range.</p>';

    var byCat = revenueByCategory();
    var prevCat = win ? categoryRevenueWindow(prevOrders) : null;
    if (prevCat && BBB.configured) {
      var pbc = bbbCategoryRevenue(win.start, win.end);
      Object.keys(pbc).forEach(function (k) { prevCat[k] = (prevCat[k] || 0) + pbc[k]; });
    }
    var catTotal = byCat.reduce(function (s, c) { return s + c.v; }, 0);
    var catPalette = ['var(--accent)', '#3b7bbf', '#e8b84b', 'var(--price)', '#9b6dd6', '#5fb0a5', '#d67c4a', '#8a8f98'];
    $('admCatChart').innerHTML = byCat.length ? donutChart(byCat.map(function (c, i) {
      var pv = prevCat ? (prevCat[c.label] || 0) : null;
      var deltaTxt = (pv != null && pv > 0) ? ' · ' + (c.v >= pv ? '+' : '') + Math.round((c.v - pv) / pv * 100) + '% vs prev' : '';
      return {
        label: c.label, value: c.v, color: catPalette[i % catPalette.length],
        display: esc(usd(c.v)), plain: usd(c.v),
        tip: c.label + ' · ' + usd(c.v) + ' · ' + (catTotal ? Math.round(c.v / catTotal * 100) : 0) + '%' + deltaTxt
      };
    }), { centerLabel: usd(catTotal), centerSub: 'revenue' }) : '<p class="adm-empty">No data in this range.</p>';
    if ($('admCatList')) $('admCatList').innerHTML = '';

    $('admTrafficChart').innerHTML = svgBars(trafficSeries(), { color: 'var(--price)' });
    attachChartTooltip($('admTrafficChart'));
    var trafficRows = TRAFFIC.slice(Math.max(0, TRAFFIC.length - (RANGE_DAYS || 120)));
    var totalViews = trafficRows.reduce(function (s, r) { return s + r.pageviews; }, 0);
    var totalSessions = trafficRows.reduce(function (s, r) { return s + r.sessions; }, 0);
    var retLabel = TRAFFIC_VISITORS ? pct(TRAFFIC_VISITORS.rate) : '–';
    var retSub = TRAFFIC_VISITORS ? (TRAFFIC_VISITORS.returning.toLocaleString('en-US') + ' of ' + TRAFFIC_VISITORS.total.toLocaleString('en-US') + ' · 120d') : 'gathering data';
    $('admTrafficStats').innerHTML =
      '<div class="dash-stat glass"><span class="ds-label">Pageviews</span><span class="ds-num">' + totalViews.toLocaleString('en-US') + '</span></div>' +
      '<div class="dash-stat glass"><span class="ds-label">Sessions</span><span class="ds-num">' + totalSessions.toLocaleString('en-US') + '</span></div>' +
      '<div class="dash-stat glass"><span class="ds-label">Returning visitors</span><span class="ds-num">' + retLabel + '</span><span class="ds-sub">' + retSub + '</span></div>';

    if ($('admTopPagesBody')) {
      var tpShow = TOP_PAGES_OPEN ? TRAFFIC_PAGES.slice(0, 50) : TRAFFIC_PAGES.slice(0, 5);
      $('admTopPagesBody').innerHTML = tpShow.map(function (p) {
        var label = p.path === '/' ? '/ <span class="adm-sub">Home page</span>' : esc(p.path);
        return '<tr><td class="dt-mono">' + label + '</td><td>' + p.views.toLocaleString('en-US') + '</td><td>' + p.sessions.toLocaleString('en-US') + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="adm-empty">No traffic yet.</td></tr>';
      var tpBtn = $('admTopPagesMore');
      if (tpBtn) { tpBtn.hidden = TRAFFIC_PAGES.length <= 5; tpBtn.textContent = TOP_PAGES_OPEN ? 'Show fewer' : 'Show all ' + Math.min(TRAFFIC_PAGES.length, 50) + ' pages'; }
    }

    if ($('admFunnel')) {
      var fn = funnelCounts();
      var steps = [
        { label: 'Visited the site', v: fn.visitors },
        { label: 'Viewed a product', v: fn.product },
        { label: 'Added to cart', v: fn.cart },
        { label: 'Started checkout', v: fn.checkout },
        { label: 'Paid (orders)', v: fn.paid }
      ];
      var fTop = Math.max.apply(null, steps.map(function (st) { return st.v; }).concat([1]));
      var fRows = steps.map(function (st, i) {
        var prev = i ? steps[i - 1].v : 0;
        var note = i === 0 ? '' : (prev ? pct(st.v / prev * 100) + ' of previous step' : ' - ');
        var w = st.v ? Math.max(1.5, st.v / fTop * 100) : 0;
        return '<div class="adm-funnel-row"><div class="adm-funnel-label">' + esc(st.label) + '</div>' +
          '<div class="adm-funnel-track"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
          '<div class="adm-funnel-num">' + st.v.toLocaleString('en-US') + '</div>' +
          '<div class="adm-funnel-note">' + note + '</div></div>';
      }).join('');
      var fNote = 'Counted by session over the selected range; admin and sign-in pages are excluded. Paid is completed orders, which are not tied to a session, so it can run ahead of the step above.';
      $('admFunnel').innerHTML = statGrid([
        statTile('Visitor to paid', steps[0].v ? pct(fn.paid / steps[0].v * 100) : ' - ', 'over selected range', ''),
        statTile('Cart to checkout', fn.cart ? pct(fn.checkout / fn.cart * 100) : ' - ', null, ''),
        statTile('Checkout to paid', fn.checkout ? pct(fn.paid / fn.checkout * 100) : ' - ', null, '')
      ]) + '<div class="adm-funnel">' + fRows + '</div><p class="adm-note">' + fNote + '</p>';
    }

    if ($('admSearchBody')) {
      var ts = topSearches(15);
      $('admSearchBody').innerHTML = ts.map(function (sq) {
        return '<tr><td>' + esc(sq.q) + '</td><td>' + sq.count + '</td><td>' + (sq.noResults ? '<span class="dt-badge warn">' + sq.noResults + '</span>' : '<span class="adm-sub"> - </span>') + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="adm-empty">No searches logged yet.</td></tr>';
    }

    if ($('admHowHeardBody')) {
      var hh = howHeard();
      $('admHowHeardBody').innerHTML = hh.map(function (r) {
        return '<tr><td>' + esc(r.label) + '</td><td>' + r.count + '</td><td>' + r.pct + '%</td></tr>';
      }).join('') || '<tr><td colspan="3" class="adm-empty">No survey answers yet.</td></tr>';
    }

    var abShow = ABANDONED_OPEN ? ABANDONED.slice(0, 50) : ABANDONED.slice(0, 5);
    $('admAbandonedBody').innerHTML = abShow.map(function (a) {
      var sent = a.recoveryEmailSentAt
        ? '<span class="dt-badge ok">Email sent</span><div class="adm-sub">' + (a.abandonedStep != null ? 'Step ' + a.abandonedStep + ' · ' : '') + fmtDate(new Date(a.recoveryEmailSentAt)) + '</div>'
        : (a.abandonedStep > 0 ? '<span class="dt-badge">Step ' + a.abandonedStep + ' handled</span><div class="adm-sub">sent before tracking</div>'
          : (a.email ? '<span class="dt-badge warn">Not sent yet</span>' : '<span class="dt-badge">No email</span>'));
      return '<tr><td>' + fmtDate(new Date(a.date)) + '</td><td>' + esc(a.title) + '</td><td>' + usd(a.value) + '</td><td>' + (a.email ? esc(a.email) : '<span class="adm-sub">unknown</span>') + '</td><td>' + sent + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="adm-empty">No abandoned carts.</td></tr>';
    $('admAbandonedTotal').textContent = usd(ABANDONED.reduce(function (sum, a) { return sum + a.value; }, 0));
    var abBtn = $('admAbandonedMore');
    if (abBtn) { abBtn.hidden = ABANDONED.length <= 5; abBtn.textContent = ABANDONED_OPEN ? 'Show fewer' : 'Show all ' + Math.min(ABANDONED.length, 50) + ' carts'; }

    var cs = couponStats();
    if ($('admCouponTotals')) {
      var ct = cs.reduce(function (a, c) { a.disc += c.discountGiven; a.rev += c.revenue; return a; }, { disc: 0, rev: 0 });
      $('admCouponTotals').innerHTML = statGrid([
        statTile('Coupon revenue', usd(ct.rev), 'orders using a code · this range', ''),
        statTile('Discount given', usd(ct.disc), 'this range', ''),
        statTile('Net after discount', usd(ct.rev - ct.disc), null, '')
      ]);
    }
    $('admCouponAnBody').innerHTML = cs.map(function (c) {
      var codeCell = c.label ? esc(c.label) + '<div class="adm-sub">' + c.issued + ' code' + (c.issued === 1 ? '' : 's') + ' issued · one per signup</div>' : esc(c.code);
      var usesCell = c.issued ? c.uses + ' of ' + c.issued + ' used' : c.uses + (c.limit ? ' / ' + c.limit : '');
      return '<tr><td class="dt-mono">' + codeCell + '</td><td>' + (c.active ? '<span class="dt-badge ok">Active</span>' : '<span class="dt-badge err">Inactive</span>') + '</td><td>' + usesCell + '</td><td>' + usd(c.discountGiven) + '</td><td>' + usd(c.revenue) + '</td></tr>';
    }).join('');

    document.querySelectorAll('.adm-range button').forEach(function (b) { b.classList.toggle('active', +b.getAttribute('data-range') === RANGE_DAYS); });
  }

  /* ================================================================
     PRODUCTS PANEL
     ================================================================ */
  var ADM_ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
  var ADM_ICON_KEBAB = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="12" cy="19" r="1.75"/></svg>';
  var ADM_ICON_EDIT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  var ADM_ICON_EXT = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>';
  var ADM_ICON_INFO = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
  var ADM_ICON_PAUSE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  var ADM_ICON_PLAY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M7 4v16l14-8Z"/></svg>';
  var ADM_ICON_COPY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var ADM_ICON_CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  // Units actually sold for a product: completed, paid orders only - not
  // pending/failed attempts, refunds, or free admin grants - and counting
  // line-item quantities, not one-per-order. Matches the "completed &&
  // source !== 'granted'" basis every revenue figure in this panel uses.
  function purchaseCount(id) {
    var n = 0;
    ORDERS.forEach(function (o) {
      if (o.status !== 'completed' || o.source === 'granted') return;
      (o.items || []).forEach(function (it) {
        if (it.product_slug === id) n += Math.max(1, Number(it.qty) || 1);
      });
    });
    return n;
  }
  function sortProducts(list) {
    var mode = PROD_SORT || 'newest';
    var withMeta = list.map(function (p, i) {
      return { p: p, i: i, sales: purchaseCount(p.id), created: Date.parse(p.createdAt) || 0 };
    });
    withMeta.sort(function (a, b) {
      if (mode === 'oldest') return (a.created - b.created) || (a.i - b.i);
      if (mode === 'sales-desc') return (b.sales - a.sales) || (a.i - b.i);
      if (mode === 'sales-asc') return (a.sales - b.sales) || (a.i - b.i);
      if (mode === 'rating-desc') return (b.p.rating - a.p.rating) || (a.i - b.i);
      if (mode === 'price-desc') return (b.p.priceNum - a.p.priceNum) || (a.i - b.i);
      if (mode === 'price-asc') return (a.p.priceNum - b.p.priceNum) || (a.i - b.i);
      return (b.created - a.created) || (a.i - b.i); // newest (default)
    });
    return withMeta.map(function (m) { return m.p; });
  }
  function renderProducts() {
    var q = ($('admProdSearch') || {}).value || '';
    q = q.trim().toLowerCase();
    var rows = sortProducts(allProducts().filter(function (p) {
      return !q || p.title.toLowerCase().indexOf(q) >= 0;
    }));
    $('admProdBody').innerHTML = rows.map(function (p) {
      var rating = (p.rating || 0).toFixed(1);
      return '<tr data-id="' + esc(p.id) + '">' +
        '<td><span class="dr-thumb" style="background-image:url(\'' + p.image + '\');width:52px;height:38px;display:inline-block;vertical-align:middle;border-radius:7px;"></span></td>' +
        '<td><a class="adm-prod-name" href="/product/' + esc(p.id) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a></td>' +
        '<td><span class="adm-cat-tag">' + esc(p.cat || 'Uncategorized') + '</span></td>' +
        '<td>' + rating + '<span class="adm-star">★</span></td>' +
        '<td>' + purchaseCount(p.id) + '</td>' +
        '<td class="adm-row-actions">' +
          '<button class="adm-icon-btn adm-prod-download" type="button" title="Download product file" aria-label="Download">' + ADM_ICON_DOWNLOAD + '</button>' +
          '<button class="adm-icon-btn adm-prod-edit" type="button" title="Edit product" aria-label="Edit">' + ADM_ICON_KEBAB + '</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="adm-empty">No products match.</td></tr>';
  }
  var prodBody = $('admProdBody');
  if (prodBody) prodBody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var p = findProduct(id); if (!p) return;
    if (e.target.closest('.adm-prod-toggle')) {
      if (!can('admin')) return;
      var toggleBtn = e.target.closest('.adm-prod-toggle');
      toggleBtn.disabled = true;
      callUpsertProduct(upsertPayloadFor(p, { visible: !p.visible })).then(function () {
        logAudit((p.visible ? 'Unreleased' : 'Released') + ' product "' + p.title + '"');
        admToast((p.visible ? 'Unreleased' : 'Released') + ' "' + p.title + '"', true);
        return refreshProducts();
      }).catch(function (err) {
        toggleBtn.disabled = false;
        admToast(err.message || 'Could not update product', false);
      });
    } else if (e.target.closest('.adm-prod-download')) {
      var dlBtn = e.target.closest('.adm-prod-download');
      dlBtn.disabled = true;
      invokeAdminFn('admin-get-download-url', { productId: p.dbId }, 'Could not download the product file.').then(function (d) {
        dlBtn.disabled = false;
        window.open(d.url, '_blank', 'noopener');
      }).catch(function (err) {
        dlBtn.disabled = false;
        alert(err.message || 'Could not download the product file.');
      });
    } else if (e.target.closest('.adm-prod-edit')) {
      openProductEdit(id);
    }
  });
  var prodSearch = $('admProdSearch');
  if (prodSearch) prodSearch.addEventListener('input', renderProducts);

  /* ---- Product edit panel ---- */
  var ADM_ICON_TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  var CATEGORIES_BY_PLATFORM = {
    Roblox: ['Finished Games & Templates', 'Maps', 'Scripts & UI', 'Graphics', 'Buildings', 'Assets', 'Uniforms & Gear', 'Boats', 'Weapons', 'Vehicles', 'Animations & VFX']
  };
  // Mirrors the sidebar subcategory filter tree on the shop page.
  var SUBCATS_BY_CAT = {
    'Finished Games & Templates': [['finished-games', 'Finished Games'], ['game-templates', 'Game Templates']],
    'Maps': [['cities-towns', 'Cities & Towns'], ['houses-estates', 'Houses & Estates'], ['military-government', 'Military & Government'], ['nature-terrain', 'Nature & Terrain'], ['scpf', 'SCPF'], ['sci-fi', 'Sci-Fi'], ['airports-aviation', 'Airports & Aviation'], ['medieval', 'Medieval'], ['lobby-spawns', 'Lobby & Spawns'], ['cafes-retail', 'Cafes & Retail'], ['ugc-showcase-homestores', 'UGC Showcase & Homestores'], ['combat', 'Combat'], ['low-poly', 'Low Poly'], ['simulator', 'Simulator'], ['stud-style', 'Stud-style']],
    'Scripts & UI': [['scripted-systems', 'Scripted Systems'], ['non-scripted-ui', 'Non-Scripted UI'], ['ui-packs', 'UI Packs'], ['roleplay', 'Roleplay'], ['military', 'Military'], ['combat', 'Combat'], ['economy', 'Economy']],
    'Graphics': [['military', 'Military'], ['scpf', 'SCPF'], ['logos', 'Logos']],
    'Buildings': [['filler', 'Filler'], ['furnished', 'Furnished'], ['roleplay', 'Roleplay'], ['building-packs', 'Building Packs'], ['military', 'Military'], ['houses-residential', 'Houses & Residential'], ['government', 'Government'], ['medieval', 'Medieval'], ['scpf', 'SCPF'], ['sci-fi', 'Sci-Fi'], ['stores-commercial', 'Stores & Commercial']],
    'Assets': [['asset-packs', 'Asset Packs'], ['realistic', 'Realistic'], ['medieval', 'Medieval'], ['sci-fi', 'Sci-Fi'], ['low-poly', 'Low Poly'], ['aviation', 'Aviation'], ['scpf', 'SCPF'], ['furniture', 'Furniture'], ['nature', 'Nature'], ['stud-style', 'Stud-style']],
    'Uniforms & Gear': [['2d-uniforms', '2D Uniforms'], ['3d-gear', '3D Gear'], ['military-government', 'Military & Government'], ['roleplay', 'Roleplay'], ['aviation', 'Aviation'], ['morphs', 'Morphs']],
    'Boats': [['military', 'Military'], ['civilian', 'Civilian'], ['commercial', 'Commercial']],
    'Weapons': [['military', 'Military'], ['medieval', 'Medieval'], ['scripted', 'Scripted'], ['firearms', 'Firearms'], ['melees', 'Melees']],
    'Vehicles': [['scripted', 'Scripted Vehicles'], ['military', 'Military'], ['civilian', 'Civilian'], ['trains-locomotives', 'Trains & Locomotives'], ['emergency-services', 'Emergency Services']],
    'Animations & VFX': [['vfx', 'VFX'], ['animations', 'Animations'], ['vfx-packs', 'VFX Packs'], ['combat', 'Combat VFX'], ['auras', 'Aura VFX'], ['rng-vfx', 'RNG VFX'], ['anime-vfx', 'Anime VFX'], ['animation-packs', 'Animation Packs'], ['combat-animations', 'Combat Animations']]
  };
  var editContacts = [];
  var editProofFiles = [];
  var editDevProofFiles = [];
  var editGallery = [];
  var pendingStoragePath = null; // set when a new product file upload succeeds, sent on next save
  var draftSlug = null; // lazily-created placeholder path prefix for uploads before the product has a real slug

  // Uploads a file to Storage via admin-get-upload-url, then PUTs the bytes
  // straight there (bytes never pass through our own server/functions).
  // kind: 'thumbnail' | 'gallery' | 'productFile'. productSlug is only ever
  // used as a Storage path prefix for organization - it doesn't need to
  // match the product's real slug, so a brand-new unsaved product gets a
  // throwaway draft identifier instead of blocking uploads until first save.
  // Which file types each upload area accepts (extension, lower case). The same lists are
  // enforced server-side in admin-get-upload-url; kinds not listed here (staged unreleased
  // files) take anything.
  var UPLOAD_ALLOWED = {
    thumbnail: ['gif', 'png', 'jpg', 'jpeg', 'zip', 'mp4'],
    gallery: ['gif', 'png', 'jpg', 'jpeg', 'zip', 'mp4'],
    productFile: ['zip', 'rbxm', 'rbxl'],
    legalDoc: ['zip', 'mp4', 'png', 'jpg', 'jpeg']
  };
  function uploadAllowedMsg(kind, file) {
    var list = UPLOAD_ALLOWED[kind];
    if (!list) return null;
    var m = /\.([a-z0-9]+)$/i.exec(file.name || '');
    var ext = m ? m[1].toLowerCase() : '';
    if (list.indexOf(ext) >= 0) return null;
    var shown = list.filter(function (e) { return e !== 'jpg'; }).map(function (e) { return '.' + e; });
    return file.name + ' is not an accepted file type. Accepted: ' + shown.join(', ') + '.';
  }
  function uploadToStorageRaw(kind, file, slugOverride) {
    var typeMsg = uploadAllowedMsg(kind, file);
    if (typeMsg) return Promise.reject(new Error(typeMsg));
    var slug = slugOverride || $('admEditId').value;
    if (!slug) {
      if (!draftSlug) draftSlug = 'draft-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      slug = draftSlug;
    }
    // Public images are capped at 100 MB by the upload server (admin-get-upload-url).
    // Say so up front, with the file's real size, instead of the server's bare "File is too large."
    if ((kind === 'thumbnail' || kind === 'gallery') && file.size > 100 * 1024 * 1024) {
      return Promise.reject(new Error(file.name + ' is ' + formatFileSize(file.size) + ', over the 100 MB image limit.'));
    }
    return invokeAdminFn('admin-get-upload-url', { kind: kind, productSlug: slug, filename: file.name }, 'Could not prepare upload.').then(function (d) {
      // driver:'cdn' = signed POST to cdn.coldd.dev/upload.php (Ultimate Hosting);
      // no driver = Supabase Storage, used until the CDN secrets are set.
      if (d.driver === 'cdn' && d.chunked) {
        // Private files go up in 4MB pieces so size isn't limited by PHP's
        // per-request caps; each piece is retried a few times so a blip on a
        // multi-hundred-MB upload doesn't force a restart.
        var CHUNK = 4 * 1024 * 1024;
        var sendChunk = function (offset, tries) {
          var end = Math.min(offset + CHUNK, file.size);
          var body = new FormData();
          body.append('file', file.slice(offset, end), 'chunk');
          var last = end >= file.size ? 1 : 0;
          return fetch(d.uploadUrl + '&offset=' + offset + '&last=' + last, { method: 'POST', body: body }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) {
              if (r.status === 409 && typeof j.have === 'number' && j.have > offset && j.have < file.size) return sendChunk(j.have, 3); // earlier attempt had landed; resume after it
              if (!r.ok || !j.ok) { var e = new Error(j.error || 'Upload failed (' + r.status + ').'); e.fatal = r.status >= 400 && r.status < 500; throw e; }
              return last ? null : sendChunk(end, 3);
            });
          }).catch(function (e) {
            if (!e.fatal && tries > 1) return sendChunk(offset, tries - 1);
            throw new Error(e.fatal ? e.message : 'File storage is temporarily unavailable. Please try again shortly.');
          });
        };
        return sendChunk(0, 3).then(function () { return { path: d.path, publicUrl: d.publicUrl }; });
      }
      if (d.driver === 'cdn') {
        var fd = new FormData();
        fd.append('file', file);
        return fetch(d.uploadUrl, { method: 'POST', body: fd }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok || !j.ok) throw new Error(j.error || 'Upload failed (' + r.status + ').');
            return { path: d.path, publicUrl: d.publicUrl };
          });
        }, function () { throw new Error('Image storage is temporarily unavailable. Please try again shortly.'); });
      }
      return window.coldSupabase.storage.from(d.bucket).uploadToSignedUrl(d.path, d.token, file).then(function (upRes) {
        if (upRes.error) throw new Error(upRes.error.message || 'Upload failed.');
        return { path: d.path, publicUrl: d.publicUrl };
      });
    });
  }

  // Every upload reports back with the same corner toast as "Product created":
  // green and auto-dismissing on success, red and sticky (click to dismiss) on failure.
  function uploadToStorage(kind, file, slugOverride) {
    return uploadToStorageRaw(kind, file, slugOverride).then(function (r) {
      admToast('Uploaded ' + file.name, true);
      return r;
    }, function (err) {
      admToast(file.name + ' failed to upload: ' + ((err && err.message) || 'try again'), false);
      if (err && typeof err === 'object') err.toasted = true;
      throw err;
    });
  }

  // The placeholder is the products table's column default, so a product that
  // has never had a real upload still reads as having a file. Say so plainly
  // rather than leaving the admin to guess.
  var PLACEHOLDER_PATH = '_shared/placeholder.zip';
  // The product file shows as a card (type badge, name, Download and Remove)
  // instead of a line of text. "removed" holds a pending removal per panel; it
  // saves with the product, like a pending upload does.
  var FILE_REMOVED = { edit: false, upd: false };
  function fileExtOf(name) { var m = /\.([a-z0-9]{1,5})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : 'file'; }
  function fileNoteMsg(el, text, warn) {
    if (!el) return;
    el.hidden = false;
    el.innerHTML = '<div class="adm-filecard-main"><span class="' + (warn ? 'adm-note-warn' : 'adm-sub') + '">' + esc(text) + '</span></div>';
  }
  function setFileNote(el, storagePath, pendingName) {
    if (!el) return;
    var scope = el.id === 'admUpdFileNote' ? 'upd' : 'edit';
    var name, status, canDownload = false;
    if (pendingName) {
      name = pendingName; status = 'Uploaded, saves with the product';
    } else if (storagePath && storagePath !== PLACEHOLDER_PATH && !FILE_REMOVED[scope]) {
      // Strip the 8-char storage prefix so this matches the filename the buyer
      // actually receives (see _shared/download.ts downloadName).
      name = storagePath.split('/').pop().replace(/^[0-9a-f]{8}-/i, '');
      status = 'Attached'; canDownload = true;
    } else {
      el.hidden = true; el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = '<span class="adm-filecard-ic">' + esc(fileExtOf(name)) + '</span>' +
      '<div class="adm-filecard-main"><strong>' + esc(name) + '</strong><span class="adm-sub">' + status + '</span></div>' +
      '<div class="adm-filecard-acts">' +
        (canDownload ? '<button type="button" class="adm-mp-done" data-fc="download" data-scope="' + scope + '">Download</button>' : '') +
        '<button type="button" class="adm-mp-del" data-fc="remove" data-scope="' + scope + '" title="Remove file" aria-label="Remove file">' + ADM_ICON_TRASH + '</button>' +
      '</div>';
  }

  /* ---- Reusable custom dropdown (replaces native <select> everywhere in admin) ----
     root must contain .adm-dd-btn (with .adm-dd-val + chevron) and .adm-dd-menu,
     matching the markup already used for the product category picker.

     opts.searchable: injects a filter input at the top of the menu - for the
     user/product pickers (grant form, reseller product), which can run to
     hundreds of unsorted rows otherwise (a tester flagged scrolling a long,
     non-alphabetical user list to find one person as unusable).
     opts.multi: value becomes a comma-joined list of selected values instead
     of one, checkboxes instead of radio dots, clicking an option toggles it
     without closing the menu. Only the product picker in the grant form
     needs this (granting several products to one user at once). */
  function makeDropdown(root, opts) {
    opts = opts || {};
    if (!root) return { setOptions: function () {}, setValue: function () {}, getValue: function () { return ''; }, close: function () {} };
    var btn = root.querySelector('.adm-dd-btn');
    var valEl = root.querySelector('.adm-dd-val');
    var menu = root.querySelector('.adm-dd-menu');
    var valueInput = opts.valueInput || null;
    var placeholder = opts.placeholder || 'Select…';
    var multi = !!opts.multi;
    var current = multi ? [] : '';
    var optionList = [];

    function close() { root.classList.remove('open'); if (menu) menu.hidden = true; if (btn) btn.setAttribute('aria-expanded', 'false'); }
    function open() {
      root.classList.add('open'); if (menu) menu.hidden = false; if (btn) btn.setAttribute('aria-expanded', 'true');
      var search = menu ? menu.querySelector('.adm-dd-search') : null;
      if (search) { search.value = ''; filterOptions(''); setTimeout(function () { search.focus(); }, 30); }
    }
    function labelFor(value) {
      var found = optionList.filter(function (o) { return o.value === value; })[0];
      return found ? found.label : value;
    }
    function filterOptions(q) {
      q = (q || '').trim().toLowerCase();
      if (!menu) return;
      Array.prototype.forEach.call(menu.querySelectorAll('.adm-dd-opt'), function (o) {
        var label = (o.getAttribute('data-label') || '').toLowerCase();
        o.hidden = !!q && label.indexOf(q) < 0;
      });
    }
    function syncButtonLabel() {
      if (!valEl) return;
      var empty = multi ? current.length === 0 : !current;
      var text;
      if (empty) text = placeholder;
      else if (!multi) text = labelFor(current);
      else if (current.length <= 3) text = current.map(function (v) { return labelFor(v); }).join(', ');
      else text = current.length + ' selected';
      valEl.textContent = text;
      valEl.classList.toggle('placeholder', empty);
    }
    function setValue(value, silent) {
      current = multi ? (Array.isArray(value) ? value.slice() : (value ? String(value).split(',').filter(Boolean) : [])) : (value || '');
      syncButtonLabel();
      if (valueInput) valueInput.value = multi ? current.join(',') : current;
      if (menu) Array.prototype.forEach.call(menu.querySelectorAll('.adm-dd-opt'), function (o) {
        var v = o.getAttribute('data-value');
        var isActive = multi ? current.indexOf(v) >= 0 : v === current;
        o.classList.toggle('active', isActive);
        o.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      if (!silent && typeof opts.onChange === 'function') opts.onChange(current);
    }
    function toggleValue(v) {
      var i = current.indexOf(v);
      var next = current.slice();
      if (i >= 0) next.splice(i, 1); else next.push(v);
      setValue(next);
    }
    function setOptions(list, selected) {
      optionList = list.map(function (o) { return typeof o === 'string' ? { value: o, label: o } : o; });
      if (menu) {
        var searchHtml = opts.searchable ? '<input type="text" class="adm-dd-search adm-input" placeholder="Search…" />' : '';
        menu.innerHTML = searchHtml + optionList.map(function (o) {
          return '<button type="button" class="adm-dd-opt" data-value="' + esc(o.value) + '" data-label="' + esc(o.label) + '" role="option" aria-selected="false"><span>' + esc(o.label) + '</span><span class="adm-dd-radio' + (multi ? ' adm-dd-check' : '') + '"></span></button>';
        }).join('');
        Array.prototype.forEach.call(menu.querySelectorAll('.adm-dd-opt'), function (o) {
          o.addEventListener('click', function () {
            if (multi) toggleValue(o.getAttribute('data-value'));
            else { setValue(o.getAttribute('data-value')); close(); }
          });
        });
        var search = menu.querySelector('.adm-dd-search');
        if (search) {
          search.addEventListener('input', function () { filterOptions(search.value); });
          // Enter picks the first visible match, so typing "ani" + Enter is the whole interaction.
          search.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { close(); if (btn) btn.focus(); return; }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            var first = Array.prototype.filter.call(menu.querySelectorAll('.adm-dd-opt'), function (o) { return !o.hidden; })[0];
            if (first) first.click();
          });
        }
      }
      setValue((selected != null ? selected : current), true);
    }
    if (btn) btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu && menu.hidden) open(); else close();
    });
    // Searchable dropdowns: typing a letter on the focused button opens the list with that letter pre-filled.
    if (btn && opts.searchable) btn.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === ' ') return;
      e.preventDefault();
      open();
      var search = menu ? menu.querySelector('.adm-dd-search') : null;
      if (search) { search.value = e.key; filterOptions(e.key); }
    });
    document.addEventListener('click', function (e) { if (!root.contains(e.target)) close(); });

    return { setOptions: setOptions, setValue: setValue, getValue: function () { return current; }, close: close };
  }

  var prodSortDropdown = makeDropdown($('admProdSortDD'), {
    onChange: function (v) { PROD_SORT = v || 'newest'; lsSet('coldd_admin_prod_sort_v1', PROD_SORT); renderProducts(); }
  });
  prodSortDropdown.setOptions([
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
    { value: 'sales-desc', label: 'Highest Sales' },
    { value: 'sales-asc', label: 'Lowest Sales' },
    { value: 'rating-desc', label: 'Highest Rated' },
    { value: 'price-desc', label: 'Price: High to Low' },
    { value: 'price-asc', label: 'Price: Low to High' }
  ], PROD_SORT);

  var subcatDropdown = makeDropdown($('admEditSubcatDD'), { valueInput: $('admEditSubcat'), placeholder: 'Select subcategories', searchable: true, multi: true });
  function populateSubcatSelect(cat, selected) {
    var subs = SUBCATS_BY_CAT[cat] || [];
    var opts = subs.map(function (s) { return { value: s[0], label: s[1] }; });
    // A product can sit in several sub-categories: "selected" is a
    // comma-separated list. Keep any stored value that is no longer in the list
    // visible so saving doesn't silently drop it.
    var sel = selected ? String(selected).split(',').map(function (v) { return v.trim(); }).filter(Boolean) : [];
    sel.forEach(function (v) { if (!opts.some(function (o) { return o.value === v; })) opts.push({ value: v, label: v }); });
    subcatDropdown.setOptions(opts, sel);
  }
  var catDropdown = makeDropdown($('admEditCatDD'), {
    valueInput: $('admEditCat'), placeholder: 'Select category', searchable: true,
    onChange: function (cat) {
      populateSubcatSelect(cat, null);
      // Hand focus to Subcategory so the next keystroke starts searching it.
      var sb = $('admEditSubcatDD') && $('admEditSubcatDD').querySelector('.adm-dd-btn');
      if (sb && cat) sb.focus();
    }
  });
  function populateCategorySelect(platform, selected, subcatToKeep) {
    var cats = CATEGORIES_BY_PLATFORM[platform] || [];
    if (selected && cats.indexOf(selected) < 0) cats = cats.concat([selected]);
    // No default category on a new product - defaulting to the first one in
    // the list silently let "Finished Games & Templates" through on
    // anything the admin forgot to categorize, since the required-field
    // check saw a non-empty value either way.
    var finalCat = selected || '';
    catDropdown.setOptions(cats, finalCat);
    populateSubcatSelect(finalCat, subcatToKeep);
  }
  function setEditPlatform(platform, catToKeep, subcatToKeep) {
    $('admEditPlatform').value = platform;
    populateCategorySelect(platform, catToKeep, subcatToKeep);
    updateDevexAutofill();
  }
  // The Robux price rounds up to a clean hundred rather than quoting the
  // raw DevEx figure (e.g. $5 -> 1316 -> 1400) since nobody prices a Robux
  // listing at a number like 1316.
  function devexRobuxPrice(usdPrice) { return Math.ceil((usdPrice / DEVEX_USD_PER_ROBUX) / 100) * 100; }
  // Set once the admin types into a Robux field directly, or once an
  // existing product with its own non-formula Robux price loads - either
  // way, autofill backs off and leaves their number alone from then on.
  var robuxPriceManuallySet = false;
  var resellRobuxPriceManuallySet = false;
  function updateDevexAutofill() {
    var platform = ($('admEditPlatform') || {}).value;
    if (platform !== 'Roblox') return;
    var usdPrice = parseFloat($('admEditPrice').value) || 0;
    if (!robuxPriceManuallySet) $('admEditRobuxPrice').value = usdPrice > 0 ? devexRobuxPrice(usdPrice) : '';
    var resellUsdPrice = parseFloat($('admEditResellPrice').value) || 0;
    if (!resellRobuxPriceManuallySet) $('admEditResellRobuxPrice').value = resellUsdPrice > 0 ? devexRobuxPrice(resellUsdPrice) : '';
  }
  // f.path (real upload, private product-files bucket) opens via a
  // freshly-minted signed URL on click - no permanent URL is ever stored,
  // so there's nothing to go stale. f.url only appears on entries saved
  // before that existed (a blob: URL, dead the moment that tab closed) -
  // shown as plain text since there's nothing left to link to.
  function renderFileList(listId, files, removeClass) {
    var list = $(listId); if (!list) return;
    list.innerHTML = files.map(function (f, i) {
      var name = typeof f === 'string' ? f : (f.name || '');
      var path = typeof f === 'string' ? null : f.path;
      var ext = fileExtOf(name);
      var kind = /^(mp4|webm|mov|m4v)$/.test(ext) ? 'video' : /^(png|jpe?g|gif|webp)$/.test(ext) ? 'image' : /^(mp3|wav|ogg|m4a)$/.test(ext) ? 'audio' : 'file';
      var acts = '';
      if (path) {
        if (kind !== 'file') acts += '<button type="button" class="adm-mp-done" data-fl="view" data-kind="' + kind + '" data-path="' + esc(path) + '">' + (kind === 'image' ? 'View' : 'Play') + '</button>';
        acts += '<button type="button" class="adm-mp-done" data-fl="download" data-path="' + esc(path) + '">Download</button>';
      }
      return '<div class="adm-file-item adm-file-card"><span class="adm-filecard-ic">' + esc(ext) + '</span>' +
        '<span class="adm-file-name">' + esc(name) + (path ? '' : ' <em>(no stored file to open, upload it again)</em>') + '</span>' + acts +
        '<button type="button" class="adm-icon-btn ' + removeClass + '" data-i="' + i + '" title="Remove" aria-label="Remove">' + ADM_ICON_TRASH + '</button>' +
        '<div class="adm-file-preview" hidden></div></div>';
    }).join('') || '<p class="adm-empty" style="padding:8px 0;">No files uploaded yet.</p>';
  }
  function renderProofList() { renderFileList('admLegalProofList', editProofFiles, 'adm-proof-remove'); }
  function renderDevProofList() { renderFileList('admLegalDevProofList', editDevProofFiles, 'adm-dev-proof-remove'); }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fl]');
    if (!b || !(b.closest('#admLegalProofList') || b.closest('#admLegalDevProofList'))) return;
    var act = b.getAttribute('data-fl'), path = b.getAttribute('data-path'), kind = b.getAttribute('data-kind');
    var prev = b.closest('.adm-file-item').querySelector('.adm-file-preview');
    if (act === 'view' && prev && !prev.hidden) { prev.hidden = true; prev.innerHTML = ''; b.textContent = kind === 'image' ? 'View' : 'Play'; return; }
    var label = b.textContent;
    b.disabled = true; b.textContent = 'Opening…';
    invokeAdminFn('admin-get-download-url', { path: path }, 'Could not open file.').then(function (d) {
      b.disabled = false;
      if (act === 'download') { b.textContent = label; window.open(d.url, '_blank', 'noopener'); return; }
      b.textContent = 'Hide';
      var u = esc(d.url);
      prev.innerHTML = kind === 'video' ? '<video controls autoplay playsinline preload="metadata" src="' + u + '"></video>'
        : kind === 'audio' ? '<audio controls autoplay src="' + u + '"></audio>'
        : '<img src="' + u + '" alt="" />';
      prev.hidden = false;
    }).catch(function (err) {
      b.disabled = false; b.textContent = label;
      admToast(err.message || 'Could not open file.', false);
    });
  });
  function renderGalleryList() {
    var list = $('admEditGalleryList'); if (!list) return;
    list.innerHTML = editGallery.map(function (src, i) {
      return '<div class="adm-gallery-item"><a href="' + esc(src) + '" target="_blank" rel="noopener"><img src="' + esc(src) + '" alt="" /></a><button type="button" class="adm-gallery-remove" data-i="' + i + '">' + ADM_ICON_TRASH + '</button></div>';
    }).join('');
  }
  function updateThumbPreview() {
    var img = $('admEditThumbPreview'); if (!img) return;
    var url = $('admEditThumbUrl').value.trim();
    img.src = url;
    $('admEditThumbEmpty').hidden = !!url;
    $('admEditThumbPreviewWrap').hidden = !url;
  }
  function addThumbFile(file) {
    if (!file) return;
    uploadToStorage('thumbnail', file).then(function (r) {
      $('admEditThumbUrl').value = r.publicUrl;
      updateThumbPreview();
    }).catch(function () { /* admToast already reported it */ });
  }
  function addGalleryFiles(files) {
    Array.prototype.forEach.call(files, function (f) {
      uploadToStorage('gallery', f).then(function (r) {
        editGallery.push(r.publicUrl);
        renderGalleryList();
      }).catch(function () { /* admToast already reported it */ });
    });
  }
  function renderContactList() {
    var list = $('admLegalContactList'); if (!list) return;
    list.innerHTML = editContacts.map(function (c, i) {
      return '<div class="adm-contact-row" data-i="' + i + '">' +
        '<input type="text" class="adm-input adm-contact-label" placeholder="Label (e.g. Discord username)" value="' + esc(c.label || '') + '" />' +
        '<input type="text" class="adm-input adm-contact-value" placeholder="Value" value="' + esc(c.value || '') + '" />' +
        '<button type="button" class="adm-icon-btn adm-contact-remove">' + ADM_ICON_TRASH + '</button></div>';
    }).join('');
  }

  function openProductEdit(id, opts) {
    var p = findProduct(id); if (!p) return;
    pendingStoragePath = null;
    $('admEditId').value = p.id;
    $('admEditTitleInput').value = p.title;
    $('admEditPrice').value = p.price;
    $('admEditRobuxPrice').value = p.robuxPrice != null ? p.robuxPrice : '';
    robuxPriceManuallySet = p.robuxPrice != null;
    $('admEditWasPrice').value = p.wasPrice != null ? p.wasPrice : '';
    $('admEditWasPriceWrap').hidden = false;
    $('admEditPriority').checked = !!p.priority;
    setEditPlatform(p.platform, p.cat, p.subcat);
    $('admEditSubtext').value = p.desc || '';
    $('admEditLongDesc').value = p.longDesc || '';
    $('admEditResell').checked = !!p.resell;
    $('admEditResellPrice').value = p.resellPrice != null ? p.resellPrice : '';
    $('admEditResellRobuxPrice').value = p.resellRobuxPrice != null ? p.resellRobuxPrice : '';
    resellRobuxPriceManuallySet = p.resellRobuxPrice != null;
    $('admEditResellPriceWrap').hidden = !p.resell;
    $('admEditResellRobuxPriceWrap').hidden = !p.resell;
    $('admEditPrivate').checked = !p.visible;
    $('admEditDeleteBtn').hidden = false;
    if ($('admLegalDownloadBtn')) $('admLegalDownloadBtn').hidden = false;
    $('admEditHeading').textContent = 'Edit: ' + p.title;
    if ($('admMpUploadCard')) $('admMpUploadCard').hidden = true;
    $('admEditSaveBtn').textContent = 'Save changes';
    if ($('admEditStickySave')) $('admEditStickySave').querySelector('.btn-label').textContent = 'Save changes';
    $('admEditMsg').textContent = '';
    updateDevexAutofill();

    var tech = p.tech || {};
    $('admEditTechFormat').value = tech.format || '';
    $('admEditTechSize').value = tech.size || '';
    $('admEditTechFileName').value = tech.fileName || '';
    $('admEditFileInput').value = '';
    var fileNote = $('admEditFileNote');
    // This used to read tech.fileName - a free-text field the admin types for
    // display on the product page - so it happily said "Selected: kit.zip"
    // while storage_path was still the column default and buyers were
    // downloading the placeholder. Report the actual attached object.
    FILE_REMOVED.edit = false;
    setFileNote(fileNote, p.storagePath);

    $('admEditThumbUrl').value = p.image || '';
    updateThumbPreview();
    editGallery = (p.gallery || []).slice();
    renderGalleryList();
    $('admEditVideoUrl').value = p.video || '';

    var legal = p.legal || defaultLegal();
    $('admLegalTos').value = legal.tos || '';
    editContacts = (legal.contacts || []).map(function (c) { return Object.assign({}, c); });
    editProofFiles = (legal.proofFiles || []).map(function (f) { return typeof f === 'string' ? { name: f, url: null } : f; });
    editDevProofFiles = (legal.devProofFiles || []).map(function (f) { return typeof f === 'string' ? { name: f, url: null } : f; });
    renderContactList(); renderProofList(); renderDevProofList();
    $('admLegalCostAmount').value = legal.licenseCost || 0;
    setCostCurrency(legal.licenseCostCurrency || 'usd');
    $('admLegalPurchasedAt').value = legal.licensePurchasedAt || '';
    $('admLegalMinUsd').value = legal.minSaleUsd || 0;
    $('admLegalMinRobux').value = legal.minSaleRobux || 0;
    $('admLegalMaxDiscount').value = legal.maxDiscountPct || 0;
    $('admLegalCannotBeFree').checked = !legal.canBeFree;
    $('admLegalDisallowSales').checked = !!legal.disallowSales;

    showPanel('product-edit', Object.assign({ extra: p.slug }, opts));
  }

  function wireDropzone(dropEl, inputEl, onFiles) {
    if (!dropEl || !inputEl) return;
    dropEl.addEventListener('click', function () { inputEl.click(); });
    inputEl.addEventListener('change', function () { onFiles(inputEl.files); inputEl.value = ''; });
    dropEl.addEventListener('dragover', function (e) { e.preventDefault(); dropEl.classList.add('dragover'); });
    dropEl.addEventListener('dragleave', function () { dropEl.classList.remove('dragover'); });
    dropEl.addEventListener('drop', function (e) {
      e.preventDefault();
      dropEl.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
    });
  }

  wireDropzone($('admEditFileDrop'), $('admEditFileInput'), function (files) {
    var f = files[0]; if (!f) return;
    var fileNote = $('admEditFileNote');
    var dot = f.name.lastIndexOf('.');
    $('admEditTechFormat').value = dot >= 0 ? f.name.slice(dot).toLowerCase() : '';
    $('admEditTechSize').value = formatFileSize(f.size);
    $('admEditTechFileName').value = f.name;
    FILE_REMOVED.edit = false;
    fileNoteMsg(fileNote, 'Uploading ' + f.name + '…');
    uploadToStorage('productFile', f).then(function (r) {
      pendingStoragePath = r.path;
      setFileNote(fileNote, null, f.name);
    }).catch(function (err) {
      pendingStoragePath = null;
      fileNoteMsg(fileNote, 'Upload failed: ' + (err.message || 'try again') + '.', true);
    });
  });

  /* ================================================================
     UNRELEASED FILES - staging area for files that aren't real
     products yet. Not part of the products list/filter at all; each
     row is just a Storage upload + a renamable display name.
     ================================================================ */
  var UNRELEASED_FILES = [];
  function loadUnreleasedFiles() {
    return invokeAdminFn('admin-unreleased-files', { action: 'list' }).then(function (d) {
      UNRELEASED_FILES = d.files || [];
      var badge = $('admUnreleasedCount');
      if (badge) { badge.hidden = !UNRELEASED_FILES.length; badge.textContent = UNRELEASED_FILES.length ? '(' + UNRELEASED_FILES.length + ')' : ''; }
      renderAll();
    }).catch(function (err) { console.error('[admin] failed to load unreleased files:', err.message); });
  }
  function renderUnreleasedFiles() {
    var list = $('admUnreleasedList'); if (!list) return;
    list.innerHTML = UNRELEASED_FILES.map(function (f) {
      return '<div class="adm-file-item" data-id="' + esc(f.id) + '">' +
        '<input type="text" class="adm-file-rename" value="' + esc(f.display_name) + '" />' +
        (f.size_bytes ? '<span class="adm-file-meta">' + formatFileSize(f.size_bytes) + '</span>' : '') +
        '<button type="button" class="btn btn-ghost adm-btn-sm adm-unreleased-download" title="Download this file">Download</button>' +
        '<button type="button" class="btn btn-ghost adm-btn-sm adm-unreleased-create" ' + (can('admin') ? '' : 'disabled ') + 'title="Create a product from this file">Create product</button>' +
        '<button type="button" class="adm-icon-btn adm-unreleased-remove" title="Delete" aria-label="Delete">' + ADM_ICON_TRASH + '</button>' +
        '</div>';
    }).join('') || '<p class="adm-empty" style="padding:8px 0;">Nothing staged right now - drop a file above to keep track of it.</p>';
  }
  // Acquiring a product -> uploading the file -> uploading it to the store
  // used to be three disconnected steps: drop the file here to hold onto
  // it, then separately open Create Product and upload the SAME file again
  // from scratch. Reuses the file already sitting in Storage (product
  // downloads read products.storage_path directly with no prefix
  // requirement - see get-download-url - so there's nothing to move) and
  // opens Create Product with it already attached, one step instead of two.
  var pendingUnreleasedFileId = null;
  function startProductFromUnreleased(file) {
    openProductCreate();
    pendingStoragePath = file.storage_path;
    pendingUnreleasedFileId = file.id;
    setFileNote($('admEditFileNote'), null, file.display_name);
    // Best-effort starting point, not a real title - strip the extension
    // and turn separators into spaces so there's something to edit instead
    // of a blank field, admin still reviews/renames before saving either way.
    var guess = file.display_name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    if (guess) $('admEditTitleInput').value = guess;
  }
  wireDropzone($('admUnreleasedDrop'), $('admUnreleasedInput'), function (files) {
    Array.prototype.slice.call(files).forEach(function (f) {
      uploadToStorage('unreleasedFile', f).then(function (r) {
        return invokeAdminFn('admin-unreleased-files', { action: 'create', storagePath: r.path, displayName: f.name, sizeBytes: f.size });
      }).then(function () {
        return loadUnreleasedFiles();
      }).catch(function (err) { if (!(err && err.toasted)) admToast((err && err.message) || 'Upload failed.', false); });
    });
  });
  var unreleasedList = $('admUnreleasedList');
  if (unreleasedList) {
    unreleasedList.addEventListener('click', function (e) {
      var createBtn = e.target.closest('.adm-unreleased-create');
      if (createBtn) {
        if (!can('admin')) return;
        var createRow = e.target.closest('.adm-file-item'); if (!createRow) return;
        var file = UNRELEASED_FILES.filter(function (f) { return f.id === createRow.getAttribute('data-id'); })[0];
        if (file) startProductFromUnreleased(file);
        return;
      }
      var dlBtn = e.target.closest('.adm-unreleased-download');
      if (dlBtn) {
        var dlRow = e.target.closest('.adm-file-item'); if (!dlRow) return;
        var dlId = dlRow.getAttribute('data-id');
        var prevText = dlBtn.textContent;
        dlBtn.disabled = true; dlBtn.textContent = 'Opening…';
        invokeAdminFn('admin-unreleased-files', { action: 'download', id: dlId }, 'Could not open file.').then(function (d) {
          dlBtn.disabled = false; dlBtn.textContent = prevText;
          window.open(d.url, '_blank', 'noopener');
        }).catch(function (err) {
          dlBtn.disabled = false; dlBtn.textContent = prevText;
          alert(err.message || 'Could not open file.');
        });
        return;
      }
      var btn = e.target.closest('.adm-unreleased-remove'); if (!btn) return;
      var row = e.target.closest('.adm-file-item'); if (!row) return;
      var id = row.getAttribute('data-id');
      btn.disabled = true;
      invokeAdminFn('admin-unreleased-files', { action: 'delete', id: id }).then(function () {
        return loadUnreleasedFiles();
      }).catch(function (err) { btn.disabled = false; alert(err.message || 'Could not delete file.'); });
    });
    unreleasedList.addEventListener('blur', function (e) {
      var input = e.target.closest('.adm-file-rename'); if (!input) return;
      var row = e.target.closest('.adm-file-item'); if (!row) return;
      var id = row.getAttribute('data-id');
      var name = input.value.trim();
      var current = (UNRELEASED_FILES.filter(function (f) { return f.id === id; })[0] || {}).display_name || '';
      if (!name || name === current) { input.value = current; return; }
      invokeAdminFn('admin-unreleased-files', { action: 'rename', id: id, displayName: name }).then(function () {
        return loadUnreleasedFiles();
      }).catch(function (err) { input.value = current; alert(err.message || 'Could not rename file.'); });
    }, true);
    unreleasedList.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.closest('.adm-file-rename')) { e.preventDefault(); e.target.blur(); }
    });
  }
  var openUnreleasedBtn = $('admOpenUnreleasedPanel');
  if (openUnreleasedBtn) openUnreleasedBtn.addEventListener('click', function () { showPanel('unreleased', { extra: 'unreleased' }); });

  wireDropzone($('admEditThumbDrop'), $('admEditThumbInput'), function (files) { addThumbFile(files[0]); });
  var thumbRemoveBtn = $('admEditThumbRemove');
  if (thumbRemoveBtn) thumbRemoveBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    $('admEditThumbUrl').value = '';
    updateThumbPreview();
  });
  var thumbPreviewImg = $('admEditThumbPreview');
  if (thumbPreviewImg) thumbPreviewImg.addEventListener('click', function (e) {
    e.stopPropagation();
    var url = $('admEditThumbUrl').value.trim();
    if (url) window.open(url, '_blank');
  });

  wireDropzone($('admEditGalleryDrop'), $('admEditGalleryInput'), addGalleryFiles);
  var galleryList = $('admEditGalleryList');
  if (galleryList) galleryList.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-gallery-remove'); if (!btn) return;
    editGallery.splice(+btn.getAttribute('data-i'), 1);
    renderGalleryList();
  });

  function setCostCurrency(currency) {
    $('admLegalCostCurrency').value = currency;
    document.querySelectorAll('#admLegalCostCurrencyToggle button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-currency') === currency);
    });
  }
  document.querySelectorAll('#admLegalCostCurrencyToggle button').forEach(function (b) {
    b.addEventListener('click', function () { setCostCurrency(b.getAttribute('data-currency')); });
  });

  var editPriceInput = $('admEditPrice');
  if (editPriceInput) editPriceInput.addEventListener('input', updateDevexAutofill);
  var editRobuxPriceInput = $('admEditRobuxPrice');
  if (editRobuxPriceInput) editRobuxPriceInput.addEventListener('input', function () { robuxPriceManuallySet = true; });
  var editResellPriceInput = $('admEditResellPrice');
  if (editResellPriceInput) editResellPriceInput.addEventListener('input', updateDevexAutofill);
  var editResellRobuxPriceInput = $('admEditResellRobuxPrice');
  if (editResellRobuxPriceInput) editResellRobuxPriceInput.addEventListener('input', function () { resellRobuxPriceManuallySet = true; });
  var editResellBox = $('admEditResell');
  if (editResellBox) editResellBox.addEventListener('change', function () { var h = !editResellBox.checked; $('admEditResellPriceWrap').hidden = h; $('admEditResellRobuxPriceWrap').hidden = h; });

  var contactAddBtn = $('admLegalContactAdd');
  if (contactAddBtn) contactAddBtn.addEventListener('click', function () { editContacts.push({ label: '', value: '' }); renderContactList(); });
  var contactList = $('admLegalContactList');
  if (contactList) {
    contactList.addEventListener('click', function (e) {
      var btn = e.target.closest('.adm-contact-remove'); if (!btn) return;
      var i = +btn.closest('.adm-contact-row').getAttribute('data-i');
      editContacts.splice(i, 1); renderContactList();
    });
    contactList.addEventListener('input', function (e) {
      var row = e.target.closest('.adm-contact-row'); if (!row) return;
      var i = +row.getAttribute('data-i');
      if (!editContacts[i]) return;
      if (e.target.classList.contains('adm-contact-label')) editContacts[i].label = e.target.value;
      else if (e.target.classList.contains('adm-contact-value')) editContacts[i].value = e.target.value;
    });
  }

  // Real Storage upload (private product-files bucket, kind 'legalDoc') -
  // this used to just wrap the file in a blob: URL, which is only valid
  // for the tab that created it and is already gone by the time the saved
  // product is reopened. A placeholder row shows immediately so a slow
  // upload doesn't look like nothing happened; it gets its real path once
  // the upload resolves, or is removed on failure.
  function addLegalFiles(list, files, rerender) {
    Array.prototype.forEach.call(files, function (f) {
      var row = { name: f.name, path: null };
      list.push(row);
      rerender();
      uploadToStorage('legalDoc', f).then(function (r) {
        row.path = r.path;
        rerender();
      }).catch(function (err) {
        var idx = list.indexOf(row);
        if (idx !== -1) list.splice(idx, 1);
        rerender();
      });
    });
  }
  wireDropzone($('admLegalProofDrop'), $('admLegalProofInput'), function (files) {
    addLegalFiles(editProofFiles, files, renderProofList);
  });
  var proofList = $('admLegalProofList');
  if (proofList) proofList.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-proof-remove'); if (!btn) return;
    editProofFiles.splice(+btn.getAttribute('data-i'), 1);
    renderProofList();
  });

  wireDropzone($('admLegalDevProofDrop'), $('admLegalDevProofInput'), function (files) {
    addLegalFiles(editDevProofFiles, files, renderDevProofList);
  });
  var devProofList = $('admLegalDevProofList');
  if (devProofList) devProofList.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-dev-proof-remove'); if (!btn) return;
    editDevProofFiles.splice(+btn.getAttribute('data-i'), 1);
    renderDevProofList();
  });

  function openProductCreate(opts) {
    pendingStoragePath = null;
    pendingUnreleasedFileId = null;
    $('admEditId').value = '';
    $('admEditTitleInput').value = '';
    $('admEditPrice').value = 0;
    $('admEditRobuxPrice').value = '';
    robuxPriceManuallySet = false;
    $('admEditWasPrice').value = '';
    // A brand-new product can't be on sale yet - the field only makes sense
    // once it exists, so it's hidden until the first save.
    $('admEditWasPriceWrap').hidden = true;
    $('admEditPriority').checked = false;
    setEditPlatform('Roblox', null);
    $('admEditSubtext').value = '';
    $('admEditLongDesc').value = '';
    $('admEditResell').checked = false;
    $('admEditResellPrice').value = '';
    $('admEditResellRobuxPrice').value = '';
    resellRobuxPriceManuallySet = false;
    $('admEditResellPriceWrap').hidden = true;
    $('admEditResellRobuxPriceWrap').hidden = true;
    $('admEditPrivate').checked = false; // new products are shown unless marked Private
    $('admEditDeleteBtn').hidden = true;
    if ($('admLegalDownloadBtn')) $('admLegalDownloadBtn').hidden = true;
    $('admEditHeading').textContent = 'Create new product';
    mpResetUploadChecks();
    $('admEditSaveBtn').textContent = 'Create product';
    if ($('admEditStickySave')) $('admEditStickySave').querySelector('.btn-label').textContent = 'Create product';
    $('admEditMsg').textContent = '';
    updateDevexAutofill();

    ['admEditTechFormat', 'admEditTechSize', 'admEditTechFileName'].forEach(function (id) { $(id).value = ''; });
    $('admEditFileInput').value = '';
    FILE_REMOVED.edit = false;
    setFileNote($('admEditFileNote'), null);

    $('admEditThumbUrl').value = '';
    updateThumbPreview();
    editGallery = [];
    renderGalleryList();
    $('admEditVideoUrl').value = '';

    $('admLegalTos').value = '';
    editContacts = []; editProofFiles = []; editDevProofFiles = [];
    renderContactList(); renderProofList(); renderDevProofList();
    $('admLegalCostAmount').value = 0;
    setCostCurrency('usd');
    $('admLegalPurchasedAt').value = '';
    $('admLegalMinUsd').value = 0;
    $('admLegalMinRobux').value = 0;
    $('admLegalMaxDiscount').value = 0;
    $('admLegalCannotBeFree').checked = false;
    $('admLegalDisallowSales').checked = false;

    showPanel('product-edit', Object.assign({ extra: 'new' }, opts));
  }
  var createBtn = $('admOpenCreatePanel');
  if (createBtn) createBtn.addEventListener('click', function () { if (can('admin')) openProductCreate(); });

  function collectEditFields() {
    return {
      price: Math.max(0, parseFloat($('admEditPrice').value) || 0),
      // A 0-or-negative Robux price is never actually intended (nothing
      // should cost real USD and be free in Robux) - saved as null (no
      // override, falls back to the flat estimate) instead of a literal
      // 0 that then quotes the product as free everywhere Robux pricing
      // is shown. The old Math.max(0, ...) clamp let exactly that happen
      // silently on any negative or unparseable entry.
      robuxPrice: (function () {
        var v = parseFloat($('admEditRobuxPrice').value);
        return Number.isFinite(v) && v > 0 ? v : null;
      })(),
      wasPrice: (function () {
        var v = parseFloat($('admEditWasPrice').value);
        return Number.isFinite(v) && v > 0 ? v : null;
      })(),
      priority: $('admEditPriority').checked,
      cat: $('admEditCat').value,
      subcat: $('admEditSubcat').value || null,
      desc: $('admEditSubtext').value.trim(),
      longDesc: $('admEditLongDesc').value.trim(),
      resell: $('admEditResell').checked,
      resellPrice: $('admEditResell').checked && $('admEditResellPrice').value !== '' ? Math.max(0, parseFloat($('admEditResellPrice').value) || 0) : null,
      resellRobuxPrice: $('admEditResell').checked && $('admEditResellRobuxPrice').value !== '' ? Math.max(0, Math.round(parseFloat($('admEditResellRobuxPrice').value) || 0)) : null,
      visible: !$('admEditPrivate').checked,
      image: $('admEditThumbUrl').value.trim(),
      gallery: editGallery.slice(),
      video: toYouTubeEmbed($('admEditVideoUrl').value.trim()),
      tech: {
        format: $('admEditTechFormat').value.trim(),
        size: $('admEditTechSize').value.trim(),
        fileName: $('admEditTechFileName').value
      },
      legal: {
        tos: $('admLegalTos').value.trim(),
        proofFiles: editProofFiles.slice(),
        devProofFiles: editDevProofFiles.slice(),
        contacts: editContacts.filter(function (c) { return c.label || c.value; }),
        licenseCost: Math.max(0, parseFloat($('admLegalCostAmount').value) || 0),
        licenseCostCurrency: $('admLegalCostCurrency').value,
        licensePurchasedAt: $('admLegalPurchasedAt').value,
        minSaleUsd: Math.max(0, parseFloat($('admLegalMinUsd').value) || 0),
        minSaleRobux: Math.max(0, parseFloat($('admLegalMinRobux').value) || 0),
        maxDiscountPct: Math.max(0, Math.min(100, parseFloat($('admLegalMaxDiscount').value) || 0)),
        canBeFree: !$('admLegalCannotBeFree').checked,
        disallowSales: $('admLegalDisallowSales').checked
      }
    };
  }

  // Floating top-right save button - mirrors the form's own submit so the
  // admin doesn't have to scroll to the bottom of a long edit form.
  var editStickySave = $('admEditStickySave');
  if (editStickySave) editStickySave.addEventListener('click', function () {
    var f = $('admEditForm');
    if (f && f.requestSubmit) f.requestSubmit();
    else if (f) f.dispatchEvent(new Event('submit', { cancelable: true }));
  });

  // Mirror of admin-upsert-product's server-side product_legal check, so a
  // hand-set price that would breach the product's own Legal limits is
  // caught here with a clear message instead of a generic save error.
  function productLegalSaveError() {
    var price = Math.max(0, parseFloat($('admEditPrice').value) || 0);
    var wasV = parseFloat($('admEditWasPrice').value);
    var was = Number.isFinite(wasV) && wasV > price ? wasV : 0;
    var rbxV = parseFloat($('admEditRobuxPrice').value);
    var rbx = Number.isFinite(rbxV) && rbxV > 0 ? rbxV : 0;
    var minUsd = Math.max(0, parseFloat($('admLegalMinUsd').value) || 0);
    var minRbx = Math.max(0, parseFloat($('admLegalMinRobux').value) || 0);
    var maxPct = Math.max(0, Math.min(100, parseFloat($('admLegalMaxDiscount').value) || 0));
    var disallow = $('admLegalDisallowSales').checked;
    var canFree = !$('admLegalCannotBeFree').checked;
    var errs = [];
    if (was && disallow) errs.push('this product is marked "do not discount"');
    if (minUsd > 0 && price > 0 && price < minUsd) errs.push('the USD price is below the $' + minUsd.toFixed(2) + ' minimum');
    if (was && maxPct > 0 && (1 - price / was) * 100 > maxPct + 0.01) errs.push('that is a ' + Math.round((1 - price / was) * 100) + '% discount, over the ' + maxPct + '% maximum');
    if (!canFree && price <= 0) errs.push("this product isn't allowed to be free");
    if (minRbx > 0 && rbx > 0 && rbx < minRbx) errs.push('the Robux price is below the ' + minRbx + ' minimum');
    return errs.length ? ("Can't save - " + errs.join('; ') + '. Adjust the price or the Legal settings.') : null;
  }

  // Required-field check for saving a product. Every field a customer sees
  // (plus the file to deliver) must be filled in; each missing one is
  // outlined in red and the first is scrolled into view. A Private product
  // is a draft, so it only needs a title and category.
  function clearInvalidMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('#admEditForm .adm-invalid'), function (el) { el.classList.remove('adm-invalid'); });
  }
  function productMissingFieldsError(isCreate) {
    clearInvalidMarks();
    var priv = $('admEditPrivate').checked;
    var missing = [], firstEl = null;
    function need(ok, label, el) {
      if (ok) return;
      missing.push(label);
      var mark = el && (el.closest('.adm-field') || el);
      if (mark) { mark.classList.add('adm-invalid'); if (!firstEl) firstEl = mark; }
    }
    var cat = $('admEditCat').value;
    need(!!$('admEditTitleInput').value.trim(), 'Title', $('admEditTitleInput'));
    need(!!cat, 'Category', $('admEditCatDD'));
    if (!priv) {
      need(!!$('admEditSubcat').value || !(SUBCATS_BY_CAT[cat] || []).length, 'Subcategory', $('admEditSubcatDD'));
      need(parseFloat($('admEditPrice').value) > 0 || !$('admLegalCannotBeFree').checked && $('admEditPrice').value !== '', 'USD price', $('admEditPrice'));
      if ($('admEditPlatform').value === 'Roblox') need(parseFloat($('admEditRobuxPrice').value) > 0 || (!$('admLegalCannotBeFree').checked && $('admEditRobuxPrice').value !== ''), 'Robux price', $('admEditRobuxPrice'));
      if ($('admEditResell').checked) {
        need(parseFloat($('admEditResellPrice').value) > 0, 'Resell licence price (USD)', $('admEditResellPrice'));
        need(parseFloat($('admEditResellRobuxPrice').value) > 0, 'Resell licence price (Robux)', $('admEditResellRobuxPrice'));
      }
      need(!!$('admEditSubtext').value.trim(), 'Summary', $('admEditSubtext'));
      need($('admEditSubtext').value.length <= 100, 'Summary shortened to 100 characters or fewer', $('admEditSubtext'));
      need(!!$('admEditLongDesc').value.trim(), 'Description', $('admEditLongDesc'));
      need(!!$('admEditThumbUrl').value.trim(), 'Thumbnail image', $('admEditThumbDrop'));
      var fileCard = $('admEditFileNote');
      var hasFile = !!(fileCard && !fileCard.hidden && fileCard.querySelector('.adm-filecard-ic'));
      need(hasFile, 'Product file', $('admEditFileDrop'));
    }
    if (firstEl && firstEl.scrollIntoView) firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return missing.length ? ('Missing: ' + missing.join(', ') + '.') : null;
  }
  var editFormForClear = $('admEditForm');
  if (editFormForClear) editFormForClear.addEventListener('input', function (e) {
    var m = e.target && e.target.closest && e.target.closest('.adm-invalid'); if (m) m.classList.remove('adm-invalid');
  });

  var editForm = $('admEditForm');
  if (editForm) editForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var id = $('admEditId').value;
    var isCreate = !id;
    var platform = $('admEditPlatform').value;
    var msg = $('admEditMsg');
    var legalSaveErr = productLegalSaveError();
    if (legalSaveErr) { if (msg) msg.textContent = legalSaveErr; return; }
    var realSaveBtn = $('admEditSaveBtn');
    var stickySave = $('admEditStickySave');
    // A stand-in for the real save button that also drives the floating
    // top-right one (disabled state + its spinner), since the rest of this
    // handler only ever toggles saveBtn.disabled.
    var saveBtn = {
      set disabled(v) {
        if (realSaveBtn) realSaveBtn.disabled = v;
        if (stickySave) { stickySave.disabled = v; var sp = stickySave.querySelector('.btn-spinner'); if (sp) sp.hidden = !v; var lb = stickySave.querySelector('.btn-label'); if (lb) lb.hidden = v; }
      }
    };

    if (isCreate) {
      var title = $('admEditTitleInput').value.trim();
      var createMissingErr = productMissingFieldsError(true);
      if (createMissingErr) { if (msg) msg.textContent = createMissingErr; admToast(createMissingErr, false); return; }
      var fields = Object.assign({ title: title, platform: platform }, collectEditFields());
      if (!fields.image) fields.image = '/banner.jpg';
      // Create used to omit this, so a file uploaded while filling in a new
      // product was written to Storage and then thrown away: the row kept the
      // column default, _shared/placeholder.zip, and buyers downloaded the
      // placeholder. openProductEdit() runs straight after this and clears
      // pendingStoragePath, so there was no second chance to save it either.
      if (pendingStoragePath) fields.storagePath = pendingStoragePath;
      var unreleasedIdToRelease = pendingUnreleasedFileId;
      if (saveBtn) saveBtn.disabled = true;
      if (msg) msg.textContent = 'Creating…';
      var mpUploadTicks = mpReadUploadChecks();
      callUpsertProduct(fields).then(function (res) {
        logAudit('Created product "' + title + '"');
        mpSaveListings(res.id, MARKETPLACES.map(function (m) { return { key: m.key, status: mpUploadTicks[m.key] ? 'live' : 'pending' }; }));
        // The staged file now belongs to a real product - clear the
        // staging row (not the file itself, see admin-unreleased-files'
        // "release" action) so it stops showing up as still-unreleased.
        // Best-effort: a failure here just leaves a stale-but-harmless
        // staging entry, never worth blocking the product creation over.
        pendingUnreleasedFileId = null;
        var releaseP = unreleasedIdToRelease
          ? invokeAdminFn('admin-unreleased-files', { action: 'release', id: unreleasedIdToRelease }).then(loadUnreleasedFiles).catch(function () {})
          : Promise.resolve();
        return releaseP.then(function () { return refreshProducts(); }).then(function () {
          if (saveBtn) saveBtn.disabled = false;
          var created = allProducts().filter(function (p) { return p.dbId === res.id; })[0];
          if (created) openProductEdit(created.id);
          if (msg) msg.textContent = 'Created.';
          admToast('Product created', true);
        });
      }).catch(function (err) {
        if (saveBtn) saveBtn.disabled = false;
        if (msg) msg.textContent = err.message || 'Could not create product.';
        admToast(err.message || 'Could not create product', false);
      });
      return;
    }

    var p = findProduct(id); if (!p) return;
    var saveMissingErr = productMissingFieldsError(false);
    if (saveMissingErr) { if (msg) msg.textContent = saveMissingErr; admToast(saveMissingErr, false); return; }
    var fields = Object.assign({ title: $('admEditTitleInput').value.trim() || p.title, platform: platform }, collectEditFields());
    if (pendingStoragePath) fields.storagePath = pendingStoragePath;
    if (saveBtn) saveBtn.disabled = true;
    if (msg) msg.textContent = 'Saving…';
    callUpsertProduct(upsertPayloadFor(p, fields)).then(function () {
      logAudit('Updated product "' + fields.title + '"');
      pendingStoragePath = null;
      return refreshProducts();
    }).then(function () {
      if (saveBtn) saveBtn.disabled = false;
      if (msg) msg.textContent = 'Saved.';
      admToast('Changes saved', true);
    }).catch(function (err) {
      if (saveBtn) saveBtn.disabled = false;
      if (msg) msg.textContent = err.message || 'Could not save product.';
      admToast(err.message || 'Could not save product', false);
    });
  });
  var editDeleteBtn = $('admEditDeleteBtn');
  if (editDeleteBtn) editDeleteBtn.addEventListener('click', async function () {
    if (!can('admin')) return;
    var id = $('admEditId').value;
    var p = findProduct(id); if (!p) return;
    if (!(await dialogConfirm('Remove “' + p.title + '” from the storefront? You can restore it later by editing the product and setting Released back on.', { title: 'Remove product', acceptLabel: 'Remove product' }))) return;
    editDeleteBtn.disabled = true;
    callDeleteProduct(p.dbId).then(function () {
      logAudit('Removed product "' + p.title + '"');
      return refreshProducts();
    }).then(function () {
      showPanel('products');
      admToast('Product removed', true);
    }).catch(function (err) {
      editDeleteBtn.disabled = false;
      admToast(err.message || 'Could not remove product', false);
    });
  });
  var legalDownloadBtn = $('admLegalDownloadBtn');
  if (legalDownloadBtn) legalDownloadBtn.addEventListener('click', function () {
    var id = $('admEditId').value;
    var p = findProduct(id); if (!p || !window.coldSupabase) return;
    var btnLabel = legalDownloadBtn.querySelector('.btn-label');
    var btnSpinner = legalDownloadBtn.querySelector('.btn-spinner');
    legalDownloadBtn.disabled = true;
    if (btnSpinner) btnSpinner.hidden = false;
    window.coldSupabase.auth.getSession().then(function (res) {
      var token = res && res.data && res.data.session && res.data.session.access_token;
      if (!token) throw new Error('Please sign in.');
      // Returns a real .docx binary, not JSON - can't go through
      // invokeAdminFn (which always parses the response as JSON), so this
      // is a plain authenticated fetch straight to the function.
      // Same publishable anon key every other client-side Supabase call on
      // this site already ships (supabase-init.js, lock/index.html) - it's
      // meant to be public, the is_admin gate server-side is what actually
      // protects this endpoint, not keeping this value secret.
      return fetch('https://ekinmytmudjwfaqaqswp.supabase.co/functions/v1/admin-generate-legal-docx', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'sb_publishable_q5JwjFnMT_0Uhu5rAlAkQA_DEGnhwV7',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ productId: p.dbId })
      });
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (data) {
        throw new Error(data.error || 'Could not generate document.');
      });
      return res.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = p.id + '-legal-record.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      logAudit('Downloaded legal record for "' + p.title + '"');
    }).catch(function (err) {
      alert(err.message || 'Could not generate document.');
    }).then(function () {
      legalDownloadBtn.disabled = false;
      if (btnSpinner) btnSpinner.hidden = true;
    });
  });

  /* ================================================================
     PRODUCT UPDATE PANEL (version/changelog/file pushes)
     ================================================================ */
  var updSelectedId = null, updPendingPath = null, updPendingTech = null, updDescOriginal = '';

  function openUpdatePanel() {
    updSelectedId = null; updPendingPath = null; updPendingTech = null;
    var search = $('admUpdSearch'); if (search) search.value = '';
    if ($('admUpdSearchField')) $('admUpdSearchField').hidden = false;
    $('admUpdResults').innerHTML = '';
    $('admUpdSelected').hidden = true;
    showPanel('product-update', { extra: 'update' });
  }
  var openUpdateBtn = $('admOpenUpdatePanel');
  if (openUpdateBtn) openUpdateBtn.addEventListener('click', openUpdatePanel);

  function renderUpdResults() {
    var q = ($('admUpdSearch').value || '').trim().toLowerCase();
    var results = $('admUpdResults');
    if (!q) { results.innerHTML = ''; return; }
    var matches = allProducts().filter(function (p) { return p.title.toLowerCase().indexOf(q) >= 0; }).slice(0, 8);
    results.innerHTML = matches.map(function (p) {
      return '<button type="button" class="adm-upd-result" data-id="' + esc(p.id) + '">' +
        '<span class="dr-thumb" style="width:36px;height:26px;border-radius:6px;flex:0 0 auto;background-image:url(\'' + p.image + '\')"></span>' +
        '<span>' + esc(p.title) + '</span></button>';
    }).join('') || '<p class="adm-empty" style="padding:8px 0;">No products match.</p>';
  }
  var updSearchInput = $('admUpdSearch');
  if (updSearchInput) updSearchInput.addEventListener('input', renderUpdResults);

  function renderUpdHistory(p) {
    var box = $('admUpdHistory'); if (!box) return;
    var versions = (p.versions || []).slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    box.innerHTML = '<div class="dash-card-head"><h2>Version history</h2></div>' + (versions.map(function (v) {
      return '<div class="adm-ver-item"><span class="adm-ver-num">' + esc(v.version) + '</span>' +
        '<span class="adm-ver-date">' + fmtDate(new Date(v.date)) + '</span>' +
        '<span class="adm-ver-note">' + esc(v.changelog) + '</span></div>';
    }).join('') || '<p class="adm-empty">No versions pushed yet.</p>');
  }

  // "Updated on" tick boxes: one per marketplace the product is already
  // listed on. Ticked = already updated there; unticked becomes a task.
  function renderUpdMpChecks(p) {
    var box = $('admUpdMpChecks'); if (!box) return;
    box.innerHTML = '<span class="adm-mp-lead">Updated on</span>' + MARKETPLACES.map(function (m) {
      return '<label class="adm-mp-check mk-' + m.key + '"><input type="checkbox" data-mp="' + m.key + '" />' + mpLogo(m.key) + '<span>' + esc(m.label) + '</span></label>';
    }).join('');
  }

  function updSilent() { return !!($('admUpdSilent') && $('admUpdSilent').checked); }
  function applyUpdSilentUI() {
    var silent = updSilent();
    $('admUpdVersionGrid').hidden = silent;
    $('admUpdDescField').hidden = silent;
    $('admUpdSubmit').textContent = silent ? 'Replace file' : 'Push update';
  }
  var updSilentBox = $('admUpdSilent');
  if (updSilentBox) updSilentBox.addEventListener('change', applyUpdSilentUI);

  function selectUpdateProduct(id) {
    var p = findProduct(id); if (!p) return;
    updSelectedId = id; updPendingPath = null; updPendingTech = null;
    $('admUpdThumb').style.backgroundImage = "url('" + p.image + "')";
    $('admUpdSelectedName').textContent = p.title;
    $('admUpdVersion').value = '';
    $('admUpdChangelog').value = '';
    $('admUpdSilent').checked = false;
    applyUpdSilentUI();
    updDescOriginal = p.longDesc || '';
    $('admUpdDescInput').value = updDescOriginal;
    FILE_REMOVED.upd = false;
    setFileNote($('admUpdFileNote'), p.storagePath);
    autoGrow($('admUpdDescInput'));
    $('admUpdMsg').textContent = '';
    $('admUpdResults').innerHTML = '';
    $('admUpdSearch').value = '';
    // The selected card already names the product, so the search box goes away
    // until "Change product" is used.
    if ($('admUpdSearchField')) $('admUpdSearchField').hidden = true;
    $('admUpdSelected').hidden = false;
    renderUpdHistory(p);
    renderUpdMpChecks(p);
  }
  var updResults = $('admUpdResults');
  if (updResults) updResults.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-upd-result'); if (!btn) return;
    selectUpdateProduct(btn.getAttribute('data-id'));
  });
  var updChangeBtn = $('admUpdChange');
  if (updChangeBtn) updChangeBtn.addEventListener('click', openUpdatePanel);

  wireDropzone($('admUpdFileDrop'), $('admUpdFileInput'), function (files) {
    var f = files[0]; if (!f || !updSelectedId) return;
    var note = $('admUpdFileNote');
    FILE_REMOVED.upd = false;
    fileNoteMsg(note, 'Uploading ' + f.name + '…');
    uploadToStorage('productFile', f, updSelectedId).then(function (r) {
      var dot = f.name.lastIndexOf('.');
      updPendingPath = r.path;
      updPendingTech = { format: dot >= 0 ? f.name.slice(dot).toLowerCase() : '', size: formatFileSize(f.size), fileName: f.name };
      setFileNote(note, null, f.name);
    }).catch(function (err) {
      updPendingPath = null; updPendingTech = null;
      fileNoteMsg(note, 'Upload failed: ' + (err.message || 'try again') + '.', true);
    });
  });

  var updSubmitBtn = $('admUpdSubmit');
  if (updSubmitBtn) updSubmitBtn.addEventListener('click', function () {
    if (!can('admin')) return;
    if (!updSelectedId) return;
    var p = findProduct(updSelectedId); if (!p) return;
    var msg = $('admUpdMsg');
    var silent = updSilent();
    var overrides = {};
    var label;

    if (silent) {
      if (!updPendingPath) { if (msg) msg.textContent = 'Upload the new file first.'; return; }
      label = 'Silent update';
    } else {
      var version = $('admUpdVersion').value.trim();
      var changelog = $('admUpdChangelog').value.trim();
      if (!version || !changelog) { if (msg) msg.textContent = 'Enter a version number and changelog.'; return; }
      var versions = (p.versions || []).slice();
      versions.push({ version: version, changelog: changelog, date: new Date().toISOString() });
      overrides.versions = versions;
      var newDesc = $('admUpdDescInput').value.trim();
      if (newDesc !== updDescOriginal.trim()) overrides.longDesc = newDesc;
      label = 'Update ' + version;
    }
    if (updPendingPath) {
      overrides.storagePath = updPendingPath;
      overrides.tech = Object.assign({}, p.tech || {}, updPendingTech || {});
    }
    var ticks = {};
    Array.prototype.forEach.call(document.querySelectorAll('#admUpdMpChecks input[data-mp]'), function (el) { ticks[el.getAttribute('data-mp')] = el.checked; });

    updSubmitBtn.disabled = true;
    if (msg) msg.textContent = 'Pushing…';
    var dbId = p.dbId;
    callUpsertProduct(upsertPayloadFor(p, overrides)).then(function () {
      logAudit((silent ? 'Silent file update' : 'Pushed update ' + $('admUpdVersion').value.trim()) + ' for "' + p.title + '"');
      // Every marketplace it is already live on either gets the tick (done) or
      // becomes an "Update on X" task.
      // Ticked = it is up to date there (so it counts as live). Unticked on a
      // marketplace it is already on = it now needs updating. Unticked where it
      // was never uploaded stays "not uploaded".
      var rows = [];
      MARKETPLACES.forEach(function (m) {
        if (ticks[m.key]) rows.push({ key: m.key, status: 'live' });
        else if (mpStatus(dbId, m.key) !== 'pending') rows.push({ key: m.key, status: 'needs_update' });
      });
      mpSaveListings(dbId, rows);
      return refreshProducts();
    }).then(function () {
      updSubmitBtn.disabled = false;
      if (msg) msg.textContent = silent ? 'File replaced.' : 'Update pushed.';
      admToast(label + ' saved', true);
      $('admUpdVersion').value = '';
      $('admUpdChangelog').value = '';
      updPendingPath = null; updPendingTech = null;
      var fresh = findProduct(updSelectedId);
      FILE_REMOVED.upd = false;
      if (fresh) { updDescOriginal = fresh.longDesc || ''; setFileNote($('admUpdFileNote'), fresh.storagePath); autoGrow($('admUpdDescInput')); renderUpdHistory(fresh); renderUpdMpChecks(fresh); }
    }).catch(function (err) {
      updSubmitBtn.disabled = false;
      if (msg) msg.textContent = err.message || 'Could not push update.';
      admToast(err.message || 'Could not push update', false);
    });
  });

  /* ---- description boxes: grow with their text, and a bullets button ---- */
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  }
  function autoGrowAll() { autoGrow($('admEditLongDesc')); autoGrow($('admUpdDescInput')); }
  ['admEditLongDesc', 'admUpdDescInput'].forEach(function (id) {
    var ta = $(id); if (ta) ta.addEventListener('input', function () { autoGrow(ta); });
  });
  window.addEventListener('resize', autoGrowAll);
  // Bullets use the "- " marker, which is what the product page turns into a
  // bullet list (same as the Aura VFX Asset Pack description).
  function toggleBullets(ta) {
    if (!ta) return;
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var start = v.lastIndexOf('\n', s - 1) + 1;
    var end = v.indexOf('\n', e); if (end < 0) end = v.length;
    if (e > s && v.charAt(e - 1) === '\n') end = e - 1;
    var lines = v.slice(start, end).split('\n');
    var isBullet = /^\s*[-*•]\s+/;
    var filled = lines.filter(function (l) { return l.trim(); });
    var allBullets = filled.length > 0 && filled.every(function (l) { return isBullet.test(l); });
    var out = lines.map(function (l) {
      if (!l.trim()) return l;
      if (allBullets) return l.replace(/^(\s*)[-*•]\s+/, '$1');
      return isBullet.test(l) ? l.replace(/^(\s*)[*•]\s+/, '$1- ') : '- ' + l.trim();
    }).join('\n');
    ta.value = v.slice(0, start) + out + v.slice(end);
    ta.focus();
    ta.setSelectionRange(start, start + out.length);
    autoGrow(ta);
  }
  var bulletsBtn = $('admEditBullets'); if (bulletsBtn) bulletsBtn.addEventListener('click', function () { toggleBullets($('admEditLongDesc')); });
  var updBulletsBtn = $('admUpdBullets'); if (updBulletsBtn) updBulletsBtn.addEventListener('click', function () { toggleBullets($('admUpdDescInput')); });

  /* ---- product file card: download / remove ---- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fc]'); if (!b) return;
    var scope = b.getAttribute('data-scope');
    var p = scope === 'upd' ? findProduct(updSelectedId) : findProduct($('admEditId').value);
    if (b.getAttribute('data-fc') === 'download') {
      if (!p) return;
      var label = b.textContent; b.disabled = true; b.textContent = 'Opening…';
      invokeAdminFn('admin-get-download-url', { productId: p.dbId }, 'Could not open the product file.').then(function (d) {
        b.disabled = false; b.textContent = label; window.open(d.url, '_blank', 'noopener');
      }).catch(function (err) { b.disabled = false; b.textContent = label; admToast(err.message || 'Could not open the file.', false); });
      return;
    }
    // remove
    if (scope === 'upd') {
      if (updPendingPath) { updPendingPath = null; updPendingTech = null; FILE_REMOVED.upd = false; setFileNote($('admUpdFileNote'), p && p.storagePath); return; }
      if (!window.confirm('Remove the product file? Customers cannot download until a new one is uploaded.')) return;
      updPendingPath = PLACEHOLDER_PATH; updPendingTech = {}; FILE_REMOVED.upd = true;
      setFileNote($('admUpdFileNote'), PLACEHOLDER_PATH); admToast('File removed. Saves when you push.', true);
    } else {
      if (pendingStoragePath && pendingStoragePath !== PLACEHOLDER_PATH) { pendingStoragePath = null; FILE_REMOVED.edit = false; setFileNote($('admEditFileNote'), p && p.storagePath); return; }
      if (!window.confirm('Remove the product file? Customers cannot download until a new one is uploaded.')) return;
      pendingStoragePath = PLACEHOLDER_PATH; FILE_REMOVED.edit = true;
      setFileNote($('admEditFileNote'), PLACEHOLDER_PATH); admToast('File removed. Saves with the product.', true);
    }
  });

  /* ================================================================
     MARKETPLACES (BuiltByBit, ClearlyDev, Parcel, Creator Store)
     A missing listing row means "not uploaded yet". See supabase/marketplaces.sql.
     ================================================================ */
  var MARKETPLACES = [
    { key: 'builtbybit', label: 'BuiltByBit' },
    { key: 'clearlydev', label: 'ClearlyDev' },
    { key: 'parcel', label: 'Parcel' },
    { key: 'creatorstore', label: 'Creator Store' }
  ];
  var MP_LISTINGS = {};   // product db id -> { marketplace key -> status }
  var MP_TASKS = [];      // custom per-product tasks (open and done)
  var MP_FILTER = 'all';
  // Real marketplace logos (web-sized copies in /mp-logos; Creator Store uses
  // the same Roblox mark as the homepage hero).
  function mpLogo(key) { return '<img class="adm-mp-logo" src="/mp-logos/' + key + '.png" alt="" width="22" height="22" loading="lazy" />'; }
  function mpLabel(key) { var m = MARKETPLACES.filter(function (x) { return x.key === key; })[0]; return m ? m.label : key; }
  function mpStatus(dbId, key) { var l = MP_LISTINGS[dbId]; return (l && l[key]) || 'pending'; }

  function refreshMarketplaces() {
    if (!window.coldSupabase) return Promise.resolve();
    return Promise.all([
      window.coldSupabase.from('marketplace_listings').select('product_id, marketplace, status').limit(5000),
      window.coldSupabase.from('marketplace_tasks').select('id, product_id, marketplace, title, done, created_at').order('created_at', { ascending: false }).limit(5000)
    ]).then(function (r) {
      if (r[0].error || r[1].error) { console.error('[admin] marketplaces:', (r[0].error || r[1].error).message); return; }
      MP_LISTINGS = {};
      (r[0].data || []).forEach(function (row) { (MP_LISTINGS[row.product_id] = MP_LISTINGS[row.product_id] || {})[row.marketplace] = row.status; });
      MP_TASKS = r[1].data || [];
      if (curPanel === 'marketplaces') renderMarketplaces();
      if (curPanel === 'home') renderHome();
    });
  }

  // Upsert listing rows for one product: rows = [{ key, status }].
  function mpSaveListings(dbId, rows) {
    if (!dbId || !rows || !rows.length || !window.coldSupabase) return Promise.resolve();
    var now = new Date().toISOString();
    var payload = rows.map(function (r) {
      return { product_id: dbId, marketplace: r.key, status: r.status, synced_at: r.status === 'live' ? now : null, updated_at: now };
    });
    return window.coldSupabase.from('marketplace_listings').upsert(payload, { onConflict: 'product_id,marketplace' }).then(function (res) {
      if (res.error) { console.error('[admin] could not save marketplace listings:', res.error.message); admToast('Could not save the marketplace ticks', false); return; }
      rows.forEach(function (r) { (MP_LISTINGS[dbId] = MP_LISTINGS[dbId] || {})[r.key] = r.status; });
      if (curPanel === 'marketplaces') renderMarketplaces();
      if (curPanel === 'home') renderHome();
    });
  }

  function mpReadUploadChecks() {
    var out = {};
    Array.prototype.forEach.call(document.querySelectorAll('#admMpUploadChecks input[data-mp]'), function (el) { out[el.getAttribute('data-mp')] = el.checked; });
    return out;
  }
  function mpResetUploadChecks() {
    Array.prototype.forEach.call(document.querySelectorAll('#admMpUploadChecks input[data-mp]'), function (el) { el.checked = false; });
    if ($('admMpUploadCard')) $('admMpUploadCard').hidden = false;
  }

  // Everything still to do: not uploaded, out of date, or a custom task.
  // Private products are not listed anywhere yet, so they raise nothing.
  function mpOpenItems() {
    var items = [];
    var prods = allProducts();
    prods.forEach(function (p) {
      if (!p.visible) return;
      MARKETPLACES.forEach(function (m) {
        var st = mpStatus(p.dbId, m.key);
        if (st === 'pending') items.push({ kind: 'upload', product: p, mk: m.key, text: 'Upload to ' + m.label });
        else if (st === 'needs_update') items.push({ kind: 'update', product: p, mk: m.key, text: 'Update on ' + m.label });
      });
    });
    MP_TASKS.forEach(function (t) {
      if (t.done) return;
      var p = prods.filter(function (x) { return x.dbId === t.product_id; })[0];
      if (p) items.push({ kind: 'task', product: p, mk: t.marketplace, text: t.title, taskId: t.id });
    });
    return items;
  }
  function mpTodoLines() {
    var items = mpOpenItems();
    return MARKETPLACES.map(function (m) {
      var n = items.filter(function (i) { return i.mk === m.key; }).length;
      return n ? { text: n + ' thing' + (n === 1 ? '' : 's') + ' to do on ' + m.label, panel: 'marketplaces', badge: 'warn' } : null;
    }).filter(Boolean);
  }

  /* ================================================================
     BUILTBYBIT STATS
     Filled by the admin-builtbybit-sync edge function into bbb_purchases,
     bbb_reviews and bbb_resource_snapshots (supabase/builtbybit.sql); the panels
     read those tables directly. configured: null = not known yet, false = no
     BUILTBYBIT_API_TOKEN secret, true = connected.
     The account has hundreds of listings, so a sync is resumable: the function
     returns how many are `remaining` and this keeps calling until it reaches 0.
     ================================================================ */
  var BBB = { configured: null, purchases: [], reviews: [], snaps: [], dismissed: {}, syncing: false, progress: '', error: '', syncedAt: null };
  var BBB_RANGE = lsGet('coldd_admin_bbb_range_v1', 30);
  var BBB_SYNC_KEY = 'coldd_admin_bbb_sync_at_v1';

  function bbbIsUsd(p) { return String(p.currency || 'USD').toUpperCase() === 'USD'; }
  // Refunded / reversed purchases are not revenue.
  function bbbCounts(p) { return !/refund|revers|cancel|charge|dispute|void|fail/.test(String(p.status || '').toLowerCase()); }
  function bbbPurchasesIn(start, end) {
    return BBB.purchases.filter(function (p) {
      if (!bbbCounts(p)) return false;
      var t = new Date(p.purchased_at);
      return (!start || t >= start) && (!end || t < end);
    });
  }
  function bbbSum(list) {
    var usdTotal = 0, other = 0, pending = 0;
    list.forEach(function (p) {
      if (bbbIsUsd(p)) {
        usdTotal += Number(p.price) || 0;
        if (String(p.status).toLowerCase() === 'pending') pending += Number(p.price) || 0;
      } else other += 1;
    });
    return { usd: usdTotal, orders: list.length, other: other, pending: pending };
  }
  // Totals for the dashboard / analytics range and the window before it.
  function bbbRangeTotals() {
    var now = new Date(Date.now() + 1000);
    var cur = bbbSum(bbbPurchasesIn(RANGE_DAYS ? rangeStart() : null, now));
    var prev = { usd: 0, orders: 0 };
    if (RANGE_DAYS) { var w = prevRangeWindow(); prev = bbbSum(bbbPurchasesIn(w.start, w.end)); }
    return { cur: cur, prev: prev };
  }
  function bbbOffline() { return BBB.configured === null ? 'loading…' : 'not connected'; }
  function bbbRevTile() {
    if (!BBB.configured) return statTile('BuiltByBit revenue', '–', bbbOffline(), '', { panel: 'marketplaces' });
    var t = bbbRangeTotals();
    return statTile('BuiltByBit revenue', aud(t.cur.usd), usd(t.cur.usd) + ' USD', pctDelta(t.cur.usd, t.prev.usd), { panel: 'marketplaces' });
  }
  function bbbOrdersTile() {
    if (!BBB.configured) return statTile('BuiltByBit orders', '–', bbbOffline(), '', { panel: 'marketplaces' });
    var t = bbbRangeTotals();
    return statTile('BuiltByBit orders', num(t.cur.orders), null, pctDelta(t.cur.orders, t.prev.orders), { panel: 'marketplaces' });
  }

  function bbbNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function bbbVer(s) { return String(s || '').toLowerCase().replace(/^v/, '').trim(); }
  // Latest saved listing row per BuiltByBit resource, and the site product it matches by title.
  function bbbListingByTitle() {
    var by = {};
    BBB.snaps.forEach(function (s) { var k = bbbNorm(s.title); if (k && !by[k]) by[k] = s; });
    return by;
  }
  function bbbSnapById() {
    var by = {};
    BBB.snaps.forEach(function (s) { by[s.resource_id] = s; });
    return by;
  }
  // Which site category a BuiltByBit listing belongs to: its matched coldd product's
  // category when there is one, otherwise BuiltByBit's own category name.
  function bbbCategoryOf(resourceId, title) {
    var prods = allProducts(), k = bbbNorm(title);
    var site = prods.filter(function (p) { return bbbNorm(p.title) === k; })[0];
    if (site && site.cat) return site.cat;
    var snap = bbbSnapById()[resourceId];
    var cat = snap && snap.category;
    if (!cat) return 'Other';
    var ck = bbbNorm(cat);
    var cats = {}; prods.forEach(function (p) { if (p.cat) cats[bbbNorm(p.cat)] = p.cat; });
    return cats[ck] || cat;
  }

  // BuiltByBit's contribution to the Analytics "Best sellers" list, in the active range.
  function bbbBestSellers(start, end) {
    var by = {};
    bbbPurchasesIn(start, end).forEach(function (p) {
      var e = by[p.resource_id] = by[p.resource_id] || { id: p.resource_id, title: p.resource_title || p.resource_id, units: 0, revenue: 0 };
      e.units += 1;
      if (bbbIsUsd(p)) e.revenue += Number(p.price) || 0;
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  // BuiltByBit revenue by site category for a window: { category label -> USD }.
  function bbbCategoryRevenue(start, end) {
    var map = {};
    bbbBestSellers(start, end).forEach(function (e) {
      var c = bbbCategoryOf(e.id, e.title);
      map[c] = (map[c] || 0) + e.revenue;
    });
    return map;
  }

  function bbbRenderAll() {
    if (curPanel === 'marketplaces') renderMarketplaces();
    if (curPanel === 'home') renderHome();
    if (curPanel === 'analytics') renderAnalytics();
  }
  // PostgREST returns at most 1000 rows per request, so read big tables in pages.
  function bbbPaged(build) {
    var all = [];
    function page(from) {
      return build().range(from, from + 999).then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        all = all.concat(rows);
        return rows.length === 1000 && all.length < 100000 ? page(from + 1000) : all;
      });
    }
    return page(0);
  }
  function refreshBbbData() {
    if (!window.coldSupabase) return Promise.resolve();
    var sb = window.coldSupabase;
    return Promise.all([
      bbbPaged(function () { return sb.from('bbb_purchases').select('purchase_id, resource_id, resource_title, price, currency, status, renewal, purchased_at').order('purchased_at', { ascending: false }).order('purchase_id'); }),
      sb.from('bbb_reviews').select('review_id, resource_id, resource_title, rating, message, response, reviewed_at').order('reviewed_at', { ascending: false }).limit(200),
      bbbPaged(function () { return sb.from('bbb_resource_snapshots').select('resource_id, snapshot_date, title, price, currency, downloads, purchases, reviews, rating, latest_version, category, synced_at').order('snapshot_date', { ascending: false }).order('resource_id'); }),
      sb.from('bbb_issue_dismissals').select('issue_key')
    ]).then(function (r) {
      if (r[1].error) throw r[1].error;
      BBB.purchases = r[0];
      BBB.reviews = r[1].data || [];
      // Keep only the newest day's listing rows.
      var snaps = r[2], newest = snaps.length ? snaps[0].snapshot_date : null;
      BBB.snaps = snaps.filter(function (s) { return s.snapshot_date === newest; });
      BBB.snaps.forEach(function (s) { if (s.synced_at && (!BBB.syncedAt || s.synced_at > BBB.syncedAt)) BBB.syncedAt = s.synced_at; });
      BBB.dismissed = {};
      ((r[3] && r[3].data) || []).forEach(function (d) { BBB.dismissed[d.issue_key] = true; });
      if (BBB.configured !== false && (BBB.purchases.length || BBB.snaps.length)) BBB.configured = true;
      bbbRenderAll();
    }).catch(function (err) { console.error('[admin] builtbybit tables:', err && err.message); });
  }

  // Pulls fresh data from BuiltByBit. The function does a slice at a time and reports
  // how many listings are still `remaining`; keep going until it is done. Throttled to
  // every 10 minutes once a full pass has finished, unless forced.
  function bbbSync(force) {
    if (BBB.syncing) return Promise.resolve();
    var last = Number(lsGet(BBB_SYNC_KEY, 0)) || 0;
    if (!force && Date.now() - last < 10 * 60 * 1000) return Promise.resolve();
    BBB.syncing = true; BBB.error = ''; BBB.progress = 'Starting…';
    if (curPanel === 'marketplaces') renderBbb();
    var rounds = 0;
    function step(cont) {
      var timeout = new Promise(function (_, reject) { setTimeout(function () { reject(new Error('BuiltByBit took too long to answer. Try Sync now again in a minute.')); }, 140000); });
      return Promise.race([invokeAdminFn('admin-builtbybit-sync', { action: 'sync', 'continue': !!cont }, 'Could not sync BuiltByBit.'), timeout]).then(function (d) {
        rounds++;
        BBB.configured = d.configured === false ? false : true;
        if (d.configured === false) return d;
        BBB.syncedAt = d.syncedAt || new Date().toISOString();
        if (d.errors && d.errors.length) BBB.error = 'Some data could not be read: ' + d.errors[0];
        BBB.progress = d.remaining ? 'Reading listings, ' + d.remaining + ' left…' : '';
        return refreshBbbData().then(function () {
          if (d.remaining > 0 && d.processed > 0 && rounds < 40) return step(true);
          if (!d.remaining) lsSet(BBB_SYNC_KEY, Date.now());
          return d;
        });
      });
    }
    return step(false).catch(function (err) {
      BBB.error = err.message || 'Could not sync BuiltByBit.';
    }).then(function () {
      BBB.syncing = false; BBB.progress = '';
      return refreshBbbData();
    }).then(function () { if (curPanel === 'marketplaces') renderBbb(); });
  }
  // The server syncs BuiltByBit on its own every 15 minutes (pg_cron -> admin-builtbybit-sync),
  // spaced to stay inside BuiltByBit's rate limits. The browser only re-reads our tables; a
  // forced sync is still available from the Sync now button.
  function refreshBbb() { return refreshBbbData(); }
  setInterval(function () {
    if (document.hidden || (curPanel !== 'marketplaces' && curPanel !== 'home' && curPanel !== 'analytics')) return;
    refreshBbbData();
  }, 5 * 60 * 1000);

  function bbbStars(n) {
    var r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '<span class="adm-bbb-stars" aria-label="' + r + ' of 5">' + '★★★★★'.slice(0, r) + '<i>' + '★★★★★'.slice(r) + '</i></span>';
  }

  // Trend chart: each line is the real daily figure (faint) with a moving average on top
  // (bold, area-filled), so a handful of sales reads as a direction, not a row of spikes.
  // lines: [{ name, color, data: [{ label, v, tip }], avg: days }]
  function svgTrend(lines, opts) {
    opts = opts || {};
    var w = 640, h = opts.height || 150, fmt = opts.fmt || axisNum;
    var n = lines[0].data.length;
    if (n < 2) return svgBars(lines[0].data, opts);
    function avgOf(data, k) {
      return data.map(function (d, i) {
        var from = Math.max(0, i - k + 1), s = 0;
        for (var j = from; j <= i; j++) s += data[j].v;
        return s / (i - from + 1);
      });
    }
    var series = lines.map(function (l) {
      var k = l.avg || Math.max(3, Math.round(n / 12));
      return { l: l, avg: avgOf(l.data, k), k: k };
    });
    var rawMax = 0;
    series.forEach(function (s) { s.avg.forEach(function (v) { if (v > rawMax) rawMax = v; }); s.l.data.forEach(function (d) { if (d.v > rawMax) rawMax = d.v; }); });
    var sc = niceScale(rawMax);
    function X(i) { return (i / (n - 1)) * w; }
    function Y(v) { return h - (v / sc.top) * h; }
    var grid = sc.ticks.map(function (t) {
      return '<line class="adm-chart-grid" x1="0" x2="' + w + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '" vector-effect="non-scaling-stroke"></line>';
    }).join('');
    var paths = series.map(function (s, idx) {
      var color = s.l.color || 'var(--accent)';
      var raw = s.l.data.map(function (d, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(d.v).toFixed(1); }).join('');
      var avg = s.avg.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join('');
      var area = avg + 'L' + w + ' ' + h + 'L0 ' + h + 'Z';
      return (idx === 0 ? '<path d="' + area + '" fill="' + color + '" opacity=".14"></path>' : '') +
        '<path d="' + raw + '" fill="none" stroke="' + color + '" stroke-width="1" opacity=".35" vector-effect="non-scaling-stroke"></path>' +
        '<path d="' + avg + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>';
    }).join('');
    var colW = w / n;
    var hover = lines[0].data.map(function (d, i) {
      var tip = esc(d.label) + series.map(function (s) { return ' · ' + (series.length > 1 ? esc(s.l.name) + ' ' : '') + esc(s.l.data[i].tip != null ? s.l.data[i].tip : s.l.data[i].v); }).join('');
      return '<rect x="' + (X(i) - colW / 2).toFixed(1) + '" y="0" width="' + colW.toFixed(1) + '" height="' + h + '" fill="transparent"><title>' + tip + '</title></rect>';
    }).join('');
    var labels = sc.ticks.map(function (t) { return esc(fmt(t)); });
    var axisW = Math.max.apply(null, labels.map(function (l) { return l.length; })) + 1;
    var axis = sc.ticks.map(function (t, i) { return '<span style="bottom:' + (t / sc.top * 100).toFixed(2) + '%">' + labels[i] + '</span>'; }).join('');
    var xl = '<div class="adm-chart-x"><span>' + esc(lines[0].data[0].label) + '</span><span>' + esc(lines[0].data[n - 1].label) + '</span></div>';
    var legend = '<div class="adm-trend-legend">' + series.map(function (s) {
      return '<span><i style="background:' + (s.l.color || 'var(--accent)') + '"></i>' + esc(s.l.name || 'Revenue') + ' <em>' + s.k + '-day average</em></span>';
    }).join('') + '</div>';
    return '<div class="adm-chart-wrap"><div class="adm-chart-axis" style="height:' + h + 'px;min-width:' + axisW + 'ch">' + axis + '</div>' +
      '<div class="adm-chart-main"><svg viewBox="0 0 ' + w + ' ' + h + '" class="adm-chart" style="height:' + h + 'px" preserveAspectRatio="none">' + grid + paths + hover + '</svg>' + xl + '</div></div>' + legend;
  }
  // Sales performance chart in the style of BuiltByBit's own dashboard: total revenue (left
  // axis, USD) and total purchases (right axis) as two lines with a point per bucket.
  // The timeframe buttons (7D / 30D / 90D / All) drive it; the bucket size follows the
  // timeframe so the lines stay readable: daily up to 120 days, weekly up to ~13 months,
  // monthly beyond that.
  function bbbDayIndex(date, todayStart) {
    var d = new Date(date); d.setHours(0, 0, 0, 0);
    return Math.round((todayStart.getTime() - d.getTime()) / 86400000);
  }
  function bbbBuckets(range) {
    var list = bbbPurchasesIn(null, null);
    var todayStart = daysAgoStart(1);
    var oldest = 0;
    list.forEach(function (p) { var i = bbbDayIndex(p.purchased_at, todayStart); if (i > oldest) oldest = i; });
    var days = Math.min(range || (oldest + 1), 1500);
    var unit = days <= 120 ? 'day' : days <= 400 ? 'week' : 'month';
    var buckets = [], key;
    if (unit === 'day') {
      for (var i = days - 1; i >= 0; i--) { var d = daysAgo(i); buckets.push({ at: d, rev: 0, n: 0, idx: i }); }
      key = function (di) { return di; };
    } else if (unit === 'week') {
      var nw = Math.ceil(days / 7);
      for (var k = nw - 1; k >= 0; k--) buckets.push({ at: daysAgo(k * 7 + 6), end: daysAgo(k * 7), rev: 0, n: 0, idx: k });
      key = function (di) { return Math.floor(di / 7); };
    } else {
      var first = daysAgo(Math.min(oldest, days - 1)), cur = new Date(first.getFullYear(), first.getMonth(), 1), stop = new Date();
      while (cur <= stop) { buckets.push({ at: new Date(cur), month: cur.getFullYear() * 12 + cur.getMonth(), rev: 0, n: 0 }); cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); }
    }
    var byIdx = {};
    buckets.forEach(function (b) { byIdx[unit === 'month' ? b.month : b.idx] = b; });
    list.forEach(function (p) {
      var t = new Date(p.purchased_at), di = bbbDayIndex(t, todayStart);
      if (range && di >= days) return;
      var b = byIdx[unit === 'month' ? t.getFullYear() * 12 + t.getMonth() : key(di)];
      if (!b) return;
      b.n += 1;
      if (bbbIsUsd(p)) b.rev += Number(p.price) || 0;
    });
    buckets.forEach(function (b) { b.rev = Math.round(b.rev * 100) / 100; });
    return { unit: unit, buckets: buckets };
  }
  // Whole-number axis for the purchases count (never 0.25-style steps).
  function bbbCountScale(max) {
    var m = Math.max(4, Math.ceil(max)), step = Math.ceil(m / 4), top = step * 4, ticks = [];
    for (var t = 0; t <= top; t += step) ticks.push(t);
    return { top: top, ticks: ticks };
  }
  function bbbChart(range) {
    var res = bbbBuckets(range), bk = res.buckets, n = bk.length;
    var unitLabel = res.unit === 'day' ? 'Daily' : res.unit === 'week' ? 'Weekly' : 'Monthly';
    function lbl(b) {
      if (res.unit === 'month') return b.at.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      return b.at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    function tipDate(b) {
      if (res.unit === 'week') return fmtDate(b.at) + ' to ' + fmtDate(b.end);
      if (res.unit === 'month') return b.at.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      return fmtDate(b.at);
    }
    var head = '<div class="bbb-chart-head"><span class="adm-mini-head" style="margin:0">Sales performance</span><span class="bbb-chart-unit">' + unitLabel + '</span></div>';
    if (n < 1) return head + '<p class="adm-empty">No sales in this timeframe.</p>';
    var W = 760, H = 270, L = 50, R = 40, T = 14, B = 30, iw = W - L - R, ih = H - T - B;
    var maxRev = 0, maxN = 0;
    bk.forEach(function (b) { if (b.rev > maxRev) maxRev = b.rev; if (b.n > maxN) maxN = b.n; });
    var sr = niceScale(maxRev), sn = bbbCountScale(maxN);
    function X(i) { return L + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); }
    function YR(v) { return T + ih - (v / sr.top) * ih; }
    function YN(v) { return T + ih - (v / sn.top) * ih; }
    var grid = sr.ticks.map(function (t) {
      return '<line class="adm-chart-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + YR(t).toFixed(1) + '" y2="' + YR(t).toFixed(1) + '"></line>' +
        '<text class="bbb-ax" x="' + (L - 8) + '" y="' + (YR(t) + 3.5).toFixed(1) + '" text-anchor="end">' + esc(axisUsd(t)) + '</text>';
    }).join('');
    var rightAx = sn.ticks.map(function (t) {
      return '<text class="bbb-ax bbb-ax-n" x="' + (W - R + 8) + '" y="' + (YN(t) + 3.5).toFixed(1) + '" text-anchor="start">' + t + '</text>';
    }).join('');
    var every = Math.max(1, Math.ceil(n / 8)), xl = '';
    for (var i = 0; i < n; i += every) xl += '<text class="bbb-ax" x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(lbl(bk[i])) + '</text>';
    function path(f) { return bk.map(function (b, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + f(b).toFixed(1); }).join(''); }
    var dots = n <= 62 ? 3.2 : 0;
    var revPts = '', ordPts = '';
    if (dots) bk.forEach(function (b, i) {
      revPts += '<circle class="bbb-dot bbb-rev" cx="' + X(i).toFixed(1) + '" cy="' + YR(b.rev).toFixed(1) + '" r="' + dots + '"></circle>';
      ordPts += '<circle class="bbb-dot bbb-ord" cx="' + X(i).toFixed(1) + '" cy="' + YN(b.n).toFixed(1) + '" r="' + dots + '"></circle>';
    });
    var colW = n === 1 ? iw : iw / (n - 1);
    var hits = bk.map(function (b, i) {
      return '<g class="bbb-hit"><rect x="' + (X(i) - colW / 2).toFixed(1) + '" y="' + T + '" width="' + colW.toFixed(1) + '" height="' + ih + '" fill="transparent"><title>' + esc(tipDate(b)) + ' · ' + esc(usd(b.rev)) + ' revenue · ' + b.n + (b.n === 1 ? ' purchase' : ' purchases') + '</title></rect>' +
        '<line class="bbb-hover-line" x1="' + X(i).toFixed(1) + '" x2="' + X(i).toFixed(1) + '" y1="' + T + '" y2="' + (T + ih) + '"></line>' +
        '<circle class="bbb-hover-dot bbb-rev" cx="' + X(i).toFixed(1) + '" cy="' + YR(b.rev).toFixed(1) + '" r="4.5"></circle>' +
        '<circle class="bbb-hover-dot bbb-ord" cx="' + X(i).toFixed(1) + '" cy="' + YN(b.n).toFixed(1) + '" r="4.5"></circle></g>';
    }).join('');
    var svg = '<svg class="bbb-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Sales performance chart">' + grid + rightAx + xl +
      '<path class="bbb-line bbb-rev" d="' + path(function (b) { return YR(b.rev); }) + '"></path>' +
      '<path class="bbb-line bbb-ord" d="' + path(function (b) { return YN(b.n); }) + '"></path>' + revPts + ordPts + hits + '</svg>';
    var legend = '<div class="bbb-legend"><span><i class="bbb-rev"></i>Total revenue</span><span><i class="bbb-ord"></i>Total purchases</span></div>';
    return head + '<div class="bbb-chart-wrap">' + svg + '</div>' + legend;
  }
  // Daily BuiltByBit revenue for the last n days (local days, like the site series).
  function bbbDailySeries(days) {
    var byDay = {};
    bbbPurchasesIn(null, null).forEach(function (p) {
      if (!bbbIsUsd(p)) return;
      var k = new Date(p.purchased_at).toDateString();
      byDay[k] = (byDay[k] || 0) + (Number(p.price) || 0);
    });
    var n = days;
    if (!n) {
      var first = BBB.purchases.length ? new Date(BBB.purchases[BBB.purchases.length - 1].purchased_at) : null;
      n = first ? Math.min(365, Math.max(7, Math.ceil((Date.now() - first.getTime()) / 86400000) + 1)) : 30;
    }
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = daysAgo(i), v = Math.round((byDay[d.toDateString()] || 0) * 100) / 100;
      out.push({ label: fmtDate(d), v: v, tip: usd(v) });
    }
    return out;
  }

  // Things worth a look: products on the site that are not on BuiltByBit, or that disagree
  // with their BuiltByBit listing. Each has a stable key so it can be dismissed.
  function bbbIssues() {
    var out = [];
    if (!BBB.snaps.length) return out;
    var byTitle = bbbListingByTitle();
    allProducts().forEach(function (p) {
      if (!p.visible) return;
      var l = byTitle[bbbNorm(p.title)];
      var mark = mpStatus(p.dbId, 'builtbybit');
      if (!l) {
        out.push({ key: 'missing:' + p.dbId, kind: 'missing', title: p.title,
          text: 'Not on BuiltByBit' + (mark === 'live' ? ' (your checklist says it is live)' : ''), pid: p.dbId });
        return;
      }
      var bp = l.price == null ? null : Number(l.price);
      if (bp != null && Math.abs(bp - p.priceNum) > 0.005) {
        out.push({ key: 'price:' + p.dbId + ':' + p.priceNum + ':' + bp, kind: 'price', title: p.title,
          text: 'Price differs: site ' + usd(p.priceNum) + ', BuiltByBit ' + usd(bp), pid: p.dbId });
      }
      if (l.latest_version && p.siteVersion && bbbVer(l.latest_version) !== bbbVer(p.siteVersion)) {
        out.push({ key: 'version:' + p.dbId + ':' + bbbVer(p.siteVersion) + ':' + bbbVer(l.latest_version), kind: 'version', title: p.title,
          text: 'Version differs: site v' + bbbVer(p.siteVersion) + ', BuiltByBit v' + bbbVer(l.latest_version), pid: p.dbId });
      }
      if (mark !== 'live' && mark !== 'needs_update') {
        out.push({ key: 'checklist:' + p.dbId, kind: 'checklist', title: p.title,
          text: 'On BuiltByBit, but your checklist says it is not uploaded', pid: p.dbId });
      }
    });
    return out;
  }

  var ADM_ICON_X = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>';

  function renderBbb() {
    var body = $('admBbbBody');
    if (!body) return;
    Array.prototype.forEach.call(document.querySelectorAll('#admBbbRange button'), function (b) { b.classList.toggle('active', +b.getAttribute('data-bbb-range') === BBB_RANGE); });
    var sync = $('admBbbSync'); if (sync) { sync.disabled = BBB.syncing; sync.textContent = BBB.syncing ? 'Syncing…' : 'Sync now'; }
    var sub = $('admBbbSub');
    if (sub) sub.textContent = !BBB.configured ? '' : BBB.syncing ? (BBB.progress || 'Syncing…') : (BBB.syncedAt ? 'Last synced ' + new Date(BBB.syncedAt).toLocaleString() + ' · updates itself every 15 minutes' : 'Sales as reported by BuiltByBit, in USD');

    if (BBB.configured === false) {
      body.innerHTML = '<p class="adm-empty">BuiltByBit is not connected yet. Create a <strong>Private</strong> token at builtbybit.com/account/api, then run <code>supabase secrets set BUILTBYBIT_API_TOKEN=your-token</code> and press Sync now.</p>' +
        (BBB.error ? '<div class="adm-edit-msg err">' + esc(BBB.error) + '</div>' : '');
      return;
    }
    if (BBB.configured === null) { body.innerHTML = '<p class="adm-empty">Loading…</p>'; return; }

    var start = BBB_RANGE ? daysAgoStart(BBB_RANGE) : null, now = new Date(Date.now() + 1000);
    var cur = bbbSum(bbbPurchasesIn(start, now));
    var prev = { usd: 0, orders: 0 };
    if (BBB_RANGE) prev = bbbSum(bbbPurchasesIn(daysAgoStart(BBB_RANGE * 2), daysAgoStart(BBB_RANGE)));
    function delta(c, p) { if (!BBB_RANGE) return ''; var s = RANGE_DAYS; RANGE_DAYS = BBB_RANGE; var h = pctDelta(c, p); RANGE_DAYS = s; return h; }

    var tiles = statGrid([
      statTile('Revenue', aud(cur.usd), usd(cur.usd) + ' USD', delta(cur.usd, prev.usd)),
      statTile('Orders', num(cur.orders), cur.other ? cur.other + ' in another currency, not counted in revenue' : null, delta(cur.orders, prev.orders)),
      statTile('Avg order value', cur.orders ? usd(cur.usd / cur.orders) : '–', null, '')
    ]);

    var chart = bbbChart(BBB_RANGE);

    // potential issues (expandable), each with a dismiss icon
    var issues = bbbIssues(), shown = issues.filter(function (i) { return !BBB.dismissed[i.key]; });
    var hidden = issues.length - shown.length;
    var list = shown.map(function (i) {
      var act = '';
      if (i.kind === 'version') act = '<button type="button" class="adm-mp-done" data-bbb-flag="' + esc(i.pid) + '">Flag needs update</button>';
      if (i.kind === 'checklist') act = '<button type="button" class="adm-mp-done" data-bbb-live="' + esc(i.pid) + '">Mark live</button>';
      return '<li class="adm-bbb-issue"><span class="dt-badge warn">' + esc(i.kind === 'missing' ? 'Missing' : i.kind === 'price' ? 'Price' : i.kind === 'version' ? 'Version' : 'Checklist') + '</span>' +
        '<span class="adm-bbb-issue-text"><strong>' + esc(i.title) + '</strong> <span class="adm-sub">' + esc(i.text) + '</span></span>' + act +
        '<button type="button" class="adm-mp-del" data-bbb-dismiss="' + esc(i.key) + '" title="Dismiss" aria-label="Dismiss this issue">' + ADM_ICON_X + '</button></li>';
    }).join('');
    var issuesHtml = '<details class="adm-collapse adm-bbb-issues"' + (shown.length && shown.length <= 6 ? '' : '') + '><summary class="adm-bbb-issues-sum"><span>Potential issues <strong>' + shown.length + '</strong>' + (hidden ? ' <span class="adm-sub">' + hidden + ' dismissed</span>' : '') +
      '</span><svg class="adm-collapse-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></summary>' +
      '<div class="adm-collapse-body">' + (list ? '<ul class="adm-bbb-issue-list">' + list + '</ul>' : '<p class="adm-empty">Nothing to fix. Every on-site product matches its BuiltByBit listing.</p>') +
      (hidden ? '<button type="button" class="btn btn-ghost adm-btn-sm" data-bbb-restore="1">Show dismissed</button>' : '') + '</div></details>';


    body.innerHTML = tiles + chart + issuesHtml + (BBB.error ? '<div class="adm-edit-msg err">' + esc(BBB.error) + '</div>' : '');
  }

  document.addEventListener('click', function (e) {
    var rb = e.target.closest('#admBbbRange button');
    if (rb) { BBB_RANGE = +rb.getAttribute('data-bbb-range'); lsSet('coldd_admin_bbb_range_v1', BBB_RANGE); renderBbb(); return; }
    if (e.target.closest('#admBbbSync')) { bbbSync(true); return; }
    var fl = e.target.closest('[data-bbb-flag]');
    if (fl) { fl.disabled = true; mpSaveListings(fl.getAttribute('data-bbb-flag'), [{ key: 'builtbybit', status: 'needs_update' }]).then(function () { admToast('Flagged for update on BuiltByBit', true); renderBbb(); }); return; }
    var lv = e.target.closest('[data-bbb-live]');
    if (lv) { lv.disabled = true; mpSaveListings(lv.getAttribute('data-bbb-live'), [{ key: 'builtbybit', status: 'live' }]).then(function () { admToast('Marked live on BuiltByBit', true); renderBbb(); }); return; }
    var ds = e.target.closest('[data-bbb-dismiss]');
    if (ds) {
      var key = ds.getAttribute('data-bbb-dismiss');
      BBB.dismissed[key] = true; renderBbb();
      Promise.resolve(window.coldSupabase.from('bbb_issue_dismissals').upsert({ issue_key: key }, { onConflict: 'issue_key' })).then(function (r) {
        if (r && r.error) { delete BBB.dismissed[key]; renderBbb(); admToast('Could not dismiss that', false); }
      });
      return;
    }
    if (e.target.closest('[data-bbb-restore]')) {
      Promise.resolve(window.coldSupabase.from('bbb_issue_dismissals').delete().neq('issue_key', '')).then(function (r) {
        if (r && r.error) { admToast('Could not restore', false); return; }
        BBB.dismissed = {}; renderBbb();
      });
    }
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest ? e.target.closest('.adm-bbb-replyform') : null;
    if (!f) return;
    e.preventDefault();
    var ta = f.querySelector('textarea'), btn = f.querySelector('button'), msg = ta.value.trim();
    if (msg.length < 2) { ta.focus(); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    invokeAdminFn('admin-builtbybit-sync', { action: 'reply_review', resourceId: f.getAttribute('data-rid'), reviewId: f.getAttribute('data-rv'), message: msg }, 'Could not send the reply.').then(function () {
      var rv = BBB.reviews.filter(function (r) { return String(r.review_id) === f.getAttribute('data-rv'); })[0];
      if (rv) rv.response = msg;
      admToast('Reply sent to BuiltByBit', true);
      renderBbb();
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Send reply';
      admToast(err.message || 'Could not send the reply', false);
    });
  });

  var mpProductDD = makeDropdown($('admMpProductDD'), { valueInput: $('admMpProduct'), placeholder: 'Product', searchable: true });
  var mpMarketDD = makeDropdown($('admMpMarketDD'), { valueInput: $('admMpMarket'), placeholder: 'Marketplace' });
  mpMarketDD.setOptions(MARKETPLACES.map(function (m) { return { value: m.key, label: m.label }; }), '');

  function renderMarketplaces() {
    if (!$('admMpTasks')) return;
    renderBbb();
    var prods = allProducts();
    mpProductDD.setOptions(prods.map(function (p) { return { value: p.dbId, label: p.title }; }), $('admMpProduct').value || '');

    var items = mpOpenItems();
    $('admMpStats').innerHTML = MARKETPLACES.map(function (m) {
      var n = items.filter(function (i) { return i.mk === m.key; }).length;
      return '<div class="dash-stat glass"><span class="ds-label adm-mp-statlabel">' + mpLogo(m.key) + esc(m.label) + '</span><span class="ds-num">' + n + '</span><span class="ds-sub">' + (n ? 'to do' : 'all caught up') + '</span></div>';
    }).join('');

    $('admMpFilter').innerHTML = [{ key: 'all', label: 'All' }].concat(MARKETPLACES).map(function (m) {
      return '<button type="button" class="' + (m.key === 'all' ? '' : 'mk-' + m.key) + (MP_FILTER === m.key ? ' active' : '') + '" data-mp="' + m.key + '">' + (m.key === 'all' ? '' : mpLogo(m.key)) + esc(m.label) + '</button>';
    }).join('');

    var shown = items.filter(function (i) { return MP_FILTER === 'all' || i.mk === MP_FILTER; });
    var groups = {}, order = [];
    shown.forEach(function (i) {
      if (!groups[i.product.dbId]) { groups[i.product.dbId] = { product: i.product, rows: [] }; order.push(i.product.dbId); }
      groups[i.product.dbId].rows.push(i);
    });
    order.sort(function (a, b) { return groups[a].product.title.localeCompare(groups[b].product.title); });
    $('admMpTasks').innerHTML = order.map(function (id) {
      var g = groups[id], p = g.product;
      return '<article class="adm-mp-card">' +
        '<header class="adm-mp-card-head"><span class="adm-mp-thumb" style="background-image:url(\'' + p.image + '\')"></span>' +
        '<div class="adm-mp-card-title"><strong>' + esc(p.title) + '</strong><span>' + g.rows.length + (g.rows.length === 1 ? ' task' : ' tasks') + '</span></div></header>' +
        '<ul class="adm-mp-list">' + g.rows.map(function (r) {
          var attrs = ' data-pid="' + esc(p.dbId) + '" data-mk="' + r.mk + '" data-kind="' + r.kind + '"' + (r.taskId ? ' data-task="' + esc(r.taskId) + '"' : '');
          var what = r.kind === 'upload' ? 'Upload' : r.kind === 'update' ? 'Update' : esc(r.text);
          var btn = r.kind === 'upload' ? 'Mark uploaded' : r.kind === 'update' ? 'Mark updated' : 'Done';
          return '<li class="adm-mp-item"><span class="adm-mp-tag mk-' + r.mk + '">' + mpLogo(r.mk) + esc(mpLabel(r.mk)) + '</span>' +
            '<span class="adm-mp-what">' + what + '</span>' +
            '<button type="button" class="adm-mp-done" data-act="done"' + attrs + '>' + btn + '</button>' +
            (r.kind === 'task' ? '<button type="button" class="adm-mp-del" data-act="delete"' + attrs + ' title="Delete task" aria-label="Delete task">' + ADM_ICON_TRASH + '</button>' : '') +
            '</li>';
        }).join('') + '</ul></article>';
    }).join('') || '<p class="adm-empty adm-mp-empty">Everything is up to date' + (MP_FILTER === 'all' ? ' on every marketplace.' : ' on ' + esc(mpLabel(MP_FILTER)) + '.') + '</p>';

    var mxBody = $('admMpMatrix');
    if (mxBody) mxBody.innerHTML = prods.map(function (p) {
      return '<tr><td>' + esc(p.title) + (p.visible ? '' : ' <span class="adm-sub">Private</span>') + '</td>' + MARKETPLACES.map(function (m) {
        var st = mpStatus(p.dbId, m.key);
        var cls = st === 'live' ? 'ok' : st === 'needs_update' ? 'warn' : '';
        var txt = st === 'live' ? 'Live' : st === 'needs_update' ? 'Needs update' : 'Not uploaded';
        return '<td><button type="button" class="dt-badge ' + cls + ' adm-mp-chip" data-pid="' + esc(p.dbId) + '" data-mk="' + m.key + '" data-st="' + st + '">' + txt + '</button></td>';
      }).join('') + '</tr>';
    }).join('') || '<tr><td colspan="5" class="adm-empty">No products yet.</td></tr>';
  }

  var mpTasksBox = $('admMpTasks');
  if (mpTasksBox) mpTasksBox.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]'); if (!btn || !can('admin')) return;
    var pid = btn.getAttribute('data-pid'), mk = btn.getAttribute('data-mk'), kind = btn.getAttribute('data-kind'), taskId = btn.getAttribute('data-task');
    var p = allProducts().filter(function (x) { return x.dbId === pid; })[0];
    var title = p ? p.title : 'a product';
    btn.disabled = true;
    var op;
    if (btn.getAttribute('data-act') === 'delete') {
      op = window.coldSupabase.from('marketplace_tasks').delete().eq('id', taskId);
    } else if (kind === 'task') {
      op = window.coldSupabase.from('marketplace_tasks').update({ done: true, done_at: new Date().toISOString() }).eq('id', taskId);
    } else {
      op = mpSaveListings(pid, [{ key: mk, status: 'live' }]);
    }
    Promise.resolve(op).then(function (res) {
      if (res && res.error) { admToast('Could not update the task', false); btn.disabled = false; return; }
      logAudit('Marketplaces: ' + (btn.getAttribute('data-act') === 'delete' ? 'deleted a task' : 'marked "' + (kind === 'upload' ? 'upload' : kind === 'update' ? 'update' : 'task') + '" done') + ' on ' + mpLabel(mk) + ' for "' + title + '"');
      return refreshMarketplaces();
    });
  });

  var mpFilterBox = $('admMpFilter');
  if (mpFilterBox) mpFilterBox.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mp]'); if (!b) return;
    MP_FILTER = b.getAttribute('data-mp'); renderMarketplaces();
  });

  var mpMatrixBox = $('admMpMatrix');
  if (mpMatrixBox) mpMatrixBox.addEventListener('click', function (e) {
    var b = e.target.closest('.adm-mp-chip'); if (!b || !can('admin')) return;
    var next = { pending: 'live', live: 'needs_update', needs_update: 'pending' }[b.getAttribute('data-st')] || 'pending';
    mpSaveListings(b.getAttribute('data-pid'), [{ key: b.getAttribute('data-mk'), status: next }]);
  });

  var mpAddForm = $('admMpAddForm');
  if (mpAddForm) mpAddForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var pid = $('admMpProduct').value, mk = $('admMpMarket').value, title = $('admMpTaskTitle').value.trim();
    var msg = $('admMpMsg');
    if (!pid || !mk || !title) { if (msg) msg.textContent = 'Pick a product, a marketplace, and write the task.'; return; }
    var p = allProducts().filter(function (x) { return x.dbId === pid; })[0];
    if (msg) msg.textContent = 'Adding…';
    window.coldSupabase.from('marketplace_tasks').insert({ product_id: pid, marketplace: mk, title: title, created_by: ADMIN.id }).then(function (res) {
      if (res.error) { if (msg) msg.textContent = 'Could not add the task.'; return; }
      if (msg) msg.textContent = '';
      $('admMpTaskTitle').value = '';
      admToast('Task added', true);
      logAudit('Marketplaces: added task "' + title + '" on ' + mpLabel(mk) + ' for "' + (p ? p.title : pid) + '"');
      return refreshMarketplaces();
    });
  });

  /* ================================================================
     ORDERS PANEL
     ================================================================ */
  var orderStatusDropdown = makeDropdown($('admOrderStatusFilterDD'), {
    onChange: function () { renderOrders(); }
  });
  orderStatusDropdown.setOptions([
    { value: 'all', label: 'All statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'completed', label: 'Completed' },
    { value: 'refunded', label: 'Refunded' },
    { value: 'revoked', label: 'Revoked' }
  ], 'all');
  function orderRowMenuHtml(o) {
    var items = ['<button type="button" class="adm-row-menu-item" data-action="view">View details</button>'];
    if (o.status === 'pending' && can('support')) items.push('<button type="button" class="adm-row-menu-item" data-action="complete">Mark completed</button>');
    if (o.status === 'completed' && can('support')) {
      items.push('<button type="button" class="adm-row-menu-item" data-action="refund">Refund</button>');
      items.push('<button type="button" class="adm-row-menu-item danger" data-action="revoke">Revoke license</button>');
    }
    return '<div class="adm-row-menu" data-id="' + esc(o.id) + '">' +
      '<button type="button" class="adm-row-menu-btn" aria-haspopup="true" aria-expanded="false" aria-label="Order actions">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>' +
      '<div class="adm-row-menu-list" hidden>' + items.join('') + '</div></div>';
  }
  function renderOrders() {
    var statusF = orderStatusDropdown.getValue() || 'all';
    var q = (($('admOrderSearch') || {}).value || '').trim().toLowerCase();
    var rows = ORDERS.filter(function (o) {
      if (o.status === 'failed') return false;
      // Pending clutters the default view with checkouts that were opened
      // and never finished - same call as the customer dashboard's own
      // purchase history. Unlike 'failed' this isn't a hard exclude though:
      // a pending order can still be genuinely actionable (a stuck crypto/
      // Robux payment, "Mark completed" below), so filtering to it directly
      // via the status dropdown still works - it's just not what shows by
      // default alongside everything else.
      if (o.status === 'pending' && statusF === 'all') return false;
      var okStatus = statusF === 'all' || o.status === statusF;
      var okQ = !q || o.id.toLowerCase().indexOf(q) >= 0 || o.title.toLowerCase().indexOf(q) >= 0 || o.userName.toLowerCase().indexOf(q) >= 0;
      return okStatus && okQ;
    }).sort(function (a, b) { return new Date(b.date) - new Date(a.date); }).slice(0, 200);
    $('admOrdersBody').innerHTML = rows.map(function (o) {
      var img = o.image ? window.imgUrl(o.image) : '/banner.jpg';
      // A real, currently-paying gift order - distinct from the "Gifted"
      // free-comp badge, so shown alongside it rather than in place of it.
      var giftBadge = o.purchasedByUserId ? ' <span class="dt-badge warn" title="Bought as a gift for a different account">Gift</span>' : '';
      var statusHtml = o.source === 'granted' ? '<span class="dt-badge info">Gifted</span>' : statusBadge(o.status);
      return '<div class="dash-row" data-id="' + esc(o.id) + '">' +
        '<span class="dr-thumb" style="background-image:url(\'' + img + '\')"></span>' +
        '<div class="dr-main">' +
          '<div class="dr-title">' + esc(o.title) + (o.licence === 'resell' ? ' <span class="adm-sub">· resell</span>' : '') + '</div>' +
          '<div class="dr-sub">' + fmtDate(new Date(o.date)) + ' · <span class="dt-mono">' + esc(o.id) + '</span> · ' + esc(o.userName) + ' · ' + o.currency.toUpperCase() + ' · ' + statusHtml + giftBadge + '</div>' +
        '</div>' +
        '<span class="p-price" data-fixed>' + orderAmount(o) + '</span>' +
        '<div class="dr-actions">' + orderRowMenuHtml(o) + '</div></div>';
    }).join('') || '<p class="dash-empty-note">No orders match.</p>';
  }
  var ordersBody = $('admOrdersBody');
  // Listens on document, not ordersBody: openRowMenu() portals the open
  // .adm-row-menu-list to <body> (see its own comment for why), so a click
  // on one of its action items no longer bubbles through ordersBody at
  // all once that's happened. The .contains(menuEl) checks below stand in
  // for the scoping ordersBody used to provide for free - menuEl (the
  // .adm-row-menu wrapper holding the trigger button) never itself moves,
  // only its .adm-row-menu-list child does.
  if (ordersBody) document.addEventListener('click', async function (e) {
    var menuBtn = e.target.closest('.adm-row-menu-btn');
    if (menuBtn) {
      var menu = menuBtn.closest('.adm-row-menu');
      if (!ordersBody.contains(menu)) return;
      var wasOpen = menu.classList.contains('open');
      closeAllRowMenus();
      if (!wasOpen) openRowMenu(menu);
      return;
    }
    var actionBtn = e.target.closest('.adm-row-menu-item');
    if (!actionBtn) return;
    var listEl = actionBtn.closest('.adm-row-menu-list');
    var menuEl = listEl && listEl.__ownerMenu;
    if (!menuEl || !ordersBody.contains(menuEl)) return;
    var id = menuEl.getAttribute('data-id');
    var o = ORDERS.filter(function (x) { return x.id === id; })[0]; if (!o) return;
    closeAllRowMenus();
    var action = actionBtn.getAttribute('data-action');

    if (action === 'view') {
      viewOrderId = id;
      showPanel('order-detail', { extra: id });
      return;
    }
    if (action === 'complete') {
      if (!can('support')) return;
      callManageOrder(o.dbId, 'complete').then(function () {
        logAudit('Marked order ' + id + ' completed');
        return refreshOrders();
      }).catch(function (err) { alert(err.message || 'Could not update the order.'); });
    } else if (action === 'refund') {
      if (!can('support')) return;
      var reason = await dialogPrompt('This refund is recorded against order ' + id + '.', 'Requested by customer', { title: 'Issue refund', inputLabel: 'Internal reason', acceptLabel: 'Issue refund' }); if (reason === null) return;
      callManageOrder(o.dbId, 'refund', reason || 'Requested by customer').then(function () {
        logAudit('Refunded order ' + id + ' (' + orderAmount(o) + ')');
        return refreshOrders();
      }).catch(function (err) { alert(err.message || 'Could not process the refund.'); });
    } else if (action === 'revoke') {
      if (!can('support')) return;
      if (!(await dialogConfirm('The buyer will immediately lose download access. This does not refund their payment.', { title: 'Revoke licence for order ' + id, acceptLabel: 'Continue' }))) return;
      var revReason = await dialogPrompt('Add the internal reason for this revocation.', 'Policy violation', { title: 'Revoke licence', inputLabel: 'Internal reason', acceptLabel: 'Revoke licence' }); if (revReason === null) return;
      callManageOrder(o.dbId, 'revoke', revReason || 'Policy violation').then(function () {
        logAudit('Revoked license for order ' + id + ' - ' + (revReason || 'Policy violation'));
        return refreshOrders();
      }).catch(function (err) { alert(err.message || 'Could not revoke the license.'); });
    }
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('.adm-row-menu') || e.target.closest('.adm-row-menu-list')) return;
    closeAllRowMenus();
  });
  var orderSearchInput = $('admOrderSearch');
  if (orderSearchInput) orderSearchInput.addEventListener('input', renderOrders);

  /* ================================================================
     ORDER DETAIL (drill-down from the orders table's row menu)
     ================================================================ */
  var viewOrderId = null;
  function paymentInfoRows(o) {
    var rows = [];
    if (o.paymentProvider) rows.push(['Payment provider', esc(o.paymentProvider)]);
    if (o.stripePaymentIntentId) rows.push(['Stripe payment intent', '<span class="dt-mono">' + esc(o.stripePaymentIntentId) + '</span>']);
    if (o.stripeCheckoutSessionId) rows.push(['Stripe checkout session', '<span class="dt-mono">' + esc(o.stripeCheckoutSessionId) + '</span>']);
    if (o.paypalOrderId) rows.push(['PayPal order ID', '<span class="dt-mono">' + esc(o.paypalOrderId) + '</span>']);
    if (o.paypalCaptureId) rows.push(['PayPal capture ID', '<span class="dt-mono">' + esc(o.paypalCaptureId) + '</span>']);
    if (o.cryptoProvider) rows.push(['Crypto provider', esc(o.cryptoProvider)]);
    if (o.cryptoChargeId) rows.push(['Crypto charge ID', '<span class="dt-mono">' + esc(o.cryptoChargeId) + '</span>']);
    if (o.cryptoPaymentId) rows.push(['Crypto payment ID', '<span class="dt-mono">' + esc(o.cryptoPaymentId) + '</span>']);
    if (o.externalTransactionId) rows.push(['External transaction ID', '<span class="dt-mono">' + esc(o.externalTransactionId) + '</span>']);
    if (o.robloxGamepassId) rows.push(['Roblox gamepass ID', '<span class="dt-mono">' + esc(o.robloxGamepassId) + '</span>']);
    if (o.robloxBuyerId) rows.push(['Roblox buyer ID', '<span class="dt-mono">' + esc(o.robloxBuyerId) + '</span>']);
    if (o.robloxVerificationMethod) rows.push(['Roblox verification', esc(o.robloxVerificationMethod)]);
    return rows;
  }
  function detailRow(label, valueHtml) {
    return '<div class="adm-detail-row"><span class="adm-detail-label">' + esc(label) + '</span><span class="adm-detail-val">' + valueHtml + '</span></div>';
  }
  function renderOrderDetail() {
    var el = $('admOrderDetailBody'); if (!el) return;
    var o = ORDERS.filter(function (x) { return x.id === viewOrderId; })[0];
    if (!o) { el.innerHTML = '<p class="adm-empty">Order not found.</p>'; return; }

    var itemsRows = (o.items || []).map(function (it) {
      return '<tr><td>' + esc(it.title || '') + '</td><td>' + (it.licence === 'resell' ? 'Resell' : 'Standard') + '</td><td>' + (it.qty || 1) + '</td><td>' + usd(it.unit_price_usd || 0) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="adm-empty">No line items.</td></tr>';

    var payRows = paymentInfoRows(o);
    var payHtml = payRows.length
      ? payRows.map(function (r) { return detailRow(r[0], r[1]); }).join('')
      : '<p class="adm-note">No payment reference on file for this order.</p>';

    var canAct = can('support');
    var actions = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px;">';
    if (o.status === 'pending' && canAct) actions += '<button class="btn btn-ghost adm-btn-sm" type="button" id="admOdComplete">Mark completed</button>';
    if (o.status === 'completed' && canAct) {
      actions += '<button class="btn btn-ghost adm-btn-sm" type="button" id="admOdRefund">Refund</button>';
      actions += '<button class="btn btn-ghost adm-btn-sm" type="button" id="admOdRevoke" style="color:#ff6b6b;">Revoke license</button>';
    }
    actions += '</div>';

    el.innerHTML =
      '<div class="dash-head"><h1>Order ' + esc(o.id) + '</h1><p>' + statusBadge(o.status) + '</p></div>' +
      '<div class="dash-card glass">' +
        '<div class="dash-card-head"><h2>Overview</h2></div>' +
        detailRow('Placed', fmtDateTime(new Date(o.date))) +
        (o.paidAt ? detailRow('Paid', fmtDateTime(new Date(o.paidAt))) : '') +
        detailRow('Buyer', esc(o.userName) + (o.userEmail ? ' &nbsp;<span class="adm-sub">' + esc(o.userEmail) + '</span>' : '')) +
        detailRow('Source', esc(o.source)) +
        detailRow('Currency', o.currency.toUpperCase()) +
        detailRow('Subtotal', usd(o.subtotal)) +
        (o.couponCode ? detailRow('Coupon', esc(o.couponCode) + ' (&minus;' + usd(o.discount) + ')') : '') +
        detailRow('Total', o.currency === 'robux' ? robuxRaw(o.totalRobux) : usd(o.total)) +
        (o.refundReason ? detailRow(o.status === 'revoked' ? 'Revoke reason' : 'Refund reason', esc(o.refundReason)) : '') +
        actions +
      '</div>' +
      '<div class="dash-card glass dash-tablewrap">' +
        '<div class="dash-card-head"><h2>Items</h2></div>' +
        '<table class="dash-table"><thead><tr><th>Product</th><th>Licence</th><th>Qty</th><th>Unit price</th></tr></thead><tbody>' + itemsRows + '</tbody></table>' +
      '</div>' +
      '<div class="dash-card glass">' +
        '<div class="dash-card-head"><h2>Payment reference</h2></div>' +
        payHtml +
      '</div>';

    var completeBtn = $('admOdComplete');
    if (completeBtn) completeBtn.addEventListener('click', function () {
      completeBtn.disabled = true;
      callManageOrder(o.dbId, 'complete').then(function () {
        logAudit('Marked order ' + o.id + ' completed');
        return refreshOrders();
      }).then(renderOrderDetail).catch(function (err) {
        completeBtn.disabled = false;
        alert(err.message || 'Could not update the order.');
      });
    });
    var refundBtn = $('admOdRefund');
    if (refundBtn) refundBtn.addEventListener('click', async function () {
      var reason = await dialogPrompt('This refund is recorded against order ' + o.id + '.', 'Requested by customer', { title: 'Issue refund', inputLabel: 'Internal reason', acceptLabel: 'Issue refund' }); if (reason === null) return;
      refundBtn.disabled = true;
      callManageOrder(o.dbId, 'refund', reason || 'Requested by customer').then(function () {
        logAudit('Refunded order ' + o.id + ' (' + orderAmount(o) + ')');
        return refreshOrders();
      }).then(renderOrderDetail).catch(function (err) {
        refundBtn.disabled = false;
        alert(err.message || 'Could not process the refund.');
      });
    });
    var revokeBtn = $('admOdRevoke');
    if (revokeBtn) revokeBtn.addEventListener('click', async function () {
      if (!(await dialogConfirm('The buyer will immediately lose download access. This does not refund their payment.', { title: 'Revoke licence for order ' + o.id, acceptLabel: 'Continue' }))) return;
      var revReason = await dialogPrompt('Add the internal reason for this revocation.', 'Policy violation', { title: 'Revoke licence', inputLabel: 'Internal reason', acceptLabel: 'Revoke licence' }); if (revReason === null) return;
      revokeBtn.disabled = true;
      callManageOrder(o.dbId, 'revoke', revReason || 'Policy violation').then(function () {
        logAudit('Revoked license for order ' + o.id + ' - ' + (revReason || 'Policy violation'));
        return refreshOrders();
      }).then(renderOrderDetail).catch(function (err) {
        revokeBtn.disabled = false;
        alert(err.message || 'Could not revoke the license.');
      });
    });
  }

  /* ================================================================
     RESELLERS PANEL
     ================================================================ */
  var RESELLERS = [];
  function refreshResellers() {
    return invokeAdminFn('admin-resellers', { action: 'list' }).then(function (d) {
      RESELLERS = (d.resellers || []).map(function (r) {
        return {
          id: r.id || null,                         // resellers row id (null = not onboarded)
          key: r.id || ('oi:' + (r.orderItemId || '')),
          orderItemId: r.orderItemId || null,
          userId: r.userId || null,
          onboarded: !!r.onboarded,
          contactType: r.contactType || 'email',
          contactValue: r.contactValue || '',
          sellingLocations: Array.isArray(r.sellingLocations) ? r.sellingLocations : [],
          accountName: r.accountName || null,
          accountEmail: r.accountEmail || null,
          productTitle: r.productTitle || null,
          productId: r.productId || null,
          sellingWhere: r.sellingWhere || null,
          sellingNotes: r.sellingNotes || null,
          status: r.status || 'active',
          source: r.source || 'purchase',
          createdAt: r.createdAt || r.licencedAt
        };
      });
      if (curPanel === 'resellers') renderResellers();
    }).catch(function (err) { console.error('[admin] failed to load resellers:', err.message); });
  }
  function resellerInitials(r) {
    var s = String(r.accountName || r.contactValue || '?').replace(/^https?:\/\//, '').trim();
    var parts = s.split(/[\s@._/-]+/).filter(Boolean);
    return (((parts[0] || '?')[0] || '?') + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function renderResellers() {
    var body = $('admResellersBody'); if (!body) return;
    var q = (($('admResellerSearch') || {}).value || '').trim().toLowerCase();
    var rows = RESELLERS.filter(function (r) {
      if (!q) return true;
      return [r.contactValue, r.accountEmail, r.accountName, r.productTitle].some(function (v) { return v && v.toLowerCase().indexOf(q) >= 0; });
    }).sort(function (a, b) {
      if (a.onboarded !== b.onboarded) return a.onboarded ? 1 : -1;   // needs-info first
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    var needInfo = RESELLERS.filter(function (r) { return !r.onboarded; }).length;
    var countEl = $('admResellerCount');
    if (countEl) countEl.textContent = RESELLERS.length
      ? (RESELLERS.length + ' reseller' + (RESELLERS.length === 1 ? '' : 's') + (needInfo ? ' · ' + needInfo + ' need info' : ''))
      : '';

    body.innerHTML = rows.map(function (r) {
      var name = r.accountName || r.contactValue || 'Unknown seller';
      var statusHtml = !r.onboarded
        ? '<span class="dt-badge warn">Needs info</span>'
        : (r.status === 'active' ? '<span class="dt-badge ok">Active</span>' : '<span class="dt-badge mute">Inactive</span>');

      var meta = [r.source === 'manual' ? 'Manual add' : 'Purchase', fmtDate(new Date(r.createdAt))];
      if (r.onboarded && r.contactValue) meta.push((r.contactType === 'discord' ? 'Discord: ' : '') + r.contactValue);
      else if (!r.onboarded) meta.push('awaiting seller info');

      var locsHtml = '';
      if (r.sellingLocations.length) {
        locsHtml = '<div class="adm-reseller-locs">' + r.sellingLocations.map(function (l) {
          var label = l.platform || String(l.url || '').replace(/^https?:\/\//, '').split('/')[0] || 'Link';
          return '<a class="adm-reseller-loc" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(label) + ADM_ICON_EXT + '</a>';
        }).join('') + '</div>';
      } else if (r.onboarded && r.sellingWhere) {
        locsHtml = '<div class="adm-reseller-locs"><span class="adm-reseller-loc as-text">' + esc(r.sellingWhere) + '</span></div>';
      }

      return '<div class="dash-row adm-reseller-row" data-key="' + esc(r.key) + '">' +
        '<span class="adm-reseller-av' + (r.onboarded ? '' : ' needs-info') + '">' + esc(resellerInitials(r)) + '</span>' +
        '<div class="dr-main">' +
          '<div class="dr-title">' + esc(name) + ' ' + statusHtml + '</div>' +
          '<div class="dr-prod">' + esc(r.productTitle || 'No product set') + '</div>' +
          '<div class="dr-sub">' + esc(meta.join(' · ')) + '</div>' +
          locsHtml +
        '</div>' +
        '<div class="dr-actions"><button class="adm-icon-btn adm-reseller-edit" type="button" title="' + (r.onboarded ? 'Edit reseller' : 'Add seller info') + '" aria-label="' + (r.onboarded ? 'Edit reseller' : 'Add seller info') + '">' + ADM_ICON_KEBAB + '</button></div>' +
        '</div>';
    }).join('') || '<p class="dash-empty-note">No resell licences sold yet.</p>';
  }
  var resellerSearchEl = $('admResellerSearch');
  if (resellerSearchEl) resellerSearchEl.addEventListener('input', renderResellers);

  var resellerProductDropdown = makeDropdown($('admResellerProductDD'), { valueInput: $('admResellerProductId'), placeholder: 'None', searchable: true });
  var resellerStatusDropdown = makeDropdown($('admResellerStatusDD'), { valueInput: $('admResellerStatus') });
  resellerStatusDropdown.setOptions([{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], 'active');

  var admResellerContactType = 'email';
  function admResellerApplyContact(t) {
    admResellerContactType = t === 'discord' ? 'discord' : 'email';
    var sw = $('admResellerContactSwitch'); if (!sw) return;
    sw.querySelectorAll('.bt-opt').forEach(function (o) {
      var on = o.getAttribute('data-ctype') === admResellerContactType;
      o.classList.toggle('active', on); o.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var inp = $('admResellerContact');
    if (inp) { inp.type = admResellerContactType === 'email' ? 'email' : 'text'; inp.placeholder = admResellerContactType === 'email' ? 'you@example.com' : 'Their Discord username or server invite'; }
  }
  (function () {
    var sw = $('admResellerContactSwitch');
    if (sw) sw.addEventListener('click', function (e) { var b = e.target.closest('.bt-opt'); if (b) admResellerApplyContact(b.getAttribute('data-ctype')); });
    var addBtn = $('admResellerAddLoc');
    if (addBtn) addBtn.addEventListener('click', function () { admAddResellerLocRow(); });
  })();
  function admResellerLocRows() { var w = $('admResellerLocations'); return w ? Array.prototype.slice.call(w.querySelectorAll('.rs-loc-row')) : []; }
  function admSyncResellerLocRemove() { var rows = admResellerLocRows(); rows.forEach(function (r) { var x = r.querySelector('.rs-loc-x'); if (x) x.disabled = rows.length <= 1; }); }
  function admAddResellerLocRow(platform, url) {
    var w = $('admResellerLocations'); if (!w) return;
    var row = document.createElement('div');
    row.className = 'rs-loc-row';
    row.innerHTML =
      '<input type="text" class="rs-input rs-loc-platform" autocomplete="off" placeholder="Platform (eg: BuiltByBit, ClearlyDev, Discord)" />' +
      '<input type="url" class="rs-input rs-loc-url" autocomplete="off" placeholder="Link to their store / profile" />' +
      '<button type="button" class="rs-loc-x" aria-label="Remove location"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
    if (platform) row.querySelector('.rs-loc-platform').value = platform;
    if (url) row.querySelector('.rs-loc-url').value = url;
    row.querySelector('.rs-loc-x').addEventListener('click', function () { if (admResellerLocRows().length <= 1) return; row.remove(); admSyncResellerLocRemove(); });
    w.appendChild(row); admSyncResellerLocRemove();
  }

  var admResellerCtx = {};
  function openResellerEditor(r) {
    // r may be: an onboarded resellers row, a not-yet-onboarded resell
    // licence (r.id null, r.orderItemId set), or null (fully manual add).
    admResellerCtx = {
      id: (r && r.id) || '',
      orderItemId: (r && r.orderItemId) || '',
      userId: (r && r.userId) || ''
    };
    var lockedProduct = r && r.orderItemId && r.productId;   // a real licence - product is fixed
    resellerProductDropdown.setOptions([{ value: '', label: 'None' }].concat(
      allProducts().filter(function (p) { return p.resell; }).map(function (p) { return { value: p.id, label: p.title }; }).sort(function (a, b) { return a.label.localeCompare(b.label); })
    ), (r && r.productId) || '');
    resellerStatusDropdown.setValue((r && r.status) || 'active', true);
    $('admResellerName').value = (r && r.displayName) || '';
    $('admResellerNotes').value = (r && r.sellingNotes) || '';
    admResellerApplyContact((r && r.contactType) || 'email');
    var prefillEmail = (r && !r.onboarded && r.accountEmail && !/\.coldd\.internal$/i.test(r.accountEmail)) ? r.accountEmail : '';
    $('admResellerContact').value = (r && r.contactValue) || prefillEmail || '';
    $('admResellerLocations').innerHTML = '';
    var locs = ((r && r.sellingLocations) || []).filter(function (l) { return l && (l.platform || l.url); });
    if (locs.length) locs.forEach(function (l) { admAddResellerLocRow(l.platform, l.url); });
    else { admAddResellerLocRow(); admAddResellerLocRow(); admAddResellerLocRow(); }
    var heading = !r ? 'Add reseller' : (r.onboarded ? 'Edit reseller' : 'Add seller info');
    $('admResellerEditHeading').textContent = heading + (r && r.accountName ? ' - ' + r.accountName : '');
    $('admResellerMsg').textContent = '';
    showPanel('reseller-edit', { extra: admResellerCtx.id || admResellerCtx.orderItemId || 'new' });
  }
  var openResellerCreateBtn = $('admOpenResellerCreate');
  if (openResellerCreateBtn) openResellerCreateBtn.addEventListener('click', function () { openResellerEditor(null); });

  var resellersBody = $('admResellersBody');
  if (resellersBody) resellersBody.addEventListener('click', function (e) {
    // The storefront-link chips are real links - let them through.
    if (e.target.closest('.adm-reseller-loc')) return;
    var row = e.target.closest('.adm-reseller-row'); if (!row) return;
    var r = RESELLERS.filter(function (x) { return x.key === row.getAttribute('data-key'); })[0];
    if (r) openResellerEditor(r);
  });

  var resellerForm = $('admResellerForm');
  if (resellerForm) resellerForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = admResellerCtx.id;
    var saveBtn = $('admResellerSaveBtn');
    var msgEl = $('admResellerMsg');
    var label = saveBtn.querySelector('.btn-label'), spinner = saveBtn.querySelector('.btn-spinner');
    saveBtn.disabled = true; if (label) label.hidden = true; if (spinner) spinner.hidden = false;

    var locations = [];
    var badLoc = false;
    admResellerLocRows().forEach(function (r) {
      var pl = r.querySelector('.rs-loc-platform').value.trim();
      var u = r.querySelector('.rs-loc-url').value.trim();
      if (!pl && !u) return;
      if (!pl || !u) badLoc = true; else locations.push({ platform: pl, url: u });
    });
    var contactValue = $('admResellerContact').value.trim();
    if (!contactValue || badLoc || !locations.length) {
      saveBtn.disabled = false; if (label) label.hidden = false; if (spinner) spinner.hidden = true;
      if (msgEl) msgEl.textContent = !contactValue ? 'A contact email or Discord is required.'
        : badLoc ? 'Every location needs both a platform and a link.'
        : 'Add at least one place they sell, with a link.';
      return;
    }

    var payload = {
      contactType: admResellerContactType,
      contactValue: contactValue,
      displayName: $('admResellerName').value.trim(),
      productId: $('admResellerProductId').value || null,
      sellingLocations: locations,
      status: $('admResellerStatus').value || 'active',
      sellingNotes: $('admResellerNotes').value.trim()
    };

    var req = id
      ? invokeAdminFn('admin-resellers', { action: 'update', id: id, patch: payload }, 'Could not update reseller.')
      : invokeAdminFn('admin-resellers', Object.assign({ action: 'create' }, payload, {
          orderItemId: admResellerCtx.orderItemId || null,
          userId: admResellerCtx.userId || null
        }), 'Could not save seller info.');

    req.then(function () {
      logAudit((id ? 'Updated' : 'Added') + ' reseller ' + contactValue);
      return refreshResellers();
    }).then(function () {
      showPanel('resellers');
    }).catch(function (err) {
      msgEl.textContent = err.message || 'Something went wrong.';
    }).then(function () {
      saveBtn.disabled = false; if (label) label.hidden = false; if (spinner) spinner.hidden = true;
    });
  });

  /* ================================================================
     REVIEWS PANEL
     ================================================================ */
  var reviewFilterDropdown = makeDropdown($('admReviewFilterDD'), {
    onChange: function () { renderReviews(); }
  });
  reviewFilterDropdown.setOptions([
    { value: 'new', label: 'New' },
    { value: 'approved', label: 'Visible' },
    { value: 'hidden', label: 'Hidden' },
    { value: 'all', label: 'All' }
  ], 'new');
  function renderReviews() {
    var f = reviewFilterDropdown.getValue() || 'new';
    var rows = REVIEWS.filter(function (r) { return f === 'all' || (f === 'new' ? !r.adminReviewedAt : r.status === f); }).sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    $('admReviewsList').innerHTML = rows.map(function (r) {
      var stars = '';
      for (var i = 0; i < 5; i++) stars += '<span class="pd-star ' + (i < r.stars ? 'on' : '') + '">' + (i < r.stars ? '★' : '☆') + '</span>';
      return '<div class="dash-card glass adm-review" data-id="' + r.id + '">' +
        '<div class="adm-review-head"><strong>' + esc(r.user) + '</strong><span class="adm-sub">on ' + esc(r.productTitle) + '</span><span class="adm-sub">' + fmtDate(new Date(r.date)) + '</span>' +
          (!r.adminReviewedAt ? statusBadge('pending') : statusBadge(r.status === 'hidden' ? 'refunded' : 'completed')) + '</div>' +
        '<div class="pd-rev-stars">' + stars + '</div>' +
        '<p class="adm-review-text">' + esc(r.text) + '</p>' +
        (r.reply ? '<div class="adm-review-reply"><strong>Your reply</strong><p>' + esc(r.reply.text) + '</p></div>' : '') +
        '<div class="adm-review-reply-form" hidden>' +
          '<textarea class="adm-input adm-textarea adm-rev-reply-input" rows="2" placeholder="Write a public reply to this review…">' + esc(r.reply ? r.reply.text : '') + '</textarea>' +
          '<button type="button" class="btn btn-primary adm-btn-sm adm-rev-reply-save">Save reply</button>' +
        '</div>' +
        '<div class="adm-row-actions">' +
          (r.status !== 'hidden' ? '<button class="btn btn-ghost adm-btn-sm adm-rev-hide" type="button">Hide</button>' : '') +
          '<button class="btn btn-ghost adm-btn-sm adm-rev-reply-toggle" type="button">' + (r.reply ? 'Edit reply' : 'Reply') + '</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-rev-goto" type="button">Go to product</button>' +
        '</div></div>';
    }).join('') || '<p class="adm-empty">Nothing here.</p>';

    // Reviews are public the moment they're submitted now - there's no
    // approval step for this panel to gate. Opening it is what clears the
    // "new review" flag driving the dashboard to-do, same as reading an
    // inbox marks it read.
    var unseen = rows.filter(function (r) { return !r.adminReviewedAt; });
    if (unseen.length) {
      Promise.all(unseen.map(function (r) { return callModerateReview(r.dbId, 'seen'); }))
        .then(refreshReviews)
        .catch(function () {});
    }
  }
  var reviewsList = $('admReviewsList');
  if (reviewsList) reviewsList.addEventListener('click', function (e) {
    var card = e.target.closest('.adm-review'); if (!card) return;
    var id = card.getAttribute('data-id');
    var r = REVIEWS.filter(function (x) { return x.id === id; })[0]; if (!r) return;
    if (e.target.classList.contains('adm-rev-hide')) {
      callModerateReview(r.dbId, 'hide').then(function () {
        logAudit('Hid review by ' + r.user + ' on "' + r.productTitle + '"');
        return refreshReviews();
      }).catch(function (err) { alert(err.message || 'Could not hide review.'); });
    } else if (e.target.classList.contains('adm-rev-reply-toggle')) {
      var form = card.querySelector('.adm-review-reply-form');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('textarea').focus();
    } else if (e.target.classList.contains('adm-rev-reply-save')) {
      var text = card.querySelector('.adm-rev-reply-input').value.trim();
      callModerateReview(r.dbId, 'reply', text || null).then(function () {
        logAudit((text ? 'Replied to' : 'Removed reply on') + ' review by ' + r.user + ' on "' + r.productTitle + '"');
        return refreshReviews();
      }).catch(function (err) { alert(err.message || 'Could not save reply.'); });
    } else if (e.target.classList.contains('adm-rev-goto')) {
      openProductEdit(r.productId);
    }
  });

  /* ---- Import a review (from another platform) ---- */
  var importReviewSearch = $('admImportReviewProductSearch');
  var importReviewResults = $('admImportReviewProductResults');
  var importReviewSlugInput = $('admImportReviewProductSlug');
  if (importReviewSearch) importReviewSearch.addEventListener('input', function () {
    importReviewSlugInput.value = '';
    var q = importReviewSearch.value.trim().toLowerCase();
    if (!q) { importReviewResults.hidden = true; return; }
    var matches = PRODUCTS_CACHE.filter(function (p) { return p.title.toLowerCase().indexOf(q) >= 0; }).slice(0, 8);
    importReviewResults.innerHTML = matches.map(function (p) {
      return '<button type="button" class="adm-dd-opt" data-slug="' + esc(p.id) + '" data-title="' + esc(p.title) + '">' + esc(p.title) + '</button>';
    }).join('') || '<div class="adm-dd-opt" style="opacity:.5;">No matches</div>';
    importReviewResults.hidden = false;
  });
  if (importReviewResults) importReviewResults.addEventListener('click', function (e) {
    var opt = e.target.closest('[data-slug]'); if (!opt) return;
    importReviewSlugInput.value = opt.getAttribute('data-slug');
    importReviewSearch.value = opt.getAttribute('data-title');
    importReviewResults.hidden = true;
  });
  document.addEventListener('click', function (e) {
    if (importReviewResults && !e.target.closest('#admImportReviewProductSearch') && !e.target.closest('#admImportReviewProductResults')) {
      importReviewResults.hidden = true;
    }
  });
  var importReviewStarsDropdown = makeDropdown($('admImportReviewStarsDD'), { valueInput: $('admImportReviewStars') });
  importReviewStarsDropdown.setOptions([
    { value: '5', label: '★★★★★ (5)' }, { value: '4', label: '★★★★ (4)' }, { value: '3', label: '★★★ (3)' },
    { value: '2', label: '★★ (2)' }, { value: '1', label: '★ (1)' }
  ], '5');
  var importReviewPlatformDropdown = makeDropdown($('admImportReviewPlatformDD'), { valueInput: $('admImportReviewPlatform') });
  importReviewPlatformDropdown.setOptions(['BuiltByBit', 'ClearlyDev', 'Discord', 'Creator Store', 'Other'], 'BuiltByBit');

  var importReviewForm = $('admImportReviewForm');
  if (importReviewForm) importReviewForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var msgEl = $('admImportReviewMsg');
    var slug = importReviewSlugInput.value;
    if (!slug) { if (msgEl) { msgEl.className = 'co-msg err show'; msgEl.textContent = 'Pick a product from the search results.'; } return; }
    var body = {
      slug: slug,
      stars: $('admImportReviewStars').value,
      reviewerName: $('admImportReviewName').value.trim(),
      platform: $('admImportReviewPlatform').value,
      text: $('admImportReviewText').value.trim()
    };
    invokeAdminFn('admin-import-review', body, 'Could not import review.').then(function () {
      logAudit('Imported a ' + body.platform + ' review for "' + importReviewSearch.value + '"');
      importReviewForm.reset(); importReviewSlugInput.value = '';
      importReviewStarsDropdown.setValue('5'); importReviewPlatformDropdown.setValue('BuiltByBit');
      if (msgEl) { msgEl.className = 'co-msg show'; msgEl.textContent = 'Review imported and published.'; }
      return refreshReviews();
    }).catch(function (err) {
      if (msgEl) { msgEl.className = 'co-msg err show'; msgEl.textContent = err.message || 'Could not import review.'; }
    });
  });

  /* ================================================================
     USERS PANEL (+ manual product grants)
     ================================================================ */
  function userSpend(userId) {
    return ORDERS.filter(function (o) { return o.userId === userId && o.status === 'completed'; }).reduce(function (s, o) { return s + o.total; }, 0);
  }
  // Completed only, matching userSpend above - counting every attempt
  // (including abandoned/pending ones that were never actually paid) made
  // this column contradict Spent right next to it: an account could show
  // "11 orders, $0.00 spent", which reads as broken/fake data even though
  // each number was individually accurate. The full total/pending/completed
  // breakdown is still available in the View more detail modal.
  function userOrderCount(userId) { return ORDERS.filter(function (o) { return o.userId === userId && o.status === 'completed'; }).length; }
  // Cross-references the grant form's current user+product picks against
  // real paid orders, so an admin granting a duplicate finds out before
  // clicking Grant rather than after - flagged directly ("make a little
  // warning saying they already own it") rather than blocking the submit,
  // since re-granting is occasionally legitimate (account merges, a
  // support fix).
  function renderGrantOwnershipWarning() {
    var warn = $('admGrantOwnedWarn'); if (!warn) return;
    var userId = grantUserDropdown.getValue();
    var productIds = grantProductDropdown.getValue();
    if (!userId || !productIds.length) { warn.hidden = true; return; }
    var owned = productIds.filter(function (slug) {
      return ORDERS.some(function (o) {
        return o.userId === userId && o.status === 'completed' &&
          (o.items || []).some(function (it) { return it.product_slug === slug; });
      });
    }).map(function (slug) { var p = findProduct(slug); return p ? p.title : slug; });
    warn.hidden = !owned.length;
    if (owned.length) warn.textContent = (owned.length === 1 ? owned[0] + ' is' : owned.join(', ') + ' are') + ' already owned by this user.';
  }
  var grantUserDropdown = makeDropdown($('admGrantUserDD'), { valueInput: $('admGrantUser'), placeholder: 'Select user', searchable: true, onChange: renderGrantOwnershipWarning });
  var grantProductDropdown = makeDropdown($('admGrantProductDD'), { valueInput: $('admGrantProduct'), placeholder: 'Select product(s)', searchable: true, multi: true, onChange: renderGrantOwnershipWarning });
  function userRowMenuHtml(u) {
    if (!can('admin')) return '';
    var items = ['<button type="button" class="adm-row-menu-item" data-action="view">View more</button>'];
    if (!u.isAdmin) {
      items.push('<button type="button" class="adm-row-menu-item" data-action="' + (u.status === 'active' ? 'ban' : 'unban') + '">' + (u.status === 'active' ? 'Ban' : 'Unban') + '</button>');
      items.push('<button type="button" class="adm-row-menu-item danger" data-action="remove">Remove account</button>');
    }
    return '<div class="adm-row-menu" data-id="' + esc(u.id) + '">' +
      '<button type="button" class="adm-row-menu-btn" aria-haspopup="true" aria-expanded="false" aria-label="User actions">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>' +
      '<div class="adm-row-menu-list" hidden>' + items.join('') + '</div></div>';
  }
  function renderUsers() {
    var q = (($('admUserSearch') || {}).value || '').trim().toLowerCase();
    var rows = USERS.filter(function (u) { return !q || u.name.toLowerCase().indexOf(q) >= 0 || u.email.toLowerCase().indexOf(q) >= 0; });
    $('admUsersBody').innerHTML = rows.map(function (u) {
      return '<tr data-id="' + u.id + '"><td>' + esc(u.name) + (u.isAdmin ? ' <span class="adm-sub">· admin</span>' : '') + '</td><td>' + esc(u.email) + '</td><td>' + fmtDate(new Date(u.joined)) + '</td><td>' + userOrderCount(u.id) + '</td><td>' + usd(userSpend(u.id)) + '</td>' +
        '<td>' + (u.status === 'active' ? '<span class="dt-badge ok">Active</span>' : '<span class="dt-badge err">Banned' + (u.banReason ? ' - ' + esc(u.banReason) : '') + '</span>') + '</td>' +
        '<td class="adm-row-actions">' + userRowMenuHtml(u) + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="adm-empty">No users match.</td></tr>';

    grantUserDropdown.setOptions(USERS.map(function (u) { return { value: u.id, label: u.name }; }).sort(function (a, b) { return a.label.localeCompare(b.label); }), grantUserDropdown.getValue());
    grantProductDropdown.setOptions(allProducts().map(function (p) { return { value: p.id, label: p.title }; }).sort(function (a, b) { return a.label.localeCompare(b.label); }), grantProductDropdown.getValue());
  }
  var usersBody = $('admUsersBody');
  // See the matching comment on the orders row-menu listener above - same
  // portal-to-<body> reason for listening on document instead of usersBody.
  if (usersBody) document.addEventListener('click', async function (e) {
    var menuBtn = e.target.closest('.adm-row-menu-btn');
    if (menuBtn) {
      var menu = menuBtn.closest('.adm-row-menu');
      if (!usersBody.contains(menu)) return;
      var wasOpen = menu.classList.contains('open');
      closeAllRowMenus();
      if (!wasOpen) openRowMenu(menu);
      return;
    }
    var actionBtn = e.target.closest('.adm-row-menu-item');
    if (!actionBtn) return;
    var listEl = actionBtn.closest('.adm-row-menu-list');
    var menuEl = listEl && listEl.__ownerMenu;
    if (!menuEl || !usersBody.contains(menuEl)) return;
    var id = menuEl.getAttribute('data-id');
    var u = USERS.filter(function (x) { return x.id === id; })[0]; if (!u) return;
    closeAllRowMenus();
    var action = actionBtn.getAttribute('data-action');

    if (!can('admin')) return;
    if (action === 'view') {
      openUserDetailModal(u);
    } else if (action === 'ban' || action === 'unban') {
      var willBan = action === 'ban';
      var reason = null;
      if (willBan) {
        reason = await dialogPrompt('Add the internal reason for banning ' + u.name + '.', 'Violated terms of service', { title: 'Ban user', inputLabel: 'Internal reason', acceptLabel: 'Ban user' });
        if (reason === null) return;
      } else if (!(await dialogConfirm('Restore access for ' + u.name + '?', { title: 'Unban user', acceptLabel: 'Unban user' }))) return;
      invokeAdminFn('admin-set-user-banned', { userId: u.id, banned: willBan, reason: reason }, 'Could not update user.').then(function () {
        logAudit((willBan ? 'Banned' : 'Unbanned') + ' user ' + u.name);
        return refreshUsers();
      }).catch(function (err) { alert(err.message || 'Could not update user.'); });
    } else if (action === 'remove') {
      openRemoveAccountModal(u);
    }
  });
  var userSearch = $('admUserSearch');
  if (userSearch) userSearch.addEventListener('input', renderUsers);

  // Full account record for support/legal requests ("what do we have on
  // this person") - everything mapProfileRow carries, plus the order
  // breakdown by status, all in one place instead of scattered across the
  // row's summary columns (which only ever showed completed orders/spend,
  // with no way to see pending/total from the table itself).
  var userDetailOverlay = $('admUserDetailOverlay');
  function closeUserDetailModal() { if (userDetailOverlay) userDetailOverlay.hidden = true; }
  if ($('admUserDetailClose')) $('admUserDetailClose').addEventListener('click', closeUserDetailModal);
  if (userDetailOverlay) userDetailOverlay.addEventListener('click', function (e) { if (e.target === userDetailOverlay) closeUserDetailModal(); });
  function openUserDetailModal(u) {
    if (!userDetailOverlay) return;
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    if ($('admUserDetailSub')) $('admUserDetailSub').textContent = u.name;
    set('admUdId', u.id);
    set('admUdEmail', u.email || '–');
    set('admUdJoined', fmtDate(new Date(u.joined)));
    set('admUdRole', u.isAdmin ? 'Admin' : (u.role || 'customer'));
    set('admUdStatus', u.status === 'banned' ? ('Banned' + (u.banReason ? ' - ' + u.banReason : '')) : 'Active');
    set('admUdVerified', u.emailVerified ? 'Yes' : 'No');
    set('admUdDiscord', u.discordId ? ('Linked (' + u.discordId + ')') : 'Not linked');
    set('admUdRoblox', u.robloxId ? ('Linked (' + u.robloxId + ')') : 'Not linked');
    set('admUdMarketing', u.marketingUnsubscribed ? 'Unsubscribed' : 'Subscribed');
    set('admUdRefCode', u.referralCode || '–');
    var userOrders = ORDERS.filter(function (o) { return o.userId === u.id; })
      .slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    set('admUdOrdersTotal', String(userOrders.length));
    set('admUdOrdersPaid', String(userOrders.filter(function (o) { return o.status === 'completed'; }).length));
    set('admUdOrdersPending', String(userOrders.filter(function (o) { return o.status === 'pending'; }).length));
    set('admUdSpent', usd(userSpend(u.id)));

    // The pop-out this replaces only ever showed counts - this is the
    // actual per-order record (what, when, how much, whether it went
    // through) behind "11 pending orders", so support/ops can see what's
    // really happening for this customer instead of guessing from a number.
    var ordersListEl = $('admUdOrdersList');
    if (ordersListEl) {
      ordersListEl.innerHTML = userOrders.length ? userOrders.map(function (o) {
        var badgeClass = o.status === 'completed' ? 'ok' : o.status === 'pending' ? 'warn' : 'err';
        var amount = o.currency === 'robux' ? (o.totalRobux ? o.totalRobux.toLocaleString('en-US') + ' R$' : usd(o.total)) : usd(o.total);
        return '<div class="adm-ud-order-row">' +
          '<span class="adm-ud-order-date">' + fmtDate(new Date(o.date)) + '</span>' +
          '<span class="adm-ud-order-title">' + esc(o.title) + '</span>' +
          '<span class="adm-ud-order-total">' + esc(amount) + '</span>' +
          '<span class="dt-badge ' + badgeClass + '">' + esc(o.status) + '</span>' +
          '</div>';
      }).join('') : '<p class="adm-empty">No orders yet.</p>';
    }

    // Same already-collected data the abandoned-cart recovery emails run
    // on (public.cart_snapshots) - not a new tracking surface, just
    // surfacing it here too instead of only in the separate Marketing
    // panel. Matched by user_id first (reliable for anyone signed in when
    // they left items in cart); email is a fallback for the rare case a
    // snapshot was written before the row picked up a user_id.
    var cartSection = $('admUdCartSection');
    var cart = ABANDONED.filter(function (c) { return c.userId === u.id || (u.email && c.email === u.email); })
      .sort(function (a, b) { return new Date(b.date) - new Date(a.date); })[0];
    if (cartSection) {
      if (cart) {
        cartSection.hidden = false;
        var cartHtml = '<div class="adm-ud-cart-row">' +
          (cart.image ? '<img src="' + esc(cart.image) + '" alt="" />' : '') +
          '<div class="adm-ud-cart-info"><div class="adm-ud-cart-title">' + esc(cart.title) + '</div>' +
          '<div class="adm-ud-cart-meta">Last active ' + fmtDate(new Date(cart.date)) +
          (cart.abandonedStep != null ? ' · left at checkout step ' + cart.abandonedStep : '') +
          (cart.recoveryEmailSentAt ? ' · recovery email sent ' + fmtDate(new Date(cart.recoveryEmailSentAt)) : ' · no recovery email sent yet') +
          '</div></div><span class="adm-ud-cart-value">' + usd(cart.value) + '</span></div>';
        cartSection.querySelector('#admUdCartActivity').innerHTML = cartHtml;
      } else {
        cartSection.hidden = true;
      }
    }

    userDetailOverlay.hidden = false;
  }

  // Replaces the stacked native confirm()+prompt() pair this used to be -
  // a plain browser prompt for a "type REMOVE to confirm" step reads as
  // broken/unstyled next to the rest of the panel, and stacking two
  // native dialogs for one destructive action was clunky regardless.
  var removeAcctOverlay = $('admRemoveAcctOverlay');
  var removeAcctSub = $('admRemoveAcctSub');
  var removeAcctInput = $('admRemoveAcctInput');
  var removeAcctMsg = $('admRemoveAcctMsg');
  var removeAcctConfirm = $('admRemoveAcctConfirm');
  var removeAcctCancel = $('admRemoveAcctCancel');
  var removeAcctClose = $('admRemoveAcctClose');
  var removeAcctTarget = null;
  function closeRemoveAcctModal() {
    if (removeAcctOverlay) removeAcctOverlay.hidden = true;
    removeAcctTarget = null;
    if (removeAcctInput) removeAcctInput.value = '';
    if (removeAcctMsg) removeAcctMsg.textContent = '';
    if (removeAcctConfirm) { removeAcctConfirm.disabled = true; removeAcctConfirm.textContent = 'Remove account'; }
  }
  function openRemoveAccountModal(u) {
    if (!removeAcctOverlay) return;
    removeAcctTarget = u;
    if (removeAcctSub) removeAcctSub.textContent = 'Permanently remove ' + u.name + '\'s account? This deletes their login, profile, and everything tied to it - it cannot be undone. Their past orders stay on record.';
    if (removeAcctInput) removeAcctInput.value = '';
    if (removeAcctMsg) removeAcctMsg.textContent = '';
    if (removeAcctConfirm) removeAcctConfirm.disabled = true;
    removeAcctOverlay.hidden = false;
    if (removeAcctInput) removeAcctInput.focus();
  }
  if (removeAcctInput) removeAcctInput.addEventListener('input', function () {
    if (removeAcctConfirm) removeAcctConfirm.disabled = removeAcctInput.value !== 'REMOVE';
  });
  if (removeAcctCancel) removeAcctCancel.addEventListener('click', closeRemoveAcctModal);
  if (removeAcctClose) removeAcctClose.addEventListener('click', closeRemoveAcctModal);
  if (removeAcctOverlay) removeAcctOverlay.addEventListener('click', function (e) { if (e.target === removeAcctOverlay) closeRemoveAcctModal(); });
  if (removeAcctConfirm) removeAcctConfirm.addEventListener('click', function () {
    if (!removeAcctTarget || removeAcctInput.value !== 'REMOVE') return;
    var u = removeAcctTarget;
    removeAcctConfirm.disabled = true;
    removeAcctConfirm.textContent = 'Removing…';
    invokeAdminFn('admin-delete-user', { userId: u.id }, 'Could not remove the account.').then(function () {
      logAudit('Removed account for ' + u.name + ' (' + u.email + ')');
      closeRemoveAcctModal();
      return refreshUsers();
    }).catch(function (err) {
      removeAcctConfirm.disabled = false;
      removeAcctConfirm.textContent = 'Remove account';
      if (removeAcctMsg) removeAcctMsg.textContent = err.message || 'Could not remove the account.';
    });
  });

  var grantForm = $('admGrantForm');
  if (grantForm) grantForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('support')) return;
    var userId = $('admGrantUser').value;
    var products = grantProductDropdown.getValue().map(findProduct).filter(Boolean);
    var u = USERS.filter(function (x) { return x.id === userId; })[0];
    if (!u || !products.length) return;
    var msg = $('admGrantMsg');
    var submitBtn = grantForm.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    // One grant call per product - admin-grant-product only ever writes a
    // single order+order_item (mirroring one real checkout), and granting
    // several products still needs to show up as several distinct
    // purchase-history rows, not one row claiming multiple items.
    var chain = products.reduce(function (p, product) {
      return p.then(function () {
        return invokeAdminFn('admin-grant-product', { userId: u.id, productId: product.dbId }, 'Could not grant "' + product.title + '".');
      });
    }, Promise.resolve());
    chain.then(function () {
      var names = products.map(function (p) { return p.title; }).join(', ');
      logAudit('Manually granted ' + names + ' to ' + u.name);
      if (msg) { msg.textContent = 'Granted ' + names + ' to ' + u.name + '.'; setTimeout(function () { msg.textContent = ''; }, 3000); }
      if (submitBtn) submitBtn.disabled = false;
      grantProductDropdown.setValue([]);
      renderGrantOwnershipWarning();
      return refreshOrders();
    }).catch(function (err) {
      if (submitBtn) submitBtn.disabled = false;
      if (msg) msg.textContent = err.message || 'Could not grant the product(s).';
    });
  });

  /* ================================================================
     SALES & DISCOUNTS PANEL (Sale Events + Discount Codes)
     ================================================================ */
  function buildScopeOptions() {
    var out = [{ value: 'sitewide', label: 'Sitewide' }];
    Object.keys(CATEGORIES_BY_PLATFORM).forEach(function (platform) {
      out.push({ value: 'platform:' + platform, label: platform + ' - All categories' });
      CATEGORIES_BY_PLATFORM[platform].forEach(function (cat) {
        out.push({ value: 'category:' + platform + ':' + cat, label: platform + ' - ' + cat });
      });
    });
    return out;
  }
  function parseScopeValue(value) {
    var parts = String(value || 'sitewide').split(':');
    if (parts[0] === 'platform') return { scope: 'platform', platform: parts[1], category: null };
    if (parts[0] === 'category') return { scope: 'category', platform: parts[1], category: parts.slice(2).join(':') };
    return { scope: 'sitewide', platform: null, category: null };
  }
  function scopeValueFor(item) {
    if (item.scope === 'platform') return 'platform:' + item.platform;
    if (item.scope === 'category') return 'category:' + item.platform + ':' + item.category;
    return 'sitewide';
  }
  function scopeLabel(item) {
    if (item.scope === 'platform') return item.platform;
    if (item.scope === 'category') return item.platform + ': ' + item.category;
    return 'Sitewide';
  }
  function productsInScope(scopeInfo) {
    return PRODUCTS_CACHE.filter(function (p) {
      if (scopeInfo.scope === 'platform') return p.platform === scopeInfo.platform;
      if (scopeInfo.scope === 'category') return p.platform === scopeInfo.platform && p.cat === scopeInfo.category;
      return true; // sitewide
    });
  }
  // Checked against product_legal (min_sale_usd / max_discount_pct /
  // disallow_sales) before a sale event or coupon can be saved, so a
  // broad-scope discount can never silently undercut a product's
  // contractual minimum price, exceed its allowed discount percentage, or
  // discount one explicitly marked as not-for-sale.
  function legalViolations(scopeInfo, discountedPriceFor) {
    var disallowed = [], belowMin = [], notFreeable = [], overMaxPct = [];
    productsInScope(scopeInfo).forEach(function (p) {
      var legal = p.legal || {};
      if (legal.disallowSales) { disallowed.push(p.title); return; }
      var discounted = discountedPriceFor(p.priceNum);
      if (discounted <= 0 && !legal.canBeFree) { notFreeable.push(p.title); return; }
      if (legal.minSaleUsd != null && discounted < Number(legal.minSaleUsd)) belowMin.push(p.title + ' (min $' + Number(legal.minSaleUsd).toFixed(2) + ')');
      var maxPct = Number(legal.maxDiscountPct) || 0;
      if (maxPct > 0 && p.priceNum > 0 && discounted < p.priceNum * (1 - maxPct / 100) - 0.001) {
        overMaxPct.push(p.title + ' (max ' + maxPct + '% off)');
      }
    });
    return { disallowed: disallowed, belowMin: belowMin, notFreeable: notFreeable, overMaxPct: overMaxPct,
      ok: !disallowed.length && !belowMin.length && !notFreeable.length && !overMaxPct.length };
  }
  function legalViolationMessage(v) {
    var parts = [];
    if (v.disallowed.length) parts.push(v.disallowed.length + ' product(s) marked "do not discount": ' + v.disallowed.slice(0, 5).join(', ') + (v.disallowed.length > 5 ? '…' : ''));
    if (v.notFreeable.length) parts.push(v.notFreeable.length + ' product(s) would be discounted to $0 but aren\'t allowed to be free: ' + v.notFreeable.slice(0, 5).join(', ') + (v.notFreeable.length > 5 ? '…' : ''));
    if (v.belowMin.length) parts.push(v.belowMin.length + ' product(s) would fall below their minimum sale price: ' + v.belowMin.slice(0, 5).join(', ') + (v.belowMin.length > 5 ? '…' : ''));
    if (v.overMaxPct && v.overMaxPct.length) parts.push(v.overMaxPct.length + ' product(s) would exceed their maximum allowed discount: ' + v.overMaxPct.slice(0, 5).join(', ') + (v.overMaxPct.length > 5 ? '…' : ''));
    return 'Can\'t save - ' + parts.join('; ') + '.';
  }

  var salesTypeToggle = $('admSalesTypeToggle');
  if (salesTypeToggle) salesTypeToggle.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-sales-type-btn'); if (!btn) return;
    var type = btn.getAttribute('data-type');
    salesTypeToggle.querySelectorAll('.adm-sales-type-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
    $('admSalesEventsView').hidden = type !== 'events';
    $('admDiscountCodesView').hidden = type !== 'codes';
    $('admBundleDealsView').hidden = type !== 'bundles';
    $('admHomepageView').hidden = type !== 'homepage';
    if (type === 'homepage') { renderHomepageTab(); loadWeeklyDealsSettings(); }
    if (type === 'bundles') { renderCuratedBundles(); renderBundleDeals(); }
  });

  /* Curated bundles - hand-built, permanent, public. admin-upsert-bundle. */
  function renderCuratedBundles() {
    var el = $('admCuratedBundlesBody'); if (!el) return;
    el.innerHTML = '<tr><td colspan="6" class="adm-empty">Loading…</td></tr>';
    invokeAdminFn('admin-upsert-bundle', { action: 'list' }, 'Could not load bundles.').then(function (data) {
      var rows = data.bundles || [];
      el.innerHTML = rows.map(function (b) {
        return '<tr data-token="' + esc(b.token) + '">' +
          '<td>' + esc(b.title || '') + '</td><td>' + esc(b.slug || '') + '</td>' +
          '<td>' + esc((b.slugs || []).join(', ')) + '</td>' +
          '<td>-' + esc(Math.round(b.bundle_pct)) + '%</td>' +
          '<td>' + (b.active ? '<span class="dt-badge ok">Active</span>' : '<span class="dt-badge">Off</span>') + '</td>' +
          '<td class="adm-row-actions"><button class="btn btn-ghost adm-btn-sm adm-bundle-edit" type="button">Edit</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-bundle-del" type="button">Delete</button></td></tr>';
      }).join('') || '<tr><td colspan="6" class="adm-empty">No curated bundles yet.</td></tr>';
    }).catch(function (err) { el.innerHTML = '<tr><td colspan="6" class="adm-empty">' + esc(err.message) + '</td></tr>'; });
  }
  var bundleForm = $('admBundleForm');
  if (bundleForm) {
    function resetBundleForm() {
      $('admBundleToken').value = ''; $('admBundleTitle').value = ''; $('admBundleSlug').value = '';
      $('admBundleImage').value = ''; $('admBundleDiscount').value = ''; $('admBundleProducts').value = '';
      $('admBundleActive').checked = true;
      $('admBundleFormTitle').textContent = 'New curated bundle';
      $('admBundleCancelBtn').hidden = true;
    }
    $('admBundleCancelBtn').addEventListener('click', resetBundleForm);
    bundleForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = $('admBundleMsg'); msg.textContent = 'Saving…';
      invokeAdminFn('admin-upsert-bundle', {
        action: 'upsert',
        token: $('admBundleToken').value || undefined,
        title: $('admBundleTitle').value,
        slug: $('admBundleSlug').value,
        image: $('admBundleImage').value,
        discountPct: Number($('admBundleDiscount').value),
        productSlugs: $('admBundleProducts').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        active: $('admBundleActive').checked
      }, 'Could not save.').then(function () {
        msg.textContent = 'Saved.'; resetBundleForm(); renderCuratedBundles();
      }).catch(function (err) { msg.textContent = err.message; });
    });
    $('admCuratedBundlesBody').addEventListener('click', async function (e) {
      var tr = e.target.closest('tr[data-token]'); if (!tr) return;
      var token = tr.getAttribute('data-token');
      if (e.target.closest('.adm-bundle-del')) {
        if (!(await dialogConfirm('Delete this bundle? This cannot be undone.', { title: 'Delete bundle', acceptLabel: 'Delete bundle' }))) return;
        invokeAdminFn('admin-upsert-bundle', { action: 'delete', token: token }, 'Delete failed.').then(renderCuratedBundles);
        return;
      }
      if (e.target.closest('.adm-bundle-edit')) {
        var tds = tr.querySelectorAll('td');
        $('admBundleToken').value = token;
        $('admBundleTitle').value = tds[0].textContent;
        $('admBundleSlug').value = tds[1].textContent;
        $('admBundleProducts').value = tds[2].textContent;
        $('admBundleDiscount').value = tds[3].textContent.replace(/[^0-9]/g, '');
        $('admBundleActive').checked = /Active/.test(tds[4].textContent);
        $('admBundleFormTitle').textContent = 'Edit bundle';
        $('admBundleCancelBtn').hidden = false;
        bundleForm.scrollIntoView({ block: 'center' });
      }
    });
  }

  /* Bundle deals are auto-minted (post-purchase upsell, wishlist
     reminder), never created by hand here - this tab is read-only
     visibility into what's currently active, not a form. Reads
     bundle_deals directly via RLS (bundle_deals_select_admin), same
     as coupons. */
  function renderBundleDeals() {
    var el = $('admBundleDealsBody'); if (!el || !window.coldSupabase) return;
    el.innerHTML = '<tr><td colspan="5" class="adm-empty">Loading…</td></tr>';
    window.coldSupabase.from('bundle_deals').select('*').order('created_at', { ascending: false }).limit(100).then(function (res) {
      if (res.error) { el.innerHTML = '<tr><td colspan="5" class="adm-empty">Could not load bundle deals.</td></tr>'; return; }
      var rows = res.data || [];
      var now = Date.now();
      el.innerHTML = rows.map(function (r) {
        var expired = r.expires_at && new Date(r.expires_at).getTime() < now;
        var expiresText = r.expires_at ? fmtDate(new Date(r.expires_at)) : 'Never';
        return '<tr' + (expired ? ' style="opacity:0.5;"' : '') + '>' +
          '<td>' + esc((r.slugs || []).join(', ')) + '</td>' +
          '<td>' + esc(r.item_pct) + '% / ' + esc(Number(r.item_pct) + Number(r.bundle_pct)) + '%</td>' +
          '<td>' + esc(r.source || '') + '</td>' +
          '<td>' + fmtDate(new Date(r.created_at)) + '</td>' +
          '<td>' + expiresText + (expired ? ' <span class="dt-badge">Expired</span>' : '') + '</td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="5" class="adm-empty">No bundle deals minted yet.</td></tr>';
    });
  }

  function callWeeklyDeals(action, productId) {
    var body = { action: action };
    if (productId) body.productId = productId;
    return invokeAdminFn('admin-weekly-deals', body, 'Request failed.');
  }
  function renderHomepageTab() {
    var products = allProducts();

    var featured = products.filter(function (p) { return p.featured; }).sort(function (a, b) { return a.featuredOrder - b.featuredOrder; });
    $('admFeaturedBody').innerHTML = featured.length ? featured.map(function (p) {
      return '<tr data-id="' + esc(p.id) + '"><td><input type="number" class="adm-input adm-input-sm adm-featured-order" min="0" step="1" value="' + p.featuredOrder + '" style="max-width:70px;" /></td><td>' + esc(p.title) + '</td><td>' + usd(p.price) + '</td>' +
        '<td class="adm-row-actions"><button class="btn btn-ghost adm-btn-sm adm-featured-remove" type="button" data-id="' + esc(p.id) + '">Remove</button></td></tr>';
    }).join('') : '<tr><td colspan="4" class="adm-empty">No featured products yet - add one below.</td></tr>';
    var notFeatured = products.filter(function (p) { return !p.featured; }).sort(function (a, b) { return a.title.localeCompare(b.title); });
    featuredAddDropdown.setOptions(notFeatured.map(function (p) { return { value: p.id, label: p.title }; }), '');

    var deals = products.filter(function (p) { return p.weeklyDeal; });
    $('admWeeklyDealsBody').innerHTML = deals.length ? deals.map(function (p) {
      return '<tr data-id="' + esc(p.id) + '"><td>' + esc(p.title) + '</td><td>' + usd(p.wasPrice) + '</td><td>' + usd(p.price) + '</td>' +
        '<td>-' + (p.weeklyDealPct != null ? p.weeklyDealPct : Math.round((1 - p.price / p.wasPrice) * 100)) + '%</td>' +
        '<td>' + (p.weeklyDealAuto ? 'Algorithm' : 'Manual') + '</td>' +
        '<td class="adm-row-actions">' +
          (p.weeklyDealAuto ? '<button class="btn btn-ghost adm-btn-sm adm-weekly-revert" type="button" data-id="' + esc(p.id) + '">Revert</button>' : '') +
          '<button class="btn btn-ghost adm-btn-sm adm-weekly-exclude" type="button" data-id="' + esc(p.id) + '">Exclude</button>' +
        '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="adm-empty">No active weekly deals right now.</td></tr>';

    var excluded = products.filter(function (p) { return p.weeklyDealExcluded; });
    $('admWeeklyExcludedCard').hidden = !excluded.length;
    $('admWeeklyExcludedBody').innerHTML = excluded.map(function (p) {
      return '<tr><td>' + esc(p.title) + '</td><td>' + usd(p.price) + '</td>' +
        '<td class="adm-row-actions"><button class="btn btn-ghost adm-btn-sm adm-weekly-include" type="button" data-id="' + esc(p.id) + '">Re-include</button></td></tr>';
    }).join('');
  }

  var featuredAddDropdown = makeDropdown($('admFeaturedAddDD'), {
    valueInput: $('admFeaturedAddId'), placeholder: 'Select a product', searchable: true
  });
  var featuredBody = $('admFeaturedBody');
  if (featuredBody) {
    featuredBody.addEventListener('click', function (e) {
      var btn = e.target.closest('.adm-featured-remove'); if (!btn) return;
      if (!can('admin')) return;
      var p = findProduct(btn.getAttribute('data-id')); if (!p) return;
      btn.disabled = true;
      callUpsertProduct(upsertPayloadFor(p, { featured: false, featuredOrder: 0 })).then(function () {
        return refreshProducts();
      }).then(function () {
        renderHomepageTab();
      }).catch(function (err) {
        btn.disabled = false;
        admToast(err.message || 'Could not remove from featured', false);
      });
    });
    featuredBody.addEventListener('change', function (e) {
      var input = e.target.closest('.adm-featured-order'); if (!input) return;
      if (!can('admin')) return;
      var row = input.closest('tr');
      var p = findProduct(row.getAttribute('data-id')); if (!p) return;
      var order = Math.max(0, parseInt(input.value, 10) || 0);
      callUpsertProduct(upsertPayloadFor(p, { featured: true, featuredOrder: order })).then(function () {
        return refreshProducts();
      }).then(function () {
        renderHomepageTab();
      }).catch(function (err) {
        admToast(err.message || 'Could not update order', false);
      });
    });
  }
  var featuredAddForm = $('admFeaturedAddForm');
  if (featuredAddForm) featuredAddForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var msg = $('admFeaturedMsg');
    var p = findProduct($('admFeaturedAddId').value);
    if (!p) { if (msg) msg.textContent = 'Pick a product first.'; return; }
    var maxOrder = allProducts().filter(function (x) { return x.featured; }).reduce(function (m, x) { return Math.max(m, x.featuredOrder || 0); }, -1);
    if (msg) msg.textContent = 'Adding…';
    callUpsertProduct(upsertPayloadFor(p, { featured: true, featuredOrder: maxOrder + 1 })).then(function () {
      return refreshProducts();
    }).then(function () {
      featuredAddDropdown.setValue('');
      if (msg) msg.textContent = '';
      renderHomepageTab();
    }).catch(function (err) {
      if (msg) msg.textContent = err.message || 'Could not add to featured.';
    });
  });

  function weeklyDealsAction(action, productId, btn) {
    if (!can('admin')) return;
    var msg = $('admWeeklyDealsMsg');
    var label = btn ? btn.querySelector('.btn-label') : null, spinner = btn ? btn.querySelector('.btn-spinner') : null;
    if (btn) { btn.disabled = true; if (label) label.hidden = true; if (spinner) spinner.hidden = false; }
    callWeeklyDeals(action, productId).then(function (res) {
      if (msg) msg.textContent = action === 'run' ? (res.picks && res.picks.length ? 'Picked: ' + res.picks.map(function (p) { return p.title + ' (-' + p.pct + '%)'; }).join(', ') : 'No eligible products found.') : 'Done.';
      return refreshProducts();
    }).then(function () {
      renderHomepageTab();
    }).catch(function (err) {
      if (msg) msg.textContent = err.message || 'Something went wrong.';
    }).then(function () {
      if (btn) { btn.disabled = false; if (label) label.hidden = false; if (spinner) spinner.hidden = true; }
    });
  }
  var weeklyDealsBody = $('admWeeklyDealsBody');
  if (weeklyDealsBody) weeklyDealsBody.addEventListener('click', function (e) {
    var revertBtn = e.target.closest('.adm-weekly-revert');
    var excludeBtn = e.target.closest('.adm-weekly-exclude');
    if (revertBtn) weeklyDealsAction('revert', revertBtn.getAttribute('data-id'), revertBtn);
    else if (excludeBtn) weeklyDealsAction('exclude', excludeBtn.getAttribute('data-id'), excludeBtn);
  });
  var weeklyExcludedBody = $('admWeeklyExcludedBody');
  if (weeklyExcludedBody) weeklyExcludedBody.addEventListener('click', function (e) {
    var includeBtn = e.target.closest('.adm-weekly-include'); if (!includeBtn) return;
    weeklyDealsAction('include', includeBtn.getAttribute('data-id'), includeBtn);
  });
  function loadWeeklyDealsSettings() {
    callWeeklyDeals('getSettings').then(function (res) {
      if ($('admWeeklyMaxPct')) $('admWeeklyMaxPct').value = res.maxDiscountPct;
      if ($('admWeeklyStepPct')) $('admWeeklyStepPct').value = res.discountStepPct;
      if ($('admWeeklyMaxPctLabel')) $('admWeeklyMaxPctLabel').textContent = res.maxDiscountPct;
    }).catch(function () {});
  }
  var weeklySettingsSaveBtn = $('admWeeklySettingsSave');
  if (weeklySettingsSaveBtn) weeklySettingsSaveBtn.addEventListener('click', function () {
    if (!can('admin')) return;
    var msg = $('admWeeklyDealsMsg');
    var label = weeklySettingsSaveBtn.querySelector('.btn-label'), spinner = weeklySettingsSaveBtn.querySelector('.btn-spinner');
    var maxDiscountPct = parseInt($('admWeeklyMaxPct').value, 10);
    var discountStepPct = parseInt($('admWeeklyStepPct').value, 10);
    weeklySettingsSaveBtn.disabled = true; if (label) label.hidden = true; if (spinner) spinner.hidden = false;
    invokeAdminFn('admin-weekly-deals', { action: 'updateSettings', maxDiscountPct: maxDiscountPct, discountStepPct: discountStepPct }, 'Request failed.').then(function () {
      if (msg) msg.textContent = 'Settings saved.';
      if ($('admWeeklyMaxPctLabel')) $('admWeeklyMaxPctLabel').textContent = maxDiscountPct;
    }).catch(function (err) {
      if (msg) msg.textContent = err.message || 'Something went wrong.';
    }).then(function () {
      weeklySettingsSaveBtn.disabled = false; if (label) label.hidden = false; if (spinner) spinner.hidden = true;
    });
  });
  var runNowBtn = $('admWeeklyDealsRunNow');
  if (runNowBtn) runNowBtn.addEventListener('click', function () { weeklyDealsAction('run', null, runNowBtn); });
  var revertAllBtn = $('admWeeklyDealsRevertAll');
  if (revertAllBtn) revertAllBtn.addEventListener('click', async function () {
    if (!(await dialogConfirm('Revert every algorithm-picked weekly deal back to its normal price?', { title: 'Revert weekly deals', acceptLabel: 'Revert deals' }))) return;
    weeklyDealsAction('revertAll', null, revertAllBtn);
  });

  var contentTypeToggle = $('admContentTypeToggle');
  if (contentTypeToggle) contentTypeToggle.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-content-type-btn'); if (!btn) return;
    var type = btn.getAttribute('data-type');
    contentTypeToggle.querySelectorAll('.adm-content-type-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
    $('admContentPostsView').hidden = type !== 'posts';
    $('admContentTutorialsView').hidden = type !== 'tutorials';
    $('admContentReleasesView').hidden = type !== 'releases';
  });

  var siteMgmtToggle = $('admSiteMgmtToggle');
  if (siteMgmtToggle) siteMgmtToggle.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-sitemgmt-btn'); if (!btn) return;
    var view = btn.getAttribute('data-view');
    siteMgmtToggle.querySelectorAll('.adm-sitemgmt-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
    $('admSiteMgmtAccessView').hidden = view !== 'access';
    $('admSiteMgmtRobloxView').hidden = view !== 'roblox';
    $('admSiteMgmtStaffView').hidden = view !== 'staff';
    $('admSiteMgmtUsersView').hidden = view !== 'users';
    $('admSiteMgmtAuditView').hidden = view !== 'audit';
  });

  /* ---- Sale Events ---- */
  function eventStatus(ev) {
    var today = new Date().toISOString().slice(0, 10);
    if (!ev.active) return 'inactive';
    if (today < ev.startDate) return 'scheduled';
    if (today > ev.endDate) return 'ended';
    return 'live';
  }
  var eventScopeDropdown = makeDropdown($('admEventScopeDD'), { valueInput: $('admEventScope') });
  eventScopeDropdown.setOptions(buildScopeOptions(), 'sitewide');

  function renderEvents() {
    $('admEventsBody').innerHTML = SALE_EVENTS.map(function (ev) {
      var status = eventStatus(ev);
      var badge = status === 'live' ? '<span class="dt-badge ok">Live now</span>' : status === 'scheduled' ? '<span class="dt-badge">Scheduled</span>' : status === 'ended' ? '<span class="dt-badge err">Ended</span>' : '<span class="dt-badge err">Inactive</span>';
      return '<tr data-id="' + ev.id + '"><td>' + esc(ev.title) + '</td><td>' + ev.percentOff + '% off</td><td>' + esc(scopeLabel(ev)) + '</td><td>' + esc(ev.startDate) + ' – ' + esc(ev.endDate) + '</td><td>' + badge + '</td>' +
        '<td class="adm-row-actions">' + (can('admin') ? '<button class="btn btn-ghost adm-btn-sm adm-event-edit" type="button">Edit</button><button class="btn btn-ghost adm-btn-sm adm-event-toggle" type="button">' + (ev.active ? 'Deactivate' : 'Activate') + '</button><button class="btn btn-ghost adm-btn-sm adm-event-del" type="button">Delete</button>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="adm-empty">No sale events yet.</td></tr>';
  }
  function resetEventForm() {
    $('admEventEditId').value = '';
    $('admEventTitle').value = ''; $('admEventMessage').value = ''; $('admEventPercent').value = '';
    eventScopeDropdown.setValue('sitewide');
    $('admEventStart').value = ''; $('admEventEnd').value = '';
    $('admEventFormTitle').textContent = 'Create sale event';
    $('admEventSubmitBtn').textContent = 'Create event';
    $('admEventCancelBtn').hidden = true;
  }
  function fillEventForm(ev) {
    $('admEventEditId').value = ev.id;
    $('admEventTitle').value = ev.title; $('admEventMessage').value = ev.message; $('admEventPercent').value = ev.percentOff;
    eventScopeDropdown.setValue(scopeValueFor(ev));
    $('admEventStart').value = ev.startDate; $('admEventEnd').value = ev.endDate;
    $('admEventFormTitle').textContent = 'Edit sale event';
    $('admEventSubmitBtn').textContent = 'Save changes';
    $('admEventCancelBtn').hidden = false;
  }
  var eventsBody = $('admEventsBody');
  if (eventsBody) eventsBody.addEventListener('click', async function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var ev = SALE_EVENTS.filter(function (x) { return x.id === id; })[0]; if (!ev) return;
    if (!can('admin')) return;
    if (e.target.classList.contains('adm-event-edit')) { fillEventForm(ev); }
    else if (e.target.classList.contains('adm-event-toggle')) {
      var newActive = !ev.active;
      var evData = Object.assign({}, ev); delete evData.id; delete evData.slug; delete evData.active;
      callUpsertContent('sale_event', ev.id, ev.slug, newActive, evData)
        .then(function () { logAudit((newActive ? 'Activated' : 'Deactivated') + ' sale event "' + ev.title + '"'); return refreshSaleEvents(); })
        .catch(function (err) { alert(err.message || 'Could not update sale event.'); });
    } else if (e.target.classList.contains('adm-event-del')) {
      if (!(await dialogConfirm('Delete “' + ev.title + '”? This cannot be undone.', { title: 'Delete sale event', acceptLabel: 'Delete event' }))) return;
      callDeleteContent(ev.id)
        .then(function () {
          logAudit('Deleted sale event "' + ev.title + '"');
          if ($('admEventEditId').value === id) resetEventForm();
          return refreshSaleEvents();
        })
        .catch(function (err) { alert(err.message || 'Could not delete sale event.'); });
    }
  });
  var eventCancelBtn = $('admEventCancelBtn');
  if (eventCancelBtn) eventCancelBtn.addEventListener('click', resetEventForm);
  var eventForm = $('admEventForm');
  if (eventForm) eventForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var id = $('admEventEditId').value;
    var scopeInfo = parseScopeValue($('admEventScope').value);
    var fields = {
      title: $('admEventTitle').value.trim(),
      message: $('admEventMessage').value.trim(),
      percentOff: Math.max(1, Math.min(90, parseInt($('admEventPercent').value, 10) || 0)),
      scope: scopeInfo.scope, platform: scopeInfo.platform, category: scopeInfo.category,
      startDate: $('admEventStart').value, endDate: $('admEventEnd').value
    };
    if (!fields.title || !fields.message || !fields.startDate || !fields.endDate) return;
    var pctOff = fields.percentOff;
    var violations = legalViolations(scopeInfo, function (price) { return price * (1 - pctOff / 100); });
    if (!violations.ok) { alert(legalViolationMessage(violations)); return; }
    var existing = id ? SALE_EVENTS.filter(function (x) { return x.id === id; })[0] : null;
    var active = existing ? existing.active : true;
    var slug = existing ? existing.slug : (fields.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sale') + '-' + Date.now().toString(36);
    callUpsertContent('sale_event', id || null, slug, active, fields)
      .then(function () {
        logAudit((existing ? 'Updated' : 'Created') + ' sale event "' + fields.title + '"');
        resetEventForm();
        return refreshSaleEvents();
      })
      .catch(function (err) { alert(err.message || 'Could not save sale event.'); });
  });

  /* ---- Discount Codes ---- */
  var couponTypeDropdown = makeDropdown($('admNewCouponTypeDD'), { valueInput: $('admNewCouponType') });
  couponTypeDropdown.setOptions([{ value: 'pct', label: '% off' }, { value: 'flat', label: '$ off' }], 'pct');
  var couponScopeDropdown = makeDropdown($('admCouponScopeDD'), { valueInput: $('admCouponScope') });
  couponScopeDropdown.setOptions(buildScopeOptions(), 'sitewide');

  function renderCoupons() {
    var cs = couponStats();
    $('admCouponsBody').innerHTML = COUPONS.map(function (c) {
      var stat = cs.filter(function (x) { return x.code === c.code; })[0] || { uses: 0, discountGiven: null };
      return '<tr data-code="' + esc(c.code) + '"><td class="dt-mono">' + esc(c.code) + '</td><td>' + (c.type === 'pct' ? c.val + '%' : usd(c.val)) + '</td><td>' + esc(scopeLabel(c)) + '</td><td>' + (c.expiresAt ? esc(c.expiresAt) : '–') + '</td><td>' + stat.uses + (c.limit ? ' / ' + c.limit : '') + '</td><td>' + (stat.discountGiven == null ? '–' : usd(stat.discountGiven)) + '</td>' +
        '<td>' + (c.active ? '<span class="dt-badge ok">Active</span>' : '<span class="dt-badge err">Inactive</span>') + '</td>' +
        '<td class="adm-row-actions">' + (can('admin') ? '<button class="btn btn-ghost adm-btn-sm adm-coupon-edit" type="button">Edit</button><button class="btn btn-ghost adm-btn-sm adm-coupon-toggle" type="button">' + (c.active ? 'Deactivate' : 'Activate') + '</button><button class="btn btn-ghost adm-btn-sm adm-coupon-del" type="button">Delete</button>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="8" class="adm-empty">No discount codes yet.</td></tr>';
  }
  function resetCouponForm() {
    $('admCouponEditId').value = '';
    $('admNewCouponCode').value = ''; $('admNewCouponVal').value = ''; $('admNewCouponLimit').value = '';
    $('admNewCouponExpiry').value = '';
    couponTypeDropdown.setValue('pct'); couponScopeDropdown.setValue('sitewide');
    $('admCouponFormTitle').textContent = 'Create discount code';
    $('admCouponSubmitBtn').textContent = 'Create discount code';
    $('admCouponCancelBtn').hidden = true;
  }
  function fillCouponForm(c) {
    $('admCouponEditId').value = c.code;
    $('admNewCouponCode').value = c.code; $('admNewCouponVal').value = c.val; $('admNewCouponLimit').value = c.limit || '';
    $('admNewCouponExpiry').value = c.expiresAt || '';
    couponTypeDropdown.setValue(c.type); couponScopeDropdown.setValue(scopeValueFor(c));
    $('admCouponFormTitle').textContent = 'Edit discount code';
    $('admCouponSubmitBtn').textContent = 'Save changes';
    $('admCouponCancelBtn').hidden = false;
  }
  function callUpsertCoupon(payload) {
    return invokeAdminFn('admin-upsert-coupon', payload, 'Could not save the code.');
  }
  function callDeleteCoupon(code) {
    return invokeAdminFn('admin-delete-coupon', { code: code }, 'Could not delete the code.');
  }
  var couponsBody = $('admCouponsBody');
  if (couponsBody) couponsBody.addEventListener('click', async function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var code = tr.getAttribute('data-code');
    var c = COUPONS.filter(function (x) { return x.code === code; })[0]; if (!c) return;
    if (!can('admin')) return;
    if (e.target.classList.contains('adm-coupon-edit')) { fillCouponForm(c); }
    else if (e.target.classList.contains('adm-coupon-toggle')) {
      var toggleBtn = e.target;
      toggleBtn.disabled = true;
      callUpsertCoupon({
        editingCode: c.code, code: c.code, type: c.type, val: c.val, active: !c.active,
        usageLimit: c.limit, expiresAt: c.expiresAt, scope: c.scope, platform: c.platform, category: c.category
      }).then(function () {
        logAudit((c.active ? 'Deactivated' : 'Activated') + ' coupon ' + code);
        return refreshCoupons();
      }).catch(function (err) {
        toggleBtn.disabled = false;
        alert(err.message || 'Could not update the code.');
      });
    } else if (e.target.classList.contains('adm-coupon-del')) {
      if (!(await dialogConfirm('Delete coupon ' + code + '? This cannot be undone.', { title: 'Delete coupon', acceptLabel: 'Delete coupon' }))) return;
      callDeleteCoupon(code).then(function () {
        logAudit('Deleted coupon ' + code);
        if ($('admCouponEditId').value === code) resetCouponForm();
        return refreshCoupons();
      }).catch(function (err) { alert(err.message || 'Could not delete the code.'); });
    }
  });
  var couponCancelBtn = $('admCouponCancelBtn');
  if (couponCancelBtn) couponCancelBtn.addEventListener('click', resetCouponForm);
  var addCouponForm = $('admAddCouponForm');
  if (addCouponForm) addCouponForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var editId = $('admCouponEditId').value;
    var code = $('admNewCouponCode').value.trim().toUpperCase();
    var type = $('admNewCouponType').value;
    var val = parseFloat($('admNewCouponVal').value) || 0;
    var limit = parseInt($('admNewCouponLimit').value, 10) || null;
    var expiresAt = $('admNewCouponExpiry').value || null;
    var scopeInfo = parseScopeValue($('admCouponScope').value);
    if (!code || !val) return;
    var couponViolations = legalViolations(scopeInfo, function (price) {
      return type === 'flat' ? Math.max(0, price - val) : price * (1 - val / 100);
    });
    if (!couponViolations.ok) { alert(legalViolationMessage(couponViolations)); return; }
    var submitBtn = $('admCouponSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;
    callUpsertCoupon({
      editingCode: editId || undefined, code: code, type: type, val: val, active: true,
      usageLimit: limit, expiresAt: expiresAt, scope: scopeInfo.scope, platform: scopeInfo.platform, category: scopeInfo.category
    }).then(function () {
      logAudit((editId ? 'Updated' : 'Created') + ' discount code ' + code);
      resetCouponForm();
      return refreshCoupons();
    }).catch(function (err) {
      alert(err.message || 'Could not save the code.');
    }).then(function () {
      if (submitBtn) submitBtn.disabled = false;
    });
  });

  /* ================================================================
     ROBLOX PANEL (container game pool that gamepasses get created in)
     ================================================================ */
  var ROBLOX_CONTAINERS = [];
  function refreshRobloxContainers() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('roblox_containers').select('*').order('created_at').then(function (res) {
      if (res.error) { console.error('[admin] failed to load roblox containers:', res.error.message); return; }
      ROBLOX_CONTAINERS = res.data || [];
      if (curPanel === 'sitemgmt') renderRobloxContainers();
      if (curPanel === 'home') renderHome();
    });
  }
  // Phase D fallback health - table may not exist yet if
  // roblox_cookie_health.sql hasn't been run, so a failed select here is
  // expected/harmless until then.
  var ROBLOX_COOKIE_BROKEN = false;
  function refreshRobloxCookieHealth() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('roblox_cookie_health').select('*').eq('id', true).maybeSingle().then(function (res) {
      ROBLOX_COOKIE_BROKEN = !!(res.data && !res.error && !res.data.ok);
      var el = $('admRobloxCookieWarning');
      if (el) {
        if (res.error || !res.data || res.data.ok) { el.hidden = true; }
        else { el.hidden = false; el.textContent = 'Robux fallback cookie is broken (' + (res.data.last_error || 'unknown error') + ') - refresh it, then update the ROBLOX_FALLBACK_COOKIE secret.'; }
      }
      if (curPanel === 'home') renderHome();
    });
  }
  /* ================================================================
     ROBUX POOL PANEL (shared leased-gamepass pool checkout draws from)
     ================================================================ */
  function refreshRobloxPool() {
    var body = $('admRobloxPoolBody'); if (!body) return Promise.resolve();
    return invokeAdminFn('admin-robux-pool', { action: 'stats' }, 'Could not load the pool.').then(function (data) {
      renderRobloxPool(data.stats, data.passes || []);
    }).catch(function (err) {
      var msg = $('admRobloxPoolMsg'); if (msg) msg.textContent = err.message;
    });
  }
  function renderRobloxPool(stats, passes) {
    stats = stats || { total: 0, free_now: 0, leased_now: 0 };
    var t = $('admRoboxPoolTotal'), f = $('admRoboxPoolFree'), l = $('admRoboxPoolLeased');
    if (t) t.textContent = stats.total;
    if (f) f.textContent = stats.free_now;
    if (l) l.textContent = stats.leased_now;
    var body = $('admRobloxPoolBody'); if (!body) return;
    if (!passes.length) { body.innerHTML = '<tr><td colspan="6" class="adm-empty">No pool passes yet - seed some to start.</td></tr>'; return; }
    body.innerHTML = passes.map(function (p) {
      var leased = p.leased_order_id && p.lease_expires_at && new Date(p.lease_expires_at).getTime() > Date.now();
      var state = !p.active ? 'Retired' : (leased ? 'Leased' : 'Free');
      var act = p.active
        ? '<button type="button" class="btn btn-ghost adm-btn-sm adm-pool-toggle" data-pool-action="retire" data-gamepass="' + esc(p.gamepass_id) + '">Retire</button>'
        : '<button type="button" class="btn btn-ghost adm-btn-sm adm-pool-toggle" data-pool-action="restore" data-gamepass="' + esc(p.gamepass_id) + '">Restore</button>';
      return '<tr>' +
        '<td><a href="https://www.roblox.com/game-pass/' + esc(p.gamepass_id) + '/" target="_blank" rel="noopener">' + esc(p.gamepass_id) + '</a></td>' +
        '<td>' + esc(p.universe_id) + '</td>' +
        '<td><span class="dt-badge ' + (state === 'Free' ? 'ok' : (state === 'Leased' ? 'warn' : 'err')) + '">' + state + '</span></td>' +
        '<td>' + (leased && p.lease_price_robux != null ? esc(p.lease_price_robux) + ' R$' : '–') + '</td>' +
        '<td>' + (leased ? new Date(p.lease_expires_at).toLocaleString() : '–') + '</td>' +
        '<td>' + act + '</td>' +
        '</tr>';
    }).join('');
  }
  var robloxPoolBodyEl = $('admRobloxPoolBody');
  if (robloxPoolBodyEl) robloxPoolBodyEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.adm-pool-toggle');
    if (!btn) return;
    var action = btn.getAttribute('data-pool-action');
    var gamepassId = btn.getAttribute('data-gamepass');
    var msg = $('admRobloxPoolMsg');
    btn.disabled = true;
    if (msg) msg.textContent = action === 'retire' ? 'Retiring pass…' : 'Restoring pass…';
    invokeAdminFn('admin-robux-pool', { action: action, gamepassId: gamepassId }, 'Could not update the pass.').then(function (data) {
      if (msg) msg.textContent = action === 'retire' ? 'Pass retired - it is out of the pool and off sale on Roblox.' : 'Pass restored to the pool.';
      logAudit((action === 'retire' ? 'Retired' : 'Restored') + ' Robux pool pass ' + gamepassId);
      renderRobloxPool(data.stats, data.passes || []);
    }).catch(function (err) {
      if (msg) msg.textContent = err.message;
      btn.disabled = false;
    });
  });
  var robloxPoolSeedForm = $('admRobloxPoolSeedForm');
  if (robloxPoolSeedForm) robloxPoolSeedForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var count = Math.max(1, Math.min(25, parseInt($('admRobloxPoolSeedCount').value, 10) || 5));
    var btn = $('admRobloxPoolSeedBtn'), msg = $('admRobloxPoolMsg');
    btn.disabled = true;
    if (msg) msg.textContent = 'Creating gamepasses on Roblox…';
    invokeAdminFn('admin-robux-pool', { action: 'seed', count: count }, 'Could not seed the pool.').then(function (data) {
      if (msg) msg.textContent = 'Created ' + data.created + ' of ' + count + ' requested pass' + (count === 1 ? '' : 'es') + (data.errors && data.errors.length ? ' - ' + data.errors[0] : '.');
      logAudit('Seeded ' + data.created + ' Robux pool pass(es)');
      return refreshRobloxPool();
    }).catch(function (err) {
      if (msg) msg.textContent = err.message;
    }).then(function () {
      btn.disabled = false;
    });
  });

  /* ================================================================
     SITE ACCESS PANEL (open / maintenance)
     ================================================================ */
  var siteMode = 'open';
  var SITE_MODE_COPY = {
    open: { status: 'Open', badge: 'ok', hint: 'Open: the storefront, checkout, and dashboard all work normally for every visitor.' },
    maintenance: { status: 'Maintenance', badge: 'warn', hint: 'Maintenance: every visitor except staff sees a maintenance page instead of the site - nothing can be bought or browsed until this is switched back to Open.' }
  };
  function applySiteModeUI(mode) {
    var copy = SITE_MODE_COPY[mode] || SITE_MODE_COPY.open;
    var cur = $('admSiteCurrentStatus');
    if (cur) { cur.textContent = copy.status; cur.className = 'dt-badge ' + copy.badge; }
    var modeHint = $('admSiteModeHint');
    if (modeHint) modeHint.textContent = copy.hint;
    document.querySelectorAll('.adm-site-mode-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    var maintFields = $('admSiteMaintFields');
    if (maintFields) maintFields.hidden = mode !== 'maintenance';
  }
  var testerAccessDropdown = makeDropdown($('admSiteTesterDD'), {
    valueInput: $('admSiteMaintAllowIds'), placeholder: 'Select testers', searchable: true, multi: true
  });
  function populateTesterOptions() {
    testerAccessDropdown.setOptions(
      USERS.map(function (u) { return { value: u.id, label: u.name + (u.email ? ' · ' + u.email : '') }; })
        .sort(function (a, b) { return a.label.localeCompare(b.label); }),
      testerAccessDropdown.getValue()
    );
  }
  function refreshSiteStatus() {
    if (!window.coldSupabase) return Promise.resolve();
    return Promise.all([
      window.coldSupabase.from('site_status').select('id, mode, maintenance_message, maintenance_ends_at, updated_at').eq('id', true).maybeSingle(),
      // The tester allowlist is not publicly readable; admins fetch it by RPC.
      window.coldSupabase.rpc('admin_maintenance_allowlist')
    ]).then(function (both) {
      var res = both[0];
      var data = res && res.data;
      if (data) data.maintenance_allow_user_ids = both[1] && !both[1].error && Array.isArray(both[1].data) ? both[1].data : [];
      siteMode = (data && data.mode) || 'open';
      applySiteModeUI(siteMode);
      if (data) {
        var msgEl = $('admSiteMaintMsg'); if (msgEl) msgEl.value = data.maintenance_message || '';
        var endsEl = $('admSiteMaintEnds');
        if (endsEl) endsEl.value = data.maintenance_ends_at ? toDatetimeLocalValue(new Date(data.maintenance_ends_at)) : '';
        var ids = Array.isArray(data.maintenance_allow_user_ids) ? data.maintenance_allow_user_ids : [];
        if (USERS.length) populateTesterOptions();
        testerAccessDropdown.setValue(ids, true);
      }
    });
  }
  document.querySelectorAll('.adm-site-mode-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      siteMode = b.getAttribute('data-mode');
      applySiteModeUI(siteMode);
    });
  });
  var admSiteSaveBtn = $('admSiteSaveBtn');
  if (admSiteSaveBtn) admSiteSaveBtn.addEventListener('click', function () {
    if (!can('owner')) { alert('Only the owner can change site access.'); return; }
    var msg = $('admSiteMaintMsg'), ends = $('admSiteMaintEnds');
    var testerIds = testerAccessDropdown.getValue();
    var payload = {
      mode: siteMode,
      message: msg ? msg.value.trim() : '',
      endsAt: ends && ends.value ? new Date(ends.value).toISOString() : null,
      allowUserIds: Array.isArray(testerIds) ? testerIds : []
    };
    admSiteSaveBtn.disabled = true;
    invokeAdminFn('admin-set-site-status', payload, 'Could not update site status.').then(function () {
      logAudit('Set site access to ' + siteMode);
      var m = $('admSiteMsg'); if (m) m.textContent = 'Saved.';
      return refreshSiteStatus();
    }).catch(function (err) {
      var m = $('admSiteMsg'); if (m) m.textContent = err.message || 'Could not save.';
    }).then(function () {
      admSiteSaveBtn.disabled = false;
    });
  });

  function callUpsertRobloxContainer(payload) {
    return invokeAdminFn('admin-upsert-roblox-container', payload, 'Save failed.');
  }
  function resetRobloxContainerForm() {
    $('admRobloxContainerEditId').value = '';
    $('admRobloxContainerUniverseId').value = '';
    $('admRobloxContainerLabel').value = '';
    $('admRobloxContainerFormTitle').textContent = 'Add container game';
    $('admRobloxContainerSubmitBtn').textContent = 'Add container';
    $('admRobloxContainerCancelBtn').hidden = true;
  }
  function renderRobloxContainers() {
    var body = $('admRobloxContainersBody'); if (!body) return;
    body.innerHTML = ROBLOX_CONTAINERS.map(function (c) {
      var full = c.gamepass_count >= 50;
      var statusBadge = !c.active ? '<span class="dt-badge warn">Disabled</span>' : full ? '<span class="dt-badge err">Full</span>' : '<span class="dt-badge ok">Open</span>';
      return '<tr data-id="' + esc(c.id) + '">' +
        '<td class="dt-mono">' + esc(c.universe_id) + '</td>' +
        '<td>' + esc(c.label || '') + '</td>' +
        '<td>' + c.gamepass_count + ' / 50</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td class="adm-row-actions">' +
          '<button class="btn btn-ghost adm-btn-sm adm-roblox-edit" type="button">Edit</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-roblox-toggle" type="button">' + (c.active ? 'Disable' : 'Enable') + '</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="adm-empty">No container games registered yet.</td></tr>';
  }
  var robloxContainersBody = $('admRobloxContainersBody');
  if (robloxContainersBody) robloxContainersBody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var c = ROBLOX_CONTAINERS.filter(function (x) { return x.id === id; })[0]; if (!c) return;
    if (e.target.classList.contains('adm-roblox-edit')) {
      $('admRobloxContainerEditId').value = c.id;
      $('admRobloxContainerUniverseId').value = c.universe_id;
      $('admRobloxContainerLabel').value = c.label || '';
      $('admRobloxContainerFormTitle').textContent = 'Edit container game';
      $('admRobloxContainerSubmitBtn').textContent = 'Save changes';
      $('admRobloxContainerCancelBtn').hidden = false;
    } else if (e.target.classList.contains('adm-roblox-toggle')) {
      callUpsertRobloxContainer({ id: c.id, universeId: c.universe_id, label: c.label, active: !c.active }).then(function () {
        logAudit((c.active ? 'Disabled' : 'Enabled') + ' Roblox container ' + c.universe_id);
        return refreshRobloxContainers();
      }).catch(function (err) { alert(err.message || 'Could not update the container.'); });
    }
  });
  var robloxContainerCancelBtn = $('admRobloxContainerCancelBtn');
  if (robloxContainerCancelBtn) robloxContainerCancelBtn.addEventListener('click', resetRobloxContainerForm);
  var robloxContainerForm = $('admRobloxContainerForm');
  if (robloxContainerForm) robloxContainerForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var editId = $('admRobloxContainerEditId').value;
    var universeId = $('admRobloxContainerUniverseId').value.trim();
    var label = $('admRobloxContainerLabel').value.trim();
    if (!universeId) return;
    var submitBtn = $('admRobloxContainerSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;
    callUpsertRobloxContainer({ id: editId || undefined, universeId: universeId, label: label, active: true }).then(function () {
      logAudit((editId ? 'Updated' : 'Added') + ' Roblox container ' + universeId);
      resetRobloxContainerForm();
      return refreshRobloxContainers();
    }).catch(function (err) {
      var msg = $('admRobloxContainerMsg'); if (msg) msg.textContent = err.message || 'Could not save the container.';
    }).then(function () {
      if (submitBtn) submitBtn.disabled = false;
    });
  });

  // Shared by the Posts and Tutorials forms - read/tutorial time is
  // computed from the body's word count (200 wpm) instead of typed in by
  // hand, so it can't drift out of sync with the actual content.
  function estimateReadMins(text) {
    var words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.ceil(words / 200));
  }
  var postBodyInput = $('admNewPostBody');
  if (postBodyInput) postBodyInput.addEventListener('input', function () { $('admNewPostRead').value = estimateReadMins(postBodyInput.value); });
  var tutBodyInput = $('admNewTutBody');
  if (tutBodyInput) tutBodyInput.addEventListener('input', function () { $('admNewTutMins').value = estimateReadMins(tutBodyInput.value); });

  /* ================================================================
     BLOG POSTS PANEL
     ================================================================ */
  var POSTS = [];
  function mapContentRow(row) { return Object.assign({ id: row.id, slug: row.slug, visible: row.visible }, row.data || {}); }
  function refreshPosts() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('content').select('*').eq('type', 'post').order('created_at', { ascending: false }).then(function (res) {
      if (res.error) { console.error('[admin] failed to load posts:', res.error.message); return; }
      POSTS = (res.data || []).map(mapContentRow);
      if (curPanel === 'content') renderPosts();
    });
  }
  function callUpsertContent(type, id, slug, visible, data) {
    return invokeAdminFn('admin-upsert-content', { id: id || null, type: type, slug: slug, visible: visible, data: data }, 'Could not save.');
  }
  function callDeleteContent(id) {
    return invokeAdminFn('admin-delete-content', { id: id }, 'Could not delete.');
  }
  function renderPosts() {
    var q = ($('admPostSearch') || {}).value || '';
    q = q.trim().toLowerCase();
    var rows = POSTS.filter(function (p) { return !q || p.title.toLowerCase().indexOf(q) >= 0; });
    $('admPostBody').innerHTML = rows.map(function (p) {
      return '<tr data-id="' + esc(p.id) + '">' +
        '<td>' + esc(p.title) + '</td>' +
        '<td>' + esc(p.category) + '</td>' +
        '<td>' + esc(p.author) + '</td>' +
        '<td>' + esc(p.date) + '</td>' +
        '<td>' + (p.visible ? '<span class="dt-badge ok">Published</span>' : '<span class="dt-badge err">Draft</span>') + '</td>' +
        '<td class="adm-row-actions">' +
          '<button class="btn btn-ghost adm-btn-sm adm-post-edit" type="button"' + (can('admin') ? '' : ' disabled') + '>Edit</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-post-toggle" type="button"' + (can('admin') ? '' : ' disabled') + '>' + (p.visible ? 'Unpublish' : 'Publish') + '</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-post-del" type="button"' + (can('admin') ? '' : ' disabled') + '>Delete</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="adm-empty">No posts yet.</td></tr>';
  }
  var postCategoryDropdown = makeDropdown($('admNewPostCategoryDD'), { valueInput: $('admNewPostCategory') });
  postCategoryDropdown.setOptions(['Devlog', 'Studio News', 'Craft'], 'Devlog');
  function fillPostForm(p) {
    $('admPostEditId').value = p.id;
    $('admNewPostTitle').value = p.title;
    postCategoryDropdown.setValue(p.category);
    $('admNewPostAuthor').value = p.author;
    $('admNewPostDate').value = p.date;
    $('admNewPostCover').value = p.cover;
    $('admNewPostDek').value = p.dek;
    $('admNewPostBody').value = p.body;
    $('admNewPostRead').value = estimateReadMins(p.body);
    $('admNewPostPublished').checked = p.visible;
    $('admPostFormTitle').textContent = 'Edit post';
    $('admPostFormSubmit').textContent = 'Save changes';
    $('admPostFormCancel').hidden = false;
  }
  function resetPostForm() {
    $('admAddPostForm').reset();
    postCategoryDropdown.setValue('Devlog');
    $('admPostEditId').value = '';
    $('admPostFormTitle').textContent = 'Add post';
    $('admPostFormSubmit').textContent = 'Add post';
    $('admPostFormCancel').hidden = true;
  }
  var postBody = $('admPostBody');
  if (postBody) postBody.addEventListener('click', async function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var p = POSTS.filter(function (x) { return x.id === id; })[0]; if (!p) return;
    if (e.target.classList.contains('adm-post-edit')) {
      if (!can('admin')) return;
      fillPostForm(p);
    } else if (e.target.classList.contains('adm-post-toggle')) {
      if (!can('admin')) return;
      var newVisible = !p.visible;
      var postData = Object.assign({}, p); delete postData.id; delete postData.slug; delete postData.visible;
      callUpsertContent('post', p.id, p.slug, newVisible, postData)
        .then(function () { logAudit((newVisible ? 'Published' : 'Unpublished') + ' post "' + p.title + '"'); return refreshPosts(); })
        .catch(function (err) { alert(err.message || 'Could not update post.'); });
    } else if (e.target.classList.contains('adm-post-del')) {
      if (!can('admin')) return;
      if (!(await dialogConfirm('Delete “' + p.title + '”? This cannot be undone.', { title: 'Delete post', acceptLabel: 'Delete post' }))) return;
      callDeleteContent(p.id)
        .then(function () { logAudit('Deleted post "' + p.title + '"'); return refreshPosts(); })
        .catch(function (err) { alert(err.message || 'Could not delete post.'); });
    }
  });
  var postSearch = $('admPostSearch');
  if (postSearch) postSearch.addEventListener('input', renderPosts);
  var postCancelBtn = $('admPostFormCancel');
  if (postCancelBtn) postCancelBtn.addEventListener('click', resetPostForm);
  var addPostForm = $('admAddPostForm');
  if (addPostForm) addPostForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var title = $('admNewPostTitle').value.trim();
    if (!title) return;
    var editId = $('admPostEditId').value;
    var existing = editId ? POSTS.filter(function (x) { return x.id === editId; })[0] : null;
    var visible = $('admNewPostPublished').checked;
    var data = {
      title: title,
      category: $('admNewPostCategory').value,
      author: $('admNewPostAuthor').value.trim() || 'coldd',
      date: $('admNewPostDate').value,
      readMins: estimateReadMins($('admNewPostBody').value),
      cover: $('admNewPostCover').value.trim() || '/banner.jpg',
      dek: $('admNewPostDek').value.trim(),
      body: $('admNewPostBody').value,
      tags: existing ? existing.tags : [],
      featured: existing ? existing.featured : false
    };
    var slug = existing ? existing.slug : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    callUpsertContent('post', editId || null, slug, visible, data)
      .then(function () {
        logAudit((existing ? 'Edited' : 'Added') + ' post "' + title + '"');
        resetPostForm();
        return refreshPosts();
      })
      .catch(function (err) { alert(err.message || 'Could not save post.'); });
  });

  /* ================================================================
     TUTORIALS PANEL
     ================================================================ */
  var TUTORIALS = [];
  function refreshTutorials() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('content').select('*').eq('type', 'tutorial').order('created_at', { ascending: false }).then(function (res) {
      if (res.error) { console.error('[admin] failed to load tutorials:', res.error.message); return; }
      TUTORIALS = (res.data || []).map(mapContentRow);
      if (curPanel === 'content') renderTutorials();
    });
  }
  function renderTutorials() {
    var q = ($('admTutSearch') || {}).value || '';
    q = q.trim().toLowerCase();
    var rows = TUTORIALS.filter(function (t) { return !q || t.title.toLowerCase().indexOf(q) >= 0; });
    $('admTutBody').innerHTML = rows.map(function (t) {
      return '<tr data-id="' + esc(t.id) + '">' +
        '<td>' + esc(t.title) + '</td>' +
        '<td>' + esc(t.track) + '</td>' +
        '<td>' + esc(t.difficulty) + '</td>' +
        '<td>' + esc(t.platform) + '</td>' +
        '<td>' + t.order + '</td>' +
        '<td>' + (t.visible ? '<span class="dt-badge ok">Published</span>' : '<span class="dt-badge err">Draft</span>') + '</td>' +
        '<td class="adm-row-actions">' +
          '<button class="btn btn-ghost adm-btn-sm adm-tut-edit" type="button"' + (can('admin') ? '' : ' disabled') + '>Edit</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-tut-toggle" type="button"' + (can('admin') ? '' : ' disabled') + '>' + (t.visible ? 'Unpublish' : 'Publish') + '</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-tut-del" type="button"' + (can('admin') ? '' : ' disabled') + '>Delete</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="adm-empty">No tutorials yet.</td></tr>';
  }
  var tutTrackDropdown = makeDropdown($('admNewTutTrackDD'), { valueInput: $('admNewTutTrack') });
  tutTrackDropdown.setOptions(['Scripting', 'Building', 'Server Setup'], 'Scripting');
  var tutDifficultyDropdown = makeDropdown($('admNewTutDifficultyDD'), { valueInput: $('admNewTutDifficulty') });
  tutDifficultyDropdown.setOptions(['Beginner', 'Intermediate', 'Advanced'], 'Beginner');
  var tutPlatformDropdown = makeDropdown($('admNewTutPlatformDD'), { valueInput: $('admNewTutPlatform') });
  tutPlatformDropdown.setOptions(['Roblox'], 'Roblox');
  function fillTutForm(t) {
    $('admTutEditId').value = t.id;
    $('admNewTutTitle').value = t.title;
    tutTrackDropdown.setValue(t.track);
    tutDifficultyDropdown.setValue(t.difficulty);
    tutPlatformDropdown.setValue(t.platform);
    $('admNewTutOrder').value = t.order;
    $('admNewTutCover').value = t.cover;
    $('admNewTutVideo').value = t.video || '';
    $('admNewTutSummary').value = t.summary;
    $('admNewTutBody').value = t.body;
    $('admNewTutMins').value = estimateReadMins(t.body);
    $('admNewTutPublished').checked = t.visible;
    $('admTutFormTitle').textContent = 'Edit tutorial';
    $('admTutFormSubmit').textContent = 'Save changes';
    $('admTutFormCancel').hidden = false;
  }
  function resetTutForm() {
    $('admAddTutForm').reset();
    tutTrackDropdown.setValue('Scripting'); tutDifficultyDropdown.setValue('Beginner'); tutPlatformDropdown.setValue('Roblox');
    $('admTutEditId').value = '';
    $('admTutFormTitle').textContent = 'Add tutorial';
    $('admTutFormSubmit').textContent = 'Add tutorial';
    $('admTutFormCancel').hidden = true;
  }
  var tutBody = $('admTutBody');
  if (tutBody) tutBody.addEventListener('click', async function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var t = TUTORIALS.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    if (e.target.classList.contains('adm-tut-edit')) {
      if (!can('admin')) return;
      fillTutForm(t);
    } else if (e.target.classList.contains('adm-tut-toggle')) {
      if (!can('admin')) return;
      var newVisible = !t.visible;
      var tutData = Object.assign({}, t); delete tutData.id; delete tutData.slug; delete tutData.visible;
      callUpsertContent('tutorial', t.id, t.slug, newVisible, tutData)
        .then(function () { logAudit((newVisible ? 'Published' : 'Unpublished') + ' tutorial "' + t.title + '"'); return refreshTutorials(); })
        .catch(function (err) { alert(err.message || 'Could not update tutorial.'); });
    } else if (e.target.classList.contains('adm-tut-del')) {
      if (!can('admin')) return;
      if (!(await dialogConfirm('Delete “' + t.title + '”? This cannot be undone.', { title: 'Delete tutorial', acceptLabel: 'Delete tutorial' }))) return;
      callDeleteContent(t.id)
        .then(function () { logAudit('Deleted tutorial "' + t.title + '"'); return refreshTutorials(); })
        .catch(function (err) { alert(err.message || 'Could not delete tutorial.'); });
    }
  });
  var tutSearch = $('admTutSearch');
  if (tutSearch) tutSearch.addEventListener('input', renderTutorials);
  var tutCancelBtn = $('admTutFormCancel');
  if (tutCancelBtn) tutCancelBtn.addEventListener('click', resetTutForm);
  var addTutForm = $('admAddTutForm');
  if (addTutForm) addTutForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var title = $('admNewTutTitle').value.trim();
    if (!title) return;
    var editId = $('admTutEditId').value;
    var existing = editId ? TUTORIALS.filter(function (x) { return x.id === editId; })[0] : null;
    var visible = $('admNewTutPublished').checked;
    var data = {
      title: title,
      track: $('admNewTutTrack').value,
      difficulty: $('admNewTutDifficulty').value,
      platform: $('admNewTutPlatform').value,
      order: parseInt($('admNewTutOrder').value, 10) || 1,
      estMins: estimateReadMins($('admNewTutBody').value),
      cover: $('admNewTutCover').value.trim() || '/scripts.jpg',
      video: $('admNewTutVideo').value.trim(),
      summary: $('admNewTutSummary').value.trim(),
      body: $('admNewTutBody').value
    };
    var slug = existing ? existing.slug : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    callUpsertContent('tutorial', editId || null, slug, visible, data)
      .then(function () {
        logAudit((existing ? 'Edited' : 'Added') + ' tutorial "' + title + '"');
        resetTutForm();
        return refreshTutorials();
      })
      .catch(function (err) { alert(err.message || 'Could not save tutorial.'); });
  });

  /* ================================================================
     RELEASES PANEL
     ================================================================ */
  var RELEASES = [];
  function refreshReleases() {
    if (!window.coldSupabase) return Promise.resolve();
    return window.coldSupabase.from('content').select('*').eq('type', 'release').order('created_at', { ascending: false }).then(function (res) {
      if (res.error) { console.error('[admin] failed to load releases:', res.error.message); return; }
      RELEASES = (res.data || []).map(mapContentRow);
      if (curPanel === 'content') renderReleases();
    });
  }
  function renderReleases() {
    var q = ($('admRelSearch') || {}).value || '';
    q = q.trim().toLowerCase();
    var rows = RELEASES.filter(function (r) { return !q || r.title.toLowerCase().indexOf(q) >= 0; });
    $('admRelBody').innerHTML = rows.map(function (r) {
      return '<tr data-id="' + esc(r.id) + '">' +
        '<td class="dt-mono">' + esc(r.version || '–') + '</td>' +
        '<td>' + esc(r.kind) + '</td>' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(r.date) + '</td>' +
        '<td>' + (r.visible ? '<span class="dt-badge ok">Published</span>' : '<span class="dt-badge err">Draft</span>') + '</td>' +
        '<td class="adm-row-actions">' +
          '<button class="btn btn-ghost adm-btn-sm adm-rel-edit" type="button"' + (can('admin') ? '' : ' disabled') + '>Edit</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-rel-toggle" type="button"' + (can('admin') ? '' : ' disabled') + '>' + (r.visible ? 'Unpublish' : 'Publish') + '</button>' +
          '<button class="btn btn-ghost adm-btn-sm adm-rel-del" type="button"' + (can('admin') ? '' : ' disabled') + '>Delete</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="adm-empty">No releases yet.</td></tr>';
  }
  var relKindDropdown = makeDropdown($('admNewRelKindDD'), { valueInput: $('admNewRelKind') });
  relKindDropdown.setOptions(['Feature', 'Fix', 'Announcement'], 'Feature');
  function fillRelForm(r) {
    $('admRelEditId').value = r.id;
    $('admNewRelVersion').value = r.version || '';
    relKindDropdown.setValue(r.kind);
    $('admNewRelTitle').value = r.title;
    $('admNewRelDate').value = r.date;
    $('admNewRelAffects').value = (r.affects || []).join(', ');
    $('admNewRelSummary').value = r.summary;
    $('admNewRelPublished').checked = r.visible;
    $('admRelFormTitle').textContent = 'Edit release';
    $('admRelFormSubmit').textContent = 'Save changes';
    $('admRelFormCancel').hidden = false;
  }
  function resetRelForm() {
    $('admAddRelForm').reset();
    relKindDropdown.setValue('Feature');
    $('admRelEditId').value = '';
    $('admRelFormTitle').textContent = 'Add release';
    $('admRelFormSubmit').textContent = 'Add release';
    $('admRelFormCancel').hidden = true;
  }
  var relBody = $('admRelBody');
  if (relBody) relBody.addEventListener('click', async function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var r = RELEASES.filter(function (x) { return x.id === id; })[0]; if (!r) return;
    if (e.target.classList.contains('adm-rel-edit')) {
      if (!can('admin')) return;
      fillRelForm(r);
    } else if (e.target.classList.contains('adm-rel-toggle')) {
      if (!can('admin')) return;
      var newVisible = !r.visible;
      var relData = Object.assign({}, r); delete relData.id; delete relData.slug; delete relData.visible;
      callUpsertContent('release', r.id, r.slug, newVisible, relData)
        .then(function () { logAudit((newVisible ? 'Published' : 'Unpublished') + ' release "' + r.title + '"'); return refreshReleases(); })
        .catch(function (err) { alert(err.message || 'Could not update release.'); });
    } else if (e.target.classList.contains('adm-rel-del')) {
      if (!can('admin')) return;
      if (!(await dialogConfirm('Delete “' + r.title + '”? This cannot be undone.', { title: 'Delete release', acceptLabel: 'Delete release' }))) return;
      callDeleteContent(r.id)
        .then(function () { logAudit('Deleted release "' + r.title + '"'); return refreshReleases(); })
        .catch(function (err) { alert(err.message || 'Could not delete release.'); });
    }
  });
  var relSearch = $('admRelSearch');
  if (relSearch) relSearch.addEventListener('input', renderReleases);
  var relCancelBtn = $('admRelFormCancel');
  if (relCancelBtn) relCancelBtn.addEventListener('click', resetRelForm);
  var addRelForm = $('admAddRelForm');
  if (addRelForm) addRelForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('admin')) return;
    var title = $('admNewRelTitle').value.trim();
    if (!title) return;
    var editId = $('admRelEditId').value;
    var existing = editId ? RELEASES.filter(function (x) { return x.id === editId; })[0] : null;
    var visible = $('admNewRelPublished').checked;
    var data = {
      version: $('admNewRelVersion').value.trim(),
      kind: $('admNewRelKind').value,
      title: title,
      date: $('admNewRelDate').value,
      affects: $('admNewRelAffects').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      summary: $('admNewRelSummary').value.trim(),
      details: ''
    };
    var slug = existing ? existing.slug : (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'release') + '-' + Date.now().toString(36);
    callUpsertContent('release', editId || null, slug, visible, data)
      .then(function () {
        logAudit((existing ? 'Edited' : 'Added') + ' release "' + title + '"');
        resetRelForm();
        return refreshReleases();
      })
      .catch(function (err) { alert(err.message || 'Could not save release.'); });
  });

  /* ================================================================
     STAFF PANEL - real, backed by profiles.is_admin/role. All writes go
     through admin-set-staff-role (service role, requires the CALLER to
     be an owner, refuses self-changes).
     ================================================================ */
  var ADM_DD_CHEV = '<svg class="adm-dd-chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  function callSetStaffRole(email, role) {
    return invokeAdminFn('admin-set-staff-role', { email: email, role: role }, 'Could not update staff access.');
  }
  function renderStaff() {
    $('admStaffBody').innerHTML = STAFF.map(function (s) {
      var isSelf = s.id === (window.__ADMIN_ID || null);
      var editable = can('owner') && !isSelf;
      var roleMenu = ['owner', 'admin', 'support'].map(function (r) {
        return '<button type="button" class="adm-dd-opt' + (r === s.role ? ' active' : '') + '" data-value="' + r + '" role="option" aria-selected="' + (r === s.role ? 'true' : 'false') + '"><span>' + r + '</span><span class="adm-dd-radio"></span></button>';
      }).join('');
      return '<tr data-id="' + s.id + '" data-email="' + esc(s.email || '') + '"><td>' + esc(s.name) + (isSelf ? ' <span class="adm-sub">(you)</span>' : '') + '</td><td class="dt-mono">' + esc(s.email || '–') + '</td>' +
        '<td><div class="adm-dd adm-dd-inline adm-staff-role-dd"' + (editable ? '' : ' data-disabled="1"') + '>' +
          '<button type="button" class="adm-dd-btn"' + (editable ? '' : ' disabled') + ' aria-haspopup="listbox" aria-expanded="false"><span class="adm-dd-val">' + esc(s.role) + '</span>' + ADM_DD_CHEV + '</button>' +
          '<div class="adm-dd-menu" role="listbox" aria-label="Role" hidden>' + roleMenu + '</div>' +
        '</div></td>' +
        '<td class="adm-row-actions">' + (editable ? '<button class="btn btn-ghost adm-btn-sm adm-staff-remove" type="button">Revoke access</button>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="adm-empty">No staff yet.</td></tr>';
  }
  var staffBody = $('admStaffBody');
  if (staffBody) staffBody.addEventListener('click', async function (e) {
    var ddBtn = e.target.closest('.adm-staff-role-dd .adm-dd-btn');
    if (ddBtn) {
      if (ddBtn.disabled) return;
      var dd = ddBtn.closest('.adm-staff-role-dd');
      var menu = dd.querySelector('.adm-dd-menu');
      var wasOpen = !menu.hidden;
      staffBody.querySelectorAll('.adm-staff-role-dd').forEach(function (d) { d.classList.remove('open'); d.querySelector('.adm-dd-menu').hidden = true; });
      if (!wasOpen) { dd.classList.add('open'); menu.hidden = false; }
      return;
    }
    var opt = e.target.closest('.adm-staff-role-dd .adm-dd-opt');
    if (opt) {
      if (!can('owner')) return;
      var tr = opt.closest('tr'); var id = tr.getAttribute('data-id'), email = tr.getAttribute('data-email');
      var s = STAFF.filter(function (x) { return x.id === id; })[0]; if (!s || !email) return;
      var newRole = opt.getAttribute('data-value');
      callSetStaffRole(email, newRole)
        .then(function () { logAudit('Changed ' + s.name + '\'s role to ' + newRole); return refreshStaff(); })
        .catch(function (err) { alert(err.message || 'Could not update role.'); });
      return;
    }
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('.adm-staff-role-dd')) return;
    document.querySelectorAll('.adm-staff-role-dd.open').forEach(function (d) { d.classList.remove('open'); d.querySelector('.adm-dd-menu').hidden = true; });
  });
  if (staffBody) staffBody.addEventListener('click', async function (e) {
    if (!e.target.classList.contains('adm-staff-remove')) return;
    if (!can('owner')) return;
    var tr = e.target.closest('tr'); var id = tr.getAttribute('data-id'), email = tr.getAttribute('data-email');
    var s = STAFF.filter(function (x) { return x.id === id; })[0]; if (!s || !email) return;
    if (!(await dialogConfirm('Revoke ' + s.name + '\'s staff access?', { title: 'Revoke staff access', acceptLabel: 'Revoke access' }))) return;
    callSetStaffRole(email, null)
      .then(function () { logAudit('Revoked staff access for ' + s.name); return refreshStaff(); })
      .catch(function (err) { alert(err.message || 'Could not revoke access.'); });
  });
  var newStaffRoleDropdown = makeDropdown($('admNewStaffRoleDD'), { valueInput: $('admNewStaffRole') });
  newStaffRoleDropdown.setOptions([
    { value: 'support', label: 'Support agent' },
    { value: 'admin', label: 'Admin' },
    { value: 'owner', label: 'Owner' }
  ], 'support');
  var addStaffForm = $('admAddStaffForm');
  if (addStaffForm) addStaffForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!can('owner')) return;
    var email = $('admNewStaffEmail').value.trim();
    var role = $('admNewStaffRole').value;
    var msgEl = $('admStaffMsg');
    if (!email) return;
    callSetStaffRole(email, role).then(function (data) {
      logAudit('Granted ' + (data.username || email) + ' staff access (' + role + ')');
      addStaffForm.reset(); newStaffRoleDropdown.setValue('support', true);
      if (msgEl) { msgEl.className = 'co-msg show'; msgEl.textContent = 'Access granted.'; }
      return refreshStaff();
    }).catch(function (err) {
      if (msgEl) { msgEl.className = 'co-msg err show'; msgEl.textContent = err.message || 'Could not grant access.'; }
    });
  });

  /* ================================================================
     AUDIT LOG PANEL
     ================================================================ */
  var auditQuery = '', auditActor = '', auditType = '';

  // errKind -> label for the type filter and the row rendering.
  var AUDIT_ERR_KINDS = {
    js_error: 'JS error',
    unhandled_rejection: 'Unhandled rejection',
    edge_function: 'Edge function',
    checkout: 'Checkout',
    robux_checkout: 'Robux checkout'
  };

  // Declared before renderAudit() runs; makeDropdown returns a no-op shim if
  // the element is missing, so this is safe even on a stripped page.
  var auditActorDropdown = makeDropdown($('admAuditActorDD'), {
    valueInput: $('admAuditActor'),
    placeholder: 'All staff',
    onChange: function (v) { auditActor = v || ''; renderAudit(); }
  });
  var auditTypeDropdown = makeDropdown($('admAuditTypeDD'), {
    valueInput: $('admAuditType'),
    placeholder: 'All activity',
    onChange: function (v) { auditType = v || ''; renderAudit(); }
  });
  if (auditTypeDropdown) {
    auditTypeDropdown.setOptions([
      { value: '', label: 'All activity' },
      { value: 'staff', label: 'Staff actions' },
      { value: 'error', label: 'All errors' },
      { value: 'err:js_error', label: '— JS errors' },
      { value: 'err:unhandled_rejection', label: '— Unhandled rejections' },
      { value: 'err:edge_function', label: '— Edge function' },
      { value: 'err:checkout', label: '— Checkout' },
      { value: 'err:robux_checkout', label: '— Robux checkout' }
    ]);
  }
  if ($('admAuditSearch')) {
    $('admAuditSearch').addEventListener('input', function (e) {
      auditQuery = e.target.value.trim();
      renderAudit();
    });
  }

  function renderAudit() {
    var warn = $('admAuditWarn');
    if (warn) {
      warn.hidden = !AUDIT_PERSIST_ERROR;
      if (AUDIT_PERSIST_ERROR) {
        warn.innerHTML = '<strong>This log is not being saved.</strong> Entries below are only in this browser tab and ' +
          'will disappear on reload. The admin_audit_log table is missing or unreadable - run ' +
          '<code>supabase/admin_audit_log.sql</code> in the Supabase SQL editor. ' +
          '<span class="adm-sub">(' + esc(AUDIT_PERSIST_ERROR) + ')</span>';
      }
    }

    var actors = [];
    AUDIT.forEach(function (a) { if (a.actor && actors.indexOf(a.actor) < 0) actors.push(a.actor); });
    actors.sort();
    if (auditActorDropdown) {
      auditActorDropdown.setOptions([{ value: '', label: 'All staff' }].concat(actors.map(function (n) {
        return { value: n, label: n };
      })));
      auditActorDropdown.setValue(auditActor, true);
    }
    if (auditTypeDropdown) auditTypeDropdown.setValue(auditType, true);

    var q = auditQuery.toLowerCase();
    var rows = AUDIT.filter(function (a) {
      if (auditActor && a.actor !== auditActor) return false;
      if (auditType === 'staff' && a.kind !== 'staff') return false;
      if (auditType === 'error' && a.kind !== 'error') return false;
      if (auditType.indexOf('err:') === 0 && (a.kind !== 'error' || a.errKind !== auditType.slice(4))) return false;
      if (q) {
        // Match staff name / action text, and - for error rows - the
        // reference code, function name, kind and page URL, so a code a
        // customer read back ("it said ERR-4K9X2P") actually finds its row.
        var hay = [a.action, a.actor, a.code, a.fnName, a.errKind, a.pageUrl]
          .filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    if ($('admAuditCount')) {
      $('admAuditCount').textContent = rows.length === AUDIT.length
        ? (AUDIT.length + ' entr' + (AUDIT.length === 1 ? 'y' : 'ies'))
        : (rows.length + ' of ' + AUDIT.length);
    }

    var body = $('admAuditBody');
    body.innerHTML = rows.map(function (a, i) {
      if (a.kind === 'error') {
        var kindLabel = AUDIT_ERR_KINDS[a.errKind] || a.errKind || 'Error';
        return '<tr class="adm-audit-err-row"><td>' + fmtDateTime(new Date(a.ts)) + '</td>' +
          '<td><span class="adm-err-code">' + esc(a.code || 'ERR-??????') + '</span></td>' +
          '<td><span class="dt-badge">' + esc(kindLabel) + '</span> ' + esc(a.action) +
          (a.fnName ? ' <span class="adm-sub">(' + esc(a.fnName) + ')</span>' : '') +
          ' <button type="button" class="adm-err-details-btn" data-idx="' + i + '">Details</button></td></tr>';
      }
      return '<tr><td>' + fmtDateTime(new Date(a.ts)) + '</td><td>' + esc(a.actor) + '</td><td>' + esc(a.action) + '</td></tr>';
    }).join('') || ('<tr><td colspan="3" class="adm-empty">' +
      (AUDIT.length ? 'No entries match that filter.' : 'No actions logged yet.') + '</td></tr>');

    // The click handler is wired once, but `rows` is rebuilt on every
    // render (filter, refresh); stash the current set on the element so
    // the handler resolves data-idx against what's actually on screen
    // rather than a stale closure from the first render.
    body.__auditRows = rows;
    if (!body.__errDetailsWired) {
      body.__errDetailsWired = true;
      body.addEventListener('click', function (e) {
        var btn = e.target.closest('.adm-err-details-btn');
        if (!btn) return;
        var row = (body.__auditRows || [])[Number(btn.getAttribute('data-idx'))];
        if (row) openErrDetails(row);
      });
    }
  }

  function openErrDetails(row) {
    var overlay = $('admErrOverlay');
    if (!overlay) return;
    $('admErrCode').textContent = row.code || 'ERR-??????';
    $('admErrKind').textContent = row.errKind || '';
    $('admErrWhen').textContent = fmtDateTime(new Date(row.ts));
    $('admErrMsg').textContent = row.action || '';
    $('admErrUrl').textContent = row.pageUrl || '–';
    $('admErrUA').textContent = row.userAgent || '–';
    $('admErrUser').textContent = row.userId || 'Not signed in';
    var ctxEl = $('admErrContext');
    var ctxWrap = $('admErrContextWrap');
    var hasCtx = row.context && Object.keys(row.context).length;
    if (ctxWrap) ctxWrap.hidden = !hasCtx;
    if (ctxEl && hasCtx) ctxEl.textContent = JSON.stringify(row.context, null, 2);
    var stackWrap = $('admErrStackWrap');
    var stackEl = $('admErrStack');
    if (stackWrap) stackWrap.hidden = !row.stack;
    if (stackEl && row.stack) stackEl.textContent = row.stack;
    overlay.hidden = false;
  }
  var admErrCloseBtn = $('admErrClose');
  if (admErrCloseBtn) admErrCloseBtn.addEventListener('click', function () { $('admErrOverlay').hidden = true; });
  var admErrOverlayEl = $('admErrOverlay');
  if (admErrOverlayEl) admErrOverlayEl.addEventListener('click', function (e) { if (e.target === admErrOverlayEl) admErrOverlayEl.hidden = true; });

  /* ================================================================
     INIT
     ================================================================ */
  routeFromLocation();

  // Deep-link from the public product page's admin bar:
  //   /admin?product=<id>&action=edit   -> open that product's edit form
  //   /admin?product=<id>&action=update -> open Push Update for it
  // The catalog loads async, so poll findProduct() briefly before giving up.
  (function productDeepLink() {
    var pid, action;
    try {
      var qp = new URLSearchParams(location.search);
      pid = qp.get('product');
      action = qp.get('action') === 'update' ? 'update' : 'edit';
    } catch (e) { return; }
    if (!pid) return;
    var tries = 0;
    (function wait() {
      if (findProduct(pid)) {
        if (action === 'update') { openUpdatePanel(); selectUpdateProduct(pid); }
        else openProductEdit(pid);
      } else if (tries++ < 40) {
        setTimeout(wait, 150);
      }
    })();
  })();

  // Sync the range buttons (markup hard-codes 30D active) to the persisted
  // RANGE_DAYS so the highlighted period always matches the figures shown.
  setRange(RANGE_DAYS);
  refreshProducts().then(function () {
    return refreshOrders().then(function () { refreshAdminReferrals(); refreshPayouts(); });
  });
  refreshCoupons();
  refreshRobloxContainers();
  refreshUsers();
  refreshReviews();
  refreshPosts();
  refreshTutorials();
  refreshReleases();
  refreshSaleEvents();
  refreshTraffic();
  refreshClientEvents();
  refreshAbandoned();
  refreshMarketplaces();
  refreshBbb();
  refreshStaff();
  refreshRobloxCookieHealth();
  refreshLiveSessions();
  refreshDiscordStats();
  refreshSocialStats();
  refreshCampaigns();
  refreshAdbloxStats();
  refreshEmailStats();
  refreshEmailCampaigns();
  refreshEmailEvents();
  refreshTemplates();
  loadUnreleasedFiles();
  refreshResellers();
  refreshEmailConfigStatus();
  refreshAutomations();
  var admAdbloxLoadMoreBtn = $('admAdbloxLoadMore');
  if (admAdbloxLoadMoreBtn) admAdbloxLoadMoreBtn.addEventListener('click', function () {
    admAdbloxLoadMoreBtn.disabled = true;
    loadMoreAdbloxLogs().then(function () {
      admAdbloxLoadMoreBtn.disabled = false;
    });
  });
  setInterval(refreshLiveSessions, 30000);
  // Site visits / pageviews / top pages were a once-on-boot pull. Re-pull
  // every 5 min so the Analytics and home numbers stay current for a tab
  // left open, same unconditional-interval pattern as live sessions (each
  // render call already no-ops unless its panel is showing).
  setInterval(refreshTraffic, 5 * 60 * 1000);
  setInterval(refreshClientEvents, 5 * 60 * 1000);
  // AdBlox stats used to only load once on boot, or on the manual Refresh
  // button - same polling pattern as refreshLiveSessions above (an
  // unconditional interval; the function itself already only re-renders
  // when the Marketing panel is the one currently showing), so the numbers
  // stay current without anyone having to remember to hit Refresh. The
  // button stays wired exactly as before for an on-demand pull.
  //
  // 10s, not 30s: AdBlox's documented budget is 60 requests/minute per API
  // key (docs.adblox.xyz/errors-and-rate-limits) shared across every
  // endpoint, and this one call already spends 3 of that per poll
  // (stats+servers+logs). At 10s that's 18 req/min for a single admin
  // tab - comfortable headroom under 60 even with the manual button
  // clicked a few times or a second admin tab open, and refreshAdbloxStats
  // backs the interval off for a minute on an actual 429 rather than
  // assuming the budget is infinite.
  setInterval(function () {
    if (Date.now() < ADBLOX_COOLDOWN_UNTIL) return;
    refreshAdbloxStats();
  }, 10000);
  } // end boot()
})();
