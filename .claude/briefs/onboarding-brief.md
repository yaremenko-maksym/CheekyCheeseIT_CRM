# Onboarding flow + редактируемые шаблоны контрактов — Brief

**Дата:** 2026-06-03
**Автор:** PM
**Статус:** Approved by USER (design), pending spec review
**Связанные PR placeholder:** Phase 6A → 6B → 6C → 6D

---

## 1. Цель

Каждый сотрудник перед началом работы в CRM **обязан**:

1. Подписать MSA (Master Service Agreement) — шаблон зависит от роли (HR / SENIOR / JUNIOR / DROP / ACCOUNTANT).
2. Принять Terms of Service (общие для всех ролей).

Если хотя бы одно из двух не сделано — пользователь не может пользоваться CRM (redirect на `/crm/onboarding`).

Дополнительно ADMIN может редактировать шаблоны контрактов и ToS через UI. Новые сотрудники получают актуальную (`is_active=true`) версию. Подписанные/принятые документы — immutable (audit trail, snapshot хранится в DB).

---

## 2. Business decisions (от USER)

| Тема                              | Решение                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Механизм подписания               | Click-to-sign + typed name + IP/UA + timestamp (analog invoice signing)                  |
| Формат шаблона                    | Markdown + переменные `{{var}}`                                                          |
| ToS обновился у existing user'ов  | Soft-notify (sticky banner сверху, работа НЕ блокируется)                                |
| Хранение подписанных контрактов   | DB JSON snapshot (`body_markdown_snapshot` + `variables_filled`) + on-the-fly PDF        |
| Количество шаблонов               | 5 — отдельный per role (HR / SENIOR / JUNIOR / DROP / ACCOUNTANT). ADMIN не подписывает. |
| Refactor `pdf-invoice.service.ts` | **Отдельная фаза позже** (не в этом scope). Backlog item.                                |
| ADMIN onboarding                  | Bypass — ADMIN не подписывает контракт и не принимает ToS                                |
| RBAC чтения contracts             | ADMIN + ACCOUNTANT + сам сотрудник                                                       |
| Backfill existing users           | НЕТ backfill — force onboarding при следующем входе всем (кроме ADMIN)                   |
| Invoice fallback при отсутствии   | `contract_number = NULL`, в PDF прочерк (не блокируем generate)                          |
| Контракт scope                    | Two-tier: MSA (онбординг) + SOW (per project, FUTURE)                                    |
| Payment requisites timing         | ADMIN заполняет при создании пользователя; в MSA подставляются как переменные            |

---

## 3. Scope of this delivery

### In scope (4 phases / 4 PR)

- MSA шаблоны per role (5 шаблонов) + редактирование ADMIN'ом через UI
- ToS глобальный + редактирование + versioning + soft-notify на update
- Onboarding gate (backend guard + frontend redirect)
- Sign mechanism: click-to-sign + typed name + IP/UA capture
- Audit trail: immutable snapshot, contract_number per signed contract
- Invoice integration: real `contract_number` вместо placeholder `CHK-${userId.slice(0,8)}-${year}` в `apps/api/src/invoices/invoices.service.ts:345`

### Out of scope (backlog)

- **SOW per project** (rate, %, currency для конкретного project_member) — следующая фаза после 6D
- **Refactor `pdf-invoice.service.ts` → generic `pdf-generation.service.ts`** — унификация паттерна DB-snapshot + on-the-fly PDF для всех документов платформы (invoice, contract, future receipts). Записан в `docs/agents/memory/pm/lessons.md` как backlog.
- **PDF generation для contracts** — в Phase 6A-D PDF не генерится. Подписанный контракт показывается как rendered Markdown в UI. PDF download — после refactor pdf-invoice (часть backlog item).

---

## 4. Data model

### 4.1. Миграция `0027_onboarding.sql`

