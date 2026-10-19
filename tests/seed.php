<?php
/* Fills the local data folder (.dev-data) with sample traffic so the metrics
   page has something to show. The page labels it as sample data.

     php tests/seed.php          add sample data
     php tests/seed.php --clear  remove it again */

define('AIVOID', true);
define('AIVOID_DATA_DIR', dirname(__DIR__) . '/.dev-data');
require dirname(__DIR__) . '/public/api/lib.php';

$db = aivoid_db();
$db->exec('DELETE FROM daily; DELETE FROM seen;');
if (in_array('--clear', $argv, true)) {
    @unlink(AIVOID_DATA_DIR . '/sample');
    echo "Cleared.\n";
    exit;
}

$countries = ['US', 'IN', 'GB', 'DE', 'BR', 'JP', 'CA', 'FR', 'AU', 'ES', 'NL', 'KR', 'MX', 'IT', 'SE', 'PL', 'TR', 'ID', 'XX'];
$weight = [30, 18, 9, 8, 6, 5, 5, 4, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1];
mt_srand(7);
$ins = $db->prepare('INSERT INTO daily (day, country, visitors, pageviews, files, cleans) VALUES (?, ?, ?, ?, ?, ?)');
$db->beginTransaction();
for ($i = 420; $i >= 0; $i--) {
    $day = aivoid_day(-$i);
    $growth = 0.25 + (420 - $i) / 420;
    $wd = (int) gmdate('w', strtotime($day . ' UTC'));
    $wk = ($wd === 0 || $wd === 6) ? 0.7 : 1;
    foreach ($countries as $k => $c) {
        $v = (int) round($weight[$k] * $growth * $wk * (0.6 + mt_rand() / mt_getrandmax() * 0.8));
        if (!$v) continue;
        $cleans = (int) round($v * (0.35 + mt_rand() / mt_getrandmax() * 0.2));
        $ins->execute([$day, $c, $v, (int) round($v * 1.4), (int) round($cleans * (2 + mt_rand() / mt_getrandmax() * 6)), $cleans]);
    }
}
$db->commit();
touch(AIVOID_DATA_DIR . '/sample');
echo "Sample data written to .dev-data\n";
