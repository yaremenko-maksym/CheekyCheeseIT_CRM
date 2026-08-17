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

# The REAL cloudflare.com/ips-v4 response has NO trailing newline after its
# last CIDR (confirmed by fetching it while building the count-floor guard
# below, not by assumption) — `printf` here deliberately omits the final
# `\n` a heredoc would always add, so this fixture matches production byte-
# for-byte instead of matching every OTHER fixture in this file. Same three
# ranges as live-v4.txt, just without the trailing newline.
printf '173.245.48.0/20\n103.21.244.0/22\n198.41.128.0/17' >"$WS/live-v4-no-trailing-newline.txt"

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

# Carries a range Cloudflare no longer publishes, with NOTHING added in the
# same family — this is the PURE single-direction count-drop shape. Since
# security review PR #557 (HIGH), this is treated as SUSPECTED TRUNCATION
# (exit 2), not "safe to remove" — see the guard's own header for why a
# genuine single-range retirement and a single-line truncated fetch are
# mathematically indistinguishable from CIDR content alone.
cat >"$WS/repo-extra-range.txt" <<'EOF'
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17
1.2.3.0/24

2400:cb00::/32
2606:4700::/32
EOF

# Same shape, but the v4 family's TOTAL COUNT does not regress: Cloudflare
# added 198.41.128.0/17 AND the repo separately carries a stale 1.2.3.0/24
# that Cloudflare no longer publishes. live v4 count (3) == repo v4 count
# (3), so the count-floor guard does not fire, and check_set's normal
# added/removed split is exercised on purpose — proves genuine simultaneous
# add+remove is still detected when the family does not shrink, i.e. the
# count-floor guard blocks PURE regressions, not every mismatch.
cat >"$WS/repo-offsetting.txt" <<'EOF'
173.245.48.0/20
103.21.244.0/22
1.2.3.0/24

2400:cb00::/32
2606:4700::/32
EOF

# Case A (security review PR #557, HIGH): the v4 endpoint answers 200 with
# an HTML error/redirect page instead of the text list. Every "line" fails
# the CIDR-shape check.
cat >"$WS/live-v4-html.txt" <<'EOF'
<html>
<head><title>502 Bad Gateway</title></head>
<body><center>502 Bad Gateway</center></body>
</html>
EOF

# Case B (security review PR #557, HIGH — the reviewer's own literal
# scenario): a THIRD, genuinely-published v6 range, and a version of the
# live fetch missing exactly that one line — every remaining line is a
# perfectly well-formed CIDR, so format validation alone cannot catch this;
# only the count-floor guard can.
cat >"$WS/live-v6-full.txt" <<'EOF'
2400:cb00::/32
2606:4700::/32
2803:f800::/32
EOF

cat >"$WS/live-v6-truncated.txt" <<'EOF'
2400:cb00::/32
2606:4700::/32
EOF

# repo already trusts all 3 v6 ranges (fresh relative to live-v6-full) — the
# anchor the count-floor guard compares live-v6-truncated's 2 against.
cat >"$WS/repo-three-v6.txt" <<'EOF'
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17

2400:cb00::/32
2606:4700::/32
2803:f800::/32
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

assert_red "PURE count drop (nothing added in the family) -> suspected truncation, NOT 'safe to remove'" \
  --contains "truncated/incomplete fetch" \
  --not-contains "is FRESH" \
  --not-contains "STALE" \
  -- run_guard "$WS/repo-extra-range.txt"

assert_red "genuine add+remove that does NOT shrink the family -> still detected normally" \
  --contains "198.41.128.0/17" \
  --contains "1.2.3.0/24" \
  --contains "STALE" \
  -- run_guard "$WS/repo-offsetting.txt"

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

# ── security review PR #557 (HIGH) — Case A: HTML body instead of a list ──────
assert_red "Case A: v4 endpoint answers 200 with an HTML page -> refused, not read as 'everything removed'" \
  --contains "did not return a clean list" \
  --contains "HTML error page" \
  --not-contains "is FRESH" \
  --not-contains "STALE" \
  -- run_guard "$WS/repo-fresh.txt" "$WS/live-v4-html.txt" "$WS/live-v6.txt"

