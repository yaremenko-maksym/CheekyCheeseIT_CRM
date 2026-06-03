#!/bin/bash
# ECC stable id: pre:bash:coder-push-gate
# Phase 2 ECC port of legacy .claude/hooks/coder-pre-push.sh.
#
# Purpose: enforce that Coder/AutoTest commits include an `ac_verified:` marker
# on agent work branches before `git push`. Layer C3 fix from
# docs/architecture/2026-05-23-dev-flow-rca.md (D3 cite — narrow matcher: only
# act on actual `git push` invocations, not every Bash call).
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit (0) on every non-`git push` command — main perf win vs legacy.
#   - exit 2 + JSON decision body on block.
#
# Decision tree (after `git push` is detected):
#   - Not in a git work tree                  → allow (exit 0)
#   - Branch not under feature|fix|infra|test → allow (architect/legal/etc.
#                                              are out of scope)
#   - Last commit is `wip:` / `wip(scope):`   → allow (milestone chunking)
#   - Last commit starts `ac_verified:`       → allow
#   - Last commit is merge (>1 parent)        → allow
#   - Otherwise                                → BLOCK

set -u

CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)

# Fast exit: not a `git push` invocation at all.
[ -z "$CMD" ] && exit 0
if ! echo "$CMD" | grep -qE '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
  exit 0
fi

# Skip `git push --help` / `-h`.
if echo "$CMD" | grep -qE '(^|[[:space:]])(-h|--help)([[:space:]]|$)'; then
  exit 0
fi

# Must be inside a git work tree to enforce.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

BRANCH=$(git branch --show-current 2>/dev/null || echo "")
[ -z "$BRANCH" ] && exit 0

# Only enforce on agent work branches.
if ! echo "$BRANCH" | grep -qE '^(feature|fix|infra|test)/'; then
  exit 0
fi

LAST_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")

# WIP milestone push — allowed by Coder task-chunking contract (coder.md §7).
if echo "$LAST_MSG" | grep -qE '^wip(\([^)]*\))?:'; then
  exit 0
fi

# Verified — allow.
if echo "$LAST_MSG" | grep -qE '^ac_verified:'; then
  exit 0
fi

# Merge commit — allow.
PARENTS=$(git log -1 --pretty=%P 2>/dev/null | wc -w | tr -d ' ')
if [ "${PARENTS:-0}" -gt 1 ] 2>/dev/null; then
  exit 0
fi

# Block.
python3 -c "
import json
reason = '''🚫 PRE-PUSH BLOCK: последний commit на ветке '$BRANCH' не содержит 'ac_verified:' строки.

Перед push добавь в commit message:
    ac_verified: 1,2,3        # номера AC из task-файла
    vision: ✓ /crm/<route>    # только для UI задач

Если AC выполнены не все — укажи сделанные + комментарий:
    ac_verified: 1,2 (3 — blocked, см. .blocked.md)

Если это intermediate milestone push в больших задачах — используй wip-префикс:
    git commit -m \"wip(<scope>): <milestone>\"

См. docs/agents/coder.md §2.9 (Verification) и §7 (Task chunking).'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null

echo "[pre:bash:coder-push-gate] BLOCK branch=$BRANCH (no ac_verified)" >&2
exit 2
