#!/usr/bin/env bash
# test-check-cloudflare-ips-freshness.sh — proves
# scripts/devops/check-cloudflare-ips-freshness.sh goes RED on a stale
# nginx/cloudflare-ips.txt AND when it simply could not check.
#
# `curl` is replaced by a PATH shim serving fixture range lists. That is not a
# convenience: this guard is a fail-CLOSED precondition for flipping
# ORIGIN_GATE_MODE to enforce, so the branch that matters most is "the fetch
# failed" — and there is no way to make the real cloudflare.com fail on demand.
# Testing it against the live endpoint would also make the suite a network flake
# and would silently start passing/failing whenever Cloudflare renumbers.
#
# The "live list came back empty" case is the file-exists-but-says-nothing shape:
# a 200 response with a zero-byte body would otherwise diff as "repo has extra
# ranges" or, worse, as a clean match against an empty repo file.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-cloudflare-ips-freshness.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# ── fixture range lists ────────────────────────────────────────────────────────
cat >"$WS/live-v4.txt" <<'EOF'
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17
EOF

cat >"$WS/live-v6.txt" <<'EOF'
2400:cb00::/32
2606:4700::/32
EOF

# Same list plus one newly-published range — used to prove IPv6 drift alone is
# enough to fail, independently of the IPv4 half.
cat >"$WS/live-v6-drifted.txt" <<'EOF'
2400:cb00::/32
2606:4700::/32
2a06:98c0::/29
EOF

# The repo file interleaves v4/v6 and carries comments + blank lines, exactly
# like the real nginx/cloudflare-ips.txt.
cat >"$WS/repo-fresh.txt" <<'EOF'
# Cloudflare edge ranges — canonical source for set_real_ip_from AND the
# origin gate allow-list. Regenerate from cloudflare.com/ips-v4 + /ips-v6.

173.245.48.0/20
103.21.244.0/22
198.41.128.0/17

2400:cb00::/32
2606:4700::/32
EOF

# Missing 198.41.128.0/17 — the dangerous direction: visitors arriving via a
# range we do not trust get their real IP unrecorded and are denied once the
# gate enforces.
cat >"$WS/repo-missing-range.txt" <<'EOF'
173.245.48.0/20
103.21.244.0/22

2400:cb00::/32
2606:4700::/32
EOF

# Carries a range Cloudflare no longer publishes — harmless on its own, but the
# signal that nobody has re-verified this file.
cat >"$WS/repo-extra-range.txt" <<'EOF'
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17
1.2.3.0/24

2400:cb00::/32
2606:4700::/32
EOF

# LOCAL_TRUSTED lines (127.0.0.1 / ::1 — see the guard's own LOCAL_TRUSTED
# constant) sitting alongside an otherwise-exact match. These are NOT
# Cloudflare's to publish, so their absence from the live lists must not
# read as drift (task-cloudflare-ips-watch, 2026-08-18).
cat >"$WS/repo-fresh-with-local.txt" <<'EOF'
# same three v4 + two v6 ranges as repo-fresh.txt, plus two LOCAL_TRUSTED
# lines that legitimately have no counterpart in cloudflare.com/ips-v4|v6.
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17
127.0.0.1

2400:cb00::/32
2606:4700::/32
::1
EOF

: >"$WS/empty.txt"

# ── curl shim ──────────────────────────────────────────────────────────────────
# Understands just enough of the guard's invocation: `-o <path>` plus the URL.
read -r -d '' SHIM_BODY <<'SHIM' || true
#!/bin/sh
out=""
url=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
if [ "${SHIM_CURL_FAIL:-0}" = "1" ]; then
  echo "curl: (22) The requested URL returned error: 503" >&2
  exit 22
fi
case "$url" in
  *ips-v4) src="$SHIM_V4" ;;
  *ips-v6) src="$SHIM_V6" ;;
  *) echo "shim: unexpected url: $url" >&2; exit 3 ;;
esac
cat "$src" >"$out"
SHIM
guard_test_shim "$WS" curl "$SHIM_BODY"

# $1 = repo file, then optional env overrides via the caller's environment
run_guard() {
  local repo_file="$1" v4="${2:-$WS/live-v4.txt}" v6="${3:-$WS/live-v6.txt}" fail="${4:-0}"
  PATH="$WS/bin:$PATH" SHIM_V4="$v4" SHIM_V6="$v6" SHIM_CURL_FAIL="$fail" \
    bash "$GUARD" "$repo_file"
}

