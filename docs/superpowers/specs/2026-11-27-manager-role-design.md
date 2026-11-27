# MANAGER role, partner accounts and Kostya's exit from ADMIN — design

Date: 2026-11-27 · Status: draft, awaiting owner approval · Effective date of the business change: **2026-12-01**

## 1. Intent

From 2026-12-01 Kostya stops being an ADMIN and leaves the business. He keeps **50 % of the net profit
of the 4 current projects** and shares the costs that belong to those projects (currency conversion to
pay him, transfer fees, junior salaries on those projects). Every other company cost (general expenses,
HR salary) is the owner's (Maksym's) alone from December on.

To express that — and to onboard a new manager (Vladislav) who earns a share of the net profit of his own
projects — the CRM gains a new role **MANAGER**: a scoped "first-level admin" who runs the people and
projects of his own teams and earns a configurable share of each of his projects' net profit. The single
implicit "two admins, 50/50, DEBT = difference / 2" model is replaced by explicit **partner accounts**
with a live "who owes whom" balance per manager.

Why: today the 50/50 split exists nowhere in code (only as an assumption: HOLDING sums every
`role='ADMIN'` user, the stats card divides the difference by two). Simply changing Kostya's role would
drop his history out of the statistics and leave no place to record his ongoing share.

## 2. Goals

1. New role `MANAGER` with scoped admin rights (§5).
2. Per-project manager share of **net profit**, resolved PROJECT → TEAM → USER like the senior share,
   snapshotted on every money row so a later % change never rewrites history (§4).
3. Project-tagged expenses (conversion, transfer fees, other) separated from general company expenses (§4.3).
4. A live partner balance per manager: accrued share − payouts ± his part of joint costs ± money he holds (§4.5).
5. Kostya migrated to MANAGER on 2026-12-01 with his history and the existing balance preserved (§6).
6. A new manager can develop in the CRM repo and merge, with owner approval required only on
   critical zones; restricted read-only SSH on the prod VPS (§7).

## 3. Non-goals / anti-goals

- **Non-goal:** several managers on one project. One manager per project (owner-confirmed).
- **Non-goal:** automatic bank/crypto transfers to managers. Payouts are booked manually, as dividends are today.
- **Non-goal:** a manager changing his own share. Only ADMIN sets manager shares.
- **Anti-goal:** a manager seeing money that does not concern him — company expenses, the owner's
  income, another manager's income or projects. A leak here is a failure even if the maths is right.
- **Anti-goal:** a second ledger that can drift from `transactions` (this is why approach B was rejected).
- **Anti-goal:** Kostya being attached to new projects. He is bound directly to the 4 projects, never via a team.

## 4. Finance model

### 4.1 Net profit of a project

