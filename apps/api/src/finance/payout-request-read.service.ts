import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { desc, eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { pendingObligations, payoutRequests } from '../database/schema'
import { mapTx, type TxWithRelations } from './transaction-mapper.util'

/**
 * Read side of payout requests: the role-scoped list and the single-request
 * detail (with per-viewer counterparty masking and the audit-field gate).
 * Depends on the database only, never on TransactionsService.
 */
@Injectable()
export class PayoutRequestReadService {
  constructor(private readonly db: DatabaseService) {}

  async findPayoutRequests(currentUser: SessionUser) {
    const all = await this.db.db.query.payoutRequests.findMany({
      orderBy: [desc(payoutRequests.createdAt)],
      with: {
        senior: { columns: { displayName: true } },
      },
    })

    const filtered =
      currentUser.role === 'SENIOR'
        ? all.filter((r) => r.seniorId === currentUser.id)
        : currentUser.role === 'DROP'
          ? // Drop role - phase 2 (backlog AC4): DROP sees only their OWN
            // payout requests. In drop-project flows `payoutRequests.seniorId`
            // points at the DROP user (the column is reused as "owner of the
            // payout" — see `payPayoutRequest` header comment around the
            // `req.seniorId === currentUser.id` check). Same filter shape as
            // SENIOR.
            all.filter((r) => r.seniorId === currentUser.id)
          : currentUser.role === 'JUNIOR' || currentUser.role === 'HR'
            ? // Same idea — these roles never owned payout requests.
              []
            : all

    return filtered.map((r) => ({
      id: r.id,
      seniorId: r.seniorId,
      seniorName:
        (r as typeof r & { senior: { displayName: string } | null }).senior?.displayName ?? '',
      incomeAmount: r.incomeAmount,
      payableAmount: r.payableAmount,
      contractAddress: r.contractAddress,
      txHash: r.txHash,
      // task-onchain-payment-integrity: the recorded on-chain sender is an
      // AUDIT field — ADMIN/ACCOUNTANT only. Masked to null for the payout's
      // own SENIOR/DROP (they gain nothing from it and it would leak other
      // parties' wallet addresses into a non-privileged surface).
      txFromAddress:
        currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT' ? r.txFromAddress : null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
  }

  async findPayoutRequest(id: string, currentUser: SessionUser) {
    const req = await this.db.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, id),
      with: {
        senior: { columns: { displayName: true } },
        transactions: {
          with: {
            // task-counterparty-role-masking: `role` drives ADMIN-party masking in mapTx.
            sender: { columns: { displayName: true, role: true } },
            receiver: { columns: { displayName: true, role: true } },
            project: { columns: { name: true } },
          },
        },
      },
    })
    if (!req) throw apiError('FINANCE_PAYOUT_REQUEST_NOT_FOUND', HttpStatus.NOT_FOUND)

    // RBAC gate (F2 fix, OWASP A01): only ADMIN / ACCOUNTANT have unrestricted
    // access; SENIOR and DROP may only see their own request (seniorId match);
    // all other roles (HR, JUNIOR, etc.) are unconditionally forbidden.
    //
    // Previously the code only checked SENIOR and DROP — HR and JUNIOR fell
    // through to the return statement and received the data (IDOR).
    //
    // Drop role - phase 2 note: `payout_requests.seniorId` is reused as the
    // "owner" column for DROP requests too (see `payPayoutRequest` header).
    // The ownership check below naturally handles both SENIOR and DROP via the
    // `isOwner` branch.
    const isPrivileged = currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT'
    const isOwner =
      (currentUser.role === 'SENIOR' || currentUser.role === 'DROP') &&
      req.seniorId === currentUser.id
    if (!isPrivileged && !isOwner) throw new ForbiddenException()

    // task-settle-payout-link-lost (backlog 74/B-1). `req.transactions` above
    // is a live Drizzle relation keyed on `transactions.payoutRequestId` —
    // but `settleByCompany` flips a cascade-booked obligation's source IOU
    // row IN PLACE and resets THAT column to null on the flip (task-settle-
    // in-place ADR — deliberate, avoids bleeding a paid obligation into
    // `autoCreateForPayout`'s aggregation and the `findOne`
    // SENIOR_INCOME-by-payoutRequestId enrichment elsewhere). The live
    // relation therefore silently drops a settled obligation from THIS
    // payout's detail view — this payout looks like it produced no senior/
    // drop obligation at all, even though the money is correct.
    // `pending_obligations.payoutRequestId` is a SEPARATE column, stamped
    // once at booking time (bookCompanyObligations) and never touched by
    // settle, so it still resolves the obligation's CURRENT row (via
    // `sourceTransactionId` — the flip reuses the same id, task-settle-
    // in-place) regardless of whether it has since been paid off. Merge
    // (dedup by id) rather than replace — a still-PENDING obligation is
    // already present via the live relation above; this only recovers the
    // ones settle detached.
    // security-review round on #590 (MED-1): the recovered obligation may
    // belong to a DIFFERENT person than the payout's owner — e.g. a DROP's
    // cascade payout books a SEPARATE senior IOU (creditorUserId=senior),
    // which the DROP owns the PAYOUT for but never owned the obligation
    // itself. Before settle, that SENIOR_PENDING_PAYOUT row never passed the
    // client's `isIncomeTransaction` filter (wrong type) and was never
    // rendered to the DROP; recovering it here must not be the FIRST time
    // that DROP viewer sees the senior's name + share amount. `mapTx` masks
    // company/ADMIN counterparties but never the senior/drop side — this
    // repo's rule on that surface is allowlist, not denylist (prior leaks on
    // this exact class), so narrow explicitly rather than trust downstream
    // masking. Reuses the SAME `isPrivileged` this function already computed
    // for the whole-request gate above — not a new predicate.
    //
    // backlog 168 (security-review on #590, found pre-existing — #590 did
    // NOT introduce or widen this; it made the RESTORED/recovered path above
    // stricter while leaving THIS live relation untouched). Before
    // MED-1 only narrowed `recoveredTxs` (the rows settle detaches and this
    // function re-attaches from `pending_obligations`). It never touched
    // `reqTransactions` itself — but the SAME cross-person row can reach the
    // viewer through the live relation directly: `bookCompanyObligations`
    // stamps the cascade-booked SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT
    // rows with THIS payout's `payoutRequestId` at creation time (still
    // PENDING_PAYMENT, settle has not run), so they are already sitting in
    // `req.transactions` the very first time `payPayoutRequest` returns —
    // for a DROP-owned cascade, that includes the SEPARATE senior IOU
    // (receiverId=senior, not the drop who owns this payout). `mapTx` never
    // masks the senior/drop counterparty (only the company/ADMIN side), so
    // an unfiltered pass-through leaks the senior's name + share amount to
    // the DROP in the exact response confirming their own payment.
    // Narrowed the same way `recoveredTxs` below already is: a live-relation
    // row belongs to `currentUser` when they are its sender OR receiver
    // (covers every shape actually attached here — the caller's own income
    // rows [receiverId=caller], the PAYOUT row itself [senderId=caller], and
    // the caller's OWN pending-payout row [receiverId=caller] — while
    // excluding a same-payout row stamped for someone else, e.g. the senior
    // IOU on a drop cascade). Privileged viewers are unaffected (`isPrivileged`
    // short-circuits, same as everywhere else on this surface).
    const reqTransactions = (
      req as typeof req & { transactions: TxWithRelations[] }
    ).transactions.filter(
      (tx) => isPrivileged || tx.senderId === currentUser.id || tx.receiverId === currentUser.id,
    )
    const seenTxIds = new Set(reqTransactions.map((tx) => tx.id))
    const obligationRows = (await this.db.db.query.pendingObligations.findMany({
      where: eq(pendingObligations.payoutRequestId, id),
      with: {
        sourceTransaction: {
          with: {
            sender: { columns: { displayName: true, role: true } },
            receiver: { columns: { displayName: true, role: true } },
            project: { columns: { name: true } },
          },
        },
      },
    })) as { creditorUserId: string; sourceTransaction: TxWithRelations | null }[]
    const recoveredTxs = obligationRows
      .filter((o) => isPrivileged || o.creditorUserId === currentUser.id)
      .map((o) => o.sourceTransaction)
      .filter((tx): tx is TxWithRelations => tx != null && !seenTxIds.has(tx.id))
    const allTransactions = [...reqTransactions, ...recoveredTxs]

    return {
      id: req.id,
      seniorId: req.seniorId,
      seniorName:
        (req as typeof req & { senior: { displayName: string } | null }).senior?.displayName ?? '',
      incomeAmount: req.incomeAmount,
      payableAmount: req.payableAmount,
      contractAddress: req.contractAddress,
      txHash: req.txHash,
      // Audit field — ADMIN/ACCOUNTANT only (see findPayoutRequests).
      txFromAddress: isPrivileged ? req.txFromAddress : null,
      status: req.status,
      transactions: allTransactions.map((tx) => mapTx(tx, currentUser)),
      createdAt: req.createdAt.toISOString(),
      updatedAt: req.updatedAt.toISOString(),
    }
  }
}
