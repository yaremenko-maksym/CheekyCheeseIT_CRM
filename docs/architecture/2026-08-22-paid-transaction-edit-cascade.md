# 2026-08-22 — Editing the amount of a paid transaction: the dependency map and the cascade mechanics

## Status

Proposed — an analysis, implementation not started. Backlog item 178, the owner's decision 2026-08-22.
Zone: only `docs/architecture/**`. `apps/**` and `packages/**` were not touched.

> **The code version from which ALL line numbers are read: `origin/main` = `166897df`**
> (the last commit — `fix(api): fail resume upload after a successful render (bug 44)`, #591;
> includes #587 "idempotency of incomes" and #590 "the link of a payout with obligations").
> `transactions.service.ts` — 7478 lines at this SHA. References of the form `file:NNNN` are valid
> only for it: the file changes fast (over the 11 commits before this SHA it changed by
> +672/−141). Before using the references, reconcile by the **symbol name**, not by the number —
> the names in the text are given everywhere precisely for this.

## Context

The owner decided to allow ADMIN to edit the amounts of already-paid transactions — as a **general mechanism
of correcting errors** in posted money, not as a patch under one bug. The mechanics set by the owner
(a given, not up for discussion):

1. before saving, show which derivative transactions will be recomputed;
2. after saving the derivatives, **if they were paid**, are returned to `PENDING` and require
   re-confirmation by the new amounts;
3. in such a row it is visible **how much has already been paid out**, to understand the difference to top up.

Today the edit is held by three guards in a cascade (`transactions.service.ts:2944-2983`):

| #   | Guard                                                                  | Removed? |
| --- | ---------------------------------------------------------------------- | -------- |
| 1   | `type ∈ {PAYOUT, PAYOUT_ADMIN, PAYOUT_CONFIRMED}` → forbidden entirely | no       |
| 2   | `payoutRequestId IS NOT NULL` → forbidden entirely                     | no       |
| 3   | `status = 'PAID'` → cannot edit `amount` / `currency` / `salaryMonth`  | **yes**  |

Below — a map of what hangs on the amount of one row, and what will happen when the third guard goes.

---

## AC1 — The dependency map

### The method (why this is not "one grep")

The map was built by four independent passes, so that completeness is verifiable, not declared:

1. **From the schema down** — all columns storing a derivative of the amount or a reference to the source row
   (`schema.ts`: `sourceIncomeTransactionId`, `closingTransactionId`, `sourceTransactionId`,
   `payoutRequestId`, `seniorSharePercent`, `dropSharePercent`, `originalAmount`, `exchangeRate`,
   `pending_obligations.amount`, `payout_requests.incomeAmount/payableAmount`).
2. **From the write down** — all methods that write an amount or compute from it
   (`bookCompanyObligations`, `declareUsdtProjectIncome`, `applyPayoutPaidCascade`,
   `createPayoutRequest`, `settleByCompany`, `paySalary`, `submitDeposit`, `createDividend`).
3. **From the read up** — an exhaustive list of the API files reading a transaction amount:
   `grep -rln "transactions\.amount\|tx\.amount\|\.amount)" apps/api/src --include='*.ts'` (without specs)
   gives exactly **eight** files: `balance.service.ts`, `company-account.service.ts`,
   `pending-settlement.service.ts`, `salary-status.helper.ts`, `transactions.service.ts`,
   `invoice-pdf.service.ts`, `invoices.service.ts`, `users.service.ts`. Each is examined below.
   (`projects.service.ts` does not read amounts at all — verified, zero occurrences.)
4. **Reconciliation with a previously adopted decision** — the "silo-consumers of the flipped row" table from ADR
   `2026-07-14-settle-transition-in-place.md` §"Silo-consumers" (5 consumers). My map is
   its superset; no discrepancies were found, which indirectly confirms the completeness of both.

The result — **19 links** (L1–L19), including both added by the last merges: #590
(`pending_obligations.payoutRequestId` — L18) and #587 (idempotency of incomes — L19).

### What exactly will become editable

After the removal of guard 3 any `PAID` row becomes editable, except the `PAYOUT` family
(guard 1) and any row with a `payoutRequestId` (guard 2). This is, in particular:

`ADMIN_INCOME` · `SENIOR_INCOME` · `DROP_INCOME` (without a payout) · `EXPENSE` · `SALARY` ·
`COMPANY_DEPOSIT` · `DIVIDEND_TO_ADMIN` · `DIVIDEND_TAX` · `ADMIN_TRANSFER` · `TOV_INCOME` ·
`SENIOR_PAID` · `ADMIN_INCOME_CASH` / `_CRYPTO` · `SENIOR_INCOME_CRYPTO` — **and, most importantly,
flipped obligations** (`SENIOR_INCOME` / `PAYOUT_DROP`, for which `settleByCompany` reset
`payoutRequestId := null`, `pending-settlement.service.ts:857`). That is, not only the source
but the derivative itself becomes editable.

### The map

Format: **(a)** how it is linked technically · **(b)** what will happen on an edit of the source amount ·
**(c)** whether the discrepancy is detectable today.

---

#### L1. `ADMIN_INCOME` → the senior IOU (`SENIOR_PENDING_PAYOUT`) + a `pending_obligations` row

- **(a)** `declareUsdtProjectIncome` (`transactions.service.ts:2166-2183`) in one DB transaction
  inserts the income and calls `bookCompanyObligations` (`:4629-4759`). It writes an IOU-row with
  `amount` = `roundShareAmount(incomeAmount, seniorSharePercent)` (`:4671`) and
  `sourceIncomeTransactionId` = the income id, and next to it — a `pending_obligations` row
  with **the same number as a second copy** (`:4693-4707`).
- **(b)** Both copies will remain old. The income will become, say, 10,000, and the obligation to the
  senior — as it was from 8,000. The money the company owes is computed from an amount that no longer
  exists.
- **(c)** **No.** No reconciliation "the share == the percent × the income" exists in the system either on a read,
  or on a write, or in the reports. The discrepancy will not surface anywhere until a human adds the
  numbers by hand.

#### L2. `ADMIN_INCOME` → the drop IOU (`DROP_PENDING_PAYOUT`) + `pending_obligations`

- **(a)** The same, the `drop` branch in `bookCompanyObligations` (`:4712-4755`), `amount` =
  `roundShareAmount(incomeAmount, dropSharePercent)` (`:4713`). Protected from a double booking by the partial
  unique index `uq_transactions_source_income_drop_link` (`schema.ts:1072-1076`) — **one**
  `DROP_PENDING_PAYOUT`/`PAYOUT_DROP` per one `source_income_transaction_id`.
- **(b)** Like L1.
- **(c)** No. **An important consequence for the design:** this index makes it physically impossible to create
  a SECOND drop-row from the same income — that is, the cascade is obliged to **update** the existing
  derivative, not to write a delta-row next to it (see AC3).

#### L3. The double copy of the obligation amount: `transactions.amount` ↔ `pending_obligations.amount`

- **(a)** The same number lives in two tables. Different readers take different copies:
  the funds-sufficiency money-gate reads **`obligation.amount`**
  (`pending-settlement.service.ts:780`), and the company account ledger debits by
  **`transactions.amount`** (`company-account-balance.ts:333-357`).
- **(b)** An edit of one side desynchronizes the gate and the ledger: the system will check one amount, and
  debit another.
- **(c)** **No — and this is already broken, independently of the task.** An IOU-row born of
  `declareUsdtProjectIncome` has `payoutRequestId = NULL` and the status `PENDING_PAYMENT` (not `PAID`).
  So **none of the three guards holds it** — `adminUpdateTransaction` can change its
  `amount` **already today**, and the paired `pending_obligations` row will not follow it.
  This is a live defect found by this analysis; it is exactly the class of item 170 — a symmetric
  invariant that is checked only from one side. A query to assess the scale — §SQL, №4.

#### L4. An already-**closed** obligation (settle done) — the heaviest case

- **(a)** `settleByCompany` closes an obligation not by inserting a second row, but by a **flip
  of the original in place** (`pending-settlement.service.ts:805-893`, ADR 2026-07-14). On the flip:
  `type` → `SENIOR_INCOME` / `PAYOUT_DROP`; `status` → `PAID`; `payoutRequestId` → `null` (`:857`);
  the obligation's `closingTransactionId` → a reference to **this very row** (`:918`);
  and — critically — **`seniorSharePercent` / `dropSharePercent` are zeroed** (`:869-872`).
- **(b)** Editing the source amount requires recomputing the share, but **the percent by which it was computed
  is physically destroyed**. Deriving the new share from the derivative row itself is impossible. The live resolver
  cannot be called (that would rewrite the price of an already-made deal — see C1). Plus the money has already
  left: either from the company account, or from the admin's personal account.
- **(c)** No. The zeroed percent does not even look like a loss — it is zeroed **deliberately**: the balances
  read `seniorSharePercent` as a GROSS↔NET discriminator (`balance.service.ts:265-272`, `:385-388`),
  and a non-zero value on a flipped row would give a ~26-fold undercount of the senior. That is, the field can be
  neither left nor restored "as it was" — a separate storage place is needed (AC3).

#### L5. `payout_requests.incomeAmount` / `payableAmount` — a stored derivative

- **(a)** `createPayoutRequest` (`transactions.service.ts:4207-4233`) sums the `amount` of the selected
  `VALIDATED` incomes, applies the percent and the NBU rate, and **writes the result into two columns**.
  The placeholder `PAYOUT` row gets `amount = payableAmount` (`:4284`) — a third copy.
- **(b)** There is no recompute either on a read or on an edit. Worse: `payPayoutRequest` requires the
  on-chain transfer to match `payableAmount` **exactly, without a percent tolerance**
  (`:4439-4464`, "The amount of the on-chain transaction must match exactly"). After the payment this transfer is already
  in the blockchain — recomputing `payableAmount` for the new income amount means declaring the completed
  transfer wrong.
- **(c)** Partially: the discrepancy will surface on the next attempt to pay the same payout (the exact-match
  gate), but not earlier and not as a report. **Today this is closed by guard 2** — the incomes that went into
  a request carry a `payoutRequestId` and are non-editable. Guard 2 is the only thing holding this link.

#### L6. The drop-payout chain (two-level)

- **(a)** `DROP_INCOME` → `createPayoutRequest` → `PAYOUT` → `applyPayoutPaidCascade` →
  `bookCompanyObligations` (`:5153-5162`) → the senior IOU **and** the drop IOU → `settleByCompany` → the flip.
- **(b)** Editing the source `DROP_INCOME` would have to go through two levels: recompute
  `payout_requests`, then both IOUs.
- **(c)** Not applicable: the chain's entry carries a `payoutRequestId`, guard 2 blocks. **This is exactly what
  makes the cascade one-level** — see AC3, the question about depth.

#### L7. The company account balance (`sumLedgerTerms`, 8 terms)

- **(a)** The balance is **not stored**, it is derived from the ledger on every read
  (`company-account-balance.ts:267-370`): `COMPANY_DEPOSIT + PAYOUT(COMPANY_ACCOUNT) +
ADMIN_INCOME(COMPANY_ACCOUNT) − DIVIDEND_TO_ADMIN − SALARY(CA) − EXPENSE(CA) − SENIOR_INCOME(CA) −
PAYOUT_DROP(CA)`, all terms with `status='PAID' AND currency='USDT'`.
- **(b)** By **amount** — it will recompute itself, the edit is sufficient. By **currency** — a catastrophe, see L8.
  By **status** — if the mechanism rolls back `PAID` → `PENDING`, the corresponding term will disappear and the balance
  **will grow by the already-spent money** (see AC3).
- **(c)** Yes, indirectly: the gates compare the balance with the operation amount and will refuse if the money "is not
  enough". But the opposite error (the balance is overstated) is not detected — on the contrary, it permits extra spending.

#### L8. The company account currency guard

- **(a)** `assertNoOffCurrencyCompanyRows` (`company-account-balance.ts:228-254`) counts `PAID`
  company-rows with `currency <> 'USDT'` and **throws an exception** if there are any.
  On `computeCompanyAccountBalanceFromLedger` hang **four money gates**: `createExpense`,
  `paySalary`, `settleByCompany`, `createDividend` (`:372-380`) — they are fail-closed by design.
- **(b)** One edit of the **currency** of one paid company-row stops **all** payouts in the
  system with a 500 error, until the row is fixed. The comment in the code describes this situation
  verbatim: "Every write path that creates one of these rows hardcodes 'USDT' today … it is a trap
  for a FUTURE write path that forgets to, not a live bug" (`:184-190`). Removing the currency condition of
  BIZ-18 **is that very future write path**.
- **(c)** Yes, loudly — but at the price of a full stop of money operations. The diagnostic screen in doing so
  survives (`computeCompanyAccountBalanceForDisplay`, degraded mode).

#### L9. Personal balances and summaries (`getSummary`, `getSeniorBalance`, `getTotalEarned`, `computeDropAggregate`, `getAdminBalance`)

- **(a)** All computed on the fly by a full scan of the ledger with the filter `deleted_at IS NULL` + `status='PAID'`
  (`transactions.service.ts:5385+`, `balance.service.ts:171/230/330`). Conversion to the base currency —
  `convertToBase` by the **live** NBU rates.
- **(b)** They recompute themselves. The amount edit is sufficient.
- **(c)** Not required — no discrepancy arises.

#### L10. The GROSS↔NET discriminator on `SENIOR_INCOME`

- **(a)** `balance.service.ts:265-272` and `:385-388`: `seniorSharePercent IS NOT NULL` ⇒ `amount` is
  GROSS, the senior's share = `amount × percent/100`; `NULL` ⇒ `amount` is already NET (a row after settle).
- **(b)** An `amount` edit recomputes itself, because the percent is taken **from the row** (a snapshot) —
  correct behavior. But this also means: **the percent must not be touched** (C1), otherwise what changes is not
  the number but the meaning of the row.
- **(c)** Not required.

#### L11. Salary: `salaryMonth` and the monthly aggregates

- **(a)** `getOwnSalaryStatus` (`salary-status.helper.ts:56-66`) looks for a row by the pair
  `(receiverId, salaryMonth)`; the partial unique index `uq_transactions_salary_receiver_month`
  (`schema.ts:1024-1026`) forbids two `SALARY` rows per pair. The report on missed months —
  `getSalaryMonthGapReport`.
- **(b)** Editing `salaryMonth` moves the payout between months; on a collision with an existing row
  a 23505 will arrive, and the error handler accounts for this explicitly (`transactions.service.ts:3099-3109`).
- **(c)** **Partially no: a month change is not written to the journal at all.** The write condition is
  `amountChanged || currencyChanged || receiverLabelChanged` (`:3056`), `salaryMonthChanged`
  is computed (`:2973`), participates in the BIZ-18 guard (`:2979`), but is **not** in the journaling
  condition. Confirmed; this is exactly the gap named in the preamble.

#### L12. The payment-fact triplet: `originalAmount` / `originalCurrency` / `exchangeRate`

- **(a)** Written by `paySalary` and the drop branch of `settleByCompany` (`schema.ts:629-687`,
  `pending-settlement.service.ts:820-826`). `amount` = how much really left, `originalAmount` = what
  the obligation was, `exchangeRate` = `paid / original` — the **effective applied rate**.
- **(b)** The schema comment directly warns: "A SNAPSHOT of what was applied at pay time (like
  `senior_share_percent`) — a later `adminEditTransaction` on `amount` does not rewrite it"
  (`schema.ts:665-668`). That is, after an `amount` edit the identity
  `exchangeRate == amount / originalAmount` stops holding. The row will start asserting a rate that did not exist.
