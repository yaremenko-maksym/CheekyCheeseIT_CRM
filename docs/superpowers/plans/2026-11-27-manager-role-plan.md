# MANAGER role, partner accounts and ACCOUNTANT removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `MANAGER` role (scoped, default-deny), the manager share of net profit with per-row snapshots, the
profit and cash layers, partner accounts, the 2026-12-01 migration of the former admin partner, CODEOWNERS and the VPS
runbook — after removing the `ACCOUNTANT` role.

**Architecture:** Approach A of the design: snapshot `managerId` / `managerSharePercent` / source on every
profit-layer and manager-related cash row at write time; derive `earned`, `in hand` and the balance on read. Period is a
stored immutable `periodMonth`. RBAC is two audited gates: controller `@Roles` and an explicit MANAGER branch (or deny)
in every service role chain.

**Tech Stack:** NestJS 11 + Fastify + Drizzle (PostgreSQL), Zod v4 in `@crm/shared`, React + Vite + TanStack, Lingui
(`uk` + `en`), Vitest, Playwright. Prod DDL/data through `apps/api/drizzle/manual/*.sql` wired in
`.github/workflows/deploy.yml`.

**Spec:** `docs/superpowers/specs/2026-11-27-manager-role-design.md` (r7). §11 author's calls and §12 owner answers are
approved and are not re-opened here.

**RBAC checklist (§5):** `docs/superpowers/plans/2026-11-27-manager-role-rbac-audit.md` — the tracked inventory of every
ADMIN comparison, `@Roles`, guard-less handler, role branch and DB role predicate, each with a proposed class.

## Global Constraints

- Effective date of the business change: **2026-12-01**; cutoff periods: legacy = `periodMonth ≤ '2026-11'`, new model
  = `periodMonth ≥ '2026-12'`. Time zone for `periodMonth`: `Europe/Kyiv`, format `YYYY-MM`.
- MANAGER is **default-deny**: every endpoint or service branch not explicitly granted in design §5 refuses MANAGER.
- One manager per project: `projects.managerId` is the only project scope; `teams.managerId` only seeds a new project.
- Money visibility and money write checks use the **row snapshot** (`managerId` on the row), never the project's
  current manager.
- A manager's create-user roles: `SENIOR | JUNIOR | HR | DROP`. Never `ADMIN`, `MANAGER`.
- Manager share, `projects.managerId`, `teams.managerId` changes: ADMIN only (HR / manager may set `teams.managerId`
  once at creation, §5 table).
- Product strings `uk` + `en` through Lingui; no new dependencies; version pins unchanged
  (`.claude/rules/common/version-pins.md`).
- `role` enum gains values only through `ALTER TYPE … ADD VALUE` in its **own** manual SQL file: the deploy applies
  each file with `--single-transaction`, and a value added in a transaction cannot be used before that commit.
- Prod DDL and data steps: manual SQL + `deploy.yml`, fail-loud (`ON_ERROR_STOP=1`), idempotent, with ORDER /
  IDEMPOTENT / ROLLBACK headers like the existing files. Owner-run row-level SQL lives in
  `apps/api/drizzle/manual-private/` (never wired into CI: the repo and its Action logs are public).
- Never write to the live `crm_db`; integration specs and E2E run on a scratch DB with `DATABASE_URL` set inline. Push
  as `DATABASE_URL= git push`.
- Every finance / RBAC / auth / DB PR: code-reviewer **and** security-reviewer; owner review before merge.
- Every final commit carries `ac_verified:`; files staged by name; no `--no-verify`, no `gh pr merge --admin`.
- Long-lived records (PR bodies, backlog) name symbols, not line numbers (`doc-durability.md`).

## Review Focus

Inputs the spec implies that are easy to leave untested; each line has its test in the owning PR.

1. **Income types the design does not name.** `TOV_INCOME`, `SENIOR_INCOME_CRYPTO`, `SENIOR_PAID`,
   `ADMIN_INCOME_CASH`, `ADMIN_INCOME_CRYPTO` exist in `transactionTypeEnum`. Each is classified profit / cash / never
   by a table-driven unit test that fails on an unclassified enum value (PR 5c).
2. **A new `transaction_type` or `role` value added later** silently falls into "everyone else" or "not counted". The
   same exhaustive tests (PR 2 for roles, PR 5c / PR 7b for types) fail on an unknown value.
3. **Soft-deleted or rejected rows after a payout.** A rejected income whose IOU was already paid must leave the
   profit layer and keep its cash effect (PR 5c, PR 7b).
4. **A MANAGER calling an endpoint that has no `@Roles`.** 117 handlers have no `@Roles`; the guard is a no-op there.
   One integration test per such handler that reads or writes money or people proves MANAGER is scoped or refused
   (PR 2).
