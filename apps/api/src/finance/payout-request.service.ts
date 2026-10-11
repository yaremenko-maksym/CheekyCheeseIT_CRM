import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { payoutRequests, transactions, users } from '../database/schema'
import { DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'
import { DEFAULT_SENIOR_SHARE_PERCENT } from './drop-distribution.util'
import { NbuCurrencyService } from './nbu-currency.service'
import { PayoutRequestReadService } from './payout-request-read.service'
import { resolveTransactionDate } from './transaction-date.util'
import { convertToUsdtMinor } from './usdt-conversion.util'

/**
 * Payout-request creation: bundles a SENIOR's / DROP's own VALIDATED incomes
 * into one payout to the company wallet (NBU-converted to USDT, atomic
 * row lock, placeholder PAYOUT row). Depends on the database, the NBU rate
 * feed and the payout read path; never on TransactionsService.
 */
@Injectable()
export class PayoutRequestService {
  constructor(
    private readonly db: DatabaseService,
    private readonly payoutRead: PayoutRequestReadService,
    private readonly nbuCurrency: NbuCurrencyService,
  ) {}

  async createPayoutRequest(
    transactionIds: string[],
    currentUser: SessionUser,
    txDate?: string | null,
  ) {
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
        throw apiError('FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE', HttpStatus.BAD_REQUEST)
      }

      // A payout may be backdated, but it cannot predate any income it settles.
      // Compare calendar-day keys only: txDate is a business DATE, while the
      // source rows carry timestamps. For a batch, the latest source date is
      // therefore the inclusive lower bound for the payout date.
      const latestSourceDate = lockedRows
        .map((tx) => (tx.txDate ?? tx.createdAt).toISOString().slice(0, 10))
        .sort()
        .pop()
      // Missing custom date means "do not enforce a lower bound". Use a
      // lexicographically-high sentinel so the comparison remains one simple,
      // mutation-testable expression without nullable branches.
      const comparablePayoutDate = txDate ?? String.fromCharCode(0xffff)
      const comparableLatestSourceDate = latestSourceDate ?? comparablePayoutDate
      if (comparablePayoutDate < comparableLatestSourceDate) {
        throw apiError('FINANCE_PAYOUT_DATE_BEFORE_INCOME', HttpStatus.BAD_REQUEST)
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
          throw apiError('FINANCE_PAYOUT_SINGLE_PROJECT_ONLY', HttpStatus.BAD_REQUEST)
        }
      }

      // ── Phase 8 v2 — recipient = the COMPANY USDT wallet.
      // The single company_account row holds the wallet. If it is not
      // configured the senior has nowhere to send funds → reject the batch.
      const account = await dbtx.query.companyAccount.findFirst()
      if (!account?.walletAddress) {
        throw apiError('FINANCE_COMPANY_WALLET_NOT_CONFIGURED', HttpStatus.BAD_REQUEST)
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
        throw apiError('FINANCE_NBU_RATE_UNAVAILABLE', HttpStatus.BAD_REQUEST)
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
        incomeUsdtMinor += convertToUsdtMinor(amountMinor, tx.currency, rates)
        payableUsdtMinor += convertToUsdtMinor(companyShareMinor, tx.currency, rates)
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
        // Persist the operator-selected business date on the ledger row.
        // Omitting txDate stays backward-compatible at the API boundary and
        // resolves to "now", matching the old createdAt-based business day.
        txDate: resolveTransactionDate(txDate),
        createdBy: currentUser.id,
      })

      // Return only the id from inside the transaction. The detail read
      // (findPayoutRequest) MUST run on the base connection AFTER commit — it
      // uses this.db.db (a separate pooled client) which cannot see this
      // transaction's uncommitted rows, so reading it here would 404.
      return req!.id
    })

    return this.payoutRead.findPayoutRequest(newRequestId, currentUser)
  }
}
