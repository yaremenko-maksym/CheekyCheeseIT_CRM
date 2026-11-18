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
#     sockets open. The 125 MB webkit set needs ~35 min at that rate.
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
APT_UPDATE_CMD="${APT_UPDATE_CMD-${SUDO} apt-get update}"
APT_POLICY_CMD="${APT_POLICY_CMD:-apt-cache policy}"
# The step has no budget of its own, and a trickling mirror can hold an
# `apt-get update` for minutes. A timeout here counts as a failed verification.
APT_UPDATE_TIMEOUT_SECONDS="${APT_UPDATE_TIMEOUT_SECONDS:-120}"
APT_SOURCES_PATHS="${APT_SOURCES_PATHS:-/etc/apt/sources.list /etc/apt/sources.list.d}"

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

# 0 = apt refreshed its lists AND the verification package has a candidate.
# Everything printed; no channel discarded (`verification-integrity.md`).
_verify_lists() {
  local out rc=0
  if [ -n "$APT_UPDATE_CMD" ]; then
    if command -v timeout >/dev/null 2>&1; then
      out="$(timeout "$APT_UPDATE_TIMEOUT_SECONDS" sh -c "$APT_UPDATE_CMD" 2>&1)" || rc=$?
    else
      out="$(sh -c "$APT_UPDATE_CMD" 2>&1)" || rc=$?
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

original="$(cat "$MIRRORS_FILE" 2>&1)"
echo "Mirror list before (${MIRRORS_FILE}):"
printf '%s\n' "$original" | head -10

rewrote=0
if ! printf '%s' "$original" | grep -q 'ec2\.archive\.ubuntu\.com'; then
  echo "Mirror list unchanged: no *.ec2.archive.ubuntu.com host in ${MIRRORS_FILE}. This runner already fetches from a mirror that measured fast (the green runs' azure host), so there is nothing to rewrite."
elif ! printf '%s\n' "$OFFICIAL_MIRRORS" | ${SUDO} tee "$MIRRORS_FILE" >/dev/null 2>&1; then
  echo "::warning::Could not write ${MIRRORS_FILE} — apt keeps the ec2 mirror and this leg may fetch at the slow rate. The install is unaffected otherwise."
else
  # Assert the ARTIFACT, never the exit status of tee
  # (`.claude/rules/common/verification-integrity.md`): a write that reported
  # success while leaving the ec2 host in place would otherwise read as a fix.
  after="$(cat "$MIRRORS_FILE" 2>&1)"
  echo "Mirror list after:"
  printf '%s\n' "$after" | head -10
  if printf '%s' "$after" | grep -q 'ec2\.archive\.ubuntu\.com' ||
    ! printf '%s' "$after" | grep -q 'archive\.ubuntu\.com'; then
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
printf '%s\n' "$original" | ${SUDO} tee "$MIRRORS_FILE" >/dev/null 2>&1 ||
  echo "::warning::Could not restore ${MIRRORS_FILE}."
if _verify_lists; then
  echo "Recovered: with the original mirror list ${APT_VERIFY_PKG} is resolvable again. This leg fetches from the runner's own (slow) mirror."
  exit 0
fi
echo "::warning::Still unresolvable with the original mirror list, so the mirror list is not the cause. The deps step will report apt's own error."
exit 0