- **(c)** **No.** No reader checks this identity.

#### L13. The invoice: a PDF in S3, signatures, a public verification

- **(a)** The amount is baked into the **PDF bytes** at generation; `invoice_signatures.pdfHash` fixes the
  SHA-256 of the signed document; `transactions.invoiceDocumentId` points at the active PDF.
- **(b)** Three different consequences, all hidden:
  1. The counterparty's signature **will not break**: the verification reconciles the hash of the **file stored in S3**, not
     of a re-render (`invoices.service.ts:773-782`). The amount edit does not touch the file.
  2. But after the counterparty signs, the PDF is **re-rendered from the live `tx.amount`** (`:800-925`) and
     replaces the previous one. The final two-sided-signed document will contain the **new** amount,
     while the hashes fixed in `invoice_signatures` refer to the **old** file. After this no one
     reconciles them — the discrepancy is mute.
  3. The public verification by the QR code from the paper (`verifyInvoice`, `:985`) returns the **live** `tx.amount`.
     A counterparty with a printout of 8,000 will scan the code and see 10,000.
- **(c)** **No.** This is exactly the class of item 168: in the CRM everything looks consistent, while the discrepancy lives
  outside — in a document that is already with the counterparty.

#### L14. On-chain observed amounts

- **(a)** `COMPANY_DEPOSIT.amount` — not our computation, but **what really arrived over the blockchain**
  (`company-account.service.ts:356-377`, `amount = verification.amountUsdt`). `payout_requests.payableAmount`
  is reconciled with the actual transfer exactly (L5). In the row itself lies a reference to the explorer.
