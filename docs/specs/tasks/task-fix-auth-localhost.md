# task-fix-auth-localhost

## Агент: coder
## Приоритет: HIGH (блокирует локальный dev workflow + User Testing на tunnel)
## Ветка: fix/auth-localhost

## Контекст

На localhost (`pnpm dev` — Vite на :3000, NestJS на :3001) сломаны два auth flow:

### 1. Dev login UI не работает
- Endpoint `POST /api/auth/dev-login` существует в `apps/api/src/auth/auth.controller.ts:185-217` с NODE_ENV gate.
- Frontend UI существует в `apps/web/app/routes/crm_/login.tsx:208-248` — секция «Dev login» с кнопками, callback `await api.post('/auth/dev-login', { email })`. Показывается если `SHOW_DEV_LOGIN = import.meta.env.DEV || import.meta.env['VITE_DEV_LOGIN'] === 'true'`.
- **Root cause:** `apps/web/vite.config.ts` имеет proxy `/api → http://localhost:3001` ТОЛЬКО в `preview` секции. В `server` (dev) секции proxy отсутствует. В результате клик «Dev login» делает запрос на `http://localhost:3000/api/auth/dev-login` → Vite не знает route → 404 / index.html SPA fallback.

### 2. Google OAuth не работает
- `apps/api/src/auth/auth.controller.ts` handler `googleCallback` (lines 60-115) делает `reply.redirect(\`${this.frontendUrl}/crm\`, 302)` после успешной авторизации. `this.frontendUrl` берётся из env (см. `apps/api/src/config/env.ts`).
- На localhost требуется `FRONTEND_URL=http://localhost:3000` чтобы callback вернул юзера на Vite dev server. Если FRONTEND_URL missing/wrong — редирект уходит на 3001 (где фронта нет) либо вообще не строится URL.
- Catch block на line 79-82 silent — ловит exception и редиректит на `/crm/login?error=google_error` БЕЗ console/logger вывода. Невозможно понять что упало.

## AC

- [ ] **AC1: Vite dev proxy `/api` → :3001**
  - Добавить в `apps/web/vite.config.ts` в секцию `server` блок `proxy` идентичный тому что в `preview` (`'/api': { target: 'http://localhost:3001', changeOrigin: true }`)
  - Проверка: после `pnpm dev` запрос `curl http://localhost:3000/api/health` должен проксироваться на NestJS и вернуть валидный ответ (не SPA index.html)

- [ ] **AC2: Dev login работает end-to-end на localhost**
  - Открыть http://localhost:3000/crm/login → секция «Dev login» видна (DEV mode)
  - Клик на любого юзера (например ADMIN) → запрос проходит через proxy → JWT cookie ставится → редирект на `/crm` → `useAuth()` показывает залогиненного юзера
  - E2E smoke: `apps/e2e/tests/auth-dev-login.spec.ts` (если уже есть — должен пройти; если нет — этот task НЕ создаёт E2E, AutoTest добавит отдельно)

- [ ] **AC3: FRONTEND_URL default + validation**
  - В `apps/api/src/config/env.ts` убедиться что `FRONTEND_URL` имеет default `http://localhost:3000` для dev (NODE_ENV !== 'production'). В production должен быть required без default.
  - В `.env.example` подтвердить наличие строки `FRONTEND_URL=http://localhost:3000`

- [ ] **AC4: Google OAuth callback логирует ошибки**
  - В `apps/api/src/auth/auth.controller.ts` метод `googleCallback`, catch block на line 79-82 → добавить `this.logger.error('Google OAuth callback failed', err)` (через NestJS Logger, не console.log)
  - Logger инициализировать в конструкторе как `private readonly logger = new Logger(AuthController.name)` если ещё не инициализирован
  - Цель: следующая попытка OAuth с реальной ошибкой даст trace в API логах

- [ ] **AC5: Google OAuth работает end-to-end на localhost**
  - Pre-requisite: в локальном `.env` должны быть `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL=http://localhost:3001/api/auth/google/callback`, `FRONTEND_URL=http://localhost:3000`. Если не настроены — этот AC проверяется только до момента редиректа на Google (т.е. URL формируется корректно, `/api/auth/google` отвечает 302 с правильным `Location`)
  - Manual smoke: открыть http://localhost:3000/crm/login → клик «Войти с Google» → редирект на accounts.google.com (если creds настроены — продолжить полный flow и вернуться на `/crm`)

## Файлы (ожидаемые изменения)

- `apps/web/vite.config.ts` — добавить `server.proxy`
- `apps/api/src/config/env.ts` — verify FRONTEND_URL default for dev
- `.env.example` — verify FRONTEND_URL line
- `apps/api/src/auth/auth.controller.ts` — Logger в catch block

## Definition of Done

- ac_verified: 1,2,3,4,5
- Локальный smoke (вручную):
  - `pnpm dev` запускает api+web на :3001 и :3000
  - `curl http://localhost:3000/api/health` → 200 (НЕ index.html)
  - http://localhost:3000/crm/login показывает Dev login section
  - Клик ADMIN → редирект на `/crm` → юзер залогинен
  - Клик «Войти с Google» → 302 на accounts.google.com
- Unit tests pass: `pnpm test`
- Typecheck pass: `pnpm typecheck`
- ESLint pass: `pnpm lint`
- E2E локально перед push: `pnpm --filter @crm/e2e test` (правило из feedback memory)

## Out of scope

- Реальная настройка Google OAuth credentials в .env — это manual задача юзера
- Изменение vite proxy для `preview` (он уже работает)
- E2E test для Google OAuth (требует mocking Google API — отдельный task)
- Production deployment env config (FRONTEND_URL для prod уже должен быть в deploy config)

## Заметки для Coder

- НЕ удалять preview.proxy block — он нужен для tunnel.
- ВАЖНО: dev proxy `/api` НЕ должен ломать VITE_DEV_LOGIN flow в preview mode (через tunnel). Проверь оба mode после фикса.
- `apps/api/src/config/env.ts` использует Zod — добавляй default через `.default('http://localhost:3000')` или conditional через preprocess (см. как сделано для S3 booleans в commit 83c54c1).
