# task-drop-topup

## Agent: coder

## Status: ready

## Blockers: none (tasks 0/1/2/3/4 are in `main` — #598, #599, #603, #607, #600)

## Priority: high

## Model: opus

Justification per `rules/common/model-routing.md`: financial calculation logic + company account +
cross-module (`settleByCompany` ↔ cascade ↔ term 9 ↔ `@crm/shared`). The diff touches a block that
has passed three rounds of security-review. An error "to the plus" on this path is caught by no gate,
while an error "to the minus" is a repeated payout to a living person.

## Depends on

Task **3b** from the decomposition of `docs/architecture/2026-08-22-paid-transaction-edit-cascade.md`
(deferred in the addendum to task 3, `docs/architecture/2026-08-23-cascade-apply-ledger-term.md` §1.11).

Constructive decisions — `docs/architecture/2026-08-23-drop-topup-triplet.md`
(**read in full before the first edit**; below are references like "addendum 3b, 1.4").

## Branch: feature/drop-topup

> **Line numbers are read from `main` = `0e43ce41`.** Files change quickly — check by **symbol
> name**, the names are given everywhere precisely for this.

---

## Context

Today a top-up on a partially paid drop obligation refuses in two places, and both
refusals are deliberate:

- `PendingSettlementService.settleByCompany` — `if (isDropObligation && priorSettledAmount > 0)`
  (`pending-settlement.service.ts:372`);
- `TransactionsService.applyEditCascade` — AC15(a),
  `if (snap.type === 'PAYOUT_DROP' && (snap.settledAmount ?? 0) > 0)`
  (`transactions.service.ts:3929`).

The second appeared later and, by the AC15 law ("the cascade does not roll back what it will not be able to close"), moved
to the **moment of the edit**. Hence today's limitation, named in the addendum to task 3 §1.11 in plain
words: **an income whose drop share is already paid is not editable at all.** This is an ordinary scenario.
3b lifts exactly that.

The deferral was justified by one argument: a top-up makes `amount` cumulative, while the triplet
`originalAmount`/`originalCurrency`/`exchangeRate` describes **one** conversion, so the identity
`amount = original_amount × exchange_rate` stops holding, and "what should the triplet mean on a
row closed by two payments at different rates" is a separate decision.

**The decision is made and recorded in addendum 3b.** In short:

1. The wording "at different rates" has an **empty domain of definition** in the population the cascade can
   reach: five existing refusals in three files reduce the top-up currency to the obligation's currency,
   and USDT→USDT is a peg pair, so the rate of every payment is exactly 1 (addendum 3b, 1.3).
2. The triplet is a **property of the closed form of the row**, not of an individual payment: `original_amount` is
   the obligation as it finally became; `exchange_rate` is the ratio of the accumulated amount to it.
   The column definitions in `schema.ts` **do not change** — what changes is the moment: the triplet
   is reset on every closure and zeroed by the rollback (addendum 3b, 1.4–1.5).
3. The support is expressed by an **executable check at the point of stamping**, not by five refusals
   elsewhere (mechanism §3.1 of the addendum to task 3).

---

## Concrete changes

