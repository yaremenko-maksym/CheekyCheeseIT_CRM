# User Testing Tunnel — Pre-flight Checklist

Запускаем `bash scripts/pm/prep-user-testing.sh <pr_branch>` чтобы поднять User Testing demo с публичным URL для тестирования с телефона. Этот runbook — checklist всех точек отказа на основе реального опыта.

## Конфигурация которая работает (по состоянию на 2026-05-23)

| Слой | Решение | Почему |
|---|---|---|
| **Tunnel provider** | `serveo.net` (SSH reverse forward) | LocalTunnel — 503 на demand. Cloudflare quick tunnel — заблокирован в нашей сети. ngrok free — требует регистрацию + конфликт с rate limits. Serveo — стабильный, anonymous, через SSH. |
| **URL формат** | `https://<hash>-<ip-dashed>.serveousercontent.com` | Anonymous mode (без SSH key auth). |
| **Build mode** | Production build + Vite preview (НЕ dev) | Dev через tunnel = HMR-сокет flaky + сотни unbundled запросов. Preview = минифицированный bundle. |
| **API access** | `vite preview` проксирует `/api → localhost:3001` | Чтобы из mobile-браузера запросы шли через tunnel-origin, а не на localhost телефона. |
| **OAuth login** | **Dev Login** (`POST /api/auth/dev-login {email}`) | Google OAuth не работает через tunnel — `redirect_uri_mismatch` (Google требует whitelist redirect URI, tunnel-URL динамический). Dev Login — bypass для тестирования. |
| **Dev Login UI** | `VITE_DEV_LOGIN=true` в build (всегда) | `login.tsx` рендерит Dev Login кнопку только если `import.meta.env.DEV` или `VITE_DEV_LOGIN === 'true'`. В production build `DEV === false` → флаг обязателен. Скрипт устанавливает его сам. |
| **Ports** | `API_PORT=3001 PORT=3001` (явный export) | Перебивает любое унаследованное окружение от предыдущих запусков. |

## Pre-flight checklist (что должно быть выполнено ДО запуска)

### 1. SSH доступен
```bash
command -v ssh && echo OK
```
Скрипт проверит автоматически. Если нет — `xcode-select --install` (macOS) или `apt install openssh-client` (Linux).

### 2. Vite allowedHosts включает `.serveousercontent.com`
Проверить `apps/web/vite.config.ts`:
```ts
server: { allowedHosts: ['.serveousercontent.com', '.serveo.net'], ... }
preview: { allowedHosts: ['.serveousercontent.com', '.serveo.net'], ... }
```

Без этого Vite вернёт `Blocked request. This host is not allowed.` на любой не-localhost Host header.

### 3. Preview прокси для /api настроен
В `vite.config.ts → preview`:
```ts
proxy: {
  '/api': { target: 'http://localhost:3001', changeOrigin: true }
}
```

Без этого браузер на телефоне попытается `GET http://localhost:3001/api/...` — это localhost САМОГО телефона, API недоступен.

### 4. Build с правильными env vars
`scripts/pm/prep-user-testing.sh` собирает с:
- `VITE_API_URL=/api` — относительные API URL (иначе захардкоженный localhost ломает tunnel)
- `VITE_DEV_LOGIN=true` — показывает Dev Login кнопку в production build

Если переопределяешь окружение — НЕ задавать `VITE_API_URL=http://localhost:3001/api` (это сломает tunnel). `VITE_DEV_LOGIN` лучше оставить на дефолте — скрипт сам выставит.

### 5. Постгрес запущен и tracking есть
Скрипт проверит автоматически (drizzle pre-flight). Если красное — `docker-compose up -d` и подождать.

### 6. Dev Login доступен на бэкенде
`apps/api/.env`: `ENABLE_DEV_LOGIN=true` (или эквивалент). Без бэка-флага кнопка в UI есть, но `POST /api/auth/dev-login` вернёт 403. На фронте — серверная ошибка.

### 7. Порты 3000 и 3001 свободны
Скрипт убивает свои предыдущие процессы (по портам через `lsof -ti`, не по имени — не трогает сторонние Vite/Node), но если 3000 занят посторонним dev-сервером (например, VSCode держит его) — выдаст диагностику с PID/command и предложит закрыть вручную.

