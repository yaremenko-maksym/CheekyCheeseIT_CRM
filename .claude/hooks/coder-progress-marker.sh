#!/bin/bash
# PostToolUse hook — записывает Edit/Write/MultiEdit активность из subagent
# worktrees в durable activity log. PM использует tail этого лога для detection
# silent termination (C1 [P0] из dev-flow RCA 2026-05-23).
#
# Лог: <main-repo>/.claude/coder-activity.log
#   - Один на репо (shared между worktrees)
#   - Append-only, по строке на Edit/Write/MultiEdit/NotebookEdit
#   - TSV формат: <ISO timestamp>\t<tool>\t<branch>\t<cwd>\t<file>
#   - Gitignored (local state, не commitable)
#
# Rotation: > 1 MB → перенос в `.log.old` (ad-hoc, без подсчёта линий — простота
# важнее точности; PM-recovery читает только последние N строк).
#
# Hook fires только если cwd внутри `.claude/worktrees/` — main-repo edits user'а
# не логируются. Это разделяет PM/user активность от agent активности.

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

# Только subagent worktrees — main-repo user edits не отслеживаем
echo "$PWD" | grep -q '/\.claude/worktrees/' || exit 0

# Найти main repo (parent of git common dir) для shared log location
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
[ -z "$COMMON_DIR" ] && exit 0
MAIN_REPO=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd)
[ -z "$MAIN_REPO" ] && exit 0

LOG_DIR="$MAIN_REPO/.claude"
LOG_FILE="$LOG_DIR/coder-activity.log"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

# Rotation: > 1 MB → .log.old (overwrites previous .old, intentional)
if [ -f "$LOG_FILE" ]; then
  SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 1048576 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null || true
  fi
fi

BRANCH=$(git branch --show-current 2>/dev/null || echo "<detached>")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Append одной строкой (POSIX гарантирует атомарность для < PIPE_BUF записей).
# Tab-separated для grep-friendly + awk parsing.
printf '%s\t%s\t%s\t%s\t%s\n' "$TS" "$TOOL_NAME" "$BRANCH" "$PWD" "$FILE_PATH" >> "$LOG_FILE" 2>/dev/null

exit 0