5. **A row edited across the cutoff or to another project** re-snapshots and audits old and new (PR 5a); a row edited
   in any other field keeps its snapshot.

## Spec → PR map

| Spec                                                                             | PR    |
| -------------------------------------------------------------------------------- | ----- |
| §13.1–13.2 fact-finding SQL, owner decision, fail-loud data step                 | PR 1a |
| §13.3 ACCOUNTANT code (API)                                                      | PR 1b |
| §13.3 ACCOUNTANT code (web, i18n, E2E)                                           | PR 1c |
| §13.4 enum value retired, Zod refuses it                                         | PR 1d |
| §5 enum + controller gate + service gate (default-deny)                          | PR 2  |
| §5 scope helper, people / projects / teams grants, `users.createdById`           | PR 3  |
| §4.1 `periodMonth` + backfill; §4.2 accepted-status set                          | PR 4  |
| §4.3 share storage, resolver, snapshot, re-snapshot rule                         | PR 5a |
| §4.2 both percentages on income rows, drop paths, §4.7 manager-owned projects    | PR 5b |
| §4.2 profit layer read (`earned` profit part), row classification                | PR 5c |
| §4.4 junior salary attribution; §4.5 `expenseCategory`, settlement expense       | PR 6  |
| §4.4a no mixed batches, cash snapshot on IOUs / cash rows; §4.5 `MANAGER_PAYOUT` | PR 7a |
| §4.6 manager cash write paths, `in hand`, company-account ledger types           | PR 7b |
| §4.6 currency: historical NBU rate persistence                                   | PR 8  |
| §4.6 partner accounts, stats card; §6.1–6.2 legacy figure, `adminUntil`          | PR 9  |
| §6.3–6.7 migration of the former admin partner                                   | PR 10 |
| §7 CODEOWNERS, CI owner-approval check, protection doc                           | PR 11 |
| §7 VPS restricted SSH runbook                                                    | PR 12 |

Order follows design §10. PR 4 (`periodMonth`) is pulled in front of shares because every later money PR reads it. PR 8
has no dependency and can run in parallel from PR 4 on.

## The cutoff gap (2026-12-01 → PR 10 deploy)

Nothing of the MANAGER model ships before 2026-12-01 (four days). Between the cutoff and the PR 10 deploy:

- The former partner stays `ADMIN` in the CRM: he keeps full visibility and keeps booking rows as today.
- December rows land without snapshots. PR 4 backfills `periodMonth` from data; PR 10's fail-loud data step snapshots
  every `periodMonth ≥ '2026-12'` row (design §6.5) and lists mixed November/December payout requests for ADMIN to
  split.
- The legacy DEBT card keeps moving with December rows until PR 9 restricts both partners to `periodMonth ≤ '2026-11'`.
  It is not a settlement figure in that window.

Owner decision Q-A (end of this file) covers the visibility part.

---

## PR 1a — ACCOUNTANT fact-finding and data step (§13.1–13.2)

**Track:** full (prod data, RBAC). **Agents:** coder (SQL), security-reviewer, code-reviewer. **Gate:** owner runs the
fact-finding SQL and decides the new role per user (A3) before the data step is written.

**Files:**

- Create: `apps/api/drizzle/manual-private/2026-11-27_accountant_fact_finding.sql` (owner-run, never wired)
- Create: `apps/api/drizzle/manual/2026-11-27_accountant_role_retire.sql` (deploy-wired assertion + uniform update)
- Modify: `.github/workflows/deploy.yml` (list the new manual file, before the app starts)
- Test: `apps/api/src/database/accountant-role-retire-ddl.integration.spec.ts`

**Acceptance criteria:**

1. The fact-finding file is read-only: it opens `BEGIN TRANSACTION READ ONLY` and contains no `INSERT`, `UPDATE`,
   `DELETE`, DDL or function with side effects; a unit test greps the file for these keywords and fails on any.
2. It returns: count of ACCOUNTANT users split active / archived; per ACCOUNTANT user only `id`, `archived_at IS NOT
NULL`, `created_at` (no email, no name); and per FK column referencing `users.id` the count of rows naming an
   ACCOUNTANT user. FK columns are **derived from `pg_constraint`** at run time (`contype = 'f'`,
   `confrelid = 'users'::regclass`), counted through `query_to_xml`, so a column added later is never missed
   (`team_members`, `project_members`, approvals and audit tables included).
3. The deploy-wired file applies only the owner's decision and ends with a fail-loud assertion
   `DO $$ BEGIN IF (SELECT count(*) FROM users WHERE role = 'ACCOUNTANT') > 0 THEN RAISE EXCEPTION … END IF; END $$`.
   It names no email; user ids appear only if the owner decides per-user targets (Q-C).
