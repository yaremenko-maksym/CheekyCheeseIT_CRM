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
#
# `timeout` is injected too (a recorder on PATH), because the only way to pin
# the DS-M-2 fix — apt-get run directly under `sudo timeout --kill-after=…`,
# with no `sh -c` to swallow the signal — is to read the argv the subject built.
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
cat > "$WORK/policy-ok" << 'STUB'
#!/usr/bin/env bash
echo "$1:"
echo "  Installed: (none)"
echo "  Candidate: 1:14.0.1-1"
STUB
cat > "$WORK/policy-missing" << 'STUB'
#!/usr/bin/env bash
echo "N: Unable to locate package $1"
STUB
cat > "$WORK/update-fail" << 'STUB'
#!/usr/bin/env bash
echo "Err:1 http://archive.ubuntu.com/ubuntu noble InRelease" >&2
exit 100
STUB
cat > "$WORK/update-ok" << 'STUB'
#!/usr/bin/env bash
echo "Reading package lists... Done"
STUB
chmod +x "$WORK/policy-ok" "$WORK/policy-missing" "$WORK/update-fail" "$WORK/update-ok"

# A `timeout` that RECORDS the argv it was handed and then runs the command, so
# the cases can assert the shape of the call rather than its signal behaviour.
# On PATH ahead of any real one, so the subject takes the same branch on macOS
# (no `timeout` at all) and on Linux.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/timeout" << 'STUB'
#!/usr/bin/env bash
printf 'timeout-argv: %s\n' "$*" >> "$ARGV_LOG"
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    --kill-after=*) i=$((i + 1)) ;;
    *) break ;;
  esac
done
i=$((i + 1)) # skip the duration
exec "${args[@]:$i}"
STUB
chmod +x "$WORK/bin/timeout"

# A `sudo` stand-in that records what it was asked to run and then runs it.
cat > "$WORK/recording-sudo" << 'STUB'
#!/usr/bin/env bash
printf 'sudo-argv: %s\n' "$*" >> "$ARGV_LOG"
exec "$@"
STUB
# A privileged write that FAILS, so the "could not write" branch is reached on a
# file that really exists. A directory in the file's place cannot reach it: the
# subject's own `[ ! -f ]` guard returns first, which is what made the earlier
# version of this case vacuous (SPEC-M-4).
cat > "$WORK/failing-sudo" << 'STUB'
#!/usr/bin/env bash
echo "sudo: a password is required" >&2
exit 1
STUB
# A privileged write that succeeds but writes a THIRD-PARTY host whose path
# merely contains the official name. Pins the anchored match (DS-L-2).
cat > "$WORK/sudo-writes-lookalike" << 'STUB'
#!/usr/bin/env bash
# argv: tee <file>; stdin is discarded on purpose
cat > /dev/null
printf 'http://mirror.example.com/archive.ubuntu.com/ubuntu/\n' > "$2"
STUB
chmod +x "$WORK/recording-sudo" "$WORK/failing-sudo" "$WORK/sudo-writes-lookalike"

ARGV_LOG="$WORK/argv.log"
: > "$ARGV_LOG"
export ARGV_LOG