- **(b)** The edit makes the ledger contradict the blockchain — with a live proof reference right in
  this same row.
- **(c)** Yes, but only manually: open the reference and compare. There is no automatic re-verification of a `PAID`
  deposit (`pollDeposit` works only on `PENDING`).

#### L15. Notifications

- **(a)** The amount is formatted into the notification text at creation (`invoices.service.ts:369`, `:531`,
  `:936`).
- **(b)** A sent notification contains the old amount forever.
- **(c)** Not applicable — this is a fact of communication, not a state. Not subject to an edit.

#### L16. Soft deletion — a parallel (not closed) hole

- **(a)** `adminDeleteTransaction` refuses to delete a row referenced by an obligation
  (`transactions.service.ts:3187-3194`, a check by `pending_obligations.sourceTransactionId`).
- **(b)** But the obligation references the **IOU**, not the income. So the `ADMIN_INCOME` that generated the
  obligations **is deleted without obstruction already today** — the `sourceIncomeTransactionId` link
  is not covered by this check.
- **(c)** No. Noted as a neighboring defect; not needed to fix in this task (AC5, item 10), but when
  designing the cascade it is logical to extend this check to `sourceIncomeTransactionId` too.

#### L17. `users.service.ts` — the warning on archiving

- **(a)** `getPendingTransactionsForArchiveWarning` (`:1355-1374`) shows the amounts of the employee's `PENDING` rows
  before archiving.
- **(b)** Reads live, only `PENDING`. Recomputes itself.
- **(c)** Not required.

#### L18. `pending_obligations.payoutRequestId` — a durable link "from which payout it arose"

The column was added by PR #590 (backlog 74/B-1) after the posing of this task — accounted for separately.

- **(a)** Stamped **once** at booking (`bookCompanyObligations`, `:4706` and `:4753`) with the same
  `payoutRequestId` that the IOU-row gets. This is a **deliberately separate** column from
  `transactions.payoutRequestId`, which `settleByCompany` resets to `null` on the flip
  (`:857`) — and which the reset therefore does not affect (`schema.ts:1310-1330`). It exists exactly
  so that after the obligation is closed the detailed payout screen can still answer "which
  obligations arose from it".
- **(b)** It does **not depend** on the amount at all — an `amount` edit does not affect it. But it is important to the cascade from
  the other side: it is the **only** link "obligation ↔ payout" that survived the flip, and therefore
  the only way to understand that a derivative row originates from the payout cascade, not from
  an admin declaration. The preview (AC4) must read exactly it, not `transactions.payoutRequestId`
  (on a closed row that is already `null`).
- **(c)** Not applicable (not a monetary value). An important limitation: the FK has
  `ON DELETE SET NULL` and the schema directly marks the column as "informational (display only), never a
  security/money gate" — **it cannot be relied on as a guard**. For the discrimination
  "cascade vs declaration" a positive marker `transactions.dropCascadeOrigin` exists
  (`schema.ts:709-765`), which is stamped once and is not derived from the FK precisely because
  `SET NULL` would make such a guard refuse **in the open** direction.

#### L19. Idempotency of incomes (#587) — what the cascade is obliged not to break

- **(a)** `SENIOR_INCOME` and `DROP_INCOME` got client idempotency keys with partial
  unique indexes `uq_transactions_senior_income_idempotency_key` /
  `uq_transactions_drop_income_idempotency_key` (`schema.ts:1044-1065`), in one namespace
  with those already existing for `ADMIN_INCOME` and `DIVIDEND_TO_ADMIN`.
- **(b)** An amount edit does **not** change `idempotencyKey`, and it must not change it: the key is
  the "intention" of a specific request, not a property of the amount. The same contract is already fixed for
  `ADMIN_INCOME`: a repeat of the key with a DIFFERENT payload returns the first fixed row and
  ignores the new amount (`transactions.service.ts:2010-2015`).
