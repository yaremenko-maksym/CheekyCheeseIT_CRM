#!/usr/bin/env bash
# test-cloudflare-ips-watch.sh — proves the three scenarios
# task-cloudflare-ips-watch (AC8) requires, by actually RUNNING
# scripts/devops/cloudflare-ips-watch.sh, not by reading it:
#
#   1. current state (repo matches Cloudflare)      -> silence, no PR, no issue
#   2. faked drift (one range added, one removed)    -> correct added/removed
#      split in the issue (urgent framing) AND a correct diff in the PR
#   3. Cloudflare unreachable                        -> LOUD failure, never
#      mistaken for "no drift"
#
# Plus two more the script's own contract implies and AC3 names explicitly:
#   4. removed-only drift is framed as cleanup, not urgent
#   5. an already-open PR/issue is UPDATED, never duplicated
#
# `curl` is stubbed via a PATH shim (same fixture technique as
# test-check-cloudflare-ips-freshness.sh — this script calls that guard as a
# real subprocess, so the exact same shim drives both). `gh`/`git` are never
# actually invoked: every case runs with DRY_RUN=1, which — per the script's
# own header — computes and prints everything without touching the network
# (beyond the freshness sub-check's own fetch) or the working tree. That is
# what makes "the issue splits added/removed correctly" and "the PR carries
# the right diff" testable without a real GitHub repo or git remote.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

WATCH="$GUARD_DIR/cloudflare-ips-watch.sh"
FRESHNESS="$GUARD_DIR/check-cloudflare-ips-freshness.sh"
FAKE_FRESHNESS="$SELF_DIR/lib/fake-freshness-check.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# ── fixture live range lists (same shape as the freshness-check fixtures) ──────
cat >"$WS/live-v4.txt" <<'EOF'
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17
EOF

cat >"$WS/live-v6.txt" <<'EOF'
2400:cb00::/32
2606:4700::/32
EOF

# repo file matching live EXACTLY (plus the standard header + a LOCAL_TRUSTED
# line, proving that one is not treated as drift here either — end to end,
# not just inside the sub-check).
cat >"$WS/repo-fresh.txt" <<'EOF'
# Cloudflare edge ranges — canonical source for set_real_ip_from AND the
# origin gate allow-list. Regenerate from cloudflare.com/ips-v4 + /ips-v6.
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17
127.0.0.1
2400:cb00::/32
2606:4700::/32
EOF

# repo file MISSING 198.41.128.0/17 (Cloudflare added it — urgent) AND
# carrying 1.2.3.0/24 (Cloudflare no longer publishes it — cleanup). Both
# directions in one fixture, so the test proves the split, not just that
# SOMETHING was detected.
cat >"$WS/repo-both-directions.txt" <<'EOF'
# Cloudflare edge ranges — canonical source for set_real_ip_from AND the
# origin gate allow-list. Regenerate from cloudflare.com/ips-v4 + /ips-v6.
173.245.48.0/20
103.21.244.0/22
1.2.3.0/24
2400:cb00::/32
2606:4700::/32
EOF

# repo file with ONLY a stale/extra range — nothing added. Proves the
# cleanup framing is used (not urgent) when there is nothing urgent. This is
# also the fixture shape that reproduced the MED count bug (security review
# PR #557): ADDED_FILE ends up EMPTY here, which is exactly the input the
# old `grep -c . || echo 0` idiom mishandled.
cat >"$WS/repo-removed-only.txt" <<'EOF'
# Cloudflare edge ranges — canonical source for set_real_ip_from AND the
# origin gate allow-list. Regenerate from cloudflare.com/ips-v4 + /ips-v6.
173.245.48.0/20
103.21.244.0/22
198.41.128.0/17
9.9.9.0/24
2400:cb00::/32
2606:4700::/32
EOF

# The mirror-image single-direction case — REMOVED_FILE ends up empty here.
cat >"$WS/repo-added-only.txt" <<'EOF'
# Cloudflare edge ranges — canonical source for set_real_ip_from AND the
# origin gate allow-list. Regenerate from cloudflare.com/ips-v4 + /ips-v6.
173.245.48.0/20
103.21.244.0/22
2400:cb00::/32
2606:4700::/32
EOF

: >"$WS/empty.txt"

# ── curl shim (verbatim technique from test-check-cloudflare-ips-freshness.sh) ─
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

