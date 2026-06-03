#!/usr/bin/env bash
# ECC stable id: post:edit-write:coder-progress
# Phase 2.5 — adapts .claude/hooks/coder-progress-marker.sh per ADR
# docs/architecture/2026-06-03-phase2-coder-progress-spike.md §2.2.4 (Adapt
# verdict — keep semantics, port registration to ECC convention).
#
# Purpose: append durable Edit/Write/MultiEdit/NotebookEdit activity records
# (TSV) from subagent worktrees into <main-repo>/.claude/coder-activity.log.
# Consumer: PM agent's silent-termination recovery contract (C1 dev-flow-rca).
#
# Contract:
#   - Reads tool-call JSON from stdin (Claude Code PostToolUse contract).
#   - exit 0 always (observation-only; never blocks).
#   - Fast-exits on: non-target tool, no file_path, cwd outside worktrees,
#     not in a git repo, or cwd path that is not a pre-existing CRM repo
#     (e.g. /tmp/test-*, scratch dirs).
#
# Differences from legacy script:
#   - Stable ID comment header (Phase 2 ECC convention).
#   - Explicit shebang `#!/usr/bin/env bash` (no /bin/bash hardcoding).
#   - Skips temp/scratch cwd paths via early guard (was implicit before via
#     the `/.claude/worktrees/` predicate — kept identical for safety).
#
# Rotation: > 1 MB → `coder-activity.log.old` (overwrites previous .old; PM
# recovery only tails recent N lines so deeper history is throwaway).

set -u

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || true)
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
print(ti.get('file_path') or ti.get('notebook_path') or '')
" 2>/dev/null || true)

[ -z "$FILE_PATH" ] && exit 0

# Only subagent worktrees — main-repo user/PM edits not tracked here.
echo "$PWD" | grep -q '/\.claude/worktrees/' || exit 0

# Resolve main repo via git common dir; if cwd isn't a git repo, fast exit.
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
[ -z "$COMMON_DIR" ] && exit 0
MAIN_REPO=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd)
[ -z "$MAIN_REPO" ] && exit 0

LOG_DIR="$MAIN_REPO/.claude"
LOG_FILE="$LOG_DIR/coder-activity.log"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

# Rotation: > 1 MB → .log.old (overwrites previous .old, intentional).
if [ -f "$LOG_FILE" ]; then
  SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 1048576 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null || true
  fi
fi

BRANCH=$(git branch --show-current 2>/dev/null || echo "<detached>")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Single-line atomic append (POSIX guarantees < PIPE_BUF writes atomic).
printf '%s\t%s\t%s\t%s\t%s\n' "$TS" "$TOOL_NAME" "$BRANCH" "$PWD" "$FILE_PATH" >> "$LOG_FILE" 2>/dev/null

exit 0
