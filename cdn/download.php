<?php
// cdn/download.php - deploy to public_html/download.php on cdn.coldd.dev.
//
// Streams a PRIVATE product file (stored outside the web root) to a buyer.
// Only works with a short-lived HMAC link minted by our Supabase edge functions
// AFTER they verified the purchase, so the file list is never browsable and a
// link can't be reused after it expires. Supports Range requests so large
// downloads can resume.
//
//   GET /download.php?path=..&name=..&exp=..&sig=..

declare(strict_types=1);

$cfgFile = dirname(__DIR__) . '/cdn-config.php';
$cfg = is_file($cfgFile) ? (require $cfgFile) : [];
$secret = (string)($cfg['secret'] ?? '');
$privRoot = rtrim((string)($cfg['private_root'] ?? dirname(__DIR__) . '/private-files'), '/');

function fail(int $code, string $msg): never {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo $msg;
    exit;
}

if ($secret === '' || strlen($secret) < 32) fail(503, 'Downloads are not configured.');
$path = (string)($_GET['path'] ?? '');
$name = (string)($_GET['name'] ?? '');
$exp  = (int)($_GET['exp'] ?? 0);
$sig  = (string)($_GET['sig'] ?? '');

if ($exp < time()) fail(403, 'This download link has expired. Please request a new one from your account.');
$expected = hash_hmac('sha256', implode('|', ['v2', 'download', $path, $exp, $name]), $secret);
if (!hash_equals($expected, $sig)) fail(403, 'Invalid download link.');
if (!preg_match('#^[a-z0-9][a-z0-9._\-/]{0,240}$#', $path) || str_contains($path, '..') || str_contains($path, '//') || str_contains($path, '/.')) fail(400, 'Bad path.');

$file = $privRoot . '/' . $path;
if (!is_file($file)) fail(404, 'File not found.');

$size = filesize($file);
$start = 0;
$end = $size - 1;
$status = 200;
if (isset($_SERVER['HTTP_RANGE']) && preg_match('/^bytes=(\d*)-(\d*)$/', $_SERVER['HTTP_RANGE'], $m) && ($m[1] !== '' || $m[2] !== '')) {
    if ($m[1] === '') { $start = max(0, $size - (int)$m[2]); }
    else { $start = (int)$m[1]; if ($m[2] !== '') $end = min($end, (int)$m[2]); }
    if ($start > $end || $start >= $size) { header("Content-Range: bytes */$size"); fail(416, 'Bad range.'); }
    $status = 206;
}

$safeName = preg_replace('/[^A-Za-z0-9._ \-]+/', '_', $name !== '' ? $name : basename($path));
http_response_code($status);
header('Content-Type: application/octet-stream');
header('Content-Disposition: attachment; filename="' . $safeName . '"; filename*=UTF-8\'\'' . rawurlencode($safeName));
header('Accept-Ranges: bytes');
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');
header('Content-Length: ' . ($end - $start + 1));
if ($status === 206) header("Content-Range: bytes $start-$end/$size");

@set_time_limit(0);
while (ob_get_level() > 0) ob_end_clean();
$fh = fopen($file, 'rb');
fseek($fh, $start);
$left = $end - $start + 1;
while ($left > 0 && !feof($fh) && !connection_aborted()) {
    $chunk = fread($fh, (int)min(1048576, $left));
    if ($chunk === false || $chunk === '') break;
    echo $chunk;
    $left -= strlen($chunk);
    flush();
}
fclose($fh);
