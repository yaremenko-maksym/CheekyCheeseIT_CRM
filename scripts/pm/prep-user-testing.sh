#!/usr/bin/env bash
# Подготовка окружения перед User Testing + публичный туннель через serveo.net (SSH).
# Usage: bash scripts/pm/prep-user-testing.sh <pr_branch>
#
# Шаги: branch checkout → migration pre-flight → db:migrate → unit-tests →
#       production build (api+web) → старт API+preview → wait for ready →
#       Serveo SSH tunnel → блокирует пока не Ctrl+C.
#
# ВАЖНО: используется production build + Vite preview (не dev). Это нужно для
# нормальной работы через туннель: dev-режим тянет сотни unbundled модулей через
# туннель + HMR-сокет = flaky на мобильнике. Preview отдаёт минифицированный
# bundle и проксирует /api → NestJS на 3001.
#
# Tunnel provider: serveo.net. Был выбран после провалов LocalTunnel (503),
# Cloudflare quick tunnel (заблокирован в нашей сети), ngrok (требует регистрацию).
# Serveo работает через SSH reverse forward, не требует client install.
# URL формат: https://<random-hash>-<ip-dashed>.serveousercontent.com
# См. docs/runbooks/user-testing-tunnel.md для полного pre-flight checklist.
#
# Скрипт работает в FOREGROUND. Ctrl+C / SIGTERM убивает API + preview + SSH tunnel
# через trap, не оставляя висящих процессов. Для background-режима — вызывать с `&`.
#
# Возвращает 0 если всё ОК, не-0 если что-то упало.
#
# Env overrides:
#   POSTGRES_HOST (default: localhost)
#   POSTGRES_PORT (default: 5432)
#   POSTGRES_DB   (default: crm_db)
#   POSTGRES_USER (default: crm_user)
#   POSTGRES_PASSWORD (default: password)
#   SKIP_TUNNEL=1 (отключить tunnel, только локальный сервер на localhost:3000)

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

SKIP_TUNNEL="${SKIP_TUNNEL:-0}"
TUNNEL_LOG=""
TUNNEL_URL=""
TOTAL_STEPS="7"
[ "$SKIP_TUNNEL" = "1" ] && TOTAL_STEPS="6"

