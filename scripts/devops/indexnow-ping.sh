#!/bin/bash
# indexnow-ping.sh — notify search engines of updated URLs via IndexNow
# (task-infra-locale-edge, AC B6).
#
# IndexNow is a SHARED protocol (https://www.indexnow.org/) — one POST to
# api.indexnow.org relays the notification to every participating engine,
# which today includes both Bing AND Yandex (the two named in AC B6) plus
# Seznam/Naver. This is deliberately the ONE endpoint pinged, not two
# separate Bing/Yandex calls — same coverage, half the requests.
#
# Usage:
#   scripts/devops/indexnow-ping.sh <key> <host> <url1> [url2] [url3] ...
#
#   key   — the IndexNow key (same value baked into the nginx image as the
#           INDEXNOW_KEY build-arg — see nginx/Dockerfile and
#           scripts/devops/locale-routing-runbook.md). The key file must
#           already be live at https://<host>/<key>.txt — IndexNow verifies
#           it before accepting the submission.
#   host  — bare host, e.g. cheekycheese.tech (no scheme).
#   urlN  — one or more FULL page URLs to (re)submit (NOT a sitemap URL —
#           IndexNow's urlList expects individual pages, see indexnow.org).
#
# Exit code is non-zero only on a transport-level failure (curl itself
# failing to reach the endpoint) — a non-2xx HTTP response from IndexNow is
# logged loudly but does NOT fail the caller by default (matches the
# project's established fail-soft convention for third-party
# indexing/notification integrations, same as the Google Indexing API
# service — see docs/runbooks/deployment.md "Google Indexing API": indexing
# pings must never block a deploy or a vacancy publish/close action). Set
# INDEXNOW_STRICT=1 to make a non-2xx response a hard failure instead.
#
# "ответ 200/202 залогирован" (AC B6) — the HTTP status IS always printed to
# stdout, which callers running this from GitHub Actions get for free in
# the run log; no separate log file needed for that requirement.
set -u

KEY="${1:-}"
HOST="${2:-}"
shift 2 2>/dev/null || true
URLS=("$@")

if [ -z "$KEY" ] || [ -z "$HOST" ] || [ "${#URLS[@]}" -eq 0 ]; then
  echo "Usage: $0 <key> <host> <url1> [url2] ..." >&2
  echo "Example: $0 abc123 cheekycheese.tech https://cheekycheese.tech/ https://cheekycheese.tech/careers/" >&2
  exit 2
fi

# Build the JSON body without a full JSON library dependency — the only
# dynamic values are the key, host, and a list of plain https URLs (no
# owner/user-controlled free text ever flows into this script, see the
# call sites in .github/workflows/deploy.yml), so straightforward manual
# escaping of the fixed URL shape is safe here.
url_list_json=""
for url in "${URLS[@]}"; do
  if [ -n "$url_list_json" ]; then
    url_list_json="${url_list_json},"
  fi
  url_list_json="${url_list_json}\"${url}\""
done

body=$(
  cat <<EOF
{"host":"${HOST}","key":"${KEY}","keyLocation":"https://${HOST}/${KEY}.txt","urlList":[${url_list_json}]}
EOF
)

echo "==> IndexNow ping — host=${HOST} urls=${#URLS[@]}"

http_status=$(
  curl -s -o /tmp/indexnow-response.txt -w '%{http_code}' --max-time 15 \
    -X POST 'https://api.indexnow.org/indexnow' \
    -H 'Content-Type: application/json; charset=utf-8' \
    -d "$body"
) || {
  echo "ERROR: IndexNow request failed at the transport level (network/DNS/timeout)." >&2
  exit 1
}

echo "==> IndexNow response: HTTP ${http_status}"
if [ -s /tmp/indexnow-response.txt ]; then
  echo "==> IndexNow response body:"
  cat /tmp/indexnow-response.txt
fi
rm -f /tmp/indexnow-response.txt

case "$http_status" in
200 | 202)
  echo "==> IndexNow ping accepted (HTTP ${http_status})."
  ;;
*)
  echo "::warning::IndexNow ping returned HTTP ${http_status} (expected 200/202) — see scripts/devops/locale-routing-runbook.md 'IndexNow'. Non-blocking by default (fail-soft, same convention as the Google Indexing API)."
  if [ "${INDEXNOW_STRICT:-0}" = "1" ]; then
    exit 1
  fi
  ;;
esac
