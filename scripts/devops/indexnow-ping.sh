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
#
# SECURITY (security-review round 1, PR #423, LOW): the JSON body is built
# with `jq -n` (not string concatenation) — today's only two call sites
# (deploy.yml's fixed URL list) never carry attacker-controlled text, but
# the runbook explicitly advertises this script for REUSE from a future
# vacancy publish/close hook, where a URL would embed a DB-derived slug —
# `jq` makes the eventual reuse safe by construction instead of relying on
# whoever writes that hook to remember to escape it. `mktemp` (not a fixed
# /tmp path) avoids a symlink/predictable-path race if this script is ever
# invoked concurrently. `set -euo pipefail` replaces the looser `set -u`.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (JSON body construction) but was not found on PATH." >&2
  echo "GitHub Actions ubuntu-latest runners ship jq by default; for local/manual runs, install it (e.g. \`brew install jq\`)." >&2
  exit 2
fi

KEY="${1:-}"
HOST="${2:-}"
shift 2 2>/dev/null || true
URLS=("$@")

if [ -z "$KEY" ] || [ -z "$HOST" ] || [ "${#URLS[@]}" -eq 0 ]; then
  echo "Usage: $0 <key> <host> <url1> [url2] ..." >&2
  echo "Example: $0 abc123 cheekycheese.tech https://cheekycheese.tech/ https://cheekycheese.tech/careers/" >&2
  exit 2
fi

body="$(
  jq -nc \
    --arg host "$HOST" \
    --arg key "$KEY" \
    --arg keyLocation "https://${HOST}/${KEY}.txt" \
    --args '{host: $host, key: $key, keyLocation: $keyLocation, urlList: $ARGS.positional}' \
    "${URLS[@]}"
)"

echo "==> IndexNow ping — host=${HOST} urls=${#URLS[@]}"

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

http_status="$(
  curl -s -o "$response_file" -w '%{http_code}' --max-time 15 \
    -X POST 'https://api.indexnow.org/indexnow' \
    -H 'Content-Type: application/json; charset=utf-8' \
    -d "$body"
)" || {
  echo "ERROR: IndexNow request failed at the transport level (network/DNS/timeout)." >&2
  exit 1
}

echo "==> IndexNow response: HTTP ${http_status}"
if [ -s "$response_file" ]; then
  echo "==> IndexNow response body:"
  cat "$response_file"
fi

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
