#!/usr/bin/env bash
# Point apt at the official Ubuntu archive when the runner's mirror list names
# the AWS-region `*.ec2.archive.ubuntu.com` hosts, then PROVE that apt can still
# resolve the packages the deps step is about to install.
#
# WHY THE REWRITE (measured, round 4 of PR #1415, not inferred):
#   * Every red `Install Playwright system deps` of the webkit leg ran on an
#     AWS-region runner fetching from `*.ec2.archive.ubuntu.com`; every green one
#     ran on Azure against `azure.archive.ubuntu.com`.
#   * The round-4 progress sampler settled WHY, on job 134915543321 (us-west-2):
#     apt's cache grew from 5376 KB to 53492 KB over 481 s — about 100 KB/s,
#     steady, with the `http` fetch process alive at every 30 s sample and the
#     sockets open. 48116 KB / 481 s is 100 KB/s, so the 125 MB webkit set
#     needs ~21 min at that rate (125000 KB / 100 KB/s = 1250 s).
#   * It is the mirror, not the runner: the SAME job restored a 177 MB
#     actions/cache entry at 22-41 MB/s a minute earlier. So no fetch timeout,
#     retry count or step budget can fix it — the byte source has to change.
#
# WHY THE VERIFICATION: on one leg of 12 (job 134961852153) apt enumerated ZERO
# Ubuntu sources — only `packages.microsoft.com` — and `install-deps` died three
# steps later with `E: Unable to locate package fonts-unifont`, a universe
# package. The sources that vanished include the direct `security.ubuntu.com`
# stanza, which does NOT go through the mirror list at all, so a rewritten list
# does not explain it; the other 11 legs had the identical before/after list and
# resolved universe normally. Root cause unestablished. What IS fixable is the
# blindness: an unresolvable package set is detected HERE, with the sources state
# printed, instead of surfacing as an opaque exit 100 inside playwright.
#
# WHAT IT DOES: the runner image's sources are deb822 with
# `URIs: mirror+file:/etc/apt/apt-mirrors.txt`, so the mirror list file is the
# seam — one file, read by both deps paths (`playwright install --with-deps` and
# the wrapper step), neither of which passes apt any `-o` override. Verified in
# ubuntu:24.04: writing that file changes the host in apt's `Get:` lines.
#
# Mirror policy: `archive.ubuntu.com` and `security.ubuntu.com` are Canonical's
# own; `azure.archive.ubuntu.com` is an official Ubuntu mirror and is the host
# the green runs used. No third-party mirror and no proxy is written here.
#
# NEVER fails the step: a runner whose layout this does not match keeps its own
# mirrors and installs exactly as before, with a `::warning::` saying so. A
# failed verification is a `::warning::` plus evidence, and the rewrite is rolled
# back so the install runs against the sources the runner shipped with.
set -uo pipefail