4. The file is idempotent: a second apply changes nothing and the assertion still passes.
5. History rows that name a former ACCOUNTANT user (transactions as sender / receiver / validator, audit, approvals)
   are untouched: the integration test counts them before and after.

**Steps:**

- [ ] **Step 1: Write the read-only grep test** `accountant-fact-finding-sql.spec.ts` asserting the file starts with
      `BEGIN TRANSACTION READ ONLY` and has no match for `/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT)\b/i`
      outside comments. Run `pnpm --filter @crm/api test accountant-fact-finding-sql` → FAIL (file missing).
- [ ] **Step 2: Write the fact-finding SQL** (AC 2). Run the test → PASS. Run the file once on the scratch DB
      (`DATABASE_URL=<scratch> psql -v ON_ERROR_STOP=1 -f …`) after `SELECT current_database()`; it returns the three
      result sets.
- [ ] **Step 3: Commit + push wip**, open the PR as draft, hand the file to the owner. **Stop this branch** until the
      owner's per-user decision (A3). Neighbouring work (PR 1b code on a stacked branch) continues.
- [ ] **Step 4: Write the failing integration spec** `accountant-role-retire-ddl.integration.spec.ts`: seed two
      ACCOUNTANT users (one archived) with a transaction each as `validated_by`; apply the file; assert
      `count(role='ACCOUNTANT') = 0`, the target role per the decision, and unchanged transaction counts; apply again →
      no error. Run with `DATABASE_URL=<scratch>` → FAIL.
- [ ] **Step 5: Write the deploy-wired file** (AC 3–4) and list it in `deploy.yml` after the last manual file and
      before the app container starts. Run the spec → PASS.
- [ ] **Step 6: Final commit** with `ac_verified: 1,2,3,4,5`; `DATABASE_URL= git push`; `git ls-remote` shows the sha.

**Tests:** grep unit spec (AC 1); integration spec on scratch DB (AC 3–5).

**Risks:** an ACCOUNTANT user with rows the owner did not expect (validator of open transactions) — the count per FK
column surfaces it before the decision. The data step must deploy and pass **before** PR 1d removes the value from Zod,
otherwise `.parse()` of a stored user throws.

## PR 1b — ACCOUNTANT removal, API (§13.3)

**Track:** full. **Agents:** coder, code-reviewer, security-reviewer. **Depends on:** PR 1a merged and applied on prod
(0 ACCOUNTANT users).

**Files (inventory, regenerate with the grep in the audit file):** 35 files in `apps/api/src/finance` (incl.
`accountant-summary` endpoint in `transactions.controller.ts`, `@Roles('ADMIN', 'ACCOUNTANT')` on validation, expense
entry, pending settlement, company account), 13 in `users/` (incl. `@Roles('ADMIN', 'ACCOUNTANT')` in
`users.controller.ts`), 12 in `projects/`, 6 in `teams/` (auto-add to every team), 10 in `database/` (seed users,
`seed-templates/contract-accountant.ts`, `ACCOUNTANT_CONTRACT` in `seed/contract-bodies.ts` / `seed/onboarding.ts`),
`notifications/notification-email-copy.ts`, `contracts/`, `invoices/`, `documents/`, `legends/`, `credentials/`,
`interviews/`, `job-sourcing/`, `resumes/`, `common/`; `apps/api/eslint.config.mjs`.

**Acceptance criteria:**

1. `grep -rn ACCOUNTANT apps/api/src --include=*.ts` returns matches only in migration-history comments and the
   retirement spec; each remaining match is listed in the PR body with its reason.
2. Every `@Roles(..., 'ACCOUNTANT', ...)` loses the value; no endpoint widens (a role set never gains a role in this PR).
3. Every service branch for ACCOUNTANT is deleted, or folded into the ADMIN branch where ADMIN already had the same
   right; no branch that granted ACCOUNTANT something ADMIN lacked is folded (listed in the PR body if any exists).
4. `GET /api/finance/accountant-summary` and `accountantSummarySchema` consumers are removed; the route returns 404.
5. Team auto-membership for ACCOUNTANT is removed; existing `team_members` rows of former accountants are untouched.
6. Seeds create no ACCOUNTANT user and no ACCOUNTANT contract template.
7. `pnpm --filter @crm/api typecheck` and `test` pass; the case count is non-zero and reported.

**Tests:** existing unit/integration specs that used ACCOUNTANT are rewritten to ADMIN where the behaviour is the
folded one, deleted where it was ACCOUNTANT-only; one RBAC integration spec per touched endpoint asserts the role set
is unchanged for ADMIN / SENIOR / HR / JUNIOR / DROP.

