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
CONTRACT_RE="$(bash "$GUARD" --print-contract-pattern)"

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
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=412
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=TelemetryRetentionCronService object=table:telemetry_events sqlstate=42501-by-message src=text
LOGSCAN_END
EOF

cat >"$WS/hit-variants.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=900
LOGSCAN_HITS=3
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T04:00:00.000000001Z logger=unknown object=unknown sqlstate=42501 src=text
LOGSCAN_HIT ts=2026-10-19T04:00:01.000000001Z logger=DocumentAccessLogRetentionCronService object=owner-only:table:document_access_log sqlstate=42501-by-message src=text
LOGSCAN_HIT ts=unknown logger=unknown object=unknown sqlstate=unclassified src=text
LOGSCAN_END
EOF

# The count alone is the alert, even if no detail line survived.
cat >"$WS/hit-count-only.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=10
LOGSCAN_HITS=4
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_END
EOF

cat >"$WS/clean.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=412
LOGSCAN_HITS=0
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_END
EOF

cat >"$WS/clean-silent.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=0
LOGSCAN_HITS=0
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_END
EOF

# SECOND LOCK: a remote that starts emitting raw text must turn the run red, and the
# text must not be echoed by the checker.
cat >"$WS/leak-raw-line.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=5
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
2026-10-19T05:00:00.000000001Z ERROR [X] permission denied for table t; email=jane.doe@example.com ::error::INJECTED
LOGSCAN_END
EOF
cat >"$WS/leak-in-field.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=5
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T05:00:00.000000001Z logger=X object=table:t;jane.doe@example.com sqlstate=42501 src=text
LOGSCAN_END
EOF

: >"$WS/empty.env"
printf 'LOGSCAN_BEGIN\nLOGSCAN_FAILED=compose_logs\n' >"$WS/remote-failed.env"
cat >"$WS/no-container.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=0
LOGSCAN_CONTAINER=unknown
LOGSCAN_LINES=0
LOGSCAN_HITS=0
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_END
EOF
# Cut off before END: the hit could be in the part that was lost.
cat >"$WS/truncated.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=412
LOGSCAN_HITS=0
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
EOF
printf '%s\n' '<html>ssh banner garbage</html>' >"$WS/garbage.env"
cat >"$WS/inconsistent.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=3
LOGSCAN_HITS=0
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=table:unknown sqlstate=42501 src=text
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
  --contains "0 contract line(s) and 3 other" -- \
  run_guard "$WS/hit-variants.env"

assert_red "a hit count with no detail lines still fires" --contains "0 contract line(s) and 4 other" -- \
  run_guard "$WS/hit-count-only.env"

assert_exit_code "a hit exits 1 (act on it)" 1 run_guard "$WS/hit.env"

# ── quiet ────────────────────────────────────────────────────────────────────
assert_green "clean log stays quiet: exit 0, says what it read, no HIT, no error" \
  --contains "OK: read under 1,000 API log line(s) from 1 container(s) (crm-api-1)" \
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
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=table:unknown sqlstate=42501 src=text
LOGSCAN_END
EOF
cat >"$WS/offlist-logger.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=AttackerChosenTokenHere object=table:unknown sqlstate=42501 src=text
LOGSCAN_END
EOF
cat >"$WS/offlist-object.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=table:jane_doe_example_com sqlstate=42501 src=text
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
# SR-M-2: the WHOLE object field is validated, not the segment after the last colon.
mk_obj_env() { # <object-field> -> $WS/obj.env
  cat >"$WS/obj.env" <<EOF
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=$1 sqlstate=42501 src=text
LOGSCAN_END
EOF
}
run_obj() { mk_obj_env "$1"; run_guard "$WS/obj.env"; }
assert_red "SR-M-2: 'jane.doe.example.com-380501234567:unknown' (legal last segment, hostile prefix) is refused and NOT echoed" \
  --contains "BLIND" --not-contains "jane.doe" --not-contains "380501234567" -- run_obj "jane.doe.example.com-380501234567:unknown"
assert_red "SR-M-2: a hostile prefix before a LISTED table is refused too" \
  --contains "BLIND" --not-contains "jane.doe" -- run_obj "jane.doe:table:telemetry_events"
assert_red "SR-M-2: an unknown kind is refused" --contains "BLIND" -- run_obj "widget:telemetry_events"
assert_red "SR-M-2: a bare word with no kind:name shape is refused" --contains "BLIND" -- run_obj "telemetry_events"
assert_red "SR-M-2: kind:name with an off-list name is refused" --contains "BLIND" -- run_obj "table:jane_doe_example_com"
assert_red "SR-M-2: the legal shapes still fire (owner-only:table:<listed>)" --contains "object=owner-only:table:document_access_log" -- run_obj "owner-only:table:document_access_log"
assert_red "SR-M-2: ...and kind:unknown still pages" --contains "object=sequence:unknown" -- run_obj "sequence:unknown"

# SR-M-4: the summary's advice must be true of what it emits.
SUMF="$WS/summary.md"
run_with_summary() { : >"$SUMF"; GITHUB_STEP_SUMMARY="$SUMF" bash "$GUARD" <"$1" >/dev/null 2>&1; }
run_with_summary "$WS/hit.env"
assert_green "SR-M-4: a hit WITH a timestamp points at the timestamps above" -- grep -q 'near the timestamps above' "$SUMF"
cat >"$WS/hit-nots.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=1
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=unknown logger=unknown object=table:unknown sqlstate=42501 src=text
LOGSCAN_END
EOF
run_with_summary "$WS/hit-nots.env"
assert_green "SR-M-4: a hit with ts=unknown does NOT claim timestamps exist, and says where to look instead" -- \
  bash -c "! grep -q 'near the timestamps above' '$SUMF' && grep -q 'No timestamp could be read' '$SUMF'"

# LOW: the public log carries a coarse volume, never the exact line count.
cat >"$WS/clean-413.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=40321
LOGSCAN_HITS=0
LOGSCAN_CONTRACT_HITS=0
LOGSCAN_UNPARSED=0
LOGSCAN_END
EOF
assert_green "the public log never shows an exact traffic count (40321 lines -> a bucket)" \
  --contains "10,000 or more" --not-contains "40321" -- run_guard "$WS/clean-413.env"

assert_red "no allowlists supplied: BLIND (fails closed), even for a clean-looking hit" \
  --contains "allowlists not provided" -- env -u LOGSCAN_TABLES -u LOGSCAN_LOGGERS bash "$GUARD" <"$WS/hit.env"

# ── SR-M-6: the frame. Text a login shell writes around our output is discarded and
# COUNTED, never shown, and never turns a genuine hit into BLIND ─────────────────
{ printf 'Welcome to the VPS\nLast login: Mon Oct 19 from 203.0.113.9\n'; cat "$WS/hit.env"; printf 'bye from the rc file\n'; } >"$WS/noisy-hit.env"
{ printf 'Welcome to the VPS\n'; cat "$WS/clean.env"; } >"$WS/noisy-clean.env"
printf 'Welcome to the VPS\nconnection banner\n' >"$WS/noise-only.env"
{ cat "$WS/hit.env"; cat "$WS/clean.env"; } >"$WS/two-frames.env"
assert_red "SR-M-6: a hit with login-shell text before AND after the frame still FIRES (exit 1, not BLIND)" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z" --contains "discarded 3 line(s)" \
  --not-contains "Welcome" --not-contains "203.0.113.9" --not-contains "bye from" -- run_guard "$WS/noisy-hit.env"
