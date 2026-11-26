/* Agency section of the admin (Commissions, Leads, Devs, Payouts, Services).
   Rendering only: the figures come from public.agency_data (admin-only RLS),
   never from this file, because every admin asset is publicly downloadable.
   admin.js owns routing; it calls window.AGENCY.render(panel) from renderPanel()
   and exposes window.admShowPanel for the commission detail page. */
(function () {
  'use strict';
  var PANELS = ['commissions', 'commission', 'leads', 'devs', 'payouts', 'services'];
  var D = null, LOADING = null, LOAD_ERR = '';
  var CUR_CM = null, CM_VIEW = 'active', LEAD_VIEW = 'open', LEAD_OPEN = null, PAY_VIEW = 'owed';

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
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    wallet: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.4-.9-1.3-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.2-.6-2.6-1.5M12 6.5V8M12 16v1.5"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'
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
    'Clothing': { key: 'model', c: 'var(--sv-3d)', skill: 'Clothing' }
  };
  var DISCORD = '<svg viewBox="0 0 24 24" fill="#5865f2" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>';
  var XLOGO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="color:var(--src-x)"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>';
  var SRC = {
    bbb: { name: 'BuiltByBit', color: 'var(--pf-builtbybit)', logo: '<img src="/mp-logos/builtbybit.png" alt="" />' },
    discord: { name: 'Discord', color: 'var(--src-discord)', logo: DISCORD },
    x: { name: 'X', color: 'var(--src-x)', logo: XLOGO },
    site: { name: 'coldd.dev', color: 'var(--pf-site)', logo: '<img src="/logo.png" alt="" />' }
  };
  var STAGES = ['Deposit', 'In progress', 'Client review', 'Delivered'];
  var SKILLS = ['Scripting', 'Building', 'User interface', '3D models', 'Thumbnails', 'Game trailers', 'Animations', 'VFX'];

  // ---------- helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function usd(n) { return '$' + Number(n).toLocaleString('en-US'); }
  function rbx(n) { return 'R$ ' + Number(n).toLocaleString('en-US'); }
  function svg(path, w) { return '<svg viewBox="0 0 24 24" width="' + (w || 18) + '" height="' + (w || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>'; }
  function svcOf(name) { return SVC[name] || SVC['Full game']; }
  function tile(svc, size) { var s = svcOf(svc); return '<span class="ag-tile' + (size ? ' ' + size : '') + '" style="--sv:' + s.c + '">' + svg(ICON[s.key]) + '</span>'; }
  function src(k) { var s = SRC[k] || SRC.site; return '<span class="ag-src">' + s.logo + '<span>' + esc(s.name) + '</span></span>'; }
  function srcTile(k) { return '<span class="ag-srctile">' + (SRC[k] || SRC.site).logo + '</span>'; }
  function delta(now, prev, label) {
    if (!prev) return now ? '<span class="adm-kpi-delta up">New</span>' : '';
    var p = Math.round((now - prev) / prev * 100);
    if (!p) return '';
    return '<span class="adm-kpi-delta ' + (p > 0 ? 'up' : 'down') + '">' + (p > 0 ? '↑ ' : '↓ ') + Math.abs(p) + '%</span> ' + (label || 'vs previous 30 days');
  }
  function kpi(label, value, em, line, sub) {
    return '<div class="adm-kpi-cell"><span class="adm-kpi-label">' + label + '</span><span class="adm-kpi-value"><b>' + value + '</b>' + (em ? '<em>' + em + '</em>' : '') + '</span>' +
      '<span class="adm-kpi-line">' + (line || '') + '</span>' + (sub ? '<span class="adm-kpi-sub">' + sub + '</span>' : '') + '</div>';
  }
  function costOf(c) { var u = 0, r = 0; c.devs.forEach(function (d) { u += d[2]; r += d[3]; }); return { usd: u, rbx: r }; }
  function stageCell(c) {
    var cls = c.stage === 3 ? ' is-done' : c.tone === 'late' ? ' is-late' : '';
    var bar = STAGES.map(function (s, i) { return '<i class="' + (i <= c.stage ? 'on' : '') + '"></i>'; }).join('');
    return '<span class="ag-stage' + cls + '"><span class="ag-stage-bar">' + bar + '</span><small>' + STAGES[c.stage] + '</small></span>';
  }
  function devsByStatus(status) {
    var out = [];
    D.commissions.forEach(function (c) { c.devs.forEach(function (d) { if (d[4] === status) out.push({ dev: d[0], c: c, usd: d[2], rbx: d[3], part: d[1] }); }); });
    return out;
  }
  function owedList() { return devsByStatus('owed'); }
  function paidList() { return devsByStatus('paid').concat(D.paidExtra || []); }
  function devInfo(n) { return D.devs.filter(function (x) { return x.n === n; })[0] || { skills: ['Scripting'], pay: 'PayPal' }; }
  function niceStep(raw) { var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function setNav(id, n) { var el = $(id); if (!el) return; el.textContent = n; el.hidden = !n; }

  // ---------- charts
  function lineChart(el, labels, series) {
    if (!el) return;
    var W = Math.max(320, el.clientWidth), H = el.clientHeight || 236, L = 46, R = 92, T = 12, B = 28;
    var max = 0; series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    var step = niceStep(max / 4 || 1), top = Math.ceil(max / step) * step || step;
    function x(i) { return L + i * (W - L - R) / (labels.length - 1); }
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
  function donut(segs, center, sub) {
    var total = segs.reduce(function (a, s) { return a + s.value; }, 0);
    if (!total) return '<p class="ag-empty">Nothing yet</p>';
    var size = 168, c = 84, r = 64, sw = 28, circ = 2 * Math.PI * r, off = 0;
    var arcs = segs.map(function (s) {
      var dash = s.value / total * circ;
      // var() only works in style, never in SVG presentation attributes.
      var a = '<circle class="adm-donut-seg" cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" style="stroke:' + s.color + ';stroke-width:' + sw + 'px" stroke-dasharray="' + Math.max(0, dash - 1.5).toFixed(2) + ' ' + (circ - dash + 1.5).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '"></circle>';
      off += dash; return a;
    }).join('');
    var key = '<div class="adm-donut-key">' + segs.map(function (s) { return '<span><i style="background:' + s.color + '"></i><span class="adm-donut-lbl">' + esc(s.label) + '</span><b>' + s.display + '</b><em>' + Math.round(s.value / total * 100) + '%</em></span>'; }).join('') + '</div>';
    return '<div class="adm-donut-wrap"><svg class="adm-donut" viewBox="0 0 ' + size + ' ' + size + '"><g transform="rotate(-90 ' + c + ' ' + c + ')">' + arcs + '</g>' +
      '<text x="' + c + '" y="' + (c - 3) + '" class="adm-donut-c1">' + esc(center) + '</text><text x="' + c + '" y="' + (c + 13) + '" class="adm-donut-c2">' + esc(sub) + '</text></svg>' + key + '</div>';
  }

  // ---------- data
  function load() {
    if (D) return Promise.resolve(D);
    if (LOADING) return LOADING;
    var sb = window.coldSupabase;
    if (!sb) return Promise.reject(new Error('Not connected'));
    LOADING = sb.from('agency_data').select('data').eq('id', 'main').maybeSingle().then(function (res) {
      LOADING = null;
      if (res.error) { LOAD_ERR = res.error.message || 'Could not load'; throw res.error; }
      if (!res.data || !res.data.data) { LOAD_ERR = 'No Agency data yet'; throw new Error(LOAD_ERR); }
      D = res.data.data; LOAD_ERR = '';
      updateNav();
      return D;
    }, function (e) { LOADING = null; LOAD_ERR = (e && e.message) || 'Could not load'; throw e; });
    return LOADING;
  }
  function updateNav() {
    if (!D) return;
    setNav('agNavCm', D.commissions.filter(function (c) { return c.tone === 'late' && c.stage < 3; }).length);
    setNav('agNavLeads', D.leads.filter(function (l) { return l.st === 'open'; }).length);
    setNav('agNavPay', owedList().length);
  }
  function waitThen(panel, fn) {
    if (D) { fn(); return; }
    var sec = $('adm-panel-' + panel), slot = sec && sec.querySelector('.ag-loading');
    if (slot) { slot.hidden = false; slot.textContent = 'Loading…'; }
    load().then(function () { if (slot) slot.hidden = true; fn(); }, function () {
      if (slot) { slot.hidden = false; slot.textContent = 'Could not load Agency data: ' + LOAD_ERR; }
    });
  }

  // ---------- Commissions
  function renderCommissions() {
    var S = D.stats || {};
    var active = D.commissions.filter(function (c) { return c.stage < 3; });
    var now = 0, prev = 0, cnt = 0;
    D.srcSeries.forEach(function (s) { now += s.v[s.v.length - 1]; prev += s.v[s.v.length - 2] || 0; cnt += s.n[s.n.length - 1]; });
    var late = active.filter(function (c) { return c.tone === 'late'; }).length;
    var today = active.filter(function (c) { return c.due === 'Today'; }).length;
    var booked = active.reduce(function (a, c) { return a + c.price; }, 0);
    var open = D.leads.filter(function (l) { return l.st === 'open'; }).length;
    var owed = owedList(), owedUsd = owed.reduce(function (a, o) { return a + o.usd; }, 0);
    var devSet = {}; active.forEach(function (c) { c.devs.forEach(function (d) { devSet[d[0]] = 1; }); });
    $('agKpi').innerHTML =
      kpi('Revenue', usd(now), cnt + ' payments', delta(now, prev), cnt ? 'Average ' + usd(Math.round(now / cnt)) + ' a payment' : '') +
      kpi('Margin', usd(S.margin || 0), now ? Math.round((S.margin || 0) / now * 100) + '%' : '', delta(S.margin || 0, S.marginPrev || 0), usd(now - (S.margin || 0)) + ' paid to devs') +
      kpi('Active', active.length, usd(booked) + ' booked', (today ? today + ' due today' : '') + (late ? (today ? ' &middot; ' : '') + '<span class="ag-late">' + late + ' late</span>' : ''), 'Across ' + Object.keys(devSet).length + ' devs') +
      kpi('Leads', open, 'open', S.leadsDelta ? '<span class="adm-kpi-delta up">↑ ' + S.leadsDelta + '</span> vs previous 30 days' : '', S.leadsConverted ? S.leadsConverted + ' converted' : '');
    $('agKpiFoot').innerHTML = '<span><i class="adm-live-dot is-on"></i><b>' + (S.devsWorking || 0) + '</b> devs working now</span><span>Owed to devs <b>' + usd(owedUsd) + '</b> across ' + owed.length + '</span>' +
      (S.nextDue ? '<span>Next due <b>' + esc(S.nextDue) + '</b> today</span>' : '');
    renderCmList();
    var needs = S.needs || [];
    $('agNeedsCount').textContent = needs.length ? needs.length + ' open' : '';
    $('agNeeds').innerHTML = needs.length ? needs.map(function (n) {
      var ico = n.ico === 'bbb' ? SRC.bbb.logo : n.ico === 'discord' ? DISCORD : svg(ICON[n.ico] || ICON.note, 16);
      return '<a class="adm-work-item' + (n.tone ? ' tone-' + n.tone : '') + '" href="#" data-ag-go="' + esc(n.go) + '"><span class="adm-work-ico">' + ico + '</span><span class="adm-work-text">' + esc(n.t) + '<small>' + esc(n.s) + '</small></span><span class="adm-work-go">' + svg(ICON.chev, 16) + '</span></a>';
    }).join('') : '<p class="adm-work-empty">Nothing needs you right now</p>';
    var tot = 0, totPrev = 0, totN = 0, last = D.months.length - 1;
    D.srcSeries.forEach(function (s) { tot += s.v[last]; totPrev += s.v[last - 1] || 0; totN += s.n[last]; });
    var rows = D.srcSeries.map(function (s) {
      var cur = s.v[last], was = s.v[last - 1] || 0, p = was ? Math.round((cur - was) / was * 100) : null, share = tot ? Math.round(cur / tot * 100) : 0, k = SRC[s.k] ? s.k : 'site';
      return '<tr><th><span class="adm-pf" style="--pf:' + SRC[k].color + '"><i></i>' + src(k) + '</span></th><td class="is-strong">' + usd(cur) + '</td><td class="is-muted">' + usd(was) + '</td>' +
        '<td><span class="adm-chg ' + (p == null || p >= 0 ? 'up' : 'down') + '">' + (p == null ? 'New' : (p >= 0 ? '↑ ' : '↓ ') + Math.abs(p) + '%') + '</span></td>' +
        '<td><span class="adm-share" style="--pf:' + SRC[k].color + '"><span class="adm-share-bar"><i style="width:' + share + '%"></i></span><span>' + share + '%</span></span></td><td>' + s.n[last] + '</td></tr>';
    }).join('');
    $('agSrcTable').innerHTML = '<thead><tr><th>Source</th><th>Last 30d</th><th>Previous 30d</th><th>Change</th><th>Share</th><th>Commissions</th></tr></thead><tbody>' + rows + '</tbody>' +
      '<tfoot><tr><th>All sources</th><td>' + usd(tot) + '</td><td>' + usd(totPrev) + '</td><td>' + (totPrev ? '<span class="adm-chg ' + (tot >= totPrev ? 'up' : 'down') + '">' + (tot >= totPrev ? '↑ ' : '↓ ') + Math.abs(Math.round((tot - totPrev) / totPrev * 100)) + '%</span>' : '') + '</td><td></td><td>' + totN + '</td></tr></tfoot>';
    var mixTotal = D.svcMix.reduce(function (a, m) { return a + m[1]; }, 0);
    $('agSvcDonut').innerHTML = donut(D.svcMix.map(function (m) { return { label: m[0], value: m[1], color: svcOf(m[0]).c, display: usd(m[1]) }; }), usd(mixTotal), 'revenue');
    drawSourceChart();
  }
  function renderCmList() {
    var rows = D.commissions.filter(function (c) { return CM_VIEW === 'all' || (CM_VIEW === 'active' ? c.stage < 3 : c.stage === 3); });
    $('agCmTitle').textContent = CM_VIEW === 'active' ? 'Active commissions' : CM_VIEW === 'done' ? 'Delivered' : 'All commissions';
    $('agCmCount').textContent = rows.length;
    var h = '<div class="ag-lh ag-commissions-cols"><span>Commission</span><span>Source</span><span>Devs</span><span>Stage</span><span class="ag-r">Price</span><span class="ag-r">' + (CM_VIEW === 'done' ? 'Delivered' : 'Due') + '</span></div>';
    rows.forEach(function (c) {
      var names = c.devs.map(function (d) { return d[0]; });
      h += '<button type="button" class="ag-row ag-commissions-cols" data-ag-cm="' + esc(c.id) + '">' +
        '<span class="ag-main">' + tile(c.svc) + '<span class="ag-name"><span class="ag-t">' + esc(c.title) + '</span><span class="ag-m">' + esc(c.svc + ' · ' + c.client) + '</span></span></span>' +
        '<span class="ag-hide-sm">' + src(c.src) + '</span>' +
        '<span class="ag-c ag-hide-sm">' + esc(names.slice(0, 2).join(', ')) + (names.length > 2 ? '<small>+' + (names.length - 2) + ' more</small>' : '') + '</span>' +
        '<span class="ag-hide-sm">' + stageCell(c) + '</span>' +
        '<span class="ag-amt ag-hide-sm">' + usd(c.price) + (c.paid < c.price ? '<small>' + usd(c.paid) + ' paid</small>' : '<small>Paid</small>') + '</span>' +
        '<span class="ag-when">' + esc(c.due) + '<small class="' + (c.tone === 'late' ? 'ag-late' : c.tone === 'warn' ? 'ag-warn' : '') + '">' + esc(c.rel) + '</small></span></button>';
    });
    if (!rows.length) h += '<p class="ag-empty">No commissions here</p>';
    $('agCmList').innerHTML = h;
  }
  function drawSourceChart() {
    var el = $('agSrcChart');
    if (!el || !D || $('adm-panel-commissions').hidden) return;
    lineChart(el, D.months, D.srcSeries.map(function (s) { var k = SRC[s.k] ? s.k : 'site'; return { name: SRC[k].name, color: SRC[k].color, values: s.v }; }));
  }

  // ---------- Commission detail
  function logIcon(t) {
    t = String(t).toLowerCase();
    if (/paid|deposit/.test(t)) return ['ok', ICON.coin];
    if (/deliver/.test(t)) return ['ok', ICON.check];
    if (/review|sent/.test(t)) return ['warn', ICON.eye];
    if (/deadline|late/.test(t)) return ['err', ICON.alert];
    if (/call|consult/.test(t)) return ['', ICON.phone];
    return ['', ICON.note];
  }
  function logHtml(c) {
    return c.log.map(function (l) { var ic = logIcon(l[0]); return '<div class="adm-work-item' + (ic[0] ? ' tone-' + ic[0] : '') + '"><span class="adm-work-ico">' + svg(ic[1], 16) + '</span><span class="adm-work-text">' + esc(l[0]) + '<small>' + esc(l[1]) + '</small></span></div>'; }).join('');
  }
  function renderCommission() {
    var sec = $('adm-panel-commission');
    var c = D.commissions.filter(function (x) { return x.id === CUR_CM; })[0];
    if (!c) { sec.innerHTML = '<button type="button" class="ag-back" data-panel="commissions">' + svg('<path d="m15 18-6-6 6-6"/>', 16) + 'Commissions</button><p class="ag-empty">That commission was not found.</p>'; return; }
    var cost = costOf(c), margin = c.price - cost.usd, pct = c.price ? Math.round(margin / c.price * 100) : 0, paidPct = c.price ? Math.round(c.paid / c.price * 100) : 0;
    var h = '<button type="button" class="ag-back" data-panel="commissions">' + svg('<path d="m15 18-6-6 6-6"/>', 16) + 'Commissions</button>';
    h += '<div class="dash-head adm-home-head ag-dhead"><div class="ag-main ag-title-row">' + tile(c.svc, 'lg') + '<div><h1>' + esc(c.title) + '</h1>' +
      '<div class="ag-subline">' + esc(c.id + ' · ' + c.svc + ' · ' + c.client + ' ·') + ' ' + src(c.src) + (D.sample ? '<span class="ag-sample">Sample data</span>' : '') + '</div></div></div>' +
      '<div class="ag-tools"><div class="adm-seg" role="group" aria-label="Stage" id="agStageSeg">' + STAGES.map(function (s, i) { return '<button type="button" data-i="' + i + '" class="' + (i === c.stage ? 'active' : '') + '">' + s + '</button>'; }).join('') + '</div></div></div>';
    h += '<div class="adm-hp adm-kpi"><div class="adm-kpi-grid">' +
      kpi('Client price', usd(c.price), '', '', c.svc === 'Full game' ? 'Floor $500' : '') +
      kpi('Client paid', usd(c.paid), c.paid < c.price ? 'of ' + usd(c.price) : 'in full', '<span class="adm-share" style="--pf:var(--price);justify-content:flex-start"><span class="adm-share-bar" style="width:120px"><i style="width:' + paidPct + '%"></i></span><span>' + paidPct + '%</span></span>') +
      kpi('Dev cost', cost.usd ? usd(cost.usd) : rbx(cost.rbx), cost.usd && cost.rbx ? '+ ' + rbx(cost.rbx) : '', '', c.devs.length + ' dev' + (c.devs.length > 1 ? 's' : '')) +
      kpi('Margin', usd(margin), pct + '%', '', cost.rbx ? 'Robux paid from the group' : '') + '</div></div>';
    h += '<div class="ag-grid"><div class="ag-col">' +
      '<div class="adm-hp"><div class="adm-hp-head"><div class="adm-hp-title"><h2>Brief</h2></div><a class="adm-hp-link" href="#">' + (c.src === 'bbb' ? 'Open on BuiltByBit' : c.src === 'x' ? 'Open on X' : 'Open the ticket') + '</a></div>' +
      '<p class="ag-brief">' + esc(c.brief) + '</p></div>' +
      '<div class="adm-hp adm-ro"><div class="adm-hp-head"><div class="adm-hp-title"><h2>Devs</h2><span>' + c.devs.length + '</span></div><button class="btn btn-ghost adm-btn-sm" type="button">Add dev</button></div><div class="ag-list">' +
      c.devs.map(function (d) {
        var dv = devInfo(d[0]);
        var st = d[4] === 'owed' ? '<span class="ag-chip warn"><i></i>Owed</span>' : d[4] === 'paid' ? '<span class="ag-chip ok"><i></i>Paid</span>' : '<span class="ag-chip"><i></i>After delivery</span>';
        return '<div class="ag-row is-static ag-devrow"><span class="ag-main">' + tile(dv.skills[0]) + '<span class="ag-name"><span class="ag-t">' + esc(d[0]) + '</span><span class="ag-m">' + esc(d[1]) + '</span></span></span>' +
          '<span class="ag-amt">' + (d[2] ? usd(d[2]) : rbx(d[3])) + '</span><span class="ag-r">' + st + '</span></div>';
      }).join('') + '</div></div></div>' +
      '<aside class="adm-hp adm-work"><div class="adm-hp-head"><div class="adm-hp-title"><h2>Activity</h2></div></div>' +
      '<form class="adm-work-add" id="agNoteForm" autocomplete="off"><input type="text" id="agNoteIn" maxlength="300" placeholder="Add a note" aria-label="Add a note" /><kbd aria-hidden="true">Enter</kbd></form>' +
      '<div class="adm-work-list" id="agLog">' + logHtml(c) + '</div></aside></div>';
    sec.innerHTML = h;
    $('agNoteForm').addEventListener('submit', function (e) { e.preventDefault(); var v = $('agNoteIn').value.trim(); if (!v) return; c.log.unshift([v, 'Just now']); $('agNoteIn').value = ''; $('agLog').innerHTML = logHtml(c); });
    $('agStageSeg').addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (!b) return; c.stage = +b.getAttribute('data-i'); this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); }); updateNav(); });
  }
  function openCommission(id, opts) {
    CUR_CM = id;
    if (typeof window.admShowPanel === 'function') window.admShowPanel('commission', { extra: id, skipUrl: opts && opts.skipUrl });
  }

  // ---------- Leads
  function renderLeads() {
    var S = D.stats || {};
    var open = D.leads.filter(function (l) { return l.st === 'open'; });
    $('agLeadKpi').innerHTML =
      kpi('Open leads', open.length, '', S.leadsDelta ? '<span class="adm-kpi-delta up">↑ ' + S.leadsDelta + '</span> vs previous 30 days' : '', S.leadsOldest ? 'Oldest ' + esc(S.leadsOldest) : '') +
      kpi('Reply time', esc(S.replyTime || ''), 'average', S.replyDelta ? '<span class="adm-kpi-delta up">↓ ' + esc(S.replyDelta) + '</span> faster than before' : '', esc(S.replyWithin || '')) +
      kpi('Converted', esc(S.convertedPct || ''), esc(S.leadsConverted || ''), S.convertedDelta ? '<span class="adm-kpi-delta up">↑ ' + esc(S.convertedDelta) + '</span> vs previous 30 days' : '', S.convertedBooked ? usd(S.convertedBooked) + ' booked' : '') +
      kpi('Under the floor', D.leads.filter(function (l) { return l.under && l.st === 'open'; }).length, '', '', 'Flagged automatically');
    var rows = D.leads.filter(function (l) { return l.st === LEAD_VIEW; });
    $('agLeadCount').textContent = rows.length;
    var h = '<div class="ag-lh ag-leads-cols"><span>Lead</span><span>Service</span><span>Budget</span><span>Wants it by</span><span>Status</span><span class="ag-r">Received</span></div>';
    rows.forEach(function (l) {
      var k = SRC[l.src] ? l.src : 'site';
      h += '<button type="button" class="ag-row ag-leads-cols" data-ag-lead="' + esc(l.id) + '" aria-expanded="' + (LEAD_OPEN === l.id) + '">' +
        '<span class="ag-main">' + srcTile(k) + '<span class="ag-name"><span class="ag-t">' + esc(l.title) + '</span><span class="ag-m">' + esc(l.client + ' · ' + SRC[k].name) + '</span></span></span>' +
        '<span class="ag-c ag-hide-sm ag-svc">' + tile(l.svc, 'sm') + '<span>' + esc(l.svc) + '</span></span>' +
        '<span class="ag-amt ag-hide-sm ag-left' + (l.under ? ' ag-warn' : l.budget === '$0' ? ' plain' : '') + '">' + esc(l.budget) + (l.under ? '<small class="ag-warn">Under the ' + usd(l.under) + ' floor</small>' : l.nobody ? '<small class="ag-warn">Nobody does trailers yet</small>' : '') + '</span>' +
        '<span class="ag-c ag-hide-sm">' + esc(l.by) + '</span>' +
        '<span class="ag-hide-sm"><span class="ag-chip ' + esc((l.chip || [])[1] || '') + '"><i></i>' + esc((l.chip || [])[0] || '') + '</span></span>' +
        '<span class="ag-when">' + esc(l.when) + '<small>' + esc(l.ago) + '</small></span></button>';
      if (LEAD_OPEN === l.id && l.ask) {
        h += '<div class="ag-answers"><dl><dt>What they need</dt><dd>' + esc(l.ask) + '</dd><dt>Service</dt><dd>' + esc(l.svc === 'Full game' ? 'Full game development' : l.svc) + '</dd><dt>Budget</dt><dd>' + esc(l.budget) + '</dd><dt>Wants it by</dt><dd>' + esc(l.by) + '</dd>' +
          '<dt>Existing game</dt><dd>' + esc(l.existing) + '</dd><dt>References</dt><dd>' + esc(l.refs) + '</dd><dt>Contact</dt><dd>' + esc(l.client) + ' on ' + (k === 'site' ? 'Discord' : SRC[k].name) + '</dd></dl>' +
          '<div class="ag-tools"><button class="btn btn-primary adm-btn-sm" type="button">Make it a commission</button><button class="btn btn-ghost adm-btn-sm" type="button">Reply on ' + (k === 'bbb' ? 'BuiltByBit' : k === 'x' ? 'X' : 'Discord') + '</button><button class="btn btn-ghost adm-btn-sm" type="button">Decline</button></div></div>';
      }
    });
    if (!rows.length) h += '<p class="ag-empty">No leads here</p>';
    $('agLeadList').innerHTML = h;
    var by = {}; D.leads.forEach(function (l) { by[l.src] = (by[l.src] || 0) + 1; });
    $('agLeadDonut').innerHTML = donut(['bbb', 'discord', 'site', 'x'].filter(function (k) { return by[k]; }).map(function (k) { return { label: SRC[k].name, value: by[k], color: SRC[k].color, display: by[k] }; }), String(D.leads.length), 'leads');
    var bs = {}; D.leads.forEach(function (l) { bs[l.svc] = (bs[l.svc] || 0) + 1; });
    $('agLeadSvcDonut').innerHTML = donut(Object.keys(bs).sort(function (a, b) { return bs[b] - bs[a]; }).map(function (k) { return { label: k, value: bs[k], color: svcOf(k).c, display: bs[k] }; }), String(D.leads.length), 'leads');
  }

  // ---------- Devs
  function activeFor(n) { return D.commissions.filter(function (c) { return c.stage < 3 && c.devs.some(function (d) { return d[0] === n; }); }).length; }
  function owedFor(n) { return owedList().filter(function (o) { return o.dev === n; }).reduce(function (a, o) { return a + o.usd; }, 0); }
  function renderDevs() {
    var S = D.stats || {};
    var team = D.devs.filter(function (d) { return d.on; }), cand = D.devs.filter(function (d) { return !d.on; });
    var busy = team.filter(function (d) { return activeFor(d.n); }).length, owed = owedList();
    $('agDevKpi').innerHTML =
      kpi('On the team', team.length, '', S.teamDelta ? '<span class="adm-kpi-delta up">↑ ' + S.teamDelta + '</span> this month' : '', '') +
      kpi('Working now', busy, 'of ' + team.length, '', (team.length - busy) + ' free for new work') +
      kpi('On time', esc(S.onTime || ''), 'last 90 days', S.onTimeDelta ? '<span class="adm-kpi-delta down">↓ ' + esc(S.onTimeDelta) + '</span> vs previous 90 days' : '', D.commissions.filter(function (c) { return c.tone === 'late' && c.stage < 3; }).length + ' late right now') +
      kpi('Owed', usd(owed.reduce(function (a, o) { return a + o.usd; }, 0)), '', '', owed.length + ' payouts waiting');
    $('agDevCards').innerHTML = team.map(function (d) {
      var a = activeFor(d.n), o = owedFor(d.n);
      return '<div class="ag-dev"><div class="ag-dev-head">' + tile(d.skills[0], 'lg') + '<span class="ag-name"><b>' + esc(d.n) + '</b><span class="ag-m">' + esc(d.skills.join(', ') + (d.pay ? ' · ' + d.pay : '')) + '</span></span>' +
        '<span class="ag-dev-state' + (a ? ' busy' : '') + '"><i></i>' + (a ? 'Working' : 'Free') + '</span></div>' +
        '<div class="ag-dev-stats"><div><b>' + a + '</b><span>Active</span></div><div><b>' + (d.delivered || 0) + '</b><span>Delivered</span></div><div><b class="' + ((d.ontime || 100) < 85 ? 'ag-warn' : '') + '">' + (d.ontime == null ? 100 : d.ontime) + '%</b><span>On time</span></div></div>' +
        '<div class="ag-dev-foot"><span class="' + (d.rate ? '' : 'ag-dim') + '">' + esc(d.rate || 'Rate not set') + '</span>' + (o ? '<span>Owed <b>' + usd(o) + '</b></span>' : '') + '</div></div>';
    }).join('') + '<button type="button" class="ag-dev ag-dev-add">' + svg('<path d="M12 5v14M5 12h14"/>', 22) + '<b>Add a dev</b><span>' + cand.length + ' candidates waiting</span></button>';
    $('agCandCount').textContent = cand.length;
    $('agCandList').innerHTML = cand.length ? cand.map(function (d) {
      return '<div class="ag-row is-static ag-candrow"><span class="ag-main">' + tile(d.skills[0], 'sm') + '<span class="ag-t">' + esc(d.n) + '</span></span>' +
        '<span class="ag-c">' + esc(d.skills.join(', ')) + '</span><span class="ag-r"><button class="btn btn-ghost adm-btn-sm ag-hover-act" type="button" data-ag-add="' + esc(d.n) + '">Add to team</button></span></div>';
    }).join('') : '<p class="ag-empty">No candidates</p>';
    $('agCoverage').innerHTML = SKILLS.map(function (s) {
      var a = D.devs.filter(function (d) { return d.on && d.skills.indexOf(s) >= 0; }).length, b = D.devs.filter(function (d) { return !d.on && d.skills.indexOf(s) >= 0; }).length;
      var bars = ''; for (var i = 0; i < a; i++) bars += '<i></i>'; for (var j = 0; j < b; j++) bars += '<i class="cand"></i>';
      var txt = a ? a + ' on the team' + (b ? ', ' + b + ' more' : '') : b ? b + ' candidate' + (b > 1 ? 's' : '') : 'Nobody yet';
      return '<div class="ag-cov" style="--sv:' + svcOf(s).c + '">' + tile(s, 'sm') + '<b>' + esc(s) + '</b><em class="' + (a ? '' : 'ag-warn') + '">' + txt + '</em>' + (bars ? '<span class="ag-covbar">' + bars + '</span>' : '') + '</div>';
    }).join('');
  }

  // ---------- Payouts
  function renderPayouts() {
    var S = D.stats || {};
    var owed = owedList(), paid = paidList(), owedUsd = owed.reduce(function (a, o) { return a + o.usd; }, 0);
    $('agPayKpi').innerHTML =
      kpi('Owed now', usd(owedUsd), owed.length + ' payouts', '', 'Client money already in') +
      kpi('Paid this month', usd(S.paidMonth || 0), (S.paidMonthCount || 0) + ' payouts', delta(S.paidMonth || 0, S.paidMonthPrev || 0), S.paidMonthRbx ? '+ ' + rbx(S.paidMonthRbx) + ' in Robux' : '') +
      kpi('Your margin', usd(S.margin || 0), '', delta(S.margin || 0, S.marginPrev || 0), 'Kept after paying devs') +
      kpi('Time to pay', esc(S.timeToPay || ''), 'average', S.timeToPayDelta ? '<span class="adm-kpi-delta up">↓ ' + esc(S.timeToPayDelta) + '</span> vs previous 30 days' : '', 'From client payment to dev');
    var list = PAY_VIEW === 'owed' ? owed : paid;
    $('agPayTitle').textContent = PAY_VIEW === 'owed' ? 'To pay' : 'Paid';
    $('agPayCount').textContent = list.length;
    var h = '<div class="ag-lh ag-pay-cols"><span>Dev</span><span>Commission</span><span>Client paid on</span><span class="ag-r">Amount</span><span></span></div>';
    list.forEach(function (o) {
      var dv = devInfo(o.dev);
      h += '<div class="ag-row is-static ag-pay-cols"><span class="ag-main">' + tile(dv.skills[0]) + '<span class="ag-name"><span class="ag-t">' + esc(o.dev) + '</span><span class="ag-m">' + esc(o.part + ' · ' + (dv.pay || 'PayPal')) + '</span></span></span>' +
        '<span class="ag-c ag-hide-sm">' + esc(o.c.title) + '<small>' + esc(o.c.id) + '</small></span><span class="ag-hide-sm">' + src(o.c.src) + '</span>' +
        '<span class="ag-amt">' + (o.usd ? usd(o.usd) : rbx(o.rbx)) + '</span>' +
        '<span class="ag-r">' + (PAY_VIEW === 'owed' ? '<button class="btn btn-primary adm-btn-sm" type="button" data-ag-pay="' + esc(o.dev + '|' + o.c.id) + '">Mark paid</button>' : '<span class="ag-c">' + esc(o.when || o.c.due) + '</span>') + '</span></div>';
    });
    if (!list.length) h += '<p class="ag-empty">' + (PAY_VIEW === 'owed' ? 'Everyone is paid' : 'No payouts yet') + '</p>';
    $('agPayList').innerHTML = h;
    var max = Math.max.apply(null, D.paidMonths.map(function (m) { return m[1]; }).concat([1]));
    $('agPayBars').innerHTML = D.paidMonths.map(function (m, i) {
      return '<div class="ag-bar' + (i === D.paidMonths.length - 1 ? ' now' : '') + '"><i style="height:' + Math.max(2, Math.round(m[1] / max * 100)) + '%"><b>' + usd(m[1]) + '</b></i><span>' + esc(m[0]) + '</span></div>';
    }).join('');
  }

  // ---------- Services
  function renderServices() {
    var h = '<div class="ag-lh ag-services-cols"><span>Service</span><span>Price</span><span>We pay</span><span class="ag-r">Margin at the floor</span><span class="ag-r">On</span></div>';
    D.services.forEach(function (s, i) {
      var sk = svcOf(s.n).skill, team = sk ? D.devs.filter(function (d) { return d.on && d.skills.indexOf(sk) >= 0; }).length : 3;
      var meta = !sk ? 'Scripting, building and UI from the team' : team ? team + ' dev' + (team > 1 ? 's' : '') + ' on the team' : '<span class="ag-warn">Nobody on the team yet</span>';
      var priceSet = s.price && s.price !== 'Not set';
      h += '<div class="ag-row is-static ag-services-cols' + (s.on ? '' : ' is-off') + '"><span class="ag-main">' + tile(s.n) + '<span class="ag-name"><span class="ag-t">' + esc(s.label || s.n) + '</span><span class="ag-m">' + meta + '</span></span></span>' +
        '<span class="ag-c ag-hide-sm' + (priceSet ? ' ag-price' : ' ag-dim') + '">' + esc(s.price || 'Not set') + (s.sub ? '<small>' + esc(s.sub) + '</small>' : '') + '</span>' +
        '<span class="ag-c ag-hide-sm' + (s.cost && s.cost !== 'Not set' ? '' : ' ag-dim') + '">' + esc(s.cost || 'Depends on the build') + (s.costSub ? '<small>' + esc(s.costSub) + '</small>' : '') + '</span>' +
        '<span class="ag-margin ag-hide-sm' + (s.thin ? ' thin' : '') + '">' + (s.marginPct != null ? '<span class="adm-share-bar" style="width:60px"><i style="width:' + s.marginPct + '%"></i></span>' + esc(s.margin) : '') + '</span>' +
        '<span class="ag-r"><label class="switch" aria-label="Offer ' + esc(s.label || s.n) + '"><input type="checkbox" data-ag-svc="' + i + '"' + (s.on ? ' checked' : '') + ' /><span class="track"></span></label></span></div>';
    });
    $('agSvcList').innerHTML = h;
    $('agTiers').innerHTML = D.tiers.map(function (t) { return '<div class="ag-tier"><div class="ag-tier-name">' + esc(t.name) + '</div><b>' + esc(t.usd) + '</b><span class="adm-rbx">' + esc(t.rbx) + '</span><ul><li>' + esc(t.len) + '</li><li>' + esc(t.rev) + '</li></ul></div>'; }).join('');
    $('agSettings').innerHTML = D.settings.map(function (s) { return '<div class="ag-set"><span>' + esc(s[0]) + '</span><label class="switch" aria-label="' + esc(s[0]) + '"><input type="checkbox"' + (s[1] ? ' checked' : '') + ' /><span class="track"></span></label></div>'; }).join('');
  }

  var RENDER = { commissions: renderCommissions, commission: renderCommission, leads: renderLeads, devs: renderDevs, payouts: renderPayouts, services: renderServices };
  function render(name) {
    if (!RENDER[name]) return;
    if (D && D.sample) document.querySelectorAll('.ag-sample[hidden]').forEach(function (el) { el.hidden = false; });
    waitThen(name, function () { if (D && D.sample) document.querySelectorAll('.ag-sample[hidden]').forEach(function (el) { el.hidden = false; }); RENDER[name](); });
  }

  // ---------- events (all scoped to Agency markup)
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t.closest || !t.closest('.ag')) return;
    var cm = t.closest('[data-ag-cm]'); if (cm) { openCommission(cm.getAttribute('data-ag-cm')); return; }
    var go = t.closest('[data-ag-go]');
    if (go) { ev.preventDefault(); var g = go.getAttribute('data-ag-go'); if (/^CM-/.test(g)) openCommission(g); else if (window.admShowPanel) window.admShowPanel(g); return; }
    var seg = t.closest('#agCmSeg button'); if (seg) { CM_VIEW = seg.getAttribute('data-v'); seg.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === seg); }); renderCmList(); return; }
    var ls = t.closest('#agLeadSeg button'); if (ls) { LEAD_VIEW = ls.getAttribute('data-v'); LEAD_OPEN = null; ls.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === ls); }); renderLeads(); return; }
    var lead = t.closest('[data-ag-lead]'); if (lead) { var id = lead.getAttribute('data-ag-lead'); LEAD_OPEN = LEAD_OPEN === id ? null : id; renderLeads(); return; }
    var ps = t.closest('#agPaySeg button'); if (ps) { PAY_VIEW = ps.getAttribute('data-v'); ps.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === ps); }); renderPayouts(); return; }
    var pay = t.closest('[data-ag-pay]');
    if (pay) { var k = pay.getAttribute('data-ag-pay').split('|'); D.commissions.forEach(function (c) { if (c.id === k[1]) c.devs.forEach(function (d) { if (d[0] === k[0] && d[4] === 'owed') d[4] = 'paid'; }); }); renderPayouts(); updateNav(); return; }
    var add = t.closest('[data-ag-add]'); if (add) { D.devs.forEach(function (d) { if (d.n === add.getAttribute('data-ag-add')) { d.on = true; d.delivered = 0; d.ontime = 100; d.pay = 'PayPal'; } }); renderDevs(); return; }
  });
  document.addEventListener('change', function (ev) {
    var i = ev.target.getAttribute && ev.target.getAttribute('data-ag-svc');
    if (i != null && D) { D.services[+i].on = ev.target.checked; ev.target.closest('.ag-row').classList.toggle('is-off', !ev.target.checked); }
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
    open: function (id, opts) { openCommission(id, opts); }
  };
})();
