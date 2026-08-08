#!/usr/bin/env bash
# run-guard-tests.sh — the one command that runs every guard test.
#
#   scripts/devops/tests/run-guard-tests.sh              # all of them
#   scripts/devops/tests/run-guard-tests.sh ddl          # only matching files
#   GUARD_TEST_VERBOSE=1 scripts/devops/tests/run-guard-tests.sh   # show each
#                                                          case's captured output
#
# GUARD_TEST_VERBOSE is how the actual red output gets into a PR body: every
# negative case prints what the guard really said when it refused. Claiming a
# guard goes red is not evidence; the output is.
#
# Runs the meta-guard (check-guard-tests-exist.sh) FIRST and independently of the
# test files, so that "a guard has no test" is reported even if every existing
# test passes — the failure mode this whole suite exists to prevent is silence
# about something that is missing, not noise about something that is broken.
#
# Requires: bash, python3, node, curl. All four are already required by the
# guards themselves and are present on the ubuntu-latest runner.
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_DIR="$(cd "$SELF_DIR/.." && pwd)"
FILTER="${1:-}"

TOTAL_FILES=0
FAILED_FILES=0
FAILED_NAMES=""

echo "########################################################################"
echo "# Guard tests — every check-* script in scripts/devops, both directions #"
echo "########################################################################"
echo

# ── meta-guard first ───────────────────────────────────────────────────────────
if [ -z "$FILTER" ]; then
  if ! bash "$GUARD_DIR/check-guard-tests-exist.sh"; then
    FAILED_FILES=$((FAILED_FILES + 1))
    FAILED_NAMES="${FAILED_NAMES}  check-guard-tests-exist.sh (meta-guard)
"
  fi
  echo
fi

# ── every test file ────────────────────────────────────────────────────────────
for test_file in "$SELF_DIR"/test-*.sh; do
  [ -f "$test_file" ] || continue
  name="$(basename "$test_file")"
  if [ -n "$FILTER" ]; then
    case "$name" in
      *"$FILTER"*) ;;
      *) continue ;;
    esac
  fi

  TOTAL_FILES=$((TOTAL_FILES + 1))
  if ! bash "$test_file"; then
    FAILED_FILES=$((FAILED_FILES + 1))
    FAILED_NAMES="${FAILED_NAMES}  $name
"
  fi
  echo
done

if [ "$TOTAL_FILES" -eq 0 ]; then
  echo "ERROR: no test files matched${FILTER:+ filter '$FILTER'}." >&2
  exit 1
fi

echo "########################################################################"
if [ "$FAILED_FILES" -eq 0 ]; then
  echo "# ALL GUARD TESTS PASSED — $TOTAL_FILES test file(s)"
  echo "########################################################################"
  exit 0
fi

echo "# GUARD TESTS FAILED — $FAILED_FILES of $TOTAL_FILES test file(s):"
printf '%s' "$FAILED_NAMES" | sed 's/^/# /'
echo "########################################################################"
exit 1
