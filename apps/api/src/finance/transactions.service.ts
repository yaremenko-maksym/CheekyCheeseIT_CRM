import { randomBytes } from 'crypto'
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common'

import { and, desc, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm'
// QueryBuilder assembles SQL without a client — used by
// `salaryReceiverNotArchivedFilter` to build a correlated sub-select that some
// OTHER statement executes. See that method for why it must not go through `db`.
import { QueryBuilder } from 'drizzle-orm/pg-core'
import type {
  SessionUser,
  DropIncomeDto,
  DropIncomeStatus,
  DropIncomesQuery,
  DropPaymentDto,
  DropPaymentStatus,
  PaginatedDropIncomes,
  SeniorSummaryDto,
  IncomeComplianceOverviewDto,
  IncomeComplianceReceiverDto,
  IncomeComplianceRole,
  ManualPayoutMethod,
  CurrencyEnum,
  TransactionAuditLogEntryDto,
  SalaryMonthGapReportDto,
  SalaryMonthGapReceiverDto,
  MySalaryStatusDto,
  CascadeSnapshot,
  CascadeDerivativeSnapshot,
  CascadeEditPreviewResponse,
} from '@crm/shared'
import {
  SALARY_ELIGIBLE_ROLES,
  COMPANY_ACCOUNT_RECEIVER,
  resolveEditCascade,
  computeCascadeVersion,
  cascadeEditPreviewResponseSchema,
  amountsDiffer,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  invoiceSignatures,
  pendingObligations,
  projectFinanceSettings,
  projectMembers,
  payoutRequests,
  projects,
  teamMembers,
  transactions,
  transactionAuditLog,
  users,
  type Transaction,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { isUniqueViolation, uniqueViolationConstraint } from '../database/pg-errors'
import {
  consumeTxHash,
  describeTxHashClaim,
  findConsumedTxHash,
  minorUnitsFromString,
  normalizeEthAddress,
  normalizeOnChainTxHash,
  releaseConsumedTxHash,
  settlementConsumesTransfer,
  usdtToMinorUnits,
  TX_HASH_ALREADY_CONSUMED_MESSAGE,
} from './onchain-tx'
// HIGH-1: the SINGLE hash-extraction rule, shared with the Zod write boundary.
import { extractOnChainTxHash } from '@crm/shared'
import { InvoicesService } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { NbuCurrencyService, type ExchangeRateResult } from './nbu-currency.service'
import { convertToBase, type BalanceCurrency } from './balance.service'
import { EtherscanService } from './etherscan.service'
import { resolveSeniorShare } from './senior-share-resolver'
import { resolveDropShare, DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'
import { getOwnSalaryStatus } from './salary-status.helper'
import { previousSalaryMonthKey } from './salary-month.util'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
  COMPANY_ACCOUNT_FUNDING_SOURCE,
} from './company-account-balance'
import { assertReceiptDocumentBindable } from './receipt.util'
import { receiptMandatoryError, selfPayError, transactionAmountError } from '@crm/shared'
// task-admin-income-unified: MONEY_SCALE/roundShareAmount moved to @crm/shared
// so the web pre-submit obligation-preview banner and this service compute the
// exact same rounded share amount — see the module doc in packages/shared.
import { MONEY_SCALE, roundShareAmount } from '@crm/shared'
// Re-exported for backward compatibility: pre-move call sites (e.g.
// admin-income-drop-backfill.integration.spec.ts, task-admin-income-drop-backfill,
// merged independently of this move) still import `roundShareAmount` from this
// file's old local-export surface — same binding as the @crm/shared import
// above, not a second implementation.
export { roundShareAmount }
import {
  assertTransactionVisible,
  assertTransactionWritable,
  fetchWritableTransactionOrThrow,
} from './transaction-visibility.util'
// task-drop-payout-currency: extracted to a shared util (was a private
// function here) so pending-settlement.service.ts can apply the SAME
// exchange-rate storability rule when settling a DROP obligation in a
// non-obligation currency — see exchange-rate.util.ts for the full rationale.
import { isStorableExchangeRate } from './exchange-rate.util'

// Phase 8 v2 — payout → company wallet. Marker persisted in
// transactions.fundingSource on a PAYOUT row whose money landed on the company
// USDT account (on-chain confirm OR manual COMPANY_ACCOUNT). company-account
// computeBalance counts ONLY these PAYOUT rows, so ADMIN_USDT/CASH manual
// confirmations (which leave fundingSource NULL) never inflate the balance.
//
// LOW (security-review round 6): sourced from the EXPORTED constant instead of
// re-declaring the literal. The writer and the balance formula that reads it
// must never drift apart, and a second copy of a string is how that starts.
const PAYOUT_TO_COMPANY_ACCOUNT = COMPANY_ACCOUNT_FUNDING_SOURCE
// M4 — On-chain amount vs. the recorded payableAmount.
//
// The ±1% tolerance band that used to live here was REMOVED by
// task-onchain-payment-integrity (owner decision: «сумма должна быть точь-в-точь
// как в выплате»). `payPayoutRequest` now demands EXACT equality, compared as
// integer minor units — the rationale and the mechanics are documented at the
// comparison itself. Nothing else referenced the constant, so no band remains
// anywhere in the payout path.
//
// WHAT WE CREDIT is unchanged: the company account is credited the FROZEN
// `payableAmount` (the contractual company-share obligation), not a figure
// derived from chain data — keeping the ledger deterministic and immune to a
// manipulated on-chain `value`. With exact matching the two are now
// necessarily identical anyway.

// `isUniqueViolation` (+ PG_UNIQUE_VIOLATION) now lives in
// `../database/pg-errors` — task-onchain-payment-integrity moved it there so the
// deposit path (`company-account.service`) detects a constraint collision the
// SAME way this file does; the two used to disagree (that file read `.code` off
// the top-level error only, missing drizzle-wrapped violations).

/** Default drop-share percentage when `users.dropSharePercent` is NULL.
 *  Used in `computeDropDistribution` (write-path), `getSummary` (read-path
 *  display), the drop-share resolver and the admin-USDT obligation math.
 *  Single source of truth — physically defined in `drop-share-resolver.ts`
 *  (so the resolver can consume it without a circular import) and re-exported
 *  here for backward compatibility with existing call sites.
 */
export { DEFAULT_DROP_SHARE_PERCENT }

/**
 * Default senior share percent when no per-user override is set (DB default 26).
 * Single source of truth — used in computeDropDistribution, getSeniorSummary,
 * and getSummary to avoid scattering the literal `26` across the service.
 */
export const DEFAULT_SENIOR_SHARE_PERCENT = 26

/**
 * Roles the monthly SALARY cron (`createMonthlySalaries`) actually processes
 * — mirrors exactly what `resolveHrAccountantSalaryReceivers` /
 * `resolveJuniorSalaryReceivers` target, kept as an explicit named set (not
 * re-derived from those two methods' names) so both the E-5 gap report and
 * the E-6 `mySalaryState` computation in `getSeniorSummary` can ask "is this
 * role one the cron ever accrues to" without a role-by-role reimplementation.
 * Deliberately narrower than `SALARY_ELIGIBLE_ROLES` (@crm/shared, users.ts)
 * — that set ALSO includes SENIOR/DROP, who can only ever receive a
 * MANUALLY created salary (`createSalary`), never a cron-accrued one.
 *
 * security-review round 3 (mutation gate): exported so it can be pinned
 * DIRECTLY — its only current runtime call site is `getSeniorSummary`,
 * which is itself RBAC-gated to SENIOR/ADMIN callers ONLY (see the class's
 * `@Roles` guard). Neither SENIOR nor ADMIN is ever a member of this set,
 * so `.has(currentUser.role)` is FALSE for every real caller regardless of
 * what this set actually contains — gutting it to `[]`, or blanking any of
 * its 3 string literals, changed nothing any existing test could observe
 * through that call site alone (all 4 mutants survived). A direct
 * membership test on the export is the only way to pin the invariant the
 * docblock above already claims ("mirrors exactly what
 * resolveHrAccountantSalaryReceivers / resolveJuniorSalaryReceivers
 * target").
 */
export const CRON_ELIGIBLE_SALARY_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'HR',
  'ACCOUNTANT',
  'JUNIOR',
])

type TxWithRelations = Transaction & {
  // task-counterparty-role-masking: `role` is joined so mapTx can tell whether
  // a party is an ADMIN partner (Максим/Константин) and mask their identity for
  // non-privileged viewers. Nullable to stay resilient if a legacy row points
  // at a since-deleted user (the relation resolves to null).
  sender: { displayName: string; role: string } | null
  receiver: { displayName: string; role: string } | null
  project: { name: string } | null
  payoutRequest?: {
    seniorId: string
    incomeAmount: string
    payableAmount: string
    seniorSharePercent: number | null
    seniorSharePercentSource?: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null
  } | null
}

@Injectable()
export class TransactionsService {
  // Invoice triggers fire on best-effort and only log failures so a hiccup in
  // S3/PDF/notifications never reverts a successful financial transition.
  private readonly logger = new Logger(TransactionsService.name)

  constructor(
    private db: DatabaseService,
    @Inject(forwardRef(() => InvoicesService))
    private readonly invoicesService: InvoicesService,
    @Inject(forwardRef(() => DocumentsService))
    private readonly documentsService: DocumentsService,
    // Phase 8 v2 — payout → company wallet. NBU rates convert cross-currency
    // company-shares into USDT at create time; EtherscanService validates the
    // on-chain settlement at pay time (recipient = company wallet, confirmed,
    // amount ≈ payable).
    private readonly nbuCurrency: NbuCurrencyService,
    private readonly etherscan: EtherscanService,
  ) {}

  /**
   * MED-Q (security-review round 6) — is THIS unique violation the on-chain
   * registry, or something else entirely?
   *
   * Mapping any 23505 to «хеш уже использован» hands the user a confident,
   * wrong explanation: an admin edit that also sets a salary month trips
   * `uq_transactions_salary_receiver_month` and gets told about a tx hash they
   * never touched. Same failure the payout cascade already avoids with an
   * allow-list of index names — the receipt entrances now share it.
   */
  private isRegistryConflict(err: unknown): boolean {
    const constraint = uniqueViolationConstraint(err)
    return (
      constraint === 'uq_consumed_tx_hashes_active_tx_hash' ||
      // Pre-MED-J name; a rolling deploy can still be running the old index.
      constraint === 'uq_consumed_tx_hashes_tx_hash'
    )
  }

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
  private async resolveReceiptHashTransition(
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
      return { txHashPatch: {}, claimHash: null, staleClaim: currentHash !== null }
    }

    const consumed = await findConsumedTxHash(this.db.db, nextHash)
    if (consumed && consumed.referenceId !== tx.id) {
      throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
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
      throw new BadRequestException(
        'Некорректный hash транзакции — ожидается 0x + 64 hex или ссылка на Etherscan',
      )
    }
    const trimmedReason = reason.trim()
    if (trimmedReason.length === 0) {
      throw new BadRequestException('Укажите причину освобождения хеша (она попадёт в журнал)')
    }

