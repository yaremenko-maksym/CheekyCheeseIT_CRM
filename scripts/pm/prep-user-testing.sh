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
#   SKIP_UNIT_TESTS=1 (пропустить unit-tests на шаге 4 — обход флейков, риск показать
#                      сломанный bundle пользователю; см. runbook)

set -euo pipefail

# A3: Явный API_PORT/PORT=3001 чтобы перебить любое унаследованное окружение
# (PM мог установить их во время предыдущего запуска другого проекта).
# Без этого NestJS может стартануть не на 3001 → curl /api/health тайм-аутит.
export API_PORT=3001
export PORT=3001

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
SKIP_UNIT_TESTS="${SKIP_UNIT_TESTS:-0}"
TUNNEL_LOG=""
TUNNEL_URL=""
# Шаги: 1=checkout, 2=pnpm install, 3=.env setup, 4=shared build, 5=migrations pre-flight,
#       6=db:migrate, 7=unit tests, 8=build + start, 9=wait for ready, 10=tunnel.
TOTAL_STEPS="10"
[ "$SKIP_TUNNEL" = "1" ] && TOTAL_STEPS="9"

# ────────────────────────────────────────────────────────────────────────────
# A1: timeout shim для macOS совместимости.
# GNU `timeout` нет на macOS без brew coreutils. Порядок попыток:
#   1. timeout (Linux / macOS с coreutils symlink)
#   2. gtimeout (brew coreutils ставит как gtimeout)
#   3. perl alarm — есть везде, fallback последней надежды
# Usage: _timeout SECONDS COMMAND [ARGS...]
# ────────────────────────────────────────────────────────────────────────────
_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    # perl alarm-fallback. Запускаем команду через bash -c "..." чтобы поддержать
    # вызывающие, передающие конструкцию `bash -c 'until ...'`.
    perl -e '
      my $secs = shift @ARGV;
      my $pid = fork();
      if ($pid == 0) { exec @ARGV; exit 127; }
      eval {
        local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 1; kill "KILL", $pid; die "timeout\n"; };
        alarm $secs;
        waitpid($pid, 0);
        alarm 0;
        exit($? >> 8);
      };
      if ($@ =~ /^timeout/) { exit 124; }
    ' "$secs" "$@"
  fi
}