# Cleanup trap — убивает API + Web preview + tunnel при ЛЮБОМ выходе скрипта
# (success, error, Ctrl+C, kill). Не оставляет висящие процессы.
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM  # disable trap, чтобы не зациклиться
  echo ""
  echo "🛑 Останавливаю API + Web preview + tunnel..."
  pkill -f "nest start" 2>/dev/null || true                 # на случай если кто-то поднимал dev API
  pkill -f "node .*apps/api/dist" 2>/dev/null || true       # production API
  pkill -f "vite" 2>/dev/null || true                       # вкл. vite preview
  pkill -f "ssh.*serveo\.net" 2>/dev/null || true           # Serveo SSH tunnel
  [ -n "$TUNNEL_LOG" ] && [ -f "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG"
  echo "✅ Cleanup завершён."
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "🔄 Подготовка User Testing для ветки: $PR_BRANCH"
echo "──────────────────────────────────────────────────"

# 1. Переключиться на ветку PR
echo "[1/$TOTAL_STEPS] Fetch + checkout + pull"
git fetch origin
git checkout "$PR_BRANCH"
git pull origin "$PR_BRANCH"

# 2. Pre-flight: проверить состояние Drizzle migrations
echo "[2/$TOTAL_STEPS] Drizzle migrations pre-flight"

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
echo "[3/$TOTAL_STEPS] DB migrations"
pnpm --filter @crm/api db:migrate

# 4. Прогнать unit-тесты — если упали, не показываем пользователю.
# ВАЖНО: `pnpm test` без фильтра тянет @crm/e2e (Playwright), который коннектится к
# localhost:3000 — а сервер ещё не поднят (это шаг 5). Фильтруем явно — только
# unit/integration suites из api/web/shared. E2E запускается в CI отдельно.
echo "[4/$TOTAL_STEPS] Unit tests (api + web + shared, без Playwright E2E)"
if ! pnpm --filter @crm/shared --filter @crm/api --filter @crm/web test; then
  echo "❌ Unit tests упали. НЕ показывать пользователю. Создать fix-задачу для Coder." >&2
  exit 1
fi

# 5. Производственная сборка + старт preview-сервера + старт API в production-режиме.
# ПОЧЕМУ не dev-сервер: через LocalTunnel dev-режим грузит сотни unbundled модулей,
# source maps, HMR-сокет — это десятки секунд загрузки на мобильнике и flaky HMR
# через туннель. Production build = один минифицированный bundle, никакого HMR,
# работает как реальный prod. Vite preview сервер проксирует /api → :3001.
echo "[5/$TOTAL_STEPS] Kill previous processes + production build + start"

pkill -f "nest start" 2>/dev/null || true
pkill -f "node .*apps/api/dist" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "ssh.*serveo\.net" 2>/dev/null || true
sleep 2

# Build api + web параллельно через turbo.
# VITE_API_URL=/api → бандл делает запросы относительно origin'а, чтобы tunnel-URL
# работал (иначе захардкоженный http://localhost:3001/api ссылается на localhost
# самого МОБИЛЬНИКА — ничего не доступно).
echo "  ↪ pnpm build (api + web, production, VITE_API_URL=/api)"
if ! VITE_API_URL=/api pnpm --filter @crm/api --filter @crm/web build; then
  echo "❌ Build упал. НЕ показывать пользователю. Создать fix-задачу для Coder." >&2
  exit 1
fi

# Запуск production-серверов в фоне.
echo "  ↪ Start API (node dist/main) + Web preview"
nohup pnpm --filter @crm/api start >/tmp/pm-api.log 2>&1 &
nohup pnpm --filter @crm/web start >/tmp/pm-web.log 2>&1 &

# 6. Дождаться готовности
echo "[6/$TOTAL_STEPS] Wait for services"
if ! timeout 60 bash -c 'until curl -sf http://localhost:3001/api/health >/dev/null; do sleep 2; done'; then
  echo "❌ API не поднялся за 60 сек. Лог: /tmp/pm-api.log" >&2
  exit 1
fi
if ! timeout 30 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 2; done'; then
  echo "❌ Web preview не поднялся за 30 сек. Лог: /tmp/pm-web.log" >&2
  exit 1
fi

# Sanity check: preview-сервер должен проксировать /api → :3001.
# Если прокси не настроен в vite.config.ts, /api/health через :3000 даст 404.
if ! curl -sf --max-time 5 http://localhost:3000/api/health >/dev/null; then
  echo "⚠️ /api/health через preview (3000) недоступен — preview.proxy не настроен в vite.config.ts" >&2
  echo "Через tunnel API не будет работать. Проверь preview.proxy в apps/web/vite.config.ts." >&2
  exit 1
fi
echo "  ↪ /api proxy через preview работает"

# 7. LocalTunnel — публичный URL для тестирования с телефона
if [ "$SKIP_TUNNEL" = "1" ]; then
  echo "──────────────────────────────────────────────────"
  echo "✅ Окружение готово (БЕЗ tunnel — SKIP_TUNNEL=1)."
  echo "Локальный: http://localhost:3000  (Vite preview, production build)"
  echo "Лог API:   /tmp/pm-api.log"
  echo "Лог web:   /tmp/pm-web.log"
  echo "Нажми Ctrl+C для остановки API + preview."
  wait
  exit 0
fi

echo "[7/$TOTAL_STEPS] Поднимаю Serveo SSH tunnel"

# Двойная проверка что localhost:3000 реально отвечает (200/3xx/4xx — главное не connection refused)
if ! curl -sf --max-time 5 --retry 3 --retry-delay 1 http://localhost:3000 >/dev/null; then
  echo "❌ localhost:3000 не отвечает после wait-for-services. Tunnel запускать бессмысленно." >&2
  exit 1
fi

# Serveo требует SSH-клиент. На macOS/Linux он обычно есть из коробки.
if ! command -v ssh >/dev/null 2>&1; then
  echo "❌ SSH не установлен. Serveo требует ssh-клиент." >&2
  echo "  - macOS: должен быть из коробки. Если нет — xcode-select --install" >&2
  echo "  - Linux: apt install openssh-client / pacman -S openssh" >&2
  echo "  - Можно обойти: SKIP_TUNNEL=1 bash $0 $PR_BRANCH" >&2
  exit 1
fi

TUNNEL_LOG=$(mktemp /tmp/pm-serveo-XXXXXX.log)

# SSH reverse forward: remote :80 → local :3000.
# - StrictHostKeyChecking=accept-new: принять fingerprint serveo.net (без интерактивного prompt)
# - UserKnownHostsFile=/tmp/pm-serveo-known-hosts: не засоряем ~/.ssh/known_hosts
# - ServerAliveInterval=60: NAT keepalive, чтобы туннель не падал
# - ConnectTimeout=15: быстрый fail если serveo.net недоступен
# - LogLevel=ERROR: глушим verbose SSH-вывод, в лог попадает только URL
nohup ssh -R 80:localhost:3000 \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=/tmp/pm-serveo-known-hosts \
  -o ServerAliveInterval=60 \
  -o ConnectTimeout=15 \
  -o ExitOnForwardFailure=yes \
  serveo.net >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Ждём пока tunnel выдаст URL (макс 30 сек). Параллельно проверяем что процесс жив.
TUNNEL_URL=""
for i in {1..30}; do
  # Tunnel-процесс умер раньше времени → диагностируем и выходим
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "❌ Serveo SSH tunnel упал. Лог:" >&2
    cat "$TUNNEL_LOG" >&2
    echo "" >&2
    echo "Возможные причины:" >&2
    echo "  - serveo.net недоступен (сеть/firewall блокирует исходящий SSH на 22)" >&2
    echo "  - ExitOnForwardFailure сработал — :80 на serveo уже занят другим клиентом" >&2
    echo "  - SSH key rejection — попробуй удалить /tmp/pm-serveo-known-hosts" >&2
    echo "  - Можно обойти: SKIP_TUNNEL=1 bash $0 $PR_BRANCH" >&2
    exit 1
  fi

  # Парсим URL из лога. Serveo печатает: "Forwarding HTTP traffic from https://xxx.serveousercontent.com"
  # (anonymous) или "https://xxx.serveo.net" (с SSH key auth).
  URL=$(grep -oE 'https://[a-z0-9.-]+\.(serveousercontent\.com|serveo\.net)' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$URL" ]; then
    TUNNEL_URL="$URL"
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Serveo не выдал URL за 30 сек. Лог:" >&2
  cat "$TUNNEL_LOG" >&2
  echo "" >&2
  echo "Можно обойти: SKIP_TUNNEL=1 bash $0 $PR_BRANCH" >&2
  exit 1
fi

echo "──────────────────────────────────────────────────"
echo "✅ Окружение готово."
echo ""
printf '╔══════════════════════════════════════════════════════════════════╗\n'
printf '║                                                                  ║\n'
printf '║  🔗 USER TESTING URL:                                            ║\n'
printf '║                                                                  ║\n'
printf '║  %-64s║\n' "$TUNNEL_URL"
printf '║                                                                  ║\n'
printf '║  📱 Открыть с телефона напрямую — без password/bypass страниц.   ║\n'
printf '║     Google OAuth не работает через tunnel (redirect_uri          ║\n'
printf '║     mismatch) — используй Dev Login через email на /crm/login.   ║\n'
printf '║                                                                  ║\n'
printf '╚══════════════════════════════════════════════════════════════════╝\n'
echo ""
echo "Локальный URL:   http://localhost:3000  (Vite preview, production build)"
echo "Публичный URL:   $TUNNEL_URL"
echo "Лог API:         /tmp/pm-api.log"
echo "Лог web preview: /tmp/pm-web.log"
echo "Лог Serveo:      $TUNNEL_LOG"
echo ""
echo "Ctrl+C — остановит API + preview + Serveo SSH (cleanup автоматический)."
echo "──────────────────────────────────────────────────"

# Блокируем выполнение — держим серверы и tunnel живыми до Ctrl+C / SIGTERM.
# Trap cleanup на EXIT гарантирует что все процессы убьются вместе.
wait