MIRRORS_FILE="${MIRRORS_FILE:-/etc/apt/apt-mirrors.txt}"
# Order matters: apt's mirror method spreads requests over the list, so both
# hosts carry part of the fetch and either one being slow is survivable.
OFFICIAL_MIRRORS="${OFFICIAL_MIRRORS:-http://archive.ubuntu.com/ubuntu/
http://azure.archive.ubuntu.com/ubuntu/}"
SUDO="${APT_SUDO-sudo}"
# A universe package `playwright install-deps` needs on every browser. If this
# one has no candidate, the install is going to exit 100.
APT_VERIFY_PKG="${APT_VERIFY_PKG:-fonts-unifont}"
# WITHOUT a privilege prefix: the prefix is applied at the call site, OUTSIDE
# the timeout, because `timeout … sudo apt-get` sends its signals to sudo, and
# sudo does not relay SIGKILL. See _verify_lists.
APT_UPDATE_CMD="${APT_UPDATE_CMD-apt-get update}"
APT_POLICY_CMD="${APT_POLICY_CMD:-apt-cache policy}"
# The step has no budget of its own, and a trickling mirror can hold an
# `apt-get update` for minutes. A timeout here counts as a failed verification.
APT_UPDATE_TIMEOUT_SECONDS="${APT_UPDATE_TIMEOUT_SECONDS:-120}"
# How long after SIGTERM the kill goes in. `timeout` alone sends only TERM, and
# an apt-get that ignores or is slow to handle it stays alive holding the lists
# lock — which is precisely what makes the retry below fail (round 4 review
# DS-M-2).
APT_UPDATE_KILL_AFTER_SECONDS="${APT_UPDATE_KILL_AFTER_SECONDS:-15}"
# Bounded wait for a leftover apt/dpkg process before the post-rollback retry.
APT_LOCK_WAIT_MAX_SECONDS="${APT_LOCK_WAIT_MAX_SECONDS:-30}"
APT_LOCK_POLL_SECONDS="${APT_LOCK_POLL_SECONDS:-3}"
# `ps -o comm=` TRUNCATES TO 15 CHARACTERS on Linux, so the production name
# `unattended-upgrade` can only ever be seen as `unattended-upgr`.
APT_PROC_REGEX="${APT_PROC_REGEX:-apt-get|apt\.systemd|unattended-upgr|dpkg}"
APT_SOURCES_PATHS="${APT_SOURCES_PATHS:-/etc/apt/sources.list /etc/apt/sources.list.d}"
# THE STEP'S OWN WORST CASE, as the sum of the knobs above, because ci.yml's
# job-level arithmetic needs a number it can check rather than trust:
#   APT_UPDATE_TIMEOUT_SECONDS + APT_UPDATE_KILL_AFTER_SECONDS (first
#     verification, after the rewrite)
#   + APT_LOCK_WAIT_MAX_SECONDS (waiting out the killed apt-get)
#   + APT_UPDATE_TIMEOUT_SECONDS + APT_UPDATE_KILL_AFTER_SECONDS (the
#     re-verification after the rollback)
#   + the policy/dump calls
#   = 120 + 15 + 30 + 120 + 15 + ~10 = ~310s on the rollback path, which is the
# only path that refreshes the lists twice. KILL_AFTER is paid PER `apt-get
# update` call, not once across both: each call is its own `timeout
# --kill-after=` (see _verify_lists), so an apt-get that ignores SIGTERM costs
# it twice. Every other path is one refresh (~145s).

# Print what apt is actually working from. Called on every verification failure,
# unconditionally: the one thing missing when this fired in CI was the state of
# these files on the runner that failed.
_dump_sources() {
  # shellcheck disable=SC2086
  echo "apt sources listing:"
  # shellcheck disable=SC2086
  ls -l $APT_SOURCES_PATHS 2>&1 | head -30
  echo "apt source stanzas:"
  # shellcheck disable=SC2086
  grep -rhE '^(URIs:|Suites:|Enabled:|Types:|deb[^ ]* )' $APT_SOURCES_PATHS 2>&1 | sort -u | head -30
  echo "mirror list (${MIRRORS_FILE}):"
  cat "$MIRRORS_FILE" 2>&1 | head -10
}

# Names any apt/dpkg process still running, or nothing. Prints `ps-unreadable`
# when it cannot tell, which is NOT the same answer as "none" — reading an
# empty result from an instrument that failed is the verification-integrity.md
# defect, so the caller distinguishes the two.
_apt_procs() {
  local out
  out="$(ps -eo comm= 2>&1)" || true
  if [ -z "$out" ]; then
    printf 'ps-unreadable'
    return 0
  fi
  printf '%s\n' "$out" | grep -E "$APT_PROC_REGEX" | head -3 | tr '\n' ' '
}

