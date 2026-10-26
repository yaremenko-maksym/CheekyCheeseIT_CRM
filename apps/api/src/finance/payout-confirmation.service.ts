import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { selfPayError } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import { payoutRequests, transactionAuditLog, transactions, users } from '../database/schema'
import { TransactionLifecycleService } from './transaction-lifecycle.service'
import { backdateAuditRow } from './transaction-date-audit.util'
import { resolveTransactionDateWithPolicy } from './transaction-date-policy'
import { formatTransactionBusinessDate, sourceBusinessDay } from './transaction-date.util'
import { assertTransactionWritable } from './transaction-visibility.util'

/**
 * ACCOUNTANT/ADMIN review of income rows and manual payout confirmation:
 * `validateTransaction` (validate / reject a PENDING SENIOR_INCOME or DROP_INCOME)
 * and `confirmPayout` (flip a PENDING_PAYMENT PAYOUT to PAID and credit the chosen
 * admin with a PAYOUT_CONFIRMED row). Depends on the database and the lifecycle
 * (status-change notification) collaborator; never on TransactionsService. The
 * viewer-scoped read-back stays on the facade: `validateTransaction` resolves
 * once the write committed, and `confirmPayout` receives the facade's `readBack`
 * and returns whatever it produced for the PAYOUT and the new credit row.
 */
