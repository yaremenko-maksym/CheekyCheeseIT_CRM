#!/usr/bin/env bash
# Подготовка окружения перед User Testing.
# Usage: bash scripts/pm/prep-user-testing.sh <pr_branch>
#
# Шаги: branch checkout → migration pre-flight → db:migrate → unit-tests → restart dev → wait for ready.
# Возвращает 0 если всё ОК (можно показывать пользователю), не-0 если что-то упало.
#
# Env overrides:
#   POSTGRES_HOST (default: localhost)
#   POSTGRES_PORT (default: 5432)
#   POSTGRES_DB   (default: crm_db)
#   POSTGRES_USER (default: crm_user)
#   POSTGRES_PASSWORD (default: password)

set -euo pipefail

PR_BRANCH="${1:-}"
if [ -z "$PR_BRANCH" ]; then
  echo "❌ Usage: $0 <pr_branch>" >&2
  exit 2
fi

PG_HOST="${POSTGRES_HOST:-localhost}"
PG_PORT="${POSTGRES_PORT:-5432}"
PG_DB="${POSTGRES_DB:-crm_db}"
PG_USER="${POSTGRES_USER:-crm_user}"
PG_PW="${POSTGRES_PASSWORD:-password}"

psql_q() {
  PGPASSWORD="$PG_PW" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null
}

echo "🔄 Подготовка User Testing для ветки: $PR_BRANCH"
echo "──────────────────────────────────────────────────"

# 1. Переключиться на ветку PR
echo "[1/6] Fetch + checkout + pull"
git fetch origin
git checkout "$PR_BRANCH"
git pull origin "$PR_BRANCH"

# 2. Pre-flight: проверить состояние Drizzle migrations
echo "[2/6] Drizzle migrations pre-flight"

# 2a. Postgres reachable?
if ! psql_q "SELECT 1" >/dev/null; then
  echo "❌ Postgres недоступен ($PG_USER@$PG_HOST:$PG_PORT/$PG_DB)." >&2
  echo "Решение: docker-compose up -d  и подожди пока БД поднимется." >&2
  exit 1
fi

# 2b. Tracking table drizzle.__drizzle_migrations exists? (Drizzle хранит в `drizzle` schema, не public)
TRACKING=$(psql_q "SELECT to_regclass('drizzle.__drizzle_migrations')")
HAS_TRACKING="false"
[ -n "$TRACKING" ] && [ "$TRACKING" != "" ] && HAS_TRACKING="true"

# 2c. Schema applied (users table — есть с migration 0000)?
USERS_TABLE=$(psql_q "SELECT to_regclass('public.users')")
HAS_SCHEMA="false"
[ -n "$USERS_TABLE" ] && [ "$USERS_TABLE" != "" ] && HAS_SCHEMA="true"

if [ "$HAS_SCHEMA" = "true" ] && [ "$HAS_TRACKING" = "false" ]; then
  echo "⚠️ Несогласованное состояние: schema применена (есть users), но __drizzle_migrations отсутствует." >&2
  echo "" >&2
  echo "Это значит DB была создана через db:push (без tracking) или старый dump. db:migrate упадёт." >&2
  echo "" >&2
  echo "Варианты:" >&2
  echo "  A. Полный reset (теряются данные):" >&2
  echo "     docker-compose down -v && docker-compose up -d" >&2
  echo "     # подожди ~5 сек, затем повтори этот скрипт" >&2
  echo "" >&2
  echo "  B. Создать DevOps task на __drizzle_migrations sync:" >&2
  echo "     docs/specs/tasks/task-infra-migrations-sync.md" >&2
  echo "     (DevOps восстановит tracking без потери данных)" >&2
  echo "" >&2
  echo "До разрешения — НЕ показывать User Testing." >&2
  exit 1
fi

if [ "$HAS_SCHEMA" = "false" ] && [ "$HAS_TRACKING" = "false" ]; then
  echo "ℹ️ Fresh DB. db:migrate создаст и tracking, и schema."
elif [ "$HAS_TRACKING" = "true" ]; then
  APPLIED_COUNT=$(psql_q "SELECT COUNT(*) FROM drizzle.__drizzle_migrations")
  echo "ℹ️ Tracking ОК: $APPLIED_COUNT миграций применено."
fi

# 3. Применить миграции
echo "[3/6] DB migrations"
pnpm --filter @crm/api db:migrate

# 4. Прогнать unit-тесты — если упали, не показываем пользователю
echo "[4/6] Unit tests"
if ! pnpm test; then
  echo "❌ Unit tests упали. НЕ показывать пользователю. Создать fix-задачу для Coder." >&2
  exit 1
fi

# 5. Перезапустить dev-серверы
echo "[5/6] Restart dev servers"
pkill -f "nest start" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 2
nohup pnpm dev >/tmp/pm-dev.log 2>&1 &

# 6. Дождаться готовности
echo "[6/6] Wait for services"
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
