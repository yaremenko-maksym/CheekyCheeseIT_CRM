#!/usr/bin/env bash
# Guard test for scripts/devops/prefer-official-apt-mirror.sh.
#
# The subject's contract is a STDOUT contract, not an exit code: it must never
# fail the CI step, whatever it finds. So every negative case here is an
# `assert_red_signal` — the red is a `::warning::` (or an "unchanged" line) on
# exit 0, and the thing that must never happen is a silent success that leaves
# the slow ec2 mirror in place while the log reads like a fix.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/prefer-official-apt-mirror.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

EC2_LIST='http://us-west-2.ec2.archive.ubuntu.com/ubuntu/
http://security.ubuntu.com/ubuntu/'

# APT_SUDO is set to the empty string (not unset) so the subject writes as the
# test user: `${APT_SUDO-sudo}` keeps `sudo` only when the variable is UNSET.
run_subject() {
  local target="$1"
  MIRRORS_FILE="$target" APT_SUDO="" bash "$SUBJECT"
}

# A sudo stand-in that succeeds without doing anything. This is the shape that
# matters: `tee` reports success, the file keeps the ec2 host, and the step must
# say so rather than print "apt will fetch from the official archive".
run_subject_noop_write() {
  local target="$1"
  MIRRORS_FILE="$target" APT_SUDO="true" bash "$SUBJECT"
}

# ── 1. happy path: the ec2 host is replaced and the result is ASSERTED ───────
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-ec2"
assert_green "an ec2 mirror list is rewritten to the official archive, and the file is re-read to prove it" \
  --contains "Mirror list before" \
  --contains "ec2.archive.ubuntu.com" \
  --contains "Mirror list after" \
  --contains "apt will fetch from the official Ubuntu archive" \
  --not-contains "::warning::" \
  -- run_subject "$WORK/mirrors-ec2"

assert_green "after the rewrite the file itself holds the official hosts and no ec2 host" \
  --contains "http://archive.ubuntu.com/ubuntu/" \
  --contains "http://azure.archive.ubuntu.com/ubuntu/" \
  --not-contains "ec2.archive.ubuntu.com" \
  -- cat "$WORK/mirrors-ec2"

# ── 2. a non-ec2 runner is left ALONE (the azure runners are already fast) ───
printf 'http://azure.archive.ubuntu.com/ubuntu/\n' > "$WORK/mirrors-azure"
assert_red_signal "a mirror list with no ec2 host is left untouched and the log says why, instead of claiming a rewrite" \
  --contains "Mirror list unchanged" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject "$WORK/mirrors-azure"

assert_green "the untouched file still holds exactly what it held" \
  --contains "http://azure.archive.ubuntu.com/ubuntu/" \
  -- cat "$WORK/mirrors-azure"

# ── 3. no mirror list at all (a runner image with plain sources.list) ────────
assert_red_signal "a missing mirror list is a warning and a no-op, never a failed step" \
  --contains "::warning::" \
  --contains "does not exist" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject "$WORK/no-such-file"

# ── 4. the target cannot be written ─────────────────────────────────────────
# A DIRECTORY in the file's place, not a read-only file: `tee` fails on a
# directory for every user, so the case stays red when the suite runs as root
# (CI containers do) instead of silently turning green there.
mkdir -p "$WORK/mirrors-as-dir"
assert_red_signal "an unwritable mirror list is a warning, and the ec2 mirror is reported as still in place" \
  --contains "::warning::" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject "$WORK/mirrors-as-dir"

# ── 5. the write "succeeds" and changes nothing (the dangerous shape) ───────
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-noop"
assert_red_signal "a write that reports success while the file keeps the ec2 host is named as a mismatch, not passed over" \
  --contains "::warning::" \
  --contains "still does not name the official archive" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject_noop_write "$WORK/mirrors-noop"

guard_test_summary "test-prefer-official-apt-mirror.sh"
