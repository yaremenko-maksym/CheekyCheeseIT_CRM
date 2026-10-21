#!/usr/bin/env bash
# test-pre-bash-swallowed-failure.sh — proves .claude/hooks/pre-bash-swallowed-failure.sh
# DELIVERS its note to the model on the shapes it exists for, and DELIVERS NOTHING
# on the legitimate look-alikes.
#
# ── WHAT IS ASSERTED IS DELIVERY, NOT PRINTING (CR-H-1 on this PR) ───────────
#
# The first version of this file asserted the hook's STDERR. That proved the note
# was written and nothing about anyone receiving it — and for a PreToolUse hook
# that exits 0, stderr does NOT reach the model (stderr is surfaced on a refusal,
# which this hook never issues). So the advisory was an instrument reporting into
# a channel nobody reads: this rule's own defect, shipped inside the rule, and
# passing a green test.
#
# `run_hook` below therefore prints ONLY what the model would actually receive:
# it parses the hook's stdout as JSON and extracts
# `hookSpecificOutput.additionalContext`. If the note ever moves back to stderr,
# or the JSON stops parsing, every firing case below goes red — which is the pin
# the review asked for, as opposed to one that fails when a string stops being
# printed.
#
# Each case also asserts `RC=0` (this hook must never refuse) and `STDERR-EMPTY`.
# The second one matters more than it looks: without it, a hook that CRASHED
# would deliver nothing, and every silence case would pass for the worst possible
# reason. Every silence case therefore asserts a POSITIVE token
# (`NOTHING-DELIVERED`), never the mere absence of output.
#
# ── WHICH MUTATION REDDENS WHICH CASE — MEASURED, NOT ASSERTED (CR-M-3) ──────
#
# A single "force both predicates true" mutation does NOT redden all the silence
# cases, and presenting eight cases as eight proofs when they are not is this
# file's own version of the defect it tests for. So each silence case is tagged
# with the mechanism that silences it, and the tag was established BY RUNNING a
# mutation, not by reading the hook. The measured matrix:
#
#   MUTATION                              CASES IT REDDENS
#   M0 note written to stderr instead     all 10 firing cases  <- the delivery pin
#      of hookSpecificOutput/stdout
#   M1 is_reader/is_counter forced true   the 3 [PREDICATE] cases
#   M2 pre-filter deleted                 NOTHING
#   M4 discard requirement dropped        NOTHING
#   M6 pre-filter AND discard dropped     the 2 [DOUBLY-SILENCED] cases
#   M3 statement split removed            the separate-statements case
#   M7 stage-count guard + counter list   both [STRUCTURE] cases
#
# TWO RESULTS HERE CORRECT WHAT BOTH I AND THE REVIEW BELIEVED. The two
# "no discard, braced" cases were called pre-filter artifacts, and the review
# said removing the pre-filter would redden them. **It does not** (M2: nothing),
# and neither does removing the discard requirement alone (M4: nothing). They are
# DOUBLY SILENCED — the cheap grep and the predicate each reject them
# independently — so only M6, removing both, reddens them. Each is therefore a
# real assertion with a redundant guard in front of it, not a case riding a
# pre-filter.
#
# ONE CASE IS NOT REDDENED BY ANY MUTATION OF THIS HOOK, and that is stated
# rather than hidden: the [ANALYZER] heredoc case is silenced inside
# lib/cmdscan.py, which excludes a quoted-delimiter body from code. Reddening it
# means mutating the analyzer, not this hook. It is kept because the property is
# worth pinning from this side too, and the analyzer's own corpus pins it from
# the other.
#
# Nothing here executes any command under test: each is handed to the hook as the
# text of a tool call, which is exactly what it sees in production.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-swallowed-failure.sh"

echo "== test-pre-bash-swallowed-failure.sh =="
echo

# A syntax error in the hook would make every silence case "pass": the EXIT trap
# converts any non-zero exit to 0 and nothing would be delivered. The STDERR-EMPTY
# assertions catch that, and this check catches it one step earlier and louder.
if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

# Prints the model's-eye view of one tool call:
#   RC=<exit code> / STDERR-EMPTY|STDERR-NONEMPTY / DELIVERED: + text, or NOTHING-DELIVERED
run_hook() {
  local json out rc errfile
  json=$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1")
  errfile=$(mktemp)
  out=$(printf '%s' "$json" | bash "$HOOK" 2>"$errfile")
  rc=$?
  echo "RC=$rc"
  if [ -s "$errfile" ]; then
    echo "STDERR-NONEMPTY"
    cat "$errfile"
  else
    echo "STDERR-EMPTY"
  fi
  rm -f "$errfile"
  printf '%s' "$out" | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    print("NOTHING-DELIVERED")
    sys.exit(0)
try:
    ctx = json.loads(raw)["hookSpecificOutput"]["additionalContext"]
except Exception:
    print("UNPARSEABLE-HOOK-STDOUT")
    sys.exit(0)
print("DELIVERED:")
print(ctx)
'
}

# `git` is assembled so this file does not itself contain the shapes it asserts
# about: a sweep of the repo for the defect should find the hook and the rule, not
# these fixtures.
G="g""it"

# ── SWALLOWED-COUNT: the note must REACH THE MODEL ───────────────────────────

