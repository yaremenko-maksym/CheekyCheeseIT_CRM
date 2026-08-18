#!/usr/bin/env bash
# test-pre-bash-devserver-ttl-gate.sh — proves .claude/hooks/pre-bash-devserver-ttl-gate.sh
# still demands the TTL wrapper for every real dev-server boot inside an agent
# worktree, and no longer fires on commands that merely name one.
#
# WHY THIS FILE EXISTS AT ALL. This hook was not in the original scope: the
# reported false positive named only pre-bash-live-db-guard. But both hooks
# carried the SAME launcher regex, copy-pasted, so narrowing one left
# `git show <ref>:pnpm-lock.yaml | grep -n vite` still blocked — reproduced on
# 2026-08-18 with the narrowed live-db-guard already in place. "The scoped hook
# now allows it" would have been a true statement and a useless fix.
#
# The wrapper check is per-SEGMENT on purpose: a mention of dev-ttl.sh in one
# segment must not whitelist an unwrapped boot in another. That decoy is the
# last red case below.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-devserver-ttl-gate.sh"
TTL="scripts/devops/dev-ttl.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

h() { hook_at "$HOOK" "$@"; }

echo "== test-pre-bash-devserver-ttl-gate.sh =="
echo

# ── green ─────────────────────────────────────────────────────────────────────
assert_green "READ: git show | grep -n vite (тот же ложный случай, что у соседа)" \
  -- h "git show HEAD:pnpm-lock.yaml | grep -n vite"

assert_green "READ: rg -n 'nest start' по apps/api" \
  -- h "rg -n 'nest start' apps/api"

assert_green "READ: ls node_modules/.bin/vite" \
  -- h "ls -la node_modules/.bin/vite"

assert_green "НЕ dev-сервер: vitest / playwright самозавершаются" \
  -- h "pnpm --filter @crm/e2e test"

assert_green "правильно обёрнутый запуск проходит" \
  -- h "$TTL --ttl 7200 -- pnpm --filter @crm/api dev"

assert_green "обёрнутый запуск с префиксом переменных окружения" \
  -- h "$TTL -- DATABASE_URL=postgresql://h:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev"

assert_green "вне worktree/scratchpad — стек владельца не гейтится" \
  -- h "pnpm --filter @crm/api dev" "$WS"

# ── red ───────────────────────────────────────────────────────────────────────
assert_red "голый pnpm dev в worktree" \
  --contains '"decision": "block"' \
  --contains "[pre:bash:devserver-ttl-gate] BLOCK" \
  -- h "pnpm --filter @crm/api dev"

assert_red "vite после cd" \
  --contains '"decision": "block"' \
  -- h "cd apps/web && vite --port 3010"

assert_red "nest start через sh -c" \
  --contains '"decision": "block"' \
  -- h "sh -c 'cd apps/api && nest start'"

assert_red "собранный API: node apps/api/dist/main.js" \
  --contains '"decision": "block"' \
  -- h "node apps/api/dist/main.js"

assert_red "фоновый nohup" \
  --contains '"decision": "block"' \
  -- h "nohup pnpm --filter @crm/web dev &"

assert_red "ПРИМАНКА: dev-ttl.sh упомянут в другом сегменте, запуск не обёрнут" \
  --contains '"decision": "block"' \
  -- h "echo $TTL && pnpm --filter @crm/api dev"

assert_red "кавычки не парсятся — деградированный разбор всё равно ловит запуск" \
  --contains '"decision": "block"' \
  -- h "pnpm --filter @crm/api dev \"unbalanced"

# ── crash is not a verdict (AC6) ──────────────────────────────────────────────
BROKEN="$(hook_with_broken_lib "$WS" pre-bash-devserver-ttl-gate.sh)"

assert_red "СЛОМАННЫЙ анализатор + необёрнутый запуск: блок, помеченный ДЕГРАДИРОВАННЫМ" \
  --contains "INTERNAL ERROR" \
  --contains "ДЕГРАДИРОВАННЫЙ РЕЖИМ" \
  -- hook_at "$BROKEN" "pnpm --filter @crm/api dev"

assert_red "СЛОМАННЫЙ анализатор + безобидное чтение: НЕ вердикт" \
  --contains "INTERNAL ERROR" \
  --not-contains "decision" \
  -- hook_at "$BROKEN" "grep -rn 'pnpm dev' .claude/rules"

assert_red "ЛОВУШКА: хук со сломанным bash тоже даёт rc≠0 — но без decision-контракта" \
  --contains "syntax error" \
  --not-contains "decision" \
  -- hook_at "$(hook_with_broken_bash "$WS")" "pnpm --filter @crm/api dev"

guard_test_summary "test-pre-bash-devserver-ttl-gate.sh"