```sql
-- contract_templates: редактируемые шаблоны
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

-- signed_contracts: immutable audit trail
CREATE SEQUENCE contract_number_seq;

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

-- tos_versions: глобальный versioned ToS
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

-- tos_acceptances: кто какую версию принял
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

### 4.2. Contract number format

`CHK-{seq}-{year}` где `seq` = `nextval('contract_number_seq')`, `year` = UTC год подписания.
Примеры: `CHK-1-2026`, `CHK-2-2026`, ..., `CHK-247-2027`.

Sequence начинается с 1. Monotonic, no gaps в normal flow (rollback может оставить gap — это ok).

### 4.3. Variables для template interpolation

Resolved в момент `POST /api/contracts/sign`. Snapshot в `signed_contracts.variables_filled`.

| Variable              | Источник                                                        |
| --------------------- | --------------------------------------------------------------- |
| `{{employeeName}}`    | `users.display_name`                                            |
| `{{employeeEmail}}`   | `users.email`                                                   |
| `{{role}}`            | translated label: Senior / Junior / HR / Drop / Accountant      |
| `{{onboardingDate}}`  | `signed_at` (UTC formatted)                                     |
| `{{companyName}}`     | hardcoded `'Cheeky Cheese IT'`                                  |
| `{{walletUsdt}}`      | `users.<USDT ERC-20 поле>` (если present, иначе `'не указано'`) |
| `{{bankUahFop}}`      | `users.<ФОП поля>` (IBAN/EDRPOU forming, если present)          |
| `{{preferredMethod}}` | `users.<preferred method поле>` — `crypto` или `fop`            |

Точные имена payment-requisites колонок резолвит Coder в Phase 6A через `mcp__postgres__query` на текущую схему `users` (миграции 0003, 0004, 0024 их добавляли — exact column names TBD by Coder).

---

## 5. Backend (NestJS)

### 5.1. Modules

**`apps/api/src/contracts/`:**

- `contracts.module.ts`
- `contract-templates.controller.ts`
  - `GET /api/contracts/templates` — list all per current role caller (ADMIN видит все 5)
  - `GET /api/contracts/templates/current/:role` — get active template per role
  - `POST /api/contracts/templates` — ADMIN only: create new version (auto-deactivate previous active)
  - `GET /api/contracts/templates/:id` — read single (ADMIN only)
- `contract-templates.service.ts`
- `signed-contracts.controller.ts`
  - `POST /api/contracts/sign` — самоподпись для текущего user'а (resolve variables, snapshot, generate contract_number)
  - `GET /api/contracts/me` — свои подписанные контракты
  - `GET /api/contracts/:id` — RBAC: ADMIN / ACCOUNTANT / owner
- `signed-contracts.service.ts`

**`apps/api/src/tos/`:**

- `tos.module.ts`
- `tos.controller.ts`
  - `GET /api/tos/current` — active ToS version
  - `GET /api/tos/versions` — all versions (ADMIN only)
  - `POST /api/tos` — ADMIN only: publish new version (auto-deactivate previous active)
  - `POST /api/tos/accept` — user accepts current version
- `tos.service.ts`

**`apps/api/src/onboarding/`:**

- `onboarding.module.ts`
- `onboarding.controller.ts`
  - `GET /api/onboarding/status` → `{ requiresContract: bool, requiresTos: bool, contractTemplate?: {...}, tosVersion?: {...} }`
- `onboarding.service.ts`

### 5.2. OnboardingGuard

`apps/api/src/auth/onboarding.guard.ts` — NestJS global guard, runs after `JwtGuard`.

**Логика:**

```
if (req.user.role === 'ADMIN') return true;
if (req.path startswith one of bypass-paths) return true;

const needsContract = !exists(signed_contracts WHERE user_id = req.user.id AND template_id IN (active templates for user.role));
const needsTos = !exists(tos_acceptances WHERE user_id = req.user.id AND tos_version_id = active tos);