# $1 = repo file, remaining = extra env assignments (NAME=value)
#
# Goes through `env` explicitly (same technique as
# test-check-required-checks-complete.sh's run_guard) rather than bare
# `NAME=value ... command` prefix syntax: bash only recognizes a WORD as a
# prefix assignment by its LITERAL SOURCE TEXT at parse time — a
# `${extra_env[@]}` expansion is a single parameter-expansion token, so even
# though it expands to text that LOOKS like `NAME=value`, bash never
# classifies it as an assignment and instead treats the first expanded word
# as the command name ("DRY_RUN_OPEN_PR=42: command not found" — caught by
# actually running this test, not by reading it). `env` parses its own argv
# at RUNTIME instead, so this distinction does not apply to it.
run_watch() {
  local repo_file="$1"
  shift
  local extra_env=("$@")
  env \
    PATH="$WS/bin:$PATH" \
    REPO="acme/crm" OWNER_LOGIN="test-owner" \
    CF_IPS_FILE="$repo_file" FRESHNESS_CHECK="$FRESHNESS" \
    DRY_RUN=1 \
    SHIM_V4="$WS/live-v4.txt" SHIM_V6="$WS/live-v6.txt" SHIM_CURL_FAIL=0 \
    PR_BRANCH="infra/cloudflare-ips-auto-update" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$WATCH"
}

# Same idea, but FRESHNESS_CHECK points at lib/fake-freshness-check.sh
# instead of the real curl-backed sub-check — see that fake's own header for
# why: the real sub-check's count-floor guard (HIGH fix) makes a PURE
# single-direction removal structurally unable to reach FRESH_RC=1 anymore,
# which is correct FOR THE GUARD but means the watcher's own "cleanup"
# classification code can only be exercised end-to-end via a controlled
# stand-in. $1 = repo file, $2 = FAKE_ADDED, $3 = FAKE_REMOVED, remaining =
# extra env.
run_watch_fake() {
  local repo_file="$1" fake_added="$2" fake_removed="$3"
  shift 3
  local extra_env=("$@")
  env \
    REPO="acme/crm" OWNER_LOGIN="test-owner" \
    CF_IPS_FILE="$repo_file" FRESHNESS_CHECK="$FAKE_FRESHNESS" \
    DRY_RUN=1 FAKE_ADDED="$fake_added" FAKE_REMOVED="$fake_removed" FAKE_RC=1 \
    PR_BRANCH="infra/cloudflare-ips-auto-update" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$WATCH"
}

echo "== test-cloudflare-ips-watch.sh =="
echo

# ── SCENARIO 1 (AC8): current state -> tishina, no PR, no issue ────────────────
assert_green "current state (repo matches Cloudflare) -> quiet, nothing opened" \
  --contains "no drift" \
  --not-contains "gh issue create" \
  --not-contains "gh pr create" \
  --not-contains "gh issue edit" \
  --not-contains "gh pr edit" \
  -- run_watch "$WS/repo-fresh.txt"

# ── SCENARIO 2 (AC8): faked drift -> correct added/removed split + PR diff ─────
assert_green "faked drift: added=1 removed=1 -> urgent framing, both lists correct" \
  --contains "severity=urgent" \
  --contains "СРОЧНО" \
  --contains "gh pr create" \
  --contains "gh issue create" \
  -- run_watch "$WS/repo-both-directions.txt"

# Re-run captured separately so the assertions on WHICH cidr landed in WHICH
# list can check exact placement, not just "the text 198... appears somewhere".
OUT_BOTH="$(run_watch "$WS/repo-both-directions.txt" 2>&1)"
if printf '%s' "$OUT_BOTH" | grep -q '198\.41\.128\.0/17' \
  && printf '%s' "$OUT_BOTH" | grep -q '1\.2\.3\.0/24' \
  && printf '%s' "$OUT_BOTH" | grep -q '+198.41.128.0/17' \
  && printf '%s' "$OUT_BOTH" | grep -q -- '-1.2.3.0/24'; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] 198.41.128.0/17 lands as ADDED, 1.2.3.0/24 lands as REMOVED (PR diff has the right +/-)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] added/removed CIDRs were not found in the right places\n'
  printf '%s\n' "$OUT_BOTH" | sed 's/^/      | /'
fi