## Environment variables

| Var | Default | Описание |
|---|---|---|
| `SKIP_TUNNEL` | `0` | `1` — не поднимать Serveo, только локально на `localhost:3000`. Полезно если tunnel не нужен / не работает. |
| `SKIP_UNIT_TESTS` | `0` | `1` — пропустить шаг 4 (unit-tests). **Используй только при флейках**, понимая риск показать сломанный bundle. |
| `POSTGRES_HOST` | `localhost` | Хост Postgres. |
| `POSTGRES_PORT` | `5432` | Порт Postgres. |
| `POSTGRES_DB` | `crm_db` | DB name. |
| `POSTGRES_USER` | `crm_user` | DB user. |
| `POSTGRES_PASSWORD` | `password` | DB password. |
| `API_PORT` / `PORT` | `3001` (force) | Скрипт явно экспортирует `3001`, перебивая любое унаследованное значение. |

## Запуск

```bash
bash scripts/pm/prep-user-testing.sh <pr_branch>
```

С обходом флейков:
```bash
SKIP_UNIT_TESTS=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Только локально (без tunnel):
```bash
SKIP_TUNNEL=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Ожидай:
- ~30-40 сек build (api + web)
- ~10 сек старт серверов
- ~5-30 сек handshake с serveo.net + парсинг URL
- Итого: ~60-90 сек до видимости рамки с URL

## Если упало — диагностика

### `command not found: timeout` (или ничего не падает, но висит)
Это macOS без brew coreutils. Скрипт сам fallback'ает на `gtimeout` → `perl alarm`. Если ты видишь эту ошибку — у тебя старая версия скрипта без shim. Обнови до текущего main.

### `fatal: 'X' is already checked out at '/path/to/worktree'`
Ветка уже checked out в другом git worktree (`.claude/worktrees/<name>`). Скрипт должен это сам обнаружить через `git worktree list --porcelain` и `cd` в нужный worktree вместо checkout. Если падает — у тебя старая версия скрипта.

Manual workaround: `cd /path/to/worktree && bash scripts/pm/prep-user-testing.sh <branch>` оттуда.

### `Порт 3000 (Vite preview) занят после kill`
Скрипт не смог освободить порт даже после kill -KILL. Это значит порт держит процесс который не находится через `lsof -ti :3000` (например, root-процесс или Docker контейнер на host network).

Диагностика выводится с PID и командой. Типичные источники:
- VSCode dev server (закрыть терминал в VSCode)
- Забытая сессия `pnpm dev` (`pkill -f 'vite|nest'` или `ps aux | grep -E 'vite|nest'`)
- Другой запуск `prep-user-testing.sh` (`ps aux | grep prep-user-testing`)
- Docker container с `--network host` (`docker ps`)

### `Serveo SSH tunnel упал`
Лог tunnel в `/tmp/pm-serveo-<PID>-<random>.log` (печатается в stderr скрипта). Типичные ошибки:

| Ошибка в SSH-логе | Причина | Что делать |
|---|---|---|
| `port 80 is already in use` | Кто-то ещё держит tunnel на serveo | Подождать 30 сек и повторить (anonymous tunnels освобождают порт быстро) |
| `Connection refused` | SSH на 22 заблокирован firewall'ом | Использовать tunnel через 443 (Serveo: `-p 443 serveo.net`) или сменить сеть |
| `Host key verification failed` | Старый key в `/tmp/pm-serveo-known-hosts` | `rm /tmp/pm-serveo-known-hosts && повторить` |
| `Permission denied (publickey)` | Только если в OpenSSH config глобально стоит требование key | `ssh -o PreferredAuthentications=password serveo.net` (но обычно для anonymous SSH key не требуется) |

### `/api/health через preview (3000) недоступен`
Это sanity-check в скрипте (после wait-for-services). Значит `preview.proxy` не настроен в vite.config.ts. См. чек 3 выше.