if (needsContract OR needsTos) {
  throw new ForbiddenException({ error: 'ONBOARDING_REQUIRED', missing: [...] });
}
return true;
```

**Bypass paths:**

- `/api/auth/*` (включая `/api/auth/me` — frontend читает текущего user до status check)
- `/api/onboarding/*`
- `/api/tos/current` (нужен для отображения текста на onboarding page)
- `/api/contracts/templates/current/:role` (нужен для отображения preview на onboarding page)
- `/api/contracts/sign` и `/api/tos/accept` (механизм выхода из gate)

### 5.3. Soft-notify check (отдельный endpoint)

`GET /api/onboarding/status` возвращает дополнительное поле:

```jsonc
{
  "requiresContract": false,
  "requiresTos": false,
  "tosUpdateAvailable": true, // user принял старую версию, но активная новее
  "latestTosVersion": { ... }
}
```

Frontend banner показывает при `tosUpdateAvailable && !requiresTos`.

---

## 6. Frontend (Vite + TanStack Router)

### 6.1. Routes

**`apps/web/app/routes/crm/onboarding/`:**

- `route.tsx` — layout для onboarding wizard (без sidebar)
- `index.tsx` — 2-step wizard: Step 1 Sign Contract → Step 2 Accept ToS

**`apps/web/app/routes/crm/admin/templates/`:**

- `route.tsx` — ADMIN-only layout (RBAC enforce); tab nav: Contracts / ToS
- `contracts.tsx` — список 5 contract templates per role
- `contracts.$role.tsx` — split-view editor: CodeMirror (Markdown left) ↔ live preview (react-markdown right)
- `tos.tsx` — текущая активная ToS version editor + history list
- `tos.new.tsx` — публикация новой ToS версии

### 6.2. Gate в `apps/web/app/routes/crm/route.tsx`

`useQuery(['onboarding-status'], fetchOnboardingStatus)` после auth check:

- Если `requiresContract || requiresTos` AND current route != `/crm/onboarding/**` → redirect via `Navigate` to `/crm/onboarding`
- Если `tosUpdateAvailable` → sticky banner сверху layout с CTA «Прочитать новую версию ToS» (link на `/crm/onboarding?step=tos`)

### 6.3. Sign mechanism UI

Onboarding Step 1 (Sign Contract):

1. Render template Markdown с подставленными переменными (через react-markdown)
2. Input «Введіть ваше имя для подписи» (typed name)
3. Checkbox «Я ознайомився и підтверджую»
4. Button «Підписати» — disabled пока typed name пуст и checkbox не отмечен
5. На click: `POST /api/contracts/sign` с `{ typed_name }` → server resolves IP/UA from request → создаёт `signed_contracts` row → возвращает contract_number → wizard переходит на Step 2

Onboarding Step 2 (Accept ToS):

1. Render ToS Markdown
2. Checkbox «Я приймаю Terms of Service»
3. Button «Прийняти» — на click `POST /api/tos/accept` → создаёт `tos_acceptances` → redirect to `/crm/dashboard`

### 6.4. Soft-notify banner

Sticky top banner в crm layout (между header и main content), shadcn `<Alert>` variant:

```
ℹ️ Опубліковано нову версію Terms of Service. [Прочитати →]
```

Button → `/crm/onboarding?step=tos` (один шаг wizard'а; после accept → return to previous page).

---

## 7. Shared schemas (`packages/shared/src/schemas/`)

- `contracts.ts`:
  - `contractTargetRoleSchema` (z.enum, без ADMIN)
  - `contractTemplateSchema`
  - `createContractTemplateSchema`
  - `signedContractSchema`
  - `signContractSchema` (input: typed_name)
- `tos.ts`:
  - `tosVersionSchema`
  - `createTosVersionSchema`
  - `tosAcceptanceSchema`
- `onboarding.ts`:
  - `onboardingStatusSchema`

Экспортировать из `packages/shared/src/schemas/index.ts`.

---

## 8. Phase decomposition

### Phase 6A — Data model + Backend (1 PR)

**Branch:** `feature/onboarding-data-backend`
**Reviewer:** **MANDATORY** (миграция + auth-adjacent + > 500 LOC ожидается)

**AC:**

1. Миграция `0027_onboarding.sql` создаёт 4 таблицы + sequence (см. §4.1)
2. Drizzle schema sync `apps/api/src/database/schema.ts` обновлён
3. `apps/api/src/contracts/` модуль с 2 controllers + 2 services, все endpoints (см. §5.1)
4. `apps/api/src/tos/` модуль с 1 controller + 1 service
5. `apps/api/src/onboarding/` модуль с status endpoint
6. `OnboardingGuard` создан и подключён глобально (`AppModule.providers` через `APP_GUARD`)
7. Shared schemas (`contracts.ts`, `tos.ts`, `onboarding.ts`) + экспорт из index
8. Unit tests (Vitest): contracts.service / tos.service / onboarding.service / onboarding.guard
9. Seed: 5 базовых contract_templates (по одному per role, body = placeholder draft Markdown) + ToS v1 (placeholder draft)
10. Все endpoints проверены через `mcp__postgres__query` на реальной схеме

**Не входит:** UI, frontend изменения, invoice contract_number replacement.

### Phase 6B — Onboarding UI + gate (1 PR)

**Branch:** `feature/onboarding-ui-gate`
**Reviewer:** **MANDATORY** (auth-adjacent)
**Depends on:** 6A merged

**AC:**

1. Route `/crm/onboarding` с 2-step wizard
2. Gate в `routes/crm/route.tsx`: useQuery `/api/onboarding/status` → redirect logic
3. Sign Contract step: render Markdown preview, typed name, checkbox, sign button → POST sign
4. Accept ToS step: render Markdown, checkbox, accept button → POST accept
5. Soft-notify sticky banner при `tosUpdateAvailable`
6. После завершения wizard'а → `/crm/dashboard`
7. ADMIN bypass: онбординг не показывается, gate сразу пропускает
8. E2E (`apps/e2e/tests/onboarding-*.spec.ts`):
   - **5 ролей** (HR, SENIOR, JUNIOR, DROP, ACCOUNTANT): первый логин → попадает на onboarding → подписывает контракт + принимает ToS → попадает на /crm/dashboard
   - ADMIN logs in → НЕ попадает на onboarding
   - Onboarded user logs in → НЕ попадает на onboarding (idempotent)
   - Soft-notify banner shows при new ToS version

**Не входит:** ADMIN template editing UI, invoice integration.

### Phase 6C — Admin template editor (1 PR)

**Branch:** `feature/onboarding-admin-editor`
**Reviewer:** Conditional (если diff > 500 LOC)
**Depends on:** 6A merged

**AC:**

1. Route `/crm/admin/templates` с tab nav: Contracts / ToS — ADMIN only (redirect for non-ADMIN)
2. `contracts.tsx` — список 5 templates per role с current active version, link на editor
3. `contracts.$role.tsx` — split-view editor (CodeMirror Markdown left + react-markdown preview right). Save → POST new version (auto-deactivate previous active)
4. `tos.tsx` — editor для current active version + list of historical versions (read-only view)
5. `tos.new.tsx` — публикация новой версии
6. Variables hint в editor: подсказка списка доступных `{{vars}}`
7. RBAC enforcement: non-ADMIN видит 403/redirect на `/crm/dashboard`
8. E2E:
   - ADMIN updates SENIOR contract template → новый SENIOR user видит новый body на onboarding
   - ADMIN publishes new ToS → existing onboarded user видит soft-notify banner
   - non-ADMIN заходит на `/crm/admin/templates` → не видит UI

### Phase 6D — Invoice contract_number replacement (1 PR)

**Branch:** `feature/invoice-real-contract-number`
**Reviewer:** **MANDATORY** (finance touch)
**Depends on:** 6A merged

**AC:**

1. `apps/api/src/invoices/invoices.service.ts:337-345` — формула placeholder убрана
2. Новая логика: `contract_number = signed_contracts.contract_number` (lookup по user_id и target_role)
3. Fallback: если signed_contracts row не найден → `contract_number = NULL`
4. `apps/api/src/invoices/invoice-pdf.service.ts` — при `contract_number === null` рендерит прочерк («—»)
5. Unit tests обновлены (тесты в `invoices.service.spec.ts:895-899` + `invoice-pdf.service.spec.ts:460-588` — все references на `CHK-deadbeef-2026` заменены)
6. E2E:
   - Onboarded user generates invoice → PDF содержит real contract_number из его signed_contracts
   - User без signed_contract (теоретический legacy case) → PDF показывает прочерк (не падает)

**Не входит:** Refactor invoice-pdf service на unified pattern (backlog).

---

## 9. Backlog (после 6A-D, отдельные фичи)

1. **SOW per project** — Statement of Work с rate/%/currency, подписывается при добавлении user в `project_members`. Шаблоны редактируются ADMIN. Связь invoice ↔ SOW для конкретного project_member.
2. **Refactor `pdf-invoice.service.ts` → `pdf-generation.service.ts`** — generic service, который принимает Markdown snapshot + variables и рендерит PDF. Используется и invoice, и signed_contracts download.
3. **PDF download для signed contracts** (нужен после backlog item #2).
4. **Audit log endpoint для ACCOUNTANT** — сводный список signed_contracts с фильтрами.

---

## 10. Open items для review

1. **Body шаблонов для seed** — PM сгенерирует draft 5 контрактов + ToS как стартовый placeholder в Phase 6A seed скрипте. ADMIN потом редактирует через UI (Phase 6C ready). Если USER хочет конкретный текст — приложить к task-файлу 6A.
2. **Точные имена payment-requisites колонок в `users`** — Coder резолвит через `mcp__postgres__query` в начале Phase 6A. Если структура `users` не покрывает USDT/ФОП/preferredMethod нужным образом — Coder создаёт `.blocked.md`.
3. **Язык интерфейса onboarding** — `CLAUDE.md` требует **русский** язык UI для всех текстов (кнопки, заголовки). Шаблоны контрактов могут быть на любом языке по выбору ADMIN'а (он сам пишет body), но UI wrapper (Step 1/2, кнопки «Подписать», «Принять») — на русском.

---

## 11. Связь с docs/agents/

- После merge каждого PR — PM append'ит lessons в `docs/agents/memory/pm/lessons.md` (per RULES §6).
- После всех 4 PR — `docs/agents/project-state.md` обновляется: Phase 6 → in progress / partial (5A-D done, SOW pending), новые таблицы добавляются в §5.1.
- `CLAUDE.md` — обновить текущий статус в финальной summary секции.

---

## 12. Approval status

- [x] Design approved by USER (2026-06-03 chat session)
- [ ] Spec doc reviewed by USER (this file)
- [ ] Implementation plan written (next step: `superpowers:writing-plans` skill)
- [ ] Phase 6A task file created
