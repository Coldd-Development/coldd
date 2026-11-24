#!/usr/bin/env node
// Saves the coldd.dev mailbox passwords as Supabase secrets for mailbox-poll, without
// ever printing them or writing them into the repo.
//
// 1. Copy the message that lists the mailboxes, one per line:
//      support@coldd.dev - <password>
//      billing@coldd.dev - <password>
// 2. From the repo folder run:   node scripts/set-mailbox-secrets.cjs
//    (it reads the copied text from the clipboard; or pipe the text in instead).
//
// Each line becomes the secret MAILBOX_<NAME> (MAILBOX_SUPPORT, MAILBOX_BILLING, ...).
// The temporary file handed to the Supabase CLI is deleted straight after, and the
// clipboard is cleared once the passwords are saved.

const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

function readClipboard() {
  if (process.platform === 'win32') return spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).stdout || '';
  if (process.platform === 'darwin') return spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout || '';
  return spawnSync('sh', ['-c', 'xclip -o -selection clipboard 2>/dev/null || wl-paste 2>/dev/null'], { encoding: 'utf8' }).stdout || '';
}
function clearClipboard() {
  if (process.platform === 'win32') spawnSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value $null']);
  else if (process.platform === 'darwin') spawnSync('sh', ['-c', 'printf "" | pbcopy']);
}

const fromPipe = !process.stdin.isTTY;
const text = fromPipe ? fs.readFileSync(0, 'utf8') : readClipboard();

// "name@coldd.dev - password" (also accepts ":" or an en/em dash between them).
const found = new Map();
for (const m of text.matchAll(/([a-z0-9._%+-]+)@coldd\.dev\s*[-:\u2013\u2014]\s*(\S+)/gi)) {
  found.set(m[1].toLowerCase(), m[2]);
}
if (!found.size) {
  console.error('No "name@coldd.dev - password" lines found. Copy the message first, then run this again.');
  process.exit(1);
}

const envName = (name) => 'MAILBOX_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const quote = (v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const file = path.join(os.tmpdir(), 'coldd-mailboxes-' + crypto.randomBytes(6).toString('hex') + '.env');
let ok = false;
try {
  fs.writeFileSync(file, [...found].map(([name, pass]) => envName(name) + '=' + quote(pass)).join('\n') + '\n', { mode: 0o600 });
  const win = process.platform === 'win32';
  const r = spawnSync('supabase', ['secrets', 'set', '--env-file', win ? '"' + file + '"' : file], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32', encoding: 'utf8' });
  ok = r.status === 0;
  if (!ok) console.error('Supabase CLI could not save the secrets:', (r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' '));
} finally {
  try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
}
if (!ok) process.exit(1);
if (!fromPipe) clearClipboard();
console.log('Saved ' + found.size + ' mailbox password' + (found.size === 1 ? '' : 's') + ' (' + [...found.keys()].map((n) => n + '@coldd.dev').join(', ') + ').');
if (!fromPipe) console.log('Clipboard cleared.');
console.log('mailbox-poll picks them up on its next run (every 10 minutes).');
