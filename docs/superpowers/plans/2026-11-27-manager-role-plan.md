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

<!-- PRs 2–12 follow -->
