(function () {
  var SUPABASE_URL = 'https://ekinmytmudjwfaqaqswp.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_q5JwjFnMT_0Uhu5rAlAkQA_DEGnhwV7';
  // Set this to your Coldd Development Discord server's guild ID to enable
  // per-member role/nickname lookups via the guilds.members.read scope.
  // Leave empty to skip that lookup (guild LIST still works either way).
  var TARGET_GUILD_ID = '1247414059909779578';
  var PROFILE_KEY = 'coldd_profile';
  var AUTH_KEY = 'coldd_auth';

  // Roblox OAuth app client ID (public, safe to inline - same as the
  // Discord guild ID above). Set once the OAuth app is created at
  // create.roblox.com/dashboard/credentials/oauth; account linking is a
  // no-op until then.
  var ROBLOX_OAUTH_CLIENT_ID = '6729807859304248011';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[coldd] Supabase SDK failed to load.');
    return;
  }
  // Session (access + refresh token) storage. This was sessionStorage -
  // cleared the moment the tab/browser closes, which shrinks how long a
  // stolen token (XSS, shared machine) stays useful, but also meant every
  // visitor got signed out just from closing their browser. Moved to
  // localStorage (supabase-js's own default) to actually persist across
  // sessions like a normal site login. This is not a security downgrade
  // relative to a plain cookie - a JS-readable cookie is exactly as
  // exposed to XSS as localStorage is, since what matters is whether JS
  // can read it, not which API it's stored behind. The real fix for that
  // class of exposure is httpOnly cookies plus a server that mediates
  // every Supabase call, which is a proxy-layer architecture change this
  // static site doesn't have yet, not a storage flag.
  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storage: window.localStorage }
  });
  window.coldSupabase = client;

  // Resolves to {} once the browser has been sent to the provider, or
  // { error } if it could not be. Navigation is done here rather than by the
  // SDK (skipBrowserRedirect) so a missing/invalid URL is a visible error.
  function startOAuth(params) {
    params.options = Object.assign({}, params.options, { skipBrowserRedirect: true });
    return client.auth.signInWithOAuth(params).then(function (res) {
      if (res.error || !res.data || !res.data.url) {
        var err = res.error || new Error('No sign-in URL was returned.');
        console.error('[coldd] OAuth start failed:', err);
        return { error: err };
      }
      location.assign(res.data.url);
      return {};
    }).catch(function (e) {
      console.error('[coldd] OAuth start threw:', e);
      return { error: e };
    });
  }


  // Cart and wishlist are both pure localStorage with no per-user
  // namespacing (cart has no backend at all; wishlist mirrors into
  // wishlist_items but always reads back from localStorage first - see
  // app.js). On a shared/borrowed browser, signing into a DIFFERENT
  // account than whichever one (or guest state) last touched this
  // browser silently inherited that previous cart/wishlist - a real
  // privacy bug, not just a stale-cache annoyance. ACCOUNT_KEY tracks
  // which account (or '' for guest) the current local cart/wishlist
  // actually belong to; any mismatch resets both before anything else
  // reads them. A first-ever guest->sign-in transition (stored === null,
  // meaning this browser has never been associated with any account) is
  // deliberately NOT treated as a mismatch - that's very likely the same
  // person continuing a guest session into their own new account, not a
  // different person inheriting someone else's cart.
  var ACCOUNT_KEY = 'coldd_account_uid';
  function resetLocalCartAndWishlist() {
    try { localStorage.setItem('coldd_cart_v1', '[]'); } catch (e) {}
    try { localStorage.setItem('coldd_wish_v1', '[]'); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('coldd:cart-sync', { detail: { source: 'account-switch' } })); } catch (e) {}
  }
  // Repopulates the wishlist from the newly-signed-in account's real
  // wishlist_items rows - without this, a reset (or a brand new browser)
  // shows an empty wishlist even though the account has real saved items
  // server-side.
  function restoreWishlistFor(uid) {
    client.from('wishlist_items').select('products(slug)').eq('user_id', uid).then(function (res) {
      var rows = (res && res.data) || [];
      var slugs = rows.map(function (r) { return r.products && r.products.slug; }).filter(Boolean);
      if (!slugs.length) return;
      try { localStorage.setItem('coldd_wish_v1', JSON.stringify(slugs)); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('coldd:cart-sync', { detail: { source: 'account-switch' } })); } catch (e) {}
    }).catch(function () {});
  }
  var lastReconciledUid; // avoids re-running for the same uid on every redundant auth event
  function reconcileAccountLocalState(uid) {
    var current = uid || '';
    if (current === lastReconciledUid) return;
    lastReconciledUid = current;
    var stored = null;
    try { stored = localStorage.getItem(ACCOUNT_KEY); } catch (e) {}
    if (stored !== null && stored !== current) {
      resetLocalCartAndWishlist();
      if (uid) restoreWishlistFor(uid);
    }
    try { localStorage.setItem(ACCOUNT_KEY, current); } catch (e) {}
  }
  client.auth.getSession().then(function (res) {
    var session = res && res.data && res.data.session;
    reconcileAccountLocalState(session && session.user && session.user.id);
  }).catch(function () {});
  client.auth.onAuthStateChange(function (_event, session) {
    reconcileAccountLocalState(session && session.user && session.user.id);
  });

  // Site-wide error capture: uncaught JS errors, unhandled promise
  // rejections, and failed Edge Function calls, from any visitor - signed
  // in or not, since errors often happen exactly when something (like
  // auth) is already broken. Each report gets a short code a visitor can
  // actually read back to support ("it said ERR-4K9X2P"), which shows up
  // next to staff actions in the admin audit log. See
  // supabase/client_errors.sql for the table this writes to - insert is
  // open to anon on purpose (a write-only report can't leak anything back
  // to the reporter), select is admin-only.
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - hand-copied into a support message
  function genErrorCode() {
    var s = '';
    for (var i = 0; i < 6; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    return 'ERR-' + s;
  }
  function logClientError(kind, message, stack, extra) {
    try {
      var code = genErrorCode();
      client.auth.getSession().then(function (res) {
        var uid = (res && res.data && res.data.session && res.data.session.user && res.data.session.user.id) || null;
        var row = {
          code: code, kind: kind, message: String(message || '').slice(0, 2000),
          stack: stack ? String(stack).slice(0, 8000) : null,
          fn_name: (extra && extra.fnName) || null,
          page_url: location.href, user_agent: navigator.userAgent, user_id: uid,
          context: (extra && extra.context) || null
        };
        // A PostgREST builder is a thenable but has no .catch(), so
        // `.insert(row).catch(...)` threw synchronously and the insert
        // never fired - every client error report was silently dropped.
        // Use the two-arg .then() to swallow failures instead.
        client.from('client_errors').insert(row).then(null, function () {});
      }, function () {});
      return code;
    } catch (e) { return null; }
  }
  window.addEventListener('error', function (e) {
    // Cross-origin scripts (the Google Fonts stylesheet, jsDelivr's
    // Supabase SDK bundle) report as "Script error." with no stack when
    // something inside them throws - nothing actionable to log there.
    if (!e || e.message === 'Script error.') return;
    logClientError('js_error', e.message, e.error && e.error.stack, { context: { line: e.lineno, col: e.colno, src: e.filename } });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var message = (reason && (reason.message || String(reason))) || 'Unhandled rejection';
    logClientError('unhandled_rejection', message, reason && reason.stack);
  });

  // supabase-js's functions.invoke() does NOT parse the JSON body into
  // res.data on a non-2xx response - it's null, and res.error.message is
  // always the generic "Edge Function returned a non-2xx status code".
  // The real error body lives on res.error.context (the raw Response).
  function invokeFn(name, body) {
    return client.functions.invoke(name, { body: body || {} }).then(function (res) {
      if (res.error) {
        var ctx = res.error.context;
        var parsed = (ctx && typeof ctx.json === 'function') ? ctx.json().catch(function () { return null; }) : Promise.resolve(null);
        return parsed.then(function (data) {
          var msg = (data && data.error) || res.error.message || 'Request failed.';
          var ecode = logClientError('edge_function', msg, null, { fnName: name, context: { status: ctx && ctx.status } });
          var err = new Error(msg);
          if (data && data.code) err.code = data.code;
          if (ecode) err.errCode = ecode;
          throw err;
        });
      }
      if (!res.data || !res.data.ok) {
        var failMsg = (res.data && res.data.error) || 'Request failed.';
        var fcode = logClientError('edge_function', failMsg, null, { fnName: name });
        var failErr = new Error(failMsg);
        if (res.data && res.data.code) failErr.code = res.data.code;
        if (fcode) failErr.errCode = fcode;
        throw failErr;
      }
      return res.data;
    });
  }

  // Real access check, backed by profiles.is_admin/role (RLS-enforced -
  // this is the same flag every admin-* Edge Function checks server-side,
  // not a separate client-side list). role is 'owner'/'admin'/'support',
  // set manually via SQL for now; a signed-in admin with is_admin=true but
  // no role yet defaults to 'admin' so existing staff aren't locked out.
  // checkIsAdmin() is two network round trips (getUser, then the profiles
  // row), so the staff-only nav affordances it gates used to pop in a
  // second or two after the rest of the page. This caches the last result
  // in localStorage: isAdminCached() is a synchronous read the callers use
  // to render optimistically on the next load, and checkIsAdmin() still
  // runs to confirm (and correct, or clear the cache) in the background.
  var ADMIN_KEY = 'coldd_is_admin';
  function cacheAdmin(info) {
    try {
      if (info && info.isAdmin) localStorage.setItem(ADMIN_KEY, JSON.stringify({ isAdmin: true, role: info.role || 'admin' }));
      else localStorage.removeItem(ADMIN_KEY);
    } catch (e) {}
  }
  function isAdminCached() {
    try {
      var v = JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null');
      return (v && v.isAdmin) ? { isAdmin: true, role: v.role || 'admin' } : null;
    } catch (e) { return null; }
  }

  function checkIsAdmin() {
    return client.auth.getUser().then(function (res) {
      var user = res && res.data && res.data.user;
      if (!user) { cacheAdmin(null); return { isAdmin: false, role: null, username: null, id: null }; }
      return client.from('profiles').select('is_admin, role, username, email').eq('id', user.id).single().then(function (pRes) {
        if (pRes.error || !pRes.data) return { isAdmin: false, role: null, username: null, id: user.id };
        var isAdmin = !!pRes.data.is_admin;
        var info = {
          isAdmin: isAdmin,
          role: pRes.data.role || (isAdmin ? 'admin' : null),
          username: pRes.data.username || pRes.data.email || null,
          id: user.id
        };
        cacheAdmin(info);
        return info;
      });
    }).catch(function () { return { isAdmin: false, role: null, username: null, id: null }; });
  }
  checkIsAdmin.cached = isAdminCached;

  var REF_KEY = 'coldd_ref_code';
  var REF_SLUG_KEY = 'coldd_ref_slug';
  // Referrals are per-product only: a link only ever looks like
  // /product/<slug>?ref=CODE (see the product page's "Refer this product"
  // widget and the dashboard's per-product link table), so the product is
  // read straight off the URL path rather than tracked server-side at
  // click time. Checkout reads both back via getReferralAttribution() -
  // same "carried in localStorage until order-creation time" pattern as
  // getCampaignCode() below - and the order-creation function is the one
  // that actually validates the code and that the referred product is in
  // the cart (see _shared/referrals.ts).
  (function captureReferralClick() {
    try {
      var m = /[?&]ref=([^&]+)/.exec(location.search);
      if (!m) return;
      var code = decodeURIComponent(m[1]).trim().toLowerCase();
      if (!code) return;
      var slugMatch = /^\/product\/([^/?#]+)/.exec(location.pathname);
      if (!slugMatch) return;
      localStorage.setItem(REF_KEY, code);
      localStorage.setItem(REF_SLUG_KEY, decodeURIComponent(slugMatch[1]));
    } catch (e) {}
  })();
  function getReferralAttribution() {
    try {
      var code = localStorage.getItem(REF_KEY);
      var slug = localStorage.getItem(REF_SLUG_KEY);
      if (!code || !slug) return null;
      return { code: code, slug: slug };
    } catch (e) { return null; }
  }

  var CAMPAIGN_KEY = 'coldd_campaign_code';
  // Captures ?cmp=CODE the same way captureReferralClick() captures ?ref= -
  // a separate query param and separate table on purpose, since campaign
  // links are admin-managed marketing links (partners, sponsors), not the
  // user-to-user referral program. Read by checkout at order-creation time
  // via getCampaignCode(), not attributed to a signed-in profile the way
  // referrals are, so it works for guest checkouts too.
  (function captureCampaignClick() {
    try {
      var m = /[?&]cmp=([^&]+)/.exec(location.search);
      if (!m) return;
      var code = decodeURIComponent(m[1]).trim().toLowerCase();
      if (!code) return;
      localStorage.setItem(CAMPAIGN_KEY, code);
      invokeFn('track-campaign-click', { code: code }).catch(function () {});
    } catch (e) {}
  })();
  function getCampaignCode() {
    try { return localStorage.getItem(CAMPAIGN_KEY); } catch (e) { return null; }
  }

  // Captures ?bundle=TOKEN the same way - a wishlist-reminder or
  // post-purchase-upsell email links back with one, and checkout reads it
  // from here (coldd_bundle_token) rather than the URL directly, since the
  // buyer may click around (wishlist -> product page -> checkout) before
  // actually placing the order. priceItems() silently ignores an
  // expired/unknown one, so there's no harm in always carrying whatever
  // was last captured.
  (function captureBundleToken() {
    try {
      var m = /[?&]bundle=([^&]+)/.exec(location.search);
      if (!m) return;
      var token = decodeURIComponent(m[1]).trim();
      if (!token) return;
      localStorage.setItem('coldd_bundle_token', token);
    } catch (e) {}
  })();

  function saveProfile(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {} }
  function getProfile() { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (e) { return null; } }
  function clearProfile() { try { localStorage.removeItem(PROFILE_KEY); localStorage.removeItem(ADMIN_KEY); } catch (e) {} }
  function initials(name) {
    if (!name) return '?';
    var parts = name.trim().split(/\s+/);
    return (parts[0][0] || '').toUpperCase();
  }
  // Discord identities already carry a real avatar from callback.html, so
  // this never overrides one. Every other provider (Google, email, and
  // Roblox when Roblox's own API returns none) saved avatar: '' outright -
  // a generated identicon reads as an intentional default for those,
  // rather than the plain-letter initials circle looking like a broken
  // image that never loaded. Seeded on the account id so it's stable for
  // that person forever, not re-rolled on every page load.
  function avatarUrlFor(p) {
    if (!p) return '';
    if (p.avatar) return p.avatar;
    // A Roblox account with no stored picture: build the headshot straight
    // from the user id. This URL 302-redirects to the current CDN render,
    // so it works as an <img>/background src and never goes stale.
    if (p.robloxId) {
      return 'https://www.roblox.com/headshot-thumbnail/image?userId=' + encodeURIComponent(p.robloxId) + '&width=150&height=150&format=png';
    }
    if (p.provider === 'discord') return '';
    var seed = p.id || p.email || p.name || 'coldd';
    return 'https://api.dicebear.com/9.x/identicon/svg?seed=' + encodeURIComponent(seed) + '&backgroundType=solid&backgroundColor=1f2127';
  }
  function capitalizeEmailPrefix(email) {
    if (!email) return '';
    var prefix = email.split('@')[0];
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }

  function applyProfile() {
    var p = getProfile();
    if (!p) return;
    // p.name already IS the right value here - upsertBasicProfile only
    // ever derives it from the email prefix as a fallback for brand-new
    // signups (see its own comment), and keeps whatever the user set via
    // Account Settings from then on. Unconditionally recomputing it from
    // the email here for every email-provider user threw that custom name
    // away everywhere applyProfile paints it (nav, dashboard header) even
    // though Account Settings itself (which reads p.name directly) showed
    // it saved correctly - "I changed my name and nothing changed."
    // capitalizeEmailPrefix is now only a last-resort fallback if p.name
    // is somehow empty.
    var displayName = p.name || (p.provider === 'email' ? capitalizeEmailPrefix(p.email) : '') || 'Member';

    // A zero-width space, not '', for an empty value: the identity fields
    // carry a CSS skeleton pulse keyed off :empty (see styles.css), which is
    // only meant to run WHILE the profile is loading. Same trick as
    // paintAvatar() below.
    // A synthetic roblox-<id>@roblox.coldd.internal address is not a real
    // email - never show it as one (nav, dashboard header, checkout).
    var shownEmail = (p.email && !/@roblox\.coldd\.internal$/i.test(p.email)) ? p.email : '';
    document.querySelectorAll('#dashName, #coUserName').forEach(function (el) { el.textContent = displayName || '​'; });
    // An account with no email on record (Roblox sign-ins, some username-only
    // accounts) has resolved - it just has no email. Collapse the line rather
    // than holding it open with a zero-width space: an invisible sub-line
    // still takes vertical space, which pushed the visible name up so it sat
    // against the top of the avatar instead of centred beside it.
    document.querySelectorAll('#dashEmail, #coUserEmail').forEach(function (el) {
      el.hidden = !shownEmail;
      el.textContent = shownEmail || '​';
    });

    function paintAvatar(url) {
      document.querySelectorAll('#dashAvatar, #coAvatar, #acAvatarPreview, .account-menu-av').forEach(function (el) {
        if (url) {
          el.style.backgroundImage = 'url(' + url + ')';
          el.style.backgroundSize = 'cover';
          el.style.backgroundPosition = 'center';
          // NOT '' - the CSS skeleton-loading pulse is keyed off :empty,
          // which this element only ever satisfies BEFORE a real avatar
          // loads (a background-image doesn't count as content). Leaving
          // it truly empty here made it look "loaded" to the eye but
          // still match :empty forever, so the placeholder pulse never
          // actually turned off - a zero-width space is invisible but is
          // real text content, which is enough to stop matching :empty.
          el.textContent = '​';
        } else {
          el.style.backgroundImage = '';
          el.textContent = initials(displayName);
        }
      });
    }
    paintAvatar(avatarUrlFor(p));

    // profiles.avatar_url persists server-side regardless of which provider
    // the CURRENT session used to sign in - p above only reflects this
    // session's provider, so a user who linked Discord (or uploaded a
    // custom picture via Account Settings) but is now signed in via email/
    // Google/Roblox would otherwise never see it. Whatever's on record wins
    // over the synchronous provider/identicon default above, once this
    // resolves - a self-uploaded avatar is exactly as durable as a linked
    // Discord one, same column, same "always wins" rule.
    if (client && p.id) {
      client.from('profiles').select('avatar_url').eq('id', p.id).maybeSingle()
        .then(function (res) {
          var row = res && res.data;
          if (row && row.avatar_url && row.avatar_url !== p.avatar) {
            p.avatar = row.avatar_url;
            saveProfile(p); // so a lazily-built nav dropdown menu uses it too
            paintAvatar(row.avatar_url);
          }
        })
        .catch(function () {});
    }

    // The separator lives here, not in the markup: the heading ships as
    // "Welcome back." with an empty span, so a profile that never loads reads
    // as a plain greeting rather than a dangling comma.
    var welcome = document.getElementById('dashWelcomeName');
    if (welcome) {
      var first = (displayName || '').split(' ')[0] || displayName;
      welcome.textContent = first ? ', ' + first : '';
    }

    var acName = document.getElementById('ac-name');
    if (acName) acName.value = displayName || '';
    var acEmail = document.getElementById('ac-email');
    if (acEmail) acEmail.value = p.email || '';

  }

  // Returns the promise chain (callers must return/await it) - every
  // caller used to fire this and resolve immediately, so a fast
  // isEmailVerified() round trip could win the race and redirect to
  // /dashboard before saveProfile() ever ran. That left coldd_profile
  // unset in localStorage: applyProfile() found nothing to apply, so the
  // account menu and dashboard rendered a bare "?" avatar with no name
  // even though the real session (and the purchase history it drives)
  // was completely valid - not a data leak, just a lost race.
  function upsertBasicProfile(user) {
    var email = user.email || '';
    var derivedName = (user.user_metadata && (user.user_metadata.username || user.user_metadata.full_name || user.user_metadata.name)) || (email ? email.split('@')[0] : 'Member');
    // Only set username if the profile doesn't already have one - a user
    // who customized their display name via Account Settings must not have
    // it silently reverted to their OAuth/email-derived name on every
    // future sign-in.
    return client.from('profiles').select('username, avatar_url, roblox_id, discord_id').eq('id', user.id).maybeSingle().then(function (existingRes) {
      var row = (existingRes && existingRes.data) || {};
      var existingName = row.username || null;
      var name = existingName || derivedName;
      var payload = { id: user.id, email: email, updated_at: new Date().toISOString() };
      if (!existingName) payload.username = derivedName;
      // Keep the real provider + avatar - a Roblox-only or Discord-only
      // account must not get flattened to provider:'email', avatar:'' on
      // every session restore (that's what left Roblox users showing the
      // generated identicon in the nav dropdown).
      var meta = user.user_metadata || {};
      var provider = row.roblox_id || meta.roblox_id ? 'roblox'
        : row.discord_id || meta.provider === 'discord' ? 'discord'
        : (meta.provider || 'email');
      var profile = {
        id: user.id, provider: provider, name: name, email: email,
        avatar: row.avatar_url || meta.avatar_url || '',
        robloxId: row.roblox_id || meta.roblox_id || null,
        discordId: row.discord_id || null
      };
      saveProfile(profile);
      try { localStorage.setItem(AUTH_KEY, 'in'); } catch (e) {}
      return client.from('profiles').upsert(payload).then(function (res) {
        if (res.error) console.warn('[coldd] profile upsert failed:', res.error.message);
      });
    });
  }

  window.coldAuth = {
    invokeFn: invokeFn,
    logClientError: logClientError,
    avatarUrlFor: avatarUrlFor,
    saveProfile: saveProfile,
    getProfile: getProfile,
    clearProfile: clearProfile,
    applyProfile: applyProfile,
    targetGuildId: TARGET_GUILD_ID,
    checkIsAdmin: checkIsAdmin,
    getReferralAttribution: getReferralAttribution,
    getCampaignCode: getCampaignCode,
    // Both native providers go through startOAuth so the caller can SEE a
    // failure. They used to fire signInWithOAuth and drop the result, so a
    // provider error (or a blocked redirect) left the button doing nothing,
    // with nothing in the console either - the "Continue with Discord just
    // doesn't load" report.
    signInDiscord: function () {
      return startOAuth({
        provider: 'discord',
        options: { redirectTo: location.origin + '/callback.html', scopes: 'identify email guilds guilds.members.read' }
      });
    },
    // Google is a Supabase-native provider, so this is the same one-call shape
    // as Discord - no hand-rolled exchange like Roblox needs. Requires the
    // Google provider to be enabled in Supabase Auth with a client ID/secret
    // from Google Cloud.
    signInGoogle: function () {
      return startOAuth({
        provider: 'google',
        options: {
          redirectTo: location.origin + '/callback.html',
          // Forces the account chooser instead of silently reusing whichever
          // Google account the browser last used - people share machines.
          queryParams: { prompt: 'select_account' }
        }
      });
    },
    // Roblox isn't a Supabase-native OAuth provider, so this is a hand-
    // rolled OAuth2 redirect (unlike signInDiscord above) - the code
    // exchange happens server-side in roblox-oauth-callback, invoked from
    // roblox-callback.html. Links an existing coldd account; not a
    // primary sign-in method.
    // `returnTo` is where roblox-callback.html should land once the round trip
    // finishes. Linking from the Robux checkout used to end on the dashboard,
    // which abandons a half-finished order: the buyer linked their account in
    // order to pay, and got moved away from the payment they were making.
    signInRoblox: function (returnTo) {
      if (!ROBLOX_OAUTH_CLIENT_ID) { console.error('[coldd] Roblox OAuth client ID not configured yet.'); return; }
      var redirectUri = location.origin + '/roblox-callback.html';
      var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { sessionStorage.setItem('coldd_roblox_oauth_state', state); } catch (e) {}
      try {
        // Same-origin paths only - this value comes back as a redirect target.
        if (returnTo && returnTo.charAt(0) === '/' && returnTo.charAt(1) !== '/') {
          sessionStorage.setItem('coldd_roblox_return', returnTo);
        } else {
          sessionStorage.removeItem('coldd_roblox_return');
        }
      } catch (e) {}
      var params = new URLSearchParams({
        client_id: ROBLOX_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: 'openid profile user.inventory-item:read',
        response_type: 'code',
        state: state
      });
      location.href = 'https://apis.roblox.com/oauth/v1/authorize?' + params.toString();
    },
    unlinkRoblox: function () {
      return invokeFn('roblox-oauth-callback', { unlink: true });
    },
    robloxLinkStatus: function () {
      return invokeFn('roblox-link-status', {}).catch(function () {
        return { ok: false, linked: false };
      });
    },
    signUpEmail: function (email, password, username) {
      return client.auth.signUp({
        email: email,
        password: password,
        options: { data: { username: username } }
      });
    },
    requestEmailOtp: function () {
      return client.functions.invoke('email-otp', { body: { action: 'send' } });
    },
    verifyEmailOtp: function (code) {
      return client.functions.invoke('email-otp', { body: { action: 'verify', code: code } }).then(function (res) {
        if (!res.error && res.data && res.data.ok) {
          return client.auth.getUser().then(function (r) {
            if (!r.data || !r.data.user) return res;
            return upsertBasicProfile(r.data.user).then(function () { return res; });
          });
        }
        return res;
      });
    },
    signInEmail: function (email, password) {
      return client.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        if (res.error || !res.data || !res.data.user) return res;
        return upsertBasicProfile(res.data.user).then(function () { return res; });
      });
    },
    isEmailVerified: function () {
      return client.auth.getUser().then(function (r) {
        if (!r.data || !r.data.user) return false;
        return client.from('profiles').select('email_verified').eq('id', r.data.user.id).single().then(function (res) {
          return !!(res.data && res.data.email_verified);
        });
      });
    },
    emailExists: function (email) {
      return client.rpc('email_exists', { check_email: email }).then(function (res) {
        return !!(res.data === true);
      });
    },
    // Reset by emailed code. The password-reset-code function emails the code and, on verify,
    // sets the new password; the buyer is then signed in with it. (The old path used Supabase's
    // built-in recovery email, whose dashboard template sent a link while this UI asks for a code.)
    sendPasswordReset: function (email) {
      return client.functions.invoke('password-reset-code', { body: { action: 'send', email: email } }).then(function (res) {
        if (res.error) {
          var status = res.error.context && res.error.context.status;
          if (status === 429) return {}; // a code was just sent, keep going to the code screen
          throw res.error;
        }
        return res;
      });
    },
    verifyRecoveryOtp: function (email, code, newPassword) {
      return client.functions.invoke('password-reset-code', { body: { action: 'verify', email: email, code: code, newPassword: newPassword } }).then(function (res) {
        if (res.error) return { error: res.error };
        return client.auth.signInWithPassword({ email: email, password: newPassword }).then(function (inRes) {
          if (inRes.error || !inRes.data || !inRes.data.user) return inRes;
          return upsertBasicProfile(inRes.data.user).then(function () { return inRes; });
        });
      });
    },
    updatePassword: function (password) {
      return client.auth.updateUser({ password: password });
    },
    // A Roblox-first sign-up gets a synthetic, undeliverable
    // roblox-<id>@roblox.coldd.internal address - treat that as "no email".
    // Discord / Google always hand over a real one.
    isPlaceholderEmail: function (email) {
      return !email || /@roblox\.coldd\.internal$/i.test(email);
    },
    // Resolves to true when the signed-in account has no real email on
    // record and should be prompted to claim it.
    needsClaim: function () {
      return client.auth.getUser().then(function (r) {
        var u = r && r.data && r.data.user;
        if (!u) return false;
        // A real, deliverable primary email = already claimable.
        if (u.email && !/@roblox\.coldd\.internal$/i.test(u.email)) return false;
        // Any linked identity that isn't the Roblox one (Discord / Google /
        // email+password) is already a Roblox-independent way back into the
        // account, so there's nothing left to nag about.
        var ids = u.identities || [];
        for (var i = 0; i < ids.length; i++) {
          if (ids[i] && ids[i].provider && ids[i].provider !== 'roblox') return false;
        }
        return true;
      }).catch(function () { return false; });
    },
    claimSend: function (email) {
      return client.functions.invoke('claim-account', { body: { action: 'send', email: email } });
    },
    claimVerify: function (email, code, password) {
      return client.functions.invoke('claim-account', { body: { action: 'verify', email: email, code: code, password: password } }).then(function (res) {
        if (!res.error && res.data && res.data.ok) {
          return client.auth.getUser().then(function (r) {
            if (r.data && r.data.user) return upsertBasicProfile(r.data.user).then(function () { return res; });
            return res;
          });
        }
        return res;
      });
    },
    upsertBasicProfile: upsertBasicProfile,
    signOut: function () {
      clearProfile();
      try { localStorage.setItem(AUTH_KEY, 'out'); } catch (e) {}
      return client.auth.signOut().catch(function () {});
    }
  };

  // ---------------------------------------------------------------------
  // Cookie / storage consent
  //
  // Two categories only, because the site genuinely has two.
  //
  //   essential - the Supabase auth session, the cart, the site gate, and this
  //               consent record itself. Never optional: without them the site
  //               cannot do the thing the visitor came to do, so they are not
  //               offered as a choice and no banner button can switch them off.
  //   analytics - the pageview beacon and the abandoned-cart snapshot. Both
  //               exist for the admin panel, not for the visitor, so both wait
  //               for an explicit yes.
  //
  // The default before any choice is made is NO. allows() returns false while
  // the decision is undecided, so a visitor who ignores the banner entirely is
  // treated as having declined rather than as having agreed by silence.
  // ---------------------------------------------------------------------
  var CONSENT_KEY = 'coldd_cookie_consent';
  // Bumped to 2 when the analytics wording started covering abandoned-cart
  // reminder emails - a materially different thing to agree to, so everyone is
  // asked again rather than carrying an old yes forward.
  var CONSENT_VERSION = 2;

  function readConsent() {
    try {
      var raw = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
      if (!raw || raw.version !== CONSENT_VERSION) return null;
      return raw;
    } catch (e) { return null; }
  }

  // Keeps a server-side record of each banner decision (see
  // supabase/migrations/20261004_consent_records.sql). Fire-and-forget: a
  // failed log must never block or undo the visitor's choice. The visitor id
  // is random and per-browser - it identifies a consent decision, not a person.
  function logConsent(rec) {
    try {
      var vid = localStorage.getItem('coldd_consent_vid');
      if (!vid) {
        vid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
        localStorage.setItem('coldd_consent_vid', vid);
      }
      client.auth.getSession().then(function (res) {
        var uid = res && res.data && res.data.session && res.data.session.user ? res.data.session.user.id : null;
        return client.from('consent_log').insert({
          visitor_id: vid, user_id: uid, analytics: !!rec.analytics,
          banner_version: rec.version, page: location.pathname.slice(0, 200)
        });
      }).catch(function () {});
    } catch (e) {}
  }

  function writeConsent(analytics) {
    var rec = { version: CONSENT_VERSION, analytics: !!analytics, ts: new Date().toISOString() };
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify(rec)); } catch (e) {}
    // Lets already-loaded scripts react without a reload - catalog.js listens
    // so a visitor who accepts gets counted on the page they accepted from,
    // rather than only from the next navigation onward.
    try { window.dispatchEvent(new CustomEvent('coldd:consent', { detail: rec })); } catch (e) {}
    logConsent(rec);
    return rec;
  }

  window.coldConsent = {
    get: readConsent,
    decided: function () { return !!readConsent(); },
    allows: function (category) {
      if (category === 'essential') return true;
      var c = readConsent();
      return !!(c && c[category]);
    },
    accept: function () { return writeConsent(true); },
    reject: function () { return writeConsent(false); },
    // Exposed so the privacy policy can offer a "change your choice" control.
    // Shows the banner pre-filled with whatever is currently saved - this
    // used to clear the saved choice from localStorage immediately on open,
    // before the visitor had done anything, so just opening your
    // preferences to look (without clicking Accept/Reject/Save) silently
    // reset a prior Accept back to declined. Nothing is written until the
    // visitor actually makes a choice again.
    reopen: function () { showConsentBanner({ openConfig: true }); }
  };

  function showConsentBanner(opts) {
    if (document.getElementById('cookieBanner')) return;
    opts = opts || {};
    // Reopening to review/change an existing choice should show that choice,
    // not silently default back to "off" - a visitor who'd accepted
    // analytics and clicked Save here without touching the checkbox (since
    // it looked already off) would otherwise have their Accept quietly
    // downgraded to a decline.
    var current = readConsent();
    var analyticsChecked = !!(current && current.analytics);

    var bar = document.createElement('div');
    bar.className = 'cookie-bar';
    bar.id = 'cookieBanner';
    // role=region + aria-label rather than role=dialog: this does not trap
    // focus and must not stop anyone reading the page behind it.
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Cookie choices');
    bar.innerHTML =
      '<div class="cookie-bar-inner">' +
        '<div class="cookie-bar-tx">' +
          '<h2 class="cookie-bar-h">Cookies</h2>' +
          '<p>We use essential cookies to keep you signed in and your cart intact. ' +
          'We would also like optional analytics cookies to see which pages people use and to send cart reminder emails if you leave items behind while signed in. ' +
          '<a href="/privacy-policy">Read our privacy policy</a>.</p>' +
        '</div>' +
        '<div class="cookie-bar-actions">' +
          '<button type="button" class="btn btn-ghost cookie-config" aria-expanded="' + (opts.openConfig ? 'true' : 'false') + '">Configure</button>' +
          '<button type="button" class="btn btn-tinted cookie-reject">Essential only</button>' +
          '<button type="button" class="btn btn-primary cookie-accept">Accept all</button>' +
        '</div>' +
        // Per-category detail. Collapsed by default so the common cases stay
        // one click - a preferences panel nobody asked for is friction, but
        // burying the choice behind a link is a dark pattern. Expanding is the
        // middle path. Reopened via "Manage Cookie Preferences" starts
        // expanded instead - the whole point of that button is reviewing the
        // per-category choice, not the two big first-visit buttons.
        '<div class="cookie-cats"' + (opts.openConfig ? '' : ' hidden') + '>' +
          '<label class="cookie-cat is-locked">' +
            '<input type="checkbox" checked disabled />' +
            '<span class="cookie-cat-tx">' +
              '<span class="cookie-cat-n">Essential <span class="cookie-cat-tag">Always on</span></span>' +
              '<span class="cookie-cat-d">Keeps you signed in, remembers your cart and currency, and stores this cookie choice. The site cannot work without it, so it is not optional.</span>' +
            '</span>' +
          '</label>' +
          '<label class="cookie-cat">' +
            '<input type="checkbox" class="cookie-cat-analytics"' + (analyticsChecked ? ' checked' : '') + ' />' +
            '<span class="cookie-cat-tx">' +
              '<span class="cookie-cat-n">Analytics</span>' +
              '<span class="cookie-cat-d">Tells us which pages get used and whether a cart was abandoned. If you are signed in, an abandoned cart is linked to your account and may trigger up to a few reminder emails. Not shared with anyone else. Off unless you turn it on.</span>' +
            '</span>' +
          '</label>' +
          '<button type="button" class="btn btn-primary cookie-save">Save preferences</button>' +
        '</div>' +
      '</div>';

    function close() { bar.classList.remove('in'); setTimeout(function () { bar.remove(); }, 220); }
    bar.querySelector('.cookie-accept').addEventListener('click', function () { window.coldConsent.accept(); close(); });
    bar.querySelector('.cookie-reject').addEventListener('click', function () { window.coldConsent.reject(); close(); });

    var cats = bar.querySelector('.cookie-cats');
    var configBtn = bar.querySelector('.cookie-config');
    configBtn.addEventListener('click', function () {
      var open = cats.hidden;
      cats.hidden = !open;
      configBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    bar.querySelector('.cookie-save').addEventListener('click', function () {
      // Saving reflects exactly what the toggles say. An untouched panel saves
      // analytics off, which matches the default - silence is still a decline.
      var on = bar.querySelector('.cookie-cat-analytics').checked;
      if (on) window.coldConsent.accept(); else window.coldConsent.reject();
      close();
    });

    document.body.appendChild(bar);
    // Next frame, so the entrance transition has a resting state to animate
    // from instead of being applied in the same style pass.
    requestAnimationFrame(function () { bar.classList.add('in'); });
  }

  function maybeShowConsentBanner() {
    if (readConsent()) return;
    // The gate page and the OAuth callbacks are not places to ask - they are
    // transient redirects, and the banner would flash and vanish.
    var p = location.pathname;
    if (/lock\.html|callback\.html/.test(p)) return;
    showConsentBanner();
  }

  document.addEventListener('DOMContentLoaded', applyProfile);
  document.addEventListener('DOMContentLoaded', maybeShowConsentBanner);
})();
