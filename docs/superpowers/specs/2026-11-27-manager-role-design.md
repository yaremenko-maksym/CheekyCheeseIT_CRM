# MANAGER role, partner accounts and Kostya's exit from ADMIN — design

Date: 2026-11-27 · Status: draft r2 (after builder check + second-opinion round 1), awaiting owner approval ·
Effective date of the business change: **2026-12-01**

## 1. Intent

From 2026-12-01 Kostya stops being an ADMIN and leaves the business. He keeps **50 % of the net profit
of the 4 current projects** and shares the costs that belong to those projects (currency conversion and
transfer fees to pay him, junior salaries on those projects). Every other company cost (general expenses,
HR salary) is the owner's (Maksym's) alone for periods from December on.

To express that — and to onboard a new manager (Vladislav) who earns a share of the net profit of his own
projects — the CRM gains a new role **MANAGER**: a scoped "first-level admin" who runs the people and
projects in his scope and earns a configurable share of each of his projects' net profit. The implicit
"two admins, 50/50, DEBT = difference / 2" model is replaced by explicit **partner accounts** with a live
"who owes whom" balance per manager.

Why: the 50/50 split exists nowhere in code — only as an assumption (HOLDING and the admin balances read
live `users.role = 'ADMIN'`, the stats card divides the difference by two). Simply changing Kostya's role
would drop his history out of the statistics and leave no place to record his ongoing share.

## 2. Goals

1. New role `MANAGER` with scoped admin rights, **default-deny** everywhere it is not explicitly granted (§5).
2. Per-project manager share of **net profit**, resolved PROJECT → TEAM → USER like the senior share,
   snapshotted on every money row so a later % change or reassignment never rewrites history (§4).
3. Project-tagged expenses separated from general company expenses (§4.3).
4. A live partner balance per manager (§4.5).
5. Kostya migrated to MANAGER on 2026-12-01 with his history and the existing balance preserved (§6).
6. A new manager can develop in the CRM repo and merge, with owner approval required only on critical
   zones; restricted read-only SSH on the prod VPS (§7).

## 3. Non-goals / anti-goals

- **Non-goal:** several managers on one project. One manager per project (owner-confirmed).
- **Non-goal:** automatic bank/crypto transfers. Payouts are booked manually.
- **Non-goal:** a manager changing his own share, his project's manager, or a team's manager. ADMIN only.
- **Anti-goal:** a manager seeing money that does not concern him — company expenses, the owner's income,
  another manager's projects, rows from before he managed the project. A leak is a failure even if the
  maths is right.
- **Anti-goal:** a second ledger that can drift from `transactions` (why approach B was rejected).
- **Anti-goal:** Kostya being attached to new projects. He is bound directly to the 4 projects, never via a team.
- **Anti-goal:** counting one euro twice (income and its payout row; legacy balance and new balance).

## 4. Finance model

### 4.1 Period

`transactions` has no period column. Period = **`salaryMonth`** for SALARY rows, otherwise the calendar
month of **`txDate`** (Europe/Kyiv). Stored as a generated/derived `periodMonth` (builder decides: generated
column or expression) so cutoff and monthly aggregates use one definition.

### 4.2 Net profit of a project

Per project, per period, over rows in a **settled** status only (PAID / CONFIRMED — the exact status set is
fixed in the term table below):

```
net profit = company income            # what the company keeps from client money (after senior + drop share)
           − junior salaries on the project
           − project expenses (conversion, transfer fees, other)
manager share = net profit × managerSharePercent   # may be negative
owner part    = net profit − manager share
```

**Term table (first plan task, from code, reviewed by security-reviewer).** Every transaction type/status
maps to **exactly one** term or to "none". Rule: client money counts **once**, at the row that represents
the company's take — never at both the gross income row (`SENIOR_INCOME` / `DROP_INCOME`, gross, carries no
senior-share debit) and its `PAYOUT` row. Draft, to be verified against `payout-request.service`,
`drop-distribution.util`, `senior-drop-income.service`, `edit-cascade.service`:

