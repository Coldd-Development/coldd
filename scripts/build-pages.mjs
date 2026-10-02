// scripts/build-pages.mjs
//
// Assembles the PUBLIC site into ./dist for Cloudflare Pages. GitHub Pages
// published the whole repo root (so /supabase/*.sql was downloadable); this is
// an allowlist instead, so source folders and tooling are never deployed.
//
//   node scripts/build-pages.mjs        -> dist/
//   npx wrangler pages deploy dist --project-name coldd

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const OUT = "dist";
// Never published. Everything else with an allowed extension is.
const SKIP_DIRS = new Set([".git", ".github", ".claude", ".impeccable", "supabase", "cdn", "scripts", "scratchpad", "node_modules", OUT]);
const SKIP_FILES = new Set(["CNAME", "cloudflare-worker-og.js", "placeholder.zip", ".env.example", ".gitignore"]);
const ALLOWED_EXT = new Set([".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".ico", ".txt", ".xml", ".json", ".webmanifest", ".woff2"]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
let count = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_FILES.has(name) || name.startsWith(".")) continue;
    const src = join(dir, name);
    if (statSync(src).isDirectory()) {
      if (dir === "." && SKIP_DIRS.has(name)) continue;
      walk(src);
    } else if (ALLOWED_EXT.has(extname(name).toLowerCase())) {
      const dest = join(OUT, src);
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(src, dest);
      count++;
    }
  }
}
walk(".");

// Response headers (GitHub Pages could not set these). CSP is deliberately not
// included here - see SECURITY-HEADERS.md, it needs its own testing pass.
writeFileSync(join(OUT, "_headers"), `/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Strict-Transport-Security: max-age=15552000; includeSubDomains
`);

for (const must of ["index.html", "404.html", "styles.css", "app.js", "robots.txt"]) {
  if (!existsSync(join(OUT, must))) { console.error(`build: missing ${must}`); process.exit(1); }
}
for (const mustNot of ["supabase", "cdn", "scripts"]) {
  if (existsSync(join(OUT, mustNot))) { console.error(`build: ${mustNot}/ leaked into dist`); process.exit(1); }
}
console.log(`build: ${count} files -> ${OUT}/`);
