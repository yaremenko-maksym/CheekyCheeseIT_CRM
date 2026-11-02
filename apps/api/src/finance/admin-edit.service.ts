import {
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  forwardRef,
} from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { CascadePlan, SessionUser } from '@crm/shared'
import {
  PAID_ROW_LOCKED_FIELD_ERROR_CODES,
  amountsDiffer,
  computeCascadeVersion,
  floorAmountAtAccumulator,
  isCascadeAmountEdit,
  resolveEditCascade,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { pendingObligations, transactionAuditLog, transactions } from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import {
  repairInvoicesAfterAdminEdit,
  type AdminEditResult,
} from './admin-edit-invoice-repair.helper'
import { migrateSalaryMonthMarker } from './admin-edit-salary-month.helper'
import {
  assertTxDateNotClaimedInRequest,
  resolveAdminEditTxDate,
  txDateSnapshotPredicates,
} from './admin-edit-tx-date.helper'
import { EditCascadeService } from './edit-cascade.service'
import { isRegistryConflict } from './finance-predicates.util'
import { consumeTxHash } from './onchain-tx'
import { OnChainClaimService } from './onchain-claim.service'
import { assertReceiptDocumentBindable } from './receipt.util'
import { backdateAuditRow } from './transaction-date-audit.util'
import { formatTransactionBusinessDate } from './transaction-date.util'
import { assertTransactionWritable } from './transaction-visibility.util'

/**
 * ADMIN edit of any non-payout transaction: BIZ-18 guards, the paid-amount edit
 * cascade (lock, snapshot, assert, apply), on-chain receipt-hash transitions and
 * the post-commit invoice void/re-issue repair. Depends on the database, the
 * edit-cascade and on-chain-claim collaborators and the invoice service; never
 * on TransactionsService. `adminUpdateTransaction` returns the edited row id
 * (plus the invoice-repair flag when one is needed); the facade performs the
 * viewer-scoped read-back.
 */
@Injectable()
export class AdminEditService {
  private readonly logger = new Logger(AdminEditService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly onChainClaim: OnChainClaimService,
    private readonly editCascade: EditCascadeService,
    @Inject(forwardRef(() => InvoicesService))
    private readonly invoicesService: InvoicesService,
  ) {}

  async adminUpdateTransaction(
    id: string,
    data: {
      amount?: number | undefined
      currency?: string | undefined
      notes?: string | null | undefined
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      category?: string | undefined
      salaryMonth?: string | undefined
      /** Business day `YYYY-MM-DD`; consulted only when it differs from the stored day. */
      txDate?: string | null | undefined
      /** Justification for dating the row beyond the backdating window (policy D-2). */
      backdateReason?: string | null | undefined
      /** task-cascade-apply (task 3) — the token `GET :id/edit-preview` returned. */
      cascadeVersion?: string | undefined
    },
    currentUser: SessionUser,
  ): Promise<AdminEditResult> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    assertTransactionWritable(tx, currentUser)
    // Drop role - phase 3: PAYOUT_CONFIRMED rows are the audit trail of a
    // manual confirmation — editing them in-place would corrupt the link to
    // the originating PAYOUT. Group the prohibition with the existing PAYOUT
    // family so the contract is consistent.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw apiError('FINANCE_EDIT_PAYOUT_FORBIDDEN', HttpStatus.BAD_REQUEST)
    }
    if (tx.payoutRequestId) {
      throw apiError('FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN', HttpStatus.BAD_REQUEST)
    }

    // BIZ-18: once a transaction is PAID, its money-defining fields (amount /
    // currency / salaryMonth) are immutable for ALL types — not just company-funded
    // rows. The original guard only blocked company-funded rows (fundingSource =
    // COMPANY_ACCOUNT), but a PAID ADMIN_INCOME or PAID EXPENSE that is NOT
    // company-funded represents a real cash movement that has already cleared;
    // retroactively changing the amount or currency would desync the ledger.
    // Metadata-only edits (notes / receipt / category) remain allowed on PAID rows.
    //
    // BIZ-18-fix (2026-07-06): change-based guard, not presence-based.
    // The frontend edit-form always sends the full form state (amount + currency +
    // notes + receipt), even when the user only touched the receipt field. A
    // presence-based check (data.amount !== undefined) therefore blocked every
    // metadata-only edit on PAID rows. The guard must compare NEW vs STORED value
    // and only block when a money-defining field actually differs.
    //
    // Float-safe comparison: DB stores numeric(15,6) as a string e.g. '233304.560000';
    // incoming data.amount is a JS number (e.g. 233304.56). `amountsDiffer`
    // (`@crm/shared`) normalises both to Number(…).toFixed(6) before
    // comparing — identical values round to the same string, genuine changes
    // produce a different string.
    //
    // HIGH (code-review, task-cascade-resolver-preview round 1): this used to
    // re-describe the SAME rule inline (`Number(data.amount).toFixed(6) !==
    // Number(tx.amount).toFixed(6)`) instead of calling the shared helper
    // that was extracted for exactly this reason (AC4 of the ADR —
    // `roundShareAmount`'s precedent one layer up: "both stay pinned to
    // identical numbers"). A pure substitution of an identical expression —
    // the task's "do not touch adminUpdateTransaction" scope is about not
    // changing its BEHAVIOUR, not about leaving a duplicate description of a
    // money rule in place once the single source of truth exists.
    // SR-M-1 / SR-M-2 (review round 4) — ONE condition for all three writers.
    //
    // The floor used to be applied on "an amount was SENT" while the second
    // stored copy and the journal keyed on "the amount CHANGED". On a legacy
    // row whose stored `amount` sits BELOW its accumulator that split was
    // reachable: the edit form always sends full state, so editing a NOTE
    // re-sent the unchanged amount, the floor rewrote `transactions.amount`
    // 100 → 260, and `pending_obligations.amount` stayed at 100 with nothing
    // in the journal — the L3 divergence task 0 exists to close, re-opened
    // silently by the fix for a different finding.
    //
    // Now: floor first, then ask whether the STORED figure moves. Everything
    // downstream keys on `amountToWrite !== undefined`, which is that one
    // answer. The repair direction is the safe one — raising `amount` to what
    // was actually paid makes term 7 debit MORE, never less.
    const requestedFloored =
      data.amount === undefined
        ? undefined
        : floorAmountAtAccumulator(tx.settledAmount, data.amount)
    const amountChanged =
      requestedFloored !== undefined && amountsDiffer(requestedFloored, Number(tx.amount))
    const currencyChanged = data.currency !== undefined && data.currency !== tx.currency
    const salaryMonthChanged = data.salaryMonth !== undefined && data.salaryMonth !== tx.salaryMonth
    // task-soft-delete-and-money-audit (AC5): "receiver" on this endpoint is
    // `category` → `receiverLabel` (see the `.set({ ...receiverLabel: data.category })`
    // below) — the counterparty-facing label an ADMIN edit can change.
    const receiverLabelChanged = data.category !== undefined && data.category !== tx.receiverLabel

    // task-cascade-apply (task 3, AC1) — BIZ-18 is narrowed SURGICALLY: only
    // `amountChanged` leaves this condition. `currency` and `salaryMonth` stay
    // blocked on a PAID row, and each for its own reason:
    //
    //  - CURRENCY: one PAID company-shaped row in a currency other than USDT
    //    makes `assertNoOffCurrencyCompanyRows` throw, and FOUR money gates
    //    hang off it (createExpense / paySalary / settleByCompany /
    //    createDividend). Every payout in the system stops until the row is
    //    fixed. A currency mistake is corrected by a reversing entry plus a
    //    new row, never in place (ADR AC5 §3).
    //  - SALARY MONTH: it keys historical monthly aggregates and invoice/reporting
    //    context; moving a paid salary between months rewrites history and is a
    //    separate, unrelated defect (L11), deliberately not opened here.
    //
    // Lifting all three "заодно" is exactly the failure ADR AC5 §3 predicts:
    // they sit in one condition, so the easy edit takes all three.
    //
    // QA-H-2 (manual QA, HIGH): the text names the CARRIER of the refusal and
    // the remedy, and is the SAME catalog entry the dialog shows proactively —
    // one api-error code in `@crm/shared` (`PAID_ROW_LOCKED_FIELD_ERROR_CODES`),
    // so the screen and the 400 cannot drift apart. It also branches, because the two fields are locked
    // for two unrelated reasons (see the block above) and telling an operator
    // about salary months when they touched a currency is noise.
    if (tx.status === 'PAID' && (currencyChanged || salaryMonthChanged)) {
      throw apiError(
        currencyChanged
          ? PAID_ROW_LOCKED_FIELD_ERROR_CODES.CURRENCY
          : PAID_ROW_LOCKED_FIELD_ERROR_CODES.SALARY_MONTH,
        HttpStatus.BAD_REQUEST,
      )
    }

    const txDate = resolveAdminEditTxDate(tx, data, currentUser.role)
    const dateDecision = txDate.decision

    // task-cascade-apply (task 3, AC2) — editing the amount of a PAID row is
    // never a bare UPDATE: it moves money that derivative rows were computed
    // from. The operator must have SEEN what it does (`GET :id/edit-preview`)
    // and must hand back the version that preview was built on, so the server
    // can prove the world has not moved since (checked under lock inside the
    // transaction below).
    //
    // Required even when the row has no derivatives at all: the rule is
    // simpler that way, and the token doubles as an optimistic lock on the
    // edited row itself.
    // CR-M-2 — one symbol, asked here and in `getEditCascadePreview`.
    //
    // It compares the RAW request, while `amountChanged` below compares the
    // FLOORED figure, and that difference is deliberate (SR-M-1, review round
    // 5 — the previous version of this comment claimed they were the same, and
    // pointed at a test that did not exist):
    //
    //   - "did the operator ASK for a change?" (raw, here) decides whether
    //     AC13 and the preview token apply;
    //   - "does the STORED figure move?" (floored, `amountChanged`) decides
    //     what actually gets written.
    //
    // They part company on a settled row, where `amount === settled_amount` so
    // every downward request floors straight back: the floored question calls
    // that "no change", skips AC13 and answers with a silent success — on
    // exactly the population AC13 exists to refuse. Measured, not argued:
    // `isCascadeAmountEdit — the two questions genuinely diverge…` in
    // `packages/shared/src/schemas/edit-cascade.spec.ts`.
    //
    // Do NOT "restore consistency" between the two without reading that test.
    const isCascadeEdit =
      data.amount !== undefined &&
      isCascadeAmountEdit({
        status: tx.status,
        storedAmount: Number(tx.amount),
        requestedAmount: data.amount,
      })
    if (isCascadeEdit && !data.cascadeVersion) {
      // task-cascade-preview-ui (task 5) — the tail is now an ACTION, not an
      // apology. PR #610 shortened it to «подтвердить пересчёт пока негде»
      // because the preview screen did not exist yet and naming a step nobody
      // could take is worse than naming none. It exists as of this task
      // (`CascadeImpactPanel` inside `AdminEditTransactionDialog`), so the
      // refusal points at it. The head of the sentence is unchanged on
      // purpose: it is what the two callers' tests match on, and the shortest
      // honest statement of the reason.
      throw apiError('FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW', HttpStatus.BAD_REQUEST)
    }
    // SR-M-6 (security-review round 3) — the SAME law AC5/AC7 state for the
    // cascade, stated once and applied on BOTH write paths:
    //
    // > a row's `amount` is never written below its `settled_amount`.
    //
    // The cascade enforced it; this path did not. A row a cascade has reverted
    // sits at `PENDING_PAYMENT`, so `isCascadeEdit` is false, AC13 is never
    // consulted, and both writes below stored whatever figure was typed — an
    // obligation asserting a debt of 100 with 260 already paid, out of which
    // only a repair of the data leads. Not a dead end (the settle refuses a
    // negative remainder rather than paying it), which is why this is MED and
    // not HIGH; but a law that holds on one of two write paths is a
    // coincidence, not a law.
    //
    // On the CASCADE path this is the identity by construction: AC13 refuses
    // the edit outright when the edited row carries an accumulator, so
    // `tx.settledAmount` is NULL there and `floorAmountAtAccumulator` returns
    // the request untouched. Same for the overwhelmingly common never-settled
    // row.
    // ONE value with ONE meaning: the figure to store, or nothing to store.
    // `amountToWrite !== undefined` IS `amountChanged` by construction, so the
    // three write sites below cannot disagree about whether this edit touches
    // money (SR-M-1).
    const amountToWrite = amountChanged ? requestedFloored : undefined
    // No `!== undefined` guard: it is only ever READ under `amountChanged`,
    // which already implies it, and the redundant operand was a mutant no test
    // could kill.
    const flooredByAccumulator = amountToWrite !== data.amount

    // The "is this row's amount our own record?" refusals (AC13) live in
    // `assertEditedRowAmountIsOwnRecord`, called below on the LOCKED snapshot —
    // one of the four predicates (a closed obligation on the row itself) needs
    // a query, and splitting one rule across two places is how the halves
    // drift apart.

    // Resolve XOR before write (same logic as updateSeniorIncome). Either
    // field provided as defined wipes the other to satisfy the CHECK.
    const receiptDocChanged = data.receiptDocumentId !== undefined
    const receiptUrlChanged = data.receiptExternalUrl !== undefined
    const receiptPatch: { receiptDocumentId?: string | null; receiptExternalUrl?: string | null } =
      {}
    if (receiptDocChanged || receiptUrlChanged) {
      receiptPatch.receiptDocumentId = receiptDocChanged
        ? (data.receiptDocumentId ?? null)
        : receiptUrlChanged && data.receiptExternalUrl
          ? null
          : tx.receiptDocumentId
      receiptPatch.receiptExternalUrl = receiptUrlChanged
        ? (data.receiptExternalUrl ?? null)
        : receiptDocChanged && data.receiptDocumentId
          ? null
          : tx.receiptExternalUrl
    }

    // HIGH-1: validate receipt ownership + category before writing FK.
    // For ADMIN edits the receipt must belong to the transaction's receiver
    // (for income types) or the ADMIN themselves (for EXPENSE where receiverId
    // is null). Falls back to currentUser.id when no receiver is set.
    const nextReceiptDocId = receiptPatch.receiptDocumentId
    if (nextReceiptDocId && nextReceiptDocId !== tx.receiptDocumentId) {
      const expectedOwnerId = tx.receiverId ?? currentUser.id
      await assertReceiptDocumentBindable(this.db.db, nextReceiptDocId, currentUser, {
        expectedOwnerId,
      })
    }

    // ── SECURITY (security-review round 4, MED-F): the SECOND receipt entrance.
    // This endpoint edits `receiptExternalUrl` on an already-PAID crediting row
    // (metadata-only edits are explicitly allowed on PAID rows above), so
    // without this it bypassed the guard `attachOrReplaceReceipt` got in round
    // 3 — re-pointing a credited admin income at a transfer another settlement
    // had already consumed. Same shared rule, same behaviour.
    const transition =
      receiptUrlChanged || receiptDocChanged
        ? await this.onChainClaim.resolveReceiptHashTransition(
            tx,
            receiptPatch.receiptExternalUrl ?? null,
          )
        : // Stryker disable next-line ObjectLiteral: replacing this no-transition fallback with `{}` is unobservable — `...undefined` spreads no keys into the UPDATE and `undefined` is falsy exactly like `null` / `false` at the two reads below; the inner `txHashPatch: {}` on the next line is NOT covered and stays killable
          {
            txHashPatch: {},
            claimHash: null,
            staleClaim: false,
          }

    assertTxDateNotClaimedInRequest(txDate, transition.claimHash)

    // task-cascade-apply (task 3, AC11) — produced INSIDE the DB transaction,
    // consumed AFTER it commits. `undefined` ⇔ no cascade ran, which is also
    // what gates the invoice re-issue below: one value, one meaning, no
    // separate flag to keep in step.
    let cascadeApplied: { changedDerivativeIds: string[] } | undefined

    try {
      cascadeApplied = await this.db.db.transaction(async (dbtx) => {
        let applied: { changedDerivativeIds: string[] } | undefined
        // task-paid-salary-amount-edit — what the plan (built on the LOCKED
        // snapshot) says about the edited salary's payment fact. Read by the
        // source-row UPDATE and the journal below, never re-derived there:
        // the preview showed exactly this figure.
        let paymentFact: CascadePlan['sourcePaymentFact'] = null
        // task-cascade-apply (task 3, AC2/AC3/AC4-AC7). Runs FIRST inside the
        // transaction: it takes every lock the rest of this callback needs, in
        // the one order that does not invert `settleByCompany`'s, and it
        // refuses BEFORE anything is written.
        if (isCascadeEdit) {
          const snapshot = await this.editCascade.loadCascadeSnapshot(dbtx, id, { forUpdate: true })
          if (!snapshot) {
            throw apiError('FINANCE_TRANSACTION_DELETED_RESTORE_FIRST', HttpStatus.BAD_REQUEST)
          }
          // AC13 — before anything else about the cascade: may this row's
          // amount move at all? Asked FIRST because "this row is not editable"
          // is a different, more fundamental answer than "your preview is
          // stale", and the operator should get the one that is actually true.
          this.editCascade.assertEditedRowAmountIsOwnRecord(snapshot.source, data.amount!)

          // AC2 — re-derive the version from the state we just locked and
          // compare. A MISMATCH means the world moved between the preview and
          // this save (an accountant closed the obligation in another tab), so
          // the operator would be confirming something they were never shown.
          // Refuse and make them look again; a silent recompute IS the
          // preview-vs-fact divergence, just wearing a success response (ADR
          // AC4).
          if (computeCascadeVersion(snapshot) !== data.cascadeVersion) {
            throw apiError('FINANCE_CASCADE_PREVIEW_STALE', HttpStatus.CONFLICT)
          }
          // The server computes the cascade itself. The client's version is an
          // input for comparison, never a plan to execute (ADR AC5 §11).
          const plan = resolveEditCascade(snapshot, { amount: data.amount! })
          paymentFact = plan.sourcePaymentFact ?? null
          applied = await this.editCascade.applyEditCascade(
            dbtx,
            snapshot,
            plan,
            currentUser.impersonatorId ?? currentUser.id,
          )
        }

        // task-fix-obligation-amount-divergence (backlog 181, L3 in
        // docs/architecture/2026-08-22-paid-transaction-edit-cascade.md).
        // `pending_obligations.amount` is a SEPARATE stored copy of the exact
        // same number `transactions.amount` gets below — bookCompanyObligations
        // inserts both rows with the identical share at booking time
        // (transactions.service.ts, senior/drop IOU branches). Nothing kept
        // them in sync afterwards: the settle-time money gate reads FROM
        // `obligation.amount` (pending-settlement.service.ts, `computeCompanyAccountBalanceFromLedger`
        // sufficiency check) while the company-account ledger debits BY
        // `transactions.amount` once the row flips to PAID
        // (company-account-balance.ts `sumLedgerTerms`). Editing only the
        // transactions row here would let a future settle check solvency
        // against a stale sum while the ledger debits a different one — the
        // exact defect this diff closes. Scoped to `status = 'PENDING'`
        // (AC3): a CLOSED obligation's amount is a historical record of a
        // settlement that already happened (L4 in the same doc) and is
        // deliberately out of reach here — the WHERE clause makes that a
        // structural guarantee, not just an intent, even if amountChanged
        // somehow fires for an already-settled source row.
        //
        // security-review round on PR #598 (MED-2, lock-order inversion):
        // this UPDATE runs BEFORE the `transactions` one below — deliberately
        // matching the lock order `settleByCompany` already takes (its own
        // conditional claim UPDATEs `pending_obligations` first, THEN flips
        // `transactions`, pending-settlement.service.ts). Doing it the other
        // way round here (transactions → pending_obligations) would be an
        // ABBA lock order against that method's (pending_obligations →
        // transactions) on the SAME row pair — a Postgres deadlock (40P01)
        // reachable the moment an admin edit and a settle race on the same
        // obligation, surfacing as a genuine 500 on the money path even
        // though neither transaction corrupts anything (Postgres's own
        // deadlock detector aborts one side, full rollback). Ordering both
        // call sites the same way removes the inversion structurally, not by
        // hoping the two never overlap.
        if (amountChanged) {
          await dbtx
            .update(pendingObligations)
            .set({ amount: String(amountToWrite), updatedAt: new Date() })
            .where(
              and(
                eq(pendingObligations.sourceTransactionId, id),
                eq(pendingObligations.status, 'PENDING'),
              ),
            )
        }

        // security-review PR #456 (MED-1, delete↔write TOCTOU): `tx` was read
        // before this transaction opened; re-assert `deleted_at IS NULL`
        // inside the write itself so a concurrent delete cannot land between
        // the pre-check and this UPDATE.
        //
        // SR-795-M-4 (PR #868): a salary-month correction also migrates
        // cron-marker ownership below, decided from `tx.salaryMonth` /
        // `tx.salaryOrigin` read before this transaction opened. Bind the exact
        // source month and origin observed; NULL is meaningful for legacy
        // automatic rows, hence IS NOT DISTINCT FROM rather than `=`.
        const sourceMonthSnapshotPredicates =
          salaryMonthChanged && tx.type === 'SALARY'
            ? [
                sql`${transactions.salaryMonth} IS NOT DISTINCT FROM ${tx.salaryMonth}`,
                sql`${transactions.salaryOrigin} IS NOT DISTINCT FROM ${tx.salaryOrigin}`,
              ]
            : []
        const updated = await dbtx
          .update(transactions)
          .set({
            ...(amountToWrite !== undefined && { amount: String(amountToWrite) }),
            // task-paid-salary-amount-edit — the obligation at the recorded
            // rate, in the SAME statement as the amount so the pair is never
            // observed half-written. `exchangeRate` / `originalCurrency` are
            // deliberately absent: the rate of a transfer that happened does
            // not change because its figure was mistyped.
            //
            // No `amountToWrite !== undefined` beside it: a non-null
            // `paymentFact` already means the plan saw the stored figure move
            // (`resolveEditCascade` sets it only when `sourceAmountChanged`),
            // on a salary with no accumulator — where the floored comparison
            // `amountChanged` makes is the same comparison. The extra operand
            // was an equivalent mutant, i.e. a second rule saying nothing.
            ...(paymentFact?.recomputed && {
              originalAmount: String(paymentFact.newOriginalAmount),
            }),
            ...(data.currency !== undefined && {
              currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
            }),
            ...(data.notes !== undefined && { notes: data.notes }),
            ...receiptPatch,
            ...transition.txHashPatch,
            ...(data.category !== undefined && { receiverLabel: data.category }),
            ...(data.salaryMonth !== undefined && { salaryMonth: data.salaryMonth }),
            ...(dateDecision && { txDate: dateDecision.txDate }),
            updatedAt: new Date(),
          })
          // SR-H-1 (security-review round 4) — re-assert the state every
          // decision above was made on.
          //
          // `isCascadeEdit`, `amountChanged` and `requestedFloored` all come
          // from `tx`, read BEFORE this transaction opened, and on the non-cascade
          // path nothing here takes a lock (`settleByCompany` takes all of
          // them). A settle landing in that window used to be overwritten
          // blind, and it cost twice: term 7 would debit the figure just
          // written while a different one actually left the account — an error
          // in the "+" direction when the edit lowers it, feeding straight
          // into `if (amount > balance) throw` — and the edit would land on a
          // now-`PAID` row carrying an accumulator with NO `cascadeVersion`,
          // NO AC13 and NO cascade, which is precisely the "edit the row that
          // closed the obligation" AC13 exists to forbid. The SR-M-6 floor
          // cannot help: `requestedFloored` is computed from `tx.settledAmount`
          // off that same stale row.
          //
          // Binding the status is enough for BOTH, and not by luck:
          // `settled_amount` is only ever written by the flip, and the flip
          // writes the status in the same `.set()`. So "the accumulator moved"
          // cannot happen without "the status moved", and one predicate covers
          // the pair.
          //
          // Same shape as SR-M-1 of round 2 two screens down (scoped WHERE +
          // affected-row count) — the third statement in this file to use it.
          //
          // NOTE: this `.where` was identical on `origin/main`, so the race is
          // older than this branch. It had no money consequence there only
          // because BIZ-18 forbade editing a PAID row's amount at all. This
          // task lifts BIZ-18, so this task is what wakes it — "no worse than
          // before" is not a defence when the change is the activator.
          .where(
            and(
              eq(transactions.id, id),
              isNull(transactions.deletedAt),
              eq(transactions.status, tx.status),
              // SR-L-1 (review round 5) — the ABA remainder of the predicate
              // above. `PENDING → PAID → PENDING` inside the window leaves the
              // status reading exactly what was read, while the accumulator
              // now says money went out. Binding the accumulator itself closes
              // it; the two predicates are not redundant, they cover A→B and
              // A→B→A.
              //
              // `IS NOT DISTINCT FROM` rather than `=` because the value is
              // NULL on a row that has never settled, and `NULL = NULL` is
              // NULL — which would match nothing and break every ordinary
              // edit. Same statement, same column, same reason as
              // `settleByCompany`'s flip (pending-settlement.service.ts).
              sql`${transactions.settledAmount} IS NOT DISTINCT FROM ${tx.settledAmount}::numeric`,
              ...sourceMonthSnapshotPredicates,
              ...txDateSnapshotPredicates(txDate),
            ),
          )
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          // Zero rows means the snapshot this edit was computed against is no
          // longer the row's state — and the message deliberately does NOT say
          // which part moved. It cannot: the ways to get here outgrew any
          // enumeration (deleted, settled mid-window, A->B->A on the
          // accumulator, and the salary month/origin predicates just above),
          // and on the pay path the same code answers a row that is still
          // PENDING and still un-deleted. So it states the fact and the remedy
          // (reload, retry) and asserts no cause. The concrete cause belongs to
          // the audit log, not to a string shown to an accountant.
          //
          // The full reasoning, and the three rounds of wording that led here,
          // are recorded in cascade-apply.unit.spec.ts, test "the refusal names
          // no specific cause, because the causes outgrew the message" — which
          // also pins it, so this comment and the string cannot drift apart
          // silently.
          throw apiError('FINANCE_ROW_STATE_CHANGED_WHILE_EDITING', HttpStatus.BAD_REQUEST)
        }

        // Salary-month marker migration — see `migrateSalaryMonthMarker`.
        await migrateSalaryMonthMarker(
          dbtx,
          tx,
          data.salaryMonth,
          salaryMonthChanged,
          currentUser.impersonatorId ?? currentUser.id,
        )

        // task-soft-delete-and-money-audit (AC5): "изменение суммы/получателя"
        // — the money-defining fields this endpoint can mutate. Only written
        // when one of them actually changed (mirrors TeamAuditLogService's
        // skip-on-empty-diff convention) — a metadata-only edit (notes/receipt)
        // does not spam the journal.
        // task-fix-obligation-amount-divergence (L11 in the same doc, AC4):
        // `salaryMonthChanged` used to be computed and enforced by BIZ-18
        // above but never reached this condition — a salary moved between
        // months left no journal trail at all. Added to both the condition
        // and the metadata below.
        if (
          amountChanged ||
          currencyChanged ||
          receiverLabelChanged ||
          salaryMonthChanged ||
          dateDecision
        ) {
          await dbtx.insert(transactionAuditLog).values({
            actorId: currentUser.impersonatorId ?? currentUser.id,
            targetId: id,
            action: 'AMOUNT_OR_RECEIVER_CHANGE',
            metadata: {
              ...(amountChanged && {
                amount: {
                  before: tx.amount,
                  // What was actually STORED — recording the typed figure here
                  // when the floor moved it would make the journal describe a
                  // write that never happened.
                  after: String(amountToWrite),
                  // …and what the operator typed, when the two differ. The
                  // floor is silent in the response but must not be silent in
                  // the record (SR-M-6).
                  ...(flooredByAccumulator && { flooredFrom: data.amount }),
                },
              }),
              // task-paid-salary-amount-edit — «старое/новое по всем трём»:
              // amount above, the obligation and the rate here. `recomputed:
              // false` is owner decision 2 (no rate recorded → the obligation
              // is left as it was), and the note makes the resulting
              // disagreement between the three a recorded choice, not a bug.
              // (Non-null only on an amount change — see the UPDATE above.)
              ...(paymentFact && {
                paymentFact: {
                  originalAmount: {
                    before: String(paymentFact.oldOriginalAmount),
                    after: String(paymentFact.newOriginalAmount),
                  },
                  exchangeRate: {
                    before: paymentFact.exchangeRate,
                    after: paymentFact.exchangeRate,
                  },
                  recomputed: paymentFact.recomputed,
                  ...(!paymentFact.recomputed && {
                    note: 'exchange rate not recorded — obligation not recomputed',
                  }),
                },
              }),
              ...(currencyChanged && {
                currency: { before: tx.currency, after: data.currency },
              }),
              ...(receiverLabelChanged && {
                receiverLabel: { before: tx.receiverLabel, after: data.category },
              }),
              ...(salaryMonthChanged && {
                salaryMonth: { before: tx.salaryMonth, after: data.salaryMonth },
              }),
              ...(dateDecision && {
                txDate: {
                  before: txDate.storedBusinessDay,
                  after: formatTransactionBusinessDate(dateDecision.txDate),
                },
              }),
            },
          })
        }

        // D-2: an out-of-window backdate carries its justification on the
        // trail, in the same transaction as the date it justifies.
        if (dateDecision?.backdateReason) {
          await dbtx.insert(transactionAuditLog).values(
            backdateAuditRow({
              targetId: id,
              actor: currentUser,
              txDate: dateDecision.txDate,
              backdateReason: dateDecision.backdateReason,
            }),
          )
        }

        if (transition.claimHash) {
          const claim = await consumeTxHash(dbtx, {
            txHash: transition.claimHash,
            purpose: 'ADMIN_INCOME',
            referenceId: id,
            consumedByUserId: currentUser.id,
          })
          if (claim.reclaimedAfterRelease) {
            await this.onChainClaim.recordReclaimAfterRelease(dbtx, {
              path: 'adminUpdateTransaction',
              txHash: transition.claimHash,
              referenceId: id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }
        if (transition.staleClaim) {
          await this.onChainClaim.recordReceiptClaimDivergence(dbtx, {
            path: 'adminUpdateTransaction',
            transactionId: id,
            actorId: currentUser.impersonatorId ?? currentUser.id,
          })
        }

        return applied
      })
    } catch (err) {
      // MED-L (round 5): same as the sibling receipt entrance — a racing claim
      // must surface as a 400, not a 500.
      // MED-Q (round 6): and ONLY a registry conflict may say so. Any unrelated
      // unique violation from the same transaction has nothing to do with a tx
      // hash and must pass through unchanged.
      if (isRegistryConflict(err)) {
        throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
      }
      throw err
    }

    // Post-commit invoice void/re-issue repair — see `repairInvoicesAfterAdminEdit`.
    return repairInvoicesAfterAdminEdit(
      { db: this.db, invoicesService: this.invoicesService, logger: this.logger },
      {
        id,
        tx,
        actorId: currentUser.impersonatorId ?? currentUser.id,
        cascadeApplied,
        dateMoved: !!dateDecision,
      },
    )
  }
}
