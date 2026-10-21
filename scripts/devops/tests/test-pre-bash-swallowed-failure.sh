#!/usr/bin/env bash
# test-pre-bash-swallowed-failure.sh — proves .claude/hooks/pre-bash-swallowed-failure.sh
# SPEAKS on a discarded stderr feeding a counter, and STAYS SILENT on the
# legitimate look-alikes, in both directions.
#
# WHY THE NEGATIVE CONTROL HERE IS `assert_red_signal` AND NOT `assert_red`.
# This hook is ADVISORY: it never refuses, so its "red" is a MESSAGE, not an
# exit code. `assert_red_signal` is the harness expectation for exactly that —
# exit 0 PLUS a required substring — and `check-guard-tests-exist.sh` counts it
# as a negative assertion. Using `assert_red` would be a lie about the contract
# and would fail every case.
#
# THE SILENT DIRECTION IS THE LOAD-BEARING HALF. An advisory that fires on
# everything is deleted within a day, so every `assert_green --not-contains`
# below is a claim that a real, frequent command stays quiet. Two of them are
# not hypothetical:
#   - the readiness probe is the ONE legitimate occurrence of this conjunction
#     in this repository (an ssh-keyscan retried until a service answers); it is
#     why this hook does not refuse, and it must never be noisy;
#   - the quoted-delimiter heredoc is the false-positive class that the launcher
#     gates produced four times in one day before they were narrowed. It costs
#     nothing here because lib/cmdscan.py already excludes such a body from code.
#
# A GATE PROVEN ONLY BY FIRING IS THE DEFECT THIS HOOK IS ABOUT, one level up —
# so this file asserts both sides of every predicate.
#
# Nothing here executes any command under test: each is handed to the hook as
# the text of a tool call, which is exactly what it sees in production.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-swallowed-failure.sh"

echo "== test-pre-bash-swallowed-failure.sh =="
echo

# A syntax error in the hook would make every case "pass" silently, because the
# EXIT trap converts any non-zero exit to 0 and prints nothing this file greps
# for. So the file fails loudly here first.
if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

run_hook() {
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1")
  printf '%s' "$json" | bash "$HOOK"
}

# `git` is assembled so that this test file does not itself contain the shapes
# it asserts about — a grep over the repo for the defect should find the hook and
# the rule, not its own test fixtures.
G="g""it"

# ── SWALLOWED-COUNT: the note must fire ──────────────────────────────────────

assert_red_signal "instance 5 shape: a named-object read, stderr discarded, into grep -c" \
  --contains "SWALLOWED-COUNT" \
  --contains "nothing was read" \
  -- run_hook "$G show \$REV:apps/x.ts 2>/dev/null | grep -c foo"

assert_red_signal "the live defect in our own push gate: discarded git log into wc -w" \
  --contains "SWALLOWED-COUNT" \
  --contains "wc -w" \
  -- run_hook "PARENTS=\$($G log -1 --pretty=%P 2>/dev/null | wc -w | tr -d ' ')"

# `grep -qE` is the exact form the first (wrong) measurement of this class
# missed, because its regex required the flag cluster to END in c or q.
assert_red_signal "grep -qE: a flag cluster that does not end in q" \
  --contains "SWALLOWED-COUNT" \
  -- run_hook "$G cat-file -p \${R}:a 2>/dev/null | grep -qE 'sym'"

assert_red_signal "a plain file read discarded into wc -l" \
  --contains "SWALLOWED-COUNT" \
  -- run_hook "cat some/file 2>/dev/null | wc -l"

assert_red_signal "an intermediate stage does not hide the counter" \
  --contains "SWALLOWED-COUNT" \
  -- run_hook "$G show \${R}:a 2>/dev/null | sed -n '1,5p' | grep -c sym"

# ── ZSH-REVSPEC: the note must fire, discard or not ──────────────────────────

assert_red_signal "unbraced \$VAR: in a revspec, reported without any discard" \
  --contains "ZSH-REVSPEC" \
  --contains "Quoting does NOT help" \
  -- run_hook "$G show \$REV:apps/x.ts | grep -c foo"

assert_red_signal "both predicates on one command report both" \
  --contains "SWALLOWED-COUNT" \
  --contains "ZSH-REVSPEC" \
  -- run_hook "$G show \$REV:apps/x.ts 2>/dev/null | grep -c foo"

# ── THE SILENT DIRECTION: legitimate look-alikes must stay quiet ─────────────

# The one legitimate occurrence of the conjunction in this repository. A probe
# EXPECTS its producer to fail while a service comes up; the discard is correct.
assert_green "readiness probe (ssh-keyscan) stays silent" \
  --not-contains "SWALLOWED-COUNT" \
  --not-contains "ADVISORY" \
  -- run_hook "ssh-keyscan -T 2 -p 2222 127.0.0.1 2>/dev/null | grep -q ed25519"

assert_green "readiness probe (curl) stays silent" \
  --not-contains "ADVISORY" \
  -- run_hook "curl -s http://127.0.0.1:3001/health 2>/dev/null | grep -q ok"

assert_green "a braced revspec with no discard is the correct form and is silent" \
  --not-contains "ADVISORY" \
  -- run_hook "$G show \${REV}:apps/x.ts | grep -c foo"

# The false-positive class that cost the launcher gates four refusals in a day.
assert_green "the shape spelled inside a quoted-delimiter heredoc is data, not code" \
  --not-contains "ADVISORY" \
  -- run_hook "cat > note.md <<'EOF'
$G show a:b 2>/dev/null | grep -c x
EOF"

assert_green "a discard into a plain filter (not a counter) is out of scope and silent" \
  --not-contains "ADVISORY" \
  -- run_hook "cat f 2>/dev/null | grep -i vary"

assert_green "a discard with no pipe at all is silent" \
  --not-contains "ADVISORY" \
  -- run_hook "$G show \${R}:a 2>/dev/null"

assert_green "a counter with no discard is silent" \
  --not-contains "ADVISORY" \
  -- run_hook "$G show \${R}:a | grep -c sym"

# A reader in one statement must not pair with a counter in the NEXT one; that
# is what the forward cursor in the hook exists for.
assert_green "a discarded read and a counter in separate statements do not pair" \
  --not-contains "SWALLOWED-COUNT" \
  -- run_hook "cat a 2>/dev/null > /tmp/x; ls /tmp | wc -l"

# ── the hook must never refuse, whatever it says ─────────────────────────────

assert_green "exit code is 0 even when both predicates fire (advisory contract)" \
  --contains "ADVISORY" \
  -- run_hook "$G show \$REV:a 2>/dev/null | grep -c x"

guard_test_summary "test-pre-bash-swallowed-failure.sh"
