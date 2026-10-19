#!/usr/bin/env bash
# test-check-api-permission-denied.sh — proves the standing 42501 watch
# (scripts/devops/check-api-permission-denied.sh + the remote script in
# .github/workflows/api-permission-denied-watch.yml + the inline scan in
# deploy-stack-on-vps.sh):
#   - FIRES on a synthetic 42501,
#   - STAYS QUIET on a clean log,
#   - goes RED (exit 2) when it cannot see (a guard whose failure makes the system
#     quieter is the defect class this repo keeps paying for),
#   - never lets raw production log text out: this repository's Actions logs are
#     PUBLIC. Tested at BOTH locks: the remote script must not emit it, and the
#     checker must refuse an envelope that carries it.
#
# Section 1 feeds the checker hand-written envelopes. Section 2 runs the REAL remote
# script (extracted from the workflow) and the REAL deploy block (extracted from the
# deploy script) against a fake `docker`, and pipes the first into the real checker.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-api-permission-denied.sh"
DEPLOY_SCRIPT="$GUARD_DIR/deploy-stack-on-vps.sh"
WORKFLOW="$GUARD_DIR/../../.github/workflows/api-permission-denied-watch.yml"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

RE="$(bash "$GUARD" --print-pattern)"

run_guard() { env -u GITHUB_STEP_SUMMARY bash "$GUARD" <"$1"; }

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

# ═══ 1. the checker, on hand-written (already sanitised) envelopes ═════════════

cat >"$WS/hit.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=412
LOGSCAN_HITS=1
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=TelemetryRetentionService object=table:telemetry_events sqlstate=42501-by-message
LOGSCAN_END
EOF

cat >"$WS/hit-variants.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=900
LOGSCAN_HITS=3
LOGSCAN_HIT ts=2026-10-19T04:00:00.000000001Z logger=DatabaseService object=unknown sqlstate=42501
LOGSCAN_HIT ts=2026-10-19T04:00:01.000000001Z logger=AuditService object=owner-only:table:document_access_log sqlstate=42501-by-message
LOGSCAN_HIT ts=unknown logger=unknown object=unknown sqlstate=unclassified
LOGSCAN_END
EOF

# The count alone is the alert, even if no detail line survived.
cat >"$WS/hit-count-only.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=10
LOGSCAN_HITS=4
LOGSCAN_END
EOF

cat >"$WS/clean.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=412
LOGSCAN_HITS=0
LOGSCAN_END
EOF

cat >"$WS/clean-silent.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=0
LOGSCAN_HITS=0
LOGSCAN_END
EOF

# SECOND LOCK: a remote that starts emitting raw text must turn the run red, and the
# text must not be echoed by the checker.
cat >"$WS/leak-raw-line.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=5
LOGSCAN_HITS=1
2026-10-19T05:00:00.000000001Z ERROR [X] permission denied for table t; email=jane.doe@example.com ::error::INJECTED
LOGSCAN_END
EOF
cat >"$WS/leak-in-field.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=5
LOGSCAN_HITS=1
LOGSCAN_HIT ts=2026-10-19T05:00:00.000000001Z logger=X object=table:t;jane.doe@example.com sqlstate=42501
LOGSCAN_END
EOF

: >"$WS/empty.env"
printf 'LOGSCAN_FAILED=compose_logs\n' >"$WS/remote-failed.env"
cat >"$WS/no-container.env" <<'EOF'
LOGSCAN_API_CONTAINERS=0
LOGSCAN_CONTAINER=unknown
LOGSCAN_LINES=0
LOGSCAN_HITS=0
LOGSCAN_END
EOF
# Cut off before END: the hit could be in the part that was lost.
cat >"$WS/truncated.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=412
LOGSCAN_HITS=0
EOF
printf '%s\n' '<html>ssh banner garbage</html>' >"$WS/garbage.env"
cat >"$WS/inconsistent.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=3
LOGSCAN_HITS=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=X object=table:t sqlstate=42501
LOGSCAN_END
EOF

# ── fires ────────────────────────────────────────────────────────────────────
assert_red "synthetic 42501 FIRES with time, logger, object, sqlstate and container" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=TelemetryRetentionService object=table:telemetry_events sqlstate=42501-by-message" \
  --contains "API hit permission denied (42501)" --contains "container crm-api-1" -- \
  run_guard "$WS/hit.env"

assert_red "code-only, owner-only and unclassified variants all fire" \
  --contains "logger=DatabaseService object=unknown sqlstate=42501" \
  --contains "object=owner-only:table:document_access_log" --contains "sqlstate=unclassified" \
  --contains "3 matching" -- \
  run_guard "$WS/hit-variants.env"

assert_red "a hit count with no detail lines still fires" --contains "4 matching log line" -- \
  run_guard "$WS/hit-count-only.env"

assert_exit_code "a hit exits 1 (act on it)" 1 run_guard "$WS/hit.env"

# ── quiet ────────────────────────────────────────────────────────────────────
assert_green "clean log stays quiet: exit 0, says what it read, no HIT, no error" \
  --contains "OK: read 412 API log line(s) from 1 container(s) (crm-api-1)" \
  --not-contains "HIT" --not-contains "::error" -- \
  run_guard "$WS/clean.env"
