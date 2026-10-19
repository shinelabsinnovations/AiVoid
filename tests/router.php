<?php
/* Local development router for PHP's built-in server:

     php -S localhost:5173 -t public tests/router.php

   Serves public/ at /, tests/ at /tests/, /metrics as metrics.html, and runs
   the API against a local data folder (.dev-data). POST /__asset?name=...
   lets tests/make-assets.html save the share card and icons. */

$root = dirname(__DIR__);
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/');

define('AIVOID_DATA_DIR', $root . '/.dev-data');

$types = [
    'html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8',
    'svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'json' => 'application/json',
];

if (preg_match('#^/api/(hit|stats)\.php$#', $path, $m)) {
    require $root . '/public/api/' . $m[1] . '.php';
    return true;
}

if ($path === '/__asset' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $allowed = ['og.jpg', 'icon-32.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
    $name = $_GET['name'] ?? '';
    if (!in_array($name, $allowed, true)) { http_response_code(400); return true; }
    file_put_contents($root . '/public/assets/' . $name, file_get_contents('php://input'));
    http_response_code(204);
    return true;
}

if (str_starts_with($path, '/tests/')) {
    $file = realpath($root . $path . (str_ends_with($path, '/') ? 'index.html' : ''));
    if (!$file || !str_starts_with($file, realpath($root . '/tests')) || !is_file($file)) { http_response_code(404); return true; }
    header('Content-Type: ' . ($types[pathinfo($file, PATHINFO_EXTENSION)] ?? 'application/octet-stream'));
    header('Cache-Control: no-store');
    readfile($file);
    return true;
}

// Extensionless pages, as Nginx's try_files $uri.html does in production.
if (!pathinfo($path, PATHINFO_EXTENSION) && $path !== '/' && is_file($root . '/public' . $path . '.html')) {
    header('Content-Type: text/html; charset=utf-8');
    readfile($root . '/public' . $path . '.html');
    return true;
}

// The API library is never served directly.
if ($path === '/api/lib.php') { http_response_code(404); return true; }

return false;
