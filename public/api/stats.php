<?php
// GET /api/stats.php?range=today|yesterday|week|month|year|lifetime
define('AIVOID', true);
require __DIR__ . '/lib.php';

header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json; charset=utf-8');

try {
    $data = aivoid_stats(aivoid_db(), (string) ($_GET['range'] ?? 'week'));
} catch (Throwable $e) {
    error_log('AiVoid stats: ' . $e->getMessage());
    http_response_code(500);
    echo '{"error":"unavailable"}';
    exit;
}

header('Cache-Control: ' . (!empty($data['sample']) ? 'no-store' : 'public, max-age=60'));
echo json_encode($data, JSON_UNESCAPED_SLASHES);
