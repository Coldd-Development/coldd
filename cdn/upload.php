<?php
// cdn/upload.php - deploy to the cdn.coldd.dev web root (public_html/upload.php).
//
// Receives files straight from the browser, for two kinds of storage:
//   vis=pub   public images (thumbnails, gallery, avatars) -> Storage Box + a copy in public_html/<path>
//   vis=priv  paid product files + legal docs -> Storage Box ONLY (never web-reachable here)
//
// The browser never holds a password: our Supabase edge functions mint a short-lived HMAC
// token after checking the caller is allowed, and this script only verifies it. The secret
// and Storage Box key live OUTSIDE the web root in ../private/ (see cdn/README.md).
// With no 'box' section in the config it falls back to plain local disk (legacy mode).
//
//   POST ?action=upload&path=..&exp=..&max=..&ow=0|1&vis=pub|priv&sig=..   multipart field "file"
//        private files may be sent in chunks: &offset=N&last=0|1 (offset must equal bytes so far)
//   POST ?action=delete&path=..&exp=..&vis=..&sig=..
//   POST ?action=selftest&path=selftest/ping.txt&exp=..&vis=priv&sig=..   (signed) checks the Storage Box link
//   GET  ?action=ping   -> {"ok":true,...}

declare(strict_types=1);

require dirname(__DIR__) . '/private/cdn-lib.php';

$cfg = cdn_cfg();
$secret = (string)($cfg['secret'] ?? '');
$origins = (array)($cfg['allowed_origins'] ?? ['https://coldd.dev']);
$pubRoot = rtrim((string)($cfg['root'] ?? __DIR__), '/');
$privRoot = rtrim((string)($cfg['private_root'] ?? dirname(__DIR__) . '/private/files'), '/');
$tmpRoot = dirname(__DIR__) . '/private/incoming';
$useBox = box_enabled();

const IMG_EXT = [
    'jpg' => ['image/jpeg'], 'jpeg' => ['image/jpeg'], 'png' => ['image/png'],
    'webp' => ['image/webp'], 'gif' => ['image/gif'], 'avif' => ['image/avif'],
];
const BOX_DOWN = 'Storage is temporarily unavailable. Please try again in a minute.';

