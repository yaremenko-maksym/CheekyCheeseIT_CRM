# 2026-08-23 — Addendum to the cascade ADR: the ledger term, the percent snapshot, the mechanism for recording a dependency

## Status

Proposed. An addendum to `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` —
the main ADR is **not changed**. Here three places are built out that were left in it as a
recommendation rather than a construction, and that are needed by task 3 (applying the cascade).

Zone: only `docs/architecture/**` + `.claude/tasks/task-cascade-apply.md`.
`apps/**` and `packages/**` were not touched.

> **On line numbers.** There are deliberately none in a long-lived document
> (`.claude/rules/common/doc-durability.md`): everything is addressed by the **symbol name**. The main ADR
> was written against `166897df`; since then #598, #599, #600, #603 have landed in `main`, and its references
> of the form `file:NNNN` have already shifted. Below each conclusion is marked with **what exactly was read**.

## Context

Tasks 0, 1, 2 and 4 are in `main` (#598, #599, #603, #600). Next — task 3: the first thing that
actually writes money. The main ADR left three questions open:

1. the exact form of the 9th ledger term compensating the rollback `PAID → PENDING_PAYMENT`;
2. where to return the percent snapshot on the rollback;
3. what records the dependency "code A is correct while code B holds the invariant".

Below — the answers. Each with confidence and with a note of what was read.

---

## Answer 1. The ledger term on the rollback `PAID → PENDING_PAYMENT`

### 1.1. What holds the debit today (read)

`sumLedgerTerms` (`company-account-balance.ts`) — eight terms. A debit on the rows that
the cascade returns to `PENDING` is given by exactly two:

| Term | Predicate                                                                                  | What it sums |
| ---- | ------------------------------------------------------------------------------------------ | ------------ |
| 7    | `type='SENIOR_INCOME' ∧ status='PAID' ∧ fundingSource='COMPANY_ACCOUNT' ∧ currency='USDT'` | `amount`     |
| 8    | `type='PAYOUT_DROP' ∧ status='PAID' ∧ fundingSource='COMPANY_ACCOUNT' ∧ currency='USDT'`   | `amount`     |

Read: the body of `sumLedgerTerms` in full (eight calls to `sumAmount`), `sumAmount`
(sums `nonDeletedTransactions.amount`), `COMPANY_TERM_TYPES_UNGATED` /
`COMPANY_TERM_TYPES_FUNDING_GATED`.

### 1.2. The invariant on which everything else stands — and who actually holds it

> **After any settle of a company-funded row the condition `amount == settled_amount` holds.**

A breakdown by the code of `settleByCompany` (read in full: the DROP conversion block, the computation of
`settledAmountThisSettle`, the `.set()` of the flip):

- **DROP — proven inside the method.** The flip writes `amount: String(paidAmount)`, and
  `settledAmountThisSettle = paidAmount!`. The same number, the same variable.
- **SENIOR — NOT proven inside the method.** The flip does not touch `amount` (the object with the amount
  is spread only under `isDropObligation`), and `settledAmountThisSettle = parseFloat(obligation.amount)`.
  That is, the accumulator is taken from `pending_obligations.amount`, and `amount` remains what is in
  `transactions`. The equality of these two is **nowhere checked in `settleByCompany`**.
- The accumulator is incremented DB-native: `coalesce(settled_amount, 0) + delta`. On the first
  settle `coalesce` gives 0, so `settled_amount = delta`.

**What the `claimedAmount` reconciliation is NOT.** `claimedAmount` is `claimed[0].amount`, that is,
`pending_obligations.amount`, read by the `.returning()` of the same conditional UPDATE, and it is reconciled
with `obligation.amount` — the pre-transactional read of **the same obligations row**. It
proves exactly one thing: "the obligation amount did not change between the read and the claim". There is
no comparison of `transactions.amount` with `pending_obligations.amount` in the method at all.

**So on the senior branch this is an invariant with EXTERNAL holders, not a consequence of the settle code:**

| Holder                                       | What it guarantees                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `bookCompanyObligations`                     | both copies are inserted equal (`roundShareAmount(...)` once, written to two tables) |
| `adminUpdateTransaction` after task 0 (#598) | an amount edit updates both copies, scope `status='PENDING'`                         |
| _(nothing)_                                  | rows edited **before** #598 — a discrepancy there could already have occurred        |

The third row is the price of silence. If the copies diverged, the senior-settle will take `settled_amount`
from `obligation.amount`, while term 7 will debit `transactions.amount` — the numbers are different, and **term 9
will return not the debit that disappeared**. An error "in the plus", exactly risk #4 of AC6.

**Therefore the dependency is expressed by a check, not an assumption** (answer 3, §3.1). Before a rollback of a
company-funded derivative the cascade is obliged to reconcile `transactions.amount` with `settled_amount`
(with the same `amountsDiffer` that describes "the same monetary value" throughout the project) and on a
discrepancy **refuse out loud**, with text naming the invariant and its holders. This is the only
place where we would otherwise deviate from fail-loud, and it is also the point of support of term 9.

The requirement is carried into the task as a separate AC6 item and a separate test (risk 17).

Task 3 is obliged to **preserve** this invariant — it is the only reason terms 7/8 can be left untouched (see 1.10).

### 1.3. The exact condition of the 9th term (Confidence: HIGH)

```
type IN ('SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT')
AND status           = 'PENDING_PAYMENT'
AND funding_source   = 'COMPANY_ACCOUNT'
AND settled_currency = 'USDT'
```

**it sums `settled_amount`** (not `amount`), the sign — **minus**, like terms 7/8.
The source of rows — the same VIEW `nonDeletedTransactions` as for the other terms.

Three decisions within the condition, each justified:

- **`settled_amount`, not `amount`.** After the rollback `amount` already equals the **new** share, while from
  the ledger the debit of the **old** one left. We need to return the old one, and it physically lies only in
  the accumulator. This also makes the term robust to a series of edits in a row: however many times the admin
  edits the income, `settled_amount` does not change, and the debit remains exactly what was removed.
- **`settled_currency`, not `currency`.** The currency label of the summed column is `settled_currency`.
  Taking `currency` would mean checking the label of a **different** number. Within the term's set both are
  always `USDT` (see 1.5), but we must check the one that labels what is summed.
- **There is NO `settled_amount > 0` predicate.** It is redundant: `settled_currency = 'USDT'` already
  cuts off `NULL` (an SQL comparison with NULL gives NULL), and a row with an honest zero (an obligation with
  a 0% share — `settledAmountError` allows this, read) contributes 0 to the sum. A redundant
  predicate gives an un-killable mutant and buys a gate figure, protecting nothing — exactly the form
  of backlog item 96.

### 1.4. Coincidence of sets: term 9 == the rows that lost the debit (Confidence: HIGH)

An equality is required, not "approximately": an undercount = a hole, an overcount = double counting.

**(⊆) Every row that lost the debit falls into term 9.** A row had a debit ⟺ it was in
term 7 or 8: `type ∈ {SENIOR_INCOME, PAYOUT_DROP}`, `status='PAID'`,
`fundingSource='COMPANY_ACCOUNT'`, `currency='USDT'`. The rollback (task 3) changes exactly two fields:
`type` → the paired `*_PENDING_PAYOUT`, `status` → `PENDING_PAYMENT`. `fundingSource` is **preserved**
(AC3 item 4 of the main ADR: proof that the payout happened), `currency` is **not touched**
(a currency edit is forbidden, AC5 item 3). `settled_currency` = `'USDT'` — per 1.5. All four
predicates of term 9 are satisfied.

**(⊇) Every row of term 9 previously had a debit.** We need to show that
`type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT} ∧ fundingSource='COMPANY_ACCOUNT'`
is reachable **only** via a flip + rollback. Read `bookCompanyObligations` — both branches of the IOU insert
(senior and drop) list the fields explicitly, and `fundingSource` is **not** among them, that is, at
the birth of an IOU the column is `NULL`. The only write of `fundingSource = COMPANY_ACCOUNT_FUNDING_SOURCE`
on these rows is the flip of `settleByCompany`, and it also moves `type`/`status` into the PAID form.
So `*_PENDING_PAYOUT` + `COMPANY_ACCOUNT` = "was PAID company-funded, then rolled back".
Additionally `settled_currency='USDT'` requires a settle that happened (the column is written only there).

**The sets coincide.**

**The scope of this proof is the ROLLBACK, and only it.** It relies on the fact that a row's
`funding_source` does not change, and this is true for the rollback (AC6 requires preserving it). But
`funding_source` is a **live column**, and the next settle overwrites it. A second settle from
another source removes the row from both term 7 and term 9 at once. This step is **not
considered here deliberately** — it is examined separately in 1.13, where its own invariant and
its own refusal are introduced for it. The set equality above by itself does not cover it, and reading
1.4 as covering the second settle is not allowed.

### 1.5. Why within term 9 the currency is always USDT (Confidence: HIGH)

Read the `currency` resolution block in `settleByCompany`:

```
useCompanyAccount    = funding ? funding.fundingSource === 'COMPANY_ACCOUNT' : isCompanyDebt
debitsCompanyAccount = useCompanyAccount && isCompanyDebt
if (funding?.fundingSource === 'ADMIN_PERSONAL') { … }        // branch A
else if (debitsCompanyAccount) { currency = 'USDT' }          // branch B
fundingSource:    debitsCompanyAccount ? COMPANY_ACCOUNT : null
settledCurrency:  currency
```

Branches A and B are mutually exclusive by construction: in branch A `useCompanyAccount === false`, so
`debitsCompanyAccount === false`. Consequently
**`fundingSource='COMPANY_ACCOUNT'` ⟹ `currency='USDT'` ⟹ `settled_currency='USDT'`.**

The converse implication is also useful: **any non-USDT settle is `ADMIN_PERSONAL` with
`fundingSource = null`**, that is, a row outside the ledger terms entirely. The off-currency drop case
(an obligation closed in UAH) does not touch the company account either before or after the rollback.

### 1.6. Double counting on a repeat settle: there is no intersection window (Confidence: HIGH)

**Logically.** `status` is one column with one value. Term 9 requires `PENDING_PAYMENT`,
terms 7/8 — `PAID`. The intersection is empty. Independently of that it is also empty by `type`: `SENIOR_INCOME`
vs `SENIOR_PENDING_PAYOUT` — different values of one enum. **Two independent discriminators,
both unambiguous.** A row drops out of term 9 by the very same UPDATE by which it enters term 7/8
(the flip changes `type` and `status` in one `.set()`), so the transition is atomic at the row level.

**Arithmetically.** Before the rollback the debit = `amount(old share)`. `settled_amount` equals it — by
the invariant 1.2, **checked by the cascade before the rollback**, not assumed.
After the rollback term 9 gives `settled_amount` = the same number. **The balance delta is exactly 0.**
After the top-up (SENIOR): `amount` = the new full share, `settled_amount = prior + owedNow` =
the new full share (see 1.11), term 7 gives the new full share, term 9 falls off. The debit delta
= `owedNow` = exactly what physically left.

**On isolation.** The eight SUMs fly via `Promise.all` on one handle; on the gate paths this is
a `DrizzleTx` in READ COMMITTED, where each statement takes its own snapshot. A row that moved between
the terms **between two statements** may be counted twice (a debit overcount ⇒ the balance is understated ⇒
the gate refuses — the fail-closed direction) or zero times (the balance is overstated — **this is the dangerous
direction**). It is cured by the same mechanism by which the project already serializes debits: **the cascade
is obliged to take `lockCompanyAccount(dbtx)`**, and then no gate reads the balance until the cascade
is committed. The order of acquisition is critical — see 1.9.

### 1.7. The overpayment branch: `amount` never drops below `settled_amount` (Confidence: HIGH) — mandatory to follow

**The general rule from which both branches follow:**

> **The `amount` of a derivative is never written below its `settled_amount`.**
>
> - obligation `PAID` ⇒ **do not write at all** (there `amount == settled_amount` per 1.2, nothing to write);
> - obligation `PENDING` with a non-empty accumulator ⇒ write `max(newAmount, settledAmount)`,
>   and when the `max` triggers — journal the overpayment.

Below — why, on the original case AC3 of the main ADR: when `new_share ≤ settled_amount` we do not return the row to
`PENDING`, it remains `PAID`. The question: whether to update the `transactions.amount` of this row.

**Answer: no. Neither `transactions.amount` nor `pending_obligations.amount` of this row is touched.**

The argument is arithmetic, not stylistic. Term 7/8 debits `amount`; physically what left was
`settled_amount`. Writing `amount := new_share` (the smaller) means under-debiting the ledger by exactly
the overpayment: **the company account balance will grow by the overpaid, while the money has already
left.** This is the same "in the plus" defect for which term 9 is introduced, only brought in from the other
side — and term 9 does not catch it, because the row remained `PAID` and does not fall into term 9.

**The coder will update `amount` "helpfully" if it is not explicitly forbidden.** In the task this is a separate
prohibition with a separate test (risk 16), not a note.

Consequences to know in advance:

- After an overpayment `amount ≠ roundShareAmount(income, snapshot)` — **deliberately**. This is a record
  of the fact "we paid 2000 for what turned out to be an obligation of 1000". Therefore the symmetric
  check AC6 #2 ("`obligation.amount == roundShareAmount(income, snapshot)`") applies
  **only to derivatives for which the plan wrote something**, and on the overpayment branch it is not
  asserted. Otherwise the test would cement the wrong thing.
- The `pending_obligations` of a closed obligation is structurally unreachable: the UPDATE from task 0 is
  scoped to `status='PENDING'` (read). Nothing additional needs to be forbidden — but this `WHERE` must
  not be weakened.
- The case `new_share == settled_amount` falls here too (`needsReconfirm` of the resolver — strictly
  `newAmount > settledAmount`) and is a no-op by construction: `amount` already equals
  `settled_amount` per 1.2, nothing to write.
- **The second branch of the rule — an already rolled-back derivative** (obligation `PENDING`, the accumulator
  non-empty). There `isSettled === false`, so neither `needsReconfirm` nor the prohibition above triggers,
  and a naive implementation would write `amount := newAmount` below the accumulator. The consequence is not an
  overstatement of the balance (the row is in term 9, which counts by `settled_amount`), but a **deadlock**: the remainder to top up
  becomes negative, and there is nothing to close the obligation with. Hence `max(newAmount, settledAmount)`
  — see 1.14.

### 1.8. The currency guard: the rollback and term 9 cannot bring it down (Confidence: HIGH)

Read `assertNoOffCurrencyCompanyRows`. Its predicate:

```
status = 'PAID' AND currency <> 'USDT'
AND ( type IN COMPANY_TERM_TYPES_UNGATED
      OR (type IN COMPANY_TERM_TYPES_FUNDING_GATED AND funding_source = 'COMPANY_ACCOUNT') )
```

A rolled-back row does not pass **by two independent predicates**:

1. its `status` is `PENDING_PAYMENT`, while `PAID` is required;
2. its `type` is `SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT`, while both type lists
   (`COMPANY_TERM_TYPES_UNGATED = ['COMPANY_DEPOSIT','DIVIDEND_TO_ADMIN']`,
   `COMPANY_TERM_TYPES_FUNDING_GATED = ['PAYOUT','ADMIN_INCOME','SALARY','EXPENSE','SENIOR_INCOME','PAYOUT_DROP']`)
   do not contain them.

Plus a third, independent one: the rollback does not change `currency`, and before the rollback it was `USDT` (otherwise the row
would not be in term 7/8). **The four money gates are safe.**

**But term 9 opens a new blind spot for the guard** — and this is worth saying explicitly. The guard
exists because a company-shaped row in a foreign currency **silently falls out** of the sum. Term 9
introduces a new class of company-shaped rows (`*_PENDING_PAYOUT` + `COMPANY_ACCOUNT`), and its
filter `settled_currency='USDT'` drops such a row just as silently. Today it is unreachable
(1.5), but this is exactly that "trap for a FUTURE write path" by which the guard justifies itself.

**Recommendation (a separate, independently assessed AC): add to the same guard query an
OR branch**

```
status = 'PENDING_PAYMENT' AND funding_source = 'COMPANY_ACCOUNT'
AND type IN ('SENIOR_PENDING_PAYOUT','DROP_PENDING_PAYOUT')
AND settled_amount IS NOT NULL AND settled_amount <> 0
AND (settled_currency IS NULL OR settled_currency <> 'USDT')
```

`settled_currency IS NULL` is included deliberately: "there is no label" — not "the label matches". The same argument
by which in round 2 of #603 `settledCurrency !== null` was removed from the resolver.

**The price of the branch and why it does NOT need to be insured by querying the live DB.** The branch extends the refusal condition
at four money gates, so the question "aren't there already such rows in prod" is legitimate. The first
edition of this document answered it with a read-only query before the merge. That was **methodically
wrong**: the executor of task 3 has no access to prod data (prod is on a VPS, no SSH —
`project_deployment_plan`; the local `crm_db` in docker is empty; `crm_qa` is a QA base and does not answer about real
data). An instruction that cannot be executed produces either a silent skip, or
a "zero" obtained from the wrong base — a confident answer where there is no answer.

The correct insurance of the same claim is **not data, but code**. The set of rows of the branch is empty
structurally, and this is verified by a grep:

1. `status: 'PENDING_PAYMENT'` is written by exactly **four** places (by a grep of the literal with an assignment,
   without specs): two insert ones in `bookCompanyObligations` (the senior IOU and the drop IOU) and two in
   the payout path (`createPayoutRequest` — marking the selected incomes and inserting the placeholder
   `PAYOUT`). None of them writes `fundingSource`.
2. `fundingSource: COMPANY_ACCOUNT_FUNDING_SOURCE` on a row of type `*_PENDING_PAYOUT` is written by
   a **single** place — the flip of `settleByCompany`, and it by the same `.set()` moves `status` to
   `'PAID'`, and `type` — to the PAID form.
3. The two types from the branch condition (`SENIOR_PENDING_PAYOUT`, `DROP_PENDING_PAYOUT`) are created **only**
   by the inserts from item 1. The payout-path rows have other types and do not fall into the condition —
   the constraint by `type` here is load-bearing, not decorative.

Consequently the combination `type ∈ {SENIOR_PENDING_PAYOUT, DROP_PENDING_PAYOUT} ∧
funding_source='COMPANY_ACCOUNT'` was **never produced by this code**: before task 3 there is in the system
no path at all that returns a row from `PAID` to `PENDING_PAYMENT`. A data query is not needed —
the origin is checked, not a sample, and the check is executable without access to anything but the
sources.

This is the same technique as in the guard itself: it exists as a trap for a future write path, not
as a reaction to found rows.

### 1.9. The order of lock acquisition (Confidence: HIGH) — otherwise a deadlock on the money path

Read all four places that take `lockCompanyAccount`, and the order of locks in
`settleByCompany` / `adminUpdateTransaction`.

- `createExpense`, `paySalary`, `createDividend`: the advisory-lock **first thing**,
  they do not touch `pending_obligations` at all.
- `settleByCompany`: first the conditional UPDATE `pending_obligations` (takes a row-lock),
  **then** `lockCompanyAccount`, **then** the UPDATE `transactions`.
- `adminUpdateTransaction` (after #598): `pending_obligations`, then `transactions` — this
  order in #598 was chosen deliberately against an ABBA with `settleByCompany` (MED-2 of that review).

Hence the **mandatory order for the cascade**, exactly repeating `settleByCompany`:

```
1. pending_obligations  — SELECT … FOR UPDATE (ORDER BY id) and/or the conditional UPDATE
2. lockCompanyAccount(dbtx)
3. transactions         — SELECT … FOR UPDATE (ORDER BY id), then UPDATE
```

Any permutation gives an ABBA with `settleByCompany` and a 40P01 (Postgres will kill one of the sides) —
a 500 on the money path at the moment of a race of an edit and a debt closing. `ORDER BY id` is needed against
a deadlock of two cascades with each other on intersecting sets of rows.

### 1.10. The choice: a 9th term, not a compensating row (Confidence: HIGH)

The decision is made by me, as the owner asked. **A term.**

| Criterion                | A 9th term                                            | A compensating row                                                                       |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Idempotency              | not needed: a term is a derivative of the row's state | needs its own (a double rollback = a second row = a double debit)                        |
| The unique index L2      | not affected                                          | `uq_transactions_source_income_drop_link` forbids a second drop-row from the same income |
| Reversibility of an edit | automatic: `amount` changes — the term follows        | the row goes stale on the next edit, needs a recompute or a reversal                     |
| Auditability             | the formula remains one and only                      | rows appear whose meaning is visible only in a pair with another row                     |
| Cost                     | one SUM (a ninth query instead of eight)              | inserts + deletes + a journal + its own races                                            |

The decisive argument is the second: a compensating row for the drop branch is **physically impossible** without
revising the unique index, and revising the index for the sake of a compensation means opening
the way to second drop-rows in general. This is more expensive than one SUM.

### 1.11. What follows from this for `settleByCompany` (the top-up)

Term 9 is correct only while the invariant 1.2 holds. A repeat settle breaks it if it pays
the **full** amount of the obligation a second time: `settled_amount` will go to `2 × amount`.

**Task 3 makes the top-up for the SENIOR branch and refuses out loud for the DROP branch.** (Confidence: MED
— this is a decision about the task's boundary, not about money; a revision costs a separate task, not a redo.)

- **SENIOR.** `owedNow = claimedAmount − coalesce(settled_amount, 0)`; the funds-sufficiency gate
  measures `owedNow`; `settledAmountThisSettle = owedNow`; `amount` is still not
  touched (it already equals the full new share the cascade wrote). Result:
  `settled_amount = prior + owedNow = amount` — the invariant 1.2 is preserved. This is three lines
  of arithmetic in one currency: a senior obligation is always USDT, the conversion does not enter this branch
  (the whole conversion block is under `isDropObligation`).
- **DROP.** Refusal: `settled_amount > 0` ⇒ `BadRequestException`. The reason is not laziness: on a drop-row
  `amount` is a **fact of payment in the payment currency**, and next to it lies a triplet
  `originalAmount`/`originalCurrency`/`exchangeRate`, where `exchangeRate = paid / original`.
  A partial top-up makes `amount` cumulative, while the triplet describes **one** conversion —
  the invariant `amount = originalAmount × exchangeRate` stops holding. What the triplet should mean
  on a row closed by two payments at different rates is a separate decision (store it
  per-payment? describe the last one? move the debit of terms 7/8 to `settled_amount`?), and its
  price is an edit of a block that passed three rounds of security-review. Mixing this with the core of the cascade
  means getting a PR without one clear acceptance criterion (AC5 item 10 of the main ADR).
- **`owedNow == 0` — a lawful idempotent closing, not an error.** The first edition of this
  document prescribed a refusal; that created a deadlock (1.14). Zero means "on the obligation already
  as much has been paid out as it costs", and the closing in this case is ledger-neutral:
  the row leaves term 9 (`−settled_amount`) and comes into term 7 (`−amount`), and these two numbers
  are equal per 1.2. The refusal remains only on `owedNow < 0`, and rule 1.7 (`max`) makes this
  state unreachable.
- **The price of deferring 3b has become higher than in the first edition.** From 1.14 it follows that the DROP refusal
  moves from the moment of the top-up to the moment of the **edit**: an income whose drop share is already paid out
  becomes non-editable until 3b. This is still the correct decision (a deadlocked row is worse than an
  honest refusal), but now this limitation is visible to the owner at once, not after the rollback.

A check of the invariant 1.2 after the top-up is a mandatory test (risk 6).

### 1.12. An edit of a `PAID` row that ITSELF participates in a term (Confidence: HIGH)

A security-review finding on #607 (SR-H-1). The addendum and the task examined the cascade "source →
derivatives" and **never once asked what happens to the ledger when the row that itself stands in a
term is edited**. And the main ADR directly lists flipped obligations among what becomes
editable: "not only the source becomes editable, but the derivative itself".

The mechanics of the hole (verified by the code): the flip of `settleByCompany` sets `payoutRequestId: null`, so
guard 2 does not hold such a row; `originalAmount` on the senior branch remains `null` (the object with the amount
and the triplet is spread only under `isDropObligation`), so the AC5 §5 guard does not catch it;
it has no derivatives, so the `amount == settled_amount` reconciliation from AC6, bypassing
`plan.derivatives`, **is not performed at all**. Term 7 debits by `amount` — an edit 260 → 26
reduces the debit by 234, and term 9 does not compensate (it requires `PENDING_PAYMENT`). The balance grows
by 234.

An irony worth recording: **the 1.7 branch refuses to make exactly such a write one level
lower and for exactly this reason.** One level higher the prohibition was absent — because the task's boundary was
drawn by the row's role in the cascade, not by its role in the ledger.

**The boundary that needs to be drawn (and this is the answer to the question "which types"):**

> Editing `amount` on a `PAID` row is allowed when `amount` is **our own record of a value
> that could have been entered incorrectly**. It is forbidden when the number has a **second
> carrier that the edit does not move**: the edit then does not fix a record but pits two
> records of the system against each other.

The second carrier is not a metaphor but an enumerable list of columns, so the boundary is expressed
by predicates, not a description:

| Second carrier                            | Refusal predicate                                                                       | Whom it closes                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| a payment fact with a rate                | `original_amount IS NOT NULL`                                                           | `SALARY`, `PAYOUT_DROP`                   |
| the accumulator of actual payouts         | `settled_amount IS NOT NULL`                                                            | `SENIOR_INCOME`, `PAYOUT_DROP` after #599 |
| a closed obligation (legacy, before #599) | a `pending_obligations` exists with `source_transaction_id = <row> AND status = 'PAID'` | the same rows before #599                 |
| an amount reconciled with the blockchain  | `type = 'COMPANY_DEPOSIT'`                                                              | term 1                                    |
| an on-chain transfer, reconciled exactly  | guard 1 (the `PAYOUT` family) — **already exists**                                      | term 2                                    |

A completeness check — over all eight terms, not by intuition:

| Term | Row type                | How an `amount` edit is protected                                                                        |
| ---- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | `COMPANY_DEPOSIT`       | **a NEW refusal by type** (C4 of the main ADR: the amount is observed in the chain)                      |
| 2    | `PAYOUT` (CA)           | guard 1 — exists                                                                                         |
| 3    | `ADMIN_INCOME` (CA)     | **edited deliberately**, the ledger follows the number — this is the point of the feature                |
| 4    | `DIVIDEND_TO_ADMIN`     | **edited**, there is no second carrier of the amount (verified: neither `original_amount` nor `tx_hash`) |
| 5    | `SALARY` (CA)           | `original_amount` — stamped **unconditionally** on every `paySalary`                                     |
| 6    | `EXPENSE` (CA)          | **edited**, there is no second carrier                                                                   |
| 7    | `SENIOR_INCOME` (CA)    | **a NEW refusal**: `settled_amount` / a closed obligation                                                |
| 8    | `PAYOUT_DROP` (CA)      | `original_amount` (stamped on every drop-settle) + the same new refusal                                  |
| 9    | `*_PENDING_PAYOUT` (CA) | not `PAID`; this row is managed by the cascade                                                           |

Rows 3, 4, 6 remain editable **deliberately**: there an edit means "we recorded the wrong
number", and the ledger is obliged to follow it. This is not a gap — it is exactly the work for which
the task exists. Written explicitly so that the next reader does not "finish closing" them for the company.

Terms 7 and 8 in the table show that the predicate "there is an accumulator" and the predicate "there is a payment
fact" intersect on `PAYOUT_DROP`. This is normal: the refusal is a disjunction, the intersection of predicates breaks nothing and
makes the protection two-layered.

### 1.13. A top-up from a different funding source (Confidence: HIGH)

A security-review finding on #607 (SR-H-2). Terms 7, 8 and 9 key on the **live** column
`funding_source`. The rollback preserves it (AC6 requires it), but the next settle overwrites it:
`fundingSource: debitsCompanyAccount ? COMPANY_ACCOUNT : null`. A reconciliation of the new source with the already
paid one is nowhere.

The scenario is entirely in USDT, so the currency guard `sourceSettledCurrency !== currency` stays silent:
a company-settle 260 → rollback (term 9 returns 260) → a top-up from the admin's personal account ⇒
`funding_source` becomes `null`, and the row falls out **both of term 7** (needs `COMPANY_ACCOUNT`),
**and of term 9** (needs `PENDING_PAYMENT`). 260 USDT that really left the company account
disappear from the ledger. The mirror order gives term 7 = the full amount of the obligation on a partial
payment by the company.

The root is named correctly: terms 7/8 debit `amount` — "how much the row costs" — and not "how much
a specific pot paid". Before this task these two coincided, because the row was paid exactly
once. **A top-up removes the coincidence.**

Two exits, and I choose the first:

- **(chosen) A refusal out loud on a source change.** Restores the invariant rather than bypassing it:

  > **All settles of one row happen from one funding source, and
  > `funding_source` is its record.**
  > Held by: the flip (writes), the rollback (preserves), the new refusal (does not let it become multi-valued).
  > The point of support: terms 7/8/9 key on this column.

  Predicate: `priorSettled > 0 AND (debitsCompanyAccount ? 'COMPANY_ACCOUNT' : null) !== source.funding_source` ⇒
  `BadRequestException`. Requires one new field in `resolveSource` (`sourceFundingSource`) and
  stands literally next to the refusal on mixing accumulator currencies — the same form, the same argument, the same
  method.

- **(rejected) Key the term not on a live column.** Would require a column
  `settled_funding_source` (modeled on `settled_currency`) and — what decides it — **edits to terms
  7 and 8**, which this whole document commits to not touching (1.10, 1.2). The price is incommensurable with
  the gain: there is no point in mixing pots on one obligation — it is one debt to one person, and
  "who pays" here is one decision, not a decomposition by sources.

If mixing pots ever becomes needed — the escape is exactly the same as for the currency: a separate
accumulator column, and then the refusal is lifted along with it.

### 1.14. The cascade does not roll back what cannot be closed back (Confidence: HIGH)

`SR-M-3` and `SR-M-4` from the same review — not two bugs, but one consequence of an unwritten rule.
Both look the same: a row is returned to `PENDING`, and there is nothing to close it with afterwards.

> **Before rolling back a derivative the cascade is obliged to make sure that a subsequent settle on it is possible
> by the AC10 rules. Not possible — a refusal out loud, nothing is written.**

Why a refusal and not "roll it back, and they will close it later": a reopened obligation is a **statement about
a debt**. `pending_obligations.amount` enters the money gate and the aggregates, and a row that cannot be
closed asserts a non-existent debt to a person. A deadlock is worse than a refusal: a refusal is reversible by nothing,
a deadlock is reversible only by a data edit.

Three cases where a closing is impossible:

| Case                                                                        | What to do                          | Why                                                                       |
| --------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| a DROP derivative with a non-empty accumulator                              | refuse **on the edit**              | a top-up on drop is not implemented (1.11)                                |
| `settled_currency ≠` the obligation currency (a cross-currency accumulator) | refuse **on the edit**              | the remainder is incomputable — subtraction from different units (SR-M-3) |
| `newAmount < settled_amount` on an **already rolled-back** row              | do not roll back; write `max` (1.7) | otherwise `owedNow < 0` and there is nothing to close with (SR-M-4)       |

**This cancels one of my former A1 assumptions.** In the first edition `NON_USDT_CURRENCY` was
declared non-blocking — "rows outside the ledger terms, a prohibition is more expensive than an honest `remainingToPay: null`".
The argument rested on the premise "the top-up works". For drop it does not work, so the premise disappeared, and
with it the conclusion. The assumption is replayed: **`NON_USDT_CURRENCY` on a closed obligation
blocks the application.**

Together with 1.7 and 1.11 this gives a closed system: the cascade rolls back only what is closeable;
`amount` is never below the accumulator; `owedNow` is therefore always `≥ 0`; `owedNow == 0` closes the
obligation idempotently and ledger-neutrally. No deadlock states remain.

---

## Answer 2. Where to return the percent snapshot

**Decision: write the percent back to `seniorSharePercent` / `dropSharePercent` (by the derivative's
type), do not touch `settled_share_percent`, leave `*SharePercentSource` `NULL`.**
(Confidence: HIGH — this is not a choice by taste, it is a requirement of already-merged code.)

### 2.1. Why it is forced, not chosen

Read `resolveDerivative` (`packages/shared/src/schemas/edit-cascade.ts`):

```ts
const isSettled = derivative.obligation?.status === 'PAID'
const sharePercent = isSettled ? derivative.settledSharePercent : derivative.sharePercent
```

and `loadCascadeSnapshot` (`transactions.service.ts`), which fills
`sharePercent: d.seniorSharePercent ?? d.dropSharePercent ?? null`.

The rollback moves the obligation to `PENDING` ⇒ on the **next** preview `isSettled === false`
⇒ the resolver reads `derivative.sharePercent`, that is, the **live** columns. If they are left `NULL`,
the resolver will return `NO_SHARE_SNAPSHOT` and `newAmount: null` — the just-rolled-back row will become
non-recomputable. This is a regression introduced by the rollback itself.

The alternative "read `settledSharePercent` on PENDING too" would require changing the condition in
the resolver, that is, redefining the meaning of `isSettled` through two different states of one row —
and doing it in a package that task 3 by the decomposition does not rewrite.

### 2.2. Why it is safe for the GROSS↔NET discriminator (C1)

Checked **all** non-spec readers of `transactions.senior_share_percent` /
`transactions.drop_share_percent` (by a grep of both names, filtering out the same-named columns
of `users`/`projects`/`teams` and the seed):

| Reader                                                                   | Entry condition                                          | Dangerous on `*_PENDING_PAYOUT`?       |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------- |
| `BalanceService.getSeniorBalance`                                        | `type === 'SENIOR_INCOME' ∧ status === 'PAID'`           | no — both conditions false             |
| `BalanceService.getTotalEarned` (the SENIOR branch)                      | `type === 'SENIOR_INCOME'`, the set is already PAID-only | no                                     |
| `TransactionsService.getSeniorSummary` (`paidIncomeRows`)                | `type='SENIOR_INCOME' ∧ status='PAID'`                   | no                                     |
| `TransactionsService.createPayoutRequest`                                | rows strictly `status='VALIDATED'`                       | no                                     |
| `computeDropAggregate` and the drop-snapshot branches                    | `DROP_INCOME` / `PAYOUT_DROP`                            | no                                     |
| `TransactionsService.loadCascadeSnapshot`                                | any derivative                                           | **yes — and this is the desired read** |
| `TransactionsService.mapTx`, `PendingSettlementService.toTransactionDto` | any row                                                  | no — pass-through to the DTO           |

No arithmetic consumer looks at these columns on a `*_PENDING_PAYOUT` row.
The C1 danger materializes only when the row again becomes
`SENIOR_INCOME` + `PAID` — and this transition is made by `settleByCompany`, and it **zeroes both columns
and both `*Source`** in the same `.set()` (read). The loop closes itself:

```
booking → the percent is written
settle  → the percent is zeroed, the snapshot went into settled_share_percent
rollback → the percent is restored from the snapshot   ← this is task 3
settle  → the percent is zeroed again                  ← existing code, no change needed
```

`settleByCompany` does not need to be edited for this: it takes the snapshot from the **current**
value of the column via `resolveSource`, and after the rollback the current value is non-empty and correct.

### 2.3. Where to take the value from and what about `*Source`

- **The value** is taken from `CascadeDerivativePlan.sharePercent` — from the plan, not from the row
  directly. The plan is the decision (AC4 "preview == fact"); reading the column bypassing the plan means
  having a second description of one rule.
- **The column** is chosen by the derivative's type: `SENIOR_PENDING_PAYOUT` → `seniorSharePercent`,
  `DROP_PENDING_PAYOUT` → `dropSharePercent`. Exactly as `bookCompanyObligations` writes them.
- **`settled_share_percent` is not touched.** It is overwritten on every settle and means
  "the percent of the last closing"; the rollback is not a closing.
- **`*SharePercentSource` remains `NULL`.** Task 1 did not save an origin snapshot, and
  making one up is not allowed (backlog item 70: emptiness is information). There is no CHECK constraint
  tying the value and the source in the schema — verified by a grep of
  `senior_share_percent` / `drop_share_percent` in `schema.ts`. The only readers of `*Source` are
  the DTO mapping and the drop-aggregate branch by `DROP_INCOME`; neither falls on `NULL`.

---

## Answer 3. The mechanism for recording "code A depends on an invariant held by code B"

**One mechanism: the dependency is expressed by an executable check at the point of support, not by text next to it.**
(Confidence: MED — the mechanism eliminates the silently-wrong outcome, but does not guarantee that every
support is declared at all; the honest boundary is described in 3.4.)

### 3.1. The formulation

> If the correctness of module A depends on a condition provided by module B, A has exactly
> two lawful moves:
>
> 1. **Read the actual value from B.** Then the dependency is gone — A follows the data.
> 2. **Check the condition at the point of support and refuse out loud** (`assert*` + an exception whose text
>    names the invariant and the one who holds it).
>
> A comment, a test-guard on a literal in B, and an ADR entry replace neither of these.

### 3.2. Why exactly this, and not the alternatives

- **A comment.** Backlog item 85: the phrasing "mirrors X exactly" is a marker of a third copy.
  A request to the reader is not a mechanism by definition: it fires only if the
  reader read it, and the author of the next task opens **their** file, not someone else's.
- **A test-guard on a literal in B.** Item 92: proves that the literal is what it is, and says nothing
  about a remote consumer. Worse: it **creates an appearance** of protection and survives the
  deletion of the consumer itself.
- **An invariant registry + a CI check.** This is a third copy of the rule living far from the code, and CI
  will only be able to check the match of the text — the same defect as the literal guard, plus
  its own false positives. Rejected.
- **Read the value.** The strongest form: there simply is no invariant left to remember about. Applicable
  always when the value is reachable (a column, a snapshot field, an argument).
- **Refuse out loud.** The form for the case where the value is unreachable but the condition is checkable.
  The observability comes from the **runtime**, not from the documentation: the author of the next task removes
  the invariant — and the system starts refusing on real data, with text that names the
  reason. They do not need to be attentive.

### 3.3. Why this is an alignment to the record, not a new invention

The asymmetry from handoff 1.2 is not an accident but a difference of disciplines, and the right half is already in the code:

| Place                                                               | Invariant                               | Behavior        |
| ------------------------------------------------------------------- | --------------------------------------- | --------------- |
| `settleByCompany`, the `sourceSettledCurrency` check                | the accumulator does not mix currencies | refuse out loud |
| `settleByCompany`, the drop branch, `obligationCurrency !== 'USDT'` | a drop obligation is always USDT        | refuse out loud |
| `assertNoOffCurrencyCompanyRows`                                    | a company row is always USDT            | refuse out loud |
| `assertSettleCurrencyAllowed`                                       | a senior-settle only USD/USDT           | refuse out loud |
| `resolveEditCascade`, the currency label of `oldAmount`             | an obligation is in the source currency | **silence**     |

The first four are conditions unreachable today on which the code refuses to work. The fifth is an
unreachable-today condition on which the code **works and produces a number**. The mechanism from 3.1
converts the fifth row into the form of the first four.

**The mechanism has a ready name in this codebase:** a free function `assert*` throwing
an exception with text naming the invariant. This makes the supports _enumerable_:
`grep -rn 'function assert[A-Z]' apps/api/src packages` gives an inventory of the declared supports. A weak
but non-zero observability — a reviewer can ask "what does this module rely on" and get the
answer from the code, not from memory.

### 3.4. The honest boundary of the mechanism

It does **not** guarantee that every support will be declared: an author who did not realize a dependency will not
write either an `assert` or a read. Nothing gives such a guarantee, and asserting it would be the same
self-deception as the test-guard.

What it does guarantee: **a declared support cannot have a silently-wrong outcome.** Removing the
invariant either changes nothing (the value is read), or loudly stops the work (the condition
is checked). Deleting an explicit `throw` with text can only be done deliberately and in a diff visible at the
review — and this is the whole difference from "silently using a stale literal".

### 3.5. Application right now, in task 3 (backlog item 95)

A live case of exactly this form. `CascadeDerivativePlan.oldAmount` is taken from
`pending_obligations.amount`, to which `bookCompanyObligations` stamps `currency: 'USDT'`
by a **literal**, while in the plan this number is labeled `sourceCurrency`. Today they coincide; the coincidence is
held by BIZ-18 — the guard that task 3 removes.

By the mechanism 3.1 we apply **both** moves, because here they complement each other:

1. **Read:** add `currency` to `CascadeObligationSnapshot`, fill it in
   `loadCascadeSnapshot` from `pending_obligations.currency`. The value stops being an assumption.
2. **Refuse out loud:** the resolver emits a new warning code
   `OBLIGATION_CURRENCY_MISMATCH` when `obligation.currency !== source.currency`, and the application
   of the cascade on such a warning **refuses** (400), writing nothing.

The second move is not decorative: the cascade **writes** into `pending_obligations.amount` a number computed
as a share of the source amount. Writing it into a column whose currency is not checked is the very form
of item 86 (the currency lies nearby but does not enter the arithmetic). That is, this is not a "passing fix
of a neighboring defect" (AC5 item 10), but a condition for the correctness of task 3's own write.

The resolver is a pure function, so the unreachable-today condition is checked by a real
unit test (the snapshot is constructed by hand), not by suppressing a mutant.

---

## Consequences

- The company account balance formula gets a ninth term and remains the single source of
  truth. Terms 1–8 do not change by a byte — a deliberate consequence of the invariant 1.2.
- The cascade becomes a participant of the company account serialization (`lockCompanyAccount`) with a rigidly
  specified order of acquisition. Transaction edits start to compete with the money gates;
  the price — milliseconds on a rare operation.
- The top-up is closed for the senior branch and remains open for the drop branch until task 3b.
  The owner sees "already paid out" on both, but can close the remainder through the system so far only
  on senior.
- `assertNoOffCurrencyCompanyRows` (if the OR branch is enabled) starts to know about the new class of
  company rows; the refusal condition at the four money gates extends to data that
  does not exist in prod — and the emptiness of this set is proven by the origin of the rows (a grep of the write
  paths), not by querying a base to which the executor has no access.
- The invariant `amount == settled_amount` stops being an assumption on the senior branch: the cascade
  checks it at the point of support and refuses out loud. A side effect — an income edit on a row with
  already diverged copies (legacy before #598) will be rejected until a manual investigation. This is deliberate:
  the only alternative is to silently return a wrong debit.
- **The set of editable `PAID` rows narrows** (1.12): closed obligations and
  `COMPANY_DEPOSIT` become non-editable by amount; they are corrected by a reversal, not an edit.
  `ADMIN_INCOME`, `EXPENSE`, `DIVIDEND_TO_ADMIN` remain editable deliberately — there the
  ledger is obliged to follow the corrected number.
- **The top-up is obliged to go from the same funding source** (1.13), otherwise a refusal. Mixing
  pots on one obligation is not supported; the escape is a separate accumulator column, as for the
  currency.
- **The cascade stops rolling back the irreversibly-uncloseable** (1.14). A practical price that
  must be seen in advance: an income whose drop share is already paid out is **non-editable until task 3b**,
  and the same for a cross-currency accumulator. This makes 3b not a "nice addition" but a condition of the
  feature's completeness.
- A writing rule appears ("a support is a check"), applied immediately to item 95. Whether to formalize
  it as a separate file in `.claude/rules/common/` is the owner's decision, not made here.

## Rollback

The document executes nothing.

```bash
git -C <repo> revert <commit>
# expected state: docs/architecture/2026-08-23-cascade-apply-ledger-term.md absent,
#                 .claude/tasks/task-cascade-apply.md absent
git -C <repo> status --porcelain apps/ packages/   # MUST be empty — the code was not touched
```

The rollback of the task 3 implementation — by its own PR. Term 9 is reversible by a separate commit
(removing one SUM and one summand); the rollback of the already-performed derivative rollbacks is reversible
only by data, so the order of rollback is first disable the endpoint, then remove the term.

## Sources

Everything verified by reading the code in the working tree on `main` = `0e43ce41`, by symbol names.

- `apps/api/src/finance/company-account-balance.ts` — `sumLedgerTerms` (eight terms),
  `sumAmount`, `assertNoOffCurrencyCompanyRows`, `CompanyAccountOffCurrencyError`,
  `COMPANY_TERM_TYPES_UNGATED`, `COMPANY_TERM_TYPES_FUNDING_GATED`, `lockCompanyAccount`,
  `computeCompanyAccountBalanceFromLedger`, `computeCompanyAccountBalanceForDisplay`.
- `apps/api/src/finance/pending-settlement.service.ts` — `settleByCompany` in full: the resolution of
  `useCompanyAccount`/`debitsCompanyAccount`/`currency`, the HIGH-1 guard by `dropCascadeOrigin`,
  the DROP conversion block (`paidAmount`/`originalAmount`/`exchangeRate`, the guard
  `obligationCurrency !== 'USDT'`, the dust check), `settledAmountThisSettle`, the check of
  `sourceSettledCurrency`, the conditional claim and the `claimedAmount` reconciliation, the money-gate, the `.set()` of the flip;
  `resolveSource`, `toTransactionDto`.
- `apps/api/src/finance/transactions.service.ts` — `adminUpdateTransaction` (BIZ-18,
  the synchronization of `pending_obligations` from #598, the journal `AMOUNT_OR_RECEIVER_CHANGE`),
  `loadCascadeSnapshot`, `getEditCascadePreview`, `bookCompanyObligations` (both branches of the IOU insert),
  `createPayoutRequest` (the `VALIDATED` selection, reading the percent snapshots), `getSeniorSummary`.
- `apps/api/src/finance/balance.service.ts` — `getSeniorBalance`, `getTotalEarned`
  (the GROSS↔NET discriminator, both gates by `type === 'SENIOR_INCOME'`).
- `packages/shared/src/schemas/edit-cascade.ts` — `resolveDerivative`, `resolveEditCascade`,
  `resolveSourceWarnings`, `computeCascadeVersion`, `amountsDiffer`,
  `cascadeWarningCodeSchema`, `cascadeDerivativePlanSchema`, `cascadeEditPreviewResponseSchema`.
- `packages/shared/src/schemas/finance.ts` — `adminUpdateTransactionSchema`.
- `apps/api/src/finance/transactions.controller.ts` — `adminEdit` (`PATCH :id/admin-edit`),
  `editPreview`.
- `apps/api/src/invoices/invoices.service.ts` — `voidInvoiceForAmountEdit`,
  `reissueInvoiceIfStillPaid`, `voidAndReissueInvoiceForAmountEdit` (the last one today has
  no caller at all in the product code — verified by a grep).
- `apps/api/src/database/schema.ts` — `transactions.settledAmount`/`settledCurrency`/
  `settledSharePercent` with their doc-comment, `transactions.fundingSource`,
  `transactions.seniorSharePercent`/`dropSharePercent` and their `*Source` (no CHECK constraints),
  `transactionAuditLog` (`action` — `text`, not an enum).
- `apps/api/src/finance/company-account-balance-currency.spec.ts` — locks in the number of queries
  (currently 9) and the presence of `'USDT'` in the first eight WHEREs.
- ADR `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` — AC3/AC5/AC6 and
  the decomposition.
- Backlog `.claude/tasks/BACKLOG-followups.md` — items 70, 71, 72, 75, 82, 85, 86, 87, 91, 92,
  95, 96.
- Handoff `.claude/tasks/HANDOFF-architect-2026-08-22.md` — questions 1.2 and 1.4.
