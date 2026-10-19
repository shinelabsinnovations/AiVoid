<?php
/* AiVoid metrics: anonymous visit and file counts in SQLite, plus a country
   lookup from a MaxMind-format database (the free DB-IP "IP to Country Lite").
   No IP addresses, user agents or file contents are stored.

   Data folder (database, salt, country file), first match wins:
     the AIVOID_DATA_DIR constant, the AIVOID_DATA environment variable,
     or ../../aivoid-private relative to this file (outside the web root). */

if (!defined('AIVOID')) {
    http_response_code(404);
    exit;
}

const AIVOID_RANGES = ['today', 'yesterday', 'week', 'month', 'year', 'lifetime'];
const AIVOID_BOTS = '/bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python-requests|httpclient/i';
const AIVOID_MAX_FILES = 5000;

function aivoid_data_dir(): string
{
    if (defined('AIVOID_DATA_DIR')) return AIVOID_DATA_DIR;
    $env = getenv('AIVOID_DATA');
    return $env ?: dirname(__DIR__, 2) . '/aivoid-private';
}

function aivoid_db(): PDO
{
    $dir = aivoid_data_dir();
    if (!is_dir($dir)) mkdir($dir, 0750, true);
    $db = new PDO('sqlite:' . $dir . '/aivoid.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    $db->exec('CREATE TABLE IF NOT EXISTS daily (
        day TEXT NOT NULL, country TEXT NOT NULL,
        visitors INTEGER NOT NULL DEFAULT 0, pageviews INTEGER NOT NULL DEFAULT 0,
        files INTEGER NOT NULL DEFAULT 0, cleans INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, country))');
    $db->exec('CREATE TABLE IF NOT EXISTS seen (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash))');
    return $db;
}

function aivoid_salt(): string
{
    $env = getenv('METRICS_SALT');
    if ($env) return $env;
    $file = aivoid_data_dir() . '/salt';
    if (is_file($file)) return trim((string) file_get_contents($file));
    $salt = bin2hex(random_bytes(32));
    file_put_contents($file, $salt, LOCK_EX);
    @chmod($file, 0600);
    return $salt;
}

function aivoid_day(int $offset = 0, ?string $from = null): string
{
    $d = new DateTimeImmutable(($from ?? 'now') . ($from ? 'T00:00:00' : ''), new DateTimeZone('UTC'));
    if ($offset) $d = $d->modify(($offset > 0 ? '+' : '') . $offset . ' day');
    return $d->format('Y-m-d');
}