1. `packages/shared/src/schemas/edit-cascade.ts`
   - `CascadeDerivativeSnapshot` — add `originalAmount: number | null`,
     `originalCurrency: CurrencyEnum | null`, `exchangeRate: string | null`. **The resolver does not
     read them** — they are needed by `applyEditCascade` to write the retractable values to the journal.
     The precedent and form of the comment — the field `fundingSource` already lying next to them ("Unused by the pure
     resolver — see the field's own comment for why it still belongs on the snapshot").
   - The resolver (`resolveDerivative`, `resolveEditCascade`) **do not touch**: not one of its branches
     changes, `needsReconfirm` / `remainingToPay` / `NON_USDT_CURRENCY` stay as they are.
2. `apps/api/src/finance/transactions.service.ts`
   - `loadCascadeSnapshot` (the mapping of derivatives, `:3714`) — fill the three new fields from the
     row already being read. **Do not introduce a second round-trip**, the query already returns `d.*`.
   - `applyEditCascade`, phase 1 (`:3839`):
     - **delete** the AC15(a) refusal (`:3929`) — that is the content of the task;
     - **add** the AC9 refusal (below): a derivative with `obligation.status === 'PAID'` and
       `settledAmount === null`. Place it **next to** the existing check §1.2, of the same form.
   - `applyEditCascade`, the rollback branch (`revertedType`, `:4015`):
     - in the `.set()` of the flip back add `originalAmount: null, originalCurrency: null,
       exchangeRate: null` — **unconditionally**, without a branch by type (on a senior row it is a provable
       no-op, see AC2);
     - in `CASCADE_REOPEN.metadata.before` (`:4051`) add the retractable values: the triplet and
       the receipt references (`receiptDocumentId` / `receiptExternalUrl`).
3. `apps/api/src/finance/pending-settlement.service.ts`
   - **delete** the refusal `isDropObligation && priorSettledAmount > 0` (`:372`);
   - the block `if (isDropObligation)` (`:572`):
     - **a new refusal** (AC8) right after the assert `obligationCurrency !== 'USDT'`:
       `priorSettledAmount > 0 && targetCurrency !== obligationCurrency` → 400;
     - the input of the conversion — `owedNow = remainingOwed(obligation.amount)` instead of `obligationAmount`
       (`:647` fast-path and the NBU branch). `obligationAmount` **stays** a separate variable: it
       is needed as the rate denominator and as `originalAmount`;
     - the dust check (`:744`) — compare with `owedNow`, not with `obligationAmount`;
     - `rawExchangeRate` (`:777`) — the numerator is `cumulativePaid = priorSettledAmount + paidAmount`
       (rounded to 6 digits), the denominator `obligationAmount` unchanged;
   - the money gate (`:1054`) — collapse the ternary into `remainingOwed(claimedAmount)` (AC7);
   - the `.set()` of the flip, the drop patch (`:1094`) — `amount: sql\`coalesce(${transactions.settledAmount}, 0) + ${settledAmountThisSettle}\``
     **with the same expression** as `settledAmount` (`:1168`).
4. `apps/api/src/database/schema.ts` — add a paragraph about repeated closing to the doc comment of
   `transactions.originalAmount` (AC14). Do **not rewrite** the definitions of the three columns — they are correct,
   only the case "the row is closed twice" is added.
5. Specs (see "Test AC"): `apps/api/src/finance/pending-settlement.drop-currency.spec.ts`,
   `apps/api/src/finance/pending-settlement.spec.ts`,
   `apps/api/src/finance/cascade-apply.unit.spec.ts`,
   `apps/api/src/finance/cascade-apply.integration.spec.ts`,
   a new `apps/api/src/finance/drop-topup.integration.spec.ts`,
   `packages/shared/src/schemas/edit-cascade.spec.ts`.

---

## Reuse / Regression scope

**Reuse, do not rewrite:**

- `remainingOwed` (`pending-settlement.service.ts:338`) — "how much is still owed", one description for all
  calls. Do not introduce a second remainder arithmetic.
- `isUsdPegPair`, `convertToBase`, `isStorableExchangeRate`, `settledAmountError` — unchanged.
- `floorAmountAtAccumulator`, `amountsDiffer`, `roundShareAmount` (`@crm/shared`) — unchanged.
- `resolveEditCascade` and the whole pure resolver — unchanged.

**Do not touch at all (regression scope, any touch = a review finding):**

- ledger terms 1–8 and the ninth (`company-account-balance.ts`) — not a byte;
- `assertNoOffCurrencyCompanyRows` and its OR branch;
- the HIGH-1 guard on `dropCascadeOrigin`, the guard `sourceSettledCurrency !== currency` (MED-1 #599),
  the source/payer guard (AC14 #607), the check §1.2 in `applyEditCascade`;
- guards 1 and 2 of `adminUpdateTransaction`, BIZ-18 in its current narrowed form;
- the senior branch of `settleByCompany` (its top-up was done by task 3 and works);
- `settled_amount` stays monotonic.

---

## Acceptance criteria

### AC1 — the AC15(a) refusal is lifted

- [ ] `applyEditCascade` no longer refuses on `snap.type === 'PAYOUT_DROP' && settledAmount > 0`.
- [ ] An edit of an income whose drop share was paid **in USDT** reaches the write: the derivative
      returns to `DROP_PENDING_PAYOUT` / `PENDING_PAYMENT`, the obligation — to `PENDING`.
- [ ] An edit of an income whose drop share was paid in a currency **other than** the income currency still refuses via the
      existing AC15(b) (`NON_USDT_CURRENCY`). This refusal is **not touched**.

### AC2 — the rollback zeroes the triplet and zeroes nothing else

- [ ] `originalAmount: null, originalCurrency: null, exchangeRate: null` added to the rollback `.set()`.
- [ ] **Unconditionally, without a branch by type.** On a senior row this is a no-op by construction:
      `bookCompanyObligations` does not write the triplet, the senior branch of the flip does not write it (the object with the triplet
      is revealed only under `isDropObligation`). A branch whose firing no test can
      distinguish from its not firing costs more than its absence.
- [ ] **Not zeroed** and not touched: `settled_amount`, `settled_currency`,
      `settled_share_percent`, `funding_source`, `sender_id`, `sender_label`, `receipt_*`,
      `tx_date`, `currency`. The criterion — addendum 3b, 1.5: only that is zeroed whose truth
      is formulated **relative to `amount`**, which the rollback rewrites.
- [ ] After the rollback the row satisfies `original_amount IS NULL` (T2 of addendum 3b, 1.4).

### AC3 — the conversion input = the remainder, not the full obligation

- [ ] `owedNow = remainingOwed(obligation.amount)` — the same symbol as on the senior branch.
- [ ] The conversion (both branches — the `isUsdPegPair` fast-path and NBU) computes **from `owedNow`**.
- [ ] `obligationAmount` stays a separate variable and still equals the full
      `parseFloat(obligation.amount)`: it is the rate denominator (AC5) and the value of `originalAmount`.
- [ ] On the first settle (`priorSettledAmount === 0`) `owedNow === obligationAmount` ⇒ behavior
      **byte-for-byte as before**. This is asserted by a test, not by a comment.

### AC4 — `amount` is cumulative, by the same expression as the accumulator

- [ ] `amount: sql\`coalesce(${transactions.settledAmount}, 0) + ${settledAmountThisSettle}\`` —
      **literally the same expression** as `settledAmount` one line below.
- [ ] The invariant §1.2 (`amount == settled_amount`) on the drop branch becomes **structural**:
      it cannot diverge, because the source of the number is one. This is a strengthening of the earlier argument
      ("one variable `paidAmount`"), not its replacement.
- [ ] The existing TOCTOU condition `settled_amount IS NOT DISTINCT FROM <the value read>` in the `WHERE`
      of the flip **stays** — it pins the previous value on which `cumulativePaid` is built.
- [ ] `amount` is still written **only** on the drop branch. The senior branch does not touch `amount`.

### AC5 — the rate: the numerator is accumulated, the denominator is the obligation

- [ ] `cumulativePaid = Number((priorSettledAmount + paidAmount).toFixed(6))`.
- [ ] `rawExchangeRate = Number.isFinite(obligationAmount) && obligationAmount > 0 ? cumulativePaid / obligationAmount : null`.
- [ ] `originalAmount = obligation.amount` (the full obligation), `originalCurrency = obligationCurrency`
      — as now, do not change.
- [ ] The existing Stryker suppressions on these lines are kept together with their justification;
      if the justification stopped being true after the edit — **rewrite it, do not leave it**.
- [ ] On the first settle `cumulativePaid === paidAmount` ⇒ the former formula.

### AC6 — the dust check compares with the remainder

- [ ] `if (paidAmount === 0 && owedNow > 0)` instead of `obligationAmount > 0`.
- [ ] The reason to be understood: without this, the legitimate idempotent closure `owedNow === 0`
      (made legitimate in task 3, AC15/addendum §1.11 — the exit from SR-M-4) is rejected on the drop branch,
      and we get that very dead end that AC15 closed.
- [ ] Reachability: edit the income upward → rollback → edit back downward (the AC5 branch of task 3 writes
      `max(newAmount, settledAmount)` into both copies) → the next settle gives `owedNow === 0`.

### AC7 — the money gate: one description

- [ ] `const amount = remainingOwed(claimedAmount)` — the ternary by `isDropObligation` is removed.
- [ ] Justification in a comment: a company-funded drop-settle is forced to USDT
      (`debitsCompanyAccount ⇒ currency = 'USDT'`), the obligation is USDT too ⇒ `paidAmount === owedNow`
      without conversion; on the first settle this is exactly the former `parseFloat(claimedAmount)`.
- [ ] The check of `claimedAmount` against `obligation.amount` **stays** load-bearing: `owedNow` is computed from
      the pre-transaction read, and it is this check that makes it valid.

### AC8 — a new loud refusal at the point of stamping

- [ ] Inside `if (isDropObligation)`, right after the assert `obligationCurrency !== 'USDT'`:
      `priorSettledAmount > 0 && targetCurrency !== obligationCurrency` → `BadRequestException`.
- [ ] The text names the **invariant**, not just "not allowed": a top-up is possible only in the obligation's currency,
      because otherwise the recorded rate would become an average that no payment had.
      The words "error", "corrupted" must not appear; this is a boundary of capabilities, not a breakage.
- [ ] In a comment — why this is not a duplicate of the five existing refusals: they protect **other**
      claims (the obligation's currency, the accumulator's unit, the unit of the write into `pending_obligations`),
      and none is formulated about the triplet. List them by name (addendum 3b, 1.3).
- [ ] The check must be **reachable in a test** (the snapshot/fixture is assembled by hand), otherwise it
      does not differ from a comment.

### AC9 — rolling back a derivative with an unknown accumulator refuses

- [ ] In phase 1 of `applyEditCascade`: `derivativePlan.needsReconfirm && snap.settledAmount === null`
      → 400, **not a single write**.
- [ ] The text names the reason: "how much has already been paid on this row is not recorded (a closure before
      the accumulator appeared) — it cannot be returned to awaiting payout, a manual reconciliation will be needed".
- [ ] Why this is not "just in case": today the set is empty **by theorem** — `settled_amount` and
      `settled_share_percent` were introduced by one task (#599) and are written by one `.set()`, and
      `settledAmount` is written by an `sql` expression and after #599 is never `NULL`; so
      `settled_amount IS NULL` ⟹ the settle was before #599 ⟹ `settled_share_percent IS NULL` ⟹ the resolver
      returns `newAmount: null` ⟹ the first condition of phase 1 refuses. The check makes this theorem
      **refutable**: break any link — and the system will say so loudly instead of paying out
      the full amount again.
- [ ] Placed **next to** the check §1.2 and of the same form (one family, one way of reading).

### AC10 — the invariant §1.2 and term 9 are preserved

- [ ] After a top-up `amount == settled_amount` — verified by a test on a real DB **and** by a unit double.
- [ ] Term 9 is not touched. The transition on a top-up: the row leaves term 9 at `settled_amount`
      (the old debit) and arrives in term 8 at `amount` (the accumulated); the debit difference equals `owedNow` —
      exactly what physically left.
- [ ] At `owedNow === 0` the transition is **ledger-neutral** (both numbers are equal) — verified by a test.
- [ ] The check §1.2 in `applyEditCascade` is neither widened nor narrowed.

### AC11 — provenance of the retractable payment

- [ ] `CASCADE_REOPEN.metadata.before` carries: `amount`, `type`, `status` (as now) **plus**
      `originalAmount`, `originalCurrency`, `exchangeRate`, `receiptDocumentId`,
      `receiptExternalUrl`.
- [ ] Why precisely here: `CASCADE_REOPEN` is written by `dbtx.insert` **inside** the money transaction, unlike
      the best-effort `PAY` after commit — so this is a reliable carrier. Money is still **not counted**
      from the journal (AC5 item 9 of the main ADR); it holds only provenance.
- [ ] The receipt of the first payment will be overwritten on the row on a top-up (`receiptDocumentId: funding?.… ?? null`)
      — this is allowed **only** because the reference is preserved by the journal. Do not clear the column:
      the receipt is an independent record, it was and remains true (criterion 1.5).

### AC12 — idempotency and races are not weakened

- [ ] The conditional claim of `pending_obligations` (`status='PENDING'` + `.returning()`), the check of
      `claimedAmount`, the `WHERE` scope of the flip by `status='PENDING_PAYMENT'` and
      `settled_amount IS NOT DISTINCT FROM` — all stay.
- [ ] The cascade's lock order (`pending_obligations` → `lockCompanyAccount` → `transactions`)
      does not change.
- [ ] A repeated top-up on an already closed row gives the existing «Долг уже закрыт или отменён».
- [ ] The chain "edit → top-up → edit → top-up" gives a **strictly growing** `settled_amount` and
      after each top-up `settled_amount == amount`.

### AC13 — AC13 (the editability classifier) does not change in either direction

- [ ] `classifyEditedRowLedgerFact` is **not touched**: no new predicate, none removed.
- [ ] It is verified and pinned by a test that zeroing the triplet on rollback **opens nothing**:
      a closed drop row keeps refusing on `settledAmount !== null` and on
      `hasClosedObligation`, i.e. the refusal is two-layered even without the first predicate.
- [ ] A rolled-back row (`PENDING_PAYMENT`) does not reach AC13 at all (`isCascadeAmountEdit` requires
      `status === 'PAID'`); it is held by `floorAmountAtAccumulator` — this is **not a regression**, but the
      existing design, and it must be pinned by a test, so that the next reader does not
      "close" a hole that does not exist.
- [ ] `ADMIN_INCOME`, `EXPENSE`, `DIVIDEND_TO_ADMIN` remain editable. Negative tests
      are mandatory.

### AC14 — the schema doc comment describes repeated closing

- [ ] A paragraph is added to the comment of `transactions.originalAmount` (`schema.ts:629` area): on
      a row closed by more than one payment, `original_amount` is the obligation as it finally
      became; `amount` is the sum of all payments; `exchange_rate` is their ratio; the identity
      `amount = original_amount × exchange_rate` holds because a top-up is possible only in
      the obligation's currency (a reference to AC8).
- [ ] The existing sentence "a later `adminEditTransaction` on `amount` does not rewrite it"
      **stays true** and is not deleted: an `amount` edit on such a row is forbidden by AC13, and
      the triplet is reset not by an edit but by a closure.
- [ ] T2 is added: the triplet is non-empty ⟺ the row is in closed form; the rollback zeroes it.

---

## Test AC — what exactly will turn red on the version without the fix

"Covered by tests" is a defect of the task. For each item it is stated **what will turn red**, and this must be
confirmed in fact (backlog item 75): `git stash` the fix, run the spec, attach the failure output
to the PR body. Claims without output are not accepted.

**The blindness of the gates — established facts, not caution:**

- `check-mutation-tally.mjs` goes red only on `Survived`; `NoCoverage` passes silently;
- Stryker has **no mutator for operators inside template strings** — arithmetic that moved into
  `sql\`…\`` is invisible to the gate altogether. Therefore AC4 must have a test reading the **result from the DB**,
  not the shape of the expression;
- the mutation gate **does not see** `*.integration.spec.ts` (`rules/common/mutation-gate-integration-specs.md`)
  — cured by a unit double, not by a second integration test;
- `Integration Tests (Postgres)` is **now a required check on `main`** (verified
  `gh api …/branches/main/protection` 2026-08-23) — a red integration run blocks the merge.
  This removes the former reason to duplicate everything with units "for the merge gate", but does **not** remove
  the need for unit doubles for the mutation gate. Two different gates, two different reasons.

**A separate requirement on currency (backlog item 86).** Conversion at NBU rates and amounts in different
currencies are the very form "the currency lies next to the value but does not enter the arithmetic" that over a day
produced four HIGHs. Therefore for each money claim below **both sides** are checked:
both the number and the currency label next to it. A test asserting only the amount counts as an
unfulfilled item.

| #       | Risk                                                               | Test                                                                                                                                                                                                                                                                                                                 | Goes red on                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | **double payout to the drop** (L1 of addendum 3b)                  | integration: income → drop-IOU 100 USDT → company-settle → edit the income upward (share 130) → top-up. Assert: **exactly 30 left the company account** (`B_after = B_before − 30`), `settled_amount === 130`, `amount === 130`, `settled_currency === 'USDT'`                                                       | removing only the `settleByCompany` guard without AC3: `paidAmount = 130`, 230 goes to the drop, `settled_amount = 230`                                                         |
| **1b**  | the same, visible to the mutation gate                             | unit (`pending-settlement.spec.ts`): a substituted `dbtx` captures `.set()`; assert that the conversion input equals `owedNow`, and that the captured `amount` expression is **identical** to the `settledAmount` expression (comparison by the SQL fragment string, not "both truthy")                              | a mutant returning `obligationAmount` into the conversion input; a divergence of the `amount` and `settledAmount` expressions                                                   |
| **2**   | **T1 violated: the rate from one payment** (L2)                    | integration: the same chain → read the row: `original_amount === 130`, `original_currency === 'USDT'`, `exchange_rate === '1.00000000'`, and **explicitly** `Number(amount) === Number(original_amount) * Number(exchange_rate)`                                                                                     | the numerator `paidAmount` instead of `cumulativePaid`: `exchange_rate ≈ 0.23076923`, the identity is false                                                                     |
| **2b**  | the same, visible to the mutation gate                             | unit: a pure triplet calculation on three sets (`prior=0`; `prior>0`; `obligationAmount === 0`) — assert the exact strings of the three columns                                                                                                                                                                      | replacing `cumulativePaid` with `paidAmount`; `owedNow` in the denominator; removing `obligationAmount > 0`                                                                     |
| **3**   | **the triplet was not reset** (L3)                                 | integration: after the top-up `original_amount !== 100` (the old obligation) — assert specifically **inequality to the old value**, not only equality to the new one                                                                                                                                                 | an implementation that left the stamp from the first payment                                                                                                                    |
| **4**   | **the triplet survived the rollback** (L4)                         | integration: edit the income upward → **before** the top-up read the derivative: `original_amount === null`, `original_currency === null`, `exchange_rate === null`, while `settled_amount === 100`, `settled_currency === 'USDT'`, `funding_source`/`sender_id` intact                                              | an implementation without AC2: a row in `PENDING_PAYMENT` carries the triplet, `amount(130) ≠ original(100) × 1`                                                                |
| **4b**  | the same, visible to the mutation gate                             | unit (`cascade-apply.unit.spec.ts`): the captured rollback `.set()` contains three `null`s **and does not contain** the keys `settledAmount`/`settledCurrency`/`fundingSource`/`senderId`/`receiptDocumentId`                                                                                                        | an "obliging" clearing of the accumulator or receipt; the absence of clearing the triplet                                                                                       |
| **5**   | **dead end at `owedNow === 0`** (AC6)                              | integration: settle 100 → edit upward (share 130) → edit back downward (share 100) → settle: **passes**, row `PAYOUT_DROP`/`PAID`, `settled_amount === 100`, `amount === 100`, the balance did not change                                                                                                            | a dust check left on `obligationAmount`: 400 «сумма выплаты получилась нулевой», nothing to close the row with                                                                  |
| **6**   | **a top-up in another currency writes an average rate** (AC8)      | unit + integration: the accumulator in USDT → an attempt to top up in UAH → **400**, zero writes in both tables. Check the text too: it names the obligation's currency                                                                                                                                              | the absence of AC8: the top-up passes, `exchange_rate` becomes a weighted average that no payment had                                                                           |
| **6b**  | the same refusal does **not** fire on the first settle             | integration: the first drop-settle in UAH (the accumulator is empty) → passes as today, `exchange_rate` = the NBU rate, `original_currency === 'USDT'`, `currency === 'UAH'`                                                                                                                                         | a refusal placed without `priorSettledAmount > 0`: breaks the existing feature `drop-payout-currency`                                                                           |
| **7**   | **unknown accumulator** (AC9)                                      | unit: a snapshot with `obligation.status === 'PAID'`, `settledAmount: null`, `settledSharePercent: 42` (i.e. the resolver gives `newAmount > 0`) → `applyEditCascade` throws 400, `dbtx` received **not a single** write. A mirror case with a non-empty accumulator passes                                          | an implementation without AC9: `?? 0` is read as "nothing paid", the row is rolled back and closed by the **full** amount a second time                                         |
| **8**   | **the cross-currency rollback stopped refusing**                   | integration: a drop obligation closed in UAH → `PATCH` on the source → **400** by the existing AC15(b), the obligation stayed `PAID`, zero writes                                                                                                                                                                    | an implementation that removed AC15(b) "along with" AC15(a): the row is rolled back, the remainder is incomputable, nothing to close with                                       |
| **9**   | **§1.2 diverged after a top-up** (AC10)                            | integration: after each top-up in the chain assert `amount === settled_amount` **and** `currency === settled_currency`                                                                                                                                                                                               | a JS-computed `amount` diverging from the DB-native accumulator at the sixth digit; writing `amount = paidAmount`                                                               |
| **9b**  | the same, visible to the mutation gate                             | unit: two captured SQL fragments are compared as strings (the mutation gate does not see arithmetic inside a template string — hence **the identity of expressions** is checked, not the result)                                                                                                                     | any divergence of the expressions; replacing one of them with a literal                                                                                                         |
| **10**  | **term 9 ↔ term 8 are not neutral**                                | integration: `B1` before the edit → edit upward (rollback) → `B2` → top-up → `B3`. Assert `B2 === B1` (term 9 returned the vanished debit) and `B3 === B1 − owedNow`                                                                                                                                                 | an implementation where `amount` after the top-up does not equal the accumulated: term 8 debits the wrong number, `B3` drifts                                                   |
| **10b** | the same at `owedNow === 0`                                        | integration (a continuation of test 5): the balance **did not change** on closing at a zero remainder                                                                                                                                                                                                                | an implementation where `amount` and `settled_amount` diverged: the transition between terms stops being neutral                                                                |
| **11**  | **top-up source/payer** (AC14 of task 3)                           | integration: company-settle → rollback → top-up with `ADMIN_PERSONAL` → **400**. Control run: a top-up from `COMPANY_ACCOUNT` passes                                                                                                                                                                                 | an implementation that accidentally weakened the AC14 guard while editing neighboring lines                                                                                     |
| **12**  | **AC13 opened or closed too much**                                 | unit on `classifyEditedRowLedgerFact`: a closed drop row with `originalAmount: null` (the form after a future rollback) → still a refusal on `settledAmount`; `ADMIN_INCOME`/`EXPENSE`/`DIVIDEND_TO_ADMIN` → `null`. Plus: `isCascadeAmountEdit` on `PENDING_PAYMENT` → `false`                                      | adding a new predicate "for company"; removing `settledAmount !== null`; an attempt to extend AC13 to `PENDING_PAYMENT`                                                         |
| **13**  | **provenance lost** (AC11)                                         | integration: before the edit the row has `receiptExternalUrl` and a triplet → after the edit read `transaction_audit_log`: a `CASCADE_REOPEN` entry, `metadata.before` contains **each** of the five fields by name                                                                                                  | an implementation journaling only `{amount,type,status}`: the receipt link of the first payment vanishes without a trace                                                        |
| **14**  | **the currency is next to it but not in the arithmetic** (item 86) | a property test on the triplet calculation: the generator must produce pairs `(obligation currency, payment currency)` **including differing ones** and the combination "accumulator > 0 with a `PENDING` obligation" (item 87). The claim: with differing currencies the function **refuses**, not returns a number | a generator deriving the payment currency from the obligation currency: the disputed combination is never produced and the invariant is asserted where it could not be violated |
| **15**  | **the first settle changed**                                       | a run of the existing `drop-payout-currency.integration.spec.ts`, `drop-payout-company-account.integration.spec.ts`, `settled-amount-snapshot.realdb.integration.spec.ts` **without edits** — all green                                                                                                              | any change in the behavior of the first settle; the need to edit an existing spec = a signal that AC3/AC4/AC5 broke "byte-for-byte"                                             |
| **16**  | tautological test                                                  | `MUTATION_BASE_SHA=$(git rev-parse origin/main) node scripts/devops/mutation-gate.mjs --changed` + **read the log**, not the verdict: zero `Survived` with a non-empty `NoCoverage` without an integration hint = a defect                                                                                           | a mutant in the top-up arithmetic that no test kills                                                                                                                            |

Additionally (project rules, not optional):

- `Skill('security-review')` **before** the first edit of `settleByCompany`; the surface is monetary ⇒
  `security-reviewer` in the review is **mandatory**.
- `Skill('superpowers:test-driven-development')` — the test before the implementation.
- `Skill('superpowers:verification-before-completion')` — before declaring readiness.
- `Skill('diagnosing-bugs')` — if a test goes red not where expected.
- E2E locally before push; push of the feature branch — `DATABASE_URL= git push`.
- The live `crm_db` is not needed; integration specs — on a scratch/QA DB, `DATABASE_URL` **inline**
  in the command (`rules/common/live-db-access.md`).

---

## Assumptions

Filled in by the executor as work proceeds (A1 decisions). Those already made by the architect — below; each is reversible
within this PR.

- **The triplet is zeroed by the rollback, not survived by it.** The criterion — "that is zeroed whose truth
  is formulated relative to the `amount` that the rollback rewrites" (addendum 3b, 1.5). The alternative
  ("keep it, reset only on closure") would leave a window between the edit and the top-up in which a
  row in `PENDING_PAYMENT` claims to be paid, and this window is exactly the time when the owner
  looks at "how much to top up". · reversible, rollback: remove the three `null`s from one `.set()`.
- **The boundary of 3b — a top-up only in the obligation's currency.** A cross-currency top-up remains a loud
  refusal (AC8). The reason: it requires per-payment recording (a separate table), i.e. a different task;
  and in the reachable population it is unreachable anyway (addendum 3b, 1.3). A narrow working subset
  plus an explicit refusal is better than a broad solution with a silently wrong rate. · reversible, rollback: remove
  AC8 together with implementing per-payment recording.
- **`amount` is written by a DB-native expression, not a JS number.** It makes §1.2 structural rather than
  asserted; the same argument by which MED-3 (#599) demanded a DB-native increment of the accumulator. The cost:
  arithmetic moves into a template string, where Stryker has no mutator — compensated by test 9b
  (comparing expressions as strings) and test 9 (the result from the DB). · reversible, rollback: replace with
  `String(cumulativePaid)` and add an equality assertion.
- **`tx_date` and `receipt_*` on a row closed twice stay from the last payment.**
  `tx_date` reads as "the day the obligation was closed" — meaningful and not money. `receipt_*` —
  acceptable **only** because the receipt link of the first payment is preserved in
  `CASCADE_REOPEN.metadata.before` inside the money transaction (AC11). Without AC11 this would be a
  silent loss of payment evidence. · reversible, rollback: add snapshot columns if the
  owner wants to see both receipts on the row.
- **AC15(a) is replaced by four narrower refusals, not deleted.** The AC15 law ("do not roll back
  what you will not be able to close") continues to hold: currency — AC15(b) + `OBLIGATION_CURRENCY_MISMATCH`;
  the remainder — the `max` rule; source and payer — the AC14 guard; unknown accumulator — the new AC9.
  · reversible, rollback: return the one line `snap.type === 'PAYOUT_DROP' && settledAmount > 0`.

---

### Accepted by the executor during implementation (A1)

- **Six fields were added to `CascadeDerivativeSnapshot`, not three.** The task listed the triplet,
  but AC11 requires the receipt links in the journal as well, and SR-M-1 (review) — the payment date; and
  `applyEditCascade` reads only the snapshot. `loadCascadeSnapshot` already selects the whole row, so
  no second round-trip was introduced — only the mapping expanded. · reversible, rollback: remove
  `receiptDocumentId`/`receiptExternalUrl`/`txDate` from the snapshot together with the corresponding keys of
  `CASCADE_REOPEN.metadata.before`; the cost — the provenance of the retractable payment is lost again on
  a top-up.
- **The AC9 refusal stands right AFTER the check §1.2, not before it.** "Next to and of the same form" is
  set by the task, the order is not. Placing it earlier was tempting (the diagnosis is more precise: §1.2 prints
  `settled_amount = 0`, obtained by that very `?? 0` which AC9 does not trust), but this would narrow the
  reachable population of §1.2, and AC10 requires neither widening nor narrowing it. · reversible, rollback:
  swap the two blocks; the cost — §1.2 becomes unreachable on rows with an empty accumulator,
  i.e. the behavior of a check the task asked not to touch changes.
- **The unit tests of the top-up live in `pending-settlement.drop-currency.spec.ts`**, although test-AC 1b
  names `pending-settlement.spec.ts`. The first file is the home of the drop block by its own header and
  already carries the needed harness (`state.flips`, substitution of NBU rates); the second is senior-oriented and
  received only an edit of its drop fixture. · reversible, rollback: move the describe entirely, together
  with the harness.
- **The unit double now renders money columns the way `numeric(18,6)` does.** Ten
  existing assertions compared `'1000'` with what Postgres actually returns as
  `'1000.000000'`; the double described itself, not the database. Verified on a real DB (a value written
  as `String(2500)` reads back as `'2500.000000'`). One assertion "no more than two digits in
  the string" was reformulated to the value — the string form is not what the column stores. · reversible,
  rollback: return the double's character-by-character passthrough and the ten assertions to their former form; the cost — the double
  again diverges from the database in the direction where the divergence is not visible.
- **The accumulator expression is extracted into a single `const accumulatedAmount`** (review finding CR-M-1) and
  is used by both columns. A test comparing fragments would after that have become a tautology, so it was
  strengthened to a comparison by reference (`toBe`): it catches exactly the regression that the extraction is meant to
  prevent — re-inlining a separate, textually identical expression.
  · reversible, rollback: write the expression twice and return the compiled-form comparison to the test.
- **`notes` of a rolled-back row is rewritten to a description of the current state**, not restored
  to the text of the booking (SR-L-2). The original text carries a caller-supplied prefix
  (`bookCompanyObligations`, `notePrefix`) that the row does not store — restoring would mean
  inventing it. The only SQL predicate on `notes` is `eq(transactions.notes, confirmationNote)`
  in `confirmPayout`, and both of its branches are scoped to `type='PAYOUT_CONFIRMED'`, whereas a rolled-back
  derivative is `*_PENDING_PAYOUT`; it does not fall into that population (clarified in round 2: the former
  wording "logic does not branch on it" was broader than the truth). · reversible,
  rollback: remove one key from `.set()`; the cost — a row awaiting payout again reads as
  «Выплата … IOU».

## Do not touch

- Ledger terms 1–9 (`company-account-balance.ts`) — not a single byte. If it seems needed —
  this is a sign that the decision has gone the wrong way: the whole point of addendum 3b is that the top-up fits
  into the existing formula.
- `assertNoOffCurrencyCompanyRows` and its OR branch.
- The pure resolver `resolveEditCascade` / `resolveDerivative` — its branches do not change.
- `classifyEditedRowLedgerFact`, `floorAmountAtAccumulator`, `isCascadeAmountEdit`, `amountsDiffer`.
- Guards 1 and 2 of `adminUpdateTransaction`; BIZ-18 in its current form.
- The HIGH-1 guard (`dropCascadeOrigin`), the guard `sourceSettledCurrency !== currency`, the guard
  of source/payer, the check §1.2, AC15(b).
- The senior branch of `settleByCompany` (its top-up was done by task 3).
- The monotonicity of `settled_amount`.
- Neighboring defects found during the analysis (addendum 3b, "Found along the way") — to the backlog, not here.

---

## Verification (Coder before `git push`)

```bash
pnpm typecheck
pnpm --filter @crm/api test                      # unit
DATABASE_URL=postgres://…/crm_scratch pnpm --filter @crm/api test:integration   # inline, NOT export
MUTATION_BASE_SHA=$(git rev-parse origin/main) node scripts/devops/mutation-gate.mjs --changed
DATABASE_URL= git push -u origin feature/drop-topup
```

Into the PR body:

- the failure output of **each** test from the table on the version without the fix (`git stash` → run → output);
- the whole log of the mutation gate, not the verdict;
- the "Assumptions" block with exactly the lines above (`rules/common/autonomy-levels.md`);
- the `Findings:` line when receiving a review and a report on each identifier
  (`rules/common/review-findings-transfer.md`).