@Injectable()
export class PayoutConfirmationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly lifecycle: TransactionLifecycleService,
  ) {}

  async validateTransaction(
    id: string,
    action: 'validate' | 'reject',
    rejectionReason: string | null | undefined,
    currentUser: SessionUser,
  ): Promise<void> {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    assertTransactionWritable(tx, currentUser)
    // Drop role - phase 2: validate also handles DROP_INCOME with the same
    // shape — flip to VALIDATED + create payout_request + insert placeholder
    // PAYOUT row. The drop-specific distribution math lives in
    // `payPayoutRequest` (drop branch) — at validate time we only book a
    // payable that represents what the wallet owner will transfer off-platform
    // (= income * (1 - share/100), using dropSharePercent for DROP_INCOME).
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'DROP_INCOME') {
      throw apiError('FINANCE_VALIDATE_WRONG_TYPE', HttpStatus.BAD_REQUEST)
    }
    // AC4: idempotency. The action is only valid on PENDING rows — a second
    // click after a successful validate would otherwise create a duplicate
    // PAYOUT row. We throw rather than silently no-op so the UI can show
    // a clear error to the ACCOUNTANT (vs. pretending it worked twice).
    if (tx.status !== 'PENDING')
      throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)

    // task-soft-delete-and-money-audit (AC5): "проверка и отклонение" —
    // written INSIDE the same transaction as the status flip so a
    // validate/reject can never happen without its journal entry.
    const effectiveActorId = currentUser.impersonatorId ?? currentUser.id

    if (action === 'validate') {
      // task-drop-payout-company-account: SENIOR_INCOME and DROP_INCOME now share
      // the SAME validate semantics — validate ONLY flips status to VALIDATED. No
      // payout_request and no PAYOUT row are created here. The recipient (SENIOR
      // or DROP) later bundles their VALIDATED incomes into a single payout via
      // POST /api/payout-requests (createPayoutRequest). Previously DROP_INCOME
      // auto-created a payout_request + placeholder PAYOUT at validate time (a
      // legacy of the removed payment-channel flow) — that diverged from the
      // senior path and could double-book a payout against the same income. Both
      // paths are now identical, removing that drift.
      const now = new Date()
      await this.db.db.transaction(async (dbtx) => {
        // security-review PR #456 (MED-1): re-assert deleted_at IS NULL inside
        // the write + check the affected row count (delete↔validate TOCTOU).
        // MED-2: `validatedBy` stamps the REAL operator (effectiveActorId),
        // never the impersonated target — consistent with the audit-log row
        // written right below for the same action.
        const updated = await dbtx
          .update(transactions)
          .set({
            status: 'VALIDATED',
            validatedBy: effectiveActorId,
            validatedAt: now,
            updatedAt: now,
          })
          .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          throw apiError('FINANCE_TRANSACTION_DELETED_RESTORE_FIRST', HttpStatus.BAD_REQUEST)
        }

        await dbtx.insert(transactionAuditLog).values({
          actorId: effectiveActorId,
          targetId: id,
          action: 'VALIDATE',
          metadata: { type: tx.type, amount: tx.amount, currency: tx.currency },
        })
      })

      // task-salary-company-account: junior salaries no longer depend on
      // validated senior/drop income (LOCKED removed) — nothing to unlock here.

      // Позиция 6: получатель дохода ЖДЁТ этого перехода. После коммита —
      // строка уже проверена, и уведомление не может опередить факт.
      await this.lifecycle.notifyTransactionStatusChanged(id, 'VALIDATED', null, currentUser)
    } else {
      if (!rejectionReason)
        throw apiError('FINANCE_REJECTION_REASON_REQUIRED', HttpStatus.BAD_REQUEST)
      await this.db.db.transaction(async (dbtx) => {
        // security-review PR #456 (MED-1 / MED-2): same pair of fixes as the
        // validate branch above.
        const updated = await dbtx
          .update(transactions)
          .set({
            status: 'REJECTED',
            validatedBy: effectiveActorId,
            validatedAt: new Date(),
            rejectionReason,
            updatedAt: new Date(),
          })
          .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          throw apiError('FINANCE_TRANSACTION_DELETED_RESTORE_FIRST', HttpStatus.BAD_REQUEST)
        }

        await dbtx.insert(transactionAuditLog).values({
          actorId: effectiveActorId,
          targetId: id,
          action: 'REJECT',
          metadata: {
            type: tx.type,
            amount: tx.amount,
            currency: tx.currency,
            rejectionReason,
          },
        })
      })

      // Позиция 6: отказ без причины сотруднику бесполезен, а узнать её иначе
      // неоткуда — причина едет в данных записи, а не в её заголовке.
      await this.lifecycle.notifyTransactionStatusChanged(
        id,
        'REJECTED',
        rejectionReason,
        currentUser,
      )
    }
  }

  // ── Manual payout confirmation (Drop role - phase 3, spec §8.4) ──────────
  //
  // ACCOUNTANT/ADMIN confirms a previously created PAYOUT actually landed on a
  // specific admin partner (Maksym/Kostya) off-platform. This is a **safety
  // net** on top of the auto 50/50 PAYOUT_ADMIN split that `payPayoutRequest`
  // emits — both flows live in parallel; phase 2 distribution math is NOT
  // touched here.
  //
  // Effects (single DB transaction):
  //   1) The PAYOUT row flips PENDING_PAYMENT → PAID. `validatedBy` +
  //      `validatedAt` are set on the PAYOUT row so the audit trail mirrors
  //      SENIOR_INCOME validation semantics.
  //   2) A fresh PAYOUT_CONFIRMED row is inserted in PAID:
  //      - `receiverId` + `recipientId` = chosen ADMIN (recipientId mirrors
  //        the phase-2 PAYOUT_DROP pattern for explicit "money landed here"
  //        attribution).
  //      - `amount` / `currency` / `projectId` mirror the PAYOUT row.
  //      - `senderId` = `PAYOUT.senderId` so the chain "senior/drop pays →
  //        admin receives" stays traceable.
  //      - `payoutRequestId` is copied so reporting can group the auto-split
  //        rows with this manual confirmation under one umbrella.
  //      - `notes` records who confirmed + when, for the audit trail.
  //
  // Validation:
  //   - RBAC: ADMIN + ACCOUNTANT only. Anyone else → 403.
  //   - PAYOUT row must exist, type = PAYOUT, status = PENDING_PAYMENT.
  //   - `recipientAdminId` must exist, role = ADMIN, NOT archived.
  //
  // Idempotency:
  //   - A second click on an already-PAID PAYOUT throws 400 («Already
  //     confirmed»). This is enforced by the status check on the PAYOUT row —
  //     once it's PAID the predicate fails before any insert runs, so we can
  //     never double-credit an admin.
  async confirmPayout<T>(
    payoutTxId: string,
    recipientAdminId: string,
    currentUser: SessionUser,
    options: {
      method?: 'CRYPTO' | 'CASH'
      txHash?: string | null
      txDate?: string | null
      // SR-809-H-1 / D-2: travels with txDate. ADMIN/ACCOUNTANT (the only roles
      // this method admits) may exceed the backdating window with a stated
      // reason, which is recorded on the audit trail below.
      backdateReason?: string | null
    } = {},
    readBack: (id: string) => Promise<T>,
  ): Promise<{ payout: T; confirmed: T | null }> {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    // Drop role - phase 4 refactor (task-drop-phase4-refactor-remove-tov.md
    // AC4). PAYOUT_CONFIRMED rows now carry an explicit payment method:
    // CRYPTO (default — txHash required) or CASH (no on-chain hash). Cash
    // path covers manual confirmations where the senior settled with the
    // partner via fiat / hand-off; crypto path keeps the legacy contract.
    const method = options.method ?? 'CRYPTO'
    const txHashRaw = options.txHash?.trim() ?? ''
    if (method === 'CRYPTO' && txHashRaw.length < 10) {
      throw apiError('FINANCE_CRYPTO_TX_HASH_TOO_SHORT', HttpStatus.BAD_REQUEST)
    }
    const recordedTxHash = method === 'CRYPTO' ? txHashRaw : null

    const payoutTx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, payoutTxId),
    })
    if (!payoutTx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (payoutTx.type !== 'PAYOUT') {
      throw apiError('FINANCE_CONFIRM_PAYOUT_ONLY', HttpStatus.BAD_REQUEST)
    }
    // Idempotency guard. Once PAYOUT has flipped to PAID a second confirm
    // would either no-op or duplicate the PAYOUT_CONFIRMED row depending on
    // which side races; throw early so the UI can show «уже подтверждено».
    if (payoutTx.status !== 'PENDING_PAYMENT') {
      throw apiError('FINANCE_PAYOUT_NOT_PENDING_PAYMENT', HttpStatus.BAD_REQUEST)
    }
    // SR-809-M-1 (PR #868): resolve once so validation and persistence use
    // the same instant. Omitting the date means "now", and that effective
    // date is still subject to the source lower bound.
    const now = new Date()
    // SR-809-H-1 / owner decision D-2: the chosen date also passes the shared
    // server-side policy. EXECUTED — a confirmation records a payment that has
    // already happened, so it is never dated ahead of today.
    const dateDecision = resolveTransactionDateWithPolicy(options.txDate, {
      role: currentUser.role,
      flow: 'EXECUTED',
      backdateReason: options.backdateReason,
      now,
    })
    const confirmationTxDate = dateDecision.txDate
    // Backlog 338: a NULL-txDate PAYOUT floors on the KYIV day of createdAt.
    const payoutSourceDate = sourceBusinessDay(payoutTx)
    if (formatTransactionBusinessDate(confirmationTxDate) < payoutSourceDate) {
      throw apiError('FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION', HttpStatus.BAD_REQUEST)
    }

    const recipient = await this.db.db.query.users.findFirst({
      where: eq(users.id, recipientAdminId),
    })
    if (!recipient) throw apiError('FINANCE_RECIPIENT_ADMIN_NOT_FOUND', HttpStatus.BAD_REQUEST)
    if (recipient.role !== 'ADMIN') {
      throw apiError('FINANCE_RECIPIENT_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
    }
    if (recipient.archivedAt) {
      throw apiError('FINANCE_RECIPIENT_ADMIN_ARCHIVED', HttpStatus.BAD_REQUEST)
    }
    // task-sender-receiver-invariant (backlog A-2): defense-in-depth. Not
    // reachable today — `payoutTx.senderId` is the SENIOR/DROP who requested
    // the payout and `recipient` must resolve to an ADMIN, two structurally
    // different roles that can never share an id — but the PAYOUT_CONFIRMED
    // insert below copies `payoutTx.senderId` verbatim, so a future change to
    // either invariant would otherwise surface as an opaque DB CHECK error
    // instead of this clean 400.
    const confirmSelfPayErr = selfPayError(payoutTx.senderId, recipient.id)
    if (confirmSelfPayErr) throw zodErrorBadRequest(confirmSelfPayErr)

    // security-review PR #456 round 2 (MED-3): under impersonation, attribute
    // `validatedBy` (and the note) to the REAL admin/accountant operator, never
    // the impersonated target — same rule `adminDeleteTransaction` and
    // `validateTransaction` already apply to their own `*By` columns. This was
    // the second of the two raw-`currentUser.id` sites the review found
    // (pending-settlement.service.ts's `settleByCompany` was the first).
    const effectiveActorId = currentUser.impersonatorId ?? currentUser.id

    const confirmationNote = `Manual payout confirmation by ${effectiveActorId} at ${now.toISOString()} (method=${method})`

    await this.db.db.transaction(async (dbtx) => {
      // BIZ-02 (HIGH): atomic claim — flip PAYOUT→PAID ONLY when the row is
      // still PENDING_PAYMENT (conditional UPDATE with WHERE status predicate).
      // The UPDATE takes a row-level lock and re-evaluates the predicate
      // against the committed row, so exactly ONE concurrent caller wins.
      // If zero rows are returned the row was already claimed by a concurrent
      // winner → throw before any INSERT runs, preventing a double credit.
      const claimed = await dbtx
        .update(transactions)
        .set({
          status: 'PAID',
          validatedBy: effectiveActorId,
          validatedAt: now,
          txDate: confirmationTxDate,
          updatedAt: now,
          ...(recordedTxHash ? { txHash: recordedTxHash } : {}),
        })
        .where(and(eq(transactions.id, payoutTxId), eq(transactions.status, 'PENDING_PAYMENT')))
        .returning({ id: transactions.id })

      if (claimed.length === 0) {
        // The row was already confirmed by a concurrent call — bail out before
        // inserting a PAYOUT_CONFIRMED so no double credit occurs.
        throw apiError('FINANCE_PAYOUT_NOT_PENDING_PAYMENT', HttpStatus.BAD_REQUEST)
      }

      // SR-809-L-3 / D-2: an out-of-window backdate carries its justification on
      // the audit trail, written after the claim succeeded so a losing concurrent
      // caller records nothing, and inside this transaction so the reason cannot
      // commit without the date it justifies.
      if (dateDecision.backdateReason) {
        await dbtx.insert(transactionAuditLog).values(
          backdateAuditRow({
            targetId: payoutTxId,
            actor: currentUser,
            txDate: confirmationTxDate,
            backdateReason: dateDecision.backdateReason,
          }),
        )
      }

      // BIZ-02 cross-path (HIGH): when this PAYOUT is linked to a payout_request,
      // flip the request's status PENDING→PAID atomically in the SAME transaction.
      // This closes the race with `payPayoutRequest` which gates on
      // `payout_requests.status === 'PENDING'` before calling `applyPayoutPaidCascade`.
      // Without this flip, `payPayoutRequest` can still pass its gate AFTER
      // `confirmPayout` has committed, producing a second credit.
      //
      // 0 rows returned = payout_request already PAID (race with payPayoutRequest) —
      // still valid here because the PAYOUT row was already claimed above (the
      // primary race guard). We just ensure the request is also marked PAID.
      if (payoutTx.payoutRequestId) {
        await dbtx
          .update(payoutRequests)
          .set({ status: 'PAID', updatedAt: now })
          .where(
            and(
              eq(payoutRequests.id, payoutTx.payoutRequestId),
              eq(payoutRequests.status, 'PENDING'),
            ),
          )
          .returning({ id: payoutRequests.id })
      }

      // 2) Insert the PAYOUT_CONFIRMED row crediting the chosen admin. The
      //    inputs (amount/currency/projectId/payoutRequestId) snapshot the
      //    PAYOUT row so a later edit to PAYOUT (out of scope here — PAYOUT
      //    is non-editable per `adminUpdateTransaction`) wouldn't desync the
      //    credit row. senderId mirrors PAYOUT.senderId for traceability.
      //    The payment method is captured via senderLabel marker so existing
      //    schema columns are reused (no schema change needed). Cash method
      //    keeps txHash null per AC4; crypto records the on-chain hash.
      await dbtx.insert(transactions).values({
        type: 'PAYOUT_CONFIRMED',
        status: 'PAID',
        amount: payoutTx.amount,
        currency: payoutTx.currency,
        senderId: payoutTx.senderId,
        senderLabel: `PAYOUT_METHOD:${method}`,
        receiverId: recipient.id,
        recipientId: recipient.id,
        projectId: payoutTx.projectId,
        payoutRequestId: payoutTx.payoutRequestId,
        txHash: recordedTxHash,
        notes: confirmationNote,
        txDate: confirmationTxDate,
        createdBy: currentUser.id,
      })
    })

    // Return both rows so the UI can update the table in a single round-trip:
    // the now-PAID PAYOUT and the freshly created credit row.
    const updatedPayout = await readBack(payoutTxId)
    // Build the WHERE predicate conditionally: payoutRequestId is nullable, and
    // passing '' (empty string) for a UUID column causes Postgres to throw
    // "invalid input syntax for type uuid". Filter on it only when present.
    const confirmedRowWhere = payoutTx.payoutRequestId
      ? and(
          eq(transactions.type, 'PAYOUT_CONFIRMED'),
          eq(transactions.payoutRequestId, payoutTx.payoutRequestId),
          eq(transactions.receiverId, recipient.id),
          eq(transactions.notes, confirmationNote),
        )
      : and(
          eq(transactions.type, 'PAYOUT_CONFIRMED'),
          eq(transactions.receiverId, recipient.id),
          eq(transactions.notes, confirmationNote),
        )
    const confirmedRow = await this.db.db.query.transactions.findFirst({
      where: confirmedRowWhere,
      orderBy: [desc(transactions.createdAt)],
    })
    const confirmed = confirmedRow ? await readBack(confirmedRow.id) : null

    return { payout: updatedPayout, confirmed }
  }
}