**Risks:** folding a branch widens ADMIN by accident (AC 3); silent removal of a validation path (ADMIN keeps
`PATCH /transactions/:id/validate`, a test proves it).

## PR 1c — ACCOUNTANT removal, web + i18n + E2E (§13.3)

**Track:** full (RBAC in `route-access.ts`). **Agents:** coder (web), autotest (E2E), code-reviewer,
security-reviewer, copy-reviewer (catalogs). **Depends on:** PR 1b.

**Files:** `apps/web/app/lib/route-access.ts` (`ALL_ROLES`, `DASHBOARD_NAV_ROLES`, `ROUTE_ACCESS`), 51 route files and
19 components (AccountantDashboard and its route branch), `apps/web/app/hooks/*`,
`apps/web/app/components/ui/role-select.tsx`, `packages/shared/src/i18n/locales/{uk,en}/messages.po`,
`apps/e2e/tests/accountant-dashboard.spec.ts` (deleted) and 48 E2E files that name ACCOUNTANT, `apps/e2e/COVERAGE.md`.

**Acceptance criteria:**

1. `grep -rn ACCOUNTANT apps/web/app apps/e2e` returns nothing except listed comments.
2. No route grants a role it did not grant before; `ROUTE_ACCESS` coverage test still passes.
3. Role pickers no longer offer ACCOUNTANT; catalogs drop the role label in `uk` and `en` (`i18n:extract` clean).
4. `pnpm --filter @crm/e2e test` passes locally on a scratch DB with a non-zero case count.

**Tests:** route-access unit test (role sets per prefix, snapshot of the full table); E2E suites that used an
ACCOUNTANT login re-pointed to ADMIN or deleted with the reason in the PR body.

**Risks:** dev-login fixtures with ACCOUNTANT break E2E setup — fixtures updated first.

## PR 1d — Retire the enum value (§13.4)

**Track:** full (DB, RBAC). **Agents:** coder, security-reviewer. **Depends on:** PR 1c; prod shows 0 ACCOUNTANT users.

**Decision (Q-B, recommendation):** keep `'ACCOUNTANT'` in the Postgres `role` type and in Drizzle `roleEnum` (so
`db:push` in dev/CI never tries to drop or recreate the type), remove it from Zod `roleSchema` and every shared
literal, and add `CHECK (role <> 'ACCOUNTANT')` on `users` (Drizzle `check()` + manual SQL). Recreating the type
rewrites every column using `role` under an exclusive lock and touches the privilege SQL; it buys nothing a CHECK does
not.

**Files:** `packages/shared/src/schemas/users.ts` (`roleSchema`), inline role literals in
`packages/shared/src/schemas/**`, `apps/api/src/database/schema/users.ts` (check), `apps/api/src/database/schema/enums.ts`
(comment that the value is retired), `apps/api/drizzle/manual/2026-11-28_users_role_not_accountant.sql`, `deploy.yml`.

**Acceptance criteria:**

1. `roleSchema.safeParse('ACCOUNTANT').success === false`.
2. `INSERT`/`UPDATE` of a user to `ACCOUNTANT` fails with SQLSTATE `23514` on a scratch DB.
3. The manual file is idempotent (`DROP CONSTRAINT IF EXISTS` + `ADD`) and ordered after PR 1a's file.
4. `schema-ddl-coverage.spec.ts` covers the new check.
5. Before writing the Drizzle change, verify how `drizzle-kit push` treats the unchanged enum + new check on a scratch
   DB (no type recreation in the generated SQL); paste the output in the PR body.

**Tests:** Zod unit test (AC 1); DDL integration spec (AC 2–4).

**Risks:** a cached JWT carrying `role: 'ACCOUNTANT'` — PR 1a leaves no such user, and the auth payload parse rejects
it with 401 (test).

---

PRs 2–12 below are PR-level blocks (scope, numbered AC, tests, risks). Each gets step-level TDD detail in its own task
file under `.claude/tasks/` when it starts, after the previous PR merges, so names fixed by earlier PRs are real.

## PR 2 — MANAGER enum + both gates, default-deny (§5)

**Agents:** coder, code-reviewer, security-reviewer. **Depends on:** PR 1d.

**Scope:** `apps/api/drizzle/manual/<date>_role_manager.sql` (`ALTER TYPE role ADD VALUE IF NOT EXISTS 'MANAGER'`,
alone in its file), `roleEnum`, `roleSchema` and every shared literal, `ALL_ROLES` / `ROUTE_ACCESS` (MANAGER gets only
`/profile`, `/onboarding`, `/pending` in this PR), every row of the RBAC checklist file.

**Acceptance criteria:**