# ────────────────────────────────────────────────────────────────────────────
# A4: kill процессов по PORT, а не по имени.
# `pkill -f vite` убивает сторонние Vite-проекты разработчика — враждебно.
# Идемпотентно: нет процесса → no-op, нет ошибки.
# Usage: _kill_port PORT [SIGNAL]
# ────────────────────────────────────────────────────────────────────────────
_kill_port() {
  local port="$1"
  local signal="${2:-TERM}"
  local pids
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086  # хотим word-split
    kill -"$signal" $pids 2>/dev/null || true
    # Дать процессу время умереть до следующих действий
    sleep 1
    # Если ещё жив — добить KILL
    pids=$(lsof -ti ":${port}" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
    fi
  fi
}

# ────────────────────────────────────────────────────────────────────────────
# B2: Проверка что порт свободен после kill. Если нет — диагностика.
# Запускается ПОСЛЕ _kill_port — даёт понятную ошибку вместо silent fail
# preview/api-сервера с port-already-in-use.
# Usage: _check_port_free PORT NAME
# ────────────────────────────────────────────────────────────────────────────
_check_port_free() {
  local port="$1"
  local name="$2"
  local pids
  pids=$(lsof -ti ":${port}" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "❌ Порт $port (${name}) занят после kill — не могу запустить сервер." >&2
    echo "" >&2
    echo "Кто держит порт:" >&2
    for pid in $pids; do
      # ps -p может выдать пустую строку если процесс умер между lsof и ps — игнорируем
      local cmd
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || echo "<неизвестно>")
      echo "  PID $pid: $cmd" >&2
    done
    echo "" >&2
    echo "Решение:" >&2
    echo "  1. Закрыть процесс вручную: kill -9 $pids" >&2
    echo "  2. Перезапустить скрипт" >&2
    echo "" >&2
    echo "Возможные источники: VSCode dev server, забытая сессия pnpm dev," >&2
    echo "другой User Testing процесс, тестовый Vite на 3000." >&2
    exit 1
  fi
}

# ────────────────────────────────────────────────────────────────────────────
# A5: checkout ветки с auto-detect worktrees.
# В нашей dev-среде куча worktrees — одна ветка может быть checked out в другом.
# `git checkout X` падает с `fatal: 'X' is already checked out at ...` → bash exit.
# Стратегия:
#   - parse `git worktree list --porcelain`, найти worktree которому принадлежит ветка
#   - если это текущий worktree — обычный pull
#   - если другой worktree — `cd` туда, pull, продолжить работу из него
#   - если ветка нигде не checked out — обычный checkout + pull
# Usage: _checkout_branch BRANCH
# ────────────────────────────────────────────────────────────────────────────
_checkout_branch() {
  local branch="$1"
  local current_wt
  current_wt=$(git rev-parse --show-toplevel)

  # Парсим worktree list. Формат:
  #   worktree /path/to/wt
  #   HEAD <sha>
  #   branch refs/heads/<branch>
  #   (пустая строка)
  # Ищем worktree path для нашей ветки.
  local target_wt=""
  local wt_path=""
  while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      wt_path="${line#worktree }"
    elif [[ "$line" == "branch refs/heads/${branch}" ]]; then
      target_wt="$wt_path"
      break
    fi
  done < <(git worktree list --porcelain)

  if [ -n "$target_wt" ] && [ "$target_wt" != "$current_wt" ]; then
    echo "  ↪ Ветка $branch уже checked out в другом worktree: $target_wt"
    echo "  ↪ Переключаюсь туда (cd) и продолжаю работу из него."
    cd "$target_wt"
    git pull --ff-only origin "$branch"
  elif [ -n "$target_wt" ]; then
    # В текущем worktree — просто pull
    git pull --ff-only origin "$branch"
  else
    # Ветка ещё нигде не checked out
    git checkout "$branch"
    git pull --ff-only origin "$branch"
  fi
}

# Cleanup trap — убивает API + Web preview + tunnel при ЛЮБОМ выходе скрипта
# (success, error, Ctrl+C, kill). Не оставляет висящие процессы.
# Используем _kill_port (по портам, не по имени) чтобы не убить сторонние Vite/Node.
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM  # disable trap, чтобы не зациклиться
  echo ""
  echo "🛑 Останавливаю API + Web preview + tunnel..."
  _kill_port 3001 TERM                                       # API NestJS
  _kill_port 3000 TERM                                       # Vite preview
  pkill -f "ssh.*serveo\.net" 2>/dev/null || true            # Serveo SSH tunnel (порт remote)
  [ -n "$TUNNEL_LOG" ] && [ -f "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG"
  echo "✅ Cleanup завершён."
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "🔄 Подготовка User Testing для ветки: $PR_BRANCH"
echo "──────────────────────────────────────────────────"

# 1. Переключиться на ветку PR (с auto-detect worktrees — A5)
echo "[1/$TOTAL_STEPS] Fetch + checkout + pull"
git fetch origin
_checkout_branch "$PR_BRANCH"

# 2. pnpm install — fresh worktrees / merge'и могут менять lockfile.
# Без install: `drizzle-kit: command not found` (на fresh worktree node_modules пусты),
# `Cannot find module '@crm/shared'` (если новые зависимости), etc.
# --frozen-lockfile: гарантия что lockfile не модифицируется (контракт CI≡local).
echo "[2/$TOTAL_STEPS] pnpm install (frozen lockfile)"
if ! pnpm install --frozen-lockfile; then
  echo "❌ pnpm install fail. Проверь pnpm-lock.yaml vs package.json — возможно lockfile отстал от main." >&2
  exit 1
fi

# 3. .env setup — на fresh worktree файла нет, env.ts падает на required vars.
# Z3 schema требует JWT_SECRET.min(32), SESSION_SECRET.min(32), GOOGLE_* non-empty.
# Через tunnel реальные Google creds не нужны (OAuth не работает из-за redirect_uri
# mismatch — User Testing использует Dev Login через email). Подставляем заглушки.
# NestJS ConfigModule читает .env из cwd = apps/api/ при `pnpm --filter @crm/api start`,
# поэтому копируем второй раз в apps/api/.env.
echo "[3/$TOTAL_STEPS] Env setup (.env + apps/api/.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  # sed -i.bak — BSD/macOS compat (без .bak падает с "extra characters at end").
  # 32+ chars для JWT/SESSION (zod .min(32)), placeholder для GOOGLE_* (не используются через tunnel).
  sed -i.bak 's|^JWT_SECRET=$|JWT_SECRET=dev-secret-not-for-production-32chars-min|' .env
  sed -i.bak 's|^SESSION_SECRET=$|SESSION_SECRET=dev-session-not-for-production-32chars-min|' .env
  sed -i.bak 's|^GOOGLE_CLIENT_ID=$|GOOGLE_CLIENT_ID=dev-not-used-via-tunnel|' .env
  sed -i.bak 's|^GOOGLE_CLIENT_SECRET=$|GOOGLE_CLIENT_SECRET=dev-not-used-via-tunnel|' .env
  rm -f .env.bak
  echo "  ↪ .env создан из .env.example (только dev — НЕ для prod)"
else
  echo "  ↪ .env уже существует — оставляю как есть"
fi
# NestJS ConfigModule cwd = apps/api/ → нужна копия там.
# Каждый раз пересоздаём (на случай если корневой .env обновили вручную).
cp .env apps/api/.env

# 4. packages/shared build — генерирует dist/*.d.ts для api/web TypeScript.
# Без этого: api `Cannot find module '@crm/shared'`. Workspace symlinks не помогают —
# нужны реальные .d.ts файлы для tsc/vite.
echo "[4/$TOTAL_STEPS] Build packages/shared (TS declarations для api/web)"
if ! pnpm --filter @crm/shared build; then
  echo "❌ packages/shared build fail. Без этого api/web упадут с 'Cannot find module @crm/shared'." >&2
  exit 1
fi

# 5. Pre-flight: проверить состояние Drizzle migrations
echo "[5/$TOTAL_STEPS] Drizzle migrations pre-flight"

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

# 6. Применить миграции
echo "[6/$TOTAL_STEPS] DB migrations"
pnpm --filter @crm/api db:migrate

# 7. Прогнать unit-тесты — если упали, не показываем пользователю.
# ВАЖНО: `pnpm test` без фильтра тянет @crm/e2e (Playwright), который коннектится к
# localhost:3000 — а сервер ещё не поднят (это шаг 8). Фильтруем явно — только
# unit/integration suites из api/web/shared. E2E запускается в CI отдельно.
# B3: SKIP_UNIT_TESTS=1 — обход флейков (риск показать сломанный bundle).
if [ "$SKIP_UNIT_TESTS" = "1" ]; then
  echo "[7/$TOTAL_STEPS] ⚠️ SKIP_UNIT_TESTS=1 — unit-тесты пропущены. Возможен сломанный bundle."
else
  echo "[7/$TOTAL_STEPS] Unit tests (api + web + shared, без Playwright E2E)"
  if ! pnpm --filter @crm/shared --filter @crm/api --filter @crm/web test; then
    echo "❌ Unit tests упали. НЕ показывать пользователю. Создать fix-задачу для Coder." >&2
    echo "   Если флейки и нужен обход — SKIP_UNIT_TESTS=1 bash $0 $PR_BRANCH" >&2
    exit 1
  fi
fi

# 8. Производственная сборка + старт preview-сервера + старт API в production-режиме.
# ПОЧЕМУ не dev-сервер: через LocalTunnel dev-режим грузит сотни unbundled модулей,
# source maps, HMR-сокет — это десятки секунд загрузки на мобильнике и flaky HMR
# через туннель. Production build = один минифицированный bundle, никакого HMR,
# работает как реальный prod. Vite preview сервер проксирует /api → :3001.
echo "[8/$TOTAL_STEPS] Kill previous processes + production build + start"

# A4: kill по портам, не по имени — не убиваем сторонние Vite/Node разработчика.
_kill_port 3001 TERM   # API
_kill_port 3000 TERM   # Vite preview
pkill -f "ssh.*serveo\.net" 2>/dev/null || true   # Serveo SSH (порт remote, lsof тут не подходит)

# L2 (session-2026-06-02): kill stale dev процессы которые могли остаться от Coder
# агентов в worktrees. NestJS `nest start --watch` сам себя рестартует при изменении
# файла — port-only kill его не достанет потому что новый child процесс grabs port
# заново. Killer по pattern `@crm/api.*dev` ловит главный watch wrapper, который
# тогда не resurrect'нет ребёнка. Cosmetic precaution: vite preview/dev из других
# branches ветвей тоже завершить. Если у разработчика есть legit running `vite dev`
# на 3000 в другом проекте — он не использует эти patterns.
pkill -f "@crm/api.*\<dev\>" 2>/dev/null || true   # NestJS watch wrapper
pkill -f "@crm/web.*\<dev\>" 2>/dev/null || true   # Vite dev
pkill -f "@crm/web.*preview" 2>/dev/null || true   # Vite preview (старый instance из другой ветки)

sleep 2

# B2: pre-flight check что порты реально освободились. Если нет — понятная диагностика
# с PID/command вместо silent fail на bind() позже.
_check_port_free 3001 "API NestJS"
_check_port_free 3000 "Vite preview"

# Build api + web параллельно через turbo.
# VITE_API_URL=/api → бандл делает запросы относительно origin'а, чтобы tunnel-URL
# работал (иначе захардкоженный http://localhost:3001/api ссылается на localhost
# самого МОБИЛЬНИКА — ничего не доступно).
# B1: VITE_DEV_LOGIN=true — обязательно для User Testing! В production build
# import.meta.env.DEV === false, без VITE_DEV_LOGIN кнопка Dev Login исчезает
# из login.tsx → нельзя залогиниться через tunnel (Google OAuth = redirect_uri_mismatch).
# Это вся суть скрипта — Dev Login должен быть.
echo "  ↪ pnpm build (api + web, production, VITE_API_URL=/api, VITE_DEV_LOGIN=true)"
if ! VITE_API_URL=/api VITE_DEV_LOGIN=true pnpm --filter @crm/api --filter @crm/web build; then
  echo "❌ Build упал. НЕ показывать пользователю. Создать fix-задачу для Coder." >&2
  exit 1
fi

# Запуск production-серверов в фоне.
echo "  ↪ Start API (node dist/main) + Web preview"
nohup pnpm --filter @crm/api start >/tmp/pm-api.log 2>&1 &
nohup pnpm --filter @crm/web start >/tmp/pm-web.log 2>&1 &

# 9. Дождаться готовности
# A1: _timeout shim — работает на macOS без brew coreutils.
echo "[9/$TOTAL_STEPS] Wait for services"
if ! _timeout 60 bash -c 'until curl -sf http://localhost:3001/api/health >/dev/null; do sleep 2; done'; then
  echo "❌ API не поднялся за 60 сек. Лог: /tmp/pm-api.log" >&2
  exit 1
fi
if ! _timeout 30 bash -c 'until curl -sf http://localhost:3000 >/dev/null; do sleep 2; done'; then
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

# 10. Serveo SSH tunnel — публичный URL для тестирования с телефона
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

echo "[10/$TOTAL_STEPS] Поднимаю Serveo SSH tunnel"

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

# A2: macOS-compatible temp file. BSD mktemp шаблон отличается от GNU.
# Явное имя через $$ (PID) + $RANDOM — детерминировано, кроссплатформенно,
# уникально (PID шёл бы достаточно один — добавляем $RANDOM для безопасности
# на случай если PID переиспользуется между быстрыми запусками).
TUNNEL_LOG="/tmp/pm-serveo-$$-${RANDOM}.log"
: >"$TUNNEL_LOG"

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
