<?php
// cdn/cdn-lib.php - deploy to /home/<user>/web/<domain>/private/cdn-lib.php (NOT public_html).
//
// Shared by upload.php and download.php. Talks to the Hetzner Storage Box over SFTP using
// PHP's curl extension (libcurl built with SFTP), so no root access, no mount and no extra
// PHP library is needed. The Storage Box is the source of truth:
//   <base>/public/<path>   public images (the hosting disk keeps a convenience copy for nginx)
//   <base>/private/<path>  paid product files, staged files, legal docs (hosting keeps NOTHING)
//
// Config (private/cdn-config.php):
//   'box' => ['host'=>'uXXXX.your-storagebox.de','port'=>23,'user'=>'uXXXX',
//             'key'=>'/home/<user>/web/<domain>/private/storagebox_key',
//             'base'=>'coldd', 'host_sha256'=>'<base64>' , 'host_md5'=>'<hex>']

declare(strict_types=1);

function cdn_cfg(): array {
    static $c = null;
    if ($c === null) {
        $f = __DIR__ . '/cdn-config.php';
        $c = is_file($f) ? (array)(require $f) : [];
    }
    return $c;
}

function box_enabled(): bool {
    $b = cdn_cfg()['box'] ?? null;
    return is_array($b) && !empty($b['host']) && !empty($b['user']) && !empty($b['key']) && function_exists('curl_init');
}

function box_has_sftp(): bool {
    if (!function_exists('curl_version')) return false;
    $v = curl_version();
    return in_array('sftp', (array)($v['protocols'] ?? []), true);
}

function box_url(string $rel): string {
    $b = cdn_cfg()['box'];
    $path = trim((string)($b['base'] ?? 'coldd'), '/') . '/' . ltrim($rel, '/');
    $enc = implode('/', array_map('rawurlencode', explode('/', $path)));
    return 'sftp://' . $b['host'] . ':' . (int)($b['port'] ?? 23) . '/' . $enc;
}

/** Remote absolute path (inside the chrooted box) for quote commands. */
function box_abs(string $rel): string {
    $b = cdn_cfg()['box'];
    return '/' . trim((string)($b['base'] ?? 'coldd'), '/') . '/' . ltrim($rel, '/');
}

function box_handle(string $url) {
    $b = cdn_cfg()['box'];
    $ch = curl_init($url);
    $opts = [
        CURLOPT_PROTOCOLS => CURLPROTO_SFTP,
        CURLOPT_USERNAME => (string)$b['user'],
        CURLOPT_SSH_PRIVATE_KEYFILE => (string)$b['key'],
        CURLOPT_SSH_AUTH_TYPES => CURLSSH_AUTH_PUBLICKEY,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_LOW_SPEED_LIMIT => 1024,
        CURLOPT_LOW_SPEED_TIME => 60,
        CURLOPT_RETURNTRANSFER => true,
    ];
    if (!empty($b['pubkey'])) $opts[CURLOPT_SSH_PUBLIC_KEYFILE] = (string)$b['pubkey'];
    // Pin the Storage Box's host key so the connection can't be intercepted.
    if (!empty($b['host_sha256']) && defined('CURLOPT_SSH_HOST_PUBLIC_KEY_SHA256')) {
        $opts[constant('CURLOPT_SSH_HOST_PUBLIC_KEY_SHA256')] = (string)$b['host_sha256'];
    } elseif (!empty($b['host_md5'])) {
        $opts[CURLOPT_SSH_HOST_PUBLIC_KEY_MD5] = (string)$b['host_md5'];
    }
    curl_setopt_array($ch, $opts);
    return $ch;
}

/** Upload a local file to the box. Returns null on success or an error string. */
function box_put(string $rel, string $localFile): ?string {
    $fh = @fopen($localFile, 'rb');
    if (!$fh) return 'local file unreadable';
    $ch = box_handle(box_url($rel));
    curl_setopt_array($ch, [
        CURLOPT_UPLOAD => true,
        CURLOPT_INFILE => $fh,
        CURLOPT_INFILESIZE => (int)filesize($localFile),
        CURLOPT_FTP_CREATE_MISSING_DIRS => 1,
        CURLOPT_TIMEOUT => 0,
    ]);
    $ok = curl_exec($ch);
    $err = $ok === false ? curl_error($ch) . ' (' . curl_errno($ch) . ')' : null;
    curl_close($ch);
    fclose($fh);
    return $err;
}

/** @return array{0:string,1:int} [status ok|missing|error, size] */
function box_size(string $rel): array {
    $ch = box_handle(box_url($rel));
    curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_TIMEOUT => 30]);
    curl_exec($ch);
    $no = curl_errno($ch);
    $size = (int)curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
    curl_close($ch);
    if ($no === 0) return ['ok', max(0, $size)];
    if ($no === 78) return ['missing', 0]; // CURLE_REMOTE_FILE_NOT_FOUND
    return ['error', 0];
}

/** Stream bytes [start,end] of a box file to $sink(string $chunk): int. Returns null or error string. */
function box_stream(string $rel, int $start, int $end, callable $sink): ?string {
    $ch = box_handle(box_url($rel));
    curl_setopt_array($ch, [
        CURLOPT_RANGE => $start . '-' . $end,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_WRITEFUNCTION => function ($c, $data) use ($sink) { return $sink($data); },
    ]);
    $ok = curl_exec($ch);
    $no = curl_errno($ch);
    $err = $ok === false ? curl_error($ch) . ' (' . $no . ')' : null;
    curl_close($ch);
    return ($no === 23 /* write aborted by client */) ? null : $err;
}

/** Delete a box file. Returns null on success (or already gone), else error string. */
function box_delete(string $rel): ?string {
    $b = cdn_cfg()['box'];
    $ch = box_handle('sftp://' . $b['host'] . ':' . (int)($b['port'] ?? 23) . '/');
    curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_QUOTE => ['rm ' . box_abs($rel)], CURLOPT_TIMEOUT => 30]);
    $ok = curl_exec($ch);
    $no = curl_errno($ch);
    $err = $ok === false ? curl_error($ch) . ' (' . $no . ')' : null;
    curl_close($ch);
    // 21 = quote command failed (file already gone): treat as success.
    return ($no === 0 || $no === 21) ? null : $err;
}
