import { randomBytes } from 'crypto'
import { ForbiddenException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { and, eq, isNull, ne, or } from 'drizzle-orm'
import type { ManualPayoutMethod, SessionUser } from '@crm/shared'
import { extractOnChainTxHash } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { payoutRequests, transactionAuditLog, transactions } from '../database/schema'
import { uniqueViolationConstraint } from '../database/pg-errors'
import { COMPANY_ACCOUNT_FUNDING_SOURCE } from './company-account-balance'
import { EtherscanService } from './etherscan.service'
import {
  consumeTxHash,
  findConsumedTxHash,
  minorUnitsFromString,
  normalizeEthAddress,
  usdtToMinorUnits,
} from './onchain-tx'
import { OnChainClaimService } from './onchain-claim.service'
import { PayoutRequestReadService } from './payout-request-read.service'
import { applyDropProjectPayout } from './payout-settlement-drop.util'
import { formatTransactionBusinessDate, resolveTransactionDate } from './transaction-date.util'
import { TransactionLifecycleService } from './transaction-lifecycle.service'

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

/**
 * Payout settlement: the money cascade that flips a PENDING payout request to
 * PAID (on-chain `payPayoutRequest`, off-chain `manualConfirmPayout`) and
 * books the obligations, drop-share routing, company-account credit and audit
 * rows in one claim-first transaction. Depends on the database, the payout
 * read path, the on-chain claim registry, the transaction lifecycle and the
 * Etherscan verifier; never on TransactionsService.
 */
@Injectable()
export class PayoutSettlementService {
  private readonly logger = new Logger(PayoutSettlementService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly payoutRead: PayoutRequestReadService,
    private readonly onChainClaim: OnChainClaimService,
    private readonly lifecycle: TransactionLifecycleService,
    private readonly etherscan: EtherscanService,
  ) {}

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
    txDate?: string | null,
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
    if (!req) throw apiError('FINANCE_PAYOUT_REQUEST_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (req.seniorId !== currentUser.id) throw new ForbiddenException()
    if (req.status !== 'PENDING')
      throw apiError('FINANCE_PAYOUT_REQUEST_ALREADY_PAID', HttpStatus.BAD_REQUEST)

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
      throw apiError('FINANCE_SIMULATION_TX_NOT_CONFIRMED', HttpStatus.BAD_REQUEST)
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
      throw apiError('FINANCE_TX_HASH_INVALID', HttpStatus.BAD_REQUEST)
    }
    const effectiveTxHash =
      extractedTxHash ??
      (isSimulating
        ? `0xSIM${randomBytes(28).toString('hex')}`
        : (() => {
            throw apiError('FINANCE_TX_HASH_REQUIRED', HttpStatus.BAD_REQUEST)
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
        throw apiError('FINANCE_COMPANY_WALLET_NOT_CONFIGURED', HttpStatus.BAD_REQUEST)
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
        throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
      }
      // Legacy guard kept as-is: rows settled BEFORE the registry existed are
      // backfilled by the migration, but this costs one indexed read and keeps
      // the check meaningful even if a backfill was skipped.
      const reused = await this.db.db.query.payoutRequests.findFirst({
        where: and(eq(payoutRequests.txHash, effectiveTxHash), eq(payoutRequests.status, 'PAID')),
      })
      if (reused) {
        throw apiError('FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT', HttpStatus.BAD_REQUEST)
      }

      const verification = await this.etherscan.verifyDeposit(
        effectiveTxHash,
        account.walletAddress,
        account.confirmationThreshold,
      )
      if (!verification.toMatches) {
        throw apiError('FINANCE_TX_RECIPIENT_MISMATCH_COMPANY_WALLET', HttpStatus.BAD_REQUEST)
      }
      if (!verification.confirmed) {
        throw apiError('FINANCE_TX_NOT_CONFIRMED_ONCHAIN', HttpStatus.BAD_REQUEST)
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
      if ((payableMinor ?? 0n) <= 0n || onChainMinor !== payableMinor) {
        throw apiError('FINANCE_ONCHAIN_AMOUNT_MISMATCH', HttpStatus.BAD_REQUEST)
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
      txDate,
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
    options: { note?: string | null; txHash?: string | null; txDate?: string | null } = {},
  ) {
    // RBAC: ADMIN/ACCOUNTANT only (NOT SENIOR/DROP). Real 403 enforced here AND
    // by the controller RolesGuard (defense-in-depth).
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const req = await this.db.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    if (!req) throw apiError('FINANCE_PAYOUT_REQUEST_NOT_FOUND', HttpStatus.NOT_FOUND)
    // Idempotency: only a still-PENDING payout can be confirmed; a second
    // confirmation throws (the cascade already ran, balance already moved).
    if (req.status !== 'PENDING') {
      throw apiError('FINANCE_PAYOUT_REQUEST_ALREADY_PAID', HttpStatus.BAD_REQUEST)
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
      throw apiError('FINANCE_TX_HASH_INVALID', HttpStatus.BAD_REQUEST)
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
        throw apiError('FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT', HttpStatus.BAD_REQUEST)
      }
    }
    // HOLE 2 fast-fail: a real hash already spent by ANY path (incl. a company
    // DEPOSIT, which the payout-table scan above cannot see). Applies to EVERY
    // method — even a non-crediting ADMIN_USDT/CASH confirmation must not
    // re-use a transfer that already settled something else. Authoritative
    // claim happens inside `applyPayoutPaidCascade`. `findConsumedTxHash`
    // re-normalizes the hash and returns null without touching the database for
    // a synthetic 0xMANUAL marker, so the lookup is unconditional.
    const consumed = await findConsumedTxHash(this.db.db, effectiveTxHash)
    if (consumed) {
      throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
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
      null,
      options.txDate,
    )
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
    txDate?: string | null,
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
          throw apiError('FINANCE_PAYOUT_REQUEST_ALREADY_PAID', HttpStatus.BAD_REQUEST)
        }

        // The payment date may be backdated, but never before the PAYOUT row
        // being settled. Validate inside the same transaction as the status
        // claim so no concurrent edit can make the decision stale.
        //
        // SR-809-M-3 = CR-809-L-3: this lookup runs ONLY when a date was actually
        // supplied. Its whole purpose is to find the lower bound, so with no date
        // there is nothing to bound — and #809's unconditional throw made every
        // payout request without a PAYOUT row (legacy data, a half-failed create)
        // permanently unpayable, including through `manualConfirmPayout`, which
        // IS the ADMIN/ACCOUNTANT recovery path. `isNull(deletedAt)` stops a
        // soft-deleted row from governing the bound of a live payment.
        let payoutSourceTxDate: Date | null = null
        if (txDate) {
          const [payoutSource] = await dbtx
            .select({
              id: transactions.id,
              txDate: transactions.txDate,
              createdAt: transactions.createdAt,
            })
            .from(transactions)
            .where(
              and(
                eq(transactions.payoutRequestId, requestId),
                eq(transactions.type, 'PAYOUT'),
                isNull(transactions.deletedAt),
              ),
            )
            .limit(1)
          if (!payoutSource) {
            throw apiError(
              'FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST',
              HttpStatus.BAD_REQUEST,
            )
          }
          payoutSourceTxDate = payoutSource.txDate
          const sourceDate = (payoutSource.txDate ?? payoutSource.createdAt)
            .toISOString()
            .slice(0, 10)
          if (txDate < sourceDate) {
            throw apiError('FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION', HttpStatus.BAD_REQUEST)
          }
        }
        const paymentTxDate = txDate ? resolveTransactionDate(txDate) : undefined

        // SR-809-L-3: the audit trail used to carry the NEW date only, while the
        // PAYOUT row's own date is overwritten at pay time — so the override was
        // not reconstructable from the trail. Record both ends of it. `null` means
        // "the row carried no business date before", which is different from
        // "no override happened" (then neither key is written at all).
        const dateOverrideAudit =
          paymentTxDate === undefined
            ? {}
            : {
                txDateBefore: payoutSourceTxDate
                  ? formatTransactionBusinessDate(payoutSourceTxDate)
                  : null,
                txDateAfter: formatTransactionBusinessDate(paymentTxDate),
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
            throw apiError('FINANCE_TX_HASH_USED_FOR_OTHER_PAYOUT', HttpStatus.BAD_REQUEST)
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
        // The claim is NOT gated on "credits the balance": a manual
        // ADMIN_USDT / CASH confirmation leaves `fundingSource` null and never
        // touches the company balance, yet it DID spend a real transfer, which
        // must therefore not also be claimable as a deposit. The gate is the
        // hash itself: `consumeTxHash` re-normalizes it and returns without
        // touching the database when it is not a real on-chain hash, so the
        // call is unconditional (see `settlementConsumesTransfer` for why the
        // three paths differ).
        const claim = await consumeTxHash(dbtx, {
          txHash: effectiveTxHash,
          purpose: 'PAYOUT',
          referenceId: requestId,
          consumedByUserId: currentUser.id,
        })
        if (claim.reclaimedAfterRelease) {
          await this.onChainClaim.recordReclaimAfterRelease(dbtx, {
            path: 'applyPayoutPaidCascade',
            txHash: effectiveTxHash,
            referenceId: requestId,
            actorId: currentUser.impersonatorId ?? currentUser.id,
          })
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
            ...(paymentTxDate ? { txDate: paymentTxDate } : {}),
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
              ...(paymentTxDate ? { txDate: paymentTxDate } : {}),
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
            throw apiError(
              'FINANCE_PAYOUT_TRANSACTION_NOT_FOUND_FOR_REQUEST',
              HttpStatus.BAD_REQUEST,
            )
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
            ...(txDate ? { txDate } : {}),
            ...dateOverrideAudit,
          },
        })

        // Drop role - phase 2 (AC3): drop-project routing + pending IOUs
        // (senior + drop) — extracted to payout-settlement-drop.util.ts. Runs in
        // THIS transaction (`dbtx`); senior-projects write nothing here.
        await applyDropProjectPayout(
          dbtx,
          this.db.db,
          req,
          paidIncomeTxs,
          currentUser,
          requestId,
          paymentTxDate,
        )

        // Stryker disable next-line OptionalChaining: equivalent — payoutRow is assigned on every path that reaches this line (payoutUpdated[0] after a length check, or existing[0] after a length check that throws), so it is never undefined.
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
          throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
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
      await this.lifecycle.safeAutoCreateInvoice('PAYOUT', payoutRowId)
    }

    return this.payoutRead.findPayoutRequest(requestId, currentUser)
  }
}
