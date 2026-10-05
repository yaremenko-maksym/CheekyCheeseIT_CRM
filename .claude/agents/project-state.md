# project-state — Facts inventory

Single source of truth for the **factual state of the project**: phases, migrations, RBAC, business rules, the shared schemas inventory, technical gotchas.

**Who should read:** all agents upfront at session start (~7 KB).
**Who updates:**

| Information              | Update owner | When                                   |
| ------------------------ | ------------ | -------------------------------------- |
| Phase status             | Master       | After each merge                       |
| Drizzle migrations       | Master       | After `db:generate`                    |
| RBAC matrix              | Master       | On a logic change                      |
| Canonical versions       | DevOps       | On an upgrade (then also — `RULES.md` §7) |
| Shared schemas inventory | Coder/Master | On adding a new module                 |
| Tech gotchas             | Coder        | On discovery                           |

---

## 1. Phases — current status

- [x] **PHASE 1**: Layout (Sidebar + Header, RBAC navigation)
- [x] **PHASE 2**: Team (Teams, team_members)
- [x] **PHASE 3**: Projects (Projects, project_members)
- [x] **PHASE 4**: Interviews (Interviews Kanban, dnd-kit)
- [x] **PHASE 5**: Finance (transactions, NBU rates, PDF, etherscan; the finance model refactored → payout_requests + pending_obligations)
- [x] **PHASE 6**: Documents (S3-compatible: dev RustFS / prod Cloudflare R2 — MinIO removed 2026-09-24, #709; the `documents` table, PDF inline preview, search/sort, receipt lifecycle)
- [x] **PHASE 7**: Profiles (`/profile`, `/users/:id`, telegram+phone, **photo S3** via `avatarDocumentId`) + Legend **per-project** (#150 + #164: `legends` with projectId UNIQUE + `legend_entries` journal; RBAC: the related ADMIN/HR/JUNIOR see/edit it, the subject is excluded)
- [x] **Contracts + Onboarding** (outside the original 9-phase plan): `contract_templates`, `employee_contracts`, `signed_contracts`, ToS (`tos_versions`/`tos_acceptances`), a template variables system, a two-column UA|EN PDF, `/onboarding`
- [x] **DROP role**: payment-routing (`dropSharePercent`, `payout_requests`, `pending_obligations`)
- [x] **PHASE 8**: **"Company account" (USDT ERC-20)** ✅ closed — a single wallet; incoming verification by a link to a tx (etherscan + a block progress bar, idempotent by `txHash`); ADMIN dividends; salary/expense/admin-income + drop-payout via the company account. **NOT on-chain** (smart contracts cancelled by the owner 2026-06-17). PR #249–#265 (+ #277 throttle). Details — §1.1
- [ ] **PHASE 9**: Dashboard — partly stale (per-role dashboards are already at the root `/` #223); redefine = a generic ADMIN/SENIOR dashboard (#231 MED-defer) + cross-role analytics. See ADR 2026-06-17 Part 3(c)
- **Current focus (snapshot 2026-06-22, may be stale — check against `git log` and the backlog; moved here from CLAUDE.md 2026-10-05):** a smooth design migration into **Claude Design** (design-gate Tier 1/2, screen by screen; the pilot — the HR dashboard). Cross-cutting UI, not a numbered phase. Then PHASE 9.

### 1.1. PHASE 8 — implemented ✅ (REDEFINED 2026-06-17; smart contracts cancelled)

> The full roadmap + safety-gates + open questions — ADR `docs/architecture/2026-06-17-planning-audit-roadmap.md` (Part 3b, Part 5).

- **NOT on-chain.** No Solidity / Hardhat / mainnet deploy / external audit / multisig. Risk M (not H).
- **Company account:** a single wallet (USDT ERC-20) to which SENIORs and DROPs transfer money.
- **Incoming confirmation:** the sender sends a **link to the transaction** → the backend verifies it via `etherscan.service.ts` (already exists). Confirmed (≥ the block threshold) → credit; pending → a **block-resolution progress bar** in the UI. Idempotent by `txHash`.
- **ADMIN dividends:** withdrawal from the company account as dividends (the business logic on the Finance page); 50/50 between ADMINs is preserved + a **shared company account** for salaries/expenses.
- **Safety:** no auto-credit without confirmed; RBAC (withdrawal only by ADMIN); a Legal pre-check (UA crypto/AML/taxes); integration guard tests (FM-5). The design — Mode A.

---

## 2. Tech stack — canonical decisions

- **Monorepo:** Turborepo + pnpm
- **Frontend:** React + **Vite SPA** (NOT TanStack Start/vinxi) + TanStack Router/Form/Query + Tailwind v4 + shadcn/ui + Framer Motion
- **Backend:** NestJS 11 + a Fastify adapter + Drizzle ORM (PostgreSQL) + Redis
- **Validation:** Zod v4 (strict). All API requests/responses via `.parse()`. DTO in NestJS via Zod, NOT class-validator.
- **Testing:** Vitest (unit), Playwright (E2E)
- **Routing:** TanStack Router file-based (`apps/web/app/routes/**`)
- **Styling:** Tailwind v4 + shadcn/ui. No hardcoded colors (`text-[#...]`)
- **Animations:** Framer Motion, 200-300ms, only appropriate ones

Versions — see `RULES.md` §7.

---

## 3. RBAC — the role matrix

5 roles: `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT`. Each NestJS endpoint must check the role via `@UseGuards(JwtGuard)` + `RolesGuard`.

| Role           | What it can do                                                                          |
| -------------- | --------------------------------------------------------------------------------------- |
| **ADMIN**      | Everything. Sees all data of all users. Excluded from all teams (an RBAC quirk)         |
| **SENIOR**     | Their projects, their interview board, their transactions                               |
| **JUNIOR**     | Projects where they are an active member (project_members with leftAt=NULL)             |
| **HR**         | Their teams, the projects of their seniors, the interview boards of their seniors       |
| **ACCOUNTANT** | The finance of all seniors, validation of transactions. Automatically added to every team |

### 3.1. Sidebar navigation (RBAC visibility)

| Item       | ADMIN | SENIOR | JUNIOR | HR  | ACCOUNTANT |
| ---------- | ----- | ------ | ------ | --- | ---------- |
| Dashboard  | ✓     | ✓      | ✓      | ✓   | ✓          |
| Profile    | ✓     | ✓      | ✓      | ✓   | ✓          |
| Team       | ✓     | ✓      | ✓      | ✓   | ✓          |
| Projects   | ✓     | ✓      | ✓      | ✓   | ✓          |
| Finance    | ✓     | ✓      | ✓      | ✓   | ✓          |
| Interviews | ✓     | ✓      | —      | ✓   | —          |
| Documents  | ✓     | ✓      | ✓      | ✓   | ✓          |

---

## 4. Business rules (key constraints)

### 4.1. Teams

- Max 10 teams per company.
- ACCOUNTANT is added automatically to every team (one per company).
- ADMIN is excluded from all teams.
- A JUNIOR in a team — is **derived** from `project_members` (NOT stored in `team_members`). `TeamsService.mapTeam()` pulls JUNIORs from `project_members` WHERE `leftAt IS NULL` AND `project.seniorId = team's senior`.
- Protection: you cannot delete a SENIOR (only delete the team), you cannot delete the last HR / ACCOUNTANT.

### 4.2. Projects

- One JUNIOR maximum per active project.
- `project_members.leftAt` — a soft delete: `NULL` = active, `timestamp` = left.
- Only a JUNIOR can be added as a `project_member` (`addMember` checks the role).
- Closing a project: PATCH /api/projects/:id with `{ status: 'CLOSED', endDate: now }` — does not delete, archives.
- `seniorId` — an FK to `users.id`, directly in the `projects` table (not via `project_members`).

### 4.3. Interviews

- Each board is personal to a senior. `?seniorId=<uuid>` in the URL via TanStack Router `validateSearch`.
- HR sees the boards of their seniors; ADMIN — all.
- DnD via dnd-kit with `closestCenter` (mandatory for a cross-column drag).
- `position` — an integer, renormalized on each move.
- Stages: `HR_SCREEN | ENGLISH_CHECK | TECH_INTERVIEW | FINAL_INTERVIEW | OFFER_RECEIVED | HIRED | REJECTED | ARCHIVED`.

### 4.4. Finance

- Workflow: SENIOR receives a salary → enters a transaction → ACCOUNTANT validates → SENIOR pays 74% to the smart contract → JUNIOR receives a fixed amount → the remainder 50/50 ADMIN + partner.
- Transaction statuses: `PENDING → VALIDATED → PENDING_PAYMENT → PAID | REJECTED`.
- Invoice statuses: `DRAFT → SIGNED | CANCELLED`.
- Payout statuses: `PENDING_PAYMENT → PAID | CANCELLED`.
- The payout currency via the smart contract: only USDT ERC-20 (Ethereum mainnet).
- Rates: NBU (`nbu-currency.service.ts`).
- Etherscan integration: `etherscan.service.ts` — verification of crypto transactions.
- PDF invoices: `pdf-invoice.service.ts`.

### 4.5. Documents / Profile

- Files (documents, photos) — AWS S3 with compression:
  - `sharp` for images
  - `pdf-lib` for PDF
- A USDT wallet is mandatory for JUNIOR/SENIOR (used by the smart contract).
- Changing the wallet — with a confirmation (security).

---

## 5. Drizzle migrations (0000–0009 applied)

> ⚠ **Fact (2026-06-11):** the baseline is **squashed** → `0000_purple_runaways` (all core tables) + `0001_employee_contracts`, `0002`–`0003` (contracts/onboarding), `0004_contract_templates_remove_version`, `0005`, `0006_employee_contracts_custom_values`, `0007_cleanup_orphan_senior_payout_requests`, `0008_quick_mac_gargan`, `0009_legends_per_project`. The table below — is **pre-squash historical** (the names/numbering do NOT correspond to the files in `apps/api/drizzle/migrations/`; the `schema.ts` comments about "migration 0007–0013" — are also historical).

| Migration                    | What                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_lethal_dark_beast.sql` | `users` + the role enum (`ADMIN/SENIOR/JUNIOR/HR/ACCOUNTANT`)                                                                                                               |
| `0001_*`                     | `teams` + `team_members`                                                                                                                                                    |
| `0002_*`                     | `projects` + `project_members` + enums (currency, project_status)                                                                                                          |
| `0003_*`                     | `interviews` + the `interview_stage` enum                                                                                                                                  |
| `0004–0011`                  | Finance: `transactions`, `expenses`, `junior_payments`, `invoices`, `invoice_transactions`, `payouts`, `payout_transactions`, the partner enum, `exchange_rate`, `project_logo` |

**Apply:** `pnpm --filter @crm/api drizzle-kit migrate`
**Seed:** `pnpm --filter @crm/api db:seed`
**Create a new one:** `pnpm --filter @crm/api db:generate`

### 5.1. Active DB tables (23)

`users` · `teams` · `team_members` · `projects` · `project_finance_settings` · `project_members` · `interviews` · `payout_requests` · `transactions` · `pending_obligations` · `documents` · `invoice_signatures` · `contract_templates` · `signed_contracts` · `tos_versions` · `tos_acceptances` · `employee_contracts` · `notifications` · `user_audit_log` · `team_audit_log` · `project_audit_log` · `legends` · `legend_entries`

> **The finance model is refactored:** the old `expenses`/`junior_payments`/`invoices`/`invoice_transactions`/`payouts`/`payout_transactions` → consolidated into `transactions` (+`seniorSharePercent`/source) + `payout_requests` + `pending_obligations`.

---

## 6. Shared schemas inventory (`packages/shared/src/schemas/`)

The Single Source of Truth for all types. Frontend and backend import from `@crm/shared`.

> ⚠ **Fact (2026-06-09):** the table below is incomplete. The real files: `auth`, `users`, `payment-requisites`, `teams`, `projects`, `interviews`, `finance`, `invoices`, `documents`, `contracts`, `employee-contracts`, `tos`, `onboarding`, `notifications`, `admin-actions`, `audit-log`, `view-permissions` (`api.ts` removed).

| File            | Main exports                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.ts`       | `SessionUser`, `googleCallbackSchema`                                                                                                                                                                                                                                                                                                                   |
| `users.ts`      | `userSchema`, related types                                                                                                                                                                                                                                                                                                                             |
| `teams.ts`      | `teamMemberSchema`, `teamSchema`, `createTeamSchema`, `updateTeamSchema`, `addTeamMemberSchema`                                                                                                                                                                                                                                                         |
| `projects.ts`   | `projectMemberSchema`, `projectSchema`, `createProjectSchema`, `updateProjectSchema`, `addProjectMemberSchema`                                                                                                                                                                                                                                          |
| `interviews.ts` | `interviewStageSchema`, `interviewSchema`, `createInterviewSchema`, `updateInterviewSchema`, `moveInterviewSchema`                                                                                                                                                                                                                                      |
| `finance.ts`    | `transactionSchema`, `createTransactionSchema`, `validateTransactionSchema`, `submitPaymentSchema`, `expenseSchema`, `createExpenseSchema`, `invoiceSchema`, `createInvoiceSchema`, `signInvoiceSchema`, `payoutSchema`, `createPayoutSchema`, `submitPayoutSchema`, `juniorPaymentSchema`, `partnerBalanceSchema`, `financeSummarySchema`, `nbuRateSchema` |
| `api.ts`        | Common API types                                                                                                                                                                                                                                                                                                                                       |

Export a new schema from `packages/shared/src/schemas/index.ts`.

---

## 7. Auth

- **Google OAuth ONLY**, manual (without Passport — fewer dependencies, no conflicts with Fastify).
- JWT in an HttpOnly cookie, 7 days, signed `@nestjs/jwt`, payload = `SessionUser`.
- Endpoints:
  - `GET /api/auth/google` — a redirect to Google
  - `GET /api/auth/google/callback` — an email check in the DB → a JWT cookie → a redirect to `/crm`
  - `GET /api/auth/me` — the current user
  - `GET /api/auth/logout`
- State CSRF: a random state in a signed cookie `oauth_state`, TTL 600 sec.
- Strict check: if the email is not in the `users` table → 403 → `/login?error=unauthorized`.

### 7.1. Dev Login (User Testing only)

`POST /api/auth/dev-login {email}` — for scripted login without OAuth. Enabled in the production build when `VITE_DEV_LOGIN=true` (passed by `scripts/pm/prep-user-testing.sh`). OAuth via a tunnel does NOT work — this is a compensation.

---

## 8. Design system components (`apps/web/app/components/ui/`)

`button` · `input` · `label` · `card` · `badge` (with role variants) · `separator` · `skeleton` · `avatar` · `sonner` · `scroll-area` · `tooltip` · `dropdown-menu` · `dialog` · `sheet`

Use as the base, do not replace with your own implementations.

---

## 9. Tech gotchas — known issues

- **`routeTree.gen.ts`** — generated by `@tanstack/router-plugin` (a Vite plugin) on `vite dev` / `pnpm dev`. Do not edit manually.
- **Vite SPA**: `app/client.tsx` — the entry point (`createRoot` + `RouterProvider`). `index.html` in the root of `apps/web/`. This is **NOT** TanStack Start/vinxi — SSR is not needed.
- **Fastify**: forced via `pnpm.overrides` to `^5.8.5` (a conflict with `@fastify/helmet`).
- **`pnpm.overrides`**: do NOT add for `@tanstack/router-*` — it breaks the build.
- **TanStack Router + Plugin**: a peer-matched pair, EXACT-pinned — react-router `1.170.15` + plugin `1.168.18` (the numbers do NOT match; do not bump separately and do not switch to caret) — see `rules/common/version-pins.md`.
- **Tailwind v4 dark mode**: `@custom-variant dark (&:is(.dark *))` + `class="dark"` on `<html>`.
- **shadcn/ui tokens**: `@theme inline {}` maps CSS vars → Tailwind utilities. `:root` = light, `.dark` = dark.
- **`exactOptionalPropertyTypes`**: Radix CheckboxItem `checked` — pass via `...props`, do NOT destructure.
- **tw-animate-css**: a CSS package for Tailwind v4 animations (`@import "tw-animate-css"` in `globals.css`).
- **`@crm/shared` + the API tsconfig**: `"main"` and `"types"` in `packages/shared/package.json` for compatibility with `moduleResolution: "Node"`. The API tsconfig uses `"ignoreDeprecations": "5.0"`.
- **Interviews dnd-kit**: `closestCenter` collision detection — mandatory for a cross-column drag. Each column has `useDroppable({ id: stage })` — for a drop into an empty column.

---

## 10. Seed data (for tests)

Test users (`apps/api/src/database/seed.ts`): `admin`, `senior1`, `senior2`, `junior1`, `hr`, `accountant` — all `@cheekyit.com`. Google OAuth is unavailable in CI — the tests go via Playwright fixtures (`asAdmin`, `asSenior`, `asHR`, etc.).

`pnpm --filter @crm/api db:seed` — to populate.

---

## 11. CI/CD pipeline (current)

**Active workflows** in `.github/workflows/`:

| Workflow                  | Trigger                              | What it does                                      |
| ------------------------- | ------------------------------------ | ------------------------------------------------- |
| `ci.yml`                  | `push` / `pull_request`              | typecheck + lint + unit tests + label `ci-failed` |
| `e2e.yml`                 | `push` to main / `workflow_dispatch` | Playwright E2E                                    |
| `auto-merge-on-label.yml` | `pull_request` labeled               | Auto-squash-merge on the label `merge-approved`   |
| `e2e-watchdog.yml`        | scheduled / events                   | E2E control                                       |
| `labels-sync.yml`         | scheduled                            | Sync labels                                       |

Master dispatches Coder/Reviewer/AutoTest/DevOps **locally** via `Agent(isolation="worktree")`. Any mentions of "PM runs `gh workflow run coder.yml`" in old docs — are stale.

---

## 12. Where this info used to live

This information was previously scattered across:

- `CLAUDE.md` (root) — phases, migrations, business rules, design system, RBAC sidebar
- `CLAUDE-coder.md` — the monorepo structure, status, migrations, gotchas, business logic
- `CLAUDE-pm.md` — the phase status
- `CLAUDE-reviewer.md` — version pins, DB tables, shared schemas
- `CLAUDE-ba.md` — the business model, key constraints, the phase status
- `CLAUDE-devops.md` — versions, secrets, the pipeline
- `CLAUDE-autotest.md` — seed users

All these stub files are **removed** (CLAUDE-ba — Phase 6 2026-06-03; the other 6 — wisdom-transfer
cleanup 2026-06-16). The information is now updated here and here only — the stubs are not needed.
