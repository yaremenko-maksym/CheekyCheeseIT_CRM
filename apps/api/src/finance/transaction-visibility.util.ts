/**
 * transaction-visibility.util — the SINGLE choke point for "is this
 * transaction row visible / mutable" across the whole API.
 *
 * security-review PR #456, TWO rounds:
 *
 * Round 1 (`5cf6d3c6`, verdict BLOCK, HIGH-1/HIGH-2/HIGH-3): `deletedAt` was
 * implemented as a property of ONE module (`TransactionsService`), but the
 * `transactions` row is read and written from at least THREE others
 * (`InvoicesService`, `CompanyAccountService`, `DocumentsService`). Fixed by
 * adding the guard FUNCTIONS below plus a text-scanning regression spec
 * meant to catch a caller who forgot to call them.
 *
 * Round 2 (verdict BLOCK again, 4834458611/4840207923): the scanner was
 * defeated 7/7 by realistic variants, and — the decisive finding —
 * `assertTransactionVisible` was DELETED from `getDepositStatus` (the fetch
 * and the guard were two separate statements) while the scanner stayed
 * green. Detection cannot outpace a determined bypass; this file's role
 * shifted from "the thing callers must remember to invoke" to "the thing
 * that makes forgetting impossible":
 *
 *   - List/aggregate/join reads that never need an ADMIN/ACCOUNTANT-sees-
 *     deleted-rows exception now source from `nonDeletedTransactions`
 *     (schema.ts) — a Postgres VIEW, so there is no WHERE clause to forget.
 *   - Single-row-by-id reads that DO need that exception (findOne,
 *     getInvoice, signInvoice, getDepositStatus, the audit-log read) use
 *     `fetchVisibleTransactionOrThrow` / `fetchWritableTransactionOrThrow`
 *     below — fetch and guard are now ONE function call, so the
 *     getDepositStatus-class mistake (delete the guard, keep the fetch) is
 *     no longer two separate statements where one can be silently dropped:
 *     deleting the guard now means deleting the DATA too.
 *   - `apps/api/eslint.config.mjs` bans importing the raw `transactions`
 *     table from outside `finance/**` (`no-restricted-imports`) — a module
 *     like `invoices/` or `documents/` cannot reach an unfiltered row at
 *     all, not "is expected not to".
 *
 * `TRANSACTION_NOT_DELETED` / `assertTransactionVisible` /
 * `assertTransactionNotDeleted` / `assertTransactionWritable` remain in
 * active use: by the view's own definition, by `finance/**`'s legitimate
 * raw-table readers (idempotency-by-hash lookups, rows a sibling FK-adjacent
 * guard already makes un-deletable), and as the primitives the two `fetch*`
 * functions below compose.
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
import { eq, isNull } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { transactions, type Transaction } from '../database/schema'
import type { DatabaseService } from '../database/database.service'
import type { DrizzleTx } from '../database/types'

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
    throw new NotFoundException('Транзакция не найдена')
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

/** Either the pool handle or a transaction handle opened by `db.transaction(...)`. */
type Db = DatabaseService['db'] | DrizzleTx

/**
 * Combines "not found" + visibility into ONE check on an ALREADY-FETCHED row
 * (or `undefined`). security-review PR #456 round 2: this is the direct fix
 * for the demonstrated bypass — `assertTransactionVisible` was deleted from
 * `getDepositStatus` (a separate statement AFTER the fetch) while the fetch
 * itself stayed, undetected by the round-1 scanner. Wrap the raw
 * `db.query.transactions.findFirst(...)` (or any relational fetch carrying
 * `with: {...}` joins — the generic only needs `{ deletedAt }`, so any
 * relation shape works) DIRECTLY in this call:
 *
 *   const tx = assertFoundAndVisible(
 *     await db.query.transactions.findFirst({ where: ..., with: {...} }),
 *     currentUser,
 *   )
 *
 * Fetch and guard are now ONE expression — there is no longer a line to
 * delete that removes ONLY the guard without also breaking the assignment.
 * Prefer `fetchVisibleTransactionOrThrow` below when no `with:` relations are
 * needed (it builds the query itself, one fewer thing to get wrong).
 */
export function assertFoundAndVisible<T extends { deletedAt: Date | null }>(
  tx: T | undefined,
  currentUser: SessionUser | null,
): T {
  if (!tx) throw new NotFoundException('Transaction not found')
  assertTransactionVisible(tx, currentUser)
  return tx
}

/**
 * Fetch a transaction row BY ID and apply the visibility guard — as ONE
 * function call, not two statements. Thin wrapper around
 * `assertFoundAndVisible` for the common case (no relational `with:` needed).
 * `currentUser: null` covers unauthenticated/public reads (e.g. the invoice
 * `/verify/:id` QR endpoint).
 */
export async function fetchVisibleTransactionOrThrow(
  db: Db,
  id: string,
  currentUser: SessionUser | null,
): Promise<Transaction> {
  const tx = await db.query.transactions.findFirst({ where: eq(transactions.id, id) })
  return assertFoundAndVisible(tx, currentUser)
}

/**
 * Same fusion as `fetchVisibleTransactionOrThrow`, plus the write-side gate —
 * for any single-row mutation entry point reachable by a non-privileged
 * author (see `assertTransactionWritable`'s doc for the 404-vs-400 split).
 */
export async function fetchWritableTransactionOrThrow(
  db: Db,
  id: string,
  currentUser: SessionUser,
): Promise<Transaction> {
  const tx = await fetchVisibleTransactionOrThrow(db, id, currentUser)
  assertTransactionNotDeleted(tx)
  return tx
}
