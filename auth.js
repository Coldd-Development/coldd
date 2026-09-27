(function () {
  function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function val(form, name) { var el = form.querySelector('[name="' + name + '"]'); return el ? el.value.trim() : ''; }
  function fieldErr(form, name, msg) {
    var f = form.querySelector('.auth-field[data-for="' + name + '"]');
    if (!f) return;
    f.classList.toggle('invalid', !!msg);
    var e = f.querySelector('.auth-err'); if (e) e.textContent = msg || '';
  }
  function flash(form, text) {
    var card = form.closest('.auth-card'); if (!card) return;
    var msg = card.querySelector('.auth-msg'); if (!msg) return;
    msg.textContent = text; msg.classList.add('show');
  }
  function setLoading(form, loading) {
    var btn = form.querySelector('.auth-submit'); if (!btn) return;
    var spinner = btn.querySelector('.btn-spinner');
    btn.disabled = loading;
    btn.classList.toggle('is-loading', loading);
    if (spinner) spinner.hidden = !loading;
  }
  function setStatus(form, text) {
    var card = form.closest('.auth-card'); if (!card) return;
    var el = card.querySelector('.auth-status'); if (!el) return;
    if (text) { el.textContent = text; el.hidden = false; } else { el.hidden = true; }
  }
  function withMinDelay(promise, ms) {
    var start = Date.now();
    return promise.then(function (res) {
      var wait = Math.max(0, ms - (Date.now() - start));
      return new Promise(function (resolve) { setTimeout(function () { resolve(res); }, wait); });
    });
  }

  document.querySelectorAll('.auth-pw-toggle').forEach(function (btn) {
    var off = btn.querySelector('.eye-off'), on = btn.querySelector('.eye-on');
    if (off && on) { off.style.display = ''; on.style.display = 'none'; }
    btn.addEventListener('click', function () {
      var input = btn.parentNode.querySelector('input'); if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      if (off && on) {
        off.style.display = show ? 'none' : '';
        on.style.display = show ? '' : 'none';
      }
    });
  });

  document.querySelectorAll('.auth-oauth').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.classList.contains('oauth-disabled')) return;
      var p = b.getAttribute('data-provider');
      if (p === 'Discord') {
        if (window.coldAuth) window.coldAuth.signInDiscord();
        return;
      }
      if (p === 'Roblox') {
        if (window.coldAuth) window.coldAuth.signInRoblox();
        return;
      }
      if (p === 'Google') {
        if (window.coldAuth) window.coldAuth.signInGoogle();
        return;
      }
      // No silent fallback. This previously set coldd_auth and redirected to
      // the dashboard for any unrecognised provider - a FAKE sign-in with no
      // authentication behind it, which only looked harmless because the
      // buttons that hit it were disabled. An unknown provider is a bug, so
      // say so rather than pretending it worked.
      console.error('[auth] no handler for provider:', p);
    });
  });

  function setupPasswordStrength(form, getUsername) {
    var input = form.querySelector('input[name="password"]');
    var box = form.querySelector('#pwStrength');
    var fill = form.querySelector('#pwFill');
    var list = form.querySelector('#pwChecklist');
    if (!input || !box || !fill || !list) return;

    function evaluate() {
      var v = input.value;
      var rules = {
        upper: /[A-Z]/.test(v),
        lower: /[a-z]/.test(v),
        number: /[0-9]/.test(v),
        special: /[^A-Za-z0-9]/.test(v),
        length: v.length > 8
      };
      var met = 0;
      Object.keys(rules).forEach(function (k) {
        var li = list.querySelector('[data-rule="' + k + '"]');
        if (li) li.classList.toggle('met', rules[k]);
        if (rules[k]) met++;
      });
      fill.style.width = (met / 5 * 100) + '%';
      fill.style.background = met <= 2 ? '#ff4d44' : met <= 4 ? '#ffb020' : '#7ee08a';

      var username = getUsername ? getUsername() : '';
      if (username && v && v.toLowerCase() === username.toLowerCase()) {
        fieldErr(form, 'password', "Password can't be the same as your username.");
      } else {
        fieldErr(form, 'password', '');
      }
    }

    input.addEventListener('input', function () { box.classList.add('open'); evaluate(); });
    input.addEventListener('focus', function () { if (input.value) box.classList.add('open'); });
    input.addEventListener('blur', function () { if (!input.value) box.classList.remove('open'); });
  }

  var si = document.getElementById('form-signin');
  var su = document.getElementById('form-signup');
  if (su) setupPasswordStrength(su, function () { return val(su, 'username'); });
  var sv = document.getElementById('form-verify');
  var resendBtn = document.getElementById('btnResendCode');
  var backBtn = document.getElementById('btnBackToSignup');
  var pendingEmail = '';
  var pendingMarketingOptIn = false; // carried from the signup form to the verify step
  var resendTimer = null;
  var RESEND_SECONDS = 30;

  function startResendCooldown() {
    if (!resendBtn) return;
    var remaining = RESEND_SECONDS;
    resendBtn.disabled = true;
    resendBtn.textContent = 'Resend code (' + remaining + 's)';
    clearInterval(resendTimer);
    resendTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(resendTimer);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend code';
      } else {
        resendBtn.textContent = 'Resend code (' + remaining + 's)';
      }
    }, 1000);
  }

  function showVerifyStep(email) {
    pendingEmail = email;
    if (si) si.hidden = true;
    if (su) su.hidden = true;
    if (sv) {
      sv.hidden = false;
      var sub = document.getElementById('verifySub');
      if (sub) sub.textContent = 'Enter the code we emailed to ' + email + '.';
    }
    startResendCooldown();
  }

  if (backBtn) backBtn.addEventListener('click', function () {
    clearInterval(resendTimer);
    if (sv) sv.hidden = true;
    if (su) { su.hidden = false; return; }
    if (si) si.hidden = false;
  });

  if (si) si.addEventListener('submit', function (e) {
    e.preventDefault();
    var ok = true, email = val(si, 'email'), pass = val(si, 'password');
    if (!emailOk(email)) { fieldErr(si, 'email', 'Enter a valid email.'); ok = false; } else fieldErr(si, 'email', '');
    if (!pass) { fieldErr(si, 'password', 'Enter your password.'); ok = false; } else fieldErr(si, 'password', '');
    if (!ok || !window.coldAuth) return;

    setLoading(si, true);
    window.coldAuth.signInEmail(email, pass).then(function (res) {
      if (res.error) {
        setLoading(si, false);
        var m = /confirm/i.test(res.error.message) ? 'Please confirm your email first - check your inbox.' : 'Invalid email or password.';
        flash(si, m);
        return;
      }
      window.coldAuth.isEmailVerified().then(function (verified) {
        if (!verified) {
          setStatus(si, "Hold tight, we're sending you a verification code…");
          window.coldAuth.requestEmailOtp().then(function () {
            setLoading(si, false);
            setStatus(si, '');
            showVerifyStep(email);
          });
          return;
        }
        setLoading(si, false);
        location.href = '/dashboard';
      });
    }).catch(function () {
      setLoading(si, false);
      flash(si, 'Something went wrong. Please try again.');
    });
  });

  if (su) su.addEventListener('submit', function (e) {
    e.preventDefault();
    var ok = true, username = val(su, 'username'), email = val(su, 'email'), pass = val(su, 'password'), conf = val(su, 'confirm');
    var tos = su.querySelector('[name="tos"]');
    if (!username || username.length < 3) { fieldErr(su, 'username', 'Pick a username (3+ characters).'); ok = false; } else fieldErr(su, 'username', '');
    if (!emailOk(email)) { fieldErr(su, 'email', 'Enter a valid email.'); ok = false; } else fieldErr(su, 'email', '');
    if (pass.length < 8) { fieldErr(su, 'password', 'Use at least 8 characters.'); ok = false; } else fieldErr(su, 'password', '');
    if (!conf || conf !== pass) { fieldErr(su, 'confirm', "Passwords don't match."); ok = false; } else fieldErr(su, 'confirm', '');
    var te = su.querySelector('.auth-err[data-for="tos"]');
    if (tos && !tos.checked) { if (te) te.textContent = 'Please accept the Terms to continue.'; ok = false; } else if (te) te.textContent = '';
    if (!ok || !window.coldAuth) return;
    var mkt = su.querySelector('[name="marketing"]');
    pendingMarketingOptIn = !!(mkt && mkt.checked);

    setLoading(su, true);
    withMinDelay(window.coldAuth.signUpEmail(email, pass, username), 1500).then(function (res) {
      if (res.error) { setLoading(su, false); flash(su, res.error.message); return; }
      setStatus(su, "Hold tight, we're sending you a verification code…");
      window.coldAuth.requestEmailOtp().then(function (otpRes) {
        setLoading(su, false);
        setStatus(su, '');
        if (otpRes.error) flash(su, "Account created, but we couldn't send the code. Try resending on the next screen.");
        showVerifyStep(email);
      });
    }).catch(function () {
      setLoading(su, false);
      flash(su, 'Something went wrong. Please try again.');
    });
  });

  if (sv) sv.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = val(sv, 'code').toUpperCase();
    if (!code || code.length < 6) { fieldErr(sv, 'code', 'Enter the 6-character code.'); return; }
    fieldErr(sv, 'code', '');
    setLoading(sv, true);
    window.coldAuth.verifyEmailOtp(code).then(function (res) {
      setLoading(sv, false);
      if (res.error || !res.data || !res.data.ok) {
        var m = (res.data && res.data.error) || 'Incorrect or expired code.';
        fieldErr(sv, 'code', m);
        flash(sv, m);
        return;
      }
      fieldErr(sv, 'code', '');
      // Record the signup-form marketing opt-in now that there's a real
      // verified session. source:'signup' is consent-only - marketing-signup
      // records it in marketing_optins and syncs notification_prefs.promotions
      // but mints NO discount code (the 10% code is popup-only). Fire-and-
      // forget: it must never block the redirect.
      if (pendingMarketingOptIn && window.coldSupabase) {
        try {
          window.coldSupabase.functions.invoke('marketing-signup', { body: { email: pendingEmail, source: 'signup' } }).catch(function () {});
        } catch (e) {}
      }
      location.href = '/dashboard';
    }).catch(function () {
      setLoading(sv, false);
      flash(sv, 'Something went wrong. Please try again.');
    });
  });

  if (resendBtn) resendBtn.addEventListener('click', function () {
    if (resendBtn.disabled) return;
    resendBtn.disabled = true;
    window.coldAuth.requestEmailOtp().then(function (res) {
      flash(sv, res.error ? "Couldn't resend right now, try again shortly." : 'New code sent to ' + pendingEmail + '.');
      startResendCooldown();
    });
  });

  var fo = document.getElementById('form-forgot');
  var frc = document.getElementById('form-reset-code');
  var foResendBtn = document.getElementById('btnResendCode');
  var foBackBtn = document.getElementById('btnBackToSignup');
  var pendingResetEmail = '';
  var foResendTimer = null;

  function startForgotCooldown() {
    if (!foResendBtn) return;
    var remaining = RESEND_SECONDS;
    foResendBtn.disabled = true;
    foResendBtn.textContent = 'Resend code (' + remaining + 's)';
    clearInterval(foResendTimer);
    foResendTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(foResendTimer);
        foResendBtn.disabled = false;
        foResendBtn.textContent = 'Resend code';
      } else {
        foResendBtn.textContent = 'Resend code (' + remaining + 's)';
      }
    }, 1000);
  }

  if (fo) fo.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = val(fo, 'email');
    if (!emailOk(email)) { fieldErr(fo, 'email', 'Enter a valid email.'); return; }
    fieldErr(fo, 'email', '');
    if (!window.coldAuth) return;
    setLoading(fo, true);
    window.coldAuth.sendPasswordReset(email).then(function () {
      setLoading(fo, false);
      pendingResetEmail = email;
      fo.hidden = true;
      if (frc) {
        frc.hidden = false;
        var sub = document.getElementById('resetCodeSub');
        if (sub) sub.textContent = 'Enter the code we emailed to ' + email + ', plus your new password.';
      }
      startForgotCooldown();
    }).catch(function () {
      setLoading(fo, false);
      flash(fo, 'Something went wrong. Please try again.');
    });
  });

  if (frc) frc.addEventListener('submit', function (e) {
    e.preventDefault();
    var ok = true, code = val(frc, 'code').toUpperCase(), pass = val(frc, 'password'), conf = val(frc, 'confirm');
    if (!code || code.length < 6) { fieldErr(frc, 'code', 'Enter the 6-character code.'); ok = false; } else fieldErr(frc, 'code', '');
    if (pass.length < 8) { fieldErr(frc, 'password', 'Use at least 8 characters.'); ok = false; } else fieldErr(frc, 'password', '');
    if (!conf || conf !== pass) { fieldErr(frc, 'confirm', "Passwords don't match."); ok = false; } else fieldErr(frc, 'confirm', '');
    if (!ok || !window.coldAuth) return;

    setLoading(frc, true);
    window.coldAuth.verifyRecoveryOtp(pendingResetEmail, code, pass).then(function (res) {
      setLoading(frc, false);
      if (res.error) { flash(frc, 'Incorrect or expired code.'); return; }
      flash(frc, 'Password updated! Redirecting…');
      setTimeout(function () { location.href = '/dashboard'; }, 900);
    }).catch(function () {
      setLoading(frc, false);
      flash(frc, 'Something went wrong. Please try again.');
    });
  });

  if (foResendBtn) foResendBtn.addEventListener('click', function () {
    if (foResendBtn.disabled || !pendingResetEmail) return;
    foResendBtn.disabled = true;
    window.coldAuth.sendPasswordReset(pendingResetEmail).then(function (res) {
      flash(frc, res.error ? "Couldn't resend right now, try again shortly." : 'New code sent to ' + pendingResetEmail + '.');
      startForgotCooldown();
    });
  });

  if (foBackBtn) foBackBtn.addEventListener('click', function () {
    clearInterval(foResendTimer);
    if (frc) frc.hidden = true;
    if (fo) fo.hidden = false;
  });

  var rs = document.getElementById('form-reset');
  if (rs) setupPasswordStrength(rs, null);
  if (rs) rs.addEventListener('submit', function (e) {
    e.preventDefault();
    var ok = true, pass = val(rs, 'password'), conf = val(rs, 'confirm');
    if (pass.length < 8) { fieldErr(rs, 'password', 'Use at least 8 characters.'); ok = false; } else fieldErr(rs, 'password', '');
    if (!conf || conf !== pass) { fieldErr(rs, 'confirm', "Passwords don't match."); ok = false; } else fieldErr(rs, 'confirm', '');
    if (!ok || !window.coldAuth) return;
    setLoading(rs, true);
    window.coldAuth.updatePassword(pass).then(function (res) {
      setLoading(rs, false);
      if (res.error) { flash(rs, res.error.message); return; }
      flash(rs, 'Password updated - you can sign in now.');
      setTimeout(function () { location.href = '/signin'; }, 1200);
    }).catch(function () {
      setLoading(rs, false);
      flash(rs, 'Something went wrong. Please try again.');
    });
  });
})();
