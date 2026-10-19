#!/usr/bin/env bash
#
# scan-api-permission-denied.sh — the runner-side driver of the standing 42501 watch.
# Opens ONE read-only plain-`ssh` session, runs api-permission-denied-remote.sh on the
# VPS, and pipes its stdout STRAIGHT into check-api-permission-denied.sh. The pipe's
# exit status is the checker's (0 clean / 1 hit / 2 blind), or ssh's if that is worse.
#
# WHY PLAIN ssh AND NOT appleboy/ssh-action (fix round 1, SR-H-1 / SR-M-1 / SR-M-3):
#   - the action prints a banner into its own stdout, and its capture_stdout writes
#     `{ ... | tee -a "$GITHUB_OUTPUT"; } >> "$GITHUB_OUTPUT"`, i.e. EVERY chunk twice.
#     The checker rightly refuses both, so as wired every run was BLIND, clean or hit;
#   - drone-ssh 1.8.1 routes remote STDERR through the same writer as stdout, so stderr
#     also landed in the captured output (the earlier claim that it streamed was wrong);
#   - the captured output reached the next step through `env:`, which the job log renders
#     BEFORE the checker runs, so the checker's second lock was decorative. Here nothing
#     is captured, rendered or round-tripped: the checker is in the pipe;
#   - it removes a third-party action, pinned by tag, that downloads its binary at runtime
#     with no checksum, from a path that carries the deploy key 48 times a day.
#
# Remote stderr and ssh's own diagnostics go to THIS step's stderr (the job log). The
# remote script writes no log text to stderr (docker's is folded into a variable), and
# the tests assert that.
#
# Env (the workflow supplies them; secrets arrive via env: and are never interpolated):
#   VPS_HOST VPS_USER VPS_SSH_KEY          required
#   VPS_KNOWN_HOSTS                         optional repo VARIABLE (public host-key lines);
#                                           unset = trust-on-first-use via ssh-keyscan, with
#                                           a warning. Same trust level as the deploy today
#                                           (ssh-action with no fingerprint), made visible.
#   LOGSCAN_RE LOGSCAN_CONTRACT_RE LOGSCAN_SINCE LOGSCAN_TABLES LOGSCAN_LOGGERS   required (the cfg step)
#   SSH_PORT                                optional, default 22 (tests)
#   SSH_EXTRA_OPTS                          optional, word-split, tests only
# NOTHING here creates, rotates or installs a credential: it reads the existing key into
# a 0600 temp file removed on exit.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="$SELF_DIR/api-permission-denied-remote.sh"
CHECKER="$SELF_DIR/check-api-permission-denied.sh"

die() { echo "::error title=API permission-denied watch is BLIND::$1"; exit 2; }

for v in VPS_HOST VPS_USER VPS_SSH_KEY LOGSCAN_RE LOGSCAN_CONTRACT_RE LOGSCAN_SINCE LOGSCAN_TABLES LOGSCAN_LOGGERS; do
  [ -n "${!v:-}" ] || die "required input $v is empty (a missing secret must not look like a clean scan)"
done
# These land on an ssh command line: no leading '-', no whitespace, no shell syntax.
printf '%s' "$VPS_HOST" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$' || die "VPS_HOST has an unexpected shape"
printf '%s' "$VPS_USER" | grep -Eq '^[A-Za-z_][A-Za-z0-9._-]{0,31}$' || die "VPS_USER has an unexpected shape"
printf '%s' "$LOGSCAN_SINCE" | grep -Eq '^[0-9]{1,4}[mh]$' || die "window is not <number>m or <number>h"

WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/permdenied-XXXXXX")" || die "could not create a temp dir"
trap 'rm -rf "$WORK"' EXIT
umask 077
printf '%s\n' "$VPS_SSH_KEY" >"$WORK/key"
chmod 600 "$WORK/key"

PORT="${SSH_PORT:-22}"
if [ -n "${VPS_KNOWN_HOSTS:-}" ]; then
  printf '%s\n' "$VPS_KNOWN_HOSTS" >"$WORK/known_hosts"
else
  echo "::warning::VPS_KNOWN_HOSTS is not set: trusting the host key on first use (ssh-keyscan). Pin it with a repo variable to remove the window."
  ssh-keyscan -T 10 -p "$PORT" "$VPS_HOST" >"$WORK/known_hosts" 2>/dev/null
  [ -s "$WORK/known_hosts" ] || die "could not obtain the VPS host key"
fi

# The payload: export lines (printf %q quotes the pattern's | ( ) [ ^), then the script.
{
  printf 'export LOGSCAN_RE=%q\n' "$LOGSCAN_RE"
  printf 'export LOGSCAN_CONTRACT_RE=%q\n' "$LOGSCAN_CONTRACT_RE"
  printf 'export LOGSCAN_SINCE=%q\n' "$LOGSCAN_SINCE"
  printf 'export LOGSCAN_TABLES=%q\n' "$LOGSCAN_TABLES"
  printf 'export LOGSCAN_LOGGERS=%q\n' "$LOGSCAN_LOGGERS"
  [ -z "${LOGSCAN_CRM_DIR:-}" ] || printf 'export LOGSCAN_CRM_DIR=%q\n' "$LOGSCAN_CRM_DIR"
  cat "$REMOTE"
} >"$WORK/payload.sh"

# shellcheck disable=SC2086  # SSH_EXTRA_OPTS is deliberately word-split (tests only)
ssh -i "$WORK/key" -p "$PORT" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$WORK/known_hosts" \
  -o LogLevel=ERROR ${SSH_EXTRA_OPTS:-} \
  "${VPS_USER}@${VPS_HOST}" 'bash -s' <"$WORK/payload.sh" \
  | bash "$CHECKER"
