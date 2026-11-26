/* Agency section of the admin (Commissions, Leads, Devs, Payouts, Services).
   Reads and writes the admin-only agency_* tables (RLS is_admin) through the
   admin's Supabase client; every figure is worked out from those rows.
   admin.js owns routing: it calls window.AGENCY.render(panel) from renderPanel()
   and exposes window.admShowPanel for the commission detail page. */
(function () {
  'use strict';
  var PANELS = ['commissions', 'commission', 'leads', 'devs', 'payouts', 'services'];
  var DB = null, LOADING = null, LOAD_ERR = '', CUR_PANEL = '';
  var CUR_CM = null, CM_VIEW = 'active', LEAD_VIEW = 'open', LEAD_OPEN = null, PAY_VIEW = 'owed', RANGE = 30;
  var DAY = 86400000;

  var ICON = {
    game: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 10.5v4M5 12.5h4"/><path d="M15.5 11.5h.01M18 13.5h.01"/>',
    script: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    build: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 14.5h18M9 4v5.5M15 9.5v5M9 14.5V20"/>',
    model: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    ui: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    thumb: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    trailer: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    anim: '<circle cx="14" cy="4.5" r="2"/><path d="m8 21 3-6 3 2v4"/><path d="M6 11l4-3.5 4 3 3.5 1"/><path d="m11 15-1-5"/>',
    vfx: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
    cloth: '<path d="M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3c0 1.7-1.8 3-4 3S8 4.7 8 3z"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    wallet: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.4-.9-1.3-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.2-.6-2.6-1.5M12 6.5V8M12 16v1.5"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
  };
  var SVC = {
    'Full game': { key: 'game', c: 'var(--sv-game)', skill: null },
    'Scripting': { key: 'script', c: 'var(--sv-script)', skill: 'Scripting' },
    'Building': { key: 'build', c: 'var(--sv-build)', skill: 'Building' },
    '3D models': { key: 'model', c: 'var(--sv-3d)', skill: '3D models' },
    'User interface': { key: 'ui', c: 'var(--sv-ui)', skill: 'User interface' },
    'Thumbnails': { key: 'thumb', c: 'var(--sv-thumb)', skill: 'Thumbnails' },
    'Game trailers': { key: 'trailer', c: 'var(--sv-trailer)', skill: 'Game trailers' },
    'Animations': { key: 'anim', c: 'var(--sv-anim)', skill: 'Animations' },
    'VFX': { key: 'vfx', c: 'var(--sv-vfx)', skill: 'VFX' },
    'Clothing': { key: 'cloth', c: 'var(--sv-cloth)', skill: 'Clothing' }
  };
  var SERVICE_NAMES = ['Full game', 'Scripting', 'Building', '3D models', 'User interface', 'Thumbnails', 'Game trailers', 'Animations', 'VFX'];
  var SKILLS = ['Scripting', 'Building', 'User interface', '3D models', 'Thumbnails', 'Game trailers', 'Animations', 'VFX', 'Clothing'];
  var DISCORD = '<svg viewBox="0 0 24 24" fill="#5865f2" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>';
  var XLOGO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="color:var(--src-x)"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>';
  var SRC = {
    bbb: { name: 'BuiltByBit', color: 'var(--pf-builtbybit)', logo: '<img src="/mp-logos/builtbybit.png" alt="" />' },
    discord: { name: 'Discord', color: 'var(--src-discord)', logo: DISCORD },
    x: { name: 'X', color: 'var(--src-x)', logo: XLOGO },
    site: { name: 'coldd.dev', color: 'var(--pf-site)', logo: '<img src="/logo.png" alt="" />' },
    other: { name: 'Other', color: 'var(--fg-3)', logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" style="color:var(--fg-3)"><circle cx="12" cy="12" r="9"/><path d="M8 12h.01M12 12h.01M16 12h.01"/></svg>' }
  };
  var SOURCE_KEYS = ['bbb', 'discord', 'x', 'site', 'other'];
  var STAGES = ['Deposit', 'In progress', 'Client review', 'Delivered'];
  var LEAD_STATUS = { 'new': ['New', 'new'], replied: ['Replied', 'ok'], consultation: ['Consultation', 'warn'], converted: ['Converted', 'ok'], declined: ['Declined', ''] };

  // ---------- helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { n = Number(n) || 0; return n; }
  function usd(n) { n = num(n); return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function rbx(n) { return 'R$ ' + num(n).toLocaleString('en-US'); }
  function svg(path, w) { return '<svg viewBox="0 0 24 24" width="' + (w || 18) + '" height="' + (w || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>'; }
  function svcOf(name) { return SVC[name] || SVC['Full game']; }
  function tile(svc, size) { var s = svcOf(svc); return '<span class="ag-tile' + (size ? ' ' + size : '') + '" style="--sv:' + s.c + '">' + svg(ICON[s.key]) + '</span>'; }
  function srcK(k) { return SRC[k] ? k : 'other'; }
  function src(k) { var s = SRC[srcK(k)]; return '<span class="ag-src">' + s.logo + '<span>' + esc(s.name) + '</span></span>'; }
  function srcTile(k) { return '<span class="ag-srctile">' + SRC[srcK(k)].logo + '</span>'; }
  function today() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function parseDay(s) { if (!s) return null; var p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(d) { if (!d) return ''; if (typeof d === 'string') d = d.length > 10 ? new Date(d) : parseDay(d); return d.getDate() + ' ' + MON[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''); }
  function fmtTime(t) { var d = new Date(t); var h = d.getHours(), m = d.getMinutes(); return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' am' : ' pm'); }
  function ago(t) {
    var ms = Date.now() - new Date(t).getTime();
    if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + 'm ago';
    if (ms < DAY) return Math.round(ms / 3600000) + 'h ago';
    var d = Math.round(ms / DAY); return d === 1 ? 'Yesterday' : d + ' days ago';
  }
  function dayDiff(a, b) { return Math.round((a - b) / DAY); }
  function sum(arr, f) { return arr.reduce(function (a, x) { return a + num(f(x)); }, 0); }
  function setNav(id, n) { var el = $(id); if (!el) return; el.textContent = n || ''; el.hidden = !n; }
  function niceStep(raw) { var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function inRange(t, days, back) { if (!t) return false; var ms = new Date(t).getTime(), now = Date.now(); if (!days) return !back; var end = now - (back ? days * DAY : 0), start = end - days * DAY; return ms > start && ms <= end; }
  function rangeLabel() { return RANGE ? 'vs previous ' + (RANGE === 365 ? 'year' : RANGE + ' days') : ''; }
  function delta(now, prev) {
    if (!RANGE) return '';
    if (!prev) return now ? '<span class="adm-kpi-delta up">New</span> ' + rangeLabel() : '';
    var p = Math.round((now - prev) / prev * 100);
    if (!p) return '';
    return '<span class="adm-kpi-delta ' + (p > 0 ? 'up' : 'down') + '">' + (p > 0 ? '↑ ' : '↓ ') + Math.abs(p) + '%</span> ' + rangeLabel();
  }
  function kpi(label, value, em, line, sub) {
    return '<div class="adm-kpi-cell"><span class="adm-kpi-label">' + label + '</span><span class="adm-kpi-value"><b>' + value + '</b>' + (em ? '<em>' + em + '</em>' : '') + '</span>' +
      '<span class="adm-kpi-line">' + (line || '') + '</span>' + (sub ? '<span class="adm-kpi-sub">' + sub + '</span>' : '') + '</div>';
  }
  var toastEl = null, toastT = null;
  function toast(msg, ok) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'adm-toast'; toastEl.addEventListener('click', function () { toastEl.classList.remove('show'); }); document.body.appendChild(toastEl); }
    clearTimeout(toastT); toastEl.textContent = msg; toastEl.className = 'adm-toast ' + (ok ? 'ok' : 'err'); void toastEl.offsetWidth; toastEl.classList.add('show');
    if (ok) toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }
  function me() { var w = $('admSideWho'); return w ? String(w.textContent || '').split('·')[0].trim().slice(0, 80) : ''; }

  // ---------- data
  function sb() { return window.coldSupabase; }
  function q(p) { return p.then(function (r) { if (r.error) throw r.error; return r.data; }); }
  function load(force) {
    if (DB && !force) return Promise.resolve(DB);
    if (LOADING) return LOADING;
    var c = sb();
    if (!c) return Promise.reject(new Error('Not connected'));
    LOADING = Promise.all([
      q(c.from('agency_devs').select('*').order('created_at', { ascending: true })),
      q(c.from('agency_leads').select('*').order('created_at', { ascending: false }).limit(2000)),
      q(c.from('agency_commissions').select('*').order('created_at', { ascending: false }).limit(2000)),
      q(c.from('agency_payments').select('*').order('paid_on', { ascending: false }).limit(5000)),
      q(c.from('agency_assignments').select('*').order('created_at', { ascending: true }).limit(5000)),
      q(c.from('agency_notes').select('*').order('created_at', { ascending: false }).limit(5000)),
      q(c.from('agency_data').select('id,data').eq('id', 'settings').maybeSingle())
    ]).then(function (r) {
      LOADING = null; LOAD_ERR = '';
      DB = { devs: r[0] || [], leads: r[1] || [], cms: r[2] || [], pays: r[3] || [], asg: r[4] || [], notes: r[5] || [], settings: (r[6] && r[6].data) || { services: [], tiers: [], switches: [] } };
      derive();
      updateNav();
      return DB;
    }, function (e) { LOADING = null; LOAD_ERR = (e && e.message) || 'Could not load'; throw e; });
    return LOADING;
  }
  // Joins rows once per load: money in/out per commission, payout state per assignment.
  function derive() {
    var byId = {}, devById = {}, t0 = today();
    DB.devs.forEach(function (d) { devById[d.id] = d; });
    DB.cms.forEach(function (c) {
      byId[c.id] = c; c.ref = 'CM-' + c.num; c.price = num(c.price_usd); c.paid = 0; c.costUsd = 0; c.costRbx = 0; c.team = []; c.payments = []; c.notesList = [];
      var due = parseDay(c.due_on); c.dueDays = due ? dayDiff(due, t0) : null;
      c.tone = c.stage < 3 && due ? (c.dueDays < 0 ? 'late' : c.dueDays <= 3 ? 'warn' : '') : '';
    });
    DB.pays.forEach(function (p) { var c = byId[p.commission_id]; if (c) { c.paid += num(p.amount_usd); c.payments.push(p); } });
    DB.notes.forEach(function (n) { var c = byId[n.commission_id]; if (c) c.notesList.push(n); });
    DB.asg.forEach(function (a) {
      var c = byId[a.commission_id]; if (!c) return;
      a.dev = devById[a.dev_id] || { name: 'Removed dev', skills: [] };
      a.c = c;
      a.state = a.paid_at ? 'paid' : c.stage < 3 ? 'waiting' : c.paid + 0.005 < c.price ? 'client' : 'owed';
      c.costUsd += num(a.cost_usd); c.costRbx += num(a.cost_robux); c.team.push(a);
    });
    DB.byId = byId; DB.devById = devById;
    var floors = {};
    (DB.settings.services || []).forEach(function (s) { if (s.floor) floors[s.n] = num(s.floor); });
    var flag = switchOn('Flag leads under the floor', true);
    DB.leads.forEach(function (l) { l.ref = 'L-' + l.num; l.floor = floors[l.service] || 0; l.under = flag && l.floor && l.budget_usd != null && num(l.budget_usd) < l.floor; });
  }
  function switchOn(label, dflt) { var s = (DB.settings.switches || []).filter(function (x) { return x[0] === label; })[0]; return s ? !!s[1] : dflt; }
  function owedList() { return DB.asg.filter(function (a) { return a.c && a.state === 'owed'; }); }
  function openLeads() { return DB.leads.filter(function (l) { return l.status === 'new' || l.status === 'replied' || l.status === 'consultation'; }); }
  function activeCms() { return DB.cms.filter(function (c) { return c.stage < 3; }); }
  function cmByRef(ref) { return DB.cms.filter(function (c) { return c.ref === ref || c.id === ref; })[0]; }
  function updateNav() {
    if (!DB) return;
    setNav('agNavCm', DB.cms.filter(function (c) { return c.tone === 'late'; }).length);
    setNav('agNavLeads', DB.leads.filter(function (l) { return l.status === 'new'; }).length);
    setNav('agNavPay', owedList().length);
  }
  function reload() { return load(true).then(function () { if (CUR_PANEL && RENDER[CUR_PANEL]) RENDER[CUR_PANEL](); }); }
  function save(promise, okMsg) {
    return q(promise).then(function (d) { if (okMsg) toast(okMsg, true); return reload().then(function () { return d; }); }, function (e) { toast('Could not save: ' + ((e && e.message) || 'error'), false); throw e; });
  }
  function waitThen(panel, fn) {
    if (DB) { fn(); return; }
    var sec = $('adm-panel-' + panel), slot = sec && sec.querySelector('.ag-loading');
    if (slot) { slot.hidden = false; slot.textContent = 'Loading…'; }
    load().then(function () { if (slot) slot.hidden = true; fn(); }, function () {
      if (slot) { slot.hidden = false; slot.textContent = 'Could not load Agency data: ' + LOAD_ERR; }
    });
  }

  // ---------- charts
  function lineChart(el, labels, series) {
    if (!el) return;
    var W = Math.max(320, el.clientWidth), H = el.clientHeight || 236, L = 46, R = 92, T = 12, B = 28;
    var max = 0; series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    var step = niceStep(max / 4 || 1), top = Math.ceil(max / step) * step || step;
    function x(i) { return L + i * (W - L - R) / Math.max(1, labels.length - 1); }
    function y(v) { return T + (1 - v / top) * (H - T - B); }
    var g = '';
    for (var t = 0; t <= top + 1e-9; t += step) g += '<line class="pc-grid" x1="' + L + '" x2="' + (W - R + 10) + '" y1="' + y(t) + '" y2="' + y(t) + '"/><text class="pc-axis" x="' + (L - 10) + '" y="' + (y(t) + 4) + '" text-anchor="end">$' + (t >= 1000 ? (t / 1000) + 'k' : t) + '</text>';
    labels.forEach(function (l, i) { g += '<text class="pc-axis" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(l) + '</text>'; });
    var ends = [];
    series.forEach(function (s) {
      var d = s.values.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
      g += '<path class="pc-line" d="' + d + '" style="stroke:' + s.color + '"/>';
      var li = s.values.length - 1;
      g += '<circle class="pc-dot" cx="' + x(li) + '" cy="' + y(s.values[li]) + '" r="4" style="fill:' + s.color + '"/>';
      ends.push({ y: y(s.values[li]), name: s.name, color: s.color });
    });
    ends.sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
    ends.forEach(function (e) { g += '<line class="pc-key" x1="' + (W - R + 18) + '" x2="' + (W - R + 28) + '" y1="' + e.y + '" y2="' + e.y + '" style="stroke:' + e.color + '"/><text class="pc-end" x="' + (W - R + 34) + '" y="' + (e.y + 4) + '">' + esc(e.name) + '</text>'; });
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + g + '</svg>';
  }
  function donut(segs, center, sub, empty) {
    segs = segs.filter(function (s) { return s.value > 0; });
    var total = segs.reduce(function (a, s) { return a + s.value; }, 0);
    if (!total) return '<p class="ag-empty">' + esc(empty || 'Nothing yet') + '</p>';
    var size = 168, c = 84, r = 64, sw = 28, circ = 2 * Math.PI * r, off = 0;
    var arcs = segs.map(function (s) {
      var dash = s.value / total * circ;
      var a = segs.length === 1
        ? '<circle class="adm-donut-seg" cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" style="stroke:' + s.color + ';stroke-width:' + sw + 'px"></circle>'
        // var() only works in style, never in SVG presentation attributes.
        : '<circle class="adm-donut-seg" cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" style="stroke:' + s.color + ';stroke-width:' + sw + 'px" stroke-dasharray="' + Math.max(0, dash - 1.5).toFixed(2) + ' ' + (circ - dash + 1.5).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '"></circle>';
      off += dash; return a;
    }).join('');
    var key = '<div class="adm-donut-key">' + segs.map(function (s) { return '<span><i style="background:' + s.color + '"></i><span class="adm-donut-lbl">' + esc(s.label) + '</span><b>' + s.display + '</b><em>' + Math.round(s.value / total * 100) + '%</em></span>'; }).join('') + '</div>';
    return '<div class="adm-donut-wrap"><svg class="adm-donut" viewBox="0 0 ' + size + ' ' + size + '"><g transform="rotate(-90 ' + c + ' ' + c + ')">' + arcs + '</g>' +
      '<text x="' + c + '" y="' + (c - 3) + '" class="adm-donut-c1">' + esc(center) + '</text><text x="' + c + '" y="' + (c + 13) + '" class="adm-donut-c2">' + esc(sub) + '</text></svg>' + key + '</div>';
  }
  function monthKeys(n) { var out = [], d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); for (var i = n - 1; i >= 0; i--) { var m = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push({ k: m.getFullYear() + '-' + m.getMonth(), label: MON[m.getMonth()] }); } return out; }
  function monthKey(t) { var d = typeof t === 'string' && t.length <= 10 ? parseDay(t) : new Date(t); return d.getFullYear() + '-' + d.getMonth(); }
  function dayAgo(t) { if (!t) return ''; var d = dayDiff(today(), parseDay(String(t).slice(0, 10))); return d === 0 ? 'Today' : d === 1 ? 'Yesterday' : d + ' days ago'; }

  // ---------- Commissions
  function periodStats(back) {
    var pays = DB.pays.filter(function (p) { return inRange(p.paid_on + 'T12:00:00', RANGE, back); });
    var revenue = sum(pays, function (p) { return p.amount_usd; });
    var delivered = DB.cms.filter(function (c) { return c.stage === 3 && inRange(c.delivered_at, RANGE, back); });
    var margin = sum(delivered, function (c) { return c.price - c.costUsd; });
    var leads = DB.leads.filter(function (l) { return inRange(l.created_at, RANGE, back); });
    return { pays: pays, revenue: revenue, delivered: delivered, margin: margin, booked: sum(delivered, function (c) { return c.price; }), leads: leads };
  }
  function renderCommissions() {
    syncRange('agCmRange');
    var cur = periodStats(false), prev = periodStats(true), active = activeCms();
    var late = active.filter(function (c) { return c.tone === 'late'; }).length;
    var dueToday = active.filter(function (c) { return c.dueDays === 0; }).length;
    var open = openLeads(), owed = owedList();
    var devSet = {}; active.forEach(function (c) { c.team.forEach(function (a) { devSet[a.dev_id] = 1; }); });
    var converted = cur.leads.filter(function (l) { return l.status === 'converted'; }).length;
    $('agKpi').innerHTML =
      kpi('Revenue', usd(cur.revenue), cur.pays.length + ' payment' + (cur.pays.length === 1 ? '' : 's'), delta(cur.revenue, prev.revenue), cur.pays.length ? 'Average ' + usd(Math.round(cur.revenue / cur.pays.length)) + ' a payment' : 'Client payments you record') +
      kpi('Margin', usd(cur.margin), cur.booked ? Math.round(cur.margin / cur.booked * 100) + '%' : '', delta(cur.margin, prev.margin), cur.delivered.length ? 'On ' + cur.delivered.length + ' delivered' : 'Price minus dev pay, once delivered') +
      kpi('Active', active.length, active.length ? usd(sum(active, function (c) { return c.price; })) + ' booked' : '', (dueToday ? dueToday + ' due today' : '') + (late ? (dueToday ? ' &middot; ' : '') + '<span class="ag-late">' + late + ' late</span>' : ''), active.length ? 'Across ' + Object.keys(devSet).length + ' dev' + (Object.keys(devSet).length === 1 ? '' : 's') : '') +
      kpi('Leads', open.length, 'open', '', cur.leads.length ? converted + ' of ' + cur.leads.length + ' converted' : '');
    var next = active.filter(function (c) { return c.dueDays != null && c.dueDays >= 0; }).sort(function (a, b) { return a.dueDays - b.dueDays; })[0];
    $('agKpiFoot').innerHTML = '<span><i class="adm-live-dot' + (Object.keys(devSet).length ? ' is-on' : '') + '"></i><b>' + Object.keys(devSet).length + '</b> devs working now</span>' +
      '<span>Owed to devs <b>' + usd(sum(owed, function (a) { return a.cost_usd; })) + '</b>' + (owed.length ? ' across ' + owed.length : '') + '</span>' +
      (next ? '<span>Next due <b>' + esc(next.title) + '</b> ' + (next.dueDays === 0 ? 'today' : next.dueDays === 1 ? 'tomorrow' : 'in ' + next.dueDays + ' days') + '</span>' : '');
    renderCmList();
    renderNeeds();
    renderSourceTable(cur, prev);
    var bySvc = {}; cur.pays.forEach(function (p) { var c = DB.byId[p.commission_id]; if (c) bySvc[c.service] = (bySvc[c.service] || 0) + num(p.amount_usd); });
    var mix = Object.keys(bySvc).sort(function (a, b) { return bySvc[b] - bySvc[a]; });
    $('agSvcTitleSub').textContent = RANGE ? 'Last ' + (RANGE === 365 ? 'year' : RANGE + ' days') : 'All time';
    $('agSvcDonut').innerHTML = donut(mix.map(function (k) { return { label: k, value: bySvc[k], color: svcOf(k).c, display: usd(bySvc[k]) }; }), usd(cur.revenue), 'revenue', 'No client payments in this range');
    drawSourceChart();
  }
  function cmRow(c) {
    var names = c.team.map(function (a) { return a.dev.name; });
    var when = c.stage === 3 ? fmtDay(c.delivered_at) : c.due_on ? fmtDay(c.due_on) : 'No date';
    var rel = c.stage === 3 ? dayAgo(c.delivered_at) : c.due_on ? (c.dueDays < 0 ? Math.abs(c.dueDays) + ' day' + (c.dueDays === -1 ? '' : 's') + ' late' : c.dueDays === 0 ? 'due today' : 'in ' + c.dueDays + ' day' + (c.dueDays === 1 ? '' : 's')) : '';
    if (c.stage === 2 && c.tone !== 'late') rel = 'waiting on client';
    if (c.stage === 0 && !c.paid) rel = 'deposit not paid';
    return '<button type="button" class="ag-row ag-commissions-cols" data-ag-cm="' + esc(c.ref) + '">' +
      '<span class="ag-main">' + tile(c.service) + '<span class="ag-name"><span class="ag-t">' + esc(c.title) + '</span><span class="ag-m">' + esc(c.service + (c.client ? ' · ' + c.client : '')) + '</span></span></span>' +
      '<span class="ag-hide-sm">' + src(c.source) + '</span>' +
      '<span class="ag-c ag-hide-sm' + (names.length ? '' : ' ag-dim') + '">' + (names.length ? esc(names.slice(0, 2).join(', ')) + (names.length > 2 ? '<small>+' + (names.length - 2) + ' more</small>' : '') : 'No dev yet') + '</span>' +
      '<span class="ag-hide-sm">' + stageCell(c) + '</span>' +
      '<span class="ag-amt ag-hide-sm">' + usd(c.price) + '<small>' + (c.paid + 0.005 >= c.price && c.price ? 'Paid' : usd(c.paid) + ' paid') + '</small></span>' +
      '<span class="ag-when">' + esc(when) + '<small class="' + (c.tone === 'late' ? 'ag-late' : c.tone === 'warn' ? 'ag-warn' : '') + '">' + esc(rel) + '</small></span></button>';
  }
  function stageCell(c) {
    var cls = c.stage === 3 ? ' is-done' : c.tone === 'late' ? ' is-late' : '';
    var bar = STAGES.map(function (s, i) { return '<i class="' + (i <= c.stage ? 'on' : '') + '"></i>'; }).join('');
    return '<span class="ag-stage' + cls + '"><span class="ag-stage-bar">' + bar + '</span><small>' + STAGES[c.stage] + '</small></span>';
  }
  function renderCmList() {
    var rows = DB.cms.filter(function (c) { return CM_VIEW === 'all' || (CM_VIEW === 'active' ? c.stage < 3 : c.stage === 3); });
    if (CM_VIEW === 'active') rows.sort(function (a, b) { return (a.dueDays == null ? 9999 : a.dueDays) - (b.dueDays == null ? 9999 : b.dueDays); });
    if (CM_VIEW === 'done') rows.sort(function (a, b) { return new Date(b.delivered_at || 0) - new Date(a.delivered_at || 0); });
    $('agCmTitle').textContent = CM_VIEW === 'active' ? 'Active commissions' : CM_VIEW === 'done' ? 'Delivered' : 'All commissions';
    $('agCmCount').textContent = rows.length || '';
    var h = rows.length ? '<div class="ag-lh ag-commissions-cols"><span>Commission</span><span>Source</span><span>Devs</span><span>Stage</span><span class="ag-r">Price</span><span class="ag-r">' + (CM_VIEW === 'done' ? 'Delivered' : 'Due') + '</span></div>' + rows.map(cmRow).join('') : '';
    if (!rows.length) h = '<div class="ag-empty-cta">' + svg(ICON.inbox, 22) + '<b>' + (CM_VIEW === 'done' ? 'Nothing delivered yet' : DB.cms.length ? 'No active commissions' : 'No commissions yet') + '</b><span>Add one here, or turn a lead into one from Leads.</span><button class="btn btn-primary adm-btn-sm" type="button" data-ag-new="commission">New commission</button></div>';
    $('agCmList').innerHTML = h;
  }
  function renderNeeds() {
    var items = [], active = activeCms(), t = Date.now();
    active.filter(function (c) { return c.tone === 'late'; }).forEach(function (c) { items.push({ tone: 'err', ico: svg(ICON.alert, 16), t: c.title + ' is ' + Math.abs(c.dueDays) + ' day' + (c.dueDays === -1 ? '' : 's') + ' late', s: (c.team.map(function (a) { return a.dev.name; }).join(', ') || 'No dev') + ' · due ' + fmtDay(c.due_on), go: c.ref }); });
    active.filter(function (c) { return c.dueDays === 0; }).forEach(function (c) { items.push({ tone: 'warn', ico: svg(ICON.clock, 16), t: c.title + ' is due today', s: STAGES[c.stage], go: c.ref }); });
    DB.leads.filter(function (l) { return l.status === 'consultation' && l.consultation_at && new Date(l.consultation_at).getTime() > t - 3600000; }).forEach(function (l) { items.push({ tone: '', ico: SRC[srcK(l.source)].logo, t: 'Consultation with ' + (l.client || l.title), s: l.title + ' · ' + fmtDay(l.consultation_at) + ' ' + fmtTime(l.consultation_at), go: 'leads' }); });
    var fresh = DB.leads.filter(function (l) { return l.status === 'new'; });
    if (fresh.length) items.push({ tone: '', ico: svg(ICON.inbox, 16), t: fresh.length + ' new lead' + (fresh.length === 1 ? '' : 's') + ' to reply to', s: 'Oldest ' + ago(fresh[fresh.length - 1].created_at), go: 'leads' });
    var listed = {}; items.forEach(function (n) { listed[n.go] = 1; });
    active.filter(function (c) { return c.stage === 2 && !listed[c.ref]; }).forEach(function (c) { items.push({ tone: 'warn', ico: svg(ICON.eye, 16), t: c.title + ' is with the client', s: c.client || '', go: c.ref }); });
    var owed = owedList();
    if (owed.length) {
      var per = {}; owed.forEach(function (a) { per[a.dev.name] = (per[a.dev.name] || 0) + num(a.cost_usd); });
      items.push({ tone: 'ok', ico: svg(ICON.wallet, 16), t: 'Pay ' + Object.keys(per).map(function (n) { return n + ' ' + usd(per[n]); }).join(', '), s: 'Delivered and the client has paid', go: 'payouts' });
    }
    active.filter(function (c) { return c.stage === 0 && !c.paid; }).forEach(function (c) { items.push({ tone: '', ico: svg(ICON.coin, 16), t: 'Deposit not paid for ' + c.title, s: (c.client ? c.client + ' · ' : '') + 'added ' + ago(c.created_at).toLowerCase(), go: c.ref }); });
    items = items.slice(0, 8);
    $('agNeedsCount').textContent = items.length ? items.length + ' open' : '';
    $('agNeeds').innerHTML = items.length ? items.map(function (n) {
      return '<a class="adm-work-item' + (n.tone ? ' tone-' + n.tone : '') + '" href="#" data-ag-go="' + esc(n.go) + '"><span class="adm-work-ico">' + n.ico + '</span><span class="adm-work-text">' + esc(n.t) + '<small>' + esc(n.s) + '</small></span><span class="adm-work-go">' + svg(ICON.chev, 16) + '</span></a>';
    }).join('') : '<p class="adm-work-empty">Nothing needs you right now</p>';
  }
  function renderSourceTable(cur, prev) {
    var srcOf = function (p) { var c = DB.byId[p.commission_id]; return c ? srcK(c.source) : 'other'; };
    var rows = SOURCE_KEYS.map(function (k) {
      var a = cur.pays.filter(function (p) { return srcOf(p) === k; }), b = prev.pays.filter(function (p) { return srcOf(p) === k; });
      var ids = {}; a.forEach(function (p) { ids[p.commission_id] = 1; });
      return { k: k, cur: sum(a, function (p) { return p.amount_usd; }), prev: sum(b, function (p) { return p.amount_usd; }), n: Object.keys(ids).length };
    }).filter(function (r) { return r.cur || r.prev || DB.cms.some(function (c) { return srcK(c.source) === r.k; }); });
    var tot = sum(rows, function (r) { return r.cur; }), totPrev = sum(rows, function (r) { return r.prev; }), totN = sum(rows, function (r) { return r.n; });
    var lbl = RANGE ? (RANGE === 365 ? 'Last year' : 'Last ' + RANGE + 'd') : 'All time';
    $('agSrcTable').parentNode.hidden = !rows.length;
    if (!rows.length) { $('agSrcTable').innerHTML = ''; return; }
    $('agSrcTable').innerHTML = '<thead><tr><th>Source</th><th>' + lbl + '</th>' + (RANGE ? '<th>Previous</th><th>Change</th>' : '') + '<th>Share</th><th>Commissions</th></tr></thead><tbody>' + rows.map(function (r) {
      var p = r.prev ? Math.round((r.cur - r.prev) / r.prev * 100) : null, share = tot ? Math.round(r.cur / tot * 100) : 0;
      return '<tr><th><span class="adm-pf" style="--pf:' + SRC[r.k].color + '"><i></i>' + src(r.k) + '</span></th><td class="is-strong">' + usd(r.cur) + '</td>' +
        (RANGE ? '<td class="is-muted">' + usd(r.prev) + '</td><td>' + (r.cur && p !== 0 ? '<span class="adm-chg ' + (p == null || p > 0 ? 'up' : 'down') + '">' + (p == null ? 'New' : (p > 0 ? '↑ ' : '↓ ') + Math.abs(p) + '%') + '</span>' : '') + '</td>' : '') +
        '<td><span class="adm-share" style="--pf:' + SRC[r.k].color + '"><span class="adm-share-bar"><i style="width:' + share + '%"></i></span><span>' + share + '%</span></span></td><td>' + r.n + '</td></tr>';
    }).join('') + '</tbody><tfoot><tr><th>All sources</th><td>' + usd(tot) + '</td>' + (RANGE ? '<td>' + usd(totPrev) + '</td><td>' + (totPrev ? '<span class="adm-chg ' + (tot >= totPrev ? 'up' : 'down') + '">' + (tot >= totPrev ? '↑ ' : '↓ ') + Math.abs(Math.round((tot - totPrev) / totPrev * 100)) + '%</span>' : '') + '</td>' : '') + '<td></td><td>' + totN + '</td></tr></tfoot>';
  }
  function drawSourceChart() {
    var el = $('agSrcChart');
    if (!el || !DB || $('adm-panel-commissions').hidden) return;
    var months = monthKeys(RANGE === 365 || !RANGE ? 12 : 6), idx = {};
    months.forEach(function (m, i) { idx[m.k] = i; });
    var series = {};
    DB.pays.forEach(function (p) {
      var i = idx[monthKey(p.paid_on)]; if (i == null) return;
      var c = DB.byId[p.commission_id], k = c ? srcK(c.source) : 'other';
      if (!series[k]) series[k] = months.map(function () { return 0; });
      series[k][i] += num(p.amount_usd);
    });
    var keys = SOURCE_KEYS.filter(function (k) { return series[k]; });
    if (!keys.length) { el.innerHTML = '<div class="ag-chart-empty">' + svg(ICON.coin, 22) + '<b>No client payments yet</b><span>Record a payment on a commission and it shows here by source.</span></div>'; return; }
    lineChart(el, months.map(function (m) { return m.label; }), keys.map(function (k) { return { name: SRC[k].name, color: SRC[k].color, values: series[k] }; }));
  }

  // ---------- Commission detail
  function logIcon(t) {
    t = String(t).toLowerCase();
    if (/paid|deposit|payment/.test(t)) return ['ok', ICON.coin];
    if (/deliver/.test(t)) return ['ok', ICON.check];
    if (/review|sent/.test(t)) return ['warn', ICON.eye];
    if (/deadline|late/.test(t)) return ['err', ICON.alert];
    if (/call|consult/.test(t)) return ['', ICON.phone];
    return ['', ICON.note];
  }
  function activity(c) {
    var ev = c.notesList.map(function (n) { return { t: n.body, s: (n.created_by_name ? n.created_by_name + ' · ' : '') + fmtDay(n.created_at), at: n.created_at }; });
    c.payments.forEach(function (p) { ev.push({ t: 'Client paid ' + usd(p.amount_usd) + (p.note ? ' (' + p.note + ')' : ''), s: fmtDay(p.paid_on), at: p.paid_on + 'T12:00:00', kind: 'payment' }); });
    if (c.delivered_at) ev.push({ t: 'Delivered', s: fmtDay(c.delivered_at), at: c.delivered_at });
    ev.push({ t: 'Commission added', s: fmtDay(c.created_at), at: c.created_at });
    ev.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    return ev.map(function (e) { var ic = logIcon(e.t); return '<div class="adm-work-item' + (ic[0] ? ' tone-' + ic[0] : '') + '"><span class="adm-work-ico">' + svg(ic[1], 16) + '</span><span class="adm-work-text">' + esc(e.t) + '<small>' + esc(e.s) + '</small></span></div>'; }).join('');
  }
  function renderCommission() {
    var sec = $('adm-panel-commission'), c = cmByRef(CUR_CM);
    var back = '<button type="button" class="ag-back" data-panel="commissions">' + svg('<path d="m15 18-6-6 6-6"/>', 16) + 'Commissions</button>';
    if (!c) { sec.innerHTML = back + '<p class="ag-empty">That commission was not found.</p>'; return; }
    var margin = c.price - c.costUsd, pct = c.price ? Math.round(margin / c.price * 100) : 0, paidPct = c.price ? Math.min(100, Math.round(c.paid / c.price * 100)) : 0;
    var svcSet = (DB.settings.services || []).filter(function (s) { return s.n === c.service; })[0];
    var h = back + '<div class="dash-head adm-home-head ag-dhead"><div class="ag-main ag-title-row">' + tile(c.service, 'lg') + '<div><h1>' + esc(c.title) + '</h1>' +
      '<div class="ag-subline">' + esc(c.ref + ' · ' + c.service + (c.client ? ' · ' + c.client : '') + ' ·') + ' ' + src(c.source) + '</div></div></div>' +
      '<div class="ag-tools"><div class="adm-seg" role="group" aria-label="Stage" id="agStageSeg">' + STAGES.map(function (s, i) { return '<button type="button" data-i="' + i + '" class="' + (i === c.stage ? 'active' : '') + '">' + s + '</button>'; }).join('') + '</div>' +
      '<button class="btn btn-ghost adm-btn-sm" type="button" data-ag-edit-cm="' + esc(c.id) + '">Edit</button></div></div>';
    h += '<div class="adm-hp adm-kpi"><div class="adm-kpi-grid">' +
      kpi('Client price', usd(c.price), '', '', svcSet && svcSet.floor ? 'Floor ' + usd(svcSet.floor) + (c.price < svcSet.floor ? ' <span class="ag-warn">(under)</span>' : '') : '') +
      kpi('Client paid', usd(c.paid), c.paid + 0.005 < c.price ? 'of ' + usd(c.price) : c.price ? 'in full' : '', '<span class="adm-share" style="--pf:var(--price);justify-content:flex-start"><span class="adm-share-bar" style="width:120px"><i style="width:' + paidPct + '%"></i></span><span>' + paidPct + '%</span></span>') +
      kpi('Dev cost', c.costUsd || !c.costRbx ? usd(c.costUsd) : rbx(c.costRbx), c.costUsd && c.costRbx ? '+ ' + rbx(c.costRbx) : '', '', c.team.length ? c.team.length + ' dev' + (c.team.length > 1 ? 's' : '') : 'No dev yet') +
      kpi('Margin', usd(margin), c.price ? pct + '%' : '', '', c.costRbx ? 'Robux paid from the group' : '') + '</div></div>';
    h += '<div class="ag-grid"><div class="ag-col">' +
      '<div class="adm-hp"><div class="adm-hp-head"><div class="adm-hp-title"><h2>Brief</h2></div>' + (c.thread_url ? '<a class="adm-hp-link" href="' + esc(c.thread_url) + '" target="_blank" rel="noopener">' + (c.source === 'bbb' ? 'Open on BuiltByBit' : c.source === 'x' ? 'Open on X' : 'Open the conversation') + '</a>' : '') + '</div>' +
      '<p class="ag-brief' + (c.brief ? '' : ' ag-dim') + '">' + (c.brief ? esc(c.brief) : 'No brief yet. Use Edit to add one.') + '</p>' +
      '<dl class="ag-kv"><dt>Due</dt><dd class="' + (c.tone === 'late' ? 'ag-late' : '') + '">' + (c.due_on ? esc(fmtDay(c.due_on)) : 'No date') + '</dd><dt>Started</dt><dd>' + esc(fmtDay(c.created_at)) + '</dd>' + (c.delivered_at ? '<dt>Delivered</dt><dd>' + esc(fmtDay(c.delivered_at)) + '</dd>' : '') + '</dl></div>' +
      '<div class="adm-hp adm-ro"><div class="adm-hp-head"><div class="adm-hp-title"><h2>Devs</h2><span>' + (c.team.length || '') + '</span></div><button class="btn btn-ghost adm-btn-sm" type="button" data-ag-assign="' + esc(c.id) + '">Add dev</button></div><div class="ag-list">' +
      (c.team.length ? c.team.map(function (a) {
        var st = { paid: '<span class="ag-chip ok"><i></i>Paid ' + esc(fmtDay(a.paid_at)) + '</span>', owed: '<button class="btn btn-primary adm-btn-sm" type="button" data-ag-pay="' + esc(a.id) + '">Mark paid</button>', client: '<span class="ag-chip warn"><i></i>Waiting on client</span>', waiting: '<span class="ag-chip"><i></i>After delivery</span>' }[a.state];
        return '<div class="ag-row is-static ag-devrow"><span class="ag-main">' + tile(a.dev.skills && a.dev.skills[0] || 'Scripting') + '<span class="ag-name"><span class="ag-t">' + esc(a.dev.name) + '</span><span class="ag-m">' + esc(a.part || (a.dev.skills || []).join(', ')) + '</span></span></span>' +
          '<span class="ag-amt">' + (num(a.cost_usd) ? usd(a.cost_usd) : '') + (num(a.cost_robux) ? (num(a.cost_usd) ? '<small>+ ' + rbx(a.cost_robux) + '</small>' : rbx(a.cost_robux)) : '') + (!num(a.cost_usd) && !num(a.cost_robux) ? '<span class="ag-dim">$0</span>' : '') + '</span>' +
          '<span class="ag-r ag-rowacts">' + st + (a.paid_at ? '' : '<button type="button" class="ag-iconbtn ag-hover-act" data-ag-unassign="' + esc(a.id) + '" aria-label="Remove ' + esc(a.dev.name) + '">' + svg(ICON.x, 14) + '</button>') + '</span></div>';
      }).join('') : '<p class="ag-empty">No devs on this yet</p>') + '</div></div>' +
      '<div class="adm-hp adm-ro"><div class="adm-hp-head"><div class="adm-hp-title"><h2>Client payments</h2><span>' + (c.payments.length || '') + '</span></div><button class="btn btn-ghost adm-btn-sm" type="button" data-ag-payment="' + esc(c.id) + '">Record payment</button></div><div class="ag-list">' +
      (c.payments.length ? c.payments.map(function (p) {
        return '<div class="ag-row is-static ag-payrow"><span class="ag-main"><span class="ag-tile sm" style="--sv:var(--price)">' + svg(ICON.coin) + '</span><span class="ag-name"><span class="ag-t">' + esc(fmtDay(p.paid_on)) + '</span>' + (p.note ? '<span class="ag-m">' + esc(p.note) + '</span>' : '') + '</span></span>' +
          '<span class="ag-amt">' + usd(p.amount_usd) + '</span><span class="ag-r"><button type="button" class="ag-iconbtn ag-hover-act" data-ag-unpay="' + esc(p.id) + '" aria-label="Remove payment">' + svg(ICON.x, 14) + '</button></span></div>';
      }).join('') : '<p class="ag-empty">No payments recorded</p>') + '</div></div></div>' +
      '<aside class="adm-hp adm-work"><div class="adm-hp-head"><div class="adm-hp-title"><h2>Activity</h2></div></div>' +
      '<form class="adm-work-add" id="agNoteForm" autocomplete="off"><input type="text" id="agNoteIn" maxlength="1000" placeholder="Add a note" aria-label="Add a note" /><kbd aria-hidden="true">Enter</kbd></form>' +
      '<div class="adm-work-list">' + activity(c) + '</div></aside></div>';
    sec.innerHTML = h;
    $('agNoteForm').addEventListener('submit', function (e) {
      e.preventDefault(); var v = $('agNoteIn').value.trim(); if (!v) return;
      $('agNoteIn').disabled = true;
      save(sb().from('agency_notes').insert({ commission_id: c.id, body: v.slice(0, 1000), created_by_name: me() || null })).catch(function () { var i = $('agNoteIn'); if (i) i.disabled = false; });
    });
    $('agStageSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-i]'); if (!b) return;
      var st = +b.getAttribute('data-i'); if (st === c.stage) return;
      save(sb().from('agency_commissions').update({ stage: st, delivered_at: st === 3 ? (c.delivered_at || new Date().toISOString()) : null }).eq('id', c.id), st === 3 ? 'Marked delivered' : 'Stage saved');
    });
  }
  function openCommission(ref, opts) {
    CUR_CM = ref;
    if (typeof window.admShowPanel === 'function') window.admShowPanel('commission', { extra: ref, skipUrl: opts && opts.skipUrl });
  }

  // ---------- Leads
  function renderLeads() {
    syncRange('agLeadRange');
    var open = openLeads(), cur = periodStats(false).leads, prev = periodStats(true).leads;
    var replied = cur.filter(function (l) { return l.replied_at; }), avgH = replied.length ? sum(replied, function (l) { return (new Date(l.replied_at) - new Date(l.created_at)) / 3600000; }) / replied.length : null;
    var within = replied.length ? Math.round(replied.filter(function (l) { return new Date(l.replied_at) - new Date(l.created_at) <= DAY; }).length / replied.length * 100) : null;
    var done = cur.filter(function (l) { return l.status === 'converted' || l.status === 'declined'; }), conv = cur.filter(function (l) { return l.status === 'converted'; });
    var booked = sum(conv, function (l) { var c = l.commission_id && DB.byId[l.commission_id]; return c ? c.price : 0; });
    var oldest = open.length ? open[open.length - 1] : null;
    $('agLeadKpi').innerHTML =
      kpi('Open leads', open.length, '', cur.length ? cur.length + ' new ' + (RANGE ? (RANGE === 365 ? 'this year' : 'in ' + RANGE + ' days') : 'in total') + (RANGE && prev.length ? ', ' + prev.length + ' before' : '') : '', oldest ? 'Oldest ' + ago(oldest.created_at).toLowerCase() : 'Nothing waiting') +
      kpi('Reply time', avgH == null ? '-' : avgH < 1 ? Math.round(avgH * 60) + 'm' : avgH < 48 ? (Math.round(avgH * 10) / 10) + 'h' : Math.round(avgH / 24) + 'd', avgH == null ? '' : 'average', '', within == null ? 'Mark leads replied to track this' : within + '% within 24h') +
      kpi('Converted', done.length ? Math.round(conv.length / done.length * 100) + '%' : '-', done.length ? conv.length + ' of ' + done.length : '', '', booked ? usd(booked) + ' booked' : 'Of leads you closed') +
      kpi('Under the floor', open.filter(function (l) { return l.under; }).length, '', '', switchOn('Flag leads under the floor', true) ? 'Flagged automatically' : 'Flagging is off in Services');
    var rows = LEAD_VIEW === 'open' ? open : DB.leads.filter(function (l) { return l.status === (LEAD_VIEW === 'won' ? 'converted' : 'declined'); });
    $('agLeadCount').textContent = rows.length || '';
    var h = rows.length ? '<div class="ag-lh ag-leads-cols"><span>Lead</span><span>Service</span><span>Budget</span><span>Wants it by</span><span>Status</span><span class="ag-r">Received</span></div>' : '';
    rows.forEach(function (l) {
      var k = srcK(l.source), st = LEAD_STATUS[l.status] || ['', ''];
      var stLabel = l.status === 'consultation' && l.consultation_at ? 'Consultation ' + fmtDay(l.consultation_at) : st[0];
      var c = l.commission_id && DB.byId[l.commission_id];
      h += '<button type="button" class="ag-row ag-leads-cols" data-ag-lead="' + esc(l.id) + '" aria-expanded="' + (LEAD_OPEN === l.id) + '">' +
        '<span class="ag-main">' + srcTile(k) + '<span class="ag-name"><span class="ag-t">' + esc(l.title) + '</span><span class="ag-m">' + esc((l.client ? l.client + ' · ' : '') + SRC[k].name) + '</span></span></span>' +
        '<span class="ag-c ag-hide-sm ag-svc">' + tile(l.service, 'sm') + '<span>' + esc(l.service) + '</span></span>' +
        '<span class="ag-amt ag-hide-sm ag-left' + (l.under ? ' ag-warn' : l.budget ? '' : ' plain') + '">' + (l.budget ? esc(l.budget) : '<span class="ag-dim">Not given</span>') + (l.under ? '<small class="ag-warn">Under the ' + usd(l.floor) + ' floor</small>' : nobodyFor(l.service) ? '<small class="ag-warn">Nobody on the team for this</small>' : '') + '</span>' +
        '<span class="ag-c ag-hide-sm">' + esc(l.wants_by || '') + '</span>' +
        '<span class="ag-hide-sm"><span class="ag-chip ' + st[1] + '"><i></i>' + esc(stLabel) + '</span></span>' +
        '<span class="ag-when">' + esc(fmtDay(l.created_at)) + '<small>' + esc(c ? c.ref : ago(l.created_at)) + '</small></span></button>';
      if (LEAD_OPEN === l.id) {
        h += '<div class="ag-answers"><dl>' +
          (l.details ? '<dt>What they need</dt><dd>' + esc(l.details) + '</dd>' : '') +
          '<dt>Service</dt><dd>' + esc(l.service === 'Full game' ? 'Full game development' : l.service) + '</dd><dt>Budget</dt><dd>' + esc(l.budget || 'Not given') + '</dd>' +
          (l.wants_by ? '<dt>Wants it by</dt><dd>' + esc(l.wants_by) + '</dd>' : '') + (l.existing_game ? '<dt>Existing game</dt><dd>' + esc(l.existing_game) + '</dd>' : '') +
          (l.refs ? '<dt>References</dt><dd>' + esc(l.refs) + '</dd>' : '') + '<dt>From</dt><dd>' + esc((l.client || 'Unknown') + ' on ' + SRC[k].name) + '</dd>' +
          (l.replied_at ? '<dt>Replied</dt><dd>' + esc(fmtDay(l.replied_at)) + '</dd>' : '') + '</dl><div class="ag-tools">' +
          (l.status === 'converted' ? (c ? '<button class="btn btn-primary adm-btn-sm" type="button" data-ag-cm="' + esc(c.ref) + '">Open ' + esc(c.ref) + '</button>' : '') :
            '<button class="btn btn-primary adm-btn-sm" type="button" data-ag-convert="' + esc(l.id) + '">Make it a commission</button>' +
            (l.status === 'new' ? '<button class="btn btn-ghost adm-btn-sm" type="button" data-ag-lead-set="replied" data-id="' + esc(l.id) + '">Mark replied</button>' : '') +
            '<button class="btn btn-ghost adm-btn-sm" type="button" data-ag-consult="' + esc(l.id) + '">' + (l.consultation_at ? 'Move consultation' : 'Book consultation') + '</button>' +
            (l.status === 'declined' ? '<button class="btn btn-ghost adm-btn-sm" type="button" data-ag-lead-set="new" data-id="' + esc(l.id) + '">Reopen</button>' : '<button class="btn btn-ghost adm-btn-sm" type="button" data-ag-lead-set="declined" data-id="' + esc(l.id) + '">Decline</button>')) +
          '<button class="btn btn-ghost adm-btn-sm" type="button" data-ag-edit-lead="' + esc(l.id) + '">Edit</button></div></div>';
      }
    });
    if (!rows.length) h = '<div class="ag-empty-cta">' + svg(ICON.inbox, 22) + '<b>' + (LEAD_VIEW === 'open' ? 'No open leads' : LEAD_VIEW === 'won' ? 'No converted leads yet' : 'No declined leads') + '</b>' + (LEAD_VIEW === 'open' ? '<span>Add enquiries from BuiltByBit, Discord, X or the site to track them here.</span><button class="btn btn-primary adm-btn-sm" type="button" data-ag-new="lead">Add lead</button>' : '') + '</div>';
    $('agLeadList').innerHTML = h;
    var pool = cur.length ? cur : DB.leads;
    $('agLeadPoolSub').textContent = $('agLeadPoolSub2').textContent = cur.length ? (RANGE ? 'Last ' + (RANGE === 365 ? 'year' : RANGE + ' days') : 'All time') : 'All time';
    var by = {}; pool.forEach(function (l) { var k = srcK(l.source); by[k] = (by[k] || 0) + 1; });
    $('agLeadDonut').innerHTML = donut(SOURCE_KEYS.map(function (k) { return { label: SRC[k].name, value: by[k] || 0, color: SRC[k].color, display: by[k] || 0 }; }), String(pool.length), 'leads', 'No leads yet');
    var bs = {}; pool.forEach(function (l) { bs[l.service] = (bs[l.service] || 0) + 1; });
    $('agLeadSvcDonut').innerHTML = donut(Object.keys(bs).sort(function (a, b) { return bs[b] - bs[a]; }).map(function (k) { return { label: k, value: bs[k], color: svcOf(k).c, display: bs[k] }; }), String(pool.length), 'leads', 'No leads yet');
  }
  function nobodyFor(service) { var sk = svcOf(service).skill; return sk && !DB.devs.some(function (d) { return d.status === 'team' && (d.skills || []).indexOf(sk) >= 0; }); }

  // ---------- Devs
  function devStats(d) {
    var mine = DB.asg.filter(function (a) { return a.dev_id === d.id && a.c; });
    var active = mine.filter(function (a) { return a.c.stage < 3; }).length;
    var delivered = mine.filter(function (a) { return a.c.stage === 3; });
    var timed = delivered.filter(function (a) { return a.c.due_on && a.c.delivered_at; });
    var onTime = timed.length ? Math.round(timed.filter(function (a) { return parseDay(String(a.c.delivered_at).slice(0, 10)) <= parseDay(a.c.due_on) || new Date(a.c.delivered_at) <= new Date(parseDay(a.c.due_on).getTime() + DAY); }).length / timed.length * 100) : null;
    var owed = sum(mine.filter(function (a) { return a.state === 'owed'; }), function (a) { return a.cost_usd; });
    return { active: active, delivered: delivered.length, onTime: onTime, owed: owed };
  }
  function renderDevs() {
    var team = DB.devs.filter(function (d) { return d.status === 'team'; }), cand = DB.devs.filter(function (d) { return d.status !== 'team'; });
    var stats = {}; team.forEach(function (d) { stats[d.id] = devStats(d); });
    var busy = team.filter(function (d) { return stats[d.id].active; }).length, owed = owedList();
    var recent = DB.cms.filter(function (c) { return c.stage === 3 && c.due_on && c.delivered_at && Date.now() - new Date(c.delivered_at) < 90 * DAY; });
    var onTime = recent.length ? Math.round(recent.filter(function (c) { return new Date(c.delivered_at) <= new Date(parseDay(c.due_on).getTime() + DAY); }).length / recent.length * 100) : null;
    $('agDevKpi').innerHTML =
      kpi('On the team', team.length, '', '', cand.length + ' candidate' + (cand.length === 1 ? '' : 's')) +
      kpi('Working now', busy, 'of ' + team.length, '', (team.length - busy) + ' free for new work') +
      kpi('On time', onTime == null ? '-' : onTime + '%', 'last 90 days', '', DB.cms.filter(function (c) { return c.tone === 'late'; }).length + ' late right now') +
      kpi('Owed', usd(sum(owed, function (a) { return a.cost_usd; })), '', '', owed.length + ' payout' + (owed.length === 1 ? '' : 's') + ' waiting');
    $('agDevCards').innerHTML = team.map(function (d) {
      var s = stats[d.id];
      return '<button type="button" class="ag-dev" data-ag-edit-dev="' + esc(d.id) + '"><span class="ag-dev-head">' + tile(d.skills[0] || 'Scripting', 'lg') + '<span class="ag-name"><b>' + esc(d.name) + '</b><span class="ag-m">' + esc((d.skills || []).join(', ') + (d.pay_method ? ' · ' + d.pay_method : '')) + '</span></span>' +
        '<span class="ag-dev-state' + (s.active ? ' busy' : '') + '"><i></i>' + (s.active ? 'Working' : 'Free') + '</span></span>' +
        '<span class="ag-dev-stats"><span><b>' + s.active + '</b><span>Active</span></span><span><b>' + s.delivered + '</b><span>Delivered</span></span><span><b class="' + (s.onTime != null && s.onTime < 85 ? 'ag-warn' : '') + '">' + (s.onTime == null ? '-' : s.onTime + '%') + '</b><span>On time</span></span></span>' +
        '<span class="ag-dev-foot"><span class="' + (d.rate ? '' : 'ag-dim') + '">' + esc(d.rate || 'Rate not set') + '</span>' + (s.owed ? '<span>Owed <b>' + usd(s.owed) + '</b></span>' : '') + '</span></button>';
    }).join('') + '<button type="button" class="ag-dev ag-dev-add" data-ag-new="dev">' + svg(ICON.plus, 22) + '<b>Add a dev</b><span>' + cand.length + ' candidate' + (cand.length === 1 ? '' : 's') + ' waiting</span></button>';
    $('agCandCount').textContent = cand.length || '';
    $('agCandList').innerHTML = cand.length ? cand.map(function (d) {
      return '<div class="ag-row is-static ag-candrow"><span class="ag-main">' + tile(d.skills[0] || 'Scripting', 'sm') + '<span class="ag-t">' + esc(d.name) + '</span></span>' +
        '<span class="ag-c">' + esc((d.skills || []).join(', ')) + '</span><span class="ag-r ag-rowacts"><button class="btn btn-ghost adm-btn-sm ag-hover-act" type="button" data-ag-team="' + esc(d.id) + '">Add to team</button><button type="button" class="ag-iconbtn ag-hover-act" data-ag-edit-dev="' + esc(d.id) + '" aria-label="Edit ' + esc(d.name) + '">' + svg(ICON.note, 14) + '</button></span></div>';
    }).join('') : '<p class="ag-empty">No candidates</p>';
    $('agCoverage').innerHTML = SKILLS.map(function (s) {
      var a = DB.devs.filter(function (d) { return d.status === 'team' && (d.skills || []).indexOf(s) >= 0; }).length, b = DB.devs.filter(function (d) { return d.status !== 'team' && (d.skills || []).indexOf(s) >= 0; }).length;
      var bars = ''; for (var i = 0; i < a; i++) bars += '<i></i>'; for (var j = 0; j < b; j++) bars += '<i class="cand"></i>';
      var txt = a ? a + ' on the team' + (b ? ', ' + b + ' more' : '') : b ? b + ' candidate' + (b > 1 ? 's' : '') : 'Nobody yet';
      return '<div class="ag-cov" style="--sv:' + svcOf(s).c + '">' + tile(s, 'sm') + '<b>' + esc(s) + '</b><em class="' + (a ? '' : 'ag-warn') + '">' + txt + '</em>' + (bars ? '<span class="ag-covbar">' + bars + '</span>' : '') + '</div>';
    }).join('');
  }

  // ---------- Payouts
  function renderPayouts() {
    var owed = owedList(), paid = DB.asg.filter(function (a) { return a.paid_at && a.c; }).sort(function (a, b) { return new Date(b.paid_at) - new Date(a.paid_at); });
    var nowD = new Date(), m0 = new Date(nowD.getFullYear(), nowD.getMonth(), 1).getTime(), m1 = new Date(nowD.getFullYear(), nowD.getMonth() - 1, 1).getTime();
    var thisM = paid.filter(function (a) { return new Date(a.paid_at) >= m0; }), lastM = paid.filter(function (a) { var t = new Date(a.paid_at).getTime(); return t >= m1 && t < m0; });
    var pm = sum(thisM, function (a) { return a.cost_usd; }), pl = sum(lastM, function (a) { return a.cost_usd; }), prb = sum(thisM, function (a) { return a.cost_robux; });
    var timed = paid.filter(function (a) { return a.c.delivered_at && Date.now() - new Date(a.paid_at) < 90 * DAY; });
    var avgDays = timed.length ? sum(timed, function (a) { return Math.max(0, (new Date(a.paid_at) - new Date(a.c.delivered_at)) / DAY); }) / timed.length : null;
    var waiting = DB.asg.filter(function (a) { return a.c && a.state === 'client'; });
    $('agPayKpi').innerHTML =
      kpi('Owed now', usd(sum(owed, function (a) { return a.cost_usd; })), owed.length + ' payout' + (owed.length === 1 ? '' : 's'), '', sum(owed, function (a) { return a.cost_robux; }) ? '+ ' + rbx(sum(owed, function (a) { return a.cost_robux; })) + ' in Robux' : 'Client money already in') +
      kpi('Paid this month', usd(pm), thisM.length + ' payout' + (thisM.length === 1 ? '' : 's'), pl ? (function () { var p = Math.round((pm - pl) / pl * 100); return p ? '<span class="adm-kpi-delta ' + (p > 0 ? 'up' : 'down') + '">' + (p > 0 ? '↑ ' : '↓ ') + Math.abs(p) + '%</span> vs last month' : ''; })() : '', prb ? '+ ' + rbx(prb) + ' in Robux' : '') +
      kpi('Waiting on clients', waiting.length, waiting.length ? usd(sum(waiting, function (a) { return a.cost_usd; })) : '', '', 'Delivered, client not fully paid') +
      kpi('Time to pay', avgDays == null ? '-' : (Math.round(avgDays * 10) / 10) + ' days', avgDays == null ? '' : 'average', '', 'From delivery to dev');
    var list = PAY_VIEW === 'owed' ? owed : paid;
    $('agPayTitle').textContent = PAY_VIEW === 'owed' ? 'To pay' : 'Paid';
    $('agPayCount').textContent = list.length || '';
    var h = list.length ? '<div class="ag-lh ag-pay-cols"><span>Dev</span><span>Commission</span><span>Client paid on</span><span class="ag-r">Amount</span><span></span></div>' : '';
    list.forEach(function (a) {
      h += '<div class="ag-row is-static ag-pay-cols"><span class="ag-main">' + tile(a.dev.skills && a.dev.skills[0] || 'Scripting') + '<span class="ag-name"><span class="ag-t">' + esc(a.dev.name) + '</span><span class="ag-m">' + esc((a.part || '') + (a.dev.pay_method ? (a.part ? ' · ' : '') + a.dev.pay_method : '')) + '</span></span></span>' +
        '<span class="ag-c ag-hide-sm ag-link" data-ag-cm="' + esc(a.c.ref) + '">' + esc(a.c.title) + '<small>' + esc(a.c.ref) + '</small></span><span class="ag-hide-sm">' + src(a.c.source) + '</span>' +
        '<span class="ag-amt">' + (num(a.cost_usd) ? usd(a.cost_usd) : '') + (num(a.cost_robux) ? (num(a.cost_usd) ? '<small>+ ' + rbx(a.cost_robux) + '</small>' : rbx(a.cost_robux)) : '') + (!num(a.cost_usd) && !num(a.cost_robux) ? '$0' : '') + '</span>' +
        '<span class="ag-r">' + (PAY_VIEW === 'owed' ? '<button class="btn btn-primary adm-btn-sm" type="button" data-ag-pay="' + esc(a.id) + '">Mark paid</button>' : '<span class="ag-c">' + esc(fmtDay(a.paid_at)) + '</span>') + '</span></div>';
    });
    if (!list.length) h = '<div class="ag-empty-cta">' + svg(ICON.wallet, 22) + '<b>' + (PAY_VIEW === 'owed' ? 'Everyone is paid' : 'No payouts yet') + '</b><span>A dev shows here once their commission is delivered and the client has paid in full.</span></div>';
    $('agPayList').innerHTML = h;
    var months = monthKeys(6), idx = {}, vals = months.map(function () { return 0; });
    months.forEach(function (m, i) { idx[m.k] = i; });
    paid.forEach(function (a) { var i = idx[monthKey(a.paid_at)]; if (i != null) vals[i] += num(a.cost_usd); });
    var max = Math.max.apply(null, vals.concat([1]));
    $('agPayBars').innerHTML = vals.some(Boolean) ? months.map(function (m, i) {
      return '<div class="ag-bar' + (i === months.length - 1 ? ' now' : '') + '"><i style="height:' + Math.max(2, Math.round(vals[i] / max * 100)) + '%">' + (vals[i] ? '<b>' + usd(Math.round(vals[i])) + '</b>' : '') + '</i><span>' + m.label + '</span></div>';
    }).join('') : '<p class="ag-empty" style="align-self:center;grid-column:1/-1">No payouts yet</p>';
  }
  function exportPayouts() {
    var rows = [['Dev', 'Paid by', 'Commission', 'Part', 'We pay ($)', 'We pay (R$)', 'Status', 'Paid on']];
    DB.asg.filter(function (a) { return a.c; }).forEach(function (a) {
      rows.push([a.dev.name, a.dev.pay_method || '', a.c.ref + ' ' + a.c.title, a.part || '', num(a.cost_usd), num(a.cost_robux), { paid: 'Paid', owed: 'Owed', client: 'Waiting on client', waiting: 'After delivery' }[a.state], a.paid_at ? isoDay(new Date(a.paid_at)) : '']);
    });
    var csv = rows.map(function (r) { return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'agency-payouts-' + isoDay(new Date()) + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- Services
  function marginOf(s) {
    if (s.floor && s.costUsd != null && s.costUsd !== '') { var m = num(s.floor) - num(s.costUsd); return { text: usd(m), pct: Math.max(0, Math.round(m / num(s.floor) * 100)), thin: m / num(s.floor) < 0.25 }; }
    if (s.margin) return { text: s.margin, pct: s.marginPct || 0, thin: !!s.thin };
    return null;
  }
  function renderServices() {
    var list = DB.settings.services || [];
    var h = '<div class="ag-lh ag-services-cols"><span>Service</span><span>Price</span><span>We pay</span><span class="ag-r">Margin at the floor</span><span class="ag-r">On</span></div>';
    list.forEach(function (s, i) {
      var sk = svcOf(s.n).skill, team = sk ? DB.devs.filter(function (d) { return d.status === 'team' && (d.skills || []).indexOf(sk) >= 0; }).length : null;
      var meta = !sk ? 'Scripting, building and UI from the team' : team ? team + ' dev' + (team > 1 ? 's' : '') + ' on the team' : '<span class="ag-warn">Nobody on the team yet</span>';
      var m = marginOf(s);
      h += '<div class="ag-row ag-services-cols' + (s.on ? '' : ' is-off') + '" data-ag-edit-svc="' + i + '" role="button" tabindex="0"><span class="ag-main">' + tile(s.n) + '<span class="ag-name"><span class="ag-t">' + esc(s.label || s.n) + '</span><span class="ag-m">' + meta + '</span></span></span>' +
        '<span class="ag-c ag-hide-sm' + (s.price ? ' ag-price' : ' ag-dim') + '">' + esc(s.price || 'Not set') + (s.sub ? '<small>' + esc(s.sub) + '</small>' : '') + '</span>' +
        '<span class="ag-c ag-hide-sm' + (s.cost ? '' : ' ag-dim') + '">' + esc(s.cost || (sk ? 'Not set' : 'Depends on the build')) + (s.costSub ? '<small>' + esc(s.costSub) + '</small>' : '') + '</span>' +
        '<span class="ag-margin ag-hide-sm' + (m && m.thin ? ' thin' : '') + '">' + (m ? '<span class="adm-share-bar" style="width:60px"><i style="width:' + m.pct + '%"></i></span>' + esc(m.text) : '') + '</span>' +
        '<span class="ag-r"><label class="switch" aria-label="Offer ' + esc(s.label || s.n) + '"><input type="checkbox" data-ag-svc="' + i + '"' + (s.on ? ' checked' : '') + ' /><span class="track"></span></label></span></div>';
    });
    $('agSvcList').innerHTML = h;
    $('agTiers').innerHTML = (DB.settings.tiers || []).map(function (t) { return '<div class="ag-tier"><div class="ag-tier-name">' + esc(t.name) + '</div><b>' + esc(t.usd) + '</b><span class="adm-rbx">' + esc(t.rbx) + '</span><ul><li>' + esc(t.len) + '</li><li>' + esc(t.rev) + '</li></ul></div>'; }).join('');
    $('agSettings').innerHTML = (DB.settings.switches || []).map(function (s, i) { return '<div class="ag-set"><span>' + esc(s[0]) + '</span><label class="switch" aria-label="' + esc(s[0]) + '"><input type="checkbox" data-ag-switch="' + i + '"' + (s[1] ? ' checked' : '') + ' /><span class="track"></span></label></div>'; }).join('');
  }
  function saveSettings(msg) {
    return save(sb().from('agency_data').update({ data: DB.settings, updated_at: new Date().toISOString() }).eq('id', 'settings'), msg || 'Saved');
  }

  // ---------- forms
  var DLG = null;
  function closeForm() { if (DLG) { DLG.hidden = true; DLG.innerHTML = ''; document.body.classList.remove('ag-dlg-open'); } }
  function field(f) {
    var id = 'agF_' + f.k, v = f.value == null ? '' : f.value, req = f.required ? ' required' : '';
    var lbl = '<span>' + esc(f.label) + (f.optional ? ' <em class="ag-opt">optional</em>' : '') + '</span>';
    var inner;
    if (f.type === 'select') inner = '<select id="' + id + '" name="' + f.k + '" class="adm-input" data-ag-csel' + req + '>' + f.options.map(function (o) { o = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(v) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    else if (f.type === 'textarea') inner = '<textarea id="' + id + '" name="' + f.k + '" class="adm-input adm-textarea" rows="' + (f.rows || 3) + '" maxlength="' + (f.max || 2000) + '" placeholder="' + esc(f.placeholder || '') + '"' + req + '>' + esc(v) + '</textarea>';
    else if (f.type === 'checks') inner = '<span class="ag-checks">' + f.options.map(function (o) { return '<label class="ag-check"><input type="checkbox" name="' + f.k + '" value="' + esc(o) + '"' + ((v || []).indexOf(o) >= 0 ? ' checked' : '') + ' /><span>' + esc(o) + '</span></label>'; }).join('') + '</span>';
    else inner = '<input id="' + id + '" name="' + f.k + '" class="adm-input" type="' + (f.type || 'text') + '" value="' + esc(v) + '"' + (f.type === 'number' ? ' min="0" step="' + (f.step || '0.01') + '" inputmode="decimal"' : '') + (f.max && f.type !== 'number' ? ' maxlength="' + f.max + '"' : '') + ' placeholder="' + esc(f.placeholder || '') + '"' + (f.type === 'date' ? ' data-ag-cdate' : '') + req + ' />';
    return f.type === 'checks' ? '<div class="adm-field' + (f.wide ? ' adm-field-wide' : '') + '">' + lbl + inner + '</div>' : '<label class="adm-field' + (f.wide ? ' adm-field-wide' : '') + '" for="' + id + '">' + lbl + inner + '</label>';
  }
  function openForm(o) {
    if (!DLG) { DLG = document.createElement('div'); DLG.className = 'pay-overlay ag-dlg-wrap'; DLG.hidden = true; document.body.appendChild(DLG);
      DLG.addEventListener('mousedown', function (e) { if (e.target === DLG) closeForm(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && DLG && !DLG.hidden) closeForm(); });
    }
    DLG.innerHTML = '<div class="pay-modal glass ag-dlg" role="dialog" aria-modal="true" aria-labelledby="agDlgTitle"><button class="pm-x" type="button" data-ag-close aria-label="Close">' + svg(ICON.x, 18) + '</button>' +
      '<h3 class="pay-title" id="agDlgTitle">' + esc(o.title) + '</h3>' + (o.sub ? '<p class="pay-sub">' + esc(o.sub) + '</p>' : '') +
      '<form class="ag-form" novalidate>' + o.fields.map(field).join('') + '<p class="ag-form-err" hidden></p><div class="ag-form-actions">' + (o.danger ? '<button class="btn btn-ghost adm-btn-sm ag-danger" type="button" data-ag-danger>' + esc(o.danger.label) + '</button>' : '') +
      '<span class="ag-grow"></span><button class="btn btn-ghost adm-btn-sm" type="button" data-ag-close>Cancel</button><button class="btn btn-primary adm-btn-sm" type="submit">' + esc(o.submit || 'Save') + '</button></div></form></div>';
    DLG.hidden = false; document.body.classList.add('ag-dlg-open');
    DLG.querySelectorAll('[data-ag-close]').forEach(function (b) { b.addEventListener('click', closeForm); });
    if (window.__coldSelect) DLG.querySelectorAll('select[data-ag-csel]').forEach(function (s) { try { window.__coldSelect(s); } catch (_) {} });
    if (window.__coldDate) DLG.querySelectorAll('input[data-ag-cdate]').forEach(function (s) { try { window.__coldDate(s); } catch (_) {} });
    var form = DLG.querySelector('form'), err = DLG.querySelector('.ag-form-err');
    if (o.danger) DLG.querySelector('[data-ag-danger]').addEventListener('click', function () { if (window.confirm(o.danger.confirm || 'Are you sure?')) { closeForm(); o.danger.run(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = {};
      o.fields.forEach(function (f) {
        if (f.type === 'checks') { v[f.k] = Array.prototype.map.call(form.querySelectorAll('input[name="' + f.k + '"]:checked'), function (x) { return x.value; }); return; }
        var el = form.elements[f.k]; var s = el ? String(el.value).trim() : '';
        v[f.k] = f.type === 'number' ? (s === '' ? null : Number(s)) : s === '' ? null : s;
      });
      var bad = o.fields.filter(function (f) { return f.required && (v[f.k] == null || (Array.isArray(v[f.k]) && !v[f.k].length)); })[0]
        || o.fields.filter(function (f) { return f.type === 'number' && v[f.k] != null && (!isFinite(v[f.k]) || v[f.k] < 0); })[0];
      if (bad) {
        var missing = bad.required && (v[bad.k] == null || (Array.isArray(v[bad.k]) && !v[bad.k].length));
        err.hidden = false; err.textContent = missing ? (bad.type === 'checks' ? 'Pick at least one for ' + bad.label.toLowerCase() + '.' : bad.label + ' is needed.') : bad.label + ' must be a number of 0 or more.'; return;
      }
      var custom = o.validate && o.validate(v);
      if (custom) { err.hidden = false; err.textContent = custom; return; }
      var btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
      Promise.resolve(o.onSubmit(v)).then(function () { closeForm(); }, function (e2) { btn.disabled = false; err.hidden = false; err.textContent = 'Could not save: ' + ((e2 && e2.message) || 'error'); });
    });
    var first = DLG.querySelector('input:not([type=checkbox]), textarea, .csel-btn'); if (first) setTimeout(function () { first.focus(); }, 30);
  }
  function srcOptions() { return SOURCE_KEYS.map(function (k) { return [k, SRC[k].name]; }); }
  function commissionForm(c, lead) {
    c = c || {};
    var pre = lead ? { title: lead.title, client: lead.client, service: lead.service, source: lead.source, price_usd: lead.budget_usd, brief: lead.details } : c;
    openForm({
      title: c.id ? 'Edit ' + c.ref : lead ? 'Make ' + lead.ref + ' a commission' : 'New commission',
      fields: [
        { k: 'title', label: 'Title', required: true, max: 120, value: pre.title, wide: true, placeholder: 'Horror escape game' },
        { k: 'client', label: 'Client', max: 80, value: pre.client, placeholder: '@discord or BuiltByBit name', optional: true },
        { k: 'source', label: 'Came from', type: 'select', options: srcOptions(), value: pre.source || 'discord' },
        { k: 'service', label: 'Service', type: 'select', options: SERVICE_NAMES, value: pre.service || 'Scripting' },
        { k: 'price_usd', label: 'Client price ($)', type: 'number', required: true, value: pre.price_usd != null ? num(pre.price_usd) : '' },
        { k: 'due_on', label: 'Due', type: 'date', value: c.due_on || '', optional: true },
        { k: 'thread_url', label: 'Conversation link', type: 'url', max: 500, value: c.thread_url, placeholder: 'https://', optional: true },
        { k: 'brief', label: 'Brief', type: 'textarea', max: 4000, rows: 4, value: pre.brief, wide: true, optional: true }
      ],
      validate: function (v) { if (v.thread_url && !/^https?:\/\//i.test(v.thread_url)) return 'The conversation link must start with https://'; },
      submit: c.id ? 'Save' : 'Add commission',
      danger: c.id ? { label: 'Delete', confirm: 'Delete ' + c.ref + ' with its payments, devs and notes? This cannot be undone.', run: function () { save(sb().from('agency_commissions').delete().eq('id', c.id), 'Commission deleted').then(function () { window.admShowPanel && window.admShowPanel('commissions'); }); } } : null,
      onSubmit: function (v) {
        var row = { title: v.title, client: v.client, source: v.source, service: v.service, price_usd: v.price_usd || 0, due_on: v.due_on, thread_url: v.thread_url, brief: v.brief };
        if (c.id) return save(sb().from('agency_commissions').update(row).eq('id', c.id), 'Saved');
        if (lead) row.lead_id = lead.id;
        row.stage = 0;
        return q(sb().from('agency_commissions').insert(row).select('id,num').single()).then(function (made) {
          var after = lead ? q(sb().from('agency_leads').update({ status: 'converted', commission_id: made.id }).eq('id', lead.id)) : Promise.resolve();
          return after.then(function () { toast('Commission CM-' + made.num + ' added', true); return reload(); }).then(function () { openCommission('CM-' + made.num); });
        }, function (e) { toast('Could not save: ' + (e.message || 'error'), false); throw e; });
      }
    });
  }
  function leadForm(l) {
    l = l || {};
    openForm({
      title: l.id ? 'Edit ' + l.ref : 'Add lead',
      fields: [
        { k: 'title', label: 'What they want', required: true, max: 120, value: l.title, wide: true, placeholder: 'Tycoon game, full build' },
        { k: 'client', label: 'Who', max: 80, value: l.client, placeholder: '@name', optional: true },
        { k: 'source', label: 'Came from', type: 'select', options: srcOptions(), value: l.source || 'discord' },
        { k: 'service', label: 'Service', type: 'select', options: SERVICE_NAMES, value: l.service || 'Full game' },
        { k: 'budget', label: 'Budget as they said it', max: 60, value: l.budget, placeholder: '$600-800', optional: true },
        { k: 'budget_usd', label: 'Budget in $ (lowest)', type: 'number', value: l.budget_usd != null ? num(l.budget_usd) : '', optional: true },
        { k: 'wants_by', label: 'Wants it by', max: 60, value: l.wants_by, placeholder: 'Flexible', optional: true },
        { k: 'existing_game', label: 'Existing game', max: 120, value: l.existing_game, placeholder: 'Yes, 2k CCU', optional: true },
        { k: 'details', label: 'What they need', type: 'textarea', max: 2000, value: l.details, wide: true, optional: true },
        { k: 'refs', label: 'References', max: 500, value: l.refs, wide: true, placeholder: 'Links, images', optional: true }
      ],
      submit: l.id ? 'Save' : 'Add lead',
      danger: l.id ? { label: 'Delete', confirm: 'Delete ' + l.ref + '? This cannot be undone.', run: function () { LEAD_OPEN = null; save(sb().from('agency_leads').delete().eq('id', l.id), 'Lead deleted'); } } : null,
      onSubmit: function (v) {
        if (l.id) return save(sb().from('agency_leads').update(v).eq('id', l.id), 'Saved');
        v.status = 'new';
        return save(sb().from('agency_leads').insert(v).select('id').single(), 'Lead added').then(function (made) { LEAD_VIEW = 'open'; LEAD_OPEN = made && made.id; syncSeg('agLeadSeg', 'open'); renderLeads(); });
      }
    });
  }
  function devForm(d) {
    d = d || {};
    openForm({
      title: d.id ? d.name : 'Add a dev',
      fields: [
        { k: 'name', label: 'Name', required: true, max: 60, value: d.name },
        { k: 'status', label: 'Status', type: 'select', options: [['team', 'On the team'], ['candidate', 'Candidate']], value: d.status || 'team' },
        { k: 'skills', label: 'Does', type: 'checks', options: SKILLS, value: d.skills || [], wide: true, required: true },
        { k: 'rate', label: 'Charges', max: 80, value: d.rate, placeholder: '$15 a thumbnail', optional: true },
        { k: 'pay_method', label: 'Paid by', max: 40, value: d.pay_method, placeholder: 'PayPal, Robux, Wise', optional: true }
      ],
      submit: d.id ? 'Save' : 'Add dev',
      danger: d.id ? { label: 'Remove', confirm: 'Remove ' + d.name + '? Devs with work on a commission cannot be removed.', run: function () { save(sb().from('agency_devs').delete().eq('id', d.id), 'Removed'); } } : null,
      onSubmit: function (v) {
        if (d.id) return save(sb().from('agency_devs').update(v).eq('id', d.id), 'Saved');
        return save(sb().from('agency_devs').insert(v), 'Dev added');
      }
    });
  }
  function assignForm(c) {
    var devs = DB.devs.slice().sort(function (a, b) { return (a.status === 'team' ? 0 : 1) - (b.status === 'team' ? 0 : 1) || a.name.localeCompare(b.name); });
    if (!devs.length) { toast('Add a dev on the Devs page first', false); return; }
    openForm({
      title: 'Add a dev to ' + c.ref,
      fields: [
        { k: 'dev_id', label: 'Dev', type: 'select', options: devs.map(function (d) { return [d.id, d.name + (d.status === 'team' ? '' : ' (candidate)') + ' · ' + (d.skills || []).join(', ')]; }), wide: true },
        { k: 'part', label: 'Their part', max: 80, placeholder: 'Scripting, 8 UI frames', wide: true, optional: true },
        { k: 'cost_usd', label: 'We pay ($)', type: 'number', optional: true },
        { k: 'cost_robux', label: 'We pay (R$)', type: 'number', step: '1', optional: true }
      ],
      validate: function (v) { if (v.cost_robux != null && Math.round(v.cost_robux) !== v.cost_robux) return 'Robux must be a whole number.'; },
      submit: 'Add dev',
      onSubmit: function (v) { return save(sb().from('agency_assignments').insert({ commission_id: c.id, dev_id: v.dev_id, part: v.part, cost_usd: v.cost_usd || 0, cost_robux: v.cost_robux || 0 }), 'Dev added'); }
    });
  }
  function paymentForm(c) {
    var left = Math.max(0, c.price - c.paid);
    openForm({
      title: 'Record a client payment',
      sub: c.ref + ' · ' + usd(c.paid) + ' of ' + usd(c.price) + ' paid so far',
      fields: [
        { k: 'amount_usd', label: 'Amount ($)', type: 'number', required: true, value: left || '' },
        { k: 'paid_on', label: 'Paid on', type: 'date', required: true, value: isoDay(new Date()) },
        { k: 'note', label: 'Note', max: 200, placeholder: 'Deposit on BuiltByBit', wide: true, optional: true }
      ],
      validate: function (v) { if (!(v.amount_usd > 0)) return 'Amount must be more than 0.'; },
      submit: 'Record payment',
      onSubmit: function (v) { return save(sb().from('agency_payments').insert({ commission_id: c.id, amount_usd: v.amount_usd, paid_on: v.paid_on, note: v.note }), 'Payment recorded'); }
    });
  }
  function consultForm(l) {
    var cur = l.consultation_at ? new Date(l.consultation_at) : null;
    var local = cur ? new Date(cur.getTime() - cur.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    openForm({
      title: 'Consultation with ' + (l.client || l.title),
      fields: [{ k: 'when', label: 'When', type: 'datetime-local', required: true, value: local, wide: true }],
      submit: 'Save',
      onSubmit: function (v) { return save(sb().from('agency_leads').update({ status: 'consultation', consultation_at: new Date(v.when).toISOString() }).eq('id', l.id), 'Consultation booked'); }
    });
  }
  function serviceForm(i) {
    var s = DB.settings.services[i];
    openForm({
      title: s.label || s.n,
      fields: [
        { k: 'price', label: 'Price as shown', max: 60, value: s.price, placeholder: 'from $500', optional: true },
        { k: 'floor', label: 'Floor ($)', type: 'number', value: s.floor != null ? s.floor : '', optional: true },
        { k: 'sub', label: 'Price note', max: 80, value: s.sub, placeholder: 'Set price, CTR style', wide: true, optional: true },
        { k: 'cost', label: 'We pay', max: 60, value: s.cost, placeholder: '$15', optional: true },
        { k: 'costUsd', label: 'We pay in $ (for the margin)', type: 'number', value: s.costUsd != null ? s.costUsd : '', optional: true },
        { k: 'costSub', label: 'We pay note', max: 80, value: s.costSub, placeholder: 'Who and how', wide: true, optional: true }
      ],
      onSubmit: function (v) {
        Object.keys(v).forEach(function (k) { if (v[k] == null || v[k] === '') delete s[k]; else s[k] = v[k]; });
        if (s.costUsd != null) { delete s.margin; delete s.marginPct; delete s.thin; }
        return saveSettings('Service saved');
      }
    });
  }

  var RENDER = { commissions: renderCommissions, commission: renderCommission, leads: renderLeads, devs: renderDevs, payouts: renderPayouts, services: renderServices };
  function render(name) {
    if (!RENDER[name]) return;
    CUR_PANEL = name;
    waitThen(name, function () { if (CUR_PANEL === name) RENDER[name](); });
  }
  function syncSeg(id, v) { var g = $(id); if (g) g.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-v') === String(v)); }); }
  function syncRange(id) { syncSeg(id, RANGE); }

  // ---------- events (all scoped to Agency markup)
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t.closest || !t.closest('.ag') || !DB) return;
    var b;
    if (t.closest('[data-ag-export]')) { exportPayouts(); return; }
    if ((b = t.closest('[data-ag-new]'))) { var k = b.getAttribute('data-ag-new'); if (k === 'commission') commissionForm(); else if (k === 'lead') leadForm(); else if (k === 'dev') devForm(); return; }
    if ((b = t.closest('[data-ag-cm]'))) { openCommission(b.getAttribute('data-ag-cm')); return; }
    if ((b = t.closest('[data-ag-go]'))) { ev.preventDefault(); var g = b.getAttribute('data-ag-go'); if (/^CM-/.test(g)) openCommission(g); else if (window.admShowPanel) window.admShowPanel(g); return; }
    if ((b = t.closest('.ag-range button'))) { RANGE = +b.getAttribute('data-v'); if (CUR_PANEL && RENDER[CUR_PANEL]) RENDER[CUR_PANEL](); return; }
    if ((b = t.closest('#agCmSeg button'))) { CM_VIEW = b.getAttribute('data-v'); syncSeg('agCmSeg', CM_VIEW); renderCmList(); return; }
    if ((b = t.closest('#agLeadSeg button'))) { LEAD_VIEW = b.getAttribute('data-v'); LEAD_OPEN = null; syncSeg('agLeadSeg', LEAD_VIEW); renderLeads(); return; }
    if ((b = t.closest('#agPaySeg button'))) { PAY_VIEW = b.getAttribute('data-v'); syncSeg('agPaySeg', PAY_VIEW); renderPayouts(); return; }
    if ((b = t.closest('[data-ag-convert]'))) { commissionForm(null, DB.leads.filter(function (l) { return l.id === b.getAttribute('data-ag-convert'); })[0]); return; }
    if ((b = t.closest('[data-ag-consult]'))) { consultForm(DB.leads.filter(function (l) { return l.id === b.getAttribute('data-ag-consult'); })[0]); return; }
    if ((b = t.closest('[data-ag-edit-lead]'))) { leadForm(DB.leads.filter(function (l) { return l.id === b.getAttribute('data-ag-edit-lead'); })[0]); return; }
    if ((b = t.closest('[data-ag-lead-set]'))) {
      var st = b.getAttribute('data-ag-lead-set'), patch = { status: st };
      if (st === 'replied') patch.replied_at = new Date().toISOString();
      if (st === 'declined') LEAD_OPEN = null;
      save(sb().from('agency_leads').update(patch).eq('id', b.getAttribute('data-id')), st === 'declined' ? 'Lead declined' : st === 'new' ? 'Lead reopened' : 'Marked replied');
      return;
    }
    if ((b = t.closest('[data-ag-lead]'))) { var id = b.getAttribute('data-ag-lead'); LEAD_OPEN = LEAD_OPEN === id ? null : id; renderLeads(); return; }
    if ((b = t.closest('[data-ag-edit-cm]'))) { commissionForm(DB.byId[b.getAttribute('data-ag-edit-cm')]); return; }
    if ((b = t.closest('[data-ag-assign]'))) { assignForm(DB.byId[b.getAttribute('data-ag-assign')]); return; }
    if ((b = t.closest('[data-ag-payment]'))) { paymentForm(DB.byId[b.getAttribute('data-ag-payment')]); return; }
    if ((b = t.closest('[data-ag-unassign]'))) { if (window.confirm('Take this dev off the commission?')) save(sb().from('agency_assignments').delete().eq('id', b.getAttribute('data-ag-unassign')), 'Dev removed'); return; }
    if ((b = t.closest('[data-ag-unpay]'))) { if (window.confirm('Remove this client payment?')) save(sb().from('agency_payments').delete().eq('id', b.getAttribute('data-ag-unpay')), 'Payment removed'); return; }
    if ((b = t.closest('[data-ag-pay]'))) { b.disabled = true; save(sb().from('agency_assignments').update({ paid_at: new Date().toISOString() }).eq('id', b.getAttribute('data-ag-pay')), 'Marked paid').catch(function () { b.disabled = false; }); return; }
    if ((b = t.closest('[data-ag-team]'))) { save(sb().from('agency_devs').update({ status: 'team' }).eq('id', b.getAttribute('data-ag-team')), 'Added to the team'); return; }
    if ((b = t.closest('[data-ag-edit-dev]'))) { devForm(DB.devById[b.getAttribute('data-ag-edit-dev')]); return; }
    if (t.closest('.switch')) return;
    if ((b = t.closest('[data-ag-edit-svc]'))) { serviceForm(+b.getAttribute('data-ag-edit-svc')); return; }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var b = ev.target.closest && ev.target.closest('[data-ag-edit-svc]');
    if (b && ev.target === b && DB) { ev.preventDefault(); serviceForm(+b.getAttribute('data-ag-edit-svc')); }
  });
  document.addEventListener('change', function (ev) {
    if (!DB || !ev.target.getAttribute) return;
    var i = ev.target.getAttribute('data-ag-svc');
    if (i != null) { DB.settings.services[+i].on = ev.target.checked; saveSettings(ev.target.checked ? 'Service on' : 'Service off'); return; }
    var j = ev.target.getAttribute('data-ag-switch');
    if (j != null) { DB.settings.switches[+j][1] = ev.target.checked; saveSettings('Saved'); }
  });
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawSourceChart, 120); });

  // Fill the sidebar counts once the admin shell is showing (the gate has passed).
  (function primeNav(tries) {
    var shell = $('admShell');
    if (window.coldSupabase && shell && !shell.hidden) { load().catch(function () {}); return; }
    if (tries < 120) setTimeout(function () { primeNav(tries + 1); }, 500);
  })(0);

  window.AGENCY = {
    has: function (name) { return PANELS.indexOf(name) >= 0; },
    render: render,
    open: function (ref, opts) { openCommission(ref, opts); }
  };
})();
