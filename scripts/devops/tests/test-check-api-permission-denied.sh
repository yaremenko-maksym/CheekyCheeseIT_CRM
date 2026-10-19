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

# The allowlists come from the SHIPPED derivation, run against the real tree, exactly
# as the workflow does. (Their independent cross-check is section 4.)
DERIVE="$GUARD_DIR/derive-permission-denied-allowlists.sh"
DERIVED="$(bash "$DERIVE")"
LOGSCAN_TABLES="$(printf '%s\n' "$DERIVED" | sed -n 's/^tables=//p')"
LOGSCAN_LOGGERS="$(printf '%s\n' "$DERIVED" | sed -n 's/^loggers=//p')"
export LOGSCAN_TABLES LOGSCAN_LOGGERS

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
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=TelemetryRetentionCronService object=table:telemetry_events sqlstate=42501-by-message
LOGSCAN_END
EOF

cat >"$WS/hit-variants.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=900
LOGSCAN_HITS=3
LOGSCAN_HIT ts=2026-10-19T04:00:00.000000001Z logger=unknown object=unknown sqlstate=42501
LOGSCAN_HIT ts=2026-10-19T04:00:01.000000001Z logger=DocumentAccessLogRetentionCronService object=owner-only:table:document_access_log sqlstate=42501-by-message
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
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=table:unknown sqlstate=42501
LOGSCAN_END
EOF

# ── fires ────────────────────────────────────────────────────────────────────
assert_red "synthetic 42501 FIRES with time, logger, object, sqlstate and container" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=TelemetryRetentionCronService object=table:telemetry_events sqlstate=42501-by-message" \
  --contains "API hit permission denied (42501)" --contains "container crm-api-1" -- \
  run_guard "$WS/hit.env"

assert_red "code-only, owner-only and unclassified variants all fire" \
  --contains "logger=unknown object=unknown sqlstate=42501" \
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

# ── AC7: allowlist lock in the checker. `unknown` is accepted AND pages ─────────
cat >"$WS/unknown-hit.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=table:unknown sqlstate=42501
LOGSCAN_END
EOF
cat >"$WS/offlist-logger.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=AttackerChosenTokenHere object=table:unknown sqlstate=42501
LOGSCAN_END
EOF
cat >"$WS/offlist-object.env" <<'EOF'
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=table:jane_doe_example_com sqlstate=42501
LOGSCAN_END
EOF
assert_red "UNKNOWN STILL PAGES: an unrecognised logger and object fire exactly like known ones" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=unknown object=table:unknown sqlstate=42501" \
  --contains "API hit permission denied (42501)" -- run_guard "$WS/unknown-hit.env"
assert_exit_code "an unknown hit exits 1 (a page), not 0" 1 run_guard "$WS/unknown-hit.env"
assert_red "an off-list logger in the envelope is refused (BLIND), not shown" \
  --contains "BLIND" --not-contains "AttackerChosenToken" -- run_guard "$WS/offlist-logger.env"
assert_red "an off-list object name in the envelope is refused (BLIND), not shown" \
  --contains "BLIND" --not-contains "jane_doe" -- run_guard "$WS/offlist-object.env"
assert_red "no allowlists supplied: BLIND (fails closed), even for a clean-looking hit" \
  --contains "allowlists not provided" -- env -u LOGSCAN_TABLES -u LOGSCAN_LOGGERS bash "$GUARD" <"$WS/hit.env"

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
    [ "${FAKE_DOCKER_MODE:-}" = "fail" ] && { echo "Error response from daemon: no such service" >&2; exit 1; }
    # The REAL `docker compose logs` shape: every line is prefixed `<service>-<n>  | `
    # and, with --timestamps, the RFC3339 time follows. (A first version of this shim
    # emitted bare lines, which is how a timestamp regex that never matched went
    # unnoticed: a test that builds its own input cannot discover what the producer emits.)
    { case "${FAKE_DOCKER_MODE:-}" in
      hit)   printf "%s\n" \
               "2026-10-19T03:00:01.000000001Z [Nest] 18  - 10/19/2026, 3:00:01 AM     LOG [HealthController] ok" \
               "2026-10-19T03:00:02.123456789Z [Nest] 18  - 10/19/2026, 3:00:02 AM   ERROR [VacanciesRetentionCronService] retention failed error: permission denied for table vacancy_applications" ;;
      code)  printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [TelemetryRetentionCronService] retention failed sqlstate=42501: Failed query: delete from telemetry_events" ;;
      upper) printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacanciesRetentionCronService] error: PERMISSION DENIED for table public.vacancy_applications" ;;
      owner) printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [DocumentAccessLogRetentionCronService] error: must be owner of table document_access_log" ;;
      hostile) printf "%s\n" \
               "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacanciesRetentionCronService] DELETE FROM vacancy_applications WHERE email = \$1 params: jane.doe@example.com,+380501234567 ::error::INJECTED permission denied for table vacancy_applications" \
               "GET /x?q=permission%20denied token=SECRETVALUE123" ;;
      evil)  printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacanciesRetentionCronService] lookup for user input ERROR [EVIL-TOKEN-xyz-attacker-chosen-text] failed: permission denied for table \"jane_doe_example_com\"" ;;
      *)     printf "%s\n" "2026-10-19T03:00:01.000000001Z [Nest] 18  - 10/19/2026, 3:00:01 AM     LOG [HealthController] ok" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x     LOG [Cron] retention pruned 0 rows" ;;
    esac; } | sed "s/^/api-1  | /"
    exit 0 ;;
