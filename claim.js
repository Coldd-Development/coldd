/* coldd.dev/claim - the giveaway / prize claim portal.

   Three views on one page, each with its own URL so Back/Forward and a
   refresh behave like separate pages:
     /claim/                -> "Your prize": where it was won + what it was
     /claim/?step=details   -> verification + payout detail + screenshot
     /claim/?step=done      -> success

   Answers live in sessionStorage (coldd_claim_draft_v1) so they survive the
   round trips to Discord / coldd sign-in / BuiltByBit and back. Everything
   is validated again server-side by the claim-prize edge function. */
(function () {
  'use strict';

  var sb = window.coldSupabase;
  var auth = window.coldAuth;
  function $(id) { return document.getElementById(id); }
  if (!$('claimStep1')) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function readJSON(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeJSON(key, v) { try { if (v == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  var DRAFT_KEY = 'coldd_claim_draft_v1';
  var DONE_KEY = 'coldd_claim_done_v1';
  var LINK_KEY = 'coldd_claim_linking';
  var RETURN_PATH = '/claim/?step=details';
  var MAX_BYTES = 8 * 1024 * 1024;
  var PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var GAMEPASS_RE = /roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?game-pass(?:es)?\/(\d{1,20})/i;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var SOURCE_LABEL = { discord_giveaway: 'Discord Giveaway', discord_event: 'Discord Event', builtbybit: 'BuiltByBit Promotion', other: 'Other' };
  var PRIZE_LABEL = { robux: 'Robux', product: 'Product', currency: 'Real currency', other: 'Other' };
  var STATUS = { pending: ['Awaiting confirmation', 'warn'], fulfilled: ['Prize fulfilled', 'ok'], declined: ['Declined', 'err'] };

  var ICON = {
    discord: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
    bbb: '<img src="/mp-logos/builtbybit.png" alt="" width="20" height="20" />',
    account: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    ok: '<svg class="msym" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="m424-296 282-282-56-56-226 226-114-114-56 56 170 170Zm56 216q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg>'
  };

  var draft = readJSON(DRAFT_KEY) || {};
  function save() { writeJSON(DRAFT_KEY, draft); }

  /* ---------------- account state ---------------- */

  var user = null;          // full auth user (with identities) or null
  var userReady = false;
  function refreshUser() {
    if (!sb) { userReady = true; return Promise.resolve(null); }
    return sb.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (!s) return null;
      return sb.auth.getUser().then(function (u) { return (u && u.data && u.data.user) || s.user; }).catch(function () { return s.user; });
    }).catch(function () { return null; }).then(function (u) { user = u || null; userReady = true; return user; });
  }
  function discordOf(u) {
    var ident = ((u && u.identities) || []).filter(function (i) { return i.provider === 'discord'; })[0];
    if (!ident) return null;
    var d = ident.identity_data || {};
    var handle = String(d.name || d.user_name || '').replace(/#0$/, '');
    return { name: (d.custom_claims && d.custom_claims.global_name) || d.full_name || handle || 'your Discord account', handle: handle };
  }
  function accountName() {
    var p = auth && auth.getProfile ? auth.getProfile() : null;
    return (p && p.name) || (user && user.email) || 'your account';
  }
  function bbbValid() {
    var b = draft.bbb;
    return !!(b && user && b.uid === user.id && b.proof && Number(b.exp) > Date.now() + 60000);
  }
  function setReturn() { writeJSON('coldd_auth_return', { path: RETURN_PATH, ts: Date.now() }); }

  /* ---------------- views ---------------- */

  var VIEWS = ['questions', 'details', 'done'];
  var current = null;
  function stepFromUrl() { var s = new URLSearchParams(location.search).get('step'); return VIEWS.indexOf(s) >= 0 ? s : 'questions'; }
  function urlFor(step) { return step === 'questions' ? '/claim/' : '/claim/?step=' + step; }
  function doneRef() { var d = readJSON(DONE_KEY); return d && d.ref ? d.ref : ''; }

  function show(step, opts) {
    opts = opts || {};
    if (step === 'details' && !questionsValid(false)) step = 'questions';
    if (step === 'done' && !doneRef()) step = 'questions';
    current = step;
    document.querySelectorAll('.claim-view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== step; });
    var idx = VIEWS.indexOf(step);
    document.querySelectorAll('#claimSteps li').forEach(function (li, i) {
      li.classList.toggle('is-done', i < idx);
      if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    var url = urlFor(step) + (opts.hash || '');
    if (opts.push) history.pushState({ claimStep: step }, '', url);
    else if (opts.replace || location.pathname + location.search !== urlFor(step)) history.replaceState({ claimStep: step }, '', url);

    if (step === 'questions') syncQuestions();
    if (step === 'details') renderDetails();
    if (step === 'done') renderDone();
    renderHistory();
    if (opts.scroll) {
      var top = $('claimSteps').getBoundingClientRect().top + window.scrollY - 110;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }
  window.addEventListener('popstate', function () { show(stepFromUrl()); });

  /* ---------------- step 1: questions ---------------- */

  function setErr(id, msg) { var el = $(id); if (el) el.textContent = msg || ''; }

  function questionsValid(showErrors) {
    var ok = true;
    if (!SOURCE_LABEL[draft.source]) { ok = false; if (showErrors) setErr('cqSourceErr', 'Choose where you received this prize.'); }
    else if (draft.source === 'other' && String(draft.sourceOther || '').trim().length < 3) { ok = false; if (showErrors) setErr('cqSourceOtherErr', 'Tell us where you won this prize.'); }
    if (!PRIZE_LABEL[draft.prize]) { ok = false; if (showErrors) setErr('cqPrizeErr', 'Choose what the prize was.'); }
    else if (draft.prize === 'other' && String(draft.prizeOther || '').trim().length < 3) { ok = false; if (showErrors) setErr('cqPrizeOtherErr', 'Tell us what you won.'); }
    return ok;
  }

  function syncQuestions() {
    document.querySelectorAll('#claimStep1 .co-input').forEach(function (inp) {
      var key = inp.name === 'source' ? 'source' : 'prize';
      inp.checked = draft[key] === inp.value;
      inp.closest('.claim-opt').classList.toggle('active', inp.checked);
    });
    $('cqSourceOtherWrap').hidden = draft.source !== 'other';
    $('cqPrizeOtherWrap').hidden = draft.prize !== 'other';
    if ($('cqSourceOther').value !== (draft.sourceOther || '')) $('cqSourceOther').value = draft.sourceOther || '';
    if ($('cqPrizeOther').value !== (draft.prizeOther || '')) $('cqPrizeOther').value = draft.prizeOther || '';
  }

  document.querySelectorAll('#claimStep1 .co-input').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var key = inp.name === 'source' ? 'source' : 'prize';
      draft[key] = inp.value;
      save();
      setErr(key === 'source' ? 'cqSourceErr' : 'cqPrizeErr', '');
      syncQuestions();
      var other = key === 'source' ? $('cqSourceOther') : $('cqPrizeOther');
      if (inp.value === 'other') setTimeout(function () { other.focus(); }, 30);
    });
  });
  [['cqSourceOther', 'sourceOther', 'cqSourceOtherErr'], ['cqPrizeOther', 'prizeOther', 'cqPrizeOtherErr']].forEach(function (t) {
    $(t[0]).addEventListener('input', function () { draft[t[1]] = this.value; save(); setErr(t[2], ''); });
  });

  $('claimStep1').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!questionsValid(true)) {
      var firstErr = document.querySelector('#claimStep1 .auth-err:not(:empty)');
      if (firstErr) firstErr.closest('.claim-q').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    pushedDetails = true;
    show('details', { push: true, scroll: true });
  });
  var pushedDetails = false;

  /* ---------------- step 2: verification ---------------- */

  var verifyBusy = '';      // action currently running, to show a spinner
  var verifyNote = '';      // one-off message under the verify rows

  function needFor(source) {
    if (source === 'builtbybit') return 'bbb';
    if (source === 'other') return 'account';
    return 'discord';
  }

  function vRow(icon, title, sub, actionHtml, done) {
    return '<div class="claim-verify' + (done ? ' is-done' : '') + '">' +
      '<span class="cv-ico">' + icon + '</span>' +
      '<span class="cv-text"><span class="cv-title">' + title + '</span><span class="cv-sub">' + sub + '</span></span>' +
      (done ? '<span class="cv-ok">' + ICON.ok + (done === 'account' ? 'Signed in' : 'Verified') + '</span>' : '') +
      (actionHtml || '') +
      '</div>';
  }
  function vBtn(act, label, primary, disabled) {
    var busy = verifyBusy === act;
    return '<button type="button" class="btn ' + (primary ? 'btn-primary' : 'btn-ghost') + ' cv-btn' + (busy ? ' is-loading' : '') + '" data-act="' + act + '"' + (disabled || busy ? ' disabled' : '') + '>' +
      '<span class="btn-label">' + label + '</span><span class="btn-spinner"' + (busy ? '' : ' hidden') + '></span></button>';
  }

  function renderVerify() {
    var need = needFor(draft.source);
    var sub = {
      discord: 'Discord prizes are matched to the Discord account that won, so sign in with Discord.',
      bbb: 'BuiltByBit prizes are matched to the BuiltByBit account that won. Sign in to your coldd account, then with BuiltByBit.',
      account: 'Sign in to your coldd account so we can keep you updated on this claim.'
    }[need];
    $('csVerifySub').textContent = sub;
    var html = '';
    if (!userReady) {
      html = '<p class="claim-sec-sub">Checking your account…</p>';
    } else if (need === 'discord') {
      var d = discordOf(user);
      if (!user) {
        html = vRow(ICON.discord, 'Discord', 'Not signed in yet', vBtn('discord-signin', 'Sign in with Discord', true));
      } else if (!d) {
        html = vRow(ICON.discord, 'Discord', 'You\'re signed in as ' + esc(accountName()) + ', but no Discord account is linked', vBtn('discord-link', 'Link Discord', true));
      } else {
        html = vRow(ICON.discord, 'Discord', 'Signed in as ' + esc(d.name) + (d.handle && d.handle !== d.name ? ' (@' + esc(d.handle) + ')' : ''), '', true);
      }
    } else {
      if (!user) {
        html = vRow(ICON.account, 'coldd account', 'Not signed in yet', '<span class="cv-btns">' + vBtn('signup', 'Create account', false) + vBtn('signin', 'Sign in', true) + '</span>');
      } else {
        html = vRow(ICON.account, 'coldd account', 'Signed in as ' + esc(accountName()), '', 'account');
      }
      if (need === 'bbb') {
        if (verifyBusy === 'bbb-finish') {
          html += vRow(ICON.bbb, 'BuiltByBit', 'Checking your BuiltByBit account…', '');
        } else if (bbbValid()) {
          html += vRow(ICON.bbb, 'BuiltByBit', 'Signed in as ' + esc(draft.bbb.username || 'your BuiltByBit account') + ' <button type="button" class="cv-link" data-act="bbb-reset">Use a different account</button>', '', true);
        } else {
          html += vRow(ICON.bbb, 'BuiltByBit', user ? 'Not signed in yet' : 'Sign in to coldd first', vBtn('bbb', 'Sign in with BuiltByBit', true, !user));
        }
      }
    }
    $('claimVerify').innerHTML = html;
    var note = $('csVerifyErr');
    note.textContent = verifyNote || '';
  }
  function verifyDone() {
    var need = needFor(draft.source);
    if (!user) return false;
    if (need === 'discord') return !!discordOf(user);
    if (need === 'bbb') return bbbValid();
    return true;
  }

  $('claimVerify').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    verifyNote = '';
    if (act === 'signin' || act === 'signup') {
      setReturn();
      location.href = act === 'signin' ? '/signin' : '/signup';
      return;
    }
    if (act === 'bbb-reset') { delete draft.bbb; save(); renderVerify(); return; }
    if (!auth || !sb) { verifyNote = 'Sign-in did not finish loading. Refresh the page and try again.'; renderVerify(); return; }

    if (act === 'discord-signin') {
      verifyBusy = act; renderVerify();
      setReturn();
      Promise.resolve(auth.signInDiscord()).then(function (r) {
        if (r && r.error) { verifyBusy = ''; verifyNote = 'Could not start Discord sign-in. Please try again.'; renderVerify(); }
      });
      return;
    }
    if (act === 'discord-link') {
      verifyBusy = act; renderVerify();
      setReturn();
      writeJSON(LINK_KEY, { ts: Date.now() });
      sb.auth.linkIdentity({ provider: 'discord', options: { redirectTo: location.origin + '/callback.html' } }).then(function (res) {
        if (res && res.error) throw res.error;
      }).catch(function (err) {
        writeJSON(LINK_KEY, null);
        verifyBusy = '';
        var raw = (err && err.message) || '';
        verifyNote = /manual linking is disabled/i.test(raw)
          ? 'Linking accounts is turned off right now. Sign out, then sign back in with Discord.'
          : 'Could not start linking Discord. Please try again.';
        renderVerify();
      });
      return;
    }
    if (act === 'bbb') {
      verifyBusy = act; renderVerify();
      auth.invokeFn('claim-prize', { action: 'bbb-start' }).then(function (d) {
        location.assign(d.url);
      }).catch(function (err) {
        verifyBusy = '';
        verifyNote = (err && err.message) || 'Could not start BuiltByBit sign-in. Please try again.';
        renderVerify();
      });
    }
  });

  // Coming back from BuiltByBit: ?code=&state= on /claim/.
  var bbbReturn = (function () {
    var qs = new URLSearchParams(location.search);
    if (qs.get('code') && qs.get('state')) {
      history.replaceState({ claimStep: 'details' }, '', urlFor('details'));
      return { code: qs.get('code'), state: qs.get('state') };
    }
    if (qs.get('error') && !qs.get('step')) {
      history.replaceState({ claimStep: 'details' }, '', urlFor('details'));
      verifyNote = 'BuiltByBit sign-in was cancelled. Try again when you\'re ready.';
    }
    return null;
  })();
  function finishBbb() {
    if (!bbbReturn || !user || !auth) return;
    var ret = bbbReturn; bbbReturn = null;
    verifyBusy = 'bbb-finish'; renderVerify();
    auth.invokeFn('claim-prize', { action: 'bbb-finish', code: ret.code, state: ret.state }).then(function (d) {
      draft.bbb = { uid: user.id, id: d.member.id, username: d.member.username, proof: d.proof, exp: Date.now() + 115 * 60 * 1000 };
      save();
    }).catch(function (err) {
      verifyNote = (err && err.message) || 'BuiltByBit sign-in failed. Please try again.';
    }).then(function () { verifyBusy = ''; if (current === 'details') renderVerify(); });
  }

  /* ---------------- step 2: prize details ---------------- */

  var CLAIMABLE = null;
  var claimableErr = '';
  function loadClaimable() {
    if (CLAIMABLE || !sb) return Promise.resolve(CLAIMABLE || []);
    return sb.rpc('claimable_products').then(function (r) {
      if (r.error) throw r.error;
      var bySlug = {};
      (window.__CATALOG || []).forEach(function (c) { bySlug[c.id] = c; });
      CLAIMABLE = (r.data || []).map(function (p) {
        var c = bySlug[p.slug] || {};
        return {
          slug: p.slug, title: p.title || c.title || p.slug, cat: p.cat || c.cat || '',
          image: c.image || (window.imgUrl && p.image ? window.imgUrl(p.image) : (p.image || '')),
          key: norm(p.title)
        };
      });
      claimableErr = '';
      return CLAIMABLE;
    }).catch(function () { claimableErr = 'Could not load the product list. Refresh the page to try again.'; return []; });
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  var PRODUCT_LIMIT = 40;
  function renderProducts() {
    var listEl = $('cpProductList');
    if (!CLAIMABLE) { listEl.innerHTML = '<p class="claim-sec-sub claim-prod-loading">' + (claimableErr || 'Loading products…') + '</p>'; return; }
    var q = norm($('cpProductSearch').value);
    var tokens = q ? q.split(' ') : [];
    var hits = CLAIMABLE.filter(function (p) { return tokens.every(function (t) { return p.key.indexOf(t) >= 0; }); });
    var picked = draft.productSlug ? CLAIMABLE.filter(function (p) { return p.slug === draft.productSlug; })[0] : null;
    if (draft.productSlug && !picked) { delete draft.productSlug; save(); }
    var shown = hits.slice(0, PRODUCT_LIMIT);
    if (picked && shown.indexOf(picked) < 0) shown.unshift(picked);
    else if (picked) { shown.splice(shown.indexOf(picked), 1); shown.unshift(picked); }
    listEl.innerHTML = shown.map(function (p) {
      var on = picked === p;
      return '<button type="button" class="claim-prod' + (on ? ' active' : '') + '" role="radio" aria-checked="' + on + '" data-slug="' + esc(p.slug) + '">' +
        '<span class="cp-img"' + (p.image ? ' style="background-image:url(\'' + esc(p.image) + '\')"' : '') + '></span>' +
        '<span class="cp-txt"><span class="cp-title">' + esc(p.title) + '</span>' + (p.cat ? '<span class="cp-cat">' + esc(p.cat) + '</span>' : '') + '</span>' +
        '<span class="co-radio" aria-hidden="true"></span></button>';
    }).join('');
    listEl.hidden = !shown.length;
    $('cpProductEmpty').hidden = !(q && !hits.length);
    var more = $('cpProductMore');
    more.hidden = hits.length <= PRODUCT_LIMIT;
    more.textContent = 'Showing ' + PRODUCT_LIMIT + ' of ' + hits.length + ' products. Keep typing to narrow it down.';
  }
  $('cpProductSearch').addEventListener('input', renderProducts);
  $('cpProductSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
  $('cpProductList').addEventListener('click', function (e) {
    var b = e.target.closest('.claim-prod'); if (!b) return;
    draft.productSlug = b.getAttribute('data-slug'); save();
    setErr('cpProductErr', '');
    renderProducts();
  });

  $('cpGamepass').addEventListener('input', function () { draft.gamepassUrl = this.value; save(); setErr('cpGamepassErr', ''); });
  $('cpPaypal').addEventListener('input', function () { draft.paypalEmail = this.value; save(); setErr('cpPaypalErr', ''); });

  function renderPrize() {
    document.querySelectorAll('.claim-prize').forEach(function (el) { el.hidden = el.getAttribute('data-prize') !== draft.prize; });
    $('csPrizeTitle').textContent = { robux: 'Where to send your Robux', currency: 'Where to send your prize', product: 'Pick your product', other: 'Your prize' }[draft.prize] || 'Your prize';
    if (draft.prize === 'robux') $('cpGamepass').value = draft.gamepassUrl || '';
    if (draft.prize === 'currency') $('cpPaypal').value = draft.paypalEmail || '';
    if (draft.prize === 'other') $('cpOtherEcho').textContent = draft.prizeOther || '';
    if (draft.prize === 'product') { renderProducts(); loadClaimable().then(function () { if (current === 'details') renderProducts(); }); }
  }

  /* ---------------- step 2: proof screenshot ---------------- */

  var proofPreviewUrl = '';
  var uploading = false;
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function renderProof() {
    var p = draft.proof && user && draft.proof.uid === user.id ? draft.proof : null;
    if (draft.proof && !p && userReady) { delete draft.proof; save(); }
    $('cpDrop').hidden = !!(p || uploading);
    $('cpProofPreview').hidden = !(p || uploading);
    $('cpDrop').classList.toggle('is-locked', !user);
    $('cpDropHint').textContent = user ? 'PNG, JPG, WEBP or GIF, up to 8 MB. You can also paste a screenshot.' : 'Sign in above first, then add your screenshot.';
    if (uploading) {
      $('cpProofThumb').className = 'cp-thumb is-loading';
      $('cpProofThumb').style.backgroundImage = '';
      $('cpProofName').textContent = uploading.name || 'Screenshot';
      $('cpProofSub').textContent = 'Uploading…';
      $('cpProofRemove').hidden = true;
      return;
    }
    if (p) {
      $('cpProofThumb').className = 'cp-thumb' + (proofPreviewUrl ? '' : ' is-file');
      $('cpProofThumb').style.backgroundImage = proofPreviewUrl ? 'url("' + proofPreviewUrl + '")' : '';
      $('cpProofName').textContent = p.name || 'Screenshot';
      $('cpProofSub').textContent = fmtSize(p.size || 0) + ' · uploaded';
      $('cpProofRemove').hidden = false;
    }
  }

  function handleFile(file) {
    setErr('cpProofErr', '');
    if (!file) return;
    if (!user) { setErr('cpProofErr', 'Sign in above before adding your screenshot.'); return; }
    if (PROOF_TYPES.indexOf(file.type) < 0) { setErr('cpProofErr', 'Please upload a PNG, JPG, WEBP or GIF image.'); return; }
    if (file.size > MAX_BYTES) { setErr('cpProofErr', 'That image is over 8 MB. Crop it or save it as a JPG and try again.'); return; }
    if (uploading) return;
    uploading = { name: file.name || 'Pasted screenshot' };
    renderProof();
    auth.invokeFn('claim-prize', { action: 'upload-url', contentType: file.type, size: file.size }).then(function (d) {
      return sb.storage.from(d.bucket).uploadToSignedUrl(d.path, d.token, file, { contentType: file.type }).then(function (res) {
        if (res && res.error) throw res.error;
        return d;
      });
    }).then(function (d) {
      if (proofPreviewUrl) { try { URL.revokeObjectURL(proofPreviewUrl); } catch (e) {} }
      proofPreviewUrl = URL.createObjectURL(file);
      draft.proof = { path: d.path, name: file.name || 'Pasted screenshot', size: file.size, uid: user.id };
      save();
    }).catch(function (err) {
      setErr('cpProofErr', (err && err.message && !/^Request failed/.test(err.message) ? err.message : 'Upload failed. Please try again.'));
    }).then(function () { uploading = false; renderProof(); });
  }

  $('cpProof').addEventListener('change', function () { handleFile(this.files && this.files[0]); this.value = ''; });
  $('cpProofRemove').addEventListener('click', function () { $('cpProof').click(); });
  var drop = $('cpDrop');
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); }); });
  drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; handleFile(f); });
  drop.addEventListener('click', function (e) { if (!user) { e.preventDefault(); setErr('cpProofErr', 'Sign in above before adding your screenshot.'); } });
  document.addEventListener('paste', function (e) {
    if (current !== 'details') return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && PROOF_TYPES.indexOf(items[i].type) >= 0) { e.preventDefault(); handleFile(items[i].getAsFile()); return; }
    }
  });

  /* ---------------- step 2: render + submit ---------------- */

  function renderDetails() {
    var src = SOURCE_LABEL[draft.source] || '';
    if (draft.source === 'other' && draft.sourceOther) src = String(draft.sourceOther).trim().slice(0, 60);
    var prize = PRIZE_LABEL[draft.prize] || '';
    if (draft.prize === 'other' && draft.prizeOther) prize = String(draft.prizeOther).trim().slice(0, 60);
    $('claimSummary').innerHTML = '<span class="cs-k">Won from</span> ' + esc(src) + '<span class="cs-sep" aria-hidden="true"></span><span class="cs-k">Prize</span> ' + esc(prize);
    renderVerify();
    renderPrize();
    renderProof();
  }

  function setMsg(text) {
    var m = $('claimMsg');
    m.className = 'auth-msg' + (text ? ' show' : '');
    m.textContent = text || '';
  }

  $('claimEdit').addEventListener('click', function () { show('questions', { push: true, scroll: true }); });
  $('claimBack').addEventListener('click', function () {
    // Only step back through history when this page pushed the details step
    // itself; after a sign-in round trip the previous entry is another site.
    if (pushedDetails) history.back();
    else show('questions', { push: true, scroll: true });
  });

  var submitting = false;
  $('claimStep2').addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitting) return;
    setMsg('');
    var errs = [];
    if (!verifyDone()) {
      errs.push('csVerifyErr');
      verifyNote = { discord: 'Sign in with Discord to claim a Discord prize.', bbb: 'Sign in with BuiltByBit to claim a BuiltByBit prize.', account: 'Sign in to your coldd account to submit your claim.' }[needFor(draft.source)];
      renderVerify();
    }
    if (draft.prize === 'robux' && !GAMEPASS_RE.test(String(draft.gamepassUrl || ''))) { errs.push('cpGamepassErr'); setErr('cpGamepassErr', 'Paste the full gamepass link, like https://www.roblox.com/game-pass/123456789.'); }
    if (draft.prize === 'currency' && !EMAIL_RE.test(String(draft.paypalEmail || '').trim())) { errs.push('cpPaypalErr'); setErr('cpPaypalErr', 'Enter the email address on your PayPal account.'); }
    if (draft.prize === 'product' && !draft.productSlug) { errs.push('cpProductErr'); setErr('cpProductErr', 'Choose the product you won.'); }
    if (uploading) { errs.push('cpProofErr'); setErr('cpProofErr', 'Wait for your screenshot to finish uploading.'); }
    else if (!(draft.proof && user && draft.proof.uid === user.id)) { errs.push('cpProofErr'); setErr('cpProofErr', 'Upload a screenshot showing you won the prize.'); }
    if (errs.length) {
      var el = $(errs[0]);
      var sec = el && el.closest('.claim-sec');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    submitting = true;
    var btn = $('claimSubmit');
    btn.disabled = true; btn.classList.add('is-loading'); btn.querySelector('.btn-spinner').hidden = false;
    auth.invokeFn('claim-prize', {
      action: 'submit',
      source: draft.source,
      sourceOther: draft.source === 'other' ? draft.sourceOther : '',
      prizeType: draft.prize,
      prizeOther: draft.prize === 'other' ? draft.prizeOther : '',
      gamepassUrl: draft.prize === 'robux' ? draft.gamepassUrl : '',
      paypalEmail: draft.prize === 'currency' ? String(draft.paypalEmail || '').trim() : '',
      productSlug: draft.prize === 'product' ? draft.productSlug : '',
      proofPath: draft.proof.path,
      bbbProof: draft.source === 'builtbybit' && draft.bbb ? draft.bbb.proof : ''
    }).then(function (d) {
      writeJSON(DONE_KEY, { ref: d.ref, ts: Date.now() });
      draft = {}; save();
      if (proofPreviewUrl) { try { URL.revokeObjectURL(proofPreviewUrl); } catch (e2) {} proofPreviewUrl = ''; }
      historyRows = null;
      show('done', { push: true, scroll: true });
      loadHistory();
    }).catch(function (err) {
      setMsg((err && err.message) || 'Could not submit your claim. Please try again.');
    }).then(function () {
      submitting = false;
      btn.disabled = false; btn.classList.remove('is-loading'); btn.querySelector('.btn-spinner').hidden = true;
    });
  });

  /* ---------------- step 3: done ---------------- */

  function renderDone() {
    var ref = doneRef();
    $('claimRefLine').hidden = !ref;
    $('claimRef').textContent = ref;
    setTimeout(function () { var h = $('claimDoneTitle'); if (h) h.focus({ preventScroll: true }); }, 50);
  }
  $('claimAnother').addEventListener('click', function (e) {
    e.preventDefault();
    writeJSON(DONE_KEY, null);
    draft = {}; save();
    show('questions', { push: true, scroll: true });
  });

  /* ---------------- claim history ---------------- */

  var historyRows = null;
  function loadHistory() {
    if (!sb || !user) { historyRows = []; renderHistory(); return Promise.resolve(); }
    return sb.from('prize_claims')
      .select('ref, status, prize_type, product_title, prize_other, decline_reason, created_at')
      .order('created_at', { ascending: false })
      .limit(20)
      .then(function (r) { historyRows = r.error ? [] : (r.data || []); renderHistory(); });
  }
  function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function renderHistory() {
    var card = $('claims');
    var rows = historyRows || [];
    card.hidden = !(rows.length && current !== 'details');
    if (card.hidden) return;
    $('claimHistory').innerHTML = rows.map(function (c) {
      var st = STATUS[c.status] || STATUS.pending;
      var what = c.prize_type === 'product' ? (c.product_title || 'Product') : c.prize_type === 'other' ? (c.prize_other || 'Other prize') : PRIZE_LABEL[c.prize_type];
      return '<div class="ch-row">' +
        '<div class="ch-main"><span class="ch-title">' + esc(what) + '</span>' +
        '<span class="ch-sub"><code>' + esc(c.ref) + '</code> · ' + esc(fmtDate(c.created_at)) + '</span>' +
        (c.status === 'declined' && c.decline_reason ? '<span class="ch-reason">' + esc(c.decline_reason) + '</span>' : '') +
        '</div><span class="dt-badge ' + st[1] + '">' + st[0] + '</span></div>';
    }).join('');
  }

  /* ---------------- boot ---------------- */

  show(stepFromUrl());
  refreshUser().then(function () {
    // Back from "Link Discord" without a Discord identity = the link failed
    // (most often: that Discord account already belongs to another login).
    var linking = readJSON(LINK_KEY);
    if (linking) {
      writeJSON(LINK_KEY, null);
      if (user && !discordOf(user) && Date.now() - (linking.ts || 0) < 30 * 60 * 1000) {
        verifyNote = 'That Discord account couldn\'t be linked. If it already has its own coldd login, sign out and sign in with Discord instead.';
      }
    }
    if (current === 'details') renderDetails();
    finishBbb();
    loadHistory().then(function () {
      if (location.hash === '#claims' && !$('claims').hidden) $('claims').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  if (sb) {
    var lastUid = null;
    sb.auth.onAuthStateChange(function (evt, session) {
      var uid = session && session.user ? session.user.id : null;
      if (evt === 'INITIAL_SESSION' || uid === lastUid && evt !== 'USER_UPDATED') { lastUid = uid; return; }
      lastUid = uid;
      setTimeout(function () {
        refreshUser().then(function () { if (current === 'details') renderDetails(); historyRows = null; loadHistory(); });
      }, 0);
    });
  }
})();
