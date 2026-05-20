#!/usr/bin/env bash
# Подготовка окружения перед User Testing.
# Usage: bash scripts/pm/prep-user-testing.sh <pr_branch>
#
# Делает: переключение на ветку → миграции → unit-тесты → рестарт dev-серверов → ожидание готовности.
# Возвращает 0 если всё ОК (можно показывать пользователю), не-0 если что-то упало.

set -euo pipefail

PR_BRANCH="${1:-}"
if [ -z "$PR_BRANCH" ]; then
  echo "❌ Usage: $0 <pr_branch>" >&2
  exit 2
fi

echo "🔄 Подготовка User Testing для ветки: $PR_BRANCH"
echo "──────────────────────────────────────────────────"

# 1. Переключиться на ветку PR
echo "[1/5] Fetch + checkout + pull"
git fetch origin
git checkout "$PR_BRANCH"
git pull origin "$PR_BRANCH"

# 2. Применить миграции
echo "[2/5] DB migrations"
pnpm --filter @crm/api db:migrate

# 3. Прогнать unit-тесты — если упали, не показываем пользователю
echo "[3/5] Unit tests"
if ! pnpm test; then
  echo "❌ Unit tests упали. НЕ показывать пользователю. Создать fix-задачу для Coder." >&2
  exit 1
fi

# 4. Перезапустить dev-серверы
echo "[4/5] Restart dev servers"
pkill -f "nest start" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 2
nohup pnpm dev >/tmp/pm-dev.log 2>&1 &

# 5. Дождаться готовности
echo "[5/5] Wait for services"
if ! timeout 60 bash -c 'until curl -sf http://localhost:3001/api/health >/dev/null; do sleep 2; done'; then
  echo "❌ API не поднялся за 60 сек. Лог: /tmp/pm-dev.log" >&2
  exit 1
fi
if ! timeout 30 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 2; done'; then
  echo "❌ Web не поднялся за 30 сек. Лог: /tmp/pm-dev.log" >&2
  exit 1
fi

echo "──────────────────────────────────────────────────"
echo "✅ Окружение готово. http://localhost:3000 — можно показывать пользователю."
