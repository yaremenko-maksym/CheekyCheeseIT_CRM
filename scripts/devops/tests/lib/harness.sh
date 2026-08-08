#!/usr/bin/env bash
# harness.sh — assertion helpers for the guard tests (task-guards-teeth, 2026-08-07).
#
# WHY THIS EXISTS: scripts/devops/ carries nine check-* guards that stand between
# this repo and production, and until this file none of them had a single test.
# We were guarding prod with scripts nobody guarded. Worse, the one guard that was
# audited in passing (check-prod-ddl-wiring.py) turned out to be satisfiable by a
# COMMENT — it proved "the filename is mentioned somewhere", not "the migration is
# copied and applied". A guard that cannot be shown to go red is a guard nobody has
# any reason to believe.
#
# THE ONE RULE THIS HARNESS ENFORCES BY DESIGN: every guard test must contain at
# least one NEGATIVE case (`assert_red` / `assert_red_signal`). A test that only
# proves "the guard stays quiet on good input" reproduces exactly the disease being
# treated — it is satisfied by a guard whose body is `exit 0`. The meta-guard
# scripts/devops/check-guard-tests-exist.sh greps for those helper names for that
# reason, so the requirement is mechanical, not a matter of discipline.
#
# Style deliberately mirrors the guards themselves (PASS/FAIL counters, printf
# table, non-zero exit on any failure) rather than importing a test framework:
# the subjects under test are bash + python3 + node, and there is no runtime all
# three share. Bash 3.2-compatible (macOS default /bin/bash) — no associative
# arrays, no `${var,,}`, and empty-array expansion always via the
# `${arr[@]+"${arr[@]}"}` idiom (plain `"${arr[@]}"` on an EMPTY array under
# `set -u` is an "unbound variable" error on 3.2).
#
# API:
#   assert_green "<desc>" [--contains S]... [--not-contains S]... -- <cmd>...
#       the command must exit 0 (and match the optional output constraints).
#   assert_red   "<desc>" [--contains S]... [--not-contains S]... -- <cmd>...
#       the command must exit NON-zero. This is the case that matters.
#   assert_red_signal "<desc>" [--contains S]... [--not-contains S]... -- <cmd>...
#       for the one guard (check-backup-freshness.sh) whose failure signal is a
#       STDOUT CONTRACT rather than an exit code — `STATUS=stale` on exit 0 is its
#       red. Semantically identical to assert_green + constraints; named separately
#       so that "this test has a negative case" stays greppable and honest.
#
# Env:
#   GUARD_TEST_VERBOSE=1   print each case's captured output (this is how the PR
#                          body's "actual red output" evidence is produced).
set -u

# Resolved once, here, so every test script gets the same anchors regardless of
# the CWD it was invoked from.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$(cd "$LIB_DIR/.." && pwd)"
GUARD_DIR="$(cd "$TESTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$GUARD_DIR/../.." && pwd)"

GUARD_TEST_PASS=0
GUARD_TEST_FAIL=0
GUARD_TEST_VERBOSE="${GUARD_TEST_VERBOSE:-0}"

_GT_OUT=""
_GT_RC=0

# Runs "$@", capturing merged stdout+stderr into _GT_OUT and the exit code into
# _GT_RC. Never lets a non-zero exit kill the test script.
_gt_run() {
  local out rc had_e=0
  case "$-" in *e*) had_e=1 ;; esac
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  [ "$had_e" = "1" ] && set -e
  _GT_OUT="$out"
  _GT_RC="$rc"
}

_gt_print_output() {
  [ "$GUARD_TEST_VERBOSE" = "1" ] || return 0
  printf '%s\n' "$_GT_OUT" | sed 's/^/      | /'
}

# $1 = expectation: green | red | signal
_gt_assert() {
  local expect="$1"
  shift
  local desc="$1"
  shift

  local contains=()
  local not_contains=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --contains)
        contains+=("$2")
        shift 2
        ;;
      --not-contains)
        not_contains+=("$2")
        shift 2
        ;;
      --)
        shift
        break
        ;;
      *)
        echo "harness: unexpected argument before '--': $1" >&2
        exit 2
        ;;
    esac
  done

  if [ "$#" -eq 0 ]; then
    echo "harness: no command given for case '$desc'" >&2
    exit 2
  fi

  _gt_run "$@"

  local ok=1
  local why=""

  case "$expect" in
    green | signal)
      if [ "$_GT_RC" -ne 0 ]; then
        ok=0
        why="expected exit 0, got $_GT_RC"
      fi
      ;;
    red)
      if [ "$_GT_RC" -eq 0 ]; then
        ok=0
        why="expected NON-zero exit (guard should have gone red), got 0"
      fi
      ;;
  esac

  local needle
  for needle in ${contains[@]+"${contains[@]}"}; do
    case "$_GT_OUT" in
      *"$needle"*) ;;
      *)
        ok=0
        why="${why:+$why; }output missing expected substring: $needle"
        ;;
    esac
  done
  for needle in ${not_contains[@]+"${not_contains[@]}"}; do
    case "$_GT_OUT" in
      *"$needle"*)
        ok=0
        why="${why:+$why; }output contains forbidden substring: $needle"
        ;;
    esac
  done

  local tag
  case "$expect" in
    green) tag="green" ;;
    red) tag="RED  " ;;
    signal) tag="RED! " ;;
  esac

  if [ "$ok" = "1" ]; then
    GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
    printf 'PASS  [%s] %s\n' "$tag" "$desc"
    _gt_print_output
  else
    GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
    printf 'FAIL  [%s] %s\n' "$tag" "$desc"
    printf '      reason: %s\n' "$why"
    printf '%s\n' "$_GT_OUT" | sed 's/^/      | /'
  fi
}