# Bounded wait for the lists lock to be free before a retry (round 4 review
# DS-M-2). The retry below follows an apt-get this script may itself have just
# killed, and an immediate second `apt-get update` loses to the dying one's lock
# with `Could not get lock /var/lib/apt/lists/lock`, which reads as a failed
# verification when it is really a race with our own cleanup.
#
# NOT `flock(1)`: apt takes fcntl() locks on those files, which flock does not
# observe, so a flock probe would report the lock free while apt holds it. The
# portable question with a true answer is whether an apt/dpkg process is alive.
_wait_for_apt_lock_free() {
  local waited=0 procs
  procs="$(_apt_procs)"
  if [ "$procs" = "ps-unreadable" ]; then
    echo "::warning::Could not read the process list, so whether an apt/dpkg process still holds the lists lock is unknown. Retrying the verification immediately; a lock error below means the retry lost that race."
    return 0
  fi
  [ -z "$procs" ] && return 0
  echo "An apt/dpkg process is still running (${procs}) — waiting up to ${APT_LOCK_WAIT_MAX_SECONDS}s for it to release the lists lock before re-verifying, instead of racing it."
  while [ "$waited" -lt "$APT_LOCK_WAIT_MAX_SECONDS" ]; do
    sleep "$APT_LOCK_POLL_SECONDS"
    waited=$((waited + APT_LOCK_POLL_SECONDS))
    procs="$(_apt_procs)"
    if [ -z "$procs" ]; then
      echo "The apt/dpkg process exited after ~${waited}s — the lists lock is free, re-verifying now."
      return 0
    fi
  done
  echo "::warning::An apt/dpkg process (${procs}) is STILL running after ${APT_LOCK_WAIT_MAX_SECONDS}s. Re-verifying anyway; a lock error below is that process, not a broken mirror list."
  return 0
}

# 0 = apt refreshed its lists AND the verification package has a candidate.
# Everything printed; no channel discarded (`verification-integrity.md`).
_verify_lists() {
  local out rc=0
  if [ -n "$APT_UPDATE_CMD" ]; then
    if command -v timeout >/dev/null 2>&1; then
      # THE PRIVILEGE PREFIX GOES OUTSIDE, THE TIMEOUT INSIDE (round 4 review
      # DS-M-2). Two separate defects in `timeout … sh -c "sudo apt-get update"`:
      # `timeout` signals its direct child, so with `sh -c` in the way the
      # signal reaches the shell (or sudo), never apt-get, and sudo does not
      # relay SIGKILL to the command it launched. The orphaned apt-get then
      # keeps /var/lib/apt/lists/lock and the immediate retry fails on the lock
      # rather than on anything about the mirror. `sudo timeout --kill-after=N`
      # puts the killer on the same side of the privilege boundary as its
      # target, and apt-get is executed directly, with no shell to absorb the
      # signal.
      # shellcheck disable=SC2086  # deliberate word-splitting: a command line
      out="$(${SUDO} timeout --kill-after="$APT_UPDATE_KILL_AFTER_SECONDS" "$APT_UPDATE_TIMEOUT_SECONDS" ${APT_UPDATE_CMD} 2>&1)" || rc=$?
    else
      # No `timeout` (macOS, where the guard suite also runs): no bound to
      # apply, and still no shell in the way.
      # shellcheck disable=SC2086  # deliberate word-splitting: a command line
      out="$(${SUDO} ${APT_UPDATE_CMD} 2>&1)" || rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
      echo "apt-get update exited ${rc} (124 = hit the ${APT_UPDATE_TIMEOUT_SECONDS}s timeout). Last lines:"
      printf '%s\n' "$out" | tail -8
      return 1
    fi
    printf '%s\n' "$out" | tail -3
  fi
  out="$(${APT_POLICY_CMD} "$APT_VERIFY_PKG" 2>&1)"
  printf '%s\n' "$out" | head -5
  printf '%s' "$out" | grep -qE 'Candidate: *[0-9]' || return 1
  return 0
}

if [ ! -f "$MIRRORS_FILE" ]; then
  echo "::warning::${MIRRORS_FILE} does not exist — this runner does not use a mirror list, so apt keeps whatever sources it has. The install is unaffected."
  exit 0
fi

# A FILE, not a `$(cat …)` string (round 4 review CR-M-2 / SPEC-L-3 / DS-L-1 /
# BM-H-1 / SR-L-8). Command substitution strips every trailing newline and, with
# `2>&1`, would fold an error message into the "original" it later restores — so
# a rollback could write a mirror list that differs from the runner's own by a
# newline, or worse, by a `cat:` diagnostic. A copy on disk is byte-exact, and
# `cmp` can then prove the restore rather than assert it.
BACKUP="$(mktemp)"
trap 'rm -f "$BACKUP"' EXIT
if ! cp "$MIRRORS_FILE" "$BACKUP"; then
  echo "::warning::Could not copy ${MIRRORS_FILE} aside, so there would be nothing byte-exact to roll back to. Leaving apt's mirror list exactly as it is; the install runs against the sources the runner shipped with."
  exit 0
