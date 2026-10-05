# 2026-08-23 — The payment-fact triplet on a row closed by two payments (task 3b)

## Status

Proposed. An addendum to `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` (the main ADR)
and to `docs/architecture/2026-08-23-cascade-apply-ledger-term.md` (the task 3 addendum). **Neither
is changed** — here exactly one place is built out that the task 3 addendum left
deferred (§1.11, the DROP branch).

Zone: only `docs/architecture/**` + `.claude/tasks/task-drop-topup.md`. `apps/**` and `packages/**`
were not touched.

> **On line numbers.** There are deliberately none here (`.claude/rules/common/doc-durability.md`) — everything is
> addressed by the symbol name. Read in the working tree on `main` = `0e43ce41`.

## Context

Tasks 0/1/2/3/4 are in `main` (#598, #599, #603, #607, #600). The drop top-up refuses out loud in two
places, and both refusals are deliberate:

- `PendingSettlementService.settleByCompany` — the guard `isDropObligation && priorSettledAmount > 0`;
- `TransactionsService.applyEditCascade` — AC15(a), `snap.type === 'PAYOUT_DROP' && (snap.settledAmount ?? 0) > 0`.

The second appeared later than the first and by the AC15 law ("the cascade does not roll back what it cannot close")
moved to the **moment of the edit**. A practical consequence, named in §1.11 of the task 3 addendum directly:
**an income whose drop share is already paid out is non-editable at all today.** This is an ordinary scenario,
not an edge case, and 3b removes exactly it.

The one question that must be closed before the implementation: **what the triplet
`originalAmount`/`originalCurrency`/`exchangeRate` becomes on a drop-row closed by two or more payments,
and what mechanism records it.**

---

## Answer 0. Checking the premise: the triplet has no arithmetic consumers — confirmed, with a correction

The premise was given to me as an established fact with a request to re-check. **Re-checked, the conclusion
is confirmed, but with a substantial correction that changes its weight.**

All non-spec occurrences of `originalAmount` / `original_amount` / `originalCurrency` /
`exchangeRate` / `exchange_rate` in `apps/**` and `packages/**` (by a grep of both names of each of the three
columns, filtering out the `nbu` rates, the `exchange_rate` table from the seed and the same-named local
frontend variables):

| Place                                                                     | What it does                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `TransactionsService.paySalary`                                           | **writes** (into the row and into the audit metadata of `PAY`) |
| `PendingSettlementService.settleByCompany`, the `isDropObligation` branch | **writes**                                                     |
| `TransactionsService.mapTx`                                               | a pass-through to the DTO                                      |
| `PendingSettlementService.toTransactionDto`                               | a pass-through to the DTO                                      |
| `TransactionsService.loadCascadeSnapshot`                                 | reads **only at the source** → `CascadeSourceSnapshot`         |
| `classifyEditedRowLedgerFact` (`@crm/shared`)                             | the predicate `!== null` (AC13), the number is not used        |
| `resolveSourceWarnings` (`@crm/shared`)                                   | prints the value into the warning text                         |
| `exchange-rate.util.ts` — `isStorableExchangeRate`, `settledAmountError`  | range validators, do not count money                           |
| `schema.ts`, `finance.ts`, `edit-cascade.ts`                              | the schema and the documentation                               |
| `apps/web`                                                                | **no reads** — only two comments in `PaySalaryDialog.tsx`      |

**No consumer produces a monetary value from the triplet.** Item 3 of the statement is correct.

**A correction that is more important than the conclusion itself: an arithmetic consumer existed and was removed
by the owner's decision.** `TransactionsService.computeDropAggregate` in one of its editions **pinned**
a converted drop payout to its snapshot `original_amount`/`original_currency`, so that an already-closed
obligation would not "drift" after the NBU rate. A comment in the code records the cancellation verbatim: "Per the
owner's explicit decision ("everywhere at today's rate"), that pinning is reverted… `original_amount`/
`original_currency` stay on the schema as a fact record of what was actually paid — just no longer
consulted by aggregation" (security-review PR #521 round 3, MED-B).

From this follows not "the triplet is unimportant", but exactly the opposite in meaning:

> **The emptiness of the arithmetic consumers is an adopted decision, not an accident. The only job
> of the triplet is to be a correct record. So the price of a wrong record here equals the price of a lie in an accounting
> ledger: it will not surface anywhere, because no one counts it.**

The practical consequence for 3b: **there is freedom in the choice of form, there is no freedom to write an untruth.** And
this record will have to be checked by one's own test — no existing consumer will turn red.

---

## Answer 1. What the triplet becomes — the predicate

### 1.1. What the three columns assert today

From the doc-comment of `transactions.originalAmount` in `schema.ts`, verbatim:

- `original_amount` — `amount` **as it stood immediately BEFORE the payment**;
- `original_currency` — `currency` there too;
- `exchange_rate` — the **effective applied rate**, `paid / original`.

Hence the identity referenced by the guard-refusal in `settleByCompany` itself:

```
amount == original_amount × exchange_rate
```

Plus the NULL contract: "NULL reads as "this row was never paid through the amount-aware flow"" — and
the drop branch stamps the triplet **on every** settle precisely so that NULL cannot be confused
with "paid, but before this flow".

### 1.2. The identity is broken not by the top-up but by the rollback — and this changes the form of the task

A breakdown by the code of `applyEditCascade`, the `isSettled` branch (the rollback):

```
type   := DROP_PENDING_PAYOUT
status := PENDING_PAYMENT
amount := the new full share
dropSharePercent := the snapshot
```

The triplet is **not touched**. So immediately after the rollback, even before any top-up:

- `amount` = 130 (the debt), `original_amount` = 100, `exchange_rate` = 1 → **the identity is false**;
- `original_amount IS NOT NULL` on a row with `status = 'PENDING_PAYMENT'` asserts "this row was
  paid through the amount-aware flow", although the row at this moment is **not paid**;
- this row can be edited directly: `isCascadeAmountEdit` requires `status === 'PAID'`, so AC13
  does not reach it at all, and `floorAmountAtAccumulator` lets any amount through **upward** from the accumulator —
  and every such edit again diverges from the triplet.

Today this is unreachable: AC15(a) refuses earlier, so `PAYOUT_DROP` never returns to
`DROP_PENDING_PAYOUT`. **3b makes this branch live with the very first commit.** Therefore the question "what
the triplet becomes after the top-up" actually consists of two, and the first is about the rollback.

### 1.3. The population that 3b can touch: "two payments at different rates" is structurally empty

The deferred decision §1.11 is formulated as "what the triplet should mean on a row closed by two
payments **at different rates**". A check shows that this formulation has an **empty domain**
in the population that 3b can reach at all. The chain — by the code, each link
verifiable by a grep of the symbol name:

1. **A drop obligation is always USDT.** `settleByCompany`, the `isDropObligation` branch, throws
   `BadRequestException` when `obligationCurrency !== 'USDT'` (the MED-1 guard from #521).
2. **The cascade refuses if the obligation currency ≠ the source currency.** `applyEditCascade`, phase 1,
   the warning `OBLIGATION_CURRENCY_MISMATCH` → 400. So on a rolled-back row
   `obligation.currency == source.currency`.
3. **The cascade refuses if the accumulator is accounted not in the source currency.** AC15(b): the warning
   `NON_USDT_CURRENCY` (`currencyMismatch = settledAmount > 0 && settledCurrency !== sourceCurrency`)
   → 400. So `settled_currency == source.currency`.
4. From (2) and (3): **`settled_currency == obligation.currency == 'USDT'`.**
5. **The top-up is obliged to go in the accumulator currency.** The MED-1 guard from #599 in `settleByCompany`:
   `sourceSettledCurrency && sourceSettledCurrency !== currency` → 400. So the top-up currency is USDT.
6. **USDT→USDT is a peg pair.** `isUsdPegPair` (`c === 'USD' || c === 'USDT'` on both sides) → the branch
   `paidAmount = <the conversion input>` without an appeal to NBU. **The rate of each payment is exactly 1.**

The first payment went under the same conditions (its currency is the `settled_currency` from step 4), so
its rate is also 1. **Both payments — at rate 1; there is no weighted average.**

This is not "luck": five of the six links are existing refusals placed by previous rounds
of review. But they stand in **three different files**, and the triplet relies on their totality silently. By the
mechanism §3.1 of the task 3 addendum ("the dependency is expressed by an executable check at the point of support") 3b is obliged
to express this dependency in **one check where the triplet is stamped** — see 2.6.

### 1.4. The predicate: what lies in the three columns after the top-up

> **The triplet is a property of the CLOSED form of the row, not of a separate payment. It is non-empty if and only
> if the row stands in the closed form, and it describes the closing as a whole.**
>
> Formally, for a drop-row:
>
> | Column              | Value                                                                                        |
> | ------------------- | -------------------------------------------------------------------------------------------- |
> | `original_amount`   | the `pending_obligations.amount` of this closing — the obligation as it finally became       |
> | `original_currency` | the currency of this obligation (`'USDT'`, checked)                                          |
> | `exchange_rate`     | `amount / original_amount`, where `amount` is the accumulated sum of all payments on the row |
>
> and two identities hold:
>
> ```
> (T1)  amount == original_amount × exchange_rate          — the former, preserved
> (T2)  original_amount IS NOT NULL  ⟺  the row is in the closed form (status = 'PAID')
> ```
>
> In the population from 1.3 `exchange_rate` is at that point equal to **exactly** 1, and `original_amount == amount ==
settled_amount`. That is, T1 holds not approximately but identically.

**The definition of the columns does not change by a word in doing so.** Apply the schema's wording ("`amount` as
it stood immediately BEFORE the payment") to the top-up: before the top-up the rollback already wrote into `amount`
the new full share, equal to `obligation.amount`. So `original_amount := obligation.amount` is a
**literal execution of the existing definition**, not a new semantics. What changes is not the meaning but the
moment: the triplet must be **re-set on each closing**, not left over from the first.

What is lost: "this was two payments, not one" is not read from the row. This is acceptable and recorded
explicitly — see 1.6 and the section "The family of unambiguous columns"; the provenance goes into the journal, which on this path
is written **inside** the money transaction, not best-effort.

### 1.5. The mechanism that records this

One criterion from which both halves follow:

> **The rollback rewrites `amount`. Therefore it is obliged to zero exactly those columns whose truth
> is formulated RELATIVE to `amount`, and not to touch those that are independent records
> of a payment that happened.**

A decomposition of all the "unambiguous" columns of a drop-row by this criterion:

| Column                                                  | Formulated relative to `amount`?     | What the rollback does                   |
| ------------------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| `original_amount`, `original_currency`, `exchange_rate` | **yes** (T1)                         | **zeroes**                               |
| `settled_amount`, `settled_currency`                    | no — "how much really left"          | preserves (monotonicity)                 |
| `settled_share_percent`                                 | no — the percent of the last closing | preserves                                |
| `funding_source`, `sender_id`, `sender_label`           | no — "from which pot and who"        | preserves (an AC6 requirement of task 3) |
| `receipt_document_id`, `receipt_external_url`           | no — proof of the payment            | preserves                                |
| `tx_date`                                               | no — the day of the payment          | preserves                                |
| `currency`                                              | no — the payment currency            | preserves                                |

Zeroing is **unconditional**, without a branch by type: on a senior-row all three columns are already `NULL` by
construction (`bookCompanyObligations` does not write them, the senior branch of the flip does not write them — the object with the
triplet is spread only under `isDropObligation`), so writing `null` there is a provable no-op.
A branch whose firing no test can distinguish from non-firing is more expensive than its absence — the same
argument by which in `settleByCompany` the gate `!isDropObligation` was removed from `settledAmountError`.

The retractable values go into `CASCADE_REOPEN.metadata.before`. This is a **reliable** carrier, in
contrast to `PAY`: the `CASCADE_REOPEN` record is made by a `dbtx.insert(...)` **inside** the same transaction
as the rollback itself (unlike the best-effort `PAY` after the commit, because of which AC5 item 9 forbids
counting money from the journal). We do not count money from it — we only store the provenance.

The second half of the mechanism — at the closing: `settleByCompany` already stamps the triplet **on every** drop-settle;
what needs to change is not "when", but **from what** it is computed (2.3).

### 1.6. What becomes a false assertion if left as is

Four different lies, in descending order of damage. The first — money, the rest — records.

**(L1) Remove only the `settleByCompany` guard and nothing else.** The conversion branch computes `paidAmount`
from the **full** `obligation.amount`, not from the remainder:

```
obligation 130, already paid out 100
→ paidAmount = 130          (paying the full amount a second time)
→ amount = 130, settled_amount = coalesce(100,0) + 130 = 230
```

The drop was physically paid 230 for a debt of 130 — an **overpayment of 100**. Plus `amount(130) ≠ settled_amount(230)`,
that is, the invariant §1.2 of the task 3 addendum breaks, on which the ledger's term 9 stands: the next cascade
on this row will start refusing forever (the check `amountsDiffer(snap.amount, snap.settledAmount)`
in `applyEditCascade`). This is the only one of the four where the lie costs real money.

**(L2) Make `amount` cumulative but leave the rate formula as is.** `rawExchangeRate =
paidAmount / obligationAmount` will compute `30 / 130 = 0.2307…`, and the row will declare a rate of 0.23 for
a USDT→USDT conversion that did not happen. T1 is violated: `130 ≠ 130 × 0.2307`. Exactly the form of backlog
item 86 — "the currency lies next to the value but does not enter the arithmetic", only here the reverse: a
number from another payment entered the arithmetic.

**(L3) Do not re-set the triplet at all.** The row asserts: "the obligation was 100, it was closed by a payment of
130 at rate 1". Three false assertions in three columns: the obligation was 130; the payment was not one;
`130 ≠ 100 × 1`.

**(L4) Do not clean the triplet on the rollback.** A row in the status `PENDING_PAYMENT` asserts that it was
paid, and its `amount` (the debt) is matched with the payment rate. Plus the hole from 1.2: such a row can be
edited directly bypassing AC13, and each edit adds a discrepancy. The lie lives the whole time between
the income edit and the top-up — that is, exactly as long as the owner looks at the "how much to top up"
screen.

Not one of the four will be caught by any existing consumer (Answer 0). Therefore each in the
task has its own test with a note of what exactly will turn red.

---

## Answer 2. What is obliged to change in the top-up arithmetic for the predicate to become true

Everything below — inside `PendingSettlementService.settleByCompany`, the `isDropObligation` branch. The ledger
terms 1–8 are not touched; term 9 is not touched.

### 2.1. The conversion input — the remainder, not the full obligation

`remainingOwed` already exists (introduced by task 3 for the senior branch, "ONE description, two call sites").
The drop branch is obliged to compute the conversion **from it**:

```
owedNow = remainingOwed(obligation.amount)      // = obligation.amount when the accumulator is empty
```

On the first settle `priorSettledAmount === 0`, so `owedNow === obligationAmount`, and the behavior is
**byte-for-byte the former**. This allows replacing the conversion input without a branch — one description instead of two.

### 2.2. `amount` becomes cumulative — and by the same expression as the accumulator

```
amount:        sql`coalesce(${transactions.settledAmount}, 0) + ${settledAmountThisSettle}`
settledAmount: sql`coalesce(${transactions.settledAmount}, 0) + ${settledAmountThisSettle}`
```

The same expression in both columns makes the invariant §1.2 (`amount == settled_amount`)
**structural**, not asserted: it cannot diverge, because the source of both numbers is one.
This is exactly the argument by which MED-3 (#599) required a DB-native increment instead of a JS-computed one:
the correctness does not depend on nobody interfering between the read and the write. The TOCTOU condition
`settled_amount IS NOT DISTINCT FROM <the read>` in the `WHERE` of the flip already stands and pins the previous
value.

On the first settle: `coalesce(NULL,0) + paidAmount = paidAmount` — the former behavior.

**`amount` is still written only on the drop branch.** The senior branch does not touch `amount` — so it
remains (there the invariant §1.2 is held by external holders plus the cascade check, see §1.2 of the task 3
addendum).

### 2.3. The rate numerator — the accumulated, the denominator — the obligation

```
cumulativePaid  = priorSettledAmount + paidAmount        // round to 6 digits
originalAmount  = obligation.amount                      // the full obligation, NOT owedNow
originalCurrency = obligationCurrency
rawExchangeRate = obligationAmount > 0 ? cumulativePaid / obligationAmount : null
```

Further — the existing `isStorableExchangeRate` without changes (`null` when the ratio is unrepresentable).
On the first settle `cumulativePaid === paidAmount` — the former formula.

T1 at that point holds by construction: `amount` (2.2) and `cumulativePaid` are one and the same number, and
`exchange_rate` is its ratio to `original_amount`.

### 2.4. The dust check switches to the remainder — otherwise a deadlock

The existing check `paidAmount === 0 && obligationAmount > 0` ("after rounding the payout amount
came out zero, although the obligation is not zero") **must** compare with `owedNow`, not with
`obligationAmount`. Otherwise a lawful idempotent closing with `owedNow === 0` — a state that
the task 3 addendum §1.11 specially made lawful for the sake of exiting SR-M-4 — on the drop branch will be
rejected, and the same deadlock that §1.14 closed will result.

Reachability verified by the code: an income edit upward → rollback (obligation 130, accumulator 100) →
an edit back downward → the AC5 branch writes `flooredAmount = max(100, 100) = 100` into both copies → the next
settle gives `owedNow = 100 − 100 = 0`. Without this fix — a `BadRequestException` on a row that there is
nothing left to close with.

### 2.5. The money-gate: the branch collapses into one description

Now: `const amount = isDropObligation ? parseFloat(claimedAmount) : remainingOwed(claimedAmount)`.
After 2.1 both halves are `remainingOwed(claimedAmount)`:

- for a company-funded drop-settle the currency is forced `'USDT'` (`debitsCompanyAccount ⇒ currency = 'USDT'`,
  §1.5 of the task 3 addendum), the obligation is also USDT, so `paidAmount === owedNow` without a conversion;
- on the first settle `remainingOwed(claimedAmount) === parseFloat(claimedAmount)` — the former behavior.

The ternary is removed. Fewer branches — fewer un-killable mutants, and "how much is still owed" remains
described once.

### 2.6. A new refusal out loud — at the point of the stamp (the §3.1 mechanism)

The chain 1.3 rests on five refusals in three files. The triplet is obliged to **itself** check what it
relies on:

```
if priorSettledAmount > 0 and targetCurrency !== obligationCurrency → 400
```

Placed inside `isDropObligation`, right after the existing assert `obligationCurrency !== 'USDT'`,
that is, exactly where the triplet is computed. The text is obliged to name the invariant: the top-up is possible only in
the obligation currency, because otherwise the recorded rate would become an average that not one payment
had.

What this gives: remove any of the five removed refusals — and the system will start refusing **loudly, on live
data**, instead of recording a weighted-average rate that no one counts. Exactly that
difference for which §3.1 was written.

It is not a duplication: the five refusals protect **other** assertions (the obligation currency,
the accumulator unit, the unit of the record in `pending_obligations`), and none of them is formulated about
the triplet.

---

## Answer 3. AC13 in both directions

The statement's requirement — check whether zeroing the triplet will open editing of rows that are obliged
to remain closed, and whether it will block anything extra. Verified by `classifyEditedRowLedgerFact`
(`@crm/shared`), where the predicates return the **first** that fired:

```
originalAmount !== null      → PAYMENT_FACT_RECORDED
settledAmount  !== null      → SETTLED_AMOUNT_RECORDED
hasClosedObligation          → CLOSES_OBLIGATION
type === 'COMPANY_DEPOSIT'   → ONCHAIN_DEPOSIT
```

**Nothing is opened.** The refusal is a disjunction, and on any drop-row that has a triplet the second
and third predicates are true independently of the first:

| Row state                         | `originalAmount` | `settledAmount` | `hasClosedObligation` | AC13 result                   |
| --------------------------------- | ---------------- | --------------- | --------------------- | ----------------------------- |
| `PAYOUT_DROP` PAID (today)        | ≠ null           | ≠ null          | true                  | refusal (by the first)        |
| `PAYOUT_DROP` PAID (after 3b)     | ≠ null           | ≠ null          | true                  | refusal — **unchanged**       |
| `DROP_PENDING_PAYOUT` rolled back | **null** (3b)    | ≠ null          | false¹                | **AC13 is not asked at all**² |

¹ `hasClosedObligation` looks for a `pending_obligations` with `status = 'PAID'`; the rollback moves the obligation
to `PENDING`, so the predicate honestly becomes false — this is not a loss of protection, but a correct description.
² `isCascadeAmountEdit` requires `status === 'PAID'`; a rolled-back row has the status `PENDING_PAYMENT`,
so the whole AC13 block (and the mandatory preview) is not executed. Such a row is held **not** by
AC13, but by `floorAmountAtAccumulator`: its `amount` cannot be written below the accumulator by any of the three
writers (SR-M-6, locked in `@crm/shared` by one helper).

**And nothing extra is blocked.** `ADMIN_INCOME`, `EXPENSE`, `DIVIDEND_TO_ADMIN` do not get a single
new predicate: 3b adds nothing to `classifyEditedRowLedgerFact`. The explicit prohibition "do not finish closing
them for the company" stands in the doc-comment of this function and remains in force.

**What does change in the observable behavior:** a rolled-back drop-row loses
`SOURCE_ORIGINAL_AMOUNT_SET` in `resolveSourceWarnings`, if this row is opened in the preview.
This is correct (a payment is no longer recorded on it) and safe (the warning is informational, not
blocking; `classifyEditedRowLedgerFact`, which still has `settledAmount`, blocks).

---

## Answer 4. The invariant §1.2 is preserved, not bypassed

`amount == settled_amount` after a company-funded settle — the only reason terms 7/8
can be left untouched.

- **On the drop branch 3b makes it structural** (2.2): both columns are written by one expression.
  Today it is held by the fact that `amount: String(paidAmount)` and `settledAmountThisSettle = paidAmount!`
  — one variable; after 3b — one expression. The form of the argument is not weakened but strengthened.
- **The cascade check before the rollback is not touched.** `applyEditCascade` continues to reconcile
  `amountsDiffer(snap.amount, snap.settledAmount ?? 0)` for a company-funded derivative and to refuse
  out loud. 3b neither extends nor narrows it.
- **Term 9 continues to return exactly the disappeared debit.** After the top-up: the row leaves term 9
  by `settled_amount` (= the old debit) and comes into term 8 by `amount` (= the accumulated). The debit difference
  equals `owedNow` — exactly what physically left. When `owedNow === 0` the transition is
  ledger-neutral, since both numbers are equal.

---

## Answer 5. What 3b does NOT do — a refusal out loud remains a lawful answer

| Case                                                                               | Behavior after 3b                   | Why                                                                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A top-up in a currency different from the obligation currency                      | **refusal** (2.6)                   | the rate would become a weighted average; for that a per-payment record is needed, i.e. a separate table |
| A rollback of a drop-row whose accumulator is accounted not in the source currency | **refusal**, the existing AC15(b)   | the remainder is incomputable — subtraction from different units (backlog item 86)                       |
| A rollback of a derivative with `settled_amount IS NULL` (legacy before #599)      | **a new refusal**, see below        | "how much was paid out" is unknown; a silent `?? 0` would mean paying the full amount a second time      |
| An edit of `amount` on a closed drop-row                                           | the AC13 refusal, unchanged         | the second carrier of the number is not moved by the edit                                                |
| An overpayment (`new share ≤ the accumulator`)                                     | the AC7 branch of task 3, unchanged | nothing is written, the row remains `PAID`                                                               |

### Separately: `settled_amount IS NULL` on a closed derivative

Today `resolveDerivative` takes `settledAmount = derivative.settledAmount ?? 0`, and AC15(a) keys
on `> 0`. A legacy row (a settle before #599) passes both conditions as "zero paid out".

**Today this is not a hole — by a theorem, not by luck.** `settled_amount` and `settled_share_percent`
were added by one task (#599) and are written by one `.set()` of the flip, moreover `settledAmount` is written
by an `sql` expression and is never `NULL` after it. So `settled_amount IS NULL` ⟹ the settle was before #599
⟹ `settled_share_percent IS NULL` ⟹ `resolveDerivative` gives `sharePercent: null` and
`newAmount: null` ⟹ `applyEditCascade` refuses on the very first condition of phase 1 ("no share-percent
snapshot"). Verified by the code of both functions.

**3b is obliged to turn this theorem into an executable check** — by the same mechanism §3.1, and for the same
reason for which §1.2 became a check: the theorem has four links in three files, and the price of its failure —
a repeated payout of the full amount. The check: **a derivative with `obligation.status === 'PAID'` and
`settledAmount === null` → 400, not a single record.** Today unreachable (this is just proven above),
unit-testable with a hand-built snapshot, costs one line.

### What happens to AC15(a)

The existing refusal `snap.type === 'PAYOUT_DROP' && (snap.settledAmount ?? 0) > 0` is **removed** — this
is the very content of 3b. It is removed not "because now it is allowed", but because the AC15 law ("do not
roll back what it cannot close") after 2.1–2.6 holds for the drop branch by other,
enumerated above refusals:

- currency: (2)+(3) of the chain 1.3 give `settled_currency == obligation.currency`, and the accumulator guard
  in `settleByCompany` requires the top-up in the same currency ⇒ the new refusal 2.6 will never fire on a
  row that the cascade rolled back;
- the remainder: the `max` rule (AC5/AC7 of task 3) holds `owedNow ≥ 0`, and `owedNow === 0` is a lawful
  closing;
- the funding source and the payer: the AC14 guard (#607) — a refusal on the top-up, not a deadlock (the operator
  can pay from the same pot);
- an unknown accumulator: the new refusal above.

**Replacing one refusal with four is not an extension but a transfer: previously the whole branch was refused, now
its uncloseable subsets are refused.**

---

## The family of unambiguous columns: why only the triplet is cleaned

A row closed by two payments has one instance of each "fact" column, while there are two
payments. The full breakdown (the criterion — 1.5):

| Column                                         | After two payments                     | Acceptable?                                                                             |
| ---------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `funding_source`, `sender_id`, `sender_label`  | the same for both                      | yes — **forcibly**, the AC14 guard refuses on a change                                  |
| `currency`, `settled_currency`                 | the same for both                      | yes — forcibly, the accumulator guard #599                                              |
| `settled_amount`                               | the sum of both                        | yes — the column is cumulative by definition                                            |
| `settled_share_percent`                        | the percent of the last closing        | yes — so intended (#599: "only the latest percent is meaningful")                       |
| `amount`                                       | the sum of both (2.2)                  | yes — term 8 and §1.2 require this                                                      |
| the triplet                                    | describes the closing as a whole (1.4) | yes — provided the rate is 1 for both (2.6)                                             |
| `tx_date`                                      | **the day of the last payment**        | yes, with a caveat: read as "the day the obligation was closed"                         |
| `receipt_document_id` / `receipt_external_url` | **the receipt of the last payment**    | **only** on condition that the receipt of the first is saved in the journal — see below |

The last two are the only ones where the unambiguity loses something.

- **`tx_date`** — not money and not proof; "the closing day" is a meaningful reading. The lower
  bound of the date (not earlier than `obligation.createdAt`) continues to work. We do nothing, we fix the
  reading here.
- **`receipt_*`** — proof of a payment, and `receiptMandatoryError` requires it on every settle from
  the user dialog. The flip writes `funding?.receiptDocumentId ?? null`, that is, the top-up
  **overwrites** the first payment's receipt, and a legacy-route top-up (without `funding`) zeroes it.
  A silent loss of proof is the same class as item 168 ("not visible on the screen ≠ not handed to the
  client"). Cured by the same mechanism as the triplet: **`CASCADE_REOPEN.metadata.before` records
  the references to the retractable payment's receipt** inside the money transaction. The column itself is not cleaned
  (criterion 1.5: a receipt is an independent record, it was and remains true), and after the top-up it carries
  the receipt of the last payment. The provenance is complete, there is no loss.

---

## Found along the way — do not fix in 3b

By AC5 item 10 of the main ADR: to mix means to get a PR without one clear acceptance criterion.

1. **The triplet is not displayed anywhere in the frontend.** It is in `transactionSchema`, `mapTx`
   passes it through, `apps/web` does not read it once (by a grep of `.originalAmount` / `.exchangeRate` /
   `originalCurrency` — only two comments in `PaySalaryDialog.tsx`). That is, "how much was
   owed and at what rate it was closed" the operator does not see at all today, including salaries. A candidate
   for task 5 (UI) or the backlog; does not affect 3b.
2. **`resolveSourceWarnings` prints `originalAmount` without a currency.** The text "a payment
   fact is already recorded (originalAmount = 800)" does not name `originalCurrency` — the form of item 86, so far
   harmless (text, not arithmetic). One line, but it is someone else's PR.
3. **The `paySalary` comment names non-existent consumers.** "Without that snapshot the USD
   reporting, balances and the "projects unpaid this month" metric … would silently lose their
   input" — none of the three today reads the triplet (Answer 0), and the pinning in `computeDropAggregate`
   was removed by the owner's decision. The same class as the already-fixed `CORRECTED (task-finance-fix-wave1,
D-3)` comment nearby: a wrong assertion in a comment costs the next audit's time.
   A candidate for the backlog.

---

## Consequences

- The drop top-up is closed **in the obligation currency**; a cross-currency one remains a refusal, and now
  a refusal that names the reason at the point of the stamp, not in three files far off.
- The triplet gets a written predicate (T1 + T2) and stops being columns whose truth
  is implied. The definition of the columns in `schema.ts` does not change — a paragraph about a repeat
  closing is added.
- The `amount` of a drop-row becomes cumulative, and the invariant §1.2 on this branch — structural.
  Terms 1–8 are not touched, term 9 is not touched.
- The cascade stops rolling back a derivative with an unknown accumulator. Today this set is empty by
  a theorem; the check makes the theorem falsifiable.
- A rolled-back drop-row stops carrying the triplet. The only observable consequence outward —
  the disappearance of the informational warning `SOURCE_ORIGINAL_AMOUNT_SET` on such a row.
- **What is still non-editable and why:** an income whose drop share is closed in a currency different from
  the income currency, and an income whose derivative is closed before #599. Both — a refusal out loud with a manual
  reconciliation. The feature completeness promised by §1.14 of the task 3 addendum is achieved for the main population
  (closing in USDT), but not for all.

## Rollback

The document executes nothing.

```bash
git -C <repo> revert <commit>
# expected state: docs/architecture/2026-08-23-drop-topup-triplet.md absent,
#                 .claude/tasks/task-drop-topup.md absent
git -C <repo> status --porcelain apps/ packages/   # MUST be empty — the code was not touched
```

The rollback of the 3b implementation — by its own PR. The order of rollback, if it becomes needed after the rollout:
first return the AC15(a) refusal in `applyEditCascade` (one line — the top-up is unreachable again), then
everything else. The reverse order would leave rolled-back drop-rows that there is nothing to close with.

## Sources

Read in the working tree on `main` = `0e43ce41`, by symbol names.

- `apps/api/src/finance/pending-settlement.service.ts` — `isUsdPegPair`; `settleByCompany` in full:
  `remainingOwed`/`priorSettledAmount`, the guard `isDropObligation && priorSettledAmount > 0`, the
  DROP conversion block (the assert `obligationCurrency !== 'USDT'`, the `isUsdPegPair` fast-path, the NBU-rate
  freshness gate, `settledAmountError`, the dust check, `originalAmount`/`originalCurrency`/`exchangeRate`),
  `settledAmountThisSettle`, the guard `sourceSettledCurrency !== currency`, the source/payer guard,
  the conditional claim and the `claimedAmount` reconciliation, the money-gate, the `.set()` of the flip (including the zeroing of
  `*SharePercent`, `settledSharePercent`, the DB-native `settledAmount`), the best-effort journal `PAY`,
  `resolveSource`, `settleByCompanySourceTransaction`, `toTransactionDto`.
- `apps/api/src/finance/transactions.service.ts` — `adminUpdateTransaction` (BIZ-18, `isCascadeEdit`,
  `floorAmountAtAccumulator`, the lock order), `lockCascadeRows`, `loadCascadeSnapshot`
  (the mapping of the derivatives and the source), `assertEditedRowAmountIsOwnRecord`, `applyEditCascade`
  (phase 1: `newAmount === null`, `OBLIGATION_CURRENCY_MISMATCH`, the §1.2 check, AC15(a)/(b);
  phase 2: the AC7/AC6/AC5 branches, `CASCADE_OVERPAYMENT`/`CASCADE_REOPEN`/`CASCADE_AMOUNT_UPDATE`),
  `computeDropAggregate` (the MED-B comment about the removed pinning to `original_amount`),
  `paySalary` (`paidSet`, the derivation of `exchangeRate`, the `PAY` metadata), `bookCompanyObligations`
  (`dropCascadeOrigin: payoutRequestId != null`), `mapTx`.
- `packages/shared/src/schemas/edit-cascade.ts` — `CascadeSourceSnapshot` / `CascadeDerivativeSnapshot`
  / `CascadeObligationSnapshot`, `resolveDerivative` (`isSettled`, `currencyMismatch`, `overpaid`,
  `needsReconfirm`, `NON_USDT_CURRENCY`, `OBLIGATION_CURRENCY_MISMATCH`), `resolveSourceWarnings`,
  `classifyEditedRowLedgerFact`, `CASCADE_LEDGER_FACT_MESSAGES`, `floorAmountAtAccumulator`,
  `isCascadeAmountEdit`, `amountsDiffer`.
- `apps/api/src/finance/company-account-balance.ts` — `sumLedgerTerms` (terms 7, 8 and the ninth),
  `COMPANY_TERM_TYPES_PENDING_SETTLED`, `assertNoOffCurrencyCompanyRows` (incl. the OR branch about
  `PENDING_PAYMENT`), `lockCompanyAccount`.
- `apps/api/src/database/schema.ts` — the doc-comment of `transactions.originalAmount` /
  `originalCurrency` / `exchangeRate` (the definitions of the three columns and the NULL contract),
  `settledAmount` / `settledCurrency` / `settledSharePercent`, `fundingSource`, `txDate`,
  `receiptDocumentId` / `receiptExternalUrl` (all nullable).
- `apps/api/src/finance/exchange-rate.util.ts` — `isStorableExchangeRate`, `settledAmountError`.
- `apps/web/app/routes/_authenticated/finance/components/dialogs/PaySalaryDialog.tsx` — the only
  mentions of the triplet in the frontend (both — comments).
- ADR `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md` — AC3 (the rollback mechanics),
  AC5 item 5/item 10, AC6 (the risk-list), C2.
- Addendum `docs/architecture/2026-08-23-cascade-apply-ledger-term.md` — §1.2 (the invariant and its
  holders), §1.3–1.5 (term 9), §1.7 (`max`), §1.11 (the deferral of the drop top-up), §1.12 (AC13),
  §1.13 (the funding source), §1.14 (AC15), §3.1 (a support = a check).
- Backlog `.claude/tasks/BACKLOG-followups.md` — items 70, 75, 82, 86, 87, 96.
- `gh api repos/:owner/:repo/branches/main/protection` — the required checks on `main`:
  `Typecheck · Lint · Unit Tests`, `E2E Tests`, **`Integration Tests (Postgres)`** (verified
  2026-08-23; the integration run now blocks the merge).