assert_green() { _gt_assert green "$@"; }
assert_red() { _gt_assert red "$@"; }
assert_red_signal() { _gt_assert signal "$@"; }

# ── temp workspace ─────────────────────────────────────────────────────────────
# Every test builds its fixtures under its own mktemp -d. The parent worktree is
# never written to (these tests run against the REAL guard scripts, but always
# against FAKE repos/origins — a test that mutated the repo it is verifying would
# be its own kind of lie).
guard_test_workspace() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/guard-test-XXXXXX")"
  printf '%s' "$d"
}

# ── fake repo scaffolding (for the three python guards) ────────────────────────
# The python guards resolve REPO_ROOT as <script>/../.. — so copying the real,
# unmodified guard into <fake>/scripts/devops/ makes <fake> its repo root. The
# guard under test is byte-identical to the one CI runs; only the world around it
# is fabricated.
guard_test_fake_repo() {
  local root="$1" guard="$2"
  mkdir -p "$root/scripts/devops" "$root/.github/workflows"
  cp "$GUARD_DIR/$guard" "$root/scripts/devops/$guard"
}

# ── PATH shims (for guards that shell out to curl / aws) ───────────────────────
# Creates <root>/bin/<name> from the given body and prepends it to PATH for the
# caller. Lets a test drive a guard's external dependency deterministically and
# offline (a guard test that needed the real Cloudflare API to be reachable would
# be a flake generator, and could not exercise the fetch-failure branch at all).
guard_test_shim() {
  local root="$1" name="$2" body="$3"
  mkdir -p "$root/bin"
  printf '%s\n' "$body" >"$root/bin/$name"
  chmod +x "$root/bin/$name"
}

# ── fake origin lifecycle (for the three curl-based nginx guards) ──────────────
# Starts lib/fake-origin.py in the background and blocks until it reports its
# bound port. Sets FAKE_ORIGIN_URL. stop_fake_origin kills it AND removes its
# workspace — the first version leaked one mktemp dir per case (~16 per suite
# run), which is exactly the kind of quiet mess a test suite has no business
# leaving on a developer's machine (review round 2, LOW).
FAKE_ORIGIN_PID=""
FAKE_ORIGIN_URL=""
FAKE_ORIGIN_DIR=""

start_fake_origin() {
  local suite="$1"
  shift
  local root
  root="$(guard_test_workspace)"
  FAKE_ORIGIN_DIR="$root"
  local portfile="$root/port"

  python3 "$LIB_DIR/fake-origin.py" --suite "$suite" --port-file "$portfile" "$@" \
    >"$root/server.log" 2>&1 &
  FAKE_ORIGIN_PID=$!

  local i=0
  while [ "$i" -lt 100 ]; do
    if [ -s "$portfile" ]; then
      FAKE_ORIGIN_URL="http://127.0.0.1:$(cat "$portfile")"
      return 0
    fi
    if ! kill -0 "$FAKE_ORIGIN_PID" 2>/dev/null; then
      echo "harness: fake-origin died on startup:" >&2
      cat "$root/server.log" >&2
      rm -rf "$root"
      FAKE_ORIGIN_DIR=""
      return 1
    fi
    # 50ms — `sleep 0.05` is coreutils/bash-portable enough for macOS + ubuntu.
    sleep 0.05
    i=$((i + 1))
  done
  echo "harness: fake-origin did not report a port in time" >&2
  cat "$root/server.log" >&2
  rm -rf "$root"
  FAKE_ORIGIN_DIR=""
  return 1
}

stop_fake_origin() {
  if [ -n "$FAKE_ORIGIN_PID" ]; then
    kill "$FAKE_ORIGIN_PID" 2>/dev/null || true
    wait "$FAKE_ORIGIN_PID" 2>/dev/null || true
    FAKE_ORIGIN_PID=""
  fi
  if [ -n "$FAKE_ORIGIN_DIR" ]; then
    rm -rf "$FAKE_ORIGIN_DIR"
    FAKE_ORIGIN_DIR=""
  fi
}

# ── per-test summary ───────────────────────────────────────────────────────────
guard_test_summary() {
  local name="$1"
  echo
  echo "== $name: $GUARD_TEST_PASS passed, $GUARD_TEST_FAIL failed =="
  if [ "$GUARD_TEST_FAIL" -gt 0 ]; then
    return 1
  fi
  return 0
}
