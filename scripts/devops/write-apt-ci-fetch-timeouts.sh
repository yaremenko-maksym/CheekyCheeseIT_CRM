#!/usr/bin/env bash
# Write an apt drop-in that makes a STALLED archive fetch reconnect quickly
# instead of sitting on a dead socket.
#
# WHY THIS EXISTS
#
# The webkit E2E leg installs WebKit's system deps through
# `playwright install-deps webkit`, which shells out to plain
# `apt-get update` + `apt-get install` (playwright-core builds the two commands
# and spawns them through sudo; it passes no `-o` overrides and sets no
# APT_CONFIG, so /etc/apt/apt.conf.d/* is what configures them).
#
# On two runs of PR #1415 the fetch stream stopped mid-download against
# `us-east-2.ec2.archive.ubuntu.com` (last line `Get:37 ... libvpx9` on one run,
# `Get:59 ... libflite1 [13.6 MB]` on the other) and nothing was printed for
# 12+ minutes, while a green run of the same package set the same day fetched
# from `azure.archive.ubuntu.com` in seconds. The deps step was cut off by its
# own budget with its `sudo apt-get` still alive, holding the dpkg lock.
#
# WHAT WAS MEASURED (ubuntu:24.04, a server that sends headers + 1 KB and then
# stops, which is the observed shape):
#
#   apt's own compiled-in defaults
#                       `apt-get update` gave the item up after 127s
#                       (`Acquire::http::Timeout` defaults to 120s and nothing
#                       retries it)
#   Timeout 30 + Retries 5
#                       212s — the knobs ARE honoured, and Retries multiplies
#                       total patience rather than reducing it
#
# And what the GitHub runner image turned out to set on top of that, read off
# the first run of this very step (job 134876586258): `Acquire::http::Timeout
# "15"`, `Acquire::Retries "1"`, i.e. one reconnect, then the item fails.
#
# So "apt never times out a stalled fetch" is false twice over, and the 12+
# minutes of silence are not one long wait: they are MANY short ones. apt
# prints `Get:` when an item STARTS and prints nothing at all while it times one
# out and gives it up, so 181 packages behind a stalling mirror produce minutes
# of blank log with the step making real but invisible progress through
# failures.
#
# What this file changes, then, is narrower than "add a timeout":
#   * `Acquire::Retries "3"` — three reconnects per item instead of the image's
#     one, so a TRANSIENT stall is survived by apt itself rather than failing
#     the whole `apt-get install` and leaving the wrapper to retry 125 MB.
#   * `Acquire::http::Pipeline-Depth "0"` — the substantive knob. With
#     pipelining on (apt's default depth is 10) the responses queued behind a
#     stalled one are lost with it, so ONE dead socket costs many items.
#   * `Timeout "15"` — kept at the image's value, not relaxed. Per-item worst
#     case is 4 × 15s = 60s against the image's 2 × 15s = 30s: twice the
#     patience, but four fresh connections instead of two. Measured against the
#     stalling server above: 68s with this file in place, 127s on apt's bare
#     defaults, and `apt-config dump` inside the container lists all five keys,
#     so apt does read it.
#
# ORDERING MATTERS. apt reads /etc/apt/apt.conf.d/* in sorted order and the
# LAST assignment wins, so this file is named `zz-…` to sort after the image's
# own drop-ins. The first run of this step proved why: as `99-ci-fetch-timeouts`
# it was written, parsed, and then overridden — the step printed
# `Acquire::http::Timeout "15"` and `Acquire::Retries "1"` back. The script now
# compares the EFFECTIVE values with the requested ones and warns on a
# mismatch, so a future override is visible instead of silent.
#
# NON-FATAL BY CONSTRUCTION. A malformed apt.conf.d file breaks EVERY later apt
# command on the runner, chromium legs included, so the file is validated with
# `apt-config dump` after writing and removed again if apt will not parse it.
# Neither a failed write nor a failed validation fails the step: without the
# drop-in the install behaves exactly as it does today.
#
# Env:
#   APT_CONF_FILE   where to write (default:
#                   /etc/apt/apt.conf.d/zz-ci-fetch-timeouts) — overridable so
#                   the guard test can assert the content without root.
#   APT_SUDO        command prefix for the write (default: sudo, or empty when
#                   already root / when APT_CONF_FILE is writable).
set -uo pipefail

APT_CONF_FILE="${APT_CONF_FILE:-/etc/apt/apt.conf.d/zz-ci-fetch-timeouts}"

if [ -n "${APT_SUDO+x}" ]; then
  sudo_cmd="$APT_SUDO"
elif [ "$(id -u)" = "0" ]; then
  sudo_cmd=""
else
  sudo_cmd="sudo"
fi

read -r -d '' conf <<'CONF' || true
// Written by scripts/devops/write-apt-ci-fetch-timeouts.sh (CI only).
// A stalled archive socket is aborted and re-opened: 4 x 15s worst case per
// item against the runner image's 2 x 15s, i.e. four fresh connections instead
// of two. Pipeline-Depth 0 keeps one dead socket from taking the responses
// queued behind it. The `zz-` filename is load-bearing: apt reads
// /etc/apt/apt.conf.d/* in sorted order and the last assignment wins.
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::ftp::Timeout "15";
Acquire::Retries "3";
Acquire::http::Pipeline-Depth "0";
CONF

if ! printf '%s' "$conf" | ${sudo_cmd} tee "$APT_CONF_FILE" >/dev/null 2>&1; then
  echo "::warning::Could not write ${APT_CONF_FILE} — apt keeps its default fetch timeouts for this run. The install is unaffected otherwise."
  exit 0
fi

# An unparsable drop-in would break every apt command on this runner, so prove
# apt reads it before leaving it in place.
if ! APT_CONFIG="" apt-config dump >/dev/null 2>&1; then
  echo "::warning::apt refused to parse ${APT_CONF_FILE} — removing it and keeping apt's default fetch timeouts."
  ${sudo_cmd} rm -f "$APT_CONF_FILE" || true
  exit 0
fi

echo "Wrote ${APT_CONF_FILE}. Effective apt fetch config:"
# Evidence that apt actually READ the file, not merely that it exists.
effective="$(apt-config dump 2>/dev/null | grep -E '^Acquire::(http|https|ftp)::(Timeout|Pipeline-Depth)|^Acquire::Retries' || true)"
if [ -z "$effective" ]; then
  echo "::warning::apt-config dump printed no Acquire fetch keys — the drop-in may not be in effect."
  exit 0
fi
printf '%s\n' "$effective"

# A drop-in that is READ can still be OVERRIDDEN by a file sorting after it,
# which is exactly what happened on the first run of this step. Compare the
# values apt reports with the ones asked for, and say so when they differ: a
# silent no-op is the failure mode worth catching here.
mismatch=""
printf '%s\n' "$effective" | grep -q 'Acquire::Retries "3";' || mismatch="${mismatch} Acquire::Retries"
printf '%s\n' "$effective" | grep -q 'Acquire::http::Timeout "15";' || mismatch="${mismatch} Acquire::http::Timeout"
printf '%s\n' "$effective" | grep -q 'Acquire::http::Pipeline-Depth "0";' || mismatch="${mismatch} Acquire::http::Pipeline-Depth"
if [ -n "$mismatch" ]; then
  echo "::warning::${APT_CONF_FILE} was written and parsed, but apt reports different effective values for:${mismatch} — another file under /etc/apt/apt.conf.d/ sorts after this one and wins. The install proceeds with the effective values above."
fi
exit 0
