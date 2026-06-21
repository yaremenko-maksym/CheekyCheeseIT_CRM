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

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
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
} from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID, SALARY_ELIGIBLE_ROLES } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  pendingObligations,
  projectFinanceSettings,
  projectMembers,
  payoutRequests,
  projects,
  teamMembers,
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { InvoicesService } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { NbuCurrencyService } from './nbu-currency.service'
import { EtherscanService } from './etherscan.service'
import { resolveSeniorShare } from './senior-share-resolver'
import { getOwnSalaryStatus } from './salary-status.helper'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'

// Phase 8 v2 — payout → company wallet. Marker persisted in
// transactions.fundingSource on a PAYOUT row whose money landed on the company
// USDT account (on-chain confirm OR manual COMPANY_ACCOUNT). company-account
// computeBalance counts ONLY these PAYOUT rows, so ADMIN_USDT/CASH manual
// confirmations (which leave fundingSource NULL) never inflate the balance.
const PAYOUT_TO_COMPANY_ACCOUNT = 'COMPANY_ACCOUNT'
// M4 — Tolerance for the on-chain amount vs. the recorded payableAmount.
//
// WHY 1%: the company-share `payableAmount` is computed and frozen at
// createPayoutRequest time using THAT day's NBU rate (cross-currency incomes →
// USDT). The senior's actual on-chain transfer happens later, at a slightly
// different effective rate, minus gas/rounding. The 1% band absorbs this drift
// so an honest payout is not rejected over a few cents.
//
// SYMMETRY (двусторонний): the check uses `Math.abs(onChain - payable)`, so it
// covers BOTH an on-chain UNDERPAYMENT (senior sent ~1% less) and an
// OVERPAYMENT (sent ~1% more) within the band — both are accepted as PAID.
//
// WHAT WE CREDIT: regardless of the exact on-chain figure (as long as it is
// within the band), the company account is credited the FROZEN `payableAmount`
// — the contractual company-share obligation, NOT the on-chain number. This is
// deliberate: it keeps the ledger deterministic (the PAYOUT row amount == what
// every report already shows) and prevents a malformed/manipulated on-chain
// `value` from setting the credited figure. Outside the band → NOT PAID.
const PAYOUT_AMOUNT_TOLERANCE = 0.01

