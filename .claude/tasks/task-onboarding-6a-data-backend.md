# task-onboarding-6a-data-backend

## Агент: coder

## Приоритет: high

## Зависит от: —

## Ветка: feature/onboarding-data-backend

## Контекст

Phase 6A фичи Onboarding flow. См. `docs/specs/onboarding-brief.md` для полного дизайна.

Цель этой задачи: backend infrastructure для онбординг-флоу — миграция БД (4 таблицы + sequence), три NestJS модуля (`contracts/`, `tos/`, `onboarding/`), `OnboardingGuard`, shared Zod-схемы и seed-данные.

UI, frontend gate, invoice integration — следующие фазы (6B/6D), сюда НЕ входят.

## Конкретные изменения

### 1. Миграция БД

`apps/api/drizzle/migrations/0027_onboarding.sql` — новая миграция (next в sequence после `0026_company_debtor.sql`).

Создаёт 4 таблицы + 1 sequence (см. секцию «DB schema» ниже). После `pnpm --filter @crm/api db:generate` — обновить и `apps/api/src/database/schema.ts` чтобы Drizzle ORM знал новые таблицы.

**Перед генерацией миграции** обязательно прочитать через `mcp__postgres__query` текущую структуру `users` для resolve payment requisites columns:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'users' ORDER BY ordinal_position;
```

Документировать в task `.progress.md` найденные имена колонок (USDT-wallet, ФОП-данные, preferred-method). Они нужны для resolve variables в Phase 6A item #5 (signed-contracts.service).

### 2. Shared schemas

`packages/shared/src/schemas/contracts.ts` — новый файл:

- `contractTargetRoleSchema` — `z.enum(['HR', 'SENIOR', 'JUNIOR', 'DROP', 'ACCOUNTANT'])` (без ADMIN)
- `contractTemplateSchema` — id, targetRole, version, bodyMarkdown, isActive, createdByUserId, createdAt
- `createContractTemplateSchema` — input для admin publish (targetRole, bodyMarkdown)
- `signedContractSchema` — id, userId, templateId, bodyMarkdownSnapshot, variablesFilled, signedTypedName, signedIp, signedUserAgent, signedAt, contractNumber
- `signContractSchema` — input: `{ typedName: z.string().min(1).max(200) }`

`packages/shared/src/schemas/tos.ts` — новый файл:

- `tosVersionSchema` — id, version, bodyMarkdown, isActive, createdByUserId, createdAt
- `createTosVersionSchema` — input для admin publish (bodyMarkdown)
- `tosAcceptanceSchema` — id, userId, tosVersionId, acceptedAt, acceptedIp, acceptedUserAgent

`packages/shared/src/schemas/onboarding.ts` — новый файл:

- `onboardingStatusSchema` — `{ requiresContract: boolean, requiresTos: boolean, contractTemplate: contractTemplateSchema | null, tosVersion: tosVersionSchema | null, tosUpdateAvailable: boolean, latestTosVersion: tosVersionSchema | null }`

Экспортировать из `packages/shared/src/schemas/index.ts`.

### 3. NestJS module — `contracts`

`apps/api/src/contracts/contracts.module.ts` — `ContractsModule` импортирует DatabaseModule и UsersModule (если нужно).

`apps/api/src/contracts/contract-templates.controller.ts`:

- `GET /api/contracts/templates` — ADMIN: список всех templates с активными версиями per role. SENIOR/HR/JUNIOR/DROP/ACCOUNTANT: 403 (только ADMIN).
- `GET /api/contracts/templates/current/:role` — возвращает активный template для конкретной role. Доступно: ADMIN, либо self (`role` === user's role). Иначе 403.
- `POST /api/contracts/templates` — ADMIN only: создать новую версию (атомарно: `version = max(version)+1`, `is_active = TRUE`, previous active → `is_active = FALSE`).
- `GET /api/contracts/templates/:id` — ADMIN only: read конкретную версию (для history view).

Bodies: Zod через global ZodValidationPipe (или manual `.parse()`). Errors → `ZodExceptionFilter`.

`apps/api/src/contracts/contract-templates.service.ts`:

- `listAll()` — все templates
- `getCurrentForRole(role)` — active template для role
- `getById(id)`
- `publish({ targetRole, bodyMarkdown, createdByUserId })` — atomic: deactivate previous, insert new active с `version = max + 1`

`apps/api/src/contracts/signed-contracts.controller.ts`:

- `POST /api/contracts/sign` — current user signs MSA. Body: `{ typedName }`. Логика:
  1. Fetch active template для `req.user.role`. Если role === ADMIN → 400 `'ADMIN_DOES_NOT_SIGN_CONTRACTS'`.
  2. Проверить, что у user'а ещё нет signed_contract для этого template_id (idempotency, чтобы повторная отправка не создавала дубликаты — return existing).
  3. Resolve variables: см. список в onboarding-brief §4.3. Точные имена payment-requisites колонок — из исследования в #1.
  4. Interpolate template body via `{{var}}` substitution → `body_markdown_snapshot`.
  5. Generate `contract_number = 'CHK-' || nextval('contract_number_seq') || '-' || EXTRACT(YEAR FROM NOW() AT TIME ZONE 'UTC')`.
  6. Capture IP/UA из `req.ip` (Fastify) и `req.headers['user-agent']`.
  7. Insert signed_contracts row → return signedContractSchema.
- `GET /api/contracts/me` — свои подписанные.
- `GET /api/contracts/:id` — RBAC: ADMIN, ACCOUNTANT, либо owner (`signed_contracts.user_id === req.user.id`). Иначе 403.

`apps/api/src/contracts/signed-contracts.service.ts`:

- `sign({ userId, userRole, typedName, ip, userAgent })` — основная логика, atomic transaction.
- `findById(id, requester)` — RBAC enforcement.
- `findMine(userId)`.
- `interpolateVariables(template, user)` — helper, чистый функционал (юнит-тестируемый).

### 4. NestJS module — `tos`

`apps/api/src/tos/tos.module.ts`.

`apps/api/src/tos/tos.controller.ts`:

- `GET /api/tos/current` — текущая активная ToS-версия. Доступно всем authenticated (даже без onboarding — bypass).
- `GET /api/tos/versions` — ADMIN only: все версии.
- `POST /api/tos` — ADMIN only: публикация новой версии. Body: `{ bodyMarkdown }`. Logic: deactivate previous active, insert new с `version = max + 1`, `is_active = TRUE`.
- `POST /api/tos/accept` — текущий user принимает active ToS-version. Если уже принимал — idempotent (return existing acceptance). Captures IP/UA.

`apps/api/src/tos/tos.service.ts`:

- `getCurrent()` — active version
- `listAll()` — для admin
- `publish({ bodyMarkdown, createdByUserId })` — atomic
- `accept({ userId, ip, userAgent })` — atomic, idempotent

### 5. NestJS module — `onboarding`

`apps/api/src/onboarding/onboarding.module.ts`.

`apps/api/src/onboarding/onboarding.controller.ts`:

- `GET /api/onboarding/status` — текущий user. Возвращает `onboardingStatusSchema`:
  - `requiresContract = !exists signed_contracts (user_id, template_id IN active for role)`
  - `requiresTos = !exists tos_acceptances (user_id, tos_version_id = active.id)`
  - `contractTemplate` = active template для role (если ADMIN → null)
  - `tosVersion` = текущая active (если требуется)
  - `tosUpdateAvailable = (user принял старую версию AND active version newer)` — `!requiresTos AND latest_tos.version > max(accepted_tos.version)`
  - `latestTosVersion` = active (для banner)

ADMIN: всё `false/null`, кроме `tosVersion=null, tosUpdateAvailable=false, latestTosVersion=null` (он bypass).

`apps/api/src/onboarding/onboarding.service.ts` — основная логика resolve status.

### 6. OnboardingGuard

`apps/api/src/auth/onboarding.guard.ts` — NestJS `CanActivate`, injected via `APP_GUARD` token в `app.module.ts` (global, AFTER JwtGuard).

Логика:

```ts
if (request.path.startsWith bypass path) return true
if (req.user.role === 'ADMIN') return true
const status = await onboardingService.getStatus(req.user.id, req.user.role)
if (status.requiresContract || status.requiresTos) {
  throw new ForbiddenException({
    error: 'ONBOARDING_REQUIRED',
    missing: [...(status.requiresContract ? ['contract'] : []), ...(status.requiresTos ? ['tos'] : [])]
  })
}
return true
```

**Bypass paths** (точные):

- `/api/auth/*` (включая `/api/auth/me`)
- `/api/onboarding/status`
- `/api/tos/current`
- `/api/contracts/templates/current/` (любой role suffix)
- `/api/contracts/sign`
- `/api/tos/accept`

Реализация через `Reflector` + `@SetMetadata('skipOnboardingGuard', true)` декоратор для endpoint'ов, ИЛИ через path-prefix check (выбрать удобный — обычно вторым проще для path-match с params).

### 7. AppModule wire-up

`apps/api/src/app.module.ts` — импортировать новые модули (`ContractsModule`, `TosModule`, `OnboardingModule`), зарегистрировать `OnboardingGuard` через `APP_GUARD`. Убедиться что order: `JwtGuard` ДО `OnboardingGuard` (Nest guards выполняются в порядке регистрации — JwtGuard первым устанавливает `req.user`).

### 8. Seed скрипт

`apps/api/src/database/seed.ts` — добавить:

- 5 базовых contract_templates (по одному per role) с placeholder body. Пример body для SENIOR:

  ```markdown
  # Master Service Agreement — Senior Engineer

  **Виконавець:** {{employeeName}} ({{employeeEmail}})
  **Дата онбордингу:** {{onboardingDate}}
  **Замовник:** {{companyName}}

  ## Платіжні реквізити

  - USDT (ERC-20): {{walletUsdt}}
  - ФОП (UAH): {{bankUahFop}}
  - Метод оплати за замовчуванням: {{preferredMethod}}

  ## Умови співпраці

  TBD — to be filled by ADMIN via UI editor.

  Цей шаблон містить заглушку для початкового запуску. Адміністратор оновить тіло через `/crm/admin/templates/contracts/SENIOR`.

  ---

  Підписант: \***\*\*\*\*\***\_\_\***\*\*\*\*\***
  ```

  Создать аналогичные для HR, JUNIOR, DROP, ACCOUNTANT — body на русском/украинском (CLAUDE.md требует русский для UI, но контракты на украинском приемлемо как business документ). Один `createdByUserId` = admin seed user.

- 1 ToS v1 с placeholder body (~3-5 параграфов markdown). `created_by_user_id` = admin seed user.

Seed запускается после migrations: `pnpm --filter @crm/api db:seed`.

### 9. Unit tests (Vitest)

Покрыть:

- `contract-templates.service.spec.ts`: list, getCurrent, publish (atomic deactivate+insert), getById
- `signed-contracts.service.spec.ts`:
  - sign happy path (resolves variables, generates contract_number, captures IP/UA, atomic)
  - sign idempotency (повтор signing возвращает existing, не duplicate)
  - sign ADMIN throws
  - interpolateVariables: все placeholder подставлены; missing values → `'не указано'`
  - findById RBAC: owner ✓, ADMIN ✓, ACCOUNTANT ✓, other SENIOR ✗
- `tos.service.spec.ts`: getCurrent, publish atomic, accept idempotent
- `onboarding.service.spec.ts`: getStatus для всех 6 ролей с разными combo (signed/not, accepted/not, ADMIN bypass)
- `onboarding.guard.spec.ts`: bypass paths, ADMIN, requires contract, requires tos, both fulfilled → pass

## API endpoints (новые)

- `GET /api/contracts/templates` — ADMIN only
- `GET /api/contracts/templates/current/:role` — ADMIN или self
- `POST /api/contracts/templates` — ADMIN only
- `GET /api/contracts/templates/:id` — ADMIN only
- `POST /api/contracts/sign` — authenticated (не ADMIN)
- `GET /api/contracts/me` — authenticated
- `GET /api/contracts/:id` — RBAC (ADMIN | ACCOUNTANT | owner)
- `GET /api/tos/current` — authenticated (bypass guard)
- `GET /api/tos/versions` — ADMIN only
- `POST /api/tos` — ADMIN only
- `POST /api/tos/accept` — authenticated (bypass guard)
- `GET /api/onboarding/status` — authenticated (bypass guard)

## DB schema

```sql
-- contract_templates
CREATE TABLE contract_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_role role NOT NULL CHECK (target_role <> 'ADMIN'),
  version INT NOT NULL,
  body_markdown TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (target_role, version)
);

CREATE UNIQUE INDEX contract_templates_one_active_per_role
  ON contract_templates(target_role) WHERE is_active = TRUE;

-- contract_number sequence
CREATE SEQUENCE contract_number_seq;

-- signed_contracts
CREATE TABLE signed_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  template_id UUID NOT NULL REFERENCES contract_templates(id),
  body_markdown_snapshot TEXT NOT NULL,
  variables_filled JSONB NOT NULL DEFAULT '{}'::jsonb,
  signed_typed_name TEXT NOT NULL,
  signed_ip TEXT,
  signed_user_agent TEXT,
  signed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  contract_number TEXT NOT NULL UNIQUE
);
CREATE INDEX signed_contracts_user_id_idx ON signed_contracts(user_id);

-- tos_versions
CREATE TABLE tos_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  body_markdown TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX tos_versions_one_active
  ON tos_versions((TRUE)) WHERE is_active = TRUE;

-- tos_acceptances
CREATE TABLE tos_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tos_version_id UUID NOT NULL REFERENCES tos_versions(id),
  accepted_at TIMESTAMP NOT NULL DEFAULT NOW(),
  accepted_ip TEXT,
  accepted_user_agent TEXT,
  UNIQUE (user_id, tos_version_id)
);
CREATE INDEX tos_acceptances_user_id_idx ON tos_acceptances(user_id);
```

После Drizzle generate — `apps/api/src/database/schema.ts` дополнить соответствующими `pgTable` definitions с правильными типами.

## RBAC

| Action                                     | ADMIN  | SENIOR | JUNIOR | HR    | DROP  | ACCOUNTANT |
| ------------------------------------------ | ------ | ------ | ------ | ----- | ----- | ---------- |
| List all contract templates                | ✓      | —      | —      | —     | —     | —          |
| Read current template для своей роли       | ✓      | ✓      | ✓      | ✓     | ✓     | ✓          |
| Publish new contract template version      | ✓      | —      | —      | —     | —     | —          |
| Sign own MSA (single time per active vers) | —      | ✓      | ✓      | ✓     | ✓     | ✓          |
| Read own signed contract                   | ✓      | ✓      | ✓      | ✓     | ✓     | ✓          |
| Read any user's signed contract            | ✓      | —      | —      | —     | —     | ✓          |
| Read current ToS                           | ✓      | ✓      | ✓      | ✓     | ✓     | ✓          |
| Publish new ToS version                    | ✓      | —      | —      | —     | —     | —          |
| Accept ToS                                 | bypass | ✓      | ✓      | ✓     | ✓     | ✓          |
| Pass OnboardingGuard                       | bypass | guard  | guard  | guard | guard | guard      |

## Acceptance criteria

Каждый пункт проверяем через grep/diff/postgres:

- [ ] AC1: `apps/api/drizzle/migrations/0027_onboarding.sql` существует и содержит 4 `CREATE TABLE` + `CREATE SEQUENCE contract_number_seq` (`grep -c "CREATE TABLE" 0027_*.sql` → 4)
- [ ] AC2: `apps/api/src/database/schema.ts` имеет 4 новых `pgTable` (contractTemplates, signedContracts, tosVersions, tosAcceptances)
- [ ] AC3: `packages/shared/src/schemas/contracts.ts`, `tos.ts`, `onboarding.ts` существуют + экспорт из `index.ts`
- [ ] AC4: `apps/api/src/contracts/contracts.module.ts` + 2 controllers + 2 services
- [ ] AC5: `apps/api/src/tos/tos.module.ts` + 1 controller + 1 service
- [ ] AC6: `apps/api/src/onboarding/onboarding.module.ts` + 1 controller + 1 service
- [ ] AC7: `apps/api/src/auth/onboarding.guard.ts` существует и registered как `APP_GUARD` в `app.module.ts` после JwtGuard
- [ ] AC8: Seed создаёт 5 contract_templates (по одному per role HR/SENIOR/JUNIOR/DROP/ACCOUNTANT, `is_active=true`) + 1 ToS v1 (`is_active=true`) — verify via `mcp__postgres__query` после `pnpm --filter @crm/api db:seed`
- [ ] AC9: Unit tests для contract-templates.service, signed-contracts.service (включая interpolateVariables + RBAC), tos.service, onboarding.service, onboarding.guard — все зелёные (`pnpm --filter @crm/api test`)
- [ ] AC10: Manual smoke test через `curl` или `pnpm exec ts-node`:
  - GET `/api/onboarding/status` для seed senior1 → `requiresContract=true, requiresTos=true`
  - POST `/api/contracts/sign {typedName:'Test'}` → contract created, contract_number формат `CHK-N-2026`
  - POST `/api/tos/accept` → acceptance row
  - GET `/api/onboarding/status` повторно → `requiresContract=false, requiresTos=false`
  - GET `/api/onboarding/status` для seed admin → all false (bypass)

## Interaction tests

Interaction tests N/A — backend-only задача, нет UI/keyboard/focus компонентов.

## Запрещено трогать

- `apps/web/**` (frontend — Phase 6B)
- `apps/api/src/invoices/**` (Phase 6D)
- `apps/e2e/**` (E2E — Phase 6B)
- `.github/workflows/**` (DevOps zone)
- Любые existing миграции (только новая 0027)
- `docs/agents/**` (PM/Architect zone)
- `docs/specs/onboarding-brief.md` (PM artifact — read only)

## Verification (Coder перед `git push`)

1. `git diff HEAD --name-only` — содержит ТОЛЬКО файлы из «Конкретные изменения»
2. `pnpm --filter @crm/api typecheck && pnpm --filter @crm/shared typecheck` — зелёные
3. `pnpm --filter @crm/api lint && pnpm --filter @crm/shared lint` — зелёные (использовать `mcp__eslint__lint-files` для предварительной проверки)
4. `pnpm --filter @crm/api test` — все unit tests passed (>= 9 новых spec'ов)
5. `pnpm --filter @crm/api db:migrate && pnpm --filter @crm/api db:seed` локально проходит без ошибок
6. `mcp__postgres__query` подтверждает что 5 contract_templates и 1 tos_versions row'ы созданы после seed
7. Manual curl smoke test (см. AC10) — записать в `task-onboarding-6a-data-backend.progress.md` результаты
8. Commit message содержит:
   ```
   ac_verified: 1,2,3,4,5,6,7,8,9,10
   ```
   (без `vision:` — задача без UI)

## Skills required

Mandatory invocation per `docs/agents/RULES.md` §3:

- `superpowers:using-superpowers` (старт сессии)
- `superpowers:brainstorming` — НЕ требуется (PM уже сделал; task четко определён)
- `superpowers:writing-plans` — перед implementation (ОБЯЗАТЕЛЬНО для multi-step)
- `superpowers:test-driven-development` — для каждого нового service (writing tests first)
- `superpowers:verification-before-completion` — перед push
- `superpowers:security-review` — задача touches auth (OnboardingGuard) → ОБЯЗАТЕЛЬНО перед PR

## Notes для Coder

- Сейчас идёт background AutoTest задача (PR #82) — НЕ ВМЕШИВАЙСЯ в её работу. Если что-то конфликтное на `apps/e2e/**` — это её зона, ты её не трогаешь.
- Текущая последняя migration — `0026_company_debtor.sql`. Следующий номер = `0027`.
- `mcp__postgres__query` доступен — используй для проверки реальной схемы `users` (для resolve payment-requisites column names).
- `mcp__ast-grep__find_code` — используй для поиска существующих модулей-аналогов (например, как зарегистрирован `JwtGuard` в `app.module.ts`).
- В `apps/api/src/database/schema.ts` смотри как уже определены другие таблицы (например, `invoices`) — следуй тому же паттерну для Drizzle.
- Existing zod валидация — паттерн в `apps/api/src/transactions/transactions.controller.ts` или похожих.
- IP capture: Fastify `req.ip` (с trust proxy = enabled — проверить).
- ZodExceptionFilter уже работает global — `apps/api/src/zod-exception.filter.ts`.