assert_exit_code "SR-M-6: ...exit code 1" 1 run_guard "$WS/noisy-hit.env"
assert_green "SR-M-6: a clean scan with leading rc text stays clean (exit 0) and reports the count" \
  --contains "OK: read" --contains "discarded 1 line(s)" --not-contains "Welcome" -- run_guard "$WS/noisy-clean.env"
assert_red "SR-M-6: output with NO frame at all is still BLIND (the script did not run), not clean, nothing echoed" \
  --contains "no LOGSCAN_BEGIN frame in 2 line(s)" --not-contains "Welcome" -- run_guard "$WS/noise-only.env"
assert_exit_code "SR-M-6: ...exit 2" 2 run_guard "$WS/noise-only.env"
assert_red "SR-M-6: a second frame AFTER the first cannot turn a hit into a clean scan: ambiguous, BLIND" --contains "ambiguous" -- run_guard "$WS/two-frames.env"
assert_exit_code "SR-M-6: ...exit 2" 2 run_guard "$WS/two-frames.env"

# The contract fields: CONTRACT_HITS is required and cannot exceed HITS (fail closed).
cat >"$WS/contract-hit.env" <<'EOF'
LOGSCAN_BEGIN
LOGSCAN_API_CONTAINERS=1
LOGSCAN_CONTAINER=crm-api-1
LOGSCAN_LINES=9
LOGSCAN_HITS=2
LOGSCAN_CONTRACT_HITS=1
LOGSCAN_UNPARSED=0
LOGSCAN_HIT ts=2026-10-19T03:00:02.123456789Z logger=unknown object=table:document_access_log sqlstate=42501 src=contract
LOGSCAN_HIT ts=2026-10-19T03:00:02.223456789Z logger=unknown object=table:document_access_log sqlstate=42501-by-message src=text
LOGSCAN_END
EOF
grep -v '^LOGSCAN_CONTRACT_HITS=' "$WS/contract-hit.env" >"$WS/no-contract-field.env"
sed 's/^LOGSCAN_CONTRACT_HITS=1$/LOGSCAN_CONTRACT_HITS=5/' "$WS/contract-hit.env" >"$WS/contract-gt-hits.env"
assert_red "contract fields: '1 contract, 1 other' is reported as such, with a source column" \
  --contains "1 contract line(s) and 1 other" --contains "src=contract" --contains "src=text" -- run_guard "$WS/contract-hit.env"
assert_red "contract fields: an envelope with no LOGSCAN_CONTRACT_HITS is BLIND (a remote older than this checker)" \
  --contains "LOGSCAN_CONTRACT_HITS" --contains "BLIND" -- run_guard "$WS/no-contract-field.env"
assert_red "contract fields: more contract hits than hits is BLIND (inconsistent)" \
  --contains "inconsistent" -- run_guard "$WS/contract-gt-hits.env"

# The container name is validated against the compose naming scheme, not just a charset:
# stray stdout is never published as a "container".
sed 's/^LOGSCAN_CONTAINER=.*/LOGSCAN_CONTAINER=WelcometotheVPSrcfileoutput/' "$WS/hit.env" >"$WS/bad-container.env"
assert_red "container name: a charset-clean but non-compose name is refused (BLIND) and not echoed" \
  --contains "BLIND" --not-contains "Welcometothe" -- run_guard "$WS/bad-container.env"

# ── the published interface: --print-pattern / --print-contract-pattern have a CONSUMER ──
# PR #1042 (the API side) reads these instead of copying the pattern. The literals are pinned
# so that changing a pattern is a deliberate act that also updates this test, the deploy copy
# and the other side, never a side effect of an edit elsewhere.
assert_green "published interface: --print-contract-pattern is exactly the anchored contract" \
  --contains '\[DatabasePrivilege\] db_privilege_denied.*sqlstate=42501' -- bash "$GUARD" --print-contract-pattern
assert_green "published interface: --print-pattern is exactly contract | permission denied | must be owner|superuser" \
  --contains '\[DatabasePrivilege\] db_privilege_denied.*sqlstate=42501|permission denied|must be (owner|superuser)' -- bash "$GUARD" --print-pattern
assert_green "published interface: ...and the two flags print one line each, nothing else" -- \
  bash -c "[ \"\$(bash '$GUARD' --print-pattern | wc -l | tr -d ' ')\" = 1 ] && [ \"\$(bash '$GUARD' --print-contract-pattern | wc -l | tr -d ' ')\" = 1 ]"

# ── the pattern itself ───────────────────────────────────────────────────────
pat_hits() { printf '%s\n' "$1" | grep -aEi -e "$RE" >/dev/null; }
assert_green "pattern: 'permission denied for table x'" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'ERROR permission denied for table x'"
assert_green "pattern: THE CONTRACT line the API's chokepoint emits (PR #1042)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool'"
assert_green "pattern: ...whatever the field order after the first token" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits '[DatabasePrivilege] db_privilege_denied ctx=pool table=users sqlstate=42501'"
assert_red "pattern: a bare 'sqlstate=42501' is NOT the contract (too generic: a client can put it in a URL)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'cron failed sqlstate=42501'"
assert_red "pattern: a JSON \"code\":\"42501\" alone is NOT matched either (narrowed on purpose)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits '{\"code\":\"42501\"}'"
assert_red "pattern: #1042's diagnostic fragment db_sqlstate=42501 must NOT match (one failure, one contract line)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'db_error db_sqlstate=42501 db_table=- db_constraint=- db_column=- db_message=- db_statement=\"select 1\"'"
assert_red "pattern: 'db_privilege_denied' with a DIFFERENT sqlstate (28P01) is not a 42501 contract line" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'db_privilege_denied sqlstate=28P01 table=unknown'"
# SR-M-9: the contract is anchored on the logger context, so user data echoed into another
# handler's message or log line cannot forge the primary pattern.
assert_red "SR-M-9: the contract token under ANOTHER logger context is not the contract (nor any hit)" -- \
  bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'ERROR [VacanciesRetentionCronService] db_privilege_denied sqlstate=42501 table=users ctx=pool'"
assert_red "SR-M-9: request data echoed into an unhandled-error message does not forge it" -- \
  bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'ERROR [ExceptionsHandler] Cannot parse GET /x?db_privilege_denied&sqlstate=42501'"
assert_green "contract regex is a subset of the full regex (everything contract is also a hit)" -- \
  bash -c "printf '%s\n' '[DatabasePrivilege] db_privilege_denied sqlstate=42501 table=x ctx=pool' | grep -aEi -e '$CONTRACT_RE' >/dev/null && printf '%s\n' '[DatabasePrivilege] db_privilege_denied sqlstate=42501 table=x ctx=pool' | grep -aEi -e '$RE' >/dev/null"
assert_red "contract regex does NOT match the belt-and-braces text (the two are distinguishable)" -- \
  bash -c "printf '%s\n' 'permission denied for table x' | grep -aEi -e '$CONTRACT_RE'"
assert_red "pattern: a bare number 42501 elsewhere (an id, a port) does NOT fire" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'processed 42501 rows'"
assert_red "pattern: the pool-listener's other codes (57P01, 28P01) do NOT fire" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'Postgres pool idle-client error sqlstate=57P01: terminating connection'"
assert_red "pattern: the Drizzle wrapper message alone does NOT fire (why the API must log .cause)" -- bash -c "$(declare -f pat_hits); RE='$RE'; pat_hits 'Failed query: DELETE FROM telemetry_events WHERE ts < \$1'"

# ═══ 2. the real remote script and deploy block, against a fake docker ═════════

