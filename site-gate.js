// site-gate.js
//
// Loaded on every page, right after supabase-init.js. Checks the
// site-wide mode (open / maintenance) and gates accordingly.
//
// FAIL-SAFE BY DESIGN: any error, missing data, or unexpected response
// while checking site_status is treated as "open" (do nothing). This
// must never be able to lock out the whole site because of a network
// hiccup or a misconfigured row - the failure mode is "gate didn't
// apply", never "gate applied when it shouldn't have".
(function () {
  // Release the pre-paint visibility hold that the inline <head> snippet
  // puts on <html> whenever the last known site mode was "maintenance".
  // That snippet hides the page before first paint so a visitor can't
  // network-freeze the tab in the gap before this script runs and read a
  // stale, non-functional copy of the storefront underneath - the
  // maintenance overlay used to be injected only AFTER the page had
  // already rendered, so a well-timed pause in the Network panel showed
  // the whole site with nothing covering it. This function is the only
  // thing that clears the hold other than its own 10s fail-open timeout,
  // so every code path that decides "this visitor may see the page" has
  // to call it. It is a harmless no-op on pages that were never held.
  function releaseGateHold() {
    try { if (window.__coldGateHold) { clearTimeout(window.__coldGateHold); window.__coldGateHold = null; } } catch (e) {}
    try { document.documentElement.style.visibility = ''; } catch (e) {}
  }
  // Cache the current mode so the inline <head> snippet on the NEXT page
  // load knows whether to hold. Only ever written from a definitive
  // answer - never from an errored/timed-out check, which must not be
  // able to downgrade a real "maintenance" to "open".
  function rememberMode(mode) {
    try { localStorage.setItem('coldd_site_mode', mode === 'maintenance' ? 'maintenance' : 'open'); } catch (e) {}
  }

  if (!window.coldSupabase) { releaseGateHold(); return; }

  var path = location.pathname.replace(/\/+$/, '') || '/';
  // Never gate:
  //  - the shared-password unlock page itself
  //  - the admin panel (its own Discord-whitelist gate; must stay reachable
  //    so an admin can turn maintenance back off)
  //  - the auth pages - otherwise a whitelisted tester who isn't already
  //    signed in has no way to sign in (the overlay would cover the form),
  //    so "tester access" is unreachable during maintenance.
  var AUTH_PATHS = ['/signin', '/signup', '/forgot', '/reset', '/callback', '/roblox-callback', '/lock'];
  if (AUTH_PATHS.indexOf(path) !== -1 || AUTH_PATHS.indexOf(path.replace(/\.html$/, '')) !== -1 || path.indexOf('/admin') === 0) {
    // These paths are excluded from the inline hold too (they must stay
    // reachable during maintenance) - this is just belt-and-braces.
    releaseGateHold();
    return;
  }

  function fmtCountdown(ms) {
    if (ms <= 0) return 'Back shortly';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var parts = [];
    if (h) parts.push(h + 'h');
    if (h || m) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  }

  var PREVIEW_KEY = 'coldd_maint_preview';
  var WHITELIST_DISMISS_KEY = 'coldd_whitelist_banner_dismissed';

  // Both blocking overlays below append to document.documentElement (a
  // sibling of <body>, not a child of it), specifically so this can hide
  // the real page - every product, every button, everything - without
  // touching the overlay itself. Before this, the overlay was the ONLY
  // thing standing between a visitor and a fully working site: deleting
  // that one <div> in DevTools (or just never loading a browser at all -
  // calling an Edge Function directly skips this file completely) left a
  // completely normal, completely functional storefront underneath. This
  // doesn't make that impossible - nothing client-side on a static site
  // ever can - but it's no longer a single element away, and the checkout
  // functions themselves now independently refuse to run during
  // maintenance regardless of what this script did or didn't manage to
  // hide (see _shared/maintenance.ts) - that's the part that actually
  // matters; this is just not handing out the storefront for free too.
  function lockBody() { document.body.style.setProperty('display', 'none', 'important'); }
  function unlockBody() { document.body.style.removeProperty('display'); }

  // adminPreview: true when a whitelisted staff member has opted to see
  // the public-facing screen rather than being auto-bypassed. Swaps the
  // lock/sign-in control for an "Exit preview" pill that hands them
  // straight back to showWhitelistBanner - no reload, no re-auth.
  function showMaintenanceOverlay(status, adminPreview) {
    if (document.getElementById('siteMaintenanceOverlay')) return;
    var endsAt = status.maintenance_ends_at ? new Date(status.maintenance_ends_at).getTime() : null;
    var msg = status.maintenance_message
      ? String(status.maintenance_message).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; })
      : "We're pushing an update. Back shortly.";

    var overlay = document.createElement('div');
    overlay.id = 'siteMaintenanceOverlay';
    overlay.className = 'gate-overlay';
    overlay.innerHTML =
      '<div class="gate-card glass">' +
        '<img class="gate-logo" src="/logo.png" alt="coldd" />' +
        (adminPreview ? '<p class="gate-eyebrow">Staff preview - visitors see this screen</p>' : '') +
        '<h2>Site under maintenance</h2>' +
        '<p class="gate-msg">' + msg + '</p>' +
        (endsAt ? '<p id="siteMaintCountdown" class="gate-countdown"></p>' : '') +
      '</div>' +
      (adminPreview
        ? '<button id="siteMaintExit" class="btn btn-tinted gate-lock" type="button">Exit preview</button>'
        : '<button id="siteMaintLock" class="gate-lock pm-x" aria-label="Staff sign in">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
          '</button>');
    document.documentElement.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    lockBody();

    if (endsAt) {
      var cdEl = document.getElementById('siteMaintCountdown');
      var tick = function () {
        if (!cdEl) return;
        cdEl.textContent = fmtCountdown(endsAt - Date.now());
      };
      tick();
      setInterval(tick, 1000);
    }

    if (adminPreview) {
      document.getElementById('siteMaintExit').addEventListener('click', function () {
        try { sessionStorage.removeItem(PREVIEW_KEY); } catch (e) {}
        overlay.remove();
        document.body.style.overflow = '';
        unlockBody();
        showWhitelistBanner(status);
      });
      return;
    }

    var lockBtn = document.getElementById('siteMaintLock');
    lockBtn.addEventListener('click', function () {
      if (document.getElementById('siteMaintSignin')) return;
      var box = document.createElement('div');
      box.id = 'siteMaintSignin';
      box.className = 'gate-signin glass';
      box.innerHTML = '<p>Staff sign-in only. Signing in does not grant public access during maintenance.</p>' +
        '<button id="siteMaintDiscord" class="auth-oauth" type="button" data-provider="Discord">' +
          '<svg viewBox="0 0 24 24" fill="#5865F2"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>' +
          ' Sign in with Discord' +
        '</button>' +
        '<button id="siteMaintRoblox" class="auth-oauth" type="button" data-provider="Roblox">' +
          '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M18.926 23.998 0 18.892 5.075.002 24 5.108ZM15.348 10.09l-5.282-1.453-1.414 5.273 5.282 1.453z"/></svg>' +
          ' Sign in with Roblox' +
        '</button>';
      overlay.appendChild(box);
      document.getElementById('siteMaintDiscord').addEventListener('click', function () {
        if (window.coldAuth) window.coldAuth.signInDiscord();
      });
      document.getElementById('siteMaintRoblox').addEventListener('click', function () {
        // Roblox-only staff accounts (e.g. coldd_analytics) have no Discord to
        // sign in with. Come back to the page they were on - site-gate re-runs
        // on load and grants the bypass view once the session exists.
        if (window.coldAuth) window.coldAuth.signInRoblox(location.pathname + location.search);
      });
    });
  }

  // Bypassed staff view: the real page renders underneath, with a bar
  // making clear maintenance is still on for everyone else and a way to
  // see exactly what they see, without signing out or losing the session.
  function showWhitelistBanner(status, isTester) {
    var existing = document.getElementById('siteWhitelistBanner');
    if (existing) return;
    var banner = document.createElement('div');
    banner.id = 'siteWhitelistBanner';
    banner.className = 'gate-banner';
    banner.innerHTML =
      '<span>' + (isTester
        ? 'Tester access - the site is in maintenance for everyone else. Report anything broken.'
        : 'You\'re viewing as a whitelisted staff member - the site is still under maintenance for everyone else.') + '</span>' +
      '<button id="siteMaintPreviewBtn" type="button">Preview maintenance screen</button>' +
      '<button id="siteMaintBannerX" type="button" aria-label="Dismiss">&times;</button>';
    document.documentElement.appendChild(banner);
    document.getElementById('siteMaintPreviewBtn').addEventListener('click', function () {
      try { sessionStorage.setItem(PREVIEW_KEY, '1'); } catch (e) {}
      banner.remove();
      showMaintenanceOverlay(status, true);
    });
    // This is a static multi-page site, not an SPA - every click to a
    // different page re-runs this whole script and re-creates the banner
    // from nothing, so without remembering the dismissal a staff member
    // had to close this same banner again on every single page they
    // visited during maintenance ("why does this keep coming back").
    // sessionStorage persists it across pages but clears when the tab
    // closes, so it's a per-page-view choice, not a permanent opt-out of
    // ever being reminded maintenance mode is on.
    document.getElementById('siteMaintBannerX').addEventListener('click', function () {
      try { sessionStorage.setItem(WHITELIST_DISMISS_KEY, '1'); } catch (e) {}
      banner.remove();
    });
  }

  function dropBanner() {
    var b = document.getElementById('siteWhitelistBanner');
    if (b) b.remove();
  }

  function runMaintenanceCheck() {
   // Explicit columns: the tester allowlist is not publicly readable.
   window.coldSupabase.from('site_status').select('id, mode, maintenance_message, maintenance_ends_at, updated_at').eq('id', true).maybeSingle().then(function (res) {
    if (res && res.error) { releaseGateHold(); return; } // fail open, don't touch the cached mode
    var status = res && res.data;
    if (!status || status.mode === 'open') { rememberMode('open'); releaseGateHold(); return; }

    if (status.mode === 'maintenance') {
      rememberMode('maintenance');
      // Do NOT release the hold here. Which of the two paths below applies
      // (overlay for visitors, banner for bypassed staff) is only known
      // after the async session/admin check below resolves - releasing the
      // hold before that point used to let the real, fully-functional page
      // paint and sit visible for the length of that round trip, every
      // single load, before the overlay finally covered it. The hold is
      // only lifted at the point content actually gets covered (by the
      // overlay) or is deliberately shown (the bypass banner path).
      // Bypassed view: the real page renders, with the "still in maintenance
      // for everyone else" banner (or the preview overlay if they asked for
      // it). Granted to staff (checkIsAdmin) and to any non-admin account on
      // the per-user allowlist (site_status.maintenance_allow_user_ids -
      // edited from the admin Site Access panel; empty = nobody extra).
      var grantBypassView = function (isTester) {
        var previewing = false;
        try { previewing = sessionStorage.getItem(PREVIEW_KEY) === '1'; } catch (e) {}
        var dismissed = false;
        try { dismissed = sessionStorage.getItem(WHITELIST_DISMISS_KEY) === '1'; } catch (e) {}
        if (previewing) showMaintenanceOverlay(status, true);
        else if (!dismissed) showWhitelistBanner(status, isTester);
        releaseGateHold();
      };
      window.coldSupabase.auth.getSession().then(function (sres) {
        var session = sres && sres.data ? sres.data.session : null;
        // If a tester's bypass is pulled while they sit on the page (removed
        // from the allowlist, or maintenance just came on), the stale
        // "tester access" banner has to go before the real overlay drops.
        if (!session) { dropBanner(); showMaintenanceOverlay(status); releaseGateHold(); return; }
        // The allowlist itself is private; the database only says whether THIS
        // account is on it. An error counts as "not a tester" (admin check next).
        Promise.resolve(window.coldSupabase.rpc('is_maintenance_tester')).then(function (r) {
          return !!(r && !r.error && r.data === true);
        }, function () { return false; }).then(function (isTester) {
          if (isTester) { grantBypassView(true); return; }
          window.coldAuth.checkIsAdmin().then(function (info) {
            if (!info.isAdmin) { dropBanner(); showMaintenanceOverlay(status); releaseGateHold(); return; }
            grantBypassView(false);
          });
        });
      }).catch(function () {
        // Session check itself failed - fail open per file header, but
        // still cover with the overlay first so a network hiccup here
        // doesn't hand out the real page during a known maintenance window.
        showMaintenanceOverlay(status);
        releaseGateHold();
      });
    }
   }).catch(function () {
    releaseGateHold();
    // Fail open - see file header.
   });
  }

  // Separate, independent check: a banned account gets signed out and
  // told why, no matter which page it's on. Also fails open on any
  // error - a check that couldn't complete must never itself look like
  // a ban.
  function runBanCheck() {
    if (document.getElementById('siteBannedOverlay')) return;
    window.coldSupabase.auth.getSession().then(function (sres) {
      var session = sres && sres.data ? sres.data.session : null;
      if (!session) return;
      window.coldSupabase.from('profiles').select('banned, ban_reason').eq('id', session.user.id).maybeSingle().then(function (pres) {
        var prof = pres && pres.data;
        if (!prof || !prof.banned) return;
        if (document.getElementById('siteBannedOverlay')) return;
        window.coldSupabase.auth.signOut().catch(function () {}).then(function () {
          try { localStorage.setItem('coldd_auth', 'out'); } catch (e) {}
          try { localStorage.removeItem('coldd_profile'); } catch (e) {}
          var overlay = document.createElement('div');
          overlay.id = 'siteBannedOverlay';
          overlay.className = 'gate-overlay';
          overlay.innerHTML = '<div class="gate-card glass">' +
            '<img class="gate-logo" src="/logo.png" alt="coldd" />' +
            '<h2>Account suspended</h2>' +
            '<p class="gate-msg">' + (prof.ban_reason ? String(prof.ban_reason).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }) : 'Contact support if you believe this is a mistake.') + '</p>' +
            '<p class="gate-msg" style="margin-top:14px;"><a href="mailto:support@coldd.dev" style="color:var(--accent);font-weight:600;">support@coldd.dev</a></p>' +
          '</div>';
          document.documentElement.appendChild(overlay);
          document.body.style.overflow = 'hidden';
          lockBody();
        });
      }).catch(function () {});
    }).catch(function () {});
  }

  runMaintenanceCheck();
  runBanCheck();

  // Revocation used to only take effect on the next full page load - a
  // banned user or a tester whose access was pulled kept browsing until
  // they happened to navigate. Re-run both checks on a short interval
  // (paused while the tab is hidden, re-checked the moment it's focused
  // again) so it lands within ~45s instead of "whenever they reload".
  // Matches the polling the notification bell already uses - no realtime
  // channel wiring anywhere in this codebase. Still fully fail-open: a
  // check that errors does nothing.
  var REVOKE_POLL_MS = 45000;
  var pollId = setInterval(function () {
    if (document.hidden) return;
    runMaintenanceCheck();
    runBanCheck();
  }, REVOKE_POLL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    runMaintenanceCheck();
    runBanCheck();
  });
  window.addEventListener('beforeunload', function () { clearInterval(pollId); });
})();
