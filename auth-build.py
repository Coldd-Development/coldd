#!/usr/bin/env python3
import base64, re
from pathlib import Path

ROOT = Path(__file__).parent

# Archivo is self-hosted (see @font-face at the top of styles.css), so no
# third-party font <link> tags are emitted - requests to Google before consent
# were a GDPR problem.
FONT = ''

GOOGLE = ('<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>'
          '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>'
          '<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>'
          '<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>')
DISCORD = '<svg viewBox="0 0 24 24" fill="#5865F2"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>'
ROBLOX = '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M18.926 23.998 0 18.892 5.075.002 24 5.108ZM15.348 10.09l-5.282-1.453-1.414 5.273 5.282 1.453z"/></svg>'
EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'

SOCIAL = ('      <div class="auth-social">\n'
          f'        <button class="auth-oauth" type="button" data-provider="Google">{GOOGLE} Continue with Google</button>\n'
          f'        <button class="auth-oauth" type="button" data-provider="Discord">{DISCORD} Continue with Discord</button>\n'
          f'        <button class="auth-oauth" type="button" data-provider="Roblox">{ROBLOX} Continue with Roblox</button>\n'
          '      </div>\n')

def pw_field(fid, name, label, autoc, ph='••••••••'):
    return (f'        <div class="auth-field" data-for="{name}">\n'
            f'          <label for="{fid}">{label}</label>\n'
            f'          <div class="auth-input-wrap">\n'
            f'            <input id="{fid}" name="{name}" type="password" autocomplete="{autoc}" placeholder="{ph}" />\n'
            f'            <button class="auth-pw-toggle" type="button" aria-label="Show password">{EYE}</button>\n'
            f'          </div>\n          <span class="auth-err"></span>\n        </div>\n')

def email_field(fid):
    return (f'        <div class="auth-field" data-for="email">\n'
            f'          <label for="{fid}">Email</label>\n'
            f'          <input id="{fid}" name="email" type="email" autocomplete="email" placeholder="you@example.com" />\n'
            f'          <span class="auth-err"></span>\n        </div>\n')

SIGNIN = ('    <div class="glass auth-card">\n'
          '      <h1>Welcome back</h1>\n'
          '      <p class="auth-sub">Sign in to your coldd account.</p>\n'
          + SOCIAL +
          '      <div class="auth-divider"><span>or sign in with email</span></div>\n'
          '      <form class="auth-form" id="form-signin" novalidate>\n'
          + email_field('si-email')
          + pw_field('si-pass', 'password', 'Password', 'current-password')
          + '        <div class="auth-row"><a href="forgot.html">Forgot password?</a></div>\n'
          '        <button class="btn btn-primary auth-submit" type="submit">Sign in</button>\n'
          '        <div class="auth-msg"></div>\n'
          '      </form>\n'
          '      <p class="auth-alt">New to coldd? <a href="signup.html">Create an account</a></p>\n'
          '    </div>\n')

SIGNUP = ('    <div class="glass auth-card">\n'
          '      <h1>Create your account</h1>\n'
          '      <p class="auth-sub">Join coldd to buy, download, and manage your assets.</p>\n'
          + SOCIAL +
          '      <div class="auth-divider"><span>or sign up with email</span></div>\n'
          '      <form class="auth-form" id="form-signup" novalidate>\n'
          + email_field('su-email')
          + pw_field('su-pass', 'password', 'Password', 'new-password', 'At least 8 characters')
          + pw_field('su-conf', 'confirm', 'Confirm password', 'new-password')
          + '        <label class="auth-check"><input type="checkbox" name="tos" /> <span>I agree to the <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a>.</span></label>\n'
          '        <span class="auth-err" data-for="tos"></span>\n'
          '        <label class="auth-check"><input type="checkbox" name="marketing" /> <span>Email me deals and drops (optional).</span></label>\n'
          '        <button class="btn btn-primary auth-submit" type="submit">Create account</button>\n'
          '        <div class="auth-msg"></div>\n'
          '      </form>\n'
          '      <p class="auth-alt">Already have an account? <a href="signin.html">Sign in</a></p>\n'
          '    </div>\n')

FORGOT = ('    <div class="glass auth-card">\n'
          '      <h1>Reset your password</h1>\n'
          '      <p class="auth-sub">Enter your email and we\'ll send a link to reset it.</p>\n'
          '      <form class="auth-form" id="form-forgot" novalidate>\n'
          + email_field('fo-email')
          + '        <button class="btn btn-primary auth-submit" type="submit">Send reset link</button>\n'
          '        <div class="auth-msg"></div>\n'
          '      </form>\n'
          '      <p class="auth-alt"><a href="signin.html">← Back to sign in</a></p>\n'
          '    </div>\n')

