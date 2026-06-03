#!/bin/bash
# ECC stable id: pre:edit-write:zone-of-write
# Phase 2 ECC port of legacy .claude/hooks/block-production-edits.sh.
#
# Purpose: enforce that Edit/Write/MultiEdit/NotebookEdit on production zones
# (apps/**, packages/**) only happens from Coder-isolated subagent worktrees.
# PM/Architect/Legal/Reviewer sessions in main repo cwd are blocked — they
# must dispatch Coder via task-file.
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit (0) on non-Edit/Write tools.
#   - Fast-exit (0) on file paths outside apps/**, packages/**.
#   - exit 2 + JSON decision body on block.
#
# Allow conditions (any one):
#   1. cwd contains `/.claude/worktrees/` (Coder/AutoTest subagent worktree).
#   2. Env var `$CLAUDE_AGENT_ID == "coder"` (future ECC agent-id propagation).
#   3. Escape hatch file `<repo>/.claude/.allow-direct-edits` (gitignored;
#      user-explicit opt-out for emergency edits).

set -u

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || true)

# Fast exit: not a target tool.
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

# Fast exit: no file path.
[ -z "$FILE_PATH" ] && exit 0

# Fast exit: file path is not in production zones.
if ! echo "$FILE_PATH" | grep -qE '(^|/)(apps|packages)/'; then
  exit 0
fi

# Allow #1: subagent worktree cwd.
if echo "$PWD" | grep -q '/\.claude/worktrees/'; then
  exit 0
fi

# Allow #2: explicit Coder agent-id (future ECC convention — env propagation).
if [ "${CLAUDE_AGENT_ID:-}" = "coder" ]; then
  exit 0
fi

# Allow #3: escape hatch file.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.claude/.allow-direct-edits" ]; then
  exit 0
fi

# Block.
python3 -c "
import json, sys
file_path = sys.argv[1]
reason = f'''🚫 PRODUCTION-EDIT BLOCK: попытка править {file_path} из main-repo сессии (не Coder worktree).

PM/Architect/Legal/Reviewer не редактируют apps/** или packages/** напрямую — это работа Coder через task-файл.

Если ты НЕ Coder (например, user-сессия):
  1. Эскейп-хатч: touch \$REPO/.claude/.allow-direct-edits  (gitignored)
  2. Или работа через worktree: git worktree add /tmp/work main
  3. Или сними этот hook в .claude/settings.json временно

Если ты PM/Architect:
  — Создай task-файл по шаблону docs/specs/tasks/templates/task.md.tpl
  — Запусти Coder через skill pm-dispatching'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" "$FILE_PATH" 2>/dev/null

echo "[pre:edit-write:zone-of-write] BLOCK path=$FILE_PATH cwd=$PWD" >&2
exit 2
