import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { SessionUser, TransactionAuditLogEntryDto } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { pendingObligations, transactionAuditLog, transactions, users } from '../database/schema'
import { assertTransactionVisible } from './transaction-visibility.util'

/**
 * Soft-delete, restore and audit-log read for money transactions. Depends on
 * the database only and never on TransactionsService: the restore read-back
 * (`findOne`) stays on the TransactionsService facade.
 */
@Injectable()
export class TransactionTrashService {
  constructor(private readonly db: DatabaseService) {}

  // ── Admin Delete (soft) ───────────────────────────────────────────────────
  //
  // task-soft-delete-and-money-audit (security-audit finding 3, 27.07). Was a
  // hard `DELETE FROM transactions` — a mistaken or bad-faith delete was
  // unrecoverable AND unprovable in a system that computes shares/payouts/
  // salaries off this ledger. Now marks the row instead (`deletedAt` /
  // `deletedBy` / `deletionReason`); the row is never physically removed.
  //
  // Visibility (owner requirement, 27.07): only ADMIN/ACCOUNTANT can ever see
  // a deleted row again, and even they don't by default — see the
  // `includeDeleted` toggle on `findAll`. Every other role gets a 404 (never
  // 403) both in the list and on a direct `GET /transactions/:id` fetch —
  // `assertTransactionReadAccess`/`findOne` enforce that so a 403 can never leak that a
  // deleted row exists.
  //
  // Balances/summaries: every aggregate read in this service and in
  // `balance.service.ts` / `company-account-balance.ts` now filters
  // `deletedAt IS NULL` — a soft-deleted row is excluded from every
  // computation exactly as a hard-deleted row would have been.

  async adminDeleteTransaction(id: string, reason: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    // Denial-money-operation: the reason is mandatory (owner requirement —
    // "через полгода «почему это удалили» без причины не восстановить").
    // Re-checked here (defense-in-depth) even though `deleteTransactionSchema`
    // already enforces `min(3)` at the controller boundary.
    const trimmedReason = reason.trim()
    if (trimmedReason.length === 0) {
      throw apiError('FINANCE_TRANSACTION_DELETE_REASON_REQUIRED', HttpStatus.BAD_REQUEST)
    }

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (tx.deletedAt) {
      throw apiError('FINANCE_TRANSACTION_ALREADY_DELETED', HttpStatus.BAD_REQUEST)
    }
    // Drop role - phase 3: PAYOUT_CONFIRMED is also non-deletable for the same
    // audit-trail reason as PAYOUT/PAYOUT_ADMIN.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw apiError('FINANCE_DELETE_PAYOUT_FORBIDDEN', HttpStatus.BAD_REQUEST)
    }
    if (tx.payoutRequestId) {
      throw apiError('FINANCE_DELETE_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN', HttpStatus.BAD_REQUEST)
    }

    // security-review pattern (mirrors releaseOnChainHash): under
    // impersonation, attribute the journal entry to the REAL admin operator,
    // never the impersonated target — see sessionUserSchema.impersonatorId's
    // doc.
    const effectiveActorId = currentUser.impersonatorId ?? currentUser.id

