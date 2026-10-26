import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { SalaryMonthGapReportDto, SessionUser } from '@crm/shared'
import {
  COMPANY_ACCOUNT_LABEL,
  receiptMandatoryError,
  selfPayError,
  transactionAmountError,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import type { DrizzleTx } from '../database/types'
import {
  salaryMonthInitializations,
  transactionAuditLog,
  transactions,
  users,
} from '../database/schema'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { isStorableExchangeRate } from './exchange-rate.util'
import { assertReceiptDocumentBindable } from './receipt.util'
import { isAutomaticSalaryComponent } from './salary-origin'
import { SalaryService } from './salary.service'
import {
  formatTransactionBusinessDate,
  resolveTransactionDate,
  sourceBusinessDay,
} from './transaction-date.util'
import { TransactionLifecycleService } from './transaction-lifecycle.service'
import { assertTransactionWritable } from './transaction-visibility.util'

/**
 * Salary payment and accrual: the manual PENDING to PAID pay flow, the monthly
 * salary accrual the cron runs, and the ADMIN month backfill that re-runs that
 * same accrual. Depends on the database, the salary collaborator and the
 * transaction lifecycle; never on TransactionsService. `paySalary` returns the
 * paid row id; the facade performs the viewer-scoped read-back.
 */
@Injectable()
export class SalaryPaymentService {
  private readonly logger = new Logger(SalaryPaymentService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly salaryService: SalaryService,
    private readonly lifecycle: TransactionLifecycleService,
  ) {}

  async paySalary(
    id: string,
    data: {
      // task-salary-pay-flow: the funding source + currency are chosen HERE (at
      // pay time), not at creation. The PENDING salary is a neutral reminder.
      fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
      // For ADMIN_PERSONAL — whose personal account pays; must be an ADMIN.
      payerAdminId?: string | undefined
      currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
      // task-salary-pay-amount: the amount ACTUALLY paid, in `currency`. When
      // omitted the row's own amount is carried over unchanged (legacy
      // behaviour — only the currency LABEL changed). Zod bounds it at the
      // boundary (positive, ≤ MAX_TRANSACTION_AMOUNT).
      paidAmount?: number | undefined
      txDate?: string | null | undefined
      txHash?: string | null | undefined
      // task-receipts-backend (#7): pay-time proof MANDATORY, currency-aware
      // (COMPANY_ACCOUNT → USDT → explorer-only). Zod enforces at the boundary.
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    assertTransactionWritable(tx, currentUser)
    if (tx.type !== 'SALARY') throw apiError('FINANCE_PAY_SALARY_ONLY', HttpStatus.BAD_REQUEST)
    if (tx.status !== 'PENDING')
      throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)

    // A salary payment can be entered later than it happened, but it cannot
    // predate the salary transaction itself. Keep the comparison at calendar-
    // day granularity because the UI submits a business date (YYYY-MM-DD).
    // SR-809-M-1 (PR #868): resolve an omitted/null date to now and validate
    // that effective day too, so omitting the field cannot bypass the bound.
    const paymentTxDate = resolveTransactionDate(data.txDate, new Date())
    // Backlog 338: a NULL-txDate row floors on the KYIV day of createdAt.
    const sourceDate = sourceBusinessDay(tx)
    if (formatTransactionBusinessDate(paymentTxDate) < sourceDate) {
      throw apiError('FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION', HttpStatus.BAD_REQUEST)
    }

    // task-finance-fix-wave1 (E-1): refuse to PAY a salary whose receiver has
    // been dismissed. `assertTransactionWritable` above only knows about
    // `deletedAt`, and nothing else on this path reads the receiver at all — so
    // the PENDING rows the cron had already accumulated for archived employees
    // (before the query filter above existed) stayed payable with one click.
    // Same shape as the recipient barrier in manualConfirmPayout: fetch the
    // named user, refuse when `archivedAt` is set.
    //
    // This is the FAST gate (and the one whose message the operator sees). It is
    // not the whole guard: the same condition is re-asserted inside both write
    // paths below — see `salaryReceiverNotArchivedFilter` for why a pre-read on
    // its own is not enough (MED-3). No transaction is open here, so the base
    // connection is the right executor.
    await this.salaryService.assertSalaryReceiverNotArchived(this.db.db, tx.receiverId)

    const isCompanyFunded = data.fundingSource === 'COMPANY_ACCOUNT'

    // task-receipts-backend (#7): defense-in-depth mandatory-receipt re-check.
    // Effective currency = USDT for a company-account payout (USDT-only account)
    // → explorer-only; else the chosen currency → file/url. Validate the doc
    // binding for a non-USDT file receipt.
    const effectiveReceiptCurrency = isCompanyFunded ? 'USDT' : data.currency
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      effectiveReceiptCurrency,
    )
    if (receiptErr) throw zodErrorBadRequest(receiptErr)
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
    }

    // Resolve sender + currency from the pay-time funding choice. The AMOUNT is
    // never converted — only the currency LABEL changes.
    let senderId: string | null
    let senderLabel: string
    let currency: 'USDT' | 'USD' | 'EUR' | 'UAH'

    if (isCompanyFunded) {
      // COMPANY_ACCOUNT: money leaves the shared company USDT account. Force USDT
      // (USDT-only account), no personal sender, labelled with the COMPANY_ACCOUNT_LABEL code.
      currency = 'USDT'
      senderId = null
      senderLabel = COMPANY_ACCOUNT_LABEL
    } else {
      // ADMIN_PERSONAL: paid from an admin partner's personal account. The payer
      // defaults to the calling (ADMIN) user; an explicit payerAdminId must
      // resolve to an ADMIN. Currency is the chosen one (any). No company balance
      // impact → no lock / balance gate.
      const payerAdminId = data.payerAdminId ?? currentUser.id
      const payer = await this.db.db.query.users.findFirst({
        where: eq(users.id, payerAdminId),
      })
      if (!payer || payer.role !== 'ADMIN') {
        throw apiError('FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
      }
      senderId = payer.id
      senderLabel = payer.displayName
      // Currency audit (LOW): SALARY has no fixed-currency obligation — unlike
      // settleByCompany (which guards against currency mismatch with a
      // pending_obligation), SALARY rows carry no locked currency at creation
      // (the PENDING row is denomination-neutral). Any currency is valid here.
      currency = data.currency
    }

    // security-review round 2 (MED-1): friendly 400 BEFORE the DB CHECK
    // (ck_transactions_sender_ne_receiver) would reject the UPDATE below with
    // an opaque constraint-violation error. `tx.receiverId` was fixed at
    // SALARY creation and this method only re-checks `payer.role ===
    // 'ADMIN'` — never the RECEIVER's CURRENT role — so senderId===receiverId
    // would only be caught by the DB, not here, if that ever became possible.
    //
    // Verified NOT reachable today by reading (not assuming) both role-
    // mutation doors: `UsersService.changeRole` and `.adminUpdateUser` BOTH
    // explicitly refuse `role === 'ADMIN'` ("ADMIN pool is fixed") — so no
    // SALARY receiver (never ADMIN by construction — createSalary's
    // SALARY_ELIGIBLE_ROLES gate, both accrual crons filter role explicitly)
    // can ever become the same row as an ADMIN payer. Kept as defense-in-
    // depth anyway, same reasoning as the `confirmPayout` guard above: cheap,
    // and it stops relying on "the ADMIN pool is fixed" holding forever
    // across every future change to those two methods.
    const paySalarySelfPayErr = selfPayError(senderId, tx.receiverId)
    if (paySalarySelfPayErr) throw zodErrorBadRequest(paySalarySelfPayErr)

    // ── task-salary-pay-amount: the FACT of the payment vs the OBLIGATION ────
    //
    // `amount`/`currency` on the row become what ACTUALLY left the payer's
    // account (owner decision, 2026-08-05: a bank statement must reconcile
    // one-to-one), which may be denominated differently from the obligation the
    // salary was created with. The obligation is NOT overwritten — it is
    // snapshotted into original_amount / original_currency, with the effective
    // rate derived from the pair. Without that snapshot the USD reporting,
    // balances and the «projects unpaid this month» metric that are built on the
    // original denomination would silently lose their input.
    //
    // The payment CLOSES the obligation in full regardless of the figure (there
    // are no partial payments in this model), so nothing here compares the two
    // amounts or rejects a mismatch — the client warns about an implausible
    // deviation (salaryPaidAmountDeviation) precisely because the server, by
    // design, will not stop it.
    const obligationAmount = parseFloat(tx.amount)
    const paidAmountProvided = data.paidAmount !== undefined
    // Defense-in-depth: Zod already applies `transactionAmountError` at the
    // controller boundary. Re-checked here through the SAME function (one rule,
    // no drift) because this service method is also reachable from server-side
    // callers that never pass through Zod — and because a non-finite amount
    // would otherwise reach the balance gate below as NaN, where EVERY
    // comparison is false, so the gate would wave a company-account debit
    // through instead of refusing it.
    //
    // security-review PR #485 (MED-1): this is also what stops an amount too
    // small for `numeric(18,6)` (`1e-7`) from being stored as `0.000000` — an
    // obligation closed in full by a payment recorded as zero.
    if (paidAmountProvided) {
      const amountError = transactionAmountError(data.paidAmount!)
      // task-i18n-stage4-task4: `transactionAmountError` now returns a
      // `zod.<CODE>` key (translated by `ZodExceptionFilter`/`translateZodError`
      // on the Zod-boundary path this same function backs). THIS call site is
      // the one server-side caller that never goes through Zod at all (see the
      // comment above) — without this translation, the raw key would leak into
      // the exception body verbatim instead of readable text.
      //
      // fix-round 2 (CR-M-2): routed through `zodErrorBadRequest` — the SAME
      // helper every other direct-throw call site in this file uses — instead
      // of re-implementing the `zod.<CODE>` → English-fallback lookup a third
      // time by hand. This also upgrades the body to the coded
      // `{ statusCode, code, message }` shape (was a plain string before),
      // which `extractBackendMessage` (`axios-utils.ts`, SR-M-4) now
      // recognizes and translates client-side.
      if (amountError) {
        throw zodErrorBadRequest(amountError)
      }
    }
    const paidAmount = paidAmountProvided ? data.paidAmount! : obligationAmount
    // Effective applied rate = paid / original (units of the paid currency per 1
    // unit of the original one). Derived, never client-supplied — see the column
    // comment in schema.ts. NULL when the obligation amount is unusable as a
    // divisor (should not happen: amounts are positive by schema).
    //
    // `Math.sign(x) === 1` is `x > 0` (false for 0, negatives and NaN). An unusable
    // obligation yields NaN, which `isStorableExchangeRate` below rejects through its own
    // `Number.isFinite` check, so the stored rate is NULL in that case.
    const rawExchangeRate: number =
      Number.isFinite(obligationAmount) && Math.sign(obligationAmount) === 1
        ? paidAmount / obligationAmount
        : Number.NaN
    // security-review PR #485 (related to MED-1) — an unrepresentable ratio is
    // recorded as NULL, never as a wrong number, and never as a refusal.
    //
    // An extreme pair of amounts can produce a ratio `numeric(18,8)` cannot
    // hold: at or above 1e10 Postgres rejects the write outright with a raw
    // «numeric field overflow» (a 500 that tells the user nothing), and below
    // 1e-8 it does something worse — stores a flat `0.00000000`, so the row
    // claims a rate of ZERO when the real one was merely tiny.
    //
    // Refusing the PAYMENT in those cases was the first instinct, and it is
    // wrong: it lets the width of a DERIVED convenience column veto a payment
    // whose two amounts are both perfectly storable (a test caught this
    // immediately — the smallest storable amount, 0.000001, against an ordinary
    // obligation produces a sub-resolution ratio), and it smuggles back in the
    // plausibility judgment this flow deliberately leaves to the client's
    // warning. The authoritative record is the PAIR (original_amount, amount) —
    // both written losslessly, both enough to re-derive the rate exactly. So
    // when the ratio cannot be recorded faithfully, the honest value is NULL
    // («not recorded»), and the write never reaches the column with a number
    // that would overflow it.
    const exchangeRate = isStorableExchangeRate(rawExchangeRate) ? rawExchangeRate.toFixed(8) : null

    // task-salary-pay-flow: stamp txDate = the actual payment business date.
    // When legacy callers omit it, resolveTransactionDate preserves the old "now"
    // behaviour; the UI supplies the operator-selected calendar day.
    const paidSet = {
      status: 'PAID' as const,
      fundingSource: isCompanyFunded ? ('COMPANY_ACCOUNT' as const) : ('ADMIN_PERSONAL' as const),
      currency,
      // The FACT of the payment — written ONLY when the caller actually stated
      // one. An omitted `paidAmount` leaves `amount` completely untouched
      // (byte-for-byte the legacy behaviour), rather than rewriting the stored
      // numeric string with a re-serialised copy of itself.
      ...(paidAmountProvided ? { amount: String(paidAmount) } : {}),
      // …and the OBLIGATION it settled, snapshotted from the row as it stood a
      // moment ago. Stamped on EVERY pay (not only when the amount changed) so
      // the pair is uniform: a reader never has to guess whether a NULL means
      // "unchanged" or "unpaid through this flow".
      originalAmount: tx.amount,
      originalCurrency: tx.currency,
      exchangeRate,
      senderId,
      senderLabel,
      txHash: data.txHash ?? null,
      // task-receipts-backend (#7): stamp the pay-time proof on the row.
      receiptDocumentId: data.receiptDocumentId ?? null,
      receiptExternalUrl: data.receiptExternalUrl ?? null,
      notes: data.notes ?? tx.notes,
      txDate: paymentTxDate,
      updatedAt: new Date(),
    }

    // SR-795-M-4 (PR #868): several fields in `paidSet` derive from the
    // pre-write salary snapshot. If an admin edits that PENDING salary between
    // the read and this payment, paying the stale snapshot would record a
    // different obligation than the one just changed. Bind every mutable source
    // field that is copied or derived from. Notes need a predicate only when
    // the request omits them (and so copies tx.notes).
    const paymentSnapshotPredicates = [
      eq(transactions.amount, tx.amount),
      eq(transactions.currency, tx.currency),
    ]
    if (data.notes === undefined) {
      paymentSnapshotPredicates.push(sql`${transactions.notes} IS NOT DISTINCT FROM ${tx.notes}`)
    }

    if (isCompanyFunded) {
      // For a company-funded salary the money leaves the shared USDT account
      // exactly NOW (at PAID). The PENDING row is not yet counted by the balance
      // formula (only PAID company SALARY debits), so `balance >= amount` is the
      // exact "can the account cover this payout" check.
      //
      // MED-1 (TOCTOU): the gate-read and the PENDING→PAID flip (which performs
      // the debit) MUST be serialized. Two concurrent paySalary calls would
      // otherwise both read the same balance, both pass, and both flip → the
      // account goes negative. Wrap gate+flip in one transaction holding the
      // company-account advisory lock; the second concurrent debit blocks,
      // re-reads the reduced balance and correctly fails. The status re-check
      // inside the lock guards against a double-flip of the SAME row.
      //
      // task-salary-pay-amount: the gate MUST measure the amount that is
      // actually about to be debited (`paidAmount`, which is what gets written
      // to `amount` and therefore what the ledger formula subtracts) — NOT the
      // row's pre-payment amount. Gating on the old figure while writing a
      // larger one would let a payout exceed the balance and drive the company
      // account negative; the company account is USDT-only (currency is forced
      // to USDT above), so the two are directly comparable with no conversion.
      const amount = paidAmount
      await this.db.db.transaction(async (dbtx) => {
        await lockCompanyAccount(dbtx)
        // security-review PR #456 (MED-1): re-check deleted_at IS NULL too —
        // not just status — so a delete racing this pay cannot leave a PAID
        // row that is also deleted (or vice versa).
        const [fresh] = await dbtx
          .select({ status: transactions.status })
          .from(transactions)
          .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
        if (!fresh || fresh.status !== 'PENDING') {
          throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)
        }
        const companyBalance = await computeCompanyAccountBalanceFromLedger(dbtx ?? this.db.db)
        if (companyBalance < amount) {
          throw apiError('FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS', HttpStatus.BAD_REQUEST)
        }
        const updated = await dbtx
          .update(transactions)
          .set(paidSet)
          .where(
            and(
              eq(transactions.id, id),
              // Mixed-source race: ADMIN_PERSONAL does not take the company
              // advisory lock. It can flip this same row after the in-lock
              // SELECT above but before this UPDATE. Re-assert PENDING in the
              // write itself so exactly one funding source can win.
              eq(transactions.status, 'PENDING'),
              isNull(transactions.deletedAt),
              ...paymentSnapshotPredicates,
              // MED-3: archival re-asserted in the write, not only pre-read.
              this.salaryService.salaryReceiverNotArchivedFilter(),
            ),
          )
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          // Zero rows has three possible causes (a racing delete/pay, a racing
          // archive, or a snapshot predicate that no longer matches). Name the
          // real one instead of guessing. Read through `dbtx` — the transaction
          // still owns a connection here, and going via `this.db.db` would check
          // out a second one (round 3, LOW).
          await this.throwPayClaimFailure(dbtx, id, tx.receiverId)
        }
      })
    } else {
      // Audit 2026-06-28 (#11): make the ADMIN_PERSONAL PENDING→PAID flip ATOMIC.
      // The pre-read status check above (line ~3495) is a TOCTOU window — two
      // concurrent paySalary calls both read PENDING and both flip + both fire
      // safeAutoCreateInvoice → a DUPLICATE invoice for one salary. Add the
      // status guard to the UPDATE itself (the COMPANY_ACCOUNT path already
      // serialises via the lock + status re-check) and only fire the invoice when
      // THIS call actually performed the flip (exactly one row updated).
      //
      // security-review PR #456 (MED-1): also re-check deleted_at IS NULL —
      // a delete racing this pay must not leave a PAID+deleted row.
      const flipped = await this.db.db
        .update(transactions)
        .set(paidSet)
        .where(
          and(
            eq(transactions.id, id),
            eq(transactions.status, 'PENDING'),
            isNull(transactions.deletedAt),
            ...paymentSnapshotPredicates,
            // MED-3: same in-write archival re-assertion as the company path.
            this.salaryService.salaryReceiverNotArchivedFilter(),
          ),
        )
        .returning({ id: transactions.id })
      if (flipped.length !== 1) {
        // A concurrent paySalary already flipped this row, a concurrent archive
        // of the receiver made the guard reject it, or an edit moved the
        // snapshot this payment was derived from. This path runs in no
        // transaction, so the base connection is correct here.
        await this.throwPayClaimFailure(this.db.db, id, tx.receiverId)
      }
    }

    // Trigger 2: invoice auto-create for SALARY → PAID transitions. Run AFTER the
    // debit transaction commits (best-effort; must not hold the lock). Reached
    // only when THIS call performed the flip (the ADMIN_PERSONAL guard above and
    // the company-account status re-check both throw on a lost race).
    await this.lifecycle.safeAutoCreateInvoice('SALARY', id)

    // task-soft-delete-and-money-audit (AC5): "оплата". Best-effort, like the
    // invoice trigger above — run AFTER the debit transaction has already
    // committed (never inside the advisory-locked block: a logging hiccup
    // must not turn a successful payment into a 500 or hold the company-
    // account lock any longer than necessary).
    try {
      await this.db.db.insert(transactionAuditLog).values({
        actorId: currentUser.impersonatorId ?? currentUser.id,
        targetId: id,
        action: 'PAY',
        metadata: {
          type: 'SALARY',
          // task-salary-pay-amount: `amount` stays the field an auditor already
          // knows, now carrying the FACT that was paid; the obligation it
          // settled is recorded next to it so the audit trail alone answers
          // «what was owed and what actually went out».
          amount: paidAmountProvided ? String(paidAmount) : tx.amount,
          currency,
          originalAmount: tx.amount,
          originalCurrency: tx.currency,
          exchangeRate,
          fundingSource: paidSet.fundingSource,
        },
      })
    } catch (auditErr) {
      this.logger.error(
        `paySalary: failed to persist audit record for transaction=${id}: ${(auditErr as Error).message}`,
        (auditErr as Error).stack,
      )
    }

    return { id }
  }

  /**
   * CR-M-1 (PR #868 fix round 1). The PENDING->PAID claim can match zero rows
   * for three different reasons, and calling them all
   * `FINANCE_TRANSACTION_NOT_PENDING` is a false statement for two of them: the
   * row IS pending, it is the snapshot that moved under us.
   *
   *   archived receiver            -> the archival assertion throws its own error
   *   gone / deleted / not PENDING -> FINANCE_TRANSACTION_NOT_PENDING
   *   still PENDING                -> by elimination only a snapshot predicate
   *                                   (amount / currency / copied notes,
   *                                   SR-795-M-4) can have rejected the write, so
   *                                   FINANCE_ROW_STATE_CHANGED_WHILE_EDITING —
   *                                   the code `AdminEditService` already uses
   *                                   for exactly this cause.
   *
   * Returns `never`: every branch throws.
   */
  private async throwPayClaimFailure(
    db: DatabaseService['db'] | DrizzleTx,
    id: string,
    receiverId: string | null,
  ): Promise<never> {
    // Unchanged behaviour: a racing archive is named first, by the assertion's
    // own error, rather than being folded into either code below.
    await this.salaryService.assertSalaryReceiverNotArchived(db, receiverId)

    const [fresh] = await db
      .select({ status: transactions.status, deletedAt: transactions.deletedAt })
      .from(transactions)
      .where(eq(transactions.id, id))

    if (!fresh || fresh.deletedAt !== null || fresh.status !== 'PENDING') {
      throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)
    }
    throw apiError('FINANCE_ROW_STATE_CHANGED_WHILE_EDITING', HttpStatus.BAD_REQUEST)
  }

  /**
   * @param actor security-review HIGH-1: OMITTED for the CRON caller
   *   (`SalaryCronService`) — no human decided THIS specific run, so
   *   `createdBy` falls back to an arbitrary admin (deliberate, pre-existing
   *   choice — Audit 2026-06-28 #7) and NOTHING is written to
   *   `transactionAuditLog`, matching `recordCreationAudit`'s own documented
   *   scope ("system-derived side-effects... not a second independent
   *   creation a human decided to make"). PASSED by `backfillSalaryMonth` —
   *   an ADMIN clicking a button IS a human decision: every row THIS call
   *   actually inserts (not a row that already existed — `ON CONFLICT DO
   *   NOTHING` returns zero rows for those) is attributed to that real actor
   *   and gets a `transactionAuditLog` CREATE entry, exactly like every other
   *   user-facing creation entry point in this file (createSalary etc.).
   */
  async createMonthlySalaries(month: string, actor?: SessionUser) {
    // Create PENDING salary for HR and ACCOUNTANT
    const hrAccountantReceivers = await this.salaryService.resolveHrAccountantSalaryReceivers()

    // Resolve WHO creates these rows (`createdBy`).
    //
    // Audit 2026-06-28 (#7): resolve ANY admin (was hardcoded to MAKSYM_ID). On a
    // prod DB whose admin ids differ from the dev seed, the MAKSYM_ID lookup
    // returned undefined → the cron silently returned, creating ZERO salary
    // reminders every month with no signal. If no admin exists at all, log an
    // error so the misconfiguration surfaces instead of failing silently.
    // security-review HIGH-1: this "any admin, no orderBy" fallback stays
    // EXACTLY as-is for the cron path (no `actor`) — see the method docblock.
    let actorId: string
    if (actor) {
      // security-review pattern (mirrors adminDeleteTransaction /
      // recordCreationAudit): under impersonation, attribute to the REAL
      // admin operator, never the impersonated target.
      actorId = actor.impersonatorId ?? actor.id
    } else {
      const admin = await this.db.db.query.users.findFirst({
        where: eq(users.role, 'ADMIN'),
      })
      if (!admin) {
        this.logger.error(
          'createMonthlySalaries: no ADMIN user found — cannot create salary reminders (skipping)',
        )
        return
      }
      actorId = admin.id
    }

    const createAutomaticSalary = async (values: {
      receiverId: string
      amount: string
      projectId?: string
    }): Promise<string | null> =>
      this.db.db.transaction(async (dbtx) => {
        // Claim the month's automatic component, independently of the salary
        // ledger. Whoever claims first owns the month: since owner decision D-3
        // (SR-795-M-1) a MANUAL part claims this marker too, and a month it
        // already holds makes this insert a no-op — which is exactly how cron
        // comes to skip a month an operator has already recorded by hand.
        const claimed = await dbtx
          .insert(salaryMonthInitializations)
          .values({
            receiverId: values.receiverId,
            salaryMonth: month,
            initializedBy: actorId,
          })
          .onConflictDoNothing({
            target: [salaryMonthInitializations.receiverId, salaryMonthInitializations.salaryMonth],
          })
          .returning({ id: salaryMonthInitializations.id })
        if (!claimed[0]) return null

        // Before this feature salary_origin did not exist. A legacy row for the
        // receiver/month is therefore the automatic component already created.
        // Read the raw table intentionally: a soft-deleted automatic salary must
        // not be resurrected by a later cron run.
        const existingAutomatic = await dbtx.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'SALARY'),
            eq(transactions.receiverId, values.receiverId),
            eq(transactions.salaryMonth, month),
            // CR-795-M-7: one shared fragment — see salary-origin.ts.
            isAutomaticSalaryComponent(),
          ),
          columns: { id: true },
        })
        if (existingAutomatic) return null

        const [inserted] = await dbtx
          .insert(transactions)
          .values({
            type: 'SALARY',
            status: 'PENDING',
            amount: values.amount,
            currency: 'USD',
            senderId: null,
            senderLabel: 'CheekyCheeseIT',
            receiverId: values.receiverId,
            ...(values.projectId ? { projectId: values.projectId } : {}),
            salaryMonth: month,
            salaryOrigin: 'CRON',
            fundingSource: null,
            createdBy: actorId,
            // SR-H-1 (PR #1158): never NULL — the Kyiv business day of the cron run.
            txDate: resolveTransactionDate(null),
          })
          .returning({ id: transactions.id })
        return inserted?.id ?? null
      })

    const hrAccountantFailures: string[] = []
    for (const emp of hrAccountantReceivers) {
      try {
        const insertedId = await createAutomaticSalary({
          receiverId: emp.id,
          amount: emp.monthlySalary,
        })
        if (insertedId) {
          await this.lifecycle.afterTransactionCreated(
            insertedId,
            { type: 'SALARY', amount: emp.monthlySalary, currency: 'USD' },
            actor ?? null,
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(
          `createMonthlySalaries: failed for employee ${emp.id} (${emp.email}) month=${month} — ${msg}`,
          err instanceof Error ? err.stack : undefined,
        )
        hrAccountantFailures.push(emp.id)
      }
    }
    if (hrAccountantFailures.length > 0) {
      this.logger.error(
        `createMonthlySalaries: ${hrAccountantFailures.length} HR/ACCOUNTANT salary(ies) failed for month=${month}. Failed employee ids: ${hrAccountantFailures.join(', ')}`,
      )
    }

    // Create PENDING salary for JUNIORs on active projects.
    const juniorReceivers = await this.salaryService.resolveJuniorSalaryReceivers()

    const juniorFailures: string[] = []
    for (const jr of juniorReceivers) {
      try {
        const insertedId = await createAutomaticSalary({
          receiverId: jr.id,
          amount: jr.monthlySalary,
          projectId: jr.projectId,
        })
        if (insertedId) {
          await this.lifecycle.afterTransactionCreated(
            insertedId,
            { type: 'SALARY', amount: jr.monthlySalary, currency: 'USD' },
            actor ?? null,
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(
          `createMonthlySalaries: failed for junior ${jr.id} (${jr.email}) project=${jr.projectId} month=${month} — ${msg}`,
          err instanceof Error ? err.stack : undefined,
        )
        juniorFailures.push(jr.id)
      }
    }
    if (juniorFailures.length > 0) {
      this.logger.error(
        `createMonthlySalaries: ${juniorFailures.length} JUNIOR salary(ies) failed for month=${month}. Failed employee ids: ${juniorFailures.join(', ')}`,
      )
    }
  }

  /**
   * POST /api/finance/salary-month-backfill — ADMIN only. Dozapolnenie: closes
   * this month's gap for whoever `resolveSalaryMonthGap` (== the cron's own
   * eligibility) says is missing, by re-invoking `createMonthlySalaries` for
   * the EXACT SAME month — no separate insert logic, so the idempotency
   * guarantee (initialization marker + ON CONFLICT DO NOTHING) is inherited verbatim,
   * not re-implemented. Returns the POST-backfill gap so the caller sees
   * immediately whether anything is still missing (e.g. a per-employee DB
   * error the cron's own try/catch already logged).
   */
  async backfillSalaryMonth(
    currentUser: SessionUser,
    month: string,
  ): Promise<SalaryMonthGapReportDto> {
    if (currentUser.role !== 'ADMIN') {
      throw apiError('FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    // security-review HIGH-1: pass the REAL actor — see createMonthlySalaries's
    // docblock for why this differs from the cron's unaudited "any admin" call.
    await this.createMonthlySalaries(month, currentUser)
    return this.salaryService.resolveSalaryMonthGap(month)
  }
}
