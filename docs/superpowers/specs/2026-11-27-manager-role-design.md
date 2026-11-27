# MANAGER role, partner accounts and Kostya's exit from ADMIN — design

Date: 2026-11-27 · Status: draft r5 (after builder check + second-opinion rounds 1–3), awaiting owner approval ·
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
   snapshotted on the rows that make up net profit, so a later % change or reassignment never rewrites
   history (§4).
3. Project-tagged expenses separated from general company expenses (§4.5).
4. A live partner balance per manager (§4.6).
5. Kostya migrated to MANAGER on 2026-12-01 with his history and the existing balance preserved (§6).
6. A new manager can develop in the CRM repo and merge, with owner approval required only on critical
   zones; restricted read-only SSH on the prod VPS (§7).
7. The ACCOUNTANT role is removed from the product (§13, separate workstream, first).

## 3. Non-goals / anti-goals

- **Non-goal:** several managers on one project. One manager per project (owner-confirmed).
- **Non-goal:** automatic bank/crypto transfers. Payouts are booked manually.
- **Non-goal:** a manager changing his own share, his project's manager, or a team's manager. ADMIN only.
- **Anti-goal:** a manager seeing money that does not concern him — company expenses, the owner's income,
  another manager's projects, rows from before he managed the project. A leak is a failure even if the
  maths is right.
- **Anti-goal:** a second ledger that can drift from `transactions` (why approach B was rejected).
- **Anti-goal:** Kostya being attached to new projects. He is bound directly to the 4 projects, never via a team.
- **Anti-goal:** counting one unit of money twice (income and its payout / IOU rows; legacy and new balance).

## 4. Finance model

The model has **two layers that never mix**:

- **Profit layer (accrual)** — what the manager has _earned_: his % of each project's net profit.
- **Cash layer (HOLDING)** — what the manager has _in hand_: money that passed through him, the same
  received − spent formula the CRM already uses for admins.

**Balance = earned − in hand** (§4.6). Payouts, IOUs, handovers and settlements are cash movements; they
never enter the profit layer, which is why nothing is counted twice.

### 4.1 Period

`transactions` has no period column. Period = **`salaryMonth`** for SALARY rows, otherwise the calendar
month of **`txDate`** (Europe/Kyiv), exposed as one derived `periodMonth` (builder decides: generated
column or expression) so cutoff and monthly aggregates share one definition.

### 4.2 Profit layer: what a manager earns

Every profit-layer row carries a signed **profit effect** and its own snapshotted `managerSharePercent` (§4.3).
Per manager, per period:

```
earned (profit part) = Σ profit effect × row's managerSharePercent    # may be negative
profit effect of an income row        = + gross × (1 − senior% − drop%)   # company take
profit effect of a project expense    = − amount
profit effect of a junior salary row  = − amount                          # attributed by §4.4
owner part = Σ profit effect − manager's part
```

Income, project expense and junior salary rows are the **only** profit-layer rows. Net profit of a project (for
reports) is the same sum restricted to rows of that project; junior salaries are attributed to a manager, not to a
project (§4.4), so they show on the manager's report, not on a project line.

- **Client income is counted once, at its income row** (`SENIOR_INCOME`, `DROP_INCOME`, `ADMIN_INCOME*`).
  Today the rows do **not** all carry both percentages: `SENIOR_INCOME` stores the senior %, `DROP_INCOME`
  stores only the drop %, and `ADMIN_INCOME` stores neither (its senior/drop cuts live only on the IOUs it
  creates). Rule: from 2026-12 every income writer snapshots **both** `seniorSharePercent` and `dropSharePercent`
  on the income row (0 when there is no senior/drop cut), computed by the same resolvers that size the IOUs, so
  the row alone gives the company take. A unit test per income path asserts that gross × (1 − senior% − drop%)
  equals gross minus the IOU amounts that path creates.
- **Settlement rows are never income.** Settling a senior IOU flips it in place into a `SENIOR_INCOME` row with a
  nulled share (`pending-settlement-tx.util`). Any row referenced by `pending_obligations.closingTransactionId`
  is excluded from the profit layer, the same test `summary.service` already uses for HOLDING. Payout rows
  (`PAYOUT`, `PAYOUT_DROP`, `PAYOUT_CONFIRMED`) and IOUs (`SENIOR_PENDING_PAYOUT`, `DROP_PENDING_PAYOUT`) are
  **cash**, never profit. This removes every dependency on how payouts are batched (a senior payout batch can
  span projects and carries one `projectId`), on IOU status, and on drop-batch arithmetic.