| Term               | Source rows (draft)                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| company income     | `PAYOUT` for senior/drop income (company take = income × (1 − senior% − drop%)); `ADMIN_INCOME*` on admin-owned projects minus its senior IOU (`SENIOR_PENDING_PAYOUT`) |
| junior salary      | `SALARY` with receiver JUNIOR, allocated to projects per §4.4                                                                                                           |
| project expense    | `EXPENSE` with `projectId`                                                                                                                                              |
| manager settlement | `EXPENSE` with `managerId` (conversion, fee, tax for paying him)                                                                                                        |
| manager payout     | new `MANAGER_PAYOUT`                                                                                                                                                    |
| none               | `DIVIDEND_TO_ADMIN`, `DIVIDEND_TAX`, `COMPANY_DEPOSIT`, HR `SALARY`, general `EXPENSE`, legacy `PAYOUT_ADMIN`                                                           |

A **negative** month is shared: the manager's balance goes down and is paid back from future accruals
(owner decision). No floor at zero. A payout while the balance is negative shows a warning, is not blocked.

### 4.3 Share resolution and snapshot (approach A)

- Storage mirrors the senior share: `users.managerSharePercent` (user default), `teams.managerSharePercentOverride`,
  `projects.managerSharePercentOverride`; `resolveManagerShare` with precedence PROJECT → TEAM → USER_DEFAULT,
  same shape as `resolveSeniorShare`.
- A project's manager is **`projects.managerId`** — the single source of truth. `teams.managerId` only
  supplies the default when a project is created.
- Every row that maps to a manager-relevant term gets three snapshot columns at write time: `managerId`,
  `managerSharePercent`, `managerSharePercentSource` — as `seniorSharePercent` / `seniorSharePercentSource`
  are written today. Reassigning a project later does **not** move old rows to the new manager.
- Edits / soft-deletes flow through the balance automatically (it is derived). The paid-transaction edit
  cascade (`payoutRequestId` guard, monotonic `settled_amount`) keeps the snapshot of the row it edits.
- Manager share changes: ADMIN only. Senior share / drop share / junior salary of people in a manager's
  scope: the manager may initiate them through the **existing approval flow** (senior/drop confirms,
  `SENIOR_SHARE_ROUTES`); no extra owner approval.

### 4.4 Junior salary allocation

Today the salary cron writes **one** SALARY row per junior, with the `projectId` of the first active
membership (`salary.service`, `seenReceiverIds`); manual `createSalary` writes no `projectId`. A junior on
two projects would charge the whole salary to one of them.