- **(c)** Yes, physically: an attempt by the cascade to insert a duplicate will run into a 23505. The practical consequence for
  the implementation — the cascade is obliged to **update** the derivatives, not to insert (AC3, idempotency item 4);
  the keys here work as insurance, not as the mechanism.

---

## AC2 — Classification by danger

### Category A — a cascade is mandatory (the derivative is computed from the amount)

| #   | Link                                                      | Why it is mandatory                                                                                 |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A1  | `ADMIN_INCOME` → the senior IOU (L1)                      | the IOU `amount` = `percent × income`; after the edit the basis disappeared                         |
| A2  | `ADMIN_INCOME` → the drop IOU (L2)                        | the same                                                                                            |
| A3  | `transactions.amount` ↔ `pending_obligations.amount` (L3) | two copies of one number; the money-gate and the ledger read **different** ones                     |
| A4  | An already-closed obligation (L4)                         | the money is gone; the percent is destroyed; a return to PENDING is needed by the owner's mechanics |
| A5  | `payout_requests.incomeAmount/payableAmount` (L5)         | a stored derivative — **but fixed by guard 2, not by the cascade** (AC5)                            |

### Category B — recomputes itself (the aggregate is computed on the fly)

| #   | Link                                                                  | Correctness condition                                              |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| B1  | The company account balance (L7)                                      | an **amount** edit — yes; currency and status edits — no (L8, AC3) |
| B2  | `getSummary`: incomes / expenses / salaries / balances / monthly (L9) | —                                                                  |
| B3  | `getSeniorBalance`, `getTotalEarned` (L9, L10)                        | the percent is taken from the snapshot row                         |
| B4  | `computeDropAggregate`, `getAdminBalance` (L9)                        | —                                                                  |
| B5  | The salary status and the missed-months report (L11)                  | an edit of `salaryMonth` — yes, but the journal stays silent (L11) |
| B6  | The warning on archiving (L17)                                        | —                                                                  |
| B7  | Conversion to the base currency by the NBU rates                      | the rate is live anyway — USD reports "drift" even without edits   |

### Category C — a snapshot by design (must not be touched)

This is the most dangerous category, because "recompute along the way" looks here like accuracy.

#### C1. `seniorSharePercent` / `dropSharePercent` (+ their `*Source`)

**Why a snapshot is obliged to remain a snapshot.** The percent is resolved by the hierarchy
`project → team → user` **at the moment of the deal** (`senior-share-resolver.ts:73-103`) and
written onto the row "verbatim … and is never recomputed on read" (there, the doc-comment).
Three independent arguments, each sufficient:

1. **Economic.** The percent is the price agreed upon then. A recompute by today's
   value retroactively rewrites the terms of a completed deal: a change of the senior's rate in
   February would re-price all last year's incomes.
2. **Technical.** The value is read as a GROSS↔NET discriminator on **every** balance read
   (`balance.service.ts:272`, `:388`). A percent change changes not the number, but the **meaning** of the `amount` column
   for this row.
3. **Determinism.** The schema comment fixes this as a contract: "makes the distribution
   deterministic (changing `users.dropSharePercent` later does not retroactively re-price existing
   rows)" (`schema.ts:773-777`).

**What this means for the cascade:** the new share = `roundShareAmount(new_income, THE_OLD_percent_from_the_row)`.
The live resolver must **never** be called in the cascade. If there is no snapshot (a legacy row or a row after
settle, where it is zeroed) — the cascade is obliged to **refuse**, not to guess.

#### C2. `originalAmount` / `originalCurrency` / `exchangeRate`

**Why a snapshot.** This is the protocol of the actual payment: "800 USD of obligation was closed by 30,000 UAH at
rate 37.5". The rate is not a reference value, but `paid / original` **of that very transfer**. A recompute by
today's NBU rate would lie about the rate at which the bank payment really went; the statement
after this cannot be reconciled. The schema fixes this explicitly (`schema.ts:665-668`).

**A trap easy to miss:** an `amount` edit on such a row breaks the identity
`exchangeRate == amount / originalAmount`, and no one checks this (L12). Hence the recommendation
AC5, item 5.

#### C3. A signed invoice (a PDF + `invoice_signatures.pdfHash`)

**Why a snapshot.** This is a **legal artifact outside the system**. It is not a "display of an amount", it is
a document that the counterparty signed and holds. Recomputing it is impossible by definition:
the signature refers to specific bytes. The only honest options are to not touch it or to explicitly
void and reissue with a new signature. A silent re-render (which happens today, L13)
is worse than both: it substitutes the document's content while keeping the signatures from the previous one.

#### C4. On-chain observed amounts (`COMPANY_DEPOSIT.amount`, the `payableAmount` reconciliation)

**Why a snapshot.** This is not our computation and not our opinion — it is an **external fact**, recorded
by the blockchain, with a proof reference in the same row. The edit does not "fix an error", but creates
a discrepancy with an independent source of truth that is verified in one click.

#### C5. `companyNameSnapshot` on the IOU

**Why a snapshot.** Not money, but the same nature: the company name at the moment of booking. The schema explains
this as "the one thing a money-history view must never do" — renaming a project must not
rewrite the history of already-booked money (`schema.ts:852-877`). Mentioned for the completeness of the
contract: the cascade must not "refresh" it.

#### C6. Delivered notifications

**Why a snapshot.** A sent message is an event, not a state. Not subject to an edit.

#### C7. `pending_obligations.amount` of a **closed** obligation

**Why a snapshot.** On a closed row this is no longer "how much is owed", but "how much was owed and how much
was closed" — a historical record of the settlement. An overwrite would turn history into a current opinion. On the
cascade one must correct the **difference to top up**, not rewrite the closed amount (AC3).

#### C8. `pending_obligations.payoutRequestId` and `transactions.dropCascadeOrigin` (L18)

**Why a snapshot.** Both are stamped **once at creation** and deliberately **not derived** from
the live FKs — because `transactions.payoutRequestId` is reset on the flip (`:857`), and the FK itself
has `ON DELETE SET NULL`. The schema explains the cost of deriving instead of stamping in plain text: a guard
relying on the live FK would, on zeroing, **refuse in the open** direction (`schema.ts:731-742`).
The cascade is obliged to read these columns, but has no right to "refresh" or recompute them: they
describe the row's origin, and the origin does not change from someone having corrected an amount.