    const result = await this.db.db.transaction(async (dbtx) => {
      const released = await releaseConsumedTxHash(dbtx, normalized, currentUser.id, trimmedReason)
      if (!released) {
        throw new NotFoundException('Этот хеш не числится использованным')
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
      throw new BadRequestException(
        'Некорректный hash транзакции — ожидается 0x + 64 hex или ссылка на Etherscan',
      )
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
  private async describeReferent(
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
  private async recordReclaimAfterRelease(
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
  private async recordReceiptClaimDivergence(
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
  private async recordUnclaimedCredit(
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

  /**
   * Resolve the business-time of a transaction from a user-supplied input.
   *
   * Frontend sends `txDate` from `<input type="date">` (YYYY-MM-DD) which the
   * Date constructor parses to midnight UTC (00:00:00.000Z). This breaks
   * sort-by-date — all "today's" rows tie at 00:00 and order falls back to
   * unrelated keys (e.g. payouts with txDate=null land first because their
   * `createdAt` carries the real time-of-day).
   *
   * Rule:
   * - User picked nothing → `new Date()` (now, with full time-of-day).
   * - User picked a *past* day (different YYYY-MM-DD vs today UTC) → keep
   *   their pick as-is (midnight is correct for "this happened on day X").
   * - User picked *today* → merge today's calendar date with current
   *   time-of-day so the row sorts above same-day rows created earlier.
   *
   * This is fix-forward: legacy midnight rows are not migrated. The frontend
   * sort tie-breaker handles them by falling through to `createdAt`.
   */
  private resolveTxDate(rawTxDate: string | null | undefined): Date {
    const now = new Date()
    if (!rawTxDate) return now
    const picked = new Date(rawTxDate)
    if (Number.isNaN(picked.getTime())) return now
    // Compare UTC calendar dates (matches how the input is parsed).
    const sameDay =
      picked.getUTCFullYear() === now.getUTCFullYear() &&
      picked.getUTCMonth() === now.getUTCMonth() &&
      picked.getUTCDate() === now.getUTCDate()
    if (!sameDay) return picked
    // Same calendar day: keep picked date, fold in current time-of-day.
    return new Date(
      Date.UTC(
        picked.getUTCFullYear(),
        picked.getUTCMonth(),
        picked.getUTCDate(),
        now.getUTCHours(),
        now.getUTCMinutes(),
        now.getUTCSeconds(),
        now.getUTCMilliseconds(),
      ),
    )
  }

  /**
   * HIGH-1 (IDOR / OWASP A01) guard — must be called BEFORE writing
   * `receiptDocumentId` to any transaction FK.
   *
   * Validates that the document identified by `docId`:
   *   1. Exists (not deleted / never inserted) — NotFoundException.
   *   2. Has category === 'RECEIPT' — BadRequestException.
   *   3. Is owned by the expected owner:
   *      - For non-ADMIN paths the owner must be the calling user (`currentUser.id`).
   *      - For ADMIN paths pass `opts.expectedOwnerId` = the transaction receiver/senior;
   *        ADMIN may bind any RECEIPT owned by that person (mirrors the upload
   *        RBAC matrix in DocumentsService.assertCanUpload for RECEIPT category).
   *
   * Throws before any DB write so the FK is never set to a foreign document.
   *
   * Rationale (PR-3 security review HIGH-1):
   *   Without this check a SENIOR-A can supply `receiptDocumentId = <docId of B>`
   *   in updateSeniorIncome.  After a subsequent reject+resubmit the replace-with-
   *   delete path (`oldDocId → dbtx.delete + S3.delete`) would permanently destroy
   *   victim B's document.  The partial unique index only catches already-bound
   *   docs; orphan RECEIPTs are free to be stolen.
   */
  private assertReceiptDocumentBindable(
    docId: string,
    currentUser: SessionUser,
    opts: { expectedOwnerId?: string } = {},
  ): Promise<void> {
    // Delegates to the shared guard (receipt.util) — the SINGLE implementation
    // reused by PendingSettlementService's ADMIN_PERSONAL file-receipt settle so
    // the ownership + RECEIPT-category check never drifts.
    return assertReceiptDocumentBindable(this.db.db, docId, currentUser, opts)
  }

  /**
   * Fire-and-forget wrapper so a failing invoice generation (e.g. S3 outage)
   * does NOT roll back the underlying transaction state change. The PAID
   * status flip is the source of truth; the invoice is a derived artefact
   * that can always be re-generated (autoCreate is idempotent on
   * `invoice_document_id`).
   *
   * task-aggregate-invoice-per-payout: a third kind `PAYOUT` was added —
   * `payPayoutRequest` now fires one PAYOUT-trigger after the cascade
   * instead of N SENIOR_INCOME-triggers (one per linked income). The
   * SENIOR_INCOME branch is kept for legacy callers
   * (`PendingSettlementService.settleByCompany`).
   */
  private async safeAutoCreateInvoice(
    kind: 'SENIOR_INCOME' | 'SALARY' | 'PAYOUT',
    transactionId: string,
  ): Promise<void> {
    try {
      if (kind === 'SENIOR_INCOME') {
        await this.invoicesService.autoCreateForSeniorPayout(transactionId)
      } else if (kind === 'SALARY') {
        await this.invoicesService.autoCreateForSalary(transactionId)
      } else {
        await this.invoicesService.autoCreateForPayout(transactionId)
      }
    } catch (err) {
      this.logger.warn(
        `auto-create invoice failed for ${kind} tx=${transactionId}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * task-counterparty-role-masking (RBAC identity-masking, security-critical).
   *
   * A transaction "side" (sender or receiver) is an **internal company party**
   * — either the company account pool itself, or a specific ADMIN partner
   * (Максим/Константин) — whose real identity is disclosed ONLY to
   * ADMIN/ACCOUNTANT. For every other role the side is rebranded to
   * «CheekyCheeseIT» with the user id + displayName stripped (see the
   * `senderMasked`/`receiverMasked` branches in `mapTx`), so a
   * SENIOR/JUNIOR/DROP/HR can never learn which admin funded a payout nor
   * enumerate the admin profile via a leaked id.
   *
   * The account pool is recognised by its label literals (`'COMPANY'` raw, or
   * the Russian «Счёт компании» alias booked by CompanyAccountService) or, as a
   * defensive fallback for legacy rows, a company-account-funded row whose side
   * carries no user id. An ADMIN partner is recognised by the joined role.
   *
   * NOTE: the actual recipient of a company payout (the drop/senior — a
   * non-ADMIN user with their own id) is never an internal party, so viewers
   * still see themselves on their own rows.
   */
  private isInternalCompanySide(
    sideId: string | null | undefined,
    sideLabel: string | null | undefined,
    sideRole: string | null | undefined,
    fundingSource: string | null | undefined,
  ): boolean {
    const isCompanyAccount =
      sideLabel === 'COMPANY' ||
      sideLabel === 'Счёт компании' ||
      (fundingSource === 'COMPANY_ACCOUNT' && (sideId === null || sideId === undefined))
    const isAdminPartner = !!sideId && sideRole === 'ADMIN'
    // MED-1 (security review PR #384): `transactions.senderId → users.id` is
    // ON DELETE SET NULL. If an ADMIN partner who personally funded a payout
    // (fundingSource='ADMIN_PERSONAL') is later deleted, `senderId` flips to
    // NULL but `senderLabel` still carries the SNAPSHOT of their displayName
    // (stamped at pay/settle time — see `paySalary` / `PendingSettlementService`
    // settle-in-place). Without this branch, `isAdminPartner` above (which
    // requires a LIVE `sideId`) no longer fires and the deleted admin's name
    // leaks through unmasked to non-privileged viewers. Every current
    // ADMIN_PERSONAL write path always stamps a real, non-null RECEIVER (the
    // employee/senior/drop being paid) — only the SENDER side can ever be null
    // under this funding marker — so this condition is safe for the receiver
    // side too; it is intentionally NOT scoped to sender-only so a future
    // write path can never silently reuse the marker asymmetrically and bypass
    // masking.
    const isOrphanedAdminPersonalPayer =
      fundingSource === 'ADMIN_PERSONAL' && (sideId === null || sideId === undefined)
    return isCompanyAccount || isAdminPartner || isOrphanedAdminPersonalPayer
  }

  private mapTx(tx: TxWithRelations, viewer: SessionUser) {
    // Only ADMIN/ACCOUNTANT may see the real identity of an internal company
    // party. All other roles get the brand + null id (RBAC, not CSS-hiding).
    const privileged = viewer.role === 'ADMIN' || viewer.role === 'ACCOUNTANT'

    const senderMasked =
      !privileged &&
      this.isInternalCompanySide(tx.senderId, tx.senderLabel, tx.sender?.role, tx.fundingSource)
    const receiverMasked =
      !privileged &&
      this.isInternalCompanySide(
        tx.receiverId,
        tx.receiverLabel,
        tx.receiver?.role,
        tx.fundingSource,
      )

    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      // task-salary-pay-amount — the OBLIGATION this row settled, kept
      // alongside the FACT of the payment above (`amount`/`currency`).
      // Deliberately NOT masked: these are the same amount that `amount`
      // already exposes to this viewer, merely in its pre-payment
      // denomination — masking one without the other would only make the two
      // numbers contradict each other. Counterparty masking (who paid whom)
      // is unaffected. NULL on every row not paid through this flow.
      originalAmount: tx.originalAmount,
      originalCurrency: tx.originalCurrency,
      exchangeRate: tx.exchangeRate,
      senderId: senderMasked ? null : tx.senderId,
      senderLabel: senderMasked ? 'CheekyCheeseIT' : tx.senderLabel,
      senderName: senderMasked ? null : (tx.sender?.displayName ?? null),
      receiverId: receiverMasked ? null : tx.receiverId,
      receiverLabel: receiverMasked ? 'CheekyCheeseIT' : tx.receiverLabel,
      receiverName: receiverMasked ? null : (tx.receiver?.displayName ?? null),
      projectId: tx.projectId,
      projectName: tx.project?.name ?? null,
      payoutRequestId: tx.payoutRequestId,
      // security-review PR #443 (MED-1, round 4): expose the SAME origin
      // marker settleByCompany's HIGH-1/MED-B guard authoritatively reads
      // (pending-settlement.service.ts), so the settle dialog can mirror the
      // server's actual decision instead of re-deriving a weaker,
      // FK-dependent approximation from payoutRequestId.
      dropCascadeOrigin: tx.dropCascadeOrigin,
      payoutRequest: tx.payoutRequest ?? null,
      seniorSharePercent: tx.seniorSharePercent,
      // task-team-senior-share-override. Snapshot source of the % above.
      // Legacy rows (created before column existed) return null and the UI
      // hides the source badge.
      seniorSharePercentSource: ((
        tx as Transaction & {
          seniorSharePercentSource?: string | null
        }
      ).seniorSharePercentSource ?? null) as 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null,
      receiptDocumentId: tx.receiptDocumentId,
      receiptExternalUrl: tx.receiptExternalUrl,
      txHash: tx.txHash,
      // task-onchain-payment-integrity. On-chain SENDER of the transfer behind
      // this row (payout settlement / company deposit) — recorded for audit,
      // never a gate. ADMIN/ACCOUNTANT only: it is investigation data, and the
      // same masking rationale as the counterparty/validatedBy fields applies
      // (a raw wallet address of another party must not leak to SENIOR/DROP).
      txFromAddress: privileged
        ? ((tx as Transaction & { txFromAddress?: string | null }).txFromAddress ?? null)
        : null,
      // RBAC identity-masking (follow-up to createdBy masking, security review
      // PR #385; same class as counterparty masking, PR #384). `validatedBy` is
      // the audit UUID of the validator — validation is ADMIN/ACCOUNTANT-only
      // (`PATCH /transactions/:id/validate` is @Roles('ADMIN','ACCOUNTANT')), so
      // a non-privileged viewer is NEVER the validator and the raw admin UUID
      // would otherwise leak on their own VALIDATED rows (e.g. a SENIOR seeing
      // which admin approved their SENIOR_INCOME). Disclose the real id ONLY to
      // ADMIN/ACCOUNTANT; for every other viewer strip it. Mirrors the
      // `createdBy` self-preserve form below for consistency (the
      // `=== viewer.id` branch never fires for validatedBy in practice — kept so
      // the two audit fields stay structurally identical and no future
      // self-validation path can silently leak).
      validatedBy: privileged || tx.validatedBy === viewer.id ? tx.validatedBy : null,
      validatedAt: tx.validatedAt ? tx.validatedAt.toISOString() : null,
      rejectionReason: tx.rejectionReason,
      notes: tx.notes,
      salaryMonth: tx.salaryMonth,
      txDate: tx.txDate ? tx.txDate.toISOString() : null,
      // Drop role - phase 2. Optional explicit recipient — populated on
      // PAYOUT_DROP today; null on every legacy row. Exposing on the DTO so
      // the frontend list/detail views can distinguish drop payouts cleanly.
      recipientId: (tx as Transaction & { recipientId?: string | null }).recipientId ?? null,
      // RBAC identity-masking (follow-up to counterparty masking, security
      // review PR #384). `createdBy` is the audit UUID of the registrar — an
      // ADMIN/ACCOUNTANT on virtually every row, or the SENIOR/DROP themselves
      // on self-declared income (createSeniorIncome / createDropIncome stamp
      // createdBy = receiverId = self). Disclose the real id ONLY to
      // ADMIN/ACCOUNTANT; for every other viewer strip it so a
      // SENIOR/JUNIOR/DROP/HR can never harvest which admin booked a payout.
      //
      // Exception — the viewer's OWN id is preserved: it leaks nothing (they
      // already know it) and it keeps the frontend author gate working
      // (`canAttachReceipt` treats `createdBy === currentUserId` as the author,
      // who may attach/replace a receipt on their own self-declared income).
      // A blank null here would silently remove that affordance for SENIOR/DROP.
      createdBy: privileged || tx.createdBy === viewer.id ? tx.createdBy : null,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
      // task-soft-delete-and-money-audit. No masking needed here: mapTx only
      // ever receives a deleted row for a privileged (ADMIN/ACCOUNTANT)
      // viewer — findAll's default query excludes deleted rows for everyone,
      // findOne's assertVisibleDespiteDeletion 404s a non-privileged caller
      // BEFORE mapTx is ever reached.
      deletedAt: tx.deletedAt ? tx.deletedAt.toISOString() : null,
      deletedBy: tx.deletedBy ?? null,
      deletionReason: tx.deletionReason ?? null,
    }
  }

  // ── Team override resolution (task-team-senior-share-override) ───────────
  //
  // The team-level senior share override applies only when *exactly one*
  // active team membership of the relevant principal carries a non-null
  // `seniorSharePercentOverride`. Multi-team ambiguity is intentionally
  // resolved by falling through to the user default (see resolver).
  //
  // Senior-project route: principal = `project.seniorId`; collect all active
  // memberships of the senior across teams (most seniors belong to a single
  // SENIOR-team, but they may temporarily belong to a DROP-team during
  // rotation — both are considered).
  //
  // Drop-project route: principal = `project.dropId`; the drop-team's
  // override governs how much the *senior assigned to this drop-project*
  // keeps. The drop's team is by definition the drop-team (type='DROP').

  /**
   * Public wrapper around the senior-share resolver — pre-fetches the active
   * teams for the senior, then calls the pure resolver. Exposed so callers
   * outside this service (e.g. PaymentChannelService for drop-projects) can
   * snapshot a `{ value, source }` pair with the same hierarchy semantics.
   *
   * Drop-project route: the senior in question is the project's *assigned
   * senior* (project.seniorId), and the team membership lookup is keyed on
   * that user. Drop-team memberships are considered alongside senior-teams
   * — both can carry an override that applies to the senior.
   */
  async resolveSeniorShareSnapshot(
    project: { seniorSharePercentOverride: number | null | undefined },
    senior: { id: string; seniorSharePercent: number | null | undefined },
  ): Promise<{ value: number; source: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' }> {
    const applicableTeams = await this.findActiveTeamsForUser(senior.id)
    return resolveSeniorShare(
      { seniorSharePercentOverride: project.seniorSharePercentOverride },
      { seniorSharePercent: senior.seniorSharePercent },
      applicableTeams,
    )
  }

  /**
   * Active team memberships for a given user — returns the team rows joined
   * through `team_members`. Only `leftAt IS NULL` rows are included so a
   * historical membership cannot accidentally apply an override.
   *
   * `archivedAt IS NULL` is enforced on the team side because an archived
   * team must never participate in a fresh override decision (the override
   * stays in DB for audit but does not apply to new income).
   */
  private async findActiveTeamsForUser(
    userId: string,
  ): Promise<{ id: string; seniorSharePercentOverride: number | null }[]> {
    // Use the relational query API instead of a raw `db.select(...).from(...)`
    // chain so existing service-spec mocks (which only stub
    // `db.query.<entity>.findFirst/findMany`) keep working without re-doing
    // every spec's mock surface. The query reaches the team rows via the
    // membership join, then JS-filters out archived teams — the dataset per
    // user is small (one or two teams in practice) so the secondary filter
    // is cheap.
    let rows: Array<{
      team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
    }> = []
    try {
      rows = (await this.db.db.query.teamMembers.findMany({
        where: and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)),
        with: { team: true },
      })) as unknown as Array<{
        team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
      }>
    } catch {
      // Defensive fallback for test mocks that don't stub
      // `query.teamMembers.findMany` — treat as "no team memberships". The
      // resolver then simply falls through to project / user-default.
      rows = []
    }

    return rows
      .filter((r) => r.team && r.team.archivedAt === null)
      .map((r) => ({
        id: r.team.id,
        seniorSharePercentOverride: r.team.seniorSharePercentOverride ?? null,
      }))
  }

  // ── Distribution helpers (Drop role - phase 2) ───────────────────────────
  //
  // Pure helpers — no DB writes, no side-effects. The drop-project flow
  // branches on `project.dropId` and calls `computeDropDistribution` to split
  // a drop-project income into the senior + drop slices. The remainder
  // (income − senior − drop) is NOT split here — it stays on the company
  // account (task-drop-payout-company-account; the legacy 50/50 partner split
  // helper `computePartnersSplit` was removed with the payment-channel flow).

  /**
   * Phase 8 v2 — convert a scaled-integer (minor units, ×1e6) amount in a source
   * currency into USDT minor units, using NBU UAH cross-rates.
   *
   * USDT is pegged 1:1 to USD (NbuCurrencyService returns usdtUah === usdUah),
   * so:
   *   - USDT / USD → identity (1 USD == 1 USDT).
   *   - EUR  → USDT: amount * (eurUah / usdUah)  (EUR→UAH→USD≡USDT).
   *   - UAH  → USDT: amount / usdUah.
   *
   * Integer-domain arithmetic on the scaled minor units (no float accumulation):
   * we multiply by the rate ratio with a single Math.round, mirroring the
   * decimal-safe aggregation used elsewhere in createPayoutRequest.
   *
   * `rates` is fetched ONCE per payout (today's NBU snapshot) and passed in so
   * the conversion is deterministic across the whole batch.
   */
  private convertToUsdtMinor(
    amountMinor: number,
    // code-review LOW: strict currency union (canonical `CurrencyEnum` from
    // @crm/shared = 'USDT' | 'USD' | 'EUR' | 'UAH') instead of bare `string`,
    // so the switch is exhaustive at compile time and an unsupported currency
    // is a type error at the call site, not a runtime surprise. The default
    // branch is kept as a defensive runtime backstop for data that bypasses the
    // Zod boundary (e.g. a legacy DB row outside the enum).
    currency: CurrencyEnum,
    rates: { usdUah: number; eurUah: number },
  ): number {
    switch (currency) {
      case 'USDT':
      case 'USD':
        return amountMinor
      case 'EUR':
        return Math.round((amountMinor * rates.eurUah) / rates.usdUah)
      case 'UAH':
        return Math.round(amountMinor / rates.usdUah)
      default:
        throw new BadRequestException(
          `Неподдерживаемая валюта для конверсии в USDT: ${String(currency)}`,
        )
    }
  }

  /**
   * Distribute a drop-project's incoming amount across senior, drop, and the
   * two admin partners. Spec §8.1 example for income $1000, senior 26%,
   * drop 5%:
   *   senior: 260, drop: 50, partners: [345, 345].
   *
   * Inputs:
   *   - income — gross amount that landed on the DROP from the client.
   *   - project — drop-project row (must have `dropId !== null` — caller
   *     verifies before invoking). Reserved for future per-project overrides.
   *   - drop — DROP user row (read `dropSharePercent`, default 5).
   *   - senior — SENIOR user row (read `seniorSharePercent`, default 26).
   *
   * Errors:
   *   - Throws `BadRequestException` if senior + drop percents exceed 100.
   *     This is a deliberate guard — the spec keeps both shares additive
   *     against the gross, so >100% is a configuration bug, not a math one.
   *
   * Returns a pure JS object — no DB writes. The caller threads the result
   * into `db.transaction(...)` and inserts one transaction per share.
   */
  computeDropDistribution(
    income: number,
    _project: { id: string; dropId: string | null },
    drop: { id: string; dropSharePercent: number | null },
    senior: { id: string; seniorSharePercent: number | null },
  ): {
    seniorShare: { amount: number; percent: number }
    dropShare: { amount: number; percent: number }
  } {
    const seniorPercent = senior.seniorSharePercent ?? DEFAULT_SENIOR_SHARE_PERCENT
    const dropPercent = drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT

    if (seniorPercent + dropPercent > 100) {
      throw new BadRequestException('Sum of senior+drop shares exceeds 100%')
    }

    // Decimal-safe share math (see roundShareAmount) — scale to integer minor
    // units, round once, divide back. Shared with bookCompanyObligations so the
    // admin-USDT obligation amounts match this drop-payout path exactly.
    const seniorAmount = roundShareAmount(income, seniorPercent)
    const dropAmount = roundShareAmount(income, dropPercent)

    // task-drop-payout-company-account: `partnerShares` (the old 50/50
    // remainder split into PAYOUT_ADMIN) is removed. The remainder
    // (income − senior − drop) now stays on the COMPANY account (credited via
    // the PAYOUT row's fundingSource marker); admin income is a deliberate
    // manual DIVIDEND_TO_ADMIN flow, not an auto split. Only the senior and
    // drop slices are returned.
    return {
      seniorShare: { amount: seniorAmount, percent: seniorPercent },
      dropShare: { amount: dropAmount, percent: dropPercent },
    }
  }

  /**
   * Per-DROP financial aggregate — single source of truth shared by the
   * admin/accountant `getSummary` (full list of every drop) and the
   * self-only `getDropSelfSummary` (one drop). Pure function over already
   * fetched transaction rows — no DB round-trips, no RBAC (callers gate).
   *
   * Drop role - phase 1 (task-drop-1-backend). Extracted from the inline
   * `dropBalances.map(...)` in `getSummary` WITHOUT changing its semantics:
   *   - `balance`             — Σ PAYOUT_DROP received − sent (the slice the
   *                             drop keeps), scaled-integer to avoid float drift.
   *   - `dropSharePercent`    — `drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT`.
   *   - `pendingCount`        — DROP_INCOME rows with `receiverId = drop.id` in
   *                             PENDING|VALIDATED status (the «N ожидают» badge).
   *
   * NEW fields (additive, only consumed by the drop self-summary; the admin
   * summary maps them away so its DTO/tests are unaffected):
   *   - `debtToCompany`       — what the drop still owes the company for
   *                             VALIDATED-but-unsettled incomes.
   *   - `pendingObligationAmount` / `pendingObligationCount` —
   *                             task-drop-sees-own-obligations. The REVERSE
   *                             direction: what the COMPANY owes THIS drop,
   *                             booked but not yet paid out.
   *
   * debtToCompany formula (derived from the DROP_INCOME → company lifecycle,
   * see `validateTransaction` + `PaymentChannelService`):
   *   At DROP_INCOME validation a placeholder PAYOUT row is booked with
   *   `senderId = drop.id`, `status = 'PENDING_PAYMENT'`,
   *   `amount = income × (1 − dropSharePercent/100)`. The drop pays the company
   *   via crypto/cash confirm, which flips that PAYOUT row → 'PAID'. Therefore
   *   the outstanding company debt is exactly the sum of the drop's PAYOUT
   *   rows still in 'PENDING_PAYMENT'. This reads the BOOKED payable directly
   *   (rather than recomputing share math), so it stays correct even if a
   *   future income carries a per-row share override.
   *
   * pendingObligationAmount formula (task-drop-sees-own-obligations — see
   * `bookCompanyObligations`): the admin-USDT declare path and the drop-payout
   * cascade both book a DROP_PENDING_PAYOUT row (`receiverId = drop.id`,
   * `status = 'PENDING_PAYMENT'`) the moment the company recognizes the
   * drop's share is owed. `settleByCompany` (pending-settlement.service.ts)
   * later flips that SAME row IN PLACE to `PAYOUT_DROP`/`PAID` — never a
   * second row — so the outstanding pending-obligation total is exactly the
   * sum of the drop's DROP_PENDING_PAYOUT rows still in 'PENDING_PAYMENT'.
   * Deliberately NOT added into `balance` (§AC2 — accrued ≠ paid).
   */
  private computeDropAggregate(
    drop: { id: string; displayName: string; dropSharePercent: number | null },
    allTxs: Array<{
      type: string
      status: string
      amount: string
      // Audit 2026-06-28 (#4): the row currency is required so the balance is
      // aggregated in a single base. Optional for older callers/stubs that pass
      // USD/USDT-only ledgers; absent → treated as USD (identity). The admin
      // summary + drop self-summary now always pass it.
      currency?: string
      senderId: string | null
      receiverId: string | null
    }>,
    // NBU rate snapshot for the cross-currency → USD conversion. Optional so a
    // single-currency (prod USDT/USD) caller can omit it; convertToBase short-
    // circuits USD/USDT to identity, so omitting rates only affects EUR/UAH rows.
    rates?: ExchangeRateResult,
  ): {
    userId: string
    displayName: string
    balance: number
    dropSharePercent: number
    pendingCount: number
    debtToCompany: number
    pendingObligationAmount: number
    pendingObligationCount: number
  } {
    const paid = allTxs.filter((tx) => tx.status === 'PAID')

    // Audit 2026-06-28 (#4): convert each amount to base (USD) BEFORE scaling so a
    // mixed-currency drop ledger sums coherently. USD/USDT → byte-exact identity.
    //
    // security-review PR #521 round 3 (MED-B): a DROP settle's `amount` is
    // ALWAYS re-converted at the CURRENT rate on every read here — uniformly
    // with every other reader (`getTotalEarned`, `adminBalances.sent` in this
    // same file). An earlier revision pinned a currency-converted settle to
    // its booked `original_amount`/`original_currency` snapshot (USDT) so an
    // already-closed obligation would not drift as NBU rates moved. Per the
    // owner's explicit decision ("везде по сегодняшнему курсу"), that pinning
    // is reverted: the SAME transaction must read as the SAME number
    // everywhere in the app, and every OTHER balance reader already
    // reconverts at today's rate — pinning only this one path made it the
    // odd one out, not the correct one. `original_amount`/`original_currency`
    // stay on the schema as a fact record of what was actually paid (see
    // settleByCompany) — just no longer consulted by aggregation.
    const baseAmount = (tx: { amount: string; currency?: string }): number =>
      rates
        ? convertToBase(
            parseFloat(tx.amount),
            (tx.currency ?? 'USD') as BalanceCurrency,
            'USD',
            rates,
          )
        : parseFloat(tx.amount)

    const receivedScaled = paid
      .filter((tx) => tx.receiverId === drop.id && tx.type === 'PAYOUT_DROP')
      .reduce((sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE), 0)
    const sentScaled = paid
      .filter((tx) => tx.senderId === drop.id && tx.type === 'PAYOUT_DROP')
      .reduce((sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE), 0)

    // pendingCount: DROP_INCOME rows for this drop still awaiting validation.
    // createDropIncome sets receiverId = drop.id (drop is the recipient),
    // senderId = null (external client). HIGH#2 fix: match on receiverId.
    const pendingCount = allTxs.filter(
      (tx) =>
        tx.type === 'DROP_INCOME' &&
        tx.receiverId === drop.id &&
        (tx.status === 'PENDING' || tx.status === 'VALIDATED'),
    ).length

    // debtToCompany: placeholder PAYOUT rows booked at validation that the
    // company-payment step has not yet flipped to PAID. senderId = drop.id.
    const debtScaled = allTxs
      .filter(
        (tx) => tx.type === 'PAYOUT' && tx.senderId === drop.id && tx.status === 'PENDING_PAYMENT',
      )
      .reduce((sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE), 0)

    // task-drop-sees-own-obligations: pendingObligationAmount — DROP_PENDING_PAYOUT
    // rows booked FOR this drop (receiverId = drop.id) that the company has not
    // yet settled (settleByCompany flips the SAME row to PAYOUT_DROP/PAID — see
    // this method's docstring). This is the reverse leg of debtToCompany above.
    const pendingObligationRows = allTxs.filter(
      (tx) =>
        tx.type === 'DROP_PENDING_PAYOUT' &&
        tx.receiverId === drop.id &&
        tx.status === 'PENDING_PAYMENT',
    )
    const pendingObligationScaled = pendingObligationRows.reduce(
      (sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE),
      0,
    )

    return {
      userId: drop.id,
      displayName: drop.displayName,
      balance: (receivedScaled - sentScaled) / MONEY_SCALE,
      dropSharePercent: drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT,
      pendingCount,
      debtToCompany: debtScaled / MONEY_SCALE,
      pendingObligationAmount: pendingObligationScaled / MONEY_SCALE,
      pendingObligationCount: pendingObligationRows.length,
    }
  }

  /**
   * Self-only DROP summary for `GET /api/finance/drop/me/summary`.
   *
   * Drop role - phase 1 (task-drop-1-backend). RBAC: DROP only — every other
   * role (SENIOR / JUNIOR / HR / ACCOUNTANT / ADMIN) gets 403. The drop only
   * ever sees THEIR OWN aggregate — the method filters the ledger to the
   * caller's own rows inside `computeDropAggregate(self, …)`, so no other
   * drop's balance / debt can leak out of this endpoint.
   */
  async getDropSelfSummary(currentUser: SessionUser): Promise<{
    balance: number
    dropSharePercent: number
    pendingIncomesCount: number
    debtToCompany: number
    pendingObligationAmount: number
    pendingObligationCount: number
  }> {
    if (currentUser.role !== 'DROP') {
      throw new ForbiddenException('Access denied: drop summary is available to DROP role only')
    }

    const self = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!self) throw new NotFoundException('Drop user not found')

    // task-soft-delete-and-money-audit (AC4): a deleted row must not move the
    // drop's own balance/debt figures.
    //
    // security-review PR #523 round 1 (MED-1): scoped at the SQL level instead
    // of pulling the WHOLE `transactions` table into memory for a single
    // drop's summary. `computeDropAggregate` only ever reads a row where
    // (receiverId = self OR senderId = self) AND type is one of these four —
    // every one of its four filters (balance/pendingCount/debtToCompany/
    // pendingObligationAmount) requires BOTH conditions, so this predicate is
    // exactly equivalent to the old unscoped scan, never a behaviour change —
    // it just stops fetching every OTHER drop's/senior's/admin's rows too.
    const allTxs = (await this.db.db.query.transactions.findMany({
      where: and(
        isNull(transactions.deletedAt),
        or(eq(transactions.receiverId, self.id), eq(transactions.senderId, self.id)),
        inArray(transactions.type, ['PAYOUT_DROP', 'DROP_INCOME', 'PAYOUT', 'DROP_PENDING_PAYOUT']),
      ),
    })) as Array<{
      type: string
      status: string
      amount: string
      currency?: string
      senderId: string | null
      receiverId: string | null
    }>

    // Audit 2026-06-28 (#4): pass the NBU snapshot so a mixed-currency drop ledger
    // aggregates in one base. USD/USDT short-circuits to identity in convertToBase.
    const rates = await this.nbuCurrency.getRates()
    const aggregate = this.computeDropAggregate(
      { id: self.id, displayName: self.displayName, dropSharePercent: self.dropSharePercent },
      allTxs,
      rates,
    )

    return {
      balance: aggregate.balance,
      dropSharePercent: aggregate.dropSharePercent,
      pendingIncomesCount: aggregate.pendingCount,
      debtToCompany: aggregate.debtToCompany,
      pendingObligationAmount: aggregate.pendingObligationAmount,
      pendingObligationCount: aggregate.pendingObligationCount,
    }
  }

  /**
   * Map a raw DB `transaction_status` to the FE-facing income status. The four
   * states a DROP_INCOME row can carry in its lifecycle are PENDING / VALIDATED
   * / PAID / REJECTED; any other DB status (PENDING_PAYMENT etc. — which belong
   * to PAYOUT rows, never DROP_INCOME rows) is not expected, so we surface it
   * as 'pending' defensively rather than leaking the internal enum. Single
   * source of truth so incomes feed + any future drop income view agree.
   */
  private mapDropIncomeStatus(dbStatus: string): DropIncomeStatus {
    switch (dbStatus) {
      case 'VALIDATED':
        return 'validated'
      case 'PAID':
        return 'paid'
      case 'REJECTED':
        return 'rejected'
      case 'PENDING':
      default:
        return 'pending'
    }
  }

  /**
   * task-drop-sees-own-obligations. Map a DROP_PENDING_PAYOUT / PAYOUT_DROP
   * row's raw DB `transaction_status` to the SAME FE-facing `DropIncomeStatus`
   * enum `mapDropIncomeStatus` uses — the incomes feed shows both income
   * models side by side (discriminated by `model`), so they share one status
   * vocabulary. Only two states are actually reachable on this pair: the row
   * is booked PENDING_PAYMENT and later settled IN PLACE to PAYOUT_DROP/PAID
   * (see `bookCompanyObligations` + `pending-settlement.service.ts`) — there
   * is no accountant-validation step for an obligation row, so 'validated' is
   * never produced here (that state is exclusively a DROP_INCOME lifecycle
   * step). REJECTED is defensive (not currently emitted by either booking
   * path) — kept explicit rather than silently defaulting, same rationale as
   * `mapDropPaymentStatus`'s PENDING_CASH_CONFIRM case below.
   */
  private mapDropObligationStatus(dbStatus: string): DropIncomeStatus {
    switch (dbStatus) {
      case 'PAID':
        return 'paid'
      case 'REJECTED':
        return 'rejected'
      // Stryker disable next-line StringLiteral: a PROVABLY equivalent mutant,
      // not an untested one — this case's body is IDENTICAL to `default`
      // immediately below it (both `return 'pending'`), so no input can ever
      // distinguish "this case label present" from "this case label removed
      // entirely". Kept only as explicit, self-documenting notation of which
      // one DB status this branch means to represent (mirrors the same
      // deliberately-redundant `case 'PENDING_PAYMENT': default:` shape
      // already established in the sibling `mapDropPaymentStatus` below, and
      // the same `case 'PENDING'` default-fallthrough pattern in
      // `mapDropIncomeStatus` above) — removing the label to "simplify" would
      // make a future reader re-derive from scratch which status this
      // fallthrough is meant to cover.
      case 'PENDING_PAYMENT':
      default:
        return 'pending'
    }
  }

  /**
   * Map a raw DB `transaction_status` to the FE-facing payment status for a
   * drop → company PAYOUT row. The placeholder PAYOUT booked at income
   * validation starts PENDING_PAYMENT (→ pending), flips to PAID on company
   * settlement (→ confirmed); REJECTED (→ failed). Anything else surfaces as
   * 'pending' defensively.
   *
   * PENDING_CASH_CONFIRM is the phase 4-B cash-payment confirmation gate:
   * semantically it is still a "waiting" state (company has not yet settled),
   * so it maps to 'pending'. Declared explicitly — NOT via the silent default —
   * so that if the mapping needs to diverge in phase 4-B it is immediately
   * visible here rather than buried in a catch-all. Fix: MED security finding.
   *
   * Remaining reachable PAYOUT statuses from the DB enum:
   *   PENDING_PAYMENT → pending  (normal pre-settlement state)
   *   PAID            → confirmed
   *   REJECTED        → failed
   *   PENDING_CASH_CONFIRM → pending  (phase 4-B cash gate, explicit)
   * Unreachable on PAYOUT but present in the enum (LOCKED / PENDING /
   * VALIDATED — income/interview lifecycle statuses) fall through to the
   * defensive default.
   */
  private mapDropPaymentStatus(dbStatus: string): DropPaymentStatus {
    switch (dbStatus) {
      case 'PAID':
        return 'confirmed'
      case 'REJECTED':
        return 'failed'
      // Phase 4-B cash-payment confirmation gate — semantically still pending;
      // explicit to prevent silent mis-attribution when phase 4-B ships.
      case 'PENDING_CASH_CONFIRM':
        return 'pending'
      case 'PENDING_PAYMENT':
      default:
        return 'pending'
    }
  }

  /**
   * Self-only DROP income feed for `GET /api/finance/drop/me/incomes`.
   *
   * Drop role - phase 2 (task-drop-2-backend). RBAC: DROP only — every other
   * role gets 403. The drop only ever sees THEIR OWN incomes — the query is
   * scoped to `receiverId = self.id` at the DB level, so no other drop's
   * income can leak. Supports status / date-window filters and offset
   * pagination; `total` is the count BEFORE the page slice.
   *
   * task-drop-sees-own-obligations: the feed covers BOTH income models a drop
   * can carry — `DROP_INCOME` is `receiverId`-scoped by design (see
   * `createDropIncome`); `receiverId` is likewise the invariant for every
   * DROP_PENDING_PAYOUT / PAYOUT_DROP row (`bookCompanyObligations` always
   * sets `receiverId: drop.id`), so ONE `receiverId = self.id` predicate
   * safely covers all three types — no widening of WHO can be seen, only of
   * WHICH of the caller's OWN rows are included (§AC5).
   *   - 'DROP_INCOME'                    → the old self-declared model.
   *   - 'DROP_PENDING_PAYOUT'/'PAYOUT_DROP' → the SAME obligation row across
   *     its lifecycle (booked PENDING_PAYMENT, settled IN PLACE to PAYOUT_DROP
   *     PAID — never two rows for one obligation), from the admin-USDT
   *     declare path or the drop-payout cascade.
   * `model` on the returned DTO discriminates which one produced each row.
   *
   * `companyName`: for a DROP_INCOME row, sourced from `senderLabel` (set to
   * `project.companyName` at creation), falling back to the linked project's
   * companyName, then ''. For an obligation row `senderLabel` is always the
   * literal 'COMPANY' marker (see `bookCompanyObligations`), which is not a
   * company name — those rows use `companyNameSnapshot` (frozen at booking
   * time — security-review PR #523 round 1, MED-4: a live `project.companyName`
   * join would let a LATER project rename silently rewrite the company name on
   * money already booked under the old one), falling back to the live
   * `project.companyName` join only for the rare pre-migration row that
   * predates the snapshot column (NULL), then '' if even the project link is
   * gone.
   */
  async getDropSelfIncomes(
    currentUser: SessionUser,
    query: DropIncomesQuery,
  ): Promise<PaginatedDropIncomes> {
    if (currentUser.role !== 'DROP') {
      throw new ForbiddenException('Access denied: drop incomes are available to DROP role only')
    }

    // Self-scope at the DB level: only this drop's rows across BOTH income
    // models (see docstring). AC2: DROP is non-privileged — a deleted own
    // income must not resurface here.
    const rows = await this.db.db.query.transactions.findMany({
      where: and(
        inArray(transactions.type, ['DROP_INCOME', 'DROP_PENDING_PAYOUT', 'PAYOUT_DROP']),
        eq(transactions.receiverId, currentUser.id),
        isNull(transactions.deletedAt),
      ),
      orderBy: [desc(transactions.createdAt)],
      with: { project: { columns: { companyName: true } } },
    })

    // In-memory status + date-window filters (the feed per drop is small;
    // pushing these to SQL would not change correctness and keeps the status
    // mapping in one place). The status filter compares the MAPPED status so
    // the FE contract (pending|validated|paid|rejected) is honoured, for
    // EITHER model.
    const fromTs = query.from ? Date.parse(query.from) : undefined
    // `to` is a YYYY-MM-DD date string: Date.parse gives midnight UTC (start of
    // that day). Add 86_399_999 ms (= 23:59:59.999) so that incomes created
    // anywhere during the last requested day are included — not just those at
    // exactly 00:00:00 UTC. Fix: MED review finding code-review-2.
    const toTs = query.to ? Date.parse(query.to) + 86_399_999 : undefined

    const mappedStatusOf = (tx: { type: string; status: string }): DropIncomeStatus =>
      tx.type === 'DROP_INCOME'
        ? this.mapDropIncomeStatus(tx.status)
        : this.mapDropObligationStatus(tx.status)

    const filtered = rows.filter((tx) => {
      if (query.status && mappedStatusOf(tx) !== query.status) return false
      const created =
        tx.createdAt instanceof Date ? tx.createdAt.getTime() : Date.parse(String(tx.createdAt))
      if (fromTs !== undefined && !Number.isNaN(fromTs) && created < fromTs) return false
      if (toTs !== undefined && !Number.isNaN(toTs) && created > toTs) return false
      return true
    })

    const total = filtered.length
    const start = (query.page - 1) * query.limit
    const pageRows = filtered.slice(start, start + query.limit)

    const items: DropIncomeDto[] = pageRows.map((tx) => ({
      id: tx.id,
      companyName:
        tx.type === 'DROP_INCOME'
          ? (tx.senderLabel ?? tx.project?.companyName ?? '')
          : (tx.companyNameSnapshot ?? tx.project?.companyName ?? ''),
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      createdAt:
        tx.createdAt instanceof Date
          ? tx.createdAt.toISOString()
          : new Date(tx.createdAt).toISOString(),
      status: mappedStatusOf(tx),
      model: tx.type === 'DROP_INCOME' ? 'declared' : 'obligation',
    }))

    return { items, total, page: query.page, limit: query.limit }
  }

  /**
   * Self-only DROP outgoing-payments feed for
   * `GET /api/finance/drop/me/payments`.
   *
   * Drop role - phase 2 (task-drop-2-backend). RBAC: DROP only — every other
   * role gets 403. Lists the PAYOUT rows the drop owes / has paid the company,
   * scoped to `type = 'PAYOUT' AND senderId = self.id` at the DB level (same
   * rows that feed `debtToCompany` in `computeDropAggregate`), so no other
   * drop's payments can leak.
   */
  async getDropSelfPayments(currentUser: SessionUser): Promise<DropPaymentDto[]> {
    if (currentUser.role !== 'DROP') {
      throw new ForbiddenException('Access denied: drop payments are available to DROP role only')
    }

    const rows = await this.db.db.query.transactions.findMany({
      where: and(eq(transactions.type, 'PAYOUT'), eq(transactions.senderId, currentUser.id)),
      orderBy: [desc(transactions.createdAt)],
    })

    return rows.map((tx) => ({
      id: tx.id,
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      ...(tx.txHash ? { txHash: tx.txHash } : {}),
      status: this.mapDropPaymentStatus(tx.status),
      createdAt:
        tx.createdAt instanceof Date
          ? tx.createdAt.toISOString()
          : new Date(tx.createdAt).toISOString(),
    }))
  }

  async findAll(
    currentUser: SessionUser,
    filters?: {
      type?: string
      status?: string
      projectId?: string
      seniorId?: string
      month?: string
      /**
       * task-soft-delete-and-money-audit (AC3). «Показать удалённые» toggle.
       * Default (undefined/false): the list NEVER includes a deleted row, for
       * ANY role — including ADMIN/ACCOUNTANT. Only when a privileged caller
       * explicitly passes `true` do deleted rows appear alongside active ones
       * (each still carrying `deletedAt`/`deletedBy`/`deletionReason` so the
       * UI can render them distinctly). A non-privileged caller passing this
       * is silently ignored — deleted rows stay excluded regardless (AC2
       * takes precedence; there is no role check needed here because the
       * filter only ever WIDENS the query, never narrows RBAC).
       */
      includeDeleted?: boolean
    },
  ) {
    const privileged = currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT'
    const showDeleted = privileged && filters?.includeDeleted === true

    const allTxs = (await this.db.db.query.transactions.findMany({
      ...(showDeleted ? {} : { where: isNull(transactions.deletedAt) }),
      orderBy: [desc(transactions.createdAt)],
      with: {
        // task-counterparty-role-masking: `role` drives ADMIN-party masking in mapTx.
        sender: { columns: { displayName: true, role: true } },
        receiver: { columns: { displayName: true, role: true } },
        project: { columns: { name: true } },
      },
    })) as TxWithRelations[]

    let result = allTxs

    // RBAC filtering
    if (currentUser.role === 'SENIOR') {
      // Drop role - phase 3: PAYOUT_CONFIRMED rows live on the admin side of
      // the ledger (manual confirmation step). SENIOR/DROP must not see them
      // for the same reason PAYOUT_ADMIN is filtered out — these rows expose
      // partner attribution that's none of their business.
      result = result.filter(
        (tx) =>
          (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
          tx.type !== 'PAYOUT_ADMIN' &&
          tx.type !== 'PAYOUT_CONFIRMED',
      )
    } else if (currentUser.role === 'JUNIOR') {
      result = result.filter((tx) => tx.receiverId === currentUser.id)
    } else if (currentUser.role === 'HR') {
      // HR sees only their own transactions (where they are sender or receiver).
      // HR must NOT see all SALARY-type rows — that would leak salary amounts
      // of other employees (F1 RBAC fix, OWASP A01).
      result = result.filter(
        (tx) => tx.receiverId === currentUser.id || tx.senderId === currentUser.id,
      )
    } else if (currentUser.role === 'DROP') {
      // Drop role - phase 1 (AC1, security): DROP must only see transactions
      // where they are the sender or receiver — never other seniors' income,
      // payouts, expenses, or junior salaries. In Phase 1 the drop has no
      // dedicated transactions yet (distribution lands in Phase 2), so this
      // filter typically yields an empty list. Phase 2 will attach
      // transactions to dropId/seniorId and this same filter naturally
      // surfaces them. Same `PAYOUT_ADMIN` exclusion as SENIOR so dropping
      // a row from an admin payout never leaks the admin balance.
      result = result.filter(
        (tx) =>
          (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
          tx.type !== 'PAYOUT_ADMIN' &&
          tx.type !== 'PAYOUT_CONFIRMED',
      )
    }
    // ADMIN, ACCOUNTANT see all

    // Apply optional filters
    if (filters?.type) result = result.filter((tx) => tx.type === filters.type)
    if (filters?.status) result = result.filter((tx) => tx.status === filters.status)
    if (filters?.projectId) result = result.filter((tx) => tx.projectId === filters.projectId)
    if (filters?.seniorId) {
      result = result.filter(
        (tx) => tx.senderId === filters.seniorId || tx.receiverId === filters.seniorId,
      )
    }
    if (filters?.month) result = result.filter((tx) => tx.salaryMonth === filters.month)

    return result.map((tx) => this.mapTx(tx, currentUser))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const tx = (await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
      with: {
        // task-counterparty-role-masking: `role` drives ADMIN-party masking in mapTx.
        sender: { columns: { displayName: true, role: true } },
        receiver: { columns: { displayName: true, role: true } },
        project: { columns: { name: true } },
        payoutRequest: {
          columns: { seniorId: true, incomeAmount: true, payableAmount: true },
        },
      },
    })) as TxWithRelations | undefined

    if (!tx) throw new NotFoundException('Transaction not found')
    // AC2: hidden from every non-ADMIN/ACCOUNTANT viewer, regardless of
    // ownership — MUST run before assertReadAccess (see that guard's doc).
    assertTransactionVisible(tx, currentUser)
    this.assertReadAccess(tx, currentUser)
    // (masking of the internal counterparty happens in mapTx below via `currentUser`)

    // Enrich payoutRequest with seniorSharePercent snapshot from first linked income tx
    if (tx.payoutRequest && tx.payoutRequestId) {
      const firstIncome = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.payoutRequestId, tx.payoutRequestId),
          eq(transactions.type, 'SENIOR_INCOME'),
        ),
      })
      if (firstIncome) {
        const firstIncomeSource = (
          firstIncome as Transaction & {
            seniorSharePercentSource?: string | null
          }
        ).seniorSharePercentSource
        tx.payoutRequest = {
          ...tx.payoutRequest,
          seniorSharePercent: firstIncome.seniorSharePercent,
          // task-team-senior-share-override. Propagate the source from the
          // originating SENIOR_INCOME so PayoutContent renders the badge.
          seniorSharePercentSource: (firstIncomeSource ?? null) as
            | 'PROJECT'
            | 'TEAM'
            | 'USER_DEFAULT'
            | null,
        }
      }
    }

    return this.mapTx(tx, currentUser)
  }

  // ── Create ADMIN_INCOME ──────────────────────────────────────────────────

  async createAdminIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
      // task-admin-income-unified: REPLACES the old `fundingSource` toggle.
      // Same contract as `declareUsdtProjectIncome`'s `receiverId` — an active
      // ADMIN's uuid credits THAT admin personally; the COMPANY_ACCOUNT_RECEIVER
      // sentinel credits the shared pool. Absent → legacy default (see below).
      // ACCOUNTANT sending an explicit value here is a contract violation, not
      // a routing preference — rejected outright (see the RBAC block below).
      receiverId?: string | undefined
    },
    currentUser: SessionUser,
  ) {
    // task-accountant-create-transaction. ACCOUNTANT has create-parity with
    // ADMIN for ADMIN_INCOME — but ONLY as a recorder. Eligibility (which
    // PROJECT a caller may declare income for) is unchanged by
    // task-admin-income-unified:
    //   - ADMIN caller: project must be their own (seniorId === self).
    //   - ACCOUNTANT caller: may register on ANY admin-owned project (the
    //     project's senior must be an ADMIN). The accountant is the recorder
    //     (createdBy), never the recipient — enforced below, independent of
    //     project eligibility.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT')
      throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')

    let projectOwnerId: string
    if (currentUser.role === 'ADMIN') {
      if (project.seniorId !== currentUser.id) {
        throw new ForbiddenException('You can only add income for your own projects')
      }
      projectOwnerId = currentUser.id
    } else {
      // ACCOUNTANT: the project must belong to an ADMIN (ADMIN_INCOME is income
      // owned by an admin partner).
      const owner = await this.db.db.query.users.findFirst({
        where: eq(users.id, project.seniorId),
      })
      if (!owner || owner.role !== 'ADMIN') {
        throw new ForbiddenException(
          'ADMIN_INCOME can only be registered for an admin-owned project',
        )
      }
      projectOwnerId = owner.id
    }

    // task-admin-income-unified (§2, owner decision 2026-08-12). WHO gets
    // credited is now a SEPARATE choice from project eligibility above — but
    // picking a SPECIFIC admin is ADMIN-only. The ACCOUNTANT has never been a
    // router of funds (the server has always hard-credited the project's
    // admin owner for this role); the web dialog's selector reflects that by
    // only ever offering "project owner" (no receiverId) or "company account"
    // (the sentinel — not a specific-admin choice, still allowed for this
    // role, same capability the old `fundingSource` toggle already had). A
    // payload naming a SPECIFIC admin disagrees with the UI's constraint and
    // is rejected, not silently coerced.
    if (
      currentUser.role === 'ACCOUNTANT' &&
      data.receiverId !== undefined &&
      data.receiverId !== COMPANY_ACCOUNT_RECEIVER
    ) {
      throw new ForbiddenException('ACCOUNTANT cannot choose who receives ADMIN_INCOME')
    }

    let receiverId: string
    let fundingSource: 'COMPANY_ACCOUNT' | null
    if (data.receiverId === undefined) {
      // Legacy default — unchanged behaviour: credit the project's owner.
      receiverId = projectOwnerId
      fundingSource = null
    } else if (data.receiverId === COMPANY_ACCOUNT_RECEIVER) {
      // Mirrors declareUsdtProjectIncome: the CALLER becomes the nominal
      // receiverId (audit trail — who recorded it), fundingSource marks the
      // ACTUAL destination (the shared pool, not that person's balance).
      receiverId = currentUser.id
      fundingSource = 'COMPANY_ACCOUNT'
    } else {
      // ADMIN caller only (the ACCOUNTANT branch above already threw). Same
      // "active ADMIN" validation declareUsdtProjectIncome already applies.
      const receiver = await this.db.db.query.users.findFirst({
        where: eq(users.id, data.receiverId),
      })
      if (!receiver || receiver.role !== 'ADMIN' || receiver.archivedAt) {
        throw new BadRequestException('Получатель должен быть активным администратором')
      }
      receiverId = receiver.id
      fundingSource = null
    }

    // task-admin-income-unified (was task-admin-income-payment-type-guard —
    // the owner rewrote the task 2026-08-12 mid-implementation from "add a
    // check" to "remove the choice that needed checking": the web dialog no
    // longer offers a separate USDT form the caller could pick wrong, it
    // decides `createAdminIncome` vs `declareUsdtProjectIncome` itself from
    // `project.paymentType`). This throw is what remains of the original
    // fix — AC4's invariant, now enforced as defense-in-depth: the UI cannot
    // reach this branch for a USDT project (it always routes to
    // `declareUsdtProjectIncome` instead), but nothing stops a direct API
    // call from trying, and a USDT-payment project books obligations to its
    // senior/drop ONLY through `declareUsdtProjectIncome`
    // (`bookCompanyObligations` runs inside THAT transaction; this path never
    // calls it) — that gap is exactly what happened in prod (GamingTec,
    // 4708.69 USDT, no drop share). Gated on `project.paymentType`, not on
    // `data.currency`/`receiverId` — a FOP/GIG project routed into the
    // company-account pool (currency forced to USDT for THIS transaction) is
    // unaffected; only a project whose OWN payment type is USDT is rejected.
    if (project.paymentType === 'USDT') {
      throw new BadRequestException(
        'USDT-проекты не создают доход через этот маршрут — используйте объявление USDT-прихода (declareUsdtProjectIncome), которое бронирует доли синьора и дропа вместе с доходом',
      )
    }

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller
    // boundary. Effective currency = USDT for a company-account income (USDT-only
    // pool) → explorer-only; else the supplied currency → file/url.
    const adminIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      fundingSource === 'COMPANY_ACCOUNT' ? 'USDT' : data.currency,
    )
    if (adminIncomeReceiptErr) throw new BadRequestException(adminIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    // task-salary-company-account (routing preserved, resolution moved above).
    // When COMPANY_ACCOUNT the income is directed into the shared company pool
    // — currency forced to USDT and funding_source persisted. The company
    // balance formula counts ADMIN_INCOME(COMPANY_ACCOUNT) PAID as a (+)
    // credit; getSummary EXCLUDES these rows from the receiver's personal
    // balance (the money went to the pool, not to a person).
    const isCompanyFunded = fundingSource === 'COMPANY_ACCOUNT'
    const currency = (isCompanyFunded ? 'USDT' : data.currency) as 'USDT' | 'USD' | 'EUR' | 'UAH'

    // ── SECURITY (security-review PR #438, HIGH-3): the SECOND ADMIN_INCOME
    // writer. This path credits the company account with exactly the same
    // ledger predicate as `declareUsdtProjectIncome`
    // (type=ADMIN_INCOME, status=PAID, currency=USDT,
    // fundingSource=COMPANY_ACCOUNT) but did not claim the on-chain hash, so
    // the registry covered one of two writers. An honestly registered client
    // inflow of 5 000 USDT left the transfer unclaimed, and any SENIOR/DROP
    // could read that hash off the public explorer and submit it as a deposit —
    // recipient, currency and confirmations all check out, a deposit declares
    // no amount, the sender is not a gate — crediting the pool a second time.
    //
    // The receipt is MANDATORY and explorer-only for a company-funded income,
    // so the hash is physically available: extract it, record it, claim it in
    // the SAME transaction as the credit.
    // LOW (round 3): RECORD the hash whenever the receipt carries one — both
    // writers now follow the same rule, and attribution is useful even on a
    // personal income. CLAIMING is the separate decision below
    // (`settlementConsumesTransfer`): recording ≠ spending.
    const onChainTxHash = extractOnChainTxHash(data.receiptExternalUrl)

    let tx: typeof transactions.$inferSelect
    try {
      tx = await this.db.db.transaction(async (dbtx) => {
        const [inserted] = await dbtx
          .insert(transactions)
          .values({
            type: 'ADMIN_INCOME',
            status: 'PAID',
            amount: String(data.amount),
            currency,
            senderId: null,
            senderLabel: project.companyName,
            receiverId,
            projectId: data.projectId,
            receiptDocumentId: data.receiptDocumentId ?? null,
            receiptExternalUrl: data.receiptExternalUrl ?? null,
            txHash: onChainTxHash,
            notes: data.notes ?? null,
            fundingSource,
            txDate: this.resolveTxDate(data.txDate),
            createdBy: currentUser.id,
          })
          .returning()

        if (settlementConsumesTransfer({ kind: 'ADMIN_INCOME', fundingSource })) {
          const claim = await consumeTxHash(dbtx, {
            txHash: data.receiptExternalUrl ?? '',
            purpose: 'ADMIN_INCOME',
            referenceId: inserted!.id,
            consumedByUserId: currentUser.id,
          })
          // MED-1: an unclaimable receipt on a CREDITING path must be visible.
          if (!claim.claimed) {
            await this.recordUnclaimedCredit(dbtx, {
              path: 'createAdminIncome',
              transactionId: inserted!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
          // MED-J: spending a transfer an ADMIN had released is legitimate but
          // must be reconstructable — record the second half of the pair.
          if (claim.reclaimedAfterRelease) {
            await this.recordReclaimAfterRelease(dbtx, {
              path: 'createAdminIncome',
              txHash: data.receiptExternalUrl ?? '',
              referenceId: inserted!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }

        return inserted!
      })
    } catch (err) {
      // The only unique index this transaction can violate is
      // `uq_consumed_tx_hashes_tx_hash` — the receipt points at a transfer that
      // already settled something else. Clean 400, never a 500.
      if (isUniqueViolation(err)) {
        throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
      }
      throw err
    }

    await this.recordCreationAudit(tx.id, tx, currentUser)
    return this.findOne(tx.id, currentUser)
  }

  // ── Declare admin USDT project income (D3) ───────────────────────────────

  /**
   * task-drop-share-override-and-receiver (D3). An ADMIN declares USDT project
   * income on a USDT-payment project. The gross amount lands on the chosen
   * receiver (an ADMIN's personal balance, or the shared company USDT pool); the
   * company then books obligations to the project's senior (unless the senior is
   * an ADMIN) and drop (if bound). The income row itself is an ADMIN_INCOME
   * (adopt-before-extend — identical money semantics), created immediately PAID.
   *
   * Income row + both obligation blocks commit in ONE db.transaction so an
   * income can never exist without its obligations (anti-BIZ-02).
   *
   * RBAC: ADMIN only (Q4 — ACCOUNTANT may NOT declare, enforced by the controller
   * @Roles and re-checked here).
   */
  async declareUsdtProjectIncome(
    data: {
      projectId: string
      amount: number
      receiverId: string
      // Security-review PR #367 (MED-1): client-generated UUID, REQUIRED (Zod
      // enforces it in createUsdtIncomeSchema). Mirrors the dividend BIZ-19
      // (MED-2) idempotency contract 1:1 — see the early-SELECT / 23505 catch
      // below and uq_transactions_admin_income_idempotency_key.
      idempotencyKey: string
      // task-receipts-backend (#4): receipt is MANDATORY and (USDT income)
      // explorer-only. Zod enforces this at the controller; re-checked below for
      // defense-in-depth.
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    // PR #367 (MED-1): idempotency replay guard. A double-submit (double click /
    // network retry) carries the SAME key — return the EXISTING ADMIN_INCOME row
    // WITHOUT re-declaring income or re-booking company obligations. The RBAC gate
    // runs FIRST (defense-in-depth): a non-admin replaying a key still gets 403,
    // never a leaked row. This is a plain SELECT (no lock) — the genuine
    // concurrent race where two submits both miss it is caught by the partial
    // unique index (23505) at the tail of this method.
    //
    // Key = INTENT (same contract as dividend BIZ-19): replaying a key with a
    // DIFFERENT payload (amount/project/receiver) still returns the FIRST
    // committed row — a silent no-op, not a 409; the new payload is ignored.
    // Acceptable by design: the endpoint is ADMIN-only and the dialog generates
    // a fresh UUID per open, so a key/payload mismatch can only come from a
    // stale client retry, where returning the original row is the safe answer.
    const replay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'ADMIN_INCOME'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (replay) return this.findOne(replay.id, currentUser)

    // task-receipts-backend (#4) defense-in-depth: re-validate the mandatory
    // receipt (USDT → explorer-only) on the service, not only in Zod. Runs AFTER
    // the idempotency short-circuit so a genuine retry still returns the existing
    // row; a NEW declaration must carry a valid explorer link. A file receipt is
    // rejected for USDT before it can be bound.
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      'USDT',
    )
    if (receiptErr) throw new BadRequestException(receiptErr)

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    // Gate: this flow is ONLY for USDT-payment projects (D2). FOP/GIG income is
    // declared by the SENIOR/DROP themselves via createSeniorIncome/DropIncome.
    if (project.paymentType !== 'USDT') {
      throw new BadRequestException('Приход в USDT можно декларировать только на USDT-проекте')
    }

    // Resolve the receiver: the COMPANY_ACCOUNT marker credits the shared USDT
    // pool (fundingSource=COMPANY_ACCOUNT, receiverId=caller, excluded from the
    // caller's personal balance in getSummary — mirror of createAdminIncome);
    // otherwise the receiver must be an active ADMIN whose personal balance is
    // credited (fundingSource=null).
    const toCompanyPool = data.receiverId === COMPANY_ACCOUNT_RECEIVER
    let receiverId: string
    let fundingSource: 'COMPANY_ACCOUNT' | null
    if (toCompanyPool) {
      receiverId = currentUser.id
      fundingSource = 'COMPANY_ACCOUNT'
    } else {
      const receiver = await this.db.db.query.users.findFirst({
        where: eq(users.id, data.receiverId),
      })
      if (!receiver || receiver.role !== 'ADMIN' || receiver.archivedAt) {
        throw new BadRequestException('Получатель должен быть активным администратором')
      }
      receiverId = receiver.id
      fundingSource = null
    }

    // Load senior + drop and resolve their effective shares BEFORE opening the
    // transaction (resolveSeniorShareSnapshot reads team memberships on the base
    // connection — committed data, safe pre-txn). Snapshots are stamped onto the
    // IOU rows so the obligation is deterministic.
    const senior = project.seniorId
      ? await this.db.db.query.users.findFirst({ where: eq(users.id, project.seniorId) })
      : null
    const drop = project.dropId
      ? await this.db.db.query.users.findFirst({ where: eq(users.id, project.dropId) })
      : null

    const seniorSnapshot = senior
      ? await this.resolveSeniorShareSnapshot(
          { seniorSharePercentOverride: project.seniorSharePercentOverride },
          { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
        )
      : null
    const dropSnapshot = drop
      ? resolveDropShare(
          { dropSharePercentOverride: project.dropSharePercentOverride },
          { dropSharePercent: drop.dropSharePercent },
        )
      : null

    let txId: string
    try {
      txId = await this.db.db.transaction(async (dbtx) => {
        const [tx] = await dbtx
          .insert(transactions)
          .values({
            type: 'ADMIN_INCOME',
            status: 'PAID',
            amount: String(data.amount),
            currency: 'USDT',
            senderId: null,
            senderLabel: project.companyName,
            receiverId,
            projectId: data.projectId,
            fundingSource,
            // PR #367 (MED-1): persist the key so uq_transactions_admin_income_
            // idempotency_key enforces single-income-per-key as a DB-level backstop
            // for concurrent submits that slip past the early-SELECT above.
            idempotencyKey: data.idempotencyKey,
            // task-receipts-backend (#4): explorer link (USDT). USDT is
            // explorer-only, so receiptDocumentId is always null here.
            receiptDocumentId: data.receiptDocumentId ?? null,
            receiptExternalUrl: data.receiptExternalUrl ?? null,
            // The explorer link is the on-chain evidence for this income; record
            // the hash it points at (MED-1) so the row is attributable and the
            // registry claim below has a visible counterpart on the ledger.
            txHash: extractOnChainTxHash(data.receiptExternalUrl) ?? null,
            notes: data.notes ?? null,
            txDate: this.resolveTxDate(data.txDate),
            createdBy: currentUser.id,
          })
          .returning()

        // ── MED-1 (security-review PR #438): ADMIN_INCOME is the THIRD term
        // `computeCompanyAccountBalanceFromLedger` credits (alongside
        // COMPANY_DEPOSIT and PAYOUT/COMPANY_ACCOUNT), so leaving it outside the
        // consumed-hash registry kept the "one on-chain transfer settles exactly
        // one thing" invariant non-global: the same transfer could be declared
        // as admin income AND settle a payout / credit a deposit. The receipt is
        // MANDATORY and explorer-only for USDT income, so its link carries the
        // hash — claim it here, inside the same transaction as the credit.
        //
        // A no-op when the link carries no hash (nothing on-chain to consume);
        // a collision surfaces as 23505 → the catch below turns it into a clean
        // 400 rather than a 500.
        //
        // HIGH-3 (round 2): the claim is tied to the CREDITING condition, not
        // to the row type — `settlementConsumesTransfer`. A personal admin
        // declaration (fundingSource null) never touches the company balance
        // and references a transfer to that admin's OWN wallet, so burning its
        // hash would block that transfer's real payer for nothing.
        if (settlementConsumesTransfer({ kind: 'ADMIN_INCOME', fundingSource })) {
          const claim = await consumeTxHash(dbtx, {
            txHash: data.receiptExternalUrl ?? '',
            purpose: 'ADMIN_INCOME',
            referenceId: tx!.id,
            consumedByUserId: currentUser.id,
          })
          if (!claim.claimed) {
            await this.recordUnclaimedCredit(dbtx, {
              path: 'declareUsdtProjectIncome',
              transactionId: tx!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
          if (claim.reclaimedAfterRelease) {
            await this.recordReclaimAfterRelease(dbtx, {
              path: 'declareUsdtProjectIncome',
              txHash: data.receiptExternalUrl ?? '',
              referenceId: tx!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }

        await this.bookCompanyObligations(dbtx, {
          incomeAmount: data.amount,
          projectId: data.projectId,
          companyName: project.companyName,
          createdBy: currentUser.id,
          // task-admin-income-drop-backfill: this row's own id — the ONE call
          // site that always knows its source income (it just inserted it, in
          // this same db transaction). Lets a future query answer "does this
          // income already have a booked share?" without guessing by
          // project+amount+time.
          incomeTransactionId: tx!.id,
          senior:
            senior && seniorSnapshot
              ? { id: senior.id, role: senior.role, shareSnapshot: seniorSnapshot }
              : null,
          drop: drop && dropSnapshot ? { id: drop.id, shareSnapshot: dropSnapshot } : null,
          notePrefix: 'USDT income',
        })

        return tx!.id
      })
    } catch (err) {
      // PR #367 (MED-1 race): two concurrent submits with the SAME key both miss
      // the early-SELECT (it runs outside any lock); A commits, B's insert hits
      // uq_transactions_admin_income_idempotency_key (23505). Drizzle rolls the
      // whole transaction back — NO partial income and NO orphan obligations —
      // then rethrows. Re-read the committed winner on a FRESH connection (the
      // aborted dbtx is unusable) and return it: idempotent response, not a 500.
      if (isUniqueViolation(err)) {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'ADMIN_INCOME'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) return this.findOne(committed.id, currentUser)
        // MED-1: no row for this key ⇒ the 23505 came from the OTHER unique
        // index in this transaction — `uq_consumed_tx_hashes_tx_hash`, i.e. the
        // receipt link points at a transfer already settled elsewhere (a payout
        // or a deposit). Clean 400, never a 500.
        throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
      }
      throw err
    }

    return this.findOne(txId, currentUser)
  }

  // ── Create SENIOR_INCOME ─────────────────────────────────────────────────

  async createSeniorIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      // backlog 73/A-3 (security): REQUIRED client-generated UUID, mirroring
      // the ADMIN_INCOME (PR #367, MED-1) / dividend (BIZ-19, MED-2)
      // idempotency contract 1:1 — see declareUsdtProjectIncome's own comment
      // for the full rationale. The frontend generates a fresh UUID at dialog
      // OPEN and sends it on every submit within that session. A double-submit
      // (double click / network retry) with the SAME key returns the EXISTING
      // SENIOR_INCOME row instead of creating a second one — the second income
      // used to book a second company obligation for the same piece of work
      // once it reached payout validation (bookCompanyObligations).
      idempotencyKey: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'SENIOR') throw new ForbiddenException()

    // backlog 73/A-3: idempotency replay guard. Runs FIRST, right after the
    // RBAC gate above and BEFORE any RBAC-independent logic (project lookup,
    // ownership check, receipt validation) — same placement
    // declareUsdtProjectIncome uses, for the same reason: an unauthorized
    // replay still gets 403 from the role check above, never a leaked row.
    // A caller replaying a key that belongs to a DIFFERENT senior's income
    // still cannot read it — `findOne` below re-applies `assertReadAccess`,
    // which rejects a SENIOR who is neither the sender nor the receiver of
    // the row, so this early-SELECT does not need its own ownership filter.
    //
    // This is a plain SELECT (no lock) — the genuine concurrent race where two
    // submits both miss it is caught by the partial unique index (23505) at
    // the insert below.
    //
    // Key = INTENT (same contract as ADMIN_INCOME/dividend): replaying a key
    // with a DIFFERENT payload still returns the FIRST committed row — a
    // silent no-op, not a 409. Acceptable by design: the dialog generates a
    // fresh UUID per open, so a key/payload mismatch can only come from a
    // stale client retry, where returning the original row is the safe answer.
    const seniorIncomeReplay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'SENIOR_INCOME'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (seniorIncomeReplay) return this.findOne(seniorIncomeReplay.id, currentUser)

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
      with: { financeSettings: true },
    })
    if (!project) throw new NotFoundException('Project not found')
    if (project.seniorId !== currentUser.id) {
      throw new ForbiddenException('You can only add income for your own projects')
    }
    // task-drop-share-override-and-receiver (D2). On a USDT-payment project the
    // SENIOR does NOT declare income — only an ADMIN does (via
    // declareUsdtProjectIncome), and the company books the senior share as an
    // obligation. FOP/GIG lifecycle is unchanged.
    if (project.paymentType === 'USDT') {
      throw new ForbiddenException('На USDT-проекте приход декларирует администратор')
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!senior) throw new NotFoundException('Senior not found')
    // task-archive-pending-modal (AC1): a NEW PENDING accrual must never be
    // minted for an archived person — `JwtAuthGuard` already rejects an
    // archived session, but its role/archived cache has a 60s TTL (see
    // jwt.guard.ts), so a request already in flight when the archive commits
    // can still reach here within that window. Same "creates a NEW
    // entitlement → refuse" rule `createSalary` / `createMonthlySalaries`
    // apply, defense-in-depth over the auth layer's TOCTOU gap.
    if (senior.archivedAt) {
      throw new ForbiddenException('Пользователь архивирован — доход не декларируется')
    }

    // task-team-senior-share-override. Hierarchy resolution:
    //   project.seniorSharePercentOverride
    //     ↓  (null)
    //   exactly-one active team.seniorSharePercentOverride for this senior
    //     ↓  (null / ambiguous)
    //   users.seniorSharePercent (fallback 26)
    //
    // The legacy `projectFinanceSettings.seniorSharePercentOverride` mirror
    // is preserved for back-compat — the projects module keeps both columns
    // in sync, so consulting `projects.seniorSharePercentOverride` (which
    // the resolver does) is equivalent to the previous mirror lookup.
    const applicableTeams = await this.findActiveTeamsForUser(currentUser.id)
    const resolved = resolveSeniorShare(
      { seniorSharePercentOverride: project.seniorSharePercentOverride },
      { seniorSharePercent: senior.seniorSharePercent },
      applicableTeams,
    )

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller boundary.
    const seniorIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      data.currency,
    )
    if (seniorIncomeReceiptErr) throw new BadRequestException(seniorIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    let tx: typeof transactions.$inferSelect | undefined
    try {
      ;[tx] = await this.db.db
        .insert(transactions)
        .values({
          type: 'SENIOR_INCOME',
          status: 'PENDING',
          amount: String(data.amount),
          currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
          senderId: null,
          senderLabel: project.companyName,
          receiverId: currentUser.id,
          projectId: data.projectId,
          seniorSharePercent: resolved.value,
          seniorSharePercentSource: resolved.source,
          // backlog 73/A-3: persist the key so
          // uq_transactions_senior_income_idempotency_key enforces
          // single-income-per-key as a DB-level backstop for concurrent
          // submits that slip past the early-SELECT above.
          idempotencyKey: data.idempotencyKey,
          receiptDocumentId: data.receiptDocumentId ?? null,
          receiptExternalUrl: data.receiptExternalUrl ?? null,
          notes: data.notes ?? null,
          txDate: this.resolveTxDate(data.txDate),
          createdBy: currentUser.id,
        })
        .returning()
    } catch (err) {
      // backlog 73/A-3 race: two concurrent submits with the SAME key both
      // miss the early-SELECT (it runs outside any lock); A commits, B's
      // insert hits uq_transactions_senior_income_idempotency_key (23505).
      // Re-read the committed winner and return it — idempotent response,
      // not a 500. Match on the CONSTRAINT NAME (not a blanket
      // isUniqueViolation) so an unrelated collision on this table (e.g.
      // uq_transactions_receipt_document_id) rethrows instead of being
      // misattributed as an idempotency race (security-review PR #438
      // rationale — see pg-errors.ts's own doc comment on
      // uniqueViolationConstraint).
      if (uniqueViolationConstraint(err) === 'uq_transactions_senior_income_idempotency_key') {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'SENIOR_INCOME'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) return this.findOne(committed.id, currentUser)
      }
      throw err
    }

    await this.recordCreationAudit(tx!.id, tx!, currentUser)
    return this.findOne(tx!.id, currentUser)
  }

  // ── Create DROP_INCOME (Drop role - phase 2) ─────────────────────────────
  //
  // Parallel to `createSeniorIncome` for DROP users on drop-projects. Keeps
  // the senior-income path unchanged. Validation cascade (validateTransaction
  // below) understands both types and routes DROP_INCOME through the
  // distribution branch.

  async createDropIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      // backlog 73/A-3 (security): same REQUIRED idempotency-key contract as
      // createSeniorIncome above (see its comment for the full rationale) —
      // mirrored 1:1 onto DROP_INCOME.
      idempotencyKey: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'DROP') throw new ForbiddenException()

    // backlog 73/A-3: idempotency replay guard — same placement + rationale
    // as createSeniorIncome's own guard (see its comment). `findOne` below
    // re-applies `assertReadAccess`, which rejects a DROP who is neither the
    // sender nor the receiver of the replayed row, so a replay of someone
    // else's key still cannot leak that row's data.
    const dropIncomeReplay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'DROP_INCOME'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (dropIncomeReplay) return this.findOne(dropIncomeReplay.id, currentUser)

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    // The drop can only declare income on a drop-project routed through them.
    if (project.dropId !== currentUser.id) {
      throw new ForbiddenException('Это не drop-проект под вами')
    }

    // task-drop-share-override-and-receiver (D2). On a USDT-payment project the
    // DROP/SENIOR do NOT declare income — only an ADMIN does (via
    // declareUsdtProjectIncome), and the company books the drop/senior share as
    // an obligation. FOP/GIG lifecycle is unchanged.
    if (project.paymentType === 'USDT') {
      throw new ForbiddenException('На USDT-проекте приход декларирует администратор')
    }

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller boundary.
    const dropIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      data.currency,
    )
    if (dropIncomeReceiptErr) throw new BadRequestException(dropIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    // task-drop-share-override-and-receiver (Part A). Snapshot the effective drop
    // share % (project override → drop user default → 5) so the distribution is
    // deterministic — a later change to users.dropSharePercent does not re-price
    // this income. Same resolver mapProject exposes as effectiveDropSharePercent.
    const dropUser = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    // task-archive-pending-modal (AC1): mirrors the guard in createSeniorIncome
    // — see its comment for the full TOCTOU rationale (JwtAuthGuard's 60s
    // role/archived cache).
    if (dropUser?.archivedAt) {
      throw new ForbiddenException('Пользователь архивирован — доход не декларируется')
    }
    const resolvedDrop = resolveDropShare(
      { dropSharePercentOverride: project.dropSharePercentOverride },
      { dropSharePercent: dropUser?.dropSharePercent },
    )

    let tx: typeof transactions.$inferSelect | undefined
    try {
      ;[tx] = await this.db.db
        .insert(transactions)
        .values({
          type: 'DROP_INCOME',
          status: 'PENDING',
          amount: String(data.amount),
          currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
          senderId: null,
          senderLabel: project.companyName,
          receiverId: currentUser.id,
          recipientId: currentUser.id,
          projectId: data.projectId,
          dropSharePercent: resolvedDrop.value,
          dropSharePercentSource: resolvedDrop.source,
          // backlog 73/A-3: persist the key so
          // uq_transactions_drop_income_idempotency_key enforces
          // single-income-per-key as a DB-level backstop for concurrent
          // submits that slip past the early-SELECT above.
          idempotencyKey: data.idempotencyKey,
          receiptDocumentId: data.receiptDocumentId ?? null,
          receiptExternalUrl: data.receiptExternalUrl ?? null,
          notes: data.notes ?? null,
          txDate: this.resolveTxDate(data.txDate),
          createdBy: currentUser.id,
        })
        .returning()
    } catch (err) {
      // backlog 73/A-3 race: same shape as createSeniorIncome's own catch —
      // match on the CONSTRAINT NAME so an unrelated collision on this table
      // rethrows instead of being misattributed as an idempotency race.
      if (uniqueViolationConstraint(err) === 'uq_transactions_drop_income_idempotency_key') {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'DROP_INCOME'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) return this.findOne(committed.id, currentUser)
      }
      throw err
    }

    await this.recordCreationAudit(tx!.id, tx!, currentUser)
    return this.findOne(tx!.id, currentUser)
  }

  /**
   * task-receipts-backend. Shared 1:1 receipt replace-with-delete + best-effort
   * post-commit S3 cleanup. Extracted from updateSeniorIncome (PR-3) so
   * updateSeniorIncome / updateDropIncome / attachOrReplaceReceipt never
   * copy-paste the ordering-sensitive logic (DRY).
   *
   * Ordering (an S3 failure must never corrupt DB state):
   *   STEP A (inside db.transaction): UPDATE the tx row (`set` MUST already carry
   *     the new receipt columns + updatedAt), re-pointing the FK; then DELETE the
   *     OLD documents row (safe — the FK no longer points at it). `runInTx` runs
   *     here too (e.g. the audit-log write) so it commits atomically.
   *   STEP B (post-commit): best-effort S3 delete of the old key. On failure →
   *     warn-log only; a dangling S3 object is acceptable, an orphan FK is not.
   *
   * We DELETE the old documents row inline via `dbtx` (NOT documentsService)
   * because hardDeleteInternal uses the pool connection — calling it inside a
   * transaction would deadlock on a second connection.
   */
  private async replaceReceiptAtomic(
    txId: string,
    oldDocId: string | null,
    nextDocId: string | null,
    set: Partial<typeof transactions.$inferInsert>,
    runInTx?: (dbtx: DrizzleTx) => Promise<void>,
  ): Promise<void> {
    // Fetch the old document's S3 keys BEFORE the transaction (post-commit
    // cleanup needs them without another DB read).
    let oldS3Key: string | null = null
    let oldThumbKey: string | null = null
    if (oldDocId && oldDocId !== nextDocId) {
      const oldDoc = await this.db.db.query.documents.findFirst({
        where: eq(documents.id, oldDocId),
      })
      if (oldDoc) {
        oldS3Key = oldDoc.s3Key
        oldThumbKey = oldDoc.thumbnailS3Key ?? null
      }
    }

    await this.db.db.transaction(async (dbtx) => {
      // security-review PR #456 (MED-1, delete↔write TOCTOU): the caller
      // already ran `assertTransactionWritable` against a row read BEFORE
      // this transaction opened — a concurrent `adminDeleteTransaction` could
      // commit in between. Re-assert `deleted_at IS NULL` INSIDE the same
      // UPDATE that performs the write, and check the affected row count, so
      // the DB (not a stale in-memory read) is the source of truth for the
      // race. Zero rows updated ⇒ deleted in flight — abort before the old
      // receipt document is deleted below.
      const updated = await dbtx
        .update(transactions)
        .set(set)
        .where(and(eq(transactions.id, txId), isNull(transactions.deletedAt)))
        .returning({ id: transactions.id })
      if (updated.length === 0) {
        throw new BadRequestException('Транзакция удалена — восстановите её перед этим действием')
      }
      if (oldDocId && oldDocId !== nextDocId) {
        await dbtx.delete(documents).where(eq(documents.id, oldDocId))
      }
      if (runInTx) await runInTx(dbtx)
    })

    if (oldS3Key) {
      await this.documentsService.deleteS3Keys(oldS3Key, oldThumbKey)
      this.logger.debug(
        `receipt replace: old S3 key="${oldS3Key}" scheduled for cleanup (post-commit)`,
      )
    }
  }

  // ── Update REJECTED SENIOR_INCOME ────────────────────────────────────────

  async updateSeniorIncome(
    id: string,
    data: {
      amount?: number | undefined
      currency?: string | undefined
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    // security-review PR #456 (HIGH-3): a deleted REJECTED income was
    // resubmittable — the resubmit reset status/validator AND hard-deleted the
    // old receipt document BEFORE the final `findOne` 404'd, i.e. the row
    // silently un-deleted itself via a side door. MUST run before the
    // type/status/ownership checks below (same ordering rule as findOne).
    assertTransactionWritable(tx, currentUser)
    if (tx.type !== 'SENIOR_INCOME')
      throw new BadRequestException('Can only edit SENIOR_INCOME transactions')
    if (tx.status !== 'REJECTED')
      throw new BadRequestException('Can only edit REJECTED transactions')
    if (tx.receiverId !== currentUser.id) throw new ForbiddenException()

    // task-archive-pending-modal (round 2, security MED-1): resubmitting a
    // REJECTED income back to PENDING with a caller-supplied amount mints a
    // NEW entitlement — the exact same "must be active" rule this PR already
    // enforces in createSeniorIncome, same TOCTOU rationale (JwtAuthGuard's
    // 60s archived-status cache lets an in-flight request from a
    // just-archived session still reach here).
    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (receiver?.archivedAt) {
      throw new ForbiddenException('Пользователь архивирован — доход не декларируется')
    }

    // ── XOR receipt resolution ──────────────────────────────────────────────
    // Exactly one of receiptDocumentId / receiptExternalUrl may be set at a
    // time (DB CHECK enforces this). Rules:
    //   - If receiptDocumentId is provided → it wins; receiptExternalUrl → null
    //   - If receiptExternalUrl is provided → it wins; receiptDocumentId → null
    //   - If neither is provided → leave both columns unchanged
    const receiptDocChanged = data.receiptDocumentId !== undefined
    const receiptUrlChanged = data.receiptExternalUrl !== undefined
    const nextDocId = receiptDocChanged
      ? (data.receiptDocumentId ?? null)
      : receiptUrlChanged && data.receiptExternalUrl
        ? null
        : tx.receiptDocumentId
    const nextExtUrl = receiptUrlChanged
      ? (data.receiptExternalUrl ?? null)
      : receiptDocChanged && data.receiptDocumentId
        ? null
        : tx.receiptExternalUrl

    // HIGH-1: validate the incoming receipt doc before writing FK.
    // Only check when nextDocId is set AND it is a new (different) document —
    // keeping the same docId is always safe (ownership already established).
    if (nextDocId && nextDocId !== tx.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(nextDocId, currentUser)
    }

    // ── 1:1 receipt replace-with-delete (PR-3) — via shared helper ──────────
    // Invariant: one SENIOR_INCOME ↔ exactly one RECEIPT document. On resubmit
    // the old receipt document is hard-deleted (S3 + DB row) atomically with the
    // tx update. The ordering-sensitive logic lives in replaceReceiptAtomic (DRY;
    // reused by updateDropIncome + attachOrReplaceReceipt).
    await this.replaceReceiptAtomic(id, tx.receiptDocumentId, nextDocId, {
      amount: data.amount !== undefined ? String(data.amount) : tx.amount,
      currency: (data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined) ?? tx.currency,
      receiptDocumentId: nextDocId,
      receiptExternalUrl: nextExtUrl,
      notes: data.notes !== undefined ? data.notes : tx.notes,
      status: 'PENDING',
      rejectionReason: null,
      validatedBy: null,
      validatedAt: null,
      updatedAt: new Date(),
    })

    return this.findOne(id, currentUser)
  }

  // ── Update REJECTED DROP_INCOME (BIZ-17) ─────────────────────────────────
  //
  // Parallel to `updateSeniorIncome` for DROP users. A DROP can resubmit a
  // REJECTED DROP_INCOME by editing the amount / currency / receipt / notes and
  // resetting the status back to PENDING for re-validation. Ownership is
  // enforced via `tx.receiverId === currentUser.id`.
  //
  // Unlike senior-income resubmission, we do NOT perform the receipt-replace-
  // with-delete step here because DROP income receipts are less common and the
  // same XOR semantics apply through the standard path. The pattern mirrors
  // updateSeniorIncome but intentionally omits the document hard-delete
  // optimisation (safe to add later if needed).

  async updateDropIncome(
    id: string,
    data: {
      amount?: number | undefined
      currency?: string | undefined
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'DROP') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    // security-review PR #456 (HIGH-3): mirrors updateSeniorIncome — must run
    // before the type/status/ownership checks below.
    assertTransactionWritable(tx, currentUser)
    if (tx.type !== 'DROP_INCOME')
      throw new BadRequestException('Can only edit DROP_INCOME transactions')
    if (tx.status !== 'REJECTED')
      throw new BadRequestException('Can only edit REJECTED transactions')
    if (tx.receiverId !== currentUser.id) throw new ForbiddenException()

    // task-archive-pending-modal (round 2, security MED-1): mirrors the guard
    // just added to updateSeniorIncome — see its comment for the full
    // TOCTOU rationale.
    const dropReceiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (dropReceiver?.archivedAt) {
      throw new ForbiddenException('Пользователь архивирован — доход не декларируется')
    }

    // XOR receipt resolution — mirrors updateSeniorIncome
    const receiptDocChanged = data.receiptDocumentId !== undefined
    const receiptUrlChanged = data.receiptExternalUrl !== undefined
    const nextDocId = receiptDocChanged
      ? (data.receiptDocumentId ?? null)
      : receiptUrlChanged && data.receiptExternalUrl
        ? null
        : tx.receiptDocumentId
    const nextExtUrl = receiptUrlChanged
      ? (data.receiptExternalUrl ?? null)
      : receiptDocChanged && data.receiptDocumentId
        ? null
        : tx.receiptExternalUrl

    if (nextDocId && nextDocId !== tx.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(nextDocId, currentUser)
    }

    // task-receipts-backend: adopt the shared 1:1 replace-with-delete helper so a
    // DROP resubmit that swaps its receipt hard-deletes the old file too (matches
    // updateSeniorIncome's invariant — previously the old DROP receipt leaked).
    await this.replaceReceiptAtomic(id, tx.receiptDocumentId, nextDocId, {
      amount: data.amount !== undefined ? String(data.amount) : tx.amount,
      currency: (data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined) ?? tx.currency,
      receiptDocumentId: nextDocId,
      receiptExternalUrl: nextExtUrl,
      notes: data.notes !== undefined ? data.notes : tx.notes,
      status: 'PENDING',
      rejectionReason: null,
      validatedBy: null,
      validatedAt: null,
      updatedAt: new Date(),
    })

    return this.findOne(id, currentUser)
  }

  // ── Generic attach / replace receipt (task-receipts-backend §6) ─────────────

  /**
   * PATCH /transactions/:id/receipt — attach or replace the receipt on an
   * EXISTING transaction. Contract (pm-brief §6):
   *
   * RBAC (defense-in-depth over the controller; NO @Roles on the route):
   *   - ADMIN / ACCOUNTANT → ANY transaction;
   *   - author (tx.createdBy === currentUser.id) → own transaction;
   *   - REPLACE (a receipt already exists) when tx.status === 'PAID' → ONLY
   *     ADMIN / ACCOUNTANT (the author may NOT replace a PAID receipt);
   *   - everyone else → 403.
   *
   * Currency-aware: a USDT transaction accepts ONLY a blockchain-explorer link
   * (a file → 400); otherwise a file OR any http(s) url. The receipt document (if
   * any) must be a RECEIPT owned by the caller (assertReceiptDocumentBindable).
   *
   * On a file replace the old receipt document is 1:1 hard-deleted (S3 + DB row)
   * via replaceReceiptAtomic. Each mutation writes a transaction_audit_log row
   * (ATTACH when there was no prior receipt, REPLACE otherwise) atomically with
   * the receipt swap.
   */
  async attachOrReplaceReceipt(
    id: string,
    data: {
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    // security-review PR #456 (HIGH-3): an author or ADMIN/ACCOUNTANT could
    // attach/replace a receipt on a deleted row (and hard-delete the old
    // document in the process) — must run before the RBAC/status checks below.
    assertTransactionWritable(tx, currentUser)

    const isPrivileged = currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT'
    const isAuthor = tx.createdBy === currentUser.id
    if (!isPrivileged && !isAuthor) {
      throw new ForbiddenException('Нет прав прикреплять чек к этой транзакции')
    }

    const hadReceipt = !!tx.receiptDocumentId || !!tx.receiptExternalUrl
    // Replace after PAID → only ADMIN / ACCOUNTANT (the author cannot).
    if (hadReceipt && tx.status === 'PAID' && !isPrivileged) {
      throw new ForbiddenException('Заменить чек после оплаты может только ADMIN или ACCOUNTANT')
    }

    // XOR — exactly one of doc / url (attachReceiptSchema enforces this at the
    // boundary; re-derive for the write).
    const nextDocId = data.receiptDocumentId ?? null
    const nextExtUrl = data.receiptExternalUrl ?? null

    // Currency-aware validation against the EXISTING transaction currency.
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: nextDocId, receiptExternalUrl: nextExtUrl },
      tx.currency,
    )
    if (receiptErr) throw new BadRequestException(receiptErr)

    // The receipt document must be a RECEIPT owned by the caller — you can only
    // attach a document you uploaded (self-ownership, no cross-owner binding).
    if (nextDocId && nextDocId !== tx.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(nextDocId, currentUser)
    }

    // ── SECURITY (security-review round 3, MED-E): keep "evidence ↔ claim" honest.
    //
    // A company-funded ADMIN_INCOME is credited on the strength of its explorer
    // receipt, and that receipt's hash is claimed in the registry. Swapping the
    // receipt afterwards used to be unchecked, so the row could be re-pointed at
    // a transfer that ANOTHER settlement had already consumed — leaving two
    // crediting rows justified by ONE on-chain transfer, which is exactly the
    // invariant this PR exists to hold.
    //
    // The guard refuses only that case: a NEW hash that is already spent by a
    // DIFFERENT row. Honest corrections still work — a link with no hash, an
    // unclaimed hash, or re-attaching this row's own hash all pass.
    const transition = await this.resolveReceiptHashTransition(tx, nextExtUrl)

    const action: 'ATTACH' | 'REPLACE' = hadReceipt ? 'REPLACE' : 'ATTACH'
    try {
      await this.replaceReceiptAtomic(
        id,
        tx.receiptDocumentId,
        nextDocId,
        {
          receiptDocumentId: nextDocId,
          receiptExternalUrl: nextExtUrl,
          // Keep the recorded hash in step with the evidence it came from.
          ...transition.txHashPatch,
          updatedAt: new Date(),
        },
        async (dbtx) => {
          // MED-E: the new evidence must be claimed too — otherwise the row would
          // credit the pool while its (new) transfer stayed spendable elsewhere.
          // Inside the same transaction as the swap; a concurrent claim collides
          // on the unique index and rolls the whole swap back.
          if (transition.claimHash) {
            const claim = await consumeTxHash(dbtx, {
              txHash: transition.claimHash,
              purpose: 'ADMIN_INCOME',
              referenceId: id,
              consumedByUserId: currentUser.id,
            })
            if (claim.reclaimedAfterRelease) {
              await this.recordReclaimAfterRelease(dbtx, {
                path: 'attachOrReplaceReceipt',
                txHash: transition.claimHash,
                referenceId: id,
                actorId: currentUser.impersonatorId ?? currentUser.id,
              })
            }
          }
          if (transition.staleClaim) {
            await this.recordReceiptClaimDivergence(dbtx, {
              path: 'attachOrReplaceReceipt',
              transactionId: id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
          // Audit atomically with the receipt swap.
          await dbtx.insert(transactionAuditLog).values({
            actorId: currentUser.impersonatorId ?? currentUser.id,
            targetId: id,
            action,
            metadata: {
              oldDocId: tx.receiptDocumentId,
              oldExtUrl: tx.receiptExternalUrl,
              newDocId: nextDocId,
              newExtUrl: nextExtUrl,
              receiptKind: nextDocId ? 'document' : 'url',
            },
          })
        },
      )
    } catch (err) {
      // MED-L (round 5): the pre-check is a fast-fail read; under a race the
      // claim itself is what collides. Map it to the same clean 400 every other
      // claim site returns — a 500 on the money path is exactly the failure
      // mode the shared `isUniqueViolation` was extracted to end.
      // MED-Q (round 6): ONLY the registry index earns that message; any other
      // unique violation rethrows rather than blaming a hash the user did not
      // touch.
      if (this.isRegistryConflict(err)) {
        throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
      }
      throw err
    }

    return this.findOne(id, currentUser)
  }

  // ── Admin Edit (any type except PAYOUT/PAYOUT_ADMIN) ─────────────────────

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
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    assertTransactionWritable(tx, currentUser)
    // Drop role - phase 3: PAYOUT_CONFIRMED rows are the audit trail of a
    // manual confirmation — editing them in-place would corrupt the link to
    // the originating PAYOUT. Group the prohibition with the existing PAYOUT
    // family so the contract is consistent.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw new BadRequestException('Cannot edit PAYOUT transactions')
    }
    if (tx.payoutRequestId) {
      throw new BadRequestException('Cannot edit a transaction linked to a payout request')
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
    const amountChanged = data.amount !== undefined && amountsDiffer(data.amount, Number(tx.amount))
    const currencyChanged = data.currency !== undefined && data.currency !== tx.currency
    const salaryMonthChanged = data.salaryMonth !== undefined && data.salaryMonth !== tx.salaryMonth
    // task-soft-delete-and-money-audit (AC5): "receiver" on this endpoint is
    // `category` → `receiverLabel` (see the `.set({ ...receiverLabel: data.category })`
    // below) — the counterparty-facing label an ADMIN edit can change.
    const receiverLabelChanged = data.category !== undefined && data.category !== tx.receiverLabel

    if (tx.status === 'PAID' && (amountChanged || currencyChanged || salaryMonthChanged)) {
      throw new BadRequestException(
        'Cannot change amount, currency or salary month of a settled (PAID) transaction',
      )
    }

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
      await this.assertReceiptDocumentBindable(nextReceiptDocId, currentUser, { expectedOwnerId })
    }

    // ── SECURITY (security-review round 4, MED-F): the SECOND receipt entrance.
    // This endpoint edits `receiptExternalUrl` on an already-PAID crediting row
    // (metadata-only edits are explicitly allowed on PAID rows above), so
    // without this it bypassed the guard `attachOrReplaceReceipt` got in round
    // 3 — re-pointing a credited admin income at a transfer another settlement
    // had already consumed. Same shared rule, same behaviour.
    const transition =
      receiptUrlChanged || receiptDocChanged
        ? await this.resolveReceiptHashTransition(tx, receiptPatch.receiptExternalUrl ?? null)
        : { txHashPatch: {}, claimHash: null, staleClaim: false }

    try {
      await this.db.db.transaction(async (dbtx) => {
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
            .set({ amount: String(data.amount), updatedAt: new Date() })
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
        const updated = await dbtx
          .update(transactions)
          .set({
            ...(data.amount !== undefined && { amount: String(data.amount) }),
            ...(data.currency !== undefined && {
              currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
            }),
            ...(data.notes !== undefined && { notes: data.notes }),
            ...receiptPatch,
            ...transition.txHashPatch,
            ...(data.category !== undefined && { receiverLabel: data.category }),
            ...(data.salaryMonth !== undefined && { salaryMonth: data.salaryMonth }),
            updatedAt: new Date(),
          })
          .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          throw new BadRequestException('Транзакция удалена — восстановите её перед этим действием')
        }

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
        if (amountChanged || currencyChanged || receiverLabelChanged || salaryMonthChanged) {
          await dbtx.insert(transactionAuditLog).values({
            actorId: currentUser.impersonatorId ?? currentUser.id,
            targetId: id,
            action: 'AMOUNT_OR_RECEIVER_CHANGE',
            metadata: {
              ...(amountChanged && {
                amount: { before: tx.amount, after: String(data.amount) },
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
            },
          })
        }

        if (transition.claimHash) {
          const claim = await consumeTxHash(dbtx, {
            txHash: transition.claimHash,
            purpose: 'ADMIN_INCOME',
            referenceId: id,
            consumedByUserId: currentUser.id,
          })
          if (claim.reclaimedAfterRelease) {
            await this.recordReclaimAfterRelease(dbtx, {
              path: 'adminUpdateTransaction',
              txHash: transition.claimHash,
              referenceId: id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }
        if (transition.staleClaim) {
          await this.recordReceiptClaimDivergence(dbtx, {
            path: 'adminUpdateTransaction',
            transactionId: id,
            actorId: currentUser.impersonatorId ?? currentUser.id,
          })
        }
      })
    } catch (err) {
      // MED-L (round 5): same as the sibling receipt entrance — a racing claim
      // must surface as a 400, not a 500.
      // MED-Q (round 6): and ONLY a registry conflict may say so. This handler
      // is the reviewer's counterexample: an admin edit carrying `salaryMonth`
      // can trip `uq_transactions_salary_receiver_month`, which has nothing to
      // do with a tx hash.
      if (this.isRegistryConflict(err)) {
        throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
      }
      throw err
    }

    return this.findOne(id, currentUser)
  }

  // ── Edit cascade preview (read-only) ────────────────────────────────────
  //
  // task-cascade-resolver-preview (task 2 of the paid-transaction-edit-cascade
  // decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
  // AC4 "один резолвер, две обёртки"). `loadCascadeSnapshot` is the ONE query
  // shape both `getEditCascadePreview` below (this task) and the future
  // `PATCH` (task 3, re-reading the SAME rows under `SELECT … FOR UPDATE`)
  // are required to call — the arithmetic itself lives in `@crm/shared`
  // (`resolveEditCascade`) and is NEVER re-implemented here, the same
  // precedent `roundShareAmount` already set one layer down (see that
  // function's own comment, `:5127` region above).
  //
  // Accepts either the pool handle or an open `dbtx` so task 3 can reuse it
  // unchanged inside a `db.transaction(...)` callback.

  private async loadCascadeSnapshot(
    db: DatabaseService['db'] | DrizzleTx,
    sourceId: string,
  ): Promise<CascadeSnapshot | null> {
    const source = await db.query.transactions.findFirst({ where: eq(transactions.id, sourceId) })
    if (!source) return null

    // L18/C8 (ADR): `sourceIncomeTransactionId` is stamped ONCE at booking
    // time and, unlike `transactions.payoutRequestId`, survives
    // `settleByCompany`'s flip — it is what makes a derivative findable by
    // its source whether the derivative is still PENDING_PAYMENT or has
    // already flipped to PAID.
    const derivativeRows = await db.query.transactions.findMany({
      where: and(
        eq(transactions.sourceIncomeTransactionId, sourceId),
        isNull(transactions.deletedAt),
      ),
    })

    // Stryker disable next-line ArrowFunction: the VALUES this feeds into the
    // two `inArray(...)` filters below are a Postgres query shape — a unit
    // double (this file's own `cascade-edit-preview.unit.spec.ts`) proves the
    // `where` clause is PRESENT (not gutted) on every call, but a mock that
    // ignores its argument content cannot distinguish real ids from
    // `undefined`s without reaching into drizzle-orm's SQL builder internals.
    // The real-Postgres round-trip in `cascade-edit-preview.integration.spec.ts`
    // is what actually proves the correct rows come back (mutation-gate-integration-specs.md).
    const derivativeIds = derivativeRows.map((d) => d.id)
    const obligationRows = derivativeIds.length
      ? await db.query.pendingObligations.findMany({
          where: inArray(pendingObligations.sourceTransactionId, derivativeIds),
        })
      : // Stryker disable next-line ArrayDeclaration: provably equivalent —
        // this branch is reachable ONLY when `derivativeRows` (and therefore
        // the FINAL `derivatives` output below, built by mapping over the
        // very same `derivativeRows`) is empty, so `obligationRows`'
        // CONTENT is built but never read by anything: `obligationByDerivative`
        // is consulted per-derivative on the next line via `derivativeRows.map`,
        // which has zero iterations here. Changing the sentinel value cannot
        // change any observable output.
        []
    const obligationByDerivative = new Map(obligationRows.map((o) => [o.sourceTransactionId, o]))

    // L13/C3 (ADR): a COUNTERPARTY-signed invoice on a derivative is exactly
    // the case AC5 §6 forbids the cascade from silently disagreeing with.
    //
    // MED-1 (security-review round 1): the SOURCE row itself needs the SAME
    // check — after guard 3 is lifted (task 3), a `SALARY` row can BE the
    // source, and it can carry its own signed invoice. `sourceId` is folded
    // into the SAME `inArray` filter as the derivatives (one query, not two)
    // — this is why the zero-length skip below can no longer bypass the
    // query entirely the way the obligations one still does.
    //
    // Stryker disable next-line ArrayDeclaration: same class as the
    // `derivativeIds` ArrowFunction suppression a few lines up — the VALUES
    // fed into `inArray(...)` are a Postgres query shape, and a unit double
    // whose `findManySignatures` stub ignores its call arguments (it returns
    // a canned row list regardless of which ids were actually queried)
    // cannot tell `[...derivativeIds, sourceId]` apart from `[]` without
    // reaching into drizzle-orm's SQL builder internals. Proven for real by
    // `cascade-edit-preview.integration.spec.ts`'s "a real COUNTERPARTY
    // invoice_signatures row on the SOURCE id surfaces SOURCE_SIGNED_INVOICE"
    // against actual Postgres: an empty/wrong id list there would return zero
    // rows and that test would fail (mutation-gate-integration-specs.md).
    const signatureQueryIds = [...derivativeIds, sourceId]
    const signatureRows = await db.query.invoiceSignatures.findMany({
      where: and(
        inArray(invoiceSignatures.transactionId, signatureQueryIds),
        // Stryker disable next-line StringLiteral: a Postgres query VALUE
        // (which signer_role to filter by), not a shape — see the
        // ArrowFunction suppression above `derivativeIds` for the same
        // reasoning; provable only against the real DB, which
        // `cascade-edit-preview.integration.spec.ts` exercises directly
        // (a signature row with signerRole !== 'COUNTERPARTY' asserted
        // absent from `hasSignedInvoice` there is not reachable here).
        eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
      ),
    })
    const signedIds = new Set(signatureRows.map((s) => s.transactionId))

    const derivatives: CascadeDerivativeSnapshot[] = derivativeRows.map((d) => {
      const obligation = obligationByDerivative.get(d.id)
      return {
        id: d.id,
        type: d.type,
        status: d.status,
        amount: Number(d.amount),
        currency: d.currency,
        updatedAt: d.updatedAt.toISOString(),
        // Non-null only while the row is still PENDING_PAYMENT — settle nulls
        // both and snapshots the ONE that mattered into settledSharePercent
        // below (schema.ts comment on settledSharePercent).
        sharePercent: d.seniorSharePercent ?? d.dropSharePercent ?? null,
        settledAmount: d.settledAmount !== null ? Number(d.settledAmount) : null,
        settledCurrency: d.settledCurrency,
        settledSharePercent: d.settledSharePercent,
        hasSignedInvoice: signedIds.has(d.id),
        obligation: obligation
          ? {
              id: obligation.id,
              status: obligation.status,
              amount: Number(obligation.amount),
              // task-cascade-apply (backlog 95, addendum §3.5): READ the
              // obligation's own currency instead of assuming it matches the
              // source's. `bookCompanyObligations` stamps 'USDT' as a
              // literal and BIZ-18 was the only thing keeping that literal
              // in step with the source — and BIZ-18 is what task 3 lifts.
              currency: obligation.currency,
              updatedAt: obligation.updatedAt.toISOString(),
            }
          : null,
      }
    })

    return {
      source: {
        id: source.id,
        type: source.type,
        status: source.status,
        amount: Number(source.amount),
        currency: source.currency,
        payoutRequestId: source.payoutRequestId,
        updatedAt: source.updatedAt.toISOString(),
        // MED-1 (security-review round 1) — see the comment on
        // `signatureQueryIds` above for why the source id shares the SAME
        // query as the derivatives instead of a second round-trip.
        hasSignedInvoice: signedIds.has(source.id),
        originalAmount: source.originalAmount !== null ? Number(source.originalAmount) : null,
      },
      derivatives,
    }
  }

  /**
   * `GET /transactions/:id/edit-preview`. Read-only — loads a snapshot,
   * calls the shared resolver, returns the plan plus an optimistic-locking
   * version. Writes NOTHING: no row, no journal entry (AC9 of the task
   * file). Same RBAC as `adminUpdateTransaction` — ADMIN only, checked here
   * AND at the controller (`@Roles('ADMIN')`), the same defense-in-depth
   * pattern every other money endpoint in this file uses.
   *
   * Guards 1 and 2 of `adminUpdateTransaction` (`:2944-2949` above) are
   * mirrored here rather than imported from there — this task's scope
   * deliberately excludes touching `adminUpdateTransaction` at all (see the
   * task file), and both guards are a small, security-reviewed, "never
   * lifted" invariant (AC5 §1/§2 of the ADR). Guard 3 (BIZ-18, the PAID
   * `amount` lock) is intentionally ABSENT here: this endpoint exists to
   * preview what removing it would do (task 3), so it must never itself
   * refuse on it.
   */
  async getEditCascadePreview(
    id: string,
    amount: number,
    currentUser: SessionUser,
  ): Promise<CascadeEditPreviewResponse> {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    // Fetch+guard fusion (transaction-visibility.util.ts) — 404 for missing
    // or invisible, 400 for a soft-deleted row even though ADMIN can see it.
    const tx = await fetchWritableTransactionOrThrow(this.db.db, id, currentUser)

    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      return cascadeEditPreviewResponseSchema.parse({
        editable: false,
        blockedReason: 'PAYOUT_FAMILY',
        plan: null,
        version: null,
      })
    }
    if (tx.payoutRequestId) {
      return cascadeEditPreviewResponseSchema.parse({
        editable: false,
        blockedReason: 'LINKED_TO_PAYOUT_REQUEST',
        plan: null,
        version: null,
      })
    }

    // LOW (security-review round 1): `fetchWritableTransactionOrThrow` above
    // already read this exact row, and `loadCascadeSnapshot` immediately
    // re-reads it as its OWN `source` query — a deliberate extra round-trip,
    // not an oversight. `fetchWritableTransactionOrThrow` carries visibility
    // RBAC + soft-delete semantics this endpoint needs for the 404/400 split
    // (`transaction-visibility.util.ts`); `loadCascadeSnapshot` is required
    // to stay a SINGLE, self-contained query shape re-usable VERBATIM by
    // task 3 under `SELECT … FOR UPDATE` (AC4 "один резолвер, две обёртки")
    // — threading a pre-fetched row into it would fork that shape into a
    // preview-only variant and reintroduce the exact "two descriptions of
    // one read" problem AC4 exists to prevent. One extra indexed
    // primary-key read is the accepted cost of keeping that guarantee.
    const snapshot = await this.loadCascadeSnapshot(this.db.db, id)
    if (!snapshot) {
      // `tx` above already proved the row exists and is visible — only a
      // genuine race (a concurrent hard-delete-equivalent between the two
      // reads) could land here. Real defense-in-depth, not a decorative
      // check: the two reads are NOT inside one transaction.
      throw new NotFoundException('Transaction not found')
    }

    const plan = resolveEditCascade(snapshot, { amount })
    const version = computeCascadeVersion(snapshot)
    // AC5 of the task file / project convention (all API responses cross the
    // wire through a Zod `.parse()`) — the SAME schema `GET /edit-preview`'s
    // consumer (task 5's UI, and task 3's own optimistic-lock check) will
    // parse on the way IN, parsed here on the way OUT so a shape drift in
    // `resolveEditCascade`/`computeCascadeVersion` fails loudly in THIS spec
    // rather than surfacing as a silent contract mismatch three tasks later.
    return cascadeEditPreviewResponseSchema.parse({
      editable: true,
      blockedReason: null,
      plan,
      version,
    })
  }

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
  // `assertReadAccess`/`findOne` enforce that so a 403 can never leak that a
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
      throw new BadRequestException('Укажите причину удаления транзакции (она попадёт в журнал)')
    }

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    if (tx.deletedAt) {
      throw new BadRequestException('Транзакция уже удалена')
    }
    // Drop role - phase 3: PAYOUT_CONFIRMED is also non-deletable for the same
    // audit-trail reason as PAYOUT/PAYOUT_ADMIN.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw new BadRequestException('Cannot delete PAYOUT transactions')
    }
    if (tx.payoutRequestId) {
      throw new BadRequestException('Cannot delete a transaction linked to a payout request')
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
        throw new BadRequestException(
          'Cannot delete a transaction that is the source of a company obligation',
        )
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
        throw new BadRequestException('Транзакция уже удалена')
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

  async restoreTransaction(id: string, reason: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const trimmedReason = reason.trim()
    if (trimmedReason.length === 0) {
      throw new BadRequestException(
        'Укажите причину восстановления транзакции (она попадёт в журнал)',
      )
    }

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    if (!tx.deletedAt) {
      throw new BadRequestException('Транзакция не удалена')
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
        throw new BadRequestException('Транзакция не удалена')
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

    return this.findOne(id, currentUser)
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
    if (!tx) throw new NotFoundException('Transaction not found')
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
      actorName: r.actorName ?? '— (пользователь удалён)',
      metadata: r.metadata as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  // ── Validate / Reject SENIOR_INCOME ──────────────────────────────────────

  async validateTransaction(
    id: string,
    action: 'validate' | 'reject',
    rejectionReason: string | null | undefined,
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    assertTransactionWritable(tx, currentUser)
    // Drop role - phase 2: validate also handles DROP_INCOME with the same
    // shape — flip to VALIDATED + create payout_request + insert placeholder
    // PAYOUT row. The drop-specific distribution math lives in
    // `payPayoutRequest` (drop branch) — at validate time we only book a
    // payable that represents what the wallet owner will transfer off-platform
    // (= income * (1 - share/100), using dropSharePercent for DROP_INCOME).
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'DROP_INCOME') {
      throw new BadRequestException('Only SENIOR_INCOME or DROP_INCOME can be validated')
    }
    // AC4: idempotency. The action is only valid on PENDING rows — a second
    // click after a successful validate would otherwise create a duplicate
    // PAYOUT row. We throw rather than silently no-op so the UI can show
    // a clear error to the ACCOUNTANT (vs. pretending it worked twice).
    if (tx.status !== 'PENDING')
      throw new BadRequestException('Transaction is not in PENDING status')

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
          throw new BadRequestException('Транзакция удалена — восстановите её перед этим действием')
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
    } else {
      if (!rejectionReason) throw new BadRequestException('Rejection reason is required')
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
          throw new BadRequestException('Транзакция удалена — восстановите её перед этим действием')
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
    }

    return this.findOne(id, currentUser)
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
  async confirmPayout(
    payoutTxId: string,
    recipientAdminId: string,
    currentUser: SessionUser,
    options: { method?: 'CRYPTO' | 'CASH'; txHash?: string | null } = {},
  ) {
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
      throw new BadRequestException('Для crypto-метода требуется txHash минимум 10 символов')
    }
    const recordedTxHash = method === 'CRYPTO' ? txHashRaw : null

    const payoutTx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, payoutTxId),
    })
    if (!payoutTx) throw new NotFoundException('Transaction not found')
    if (payoutTx.type !== 'PAYOUT') {
      throw new BadRequestException('Only PAYOUT transactions can be confirmed')
    }
    // Idempotency guard. Once PAYOUT has flipped to PAID a second confirm
    // would either no-op or duplicate the PAYOUT_CONFIRMED row depending on
    // which side races; throw early so the UI can show «уже подтверждено».
    if (payoutTx.status !== 'PENDING_PAYMENT') {
      throw new BadRequestException('Payout is not pending payment (already confirmed?)')
    }

    const recipient = await this.db.db.query.users.findFirst({
      where: eq(users.id, recipientAdminId),
    })
    if (!recipient) throw new BadRequestException('Recipient admin not found')
    if (recipient.role !== 'ADMIN') {
      throw new BadRequestException('Recipient must be an ADMIN')
    }
    if (recipient.archivedAt) {
      throw new BadRequestException('Recipient admin is archived')
    }
    // task-sender-receiver-invariant (backlog A-2): defense-in-depth. Not
    // reachable today — `payoutTx.senderId` is the SENIOR/DROP who requested
    // the payout and `recipient` must resolve to an ADMIN, two structurally
    // different roles that can never share an id — but the PAYOUT_CONFIRMED
    // insert below copies `payoutTx.senderId` verbatim, so a future change to
    // either invariant would otherwise surface as an opaque DB CHECK error
    // instead of this clean 400.
    const confirmSelfPayErr = selfPayError(payoutTx.senderId, recipient.id)
    if (confirmSelfPayErr) throw new BadRequestException(confirmSelfPayErr)

    // security-review PR #456 round 2 (MED-3): under impersonation, attribute
    // `validatedBy` (and the note) to the REAL admin/accountant operator, never
    // the impersonated target — same rule `adminDeleteTransaction` and
    // `validateTransaction` already apply to their own `*By` columns. This was
    // the second of the two raw-`currentUser.id` sites the review found
    // (pending-settlement.service.ts's `settleByCompany` was the first).
    const effectiveActorId = currentUser.impersonatorId ?? currentUser.id

    const now = new Date()
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
          updatedAt: now,
          ...(method === 'CRYPTO' && recordedTxHash ? { txHash: recordedTxHash } : {}),
        })
        .where(and(eq(transactions.id, payoutTxId), eq(transactions.status, 'PENDING_PAYMENT')))
        .returning({ id: transactions.id })

      if (claimed.length === 0) {
        // The row was already confirmed by a concurrent call — bail out before
        // inserting a PAYOUT_CONFIRMED so no double credit occurs.
        throw new BadRequestException(
          'Payout is not pending payment (already confirmed by a concurrent request)',
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
        createdBy: currentUser.id,
      })
    })

    // Return both rows so the UI can update the table in a single round-trip:
    // the now-PAID PAYOUT and the freshly created credit row.
    const updatedPayout = await this.findOne(payoutTxId, currentUser)
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
    const confirmed = confirmedRow ? await this.findOne(confirmedRow.id, currentUser) : null

    return { payout: updatedPayout, confirmed }
  }

  // ── Create EXPENSE ───────────────────────────────────────────────────────

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
    if (expenseReceiptErr) throw new BadRequestException(expenseReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
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
      senderLabel = 'Счёт компании'
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
      txDate: this.resolveTxDate(data.txDate),
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
        const companyBalance = await this.computeCompanyAccountBalance(dbtx)
        if (companyBalance < data.amount) {
          throw new BadRequestException('Недостаточно средств на счёте компании')
        }
        const [tx] = await dbtx.insert(transactions).values(values).returning()
        return tx!.id
      })
    } else {
      const [tx] = await this.db.db.insert(transactions).values(values).returning()
      txId = tx!.id
    }

    await this.recordCreationAudit(txId, values, currentUser)
    return this.findOne(txId, currentUser)
  }

  // ── Create SALARY ─────────────────────────────────────────────────────────

  // task-salary-company-account RECONCILIATION: the salary/expense balance gate
  // now delegates to the SAME single-source-of-truth used by the display
  // endpoint (GET /company-account). Previously this gate-side copy diverged —
  // it was missing the `+PAYOUT(COMPANY_ACCOUNT)` term, so the gate undercounted
  // the real balance. Both paths now call computeCompanyAccountBalanceFromLedger
  // → display and gate are BYTE-FOR-BYTE identical (see company-account-balance.ts).
  //
  // MED-1 (TOCTOU): pass `dbtx` so the balance read runs INSIDE the
  // advisory-locked transaction of a company-account debit; the consistent,
  // serialized view guarantees the gate sees concurrent debits already applied.
  private async computeCompanyAccountBalance(dbtx?: DrizzleTx): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbtx ?? this.db.db)
  }

  async createSalary(
    data: {
      receiverId: string
      amount: number
      currency?: string
      salaryMonth: string
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

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw new NotFoundException('User not found')
    // Defense-in-depth: explicit ADMIN barrier first (security-MED #222).
    // SALARY_ELIGIBLE_ROLES allow-list check follows as the general gate.
    if (receiver.role === 'ADMIN') {
      throw new BadRequestException(
        'ADMIN не получает зарплату — доход распределяется через доли (ADMIN_INCOME)',
      )
    }
    if (!(SALARY_ELIGIBLE_ROLES as ReadonlyArray<string>).includes(receiver.role)) {
      throw new BadRequestException(
        'Salary can only be created for JUNIOR, HR, ACCOUNTANT, SENIOR, or DROP',
      )
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
      throw new BadRequestException('Получатель архивирован — зарплата не начисляется')
    }

    // task-salary-pay-flow: a manually-created salary is a NEUTRAL PENDING
    // reminder — it does NOT pick a funding source, does NOT touch the company
    // balance, and is NOT a debit. The funding source (company account vs admin
    // personal) and the actual payment currency are decided LATER, at pay time
    // (paySalary). senderId/fundingSource stay null until then; the currency is
    // the nominal of the reminder (default USD). No advisory lock / balance gate.
    const currency: 'USDT' | 'USD' | 'EUR' | 'UAH' = (data.currency ?? 'USD') as
      | 'USDT'
      | 'USD'
      | 'EUR'
      | 'UAH'

    // Audit 2026-06-27 (LOW #5 side-effect): the partial unique index
    // `uq_transactions_salary_receiver_month` now enforces ONE SALARY per
    // (receiver, month) for the manual endpoint too — a legitimate invariant (an
    // employee is never paid two salaries for the same month). A duplicate raises
    // SQLSTATE 23505; translate it into a clean 400 instead of a raw 500 so the
    // UI shows a friendly message. (The cron uses ON CONFLICT DO NOTHING; the
    // manual path surfaces the conflict to the operator who explicitly asked.)
    let tx: typeof transactions.$inferSelect | undefined
    try {
      ;[tx] = await this.db.db
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
          notes: data.notes ?? null,
          fundingSource: null,
          txDate: this.resolveTxDate(data.txDate),
          createdBy: currentUser.id,
        })
        .returning()
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'Зарплата для этого сотрудника за выбранный месяц уже создана',
        )
      }
      throw err
    }

    await this.recordCreationAudit(tx!.id, tx!, currentUser)
    return this.findOne(tx!.id, currentUser)
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
      throw new BadRequestException('senderId is required (transfer is between two ADMINs)')
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
        throw new BadRequestException('Sender must be an ADMIN')
    }

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw new NotFoundException('User not found')
    if (receiver.role !== 'ADMIN')
      throw new BadRequestException('Can only transfer to another ADMIN')
    // task-sender-receiver-invariant (backlog A-2): friendly 400 BEFORE the
    // DB CHECK (ck_transactions_sender_ne_receiver) would reject the insert
    // below with an opaque constraint-violation error. Shared with every
    // other write path via `selfPayError` — one rule, not five copies.
    const transferSelfPayErr = selfPayError(
      effectiveSenderId,
      receiver.id,
      'Cannot transfer to yourself',
    )
    if (transferSelfPayErr) throw new BadRequestException(transferSelfPayErr)
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
      throw new BadRequestException('Получатель архивирован — перевод невозможен')
    }

    // task-receipts-backend (#8): mandatory receipt, currency-aware (default
    // USDT → explorer-only). Defense-in-depth over Zod; validate the doc binding
    // for a non-USDT file receipt.
    const transferCurrency = data.currency ?? 'USDT'
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      transferCurrency,
    )
    if (receiptErr) throw new BadRequestException(receiptErr)
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
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
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    await this.recordCreationAudit(tx!.id, tx!, currentUser)
    return this.findOne(tx!.id, currentUser)
  }

  // ── Create Payout Request ─────────────────────────────────────────────────

  async createPayoutRequest(transactionIds: string[], currentUser: SessionUser) {
    // task-drop-payout-company-account. SENIOR and DROP have the SAME payout
    // flow: bundle one's own VALIDATED incomes into a single payout to the
    // COMPANY wallet. The ONLY differences are (a) the income row type the
    // caller may bundle (SENIOR_INCOME vs DROP_INCOME) and (b) the share the
    // company keeps — `1 - seniorShare%` for a SENIOR, `1 - dropShare%` for a
    // DROP (the drop keeps their own slice off-platform, the senior share for a
    // drop-project is settled later as a COMPANY → senior obligation in the
    // pay cascade). Everything else (USDT conversion, atomic FOR UPDATE lock,
    // placeholder PAYOUT) is identical.
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'DROP') {
      throw new ForbiddenException()
    }
    const isDrop = currentUser.role === 'DROP'
    const incomeType = isDrop ? 'DROP_INCOME' : 'SENIOR_INCOME'

    // For a DROP caller the company-kept share is `1 - dropSharePercent%`.
    // task-drop-share-override-and-receiver (Part A): DROP_INCOME rows now carry
    // a per-income `dropSharePercent` snapshot (like the senior share). We read
    // that snapshot per-income in the loop below; this user-level default is
    // only the FALLBACK for legacy rows created before the snapshot column
    // existed. SENIOR callers read the per-income seniorSharePercent snapshot.
    let dropSharePercentFallback = DEFAULT_DROP_SHARE_PERCENT
    if (isDrop) {
      const dropUser = await this.db.db.query.users.findFirst({
        where: eq(users.id, currentUser.id),
      })
      dropSharePercentFallback = dropUser?.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT
    }

    // Phase 8 v2 — fetch the NBU snapshot ONCE, BEFORE opening the DB
    // transaction (it can hit the network) so the cross-currency→USDT
    // conversion is deterministic across the whole batch and we never hold a
    // row lock during a network call. getRates never throws (hardcoded
    // fallback), so this can't break the txn.
    const rateResult = await this.nbuCurrency.getRates()
    const rates = {
      usdUah: parseFloat(rateResult.usdUah),
      eurUah: parseFloat(rateResult.eurUah),
    }

    // ── SECURITY (HIGH): atomic SELECT-FOR-UPDATE + full mutation inside one
    // DB transaction to prevent TOCTOU race. Two concurrent POST requests on
    // the same SENIOR_INCOME rows would otherwise both pass the isNull() guard
    // (reading stale snapshots) and each create a separate payout_request,
    // doubling the payout. The FOR UPDATE lock on the income rows blocks the
    // second concurrent read until the first transaction commits; at that point
    // the second re-read finds payoutRequestId IS NOT NULL and the outer
    // count-mismatch guard throws 400.
    const newRequestId = await this.db.db.transaction(async (dbtx) => {
      // Step 1: lock the income rows. Must use the select-builder (not
      // query.findMany) because Drizzle's relational API does not expose
      // .for('update'). Conditions mirror the findMany filter below so that
      // both use the same predicate and the lock covers exactly the candidate
      // rows.
      const lockedRows = await dbtx
        .select()
        .from(transactions)
        .where(
          and(
            inArray(transactions.id, transactionIds),
            // task-drop-payout-company-account: DROP_INCOME for a DROP caller,
            // SENIOR_INCOME for a SENIOR. The receiverId filter still pins the
            // batch to the caller's OWN incomes, so a DROP can never bundle
            // another drop's (or a senior's) income — Forbidden by count-mismatch.
            eq(transactions.type, incomeType),
            eq(transactions.status, 'VALIDATED'),
            eq(transactions.receiverId, currentUser.id),
            isNull(transactions.payoutRequestId),
            // task-soft-delete-and-money-audit: a soft-deleted income must not
            // be batchable into a fresh payout — it is excluded from every
            // balance/summary already, so paying it out would credit the
            // ledger for money a row that "does not exist" supposedly earned.
            isNull(transactions.deletedAt),
          ),
        )
        .for('update')

      // Step 2: count-mismatch guard — any already-linked or disqualified tx
      // makes the batch invalid. Also applied after the lock so the decision
      // is based on the locked, consistent view of the rows.
      if (lockedRows.length !== transactionIds.length) {
        throw new BadRequestException('Часть транзакций уже включена в выплату или недоступна')
      }

      // Audit 2026-06-28 (#5): a DROP payout must bundle incomes from a SINGLE
      // project. The pay cascade (applyPayoutPaidCascade) reads the FIRST linked
      // income's project as the "primary" and applies THAT project's drop/senior
      // share split to the WHOLE batch — so a batch spanning two drop-projects
      // would settle the second project's slice at the first project's percent.
      // Enforce «one payout = one project» for DROP callers (the standing UX —
      // see PayoutDetailDialog header). SENIOR batches are unaffected (their
      // share is per-income snapshotted, not project-derived).
      if (isDrop) {
        const distinctProjects = new Set(lockedRows.map((tx) => tx.projectId))
        if (distinctProjects.size > 1) {
          throw new BadRequestException('Выплата должна охватывать только один проект')
        }
      }

      // ── Phase 8 v2 — recipient = the COMPANY USDT wallet.
      // The single company_account row holds the wallet. If it is not
      // configured the senior has nowhere to send funds → reject the batch.
      const account = await dbtx.query.companyAccount.findFirst()
      if (!account?.walletAddress) {
        throw new BadRequestException('Кошелёк компании не настроен')
      }
      const contractAddress = account.walletAddress

      // ── Phase 8 v2 — cross-currency → USDT conversion (replaces the old
      // mixed-currency guard). Company-share of EACH income is converted to
      // USDT (USDT/USD 1:1; EUR/UAH via NBU rates fetched above), then summed.
      // The PAYOUT row + payout_request are ALWAYS USDT — the senior settles
      // with the company in crypto, so a single USDT obligation is correct even
      // when the underlying incomes span currencies (the previous hard guard
      // blocked legitimate mixed-currency batches — bug fix).
      //
      // ── MED: decimal-safe aggregation. Postgres numeric(18,6) stores exact
      // decimals; parseFloat() on the running sum would drift. We keep each
      // per-tx payable as scaled integer minor units (×1_000_000), convert that
      // integer to USDT minor units, sum, then divide once at the end — one
      // rounding event per income rather than per float op.
      // ── SECURITY (task-finance-fix-wave1, D-3): never bake a FALLBACK rate
      // into these amounts. `getRates()` above does not throw when the feed is
      // down — it returns HARDCODED_FALLBACK with `stale: true` — and the
      // figures computed below go straight into `payout_requests` by an
      // irreversible INSERT. They are not a display value that self-corrects on
      // the next read: `payPayoutRequest` requires the on-chain transfer to
      // match `payableAmount` EXACTLY (no percentage band), so a made-up rate
      // makes the payout either unpayable or payable at the wrong amount.
      //
      // The two conditions mirror `settleByCompany`
      // (pending-settlement.service.ts) deliberately, rather than inventing a
      // stricter rule here:
      //
      //   1. `stale && rateDate === undefined` — refuse ONLY a genuine outage.
      //      A weekend or bank holiday also yields `stale: true`, but WITH a
      //      real `rateDate` (an actual NBU publication from the nearest prior
      //      business day) — exact and final. Refusing that would block payouts
      //      on ordinary non-working days for no gain.
      //   2. only when a rate is actually APPLIED. `convertToUsdtMinor` is the
      //      identity for USDT and USD (1:1 peg), so a batch denominated only
      //      in those needs no rate at all and must go through even with NBU
      //      completely unavailable — refusing it would break the common case
      //      while fixing the rare one.
      //
      // The caller can retry once NBU recovers; nothing has been written yet
      // (this throw rolls the surrounding transaction back before any INSERT).
      //
      // NOT recorded: which rate produced a stored amount. `payout_requests`
      // has no column for the rate, its date or a note, so an accepted
      // conversion leaves no provenance behind — see the task report (AC10);
      // adding one is a schema change, deliberately out of scope here.
      const needsRateConversion = lockedRows.some(
        (tx) => tx.currency !== 'USDT' && tx.currency !== 'USD',
      )
      if (needsRateConversion && rateResult.stale && rateResult.rateDate === undefined) {
        throw new BadRequestException(
          'Курс НБУ недоступен — сумма выплаты в USDT не может быть рассчитана. Повторите позже.',
        )
      }

      const SCALE = 1_000_000
      let incomeUsdtMinor = 0
      let payableUsdtMinor = 0
      for (const tx of lockedRows) {
        // amount is stored as numeric string from Postgres.
        const amountMinor = Math.round(parseFloat(tx.amount) * SCALE)
        // task-drop-payout-company-account: the share the recipient keeps off
        // the company transfer differs by caller — `seniorSharePercent` (per-
        // income snapshot) for a SENIOR, `dropSharePercent` (per-user) for a
        // DROP. The company keeps `1 - keptShare%` in BOTH cases; for a DROP the
        // senior's slice of the same income is NOT subtracted here — it stays in
        // the company-transfer and is later booked as a COMPANY → senior
        // obligation in applyPayoutPaidCascade (so the money is accounted once,
        // on the company account, then re-distributed to the senior on settle).
        const sharePercent = isDrop
          ? (tx.dropSharePercent ?? dropSharePercentFallback)
          : (tx.seniorSharePercent ?? DEFAULT_SENIOR_SHARE_PERCENT)
        // company's share = 1 - keptShare/100; integer arithmetic on the
        // scaled amount avoids per-iteration float drift.
        const companyShareMinor = Math.round((amountMinor * (100 - sharePercent)) / 100)
        // Convert BOTH the gross income and the company-share to USDT so the
        // recorded incomeAmount/payableAmount are coherent in one currency.
        incomeUsdtMinor += this.convertToUsdtMinor(amountMinor, tx.currency, rates)
        payableUsdtMinor += this.convertToUsdtMinor(companyShareMinor, tx.currency, rates)
      }
      const incomeAmount = (incomeUsdtMinor / SCALE).toFixed(6)
      const payableAmount = (payableUsdtMinor / SCALE).toFixed(6)

      // Step 3: insert payout_request. All writes are inside the transaction.
      // contractAddress = company wallet (recipient); amounts are USDT.
      const [req] = await dbtx
        .insert(payoutRequests)
        .values({
          seniorId: currentUser.id,
          incomeAmount,
          payableAmount,
          contractAddress,
          status: 'PENDING',
        })
        .returning()

      // Step 4: link income transactions to this payout_request and flip
      // their status to PENDING_PAYMENT. The WHERE uses the locked row ids
      // (not the caller-supplied list) so the update is constrained to the
      // exact rows we validated above.
      const lockedIds = lockedRows.map((tx) => tx.id)
      await dbtx
        .update(transactions)
        .set({ payoutRequestId: req!.id, status: 'PENDING_PAYMENT', updatedAt: new Date() })
        .where(inArray(transactions.id, lockedIds))

      // Step 5: create the placeholder PAYOUT row (PENDING_PAYMENT). Always
      // USDT (Phase 8 v2 — settlement with the company is in crypto; amount is
      // the USDT-converted payable). This row is visible in the transactions
      // table immediately so the SENIOR can click «Оплатить» without waiting
      // for the payout_request detail page. The same row is mutated to PAID in
      // payPayoutRequest (txHash + status flip + fundingSource marker) — no
      // fresh PAYOUT is inserted there.
      //
      // backlog 144: this row used to be inserted WITHOUT `projectId`, so
      // `GET /api/transactions?projectId=` (and anything else that filters on
      // it) could never see it — no matter its status. `confirmPayout` later
      // snapshots `projectId: payoutTx.projectId` from THIS row onto the
      // PAYOUT_CONFIRMED row it creates, so the gap propagated there too.
      // `applyPayoutPaidCascade` already treats "the first linked income's
      // project" as the batch's primary project for the SAME reason (see its
      // `primaryProjectId` — the standing UX is "a payout = one project"; a
      // DROP batch is additionally hard-enforced to a single project above).
      // Mirror that here. `lockedRows[0]` always exists — the count-mismatch
      // guard above already threw if the batch were empty. `?? null` is
      // defense-in-depth only: `createSeniorIncome`/`createDropIncome` require
      // a resolvable `projectId` at creation time, so a locked SENIOR_INCOME/
      // DROP_INCOME row is never legitimately projectless today.
      const primaryProjectId = lockedRows[0]?.projectId ?? null
      await dbtx.insert(transactions).values({
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: payableAmount,
        currency: 'USDT',
        senderId: currentUser.id,
        receiverLabel: 'CheekyCheeseIT',
        payoutRequestId: req!.id,
        projectId: primaryProjectId,
        createdBy: currentUser.id,
      })

      // Return only the id from inside the transaction. The detail read
      // (findPayoutRequest) MUST run on the base connection AFTER commit — it
      // uses this.db.db (a separate pooled client) which cannot see this
      // transaction's uncommitted rows, so reading it here would 404.
      return req!.id
    })

    return this.findPayoutRequest(newRequestId, currentUser)
  }

  // ── Pay Payout Request ────────────────────────────────────────────────────
  //
  // MUTUALLY EXCLUSIVE with manualConfirmPayout (M3): both can mark a payout
  // PAID, but only the FIRST one to run wins. Both gate on `req.status !==
  // 'PENDING'` → throw, so once either path flips the payout to PAID the other
  // can never re-credit it (no balance double-count). Design intent:
  //   payPayoutRequest    — the on-chain HAPPY PATH (SENIOR/DROP self-service,
  //                         Etherscan-verified recipient/amount/confirmations).
  //   manualConfirmPayout — the ADMIN/ACCOUNTANT ESCAPE HATCH for settlements
  //                         that happened off the on-chain path.
  // RBAC intent (code-review MED): SENIOR initiates AND pays SENIOR-project
  // payouts (they own the payout flow). DROP is additionally allowed here for
  // the drop-project settlement path — in that flow `payout_requests.seniorId`
  // points at the DROP user (the wallet owner of the off-platform transfer), so
  // the `req.seniorId === currentUser.id` ownership check below covers both.
  async payPayoutRequest(
    requestId: string,
    txHash: string | undefined,
    currentUser: SessionUser,
    simulateResult?: 'success' | 'error',
  ) {
    // Drop role - phase 2: DROP users own drop-project payouts. The legacy
    // SENIOR check is kept for senior-projects; either role can call this
    // endpoint and the `req.seniorId === currentUser.id` line below enforces
    // ownership in both cases. payout_requests.seniorId is a FK to users.id
    // (not constrained by role) — for drop flows it points at the DROP user.
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'DROP') {
      throw new ForbiddenException()
    }

    const req = await this.db.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    if (!req) throw new NotFoundException('Payout request not found')
    if (req.seniorId !== currentUser.id) throw new ForbiddenException()
    if (req.status !== 'PENDING') throw new BadRequestException('Payout request is already paid')

    // DEV-only simulate toggle (see PayPayoutRequestDto.simulateResult).
    // The dev/staging UI surfaces a radio group that lets the SENIOR rehearse
    // either branch without going on-chain. In production the flag is ignored —
    // real Etherscan verification owns the decision.
    // FAIL-CLOSED (security-review PR #438, MED-4). This used to be
    // `NODE_ENV !== 'production'`, i.e. an UNSET or typo'd NODE_ENV ('staging',
    // '') opened the simulate path in a real deployment: `simulateResult:
    // 'success'` from SENIOR/DROP bypasses Etherscan entirely, synthesises a
    // `0xSIM…` marker (which the registry rightly ignores) and STILL credits the
    // company account — "не регистрируется И кредитует". Mirror the hardened
    // form already used by EtherscanService (audit 2026-06-28 #13): only an
    // explicit development/test is non-prod; everything else is production.
    const nodeEnv = process.env['NODE_ENV']
    const isDevMode = nodeEnv === 'development' || nodeEnv === 'test'
    const isSimulating = isDevMode && simulateResult !== undefined
    if (isSimulating && simulateResult === 'error') {
      throw new BadRequestException('Симуляция: транзакция не подтверждена')
    }
    // simulateResult === 'success' (dev only) bypasses Etherscan and runs the
    // success cascade below.
    //
    // When simulating without a real on-chain hash, we synthesize a
    // deterministic stub hash so the audit trail (txHash column) is never
    // empty. The 0xSIM prefix is the convention the UI uses to skip the
    // etherscan link (see PayoutDetailDialog footer).
    // HIGH-1 (security-review PR #438): extract via the SHARED rule — accepts a
    // bare hash or an explorer link, lowercased. The previous
    // `trim().length >= 10` accepted any string verbatim, so a value the
    // registry could not recognise became the payout's `tx_hash`.
    const extractedTxHash = extractOnChainTxHash(txHash)
    const suppliedTxHash = txHash?.trim() ?? ''
    if (suppliedTxHash !== '' && extractedTxHash === null) {
      // Fail LOUD rather than settling with an unregistrable hash.
      throw new BadRequestException(
        'Некорректный hash транзакции — ожидается 0x + 64 hex или ссылка на Etherscan',
      )
    }
    const effectiveTxHash =
      extractedTxHash ??
      (isSimulating
        ? `0xSIM${randomBytes(28).toString('hex')}`
        : (() => {
            throw new BadRequestException('Хеш транзакции обязателен')
          })())

    // ── Phase 8 v2 — REAL on-chain validation (INVARIANT #1).
    // Outside dev-simulate, the payout is marked PAID ONLY when the submitted
    // tx really sent EXACTLY the payable USDT to the COMPANY wallet and is
    // confirmed. EtherscanService.verifyDeposit asserts recipient +
    // confirmation count; we additionally require the transferred amount to
    // equal `payableAmount` EXACTLY (integer minor units — see below).
    // ANY failure (recipient mismatch / not confirmed / amount off / no wallet)
    // throws BEFORE the status flip — the payout stays PENDING, nothing is
    // credited to the company account.
    // On-chain sender, resolved during verification and persisted on the payout
    // for audit. Stays null for dev-simulate settlements (no chain data).
    let onChainFromAddress: string | null = null

    if (!isSimulating) {
      const account = await this.db.db.query.companyAccount.findFirst()
      if (!account?.walletAddress) {
        throw new BadRequestException('Кошелёк компании не настроен')
      }

      // Idempotency (HOLE 2): a txHash already consumed by ANY on-chain
      // settlement — a PAID payout OR a company deposit — must not settle this
      // one too. The on-chain transfer happened once; re-using its hash
      // double-credits the company account. The registry is cross-path on
      // purpose: the previous per-table guards (payout_requests here,
      // transactions there) were blind to each other, so one transfer could be
      // spent in BOTH. Fast-fail read only — the authoritative claim happens
      // inside the cascade transaction (`consumeTxHash`).
      const consumed = await findConsumedTxHash(this.db.db, effectiveTxHash)
      if (consumed) {
        throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
      }
      // Legacy guard kept as-is: rows settled BEFORE the registry existed are
      // backfilled by the migration, but this costs one indexed read and keeps
      // the check meaningful even if a backfill was skipped.
      const reused = await this.db.db.query.payoutRequests.findFirst({
        where: and(eq(payoutRequests.txHash, effectiveTxHash), eq(payoutRequests.status, 'PAID')),
      })
      if (reused) {
        throw new BadRequestException('Этот хеш транзакции уже использован для другой выплаты')
      }

      const verification = await this.etherscan.verifyDeposit(
        effectiveTxHash,
        account.walletAddress,
        account.confirmationThreshold,
      )
      if (!verification.toMatches) {
        throw new BadRequestException('Получатель транзакции не совпадает с кошельком компании')
      }
      if (!verification.confirmed) {
        throw new BadRequestException('Транзакция ещё не подтверждена в сети')
      }

      // ── SECURITY (task-onchain-payment-integrity): EXACT AMOUNT ────────────
      // The transfer must move EXACTLY `payableAmount` — no percentage band.
      //
      // WHY the old ±1% band was a hole: the recipient (the company wallet) is
      // published in the payout itself, so the owner of a payout could open a
      // public explorer, pick ANY stranger's incoming transfer whose size fell
      // inside the band, and submit it as their own payment — payout PAID,
      // incomes PAID, company account credited, company's share still in their
      // pocket. The band was wide enough to make such a transfer easy to find
      // (1% of a five-figure payout is a ±$100 window), and the payer even
      // chooses which incomes to group, steering `payableAmount` toward
      // whatever transfer they found. Exact equality collapses that search
      // space to "a transfer for precisely my amount" and, combined with the
      // consumed-hash registry, each such transfer is spendable only once.
      //
      // HOW the comparison is done: integer minor units (10^-6 USDT) on BOTH
      // sides — `amountUsdtMinor` is the raw uint256 sum straight from the
      // Transfer logs, `usdtToMinorUnits` parses the `numeric(18,6)` payable
      // string digit-by-digit. No float ever participates, so there is no
      // representation error to "absorb" and no hidden rounding. A null on
      // either side (unresolved / malformed) is a mismatch — never credit a
      // payout whose transferred amount we cannot verify.
      const payableMinor = usdtToMinorUnits(req.payableAmount)
      const onChainMinor = minorUnitsFromString(verification.amountUsdtMinor)
      if (payableMinor === null || payableMinor <= 0n || onChainMinor !== payableMinor) {
        throw new BadRequestException(
          `Сумма on-chain транзакции должна точно совпадать с суммой выплаты (${req.payableAmount} USDT)`,
        )
      }

      // Record WHO sent it (observable, non-blocking — exchange withdrawals
      // legitimately show the exchange's wallet). Persisted by the cascade.
      onChainFromAddress = normalizeEthAddress(verification.fromAddress)
    }

    // On-chain (or dev-simulate) settlement landed on the COMPANY wallet → the
    // PAYOUT row is credited to the company account (fundingSource marker).
    return this.applyPayoutPaidCascade(
      req,
      effectiveTxHash,
      PAYOUT_TO_COMPANY_ACCOUNT,
      null,
      currentUser,
      false,
      onChainFromAddress,
    )
  }

  // ── Manual payout confirmation (Phase 8 v2) ──────────────────────────────
  //
  // ADMIN/ACCOUNTANT escape hatch for payouts settled OFF the on-chain happy
  // path. `method` decides whether the company balance moves:
  //   COMPANY_ACCOUNT → credited (fundingSource marker, same as on-chain).
  //   ADMIN_USDT / CASH → NOT credited (money landed off the company account);
  //                       the PAYOUT row keeps fundingSource NULL.
  // The downstream cascade (linked incomes → PAID, partner splits, invoice) is
  // identical to payPayoutRequest — only the credit marker + audit note differ.
  //
  // MUTUALLY EXCLUSIVE with payPayoutRequest (M3): see that method's header.
  // Both gate on `req.status !== 'PENDING'`, so an on-chain-paid payout cannot
  // also be manual-confirmed (and vice-versa) — the second caller throws and
  // the balance is never double-credited (cross-path test asserts this).
  async manualConfirmPayout(
    requestId: string,
    method: ManualPayoutMethod,
    currentUser: SessionUser,
    options: { note?: string | null; txHash?: string | null } = {},
  ) {
    // RBAC: ADMIN/ACCOUNTANT only (NOT SENIOR/DROP). Real 403 enforced here AND
    // by the controller RolesGuard (defense-in-depth).
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const req = await this.db.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    if (!req) throw new NotFoundException('Payout request not found')
    // Idempotency: only a still-PENDING payout can be confirmed; a second
    // confirmation throws (the cascade already ran, balance already moved).
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Payout request is already paid')
    }

    // Audit hash: use the provided on-chain hash when present, else a manual
    // marker so the audit trail (txHash column) is never empty. Manual markers
    // use a 0xMANUAL prefix (distinct from the 0xSIM dev-simulate convention).
    const noteTxHash = options.txHash?.trim() ?? ''
    // ── HIGH-1 (security-review PR #438): THE EXPLOITED LINE.
    // This was `Boolean(noteTxHash && noteTxHash.length >= 10)` and
    // `effectiveTxHash = noteTxHash` — the raw input, unparsed. Pasting an
    // explorer LINK (`https://etherscan.io/tx/0x…`, the very format the
    // neighbouring deposit endpoint advertises) therefore produced a
    // COMPANY_ACCOUNT credit whose `tx_hash` the consumed-hash registry could
    // not recognise: `consumeTxHash` saw "not a real hash" and returned without
    // inserting, so the SAME transfer was still free to be credited again as a
    // deposit (and the mirror order worked too). No malice needed — one paste.
    //
    // Now the SHARED extractor runs first (bare hash OR link → lowercase hash),
    // so what lands in `tx_hash` is exactly what the registry claims.
    const extractedTxHash = extractOnChainTxHash(noteTxHash)
    if (noteTxHash !== '' && extractedTxHash === null) {
      // Fail LOUD: a supplied-but-unparseable hash must never silently degrade
      // into an unregistered credit (it would also poison the audit column).
      throw new BadRequestException(
        'Некорректный hash транзакции — ожидается 0x + 64 hex или ссылка на Etherscan',
      )
    }
    // A REAL on-chain hash was supplied (vs. a synthesized 0xMANUAL marker).
    // Only a real hash references an actual on-chain transfer that could be
    // double-counted; the random 0xMANUAL/0xSIM markers are unique by
    // construction, so they need no reuse guard.
    const hasRealTxHash = extractedTxHash !== null
    const effectiveTxHash = extractedTxHash ?? `0xMANUAL${randomBytes(26).toString('hex')}`

    // Only COMPANY_ACCOUNT credits the company balance; ADMIN_USDT / CASH leave
    // fundingSource NULL so computeBalance ignores this PAYOUT row.
    const fundingSource = method === 'COMPANY_ACCOUNT' ? PAYOUT_TO_COMPANY_ACCOUNT : null

    // ── SECURITY (H1 + LOW #6): txHash-reuse guard, now TWO layers.
    // When the manual confirmation CREDITS the company account (COMPANY_ACCOUNT)
    // and references a REAL on-chain hash, that hash must not already belong to
    // another PAID payout — otherwise an ADMIN/ACCOUNTANT could credit the company
    // balance TWICE for a single on-chain transfer (no DB unique index on
    // payout_requests.txHash backstops this).
    //   Layer 1 (here, pre-transaction): a fast-fail UX gate so the user gets the
    //     clean error before any work. NOT authoritative on its own (TOCTOU — the
    //     read can go stale before the credit).
    //   Layer 2 (applyPayoutPaidCascade, in-transaction): `guardTxHashReuse=true`
    //     re-runs the SAME check INSIDE the serialized PENDING→PAID flip, after the
    //     row-locked claim, so a concurrent confirm with the same hash loses. This
    //     is the authoritative, TOCTOU-safe guard (audit 2026-06-27 #6).
    // ADMIN_USDT / CASH never credit the balance and synthetic markers are unique,
    // so the guard is scoped to the only exploitable path.
    const needsReuseGuard = method === 'COMPANY_ACCOUNT' && hasRealTxHash
    if (needsReuseGuard) {
      const reused = await this.db.db.query.payoutRequests.findFirst({
        where: and(eq(payoutRequests.txHash, effectiveTxHash), eq(payoutRequests.status, 'PAID')),
      })
      if (reused) {
        throw new BadRequestException('Этот хеш транзакции уже использован для другой выплаты')
      }
    }
    // HOLE 2 fast-fail: a real hash already spent by ANY path (incl. a company
    // DEPOSIT, which the payout-table scan above cannot see). Applies to EVERY
    // method — even a non-crediting ADMIN_USDT/CASH confirmation must not
    // re-use a transfer that already settled something else. Authoritative
    // claim happens inside `applyPayoutPaidCascade`.
    if (hasRealTxHash) {
      const consumed = await findConsumedTxHash(this.db.db, effectiveTxHash)
      if (consumed) {
        throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
      }
    }
    const auditNote = `Manual payout confirmation by ${currentUser.id} at ${new Date().toISOString()} (method=${method})${
      options.note ? ` — ${options.note}` : ''
    }`

    return this.applyPayoutPaidCascade(
      req,
      effectiveTxHash,
      fundingSource,
      auditNote,
      currentUser,
      needsReuseGuard,
    )
  }

  /**
   * task-drop-share-override-and-receiver (D4). Book the company's obligations to
   * the project's senior and/or drop after project income lands somewhere other
   * than their own balance (admin-declared USDT income, or the senior slice of a
   * drop payout). Each obligation is a visible PENDING_PAYMENT IOU row PLUS a
   * pending_obligations row (creditor=<senior|drop>, debtorType='COMPANY',
   * sourceTransactionId=IOU), later closed via settleByCompany.
   *
   * Shared by BOTH the drop-payout cascade (task-drop-share-pending-parity:
   * since PR #443, BOTH the senior AND the drop IOU are booked here — the
   * drop's own slice is no longer paid directly via an instant PAYOUT_DROP)
   * and declareUsdtProjectIncome (both IOUs), so the IOU row shape never
   * drifts between the two booking paths.
   *
   *   - Senior IOU: booked only when a senior is supplied AND `senior.role !==
   *     'ADMIN'` (an admin partner is never owed via a company IOU).
   *   - Drop IOU:   booked only when a drop is supplied (project.dropId != null).
   *
   * Amounts are gross × effective share, rounded via `roundShareAmount` so they
   * match `computeDropDistribution` exactly. MUST run inside the caller's
   * `db.transaction` (dbtx) so income + obligations commit atomically
   * (anti-BIZ-02: never an income row without its obligations).
   */
  private async bookCompanyObligations(
    dbtx: DrizzleTx,
    params: {
      incomeAmount: number
      projectId: string
      // task-drop-sees-own-obligations (security-review PR #523 round 1,
      // MED-4). `projects.companyName` AT BOOKING TIME — both callers
      // already have the project row loaded (they need `dropId`/`seniorId`
      // off it), so this is a pass-through, not an extra query. Stamped onto
      // `companyNameSnapshot` below so a later project rename can never
      // rewrite what a senior/drop reads as the history of money already
      // booked under the old name (see that column's doc in schema.ts).
      companyName: string
      createdBy: string
      payoutRequestId?: string | null
      // task-admin-income-drop-backfill: the income transaction this booking
      // was caused by, when the caller knows it — see the column comment on
      // `transactions.sourceIncomeTransactionId` in schema.ts for the full
      // reasoning (declareUsdtProjectIncome always passes it; the payout
      // cascade deliberately does not — no single source income to name).
      incomeTransactionId?: string | null
      senior?: {
        id: string
        role: string
        shareSnapshot: { value: number; source: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' }
      } | null
      drop?: {
        id: string
        shareSnapshot: { value: number; source: 'PROJECT' | 'USER_DEFAULT' }
      } | null
      notePrefix?: string
    },
  ): Promise<{ seniorAmount: number | null; dropAmount: number | null }> {
    const { incomeAmount, projectId, companyName, createdBy, payoutRequestId, senior, drop } =
      params
    const incomeTransactionId = params.incomeTransactionId ?? null
    const notePrefix = params.notePrefix ?? 'Company owes'
    let seniorAmount: number | null = null
    let dropAmount: number | null = null

    // Senior IOU — never for an ADMIN partner.
    if (senior && senior.role !== 'ADMIN') {
      seniorAmount = roundShareAmount(incomeAmount, senior.shareSnapshot.value)
      const [pendingRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: String(seniorAmount),
          currency: 'USDT',
          senderLabel: 'COMPANY',
          receiverId: senior.id,
          recipientId: senior.id,
          projectId,
          payoutRequestId: payoutRequestId ?? null,
          seniorSharePercent: senior.shareSnapshot.value,
          seniorSharePercentSource: senior.shareSnapshot.source,
          notes: `${notePrefix} — senior IOU (debtor=COMPANY)`,
          createdBy,
          sourceIncomeTransactionId: incomeTransactionId,
          companyNameSnapshot: companyName,
        })
        .returning()
      if (pendingRow) {
        await dbtx.insert(pendingObligations).values({
          creditorUserId: senior.id,
          debtorType: 'COMPANY',
          debtorUserId: null,
          sourceTransactionId: pendingRow.id,
          amount: String(seniorAmount),
          currency: 'USDT',
          status: 'PENDING',
          // task-settle-payout-link-lost (backlog 74/B-1): same payoutRequestId
          // the source IOU row gets — this column SURVIVES settleByCompany's
          // reset of `transactions.payoutRequestId` on the flip (see the column
          // comment in schema.ts), so a payout's detail read can still resolve
          // this obligation after it is settled.
          payoutRequestId: payoutRequestId ?? null,
        })
      }
    }

    // Drop IOU — only when the project has a drop bound.
    if (drop) {
      dropAmount = roundShareAmount(incomeAmount, drop.shareSnapshot.value)
      const [pendingRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'DROP_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: String(dropAmount),
          currency: 'USDT',
          senderLabel: 'COMPANY',
          receiverId: drop.id,
          recipientId: drop.id,
          projectId,
          payoutRequestId: payoutRequestId ?? null,
          // security-review PR #443 (MED-B): a positive, permanent origin
          // marker — true ⟺ this call came from the drop-payout cascade
          // (applyPayoutPaidCascade passes payoutRequestId; the admin-USDT
          // declaration path, declareUsdtProjectIncome, never does). Captured
          // HERE from the caller's intent, not derived later from
          // payoutRequestId's live FK value — see the column comment in
          // schema.ts for why that distinction matters (ON DELETE SET NULL).
          dropCascadeOrigin: payoutRequestId != null,
          dropSharePercent: drop.shareSnapshot.value,
          dropSharePercentSource: drop.shareSnapshot.source,
          notes: `${notePrefix} — drop IOU (debtor=COMPANY)`,
          createdBy,
          sourceIncomeTransactionId: incomeTransactionId,
          companyNameSnapshot: companyName,
        })
        .returning()
      if (pendingRow) {
        await dbtx.insert(pendingObligations).values({
          creditorUserId: drop.id,
          debtorType: 'COMPANY',
          debtorUserId: null,
          sourceTransactionId: pendingRow.id,
          amount: String(dropAmount),
          currency: 'USDT',
          status: 'PENDING',
          // task-settle-payout-link-lost: see the matching comment on the
          // senior branch above — same reasoning, same source value.
          payoutRequestId: payoutRequestId ?? null,
        })
      }
    }

    return { seniorAmount, dropAmount }
  }

  /**
   * Phase 8 v2 — shared "mark payout PAID + cascade" used by BOTH
   * payPayoutRequest (on-chain) and manualConfirmPayout (off-chain). Flips the
   * payout_request + linked incomes + PAYOUT row to PAID, stamps the PAYOUT
   * row's fundingSource (credit marker), best-effort aggregated invoice, and
   * the drop/senior partner-split rows. Extracted to keep the two entry points
   * in lockstep (no ledger drift) — the ONLY differences are the fundingSource
   * marker and the audit note, both passed in.
   *
   * `req` is the already-loaded, validated, still-PENDING payout_request row.
   * Callers MUST have enforced ownership / RBAC / verification before calling.
   */
  private async applyPayoutPaidCascade(
    req: typeof payoutRequests.$inferSelect,
    effectiveTxHash: string,
    fundingSource: string | null,
    auditNote: string | null,
    currentUser: SessionUser,
    // Audit 2026-06-27 (LOW #6, defense-in-depth). When true, re-check INSIDE the
    // transaction that `effectiveTxHash` is not already consumed by another PAID
    // payout — used by manualConfirmPayout's COMPANY_ACCOUNT path where a real
    // on-chain hash credits the company balance. Running the guard inside the
    // serialized flip (below) closes the TOCTOU the previous out-of-transaction
    // SELECT left open. payPayoutRequest passes false (it runs its own pre-check;
    // the unique index uq_payout_requests_txhash_paid remains the hard backstop).
    guardTxHashReuse = false,
    // task-onchain-payment-integrity. On-chain SENDER of the settling transfer,
    // already normalised by the caller (null for manual/off-chain/simulate
    // settlements). Stamped on the payout_request AND the PAYOUT ledger row —
    // audit data, never a gate.
    onChainFromAddress: string | null = null,
  ) {
    const requestId = req.id

    // ── SECURITY (M1): ATOMIC ledger cascade.
    // Every ledger mutation that flips this payout PAID — the payout_request,
    // the linked income rows, the PAYOUT row (+ fundingSource credit marker),
    // and the partner-split inserts (PAYOUT_DROP / PAYOUT_ADMIN) — runs inside
    // ONE DB transaction. Previously these were sequential `await`s on the bare
    // connection: a failure midway (e.g. a missing admin row, a DB blip) left a
    // partially-committed cascade — payout PAID + balance credited but the
    // partner splits missing, drifting the ledger. The transaction makes the
    // whole flip all-or-nothing.
    //
    // INTENTIONALLY OUTSIDE the transaction: `safeAutoCreateInvoice` (best-effort,
    // no-rollback contract — see its header). It must NOT abort or roll back the
    // money cascade if invoice generation fails, so we capture the PAYOUT row id
    // inside the tx and fire the invoice trigger AFTER the commit. The final
    // `findPayoutRequest` is a read and likewise runs post-commit.
    let payoutRowId: string | null
    try {
      payoutRowId = await this.db.db.transaction(async (dbtx) => {
        // ── SECURITY (LOW #6, TOCTOU): serialize the PENDING→PAID flip.
        // The conditional UPDATE flips the payout to PAID ONLY WHERE it is still
        // PENDING and RETURNS the affected rows. The UPDATE takes a row lock and
        // re-evaluates `status='PENDING'` against the committed row, so two
        // concurrent / repeated confirms (a double-clicked manual-confirm, or
        // payPayoutRequest racing manualConfirmPayout) can never both win — the
        // loser sees 0 rows and bails out BEFORE any income/PAYOUT/partner write
        // or company-account credit happens (the whole tx rolls back). Previously
        // the flip was an unconditional UPDATE preceded by an out-of-transaction
        // status read — that read could go stale between check and write.
        const claimed = await dbtx
          .update(payoutRequests)
          .set({
            txHash: effectiveTxHash,
            // Recorded sender (audit). Null on manual/simulate settlements.
            txFromAddress: onChainFromAddress,
            status: 'PAID',
            updatedAt: new Date(),
          })
          .where(and(eq(payoutRequests.id, requestId), eq(payoutRequests.status, 'PENDING')))
          .returning({ id: payoutRequests.id })
        if (claimed.length === 0) {
          // A concurrent / repeated confirm already flipped this payout.
          throw new BadRequestException('Payout request is already paid')
        }

        // ── SECURITY (LOW #6, defense-in-depth): in-transaction txHash-reuse guard.
        // For the manual COMPANY_ACCOUNT path the on-chain hash credits the company
        // balance, so a hash already consumed by another PAID payout must be
        // rejected. Running this SELECT INSIDE the serialized flip (after the claim,
        // before any credit) closes the TOCTOU the previous pre-transaction SELECT
        // left open; the unique index uq_payout_requests_txhash_paid is the hard
        // backstop. Exclude THIS request (just flipped to PAID above) from the scan.
        if (guardTxHashReuse) {
          const reused = await dbtx.query.payoutRequests.findFirst({
            where: and(
              eq(payoutRequests.txHash, effectiveTxHash),
              eq(payoutRequests.status, 'PAID'),
              ne(payoutRequests.id, requestId),
            ),
          })
          if (reused) {
            throw new BadRequestException('Этот хеш транзакции уже использован для другой выплаты')
          }
        }

        // ── SECURITY (task-onchain-payment-integrity, HOLE 2): CROSS-PATH claim.
        // Claim the on-chain hash in the shared `consumed_tx_hashes` registry,
        // INSIDE this transaction, before anything is credited. This is the
        // authoritative guard (the pre-checks above are UX fast-fails that can
        // go stale): two concurrent settlements of the same hash — even across
        // DIFFERENT money paths (this payout vs. a company deposit) — are
        // decided by the unique index, so exactly one commits and the other
        // rolls back whole. Prior to this the payout path only scanned
        // `payout_requests` and the deposit path only `transactions`, so ONE
        // transfer could legally settle a payout AND credit a deposit, and
        // `computeCompanyAccountBalanceFromLedger` summed both terms — phantom
        // money that then funded salary/expense/dividend gates.
        //
        // Runs for BOTH entry points (on-chain pay + manual confirm) and for
        // EVERY method: an ADMIN_USDT/CASH confirmation that references a REAL
        // hash consumes that transfer too, otherwise the same hash could still
        // be re-spent as a deposit. Synthetic markers (0xSIM…/0xMANUAL…) are
        // no-ops — see `consumeTxHash`.
        //
        // The condition is `hasRealTxHash`, NOT "credits the balance": a manual
        // ADMIN_USDT / CASH confirmation leaves `fundingSource` null and never
        // touches the company balance, yet it DID spend a real transfer, which
        // must therefore not also be claimable as a deposit. See
        // `settlementConsumesTransfer` for why the three paths differ.
        if (
          settlementConsumesTransfer({
            kind: 'PAYOUT',
            hasRealTxHash: normalizeOnChainTxHash(effectiveTxHash) !== null,
          })
        ) {
          const claim = await consumeTxHash(dbtx, {
            txHash: effectiveTxHash,
            purpose: 'PAYOUT',
            referenceId: requestId,
            consumedByUserId: currentUser.id,
          })
          if (claim.reclaimedAfterRelease) {
            await this.recordReclaimAfterRelease(dbtx, {
              path: 'applyPayoutPaidCascade',
              txHash: effectiveTxHash,
              referenceId: requestId,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }

        // Mark linked SENIOR_INCOME transactions as PAID
        await dbtx
          .update(transactions)
          .set({
            status: 'PAID',
            updatedAt: new Date(),
          })
          .where(eq(transactions.payoutRequestId, requestId))

        // Re-fetch the linked incomes for the drop-vs-senior routing below.
        // task-aggregate-invoice-per-payout: the per-income invoice trigger that
        // used to live here has been replaced by a single PAYOUT-trigger fired
        // AFTER the PAYOUT row flips to PAID (see below) — one invoice that
        // aggregates all linked SENIOR_INCOME / DROP_INCOME rows.
        // Drop role - phase 2: DROP_INCOME is included so drop-projects flow
        // through the same aggregation.
        const paidIncomeTxs = await dbtx
          .select({
            id: transactions.id,
            projectId: transactions.projectId,
            type: transactions.type,
            // task-drop-share-override-and-receiver (Part A). Per-income drop
            // share snapshot — used below so the distribution matches what was
            // stamped on the DROP_INCOME at creation time (deterministic).
            dropSharePercent: transactions.dropSharePercent,
            // task-drop-share-pending-parity: the matching source discriminator
            // (PROJECT / USER_DEFAULT) so the DROP_PENDING_PAYOUT snapshot booked
            // below carries the SAME {value, source} pair bookCompanyObligations
            // expects (mirrors declareUsdtProjectIncome's dropSnapshot shape).
            dropSharePercentSource: transactions.dropSharePercentSource,
          })
          .from(transactions)
          .where(
            and(
              eq(transactions.payoutRequestId, requestId),
              or(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.type, 'DROP_INCOME')),
            ),
          )

        // Mark the placeholder PAYOUT row (created at createPayoutRequest time)
        // as PAID + attach the txHash. We don't INSERT a fresh PAYOUT here — the
        // row already exists with status PENDING_PAYMENT so the SENIOR could see
        // «Выплата» in the table before clicking «Оплатить».
        //
        // Phase 8 v2 — `fundingSource` is the company-account credit marker:
        //   'COMPANY_ACCOUNT' (on-chain confirm OR manual COMPANY_ACCOUNT) → counted
        //                     by company-account computeBalance.
        //   null (manual ADMIN_USDT / CASH) → NOT counted (money landed off the
        //                     company account). The auditNote records the manual
        //                     method when present.
        //
        // BIZ-02 defense-in-depth (HIGH-1 fix): the payout_requests atomic claim
        // above is the PRIMARY race guard — the loser bails there before any
        // ledger write. The PAYOUT row UPDATE below is intentionally idempotent:
        // if the row was already flipped (e.g. by confirmPayout racing in AFTER
        // the payout_request claim), we fall through to a SELECT to recover the
        // existing id. NO throw here — an aggressive throw broke legitimate
        // payPayoutRequest / manualConfirmPayout flows where the first bulk UPDATE
        // (status='PAID' WHERE payoutRequestId=...) had already flipped the PAYOUT
        // row before this targeted UPDATE ran, causing 28 integration failures.
        // Lock-order inversion (HIGH-2): removing this secondary re-lock also
        // eliminates the P→R vs R→P deadlock risk (concurrent confirmPayout ⟂
        // payPayoutRequest paths no longer compete for the PAYOUT row lock here).
        const payoutUpdated = await dbtx
          .update(transactions)
          .set({
            status: 'PAID',
            txHash: effectiveTxHash,
            // task-onchain-payment-integrity: recorded on-chain sender (audit).
            txFromAddress: onChainFromAddress,
            fundingSource,
            updatedAt: new Date(),
            ...(auditNote ? { notes: auditNote } : {}),
          })
          .where(
            and(
              eq(transactions.payoutRequestId, requestId),
              eq(transactions.type, 'PAYOUT'),
              eq(transactions.status, 'PENDING_PAYMENT'),
            ),
          )
          .returning({ id: transactions.id })

        // Idempotent fallback: if the PAYOUT row was already PAID (0 rows
        // returned above), the bulk UPDATE at line ~2471 (WHERE payoutRequestId=requestId,
        // no type filter) already flipped the PAYOUT row to PAID but did NOT set
        // txHash / fundingSource / notes. We must write those fields now so that
        // computeBalance sees fundingSource='COMPANY_ACCOUNT' and credits the company.
        let payoutRow: { id: string }
        if (payoutUpdated.length > 0) {
          payoutRow = payoutUpdated[0]!
        } else {
          // Patch missing txHash + fundingSource on the already-PAID PAYOUT row.
          await dbtx
            .update(transactions)
            .set({
              txHash: effectiveTxHash,
              txFromAddress: onChainFromAddress,
              fundingSource,
              updatedAt: new Date(),
              ...(auditNote ? { notes: auditNote } : {}),
            })
            .where(
              and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')),
            )
          const existing = await dbtx
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')),
            )
            .limit(1)
          if (existing.length === 0) {
            throw new BadRequestException('PAYOUT transaction not found for this request')
          }
          payoutRow = existing[0]!
        }

        // ── AUDIT (task-onchain-payment-integrity): who settled this payout,
        // with which on-chain transfer, and WHO SENT that transfer. Written in
        // the same transaction as the credit, so the trail cannot drift from the
        // ledger. The sender is audit data, not a gate (exchange withdrawals) —
        // this row is what an investigator reads when a settlement looks odd.
        await dbtx.insert(transactionAuditLog).values({
          actorId: currentUser.impersonatorId ?? currentUser.id,
          targetId: payoutRow.id,
          action: 'PAYOUT_SETTLED',
          metadata: {
            payoutRequestId: requestId,
            txHash: effectiveTxHash,
            txFromAddress: onChainFromAddress,
            fundingSource,
            payableAmount: req.payableAmount,
            ...(auditNote ? { note: auditNote } : {}),
          },
        })

        // Drop role - phase 2 (AC3). Resolve whether the linked SENIOR_INCOMEs
        // belong to a drop-project. Senior-projects (project.dropId === null)
        // keep the legacy 50/50 split untouched — this is the regression-safe
        // path. Drop-projects route the partner residual through
        // `computeDropDistribution` and additionally insert PAYOUT_DROP.
        //
        // The payout_request groups SENIOR_INCOMEs by senior; in the current
        // model all of them target the same senior, but they may span multiple
        // projects. We treat the FIRST linked SENIOR_INCOME's project as the
        // "primary" project for drop-vs-senior routing. The standing UX is "a
        // payout = one project" — see PayoutDetailDialog header — so this
        // assumption matches what the SENIOR sees.
        const primaryProjectId = paidIncomeTxs[0]?.projectId ?? null
        const primaryProject = primaryProjectId
          ? await dbtx.query.projects.findFirst({
              where: eq(projects.id, primaryProjectId),
            })
          : null

        const dropUser = primaryProject?.dropId
          ? await dbtx.query.users.findFirst({
              where: eq(users.id, primaryProject.dropId),
            })
          : null

        if (dropUser && primaryProject) {
          // Drop-project branch.
          //
          // Distribution is computed on the GROSS income, not on `payable`.
          // `payable` is `income * (1 - dropShare/100)` here (validateTransaction
          // recorded this when flipping DROP_INCOME→VALIDATED on a drop-project),
          // and represents what the drop transfers off-platform — the residual
          // for partners after the drop keeps their slice. In the senior-project
          // path the same `payable` field means something different (income *
          // (1 - seniorShare/100)) — context is the project, not the column.
          //
          // The SENIOR share is computed on GROSS, not on payable, so we read
          // the senior from the project (not from `req.seniorId` — that field
          // points at the wallet owner, which is the DROP in this flow).
          const senior = primaryProject.seniorId
            ? await dbtx.query.users.findFirst({
                where: eq(users.id, primaryProject.seniorId),
              })
            : null
          if (!senior) throw new NotFoundException('Senior not found on drop-project')

          // task-team-senior-share-override. Resolve the senior share WITH its
          // source (PROJECT / TEAM / USER_DEFAULT) so the SENIOR_PENDING_PAYOUT
          // + obligation carry the same snapshot the money trail used — keeps the
          // source badge consistent across the ledger. This reads team
          // memberships on the base connection (committed data), safe mid-txn.
          const seniorShareSnapshot = await this.resolveSeniorShareSnapshot(
            { seniorSharePercentOverride: primaryProject.seniorSharePercentOverride },
            { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
          )

          const income = parseFloat(req.incomeAmount)
          // task-drop-share-override-and-receiver (Part A). Drop share for the
          // distribution comes from the per-income snapshot (deterministic —
          // matches what was stamped on the DROP_INCOME), falling back to the
          // override-aware resolver for legacy rows created before the snapshot
          // column existed. The "one payout = one project" rule for DROP callers
          // guarantees a single project/override applies to the whole batch.
          //
          // task-drop-share-pending-parity: kept as a {value, source} pair (not a
          // bare number) — this is the EXACT shape bookCompanyObligations' `drop`
          // param expects (identical to declareUsdtProjectIncome's dropSnapshot),
          // so the booked DROP_PENDING_PAYOUT carries the same source badge a
          // fresh admin-USDT IOU would.
          const dropShareSnapshot: { value: number; source: 'PROJECT' | 'USER_DEFAULT' } =
            paidIncomeTxs[0]?.dropSharePercent != null
              ? {
                  value: paidIncomeTxs[0].dropSharePercent,
                  source:
                    paidIncomeTxs[0].dropSharePercentSource === 'PROJECT'
                      ? 'PROJECT'
                      : 'USER_DEFAULT',
                }
              : resolveDropShare(
                  { dropSharePercentOverride: primaryProject.dropSharePercentOverride },
                  { dropSharePercent: dropUser.dropSharePercent },
                )
          // computeDropDistribution is PURE (no DB) — safe inside the txn. Kept
          // here ONLY for its "senior% + drop% > 100" guard (unchanged
          // regression); the actual share AMOUNTS below now come from
          // bookCompanyObligations (roundShareAmount on the SAME snapshot), so
          // both stay pinned to identical numbers — see roundShareAmount's own
          // docstring ("shared by computeDropDistribution ... and
          // bookCompanyObligations ... so both price shares identically").
          this.computeDropDistribution(
            income,
            { id: primaryProject.id, dropId: primaryProject.dropId },
            { id: dropUser.id, dropSharePercent: dropShareSnapshot.value },
            { id: senior.id, seniorSharePercent: seniorShareSnapshot.value },
          )

          // task-drop-share-pending-parity: the drop's slice is NO LONGER a
          // direct PAID PAYOUT_DROP insert (that bypassed the owner's
          // "pending until confirmed with a receipt + sender account" rule —
          // see the task doc). It now goes through the SAME
          // bookCompanyObligations() call as the senior share (and as
          // declareUsdtProjectIncome's admin-USDT path): a DROP_PENDING_PAYOUT
          // (PENDING_PAYMENT) + a paired pending_obligations row (creditor=drop,
          // debtorType=COMPANY). An ADMIN/ACCOUNTANT later closes it via the
          // EXISTING settleByCompany (mandatory receipt + funding-source choice),
          // which flips this SAME row to PAYOUT_DROP/PAID in place — byte-shape
          // identical to a freshly-booked admin-USDT drop IOU (task doc §2/§3).
          //
          // Senior IOU is skipped when the senior is an ADMIN (never owed via a
          // company IOU — task-drop-share-override-and-receiver D4); drop IOU has
          // no such skip (a drop is never an ADMIN — RBAC-distinct role).
          await this.bookCompanyObligations(dbtx, {
            incomeAmount: income,
            projectId: primaryProject.id,
            companyName: primaryProject.companyName,
            createdBy: currentUser.id,
            payoutRequestId: requestId,
            senior: { id: senior.id, role: senior.role, shareSnapshot: seniorShareSnapshot },
            drop: { id: dropUser.id, shareSnapshot: dropShareSnapshot },
            notePrefix: 'Drop payout',
          })
        }
        // Senior-project branch: nothing else to write. The PAYOUT row (flipped
        // PAID + fundingSource credit marker above) is the entire settlement —
        // no partner-split rows. See the Variant-A comment in the drop branch.

        return payoutRow?.id ?? null
      })
    } catch (err) {
      // SECURITY (NEW-M1): the partial unique index uq_payout_requests_txhash_paid
      // is the TOCTOU backstop for the app-level reuse guard above. Under a race,
      // two PENDING payouts can pass the SELECT guard with the same real on-chain
      // hash; the SECOND flip-to-PAID violates the index (Postgres code 23505),
      // which aborts and rolls back THIS transaction. Surface it as a clear
      // BadRequest (never a 500) — identical message to the app-level guard — so
      // the company balance is never double-credited for one on-chain transfer.
      // Mirrors the 23505 catch in CompanyAccountService.submitDeposit (#249 M3).
      //
      // drizzle-orm wraps query failures in a DrizzleQueryError, so the pg error
      // (with `.code`) lives on `.cause` — walk the cause chain to find the
      // SQLSTATE rather than only reading the top-level error.
      //
      // Since task-onchain-payment-integrity the same catch also covers
      // `uq_consumed_tx_hashes_tx_hash` — the CROSS-PATH registry claim above.
      // That is the case where the competing consumer is a company DEPOSIT
      // rather than another payout, hence the wider wording.
      //
      // MED (security-review round 2): SWITCH ON THE CONSTRAINT. This cascade
      // writes to several constrained tables (payout_requests, transactions,
      // pending_obligations), so a blanket 23505 → "хеш уже использован" would
      // hand the user a plausible-sounding LIE whenever something else collided
      // (e.g. the receipt-uniqueness index). Only the two hash-reuse indexes map
      // to that message; anything else rethrows as a real error.
      const constraint = uniqueViolationConstraint(err)
      if (constraint !== null) {
        if (
          // MED-J (round 5) renamed the registry index when it became PARTIAL
          // (`…_active_tx_hash`). Both names are accepted: an allow-list that
          // silently misses the live index turns every racing claim into a 500,
          // which is exactly what this branch exists to prevent — and a rolling
          // deploy can briefly have either.
          constraint === 'uq_consumed_tx_hashes_active_tx_hash' ||
          constraint === 'uq_consumed_tx_hashes_tx_hash' ||
          constraint === 'uq_payout_requests_txhash_paid'
        ) {
          throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
        }
        // LOW (round 3): an UNATTRIBUTED violation (no constraint name) is NOT
        // assumed to be a hash reuse. Guessing produces a confident, wrong
        // explanation on the money path — exactly the failure mode MED-2 fixed
        // in the verifier. Log what we know and rethrow.
        this.logger.error(
          `[payout-cascade] unique violation on "${constraint || '<unattributed>'}" — rethrowing ` +
            `instead of reporting it as a tx-hash reuse (payout ${requestId})`,
        )
      }
      throw err
    }

    // ── POST-COMMIT (best-effort, no-rollback): aggregated invoice trigger.
    // task-aggregate-invoice-per-payout — ONE invoice anchored on the PAYOUT
    // row. Runs OUTSIDE the transaction so an invoice-generation failure can
    // never roll back the (already-committed) money cascade. Idempotency is
    // guarded by the PAYOUT row's own `invoice_document_id` field.
    if (payoutRowId) {
      await this.safeAutoCreateInvoice('PAYOUT', payoutRowId)
    }

    return this.findPayoutRequest(requestId, currentUser)
  }

  // ── Payout Requests ───────────────────────────────────────────────────────

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
    if (!req) throw new NotFoundException('Payout request not found')

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
      transactions: allTransactions.map((tx) => this.mapTx(tx, currentUser)),
      createdAt: req.createdAt.toISOString(),
      updatedAt: req.updatedAt.toISOString(),
    }
  }

  // ── Finance Summary (stats) ───────────────────────────────────────────────

  async getSummary(currentUser: SessionUser) {
    // RBAC: only ADMIN and ACCOUNTANT may see the full financial summary
    // (adminBalances, dropBalances, totalIncome, dropSharePercent).
    // Any other authenticated role (SENIOR / JUNIOR / HR / DROP) reaching
    // GET /api/finance/summary directly would leak payment-routing config.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Access denied: finance summary requires ADMIN or ACCOUNTANT role',
      )
    }

    // task-accountant-summary-balances-rbac (security LOW, review #215): the
    // partner/drop balance arrays expose payment-routing config (partner +
    // DROP display names alongside their accumulated balances). ACCOUNTANT
    // needs the economic P&L surface (income/expenses/salaries/net + monthly)
    // for /crm/stats + the финансовый хаб, but NOT the per-drop balances —
    // those stay ADMIN-only and the ACCOUNTANT UI still hides that panel
    // (#214 removed the drop-balances panel; #215 gates it on /crm/stats to
    // ADMIN). `canSeeDropBalances` still gates on `[]` for anyone but ADMIN.
    const canSeeDropBalances = currentUser.role === 'ADMIN'

    // task-accountant-sees-admin-balances (2026-08-17, owner decision) — THIS
    // IS A DELIBERATE REVERSAL of the #214/#215 zeroing above, NOT a
    // regression. Do not "restore" `adminBalances: []` for ACCOUNTANT without
    // re-reading this comment.
    //
    // What changed: `assertCanReadAdminBalance` (balance.service.ts) already
    // lets ACCOUNTANT read ANY admin's personal balance via
    // GET /balances/admin/:id. Until PR #551, that endpoint was structurally
    // dead for this purpose — `getAdminBalance` summed ADMIN_INCOME_CASH /
    // ADMIN_INCOME_CRYPTO, transaction types nothing in prod ever creates, so
    // it always returned 0. #551's fix C-2 corrected that computation, which
    // made the contradiction live: an ACCOUNTANT can now pull a real, non-zero
    // personal balance for any admin one-by-one through that endpoint, while
    // this summary kept zeroing the SAME field (`adminBalances`) — two screens
    // disagreeing about a decision that was already made in the endpoint's
    // favor. Flagged by security-review on #551 (SEC-3).
    //
    // Owner resolution: keep the endpoint access; stop zeroing here so the
    // summary matches it. Scope is narrow — `adminBalances` (personal admin
    // balances) ONLY. `dropBalances` is a different, still-live #214/#215
    // decision (see `canSeeDropBalances` above) and is UNCHANGED.
    //
    // "Matches it" above is about ACCESS, not VALUES — do not read this as a
    // promise that the two screens show the same NUMBER. `adminBalances`
    // below computes the HOLDING model (all received across PAYOUT_ADMIN /
    // ADMIN_INCOME / ADMIN_TRANSFER / PAYOUT_CONFIRMED, minus ALL paid sends).
    // `getAdminBalance` (balance.service.ts, untouched here) computes a
    // narrower phase-4 personal-credit slice (ADMIN_INCOME_CASH/CRYPTO +
    // DIVIDEND_TO_ADMIN, minus paid EXPENSE) — PR #551 itself calls this a
    // "materially different, broader metric" than the endpoint. #551 is still
    // open as of this comment, so if this PR ships first the two figures can
    // diverge at their widest. Reconciling the two MODELS into one number is
    // a separate, not-yet-scoped decision — this task only reconciles WHO may
    // see `adminBalances`, not what it computes.
    //
    // Deliberately a bare literal, NOT `currentUser.role === 'ADMIN' ||
    // currentUser.role === 'ACCOUNTANT'`. That re-check would be an
    // equivalent-mutant magnet: the RBAC guard at the top of this method
    // already throws ForbiddenException for every role except ADMIN and
    // ACCOUNTANT, so a re-check here can never observably differ from `true`
    // — and a `// Stryker disable next-line ConditionalExpression` comment on
    // that OR expression does not target the specific `→true` mutant, it
    // suppresses EVERY ConditionalExpression mutant Stryker generates on that
    // line: the equivalent `→true` AND the three real, killed mutants
    // (`→false` on the whole expression, and `→false` on each operand) go
    // dark together (review round 2 on this task's own PR; the same
    // line×mutator suppression scope caught 8 mutants for 2 intended ones on
    // PR #531 — see the mutation-gate backlog item). Writing the guaranteed
    // value directly removes the equivalent mutant instead of hiding it: the
    // only mutant left is `true → false` (BooleanLiteral), which IS real —
    // flipping it empties `adminBalances` for actual ADMIN/ACCOUNTANT
    // callers, which the `getSummary` unit spec already asserts against — so
    // it needs no suppression at all.
    const canSeeAdminBalances = true

    // Scaled-integer constant used throughout aggregations below to avoid
    // JS float accumulation errors. Aliased to the module-level `MONEY_SCALE`
    // single source of truth so this method and `computeDropAggregate` can
    // never drift apart on the rounding scale.
    const SCALE = MONEY_SCALE

    // Audit 2026-06-28 (#4): aggregate every money figure in a single base
    // currency (USD). Rows may carry mixed currencies (USDT/USD/EUR/UAH); summing
    // their raw `amount` strings would add apples to oranges. Fetch the NBU
    // snapshot ONCE and convert each row BEFORE the scaled-integer accumulation.
    // USD ⇄ USDT is a byte-exact identity in convertToBase (peg short-circuit),
    // so the prod USDT/USD ledger totals are unchanged to the cent.
    const rates = await this.nbuCurrency.getRates()
    const toBase = (tx: { amount: string; currency: string }): number =>
      convertToBase(parseFloat(tx.amount), tx.currency as BalanceCurrency, 'USD', rates)

    // task-soft-delete-and-money-audit (AC4): the single most consequential
    // filter in this task — every totalIncome/totalExpenses/totalSalaries/
    // adminBalances/dropBalances figure below derives from `allTxs`.
    const allTxs = (await this.db.db.query.transactions.findMany({
      where: isNull(transactions.deletedAt),
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
      },
    })) as TxWithRelations[]

    const paid = allTxs.filter((tx) => tx.status === 'PAID')

    // task-drop-share-override-and-receiver (C4). A settlement SENIOR_INCOME (the
    // row settleByCompany inserts to close a senior IOU) is a slice of money whose
    // GROSS was already counted in totalIncome — as the linked DROP_INCOME (drop
    // payout) or the admin-USDT ADMIN_INCOME. Counting the settlement slice too
    // double-counts, REGARDLESS of funding: the previous fix only excluded
    // company-funded settlements, missing the ADMIN_PERSONAL case (funding=null).
    // Discriminator: a SENIOR_INCOME whose id closes a pending_obligation. Only a
    // "real" external SENIOR_INCOME (never a settlement) counts toward income.
    const closingTxRows = await this.db.db
      .select({ id: pendingObligations.closingTransactionId })
      .from(pendingObligations)
      .where(isNotNull(pendingObligations.closingTransactionId))
    const settlementTxIds = new Set(
      closingTxRows
        .map((r) => r.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )

    // Drop role - phase 2: DROP_INCOME counts toward total income for
    // reporting purposes (gross money that came in through DROPs).
    // Scaled-integer reduce to avoid float accumulation (MED-5).
    const totalIncome =
      Math.round(
        paid
          .filter(
            (tx) =>
              tx.type === 'ADMIN_INCOME' ||
              // C4: count a SENIOR_INCOME only when it is NOT a settlement of a
              // company/admin IOU (its gross was already counted as the linked
              // DROP_INCOME / admin-USDT ADMIN_INCOME). Real external income
              // (not a closing transaction) still counts, at any funding.
              (tx.type === 'SENIOR_INCOME' && !settlementTxIds.has(tx.id)) ||
              tx.type === 'DROP_INCOME',
          )
          .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0),
      ) / SCALE

    const totalExpenses =
      Math.round(
        paid
          .filter((tx) => tx.type === 'EXPENSE')
          .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0),
      ) / SCALE

    const totalSalaries =
      Math.round(
        paid
          .filter((tx) => tx.type === 'SALARY')
          .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0),
      ) / SCALE

    // Admin balances (HOLDING model): all received − all spent.
    //   received: PAYOUT_ADMIN + ADMIN_INCOME (excl. COMPANY_ACCOUNT) +
    //             ADMIN_TRANSFER + PAYOUT_CONFIRMED (see filter below — unchanged).
    //   sent:     ALL PAID transactions where senderId = admin.id (any type:
    //             SALARY, EXPENSE, ADMIN_TRANSFER, etc.) — the full HOLDING debit.
    // Drop role - phase 3 (spec §8.4): PAYOUT_CONFIRMED — the row inserted by
    // `confirmPayout` when ACCOUNTANT/ADMIN manually confirms an off-platform
    // payout — also credits the chosen admin's balance. Phase 2 PAYOUT_ADMIN
    // (automatic 50/50 split) remains untouched and continues to count too;
    // both flows run in parallel per task scope ("Phase 2 auto-50/50 НЕ
    // ТРОГАТЬ — manual flow живёт параллельно"). Senior-only / legacy admin
    // balance values are unchanged because they never produce PAYOUT_CONFIRMED
    // rows.
    // ACCOUNTANT now sees this too (see `canSeeAdminBalances` above —
    // deliberate #214/#215 reversal, 2026-08-17). Roles that fail the RBAC
    // guard at the top of this method never reach here at all.
    //
    // No `archivedAt` filter here — EXPLICIT, not an oversight (review round
    // 2, LOW-1): `eq(users.role, 'ADMIN')` alone includes archived admins,
    // exactly as it already did before this PR for the ADMIN viewer — this
    // task widens WHO can see the array, it does not change WHAT rows are in
    // it. An archived admin can still carry a nonzero HOLDING balance the
    // company owes or holds (departure ≠ automatic zero-out/settlement), so
    // dropping the row would hide money that still needs reconciling — the
    // accountant's job. `getAdminBalance` (balance.service.ts) has no
    // archived check either, so the per-admin endpoint ACCOUNTANT already
    // used would return the same figure for an archived admin regardless.
    // If archived admins should ever be hidden from this array, that is a
    // separate, undocumented-today business decision (nothing in
    // docs/business/ addresses it) — not bundled into this task's narrow
    // scope of "who may see `adminBalances`".
    const adminBalances = !canSeeAdminBalances
      ? []
      : (
          await this.db.db.query.users.findMany({
            where: eq(users.role, 'ADMIN'),
          })
        ).map((admin) => {
          const receivedScaled = paid
            .filter(
              (tx) =>
                tx.receiverId === admin.id &&
                (tx.type === 'PAYOUT_ADMIN' ||
                  // task-salary-company-account: ADMIN_INCOME routed to the
                  // company account (fundingSource='COMPANY_ACCOUNT') went into
                  // the shared pool, NOT the admin's personal balance — exclude
                  // it here. Legacy/admin-personal ADMIN_INCOME (NULL funding)
                  // still credits the admin as before.
                  (tx.type === 'ADMIN_INCOME' && tx.fundingSource !== 'COMPANY_ACCOUNT') ||
                  tx.type === 'ADMIN_TRANSFER' ||
                  tx.type === 'PAYOUT_CONFIRMED'),
            )
            // Audit 2026-06-28 (#4): convert to base before scaling (mixed-currency
            // safe). USD/USDT → identity, so prod balances stay byte-exact.
            .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0)
          // HOLDING model: debit = ALL paid transactions sent by this admin
          // (SALARY, EXPENSE, ADMIN_TRANSFER, etc.), not only ADMIN_TRANSFER.
          const sentScaled = paid
            .filter((tx) => tx.senderId === admin.id)
            .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0)
          return {
            userId: admin.id,
            displayName: admin.displayName,
            balance: (receivedScaled - sentScaled) / SCALE,
          }
        })

    // Drop role - phase 2 (AC4): aggregate balance per DROP user — credit on
    // PAYOUT_DROP (their slice of drop-project distribution) minus any debit
    // (none today; field kept here for symmetry with adminBalances). Empty
    // array when no DROP users exist. The shape is intentionally identical
    // to adminBalances so the frontend can render both side-by-side.
    //
    // Drop role - phase 1 (task-drop-1-backend): per-drop aggregate flows
    // through the shared `computeDropAggregate` helper (single source of truth
    // also consumed by the self-only `getDropSelfSummary`). The admin summary
    // DTO is unchanged — `debtToCompany` (returned by the helper) is mapped
    // away here so `financeSummarySchema.dropBalances` and its existing unit
    // tests stay byte-for-byte identical.
    //
    // ACCOUNTANT still gets `[]` here (see `canSeeDropBalances` above — this
    // half of #214/#215 is UNCHANGED by the adminBalances reversal); ADMIN
    // keeps the full list.
    const dropBalances = !canSeeDropBalances
      ? []
      : (
          await this.db.db.query.users.findMany({
            where: eq(users.role, 'DROP'),
          })
        ).map((drop) => {
          const aggregate = this.computeDropAggregate(
            { id: drop.id, displayName: drop.displayName, dropSharePercent: drop.dropSharePercent },
            allTxs,
            rates,
          )
          return {
            userId: aggregate.userId,
            displayName: aggregate.displayName,
            balance: aggregate.balance,
            dropSharePercent: aggregate.dropSharePercent,
            pendingCount: aggregate.pendingCount,
          }
        })

    // Monthly breakdown — scaled-integer accumulation (MED-5).
    const monthMap = new Map<
      string,
      { incomeScaled: number; expensesScaled: number; salariesScaled: number }
    >()

    for (const tx of paid) {
      // Audit 2026-06-28 (#9): bucket by the business date (txDate) when present,
      // falling back to createdAt. Aligns with getIncomeComplianceOverview. Prod
      // data has txDate == createdAt so the existing totals / graph are unchanged.
      const when = tx.txDate ?? tx.createdAt
      const month = when.toISOString().slice(0, 7) // YYYY-MM
      if (!monthMap.has(month))
        monthMap.set(month, { incomeScaled: 0, expensesScaled: 0, salariesScaled: 0 })
      const entry = monthMap.get(month)!
      // Audit 2026-06-28 (#4): convert to base before scaling (mixed-currency safe).
      const amtScaled = Math.round(toBase(tx) * SCALE)

      if (
        tx.type === 'ADMIN_INCOME' ||
        // task-drop-share-override-and-receiver (C4): exclude settlement
        // SENIOR_INCOME (closing an IOU) from the monthly income series too —
        // same closing-tx discriminator as totalIncome above (regardless of
        // funding, so ADMIN_PERSONAL settlements are excluded as well).
        (tx.type === 'SENIOR_INCOME' && !settlementTxIds.has(tx.id)) ||
        tx.type === 'DROP_INCOME'
      ) {
        entry.incomeScaled += amtScaled
      } else if (tx.type === 'EXPENSE') entry.expensesScaled += amtScaled
      else if (tx.type === 'SALARY') entry.salariesScaled += amtScaled
    }

    const monthly = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([month, v]) => {
        const income = v.incomeScaled / SCALE
        const expenses = v.expensesScaled / SCALE
        const salaries = v.salariesScaled / SCALE
        return {
          month,
          income,
          expenses,
          salaries,
          profit: (v.incomeScaled - v.expensesScaled - v.salariesScaled) / SCALE,
        }
      })

