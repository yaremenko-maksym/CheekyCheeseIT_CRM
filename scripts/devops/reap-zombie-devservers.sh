#!/bin/bash
# reap-zombie-devservers.sh — external supervisor ("reaper") for dev servers
# left behind by Claude agent sessions.
#
# Kills node/esbuild processes whose command line points into a Claude agent
# worktree (.claude/worktrees/**) or scratchpad (/tmp/claude-*/**) when:
#   (a) the referenced path no longer exists on disk (worktree deleted →
#       the process is an orphan by definition), OR
#   (b) the process is older than REAPER_MAX_AGE_SECONDS (default 6h — no
#       agent task legitimately keeps a dev server that long; in-flight
#       agents are always younger).
#
# Never touches main-repo processes (standing UT stack on :3000/:3001) —
# candidates must carry the worktree/scratchpad marker in argv, and only
# node/esbuild executables qualify (shells, git, claude binaries are skipped).
#
# Installed as a launchd agent (every 30 min) by install-devserver-reaper.sh.
# Manual dry-run: REAPER_DRY_RUN=1 scripts/devops/reap-zombie-devservers.sh
set -u

MAX_AGE="${REAPER_MAX_AGE_SECONDS:-21600}"
DRY_RUN="${REAPER_DRY_RUN:-0}"
LOG="${REAPER_LOG:-$HOME/Library/Logs/cheekycheeseit-devserver-reaper.log}"
MARKER='\.claude/worktrees/|/tmp/claude-'

log() {
  mkdir -p "$(dirname "$LOG")"
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"
}

# ps etime formats: SS / MM:SS / HH:MM:SS / DD-HH:MM:SS
etime_to_seconds() {
  local e="$1" days=0 h=0 m=0 s=0
  case "$e" in *-*)
    days="${e%%-*}"
    e="${e#*-}"
    ;;
  esac
  local IFS=:
  # shellcheck disable=SC2086
  set -- $e
  case $# in
  3)
    h=$1 m=$2 s=$3
    ;;
  2)
    m=$1 s=$2
    ;;
  1)
    s=$1
    ;;
  esac
  echo $((${days:-0} * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}

VICTIMS=()
REASONS=()

while IFS= read -r pid; do
  [ -n "$pid" ] || continue
  cmdline=$(ps -p "$pid" -o command= 2>/dev/null) || continue
  comm=$(ps -p "$pid" -o comm= 2>/dev/null) || continue
  base=$(basename "$comm")
  # Executable allow-list: dev servers / their build sidecars only.
  case "$base" in node | esbuild) ;; *) continue ;; esac
  echo "$cmdline" | grep -qE "$MARKER" || continue

  reason=""
  # Rule (a): orphan — the worktree/scratchpad file it runs is gone.
  ref=$(echo "$cmdline" | tr ' ' '\n' | grep -E "$MARKER" | head -1)
  if [ -n "$ref" ] && [ ! -e "$ref" ]; then
    reason="orphan (path gone: $ref)"
  else
    # Rule (b): age.
    etime=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ') || continue
    [ -n "$etime" ] || continue
    age=$(etime_to_seconds "$etime")
    if [ "$age" -gt "$MAX_AGE" ]; then
      reason="age ${age}s > ${MAX_AGE}s"
    fi
  fi
  [ -n "$reason" ] || continue
  VICTIMS+=("$pid")
  REASONS+=("pid=$pid $reason :: ${cmdline:0:160}")
done < <(pgrep -f "$MARKER")

if [ "${#VICTIMS[@]}" -eq 0 ]; then
  exit 0 # quiet no-op — keep the log signal-only
fi

for r in "${REASONS[@]}"; do log "REAP $r"; done

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "${REASONS[@]}"
  log "DRY_RUN — no kills"
  exit 0
fi

# zsh lesson from the 2026-07-24 sweep: never `kill $LIST` — xargs only.
printf '%s\n' "${VICTIMS[@]}" | xargs kill -TERM 2>/dev/null
sleep 5
ALIVE=()
for pid in "${VICTIMS[@]}"; do
  kill -0 "$pid" 2>/dev/null && ALIVE+=("$pid")
done
if [ "${#ALIVE[@]}" -gt 0 ]; then
  printf '%s\n' "${ALIVE[@]}" | xargs kill -KILL 2>/dev/null
  log "KILL escalated for: ${ALIVE[*]}"
fi
log "reaped ${#VICTIMS[@]} process(es)"

# Cap log size.
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 1000 ]; then
  tail -n 500 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