Per project, per period (calendar month, by the row's **period**, not its payment date):

```
net profit = senior income (company part)        # income − senior share
           − drop share                          # when the project has a DROP
           − junior salaries on the project
           − project expenses (conversion, transfer fees, other)
           − taxes on withdrawal attributable to the project
manager share = net profit × managerSharePercent  # may be negative
owner part    = net profit − manager share
```

A **negative** month is shared: the manager's balance goes down and is paid back from future accruals
(owner decision "делим убыток"). There is no floor at zero.

### 4.2 Share resolution and snapshot (approach A)

- Storage mirrors the senior share: `users.managerSharePercent` (user default), `teams.managerSharePercentOverride`,
  `projects.managerSharePercentOverride`; resolver `resolveManagerShare` with precedence PROJECT → TEAM → USER_DEFAULT,
  same shape as `resolveSeniorShare` (`apps/api/src/finance/senior-share-resolver.ts`).
- The project's manager is `projects.managerId` (nullable FK to a MANAGER user), one per project.
- Every project-attributable money row (senior income, drop share, junior SALARY, project EXPENSE, tax) gets
  three snapshot columns at write time: `managerId`, `managerSharePercent`, `managerSharePercentSource`
  — exactly as `transactions.seniorSharePercent` / `seniorSharePercentSource` are written today.
- Editing / soft-deleting a row keeps or drops its contribution automatically because the balance is
  derived from rows (§4.5). The paid-transaction edit cascade (`payoutRequestId` guard, monotonic
  `settled_amount`) is unchanged.
- Changing a manager share goes through ADMIN only. Changing senior share / drop share / junior salary of a
  manager's people goes through the **existing approval flow** (senior/drop confirms, `SENIOR_SHARE_ROUTES`);
  the manager may initiate it like an admin does today; no extra owner approval.

### 4.3 Expense attribution

`EXPENSE` rows today carry no `projectId` and the category lives in `receiverLabel`. New:

| Expense scope                                                                         | Fields                         | Effect                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| **General company**                                                                   | no `projectId`, no `managerId` | owner only, invisible to managers                                          |
| **Project**                                                                           | `projectId`                    | reduces that project's net profit → shared by its manager's %              |
| **Manager settlement** (conversion / fee to pay a manager, covering several projects) | `managerId`, no `projectId`    | split by the manager's **effective %** (see below), charged to his account |

A structured `expenseCategory` (enum: `CURRENCY_CONVERSION`, `TRANSFER_FEE`, `OTHER`, …) replaces free text for
new rows; `receiverLabel` stays for legacy rows.

Effective % for a manager-settlement expense: the share-weighted average over the projects the payout covers;
for Kostya (50 % everywhere) it is simply 50 %.

### 4.4 Taxes on withdrawal

The tax booked when money is withdrawn to pay a manager (today `DIVIDEND_TAX`, 6.5 %) is a project cost
(or manager-settlement cost, as in §4.3) and so is shared. **Legal check required** before go-live: a
payout to a non-shareholder manager may not legally be a dividend; the `legal` agent confirms which tax
type and rate applies. The code keeps the tax rate as data, not a constant.

### 4.5 Partner account and live balance

For each manager, computed on read from `transactions`:

```
balance (company owes manager, + ; manager owes company, −) =
    Σ manager share of every snapshotted project row
  − Σ his part of manager-settlement expenses
  − Σ payouts to him (new type MANAGER_PAYOUT)
  − Σ money he holds (income he received in person, not yet handed over)
  + Σ money he handed over (transfer to the owner / company account)
  + opening balance (migration row, §6)
```

- "Money he holds": Kostya keeps receiving senior payments on the 4 projects (owner-confirmed). The manager
  records such receipts himself, as admins do now (income with `receiverId = manager`); this generalises
  today's HOLDING to managers.
- The stats screen replaces the two-admin DEBT card with a **partner accounts** list: one row per manager,
  live balance, drill-down by project and month. The owner's part is the remainder; HOLDING/DEBT stop
  assuming exactly two ADMIN users.
- Monthly history is an aggregate query (a SQL view or a service method) over the same rows, not a stored table.

## 5. RBAC: the MANAGER role

New value `MANAGER` in the `role` enum and in every restated copy (`roleSchema`, inline literals in shared
schemas, `ALL_ROLES` / `ROUTE_ACCESS` on the web).

**Scope = the manager's teams.** A manager is a member of one or more teams (`team_members`). His
scope is: users who are members of those teams, projects whose senior/drop is in those teams, and projects
bound to him directly (`projects.managerId`). Implemented as a scope helper like `getHrScope`
(`apps/api/src/common/hr-access.service.ts`), applied in service bodies — `RolesGuard` is a no-op
without `@Roles`, so every list/read/write path must check scope in the service.

| Action                                              | ADMIN    | MANAGER                                                                                                             |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| See / edit / archive users                          | all      | only in his scope; a user he creates joins his team                                                                 |
| Create users                                        | any role | any role **except** ADMIN and MANAGER                                                                               |
| Edit / archive ADMIN or another MANAGER             | yes      | **no**                                                                                                              |
| Create a MANAGER, set a manager share               | yes      | **no**                                                                                                              |
| Projects: create, edit, assign members, credentials | all      | only in scope                                                                                                       |
| Teams: create / edit, choose the team's manager     | yes      | his own teams; cannot change the team's manager                                                                     |
| Initiate senior/drop share or junior salary change  | yes      | in scope, via the existing senior/drop approval                                                                     |
| Finance: transactions, salaries, expenses, stats    | all      | **only rows of his projects** + his partner account; never general expenses, the owner's or another manager's money |
| Company account, dividends, admin summary           | yes      | no                                                                                                                  |

**Assignment.** A team has one manager (`teams.managerId`). Projects of the team's seniors/drops get that
manager by default (`projects.managerId` set at creation, editable by ADMIN). HR, when creating a senior or a
team, picks the manager. Kostya is in no team; his 4 projects carry `managerId = Kostya` directly.

Every admin-only check that today reads `role === 'ADMIN'` (~79 files) is audited: each becomes
"ADMIN", "ADMIN or MANAGER-in-scope", or stays ADMIN-only. The audit is a tracked checklist in the plan.
Security-reviewer is mandatory (RBAC + finance).

## 6. Migration of Kostya (2026-12-01)

1. Before the cutoff, the stats show the current HOLDING/DEBT between the two admins as of 2026-11-30.
2. Kostya's role becomes `MANAGER`. Rows before 2026-12-01 stay as they are; reports for past periods keep
   showing him as an admin of that time (reports read the role/flags from the period, not from today's role).
3. An **opening balance** row on his partner account carries the 2026-11-30 balance (no manual settlement).
4. His 4 projects get `managerId = Kostya`, `managerSharePercentOverride = 50`.
5. Cutoff by **period**: rows whose period is November or earlier are split 50/50 as before, even if paid
   in December (example: the November HR salary paid around 2026-12-05). Rows with period December or later
   follow the new model — general expenses and HR salary are the owner's only.
6. Prod DDL and the data step ship through `deploy.yml` / manual-staged SQL as the project already does; the
   data step is fail-loud SQL reviewed by the owner (A3: prod data).

The 4 project ids are fixed by the owner at migration time (read from prod by the owner, not hardcoded in
the repo).

## 7. Repository and server access for a new manager

**GitHub.**

- The manager gets write access and may merge.
- `CODEOWNERS` requires the owner's review on critical zones:
  - `apps/api/src/{finance,auth,admin,users,approvals,credentials,common}/**`
  - `apps/api/src/database/**` (schema, migrations, manual SQL)
  - finance/RBAC schemas in `packages/shared/src/schemas/**`
  - `.github/**`, `deploy/**`, `Dockerfile*`, `docker-compose*`
  - `.claude/**`, `CODEOWNERS` itself
- Branch protection: "Require review from Code Owners". GitHub secrets and the `production` environment
  are restricted to the owner.
- **Residual risk (accepted mitigation).** CODEOWNERS restricts files, not behaviour. Any backend code
  merged without the owner runs in prod with full DB access. Mitigation: a CI check that requires owner
  approval when a PR outside the critical zones adds a reference to finance tables / services (grep/AST
  over the diff).
- The rule doc for the manager (what is protected, why) lives next to `CODEOWNERS`, so he rarely needs
  to ask.

**VPS.** A dedicated SSH user with no docker group and no sudo. A forced-command / restricted shell exposes
only read-only log and status commands for the CRM services. No access to `.env`, the DB, or the docker
socket. Deploys stay merge → CD. Provisioning is an owner-run runbook (`docs/runbooks/`), since only the
owner has prod SSH.

## 8. Approaches considered

|       | Approach                                                              | Trade-off                                                                                                                                                 | Verdict                                |
| ----- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **A** | Snapshot manager % on each project money row; balance derived on read | One source of truth, edits/deletes reflected, % change not retroactive, negative months automatic; heavier balance query, monthly view needs an aggregate | **Chosen** (owner: "как рекомендуешь") |
| B     | Separate accrual ledger, one row per money event                      | Simple balance sum; must be kept in sync with every edit/delete/cascade — drift risk in money                                                             | Rejected                               |
| C     | Monthly close job writes one accrual per project-month                | Easiest to wire; current month only provisional, post-close corrections need adjustment entries; contradicts "live"                                       | Rejected                               |

## 9. Constraints

- Finance + RBAC + prod data ⇒ critical-path zone: security-reviewer mandatory, A3 decisions to the owner.
- Product strings in `uk` + `en` via Lingui; no Russian in the product.
- Version pins unchanged; no new dependencies expected.
- `role` enum extension is an `ALTER TYPE … ADD VALUE` through the existing manual SQL path.
- Doc durability: no line numbers in long-lived records.

## 10. Left to the builder

- Exact column/table names, the expense-category enum values beyond the three above, the balance query
  shape (view vs service), UI layout of the partner-accounts card and manager screens (design-gate applies).
- Task split into PRs (suggested order: enum + scope helper → share storage/resolver/snapshot → expense
  attribution → partner balance + stats → RBAC audit of admin checks → migration → CODEOWNERS/CI check → VPS runbook).
- Test strategy per PR (unit for resolver/maths, integration for scope leaks incl. 403 cases, E2E for manager flows).
