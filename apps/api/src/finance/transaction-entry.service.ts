import { BadRequestException, ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import {
  COMPANY_ACCOUNT_LABEL,
  receiptMandatoryError,
  SALARY_ELIGIBLE_ROLES,
  selfPayError,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import { uniqueViolationConstraint } from '../database/pg-errors'
import { salaryMonthInitializations, transactions, users } from '../database/schema'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { assertReceiptDocumentBindable } from './receipt.util'
import {
  assertSalaryCreationIntent,
  assertSalaryReplayTargetLive,
  buildSalaryCreationIntent,
} from './salary-creation-intent'
import { resolveTransactionDate } from './transaction-date.util'
import { TransactionLifecycleService } from './transaction-lifecycle.service'

/**
 * Manual transaction entry: the EXPENSE, SALARY and ADMIN_TRANSFER write paths
 * with their RBAC gates, receipt checks, company-account balance gate and
 * after-create lifecycle hook. Depends on the database and the transaction
 * lifecycle; never on TransactionsService. Each method returns the created (or
 * replayed) row id; the facade performs the viewer-scoped read-back.
 */
@Injectable()
export class TransactionEntryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly lifecycle: TransactionLifecycleService,
  ) {}

  async createExpense(
    data: {
      amount: number
      currency: string
      category: string
      notes?: string | null
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      txDate?: string | null | undefined
      // task-salary-company-account: optional company-account routing. Only
      // COMPANY_ACCOUNT is meaningful (ADMIN_PERSONAL is implicit/legacy when
      // absent). Absent → legacy expense (no balance impact, currency as given).
      fundingSource?: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL' | undefined
    },
    currentUser: SessionUser,
  ) {
    // task-accountant-create-transaction. ACCOUNTANT has create-parity with
    // ADMIN for company expenses (business doc finance.md: «ACCOUNTANT — …,
    // расходы, …»). senderId = currentUser.id records who booked the expense.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT')
      throw new ForbiddenException()

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller
    // boundary. Effective currency = USDT for a company-account expense
    // (USDT-only pool) → explorer-only; else the supplied currency → file/url.
    const expenseReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      data.fundingSource === 'COMPANY_ACCOUNT' ? 'USDT' : data.currency,
    )
    if (expenseReceiptErr) throw zodErrorBadRequest(expenseReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
    }

    // task-salary-company-account: company-funded expense path. Pays OUT of the
    // shared company USDT account → always USDT, no personal sender, gated by the
    // live company balance, funding_source persisted so the balance formula
    // debits it. Absent fundingSource = legacy expense (unchanged: caller is
    // sender, currency as supplied, no balance impact, funding_source NULL).
    let currency = data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH'
    let senderId: string | null = currentUser.id
    let senderLabel: string | null = null
    let fundingSource: 'COMPANY_ACCOUNT' | null = null
    const isCompanyFunded = data.fundingSource === 'COMPANY_ACCOUNT'

    if (isCompanyFunded) {
      currency = 'USDT'
      senderId = null
      senderLabel = COMPANY_ACCOUNT_LABEL
      fundingSource = 'COMPANY_ACCOUNT'
    }

    const values = {
      type: 'EXPENSE' as const,
      status: 'PAID' as const,
      amount: String(data.amount),
      currency,
      senderId,
      senderLabel,
      receiverLabel: data.category,
      notes: data.notes ?? null,
      receiptDocumentId: data.receiptDocumentId ?? null,
      receiptExternalUrl: data.receiptExternalUrl ?? null,
      fundingSource,
      txDate: resolveTransactionDate(data.txDate),
      createdBy: currentUser.id,
    }

    // MED-1 (TOCTOU): for a company-funded expense the gate-read and the debit
    // write MUST be serialized — otherwise two concurrent expenses both read the
    // same balance, both pass the gate, and the account goes negative. Wrap
    // gate+write in one transaction and acquire the company-account advisory lock
    // FIRST; the second concurrent debit blocks, re-reads the reduced balance and
    // correctly fails. Legacy (non-company) expenses have no balance impact → no
    // lock needed.
    let txId: string
    if (isCompanyFunded) {
      txId = await this.db.db.transaction(async (dbtx) => {
        await lockCompanyAccount(dbtx)
        const companyBalance = await computeCompanyAccountBalanceFromLedger(dbtx ?? this.db.db)
        if (companyBalance < data.amount) {
          throw apiError('FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS', HttpStatus.BAD_REQUEST)
        }
        const [tx] = await dbtx.insert(transactions).values(values).returning()
        return tx!.id
      })
    } else {
      const [tx] = await this.db.db.insert(transactions).values(values).returning()
      txId = tx!.id
    }

    await this.lifecycle.afterTransactionCreated(txId, values, currentUser)
    return { id: txId }
  }

  // ── Create SALARY ─────────────────────────────────────────────────────────

  async createSalary(
    data: {
      receiverId: string
      amount: number
      currency?: string
      salaryMonth: string
      idempotencyKey: string
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    // task-accountant-create-transaction. ACCOUNTANT has create-parity with
    // ADMIN for salaries (business doc finance.md: «ACCOUNTANT — …, выплаты»).
    // task-salary-no-admin-receiver (security-MED #222): ADMIN cannot receive
    // SALARY — their income comes via admin shares (ADMIN_INCOME / PAYOUT). The
    // allow-list covers every salaried role: JUNIOR, HR, ACCOUNTANT (salaried
    // employees), SENIOR and DROP (project-based contractors who may also
    // receive a flat salary). Self-pay for ACCOUNTANT remains allowed.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT')
      throw new ForbiddenException()

    if (!data.idempotencyKey) {
      throw new BadRequestException('idempotencyKey is required for manual salary creation')
    }

    const creationIntent = buildSalaryCreationIntent(data)

    // One key represents one manual salary-part intent. The public schema
    // requires it, and the DB CHECK below rejects any MANUAL SALARY write that
    // bypasses the controller without one. This read handles sequential replay;
    // the partial unique index closes the concurrent race.
    const replay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'SALARY'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (replay) {
      // SR-795-L-2: the key may belong to a part that has since been deleted.
      // Answering 200 with its id names a row every read path hides.
      assertSalaryReplayTargetLive(replay)
      // SR-795-M-2 (PR #868): a replay is honoured only for the same request.
      assertSalaryCreationIntent(replay, creationIntent)
      return { id: replay.id }
    }

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    // Defense-in-depth: explicit ADMIN barrier first (security-MED #222).
    // SALARY_ELIGIBLE_ROLES allow-list check follows as the general gate.
    if (receiver.role === 'ADMIN') {
      throw apiError('FINANCE_ADMIN_NO_SALARY', HttpStatus.BAD_REQUEST)
    }
    if (!(SALARY_ELIGIBLE_ROLES as ReadonlyArray<string>).includes(receiver.role)) {
      throw apiError('FINANCE_SALARY_ROLE_NOT_ELIGIBLE', HttpStatus.BAD_REQUEST)
    }
    // task-finance-fix-wave1 (E-1). Why a salary refuses an archived receiver,
    // and how to decide whether the next money path should:
    //
    //   The question is whether the write CREATES an entitlement that has not
    //   been EARNED yet, or merely RECORDS one that already has been. A monthly
    //   salary is the first kind — it accrues against a period of employment,
    //   and a dismissed person will not work it. Refuse.
    //
    //   Writes that record something ALREADY earned must NOT grow this barrier,
    //   even when they insert brand-new rows addressed to a person by name. The
    //   live counter-example is `bookCompanyObligations` (~:4370, the shared
    //   engine under payPayoutRequest / manualConfirmPayout): it inserts NEW
    //   SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT rows whose `receiverId` IS
    //   the senior or the drop — and that is their share of income the company
    //   has already received. Refusing there would strand money that is owed.
    //   Dismissal stops future accrual; it forfeits nothing already earned.
    //
    //   And where does PAYING a salary fall? On neither side cleanly — saying so
    //   is the point. A PENDING salary row is a reminder, not a debit (see the
    //   next comment down: no funding source, no balance impact until
    //   `paySalary`), so one such row can mean two different things: a month the
    //   person really worked before being dismissed — earned, owed — or a month
    //   the cron minted AFTER the dismissal for work nobody did, which is the
    //   defect this task fixed. The row carries nothing that tells those apart.
    //   `paySalary` therefore refuses on the same barrier, and NOT as a deduction
    //   from the rule above: it is a deliberate stop-loss on an irreversible
    //   outward payment. Refusing costs nothing unrecoverable — the row stays
    //   PENDING and becomes payable the moment an ADMIN un-archives someone
    //   dismissed by mistake — while a wrong payment cannot be un-paid. The
    //   deeper question this exposes (the barrier reads the receiver's CURRENT
    //   state, not the period being paid for, so un-archiving makes every
    //   accumulated month payable at once) is with the owner as review-round-2
    //   MED-2, and is deliberately NOT settled in code here.
    //
    // Two corrections' worth of history, kept because it is cheaper than
    // repeating them. Round 2: this comment named `manualConfirmPayout` as the
    // precedent — it is not one, it never reads receiver archival. Round 3: the
    // replacement said "new accrual to a NAMED person → refuse", which reads
    // like an executable test and, applied literally, catches exactly the
    // `bookCompanyObligations` rows above. The paths that do refuse are
    // createAdminIncome / declareUsdtProjectIncome / confirmPayout, and their
    // reason is adjacent rather than identical: a booking needs an ACTIVE ADMIN
    // as its party. So decide with the entitlement question above — do not
    // pattern-match against this list, and do not treat either sentence as a
    // predicate you can evaluate mechanically.
    if (receiver.archivedAt) {
      throw apiError('FINANCE_SALARY_RECEIVER_ARCHIVED', HttpStatus.BAD_REQUEST)
    }

    // task-salary-pay-flow: a manually-created salary is a NEUTRAL PENDING
    // reminder — it does NOT pick a funding source, does NOT touch the company
    // balance, and is NOT a debit. The funding source (company account vs admin
    // personal) and the actual payment currency are decided LATER, at pay time
    // (paySalary). senderId/fundingSource stay null until then; the currency is
    // the nominal of the reminder (default USD). No advisory lock / balance gate.
    const currency: 'USDT' | 'USD' | 'EUR' | 'UAH' = (data.currency ?? 'USD') as
      'USDT' | 'USD' | 'EUR' | 'UAH'

    // A SALARY transaction is one concrete salary part. Operators may record
    // several parts for the same employee/month; the AUTOMATIC monthly
    // component is the one that is idempotent, and `salary_month_initializations`
    // is what makes it so.
    //
    // SR-795-M-1 / owner decision D-3: claiming that marker is no longer the
    // cron's exclusive business. The first part recorded for a receiver/month
    // claims it, whoever records it — so when an operator enters the month's
    // salary by hand (a newly configured employee, or any month the cron has not
    // reached), the cron on the 1st and the Backfill button both see the month
    // as accounted for and skip it. Before this, both minted a SECOND payable
    // salary for the same person and month, with nothing in the UI or the API
    // mentioning the first one; manual QA measured it on a real stack.
    //
    // Claimed for EVERY receiver, not only the cron-eligible ones. Re-deriving
    // "is this receiver cron-eligible" here would be a third copy of the
    // predicate the gap resolver and the cron closure already share (the defect
    // CR-795-M-7 is about), and for a receiver the cron never visits — SENIOR,
    // DROP — the marker is simply a row nothing reads.
    //
    // Note what claiming does NOT do: a later DELETE of this part does not
    // release the marker, so the month stays accounted for and nobody is paid
    // for it until a replacement part is recorded. That is the same rule
    // already in force for an automatic row (see `createMonthlySalaries` and
    // the month-edit evidence query, both of which count soft-deleted rows on
    // purpose): deleting a salary is an audit event, not permission for cron to
    // resurrect it. Releasing on delete for MANUAL parts only would make the
    // two origins follow opposite rules on one table and reopen a narrower form
    // of the double payment this task fixes. Owner-ratified on PR #1102
    // (SPEC-L-1) rather than assumed — it is a money path, and the cost of
    // being wrong is a month nobody is paid for.
    //
    // The rule is "a delete is not a release", NOT "the marker is never
    // released": `admin-edit.service` DOES release it on a salary-month change,
    // and only when no remaining row still accounts for the old month
    // (`oldMonthEvidence`). That release is bookkeeping for a month that
    // genuinely no longer has a part — the opposite situation from a delete,
    // where the part's absence is itself the audit record.
    //
    // Both writes share ONE transaction: a claimed marker with no salary row
    // behind it would suppress the month's automatic accrual for nothing.
    let tx: typeof transactions.$inferSelect
    try {
      tx = await this.db.db.transaction(async (dbtx) => {
        await dbtx
          .insert(salaryMonthInitializations)
          .values({
            receiverId: data.receiverId,
            salaryMonth: data.salaryMonth,
            // Mirrors adminDeleteTransaction / createMonthlySalaries: under
            // impersonation the REAL operator is recorded, never the target.
            initializedBy: currentUser.impersonatorId ?? currentUser.id,
          })
          .onConflictDoNothing({
            target: [salaryMonthInitializations.receiverId, salaryMonthInitializations.salaryMonth],
          })
          .returning({ id: salaryMonthInitializations.id })

        // An already-claimed month is the normal multipart case (cron ran, or
        // this is the second part): nothing to do, the part is still recorded.
        const [created] = await dbtx
          .insert(transactions)
          .values({
            type: 'SALARY' as const,
            status: 'PENDING' as const,
            amount: String(data.amount),
            currency,
            senderId: null,
            senderLabel: 'CheekyCheeseIT',
            receiverId: data.receiverId,
            salaryMonth: data.salaryMonth,
            salaryOrigin: 'MANUAL',
            salaryCreationIntent: creationIntent,
            idempotencyKey: data.idempotencyKey,
            notes: data.notes ?? null,
            fundingSource: null,
            txDate: resolveTransactionDate(data.txDate),
            createdBy: currentUser.id,
          })
          .returning()
        return created!
      })
    } catch (err) {
      if (uniqueViolationConstraint(err) === 'uq_transactions_salary_idempotency_key') {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'SALARY'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) {
          // SR-795-L-2 — same reasoning as the pre-insert lookup above.
          assertSalaryReplayTargetLive(committed)
          assertSalaryCreationIntent(committed, creationIntent)
          return { id: committed.id }
        }
      }
      throw err
    }

    await this.lifecycle.afterTransactionCreated(tx.id, tx, currentUser)
    return { id: tx.id }
  }

  // ── Create ADMIN_TRANSFER ─────────────────────────────────────────────────

  async createAdminTransfer(
    data: {
      senderId?: string | undefined
      receiverId: string
      amount: number
      currency?: string | undefined
      // task-receipts-backend (#8): receipt MANDATORY, currency-aware (default
      // USDT → explorer-only). Zod enforces at the boundary; re-checked below.
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    // task-accountant-create-transaction. ACCOUNTANT has create-parity with
    // ADMIN for partner transfers. BOTH transfer parties must be ADMIN — the
    // accountant is NEVER a party. So:
    //   - ADMIN caller: sender defaults to self (as before).
    //   - ACCOUNTANT caller: senderId is REQUIRED and must resolve to an ADMIN
    //     (no implicit self-as-sender, which would book a non-ADMIN sender).
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT')
      throw new ForbiddenException()

    const isAdminCaller = currentUser.role === 'ADMIN'

    if (!isAdminCaller && !data.senderId) {
      throw apiError('FINANCE_TRANSFER_SENDER_ID_REQUIRED', HttpStatus.BAD_REQUEST)
    }

    // BIZ-06: ADMIN callers ALWAYS send from themselves — they cannot debit a
    // partner by supplying senderId=partnerB.id. Only ACCOUNTANT recorders may
    // specify an explicit senderId (to book a transfer that already happened
    // between two admin partners). Ignoring the supplied senderId for ADMIN
    // callers is intentional and matches the "ADMIN transfers from self" contract.
    const effectiveSenderId = isAdminCaller ? currentUser.id : (data.senderId ?? currentUser.id)

    // Validate the sender is an ADMIN for ACCOUNTANT-caller bookings (effectiveSenderId
    // is always currentUser.id for ADMIN callers, so no round-trip needed there).
    if (!isAdminCaller) {
      const sender = await this.db.db.query.users.findFirst({
        where: eq(users.id, effectiveSenderId),
      })
      if (!sender || sender.role !== 'ADMIN')
        throw apiError('FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
    }

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (receiver.role !== 'ADMIN')
      throw apiError('FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
    // task-sender-receiver-invariant (backlog A-2): friendly 400 BEFORE the
    // DB CHECK (ck_transactions_sender_ne_receiver) would reject the insert
    // below with an opaque constraint-violation error. Shared with every
    // other write path via `selfPayError` — one rule, not five copies.
    // fix-round 2 (COPY-M-12): no third argument — the default coded message
    // (`SENDER_RECEIVER_SAME`, translated through `zodErrorBadRequest` below)
    // replaces the literal `'Cannot transfer to yourself'` this call used to
    // pass, so this refusal reads the SAME sentence in the SAME language as
    // every other self-pay check, instead of an untranslated English literal.
    const transferSelfPayErr = selfPayError(effectiveSenderId, receiver.id)
    if (transferSelfPayErr) throw zodErrorBadRequest(transferSelfPayErr)
    // task-archived-user-completeness (AC3). RECEIVER only — the asymmetry is
    // the whole point. In the HOLDING model an ADMIN_TRANSFER credits the
    // receiver (`received` in getSummary), i.e. it puts more company money into
    // that partner's hands. Doing that to a departed partner is a NEW
    // placement, not the settlement of anything. The SENDER side is the mirror
    // image and is deliberately left unguarded: an archived admin transferring
    // out is a departed partner handing back what they still hold, which is
    // exactly the settlement half this task must not break.
    //
    // Unreachable today for the same four reasons spelled out on the dividend
    // path (`CompanyAccountService.createDividend`) — an archived ADMIN cannot
    // be produced through the API. Kept as a lock on a door that does not
    // exist yet, not as dead code.
    //
    // Read the dividend path's comment before relaxing this one: an ADMIN
    // partner has NO `pending_obligations` row (that table's only writer
    // stamps a senior or a drop, never an admin), so their accumulated share
    // exists solely as a derived HOLDING balance. With this guard the archived
    // RECEIVER side is closed on every admin-crediting path at once — fine
    // while archived admins cannot exist, and a thing a "deactivate partner"
    // feature has to solve with a settlement path rather than by deleting
    // these lines.
    if (receiver.archivedAt) {
      throw apiError('FINANCE_TRANSFER_RECEIVER_ARCHIVED', HttpStatus.BAD_REQUEST)
    }

    // task-receipts-backend (#8): mandatory receipt, currency-aware (default
    // USDT → explorer-only). Defense-in-depth over Zod; validate the doc binding
    // for a non-USDT file receipt.
    const transferCurrency = data.currency ?? 'USDT'
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      transferCurrency,
    )
    if (receiptErr) throw zodErrorBadRequest(receiptErr)
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
    }

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'ADMIN_TRANSFER',
        status: 'PAID',
        amount: String(data.amount),
        currency: transferCurrency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: effectiveSenderId,
        receiverId: data.receiverId,
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        notes: data.notes ?? null,
        txDate: resolveTransactionDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    await this.lifecycle.afterTransactionCreated(tx!.id, tx!, currentUser)
    return { id: tx!.id }
  }
}
