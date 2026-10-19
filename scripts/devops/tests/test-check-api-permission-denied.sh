#!/usr/bin/env bash
# test-check-api-permission-denied.sh — proves scripts/devops/check-api-permission-denied.sh
# FIRES on a synthetic 42501, STAYS QUIET on a clean log, and goes RED (exit 2)
# when it cannot see. The third is the one this repo has been bitten by: a guard
# whose failure makes the system quieter.
#
# Also pins the pattern copy in deploy-stack-on-vps.sh (it runs on the VPS
# without this repo) to the single definition in the checker.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-api-permission-denied.sh"
DEPLOY_SCRIPT="$GUARD_DIR/deploy-stack-on-vps.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# ── fixtures: the envelope the workflow's remote script prints ───────────────

# A cron retention handler swallowing a 42501 (Nest ERROR line, `docker logs -t`).
cat >"$WS/hit.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_LINES=412
LOGSCAN_MATCHES_BEGIN
2026-10-19T03:00:02.123456789Z [Nest] 18  - 10/19/2026, 3:00:02 AM   ERROR [TelemetryRetentionService] retention failed error: permission denied for table telemetry_events
LOGSCAN_MATCHES_END
EOF

# Two hits, one of them the code-only shape (no "permission denied" text), and
# one "must be owner" (42501 whose message lacks the phrase).
cat >"$WS/hit-variants.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_LINES=900
LOGSCAN_MATCHES_BEGIN
2026-10-19T04:00:00.000000001Z {"level":50,"err":{"code":"42501","message":"x"}}
2026-10-19T04:00:01.000000001Z [Nest] 18  - 10/19/2026, 4:00:01 AM   ERROR [AuditService] error: must be owner of table document_access_log
2026-10-19T04:00:02.000000001Z [Nest] 18  - 10/19/2026, 4:00:02 AM   ERROR [VacancyRetention] error: PERMISSION DENIED for table public.vacancy_applications
LOGSCAN_MATCHES_END
EOF

cat >"$WS/clean.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_LINES=412
LOGSCAN_MATCHES_BEGIN
LOGSCAN_MATCHES_END
EOF

# Clean but the window held no lines at all: still clean (a warning, not red).
cat >"$WS/clean-silent.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_LINES=0
LOGSCAN_MATCHES_BEGIN
LOGSCAN_MATCHES_END
EOF

# A crafted line: valid "permission denied" plus a workflow-command injection
# and a would-be secret. None of it may be echoed.
cat >"$WS/hostile.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_LINES=5
LOGSCAN_MATCHES_BEGIN
2026-10-19T05:00:00.000000001Z GET /x?q=permission%20denied ::error::INJECTED token=SECRETVALUE123 permission denied for table ../../etc;rm
LOGSCAN_MATCHES_END
EOF

# ── blind shapes ─────────────────────────────────────────────────────────────
: >"$WS/empty.env"
printf 'LOGSCAN_FAILED=compose_logs\n' >"$WS/remote-failed.env"
cat >"$WS/no-container.env" <<'EOF'
LOGSCAN_API_CONTAINERS=0
LOGSCAN_LINES=0
LOGSCAN_MATCHES_BEGIN
LOGSCAN_MATCHES_END
EOF
# Output cut off before the END marker: the hit could be in the part that was lost.
cat >"$WS/truncated.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_LINES=412
LOGSCAN_MATCHES_BEGIN
2026-10-19T03:00:02.123456789Z ERROR [X] permission denied for table t
EOF
printf '%s\n' '<html>ssh banner garbage</html>' >"$WS/garbage.env"
# The remote claims matches that the local pattern rejects.
cat >"$WS/disagree.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_LINES=3
LOGSCAN_MATCHES_BEGIN
2026-10-19T03:00:02.123456789Z a perfectly ordinary line
LOGSCAN_MATCHES_END
EOF

run_guard() {
  env -u GITHUB_STEP_SUMMARY bash "$GUARD" <"$1"
}