esac
exit 0'

REMOTE_SH="$GUARD_DIR/api-permission-denied-remote.sh"
SCAN_SH="$GUARD_DIR/scan-api-permission-denied.sh"

DEPLOY_BLOCK_OK=1
sed -n "/^PERMISSION_DENIED_RE='/,/^echo \"No permission denied/p" "$DEPLOY_SCRIPT" >"$WS/deploy-block.body"
[ -s "$WS/deploy-block.body" ] || DEPLOY_BLOCK_OK=0
{
  echo 'set -euo pipefail'
  echo 'DEPLOY_STARTED_AT=2026-10-19T03:00:00Z'
  cat "$WS/deploy-block.body"
  echo 'echo DEPLOY-CONTINUED'
} >"$WS/deploy-block.sh"

remote() { ( PATH="$WS/bin:$PATH" FAKE_DOCKER_MODE="$1" LOGSCAN_CRM_DIR="$WS" LOGSCAN_RE="$RE" LOGSCAN_SINCE=40m bash "$REMOTE_SH" ); }
pipeline() { remote "$1" | env -u GITHUB_STEP_SUMMARY bash "$GUARD"; }
deploy_step() { ( cd "$WS" && PATH="$WS/bin:$PATH" FAKE_DOCKER_MODE="$1" bash "$WS/deploy-block.sh" ); }

assert_green "extraction: the remote script exists and the deploy block was found" -- \
  bash -c "[ -s '$REMOTE_SH' ] && [ '$DEPLOY_BLOCK_OK' = 1 ]"

assert_red "PIPELINE: log with a 42501 -> remote fields -> checker FIRES" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=VacanciesRetentionCronService object=table:vacancy_applications sqlstate=42501-by-message" \
  --contains "container crm-api-1" -- pipeline hit
assert_red "PIPELINE: a labelled sqlstate=42501 with the wrapper message fires as sqlstate=42501" \
  --contains "logger=TelemetryRetentionCronService object=unknown sqlstate=42501" -- pipeline code
assert_red "PIPELINE: upper-case message is matched and its object extracted" \
  --contains "object=table:vacancy_applications" -- pipeline upper
assert_red "PIPELINE: must-be-owner (42501 without the phrase) fires" \
  --contains "object=owner-only:table:document_access_log" -- pipeline owner
assert_green "PIPELINE: clean log stays quiet" --contains "OK: read 2 API log line(s)" --not-contains "HIT" -- pipeline clean
assert_red "PIPELINE: docker logs failing is BLIND, not clean" --contains "compose_logs" -- pipeline fail
assert_red "PIPELINE: no api container is BLIND, not clean" --contains "no running api container" -- pipeline nocontainer

# AC6: no raw production text at either lock, on a line that carries PII and a
# workflow-command injection next to a real permission-denied.
assert_green "AC6 lock 1: the REMOTE script's own output carries no raw log text" \
  --contains "LOGSCAN_HIT ts=2026-10-19T03:00:02.000000001Z logger=VacanciesRetentionCronService object=table:vacancy_applications sqlstate=42501-by-message" \
  --not-contains "jane.doe" --not-contains "380501234567" --not-contains "INJECTED" \
  --not-contains "SECRETVALUE" --not-contains "DELETE FROM" --not-contains "params" -- remote hostile
assert_red "AC6 lock 2: after the checker, still nothing raw, and it still fires" \
  --contains "object=table:vacancy_applications" \
  --not-contains "jane.doe" --not-contains "380501234567" --not-contains "INJECTED" \
  --not-contains "SECRETVALUE" --not-contains "DELETE FROM" -- pipeline hostile

# AC7: a bracketed token and a table slot filled by attacker-influenced text. Both
# are reported as `unknown`, the hit STILL pages, and neither string is published.
assert_red "AC7: hostile bracketed token + off-list table -> unknown/unknown, STILL FIRES, nothing published" \
  --contains "logger=unknown object=table:unknown sqlstate=42501-by-message" \
  --not-contains "EVIL-TOKEN" --not-contains "jane_doe" -- pipeline evil
assert_green "AC7: the REMOTE script's own output already shows unknown (lock 1, before the checker)" \
  --contains "object=table:unknown" --not-contains "EVIL-TOKEN" --not-contains "jane_doe" -- remote evil
assert_exit_code "AC7: the hostile line exits 1 (a page), not 0" 1 pipeline evil