1. `MANAGER` exists in the Postgres type, Drizzle, Zod and the web role list; ADMIN can create a MANAGER user.
2. Every checklist row is ticked with its **confirmed** class and, where the class is "ADMIN or MANAGER-in-scope", a
   pointer to the PR that grants it. In this PR every such row still **denies** MANAGER.
3. Every service role chain (`if / else if` without `else`, `switch`, role arrays, `Record<Role, …>`, DB predicates on
   `role`) handles MANAGER explicitly; an unknown role reaches a deny `else` / `default` that throws `ForbiddenException`
   or returns the empty set — never "everyone else".
4. `balance.service` `getTotalEarned` returns a deny for MANAGER instead of a silent 0 (PR 9 replaces it).
5. A MANAGER calling every handler without `@Roles` gets 403 or an empty result.

**Tests:** an exhaustive-role unit test per role-chain helper (`Record<Role, …>` typed so a new role fails
`typecheck`); one RBAC integration spec per controller (`<module>.manager-deny.rbac.integration.spec.ts`) iterating
every handler with a MANAGER session → 403 / empty; E2E: MANAGER dev-login lands on `/profile`, every other nav item
hidden.

**Risks:** the 117 guard-less handlers (Review Focus 4); a role check in a web component the checklist misses — the
web half of the checklist is reviewed by security-reviewer row by row.

## PR 3 — Scope helper and people / projects / teams grants (§5)

**Agents:** coder, autotest, code-reviewer, security-reviewer; ui-ux-designer for manager screens (design-gate).
**Depends on:** PR 2.

**Scope:** columns `projects.managerId`, `teams.managerId`, `users.createdById` (all nullable FK → `users.id`) with
manual SQL; new `apps/api/src/common/manager-scope.ts` mirroring `getHrScope` / `HrAccessService`; the checklist rows
classed "ADMIN or MANAGER-in-scope" in `users/`, `projects/`, `teams/`, `credentials/`, `approvals/` (senior-share
route), `drop-creation`; web routes `/team`, `/projects`, `/routing` for MANAGER.

**Interfaces (produced):** `getManagerScope(db, managerId): Promise<ManagerScope>` with
`{ projectIds: Set<string>; teamIds: Set<string>; readableUserIds: Set<string> }`;
`isExclusivelyMine(db, managerId, userId): Promise<boolean>`; `assertArchiveCascadeInScope(db, managerId, userId)`.

**Acceptance criteria:**

1. Projects scope = `projects.managerId = me`, nothing else.
2. People read scope = active members of my teams ∪ senior, drop and active `project_members` of my projects.
3. Exclusively-mine = at least one active project or team and all in my scope; or none and `createdById = me`.
4. Every row of the §5 action table is enforced as written (create-user roles, role change, team add, edit/archive
   another MANAGER / ADMIN refused, manager-share / `managerId` setters ADMIN only, `teams.managerId` at creation:
   himself only; HR may pick any manager).
5. Archive refuses when the `UserArchiveService.archive` cascade would touch anything out of scope.
6. A project a MANAGER creates gets `managerId = me`; a new project of a team's senior/drop gets `teams.managerId`.

**Tests:** unit for `getManagerScope` / `isExclusivelyMine` (shared user, no-team manager, user with no project);
integration per list/read endpoint proving no leak across two managers and the owner (incl. 403); archive-cascade
integration (senior whose team is not mine → refused); E2E manager creates a junior, adds him to his project, cannot
see the other manager's project.

**Risks:** HR scope and manager scope interact on the same team — test a team with both an HR and a manager.

## PR 4 — `periodMonth` and the accepted-status set (§4.1, §4.2)

**Agents:** coder, code-reviewer, security-reviewer. **Depends on:** PR 2 (can run parallel to PR 3).

**Scope:** `transactions.periodMonth varchar(7) NOT NULL` (added nullable, backfilled, then `SET NOT NULL` in a second
manual file); every transaction writer; `pending-settlement-tx.util` (settle-in-place keeps the period); payout-batch
writers (latest income period via `payoutRequestId`); the ADMIN edit path (period changes only on an ADMIN edit that
crosses the cutoff); a read-only owner listing in `manual-private/` of rows near the cutoff.

**Acceptance criteria:**

1. SALARY → `salaryMonth`; other rows → month of `txDate` in `Europe/Kyiv` at insert.
2. Batch rows (confirmation, `PAYOUT`, `PAYOUT_DROP`, drop IOUs) → latest `periodMonth` of the batch's incomes.
3. Settling an IOU in place keeps its `periodMonth`; a `txDate` edit not crossing the cutoff keeps it.
4. Backfill: SALARY from `salaryMonth`; flipped IOUs from their `pending_obligations` source; else `txDate`; fail-loud
   on any row left NULL.