assert_green "clean but zero lines in the window is clean with a warning, not red" \
  --contains "::warning::" -- run_guard "$WS/clean-silent.env"
assert_exit_code "clean exits 0" 0 run_guard "$WS/clean.env"

# ── second lock: raw text in the envelope is refused, not echoed ─────────────
assert_red "a raw log line inside the envelope is BLIND and is NOT echoed" \
  --contains "BLIND" --not-contains "jane.doe" --not-contains "INJECTED" -- \
  run_guard "$WS/leak-raw-line.env"
assert_red "free text smuggled into a HIT field is refused and not echoed" \
  --contains "BLIND" --not-contains "jane.doe" -- run_guard "$WS/leak-in-field.env"
assert_exit_code "a leaking envelope exits 2, not 0 or 1" 2 run_guard "$WS/leak-raw-line.env"

# ── blind: every one of these must be RED and exit 2, never 0 ────────────────
assert_red "empty envelope is BLIND, not clean" --contains "BLIND" -- run_guard "$WS/empty.env"
assert_red "remote could not read logs is BLIND" --contains "compose_logs" -- run_guard "$WS/remote-failed.env"
assert_red "no running api container is BLIND" --contains "no running api container" -- run_guard "$WS/no-container.env"
assert_red "truncated envelope (no END) is BLIND" --contains "LOGSCAN_END" -- run_guard "$WS/truncated.env"
assert_red "garbage on stdin is BLIND" --contains "BLIND" -- run_guard "$WS/garbage.env"
assert_red "0 hits but listed hit lines is BLIND (inconsistent)" --contains "inconsistent" -- run_guard "$WS/inconsistent.env"
assert_exit_code "empty envelope exits 2, not 0" 2 run_guard "$WS/empty.env"
assert_exit_code "truncated envelope exits 2, not 0" 2 run_guard "$WS/truncated.env"
assert_exit_code "no container exits 2, not 0" 2 run_guard "$WS/no-container.env"
assert_exit_code "blind (2) is distinguishable from a hit (1)" 2 run_guard "$WS/remote-failed.env"

# ── the pattern itself ───────────────────────────────────────────────────────
pat_hits() { printf '%s\n' "$1" | grep -aEi -e "$RE" >/dev/null; }
assert_green "pattern: 'permission denied for table x'" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'ERROR permission denied for table x'"
assert_green "pattern: 'sqlstate=42501' (the labelled-code format the API change should log)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'cron failed sqlstate=42501'"
assert_green "pattern: \"code\":\"42501\" (JSON)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits '{\"code\":\"42501\"}'"
assert_red "pattern: a bare number 42501 elsewhere (an id, a port) does NOT fire" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'processed 42501 rows'"
assert_red "pattern: the pool-listener's other codes (57P01, 28P01) do NOT fire" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'Postgres pool idle-client error sqlstate=57P01: terminating connection'"
assert_red "pattern: the Drizzle wrapper message alone does NOT fire (why the API must log .cause)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'Failed query: DELETE FROM telemetry_events WHERE ts < \$1'"

# ═══ 2. the real remote script and deploy block, against a fake docker ═════════

guard_test_shim "$WS" docker '#!/usr/bin/env bash
case " $* " in
  *" ps "*)
    [ "${FAKE_DOCKER_MODE:-}" = "nocontainer" ] || echo "crm-api-1"
    exit 0 ;;
  *" logs "*)
    case "${FAKE_DOCKER_MODE:-}" in
      hit)   printf "%s\n" \
               "2026-10-19T03:00:01.000000001Z [Nest] 18  - 10/19/2026, 3:00:01 AM     LOG [HealthController] ok" \
               "2026-10-19T03:00:02.123456789Z [Nest] 18  - 10/19/2026, 3:00:02 AM   ERROR [VacancyRetentionService] retention failed error: permission denied for table vacancy_applications" ;;
      code)  printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [TelemetryRetentionService] retention failed sqlstate=42501: Failed query: delete from telemetry_events" ;;
      upper) printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacancyRetentionService] error: PERMISSION DENIED for table public.vacancy_applications" ;;
      owner) printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [AuditService] error: must be owner of table document_access_log" ;;
      hostile) printf "%s\n" \
               "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacancyRetentionService] DELETE FROM vacancy_applications WHERE email = \$1 params: jane.doe@example.com,+380501234567 ::error::INJECTED permission denied for table vacancy_applications" \
               "GET /x?q=permission%20denied token=SECRETVALUE123" ;;
      fail)  echo "Error response from daemon: no such service" >&2; exit 1 ;;
      *)     printf "%s\n" "2026-10-19T03:00:01.000000001Z [Nest] 18  - 10/19/2026, 3:00:01 AM     LOG [HealthController] ok" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x     LOG [Cron] retention pruned 0 rows" ;;
    esac
    exit 0 ;;
esac
exit 0'

