// scripts/make-box-config.mjs
//
// Prepares everything the hosting account needs to use the Hetzner Storage Box, in
// scratchpad/cdn-upload/ (git-ignored). Run once you know the box username + host:
//
//   node scripts/make-box-config.mjs u123456 u123456.your-storagebox.de
//
// Creates: a fresh SSH key pair, cdn-config.php (existing secret + box section with the box's
// host key pinned), and copies of upload.php / download.php / cdn-lib.php. Then:
//   1. Add scratchpad/cdn-upload/private/storagebox_key.pub as an authorized key on the box.
//   2. Put the files from scratchpad/cdn-upload/ on the server (see cdn/README.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [user, host] = process.argv.slice(2);
if (!user || !host || !/^u\d+$/.test(user)) { console.error("usage: node scripts/make-box-config.mjs u123456 u123456.your-storagebox.de"); process.exit(1); }
const HESTIA_HOME = process.env.HESTIA_HOME || "/home/frchrono697497";
const DOMAIN = process.env.HESTIA_DOMAIN || "coldd.dev";
const out = "scratchpad/cdn-upload";
mkdirSync(`${out}/private`, { recursive: true });
mkdirSync(`${out}/public_html`, { recursive: true });

const secret = readFileSync("scratchpad/cdn-secret.txt", "utf8").trim();

// 1. SSH key (RSA/PEM: widest libssh2 support)
const keyPath = `${out}/private/storagebox_key`;
for (const f of [keyPath, keyPath + ".pub"]) if (existsSync(f)) rmSync(f);
execFileSync("ssh-keygen", ["-t", "rsa", "-b", "4096", "-m", "PEM", "-N", "", "-C", "coldd-hosting-to-storagebox", "-f", keyPath], { stdio: "ignore" });

// 2. Pin the box's host key
const scan = execFileSync("ssh-keyscan", ["-p", "23", "-t", "ed25519,rsa,ecdsa", host], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  .split("\n").filter((l) => l && !l.startsWith("#"));
if (!scan.length) { console.error("Could not reach the Storage Box on port 23. Is SSH support enabled?"); process.exit(1); }
// libssh2 negotiates the strongest key type the box offers; pin whichever types it advertises.
const pins = scan.map((l) => { const [, type, b64] = l.split(" "); const raw = Buffer.from(b64, "base64"); return { type, sha256: createHash("sha256").update(raw).digest("base64").replace(/=+$/, ""), md5: createHash("md5").update(raw).digest("hex") }; });
const pref = pins.find((p) => p.type === "ssh-ed25519") || pins.find((p) => p.type === "ssh-rsa") || pins[0];

// 3. Server config
const keyOnServer = `${HESTIA_HOME}/web/${DOMAIN}/private/storagebox_key`;
writeFileSync(`${out}/private/cdn-config.php`, `<?php return [
    'secret' => '${secret}',
    'allowed_origins' => ['https://coldd.dev'],
    'box' => [
        'host' => '${host}', 'port' => 23, 'user' => '${user}',
        'key' => '${keyOnServer}', 'pubkey' => '${keyOnServer}.pub',
        'base' => 'coldd',
        'host_sha256' => '${pref.sha256}', 'host_md5' => '${pref.md5}',
    ],
];
`);
for (const f of ["upload.php", "download.php"]) copyFileSync(`cdn/${f}`, `${out}/public_html/${f}`);
copyFileSync("cdn/cdn-lib.php", `${out}/private/cdn-lib.php`);
console.log(`Host key pinned (${pref.type}). Files ready in ${out}/`);
console.log("\nPUBLIC KEY to add on the Storage Box (safe to share):\n" + readFileSync(keyPath + ".pub", "utf8"));