guard_test_shim "$WS" docker '#!/usr/bin/env bash
case " $* " in
  *" ps "*)
    [ "${FAKE_DOCKER_MODE:-}" = "psnoise" ] && echo "Welcome to the VPS stray line on docker stdout"
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
      # A log taken verbatim from a file (SR-H-7: records chunked by the Docker json-file driver).
      file)    cat "$FAKE_LOG_FILE" ;;
      # The contract TOKEN under a handler own context is not the contract (SR-M-9).
      ctx_other) printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacanciesRetentionCronService] db_privilege_denied sqlstate=42501 table=users ctx=pool" ;;
      # PR #1042: the contract line (one chokepoint) and the handler diagnostic fragment.
      contract)       printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool" ;;
      contract_dash)  printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 table=unknown ctx=client" ;;
      contract_off)   printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 table=we?ird?t ctx=pool" ;;
      contract_diag)  printf "%s\n" \
                        "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool" \
                        "2026-10-19T03:00:02.100000001Z [Nest] 18  - x   ERROR [DocumentAccessLogRetentionCronService] retention failed db_error db_sqlstate=42501 db_table=document_access_log db_constraint=- db_column=- db_message=\"permission denied for table document_access_log\" db_statement=\"delete from document_access_log\"" ;;
      contract_diag_quiet) printf "%s\n" \
                        "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool" \
                        "2026-10-19T03:00:02.100000001Z [Nest] 18  - x   ERROR [DocumentAccessLogRetentionCronService] retention failed db_error db_sqlstate=42501 db_table=- db_constraint=- db_column=- db_message=- db_statement=\"select 1\"" ;;
      diag_alone)     printf "%s\n" "2026-10-19T03:00:02.100000001Z [Nest] 18  - x   ERROR [DocumentAccessLogRetentionCronService] retention failed db_error db_sqlstate=42501 db_table=- db_constraint=- db_column=- db_message=- db_statement=\"select 1\"" ;;
      upper) printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacanciesRetentionCronService] error: PERMISSION DENIED for table public.vacancy_applications" ;;
      owner) printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [DocumentAccessLogRetentionCronService] error: must be owner of table document_access_log" ;;
      hostile) printf "%s\n" \
               "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacanciesRetentionCronService] DELETE FROM vacancy_applications WHERE email = \$1 params: jane.doe@example.com,+380501234567 ::error::INJECTED permission denied for table vacancy_applications" \
               "GET /x?q=permission%20denied token=SECRETVALUE123" ;;
      realfastify) awk "{print \"2026-10-19T03:00:01.000000001Z \" \$0}" "$REAL_FASTIFY_FILE" ;;
      realfastify_boom) awk "{print \"2026-10-19T03:00:01.000000001Z \" \$0}" "$REAL_FASTIFY_ALL" ;;
      realfastify_flood) for i in $(seq 1 30); do awk "{print \"2026-10-19T03:00:01.000000001Z \" \$0}" "$REAL_FASTIFY_FILE"; done
               printf "%s\n" "2026-10-19T03:00:09.000000001Z [Nest] 18  - x   ERROR [TelemetryRetentionCronService] retention failed sqlstate=42501: permission denied for table telemetry_events" ;;
      textecho) printf "%s\n" "2026-10-19T03:00:09.000000001Z [Nest] 18  - x   ERROR [TelemetryRetentionCronService] retention failed: permission denied for table telemetry_events {\"level\":30,\"msg\":\"echoed by a client\"}" ;;
      evil)  printf "%s\n" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x   ERROR [VacanciesRetentionCronService] lookup for user input ERROR [EVIL-TOKEN-xyz-attacker-chosen-text] failed: permission denied for table \"jane_doe_example_com\"" ;;
      *)     printf "%s\n" "2026-10-19T03:00:01.000000001Z [Nest] 18  - 10/19/2026, 3:00:01 AM     LOG [HealthController] ok" "2026-10-19T03:00:02.000000001Z [Nest] 18  - x     LOG [Cron] retention pruned 0 rows" ;;
    esac; } | sed "s/^/api-1  | /"
    exit 0 ;;
esac
exit 0'

REMOTE_SH="$GUARD_DIR/api-permission-denied-remote.sh"
SCAN_SH="$GUARD_DIR/scan-api-permission-denied.sh"