/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * True when `err` (or any error in its `.cause` chain) is a Postgres
 * unique-constraint violation (SQLSTATE 23505). drizzle-orm wraps query
 * failures in a `DrizzleQueryError`, so the original pg error — the one
 * carrying `.code` — lives on `.cause`; this walks the chain rather than only
 * inspecting the top-level error. Used by the NEW-M1 txHash-reuse backstop in
 * `applyPayoutPaidCascade` to turn an index collision into a clean BadRequest.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err
  // Bounded walk — guards against a (pathological) self-referential cause chain.
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    if ((cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/** Default drop-share percentage when `users.dropSharePercent` is NULL.
 *  Used in both `computeDropDistribution` (write-path) and `getSummary`
 *  (read-path display). Single source of truth — never duplicate the literal 5.
 */
export const DEFAULT_DROP_SHARE_PERCENT = 5

/**
 * Default senior share percent when no per-user override is set (DB default 26).
 * Single source of truth — used in computeDropDistribution, getSeniorSummary,
 * and getSummary to avoid scattering the literal `26` across the service.
 */
export const DEFAULT_SENIOR_SHARE_PERCENT = 26

/**
 * Scaled-integer constant used throughout money aggregations to avoid JS
 * float accumulation errors (same scale as the write-path in confirmPayout /
 * payPayoutRequest: 1e6, round to int). Single source of truth so the
 * per-drop aggregate helper and `getSummary` agree.
 */
export const MONEY_SCALE = 1_000_000

type TxWithRelations = Transaction & {
  sender: { displayName: string } | null
  receiver: { displayName: string } | null
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
  private async assertReceiptDocumentBindable(
    docId: string,
    currentUser: SessionUser,
    opts: { expectedOwnerId?: string } = {},
  ): Promise<void> {
    const doc = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, docId),
    })

    if (!doc) throw new NotFoundException('Receipt document not found')
    if (doc.category !== 'RECEIPT') {
      throw new BadRequestException('Document must be a RECEIPT to be attached to a transaction')
    }

    // Ownership check:
    //  - Non-ADMIN callers must own the document themselves.
    //  - ADMIN callers may bind a RECEIPT owned by a specific other user
    //    (the transaction receiver).  If expectedOwnerId is not provided for an
    //    ADMIN call we fall back to self-ownership.
    const expectedOwner = opts.expectedOwnerId ?? currentUser.id
    if (doc.ownerId !== expectedOwner) {
      throw new ForbiddenException('You do not have permission to attach this receipt document')
    }
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

  private mapTx(tx: TxWithRelations) {
    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      senderId: tx.senderId,
      senderLabel: tx.senderLabel,
      senderName: tx.sender?.displayName ?? null,
      receiverId: tx.receiverId,
      receiverLabel: tx.receiverLabel,
      receiverName: tx.receiver?.displayName ?? null,
      projectId: tx.projectId,
      projectName: tx.project?.name ?? null,
      payoutRequestId: tx.payoutRequestId,
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
      validatedBy: tx.validatedBy,
      validatedAt: tx.validatedAt ? tx.validatedAt.toISOString() : null,
      rejectionReason: tx.rejectionReason,
      notes: tx.notes,
      salaryMonth: tx.salaryMonth,
      txDate: tx.txDate ? tx.txDate.toISOString() : null,
      // Drop role - phase 2. Optional explicit recipient — populated on
      // PAYOUT_DROP today; null on every legacy row. Exposing on the DTO so
      // the frontend list/detail views can distinguish drop payouts cleanly.
      recipientId: (tx as Transaction & { recipientId?: string | null }).recipientId ?? null,
      createdBy: tx.createdBy,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
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
  // branches on `project.dropId` and calls `computeDropDistribution`, while
  // the senior-project flow keeps calling `computePartnersSplit` directly.
  // Senior path math is byte-for-byte identical to pre-phase-2 behavior:
  // `computePartnersSplit(payable)` returns `[{ MAKSYM_ID, payable/2 }, …]`
  // which is what the legacy inline loop produced.

  /**
   * Split a payable amount 50/50 between the two hard-coded admin partners
   * (Maksym + Kostya). Used by:
   *   - senior-project `payPayoutRequest` (pre-phase-2 path, unchanged result)
   *   - `computeDropDistribution` for the residual after senior + drop cuts
   *
   * Returns an array (length=2) so callers can iterate without caring about
   * the admin identities — keeps the test surface small and future-proofs
   * for an N-partner split if the model ever changes.
   */
  computePartnersSplit(payableAmount: number): { adminId: string; amount: number }[] {
    const half = payableAmount / 2
    return [
      { adminId: MAKSYM_ID, amount: half },
      { adminId: KOSTYA_ID, amount: half },
    ]
  }

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
    partnerShares: { adminId: string; amount: number }[]
  } {
    const seniorPercent = senior.seniorSharePercent ?? DEFAULT_SENIOR_SHARE_PERCENT
    const dropPercent = drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT

    if (seniorPercent + dropPercent > 100) {
      throw new BadRequestException('Sum of senior+drop shares exceeds 100%')
    }

    const seniorAmount = (income * seniorPercent) / 100
    const dropAmount = (income * dropPercent) / 100
    const remainder = income - seniorAmount - dropAmount

    return {
      seniorShare: { amount: seniorAmount, percent: seniorPercent },
      dropShare: { amount: dropAmount, percent: dropPercent },
      partnerShares: this.computePartnersSplit(remainder),
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
   * NEW field (additive, only consumed by the drop self-summary; the admin
   * summary maps it away so its DTO/tests are unaffected):
   *   - `debtToCompany`       — what the drop still owes the company for
   *                             VALIDATED-but-unsettled incomes.
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
   */
  private computeDropAggregate(
    drop: { id: string; displayName: string; dropSharePercent: number | null },
    allTxs: Array<{
      type: string
      status: string
      amount: string
      senderId: string | null
      receiverId: string | null
    }>,
  ): {
    userId: string
    displayName: string
    balance: number
    dropSharePercent: number
    pendingCount: number
    debtToCompany: number
  } {
    const paid = allTxs.filter((tx) => tx.status === 'PAID')

    const receivedScaled = paid
      .filter((tx) => tx.receiverId === drop.id && tx.type === 'PAYOUT_DROP')
      .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * MONEY_SCALE), 0)
    const sentScaled = paid
      .filter((tx) => tx.senderId === drop.id && tx.type === 'PAYOUT_DROP')
      .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * MONEY_SCALE), 0)

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
      .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * MONEY_SCALE), 0)

    return {
      userId: drop.id,
      displayName: drop.displayName,
      balance: (receivedScaled - sentScaled) / MONEY_SCALE,
      dropSharePercent: drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT,
      pendingCount,
      debtToCompany: debtScaled / MONEY_SCALE,
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
  }> {
    if (currentUser.role !== 'DROP') {
      throw new ForbiddenException('Access denied: drop summary is available to DROP role only')
    }

    const self = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!self) throw new NotFoundException('Drop user not found')

    const allTxs = (await this.db.db.query.transactions.findMany()) as Array<{
      type: string
      status: string
      amount: string
      senderId: string | null
      receiverId: string | null
    }>

    const aggregate = this.computeDropAggregate(
      { id: self.id, displayName: self.displayName, dropSharePercent: self.dropSharePercent },
      allTxs,
    )

    return {
      balance: aggregate.balance,
      dropSharePercent: aggregate.dropSharePercent,
      pendingIncomesCount: aggregate.pendingCount,
      debtToCompany: aggregate.debtToCompany,
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
   * scoped to `receiverId = self.id AND type = 'DROP_INCOME'` at the DB level,
   * so no other drop's income can leak. Supports status / date-window filters
   * and offset pagination; `total` is the count BEFORE the page slice.
   *
   * `companyName` is sourced from the income's `senderLabel` (set to
   * `project.companyName` at creation — see `createDropIncome`), falling back
   * to the linked project's companyName, then '' if neither is present.
   */
  async getDropSelfIncomes(
    currentUser: SessionUser,
    query: DropIncomesQuery,
  ): Promise<PaginatedDropIncomes> {
    if (currentUser.role !== 'DROP') {
      throw new ForbiddenException('Access denied: drop incomes are available to DROP role only')
    }

    // Self-scope at the DB level: only this drop's DROP_INCOME rows.
    const rows = await this.db.db.query.transactions.findMany({
      where: and(eq(transactions.type, 'DROP_INCOME'), eq(transactions.receiverId, currentUser.id)),
      orderBy: [desc(transactions.createdAt)],
      with: { project: { columns: { companyName: true } } },
    })

    // In-memory status + date-window filters (the feed per drop is small;
    // pushing these to SQL would not change correctness and keeps the status
    // mapping in one place). The status filter compares the MAPPED status so
    // the FE contract (pending|validated|paid|rejected) is honoured.
    const fromTs = query.from ? Date.parse(query.from) : undefined
    // `to` is a YYYY-MM-DD date string: Date.parse gives midnight UTC (start of
    // that day). Add 86_399_999 ms (= 23:59:59.999) so that incomes created
    // anywhere during the last requested day are included — not just those at
    // exactly 00:00:00 UTC. Fix: MED review finding code-review-2.
    const toTs = query.to ? Date.parse(query.to) + 86_399_999 : undefined

    const filtered = rows.filter((tx) => {
      if (query.status && this.mapDropIncomeStatus(tx.status) !== query.status) return false
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
      companyName: tx.senderLabel ?? tx.project?.companyName ?? '',
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      createdAt:
        tx.createdAt instanceof Date
          ? tx.createdAt.toISOString()
          : new Date(tx.createdAt).toISOString(),
      status: this.mapDropIncomeStatus(tx.status),
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
    },
  ) {
    const allTxs = (await this.db.db.query.transactions.findMany({
      orderBy: [desc(transactions.createdAt)],
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
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

    return result.map((tx) => this.mapTx(tx))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const tx = (await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
        payoutRequest: {
          columns: { seniorId: true, incomeAmount: true, payableAmount: true },
        },
      },
    })) as TxWithRelations | undefined

    if (!tx) throw new NotFoundException('Transaction not found')
    this.assertReadAccess(tx, currentUser)

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

    return this.mapTx(tx)
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
      // task-salary-company-account: optional company-account routing. When
      // COMPANY_ACCOUNT the income is directed INTO the shared company USDT pool
      // (credits its balance, USDT-forced) and is EXCLUDED from the admin owner's
      // personal balance (getSummary). Absent → legacy (credits the admin owner).
      fundingSource?: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL' | undefined
    },
    currentUser: SessionUser,
  ) {
    // task-accountant-create-transaction. ACCOUNTANT has create-parity with
    // ADMIN for ADMIN_INCOME. Ownership + crediting differ by caller so the
    // income is ALWAYS credited to the admin owner of the project, never the
    // accountant (an ADMIN_INCOME is «доход с админ-проекта»):
    //   - ADMIN caller: project must be their own (seniorId === self); income
    //     is credited to that admin (receiverId = self). UNCHANGED.
    //   - ACCOUNTANT caller: may register on ANY admin-owned project (the
    //     project's senior must be an ADMIN); income is credited to that admin
    //     owner (receiverId = project.seniorId). The accountant is the recorder
    //     (createdBy), not the recipient.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT')
      throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')

    let receiverId: string
    if (currentUser.role === 'ADMIN') {
      if (project.seniorId !== currentUser.id) {
        throw new ForbiddenException('You can only add income for your own projects')
      }
      receiverId = currentUser.id
    } else {
      // ACCOUNTANT: the project must belong to an ADMIN (ADMIN_INCOME is income
      // owned by an admin partner). Credit that admin, never the accountant.
      const owner = await this.db.db.query.users.findFirst({
        where: eq(users.id, project.seniorId),
      })
      if (!owner || owner.role !== 'ADMIN') {
        throw new ForbiddenException(
          'ADMIN_INCOME can only be registered for an admin-owned project',
        )
      }
      receiverId = owner.id
    }

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    // task-salary-company-account: company-account routing. When COMPANY_ACCOUNT
    // the income is directed into the shared company pool — currency forced to
    // USDT and funding_source persisted. The company balance formula counts
    // ADMIN_INCOME(COMPANY_ACCOUNT) PAID as a (+) credit; getSummary EXCLUDES
    // these rows from the admin owner's personal balance (the money went to the
    // pool, not to the admin). No balance gate — this is an INFLOW. Absent →
    // legacy (admin-personal income, funding_source NULL, currency as supplied).
    const isCompanyFunded = data.fundingSource === 'COMPANY_ACCOUNT'
    const currency = (isCompanyFunded ? 'USDT' : data.currency) as 'USDT' | 'USD' | 'EUR' | 'UAH'
    const fundingSource: 'COMPANY_ACCOUNT' | null = isCompanyFunded ? 'COMPANY_ACCOUNT' : null

    const [tx] = await this.db.db
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
        notes: data.notes ?? null,
        fundingSource,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create SENIOR_INCOME ─────────────────────────────────────────────────

  async createSeniorIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'SENIOR') throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
      with: { financeSettings: true },
    })
    if (!project) throw new NotFoundException('Project not found')
    if (project.seniorId !== currentUser.id) {
      throw new ForbiddenException('You can only add income for your own projects')
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!senior) throw new NotFoundException('Senior not found')

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

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    const [tx] = await this.db.db
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
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

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
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'DROP') throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    // The drop can only declare income on a drop-project routed through them.
    if (project.dropId !== currentUser.id) {
      throw new ForbiddenException('Это не drop-проект под вами')
    }

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    const [tx] = await this.db.db
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
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
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
    if (tx.type !== 'SENIOR_INCOME')
      throw new BadRequestException('Can only edit SENIOR_INCOME transactions')
    if (tx.status !== 'REJECTED')
      throw new BadRequestException('Can only edit REJECTED transactions')
    if (tx.receiverId !== currentUser.id) throw new ForbiddenException()

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

    // ── 1:1 receipt replace-with-delete (PR-3) ──────────────────────────────
    //
    // Invariant: one SENIOR_INCOME ↔ exactly one RECEIPT document.
    //
    // When a SENIOR resubmits after rejection, the old receipt document must
    // be hard-deleted (S3 + DB row) atomically with the transaction update.
    //
    // ORDERING — chosen so S3 failure never corrupts DB state:
    //   STEP A (inside db.transaction): UPDATE transactions (FK → nextDocId,
    //          status PENDING, clear validation). Then DELETE old documents row
    //          (safe: FK no longer points at it).
    //   STEP B (after db.transaction commits): best-effort s3.delete(oldS3Key).
    //          On failure → warn-log only. A dangling S3 object is acceptable
    //          (costs pennies, ADMIN can clean up); a dangling orphan FK or a
    //          lost new-receipt pointer would be data corruption.
    //
    // Why DB-delete inside the transaction:
    //   If we deleted the documents row BEFORE the tx UPDATE committed, a crash
    //   between the two would leave the FK pointing at a ghost. Doing it after
    //   the UPDATE (but within the same tx) means the FK is already re-pointed
    //   to nextDocId — the old row is safely orphaned from the FK perspective
    //   and can be removed.
    //
    // hardDeleteInternal is called on documents row only (no RBAC). S3 cleanup
    // is split out below (post-commit, best-effort) so a MinIO hiccup never
    // rolls back the financial state update.
    const oldDocId = tx.receiptDocumentId

    // Fetch the old document's S3 key now (before the transaction) so we can
    // run S3 cleanup post-commit without another DB read.
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

    // STEP A: atomic DB transaction — update tx row + delete old documents row.
    //
    // WHY we use dbtx.delete() directly instead of hardDeleteInternal():
    //   hardDeleteInternal() uses `this.db.db` (the connection pool) for both
    //   its SELECT and DELETE. Calling it from inside a Drizzle db.transaction()
    //   callback would attempt to acquire a second pool connection while the outer
    //   transaction already holds one → PostgreSQL deadlock / pool exhaustion.
    //   Solution: perform the DB-delete inline via `dbtx` (same connection);
    //   move the S3 cleanup to STEP B (post-commit, best-effort).
    await this.db.db.transaction(async (dbtx) => {
      // A1. Update the transaction row: re-point FK, reset status, clear validation.
      await dbtx
        .update(transactions)
        .set({
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
        .where(eq(transactions.id, id))

      // A2. Delete old documents DB row inside the same tx (FK already re-pointed
      //     to nextDocId above — safe to remove the old row now).
      //     S3 cleanup is deferred to STEP B (post-commit) to keep this tx fast
      //     and to ensure an S3 hiccup cannot roll back the financial state.
      if (oldDocId && oldDocId !== nextDocId) {
        await dbtx.delete(documents).where(eq(documents.id, oldDocId))
      }
    })

    // STEP B: best-effort S3 cleanup post-commit.
    // The DB is fully consistent at this point (new receipt linked, old row
    // gone). A failure here leaves at most a dangling S3 object — never an
    // orphan FK or a missing new receipt pointer.
    if (oldS3Key) {
      await this.documentsService.deleteS3Keys(oldS3Key, oldThumbKey)
      this.logger.debug(
        `receipt replace: old S3 key="${oldS3Key}" scheduled for cleanup (post-commit)`,
      )
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

    await this.db.db
      .update(transactions)
      .set({
        ...(data.amount !== undefined && { amount: String(data.amount) }),
        ...(data.currency !== undefined && {
          currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...receiptPatch,
        ...(data.category !== undefined && { receiverLabel: data.category }),
        ...(data.salaryMonth !== undefined && { salaryMonth: data.salaryMonth }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, id))

    return this.findOne(id, currentUser)
  }

  // ── Admin Delete ──────────────────────────────────────────────────────────

  async adminDeleteTransaction(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    // Drop role - phase 3: PAYOUT_CONFIRMED is also non-deletable for the same
    // audit-trail reason as PAYOUT/PAYOUT_ADMIN.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw new BadRequestException('Cannot delete PAYOUT transactions')
    }
    if (tx.payoutRequestId) {
      throw new BadRequestException('Cannot delete a transaction linked to a payout request')
    }

    await this.db.db.delete(transactions).where(eq(transactions.id, id))
    return { deleted: true }
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
      await this.db.db
        .update(transactions)
        .set({
          status: 'VALIDATED',
          validatedBy: currentUser.id,
          validatedAt: now,
          updatedAt: now,
        })
        .where(eq(transactions.id, id))

      // task-salary-company-account: junior salaries no longer depend on
      // validated senior/drop income (LOCKED removed) — nothing to unlock here.
    } else {
      if (!rejectionReason) throw new BadRequestException('Rejection reason is required')
      await this.db.db
        .update(transactions)
        .set({
          status: 'REJECTED',
          validatedBy: currentUser.id,
          validatedAt: new Date(),
          rejectionReason,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, id))
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

    const now = new Date()
    const confirmationNote = `Manual payout confirmation by ${currentUser.id} at ${now.toISOString()} (method=${method})`

    await this.db.db.transaction(async (dbtx) => {
      // 1) Flip PAYOUT to PAID + record who/when confirmed. For CRYPTO method
      //    also stamp the txHash on the PAYOUT row so the senior-side audit
      //    matches the new credit row.
      await dbtx
        .update(transactions)
        .set({
          status: 'PAID',
          validatedBy: currentUser.id,
          validatedAt: now,
          updatedAt: now,
          ...(method === 'CRYPTO' && recordedTxHash ? { txHash: recordedTxHash } : {}),
        })
        .where(eq(transactions.id, payoutTxId))

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
    const confirmedRow = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'PAYOUT_CONFIRMED'),
        eq(transactions.payoutRequestId, payoutTx.payoutRequestId ?? ''),
        eq(transactions.receiverId, recipient.id),
        eq(transactions.notes, confirmationNote),
      ),
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

    const [tx] = await this.db.db
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

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create ADMIN_TRANSFER ─────────────────────────────────────────────────

  async createAdminTransfer(
    data: {
      senderId?: string | undefined
      receiverId: string
      amount: number
      currency?: string | undefined
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

    const effectiveSenderId = data.senderId ?? currentUser.id

    // Validate the sender is an ADMIN whenever it is not the (ADMIN) caller —
    // i.e. always for an ACCOUNTANT caller, and for an ADMIN who delegates the
    // sender to a different admin partner.
    if (effectiveSenderId !== currentUser.id || !isAdminCaller) {
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
    if (receiver.id === effectiveSenderId)
      throw new BadRequestException('Cannot transfer to yourself')

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'ADMIN_TRANSFER',
        status: 'PAID',
        amount: String(data.amount),
        currency: (data.currency ?? 'USDT') as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: effectiveSenderId,
        receiverId: data.receiverId,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

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

    // For a DROP caller the company-kept share is `1 - dropSharePercent%`. The
    // dropSharePercent lives on the user row (not snapshotted per-income like
    // the senior share), so resolve it once before the batch. SENIOR callers
    // read the per-income seniorSharePercent snapshot inside the loop below.
    let dropSharePercent = DEFAULT_DROP_SHARE_PERCENT
    if (isDrop) {
      const dropUser = await this.db.db.query.users.findFirst({
        where: eq(users.id, currentUser.id),
      })
      dropSharePercent = dropUser?.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT
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
          ),
        )
        .for('update')

      // Step 2: count-mismatch guard — any already-linked or disqualified tx
      // makes the batch invalid. Also applied after the lock so the decision
      // is based on the locked, consistent view of the rows.
      if (lockedRows.length !== transactionIds.length) {
        throw new BadRequestException('Часть транзакций уже включена в выплату или недоступна')
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
          ? dropSharePercent
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
      await dbtx.insert(transactions).values({
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: payableAmount,
        currency: 'USDT',
        senderId: currentUser.id,
        receiverLabel: 'CheekyCheeseIT',
        payoutRequestId: req!.id,
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
    const isDevMode = process.env['NODE_ENV'] !== 'production'
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
    const effectiveTxHash =
      txHash && txHash.trim().length >= 10
        ? txHash.trim()
        : isSimulating
          ? `0xSIM${randomBytes(28).toString('hex')}`
          : (() => {
              throw new BadRequestException('Хеш транзакции обязателен')
            })()

    // ── Phase 8 v2 — REAL on-chain validation (INVARIANT #1).
    // Outside dev-simulate, the payout is marked PAID ONLY when the submitted
    // tx really sent the payable USDT to the COMPANY wallet and is confirmed.
    // EtherscanService.verifyDeposit asserts recipient + confirmation count;
    // we additionally gate on the amount being within tolerance of payable.
    // ANY failure (recipient mismatch / not confirmed / amount off / no wallet)
    // throws BEFORE the status flip — the payout stays PENDING, nothing is
    // credited to the company account.
    if (!isSimulating) {
      const account = await this.db.db.query.companyAccount.findFirst()
      if (!account?.walletAddress) {
        throw new BadRequestException('Кошелёк компании не настроен')
      }

      // Idempotency: a txHash already consumed by a PAID payout (any request)
      // must not be reused to mark a second payout PAID. The on-chain transfer
      // happened once; reusing its hash would double-credit the company
      // account. Block before any verification/write.
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
      // Amount must be within tolerance of the recorded USDT payable. A null
      // amount (unresolved / malformed on-chain value) is treated as a
      // mismatch — never credit a payout whose transferred amount we cannot
      // verify.
      const payable = parseFloat(req.payableAmount)
      const onChain = verification.amountUsdt
      const withinTolerance =
        onChain !== null &&
        payable > 0 &&
        Math.abs(onChain - payable) <= payable * PAYOUT_AMOUNT_TOLERANCE
      if (!withinTolerance) {
        throw new BadRequestException('Сумма on-chain транзакции не соответствует сумме выплаты')
      }
    }

    // On-chain (or dev-simulate) settlement landed on the COMPANY wallet → the
    // PAYOUT row is credited to the company account (fundingSource marker).
    return this.applyPayoutPaidCascade(
      req,
      effectiveTxHash,
      PAYOUT_TO_COMPANY_ACCOUNT,
      null,
      currentUser,
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
    const noteTxHash = options.txHash?.trim()
    // A REAL on-chain hash was supplied (vs. a synthesized 0xMANUAL marker).
    // Only a real hash references an actual on-chain transfer that could be
    // double-counted; the random 0xMANUAL/0xSIM markers are unique by
    // construction, so they need no reuse guard.
    const hasRealTxHash = Boolean(noteTxHash && noteTxHash.length >= 10)
    const effectiveTxHash = hasRealTxHash
      ? noteTxHash!
      : `0xMANUAL${randomBytes(26).toString('hex')}`

    // Only COMPANY_ACCOUNT credits the company balance; ADMIN_USDT / CASH leave
    // fundingSource NULL so computeBalance ignores this PAYOUT row.
    const fundingSource = method === 'COMPANY_ACCOUNT' ? PAYOUT_TO_COMPANY_ACCOUNT : null

    // ── SECURITY (H1): txHash-reuse guard — mirrors payPayoutRequest:~2080.
    // When the manual confirmation CREDITS the company account (COMPANY_ACCOUNT)
    // and references a REAL on-chain hash, that hash must not already belong to
    // another PAID payout. Without this, an ADMIN/ACCOUNTANT could manual-confirm
    // a second payout with a txHash already consumed by a PAID one and credit the
    // company balance TWICE for a single on-chain transfer (no DB unique index on
    // payout_requests.txHash backstops this — verified). ADMIN_USDT / CASH never
    // credit the balance, and synthetic markers are unique, so the guard is
    // scoped to the only exploitable path. Runs BEFORE any write.
    if (method === 'COMPANY_ACCOUNT' && hasRealTxHash) {
      const reused = await this.db.db.query.payoutRequests.findFirst({
        where: and(eq(payoutRequests.txHash, effectiveTxHash), eq(payoutRequests.status, 'PAID')),
      })
      if (reused) {
        throw new BadRequestException('Этот хеш транзакции уже использован для другой выплаты')
      }
    }
    const auditNote = `Manual payout confirmation by ${currentUser.id} at ${new Date().toISOString()} (method=${method})${
      options.note ? ` — ${options.note}` : ''
    }`

    return this.applyPayoutPaidCascade(req, effectiveTxHash, fundingSource, auditNote, currentUser)
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
        // Mark payout request as paid
        await dbtx
          .update(payoutRequests)
          .set({
            txHash: effectiveTxHash,
            status: 'PAID',
            updatedAt: new Date(),
          })
          .where(eq(payoutRequests.id, requestId))

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
        await dbtx
          .update(transactions)
          .set({
            status: 'PAID',
            txHash: effectiveTxHash,
            fundingSource,
            updatedAt: new Date(),
            ...(auditNote ? { notes: auditNote } : {}),
          })
          .where(and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')))

        // Re-fetch the PAYOUT id (the UPDATE above doesn't return rows in
        // drizzle's current Postgres flavour without `.returning()` chaining).
        // Captured here so the invoice trigger can run AFTER commit (best-effort).
        const [payoutRow] = await dbtx
          .select({ id: transactions.id })
          .from(transactions)
          .where(and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')))
          .limit(1)

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
          // computeDropDistribution is PURE (no DB). The senior share uses the
          // resolved snapshot value (project/team override aware) rather than the
          // raw user default, so the obligation booked below matches the snapshot.
          const distribution = this.computeDropDistribution(
            income,
            { id: primaryProject.id, dropId: primaryProject.dropId },
            { id: dropUser.id, dropSharePercent: dropUser.dropSharePercent },
            { id: senior.id, seniorSharePercent: seniorShareSnapshot.value },
          )

          // Drop's slice — visible on the DROP user's balance.
          // senderId = senior (who initiated the off-platform settlement);
          // receiverId + recipientId both = drop (explicit semantics — see
          // schema comment on recipient_id).
          await dbtx.insert(transactions).values({
            type: 'PAYOUT_DROP',
            status: 'PAID',
            amount: String(distribution.dropShare.amount),
            currency: 'USDT',
            senderId: currentUser.id,
            receiverId: dropUser.id,
            recipientId: dropUser.id,
            projectId: primaryProject.id,
            payoutRequestId: requestId,
            txHash: effectiveTxHash,
            createdBy: currentUser.id,
          })

          // task-drop-payout-company-account. The senior share of a drop-project
          // income is owed by the COMPANY (not by the drop). The full `payable`
          // already landed on the company account via the PAYOUT row's
          // fundingSource='COMPANY_ACCOUNT' marker; the company now owes the
          // senior their slice. We book it as:
          //   1) SENIOR_PENDING_PAYOUT (PENDING_PAYMENT) — a visible IOU row with
          //      the senior-share snapshot, mirroring the (now-removed) payment-
          //      channel cascade so reporting/feeds are unchanged.
          //   2) pending_obligations (creditor=senior, debtorType=COMPANY) — the
          //      settle-able debt that ADMIN/ACCOUNTANT later closes via
          //      settleByCompany (→ SENIOR_INCOME, debits the company account).
          // No PAYOUT_ADMIN is ever emitted (the legacy auto 50/50 partner split
          // was removed in fix/payout-credits-company-account; admin income is a
          // deliberate manual DIVIDEND_TO_ADMIN flow). The historical PAYOUT_ADMIN
          // enum value is retained only for legacy rows — we never create new ones.
          const [pendingRow] = await dbtx
            .insert(transactions)
            .values({
              type: 'SENIOR_PENDING_PAYOUT',
              status: 'PENDING_PAYMENT',
              amount: String(distribution.seniorShare.amount),
              currency: 'USDT',
              senderLabel: 'COMPANY',
              receiverId: senior.id,
              recipientId: senior.id,
              projectId: primaryProject.id,
              payoutRequestId: requestId,
              seniorSharePercent: seniorShareSnapshot.value,
              seniorSharePercentSource: seniorShareSnapshot.source,
              notes: 'Drop payout — senior IOU (debtor=COMPANY)',
              createdBy: currentUser.id,
            })
            .returning()
          if (pendingRow) {
            await dbtx.insert(pendingObligations).values({
              creditorUserId: senior.id,
              debtorType: 'COMPANY',
              debtorUserId: null,
              sourceTransactionId: pendingRow.id,
              amount: String(distribution.seniorShare.amount),
              currency: 'USDT',
              status: 'PENDING',
            })
          }
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
      if (isUniqueViolation(err)) {
        throw new BadRequestException('Этот хеш транзакции уже использован для другой выплаты')
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
            sender: { columns: { displayName: true } },
            receiver: { columns: { displayName: true } },
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

    return {
      id: req.id,
      seniorId: req.seniorId,
      seniorName:
        (req as typeof req & { senior: { displayName: string } | null }).senior?.displayName ?? '',
      incomeAmount: req.incomeAmount,
      payableAmount: req.payableAmount,
      contractAddress: req.contractAddress,
      txHash: req.txHash,
      status: req.status,
      transactions: (req as typeof req & { transactions: TxWithRelations[] }).transactions.map(
        (tx) => this.mapTx(tx),
      ),
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
    // for /crm/stats + the финансовый хаб, but NOT the per-partner / per-drop
    // balances — those are ADMIN-only and the ACCOUNTANT UI already hides them
    // (#214 removed the drop-balances panel; #215 gates the balance sections on
    // /crm/stats to ADMIN). We therefore stop sending them on the wire too:
    // ADMIN keeps the full arrays (no regression), ACCOUNTANT gets empty arrays
    // (`[]`). Empty — not omitted — because `financeSummarySchema.adminBalances`
    // is a required array, so the existing FinanceSummaryDto parse on the client
    // stays valid for both roles.
    const canSeeBalances = currentUser.role === 'ADMIN'

    // Scaled-integer constant used throughout aggregations below to avoid
    // JS float accumulation errors. Aliased to the module-level `MONEY_SCALE`
    // single source of truth so this method and `computeDropAggregate` can
    // never drift apart on the rounding scale.
    const SCALE = MONEY_SCALE

    const allTxs = (await this.db.db.query.transactions.findMany({
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
      },
    })) as TxWithRelations[]

    const paid = allTxs.filter((tx) => tx.status === 'PAID')

    // Drop role - phase 2: DROP_INCOME counts toward total income for
    // reporting purposes (gross money that came in through DROPs).
    // Scaled-integer reduce to avoid float accumulation (MED-5).
    const totalIncome =
      Math.round(
        paid
          .filter(
            (tx) =>
              tx.type === 'ADMIN_INCOME' ||
              tx.type === 'SENIOR_INCOME' ||
              tx.type === 'DROP_INCOME',
          )
          .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * SCALE), 0),
      ) / SCALE

    const totalExpenses =
      Math.round(
        paid
          .filter((tx) => tx.type === 'EXPENSE')
          .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * SCALE), 0),
      ) / SCALE

    const totalSalaries =
      Math.round(
        paid
          .filter((tx) => tx.type === 'SALARY')
          .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * SCALE), 0),
      ) / SCALE

    // Admin balances: sum of PAYOUT_ADMIN received + ADMIN_INCOME - ADMIN_TRANSFER sent.
    // Drop role - phase 3 (spec §8.4): PAYOUT_CONFIRMED — the row inserted by
    // `confirmPayout` when ACCOUNTANT/ADMIN manually confirms an off-platform
    // payout — also credits the chosen admin's balance. Phase 2 PAYOUT_ADMIN
    // (automatic 50/50 split) remains untouched and continues to count too;
    // both flows run in parallel per task scope ("Phase 2 auto-50/50 НЕ
    // ТРОГАТЬ — manual flow живёт параллельно"). Senior-only / legacy admin
    // balance values are unchanged because they never produce PAYOUT_CONFIRMED
    // rows.
    // ACCOUNTANT does not receive the balance arrays (see `canSeeBalances`
    // above) — skip the extra DB reads + aggregation entirely and return `[]`
    // for both. ADMIN keeps the full, unchanged computation below.
    const adminBalances = !canSeeBalances
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
            .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * SCALE), 0)
          const sentScaled = paid
            .filter((tx) => tx.senderId === admin.id && tx.type === 'ADMIN_TRANSFER')
            .reduce((sum, tx) => sum + Math.round(parseFloat(tx.amount) * SCALE), 0)
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
    // ACCOUNTANT gets `[]` (see `canSeeBalances`); ADMIN keeps the full list.
    const dropBalances = !canSeeBalances
      ? []
      : (
          await this.db.db.query.users.findMany({
            where: eq(users.role, 'DROP'),
          })
        ).map((drop) => {
          const aggregate = this.computeDropAggregate(
            { id: drop.id, displayName: drop.displayName, dropSharePercent: drop.dropSharePercent },
            allTxs,
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
      const month = tx.createdAt.toISOString().slice(0, 7) // YYYY-MM
      if (!monthMap.has(month))
        monthMap.set(month, { incomeScaled: 0, expensesScaled: 0, salariesScaled: 0 })
      const entry = monthMap.get(month)!
      const amtScaled = Math.round(parseFloat(tx.amount) * SCALE)

      if (tx.type === 'ADMIN_INCOME' || tx.type === 'SENIOR_INCOME' || tx.type === 'DROP_INCOME') {
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
    const mySalaryStatus = await getOwnSalaryStatus(this.db.db, selfId, salaryMonth)

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
   * receivers' figures, it must never reach a SENIOR / JUNIOR / HR / DROP.
   *
   * «Приход внесён по проекту» (owner decision, task-file) = ≥1 income row of the
   * receiver's income type for the project with status VALIDATED|PAID and
   * `(txDate ?? createdAt)` inside the target month (UTC). PENDING does NOT count
   * (but flags the project as `pendingValidation` for the «на валидации» badge);
   * REJECTED is ignored. ADMIN_INCOME is written PAID immediately, so an admin-as-
   * senior's projects count as soon as the income row exists.
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

    // ── 3. Counted + pending income rows for the month, per (projectId, type) ──
    // A single aggregating pass over the relevant income rows. We only need to
    // know, per project + income-type, whether ANY row is VALIDATED|PAID
    // (counted) and whether ANY row is PENDING (pending-only badge). The dataset
    // is tiny (units of projects) so JS grouping is cheap and keeps the existing
    // service-spec mock surface (query.transactions.findMany) intact.
    const projectIds = activeProjects.map((p) => p.id)
    const incomeRows = await this.db.db.query.transactions.findMany({
      where: and(
        inArray(transactions.type, ['SENIOR_INCOME', 'ADMIN_INCOME', 'DROP_INCOME']),
        inArray(transactions.status, ['VALIDATED', 'PAID', 'PENDING']),
        inArray(transactions.projectId, projectIds),
      ),
      columns: { type: true, status: true, projectId: true, txDate: true, createdAt: true },
    })

    // key = `${projectId}|${type}` → { counted, pending } for the target month.
    const incomeByKey = new Map<string, { counted: boolean; pending: boolean }>()
    for (const tx of incomeRows) {
      if (!tx.projectId) continue
      const when = tx.txDate ?? tx.createdAt
      if (!when) continue
      const whenDate = new Date(when)
      if (whenDate < monthStart || whenDate >= nextMonthStart) continue
      const key = `${tx.projectId}|${tx.type}`
      const entry = incomeByKey.get(key) ?? { counted: false, pending: false }
      if (tx.status === 'VALIDATED' || tx.status === 'PAID') entry.counted = true
      else if (tx.status === 'PENDING') entry.pending = true
      incomeByKey.set(key, entry)
    }

    // Income type expected for a given owner role.
    const incomeTypeFor = (
      role: string,
    ): 'SENIOR_INCOME' | 'ADMIN_INCOME' | 'DROP_INCOME' | null =>
      role === 'SENIOR'
        ? 'SENIOR_INCOME'
        : role === 'ADMIN'
          ? 'ADMIN_INCOME'
          : role === 'DROP'
            ? 'DROP_INCOME'
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
    // owner. Each (receiver, project) pair is evaluated against the receiver's
    // own income type. ──────────────────────────────────────────────────────
    type Acc = {
      userId: string
      displayName: string
      role: IncomeComplianceRole
      incomeType: 'SENIOR_INCOME' | 'ADMIN_INCOME' | 'DROP_INCOME'
      projects: Array<{ projectId: string; name: string; companyName: string }>
    }
    const byReceiver = new Map<string, Acc>()
    const addPair = (ownerId: string | null, p: (typeof activeProjects)[number]): void => {
      if (!ownerId) return
      const owner = ownerById.get(ownerId)
      if (!owner) return
      const complianceRole = complianceRoleFor(owner.role)
      const incomeType = incomeTypeFor(owner.role)
      if (!complianceRole || !incomeType) return // ignore non-receiver roles defensively
      let acc = byReceiver.get(ownerId)
      if (!acc) {
        acc = {
          userId: ownerId,
          displayName: owner.displayName,
          role: complianceRole,
          incomeType,
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

    const receivers: IncomeComplianceReceiverDto[] = []
    for (const acc of byReceiver.values()) {
      const missingProjects: IncomeComplianceReceiverDto['missingProjects'] = []
      let submitted = 0
      let pendingCount = 0
      for (const proj of acc.projects) {
        const entry = incomeByKey.get(`${proj.projectId}|${acc.incomeType}`)
        const counted = entry?.counted ?? false
        const pendingOnly = !counted && (entry?.pending ?? false)
        if (counted) {
          submitted += 1
        } else {
          if (pendingOnly) pendingCount += 1
          missingProjects.push({
            projectId: proj.projectId,
            name: proj.name,
            companyName: proj.companyName,
            submitted: false,
            pendingValidation: pendingOnly,
          })
        }
      }
      const expected = acc.projects.length
      expectedProjects += expected
      submittedProjects += submitted
      pendingProjects += pendingCount
      if (submitted >= expected) completeReceivers += 1
      else laggingReceivers += 1

      receivers.push({
        userId: acc.userId,
        displayName: acc.displayName,
        role: acc.role,
        expected,
        submitted,
        pendingCount,
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

    const existing = await this.db.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })

    const values = {
      seniorSharePercentOverride: data.seniorSharePercentOverride ?? null,
      juniorSalaryOverride:
        data.juniorSalaryOverride !== undefined && data.juniorSalaryOverride !== null
          ? String(data.juniorSalaryOverride)
          : null,
      updatedBy: currentUser.id,
      updatedAt: new Date(),
    }

    if (existing) {
      await this.db.db
        .update(projectFinanceSettings)
        .set(values)
        .where(eq(projectFinanceSettings.projectId, projectId))
    } else {
      await this.db.db.insert(projectFinanceSettings).values({ projectId, ...values })
    }

    return this.getProjectFinanceSettings(projectId, currentUser)
  }

  // ── Pay salary manually ───────────────────────────────────────────────────

  async paySalary(
    id: string,
    data: {
      // task-salary-pay-flow: the funding source + currency are chosen HERE (at
      // pay time), not at creation. The PENDING salary is a neutral reminder.
      fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
      // For ADMIN_PERSONAL — whose personal account pays; must be an ADMIN.
      payerAdminId?: string | undefined
      currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
      txHash?: string | null | undefined
      notes?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    if (tx.type !== 'SALARY') throw new BadRequestException('Can only pay SALARY transactions')
    if (tx.status !== 'PENDING') throw new BadRequestException('Transaction is not PENDING')

    const isCompanyFunded = data.fundingSource === 'COMPANY_ACCOUNT'

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
      currency = data.currency
    }

    // task-salary-pay-flow: stamp txDate = pay date (now). The salary was created
    // (PENDING) on an earlier date, but the business-time of the actual payment
    // is when an ADMIN pays it. The funding source / currency / sender are
    // finalized on the row HERE.
    const paidSet = {
      status: 'PAID' as const,
      fundingSource: isCompanyFunded ? ('COMPANY_ACCOUNT' as const) : ('ADMIN_PERSONAL' as const),
      currency,
      senderId,
      senderLabel,
      txHash: data.txHash ?? null,
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
      const amount = parseFloat(tx.amount)
      await this.db.db.transaction(async (dbtx) => {
        await lockCompanyAccount(dbtx)
        const [fresh] = await dbtx
          .select({ status: transactions.status })
          .from(transactions)
          .where(eq(transactions.id, id))
        if (!fresh || fresh.status !== 'PENDING') {
          throw new BadRequestException('Transaction is not PENDING')
        }
        const companyBalance = await this.computeCompanyAccountBalance(dbtx)
        if (companyBalance < amount) {
          throw new BadRequestException('Недостаточно средств на счёте компании')
        }
        await dbtx.update(transactions).set(paidSet).where(eq(transactions.id, id))
      })
    } else {
      await this.db.db.update(transactions).set(paidSet).where(eq(transactions.id, id))
    }

    // Trigger 2: invoice auto-create for SALARY → PAID transitions. Run AFTER the
    // debit transaction commits (best-effort; must not hold the lock).
    await this.safeAutoCreateInvoice('SALARY', id)

    return this.findOne(id, currentUser)
  }

  // ── Cron helpers ──────────────────────────────────────────────────────────

  async createMonthlySalaries(month: string) {
    // Create PENDING salary for HR and ACCOUNTANT
    const employees = await this.db.db.query.users.findMany({
      where: or(eq(users.role, 'HR'), eq(users.role, 'ACCOUNTANT')),
    })

    // Find the admin who creates (Maksym by default). Used only as `createdBy`
    // for audit — the cron creates neutral PENDING reminders, no money moves
    // until an ADMIN pays each one via paySalary (which picks the funding source).
    const admin = await this.db.db.query.users.findFirst({
      where: and(eq(users.role, 'ADMIN'), eq(users.id, MAKSYM_ID)),
    })
    if (!admin) return

    for (const emp of employees) {
      if (!emp.monthlySalary) continue

      // Skip if already created for this month
      const existing = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, emp.id),
          eq(transactions.salaryMonth, month),
        ),
      })
      if (existing) continue

      // task-salary-pay-flow: monthly salaries are NEUTRAL PENDING reminders —
      // no funding source, no currency lock, no balance impact at creation. The
      // funding source (company account vs admin personal) and the actual
      // payment currency are chosen at pay time (paySalary). `monthlySalary` is
      // the USD nominal of the reminder.
      await this.db.db.insert(transactions).values({
        type: 'SALARY',
        status: 'PENDING',
        amount: emp.monthlySalary,
        currency: 'USD',
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        receiverId: emp.id,
        salaryMonth: month,
        fundingSource: null,
        createdBy: admin.id,
      })
    }

    // Create PENDING salary for JUNIORs on active projects.
    // task-salary-company-account: the LOCKED-until-validated-income mechanic is
    // GONE — juniors always get a PENDING salary regardless of whether the
    // project's senior/drop income has been validated yet. (The
    // unlockJuniorSalaryForProject method + its callers were removed.)
    const activeMembers = await this.db.db.query.projectMembers.findMany({
      where: isNull(projectMembers.leftAt),
      with: {
        user: true,
        project: { with: { financeSettings: true } },
      },
    })

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

      if (!user || user.role !== 'JUNIOR' || !project) continue

      const existing = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, user.id),
          eq(transactions.salaryMonth, month),
        ),
      })
      if (existing) continue

      // Resolve salary: project override → user default
      const salaryAmount = project.financeSettings?.juniorSalaryOverride ?? user.monthlySalary
      if (!salaryAmount) continue

      await this.db.db.insert(transactions).values({
        type: 'SALARY',
        status: 'PENDING',
        amount: String(salaryAmount),
        currency: 'USD',
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        receiverId: user.id,
        projectId: project.id,
        salaryMonth: month,
        fundingSource: null,
        createdBy: admin.id,
      })
    }
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
}
