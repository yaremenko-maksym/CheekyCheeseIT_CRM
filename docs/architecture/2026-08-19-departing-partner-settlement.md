# ADR: Settlement with a departing partner (backlog 135)

**Date:** 2026-08-19 · **Author:** Architect (ad-hoc dispatch) · **Reconciliation base:** `origin/main` = `beb9aad2`

## Status

**Deferred by the owner's decision (2026-08-19).** Nothing is implemented and will not be
implemented for now — the admin/partner departure logic remains as is, the current four guards blocking
the archiving of an active ADMIN are deemed sufficient protection for now. The document is kept as a
ready starting point: return to it when the "deactivate a partner" function is actually
needed, instead of analyzing it anew. The five open questions below remain
relevant at that point.

---

## Context

### AC1. Reconciliation of the backlog's claims with the code (facts, not memory)

| Claim (backlog 135 / security-review #564)                                    | Verdict                                              | Proof at `beb9aad2`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending_obligations` has exactly two writers                                 | **CONFIRMED**                                        | `grep insert(pendingObligations)` outside the specs → exactly 2 matches: `transactions.service.ts:4498` and `:4542`                                                                                                                                                                                                                                                                                                                        |
| Both — inside `bookCompanyObligations`                                        | **CONFIRMED**                                        | the method is declared at `:4434`, both inserts are in its body                                                                                                                                                                                                                                                                                                                                                                            |
| Both set the debtor to `senior.id` or `drop.id`                               | **CLARIFICATION**                                    | the debtor in the row is `debtorType: 'COMPANY'`, `debtorUserId: null`. `senior.id` / `drop.id` go into **`creditorUserId`**. The essence is the same (there is no third party), but the wording in the backlog is inverted — when implementing, it is important not to start looking for the admin in `debtor_user_id`                                                                                                                    |
| The senior branch explicitly excludes the admin                               | **CONFIRMED**                                        | `if (senior && senior.role !== 'ADMIN')`, `transactions.service.ts:4472`                                                                                                                                                                                                                                                                                                                                                                   |
| The "admin as senior" configuration is really supported                       | **CONFIRMED and wider than in the record**           | `projects.service.ts:170-186` — a whole `task-admin-as-senior` block (masking the link to the admin-senior's profile). `createProject` does **not check** the role of `seniorId` at all (it only checks `dropId`, `:729`). By memory about prod — the active projects WebLab / GeeksForLess / GO7 have senior = Maksym (ADMIN)                                                                                                             |
| `PAYOUT_ADMIN` is no longer created by anyone in prod — "only seed and tests" | **CONFIRMED, the record is slightly outdated**       | `type: 'PAYOUT_ADMIN'` does not appear in any non-spec file; **it is also no longer in `seed.ts`** (grep empty). Only 3 inserts remain in `transactions.get-summary.spec.ts`. The absence of an auto-split is locked in by the test `payout-no-admin-split.integration.spec.ts`                                                                                                                                                            |
| The list of five paths is complete                                            | **CONFIRMED**                                        | `createAdminIncome` `:1789`, `declareUsdtProjectIncome` `:2026`, `confirmPayout` `:3361`, `createAdminTransfer` `:3827`, `createDividend` `company-account.service.ts:717`. There is no sixth path addressing money to an ADMIN recipient                                                                                                                                                                                                  |
| An archived ADMIN does not exist today (4 locks)                              | **CONFIRMED**                                        | self-archiving — `users.controller.ts:384`; an admin archiving an admin — `users.service.ts:1070`; promotion to ADMIN — `:976`; a role change of an admin — `:994`/`:999`                                                                                                                                                                                                                                                                  |
| A departed senior still has **two** settlement paths                          | **CONFIRMED, with a clarification of which exactly** | reachable by an operator: (1) `settleByCompany` (two entry points — by obligation id and by source transaction id), (2) `manualConfirmPayout` (ADMIN/ACCOUNTANT). The third path from the `archived-entitlement.ts` docblock — `payPayoutRequest` — is **structurally unreachable** for an archived user: it requires a caller with the SENIOR/DROP role (`:4134`), and an archived user does not pass authentication (`jwt.guard.ts:276`) |
| A departed admin — has neither a row nor a path                               | **CONFIRMED and worse**                              | see AC2: there is no row, no path, and **the amount itself does not exist either** — in the code there are three non-matching definitions of it, and the one actually used by the owner is not computed at all                                                                                                                                                                                                                             |

**Nothing in the record is substantively outdated.** The three clarifications above (creditor vs debtor, seed, which
exactly the third unreachable path is) are wording fixes, not a change of conclusion.

### AC2. What the departing partner's share consists of

The partner's share — not one number, but three different ones, and none of them is a row in the DB.

**(a) HOLDING — how much of the company's money the partner holds in hand.**
`getSummary.adminBalances` (`transactions.service.ts:5322-5352`):
`received − sent`, where
`received` = PAID rows with `receiver_id = admin` and type ∈ {`PAYOUT_ADMIN` (legacy, no live writer),
`ADMIN_INCOME` with `funding_source ≠ 'COMPANY_ACCOUNT'`, `ADMIN_TRANSFER`, `PAYOUT_CONFIRMED`};
`sent` = **all** PAID rows with `sender_id = admin`, of any type.
There is no filter by `archivedAt` here — deliberately (`:5306`, "departure ≠ automatic zero-out").
A positive HOLDING means the partner **holds** the company's money, not that the company owes them.

**(b) DEBT — equalizing holdings between partners 50/50.**
`DEBT = (HOLDING_A − HOLDING_B) / 2`; the one with the larger HOLDING pays.
**This formula does not exist in the code at all** — not in the API, not in the schema, not in the DTO (`grep -i debt` over finance gives
only the drop's `debtToCompany`). It exists only in the owner's spreadsheet
(memory `project_accounting_migration`: HOLDING Maksym 78,238.34 / Kostia 93,205.82 → DEBT 7,483.74).
**This number is exactly the "settlement with a departing partner"**, and the system does not know it.

**(c) The share in the company account — an indivisible pool.**
`computeCompanyAccountBalanceFromLedger` (`company-account-balance.ts:21-28`) — 8 terms, one scalar.
There is no "admin's share" column in `users` (there is only `senior_share_percent` / `drop_share_percent`).
50/50 — an agreement, not data. The account spec explicitly fixes the mode: **"Free withdrawal, accounting
after the fact"** — the admin withdraws an arbitrary amount of dividends, there is no "available to withdraw" gate
(`docs/business/2026-06-17-company-account-spec.md:23,42`). That is, the system **deliberately** does not model
the partner's right to the pool.

**Three readers of the "admin's balance" give three different numbers — and the code already knows this:**

| Reader                                         | Formula                                                                             | Dividends       | Discrepancy                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `getSummary.adminBalances`                     | `PAYOUT_ADMIN + ADMIN_INCOME(≠pool) + ADMIN_TRANSFER + PAYOUT_CONFIRMED − ALL sent` | **not counted** | by `receiver_id`                                                         |
| `BalanceService.getAdminBalance`               | `ADMIN_INCOME(≠pool) + DIVIDEND_TO_ADMIN − PAID EXPENSE`                            | counted         | by `recipient_id ?? receiver_id`                                         |
| `BalanceService.getTotalEarned` (ADMIN branch) | `PAYOUT_ADMIN + DIVIDEND_TO_ADMIN + ADMIN_INCOME_CASH/CRYPTO`                       | counted         | `ADMIN_INCOME` **not** counted; two of the four types were never emitted |

The comment at `transactions.service.ts:5175-5186` in plain text: "Reconciling the two MODELS into one
number is a separate, not-yet-scoped decision". Until this decision is made, **any automatic
settlement will pick one of the three numbers silently**.

**Where it diverges from the senior and the drop:**

|                         | SENIOR                                             | DROP                                          | ADMIN (partner)                         |
| ----------------------- | -------------------------------------------------- | --------------------------------------------- | --------------------------------------- |
| The debt row on accrual | `pending_obligations` + `SENIOR_PENDING_PAYOUT`    | `pending_obligations` + `DROP_PENDING_PAYOUT` | **none** (`senior.role !== 'ADMIN'`)    |
| The amount              | fixed in the row (`amount`), the share snapshotted | the same                                      | derived, three non-matching definitions |
| The moment of fixing    | on income arrival                                  | on income arrival                             | never                                   |
| The settlement path     | `settleByCompany`, `manualConfirmPayout`           | the same                                      | **none**                                |
| What archiving sees     | the PENDING list (per the 2026-08-18 decision)     | the same                                      | `{ noDependencies: true }`              |
| The direction           | always "the company owes"                          | always "the company owes"                     | **either of the two**                   |

**Two things not named in the backlog that change the design:**

1. **The settlement is bidirectional.** The departing partner may owe the company (if their HOLDING is higher) —
   in prod today this is exactly so for Kostia. `pending_obligations` **cannot** express "a user
   owes the company": `creditor_user_id NOT NULL` (`schema.ts:1262`), and the company has no row in `users`;
   the `debtor_type` enum (`:143-148`) describes only the debtor, but not the creditor-company. That is,
   "just create an obligation like a senior's" covers only half the cases.
2. **Half of the settlement is already open, and from the wrong side.** The guards close only the incoming payment
   to an archived user. The departure **from** an archived user is not closed deliberately (`:3805-3811`) — and `ACCOUNTANT` can
   carry out an `ADMIN_TRANSFER` with an explicit `senderId` of another admin (`:3778`, BIZ-06 forbids this only
   to an ADMIN caller). Neither `settleByCompany` nor `paySalary` check `archivedAt` of the
   `payerAdminId` (`pending-settlement.service.ts:396`, `transactions.service.ts:6406`).
   The practical conclusion: **the "partner pays" direction works today without a single edit**, while
   the "partner is paid" direction is fully closed. An additional side effect: the remaining
   partners can draw down the departed one's HOLDING by appointing them the payer of others' salaries and obligations.

**Another trap nearby, the same root.** The cascade archiving branches on `user.role`
(`users.service.ts:1078` — the `SENIOR` branch), while project ownership lives in `projects.senior_id`, which
does not check the role. In the "admin as senior" configuration these two keys diverge: archiving a partner
will not touch their active projects at all, and the owner's rule of 2026-08-19 ("a senior cannot be removed
one at a time — the team and the projects at once") will not apply to them. On prod this is not hypothetical —
the active projects belong to the admin.

---

## Decision (AC3) — the proposed approach

### The principle — the same as in the owner's decision of 2026-08-18

The salary decision distinguishes **not by the state of the person, but by the origin of the row**:
what is created — is earned and remains payable; new rows are created only by an active one.

The partner has no row. Therefore a mechanism of the same design is **not a new way to pay
an archived user**, but **the moment at which the row appears**: the settlement row is created **in the archiving
transaction**, that is, while the person is still active. Then it behaves exactly like a senior's IOU: it remains,
remains payable, is shown in the modal, is closed by the existing path. After archiving no new
rows are created — all five guards remain in place.

### Option 1 (recommended) — "a settlement row on archiving", the money goes through the existing channels

**What is created.** One row in a new table `partner_settlements`:
`user_id`, `direction` (`COMPANY_OWES` | `PARTNER_OWES`), `amount`, `currency`,
`basis` (text — what the owner settled on: HOLDING/DEBT/agreement), snapshots of the three numbers at the moment of
archiving (`holding_snapshot`, `counterpart_holding_snapshot`, `pool_snapshot` — as a reference, not as a
source of the amount), `created_by`, `created_at`, `settled_amount`, `closed_at`, `status`
(`OPEN` | `SETTLED` | `WRITTEN_OFF`).

**Why a separate table and not `pending_obligations`.** Obligations are one-directional
(`creditor_user_id NOT NULL`, the company-creditor is inexpressible), while the settlement is bidirectional. Plus any new
row in `pending_obligations` requires a paired transaction-row (`source_transaction_id NOT NULL`), that is,
a new transaction type — see option 3, why that is expensive.

**The amount is entered by the owner, the system does not compute it.** The three numbers diverge, and the one in effect (DEBT) is
not computed at all; to pick one silently is to hardcode a business rule that does not exist. The modal
shows all three as a reference and **requires entering the amount and the basis**. This is discretion — but
**a one-time one, at the moment of departure, with a live partner, fixed by an immutable row with an author**,
not a channel open forever (which was the subject of the concern in #564).

**Who and when.** The same ADMIN who performs the archiving, in the same transaction: the amount and the basis →
the `partner_settlements` row → `archived_at`. Atomically (otherwise the state "archived without
settlement" is possible, which no branch provides for). Amount = 0 → the row is not created (symmetry with
"no PENDING → no modal").

**How it is settled — without a single new money path:**

- `COMPANY_OWES`, the share from the pool → **`DIVIDEND_TO_ADMIN`**. This is already the current and only channel
  of the partner's share (`payout-no-admin-split.integration.spec.ts`: "Admin income is now a deliberate
  manual flow (DIVIDEND_TO_ADMIN)"). It already has: a term in the account formula, an advisory-lock,
  the "do not drive the account negative" gate, a mandatory check, idempotency.
- `COMPANY_OWES`, the equalization of holdings → **`ADMIN_TRANSFER`** from the remaining partner. The company account
  is not involved (there is no `ADMIN_TRANSFER` term in the 8-term formula — `company-account-balance.ts:348`),
  which is arithmetically correct: this is a shift between holdings.
- `PARTNER_OWES` → **`ADMIN_TRANSFER` with the `senderId` of the departed one**, filed by ACCOUNTANT. **Works
  already today**, nothing to fix.

**What changes in the guards — exactly two, and not by removing a row:**

```
// was
if (receiver.archivedAt) throw new BadRequestException(...)
// becomes
if (receiver.archivedAt && !hasOpenSettlementBudget(receiver.id, amount)) throw ...
```

Only in `createDividend` (`company-account.service.ts:717`) and `createAdminTransfer`
(`transactions.service.ts:3827`). The other three (`createAdminIncome`, `declareUsdtProjectIncome`,
`confirmPayout`) are **not touched**: there the reason is different — "an active party is needed for the posting", not
"it is forbidden to pay" (this distinction is already fixed in the code at `:3679-3685`).

The settlement row — not a flag, but a **budget**: the sum of the allowed payouts cannot exceed `amount`; on
exhaustion `status → SETTLED` and the guard closes again by itself. No row → the behavior is byte-for-byte
today's.

**What archiving does (the modal).** The ADMIN branch of `getArchiveImpact` (`users.service.ts:1473`) today
returns `{ noDependencies: true }`, and the dialog prints **"No related entities"**
(`ArchiveConfirmDialog.tsx:248`) — for a departing partner this is untrue. The branch is extended to the same
set of sections as the modal from `task-archive-pending-modal` (AC8): (1) unsettled PENDING,
(2) active projects/teams under the cascade — **including projects where the partner is the `senior_id`**,
(3) a new settlement section: the three reference numbers + the mandatory fields "amount" and "basis".
Cancel does not archive and does not create a row.

**The joint with the cascade (the owner's decision 2026-08-19).** The branching by role must be replaced/supplemented
with branching by the fact of ownership: "there are active `projects.senior_id = user.id`" → a cascade of the team and
projects, in one operation, regardless of whether the role is `SENIOR` or `ADMIN`. Juniors and HR on these
projects, per the decision of 2026-08-19, are **not touched** — their `archivedAt` does not change, accruals go
as usual. For a partner this is all the more important: their projects are the most populated.

**Confidence.** HIGH — that the mechanism reproduces the design of the 2026-08-18 decision and does not open
a discretionary channel. HIGH — that `DIVIDEND_TO_ADMIN` / `ADMIN_TRANSFER` cover both sides without
a new type. **LOW — on the way of obtaining the amount**: this is a business decision (see the open questions), and
until the owner chooses, it cannot be automated.

---

## Consequences (AC4) — what breaks in each option

### Option 1 (recommended) — how it is **worse** than the others

- **Requires human input.** The amount cannot be computed by a button; if the owner makes a mistake in the field,
  the system will let the error through — there is no arithmetic protection (the senior has it: the share is snapshotted).
  Mitigation: the three reference numbers alongside + `basis` mandatory + the row is immutable (an edit = a cancel
  and a new row with a reference to the previous one).
- **A new table** — a migration + a prod DDL (only via `deploy.yml`, there is no SSH to the VPS) + a new "unsettled
  settlements" screen, otherwise the row becomes an invisible debt. Option 2 requires neither.
- **Weakens two guards that are now absolute.** An absolute guard cannot be bypassed by an error in the
  condition; a conditional one — can. `hasOpenSettlementBudget` becomes a money gate with all the
  consequences (TOCTOU: the check and the debit must be in one transaction under the same
  advisory-lock as the other account debits — otherwise two parallel withdrawals will eat
  one budget twice).
- **The atomicity of archiving becomes more complex**: archiving + the settlement row + the project cascade = one
  transaction. Now archiving is already a transaction, but the partner cascade is not yet in it.
- **Does not resolve the three-reader discrepancy** — only works around it, showing all three. The discrepancy
  will remain and will surface in the first dispute "why is there one figure here and another there".

### Option 2 — "archiving is forbidden until the settlement is reduced to zero"

The partner settles **while remaining active** (ordinary `DIVIDEND_TO_ADMIN` / `ADMIN_TRANSFER`, without
a single edit), and only then is archived. One gate in `archive` is needed.

- **What breaks:** access is revoked **last**, not first. The departing partner all this time
  sees all the finances, all the projects, the whole team and can carry out operations — including transferring money
  to themselves. This is exactly the scenario for which the deactivation was needed, and a conflicting departure may
  last months.
- "Zero" is mechanically unreachable: HOLDING is a derivative of **all** the sent rows, it moves
  from any operation of the partner. The "archive at zero" gate will turn into a race with the partner itself.
- Does not answer the question "which of the three numbers equals zero".
- **Good in that:** zero new machinery, not one guard is weakened, it is implemented in one PR. This is
  a reasonable **temporary** answer if the deactivation is needed earlier than the owner chooses the amount model.

### Option 3 — a new transaction type `PARTNER_SETTLEMENT_PENDING` + `pending_obligations`

Maximum symmetry with the senior: an IOU-row + an obligation + settlement via `settleByCompany`.

- **What breaks:** `settleByCompany` parses the source type into two cases, and "everything else"
  falls into the senior branch (`pending-settlement.service.ts:305,309`) — the partner payout will become
  `SENIOR_INCOME` and **will trigger `autoCreateForSeniorPayout`**, that is, generate a signable
  senior invoice for a partner payout. A third branch is needed.
- The company account formula — a **9th term**, otherwise the payout from the pool will not be debited from the pool
  (phantom money, the same class of defect that was already fixed in `computeCompanyAccountBalanceFromLedger`).
- The new type must be carried through **every** aggregate by hand. A precedent in this very file:
  `getAdminBalance` for years summed types that nobody emits and silently returned 0
  (`balance.service.ts:123-140`) — the compiler catches only the `Record<TransactionType, string>` in the UI,
  but not the formulas.
- The bidirectionality is still not expressed: `creditor_user_id NOT NULL`.
- **Good in that:** one obligation model for all, one "company debts" screen, zero new tables.

### Option 4 (an anti-option) — just remove the guard

This is what will happen **by default** if the decision is not made: the author of the deactivation will run into
"The recipient is archived — dividends are not paid out", remove the row (or add `|| isPartnerPayout`)
and get: a discretionary payout to any archived admin, of any amount, at any moment, without a basis
and without a trace — all while the archived admin does not log into the system and cannot confirm receipt.
Exactly the outcome for the prevention of which the comments were written in both points of the guard.

---

## Open owner decisions (needed before implementation)

1. **Where does the amount come from?** (a) the owner enters it, the three numbers — a reference [recommended];
   (b) the system computes DEBT = `(H_other − H_leaving)/2` and offers it as a default value;
   (c) the amount = the share in the pool + the equalization, computed automatically.
   (b)/(c) require first reducing the three balance readers to one — a separate task.
2. **Who has the right to archive a partner?** Today — no one (4 locks). Keep the mutual
   invulnerability and require the confirmation of both? Allow one? Allow only by the departing one's
   self-initiation?
3. **The partner-senior's projects on departure** — a cascade like a senior's (by ownership, not by role) or
   transferring the projects to another senior as a separate step before archiving?
4. **Temporary option 2 now, option 1 later** — or option 1 right away?
5. **What about `payerAdminId` without an archived check** (the remaining partners can draw down the departed one's
   HOLDING by appointing them the payer of others' obligations) — close it with a separate small PR
   independently of the choice above?

---

## AC5. A check on prod — read-only SQL for the owner, then STOP

I did not connect to `crm_db`. Below — **read-only** queries; the owner runs them, implementation
begins after their answer.

```sql
-- (0) Where we connected. Run it FIRST and verify with your eyes.
SELECT current_database(), version();

-- (1) There should be no archived ADMINs (expectation: 0 rows).
SELECT id, display_name, archived_at FROM users WHERE role = 'ADMIN' AND archived_at IS NOT NULL;

-- (2) The currencies in the rows participating in HOLDING. If there is anything here except USD/USDT,
--     query (3) is NOT equal to the application formula (it converts by NBU) — read with a correction.
SELECT t.currency, count(*), sum(t.amount)
FROM non_deleted_transactions t
JOIN users u ON u.role = 'ADMIN' AND (u.id = t.receiver_id OR u.id = t.sender_id)
WHERE t.status = 'PAID'
GROUP BY t.currency ORDER BY 2 DESC;

-- (3) Each partner's HOLDING by the getSummary.adminBalances formula (#311).
WITH a AS (SELECT id, display_name FROM users WHERE role = 'ADMIN'),
recv AS (
  SELECT a.id, COALESCE(SUM(t.amount), 0) AS received
  FROM a LEFT JOIN non_deleted_transactions t
    ON t.receiver_id = a.id AND t.status = 'PAID'
   AND (t.type IN ('PAYOUT_ADMIN', 'ADMIN_TRANSFER', 'PAYOUT_CONFIRMED')
        OR (t.type = 'ADMIN_INCOME' AND t.funding_source IS DISTINCT FROM 'COMPANY_ACCOUNT'))
  GROUP BY a.id),
sent AS (
  SELECT a.id, COALESCE(SUM(t.amount), 0) AS sent
  FROM a LEFT JOIN non_deleted_transactions t
    ON t.sender_id = a.id AND t.status = 'PAID'
  GROUP BY a.id)
SELECT a.display_name, recv.received, sent.sent, (recv.received - sent.sent) AS holding
FROM a JOIN recv ON recv.id = a.id JOIN sent ON sent.id = a.id
ORDER BY holding DESC;

-- (4) DEBT = (H_larger - H_smaller)/2. Who owes whom as of today.
--     Compute from the result of (3) by hand: two partners are easier to reconcile by eye
--     than to hide in a CTE, which would silently give a wrong number with three admins.

-- (5) The second definition of the same number — how much it diverges from (3).
--     getAdminBalance: ADMIN_INCOME(≠pool) + DIVIDEND_TO_ADMIN − PAID EXPENSE(sender=admin)
SELECT u.display_name,
  COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'ADMIN_INCOME'
        AND t.funding_source IS DISTINCT FROM 'COMPANY_ACCOUNT'
        AND COALESCE(t.recipient_id, t.receiver_id) = u.id), 0)
+ COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'DIVIDEND_TO_ADMIN'
        AND COALESCE(t.recipient_id, t.receiver_id) = u.id), 0)
- COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'EXPENSE' AND t.sender_id = u.id), 0)
  AS balance_service_number
FROM users u LEFT JOIN non_deleted_transactions t ON t.status = 'PAID'
WHERE u.role = 'ADMIN' GROUP BY u.id, u.display_name;

-- (6) The company account balance (8 terms) — the value from which the share in the pool is taken.
SELECT
   COALESCE(SUM(amount) FILTER (WHERE type = 'COMPANY_DEPOSIT'), 0)
 + COALESCE(SUM(amount) FILTER (WHERE type = 'PAYOUT'        AND funding_source = 'COMPANY_ACCOUNT'), 0)
 + COALESCE(SUM(amount) FILTER (WHERE type = 'ADMIN_INCOME'  AND funding_source = 'COMPANY_ACCOUNT'), 0)
 - COALESCE(SUM(amount) FILTER (WHERE type = 'DIVIDEND_TO_ADMIN'), 0)
 - COALESCE(SUM(amount) FILTER (WHERE type = 'SALARY'        AND funding_source = 'COMPANY_ACCOUNT'), 0)
 - COALESCE(SUM(amount) FILTER (WHERE type = 'EXPENSE'       AND funding_source = 'COMPANY_ACCOUNT'), 0)
 - COALESCE(SUM(amount) FILTER (WHERE type = 'SENIOR_INCOME' AND funding_source = 'COMPANY_ACCOUNT'), 0)
 - COALESCE(SUM(amount) FILTER (WHERE type = 'PAYOUT_DROP'   AND funding_source = 'COMPANY_ACCOUNT'), 0)
 AS company_account_usdt
FROM non_deleted_transactions WHERE status = 'PAID' AND currency = 'USDT';

-- (7) How many projects will hang: active projects whose senior is an ADMIN.
SELECT u.display_name AS admin_senior, count(*) AS active_projects
FROM projects p JOIN users u ON u.id = p.senior_id
WHERE p.archived_at IS NULL AND u.role = 'ADMIN'
GROUP BY u.display_name;

-- (8) Live PENDING obligations and whether the creditor is already archived.
SELECT po.status, po.debtor_type, u.role, u.display_name,
       u.archived_at IS NOT NULL AS creditor_archived,
       count(*), sum(po.amount::numeric)
FROM pending_obligations po JOIN users u ON u.id = po.creditor_user_id
WHERE po.status = 'PENDING'
GROUP BY 1, 2, 3, 4, 5 ORDER BY 7 DESC;

-- (9) Legacy PAYOUT_ADMIN in prod (no live writer; rows may have remained from the import).
SELECT count(*), sum(amount) FROM non_deleted_transactions WHERE type = 'PAYOUT_ADMIN';
```

**STOP.** Further — only after the answers to "Open owner decisions". Implementation in a separate
pass, as a separate task.

---

## Rollback

The document executes nothing; the rollback = deleting the file:

```bash
git rm docs/architecture/2026-08-19-departing-partner-settlement.md
git commit -m "revert(architect): drop departing-partner ADR"
# expected state: git status clean, the file is not in docs/architecture/,
# the code behavior did not change at any step (check: git diff origin/main -- apps/ packages/ empty)
```

For the future implementation (not now) the rollback is split by layers: the guards (`git revert` of the commit with
the condition — the guard returns to absolute) → the modal → the table (`DROP TABLE partner_settlements`,
by that time there are 0..N rows of data, each with an author and a basis).

---

## Sources

- `apps/api/src/finance/transactions.service.ts` — `bookCompanyObligations` `:4434`/`:4472`/`:4498`/`:4542`; the guards `:1789`, `:2026`, `:3361`, `:3685`, `:3827`; HOLDING `:5290-5352`, the absence of the archived filter `:5306`; the model discrepancy `:5175-5186`; BIZ-06 `:3778`; `payerAdminId` `:6402-6407`; `payPayoutRequest` RBAC `:4134`
- `apps/api/src/finance/company-account.service.ts:664-718` — dividends, the guard and its docblock
- `apps/api/src/finance/company-account-balance.ts:20-29,348` — 8 terms, the absence of the `ADMIN_TRANSFER` term
- `apps/api/src/finance/balance.service.ts:113-215,300-446` — the second and third readers
- `apps/api/src/finance/pending-settlement.service.ts:198-262,300-400,741-995` — the lists, the type parsing, the flip
- `apps/api/src/users/archived-entitlement.ts` — the boundary "a new right vs settling what is earned"
- `apps/api/src/users/users.service.ts:1058-1170,1365-1473`, `users.controller.ts:378-401` — archiving, cascade, `ArchiveImpact`
- `apps/api/src/database/schema.ts:67-100,143-153,1257-1297` — transaction types, the debtor enum, `pending_obligations`
- `apps/api/src/auth/jwt.guard.ts:248-281` — an archived user does not authenticate
- `apps/web/app/components/users/ArchiveConfirmDialog.tsx:246-249` — "No related entities"
- `apps/api/src/finance/payout-no-admin-split.integration.spec.ts:30-40` — the partner's share = a manual `DIVIDEND_TO_ADMIN`
- `.claude/tasks/task-archive-pending-modal.md` — the owner's decisions 2026-08-18 and 2026-08-19
- `docs/business/2026-06-17-company-account-spec.md:23,42,71` — free dividend withdrawal, accounting after the fact, 50/50
- Memory `project_accounting_migration` — the owner's model: HOLDING = received − spent; DEBT = (difference)/2