    await this.db.db.transaction(async (dbtx) => {
      // task-soft-delete-and-money-audit: replicate the protection the OLD
      // hard-delete got for free from `pending_obligations
      // .source_transaction_id`'s `ON DELETE RESTRICT` — hard-deleting an IOU
      // placeholder row (SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT) that any
      // obligation (open OR already closed) still references as its source
      // used to fail loudly at the DB (23503). Soft-delete never touches that
      // FK, so without this explicit check the protection would silently
      // disappear — `settleByCompany` could later try to settle an obligation
      // whose source row no longer "exists" from every reader's point of view.
      //
      // security-review PR #456 (MED-1): re-run INSIDE the transaction,
      // immediately before the UPDATE — a version read BEFORE the transaction
      // opened leaves a window where a concurrent request books a fresh
      // obligation against this row between the check and the delete. This
      // does not close the window to zero (READ COMMITTED, no row lock on
      // `pending_obligations`), but collapses it from "the whole method body"
      // to one DB round trip.
      const referencingObligation = await dbtx.query.pendingObligations.findFirst({
        where: eq(pendingObligations.sourceTransactionId, id),
      })
      if (referencingObligation) {
        throw apiError('FINANCE_DELETE_SOURCE_OF_OBLIGATION_FORBIDDEN', HttpStatus.BAD_REQUEST)
      }

      // security-review PR #456 (MED-1, delete↔delete TOCTOU): re-assert
      // `deleted_at IS NULL` in the UPDATE itself and check the affected row
      // count — a concurrent delete cannot double-fire the journal entry.
      const updated = await dbtx
        .update(transactions)
        .set({
          deletedAt: new Date(),
          deletedBy: effectiveActorId,
          deletionReason: trimmedReason,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
        .returning({ id: transactions.id })
      if (updated.length === 0) {
        throw apiError('FINANCE_TRANSACTION_ALREADY_DELETED', HttpStatus.BAD_REQUEST)
      }

      // Journal INSIDE the same transaction — a delete without its record
      // must be impossible.
      await dbtx.insert(transactionAuditLog).values({
        actorId: effectiveActorId,
        targetId: id,
        action: 'DELETE',
        metadata: {
          reason: trimmedReason,
          type: tx.type,
          amount: tx.amount,
          currency: tx.currency,
        },
      })
    })

    return { deleted: true }
  }

  // ── Admin Restore ─────────────────────────────────────────────────────────
  //
  // task-soft-delete-and-money-audit. Reverses `adminDeleteTransaction` —
  // ADMIN only (ACCOUNTANT can SEE a deleted row via the `includeDeleted`
  // list toggle / a direct `findOne`, but cannot restore it). Reason is
  // mandatory for the same audit-trail reason as delete.

  async restoreTransactionRow(id: string, reason: string, currentUser: SessionUser): Promise<void> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const trimmedReason = reason.trim()
    if (trimmedReason.length === 0) {
      throw apiError('FINANCE_TRANSACTION_RESTORE_REASON_REQUIRED', HttpStatus.BAD_REQUEST)
    }

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (!tx.deletedAt) {
      throw apiError('FINANCE_TRANSACTION_NOT_DELETED', HttpStatus.BAD_REQUEST)
    }

    const effectiveActorId = currentUser.impersonatorId ?? currentUser.id

    await this.db.db.transaction(async (dbtx) => {
      // security-review PR #456 (MED-1, restore↔restore TOCTOU): symmetric to
      // adminDeleteTransaction — re-assert `deleted_at IS NOT NULL` in the
      // UPDATE and check the affected row count so a concurrent restore
      // cannot double-fire the journal entry.
      const updated = await dbtx
        .update(transactions)
        .set({
          deletedAt: null,
          deletedBy: null,
          deletionReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.id, id), isNotNull(transactions.deletedAt)))
        .returning({ id: transactions.id })
      if (updated.length === 0) {
        throw apiError('FINANCE_TRANSACTION_NOT_DELETED', HttpStatus.BAD_REQUEST)
      }

      // Journal INSIDE the same transaction — a restore without its record
      // must be impossible, mirroring the delete side above.
      await dbtx.insert(transactionAuditLog).values({
        actorId: effectiveActorId,
        targetId: id,
        action: 'RESTORE',
        metadata: {
          reason: trimmedReason,
          previousDeletionReason: tx.deletionReason,
        },
      })
    })
  }

  // ── Audit log (read) ──────────────────────────────────────────────────────
  //
  // security-review PR #456 (MED-3): `transaction_audit_log` was write-only —
  // every DELETE/RESTORE/VALIDATE/REJECT/CREATE/AMOUNT_OR_RECEIVER_CHANGE/
  // ATTACH/REPLACE/ONCHAIN_* entry landed in the table, but nothing in the API
  // ever read it back. "Мы пишем то, что нельзя посмотреть." ADMIN-only (the
  // journal can name any user in the system as `actorId`, including under
  // impersonation — not a surface for ACCOUNTANT). A full audit-log UI page is
  // out of scope for a security fix; this is the read endpoint that makes the
  // journal inspectable at all (e.g. via a REST client / a future admin panel).

  async getTransactionAuditLog(
    id: string,
    currentUser: SessionUser,
  ): Promise<TransactionAuditLogEntryDto[]> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
      columns: { deletedAt: true },
    })
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    // No-op for ADMIN today (always privileged) — kept for the same reason
    // every other read in this file routes through the shared guard: a
    // future role added to this endpoint must not accidentally see the
    // journal of a transaction it cannot otherwise see.
    assertTransactionVisible(tx, currentUser)

    const rows = await this.db.db
      .select({
        id: transactionAuditLog.id,
        action: transactionAuditLog.action,
        actorId: transactionAuditLog.actorId,
        actorName: users.displayName,
        metadata: transactionAuditLog.metadata,
        createdAt: transactionAuditLog.createdAt,
      })
      .from(transactionAuditLog)
      .leftJoin(users, eq(users.id, transactionAuditLog.actorId))
      .where(eq(transactionAuditLog.targetId, id))
      .orderBy(desc(transactionAuditLog.createdAt))

    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      // `actorId` carries `ON DELETE SET NULL` — a hard-deleted user must not
      // make their own past actions unreadable.
      // i18n server-text PR4 (S4): null, not a Russian placeholder. No apps/web
      // consumer of the audit log exists yet, so the localized «User deleted»
      // fallback is DEFERRED until a transaction-audit UI exists (tracked in
      // backlog).
      actorName: r.actorName,
      metadata: r.metadata as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }))
  }
}