assert_red_signal "instance 5 shape: named-object read, stderr discarded, into grep -c" \
  --contains "RC=0" --contains "STDERR-EMPTY" --contains "DELIVERED:" \
  --contains "SWALLOWED-COUNT" --contains "nothing was read" \
  -- run_hook "$G show \$REV:apps/x.ts 2>/dev/null | grep -c foo"

# CR-M-2: the form this project actively teaches, because agents work in
# worktrees. It was silent until `-C` stopped being read as the subcommand.
assert_red_signal "git -C <dir> show (the form this repo teaches) is NOT missed" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" \
  -- run_hook "$G -C /some/worktree show \${R}:a 2>/dev/null | grep -c sym"

assert_red_signal "git -c key=value also keeps its subcommand visible" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" \
  -- run_hook "$G -c core.pager=cat show \${R}:a 2>/dev/null | wc -l"

assert_red_signal "git --git-dir=<path> likewise" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" \
  -- run_hook "$G --git-dir=/x/.git show \${R}:a 2>/dev/null | grep -q sym"

assert_red_signal "the live defect in our own push gate: discarded git log into wc -w" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" --contains "wc -w" \
  -- run_hook "PARENTS=\$($G log -1 --pretty=%P 2>/dev/null | wc -w | tr -d ' ')"

# The exact form the first (wrong) measurement of this class missed, because its
# regex required the flag cluster to END in c or q.
assert_red_signal "grep -qE: a flag cluster that does not end in q" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" \
  -- run_hook "$G cat-file -p \${R}:a 2>/dev/null | grep -qE 'sym'"

assert_red_signal "a plain file read discarded into wc -l" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" \
  -- run_hook "cat some/file 2>/dev/null | wc -l"

assert_red_signal "an intermediate stage does not hide the counter" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" \
  -- run_hook "$G show \${R}:a 2>/dev/null | sed -n '1,5p' | grep -c sym"

# ── ZSH-REVSPEC ──────────────────────────────────────────────────────────────

assert_red_signal "unbraced \$VAR: in a revspec, delivered without any discard" \
  --contains "DELIVERED:" --contains "ZSH-REVSPEC" --contains "Quoting does NOT help" \
  -- run_hook "$G show \$REV:apps/x.ts | grep -c foo"

assert_red_signal "both predicates on one command deliver both" \
  --contains "DELIVERED:" --contains "SWALLOWED-COUNT" --contains "ZSH-REVSPEC" \
  -- run_hook "$G show \$REV:apps/x.ts 2>/dev/null | grep -c foo"

# ── NOTHING MAY BE DELIVERED for the legitimate look-alikes ──────────────────

# [PREDICATE] The one legitimate occurrence of this conjunction in the repo. A
# probe EXPECTS its producer to fail while a service boots; the discard is right.
assert_green "[PREDICATE] readiness probe (ssh-keyscan) delivers nothing" \
  --contains "RC=0" --contains "STDERR-EMPTY" --contains "NOTHING-DELIVERED" \
  -- run_hook "ssh-keyscan -T 2 -p 2222 127.0.0.1 2>/dev/null | grep -q ed25519"

assert_green "[PREDICATE] readiness probe (curl) delivers nothing" \
  --contains "NOTHING-DELIVERED" --contains "STDERR-EMPTY" \
  -- run_hook "curl -s http://127.0.0.1:3001/health 2>/dev/null | grep -q ok"

assert_green "[PREDICATE] a discard into a plain filter, not a counter, delivers nothing" \
  --contains "NOTHING-DELIVERED" --contains "STDERR-EMPTY" \
  -- run_hook "cat f 2>/dev/null | grep -i vary"

# [ANALYZER] The false-positive class that cost the launcher gates four refusals
# in one day. Free here: cmdscan excludes a quoted-delimiter heredoc body.
assert_green "[ANALYZER] the shape spelled inside a quoted heredoc is data, not code" \
  --contains "NOTHING-DELIVERED" --contains "STDERR-EMPTY" \
  -- run_hook "cat > note.md <<'EOF'
$G show a:b 2>/dev/null | grep -c x
EOF"

# [STRUCTURE] No pipe at all, and a reader/counter split across statements.
assert_green "[STRUCTURE] a discard with no pipe delivers nothing" \
  --contains "NOTHING-DELIVERED" --contains "STDERR-EMPTY" \
  -- run_hook "$G show \${R}:a 2>/dev/null"

assert_green "[STRUCTURE] a discarded read and a counter in separate statements do not pair" \
  --contains "NOTHING-DELIVERED" --contains "STDERR-EMPTY" \
  -- run_hook "cat a 2>/dev/null > /tmp/x; ls /tmp | wc -l"

# [DOUBLY-SILENCED] The cheap grep AND the discard predicate each reject these
# independently (measured: M2 alone reddens nothing, M4 alone reddens nothing,
# M6 removing both reddens exactly these two). So they are genuine assertions
# behind a redundant guard, not cases riding the pre-filter.
assert_green "[DOUBLY-SILENCED] braced revspec, no discard: the correct form delivers nothing" \
  --contains "NOTHING-DELIVERED" --contains "STDERR-EMPTY" \
  -- run_hook "$G show \${REV}:apps/x.ts | grep -c foo"

assert_green "[DOUBLY-SILENCED] a counter with no discard delivers nothing" \
  --contains "NOTHING-DELIVERED" --contains "STDERR-EMPTY" \
  -- run_hook "$G show \${R}:a | grep -c sym"

guard_test_summary "test-pre-bash-swallowed-failure.sh"
