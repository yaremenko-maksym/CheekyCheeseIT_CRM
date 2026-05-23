# User Testing Tunnel — Pre-flight Checklist

Запускаем `bash scripts/pm/prep-user-testing.sh <pr_branch>` чтобы поднять User Testing demo с публичным URL для тестирования с телефона. Этот runbook — checklist всех точек отказа на основе реального опыта.

## Конфигурация которая работает (по состоянию на 2026-05-22)

| Слой | Решение | Почему |
|---|---|---|
| **Tunnel provider** | `serveo.net` (SSH reverse forward) | LocalTunnel — 503 на demand. Cloudflare quick tunnel — заблокирован в нашей сети. ngrok free — требует регистрацию + конфликт с rate limits. Serveo — стабильный, anonymous, через SSH. |
| **URL формат** | `https://<hash>-<ip-dashed>.serveousercontent.com` | Anonymous mode (без SSH key auth). |
| **Build mode** | Production build + Vite preview (НЕ dev) | Dev через tunnel = HMR-сокет flaky + сотни unbundled запросов. Preview = минифицированный bundle. |
| **API access** | `vite preview` проксирует `/api → localhost:3001` | Чтобы из mobile-браузера запросы шли через tunnel-origin, а не на localhost телефона. |
| **OAuth login** | **Dev Login** (`POST /api/auth/dev-login {email}`) | Google OAuth не работает через tunnel — `redirect_uri_mismatch` (Google требует whitelist redirect URI, tunnel-URL динамический). Dev Login — bypass для тестирования. |

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

### 4. Build с относительными API URL
`scripts/pm/prep-user-testing.sh` собирает с `VITE_API_URL=/api`. Если переопределяешь окружение — убедись что не задано `VITE_API_URL=http://localhost:3001/api` (это сломает tunnel).

### 5. Постгрес запущен и tracking есть
Скрипт проверит автоматически (drizzle pre-flight). Если красное — `docker-compose up -d` и подождать.

### 6. Dev Login доступен в env
`apps/api/.env`: `ENABLE_DEV_LOGIN=true` (или эквивалент). Если выключено — phone-тестирование через tunnel невозможно без OAuth flow.

## Запуск

```bash
bash scripts/pm/prep-user-testing.sh <pr_branch>
```

Ожидай:
- ~30-40 сек build (api + web)
- ~10 сек старт серверов
- ~5-30 сек handshake с serveo.net + парсинг URL
- Итого: ~60-90 сек до видимости рамки с URL

## Если упало — диагностика

### `Serveo SSH tunnel упал`
Лог tunnel в `/tmp/pm-serveo-XXXXXX.log` (печатается в stderr скрипта). Типичные ошибки:

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

### OAuth: `redirect_uri_mismatch` на телефоне
Это ожидаемо — Google OAuth требует фиксированного redirect_uri в Console. Tunnel URL динамический. **Решение: использовать Dev Login** (`POST /api/auth/dev-login {email}`) через login-страницу, не Google.

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
