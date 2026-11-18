#!/usr/bin/env bash
# Tests for scripts/devops/write-apt-ci-fetch-timeouts.sh — the apt drop-in the
# e2e job writes so a STALLED archive socket is aborted and re-opened instead of
# being waited out (PR #1415 round 4, Addendum 3).
#
# WHY THE NEGATIVE CASE IS A STDOUT CONTRACT (assert_red_signal), not an exit
# code: this subject must NEVER fail the step. A malformed file under
# /etc/apt/apt.conf.d/ breaks every later apt command on the runner, chromium
# legs included, and a runner where the write is impossible must install exactly
# as it does today. So its failure signal is `::warning::` on stdout plus the
# file being gone, which is what the red cases below assert.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/harness.sh"

SUBJECT="$GUARD_DIR/write-apt-ci-fetch-timeouts.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# apt-config is a Debian binary; macOS and this repo's CI runners-under-test do
# not have one, and the real one would read the host's own apt tree anyway. Each
# case gets a fake whose behaviour is the thing being tested.
make_apt_config() { # $1 = dir, $2 = mode (ok|reject|silent|absent)
  local dir="$1" mode="$2"
  mkdir -p "$dir"
  [ "$mode" = "absent" ] && return 0
  {
    echo '#!/bin/sh'
    echo '[ "$1" = "dump" ] || exit 1'
    case "$mode" in
      ok)
        echo 'echo '"'"'Acquire::http::Timeout "30";'"'"''
        echo 'echo '"'"'Acquire::Retries "3";'"'"''
        echo 'echo '"'"'Acquire::http::Pipeline-Depth "0";'"'"''
        ;;
      reject) echo 'echo "E: Syntax error" >&2; exit 100' ;;
      silent) echo 'echo '"'"'Dir "/";'"'"'' ;;
    esac
  } > "$dir/apt-config"
  chmod +x "$dir/apt-config"
}

# Runs the subject with a fake apt-config and a writable target, and prints the
# resulting file so one case can assert both the output and the content.
run_subject() { # $1 = mode, $2 = target file, [$3 = extra PATH entry]
  local mode="$1"
  local target="$2"
  local bin
  bin="$WORK/bin-$mode-$$-$RANDOM"
  make_apt_config "$bin" "$mode"
  APT_SUDO="" APT_CONF_FILE="$target" PATH="$bin:$PATH" bash "$SUBJECT"
  local rc=$?
  if [ -f "$target" ]; then
    echo "FILE-EXISTS"
    cat "$target"
  else
    echo "FILE-ABSENT"
  fi
  return $rc
}

# ── green ─────────────────────────────────────────────────────────────────────
assert_green "writes the five fetch knobs and proves apt READ them (not merely that the file exists)" \
  --contains "FILE-EXISTS" \
  --contains 'Acquire::http::Timeout "30";' \
  --contains 'Acquire::https::Timeout "30";' \
  --contains 'Acquire::ftp::Timeout "30";' \
  --contains 'Acquire::Retries "3";' \
  --contains 'Acquire::http::Pipeline-Depth "0";' \
  --contains "Effective apt fetch config:" \
  --not-contains "::warning::" \
  --not-contains "::error::" \
  -- run_subject ok "$WORK/99-ok"

run_subject_twice() {
  run_subject ok "$WORK/99-twice" >/dev/null || return $?
  run_subject ok "$WORK/99-twice"
}

assert_green "running twice leaves the same single file (the step is re-runnable)" \
  --contains 'Acquire::Retries "3";' \
  --not-contains "::warning::" \
  -- run_subject_twice

# ── red (stdout contract: a warning, the file gone, and still exit 0) ─────────
assert_red_signal "apt refuses to parse the drop-in -> the file is REMOVED and a warning is printed, the step still succeeds" \
  --contains "::warning::" \
  --contains "refused to parse" \
  --contains "FILE-ABSENT" \
  -- run_subject reject "$WORK/99-reject"

assert_red_signal "the target cannot be written -> warning, no file, and apt keeps its defaults" \
  --contains "::warning::" \
  --contains "Could not write" \
  --contains "FILE-ABSENT" \
  -- run_subject ok "$WORK/no-such-dir/99-unwritable"

assert_red_signal "apt-config is not installed at all -> treated as 'apt will not parse it', never as success" \
  --contains "::warning::" \
  --contains "FILE-ABSENT" \
  -- run_subject absent "$WORK/99-noapt"

assert_red_signal "apt parses the file but reports no Acquire fetch keys -> warning, because the drop-in may not be in effect" \
  --contains "::warning::" \
  --contains "no Acquire fetch keys" \
  --contains "FILE-EXISTS" \
  -- run_subject silent "$WORK/99-silent"

guard_test_summary "test-write-apt-ci-fetch-timeouts.sh"