5. A shared constant `ACCEPTED_TX_STATUSES` (proposed: `VALIDATED`, `PENDING_PAYMENT`, `PAID`; to be confirmed from
   the validation flow in this PR, with `LOCKED` and `PENDING_CASH_CONFIRM` classified explicitly) and a predicate
   `isProfitCountable(row)` that also excludes `deletedAt IS NOT NULL` and `REJECTED`.

**Tests:** unit per writer (period source); a 2026-11-30 23:30 Kyiv `txDate` → `2026-11`; settle-in-December keeps
`2026-11`; backfill integration on scratch DB; exhaustive status-classification test.

**Risks:** an unknown writer path leaves NULL — the NOT NULL step fails loud and the grep of every
`insert(transactions)` is attached to the PR.

## PR 5a — Manager share storage, resolver, snapshot (§4.3)

**Depends on:** PR 3, PR 4. **Agents:** coder, code-reviewer, security-reviewer.

**Scope:** `users.managerSharePercent`, `teams.managerSharePercentOverride`, `projects.managerSharePercentOverride`;
`apps/api/src/finance/manager-share-resolver.ts`; snapshot columns on `transactions`: `managerId`,
`managerSharePercent`, `managerSharePercentSource`; ADMIN-only setters; the edit path re-snapshot rule.

**Interfaces (produced):** `resolveManagerShare(input): { managerId: string | null; percent: number | null; source:
'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null }`, same shape as `resolveSeniorShare`.

**Acceptance criteria:**

1. Precedence PROJECT → TEAM → USER_DEFAULT; `managerId` from `projects.managerId` only.
2. Every profit-layer writer and every manager-settlement expense writes the three snapshot columns.
3. Reassigning a project or changing a % never rewrites existing rows.
4. Re-snapshot on an edit of `projectId` or of a `periodMonth` crossing the cutoff, with old and new in
   `transaction_audit_log`; any other edit keeps the snapshot (Review Focus 5).
5. Setters refuse MANAGER (403) and are audited.

**Tests:** resolver unit (all precedence branches, no manager); writer snapshot unit; re-snapshot unit; setter RBAC
integration.

## PR 5b — Both percentages on income rows; drop paths; manager-owned projects (§4.2, §4.7)

**Depends on:** PR 5a.

**Scope:** `createSeniorIncome`, `createDropIncome` (`senior-drop-income.service.ts`), `createAdminIncome`,
`declareUsdtProjectIncome` (`admin-income.service.ts`), `applyDropProjectPayout`, every check deciding "admin-owned" by
`seniorId.role === 'ADMIN'`.

**Acceptance criteria:**

1. From 2026-12 every income writer snapshots `seniorSharePercent` and `dropSharePercent` (0 when no cut).
2. Per income path: `gross × (1 − senior% − drop%)` = gross − the IOU amounts that path creates (unit, money-exact via
   `packages/shared/src/utils/money.ts`).
3. On a project with a drop, every admin- / manager-owned income path books and snapshots the drop cut, or refuses.
4. The drop payout sizes each income's cut from that income row's own snapshots (test: share change between
   declaration and payout; mixed-% batch).
5. Manager-owned project (`seniorId = managerId`): senior% = 0, no senior IOU, company take = gross × (1 − drop%).

## PR 5c — Profit layer read (§4.2)

**Depends on:** PR 5b.

**Scope:** `apps/api/src/finance/profit-layer.ts` — a pure classification of every `transactionTypeEnum` value
(PROFIT_INCOME / PROFIT_EXPENSE / PROFIT_SALARY / CASH / NEVER) and the SQL that sums `earned` (profit part) per
manager per period; project net profit for reports.

**Acceptance criteria:**

1. Only income, project-expense and junior-salary rows are profit-layer; settlement rows (referenced by
   `pending_obligations.closingTransactionId`), payouts, IOUs, dividends, `DIVIDEND_TAX`, `COMPANY_DEPOSIT`, HR salaries,
   general expenses, `PAYOUT_ADMIN` never are.
2. The classification is a `Record<TransactionType, …>` so a new enum value fails `typecheck` (Review Focus 1–2).
3. A negative month reduces `earned`; no floor.
4. Rejected / soft-deleted rows drop out; their cash effect (PR 7b) stays (Review Focus 3).

**Tests:** table-driven unit over every type; integration with a negative month; no double count between income and
its IOU / payout rows.

## PR 6 — Junior salary attribution and expense attribution (§4.4, §4.5)

**Depends on:** PR 5c.

