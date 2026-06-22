# project-state — Facts inventory

Single source of truth для **factual state of the project**: фазы, миграции, RBAC, бизнес-правила, инвентарь shared schemas, технические gotchas.

**Кому читать:** всем агентам upfront при старте сессии (~7 KB).
**Кто обновляет:**

| Информация               | Update owner | Когда                                  |
| ------------------------ | ------------ | -------------------------------------- |
| Phase status             | PM/BA        | После каждого merge                    |
| Drizzle migrations       | PM/BA        | После `db:generate`                    |
| RBAC матрица             | BA           | При изменении логики                   |
| Канонические версии      | DevOps       | При upgrade (тогда же — `RULES.md` §7) |
| Shared schemas inventory | Coder/BA     | При добавлении нового модуля           |
| Tech gotchas             | Coder        | При discovery                          |

---

## 1. Phases — текущий статус

- [x] **PHASE 1**: Layout (Sidebar + Header, RBAC навигация)
- [x] **PHASE 2**: Команда (Teams, team_members)
- [x] **PHASE 3**: Проекты (Projects, project_members)
- [x] **PHASE 4**: Собеседования (Interviews Kanban, dnd-kit)
- [x] **PHASE 5**: Финансы (transactions, NBU rates, PDF, etherscan; финмодель рефакторена → payout_requests + pending_obligations)
- [x] **PHASE 6**: Документы (S3/MinIO, `documents` table, PDF inline preview, search/sort, receipt lifecycle)
- [x] **PHASE 7**: Профили (`/crm/profile`, `/crm/users/:id`, telegram+phone, **фото S3** через `avatarDocumentId`) + Легенда **per-project** (#150 + #164: `legends` с projectId UNIQUE + `legend_entries` журнал; RBAC: видят/редактируют связанные ADMIN/HR/JUNIOR, субъект исключён)
- [x] **Контракты + Онбординг** (вне исходного 9-фазного плана): `contract_templates`, `employee_contracts`, `signed_contracts`, ToS (`tos_versions`/`tos_acceptances`), система переменных шаблонов, двухколоночный UA|EN PDF, `/crm/onboarding`
- [x] **DROP роль**: payment-routing (`dropSharePercent`, `payout_requests`, `pending_obligations`)
- [x] **PHASE 8**: **«Счёт компании» (USDT ERC-20)** ✅ closed — единый кошелёк; верификация прихода по ссылке на tx (etherscan + прогресс-бар блоков, idempotent по `txHash`); ADMIN-дивиденды; salary/expense/admin-income + drop-payout через счёт компании. **НЕ on-chain** (смарт-контракты отменены владельцем 2026-06-17). PR #249–#265 (+ #277 throttle). Детали — §1.1
- [ ] **PHASE 9**: Дашборд — частично устарел (per-role дашборды уже в корне `/` #223); переопределить = generic ADMIN/SENIOR дашборд (#231 MED-defer) + cross-role аналитика. См. ADR 2026-06-17 Part 3(c)
- **Текущий фокус (2026-06-22):** плавная миграция дизайна в **Claude Design** (design-gate Tier 1/2, экран за экраном; пилот — HR-дашборд). Cross-cutting UI, не нумерованная фаза. Затем PHASE 9.

### 1.1. PHASE 8 — реализовано ✅ (ПЕРЕОПРЕДЕЛЕНО 2026-06-17; смарт-контракты отменены)

> Полный роадмап + safety-gates + open-вопросы — ADR `docs/architecture/2026-06-17-planning-audit-roadmap.md` (Part 3b, Part 5).

- **НЕ on-chain.** Нет Solidity / Hardhat / mainnet-деплоя / внешнего аудита / multisig. Риск M (не H).
- **Счёт компании:** единый кошелёк (USDT ERC-20), куда SENIOR'ы и DROP'ы перечисляют деньги.
- **Подтверждение прихода:** отправитель присылает **ссылку на транзакцию** → бэк верифицирует через `etherscan.service.ts` (уже есть). Confirmed (≥ порог блоков) → credit; pending → **прогресс-бар резолва блоков** в UI. Idempotent по `txHash`.
- **ADMIN-дивиденды:** вывод со счёта компании как дивиденды (бизнес-логика на странице Финансы); 50/50 между ADMIN'ами сохраняется + **общий счёт компании** на зарплаты/расходы.
- **Safety:** никакого авто-credit без confirmed; RBAC (вывод только ADMIN); Legal pre-check (UA crypto/AML/налоги); integration guard-тесты (FM-5). Дизайн — Mode A.

---

## 2. Tech stack — канонические решения

- **Monorepo:** Turborepo + pnpm
- **Frontend:** React + **Vite SPA** (НЕ TanStack Start/vinxi) + TanStack Router/Form/Query + Tailwind v4 + shadcn/ui + Framer Motion
- **Backend:** NestJS 11 + Fastify adapter + Drizzle ORM (PostgreSQL) + Redis
- **Validation:** Zod v4 (строго). Все API запросы/ответы через `.parse()`. DTO в NestJS через Zod, НЕ class-validator.
- **Testing:** Vitest (unit), Playwright (E2E)
- **Routing:** TanStack Router file-based (`apps/web/app/routes/**`)
- **Styling:** Tailwind v4 + shadcn/ui. НЕ hardcoded цвета (`text-[#...]`)
- **Animations:** Framer Motion, 200-300ms, только уместные

Версии — см. `RULES.md` §7.

---

## 3. RBAC — матрица ролей

5 ролей: `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT`. Каждый NestJS endpoint обязан проверять роль через `@UseGuards(JwtGuard)` + `RolesGuard`.

| Роль           | Что может                                                                               |
| -------------- | --------------------------------------------------------------------------------------- |
| **ADMIN**      | Всё. Видит все данные всех пользователей. Исключён из всех команд (RBAC квирк)          |
| **SENIOR**     | Свои проекты, своя доска интервью, свои транзакции                                      |
| **JUNIOR**     | Проекты где активный member (project_members с leftAt=NULL)                             |
| **HR**         | Свои команды, проекты своих синьоров, доски интервью своих синьоров                     |
| **ACCOUNTANT** | Финансы всех синьоров, валидация транзакций. Автоматически добавляется в каждую команду |

### 3.1. Sidebar navigation (RBAC видимость)

| Пункт      | ADMIN | SENIOR | JUNIOR | HR  | ACCOUNTANT |
| ---------- | ----- | ------ | ------ | --- | ---------- |
| Дашборд    | ✓     | ✓      | ✓      | ✓   | ✓          |
| Профіль    | ✓     | ✓      | ✓      | ✓   | ✓          |
| Команда    | ✓     | ✓      | ✓      | ✓   | ✓          |
| Проекти    | ✓     | ✓      | ✓      | ✓   | ✓          |
| Фінанси    | ✓     | ✓      | ✓      | ✓   | ✓          |
| Співбесіди | ✓     | ✓      | —      | ✓   | —          |
| Документи  | ✓     | ✓      | ✓      | ✓   | ✓          |

---

## 4. Бизнес-правила (key constraints)

### 4.1. Teams

- Макс 10 команд на компанию.
- ACCOUNTANT добавляется автоматически в каждую команду (один на компанию).
- ADMIN исключён из всех команд.
- JUNIOR в команде — **производное** от `project_members` (НЕ хранится в `team_members`). `TeamsService.mapTeam()` подтягивает JUNIORов из `project_members` WHERE `leftAt IS NULL` AND `project.seniorId = team's senior`.
- Защита: нельзя удалить SENIOR (только удалить команду), нельзя удалить последнего HR / ACCOUNTANT.

### 4.2. Projects

- Один JUNIOR максимум на активный проект.
- `project_members.leftAt` — soft delete: `NULL` = активный, `timestamp` = ушёл.
- Только JUNIOR можно добавить как `project_member` (`addMember` проверяет роль).
- Закрытие проекта: PATCH /api/projects/:id со `{ status: 'CLOSED', endDate: now }` — не удаляет, архивирует.
- `seniorId` — FK на `users.id`, прямо в таблице `projects` (не через `project_members`).

### 4.3. Interviews

- Каждая доска персональна для синьора. `?seniorId=<uuid>` в URL через TanStack Router `validateSearch`.
- HR видит доски своих синьоров; ADMIN — все.
- DnD через dnd-kit с `closestCenter` (обязательно для cross-column drag).
- `position` — integer, ренормализуется при каждом move.
- Stages: `HR_SCREEN | ENGLISH_CHECK | TECH_INTERVIEW | FINAL_INTERVIEW | OFFER_RECEIVED | HIRED | REJECTED | ARCHIVED`.

### 4.4. Finance

- Workflow: SENIOR получает зарплату → вносит транзакцию → ACCOUNTANT валидирует → SENIOR платит 74% на смарт-контракт → JUNIOR получает фиксированную сумму → остаток 50/50 ADMIN + партнёр.
- Transaction статусы: `PENDING → VALIDATED → PENDING_PAYMENT → PAID | REJECTED`.
- Invoice статусы: `DRAFT → SIGNED | CANCELLED`.
- Payout статусы: `PENDING_PAYMENT → PAID | CANCELLED`.
- Валюта выплат через смарт-контракт: только USDT ERC-20 (Ethereum mainnet).
- Курсы: НБУ (`nbu-currency.service.ts`).
- Etherscan integration: `etherscan.service.ts` — верификация крипто-транзакций.
- PDF инвойсы: `pdf-invoice.service.ts`.

### 4.5. Documents / Profile

- Файлы (документы, фото) — AWS S3 со сжатием:
  - `sharp` для изображений
  - `pdf-lib` для PDF
- USDT кошелёк обязателен для JUNIOR/SENIOR (используется смарт-контрактом).
- Смена кошелька — с подтверждением (security).

---

## 5. Drizzle миграции (0000–0009 применены)

> ⚠ **Факт (2026-06-11):** baseline **squashed** → `0000_purple_runaways` (все core-таблицы) + `0001_employee_contracts`, `0002`–`0003` (контракты/онбординг), `0004_contract_templates_remove_version`, `0005`, `0006_employee_contracts_custom_values`, `0007_cleanup_orphan_senior_payout_requests`, `0008_quick_mac_gargan`, `0009_legends_per_project`. Таблица ниже — **pre-squash историческая** (имена/нумерация НЕ соответствуют файлам в `apps/api/drizzle/migrations/`; комментарии `schema.ts` про «migration 0007–0013» — тоже исторические).

| Migration                    | Что                                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_lethal_dark_beast.sql` | `users` + role enum (`ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT`)                                                                                                                   |
| `0001_*`                     | `teams` + `team_members`                                                                                                                                                    |
| `0002_*`                     | `projects` + `project_members` + enums (currency, project_status)                                                                                                           |
| `0003_*`                     | `interviews` + `interview_stage` enum                                                                                                                                       |
| `0004–0011`                  | Finance: `transactions`, `expenses`, `junior_payments`, `invoices`, `invoice_transactions`, `payouts`, `payout_transactions`, partner enum, `exchange_rate`, `project_logo` |

**Применить:** `pnpm --filter @crm/api drizzle-kit migrate`
**Seed:** `pnpm --filter @crm/api db:seed`
**Создать новую:** `pnpm --filter @crm/api db:generate`

### 5.1. Активные DB таблицы (23)

`users` · `teams` · `team_members` · `projects` · `project_finance_settings` · `project_members` · `interviews` · `payout_requests` · `transactions` · `pending_obligations` · `documents` · `invoice_signatures` · `contract_templates` · `signed_contracts` · `tos_versions` · `tos_acceptances` · `employee_contracts` · `notifications` · `user_audit_log` · `team_audit_log` · `project_audit_log` · `legends` · `legend_entries`

> **Финмодель рефакторена:** старые `expenses`/`junior_payments`/`invoices`/`invoice_transactions`/`payouts`/`payout_transactions` → консолидированы в `transactions` (+`seniorSharePercent`/source) + `payout_requests` + `pending_obligations`.

---

## 6. Shared schemas inventory (`packages/shared/src/schemas/`)

Single Source of Truth для всех типов. Frontend и backend импортируют из `@crm/shared`.

> ⚠ **Факт (2026-06-09):** таблица ниже неполная. Реальные файлы: `auth`, `users`, `payment-requisites`, `teams`, `projects`, `interviews`, `finance`, `invoices`, `documents`, `contracts`, `employee-contracts`, `tos`, `onboarding`, `notifications`, `admin-actions`, `audit-log`, `view-permissions` (`api.ts` удалён).

| Файл            | Главные экспорты                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.ts`       | `SessionUser`, `googleCallbackSchema`                                                                                                                                                                                                                                                                                                                       |
| `users.ts`      | `userSchema`, связанные типы                                                                                                                                                                                                                                                                                                                                |
| `teams.ts`      | `teamMemberSchema`, `teamSchema`, `createTeamSchema`, `updateTeamSchema`, `addTeamMemberSchema`                                                                                                                                                                                                                                                             |
| `projects.ts`   | `projectMemberSchema`, `projectSchema`, `createProjectSchema`, `updateProjectSchema`, `addProjectMemberSchema`                                                                                                                                                                                                                                              |
| `interviews.ts` | `interviewStageSchema`, `interviewSchema`, `createInterviewSchema`, `updateInterviewSchema`, `moveInterviewSchema`                                                                                                                                                                                                                                          |
| `finance.ts`    | `transactionSchema`, `createTransactionSchema`, `validateTransactionSchema`, `submitPaymentSchema`, `expenseSchema`, `createExpenseSchema`, `invoiceSchema`, `createInvoiceSchema`, `signInvoiceSchema`, `payoutSchema`, `createPayoutSchema`, `submitPayoutSchema`, `juniorPaymentSchema`, `partnerBalanceSchema`, `financeSummarySchema`, `nbuRateSchema` |
| `api.ts`        | Общие API типы                                                                                                                                                                                                                                                                                                                                              |

Экспортировать новый schema из `packages/shared/src/schemas/index.ts`.

---

## 7. Auth

- **Google OAuth ONLY**, ручной (без Passport — меньше зависимостей, нет конфликтов с Fastify).
- JWT в HttpOnly cookie, 7 дней, signed `@nestjs/jwt`, payload = `SessionUser`.
- Endpoints:
  - `GET /api/auth/google` — redirect в Google
  - `GET /api/auth/google/callback` — проверка email в БД → JWT cookie → redirect на `/crm`
  - `GET /api/auth/me` — текущий пользователь
  - `GET /api/auth/logout`
- State CSRF: случайный state в signed cookie `oauth_state`, TTL 600 сек.
- Строгая проверка: если email не в таблице `users` → 403 → `/login?error=unauthorized`.

### 7.1. Dev Login (User Testing only)

`POST /api/auth/dev-login {email}` — для скриптового логина без OAuth. Включён в production build при `VITE_DEV_LOGIN=true` (передаётся `scripts/pm/prep-user-testing.sh`). OAuth через tunnel НЕ работает — это compensation.

---

## 8. Design system компоненты (`apps/web/app/components/ui/`)

`button` · `input` · `label` · `card` · `badge` (с role variants) · `separator` · `skeleton` · `avatar` · `sonner` · `scroll-area` · `tooltip` · `dropdown-menu` · `dialog` · `sheet`

Использовать как базу, не заменять своими реализациями.

---

## 9. Tech gotchas — known issues

- **`routeTree.gen.ts`** — генерируется `@tanstack/router-plugin` (Vite plugin) при `vite dev` / `pnpm dev`. Не редактировать вручную.
- **Vite SPA**: `app/client.tsx` — точка входа (`createRoot` + `RouterProvider`). `index.html` в корне `apps/web/`. Это **НЕ** TanStack Start/vinxi — SSR не нужен.
- **Fastify**: принудительно через `pnpm.overrides` на `^5.8.5` (конфликт с `@fastify/helmet`).
- **`pnpm.overrides`**: НЕ добавлять для `@tanstack/router-*` — сломает сборку.
- **TanStack Router + Plugin**: peer-matched пара, EXACT-pinned — react-router `1.170.15` + plugin `1.168.18` (номера НЕ совпадают; не бампить раздельно и не переводить в caret) — см. `rules/common/version-pins.md`.
- **Tailwind v4 dark mode**: `@custom-variant dark (&:is(.dark *))` + `class="dark"` на `<html>`.
- **shadcn/ui tokens**: `@theme inline {}` маппит CSS vars → Tailwind utilities. `:root` = light, `.dark` = dark.
- **`exactOptionalPropertyTypes`**: Radix CheckboxItem `checked` — передавать через `...props`, НЕ деструктурировать.
- **tw-animate-css**: CSS-пакет для анимаций Tailwind v4 (`@import "tw-animate-css"` в `globals.css`).
- **`@crm/shared` + API tsconfig**: `"main"` и `"types"` в `packages/shared/package.json` для совместимости с `moduleResolution: "Node"`. API tsconfig использует `"ignoreDeprecations": "5.0"`.
- **Interviews dnd-kit**: `closestCenter` collision detection — обязательно для cross-column drag. Каждый column имеет `useDroppable({ id: stage })` — для дропа в пустую колонку.

---

## 10. Seed данные (для тестов)

Тестовые пользователи (`apps/api/src/database/seed.ts`): `admin`, `senior1`, `senior2`, `junior1`, `hr`, `accountant` — все `@cheekyit.com`. Google OAuth в CI недоступен — тесты через Playwright fixtures (`asAdmin`, `asSenior`, `asHR`, etc.).

`pnpm --filter @crm/api db:seed` — наполнить.

---

## 11. CI/CD pipeline (актуальный)

**Активные workflows** в `.github/workflows/`:

| Workflow                  | Trigger                              | Что делает                                        |
| ------------------------- | ------------------------------------ | ------------------------------------------------- |
| `ci.yml`                  | `push` / `pull_request`              | typecheck + lint + unit tests + label `ci-failed` |
| `e2e.yml`                 | `push` to main / `workflow_dispatch` | Playwright E2E                                    |
| `auto-merge-on-label.yml` | `pull_request` labeled               | Auto-squash-merge при label `merge-approved`      |
| `e2e-watchdog.yml`        | scheduled / events                   | Контроль E2E                                      |
| `labels-sync.yml`         | scheduled                            | Sync labels                                       |

**Архивные** (не запускаются — agents запускаются локально через `Agent` tool):

- `.github/workflows/archive/coder.yml`
- `.github/workflows/archive/autotest.yml`
- `.github/workflows/archive/devops.yml`
- `.github/workflows/archive/ai-review.yml`

PM диспетчит Coder/Reviewer/AutoTest/DevOps **локально** через `Agent(isolation="worktree")`. Любые упоминания «PM запускает `gh workflow run coder.yml`» в старых docs — устарело.

---

## 12. Where this info used to live

Эта информация ранее была разбросана по:

- `CLAUDE.md` (корневой) — фазы, миграции, бизнес-правила, design system, RBAC sidebar
- `CLAUDE-coder.md` — структура монорепо, статус, миграции, gotchas, бизнес-логика
- `CLAUDE-pm.md` — статус фаз
- `CLAUDE-reviewer.md` — version pins, DB таблицы, shared schemas
- `CLAUDE-ba.md` — бизнес-модель, ключевые ограничения, статус фаз
- `CLAUDE-devops.md` — версии, секреты, pipeline
- `CLAUDE-autotest.md` — seed users

Все эти файлы-стабы **удалены** (CLAUDE-ba — Phase 6 2026-06-03; остальные 6 — wisdom-transfer
cleanup 2026-06-16). Информация теперь обновляется здесь и здесь только — стабы не нужны.
