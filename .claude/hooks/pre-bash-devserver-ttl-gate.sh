#!/bin/bash
# ECC stable id: pre:bash:devserver-ttl-gate
#
# Purpose: prevent zombie dev-server accumulation. 2026-07-24 incident: 67
# orphaned nest/vite processes from agent worktrees (booted 2026-07-12..15,
# never stopped) drove the host into swap thrash (load average 70). The
# procedural "sweep zombie ports" rule failed — sessions die uncleanly, so
# the cleanup invariant moves into mechanics: any dev-server boot inside an
# agent worktree or claude scratchpad MUST go through
# scripts/devops/dev-ttl.sh (self-expiring process group).
#
# Contract (mirrors pre-bash-coder-push-gate.sh):
#   - Reads tool-call JSON from stdin.
#   - Fast-exit 0 for non-dev-server commands.
#   - exit 2 + JSON decision body on block.
#
# Decision tree:
#   - command already wrapped in dev-ttl.sh           → allow
#   - command is not a dev-server launcher            → allow (vitest/E2E
#     runs intentionally NOT matched — they self-terminate)
#   - neither cwd nor command references a worktree/
#     scratchpad path                                 → allow (main-repo
#     standing UT stack on :3000/:3001 is legit)
#   - otherwise                                       → BLOCK

set -u

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)
CWD=$(printf '%s' "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || true)

# Fast exit: empty or already TTL-wrapped.
[ -z "$CMD" ] && exit 0
if echo "$CMD" | grep -q 'dev-ttl\.sh'; then
  exit 0
fi

# Dev-server launcher patterns (narrow by design):
#   nest start / nest.js start
#   vite as a command (NOT vitest)
#   pnpm|npm|yarn|turbo [flags|--filter X|run] dev / dev:start
#   node ... dist/main (booting the built API directly)
LAUNCHER='nest(\.js)?[[:space:]]+start|(^|[/[:space:]])vite([[:space:]]|$)|(^|[[:space:]])(pnpm|npm|yarn|turbo)([[:space:]]+(-[^[:space:]]+|--filter[[:space:]]+[^[:space:]]+|run))*[[:space:]]+dev(:start)?([[:space:]]|$)|node[[:space:]][^;|&]*dist/main'
echo "$CMD" | grep -qE "$LAUNCHER" || exit 0

# Enforce only in agent worktree / claude scratchpad context.
CONTEXT='\.claude/worktrees/|/tmp/claude-'
if ! echo "$CMD" | grep -qE "$CONTEXT" && ! echo "$CWD" | grep -qE "$CONTEXT"; then
  exit 0
fi

# Block.
python3 -c "
import json
reason = '''🚫 DEVSERVER-TTL BLOCK: старт dev-сервера в agent-worktree/scratchpad без TTL-обёртки.

Причина: инцидент 2026-07-24 — 67 зомби nest/vite процессов из worktree загнали Mac
в swap-трэшинг (load average 70). Dev-сервер в .claude/worktrees/** обязан
самоликвидироваться по TTL, а не полагаться на cleanup сессии.

Правильно (обёртка даёт группе процессов TTL, default 4ч):
    scripts/devops/dev-ttl.sh -- <твоя команда>
    scripts/devops/dev-ttl.sh --ttl 7200 -- pnpm --filter @crm/api dev

Перед бутом проверь, не занят ли порт твоим же старым сервером:
    lsof -ti tcp:<PORT> | xargs kill -9

См. .claude/rules/common/light-track.md («Параллельный диспатч») и scripts/devops/dev-ttl.sh.'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null

echo "[pre:bash:devserver-ttl-gate] BLOCK unwrapped dev-server boot in worktree/scratchpad" >&2
exit 2