/* Record one event. Returns true when it was stored or deliberately skipped. */
function aivoid_record(PDO $db, array $e): bool
{
    $ua = (string) ($e['ua'] ?? '');
    if ($ua !== '' && preg_match(AIVOID_BOTS, $ua)) return true;
    $type = $e['type'] ?? null;
    if ($type !== 'visit' && $type !== 'clean') return false;
    $day = aivoid_day();
    $cc = preg_match('/^[A-Z]{2}$/', (string) ($e['country'] ?? '')) ? $e['country'] : 'XX';

    if ($type === 'visit') {
        $hash = substr(hash('sha256', aivoid_salt() . '|' . $day . '|' . ($e['ip'] ?? '') . '|' . $ua), 0, 32);
        $seen = $db->prepare('INSERT OR IGNORE INTO seen (day, hash) VALUES (?, ?)');
        $seen->execute([$day, $hash]);
        $isNew = $seen->rowCount() ? 1 : 0;
        $db->prepare('INSERT INTO daily (day, country, visitors, pageviews) VALUES (?, ?, ?, 1)
                      ON CONFLICT(day, country) DO UPDATE SET visitors = visitors + excluded.visitors, pageviews = pageviews + 1')
           ->execute([$day, $cc, $isNew]);
        $db->prepare('DELETE FROM seen WHERE day < ?')->execute([aivoid_day(-1)]);
        return true;
    }

    $n = max(0, min(AIVOID_MAX_FILES, (int) floor((float) ($e['files'] ?? 0))));
    if (!$n) return false;
    $db->prepare('INSERT INTO daily (day, country, files, cleans) VALUES (?, ?, ?, 1)
                  ON CONFLICT(day, country) DO UPDATE SET files = files + excluded.files, cleans = cleans + 1')
       ->execute([$day, $cc, $n]);
    return true;
}

/* Day window for a range, the window before it (for deltas) and the chart span. */
function aivoid_window(string $range): array
{
    $t = aivoid_day();
    $a = fn(int $n, ?string $d = null) => aivoid_day($n, $d ?? $t);
    switch ($range) {
        case 'today': return ['from' => $t, 'to' => $t, 'prev' => [$a(-1), $a(-1)], 'chart' => [$a(-13), $t], 'bucket' => 'day'];
        case 'yesterday': $y = $a(-1); return ['from' => $y, 'to' => $y, 'prev' => [$a(-2), $a(-2)], 'chart' => [$a(-14), $y], 'bucket' => 'day'];
        case 'week': return ['from' => $a(-6), 'to' => $t, 'prev' => [$a(-13), $a(-7)], 'chart' => [$a(-6), $t], 'bucket' => 'day'];
        case 'month': return ['from' => $a(-29), 'to' => $t, 'prev' => [$a(-59), $a(-30)], 'chart' => [$a(-29), $t], 'bucket' => 'day'];
        case 'year': return ['from' => $a(-364), 'to' => $t, 'prev' => [$a(-729), $a(-365)], 'chart' => [$a(-364), $t], 'bucket' => 'month'];
        default: return ['from' => '0000-01-01', 'to' => $t, 'prev' => null, 'chart' => null, 'bucket' => 'month'];
    }
}

function aivoid_stats(PDO $db, string $range): array
{
    if (!in_array($range, AIVOID_RANGES, true)) $range = 'week';
    $w = aivoid_window($range);
    $today = aivoid_day();
    $first = $db->query('SELECT MIN(day) FROM daily')->fetchColumn() ?: $today;
    [$chartFrom, $chartTo] = $w['chart'] ?? [$first, $today];

    $totals = function (string $from, string $to) use ($db): array {
        $q = $db->prepare('SELECT COALESCE(SUM(visitors),0) AS visitors, COALESCE(SUM(pageviews),0) AS pageviews,
                                  COALESCE(SUM(files),0) AS files, COALESCE(SUM(cleans),0) AS cleans
                           FROM daily WHERE day BETWEEN ? AND ?');
        $q->execute([$from, $to]);
        return array_map('intval', $q->fetch(PDO::FETCH_ASSOC));
    };

    $q = $db->prepare('SELECT country, SUM(visitors) AS visitors, SUM(pageviews) AS pageviews, SUM(files) AS files, SUM(cleans) AS cleans
                       FROM daily WHERE day BETWEEN ? AND ? GROUP BY country ORDER BY visitors DESC, files DESC');
    $q->execute([$w['from'], $w['to']]);
    $countries = array_map(fn($r) => ['country' => $r['country']] + array_map('intval', array_diff_key($r, ['country' => 1])), $q->fetchAll(PDO::FETCH_ASSOC));

    $bucket = $w['bucket'] === 'month' ? 'substr(day, 1, 7)' : 'day';
    $q = $db->prepare("SELECT $bucket AS bucket, SUM(visitors) AS visitors, SUM(files) AS files
                       FROM daily WHERE day BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket");
    $q->execute([$chartFrom, $chartTo]);
    $got = [];
    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) $got[$r['bucket']] = $r;

    // Fill empty buckets so the chart has a continuous axis.
    $series = [];
    if ($w['bucket'] === 'day') {
        for ($d = $chartFrom; $d <= $chartTo; $d = aivoid_day(1, $d)) {
            $series[] = ['key' => $d, 'visitors' => (int) ($got[$d]['visitors'] ?? 0), 'files' => (int) ($got[$d]['files'] ?? 0)];
        }
    } else {
        [$y, $m] = array_map('intval', explode('-', substr($chartFrom, 0, 7)));
        $end = substr($chartTo, 0, 7);
        for ($guard = 0; $guard < 600; $guard++) {
            $key = sprintf('%04d-%02d', $y, $m);
            $series[] = ['key' => $key, 'visitors' => (int) ($got[$key]['visitors'] ?? 0), 'files' => (int) ($got[$key]['files'] ?? 0)];
            if ($key >= $end) break;
            if (++$m > 12) { $m = 1; $y++; }
        }
    }

    $out = [
        'range' => $range,
        'from' => $range === 'lifetime' ? $first : $w['from'],
        'to' => $w['to'],
        'bucket' => $w['bucket'],
        'highlight' => ($range === 'today' || $range === 'yesterday') ? $w['to'] : null,
        'totals' => $totals($w['from'], $w['to']),
        'previous' => $w['prev'] ? $totals($w['prev'][0], $w['prev'][1]) : null,
        'countries' => $countries,
        'series' => $series,
        'generated' => gmdate('c'),
    ];
    // Local preview data is labelled as such on the page.
    if (is_file(aivoid_data_dir() . '/sample')) $out['sample'] = true;
    return $out;
}

/* Country code for an IP address, or null. Reads the database file in place
   (no full load), so a lookup touches only a few kilobytes. */
function aivoid_country(string $ip): ?string
{
    $file = aivoid_data_dir() . '/dbip-country-lite.mmdb';
    if ($ip === '' || !is_file($file)) return null;
    try {
        $r = (new AivoidMmdb($file))->lookup($ip);
    } catch (Throwable $e) {
        return null;
    }
    $code = $r['country']['iso_code'] ?? $r['registered_country']['iso_code'] ?? null;
    return is_string($code) ? strtoupper($code) : null;
}

final class AivoidMmdb
{
    private $fh;
    private int $nodeCount;
    private int $recordSize;
    private int $nodeBytes;
    private int $dataStart;
    private int $ipVersion;

    public function __construct(string $file)
    {
        $this->fh = fopen($file, 'rb');
        if (!$this->fh) throw new RuntimeException('open');
        $size = filesize($file);
        $tailLen = min($size, 131072);
        $tail = $this->read($size - $tailLen, $tailLen);
        $marker = "\xAB\xCD\xEFMaxMind.com";
        $at = strrpos($tail, $marker);
        if ($at === false) throw new RuntimeException('not an mmdb file');
        $metaOffset = $size - $tailLen + $at + strlen($marker);
        $meta = $this->decode($metaOffset, $metaOffset)[0];
        $this->nodeCount = (int) $meta['node_count'];
        $this->recordSize = (int) $meta['record_size'];
        $this->ipVersion = (int) $meta['ip_version'];
        $this->nodeBytes = intdiv($this->recordSize, 4);
        $this->dataStart = $this->nodeCount * $this->nodeBytes + 16;
    }

    public function __destruct()
    {
        if ($this->fh) fclose($this->fh);
    }

    public function lookup(string $ip): ?array
    {
        $bin = @inet_pton($ip);
        if ($bin === false) return null;
        if (strlen($bin) === 16 && substr($bin, 0, 12) === "\0\0\0\0\0\0\0\0\0\0\xFF\xFF") $bin = substr($bin, 12);
        $node = 0;
        if (strlen($bin) === 4 && $this->ipVersion === 6) {
            for ($i = 0; $i < 96 && $node < $this->nodeCount; $i++) $node = $this->record($node, 0);
        }
        $bits = strlen($bin) * 8;
        for ($i = 0; $i < $bits && $node < $this->nodeCount; $i++) {
            $bit = (ord($bin[$i >> 3]) >> (7 - ($i & 7))) & 1;
            $node = $this->record($node, $bit);
        }
        if ($node <= $this->nodeCount) return null;
        $value = $this->decode($this->dataStart + ($node - $this->nodeCount - 16), $this->dataStart)[0];
        return is_array($value) ? $value : null;
    }

    private function read(int $offset, int $len): string
    {
        fseek($this->fh, $offset);
        $s = fread($this->fh, $len);
        return $s === false ? '' : $s;
    }

    private function record(int $node, int $bit): int
    {
        $b = $this->read($node * $this->nodeBytes, $this->nodeBytes);
        $o = fn(int $i) => ord($b[$i]);
        if ($this->recordSize === 24) {
            $p = $bit * 3;
            return ($o($p) << 16) | ($o($p + 1) << 8) | $o($p + 2);
        }
        if ($this->recordSize === 28) {
            return $bit === 0
                ? ((($o(3) & 0xF0) << 20) | ($o(0) << 16) | ($o(1) << 8) | $o(2))
                : ((($o(3) & 0x0F) << 24) | ($o(4) << 16) | ($o(5) << 8) | $o(6));
        }
        return unpack('N', substr($b, $bit * 4, 4))[1];
    }

    /* Returns [value, next offset]. */
    private function decode(int $offset, int $base): array
    {
        $ctrl = ord($this->read($offset++, 1));
        $type = $ctrl >> 5;
        if ($type === 1) {
            $ss = ($ctrl >> 3) & 3;
            $v = $ctrl & 7;
            $b = $this->read($offset, $ss + 1);
            $o = fn(int $i) => ord($b[$i]);
            if ($ss === 0) { $p = ($v << 8) | $o(0); $offset += 1; }
            elseif ($ss === 1) { $p = (($v << 16) | ($o(0) << 8) | $o(1)) + 2048; $offset += 2; }
            elseif ($ss === 2) { $p = (($v << 24) | ($o(0) << 16) | ($o(1) << 8) | $o(2)) + 526336; $offset += 3; }
            else { $p = unpack('N', $b)[1]; $offset += 4; }
            return [$this->decode($base + $p, $base)[0], $offset];
        }
        if ($type === 0) $type = 7 + ord($this->read($offset++, 1));
        $size = $ctrl & 0x1F;
        if ($size === 29) { $size = 29 + ord($this->read($offset, 1)); $offset += 1; }
        elseif ($size === 30) { $size = 285 + unpack('n', $this->read($offset, 2))[1]; $offset += 2; }
        elseif ($size === 31) { $b = $this->read($offset, 3); $size = 65821 + ((ord($b[0]) << 16) | (ord($b[1]) << 8) | ord($b[2])); $offset += 3; }

        switch ($type) {
            case 2: return [$size ? $this->read($offset, $size) : '', $offset + $size];
            case 3: return [unpack('E', $this->read($offset, 8))[1], $offset + 8];
            case 4: return [$this->read($offset, $size), $offset + $size];
            case 5: case 6: case 9: case 10:
                $v = 0;
                $b = $size ? $this->read($offset, $size) : '';
                for ($i = 0; $i < $size; $i++) $v = $v * 256 + ord($b[$i]);
                return [$v, $offset + $size];
            case 7:
                $obj = [];
                for ($i = 0; $i < $size; $i++) {
                    [$k, $offset] = $this->decode($offset, $base);
                    [$v, $offset] = $this->decode($offset, $base);
                    $obj[$k] = $v;
                }
                return [$obj, $offset];
            case 8:
                $v = 0;
                $b = $size ? $this->read($offset, $size) : '';
                for ($i = 0; $i < $size; $i++) $v = ($v << 8) | ord($b[$i]);
                if ($size === 4 && $v >= 0x80000000) $v -= 0x100000000;
                return [$v, $offset + $size];
            case 11:
                $arr = [];
                for ($i = 0; $i < $size; $i++) { [$v, $offset] = $this->decode($offset, $base); $arr[] = $v; }
                return [$arr, $offset];
            case 14: return [$size !== 0, $offset];
            case 15: return [unpack('G', $this->read($offset, 4))[1], $offset + 4];
            default: throw new RuntimeException('Unsupported MMDB type ' . $type);
        }
    }
}