# ── security review PR #557 (HIGH) — Case B: exact reviewer scenario ──────────
# Response truncated by exactly ONE line — every remaining line is a
# well-formed CIDR (format check alone would pass this), and the one
# genuinely-still-active range would otherwise read as "safe to remove".
assert_red "Case B: response truncated by one line -> refused as suspected truncation, not offered as a removal" \
  --contains "fewer than the 3 this repo currently trusts" \
  --contains "truncated/incomplete fetch" \
  --not-contains "2803:f800::/32" \
  --not-contains "safe to remove" \
  -- run_guard "$WS/repo-three-v6.txt" "$WS/live-v4.txt" "$WS/live-v6-truncated.txt"

# ── regression: a response with NO trailing newline must not false-positive
# as "truncated" against the count-floor guard above. Caught by actually
# running the freshly-written guard against the REAL cloudflare.com/ips-v4
# while verifying the Case A/B fixes, not by reading the code: `wc -l`
# counts newline CHARACTERS and undercounts a response with no final `\n`
# by exactly one — which would have made the guard meant to stop a
# self-inflicted outage CAUSE one, permanently, on perfectly fresh data.
assert_green "live response with no trailing newline is counted correctly, not read as truncated" \
  --contains "is FRESH" \
  --not-contains "truncated/incomplete fetch" \
  -- run_guard "$WS/repo-fresh.txt" "$WS/live-v4-no-trailing-newline.txt" "$WS/live-v6.txt"

# ── LOCAL_TRUSTED filtering (task-cloudflare-ips-watch, 2026-08-18) ────────────
assert_green "LOCAL_TRUSTED lines (127.0.0.1 / ::1) in the repo file are not drift" \
  --contains "is FRESH" \
  -- run_guard "$WS/repo-fresh-with-local.txt"

# ── machine-readable ADDED_OUT/REMOVED_OUT (the watcher's actual contract) ────
# Uses repo-offsetting.txt (NOT repo-extra-range.txt) — the family count does
# not regress here, so this exercises the normal added/removed split rather
# than the count-floor guard (that guard has its own tests above).
ADDED_OUT_FILE="$WS/added.out"
REMOVED_OUT_FILE="$WS/removed.out"
assert_red "ADDED_OUT/REMOVED_OUT split the two directions correctly" \
  --contains "STALE" \
  -- env ADDED_OUT="$ADDED_OUT_FILE" REMOVED_OUT="$REMOVED_OUT_FILE" \
       PATH="$WS/bin:$PATH" SHIM_V4="$WS/live-v4.txt" SHIM_V6="$WS/live-v6.txt" SHIM_CURL_FAIL=0 \
       bash "$GUARD" "$WS/repo-offsetting.txt"

if [ -f "$ADDED_OUT_FILE" ] && grep -qF '198.41.128.0/17' "$ADDED_OUT_FILE" \
  && [ -f "$REMOVED_OUT_FILE" ] && grep -qF '1.2.3.0/24' "$REMOVED_OUT_FILE"; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] ADDED_OUT names 198.41.128.0/17 and REMOVED_OUT names 1.2.3.0/24 exactly\n'
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
assert_exit_code "pure count drop (Case-B shape) exits 2, NEVER 1 — must not be actionable as drift" 2 \
  run_guard "$WS/repo-extra-range.txt"
assert_exit_code "HTML body (Case A) exits 2, NEVER 1" 2 \
  run_guard "$WS/repo-fresh.txt" "$WS/live-v4-html.txt" "$WS/live-v6.txt"
assert_exit_code "one-line-truncated response (Case B, reviewer's exact scenario) exits 2, NEVER 1" 2 \
  run_guard "$WS/repo-three-v6.txt" "$WS/live-v4.txt" "$WS/live-v6-truncated.txt"
assert_exit_code "offsetting add+remove (family count unchanged) still exits 1, not 2" 1 \
  run_guard "$WS/repo-offsetting.txt"

guard_test_summary "test-check-cloudflare-ips-freshness.sh"