**A separation of roles:** `payoutRequestId` — display only (the schema directly marks it "never a
security/money gate"); the discriminator for decisions is `dropCascadeOrigin`, and only an explicit `false`
is treated as permitting (`null` is treated as BLOCK). The cascade is to inherit this same asymmetry.

---

## AC3 — The mechanics of returning a derivative to `PENDING`

### A fork that must be drawn before everything else

The derivatives split into two cases, and these are different mechanics:

| The derivative's state                                     | What to do                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The obligation is still `PENDING` (the money did not move) | Update **both** copies of the amount in one DB transaction. Nothing needs returning — it is already there |
| The obligation is `PAID` (the money is gone)               | The owner's mechanics: return to `PENDING`, show the paid out                                             |

The first case is simple and is obliged to be done together with the second, otherwise defect L3 will remain.

### What happens to the links on the return

The flip of `settleByCompany` — reversible by form, but not by meaning. The reverse move:

1. `pending_obligations`: `status: 'PAID' → 'PENDING'`, `closingTransactionId → null`.
   The partial unique index `uq_pending_obligations_source_pending` (`schema.ts:1346-1348`)
   allows exactly one `PENDING` obligation per source — there is no conflict, but the rollback is obliged to be a
   **conditional UPDATE** (`WHERE status='PAID'`) with a check of the affected row count, otherwise a double
   rollback will create a second `PENDING` and run into a 23505.
2. `transactions`: `type` back to `SENIOR_PENDING_PAYOUT` / `DROP_PENDING_PAYOUT`,
   `status: 'PAID' → 'PENDING_PAYMENT'`, `amount` = the **new** share.
3. **Restore the percent snapshot** that settle zeroed (`:869-872`) — without it the next
   preview cannot compute the share. There is nowhere to take it from except a new storage (see below).
4. `fundingSource`, `receiptDocumentId`/`receiptExternalUrl`, `senderId`, `validatedBy/At` —
   refer to the payment that happened. **Do not erase**: this is proof that the payout was.
5. The journal: a new action, for example `CASCADE_REOPEN`, with `{ obligationId, before: {amount, type,
status}, after: {...}, causedBy: <the id of the edited row>, settledAmount }` — **inside the same
   DB transaction** as the rollback itself (modeled on `adminDeleteTransaction:3213-3225`, where the journal
   record is deliberately inseparable from the action).

### A mandatory companion: a ledger term. Without it the mechanism creates a hole

**This is the most important thing in AC3.** The company account debit hangs on `status='PAID'`
(`company-account-balance.ts:333-357`). The rollback `PAID → PENDING_PAYMENT` **removes the debit** — and the balance
of the company account **grows by exactly the already-paid amount**. The money has physically left meanwhile.

The consequence is not cosmetic: an overstated balance is an input to the money-gate
(`if (amount > balance) throw`). The system will permit spending what does not exist, and there is no other check
behind it.

Therefore the return to `PENDING` **is obliged** to be accompanied by one of two:

- **(recommended)** a new term in `sumLedgerTerms`: "paid out by the rows returned to PENDING" —
  a debit by the accumulator `settledAmount` for rows with `status='PENDING_PAYMENT' AND settled_amount > 0`.
  The formula remains the only one and continues to be the source of truth;
- or a compensating row in the ledger for the paid amount — more expensive, multiplies rows and requires
  its own idempotency.

If neither is done — the mechanism of rolling back the status must not be done at all, and then the only
correct form of "re-confirmation" is a separate `PENDING` row for the **delta** (its cost:
the unique index L2 forbids a second drop-row from the same income, so either an index
revision or a link of a different kind will be required). Both paths give the owner the declared result; the choice —
is the owner's, but **the option without a compensation in the ledger is not one of them**.

### Where "how much is already paid out" is stored — and why it survives the next edits

**Decision: a pair of columns on the derivative row — `settled_amount` (`numeric(18,6)`) and
`settled_currency`, a monotonic accumulator of actual payouts.** (Confidence: HIGH)

- The currency is needed separately because a drop obligation could have been closed in another currency
  (`settleByCompany` writes `amount` = the fact in the payment currency, `pending-settlement.service.ts:820-826`).
  One number without a currency is already a wrong answer.
- **Monotonicity is the key to "survives subsequent edits".** The **sum of all actual
  payouts on the row** is stored, increases on each settle, never decreases. "To top up" is
  computed: `amount − settled_amount`. This is the same principle by which the project already made the
  `originalAmount/exchangeRate` triplet: **store the immutable term, compute the changeable one**.
  If "the difference to top up" were stored, it would go stale on every next edit and would have
  to be recomputed — that is, derived from the live values, and this is exactly what we try
  not to do.
- The columns are additive-nullable, without a backfill: `NULL` reads as "did not pass through the mechanism",
  which for all existing rows is the literal truth (the same technique as with
  `originalAmount`/`sourceIncomeTransactionId` — `schema.ts:673-677`, `:808-812`).

**Why not from the journal `transaction_audit_log`.** (Confidence: HIGH — verified by the code.)
The `PAY` record at settle is made **best-effort, after the commit of the money transaction**, and its error
is only logged (`pending-settlement.service.ts:936-963`: "Best-effort, run AFTER the settle
transaction has already committed … a logging hiccup must not turn a successful settlement into a
500"). So the journal **may not contain a payout that really happened**. Deriving money from a
log that by construction allows a miss is not allowed. The journal remains what it is —
a trace for a human, not a source of amounts.

**Why not from `pending_obligations`.** It stores the obligation amount, not "how much was
closed by it": a closing is modeled as a whole (`status` + `closingTransactionId`), the table does not know
partial payouts.

**Where to get the percent for a recompute after settle.** By the same technique — save the percent snapshot on the
flip into a separate column (`settled_share_percent`), not into `seniorSharePercent`/`dropSharePercent`,
which are obliged to remain `NULL` because of the GROSS↔NET discriminator (C1, argument 2). An alternative —
restore the percent from the ratio `old_share / old_income` **before** applying the edit; it works
(the percent is integer, `roundShareAmount` is deterministic), but adds a derivation where one can simply
record the fact. A column is recommended. (Confidence: MED — both schemes work, the choice by a taste for
migrations.)

### Deeper than one level: does such a chain exist

**Answer: no — provided guard 2 remains. The cascade is one-level and recursion is not needed.**
(Confidence: HIGH — proven by the code, not assumed.)

Proof:

1. The only editable source generating derivatives is `ADMIN_INCOME` through
   `declareUsdtProjectIncome` → `bookCompanyObligations`. This is **level 1**.
2. A derivative after settle becomes `SENIOR_INCOME` with `status='PAID'`. It cannot get into a new payout
   request: `createPayoutRequest` selects rows strictly `eq(transactions.status, 'VALIDATED')`.
   `PAID ≠ VALIDATED` — **level 2 does not arise**.
3. `PAYOUT_DROP` is not an input for any generating path at all.
4. The only really two-level chain is the drop-payout (L6), but its input carries a
   `payoutRequestId` and is closed by guard 2.
5. The invoice — a **leaf**, not a transaction: it does not "return to PENDING", it is voided (AC5, item 6).

Conclusion: the cascade is limited to one level **mechanically**, and this limitation is held exactly by guard 2.
Removing guard 2 would make the cascade two-level and would require recomputing `payableAmount`, which
is reconciled with an already-completed transfer in the blockchain — that is, non-recomputable in principle.

### Decreasing the amount: more was paid out than the new amount

The case: `new_share < settled_amount`. This is **not a debt of the company, but an overpayment to the employee**.

- One **must not** record a negative obligation. `pending_obligations.amount` participates in the
  money-gate `amount > balance` (`pending-settlement.service.ts:780-785`) and in all aggregates;
  a negative value would distort both the gate and the balances. Besides, `settledAmountError`
  (`exchange-rate.util.ts:53-60`) explicitly rejects negative payout amounts — the invariant is already
  fixed in the code.
- **Recommendation:** on `delta ≤ 0` **do not return the row to `PENDING`**. Leave it `PAID`,
  record in the journal the fact of the overpayment with both amounts and show in the interface an explicit mark
  "overpayment N USDT" on the row. The system does not know how to return money and must not — this is a human's
  decision (an offset against the next payout, a return, a write-off).
- Separately: `delta == 0` — this is not a "zero obligation", but "nothing changed"; treat
  as the absence of a cascade.

### Idempotency

Four levels, all — a repetition of techniques already existing in the project, not new inventions:

1. **Editing the same amount twice.** Already solved: `amountChanged` compares
   `Number(x).toFixed(6) !== Number(tx.amount).toFixed(6)` (`transactions.service.ts:2970-2971`).
   If the amount did not change — the cascade does not launch, the journal is not written. **Reuse this
   comparison, do not write a second one** (otherwise we get two descriptions of one rule — item 170).
2. **A repeat rollback of an already-rolled-back row.** A conditional UPDATE with a check of the affected row count —
   the pattern from `settleByCompany:756-769`, `adminDeleteTransaction:3199-3211`, `restoreTransaction:3263-3275`.
   Zero rows ⇒ the rollback already happened ⇒ exit without a second journal record.
3. **The accumulator is not overwritten.** `settled_amount` only **increases** on each settle.
   The scenario "edit → top-up → edit → top-up" is obliged to give a monotonically growing accumulator;
   the second rollback has no right to zero or reset it.
4. **The cascade does not multiply rows.** The derivatives are **updated** (lookup by `sourceIncomeTransactionId`),
   not created. For the drop-row this is additionally guaranteed physically —
   `uq_transactions_source_income_drop_link` (`schema.ts:1072-1076`) will not allow a second insert.

---

## AC4 — What to show before saving and how not to let the preview diverge from the fact

### The construction: one resolver, two wrappers

The requirement "the preview == the fact" is solved **not by discipline, but by the fact that the description is one**.

```
resolveEditCascade(snapshot, patch) -> CascadePlan
```

- **A pure function.** Not a single DB access inside. On the input — already-read rows
  (the source, its derivatives, the paired obligations, the accumulators), on the output — a plan:
  for each derivative `{ id, type, old amount, new amount, percent-snapshot, already paid out,
to top up, whether a re-confirmation is required }` + a list of warnings
  (no percent snapshot / there is a signed invoice / an overpayment / the currency is not USDT).
- **One snapshot-loading function** — `loadCascadeSnapshot(txId)`, used by both wrappers.
- **`GET /transactions/:id/edit-preview`** — loads the snapshot, calls the resolver, returns the plan. Writes nothing.
- **`PATCH /transactions/:id`** — opens a DB transaction, re-reads the snapshot **under a lock**
  (`SELECT … FOR UPDATE` on the source and the derivatives), calls the **same** resolver, applies the plan.

Why this guarantees a match: a pure function without I/O on the same input gives the same output;
the input in both cases is formed by one and the same query. A discrepancy is possible only if the data
changed between the reads — and this is closed by the item below.

A precedent in the project worth repeating verbatim: `roundShareAmount` is moved out into `@crm/shared`
precisely so that two counters do not diverge, and in the code this is fixed by a comment — "both
stay pinned to identical numbers" (`transactions.service.ts:5127-5130`). We do the same thing one
level up.

### Optimistic locking — otherwise the preview is honest but not current

Between showing the preview and pressing "Save" the accountant in a neighboring tab may close
an obligation. Then the admin will confirm not what they were shown.

Solution: the preview returns a **version** — the set of `updatedAt` of the source and all derivatives
(or their hash). `PATCH` accepts it and reconciles with the state re-read under a lock. A mismatch —
**a refusal with a request to refresh the preview**, not a silent recompute. A silent recompute is itself
a divergence of the preview from the fact, only masked as a success.

### How this is checked (so that the check is not a tautology)

- **A parity test:** one fixture set → call both entry points → assert the **equality of the structures
  as a whole**, not "in both N rows". The check "in both responses there are 2 records" passes
  even with the amounts swapped.
- **A property test:** random combinations (amount, percent, already paid out, the sign of the delta) → the
  preview plan is identical to the actually-applied one.
- **A race:** read the preview → perform a settle from another session → apply the edit →
  expect a refusal.
- Do **not mock** the resolver in the resolver tests — otherwise the test checks the mock.

---

## AC5 — What NOT to do

1. **Do not remove guard 2 (`payoutRequestId`).**
   It is the only thing holding the cascade one-level (the proof in AC3). Behind it is
   `payout_requests.payableAmount`, which is reconciled with the actual on-chain transfer **exactly, without a
   tolerance** (`transactions.service.ts:4439-4464`). The transfer is already in the blockchain; it cannot be
   "recomputed". Errors in such rows are corrected by a **reversing transaction**, not by editing.

2. **Do not remove guard 1 (the `PAYOUT` family).**
   The same grounds, plus `PAYOUT_CONFIRMED` is an audit record of a manual confirmation; an edit
   in place destroys the link with the original `PAYOUT` (the reason the type was added to the guard).

3. **Do not allow editing the CURRENCY on `PAID` rows.** This is the most likely way to accidentally break the
   system, because the currency stands in BIZ-18 **in one condition with the amount** (`:2979`) and is removed
   "along the way" in one motion. The consequence is exact: one `PAID` company-row with `currency <> 'USDT'`
   makes `assertNoOffCurrencyCompanyRows` throw an exception, and on it hang **four** money
   gates — `createExpense`, `paySalary`, `settleByCompany`, `createDividend`
   (`company-account-balance.ts:372-380`). All payouts in the system stop with a 500, until the row is
   fixed. The comment in the code calls this "trap for a FUTURE write path" (`:184-190`) — removing
   the currency condition is that write path. The currency is corrected by a reversal + a new row.
   **In BIZ-18 one must remove only `amountChanged`**, leaving `currencyChanged || salaryMonthChanged`
   blocking.

4. **Do not recompute the share percent by the live resolver.** Never call `resolveSeniorShare` /
   `resolveDropShare` inside the cascade. Only the snapshot. No snapshot — a **refusal**, not "take the current".
   The rationale — C1 (three independent arguments).

5. **Do not edit `amount` on a row with a filled `originalAmount`.** There `amount` is "how much
   really left the bank", not our estimate; next to it lies `exchangeRate = paid/original`, which
   the edit would silently make false (L12, C2). Recommendation: an explicit refusal with clear text
   ("the actual payment amount is not editable — correct the payment document"), not an attempt
   to recompute the triplet.

6. **Do not leave a signed invoice silently.** If a row has an `invoiceDocumentId` and a counterparty's
   signature — at minimum **refuse** the edit; at maximum — void the invoice explicitly (unlink,
   mark invalid, reissue under a new signature). A silent "it will somehow re-render later" is
   the worst option: the discrepancy will travel into the public verification by the QR code and into the document
   that is **already with the counterparty** (L13). This is literally item 168: "not visible on the screen ≠ not handed to
   the client".

7. **Do not invent a negative obligation on an overpayment.** `pending_obligations.amount` is
   an input to the money-gate and all aggregates; a negative value will break both, and
   `settledAmountError` already forbids negative payouts. An overpayment is a scenario for a human
   (AC3), not for automation.

8. **Do not make the cascade recursive "just in case".** The depth is provably equal to 1 while guard 2 stands.
   Recursion without a real chain is code that will never execute in prod, and therefore never will
   be checked, but will participate in every future review and in every reasoning about money.

9. **Do not count "already paid out" from the journal.** The `PAY` record is best-effort and after the commit
   (`pending-settlement.service.ts:936-963`) — the journal may not contain a payout that happened (AC3).

10. **Do not fix "along the way" neighboring defects in this same task.** Three were found; each needs its own
    check and its own review:
    - the discrepancy `transactions.amount` ↔ `pending_obligations.amount` on **open** obligations
      (L3) — a live defect, fixed separately and **before** the mechanism;
    - `salaryMonthChanged` does not get into the journaling condition (L11);
    - the deletion of an `ADMIN_INCOME` that generated obligations is not blocked (L16).
      Mixing them with the cascade means getting a PR that has no one clear acceptance criterion.

11. **Do not make the preview the "source" of the edit.** The server is obliged to compute the cascade itself, not to
    apply a plan sent by the client. The client plan is an input, not a decision; from it one can only accept
    the version for the optimistic reconciliation.

---

## AC6 — The risk-list for the implementation

| #   | What is easiest to break                                                                    | By what check it is caught                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The preview and the fact diverge (item 170)                                                 | A parity test: both entry points on one fixture, a comparison of the **structures as a whole**. The check "in both N rows" will not catch this                                                               |
| 2   | A one-sided check of a symmetric invariant (item 170)                                       | After the cascade assert **both** directions: `tx.amount == obligation.amount` **AND** `obligation.amount == roundShareAmount(income.amount, snapshot)`                                                      |
| 3   | A tautological cascade test ("returned what was mocked")                                    | The mutation gate: `MUTATION_BASE_SHA=$(git rev-parse origin/main) node scripts/devops/mutation-gate.mjs --changed`. A mutation of `roundShareAmount` that does not fail the test = the test is tautological |
| 4   | **The company balance grows by the already-paid on the rollback** (AC3, the companion-term) | An integration one: take the balance before the edit → roll back the derivative → take after → assert **equality**. An error "in the plus" is not caught by any gate itself                                  |
| 5   | The percent snapshot is lost (settle zeroed, L4)                                            | A test "an edit of an income whose share is **already paid out**": either a correct recompute from the new storage, or an explicit refusal. Today this path is covered by nothing                            |
| 6   | The accumulator `settled_amount` is zeroed on a second rollback                             | A chain test "edit → top-up → edit → top-up": assert the accumulator's monotonicity and the correct "difference to top up" at each step                                                                      |
| 7   | A race preview ↔ settle                                                                     | An integration one with a manual sequence: preview → settle from another session → edit → **refusal**, not a silent recompute                                                                                |
| 8   | The discrepancy travels into the signed invoice and the public verification (item 168)      | A `verifyInvoice` test after an amount edit: a refusal or an explicit mark. Separately — a test that a re-render does not substitute the amount under the old signatures                                     |
| 9   | The journal is not written for some fields (L11)                                            | A journal test **for each** money-field separately, not "by amount and that's enough"                                                                                                                        |
| 10  | A currency edit passes together with the amount (AC5, item 3)                               | A test: a `PATCH` with a changed currency on a `PAID` company-row → 400; and then — the balance/gates continue to work                                                                                       |
| 11  | The cascade multiplies derivative duplicates                                                | A test on a repeat edit: the number of derivatives does not grow; for drop — check that `uq_transactions_source_income_drop_link` (23505) fires, not a silent duplicate                                      |
| 12  | An edit on the live DB bypassing the interface                                              | The cascade lives in the **service**, not in the dialog. The test calls the endpoint directly, without UI                                                                                                    |

Additionally: the surface is monetary ⇒ `security-review` is **mandatory** (the critical-path rule),
plus `Skill('security-review')` before writing the endpoint. The UI part ⇒ design-gate Tier 2 +
a fidelity audit on all device classes.

---

## Scale assessment — SQL for the owner (read-only, without PII)

Not executed against `crm_db` (the rule `live-db-access.md`: reading is allowed, but for a scale
assessment aggregates are sufficient, and the decision to run — is the owner's). All queries return only
counters.

```sql
-- 0. Confirmation of the connection (mandatory first)
SELECT current_database(), version();

-- 1. How many PAID rows will become editable after removing BIZ-18, by type
SELECT type, count(*) AS rows
FROM transactions
WHERE deleted_at IS NULL
  AND status = 'PAID'
  AND type NOT IN ('PAYOUT','PAYOUT_ADMIN','PAYOUT_CONFIRMED')
  AND payout_request_id IS NULL
GROUP BY type
ORDER BY rows DESC;

-- 2. Of them — how many have derivative obligations (a cascade is mandatory)
SELECT src.type,
       count(DISTINCT src.id) AS incomes_with_derived,
       count(d.id)            AS derived_rows
FROM transactions src
JOIN transactions d
  ON d.source_income_transaction_id = src.id
 AND d.deleted_at IS NULL
WHERE src.deleted_at IS NULL
  AND src.status = 'PAID'
  AND src.payout_request_id IS NULL
  AND src.type NOT IN ('PAYOUT','PAYOUT_ADMIN','PAYOUT_CONFIRMED')
GROUP BY src.type;

-- 3. Derivatives in terms of "already paid / not yet" — the volume of the heavy case (L4)
SELECT d.type, coalesce(o.status::text, 'no_obligation') AS obligation_status, count(*) AS rows
FROM transactions d
LEFT JOIN pending_obligations o ON o.source_transaction_id = d.id
WHERE d.source_income_transaction_id IS NOT NULL
  AND d.deleted_at IS NULL
GROUP BY 1, 2
ORDER BY 3 DESC;

-- 4. THE LIVE DEFECT L3: open obligations where the two copies of the amount have already diverged
--    (only PENDING: for closed drop-rows the discrepancy is regular — there amount = the payment fact)
SELECT count(*) AS diverged_open_obligations
FROM pending_obligations o
JOIN transactions t ON t.id = o.source_transaction_id
WHERE o.status = 'PENDING'
  AND t.deleted_at IS NULL
  AND o.amount <> t.amount;

-- 5. Closed obligations that lost the percent snapshot on the flip (L4)
SELECT count(*) AS closed_without_share_snapshot
FROM pending_obligations o
JOIN transactions t ON t.id = o.closing_transaction_id
WHERE o.status = 'PAID'
  AND t.senior_share_percent IS NULL
  AND t.drop_share_percent IS NULL;

-- 6. PAID rows with a filled original_amount — editing amount there is especially dangerous (L12)
SELECT type, count(*) AS rows
FROM transactions
WHERE deleted_at IS NULL
  AND status = 'PAID'
  AND original_amount IS NOT NULL
GROUP BY type;

-- 7. PAID rows with an invoice already signed by the counterparty (L13)
SELECT t.type, count(*) AS rows
FROM transactions t
JOIN invoice_signatures s
  ON s.transaction_id = t.id
 AND s.signer_role = 'COUNTERPARTY'
WHERE t.deleted_at IS NULL
  AND t.status = 'PAID'
GROUP BY t.type;
```

Query №4 is the most substantive: a non-zero result means that defect L3 has already fired on
prod and requires a pinpoint data-fix beyond this task.

---

## Decomposition: into how many tasks and in what order

Six tasks. The order is dictated by dependencies, not by convenience.

| #   | Task                                                                                                                                     | Zone                                  | Why exactly here                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Fix L3**: an edit of an open IOU updates both copies of the amount; journal `salaryMonth` (L11)                                        | `apps/api`                            | A live defect, independent of the mechanism, fixed by a small diff. Do it **first** — otherwise the cascade is built on top of a discrepancy |
| 1   | **The snapshot infrastructure**: columns `settled_amount` / `settled_currency` / `settled_share_percent`, a write at settle              | `apps/api` + a prod DDL in deploy.yml | The resolver needs something to compute from. An additive migration, applied before the logic                                                |
| 2   | **The cascade resolver + the preview** (`GET .../edit-preview`), a pure function + parity tests                                          | `apps/api`, `packages/shared`         | Read-only: provably correct in isolation, before anything starts writing                                                                     |
| 3   | **Applying the cascade**: removing BIZ-18 **only for `amount`**, rolling back the derivatives, the ledger term, the journal, idempotency | `apps/api`                            | The core. Requires 1 and 2. **A mandatory `security-review`**                                                                                |
| 4   | **The invoice**: a refusal or an explicit invalidation on a counterparty-signed invoice (L13)                                            | `apps/api`                            | Separable from the core, but before the rollout to the UI: otherwise the very first edit will travel outside                                 |
| 5   | **UI**: the preview before saving, a `PENDING` row with "already paid out / to top up", an overpayment mark                              | `apps/web`                            | Needs the endpoint from 2 and the behavior from 3. Design-gate Tier 2 + fidelity on all device classes                                       |

Tasks 0 and 1 are independent of each other and can go in parallel. 2 → 3 → 5 are strictly sequential.
4 can go in parallel with 3, but roll out no later than it.

---

## Consequences

- The system gets a general mechanism for correcting money — at the price of three new columns, one
  new term in the company account balance formula and one new read endpoint.
- The balance formula that ADR 2026-07-14 specially designed so as **not to touch** it,
  here is nonetheless changed. This is a deliberate price for the status rollback; the alternative (a delta-row)
  runs into the unique index L2.
- The three guards turn into two and a half: `amount` is opened, `currency` and `salaryMonth`
  remain closed on `PAID`. This is **not** the same as "remove the third guard", and the difference is
  substantial (AC5, item 3).
- Three neighboring defects were found (L3, L11, L16), of which L3 is a money discrepancy on live data.

## Rollback

The document is self-contained and executes nothing.

```bash
git -C <repo> revert <commit>       # remove the document
# expected state: docs/architecture/2026-08-22-paid-transaction-edit-cascade.md absent
git -C <repo> status --porcelain apps/ packages/   # MUST be empty — the code was not touched
```

The rollback of individual implementation tasks — by their own PRs; tasks 0 and 1 are reversible independently,
task 3 without 1 and 2 is meaningless and is rolled back together with them.

## Sources

Everything verified by reading the code on `origin/main` = **`166897df`**, not from memory. Four reference points
were re-confirmed by a `grep` of the symbol name after writing the map: the BIZ-18 guard — `:2981`,
the journaling condition — `:3056`, the insert of `AMOUNT_OR_RECEIVER_CHANGE` — `:3060`,
`bookCompanyObligations` — `:4629`. Both PRs merged last are accounted for: **#587** (idempotency of
`SENIOR_INCOME` / `DROP_INCOME` — L19) and **#590** (`pending_obligations.payoutRequestId` — L18, C8).

- `apps/api/src/finance/transactions.service.ts` — `:2944-2983` (the three guards), `:2970-2973`
  (the change comparison), `:3056-3073` (the journaling condition), `:3187-3194` (the deletion guard),
  `:2166-2183` (`declareUsdtProjectIncome` → the booking), `:4207-4233` / `:4284` / `:4439-4464`
  (the payout amounts and the exact on-chain reconciliation), `:4629-4759` (`bookCompanyObligations`),
  `:5090-5162` (the drop-payout cascade), `:5127-5130` ("both stay pinned to identical numbers"),
  `:5385+` (`getSummary`), `:4045` + `:4111` (`createPayoutRequest`, the selection strictly by
  `status='VALIDATED'` — the proof of the cascade's limited depth).
- `apps/api/src/finance/pending-settlement.service.ts` — `:756-769` (the conditional claim), `:777-786`
  (the money-gate by `obligation.amount`), `:805-922` (the flip in place: `:820-826` the fact/obligation,
  `:857` the reset of `payoutRequestId`, `:869-872` the zeroing of the percents, `:918` the self-`closingTransactionId`),
  `:936-963` (the best-effort journal after the commit).
- `apps/api/src/finance/company-account-balance.ts` — `:175-190` (the comment about the "future write
  path"), `:228-254` (the currency guard), `:267-370` (the 8 terms), `:372-388` (the gates vs the display).
- `apps/api/src/finance/balance.service.ts` — `:265-272`, `:385-388` (the GROSS↔NET discriminator).
- `apps/api/src/finance/salary-status.helper.ts` — `:56-66`.
- `apps/api/src/finance/exchange-rate.util.ts` — `:28-30`, `:53-60`.
- `apps/api/src/finance/senior-share-resolver.ts` — `:73-103` (the hierarchy + the contract "never
  recomputed on read"); `drop-share-resolver.ts`.
- `apps/api/src/finance/company-account.service.ts` — `:346-377`, `:513-532` (the observed on-chain
  amount).
- `apps/api/src/invoices/invoices.service.ts` — `:735-782` (the hash reconciliation with the stored PDF),
  `:800-925` (the re-render from the live `tx.amount`), `:951-1000` (`verifyInvoice`, the public return of
  the live `tx.amount`).
- `apps/api/src/users/users.service.ts` — `:1355-1374`.
- `apps/api/src/database/schema.ts` — `:68-125` (the types), `:156-168` (the statuses), `:571-618`
  (`payout_requests`), `:620-1100` (`transactions`: `:626-687` the amounts and the triplet, `:766-781` the percent
  snapshots, `:848` `sourceIncomeTransactionId`, `:1024-1026` the salary uniqueness,
  `:1072-1076` the drop-link uniqueness), `:1287-1350` (`pending_obligations`),
  `:1429-1452` (`invoice_signatures`), `:1842-1857` (`transaction_audit_log`).
- `packages/shared/src/utils/money.ts` — `:24-33` (`roundShareAmount`, deterministic).
- ADR `docs/architecture/2026-07-14-settle-transition-in-place.md` — §"Silo-consumers of the created
  row" (the map's completeness reconciliation).
- Rules: `.claude/rules/common/live-db-access.md`, `zone-of-write.md`, `design-gate.md`.
