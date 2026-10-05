# task-cascade-apply

## Agent: coder

## Status: ready

## Blockers: none (tasks 0/1/2/4 are in `main` — #598, #599, #603, #600)

## Priority: critical

## Model: opus

Justification per `rules/common/model-routing.md`: financial calculation logic + company account +
cross-module (balance formula ↔ settle ↔ cascade ↔ invoices). An error "to the plus" on this path is
caught by no gate.

## Depends on

Task 3 from the decomposition of `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md`.
The exact constructive decisions are in the addendum `docs/architecture/2026-08-23-cascade-apply-ledger-term.md`
(**read in full before the first edit**; below are references to its sections like "addendum 1.4").

## Branch: feature/cascade-apply

---

## Context

The core of the cascade: the first thing that actually writes money. BIZ-18 is lifted **only for `amount`**,
derivatives are recomputed, paid ones return to `PENDING`, and — most important — a ninth term is added to the
company account balance formula, without which the status rollback **inflates the balance by the
already paid amount** and lets the system spend what does not exist.

Everything this is built from is already in `main`: the snapshot columns (#599), the pure resolver + preview
(#603), invoice voiding (#600, the method `voidAndReissueInvoiceForAmountEdit` is **written and has not a
single caller** — wiring it up is part of this task).

---

## Concrete changes

1. `packages/shared/src/schemas/edit-cascade.ts`
   - `CascadeObligationSnapshot` — add `currency: CurrencyEnum` (addendum 3.5, backlog item 95).
   - `CascadeSourceSnapshot` — add `settledAmount: number | null` and
     `hasClosedObligation: boolean` (AC13: the editable row may itself be a closed
     obligation).
   - `cascadeWarningCodeSchema` — add `'OBLIGATION_CURRENCY_MISMATCH'`.
   - `resolveDerivative` — when `derivative.obligation && derivative.obligation.currency !== sourceCurrency`
     add this warning. `newAmount` is **computed as usual** in that case (the number is correct in
     itself, only writing it into a foreign currency would be wrong — it blocks application,
     see item 3).
2. `packages/shared/src/schemas/finance.ts` — `adminUpdateTransactionSchema` (`:1248`): add
   `cascadeVersion: z.string().min(1).optional()`.
3. `apps/api/src/finance/transactions.service.ts`
   - `loadCascadeSnapshot` (`:3209`) — pass `currency: obligation.currency` into
     `CascadeObligationSnapshot`; fill in the source's `settledAmount` / `hasClosedObligation`,
     extending the **existing** obligations query to `source_transaction_id = sourceId`
     (do not introduce a second round-trip); accept an optional `forUpdate` flag, with which the rows
     of `pending_obligations` and `transactions` are read `SELECT … FOR UPDATE` with `ORDER BY id`
     (the order and the reason — addendum 1.9). The query shape stays ONE for both entry points (AC4 ADR).
   - `adminUpdateTransaction` (`:2935`) — narrow BIZ-18 (`:3004`) to
     `currencyChanged || salaryMonthChanged`; add three new refusals based on the edited
     row itself (AC13); add the cascade application branch (see AC2–AC8, AC15).
   - A new private method `applyEditCascade(dbtx, snapshot, plan, actor)` — all the writing of
     derivatives, so that it can be covered by a unit double.
4. `apps/api/src/finance/company-account-balance.ts`
   - a new constant `COMPANY_TERM_TYPES_PENDING_SETTLED = ['SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT']`,
     **used both by the term and by the watchdog** (one constant, no second copy — backlog item 85);
   - a new helper `sumSettledAmount` next to `sumAmount` (`:142`);
   - a ninth term in `sumLedgerTerms` (`:267`) and a **minus** in the returned expression (`:360`);
   - an OR branch in `assertNoOffCurrencyCompanyRows` (`:228`) + a fix of the text of
     `CompanyAccountOffCurrencyError` (it stops being only about `PAID`).
5. `apps/api/src/finance/pending-settlement.service.ts`
   - `resolveSource` (`:1234` area) — add `sourceSettledAmount: source.settledAmount`
     and `sourceFundingSource: source.fundingSource` (AC14);
   - the funding source check — **next to** the existing check
     `sourceSettledCurrency !== currency` (`:806`), of the same form (AC14);
   - SENIOR top-up: `owedNow` instead of `parseFloat(obligation.amount)` in `settledAmountThisSettle`
     (`:771`) and in the money gate (`:892`); in the `WHERE` of the flip (`:917` area) add
     `settled_amount IS NOT DISTINCT FROM <the value read>` (TOCTOU without a new lock —
     a zero row count is already handled by the existing `if (!paidRow) throw`);
   - DROP top-up: a loud refusal when `settled_amount > 0` (addendum 1.11). Duplicated by a refusal on
     the cascade side (AC15), so that a row does not end up rolled back into a state with no
     exit: here — the last line of defense, there — a timely one;
   - `owedNow === 0` — a regular closure, `owedNow < 0` — a refusal (AC15).
6. `apps/api/src/finance/company-account-balance-currency.spec.ts` — expected number of queries
   9 → 10; the `'USDT'` check loop over the first **nine** WHEREs (the ninth is the new term, its
   marker is in `settled_currency`), the tenth is the watchdog.
7. Specs (see "Test AC"): `apps/api/src/finance/cascade-apply.unit.spec.ts`,
   `apps/api/src/finance/cascade-apply.integration.spec.ts`,
   `apps/api/src/finance/company-account-balance.spec.ts` (arithmetic of the ninth term),
   `packages/shared/src/schemas/edit-cascade.spec.ts` (the new warning).

---

## Reuse / Regression scope

**Existing code to reuse (mandatory, do not rewrite):**

- `resolveEditCascade`, `computeCascadeVersion`, `amountsDiffer` (`@crm/shared`) — all the cascade
  arithmetic is already here. Do not reproduce it locally in any form.
- `loadCascadeSnapshot` — one read shape for preview and for application.
- `roundShareAmount` (`@crm/shared`) — only through the resolver, do not call it directly in apply.
- `lockCompanyAccount`, `COMPANY_ACCOUNT_FUNDING_SOURCE` (`company-account-balance.ts`).
- `InvoicesService.voidAndReissueInvoiceForAmountEdit` — already injected into `TransactionsService`
  (`:217-218`, `forwardRef`), DI does not need to change.
- The conditional-UPDATE-with-affected-row-count-check pattern — `settleByCompany` (`:828`),
  `adminDeleteTransaction`, `restoreTransaction`.

**Shared code that will be affected (blast-radius):**

- `sumLedgerTerms` → `computeCompanyAccountBalanceFromLedger` → four money gates
  (`createExpense`, `paySalary`, `settleByCompany`, `createDividend`) + `…ForDisplay`.
  Pinning tests before the change: `company-account-balance.spec.ts`, `company-account-balance-currency.spec.ts`.
- `CascadeObligationSnapshot` / `cascadeWarningCodeSchema` → `getEditCascadePreview` and its specs.
- `adminUpdateTransactionSchema` → `transactions.controller.ts:244` + UI (task 5, not yet).

**Must not break:**

- A regular settle (the first one on a row) — byte-for-byte the same behavior: `owedNow` when
  `settled_amount IS NULL` equals `obligation.amount`.
- Metadata edits (`notes`/`receipt`/`category`) on a `PAID` row remain allowed.
- Editing **currency** and `salaryMonth` on `PAID` remains forbidden.
- Guard 1 (the `PAYOUT` family) and guard 2 (`payoutRequestId`) — do not touch at all.
- The `pending_obligations` synchronization from #598 (scope `status='PENDING'`) — do not weaken the `WHERE`.

---

## API endpoints

None new. The body of the existing `PATCH /api/transactions/:id/admin-edit` changes
(`transactions.controller.ts:241-245`, RBAC `@Roles('ADMIN')` + service check — both
are kept): an optional field `cascadeVersion` is added.

---

## DB schema

**No migrations.** All three columns (`settled_amount`, `settled_currency`, `settled_share_percent`)
were added by task 1 (#599) and applied in prod. The task introduces no new columns.

---

## RBAC

| Role       | Access                                                   |
| ---------- | -------------------------------------------------------- |
| ADMIN      | full (the only one who can edit and trigger the cascade) |
| SENIOR     | none                                                     |
| JUNIOR     | none                                                     |
| HR         | none                                                     |
| ACCOUNTANT | none for editing; settle/top-up — as today (unchanged)   |

---

## Seams under test

- `TransactionsService.adminUpdateTransaction` — the endpoint seam, through it the entire
  cascade is observed (existing, the highest of the sufficient ones).
- `TransactionsService.applyEditCascade` — a new private method; observed through a unit double with a
  substituted `dbtx` (capturing the order and content of writes). It is needed because the mutation gate does not
  see integration specs (`mutation-gate-integration-specs.md`).
- `sumLedgerTerms` through `computeCompanyAccountBalanceFromLedger` — an existing seam, already
  covered by two specs; the arithmetic of the ninth term is verified there too.
- `resolveEditCascade` — an existing pure seam (`packages/shared`), the new warning
  is verified by constructing a snapshot by hand.
- `PendingSettlementService.settleByCompany` — the existing seam for the top-up.

---

## Acceptance criteria

### AC1 — BIZ-18 is narrowed surgically

- [ ] `transactions.service.ts:3004` becomes
      `if (tx.status === 'PAID' && (currencyChanged || salaryMonthChanged))`. `amountChanged` is removed from
      the condition, **and not weakened anywhere else**.
- [ ] `data.currency` still cannot change on a `PAID` row (backlog item 95:
      a broad removal opens the live `data.currency` branch and breaks the currency watchdog).
- [ ] grep: `grep -n "currencyChanged || salaryMonthChanged" apps/api/src/finance/transactions.service.ts`

### AC2 — mandatory preview and optimistic locking

- [ ] On `tx.status === 'PAID' && amountChanged` a missing `cascadeVersion` → `400`
      with text about the mandatory preview.
- [ ] Inside the DB transaction the snapshot is re-read with `loadCascadeSnapshot(dbtx, id, { forUpdate: true })`,
      `computeCascadeVersion` is taken from it; a mismatch with the one sent → `409` with the text
      "refresh the preview". There is no silent recomputation.
- [ ] The plan is built **only** by calling `resolveEditCascade(snapshot, { amount })`. No own
      share arithmetic appears in `apps/api`: `grep -n "roundShareAmount" apps/api/src/finance/transactions.service.ts`
      gives no new occurrences inside the cascade.

### AC3 — lock order

- [ ] The sequence inside the DB transaction is strictly: `pending_obligations` (FOR UPDATE /
      conditional UPDATE, `ORDER BY id`) → `lockCompanyAccount(dbtx)` → `transactions`
      (FOR UPDATE, `ORDER BY id`) → writes. Justification — addendum 1.9 (ABBA with `settleByCompany`
      gives 40P01 on the money path).
- [ ] `lockCompanyAccount` is taken always when the cascade writes anything, not only when
      the derivative is company-funded (addendum 1.6, about READ COMMITTED between SUMs).

### AC4 — blocking conditions of application

Application is refused entirely (400, not a single write) if for any derivative:

- [ ] `plan.newAmount === null` (`NO_SHARE_SNAPSHOT`) — recomputation is impossible, guessing is forbidden
      (AC5 item 4 of the ADR);
- [ ] `obligation.currency !== source.currency` (`OBLIGATION_CURRENCY_MISMATCH`) — the cascade
      **writes** into `pending_obligations.amount`, and the currency of this column must be checked, not
      assumed (addendum 3.5).
- [ ] `NON_USDT_CURRENCY` on a **closed** obligation (`obligation.status === 'PAID'`) —
      **blocks** (addendum 1.14). The remainder is incomputable (subtraction from different units), so
      there is nothing to close the rolled-back row with, and a reopened obligation is a claim about a debt
      to a person. The refusal is reversible by nothing; the dead end is reversible only by editing data.
      _(Revision: in the first edition of the task this assumption was the opposite. The argument relied on
      the premise "the top-up works"; for drop it does not work — the premise disappeared together with the conclusion.)_

### AC5 — a derivative with a still-open obligation

- [ ] Both copies of the amount are updated in one DB transaction: `pending_obligations.amount`
      (scope `status='PENDING'`) and `transactions.amount`.
- [ ] The value written is **`max(plan.newAmount, settledAmount)`**, not `plan.newAmount`
      (addendum 1.7, the single rule "`amount` does not drop below the accumulator"). For a row that
      never went through settle, `settledAmount = 0` and `max` is the identity, i.e. the behavior of the first
      edition is preserved byte-for-byte.
- [ ] If `max` kicked in (`newAmount < settledAmount` — this is an **already rolled-back** row, on which
      more was paid than the new share): `CASCADE_OVERPAYMENT` is additionally journaled. Without `max`
      the remainder to top up becomes negative and there is nothing to close the obligation with (SR-M-4).
- [ ] The status does not change, the percent snapshot is not touched.
- [ ] Journal: `CASCADE_AMOUNT_UPDATE` with `targetId` = the derivative's id.

### AC6 — rollback of a paid derivative (`plan.needsReconfirm === true`)

- [ ] **First — verify the invariant on which term 9 stands (addendum 1.2).** For a derivative with
      `fundingSource === 'COMPANY_ACCOUNT'`: if
      `amountsDiffer(Number(tx.amount), Number(tx.settledAmount ?? 0))` — **refuse loudly** (400),
      writing nothing. The text must name the invariant and its holders, for example: "the row amount and the
      amount of actual payments diverge (`amount` ≠ `settled_amount`) — the ledger would return the wrong
      debit; the row requires manual reconciliation before editing".
      Why this is mandatory: `settleByCompany` on the senior branch takes the accumulator from
      `pending_obligations.amount`, while term 7 debits `transactions.amount`, and **the equality of these
      two is checked nowhere in settle** — it is held by `bookCompanyObligations` and task 0
      (#598). A row edited before #598 may violate it. Silently rolling back such a row
      means returning to the balance a number other than the one that left it — an error "to the plus", risk No. 4.
      Use the **shared** `amountsDiffer` from `@crm/shared`, do not write a third comparison.
- [ ] `pending_obligations`: a conditional UPDATE `WHERE id = … AND status = 'PAID'` →
      `status='PENDING'`, `closingTransactionId = null`, `amount = plan.newAmount`. Zero
      affected rows ⇒ the rollback has already happened ⇒ exit without a second journal entry (idempotency).
- [ ] `transactions`: `type` → `SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT` (per the current type),
      `status` → `PENDING_PAYMENT`, `amount = plan.newAmount`.
- [ ] The percent snapshot is returned to the **live** column: `seniorSharePercent` for a senior derivative,
      `dropSharePercent` for a drop derivative, the value — `plan.sharePercent`
      (addendum 2). `settled_share_percent` is **not touched**. `*SharePercentSource` stays `NULL`.
- [ ] `settled_amount` / `settled_currency` are **not touched** — the accumulator is monotonic.
- [ ] `fundingSource`, `receiptDocumentId`/`receiptExternalUrl`, `senderId`/`senderLabel`,
      `validatedBy`/`validatedAt`, `currency`, `dropCascadeOrigin` are **not erased** (AC3 item 4 of the ADR;
      `fundingSource` and `currency` are additionally needed by the ninth term).
- [ ] Journal: `CASCADE_REOPEN`, `targetId` = the derivative's id, metadata
      `{ obligationId, causedBy: <source id>, settledAmount, sharePercent, before: {amount,type,status}, after: {amount,type,status} }`,
      **inside the same DB transaction**.

### AC7 — overpayment branch on a CLOSED obligation: write NOTHING (addendum 1.7)

> Both branches of AC5 and AC7 are one law: **a derivative's `amount` is never written below its
> `settled_amount`.** On a closed obligation this is "do not write at all" (there `amount` already equals
> the accumulator), on an open one — the `max(...)` from AC5. The wordings differ because the states differ;
> the monetary reason is one.

- [ ] If the obligation is `PAID` and `plan.needsReconfirm === false` (that is,
      `newAmount <= settledAmount`) — for this derivative **neither `transactions.amount`,
      nor `pending_obligations.amount`, nor the status, nor the type, nor the percent is written**.
- [ ] The reason to be understood, not memorized: term 7/8 debits `amount`, what physically left is
      `settled_amount`. Writing a smaller `amount` = inflating the company balance by exactly the overpayment.
- [ ] Journal: `CASCADE_OVERPAYMENT` with `{ obligationId, causedBy, settledAmount, newShare, overpaidBy }`.
- [ ] The row stays `PAID` and falls into term 7/8 with the same number as before.

### AC8 — the ninth ledger term

- [ ] `sumLedgerTerms` gets a ninth SUM over `settled_amount` with the condition
      `type IN COMPANY_TERM_TYPES_PENDING_SETTLED ∧ status='PENDING_PAYMENT' ∧
fundingSource='COMPANY_ACCOUNT' ∧ settled_currency='USDT'`, and it is **subtracted**.
- [ ] The predicate `settled_amount > 0` is ABSENT (redundant, gives an unkillable mutant — addendum 1.3).
- [ ] Terms 1–8 do not change by a single byte (`git diff` on the file confirms this).
- [ ] The helper `sumSettledAmount` sums exactly `settled_amount` and does not reuse `sumAmount`.

### AC9 — extension of the currency watchdog (evaluate independently of AC8)

- [ ] An OR branch is added to `assertNoOffCurrencyCompanyRows` (addendum 1.8), **in the same query**,
      without an additional round-trip.
- [ ] `settled_currency IS NULL` is included in the condition ("no marker" ≠ "the marker matches").
- [ ] The text of `CompanyAccountOffCurrencyError` stops asserting that all the rows found are `PAID`.

**The safety precondition is verified from the code, not by polling the database.** The branch adds a
refusal condition to four money gates, so it must be known that no matching rows exist. The first
edition required a read-only SELECT on the live DB — **this is infeasible**: prod is on a VPS without SSH
(`project_deployment_plan`), the local `crm_db` in docker is empty, `crm_qa` says nothing about real data. An
instruction that cannot be executed yields either a silent skip or a "zero" from the wrong
database. Instead — three greps, which the **coder runs in their worktree**, and their output goes into the
PR body:

```bash
# 1. Who writes the status PENDING_PAYMENT at all. Expected EXACTLY 4 matches:
#    two IOU inserts in bookCompanyObligations + two in the payout path (createPayoutRequest).
grep -rn "status: 'PENDING_PAYMENT'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'

# 2. Who writes fundingSource = COMPANY_ACCOUNT. Expected: only the settleByCompany flip
#    (+ paySalary/createExpense/dividends on THEIR types, which are not in the branch's type list).
grep -rn "fundingSource: " apps/api/src --include='*.ts' | grep -v '\.spec\.ts' | grep -i "COMPANY_ACCOUNT"

# 3. Check by eye: no match from (1) writes fundingSource in the same .set()/.values().
```

- [ ] The output of all three is attached to the PR body with a one-line conclusion: the combination
      `type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT} ∧ fundingSource='COMPANY_ACCOUNT'`
      was **never produced** by this code (before task 3 there is not a single `PAID → PENDING_PAYMENT` path).
- [ ] If the greps give a different picture (a fifth status writer appeared or a writer of
      `fundingSource` on an IOU row) → **do not do AC9**, put it into `.blocked.md` with the grep output.
- [ ] Unit test: the watchdog branch **does not fire** on rows of the forms that the current
      code produces (an IOU after booking: `PENDING_PAYMENT` + `fundingSource=null`; a row after the flip:
      `PAID` + `COMPANY_ACCOUNT` + USDT), and **fires** on a hand-constructed
      `PENDING_PAYMENT` + `COMPANY_ACCOUNT` + `settled_currency='UAH'`.

### AC10 — top-up after rollback

- [ ] `PendingSettlementService.resolveSource` returns `sourceSettledAmount`.
- [ ] SENIOR: `owedNow = parseFloat(claimedAmount) - Number(sourceSettledAmount ?? 0)`;
      the money gate (`:892`) is measured by this value and it also becomes `settledAmountThisSettle`
      (`:771`). The flip still does not touch `amount`.
- [ ] After the top-up `settled_amount == amount` holds (the invariant of addendum 1.2) — verified
      by a test, not by reasoning.
- [ ] `owedNow === 0` → **close as usual** (an idempotent closure, AC15): the flip passes,
      `settled_amount += 0`, the ledger does not change. A refusal here would create a dead end (SR-M-4).
- [ ] `owedNow < 0` → `400` ("more has already been paid on the obligation than it is worth — a
      manual decision on the overpayment is required"). The `max` rule from AC5 makes this state unreachable;
      the check stays as fail-loud in case it appears by another route.
- [ ] DROP + `settled_amount > 0` → `400`. The text must read to the owner as "the branch is not yet
      built", not "something broke": for example "A top-up on a partially paid
      drop obligation is not yet supported — the rate and the amount of the actual payment on such
      a row are computed per a single payment. The obligation stays open, "already paid" is visible;
      closing the remainder is a separate task." The words "error", "impossible", "corrupted" must not be
      in the text. The first settle of a drop obligation does not change at all.
- [ ] The flip's `WHERE` is extended with `settled_amount IS NOT DISTINCT FROM <the value read>` — a race between the
      pre-transaction read and the write gives zero rows and the existing `throw`.

### AC11 — invoice (wiring up task 4)

- [ ] After the DB transaction commits, `invoicesService.voidAndReissueInvoiceForAmountEdit(id, actorId)`
      is called for the source and for **each** derivative whose `amount` changed.
- [ ] The call is outside the cascade's DB transaction (the method opens its own, with `FOR UPDATE` — nesting would cause
      a self-lock). The error is logged and does not roll back the already applied cascade — the same
      contract as the existing fire-and-forget invoice triggers.
- [ ] Nothing from #600 is rewritten.

### AC12 — idempotency

- [ ] `amountsDiffer` (shared) is the only comparison of "did the amount change". A second description
      of this rule does not appear.
- [ ] A repeated edit to the same value: no cascade, no journal, no writes.
- [ ] A repeated rollback of an already rolled-back derivative: zero affected rows, exit without a second entry
      in the journal.
- [ ] The number of derivatives does not grow under any sequence of edits (rows are **updated**,
      not created).

### AC13 — editing a `PAID` row that itself stands in a ledger term (SR-H-1, addendum 1.12)

The guard `originalAmount !== null` is necessary but **insufficient**: for a paid senior row
`originalAmount` is `null` (the flip reveals the triplet only under `isDropObligation`), and
`payoutRequestId` is nulled by it too — so guard 2 does not hold it either. Term 7 debits such a row
by `amount`, and an edit downward inflates the company balance. The check from AC6 does not catch it: that one walks
`plan.derivatives`, while here the edited row is its own source.

The rule: **editing `amount` is forbidden when the number has a second carrier that the edit does not
move.** Three new refusal predicates (400, nothing is written), in addition to the
existing `originalAmount !== null`:

- [ ] `tx.settledAmount !== null` — the row is a closed or partially closed
      obligation; its `amount` is pinned to the accumulator.
- [ ] there exists a `pending_obligations` with `source_transaction_id = <row id> AND status='PAID'`
      — the same for rows closed **before** #599 (their `settled_amount` is empty).
      The key `source_transaction_id` is correct precisely because settle flips the row in place:
      after the flip `source_transaction_id == closing_transaction_id == the row's own id`.
- [ ] `tx.type === 'COMPANY_DEPOSIT'` — the amount was observed on the blockchain (C4 of the main ADR).
- [ ] The refusal texts are different and name the **carrier**, not just "not allowed": "the row closes
      an obligation, the amount is confirmed by actual payments — correct it with a reversing
      transaction", "the deposit amount is reconciled with the blockchain".
- [ ] **Do not add** a refusal for `ADMIN_INCOME`, `EXPENSE`, `DIVIDEND_TO_ADMIN`: they have no second
      carrier of the amount (verified — neither `original_amount`, nor `tx_hash` with an amount check), and
      an edit there means "we recorded the wrong number", and the ledger must follow it. That is
      exactly the work the task exists for. The full reconciliation across all eight terms — the table
      in addendum 1.12.
- [ ] The data for the check is loaded by the **same** `loadCascadeSnapshot`: `CascadeSourceSnapshot`
      gets `settledAmount: number | null` and `hasClosedObligation: boolean`. Do not introduce a second
      DB query for this.
- [ ] **A trap that must be consciously avoided.** The AC13 predicate applies **only to the row
      the request edits** (`tx` in `adminUpdateTransaction`). The cascade writes the `amount` of
      derivatives that have `settledAmount !== null` — that is its regular work (AC5/AC6).
      If the predicate is moved into a shared helper and called from `applyEditCascade`, the cascade will start
      refusing itself. Verify by a test: rolling back a derivative with a non-empty accumulator passes,
      a direct edit of the same row does not.
- [ ] Compatibility with the main scenario: `ADMIN_INCOME` has an empty `settledAmount`, no closed
      obligation on itself, the type is not `COMPANY_DEPOSIT` — all three predicates stay silent. Verify
      by a test, otherwise AC13 may quietly kill the whole feature.

### AC14 — a top-up must come from the same funding source (SR-H-2, addendum 1.13)

Terms 7/8/9 are keyed on the **live** column `funding_source`. The rollback preserves it, but the next
settle overwrites it — and the row drops out of both terms at once (`funding_source` is no longer
`COMPANY_ACCOUNT`, status is no longer `PENDING_PAYMENT`). Money that left the company account disappears
from the ledger. The scenario is entirely in USDT, so the currency guard next to it does not fire.

- [ ] `PendingSettlementService.resolveSource` returns `sourceFundingSource: string | null`.
- [ ] In `settleByCompany`, **next to the existing check `sourceSettledCurrency !== currency`**
      (the same form, the same argument): when `priorSettled > 0` and
      `(debitsCompanyAccount ? 'COMPANY_ACCOUNT' : null) !== sourceFundingSource` — a 400 refusal with
      text naming both sources.
- [ ] The check is **unconditional** (not only for senior): a top-up on drop is currently forbidden by AC10, but
      the guard must not depend on whether it is lifted in 3b.
- [ ] Record the invariant in a comment at the check itself: "all settles of one row come from one
      source; `funding_source` is its record; terms 7/8/9 are keyed on it".
- [ ] Do **not introduce** a column `settled_funding_source`: that would require editing terms 7 and 8,
      which the task commits not to touch (addendum 1.10). The escape hatch for the future is documented.

### AC15 — the cascade does not roll back what it will not be able to close (SR-M-3 / SR-M-4, addendum 1.14)

A reopened obligation is a **claim about a debt** to a person: its `amount` enters the
money gate and the aggregates. A row that cannot be closed declares a nonexistent debt. The refusal is
reversible by nothing, the dead end — only by editing data.

- [ ] Before rolling back a derivative it is verified that a subsequent settle on it is possible under the rules of
      AC10. If not possible — a 400 refusal, **not a single write**.
- [ ] It is impossible in two cases: (a) a drop derivative with a non-empty accumulator (a top-up on drop is not
      implemented); (b) `settled_currency` does not match the obligation's currency (the remainder is
      incomputable). Both are checked **before** the first write, not after the rollback.
- [ ] The third case — `newAmount < settledAmount` on an already rolled-back row — is closed by the rule
      `max(...)` from AC5, not by a separate check.
- [ ] The refusal texts read as "the branch is not yet built", following the model of AC10.
- [ ] A consequence for AC10: **`owedNow === 0` is no longer an error**, but a legitimate idempotent
      closure. Zero means "exactly as much was paid as the obligation is worth"; the closure is
      ledger-neutral (the row leaves term 9 at `settled_amount` and arrives in term 7 at
      `amount`, and they are equal). The refusal remains only on `owedNow < 0`, and the `max` rule makes this
      state unreachable.

---

## Test AC — for each risk of AC6 of the main ADR + seven new ones

The wording "covered by tests" is a defect. For each item it is stated **what exactly will turn red on the
version of the code without the fix**, and this must be confirmed in fact (backlog item 75): `git stash` the fix,
run the spec, attach the failure output to the PR body. Claims without output are not accepted.

Remember the blindness of the gates (backlog items 71/82): `check-mutation-tally.mjs` goes red only on
`Survived`, the mutation gate **does not see** `*.integration.spec.ts`, and `Integration Tests (Postgres)`
is not among the required checks. Therefore **every** money claim below has a unit double.

| #       | Risk                                                                  | Test                                                                                                                                                                                                                                                                                         | Goes red on                                                                                                                                                            |
| ------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | preview ≠ fact                                                        | integration: one fixture → `GET :id/edit-preview` → `PATCH :id/admin-edit` → compare the **whole structure**: per derivative `tx.amount`, `obligation.amount`, `status`, `type`, the restored percent against the plan's fields                                                              | an implementation computing the share locally (different rounding) or writing to the wrong fields; "N rows in both" does not catch this                                |
| **1b**  | the same, visible to the mutation gate                                | unit: a substituted `dbtx` captures the `.set()` objects; the test itself calls the **real** `resolveEditCascade` and compares the captured amounts with the plan                                                                                                                            | replacing `roundShareAmount` with local arithmetic; a mutant in the computation of the written amount                                                                  |
| **2**   | one-sided symmetry check                                              | integration: after the cascade for **each written** derivative assert `tx.amount === obligation.amount` **AND** `obligation.amount === roundShareAmount(newIncome, snapshot)`. The overpayment branch (AC7) is deliberately excluded from this check                                         | updating only `transactions` (the first equality fails) and only `pending_obligations` (fails too)                                                                     |
| **3**   | tautological test                                                     | `MUTATION_BASE_SHA=$(git rev-parse origin/main) node scripts/devops/mutation-gate.mjs --changed` + **read the log**, not the verdict: zero `Survived` with a non-empty `NoCoverage` without an integration hint = a defect                                                                   | a mutant in `roundShareAmount`/in the cascade arithmetic that no test kills                                                                                            |
| **4**   | **the balance grows by the paid amount**                              | integration: settle company-funded → `B1 = computeCompanyAccountBalanceFromLedger(db)` → edit the income upward → `B2` → `expect(B2).toBe(B1)`                                                                                                                                               | the absence of the ninth term: `B2 === B1 + oldObligation`                                                                                                             |
| **4b**  | the same, visible to the mutation gate                                | unit in `company-account-balance.spec.ts`: feed nine amounts as fixed numbers and assert the exact total; separately — `…-currency.spec.ts`: exactly **10** queries and the presence of `PENDING_PAYMENT` + `COMPANY_ACCOUNT` + `settled_currency` in the ninth WHERE                        | a `+` sign instead of `−`; a skipped term; a term summing `amount` instead of `settled_amount`                                                                         |
| **5**   | the percent snapshot is lost                                          | integration: settle → edit → read the row: the live percent column is non-empty and equals `settled_share_percent`; then a repeated `GET :id/edit-preview` returns `newAmount !== null`                                                                                                      | an implementation that left the percent `NULL`: the second preview returns `NO_SHARE_SNAPSHOT`                                                                         |
| **6**   | the accumulator is zeroed / the top-up is wrong                       | integration chain senior: settle 2000 → edit to 3000 → top-up → edit to 4500 → top-up. At each step: `settled_amount` strictly grows, after each top-up `settled_amount === amount`, `remainingToPay` from the preview matched the actually debited amount                                   | a top-up for the full amount (`settled_amount` goes to `2×`); zeroing of the accumulator by the rollback; a divergence `amount ≠ settled_amount`                       |
| **7**   | race preview ↔ settle                                                 | integration with a manual sequence: preview (version V) → settle by another session → `PATCH` with V → **409**, zero writes to the DB                                                                                                                                                        | an implementation ignoring `cascadeVersion`: the edit passes and silently recomputes                                                                                   |
| **8**   | divergence leaks into a signed invoice                                | integration: a signed invoice on a derivative → edit → the old signature is marked `voidedAt`, the new invoice carries the new amount, `verifyInvoice` returns the same                                                                                                                      | an unwired `voidAndReissueInvoiceForAmountEdit`: the old signed invoice is alive with the old amount                                                                   |
| **8b**  | the same, visible to the mutation gate                                | unit: a spy on `invoicesService.voidAndReissueInvoiceForAmountEdit` — called for the source and for each changed derivative, exactly once each                                                                                                                                               | a skipped call; a call only for the source                                                                                                                             |
| **9**   | journal by part of the fields                                         | one test per action: `CASCADE_AMOUNT_UPDATE`, `CASCADE_REOPEN`, `CASCADE_OVERPAYMENT` — check **each field** of the metadata separately, including `settledAmount` and `causedBy`; plus the existing `AMOUNT_OR_RECEIVER_CHANGE` on the source                                               | a journal of "one entry for the entire cascade"; a missing `settledAmount`; a `targetId` pointing to the source instead of the derivative                              |
| **10**  | a currency edit passes together with the amount                       | `PATCH` with a changed `currency` on a `PAID` company row → **400**; afterwards `computeCompanyAccountBalanceFromLedger` returns a number without throwing                                                                                                                                   | a broad removal of BIZ-18: the edit passes, and then the watchdog takes down four gates                                                                                |
| **11**  | the cascade breeds duplicates                                         | integration: two edits in a row → the `count(*)` of derivatives by `source_income_transaction_id` did not change; for drop additionally — an attempt to insert a second row gives `23505`, not a silent duplicate                                                                            | an implementation appending a delta row instead of updating                                                                                                            |
| **12**  | an edit bypassing the interface                                       | all tests hit the service/endpoint directly, without UI                                                                                                                                                                                                                                      | cascade logic that moved into the controller or the dialog                                                                                                             |
| **13**  | ABBA deadlock with `settleByCompany`                                  | unit: a substituted `dbtx` records the order of accesses; assert `pending_obligations` → `lockCompanyAccount` → `transactions` (addendum 1.9)                                                                                                                                                | any permutation — the same form of check as MED-2 on #598                                                                                                              |
| **14**  | the advisory lock is not taken                                        | unit: `lockCompanyAccount` called exactly once before the writes to `transactions`                                                                                                                                                                                                           | the absence of the call (the balance is read by a gate in the middle of a row's move between terms)                                                                    |
| **15**  | the obligation's currency is not checked (item 95)                    | unit on the resolver: a snapshot with `obligation.currency='EUR'` and `source.currency='USDT'` → the warning `OBLIGATION_CURRENCY_MISMATCH`; integration: `PATCH` on such a set → **400**, zero writes                                                                                       | the absence of the check: the cascade silently writes the USDT share into an EUR obligation                                                                            |
| **16**  | **an overpayment updates `amount`**                                   | integration: settle 2000 → edit the income downward (new share 1000) → the row is still `PAID`, `tx.amount === 2000`, `obligation.amount === 2000`, and `computeCompanyAccountBalanceFromLedger` **did not change**                                                                          | an "obliging" `amount := 1000`: the company balance grows by 1000 while the money has left                                                                             |
| **17**  | **`amount ≠ settled_amount` is rolled back silently**                 | unit (the mutation gate sees it): a snapshot of a company-funded derivative with `tx.amount = 2000` and `settled_amount = 1800` (the form of a legacy row edited before #598) → `applyEditCascade` throws 400, `dbtx` received **not a single** write. Plus a mirror case: equal values pass | an implementation without the AC6 check: the rollback passes, term 9 returns 1800 instead of the vanished 2000 — the balance is inflated by 200                        |
| **17b** | the same invariant on a real DB                                       | integration: prepare a row with the divergence by a direct UPDATE on the scratch DB → `PATCH` → 400 and zero changes in both tables                                                                                                                                                          | the same implementation without the check; additionally catches a typo in a column name that the unit double will miss                                                 |
| **18**  | **editing the paid senior row itself inflates the balance** (SR-H-1)  | integration: income → IOU → company-settle 260 (the row has `originalAmount === null`, `payoutRequestId === null` — assert this in the test, otherwise it will silently stop checking what it was written for) → `B1` → `PATCH` on this row `amount: 26` → **400** and `B2 === B1`           | an implementation where the refusal catches only `originalAmount`: the edit passes, the term-7 debit drops from 260 to 26, the balance grows by 234                    |
| **18b** | the same refusal, visible to the mutation gate                        | unit on the three AC13 predicates by name: `settledAmount !== null`; a closed obligation with `settledAmount === null` (legacy); `type === 'COMPANY_DEPOSIT'`. Plus negative cases: `ADMIN_INCOME`, `EXPENSE`, `DIVIDEND_TO_ADMIN` **pass**                                                  | the removal of any of the three predicates; and — more important — the addition of an extra ban on the three types that must stay editable                             |
| **19**  | **a top-up from a different pocket erases the compensation** (SR-H-2) | integration entirely in USDT: company-settle 260 → edit upward (rollback, term 9 holds 260) → top-up with `ADMIN_PERSONAL` → **400**. And a control run: a top-up from `COMPANY_ACCOUNT` passes, `B` after it is lower than `B_before_top-up` by exactly `owedNow`                           | an implementation without the source check: the top-up passes, the row drops out of both term 7 and term 9, 260 USDT vanish from the ledger                            |
| **19b** | mirror order                                                          | integration: `ADMIN_PERSONAL`-settle → rollback → top-up from `COMPANY_ACCOUNT` → **400**                                                                                                                                                                                                    | the same implementation: term 7 would debit the full obligation on a partial payment by the company                                                                    |
| **20**  | **rollback into a dead end** (SR-M-3)                                 | integration: a drop obligation closed in UAH → `PATCH` on the source → **400**, the obligation stayed `PAID`, zero writes. Separately: a drop closed in USDT company-funded → also **400** (a top-up on drop is not implemented)                                                             | an implementation rolling back such a row: the obligation is reopened, there is nothing to close it with, and `pending_obligations.amount` declares a nonexistent debt |
| **21**  | **an edit "there and back"** (SR-M-4)                                 | integration: settle 260 → edit the income upward (share 520, rollback) → edit back (share 260) → assert `amount === 260`, `settled_amount === 260`, `owedNow === 0`, and **settle closes the row as usual**; after the closure `B` did not change                                            | an implementation without the `max` in AC5 and/or with a refusal on `owedNow === 0`: the row stays `PENDING_PAYMENT` forever                                           |

Additionally (project rules, not optional):

- `Skill('security-review')` **before** writing the first line of the endpoint; the surface is monetary ⇒
  `security-reviewer` in the review is mandatory.
- `Skill('superpowers:test-driven-development')` — the test before the implementation.
- `Skill('superpowers:verification-before-completion')` — before declaring readiness.
- The cascade's property test, if written, must generate the combination "obligation `PENDING` +
  accumulator > 0" (backlog item 87: a generator deriving the accumulator from the status is blind
  by construction).
- E2E locally before push; push of the feature branch — `DATABASE_URL= git push`.

---

## Assumptions (filled in by the executor as work proceeds — A1 decisions)

Pre-filled by the architect — these are decisions made when writing the task. The executor adds
their own below in the same line form.

- **The top-up is implemented only for the SENIOR branch; a DROP top-up refuses loudly** — on a drop row
  `amount` is the fact of the payment in the payment currency, next to it lies the triplet `originalAmount`/`exchangeRate`
  describing **one** conversion; a partial top-up makes `amount` cumulative and breaks
  `amount = originalAmount × exchangeRate`. Reversible, rollback: a separate task 3b, not a rework
  of this PR (addendum 1.11).
- **A `cascadeVersion` mismatch is returned as `409 Conflict`, not `400`** — the semantics
  "the state changed", already used in `signInvoice`. Reversible, rollback: one line.
- **`cascadeVersion` is always required on `PAID` + an amount change**, even when there are no
  derivatives — the rule is simpler and along the way gives optimistic locking to the edited row itself.
  Reversible, rollback: narrow the condition.
- ~~**`NON_USDT_CURRENCY` does not block application**~~ — **the assumption is cancelled** after
  security-review #607. The argument relied on the premise "the top-up works"; for drop it does not work
  (AC10), so the rollback would create an obligation with nothing to close it. It now blocks —
  AC4 + AC15. Left struck through deliberately: a cancelled assumption and a forgotten assumption look
  the same if the first is erased.
- **`*SharePercentSource` stays `NULL` after the rollback** — task 1 did not save the origin snapshot,
  it must not be invented (backlog item 70). Reversible, rollback: a snapshot column in
  a separate migration.
- **The `amount == settled_amount` check before the rollback (AC6) refuses outright, it does not repair data.**
  Side effect: an income edit on a row with already diverged copies (legacy, edited
  before #598) will be rejected until the owner sorts it out manually. The alternative is to silently return to the balance
  a number other than the one that left it. Reversible, rollback: remove the check (and with it —
  the correctness of term 9 on such rows).
- **The AC9 precondition is proven by a grep over the write paths, not by a query to the database** — the executor
  has no access to prod data, and a "zero" from another database is worse than the absence of a check. Reversible, rollback:
  put both SQLs into a decision brief to the owner as a merge precondition.
- **Mixing funding sources on one obligation is not supported** (AC14) —
  a refusal instead of a new column `settled_funding_source`, because the column would require editing
  terms 7/8, which the task commits not to touch. Reversible, rollback: a column + editing the terms
  as a separate task.
- **`COMPANY_DEPOSIT` is closed by type, not by `tx_hash`** (AC13) — the predicate `tx_hash IS NOT
NULL` would block `ADMIN_INCOME`, which also carries a hash through the income registry, i.e. would
  kill the main scenario of the feature. Reversible, rollback: narrow the predicate if a second
  on-chain-reconciled type appears.

### Added by the executor (round 1, PR #607)

- **`fundingSource` added to `CascadeDerivativeSnapshot`** — AC6 keys the refusal on
  `fundingSource === 'COMPANY_ACCOUNT'`, and the snapshot did not have this field. A second query for one
  column would have split `loadCascadeSnapshot`, which ADR AC4 keeps single. The resolver does not read
  the field. Reversible, rollback: remove the field, read separately.
- **The advisory lock is taken by `loadCascadeSnapshot({ forUpdate: true })` itself** — this is the only
  position between the two row locks that does not invert the order of `settleByCompany` (addendum 1.9), and
  the lock cannot be handed to the caller "for the middle". Consequence: the lock is taken also on a path ending in
  409 — a superset of AC3 in the safe direction. Reversible, rollback: split the helper.
- **`owedNow` refuses only when `priorSettled > 0`** — the blanket variant would have rejected the first
  settle of a legitimate zero obligation (a 0% share), while the task requires byte-for-byte the same
  behavior on the first settle. _(Round 2: the threshold itself was reworked by AC15 — now the refusal is only on
  `owedNow < 0`; the condition `priorSettled > 0` thereby became redundant and was removed.)_
- **An amount edit on a row with `originalAmount` is refused** (ADR AC5 §5) — BIZ-18 blocked this
  before the PR; the narrowing must not open a hole where `exchange_rate` quietly becomes false.
  _(Round 2: it entered AC13 as one of the four predicates.)_

### Added by the executor (round 2, review findings)

- **Test AC 8 (a round-trip of a signed invoice through S3/PDF) is not reproduced in this PR**
  (SPEC-L-1) — the method `voidAndReissueInvoiceForAmountEdit` itself is covered by the real-DB spec from #600
  (`invoice-signature-integrity.integration.spec.ts`), and this task's contribution — the call — is pinned
  by the spy 8b in a unit spec visible to the mutation gate (five assertions: a call for the source and each
  changed derivative exactly once, no call on the overpayment branch, no call
  on a metadata edit, attribution to the real operator under impersonation, logging of the swallowed
  error). Reversible, rollback: bring up the invoice stack in an integration spec as a separate task.
- **SR-M-2 (`amount = original_amount × exchange_rate` on a derivative) is closed by the AC15(a)
  predicate, without a fourth predicate** — the triplet is stamped ONLY by drop-settle, and drop-settle with
  a zero accumulator is possible only on a zero obligation, i.e. at a 0% share, at which
  `newAmount` is also zero and `needsReconfirm` is false. So any drop derivative able to reach
  a rollback has an accumulator > 0 and is rejected by AC15(a). Reversible, rollback: add the predicate
  `originalAmount !== null` to phase 1 (at the cost of the unreachability of the drop branch of percent restoration).
- **The drop branch of percent restoration (`dropSharePercent`) is kept, although unreachable**
  — by the same argument above. AC6 requires it explicitly, and task 3b lifts AC15(a) and makes it live;
  the unit test on it is marked synthetic, so that the next reader does not take the state for
  real. Reversible, rollback: delete the branch together with AC15(a) in 3b.

---

## Do not touch

- **Guard 1** (`type ∈ {PAYOUT, PAYOUT_ADMIN, PAYOUT_CONFIRMED}`) and **guard 2**
  (`payoutRequestId`) — neither weaken nor "refine". Guard 2 alone keeps the cascade
  single-level; behind it `payableAmount`, reconciled exactly with the on-chain transfer that took place.
- **`data.currency` and `data.salaryMonth` on a `PAID` row** — remain blocked.
- **Terms 1–8** of the balance formula — not a single byte.
- **`settled_amount` / `settled_currency`** — only through the existing DB-native increment in
  `settleByCompany`. The cascade neither writes nor zeroes them, ever.
- **The neighboring defects L11 and L16** (AC5 item 10 of the ADR) — do not fix in this PR.
- **The DROP conversion block** in `settleByCompany` (`:499-742`) — do not rewrite; of it only
  the computation base changes on a top-up, which this task does not have for drop ⇒ the block does not change at all.
- **`InvoicesService`** — only the call, no edits inside (#600).
- `.claude/state/pm-state.json`, `.github/workflows/**`, `docs/architecture/**` — other people's zones.
- **The live `crm_db`**: the task does not need it at all — neither for reading nor for writing (AC9 was converted to
  a check by code). Any write, `db:push`, `db:seed`, integration
  specs against it — are forbidden (`live-db-access.md`). Integration specs — only on a scratch DB,
  `DATABASE_URL` inline in the command, without `export`.

### Round 3 — added by the executor

- **Task 3b (a top-up on drop) goes BEFORE task 5** — the owner's decision on SR-L-2. The refusal
  "editing income with an already paid drop share is not supported" (AC10 + AC15) is a deliberate
  order of work, not a forgotten tail: until 3b is done, the UI of task 5 must not offer an edit
  where saving will certainly refuse. Recorded as a line precisely because the mechanics are correct and
  look finished — without this line each next reader will decide anew
  whether it is a bug or an intention.
- **The legacy epoch is closed by a disjunct, not by relying on a one-off script** (SR-H-3) — the task
  assumed that the fact of the run of `2026-07-15_settle_phantom_cleanup.sql` is recorded nowhere.
  Verified: it is recorded. The auto variant was run (`..._auto.sql`, PR #382, then de-wiring;
  justification — `KNOWN_NOT_WIRED` in `scripts/devops/check-prod-ddl-wiring.py`). The disjunct is needed no less
  because of that: the script's repoint is **narrowed** to `src.type IN ('SENIOR_PENDING_PAYOUT',
'DROP_PENDING_PAYOUT') AND src.status = 'PENDING_PAYMENT'` — it fixed only those obligations
  whose old source row remained a phantom IOU awaiting payout (in order to remove the FK before
  deleting the phantom). Obligations with `closing <> source`, whose old source is something
  else, remained as they were. The general argument: a guard whose correctness rests on a one-off
  script having covered all rows is a guard whose correctness lies outside the code. Reversible, rollback: remove
  the disjunct (and with it — the protection of pre-July rows).
- **The check of the top-up's source is extended to the pair `(funding_source, sender_id)`** (SR-M-5, the owner's
  decision) — inside `ADMIN_PERSONAL` the pocket is the same (`NULL`) for all admins, so
  the pocket check does not distinguish partners, and the flip overwrites `sender_id`, under which
  `adminBalances.sent` sums the whole row amount. For company-settle the pair on both sides is
  `(COMPANY_ACCOUNT, null)` — the behavior does not change. Reversible, rollback: return the comparison of a single
  pocket.
- **The accumulator floor is applied on BOTH write paths, not declared a law on one** (SR-M-6) —
  a rolled-back row stands in `PENDING_PAYMENT`, so `isCascadeEdit` is false and a direct edit went
  past the floor. Now `Math.max(requested, settled_amount)` is computed once and used
  by both writers; the journal gets both the written number and the printed one (`flooredFrom`).
  Reversible, rollback: remove the floor from the direct path and rewrite the AC5 wording as "the cascade", not
  "the row".
- **The preview returns the four AC13 reasons, not a warning** (CR-M-1) — the predicates and texts
  moved to `@crm/shared` (`classifyEditedRowLedgerFact` + `CASCADE_LEDGER_FACT_MESSAGES`), and
  both entry points ask them. A side consequence: `SOURCE_ORIGINAL_AMOUNT_SET` on a `PAID` row
  is no longer a warning, but a refusal `PAYMENT_FACT_RECORDED`; on a non-`PAID` row the warning
  remained. Reversible, rollback: return the enumeration of reasons to the service.
- **Reads of `settled_amount`/`original_amount` from the row made total over `undefined`**
  (incidentally, with CR-M-1) — `Number(undefined)` gives `NaN`, and `NaN !== null`, i.e. a missing
  column would be read as "the row has an accumulator" and would trigger a money refusal. Today
  unreachable (a read without projection), but a partial projection for speed is a one-line edit,
  and nobody would come here after the failure.

### Round 4 — added by the executor

- **An edit "there and back" on a row below the accumulator RAISES the amount, it does not stay silent** (SR-M-1) —
  when an amount is sent and after the floor the stored number shifts, both copies are written and the journal is written;
  when it does not shift, nothing is written. Before, the floor fired on "amount sent", while the second
  copy and the journal — on "amount changed", and a note edit on a legacy row (`amount` 100 with
  accumulator 260) silently rewrote `transactions.amount` to 260, leaving
  `pending_obligations.amount` at 100 — that very L3. The direction of the fix is safe: raising
  `amount` to the actually paid amount makes term 7 debit more, not less. Reversible,
  rollback: return the condition to "amount sent" and fix the journal separately.
- **The floor with an ABSENT accumulator is the identity, not `max(x, 0)`** — `?? 0` reads the same
  for all amounts the API accepts at all (both entry points validate `.positive()`), but
  introduces a second rule nobody ordered, "not below zero", and clips the resolver's negative probe. The law is about the accumulator; where there is no accumulator, there is nothing to say. Reversible, rollback: one
  line.
- **`isCascadeAmountEdit` compares the RAW request, not the floor** — these are two different questions. "Does
  the stored number shift" (by the floor) decides what to write; "did the operator ask for a change" (raw) decides
  whether this is a cascade, and therefore whether to apply AC13 and require the token. The first version of round 4 compared
  by the floor; on a closed row `amount === settled_amount`, so ANY downward edit
  was returned by the floor to the current value, AC13 was skipped and the operator got a silent success —
  exactly on the population AC13 was introduced for. Caught by two integration specs
  (`risk 18`, `risk 25`) and pinned by a unit test. Reversible, rollback: one line.
- **The conversion of the `numeric` column lives inside `floorAmountAtAccumulator`** — the helper accepts a
  string, a number, and `null`. While the caller did the conversion, it had a branch that
  no test could kill: only a non-positive request can tell `null` from `0`, and the API accepts no such
  requests. Reversible, rollback: narrow the signature and move the conversion back up.

### Round 5 — added by the executor

- **The final UPDATE binds the accumulator too, not only the status** (SR-L-1) — the status predicate
  closes A→B ("it was paid"), but not A→B→A ("paid and the status was returned"): the row reads as
  `PENDING_PAYMENT`, while the accumulator already says the money left. A monetary error "to the plus" does not
  follow from this (term 9 sums the accumulator, the next cascade repairs it with the AC5 floor), hence LOW; but
  the hardening is one line with a precedent on the same column in the `settleByCompany` flip, and
  `IS NOT DISTINCT FROM` instead of `=` is mandatory, otherwise a row with a `NULL` accumulator would stop
  matching and every ordinary edit would break. Reversible, rollback: remove the predicate.
- **The divergence of the raw value and the floor is pinned by a test, not only by a comment** (SR-M-1) — the comment
  of round 4 claimed that both comparisons take the same floored number and that this is "pinned by an
  explicit test". Neither was true: the raw one is compared — precisely because floored
  almost removed AC13. The test `the two questions genuinely diverge…` measures the divergence on a
  reachable input (a closed row, a downward edit) and records which of the two questions
  the predicate follows. Verified by switching the predicate to floored: the test goes red.

### Round 5 — taken out of this PR (not silence, a decision)

- **SR-L-2 — the preview and the write read the row with different queries.** Not fixed here by the coordinator's
  decision: `spec-review` assessed it as a pre-existing accepted trade-off from #603, a separate
  backlog item was opened. The argument I agree with: reducing two reads to one is an independent
  task, and fixing "one divergence per round" leaves the cause in place. (I raised this same observation
  in the round 4 report — I record that it was accepted and addressed, not lost.)
- **CR-M-4 — the classification of the edit is smeared over five `const`s.** A judgment about readability, moved
  into proposals for future tasks of the series. A fourth pass into the same function for readability on a
  PR that has just gone green is a risk disproportionate to the benefit.

---

## Verification (Coder before `git push`)

1. `git rev-parse --show-toplevel` — matches the issued worktree; the line
   `Worktree: <path> (verified)` in the report.
2. `git diff HEAD --name-only` — only files from "Concrete changes".
3. For each AC — `grep -n "<pattern>" <file>` confirms presence.
4. `git diff origin/main -- apps/api/src/finance/company-account-balance.ts` — terms 1–8
   unchanged (by eye, line by line).
   4b. The three greps from AC9 are done, the output is attached to the PR body. The task does not require access to the live DB —
   if you catch yourself thinking "I should look at prod", reread AC9: it explains why the
   answer is obtained from the sources.
5. Run: `pnpm typecheck`, `mcp__eslint__lint-files` on the changed ones, unit specs,
   integration — on a scratch DB, `pnpm --filter @crm/e2e test`.
6. `MUTATION_BASE_SHA=$(git rev-parse origin/main) node scripts/devops/mutation-gate.mjs --changed`
   — and **read the log**, not only the verdict (see test AC No. 3).
7. For each test from the table — attach to the PR body the **actual failure output** on the version without
   the fix. A statement without output = an unfulfilled item.
8. Commit message:
   ```
   ac_verified: 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
   ```
   (`vision:` is not needed — the UI is not touched in this task.)