    return {
      totalIncome,
      totalExpenses,
      totalSalaries,
      netBalance: totalIncome - totalExpenses - totalSalaries,
      adminBalances,
      dropBalances,
      monthly,
    }
  }

  /**
   * Accountant KPI snapshot for the финансовый хаб (Sprint 2).
   *
   * RBAC: ACCOUNTANT + ADMIN only. Every other role (SENIOR / JUNIOR / HR /
   * DROP) reaching GET /api/finance/accountant-summary directly would leak
   * company-wide payment-validation figures → ForbiddenException. Mirrors the
   * guard in `getSummary` above (single, explicit role check) and is thrown
   * BEFORE any DB access.
   *
   * Implementation: loads all transaction rows via `findMany()` and aggregates
   * the KPI buckets in-process using a single scan. UTC-based month boundaries
   * are computed once from `new Date()` so every bucket uses the same cutoff.
   *
   * KPI semantics:
   *   - pendingValidation  — income rows (SENIOR_INCOME + DROP_INCOME) still in
   *                          PENDING status, i.e. awaiting accountant action.
   *   - validatedThisMonth — rows the accountant VALIDATED in the current
   *                          calendar month (by `validatedAt`, NOT NULL).
   *   - paidThisMonth      — income/payout money settled (status PAID) whose
   *                          `createdAt` falls in the current month.
   *   - recipientCount     — distinct income parties (seniors / drops) the
   *                          accountant oversees.
   *
   * Money: `amount` is numeric(18,6); `COALESCE(SUM(amount), 0)` yields an exact
   * decimal string on the empty set → 0, mapped to a JS number with `Number`
   * (matching the previous float accumulation to the column's 6-decimal scale).
   */
  async getAccountantSummary(currentUser: SessionUser): Promise<{
    pendingValidation: { count: number; amount: number }
    validatedThisMonth: { count: number; amount: number }
    paidThisMonth: { amount: number }
    recipientCount: number
  }> {
    if (currentUser.role !== 'ACCOUNTANT' && currentUser.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Access denied: accountant summary requires ACCOUNTANT or ADMIN role',
      )
    }

    // Current-month boundary, computed once. UTC-based to match how the rest of
    // the summary buckets months (`createdAt.toISOString().slice(0,7)`).
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

    // Income types a senior / drop submits that require accountant validation —
    // the validatable-income predicate (pendingValidation + recipientCount).
    const incomeTypes = sql`${transactions.type} in ('SENIOR_INCOME', 'DROP_INCOME')`

    // Income/payout money types eligible for paidThisMonth.
    const paidEligibleTypes = sql`${transactions.type} in ('SENIOR_INCOME', 'DROP_INCOME', 'PAYOUT', 'PAYOUT_ADMIN', 'PAYOUT_DROP', 'PAYOUT_CONFIRMED')`

    // Single aggregating pass — conditional COUNT/SUM via FILTER (WHERE ...)
    // plus a distinct-party count. `COALESCE(SUM(...), 0)` guarantees 0 (not
    // NULL) on the empty set; numeric sums arrive as decimal strings → Number.
    const [row] = await this.db.db
      .select({
        pendingCount:
          sql<number>`count(*) filter (where ${transactions.status} = 'PENDING' and ${incomeTypes})`.mapWith(
            Number,
          ),
        pendingAmount:
          sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'PENDING' and ${incomeTypes}), 0)`.mapWith(
            Number,
          ),
        validatedCount:
          sql<number>`count(*) filter (where ${transactions.status} = 'VALIDATED' and ${transactions.validatedAt} is not null and ${transactions.validatedAt} >= ${monthStart})`.mapWith(
            Number,
          ),
        validatedAmount:
          sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'VALIDATED' and ${transactions.validatedAt} is not null and ${transactions.validatedAt} >= ${monthStart}), 0)`.mapWith(
            Number,
          ),
        paidAmount:
          sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'PAID' and ${paidEligibleTypes} and ${transactions.createdAt} >= ${monthStart}), 0)`.mapWith(
            Number,
          ),
        recipientCount:
          sql<number>`count(distinct coalesce(${transactions.receiverId}, ${transactions.senderId})) filter (where ${incomeTypes})`.mapWith(
            Number,
          ),
      })
      .from(transactions)
      // task-soft-delete-and-money-audit (AC4): scope the WHOLE aggregating
      // scan to non-deleted rows — every FILTER (WHERE ...) clause above runs
      // against this, so one WHERE here covers all five KPI buckets at once.
      .where(isNull(transactions.deletedAt))

    return {
      pendingValidation: {
        count: row?.pendingCount ?? 0,
        amount: row?.pendingAmount ?? 0,
      },
      validatedThisMonth: {
        count: row?.validatedCount ?? 0,
        amount: row?.validatedAmount ?? 0,
      },
      paidThisMonth: {
        amount: row?.paidAmount ?? 0,
      },
      recipientCount: row?.recipientCount ?? 0,
    }
  }

  /**
   * SENIOR dashboard KPI snapshot — STRICTLY self-scoped to `currentUser.id`.
   *
   * RBAC: SENIOR + ADMIN only (every other role → 403). The figures are ALWAYS
   * scoped to the caller's own id; there is NO `targetUserId` parameter, so a
   * senior can never request another senior's projects / income / payouts. ADMIN
   * gets access for debugging but sees their OWN id's figures (an admin owns
   * projects via `seniorId === adminId`), never an arbitrary senior's — closing
   * the data-leak surface that a `:userId` param would open.
   *
   * Content (USER selection — only this):
   *   1. activeProjects    — own active senior-projects + effective share %.
   *   2. seniorShareIncome — own senior SHARE of PAID SENIOR_INCOME (total +
   *                          this month), share = amount * sharePercent/100.
   *   3. pendingPayouts    — own PENDING payout_requests (count + Σ payable).
   *   4. mySalaryStatus    — own current-month SALARY tx (or null).
   *
   * Amounts are summed in the transaction's stored currency without cross-rate
   * conversion — consistent with getAccountantSummary / HR mySalaryStatus which
   * also report raw `amount`; the wire `currency` is the USD display label.
   */
  async getSeniorSummary(currentUser: SessionUser): Promise<SeniorSummaryDto> {
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Access denied: senior summary requires SENIOR or ADMIN role')
    }

    const selfId = currentUser.id

    // Current-month boundary (UTC), computed once — matches HR / accountant.
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    // task-senior-stats-block: PREVIOUS-month window [lastMonthStart, monthStart)
    // for `lastMonthIncome`. The current-month `YYYY-MM` key (salaryMonth) is also
    // reused as the per-company arrival bucket so the progress bar and the salary
    // lookup share one definition of "this month".
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const salaryMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

    // ── 1. Active own senior-projects + effective share % ──────────────────────
    // Self-scope at the DB level: only projects where seniorId === self AND not
    // archived. No other senior's project can ever surface here.
    const ownProjects = await this.db.db.query.projects.findMany({
      where: and(eq(projects.seniorId, selfId), isNull(projects.archivedAt)),
      orderBy: (table, { desc: d }) => [d(table.createdAt)],
    })

    // Effective share resolution reuses the canonical resolver
    // (project override → single active team override → user default). One
    // team-membership lookup serves every project (the senior's team set is the
    // same regardless of the project).
    const selfUser = await this.db.db.query.users.findFirst({ where: eq(users.id, selfId) })
    const applicableTeams = await this.findActiveTeamsForUser(selfId)
    const seniorSharePercent =
      selfUser?.seniorSharePercent ?? currentUser.seniorSharePercent ?? DEFAULT_SENIOR_SHARE_PERCENT

    const activeProjectItems = ownProjects.map((p) => {
      const resolved = resolveSeniorShare(
        { seniorSharePercentOverride: p.seniorSharePercentOverride },
        { seniorSharePercent },
        applicableTeams,
      )
      return {
        id: p.id,
        name: p.name,
        companyName: p.companyName,
        sharePercent: resolved.value,
      }
    })

    // ── 2. Senior SHARE of PAID SENIOR_INCOME (total + this month) ─────────────
    // Only PAID SENIOR_INCOME credited to self counts (same gate as
    // getTotalEarned SENIOR branch). The senior's NET share uses the snapshot
    // `seniorSharePercent` written at income-creation time (authoritative
    // historical value, NOT recomputed). A null snapshot falls back to the
    // user-level default so legacy rows still contribute.
    const paidIncomeRows = await this.db.db.query.transactions.findMany({
      where: and(
        eq(transactions.type, 'SENIOR_INCOME'),
        eq(transactions.status, 'PAID'),
        eq(transactions.receiverId, selfId),
        // task-soft-delete-and-money-audit (AC4): a deleted income row must
        // not inflate the senior's own «Статистика заработка» KPIs.
        isNull(transactions.deletedAt),
      ),
    })

    // task-senior-stats-block: derive the «Статистика заработка» figures from the
    // SAME `paidIncomeRows` (no extra query, no duplicated gate). One pass tallies:
    //   - incomeTotal / incomeThisMonth (existing KPI),
    //   - incomeLastMonth (previous calendar month),
    //   - perMonthShare (YYYY-MM → Σ share) for the sparkline history,
    //   - companiesWithIncomeThisMonth (set of own projectIds that got ≥1 PAID
    //     SENIOR_INCOME dated this month) for the arrival-progress bar.
    const monthKeyOf = (d: Date): string =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    let incomeTotal = 0
    let incomeThisMonth = 0
    let incomeLastMonth = 0
    const perMonthShare = new Map<string, number>()
    const companiesWithIncomeThisMonth = new Set<string>()
    for (const tx of paidIncomeRows) {
      const amt = parseFloat(tx.amount)
      if (!Number.isFinite(amt)) continue
      const pct = tx.seniorSharePercent ?? seniorSharePercent
      const share = amt * (pct / 100)
      incomeTotal += share
      const when = tx.txDate ?? tx.createdAt
      if (!when) continue
      const whenDate = new Date(when)
      // Per-month bucket for the sparkline (keyed by the income's own date).
      const key = monthKeyOf(whenDate)
      perMonthShare.set(key, (perMonthShare.get(key) ?? 0) + share)
      if (whenDate >= monthStart) {
        incomeThisMonth += share
        // A project counts toward arrival-progress as soon as ONE of its incomes
        // lands this month. Self-scoped: receiverId is already === self.
        if (tx.projectId) companiesWithIncomeThisMonth.add(tx.projectId)
      } else if (whenDate >= lastMonthStart) {
        incomeLastMonth += share
      }
    }

    // ── 2a. «Статистика заработка» — sparkline history + arrival progress ───────
    // monthlyHistory: a contiguous run of the LAST `HISTORY_MONTHS` calendar
    // months (oldest → newest), each carrying its summed share (0 when no income
    // that month) so the sparkline keeps a fixed length and gap-free x-axis.
    const HISTORY_MONTHS = 8
    const monthlyHistory: Array<{ month: string; amount: number }> = []
    for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      const key = monthKeyOf(d)
      monthlyHistory.push({ month: key, amount: perMonthShare.get(key) ?? 0 })
    }

    // companyIncomeProgress: total = active own projects; received = those that
    // already have ≥1 PAID SENIOR_INCOME dated this month. received ≤ total
    // because the set only contains ids drawn from this senior's own incomes,
    // intersected with the active-project id set (guards against income on a now-
    // archived project inflating `received` past `total`).
    const ownActiveProjectIds = new Set(ownProjects.map((p) => p.id))
    let companyIncomeReceived = 0
    for (const projectId of companiesWithIncomeThisMonth) {
      if (ownActiveProjectIds.has(projectId)) companyIncomeReceived += 1
    }

    // ── 3. PENDING payout_requests owed/queued by self ─────────────────────────
    // Self-scoped: payout_requests.seniorId === self. amount = Σ payableAmount of
    // the PENDING rows (what the senior still has to settle).
    const pendingRows = await this.db.db.query.payoutRequests.findMany({
      where: and(eq(payoutRequests.seniorId, selfId), eq(payoutRequests.status, 'PENDING')),
    })
    const pendingAmount = pendingRows.reduce((sum, r) => {
      const v = parseFloat(r.payableAmount)
      return Number.isFinite(v) ? sum + v : sum
    }, 0)

    // ── 4. Own current-month salary status (same shape as HR dashboard) ────────
    // task-salary-month-gap-and-status (E-6): `hasMonthlySalary` mirrors the
    // cron's own `if (!emp.monthlySalary) continue` truthiness check.
    // `isCronEligibleRole` is the SAME "does the cron process this role at
    // all" question the E-5 gap report answers (only HR/ACCOUNTANT/JUNIOR are
    // ever targeted by `createMonthlySalaries`) — security-review MED-3:
    // `getSeniorSummary` is reached ONLY by SENIOR/ADMIN (the RBAC gate
    // above), and the cron never processes either, so this is always `false`
    // here; written as a real role check (not hardcoded `false`) so the
    // shared helper stays correct if a future HR-summary re-add calls it for
    // a cron-eligible role.
    const mySalaryState = await getOwnSalaryStatus(this.db.db, selfId, salaryMonth, {
      hasMonthlySalary: Boolean(selfUser?.monthlySalary),
      isCronEligibleRole: CRON_ELIGIBLE_SALARY_ROLES.has(currentUser.role),
    })
    // DEPRECATED field — see the module comment on `mySalaryStatusSchema` in
    // @crm/shared (security-review MED-3): derived from `mySalaryState` so
    // there is exactly ONE computation, not two that could drift.
    const mySalaryStatus: MySalaryStatusDto =
      mySalaryState.state === 'EXISTS'
        ? {
            amount: mySalaryState.amount,
            currency: mySalaryState.currency,
            status: mySalaryState.status,
          }
        : null

    return {
      activeProjects: {
        count: activeProjectItems.length,
        items: activeProjectItems,
      },
      seniorShareIncome: {
        total: incomeTotal,
        thisMonth: incomeThisMonth,
        currency: 'USD',
      },
      pendingPayouts: {
        count: pendingRows.length,
        amount: pendingAmount,
      },
      mySalaryStatus,
      mySalaryState,
      // task-senior-stats-block — «Статистика заработка». No money "expected"
      // figure (USER): only the per-company arrival PROGRESS for this month.
      earningsStats: {
        lastMonthIncome: incomeLastMonth,
        monthlyHistory,
        companyIncomeProgress: {
          received: companyIncomeReceived,
          total: ownProjects.length,
        },
      },
    }
  }

  /**
   * Income compliance overview — «Контроль приходов» (task-income-compliance).
   *
   * Company-wide, NOT self-scoped: for EVERY income receiver (SENIOR + ADMIN-as-
   * senior via projects.seniorId, DROP via projects.dropId) it reports how many
   * of their active projects already have a COUNTED income this month (X) out of
   * their active project count (N), plus the list of projects WITHOUT a counted
   * income for the expand drawer. Sorted laggards-first.
   *
   * RBAC: ADMIN + ACCOUNTANT ONLY. Defense-in-depth — the controller's @Roles
   * gate runs first, and this service-side check throws 403 too (kept
   * intentionally, never replaced; same belt-and-suspenders as
   * getAccountantSummary / getSeniorSummary). Because this aggregates MANY
   * receivers' figures, it must never reach a SENIOR / JUNIOR / HR / DROP. The
   * SET of receivers is derived SOLELY from active-project ownership
   * (`seniorId`/`dropId`) — task-compliance-overview-pending-types (AC3) keeps
   * it that way: recognising more transaction TYPES as evidence never adds a
   * receiver who does not already own an active project.
   *
   * «Приход внесён по проекту» (owner decision, task-file) = ≥1 income row of the
   * receiver's income type for the project with status VALIDATED|PAID and
   * `(txDate ?? createdAt)` inside the target month (UTC). PENDING does NOT count
   * (but flags the project as `pendingValidation` for the «на валидации» badge);
   * REJECTED is ignored. ADMIN_INCOME is written PAID immediately, so an admin-as-
   * senior's projects count as soon as the income row exists.
   *
   * task-compliance-overview-pending-types (2026-08-16). The criterion above was
   * written for the self-declare model and never learned the OBLIGATION model
   * (`bookCompanyObligations`) that the current USDT admin-declare path actually
   * uses for SENIOR/DROP — see the extended comment on
   * `incomeComplianceProjectSchema` in `packages/shared` for the full owner
   * decision. Summary: a THIRD state, `accrued`, covers a company-booked
   * obligation still PENDING_PAYMENT (booked, not yet paid — counts as neither
   * `submitted` NOR `lagging`); its later settlement is picked up by the
   * EXISTING `submitted` criterion because `settleByCompany` flips the row in
   * place to a type this method already recognised as income evidence
   * (`SENIOR_INCOME` for a senior; `PAYOUT_DROP` — newly added here — for a
   * drop, since a drop's settlement does NOT reuse `DROP_INCOME`).
   *
   * security-review PR #531 round 1 (MED-1/MED-2), both fixed:
   *   - MED-1: the obligation-model types (SENIOR_PENDING_PAYOUT /
   *     DROP_PENDING_PAYOUT / PAYOUT_DROP) are looked up KEYED BY RECEIVER
   *     (`evidenceKey`, §3 below) — NOT project+type alone. Without this, a
   *     project's `dropId` (or `seniorId`) reassignment would let the NEW
   *     owner inherit the OLD owner's evidence for the rest of the month — a
   *     person who was never paid would render compliant.
   *   - MED-2: `PENDING_PAYMENT` is NOT exclusive to a booked-unpaid
   *     obligation — `createPayoutRequest` also flips an already-VALIDATED
   *     self-declare SENIOR_INCOME/DROP_INCOME row to `PENDING_PAYMENT` for
   *     the payout-request window. That is `received` (already earned), not
   *     `accrued` — see the type-aware classification in §3.
   *
   * @param month optional 'YYYY-MM' (UTC). Defaults to the current UTC month.
   */
  async getIncomeComplianceOverview(
    currentUser: SessionUser,
    month?: string,
  ): Promise<IncomeComplianceOverviewDto> {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Access denied: income compliance overview requires ADMIN or ACCOUNTANT role',
      )
    }

    // ── Resolve the target month window [monthStart, nextMonthStart) in UTC ────
    // Consistent with getAccountantSummary / getSeniorSummary (all UTC). When a
    // `month` is given it is already validated as YYYY-MM by the controller's Zod
    // schema; default = current UTC month.
    const now = new Date()
    let year: number
    let monthIdx: number // 0-based
    if (month) {
      const [y, m] = month.split('-').map(Number) as [number, number]
      year = y
      monthIdx = m - 1
    } else {
      year = now.getUTCFullYear()
      monthIdx = now.getUTCMonth()
    }
    const monthStart = new Date(Date.UTC(year, monthIdx, 1))
    const nextMonthStart = new Date(Date.UTC(year, monthIdx + 1, 1))
    const targetMonthKey = `${year}-${String(monthIdx + 1).padStart(2, '0')}`

    // ── 1. All active (non-archived) income-bearing projects, with owners ──────
    // One pass: a project contributes to its SENIOR owner (always) AND to its
    // DROP owner (when dropId is set). The owner's role decides the income type
    // we look for (SENIOR_INCOME vs ADMIN_INCOME vs DROP_INCOME).
    const activeProjects = await this.db.db.query.projects.findMany({
      where: isNull(projects.archivedAt),
      columns: { id: true, name: true, companyName: true, seniorId: true, dropId: true },
    })

    if (activeProjects.length === 0) {
      return {
        month: targetMonthKey,
        totals: {
          expectedProjects: 0,
          submittedProjects: 0,
          laggingReceivers: 0,
          completeReceivers: 0,
          pendingProjects: 0,
          accruedProjects: 0,
        },
        receivers: [],
      }
    }

    // ── 2. Resolve the role of every owner referenced by an active project ─────
    const ownerIds = Array.from(
      new Set(
        activeProjects.flatMap((p) => [p.seniorId, p.dropId].filter((id): id is string => !!id)),
      ),
    )
    const ownerRows = await this.db.db.query.users.findMany({
      where: inArray(users.id, ownerIds),
      columns: { id: true, displayName: true, role: true },
    })
    const ownerById = new Map(ownerRows.map((u) => [u.id, u]))

    // ── 3. Evidence rows for the month, per (projectId, type[, receiverId]) ────
    // A single aggregating pass over every type of row that can constitute
    // evidence a receiver's income was accounted for. Three kinds, per
    // task-compliance-overview-pending-types:
    //   - self-declared income (SENIOR_INCOME / ADMIN_INCOME / DROP_INCOME):
    //     VALIDATED|PAID → received; PENDING → pendingValidation (awaiting the
    //     accountant). PENDING_PAYMENT is ALSO reachable here — see the
    //     type-aware classification below, NOT a generic one.
    //   - a company-booked OBLIGATION not yet paid (SENIOR_PENDING_PAYOUT /
    //     DROP_PENDING_PAYOUT, status PENDING_PAYMENT) → accrued (awaiting the
    //     COMPANY's payout — nothing for the receiver to do).
    //   - a SETTLED drop obligation (PAYOUT_DROP, status PAID) → received. A
    //     settled SENIOR obligation needs NO extra type here — `settleByCompany`
    //     flips it in place to SENIOR_INCOME/PAID, already covered above.
    // The dataset is tiny (units of projects) so JS grouping is cheap and keeps
    // the existing service-spec mock surface (query.transactions.findMany) intact.
    const projectIds = activeProjects.map((p) => p.id)
    const incomeRows = await this.db.db.query.transactions.findMany({
      where: and(
        inArray(transactions.type, [
          'SENIOR_INCOME',
          'ADMIN_INCOME',
          'DROP_INCOME',
          'SENIOR_PENDING_PAYOUT',
          'DROP_PENDING_PAYOUT',
          'PAYOUT_DROP',
        ]),
        inArray(transactions.status, ['VALIDATED', 'PAID', 'PENDING', 'PENDING_PAYMENT']),
        inArray(transactions.projectId, projectIds),
        // task-soft-delete-and-money-audit (AC4): a deleted (e.g. fraudulent)
        // income must not count toward a project's «сдал приход в этом месяце»
        // compliance badge.
        isNull(transactions.deletedAt),
      ),
      columns: {
        type: true,
        status: true,
        projectId: true,
        // security-review PR #531 (MED-1): the three obligation-model types
        // below need `receiverId` for keying — see `RECEIVER_SCOPED_TYPES`.
        receiverId: true,
        txDate: true,
        createdAt: true,
      },
    })

    // security-review PR #531 (MED-1). `bookCompanyObligations` documents
    // `receiverId` as a hard invariant on every SENIOR_PENDING_PAYOUT /
    // DROP_PENDING_PAYOUT / PAYOUT_DROP row (always the actual person the
    // company owes/paid), and every OTHER consumer of these rows keys by it
    // (`computeDropAggregate`, `balance.service.ts:327`). This widget must
    // too: without it, the evidence key is `${projectId}|${type}` ALONE, so
    // reassigning a project's `dropId` mid-month makes the NEW drop silently
    // inherit the OLD drop's obligation evidence — a person who was never
    // paid would render compliant. Self-declare types (SENIOR_INCOME /
    // ADMIN_INCOME / DROP_INCOME) are deliberately NOT in this set — their
    // existing project-level (not receiver-level) semantics predate this task
    // and are unchanged (e.g. an admin-as-senior's ADMIN_INCOME can legally be
    // routed to a different admin's receiverId — COMPANY_ACCOUNT pooling in
    // `declareUsdtProjectIncome` — without that being non-compliance).
    const RECEIVER_SCOPED_TYPES = new Set([
      'SENIOR_PENDING_PAYOUT',
      'DROP_PENDING_PAYOUT',
      'PAYOUT_DROP',
    ])
    // The subset of RECEIVER_SCOPED_TYPES whose PENDING_PAYMENT status means
    // "booked, unpaid obligation" (accrued) — see the type-aware status
    // classification below (MED-2).
    const OBLIGATION_TYPES = new Set(['SENIOR_PENDING_PAYOUT', 'DROP_PENDING_PAYOUT'])
    const evidenceKey = (projectId: string, type: string, receiverId: string | null): string =>
      RECEIVER_SCOPED_TYPES.has(type)
        ? `${projectId}|${type}|${receiverId}`
        : `${projectId}|${type}`

    // key = evidenceKey(...) → per-state flags for the target month.
    const incomeByKey = new Map<
      string,
      { received: boolean; pendingValidation: boolean; accrued: boolean }
    >()
    for (const tx of incomeRows) {
      if (!tx.projectId) continue
      const when = tx.txDate ?? tx.createdAt
      if (!when) continue
      const whenDate = new Date(when)
      if (whenDate < monthStart || whenDate >= nextMonthStart) continue
      const key = evidenceKey(tx.projectId, tx.type, tx.receiverId)
      // Stryker disable next-line ObjectLiteral: a PROVABLY equivalent mutant, not an untested one — every field on this fallback is IMMEDIATELY either read as falsy (identical to `{}`'s `undefined`, since every read below is a truthy check: `if (entry.received)`) or overwritten by one of the three branches directly below, so `{}` and `{received:false,pendingValidation:false,accrued:false}` are indistinguishable to any observer of this function's output — see income-compliance.unit.spec.ts's DB-level type/status scope suite for the mutants on THIS line's neighbours that ARE observable.
      const entry = incomeByKey.get(key) ?? {
        received: false,
        pendingValidation: false,
        accrued: false,
      }
      if (tx.status === 'VALIDATED' || tx.status === 'PAID') entry.received = true
      else if (tx.status === 'PENDING') entry.pendingValidation = true
      else if (tx.status === 'PENDING_PAYMENT') {
        // security-review PR #531 (MED-2): PENDING_PAYMENT is NOT exclusive to
        // a booked-unpaid obligation. `createPayoutRequest`
        // (transactions.service.ts, ~L3941-3944) ALSO flips an already-
        // VALIDATED self-declare SENIOR_INCOME/DROP_INCOME row to
        // PENDING_PAYMENT for the entire payout-request window (until
        // `payPayoutRequest` flips it PAID). That income was already earned
        // and validated — it is `received`, not a company debt the receiver
        // is waiting on; labelling it "Начислено · ожидает выплаты" would
        // misattribute the wait to the wrong party (the payout mechanics, not
        // an ADMIN-booked IOU). Only the two TRUE obligation types — booked by
        // `bookCompanyObligations`, which never emits a VALIDATED status —
        // mean `accrued`.
        if (OBLIGATION_TYPES.has(tx.type)) entry.accrued = true
        else entry.received = true
      }
      incomeByKey.set(key, entry)
    }

    // Every transaction type that can constitute evidence for a given owner
    // role, in priority order (received > accrued > pendingValidation — see the
    // step-5 reduction below). ADMIN never gets an obligation type:
    // `bookCompanyObligations` explicitly skips an ADMIN owner (admin income is
    // always direct, never proxied through a company IOU).
    const incomeTypesFor = (role: string): readonly string[] | null =>
      role === 'SENIOR'
        ? (['SENIOR_INCOME', 'SENIOR_PENDING_PAYOUT'] as const)
        : role === 'ADMIN'
          ? (['ADMIN_INCOME'] as const)
          : role === 'DROP'
            ? (['DROP_INCOME', 'DROP_PENDING_PAYOUT', 'PAYOUT_DROP'] as const)
            : null
    const complianceRoleFor = (role: string): IncomeComplianceRole | null =>
      role === 'SENIOR'
        ? 'SENIOR'
        : role === 'ADMIN'
          ? 'ADMIN_SENIOR'
          : role === 'DROP'
            ? 'DROP'
            : null

    // ── 4. Group projects by receiver (owner). A project belongs to its SENIOR
    // owner (via seniorId, role SENIOR or ADMIN) AND, if dropId set, to the DROP
    // owner. Each (receiver, project) pair is evaluated against every one of the
    // receiver's own income evidence types. ────────────────────────────────────
    type Acc = {
      userId: string
      displayName: string
      role: IncomeComplianceRole
      incomeTypes: readonly string[]
      projects: Array<{ projectId: string; name: string; companyName: string }>
    }
    const byReceiver = new Map<string, Acc>()
    const addPair = (ownerId: string | null, p: (typeof activeProjects)[number]): void => {
      if (!ownerId) return
      const owner = ownerById.get(ownerId)
      if (!owner) return
      const complianceRole = complianceRoleFor(owner.role)
      const incomeTypes = incomeTypesFor(owner.role)
      // Stryker disable next-line LogicalOperator: a PROVABLY equivalent mutant (`||` → `&&`), not an untested one — `complianceRoleFor` and `incomeTypesFor` branch on the IDENTICAL three-way role check (SENIOR/ADMIN/DROP → non-null, everything else → null), so for every possible `owner.role` string `!complianceRole` and `!incomeTypes` are ALWAYS the same boolean — `A || A` and `A && A` both reduce to `A`. See the "non-receiver role (JUNIOR)" test right below for the mutant on THIS line that IS observable (the whole condition forced to a constant).
      if (!complianceRole || !incomeTypes) return // ignore non-receiver roles defensively
      let acc = byReceiver.get(ownerId)
      if (!acc) {
        acc = {
          userId: ownerId,
          displayName: owner.displayName,
          role: complianceRole,
          incomeTypes,
          projects: [],
        }
        byReceiver.set(ownerId, acc)
      }
      acc.projects.push({ projectId: p.id, name: p.name, companyName: p.companyName })
    }
    for (const p of activeProjects) {
      addPair(p.seniorId, p)
      if (p.dropId) addPair(p.dropId, p)
    }

    // ── 5. Build the receiver DTOs + company totals ────────────────────────────
    let expectedProjects = 0
    let submittedProjects = 0
    let laggingReceivers = 0
    let completeReceivers = 0
    let pendingProjects = 0
    let accruedProjects = 0

    const receivers: IncomeComplianceReceiverDto[] = []
    for (const acc of byReceiver.values()) {
      const missingProjects: IncomeComplianceReceiverDto['missingProjects'] = []
      let submitted = 0
      let pendingCount = 0
      let accruedCount = 0
      for (const proj of acc.projects) {
        // Merge evidence across every type this receiver can carry (e.g. a
        // DROP checks DROP_INCOME AND DROP_PENDING_PAYOUT AND PAYOUT_DROP for
        // the SAME project) — `received` wins over `accrued` wins over
        // `pendingValidation`: real, confirmed money outranks an unpaid
        // obligation, which in turn outranks a merely self-declared, unverified
        // claim.
        let received = false
        let pendingValidation = false
        let accrued = false
        for (const type of acc.incomeTypes) {
          // security-review PR #531 (MED-1): looked up with the SAME
          // receiver-aware key the aggregation pass wrote — see `evidenceKey`
          // above. `acc.userId` is the CURRENT owner of `proj` (this receiver),
          // so a stale row left behind by a PREVIOUS owner (project
          // reassignment) never matches here.
          const entry = incomeByKey.get(evidenceKey(proj.projectId, type, acc.userId))
          if (!entry) continue
          if (entry.received) received = true
          if (entry.pendingValidation) pendingValidation = true
          if (entry.accrued) accrued = true
        }
        if (received) {
          submitted += 1
        } else if (accrued) {
          accruedCount += 1
          missingProjects.push({
            projectId: proj.projectId,
            name: proj.name,
            companyName: proj.companyName,
            submitted: false,
            pendingValidation: false,
            accrued: true,
          })
        } else {
          const pendingOnly = pendingValidation
          if (pendingOnly) pendingCount += 1
          missingProjects.push({
            projectId: proj.projectId,
            name: proj.name,
            companyName: proj.companyName,
            submitted: false,
            pendingValidation: pendingOnly,
            accrued: false,
          })
        }
      }
      const expected = acc.projects.length
      expectedProjects += expected
      submittedProjects += submitted
      pendingProjects += pendingCount
      accruedProjects += accruedCount
      if (submitted >= expected) completeReceivers += 1
      else laggingReceivers += 1

      receivers.push({
        userId: acc.userId,
        displayName: acc.displayName,
        role: acc.role,
        expected,
        submitted,
        pendingCount,
        accruedCount,
        missingProjects,
      })
    }

    // Sort laggards-first: lowest coverage ratio on top; ties → fewer submitted
    // first, then displayName for stable ordering.
    receivers.sort((a, b) => {
      const ra = a.expected > 0 ? a.submitted / a.expected : 1
      const rb = b.expected > 0 ? b.submitted / b.expected : 1
      if (ra !== rb) return ra - rb
      if (a.submitted !== b.submitted) return a.submitted - b.submitted
      return a.displayName.localeCompare(b.displayName, 'en')
    })

    return {
      month: targetMonthKey,
      totals: {
        expectedProjects,
        submittedProjects,
        laggingReceivers,
        completeReceivers,
        pendingProjects,
        accruedProjects,
      },
      receivers,
    }
  }

  // ── Project Finance Settings ──────────────────────────────────────────────

  async getProjectFinanceSettings(projectId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const settings = await this.db.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })
    return settings ?? null
  }

  async upsertProjectFinanceSettings(
    projectId: string,
    data: {
      seniorSharePercentOverride?: number | null | undefined
      juniorSalaryOverride?: number | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })
    if (!project) throw new NotFoundException('Project not found')

    const fsValues = {
      seniorSharePercentOverride: data.seniorSharePercentOverride ?? null,
      juniorSalaryOverride:
        data.juniorSalaryOverride !== undefined && data.juniorSalaryOverride !== null
          ? String(data.juniorSalaryOverride)
          : null,
      updatedBy: currentUser.id,
      updatedAt: new Date(),
    }

    // BIZ-22: upsertProjectFinanceSettings must be the SINGLE SOURCE OF TRUTH
    // for the senior-share override. Before this fix it only wrote to
    // project_finance_settings, but createSeniorIncome reads
    // projects.senior_share_percent_override (via the hierarchy resolver).
    // Resolution: wrap both writes in one transaction — project_finance_settings
    // and projects.senior_share_percent_override are always in sync after this call.
    //
    // Design choice: mirror the write into projects (same strategy as
    // ProjectsService.syncFinanceSettingsOverride) rather than changing the
    // resolver read-path — keeps the hierarchy resolver pure and avoids a JOIN.
    await this.db.db.transaction(async (tx) => {
      const existing = await tx.query.projectFinanceSettings.findFirst({
        where: eq(projectFinanceSettings.projectId, projectId),
      })

      if (existing) {
        await tx
          .update(projectFinanceSettings)
          .set(fsValues)
          .where(eq(projectFinanceSettings.projectId, projectId))
      } else {
        await tx.insert(projectFinanceSettings).values({ projectId, ...fsValues })
      }

      // Mirror seniorSharePercentOverride into projects so the resolver
      // (which reads projects.senior_share_percent_override) picks it up.
      // juniorSalaryOverride lives ONLY in project_finance_settings (used by
      // salary cron) and does NOT exist on the projects table — no mirror needed.
      if (data.seniorSharePercentOverride !== undefined) {
        await tx
          .update(projects)
          .set({ seniorSharePercentOverride: data.seniorSharePercentOverride ?? null })
          .where(eq(projects.id, projectId))
      }
    })

    return this.getProjectFinanceSettings(projectId, currentUser)
  }

  // ── Pay salary manually ───────────────────────────────────────────────────

  /**
   * Refuse to pay a salary whose receiver has been dismissed.
   *
   * task-finance-fix-wave1 (E-1). Used in THREE places inside `paySalary`: as
   * the up-front gate (so the operator gets this message, not a generic one),
   * and after each of the two write paths reports zero affected rows — where it
   * turns "nothing was written" into the actual reason.
   *
   * Deliberately keyed on the row's OWN `receiverId`: `receiverId` is nullable
   * on `transactions` (label-only counterparties exist for other types), a row
   * with no receiver has no archival to check, and a null id must never reach
   * the query.
   *
   * `db` is the executor to read through, and it is a REQUIRED parameter rather
   * than a default of `this.db.db` (round 3, LOW): one of the callers runs inside
   * `db.transaction()`, and reaching for `this.db.db` there would check out a
   * SECOND pooled connection while the first is still held by the transaction.
   * On a saturated pool that is not a failure, it is a wait for a connection
   * that only frees when the transaction it is nested in finishes — which is
   * waiting on itself. Making the parameter explicit means a caller has to name
   * its executor, so the nesting cannot reappear by omission.
   */
  private async assertSalaryReceiverNotArchived(
    db: DatabaseService['db'] | DrizzleTx,
    receiverId: string | null,
  ): Promise<void> {
    if (!receiverId) return
    const receiver = await db.query.users.findFirst({ where: eq(users.id, receiverId) })
    if (receiver && receiver.archivedAt) {
      throw new BadRequestException('Получатель зарплаты архивирован — выплата невозможна')
    }
  }

  /**
   * The same refusal as `assertSalaryReceiverNotArchived`, expressed as a
   * predicate that lives INSIDE the write statement.
   *
   * security-review round 2 (MED-3): the up-front gate alone is a TOCTOU
   * window — the receiver is read before the transaction opens, and an archive
   * committing in between would let the salary go out to a dismissed employee.
   * That window is not microscopic: between the pre-read and the write sit the
   * receipt validation, the amount checks, opening the transaction and WAITING
   * on the company-account advisory lock (i.e. possibly behind another payment).
   * This file already answered the same argument once — PR #456 (MED-1) refused
   * to trust a pre-read for `deleted_at` and moved the condition into the write.
   * Same move here, and it fails CLOSED.
   *
   * WHAT THIS DOES AND DOES NOT GUARANTEE (round 3 — the earlier wording claimed
   * "no instant between check and write", which is half a step stronger than the
   * mechanics, and this PR is the wrong place to leave an absolute that is
   * subtly false). The correlated sub-query reads `users` under the statement's
   * own snapshot; Postgres's re-check-on-lock (EvalPlanQual) applies to the
   * LOCKED row — the `transactions` row — not to `users`. So an archive that
   * commits DURING this UPDATE is not seen by the sub-query. The window
   * therefore shrinks from "several awaits plus a lock wait" to "the duration of
   * one statement", which is the real gain; it does not become zero.
   *
   * Why no row lock on the receiver. `FOR KEY SHARE` — the obvious candidate —
   * does NOT help: measured on Postgres 15, a holder taking `FOR KEY SHARE` on
   * the users row does not block `UPDATE users SET archived_at = now()`, because
   * that UPDATE touches no key column and so takes FOR NO KEY UPDATE, which
   * `FOR KEY SHARE` does not conflict with. `FOR SHARE` and `FOR UPDATE` do
   * block it (also measured). We deliberately take neither:
   *   - it would only cover this path. The ADMIN_PERSONAL flip below runs in NO
   *     transaction by design (nothing to serialise — the company balance is not
   *     touched), and its write already IS a single statement; adding a lock
   *     there means wrapping it in a transaction and changing that contract.
   *   - `FOR SHARE` on a `users` row makes paying a salary serialise against
   *     every ordinary write to that person's row — a display-name edit, an
   *     avatar, a salary-figure change — for as long as this transaction holds,
   *     advisory-lock wait included.
   *   - the residual exposure is qualitatively unlike the bug being fixed:
   *     settling an accrual that already existed before the dismissal (a row an
   *     ADMIN can soft-delete), versus the original defect, which minted a FRESH
   *     accrual every month and left it silently payable forever.
   * The durable fix belongs at the other end — voiding PENDING salaries when a
   * user is archived, in `UsersService.archive`. That is a different zone and a
   * separate task (backlog 88 follow-up), deliberately not smuggled in here.
   *
   * `NOT EXISTS (SELECT id FROM users WHERE users.id = transactions.receiver_id
   * AND users.archived_at IS NOT NULL)` — note this is TRUE when the receiver
   * row is missing entirely, which matches the up-front gate (an absent user is
   * not an archived one) instead of silently blocking the payment.
   *
   * Built with Drizzle's client-less `QueryBuilder`, NOT `this.db.db.select`:
   * this method only assembles SQL (the enclosing UPDATE is what executes it),
   * so it has no business needing a connection. The first version did go through
   * `this.db.db`, and the cost showed up immediately — every existing unit spec
   * that reaches `paySalary` suddenly had to stub `select` or die with
   * `this.db.db.select is not a function` (transactions.finance-audit.spec.ts
   * did, caught by the pre-push suite). A predicate builder that radiates stub
   * requirements into unrelated specs is the wrong shape.
   */
  private salaryReceiverNotArchivedFilter() {
    return notExists(
      new QueryBuilder()
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, transactions.receiverId), isNotNull(users.archivedAt))),
    )
  }

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
    if (!tx) throw new NotFoundException('Transaction not found')
    assertTransactionWritable(tx, currentUser)
    if (tx.type !== 'SALARY') throw new BadRequestException('Can only pay SALARY transactions')
    if (tx.status !== 'PENDING') throw new BadRequestException('Transaction is not PENDING')

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
    await this.assertSalaryReceiverNotArchived(this.db.db, tx.receiverId)

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
    if (receiptErr) throw new BadRequestException(receiptErr)
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    // Resolve sender + currency from the pay-time funding choice. The AMOUNT is
    // never converted — only the currency LABEL changes.
    let senderId: string | null
    let senderLabel: string
    let currency: 'USDT' | 'USD' | 'EUR' | 'UAH'

    if (isCompanyFunded) {
      // COMPANY_ACCOUNT: money leaves the shared company USDT account. Force USDT
      // (USDT-only account), no personal sender, labelled «Счёт компании».
      currency = 'USDT'
      senderId = null
      senderLabel = 'Счёт компании'
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
        throw new BadRequestException('Личный счёт-плательщик зарплаты должен принадлежать ADMIN')
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
    if (paySalarySelfPayErr) throw new BadRequestException(paySalarySelfPayErr)

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
      if (amountError) throw new BadRequestException(amountError)
    }
    const paidAmount = paidAmountProvided ? data.paidAmount! : obligationAmount
    // Effective applied rate = paid / original (units of the paid currency per 1
    // unit of the original one). Derived, never client-supplied — see the column
    // comment in schema.ts. NULL when the obligation amount is unusable as a
    // divisor (should not happen: amounts are positive by schema).
    const rawExchangeRate =
      Number.isFinite(obligationAmount) && obligationAmount > 0
        ? paidAmount / obligationAmount
        : null
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
    const exchangeRate =
      rawExchangeRate !== null && isStorableExchangeRate(rawExchangeRate)
        ? rawExchangeRate.toFixed(8)
        : null

    // task-salary-pay-flow: stamp txDate = pay date (now). The salary was created
    // (PENDING) on an earlier date, but the business-time of the actual payment
    // is when an ADMIN pays it. The funding source / currency / sender are
    // finalized on the row HERE.
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
      txDate: new Date(),
      updatedAt: new Date(),
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
          throw new BadRequestException('Transaction is not PENDING')
        }
        const companyBalance = await this.computeCompanyAccountBalance(dbtx)
        if (companyBalance < amount) {
          throw new BadRequestException('Недостаточно средств на счёте компании')
        }
        const updated = await dbtx
          .update(transactions)
          .set(paidSet)
          .where(
            and(
              eq(transactions.id, id),
              isNull(transactions.deletedAt),
              // MED-3: archival re-asserted in the write, not only pre-read.
              this.salaryReceiverNotArchivedFilter(),
            ),
          )
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          // Zero rows now has two possible causes (a racing delete/pay, or a
          // racing archive). Name the real one instead of guessing. Read through
          // `dbtx` — the transaction still owns a connection here, and going via
          // `this.db.db` would check out a second one (round 3, LOW).
          await this.assertSalaryReceiverNotArchived(dbtx, tx.receiverId)
          throw new BadRequestException('Transaction is not PENDING')
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
            // MED-3: same in-write archival re-assertion as the company path.
            this.salaryReceiverNotArchivedFilter(),
          ),
        )
        .returning({ id: transactions.id })
      if (flipped.length !== 1) {
        // A concurrent paySalary already flipped this row — or a concurrent
        // archive of the receiver made the guard above reject it. This path runs
        // in no transaction, so the base connection is correct here.
        await this.assertSalaryReceiverNotArchived(this.db.db, tx.receiverId)
        throw new BadRequestException('Transaction is not PENDING')
      }
    }

    // Trigger 2: invoice auto-create for SALARY → PAID transitions. Run AFTER the
    // debit transaction commits (best-effort; must not hold the lock). Reached
    // only when THIS call performed the flip (the ADMIN_PERSONAL guard above and
    // the company-account status re-check both throw on a lost race).
    await this.safeAutoCreateInvoice('SALARY', id)

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

    return this.findOne(id, currentUser)
  }

  // ── Cron helpers ──────────────────────────────────────────────────────────

  // task-salary-month-gap-and-status (E-5): the two resolvers below are the
  // ONLY definition of "who does the monthly cron accrue a SALARY to, and how
  // much". Extracted (2026-08) out of `createMonthlySalaries` itself so the
  // gap report / backfill (`resolveSalaryMonthGap`, further down) share the
  // EXACT SAME query — not a hand-duplicated read that could silently drift
  // from what the cron actually does. Read-only; the insert + idempotency
  // (unique index + ON CONFLICT DO NOTHING) stays in `createMonthlySalaries`,
  // the only writer.

  /**
   * HR / ACCOUNTANT eligible for this month's salary — unconditional on
   * `monthlySalary` being set, same as the cron always was.
   *
   * task-finance-fix-wave1 (E-1): the `archivedAt` term is NOT decoration —
   * without it a DISMISSED employee kept being paid. `UsersService.archive`
   * does exactly one thing for these two roles beyond stamping `archivedAt`:
   * it sets `leftAt` on their `team_members` rows. It does NOT zero
   * `monthlySalary` and does NOT change the role — so a role-only SELECT went
   * on matching them forever, the `if (!emp.monthlySalary) continue` guard
   * below waved them through, and the partial unique index only dedupes
   * WITHIN one month, so every following month produced a fresh PENDING
   * salary. Those rows are not hidden anywhere in the UI either: paying one
   * was an ordinary ADMIN click on the finance page.
   *
   * The filter belongs in the QUERY, not in the loop below: the loop's only
   * guard is about a MISSING salary figure, and a reader adding the next
   * condition there would have no reason to suspect archival is handled
   * elsewhere. (The JUNIOR resolver needs no equivalent QUERY term — it
   * selects through `projectMembers` with `isNull(projectMembers.leftAt)`,
   * and archiving a junior sets that `leftAt`. See that resolver's comment.)
   */
  private async resolveHrAccountantSalaryReceivers(): Promise<
    Array<{
      id: string
      email: string
      displayName: string
      role: 'HR' | 'ACCOUNTANT'
      monthlySalary: string
    }>
  > {
    const employees = await this.db.db.query.users.findMany({
      where: and(or(eq(users.role, 'HR'), eq(users.role, 'ACCOUNTANT')), isNull(users.archivedAt)),
    })

    const receivers: Array<{
      id: string
      email: string
      displayName: string
      role: 'HR' | 'ACCOUNTANT'
      monthlySalary: string
    }> = []
    for (const emp of employees) {
      if (!emp.monthlySalary) continue
      receivers.push({
        id: emp.id,
        email: emp.email,
        displayName: emp.displayName,
        role: emp.role as 'HR' | 'ACCOUNTANT',
        monthlySalary: emp.monthlySalary,
      })
    }
    return receivers
  }

  /**
   * JUNIORs on an active project membership — salary = project override ??
   * user default.
   *
   * task-salary-company-account: the LOCKED-until-validated-income mechanic is
   * GONE — juniors always get a PENDING salary regardless of whether the
   * project's senior/drop income has been validated yet. (The
   * unlockJuniorSalaryForProject method + its callers were removed.)
   *
   * task-finance-fix-wave1 (E-1), round-2 correction (MED-1). The first
   * version of this fix left the JUNIOR branch alone, reasoning that
   * archiving a junior sets `leftAt` on their memberships and
   * `isNull(projectMembers.leftAt)` below therefore excludes them. A reviewer
   * showed that holds only AT THE MOMENT of archiving: `ProjectsService`
   * re-opens a membership (`leftAt = null`) when someone is added to a
   * project, without consulting `archivedAt` — so an archived junior can be
   * re-attached and start collecting monthly salaries again. `leftAt` tracks
   * PROJECT membership; `archivedAt` tracks EMPLOYMENT. They are not
   * interchangeable, and the salary decision belongs to the second one.
   *
   * The archival term sits in the LOOP here, not in the query as it does for
   * HR/ACCOUNTANT, for a mechanical reason: this query selects
   * `project_members` and reaches the person through a `with: { user }`
   * relation, and Drizzle's relational API cannot filter parent rows by a
   * related table's column. The loop below is already where every USER-level
   * condition is applied (`user.role !== 'JUNIOR'`), so the check is next to
   * its siblings rather than in a place a reader would not look.
   *
   * Not fixed here (deliberately, different zone + PR #541, since merged): the
   * re-attach itself in `ProjectsService.addMember`. Tracked separately.
   */
  private async resolveJuniorSalaryReceivers(): Promise<
    Array<{
      id: string
      email: string
      displayName: string
      monthlySalary: string
      projectId: string
      projectName: string
    }>
  > {
    const activeMembers = await this.db.db.query.projectMembers.findMany({
      where: isNull(projectMembers.leftAt),
      with: {
        user: true,
        project: { with: { financeSettings: true } },
      },
    })

    const receivers: Array<{
      id: string
      email: string
      displayName: string
      monthlySalary: string
      projectId: string
      projectName: string
    }> = []
    // security-review MED-2: a junior on MULTIPLE active projects used to
    // push ONE receiver entry PER MEMBERSHIP, each carrying the FULL resolved
    // amount — harmless for `createMonthlySalaries`'s actual INSERT loop
    // (the unique index + ON CONFLICT DO NOTHING already lets only the FIRST
    // attempt for a given receiver+month succeed, so the real DB state was
    // never double-booked), but the E-5 gap report SUMS `expectedAmount`
    // across every entry it is handed — a junior on 2 projects inflated the
    // reported total by their FULL salary a second time (measured on real
    // data: +21%). Track which receivers already have an entry and skip
    // their later memberships — preserving the SAME "first membership in
    // iteration order wins" semantics the DB constraint already enforces for
    // actual inserts, so this list and what the cron would actually WRITE
    // agree on both WHO and HOW MUCH.
    const seenReceiverIds = new Set<string>()
    for (const member of activeMembers) {
      const user = (member as typeof member & { user: typeof users.$inferSelect | null }).user
      const project = (
        member as typeof member & {
          project:
            | (typeof projects.$inferSelect & {
                financeSettings: typeof projectFinanceSettings.$inferSelect | null
              })
            | null
        }
      ).project

      // `user.archivedAt` — see the method comment: a dismissed junior whose
      // membership was re-opened must not be accrued a new salary.
      if (!user || user.role !== 'JUNIOR' || user.archivedAt || !project) continue
      if (seenReceiverIds.has(user.id)) continue

      // Resolve salary: project override → user default
      const salaryAmount = project.financeSettings?.juniorSalaryOverride ?? user.monthlySalary
      if (!salaryAmount) continue

      seenReceiverIds.add(user.id)
      receivers.push({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        monthlySalary: String(salaryAmount),
        projectId: project.id,
        projectName: project.name,
      })
    }
    return receivers
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
    const hrAccountantReceivers = await this.resolveHrAccountantSalaryReceivers()

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

    const hrAccountantFailures: string[] = []
    for (const emp of hrAccountantReceivers) {
      // task-salary-pay-flow: monthly salaries are NEUTRAL PENDING reminders —
      // no funding source, no currency lock, no balance impact at creation. The
      // funding source (company account vs admin personal) and the actual
      // payment currency are chosen at pay time (paySalary). `monthlySalary` is
      // the USD nominal of the reminder.
      //
      // Audit 2026-06-27 (LOW #5): the previous find-then-insert "skip if exists"
      // had a TOCTOU gap — a concurrent / re-run cron could insert a duplicate
      // salary for the same (receiver, month). The DB is now the single source of
      // truth: INSERT … ON CONFLICT DO NOTHING against the partial unique index
      // `uq_transactions_salary_receiver_month` (WHERE type='SALARY' AND
      // salary_month IS NOT NULL). A duplicate is silently ignored — idempotent,
      // race-free, no read round-trip per employee (also kills the N+1).
      //
      // MED-1: per-employee try/catch — a DB error on one employee (e.g. transient
      // lock or network issue) must NOT abort the loop; remaining employees still
      // get their salary reminder. Failures are collected and logged after the loop
      // so the cron does not silently skip employees.
      try {
        const inserted = await this.db.db
          .insert(transactions)
          .values({
            type: 'SALARY',
            status: 'PENDING',
            amount: emp.monthlySalary,
            currency: 'USD',
            senderId: null,
            senderLabel: 'CheekyCheeseIT',
            receiverId: emp.id,
            salaryMonth: month,
            fundingSource: null,
            createdBy: actorId,
          })
          .onConflictDoNothing({
            target: [transactions.receiverId, transactions.salaryMonth],
            // `where` (NOT targetWhere) — drizzle-orm 0.36 onConflictDoNothing emits
            // this as the conflict-target predicate, matching the partial index's
            // WHERE. Must match `uq_transactions_salary_receiver_month` exactly.
            where: sql`${transactions.type} = 'SALARY' AND ${transactions.salaryMonth} IS NOT NULL`,
          })
          // security-review HIGH-1: RETURNING is empty when ON CONFLICT DO
          // NOTHING actually did nothing — the only way to tell "this call
          // really created a row" from "it already existed" for the audit
          // entry below.
          .returning({ id: transactions.id })
        if (actor && inserted[0]) {
          await this.recordCreationAudit(
            inserted[0].id,
            { type: 'SALARY', amount: emp.monthlySalary, currency: 'USD' },
            actor,
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
    const juniorReceivers = await this.resolveJuniorSalaryReceivers()

    const juniorFailures: string[] = []
    for (const jr of juniorReceivers) {
      // Audit 2026-06-27 (LOW #5): idempotent, race-free salary creation — see the
      // HR/ACCOUNTANT loop above. ON CONFLICT DO NOTHING against the partial
      // unique index replaces the find-then-insert TOCTOU + N+1 read.
      //
      // MED-1: per-member try/catch — see HR/ACCOUNTANT loop above for rationale.
      try {
        const inserted = await this.db.db
          .insert(transactions)
          .values({
            type: 'SALARY',
            status: 'PENDING',
            amount: jr.monthlySalary,
            currency: 'USD',
            senderId: null,
            senderLabel: 'CheekyCheeseIT',
            receiverId: jr.id,
            projectId: jr.projectId,
            salaryMonth: month,
            fundingSource: null,
            createdBy: actorId,
          })
          .onConflictDoNothing({
            target: [transactions.receiverId, transactions.salaryMonth],
            // `where` (NOT targetWhere) — drizzle-orm 0.36 onConflictDoNothing emits
            // this as the conflict-target predicate, matching the partial index's
            // WHERE. Must match `uq_transactions_salary_receiver_month` exactly.
            where: sql`${transactions.type} = 'SALARY' AND ${transactions.salaryMonth} IS NOT NULL`,
          })
          .returning({ id: transactions.id })
        if (actor && inserted[0]) {
          await this.recordCreationAudit(
            inserted[0].id,
            { type: 'SALARY', amount: jr.monthlySalary, currency: 'USD' },
            actor,
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
   * task-salary-month-gap-and-status (E-5) — «who was the cron supposed to
   * accrue this month, and didn't». Pure read: resolves the SAME two
   * populations `createMonthlySalaries` targets (see the resolvers above),
   * then subtracts whoever already has a non-deleted SALARY row for `month`.
   * No RBAC here — both public callers below gate first, this is shared,
   * unauthenticated-by-itself plumbing.
   */
  private async resolveSalaryMonthGap(month: string): Promise<SalaryMonthGapReportDto> {
    const [hrAccountant, juniors] = await Promise.all([
      this.resolveHrAccountantSalaryReceivers(),
      this.resolveJuniorSalaryReceivers(),
    ])

    const expected: SalaryMonthGapReceiverDto[] = [
      ...hrAccountant.map((r) => ({
        userId: r.id,
        displayName: r.displayName,
        role: r.role,
        expectedAmount: Number(r.monthlySalary),
        projectId: null,
        projectName: null,
      })),
      ...juniors.map((r) => ({
        userId: r.id,
        displayName: r.displayName,
        role: 'JUNIOR' as const,
        expectedAmount: Number(r.monthlySalary),
        projectId: r.projectId,
        projectName: r.projectName,
      })),
    ]

    if (expected.length === 0) return { month, missing: [] }

    // security-review MED-1: the partial unique index
    // `uq_transactions_salary_receiver_month` has NO `deleted_at IS NULL`
    // term (see the migration's own comment — deliberate, not an oversight
    // elsewhere) — so a SOFT-DELETED SALARY row still occupies the
    // (receiver_id, salary_month) slot: `ON CONFLICT DO NOTHING` blocks a
    // fresh insert for that person even though the row is invisible
    // everywhere else. Checking existence through `nonDeletedTransactions`
    // ALONE would report that person as "missing" forever, and clicking
    // Backfill would silently do nothing (`INSERT 0 0`) forever — reproduced
    // against real Postgres. Deliberately reading the RAW `transactions`
    // table here, not the view: this is an ADMIN/ACCOUNTANT-only EXISTENCE
    // check (does ANY row occupy this slot), never surfacing a deleted row's
    // content to the caller — matches the view doc's own carve-out for
    // privileged single-row reads. Anyone with ANY row (deleted or not) for
    // this receiver+month is excluded from `missing`: the report never
    // advertises a backfill it cannot actually perform. (A separate,
    // legitimate question — "an ADMIN should be told a SALARY was voided" —
    // is already served by the existing `includeDeleted` toggle on the
    // ordinary transactions list; not this report's job.)
    const receiverIds = expected.map((r) => r.userId)
    const existingRows = await this.db.db
      .select({ receiverId: transactions.receiverId })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.salaryMonth, month),
          inArray(transactions.receiverId, receiverIds),
        ),
      )
    const existingReceiverIds = new Set(existingRows.map((r) => r.receiverId))

    return {
      month,
      missing: expected.filter((r) => !existingReceiverIds.has(r.userId)),
    }
  }

  /** GET /api/finance/salary-month-gap — ADMIN + ACCOUNTANT only. */
  async getSalaryMonthGapReport(
    currentUser: SessionUser,
    month?: string,
  ): Promise<SalaryMonthGapReportDto> {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Access denied: salary month gap report requires ADMIN or ACCOUNTANT role',
      )
    }
    // security-review HIGH-2: default to the PREVIOUS calendar month — the
    // one `createMonthlySalaries` last targeted — NOT the current month
    // (which the cron never touches; see salary-month.util.ts). Shares the
    // EXACT resolver `SalaryCronService` uses so the two can never drift.
    const targetMonth = month ?? previousSalaryMonthKey()
    return this.resolveSalaryMonthGap(targetMonth)
  }

  /**
   * POST /api/finance/salary-month-backfill — ADMIN only. Dozapolnenie: closes
   * this month's gap for whoever `resolveSalaryMonthGap` (== the cron's own
   * eligibility) says is missing, by re-invoking `createMonthlySalaries` for
   * the EXACT SAME month — no separate insert logic, so the idempotency
   * guarantee (unique index + ON CONFLICT DO NOTHING) is inherited verbatim,
   * not re-implemented. Returns the POST-backfill gap so the caller sees
   * immediately whether anything is still missing (e.g. a per-employee DB
   * error the cron's own try/catch already logged).
   */
  async backfillSalaryMonth(
    currentUser: SessionUser,
    month: string,
  ): Promise<SalaryMonthGapReportDto> {
    if (currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Access denied: salary month backfill requires ADMIN role')
    }
    // security-review HIGH-1: pass the REAL actor — see createMonthlySalaries's
    // docblock for why this differs from the cron's unaudited "any admin" call.
    await this.createMonthlySalaries(month, currentUser)
    return this.resolveSalaryMonthGap(month)
  }

  // ── Access guard ──────────────────────────────────────────────────────────

  private assertReadAccess(tx: TxWithRelations, currentUser: SessionUser) {
    if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return
    if (currentUser.role === 'SENIOR') {
      // Drop role - phase 3: PAYOUT_CONFIRMED matches PAYOUT_ADMIN — admin
      // attribution rows are never visible to SENIOR via findOne either.
      if (
        (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
        tx.type !== 'PAYOUT_ADMIN' &&
        tx.type !== 'PAYOUT_CONFIRMED'
      )
        return
      throw new ForbiddenException()
    }
    if (currentUser.role === 'JUNIOR') {
      if (tx.receiverId === currentUser.id) return
      throw new ForbiddenException()
    }
    if (currentUser.role === 'HR') {
      if (tx.receiverId === currentUser.id || tx.senderId === currentUser.id) return
      throw new ForbiddenException()
    }
    // Drop role - phase 1 (AC1, security): same shape as SENIOR — own
    // sender/receiver rows only, no PAYOUT_ADMIN. In Phase 1 the row set is
    // typically empty; explicit clause keeps the contract crisp.
    if (currentUser.role === 'DROP') {
      if (
        (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
        tx.type !== 'PAYOUT_ADMIN' &&
        tx.type !== 'PAYOUT_CONFIRMED'
      )
        return
      throw new ForbiddenException()
    }
    throw new ForbiddenException()
  }

  /**
   * task-soft-delete-and-money-audit (AC5): "создание" — every primary
   * user-facing creation entry point (createAdminIncome / createSeniorIncome
   * / createDropIncome / createExpense / createSalary / createAdminTransfer)
   * calls this right after its `.insert(transactions)...returning()`.
   * Best-effort (mirrors AuditInterceptor's convention): a logging hiccup
   * must never turn a successful money-record creation into a 500 — the
   * primary insert has already committed by the time this runs.
   *
   * Deliberately NOT wired into every INTERNAL cascade insert (obligation
   * placeholders booked by `bookCompanyObligations`, the monthly salary cron,
   * drop-payout cascade rows) — those are system-derived side-effects of an
   * already-audited primary action, not a second independent "creation" a
   * human decided to make.
   */
  private async recordCreationAudit(
    txId: string,
    created: { type: string; amount: string; currency: string },
    currentUser: SessionUser,
  ): Promise<void> {
    try {
      await this.db.db.insert(transactionAuditLog).values({
        actorId: currentUser.impersonatorId ?? currentUser.id,
        targetId: txId,
        action: 'CREATE',
        metadata: {
          type: created.type,
          amount: created.amount,
          currency: created.currency,
        },
      })
    } catch (auditErr) {
      this.logger.error(
        `recordCreationAudit: failed to persist audit record for transaction=${txId}: ${(auditErr as Error).message}`,
        (auditErr as Error).stack,
      )
    }
  }
}