- An income row counts from the moment it is **accepted** (validated by ADMIN, or created by ADMIN /
  the project's MANAGER) and stops counting if rejected or soft-deleted. The exact status set is fixed in the
  first plan task from `transaction-status` and the validation flow, and tested.
- **Manager-owned projects** (§4.7): senior% = 0 on their income rows, so company take = gross × (1 − drop%).
  The admin-owned income path rejects drop routing today, so in practice drop% = 0 there too; if drop routing is
  ever enabled on that path, the both-percentages rule above already covers it.
- Junior salary and project expense rows count when booked (not when paid), with the same accepted /
  not-deleted rule.
- Rows that never enter the profit layer: dividends, `DIVIDEND_TAX`, `COMPANY_DEPOSIT`, HR salaries, general
  expenses, manager-settlement expenses (§4.5, charged directly in §4.6), legacy `PAYOUT_ADMIN`.

A **negative** month is shared: earned goes down and is recovered from future months (owner decision). No
floor. A payout while the balance is negative shows a warning, is not blocked.

### 4.3 Share resolution and snapshot (approach A)

- Storage mirrors the senior share: `users.managerSharePercent` (user default), `teams.managerSharePercentOverride`,
  `projects.managerSharePercentOverride`; `resolveManagerShare` with precedence PROJECT → TEAM → USER_DEFAULT,
  same shape as `resolveSeniorShare`.
- A project's manager is **`projects.managerId`** — the single source of truth. `teams.managerId` only
  supplies the default when a project is created.
- Every **profit-layer** row (income, junior salary, project expense) and every manager-settlement expense gets
  three snapshot columns at write time: `managerId`, `managerSharePercent`, `managerSharePercentSource` — as
  `seniorSharePercent` / `seniorSharePercentSource` are written today. Reassigning a project later does **not**
  move old rows.
- **Re-snapshot rule:** an edit that changes a row's `projectId` or moves its `periodMonth` across the
  2026-12 cutoff recomputes the snapshot (and the audit log records old and new). Any other edit keeps it.
  The paid-transaction edit cascade (`payoutRequestId` guard, monotonic `settled_amount`) is otherwise
  unchanged.
- Manager share changes: ADMIN only. For people in a manager's scope the manager acts as an ADMIN does today
  (owner: "as it works now", no owner approval): a **senior share** change goes through the existing approval
  (`SENIOR_SHARE_ROUTES`, the senior confirms); **drop share** and **junior salary** have no approval flow today
  (`changeSalary` writes `monthlySalary` directly), so the manager changes them directly, audited. No new
  approval routes are built.

### 4.4 Junior salary

Today the salary cron writes **one** SALARY row per junior, with the `projectId` of the first active
membership in query order (`salary.service`, `seenReceiverIds`); manual `createSalary` writes no `projectId`.

Owner decision: **the salary belongs to the employee and is paid once a month, whatever the project.** It is
not split and not charged to a project. A SALARY row is attributed to a **manager**, not a project:

- At write time the row snapshots `managerId` = the manager of the junior's active projects in that salary month,
  when they all have the same manager (Kostya's 4 projects: Kostya), and `managerSharePercent` = that manager's
  user default (Kostya: 50).
- Projects with different managers, or with none: the snapshot is empty (owner-only cost) until ADMIN sets the
  manager and % on the row (audited).
- The existing `projectId` on cron rows stays as information only; it is not used for attribution.

### 4.4a Cash received after the cutoff for income before it

Legacy is cash-based (HOLDING), the new model is accrual-based (§4.2). Money that reaches a partner in December
or later for income whose period is ≤ 2026-11 (a `PAYOUT_CONFIRMED` is dated at confirmation; an IOU settled in
December for November income) would otherwise land in the new `in hand` with no matching `earned`, so the
manager would owe all of it instead of half. Rule: a cash row that settles a specific income (through
`payoutRequestId` / `pending_obligations` / the payout's source income) takes the **period of that income** for
the legacy/new split; a cash row with no such link uses its own period. The builder lists every linking path and
tests each across the cutoff. The rule applies to both partners, so the frozen legacy figure (§6) includes them.

### 4.5 Expense attribution

| Expense scope                                                    | Fields                         | Effect                                                         |
| ---------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| **General company**                                              | no `projectId`, no `managerId` | owner only, invisible to managers                              |
| **Project**                                                      | `projectId`                    | profit layer: reduces that project's net profit                |
| **Manager settlement** (conversion / fee / tax to pay a manager) | `managerId`, no `projectId`    | charged to his earned amount at the row's snapshotted % (§4.6) |

`expenseCategory` enum (`CURRENCY_CONVERSION`, `TRANSFER_FEE`, `TAX`, `OTHER`, …) for new rows; `receiverLabel`
stays for legacy rows. A settlement row snapshots one `managerSharePercent` at write time = the manager's user
default (Kostya: 50, set in §6), editable by ADMIN on the row. No weighted average.

A payout to a manager is an **ordinary transfer** `MANAGER_PAYOUT` (owner decision), not a dividend — no
automatic tax. Any tax or fee for that payment is a separate settlement expense. When `MANAGER_PAYOUT` or a
settlement expense is paid from the company wallet, it debits the company-account ledger
(`company-account-balance`) like other outgoing types — that type list is extended.

### 4.6 Partner account and live balance

Positive = the company owes the manager. For periods ≥ 2026-12:

```
earned  = Σ profit effect × % over profit-layer rows snapshotted to him (§4.2)
        − Σ (manager-settlement expense × its %)
in hand = HOLDING(him) = Σ money received by him − Σ money paid by him
          (received: client money he took in person, MANAGER_PAYOUT and other transfers to him;
           paid: expenses, salaries and IOUs he paid from that money or his own pocket, handovers to the owner)
balance = legacy balance (§6, Kostya only) + earned − in hand
```

- No term appears in both `earned` and `in hand`, and every cash movement appears exactly once in `in hand`:
  a handover lowers `in hand` (raises the balance), a payout raises it, a cost he pays from his own pocket
  lowers it (the company owes him the full amount; his % of a project cost is already in `earned`).
- `in hand` reuses the legacy HOLDING formula (`summary.service`), parameterised by user and by period range
  instead of hard-coded `role = 'ADMIN'`, and **extended**: its received set gains `MANAGER_PAYOUT` and
  ADMIN → MANAGER transfers, its paid set gains MANAGER → ADMIN handovers and the manager-paid salary / IOU /
  expense rows. A test per type proves each moves `in hand` once, with the right sign.
- **Currency.** HOLDING today converts every row at today's NBU rate, so a balance over non-USD rows drifts with
  the rate. `earned` and `in hand` use the same conversion rule, so the drift partly cancels; the builder
  evaluates converting at the row's `txDate` rate instead (author's call, §11). The legacy figure (§6) is stored
  as a USD number at sign-off, not recomputed.
- **Write paths a manager needs, only for rows on his projects or salary rows attributed to him:** record client money he received, hand money
  over to the owner, pay a junior salary / IOU / project expense from his own pocket. Today these are
  ADMIN-only (`ADMIN_INCOME` receiver, `ADMIN_TRANSFER` both sides, `PayoutConfirmationService` →
  `FINANCE_RECIPIENT_MUST_BE_ADMIN`, salary payer must be ADMIN, IOU payer must be ADMIN, expense entry
  ADMIN/ACCOUNTANT). Each becomes "ADMIN, or the MANAGER of that row's project"; handovers become
  ADMIN ↔ MANAGER transfers.
- The owner has **no** partner account: the owner's part is the remainder; money an ADMIN receives in person
  stays HOLDING as today.
- Stats: the two-admin DEBT card becomes a **partner accounts** list (one row per manager: earned, in hand,
  balance; drill-down by project and period).

### 4.7 Projects where the manager himself is `seniorId` (owner-confirmed for Kostya)

On part of the 4 projects Kostya is `seniorId` and the client pays him directly — today the admin-owned income
path (`ADMIN_INCOME*`, no senior share). After his role changes, code that treats a non-ADMIN `seniorId` as a
senior would book him a senior IOU **on top of** his 50 %.

Rule: a project whose `seniorId` is its own `managerId` is **manager-owned**. Its income follows the admin-owned
path — senior% = 0, no senior IOU; the money he receives is in his `in hand`. Every check that today decides
"admin-owned" by `seniorId.role === 'ADMIN'` becomes "seniorId is an ADMIN, or is the project's MANAGER". A unit
test proves no IOU is created and company take = gross × (1 − drop%).

## 5. RBAC: the MANAGER role

New value `MANAGER` in the `role` enum and every restated copy (`roleSchema`, inline literals in shared
schemas, `ALL_ROLES` / `ROUTE_ACCESS` on the web).

**Two gates, both audited.**

1. **Controller gate.** Endpoints with `@Roles('ADMIN')` refuse MANAGER before the service runs. Each one the
   manager needs gets `@Roles('ADMIN', 'MANAGER')` plus a service-level scope check; the rest stay ADMIN-only.
2. **Service gate (default-deny).** `RolesGuard` lets through any endpoint **without** `@Roles`, and many service
   methods branch on role with an `if / else if` chain and no final `else` (e.g. `TransactionsService.findAll`:
   SENIOR / JUNIOR / HR / DROP branches, everyone else sees all rows; `balance.service` `getTotalEarned` switches
   on role and returns 0 for an unknown one). A new role falls into "everyone else". Every such chain gets an
   explicit MANAGER branch or an `else` that denies.

An integration test per list/read endpoint proves a MANAGER sees only his scope (incl. 403 cases).

**Scope.**

- **Projects:** `projects.managerId = me`. Nothing else — not "senior/drop in my team" (seniors and drops sit in
  separate team types, so team-based project scope would leak across managers).
- **People (read):** active members (`leftAt IS NULL`) of my teams ∪ the senior, drop and active members
  (`project_members.leftAt IS NULL`) of my projects. This gives Kostya (no team) his 4 projects' people and covers
  juniors, who are never in `team_members`.
- **People (write: edit, archive, user-level defaults like `seniorSharePercent`, `monthlySalary`):** only a user
  who is **exclusively** mine — every active project and team of that user is in my scope. A person shared with
  another manager's or the owner's project: the manager may change only project-level values on his own
  projects. **Archive** additionally refuses when the cascade in `user-archive.service` (archiving a SENIOR
  archives his team and active projects) would touch anything outside my scope. Kostya has no team, so archiving
  a senior of his projects (whose senior team is not his) is refused and goes to ADMIN — intended.
- **Money:** a row is visible only when it has period ≥ 2026-12 **and** either its snapshotted `managerId = me`
  (income, salary and expense rows carry the snapshot, §4.3) or he is its sender or receiver; plus his own partner
  account. All pre-December rows stay hidden, including the ones where Kostya was sender or receiver as ADMIN
  (general expenses, HR salaries he paid); he sees his legacy figure as one number. Never general expenses, HR
  salaries, company account, dividends, other managers' rows.

| Action                                                            | ADMIN                                         | MANAGER                                                           |
| ----------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| See users                                                         | all                                           | people in scope (read)                                            |
| Edit / archive users, user-level defaults                         | all                                           | exclusively-mine users; archive cascade must stay in scope        |
| Create users                                                      | any role                                      | SENIOR, JUNIOR, HR, DROP; **not** ADMIN, MANAGER                  |
| Change a user's role                                              | any                                           | not to/from ADMIN, MANAGER; exclusively-mine users only           |
| Add a user to a team                                              | yes                                           | only to his own teams, only a user **he created** (others: ADMIN) |
| Edit / archive another MANAGER                                    | yes                                           | **no**                                                            |
| Edit / archive another ADMIN                                      | no (`CANNOT_ARCHIVE_ANOTHER_ADMIN`, as today) | **no**                                                            |
| Set manager share, `projects.managerId`, change `teams.managerId` | yes                                           | **no**                                                            |
| Set `teams.managerId` when creating a senior or a team            | yes                                           | only himself (HR: may pick any manager, owner decision)           |
| Projects: create, edit, members, credentials                      | all                                           | in scope; a project he creates gets `managerId = me`              |
| Senior share / drop share / junior salary change                  | yes                                           | in scope, as today (§4.3)                                         |
| Cash write paths on his projects (§4.6)                           | yes                                           | yes                                                               |
| Finance views, stats                                              | all                                           | his rows + his partner account                                    |
| Company account, dividends, admin summary                         | yes                                           | no                                                                |

**Assignment.** A team has one manager (`teams.managerId`). A new project of a team's senior/drop gets that
manager by default; ADMIN can change it. HR, when creating a senior or a team, picks the manager (once, at
creation; changing it later is ADMIN only). Kostya is in no team; his 4 projects carry `managerId = Kostya`
directly.

Every check that reads `role === 'ADMIN'` / `!== 'ADMIN'` (~79 files) and every `@Roles(...)` is audited into
"ADMIN only", "ADMIN or MANAGER-in-scope", or "MANAGER-specific", as a tracked checklist. Security-reviewer is
mandatory (RBAC + finance).

## 6. Migration of Kostya (2026-12-01)

1. **No opening-balance row.** Kostya's legacy balance = the existing two-partner HOLDING/DEBT logic computed
   over rows with **period ≤ 2026-11 only**, whenever they are booked (the November HR salary paid around
   2026-12-05 still splits 50/50). The new model (§4.6) covers rows with **period ≥ 2026-12 only**. Every row is
   in exactly one of the two by its `periodMonth` (cash rows: by the period of the income they settle, §4.4a), so
   nothing is counted twice.
2. `users.adminUntil` (date) = 2026-11-30 for Kostya. The legacy computation (`summary.service`, `balance.service`,
   the stats card) selects partners as `role = 'ADMIN' OR adminUntil IS NOT NULL`. The DEBT card is
   `|HOLDING(A) − HOLDING(B)| / 2`, so restricting only Kostya's rows would let the owner's December rows keep
   moving the legacy debt: the legacy computation restricts **both** partners' rows to period ≤ 2026-11. The
   owner's own HOLDING after the cutoff is shown separately and is not part of any debt. Historical per-user views
   (`getTotalEarned` etc.) use the same rule, so Kostya's past earnings stay visible to ADMIN.
3. **Company pool at the cutoff (owner Q4: "carry the pool over, only his role changes").** The company-account
   balance carries over unchanged. No settlement row, no split, no opening entry: only Kostya's role changes.
   Legacy HOLDING never included the pool, and the new model does not touch it.
4. Kostya's role becomes `MANAGER`; `users.managerSharePercent = 50`; his 4 projects get `managerId = Kostya` and
   `managerSharePercentOverride = 50`.
5. Rows with period ≥ 2026-12 written before the deploy get their snapshot via a one-off fail-loud data step.
6. Prod DDL and data steps ship through the existing manual-staged SQL / `deploy.yml` path; the data step is
   reviewed by the owner (A3: prod data). The 4 project ids are supplied by the owner at migration time, not
   hardcoded.
7. The owner signs off the 2026-11-30 legacy figure once on the stats screen. Cash that later settles pre-cutoff
   income (§4.4a) adjusts it; each adjustment is listed under the figure.

## 7. Repository and server access for a new manager

**GitHub.**

- The manager gets write access and may merge.
- `.github/CODEOWNERS` today starts with `* @yaremenko-maksym`, which would require the owner on every PR. That
  catch-all line is **removed** and replaced by explicit critical zones, then "Require review from Code Owners"
  is enabled:
  - `apps/api/src/{finance,auth,admin,users,approvals,credentials,common,projects,teams,audit,invoices,config,contracts,documents}/**`,
    `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
  - `apps/api/src/database/**` and `apps/api/drizzle/**` (schema, migrations, `manual`, `manual-private` prod SQL)
  - finance/RBAC schemas in `packages/shared/src/schemas/**`, `apps/web/app/lib/route-access.ts`
  - `.github/**`, `Dockerfile*`, `docker-compose*`, `scripts/**`, `.claude/**`, `CODEOWNERS`
  - `package.json` files, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (supply chain), `.husky/**` (git hooks)

  The builder verifies each path exists and adds any deploy-related path found in `deploy.yml`.

- GitHub secrets and the `production` environment: owner only.
- **Residual risk.** CODEOWNERS restricts files, not behaviour: backend code merged without the owner runs in prod
  with full DB access. Mitigation: a CI check requiring owner approval when a PR outside the critical zones
  imports the DB client, a finance table/service, or adds a new controller. A short doc next to `CODEOWNERS` tells
  the manager what is protected and why.

**VPS.** A dedicated SSH user, no docker group, no sudo; a forced command / restricted shell exposes only read-only
log and status commands for the CRM services. No `.env`, DB or docker socket. Deploys stay merge → CD. Provisioning
is an owner-run runbook in `docs/runbooks/`.

## 8. Approaches considered

|       | Approach                                                                    | Trade-off                                                                                                                 | Verdict                                |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **A** | Snapshot manager % on profit-layer rows; earned and in-hand derived on read | One source of truth, edits reflected, % change and reassignment not retroactive, negative months automatic; heavier query | **Chosen** (owner: "как рекомендуешь") |
| B     | Separate accrual ledger, one row per money event                            | Simple sum; must stay in sync with every edit/delete/cascade — drift risk in money                                        | Rejected                               |
| C     | Monthly close job                                                           | Easy to wire; current month only provisional, contradicts "live"                                                          | Rejected                               |

## 9. Constraints

- Finance + RBAC + prod data ⇒ critical-path zone: security-reviewer mandatory, A3 decisions to the owner.
- Product strings in `uk` + `en` via Lingui. Version pins unchanged; no new dependencies expected.
- `role` enum extension via `ALTER TYPE … ADD VALUE` through the existing manual SQL path.
- Doc durability: no line numbers in long-lived records.

## 10. Left to the builder

- Column/table names, `periodMonth` mechanics, query shapes, UI of partner accounts and manager screens
  (design-gate applies).
- PR order (suggested): ACCOUNTANT removal (§13) → enum + controller/service gate audit → scope helper →
  share storage/resolver/snapshot + both-percentages on income rows + profit layer → expense attribution +
  salary-to-manager attribution → manager cash write
  paths + `in hand` → partner accounts + stats → migration → CODEOWNERS + CI check → VPS runbook.
- Tests: unit for resolver and profit maths (negative month, manager-owned project, no double count between
  layers and across the cutoff, settlement rows excluded, cash for pre-cutoff income), integration for scope leaks, archive cascade and 403s per endpoint, E2E for
  manager flows.

## 11. Author's calls (owner, please check)

1. Period = `salaryMonth` or month of `txDate`; legacy vs new model split strictly by period.
2. Profit counted at the income row (accrual), not at payout; payouts/IOUs are cash only.
3. Balance = earned − in hand; `in hand` is the existing HOLDING formula for the manager.
4. `projects.managerId` is the only project scope; money visibility by the row's snapshotted `managerId`.
5. A manager edits / archives only people who are exclusively his.
6. The owner has no partner account; HOLDING stays for ADMIN.
7. Settlement expense % = manager's user default at write time, editable by ADMIN.
8. Negative balance: warning on payout, not a block.
9. CODEOWNERS catch-all removed, explicit critical list instead.
10. Junior salary attributed to the manager of all the junior's projects; mixed or none = owner-only until ADMIN
    sets it (§4.4).
11. A cash row that settles a pre-cutoff income belongs to the legacy side (§4.4a).
12. A manager adds to his team only users he created; others go through ADMIN.
13. Drop share and junior salary: manager changes them directly, as an ADMIN does today; no new approval routes.
14. Currency: same conversion for `earned` and `in hand`; txDate-rate conversion left to the builder to evaluate.

## 12. Owner answers and open questions

- **Q1 — yes, Kostya is `seniorId` on part of the 4 projects.** See §4.7.
- **Q2 — the salary belongs to the employee**, paid once a month whatever the project. See §4.4.
- **Q3 — remove the ACCOUNTANT role from the whole project.** See §13. A manager creates SENIOR, JUNIOR, HR, DROP.
- **Q4 — carry the company pool over, only Kostya's role changes.** See §6.3.

## 13. Separate workstream: remove the ACCOUNTANT role

Owner decision: ACCOUNTANT is removed everywhere. It ships as its **own PR(s), before** the MANAGER work, so the
MANAGER RBAC audit does not have to reason about a role that sees all company finances.

1. Fact-find first (owner-run read-only SQL on prod): number of ACCOUNTANT users (active and archived) and every
   row that names one (transactions as sender/receiver/validator, salaries, audit, approvals, project members).
2. Owner decides per ACCOUNTANT user — **including archived ones** — the new role (A3: prod data, RBAC). A
   fail-loud data step changes them and asserts 0 users with role ACCOUNTANT before the code change ships,
   so no `.parse()` of a stored user can meet the removed value.
3. Code: every ACCOUNTANT branch / literal is removed or folded into ADMIN (income validation, expense entry,
   salary visibility, `privileged` checks, `ROUTE_ACCESS`, seed template `ACCOUNTANT_CONTRACT`, i18n strings,
   E2E fixtures).
4. DB: Postgres cannot drop an enum value in place. The value stays in `role` unused (rejected by Zod
   `roleSchema` and guarded on write) or the enum is recreated through the manual-staged SQL path — builder's
   call, reviewed by security-reviewer.
5. History rows that reference former ACCOUNTANT users stay intact.
