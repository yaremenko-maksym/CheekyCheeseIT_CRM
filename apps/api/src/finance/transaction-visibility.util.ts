/**
 * transaction-visibility.util — the SINGLE choke point for "is this
 * transaction row visible / mutable" across the whole API.
 *
 * security-review PR #456 (round on `5cf6d3c6`, verdict BLOCK, HIGH-1/HIGH-2/
 * HIGH-3): `deletedAt` was implemented as a property of ONE module
 * (`TransactionsService`), but the `transactions` row is read and written
 * from at least THREE others (`InvoicesService`, `CompanyAccountService`,
 * `DocumentsService`). Patching the three modules the reviewer happened to
 * find would only move the bug to the next one. This file is the fix: every
 * module that touches a `transactions` row by id (read OR write) imports
 * from here instead of re-deriving the check inline, and
 * `transaction-read-guard.spec.ts` fails the build the moment a new raw
 * read/join of the `transactions` table appears anywhere in `apps/api/src`
 * without routing through one of these three exports (or a documented,
 * reviewed allowlist entry).
 *
 * Two independent invariants, composed as needed:
 *
 *   1. VISIBILITY (`assertTransactionVisible`) — a deleted row does not
 *      "exist" for anyone except ADMIN/ACCOUNTANT, not even its own author.
 *      Throws 404 (`NotFoundException`), never 403 — a 403 would let a
 *      non-privileged caller distinguish "not mine" from "deleted" from
 *      "never existed" by probing a known id (existence-oracle, SEC-10
 *      class). MUST run BEFORE any ownership/RBAC check that would
 *      otherwise resolve first (see `TransactionsService.findOne`'s
 *      ordering comment — the same rule applies everywhere this is called).
 *
 *   2. WRITABILITY (`assertTransactionNotDeleted`) — a soft-deleted row must
 *      not be mutable via ANY normal write endpoint, including by
 *      ADMIN/ACCOUNTANT (who otherwise still "see" it — see #1). ADMIN must
 *      restore it first (a deliberate, journaled action) before it can be
 *      edited/validated/paid/signed/receipted again. Throws 400
 *      (`BadRequestException`) with an actionable message — unlike #1, the
 *      caller here is always someone who is either privileged (already
 *      allowed to know the row exists) or the row's own author acting on an
 *      id they supplied themselves, so the message does not leak anything a
 *      404 would have hidden.
 *
 *   `assertTransactionWritable` composes both — the correct guard for any
 *   mutation entry point that a non-privileged author can reach directly
 *   (a privileged-only entry point may use `assertTransactionNotDeleted`
 *   alone since #1 would be a no-op there anyway; using the composed guard
 *   everywhere is equally correct and is what this codebase now does, for a
 *   single uniform pattern instead of two hand-picked ones).
 *
 * `TRANSACTION_NOT_DELETED` is the LIST/JOIN-level counterpart — a reusable
 * Drizzle predicate ANDed into any `where`/join condition that returns more
 * than one row (a single missing `AND` here is exactly how HIGH-1 leaked a
 * deleted transaction's amount/counterparty through `GET /api/invoices` and
 * the documents "Требует подписи" badge).
 */
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { isNull } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { transactions } from '../database/schema'

/** Reusable predicate for LIST/JOIN reads — AND this into every multi-row query. */
export const TRANSACTION_NOT_DELETED = isNull(transactions.deletedAt)

/** ADMIN/ACCOUNTANT are the only roles that can ever see a deleted row. */
function isPrivilegedViewer(currentUser: SessionUser | null): boolean {
  return currentUser?.role === 'ADMIN' || currentUser?.role === 'ACCOUNTANT'
}

/**
 * Read-side gate. `currentUser: null` covers unauthenticated/public reads
 * (e.g. the invoice `/verify/:id` QR endpoint) — always treated as
 * non-privileged, so a deleted transaction's invoice is never publicly
 * verifiable.
 */
export function assertTransactionVisible(
  tx: { deletedAt: Date | null },
  currentUser: SessionUser | null,
): void {
  if (tx.deletedAt && !isPrivilegedViewer(currentUser)) {
    throw new NotFoundException('Transaction not found')
  }
}

/** Write-side gate. Applies regardless of role — see file header, invariant #2. */
export function assertTransactionNotDeleted(tx: { deletedAt: Date | null }): void {
  if (tx.deletedAt) {
    throw new BadRequestException('Транзакция удалена — восстановите её перед этим действием')
  }
}

/**
 * Composed guard for any write entry point reachable by a non-privileged
 * author acting on a transaction they already know the id of (resubmit /
 * attach-receipt / sign flows). Non-privileged + deleted → 404 (hides
 * existence, invariant #1); privileged + deleted → 400 (blocks the mutation,
 * invariant #2).
 */
export function assertTransactionWritable(
  tx: { deletedAt: Date | null },
  currentUser: SessionUser | null,
): void {
  assertTransactionVisible(tx, currentUser)
  assertTransactionNotDeleted(tx)
}
