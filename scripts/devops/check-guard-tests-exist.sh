#!/usr/bin/env bash
# check-guard-tests-exist.sh — meta-guard (task-guards-teeth, 2026-08-07).
#
# WHY: on 2026-08-07 this repo had nine check-* guards standing between it and
# production and zero tests for any of them. One of the nine
# (check-prod-ddl-wiring.py) turned out to be satisfiable by a COMMENT — it had
# been decorative since the day it was written, in direct response to a real prod
# outage. Writing tests for all nine fixes today. This script is what stops the
# tenth guard from arriving untested next month, which is the only reason today's
# fix means anything a year from now.
#
# WHAT IT REQUIRES, for every scripts/devops/check-*.{sh,py,mjs}:
#   1. A test file exists at scripts/devops/tests/test-<basename>.sh.
#   2. That test contains at least one NEGATIVE assertion (`assert_red` or
#      `assert_red_signal` from tests/lib/harness.sh).
#
# Requirement 2 is the whole point. "A test exists" is satisfied by `touch`, and
# a test that only asserts the guard stays quiet on good input is satisfied by a
# guard whose body is `exit 0` — which is exactly the disease being treated one
# level up. A guard is only worth having if someone has watched it go red.
#
# WHY THE ANCHOR (review round 2, H2). The first version grepped for the helper
# name anywhere in the file. A reviewer deleted all seven real negative calls
# from test-check-backup-freshness.sh, left only its header — which mentions
# `assert_red` twice while EXPLAINING the rule — and this script reported "10
# guarded, 0 unguarded". So the meta-guard was satisfiable by a comment: exactly
# the defect it was written to stop, reproduced inside the thing meant to stop
# it. The pattern is now anchored to the start of a line, so prose about the
# helper is not the helper.
#
# I had documented a limitation here ("`assert_red \"x\" -- false` would satisfy
# it") which was true but drew the line in the wrong place — the real hole was
# that no call had to exist at all. Keeping the note is worth more than deleting
# it: a stated boundary is only as good as the check under it.
#
# REMAINING LIMITATION, still true: this checks that a negative assertion is
# PRESENT and is a real call, not that it is MEANINGFUL. `assert_red "x" -- false`
# passes. That is a deliberate stopping point — a check strong enough to judge
# meaningfulness is a code reviewer, not a grep. What this closes is the gap that
# actually occurred (a guard with no test; a test with no red case; a test whose
# only "red case" is prose), not every way to write a bad test on purpose.
#
# Self-referential on purpose: this script is itself a check-*, so it must have
# its own test with its own negative case, and it does
# (scripts/devops/tests/test-check-guard-tests-exist.sh). If it ever stops
# holding itself to its own rule, it fails itself.
#
# Usage:
#   scripts/devops/check-guard-tests-exist.sh                 # this repo
#   scripts/devops/check-guard-tests-exist.sh <guards_dir> <tests_dir>
#
# The two-argument form exists ONLY so the meta-guard's own test can point it at
# fixture directories. It changes what is inspected, never how strictly.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GUARDS_DIR="${1:-$SCRIPT_DIR}"
TESTS_DIR="${2:-$SCRIPT_DIR/tests}"

# The helper names from tests/lib/harness.sh that denote a negative case.
# Anchored to line start (leading whitespace allowed) so that only an actual
# CALL counts — a mention inside a comment or a string does not. `assert_red`
# without a `$` suffix so `assert_red_signal` (the stdout-contract variant, for
# check-backup-freshness.sh) counts too. See the H2 note in the header.
NEGATIVE_ASSERTION_RE='^[[:space:]]*assert_red'

PASS=0
FAIL=0

echo "== check-guard-tests-exist.sh =="
echo "   guards: $GUARDS_DIR"
echo "   tests:  $TESTS_DIR"
echo

MISSING_TEST=""
NO_NEGATIVE=""
GUARD_COUNT=0

for guard_path in "$GUARDS_DIR"/check-*.sh "$GUARDS_DIR"/check-*.py "$GUARDS_DIR"/check-*.mjs; do
  # Unmatched globs expand to themselves — skip those.
  [ -f "$guard_path" ] || continue

  guard_name="$(basename "$guard_path")"
  base="${guard_name%.*}"
  test_path="$TESTS_DIR/test-$base.sh"
  GUARD_COUNT=$((GUARD_COUNT + 1))

  if [ ! -f "$test_path" ]; then
    FAIL=$((FAIL + 1))
    MISSING_TEST="${MISSING_TEST}  $guard_name -> expected $(basename "$test_path")
"
    printf 'FAIL  %-52s no test file\n' "$guard_name"
    continue
  fi

  if ! grep -qE "$NEGATIVE_ASSERTION_RE" "$test_path"; then
    FAIL=$((FAIL + 1))
    NO_NEGATIVE="${NO_NEGATIVE}  $guard_name -> $(basename "$test_path")
"
    printf 'FAIL  %-52s test has no negative case\n' "$guard_name"
    continue
  fi

  PASS=$((PASS + 1))
  printf 'PASS  %-52s %s\n' "$guard_name" "$(basename "$test_path")"
done

if [ "$GUARD_COUNT" -eq 0 ]; then
  echo "ERROR: no check-* scripts found in $GUARDS_DIR — wrong directory?" >&2
  exit 1
fi

echo
echo "== $PASS guarded, $FAIL unguarded =="

if [ "$FAIL" -gt 0 ]; then
  echo
  if [ -n "$MISSING_TEST" ]; then
    echo "FAIL: these guards have NO test at all:"
    printf '%s' "$MISSING_TEST"
    echo
    echo "  Add scripts/devops/tests/test-<guard-basename>.sh. Start from an existing"
    echo "  one — they all follow the same shape: source lib/harness.sh, build a fixture"
    echo "  (fake repo / PATH shim / fake origin), then assert both directions."
  fi
  if [ -n "$NO_NEGATIVE" ]; then
    echo "FAIL: these tests never assert the guard goes RED:"
    printf '%s' "$NO_NEGATIVE"
    echo
    echo "  A test that only proves 'the guard is quiet on good input' is satisfied by a"
    echo "  guard that does nothing at all. Add at least one assert_red / assert_red_signal"
    echo "  case feeding the guard input it MUST reject."
  fi
  echo
  echo "Rule: a guard nobody has watched go red is not a guard."
  exit 1
fi

echo
echo "OK: every check-* script has a test, and every test has a negative case."
exit 0