fi
echo "Mirror list before (${MIRRORS_FILE}):"
head -10 "$BACKUP"

rewrote=0
if ! grep -qE '://[^/]*ec2\.archive\.ubuntu\.com/' "$BACKUP"; then
  echo "Mirror list unchanged: no *.ec2.archive.ubuntu.com host in ${MIRRORS_FILE}. This runner already fetches from a mirror that measured fast (the green runs' azure host), so there is nothing to rewrite."
elif ! printf '%s\n' "$OFFICIAL_MIRRORS" | ${SUDO} tee "$MIRRORS_FILE" >/dev/null 2>&1; then
  echo "::warning::Could not write ${MIRRORS_FILE} — apt keeps the ec2 mirror and this leg may fetch at the slow rate. The install is unaffected otherwise."
else
  # Assert the ARTIFACT, never the exit status of tee
  # (`.claude/rules/common/verification-integrity.md`): a write that reported
  # success while leaving the ec2 host in place would otherwise read as a fix.
  echo "Mirror list after:"
  head -10 "$MIRRORS_FILE"
  # ANCHORED ON THE HOST FIELD (round 4 review DS-L-2). A bare
  # `grep archive\.ubuntu\.com` is a substring match, so it is also satisfied by
  # `azure.archive.ubuntu.com` and by every `*.ec2.archive.ubuntu.com` host this
  # rewrite exists to remove — i.e. the check could confirm "the official
  # archive is named" while reading a list of nothing but ec2 mirrors. Canonical's
  # own hosts are exactly `archive.ubuntu.com` and `security.ubuntu.com` with
  # nothing before the dot, and `://` plus the trailing `/` pin both ends of the
  # host field.
  if grep -qE '://[^/]*ec2\.archive\.ubuntu\.com/' "$MIRRORS_FILE" ||
    ! grep -qE '://(archive|security)\.ubuntu\.com/' "$MIRRORS_FILE"; then
    echo "::warning::${MIRRORS_FILE} was written but still does not name the official archive — apt may keep fetching from the ec2 mirror. Shown above is what the file actually holds."
  else
    rewrote=1
    echo "apt will fetch from the official Ubuntu archive for this job."
  fi
fi

# ── The verification. Runs on every path, rewritten or not: the leg that broke
# in CI would have been diagnosed here, and the rewrite was not its cause.
if _verify_lists; then
  echo "apt package lists refreshed and ${APT_VERIFY_PKG} is resolvable — the deps step can install from universe."
  exit 0
fi

echo "::warning::apt cannot resolve ${APT_VERIFY_PKG} (a universe package every playwright install-deps needs). The deps step would fail with 'E: Unable to locate package ${APT_VERIFY_PKG}' and exit 100. Evidence below."
_dump_sources

if [ "$rewrote" = "0" ]; then
  echo "::warning::This script changed no file on this runner, so the unresolvable package set is not its doing. The deps step will report apt's own error."
  exit 0
fi

echo "Rolling back the mirror list to what the runner shipped with, then re-verifying."
# `cp`, not `mv` and not `cp -p`: the live file is root-owned and must stay that
# way, and both of those would hand it the backup's ownership and mode.
if ! ${SUDO} cp "$BACKUP" "$MIRRORS_FILE"; then
  echo "::warning::Could not restore ${MIRRORS_FILE} from the byte-exact copy taken before the rewrite. apt keeps the rewritten list for the rest of this job."
elif cmp -s "$BACKUP" "$MIRRORS_FILE"; then
  # The ARTIFACT, not the exit status (verification-integrity.md): the claim
  # "rolled back" is only made once the bytes on disk match the bytes taken
  # before the rewrite.
  echo "Rolled back: ${MIRRORS_FILE} is byte-for-byte what the runner shipped with (cmp)."
else
  echo "::warning::${MIRRORS_FILE} was rewritten from the backup but still does not match it byte for byte. Shown above is what the file holds."
fi
_wait_for_apt_lock_free
if _verify_lists; then
  echo "Recovered: with the original mirror list ${APT_VERIFY_PKG} is resolvable again. This leg fetches from the runner's own (slow) mirror."
  exit 0
fi
echo "::warning::Still unresolvable with the original mirror list, so the mirror list is not the cause. The deps step will report apt's own error."
exit 0