Owner decision: **one salary per junior** — no splitting. The SALARY row stays one per junior per month and
is charged to exactly one project. Changes: the cron picks that project deterministically (not "first
membership in query order" — e.g. the junior's designated primary project, editable by ADMIN), and manual
`createSalary` for a JUNIOR requires a `projectId`. The row's snapshot follows that project's manager.

### 4.5 Expense attribution

| Expense scope                                                    | Fields                         | Effect                                            |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------------------------------- |
| **General company**                                              | no `projectId`, no `managerId` | owner only, invisible to managers                 |
| **Project**                                                      | `projectId`                    | reduces that project's net profit                 |
| **Manager settlement** (conversion / fee / tax to pay a manager) | `managerId`, no `projectId`    | charged to his account at the row's snapshotted % |

`expenseCategory` enum (`CURRENCY_CONVERSION`, `TRANSFER_FEE`, `TAX`, `OTHER`, …) for new rows; `receiverLabel`
stays for legacy rows. A settlement row snapshots one `managerSharePercent` at write time = the manager's
user default (Kostya: 50, set in §6), editable by ADMIN on the row. No weighted average.

A payout to a manager is an **ordinary transfer** `MANAGER_PAYOUT` (owner decision), not a dividend — no
automatic tax. Any tax or fee for that payment is a separate settlement expense.

When `MANAGER_PAYOUT` or a settlement expense is paid from the company wallet, it debits the company-account
ledger (`company-account-balance`) like other outgoing types — the type list there is extended.

### 4.6 Partner account and live balance

Positive = company owes the manager. Computed on read:

```
balance = legacy balance (§6, periods ≤ 2026-11, Kostya only)
        + Σ manager share of net profit (periods ≥ 2026-12, rows snapshotted to him)
        − Σ (settlement expense × its %)
        − Σ MANAGER_PAYOUT to him
        + Σ company costs he paid from his own pocket (senderId = him: project expenses, junior salaries)
        − Σ client money he received in person and still holds
        + Σ handovers from him to the owner / company account
        − Σ handovers from the owner to him that are not payouts
```

- Kostya keeps receiving client money on the 4 projects (owner-confirmed). Today such receipts and
  handovers are ADMIN-only (`ADMIN_INCOME` receiver, `ADMIN_TRANSFER` both sides,
  `PayoutConfirmationService` → `FINANCE_RECIPIENT_MUST_BE_ADMIN`). These checks become "ADMIN, or the
  MANAGER of that row's project" for project-bound rows; handovers become ADMIN ↔ MANAGER transfers.
- The owner has **no** partner account: the owner's part is the remainder; money an ADMIN receives in
  person stays HOLDING as today.
- Stats: the two-admin DEBT card becomes a **partner accounts** list (one row per manager, live balance,
  drill-down by project and period). Monthly history is an aggregate over the same rows.

### 4.7 Projects where the manager himself is `seniorId` (owner-confirmed for Kostya)

On part of the 4 projects Kostya is `seniorId` and the client pays him directly — today the admin-owned
income path (`ADMIN_INCOME*`, no senior share). After his role changes, code that treats a non-ADMIN
`seniorId` as a senior would book him a senior IOU **on top of** his 50 %.

Rule: a project whose `seniorId` is its own `managerId` is **manager-owned**. Its income follows the
admin-owned path — no senior share, no senior IOU; the full amount (minus drop share, if any) is company
income for §4.2, and the money he receives counts as "held by him" in §4.6. Every check that today decides
"admin-owned" by `seniorId.role === 'ADMIN'` becomes "seniorId is an ADMIN, or is the project's MANAGER".
The term table (§4.2) gets an explicit row for this case, with a unit test proving no IOU is created.

## 5. RBAC: the MANAGER role

New value `MANAGER` in the `role` enum and every restated copy (`roleSchema`, inline literals in shared
schemas, `ALL_ROLES` / `ROUTE_ACCESS` on the web).

**Default-deny.** Many service methods branch on role with an `if / else if` chain and no final `else`
(e.g. `TransactionsService.findAll`: SENIOR / JUNIOR / HR / DROP branches, everyone else sees all rows).
A new role falls into "everyone else" — i.e. sees everything. Every such chain gets an explicit MANAGER
branch or an `else` that denies; `RolesGuard` is a no-op without `@Roles`, so the check lives in the
service. An integration test per list/read endpoint proves a MANAGER sees only his scope (incl. 403 cases).

**Scope.**

- **Projects:** `projects.managerId = me`. Nothing else — not "senior/drop in my team" (seniors and drops sit
  in separate team types, so team-based project scope would leak across managers).
- **People:** members of my teams ∪ the senior, drop and members (`project_members`) of my projects. This
  gives Kostya (no team) his 4 projects' people, and covers juniors, who are never in `team_members`.
- **Money:** a row is visible only when its snapshotted `managerId = me` (not the current project manager),
  so pre-December rows (snapshot null) and the previous manager's rows stay hidden. Plus his own partner
  account. Never general expenses, HR salaries, company account, dividends, other managers' rows.

| Action                                                     | ADMIN    | MANAGER                                                          |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| See / edit / archive users                                 | all      | people in scope                                                  |
| Create users                                               | any role | SENIOR, JUNIOR, HR, DROP; **not** ADMIN, MANAGER                 |
| Change a user's role                                       | any      | not to/from ADMIN, MANAGER                                       |
| Add a user to a team                                       | yes      | only to his own teams, only a user not in another manager's team |
| Edit / archive ADMIN or another MANAGER                    | yes      | **no**                                                           |
| Set manager share, `projects.managerId`, `teams.managerId` | yes      | **no**                                                           |
| Projects: create, edit, members, credentials               | all      | in scope; a project he creates gets `managerId = me`             |
| Initiate senior/drop share or junior salary change         | yes      | in scope, via the existing approval                              |
| Record receipts / handovers on his projects                | yes      | yes (§4.6)                                                       |
| Finance views, stats                                       | all      | his rows + his partner account                                   |
| Company account, dividends, admin summary                  | yes      | no                                                               |

**Assignment.** A team has one manager (`teams.managerId`). A new project of a team's senior/drop gets that
manager by default; ADMIN can change it. HR, when creating a senior or a team, picks the manager. Kostya is in
no team; his 4 projects carry `managerId = Kostya` directly.

Every check that reads `role === 'ADMIN'` / `!== 'ADMIN'` (~79 files) is audited into "ADMIN only",
"ADMIN or MANAGER-in-scope", or "MANAGER-specific", as a tracked checklist. Care: code that treats a
non-ADMIN `seniorId` as a senior (IOU booking) — see §4.7. Security-reviewer is mandatory (RBAC + finance).

## 6. Migration of Kostya (2026-12-01)

1. **No opening-balance row.** Kostya's legacy balance is computed live by the existing two-partner
   HOLDING/DEBT logic over rows with period ≤ 2026-11, whenever they are booked — so the November HR salary
   paid around 2026-12-05 still splits 50/50. Rows with period ≥ 2026-12 use only the new model. A row is in
   exactly one of the two, so nothing is counted twice.
2. `users.adminUntil` (date) = 2026-11-30 for Kostya. The legacy computation (`summary.service`,
   `balance.service`, the stats card) selects partners as `role = 'ADMIN' OR adminUntil IS NOT NULL` instead of
   live `role = 'ADMIN'`, so past reports keep him.
3. Kostya's role becomes `MANAGER`; `users.managerSharePercent = 50`; his 4 projects get `managerId = Kostya`
   and `managerSharePercentOverride = 50`.
4. Rows with period ≥ 2026-12 written before the deploy get their snapshot via a one-off fail-loud data step.
5. Prod DDL and data steps ship through the existing manual-staged SQL / `deploy.yml` path; the data step is
   reviewed by the owner (A3: prod data). The 4 project ids are supplied by the owner at migration time, not
   hardcoded.
6. The owner signs off the 2026-11-30 legacy figure once on the stats screen.

## 7. Repository and server access for a new manager

**GitHub.**

- The manager gets write access and may merge.
- `.github/CODEOWNERS` today starts with `* @yaremenko-maksym`, which would require the owner on every PR.
  That catch-all line is **removed** and replaced by explicit critical zones, then "Require review from
  Code Owners" is enabled:
  - `apps/api/src/{finance,auth,admin,users,approvals,credentials,common,projects,teams}/**`
  - `apps/api/src/database/**` (schema, migrations, manual SQL)
  - finance/RBAC schemas in `packages/shared/src/schemas/**`, `apps/web/app/lib/route-access.ts`
  - `.github/**`, `deploy/**`, `Dockerfile*`, `docker-compose*`, `.claude/**`, `CODEOWNERS`
- GitHub secrets and the `production` environment: owner only.
- **Residual risk.** CODEOWNERS restricts files, not behaviour: backend code merged without the owner runs in
  prod with full DB access. Mitigation: a CI check requiring owner approval when a PR outside the critical
  zones references finance tables/services (AST/grep over the diff). A short doc next to `CODEOWNERS` tells
  the manager what is protected and why.

**VPS.** A dedicated SSH user, no docker group, no sudo; a forced command / restricted shell exposes only
read-only log and status commands for the CRM services. No `.env`, DB or docker socket. Deploys stay
merge → CD. Provisioning is an owner-run runbook in `docs/runbooks/`.

## 8. Approaches considered

|       | Approach                                                               | Trade-off                                                                                                                                       | Verdict                                |
| ----- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **A** | Snapshot manager % on each relevant money row; balance derived on read | One source of truth, edits reflected, % change and reassignment not retroactive, negative months automatic; heavier query, needs the term table | **Chosen** (owner: "как рекомендуешь") |
| B     | Separate accrual ledger, one row per money event                       | Simple sum; must stay in sync with every edit/delete/cascade — drift risk in money                                                              | Rejected                               |
| C     | Monthly close job                                                      | Easy to wire; current month only provisional, contradicts "live"                                                                                | Rejected                               |

## 9. Constraints

- Finance + RBAC + prod data ⇒ critical-path zone: security-reviewer mandatory, A3 decisions to the owner.
- Product strings in `uk` + `en` via Lingui. Version pins unchanged; no new dependencies expected.
- `role` enum extension via `ALTER TYPE … ADD VALUE` through the existing manual SQL path.
- Doc durability: no line numbers in long-lived records.

## 10. Left to the builder

- Column/table names, `periodMonth` mechanics, balance query shape, UI of partner accounts and manager screens
  (design-gate applies).
- PR order (suggested): ACCOUNTANT removal (§13) → term table + enum + default-deny audit → scope helper → share storage/resolver/snapshot →
  expense attribution + salary allocation → receipts/handovers for MANAGER → partner balance + stats →
  migration → CODEOWNERS + CI check → VPS runbook.
- Tests: unit for resolver and the term maths (incl. negative month, no double count), integration for scope
  leaks and 403s per endpoint, E2E for manager flows.

## 11. Author's calls (owner, please check)

1. Period = `salaryMonth` or month of `txDate`; cutoff between legacy and new model by period.
2. No opening-balance row; legacy balance computed live for periods ≤ 2026-11.
3. `projects.managerId` is the only project scope; money visibility by the row's snapshotted `managerId`.
4. Only settled rows count toward net profit.
5. The owner has no partner account; HOLDING stays for ADMIN.
6. Settlement expense % = manager's user default at write time, editable by ADMIN.
7. Negative balance: warning on payout, not a block.
8. CODEOWNERS catch-all removed, explicit critical list instead.

## 12. Owner answers (2026-11-27)

- **Q1 — yes, Kostya is `seniorId` on part of the 4 projects.** See §4.7.
- **Q2 — one salary per junior**, no split between projects. See §4.4.
- **Q3 — remove the ACCOUNTANT role from the whole project.** See §13. A manager creates SENIOR, JUNIOR,
  HR, DROP.

## 13. Separate workstream: remove the ACCOUNTANT role

Owner decision: ACCOUNTANT is removed everywhere. It ships as its **own PR(s), before** the MANAGER
work, so the MANAGER RBAC audit does not have to reason about a role that sees all company finances.

1. Fact-find first (owner-run read-only SQL on prod): number of ACCOUNTANT users and every row that names
   one (transactions as sender/receiver/validator, salaries, audit, approvals, project members).
2. Owner decides per existing ACCOUNTANT user: archive, or change role (A3: prod data, RBAC).
3. Code: every ACCOUNTANT branch / literal is removed or folded into ADMIN (validation of income, expense
   entry, salary visibility, `privileged` checks, `ROUTE_ACCESS`, seed templates `ACCOUNTANT_CONTRACT`,
   i18n strings, E2E fixtures).
4. DB: Postgres cannot drop an enum value in place. The value stays in `role` (unused, rejected by Zod
   `roleSchema` and a CHECK / write-path guard) or the enum is recreated through the manual-staged SQL path —
   builder's call, reviewed by security-reviewer.
5. History rows that reference former ACCOUNTANT users stay intact; reports render the user as archived.