# APT_SUDO is set to the empty string (not unset) so the subject writes as the
# test user: `${APT_SUDO-sudo}` keeps `sudo` only when the variable is UNSET.
# APT_UPDATE_CMD empty = skip the refresh (the default would call real apt).
# `env` for the optional variable, never a `${VAR:+NAME=value}` expansion in a
# command prefix: the expanded word lands in command-NAME position, so bash
# tries to execute `APT_PROC_REGEX=sleep` and exits 127. Leaving the variable
# out entirely is what exercises the subject's production default, which every
# other case here does.
run_subject() {
  local target="$1" policy="${2:-$WORK/policy-ok}" update="${3:-}"
  local -a extra=()
  [ -n "${APT_PROC_REGEX_FOR_CASE:-}" ] && extra+=("APT_PROC_REGEX=$APT_PROC_REGEX_FOR_CASE")
  PATH="$WORK/bin:$PATH" MIRRORS_FILE="$target" APT_SUDO="${APT_SUDO_FOR_CASE-}" \
    APT_UPDATE_CMD="$update" APT_POLICY_CMD="$policy" APT_SOURCES_PATHS="$WORK" \
    APT_LOCK_WAIT_MAX_SECONDS="${APT_LOCK_WAIT_MAX_SECONDS_FOR_CASE:-30}" \
    APT_LOCK_POLL_SECONDS="${APT_LOCK_POLL_SECONDS_FOR_CASE:-3}" \
    env ${extra[@]+"${extra[@]}"} bash "$SUBJECT"
}