echo "== test-check-cloudflare-ips-freshness.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "repo list matching Cloudflare exactly is FRESH" \
  --contains "is FRESH" \
  --contains "PASS  IPv4" \
  --contains "PASS  IPv6" \
  -- run_guard "$WS/repo-fresh.txt"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "Cloudflare added a range the repo lacks -> STALE" \
  --contains "198.41.128.0/17" \
  --contains "STALE" \
  -- run_guard "$WS/repo-missing-range.txt"

assert_red "repo carries a range Cloudflare no longer publishes -> STALE" \
  --contains "1.2.3.0/24" \
  --contains "STALE" \
  -- run_guard "$WS/repo-extra-range.txt"

assert_red "IPv6 drift alone is enough to go red (IPv4 half still matches)" \
  --contains "PASS  IPv4" \
  --contains "FAIL  IPv6" \
  --contains "2a06:98c0::/29" \
  -- run_guard "$WS/repo-fresh.txt" "$WS/live-v4.txt" "$WS/live-v6-drifted.txt"

assert_red "THE CHEAT: fetch returns an EMPTY body -> not verified, never a PASS" \
  --contains "returned an empty response" \
  --not-contains "is FRESH" \
  -- run_guard "$WS/repo-fresh.txt" "$WS/empty.txt" "$WS/live-v6.txt"

assert_red "fetch fails outright -> fail-closed, never a PASS" \
  --contains "freshness NOT verified" \
  --not-contains "is FRESH" \
  -- run_guard "$WS/repo-fresh.txt" "$WS/live-v4.txt" "$WS/live-v6.txt" 1

assert_red "missing cloudflare-ips.txt -> red" \
  --contains "not found" \
  -- run_guard "$WS/does-not-exist.txt"

# ── LOCAL_TRUSTED filtering (task-cloudflare-ips-watch, 2026-08-18) ────────────
assert_green "LOCAL_TRUSTED lines (127.0.0.1 / ::1) in the repo file are not drift" \
  --contains "is FRESH" \
  -- run_guard "$WS/repo-fresh-with-local.txt"

# ── machine-readable ADDED_OUT/REMOVED_OUT (the watcher's actual contract) ────
ADDED_OUT_FILE="$WS/added.out"
REMOVED_OUT_FILE="$WS/removed.out"
assert_red "ADDED_OUT/REMOVED_OUT split the two directions correctly" \
  --contains "STALE" \
  -- env ADDED_OUT="$ADDED_OUT_FILE" REMOVED_OUT="$REMOVED_OUT_FILE" \
       PATH="$WS/bin:$PATH" SHIM_V4="$WS/live-v4.txt" SHIM_V6="$WS/live-v6.txt" SHIM_CURL_FAIL=0 \
       bash "$GUARD" "$WS/repo-extra-range.txt"

if [ -f "$ADDED_OUT_FILE" ] && [ ! -s "$ADDED_OUT_FILE" ] \
  && [ -f "$REMOVED_OUT_FILE" ] && grep -qF '1.2.3.0/24' "$REMOVED_OUT_FILE"; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] ADDED_OUT is empty and REMOVED_OUT names 1.2.3.0/24 exactly\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] ADDED_OUT/REMOVED_OUT contents did not match expectations\n'
  printf '      ADDED_OUT:\n'
  sed 's/^/        | /' "$ADDED_OUT_FILE" 2>/dev/null
  printf '      REMOVED_OUT:\n'
  sed 's/^/        | /' "$REMOVED_OUT_FILE" 2>/dev/null
fi

# ── exit codes: "drifted" (1) vs "could not verify" (2) must differ ───────────
# The watcher (cloudflare-ips-watch.sh) branches on this — conflating them
# would make it either silently skip real drift or open a PR full of empty
# diffs when the sentinel itself is down. See the guard's own header.
assert_exit_code() {
  local desc="$1" expected="$2"
  shift 2
  local rc
  "$@" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq "$expected" ]; then
    GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
    printf 'PASS  [code=%s] %s\n' "$expected" "$desc"
  else
    GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
    printf 'FAIL  [code!=%s] %s (got %s)\n' "$expected" "$desc" "$rc"
  fi
}

assert_exit_code "fresh repo exits 0" 0 run_guard "$WS/repo-fresh.txt"
assert_exit_code "genuine drift exits 1 (act on it), not 2" 1 run_guard "$WS/repo-missing-range.txt"
assert_exit_code "fetch failure exits 2 (broken sentinel), not 1" 2 \
  run_guard "$WS/repo-fresh.txt" "$WS/live-v4.txt" "$WS/live-v6.txt" 1
assert_exit_code "missing repo file exits 2 (broken sentinel), not 1" 2 \
  run_guard "$WS/does-not-exist.txt"

guard_test_summary "test-check-cloudflare-ips-freshness.sh"
