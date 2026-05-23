# Task: prep-user-testing.sh dev-flow fixes

## Агент: devops
## Ветка: infra/dev-flow-fixes (от main)
## Файлы:
- `scripts/pm/prep-user-testing.sh` (правки A1–A5, B1–B3)
- `docs/runbooks/user-testing-tunnel.md` (документация новых env + troubleshooting)

## Контекст

Скрипт `scripts/pm/prep-user-testing.sh` падает в реальных условиях macOS-разработки по 8 пунктам. Это аккумулированные грабли из последних запусков User Testing — нужно зафиксить раз и навсегда.

Скрипт исполняется PM-агентом во время фазы «User Testing» — собирает production-bundle и поднимает Serveo tunnel чтобы пользователь мог тестить с телефона.

## Фиксы

### A-группа: macOS совместимость

**A1. `timeout` не существует на macOS из коробки**

Сейчас:
```bash
timeout 60 bash -c 'until curl -sf http://localhost:3001/api/health >/dev/null; do sleep 2; done'
```

`timeout` — GNU coreutils, на macOS вместо неё `gtimeout` (если `brew install coreutils`). У многих разработчиков нет brew coreutils → скрипт падает с `command not found`.

Решение: shim-функция `_timeout` в начале скрипта:
- Если есть `timeout` — используем
- Иначе если есть `gtimeout` — используем
- Иначе fallback на `perl -e 'alarm shift; exec @ARGV' SECONDS CMD...` (perl всегда есть на macOS/Linux)

Заменить ВСЕ вызовы `timeout N ...` → `_timeout N ...`.

**A2. `mktemp /tmp/pm-serveo-XXXXXX.log` — несовместимо macOS↔Linux**

GNU `mktemp` подставляет случайные символы в XXXX. BSD `mktemp` (macOS) — другой синтаксис (`-t prefix`). Безопасный путь — генерация имени через `$RANDOM` и `mktemp` без шаблона.

Решение: заменить на `mktemp -t pm-serveo` (на macOS — `mktemp` без шаблона работает) или явно `/tmp/pm-serveo-$$-$RANDOM.log`. Выбираем второй вариант — детерминирован, не зависит от платформы.

**A3. `API_PORT` может прилететь из окружения и сломать запуск**

NestJS читает `PORT` или `API_PORT` (зависит от конфига). У PM в shell могут быть установлены эти переменные от предыдущих запусков → API стартует не на 3001 → `/api/health` через curl падает.

Решение: явный `export API_PORT=3001 PORT=3001` после `set -euo pipefail`. Перебивает любое унаследованное значение.

**A4. `pkill -f "vite"` убивает посторонние процессы**

Если у разработчика параллельно открыт другой проект на Vite (например, что-то на 5173) — `pkill -f vite` убьёт и его. Это враждебно для пользователя.

Решение: убивать не по имени процесса, а по порту через `lsof -ti :3000 | xargs -r kill -TERM`. Делать это идемпотентно для портов 3000, 3001, и SSH-туннеля (поиск по `pgrep -f 'ssh.*serveo'` оставляем — порт не помогает).

Завернуть в helper-функцию `_kill_port PORT` чтобы не дублировать.

**A5. `git checkout` падает если ветка в другом worktree**

В нашей dev-среде куча worktrees (`.claude/worktrees/`), и одна и та же ветка может быть checked out в нескольких местах. `git checkout pr_branch` → `fatal: 'X' is already checked out at '/path/to/worktree'`.

Решение: pre-flight через `git worktree list --porcelain` — если ветка где-то checked out, выводим путь и переходим (`cd`) туда вместо checkout. Если в текущем worktree — обычный checkout. Если ветка ещё нигде — обычный checkout создаст её локально.

Helper-функция `_checkout_branch BRANCH`.

### B-группа: User Testing env

**B1. `VITE_DEV_LOGIN=true` должен быть всегда в production build**

Скрипт собирает production-bundle. Но `login.tsx` показывает Dev Login кнопку только если `VITE_DEV_LOGIN=true` (или DEV-mode). Production build = `import.meta.env.DEV === false`. Значит без `VITE_DEV_LOGIN=true` Dev Login кнопка исчезает в production-сборке → User Testing через tunnel невозможен (Google OAuth не работает через tunnel из-за redirect_uri_mismatch).

Это вся суть User Testing скрипта — должен показать Dev Login. Сейчас не показывает = баг.

Решение: добавить `VITE_DEV_LOGIN=true` к существующему `VITE_API_URL=/api` в build-команде.

**B2. Stale listener на 3000/3001 — диагностика непонятна**

Сейчас если на 3000 уже висит другой процесс (старый preview из забытой сессии, dev-сервер из VSCode, что-то ещё) — build пройдёт, preview start попытается забиндить → port already in use → молча умрёт в /tmp/pm-web.log → wait-for-services тайм-аут «не поднялся за 30 сек». Пользователь смотрит и не понимает.

Решение: pre-flight check `_check_port_free 3000` (через `lsof -ti :3000`) ПОСЛЕ kill, перед build. Если порт всё ещё занят — печатаем диагностику: какой PID, какая команда (`ps -p PID -o command=`), и предлагаем решение.

**B3. `SKIP_UNIT_TESTS=1` опция (флейки иногда красные)**

Шаг 4 — `pnpm test`. Иногда падает по флейкам (race в snapshot tests, например). Тогда User Testing блокируется до фикса тестов. PM хочет вариант обойти, понимая риск.

Решение: env `SKIP_UNIT_TESTS=1` — пропускает шаг 4. В шапке скрипта документируем риск.

## Acceptance Criteria

- [ ] **AC1.** Smoke-test скрипта на macOS без brew coreutils — не должно быть `command not found`
- [ ] **AC2.** Idempotency: 2-3 kill+restart подряд работают без ошибок
- [ ] **AC3.** Worktree auto-detect: создать `/tmp/test-wt` worktree с другой веткой, запустить скрипт с этой веткой — должен `cd` в worktree, не падать с `already checked out`
- [ ] **AC4.** `pnpm typecheck` зелёный (мы только bash + md меняем, должно остаться зелёным)
- [ ] **AC5.** `pnpm lint` зелёный
- [ ] **AC6.** Параллельный сторонний Vite-процесс на другом порту НЕ убит после запуска (A4)
- [ ] **AC7.** `VITE_DEV_LOGIN=true` присутствует в build-команде (B1) — проверяется `grep`-ом скрипта
- [ ] **AC8.** Stale listener на 3000 — выдаётся понятная диагностика с PID/command (B2)
- [ ] **AC9.** `SKIP_UNIT_TESTS=1 bash ... pr_branch` — пропускает unit-tests (B3)
- [ ] **AC10.** `docs/runbooks/user-testing-tunnel.md` — обновлён: новые env (`SKIP_UNIT_TESTS`), troubleshooting (stale listener, worktree clash)

## Out of scope

- Правки `.md` файлов в `docs/agents/` (D-группа) — это зона AI Architect, см. `task-arch-agents-md-fixes.md`
- `apps/`, `packages/`, `.github/workflows/` — не трогаем
- Замена Serveo на другой tunnel — это отдельная инфра-задача

## PR

Title: `infra: prep-user-testing.sh macOS compat + idempotency + auto-detect worktree`
Label: `awaiting-pm-review`
В body — секция «AI Architect joins this branch» с инструкцией Architect'у дополнить эту же ветку commits для .md правок (см. `task-arch-agents-md-fixes.md`).