# A sudo stand-in that succeeds without doing anything. This is the shape that
# matters: `tee` reports success, the file keeps the ec2 host, and the step must
# say so rather than print "apt will fetch from the official archive".
run_subject_noop_write() {
  local target="$1"
  PATH="$WORK/bin:$PATH" MIRRORS_FILE="$target" APT_SUDO="true" APT_UPDATE_CMD="" \
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

# ── 2b. DS-L-2: the ec2 host form is matched on the HOST field ──────────────
# `azure.archive.ubuntu.com` contains `archive.ubuntu.com` as a substring and
# must NOT be read as an ec2 host; `us-east-2.ec2…` is the second region form.
printf 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\n' > "$WORK/mirrors-ec2-east"
assert_green "the us-east-2 ec2 host form is recognised and rewritten, like us-west-2" \
  --contains "apt will fetch from the official Ubuntu archive" \
  --not-contains "Mirror list unchanged" \
  -- run_subject "$WORK/mirrors-ec2-east"

printf 'http://archive.ubuntu.com/ubuntu/\n' > "$WORK/mirrors-official-already"
assert_red_signal "a list already on Canonical's own host is left untouched, not rewritten over itself" \
  --contains "Mirror list unchanged" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject "$WORK/mirrors-official-already"

# ── 3. no mirror list at all (a runner image with plain sources.list) ────────
assert_red_signal "a missing mirror list is a warning and a no-op, never a failed step" \
  --contains "::warning::" \
  --contains "does not exist" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject "$WORK/no-such-file"

# ── 4. the privileged write FAILS on a file that exists ─────────────────────
# Reaches the write and fails there, which the directory-in-the-way version of
# this case never did (SPEC-M-4): the subject returns at `[ ! -f ]` first, so
# the old case was green no matter what the write branch did.
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-unwritable"
APT_SUDO_FOR_CASE="$WORK/failing-sudo"
assert_red_signal "a failed privileged write is named as 'could not write', and the ec2 mirror is reported as still in place" \
  --contains "::warning::" \
  --contains "Could not write" \
  --contains "apt keeps the ec2 mirror" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject "$WORK/mirrors-unwritable"
unset APT_SUDO_FOR_CASE

assert_green "the file the write failed on is byte-for-byte unchanged" \
  --contains "us-west-2.ec2.archive.ubuntu.com" \
  --not-contains "azure" \
  -- cat "$WORK/mirrors-unwritable"

# ── 5. the write "succeeds" and changes nothing (the dangerous shape) ───────
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-noop"
assert_red_signal "a write that reports success while the file keeps the ec2 host is named as a mismatch, not passed over" \
  --contains "::warning::" \
  --contains "still does not name the official archive" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject_noop_write "$WORK/mirrors-noop"

# ── 5b. DS-L-2: a third-party host whose PATH contains the official name ────
# The unanchored substring check accepted this as "the official archive is
# named" — a mirror nobody vetted, reported as Canonical's own.
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-lookalike"
APT_SUDO_FOR_CASE="$WORK/sudo-writes-lookalike"
assert_red_signal "a host that merely has archive.ubuntu.com in its PATH is not accepted as the official archive" \
  --contains "::warning::" \
  --contains "still does not name the official archive" \
  --not-contains "apt will fetch from the official Ubuntu archive" \
  -- run_subject "$WORK/mirrors-lookalike"
unset APT_SUDO_FOR_CASE

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

# ── 6b. CR-M-2 / SR-L-8: the rollback is BYTE-exact, proved with cmp ────────
# The file ends with a newline AND a blank line. `original="$(cat …)"` strips
# every trailing newline, so the old rollback wrote a file that differed from
# the runner's own in its last bytes — invisible to a `grep` comparison and to
# a reader, and a real change to a file this script promises not to change.
printf 'http://us-west-2.ec2.archive.ubuntu.com/ubuntu/\nhttp://security.ubuntu.com/ubuntu/\n\n' \
  > "$WORK/mirrors-bytes"
cp "$WORK/mirrors-bytes" "$WORK/mirrors-bytes.expected"
assert_red_signal "the rollback claims success only after cmp proves the bytes match" \
  --contains "Rolling back the mirror list" \
  --contains "is byte-for-byte what the runner shipped with (cmp)" \
  -- run_subject "$WORK/mirrors-bytes" "$WORK/policy-missing"

assert_contract "the rolled-back file is byte-identical to the original, trailing blank line included" \
  -- cmp "$WORK/mirrors-bytes" "$WORK/mirrors-bytes.expected"

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

# ── 9. DS-M-2: apt-get runs DIRECTLY under `sudo timeout --kill-after=…` ────
# `timeout … sh -c "sudo apt-get update"` signalled the shell, and sudo never
# relays SIGKILL, so the orphaned apt-get kept the lists lock and the retry
# failed on the lock. The argv is the only observable that pins this.
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-argv"
: > "$ARGV_LOG"
APT_SUDO_FOR_CASE="$WORK/recording-sudo"
assert_green "the refresh runs under the privilege prefix, with a kill-after bound and no intervening shell" \
  --contains "Reading package lists" \
  -- run_subject "$WORK/mirrors-argv" "$WORK/policy-ok" "$WORK/update-ok"
unset APT_SUDO_FOR_CASE

assert_green "the recorded argv shows sudo outside, timeout inside, --kill-after set, and no 'sh -c'" \
  --contains "sudo-argv: timeout --kill-after=15 120" \
  --contains "timeout-argv: --kill-after=15 120" \
  --contains "update-ok" \
  --not-contains "sh -c" \
  -- cat "$ARGV_LOG"

# ── 10. DS-M-2: the retry waits for a live apt/dpkg process, bounded ────────
# The wait is driven by the process list, not by flock(1): apt takes fcntl()
# locks, which flock does not observe. `sleep` stands in for the holder here so
# the case needs no apt and no root.
printf '%s\n' "$EC2_LIST" > "$WORK/mirrors-lockwait"
sleep 30 &
SLEEPER_PID=$!
APT_PROC_REGEX_FOR_CASE='sleep'
APT_LOCK_WAIT_MAX_SECONDS_FOR_CASE=1
APT_LOCK_POLL_SECONDS_FOR_CASE=1
assert_red_signal "before re-verifying, a still-running holder is waited out for a BOUNDED time and then reported" \
  --contains "is still running" \
  --contains "waiting up to 1s" \
  --contains "STILL running after 1s" \
  -- run_subject "$WORK/mirrors-lockwait" "$WORK/policy-missing"
kill "$SLEEPER_PID" 2> /dev/null || true
wait "$SLEEPER_PID" 2> /dev/null || true
unset APT_PROC_REGEX_FOR_CASE APT_LOCK_WAIT_MAX_SECONDS_FOR_CASE APT_LOCK_POLL_SECONDS_FOR_CASE

guard_test_summary "test-prefer-official-apt-mirror.sh"
