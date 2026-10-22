#!/usr/bin/env bash
# check-stream-silence.sh — turn the watchdog's invisible failure into a number.
#
# Reads the heartbeat ledger written by .claude/hooks/post-any-heartbeat.sh
# (one line per completed tool call of an agent workspace) and reports, per
# workspace, every stretch of silence at or over the threshold.
#
# WHY IT EXISTS. The harness cuts an agent after 600 s with nothing on its
# stream. Until this script, nobody could say afterwards how close an agent had
# come, or which stretch had killed it: stream-watchdog.md's own observability
# row fell back on "a transcript that ends mid-stretch … and no `wip:` commit",
# which is a reading, by hand, of the thing whose absence is the defect. On
# 2026-10-20 five agents were cut in one day and nothing in the repository
# recorded a single one.
#
# TWO SIGNALS, and the difference matters:
#   SURVIVED  a gap between two consecutive heartbeats. The agent lived through
#             it. At 480 s of a 600 s budget it is one slow retry from a cut —
#             a leading indicator, and the one worth acting on.
#   TRAILING  the last heartbeat of a workspace is older than the threshold and
#             the workspace is still the newest thing in the ledger. Either the
#             agent is inside a silent stretch right now, or it was cut there.
#             This is the post-mortem signal.
#
# NOT A CI GATE, on purpose. The ledger is machine-local and per-run: it
# describes this laptop's agents, not the repository's content, so there is
# nothing for a workflow to check out and reconcile against. It is run by
# Master at acceptance (stream-watchdog.md "How we know it is violated") and by
# anyone investigating a cut. The test proves the red, which is what makes the
# number believable; CI has nothing to add.
#
# EXIT: 0 = no stretch at or over the threshold. 1 = at least one found (the
# red). 2 = usage / unreadable ledger.
#
# Usage:
#   scripts/devops/check-stream-silence.sh [--log PATH] [--threshold SECONDS]
#                                          [--now EPOCH] [--quiet]
#
#   --threshold  default 480 (80% of the 600 s budget).
#   --now        pins "now" for the TRAILING computation; tests use it, and so
#                does anyone reading an old ledger.

set -u

LOG=""
THRESHOLD=480
NOW=""
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
  --log)
    LOG="${2:-}"
    shift 2
    ;;
  --threshold)
    THRESHOLD="${2:-}"
    shift 2
    ;;
  --now)
    NOW="${2:-}"
    shift 2
    ;;
  --quiet)
    QUIET=1
    shift
    ;;
  -h | --help)
    sed -n '1,45p' "$0"
    exit 0
    ;;
  *)
    echo "check-stream-silence.sh: unknown argument '$1'" >&2
    exit 2
    ;;
  esac
done

if [ -z "$LOG" ]; then
  COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$COMMON_DIR" ]; then
    MAIN_REPO=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd || true)
    [ -n "$MAIN_REPO" ] && LOG="$MAIN_REPO/.claude/agent-heartbeat.log"
  fi
fi

if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  echo "check-stream-silence.sh: no heartbeat ledger at '${LOG:-<unresolved>}'." >&2
  echo "  It is written by .claude/hooks/post-any-heartbeat.sh and appears once an" >&2
  echo "  agent has run a tool in its own worktree. Nothing to reconcile." >&2
  exit 2
fi

case "$THRESHOLD" in
'' | *[!0-9]*)
  echo "check-stream-silence.sh: --threshold must be a whole number of seconds" >&2
  exit 2
  ;;
esac

[ -z "$NOW" ] && NOW=$(date -u +%s)

OUT=$(awk -F'\t' -v th="$THRESHOLD" -v now="$NOW" '
  $1 ~ /^[0-9]+$/ && NF >= 4 {
    ws = $4
    if (ws in last) {
      gap = $1 - last[ws]
      if (gap >= th) {
        printf "SURVIVED\t%d\t%s\t%s\t%s -> %s\n", gap, ws, lastiso[ws], lasttool[ws], $3
        n++
      }
    }
    last[ws] = $1; lastiso[ws] = $2; lasttool[ws] = $3
    if ($1 > newest) newest = $1
    seen[ws] = 1
  }
  END {
    for (ws in seen) {
      gap = now - last[ws]
      if (gap >= th) {
        printf "TRAILING\t%d\t%s\t%s\t%s -> (nothing since)\n", gap, ws, lastiso[ws], lasttool[ws]
        n++
      }
    }
    exit (n > 0 ? 1 : 0)
  }
' "$LOG")
RC=$?

if [ "$QUIET" -eq 0 ]; then
  echo "== check-stream-silence.sh =="
  echo "ledger:    $LOG"
  echo "threshold: ${THRESHOLD}s of the 600s watchdog budget"
  echo
  if [ "$RC" -eq 0 ]; then
    echo "OK: no agent workspace went quiet for ${THRESHOLD}s or more."
  else
    printf '%-9s %8s  %s\n' "KIND" "SECONDS" "WORKSPACE / LAST HEARTBEAT / TOOLS AROUND THE GAP"
    printf '%s\n' "$OUT" | awk -F'\t' '{ printf "%-9s %8s  %s\n           %s   %s\n", $1, $2, $3, $4, $5 }'
    echo
    echo "SURVIVED = the agent lived through that silence; at ${THRESHOLD}s it is one slow"
    echo "           retry from a cut. TRAILING = it is inside a silent stretch now, or"
    echo "           it was cut there."
    echo "Next: check whether that workspace's branch has anything PUSHED — that is what"
    echo "      decides whether a cut costs a re-read or the whole stretch."
    echo "Rule: .claude/rules/common/stream-watchdog.md"
  fi
fi

exit "$RC"