**Scope:** `salary.service` cron (`seenReceiverIds` path) and manual `createSalary`; `expenseCategory` enum
(`CURRENCY_CONVERSION`, `TRANSFER_FEE`, `TAX`, `OTHER`) on new expense rows; expense entry for project / general /
manager-settlement scopes; ADMIN row-level edit of `managerId` / % on a SALARY or settlement row.

**Acceptance criteria:**

1. SALARY snapshot `managerId` = the single manager of all the junior's active projects in that month, % = that
   manager's user default; mixed or none → empty snapshot (owner-only) until ADMIN sets it (audited).
2. Amount = `monthlySalary` unless every active project carries the same `juniorSalaryOverride`; different overrides →
   `monthlySalary` and the row is flagged for ADMIN.
3. Who may pay a SALARY row: ADMIN or the row's snapshotted `managerId`.
4. Expense scopes per the §4.5 table; general expenses invisible to MANAGER; settlement % = manager's user default at
   write time, editable by ADMIN.
5. `receiverLabel` stays on legacy rows.

**Tests:** salary attribution unit (one manager, mixed, none, override agree/disagree); expense scope integration
(MANAGER cannot see general); settlement % snapshot unit.

## PR 7a — Cash snapshots, no mixed batches, `MANAGER_PAYOUT` (§4.4a, §4.5)

**Depends on:** PR 6.

**Scope:** `transaction_type` gains `MANAGER_PAYOUT` (own manual file, `ADD VALUE`); IOUs and every cash row made for an
income copy its `managerId`; payout-request creation refuses mixing `periodMonth ≤ '2026-11'` with `≥ '2026-12'`;
company-account ledger (`company-account-balance`) type list extended with `MANAGER_PAYOUT` and settlement expenses paid
from the company wallet.

**Acceptance criteria:**

1. Every cash type is listed with its linking path and tested across the cutoff (table in the PR body).
2. Mixed request → 400 with a new error code in `packages/shared/src/schemas/api-errors/`.
3. Write check for a batch: the manager of every project in it, else ADMIN only.
4. After a reassignment the old manager still sees and settles his rows; the new one does not get them.

## PR 7b — Manager cash write paths and `in hand` (§4.6)

**Depends on:** PR 7a.

**Scope:** `ADMIN_INCOME` receiver, `ADMIN_TRANSFER` both sides (ADMIN ↔ MANAGER handovers),
`PayoutConfirmationService` (`FINANCE_RECIPIENT_MUST_BE_ADMIN`), salary / IOU payer checks, expense entry: each becomes
"ADMIN, or the MANAGER of that row's snapshot"; `summary.service` HOLDING parameterised by user and period range.

**Interfaces (produced):** `computeHolding(db, { userId, periodFrom?, periodTo? }): Promise<Money>`.

**Acceptance criteria:**

1. Received set gains `MANAGER_PAYOUT` and ADMIN → MANAGER transfers; paid set gains MANAGER → ADMIN handovers and the
   manager-paid salary / IOU / expense rows.
2. One test per cash type proves it moves `in hand` once, with the right sign.
3. A cost paid from his own pocket lowers `in hand` by the full amount.
4. MANAGER cannot write a cash row outside his snapshots (403 integration per path).

## PR 8 — Historical NBU rates persisted (§4.6 currency)

**Depends on:** none (parallel from PR 4).

**Scope:** `NbuCurrencyService.getRates(date)`; a table of persisted daily rates; read paths for `earned`, `in hand`
and the legacy figure convert each row at its own date's rate.

**Acceptance criteria:**

1. A past date is fetched once and persisted; later reads never call NBU for it.
2. A live read never calls NBU per row (batch prefetch of missing dates).
3. A stale or fallback rate marks the balance `stale: true`; a payout against it shows a warning.

## PR 9 — Partner accounts, stats card, legacy figure, `adminUntil` (§4.6, §6.1–6.2)

**Depends on:** PR 7b, PR 8. **Agents:** + ui-ux-designer (design-gate: partner accounts list and drill-down), copy-reviewer.

**Scope:** `users.adminUntil date`; legacy computation selects partners as `role = 'ADMIN' OR adminUntil IS NOT NULL`,
restricted for **both** partners to `periodMonth ≤ '2026-11'`; partner-account endpoint and screen; DEBT card replaced
by the partner accounts list; `getTotalEarned` MANAGER branch.

**Acceptance criteria:**

1. `legacy = (HOLDING(owner) − HOLDING(partner)) / 2`, signed, live, never stored; late November-period rows listed
   under it.
2. `balance = legacy + earned − in hand`; owner has no partner account; owner's post-cutoff HOLDING shown separately.
3. `getTotalEarned` for a MANAGER with `adminUntil`: ADMIN branch over `periodMonth ≤ '2026-11'` + `MANAGER_PAYOUT`
   after; the partner's pre-cutoff earnings do not drop to 0.
