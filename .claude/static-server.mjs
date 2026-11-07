// Minimal static file server for local design review of the coldd site.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
};

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  let target = normalize(join(ROOT, clean)).replace(/\\/g, '/');
  if (!target.startsWith(ROOT.replace(/\\/g, '/'))) return null;
  try {
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
  } catch {
    // fall through to the 404 below
  }
  return target;
}

createServer((req, res) => {
  // Live, catalog-loader.php only redirects to catalog.js (versioned by its hash); PHP can't run here.
  if ((req.url || '').split('?')[0] === '/catalog-loader.php') {
    res.writeHead(302, { location: '/catalog.js?v=local', 'cache-control': 'no-store' }).end();
    return;
  }
  const file = resolve(req.url || '/');
  if (!file) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let serveFile = file;
  let status = 200;
  try {
    statSync(serveFile);
  } catch {
    // Mirror GitHub Pages: serve the custom 404.html for any unmatched
    // path (with a 404 status) so client-side fallbacks like the pretty
    // /product/<slug> router can be exercised locally.
    serveFile = join(ROOT, '404.html');
    status = 404;
    try { statSync(serveFile); } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
  }
  res.writeHead(status, {
    'content-type': TYPES[extname(serveFile).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(serveFile).pipe(res);
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
