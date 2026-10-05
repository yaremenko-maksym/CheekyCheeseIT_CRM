# DROP role — design (2026-06-10)

> Status: DRAFT under owner review. Source — brainstorming session 2026-06-10.
> In parallel with `2026-06-10-junior-ux-refactor-design.md`.

## 1. Context and goal

The drop is a narrow payment-routing role. Currently: 3 sections (Profile/Team/Finance), no hub, the balance aggregate is hidden (DropBalanceCard — ADMIN only), **sees ALL teams instead of their own single one (a bug)**, no list of drop projects, risk of a dead-link in the payment flow.

**Goal — a routing-centric hub** + a full financial cabinet for the drop + correct visibility.

## 2. Principles

1. **Routing-centricity.** The drop's home is the payment hub.
2. **Compartmentalization around the junior.** The inner circle (drop + senior + HR + accountant) see each other and coordinate; the junior is isolated, sees a "senior" persona, the drop does not exist for them.
3. The drop sees **only their own**; full **financial transparency** for themselves.

## 3. Essence of the role (payment routing)

The client pays the drop → the drop registers `DROP_INCOME` → the accountant validates → the drop initiates the payment to the company (crypto: the drop sends txHashes; cash: the accountant confirms) → distribution: the senior's share (`seniorSharePercent`, default 26%) + **the drop's share** (`dropSharePercent`, default 5%) + the ADMIN/partners split (the remaining 50/50). The drop keeps their own share; the senior's share is settled separately by the company (`settleByCompany`).

## 4. Visibility model (decided)

|                                                                               | Drop sees                           |
| ----------------------------------------------------------------------------- | ----------------------------------- |
| Their drop projects (`dropId=self`)                                           | ✓                                   |
| Their drop-team (senior / HR / accountant, **real** contacts — coordination)  | ✓                                   |
| Their finances (full cabinet)                                                 | ✓                                   |
| Legends                                                                       | ✗ (subject excluded, like a senior) |
| Juniors                                                                       | ✗                                   |
| Others' drops / profiles / teams                                              | ✗                                   |

- **Senior ↔ drop: see each other** (drop-team, coordinate directly).
- **The junior does not see the drop** — sees a "senior" persona (legend); the word "drop" does not exist in the junior's world.
- **Fix:** `teams` for DROP currently returns all teams → only their own single drop-team.

## 5. Target UX (4 sections)

`My routing · Finance · Team · Profile`

### 🏠 My routing (hub; replaces the absent dashboard)

- **Balance card:** my share (accumulated) · rate % · in progress (N incomes) · company debt.
- **Requires action:** validated incomes → "Pay the company" button; stalled steps.
- **My drop projects:** company · senior · number of incomes.
- **Quick actions:** "Register an income" · "Pay the company".

### 💰 Finance (full cabinet)

- Balance/share breakdown.
- Incomes: a `pending → validated → paid` feed with filters (type/status/period).
- Company debt · payment statuses.
- Actions: register an income · initiate a crypto payment (confirm txHashes).

### 👥 Team (their own single drop-team)

Senior · HR(s) · accountant with real contacts — for coordination. Read-only (the roster is maintained by ADMIN/HR).

### 👤 Profile

Their own data, requisites (wallets — critical for routing), their own contract/onboarding.

## 6. Data / RBAC

- **Own-team fix:** `TeamsService.findAll` for DROP → only the team where they are the owner (currently does not filter).
- **Drop-facing aggregate:** balance/share/company-debt for self — a drop version of DropBalanceCard / a `getSummary`-like self-only endpoint (`GET /api/balances/drop/me` or a filter in the existing one). Only their own aggregate, not others' drops.
- **Payment-flow route** `/crm/payments/initiate/:incomeId` — verify it is accessible to the drop and not a dead-link.
- **Unification** of the two "register an income" entry points (finance page + profile finance tab).
- **Backend tests:** DROP sees only their own team (403/filter), aggregate — self only, payment RBAC (`resolveIncome`: only their own income).

## 7. Rollout phases

1. **Backend.** Fix the own-team filter; drop-facing aggregate (balance/share/debt self-only); check/fix the payment route; RBAC tests.
2. **UX core.** The "My routing" hub + the full "Finance" cabinet.
3. **UX cleanup.** "Team" (their own single one), Profile, unification of the income buttons.

## 8. Decisions (fixed)

1. **Drop ↔ senior** — see each other (coordinate directly, drop-team with real contacts).
2. **The drop's financial layout** — full cabinet (balance/share, incomes, company debt, statuses).
3. **UX scope** — full routing hub (dashboard + cabinet + actions + team).

## 9. Out of scope

- Changes to the legend system (the drop does not work with them; the legend is junior-facing, maintained in the junior refactor).
- UX of other roles (except that the drop is hidden from the junior — in the junior refactor).