### `localhost:3000 не отвечает после wait-for-services`
Build упал или preview server не стартовал. Логи:
- `/tmp/pm-api.log` — лог NestJS
- `/tmp/pm-web.log` — лог Vite preview

### Tunnel поднялся, URL виден, но страница не открывается с телефона
1. Открой URL в desktop-браузере — если работает там, проблема в мобильной сети (firewall на public DNS, например)
2. Попробуй другой Wi-Fi на телефоне или mobile data
3. Используй `curl https://<tunnel-url>/api/health` с десктопа — если 200, tunnel работает, проблема UI-level

### Кнопка Dev Login не появляется на login странице (тестируешь через tunnel)
Признак: открываешь tunnel URL с телефона → `/crm/login` показывает только Google SSO кнопку.

Причина: build собран без `VITE_DEV_LOGIN=true`. В production-бандле `import.meta.env.DEV === false`, и условие `DEV || VITE_DEV_LOGIN === 'true'` отдаёт `false` → кнопка скрыта.

Решение: пересобрать через `scripts/pm/prep-user-testing.sh` — он сам выставляет флаг. Если запускаешь build вручную: `VITE_API_URL=/api VITE_DEV_LOGIN=true pnpm --filter @crm/web build`.

### OAuth: `redirect_uri_mismatch` на телефоне
Это ожидаемо — Google OAuth требует фиксированного redirect_uri в Console. Tunnel URL динамический. **Решение: использовать Dev Login** (`POST /api/auth/dev-login {email}`) через login-страницу, не Google.

### Unit-тесты упали и блокируют User Testing
Если знаешь что это флейк (не реальная регрессия) и хочешь быстро показать UI пользователю:
```bash
SKIP_UNIT_TESTS=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```
**Риск:** пользователь увидит bundle с потенциально сломанной логикой. Используй только когда уверен что причина — flaky test infra (race в snapshot, timeout под нагрузкой), а не реальная регрессия. Параллельно открой task на стабилизацию теста.

## Полный fallback: SKIP_TUNNEL

Если ничего не работает / не нужен phone testing — отключить tunnel:
```bash
SKIP_TUNNEL=1 bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Скрипт поднимет API + preview локально, без tunnel. Можно тестировать на десктопе через `http://localhost:3000`.

## Что НЕ работает (известные ограничения)

- **Hot reload через tunnel** — preview-режим не отдаёт HMR. Любая правка кода → перезапуск скрипта.
- **Persistent subdomain** — anonymous Serveo генерирует случайный hash. Чтобы получить стабильный URL — настроить SSH key в `~/.ssh/serveo` + использовать `ssh -i ... user@serveo.net` (см. https://serveo.net).
- **WebSocket** — preview сервер прокидывает HTTP, но не WebSocket. Если бекенд использует WS для чего-то — не пройдёт через tunnel. (CRM пока WS не использует.)
- **Google OAuth** — см. выше. Permanent fix потребует whitelist tunnel-domain в Google Console (нельзя для динамических hash'ей).

## История попыток (для понимания почему именно serveo.net)

1. **LocalTunnel** — 503 Service Unavailable. Известная проблема при высокой нагрузке на free tier.
2. **Cloudflare quick tunnel** — `trycloudflare.com` заблокирован в нашей сети (corporate firewall или ISP-level).
3. **ngrok free** — требует регистрацию + rate-limit очень строгий, hash меняется при каждом старте.
4. **serveo.net** — работает. SSH reverse forward, anonymous, бесплатно.

При смене провайдера: обновить `allowedHosts` в `vite.config.ts` И URL regex в `prep-user-testing.sh`.

## Macos-совместимость скрипта (для DevOps)

Скрипт активно поддерживает macOS без brew coreutils — все используемые утилиты обёрнуты в shim'ы:
- `timeout` → fallback на `gtimeout` → fallback на `perl alarm`
- `mktemp` шаблон → явное имя `/tmp/pm-serveo-$$-${RANDOM}.log`
- `pkill -f vite` → `lsof -ti :3000 | xargs kill` (по порту, не по имени — не убивает сторонние процессы)
- `git checkout` → детектит worktree через `git worktree list --porcelain`, `cd` если ветка в другом worktree