# ── SR-H-5: the REAL producer of request log lines ────────────────────────────
# lib/real-fastify-request-log.ts runs the repository's own createRedactingReqSerializer
# inside a real Fastify and injects real anonymous requests. It needs `pnpm install` (CI's
# guard_tests job does that); without it this FAILS LOUDLY rather than skipping: a skip
# here would quietly drop the regression for the exact forgery the watch must survive.
# LOGSCAN_API_DIR points at an apps/api that has node_modules (worktrees without an install).
REAL_API_DIR="${LOGSCAN_API_DIR:-$GUARD_DIR/../../apps/api}"
REAL_TSX="$REAL_API_DIR/node_modules/.bin/tsx"
REAL_FASTIFY_ALL="$WS/real-fastify.all"
REAL_FASTIFY_FILE="$WS/real-fastify.forgeries"
if [ -x "$REAL_TSX" ] \
  && LOGSCAN_API_DIR="$REAL_API_DIR" "$REAL_TSX" "$SELF_DIR/lib/real-fastify-request-log.ts" >"$REAL_FASTIFY_ALL" 2>"$WS/real-fastify.err" \
  && [ -s "$REAL_FASTIFY_ALL" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  fixture: %s real Fastify log records generated by the repository serializer\n' "$(wc -l <"$REAL_FASTIFY_ALL" | tr -d ' ')"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  fixture: could not generate the real Fastify records (needs `pnpm install`, or LOGSCAN_API_DIR): %s\n' "$(head -c 200 "$WS/real-fastify.err" 2>/dev/null)"
  : >"$REAL_FASTIFY_ALL"
fi
# The record that carries a GENUINE error message (the throwing route) is split out so
# "forgeries only" is a clean log and the genuine one stays detectable.
grep -v 'real_hit_from_a_handler' "$REAL_FASTIFY_ALL" >"$REAL_FASTIFY_FILE" || true
export REAL_FASTIFY_FILE REAL_FASTIFY_ALL

DEPLOY_BLOCK_OK=1
sed -n "/^PERMISSION_DENIED_RE='/,/^echo \"No permission denied/p" "$DEPLOY_SCRIPT" >"$WS/deploy-block.body"
[ -s "$WS/deploy-block.body" ] || DEPLOY_BLOCK_OK=0
{
  echo 'set -euo pipefail'
  echo 'DEPLOY_STARTED_AT=2026-10-19T03:00:00Z'
  cat "$WS/deploy-block.body"
  echo 'echo DEPLOY-CONTINUED'
} >"$WS/deploy-block.sh"

remote() { ( PATH="$WS/bin:$PATH" FAKE_DOCKER_MODE="$1" LOGSCAN_CRM_DIR="$WS" LOGSCAN_RE="$RE" LOGSCAN_CONTRACT_RE="$CONTRACT_RE" LOGSCAN_SINCE=40m bash "$REMOTE_SH" ); }
pipeline() { remote "$1" | env -u GITHUB_STEP_SUMMARY bash "$GUARD"; }
deploy_step() { ( cd "$WS" && PATH="$WS/bin:$PATH" FAKE_DOCKER_MODE="$1" bash "$WS/deploy-block.sh" ); }

assert_green "extraction: the remote script exists and the deploy block was found" -- \
  bash -c "[ -s '$REMOTE_SH' ] && [ '$DEPLOY_BLOCK_OK' = 1 ]"

assert_red "PIPELINE: log with a 42501 -> remote fields -> checker FIRES" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=VacanciesRetentionCronService object=table:vacancy_applications sqlstate=42501-by-message" \
  --contains "container crm-api-1" -- pipeline hit
# ── THE CONTRACT (PR #1042): db_privilege_denied sqlstate=42501 table=<T> ctx=<C> ──
assert_red "CONTRACT: the chokepoint's line fires; the table comes from its table= field; src=contract" \
  --contains "object=table:document_access_log sqlstate=42501 src=contract" \
  --contains "1 contract line(s) and 0 other" -- pipeline contract
assert_green "CONTRACT: the remote reports HITS=1 and CONTRACT_HITS=1" \
  --contains "LOGSCAN_HITS=1" --contains "LOGSCAN_CONTRACT_HITS=1" -- remote contract
assert_red "CONTRACT: table=unknown (the 42501 names no table) is reported as object=table:unknown, and STILL pages" \
  --contains "object=table:unknown sqlstate=42501 src=contract" -- pipeline contract_dash
assert_exit_code "CONTRACT: ...exit 1" 1 pipeline contract_dash
assert_red "CONTRACT: an off-list or odd table (we?ird?t) is table:unknown, never published, and STILL pages" \
  --contains "object=table:unknown sqlstate=42501 src=contract" --not-contains "we?ird" -- pipeline contract_off
assert_red "CONTRACT: the contract line plus a handler diagnostic quoting the message = 1 contract + 1 other, said plainly" \
  --contains "1 contract line(s) and 1 other" --contains "src=contract" --contains "src=text" -- pipeline contract_diag
assert_red "CONTRACT: the diagnostic fragment (db_sqlstate=42501, no message text) does NOT add a second hit" \
  --contains "1 contract line(s) and 0 other" -- pipeline contract_diag_quiet
assert_green "CONTRACT: the diagnostic fragment ALONE is not matched (the contract is the chokepoint line; decided with #1042's author)" \
  --contains "OK: read" --not-contains "HIT" -- pipeline diag_alone
assert_red "CONTRACT: the deploy gate fails on the contract line too" \
  --contains "appeared 1 time(s)" --not-contains "DEPLOY-CONTINUED" -- deploy_step contract
assert_red "PIPELINE: upper-case message is matched and its object extracted" \
  --contains "object=table:vacancy_applications" -- pipeline upper
assert_red "PIPELINE: must-be-owner (42501 without the phrase) fires" \
  --contains "object=owner-only:table:document_access_log" -- pipeline owner
assert_green "PIPELINE: clean log stays quiet" --contains "OK: read under 100 API log line(s)" --not-contains "HIT" -- pipeline clean
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

assert_green "container name: stray stdout from 'docker compose ps' is never published as the container" \
  --contains "LOGSCAN_CONTAINER=crm-api-1" --contains "LOGSCAN_API_CONTAINERS=1" --not-contains "Welcome" -- remote psnoise

# AC7: a bracketed token and a table slot filled by attacker-influenced text. Both
# are reported as `unknown`, the hit STILL pages, and neither string is published.
assert_red "AC7: hostile bracketed token + off-list table -> unknown/unknown, STILL FIRES, nothing published" \
  --contains "logger=unknown object=table:unknown sqlstate=42501-by-message" \
  --not-contains "EVIL-TOKEN" --not-contains "jane_doe" -- pipeline evil
assert_green "AC7: the REMOTE script's own output already shows unknown (lock 1, before the checker)" \
  --contains "object=table:unknown" --not-contains "EVIL-TOKEN" --not-contains "jane_doe" -- remote evil
assert_exit_code "AC7: the hostile line exits 1 (a page), not 0" 1 pipeline evil

# python3 stand-in: runs the real one, or fails on demand (the filter must fail CLOSED).
guard_test_shim "$WS" python3 '#!/usr/bin/env bash
[ "${FAKE_PYTHON_FAIL:-}" = 1 ] && exit 1
# A broken shim or version-manager wrapper that reads stdin and exits 0 with NO output, or
# one that just copies its input: neither is the filter, and neither may read as "clean".
[ "${FAKE_PYTHON_EMPTY:-}" = 1 ] && { cat >/dev/null; exit 0; }
[ "${FAKE_PYTHON_CAT:-}" = 1 ] && { cat; exit 0; }
real="$(PATH=/usr/bin:/usr/local/bin:/opt/homebrew/bin:/bin command -v python3)"
exec "$real" "$@"'

# ═══ SR-H-5: anonymous requests must not forge a hit, in the watch OR the deploy gate ═══
forged_unfiltered="$(grep -aEic -e "$RE" "$REAL_FASTIFY_FILE" || true)"
assert_green "SR-H-5 non-vacuity: the REAL Fastify records WOULD match the pattern unfiltered ($forged_unfiltered of them)" -- \
  bash -c "[ '${forged_unfiltered:-0}' -ge 4 ]"

assert_green "SR-H-5 WATCH: anonymous forgeries from the real logger (query string, 404 path, 4xx) -> clean, exit 0" \
  --contains "OK: read" --not-contains "HIT" --not-contains "::error" -- pipeline realfastify
assert_exit_code "SR-H-5 WATCH: ...exit 0, not 1" 0 pipeline realfastify
assert_red "SR-H-5 WATCH: a GENUINE error in a real level-50 record is still found, exactly once, URL gone" \
  --contains "0 contract line(s) and 1 other" --contains "sqlstate=42501-by-message" -- pipeline realfastify_boom
assert_green "SR-H-5 WATCH: ...and the remote reports HITS=1, not one per forged record" \
  --contains "LOGSCAN_HITS=1" -- remote realfastify_boom
assert_red "SR-H-5 WATCH: 30 rounds of forgeries cannot push a genuine hit out or inflate the count" \
  --contains "0 contract line(s) and 1 other" --contains "logger=TelemetryRetentionCronService" -- pipeline realfastify_flood
assert_exit_code "SR-H-5 WATCH: ...and it still pages (exit 1)" 1 pipeline realfastify_flood
assert_red "SR-H-5 WATCH: a genuine TEXT line that ends in an echoed {...} is NOT dropped" \
  --contains "logger=TelemetryRetentionCronService" -- pipeline textecho

assert_green "SR-H-5 DEPLOY: the same anonymous forgeries do not fail the deploy" \
  --contains "No permission denied / 42501" --contains "DEPLOY-CONTINUED" -- deploy_step realfastify
assert_red "SR-H-5 DEPLOY: a genuine error in a real level-50 record still fails it" \
  --contains "appeared 1 time(s)" --not-contains "DEPLOY-CONTINUED" -- deploy_step realfastify_boom
assert_red "SR-H-5 DEPLOY: forgeries plus one genuine hit fail it with a count of exactly 1" \
  --contains "appeared 1 time(s)" -- deploy_step realfastify_flood

# The filter fails CLOSED: no python means "could not look", never "found nothing".
assert_red "SR-H-5 WATCH: a failing python filter is BLIND, not clean" --contains "req_filter" -- \
  env FAKE_PYTHON_FAIL=1 bash -c "$(declare -f remote pipeline); REMOTE_SH='$REMOTE_SH' WS='$WS' RE='$RE' CONTRACT_RE='$CONTRACT_RE' GUARD='$GUARD' LOGSCAN_TABLES='$LOGSCAN_TABLES' LOGSCAN_LOGGERS='$LOGSCAN_LOGGERS'; pipeline clean"
assert_red "SR-H-5 DEPLOY: a failing python filter fails the deploy instead of passing unread" \
  --contains "refusing to pass the 42501 check unread" --not-contains "DEPLOY-CONTINUED" -- \
  env FAKE_PYTHON_FAIL=1 bash -c "$(declare -f deploy_step); WS='$WS'; deploy_step clean"

# ═══ SR-H-7: Docker splits a log line over 16384 bytes and stamps EACH chunk ═══════════
# `docker compose logs --timestamps` therefore hands the filter a pino record with a second
# timestamp INSIDE it. Where it lands decides whether json.loads works, and the client
# chooses (pino doubles each escaped quote, so the byte count is theirs to tune). The old
# filter kept a record it could not parse, request data included. Here the record is the
# REAL serializer output in a REAL Fastify, padded so the URL's closing quote is at byte
# 16384, and the stamp goes right after it, between two JSON tokens.
with_file() { FAKE_LOG_FILE="$1"; export FAKE_LOG_FILE; shift; "$@"; }
make_long() { LOGSCAN_LONG_PAD="$2" LOGSCAN_LONG_ROUTE="$1" LOGSCAN_API_DIR="$REAL_API_DIR" "$REAL_TSX" "$SELF_DIR/lib/real-fastify-request-log.ts" 2>/dev/null; }
url_end() { python3 -I -c 'import sys;s=sys.stdin.read().rstrip("\n");i=s.index("\"url\":\"")+7;print(s.index("\"",i)+1)'; }
not_json() { python3 -I -c 'import json,sys
t=open(sys.argv[1]).read().rstrip("\n").split(" ",1)[1]
try:
    json.loads(t)
except ValueError:
    sys.exit(0)
sys.exit(1)' "$1"; }
is_json() { python3 -I -c 'import json,sys
json.loads(open(sys.argv[1]).read().rstrip("\n").split(" ",1)[1])' "$1"; }
build_long() { # <route> <selector>
  local route="$1" sel="$2" base idx0 pad rec
  base="$(make_long "$route" 0 | grep -m1 -- "$sel")"
  idx0="$(printf '%s' "$base" | url_end 2>/dev/null)"
  if [ -z "$idx0" ]; then : >"$WS/long-$route.json"; return 0; fi
  pad=$((16384 - idx0))
  rec="$(make_long "$route" "$pad" | grep -m1 -- "$sel")"
  printf '%s\n' "$rec" >"$WS/long-$route.json"
  printf '%s' "$rec" | url_end >"$WS/long-$route.idx" 2>/dev/null
  python3 -I - "$WS/long-$route.json" "$WS/long-$route.split" "$WS/long-$route.cut" "$WS/long-$route.nosplit" <<'PYEOF'
import sys
rec = open(sys.argv[1], encoding="utf-8").read().rstrip("\n")
first, rest = rec[:16384], rec[16384:]
lead = "2026-10-19T03:00:01.000000001Z "
stamp = "2026-10-19T03:00:02.123456789Z "
open(sys.argv[2], "w").write(lead + first + stamp + rest + "\n")  # the Docker shape
open(sys.argv[3], "w").write(lead + first + "\n")                 # only the first chunk
open(sys.argv[4], "w").write(lead + rec + "\n")                   # control: no split
PYEOF
}
if [ -s "$REAL_FASTIFY_ALL" ]; then
  echo "  building the >16 KB records with the real serializer (a few seconds)"
  build_long health '"msg":"incoming request"'
  build_long boom '"level":50'
fi

for route in health boom; do
  assert_green "SR-H-7 fixture ($route): the real record's url ends exactly at byte 16384" -- \
    bash -c "[ \"\$(cat '$WS/long-$route.idx' 2>/dev/null)\" = 16384 ]"
  assert_green "SR-H-7 fixture ($route): the split record is NOT valid JSON (the exact input the old filter kept)" -- not_json "$WS/long-$route.split"
  assert_green "SR-H-7 fixture ($route): ...while the same record unsplit IS valid JSON" -- is_json "$WS/long-$route.nosplit"
done
assert_green "SR-H-7 non-vacuity: unfiltered, the split health record matches the CONTRACT (a keep-what-you-cannot-parse filter would publish it)" -- \
  bash -c "grep -aEiq -e '$CONTRACT_RE' '$WS/long-health.split'"

# ── health: a level-30 record. Dropped from the TEXT, before json.loads is even tried ───
assert_green "SR-H-7 WATCH: the chunked level-30 record is dropped -> clean, nothing published" \
  --contains "OK: read" --not-contains "HIT" --not-contains "::error" -- with_file "$WS/long-health.split" pipeline file
assert_exit_code "SR-H-7 WATCH: ...exit 0, not 1" 0 with_file "$WS/long-health.split" pipeline file
assert_green "SR-H-7 WATCH: control, same size and no split -> clean" --contains "OK: read" -- with_file "$WS/long-health.nosplit" pipeline file
assert_green "SR-H-7 DEPLOY: the chunked level-30 record does not fail the deploy" \
  --contains "No permission denied / 42501" --contains "DEPLOY-CONTINUED" -- with_file "$WS/long-health.split" deploy_step file

# ── boom: a REAL level-50 500. Stamps stripped and re-parsed: the genuine error stays, the
#    forged hostname goes ───────────────────────────────────────────────────────────────
assert_red "SR-H-7 WATCH: a chunked level-50 record is re-parsed after stripping the stamp: the GENUINE error survives, the forged contract does not" \
  --contains "0 contract line(s) and 1 other" -- with_file "$WS/long-boom.split" pipeline file
assert_green "SR-H-7 WATCH: ...and nothing was unparsed (the strip-and-reparse worked)" \
  --contains "LOGSCAN_UNPARSED=0" -- with_file "$WS/long-boom.split" remote file
assert_red "SR-H-7 DEPLOY: ...the same record gives exactly ONE hit in the deploy gate (the genuine one), not two" \
  --contains "appeared 1 time(s)" -- with_file "$WS/long-boom.split" deploy_step file

# ── cut: only the first chunk, a level-50 pino record that cannot be parsed at all ───────
assert_green "SR-H-7 WATCH: an unparseable pino-looking record is DROPPED, never kept, and COUNTED (LOGSCAN_UNPARSED=1)" \
  --contains "LOGSCAN_UNPARSED=1" --contains "LOGSCAN_HITS=0" -- with_file "$WS/long-boom.cut" remote file
assert_green "SR-H-7 WATCH: ...so the forged contract text in it cannot page" \
  --contains "OK: read" --not-contains "HIT" -- with_file "$WS/long-boom.cut" pipeline file
assert_green "SR-H-7 WATCH: ...and the discard is VISIBLE in the output (a warning), not merely counted" \
  --contains "::warning::1 pino-looking api log record(s) could not be parsed and were dropped" -- with_file "$WS/long-boom.cut" pipeline file
pipeline_sum() { remote file | GITHUB_STEP_SUMMARY="$SUMF" bash "$GUARD"; }
: >"$SUMF"
with_file "$WS/long-boom.cut" pipeline_sum >/dev/null 2>&1
assert_green "SR-H-7 WATCH: ...and in the run SUMMARY a reader can open" -- grep -q '1 pino-looking record(s) could not be parsed and were dropped' "$SUMF"
assert_green "SR-H-7 DEPLOY: ...and the deploy log says so too, and the deploy is not failed by it" \
  --contains "::warning::1 pino-looking api log record(s) could not be parsed" --contains "DEPLOY-CONTINUED" -- with_file "$WS/long-boom.cut" deploy_step file

# ── the same through the REAL Docker json-file driver, when this machine has one ────────
# A skip is printed as SKIP, never as a pass; the synthetic stamp above always runs.
DOCKER_IMG=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  for c in debian:bookworm-slim alpine:latest busybox:latest ubuntu:24.04; do
    if docker image inspect "$c" >/dev/null 2>&1; then DOCKER_IMG="$c"; break; fi
  done
fi
if [ -n "$DOCKER_IMG" ] && [ -s "$WS/long-health.json" ]; then
  for route in health boom; do
    echo "  docker: throwaway container ($DOCKER_IMG) writes the $route record; reading it back with --timestamps"
    cname="logscan-chunk-$$-$route"
    docker run --name "$cname" -v "$WS:/d:ro" "$DOCKER_IMG" cat "/d/long-$route.json" >/dev/null 2>&1
    docker logs --timestamps "$cname" >"$WS/long-$route.docker" 2>/dev/null
    docker rm -f "$cname" >/dev/null 2>&1
    assert_green "SR-H-7 REAL DOCKER ($route): the json-file driver put a SECOND timestamp inside the record" -- \
      python3 -I -c 'import re,sys;t=open(sys.argv[1]).read();sys.exit(0 if len(re.findall(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z ",t))>=2 else 1)' "$WS/long-$route.docker"
    assert_green "SR-H-7 REAL DOCKER ($route): ...and that record is not valid JSON as delivered" -- not_json "$WS/long-$route.docker"
  done
  assert_green "SR-H-7 REAL DOCKER: the health record, as Docker really delivers it, is dropped by the watch" \
    --contains "OK: read" --not-contains "HIT" -- with_file "$WS/long-health.docker" pipeline file
  assert_green "SR-H-7 REAL DOCKER: ...and does not fail the deploy gate" \
    --contains "DEPLOY-CONTINUED" -- with_file "$WS/long-health.docker" deploy_step file
  assert_red "SR-H-7 REAL DOCKER: the level-50 record as Docker delivers it keeps the genuine error and drops the forged contract" \
    --contains "0 contract line(s) and 1 other" -- with_file "$WS/long-boom.docker" pipeline file
else
  echo "SKIP  SR-H-7 REAL DOCKER: no running docker or no local debian/alpine/busybox/ubuntu image (the synthetic stamp at byte 16384 above still ran)"
fi

# ═══ SR-M-8: the canary. A python3 that exits 0 and prints nothing, or just copies its input,
#     must never turn a genuine hit into "clean" ══════════════════════════════════════════════
pipeline_py() { ( export "$1=1"; pipeline "$2" ); }
deploy_py() { ( export "$1=1"; deploy_step "$2" ); }
assert_red "SR-M-8 WATCH: a python3 that exits 0 with EMPTY output, over a genuine contract hit, is BLIND (not clean)" \
  --contains "req_filter_canary" --not-contains "OK: read" -- pipeline_py FAKE_PYTHON_EMPTY contract
assert_exit_code "SR-M-8 WATCH: ...exit 2, not 0" 2 pipeline_py FAKE_PYTHON_EMPTY contract
assert_red "SR-M-8 WATCH: a python3 that just COPIES its input is BLIND too (the filter did not run)" \
  --contains "req_filter_canary" -- pipeline_py FAKE_PYTHON_CAT contract
assert_red "SR-M-8 DEPLOY: an empty-output python3 fails the deploy instead of passing a genuine hit" \
  --contains "canary check failed" --not-contains "DEPLOY-CONTINUED" -- deploy_py FAKE_PYTHON_EMPTY contract
assert_red "SR-M-8 DEPLOY: a copy-input python3 fails the deploy too" \
  --contains "canary check failed" --not-contains "DEPLOY-CONTINUED" -- deploy_py FAKE_PYTHON_CAT contract
assert_red "SR-M-8 control: the real python3 over the same genuine hit FIRES" \
  --contains "src=contract" -- pipeline contract

# ═══ SR-M-9: the contract token under another logger context is not the contract ═════════
assert_green "SR-M-9 WATCH: db_privilege_denied under a handler context is NOT a hit" \
  --contains "OK: read" --not-contains "HIT" -- pipeline ctx_other
assert_green "SR-M-9 DEPLOY: ...and does not fail the deploy" --contains "DEPLOY-CONTINUED" -- deploy_step ctx_other

# ═══ LOGSCAN_UNPARSED at the checker, and the LAST BEGIN ═══════════════════════════════════
sed '/^LOGSCAN_UNPARSED=/d' "$WS/clean.env" >"$WS/no-unparsed.env"
sed 's/^LOGSCAN_UNPARSED=0$/LOGSCAN_UNPARSED=3/' "$WS/clean.env" >"$WS/unparsed3.env"
assert_red "UNPARSED: an envelope with no LOGSCAN_UNPARSED is BLIND (a remote older than this checker)" \
  --contains "LOGSCAN_UNPARSED" --contains "BLIND" -- run_guard "$WS/no-unparsed.env"
assert_green "UNPARSED: 3 dropped records on a clean scan -> still clean, but the discard is a visible warning" \
  --contains "::warning::3 pino-looking api log record(s) could not be parsed and were dropped" -- run_guard "$WS/unparsed3.env"
run_with_summary "$WS/unparsed3.env"
assert_green "UNPARSED: ...and it is in the summary" -- grep -q '3 pino-looking record(s) could not be parsed and were dropped' "$SUMF"
{ printf 'LOGSCAN_BEGIN\nLOGSCAN_API_CONTAINERS=1\nLOGSCAN_CONTAINER=crm-api-1\nLOGSCAN_LINES=9\nLOGSCAN_HITS=0\nLOGSCAN_CONTRACT_HITS=0\nLOGSCAN_UNPARSED=0\nLOGSCAN_END\n'; cat "$WS/hit.env"; } >"$WS/decoy-frame.env"
assert_red "DECOY FRAME: a forged CLEAN frame printed BEFORE the real one cannot hide a hit: ambiguous, BLIND" --contains "ambiguous" -- run_guard "$WS/decoy-frame.env"
assert_exit_code "DECOY FRAME: ...exit 2, not 0" 2 run_guard "$WS/decoy-frame.env"

# The two copies of the filter must be the same program.
extract_filter() { sed -n '/^# --- BEGIN LOGSCAN_REQ_FILTER/,/^# --- END LOGSCAN_REQ_FILTER/p' "$1"; }
extract_filter "$REMOTE_SH" >"$WS/filter.remote"
extract_filter "$DEPLOY_SCRIPT" >"$WS/filter.deploy"
assert_green "SR-H-5 no drift: the request-log filter in the remote script == the one in the deploy script" -- \
  bash -c "[ -s '$WS/filter.remote' ] && diff '$WS/filter.remote' '$WS/filter.deploy'"

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
echo " * docs mention new Logger(Class.name) and // new Logger(CommentedOutService.name)" >"$FR/apps/api/src/svc/docs.ts"
echo "// const l = new Logger(CommentedOutService.name)" >>"$FR/apps/api/src/svc/docs.ts"
assert_green "loggers: a name that only appears in a comment or docstring is NOT listed (the old 'Class')" \
  --not-contains "Class" --not-contains "CommentedOutService" -- derive_fake
assert_green "loggers: the real tree no longer lists 'Class'" -- \
  bash -c "! printf '%s\n' '$LOGSCAN_LOGGERS' | tr ' ' '\n' | grep -qx Class"

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

# ═══ 5. THE SEAM: the driver between the producer (ssh) and the checker ═════════
# Fix round 1 (SR-H-1). Everything above feeds the checker output that THIS FILE built.
# That is how the first design shipped permanently blind: appleboy/ssh-action prints a
# banner and writes its capture twice, the checker rightly refused both, and 58 green
# tests never saw it, because a test that constructs its own input cannot discover what
# the real producer emits. So this section drives scan-api-permission-denied.sh itself:
#  5a  always on: the real driver with `ssh` replaced by a stand-in (argv, key mode,
#      stderr noise, failure), the real remote script, the fake docker;
#  5b  when an sshd exists on this machine: the SAME driver over a REAL ssh connection to
#      a throwaway sshd, so the bytes in the pipe are ssh's own. If sshd is unavailable
#      the section prints SKIP (never PASS) and 5a still runs.

mkdir -p "$WS/sshshim"
cat >"$WS/sshshim/ssh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for ssh (tests only): records argv and the key file's mode, writes noise to
# stderr the way ssh does, optionally fails, otherwise runs the payload on stdin locally.
printf '%s\n' "$@" >"$SHIM_ARGS_FILE"
key=""; prev=""
for a in "$@"; do [ "$prev" = "-i" ] && key="$a"; prev="$a"; done
{ [ -f "$key" ] && [ -n "$(find "$key" -perm 600 2>/dev/null)" ] && echo "KEY_MODE_600"; echo "KEY_PATH=$key"; } >>"$SHIM_ARGS_FILE"
echo "Warning: Permanently added 'vps.example.test' to the list of known hosts." >&2
[ "${SHIM_SSH_FAIL:-}" = 1 ] && exit 255
exec bash -s
EOF
chmod +x "$WS/sshshim/ssh"
printf '%s\n' '#!/usr/bin/env bash' 'echo "vps.example.test ssh-ed25519 AAAAFAKEHOSTKEY"' >"$WS/sshshim/ssh-keyscan"
chmod +x "$WS/sshshim/ssh-keyscan"

scan() { # <docker-mode> [env args...]
  local mode="$1"; shift
  rm -f "$WS/ssh-args.txt"
  env -u GITHUB_STEP_SUMMARY PATH="$WS/sshshim:$WS/bin:$PATH" FAKE_DOCKER_MODE="$mode" LOGSCAN_CRM_DIR="$WS" \
    VPS_HOST=vps.example.test VPS_USER=deploy VPS_SSH_KEY="FAKE-KEY-CONTENT-NOT-A-KEY" \
    LOGSCAN_RE="$RE" LOGSCAN_CONTRACT_RE="$CONTRACT_RE" LOGSCAN_SINCE=40m SHIM_ARGS_FILE="$WS/ssh-args.txt" \
    "$@" bash "$SCAN_SH"
}

assert_green "SEAM 5a: clean scan through the real driver exits 0 and says what it read" \
  --contains "OK: read under 100 API log line(s)" -- scan clean
assert_exit_code "SEAM 5a: clean exits 0" 0 scan clean
assert_red "SEAM 5a: a 42501 through the real driver FIRES, with the real timestamp from the compose-prefixed line" \
  --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=VacanciesRetentionCronService object=table:vacancy_applications" \
  -- scan hit
assert_exit_code "SEAM 5a: a hit exits 1" 1 scan hit
assert_red "SEAM 5a: PII / SQL / injection in the production log reaches NO sink of the driver (stdout+stderr)" \
  --contains "HIT time=" --not-contains "jane.doe" --not-contains "380501234567" --not-contains "INJECTED" \
  --not-contains "SECRETVALUE" --not-contains "DELETE FROM" -- scan hostile
assert_green "SEAM 5a: ssh's stderr noise reaches the job log but NOT the checker (clean stays clean)" \
  --contains "Permanently added" --contains "OK: read" -- scan clean
assert_exit_code "SEAM 5a: ssh failing (255) is BLIND, exit 2, never 0" 2 scan clean SHIM_SSH_FAIL=1
assert_red "SEAM 5a: the api container missing is BLIND through the driver too" --contains "no running api container" -- scan nocontainer
assert_red "SEAM 5a: a failing docker logs is BLIND through the driver" --contains "compose_logs" -- scan fail

assert_exit_code "SEAM 5a: an empty secret is refused (exit 2) before any ssh" 2 scan clean VPS_SSH_KEY=
assert_red "SEAM 5a: a hostile VPS_HOST (option injection) is refused and ssh is never run" \
  --contains "VPS_HOST has an unexpected shape" -- scan clean "VPS_HOST=-oProxyCommand=touch_pwned"
assert_green "SEAM 5a: ...and the stand-in ssh was indeed never invoked for it" -- \
  bash -c "scan_out=0; [ ! -e '$WS/ssh-args.txt' ]"
scan clean >/dev/null 2>&1
assert_green "SEAM 5a: the key reached ssh in a 0600 file, passed with -i, never on the command line" -- \
  bash -c "grep -qx KEY_MODE_600 '$WS/ssh-args.txt' && grep -qx -e '-i' '$WS/ssh-args.txt' && ! grep -q 'FAKE-KEY-CONTENT' '$WS/ssh-args.txt'"
assert_green "SEAM 5a: ...and the key file is gone after the driver exits" -- \
  bash -c "p=\$(sed -n 's/^KEY_PATH=//p' '$WS/ssh-args.txt'); [ -n \"\$p\" ] && [ ! -e \"\$p\" ]"
assert_green "SEAM 5a: host key is verified (StrictHostKeyChecking=yes), no agent or password fallback" -- \
  bash -c "grep -qx 'StrictHostKeyChecking=yes' '$WS/ssh-args.txt' && grep -qx 'BatchMode=yes' '$WS/ssh-args.txt'"
assert_green "SEAM 5a: without VPS_KNOWN_HOSTS the unverified-host-key exposure is announced, not silent" \
  --contains "::warning::VPS_KNOWN_HOSTS is not set" -- scan clean
assert_green "SEAM 5a: with VPS_KNOWN_HOSTS pinned there is no such warning" \
  --not-contains "VPS_KNOWN_HOSTS is not set" -- scan clean "VPS_KNOWN_HOSTS=vps.example.test ssh-ed25519 AAAAFAKEHOSTKEY"

# The remote script fails closed on missing allowlists instead of dying mid-loop (a LOW).
remote_no_lists() { ( PATH="$WS/bin:$PATH" FAKE_DOCKER_MODE=hit LOGSCAN_CRM_DIR="$WS" LOGSCAN_RE="$RE" LOGSCAN_CONTRACT_RE="$CONTRACT_RE" LOGSCAN_SINCE=40m LOGSCAN_TABLES= LOGSCAN_LOGGERS= bash "$REMOTE_SH" ) | env -u GITHUB_STEP_SUMMARY bash "$GUARD"; }
assert_red "remote script with empty allowlists reports LOGSCAN_FAILED and the run is BLIND, not a silent half-hit" \
  --contains "inputs_missing" -- remote_no_lists

# The workflow must call the driver and hand it everything the driver requires.
assert_green "WIRING: the workflow uses no third-party ssh action" -- bash -c "! grep -q 'uses: appleboy' '$WORKFLOW'"
assert_green "WIRING: the workflow's last step runs the driver" -- \
  bash -c "grep -q 'run: scripts/devops/scan-api-permission-denied.sh' '$WORKFLOW'"
required_vars="$(sed -n 's/^for v in \(.*\); do$/\1/p' "$SCAN_SH" | head -n 1)"
missing_wiring=""
for v in $required_vars; do
  grep -q "^          $v: \${{" "$WORKFLOW" || missing_wiring="$missing_wiring $v"
done
if [ -n "$required_vars" ] && [ -z "$missing_wiring" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  WIRING: every variable the driver requires (%s) is set by the workflow step\n' "$required_vars"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  WIRING: driver requires [%s]; the workflow does not set:%s\n' "$required_vars" "$missing_wiring"
fi

# ── 5b: the same driver over a REAL ssh connection ────────────────────────────
SSHD_BIN=""
for c in /usr/sbin/sshd /usr/local/sbin/sshd; do [ -x "$c" ] && SSHD_BIN="$c" && break; done
SSHD_PID=""
trap '[ -z "$SSHD_PID" ] || kill "$SSHD_PID" 2>/dev/null; rm -rf "$WS"' EXIT
if [ -n "$SSHD_BIN" ] && command -v ssh-keygen >/dev/null 2>&1; then
  SD="$WS/sshd"; mkdir -p "$SD"
  ssh-keygen -q -t ed25519 -N '' -f "$SD/hostkey" && ssh-keygen -q -t ed25519 -N '' -f "$SD/clientkey" \
    && ssh-keygen -q -t ed25519 -N '' -f "$SD/otherhostkey"
  cp "$SD/clientkey.pub" "$SD/authorized_keys"; chmod 600 "$SD/authorized_keys"
  SSHD_PORT="$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
  # ForceCommand is how the fake docker and the mode reach the session; it also models
  # the owner's possible future restricted key (a forced command ignores the client's).
  cat >"$SD/wrap.sh" <<WRAP
#!/usr/bin/env bash
export PATH="$WS/bin:\$PATH" FAKE_DOCKER_MODE="\$(cat "$SD/mode")" LOGSCAN_CRM_DIR="$WS"
[ -f "$SD/noise" ] && export BASH_ENV="$SD/benv"
exec bash -c "\$SSH_ORIGINAL_COMMAND"
WRAP
  # A REAL shell startup file: bash reads \$BASH_ENV for every non-interactive shell, which
  # is how a login shell's rc output reaches the session's stdout BEFORE our script runs
  # (SR-M-6). ForceCommand bypasses the user's login shell, so this is how the test gets
  # the same effect through a mechanism the shell itself provides.
  printf '%s\n' 'if [ -z "${BENV_DONE:-}" ]; then export BENV_DONE=1; echo "Welcome to the VPS (rc file output)"; echo "second rc line"; fi' >"$SD/benv"
  chmod +x "$SD/wrap.sh"
  cat >"$SD/sshd_config" <<CONF
Port $SSHD_PORT
ListenAddress 127.0.0.1
HostKey $SD/hostkey
PidFile $SD/sshd.pid
AuthorizedKeysFile $SD/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PermitUserEnvironment no
ForceCommand $SD/wrap.sh
LogLevel ERROR
CONF
  echo clean >"$SD/mode"
  "$SSHD_BIN" -f "$SD/sshd_config" -D -e >"$SD/sshd.log" 2>&1 &
  SSHD_PID=$!
  up=0
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ssh-keyscan -T 2 -p "$SSHD_PORT" 127.0.0.1 2>/dev/null | grep -q ed25519; then up=1; break; fi
    echo "  sshd: waiting for the throwaway server ($i/20)"
    sleep 0.5
  done
  if [ "$up" = 1 ]; then
    KH="[127.0.0.1]:$SSHD_PORT $(cut -d' ' -f1,2 "$SD/hostkey.pub")"
    OTHER_KH="[127.0.0.1]:$SSHD_PORT $(cut -d' ' -f1,2 "$SD/otherhostkey.pub")"
    real() { # <mode> [env args...]
      local mode="$1"; shift
      echo "$mode" >"$SD/mode"
      env -u GITHUB_STEP_SUMMARY VPS_HOST=127.0.0.1 SSH_PORT="$SSHD_PORT" VPS_USER="$(id -un)" VPS_SSH_KEY="$(cat "$SD/clientkey")" \
        VPS_KNOWN_HOSTS="$KH" LOGSCAN_RE="$RE" LOGSCAN_CONTRACT_RE="$CONTRACT_RE" LOGSCAN_SINCE=40m "$@" bash "$SCAN_SH"
    }
    assert_green "SEAM 5b REAL ssh: clean scan exits 0" --contains "OK: read under 100 API log line(s)" -- real clean
    assert_red "SEAM 5b REAL ssh: a 42501 FIRES with its real timestamp" \
      --contains "HIT time=2026-10-19T03:00:02.123456789Z logger=VacanciesRetentionCronService object=table:vacancy_applications" -- real hit
    assert_exit_code "SEAM 5b REAL ssh: a hit exits 1" 1 real hit
    assert_red "SEAM 5b REAL ssh: hostile production text reaches no sink" \
      --contains "HIT time=" --not-contains "jane.doe" --not-contains "INJECTED" --not-contains "SECRETVALUE" -- real hostile
    assert_exit_code "SEAM 5b REAL ssh: a pinned host key that does NOT match is refused (BLIND), not trusted" 2 real clean "VPS_KNOWN_HOSTS=$OTHER_KH"

    # What the real producer emits, byte for byte: only our lines, each exactly once.
    echo hit >"$SD/mode"
    { printf 'export LOGSCAN_RE=%q\nexport LOGSCAN_CONTRACT_RE=%q\nexport LOGSCAN_SINCE=40m\nexport LOGSCAN_TABLES=%q\nexport LOGSCAN_LOGGERS=%q\n' "$RE" "$CONTRACT_RE" "$LOGSCAN_TABLES" "$LOGSCAN_LOGGERS"; cat "$REMOTE_SH"; } >"$SD/payload.sh"
    ssh -i "$SD/clientkey" -p "$SSHD_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$(id -un)@127.0.0.1" 'bash -s' <"$SD/payload.sh" >"$SD/raw.out" 2>"$SD/raw.err"
    # SR-M-6 over a real ssh: shell rc output precedes our frame. First prove the noise is
    # REALLY on the wire, then that the verdict survives it.
    touch "$SD/noise"
    echo hit >"$SD/mode"
    ssh -i "$SD/clientkey" -p "$SSHD_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$(id -un)@127.0.0.1" 'bash -s' <"$SD/payload.sh" >"$SD/noisy.out" 2>/dev/null
    assert_green "SEAM 5b REAL ssh: with a shell rc file the first bytes on the wire are NOT our frame (the repro is real)" -- \
      bash -c "head -n1 '$SD/noisy.out' | grep -q 'Welcome to the VPS'"
    assert_red "SEAM 5b REAL ssh: ...yet a hit still FIRES (exit 1, not BLIND), noise counted and not shown" \
      --contains "HIT time=2026-10-19T03:00:02.123456789Z" --contains "discarded" --not-contains "Welcome" -- real hit
    assert_exit_code "SEAM 5b REAL ssh: ...exit 1" 1 real hit
    assert_green "SEAM 5b REAL ssh: ...and a clean scan with the same rc noise exits 0" --contains "OK: read" -- real clean
    rm -f "$SD/noise"
    assert_green "SEAM 5b REAL ssh: raw stdout is exactly the envelope (starts/ends right, nothing else)" -- \
      bash -c "[ \"\$(head -n1 '$SD/raw.out')\" = LOGSCAN_BEGIN ] && [ \"\$(tail -n1 '$SD/raw.out')\" = LOGSCAN_END ] && ! grep -qv '^LOGSCAN_' '$SD/raw.out'"
    assert_green "SEAM 5b REAL ssh: ...with no line written twice (the ssh-action doubling cannot recur)" -- \
      bash -c "[ -z \"\$(sort '$SD/raw.out' | uniq -d)\" ]"
    assert_green "SEAM 5b REAL ssh: ...and the remote wrote nothing to stderr" -- bash -c "[ ! -s '$SD/raw.err' ]"
  else
    echo "SKIP  SEAM 5b REAL ssh: the throwaway sshd did not come up on this machine (5a still ran):"
    head -n 3 "$SD/sshd.log" | sed 's/^/        /'
  fi
else
  echo "SKIP  SEAM 5b REAL ssh: no sshd on this machine (5a, the stand-in seam, still ran)"
fi

guard_test_summary "test-check-api-permission-denied.sh"
