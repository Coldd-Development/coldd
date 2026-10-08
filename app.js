    // Google Material Symbols (Outlined, 24dp) shipped as inline SVG geometry
    // rather than the icon webfont. The font renders icons as ligature TEXT,
    // which DESIGN.md's "draw every icon" rule exists specifically to prevent -
    // and it would add a render-blocking external request that fails closed to
    // visible glyph names. Paths are lifted verbatim from Google's own SVGs, so
    // the 0 -960 960 960 viewBox is theirs, not a mistake.
    window.MSYM = {
      visibility: 'M607.5-372.5Q660-425 660-500t-52.5-127.5Q555-680 480-680t-127.5 52.5Q300-575 300-500t52.5 127.5Q405-320 480-320t127.5-52.5Zm-204-51Q372-455 372-500t31.5-76.5Q435-608 480-608t76.5 31.5Q588-545 588-500t-31.5 76.5Q525-392 480-392t-76.5-31.5ZM214-281.5Q94-363 40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200q-146 0-266-81.5ZM480-500Zm207.5 160.5Q782-399 832-500q-50-101-144.5-160.5T480-720q-113 0-207.5 59.5T128-500q50 101 144.5 160.5T480-280q113 0 207.5-59.5Z',
      download: 'M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z',
      reviews: 'm363-390 117-71 117 71-31-133 104-90-137-11-53-126-53 126-137 11 104 90-31 133ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z'
    };
    // Decorative by default: these sit beside a text label, so announcing them
    // would just double-read the button.
    window.msym = function (name, size) {
      var d = window.MSYM[name];
      if (!d) return '';
      var s = size || 16;
      return '<svg class="msym" viewBox="0 -960 960 960" width="' + s + '" height="' + s +
        '" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';
    };

    // Browser alert()/confirm()/prompt() windows break the visual system and
    // cannot be reviewed, styled, or operated consistently. This single
    // asynchronous dialog is used by the storefront and the admin panel.
    (function () {
      var overlay, titleEl, messageEl, inputWrap, inputEl, acceptBtn, cancelBtn;
      var resolveCurrent, previousFocus;
      function close(value) {
        if (!overlay || overlay.hidden) return;
        overlay.hidden = true;
        var done = resolveCurrent;
        resolveCurrent = null;
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        previousFocus = null;
        if (done) done(value);
      }
      function mount() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.className = 'confirm-overlay cold-dialog-overlay';
        overlay.hidden = true;
        overlay.innerHTML =
          '<section class="confirm-modal cold-dialog" role="dialog" aria-modal="true" aria-labelledby="coldDialogTitle">' +
            '<h3 id="coldDialogTitle" class="pay-title"></h3>' +
            '<p id="coldDialogMessage" class="pay-sub"></p>' +
            '<label id="coldDialogInputWrap" class="adm-field" hidden><span id="coldDialogInputLabel"></span><input id="coldDialogInput" class="adm-input" type="text" autocomplete="off" /></label>' +
            '<div class="confirm-actions"><button class="btn btn-tinted" type="button" id="coldDialogCancel">Cancel</button><button class="btn btn-primary" type="button" id="coldDialogAccept"></button></div>' +
          '</section>';
        document.body.appendChild(overlay);
        titleEl = overlay.querySelector('#coldDialogTitle');
        messageEl = overlay.querySelector('#coldDialogMessage');
        inputWrap = overlay.querySelector('#coldDialogInputWrap');
        inputEl = overlay.querySelector('#coldDialogInput');
        acceptBtn = overlay.querySelector('#coldDialogAccept');
        cancelBtn = overlay.querySelector('#coldDialogCancel');
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
        cancelBtn.addEventListener('click', function () { close(null); });
        acceptBtn.addEventListener('click', function () { close(inputWrap.hidden ? true : inputEl.value); });
        inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); close(inputEl.value); }
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.hidden) close(null); });
      }
      function open(options) {
        mount();
        if (!overlay.hidden) close(null);
        previousFocus = document.activeElement;
        titleEl.textContent = options.title || 'Confirm action';
        messageEl.textContent = options.message || '';
        acceptBtn.textContent = options.acceptLabel || 'Continue';
        cancelBtn.hidden = options.type === 'alert';
        inputWrap.hidden = options.type !== 'prompt';
        inputEl.value = options.value == null ? '' : options.value;
        inputEl.placeholder = options.placeholder || '';
        var label = overlay.querySelector('#coldDialogInputLabel');
        if (label) label.textContent = options.inputLabel || '';
        overlay.hidden = false;
        setTimeout(function () { (options.type === 'prompt' ? inputEl : acceptBtn).focus(); }, 0);
        return new Promise(function (resolve) { resolveCurrent = resolve; });
      }
      window.coldDialog = {
        alert: function (message, options) {
          options = options || {}; options.type = 'alert'; options.message = message; options.acceptLabel = options.acceptLabel || 'Close';
          return open(options);
        },
        confirm: function (message, options) {
          options = options || {}; options.type = 'confirm'; options.message = message; options.acceptLabel = options.acceptLabel || 'Confirm';
          return open(options).then(function (value) { return value === true; });
        },
        prompt: function (message, value, options) {
          options = options || {}; options.type = 'prompt'; options.message = message; options.value = value; options.acceptLabel = options.acceptLabel || 'Save';
          return open(options);
        }
      };
    })();

    (function () {
      // Shared "which products does the signed-in user own" cache - both
      // the product page and the shop/catalog grid need this, so it's
      // loaded once here instead of each page querying Supabase itself.
      var cache = null, pending = null;
      function load() {
        if (cache) return Promise.resolve(cache);
        if (pending) return pending;
        if (!window.coldSupabase) return Promise.resolve({});
        pending = window.coldSupabase.auth.getSession().then(function (res) {
          var session = res && res.data && res.data.session;
          if (!session) { cache = {}; return cache; }
          return window.coldSupabase
            .from('orders')
            .select('status, order_items(product_slug, licence)')
            .eq('user_id', session.user.id)
            .eq('status', 'paid')
            .then(function (r) {
              // Keyed by slug + licence, same composite key the cart itself
              // uses (see add() below) - a resell licence is a materially
              // different, separately-purchasable sale from the personal
              // one, not a quantity of the same thing. Keying purely by
              // slug marked a product "Owned" (and disabled Buy/Add) for
              // EVERY licence once a buyer owned any one of them, including
              // blocking someone who only owns the personal licence from
              // ever buying the resell licence on the same product.
              var owned = {};
              ((r && r.data) || []).forEach(function (o) {
                (o.order_items || []).forEach(function (i) {
                  owned[i.product_slug + (i.licence === 'resell' ? '--resell' : '')] = true;
                });
              });
              cache = owned;
              return cache;
            });
        });
        return pending;
      }
      window.__coldOwned = {
        load: load,
        has: function (slug, licence) { return !!(cache && cache[slug + (licence === 'resell' ? '--resell' : '')]); },
        ready: function () { return !!cache; }
      };
    })();

    (function () {
      // Best-effort mirror of a wishlist add/remove into wishlist_items, so
      // it's visible to anything running outside the buyer's own browser
      // (a sale-price update deciding who to notify, say) - localStorage
      // stays the instant-read source of truth the UI itself uses, this is
      // purely a write-behind copy. Silently no-ops signed out, since
      // there's no user_id to attach it to and the wishlist already works
      // fine locally without an account.
      window.__wishSync = function (slug, added) {
        if (!window.coldSupabase) return;
        window.coldSupabase.auth.getSession().then(function (res) {
          var session = res && res.data && res.data.session;
          if (!session) return;
          return window.coldSupabase.from('products').select('id').eq('slug', slug).maybeSingle().then(function (r) {
            var productId = r && r.data && r.data.id;
            if (!productId) return;
            if (added) {
              return window.coldSupabase.from('wishlist_items').upsert({ user_id: session.user.id, product_id: productId }, { onConflict: 'user_id,product_id' });
            }
            return window.coldSupabase.from('wishlist_items').delete().eq('user_id', session.user.id).eq('product_id', productId);
          });
        }).catch(function () {});
      };
    })();

    // /contact page's form - posts straight to send-contact-message, which
    // holds the reason->destination-email mapping server-side (never trust
    // a client-supplied "send this to X" address). No-ops everywhere else
    // on the site since #contactForm only exists on that one page.
    (function () {
      var form = document.getElementById('contactForm');
      if (!form) return;
      var submitBtn = document.getElementById('ctSubmit');
      var msgEl = document.getElementById('ctMsg');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var label = submitBtn.querySelector('.btn-label'), spinner = submitBtn.querySelector('.btn-spinner');
        var payload = {
          name: document.getElementById('ctName').value.trim(),
          email: document.getElementById('ctEmail').value.trim(),
          reason: document.getElementById('ctReason').value,
          message: document.getElementById('ctMessage').value.trim()
        };
        if (msgEl) { msgEl.textContent = ''; msgEl.className = 'auth-msg'; }
        submitBtn.disabled = true; if (label) label.hidden = true; if (spinner) spinner.hidden = false;
        window.coldSupabase.functions.invoke('send-contact-message', { body: payload })
          .then(function (res) {
            var data = res && res.data;
            if (!data || !data.ok) {
              if (msgEl) { msgEl.textContent = (data && data.error) || 'Could not send your message. Please try again.'; msgEl.className = 'auth-msg show'; }
              return;
            }
            form.reset();
            if (msgEl) { msgEl.textContent = "Thanks - we've got your message and will get back to you soon."; msgEl.className = 'auth-msg ok show'; }
          })
          .catch(function () {
            if (msgEl) { msgEl.textContent = 'Could not send your message. Please try again.'; msgEl.className = 'auth-msg show'; }
          })
          .then(function () {
            submitBtn.disabled = false; if (label) label.hidden = false; if (spinner) spinner.hidden = true;
          });
      });
    })();

    // Site-wide "get 10% off for your email" popup - the discount used to
    // be tied to the checkout marketing checkbox, which wasn't the right
    // place for it (a purchase already in progress isn't the moment to be
    // asking for an email in exchange for a discount on that same order).
    // This is the dedicated version: shows once, independent of checkout,
    // and mints a real one-time code via marketing-signup rather than a
    // discount that only ever existed as a checkbox label.
    (function () {
      var SEEN_KEY = 'coldd_mkt_popup_seen';       // set on an explicit "No thanks" - full 30-day snooze
      var CODE_KEY = 'coldd_mkt_popup_code';        // set once a code is claimed - never ask again
      var MIN_KEY = 'coldd_mkt_popup_min';          // set when the popup is X'd - stays as a corner tab
      var SNOOZE_DAYS = 30;
      var SHOW_DELAY_MS = 20000;

      // Never on checkout (mid-purchase is the wrong moment to interrupt
      // with an unrelated offer) or any account/admin flow.
      if (/^\/(checkout|dashboard|admin|signin|signup|forgot|reset|lock)(\/|$)/.test(location.pathname)) return;

      var minimized = false;
      try {
        if (localStorage.getItem(CODE_KEY)) return; // already claimed a code, never ask again
        minimized = localStorage.getItem(MIN_KEY) === '1';
        var seenAt = parseInt(localStorage.getItem(SEEN_KEY) || '0', 10);
        // An explicit "No thanks" snoozes everything, tab included.
        if (seenAt && (Date.now() - seenAt) / 86400000 < SNOOZE_DAYS) return;
      } catch (e) {}

      function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
      function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
      function markSeen() { lsSet(SEEN_KEY, String(Date.now())); lsDel(MIN_KEY); }

      var tabEl = null;
      // The corner tab: what an X'd popup collapses to. Persists across
      // pages (MIN_KEY) and only goes away on "No thanks" or a claimed code.
      function showTab() {
        lsSet(MIN_KEY, '1');
        if (tabEl) return;
        tabEl = document.createElement('button');
        tabEl.type = 'button';
        tabEl.className = 'mkt-claim-tab';
        tabEl.textContent = 'Claim discount now';
        tabEl.addEventListener('click', function () { hideTab(false); buildPopup(); });
        document.body.appendChild(tabEl);
      }
      function hideTab(clearFlag) {
        if (tabEl) { tabEl.remove(); tabEl = null; }
        if (clearFlag) lsDel(MIN_KEY);
      }

      function buildPopup() {
        var overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML =
          '<div class="confirm-modal mkt-popup-modal">' +
          '<h3 class="mkt-popup-title">First order? Take <span class="mkt-popup-pct">10% off</span>.</h3>' +
          '<p class="mkt-popup-sub">Get new products and sale events first, plus a one-time code waiting in your inbox the second you sign up.</p>' +
          '<form class="mkt-popup-form" id="mktPopupForm">' +
          '<div class="mkt-popup-field">' +
          '<input type="email" id="mktPopupEmail" placeholder="you@example.com" aria-label="Email address" required />' +
          '<button class="btn btn-primary" type="submit"><span class="btn-label">Get my discount</span><span class="btn-spinner" hidden></span></button>' +
          '</div>' +
          '</form>' +
          '<p class="mkt-popup-msg" id="mktPopupMsg"></p>' +
          '<p class="mkt-popup-fine">By continuing you agree to receive marketing emails from coldd. No spam, unsubscribe any time.</p>' +
          '<button class="mkt-popup-no" type="button" id="mktPopupNo">I don\'t want a discount</button>' +
          '</div>';
        document.body.appendChild(overlay);

        // Autofill for a signed-in visitor who already has a real email on
        // file - a Roblox-only account has none (its profile.email is ''),
        // so this naturally leaves the field blank for them instead of
        // filling in the synthetic @roblox.coldd.internal address. Still a
        // normal editable field either way, not locked to the prefill.
        try {
          var knownProfile = window.coldAuth && window.coldAuth.getProfile && window.coldAuth.getProfile();
          var knownEmail = knownProfile && knownProfile.email;
          if (knownEmail && !/@roblox\.coldd\.internal$/i.test(knownEmail)) {
            overlay.querySelector('#mktPopupEmail').value = knownEmail;
          }
        } catch (e) {}

        // Click-outside = minimize to the corner tab. There is no X - the
        // only way past the popup is "I don't want a discount" (a real
        // dismissal) or claiming a code.
        function minimize() { overlay.remove(); showTab(); }
        function decline() { overlay.remove(); hideTab(false); markSeen(); }
        overlay.addEventListener('click', function (e) { if (e.target === overlay) minimize(); });
        overlay.querySelector('#mktPopupNo').addEventListener('click', decline);

        var form = overlay.querySelector('#mktPopupForm');
        var msgEl = overlay.querySelector('#mktPopupMsg');
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var email = overlay.querySelector('#mktPopupEmail').value.trim();
          if (!email || !window.coldSupabase) return;
          var btn = form.querySelector('button[type="submit"]');
          var spinner = btn.querySelector('.btn-spinner');
          btn.disabled = true; if (spinner) spinner.hidden = false;
          window.coldSupabase.functions.invoke('marketing-signup', { body: { email: email, source: 'popup' } }).then(function (res) {
            btn.disabled = false; if (spinner) spinner.hidden = true;
            var data = res && res.data;
            if (res.error || !data || !data.ok || !data.code) {
              msgEl.className = 'mkt-popup-msg err';
              msgEl.textContent = (data && data.error) || 'Could not generate a code. Please try again.';
              return;
            }
            lsSet(CODE_KEY, data.code);
            hideTab(true);
            form.hidden = true;
            var no = overlay.querySelector('#mktPopupNo'); if (no) no.hidden = true;
            msgEl.className = 'mkt-popup-msg ok';
            msgEl.innerHTML = '<span class="mkt-popup-code">' + data.code + '</span>Use this at checkout - we\'ve emailed it to you and saved it to this browser.';
          }).catch(function () {
            btn.disabled = false; if (spinner) spinner.hidden = true;
            msgEl.className = 'mkt-popup-msg err';
            msgEl.textContent = 'Could not generate a code. Please try again.';
          });
        });
      }

      // Already X'd once on a previous page - come back as the tab straight
      // away, no 20s wait, no auto-reopen of the full popup.
      if (minimized) { showTab(); return; }

      var popupTriggered = false;
      function maybeShowPopup() {
        if (popupTriggered) return;
        popupTriggered = true;
        // A signed-in visitor who's already opted into promotions doesn't
        // need to be asked again just because this browser hasn't seen the
        // popup before.
        if (window.coldSupabase) {
          window.coldSupabase.auth.getSession().then(function (res) {
            var session = res && res.data && res.data.session;
            if (!session) { buildPopup(); return; }
            window.coldSupabase.from('profiles').select('notification_prefs').eq('id', session.user.id).maybeSingle().then(function (r) {
              var already = r && r.data && r.data.notification_prefs && r.data.notification_prefs.promotions;
              if (already) { markSeen(); return; }
              buildPopup();
            }).catch(function () { buildPopup(); });
          }).catch(function () { buildPopup(); });
        } else {
          buildPopup();
        }
      }

      // Primary trigger: a fixed delay after load.
      setTimeout(maybeShowPopup, SHOW_DELAY_MS);

      // Addition, not a replacement: if the pointer leaves through the top
      // of the window (heading for the tab bar / back button) before that
      // timer fires, show the offer now rather than losing the visitor. One
      // shot - maybeShowPopup's own guard makes the two triggers race
      // harmlessly, whichever lands first wins.
      document.addEventListener('mouseout', function (e) {
        if (popupTriggered) return;
        if (e.relatedTarget || e.toElement) return;   // moved onto another element, still in the page
        if ((e.clientY || 0) > 8) return;             // only a real exit through the top edge
        maybeShowPopup();
      });
    })();

    // Theme picker (dashboard > Appearance). The actual theme application
    // happens in an early inline <head> script on every page (reads
    // localStorage before paint, sets data-theme on <html>) so there is no
    // flash of the wrong theme on pages other than dashboard; this block
    // only has to sync the segmented control and handle live changes,
    // including live-following the OS when "Sync" is selected.
    (function () {
      var KEY = 'coldd_theme';
      var wrap = document.getElementById('themeSwitch');
      if (!wrap) return;
      var opts = wrap.querySelectorAll('.theme-opt');
      var mq = window.matchMedia('(prefers-color-scheme: light)');

      function apply(mode) {
        var light = mode === 'light' || (mode === 'system' && mq.matches);
        if (light) document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
      }
      function setActive(mode) {
        opts.forEach(function (btn) {
          var on = btn.getAttribute('data-theme-choice') === mode;
          btn.classList.toggle('active', on);
          btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
      }

      var stored = null;
      try { stored = localStorage.getItem(KEY); } catch (e) {}
      var mode = stored === 'light' || stored === 'system' ? stored : 'dark';
      setActive(mode);

      opts.forEach(function (btn) {
        btn.addEventListener('click', function () {
          mode = btn.getAttribute('data-theme-choice');
          setActive(mode);
          apply(mode);
          try {
            if (mode === 'dark') localStorage.removeItem(KEY);
            else localStorage.setItem(KEY, mode);
          } catch (e) {}
        });
      });

      mq.addEventListener('change', function () {
        if (mode === 'system') apply('system');
      });
    })();

    // Back to top - mobile only (see .back-to-top's max-width:1100px gate in
    // styles.css, matching the site's nav breakpoint). Desktop pages are
    // short enough with a persistent floating nav that this is redundant
    // there; on mobile the nav collapses into a hamburger with no equivalent
    // quick return-to-top path.
    (function () {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'back-to-top';
      btn.setAttribute('aria-label', 'Back to top');
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      document.body.appendChild(btn);

      var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var visible = false;
      function onScroll() {
        var show = window.scrollY > 600;
        if (show === visible) return;
        visible = show;
        btn.classList.toggle('show', show);
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
      btn.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      });
    })();

    // Currency conversion (window.__money/__usd/__robux/__fiat/__currencyMode,
    // the #curSwitch dropdown) moved to catalog.js. It used to live here, but
    // app.js only loads once catalog.js's Supabase fetch resolves (see
    // catalog.js's loadDependents/data-then), which is a couple seconds on a
    // cold load - every price on the page painted in USD from the static
    // markup and then visibly snapped to the visitor's real stored currency
    // once this file finally showed up. catalog.js runs synchronously as
    // soon as its <script> tag is reached, before that fetch resolves, so
    // moving the conversion there makes the first paint already correct.

    (function () {
      const bar = document.getElementById('announce');
      if (!bar) return;
      var DISMISS_KEY = 'coldd_ann_dismissed';
      function hide() { document.documentElement.setAttribute('data-ann', 'off'); window.dispatchEvent(new Event('resize')); }
      const x = document.getElementById('announceX');
      // This is a static multi-page site, not an SPA - every click to a
      // different page re-runs this whole script from scratch, so without
      // remembering the dismissal a visitor had to close the same banner
      // again on every single page they visited ("why does this keep
      // coming back"). sessionStorage (not a cookie or localStorage) keyed
      // on the specific sale's id: it survives normal browsing but clears
      // when the tab closes, and a NEW sale event still gets shown once
      // even if an old one was dismissed earlier.
      if (x) x.addEventListener('click', function () {
        var sale = window.__ACTIVE_SALE;
        if (sale && sale.id) { try { sessionStorage.setItem(DISMISS_KEY, sale.id); } catch (e) {} }
        hide();
      });

      // Starts hidden (see the <html> tag - data-ann has no "on" baked in
      // by default anymore) so there's nothing to flash. This branch is the
      // only thing that ever turns it on, and only once a real active sale
      // is confirmed - previously the static markup shipped a hardcoded
      // "on" state plus placeholder promo copy, which meant every visitor
      // saw stale/wrong text for one frame before this code caught up and
      // hid it again.
      const sale = window.__ACTIVE_SALE;
      if (!sale) { hide(); return; }
      var dismissed = null;
      try { dismissed = sessionStorage.getItem(DISMISS_KEY); } catch (e) {}
      if (sale.id && dismissed === sale.id) { hide(); return; }
      const msg = bar.querySelector('.announce-msg');
      if (msg) {
        const link = msg.querySelector('.announce-link');
        const linkHtml = link ? link.outerHTML : '';
        const escText = String(sale.message || sale.title || '').replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
        // Sale events end at the close of endDate (a YYYY-MM-DD, no time),
        // so day-granular urgency is all that's honest here - no live ticker.
        var endsIn = '';
        if (sale.endDate) {
          var end = new Date(sale.endDate + 'T23:59:59');
          var days = Math.ceil((end - Date.now()) / 86400000);
          if (days === 1) endsIn = ' <span class="announce-ends">Ends today</span>';
          else if (days === 2) endsIn = ' <span class="announce-ends">Ends tomorrow</span>';
          else if (days > 2) endsIn = ' <span class="announce-ends">' + days + ' days left</span>';
        }
        msg.innerHTML = escText + endsIn + ' ' + linkHtml;
      }
      document.documentElement.setAttribute('data-ann', 'on');
      window.dispatchEvent(new Event('resize'));
    })();

    const nav = document.getElementById('nav');
    const backdrop = document.querySelector('.backdrop');
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let winH = window.innerHeight;
    function measure() { winH = window.innerHeight; render(); }
    let ticking = false;
    function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(render); } }
    function render() {
      ticking = false;
      nav.classList.toggle('scrolled', window.scrollY > 12);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    window.addEventListener('load', measure);
    measure();

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const els = document.querySelectorAll('.reveal');
    // This only ever ran once, over whatever .reveal elements existed at the
    // moment app.js executed. Pages whose content loads after app.js (e.g.
    // reviews-page.js, chained behind app.js in catalog.js's data-then so
    // the review count is known first) inject .reveal cards that never got
    // observed - html.js .reveal defaults to opacity:0 until the observer
    // adds .in, so those cards sat fully rendered in the DOM but invisible,
    // forever. Exposed so any script rendering .reveal content after load
    // can register it - reviews-page.js calls this once after its render().
    window.__scanReveal = function (root) {
      var scope = root || document;
      var found = scope.querySelectorAll('.reveal');
      if (reduce || !('IntersectionObserver' in window)) {
        found.forEach(e => e.classList.add('in'));
      } else if (window.__revealIo) {
        found.forEach(e => window.__revealIo.observe(e));
      }
    };
    if (reduce || !('IntersectionObserver' in window)) {
      els.forEach(e => e.classList.add('in'));
    } else {
      const io = new IntersectionObserver((en) => en.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }), { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      window.__revealIo = io;
      els.forEach(e => io.observe(e));
    }

    (function () {
      var nums = document.querySelectorAll('.as-num[data-count]');
      if (!nums.length) return;
      function paint(el, val) {
        var n = Math.round(val);
        var text = el.hasAttribute('data-plain') ? String(n) : n.toLocaleString('en-US');
        el.textContent = text + (el.getAttribute('data-suffix') || '');
      }
      function run(el) {
        var target = parseFloat(el.getAttribute('data-count')) || 0;
        if (reduce) { paint(el, target); return; }
        var start = null, dur = 1300;
        function tick(ts) {
          if (start === null) start = ts;
          var p = Math.min((ts - start) / dur, 1);
          paint(el, target * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }
      if (!('IntersectionObserver' in window)) {
        nums.forEach(function (el) { paint(el, parseFloat(el.getAttribute('data-count')) || 0); });
      } else {
        var io2 = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) { run(e.target); e.target.__coldAnimated = true; io2.unobserve(e.target); }
          });
        }, { threshold: 0.5 });
        nums.forEach(function (el) { io2.observe(el); });
      }

      // About page's "Discord members" stat - same live proxied count the
      // homepage hero uses. If this figure sits above the fold it can
      // already be observed/animated (using the static fallback) before
      // this fetch resolves - a real (if unlikely) race, not just a
      // hypothetical one, since it's a network round trip against a
      // scroll-into-view that can already be true at page load. Updating
      // data-count alone doesn't repaint text that already finished
      // animating, so re-paint directly with the live count when that
      // happened instead of leaving the stale fallback on screen.
      var aboutDiscordEl = document.getElementById('aboutStatDiscord');
      if (aboutDiscordEl && window.coldSupabase) {
        window.coldSupabase.functions.invoke('public-site-stats', { body: {} }).then(function (res) {
          var count = res && res.data && res.data.discordMemberCount;
          if (typeof count === 'number') {
            aboutDiscordEl.setAttribute('data-count', count);
            aboutDiscordEl.setAttribute('data-suffix', '');
            if (aboutDiscordEl.__coldAnimated) paint(aboutDiscordEl, count);
          }
        }).catch(function () {});
      }
    })();

    (function () {
      const wrap = document.getElementById('heroStats');
      if (!wrap) return;
      const nums = Array.prototype.slice.call(wrap.querySelectorAll('.hn[data-target]'));
      if (!nums.length) return;

      // Products: real, exact catalog count (both platforms).
      const productsEl = document.getElementById('heroStatProducts');
      if (productsEl) {
        const count = (window.__CATALOG || []).length;
        if (count > 0) {
          productsEl.setAttribute('data-target', count);
          productsEl.setAttribute('data-suffix', '');
        }
      }

      // Discord: the real, live (unrounded) member count - proxied through
      // our own function since Discord's API doesn't send CORS headers for
      // direct browser fetches (same reason admin-discord-stats exists).
      // Waited on below so the animation always plays with the real number
      // instead of the static fallback baked into the HTML.
      const discordEl = document.getElementById('heroStatDiscord');
      const discordReady = (discordEl && window.coldSupabase)
        ? window.coldSupabase.functions.invoke('public-site-stats', { body: {} }).then(function (res) {
            var count = res && res.data && res.data.discordMemberCount;
            if (typeof count === 'number') {
              discordEl.setAttribute('data-target', count);
              discordEl.setAttribute('data-suffix', '');
            }
          }).catch(function () {})
        : Promise.resolve();

      // Reveal the numbers (see styles.css's .hs-loading, which keeps them
      // invisibility:hidden but laid out) the moment both real figures are
      // known, independent of the count-up animation's own scroll-gated
      // timing below - a visitor who never scrolls the hero into view
      // (unlikely, it's above the fold, but the animation code already
      // treats that as possible) shouldn't be stuck looking at a
      // permanently blanked-out stat forever.
      discordReady.then(function () { wrap.classList.remove('hs-loading'); });

      function setFinal(el) {
        var target = Number(el.getAttribute('data-target')) || 0;
        el.textContent = target.toLocaleString('en-US') + (el.getAttribute('data-suffix') || '');
      }

      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Count-up runs on the REAL resolved figure, never on the static fallback
      // baked into the markup - otherwise the number visibly climbs to 850 and
      // then snaps to the true catalog count, which reads as broken. The
      // tabular-nums lock in CSS keeps the digits from reflowing mid-count.
      function countUp(el) {
        var target = Number(el.getAttribute('data-target')) || 0;
        var suffix = el.getAttribute('data-suffix') || '';
        if (reduced || target <= 0) { setFinal(el); return; }

        // Longer for bigger numbers, but bounded - a visitor should never wait
        // on a decoration to read a figure they came for.
        var dur = Math.min(1600, 700 + Math.log10(Math.max(target, 10)) * 260);
        var start = 0;

        function frame(now) {
          if (!start) start = now;
          var t = Math.min((now - start) / dur, 1);
          // easeOutExpo: fast out of the gate, long settle. Reads as an odometer
          // landing rather than a linear tick.
          var eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
          el.textContent = Math.round(target * eased).toLocaleString('en-US') + suffix;
          if (t < 1) requestAnimationFrame(frame);
          else setFinal(el);
        }
        requestAnimationFrame(frame);
      }

      // Only animate once, and only while the stats are actually on screen -
      // counting up in a scrolled-past viewport is motion nobody sees.
      var played = false;
      function play() {
        if (played) return;
        played = true;
        discordReady.then(function () { nums.forEach(countUp); });
      }

      if (!('IntersectionObserver' in window)) { play(); return; }
      var statIo = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { play(); statIo.disconnect(); }
        });
      }, { threshold: 0.4 });
      statIo.observe(wrap);

      // Truth outranks the animation. The markup ships a static fallback (850
      // products) that the live catalog count replaces, so if the observer
      // never fires - zero-height viewport, a browser that reports no
      // intersection, the section never scrolled to - the visitor would be
      // left reading a stale, wrong number indefinitely. Print the real
      // figures regardless once they resolve; if the count-up has already
      // started this is a no-op, since play() is latched.
      discordReady.then(function () {
        setTimeout(function () {
          if (played) return;
          played = true;
          nums.forEach(setFinal);
        }, 1200);
      });
    })();

    (function () {
      const track = document.getElementById('nrTrack');
      if (!track) return;
      const dotsWrap = document.getElementById('nrDots');

      // The section ships with static placeholder slides. Replace them with
      // the actual newest live products (by real created_at) once the
      // Supabase-backed catalog has loaded.
      const newest = (window.__CATALOG || []).slice().sort(function (a, b) {
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      }).slice(0, 6);
      if (newest.length) {
        function escNr(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
        track.innerHTML = newest.map(function (p) {
          // The image lives on its own .nr-bg layer so the drift animation can
          // scale the photograph without dragging the caption and button with
          // it. The static placeholder slides in the markup keep their inline
          // background on .nr-slide, which still renders if the catalog fetch
          // never resolves.
          return '<div class="nr-slide"><span class="nr-bg" style="background-image:url(\'' + p.image + '\')"></span><div class="nr-cap"><span class="nr-chip">New</span><span class="nr-title">' + escNr(p.title) + '</span><a class="btn nr-view" href="/product/' + encodeURIComponent(p.id) + '">View product</a></div></div>';
        }).join('');
        if (dotsWrap) dotsWrap.innerHTML = newest.map(function () { return '<span class="nr-dot"></span>'; }).join('');
      }

      const slides = track.children.length;
      if (slides <= 1) { var sec = track.closest('section'); if (sec) sec.hidden = true; return; }
      const dots = Array.prototype.slice.call(document.querySelectorAll('#nrDots .nr-dot'));
      const DELAY = 3500;
      // Reduced-motion users still get auto-advance (WCAG-friendly cadence, no forced motion
      // to opt into); the CSS's own reduced-motion rule already strips the slide transition,
      // so this just becomes an instant cut instead of a smooth slide.
      let i = 0, timer = null;
      const slideEls = Array.prototype.slice.call(track.children);
      function go(n) {
        i = (n % slides + slides) % slides;
        track.style.transform = 'translateX(' + (-i * 100) + '%)';
        dots.forEach(function (d, idx) { d.classList.toggle('active', idx === i); });
        // Drives the drift + caption stagger in CSS. The class is removed and
        // re-added rather than left on, so returning to a slide replays its
        // entrance instead of showing an already-finished animation.
        slideEls.forEach(function (s, idx) {
          if (idx === i) {
            s.classList.remove('is-active');
            // Reading offsetWidth forces a style flush between the remove and
            // the add; without it the browser coalesces both into one frame and
            // the animation never restarts.
            void s.offsetWidth;
            s.classList.add('is-active');
          } else {
            s.classList.remove('is-active');
          }
        });
      }
      function start() { if (!timer) timer = setInterval(function () { go(i + 1); }, DELAY); }
      function stop() { clearInterval(timer); timer = null; }
      go(0);

      dots.forEach(function (d, idx) {
        d.style.cursor = 'pointer';
        d.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        d.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          go(idx); stop(); start();
        });
      });

      start();
      document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

      // Without this, the slide can auto-advance out from under the cursor
      // between the user reading a slide and clicking it, sending them to
      // whatever product rotated in next instead of the one they saw.
      var frame = track.closest('.nr-frame') || track;
      frame.addEventListener('mouseenter', stop);
      frame.addEventListener('mouseleave', start);
      frame.addEventListener('focusin', stop);
      frame.addEventListener('focusout', start);
    })();

    const tpanels = document.querySelectorAll('.tpanel');
    const teamGrid = document.querySelector('.team');
    tpanels.forEach(pn => pn.addEventListener('mouseenter', () => {
      tpanels.forEach(x => x.classList.remove('active'));
      pn.classList.add('active');
    }));
    if (teamGrid) teamGrid.addEventListener('mouseleave', () => {
      tpanels.forEach(x => x.classList.remove('active'));
    });

    (function () {
      const links = document.querySelector('.nav-links');
      const navSet = document.querySelector('.nav-set');
      const btn = document.getElementById('searchBtn');
      const input = document.getElementById('searchInput');
      const nav = document.getElementById('nav');
      const panel = document.getElementById('searchPanel');
      const list = document.getElementById('searchList');
      if (!links || !navSet || !btn || !input) return;
      function isOpen() { return links.classList.contains('searching'); }
      function open() {
        if (isOpen()) return;
        navSet.style.maxWidth = navSet.scrollWidth + 'px';
        navSet.getBoundingClientRect();
        links.classList.add('searching');
        navSet.style.maxWidth = '0px';
        setTimeout(function () { input.focus(); }, 60);
      }
      function close() {
        if (!isOpen()) return;
        links.classList.remove('searching');
        navSet.style.maxWidth = navSet.scrollWidth + 'px';
        setTimeout(function () { navSet.style.maxWidth = 'none'; }, 600);
        input.value = ''; input.blur();
        hidePanel();
      }

      function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
      function priceStr(p) {
        var usd = parseFloat(String(p).replace(/[^0-9.]/g, '')) || 0;
        if (window.__price) return window.__price(usd);
        return usd > 0 ? ('$' + usd) : 'Free';
      }
      function highlight(text, q) {
        const i = text.toLowerCase().indexOf(q);
        if (i < 0) return esc(text);
        return esc(text.slice(0, i)) + '<b>' + esc(text.slice(i, i + q.length)) + '</b>' + esc(text.slice(i + q.length));
      }
      function positionPanel() {
        if (!panel || !nav) return;
        const r = nav.getBoundingClientRect();
        panel.style.top = (r.bottom + 12) + 'px';
      }
      function hidePanel() { if (panel) panel.classList.remove('open'); }
      function showPanel() { if (panel) { positionPanel(); panel.classList.add('open'); } }

      const PAGES = [
        { label: 'Home', href: '/' },
        { label: 'Shop', href: '/shop' },
        { label: 'About Us', href: '/about' }
      ];
      function groupHeader(label) {
        const h = document.createElement('div'); h.className = 'search-group'; h.textContent = label;
        return h;
      }
      function pageRow(href, label, q) {
        const a = document.createElement('a');
        a.className = 'sresult sresult-cat';
        a.href = href;
        a.innerHTML =
          '<span class="sresult-cicon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M4 9h16"/><path d="M9 9v11"/></svg></span>' +
          '<span class="sresult-info"><span class="sresult-title">' + highlight(label, q) + '</span></span>' +
          '<span class="sresult-go">→</span>';
        a.addEventListener('mousedown', function (e) { e.preventDefault(); });
        a.addEventListener('click', function () { close(); });
        return a;
      }
      function runSearch() {
        if (!panel || !list) return;
        const q = input.value.trim().toLowerCase();
        if (!q) { hidePanel(); return; }

        const pages = PAGES.filter(function (pg) { return pg.label.toLowerCase().indexOf(q) >= 0; });
        const cats = (window.__CATEGORIES || []).filter(function (c) {
          return c.label.toLowerCase().indexOf(q) >= 0;
        }).slice(0, 5);
        const assets = (window.__CATALOG || []).filter(function (p) {
          return p.title.toLowerCase().indexOf(q) >= 0;
        }).slice(0, 8);

        list.innerHTML = '';
        if (!pages.length && !cats.length && !assets.length) {
          list.innerHTML = '<div class="search-empty">No matches for <b>' + esc(input.value.trim()) + '</b></div>';
          showPanel(); return;
        }

        if (pages.length) {
          list.appendChild(groupHeader('Pages'));
          pages.forEach(function (pg) { list.appendChild(pageRow(pg.href, pg.label, q)); });
        }

        if (cats.length) {
          list.appendChild(groupHeader('Categories'));
          cats.forEach(function (c) {
            const a = document.createElement('a');
            a.className = 'sresult sresult-cat';
            a.href = c.page + '?cat=' + c.slug;
            a.innerHTML =
              '<span class="sresult-cicon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span>' +
              '<span class="sresult-info"><span class="sresult-title">' + highlight(c.label, q) + '</span></span>' +
              '<span class="sresult-go">→</span>';
            a.addEventListener('mousedown', function (e) { e.preventDefault(); });
            a.addEventListener('click', function () { close(); });
            list.appendChild(a);
          });
        }

        if (assets.length) {
          list.appendChild(groupHeader('Assets'));
          assets.forEach(function (p) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'sresult';
            b.innerHTML =
              '<span class="sresult-thumb" style="background-image:url(\'' + p.image + '\')"></span>' +
              '<span class="sresult-info"><span class="sresult-title">' + highlight(p.title, q) + '</span></span>' +
              '<span class="sresult-price">' + esc(priceStr(p.price)) + '</span>';
            b.addEventListener('mousedown', function (e) { e.preventDefault(); });
            b.addEventListener('click', function () {
              // Opens the real product page in a new tab, matching what a
              // catalog card already does. This was the last caller of the
              // retired quick-view modal, which is why that panel could still
              // appear from search long after it was removed everywhere else.
              var a = document.createElement('a');
              a.href = '/product/' + encodeURIComponent(p.id);
              a.target = '_blank'; a.rel = 'noopener';
              a.click();
              close();
            });
            list.appendChild(b);
          });
        }
        showPanel();
      }

      // Log a search once the query settles (1.4s idle) or on Enter, not
      // per keystroke - and never the same query twice in a row.
      var lastLoggedQuery = '', searchLogTimer = null;
      function logSearch() {
        var q = input.value.trim();
        if (!q || q.length < 2 || q.toLowerCase() === lastLoggedQuery) return;
        lastLoggedQuery = q.toLowerCase();
        var n = list ? list.querySelectorAll('.sresult').length : 0;
        if (window.coldTrack) window.coldTrack('search', { q: q, results: n });
      }

      btn.addEventListener('mousedown', function (e) { if (isOpen()) e.preventDefault(); });
      btn.addEventListener('click', function (e) { e.preventDefault(); isOpen() ? close() : open(); });
      input.addEventListener('input', function () {
        runSearch();
        clearTimeout(searchLogTimer);
        searchLogTimer = setTimeout(logSearch, 1400);
      });
      input.addEventListener('focus', function () { if (input.value.trim()) runSearch(); });
      input.addEventListener('blur', function () { setTimeout(function () { if (isOpen()) close(); }, 120); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(searchLogTimer); logSearch();
          const first = list && list.querySelector('.sresult');
          if (first) first.click();
        }
      });
      window.addEventListener('resize', function () { if (panel && panel.classList.contains('open')) positionPanel(); });
      window.addEventListener('scroll', function () { if (panel && panel.classList.contains('open')) positionPanel(); }, { passive: true });
      window.addEventListener('currencychange', function () { if (panel && panel.classList.contains('open')) runSearch(); });
    })();

    (function () {
      // .menu-btn is the hamburger shown <=900px (see styles.css) once
      // .nav-links itself is hidden - it previously had no click handler
      // anywhere in the codebase, so there was no way to reach Home/Shop/
      // About from the header on mobile at all. Reuses .nav-links
      // (search bar included) as a full-screen overlay instead of building
      // separate markup.
      const menuBtn = document.querySelector('.menu-btn');
      const links = document.querySelector('.nav-links');
      if (!menuBtn || !links) return;
      const OPEN_ICON = menuBtn.innerHTML;
      const CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      function isMenuOpen() { return links.classList.contains('mobile-open'); }

      // The currency switcher is hidden from .tc below 900px: the nav pill and
      // .tc cannot both fit a full control set at 375px, and currency is the
      // low-frequency one. Move (not clone, so its listeners survive) the live
      // node into the menu panel while open, and put it back on close.
      const curSwitch = document.getElementById('curSwitch');
      const curHome = curSwitch && curSwitch.parentElement;
      function stowCurrency() {
        if (curSwitch && curHome && curSwitch.parentElement !== curHome) curHome.appendChild(curSwitch);
      }
      function lendCurrency() {
        if (curSwitch && curSwitch.parentElement !== links) links.appendChild(curSwitch);
      }

      function closeMenu() {
        if (!isMenuOpen()) return;
        links.classList.remove('mobile-open');
        menuBtn.innerHTML = OPEN_ICON;
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.setAttribute('aria-label', 'Menu');
        document.body.classList.remove('nav-menu-open');
        stowCurrency();
      }
      function openMenu() {
        if (isMenuOpen()) return;
        links.classList.add('mobile-open');
        menuBtn.innerHTML = CLOSE_ICON;
        menuBtn.setAttribute('aria-expanded', 'true');
        menuBtn.setAttribute('aria-label', 'Close menu');
        document.body.classList.add('nav-menu-open');
        lendCurrency();
      }
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.addEventListener('click', function () { isMenuOpen() ? closeMenu() : openMenu(); });
      links.addEventListener('click', function (e) { if (e.target.closest('a')) closeMenu(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
      // Must match the nav collapse breakpoint in styles.css: past it the
      // links return to the pill and the panel has to give the currency
      // switcher back to .tc.
      window.addEventListener('resize', function () { if (window.innerWidth > 1100) closeMenu(); });
    })();

    (function () {
      const trigger = document.getElementById('shopLink');
      const mega = document.getElementById('navMega');
      if (!trigger || !mega) return;
      let hideT;
      function position() {
        const r = trigger.getBoundingClientRect();
        const w = mega.offsetWidth;
        let left = r.left + r.width / 2 - w / 2;
        left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
        mega.style.left = left + 'px';
        mega.style.top = (r.bottom + 12) + 'px';
      }
      // Mobile Safari fires a synthetic mouseenter on the first tap of any
      // element with hover listeners (its long-standing hover-before-click
      // compatibility shim) - so tapping "Shop" inside the mobile hamburger
      // panel opened this fixed, z-index:150 flyout on top of that panel
      // instead of just following the link. The desktop hover flyout has no
      // mobile equivalent (categories there live behind /shop' filter
      // panel instead), so it should never open without a real hover
      // device to begin with.
      function canHover() {
        return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      }
      function open() {
        if (!canHover()) return;
        const links = document.querySelector('.nav-links');
        if (links && links.classList.contains('searching')) return;
        clearTimeout(hideT); position(); mega.classList.add('open');
      }
      function close() { hideT = setTimeout(function () { mega.classList.remove('open'); }, 130); }
      trigger.addEventListener('mouseenter', open);
      trigger.addEventListener('mouseleave', close);
      mega.addEventListener('mouseenter', function () { clearTimeout(hideT); });
      mega.addEventListener('mouseleave', close);
      window.addEventListener('resize', function () { if (mega.classList.contains('open')) position(); });

      const tabs = mega.querySelectorAll('.nmt-tab');
      const panels = mega.querySelectorAll('.nav-mega-cats[data-platform-panel]');
      const feature = document.getElementById('navMegaFeature');
      function setPlatform(platform) {
        tabs.forEach(function (t) {
          const active = t.getAttribute('data-platform') === platform;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        panels.forEach(function (p) { p.hidden = p.getAttribute('data-platform-panel') !== platform; });
        if (feature) {
          feature.setAttribute('href', feature.getAttribute('data-href-' + platform) || feature.getAttribute('href'));
          const img = feature.querySelector('.nmf-img');
          const url = feature.getAttribute('data-img-' + platform);
          if (img && url) img.style.backgroundImage = "url('" + url + "')";
        }
        if (mega.classList.contains('open')) position();
      }
      // Click only, not hover - a hover-triggered switch used to swap the
      // panel out from under the cursor on the way to a category.
      tabs.forEach(function (t) {
        t.addEventListener('click', function () { setPlatform(t.getAttribute('data-platform')); });
      });
    })();

    (function () {
      const wrap = document.getElementById('platSelect');
      const btn = document.getElementById('platBtn');
      const menu = document.getElementById('platMenu');
      if (!wrap || !btn || !menu) return;
      function close() { wrap.classList.remove('open'); menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
      function open() { wrap.classList.add('open'); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); window.__coldMenuFit && window.__coldMenuFit(menu, wrap); }
      btn.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden ? open() : close(); });
      document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    })();

    // Ratings render from the live catalog only. Product cards used to carry
    // hardcoded stars and counts that no database row backed, so a card
    // advertising "(214)" opened onto a product page reading "Reviews (0)" -
    // and the sort read data-reviews, which those cards never set, so it
    // ranked them as 0 while displaying 214. Shared because the shop grids and
    // the homepage's featured/deals grids both need it.
    var STAR_SVG = "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M12 2.1l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.16l-5.9 3.11 1.13-6.57L2.45 9.04l6.6-.96z\"/></svg>";
    window.__coldRating = (function () {
      function slugOf(card) {
        var nameEl = card.querySelector('.p-name');
        var t = nameEl ? nameEl.textContent.trim() : '';
        return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      }
      function starsHtmlFor(p) {
        if (!(p.reviews > 0)) return '';
        var full = Math.round(p.rating), st = '';
        for (var i = 0; i < 5; i++) st += '<span class="st' + (i < full ? ' on' : '') + '">' + STAR_SVG + '</span>';
        return '<div class="p-stars">' + st + '<span class="p-rc">(' + p.reviews + ')</span></div>';
      }
      function applyRating(card, p) {
        card.setAttribute('data-reviews', p.reviews || 0);
        card.setAttribute('data-rating', p.rating || 0);
        var current = card.querySelector('.p-stars');
        var html = starsHtmlFor(p);
        if (!html) { if (current) current.remove(); return; }
        if (current) { current.outerHTML = html; return; }
        var priceRow = card.querySelector('.p-price-row');
        if (priceRow) priceRow.insertAdjacentHTML('afterend', html);
      }
      return { slugOf: slugOf, starsHtmlFor: starsHtmlFor, applyRating: applyRating };
    })();

    // One spend-tier ladder, shared by the checkout order summary, the
    // cart drawer and the Place-order offer modal. Given a subtotal
    // already in the display unit plus the tier table, it returns the
    // status line + meter markup and the tier / next / gap facts callers
    // need. The meter is four equal segments, one per tier, so the fill
    // and the 10/15/20/25% scale under it always line up - the real
    // thresholds are not evenly spaced, and positioning the labels by
    // true proportion is what made the old version read like a
    // spreadsheet.
    window.__coldTierLadder = (function () {
      function build(sub, opts) {
        opts = opts || {};
        var fmt = opts.fmt || function (n) { return '$' + n; };
        var rawThr = opts.thresholdFor || function (t) { return t.minSubtotal != null ? t.minSubtotal : t.min; };
        // Keep each caller's original tier object so their thresholdFor
        // (which reads .minSubtotal) still works, and precompute the
        // resolved threshold + pct next to it.
        var tiers = (opts.tiers || []).map(function (t) {
          return { pct: t.pct, at: rawThr(t) };
        }).sort(function (a, b) { return a.at - b.at; });
        if (!(sub > 0) || !tiers.length) return { hidden: true, html: '', tier: null, next: null, gap: 0 };

        var reached = 0, tier = null, next = null;
        for (var i = 0; i < tiers.length; i++) { if (sub >= tiers[i].at) { reached = i + 1; tier = tiers[i]; } }
        for (var j = 0; j < tiers.length; j++) { if (sub < tiers[j].at) { next = tiers[j]; break; } }

        var seg = 100 / tiers.length;
        var fillPct;
        if (!next) fillPct = 100;
        else {
          var lo = reached === 0 ? 0 : tiers[reached - 1].at;
          var hi = next.at;
          var frac = hi > lo ? Math.max(0, Math.min(1, (sub - lo) / (hi - lo))) : 0;
          fillPct = Math.min(100, (reached + frac) * seg);
        }
        var gap = next ? Math.max(0, next.at - sub) : 0;
        var msg = next
          ? (tier
              ? '<b>' + tier.pct + '% off</b> applied - add ' + fmt(gap) + ' for ' + next.pct + '%'
              : 'Add ' + fmt(gap) + ' to unlock ' + next.pct + '% off')
          : '<b>' + tier.pct + '% off</b> applied - you’re at the top tier';
        var tick = tier
          ? '<svg class="co-tier-tick" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>'
          : '';
        var amt = opts.fmtThreshold || fmt;
        var steps = tiers.map(function (t) {
          var d = sub >= t.at, n = next && t.at === next.at;
          return '<span class="co-tier-step' + (d ? ' done' : '') + (n ? ' next' : '') + '">' +
            '<b>' + amt(t.at) + '</b><i>' + t.pct + '% off</i></span>';
        }).join('');
        var html =
          '<div class="co-tier-status' + (tier ? ' unlocked' : '') + '">' + tick + '<span>' + msg + '</span></div>' +
          '<div class="co-tier-meter"><div class="co-tier-fill" style="width:' + fillPct.toFixed(1) + '%"></div></div>' +
          '<div class="co-tier-scale">' + steps + '</div>';
        return { hidden: false, html: html, tier: tier, next: next, gap: gap };
      }
      // Render a built ladder into `box`, animating the meter fill from
      // wherever it was last time (or 0 on first paint) to its new width -
      // so adding an item slides the bar rather than snapping it.
      function apply(box, res) {
        if (!box) return;
        if (res.hidden) { box.hidden = true; box.innerHTML = ''; box.removeAttribute('data-fill'); return; }
        box.hidden = false;
        var prev = box.getAttribute('data-fill');
        box.innerHTML = res.html;
        var fill = box.querySelector('.co-tier-fill');
        if (fill) {
          var target = fill.style.width;
          if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            // Set the start width, force the browser to commit it, then set
            // the target - the reflow between the two is what makes the
            // transition run. Not requestAnimationFrame: rAF callbacks are
            // paused while the tab is hidden, which would leave the bar
            // stuck at its start width.
            fill.style.width = (prev != null ? prev : '0%');
            void fill.offsetWidth;
            fill.style.width = target;
          }
          box.setAttribute('data-fill', target);
        }
      }
      return { build: build, apply: apply };
    })();

    // Keep an open dropdown menu inside the viewport. Every menu on the
    // site is CSS-positioned directly under its trigger (top: 100% + gap)
    // at a fixed width, with no edge handling - near the bottom or a side
    // of a short or zoomed window the menu ran past the edge, which grew
    // the page to fit it instead of letting it float over the content
    // below. Called once, right after a menu is shown: it flips the menu
    // above its trigger when there is no room below (and there is above),
    // and re-anchors it horizontally when a side is crossed. A menu that
    // already fits is left exactly where its stylesheet put it.
    window.__coldMenuFit = function (menu, anchor, opts) {
      if (!menu || menu.hidden) return;
      opts = opts || {};
      var pad = opts.pad == null ? 8 : opts.pad;   // min gap to the viewport edge
      var gap = opts.gap == null ? 8 : opts.gap;   // gap between trigger and menu
      // Clear any correction from a previous open so we measure the CSS default.
      menu.style.top = ''; menu.style.bottom = ''; menu.style.left = ''; menu.style.right = '';
      menu.style.maxHeight = ''; menu.style.overflowY = '';
      menu.classList.remove('menu-flipped');
      anchor = anchor || menu.parentElement;
      if (!anchor) return;
      // Only meaningful for a menu the stylesheet floats out of flow.
      if (getComputedStyle(menu).position !== 'absolute') return;
      var a = anchor.getBoundingClientRect();
      var m = menu.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      if (vw < 1 || vh < 1) return;
      var below = vh - a.bottom - gap - pad;
      var above = a.top - gap - pad;
      if (m.height > below && above > below) {
        menu.style.top = 'auto';
        menu.style.bottom = 'calc(100% + ' + gap + 'px)';
        menu.classList.add('menu-flipped');
        if (m.height > above) { menu.style.maxHeight = Math.max(120, above) + 'px'; menu.style.overflowY = 'auto'; }
      } else if (m.height > below) {
        menu.style.maxHeight = Math.max(120, below) + 'px';
        menu.style.overflowY = 'auto';
      }
      // Horizontal: only touch it if an edge is actually crossed. Anchoring
      // to the opposite edge covers the common case (a menu wider than its
      // trigger, sitting near the right side of the window).
      m = menu.getBoundingClientRect();
      if (m.right > vw - pad) { menu.style.left = 'auto'; menu.style.right = '0px'; }
      else if (m.left < pad) { menu.style.right = 'auto'; menu.style.left = '0px'; }
    };

    // Custom <select> - the native control's dropdown can't be styled to
    // match the site, so every <select data-csel> keeps its real element
    // in the DOM (form submit, no-JS fallback) but hidden, and a styled
    // button + menu drives it, dispatching a real 'change' so existing
    // listeners never know the difference. Same neutral-fill / drawn-tick
    // idiom as the shop sort menu.
    window.__coldSelect = (function () {
      var openMenu = null;
      document.addEventListener('click', function () { if (openMenu) openMenu(); });
      function enhance(sel) {
        if (!sel || sel.__csel || sel.multiple) return;
        sel.__csel = true;
        var opts = Array.prototype.slice.call(sel.options);
        var wrap = document.createElement('div');
        wrap.className = 'csel';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'csel-btn';
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        if (sel.id) btn.setAttribute('aria-label', (sel.getAttribute('aria-label') || sel.id));
        btn.innerHTML = '<span class="csel-val"></span>' +
          '<svg class="csel-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
        var menu = document.createElement('div');
        menu.className = 'csel-menu';
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        opts.forEach(function (o) {
          if (o.disabled) return; // e.g. a "Choose…" placeholder option
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'csel-opt';
          b.setAttribute('role', 'option');
          b.setAttribute('data-value', o.value);
          b.innerHTML = '<span>' + o.textContent + '</span>' +
            '<svg class="csel-tick" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
          b.addEventListener('click', function () { pick(o.value); close(); btn.focus(); });
          menu.appendChild(b);
        });
        var valEl = btn.querySelector('.csel-val');
        function labelFor(v) { var o = opts.filter(function (x) { return x.value === v; })[0]; return o ? o.textContent : (opts[0] ? opts[0].textContent : ''); }
        function sync() {
          Array.prototype.forEach.call(menu.children, function (b) {
            var on = b.getAttribute('data-value') === sel.value;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          valEl.textContent = labelFor(sel.value);
          btn.classList.toggle('csel-placeholder', !sel.value);
        }
        function pick(v) { if (sel.value === v) return; sel.value = v; sync(); sel.dispatchEvent(new Event('change', { bubbles: true })); }
        function open() {
          if (openMenu && openMenu !== close) openMenu();
          menu.hidden = false; wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); openMenu = close;
          window.__coldMenuFit && window.__coldMenuFit(menu, wrap);
        }
        function close() { menu.hidden = true; wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); if (openMenu === close) openMenu = null; }
        btn.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden ? open() : close(); });
        btn.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (menu.hidden) open(); }
          else if (e.key === 'Escape') close();
        });
        menu.addEventListener('click', function (e) { e.stopPropagation(); });
        sel.addEventListener('change', sync);
        // form.reset() sets sel.value back to its default without firing
        // 'change' - re-sync the button label on the next tick.
        if (sel.form) sel.form.addEventListener('reset', function () { setTimeout(sync, 0); });
        sel.insertAdjacentElement('afterend', wrap);
        wrap.appendChild(btn);
        wrap.appendChild(menu);
        sel.classList.add('csel-native');
        sync();
      }
      function run() { Array.prototype.forEach.call(document.querySelectorAll('select[data-csel]'), enhance); }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
      else run();
      return enhance;
    })();

    // Custom date field - same button-over-hidden-native idiom as
    // __coldSelect above (the real <input type="date"> stays in the DOM,
    // hidden, driving everything else via a real 'change' event), because
    // the native date picker can't be restyled to match the site.
    window.__coldDate = (function () {
      var openMenu = null;
      document.addEventListener('click', function () { if (openMenu) openMenu(); });
      var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      var DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
      function pad2(n) { return n < 10 ? '0' + n : '' + n; }
      function toISO(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
      function parseISO(v) {
        if (!v) return null;
        var parts = String(v).split('-');
        if (parts.length !== 3) return null;
        var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);
        if (!y || m < 0 || m > 11 || !d) return null;
        return { y: y, m: m, d: d };
      }
      function enhance(inp) {
        if (!inp || inp.__cdate) return;
        inp.__cdate = true;
        var placeholder = inp.getAttribute('data-placeholder') || 'Select date';
        var today = new Date();
        var viewY = today.getFullYear(), viewM = today.getMonth();

        var wrap = document.createElement('div');
        wrap.className = 'cdate';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cdate-btn';
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.setAttribute('aria-expanded', 'false');
        if (inp.id) btn.setAttribute('aria-label', inp.getAttribute('aria-label') || inp.id);
        btn.innerHTML = '<span class="cdate-val"></span>' +
          '<svg class="cdate-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
        var valEl = btn.querySelector('.cdate-val');

        var menu = document.createElement('div');
        menu.className = 'cdate-menu';
        menu.setAttribute('role', 'dialog');
        menu.hidden = true;
        menu.innerHTML =
          '<div class="cdate-head"><button type="button" class="cdate-nav" data-nav="-1" aria-label="Previous month"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>' +
          '<b></b>' +
          '<button type="button" class="cdate-nav" data-nav="1" aria-label="Next month"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button></div>' +
          '<div class="cdate-dow">' + DOW.map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div>' +
          '<div class="cdate-grid"></div>' +
          '<div class="cdate-foot"><button type="button" class="cdate-clear">Clear</button></div>';
        var headEl = menu.querySelector('.cdate-head b');
        var gridEl = menu.querySelector('.cdate-grid');

        function labelFor(v) {
          var p = parseISO(v);
          if (!p) return placeholder;
          return MONTHS[p.m].slice(0, 3) + ' ' + p.d + ', ' + p.y;
        }
        function sync() {
          valEl.textContent = labelFor(inp.value);
          btn.classList.toggle('cdate-placeholder', !inp.value);
        }
        function renderGrid() {
          var sel = parseISO(inp.value);
          var first = new Date(viewY, viewM, 1);
          var startDow = first.getDay();
          var daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
          var daysInPrev = new Date(viewY, viewM, 0).getDate();
          var cells = [];
          for (var i = startDow - 1; i >= 0; i--) {
            cells.push({ d: daysInPrev - i, out: true, y: viewM === 0 ? viewY - 1 : viewY, m: viewM === 0 ? 11 : viewM - 1 });
          }
          for (var d = 1; d <= daysInMonth; d++) cells.push({ d: d, out: false, y: viewY, m: viewM });
          var rem = (7 - (cells.length % 7)) % 7;
          for (var j = 1; j <= rem; j++) {
            cells.push({ d: j, out: true, y: viewM === 11 ? viewY + 1 : viewY, m: viewM === 11 ? 0 : viewM + 1 });
          }
          headEl.textContent = MONTHS[viewM] + ' ' + viewY;
          gridEl.innerHTML = cells.map(function (c) {
            var isToday = c.y === today.getFullYear() && c.m === today.getMonth() && c.d === today.getDate();
            var isActive = !!sel && c.y === sel.y && c.m === sel.m && c.d === sel.d;
            return '<button type="button" class="cdate-day' + (c.out ? ' out' : '') + (isToday ? ' today' : '') + (isActive ? ' active' : '') +
              '" data-y="' + c.y + '" data-m="' + c.m + '" data-d="' + c.d + '">' + c.d + '</button>';
          }).join('');
        }
        Array.prototype.forEach.call(menu.querySelectorAll('[data-nav]'), function (b) {
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            var dir = parseInt(b.getAttribute('data-nav'), 10);
            viewM += dir;
            if (viewM < 0) { viewM = 11; viewY--; } else if (viewM > 11) { viewM = 0; viewY++; }
            renderGrid();
          });
        });
        gridEl.addEventListener('click', function (e) {
          var b = e.target.closest ? e.target.closest('.cdate-day') : null;
          if (!b) return;
          inp.value = toISO(parseInt(b.getAttribute('data-y'), 10), parseInt(b.getAttribute('data-m'), 10), parseInt(b.getAttribute('data-d'), 10));
          sync();
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          close();
          btn.focus();
        });
        menu.querySelector('.cdate-clear').addEventListener('click', function (e) {
          e.stopPropagation();
          inp.value = '';
          sync();
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          close();
          btn.focus();
        });
        function open() {
          if (openMenu && openMenu !== close) openMenu();
          var p = parseISO(inp.value);
          viewY = p ? p.y : today.getFullYear();
          viewM = p ? p.m : today.getMonth();
          renderGrid();
          menu.hidden = false; wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); openMenu = close;
          window.__coldMenuFit && window.__coldMenuFit(menu, wrap);
        }
        function close() { menu.hidden = true; wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); if (openMenu === close) openMenu = null; }
        btn.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden ? open() : close(); });
        btn.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (menu.hidden) open(); }
          else if (e.key === 'Escape') close();
        });
        menu.addEventListener('click', function (e) { e.stopPropagation(); });
        inp.addEventListener('change', sync);
        if (inp.form) inp.form.addEventListener('reset', function () { setTimeout(sync, 0); });
        inp.insertAdjacentElement('afterend', wrap);
        wrap.appendChild(btn);
        wrap.appendChild(menu);
        inp.classList.add('csel-native');
        sync();
      }
      function run() { Array.prototype.forEach.call(document.querySelectorAll('input[type="date"][data-cdate]'), enhance); }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
      else run();
      return enhance;
    })();

    (function () {
      // Featured products and This week's deals used to be hand-written
      // HTML the admin had to edit by hand and keep in sync with real
      // catalog data. Now they're driven by products.featured (admin-set,
      // see the admin panel's product editor) and products.weekly_deal
      // (set automatically by the weekly-deals algorithm, see
      // admin-weekly-deals) - real DB rows replace the static markup
      // below when there are any; the original static cards stay as a
      // no-JS/no-picks-yet fallback rather than leaving the section empty.
      function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
      function money(n) { return window.__money ? window.__money(n) : ('$' + (n % 1 === 0 ? n : n.toFixed(2))); }
      function priceLabel(n) { return window.__price ? window.__price(n) : ((Number(n) || 0) > 0 ? money(n) : 'Free'); }
      function homeCardHtml(p) {
        var onSale = p.was > p.priceNum;
        var offPct = onSale ? Math.round((1 - p.priceNum / p.was) * 100) : 0;
        var resell = p.resell ? ' data-resell="yes" data-resell-price="' + (p.resellPrice != null ? p.resellPrice : Math.round(p.priceNum * 3)) + '"' : '';
        // data-usd on both spans (not just the static fmtPriceStr this
        // replaced) so a later currency toggle - catalog.js's applyStatic,
        // which re-queries every .p-price/.p-was in the document - picks
        // these up too. Without it these two grids stayed in USD forever
        // after being replaced, even once the visitor switched currency.
        return '<article class="product" data-id="' + escHtml(p.id) + '" data-cat="' + escHtml(p.cat || '') + '" data-price="' + p.priceNum + '" data-catlabel="' + escHtml(p.cat || '') + '"' + resell + (onSale ? ' data-was="' + p.was + '"' : '') + '>' +
          '<div class="p-thumb" style="background-image:url(\'' + p.image + '\')">' + (onSale ? '<span class="p-off">-' + offPct + '%</span>' : '') + '</div>' +
          '<div class="p-body">' +
            '<h3 class="p-name">' + escHtml(p.title) + '</h3>' +
            '<div class="p-price-row">' + (onSale ? '<span class="p-was" data-usd="' + p.was + '">' + money(p.was) + '</span>' : '') + '<span class="p-price" data-usd="' + p.priceNum + '">' + priceLabel(p.priceNum) + '</span></div>' +
            '<p class="p-sum">' + escHtml(p.desc || '') + '</p>' +
            '<div class="p-actions"><button class="p-buy" type="button">Buy now</button><button class="p-add" type="button">Add to cart</button></div>' +
          '</div>' +
        '</article>';
      }
      // markOwned() in the shop-grid module only ever touches that grid's own
      // cards - the homepage's Featured/Deals grids are curated/algorithmic
      // picks, not personalized, so a product a signed-in visitor already
      // owns can legitimately still show up here. Without this, it showed
      // with a fully-active Buy/Add to cart and no indication they already
      // own it - the same "owned state missing" gap the shop grid already
      // solves, just not applied to these two grids.
      function applyOwnedState(container) {
        if (!container || !window.__coldOwned) return;
        window.__coldOwned.load().then(function () {
          Array.prototype.forEach.call(container.querySelectorAll('.product'), function (card) {
            var owned = window.__coldOwned.has(card.getAttribute('data-id'));
            card.classList.toggle('owned', owned);
            var addBtn = card.querySelector('.p-add');
            if (addBtn) { addBtn.disabled = owned; addBtn.textContent = owned ? 'Owned' : 'Add to cart'; }
            var buyBtn = card.querySelector('.p-buy');
            if (buyBtn) buyBtn.disabled = owned;
            var thumb = card.querySelector('.p-thumb');
            var badge = thumb ? thumb.querySelector('.p-owned-badge') : null;
            if (owned && thumb && !badge) thumb.insertAdjacentHTML('beforeend', '<span class="p-owned-badge">Owned</span>');
          });
        });
      }
      var catalog = window.__CATALOG || [];
      // Both grids ship `hidden` in the static HTML - see index.html - so the
      // hardcoded example cards below (a fallback for no-JS/no-picks-yet,
      // not real inventory) never get a first paint of their own. Without
      // this, every visitor saw those made-up products and prices flash for
      // however long the catalog fetch above took, then get replaced by
      // whatever's actually true (or removed entirely if there are no
      // picks) - a textbook wrong-then-right flash, not a normal load state.
      // Each grid's enclosing <section> (heading included) ships `hidden`
      // too, not just the grid - a "Featured products" heading sitting
      // over nothing, because no product happens to be marked featured
      // right now, is exactly as wrong as the flash-of-fake-cards this
      // whole block already exists to prevent.
      var featuredGrid = document.getElementById('homeFeaturedGrid');
      var featuredSection = document.getElementById('homeFeaturedSection');
      if (featuredGrid) {
        var featuredPicks = catalog.filter(function (p) { return p.featured; }).sort(function (a, b) { return a.featuredOrder - b.featuredOrder; }).slice(0, 4);
        if (featuredPicks.length) featuredGrid.innerHTML = featuredPicks.map(homeCardHtml).join('');
        featuredGrid.hidden = !featuredPicks.length;
        if (featuredSection) featuredSection.hidden = !featuredPicks.length;
        applyOwnedState(featuredGrid);
        if (window.__stampSaleBadges) window.__stampSaleBadges(featuredGrid);
      }
      var dealsGrid = document.getElementById('homeDealsGrid');
      var dealsSection = document.getElementById('homeDealsSection');
      if (dealsGrid) {
        var dealPicks = catalog.filter(function (p) { return p.weeklyDeal; }).slice(0, 4);
        if (dealPicks.length) dealsGrid.innerHTML = dealPicks.map(homeCardHtml).join('');
        dealsGrid.hidden = !dealPicks.length;
        if (dealsSection) dealsSection.hidden = !dealPicks.length;
        applyOwnedState(dealsGrid);
        if (window.__stampSaleBadges) window.__stampSaleBadges(dealsGrid);

        // The weekly-deals cron reverts these every Monday 00:00 UTC, so
        // that's the honest deadline to show.
        var cd = document.getElementById('homeDealsCountdown');
        if (cd && dealPicks.length) {
          var now = new Date();
          var nextMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
          nextMon.setUTCDate(nextMon.getUTCDate() + ((8 - nextMon.getUTCDay()) % 7 || 7));
          var hrs = Math.round((nextMon - now) / 3600000);
          cd.textContent = hrs <= 24
            ? 'New picks in ' + hrs + 'h'
            : 'New picks in ' + Math.round(hrs / 24) + ' days';
          cd.hidden = false;
        }
      }

      // Curated bundles (window.__BUNDLES from catalog.js). Each card adds
      // every product plus the bundle token, so priceItems applies the
      // bundle discount at checkout.
      var bundlesGrid = document.getElementById('homeBundlesGrid');
      var bundlesSection = document.getElementById('homeBundlesSection');
      if (bundlesGrid) {
        var bySlug = {};
        catalog.forEach(function (p) { bySlug[p.id] = p; });
        var bundles = (window.__BUNDLES || []).map(function (b) {
          var prods = (b.slugs || []).map(function (s) { return bySlug[s]; }).filter(Boolean);
          if (prods.length < 2) return null;
          var listUsd = prods.reduce(function (sum, p) { return sum + (p.priceNum || 0); }, 0);
          var priceUsd = Math.round(listUsd * (1 - Number(b.bundle_pct) / 100) * 100) / 100;
          return { b: b, prods: prods, listUsd: listUsd, priceUsd: priceUsd };
        }).filter(Boolean);
        if (bundles.length) {
          bundlesGrid.innerHTML = bundles.map(function (x) {
            var m = window.__money || function (n) { return '$' + n; };
            var img = x.b.image || (x.prods[0] && x.prods[0].image) || '/banner.jpg';
            return '<article class="bundle-card" data-token="' + escHtml(x.b.token) + '">' +
              '<div class="bundle-thumb" style="background-image:url(\'' + img + '\')"><span class="bundle-off">-' + Math.round(x.b.bundle_pct) + '%</span></div>' +
              '<div class="bundle-body">' +
              '<h3 class="bundle-name">' + escHtml(x.b.title) + '</h3>' +
              '<p class="bundle-meta">' + x.prods.length + ' products: ' + x.prods.map(function (p) { return escHtml(p.title); }).join(', ') + '</p>' +
              '<div class="bundle-price-row"><span class="p-was">' + m(x.listUsd) + '</span><span class="p-price">' + m(x.priceUsd) + '</span></div>' +
              '<button class="btn btn-primary bundle-add" type="button">Add bundle to cart</button>' +
              '</div></article>';
          }).join('');
          bundlesGrid.querySelectorAll('.bundle-card').forEach(function (card) {
            var x = bundles.filter(function (y) { return y.b.token === card.getAttribute('data-token'); })[0];
            if (!x) return;
            card.querySelector('.bundle-add').addEventListener('click', function () {
              x.prods.forEach(function (p) {
                if (window.__cartAdd) window.__cartAdd({ id: p.id, title: p.title, price: p.priceNum, image: p.image, tag: p.cat });
              });
              try { localStorage.setItem('coldd_bundle_token', x.b.token); } catch (e) {}
              if (window.__openCart) window.__openCart();
            });
          });
        }
        bundlesSection.hidden = !bundles.length;
      }
    })();

    (function () {
      // The homepage's featured/deals cards are static markup outside any
      // .shop, so the shop reconciler below never reached them and they kept
      // whatever rating the HTML hardcoded. The products themselves are real,
      // so match them to the catalog by name and let the live row supply the
      // stars. The static markup stays as the no-JS fallback; it just no
      // longer asserts a review count of its own.
      var cards = document.querySelectorAll('.featured-grid .product');
      if (!cards.length) return;
      var byId = {};
      (window.__CATALOG || []).forEach(function (p) { byId[p.id] = p; });
      Array.prototype.forEach.call(cards, function (card) {
        var p = byId[window.__coldRating.slugOf(card)];
        if (!p) return;
        card.setAttribute('data-id', p.id);
        window.__coldRating.applyRating(card, p);
      });
    })();

    // Shop filters: no inner scrollbar. The panel scrolls with the page until its
    // bottom reaches the bottom of the window (or its top reaches the header,
    // whichever is first), then stays put - the usual tall-sticky-sidebar behaviour.
    (function () {
      var side = document.querySelector('.shop-side');
      if (!side) return;
      function place() {
        if (window.matchMedia('(max-width: 1040px)').matches) { side.style.top = ''; return; }
        side.style.top = Math.min(96, window.innerHeight - side.offsetHeight - 24) + 'px';
      }
      place();
      window.addEventListener('resize', place);
      window.addEventListener('load', place);
      if (window.ResizeObserver) new ResizeObserver(place).observe(side);
    })();

    (function () {
      const shops = document.querySelectorAll('.shop');
      if (!shops.length) return;
      shops.forEach(function (shop) {
        const grid = shop.querySelector('.product-grid');
        if (!grid) return;
        const chips = shop.querySelector('.filters');
        const sideCats = shop.querySelector('.fc-cats');
        const searchEl = shop.querySelector('.shop-search');
        const prMin = shop.querySelector('.pr-min');
        const prMax = shop.querySelector('.pr-max');
        const prFill = shop.querySelector('.pr-fill');
        const prMinVal = shop.querySelector('.pr-minval');
        const prMaxVal = shop.querySelector('.pr-maxval');
        const empty = shop.querySelector('.shop-empty');
        const pager = shop.querySelector('.shop-pager');
        const saleBox = shop.querySelector('.fc-sale');
        const freeBox = shop.querySelector('.fc-free');
        const sortField = shop.querySelector('.sort-field');
        const sortBtn = shop.querySelector('.sort-btn');
        const sortMenu = shop.querySelector('.sort-menu');
        const sortBtnVal = shop.querySelector('.sort-btn-val');
        const sortOpts = sortMenu ? Array.prototype.slice.call(sortMenu.querySelectorAll('.sort-opt')) : [];
        const clearBtn = shop.querySelector('.fc-clear');
        const countEl = shop.querySelector('.shop-count');
        const base = shop.getAttribute('data-page') || (location.pathname.split('/').pop() || '/shop');
        // Matches product.html/checkout's fallback when a product has no
        // admin-set resell_price_usd.
        const RESELL_MULT = 3;

        // ---- Per-category SEO -------------------------------------------------
        // /shop?cat=<slug> is one shell that filters client-side, so without
        // this every category shares the /shop title, description and canonical
        // and competes with it. Restate them for the active category (and the
        // visually-hidden <h1>), and reset to the /shop defaults for "all".
        // Copy is intentionally short and specific - these are commercial
        // landing pages for "roblox <thing>" queries.
        var CAT_SEO = {
          'game-templates': ['Roblox Game Templates & Finished Games', 'Launch-ready Roblox games and starter templates - fully scripted, monetised and documented. Instant download after checkout.'],
          'maps': ['Roblox Maps', 'Standalone, optimised Roblox map builds for lobbies, PvP, survival and adventure games. Instant download, resell licences available.'],
          'scripts-ui': ['Roblox Scripts & UI Kits', 'Drop-in Roblox gameplay systems, HUDs, inventory and menu UI. Clean, commented code you can integrate the same day.'],
          'graphics': ['Roblox Graphics - Thumbnails, Logos & Icons', 'Thumbnail bundles, logo systems and icon kits for Roblox games and studios. Editable source files included.'],
          'buildings': ['Roblox Buildings & Set Pieces', 'Individual structures and set pieces for Roblox maps - part-optimised and ready to drop into your place.'],
          'assets': ['Roblox Asset Packs', 'Reusable Roblox asset packs and building blocks for faster game development. Instant download after checkout.'],
          'uniforms-gear': ['Roblox Uniforms & Gear', 'Character clothing, uniforms and equipment sets for Roblox games. Instant download, resell licences available.'],
          'boats': ['Roblox Boat Packs', 'Boat and watercraft model packs for Roblox naval, survival and roleplay games.'],
          'weapons': ['Roblox Weapon Packs', 'Weapon model and mechanic packs for Roblox combat games - rigged, animated and ready to script.'],
          'vehicles': ['Roblox Vehicle Packs', 'Car and vehicle packs for Roblox racing, city and roleplay games, with drift-ready handling.'],
          'animations-vfx': ['Roblox Animations & VFX', 'Emote animation sets and particle VFX for Roblox games. Instant download after checkout.']
        };
        var srH1 = document.querySelector('main h1.sr-only');
        var seoBase = {
          title: document.title,
          desc: (document.querySelector('meta[name="description"]') || {}).content || '',
          canonical: 'https://coldd.dev' + (base && base.charAt(0) === '/' ? base : '/shop'),
          h1: srH1 ? srH1.textContent : ''
        };
        function applyCatSeo(cat) {
          if (!window.coldSeo) return;
          var entry = cat && cat !== 'all' && CAT_SEO[cat];
          if (entry) {
            window.coldSeo.apply({
              title: entry[0] + ' - coldd',
              description: entry[1],
              path: (base && base.charAt(0) === '/' ? base : '/shop') + '?cat=' + cat,
              image: 'https://coldd.dev/banner.jpg',
              type: 'website'
            });
            if (srH1) srH1.textContent = entry[0];
          } else {
            document.title = seoBase.title;
            var m = document.querySelector('meta[name="description"]');
            if (m) m.content = seoBase.desc;
            var c = document.querySelector('link[rel="canonical"]');
            if (c) c.href = seoBase.canonical;
            if (srH1) srH1.textContent = seoBase.h1;
          }
        }

        // The grid below ships as static markup (built once from the source
        // HTML), so it doesn't know about products created after the last
        // build. Reconcile it against the live, Supabase-backed catalog:
        // stamp real creation dates onto the cards that are already there
        // (so "Newest"/"Oldest" sort on real dates instead of DOM order),
        // and append any catalog product missing from the static markup.
        (function reconcileGrid() {
          function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
          function fmtPriceStr(n) { return '$' + (n % 1 === 0 ? n : n.toFixed(2)); }
          var shopPlatform = 'Roblox';
          var catSlugByLabel = {};
          (window.__CATEGORIES || []).forEach(function (c) { if (c.platform === shopPlatform) catSlugByLabel[c.label] = c.slug; });
          var starsHtmlFor = window.__coldRating.starsHtmlFor;
          var applyRating = window.__coldRating.applyRating;

          var existingByCardId = {};
          Array.prototype.slice.call(grid.querySelectorAll('.product')).forEach(function (el) {
            existingByCardId[window.__coldRating.slugOf(el)] = el;
          });
          // The static grid still contains every product that existed at build
          // time. Once the live catalog has loaded, drop any card that is no
          // longer in it (hidden/Private or deleted), so retired products stop
          // showing in the shop. Skipped if the catalog fetch failed, so an
          // outage keeps the static cards instead of emptying the shop.
          if (window.__CATALOG_OK) {
            var liveIds = {};
            (window.__CATALOG || []).forEach(function (p) { liveIds[p.id] = true; });
            Object.keys(existingByCardId).forEach(function (id) {
              if (!liveIds[id]) { existingByCardId[id].remove(); delete existingByCardId[id]; }
            });
          }
          (window.__CATALOG || []).filter(function (p) { return p.platform === shopPlatform; }).forEach(function (p) {
            var existing = existingByCardId[p.id];
            if (existing) {
              existing.setAttribute('data-id', p.id);
              existing.setAttribute('data-priority', p.priority ? 'yes' : 'no');
              if (p.createdAt) existing.setAttribute('data-created', p.createdAt);
              // Live price wins over whatever the prerendered card shipped
              // with. An admin price change updates the catalog row but not
              // the static markup, so without this the grid kept quoting the
              // old number - and so did the price sort and the price-range
              // filter, which both read data-price/data-was straight off the
              // card. syncCardPricing() rebuilds the visible .p-price-row
              // from these attributes on every refilter, so setting them
              // here is enough for the displayed price; the sale badge on
              // the thumb is the one bit it doesn't manage.
              var exOnSale = p.was > p.priceNum;
              existing.setAttribute('data-price', p.priceNum);
              if (exOnSale) existing.setAttribute('data-was', p.was);
              else existing.removeAttribute('data-was');
              var exThumb = existing.querySelector('.p-thumb');
              if (exThumb) {
                var exOff = exThumb.querySelector('.p-off');
                if (exOnSale) {
                  var exPct = '-' + Math.round((1 - p.priceNum / p.was) * 100) + '%';
                  if (exOff) exOff.textContent = exPct;
                  else exThumb.insertAdjacentHTML('afterbegin', '<span class="p-off">' + exPct + '</span>');
                } else if (exOff) {
                  exOff.remove();
                }
              }
              if (p.resell) {
                existing.setAttribute('data-resell', 'yes');
                existing.setAttribute('data-resell-price', p.resellPrice != null ? p.resellPrice : Math.round(p.priceNum * RESELL_MULT));
              }
              applyRating(existing, p);
              return;
            }
            var onSale = p.was > p.priceNum;
            var offPct = onSale ? Math.round((1 - p.priceNum / p.was) * 100) : 0;
            var starsHtml = starsHtmlFor(p);
            var art = document.createElement('article');
            art.className = 'product';
            art.setAttribute('data-id', p.id);
            art.setAttribute('data-cat', catSlugByLabel[p.cat] || '');
            art.setAttribute('data-price', p.priceNum);
            art.setAttribute('data-reviews', p.reviews || 0);
            art.setAttribute('data-rating', p.rating || 0);
            art.setAttribute('data-catlabel', p.cat || '');
            art.setAttribute('data-priority', p.priority ? 'yes' : 'no');
            if (p.createdAt) art.setAttribute('data-created', p.createdAt);
            if (p.resell) {
              art.setAttribute('data-resell', 'yes');
              var resellUsd = p.resellPrice != null ? p.resellPrice : Math.round(p.priceNum * RESELL_MULT);
              art.setAttribute('data-resell-price', resellUsd);
            }
            if (p.subcat) art.setAttribute('data-subcat', p.subcat);
            if (onSale) art.setAttribute('data-was', p.was);
            art.innerHTML =
              '<div class="p-thumb" style="background-image:url(\'' + p.image + '\')">' + (onSale ? '<span class="p-off">-' + offPct + '%</span>' : '') + '</div>' +
              '<div class="p-body">' +
                '<h3 class="p-name">' + escHtml(p.title) + '</h3>' +
                '<div class="p-price-row">' + (onSale ? '<span class="p-was">' + fmtPriceStr(p.was) + '</span>' : '') + '<span class="p-price">' + p.price + '</span></div>' +
                starsHtml +
                '<p class="p-sum">' + escHtml(p.desc || '') + '</p>' +
                '<div class="p-actions"><button class="p-buy" type="button">Buy now</button>' +
                '<button class="p-add" type="button">Add to cart</button></div>' +
              '</div>';
            grid.appendChild(art);
          });

          // Catches static cards marked data-resell="yes" in the source HTML
          // with no matching live catalog entry (so the loop above never
          // touched them) - falls back to the same 3x multiplier every other
          // resell price defaults to.
          grid.querySelectorAll('.product[data-resell="yes"]:not([data-resell-price])').forEach(function (el) {
            var base = parseFloat(el.getAttribute('data-price')) || 0;
            el.setAttribute('data-resell-price', Math.round(base * RESELL_MULT));
          });
        })();

        const products = Array.prototype.slice.call(grid.querySelectorAll('.product'));
        const PER_PAGE = 12;
        let page = 1;

        if (window.__stampSaleBadges) window.__stampSaleBadges(grid);

        function markOwned() {
          products.forEach(function (card) {
            // A card showing the Resell License filter's pricing needs to
            // check resell ownership, not personal - see __coldOwned's own
            // comment. Owning the personal licence must never block buying
            // the resell one for the same product.
            var showingResell = curCat === 'resell' && card.getAttribute('data-resell') === 'yes';
            var owned = window.__coldOwned.has(card.getAttribute('data-id'), showingResell ? 'resell' : 'standard');
            card.classList.toggle('owned', owned);
            var addBtn = card.querySelector('.p-add');
            if (addBtn) {
              addBtn.disabled = owned;
              addBtn.textContent = owned ? 'Owned' : 'Add to cart';
            }
            var buyBtn = card.querySelector('.p-buy');
            if (buyBtn) buyBtn.disabled = owned;
            var thumb = card.querySelector('.p-thumb');
            var badge = thumb ? thumb.querySelector('.p-owned-badge') : null;
            if (owned && thumb && !badge) thumb.insertAdjacentHTML('beforeend', '<span class="p-owned-badge">Owned</span>');
            else if (!owned && badge) badge.remove();
          });
        }
        window.__coldOwned.load().then(markOwned);

        let maxPrice = 0;
        products.forEach(function (p) { maxPrice = Math.max(maxPrice, parseFloat(p.getAttribute('data-price')) || 0); });
        maxPrice = Math.max(10, Math.ceil(maxPrice / 10) * 10);
        if (prMin && prMax) { prMin.max = prMax.max = maxPrice; prMin.value = 0; prMax.value = maxPrice; }
        if (prMinVal && prMaxVal) { prMinVal.max = prMaxVal.max = maxPrice; prMinVal.value = 0; prMaxVal.value = maxPrice; }
        let curCat = 'all', curSub = null, query = '', lo = 0, hi = maxPrice, onSale = false, onFree = false, sortMode = 'recommended';

        function paintRange() {
          if (prFill) { prFill.style.left = (lo / maxPrice * 100) + '%'; prFill.style.width = ((hi - lo) / maxPrice * 100) + '%'; }
          if (prMinVal && document.activeElement !== prMinVal) prMinVal.value = Math.round(lo);
          if (prMaxVal && document.activeElement !== prMaxVal) prMaxVal.value = Math.round(hi);
        }
        function syncCats() {
          if (chips) chips.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-cat') === curCat); });
          if (sideCats) {
            sideCats.querySelectorAll('.fc-cat').forEach(function (c) { c.classList.toggle('active', !curSub && c.getAttribute('data-cat') === curCat); });
            sideCats.querySelectorAll('.fc-sub').forEach(function (c) { c.classList.toggle('active', curSub && c.getAttribute('data-cat') === curCat && c.getAttribute('data-subcat') === curSub); });
          }
        }
        function matches(p) {
          const price = parseFloat(p.getAttribute('data-price')) || 0;
          const nameEl = p.querySelector('.p-name') || p.querySelector('h3');
          const title = (nameEl ? nameEl.textContent : '').toLowerCase();
          const okCat = curCat === 'all' ? true
                      : curCat === 'resell' ? p.getAttribute('data-resell') === 'yes'
                      : p.getAttribute('data-cat') === curCat;
          // Resell License is a cross-cutting filter, not a category of its
          // own - a resellable product still lives in Maps or Scripts & UI. So
          // under Resell the sub-buttons ARE the real categories, and curSub
          // matches data-cat rather than data-subcat.
          const okSub = !curSub ? true
                      : curCat === 'resell' ? p.getAttribute('data-cat') === curSub
                      : (p.getAttribute('data-subcat') || '').split(',').indexOf(curSub) >= 0;
          const okSale = !onSale || p.hasAttribute('data-was') || p.getAttribute('data-sale-event') === 'yes';
          const okFree = !onFree || p.getAttribute('data-free') === 'yes';
          return okCat && okSub && okSale && okFree && (!query || title.indexOf(query) >= 0) && price >= lo && price <= hi;
        }
        function isFiltered() {
          return curCat !== 'all' || !!curSub || !!query || lo > 0 || hi < maxPrice || onSale || onFree;
        }

        // Below 1040px .shop-side becomes a sheet (see styles.css) so the grid,
        // not ~1050px of filter UI, is what a phone user lands on. The trigger
        // and the sheet's own controls are built here rather than in the page
        // markup: they only mean anything with scripting, and the CSS that
        // hides the panel is scoped to html.js for the same reason.
        const side = shop.querySelector('.shop-side');
        const resultsBar = shop.querySelector('.shop-resultsbar');
        let filtersBtn = null, filtersN = null, doneBtn = null, scrim = null;

        function sheetActive() { return !!filtersBtn && getComputedStyle(filtersBtn).display !== 'none'; }
        function countActiveFilters() {
          let n = 0;
          if (curCat !== 'all') n++;
          if (curSub) n++;
          if (lo > 0 || hi < maxPrice) n++;
          if (onSale) n++;
          if (onFree) n++;
          return n;
        }
        // main.page carries a transform for the page-transition animation, and
        // a transformed ancestor becomes the containing block for position:
        // fixed descendants - the sheet anchored to the bottom of the document
        // (y=5777) instead of the viewport. Portal it to <body> while it is
        // open and put it back exactly where it was on close, so the desktop
        // layout above 1040px is untouched.
        let sideHome = null, sideNext = null;
        function closeSheet() {
          if (!side || !side.classList.contains('open')) return;
          side.classList.remove('open');
          document.body.classList.remove('shop-filters-open');
          if (scrim) { scrim.remove(); scrim = null; }
          if (sideHome) { sideHome.insertBefore(side, sideNext); sideHome = null; sideNext = null; }
          if (filtersBtn) { filtersBtn.setAttribute('aria-expanded', 'false'); filtersBtn.focus(); }
        }
        function openSheet() {
          if (!side || side.classList.contains('open')) return;
          scrim = document.createElement('div');
          scrim.className = 'shop-filters-scrim';
          scrim.addEventListener('click', closeSheet);
          sideHome = side.parentNode;
          sideNext = side.nextSibling;
          document.body.appendChild(scrim);
          document.body.appendChild(side);
          // Flush the moved node's style at translateY(101%) before adding the
          // class that animates it to 0, or the sheet jumps into place with no
          // transition. A forced reflow rather than rAF, so the sheet still
          // opens when the frame loop is throttled (background tab).
          void side.offsetWidth;
          side.classList.add('open');
          document.body.classList.add('shop-filters-open');
          if (filtersBtn) filtersBtn.setAttribute('aria-expanded', 'true');
          const firstCtl = side.querySelector('button, input, select, a[href]');
          if (firstCtl) firstCtl.focus();
        }
        function syncFilterSheet(matchedCount) {
          if (!filtersBtn) return;
          const n = countActiveFilters();
          filtersN.textContent = n ? String(n) : '';
          filtersBtn.setAttribute('aria-label', n ? 'Filters, ' + n + ' active' : 'Filters');
          if (doneBtn) {
            doneBtn.textContent = matchedCount === 1
              ? 'Show 1 result'
              : 'Show ' + matchedCount + ' results';
          }
          if (!sheetActive()) closeSheet();
        }

        if (side && resultsBar) {
          filtersBtn = document.createElement('button');
          filtersBtn.type = 'button';
          filtersBtn.className = 'shop-filters-btn';
          filtersBtn.setAttribute('aria-expanded', 'false');
          filtersBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><circle cx="12" cy="4" r="2"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><circle cx="10" cy="12" r="2"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><circle cx="14" cy="20" r="2"/></svg>' +
            '<span>Filters</span><span class="shop-filters-n"></span>';
          filtersN = filtersBtn.querySelector('.shop-filters-n');
          filtersBtn.addEventListener('click', function () {
            side.classList.contains('open') ? closeSheet() : openSheet();
          });
          // Lives in .shop-toolbar, right after Sort, not .shop-resultsbar -
          // it's invisible above 1040px either way (display:none until the
          // mobile breakpoint), so this only changes the mobile flex-wrap
          // flow: Sort and Filters land in the same row instead of Sort
          // wrapping onto the toolbar's line and Filters landing alone on
          // the results bar's line below the search field.
          if (sortField && sortField.parentNode) sortField.parentNode.insertBefore(filtersBtn, sortField.nextSibling);
          else resultsBar.appendChild(filtersBtn);

          doneBtn = document.createElement('button');
          doneBtn.type = 'button';
          doneBtn.className = 'shop-filters-done';
          doneBtn.textContent = 'Show results';
          doneBtn.addEventListener('click', closeSheet);
          side.appendChild(doneBtn);

          document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
          // Past the breakpoint the panel returns to the flow, so a sheet left
          // open would otherwise strand the scroll lock and scrim behind it.
          window.addEventListener('resize', function () { if (!sheetActive()) closeSheet(); });
        }
        // "Recommended" (the default every visitor lands on, before they've
        // touched the sort menu) used to just return the grid in whatever
        // arbitrary order the DOM happened to have it in - not sorted by
        // anything, just literally not-sorted. This is what most visitors
        // actually see, so it's the highest-leverage place on the whole
        // catalog to rank by something real instead of nothing:
        //   - social proof: rating and review count, log-dampened so one
        //     5-star review doesn't outrank a 4.8 with 200 of them
        //   - sale urgency/value: a real discount is a real reason to buy
        //     now, weighted by how deep it is
        //   - recency: new arrivals get a visibility nudge that decays
        //     over ~2 months, instead of being buried under old bestsellers
        //     forever with no way to ever accumulate reviews of their own
        //   - price, log-dampened same as reviews: between two similarly
        //     well-reviewed products, nudge the higher-value one forward -
        //     revenue per impression matters, but this is deliberately
        //     gentle (a $500 item with no reviews still loses badly to a
        //     $50 item with 200 five-star ones) so it breaks near-ties
        //     toward money without burying quality under price alone
        //   - interest: a signed-in visitor's own purchase history (which
        //     categories they've actually bought from before) boosts
        //     matching products - someone who's bought VFX packs is a
        //     better prospect for another VFX pack than a cold visitor is,
        //     so show it to them first
        // These are all things that plausibly correlate with someone
        // actually completing a purchase, not just similarity to whatever
        // they're currently looking at (that's related()'s job, on the
        // product page).
        var userCategories = null; // Set of "platform|cat", null until the async fetch below resolves (or resolves to signed-out)
        // Map slug -> 0..1 revenue rank (this product's paid revenue over the
        // catalogue's highest), from catalog_revenue_rank(). Deliberately NOT
        // raw dollars: get_catalog_revenue() used to be fetched here on the
        // public shop, so every visitor's Network tab exposed coldd's real
        // per-product sales. The server now normalises it before it leaves.
        var catalogRevenue = null;

        // Replaces a fixed genre-keyword list (which needed a human to
        // notice a new recurring theme in the catalog - "brainrot",
        // whatever comes after it - and go add it by hand) with terms the
        // catalog itself surfaces: catalog_signal_terms() (see
        // 20260819_dynamic_signal_terms.sql) extracts every meaningful
        // word/phrase from each product's title+description and keeps only
        // the ones that recur across a real slice of the catalog - not one
        // product's own flavor text, not near-universal noise like
        // "roblox". That's computed once, server-side, for the whole
        // catalog and fetched here as slug -> terms.
        var catalogTerms = null; // Map slug -> term[], from catalog_signal_terms()
        var userTerms = null; // Set of terms, from get_user_signal_terms

        function conversionScore(el) {
          // Manual admin override (product edit form's "Priority" checkbox) -
          // large enough to reliably clear the real signals below (a
          // realistic ceiling there is roughly rating*2*10 + sale + recency,
          // well under 200), but still just an addend, not a hijack: two
          // priority products still rank against each other and everything
          // else by the real signals underneath it.
          var priorityBoost = el.getAttribute('data-priority') === 'yes' ? 200 : 0;
          var rating = parseFloat(el.getAttribute('data-rating')) || 0;
          var reviews = parseFloat(el.getAttribute('data-reviews')) || 0;
          var price = parseFloat(el.getAttribute('data-price')) || 0;
          var was = parseFloat(el.getAttribute('data-was')) || 0;
          var created = Date.parse(el.getAttribute('data-created')) || 0;

          var social = (rating * 2 + Math.log(1 + reviews)) * 10;

          var saleBoost = 0;
          if (was > price && was > 0) {
            var pct = (1 - price / was) * 100;
            saleBoost = 15 + pct * 0.3;
          }

          var recencyBoost = 0;
          if (created) {
            var daysOld = (Date.now() - created) / 86400000;
            recencyBoost = Math.max(0, 20 - daysOld / 3);
          }

          var priceWeight = Math.log(1 + price) * 4;

          var interestBoost = 0;
          if (userCategories && userCategories.size) {
            // reconcileGrid's own shopPlatform is scoped to its own inner
            // function, not shared with this one - same derivation from
            // the same `base` const, just recomputed here.
            var platform = 'Roblox';
            var key = platform + '|' + (el.getAttribute('data-catlabel') || '');
            if (userCategories.has(key)) interestBoost = 25;
          }

          // Genre match: "bought a simulator map" generalizing to "show
          // more simulator products" even across different catalog
          // categories - a coarser category match above already covers
          // "same category", this covers "same kind of game, different
          // category label".
          var genreBoost = 0;
          if (userTerms && userTerms.size && catalogTerms) {
            var terms = catalogTerms[el.getAttribute('data-id')];
            if (terms && terms.some(function (t) { return userTerms.has(t); })) genreBoost = 25;
          }

          // How well this exact product has actually sold, as a 0..1 rank
          // against the best-selling product (server-normalised - see
          // catalogRevenue above). Still the strongest "will this make
          // money" signal, so the top seller gets a meaningful nudge, but
          // it's a bounded addend that can't bury the rest of the page.
          var revenueBoost = 0;
          if (catalogRevenue) {
            var rank = catalogRevenue[el.getAttribute('data-id')] || 0;
            if (rank > 0) revenueBoost = rank * 40;
          }

          // A resell licence is a materially bigger sale than the personal
          // one on the same product - worth a small nudge toward products
          // that actually offer that upsell path at all.
          var resellBoost = el.getAttribute('data-resell') === 'yes' ? 8 : 0;

          // BuiltByBit sales of this listing and of similar ones, plus on-site views: real demand
          // signals that work before this site has its own sales history.
          var demandBoost = 0;
          if (catalogDemand) {
            var dm = catalogDemand[el.getAttribute('data-id')];
            if (dm) demandBoost = dm.bbb * 30 + dm.views * 12;
          }

          // This visitor's own browsing in this tab session (works for anonymous visitors):
          // categories they've opened and words from products they viewed, searched or added.
          var sessionBoost = 0;
          if (window.__interest) {
            var si = window.__interest.get();
            var catKey = el.getAttribute('data-catlabel') || '';
            var catMax = 0; for (var ck in si.cats) { if (si.cats[ck] > catMax) catMax = si.cats[ck]; }
            if (catMax > 0 && si.cats[catKey]) sessionBoost += 28 * (si.cats[catKey] / catMax);
            var nm = (el.querySelector('.p-name') ? el.querySelector('.p-name').textContent : '').toLowerCase().split(/[^a-z0-9]+/);
            var hit = 0; nm.forEach(function (w) { if (si.terms[w]) hit += Math.min(si.terms[w], 4); });
            sessionBoost += Math.min(22, hit * 5);
          }

          return priorityBoost + social + saleBoost + recencyBoost + priceWeight + interestBoost + genreBoost + revenueBoost + resellBoost + demandBoost + sessionBoost;
        }
        // Each of these four ranking signals is its own round trip. A
        // previous fix stopped them from reordering the grid AFTER it was
        // revealed (they used to call refilter() the instant one landed,
        // visibly reshuffling cards the visitor was already looking at) -
        // but the grid's first reveal was still happening immediately, with
        // whatever subset of these signals had happened to resolve by
        // then, and never got corrected once the rest landed. On a
        // connection where even one of these round trips takes a couple of
        // seconds, that's still exactly "products change a few seconds
        // after the page loads" - just moved from "after reveal" to "the
        // reveal itself was the change." Fixed properly this time by
        // holding the reveal - grid stays hidden behind the loading spinner
        // - until every signal has either resolved or hit the safety
        // timeout below, so there is only ever one render, with final data,
        // and nothing to visibly transition from.
        var pendingRankingSignals = { cats: true, catTerms: true, userTerms: true, revenue: true, demand: true };
        var catalogDemand = null; // slug -> { bbb, views }, 0..1 ranks from catalog_demand_signals()
        var gridRevealed = false;
        function signalSettled(key) {
          delete pendingRankingSignals[key];
          if (Object.keys(pendingRankingSignals).length === 0) revealGrid();
        }
        var revealSafetyTimer = setTimeout(revealGrid, 2500);
        function loadUserCategories() {
          if (!window.coldSupabase) { signalSettled('cats'); return; }
          window.coldSupabase.auth.getSession().then(function (res) {
            var session = res && res.data && res.data.session;
            if (!session) return;
            return window.coldSupabase.rpc('get_user_categories', { p_user_id: session.user.id }).then(function (r) {
              var rows = r.data || [];
              if (!rows.length) return;
              userCategories = new Set(rows.map(function (row) { return row.platform + '|' + row.cat; }));
            });
          }).catch(function () {}).then(function () { signalSettled('cats'); });
        }
        loadUserCategories();
        function loadCatalogTerms() {
          if (!window.coldSupabase) { signalSettled('catTerms'); return; }
          window.coldSupabase.rpc('catalog_signal_terms', {}).then(function (r) {
            var rows = r.data || [];
            if (!rows.length) return;
            var map = {};
            rows.forEach(function (row) { map[row.product_slug] = row.terms || []; });
            catalogTerms = map;
          }).catch(function () {}).then(function () { signalSettled('catTerms'); });
        }
        loadCatalogTerms();
        function loadUserTerms() {
          if (!window.coldSupabase) { signalSettled('userTerms'); return; }
          window.coldSupabase.auth.getSession().then(function (res) {
            var session = res && res.data && res.data.session;
            if (!session) return;
            return window.coldSupabase.rpc('get_user_signal_terms', { p_user_id: session.user.id }).then(function (r) {
              var terms = r.data || [];
              if (!terms.length) return;
              userTerms = new Set(terms);
            });
          }).catch(function () {}).then(function () { signalSettled('userTerms'); });
        }
        loadUserTerms();
        function loadCatalogRevenue() {
          if (!window.coldSupabase) { signalSettled('revenue'); return; }
          window.coldSupabase.rpc('catalog_revenue_rank', {}).then(function (r) {
            var rows = r.data || [];
            if (!rows.length) return;
            var map = {};
            rows.forEach(function (row) { map[row.product_slug] = Number(row.rank) || 0; });
            catalogRevenue = map;
          }).catch(function () {}).then(function () { signalSettled('revenue'); });
        }
        loadCatalogRevenue();
        function loadCatalogDemand() {
          if (!window.coldSupabase) { signalSettled('demand'); return; }
          window.coldSupabase.rpc('catalog_demand_signals', {}).then(function (r) {
            var rows = r.data || [];
            if (!rows.length) return;
            var map = {};
            rows.forEach(function (row) { map[row.product_slug] = { bbb: Number(row.bbb_rank) || 0, views: Number(row.views_rank) || 0 }; });
            catalogDemand = map;
          }).catch(function () {}).then(function () { signalSettled('demand'); });
        }
        loadCatalogDemand();
        function sortMatches(arr) {
          const mode = sortMode || 'recommended';
          if (mode === 'recommended') {
            const withScore = arr.map(function (p, i) { return { p: p, i: i, s: conversionScore(p) }; });
            withScore.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); });
            var ordered = withScore.map(function (m) { return m.p; });
            // Exploration slot: one product nobody has looked at yet is pulled into position 4 so a
            // new or overlooked product can earn views and sales data instead of staying buried.
            if (ordered.length > 10 && catalogDemand) {
              var pool = ordered.slice(8).filter(function (el) { var d = catalogDemand[el.getAttribute('data-id')]; return !d || d.views === 0; });
              if (pool.length) {
                var pick = pool[Math.floor(Math.random() * pool.length)];
                ordered.splice(ordered.indexOf(pick), 1);
                ordered.splice(3, 0, pick);
              }
            }
            return ordered;
          }
          if (mode === 'newest' || mode === 'oldest') {
            const withDate = arr.map(function (p, i) { return { p: p, i: i, t: Date.parse(p.getAttribute('data-created')) || 0 }; });
            withDate.sort(function (a, b) { return mode === 'newest' ? (b.t - a.t) || (a.i - b.i) : (a.t - b.t) || (a.i - b.i); });
            return withDate.map(function (m) { return m.p; });
          }
          const withMeta = arr.map(function (p, i) {
            return {
              p: p, i: i,
              price: parseFloat(p.getAttribute('data-price')) || 0,
              rating: parseFloat(p.getAttribute('data-rating')) || 0,
              reviews: parseFloat(p.getAttribute('data-reviews')) || 0
            };
          });
          withMeta.sort(function (a, b) {
            if (mode === 'price-asc') return (a.price - b.price) || (a.i - b.i);
            if (mode === 'price-desc') return (b.price - a.price) || (a.i - b.i);
            if (mode === 'featured') return (b.rating - a.rating) || (b.reviews - a.reviews) || (a.i - b.i);
            return a.i - b.i;
          });
          return withMeta.map(function (m) { return m.p; });
        }
        function renderPager(pages) {
          if (!pager) return;
          pager.innerHTML = '';
          if (pages <= 1) return;
          function btn(label, target, opts) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
            if (opts && opts.disabled) b.disabled = true;
            if (opts && opts.active) b.classList.add('active');
            else b.addEventListener('click', function () {
              page = target; refilter(false);
              try { window.scrollTo({ top: Math.max(0, shop.getBoundingClientRect().top + window.scrollY - 90), behavior: 'smooth' }); } catch (_) {}
            });
            return b;
          }
          pager.appendChild(btn('‹', page - 1, { disabled: page === 1 }));
          for (let i = 1; i <= pages; i++) pager.appendChild(btn(String(i), i, { active: i === page }));
          pager.appendChild(btn('›', page + 1, { disabled: page === pages }));
        }
        // The Resell filter shows the same cards as their real category
        // (resell is cross-cutting, not its own set of products - see
        // matches() above), so left alone they'd keep showing the Personal
        // Use price while the shopper is specifically browsing for a resell
        // licence. Swap the visible price for the resell price while that
        // filter is active, and back to normal the moment it isn't.
        // Same real per-product robux_price the cart/checkout and product.html
        // already prefer over the flat 80-per-dollar estimate (see app.js's
        // catalogRobuxPrice, a separate IIFE scope this can't reach directly -
        // this is that same lookup against the same window.__CATALOG global).
        // Without it the shop grid quoted one Robux number while the cart
        // quoted a different, real one for the identical product.
        function cardRobuxOff(id) { var p = (window.__CATALOG || []).filter(function (c) { return c.id === id; })[0]; return !!(p && p.robuxDisabled); }
        function cardRobuxPrice(id) {
          var p = (window.__CATALOG || []).filter(function (c) { return c.id === id; })[0];
          // > 0: a stored robux_price of 0 is bad data, not a real R$0
          // price - falls back to the flat estimate instead of quoting
          // a product free in Robux while it still costs real money.
          return p && p.robuxPrice > 0 ? p.robuxPrice : null;
        }
        // The resell licence's own saved Robux price (same rule as cardRobuxPrice).
        function cardResellRobuxPrice(id) {
          var p = (window.__CATALOG || []).filter(function (c) { return c.id === id; })[0];
          return p && p.resellRobuxPrice > 0 ? p.resellRobuxPrice : null;
        }
        function syncCardPricing(card) {
          var priceRow = card.querySelector('.p-price-row');
          if (!priceRow) return;
          var resell = card.getAttribute('data-resell') === 'yes';
          var robuxMode = window.__currencyMode ? window.__currencyMode() === 'robux' : false;
          var showResell = curCat === 'resell' && resell;
          // Buy/Add reads this so the cart gets the resell licence + price
          // the card is actually showing, not the base licence.
          card.setAttribute('data-lic-mode', showResell ? 'resell' : 'standard');
          if (showResell) {
            var resellUsd = Number(card.getAttribute('data-resell-price'));
            // Resell licences are buyable in Robux (cart, checkout and the server
            // all price them): show the licence's saved Robux price, falling back
            // to the flat estimate only when none is set.
            var robuxOff = true; // resell licences are USD only
            var rbxResell = robuxMode && !robuxOff ? cardResellRobuxPrice(card.getAttribute('data-id')) : null;
            var text = robuxMode && !robuxOff
              ? (rbxResell != null ? ('R$ ' + Math.round(rbxResell).toLocaleString('en-US')) : (window.__robux ? window.__robux(resellUsd) : ('$' + resellUsd)))
              : ((robuxOff && window.__fiat) ? window.__fiat(resellUsd) : (window.__money ? window.__money(resellUsd) : ('$' + resellUsd)));
            // No "was" price for resell - it isn't a sale off a base price,
            // it's a different licence with its own price.
            priceRow.innerHTML = '<span class="p-price" data-usd="' + resellUsd + '">' + text + '</span>';
          } else {
            var was = card.getAttribute('data-was');
            var baseUsd = Number(card.getAttribute('data-price'));
            var robuxOff2 = cardRobuxOff(card.getAttribute('data-id'));
            var rbx = robuxMode && !robuxOff2 ? cardRobuxPrice(card.getAttribute('data-id')) : null;
            var baseText = baseUsd <= 0
              ? 'Free'
              : (rbx != null ? ('R$ ' + Math.round(rbx).toLocaleString('en-US')) : ((robuxOff2 && window.__fiat) ? window.__fiat(baseUsd) : (window.__money ? window.__money(baseUsd) : ('$' + baseUsd))));
            priceRow.innerHTML = (was ? '<span class="p-was">' + ((robuxOff2 && window.__fiat) ? window.__fiat(Number(was)) : (window.__money ? window.__money(Number(was)) : ('$' + was))) + '</span>' : '') + '<span class="p-price" data-usd="' + baseUsd + '">' + baseText + '</span>';
          }
        }
        function refilter(resetPage) {
          if (resetPage) page = 1;
          const matched = sortMatches(products.filter(matches));
          const pages = Math.max(1, Math.ceil(matched.length / PER_PAGE));
          if (page > pages) page = pages;
          const start = (page - 1) * PER_PAGE;
          const visible = matched.slice(start, start + PER_PAGE);
          products.forEach(function (p) { p.style.display = 'none'; });
          visible.forEach(function (p) { p.style.display = ''; grid.appendChild(p); syncCardPricing(p); });
          // syncCardPricing rebuilds each price row from data-price, wiping
          // the sale-event struck price - restore it.
          if (window.__stampSaleBadges) window.__stampSaleBadges(grid);
          // Re-check ownership per card - it's licence-aware (see markOwned),
          // and which licence a card is showing can change on every
          // refilter (switching in or out of the Resell License filter).
          if (window.__coldOwned.ready()) markOwned();
          if (empty) empty.hidden = matched.length > 0;
          renderPager(pages);
          if (countEl) {
            countEl.textContent = matched.length === products.length
              ? matched.length + (matched.length === 1 ? ' result' : ' results')
              : 'Showing ' + matched.length + ' of ' + products.length + ' results';
          }
          if (clearBtn) clearBtn.hidden = !isFiltered();
          syncFilterSheet(matched.length);
        }
        function setCat(cat) { curCat = cat; curSub = null; syncCats(); refilter(true); applyCatSeo(cat); }
        function setSub(cat, sub) { curCat = cat; curSub = sub; syncCats(); refilter(true); applyCatSeo(cat); }
        shop.__applyCat = setCat;

        if (chips) chips.addEventListener('click', function (e) {
          const c = e.target.closest('.chip'); if (!c) return;
          setCat(c.getAttribute('data-cat'));
          try { history.replaceState(null, '', curCat === 'all' ? base : (base + '?cat=' + curCat)); } catch (_) {}
        });
        // The subcategory lists open via grid-template-rows: 0fr -> 1fr, which
        // needs every item inside one grid row. Wrapping here rather than in
        // the page markup keeps the two shop pages from having to repeat it
        // around 11 groups each.
        if (sideCats) sideCats.querySelectorAll('.fc-subs').forEach(function (subs) {
          if (subs.querySelector(':scope > .fc-subs-inner')) return;
          const inner = document.createElement('div');
          inner.className = 'fc-subs-inner';
          while (subs.firstChild) inner.appendChild(subs.firstChild);
          subs.appendChild(inner);
        });
        if (sideCats) sideCats.addEventListener('click', function (e) {
          const sub = e.target.closest('.fc-sub');
          if (sub) { setSub(sub.getAttribute('data-cat'), sub.getAttribute('data-subcat')); return; }
          const c = e.target.closest('.fc-cat'); if (!c) return;
          const group = c.closest('.fc-cat-group');
          sideCats.querySelectorAll('.fc-cat-group.open').forEach(function (g) {
            if (g !== group) { g.classList.remove('open'); var s = g.querySelector('.fc-subs'); if (s) s.hidden = true; }
          });
          if (group) {
            const willOpen = !group.classList.contains('open');
            group.classList.toggle('open', willOpen);
            const subs = group.querySelector('.fc-subs'); if (subs) subs.hidden = !willOpen;
          }
          setCat(c.getAttribute('data-cat'));
        });
        if (searchEl) searchEl.addEventListener('input', function () { query = searchEl.value.trim().toLowerCase(); refilter(true); });
        function onRange() {
          lo = Math.min(+prMin.value, +prMax.value);
          hi = Math.max(+prMin.value, +prMax.value);
          paintRange(); refilter(true);
        }
        if (prMin && prMax) { prMin.addEventListener('input', onRange); prMax.addEventListener('input', onRange); }
        function onPriceBox() {
          let a = parseFloat(prMinVal.value); let b = parseFloat(prMaxVal.value);
          if (isNaN(a)) a = 0;
          if (isNaN(b)) b = maxPrice;
          a = Math.max(0, Math.min(a, maxPrice));
          b = Math.max(0, Math.min(b, maxPrice));
          lo = Math.min(a, b); hi = Math.max(a, b);
          if (prMin && prMax) { prMin.value = lo; prMax.value = hi; }
          paintRange(); refilter(true);
        }
        if (prMinVal && prMaxVal) {
          prMinVal.addEventListener('change', onPriceBox);
          prMaxVal.addEventListener('change', onPriceBox);
          [prMinVal, prMaxVal].forEach(function (el) {
            el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
          });
        }
        // The global currency toggle's own handler (apply(), in the
        // currency-switch module) runs its generic .p-price rewrite THEN
        // dispatches this event, in that order - so this always runs after
        // it and fully rebuilds the price row from data-resell-price/
        // data-price, discarding whatever the generic pass did to a card
        // currently showing the resell price. Without this, switching
        // currency while browsing the Resell filter would go stale (or
        // worse, get robux-converted, which resell licences never are)
        // until the next category click.
        window.addEventListener('currencychange', function () { products.forEach(syncCardPricing); if (window.__stampSaleBadges) window.__stampSaleBadges(grid); });

        if (saleBox) saleBox.addEventListener('change', function () { onSale = saleBox.checked; refilter(true); });
        if (freeBox) freeBox.addEventListener('change', function () { onFree = freeBox.checked; refilter(true); });

        function closeSort() { if (sortField) sortField.classList.remove('open'); if (sortMenu) sortMenu.hidden = true; if (sortBtn) sortBtn.setAttribute('aria-expanded', 'false'); }
        function openSort() { if (sortField) sortField.classList.add('open'); if (sortMenu) sortMenu.hidden = false; if (sortBtn) sortBtn.setAttribute('aria-expanded', 'true'); if (sortMenu) window.__coldMenuFit && window.__coldMenuFit(sortMenu, sortField || sortBtn); }
        function setSort(mode, label) {
          sortMode = mode;
          if (sortBtnVal) sortBtnVal.textContent = label;
          sortOpts.forEach(function (o) {
            var active = o.getAttribute('data-sort') === mode;
            o.classList.toggle('active', active);
            o.setAttribute('aria-selected', active ? 'true' : 'false');
          });
          refilter(true);
        }
        if (sortBtn) sortBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (sortMenu && sortMenu.hidden) openSort(); else closeSort();
        });
        sortOpts.forEach(function (o) {
          o.addEventListener('click', function () {
            var label = o.querySelector('span') ? o.querySelector('span').textContent : o.textContent;
            setSort(o.getAttribute('data-sort'), label);
            closeSort();
          });
        });
        document.addEventListener('click', function (e) { if (sortField && !sortField.contains(e.target)) closeSort(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSort(); });

        if (clearBtn) clearBtn.addEventListener('click', function () {
          curCat = 'all'; curSub = null; query = ''; lo = 0; hi = maxPrice; onSale = false; onFree = false;
          if (searchEl) searchEl.value = '';
          if (saleBox) saleBox.checked = false;
          if (freeBox) freeBox.checked = false;
          syncCats(); paintRange(); refilter(true);
          try { history.replaceState(null, '', base); } catch (_) {}
        });

        paintRange();
        // #grid ships [hidden] (static markup is every product in raw
        // build-time order, unsorted and unpaginated - see styles.css's
        // .grid-loading comment) and stays that way, spinner showing, until
        // every ranking signal above has settled - see the comment on
        // pendingRankingSignals for why this waits rather than revealing
        // immediately. setCat/setSort run the real sort+filter+pagination
        // pass synchronously with whatever final data is available the
        // moment this actually fires, so there is exactly one render.
        function revealGrid() {
          if (gridRevealed) return;
          gridRevealed = true;
          clearTimeout(revealSafetyTimer);
          const initial = new URLSearchParams(location.search).get('cat');
          const hasInit = initial && ((chips && chips.querySelector('.chip[data-cat="' + initial + '"]')) || (sideCats && sideCats.querySelector('.fc-cat[data-cat="' + initial + '"]')));
          setCat(hasInit ? initial : 'all');

          // Lets a link (the Shop mega-menu's New Releases tile, currently
          // the only user of this) land pre-sorted instead of on Recommended.
          const initialSort = new URLSearchParams(location.search).get('sort');
          const initialSortOpt = initialSort && sortOpts.filter(function (o) { return o.getAttribute('data-sort') === initialSort; })[0];
          if (initialSortOpt) {
            var initialSortLabel = initialSortOpt.querySelector('span') ? initialSortOpt.querySelector('span').textContent : initialSortOpt.textContent;
            setSort(initialSort, initialSortLabel);
          }

          grid.hidden = false;
          var gridLoading = document.getElementById('gridLoading');
          if (gridLoading) gridLoading.hidden = true;
        }
      });
    })();

    if (!window.__singleFile) {
      const mainEl = document.querySelector('main');
      document.addEventListener('click', function (e) {
        const a = e.target.closest('a'); if (!a || a.target === '_blank') return;
        const href = a.getAttribute('href') || '';
        if (!/^\/(assets|about)?(\?|#|$)/.test(href)) return;

        const here = location.pathname.split('/').pop() || '/';
        const target = href.split(/[?#]/)[0] || '/';
        if (href.charAt(0) === '#' || (target === here && href.indexOf('#') !== -1 && href.indexOf('?') === -1)) return;
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        e.preventDefault();
        if (mainEl) mainEl.classList.add('page-leaving');
        setTimeout(function () { location.href = href; }, 165);
      });

      window.addEventListener('pageshow', function (ev) {
        if (ev.persisted && mainEl) mainEl.classList.remove('page-leaving');
      });
    }

    (function () {
      const cards = document.querySelectorAll('a.tile, a.asset-visual');
      if (!cards.length) return;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      cards.forEach(function (card) {
        card.addEventListener('pointerdown', function (e) {
          card.classList.add('is-pressing');
          if (reduce) return;
          const r = card.getBoundingClientRect();
          const rip = document.createElement('span');
          rip.className = 'card-ripple';
          rip.style.setProperty('--rx', (e.clientX - r.left) + 'px');
          rip.style.setProperty('--ry', (e.clientY - r.top) + 'px');
          card.appendChild(rip);
          setTimeout(function () { rip.remove(); }, 640);
        });
        const release = function () { card.classList.remove('is-pressing'); };
        card.addEventListener('pointerup', release);
        card.addEventListener('pointerleave', release);
        card.addEventListener('pointercancel', release);
      });
    })();

    (function () {
      var KEY = 'coldd_cart_v1';
      // Every product is a digital download - there's no notion of buying
      // "2 of" one, since a licence isn't consumed by quantity. qty stays
      // in the item shape (checkout/order-item code elsewhere still reads
      // it) but is always forced to 1, including for carts saved by an
      // older version of this file that still had the +/- stepper.
      function normalizeCart(arr) { return (arr || []).map(function (i) { i.qty = 1; return i; }); }
      // A cart item stores the price it had when it was added, and nothing
      // ever refreshed it, so a later price change (or a weekly deal ending)
      // left every saved cart quoting the old figure, and the Robux total with
      // it. Once the live catalog has loaded, re-price each plain item from it
      // and drop products that are no longer on sale. Bundle and cross-sell
      // lines carry their own discounted price, so they are left alone.
      window.__coldRepriceCart = function (arr) {
        if (!window.__CATALOG_OK) return arr;
        var byId = {};
        (window.__CATALOG || []).forEach(function (p) { byId[p.id] = p; });
        return (arr || []).filter(function (i) {
          var id = String(i.id);
          var base = id.replace(/--resell$/, '');
          if (base.indexOf('--') !== -1) return true;
          var p = byId[base];
          if (!p) return false;
          i.price = /--resell$/.test(id) ? (p.resellPrice != null ? p.resellPrice : Math.round(p.priceNum * 3)) : p.priceNum;
          return true;
        });
      };
      var cart = [];
      try {
        var rawCart = localStorage.getItem(KEY) || '[]';
        cart = normalizeCart(window.__coldRepriceCart(JSON.parse(rawCart)));
        if (JSON.stringify(cart) !== rawCart) { try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (_) {} }
      } catch (_) { cart = []; }

      var countEl = document.getElementById('cartCount');
      var headCount = document.getElementById('cartHeadCount');
      var fab = document.getElementById('cartFab');
      var fabTotal = document.getElementById('cartFabTotal');
      var drawer = document.getElementById('cartDrawer');
      var overlay = document.getElementById('cartOverlay');
      var itemsEl = document.getElementById('cartItems');
      var emptyEl = document.getElementById('cartEmpty');
      var subEl = document.getElementById('cartSubtotal');

      // Broadcasts to any other cart instance on the same page (e.g. the
      // checkout page's own item list) so both stay in sync with what's
      // actually in localStorage - without this, editing the cart in one
      // place while the other still holds its stale page-load snapshot
      // could charge/display a different cart than what the user last saw.
      function save() {
        try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('coldd:cart-sync', { detail: { source: 'drawer' } })); } catch (_) {}
      }
      window.addEventListener('coldd:cart-sync', function (e) {
        if (e.detail && e.detail.source === 'drawer') return;
        try { cart = normalizeCart(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch (_) { cart = []; }
        updateBadge(); renderCart();
      });
      function money(n) { return window.__money ? window.__money(n) : ('$' + n); }
      function count() { return cart.reduce(function (s, i) { return s + i.qty; }, 0); }
      function subtotal() { return cart.reduce(function (s, i) { return s + i.price * i.qty; }, 0); }

      // The flat 80-Robux-per-$1 conversion (window.__robux/__money) is
      // only a display estimate for arbitrary numbers - it ignores each
      // product's real admin-configured robux_price (which reflects
      // Roblox's DevEx markup and can differ from a flat conversion).
      // product.html already prefers that real price when set; the cart/
      // checkout need to do the same instead of showing a generic
      // estimate. Resell licences ARE sold in Robux now - they use
      // products.resell_robux_price when set, falling back to the resell
      // USD price (or 3x list) flat-converted, matching _shared/roblox.ts's
      // robuxUnitPrice(product, true).
      var ROBUX_PER_USD_FALLBACK = 80; // matches _shared/roblox.ts's ROBUX_PER_USD
      function catalogRobuxPrice(id, licence) {
        var raw = String(id);
        var baseId = raw.replace(/--resell$/, '').replace(/--bundle$/, '');
        var isResell = licence === 'resell' || /--resell$/.test(raw);
        var p = (window.__CATALOG || []).filter(function (c) { return c.id === baseId; })[0];
        if (!p) return null;
        if (isResell) {
          // Always a real number for resell (never null): a resell licence
          // is now always buyable in Robux, either at its admin-set
          // resell_robux_price or the flat-converted resell USD price.
          if (p.resellRobuxPrice > 0) return p.resellRobuxPrice;
          var usd = p.resellPrice != null ? p.resellPrice : p.priceNum * 3;
          return Math.round(usd * ROBUX_PER_USD_FALLBACK);
        }
        // > 0, not != null: an admin-set robux_price of 0 is never really
        // intended (nothing should cost real money in USD and be free in
        // Robux) - treating it as "no override" instead of "R$ 0" is what
        // stops one bad field value from making a product unsellable via
        // Robux instead of just falling back to the flat estimate.
        return p.robuxPrice > 0 ? p.robuxPrice : null;
      }
      function itemUnitMoney(item) {
        if ((Number(item.price) || 0) <= 0) return 'Free';
        var robuxMode = window.__currencyMode && window.__currencyMode() === 'robux';
        if (robuxMode) {
          var rbx = catalogRobuxPrice(item.id, item.licence);
          if (rbx != null) return 'R$ ' + Math.round(rbx).toLocaleString('en-US');
        }
        if (window.__robuxOff && window.__robuxOff(item.id) && window.__fiat) return window.__fiat(item.price);
        return money(item.price);
      }
      function subtotalMoney() {
        if (window.__currencyMode && window.__currencyMode() === 'robux') {
          var total = 0, allPriced = true;
          cart.forEach(function (i) {
            var rbx = catalogRobuxPrice(i.id, i.licence);
            if (rbx == null) { allPriced = false; return; }
            total += rbx * i.qty;
          });
          if (allPriced) return 'R$ ' + Math.round(total).toLocaleString('en-US');
        }
        return money(subtotal());
      }

      // Same spend-tier ladder as checkout (must match _shared/coupon.ts's
      // SPEND_TIERS exactly - this is a preview, the real discount is
      // computed server-side the instant an order is created). Showing it
      // here too, not just at checkout, means someone can shop TOWARD the
      // next tier instead of only discovering it after they've already
      // decided what to buy.
      var SPEND_TIERS = [
        { minSubtotal: 200, minRobux: 50000, pct: 50 },
        { minSubtotal: 100, minRobux: 26000, pct: 40 },
        { minSubtotal: 75, minRobux: 20000, pct: 30 },
        { minSubtotal: 50, minRobux: 13000, pct: 20 },
        { minSubtotal: 30, minRobux: 8000, pct: 10 }
      ];
      // The cheapest catalog item (not already in the cart) whose price
      // alone covers the remaining gap to the next tier - turns "spend $12
      // more" into a specific, one-click thing to add instead of homework
      // the shopper has to go do themselves.
      var tierRelCache = { sig: '', list: null, pending: false };
      function tierRelevance() {
        var slugs = cart.map(function (i) { return i.id.replace(/--resell$/, '').replace(/--bundle$/, '').replace(/--crosssell$/, ''); }).sort();
        var sig = slugs.join(',');
        if (!sig) return null;
        if (tierRelCache.sig === sig && tierRelCache.list) return tierRelCache.list;
        if (!tierRelCache.pending && window.coldSupabase) {
          tierRelCache.pending = true;
          window.coldSupabase.rpc('get_checkout_cross_sell', { p_slugs: slugs, p_limit: 25, p_interest: (window.__interest ? window.__interest.get() : {}) })
            .then(function (r) {
              tierRelCache.sig = sig;
              tierRelCache.list = (r.data || []).map(function (x) { return x.product_slug; });
            }).catch(function () { tierRelCache.sig = sig; tierRelCache.list = []; }).then(function () {
              tierRelCache.pending = false;
              if (tierRelCache.sig === sig && typeof renderTierProgress === 'function') renderTierProgress();
            });
        }
        return tierRelCache.sig === sig ? tierRelCache.list : null;
      }
      function cheapestGapCloser(remaining, useRobux) {
        var cat = window.__CATALOG || [];
        var cartIds = {};
        cart.forEach(function (i) { cartIds[i.id.replace(/--resell$/, '').replace(/--bundle$/, '').replace(/--crosssell$/, '')] = true; });
        // The gap itself, and every candidate's price, both have to be in
        // whatever unit the ladder is actually comparing against right now
        // (see renderTierProgress's useRobux) - a Robux gap searched
        // against USD list prices would filter and sort against numbers
        // from two different scales entirely.
        function priceOf(p) {
          if (!useRobux) return p.priceNum;
          var rbx = catalogRobuxPrice(p.id);
          return rbx != null ? rbx : Math.round(p.priceNum * ROBUX_PER_USD_FALLBACK);
        }
        var candidates = cat.filter(function (p) { return !cartIds[p.id] && priceOf(p) >= remaining && !(p.robuxDisabled && useRobux); });
        candidates.sort(function (a, b) { return priceOf(a) - priceOf(b); });
        var pick = candidates[0] || null;
        // Personalized: prefer the product the relevance engine ranks highest for this cart
        // (style/genre match first) over the merely cheapest, as long as it does not cost much
        // more than the gap needs. The ranking is fetched once per cart and cached.
        var rel = tierRelevance();
        if (rel && candidates.length) {
          var cap = Math.max(remaining * 2.5, remaining + 15);
          var best = null, bestIdx = 1e9;
          candidates.forEach(function (p) {
            var idx = rel.indexOf(p.id);
            if (idx >= 0 && idx < bestIdx && priceOf(p) <= cap) { best = p; bestIdx = idx; }
          });
          if (best) pick = best;
        }
        if (pick) pick = Object.assign({}, pick, { gapPrice: priceOf(pick) });
        return pick;
      }
      // Same fallback shape create-robux-order's priceRobuxItems already
      // uses server-side (a real per-product robux_price where one's set,
      // Math.round(price * flat rate) otherwise) - robuxSubtotalRaw()
      // returns null for the WHOLE cart the moment even one line lacks an
      // explicit override, which left the tier preview (and the discount
      // line) falling back to a USD-only view far more often than the
      // server itself ever falls back to anything.
      function robuxSubtotalWithFallback() {
        var total = 0;
        cart.forEach(function (i) {
          var rbx = catalogRobuxPrice(i.id, i.licence);
          if (rbx == null) rbx = Math.round(i.price * ROBUX_PER_USD_FALLBACK);
          total += rbx * i.qty;
        });
        return total;
      }
      function renderTierProgress() {
        var box = document.getElementById('cdTierBanner');
        if (!box) return;
        // Robux orders don't grant this discount off USD list value - a
        // product's real admin-set robux_price often has no fixed ratio
        // to its USD price, so evaluating against USD while a Robux
        // shopper stares at their real, much smaller Robux total produced
        // exactly the "10% unlocked, my order is 1R$" confusion this was
        // built to prevent. Paying in Robux now evaluates (and the server
        // now grants - see spendTierDiscountRobux) against the REAL Robux
        // total against Robux-equivalent thresholds instead, so this
        // preview can never promise a discount the order doesn't actually
        // give, or vice versa.
        var useRobux = (window.__currencyMode && window.__currencyMode() === 'robux') && cart.length > 0;
        var sub = useRobux ? robuxSubtotalWithFallback() : subtotal();
        var res = window.__coldTierLadder.build(sub, {
          tiers: SPEND_TIERS,
          thresholdFor: function (t) { return useRobux ? t.minRobux : t.minSubtotal; },
          fmt: function (n) { return useRobux ? ('R$ ' + Math.round(n).toLocaleString('en-US')) : money(n); },
          fmtThreshold: function (n) { return useRobux ? ('R$ ' + (n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : Math.round(n))) : ('$' + Math.round(n)); }
        });
        box.className = 'cd-tier co-tier' + (res.tier ? ' co-tier-unlocked' : '');
        window.__coldTierLadder.apply(box, res);
        if (res.hidden) return;
        // The gap-closer nudge stays in the drawer - you're still shopping
        // here, so a one-click "add this to cross the tier" is useful.
        // Checkout drops it; by then the equivalent lives in the
        // Place-order offer modal.
        if (res.next) {
          var pick = cheapestGapCloser(res.gap, useRobux);
          if (pick) {
            var pickPriceStr = useRobux ? ('R$ ' + Math.round(pick.gapPrice).toLocaleString('en-US')) : money(pick.priceNum);
            box.insertAdjacentHTML('beforeend', '<div class="co-tier-nudge" data-id="' + esc(pick.id) + '">' +
              '<span class="co-tier-nudge-thumb" style="background-image:url(\'' + pick.image + '\')"></span>' +
              '<div class="co-tier-nudge-body"><div class="co-tier-nudge-title">' + esc(pick.title) + '</div>' +
              '<div class="co-tier-nudge-sub">' + pickPriceStr + ', crosses into ' + res.next.pct + '% off</div></div>' +
              '<button class="btn btn-tinted co-tier-nudge-add" type="button">Add</button></div>');
          }
        }
      }
      var cdTierBannerEl = document.getElementById('cdTierBanner');
      if (cdTierBannerEl) cdTierBannerEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.co-tier-nudge-add'); if (!btn) return;
        var row = e.target.closest('.co-tier-nudge'); if (!row) return;
        var cat = window.__CATALOG || [];
        var p = cat.filter(function (x) { return x.id === row.getAttribute('data-id'); })[0];
        if (!p) return;
        add({ id: p.id, title: p.title, price: p.priceNum, image: p.image, tag: p.cat || '' });
      });

      function updateBadge() {
        var c = count();
        if (countEl) {
          countEl.textContent = c > 99 ? '99+' : c;
          countEl.classList.remove('bump'); void countEl.offsetWidth; countEl.classList.add('bump');
        }
        if (headCount) headCount.textContent = c + (c === 1 ? ' item' : ' items');
        if (fabTotal) fabTotal.textContent = subtotalMoney();
        if (fab) fab.classList.toggle('has-items', c > 0);
      }
      window.addEventListener('currencychange', function () { updateBadge(); renderCart(); });
      function clearCart() { cart = []; save(); updateBadge(); renderCart(); }
      function add(item) {
        var lic = item.licence || 'standard';
        var id = item.id + (lic === 'resell' ? '--resell' : '');
        var found = cart.filter(function (i) { return i.id === id; })[0];
        // Already in the cart - a digital licence isn't a quantity, so
        // clicking Add to cart again on the same item is a no-op rather
        // than stacking a second copy.
        if (!found) {
          cart.push({ id: id, title: item.title, price: item.price, image: item.image, tag: item.tag || '', licence: lic, qty: 1 });
          if (window.coldTrack) window.coldTrack('add_to_cart', { id: item.id, price: item.price });
        }
        save(); updateBadge(); renderCart();
      }
      window.__cartAdd = add;
      function removeItem(id) {
        cart = cart.filter(function (i) { return i.id !== id; });
        save(); updateBadge(); renderCart();
      }
      function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
      function renderCart() {
        if (!itemsEl) return;
        itemsEl.innerHTML = '';
        if (emptyEl) emptyEl.hidden = cart.length > 0;
        cart.forEach(function (i) {
          var row = document.createElement('div');
          row.className = 'cart-item';
          row.innerHTML =
            '<span class="ci-thumb" style="background-image:url(\'' + i.image + '\')"></span>' +
            '<div class="ci-info"><div class="ci-title">' + esc(i.title) + (i.licence === 'resell' ? ' <span style="color:var(--accent);font-size:11px;font-weight:700;">· RESELL</span>' : '') + '</div>' +
            '<div class="ci-price">' + itemUnitMoney(i) + '</div></div>' +
            '<button class="ci-remove" type="button" data-act="rm" aria-label="Remove">×</button>';
          row.querySelector('[data-act="rm"]').addEventListener('click', function () { removeItem(i.id); });

          // Opens the real product page in a new tab, like every other route
          // to a product. This was the last caller of the retired quick-view
          // modal - clicking a line in the cart / order summary reopened it.
          var openProductPage = function () {
            closeCart();
            var a = document.createElement('a');
            a.href = '/product/' + encodeURIComponent(i.id);
            a.target = '_blank'; a.rel = 'noopener';
            a.click();
          };
          row.querySelector('.ci-thumb').addEventListener('click', openProductPage);
          row.querySelector('.ci-info').addEventListener('click', openProductPage);
          itemsEl.appendChild(row);
        });
        if (subEl) subEl.textContent = subtotalMoney();
        renderTierProgress();
      }
      function openCart() { renderCart(); if (overlay) overlay.hidden = false;
        if (drawer) { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); }
        document.body.classList.add('no-scroll'); }
      window.__openCart = openCart;
      window.__cartHas = function (id) {
        var base = String(id).replace(/--(resell|bundle|crosssell)$/, '');
        return cart.some(function (i) { return i.id === base || i.id.indexOf(base + '--') === 0; });
      };
      function closeCart() { if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
        if (overlay) overlay.hidden = true; document.body.classList.remove('no-scroll'); }

      if (fab) fab.addEventListener('click', function (e) { e.preventDefault(); openCart(); });
      var cartCloseBtn = document.getElementById('cartClose');
      if (cartCloseBtn) cartCloseBtn.addEventListener('click', closeCart);
      if (overlay) overlay.addEventListener('click', closeCart);
      var checkout = document.getElementById('cartCheckout');
      if (checkout) checkout.addEventListener('click', function () {
        if (!cart.length) return;
        closeCart();
        if (window.__goCheckout) window.__goCheckout(); else location.href = '/checkout';
      });

      function readCard(card) {
        var titleEl = card.querySelector('.p-name') || card.querySelector('.p-body h3');
        var priceEl = card.querySelector('.p-price');
        var thumb = card.querySelector('.p-thumb');
        var descEl = card.querySelector('.p-sum') || card.querySelector('.p-desc');
        var tag = card.getAttribute('data-catlabel') || (card.querySelector('.p-cat') ? card.querySelector('.p-cat').textContent.trim() : '');
        var bg = thumb ? (thumb.style.backgroundImage || getComputedStyle(thumb).backgroundImage) : '';
        var m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
        var title = titleEl ? titleEl.textContent.trim() : 'Product';
        // Reading the DISPLAYED .p-price text (or a data-usd captured from
        // it) is unsafe: syncCardPricing rebuilds that span via innerHTML
        // whenever the currency toggle flips to Robux, and the fresh span
        // carries no data-usd - so the fallback below parsed "R$ 12,999"
        // down to 12999 and priced the cart in Robux while displaying $.
        // data-price on the card itself is set once from the real catalog
        // USD number and never touched by currency-display code, so it's
        // the only value here immune to that race.
        var price = 0;
        var dp = card.getAttribute('data-price');
        if (dp != null && dp !== '') {
          price = parseFloat(dp) || 0;
        } else if (priceEl) {
          var du = priceEl.getAttribute('data-usd');
          price = du != null ? (parseFloat(du) || 0) : (parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '')) || 0);
        }
        var cardId = card.getAttribute('data-id') || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        // Matches product.html: prefer the admin-configured resell price
        // over the flat 3x estimate when the catalog has one set, so
        // quick-view and the full product page never disagree on price.
        var catalogProd = (window.__CATALOG || []).filter(function (c) { return c.id === cardId; })[0];
        var resellPrice = catalogProd && catalogProd.resellPrice != null ? catalogProd.resellPrice
          : (parseFloat(card.getAttribute('data-resell-price')) || Math.round(price * 3) || null);
        // On the Resell License filter the card shows the resell price and
        // syncCardPricing stamps data-lic-mode="resell" - honour that here
        // so Buy/Add put the resell licence (and its price) in the cart,
        // not the base one.
        var wantResell = card.getAttribute('data-lic-mode') === 'resell' && card.getAttribute('data-resell') === 'yes' && resellPrice != null;
        return { id: cardId, title: title,
                 price: wantResell ? resellPrice : price,
                 licence: wantResell ? 'resell' : 'standard',
                 image: m ? m[1] : '', tag: tag,
                 desc: descEl ? descEl.textContent.trim() : '',
                 platform: 'Roblox',
                 resell: card.getAttribute('data-resell') === 'yes',
                 resellPrice: resellPrice };
      }
      document.addEventListener('click', function (e) {
        if (e.target.closest('.cart-drawer') || e.target.closest('.search-panel')) return;
        var card = e.target.closest('.product');
        if (!card) return;
        e.preventDefault();
        if (card.getAttribute('data-free') === 'yes') { window.open('https://discord.gg/coldd', '_blank', 'noopener'); return; }
        if (e.target.closest('.p-buy')) { add(readCard(card)); location.href = '/checkout'; }
        else if (e.target.closest('.p-add')) { add(readCard(card)); openCart(); }
        else {
          var a = document.createElement('a');
          a.href = '/product/' + encodeURIComponent(readCard(card).id);
          a.target = '_blank'; a.rel = 'noopener';
          a.click();
        }
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeCart();
      });


      (function () {
        var pv = document.getElementById('view-product');
        if (!pv) return;
        // Matches product.html/checkout's fallback when a product has no
        // admin-set resell_price_usd.
        var RESELL_MULT = 3;
        var $ = function (id) { return document.getElementById(id); };
        var pdImg = $('pdImg'), pdThumbs = $('pdThumbs'), pdSale = $('pdSale');
        var pdImgPrev = $('pdImgPrev'), pdImgNext = $('pdImgNext');
        var pdVideo = $('pdVideo'), pdVideoFrame = $('pdVideoFrame');
        var pdCrumb = $('pdCrumb'), pdTitle = $('pdTitle'), pdSub = $('pdSub');
        var pdPrice = $('pdPrice'), pdPriceWas = $('pdPriceWas'), pdPriceRbx = $('pdPriceRbx'), pdPriceNote = $('pdPriceNote'), pdSaleEvent = $('pdSaleEvent');
        var pdLicence = $('pdLicence'), pdLicLabel = $('pdLicLabel'), pdLicResell = $('pdLicResell');
        var pdTechList = $('pdTechList'), pdAbout = $('pdAbout');
        var pdTechWrap = pdTechList ? pdTechList.closest('.pd-tech') : null;
        var pdRelated = $('pdRelated'), pdRelatedWrap = $('pdRelatedWrap'), pdFaqList = $('pdFaqList');
        var pdReferEarn = $('pdReferEarn'), pdReferCopy = $('pdReferCopy'), pdReferLearn = $('pdReferLearn');
        var pdWish = $('pdWish'), pdWishTx = $('pdWishTx');
        var pdBuy = $('pdBuy'), pdOwned = $('pdOwned'), pdUpgrade = $('pdUpgrade');
        var pdTabUpdates = $('pdTabUpdates'), pdUpdCount = $('pdUpdCount'), pdRevCount = $('pdRevCount');
        var pdPaneUpdates = $('pdPaneUpdates'), pdPaneReviews = $('pdPaneReviews');
        var licBtns = pv.querySelectorAll('#pdLicence .pm-lic');
        var licPriceEls = pv.querySelectorAll('#pdLicence [data-licprice]');
        var cur = null;
        var curGallery = [];
        var curIdx = 0;

        function hsh(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
        function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
        function fiat(n) { return window.__fiat ? window.__fiat(n) : ('$' + n); }
        function robux(n) { return window.__robux ? window.__robux(n) : ('R$ ' + Math.round(n * 80)); }
        function humanize(slug) { return (slug || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

        function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (_) { return []; } }
        function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
        var WISH = 'coldd_wish_v1';

        function isOwned(slug) { return window.__coldOwned.has(slug); }
        window.__coldOwned.load().then(function () { if (cur) render(cur.id); });

        var FEATURES = ['Fully optimized and production ready', 'Clean, well organized and easy to edit files', 'Simple drag and drop setup', 'Free updates and lifetime support included', 'Works in unlimited games and projects'];

        function fmtRevDate(iso) {
          try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
          catch (e) { return iso; }
        }
        function reviewsFor(p) {
          return window.__reviews ? window.__reviews.productReviews(p.id) : [];
        }
        function renderReviewListHtml(list) {
          return list.length ? list.map(function (r) {
            var reply = r.reply ? '<div class="pd-rev-reply"><div class="pd-rev-reply-head">coldd team replied</div><p>' + esc(r.reply.text) + '</p></div>' : '';
            return '<div class="pd-rev"><div class="pd-rev-head"><span class="pd-rev-name">' + esc(r.user) + '</span>' +
              '<span class="pd-rev-dot">·</span><span class="pd-rev-stars">' + starRow(r.stars) + '</span>' +
              '<span class="pd-rev-dot">·</span><span class="pd-rev-meta">' + esc(fmtRevDate(r.date)) + '</span></div>' +
              '<p class="pd-rev-body">' + esc(r.text) + '</p>' + reply + '</div>';
          }).join('') : '<p class="pd-empty">No reviews yet. Be the first to review this product.</p>';
        }
        // `existing` is {stars, text} when this account already has a
        // review on file (fetched async by loadMyReview, since the
        // catalog's own bulk reviews fetch never included user_id and has
        // no reason to for every OTHER visitor's reviews), null for a
        // genuinely first-time review.
        function renderReviewFormHtml(existing) {
          var stars = existing ? existing.stars : 0;
          return '<form class="pd-rev-form" id="pdRevForm">' +
            '<h4>' + (existing ? 'Your review' : 'Leave a review') + '</h4>' +
            '<div class="pd-rev-stars-input" id="pdRevStarsInput">' +
              [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" class="pd-rev-star-btn' + (n <= stars ? ' active' : '') + '" data-star="' + n + '" aria-label="' + n + ' star">' + STAR_SVG + '</button>'; }).join('') +
            '</div>' +
            '<textarea id="pdRevText" maxlength="2000" rows="3" placeholder="Share what you thought of this product...">' + esc(existing ? existing.text : '') + '</textarea>' +
            '<button type="submit" class="btn btn-primary" id="pdRevSubmit">' + (existing ? 'Update review' : 'Submit review') + '</button>' +
            '<p class="pd-rev-form-msg" id="pdRevFormMsg" hidden></p>' +
          '</form>';
        }
        // Guards against a slow lookup resolving after the shopper has
        // already clicked to a different product - re-checked before
        // touching the DOM so a stale response can't overwrite the form
        // for whatever's actually showing now.
        var myReviewLoadToken = 0;
        function loadMyReview(slug) {
          var token = ++myReviewLoadToken;
          if (!window.coldSupabase) return;
          window.coldSupabase.auth.getSession().then(function (res) {
            var session = res && res.data && res.data.session;
            if (!session) return null;
            return window.coldSupabase.from('reviews').select('stars, text, products!inner(slug)')
              .eq('user_id', session.user.id).eq('products.slug', slug).maybeSingle();
          }).then(function (r) {
            if (token !== myReviewLoadToken) return;
            var data = r && r.data;
            if (!data || !pdPaneReviews) return;
            var form = pdPaneReviews.querySelector('#pdRevForm');
            if (!form) return;
            revSelectedStars = data.stars;
            form.outerHTML = renderReviewFormHtml({ stars: data.stars, text: data.text });
          }).catch(function () {});
        }
        // Re-pulls just this product's reviews and repaints the list -
        // used right after a save so the new/edited review shows up
        // immediately instead of only after a manual page reload.
        function refetchReviewsAndRender(slug) {
          if (!window.coldSupabase || !pdPaneReviews) return Promise.resolve();
          return window.coldSupabase.from('reviews')
            .select('id, stars, text, created_at, reply, reply_at, user_name, products!inner(slug)')
            .eq('status', 'approved').eq('products.slug', slug)
            .order('created_at', { ascending: false }).limit(500)
            .then(function (res) {
              var rows = res && res.data || [];
              var list = rows.map(function (row) {
                return { user: row.user_name || 'user', stars: row.stars, text: row.text, date: row.created_at,
                  reply: row.reply ? { text: row.reply, date: row.reply_at } : null };
              });
              if (pdRevCount) pdRevCount.textContent = '(' + list.length + ')';
              var listWrap = pdPaneReviews.querySelector('#pdRevForm');
              // Everything after the form is the review list - replace just
              // that, so the form (and whatever the shopper is mid-typing
              // isn't relevant here since this only runs post-submit) isn't
              // torn down and rebuilt too.
              var html = renderReviewListHtml(list);
              if (listWrap) {
                var node = listWrap.nextSibling;
                while (node) { var next = node.nextSibling; node.remove(); node = next; }
                listWrap.insertAdjacentHTML('afterend', html);
              } else {
                pdPaneReviews.innerHTML = html;
              }
            }).catch(function () {});
        }
        function updatesFor(p) {
          var list = Array.isArray(p.versions) ? p.versions.slice() : [];
          list.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
          return list.map(function (v) { return { version: v.version, date: fmtRevDate(v.date), note: v.changelog || '' }; });
        }
        // File Format and File Size are the only fields actually automated
        // from the uploaded file - admin.js fills both from the File object
        // the moment a staff member picks a file to upload (name extension,
        // real byte size), and admin-upsert-product saves them verbatim as
        // product.tech. Every other field this used to show (part/mesh/
        // union/script counts, "Compatible Versions") was either a manual
        // text box nobody was required to fill in, or - when left blank -
        // silently replaced with a fabricated number derived by hashing the
        // product id, which looked like a real fact about the file but
        // wasn't one. Only show the two fields that are ever real.
        function techFor(p) {
          var t = p.tech || {};
          var rows = [];
          if (t.format) rows.push(['File Format', t.format]);
          if (t.size) rows.push(['File Size', t.size]);
          return rows;
        }
        function formatLongDesc(text) {
          var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
          var html = '', items = [];
          function flush() {
            if (items.length) { html += '<ul class="pd-feat-list">' + items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>'; items = []; }
          }
          lines.forEach(function (line) {
            if (/^[-*]\s+/.test(line)) items.push(line.replace(/^[-*]\s+/, ''));
            else { flush(); html += '<p>' + esc(line) + '</p>'; }
          });
          flush();
          return html;
        }
        function robuxRaw(n) { return 'R$ ' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
        function faqFor(p) {
          var isFree = (Number(p.priceNum) || 0) <= 0;
          var costAnswer = isFree
            ? 'This product is free - there is no payment, just add it to your cart and check out.'
            : 'This product costs ' + fiat(p.priceNum) + ', it is a one time payment with no recurring fees or subscriptions.';
          var list = [
            ['When will I receive the purchased product?', 'You receive the source files available to download instantly after purchase.'],
            ['Can I use this in multiple games?', 'Yes, you can use it in as many games and projects as you would like.'],
            ['How do I add this to my game?', 'If you received an .rbxl file open it directly in Roblox Studio via File then Open. If you received an .rbxm file, drag it directly into your Workspace.'],
            ['How much does this cost?', costAnswer],
            ['What if I need support or installation help?', 'Contact us via our discord support tickets at discord.gg/coldd or through email at support@coldd.dev'],
            ['Do I have to pay for future updates or support?', 'No, support is always free. Any updates we publish for this product are also free for all buyers. We do not offer custom changes, edits, or commissions for this product. Bug fixes related to the product itself are always free.'],
            ['Do I need to credit you in my game?', 'Credit is not required when using our assets, although it is appreciated if you do!'],
            ['Can I make money off this product?', 'Yes, you can monetize this product and profit commercially within your games and projects. You cannot resell or distribute source files or product files without an explicit resell license.'],
            ['Can I resell or redistribute this?', 'No, you cannot sell or distribute our products unless you have purchased a specific resell license. If you hold a resell license, you may resell the product under our reselling terms.'],
            ['Can I edit or update this product?', 'Yes, you can update, modify or edit any part of our products to fit within your games and projects.'],
            ['Can I pay in robux instead of real currency?', 'Yes you can purchase with robux on-site by simply selecting the robux purchase option. Keep in mind that real currency (USD) purchases are 50% cheaper than robux pricing.']
          ];
          return list;
        }

        function setMain(src) {
          // alt was never set here, so the primary product visual on every
          // product page announced nothing to a screen reader.
          if (pdImg) {
            pdImg.src = src || '';
            pdImg.alt = cur && cur.title ? cur.title : '';
          }
          pdThumbs && pdThumbs.querySelectorAll('.pd-thumb').forEach(function (t) {
            t.classList.toggle('active', t.getAttribute('data-src') === src);
          });
          // Tracked separately from pdImg.src, which the browser resolves to
          // an absolute URL - it would never match curGallery's raw strings
          // on the next lookup, so indexOf(pdImg.src) silently broke cycling
          // after the first step.
          var idx = curGallery.indexOf(src);
          if (idx >= 0) curIdx = idx;
          var multi = curGallery.length > 1;
          if (pdImgPrev) pdImgPrev.hidden = !multi;
          if (pdImgNext) pdImgNext.hidden = !multi;
        }
        function stepMain(dir) {
          if (curGallery.length < 2) return;
          curIdx = (curIdx + dir + curGallery.length) % curGallery.length;
          setMain(curGallery[curIdx]);
        }
        if (pdImgPrev) pdImgPrev.addEventListener('click', function () { stepMain(-1); });
        if (pdImgNext) pdImgNext.addEventListener('click', function () { stepMain(1); });
        function gallery(p) {
          var imgs = p.image ? [p.image] : [];
          if (Array.isArray(p.gallery) && p.gallery.length) {
            p.gallery.forEach(function (src) { if (src && imgs.indexOf(src) < 0) imgs.push(src); });
          }
          // Only the product's own cover + uploaded gallery; never pad with
          // other products' images.
          return imgs;
        }
        function refreshPrice() {
          if (!cur) return;
          var isResell = cur.licence === 'resell';
          var resellUsd = cur.resellPrice != null ? cur.resellPrice : Math.round(cur.priceNum * RESELL_MULT);
          var base = isResell ? resellUsd : cur.priceNum;
          cur.price = base; cur.licence = cur.licence;
          // A free product (base $0, only ever the standard licence) shows a
          // single "Free" with no struck-through price, no Robux equivalent
          // and no conversion note - none of those say anything at $0.
          var isFree = base <= 0;
          if (pdPrice) pdPrice.textContent = isFree ? 'Free' : fiat(base);
          if (pdPriceWas) {
            if (!isFree && !isResell && cur.was > cur.priceNum) { pdPriceWas.textContent = fiat(cur.was); pdPriceWas.hidden = false; }
            else pdPriceWas.hidden = true;
          }
          // Resell licences are sold in Robux now too - use resell_robux_price
          // when the admin set one, else flat-convert the resell USD price.
          var rbxOverride = isResell ? (cur.resellRobuxPrice > 0 ? cur.resellRobuxPrice : 0) : (cur.robuxPrice > 0 ? cur.robuxPrice : 0);
          if (pdPriceRbx) { pdPriceRbx.textContent = rbxOverride > 0 ? robuxRaw(rbxOverride) : robux(base); pdPriceRbx.hidden = isFree || isResell || !!cur.robuxDisabled; }
          if (pdPriceNote) pdPriceNote.hidden = isFree || isResell || !!cur.robuxDisabled;
          if (pdSale) pdSale.hidden = !(cur.was > cur.priceNum);
          // Live sale event (order-level, applied at checkout like an
          // automatic coupon): standard licence only, and not stacked on a
          // product already on a weekly deal / manual sale.
          if (pdSaleEvent) {
            var seOn = !isResell && !isFree && !(cur.was > cur.priceNum)
              && window.__saleEvent && window.__saleEvent() && window.__saleCovers && window.__saleCovers(cur);
            pdSaleEvent.hidden = !seOn;
            if (seOn) pdSaleEvent.textContent = 'Sale −' + window.__saleEvent().pct + '% applied at checkout';
          }
          var robuxMode = window.__currencyMode ? window.__currencyMode() === 'robux' : false;
          licPriceEls.forEach(function (el) {
            var isResellOpt = el.getAttribute('data-licprice') === 'resell';
            if (robuxMode && !cur.robuxDisabled && !isResellOpt) {
              var ov = cur.robuxPrice > 0 ? cur.robuxPrice : 0;
              if (ov > 0) { el.textContent = robuxRaw(ov); return; }
            }
            var pp = isResellOpt ? resellUsd : cur.priceNum;
            el.textContent = (cur.robuxDisabled || isResellOpt) ? fiat(pp) : (window.__money ? window.__money(pp) : fiat(pp));
          });
          if (pdReferEarn) pdReferEarn.textContent = 'earn ' + fiat(Math.round(cur.priceNum * 0.2 * 100) / 100);
        }
        function setLic(lic) {
          if (!cur) return;
          cur.licence = lic;
          licBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-lic') === lic); });
          refreshPrice();
        }
        licBtns.forEach(function (b) { b.addEventListener('click', function () { setLic(b.getAttribute('data-lic')); }); });

        function starRow(n) {
          var h = '';
          for (var i = 0; i < 5; i++) h += '<span class="pd-star ' + (i < n ? 'on' : '') + '">' + STAR_SVG + '</span>';
          return h;
        }
        function relatedCard(p) {
          var robuxMode = window.__currencyMode ? window.__currencyMode() === 'robux' : false;
          var rbx = robuxMode ? catalogRobuxPrice(p.id) : null;
          var priceText = rbx != null ? ('R$ ' + Math.round(rbx).toLocaleString('en-US')) : ((p.robuxDisabled && window.__fiat) ? window.__fiat(p.priceNum) : (window.__money ? window.__money(p.priceNum) : ('$' + p.priceNum)));
          return '<article class="product" data-id="' + esc(p.id) + '" data-resell="' + (p.resell ? 'yes' : 'no') + '" data-catlabel="' + esc(p.cat) + '" data-price="' + p.priceNum + '">' +
            '<div class="p-thumb" style="background-image:url(\'' + p.image + '\')"></div>' +
            '<div class="p-body"><h3 class="p-name">' + esc(p.title) + '</h3>' +
            '<div class="p-price-row"><span class="p-price" data-usd="' + p.priceNum + '">' + priceText + '</span></div>' +
            '<p class="p-sum">' + esc(p.desc) + '</p>' +
            '<div class="p-actions"><button class="p-buy" type="button">Buy now</button>' +
            '<button class="p-add" type="button">Add to cart</button></div></div></article>';
        }
        function related(p) {
          var cat = (window.__CATALOG || []).filter(function (x) { return x.id !== p.id && x.platform === p.platform && !isOwned(x.id); });
          function score(x) {
            var s = 0;
            if (x.subcat && p.subcat && x.subcat.split(',').some(function (v) { return p.subcat.split(',').indexOf(v) >= 0; })) s += 4;
            if (x.cat === p.cat) s += 3;
            if (x.resell === p.resell) s += 1;
            var a = p.title.toLowerCase().split(/\s+/), b = x.title.toLowerCase();
            a.forEach(function (w) { if (w.length > 3 && b.indexOf(w) >= 0) s += 1; });
            return s;
          }
          cat.sort(function (a, b) { return score(b) - score(a); });
          return cat.slice(0, 4);
        }

        // Real "customers who bought this also bought" signal from actual
        // paid orders - related() above is pure content similarity (same
        // category/subcat/title-word-overlap), which knows nothing about
        // what people actually buy together. Needs a round trip the
        // initial render above shouldn't block on, so it's fetched async
        // and the also-bought results are put first once they land -
        // real behavioral signal outranks a content-similarity guess.
        function fetchAlsoBought(p) {
          if (!window.coldSupabase || !pdRelated) return;
          window.coldSupabase.rpc('get_also_bought', { p_slug: p.id, p_limit: 8 }).then(function (res) {
            if (!cur || cur.id !== p.id) return; // navigated away before this resolved
            var slugs = (res.data || []).map(function (row) { return row.product_slug; });
            if (!slugs.length) return;
            var bySlug = {};
            (window.__CATALOG || []).forEach(function (x) { bySlug[x.id] = x; });
            var alsoBought = slugs.map(function (s) { return bySlug[s]; }).filter(Boolean).filter(function (x) { return !isOwned(x.id); });
            if (!alsoBought.length) return;
            var already = {}; alsoBought.forEach(function (x) { already[x.id] = true; });
            var blended = alsoBought.concat(related(p).filter(function (x) { return !already[x.id]; })).slice(0, 4);
            pdRelated.innerHTML = blended.map(relatedCard).join('');
            if (pdRelatedWrap) pdRelatedWrap.hidden = blended.length === 0;
          }).catch(function () {});
        }

        var curTab = 'overview';
        function showTab(t) {
          curTab = t;
          pv.querySelectorAll('.pd-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === t); });
          pv.querySelectorAll('.pd-tabpane').forEach(function (s) { s.hidden = s.getAttribute('data-pane') !== t; });
        }
        pv.querySelectorAll('.pd-tab').forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });

        /* Switching the tab alone leaves the reader at the top of the product
           page with the reviews a scroll away, so "Review" from the dashboard
           and "Leave a review" here both appeared to do nothing. Scroll the
           panel into view under the sticky header, and when the intent is to
           write, focus the textarea.

           The compose form only exists once ownership resolves, which is
           async, so a deep link has to wait for it rather than assume it is
           already in the DOM. */
        function goToReviews(compose) {
          showTab('reviews');
          var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

          /* Switching the tab alone left the reader at the top of the page
             with the reviews a full screen below, so "Review" from the
             dashboard and "Leave a review" here both looked like they did
             nothing. Scrolling stops the moment the reader takes over. */
          var stop = false;
          function release() { stop = true; }
          window.addEventListener('wheel', release, { passive: true, once: true });
          window.addEventListener('touchmove', release, { passive: true, once: true });
          window.addEventListener('keydown', function (e) {
            if (/^(Page|Arrow|Home|End| )/.test(e.key)) release();
          }, { once: true });

          // scrollIntoView rather than computing an offset against window:
          // it finds whichever ancestor actually scrolls, and the sticky
          // header is handled by scroll-margin-top on .pd-panelbox instead of
          // arithmetic here. Re-run for a short window because gallery images
          // land after this and push the panel down.
          var deadline = Date.now() + 2000, first = true;
          (function settle() {
            if (stop) return;
            var box = pv.querySelector('.pd-panelbox') || $('pdPaneReviews');
            if (box) {
              box.scrollIntoView({ block: 'start', behavior: (first && !reduce) ? 'smooth' : 'auto' });
              first = false;
            }
            if (Date.now() < deadline) setTimeout(settle, 150);
          })();

          if (!compose) return;
          var tries = 0;
          (function awaitForm() {
            var ta = document.getElementById('pdRevText');
            if (ta) {
              // Don't yank the page back up; the scroll above already framed it.
              ta.focus({ preventScroll: true });
              return;
            }
            if (tries++ < 40) setTimeout(awaitForm, 50);
          })();
        }

        function syncWish() {
          if (!cur || !pdWish) return;
          var on = lsGet(WISH).indexOf(cur.id) >= 0;
          pdWish.classList.toggle('on', on);
          if (pdWishTx) pdWishTx.textContent = on ? 'In your wishlist' : 'Add to wishlist';
        }
        function syncOwned() {
          if (!cur) return;
          if (!window.__coldOwned.ready()) {
            // Ownership isn't known yet - hide both CTAs rather than
            // flashing "Buy now" for someone who actually owns this.
            if (pdBuy) pdBuy.hidden = true;
            if (pdOwned) pdOwned.hidden = true;
            return;
          }
          var owned = isOwned(cur.id);
          if (pdBuy) pdBuy.hidden = owned;
          if (pdOwned) pdOwned.hidden = !owned;
          if (pdUpgrade) pdUpgrade.hidden = !(owned && cur.resell);
        }

        /* The category filter matches on the catalog's own slug, which is not
           always what you get by slugifying the label: "Finished Games &
           Templates" is `game-templates`, "Scripts & UI" is `scripts-ui`. Four
           of the twelve Roblox categories differ, so deriving the slug from the
           label produced breadcrumb links that silently fell back to "all" - 
           and now feeds those URLs to crawlers via BreadcrumbList. Look the
           real slug up, and only slugify as a last resort. */
        function catSlugFor(p) {
          var cats = window.__CATEGORIES || [];
          for (var i = 0; i < cats.length; i++) {
            if (cats[i].label === p.cat && cats[i].platform === p.platform) return cats[i].slug;
          }
          return (p.cat || '').toLowerCase().replace(/&/g, 'and')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        }

        // Non-destructive: hides the real product markup and drops a
        // sibling notice in, so a later render() of a valid product can
        // just clear it and unhide (matters for single-file SPA nav).
        function setNotFound(on) {
          var pd = pv.querySelector('.pd');
          if (!pd) return;
          var notice = pd.querySelector('.pd-notfound');
          Array.prototype.forEach.call(pd.children, function (c) {
            if (!c.classList.contains('pd-notfound')) c.hidden = on;
          });
          if (on && !notice) {
            pd.insertAdjacentHTML('beforeend', '<div class="pd-notfound">' +
              '<h1>Product not found</h1>' +
              '<p>We couldn’t find a product for this link - it may have been removed, renamed, or isn’t released yet.</p>' +
              '<a class="btn btn-primary" href="/shop">Browse the shop</a></div>');
          } else if (!on && notice) {
            notice.remove();
          }
        }
        function renderNotFound() {
          cur = null;
          setNotFound(true);
          document.title = 'Product not found - coldd Development';
          var robots = document.head.querySelector('meta[name="robots"]');
          if (!robots) { robots = document.createElement('meta'); robots.setAttribute('name', 'robots'); document.head.appendChild(robots); }
          robots.setAttribute('content', 'noindex, follow');
        }
        function render(id) {
          var cat = window.__CATALOG || [], p = null, i;
          for (i = 0; i < cat.length; i++) if (cat[i].id === id) { p = cat[i]; break; }
          // A real id that matches nothing (unreleased product, renamed
          // slug, typo'd link) must NOT silently fall through to a
          // different product - that's how an admin clicking one row lands
          // on another. Only the bare /product entry with no id uses the
          // first catalog item.
          if (!p && id) { renderNotFound(); return; }
          if (!p) p = cat[0];
          if (!p) return;
          setNotFound(false);

          // Canonical address is /product/<slug>. Whether we got here via a
          // pretty URL, an old /product?id=<slug> link, or the 404 fallback
          // redirect, normalise the address bar to the clean form (keeping
          // any tab=/ref= params). replaceState, so no reload.
          try {
            var _pretty = '/product/' + encodeURIComponent(p.id);
            var _sp = new URLSearchParams(location.search);
            _sp.delete('id');
            var _rest = _sp.toString();
            var _target = _pretty + (_rest ? '?' + _rest : '') + location.hash;
            if (location.pathname + location.search + location.hash !== _target) {
              history.replaceState(null, '', _target);
            }
          } catch (_e) {}
          var ups = updatesFor(p);
          var version = ups.length ? ups[0].version : 'v1.0';
          if (window.__interest) window.__interest.record(p.cat, p.title, 1);
          cur = { id: p.id, title: p.title, image: p.image, tag: p.cat, priceNum: p.priceNum, was: p.was || 0,
                  price: p.priceNum, licence: 'standard', resell: p.resell, platform: p.platform,
                  robuxPrice: p.robuxPrice != null ? p.robuxPrice : null,
                  robuxDisabled: !!p.robuxDisabled,
                  resellPrice: p.resellPrice != null ? p.resellPrice : null,
                  resellRobuxPrice: p.resellRobuxPrice != null ? p.resellRobuxPrice : null };

          var catSlug = catSlugFor(p);
          var crumb = '<a href="/">Home</a><span>›</span>' +
            '<a href="' + (p.page || '/shop') + '">' + esc(p.platform) + '</a><span>›</span>' +
            '<a href="' + (p.page || '/shop') + '?cat=' + catSlug + '">' + esc(p.cat) + '</a>';
          if (p.subcat) { var firstSub = p.subcat.split(',')[0]; crumb += '<span>›</span><span class="pd-crumb-cur">' + esc(window.__subcatLabel ? window.__subcatLabel(p.cat, firstSub) : humanize(firstSub)) + '</span>'; }
          else crumb = crumb.replace('<a href="' + (p.page || '/shop') + '?cat=' + catSlug + '">' + esc(p.cat) + '</a>', '<span class="pd-crumb-cur">' + esc(p.cat) + '</span>');
          if (pdCrumb) pdCrumb.innerHTML = crumb;

          if (pdTitle) pdTitle.innerHTML = esc(p.title) + ' <span class="pd-ver">' + version + '</span>';
          if (pdSub) pdSub.textContent = p.desc || '';

          // Admin-only quick links into the admin panel for this exact
          // product (deep-linked - /admin reads ?product=&action=). The X
          // dismisses it for this page view only, so an admin can see the
          // product page exactly as a customer does; it's back on reload.
          var pdAdminBar = document.getElementById('pdAdminBar');
          if (pdAdminBar && !pdAdminBar.dataset.wired && window.coldAuth && window.coldAuth.checkIsAdmin) {
            pdAdminBar.dataset.wired = '1';
            var xBtn = document.getElementById('pdAdminBarX');
            if (xBtn) xBtn.addEventListener('click', function () {
              pdAdminBar.hidden = true;
            });
            var eid = encodeURIComponent(p.id);
            var _dl = document.getElementById('pdAdminDownload');
            var _au = document.getElementById('pdAdminUpdate');
            if (_au) _au.href = '/admin?product=' + eid + '&action=update';
            if (_dl) _dl.onclick = function () {
              if (_dl.disabled) return;
              _dl.disabled = true;
              // Looks the product up by slug (admins can read every row), then
              // asks the admin download function for a short-lived link.
              window.coldSupabase.from('products').select('id').eq('slug', p.id).maybeSingle().then(function (r) {
                if (!r.data) throw new Error('Product not found.');
                return window.coldSupabase.functions.invoke('admin-get-download-url', { body: { productId: r.data.id } });
              }).then(function (res) {
                if (res.error || !res.data || !res.data.url) throw new Error((res.data && res.data.error) || 'No file has been uploaded for this product yet.');
                window.open(res.data.url, '_blank', 'noopener');
              }).catch(function (err) { alert(err.message || 'Could not download the file.'); }).then(function () { _dl.disabled = false; });
            };
            // Show straight away for a known admin (cached), confirm live.
            if (window.coldAuth.checkIsAdmin.cached && window.coldAuth.checkIsAdmin.cached()) pdAdminBar.hidden = false;
            window.coldAuth.checkIsAdmin().then(function (info) {
              pdAdminBar.hidden = !(info && info.isAdmin);
            }).catch(function () {});
          }

          var g = gallery(p);
          curGallery = g;
          if (pdThumbs) {
            pdThumbs.innerHTML = '';
            if (g.length > 1) g.forEach(function (src) {
              var t = document.createElement('button'); t.type = 'button'; t.className = 'pd-thumb';
              t.setAttribute('data-src', src); t.setAttribute('aria-label', 'View image');
              t.style.backgroundImage = "url('" + src + "')";
              t.addEventListener('click', function () { setMain(src); });
              pdThumbs.appendChild(t);
            });
          }
          setMain(g[0] || '');
          if (pdVideo) pdVideo.hidden = !p.video;
          if (pdVideoFrame) pdVideoFrame.src = p.video || '';

          if (pdLicResell) pdLicResell.hidden = !p.resell;
          if (pdLicLabel) pdLicLabel.style.display = '';
          licBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-lic') === 'standard'); });
          cur.licence = 'standard';
          refreshPrice();

          if (pdAbout) {
            pdAbout.innerHTML = '<h4>Product Features</h4>' + (p.longDesc && p.longDesc.trim()
              ? formatLongDesc(p.longDesc)
              : ('<p>' + esc(p.desc || '') + ' Every coldd release ships with clean, well documented files and free lifetime updates. If you get stuck, our team is one message away.</p>' +
                 '<ul class="pd-feat-list">' + FEATURES.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>'));
          }
          if (pdTechList) {
            var techRows = techFor(p);
            pdTechList.innerHTML = techRows.map(function (r) { return '<div class="pd-tech-row"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join('');
            if (pdTechWrap) pdTechWrap.hidden = techRows.length === 0;
          }

          var owned = isOwned(p.id);

          var revs = reviewsFor(p);
          if (pdRevCount) pdRevCount.textContent = '(' + revs.length + ')';
          if (pdPaneReviews) {
            pdPaneReviews.innerHTML = (owned ? renderReviewFormHtml(null) : '') + renderReviewListHtml(revs);
            revSelectedStars = 0;
            // Whether this account already reviewed this product - the form
            // used to always render blank, so resubmitting silently
            // overwrote the existing review (the upsert already prevented a
            // true duplicate row) with zero indication that's what just
            // happened. Pre-filling it and relabeling the button to "Update
            // review" makes that visible instead of implicit.
            if (owned) loadMyReview(p.id);
          }

          if (pdTabUpdates) pdTabUpdates.hidden = ups.length === 0;
          if (pdUpdCount) pdUpdCount.textContent = '(' + ups.length + ')';
          if (pdPaneUpdates) {
            pdPaneUpdates.innerHTML = ups.map(function (u) {
              var dl = owned ? '<button class="btn btn-ghost pd-upd-dl" type="button">Download</button>' : '';
              return '<div class="pd-upd"><div class="pd-upd-head"><span class="pd-upd-v">' + esc(u.version) + '</span><span class="pd-upd-date">' + esc(u.date) + '</span></div>' +
                '<p class="pd-upd-note">' + esc(u.note) + '</p>' + dl + '</div>';
            }).join('');
          }
          if (curTab === 'updates' && ups.length === 0) showTab('overview'); else showTab(curTab);

          if (pdRelated) {
            var rel = related(p);
            pdRelated.innerHTML = rel.map(relatedCard).join('');
            if (pdRelatedWrap) pdRelatedWrap.hidden = rel.length === 0;
            fetchAlsoBought(p);
          }
          if (pdFaqList) {
            pdFaqList.innerHTML = faqFor(p).map(function (q, idx) {
              return '<details class="pd-faq-item"' + (idx === 0 ? ' open' : '') + '><summary>' + esc(q[0]) + '</summary><p>' + esc(q[1]) + '</p></details>';
            }).join('');
          }

          syncWish(); syncOwned();
          applySeo(p, ups);
        }

        /* The <head> shipped with /product describes the shell. Once we know
           which product this is, restate the title, canonical, link preview
           and structured data for that specific product. */
        function applySeo(p, ups) {
          var seo = window.coldSeo;
          if (!seo) { document.title = p.title + ' - coldd'; return; }

          var title = p.title + ' - coldd';
          var path = '/product/' + encodeURIComponent(p.id);
          var desc = p.desc || (p.longDesc || '').replace(/<[^>]+>/g, '') ||
            (p.title + ', a ' + (p.cat || 'game') + ' asset for ' + (p.platform || 'Roblox') + ' from coldd.');

          seo.apply({ title: title, description: desc, path: path, image: p.image, type: 'product' });

          var offer = {
            '@type': 'Offer',
            url: 'https://coldd.dev' + path,
            price: String(p.priceNum || 0),
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
            itemCondition: 'https://schema.org/NewCondition',
            seller: { '@type': 'Organization', name: 'coldd Development' }
          };
          var product = {
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: p.title,
            description: seo.clamp(desc, 300),
            image: [seo.abs(p.image)],
            sku: p.id,
            category: p.cat || '',
            brand: { '@type': 'Brand', name: 'coldd Development' },
            offers: offer
          };
          if (ups && ups.length && ups[0].version) product.releaseNotes = ups[0].version;
          // Only claim a rating when real approved reviews back it. An invented
          // aggregateRating is a manual-action risk, not just bad manners.
          if (p.reviews > 0 && p.rating > 0) {
            product.aggregateRating = {
              '@type': 'AggregateRating',
              ratingValue: String(p.rating),
              reviewCount: String(p.reviews),
              bestRating: '5', worstRating: '1'
            };
          }
          seo.jsonLd('ld-product', product);

          var catSlug = catSlugFor(p);
          var trail = [{ name: 'Home', path: '/' },
                       { name: p.platform || 'Shop', path: p.page || '/shop' }];
          if (p.cat) trail.push({ name: p.cat, path: (p.page || '/shop') + '?cat=' + catSlug });
          trail.push({ name: p.title, path: path });
          seo.jsonLd('ld-crumbs', seo.breadcrumbs(trail));
        }

        if ($('pdAddBtn')) $('pdAddBtn').addEventListener('click', function () { if (cur) { add(cur); openCart(); } });
        if ($('pdBuyBtn')) $('pdBuyBtn').addEventListener('click', function () {
          if (!cur) return; add(cur);
          if (window.__goCheckout) window.__goCheckout(); else if (!window.__go) location.href = '/checkout'; else window.__go('checkout');
        });
        if (pdWish) pdWish.addEventListener('click', function () {
          if (!cur) return; var w = lsGet(WISH), i = w.indexOf(cur.id);
          var adding = i < 0;
          if (i >= 0) w.splice(i, 1); else w.push(cur.id);
          lsSet(WISH, w); syncWish();
          if (window.__wishSync) window.__wishSync(cur.id, adding);
        });
        if (pdUpgrade) pdUpgrade.addEventListener('click', function () { if (cur) { setLic('resell'); add(cur); openCart(); } });
        if ($('pdDownload')) $('pdDownload').addEventListener('click', function () { showTab('updates'); });
        if ($('pdReview')) $('pdReview').addEventListener('click', function () { goToReviews(true); });
        // ref=you was a hardcoded placeholder, not a real code - every
        // visitor who copied this link was sharing the exact same
        // literal string "you", which the referral-attribution backend
        // has no actual account tied to. Pulls the caller's real code
        // from the same endpoint the Referrals dashboard tab uses.
        var pdReferCode = null;
        if (pdReferCopy) pdReferCopy.addEventListener('click', function () {
          if (!cur) return;
          if (!window.coldAuth) return;
          window.coldSupabase.auth.getSession().then(function (res) {
            var session = res && res.data ? res.data.session : null;
            if (!session) { location.href = '/signin'; return; }
            var ready = pdReferCode ? Promise.resolve(pdReferCode) : window.coldAuth.invokeFn('get-referral-code', {}).then(function (r) {
              pdReferCode = r && r.code; return pdReferCode;
            });
            ready.then(function (code) {
              if (!code) return;
              var link = location.origin + '/product/' + encodeURIComponent(cur.id) + '?ref=' + encodeURIComponent(code);
              if (navigator.clipboard) navigator.clipboard.writeText(link).catch(function () {});
              var t = pdReferCopy.textContent; pdReferCopy.textContent = 'Copied!';
              setTimeout(function () { pdReferCopy.textContent = t; }, 1400);
            }).catch(function () {});
          });
        });
        if (pdReferLearn) pdReferLearn.addEventListener('click', function () { location.href = '/dashboard?panel=referrals'; });

        var revSelectedStars = 0;
        if (pdPaneReviews) {
          pdPaneReviews.addEventListener('click', function (e) {
            var starBtn = e.target.closest('.pd-rev-star-btn');
            if (!starBtn) return;
            revSelectedStars = Number(starBtn.getAttribute('data-star'));
            var btns = pdPaneReviews.querySelectorAll('.pd-rev-star-btn');
            for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', Number(btns[i].getAttribute('data-star')) <= revSelectedStars);
          });
          pdPaneReviews.addEventListener('submit', function (e) {
            var form = e.target.closest('#pdRevForm');
            if (!form || !cur) return;
            e.preventDefault();
            var msg = pdPaneReviews.querySelector('#pdRevFormMsg');
            var textEl = pdPaneReviews.querySelector('#pdRevText');
            var text = textEl ? textEl.value.trim() : '';
            var btn = form.querySelector('#pdRevSubmit');
            function showMsg(t) { if (msg) { msg.hidden = false; msg.textContent = t; } }
            if (!revSelectedStars) { showMsg('Please select a star rating.'); return; }
            if (!text) { showMsg('Please write a short review.'); return; }
            if (!window.coldAuth) return;
            var wasUpdate = !!btn && btn.textContent === 'Update review';
            if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
            window.coldAuth.invokeFn('submit-review', { slug: cur.id, stars: revSelectedStars, text: text })
              .then(function () {
                // Reviews go live immediately (no approval queue - see
                // submit-review's own comment) - the old "pending approval"
                // copy hadn't matched reality since that changed.
                return refetchReviewsAndRender(cur.id).then(function () {
                  showMsg(wasUpdate ? 'Your review has been updated.' : 'Thanks! Your review is live.');
                  if (btn) { btn.disabled = false; btn.textContent = 'Update review'; }
                  var heading = form.querySelector('h4');
                  if (heading) heading.textContent = 'Your review';
                });
              })
              .catch(function (err) {
                showMsg((err && err.message) || 'Could not submit review.');
                if (btn) { btn.disabled = false; btn.textContent = wasUpdate ? 'Update review' : 'Submit review'; }
              });
          });
        }

        function syncRelatedPricing() {
          if (!pdRelated) return;
          pdRelated.querySelectorAll('.product').forEach(function (card) {
            var id = card.getAttribute('data-id');
            var p = (window.__CATALOG || []).filter(function (x) { return x.id === id; })[0];
            if (!p) return;
            var priceEl = card.querySelector('.p-price');
            if (!priceEl) return;
            var robuxMode = window.__currencyMode ? window.__currencyMode() === 'robux' : false;
            var rbx = robuxMode ? catalogRobuxPrice(p.id) : null;
            priceEl.textContent = rbx != null ? ('R$ ' + Math.round(rbx).toLocaleString('en-US')) : ((p.robuxDisabled && window.__fiat) ? window.__fiat(p.priceNum) : (window.__money ? window.__money(p.priceNum) : ('$' + p.priceNum)));
          });
        }
        window.addEventListener('currencychange', function () { if (cur) refreshPrice(); syncRelatedPricing(); });
        window.__renderProduct = render;
        if (!window.__singleFile) {
          pv.hidden = false;
          // /product/<slug> (pretty) first, then the legacy ?id=<slug>.
          var q = (location.pathname.match(/^\/product\/([^\/?#]+)/) || [])[1]
                || (location.search.match(/[?&]id=([^&]+)/) || [])[1];
          render(q ? decodeURIComponent(q) : '');
          if (/[?&]tab=reviews\b/.test(location.search)) goToReviews(true);
        }
      })();

      window.addEventListener('currencychange', function () {
        updateBadge(); renderCart();
      });

      updateBadge();
    })();

    (function () {
      var btn = document.getElementById('accountBtn');
      if (!btn) return;

      function isLoggedIn() { try { return localStorage.getItem('coldd_auth') === 'in'; } catch (e) { return false; } }

      // coldd_auth is a client-only "was I signed in" flag, cached in
      // localStorage so the nav can render instantly without waiting on a
      // network round trip. It can still go stale even though the real
      // session also lives in localStorage now (see supabase-init.js) - a
      // refresh token can expire, get revoked, or belong to a banned/
      // deleted account, all of which leave this flag still saying "in"
      // with nothing backing it up. Without this, the nav shows a signed-
      // in account menu that dead-ends at /signin the moment its "Your
      // Account" link is followed. Reconciling the flag against the real
      // session on every load - not just gating dashboard-style pages -
      // fixes it where the stale state actually starts.
      if (window.coldSupabase) {
        window.coldSupabase.auth.getSession().then(function (res) {
          var hasSession = !!(res && res.data && res.data.session);
          var flaggedIn = isLoggedIn();
          if (hasSession === flaggedIn) return;
          try { localStorage.setItem('coldd_auth', hasSession ? 'in' : 'out'); } catch (e) {}
          if (!hasSession) { try { localStorage.removeItem('coldd_profile'); localStorage.removeItem('coldd_is_admin'); } catch (e) {} }
        }).catch(function () {});
      }

      var menu = null, overlay = null;

      function buildMenu() {
        menu = document.createElement('div');
        menu.className = 'account-menu';
        menu.hidden = true;
        var p = window.coldAuth && window.coldAuth.getProfile ? window.coldAuth.getProfile() : null;
        var initial = (p && p.name) ? p.name.trim().charAt(0).toUpperCase() : '?';
        var avatarUrl = window.coldAuth && window.coldAuth.avatarUrlFor ? window.coldAuth.avatarUrlFor(p) : (p && p.avatar);
        var avatarHtml = avatarUrl
          ? '<span class="account-menu-av account-menu-av-lg" style="background-image:url(' + avatarUrl + ')"></span>'
          : '<span class="account-menu-av account-menu-av-lg">' + initial + '</span>';
        var displayName = (p && p.name) ? p.name : 'Member';
        var subtitle = (p && p.email) ? p.email
          : (p && p.provider ? (p.provider.charAt(0).toUpperCase() + p.provider.slice(1) + ' account') : '');
        function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
        var links = [
          ['/dashboard', 'Dashboard', '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'],
          ['/dashboard?panel=purchases', 'Purchase History', '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>'],
          ['/dashboard?panel=owned', 'Licenses', '<path d="m12 2 7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/><path d="m9 12 2 2 4-4"/>'],
          ['/dashboard?panel=wishlist', 'Wishlist', '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'],
          ['/dashboard?panel=referrals', 'Referrals', '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'],
          ['/dashboard?panel=account', 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.5.6.86 1.11.86H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>']
        ];
        var itemsHtml = links.map(function (l) {
          return '<a href="' + l[0] + '" class="account-menu-item">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + l[2] + '</svg>' +
            '<span>' + l[1] + '</span></a>';
        }).join('');
        menu.innerHTML =
          '<div class="account-menu-head">' + avatarHtml +
          '<span class="account-menu-id"><strong>' + esc(displayName) + '</strong>' +
          (subtitle ? '<em>' + esc(subtitle) + '</em>' : '') + '</span></div>' +
          '<div class="account-menu-list">' + itemsHtml + '</div>' +
          '<button type="button" class="account-menu-item account-menu-signout" id="menuSignout">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>' +
          '<span>Sign out</span></button>';
        btn.parentNode.style.position = 'relative';
        btn.parentNode.appendChild(menu);
        menu.querySelector('#menuSignout').addEventListener('click', function () {
          closeMenu();
          openConfirm();
        });

        // Admin-only shortcut into the admin panel. Never in the markup for
        // a normal user, so it can't be revealed by fiddling with the DOM.
        // /admin has its own independent gate regardless. Rendered from the
        // cached check straight away, then confirmed (or removed) by the
        // live one so it doesn't lag the rest of the menu.
        if (window.coldAuth && window.coldAuth.checkIsAdmin) {
          var addAdminRow = function () {
            if (menu.querySelector('.account-menu-admin')) return;
            var box = document.createElement('a');
            box.href = '/admin';
            box.className = 'account-menu-admin';
            box.innerHTML =
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>' +
              '<span>Admin panel</span>';
            menu.insertBefore(box, menu.querySelector('#menuSignout'));
          };
          if (window.coldAuth.checkIsAdmin.cached && window.coldAuth.checkIsAdmin.cached()) addAdminRow();
          window.coldAuth.checkIsAdmin().then(function (info) {
            var row = menu.querySelector('.account-menu-admin');
            if (info && info.isAdmin) addAdminRow();
            else if (row) row.remove();
          }).catch(function () {});
        }
      }

      function toggleMenu() {
        if (!menu) buildMenu();
        var opening = menu.hidden;
        if (opening) window.__coldCloseNotifPanel && window.__coldCloseNotifPanel();
        menu.hidden = !menu.hidden;
        if (!menu.hidden) window.__coldMenuFit && window.__coldMenuFit(menu, btn);
      }
      function closeMenu() { if (menu) menu.hidden = true; }
      window.__coldCloseAccountMenu = closeMenu;

      function buildConfirm() {
        overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.hidden = true;
        overlay.innerHTML =
          '<div class="confirm-modal" role="dialog" aria-modal="true"><h3 class="confirm-title">Sign out of coldd?</h3><p>You will need to sign in again to download or manage your products.</p><div class="confirm-actions">' +
          '<button class="btn btn-tinted" type="button" id="navSignoutCancel">Cancel</button>' +
          '<button class="btn btn-primary" type="button" id="navSignoutConfirm">Sign out</button>' +
          '</div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.hidden = true; });
        overlay.querySelector('#navSignoutCancel').addEventListener('click', function () { overlay.hidden = true; });
        overlay.querySelector('#navSignoutConfirm').addEventListener('click', function () {
          overlay.hidden = true;
          try { localStorage.setItem('coldd_auth', 'out'); } catch (e) {}
          (window.coldAuth ? window.coldAuth.signOut() : Promise.resolve()).then(function () { location.href = '/'; });
        });
      }
      function openConfirm() { if (!overlay) buildConfirm(); overlay.hidden = false; }

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (isLoggedIn()) toggleMenu();
        else location.href = '/signin';
      });
      document.addEventListener('click', function (e) {
        if (menu && !menu.hidden && !e.target.closest('.account-menu') && e.target !== btn && !e.target.closest('#accountBtn')) closeMenu();
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
    })();

    (function () {
      var wrap = document.getElementById('notifWrap');
      var btn = document.getElementById('notifBtn');
      var panel = document.getElementById('notifPanel');
      var list = document.getElementById('notifList');
      var badge = document.getElementById('notifBadge');
      var markAllBtn = document.getElementById('notifMarkAll');
      if (!wrap || !btn || !panel || !list || !badge) return;

      function isLoggedIn() { try { return localStorage.getItem('coldd_auth') === 'in'; } catch (e) { return false; } }
      function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
      function fmtWhen(iso) {
        var d = new Date(iso), diff = Date.now() - d.getTime();
        var mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        var days = Math.floor(hrs / 24);
        if (days < 7) return days + 'd ago';
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      }

      var NOTIFS = [];

      function renderBadge() {
        var unread = NOTIFS.filter(function (n) { return !n.read_at; }).length;
        if (unread > 0) { badge.hidden = false; badge.textContent = unread > 99 ? '99+' : String(unread); }
        else badge.hidden = true;
      }

      var NOTIF_SVG = {
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 4.5 1.2 6.6 2.1 7.7.5.6.1 1.3-.6 1.3H4.5c-.7 0-1.1-.7-.6-1.3C4.8 14.6 6 12.5 6 8"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        receipt: '<path d="M4 3v18l2-1.5L8 21l2-1.5L12 21l2-1.5L16 21l2-1.5L20 21V3l-2 1.5L16 3l-2 1.5L12 3l-2 1.5L8 3 6 4.5 4 3Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
        tag: '<path d="M20.6 13.4 12 22l-8-8V4h10l6.6 6.6a2 2 0 0 1 0 2.8Z"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>',
        star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18l-5.9 3 1.2-6.5L2.5 9.4l6.6-.9z"/>',
        download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
        spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'
      };
      function notifMediaHtml(n) {
        var m = (n.url || '').match(/[?&]id=([^&#]+)/);
        if (m) {
          var slug = decodeURIComponent(m[1]);
          var p = (window.__CATALOG || []).filter(function (c) { return c.id === slug; })[0];
          if (p && p.image) {
            var src = window.imgUrl ? window.imgUrl(p.image) : p.image;
            return '<span class="notif-item-thumb" style="background-image:url(\'' + src + '\')"></span>';
          }
        }
        var t = (n.title + ' ' + (n.body || '')).toLowerCase();
        var key = /order|receipt|purchase|payment|invoice/.test(t) ? 'receipt'
          : /sale|deal|discount|% off|drop|price/.test(t) ? 'tag'
          : /review/.test(t) ? 'star'
          : /update|new version|patch|changelog/.test(t) ? 'download'
          : /welcome|thanks for joining|get started/.test(t) ? 'spark'
          : 'bell';
        return '<span class="notif-item-icon" data-kind="' + key + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + NOTIF_SVG[key] + '</svg></span>';
      }
      function renderList() {
        if (!NOTIFS.length) { list.innerHTML = '<p class="notif-empty">No notifications yet.</p>'; return; }
        list.innerHTML = NOTIFS.map(function (n) {
          var tag = n.url ? 'a' : 'div';
          var href = n.url ? ' href="' + esc(n.url) + '"' : '';
          return '<' + tag + ' class="notif-item' + (n.read_at ? '' : ' unread') + '" data-id="' + esc(n.id) + '"' + href + '>' +
            notifMediaHtml(n) +
            '<div class="notif-item-main">' +
              '<div class="notif-item-title">' + esc(n.title) + '</div>' +
              (n.body ? '<div class="notif-item-body">' + esc(n.body) + '</div>' : '') +
              '<div class="notif-item-date">' + fmtWhen(n.created_at) + '</div>' +
            '</div>' +
            '</' + tag + '>';
        }).join('');
      }

      function loadNotifs() {
        if (!window.coldSupabase) return;
        window.coldSupabase.auth.getSession().then(function (res) {
          var session = res && res.data && res.data.session;
          if (!session) { wrap.hidden = true; document.documentElement.classList.remove('auth-in'); return; }
          wrap.hidden = false;
          return window.coldSupabase.from('notifications').select('*').eq('user_id', session.user.id)
            .order('created_at', { ascending: false }).limit(50).then(function (r) {
              if (r.error) { console.error('[coldd] failed to load notifications:', r.error.message); return; }
              NOTIFS = r.data || [];
              renderBadge();
              if (!panel.hidden) renderList();
            });
        }).catch(function () {});
      }

      function markRead(ids) {
        if (!ids.length || !window.coldSupabase) return Promise.resolve();
        var now = new Date().toISOString();
        ids.forEach(function (id) {
          var n = NOTIFS.filter(function (x) { return x.id === id; })[0];
          if (n) n.read_at = now;
        });
        renderBadge(); renderList();
        return window.coldSupabase.from('notifications').update({ read_at: now }).in('id', ids).then(function () {});
      }

      function togglePanel() {
        var opening = panel.hidden;
        if (opening) window.__coldCloseAccountMenu && window.__coldCloseAccountMenu();
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
          renderList();
          var unreadIds = NOTIFS.filter(function (n) { return !n.read_at; }).map(function (n) { return n.id; });
          if (unreadIds.length) markRead(unreadIds);
        }
      }
      window.__coldCloseNotifPanel = function () { panel.hidden = true; };

      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); togglePanel(); });
      if (markAllBtn) markAllBtn.addEventListener('click', function (e) {
        e.preventDefault();
        markRead(NOTIFS.filter(function (n) { return !n.read_at; }).map(function (n) { return n.id; }));
      });
      document.addEventListener('click', function (e) {
        if (!panel.hidden && !e.target.closest('.nav-notif')) panel.hidden = true;
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') panel.hidden = true; });

      loadNotifs();

      // Was load-once: a notification created while someone sat on a page
      // never appeared until they navigated or refreshed. Polling instead
      // of a realtime subscription - simplest fix that matches how the
      // rest of the site already works (no websocket/channel setup
      // anywhere else), at a low enough interval nobody perceives the
      // 60s-old-at-worst gap as "not live". Paused in background tabs so
      // it isn't hammering Supabase for every idle tab a visitor forgets
      // open, and reconciled instantly on return instead of waiting out
      // whatever was left of the interval.
      var pollId = setInterval(function () { if (!document.hidden) loadNotifs(); }, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) loadNotifs(); });
      window.addEventListener('beforeunload', function () { clearInterval(pollId); });
    })();

    (function () {
      var KEY = 'coldd_auth';

      window.__isLoggedIn = function () { try { return localStorage.getItem(KEY) !== 'out'; } catch (e) { return true; } };
      function setState(v) { try { localStorage.setItem(KEY, v ? 'in' : 'out'); } catch (e) {} }

      window.__goDashboard = function () {
        if (window.__go) window.__go('dashboard');
        else location.href = '/dashboard';
      };
      window.__demoLogin = function () { setState(true); window.__goDashboard(); };

      // .dash is a generic two-column layout class reused by other pages
      // (the admin panel included) - .dash-page is what's actually unique
      // to the customer dashboard, and this block's redirect-to-/signin
      // logic further down must never fire anywhere else.
      var dash = document.querySelector('.dash-page');
      if (!dash) return;

      var adminLink = document.getElementById('dashAdminLink');
      if (adminLink && window.coldAuth && window.coldAuth.checkIsAdmin) {
        // Show it right away if the last check said staff; the live check
        // then confirms or (rarely) hides it again.
        if (window.coldAuth.checkIsAdmin.cached && window.coldAuth.checkIsAdmin.cached()) adminLink.hidden = false;
        window.coldAuth.checkIsAdmin().then(function (info) { adminLink.hidden = !info.isAdmin; });
      }

      var panels = dash.querySelectorAll('.dash-panel');
      var navlinks = dash.querySelectorAll('.dash-nav a, [data-panel]');
      function showPanel(name) {
        panels.forEach(function (p) { p.hidden = (p.id !== 'panel-' + name); });
        dash.querySelectorAll('.dash-nav a').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-panel') === name); });
        if (name === 'wishlist' && typeof renderWishlist === 'function') renderWishlist();
        if (name === 'account' && typeof loadSecurity === 'function') loadSecurity();
        if (name === 'account' && typeof window.__initSellerProfile === 'function') window.__initSellerProfile();
        if (name === 'referrals' && typeof refreshReferrals === 'function') refreshReferrals();
      }
      dash.addEventListener('click', function (e) {
        var a = e.target.closest('[data-panel]');
        if (a) { e.preventDefault(); showPanel(a.getAttribute('data-panel')); }
      });

      var initialPanel = new URLSearchParams(location.search).get('panel');
      if (initialPanel && dash.querySelector('#panel-' + initialPanel)) showPanel(initialPanel);

      // Wishlist has no backend table - it's the same coldd_wish_v1
      // localStorage array product.html already reads/writes (an array
      // of catalog ids), so this panel is just a live view onto it.
      var WISH_KEY = 'coldd_wish_v1';
      function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
      function wishIds() { try { return JSON.parse(localStorage.getItem(WISH_KEY) || '[]') || []; } catch (e) { return []; } }
      function saveWishIds(ids) { try { localStorage.setItem(WISH_KEY, JSON.stringify(ids)); } catch (e) {} }
      function wishIsOwned(id) {
        return !!(window.__coldOwned && (window.__coldOwned.has(id) || window.__coldOwned.has(id, 'resell')));
      }
      // A wishlist is a buy-later list. Once a purchase succeeds elsewhere on
      // the site, remove that entry locally and from the account mirror so it
      // cannot surface a second Buy now/Add to cart path.
      function pruneOwnedWishes() {
        if (!window.__coldOwned || !window.__coldOwned.ready()) return wishIds();
        var before = wishIds();
        var kept = before.filter(function (id) { return !wishIsOwned(id); });
        if (kept.length !== before.length) {
          saveWishIds(kept);
          if (window.__wishSync) before.filter(function (id) { return wishIsOwned(id); }).forEach(function (id) { window.__wishSync(id, false); });
        }
        return kept;
      }
      function withWishOwnership(cb) {
        if (!window.__coldOwned) { cb(); return; }
        // An ownership lookup failing must not leave the entire wishlist
        // blank. In that rare case we render the saved entries, but never
        // prune until ownership has actually resolved.
        window.__coldOwned.load().then(cb, cb);
      }
      // One-time backfill: anything wishlisted before wishlist_items existed
      // (or added on a device that was never signed in yet) was never
      // synced - dashboard load is the one place guaranteed to run for a
      // signed-in user with the full id list already in hand, so it's the
      // natural place to catch it up.
      if (window.__wishSync) wishIds().forEach(function (id) { window.__wishSync(id, true); });
      function wishPriceText(p) {
        var robuxMode = window.__currencyMode ? window.__currencyMode() === 'robux' : false;
        var rbx = robuxMode && p.robuxPrice > 0 ? p.robuxPrice : null;
        return rbx != null ? ('R$ ' + Math.round(rbx).toLocaleString('en-US')) : ((p.robuxDisabled && window.__fiat) ? window.__fiat(p.priceNum) : (window.__money ? window.__money(p.priceNum) : ('$' + p.priceNum)));
      }
      // Card-grid layout, matching Licenses (.dash-prod/.dp-thumb/.dp-body)
      // rather than the old compact row list - a wishlist entry is a product
      // you haven't bought yet, so it gets the same visual weight as one you
      // have, plus the Buy now/Add to cart pair a still-to-buy item actually
      // needs (Licenses' equivalent slot is Download/Review instead).
      // Two ways a bundle deal reaches this panel: get-my-bundle-deal looks
      // up whatever's minted directly against this signed-in account (the
      // wishlist reminder always sets user_id - see runWishlistReminder),
      // so it shows up here even if this browser never clicked the actual
      // reminder email. Falling back to a ?bundle=TOKEN captured into
      // localStorage (same as ?ref=/?cmp=) covers the case of a deal
      // minted for a guest email, or a link opened somewhere localStorage
      // doesn't carry the account's own deal. Fetched once per panel
      // render, not per item.
      var wishBundleCache = null; // { slugs, itemPct, bundlePct } | false (fetched, none active) | null (not fetched yet)
      var wishBundleFetched = false;
      function loadWishBundle(cb) {
        if (wishBundleFetched) { cb(); return; }
        if (!window.coldSupabase) { wishBundleFetched = true; wishBundleCache = false; cb(); return; }
        function fromToken() {
          var token = null;
          try { token = localStorage.getItem('coldd_bundle_token'); } catch (e) {}
          if (!token) { wishBundleFetched = true; wishBundleCache = false; cb(); return; }
          window.coldSupabase.functions.invoke('get-bundle-deal', { body: { token: token } }).then(function (res) {
            var data = res && res.data;
            wishBundleFetched = true;
            wishBundleCache = (data && data.ok) ? { slugs: data.slugs, itemPct: data.itemPct, bundlePct: data.bundlePct } : false;
            cb();
          }).catch(function () { wishBundleFetched = true; wishBundleCache = false; cb(); });
        }
        window.coldSupabase.functions.invoke('get-my-bundle-deal', { body: {} }).then(function (res) {
          var data = res && res.data;
          if (data && data.ok) {
            wishBundleFetched = true;
            wishBundleCache = { slugs: data.slugs, itemPct: data.itemPct, bundlePct: data.bundlePct };
            cb();
            return;
          }
          fromToken();
        }).catch(fromToken);
      }
      function renderWishlist() {
        var el = document.getElementById('dashWishlistRows');
        if (!el) return;
        withWishOwnership(function () { pruneOwnedWishes(); loadWishBundle(function () { paintWishlist(el); }); });
      }
      function paintWishlist(el) {
        var ids = pruneOwnedWishes();
        var cat = window.__CATALOG || [];
        var items = ids.map(function (id) { return cat.filter(function (p) { return p.id === id; })[0]; }).filter(Boolean);
        if (!items.length) { el.innerHTML = '<p class="dash-empty-note">Nothing saved yet - tap the heart on any product to add it here.</p>'; return; }
        var bundle = wishBundleCache || null;
        var wishedSlugs = items.map(function (p) { return p.id; });
        var dealItems = bundle ? items.filter(function (p) { return bundle.slugs.indexOf(p.id) !== -1; }) : [];
        var allDealItemsWished = bundle ? bundle.slugs.every(function (s) { return wishedSlugs.indexOf(s) !== -1; }) : false;
        var banner = '';
        if (dealItems.length) {
          banner = '<div class="wish-deal-banner">' +
            (allDealItemsWished
              ? ('<strong>' + (bundle.itemPct + bundle.bundlePct) + '% off</strong> all ' + dealItems.length + ' discounted items below if you get them together.')
              : ('<strong>' + bundle.itemPct + '% off</strong> ' + dealItems.length + ' item' + (dealItems.length > 1 ? 's' : '') + ' below - add every discounted one for ' + (bundle.itemPct + bundle.bundlePct) + '% off instead.')) +
            '</div>';
        }
        el.innerHTML = banner + items.map(function (p) {
          var href = '/product/' + encodeURIComponent(p.id);
          var inDeal = bundle && bundle.slugs.indexOf(p.id) !== -1;
          var priceHtml = wishPriceText(p);
          if (inDeal) {
            var pct = allDealItemsWished ? (bundle.itemPct + bundle.bundlePct) : bundle.itemPct;
            var discounted = Math.round(p.priceNum * (1 - pct / 100) * 100) / 100;
            priceHtml = '<span class="dp-was">' + wishPriceText(p) + '</span>' + ((p.robuxDisabled && window.__fiat) ? window.__fiat(discounted) : (window.__money ? window.__money(discounted) : ('$' + discounted)));
          }
          return '<div class="dash-prod' + (inDeal ? ' dp-in-deal' : '') + '" data-id="' + esc(p.id) + '">' +
            '<div class="dp-thumb" style="background-image:url(\'' + p.image + '\')">' +
            (inDeal ? '<span class="dp-deal-badge">Deal</span>' : '') +
            '<button class="dp-remove wl-remove" type="button" aria-label="Remove from wishlist">×</button></div>' +
            '<div class="dp-body"><a class="dp-name dr-title-link" href="' + href + '">' + esc(p.title) + '</a>' +
            '<span class="dp-price" data-usd="' + p.priceNum + '">' + priceHtml + '</span>' +
            '<div class="dp-actions"><button class="p-add wl-add" type="button">Add to cart</button><button class="p-buy wl-buy" type="button">Buy now</button></div></div></div>';
        }).join('');
      }
      // Overview-page preview box (capped) - mirrors "Recent purchases"'
      // compact row look, but gets the same Add to cart/Buy now pair as the
      // full Wishlist panel so a saved item can be bought straight from the
      // dashboard home without a trip to the full Wishlist tab first.
      function renderWishlistPreview(skipOwnershipLoad) {
        var el = document.getElementById('dashWishlistPreview');
        if (!el) return;
        if (!skipOwnershipLoad && window.__coldOwned && !window.__coldOwned.ready()) { withWishOwnership(function () { renderWishlistPreview(true); }); return; }
        var ids = pruneOwnedWishes().slice(0, 3);
        var cat = window.__CATALOG || [];
        var items = ids.map(function (id) { return cat.filter(function (p) { return p.id === id; })[0]; }).filter(Boolean);
        el.innerHTML = items.length ? items.map(function (p) {
          return '<div class="dash-row" data-id="' + esc(p.id) + '"><span class="dr-thumb" style="background-image:url(\'' + p.image + '\')"></span>' +
            '<div class="dr-main"><a class="dr-title-link" href="/product/' + encodeURIComponent(p.id) + '">' + esc(p.title) + '</a><div class="dr-sub"><span class="p-price" data-usd="' + p.priceNum + '">' + wishPriceText(p) + '</span></div></div>' +
            '<div class="dr-actions"><button class="p-add wl-add" type="button">Add to cart</button><button class="p-buy wl-buy" type="button">Buy now</button></div></div>';
        }).join('') : '<p class="dash-empty-note">Nothing saved yet - tap the heart on any product to add it here.</p>';
      }
      // Real purchase-history-based recommendations (get_recommended_for_user:
      // other products in categories the signed-in user has actually bought
      // from before, weighted toward higher-rated/more-reviewed ones,
      // excluding anything they already own) - not shown at all for a buyer
      // with no purchase history yet, since there's nothing real to base it
      // on and an empty or random-looking "recommended" card is worse than
      // no card.
      // Same .product card the shop grid and product page's "Related
      // products" use (thumb/name/price/summary/Buy now/Add to cart) -
      // was a compact vertical list of rows, unlike every other
      // "recommended" row on the site. Riding the .product markup means
      // it also picks up the sitewide click-delegation handler (buy/add/
      // open) for free, no extra wiring needed here.
      function dashRecCard(p) {
        return '<article class="product" data-id="' + esc(p.id) + '" data-resell="' + (p.resell ? 'yes' : 'no') + '" data-catlabel="' + esc(p.cat) + '" data-price="' + p.priceNum + '">' +
          '<div class="p-thumb" style="background-image:url(\'' + p.image + '\')"></div>' +
          '<div class="p-body"><h3 class="p-name">' + esc(p.title) + '</h3>' +
          '<div class="p-price-row"><span class="p-price" data-usd="' + p.priceNum + '">' + wishPriceText(p) + '</span></div>' +
          '<p class="p-sum">' + esc(p.desc || '') + '</p>' +
          '<div class="p-actions"><button class="p-buy" type="button">Buy now</button>' +
          '<button class="p-add" type="button">Add to cart</button></div></div></article>';
      }
      function renderRecommended() {
        var card = document.getElementById('dashRecommendedCard');
        var el = document.getElementById('dashRecommended');
        if (!card || !el || !window.coldSupabase) return;
        window.coldSupabase.auth.getSession().then(function (res) {
          var session = res && res.data && res.data.session;
          if (!session) return;
          return window.coldSupabase.rpc('get_recommended_for_user', { p_user_id: session.user.id, p_limit: 3 }).then(function (r) {
            var slugs = (r.data || []).map(function (row) { return row.product_slug; });
            if (!slugs.length) return;
            var cat = window.__CATALOG || [];
            var items = slugs.map(function (s) { return cat.filter(function (p) { return p.id === s; })[0]; }).filter(Boolean);
            if (!items.length) return;
            el.innerHTML = items.map(dashRecCard).join('');
            card.hidden = false;
          });
        }).catch(function () {});
      }
      renderRecommended();

      // "Complete the collection": a subcategory the buyer owns 2+ of but
      // not all - get-set-deal mints a bundle token for what's missing.
      function renderSetDeal() {
        var card = document.getElementById('dashSetDealCard');
        var grid = document.getElementById('dashSetDealGrid');
        if (!card || !grid || !window.coldSupabase || !window.coldAuth) return;
        window.coldAuth.invokeFn('get-set-deal', {}).then(function (data) {
          var d = data && data.deal;
          if (!d || !d.items || !d.items.length) return;
          document.getElementById('dashSetDealSub').textContent =
            'You own ' + d.ownedCount + ' of ' + d.totalCount + ' in the ' + d.label + ' collection. Get the rest at ' +
            d.itemPct + '% off each (' + d.bundlePct + '% off if you take them all).';
          var cat = window.__CATALOG || [];
          grid.innerHTML = d.items.map(function (it) {
            var p = cat.filter(function (x) { return x.id === it.slug; })[0];
            return p ? dashRecCard(p) : '';
          }).join('');
          document.getElementById('dashSetDealAdd').onclick = function () {
            d.items.forEach(function (it) {
              var p = cat.filter(function (x) { return x.id === it.slug; })[0];
              if (p && window.__cartAdd) window.__cartAdd({ id: p.id, title: p.title, price: p.priceNum, image: p.image, tag: p.cat || '' });
            });
            try { localStorage.setItem('coldd_bundle_token', d.token); } catch (e) {}
            location.href = '/checkout';
          };
          card.hidden = false;
        }).catch(function () {});
      }
      renderSetDeal();

      window.addEventListener('currencychange', function () {
        if (document.getElementById('dashWishlistRows')) renderWishlist();
        if (document.getElementById('dashWishlistPreview')) renderWishlistPreview();
      });
      function wishCardClick(e) {
        var row = e.target.closest('.dash-prod, .dash-row'); if (!row) return;
        var id = row.getAttribute('data-id');
        var p = (window.__CATALOG || []).filter(function (x) { return x.id === id; })[0];
        if (e.target.closest('.wl-remove')) {
          saveWishIds(wishIds().filter(function (x) { return x !== id; }));
          renderWishlist();
          renderWishlistPreview();
          if (window.__wishSync) window.__wishSync(id, false);
        } else if ((e.target.closest('.wl-buy') || e.target.closest('.wl-add')) && wishIsOwned(id)) {
          pruneOwnedWishes(); renderWishlist(); renderWishlistPreview();
        } else if (e.target.closest('.wl-buy') && p) {
          if (window.__cartAdd) window.__cartAdd({ id: p.id, title: p.title, price: p.priceNum, image: p.image, tag: p.cat || '' });
          location.href = '/checkout';
        } else if (e.target.closest('.wl-add') && p) {
          if (window.__cartAdd) window.__cartAdd({ id: p.id, title: p.title, price: p.priceNum, image: p.image, tag: p.cat || '' });
          var btn = e.target.closest('.wl-add');
          var t = btn.textContent; btn.textContent = 'Added ✓'; btn.disabled = true;
          setTimeout(function () { btn.textContent = t; btn.disabled = false; }, 1400);
        }
      }
      var wishlistRows = document.getElementById('dashWishlistRows');
      if (wishlistRows) wishlistRows.addEventListener('click', wishCardClick);
      var wishlistPreview = document.getElementById('dashWishlistPreview');
      if (wishlistPreview) wishlistPreview.addEventListener('click', wishCardClick);

      // Real purchase/ownership data, read live from Supabase (RLS already
      // scopes orders/order_items to the signed-in user).
      function fmtDate(iso) {
        try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
        catch (e) { return iso; }
      }
      function shortOrderId(id) { return '#' + String(id).slice(0, 8).toUpperCase(); }
      // Shared in-button spinner treatment - reuses the .btn-label/
      // .btn-spinner/.is-loading pattern already used on the full-page
      // auth forms (see styles.css's generic .btn.is-loading rules).
      function setBtnLoading(btn, loading) {
        if (!btn) return;
        btn.disabled = loading;
        btn.classList.toggle('is-loading', loading);
        var spinner = btn.querySelector('.btn-spinner');
        if (spinner) spinner.hidden = !loading;
      }

      // A completed order's amount is a fixed historical fact, not a live
      // price - Robux orders show the real R$ total, never routed through
      // the flat window.__robux() conversion (matches the same fix applied
      // to cart/checkout/admin this session).
      // Robux orders already showed their real R$ total. USD orders did not:
      // they went through window.__money(), so the amount tracked whatever
      // currency the header toggle happened to be set to. Both now report
      // what was charged.
      function orderMoney(o) {
        if (o.currency === 'robux') {
          return 'R$ ' + Math.round(Number(o.total_robux) || 0).toLocaleString('en-US');
        }
        var usd = Number(o.total_usd) || 0;
        return '$' + usd.toFixed(2).replace(/\.00$/, '');
      }

      var PURCHASE_ROWS = [];
      function renderPurchases(orders, sentGiftOrders) {
        // Orders paid for as a gift for someone else don't match .eq('user_id',
        // userId) any more under the gifting RLS policy (orders.user_id is the
        // RECIPIENT, not the buyer) - merged in here from a second query so the
        // buyer can still see what they paid for, tagged distinctly from
        // "Gifted" below (that means "you received something for free"; this
        // means "you paid for someone else").
        PURCHASE_ROWS = orders.map(function (o) { return { order: o, sentAsGift: false }; })
          .concat((sentGiftOrders || []).map(function (o) { return { order: o, sentAsGift: true }; }))
          .sort(function (a, b) { return new Date(b.order.created_at) - new Date(a.order.created_at); });
        renderPurchasesTable();
      }
      function renderPurchasesTable() {
        var body = document.getElementById('dashPurchasesBody');
        if (!body) return;
        if (!PURCHASE_ROWS.length) { body.innerHTML = '<p class="dash-empty-note">No purchases yet.</p>'; return; }

        var q = ((document.getElementById('dashPurchSearch') || {}).value || '').trim().toLowerCase();
        var fromVal = (document.getElementById('dashPurchFrom') || {}).value || '';
        var toVal = (document.getElementById('dashPurchTo') || {}).value || '';
        var minAmt = parseFloat((document.getElementById('dashPurchMinAmt') || {}).value);
        var maxAmt = parseFloat((document.getElementById('dashPurchMaxAmt') || {}).value);
        var statusFilter = (document.getElementById('dashPurchStatus') || {}).value || 'all';
        var fromTs = fromVal ? new Date(fromVal + 'T00:00:00').getTime() : null;
        var toTs = toVal ? new Date(toVal + 'T23:59:59').getTime() : null;

        var rows = PURCHASE_ROWS.filter(function (r) {
          var o = r.order;
          var items = o.order_items || [];
          var titles = items.map(function (i) { return i.title; }).join(', ');
          var gifted = o.source === 'granted';
          var receivedAsGift = !gifted && !r.sentAsGift && !!o.purchased_by_user_id;
          var statusKey = r.sentAsGift ? 'sent' : (gifted || receivedAsGift) ? 'gifted' : 'paid';
          if (statusFilter !== 'all' && statusFilter !== statusKey) return false;
          if (q && titles.toLowerCase().indexOf(q) < 0 && o.id.toLowerCase().indexOf(q) < 0) return false;
          var ts = new Date(o.created_at).getTime();
          if (fromTs != null && ts < fromTs) return false;
          if (toTs != null && ts > toTs) return false;
          var amt = o.currency === 'robux' ? Number(o.total_robux) : Number(o.total_usd);
          if (Number.isFinite(minAmt) && amt < minAmt) return false;
          if (Number.isFinite(maxAmt) && amt > maxAmt) return false;
          return true;
        });

        if (!rows.length) { body.innerHTML = '<p class="dash-empty-note">No purchases match your filters.</p>'; return; }
        body.innerHTML = rows.map(function (r) {
          var o = r.order;
          var items = o.order_items || [];
          var first = items[0];
          var slug = first ? first.product_slug : '';
          var img = (first && first.products && first.products.image) ? window.imgUrl(first.products.image) : '/banner.jpg';
          var titles = esc(items.map(function (i) { return i.title; }).join(', ') || ' - ');
          // A manually-granted order (admin panel's "Manual product grant")
          // writes status:'paid' like any real purchase - correct for
          // download/ownership access, but "Paid" reads as if the customer
          // actually paid $0 for something, which is confusing on their own
          // order history. source:'granted' distinguishes it without
          // touching the real payment status underneath.
          var gifted = o.source === 'granted';
          // A real gift from another buyer (order.user_id is the recipient,
          // purchased_by_user_id is whoever actually paid) reads exactly
          // like a normal purchase otherwise - same "received it free"
          // framing/gift-number as an admin comp is correct here too.
          var receivedAsGift = !gifted && !r.sentAsGift && !!o.purchased_by_user_id;
          // A plain "Paid" pill is noise on a page that's already only
          // completed orders - only badge the ones that are actually
          // something other than a normal purchase.
          var special = r.sentAsGift || gifted || receivedAsGift || o.status !== 'paid';
          var badge = r.sentAsGift ? 'warn' : (gifted || receivedAsGift) ? 'info' : 'warn';
          var label = r.sentAsGift ? 'Sent as gift' : (gifted || receivedAsGift) ? 'Gifted' : (o.status.charAt(0).toUpperCase() + o.status.slice(1));
          // Support can tell at a glance from the id alone that this was
          // never a real charge to look up in Stripe/PayPal/etc - same
          // short id, just labeled for what it actually is.
          var idCell = (gifted || receivedAsGift) ? shortOrderId(o.id).replace('#', 'GIFT-') : shortOrderId(o.id);
          var actions = slug ? '<a class="btn btn-ghost dr-btn" href="/product/' + encodeURIComponent(slug) + '">' + window.msym('visibility') + 'View</a>' : '';
          if (slug && o.status === 'paid') {
            actions += '<button class="btn btn-ghost dr-btn dr-download" type="button" data-slug="' + slug + '">' + window.msym('download') + 'Download</button>' +
              '<a class="btn btn-ghost dr-btn" href="/product/' + encodeURIComponent(slug) + '?tab=reviews">' + window.msym('reviews') + 'Review</a>';
          }
          return '<div class="dash-row"><span class="dr-thumb" style="background-image:url(\'' + img + '\')"></span>' +
            '<div class="dr-main"><div class="dr-title">' + titles + '</div>' +
            '<div class="dr-sub">' + fmtDate(o.created_at) + ' · ' + idCell + (special ? ' · <span class="dt-badge ' + badge + '">' + label + '</span>' : '') + '</div></div>' +
            '<span class="p-price" data-fixed>' + orderMoney(o) + '</span>' +
            '<div class="dr-actions">' + actions + '</div></div>';
        }).join('');
      }
      ['dashPurchSearch', 'dashPurchFrom', 'dashPurchTo', 'dashPurchMinAmt', 'dashPurchMaxAmt', 'dashPurchStatus'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener(el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input', renderPurchasesTable);
      });
      var dashPurchClearBtn = document.getElementById('dashPurchClear');
      if (dashPurchClearBtn) dashPurchClearBtn.addEventListener('click', function () {
        // dispatch change (not just set .value) on the date/select fields so
        // their custom-button labels resync - __coldDate/__coldSelect both
        // listen on the native element, not on whoever changed .value.
        ['dashPurchSearch', 'dashPurchFrom', 'dashPurchTo', 'dashPurchMinAmt', 'dashPurchMaxAmt'].forEach(function (id) {
          var el = document.getElementById(id);
          if (!el || !el.value) return;
          el.value = '';
          if (el.type === 'date') el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        var statusEl = document.getElementById('dashPurchStatus');
        if (statusEl && statusEl.value !== 'all') { statusEl.value = 'all'; statusEl.dispatchEvent(new Event('change', { bubbles: true })); }
        renderPurchasesTable();
      });

      function renderOverview(orders) {
        var recentEl = document.getElementById('dashRecentPurchases');
        if (recentEl) {
          var recent = orders.slice(0, 3);
          recentEl.innerHTML = recent.length ? recent.map(function (o) {
            var items = o.order_items || [];
            var first = items[0];
            var slug = first ? first.product_slug : '';
            var img = (first && first.products && first.products.image) ? window.imgUrl(first.products.image) : '/banner.jpg';
            var titles = esc(items.map(function (i) { return i.title; }).join(', ') || ' - ');
            var actions = slug ? '<a class="btn btn-ghost dr-btn" href="/product/' + encodeURIComponent(slug) + '">' + window.msym('visibility') + 'View</a>' : '';
            if (slug && o.status === 'paid') {
              actions += '<button class="btn btn-ghost dr-btn dr-download" type="button" data-slug="' + slug + '">' + window.msym('download') + 'Download</button>' +
                '<a class="btn btn-ghost dr-btn" href="/product/' + encodeURIComponent(slug) + '?tab=reviews">' + window.msym('reviews') + 'Review</a>';
            }
            return '<div class="dash-row"><span class="dr-thumb" style="background-image:url(\'' + img + '\')"></span>' +
              '<div class="dr-main"><div class="dr-title">' + titles + '</div><div class="dr-sub">' + fmtDate(o.created_at) + ' · ' + shortOrderId(o.id) + '</div></div>' +
              '<span class="p-price" data-fixed>' + orderMoney(o) + '</span>' +
              '<div class="dr-actions">' + actions + '</div></div>';
          }).join('') : '<p class="dash-empty-note">No purchases yet.</p>';
        }

        var wishEl = document.getElementById('dashWishlistPreview');
        if (wishEl && typeof renderWishlistPreview === 'function') renderWishlistPreview();
      }

      function ownedFromOrders(orders) {
        var bySlug = {};
        orders.forEach(function (o) {
          if (o.status !== 'paid') return;
          (o.order_items || []).forEach(function (i) {
            var existing = bySlug[i.product_slug];
            if (!existing || i.licence === 'resell') bySlug[i.product_slug] = i;
          });
        });
        return Object.keys(bySlug).map(function (slug) { return bySlug[slug]; });
      }

      // Navigating straight to the signed URL put a raw
      // <project-ref>.supabase.co address in the tab/download manager for
      // whoever had just paid us - reads as a phishing link, not a coldd
      // download. Fetching it and saving the blob instead means the only
      // URL ever visible anywhere is a blob: one, which carries THIS
      // page's own coldd.dev origin, not the signed URL's real host.
      function triggerFileDownload(url, filename) {
        return fetch(url).then(function (res) {
          if (!res.ok) throw new Error('Download failed.');
          return res.blob();
        }).then(function (blob) {
          var objectUrl = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = objectUrl; a.download = filename || '';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 4000);
        });
      }
      function requestDownload(slug, btn) {
        // Swap only the label span's text when present (icon buttons like
        // .dp-btn), so a loading/error state doesn't wipe out the icon by
        // overwriting the whole button with textContent.
        var labelEl = btn.querySelector('span') || btn;
        var prev = labelEl.textContent;
        btn.disabled = true; labelEl.textContent = 'Preparing…';
        (window.coldAuth ? window.coldAuth.invokeFn('get-download-url', { slug: slug }) :
          window.coldSupabase.functions.invoke('get-download-url', { body: { slug: slug } }).then(function (res) {
            if (res.error || !res.data || !res.data.ok) throw new Error((res.data && res.data.error) || 'Unavailable');
            return res.data;
          }))
          .then(function (data) { return triggerFileDownload(data.url, data.filename); })
          .then(function () { btn.disabled = false; labelEl.textContent = prev; })
          .catch(function (err) { labelEl.textContent = (err && err.message) || 'Unavailable'; btn.disabled = false; });
      }
      var DOWNLOAD_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
      var RESELL_ICON_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
      function downloadBtn(item, cls) {
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = cls;
        btn.innerHTML = DOWNLOAD_ICON_SVG + '<span>Download</span>';
        btn.addEventListener('click', function () { requestDownload(item.product_slug, btn); });
        return btn;
      }

      var OWNED_ITEMS = [];
      function renderOwnedAndDownloads(orders) {
        OWNED_ITEMS = ownedFromOrders(orders);
        renderOwnedGrid();
      }
      function renderOwnedGrid() {
        var grid = document.getElementById('dashOwnedGrid');
        if (!grid) return;
        var q = ((document.getElementById('dashOwnedSearch') || {}).value || '').trim().toLowerCase();
        var owned = q ? OWNED_ITEMS.filter(function (i) { return i.title.toLowerCase().indexOf(q) >= 0; }) : OWNED_ITEMS;
        grid.innerHTML = '';
        if (!OWNED_ITEMS.length) {
          grid.innerHTML = '<div class="dash-empty-cta"><p>You don\'t own any products yet.</p>' +
            '<a class="btn btn-primary" href="/shop">Browse products</a></div>';
        } else if (!owned.length) {
          grid.innerHTML = '<p class="dash-empty-note">No licenses match "' + esc(q) + '".</p>';
        }
        else owned.forEach(function (item) {
          var img = item.products && item.products.image ? window.imgUrl(item.products.image) : '/banner.jpg';
          var isResell = item.licence === 'resell';
          var card = document.createElement('div'); card.className = 'dash-prod';
          card.innerHTML = '<div class="dp-thumb" style="background-image:url(\'' + img + '\')">' +
            (isResell ? '<span class="dp-lic-badge" aria-label="Resell licence">' + RESELL_ICON_SVG + '<span aria-hidden="true">Resell</span></span>' : '<span class="sr-only">Standard licence</span>') +
            '</div><div class="dp-body"><div class="dp-name"></div><div class="dp-actions"></div></div>';
          card.querySelector('.dp-name').textContent = item.title;
          var actions = card.querySelector('.dp-actions');
          actions.appendChild(downloadBtn(item, 'btn btn-tinted dp-btn'));
          var reviewLink = document.createElement('a');
          reviewLink.className = 'btn btn-tinted dp-btn dp-review-btn';
          reviewLink.href = '/product/' + encodeURIComponent(item.product_slug) + '?tab=reviews';
          reviewLink.innerHTML = window.msym('reviews', 15) + '<span>Review</span>';
          actions.appendChild(reviewLink);
          grid.appendChild(card);
        });
      }
      var dashOwnedSearchEl = document.getElementById('dashOwnedSearch');
      if (dashOwnedSearchEl) dashOwnedSearchEl.addEventListener('input', renderOwnedGrid);

      ['dashRecentPurchases', 'dashPurchasesBody'].forEach(function (elId) {
        var el = document.getElementById(elId);
        if (!el) return;
        el.addEventListener('click', function (e) {
          var btn = e.target.closest('.dr-download');
          if (!btn) return;
          requestDownload(btn.getAttribute('data-slug'), btn);
        });
      });

      function loadRealData(userId) {
        var ORDER_COLS = 'id, created_at, status, source, purchased_by_user_id, currency, total_usd, total_robux, order_items(product_slug, title, qty, licence, products(image))';
        Promise.all([
          window.coldSupabase.from('orders').select(ORDER_COLS).eq('user_id', userId).order('created_at', { ascending: false }),
          // Gift orders paid for by this user, but owned by whoever they were
          // gifted to (orders.user_id is the recipient) - RLS lets this user
          // see them via purchased_by_user_id, but the primary query above
          // never will. Purchase-history-only; deliberately not merged into
          // owned/recent-purchases since this user doesn't own these.
          window.coldSupabase.from('orders').select(ORDER_COLS).eq('purchased_by_user_id', userId).order('created_at', { ascending: false }),
        ]).then(function (results) {
          // Purchase history should show purchases, not attempts. Every
          // status short of 'paid' - abandoned Stripe/PayPal checkouts,
          // still-confirming crypto/Robux, failed, canceled - is not a
          // purchase yet, so none of it belongs here even briefly.
          var orders = ((results[0] && results[0].data) || []).filter(function (o) { return o.status === 'paid'; });
          var sentGiftOrders = ((results[1] && results[1].data) || []).filter(function (o) { return o.status === 'paid'; });
          renderOverview(orders);
          renderPurchases(orders, sentGiftOrders);
          renderOwnedAndDownloads(orders);
          // Reveal the Seller profile tab straight away if any paid order
          // holds a resell licence, rather than waiting on the separate
          // reseller-profile fetch.
          var hasResell = orders.some(function (o) {
            return (o.order_items || []).some(function (i) { return i.licence === 'resell'; });
          });
          if (hasResell && typeof window.__revealSellerTab === 'function') window.__revealSellerTab();
        });
      }

      // Authoritative session check - redirects if the fast <head> pre-check
      // let a stale/expired token slip through, and drives all real-data
      // rendering above once we know who's signed in.
      if (window.coldSupabase) {
        window.coldSupabase.auth.getSession().then(function (res) {
          var session = res && res.data ? res.data.session : null;
          if (!session) {
            // A stale coldd_auth="in" flag (session expired without ever
            // signing out through this tab) is what caused the loop here:
            // signin's own <head> pre-check reads that same flag and
            // bounces straight back to /dashboard before this authoritative
            // check even runs there, so the two pages redirected to each
            // other forever. Clearing it (and the cached profile) before
            // leaving is what makes signin's pre-check agree there's no
            // session, same as an explicit sign-out would.
            (window.coldAuth ? window.coldAuth.signOut() : Promise.resolve()).then(function () {
              try { sessionStorage.setItem('coldd_bounce', String(Date.now())); } catch (e) {}
              location.href = '/signin';
            });
            return;
          }
          loadRealData(session.user.id);
          loadNotificationPrefs(session.user.id);
          // The cached local profile (localStorage) can have a blank email
          // for accounts that signed up via Roblox (which has no real email
          // to hand us at sign-in time) - the session's user.email is always
          // the real, current value, so it wins here.
          var acEmailEl = document.getElementById('ac-email');
          if (acEmailEl && session.user.email) acEmailEl.value = session.user.email;
        });
      }

      var NTF_DEFAULTS = { orderReceipts: true, productUpdates: true, promotions: true, saleDms: true, roleSync: true, supportReplies: true, inAppSales: true, inAppProductUpdates: true };
      var NTF_IDS = { orderReceipts: 'ntfOrderReceipts', productUpdates: 'ntfProductUpdates', promotions: 'ntfPromotions', saleDms: 'ntfSaleDms', roleSync: 'ntfRoleSync', supportReplies: 'ntfSupportReplies', inAppSales: 'ntfInAppSales', inAppProductUpdates: 'ntfInAppProductUpdates' };
      function loadNotificationPrefs(userId) {
        window.coldSupabase.from('profiles').select('notification_prefs').eq('id', userId).maybeSingle().then(function (res) {
          var prefs = Object.assign({}, NTF_DEFAULTS, (res && res.data && res.data.notification_prefs) || {});
          Object.keys(NTF_IDS).forEach(function (key) {
            var el = document.getElementById(NTF_IDS[key]);
            if (el) el.checked = !!prefs[key];
          });
        });
      }
      var ntfSaveBtn = document.getElementById('ntfSaveBtn');
      if (ntfSaveBtn) ntfSaveBtn.addEventListener('click', function () {
        var msgEl = document.getElementById('ntfMsg');
        window.coldSupabase.auth.getSession().then(function (res) {
          var session = res && res.data ? res.data.session : null;
          if (!session) return;
          var prefs = {};
          Object.keys(NTF_IDS).forEach(function (key) {
            var el = document.getElementById(NTF_IDS[key]);
            prefs[key] = el ? el.checked : NTF_DEFAULTS[key];
          });
          setBtnLoading(ntfSaveBtn, true);
          window.coldSupabase.from('profiles').update({ notification_prefs: prefs }).eq('id', session.user.id).then(function (upRes) {
            setBtnLoading(ntfSaveBtn, false);
            if (msgEl) { msgEl.className = upRes.error ? 'co-msg err show' : 'co-msg show'; msgEl.textContent = upRes.error ? (upRes.error.message || 'Could not save.') : 'Saved.'; }
          });
        });
      });

      var robloxStatusEl = document.getElementById('robloxLinkStatus');
      var robloxLinkBtn = document.getElementById('robloxLinkBtn');
      var robloxUnlinkBtn = document.getElementById('robloxUnlinkBtn');
      if (robloxStatusEl && window.coldAuth && window.coldSupabase) {
        window.coldAuth.robloxLinkStatus().then(function (res) {
          if (res && res.ok && res.linked) {
            robloxStatusEl.textContent = 'Linked as ' + res.robloxUsername + '.';
            if (robloxUnlinkBtn) robloxUnlinkBtn.hidden = false;
          } else {
            robloxStatusEl.textContent = 'Not linked yet. Link your Roblox account to pay with Robux.';
            if (robloxLinkBtn) robloxLinkBtn.hidden = false;
          }
        }).catch(function () {
          robloxStatusEl.textContent = 'Could not check Roblox link status.';
        });
      }
      if (robloxLinkBtn) robloxLinkBtn.addEventListener('click', function () { window.coldAuth.signInRoblox(); });
      if (robloxUnlinkBtn) robloxUnlinkBtn.addEventListener('click', function () {
        robloxUnlinkBtn.disabled = true;
        window.coldAuth.unlinkRoblox().then(function () {
          robloxUnlinkBtn.hidden = true;
          if (robloxLinkBtn) robloxLinkBtn.hidden = false;
          if (robloxStatusEl) robloxStatusEl.textContent = 'Not linked yet. Link your Roblox account to pay with Robux.';
        }).finally(function () { robloxUnlinkBtn.disabled = false; });
      });

      var refStats = null;
      var refLoaded = false;
      function refFmtUsd(n) { return window.__money ? window.__money(n) : ('$' + n); }
      function refFmtRobux(n) { return 'R$ ' + n; }
      function refFmtDate(iso) {
        try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
        catch (e) { return iso; }
      }
      function refEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
      function refreshReferrals() {
        if (refLoaded || !window.coldAuth) return;
        refLoaded = true;
        window.coldAuth.invokeFn('get-referral-stats', {}).then(function (res) {
          refStats = res;
          var earnedEl = document.getElementById('refStatEarned');
          if (earnedEl) earnedEl.textContent = refFmtUsd(res.earnedUsd);
          var availEl = document.getElementById('refStatAvailable');
          if (availEl) availEl.textContent = refFmtUsd(res.availableUsd);
          var paidEl = document.getElementById('refStatPaid');
          if (paidEl) paidEl.textContent = refFmtUsd(res.paidUsd);

          var actBody = document.getElementById('refActivityBody');
          if (actBody) {
            var rows = res.recentSales || [];
            actBody.innerHTML = rows.length ? rows.map(function (r) {
              return '<tr><td>' + refEsc(r.product) + '</td><td>' + refFmtDate(r.date) + '</td><td>' + refFmtUsd(r.earned) + '</td></tr>';
            }).join('') : '<tr><td colspan="3" class="adm-empty">No referral sales yet.</td></tr>';
          }

          var payBody = document.getElementById('refPayoutBody');
          if (payBody) {
            var payouts = res.payouts || [];
            payBody.innerHTML = payouts.length ? payouts.map(function (p) {
              var amount = p.method === 'robux' ? refFmtRobux(p.amount_robux || 0) : refFmtUsd(p.amount_usd || 0);
              var status = p.status === 'paid' ? '<span class="dt-badge ok">Paid</span>' : p.status === 'denied' ? '<span class="dt-badge err">Denied</span>' : '<span class="dt-badge warn">Requested</span>';
              var method = p.method === 'usd' ? 'USD' : p.method === 'robux' ? 'Robux' : 'Store credit';
              return '<tr><td>' + refFmtDate(p.requested_at) + '</td><td>' + method + '</td><td>' + amount + '</td><td>' + status + '</td></tr>';
            }).join('') : '<tr><td colspan="4" class="adm-empty">No payout requests yet.</td></tr>';
          }
        }).catch(function () {
          refLoaded = false;
        });
      }

      (function () {
        var dd = document.querySelector('.ref-method-dd');
        if (!dd) return;
        var native = dd.querySelector('.ref-method-native');
        var btn = dd.querySelector('.ref-method-btn');
        var val = dd.querySelector('.ref-method-val');
        var menu = dd.querySelector('.ref-method-menu');
        var opts = Array.prototype.slice.call(dd.querySelectorAll('.ref-method-opt'));
        function close() { dd.classList.remove('open'); menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
        function open() { dd.classList.add('open'); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); window.__coldMenuFit && window.__coldMenuFit(menu, dd); }
        function select(opt) {
          native.value = opt.getAttribute('data-value');
          val.textContent = opt.querySelector('span').textContent;
          opts.forEach(function (o) {
            var active = o === opt;
            o.classList.toggle('active', active);
            o.setAttribute('aria-selected', active ? 'true' : 'false');
          });
        }
        btn.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden ? open() : close(); });
        opts.forEach(function (o) { o.addEventListener('click', function () { select(o); close(); btn.focus(); }); });
        document.addEventListener('click', function (e) { if (!dd.contains(e.target)) close(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      })();

      var refPayoutForm = document.getElementById('refPayoutForm');
      if (refPayoutForm) refPayoutForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var msgEl = refPayoutForm.querySelector('.auth-msg');
        var btn = refPayoutForm.querySelector('.auth-submit');
        var method = document.getElementById('refPayoutMethod').value;
        var amount = parseFloat(document.getElementById('refPayoutAmount').value);
        if (!amount || amount <= 0) return;
        setBtnLoading(btn, true);
        window.coldAuth.invokeFn('request-referral-payout', { method: method, amount: amount }).then(function () {
          setBtnLoading(btn, false);
          if (msgEl) { msgEl.className = 'auth-msg ok show'; msgEl.textContent = 'Payout requested - our team will review it manually.'; }
          refPayoutForm.reset();
          refLoaded = false;
          refreshReferrals();
        }).catch(function (err) {
          setBtnLoading(btn, false);
          if (msgEl) { msgEl.className = 'auth-msg show'; msgEl.textContent = (err && err.message) || 'Could not request payout.'; }
        });
      });

      var refProdBody = document.getElementById('refProdBody');
      if (refProdBody) {
        var fmt = function (n) { return window.__money ? window.__money(n) : ('$' + n); };
        var refProdSearch = document.getElementById('refProdSearch');
        var refProdCatSel = document.getElementById('refProdCat');
        var refCode = null;

        // Populated straight from window.__CATALOG (catalog.js has already
        // resolved by the time app.js runs - see catalog.js's data-then
        // chain), not a fixed slice of it, so a product added, renamed or
        // retired later shows up here with no further changes. Category
        // options are collected from whatever's actually in the catalog
        // right now rather than a hardcoded list, for the same reason.
        var allProducts = (window.__CATALOG || []).slice().sort(function (a, b) { return a.title.localeCompare(b.title); });
        if (refProdCatSel) {
          var cats = [];
          allProducts.forEach(function (p) { if (p.cat && cats.indexOf(p.cat) < 0) cats.push(p.cat); });
          cats.sort();
          refProdCatSel.innerHTML = '<option value="all">All categories</option>' +
            cats.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
          // __coldSelect enhances data-csel selects once, at page load, off
          // whatever options they had then (just "All categories" - the
          // catalog wasn't necessarily in yet). Options just changed, so the
          // built dropdown from that first pass is stale - tear it down and
          // let __coldSelect build a fresh one off the real category list.
          if (refProdCatSel.__csel) {
            var staleWrap = refProdCatSel.nextElementSibling;
            if (staleWrap && staleWrap.classList.contains('csel')) staleWrap.remove();
            refProdCatSel.__csel = false;
            refProdCatSel.classList.remove('csel-native');
          }
          if (window.__coldSelect) window.__coldSelect(refProdCatSel);
        }

        function renderProdRows() {
          var q = (refProdSearch && refProdSearch.value || '').trim().toLowerCase();
          var wantCat = (refProdCatSel && refProdCatSel.value) || 'all';
          var rows = allProducts.filter(function (p) {
            if (wantCat !== 'all' && p.cat !== wantCat) return false;
            if (q && p.title.toLowerCase().indexOf(q) < 0) return false;
            return true;
          });
          if (!rows.length) { refProdBody.innerHTML = '<p class="dash-empty-note">No products match your search.</p>'; return; }
          if (!refCode) { refProdBody.innerHTML = '<p class="dash-empty-note">Loading…</p>'; return; }
          refProdBody.innerHTML = rows.map(function (p) {
            var earn = Math.round(p.priceNum * 0.2 * 100) / 100;
            var link = (p.page || '/product') + '/' + p.id + '?ref=' + encodeURIComponent(refCode);
            return '<div class="dash-row"><span class="dr-thumb" style="background-image:url(\'' + esc(p.image) + '\')"></span>' +
              '<div class="dr-main"><div class="dr-title">' + esc(p.title) + '</div>' +
              '<div class="dr-sub">' + esc(p.cat || '') + (p.cat ? ' · ' : '') + 'Earn ' + fmt(earn) + ' per sale</div></div>' +
              '<div class="dr-actions"><button class="btn btn-primary ref-prod-copy" type="button" data-link="' + esc(link) + '">Copy link</button></div></div>';
          }).join('');
          refProdBody.querySelectorAll('.ref-prod-copy').forEach(function (b) {
            b.addEventListener('click', function () {
              var link = location.origin + b.getAttribute('data-link');
              try { navigator.clipboard.writeText(link); } catch (_) {}
              var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1400);
            });
          });
        }

        if (refProdSearch) refProdSearch.addEventListener('input', renderProdRows);
        if (refProdCatSel) refProdCatSel.addEventListener('change', renderProdRows);

        renderProdRows();
        // Real sales/earnings for these links live in the "Referral sales"
        // table below (get-referral-stats), keyed off orders.ref_product_slug
        // - this list is just each link plus its flat "Earn per sale" rate
        // (20% of the product's own price).
        window.coldAuth.invokeFn('get-referral-code', {}).then(function (r) {
          refCode = r && r.code;
          renderProdRows();
        }).catch(function () {});
      }

      dash.querySelectorAll('.wl-remove').forEach(function (x) {
        x.addEventListener('click', function () { var row = x.closest('.dash-row'); if (row) row.remove(); });
      });
      dash.querySelectorAll('.dr-cart').forEach(function (b) {
        b.addEventListener('click', function () { var t = b.textContent; b.textContent = 'Added ✓'; b.disabled = true; setTimeout(function () { b.textContent = t; b.disabled = false; }, 1400); });
      });

      var acct = document.getElementById('acctForm');
      if (acct) {
        function acctFieldErr(name, msg) {
          var f = acct.querySelector('.auth-field[data-for="' + name + '"]'); if (!f) return;
          f.classList.toggle('invalid', !!msg);
          var e = f.querySelector('.auth-err'); if (e) e.textContent = msg || '';
        }
        function acctFlash(text, ok) {
          var m = acct.querySelector('.auth-msg'); if (!m) return;
          m.textContent = text; m.className = 'auth-msg show' + (ok ? ' ok' : '');
        }

        // Email/password now only change via the Security tab's
        // re-auth-gated flow; this form is display-name only.
        acct.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!window.coldSupabase || !window.coldAuth) { acctFlash('Not available right now.'); return; }
          var profile = window.coldAuth.getProfile();
          var newName = acct.querySelector('[name="name"]').value.trim();
          if (!profile || !newName || newName === profile.name) { acctFlash('Nothing to update.'); return; }

          var btn = acct.querySelector('.auth-submit');
          setBtnLoading(btn, true);
          window.coldSupabase.from('profiles').update({ username: newName }).eq('id', profile.id).then(function (res) {
            setBtnLoading(btn, false);
            if (res.error) { acctFlash(res.error.message || 'Something went wrong.'); return; }
            profile.name = newName;
            window.coldAuth.saveProfile(profile);
            window.coldAuth.applyProfile();
            acctFlash('Saved.', true);
          });
        });
      }
      var acAvatarBtn = document.getElementById('acAvatarBtn'), acAvatarInput = document.getElementById('acAvatarInput'),
          acAvatarRemove = document.getElementById('acAvatarRemove'), acAvatarMsg = document.getElementById('acAvatarMsg');
      function acAvatarFlash(text, ok) {
        if (!acAvatarMsg) return;
        acAvatarMsg.className = 'auth-msg show' + (ok ? ' ok' : '');
        acAvatarMsg.textContent = text;
      }
      if (acAvatarBtn && acAvatarInput) {
        acAvatarBtn.addEventListener('click', function () { acAvatarInput.click(); });
        acAvatarInput.addEventListener('change', function () {
          var file = acAvatarInput.files && acAvatarInput.files[0];
          acAvatarInput.value = '';
          if (!file || !window.coldSupabase || !window.coldAuth) return;
          if (file.size > 5 * 1024 * 1024) { acAvatarFlash('Image must be under 5MB.'); return; }
          setBtnLoading(acAvatarBtn, true);
          window.coldAuth.invokeFn('get-avatar-upload-url', { contentType: file.type }).then(function (d) {
            var put;
            if (d.driver === 'cdn') {
              var fd = new FormData();
              fd.append('file', file);
              put = fetch(d.uploadUrl, { method: 'POST', body: fd }).then(function (r) {
                return r.json().catch(function () { return {}; }).then(function (j) {
                  if (!r.ok || !j.ok) throw new Error(j.error || 'Upload failed (' + r.status + ').');
                });
              }, function () { throw new Error('Image storage is temporarily unavailable. Please try again shortly.'); });
            } else {
              put = window.coldSupabase.storage.from(d.bucket).uploadToSignedUrl(d.path, d.token, file).then(function (upRes) {
                if (upRes.error) throw new Error(upRes.error.message || 'Upload failed.');
              });
            }
            return put.then(function () {
              // Same fixed path every time (get-avatar-upload-url overwrites
              // in place), so a browser/CDN cache from the last upload would
              // otherwise keep showing the old picture - the query string
              // busts it without needing a new path per upload.
              var url = d.publicUrl + '?t=' + Date.now();
              return window.coldSupabase.from('profiles').update({ avatar_url: url }).eq('id', window.coldAuth.getProfile().id);
            });
          }).then(function (res) {
            setBtnLoading(acAvatarBtn, false);
            if (res && res.error) { acAvatarFlash(res.error.message || 'Could not save.'); return; }
            window.coldAuth.applyProfile();
            acAvatarFlash('Saved.', true);
          }).catch(function (err) {
            setBtnLoading(acAvatarBtn, false);
            acAvatarFlash(err.message || 'Could not upload that image.');
          });
        });
      }
      if (acAvatarRemove) acAvatarRemove.addEventListener('click', function () {
        if (!window.coldSupabase || !window.coldAuth) return;
        var profile = window.coldAuth.getProfile();
        if (!profile) return;
        setBtnLoading(acAvatarRemove, true);
        window.coldSupabase.from('profiles').update({ avatar_url: null }).eq('id', profile.id).then(function (res) {
          setBtnLoading(acAvatarRemove, false);
          if (res.error) { acAvatarFlash(res.error.message || 'Could not save.'); return; }
          window.coldAuth.applyProfile();
          acAvatarFlash('Removed.', true);
        });
      });

      acct && acct.querySelectorAll('.auth-pw-toggle').forEach(function (b) {
        b.addEventListener('click', function () {
          var input = b.parentNode.querySelector('input'); if (!input) return;
          var show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          var off = b.querySelector('.eye-off'), on = b.querySelector('.eye-on');
          if (off && on) { off.style.display = show ? 'none' : ''; on.style.display = show ? '' : 'none'; }
        });
      });

      var del = document.getElementById('delAcct'), conf = document.getElementById('delConfirm');
      if (del && conf) {
        var delCodeEl = document.getElementById('delCode');
        var delCode = '';
        function genDeleteCode() {
          var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
          var groups = [];
          for (var g = 0; g < 4; g++) {
            var s = '';
            for (var i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
            groups.push(s);
          }
          return groups.join('-');
        }
        function showDeleteCode() {
          delCode = genDeleteCode();
          if (delCodeEl) delCodeEl.textContent = delCode;
        }
        del.addEventListener('click', function () {
          showDeleteCode();
          conf.hidden = false; del.style.display = 'none';
        });
        // Self-serve data export (GDPR Art. 15/20). Runs entirely under the
        // signed-in user's own session, so row-level security is what limits
        // it to their rows - no service-role function involved. A table the
        // user can't read (or that doesn't exist for them) is listed under
        // not_included instead of failing the whole download.
        var exportBtn = document.getElementById('exportData'), exportErr = document.getElementById('exportErr');
        if (exportBtn) exportBtn.addEventListener('click', function () {
          if (!window.coldSupabase) return;
          if (exportErr) exportErr.textContent = '';
          setBtnLoading(exportBtn, true);
          window.coldSupabase.auth.getUser().then(function (ur) {
            var user = ur && ur.data ? ur.data.user : null;
            if (!user) throw new Error('Please sign in again to download your data.');
            var uid = user.id;
            var sources = [
              ['profile', 'profiles', '*', 'id'],
              ['orders', 'orders', '*, order_items(*)', 'user_id'],
              ['orders_you_paid_for', 'orders', '*, order_items(*)', 'purchased_by_user_id'],
              ['reviews', 'reviews', '*', 'user_id'],
              ['wishlist', 'wishlist_items', '*', 'user_id'],
              ['notifications', 'notifications', '*', 'user_id']
            ];
            return Promise.all(sources.map(function (src) {
              return window.coldSupabase.from(src[1]).select(src[2]).eq(src[3], uid).then(function (r) {
                return { key: src[0], data: r.error ? null : (r.data || []), failed: !!r.error };
              }, function () { return { key: src[0], data: null, failed: true }; });
            })).then(function (parts) {
              var out = {
                exported_at: new Date().toISOString(),
                account: {
                  id: uid, email: user.email || null, created_at: user.created_at || null,
                  last_sign_in_at: user.last_sign_in_at || null,
                  sign_in_providers: (user.identities || []).map(function (i) { return i.provider; })
                },
                not_included: []
              };
              parts.forEach(function (p) {
                if (p.failed) out.not_included.push(p.key); else out[p.key] = p.data;
              });
              var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a');
              a.href = url; a.download = 'coldd-my-data-' + new Date().toISOString().slice(0, 10) + '.json';
              document.body.appendChild(a); a.click(); a.remove();
              setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
              setBtnLoading(exportBtn, false);
              if (exportErr) exportErr.textContent = out.not_included.length ? 'Downloaded. Some sections could not be read: ' + out.not_included.join(', ') + '. Email support@coldd.dev for a full copy.' : 'Downloaded.';
            });
          }).catch(function (err) {
            setBtnLoading(exportBtn, false);
            if (exportErr) exportErr.textContent = (err && err.message) || 'Could not prepare your data.';
          });
        });
        var cancel = document.getElementById('delCancel');
        if (cancel) cancel.addEventListener('click', function () { conf.hidden = true; del.style.display = ''; });
        var fin = document.getElementById('delFinal'), inp = document.getElementById('delInput'), delErr = document.getElementById('delErr');
        // Copy-pasting defeats the point of "type this out" - block paste
        // on the input outright, on top of user-select:none on the code
        // itself and the disabled right-click menu.
        if (inp) inp.addEventListener('paste', function (e) { e.preventDefault(); });
        if (fin) fin.addEventListener('click', function () {
          var typed = inp ? inp.value.trim() : '';
          if (typed !== delCode) {
            if (delErr) delErr.textContent = 'That doesn’t match the code above.';
            if (inp) { inp.style.borderColor = 'var(--accent)'; inp.focus(); }
            return;
          }
          if (delErr) delErr.textContent = '';
          if (!window.coldAuth) return;
          setBtnLoading(fin, true);
          window.coldAuth.invokeFn('delete-account', {}).then(function () {
            return (window.coldAuth ? window.coldAuth.signOut() : Promise.resolve()).then(function () { location.href = '/'; });
          }).catch(function (err) {
            setBtnLoading(fin, false);
            if (delErr) delErr.textContent = err.message || 'Could not delete your account.';
          });
        });
      }

      // ================================================================
      // SECURITY TAB - re-auth gate (password, falls back to email OTP),
      // email change, password change modal.
      // ================================================================
      function currentUser(cb) {
        window.coldSupabase.auth.getUser().then(function (res) { cb(res && res.data ? res.data.user : null); });
      }
      function evalPwStrength(v, fillEl, listEl) {
        var rules = { upper: /[A-Z]/.test(v), lower: /[a-z]/.test(v), number: /[0-9]/.test(v), special: /[^A-Za-z0-9]/.test(v), length: v.length > 8 };
        var met = 0;
        Object.keys(rules).forEach(function (k) {
          var li = listEl.querySelector('[data-rule="' + k + '"]');
          if (li) li.classList.toggle('met', rules[k]);
          if (rules[k]) met++;
        });
        fillEl.style.width = (met / 5 * 100) + '%';
        fillEl.style.background = met <= 2 ? '#ff4d44' : met <= 4 ? '#ffb020' : '#7ee08a';
        return met === 5;
      }

      /* The Security panel used to sit behind a "Verify identity" gate that
         re-ran whichever provider the account signed up with. It protected
         nothing: changing the password already requires the current password,
         and changing the email already requires confirming from the new
         inbox. All the gate did was add a round trip - and, for a Discord or
         Roblox account, a full OAuth bounce - before showing a form that
         re-checks credentials anyway. */
      function loadSecurity() {
        currentUser(function (user) {
          var curEl = document.getElementById('secEmailCurrent');
          if (!curEl) return;
          var placeholder = user && window.coldAuth && window.coldAuth.isPlaceholderEmail(user.email);
          curEl.textContent = !user ? '' : placeholder
            ? 'No email on this account yet - set one up under Account Settings.'
            : ('Current email: ' + (user.email || ' - '));
          // The change-email form below sends a code to the CURRENT email,
          // which for a Roblox account is an undeliverable address - hide it
          // and point to the claim flow instead.
          var s1 = document.getElementById('secEmailStep1');
          if (s1) s1.hidden = !!placeholder;
        });
        if (typeof renderLinkedAccounts === 'function') renderLinkedAccounts();
      }

      var acTabs = document.getElementById('acTabs');
      if (acTabs) acTabs.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-actab]'); if (!btn) return;
        var name = btn.getAttribute('data-actab');
        acTabs.querySelectorAll('.pd-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
        document.querySelectorAll('.ac-tabpanel').forEach(function (p) {
          p.hidden = p.getAttribute('data-actabpanel') !== name;
        });
      });

      // Seller profile tab - only shown to a buyer who holds a resell
      // licence. Mirrors the post-purchase onboarding popup: email/discord
      // contact, repeatable platform+link selling locations, notes. Backed
      // by the reseller-profile edge function (keeps every resellers row for
      // this buyer in sync).
      (function () {
        var tab = document.getElementById('acSellerTab');
        var form = document.getElementById('acSellerForm');
        var licBox = document.getElementById('acSellerLicenses');
        if (!tab || !form) return;
        var contactInput = document.getElementById('acSellerContact');
        var contactLabel = form.querySelector('.rs-field label');
        var locWrap = document.getElementById('acSellerLocations');
        var notesEl = document.getElementById('acSellerNotes');
        var msgEl = document.getElementById('acSellerMsg');
        var saveBtn = document.getElementById('acSellerSave');
        var switchEl = document.getElementById('acSellerContactSwitch');
        var contactType = 'email';
        var loaded = false;

        window.__revealSellerTab = function () { tab.hidden = false; };

        function setMsg(t, ok) { if (!msgEl) return; msgEl.textContent = t || ''; msgEl.classList.toggle('ok', !!ok); }
        function applyContactType(t) {
          contactType = t === 'discord' ? 'discord' : 'email';
          switchEl.querySelectorAll('.bt-opt').forEach(function (o) {
            var on = o.getAttribute('data-ctype') === contactType;
            o.classList.toggle('active', on); o.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          contactInput.type = contactType === 'email' ? 'email' : 'text';
          contactInput.placeholder = contactType === 'email' ? 'you@example.com' : 'Your Discord username or server invite';
        }
        switchEl.addEventListener('click', function (e) {
          var b = e.target.closest('.bt-opt'); if (!b) return;
          applyContactType(b.getAttribute('data-ctype'));
          contactInput.value = '';
          if (contactLabel) contactLabel.textContent = 'Contact method';
          var h = form.querySelector('.rs-prefill-note'); if (h) h.remove();
        });

        // Pre-fill from a linked email / Discord identity when the seller
        // hasn't saved anything yet.
        function prefillContact(linked) {
          var lt = linked.email ? 'email' : (linked.discord ? 'discord' : null);
          if (!lt) { applyContactType('email'); return; }
          applyContactType(lt);
          contactInput.value = linked.email || linked.discord;
          if (contactLabel) contactLabel.textContent = 'Is this contact method right?';
          if (!form.querySelector('.rs-prefill-note')) {
            var h = document.createElement('p');
            h.className = 'rs-prefill-note';
            h.textContent = 'Pre-filled from your linked ' + (lt === 'email' ? 'email' : 'Discord') + '. Confirm it by saving, or edit it if you sell under a different contact.';
            contactInput.parentNode.appendChild(h);
          }
        }

        function locRows() { return Array.prototype.slice.call(locWrap.querySelectorAll('.rs-loc-row')); }
        function syncRemove() { var rows = locRows(); rows.forEach(function (r) { var x = r.querySelector('.rs-loc-x'); if (x) x.disabled = rows.length <= 1; }); }
        function addLocRow(platform, url) {
          var row = document.createElement('div');
          row.className = 'rs-loc-row';
          row.innerHTML =
            '<input type="text" class="rs-input rs-loc-platform" autocomplete="off" placeholder="Platform (eg: BuiltByBit, ClearlyDev, Discord)" />' +
            '<input type="url" class="rs-input rs-loc-url" autocomplete="off" placeholder="Link to your store / profile" />' +
            '<button type="button" class="rs-loc-x" aria-label="Remove location"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
          if (platform) row.querySelector('.rs-loc-platform').value = platform;
          if (url) row.querySelector('.rs-loc-url').value = url;
          row.querySelector('.rs-loc-x').addEventListener('click', function () {
            if (locRows().length <= 1) return; row.remove(); syncRemove();
          });
          locWrap.appendChild(row); syncRemove();
        }
        var addLocBtn = document.getElementById('acSellerAddLoc');
        if (addLocBtn) addLocBtn.addEventListener('click', function () { addLocRow(); });

        function renderLicenses(list) {
          if (!licBox) return;
          if (!list || !list.length) { licBox.innerHTML = '<p class="dash-empty-note">No resell licences found.</p>'; return; }
          licBox.innerHTML = list.map(function (l) {
            var cat = (window.__CATALOG || []).filter(function (c) { return c.id === l.slug; })[0];
            var img = (cat && cat.image) ? cat.image : '/banner.jpg';
            var since = l.createdAt ? (typeof fmtDate === 'function' ? fmtDate(l.createdAt) : new Date(l.createdAt).toLocaleDateString()) : '';
            return '<div class="dash-row">' +
              '<span class="dr-thumb" style="background-image:url(\'' + img + '\')"></span>' +
              '<div class="dr-main"><div class="dr-title">' + esc(l.title) + '</div>' +
              '<div class="dr-sub">Resell licence' + (since ? ' · Since ' + since : '') + '</div></div>' +
              '<div class="dr-actions"><a class="btn btn-ghost dr-btn" href="/product/' + encodeURIComponent(l.slug) + '">' + (window.msym ? window.msym('visibility') : '') + 'View</a></div></div>';
          }).join('');
        }

        function initSellerProfile() {
          if (!window.coldSupabase) return;
          window.coldSupabase.functions.invoke('reseller-profile', { body: { action: 'get' } }).then(function (res) {
            var d = res && res.data;
            if (!d || !d.ok) { tab.hidden = true; return; }
            tab.hidden = false;
            renderLicenses(d.licenses);
            if (loaded) return;
            loaded = true;
            var p = d.profile;
            if (p) {
              applyContactType(p.contactType);
              contactInput.value = p.contactValue || '';
              notesEl.value = p.notes || '';
              locWrap.innerHTML = '';
              var locs = (p.sellingLocations || []).filter(function (l) { return l && (l.platform || l.url); });
              if (locs.length) locs.forEach(function (l) { addLocRow(l.platform, l.url); });
              else { addLocRow(); addLocRow(); addLocRow(); }
            } else {
              prefillContact((d.account) || {});
              addLocRow(); addLocRow(); addLocRow();
            }
          }).catch(function () { tab.hidden = true; });
        }
        window.__initSellerProfile = initSellerProfile;

        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var contactValue = contactInput.value.trim();
          if (!contactValue) { setMsg(contactType === 'email' ? 'Enter a contact email.' : 'Enter your Discord.'); return; }
          var locations = [], bad = false;
          locRows().forEach(function (r) {
            var pl = r.querySelector('.rs-loc-platform').value.trim();
            var u = r.querySelector('.rs-loc-url').value.trim();
            if (!pl && !u) return;
            if (!pl || !u) bad = true; else locations.push({ platform: pl, url: u });
          });
          if (bad) { setMsg('Every selling location needs both a platform and a link.'); return; }
          if (!locations.length) { setMsg('Add at least one place you sell, with a link.'); return; }
          saveBtn.disabled = true; setMsg('');
          window.coldSupabase.functions.invoke('reseller-profile', { body: {
            action: 'update', contactType: contactType, contactValue: contactValue,
            sellingLocations: locations, notes: notesEl.value.trim() || null
          } }).then(function (res) {
            saveBtn.disabled = false;
            var d = res && res.data;
            if (!d || !d.ok) { setMsg((d && d.error) || 'Could not save.'); return; }
            setMsg('Saved.', true);
          }).catch(function () { saveBtn.disabled = false; setMsg('Could not save.'); });
        });
      })();

      // Changing the email is now a two-step, code-gated flow: request a
      // code (sent to the CURRENT email, proving whoever's here actually
      // controls this account) and verify it before the real
      // auth.updateUser() call ever fires - that call still triggers
      // Supabase's own confirm-link to the NEW address on top of this, so
      // an email change now needs proof of both ends, not just whichever
      // browser happens to be signed in.
      var secEmailStep1 = document.getElementById('secEmailStep1');
      var secEmailStep2 = document.getElementById('secEmailStep2');
      var pendingNewEmail = null;
      if (secEmailStep1) secEmailStep1.addEventListener('submit', function (e) {
        e.preventDefault();
        var newEmail = document.getElementById('sec-email').value.trim();
        var msgEl = secEmailStep1.querySelector('.auth-msg');
        var btn = secEmailStep1.querySelector('button[type="submit"]');
        if (!newEmail || !window.coldAuth) return;
        setBtnLoading(btn, true);
        window.coldAuth.requestEmailOtp().then(function (res) {
          setBtnLoading(btn, false);
          if (res.error) {
            if (msgEl) { msgEl.classList.add('show'); msgEl.textContent = (res.data && res.data.error) || res.error.message || 'Could not send a code.'; }
            return;
          }
          pendingNewEmail = newEmail;
          secEmailStep1.hidden = true;
          if (secEmailStep2) { secEmailStep2.hidden = false; secEmailStep2.querySelector('.auth-msg').classList.remove('show'); }
        }).catch(function () {
          setBtnLoading(btn, false);
          if (msgEl) { msgEl.classList.add('show'); msgEl.textContent = 'Could not send a code.'; }
        });
      });
      if (secEmailStep2) secEmailStep2.addEventListener('submit', function (e) {
        e.preventDefault();
        var code = document.getElementById('sec-email-code').value.trim();
        var msgEl = secEmailStep2.querySelector('.auth-msg');
        var btn = secEmailStep2.querySelector('button[type="submit"]');
        if (!code || !pendingNewEmail || !window.coldAuth) return;
        setBtnLoading(btn, true);
        window.coldAuth.verifyEmailOtp(code).then(function (res) {
          if (res.error || !res.data || !res.data.ok) {
            setBtnLoading(btn, false);
            if (msgEl) { msgEl.classList.add('show'); msgEl.textContent = (res.data && res.data.error) || 'Incorrect or expired code.'; }
            return;
          }
          window.coldSupabase.auth.updateUser({ email: pendingNewEmail }).then(function (ures) {
            setBtnLoading(btn, false);
            if (!msgEl) return;
            msgEl.classList.add('show');
            if (ures.error) { msgEl.textContent = ures.error.message || 'Could not update email.'; return; }
            msgEl.textContent = 'Verified - check your new email to confirm the change. It will not take effect until then.';
            pendingNewEmail = null;
            secEmailStep2.reset();
            secEmailStep2.hidden = true;
            secEmailStep1.hidden = false;
            secEmailStep1.reset();
          });
        }).catch(function () {
          setBtnLoading(btn, false);
          if (msgEl) { msgEl.classList.add('show'); msgEl.textContent = 'Something went wrong. Please try again.'; }
        });
      });
      var secEmailCancel = document.getElementById('secEmailCancel');
      if (secEmailCancel) secEmailCancel.addEventListener('click', function () {
        pendingNewEmail = null;
        if (secEmailStep2) secEmailStep2.hidden = true;
        if (secEmailStep1) secEmailStep1.hidden = false;
      });

      var pwModalOverlay = document.getElementById('pwModalOverlay');
      var openPwModalBtn = document.getElementById('openPwModalBtn');
      if (openPwModalBtn && pwModalOverlay) openPwModalBtn.addEventListener('click', function () { pwModalOverlay.hidden = false; });
      var pwModalCancel = document.getElementById('pwModalCancel');
      if (pwModalCancel && pwModalOverlay) pwModalCancel.addEventListener('click', function () { pwModalOverlay.hidden = true; });
      if (pwModalOverlay) pwModalOverlay.addEventListener('click', function (e) { if (e.target === pwModalOverlay) pwModalOverlay.hidden = true; });

      var pwNewInput = document.getElementById('pw-new');
      var pwModalFill = document.getElementById('pwModalFill');
      var pwModalList = document.getElementById('pwModalChecklist');
      var pwModalBox = document.getElementById('pwModalStrength');
      if (pwNewInput && pwModalFill && pwModalList && pwModalBox) {
        pwNewInput.addEventListener('input', function () { pwModalBox.classList.add('open'); evalPwStrength(pwNewInput.value, pwModalFill, pwModalList); });
        pwNewInput.addEventListener('focus', function () { if (pwNewInput.value) pwModalBox.classList.add('open'); });
      }

      var pwChangeForm = document.getElementById('pwChangeForm');
      if (pwChangeForm) pwChangeForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var current = document.getElementById('pw-current').value;
        var next = document.getElementById('pw-new').value;
        var confirmVal = document.getElementById('pw-confirm').value;
        var msgEl = pwChangeForm.querySelector('.auth-msg');
        function fieldErr(name, msg) {
          var f = pwChangeForm.querySelector('.auth-field[data-for="' + name + '"]'); if (!f) return;
          f.classList.toggle('invalid', !!msg);
          var e2 = f.querySelector('.auth-err'); if (e2) e2.textContent = msg || '';
        }
        fieldErr('current', ''); fieldErr('new', ''); fieldErr('confirm', '');
        if (!current) { fieldErr('current', 'Enter your current password.'); return; }
        if (!evalPwStrength(next, pwModalFill, pwModalList)) { fieldErr('new', 'Password does not meet all requirements.'); return; }
        if (next !== confirmVal) { fieldErr('confirm', 'Passwords do not match.'); return; }

        var btn = pwChangeForm.querySelector('button[type="submit"]');
        setBtnLoading(btn, true);
        currentUser(function (user) {
          if (!user || !user.email) { setBtnLoading(btn, false); fieldErr('current', 'Could not verify.'); return; }
          window.coldSupabase.auth.signInWithPassword({ email: user.email, password: current }).then(function (res) {
            if (res.error) { setBtnLoading(btn, false); fieldErr('current', 'Incorrect current password.'); return; }
            window.coldSupabase.auth.updateUser({ password: next }).then(function (res2) {
              setBtnLoading(btn, false);
              if (res2.error) { if (msgEl) { msgEl.classList.add('show'); msgEl.textContent = res2.error.message || 'Could not update password.'; } return; }
              pwChangeForm.reset();
              pwModalBox.classList.remove('open');
              if (msgEl) { msgEl.classList.add('show'); msgEl.textContent = 'Password updated.'; }
              setTimeout(function () { pwModalOverlay.hidden = true; if (msgEl) msgEl.classList.remove('show'); }, 1200);
            });
          });
        });
      });

      // ================================================================
      // LINKED ACCOUNTS - link/unlink the providers an account can carry.
      // ================================================================
      function renderLinkedAccounts() {
        currentUser(function (user) {
          if (!user) return;
          var identities = user.identities || [];
          var placeholder = window.coldAuth && window.coldAuth.isPlaceholderEmail(user.email);
          // An 'email' identity exists for Roblox sign-ups too (createUser
          // takes an email), but a synthetic @roblox.coldd.internal address
          // isn't a usable, recoverable login - treat only a real one as set.
          var hasRealEmail = identities.some(function (i) { return i.provider === 'email'; }) && !placeholder;
          var discordIdentity = identities.filter(function (i) { return i.provider === 'discord'; })[0];
          document.getElementById('linkedEmailStatus').textContent = hasRealEmail ? 'Set - used to sign in' : 'Not set';
          var emailBtn = document.getElementById('linkedEmailBtn');
          if (emailBtn) {
            emailBtn.hidden = hasRealEmail;
            emailBtn.textContent = 'Set up';
          }

          var googleIdentity = identities.filter(function (i) { return i.provider === 'google'; })[0];
          var baseCount = (hasRealEmail ? 1 : 0) + (discordIdentity ? 1 : 0) + (googleIdentity ? 1 : 0);
          window.coldAuth.robloxLinkStatus().then(function (rres) {
            var robloxLinked = !!(rres && rres.linked);
            var totalMethods = baseCount + (robloxLinked ? 1 : 0);
            var errEl = document.getElementById('linkedErr');

            // linkIdentity() needs "Manual linking" enabled on the Supabase
            // project (Authentication -> Providers). With it off, every Link
            // button fails with a raw API string that reads like a site bug
            // rather than a setting the operator has to flip.
            function linkErr(err, provider) {
              var raw = (err && (err.message || err.msg)) || '';
              if (/manual linking is disabled/i.test(raw)) {
                return 'Linking accounts is currently turned off. Please contact support.';
              }
              return raw || ('Could not link ' + provider + '.');
            }

            // Same "Linked as X" treatment Roblox already had - Discord and
            // Google just said "Linked" with no account name, inconsistent
            // with Roblox right below it for no reason.
            function identityName(identity) {
              var d = (identity && identity.identity_data) || {};
              return (d.custom_claims && d.custom_claims.global_name) || d.full_name || d.name || d.user_name || d.email || '';
            }

            var dBtn = document.getElementById('linkedDiscordBtn');
            var discordName = identityName(discordIdentity);
            document.getElementById('linkedDiscordStatus').textContent = discordIdentity ? ('Linked as ' + (discordName || '…')) : 'Not linked';
            dBtn.textContent = discordIdentity ? 'Unlink' : 'Link';
            dBtn.disabled = !!(discordIdentity && totalMethods <= 1);
            dBtn.title = (discordIdentity && totalMethods <= 1) ? 'This is your only sign-in method' : '';
            dBtn.onclick = async function () {
              if (errEl) errEl.textContent = '';
              if (discordIdentity) {
                if (totalMethods <= 1) return;
                if (!(await window.coldDialog.confirm('Remove your Discord sign-in method from this account?', { title: 'Unlink Discord', acceptLabel: 'Unlink Discord' }))) return;
                dBtn.disabled = true;
                window.coldSupabase.auth.unlinkIdentity(discordIdentity).then(function (ures) {
                  if (errEl) errEl.textContent = ures.error ? (ures.error.message || 'Could not unlink.') : '';
                  renderLinkedAccounts();
                }).catch(function (err) {
                  dBtn.disabled = false;
                  if (errEl) errEl.textContent = (err && err.message) || 'Could not unlink Discord.';
                });
              } else {
                dBtn.disabled = true;
                window.coldSupabase.auth.linkIdentity({ provider: 'discord', options: { redirectTo: location.origin + '/dashboard?panel=account' } }).then(function (lres) {
                  dBtn.disabled = false;
                  if (lres && lres.error && errEl) errEl.textContent = linkErr(lres.error, 'Discord');
                }).catch(function (err) {
                  dBtn.disabled = false;
                  if (errEl) errEl.textContent = linkErr(err, 'Discord');
                });
              }
            };

            var gBtn = document.getElementById('linkedGoogleBtn');
            if (gBtn) {
              var googleName = identityName(googleIdentity);
              document.getElementById('linkedGoogleStatus').textContent = googleIdentity ? ('Linked as ' + (googleName || '…')) : 'Not linked';
              gBtn.textContent = googleIdentity ? 'Unlink' : 'Link';
              gBtn.disabled = !!(googleIdentity && totalMethods <= 1);
              gBtn.title = (googleIdentity && totalMethods <= 1) ? 'This is your only sign-in method' : '';
              gBtn.onclick = async function () {
                if (errEl) errEl.textContent = '';
                if (googleIdentity) {
                  if (totalMethods <= 1) return;
                  if (!(await window.coldDialog.confirm('Remove your Google sign-in method from this account?', { title: 'Unlink Google', acceptLabel: 'Unlink Google' }))) return;
                  gBtn.disabled = true;
                  window.coldSupabase.auth.unlinkIdentity(googleIdentity).then(function (ures) {
                    if (errEl) errEl.textContent = ures.error ? (ures.error.message || 'Could not unlink.') : '';
                    renderLinkedAccounts();
                  }).catch(function (err) {
                    gBtn.disabled = false;
                    if (errEl) errEl.textContent = (err && err.message) || 'Could not unlink Google.';
                  });
                } else {
                  gBtn.disabled = true;
                  window.coldSupabase.auth.linkIdentity({ provider: 'google', options: { redirectTo: location.origin + '/dashboard?panel=account' } }).then(function (lres) {
                    gBtn.disabled = false;
                    if (lres && lres.error && errEl) errEl.textContent = linkErr(lres.error, 'Google');
                  }).catch(function (err) {
                    gBtn.disabled = false;
                    if (errEl) errEl.textContent = linkErr(err, 'Google');
                  });
                }
              };
            }

            var rBtn = document.getElementById('linkedRobloxBtn');
            document.getElementById('linkedRobloxStatus').textContent = robloxLinked ? ('Linked as ' + (rres.robloxUsername || '')) : 'Not linked';
            rBtn.textContent = robloxLinked ? 'Unlink' : 'Link';
            rBtn.disabled = !!(robloxLinked && totalMethods <= 1);
            rBtn.title = (robloxLinked && totalMethods <= 1) ? 'This is your only sign-in method' : '';
            rBtn.onclick = async function () {
              if (errEl) errEl.textContent = '';
              if (robloxLinked) {
                if (totalMethods <= 1) return;
                if (!(await window.coldDialog.confirm('Remove your Roblox sign-in method from this account?', { title: 'Unlink Roblox', acceptLabel: 'Unlink Roblox' }))) return;
                rBtn.disabled = true;
                window.coldAuth.unlinkRoblox().then(function (ures) {
                  rBtn.disabled = false;
                  if (ures && ures.ok === false && errEl) { errEl.textContent = ures.error || 'Could not unlink Roblox.'; return; }
                  renderLinkedAccounts();
                }).catch(function (err) {
                  rBtn.disabled = false;
                  if (errEl) errEl.textContent = (err && err.message) || 'Could not unlink Roblox.';
                });
              } else {
                window.coldAuth.signInRoblox('/dashboard?panel=account');
              }
            };
          });
        });
      }

      // ================================================================
      // CLAIM ACCOUNT - add a real email + password to a Roblox-first
      // account. The banner is dismissible (per browser); the form under
      // Account Settings > Linked accounts is always available.
      // ================================================================
      (function () {
        var CLAIM_DISMISS_KEY = 'coldd_claim_banner_dismissed';
        var banner = document.getElementById('dashClaimBanner');
        var form = document.getElementById('claimForm');
        var btn = document.getElementById('linkedEmailBtn');
        if (!form) return;
        var step1 = document.getElementById('claimStep1');
        var step2 = document.getElementById('claimStep2');
        var emailIn = document.getElementById('claim-email');
        var codeIn = document.getElementById('claim-code');
        var pwIn = document.getElementById('claim-password');
        var msg = document.getElementById('claimMsg');
        var sendBtn = document.getElementById('claimSendBtn');
        var verifyBtn = document.getElementById('claimVerifyBtn');
        var backBtn = document.getElementById('claimBackBtn');
        var pendingEmail = null;

        function say(t, ok) { if (msg) { msg.textContent = t || ''; msg.classList.toggle('show', !!t); msg.classList.toggle('ok', !!ok); } }
        function reset() {
          step1.hidden = false; step2.hidden = true; pendingEmail = null;
          if (codeIn) codeIn.value = ''; if (pwIn) pwIn.value = '';
          say('');
        }
        function openForm() {
          form.hidden = false; reset();
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (emailIn) emailIn.focus();
        }

        if (btn) btn.addEventListener('click', function () { form.hidden ? openForm() : (form.hidden = true); });
        if (backBtn) backBtn.addEventListener('click', reset);

        if (sendBtn) sendBtn.addEventListener('click', function () {
          var email = (emailIn.value || '').trim();
          if (!email || !window.coldAuth) { say('Enter an email address.'); return; }
          setBtnLoading(sendBtn, true); say('');
          window.coldAuth.claimSend(email).then(function (res) {
            setBtnLoading(sendBtn, false);
            if (res.error || !res.data || !res.data.ok) { say((res.data && res.data.error) || 'Could not send a code.'); return; }
            pendingEmail = email;
            var echo = document.getElementById('claimEmailEcho'); if (echo) echo.textContent = email;
            step1.hidden = true; step2.hidden = false;
            if (codeIn) codeIn.focus();
          }).catch(function () { setBtnLoading(sendBtn, false); say('Could not send a code.'); });
        });

        if (verifyBtn) verifyBtn.addEventListener('click', function () {
          var code = (codeIn.value || '').trim();
          var pw = pwIn.value || '';
          if (!code) { say('Enter the code from your email.'); return; }
          if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) { say('Password needs at least 8 characters, a letter and a number.'); return; }
          setBtnLoading(verifyBtn, true); say('');
          window.coldAuth.claimVerify(pendingEmail, code, pw).then(function (res) {
            setBtnLoading(verifyBtn, false);
            if (res.error || !res.data || !res.data.ok) { say((res.data && res.data.error) || 'Could not finish setup.'); return; }
            // Marketing opt-in from the claim form - now that there's a real
            // email on the account. source:'signup' is consent-only (no
            // discount code). Fire-and-forget, must not block the flow.
            var mkt = document.getElementById('claim-marketing');
            if (mkt && mkt.checked && pendingEmail && window.coldSupabase) {
              try { window.coldSupabase.functions.invoke('marketing-signup', { body: { email: pendingEmail, source: 'signup' } }).catch(function () {}); } catch (e) {}
            }
            say('Done - your email and password are set. You can now sign in with them.', true);
            try { localStorage.setItem(CLAIM_DISMISS_KEY, '1'); } catch (e) {}
            if (banner) banner.hidden = true;
            setTimeout(function () { form.hidden = true; if (typeof renderLinkedAccounts === 'function') renderLinkedAccounts(); if (typeof loadSecurity === 'function') loadSecurity(); }, 1600);
          }).catch(function () { setBtnLoading(verifyBtn, false); say('Could not finish setup.'); });
        });

        // Banner: show only for accounts that still need to claim, and only
        // if not already dismissed in this browser.
        if (banner && window.coldAuth && window.coldAuth.needsClaim) {
          var dismissed = false;
          try { dismissed = localStorage.getItem(CLAIM_DISMISS_KEY) === '1'; } catch (e) {}
          if (!dismissed) window.coldAuth.needsClaim().then(function (needs) { if (needs) banner.hidden = false; });
          var goBtn = document.getElementById('dashClaimBannerGo');
          var xBtn = document.getElementById('dashClaimBannerX');
          if (goBtn) goBtn.addEventListener('click', function () {
            var navLink = document.querySelector('.dash-nav [data-panel="account"]');
            if (navLink) navLink.click();
            var acTab = document.querySelector('#acTabs [data-actab="account"]'); if (acTab) acTab.click();
            setTimeout(openForm, 150);
          });
          if (xBtn) xBtn.addEventListener('click', function () {
            try { localStorage.setItem(CLAIM_DISMISS_KEY, '1'); } catch (e) {}
            banner.hidden = true;
          });
        }
      })();

      var so = document.getElementById('dashSignout');
      var soOverlay = document.getElementById('signoutOverlay');
      var soCancel = document.getElementById('signoutCancel');
      var soConfirm = document.getElementById('signoutConfirm');
      if (so && soOverlay) so.addEventListener('click', function () { soOverlay.hidden = false; });
      if (soCancel) soCancel.addEventListener('click', function () { soOverlay.hidden = true; });
      if (soOverlay) soOverlay.addEventListener('click', function (e) { if (e.target === soOverlay) soOverlay.hidden = true; });
      if (soConfirm) soConfirm.addEventListener('click', function () {
        soOverlay.hidden = true;
        setState(false);
        (window.coldAuth ? window.coldAuth.signOut() : Promise.resolve()).then(function () {
          if (window.__go) window.__go('home'); else location.href = '/';
        });
      });
    })();

    (function () {
      var root = document.querySelector('.checkout');
      window.__goCheckout = function () {
        if (root) { cart = load(); render(); }
        if (window.__go) window.__go('checkout'); else location.href = '/checkout';
      };
      if (!root) return;

      var CART_KEY = 'coldd_cart_v1';
      var money = function (n) { return window.__money ? window.__money(n) : ('$' + n); };
      // Forced fiat, ignoring the Robux display toggle - `money()` (=__money)
      // flat-converts USD to R$ at 80:1 whenever the top-of-page currency is
      // set to Robux, which is wrong for the checkout summary: a card/PayPal/
      // crypto charge settles in USD, and the flat 80:1 figure isn't even the
      // product's real robux_price. So when robuxView() is false the summary
      // prints this instead.
      var fiatMoney = function (n) { return window.__fiat ? window.__fiat(n) : (window.__money ? window.__money(n) : ('$' + n)); };
      // Robux figures in the order summary only make sense while the buyer is
      // actually paying in Robux. With a real-money method selected (card /
      // PayPal / crypto - the default is card), R$ prices sitting next to a
      // charge that settles in USD just read as a mismatch, so the summary,
      // subtotal, line prices, tier ladder and resell prices all fall back
      // to fiatMoney() then. `payMethod` is declared later in this IIFE but
      // only read here after render() first runs, by which point it is set.
      // The checkout is one specific transaction in one currency: the
      // selected payment method's. Robux method -> R$ (each product's real
      // robux_price). Card / PayPal / crypto -> fiat, full stop. The
      // top-of-page currency switcher is only a browsing preference and is
      // used just as the pre-selection default before a method is chosen
      // (payMethod is 'stripe' from load, so in practice the method always
      // decides). This replaced a split where the summary lines followed
      // one rule and the tier ladder / upsell another, which let a
      // Robux-toggle + card checkout show "R$ 960" on the line, "R$ 1" on
      // the Robux row, and a Robux tier ladder all at once.
      function robuxCheckout() {
        if (payMethod) return payMethod === 'robux';
        return !!(window.__currencyMode && window.__currencyMode() === 'robux');
      }
      var robuxView = robuxCheckout;
      var robuxPricing = robuxCheckout;
      // Digital licences aren't a quantity - forced to 1 here too so a cart
      // saved by an older version of this file (back when the drawer's
      // +/- stepper existed) can't still check out at qty > 1.
      function load() {
        try {
          var raw = localStorage.getItem(CART_KEY) || '[]';
          var c = (window.__coldRepriceCart ? window.__coldRepriceCart(JSON.parse(raw) || []) : (JSON.parse(raw) || [])).map(function (i) { i.qty = 1; return i; });
          if (JSON.stringify(c) !== raw) { try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch (e) {} }
          return c;
        } catch (e) { return []; }
      }
      function save(c) {
        try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch (e) {}
        scheduleCartSnapshot();
        try { window.dispatchEvent(new CustomEvent('coldd:cart-sync', { detail: { source: 'checkout' } })); } catch (e) {}
      }
      var cart = load();
      // Funnel: reaching the checkout page with a non-empty cart. Fires
      // once per page load; the paid step is the orders table.
      if (cart.length && window.coldTrack) window.coldTrack('checkout_started', { value: subtotal() });
      // Same fix as the cart drawer (app.js's other IIFE): if the drawer
      // (or any other cart instance on this page) changes the cart, reload
      // from localStorage and re-render so this page never builds the
      // create-checkout-session payload from a stale snapshot.
      window.addEventListener('coldd:cart-sync', function (e) {
        if (e.detail && e.detail.source === 'checkout') return;
        cart = load();
        render();
      });

      // Abandoned-cart tracking for the admin panel - debounced so typing/
      // adjusting quantities doesn't spam the backend. Reuses the same
      // per-browser-session id catalog.js's pageview beacon already sets.
      var cartSnapshotTimer = null;
      function cartSessionId() {
        try {
          var sid = sessionStorage.getItem('coldd_session_id');
          if (!sid) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('coldd_session_id', sid); }
          return sid;
        } catch (e) { return null; }
      }
      function scheduleCartSnapshot() {
        if (!window.coldAuth) return;
        // The snapshot exists for abandoned-cart follow-up in the admin panel,
        // not to make the visitor's own cart work - that is pure localStorage.
        // So it is analytics, and waits for consent.
        if (!window.coldConsent || !window.coldConsent.allows('analytics')) return;
        clearTimeout(cartSnapshotTimer);
        cartSnapshotTimer = setTimeout(function () {
          var sid = cartSessionId(); if (!sid) return;
          var items = cart.map(function (i) { return { title: i.title, image: i.image, qty: i.qty, price: i.price }; });
          window.coldAuth.invokeFn('save-cart-snapshot', { sessionId: sid, items: items, valueUsd: subtotal() }).catch(function () {});
        }, 1500);
      }
      function deleteCartSnapshot() {
        var sid = cartSessionId(); if (!sid || !window.coldAuth) return;
        window.coldAuth.invokeFn('delete-cart-snapshot', { sessionId: sid }).catch(function () {});
      }

      var itemsEl = document.getElementById('coItems'), emptyEl = document.getElementById('coEmpty');

      function subtotal() { return cart.reduce(function (s, i) { return s + i.price * i.qty; }, 0); }

      // Same fix as the cart drawer (app.js's other IIFE): don't
      // estimate Robux with a flat 80-per-$1 conversion - use each
      // product's real admin-configured robux_price when set. Resell
      // licences ARE priced in Robux now (resell_robux_price, else the
      // resell USD price flat-converted) - matches _shared/roblox.ts's
      // robuxUnitPrice(product, true) and priceRobuxItems(items, true).
      // ROBUX_PER_USD_FALLBACK is `var`-scoped per IIFE (see app.js's other
      // one), so it has to be declared again here rather than shared -
      // without this line, any cart item missing a real robux_price threw
      // a ReferenceError the moment renderPayAmounts hit the fallback
      // branch below.
      var ROBUX_PER_USD_FALLBACK = 80; // matches _shared/roblox.ts's ROBUX_PER_USD
      function catalogRobuxPrice(id, licence) {
        var raw = String(id);
        var baseId = raw.replace(/--resell$/, '').replace(/--bundle$/, '');
        var isResell = licence === 'resell' || /--resell$/.test(raw);
        var p = (window.__CATALOG || []).filter(function (c) { return c.id === baseId; })[0];
        if (!p) return null;
        if (isResell) {
          // Never null for resell: it's always buyable in Robux now.
          if (p.resellRobuxPrice > 0) return p.resellRobuxPrice;
          var usd = p.resellPrice != null ? p.resellPrice : p.priceNum * 3;
          return Math.round(usd * ROBUX_PER_USD_FALLBACK);
        }
        // > 0, not != null: a stored robux_price of 0 is bad data, not an
        // intentional free-in-Robux price - falls back to the flat
        // estimate instead of quoting R$0 for a product that costs real
        // money, and instead of failing the whole Robux order (server
        // rejects a total <= 0) if that were the only item in the cart.
        return p.robuxPrice > 0 ? p.robuxPrice : null;
      }
      function lineMoney(item) {
        if (robuxView() && !(window.__robuxOff && window.__robuxOff(item.id))) {
          var rbx = catalogRobuxPrice(item.id, item.licence);
          if (rbx != null) return 'R$ ' + Math.round(rbx * item.qty).toLocaleString('en-US');
        }
        return fiatMoney(item.price * item.qty);
      }
      // Raw number, not a display string - shared by subtotalMoney() below,
      // the tier ladder, and renderTotals()'s discount/total math. Falls
      // back to the flat rate per item without a real robux_price override,
      // same as create-robux-order's priceRobuxItems does server-side -
      // this used to bail to null (silently swapping the whole subtotal
      // display back to USD) the moment even ONE item lacked an override,
      // even though the server always has a real total to charge either way.
      function robuxSubtotalRaw() {
        var total = 0;
        cart.forEach(function (i) {
          var rbx = catalogRobuxPrice(i.id, i.licence);
          if (rbx == null) rbx = Math.round(i.price * ROBUX_PER_USD_FALLBACK);
          total += rbx * i.qty;
        });
        return total;
      }
      function subtotalMoney() {
        if (robuxView()) {
          var rbxTotal = robuxSubtotalRaw();
          if (rbxTotal != null) return 'R$ ' + Math.round(rbxTotal).toLocaleString('en-US');
        }
        return fiatMoney(subtotal());
      }

      function cartToItems() {
        return cart.map(function (i) {
          var licence = i.id.indexOf('--resell') !== -1 ? 'resell' : 'standard';
          var slug = i.crossSellSlug || i.id.replace(/--resell$/, '').replace(/--bundle$/, '').replace(/--crosssell$/, '');
          var out = { slug: slug, qty: i.qty, licence: licence };
          // Tells priceItems (server-side, floor-checked) to apply the
          // cross-sell discount to this specific line - the client-shown
          // price above is a preview, this flag is what actually makes it
          // real at checkout.
          if (i.crossSellSlug) out.crossSell = true;
          return out;
        });
      }

      // { code, discountUsd } once a code has been validated server-side via
      // validate-coupon - never computed client-side, so what's shown here
      // always matches what create-checkout-session actually charges.
      var appliedCoupon = null;
      // Must match _shared/coupon.ts's SPEND_TIERS exactly - this is a
      // client preview only (the real, floor-respecting amount is computed
      // server-side the instant the order is actually created, same as a
      // coupon), but the numbers themselves need to agree or the banner
      // below promises a discount the order won't actually give.
      var SPEND_TIERS = [
        { minSubtotal: 200, minRobux: 50000, pct: 50 },
        { minSubtotal: 100, minRobux: 26000, pct: 40 },
        { minSubtotal: 75, minRobux: 20000, pct: 30 },
        { minSubtotal: 50, minRobux: 13000, pct: 20 },
        { minSubtotal: 30, minRobux: 8000, pct: 10 }
      ];
      function currentSpendTier(sub) {
        for (var i = 0; i < SPEND_TIERS.length; i++) { if (sub >= SPEND_TIERS[i].minSubtotal) return SPEND_TIERS[i]; }
        return null;
      }
      function nextSpendTier(sub) {
        var next = null;
        for (var i = 0; i < SPEND_TIERS.length; i++) {
          var t = SPEND_TIERS[i];
          if (sub < t.minSubtotal && (!next || t.minSubtotal < next.minSubtotal)) next = t;
        }
        return next;
      }
      // The live sale event's discount on this cart (scoped % of the
      // in-scope list subtotal). Preview only - the server recomputes it
      // floor-safe and folds it into the same combined clamp as the coupon
      // and spend tier (_shared/coupon.ts saleEventDiscount).
      function catForCartItem(id) {
        var base = String(id).replace(/--resell$/, '').replace(/--bundle$/, '').replace(/--crosssell$/, '');
        return (window.__CATALOG || []).filter(function (c) { return c.id === base; })[0] || null;
      }
      function saleEventDiscountUsd() {
        var s = window.__saleEvent && window.__saleEvent();
        if (!s) return 0;
        var scoped = cart.reduce(function (sum, i) {
          return window.__saleCovers(catForCartItem(i.id), s) ? sum + i.price * i.qty : sum;
        }, 0);
        return Math.round(scoped * (s.pct / 100) * 100) / 100;
      }
      function computeDiscount() {
        var sub = subtotal();
        var d = appliedCoupon ? appliedCoupon.discountUsd : 0;
        d += saleEventDiscountUsd();
        var tier = currentSpendTier(sub);
        if (tier) d += Math.round(sub * (tier.pct / 100) * 100) / 100;
        return Math.min(d, sub);
      }
      // Mirrors create-robux-order's own combination exactly: the coupon
      // (USD-basis, floor-checked) is applied to the Robux total as the
      // same proportion of the USD subtotal it discounts, THEN the
      // spend-tier discount is evaluated and applied directly in Robux
      // terms against what's left. finalTotal is computed first and
      // discount derived FROM it (never the reverse) so Subtotal minus
      // Discount always equals Total exactly - the two used to be rounded
      // independently (-R$ discount from one expression, Total from a
      // different one), which could disagree by a Robux or two.
      function computeRobuxDiscount(rbxSub) {
        var sub = subtotal();
        // Coupon + sale event are both USD-basis; converted onto the Robux
        // total as the same proportion of the USD subtotal they take off,
        // exactly as create-robux-order does server-side.
        var usdReduction = (appliedCoupon ? appliedCoupon.discountUsd : 0) + saleEventDiscountUsd();
        var afterUsd = rbxSub;
        if (usdReduction > 0 && sub > 0) {
          afterUsd = Math.round(rbxSub * (1 - usdReduction / sub));
        }
        var descending = SPEND_TIERS.slice().sort(function (a, b) { return b.minRobux - a.minRobux; });
        var tierPct = 0;
        for (var i = 0; i < descending.length; i++) {
          if (afterUsd >= descending[i].minRobux) { tierPct = descending[i].pct; break; }
        }
        var finalTotal = Math.max(0, afterUsd - Math.round(afterUsd * (tierPct / 100)));
        return { finalTotal: finalTotal, discount: rbxSub - finalTotal, tierPct: tierPct };
      }
      // Same gap-closing pick as the cart drawer - the cheapest catalog
      // item not already in the cart whose price alone covers the
      // remaining distance to the next tier.
      function cheapestGapCloser(remaining, useRobux) {
        var cat = window.__CATALOG || [];
        var cartIds = {};
        cart.forEach(function (i) { cartIds[i.id.replace(/--resell$/, '').replace(/--bundle$/, '').replace(/--crosssell$/, '')] = true; });
        // The gap itself, and every candidate's price, both have to be in
        // whatever unit the ladder is actually comparing against right now
        // (see renderTierProgress's useRobux) - a Robux gap searched
        // against USD list prices would filter and sort against numbers
        // from two different scales entirely.
        function priceOf(p) {
          if (!useRobux) return p.priceNum;
          var rbx = catalogRobuxPrice(p.id);
          return rbx != null ? rbx : Math.round(p.priceNum * ROBUX_PER_USD_FALLBACK);
        }
        var candidates = cat.filter(function (p) { return !cartIds[p.id] && priceOf(p) >= remaining; });
        candidates.sort(function (a, b) { return priceOf(a) - priceOf(b); });
        var pick = candidates[0] || null;
        if (pick) pick = Object.assign({}, pick, { gapPrice: priceOf(pick) });
        return pick;
      }
      function renderTierBanner() {
        var box = document.getElementById('coTierBanner');
        if (!box) return;
        // Robux orders don't grant this discount off USD list value - a
        // product's real admin-set robux_price often has no fixed ratio
        // to its USD price, so evaluating against USD while a Robux
        // shopper stares at their real, much smaller Robux total produced
        // exactly the "10% unlocked, my order is 1R$" confusion this was
        // built to prevent. Paying in Robux now evaluates (and the server
        // now grants - see spendTierDiscountRobux) against the REAL Robux
        // total against Robux-equivalent thresholds instead, so this
        // preview can never promise a discount the order doesn't actually
        // give, or vice versa.
        var useRobux = robuxPricing() && cart.length > 0;
        var sub = useRobux ? robuxSubtotalRaw() : subtotal();
        var res = window.__coldTierLadder.build(sub, {
          tiers: SPEND_TIERS,
          thresholdFor: function (t) { return useRobux ? t.minRobux : t.minSubtotal; },
          fmt: function (n) { return useRobux ? ('R$ ' + Math.round(n).toLocaleString('en-US')) : fiatMoney(n); },
          fmtThreshold: function (n) { return useRobux ? ('R$ ' + (n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : Math.round(n))) : ('$' + Math.round(n)); }
        });
        box.classList.toggle('co-tier-unlocked', !!res.tier);
        window.__coldTierLadder.apply(box, res);
      }

      function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
      // A checkout that fails for a reason the buyer can't just fix
      // themselves (a declined charge, a payment provider error, the
      // Roblox link check erroring out) left them with nothing but an
      // error string and no path to an actual person.
      function withSupportLine(msgText) {
        return esc(msgText) + ' <a href="https://discord.gg/coldd" target="_blank" rel="noopener">Contact us on Discord</a> if this doesn\'t sort itself out.';
      }
      // Robux checkout failures the buyer can't self-resolve (verify timed
      // out, lease window closed, the ledger check erred) get written to
      // client_errors so they surface in the admin audit log next to a code
      // the buyer can read back to support. Hard invokeFn failures already
      // log themselves and hand the code back on err.errCode - only the
      // "soft" ok:true-but-not-verified and client-side timeout paths need
      // an explicit call here.
      function logRobuxFail(reason, ctx) {
        try {
          if (window.coldAuth && window.coldAuth.logClientError) {
            return window.coldAuth.logClientError('robux_checkout', reason, null, { fnName: 'verify-robux-order', context: ctx || null });
          }
        } catch (e) {}
        return null;
      }
      function refSuffix(err) {
        var c = err && err.errCode;
        return c ? '<span class="co-msg-ref">Reference <strong>' + esc(c) + '</strong> - quote this if you contact us.</span>' : '';
      }
      // The place-order button used to stay fully enabled and styled as the
      // primary action on an empty cart, while its handler bailed out on
      // `if (!cart.length) return;` - so clicking it did nothing at all and
      // said nothing about why. The empty cart is now reflected in the control.
      function syncPlaceButtonToCart() {
        var btn = document.getElementById('coPlace');
        if (!btn || btn.hidden) return;
        if (btn.getAttribute('data-busy') === '1') return;
        // A method that is disabled for its own reason keeps its own message.
        if (btn.textContent === 'Crypto checkout coming soon') return;
        if (!cart.length) {
          btn.disabled = true;
          btn.textContent = 'Your cart is empty';
        } else if (btn.textContent === 'Your cart is empty') {
          btn.disabled = false;
          btn.textContent = 'Place order';
        }
      }

      function renderItems() {
        if (!itemsEl) return;
        itemsEl.innerHTML = '';
        if (emptyEl) emptyEl.hidden = cart.length > 0;
        syncPlaceButtonToCart();
        cart.forEach(function (i) {
          var row = document.createElement('div'); row.className = 'co-item';
          // No "Qty" shown - every product is a single digital licence, not
          // a quantity, so there is never anything to count.
          var lic = i.licence === 'resell' ? '<div class="co-item-sub">Resell licence</div>' : '';
          row.innerHTML = '<span class="co-item-thumb" style="background-image:url(\'' + i.image + '\')"></span>' +
            '<div class="co-item-info"><div class="co-item-title">' + esc(i.title) + '</div>' + lic + '</div>' +
            '<span class="co-item-price">' + lineMoney(i) + '</span>' +
            '<button class="co-item-x" type="button" aria-label="Remove ' + esc(i.title) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
          row.querySelector('.co-item-x').addEventListener('click', function () {
            cart = cart.filter(function (x) { return x.id !== i.id; });
            save(cart); render();
          });
          itemsEl.appendChild(row);
        });
      }
      function renderTotals() {
        var sub = subtotal();
        var disc = computeDiscount(sub);
        var total = Math.max(0, sub - disc);
        var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
        set('coSubtotal', subtotalMoney());
        // Robux mode now evaluates and combines the discount entirely in
        // Robux terms (computeRobuxDiscount, matching create-robux-order's
        // spendTierDiscountRobux) rather than converting a USD figure -
        // see renderTierBanner's comment for why.
        var robuxMode = robuxView();
        var useRobux = robuxMode && cart.length > 0;
        var rbxSub = useRobux ? robuxSubtotalRaw() : null;
        var rr = rbxSub != null ? computeRobuxDiscount(rbxSub) : null;
        var discLine = document.getElementById('coDiscLine');
        var showsDiscount = rr ? rr.discount > 0 : disc > 0;
        if (discLine) {
          discLine.hidden = !showsDiscount;
          if (showsDiscount) {
            var tierPctNow = rr ? rr.tierPct : (currentSpendTier(sub) ? currentSpendTier(sub).pct : 0);
            var saleNow = (saleEventDiscountUsd() > 0) ? (window.__saleEvent && window.__saleEvent()) : null;
            var dParts = [];
            if (appliedCoupon) dParts.push(appliedCoupon.code);
            if (saleNow) dParts.push(saleNow.label + ' ' + saleNow.pct + '%');
            if (tierPctNow) dParts.push(tierPctNow + '%' + (dParts.length ? '' : ' off'));
            var discLabel = dParts.length ? ('Discount (' + dParts.join(' + ') + ')') : 'Discount';
            set('coDiscLabel', discLabel);
            set('coDiscAmt', rr ? ('-R$ ' + rr.discount.toLocaleString('en-US')) : ('-' + fiatMoney(disc)));
          }
        }
        // Tax is not currently charged on any order. The row stays hidden
        // rather than showing a permanent zero; when tax does apply, set the
        // value and unhide in one place.
        var taxLine = document.getElementById('coTaxLine');
        if (taxLine) taxLine.hidden = true;
        set('coTax', fiatMoney(0));
        if (rr) {
          set('coTotal', 'R$ ' + rr.finalTotal.toLocaleString('en-US'));
        } else {
          set('coTotal', disc > 0 ? fiatMoney(total) : subtotalMoney());
        }
        renderPayAmounts(total);
        return total;
      }

      // Each method shows the SAME order total expressed in its own unit. The
      // amount that actually leaves the account is always the flat USD figure -
      // stated once, below the list, rather than repeated four times.
      function renderPayAmounts(total) {
        var usd = window.__usd ? window.__usd(total) : ('$' + total);
        var fiat = window.__fiat ? window.__fiat(total) : usd;

        function set(key, v) {
          var el = document.querySelector('[data-pay-amt="' + key + '"]');
          if (el) el.textContent = v;
        }
        // Card and PayPal both settle in fiat, so both show the buyer's
        // selected currency.
        set('stripe', fiat);
        set('paypal', fiat);
        // Crypto shows the same fiat reference figure as card/PayPal, not a
        // coin amount - the BTC/ETH quantity is only known once the payment
        // processor quotes it live on its own checkout page, and printing
        // one here would be a number we invented. That's a different thing
        // from which currency the reference figure itself is in though:
        // this used to hardcode USD regardless of the buyer's selected
        // display currency, so switching to GBP converted every other
        // method but silently left crypto in USD - not a currency-specific
        // limitation, just this line never being updated to match.
        set('crypto', fiat);
        // Sums each item's REAL robux_price where one is set, falling back
        // to the flat 80-per-$1 estimate only per-item, not for the whole
        // row - matches priceRobuxItems' server-side math exactly. This
        // used to flat-convert the order's USD total in one shot
        // (window.__robux(total)), which showed a different number here
        // than the actual Robux panel below once any cart item had a real
        // robux_price - the classic "why does checkout show two different
        // Robux prices" report.
        var robuxRow = 0;
        cart.forEach(function (i) {
          var rbx = catalogRobuxPrice(i.id, i.licence);
          if (rbx == null) rbx = Math.round(i.price * ROBUX_PER_USD_FALLBACK);
          robuxRow += rbx * i.qty;
        });
        set('robux', 'R$ ' + Math.round(robuxRow).toLocaleString('en-US'));
        var robuxTile = document.querySelector('.co-pay-btn[data-key="robux"]');
        var robuxAllOff = cart.length > 0 && robuxOffItems().length === cart.length;
        if (robuxAllOff) set('robux', 'N/A');
        if (robuxTile) {
          robuxTile.classList.toggle('co-pay-disabled', robuxAllOff);
          robuxTile.setAttribute('aria-disabled', robuxAllOff ? 'true' : 'false');
          var robuxSub = robuxTile.querySelector('.co-pay-sub');
          if (robuxSub) robuxSub.textContent = robuxAllOff ? 'Not available for the items in your cart' : 'Buy a gamepass on Roblox, no card needed';
        }
        if (robuxAllOff && payMethod === 'robux') setPayMethod('stripe');

        // Card and PayPal both settle in USD at a rate their own processor
        // fixes at the moment of charge - crypto and Robux settle in
        // whatever the buyer actually sent/bought, converted well before
        // checkout, so this line's "what actually leaves your account"
        // framing only applies to the first two.
        var settle = document.getElementById('coPaySettle');
        if (!settle) return;
        // Only card/PayPal have a "settles in USD" story to tell - and only
        // worth telling when the buyer is looking at a non-USD figure. With a
        // real-money method selected the summary is already shown in fiat
        // (robuxView() is false), so the only mismatch left to explain is a
        // non-USD fiat; on USD the note just restates what's on screen.
        var showSettle = (payMethod === 'stripe' || payMethod === 'paypal') &&
                         window.__fiatCode && window.__fiatCode() !== 'USD';
        settle.hidden = !showSettle;
        if (showSettle) settle.textContent = 'Every payment method settles in USD price (' + usd + ').';
      }
      function render() {
        renderItems(); renderTotals(); updateResell();
        renderTierBanner(); renderCrossSell();
        if (typeof payMethod !== 'undefined' && payMethod === 'robux') renderRobuxPanel();
      }

      function updateResell() {
        var wrap = document.getElementById('coResellWrap');
        if (wrap) wrap.hidden = !cart.some(function (i) { return i.licence === 'resell'; });
      }

      // "Add to your order" suggestions - get_checkout_cross_sell ranks the
      // whole on-platform catalogue with relevance (shares a genre, then a
      // category, then a subcategory with something already in the cart)
      // dominating the site's usual quality/price/revenue conversion score.
      // Works for guests (reads the cart, not purchase history). The RPC
      // also returns the exact deal price checkout will honour - 10% off,
      // never below product_legal.min_sale_usd, and no discount at all when
      // disallow_sales is set - so the price shown here is the price
      // charged. Added items still carry crossSell:true and are re-priced
      // server-side by priceItems; the client number is never trusted.
      var crossSellCache = null; // [{ id, title, image, cat, list, deal }], refreshed when the cart's slug set changes
      var crossSellCartKey = null;
      function crossSellPicks() { return crossSellCache || []; }
      function cartIsAllResell() { return cart.length > 0 && cart.every(function (i) { return i.licence === 'resell'; }); }
      function resellUsdOf(p) { return p.resellPrice != null ? p.resellPrice : Math.round((p.priceNum || 0) * 3); }
      function renderCrossSell() {
        var box = document.getElementById('coCrossSell');
        if (!window.coldSupabase) return;
        var slugs = Array.from(new Set(cart.map(function (i) { return i.id.replace(/--resell$/, '').replace(/--bundle$/, '').replace(/--crosssell$/, ''); })));
        if (!slugs.length) { crossSellCache = []; crossSellCartKey = null; paintCrossSell(); return; }
        // A cart that's entirely resell licences should only ever be offered
        // MORE resell licences - never a personal one. Fold that into the
        // cache key so switching licence mix re-runs the filter.
        var allResell = cartIsAllResell();
        var key = slugs.slice().sort().join(',') + (allResell ? '|resell' : '');
        if (key === crossSellCartKey) { paintCrossSell(); return; }
        crossSellCartKey = key;
        window.coldSupabase.rpc('get_checkout_cross_sell', { p_slugs: slugs, p_limit: 4, p_interest: (window.__interest ? window.__interest.get() : {}) }).then(function (res) {
          if (key !== crossSellCartKey) return; // cart changed again before this resolved
          var cat = window.__CATALOG || [];
          var cartIds = {}; cart.forEach(function (i) { cartIds[i.id.replace(/--resell$/, '').replace(/--bundle$/, '').replace(/--crosssell$/, '')] = true; });
          crossSellCache = (res.data || []).map(function (r) {
            var p = cat.filter(function (x) { return x.id === r.product_slug; })[0];
            if (!p || cartIds[p.id]) return null;
            if (allResell) {
              if (!p.resell) return null;          // no resell licence available -> drop it
              var rp = resellUsdOf(p);
              return { id: p.id, title: p.title, image: p.image, cat: p.cat || '', list: rp, deal: rp, resell: true };
            }
            var list = Number(r.list_price_usd);
            var deal = Number(r.deal_price_usd);
            return { id: p.id, title: p.title, image: p.image, cat: p.cat || '',
                     list: isFinite(list) ? list : p.priceNum,
                     deal: isFinite(deal) && deal > 0 ? deal : p.priceNum };
          }).filter(Boolean);
          paintCrossSell();
        }).catch(function () { crossSellCache = []; paintCrossSell(); });
      }
      function crossSellRowHtml(x) {
        var rbx = robuxPricing();
        var discounted = !rbx && !x.resell && x.deal < x.list - 0.005;
        var priceHtml;
        if (rbx) {
          // Robux checkout re-prices from robux_price and doesn't honour
          // the 10% cross-sell discount - show the plain Robux price.
          // The product's own saved Robux price wins; the flat estimate is only
          // the fallback, exactly as the cart total and the server price it.
          var realRbx = catalogRobuxPrice(x.id, x.resell ? 'resell' : 'standard');
          priceHtml = 'R$ ' + Math.round(realRbx != null ? realRbx : x.list * ROBUX_PER_USD_FALLBACK).toLocaleString('en-US');
        } else if (discounted) {
          priceHtml = '<span class="co-cross-was">' + fiatMoney(x.list) + '</span>' + fiatMoney(x.deal) +
            '<span class="co-cross-off">10% off</span>';
        } else {
          priceHtml = fiatMoney(x.deal) + (x.resell ? '<span class="co-cross-off">Resell licence</span>' : '');
        }
        return '<div class="co-cross-row" data-slug="' + esc(x.id) + '">' +
          '<span class="co-cross-thumb" style="background-image:url(\'' + x.image + '\')"></span>' +
          '<div class="co-cross-info"><div class="co-cross-title">' + esc(x.title) + '</div>' +
          '<div class="co-cross-price">' + priceHtml + '</div></div>' +
          '<button class="btn btn-tinted co-cross-add" type="button">Add</button>' +
          '</div>';
      }
      function paintCrossSell() {
        var box = document.getElementById('coCrossSell');
        if (!box) return;
        var picks = crossSellPicks();
        if (!picks.length) { box.hidden = true; box.innerHTML = ''; return; }
        box.hidden = false;
        box.innerHTML = '<div class="co-cross-head">' + (picks[0] && picks[0].resell ? 'Add another resell licence' : 'Add to your order') + '</div>' +
          picks.slice(0, 3).map(function (x) { return crossSellRowHtml(x); }).join('');
      }
      function addCrossSell(slug) {
        var x = crossSellPicks().filter(function (p) { return p.id === slug; })[0];
        if (!x) return;
        if (x.resell) {
          cart.push({ id: x.id + '--resell', crossSellSlug: x.id, title: x.title, price: x.deal, image: x.image, tag: x.cat, licence: 'resell', qty: 1 });
        } else {
          cart.push({ id: x.id + '--crosssell', crossSellSlug: x.id, title: x.title, price: x.deal, image: x.image, tag: x.cat, licence: 'standard', qty: 1 });
        }
        save(cart);
        render();
      }
      if (document.getElementById('coCrossSell')) {
        document.getElementById('coCrossSell').addEventListener('click', function (e) {
          var row = e.target.closest('.co-cross-row'); if (!row) return;
          addCrossSell(row.getAttribute('data-slug'));
        });
      }

      var loggedIn = false;
      var g = document.getElementById('coGuest'), u = document.getElementById('coUser');
      function applySessionUI() {
        if (g) g.hidden = loggedIn;
        if (u) u.hidden = !loggedIn;
        updateGiftSignInGate();
        var cryptoGuestBlockEl = document.getElementById('coCryptoGuestBlock');
        if (cryptoGuestBlockEl) cryptoGuestBlockEl.hidden = payMethod !== 'crypto' || loggedIn;
      }
      function refreshSession() {
        if (!window.coldSupabase) { loggedIn = false; applySessionUI(); return; }
        window.coldSupabase.auth.getSession().then(function (res) {
          var session = res && res.data ? res.data.session : null;
          loggedIn = !!session;
          applySessionUI();
        }).catch(function () { loggedIn = false; applySessionUI(); });
      }
      refreshSession();
      if (window.coldSupabase) window.coldSupabase.auth.onAuthStateChange(function () { refreshSession(); });

      var coSigninBtn = document.getElementById('coSigninBtn');
      if (coSigninBtn) coSigninBtn.addEventListener('click', function () { location.href = '/signin'; });

      // Gift this order to someone else - buyer picks a recipient at
      // checkout and pays normally. lookup-gift-recipient only resolves who
      // to show as "Gifting to X"; every order-creation function re-checks
      // the id server-side, so trusting it here is fine.
      var giftToggle = document.getElementById('coGiftToggle'), giftBlock = document.getElementById('coGiftBlock');
      var giftInput = document.getElementById('coGiftInput'), giftVerifyBtn = document.getElementById('coGiftVerify');
      var giftMsg = document.getElementById('coGiftMsg'), giftSignedOutHint = document.getElementById('coGiftSignedOutHint');
      var giftLookupRow = document.getElementById('coGiftLookupRow');
      var giftRecipientUserId = null, giftRecipientName = null;
      function updateGiftSignInGate() {
        if (giftSignedOutHint) giftSignedOutHint.hidden = loggedIn;
        if (giftLookupRow) giftLookupRow.hidden = !loggedIn;
      }
      function clearGiftRecipient() {
        giftRecipientUserId = null; giftRecipientName = null;
        if (giftMsg) { giftMsg.className = 'co-coupon-msg'; giftMsg.textContent = ''; }
      }
      if (giftToggle) giftToggle.addEventListener('change', function () {
        if (giftBlock) giftBlock.hidden = !giftToggle.checked;
        if (!giftToggle.checked) { clearGiftRecipient(); if (giftInput) giftInput.value = ''; }
        updateGiftSignInGate();
      });
      if (giftVerifyBtn) giftVerifyBtn.addEventListener('click', function () {
        var q = (giftInput && giftInput.value || '').trim();
        clearGiftRecipient();
        if (!q) { if (giftMsg) { giftMsg.className = 'co-coupon-msg no'; giftMsg.textContent = 'Enter their email.'; } return; }
        if (!window.coldAuth) return;
        giftVerifyBtn.disabled = true;
        window.coldAuth.invokeFn('lookup-gift-recipient', { query: q }).then(function (data) {
          giftVerifyBtn.disabled = false;
          if (data && data.found) {
            giftRecipientUserId = data.userId;
            giftRecipientName = data.displayName;
            if (giftMsg) { giftMsg.className = 'co-coupon-msg ok'; giftMsg.textContent = 'Gifting to ' + data.displayName + '.'; }
          } else if (giftMsg) {
            giftMsg.className = 'co-coupon-msg no'; giftMsg.textContent = 'No coldd account found with that email.';
          }
        }).catch(function (err) {
          giftVerifyBtn.disabled = false;
          if (giftMsg) { giftMsg.className = 'co-coupon-msg no'; giftMsg.textContent = (err && err.message) || 'Could not look that up. Please try again.'; }
        });
      });
      // Editing the field after a successful lookup invalidates it - a
      // buyer could otherwise verify one recipient, edit the field, and
      // still have the order gifted to whoever was verified first.
      if (giftInput) giftInput.addEventListener('input', function () { if (giftRecipientUserId) clearGiftRecipient(); });

      var couponInput = document.getElementById('coCouponInput'), couponApplyBtn = document.getElementById('coCouponApply'), couponMsg = document.getElementById('coCouponMsg');
      if (couponApplyBtn) couponApplyBtn.addEventListener('click', function () {
        var code = (couponInput && couponInput.value || '').trim().toUpperCase();
        if (!code || !cart.length || !window.coldSupabase) return;
        couponApplyBtn.disabled = true;
        window.coldSupabase.functions.invoke('validate-coupon', { body: { code: code, items: cartToItems() } })
          .then(function (res) {
            couponApplyBtn.disabled = false;
            var data = res && res.data, error = res && res.error;
            if (error || !data || !data.ok) {
              appliedCoupon = null;
              if (couponMsg) { couponMsg.className = 'co-coupon-msg no'; couponMsg.textContent = (data && data.error) || 'That code is invalid or no longer active.'; }
            } else {
              appliedCoupon = { code: data.code, discountUsd: data.discountUsd };
              if (couponMsg) { couponMsg.className = 'co-coupon-msg ok'; couponMsg.textContent = data.note ? ('Code "' + data.code + '" applied - ' + data.note) : ('Code "' + data.code + '" applied!'); }
            }
            renderTotals();
          })
          .catch(function () {
            couponApplyBtn.disabled = false;
            appliedCoupon = null;
            if (couponMsg) { couponMsg.className = 'co-coupon-msg no'; couponMsg.textContent = 'Could not check that code. Please try again.'; }
            renderTotals();
          });
      });

      var coMktToggle = document.getElementById('coMkt');
      if (coMktToggle) coMktToggle.addEventListener('change', renderTotals);

      // Robux checkout never goes through Stripe - Roblox handles the
      // actual payment when the buyer purchases each gamepass on
      // Roblox's own site. This panel: link Roblox account if needed ->
      // create a pending order (which hands back each item's gamepass
      // ID) -> "Buy on Roblox" links per item -> verify against the
      // buyer's inventory. robuxOrderId is reused across tab switches as
      // long as the cart hasn't changed since it was created (tracked via
      // robuxOrderSignature below) - editing the cart after opening this
      // tab starts a fresh order instead of verifying against stale items.
      var robuxOrderId = null;
      var robuxOrderItems = null;
      var robuxOrderSignature = null;
      var robuxOrderGamePassId = null;
      var robuxOrderPriceRobux = null;
      function robuxItemsSignature(items) {
        return JSON.stringify(items.map(function (i) { return [i.slug, i.qty, i.licence]; }).sort());
      }
      // The panel itself is purely informational now - it shows the buyer
      // what they're about to pay in Robux and whether their account is
      // linked, but no order is created until they click Place order. That
      // matches every other payment method (nothing is created on tab
      // select) and means a buyer who switches methods a few times while
      // deciding never leases (and holds hostage) a pool pass they haven't
      // committed to yet.
      function renderRobuxPanel() {
        var resellBlock = document.getElementById('coRobuxResellBlock');
        var linkBlock = document.getElementById('coRobuxLinkBlock');
        var buyBlock = document.getElementById('coRobuxBuyBlock');
        if (!resellBlock || !linkBlock || !buyBlock) return;

        // Resell licences are sold in Robux now (resell_robux_price, else
        // the resell USD price flat-converted) - every cart line is part of
        // the Robux order, so the old resell-exclusion notice never shows.
        var robuxCartItems = cart;
        var robuxItems = cartToItems();
        resellBlock.hidden = true;
        linkBlock.hidden = true;
        buyBlock.hidden = true;
        if (!robuxItems.length || !window.coldAuth) return;

        // A cart edit invalidates any order already leased for the old
        // items - the next Place order click has to lease fresh rather than
        // reuse a pass priced for a cart that no longer exists.
        var signature = robuxItemsSignature(robuxItems);
        if (robuxOrderSignature && robuxOrderSignature !== signature) {
          robuxOrderId = null;
          robuxOrderItems = null;
          robuxOrderSignature = null;
          robuxOrderGamePassId = null;
          robuxOrderPriceRobux = null;
        }

        window.coldAuth.robloxLinkStatus().then(function (res) {
          // Only gates on "linked" here, NOT hasInventoryScope. That flag
          // reads false for any account linked before scope tracking
          // existed (which is most of them), even though their token
          // almost certainly already has the permission - Roblox's OAuth
          // consent is all-or-nothing, so anyone who got through it at all
          // has whatever was being requested at the time. The real check
          // happens server-side against the buyer's live inventory when
          // Place order is clicked; only THAT failing (see startRobuxOrder)
          // means a re-link is actually necessary.
          if (!res || !res.linked) {
            linkBlock.hidden = false;
            updateRobuxLinkCopy(false);
            return;
          }
          buyBlock.hidden = false;
        }).catch(function () { linkBlock.hidden = false; updateRobuxLinkCopy(false); });
      }
      // Same link block, two reasons to show it: never linked at all, vs
      // linked but the live inventory check at order-creation time came
      // back insufficient-scope. Both need the buyer to go through
      // Roblox's OAuth screen again - re-linking always overwrites the
      // stored scope with whatever was granted this time.
      function updateRobuxLinkCopy(needsRelink) {
        var hint = document.getElementById('coRobuxLinkHint');
        var btn = document.getElementById('coRobuxLinkBtn');
        if (hint) {
          hint.textContent = needsRelink
            ? "Robux checkout needs permission to check your Roblox inventory, which your current link doesn't have. Re-link your account to grant it - you'll sign in on roblox.com and come straight back here."
            : "Link your Roblox account to pay with Robux; we verify your purchase against the Roblox account you link. You'll sign in on roblox.com and come straight back here; if you're signed out of Roblox it will ask you to log in first.";
        }
        if (btn) btn.textContent = needsRelink ? 'Re-link Roblox account' : 'Continue to Roblox';
      }
      // The Robux total isn't re-stated in this panel - the Order summary
      // sidebar already shows the cart total in Robux whenever that's the
      // active display currency (which anyone paying in Robux almost always
      // has selected), and the purchase modal shows the real total once the
      // order exists. Repeating it here read as a bug, not new information.
      var robuxLinkBtn = document.getElementById('coRobuxLinkBtn');
      // Come back to checkout with Robux still selected, rather than landing
      // on the dashboard with a half-finished order behind you.
      if (robuxLinkBtn) robuxLinkBtn.addEventListener('click', function () {
        if (window.coldAuth) window.coldAuth.signInRoblox('/checkout?method=robux');
      });

      // ---- Robux purchase modal: Place order -> instructions -> continuous
      // verification polling until paid, switched, or timed out. ----
      var robuxModalOverlay = document.getElementById('robuxModalOverlay');
      var robuxModalClose = document.getElementById('robuxModalClose');
      var robuxModalSteps = document.getElementById('robuxModalSteps');
      var robuxModalTotal = document.getElementById('robuxModalTotal');
      var robuxModalBuyBtn = document.getElementById('robuxModalBuyBtn');
      var robuxModalConfirmBtn = document.getElementById('robuxModalConfirmBtn');
      var robuxModalWaiting = document.getElementById('robuxModalWaiting');
      var robuxModalStatusText = document.getElementById('robuxModalStatusText');
      var robuxModalHint = document.getElementById('robuxModalHint');
      var robuxModalCancelWait = document.getElementById('robuxModalCancelWait');
      var robuxModalDone = document.getElementById('robuxModalDone');
      var robuxModalDoneMsg = document.getElementById('robuxModalDoneMsg');
      var robuxModalRetryBtn = document.getElementById('robuxModalRetryBtn');

      var robuxPollTimer = null;
      var robuxPollDeadline = 0;
      var ROBUX_POLL_INTERVAL_MS = 5000;
      var ROBUX_POLL_TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes of continuous checking before asking the buyer to retry manually

      function updateRobuxModalBuyLink() {
        if (robuxModalTotal) robuxModalTotal.textContent = robuxOrderPriceRobux != null ? 'R$ ' + robuxOrderPriceRobux.toLocaleString('en-US') : ' - ';
        if (robuxModalBuyBtn) {
          if (robuxOrderGamePassId) {
            robuxModalBuyBtn.href = 'https://www.roblox.com/game-pass/' + robuxOrderGamePassId + '/';
            robuxModalBuyBtn.setAttribute('aria-disabled', 'false');
          } else {
            robuxModalBuyBtn.href = '#';
            robuxModalBuyBtn.setAttribute('aria-disabled', 'true');
          }
        }
      }
      function showRobuxModalPane(pane) {
        if (robuxModalSteps) robuxModalSteps.hidden = pane !== 'steps';
        if (robuxModalWaiting) robuxModalWaiting.hidden = pane !== 'waiting';
        if (robuxModalDone) robuxModalDone.hidden = pane !== 'done';
      }
      function stopRobuxPolling() {
        if (robuxPollTimer) { clearTimeout(robuxPollTimer); robuxPollTimer = null; }
      }
      function openRobuxModal() {
        if (!robuxModalOverlay) return;
        updateRobuxModalBuyLink();
        showRobuxModalPane('steps');
        robuxModalOverlay.hidden = false;
      }
      function closeRobuxModal() {
        if (!robuxModalOverlay) return;
        stopRobuxPolling();
        robuxModalOverlay.hidden = true;
      }
      if (robuxModalClose) robuxModalClose.addEventListener('click', closeRobuxModal);
      if (robuxModalOverlay) robuxModalOverlay.addEventListener('click', function (e) {
        if (e.target === robuxModalOverlay) closeRobuxModal();
      });
      if (robuxModalCancelWait) robuxModalCancelWait.addEventListener('click', function () {
        stopRobuxPolling();
        showRobuxModalPane('steps');
      });
      if (robuxModalRetryBtn) robuxModalRetryBtn.addEventListener('click', function () {
        showRobuxModalPane('steps');
      });

      function finishRobuxWait(success, message, code) {
        showRobuxModalPane('done');
        if (robuxModalDoneMsg) {
          robuxModalDoneMsg.className = 'robux-modal-msg' + (success ? '' : ' err');
          if (success) robuxModalDoneMsg.textContent = message;
          else robuxModalDoneMsg.innerHTML = withSupportLine(message);
        }
        var refEl = document.getElementById('robuxModalRef');
        if (refEl) {
          if (!success && code) {
            refEl.hidden = false;
            refEl.innerHTML = 'Reference <strong>' + esc(code) + '</strong> - quote this if you contact support.';
          } else {
            refEl.hidden = true;
            refEl.innerHTML = '';
          }
        }
      }
      function scheduleRobuxPoll() {
        if (Date.now() >= robuxPollDeadline) {
          var tcode = logRobuxFail('Robux verify timed out client-side after ' + Math.round(ROBUX_POLL_TIMEOUT_MS / 1000) + 's', { orderId: robuxOrderId, phase: 'poll_timeout' });
          finishRobuxWait(false, "We haven't been able to confirm your purchase yet. If you did complete the Roblox purchase, your payment is safe - send us the reference below and we'll finish your order by hand. If you didn't get that far, you can try again.", tcode);
          return;
        }
        robuxPollTimer = setTimeout(pollRobuxOrder, ROBUX_POLL_INTERVAL_MS);
      }
      // Runs on a loop (not on a click) until the order is paid, its lease
      // expires, verification fails closed, or the overall timeout passes -
      // the buyer only ever has to click "I've purchased" once.
      function pollRobuxOrder() {
        if (!robuxOrderId || !window.coldAuth) return;
        window.coldAuth.invokeFn('verify-robux-order', { orderId: robuxOrderId }).then(function (data) {
          if (data.verified) {
            stopRobuxPolling();
            var paidOrderId = robuxOrderId;
            // Belt-and-suspenders alongside removing the reuse shortcut
            // above: clear it the moment we know it's paid, so nothing
            // left in memory could point back at an already-owned pass if
            // this script instance somehow runs again (bfcache restore)
            // before actually navigating away.
            robuxOrderId = null; robuxOrderItems = null; robuxOrderSignature = null; robuxOrderGamePassId = null; robuxOrderPriceRobux = null;
            location.href = '/success?order_id=' + encodeURIComponent(paidOrderId);
            return;
          }
          if (data.code === 'PASS_SWITCHED') {
            // Buyer already owned the pass they were leased - the backend
            // has already released it and leased a fresh one for this same
            // order. Point the buy link at the new pass and keep polling
            // automatically, no re-click needed.
            robuxOrderGamePassId = data.gamePassId;
            robuxOrderPriceRobux = data.priceRobux;
            updateRobuxModalBuyLink();
            if (robuxModalStatusText) robuxModalStatusText.textContent = 'You already owned that gamepass - switched you to a new one.';
            if (robuxModalHint) robuxModalHint.textContent = "Buy the updated gamepass linked above, then we'll keep checking automatically.";
            scheduleRobuxPoll();
            return;
          }
          if (data.code === 'LEASE_EXPIRED') {
            stopRobuxPolling();
            var lcode = logRobuxFail('Robux order lease expired before verify', { orderId: robuxOrderId, phase: 'lease_expired' });
            robuxOrderId = null; robuxOrderItems = null; robuxOrderSignature = null; robuxOrderGamePassId = null; robuxOrderPriceRobux = null;
            finishRobuxWait(false, data.message || "This order's payment window expired. Please start the order again - you have not been charged.", lcode);
            return;
          }
          // Ledger just doesn't show it yet - keep checking.
          if (robuxModalStatusText) robuxModalStatusText.textContent = 'Still checking…';
          scheduleRobuxPoll();
        }).catch(function (err) {
          // Every thrown case here (NOT_LINKED, order not found/not yours,
          // VERIFY_UNAVAILABLE, ALREADY_OWNED_NO_REPLACEMENT, server error)
          // is a real stop condition, not "not found yet" - that case
          // resolves above with ok:true instead of throwing. Stop and let
          // the buyer retry manually rather than looping on something that
          // will never resolve itself.
          stopRobuxPolling();
          finishRobuxWait(false, (err && err.message) || 'Could not check your purchase. Please try again.', err && err.errCode);
        });
      }
      if (robuxModalConfirmBtn) robuxModalConfirmBtn.addEventListener('click', function () {
        showRobuxModalPane('waiting');
        if (robuxModalStatusText) robuxModalStatusText.textContent = 'Checking for your purchase…';
        if (robuxModalHint) robuxModalHint.textContent = "This can take a minute or two - we're checking automatically, you don't need to do anything else.";
        robuxPollDeadline = Date.now() + ROBUX_POLL_TIMEOUT_MS;
        pollRobuxOrder();
      });

      var payMethod = 'stripe';
      // Set by a "More payment methods" tile click; cleared whenever the
      // method selection changes so a stale local method never survives a
      // switch away from and back to Card.
      var selectedPaymentMethodType = '';
      var payMethodsWrap = document.getElementById('coPayMethods');
      function setPayMethod(key) {
        selectedPaymentMethodType = '';
        var btns = payMethodsWrap ? payMethodsWrap.querySelectorAll('.co-pay-btn') : [];
        var picked = null;
        btns.forEach(function (b) {
          var isMatch = b.getAttribute('data-key') === key;
          b.classList.toggle('active', isMatch);
          if (isMatch) picked = b;
        });
        var method = picked ? picked.getAttribute('data-method') : 'stripe';
        payMethod = method;
        document.querySelectorAll('.co-pay-panel').forEach(function (p) {
          p.hidden = p.getAttribute('data-method-panel') !== method;
        });
        // RelayPay (our crypto provider) requires a name and email on the
        // create-transaction call; signed-in buyers already have both on
        // their account, so this only needs to show for guests.
        var cryptoGuestBlockEl = document.getElementById('coCryptoGuestBlock');
        if (cryptoGuestBlockEl) cryptoGuestBlockEl.hidden = method !== 'crypto' || loggedIn;
        var placeBtnEl = document.getElementById('coPlace');
        if (placeBtnEl) {
          // Explicit per method. This used to be an if/else-if/else where the
          // final branch caught everything that wasn't Stripe or Robux and
          // labelled it "Crypto checkout coming soon" - so adding any new
          // method silently inherited the crypto copy.
          if (method === 'stripe' || method === 'paypal' || method === 'robux') {
            placeBtnEl.hidden = false; placeBtnEl.disabled = false;
            placeBtnEl.textContent = 'Place order';
            syncPlaceButtonToCart();
          } else if (method === 'crypto') {
            placeBtnEl.hidden = false; placeBtnEl.disabled = false;
            placeBtnEl.textContent = 'Place order';
            syncPlaceButtonToCart();
          } else {
            placeBtnEl.hidden = false; placeBtnEl.disabled = true;
            placeBtnEl.textContent = 'Unavailable';
          }
        }
        if (method === 'robux') renderRobuxPanel();
        // Re-render the summary for the method just picked: the settle line
        // shows/hides on card vs PayPal, and switching between a real-money
        // method and Robux flips the whole summary between money() and R$
        // (see robuxView) - which touches line prices, the subtotal, the
        // total and the tier ladder, not just the totals block.
        renderItems();
        renderTotals();
        renderTierBanner();
        renderCrossSell();
        // Selection is exposed to assistive tech, not just painted. The row
        // group is a radiogroup, so each row has to carry its own state.
        document.querySelectorAll('.co-pay-btn').forEach(function (b) {
          b.setAttribute('aria-checked', b.classList.contains('active') ? 'true' : 'false');
        });
      }
      if (payMethodsWrap) payMethodsWrap.addEventListener('click', function (e) {
        var btn = e.target.closest('.co-pay-btn'); if (!btn) return;
        if (btn.classList.contains('co-pay-disabled')) return;
        setPayMethod(btn.getAttribute('data-key'));
      });
      // ?method= lets a round trip land back on the method it left from -
      // notably returning from Roblox OAuth after linking to pay in Robux.
      // Validated against the rendered buttons so an arbitrary value cannot
      // select a method that does not exist, and a disabled one (crypto,
      // while awaiting RelayPay verification) can't be forced on either.
      var requestedMethod = new URLSearchParams(location.search).get('method');
      var methodExists = requestedMethod && payMethodsWrap &&
        payMethodsWrap.querySelector('.co-pay-btn[data-key="' + CSS.escape(requestedMethod) + '"]:not(.co-pay-disabled)');
      setPayMethod(methodExists ? requestedMethod : 'stripe');

      // "More payment methods" - a searchable tile grid of Stripe's local
      // payment methods (see LOCAL_METHOD_CURRENCY in create-checkout-session
      // for why most of these need their own currency, not USD). Picking one
      // sets selectedPaymentMethodType and places the order exactly like the
      // plain Card flow does.
      (function () {
        var openBtn = document.getElementById('coMoreMethodsBtn');
        var modal = document.getElementById('coMoreMethodsModal');
        var closeBtn = document.getElementById('coMethodsClose');
        var searchInput = document.getElementById('coMethodsSearch');
        var grid = document.getElementById('coMethodsGrid');
        var emptyEl = document.getElementById('coMethodsEmpty');
        if (!openBtn || !modal || !grid) return;
        var tiles = Array.prototype.slice.call(grid.querySelectorAll('.co-method-tile'));

        function openModal() { modal.hidden = false; if (searchInput) { searchInput.value = ''; filterTiles(''); searchInput.focus(); } }
        function closeModal() { modal.hidden = true; }
        function filterTiles(q) {
          q = q.trim().toLowerCase();
          var shown = 0;
          tiles.forEach(function (t) {
            // Most tiles are logo-only now (aria-label carries the name);
            // textContent still covers the one text tile (Pay by Bank).
            var name = t.getAttribute('aria-label') || t.textContent;
            var hay = (name + ' ' + (t.getAttribute('data-method-country') || '')).toLowerCase();
            var match = !q || hay.indexOf(q) !== -1;
            t.hidden = !match;
            if (match) shown++;
          });
          if (emptyEl) emptyEl.hidden = shown > 0;
        }

        // The required agreements (Terms of Service, plus the Resell Licence
        // Terms when a resell licence is in the cart) have to be ticked before
        // the list of methods opens, not after one is picked. Otherwise a
        // buyer chose a method, the order tried to start, and only then were
        // they sent back up the page to a checkbox.
        function requiredAgreementsOk() {
          var tos = document.getElementById('coTos');
          var resellWrap = document.getElementById('coResellWrap');
          var resell = document.getElementById('coResell');
          var errEl = document.getElementById('coAgreeErr');
          var missing = [], scrollEl = null;
          if (tos && !tos.checked) { missing.push('accept the Terms of Service'); scrollEl = tos.closest('.co-check'); }
          if (resellWrap && !resellWrap.hidden && resell && !resell.checked) { missing.push('accept the Resell Licence Terms'); scrollEl = scrollEl || resellWrap; }
          if (errEl) errEl.textContent = missing.length ? 'Please ' + missing.join(' and ') + ' before choosing a payment method.' : '';
          if (missing.length && scrollEl && scrollEl.scrollIntoView) scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return !missing.length;
        }
        // Clear the reminder as soon as the boxes are ticked.
        ['coTos', 'coResell'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.addEventListener('change', function () {
            var errEl = document.getElementById('coAgreeErr');
            if (errEl && errEl.textContent.indexOf('before choosing a payment method') !== -1) requiredAgreementsOk();
          });
        });
        openBtn.addEventListener('click', function () { if (requiredAgreementsOk()) openModal(); });
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
        if (searchInput) searchInput.addEventListener('input', function () { filterTiles(searchInput.value); });
        grid.addEventListener('click', function (e) {
          var tile = e.target.closest('.co-method-tile'); if (!tile) return;
          // These are all Stripe-only methods, so picking one has to force
          // the method over to Stripe even if PayPal/Crypto/Robux was
          // selected - setPayMethod() runs first because it clears
          // selectedPaymentMethodType as a side effect.
          setPayMethod('stripe');
          selectedPaymentMethodType = tile.getAttribute('data-method-type') || '';
          closeModal();
          tryPlaceOrder();
        });
      })();

      var placeBtn = document.getElementById('coPlace'), msg = document.getElementById('coMsg'), agreeErr = document.getElementById('coAgreeErr');
      // Robux never goes through create-checkout-session - it leases a pool
      // pass and opens the instructions modal instead of redirecting.
      // Cart lines whose product has Robux pricing switched off in admin.
      function robuxOffItems() {
        return cart.filter(function (i) { return i.licence === 'resell' || i.id.indexOf('--resell') !== -1 || (window.__robuxOff && window.__robuxOff(i.crossSellSlug || i.id)); });
      }
      // Mixed cart + Robux selected: say which item can't be bought with Robux and
      // let the buyer either pick another method or drop the USD-only items.
      function showRobuxBlockedModal(offs) {
        var multi = offs.length > 1;
        var canDrop = offs.length < cart.length;
        var overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        var rows = offs.map(function (o, idx) {
          var isRes = o.licence === 'resell' || o.id.indexOf('--resell') !== -1;
          return '<div class="co-rb-item"><span class="co-rb-thumb" data-i="' + idx + '"></span>' +
            '<div class="co-rb-name">' + esc(o.title) + (isRes ? '<small>Resell licence</small>' : '') + '</div></div>';
        }).join('');
        overlay.innerHTML =
          '<div class="confirm-modal mkt-popup-modal co-robux-block" role="dialog" aria-modal="true">' +
          '<div class="co-rb-items">' + rows + '</div>' +
          '<h3 class="mkt-popup-title">' + (multi ? 'These products cannot be purchased with Robux' : esc(offs[0].title) + ' cannot be purchased with Robux') + '</h3>' +
          '<p class="mkt-popup-sub">Please pay with a different payment method' + (canDrop ? ', or continue with Robux without ' + (multi ? 'these items' : 'this item') + '.' : '.') + '</p>' +
          '<div class="co-rb-actions">' +
          '<button type="button" class="btn btn-primary" id="coRbOther">Use a different payment method</button>' +
          (canDrop ? '<button type="button" class="btn btn-tinted" id="coRbDrop">Continue without ' + (multi ? 'these products' : esc(offs[0].title)) + '</button>' : '') +
          '</div></div>';
        document.body.appendChild(overlay);
        offs.forEach(function (o, idx) {
          var t = overlay.querySelector('.co-rb-thumb[data-i="' + idx + '"]');
          if (t) t.style.backgroundImage = 'url("' + String(o.image || '') + '")';
        });
        function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        overlay.querySelector('#coRbOther').addEventListener('click', function () {
          close();
          setPayMethod('stripe');
          if (payMethodsWrap && payMethodsWrap.scrollIntoView) payMethodsWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        var dropBtn = overlay.querySelector('#coRbDrop');
        if (dropBtn) dropBtn.addEventListener('click', function () {
          close();
          var offIds = offs.map(function (o) { return o.id; });
          cart = cart.filter(function (x) { return offIds.indexOf(x.id) < 0; });
          save(cart); render();
          startRobuxOrder();
        });
      }
      function startRobuxOrder() {
        if (!window.coldAuth) return;
        window.coldAuth.robloxLinkStatus().then(function (res) {
          // Only "linked" gates here - see renderRobuxPanel for why
          // hasInventoryScope isn't trusted as a hard requirement
          // client-side. create-robux-order's own live check is what
          // actually enforces this, below.
          if (!res || !res.linked) {
            renderRobuxPanel();
            if (msg) { msg.className = 'co-msg err show'; msg.textContent = 'Link your Roblox account first.'; }
            return;
          }
          var robuxItems = cartToItems();
          var offs = robuxOffItems();
          if (offs.length) { showRobuxBlockedModal(offs); return; }
          if (!robuxItems.length) {
            var nicode = logRobuxFail('Robux checkout started with no Robux-eligible items in cart', { phase: 'start_no_items' });
            if (msg) { msg.className = 'co-msg err show'; msg.innerHTML = withSupportLine('Your cart has nothing that can be bought with Robux.') + refSuffix({ errCode: nicode }); }
            return;
          }
          // Used to reuse robuxOrderId here instead of leasing fresh on
          // every click - but that trusted in-memory state indefinitely,
          // with nothing marking it stale once the order it pointed to
          // was actually paid. Browser back/forward can restore a
          // checkout tab's JS state (bfcache) without re-running this
          // script, so landing back here right after a successful
          // purchase could reopen the modal on the SAME gamepass the
          // buyer had just bought - the one thing the live pre-check in
          // create-robux-order exists to prevent, bypassed entirely
          // because this shortcut never called it again. Always leasing
          // fresh costs one extra pool lease (self-expires in 15 minutes
          // if unused) in exchange for the pre-check running every time,
          // which is the only thing actually worth optimizing away that
          // risk for.
          var signature = robuxItemsSignature(robuxItems);
          var prevText = placeBtn.textContent;
          placeBtn.setAttribute('data-busy', '1');
          placeBtn.disabled = true; placeBtn.textContent = 'Preparing your order…';
          if (msg) { msg.className = 'co-msg'; msg.textContent = ''; }
          var robuxOrderBody = { items: robuxItems };
          if (window.coldAuth.getCampaignCode()) robuxOrderBody.campaignCode = window.coldAuth.getCampaignCode();
          var robuxRefAttr = window.coldAuth.getReferralAttribution();
          if (robuxRefAttr) { robuxOrderBody.refCode = robuxRefAttr.code; robuxOrderBody.refSlug = robuxRefAttr.slug; }
          // Matches the Stripe/PayPal/crypto path - create-robux-order
          // re-validates the code server-side the same way those do, this
          // just tells it which one to check.
          if (appliedCoupon) robuxOrderBody.couponCode = appliedCoupon.code;
          if (giftToggle && giftToggle.checked && giftRecipientUserId) robuxOrderBody.giftRecipientUserId = giftRecipientUserId;
          if (coMktToggle && coMktToggle.checked) robuxOrderBody.marketingOptIn = true;
          window.coldAuth.invokeFn('create-robux-order', robuxOrderBody).then(function (data) {
            robuxOrderId = data.orderId;
            robuxOrderItems = data.items;
            robuxOrderSignature = signature;
            // The pass to actually buy - one leased pass covering the whole
            // order, priced to its exact total. Per-item gamepass IDs don't
            // exist under the pool model, so this is the only purchasable
            // link; see roblox_pool.ts.
            robuxOrderGamePassId = data.gamePassId;
            robuxOrderPriceRobux = data.priceRobux;
            deleteCartSnapshot();
            placeBtn.removeAttribute('data-busy');
            placeBtn.disabled = false; placeBtn.textContent = prevText;
            openRobuxModal();
          }).catch(function (err) {
            placeBtn.removeAttribute('data-busy');
            placeBtn.disabled = false; placeBtn.textContent = prevText;
            if (msg) { msg.className = 'co-msg err show'; msg.innerHTML = withSupportLine((err && err.message) || 'Could not start Robux checkout.') + refSuffix(err); }
            // create-robux-order's own live inventory check is the actual
            // authority on whether a re-link is needed (see its comments) -
            // only switch to the link block when THAT specifically failed,
            // not on every error, so a transient/unrelated failure doesn't
            // yank the buy block out from under someone who was fine.
            if (err && (err.code === 'INVENTORY_SCOPE_REQUIRED' || err.code === 'NOT_LINKED')) {
              var linkBlockEl = document.getElementById('coRobuxLinkBlock');
              var buyBlockEl = document.getElementById('coRobuxBuyBlock');
              if (linkBlockEl) linkBlockEl.hidden = false;
              if (buyBlockEl) buyBlockEl.hidden = true;
              updateRobuxLinkCopy(err.code === 'INVENTORY_SCOPE_REQUIRED');
            }
          });
        }).catch(function (err) {
          var lscode = logRobuxFail('robloxLinkStatus check failed before Robux order: ' + ((err && err.message) || 'unknown'), { phase: 'start_link_check', errCode: err && err.errCode });
          if (msg) { msg.className = 'co-msg err show'; msg.innerHTML = withSupportLine('Could not check your Roblox account link.') + refSuffix({ errCode: (err && err.errCode) || lscode }); }
        });
      }
      // The "Build more for less" interruption before payment: a single
      // modal on the "Place order" click - relevance-ranked items to add
      // to the order, and a one-tap bar to put a resell licence on
      // everything eligible. Shown at most once per checkout visit (not
      // persisted - a later visit is a fresh decision). Works for Robux
      // too: resell IS sold in Robux now (resell_robux_price), and the
      // spend-tier maths has its own Robux path server-side.
      var offerShown = false;

      function resellCandidates() {
        var cat = window.__CATALOG || [];
        return cart.filter(function (i) {
          if (i.licence === 'resell') return false;
          var p = cat.filter(function (x) { return x.id === i.id; })[0];
          return p && p.resell;
        });
      }
      function tierLadderNow() {
        var useRobux = robuxPricing();
        var sub = useRobux ? robuxSubtotalRaw() : subtotal();
        return {
          useRobux: useRobux,
          sub: sub,
          res: window.__coldTierLadder.build(sub, {
            tiers: SPEND_TIERS,
            thresholdFor: function (t) { return useRobux ? t.minRobux : t.minSubtotal; },
            fmt: function (n) { return useRobux ? ('R$ ' + Math.round(n).toLocaleString('en-US')) : fiatMoney(n); },
            fmtThreshold: function (n) { return useRobux ? ('R$ ' + (n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : Math.round(n))) : ('$' + Math.round(n)); }
          })
        };
      }
      function offerHasContent() {
        if (resellCandidates().length) return true;
        var picks = crossSellPicks();
        if (!picks.length) return false;
        var allResell = cart.length > 0 && cart.every(function (i) { return i.licence === 'resell'; });
        if (!allResell) return true;
        // All-resell cart: only worth opening if we can upsell resell
        // licences of something (standard suggestions don't fit).
        var c = window.__CATALOG || [];
        return picks.some(function (x) { var p = c.filter(function (q) { return q.id === x.id; })[0]; return p && p.resell; });
      }
      function openOfferModal(onProceed) {
        var overlay = document.getElementById('coOfferModal');
        var listEl = document.getElementById('coOfferList');
        var tierEl = document.getElementById('coOfferTier');
        var termsWrap = document.getElementById('coOfferTermsWrap');
        var termsBox = document.getElementById('coOfferTerms');
        var msgEl = document.getElementById('coOfferMsg');
        var subEl = document.getElementById('coOfferSubtotal');
        if (!overlay || !listEl) { onProceed(); return; }
        var cat = window.__CATALOG || [];
        var rate = ROBUX_PER_USD_FALLBACK;

        // Snapshot both offer lists once, from the cart as it stands now -
        // so toggling a row on doesn't make it vanish (it just flips to
        // "Added"), and the suggestions don't reshuffle under the cursor as
        // the subtotal moves. addPicks are the same relevance-ranked
        // "add to your order" suggestions the order summary shows.
        var resellSlugs = resellCandidates().map(function (i) { return i.id; });
        var resellEl = document.getElementById('coOfferResell');
        // A cart that's entirely resell licences gets resell licences of
        // other relevant products upsold to it, not standard ones.
        var allResell = cart.length > 0 && cart.every(function (i) { return i.licence === 'resell'; });
        var cartHadResell = cart.some(function (i) { return i.licence === 'resell'; });
        // True once a resell licence is added from inside this modal - the
        // modal's own terms checkbox only appears then (a resell licence
        // added on the product page is covered by the page's checkbox).
        var modalAddedResell = false;
        var addPicks = crossSellPicks().filter(function (x) {
          if (!allResell) return true;
          var p = (window.__CATALOG || []).filter(function (c) { return c.id === x.id; })[0];
          return p && p.resell;
        }).slice(0, 3);

        function resellPriceOf(p) { return p.resellPrice != null ? p.resellPrice : Math.round(p.priceNum * 3); }
        function resellRobuxOf(p, basePrice) {
          if (p.resellRobuxPrice > 0) return p.resellRobuxPrice;
          return Math.round((resellPriceOf(p) - (basePrice || 0)) * rate);
        }
        function offerRow(slug, img, name, priceHtml, added) {
          return '<div class="co-offer-row' + (added ? ' added' : '') + '" data-slug="' + esc(slug) + '">' +
            '<span class="co-offer-thumb" style="background-image:url(\'' + img + '\')"></span>' +
            '<div class="co-offer-info"><div class="co-offer-name">' + esc(name) + '</div>' +
            '<div class="co-offer-price">' + priceHtml + '</div></div>' +
            '<button class="btn btn-tinted co-offer-add' + (added ? ' is-added' : '') + '" type="button">' +
            (added
              ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>Added'
              : 'Add') +
            '</button></div>';
        }
        function build() {
          var t = tierLadderNow();
          var useRobux = t.useRobux;
          var fmtMoney = function (n) { return useRobux ? ('R$ ' + Math.round(n).toLocaleString('en-US')) : fiatMoney(n); };
          window.__coldTierLadder.apply(tierEl, t.res);

          // The resell upsell: one bar, not a row per product. Toggling it
          // puts (or pulls) a resell licence on every eligible item at once.
          if (resellEl) {
            if (!resellSlugs.length) { resellEl.hidden = true; resellEl.innerHTML = ''; }
            else {
              resellEl.hidden = false;
              var addedCount = 0, deltaTotal = 0;
              resellSlugs.forEach(function (slug) {
                var p = cat.filter(function (x) { return x.id === slug; })[0];
                if (!p) return;
                var isAdded = cart.some(function (x) { return x.id === slug + '--resell'; });
                if (isAdded) addedCount++;
                var stdLine = cart.filter(function (x) { return x.id === slug; })[0];
                var basePrice = stdLine ? stdLine.price : p.priceNum;
                deltaTotal += useRobux ? resellRobuxOf(p, basePrice) : (resellPriceOf(p) - basePrice);
              });
              var allAdded = addedCount === resellSlugs.length;
              var n = resellSlugs.length;
              // Items in the cart that cannot take a resell licence at all (and are not one already). When some
              // exist, the offer must say exactly which products it covers, never "these products".
              var ineligible = cart.filter(function (x) { return !(x.licence === 'resell' || resellSlugs.indexOf(x.id) >= 0); }).length;
              var names = resellSlugs.map(function (slug) {
                var p = cat.filter(function (x) { return x.id === slug; })[0];
                var t = p ? p.title : slug;
                return t.length > 30 ? t.slice(0, 28) + '…' : t;
              });
              var heading, detail;
              if (!ineligible) {
                heading = n === 1 ? 'Want to sell this product?' : 'Want to sell these products?';
                detail = 'Add a resell licence to ' + (n === 1 ? 'this item' : ('all ' + n + ' items'));
              } else {
                heading = 'Want to sell ' + (n <= 2 ? names.join(' or ') : (names[0] + ' and ' + (n - 1) + ' more')) + '?';
                detail = 'Add a resell licence to ' + (n === 1 ? 'this item only' : ('these ' + n + ' items only')) +
                  ' (' + (ineligible === 1 ? 'the other item in your cart doesn’t' : ('the other ' + ineligible + ' items in your cart don’t')) + ' offer one)';
              }
              resellEl.className = 'co-offer-resell' + (allAdded ? ' added' : '');
              resellEl.innerHTML =
                '<div class="cor-copy"><b>' + esc(heading) + '</b>' +
                '<span>' + esc(detail) + ' · +' + fmtMoney(deltaTotal) + '</span></div>' +
                '<button class="btn btn-tinted co-offer-resell-btn' + (allAdded ? ' is-added' : '') + '" type="button">' +
                (allAdded
                  ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>Added'
                  : 'Add') + '</button>';
            }
          }

          var rows = addPicks.map(function (x) {
            if (allResell) {
              var rp = cat.filter(function (c) { return c.id === x.id; })[0];
              if (!rp) return '';
              var added = cart.some(function (c) { return c.id === x.id + '--resell'; });
              var rpUsd = resellPriceOf(rp);
              var rpDisp = useRobux ? (rp.resellRobuxPrice > 0 ? rp.resellRobuxPrice : Math.round(rpUsd * rate)) : rpUsd;
              var priceHtml = fmtMoney(rpDisp) + '<span class="co-offer-off">Resell licence</span>';
              return offerRow(x.id, x.image, x.title, priceHtml, added);
            }
            var added2 = cart.some(function (c) { return c.id === x.id || c.id === x.id + '--crosssell'; });
            var priceHtml2;
            if (useRobux) {
              // Robux checkout re-prices from robux_price and does not honour
              // the 10% cross-sell discount, so show the plain Robux price.
              priceHtml2 = 'R$ ' + Math.round(x.list * rate).toLocaleString('en-US');
            } else if (x.deal < x.list - 0.005) {
              priceHtml2 = '<span class="co-offer-was">' + fiatMoney(x.list) + '</span>' + fiatMoney(x.deal) +
                '<span class="co-offer-off">10% off</span>';
            } else {
              priceHtml2 = fiatMoney(x.deal);
            }
            return offerRow(x.id, x.image, x.title, priceHtml2, added2);
          }).join('');
          listEl.innerHTML = rows || '<p class="co-offer-empty">You’re all set - nothing to add here.</p>';

          if (termsWrap) termsWrap.hidden = !modalAddedResell;
          if (subEl) subEl.textContent = 'Subtotal ' + fmtMoney(t.sub);
        }
        if (resellEl) resellEl.onclick = function (e) {
          if (!e.target.closest('.co-offer-resell-btn')) return;
          var allAdded = resellSlugs.every(function (slug) { return cart.some(function (x) { return x.id === slug + '--resell'; }); });
          resellSlugs.forEach(function (slug) {
            var p = cat.filter(function (x) { return x.id === slug; })[0];
            if (!p) return;
            var has = cart.some(function (x) { return x.id === slug + '--resell'; });
            if (allAdded && has) {
              cart = cart.filter(function (x) { return x.id !== slug + '--resell'; });
              cart.push({ id: slug, title: p.title, price: p.priceNum, image: p.image, tag: p.cat || '', licence: 'standard', qty: 1 });
            } else if (!allAdded && !has) {
              cart = cart.filter(function (x) { return x.id !== slug; });
              cart.push({ id: slug + '--resell', title: p.title, price: resellPriceOf(p), image: p.image, tag: p.cat || '', licence: 'resell', qty: 1 });
              modalAddedResell = true;
            }
          });
          save(cart); render(); build();
        };
        listEl.onclick = function (e) {
          var btn = e.target.closest('.co-offer-add'); if (!btn) return;
          var row = e.target.closest('.co-offer-row'); if (!row) return;
          var slug = row.getAttribute('data-slug');
          var p = cat.filter(function (x) { return x.id === slug; })[0];
          if (!p) return;
          if (allResell) {
            // Upselling resell licences onto an all-resell cart.
            if (cart.some(function (x) { return x.id === slug + '--resell'; })) {
              cart = cart.filter(function (x) { return x.id !== slug + '--resell'; });
            } else {
              cart.push({ id: slug + '--resell', title: p.title, price: resellPriceOf(p), image: p.image, tag: p.cat || '', licence: 'resell', qty: 1 });
              modalAddedResell = true;
            }
          } else if (cart.some(function (x) { return x.id === slug || x.id === slug + '--crosssell'; })) {
            cart = cart.filter(function (x) { return x.id !== slug && x.id !== slug + '--crosssell'; });
          } else {
            // Add at the cross-sell deal price and flag it (cartToItems
            // sends crossSell:true; priceItems re-checks the 10% against
            // min_sale_usd / disallow_sales server-side).
            var pick = addPicks.filter(function (a) { return a.id === slug; })[0];
            cart.push({ id: slug + '--crosssell', crossSellSlug: slug, title: p.title,
              price: pick ? pick.deal : p.priceNum, image: p.image, tag: p.cat || '', licence: 'standard', qty: 1 });
          }
          save(cart); render(); build();
        };
        function onKey(e) { if (e.key === 'Escape') close(); }
        function close() { overlay.hidden = true; document.removeEventListener('keydown', onKey); }
        document.addEventListener('keydown', onKey);
        var closeBtn = document.getElementById('coOfferClose');
        var cancelBtn = document.getElementById('coOfferCancel');
        if (closeBtn) closeBtn.onclick = function () { close(); };
        if (cancelBtn) cancelBtn.onclick = function () { close(); };
        document.getElementById('coOfferPlace').onclick = function () {
          // Only gate on the modal's own terms box for resell licences
          // added here - a pre-existing one is the page checkbox's job.
          if (modalAddedResell && termsBox && !termsBox.checked) {
            if (msgEl) msgEl.textContent = 'Please accept the Resell Licence Terms to include resell rights.';
            if (termsWrap) { termsWrap.classList.remove('shake'); void termsWrap.offsetWidth; termsWrap.classList.add('shake'); }
            return;
          }
          // Mirror the acceptance onto the page's own resell-terms checkbox
          // so validateBeforeOrder passes without bouncing the buyer back
          // up the page to a box they already ticked here.
          if (modalAddedResell) { var real = document.getElementById('coResell'); if (real) real.checked = true; }
          if (msgEl) msgEl.textContent = '';
          close();
          onProceed();
        };
        if (msgEl) msgEl.textContent = '';
        build();
        overlay.hidden = false;
      }

      // Runs the actual "can this order be placed" checks and, on the
      // first thing that's missing, brings it into view instead of just
      // printing an error above a button that might be a full scroll away
      // from the field the error is even about.
      function validateBeforeOrder() {
        var tos = document.getElementById('coTos'), resellWrap = document.getElementById('coResellWrap'), resell = document.getElementById('coResell');
        var ok = true, agreeMsgs = [], scrollEl = null;
        if (tos && !tos.checked) { ok = false; agreeMsgs.push('accept the Terms of Service'); scrollEl = scrollEl || tos.closest('.co-check'); }
        if (resellWrap && !resellWrap.hidden && resell && !resell.checked) { ok = false; agreeMsgs.push('accept the Resell Licence Terms'); scrollEl = scrollEl || resellWrap; }
        if (agreeErr) agreeErr.textContent = agreeMsgs.length ? 'Please ' + agreeMsgs.join(' and ') + '.' : '';
        if (!ok) {
          if (msg) { msg.className = 'co-msg err show'; msg.textContent = 'Please fix the highlighted fields above.'; }
          if (scrollEl && scrollEl.scrollIntoView) scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return false;
        }
        // Gift toggle on but no verified recipient - never place an order
        // gifted to nobody in particular.
        if (giftToggle && giftToggle.checked && !giftRecipientUserId) {
          if (msg) { msg.className = 'co-msg err show'; msg.textContent = 'Please verify a gift recipient above, or turn off "This is a gift".'; }
          var giftBlock = document.getElementById('coGiftBlock') || giftToggle.closest('.co-check');
          if (giftBlock && giftBlock.scrollIntoView) giftBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return false;
        }
        // Crypto (RelayPay) requires a name and email on the create-transaction
        // call; signed-in buyers already have both on their account.
        if (payMethod === 'crypto' && !loggedIn) {
          var cgName = (document.getElementById('coCryptoGuestName') || {}).value || '';
          var cgEmail = (document.getElementById('coCryptoGuestEmail') || {}).value || '';
          var cgMsg = document.getElementById('coCryptoGuestMsg');
          if (!cgName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cgEmail.trim())) {
            if (cgMsg) { cgMsg.className = 'co-coupon-msg no'; cgMsg.textContent = 'Enter your name and a valid email to pay with crypto as a guest.'; }
            var cgBlock = document.getElementById('coCryptoGuestBlock');
            if (cgBlock && cgBlock.scrollIntoView) cgBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return false;
          }
        }
        return true;
      }

      function tryPlaceOrder() {
        if (!validateBeforeOrder()) return;
        // The offer modal can add a resell licence, which makes the
        // resell-terms checkbox required - so re-validate after it closes
        // rather than proceeding straight through. The modal mirrors its
        // own terms acceptance onto that checkbox, so a buyer who ticked
        // it there won't get bounced.
        if (!offerShown && offerHasContent()) {
          offerShown = true;
          openOfferModal(function () {
            if (!validateBeforeOrder()) return;
            proceedToOrder();
          });
          return;
        }
        proceedToOrder();
      }

      if (placeBtn) placeBtn.addEventListener('click', function () {
        if (!cart.length) return;
        // Card, PayPal and Robux all place an order from this button; they
        // differ only in what happens after. Crypto drives its own panel
        // and never reaches here.
        if (payMethod !== 'stripe' && payMethod !== 'paypal' && payMethod !== 'crypto' && payMethod !== 'robux') return;

        // Signing in is optional - a guest can check out fine (create-checkout-session
        // leaves orders.user_id null for them); this just ties the order to an
        // account when one exists, for dashboard history and easier redownloads.
        // Robux is the one method that requires a signed-in, Roblox-linked
        // account (startRobuxOrder checks that), since Roblox has no guest
        // concept to buy a gamepass under.
        tryPlaceOrder();
      });

      function proceedToOrder() {
        if (payMethod === 'robux') { startRobuxOrder(); return; }

        var prevText = placeBtn.textContent;
        placeBtn.setAttribute('data-busy', '1');
        placeBtn.disabled = true; placeBtn.textContent = 'Redirecting to secure checkout…';
        if (msg) { msg.className = 'co-msg'; msg.textContent = ''; }

        var checkoutBody = { items: cartToItems() };
        if (appliedCoupon) checkoutBody.couponCode = appliedCoupon.code;
        if (window.coldAuth && window.coldAuth.getCampaignCode()) checkoutBody.campaignCode = window.coldAuth.getCampaignCode();
        var checkoutRefAttr = window.coldAuth && window.coldAuth.getReferralAttribution();
        if (checkoutRefAttr) { checkoutBody.refCode = checkoutRefAttr.code; checkoutBody.refSlug = checkoutRefAttr.slug; }
        if (giftToggle && giftToggle.checked && giftRecipientUserId) checkoutBody.giftRecipientUserId = giftRecipientUserId;
        if (coMktToggle && coMktToggle.checked) checkoutBody.marketingOptIn = true;
        if (payMethod === 'crypto' && !loggedIn) {
          checkoutBody.guestName = ((document.getElementById('coCryptoGuestName') || {}).value || '').trim();
          checkoutBody.guestEmail = ((document.getElementById('coCryptoGuestEmail') || {}).value || '').trim();
        }
        if (payMethod === 'stripe' && selectedPaymentMethodType) checkoutBody.paymentMethodType = selectedPaymentMethodType;
        // A "Build more for less" or wishlist-reminder token, if this cart
        // came from either - priceItems() silently ignores it if it's
        // expired, unknown, or none of its slugs are actually in this
        // cart, so it's always safe to just always send whatever's saved.
        try { var savedBundleToken = localStorage.getItem('coldd_bundle_token'); if (savedBundleToken) checkoutBody.bundleToken = savedBundleToken; } catch (e) {}

        // Only slugs, quantities and a coupon code are ever sent. Both
        // functions re-price the whole cart from the database, so a tampered
        // request buys nothing at the wrong price.
        var checkoutFn = payMethod === 'paypal' ? 'create-paypal-order'
          : payMethod === 'crypto' ? 'create-crypto-charge'
          : 'create-checkout-session';

        window.coldSupabase.functions.invoke(checkoutFn, { body: checkoutBody })
          .then(function (res) {
            var data = res && res.data, error = res && res.error;
            if (error || !data || !data.ok) {
              // On a non-2xx the SDK reports only "Edge Function returned a
              // non-2xx status code" and leaves data null, hiding the actual
              // reason. The response body is on error.context, so read it and
              // surface the server's own message instead.
              if (error && error.context && typeof error.context.json === 'function') {
                return error.context.json()
                  .catch(function () { return null; })
                  .then(function (parsed) {
                    throw new Error((parsed && parsed.error) || error.message || 'Could not start checkout.');
                  });
              }
              throw new Error((data && data.error) || (error && error.message) || 'Could not start checkout.');
            }
            deleteCartSnapshot();
            location.href = data.url;
          })
          .catch(function (err) {
            placeBtn.removeAttribute('data-busy');
            placeBtn.disabled = false; placeBtn.textContent = prevText;
            // create-checkout-session / create-paypal-order / create-crypto-charge
            // are called via the raw SDK (not invokeFn), so their failures
            // don't self-log - do it here so a broken checkout lands in the
            // admin audit log next to a code the buyer can quote.
            var ecode = null;
            try {
              if (window.coldAuth && window.coldAuth.logClientError) {
                ecode = window.coldAuth.logClientError('checkout', (err && err.message) || 'Checkout could not start', err && err.stack, {
                  fnName: checkoutFn,
                  context: { payMethod: payMethod, paymentMethodType: checkoutBody.paymentMethodType || null, itemCount: (checkoutBody.items || []).length, coupon: checkoutBody.couponCode || null, gift: !!checkoutBody.giftRecipientUserId }
                });
              }
            } catch (e) {}
            if (ecode && err) err.errCode = ecode;
            if (msg) { msg.className = 'co-msg err show'; msg.innerHTML = withSupportLine((err && err.message) || 'Something went wrong. Please try again.') + refSuffix(err); }
          });
      }

      // The real Place order button sits at the end of a long left column
      // (Contact -> Payment -> Before you pay), often a full scroll away
      // from where the buyer actually is once they're reading through
      // payment method details. The sticky Order summary card is already
      // on screen regardless of scroll position, so it gets its own copy
      // of the button that just mirrors and forwards to the real one -
      // this observes disabled/text/hidden instead of duplicating every
      // place those are set (busy states, method switches, validation
      // errors, etc.) so it can never silently drift out of sync with the
      // button it's standing in for.
      var placeBtnSide = document.getElementById('coPlaceSide');
      if (placeBtnSide && placeBtn) {
        var syncSideBtn = function () {
          placeBtnSide.disabled = placeBtn.disabled;
          placeBtnSide.textContent = placeBtn.textContent;
          placeBtnSide.hidden = placeBtn.hidden;
        };
        syncSideBtn();
        new MutationObserver(syncSideBtn).observe(placeBtn, {
          attributes: true, attributeFilter: ['disabled', 'hidden'],
          childList: true, characterData: true, subtree: true
        });
        placeBtnSide.addEventListener('click', function () { placeBtn.click(); });
      }

      window.addEventListener('currencychange', function () { renderTotals(); renderItems(); renderTierBanner(); renderCrossSell(); });
      if (cart.length) scheduleCartSnapshot();
      render();
    })();



    (function () {
      var root = document.querySelector('.success-page');
      if (!root) return;

      // A visitor staring at a failed/stuck order has no other path to a
      // human on this page - the sub-message alone left them to go dig up
      // a support contact themselves. Appended (not replacing the actual
      // explanation) to every failure-ish message, as real HTML since it
      // needs to be a clickable link.
      function withSupportLine(msgHtml) {
        return msgHtml + ' <a href="https://discord.gg/coldd" target="_blank" rel="noopener">Contact us on Discord</a> if this doesn\'t sort itself out.';
      }
      function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

      // Navigating straight to the signed URL put a raw
      // <project-ref>.supabase.co address in the tab/download manager for
      // whoever had just paid us - reads as a phishing link, not a coldd
      // download. Fetching it and saving the blob instead means the only
      // URL ever visible anywhere is a blob: one, which carries THIS
      // page's own coldd.dev origin, not the signed URL's real host.
      function triggerFileDownload(url, filename) {
        return fetch(url).then(function (res) {
          if (!res.ok) throw new Error('Download failed.');
          return res.blob();
        }).then(function (blob) {
          var objectUrl = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = objectUrl; a.download = filename || '';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 4000);
        });
      }

      var itemsEl = document.getElementById('successItems');
      var titleEl = document.getElementById('successTitle');
      var subEl = document.getElementById('successSub');
      var markEl = document.getElementById('successMark');
      // The tick only turns green once the order actually reads as paid.
      // Showing it on arrival would claim success while a PayPal capture or a
      // crypto confirmation is still outstanding, which is exactly the state
      // where the buyer most needs the truth.
      var tyRoot = document.getElementById('tyRoot');
      function mark(state) {
        if (markEl) markEl.setAttribute('data-state', state);
        // The "what happens next" steps talk about download buttons that only
        // exist once the order reads as paid, so they stay out of the way
        // until then rather than instructing the buyer to click nothing.
        if (tyRoot) tyRoot.setAttribute('data-state', state);
      }

      // A one-shot burst of the site's own palette, not a generic rainbow -
      // canvas over DOM nodes since a hundred-plus animating elements is
      // heavier on layout than one canvas repainting itself. Self-removes
      // once every piece has fallen off-screen (or after 4s regardless, so
      // a stray piece stuck bouncing near the ceiling can't linger forever).
      var confettiPlayed = false;
      function confettiBurst() {
        if (confettiPlayed) return;
        confettiPlayed = true;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        var colors = ['#ff4d44', '#e2382f', '#ff8079', '#34e08a', '#f4f6f9'];
        var canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
        var dpr = window.devicePixelRatio || 1;
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;
        document.body.appendChild(canvas);
        var ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        var w = window.innerWidth, h = window.innerHeight;
        var pieces = [];
        for (var i = 0; i < 140; i++) {
          pieces.push({
            x: w / 2 + (Math.random() - 0.5) * 260,
            y: h * 0.28 + (Math.random() - 0.5) * 40,
            vx: (Math.random() - 0.5) * 11,
            vy: Math.random() * -11 - 3,
            size: Math.random() * 6 + 4,
            color: colors[Math.floor(Math.random() * colors.length)],
            rot: Math.random() * 360,
            vrot: (Math.random() - 0.5) * 22,
            gravity: 0.22 + Math.random() * 0.14
          });
        }
        var start = null;
        function frame(ts) {
          if (!start) start = ts;
          ctx.clearRect(0, 0, w, h);
          var alive = false;
          pieces.forEach(function (p) {
            p.vy += p.gravity; p.x += p.vx; p.y += p.vy; p.rot += p.vrot;
            if (p.y < h + 20) alive = true;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot * Math.PI / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
            ctx.restore();
          });
          if (alive && ts - start < 4000) requestAnimationFrame(frame);
          else canvas.remove();
        }
        requestAnimationFrame(frame);
      }
      var sessionId = new URLSearchParams(location.search).get('session_id');
      var robuxOrderIdParam = new URLSearchParams(location.search).get('order_id');
      // One-time claim token for GUEST orders - the payment provider's
      // success redirect carries it as ?t=. Account orders don't have one
      // (they're gated on the signed-in buyer's JWT instead). Passed to
      // get-order-by-session / get-download-url / submit-reseller-info.
      var claimToken = new URLSearchParams(location.search).get('t') || '';
      // PayPal returns here after approval. Approval is NOT payment - the
      // capture below is what actually moves the money, so this page must run
      // it before it can honestly say the order is paid.
      var paypalOrderIdParam = new URLSearchParams(location.search).get('provider') === 'paypal'
        ? new URLSearchParams(location.search).get('orderId')
        : null;
      // Crypto returns here too, but must NEVER capture from the browser: the
      // payment confirms on-chain minutes later, often after the buyer has
      // gone, so the signed webhook is the only thing allowed to mark it paid.
      // This page just polls and reports what the order row says.
      var cryptoOrderIdParam = new URLSearchParams(location.search).get('provider') === 'crypto'
        ? new URLSearchParams(location.search).get('orderId')
        : null;
      // Downstream polling looks orders up the same way for all of them, so
      // fold whichever id we got into the generic order-id slot.
      if (!robuxOrderIdParam) robuxOrderIdParam = paypalOrderIdParam || cryptoOrderIdParam;

      try { localStorage.setItem('coldd_cart_v1', '[]'); } catch (e) {}
      window.dispatchEvent(new Event('currencychange'));

      function renderItems(items) {
        if (!itemsEl) return;
        itemsEl.innerHTML = '';
        items.forEach(function (it) {
          // order_items only stores slug/title/qty/licence, not an image -
          // the catalog (already loaded for pricing elsewhere on the site)
          // is the source of truth for that, matched by slug.
          var catEntry = (window.__CATALOG || []).filter(function (c) { return c.id === it.product_slug; })[0];
          var thumb = catEntry && catEntry.image ? catEntry.image : '';
          var card = document.createElement('div');
          card.className = 'dash-card glass dl-item';
          card.innerHTML =
            '<div class="dl-top"><span class="dl-thumb" style="background-image:url(\'' + thumb + '\')"></span>' +
            '<div class="dl-info"><div class="dl-name"></div><div class="dl-meta"></div></div>' +
            '<div class="dl-actions"><a class="btn btn-ghost dl-review" href="/product/' + encodeURIComponent(it.product_slug) + '?tab=reviews">Leave a review</a>' +
            '<button class="btn btn-primary dl-get" type="button">Download</button></div></div>';
          card.querySelector('.dl-name').textContent = it.title;
          // No "Qty" - every product is a single digital licence, never a
          // quantity.
          card.querySelector('.dl-meta').textContent = it.licence === 'resell' ? 'Resell licence' : 'Standard licence';
          var btn = card.querySelector('.dl-get');
          btn.addEventListener('click', function () {
            var prev = btn.textContent;
            btn.disabled = true; btn.textContent = 'Preparing…';
            window.coldSupabase.functions.invoke('get-download-url', { body: sessionId ? { slug: it.product_slug, sessionId: sessionId, token: claimToken } : { slug: it.product_slug, orderId: robuxOrderIdParam, token: claimToken } })
              .then(function (res) {
                var data = res && res.data;
                if (!data || !data.ok) {
                  var code = data && data.code;
                  if (code === 'LINK_EXPIRED' || code === 'LINK_INVALID' || code === 'SIGN_IN_REQUIRED') {
                    btn.disabled = false; btn.textContent = prev;
                    var note = card.querySelector('.dl-expired');
                    if (!note) {
                      note = document.createElement('p');
                      note.className = 'dl-expired';
                      note.innerHTML = code === 'SIGN_IN_REQUIRED'
                        ? 'This order is tied to an account. <a href="/signin">Sign in</a> as the buyer to download.'
                        : 'This confirmation link can\'t be used to download. <a href="/signup">Create a free account</a> with your checkout email to download any time.';
                      card.appendChild(note);
                    }
                    return;
                  }
                  btn.disabled = false;
                  btn.textContent = (data && data.error) || 'Could not get download.';
                  return;
                }
                return triggerFileDownload(data.url, data.filename).then(function () { btn.disabled = false; btn.textContent = prev; });
              })
              .catch(function () { btn.disabled = false; btn.textContent = prev; });
          });
          itemsEl.appendChild(card);
        });
      }

      // Guest checkout (no account): the ?t= link is a short-lived,
      // single-use key, not a permanent download page. Nudge them to claim
      // a free account with their checkout email so access survives.
      // One-question attribution survey on the thank-you page. Answer is
      // stored once per browser (so a repeat buyer isn't asked again) and
      // sent as a client_events 'how_heard' row via coldTrack.
      function maybeShowHowHeard() {
        var el = document.getElementById('tySurvey');
        if (!el) return;
        try { if (localStorage.getItem('coldd_how_heard')) return; } catch (e) {}
        el.hidden = false;
        var opts = document.getElementById('tySurveyOpts');
        opts.querySelectorAll('button').forEach(function (b) {
          b.addEventListener('click', function () {
            var src = b.getAttribute('data-src');
            try { localStorage.setItem('coldd_how_heard', src); } catch (e) {}
            if (window.coldTrack) window.coldTrack('how_heard', { id: src });
            opts.hidden = true;
            var d = document.getElementById('tySurveyDone');
            if (d) d.hidden = false;
          });
        });
      }

      function showGuestClaimNote() {
        if (!itemsEl || document.getElementById('tyGuestNote')) return;
        var note = document.createElement('p');
        note.id = 'tyGuestNote';
        note.className = 'ty-guest-note';
        note.innerHTML = 'You checked out as a guest. This download link expires in 2 hours - <a href="/signup">create a free account</a> with your checkout email to keep access to these files for good.';
        itemsEl.parentNode.insertBefore(note, itemsEl.nextSibling);
      }

      // Crypto is the one case where leaving really is fine (the network
      // confirmation happens regardless of whether this tab stays open -
      // see the "you can close this page" copy a few lines below), so it's
      // deliberately excluded here. Everything else (Stripe, PayPal, and
      // Robux - which has already sent the buyer to Roblox and back by the
      // time it's on this page) only sits in 'pending' for the length of a
      // real verification round trip, seconds not minutes, and there's no
      // legitimate reason to navigate away mid-poll - only to lose track of
      // whether the order actually went through.
      window.addEventListener('beforeunload', function (e) {
        if (cryptoOrderIdParam) return;
        if (!tyRoot || tyRoot.getAttribute('data-state') !== 'pending') return;
        e.preventDefault();
        e.returnValue = '';
      });

      var tyRetryBtn = document.getElementById('tyRetryBtn');
      // Every terminal failure on this page is logged with a reference
      // code (get-order-by-session is called via the raw SDK, so it does
      // not self-log), and the code is shown to the buyer next to a
      // "contact us" line so support has something to look up.
      function logOrderFail(reason, ctx) {
        try {
          if (window.coldAuth && window.coldAuth.logClientError) {
            return window.coldAuth.logClientError('checkout', reason, null, { fnName: 'get-order-by-session', context: Object.assign({
              method: cryptoOrderIdParam ? 'crypto' : paypalOrderIdParam ? 'paypal' : robuxOrderIdParam ? 'robux' : 'stripe',
              sessionId: sessionId || null, orderId: robuxOrderIdParam || cryptoOrderIdParam || null
            }, ctx || {}) });
          }
        } catch (e) {}
        return null;
      }
      function refLine(code) {
        return code ? ' <span class="co-msg-ref">Reference <strong>' + esc(code) + '</strong> - quote this if you contact us.</span>' : '';
      }
      function poll(triesLeft) {
        if (!sessionId && !robuxOrderIdParam && !cryptoOrderIdParam && !paypalOrderIdParam) {
          var nfcode = logOrderFail('Success page opened with no order/session identifier in the URL', { phase: 'no_identifier' });
          if (subEl) subEl.innerHTML = withSupportLine('We couldn\'t find an order to confirm.') + refLine(nfcode);
          if (titleEl) titleEl.textContent = 'Order not found';
          mark('fail');
          return;
        }
        if (!window.coldSupabase) {
          var nccode = logOrderFail('Success page could not init Supabase client', { phase: 'no_client' });
          if (subEl) subEl.innerHTML = withSupportLine('Could not connect. Please refresh the page.') + refLine(nccode);
          mark('fail');
          return;
        }
        // Looked up by Stripe session id (or, for Robux orders with no
        // Stripe session at all, the order id) via a service-role function,
        // not a direct table read - a guest order has no user_id for RLS to
        // match, so this is the only way (guest or signed-in) to see it
        // right after paying.
        window.coldSupabase.functions.invoke('get-order-by-session', { body: sessionId ? { sessionId: sessionId, token: claimToken } : { orderId: robuxOrderIdParam, token: claimToken } })
          .then(function (res) {
            var data = res && res.data;
            if (!data || !data.ok) {
              if (triesLeft > 0) { setTimeout(function () { poll(triesLeft - 1); }, 1500); return; }
              // A real "declined" state and "we just haven't found the row
              // yet" (a brief lookup hiccup, cold start, whatever) look
              // identical from here, but they are NOT the same claim to
              // make to someone who may have genuinely paid - a red X and
              // a dead end is exactly wrong if the charge went through and
              // this is only a lookup delay. Softer copy, plus a manual
              // retry that costs nothing to offer, instead of asserting
              // failure on a payment that might be completely fine.
              mark('fail');
              var nrcode = logOrderFail('Order row not found after ' + INITIAL_POLL_TRIES + ' tries on the success page', { phase: 'order_not_found', lastError: (data && data.error) || null });
              if (titleEl) titleEl.textContent = "Still confirming…";
              if (subEl) subEl.innerHTML = withSupportLine("We haven't been able to find this order yet. If you completed payment, it may just be taking a moment to show up - try again in a minute, or check your dashboard.") + refLine(nrcode);
              if (tyRetryBtn) tyRetryBtn.hidden = false;
              return;
            }
            if (data.status === 'paid') {
              mark('ok');
              if (tyRetryBtn) tyRetryBtn.hidden = true;
              if (titleEl) titleEl.textContent = 'Thank you for your order!';
              if (subEl) subEl.textContent = 'Payment confirmed - your files are ready below.';
              confettiBurst();
              renderItems(data.items || []);
              if (data.guest) showGuestClaimNote();
              maybeShowResellerPopup(data.items || []);
              maybeShowHowHeard();
              var orderAllResell = (data.items || []).length > 0 &&
                (data.items || []).every(function (it) { return it.licence === 'resell'; });
              renderPostPurchaseUpsell(orderAllResell);
            } else if (triesLeft > 0) {
              // Crypto sits in "pending" for real minutes while the network
              // confirms, so say that rather than leaving a blank wait.
              if (cryptoOrderIdParam && subEl) {
                subEl.textContent = 'Waiting for the network to confirm your payment. This usually takes a few minutes; you can close this page and your order will still complete.';
              }
              setTimeout(function () { poll(triesLeft - 1); }, 1500);
            } else if (subEl) {
              if (cryptoOrderIdParam) {
                // Genuinely fine to leave - the webhook finishes it. Not a failure.
                subEl.textContent = 'Still confirming on the network. Your order will complete automatically once it lands; check your dashboard shortly.';
              } else {
                mark('fail');
                var stcode = logOrderFail('Order still pending after ' + INITIAL_POLL_TRIES + ' tries on the success page', { phase: 'still_pending' });
                subEl.innerHTML = withSupportLine('Your payment is still finalizing. Check the Download Centre in your dashboard shortly.') + refLine(stcode);
                if (tyRetryBtn) tyRetryBtn.hidden = false;
              }
            }
          })
          .catch(function () {
            if (triesLeft > 0) { setTimeout(function () { poll(triesLeft - 1); }, 1500); return; }
            mark('fail');
            var pecode = logOrderFail('Success page order lookup kept erroring through all retries', { phase: 'poll_error' });
            if (subEl) subEl.innerHTML = withSupportLine("We couldn't check your order status right now. If you completed payment it's safe - quote the reference below and we'll finish it by hand.") + refLine(pecode);
            if (tyRetryBtn) tyRetryBtn.hidden = false;
          });
      }

      // "Build more for less" - same genre-matched, floor-checked discount
      // shape as the checkout cross-sell, but keyed off what was just
      // bought instead of what's in the cart, and with a bundle_deals
      // token instead of a per-line flag (this isn't the same checkout
      // request any more - the buyer already paid once, adding these is a
      // brand new order). Selecting/deselecting cards live-updates whether
      // the bigger bundle discount is still on offer, since bundle_pct
      // only applies server-side if EVERY offered slug ends up in the cart.
      function renderPostPurchaseUpsell(allResell) {
        var section = document.getElementById('upsellSection');
        var grid = document.getElementById('upsellGrid');
        if (!section || !grid || !window.coldSupabase) return;
        function resellUsd(p) { return p.resellPrice != null ? p.resellPrice : Math.round((p.priceNum || 0) * 3); }
        window.coldSupabase.functions.invoke('get-post-purchase-upsell', { body: sessionId ? { sessionId: sessionId } : { orderId: robuxOrderIdParam } })
          .then(function (res) {
            var data = res && res.data;
            if (!data || !data.ok || !data.items || !data.items.length) return;

            // The just-completed order was all resell licences -> only offer
            // resell licences of other relevant products, at the resell
            // price, added as resell. No bundle discount (resell licences
            // never carry the cross-sell/bundle discount).
            var items = data.items;
            if (allResell) {
              var cat = window.__CATALOG || [];
              items = items.map(function (it) {
                var p = cat.filter(function (c) { return c.id === it.slug; })[0];
                if (!p || !p.resell) return null;
                var rp = resellUsd(p);
                return { slug: it.slug, title: it.title, image: it.image, priceUsd: rp, itemPriceUsd: rp, bundlePriceUsd: rp, resell: true };
              }).filter(Boolean);
              if (!items.length) return;
            }

            section.hidden = false;
            var subEl2 = document.getElementById('upsellSub');
            if (subEl2 && allResell) subEl2.textContent = 'Resell licences for other products like the ones you just picked up.';
            var selected = {}; items.forEach(function (it) { selected[it.slug] = true; });
            function money2(n) { return window.__money ? window.__money(n) : ('$' + n.toFixed(2)); }
            function paint() {
              var selCount = Object.keys(selected).filter(function (s) { return selected[s]; }).length;
              var allSelected = selCount === items.length;
              grid.innerHTML = items.map(function (it) {
                var checked = !!selected[it.slug];
                var pct = it.resell ? 0 : (allSelected ? (data.itemPct + data.bundlePct) : data.itemPct);
                var price = it.resell ? it.itemPriceUsd : (allSelected ? it.bundlePriceUsd : it.itemPriceUsd);
                var metaHtml = it.resell
                  ? '<strong class="tu-now">' + money2(price) + '</strong> <span class="tu-off">Resell licence</span>'
                  : '<span class="tu-was">' + money2(it.priceUsd) + '</span> <strong class="tu-now">' + money2(price) + '</strong> <span class="tu-off">' + pct + '% off</span>';
                return '<div class="dash-card glass dl-item tu-item' + (checked ? ' is-in' : '') + '" data-slug="' + esc(it.slug) + '">' +
                  '<div class="dl-top">' +
                    '<span class="dl-thumb" style="background-image:url(\'' + window.imgUrl(it.image) + '\')"></span>' +
                    '<div class="dl-info">' +
                      '<div class="dl-name">' + esc(it.title) + '</div>' +
                      '<div class="dl-meta">' + metaHtml + '</div>' +
                    '</div>' +
                    '<div class="dl-actions">' +
                      '<button class="btn ' + (checked ? 'btn-ghost' : 'btn-primary') + ' tu-toggle" type="button" data-slug="' + esc(it.slug) + '">' + (checked ? 'Remove' : 'Add') + '</button>' +
                    '</div>' +
                  '</div>' +
                  '</div>';
              }).join('');
              var noteEl = document.getElementById('upsellNote');
              if (noteEl) {
                noteEl.textContent = allResell
                  ? (selCount + ' of ' + items.length + ' selected.')
                  : (allSelected
                    ? ('All ' + items.length + ' selected - ' + (data.itemPct + data.bundlePct) + '% off each.')
                    : (selCount + ' of ' + items.length + ' selected - ' + data.itemPct + '% off each (select all ' + items.length + ' for ' + (data.itemPct + data.bundlePct) + '% off).'));
              }
            }
            paint();
            grid.addEventListener('click', function (e) {
              var btn = e.target.closest('.tu-toggle'); if (!btn) return;
              var slug = btn.getAttribute('data-slug');
              selected[slug] = !selected[slug];
              paint();
            });
            var addAllBtn = document.getElementById('upsellAddAll');
            if (addAllBtn) addAllBtn.addEventListener('click', function () {
              var chosen = items.filter(function (it) { return selected[it.slug]; });
              if (!chosen.length) return;
              try {
                var cart = [];
                try { cart = JSON.parse(localStorage.getItem('coldd_cart_v1') || '[]') || []; } catch (e) {}
                chosen.forEach(function (it) {
                  var cid = it.resell ? (it.slug + '--resell') : it.slug;
                  if (cart.some(function (c) { return c.id === cid; })) return;
                  cart.push({ id: cid, title: it.title, price: it.priceUsd, image: window.imgUrl(it.image), tag: '', licence: it.resell ? 'resell' : 'standard', qty: 1 });
                });
                localStorage.setItem('coldd_cart_v1', JSON.stringify(cart));
                if (!allResell) localStorage.setItem('coldd_bundle_token', data.token);
                window.dispatchEvent(new CustomEvent('coldd:cart-sync', { detail: { source: 'upsell' } }));
              } catch (e) {}
              location.href = '/checkout';
            });
          }).catch(function () {});
      }

      var resellerOverlay = document.getElementById('resellerOverlay');
      var resellerForm = document.getElementById('resellerForm');
      function resellerShownKey() { return 'coldd_reseller_popup_' + (sessionId || robuxOrderIdParam); }
      var resellerLocked = false;
      function maybeShowResellerPopup(items) {
        if (!resellerOverlay || !resellerForm) return;
        var hasResell = items.some(function (it) { return it.licence === 'resell'; });
        if (!hasResell) return;
        // Only skips it once the info has actually been submitted - a
        // refresh without submitting brings it back, since it's required.
        try { if (localStorage.getItem(resellerShownKey())) return; } catch (e) {}
        resellerOverlay.hidden = false;
        resellerLocked = true;
        document.body.style.overflow = 'hidden';
        var first = document.getElementById('resellerContact');
        if (first) setTimeout(function () { first.focus(); }, 60);
      }
      // Genuinely no way out until it's submitted: Escape is swallowed, and
      // navigating away is challenged. (There's no close control or backdrop
      // dismiss in the markup.)
      document.addEventListener('keydown', function (e) {
        if (resellerLocked && (e.key === 'Escape' || e.key === 'Esc')) { e.preventDefault(); e.stopImmediatePropagation(); }
      }, true);
      window.addEventListener('beforeunload', function (e) {
        if (!resellerLocked) return;
        e.preventDefault();
        e.returnValue = '';
      });

      if (resellerOverlay && resellerForm) {
        var rsContact = document.getElementById('resellerContact');
        var rsLocWrap = document.getElementById('resellerLocations');
        var rsContactType = 'email';

        var rsSwitch = document.querySelector('.rs-contact-switch');
        if (rsSwitch) rsSwitch.addEventListener('click', function (e) {
          var b = e.target.closest('.bt-opt'); if (!b) return;
          rsContactType = b.getAttribute('data-ctype');
          rsSwitch.querySelectorAll('.bt-opt').forEach(function (o) {
            var on = o === b; o.classList.toggle('active', on); o.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          rsContact.type = rsContactType === 'email' ? 'email' : 'text';
          rsContact.placeholder = rsContactType === 'email' ? 'you@example.com' : 'Your Discord username or server invite';
          rsContact.value = '';
          var lbl0 = resellerForm.querySelector('.rs-field label'); if (lbl0) lbl0.textContent = 'Contact method';
          var h0 = resellerForm.querySelector('.rs-prefill-note'); if (h0) h0.remove();
        });

        // Pre-fill contact from a linked email / Discord identity, so a
        // signed-in reseller can just confirm it.
        if (window.coldSupabase && window.coldSupabase.auth) {
          window.coldSupabase.auth.getUser().then(function (ur) {
            var u = ur && ur.data && ur.data.user; if (!u || rsContact.value) return;
            var raw = String(u.email || '');
            var email = (raw && !/@.*\.coldd\.internal$/i.test(raw)) ? raw : null;
            var di = (u.identities || []).filter(function (i) { return i.provider === 'discord'; })[0];
            var dd = (di && di.identity_data) || {}; var cc = dd.custom_claims || {};
            var discord = cc.global_name || dd.full_name || dd.name || dd.user_name || null;
            var lt = email ? 'email' : (discord ? 'discord' : null); if (!lt) return;
            rsContactType = lt;
            rsSwitch.querySelectorAll('.bt-opt').forEach(function (o) {
              var on = o.getAttribute('data-ctype') === lt;
              o.classList.toggle('active', on); o.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            rsContact.type = lt === 'email' ? 'email' : 'text';
            rsContact.value = email || discord;
            var lbl = resellerForm.querySelector('.rs-field label');
            if (lbl) lbl.textContent = 'Is this contact method right?';
            if (!resellerForm.querySelector('.rs-prefill-note')) {
              var h = document.createElement('p');
              h.className = 'rs-prefill-note';
              h.textContent = 'Pre-filled from your linked ' + (lt === 'email' ? 'email' : 'Discord') + '. Confirm it by submitting, or edit it if you sell under a different contact.';
              rsContact.parentNode.appendChild(h);
            }
          }).catch(function () {});
        }

        function resellerLocRows() { return rsLocWrap ? Array.prototype.slice.call(rsLocWrap.querySelectorAll('.rs-loc-row')) : []; }
        function syncLocRemoveButtons() {
          var rows = resellerLocRows();
          rows.forEach(function (r) {
            var x = r.querySelector('.rs-loc-x');
            if (x) x.disabled = rows.length <= 1;
          });
        }
        function addResellerLocRow() {
          if (!rsLocWrap) return;
          var row = document.createElement('div');
          row.className = 'rs-loc-row';
          row.innerHTML =
            '<input type="text" class="rs-input rs-loc-platform" autocomplete="off" placeholder="Platform (eg: BuiltByBit, ClearlyDev, Discord)" />' +
            '<input type="url" class="rs-input rs-loc-url" autocomplete="off" placeholder="Link to your store / profile" />' +
            '<button type="button" class="rs-loc-x" aria-label="Remove location"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
          row.querySelector('.rs-loc-x').addEventListener('click', function () {
            if (resellerLocRows().length <= 1) return;
            row.remove(); syncLocRemoveButtons();
          });
          rsLocWrap.appendChild(row);
          syncLocRemoveButtons();
        }
        var rsAddLoc = document.getElementById('resellerAddLoc');
        if (rsAddLoc) rsAddLoc.addEventListener('click', addResellerLocRow);
        // Start with three rows - only one needs filling in.
        addResellerLocRow(); addResellerLocRow(); addResellerLocRow();

        resellerForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var submitBtn = document.getElementById('resellerSubmit');
          var msgEl = document.getElementById('resellerMsg');
          var setMsg = function (t) { if (msgEl) msgEl.textContent = t || ''; };

          var contactValue = rsContact.value.trim();
          if (!contactValue) { setMsg(rsContactType === 'email' ? 'Enter a contact email.' : 'Enter your Discord.'); rsContact.focus(); return; }

          var locations = [];
          var bad = false;
          resellerLocRows().forEach(function (r) {
            var platform = r.querySelector('.rs-loc-platform').value.trim();
            var url = r.querySelector('.rs-loc-url').value.trim();
            if (!platform && !url) return;
            if (!platform || !url) bad = true;
            else locations.push({ platform: platform, url: url });
          });
          if (bad) { setMsg('Every selling location needs both a platform and a link.'); return; }
          if (!locations.length) { setMsg('Add at least one place you’ll be selling, with a link.'); return; }

          var payload = {
            contactType: rsContactType,
            contactValue: contactValue,
            sellingLocations: locations,
            notes: document.getElementById('resellerNotes').value.trim() || null
          };
          if (sessionId) payload.sessionId = sessionId; else payload.orderId = robuxOrderIdParam;
          payload.token = claimToken;
          submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
          setMsg('');
          window.coldSupabase.functions.invoke('submit-reseller-info', { body: payload })
            .then(function (res) {
              var data = res && res.data;
              if (!data || !data.ok) {
                submitBtn.disabled = false; submitBtn.textContent = 'Submit';
                setMsg((data && data.error) || 'Could not save, please try again.');
                return;
              }
              try { localStorage.setItem(resellerShownKey(), '1'); } catch (e2) {}
              resellerLocked = false;
              document.body.style.overflow = '';
              resellerOverlay.hidden = true;
              var done = document.getElementById('resellerDoneOverlay');
              if (done) done.hidden = false;
            })
            .catch(function () {
              submitBtn.disabled = false; submitBtn.textContent = 'Submit';
              setMsg('Could not save, please try again.');
            });
        });

        var resellerDoneClose = document.getElementById('resellerDoneClose');
        if (resellerDoneClose) resellerDoneClose.addEventListener('click', function () {
          var done = document.getElementById('resellerDoneOverlay');
          if (done) done.hidden = true;
        });
      }

      // Capture first, then poll. If the capture call itself fails we still
      // poll: the order may already have been captured by an earlier attempt,
      // and the poll is what tells the buyer the truth either way. The function
      // is idempotent, so a retry here is always safe.
      // 10 tries (15s) used to be the whole budget, including for the
      // "order not found at all" case - a lookup hiccup or a moment of
      // replication/propagation lag on a real, successful payment had no
      // more patience than a genuinely nonexistent order, and no recovery
      // once that ran out. 30 tries (~45s) up front, plus the manual retry
      // wired below, instead of asserting failure on a fresh time budget.
      var INITIAL_POLL_TRIES = 30;
      if (tyRetryBtn) tyRetryBtn.addEventListener('click', function () {
        tyRetryBtn.hidden = true;
        tyRetryBtn.disabled = true;
        if (titleEl) titleEl.textContent = 'Confirming your payment…';
        if (subEl) subEl.textContent = 'Hang tight, this only takes a moment.';
        if (markEl) markEl.setAttribute('data-state', 'pending');
        if (tyRoot) tyRoot.setAttribute('data-state', 'pending');
        poll(INITIAL_POLL_TRIES);
        tyRetryBtn.disabled = false;
      });

      if (paypalOrderIdParam && window.coldSupabase) {
        if (titleEl) titleEl.textContent = 'Completing your payment…';
        if (subEl) subEl.textContent = 'Confirming with PayPal. Please do not close this page.';
        window.coldSupabase.functions
          .invoke('capture-paypal-order', { body: { orderId: paypalOrderIdParam } })
          .then(function (res) {
            var data = res && res.data, error = res && res.error;
            if (error || (data && data.ok === false)) {
              // A hard failure here means money did not move. Say so plainly
              // rather than letting the poll time out into a vague message,
              // and log it - this is not called via invokeFn so it won't
              // self-report to the audit log otherwise.
              var pmsg = (data && data.error) || (error && error.message) || 'PayPal could not complete this payment.';
              var pcode = null;
              try {
                if (window.coldAuth && window.coldAuth.logClientError) {
                  pcode = window.coldAuth.logClientError('checkout', pmsg, null, { fnName: 'capture-paypal-order', context: { paypalOrderId: paypalOrderIdParam } });
                }
              } catch (e) {}
              if (subEl) {
                mark('fail');
                subEl.innerHTML = withSupportLine(esc(pmsg)) + (pcode ? ' <span class="co-msg-ref">Reference <strong>' + esc(pcode) + '</strong> - quote this if you contact us.</span>' : '');
              }
            }
          })
          .catch(function () {})
          .then(function () { poll(INITIAL_POLL_TRIES); });
      } else {
        poll(INITIAL_POLL_TRIES);
      }
    })();
