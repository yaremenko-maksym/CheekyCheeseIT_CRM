#!/usr/bin/env bash
# test-pre-bash-live-db-guard.sh — proves .claude/hooks/pre-bash-live-db-guard.sh
# still refuses every real way to boot a dev server against the owner's live
# database, and stops refusing commands that merely NAME one.
#
# WHY BOTH HALVES ARE HERE. The hook exists because of PR #485 (an agent's API
# listened on :3000 against the live crm_db for two minutes, harmless by luck).
# It was then narrowed on 2026-08-18 because it also blocked
# `git show <ref>:pnpm-lock.yaml | grep -n vite` — a pure read. A narrowing is
# only trustworthy if the dangerous corpus is re-run against it, so the RED half
# below is written as "every shape #485 could have arrived in": env-var prefix,
# behind `&&`, through `sh -c`, absolute path to the binary, a wrapper, a
# command substitution, and a line whose quoting does not even parse.
#
# The last three cases are about a different failure: a hook that CRASHES exits
# non-zero too. This suite asserts on the contract (decision body / markers),
# not on rc≠0, and pins the difference explicitly.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-live-db-guard.sh"
SAFE_DB="postgresql://crm_user:password@localhost:5432/crm_qa"
LIVE_DB="postgresql://crm_user:password@localhost:5432/crm_db"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

h() { hook_at "$HOOK" "$@"; }

echo "== test-pre-bash-live-db-guard.sh =="
echo

# ── green: naming a launcher is not launching it ──────────────────────────────
assert_green "READ: git show | grep -n vite (сообщённое ложное срабатывание)" \
  -- h "git show HEAD:pnpm-lock.yaml | grep -n vite"

assert_green "READ: ls -la node_modules/.bin/vite" \
  -- h "ls -la node_modules/.bin/vite"

assert_green "READ: grep -rn 'pnpm dev' по правилам" \
  -- h "grep -rn 'pnpm dev' .claude/rules"

assert_green "READ: node -e печатает строку, содержащую dist/main.js" \
  -- h "node -e \"console.log('apps/api/dist/main.js')\""

assert_green "READ: echo цитирует команду запуска" \
  -- h "echo 'потом запусти: pnpm --filter @crm/api dev'"

assert_green "НЕ dev-сервер: vitest run (самозавершается)" \
  -- h "vitest run apps/api"

assert_green "НЕ dev-сервер: pnpm --filter @crm/web build" \
  -- h "pnpm --filter @crm/web build"

# NB: cwd is the scratch dir, not $REPO_ROOT — when these tests run from inside
# an agent worktree, $REPO_ROOT itself matches the worktree context and the case
# would pass or fail depending on where the suite was started from.
assert_green "вне worktree/scratchpad — сессия владельца не гейтится" \
  -- h "pnpm --filter @crm/api dev" "$WS"

assert_green "явно безопасные значения: crm_qa + свободный порт" \
  -- h "DATABASE_URL=$SAFE_DB API_PORT=3011 pnpm --filter @crm/api dev"

assert_green "явно пустая DATABASE_URL + --port 3010 (идиома git-policy)" \
  -- h "DATABASE_URL= vite --port 3010"

# ── red: every shape the #485 boot could have arrived in ──────────────────────
assert_red "голый запуск: ни DATABASE_URL, ни порта" \
  --contains '"decision": "block"' \
  --contains "[pre:bash:live-db-guard] BLOCK" \
  -- h "pnpm --filter @crm/api dev"

assert_red "префикс переменных окружения указывает на ЖИВУЮ crm_db" \
  --contains "crm_db" \
  -- h "DATABASE_URL=$LIVE_DB API_PORT=3011 pnpm --filter @crm/api dev"

assert_red "safe DB, но живой порт владельца 3001" \
  --contains "3001" \
  -- h "DATABASE_URL=$SAFE_DB API_PORT=3001 pnpm --filter @crm/api dev"

assert_red "внутри &&: cd apps/api && nest start --watch" \
  --contains '"decision": "block"' \
  -- h "cd apps/api && nest start --watch"

assert_red "через sh -c" \
  --contains '"decision": "block"' \
  -- h "sh -c 'pnpm --filter @crm/api dev'"

