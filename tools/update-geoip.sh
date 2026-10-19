#!/usr/bin/env bash
# Downloads the free DB-IP "IP to Country Lite" database (CC BY 4.0) into the
# AiVoid data folder. The API reads the new file on the next request.
#
#   update-geoip.sh /path/to/aivoid-private
set -euo pipefail

DIR="${1:-${AIVOID_DATA:-}}"
if [ -z "$DIR" ]; then
  echo "Usage: $0 <data folder>" >&2
  exit 2
fi

OUT="$DIR/dbip-country-lite.mmdb"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

this_month="$(date -u +%Y-%m)"
last_month="$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m)"

# Early in the month the new file may not be published yet.
for month in "$this_month" "$last_month"; do
  url="https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz"
  if curl -fsSL --retry 3 -o "$TMP" "$url"; then
    gunzip -c "$TMP" > "$OUT.new"
    mv "$OUT.new" "$OUT"
    echo "Installed $url"
    exit 0
  fi
done

echo "Could not download the DB-IP country database" >&2
exit 1
