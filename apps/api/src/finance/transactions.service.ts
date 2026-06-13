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

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type {
  SessionUser,
  DropIncomeDto,
  DropIncomeStatus,
  DropIncomesQuery,
  DropPaymentDto,
  DropPaymentStatus,
  PaginatedDropIncomes,
} from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  projectFinanceSettings,
  projectMembers,
  payoutRequests,
  projects,
  teamMembers,
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { resolveSeniorShare } from './senior-share-resolver'

/** Default drop-share percentage when `users.dropSharePercent` is NULL.
 *  Used in both `computeDropDistribution` (write-path) and `getSummary`
 *  (read-path display). Single source of truth — never duplicate the literal 5.
 */
export const DEFAULT_DROP_SHARE_PERCENT = 5

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
    const seniorPercent = senior.seniorSharePercent ?? 26
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
   */
  private mapDropPaymentStatus(dbStatus: string): DropPaymentStatus {
    switch (dbStatus) {
      case 'PAID':
        return 'confirmed'
      case 'REJECTED':
        return 'failed'
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
    const toTs = query.to ? Date.parse(query.to) : undefined

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
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    if (project.seniorId !== currentUser.id) {
      throw new ForbiddenException('You can only add income for your own projects')
    }

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: String(data.amount),
        currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: currentUser.id,
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
      if (tx.type === 'SENIOR_INCOME') {
        // feat/finance-payout-flow (#7): SENIOR_INCOME validate ONLY flips
        // status to VALIDATED. No payout_request and no PAYOUT row are created
        // here. The SENIOR manually creates a payout via POST /api/payout-requests
        // (createPayoutRequest) which lets them batch multiple VALIDATED incomes
        // into a single payout. This removes the auto-duplicate-payout bug where
        // validate created a payout_request and then createPayoutRequest created
        // a second one on the already-VALIDATED row.
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

        // Unlock junior salary for this project's current month if locked.
        // Best-effort — if it fails the validate still succeeded.
        await this.unlockJuniorSalaryForProject(tx.projectId, tx)
      } else {
        // DROP_INCOME: retain the original behaviour — atomically flip to
        // VALIDATED + create payout_request + insert placeholder PAYOUT row.
        // The drop-specific distribution math lives in payPayoutRequest.
        if (!tx.receiverId) {
          throw new BadRequestException(`${tx.type} has no receiverId — cannot create payout`)
        }
        const walletOwner = await this.db.db.query.users.findFirst({
          where: eq(users.id, tx.receiverId),
        })
        if (!walletOwner) throw new NotFoundException('Receiver not found')

        // DROP_INCOME: share kept = users.dropSharePercent ?? 5
        const sharePercent = walletOwner.dropSharePercent ?? 5
        const incomeAmount = parseFloat(tx.amount)
        const payableAmount = incomeAmount * (1 - sharePercent / 100)

        const contractAddress = '0x' + randomBytes(20).toString('hex')
        const now = new Date()

        await this.db.db.transaction(async (dbtx) => {
          const [req] = await dbtx
            .insert(payoutRequests)
            .values({
              seniorId: tx.receiverId!,
              incomeAmount: String(incomeAmount),
              payableAmount: String(payableAmount),
              contractAddress,
              status: 'PENDING',
            })
            .returning()

          await dbtx
            .update(transactions)
            .set({
              status: 'VALIDATED',
              payoutRequestId: req!.id,
              validatedBy: currentUser.id,
              validatedAt: now,
              updatedAt: now,
            })
            .where(eq(transactions.id, id))

          await dbtx.insert(transactions).values({
            type: 'PAYOUT',
            status: 'PENDING_PAYMENT',
            amount: String(payableAmount),
            currency: tx.currency,
            senderId: tx.receiverId!,
            receiverLabel: 'CheekyCheeseIT',
            projectId: tx.projectId,
            payoutRequestId: req!.id,
            createdBy: currentUser.id,
          })
        })

        // Unlock junior salary for this project's current month if locked.
        await this.unlockJuniorSalaryForProject(tx.projectId, tx)
      }
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
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await this.assertReceiptDocumentBindable(data.receiptDocumentId, currentUser)
    }

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'EXPENSE',
        status: 'PAID',
        amount: String(data.amount),
        currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: currentUser.id,
        receiverLabel: data.category,
        notes: data.notes ?? null,
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create SALARY ─────────────────────────────────────────────────────────

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
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw new NotFoundException('User not found')
    if (!['JUNIOR', 'HR', 'ACCOUNTANT'].includes(receiver.role)) {
      throw new BadRequestException('Salary can only be created for JUNIOR, HR, or ACCOUNTANT')
    }

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'SALARY',
        status: 'PAID',
        amount: String(data.amount),
        currency: (data.currency ?? 'USD') as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: currentUser.id,
        senderLabel: 'CheekyCheeseIT',
        receiverId: data.receiverId,
        salaryMonth: data.salaryMonth,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    // Trigger 2: invoice auto-create — SALARY rows from this path land
    // straight in PAID, so the invoice should be generated immediately.
    await this.safeAutoCreateInvoice('SALARY', tx!.id)

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
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const effectiveSenderId = data.senderId ?? currentUser.id

    if (data.senderId && data.senderId !== currentUser.id) {
      const sender = await this.db.db.query.users.findFirst({ where: eq(users.id, data.senderId) })
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
    if (currentUser.role !== 'SENIOR') throw new ForbiddenException()

    // ── SECURITY (HIGH): atomic SELECT-FOR-UPDATE + full mutation inside one
    // DB transaction to prevent TOCTOU race. Two concurrent POST requests on
    // the same SENIOR_INCOME rows would otherwise both pass the isNull() guard
    // (reading stale snapshots) and each create a separate payout_request,
    // doubling the payout. The FOR UPDATE lock on the income rows blocks the
    // second concurrent read until the first transaction commits; at that point
    // the second re-read finds payoutRequestId IS NOT NULL and the outer
    // count-mismatch guard throws 400.
    return this.db.db.transaction(async (dbtx) => {
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
            eq(transactions.type, 'SENIOR_INCOME'),
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

      // ── SECURITY (HIGH): mixed-currency guard.
      // Aggregating amounts across different currencies produces a meaningless
      // sum (e.g. 1000 USD + 500 EUR ≠ 1500 of anything). Reject the batch
      // if the selected transactions span more than one currency. The PAYOUT
      // row inherits the currency from the batch — hardcoding 'USDT' was the
      // original bug that silently coerced USD/EUR incomes into USDT payouts.
      const currencies = new Set(lockedRows.map((tx) => tx.currency))
      if (currencies.size > 1) {
        throw new BadRequestException('Выберите транзакции одной валюты для одной выплаты')
      }
      // Safe: lockedRows.length > 0 guaranteed by the count check above.
      const batchCurrency = lockedRows[0]!.currency

      // ── MED: decimal-safe aggregation.
      // Postgres numeric(18,6) stores exact decimals; parseFloat() would
      // introduce IEEE-754 rounding errors on the accumulated sum. We keep
      // each per-tx payable as a scaled integer (minor units × 1_000_000),
      // sum those, then divide once at the end — one division ≈ one rounding
      // event vs. N rounding events for N loop iterations.
      const SCALE = 1_000_000
      let incomeMinor = 0
      let payableMinor = 0
      for (const tx of lockedRows) {
        // amount is stored as numeric string from Postgres.
        const amountMinor = Math.round(parseFloat(tx.amount) * SCALE)
        const sharePercent = tx.seniorSharePercent ?? 26
        // company's share = 1 - seniorShare/100; use integer arithmetic
        // on the scaled amount to avoid floating-point drift per iteration.
        const companyShareMinor = Math.round((amountMinor * (100 - sharePercent)) / 100)
        incomeMinor += amountMinor
        payableMinor += companyShareMinor
      }
      const incomeAmount = (incomeMinor / SCALE).toFixed(6)
      const payableAmount = (payableMinor / SCALE).toFixed(6)

      // Stub contract address — Ethereum-shape (0x + 40 hex). Per-payout fresh
      // address, swapped for the real PaymentSplitter when PHASE 8 ships.
      const contractAddress = '0x' + randomBytes(20).toString('hex')

      // Step 3: insert payout_request. All writes are inside the transaction.
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

      // Step 5: create the placeholder PAYOUT row (PENDING_PAYMENT). Currency
      // comes from the batch, not hardcoded. This row is visible in the
      // transactions table immediately so the SENIOR can click «Оплатить»
      // without waiting for the payout_request detail page. The same row
      // is mutated to PAID in payPayoutRequest (txHash + status flip) — no
      // fresh PAYOUT is inserted there.
      await dbtx.insert(transactions).values({
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: payableAmount,
        currency: batchCurrency,
        senderId: currentUser.id,
        receiverLabel: 'CheekyCheeseIT',
        payoutRequestId: req!.id,
        createdBy: currentUser.id,
      })

      return this.findPayoutRequest(req!.id, currentUser)
    })
  }

  // ── Pay Payout Request ────────────────────────────────────────────────────

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
    // either branch of the etherscan stub without going on-chain. In
    // production the flag is ignored — real verification logic owns the
    // decision.
    const isDevMode = process.env['NODE_ENV'] !== 'production'
    const isSimulating = isDevMode && simulateResult !== undefined
    if (isSimulating && simulateResult === 'error') {
      throw new BadRequestException('Симуляция: транзакция не подтверждена')
    }
    // simulateResult === 'success' falls through to the normal cascade below
    // (which already short-circuits etherscan today — see EtherscanService
    // header comment about the missing real-verification call site).
    //
    // When the SENIOR submits without a real on-chain hash (simulate mode),
    // we synthesize a deterministic stub hash so the audit trail (txHash
    // column on payout_requests + linked transactions) is never empty. The
    // 0xSIM prefix is the convention the UI uses to skip the etherscan link
    // (see PayoutDetailDialog footer).
    const effectiveTxHash =
      txHash && txHash.trim().length >= 10
        ? txHash.trim()
        : isSimulating
          ? `0xSIM${randomBytes(28).toString('hex')}`
          : (() => {
              throw new BadRequestException('Хеш транзакции обязателен')
            })()

    // Mark payout request as paid
    await this.db.db
      .update(payoutRequests)
      .set({
        txHash: effectiveTxHash,
        status: 'PAID',
        updatedAt: new Date(),
      })
      .where(eq(payoutRequests.id, requestId))

    // Mark linked SENIOR_INCOME transactions as PAID
    await this.db.db
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
    const paidIncomeTxs = await this.db.db
      .select({ id: transactions.id, projectId: transactions.projectId, type: transactions.type })
      .from(transactions)
      .where(
        and(
          eq(transactions.payoutRequestId, requestId),
          or(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.type, 'DROP_INCOME')),
        ),
      )

    // Mark the placeholder PAYOUT row (created at createPayoutRequest time)
    // as PAID + attach the on-chain txHash. We don't INSERT a fresh PAYOUT
    // here — the row already exists with status PENDING_PAYMENT so the
    // SENIOR could see «Выплата» in the table before clicking «Оплатить».
    await this.db.db
      .update(transactions)
      .set({
        status: 'PAID',
        txHash: effectiveTxHash,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')))

    // task-aggregate-invoice-per-payout. ONE aggregated invoice anchored on
    // the PAYOUT row. Best-effort — see safeAutoCreateInvoice for the
    // no-rollback contract. We re-fetch the PAYOUT id (the UPDATE above
    // doesn't return rows in drizzle's current Postgres flavour without
    // `.returning()` chaining); idempotency is guarded by the PAYOUT row's
    // own `invoice_document_id` field.
    const [payoutRow] = await this.db.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')))
      .limit(1)
    if (payoutRow) {
      await this.safeAutoCreateInvoice('PAYOUT', payoutRow.id)
    }

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
      ? await this.db.db.query.projects.findFirst({
          where: eq(projects.id, primaryProjectId),
        })
      : null

    const dropUser = primaryProject?.dropId
      ? await this.db.db.query.users.findFirst({
          where: eq(users.id, primaryProject.dropId),
        })
      : null

    const payable = parseFloat(req.payableAmount)

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
        ? await this.db.db.query.users.findFirst({
            where: eq(users.id, primaryProject.seniorId),
          })
        : null
      if (!senior) throw new NotFoundException('Senior not found on drop-project')

      const income = parseFloat(req.incomeAmount)
      const distribution = this.computeDropDistribution(
        income,
        { id: primaryProject.id, dropId: primaryProject.dropId },
        { id: dropUser.id, dropSharePercent: dropUser.dropSharePercent },
        { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
      )

      // Drop's slice — visible on the DROP user's balance.
      // senderId = senior (who initiated the off-platform settlement);
      // receiverId + recipientId both = drop (explicit semantics — see
      // schema comment on recipient_id).
      await this.db.db.insert(transactions).values({
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

      // Partner residual (50/50 split) on the drop-project's remainder.
      for (const share of distribution.partnerShares) {
        const admin = await this.db.db.query.users.findFirst({
          where: eq(users.id, share.adminId),
        })
        if (admin) {
          await this.db.db.insert(transactions).values({
            type: 'PAYOUT_ADMIN',
            status: 'PAID',
            amount: String(share.amount),
            currency: 'USDT',
            senderId: currentUser.id,
            receiverId: share.adminId,
            projectId: primaryProject.id,
            payoutRequestId: requestId,
            txHash: effectiveTxHash,
            createdBy: currentUser.id,
          })
        }
      }
    } else {
      // Senior-project branch (legacy split math). `computePartnersSplit(payable)`
      // returns `[{maksym, payable/2}, {kostya, payable/2}]` — unchanged from
      // pre-AC1. Backlog AC5: include `projectId` on each PAYOUT_ADMIN insert
      // so the row is traceable back to the originating project (matches the
      // drop-branch shape above). `primaryProject` is null only when the
      // payout has no linked SENIOR_INCOME rows — a degenerate case that
      // can't actually happen here (the cascade short-circuits earlier on
      // empty payouts) but we keep the fallback to `null` for safety.
      const partnerShares = this.computePartnersSplit(payable)
      const senderProjectId = primaryProject?.id ?? null

      for (const share of partnerShares) {
        const admin = await this.db.db.query.users.findFirst({
          where: eq(users.id, share.adminId),
        })
        if (admin) {
          await this.db.db.insert(transactions).values({
            type: 'PAYOUT_ADMIN',
            status: 'PAID',
            amount: String(share.amount),
            currency: 'USDT',
            senderId: currentUser.id,
            receiverId: share.adminId,
            projectId: senderProjectId,
            payoutRequestId: requestId,
            txHash: effectiveTxHash,
            createdBy: currentUser.id,
          })
        }
      }
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
    const adminUsers = await this.db.db.query.users.findMany({
      where: eq(users.role, 'ADMIN'),
    })

    const adminBalances = adminUsers.map((admin) => {
      const receivedScaled = paid
        .filter(
          (tx) =>
            tx.receiverId === admin.id &&
            (tx.type === 'PAYOUT_ADMIN' ||
              tx.type === 'ADMIN_INCOME' ||
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
    const dropUsers = await this.db.db.query.users.findMany({
      where: eq(users.role, 'DROP'),
    })

    // Drop role - phase 1 (task-drop-1-backend): per-drop aggregate now flows
    // through the shared `computeDropAggregate` helper (single source of truth
    // also consumed by the self-only `getDropSelfSummary`). The admin summary
    // DTO is unchanged — `debtToCompany` (returned by the helper) is mapped
    // away here so `financeSummarySchema.dropBalances` and its existing unit
    // tests stay byte-for-byte identical.
    const dropBalances = dropUsers.map((drop) => {
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
      .sort(([a], [b]) => a.localeCompare(b))
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

    await this.db.db
      .update(transactions)
      .set({
        status: 'PAID',
        txHash: data.txHash ?? null,
        notes: data.notes ?? tx.notes,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, id))

    // Trigger 2: invoice auto-create for SALARY → PAID transitions.
    await this.safeAutoCreateInvoice('SALARY', id)

    return this.findOne(id, currentUser)
  }

  // ── Cron helpers ──────────────────────────────────────────────────────────

  async createMonthlySalaries(month: string) {
    // Create PENDING salary for HR and ACCOUNTANT
    const employees = await this.db.db.query.users.findMany({
      where: or(eq(users.role, 'HR'), eq(users.role, 'ACCOUNTANT')),
    })

    // Find the admin who creates (Maksym by default)
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

      await this.db.db.insert(transactions).values({
        type: 'SALARY',
        status: 'PENDING',
        amount: emp.monthlySalary,
        currency: 'USD',
        senderId: admin.id,
        senderLabel: 'CheekyCheeseIT',
        receiverId: emp.id,
        salaryMonth: month,
        createdBy: admin.id,
      })
    }

    // Create LOCKED salary for JUNIORs on active projects
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

      // Check if project already has a validated income this month → PENDING, else LOCKED
      const currentMonthStart = new Date(`${month}-01`)
      const nextMonthStart = new Date(currentMonthStart)
      nextMonthStart.setMonth(nextMonthStart.getMonth() + 1)

      // Drop role - phase 2 (AC5): drop-projects unlock junior salary on a
      // validated DROP_INCOME as well — the income side is what matters for
      // the unlock, not whether the wallet is a SENIOR or a DROP.
      const hasValidatedIncome = await this.db.db.query.transactions.findFirst({
        where: and(
          or(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.type, 'DROP_INCOME')),
          eq(transactions.projectId, project.id),
          eq(transactions.status, 'VALIDATED'),
        ),
      })

      // Resolve salary: project override → user default
      const salaryAmount = project.financeSettings?.juniorSalaryOverride ?? user.monthlySalary
      if (!salaryAmount) continue

      await this.db.db.insert(transactions).values({
        type: 'SALARY',
        status: hasValidatedIncome ? 'PENDING' : 'LOCKED',
        amount: String(salaryAmount),
        currency: 'USD',
        senderId: admin.id,
        senderLabel: 'CheekyCheeseIT',
        receiverId: user.id,
        projectId: project.id,
        salaryMonth: month,
        createdBy: admin.id,
      })
    }
  }

  // Unlock LOCKED junior salary when a senior OR drop income is validated.
  // Drop role - phase 2 (AC5): the trigger condition is "any validated income
  // on the project" — caller passes the validated row (SENIOR_INCOME or
  // DROP_INCOME) and we flip the LOCKED salary for the active junior.
  private async unlockJuniorSalaryForProject(projectId: string | null, incomeTx: Transaction) {
    if (!projectId) return

    const month = incomeTx.createdAt.toISOString().slice(0, 7)

    // Find the active junior on this project
    const activeMember = await this.db.db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), isNull(projectMembers.leftAt)),
      with: { user: true },
    })

    const juniorUser = (
      activeMember as (typeof activeMember & { user: typeof users.$inferSelect | null }) | undefined
    )?.user
    if (!juniorUser || juniorUser.role !== 'JUNIOR') return

    await this.db.db
      .update(transactions)
      .set({
        status: 'PENDING',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, juniorUser.id),
          eq(transactions.salaryMonth, month),
          eq(transactions.status, 'LOCKED'),
        ),
      )
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