assert_red "DEPLOY: a 42501 in the new container fails the deploy and never reaches the next step" \
  --contains "appeared 1 time(s)" --not-contains "DEPLOY-CONTINUED" --not-contains "VacanciesRetentionCronService" -- deploy_step hit
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

# ═══ 4. the allowlists: derivation, independence, drift ════════════════════════
# The SHIPPED path is derive-permission-denied-allowlists.sh (awk + grep over the
# manifest, run at scan time). The comparison below is against a GENUINELY DIFFERENT
# parser, run on every test run, not once: Node slices the PRIVILEGE_CLASSES literal
# out of the same file, strips comments and EVALUATES it as JavaScript (the input is our
# own committed manifest, read in a test, never external data). Two parsers
# with different failure modes agreeing is evidence; the derived list compared with
# itself would not be. (A first version of the shipped parser silently dropped the
# inline arrays `'A-log-prunable': ['document_access_log']` and `B: [...]`; this
# comparison is what catches that class.)
MANIFEST="$GUARD_DIR/../../apps/api/src/database/privileges/privilege-classes.ts"
node -e '
const s=require("fs").readFileSync(process.argv[1],"utf8");
const i=s.indexOf("export const PRIVILEGE_CLASSES");const j=s.indexOf("= {",i)+2;const k=s.indexOf("\n}\n",j)+2;
const body=s.slice(j,k).replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/.*$/gm,"");
console.log(Object.values(eval("("+body+")")).flat().sort().join("\n"))' "$MANIFEST" >"$WS/js-tables.txt" 2>/dev/null
printf '%s\n' "$LOGSCAN_TABLES" | tr ' ' '\n' | sort >"$WS/derived-tables.txt"

assert_green "derived table list is non-trivial (the independent evaluator produced one too)" -- \
  bash -c "[ \"\$(wc -l <'$WS/js-tables.txt')\" -ge 20 ]"
assert_green "derived table list == the manifest evaluated as JavaScript (two independent parsers)" -- \
  diff "$WS/derived-tables.txt" "$WS/js-tables.txt"
assert_green "the tables the ADR names are on the list, including inline-array classes" -- \
  bash -c "for t in document_access_log job_queue_actions telemetry_events vacancy_applications transactions; do grep -qx \$t '$WS/derived-tables.txt' || { echo missing \$t; exit 1; }; done"

# A fake repo: the real manifest plus a synthetic NEW table in a NEW inline class, and
# a source tree with enough loggers to clear the floor.
FR="$WS/fakeroot"
mkdir -p "$FR/apps/api/src/database/privileges" "$FR/apps/api/src/svc"
sed "s/^  B: \['job_queue_actions'\],/  B: ['job_queue_actions', 'brand_new_table_1_3e'],/" "$MANIFEST" >"$FR/apps/api/src/database/privileges/privilege-classes.ts"
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22; do
  echo "const l = new Logger(Fake${n}Service.name)" >"$FR/apps/api/src/svc/f${n}.ts"
done
echo "const l = new Logger(OnlyInASpecService.name)" >"$FR/apps/api/src/svc/only.spec.ts"
echo "const l = new Logger('LiteralNamed')" >"$FR/apps/api/src/svc/lit.ts"
derive_fake() { REPO_ROOT="$FR" bash "$DERIVE"; }

assert_green "NO DRIFT: a table added to the manifest is on the list at the next scan (read at scan time)" \
  --contains "brand_new_table_1_3e" -- derive_fake
assert_green "loggers: a literal context and .name contexts are listed, framework contexts included" \
  --contains "LiteralNamed" --contains "Fake7Service" --contains "ExceptionsHandler" -- derive_fake
assert_green "loggers: a spec-only logger is NOT listed" --not-contains "OnlyInASpecService" -- derive_fake

# Floors: a changed manifest shape must go RED, not silently make everything unknown.
mkdir -p "$WS/emptyroot/apps/api/src/database/privileges"
printf 'export const SOMETHING_ELSE = { A: [] }\n' >"$WS/emptyroot/apps/api/src/database/privileges/privilege-classes.ts"
cp -R "$FR/apps/api/src/svc" "$WS/emptyroot/apps/api/src/svc"
assert_red "manifest shape changed (no PRIVILEGE_CLASSES) -> the derivation FAILS LOUDLY, not an empty list" \
  --contains "derived only 0 table" -- env REPO_ROOT="$WS/emptyroot" bash "$DERIVE"
mkdir -p "$WS/nologgers/apps/api/src/database/privileges"
cp "$MANIFEST" "$WS/nologgers/apps/api/src/database/privileges/privilege-classes.ts"
assert_red "logger convention changed (none found beyond the framework list) -> FAILS LOUDLY" \
  --contains "logger name(s)" -- env REPO_ROOT="$WS/nologgers" bash "$DERIVE"
assert_red "missing manifest file -> FAILS LOUDLY" --contains "manifest not found" -- \
  env REPO_ROOT="$WS/does-not-exist" bash "$DERIVE"

guard_test_summary "test-check-api-permission-denied.sh"