4. MANAGER sees only his own partner account; ADMIN sees all; drill-down by project and period.
5. Negative balance: payout warning, not a block.

**Tests:** unit for the legacy formula (sign, both-partner restriction); integration no double count across the
cutoff; E2E partner accounts list (ADMIN) and own account (MANAGER).

## PR 10 — Migration of the former admin partner (§6.3–6.7)

**Depends on:** PR 9. **Gate:** owner reviews the data step (A3, prod data); owner supplies the 4 project ids and the
user id at migration time (never committed).

**Scope:** a parameterised deploy-wired data step (ids passed as `psql -v` variables from an owner-set GitHub
environment secret or run by the owner over `ssh crm-vps` — Q-D), plus a `manual-private/` row-level review query.

**Acceptance criteria:**

1. Sets `adminUntil = '2026-11-30'`, `role = 'MANAGER'`, `managerSharePercent = 50`; the 4 projects get
   `managerId` and `managerSharePercentOverride = 50`.
2. Snapshots every `periodMonth ≥ '2026-12'` row written before the deploy (manager snapshot + senior/drop % via the
   same resolvers); a row the resolvers refuse or an IOU that disagrees stops the step and is listed; an unknown cut is
   never 0.
3. Lists open payout requests mixing November and December income.
4. The company-account balance is unchanged (assertion before/after).
5. Idempotent; a dry-run mode prints counts only.

**Tests:** integration on a scratch DB seeded with a two-partner history across the cutoff: legacy figure equals the
pre-migration DEBT over `≤ 2026-11` rows; post-migration balance = legacy + earned − in hand.

## PR 11 — CODEOWNERS, CI owner-approval check, protection doc (§7)

**Agents:** devops, security-reviewer. **Gate:** owner approves the open-path list and enables "Require review from
Code Owners".

**Acceptance criteria:**

1. `.github/CODEOWNERS` keeps `* @yaremenko-maksym`; ownerless lines open the paths the owner approves (proposal:
   `apps/web/**`, `apps/landing/**`, `apps/e2e/**`, `docs/**`); re-protected after them: `apps/web/app/lib/route-access.ts`
   and the auth / finance parts of `apps/web`.
2. A required CI check fails a PR in the open paths that imports the DB client, a finance table / service, or adds a
   controller, unless the owner approved.
3. `.github/CODEOWNERS.md` explains what is protected and why.

## PR 12 — VPS restricted SSH runbook (§7)

**Agents:** devops. Docs-only.

**Acceptance criteria:** `docs/runbooks/vps-manager-ssh.md` describes an owner-run provisioning of a dedicated user
with no docker group and no sudo, a forced command exposing only read-only log / status commands for the CRM
services, no `.env` / DB / docker socket access, a verification checklist and a revoke procedure.

---

## Assumptions (A1, recorded)

- PR 1 is split into 1a–1d so the data step deploys before Zod refuses the value (design §13.2).
- `periodMonth` ships as PR 4, ahead of shares, because every later money PR reads it.
- `users.createdById` is added in PR 3; existing users have none, so "created by me" applies only to users created
  after PR 3 deploys.
- The RBAC checklist classes are proposals by path and symbol rules; PR 2 confirms each row.

## Owner decisions (decision brief)

**Q-A — Visibility of the former partner between 2026-12-01 and the PR 10 deploy.** The MANAGER model cannot ship in
four days. He stays ADMIN and sees all company money in that window (design anti-goal). Options: (1) accept it for the
window; (2) the owner books his rows and his account is deactivated until PR 10. **Recommendation: (1)**; December data
is fixed up by PR 10, and (2) blocks him from recording client money.

**Q-B — ACCOUNTANT enum value.** Keep it in the Postgres type, refuse it in Zod and with a `CHECK (role <>
'ACCOUNTANT')`, or recreate the type. **Recommendation: keep + CHECK** (PR 1d rationale).

**Q-C — Target role per ACCOUNTANT user.** Answered after you run the PR 1a fact-finding SQL. **Recommendation:** one
uniform target role if the data allows, so the deploy-wired step names no user id.

**Q-D — How the migration ids reach prod.** (1) the owner runs the PR 10 data step himself over `ssh crm-vps`; (2) the
ids are a `production`-environment secret read by `deploy.yml`. **Recommendation: (1)**, the public Action log never
sees them.

**Q-E — Modules the design does not grant MANAGER.** Interviews, vacancies, job sourcing, tailored resumes, documents,
employee contracts, invoices stay ADMIN-only by default-deny (219 checklist rows). A manager who creates a user may
need that user's contract and onboarding. **Recommendation:** keep them denied in this programme and add grants as a
follow-up design once managers use the CRM.
