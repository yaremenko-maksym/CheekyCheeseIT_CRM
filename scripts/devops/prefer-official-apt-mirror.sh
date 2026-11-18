#!/usr/bin/env bash
# Point apt at the official Ubuntu archive when the runner's mirror list names
# the AWS-region `*.ec2.archive.ubuntu.com` hosts.
#
# WHY (measured, round 4 of PR #1415, not inferred):
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
#     (The `Acquire::*` drop-in this script replaces was therefore removed: a
#     timeout only helps an INACTIVE socket, and this socket was never inactive.)
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
# mirrors and installs exactly as before, with a `::warning::` saying so.
set -uo pipefail

MIRRORS_FILE="${MIRRORS_FILE:-/etc/apt/apt-mirrors.txt}"
# Order matters: apt's mirror method spreads requests over the list, so both
# hosts carry part of the fetch and either one being slow is survivable.
OFFICIAL_MIRRORS="${OFFICIAL_MIRRORS:-http://archive.ubuntu.com/ubuntu/
http://azure.archive.ubuntu.com/ubuntu/}"
SUDO="${APT_SUDO-sudo}"

if [ ! -f "$MIRRORS_FILE" ]; then
  echo "::warning::${MIRRORS_FILE} does not exist — this runner does not use a mirror list, so apt keeps whatever sources it has. The install is unaffected."
  exit 0
fi

echo "Mirror list before (${MIRRORS_FILE}):"
cat "$MIRRORS_FILE" 2>&1 | head -10

if ! grep -q 'ec2\.archive\.ubuntu\.com' "$MIRRORS_FILE"; then
  echo "Mirror list unchanged: no *.ec2.archive.ubuntu.com host in ${MIRRORS_FILE}. This runner already fetches from a mirror that measured fast (the green runs' azure host), so there is nothing to rewrite."
  exit 0
fi

if ! printf '%s\n' "$OFFICIAL_MIRRORS" | ${SUDO} tee "$MIRRORS_FILE" >/dev/null 2>&1; then
  echo "::warning::Could not write ${MIRRORS_FILE} — apt keeps the ec2 mirror and this leg may fetch at the slow rate. The install is unaffected otherwise."
  exit 0
fi

# Assert the ARTIFACT, never the exit status of tee
# (`.claude/rules/common/verification-integrity.md`): a write that reported
# success while leaving the ec2 host in place would otherwise read as a fix.
after="$(cat "$MIRRORS_FILE" 2>&1)"
echo "Mirror list after:"
printf '%s\n' "$after" | head -10
if printf '%s' "$after" | grep -q 'ec2\.archive\.ubuntu\.com' ||
  ! printf '%s' "$after" | grep -q 'archive\.ubuntu\.com'; then
  echo "::warning::${MIRRORS_FILE} was written but still does not name the official archive — apt may keep fetching from the ec2 mirror. Shown above is what the file actually holds."
  exit 0
fi

echo "apt will fetch from the official Ubuntu archive for this job."