assert_red "абсолютный путь к бинарнику vite" \
  --contains '"decision": "block"' \
  -- h "$REPO_ROOT/node_modules/.bin/vite --host"

assert_red "собранный API напрямую: node apps/api/dist/main.js" \
  --contains '"decision": "block"' \
  -- h "node apps/api/dist/main.js"

assert_red "обёртки nohup+env поверх запуска в фоне" \
  --contains '"decision": "block"' \
  -- h "nohup env DATABASE_URL=$LIVE_DB pnpm dev &"

assert_red "timeout 600 перед запуском" \
  --contains '"decision": "block"' \
  -- h "timeout 600 pnpm --filter @crm/api dev"

assert_red "TTL-обёртка есть, но окружение не задано" \
  --contains '"decision": "block"' \
  -- h "scripts/devops/dev-ttl.sh --ttl 7200 -- pnpm --filter @crm/api dev"

assert_red "подстановка в позиции команды: \$(echo pnpm) dev" \
  --contains '"decision": "block"' \
  -- h "\$(echo pnpm) dev"

assert_red "кавычки не парсятся — разбор деградирован, но запуск всё равно ловится" \
  --contains '"decision": "block"' \
  -- h "pnpm --filter @crm/api dev \"unbalanced"

# ── попытки обмануть сужение (каждая найдена прогоном, не вычиткой) ───────────
# `eval` реально ускользал: старое подстрочное правило его ловило, первая версия
# сужения — нет. Поэтому кейс живёт здесь, а не в описании PR.
assert_red "ОБХОД: eval 'pnpm dev'" \
  --contains '"decision": "block"' \
  -- h "eval 'pnpm --filter @crm/api dev'"

assert_red "ОБХОД: кавычки внутри имени команды (p''npm)" \
  --contains '"decision": "block"' \
  -- h "p''npm --filter @crm/api dev"

assert_red "ОБХОД: имя команды в кавычках (\"pnpm\" dev)" \
  --contains '"decision": "block"' \
  -- h "\"pnpm\" dev"

assert_red "ОБХОД: экранированное имя (\\pnpm dev)" \
  --contains '"decision": "block"' \
  -- h "\\pnpm dev"

assert_red "ОБХОД: env -i + абсолютный путь к nest" \
  --contains '"decision": "block"' \
  -- h "env -i DATABASE_URL=postgresql://h/crm_db /abs/node_modules/.bin/nest start"

assert_red "ОБХОД: bash -c 'exec pnpm dev'" \
  --contains '"decision": "block"' \
  -- h "bash -c 'exec pnpm dev'"

assert_red "ОБХОД: xargs -I{} pnpm dev" \
  --contains '"decision": "block"' \
  -- h "xargs -I{} pnpm dev"

assert_red "ОБХОД: pnpm -r --filter=@crm/api run dev" \
  --contains '"decision": "block"' \
  -- h "pnpm -r --filter=@crm/api run dev"

# ── crash is not a verdict (AC6) ──────────────────────────────────────────────
BROKEN="$(hook_with_broken_lib "$WS" pre-bash-live-db-guard.sh)"

assert_red "СЛОМАННЫЙ анализатор + опасный запуск: блок, но помечен как ДЕГРАДИРОВАННЫЙ" \
  --contains "INTERNAL ERROR" \
  --contains "ДЕГРАДИРОВАННЫЙ РЕЖИМ" \
  -- hook_at "$BROKEN" "pnpm --filter @crm/api dev"

assert_red "СЛОМАННЫЙ анализатор + безобидное чтение: НЕ вердикт (нет decision-контракта)" \
  --contains "INTERNAL ERROR" \
  --not-contains "decision" \
  -- hook_at "$BROKEN" "grep -rn 'pnpm dev' .claude/rules"

assert_red "ЛОВУШКА: хук со сломанным bash тоже даёт rc≠0 — но без decision-контракта" \
  --contains "syntax error" \
  --not-contains "decision" \
  -- hook_at "$(hook_with_broken_bash "$WS")" "pnpm --filter @crm/api dev"

guard_test_summary "test-pre-bash-live-db-guard.sh"
