import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { and, desc, eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { extractOnChainTxHash } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { payoutRequests, transactionAuditLog, transactions } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import {
  describeTxHashClaim,
  findConsumedTxHash,
  normalizeOnChainTxHash,
  releaseConsumedTxHash,
  settlementConsumesTransfer,
} from './onchain-tx'
import { COMPANY_ACCOUNT_FUNDING_SOURCE } from './company-account-balance'

const PAYOUT_TO_COMPANY_ACCOUNT = COMPANY_ACCOUNT_FUNDING_SOURCE

/**
 * On-chain transfer claim registry: resolving a receipt's hash transition,
 * ADMIN release of a mis-claimed hash, read-only inspection, and the audit
 * journal helpers for reclaim / divergence / unclaimed credits. Depends on the
 * database only, never on TransactionsService.
 */
@Injectable()
export class OnChainClaimService {
  private readonly logger = new Logger(OnChainClaimService.name)

  constructor(private readonly db: DatabaseService) {}

  /**
   * MED-F (security-review round 4) — ONE rule for every receipt change on a
   * crediting row, shared by `attachOrReplaceReceipt` AND
   * `adminUpdateTransaction`.
   *
   * Round 3 guarded only the first entrance; `PATCH /transactions/:id/admin-edit`
   * could still re-point a credited admin income at a transfer another
   * settlement had already consumed — two crediting rows, one transfer. A guard
   * with a known bypass is worse than no guard: the next reader trusts it.
   * Both entrances now call this, so a third one has a single thing to reuse.
   *
   * Returns what the caller must apply:
   *   • `txHashPatch` — the recorded-hash column change (may be empty),
   *   • `claimHash`   — a hash to claim inside the caller's transaction,
   *   • `staleClaim`  — the new evidence dropped the hash while the old claim
   *                     stands; the claim is KEPT (the transfer really was
   *                     consumed by this credit) and the divergence is recorded.
   *
   * Throws 400 when the new evidence points at a transfer owned by a DIFFERENT
   * row. Ownership, not value: re-attaching this row's own receipt is fine
   * (MED-G — the value-only comparison rejected honest users on their own data).
   */
  async resolveReceiptHashTransition(
    tx: typeof transactions.$inferSelect,
    nextExternalUrl: string | null,
  ): Promise<{
    txHashPatch: { txHash?: string | null }
    claimHash: string | null
    staleClaim: boolean
  }> {
    const rowConsumesTransfer =
      tx.type === 'ADMIN_INCOME' &&
      settlementConsumesTransfer({ kind: 'ADMIN_INCOME', fundingSource: tx.fundingSource })
    if (!rowConsumesTransfer) {
      return { txHashPatch: {}, claimHash: null, staleClaim: false }
    }

    const currentHash = normalizeOnChainTxHash(tx.txHash)
    const nextHash = extractOnChainTxHash(nextExternalUrl)

    if (nextHash === currentHash) {
      // Unchanged evidence (including re-attaching the same link) — no-op.
      return { txHashPatch: {}, claimHash: null, staleClaim: false }
    }

    if (!nextHash) {
      // LOW (round 4): the new receipt carries no hash. The old claim STAYS —
      // that transfer really did fund this credit and must not become
      // re-spendable — so the recorded hash stays too (column and registry
      // agree). The evidence/hash divergence is what gets recorded.
      // Always true: nextHash is null here and the equal-hash case returned above,
      // so currentHash is necessarily non-null.
      return { txHashPatch: {}, claimHash: null, staleClaim: true }
    }

    const consumed = await findConsumedTxHash(this.db.db, nextHash)
    if (consumed && consumed.referenceId !== tx.id) {
      throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
    }

    return {
      txHashPatch: { txHash: nextHash },
      // Already ours (referenceId === tx.id) → nothing to claim again.
      claimHash: consumed ? null : nextHash,
      staleClaim: false,
    }
  }

  /**
   * MED-G (security-review round 4) — ADMIN releases a mis-claimed hash.
   *
   * The escape hatch for the lock-outs a permanent claim creates: a typo'd hash
   * burning a stranger's transfer, or a deposit that can never be credited
   * because its hash collided. Deleting the row does not help — the registry
   * outlives its referent by design.
   *
   * Two conditions make the release safe to have:
   *   • ADMIN only (not the SENIOR/DROP who submitted the hash — otherwise
   *     "release then re-spend" becomes the new double-spend), and
   *   • it is JOURNALED: who, when, which hash, which claim, and why. A silent
   *     un-spend would trade one problem for a worse one.
   */
  async releaseOnChainHash(
    txHash: string,
    reason: string,
    currentUser: SessionUser,
  ): Promise<{
    txHash: string
    purpose: string
    referenceId: string | null
    /**
     * MED-P: `creditsCompanyAccount === false` does NOT mean "safe to release".
     * A CASH / ADMIN_USDT payout is `settled: true` with
     * `creditsCompanyAccount: false` — the transfer was really spent, it just
     * never entered the pool. Read both fields.
     */
    referent: {
      exists: boolean
      settled: boolean
      status: string | null
      fundingSource: string | null
      currency: string | null
      creditsCompanyAccount: boolean
    }
  }> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const normalized = normalizeOnChainTxHash(txHash)
    if (!normalized) {
      throw apiError('FINANCE_TX_HASH_INVALID', HttpStatus.BAD_REQUEST)
    }
    const trimmedReason = reason.trim()
    if (trimmedReason.length === 0) {
      throw apiError('FINANCE_TX_HASH_RELEASE_REASON_REQUIRED', HttpStatus.BAD_REQUEST)
    }

    const result = await this.db.db.transaction(async (dbtx) => {
      const released = await releaseConsumedTxHash(dbtx, normalized, currentUser.id, trimmedReason)
      if (!released) {
        throw apiError('FINANCE_TX_HASH_NOT_CONSUMED', HttpStatus.NOT_FOUND)
      }

      // MED-K (round 5): report what the row that held the claim still is.
      // Releasing does not un-credit anything, so an admin who releases a live
      // settlement has just made that transfer spendable a second time — they
      // must see that consequence in the response, not discover it at
      // reconciliation. MED-P (round 6): `settled` is reported alongside
      // `creditsCompanyAccount`, because a CASH/ADMIN_USDT payout is spent
      // without ever crediting the pool.
      const referent = await this.describeReferent(dbtx, released.purpose, released.referenceId)

      // Journal INSIDE the same transaction — a release without its record must
      // be impossible. `targetId` points at the row that held the claim when
      // known, else at the actor (the audit table takes a bare uuid, no FK).
      await dbtx.insert(transactionAuditLog).values({
        actorId: currentUser.impersonatorId ?? currentUser.id,
        targetId: released.referenceId ?? currentUser.id,
        action: 'ONCHAIN_HASH_RELEASED',
        metadata: {
          txHash: released.txHash,
          purpose: released.purpose,
          referenceId: released.referenceId,
          reason: trimmedReason,
          referent,
        },
      })

      return { ...released, referent }
    })

    // LOW (round 5): log AFTER the commit. Logging inside the transaction
    // announced a release that a later failure would have rolled back — a log
    // that says "released" for something that never happened is worse than no
    // log on the one path whose whole point is traceability.
    this.logger.warn(
      `[onchain-registry] hash RELEASED by admin ${currentUser.id} — ` +
        `purpose=${result.purpose} referenceId=${result.referenceId ?? 'none'} ` +
        `referentSettled=${result.referent.settled} ` +
        `referentCreditsCompanyAccount=${result.referent.creditsCompanyAccount}. ` +
        `The transfer can be settled again.`,
    )

    return result
  }

  /**
   * MED-K (round 5) — read-only view of a hash's registry state.
   *
   * Before this, a release was blind: the only way to learn who owned a claim
   * was to call the release, which destroyed it. A typo therefore silently
   * freed somebody ELSE's legitimate claim — the same "act without seeing"
   * failure this whole PR is about. ADMIN/ACCOUNTANT (the roles that already
   * see the finance ledger) can now look first.
   */
  async inspectOnChainHash(txHash: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }
    const normalized = normalizeOnChainTxHash(txHash)
    if (!normalized) {
      throw apiError('FINANCE_TX_HASH_INVALID', HttpStatus.BAD_REQUEST)
    }

    const claim = await describeTxHashClaim(this.db.db, normalized)
    if (!claim) {
      return { txHash: normalized, claimed: false as const }
    }

    const referent = await this.describeReferent(
      this.db.db as unknown as DrizzleTx,
      claim.purpose,
      claim.referenceId,
    )

    return {
      txHash: claim.txHash,
      claimed: claim.releasedAt === null,
      purpose: claim.purpose,
      referenceId: claim.referenceId,
      consumedByUserId: claim.consumedByUserId,
      consumedAt: claim.createdAt.toISOString(),
      releasedAt: claim.releasedAt ? claim.releasedAt.toISOString() : null,
      releasedBy: claim.releasedBy,
      releasedReason: claim.releasedReason,
      // What releasing this claim would mean. MED-P: read `settled` TOGETHER
      // with `creditsCompanyAccount` — a CASH/ADMIN_USDT payout is settled
      // without crediting the pool, so `creditsCompanyAccount: false` is not a
      // green light.
      referent,
    }
  }

  /**
   * Describe the row that holds/held a claim: does it still CREDIT the company
   * account, and — if not — why not.
   *
   * MED-P (security-review round 6): `creditsCompanyAccount: false` is NOT a
   * "safe to release" verdict, and presenting the bare boolean as the decisive
   * fact invited exactly that reading. A payout confirmed manually as CASH or
   * ADMIN_USDT legitimately has `fundingSource: null` and never touches the
   * company balance — yet it consumed a REAL transfer, so releasing its claim
   * still makes that transfer spendable again. The extra fields say which case
   * you are looking at: `settled: true` with `creditsCompanyAccount: false`
   * means "spent, just not into the pool".
   *
   * The crediting predicates mirror `computeCompanyAccountBalanceFromLedger`
   * term-for-term, so "credits" here means exactly what the balance means.
   */
  async describeReferent(
    dbtx: DrizzleTx,
    purpose: string,
    referenceId: string | null,
  ): Promise<{
    exists: boolean
    /** The referent represents a real settlement (money moved somewhere). */
    settled: boolean
    status: string | null
    fundingSource: string | null
    currency: string | null
    creditsCompanyAccount: boolean
  }> {
    const missing = {
      exists: false,
      settled: false,
      status: null,
      fundingSource: null,
      currency: null,
      creditsCompanyAccount: false,
    }
    if (!referenceId) return missing

    if (purpose === 'PAYOUT') {
      const row = await dbtx.query.transactions.findFirst({
        where: and(eq(transactions.payoutRequestId, referenceId), eq(transactions.type, 'PAYOUT')),
        // LOW-1 (round 7): deterministic pick. Several PAYOUT rows for one
        // request should not exist, but an unordered read would leave WHICH one
        // answers a money-path question up to chance.
        orderBy: [desc(transactions.createdAt)],
        columns: { status: true, fundingSource: true, currency: true },
      })

      if (!row) {
        // LOW-1 (round 7) — and this one is real for us: the accounting import
        // brought over payouts settled WITHOUT the placeholder PAYOUT row this
        // branch reads. Answering `missing` for those says "no settlement
        // found", which an admin reads as "safe to release" — precisely the
        // misreading MED-P set out to prevent, now on imported data. Fall back
        // to the payout_request itself: its own status and hash prove the
        // settlement happened even when the ledger stub does not exist.
        const request = await dbtx.query.payoutRequests.findFirst({
          where: eq(payoutRequests.id, referenceId),
          columns: { status: true, txHash: true },
        })
        if (!request) return missing
        return {
          exists: true,
          settled: request.status === 'PAID',
          status: request.status,
          // No stub row → no funding marker exists to read (unknown, not "did
          // not credit"); `settled` carries the load here.
          fundingSource: null,
          currency: null,
          // The balance formula sums PAYOUT ledger rows, so without one this
          // payout contributes nothing to the pool — but it IS settled.
          creditsCompanyAccount: false,
        }
      }

      const settled = row.status === 'PAID'
      return {
        exists: true,
        settled,
        status: row.status,
        fundingSource: row.fundingSource,
        currency: row.currency,
        // A payout credits the pool only through the COMPANY_ACCOUNT marker;
        // CASH / ADMIN_USDT settlements are `settled` but not crediting.
        creditsCompanyAccount:
          settled && row.fundingSource === PAYOUT_TO_COMPANY_ACCOUNT && row.currency === 'USDT',
      }
    }

    const row = await dbtx.query.transactions.findFirst({
      where: eq(transactions.id, referenceId),
      columns: { type: true, status: true, currency: true, fundingSource: true },
    })
    if (!row) return missing

    const settled = row.status === 'PAID'
    const creditsCompanyAccount =
      settled &&
      row.currency === 'USDT' &&
      (row.type === 'COMPANY_DEPOSIT' ||
        (row.type === 'ADMIN_INCOME' &&
          settlementConsumesTransfer({
            kind: 'ADMIN_INCOME',
            fundingSource: row.fundingSource,
          })))

    return {
      exists: true,
      settled,
      status: row.status,
      fundingSource: row.fundingSource,
      // LOW (round 7): currency is part of the crediting predicate, so without
      // it a non-USDT income shows `settled: true, credits: false` with nothing
      // explaining why.
      currency: row.currency,
      creditsCompanyAccount,
    }
  }

  /**
   * MED-J (round 5) — a released transfer is being spent again.
   *
   * Legitimate by construction (that is what a release is FOR), but the PAIR of
   * events — released by X for reason R, then consumed again by Y — is what an
   * investigation reconstructs, and only the second half is visible from the
   * ledger. Recorded in the same transaction as the new claim.
   */
  async recordReclaimAfterRelease(
    dbtx: DrizzleTx,
    params: { path: string; txHash: string; referenceId: string | null; actorId: string },
  ): Promise<void> {
    await dbtx.insert(transactionAuditLog).values({
      actorId: params.actorId,
      targetId: params.referenceId ?? params.actorId,
      action: 'ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE',
      metadata: {
        path: params.path,
        txHash: normalizeOnChainTxHash(params.txHash),
        referenceId: params.referenceId,
      },
    })
    this.logger.warn(
      `[onchain-registry] previously RELEASED hash consumed again — ` +
        `path=${params.path} referenceId=${params.referenceId ?? 'none'} actorId=${params.actorId}.`,
    )
  }

  /**
   * LOW (security-review round 4) — the receipt on a crediting row lost its
   * hash while the old claim stands.
   *
   * The claim is deliberately KEPT (that transfer really did fund this credit;
   * releasing it automatically would make it re-spendable), so evidence and
   * registry now describe different things. Silent divergence is what an
   * auditor must never meet — record it. An ADMIN who decides the old claim was
   * wrong has `releaseOnChainHash` for that, and it journals the decision.
   */
  async recordReceiptClaimDivergence(
    dbtx: DrizzleTx,
    params: { path: string; transactionId: string; actorId: string },
  ): Promise<void> {
    await dbtx.insert(transactionAuditLog).values({
      actorId: params.actorId,
      targetId: params.transactionId,
      action: 'RECEIPT_DROPPED_ONCHAIN_HASH',
      metadata: {
        path: params.path,
        reason: 'new-receipt-carries-no-tx-hash-existing-claim-kept',
      },
    })
    this.logger.warn(
      `[onchain-registry] receipt replaced with one carrying NO tx hash on a crediting row — ` +
        `path=${params.path} transactionId=${params.transactionId} actorId=${params.actorId}. ` +
        `The previous claim is kept; use releaseOnChainHash if it was wrong.`,
    )
  }

  /**
   * MED-1 (security-review PR #438) — make an UNCLAIMED credit observable.
   *
   * A company-account credit whose on-chain evidence carries no usable hash
   * (an `…/address/0x…` explorer link, a non-Ethereum explorer) is legitimate
   * legacy behaviour, so it is allowed — but it has the exact SHAPE of the
   * HIGH-1 bug ("money moved, registry untouched"). Silent tolerance means an
   * auditor cannot tell a legacy link from a bypass, so every occurrence is
   * recorded in `transaction_audit_log` (and logged at WARN) with the row id.
   */
  async recordUnclaimedCredit(
    dbtx: DrizzleTx,
    params: { path: string; transactionId: string; actorId: string },
  ): Promise<void> {
    // LOW (round 3): a WARN line drowns in a busy log and cannot be queried, so
    // the fact is ALSO persisted — in the SAME transaction as the credit, so
    // the trail can never disagree with the ledger.
    await dbtx.insert(transactionAuditLog).values({
      actorId: params.actorId,
      targetId: params.transactionId,
      action: 'CREDIT_WITHOUT_ONCHAIN_CLAIM',
      metadata: {
        path: params.path,
        reason: 'receipt-link-carries-no-tx-hash',
      },
    })
    this.logger.warn(
      `[onchain-registry] company-account credit WITHOUT an on-chain claim — ` +
        `path=${params.path} transactionId=${params.transactionId} actorId=${params.actorId}. ` +
        `The receipt link carries no 0x+64hex tx hash, so the transfer stays spendable ` +
        `by another settlement path. Verify the receipt.`,
    )
  }
}
