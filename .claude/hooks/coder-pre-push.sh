#!/bin/bash
# Pre-push gate for Coder/AutoTest agents.
# Fires before every Bash tool call — filters for `git push` commands.
# Blocks push if last commit on agent branches lacks `ac_verified:` line.
#
# Agent branches: feature/*, fix/*, infra/*, test/*
# Other branches (main, claude/*, etc.) — not enforced.
#
# Contract: outputs JSON {"decision": "block", "reason": "..."} to stdout to block.

CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)

[ -z "$CMD" ] && exit 0

# Only act on `git push` (not `git push --help`, not `gh pr push` etc.)
if ! echo "$CMD" | grep -qE '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
  exit 0
fi

# Skip if `--help` or `-h`
if echo "$CMD" | grep -qE '(^|[[:space:]])(-h|--help)([[:space:]]|$)'; then
  exit 0
fi

# Need to be in a git repo
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

BRANCH=$(git branch --show-current 2>/dev/null)
[ -z "$BRANCH" ] && exit 0

# Only enforce on agent work branches
if ! echo "$BRANCH" | grep -qE '^(feature|fix|infra|test)/'; then
  exit 0
fi

# Check last commit message for `ac_verified:` line
LAST_MSG=$(git log -1 --pretty=%B 2>/dev/null)

if echo "$LAST_MSG" | grep -qE '^ac_verified:'; then
  # Verified — let push proceed
  exit 0
fi

# Skip merge commits (auto-generated)
PARENTS=$(git log -1 --pretty=%P 2>/dev/null | wc -w)
if [ "$PARENTS" -gt 1 ]; then
  exit 0
fi

# Block — emit JSON
python3 -c "
import json
import sys

reason = '''🚫 PRE-PUSH BLOCK: последний commit на ветке '$BRANCH' не содержит 'ac_verified:' строки.

Перед push добавь в commit message:
    ac_verified: 1,2,3        # номера AC из task-файла
    vision: ✓ /crm/<route>    # только для UI задач

Если AC выполнены не все — укажи сделанные + комментарий:
    ac_verified: 1,2 (3 — blocked, см. .blocked.md)

Чтобы пересоздать commit с правильным message:
    git commit --amend -m \"\$(git log -1 --pretty=%B)

ac_verified: 1,2,3\"

См. docs/agents/coder.md секция \"2.9 Verification before push\".'''

print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null
