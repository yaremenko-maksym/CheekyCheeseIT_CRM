# ACCOUNTANT role — design (2026-06-10)

> Status: DRAFT under owner review. Source — brainstorming session 2026-06-10.
> Series: `junior-ux-refactor`, `drop-role`, this one.

## 1. Context and goal

The accountant is the company's financial controller, sees everything (by design), but the UX is inefficient: empty dashboard, **no batch operations** (closes the company's debts one at a time), does not see their own payout history, flows are scattered.

**Goal — a control center:** an efficient financial command post with action queues and batch operations.

## 2. Principles

1. **Trusted controller.** The accountant sees everything (real financial data) — that is their job, we do NOT trim visibility.
2. **Not personas, but reality.** The accountant does not see legends (works with real data, not client-facing personas) — correct, we keep it.
3. **Efficiency.** "What requires action" queues, batch operations, context in dialogs.

## 3. Essence of the role (financial control)

- **Validation** of incomes: `SENIOR_INCOME` / `DROP_INCOME` (PENDING → VALIDATED/REJECTED), creates a payout_request + PAYOUT placeholder.
- **Payment confirmation:** cash (`confirmCashPayment`) · payout (`confirmPayout`, selecting the recipient admin + method/txHash).
- **Closing the company's debts** to seniors: `settleByCompany` → `SENIOR_INCOME` (PAID) + auto-invoice.
- **Financial summary/balances:** `getSummary` (income/expenses/net, drop and admin balances, monthly breakdown).
- **Invoices:** sees all (read), only the counterparty can sign.
- One per company, a **mandatory member of every team** (senior- and drop-team).

## 4. Visibility model (unchanged — trusted controller)

Sees everything: profiles (real contacts), all teams, all projects, all transactions, financial summary. **Does not see:** legends (correct — real data, not personas), `adminNote`/`fopPii` (passport PII — even the accountant does not see it).

- The accountant is visible to everyone as a team member. A junior sees the accountant's contact in the team (a potential contact for **financial** questions — unlike HR for work matters; see the junior refactor).

## 5. Target UX (control center)

### 🏠 Control center (refactor of the empty dashboard)

**Queues — what requires action (counter + jump):**

- For validation: N incomes PENDING → "Validate".
- Payouts awaiting confirmation: N `PAYOUT` PENDING_PAYMENT → "Confirm".
- Company debts: N obligations → "Close" (**batch**).
- Cash to be logged: N validated `DROP_INCOME` without a cascade → "Cash handed over".

**Summary:** total income/expenses/salaries/net · drop balances · admin balances · monthly breakdown.

### 💰 Finance (control + batch)

- Table of all transactions (filters/sort) — as it is now.
- **Batch operations:** multi-select for closing the company's debts (the main pain — currently one at a time).
- **Improved validation dialogs:** context of the original amount (where it came from), not only currency conversion.

### 👤 Profile

Their own + a **finance tab** (their own payout history — currently unavailable).

### 👥 Team / 📁 Projects / 📄 Documents

Context for control (secondary, remain as they are).

## 6. Data / RBAC

- **Batch settlement** endpoint: close an array of obligations in one call (atomically, with per-item result).
- **Queue aggregates** for the dashboard: counts (pending validations / payouts / company debts / cash-to-log) — a lightweight endpoint.
- **Finance tab in the accountant's self-profile:** add `finance` to `tabs` for ACCOUNTANT self in `getViewPermissions`.
- **Dynamic list of admins** in ConfirmPayout/LogCash (fix the hardcoded `MAKSYM_ID`/`KOSTYA_ID`).
- **Amount context** in ValidateDialog (source/history).
- Visibility unchanged (tests — the accountant sees everything except legends/passport-PII).

## 7. Rollout phases

1. **Backend.** Batch-settlement endpoint; dashboard aggregates (queues); dynamic admins; finance-tab permission for self; RBAC tests (visibility not broken).
2. **UX core.** Control center (dashboard with queues) + batch closing of debts in finance.
3. **UX cleanup.** Dialogs (validation context, dynamic admins, inline txHash validation), profile finance tab, small details.

## 8. Decisions (fixed)

1. **Visibility** — the accountant sees everything (trusted controller), unchanged.
2. **UX scope** — full control center (dashboard queues + batch + dialogs + own finance tab).

## 9. Out of scope

- Trimming the accountant's visibility.
- Legends (the accountant does not work with them).
- Report export (CSV/PDF) — a potential separate iteration.
- UX of other roles.
