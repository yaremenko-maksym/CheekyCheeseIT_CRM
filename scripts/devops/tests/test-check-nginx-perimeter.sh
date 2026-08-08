#!/usr/bin/env bash
# test-check-nginx-perimeter.sh — proves scripts/devops/check-nginx-perimeter.sh
# goes RED when the edge perimeter regresses.
#
# Scope note, same as test-check-security-headers.sh: this proves the GUARD's
# logic against lib/fake-origin.py, not that nginx.conf is right. The live proof
# is deploy.yml's FATAL smoke step running this same script against the VPS.
#
# Two of the negative cases are regressions this repo actually produced:
#   - `gate-blocks-visitor` is the reverted PR #437 source-IP gate, which keyed
#     on the post-realip $remote_addr and therefore 403'd every genuine
#     Cloudflare-forwarded visitor while letting through the traffic it was
#     written to stop.
#   - `no-catch-all` is the MED-5 finding: with no default_server, crm.conf
#     silently answered for ANY unmatched Host.
#
# The geo-variable cases matter for a subtler reason. That check SKIPs when
# NGINX_EXEC_CMD is unset — and a skip that is quietly counted as a pass is the
# same failure this whole task is about. So there is a case asserting the skip is
# reported as a skip, and cases asserting that when it CAN run, it fails on the
# wrong variable and on unreadable output rather than shrugging.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-nginx-perimeter.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# `nginx -T` stand-ins. The guard invokes "$NGINX_EXEC_CMD nginx -T", so these
# ignore their arguments and print a fully-resolved config fragment.
guard_test_shim "$WS/geo-good" nginx-exec '#!/bin/sh
echo "http {"
echo "    geo \$realip_remote_addr \$origin_gate_allowed {"
echo "        default 0;"
echo "    }"
echo "}"'
guard_test_shim "$WS/geo-bad" nginx-exec '#!/bin/sh
echo "http {"
echo "    geo \$remote_addr \$origin_gate_allowed {"
echo "        default 0;"
echo "    }"
echo "}"'
guard_test_shim "$WS/geo-silent" nginx-exec '#!/bin/sh
echo "http {"
echo "}"'

# $1 = flaw, $2 = optional geo shim dir name, $3 = optional --default-host value
run_case() {
  local flaw="$1" geo="${2:-}" default_host="${3:-}"
  local extra_args=""
  if [ -n "$default_host" ]; then
    start_fake_origin perimeter --flaw "$flaw" --default-host "$default_host" || return 99
  else
    start_fake_origin perimeter --flaw "$flaw" || return 99
  fi
  local rc=0
  if [ -n "$geo" ]; then
    NGINX_EXEC_CMD="$WS/$geo/bin/nginx-exec" bash "$GUARD" "$FAKE_ORIGIN_URL" || rc=$?
  else
    bash "$GUARD" "$FAKE_ORIGIN_URL" || rc=$?
  fi
  stop_fake_origin
  return $rc
}

echo "== test-check-nginx-perimeter.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "healthy perimeter (body caps + 444 catch-all + visitor allowed) passes" \
  --contains "0 failed" \
  --contains "1 skipped" \
  --contains "SKIP" \
  -- run_case none

assert_green "with docker access, the geo check runs and passes on \$realip_remote_addr" \
  --contains "0 failed, 0 skipped" \
  --contains "keyed on \$realip_remote_addr" \
  -- run_case none geo-good

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "nginx body cap missing: oversized bodies reach the app -> red" \
  --contains "expected nginx's 413 backstop" \
  -- run_case no-body-limit

assert_red "PR #437 regression: source-IP gate 403s a real Cloudflare visitor -> red" \
  --contains "got HTTP 403" \
  --contains "client-supplied CF-Connecting-IP header" \
  -- run_case gate-blocks-visitor

assert_red "MED-5 regression: no default_server, unmatched Host gets served -> red" \
  --contains "expected connection close" \
  -- run_case none "" landing

assert_red "origin gate keyed on \$remote_addr (the reverted bug) -> red" \
  --contains "NOT keyed on \$realip_remote_addr" \
  -- run_case none geo-bad

assert_red "geo block unreadable while docker access EXISTS -> red, not a silent skip" \
  --contains "could not find the \$origin_gate_allowed geo block" \
  --not-contains "SKIP" \
  -- run_case none geo-silent

guard_test_summary "test-check-nginx-perimeter.sh"
