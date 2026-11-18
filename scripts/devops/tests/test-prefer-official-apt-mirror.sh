#!/usr/bin/env bash
# Guard test for scripts/devops/prefer-official-apt-mirror.sh.
#
# The subject's contract is a STDOUT contract, not an exit code: it must never
# fail the CI step, whatever it finds. So every negative case here is an
# `assert_red_signal` — the red is a `::warning::` (or an "unchanged" line) on
# exit 0, and the thing that must never happen is a silent success that leaves
# the slow ec2 mirror in place while the log reads like a fix.
#
# The second half covers the CI regression of 2026-11-18 (job 134961852153):
# apt enumerated zero Ubuntu sources and `install-deps` died three steps later
# with `E: Unable to locate package fonts-unifont`. apt is injected here
# (`APT_UPDATE_CMD` / `APT_POLICY_CMD`), so the cases assert the SHAPE: an
# unresolvable universe package is named, with evidence, in this step.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/prefer-official-apt-mirror.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

EC2_LIST='http://us-west-2.ec2.archive.ubuntu.com/ubuntu/
http://security.ubuntu.com/ubuntu/'

# apt stand-ins. `apt-cache policy` prints a Candidate line for a resolvable
# package and only a diagnostic for one no source carries — that difference is
# the whole signal the subject keys on.
cat > "$WORK/policy-ok" <<'STUB'
#!/usr/bin/env bash
echo "$1:"
echo "  Installed: (none)"
echo "  Candidate: 1:14.0.1-1"
STUB
cat > "$WORK/policy-missing" <<'STUB'
#!/usr/bin/env bash
echo "N: Unable to locate package $1"
STUB
cat > "$WORK/update-fail" <<'STUB'
#!/usr/bin/env bash
echo "Err:1 http://archive.ubuntu.com/ubuntu noble InRelease" >&2
exit 100
STUB
chmod +x "$WORK/policy-ok" "$WORK/policy-missing" "$WORK/update-fail"

# APT_SUDO is set to the empty string (not unset) so the subject writes as the
# test user: `${APT_SUDO-sudo}` keeps `sudo` only when the variable is UNSET.
# APT_UPDATE_CMD empty = skip the refresh (the default would call real apt).
run_subject() {
  local target="$1" policy="${2:-$WORK/policy-ok}" update="${3:-}"
  MIRRORS_FILE="$target" APT_SUDO="" APT_UPDATE_CMD="$update" \
    APT_POLICY_CMD="$policy" APT_SOURCES_PATHS="$WORK" bash "$SUBJECT"
}

# A sudo stand-in that succeeds without doing anything. This is the shape that
# matters: `tee` reports success, the file keeps the ec2 host, and the step must
# say so rather than print "apt will fetch from the official archive".
run_subject_noop_write() {
  local target="$1"
  MIRRORS_FILE="$target" APT_SUDO="true" APT_UPDATE_CMD="" \
    APT_POLICY_CMD="$WORK/policy-ok" APT_SOURCES_PATHS="$WORK" bash "$SUBJECT"
}

# ── 1. happy path: the ec2 host is replaced and the result is ASSERTED ───────
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-ec2"
assert_green "an ec2 mirror list is rewritten to the official archive, and the file is re-read to prove it" \
  --contains "Mirror list before" \
  --contains "ec2.archive.ubuntu.com" \
  --contains "Mirror list after" \
  --contains "apt will fetch from the official Ubuntu archive" \
  --contains "is resolvable" \
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

# ── 6. THE CI REGRESSION: the universe package has no candidate ─────────────
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-unresolvable"
assert_red_signal "an unresolvable universe package is named HERE, with the sources state, not left to exit 100 inside playwright" \
  --contains "::warning::" \
  --contains "cannot resolve fonts-unifont" \
  --contains "apt sources listing" \
  --contains "apt source stanzas" \
  --contains "Rolling back the mirror list" \
  --contains "Still unresolvable with the original mirror list" \
  --not-contains "Recovered" \
  -- run_subject "$WORK/mirrors-unresolvable" "$WORK/policy-missing"

assert_green "a failed verification leaves the runner's ORIGINAL mirror list in place, byte for byte" \
  --contains "ec2.archive.ubuntu.com" \
  --not-contains "azure.archive.ubuntu.com" \
  -- cat "$WORK/mirrors-unresolvable"

# ── 7. unresolvable on a runner this script never touched ───────────────────
printf 'http://azure.archive.ubuntu.com/ubuntu/\n' > "$WORK/mirrors-azure-bad"
assert_red_signal "when nothing was rewritten, the step says the broken package set is not its doing instead of rolling back someone else's file" \
  --contains "cannot resolve fonts-unifont" \
  --contains "changed no file on this runner" \
  --not-contains "Rolling back" \
  -- run_subject "$WORK/mirrors-azure-bad" "$WORK/policy-missing"

# ── 8. apt-get update itself fails (or times out) ───────────────────────────
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-update-fail"
assert_red_signal "a failed apt-get update is reported with its own output and counts as a failed verification" \
  --contains "apt-get update exited 100" \
  --contains "Err:1" \
  --contains "::warning::" \
  --contains "Rolling back the mirror list" \
  -- run_subject "$WORK/mirrors-update-fail" "$WORK/policy-ok" "$WORK/update-fail"

guard_test_summary "test-prefer-official-apt-mirror.sh"