# ── SCENARIO 2b (AC2): removed-only drift -> cleanup, NOT urgent ───────────────
# Via run_watch_fake (see its header + fake-freshness-check.sh's own header
# for why): a pure removal cannot reach FRESH_RC=1 through the REAL
# sub-check anymore (correct — that is the HIGH fix), so the watcher's own
# cleanup-framing logic is exercised here in isolation instead.
assert_green "removed-only drift -> cleanup framing, not urgent" \
  --contains "severity=cleanup" \
  --not-contains "СРОЧНО" \
  -- run_watch_fake "$WS/repo-removed-only.txt" "" "9.9.9.0/24"

# ── security review PR #557 (MED) regression — the count bug ───────────────────
# `--contains "severity=cleanup"` above ALSO passed with the old buggy
# `grep -c . || echo 0` idiom (a broken "0\n0" value happens to fail the
# `-gt 0` test the same way a clean "0" does — same outcome, silently, for
# the wrong reason) — this is exactly the "test that cannot fail" class the
# review flagged: it never looked at the COUNT text itself. These do, on
# BOTH single-direction shapes (added-only leaves REMOVED_FILE empty;
# removed-only leaves ADDED_FILE empty — the bug only ever struck an empty
# file, so both directions have to be exercised, not just one).
assert_green "removed-only: added=0 is a clean single line, not '0\\n0' (MED regression)" \
  --contains "drift found — added=0 removed=1 severity=cleanup" \
  --contains "sync Cloudflare IP ranges (auto, added=0 removed=1)" \
  -- run_watch_fake "$WS/repo-removed-only.txt" "" "9.9.9.0/24"

assert_green "added-only: removed=0 is a clean single line, not '0\\n0' (MED regression)" \
  --contains "drift found — added=1 removed=0 severity=urgent" \
  --contains "sync Cloudflare IP ranges (auto, added=1 removed=0)" \
  -- run_watch "$WS/repo-added-only.txt"

# ── SCENARIO 5 (AC3): an already-open PR/issue is UPDATED, not duplicated ──────
assert_green "existing open PR/issue -> edit, never a second create" \
  --contains "gh pr edit 42" \
  --contains "gh issue edit 99" \
  --not-contains "gh pr create" \
  --not-contains "gh issue create" \
  -- run_watch "$WS/repo-both-directions.txt" DRY_RUN_OPEN_PR=42 DRY_RUN_OPEN_ISSUE=99

# ── SCENARIO 3 (AC8/AC7): source unreachable -> LOUD failure, never "no drift" ─
# --not-contains checks the SUCCESS sentence specifically, not the bare
# substring "no drift" — the failure message itself legitimately says
# '..., NOT "no drift"' as a negation, which would otherwise self-defeat
# a naive substring check.
assert_red "Cloudflare unreachable -> loud failure, not silently treated as clean" \
  --contains "failing loud so the scheduled run goes red" \
  --not-contains "no drift — nginx/cloudflare-ips.txt matches" \
  --not-contains "gh issue create" \
  --not-contains "gh pr create" \
  -- run_watch "$WS/repo-fresh.txt" SHIM_CURL_FAIL=1

# ── security review PR #557 (MED follow-up, 2026-08-18) ────────────────────────
# The exit-2 message must tell an operator, ON THE DAY IT MATTERS, that the
# SAME red also fires on a genuine Cloudflare range retirement — not only on
# an actually broken fetch — and how to tell the two apart. Without this, the
# obvious (and wrong) reading of "check-cloudflare-ips-freshness.sh could NOT
# verify freshness" on the day Cloudflare genuinely retires a range is
# "the automation broke", sending an owner to debug the workflow instead of
# updating nginx/cloudflare-ips.txt by hand.
assert_red "exit-2 message explains the genuine-retirement case and how to tell it apart" \
  --contains "NOT necessarily a broken sentinel" \
  --contains "Cloudflare genuinely retires a range" \
  --contains "compare nginx/cloudflare-ips.txt BY EYE against https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6" \
  --contains "update nginx/cloudflare-ips.txt by hand" \
  -- run_watch "$WS/repo-fresh.txt" SHIM_CURL_FAIL=1

# ── extra: missing required env is refused, not silently defaulted ────────────
assert_red "missing REPO/OWNER_LOGIN is refused outright" \
  --contains "required env" \
  -- env PATH="$WS/bin:$PATH" CF_IPS_FILE="$WS/repo-fresh.txt" FRESHNESS_CHECK="$FRESHNESS" \
       DRY_RUN=1 SHIM_V4="$WS/live-v4.txt" SHIM_V6="$WS/live-v6.txt" \
       bash "$WATCH"

guard_test_summary "test-cloudflare-ips-watch.sh"
