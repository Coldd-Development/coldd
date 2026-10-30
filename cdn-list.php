<?php
// cdn-list.php - signed, read-only folder listing for the Storage Box (deployed with the site,
// so it sits in public_html next to upload.php and shares its ../private/ config).
//
// Finds files that were stored but never recorded in the database, e.g. an upload that
// finished after the product had already been saved. Lists names only; never reads or
// changes a file.
//
//   POST ?path=<folder>|root&exp=..&vis=priv|pub&sig=..
//   sig = HMAC-SHA256(secret, "v2|list|<path>|<exp>|0|0|<vis>")  (same scheme as upload.php)
//   The root listing of private/ also reports unfinished chunked uploads in the temp folder.

declare(strict_types=1);

require dirname(__DIR__) . '/private/cdn-lib.php';

function out(array $body, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    header('X-Robots-Tag: noindex');
    echo json_encode($body);
    exit;
}

$secret = (string)(cdn_cfg()['secret'] ?? '');
if ($secret === '' || strlen($secret) < 32) out(['ok' => false, 'error' => 'Storage is not configured.'], 503);
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(['ok' => false, 'error' => 'POST required.'], 405);
if (!box_enabled()) out(['ok' => false, 'error' => 'No box section in config.'], 503);

$path = (string)($_GET['path'] ?? '');
$exp  = (int)($_GET['exp'] ?? 0);
$vis  = (string)($_GET['vis'] ?? 'priv') === 'pub' ? 'pub' : 'priv';
$sig  = (string)($_GET['sig'] ?? '');

if ($exp < time() || $exp > time() + 900) out(['ok' => false, 'error' => 'Link expired.'], 403);
$expected = hash_hmac('sha256', implode('|', ['v2', 'list', $path, $exp, 0, '0', $vis]), $secret);
if (!hash_equals($expected, $sig)) out(['ok' => false, 'error' => 'Invalid token.'], 403);
if ($path !== 'root' && (!preg_match('#^[a-z0-9][a-z0-9._\-/]{0,240}$#', $path) || str_contains($path, '..') || str_contains($path, '/.'))) {
    out(['ok' => false, 'error' => 'Bad path.'], 400);
}

$rel = ($vis === 'priv' ? 'private' : 'public') . ($path === 'root' ? '' : '/' . $path);
$ch = box_handle(rtrim(box_url($rel), '/') . '/');
curl_setopt_array($ch, [CURLOPT_DIRLISTONLY => true, CURLOPT_TIMEOUT => 60]);
$body = curl_exec($ch);
$err = $body === false ? curl_error($ch) . ' (' . curl_errno($ch) . ')' : null;
curl_close($ch);
if ($err !== null) out(['ok' => false, 'error' => $err], 404);

$names = [];
foreach (explode("\n", (string)$body) as $n) {
    $n = trim($n);
    if ($n !== '' && $n !== '.' && $n !== '..') $names[] = $n;
}
sort($names);
$res = ['ok' => true, 'path' => $path, 'names' => $names];

if ($path === 'root' && $vis === 'priv') {
    $tmpRoot = dirname(__DIR__) . '/private/incoming';
    $parts = [];
    foreach ((array)@scandir($tmpRoot) as $n) {
        if (is_string($n) && str_ends_with($n, '.part')) {
            $parts[] = ['name' => $n, 'size' => (int)@filesize($tmpRoot . '/' . $n), 'mtime' => date('c', (int)@filemtime($tmpRoot . '/' . $n))];
        }
    }
    $res['unfinished'] = $parts;
}
out($res);
