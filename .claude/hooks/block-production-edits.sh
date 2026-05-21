#!/bin/bash
# Blocks Edit/Write/NotebookEdit on apps/** and packages/** when NOT in a subagent worktree.
#
# Rationale: PM-агент не редактирует production-код напрямую (rule from pm.md "Зоны записи").
# Subagents (Coder/AutoTest/DevOps) launched via `Agent(isolation="worktree")` operate in
# `.claude/worktrees/<name>/` — those edits are legitimate and allowed.
#
# Escape hatch: touch <repo>/.claude/.allow-direct-edits — disables this hook (gitignored).
# Use when you want to edit code manually from main repo cwd.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || true)
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
print(ti.get('file_path') or ti.get('notebook_path') or '')
" 2>/dev/null || true)

[ -z "$FILE_PATH" ] && exit 0

# Only act on production-code paths (handle both absolute and relative)
if ! echo "$FILE_PATH" | grep -qE '(^|/)(apps|packages)/'; then
  exit 0
fi

# Subagent worktrees — allow (Coder/AutoTest/DevOps in isolation)
if echo "$PWD" | grep -q '/\.claude/worktrees/'; then
  exit 0
fi

# Escape hatch — user explicitly opted out
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.claude/.allow-direct-edits" ]; then
  exit 0
fi

# Block — emit JSON decision
python3 -c "
import json
import sys
file_path = sys.argv[1]
reason = f'''🚫 PRODUCTION-EDIT BLOCK: попытка править {file_path} из main-repo сессии.

PM-агент не редактирует apps/** или packages/** напрямую — это работа Coder через task-файл.

Если ты НЕ PM (например, user-сессия или Coder случайно вне worktree):
  1. Эскейп-хатч: touch \$REPO/.claude/.allow-direct-edits  (gitignored)
  2. Или работа через worktree: git worktree add /tmp/work main
  3. Или сними этот hook в .claude/settings.json временно

Если ты PM:
  — Создай task-файл по шаблону docs/specs/tasks/templates/task.md.tpl
  — Запусти Coder через skill pm-dispatching'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" "$FILE_PATH" 2>/dev/null