RESET = ('    <div class="glass auth-card">\n'
         '      <h1>Choose a new password</h1>\n'
         '      <p class="auth-sub">Pick something you haven\'t used before.</p>\n'
         '      <form class="auth-form" id="form-reset" novalidate>\n'
         + pw_field('rs-pass', 'password', 'New password', 'new-password', 'At least 8 characters')
         + pw_field('rs-conf', 'confirm', 'Confirm password', 'new-password')
         + '        <button class="btn btn-primary auth-submit" type="submit">Update password</button>\n'
         '        <div class="auth-msg"></div>\n'
         '      </form>\n'
         '      <p class="auth-alt"><a href="signin.html">← Back to sign in</a></p>\n'
         '    </div>\n')

PAGES = {'signin': ('Sign in', SIGNIN), 'signup': ('Create account', SIGNUP),
         'forgot': ('Reset password', FORGOT), 'reset': ('New password', RESET)}

def shell(title, body_main, head_extra='', scripts='  <script src="auth.js"></script>'):
    return (f'<!DOCTYPE html>\n<html lang="en">\n<head>\n'
            f'  <script>document.documentElement.classList.add("js")</script>\n'
            f'  <meta charset="UTF-8" />\n'
            f'  <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
            f'  <title>coldd Development {title}</title>\n  <link rel="icon" type="image/png" href="logo.png" />\n  {FONT}\n  {head_extra}\n</head>\n'
            f'<body class="auth-page">\n  <div class="backdrop"></div>\n'
            f'  <div class="scrim"></div>\n'
            f'  <a class="auth-home" href="index.html" aria-label="coldd home"><img class="logo" src="logo.png" alt="coldd" /></a>\n'
            f'{body_main}\n{scripts}\n</body>\n</html>\n')

for key, (title, card) in PAGES.items():
    main = '  <main class="auth-wrap">\n' + card + '  </main>'
    html = shell(title, main, head_extra='<link rel="stylesheet" href="styles.css" />')
    (ROOT / f'{key}.html').write_text(html)
print('Wrote signin/signup/forgot/reset .html')

def data_uri(name):
    p = ROOT / name
    mime = 'image/png' if name.endswith('.png') else 'image/jpeg'
    return f'data:{mime};base64,' + base64.b64encode(p.read_bytes()).decode()

css = (ROOT / 'styles.css').read_text()
js = (ROOT / 'auth.js').read_text()
for img in ['banner.jpg', 'logo.png']:
    css = css.replace("url('%s')" % img, "url('%s')" % data_uri(img))

screens = ''
for key, (title, card) in PAGES.items():
    hidden = '' if key == 'signin' else ' hidden'
    screens += f'    <div class="auth-screen" id="screen-{key}"{hidden}>\n{card}    </div>\n'

ROUTER = '''
  <script>
  (function(){
    function show(name){
      ['signin','signup','forgot','reset'].forEach(function(k){
        var el=document.getElementById('screen-'+k); if(el) el.hidden = (k!==name);
      });
      window.scrollTo(0,0);
    }
    document.addEventListener('click', function(e){
      var a=e.target.closest('a'); if(!a) return;
      var href=a.getAttribute('href')||'';
      var m=href.match(/^(signin|signup|forgot|reset)\\.html$/);
      if(m){ e.preventDefault(); show(m[1]); }
      else if(href==='index.html'){ return; }
    });
  })();
  </script>'''

logo_uri = data_uri('logo.png')
main = ('  <a class="auth-home" href="#" aria-label="coldd home"><img class="logo" src="' + logo_uri + '" alt="coldd" /></a>\n'
        '  <main class="auth-wrap">\n' + screens + '  </main>')
combined = (f'<!DOCTYPE html>\n<html lang="en">\n<head>\n'
            f'  <script>document.documentElement.classList.add("js")</script>\n'
            f'  <meta charset="UTF-8" />\n'
            f'  <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
            f'  <title>coldd Development Account</title>\n  <link rel="icon" type="image/png" href="{logo_uri}" />\n  {FONT}\n  <style>\n{css}\n</style>\n</head>\n'
            f'<body class="auth-page">\n  <div class="backdrop"></div>\n'
            f'  <div class="scrim"></div>\n'
            f'{main}\n  <script>\n{js}\n</script>\n{ROUTER}\n</body>\n</html>\n')

(ROOT / 'auth-preview.html').write_text(combined)
print('Wrote auth-preview.html (%.0f KB)' % ((ROOT / 'auth-preview.html').stat().st_size / 1024))