function out(array $body, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($body);
    exit;
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $origins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: content-type');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

$action = (string)($_GET['action'] ?? '');
if ($action === 'ping') out(['ok' => true, 'box' => $useBox, 'sftp' => box_has_sftp()]);
if ($secret === '' || strlen($secret) < 32) out(['ok' => false, 'error' => 'Storage is not configured.'], 503);
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(['ok' => false, 'error' => 'POST required.'], 405);

$path = (string)($_GET['path'] ?? '');
$exp  = (int)($_GET['exp'] ?? 0);
$max  = (int)($_GET['max'] ?? 0);
$ow   = (string)($_GET['ow'] ?? '0') === '1' ? '1' : '0';
$vis  = (string)($_GET['vis'] ?? 'pub') === 'priv' ? 'priv' : 'pub';
$sig  = (string)($_GET['sig'] ?? '');

if ($exp < time()) out(['ok' => false, 'error' => 'Upload link expired. Please try again.'], 403);
$expected = hash_hmac('sha256', implode('|', ['v2', $action, $path, $exp, $max, $ow, $vis]), $secret);
if (!hash_equals($expected, $sig)) out(['ok' => false, 'error' => 'Invalid upload token.'], 403);

// Path rules: lowercase, no traversal, no dotfiles.
if (!preg_match('#^[a-z0-9][a-z0-9._\-/]{0,240}$#', $path) || str_contains($path, '..') || str_contains($path, '//') || str_contains($path, '/.')) {
    out(['ok' => false, 'error' => 'Bad path.'], 400);
}

// ---- Storage Box link check (signed) ----
if ($action === 'selftest') {
    $steps = ['sftp_support' => box_has_sftp(), 'box_configured' => $useBox];
    if (!$useBox) out(['ok' => false, 'steps' => $steps, 'error' => 'No box section in config.'], 200);
    @mkdir($tmpRoot, 0700, true);
    $tf = $tmpRoot . '/selftest.txt';
    file_put_contents($tf, 'coldd storage box self test ' . date('c'));
    $steps['put'] = box_put('private/' . $path, $tf) ?? 'ok';
    [$st, $sz] = box_size('private/' . $path);
    $steps['size'] = $st . ':' . $sz;
    $buf = '';
    $steps['get'] = box_stream('private/' . $path, 0, max(0, $sz - 1), function ($d) use (&$buf) { $buf .= $d; return strlen($d); }) ?? 'ok';
    $steps['roundtrip_match'] = ($buf === file_get_contents($tf));
    $steps['delete'] = box_delete('private/' . $path) ?? 'ok';
    @unlink($tf);
    out(['ok' => $steps['put'] === 'ok' && $steps['get'] === 'ok' && $steps['roundtrip_match'] && $steps['delete'] === 'ok', 'steps' => $steps]);
}

$ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
if ($vis === 'pub' && !isset(IMG_EXT[$ext])) out(['ok' => false, 'error' => 'File type not allowed.'], 400);
$dest = ($vis === 'priv' ? $privRoot : $pubRoot) . '/' . $path;
$boxRel = ($vis === 'priv' ? 'private/' : 'public/') . $path;

if ($action === 'delete') {
    if ($useBox && box_delete($boxRel) !== null) out(['ok' => false, 'error' => BOX_DOWN], 503);
    if (is_file($dest) && !@unlink($dest)) out(['ok' => false, 'error' => 'Could not delete.'], 500);
    out(['ok' => true]);
}
if ($action !== 'upload') out(['ok' => false, 'error' => 'Unknown action.'], 400);

$f = $_FILES['file'] ?? null;
if (!$f || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) {
    out(['ok' => false, 'error' => 'No file received (too large?).'], 400);
}

// ---- Chunked private upload ----
if ($vis === 'priv' && isset($_GET['offset'])) {
    $offset = (int)$_GET['offset'];
    $last = (string)($_GET['last'] ?? '0') === '1';
    // With a Storage Box, chunks assemble in a temp folder and are pushed to the box on the last chunk.
    $partDir = $useBox ? $tmpRoot : dirname($dest);
    if (!is_dir($partDir) && !@mkdir($partDir, 0700, true) && !is_dir($partDir)) out(['ok' => false, 'error' => 'Storage unavailable.'], 503);
    $part = $partDir . '/.up-' . sha1($path) . '.part';
    if ($offset === 0) {
        if ($ow !== '1') {
            $exists = $useBox ? (box_size($boxRel)[0] === 'ok') : file_exists($dest);
            if ($exists) out(['ok' => false, 'error' => 'File already exists.'], 409);
        }
        @unlink($part);
    } elseif (!is_file($part) || filesize($part) !== $offset) {
        out(['ok' => false, 'error' => 'Chunk out of order. Please retry the upload.', 'have' => is_file($part) ? filesize($part) : 0], 409);
    }
    if ($max > 0 && $offset + $f['size'] > $max) { @unlink($part); out(['ok' => false, 'error' => 'File is too large.'], 413); }
    $in = fopen($f['tmp_name'], 'rb');
    $outH = fopen($part, 'ab');
    if (!$in || !$outH || stream_copy_to_stream($in, $outH) === false) out(['ok' => false, 'error' => 'Storage unavailable.'], 503);
    fclose($in); fclose($outH);
    if (!$last) out(['ok' => true, 'received' => (int)filesize($part)]);
    $size = (int)filesize($part);
    if ($useBox) {
        if (box_put($boxRel, $part) !== null) out(['ok' => false, 'error' => BOX_DOWN], 503); // part kept: the browser can retry the last chunk
        @unlink($part);
    } else {
        if (!@rename($part, $dest)) out(['ok' => false, 'error' => 'Storage unavailable.'], 503);
        @chmod($dest, 0640);
    }
    out(['ok' => true, 'path' => $path, 'size' => $size]);
}

// ---- Single-request upload (images, small files) ----
if ($max > 0 && $f['size'] > $max) out(['ok' => false, 'error' => 'File is too large.'], 413);
if ($vis === 'pub') {
    // Verify the bytes really are the image type the extension claims.
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($f['tmp_name']);
    if (!in_array($mime, IMG_EXT[$ext], true)) out(['ok' => false, 'error' => 'File content does not match its type.'], 400);
}
if ($ow !== '1') {
    $exists = ($useBox && $vis === 'priv') ? (box_size($boxRel)[0] === 'ok') : file_exists($dest);
    if ($exists) out(['ok' => false, 'error' => 'File already exists.'], 409);
}

if ($vis === 'priv' && $useBox) {
    if (box_put($boxRel, $f['tmp_name']) !== null) out(['ok' => false, 'error' => BOX_DOWN], 503);
    out(['ok' => true, 'path' => $path, 'size' => (int)$f['size']]);
}

// Public image (or legacy local mode): write the local copy atomically, then mirror to the box.
$dir = dirname($dest);
if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) out(['ok' => false, 'error' => BOX_DOWN], 503);
$tmp = $dest . '.part' . bin2hex(random_bytes(4));
if (!@move_uploaded_file($f['tmp_name'], $tmp) || !@rename($tmp, $dest)) {
    @unlink($tmp);
    out(['ok' => false, 'error' => BOX_DOWN], 503);
}
@chmod($dest, $vis === 'priv' ? 0640 : 0644);
if ($useBox && $vis === 'pub' && box_put($boxRel, $dest) !== null) {
    @unlink($dest); // don't leave an image that exists only on the hosting disk
    out(['ok' => false, 'error' => BOX_DOWN], 503);
}
out(['ok' => true, 'path' => $path, 'size' => (int)filesize($dest)]);
