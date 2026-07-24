#!/bin/bash
# dev-ttl.sh — TTL wrapper for dev servers started by Claude agents.
#
# Guarantees a dev server cannot outlive its task: the wrapped command runs
# in its own process group, and a detached sidecar timer kills that whole
# group when the TTL expires — even if the wrapper (or the agent session
# that spawned it) dies hard without cleanup.
#
# Context: 2026-07-24 incident — 67 orphaned nest/vite processes accumulated
# from agent worktrees (2026-07-12..15) drove the host into swap thrash
# (load average 70, swap 18.7/19.4 GB). Cleanup invariants must live in the
# process itself, not in agent discipline.
#
# Usage:
#   scripts/devops/dev-ttl.sh [--ttl <seconds>] -- <command> [args...]
# Examples:
#   scripts/devops/dev-ttl.sh -- pnpm --filter @crm/api dev
#   scripts/devops/dev-ttl.sh --ttl 7200 -- node apps/api/dist/main
#
# Default TTL: 4h (override with --ttl or DEV_TTL_SECONDS).
# Enforcement: hook pre:bash:devserver-ttl-gate blocks raw dev-server boots
# inside .claude/worktrees/** and claude scratchpads without this wrapper.
set -u

TTL="${DEV_TTL_SECONDS:-14400}"
if [ "${1:-}" = "--ttl" ]; then
  TTL="${2:?--ttl requires a value}"
  shift 2
fi
[ "${1:-}" = "--" ] && shift
if [ "$#" -lt 1 ]; then
  echo "usage: dev-ttl.sh [--ttl <seconds>] -- <command> [args...]" >&2
  exit 64
fi
case "$TTL" in
  '' | *[!0-9]*)
    echo "dev-ttl: TTL must be integer seconds, got '$TTL'" >&2
    exit 64
    ;;
esac

# Job control on: each background job below gets its OWN process group, so
# (a) a group-kill reaches every child the server spawns, and (b) the sidecar
# keeps ticking even if the wrapper's own process group is wiped out.
set -m
"$@" &
CHILD=$!
(
  trap '' INT TERM HUP
  sleep "$TTL"
  echo "[dev-ttl] TTL ${TTL}s expired — killing process group $CHILD" >&2
  kill -s TERM -- "-$CHILD" 2>/dev/null
  sleep 10
  kill -s KILL -- "-$CHILD" 2>/dev/null
) &
KILLER=$!
set +m

shutdown() {
  kill -s TERM -- "-$CHILD" 2>/dev/null
  kill -s KILL -- "-$KILLER" 2>/dev/null
}
trap shutdown INT TERM

wait "$CHILD"
STATUS=$?
# Server exited (or was reaped) — retire the sidecar and its sleep.
kill -s KILL -- "-$KILLER" 2>/dev/null
exit "$STATUS"