assert_exit_code() {
  local desc="$1" expected="$2" rc
  shift 2
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

# ── fires ────────────────────────────────────────────────────────────────────
assert_red "synthetic 42501 from a swallowing cron handler FIRES, with time, logger and object" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=TelemetryRetentionService object=table telemetry_events" \
  --contains "API hit permission denied (42501)" -- \
  run_guard "$WS/hit.env"

assert_red "code-only, must-be-owner and upper-case variants all fire" \
  --contains "HIT time=2026-10-19T04:00:00.000000001Z" \
  --contains "owner-only: table document_access_log" \
  --contains "object=table public.vacancy_applications" \
  --contains "3 matching" -- \
  run_guard "$WS/hit-variants.env"

assert_red "a crafted line fires but nothing raw from it is echoed (public Actions log)" \
  --not-contains "INJECTED" --not-contains "SECRETVALUE123" --not-contains ";rm" -- \
  run_guard "$WS/hostile.env"

assert_exit_code "a hit exits 1 (act on it)" 1 run_guard "$WS/hit.env"

# ── quiet ────────────────────────────────────────────────────────────────────
assert_green "clean log stays quiet: exit 0, says what it read, no HIT, no error" \
  --contains "OK: read 412 API log line(s)" --not-contains "HIT" --not-contains "::error" -- \
  run_guard "$WS/clean.env"

assert_green "clean but zero lines in the window is clean with a warning, not red" \
  --contains "::warning::" -- \
  run_guard "$WS/clean-silent.env"

assert_exit_code "clean exits 0" 0 run_guard "$WS/clean.env"

# ── blind: every one of these must be RED and exit 2, never 0 ────────────────
assert_red "empty envelope is BLIND, not clean" --contains "BLIND" -- run_guard "$WS/empty.env"
assert_red "remote could not read logs is BLIND" --contains "compose_logs" -- run_guard "$WS/remote-failed.env"
assert_red "no running api container is BLIND" --contains "no running api container" -- run_guard "$WS/no-container.env"
assert_red "truncated envelope (no END marker) is BLIND" --contains "LOGSCAN_MATCHES_END" -- run_guard "$WS/truncated.env"
assert_red "garbage on stdin is BLIND" --contains "BLIND" -- run_guard "$WS/garbage.env"
assert_red "remote/local filter disagreement is BLIND" --contains "disagree" -- run_guard "$WS/disagree.env"

assert_exit_code "empty envelope exits 2, not 0" 2 run_guard "$WS/empty.env"
assert_exit_code "truncated envelope exits 2, not 0" 2 run_guard "$WS/truncated.env"
assert_exit_code "no container exits 2, not 0" 2 run_guard "$WS/no-container.env"
assert_exit_code "blind (2) is distinguishable from a hit (1)" 2 run_guard "$WS/remote-failed.env"

# ── pattern behaviour, straight from the single definition ───────────────────
RE="$(bash "$GUARD" --print-pattern)"
pat_hits() { printf '%s\n' "$1" | grep -aEi -e "$RE" >/dev/null; }
assert_green "pattern: 'permission denied for table x'" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'ERROR permission denied for table x'"
assert_green "pattern: 'SQLSTATE 42501'" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'SQLSTATE 42501'"
assert_red "pattern: a bare number 42501 elsewhere (an id, a port) does NOT fire" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'processed 42501 rows'"
assert_red "pattern: an ordinary error line does NOT fire" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'ERROR connection terminated'"

# ── the copy on the VPS must equal the definition ────────────────────────────
deploy_re="$(sed -n "s/^PERMISSION_DENIED_RE='\(.*\)'\$/\1/p" "$DEPLOY_SCRIPT" | head -n 1)"
if [ "$deploy_re" = "$RE" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  deploy-stack-on-vps.sh carries the same pattern as the checker\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  pattern drift: deploy script has [%s], checker has [%s]\n' "$deploy_re" "$RE"
fi

guard_test_summary
