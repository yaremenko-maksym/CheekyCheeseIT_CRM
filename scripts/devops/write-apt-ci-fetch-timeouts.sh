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
#   defaults            `apt-get update` gave the item up after 127s
#                       (compiled-in `Acquire::http::Timeout` is 120s and
#                       nothing retries it)
#   Timeout 30 + Retries 5
#                       212s — the knobs ARE honoured, and Retries multiplies
#                       total patience rather than reducing it
#
# So "apt never times out a stalled fetch" is NOT true. What the defaults do
# wrong is cheaper to state: one 120s wait per item on a socket that is already
# dead, and no reconnect. 181 packages give that shape room to look like
# minutes of silence, because apt prints `Get:` when an item STARTS and prints
# nothing while it times one out.
#
# Hence: abort a silent socket after 30s and reconnect, up to 3 times. Per-item
# worst case stays 4 × 30s = 120s — the same ceiling the defaults already
# spend — but each of those 30s windows is a FRESH connection, which is the
# part that can actually recover. `Pipeline-Depth "0"` removes the other way
# one dead socket costs more than one item: with pipelining on (apt's default
# depth is 10), queued responses behind a stalled one are lost with it.
#
# NON-FATAL BY CONSTRUCTION. A malformed apt.conf.d file breaks EVERY later apt
# command on the runner, chromium legs included, so the file is validated with
# `apt-config dump` after writing and removed again if apt will not parse it.
# Neither a failed write nor a failed validation fails the step: without the
# drop-in the install behaves exactly as it does today.
#
# Env:
#   APT_CONF_FILE   where to write (default:
#                   /etc/apt/apt.conf.d/99-ci-fetch-timeouts) — overridable so
#                   the guard test can assert the content without root.
#   APT_SUDO        command prefix for the write (default: sudo, or empty when
#                   already root / when APT_CONF_FILE is writable).
set -uo pipefail

APT_CONF_FILE="${APT_CONF_FILE:-/etc/apt/apt.conf.d/99-ci-fetch-timeouts}"

if [ -n "${APT_SUDO+x}" ]; then
  sudo_cmd="$APT_SUDO"
elif [ "$(id -u)" = "0" ]; then
  sudo_cmd=""
else
  sudo_cmd="sudo"
fi

read -r -d '' conf <<'CONF' || true
// Written by scripts/devops/write-apt-ci-fetch-timeouts.sh (CI only).
// A stalled archive socket is aborted and re-opened instead of being waited
// out: 4 x 30s worst case per item, the same ceiling as apt's own 120s default,
// but each window is a fresh connection. Pipeline-Depth 0 keeps one dead
// socket from taking the responses queued behind it.
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::ftp::Timeout "30";
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
apt-config dump 2>/dev/null | grep -E '^Acquire::(http|https|ftp)::(Timeout|Pipeline-Depth)|^Acquire::Retries' || {
  echo "::warning::apt-config dump printed no Acquire fetch keys — the drop-in may not be in effect."
}
exit 0
