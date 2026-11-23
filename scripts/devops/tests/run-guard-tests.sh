#!/usr/bin/env bash
# run-guard-tests.sh — the one command that runs every guard test.
#
#   scripts/devops/tests/run-guard-tests.sh              # all of them
#   scripts/devops/tests/run-guard-tests.sh ddl          # only matching files
#   GUARD_TEST_VERBOSE=1 scripts/devops/tests/run-guard-tests.sh   # show each
#                                                          case's captured output
#   GUARD_TEST_JOBS=8 scripts/devops/tests/run-guard-tests.sh      # custom jobs
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
# Runs all test files concurrently via xargs -P "$(nproc)", each writing its log
# under a mktemp -d directory. After all finish, logs are printed in the same
# sorted file order as before, preserving identical per-file lines, summary, and
# exit semantics. The longest file (test-install-playwright-system-deps.sh) starts
# first to minimize queue tail.
#
# Requires: bash, python3, node, curl, xargs. All are already required by the
# guards themselves and are present on macOS and the ubuntu-latest runner.
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_DIR="$(cd "$SELF_DIR/.." && pwd)"
FILTER="${1:-}"

# Concurrency: default to available CPU count
if [ -n "${GUARD_TEST_JOBS:-}" ]; then
  JOBS="$GUARD_TEST_JOBS"
elif command -v nproc >/dev/null 2>&1; then
  JOBS="$(nproc)"
elif command -v sysctl >/dev/null 2>&1; then
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
else
  JOBS=4
fi
[ "$JOBS" -ge 1 ] 2>/dev/null || JOBS=4

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

# ── collect matching test files in sorted order ────────────────────────────────
LONGEST="test-install-playwright-system-deps.sh"
MATCHED_FILES=()

for test_file in "$SELF_DIR"/test-*.sh; do
  [ -f "$test_file" ] || continue
  name="$(basename "$test_file")"
  if [ -n "$FILTER" ]; then
    case "$name" in
      *"$FILTER"*) ;;
      *) continue ;;
    esac
  fi
  MATCHED_FILES+=("$test_file")
done

TOTAL_FILES=${#MATCHED_FILES[@]}

if [ "$TOTAL_FILES" -eq 0 ]; then
  echo "ERROR: no test files matched${FILTER:+ filter '$FILTER'}." >&2
  exit 1
fi

# ── dispatch order: start the longest file first ──────────────────────────────
DISPATCH_FILES=()
for test_file in "${MATCHED_FILES[@]}"; do
  if [ "$(basename "$test_file")" = "$LONGEST" ]; then
    DISPATCH_FILES=("$test_file" "${DISPATCH_FILES[@]}")
  else
    DISPATCH_FILES+=("$test_file")
  fi
done

# ── run tests concurrently ────────────────────────────────────────────────────
TMP_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guard-test-logs-XXXXXX")"
trap 'rm -rf "$TMP_LOG_DIR"' EXIT INT TERM

printf '%s\0' "${DISPATCH_FILES[@]}" | xargs -0 -n 1 -P "$JOBS" bash -c '
  log_dir="$1"
  file="$2"
  name="$(basename "$file")"
  bash "$file" > "$log_dir/$name.log" 2>&1
  echo $? > "$log_dir/$name.rc"
' _ "$TMP_LOG_DIR"

# ── print logs and collect results in sorted file order ────────────────────────
for test_file in "${MATCHED_FILES[@]}"; do
  name="$(basename "$test_file")"
  log="$TMP_LOG_DIR/$name.log"
  rc_file="$TMP_LOG_DIR/$name.rc"

  if [ -f "$log" ]; then
    cat "$log"
  fi

  rc=1
  if [ -f "$rc_file" ]; then
    rc="$(cat "$rc_file")"
  fi

  if [ "$rc" -ne 0 ]; then
    FAILED_FILES=$((FAILED_FILES + 1))
    FAILED_NAMES="${FAILED_NAMES}  $name
"
  fi
  echo
done

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
