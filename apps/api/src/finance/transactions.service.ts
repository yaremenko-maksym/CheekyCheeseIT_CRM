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

import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
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
import { SALARY_ELIGIBLE_ROLES, COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'
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
  transactionAuditLog,
  users,
  type Transaction,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { InvoicesService } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { NbuCurrencyService, type ExchangeRateResult } from './nbu-currency.service'
import { convertToBase, type BalanceCurrency } from './balance.service'
import { EtherscanService } from './etherscan.service'
import { resolveSeniorShare } from './senior-share-resolver'
import { resolveDropShare, DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'
import { getOwnSalaryStatus } from './salary-status.helper'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { assertReceiptDocumentBindable } from './receipt.util'
import { receiptMandatoryError } from '@crm/shared'

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
 * Scaled-integer constant used throughout money aggregations to avoid JS
 * float accumulation errors (same scale as the write-path in confirmPayout /
 * payPayoutRequest: 1e6, round to int). Single source of truth so the
 * per-drop aggregate helper and `getSummary` agree.
 */
export const MONEY_SCALE = 1_000_000

/**
 * Decimal-safe `income × percent / 100` at the numeric(18,6) precision the
 * amount column persists. Scale to integer minor units, round once, divide back
 * and fix to 6 decimals — avoids IEEE-754 drift so two shares of the same income
 * reconcile against the gross. Shared by `computeDropDistribution` (drop payout)
 * and `bookCompanyObligations` (admin-USDT) so both price shares identically.
 */
export function roundShareAmount(income: number, percent: number): number {
  const incomeMinor = Math.round(income * MONEY_SCALE)
  const shareMinor = Math.round((incomeMinor * percent) / 100)
  return Number((shareMinor / MONEY_SCALE).toFixed(6))
}

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
      senderId: senderMasked ? null : tx.senderId,
      senderLabel: senderMasked ? 'CheekyCheeseIT' : tx.senderLabel,
      senderName: senderMasked ? null : (tx.sender?.displayName ?? null),
      receiverId: receiverMasked ? null : tx.receiverId,
      receiverLabel: receiverMasked ? 'CheekyCheeseIT' : tx.receiverLabel,
      receiverName: receiverMasked ? null : (tx.receiver?.displayName ?? null),
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
  } {
    const paid = allTxs.filter((tx) => tx.status === 'PAID')

    // Audit 2026-06-28 (#4): convert each amount to base (USD) BEFORE scaling so a
    // mixed-currency drop ledger sums coherently. USD/USDT → byte-exact identity.
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

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller
    // boundary. Effective currency = USDT for a company-account income (USDT-only
    // pool) → explorer-only; else the supplied currency → file/url.
    const adminIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      data.fundingSource === 'COMPANY_ACCOUNT' ? 'USDT' : data.currency,
    )
    if (adminIncomeReceiptErr) throw new BadRequestException(adminIncomeReceiptErr)

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
            notes: data.notes ?? null,
            txDate: this.resolveTxDate(data.txDate),
            createdBy: currentUser.id,
          })
          .returning()

        await this.bookCompanyObligations(dbtx, {
          incomeAmount: data.amount,
          projectId: data.projectId,
          createdBy: currentUser.id,
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
    const resolvedDrop = resolveDropShare(
      { dropSharePercentOverride: project.dropSharePercentOverride },
      { dropSharePercent: dropUser?.dropSharePercent },
    )

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
        dropSharePercent: resolvedDrop.value,
        dropSharePercentSource: resolvedDrop.source,
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

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
      await dbtx.update(transactions).set(set).where(eq(transactions.id, txId))
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
    if (tx.type !== 'DROP_INCOME')
      throw new BadRequestException('Can only edit DROP_INCOME transactions')
    if (tx.status !== 'REJECTED')
      throw new BadRequestException('Can only edit REJECTED transactions')
    if (tx.receiverId !== currentUser.id) throw new ForbiddenException()

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

    const action: 'ATTACH' | 'REPLACE' = hadReceipt ? 'REPLACE' : 'ATTACH'
    await this.replaceReceiptAtomic(
      id,
      tx.receiptDocumentId,
      nextDocId,
      { receiptDocumentId: nextDocId, receiptExternalUrl: nextExtUrl, updatedAt: new Date() },
      async (dbtx) => {
        // Audit atomically with the receipt swap.
        await dbtx.insert(transactionAuditLog).values({
          actorId: currentUser.id,
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
    // incoming data.amount is a JS number (e.g. 233304.56). We normalise both to
    // Number(…).toFixed(6) before comparing — identical values round to the same
    // string, genuine changes produce a different string.
    const amountChanged =
      data.amount !== undefined && Number(data.amount).toFixed(6) !== Number(tx.amount).toFixed(6)
    const currencyChanged = data.currency !== undefined && data.currency !== tx.currency
    const salaryMonthChanged = data.salaryMonth !== undefined && data.salaryMonth !== tx.salaryMonth

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
          validatedBy: currentUser.id,
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
    if (receiver.id === effectiveSenderId)
      throw new BadRequestException('Cannot transfer to yourself')

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
   * Shared by BOTH the drop-payout cascade (senior IOU only — the drop is paid
   * directly via PAYOUT_DROP there, so `drop` is omitted) and
   * declareUsdtProjectIncome (both IOUs), so the IOU row shape never drifts.
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
      createdBy: string
      payoutRequestId?: string | null
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
    const { incomeAmount, projectId, createdBy, payoutRequestId, senior, drop } = params
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
          dropSharePercent: drop.shareSnapshot.value,
          dropSharePercentSource: drop.shareSnapshot.source,
          notes: `${notePrefix} — drop IOU (debtor=COMPANY)`,
          createdBy,
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
        (tx) => this.mapTx(tx, currentUser),
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

    // Audit 2026-06-28 (#4): aggregate every money figure in a single base
    // currency (USD). Rows may carry mixed currencies (USDT/USD/EUR/UAH); summing
    // their raw `amount` strings would add apples to oranges. Fetch the NBU
    // snapshot ONCE and convert each row BEFORE the scaled-integer accumulation.
    // USD ⇄ USDT is a byte-exact identity in convertToBase (peg short-circuit),
    // so the prod USDT/USD ledger totals are unchanged to the cent.
    const rates = await this.nbuCurrency.getRates()
    const toBase = (tx: { amount: string; currency: string }): number =>
      convertToBase(parseFloat(tx.amount), tx.currency as BalanceCurrency, 'USD', rates)

    const allTxs = (await this.db.db.query.transactions.findMany({
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
    if (tx.type !== 'SALARY') throw new BadRequestException('Can only pay SALARY transactions')
    if (tx.status !== 'PENDING') throw new BadRequestException('Transaction is not PENDING')

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
      // Audit 2026-06-28 (#11): make the ADMIN_PERSONAL PENDING→PAID flip ATOMIC.
      // The pre-read status check above (line ~3495) is a TOCTOU window — two
      // concurrent paySalary calls both read PENDING and both flip + both fire
      // safeAutoCreateInvoice → a DUPLICATE invoice for one salary. Add the
      // status guard to the UPDATE itself (the COMPANY_ACCOUNT path already
      // serialises via the lock + status re-check) and only fire the invoice when
      // THIS call actually performed the flip (exactly one row updated).
      const flipped = await this.db.db
        .update(transactions)
        .set(paidSet)
        .where(and(eq(transactions.id, id), eq(transactions.status, 'PENDING')))
        .returning({ id: transactions.id })
      if (flipped.length !== 1) {
        // A concurrent paySalary already flipped this row — no second invoice.
        throw new BadRequestException('Transaction is not PENDING')
      }
    }

    // Trigger 2: invoice auto-create for SALARY → PAID transitions. Run AFTER the
    // debit transaction commits (best-effort; must not hold the lock). Reached
    // only when THIS call performed the flip (the ADMIN_PERSONAL guard above and
    // the company-account status re-check both throw on a lost race).
    await this.safeAutoCreateInvoice('SALARY', id)

    return this.findOne(id, currentUser)
  }

  // ── Cron helpers ──────────────────────────────────────────────────────────

  async createMonthlySalaries(month: string) {
    // Create PENDING salary for HR and ACCOUNTANT
    const employees = await this.db.db.query.users.findMany({
      where: or(eq(users.role, 'HR'), eq(users.role, 'ACCOUNTANT')),
    })

    // Find the admin who creates the rows. Used ONLY as `createdBy` for audit —
    // the cron creates neutral PENDING reminders, no money moves until an ADMIN
    // pays each one via paySalary (which picks the funding source).
    //
    // Audit 2026-06-28 (#7): resolve ANY admin (was hardcoded to MAKSYM_ID). On a
    // prod DB whose admin ids differ from the dev seed, the MAKSYM_ID lookup
    // returned undefined → the cron silently returned, creating ZERO salary
    // reminders every month with no signal. If no admin exists at all, log an
    // error so the misconfiguration surfaces instead of failing silently.
    const admin = await this.db.db.query.users.findFirst({
      where: eq(users.role, 'ADMIN'),
    })
    if (!admin) {
      this.logger.error(
        'createMonthlySalaries: no ADMIN user found — cannot create salary reminders (skipping)',
      )
      return
    }

    const hrAccountantFailures: string[] = []
    for (const emp of employees) {
      if (!emp.monthlySalary) continue

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
        await this.db.db
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
            createdBy: admin.id,
          })
          .onConflictDoNothing({
            target: [transactions.receiverId, transactions.salaryMonth],
            // `where` (NOT targetWhere) — drizzle-orm 0.36 onConflictDoNothing emits
            // this as the conflict-target predicate, matching the partial index's
            // WHERE. Must match `uq_transactions_salary_receiver_month` exactly.
            where: sql`${transactions.type} = 'SALARY' AND ${transactions.salaryMonth} IS NOT NULL`,
          })
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

    const juniorFailures: string[] = []
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

      // Resolve salary: project override → user default
      const salaryAmount = project.financeSettings?.juniorSalaryOverride ?? user.monthlySalary
      if (!salaryAmount) continue

      // Audit 2026-06-27 (LOW #5): idempotent, race-free salary creation — see the
      // HR/ACCOUNTANT loop above. ON CONFLICT DO NOTHING against the partial
      // unique index replaces the find-then-insert TOCTOU + N+1 read.
      //
      // MED-1: per-member try/catch — see HR/ACCOUNTANT loop above for rationale.
      try {
        await this.db.db
          .insert(transactions)
          .values({
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
          .onConflictDoNothing({
            target: [transactions.receiverId, transactions.salaryMonth],
            // `where` (NOT targetWhere) — drizzle-orm 0.36 onConflictDoNothing emits
            // this as the conflict-target predicate, matching the partial index's
            // WHERE. Must match `uq_transactions_salary_receiver_month` exactly.
            where: sql`${transactions.type} = 'SALARY' AND ${transactions.salaryMonth} IS NOT NULL`,
          })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(
          `createMonthlySalaries: failed for junior ${user.id} (${user.email}) project=${project.id} month=${month} — ${msg}`,
          err instanceof Error ? err.stack : undefined,
        )
        juniorFailures.push(user.id)
      }
    }
    if (juniorFailures.length > 0) {
      this.logger.error(
        `createMonthlySalaries: ${juniorFailures.length} JUNIOR salary(ies) failed for month=${month}. Failed employee ids: ${juniorFailures.join(', ')}`,
      )
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