python3 -I - "$WORKFLOW" "$WS/remote.sh" <<'PYEOF'
import re, sys, textwrap
src = open(sys.argv[1]).read()
m = re.search(r"^ {10}script: \|\n((?: {12}.*\n|\n)+)", src, re.M)
if not m:
    sys.exit("could not find the remote script in the workflow")
body = textwrap.dedent(m.group(1)).replace("cd /opt/crm", "cd .")
open(sys.argv[2], "w").write(body)
PYEOF

DEPLOY_BLOCK_OK=1
sed -n "/^PERMISSION_DENIED_RE='/,/^echo \"No permission denied/p" "$DEPLOY_SCRIPT" >"$WS/deploy-block.body"
[ -s "$WS/deploy-block.body" ] || DEPLOY_BLOCK_OK=0
{
  echo 'set -euo pipefail'
  echo 'DEPLOY_STARTED_AT=2026-10-19T03:00:00Z'
  cat "$WS/deploy-block.body"
  echo 'echo DEPLOY-CONTINUED'
} >"$WS/deploy-block.sh"

remote() { ( cd "$WS" && PATH="$WS/bin:$PATH" FAKE_DOCKER_MODE="$1" LOGSCAN_RE="$RE" LOGSCAN_SINCE=40m bash "$WS/remote.sh" ); }
pipeline() { remote "$1" | env -u GITHUB_STEP_SUMMARY bash "$GUARD"; }
deploy_step() { ( cd "$WS" && PATH="$WS/bin:$PATH" FAKE_DOCKER_MODE="$1" bash "$WS/deploy-block.sh" ); }

assert_green "extraction: the workflow's remote script and the deploy block were both found" -- \
  bash -c "[ -s '$WS/remote.sh' ] && [ '$DEPLOY_BLOCK_OK' = 1 ]"

assert_red "PIPELINE: log with a 42501 -> remote fields -> checker FIRES" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=VacancyRetentionService object=table:vacancy_applications sqlstate=42501-by-message" \
  --contains "container crm-api-1" -- pipeline hit
assert_red "PIPELINE: a labelled sqlstate=42501 with the wrapper message fires as sqlstate=42501" \
  --contains "logger=TelemetryRetentionService object=unknown sqlstate=42501" -- pipeline code
assert_red "PIPELINE: upper-case message is matched and its object extracted" \
  --contains "object=table:public.vacancy_applications" -- pipeline upper
assert_red "PIPELINE: must-be-owner (42501 without the phrase) fires" \
  --contains "object=owner-only:table:document_access_log" -- pipeline owner
assert_green "PIPELINE: clean log stays quiet" --contains "OK: read 2 API log line(s)" --not-contains "HIT" -- pipeline clean
assert_red "PIPELINE: docker logs failing is BLIND, not clean" --contains "compose_logs" -- pipeline fail
assert_red "PIPELINE: no api container is BLIND, not clean" --contains "no running api container" -- pipeline nocontainer

# AC6: no raw production text at either lock, on a line that carries PII and a
# workflow-command injection next to a real permission-denied.
assert_green "AC6 lock 1: the REMOTE script's own output carries no raw log text" \
  --contains "LOGSCAN_HIT ts=2026-10-19T03:00:02.000000001Z logger=VacancyRetentionService object=table:vacancy_applications sqlstate=42501-by-message" \
  --not-contains "jane.doe" --not-contains "380501234567" --not-contains "INJECTED" \
  --not-contains "SECRETVALUE" --not-contains "DELETE FROM" --not-contains "params" -- remote hostile
assert_red "AC6 lock 2: after the checker, still nothing raw, and it still fires" \
  --contains "object=table:vacancy_applications" \
  --not-contains "jane.doe" --not-contains "380501234567" --not-contains "INJECTED" \
  --not-contains "SECRETVALUE" --not-contains "DELETE FROM" -- pipeline hostile

assert_red "DEPLOY: a 42501 in the new container fails the deploy and never reaches the next step" \
  --contains "appeared 1 time(s)" --not-contains "DEPLOY-CONTINUED" --not-contains "VacancyRetentionService" -- deploy_step hit
assert_red "DEPLOY: the failure message carries no raw text from a hostile line" \
  --not-contains "jane.doe" --not-contains "INJECTED" --not-contains "DELETE FROM" -- deploy_step hostile
assert_green "DEPLOY: clean logs let the deploy continue" \
  --contains "No permission denied / 42501" --contains "DEPLOY-CONTINUED" -- deploy_step clean
assert_red "DEPLOY: an unreadable log fails the deploy instead of passing unread" \
  --contains "could not read" --not-contains "DEPLOY-CONTINUED" -- deploy_step fail

# ═══ 3. the copy on the VPS must equal the definition ══════════════════════════
deploy_re="$(sed -n "s/^PERMISSION_DENIED_RE='\(.*\)'\$/\1/p" "$DEPLOY_SCRIPT" | head -n 1)"
if [ "$deploy_re" = "$RE" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  deploy-stack-on-vps.sh carries the same pattern as the checker\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  pattern drift: deploy script has [%s], checker has [%s]\n' "$deploy_re" "$RE"
fi

guard_test_summary "test-check-api-permission-denied.sh"
