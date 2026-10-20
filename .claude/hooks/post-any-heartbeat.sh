#!/usr/bin/env bash
# ECC stable id: post:any:heartbeat
#
# Purpose: one line per completed tool call of an agent workspace, so that the
# silence the watchdog kills on becomes a MEASURED number instead of an
# inference. Consumer: scripts/devops/check-stream-silence.sh.
#
# ── WHY THE EXISTING LOG CANNOT ANSWER THIS ─────────────────────────────────
#
# post:edit-write:coder-progress has recorded durable activity since Phase 2.5,
# but only for Edit/Write/MultiEdit/NotebookEdit. That makes it blind to every
# shape that actually produces silence: tests run back to back, a dev-server
# boot, a whole-file read, a long think. On 2026-10-20 five agents were cut in
# one day and that log holds TWO lines for the whole day — not because the
# agents were idle, but because the thing that killed them was never an edit.
#
# So a cut agent and an agent that finished and forgot to report were
# indistinguishable, and stream-watchdog.md said as much: it fell back on `wip:`
# commits to tell them apart, i.e. on the very discipline whose absence is the
# failure being diagnosed. A heartbeat on every tool call is the independent
# witness.
#
# WHAT IT CAN AND CANNOT SEE. A hook runs when the stream has just spoken, so a
# gap between two consecutive heartbeats is a stretch of silence the agent
# SURVIVED, measured exactly. The stretch that kills leaves no closing
# heartbeat: the ledger simply ends, and the distance from its last line to the
# agent's death is the silence that did it. Both are read by the checker; a
# long survived gap is the leading indicator (one slow retry from a cut), the
# truncated tail is the post-mortem.
#
# Contract: PostToolUse, broad matcher. exit 0 ALWAYS — observation only, never
# refuses, so the meta-guard lists it as advisory (same standing as
# post:edit-write:coder-progress). Kept deliberately free of python: it runs on
# every tool call of every agent, so the budget is a few milliseconds.
#
# Rotation: > 1 MB -> agent-heartbeat.log.old (overwrites the previous .old; the
# checker only ever reads recent history, so deeper history is throwaway).
#
# Env (tests only): HEARTBEAT_LOG pins the destination.

set -u

INPUT=$(cat 2>/dev/null || true)

TOOL=$(printf '%s' "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' |
  head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -z "$TOOL" ] && TOOL="<unknown>"

# Agent workspaces only: the orchestrator's own checkout is not at risk from
# the watchdog in the way an auto-removable worktree is, and logging it would
# bury the signal.
case "$PWD" in
*/.claude/worktrees/*) ;;
*) exit 0 ;;
esac

LOG_FILE="${HEARTBEAT_LOG:-}"
if [ -z "$LOG_FILE" ]; then
  COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
  [ -z "$COMMON_DIR" ] && exit 0
  MAIN_REPO=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd) || exit 0
  [ -z "$MAIN_REPO" ] && exit 0
  LOG_FILE="$MAIN_REPO/.claude/agent-heartbeat.log"
fi

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || exit 0

if [ -f "$LOG_FILE" ]; then
  SIZE=$(wc -c <"$LOG_FILE" 2>/dev/null || echo 0)
  if [ "${SIZE:-0}" -gt 1048576 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null || true
  fi
fi

# Epoch first so the checker needs no date parsing; ISO second so a human
# reading the tail does not need a converter. Single short line -> the append
# is atomic (POSIX guarantees it under PIPE_BUF).
printf '%s\t%s\t%s\t%s\n' \
  "$(date -u +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TOOL" "$PWD" \
  >>"$LOG_FILE" 2>/dev/null

exit 0
