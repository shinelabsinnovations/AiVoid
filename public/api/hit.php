<?php
// POST /api/hit.php  {"type":"visit"}  or  {"type":"clean","files":12}
define('AIVOID', true);
require __DIR__ . '/lib.php';

header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit;
}

// Only accept counts sent from this site's own pages.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : '') !== ($_SERVER['HTTP_HOST'] ?? '')) {
    http_response_code(403);
    exit;
}

$body = file_get_contents('php://input', false, null, 0, 257);
if ($body === false || strlen($body) > 256) {
    http_response_code(413);
    exit;
}

$data = json_decode($body, true);
if (!is_array($data)) {
    http_response_code(400);
    exit;
}

$ip = $_SERVER['REMOTE_ADDR'] ?? '';
$country = $_SERVER['HTTP_CF_IPCOUNTRY'] ?? aivoid_country($ip);

try {
    $ok = aivoid_record(aivoid_db(), [
        'type' => $data['type'] ?? null,
        'files' => $data['files'] ?? null,
        'ip' => $ip,
        'ua' => $_SERVER['HTTP_USER_AGENT'] ?? '',
        'country' => $country,
    ]);
} catch (Throwable $e) {
    error_log('AiVoid hit: ' . $e->getMessage());
    http_response_code(500);
    exit;
}

http_response_code($ok ? 204 : 400);
