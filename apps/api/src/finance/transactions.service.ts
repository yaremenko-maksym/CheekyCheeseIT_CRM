import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  forwardRef,
  Inject,
  Optional,
} from '@nestjs/common'

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import type {
  SessionUser,
  DropIncomesQuery,
  DropPaymentDto,
  PaginatedDropIncomes,
  SeniorSummaryDto,
  IncomeComplianceOverviewDto,
  ManualPayoutMethod,
  TransactionAuditLogEntryDto,
  SalaryMonthGapReportDto,
  CascadeEditPreviewResponse,
  CascadePlan,
} from '@crm/shared'
import {
  SALARY_ELIGIBLE_ROLES,
  resolveEditCascade,
  computeCascadeVersion,
  PAID_ROW_LOCKED_FIELD_ERROR_CODES,
  floorAmountAtAccumulator,
  isCascadeAmountEdit,
  amountsDiffer,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  pendingObligations,
  projectFinanceSettings,
  payoutRequests,
  projects,
  salaryMonthInitializations,
  transactions,
  transactionAuditLog,
  users,
} from '../database/schema'
import { assertProjectActive } from '../projects/project-status.util'
import type { DrizzleTx } from '../database/types'
import { uniqueViolationConstraint } from '../database/pg-errors'
import { consumeTxHash } from './onchain-tx'
import { InvoicesService, type InvoiceReissueOutcome } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { NbuCurrencyService } from './nbu-currency.service'
import { EtherscanService } from './etherscan.service'
import { TransactionLifecycleService } from './transaction-lifecycle.service'
import { resolveSeniorShare } from './senior-share-resolver'
import { resolveDropShare, DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'
import { SalaryService } from './salary.service'
import { SummaryService } from './summary.service'
import { TransactionTrashService } from './transaction-trash.service'
import { EditCascadeService } from './edit-cascade.service'
import { DropSelfService } from './drop-self.service'
import { OnChainClaimService } from './onchain-claim.service'
import { PayoutRequestReadService } from './payout-request-read.service'
import { PayoutRequestService } from './payout-request.service'
import { PayoutSettlementService } from './payout-settlement.service'
import { AdminIncomeService } from './admin-income.service'
import { resolveTransactionDate } from './transaction-date.util'
import { findActiveTeamsForUser } from './active-teams.util'
import { resolveSeniorShareSnapshot } from './senior-share-snapshot.util'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { assertReceiptDocumentBindable } from './receipt.util'
import { receiptMandatoryError, selfPayError, transactionAmountError } from '@crm/shared'
// task-admin-income-unified: MONEY_SCALE/roundShareAmount moved to @crm/shared
// so the web pre-submit obligation-preview banner and this service compute the
// exact same rounded share amount — see the module doc in packages/shared.
import { COMPANY_ACCOUNT_LABEL, roundShareAmount } from '@crm/shared'
// Re-exported for backward compatibility: pre-move call sites (e.g.
// admin-income-drop-backfill.integration.spec.ts, task-admin-income-drop-backfill,
// merged independently of this move) still import `roundShareAmount` from this
// file's old local-export surface — same binding as the @crm/shared import
// above, not a second implementation.
export { roundShareAmount }
import { assertTransactionWritable } from './transaction-visibility.util'
// task-drop-payout-currency: extracted to a shared util (was a private
// function here) so pending-settlement.service.ts can apply the SAME
// exchange-rate storability rule when settling a DROP obligation in a
// non-obligation currency — see exchange-rate.util.ts for the full rationale.
import { isStorableExchangeRate } from './exchange-rate.util'
import { isRegistryConflict } from './finance-predicates.util'
import { mapTx, type TxWithRelations } from './transaction-mapper.util'
import { loadTransactionForViewer } from './transaction-read.util'
import {
  computeDropDistribution as computeDropDistributionImpl,
  DEFAULT_SENIOR_SHARE_PERCENT,
} from './drop-distribution.util'

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

// Single source of truth lives in `drop-distribution.util.ts` (T-L2); re-exported
// here for existing importers.
export { DEFAULT_SENIOR_SHARE_PERCENT }

// Single source of truth lives in `salary-roles.const.ts` (T-L8); re-exported
// here for existing importers.
export { CRON_ELIGIBLE_SALARY_ROLES } from './salary-roles.const'

/**
 * SR-M-1 — which stage of an invoice void/re-issue failed, if any. `undefined`
 * (a caller or double that reports nothing) is not a failure: the only
 * failures are the ones someone actually reported.
 */
function invoiceFailureStage(
  outcome: InvoiceReissueOutcome | undefined,
): 'VOID' | 'REISSUE' | null {
  if (outcome === 'VOID_FAILED') return 'VOID'
  if (outcome === 'REISSUE_FAILED') return 'REISSUE'
  return null
}

@Injectable()
export class TransactionsService {
  // Invoice triggers fire on best-effort and only log failures so a hiccup in
  // S3/PDF/notifications never reverts a successful financial transition.
  private readonly logger = new Logger(TransactionsService.name)

  private readonly trash: TransactionTrashService

  private readonly editCascade: EditCascadeService

  private readonly dropSelf: DropSelfService

  private readonly onChainClaim: OnChainClaimService

  private readonly payoutRead: PayoutRequestReadService

  private readonly payoutCreate: PayoutRequestService

  private readonly payoutSettle: PayoutSettlementService

  private readonly adminIncome: AdminIncomeService

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
    // WC-L5a: notification plumbing (task-notification-types-producers, позиция 6:
    // «транзакция добавлена» / «статус транзакции изменился»). Replaces the former
    // `notifications` ctor arg in the SAME position; the collaborator never
    // depends on this class.
    private readonly lifecycle: TransactionLifecycleService,
    // T-L6: db-only salary logic (receiver resolvers, archived-receiver guard,
    // month-gap report). SalaryService never depends on this class.
    private readonly salaryService: SalaryService,
    // T-L8: read-only finance summaries. SummaryService never depends on this class.
    private readonly summaryService: SummaryService,
    // Soft-delete / restore / audit-log read. Optional trailing arg: positional
    // callers that predate it get a collaborator over the same db.
    @Optional() trash?: TransactionTrashService,
    // Edit-cascade core (locks, snapshot, apply, preview). Optional trailing arg
    // for the same reason as `trash`.
    @Optional() editCascade?: EditCascadeService,
    // Self-only DROP read path. Optional trailing arg, same fallback rationale.
    @Optional() dropSelf?: DropSelfService,
    // On-chain claim registry (hash release/inspect, receipt transitions, audit
    // journal). Optional trailing arg, same fallback rationale.
    @Optional() onChainClaim?: OnChainClaimService,
    // Payout-request read path (role-scoped list + masked detail). Optional
    // trailing arg, same fallback rationale.
    @Optional() payoutRead?: PayoutRequestReadService,
    // Payout-request creation (NBU-converted company-wallet payout). Optional
    // trailing arg, same fallback rationale.
    @Optional() payoutCreate?: PayoutRequestService,
    // Payout settlement cascade (on-chain pay + manual confirm). Optional
    // trailing arg, same fallback rationale.
    @Optional() payoutSettle?: PayoutSettlementService,
    // Admin income recording (createAdminIncome / declareUsdtProjectIncome). Optional
    // trailing arg, same fallback rationale.
    @Optional() adminIncome?: AdminIncomeService,
  ) {
    this.trash = trash ?? new TransactionTrashService(db)
    this.editCascade = editCascade ?? new EditCascadeService(db)
    this.dropSelf = dropSelf ?? new DropSelfService(db, nbuCurrency)
    this.onChainClaim = onChainClaim ?? new OnChainClaimService(db)
    this.payoutRead = payoutRead ?? new PayoutRequestReadService(db)
    this.payoutCreate = payoutCreate ?? new PayoutRequestService(db, this.payoutRead, nbuCurrency)
    this.payoutSettle =
      payoutSettle ??
      new PayoutSettlementService(db, this.payoutRead, this.onChainClaim, lifecycle, etherscan)
    this.adminIncome = adminIncome ?? new AdminIncomeService(db, this.onChainClaim, lifecycle)
  }

  /** ADMIN release of a mis-claimed on-chain hash — delegates to OnChainClaimService. */
  releaseOnChainHash(txHash: string, reason: string, currentUser: SessionUser) {
    return this.onChainClaim.releaseOnChainHash(txHash, reason, currentUser)
  }

  /** Read-only view of a hash's registry state — delegates to OnChainClaimService. */
  inspectOnChainHash(txHash: string, currentUser: SessionUser) {
    return this.onChainClaim.inspectOnChainHash(txHash, currentUser)
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
    return resolveSeniorShareSnapshot(this.db.db, project, senior)
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
   * Thin public delegate — the math lives in `drop-distribution.util.ts`
   * (T-L2). Kept as a method so the public surface and the characterization
   * spec (`svc.computeDropDistribution`) are unchanged. Signature identical.
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
    return computeDropDistributionImpl(income, _project, drop, senior)
  }

  /** Self-only DROP summary — delegates to DropSelfService. */
  getDropSelfSummary(currentUser: SessionUser) {
    return this.dropSelf.getDropSelfSummary(currentUser)
  }

  /** Self-only DROP income feed — delegates to DropSelfService. */
  getDropSelfIncomes(
    currentUser: SessionUser,
    query: DropIncomesQuery,
  ): Promise<PaginatedDropIncomes> {
    return this.dropSelf.getDropSelfIncomes(currentUser, query)
  }

  /** Self-only DROP outgoing-payments feed — delegates to DropSelfService. */
  getDropSelfPayments(currentUser: SessionUser): Promise<DropPaymentDto[]> {
    return this.dropSelf.getDropSelfPayments(currentUser)
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

    return result.map((tx) => mapTx(tx, currentUser))
  }

  async findOne(id: string, currentUser: SessionUser) {
    return loadTransactionForViewer(this.db.db, id, currentUser)
  }

  // ── Create ADMIN_INCOME ──────────────────────────────────────────────────

  async createAdminIncome(
    data: Parameters<AdminIncomeService['createAdminIncome']>[0],
    currentUser: SessionUser,
  ) {
    const { id } = await this.adminIncome.createAdminIncome(data, currentUser)
    return this.findOne(id, currentUser)
  }

  // ── Declare admin USDT project income (D3) ───────────────────────────────

  async declareUsdtProjectIncome(
    data: Parameters<AdminIncomeService['declareUsdtProjectIncome']>[0],
    currentUser: SessionUser,
  ) {
    const { id } = await this.adminIncome.declareUsdtProjectIncome(data, currentUser)
    return this.findOne(id, currentUser)
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
    // still cannot read it — `findOne` below re-applies `assertTransactionReadAccess`,
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

    // task-project-draft-status (Д2): fused fetch+status guard.
    const project = assertProjectActive(
      // Stryker disable next-line ObjectLiteral: the `where` SHAPE is unobservable
      // from this file's mocked unit specs — they stub `query.projects.findFirst`
      // to return a canned row regardless of what `where` it is called with (same
      // structural limit `income-compliance.unit.spec.ts` documents for
      // `transactions.findMany`). A gutted `{}` here would fetch an ARBITRARY
      // project instead of `data.projectId`'s — caught by this entry point's own
      // RBAC/ownership integration spec (multiple seeded projects, asserts on the
      // SPECIFIC one), not observable from a mocked unit double.
      await this.db.db.query.projects.findFirst({
        where: eq(projects.id, data.projectId),
        // Stryker disable next-line BooleanLiteral,ObjectLiteral: unobservable from a mocked unit double — this file's mocked specs stub `query.projects.findFirst` to return a canned row with `financeSettings` already populated, regardless of what `with` shape is requested; caught by this entry point's own RBAC/ownership integration spec against real Postgres, same reasoning as the `where`-shape suppression on the line above.
        with: { financeSettings: true },
      }),
    )
    if (project.seniorId !== currentUser.id) {
      throw apiError('FINANCE_INCOME_OWN_PROJECTS_ONLY', HttpStatus.FORBIDDEN)
    }
    // task-drop-share-override-and-receiver (D2). On a USDT-payment project the
    // SENIOR does NOT declare income — only an ADMIN does (via
    // declareUsdtProjectIncome), and the company books the senior share as an
    // obligation. FOP/GIG lifecycle is unchanged.
    if (project.paymentType === 'USDT') {
      throw apiError('FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!senior) throw apiError('SENIOR_NOT_FOUND', HttpStatus.NOT_FOUND)
    // task-archive-pending-modal (AC1): a NEW PENDING accrual must never be
    // minted for an archived person — `JwtAuthGuard` already rejects an
    // archived session, but its role/archived cache has a 60s TTL (see
    // jwt.guard.ts), so a request already in flight when the archive commits
    // can still reach here within that window. Same "creates a NEW
    // entitlement → refuse" rule `createSalary` / `createMonthlySalaries`
    // apply, defense-in-depth over the auth layer's TOCTOU gap.
    if (senior.archivedAt) {
      throw apiError('FINANCE_INCOME_RECEIVER_ARCHIVED', HttpStatus.FORBIDDEN)
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
    const applicableTeams = await findActiveTeamsForUser(this.db.db, currentUser.id)
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
    if (seniorIncomeReceiptErr) throw zodErrorBadRequest(seniorIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
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
          txDate: resolveTransactionDate(data.txDate),
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

    await this.lifecycle.afterTransactionCreated(tx!.id, tx!, currentUser)
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
    // re-applies `assertTransactionReadAccess`, which rejects a DROP who is neither the
    // sender nor the receiver of the replayed row, so a replay of someone
    // else's key still cannot leak that row's data.
    const dropIncomeReplay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'DROP_INCOME'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (dropIncomeReplay) return this.findOne(dropIncomeReplay.id, currentUser)

    // task-project-draft-status (Д2): fused fetch+status guard.
    const project = assertProjectActive(
      // Stryker disable next-line ObjectLiteral: the `where` SHAPE is unobservable
      // from this file's mocked unit specs — they stub `query.projects.findFirst`
      // to return a canned row regardless of what `where` it is called with (same
      // structural limit `income-compliance.unit.spec.ts` documents for
      // `transactions.findMany`). A gutted `{}` here would fetch an ARBITRARY
      // project instead of `data.projectId`'s — caught by this entry point's own
      // RBAC/ownership integration spec (multiple seeded projects, asserts on the
      // SPECIFIC one), not observable from a mocked unit double.
      await this.db.db.query.projects.findFirst({
        where: eq(projects.id, data.projectId),
      }),
    )
    // The drop can only declare income on a drop-project routed through them.
    if (project.dropId !== currentUser.id) {
      throw apiError('FINANCE_NOT_YOUR_DROP_PROJECT', HttpStatus.FORBIDDEN)
    }

    // task-drop-share-override-and-receiver (D2). On a USDT-payment project the
    // DROP/SENIOR do NOT declare income — only an ADMIN does (via
    // declareUsdtProjectIncome), and the company books the drop/senior share as
    // an obligation. FOP/GIG lifecycle is unchanged.
    if (project.paymentType === 'USDT') {
      throw apiError('FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller boundary.
    const dropIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      data.currency,
    )
    if (dropIncomeReceiptErr) throw zodErrorBadRequest(dropIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
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
      throw apiError('FINANCE_INCOME_RECEIVER_ARCHIVED', HttpStatus.FORBIDDEN)
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
          txDate: resolveTransactionDate(data.txDate),
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

    await this.lifecycle.afterTransactionCreated(tx!.id, tx!, currentUser)
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
        throw apiError('FINANCE_TRANSACTION_DELETED_RESTORE_FIRST', HttpStatus.BAD_REQUEST)
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
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    // security-review PR #456 (HIGH-3): a deleted REJECTED income was
    // resubmittable — the resubmit reset status/validator AND hard-deleted the
    // old receipt document BEFORE the final `findOne` 404'd, i.e. the row
    // silently un-deleted itself via a side door. MUST run before the
    // type/status/ownership checks below (same ordering rule as findOne).
    assertTransactionWritable(tx, currentUser)
    if (tx.type !== 'SENIOR_INCOME')
      throw apiError('FINANCE_EDIT_SENIOR_INCOME_ONLY', HttpStatus.BAD_REQUEST)
    if (tx.status !== 'REJECTED')
      throw apiError('FINANCE_EDIT_REJECTED_ONLY', HttpStatus.BAD_REQUEST)
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
      throw apiError('FINANCE_INCOME_RECEIVER_ARCHIVED', HttpStatus.FORBIDDEN)
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
      await assertReceiptDocumentBindable(this.db.db, nextDocId, currentUser)
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
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    // security-review PR #456 (HIGH-3): mirrors updateSeniorIncome — must run
    // before the type/status/ownership checks below.
    assertTransactionWritable(tx, currentUser)
    if (tx.type !== 'DROP_INCOME')
      throw apiError('FINANCE_EDIT_DROP_INCOME_ONLY', HttpStatus.BAD_REQUEST)
    if (tx.status !== 'REJECTED')
      throw apiError('FINANCE_EDIT_REJECTED_ONLY', HttpStatus.BAD_REQUEST)
    if (tx.receiverId !== currentUser.id) throw new ForbiddenException()

    // task-archive-pending-modal (round 2, security MED-1): mirrors the guard
    // just added to updateSeniorIncome — see its comment for the full
    // TOCTOU rationale.
    const dropReceiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (dropReceiver?.archivedAt) {
      throw apiError('FINANCE_INCOME_RECEIVER_ARCHIVED', HttpStatus.FORBIDDEN)
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
      await assertReceiptDocumentBindable(this.db.db, nextDocId, currentUser)
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
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    // security-review PR #456 (HIGH-3): an author or ADMIN/ACCOUNTANT could
    // attach/replace a receipt on a deleted row (and hard-delete the old
    // document in the process) — must run before the RBAC/status checks below.
    assertTransactionWritable(tx, currentUser)

    const isPrivileged = currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT'
    const isAuthor = tx.createdBy === currentUser.id
    if (!isPrivileged && !isAuthor) {
      throw apiError('FINANCE_RECEIPT_ATTACH_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    const hadReceipt = !!tx.receiptDocumentId || !!tx.receiptExternalUrl
    // Replace after PAID → only ADMIN / ACCOUNTANT (the author cannot).
    if (hadReceipt && tx.status === 'PAID' && !isPrivileged) {
      throw apiError('FINANCE_RECEIPT_REPLACE_AFTER_PAID_FORBIDDEN', HttpStatus.FORBIDDEN)
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
    if (receiptErr) throw zodErrorBadRequest(receiptErr)

    // The receipt document must be a RECEIPT owned by the caller — you can only
    // attach a document you uploaded (self-ownership, no cross-owner binding).
    if (nextDocId && nextDocId !== tx.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, nextDocId, currentUser)
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
    const transition = await this.onChainClaim.resolveReceiptHashTransition(tx, nextExtUrl)

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
              await this.onChainClaim.recordReclaimAfterRelease(dbtx, {
                path: 'attachOrReplaceReceipt',
                txHash: transition.claimHash,
                referenceId: id,
                actorId: currentUser.impersonatorId ?? currentUser.id,
              })
            }
          }
          if (transition.staleClaim) {
            await this.onChainClaim.recordReceiptClaimDivergence(dbtx, {
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
      if (isRegistryConflict(err)) {
        throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
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
      /** task-cascade-apply (task 3) — the token `GET :id/edit-preview` returned. */
      cascadeVersion?: string | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    assertTransactionWritable(tx, currentUser)
    // Drop role - phase 3: PAYOUT_CONFIRMED rows are the audit trail of a
    // manual confirmation — editing them in-place would corrupt the link to
    // the originating PAYOUT. Group the prohibition with the existing PAYOUT
    // family so the contract is consistent.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw apiError('FINANCE_EDIT_PAYOUT_FORBIDDEN', HttpStatus.BAD_REQUEST)
    }
    if (tx.payoutRequestId) {
      throw apiError('FINANCE_EDIT_LINKED_TO_PAYOUT_REQUEST_FORBIDDEN', HttpStatus.BAD_REQUEST)
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
    // SR-M-1 / SR-M-2 (review round 4) — ONE condition for all three writers.
    //
    // The floor used to be applied on "an amount was SENT" while the second
    // stored copy and the journal keyed on "the amount CHANGED". On a legacy
    // row whose stored `amount` sits BELOW its accumulator that split was
    // reachable: the edit form always sends full state, so editing a NOTE
    // re-sent the unchanged amount, the floor rewrote `transactions.amount`
    // 100 → 260, and `pending_obligations.amount` stayed at 100 with nothing
    // in the journal — the L3 divergence task 0 exists to close, re-opened
    // silently by the fix for a different finding.
    //
    // Now: floor first, then ask whether the STORED figure moves. Everything
    // downstream keys on `amountToWrite !== undefined`, which is that one
    // answer. The repair direction is the safe one — raising `amount` to what
    // was actually paid makes term 7 debit MORE, never less.
    const requestedFloored =
      data.amount === undefined
        ? undefined
        : floorAmountAtAccumulator(tx.settledAmount, data.amount)
    const amountChanged =
      requestedFloored !== undefined && amountsDiffer(requestedFloored, Number(tx.amount))
    const currencyChanged = data.currency !== undefined && data.currency !== tx.currency
    const salaryMonthChanged = data.salaryMonth !== undefined && data.salaryMonth !== tx.salaryMonth
    // task-soft-delete-and-money-audit (AC5): "receiver" on this endpoint is
    // `category` → `receiverLabel` (see the `.set({ ...receiverLabel: data.category })`
    // below) — the counterparty-facing label an ADMIN edit can change.
    const receiverLabelChanged = data.category !== undefined && data.category !== tx.receiverLabel

    // task-cascade-apply (task 3, AC1) — BIZ-18 is narrowed SURGICALLY: only
    // `amountChanged` leaves this condition. `currency` and `salaryMonth` stay
    // blocked on a PAID row, and each for its own reason:
    //
    //  - CURRENCY: one PAID company-shaped row in a currency other than USDT
    //    makes `assertNoOffCurrencyCompanyRows` throw, and FOUR money gates
    //    hang off it (createExpense / paySalary / settleByCompany /
    //    createDividend). Every payout in the system stops until the row is
    //    fixed. A currency mistake is corrected by a reversing entry plus a
    //    new row, never in place (ADR AC5 §3).
    //  - SALARY MONTH: it keys historical monthly aggregates and invoice/reporting
    //    context; moving a paid salary between months rewrites history and is a
    //    separate, unrelated defect (L11), deliberately not opened here.
    //
    // Lifting all three "заодно" is exactly the failure ADR AC5 §3 predicts:
    // they sit in one condition, so the easy edit takes all three.
    //
    // QA-H-2 (manual QA, HIGH): the text names the CARRIER of the refusal and
    // the remedy, and is the SAME catalog entry the dialog shows proactively —
    // one api-error code in `@crm/shared` (`PAID_ROW_LOCKED_FIELD_ERROR_CODES`),
    // so the screen and the 400 cannot drift apart. It also branches, because the two fields are locked
    // for two unrelated reasons (see the block above) and telling an operator
    // about salary months when they touched a currency is noise.
    if (tx.status === 'PAID' && (currencyChanged || salaryMonthChanged)) {
      throw apiError(
        currencyChanged
          ? PAID_ROW_LOCKED_FIELD_ERROR_CODES.CURRENCY
          : PAID_ROW_LOCKED_FIELD_ERROR_CODES.SALARY_MONTH,
        HttpStatus.BAD_REQUEST,
      )
    }

    // task-cascade-apply (task 3, AC2) — editing the amount of a PAID row is
    // never a bare UPDATE: it moves money that derivative rows were computed
    // from. The operator must have SEEN what it does (`GET :id/edit-preview`)
    // and must hand back the version that preview was built on, so the server
    // can prove the world has not moved since (checked under lock inside the
    // transaction below).
    //
    // Required even when the row has no derivatives at all: the rule is
    // simpler that way, and the token doubles as an optimistic lock on the
    // edited row itself.
    // CR-M-2 — one symbol, asked here and in `getEditCascadePreview`.
    //
    // It compares the RAW request, while `amountChanged` below compares the
    // FLOORED figure, and that difference is deliberate (SR-M-1, review round
    // 5 — the previous version of this comment claimed they were the same, and
    // pointed at a test that did not exist):
    //
    //   - "did the operator ASK for a change?" (raw, here) decides whether
    //     AC13 and the preview token apply;
    //   - "does the STORED figure move?" (floored, `amountChanged`) decides
    //     what actually gets written.
    //
    // They part company on a settled row, where `amount === settled_amount` so
    // every downward request floors straight back: the floored question calls
    // that "no change", skips AC13 and answers with a silent success — on
    // exactly the population AC13 exists to refuse. Measured, not argued:
    // `isCascadeAmountEdit — the two questions genuinely diverge…` in
    // `packages/shared/src/schemas/edit-cascade.spec.ts`.
    //
    // Do NOT "restore consistency" between the two without reading that test.
    const isCascadeEdit =
      data.amount !== undefined &&
      isCascadeAmountEdit({
        status: tx.status,
        storedAmount: Number(tx.amount),
        requestedAmount: data.amount,
      })
    if (isCascadeEdit && !data.cascadeVersion) {
      // task-cascade-preview-ui (task 5) — the tail is now an ACTION, not an
      // apology. PR #610 shortened it to «подтвердить пересчёт пока негде»
      // because the preview screen did not exist yet and naming a step nobody
      // could take is worse than naming none. It exists as of this task
      // (`CascadeImpactPanel` inside `AdminEditTransactionDialog`), so the
      // refusal points at it. The head of the sentence is unchanged on
      // purpose: it is what the two callers' tests match on, and the shortest
      // honest statement of the reason.
      throw apiError('FINANCE_PAID_ROW_AMOUNT_EDIT_NEEDS_PREVIEW', HttpStatus.BAD_REQUEST)
    }
    // SR-M-6 (security-review round 3) — the SAME law AC5/AC7 state for the
    // cascade, stated once and applied on BOTH write paths:
    //
    // > a row's `amount` is never written below its `settled_amount`.
    //
    // The cascade enforced it; this path did not. A row a cascade has reverted
    // sits at `PENDING_PAYMENT`, so `isCascadeEdit` is false, AC13 is never
    // consulted, and both writes below stored whatever figure was typed — an
    // obligation asserting a debt of 100 with 260 already paid, out of which
    // only a repair of the data leads. Not a dead end (the settle refuses a
    // negative remainder rather than paying it), which is why this is MED and
    // not HIGH; but a law that holds on one of two write paths is a
    // coincidence, not a law.
    //
    // On the CASCADE path this is the identity by construction: AC13 refuses
    // the edit outright when the edited row carries an accumulator, so
    // `tx.settledAmount` is NULL there and `floorAmountAtAccumulator` returns
    // the request untouched. Same for the overwhelmingly common never-settled
    // row.
    // ONE value with ONE meaning: the figure to store, or nothing to store.
    // `amountToWrite !== undefined` IS `amountChanged` by construction, so the
    // three write sites below cannot disagree about whether this edit touches
    // money (SR-M-1).
    const amountToWrite = amountChanged ? requestedFloored : undefined
    // No `!== undefined` guard: it is only ever READ under `amountChanged`,
    // which already implies it, and the redundant operand was a mutant no test
    // could kill.
    const flooredByAccumulator = amountToWrite !== data.amount

    // The "is this row's amount our own record?" refusals (AC13) live in
    // `assertEditedRowAmountIsOwnRecord`, called below on the LOCKED snapshot —
    // one of the four predicates (a closed obligation on the row itself) needs
    // a query, and splitting one rule across two places is how the halves
    // drift apart.

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
      await assertReceiptDocumentBindable(this.db.db, nextReceiptDocId, currentUser, {
        expectedOwnerId,
      })
    }

    // ── SECURITY (security-review round 4, MED-F): the SECOND receipt entrance.
    // This endpoint edits `receiptExternalUrl` on an already-PAID crediting row
    // (metadata-only edits are explicitly allowed on PAID rows above), so
    // without this it bypassed the guard `attachOrReplaceReceipt` got in round
    // 3 — re-pointing a credited admin income at a transfer another settlement
    // had already consumed. Same shared rule, same behaviour.
    const transition =
      receiptUrlChanged || receiptDocChanged
        ? await this.onChainClaim.resolveReceiptHashTransition(
            tx,
            receiptPatch.receiptExternalUrl ?? null,
          )
        : { txHashPatch: {}, claimHash: null, staleClaim: false }

    // task-cascade-apply (task 3, AC11) — produced INSIDE the DB transaction,
    // consumed AFTER it commits. `undefined` ⇔ no cascade ran, which is also
    // what gates the invoice re-issue below: one value, one meaning, no
    // separate flag to keep in step.
    let cascadeApplied: { changedDerivativeIds: string[] } | undefined

    try {
      cascadeApplied = await this.db.db.transaction(async (dbtx) => {
        let applied: { changedDerivativeIds: string[] } | undefined
        // task-paid-salary-amount-edit — what the plan (built on the LOCKED
        // snapshot) says about the edited salary's payment fact. Read by the
        // source-row UPDATE and the journal below, never re-derived there:
        // the preview showed exactly this figure.
        let paymentFact: CascadePlan['sourcePaymentFact'] = null
        // task-cascade-apply (task 3, AC2/AC3/AC4-AC7). Runs FIRST inside the
        // transaction: it takes every lock the rest of this callback needs, in
        // the one order that does not invert `settleByCompany`'s, and it
        // refuses BEFORE anything is written.
        if (isCascadeEdit) {
          const snapshot = await this.editCascade.loadCascadeSnapshot(dbtx, id, { forUpdate: true })
          if (!snapshot) {
            throw apiError('FINANCE_TRANSACTION_DELETED_RESTORE_FIRST', HttpStatus.BAD_REQUEST)
          }
          // AC13 — before anything else about the cascade: may this row's
          // amount move at all? Asked FIRST because "this row is not editable"
          // is a different, more fundamental answer than "your preview is
          // stale", and the operator should get the one that is actually true.
          this.editCascade.assertEditedRowAmountIsOwnRecord(snapshot.source, data.amount!)

          // AC2 — re-derive the version from the state we just locked and
          // compare. A MISMATCH means the world moved between the preview and
          // this save (an accountant closed the obligation in another tab), so
          // the operator would be confirming something they were never shown.
          // Refuse and make them look again; a silent recompute IS the
          // preview-vs-fact divergence, just wearing a success response (ADR
          // AC4).
          if (computeCascadeVersion(snapshot) !== data.cascadeVersion) {
            throw apiError('FINANCE_CASCADE_PREVIEW_STALE', HttpStatus.CONFLICT)
          }
          // The server computes the cascade itself. The client's version is an
          // input for comparison, never a plan to execute (ADR AC5 §11).
          const plan = resolveEditCascade(snapshot, { amount: data.amount! })
          paymentFact = plan.sourcePaymentFact ?? null
          applied = await this.editCascade.applyEditCascade(
            dbtx,
            snapshot,
            plan,
            currentUser.impersonatorId ?? currentUser.id,
          )
        }

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
            .set({ amount: String(amountToWrite), updatedAt: new Date() })
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
            ...(amountToWrite !== undefined && { amount: String(amountToWrite) }),
            // task-paid-salary-amount-edit — the obligation at the recorded
            // rate, in the SAME statement as the amount so the pair is never
            // observed half-written. `exchangeRate` / `originalCurrency` are
            // deliberately absent: the rate of a transfer that happened does
            // not change because its figure was mistyped.
            //
            // No `amountToWrite !== undefined` beside it: a non-null
            // `paymentFact` already means the plan saw the stored figure move
            // (`resolveEditCascade` sets it only when `sourceAmountChanged`),
            // on a salary with no accumulator — where the floored comparison
            // `amountChanged` makes is the same comparison. The extra operand
            // was an equivalent mutant, i.e. a second rule saying nothing.
            ...(paymentFact?.recomputed && {
              originalAmount: String(paymentFact.newOriginalAmount),
            }),
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
          // SR-H-1 (security-review round 4) — re-assert the state every
          // decision above was made on.
          //
          // `isCascadeEdit`, `amountChanged` and `requestedFloored` all come
          // from `tx`, read BEFORE this transaction opened, and on the non-cascade
          // path nothing here takes a lock (`settleByCompany` takes all of
          // them). A settle landing in that window used to be overwritten
          // blind, and it cost twice: term 7 would debit the figure just
          // written while a different one actually left the account — an error
          // in the "+" direction when the edit lowers it, feeding straight
          // into `if (amount > balance) throw` — and the edit would land on a
          // now-`PAID` row carrying an accumulator with NO `cascadeVersion`,
          // NO AC13 and NO cascade, which is precisely the "edit the row that
          // closed the obligation" AC13 exists to forbid. The SR-M-6 floor
          // cannot help: `requestedFloored` is computed from `tx.settledAmount`
          // off that same stale row.
          //
          // Binding the status is enough for BOTH, and not by luck:
          // `settled_amount` is only ever written by the flip, and the flip
          // writes the status in the same `.set()`. So "the accumulator moved"
          // cannot happen without "the status moved", and one predicate covers
          // the pair.
          //
          // Same shape as SR-M-1 of round 2 two screens down (scoped WHERE +
          // affected-row count) — the third statement in this file to use it.
          //
          // NOTE: this `.where` was identical on `origin/main`, so the race is
          // older than this branch. It had no money consequence there only
          // because BIZ-18 forbade editing a PAID row's amount at all. This
          // task lifts BIZ-18, so this task is what wakes it — "no worse than
          // before" is not a defence when the change is the activator.
          .where(
            and(
              eq(transactions.id, id),
              isNull(transactions.deletedAt),
              eq(transactions.status, tx.status),
              // SR-L-1 (review round 5) — the ABA remainder of the predicate
              // above. `PENDING → PAID → PENDING` inside the window leaves the
              // status reading exactly what was read, while the accumulator
              // now says money went out. Binding the accumulator itself closes
              // it; the two predicates are not redundant, they cover A→B and
              // A→B→A.
              //
              // `IS NOT DISTINCT FROM` rather than `=` because the value is
              // NULL on a row that has never settled, and `NULL = NULL` is
              // NULL — which would match nothing and break every ordinary
              // edit. Same statement, same column, same reason as
              // `settleByCompany`'s flip (pending-settlement.service.ts).
              sql`${transactions.settledAmount} IS NOT DISTINCT FROM ${tx.settledAmount}::numeric`,
            ),
          )
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          // Two ways to get here now, and the message names both: a message
          // that says only "удалена" sends the operator looking for a deletion
          // that never happened.
          throw apiError('FINANCE_ROW_STATE_CHANGED_WHILE_EDITING', HttpStatus.BAD_REQUEST)
        }

        // Multipart salary: before this feature, the receiver/month unique
        // index itself was cron idempotency. Moving an unpaid salary row to
        // another month therefore automatically freed the old month. The
        // durable marker must preserve that behaviour for legacy/CRON rows or
        // an admin correction would leave a stale marker behind and cron would
        // silently skip the now-empty old month forever.
        //
        // MANUAL parts never own a cron marker, so moving one must not disturb
        // a marker that may belong to an automatic part in the same month.
        if (
          salaryMonthChanged &&
          tx.type === 'SALARY' &&
          tx.receiverId &&
          tx.salaryMonth &&
          data.salaryMonth &&
          tx.salaryOrigin !== 'MANUAL'
        ) {
          const claimedTarget = await dbtx
            .insert(salaryMonthInitializations)
            .values({
              receiverId: tx.receiverId,
              salaryMonth: data.salaryMonth,
              initializedBy: currentUser.impersonatorId ?? currentUser.id,
            })
            .onConflictDoNothing({
              target: [
                salaryMonthInitializations.receiverId,
                salaryMonthInitializations.salaryMonth,
              ],
            })
            .returning({ id: salaryMonthInitializations.id })

          // If the destination was already initialized, another automatic or
          // legacy salary already owns that month. The moved row is now an
          // explicit operator-created extra part; reclassifying it as MANUAL
          // prevents two rows from claiming automatic origin semantics.
          if (claimedTarget.length === 0) {
            await dbtx
              .update(transactions)
              .set({ salaryOrigin: 'MANUAL' })
              .where(eq(transactions.id, id))
          }

          // Keep the old marker only when another raw legacy/CRON row still
          // proves that month was initialized. Deliberately include
          // soft-deleted rows: deleting an automatic salary is an audit event,
          // not permission for cron to resurrect it (same invariant as
          // createMonthlySalaries).
          const [oldAutomaticEvidence] = await dbtx
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                eq(transactions.type, 'SALARY'),
                eq(transactions.receiverId, tx.receiverId),
                eq(transactions.salaryMonth, tx.salaryMonth),
                or(isNull(transactions.salaryOrigin), eq(transactions.salaryOrigin, 'CRON')),
              ),
            )
            .limit(1)

          if (!oldAutomaticEvidence) {
            await dbtx
              .delete(salaryMonthInitializations)
              .where(
                and(
                  eq(salaryMonthInitializations.receiverId, tx.receiverId),
                  eq(salaryMonthInitializations.salaryMonth, tx.salaryMonth),
                ),
              )
          }
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
                amount: {
                  before: tx.amount,
                  // What was actually STORED — recording the typed figure here
                  // when the floor moved it would make the journal describe a
                  // write that never happened.
                  after: String(amountToWrite),
                  // …and what the operator typed, when the two differ. The
                  // floor is silent in the response but must not be silent in
                  // the record (SR-M-6).
                  ...(flooredByAccumulator && { flooredFrom: data.amount }),
                },
              }),
              // task-paid-salary-amount-edit — «старое/новое по всем трём»:
              // amount above, the obligation and the rate here. `recomputed:
              // false` is owner decision 2 (no rate recorded → the obligation
              // is left as it was), and the note makes the resulting
              // disagreement between the three a recorded choice, not a bug.
              // (Non-null only on an amount change — see the UPDATE above.)
              ...(paymentFact && {
                paymentFact: {
                  originalAmount: {
                    before: String(paymentFact.oldOriginalAmount),
                    after: String(paymentFact.newOriginalAmount),
                  },
                  exchangeRate: {
                    before: paymentFact.exchangeRate,
                    after: paymentFact.exchangeRate,
                  },
                  recomputed: paymentFact.recomputed,
                  ...(!paymentFact.recomputed && {
                    note: 'exchange rate not recorded — obligation not recomputed',
                  }),
                },
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
            await this.onChainClaim.recordReclaimAfterRelease(dbtx, {
              path: 'adminUpdateTransaction',
              txHash: transition.claimHash,
              referenceId: id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }
        if (transition.staleClaim) {
          await this.onChainClaim.recordReceiptClaimDivergence(dbtx, {
            path: 'adminUpdateTransaction',
            transactionId: id,
            actorId: currentUser.impersonatorId ?? currentUser.id,
          })
        }

        return applied
      })
    } catch (err) {
      // MED-L (round 5): same as the sibling receipt entrance — a racing claim
      // must surface as a 400, not a 500.
      // MED-Q (round 6): and ONLY a registry conflict may say so. Any unrelated
      // unique violation from the same transaction has nothing to do with a tx
      // hash and must pass through unchanged.
      if (isRegistryConflict(err)) {
        throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
      }
      throw err
    }

    // task-cascade-apply (task 3, AC11) — an amount edit invalidates every
    // invoice built on the old figure. `voidAndReissueInvoiceForAmountEdit`
    // (task 4, PR #600) marks the signed document void and issues a fresh one;
    // this is its first and only caller.
    //
    // OUTSIDE the DB transaction on purpose: that method opens its OWN
    // transaction with `FOR UPDATE`, so calling it from inside this one would
    // self-deadlock. A PDF/S3 hiccup must not undo a cascade that has already
    // committed — so a failure does not throw.
    //
    // SR-M-1 (security-review, PR #721): but it is no longer SILENT either.
    // Before, a failed void left the old, counterparty-signed invoice live
    // (the public QR check still confirmed the old figure) and a failed
    // re-issue left a salary with no invoice forever — both visible only in
    // the server log. Now each failure is a journal line
    // (`INVOICE_REISSUE_FAILED`) and the response carries
    // `invoiceReissueIncomplete`, so the edit is not reported as a clean
    // success. And the repair exists: re-saving a PAID salary whose invoice
    // was voided and never replaced re-issues it (below).
    const actorId = currentUser.impersonatorId ?? currentUser.id
    const failedStages: Array<{ id: string; stage: 'VOID' | 'REISSUE' }> = []
    if (cascadeApplied) {
      for (const reissueId of [id, ...cascadeApplied.changedDerivativeIds]) {
        let outcome: InvoiceReissueOutcome | undefined
        try {
          outcome = await this.invoicesService.voidAndReissueInvoiceForAmountEdit(
            reissueId,
            actorId,
          )
        } catch (invoiceErr) {
          this.logger.error(
            `adminUpdateTransaction: invoice void+reissue failed for transaction=${reissueId}: ${(invoiceErr as Error).message}`,
            (invoiceErr as Error).stack,
          )
          outcome = 'VOID_FAILED'
        }
        const stage = invoiceFailureStage(outcome)
        if (stage) failedStages.push({ id: reissueId, stage })
      }
    } else if (tx.type === 'SALARY' && tx.status === 'PAID') {
      // «Повторное сохранение чинит»: a save that did not move the amount is
      // the operator's way back to an invoice an earlier edit left broken —
      // whether the void failed (the old signed document is still current) or
      // the re-issue did (no document at all). SR-M-3: both stages, so the
      // toast's advice is actionable in either. A salary that never had an
      // invoice is left alone (see the method).
      let outcome: InvoiceReissueOutcome | undefined
      try {
        outcome = await this.invoicesService.reissueSalaryInvoiceIfVoided(id, actorId)
      } catch (invoiceErr) {
        this.logger.error(
          `adminUpdateTransaction: salary invoice repair failed for transaction=${id}: ${(invoiceErr as Error).message}`,
        )
        outcome = 'REISSUE_FAILED'
      }
      const stage = invoiceFailureStage(outcome)
      if (stage) failedStages.push({ id, stage })
    }

    // SR-L-5 (security-review round 2) — fire-and-forget, like every other
    // audit write in this file. The edit itself is already committed: letting
    // a journal failure throw would turn a saved edit into a 500 AND lose the
    // `invoiceReissueIncomplete` flag, which is the one thing that tells the
    // operator to save again.
    for (const failed of failedStages) {
      try {
        await this.db.db.insert(transactionAuditLog).values({
          actorId,
          targetId: failed.id,
          action: 'INVOICE_REISSUE_FAILED',
          metadata: { stage: failed.stage },
        })
      } catch (journalErr) {
        this.logger.error(
          `adminUpdateTransaction: could not journal INVOICE_REISSUE_FAILED for transaction=${failed.id} (stage=${failed.stage}): ${(journalErr as Error).message}`,
        )
      }
    }

    const updatedDto = await this.findOne(id, currentUser)
    if (failedStages.length === 0) return updatedDto
    // COPY-M-6 — «save it again» is true for the EDITED salary's own invoice
    // and false for a derived row, where no repair path exists at all. Asking
    // the invoice service keeps the promise tied to what it will actually do,
    // instead of to which row happened to fail.
    const onlyThisRow = failedStages.every((f) => f.id === id)
    const repairable = onlyThisRow && (await this.canRepairInvoiceQuietly(id))
    return {
      ...updatedDto,
      invoiceReissueIncomplete: repairable ? 'SELF_REPAIRABLE' : 'MANUAL_CHECK',
    }
  }

  /**
   * COPY-M-6 — only ever asked to pick a MESSAGE, on a path where something
   * has already failed. A throw here would replace a saved edit with a 500,
   * so an unanswerable question means «do not promise a repair».
   */
  private async canRepairInvoiceQuietly(id: string): Promise<boolean> {
    try {
      return await this.invoicesService.canRepairSalaryInvoice(id)
    } catch (err) {
      this.logger.error(
        `adminUpdateTransaction: could not determine invoice repairability for transaction=${id}: ${(err as Error).message}`,
      )
      return false
    }
  }

  // ── Edit cascade (lock, snapshot, apply, preview) — delegate to EditCascadeService ──

  /**
   * `GET /transactions/:id/edit-preview`. Read-only; ADMIN only. Implemented by
   * EditCascadeService, delegated here to keep the controller-facing surface.
   */
  async getEditCascadePreview(
    id: string,
    amount: number,
    currentUser: SessionUser,
  ): Promise<CascadeEditPreviewResponse> {
    return this.editCascade.getEditCascadePreview(id, amount, currentUser)
  }

  // ── Admin Delete / Restore / Audit log — delegate to TransactionTrashService ──

  async adminDeleteTransaction(id: string, reason: string, currentUser: SessionUser) {
    return this.trash.adminDeleteTransaction(id, reason, currentUser)
  }

  async restoreTransaction(id: string, reason: string, currentUser: SessionUser) {
    await this.trash.restoreTransactionRow(id, reason, currentUser)
    return this.findOne(id, currentUser)
  }

  async getTransactionAuditLog(
    id: string,
    currentUser: SessionUser,
  ): Promise<TransactionAuditLogEntryDto[]> {
    return this.trash.getTransactionAuditLog(id, currentUser)
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
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    assertTransactionWritable(tx, currentUser)
    // Drop role - phase 2: validate also handles DROP_INCOME with the same
    // shape — flip to VALIDATED + create payout_request + insert placeholder
    // PAYOUT row. The drop-specific distribution math lives in
    // `payPayoutRequest` (drop branch) — at validate time we only book a
    // payable that represents what the wallet owner will transfer off-platform
    // (= income * (1 - share/100), using dropSharePercent for DROP_INCOME).
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'DROP_INCOME') {
      throw apiError('FINANCE_VALIDATE_WRONG_TYPE', HttpStatus.BAD_REQUEST)
    }
    // AC4: idempotency. The action is only valid on PENDING rows — a second
    // click after a successful validate would otherwise create a duplicate
    // PAYOUT row. We throw rather than silently no-op so the UI can show
    // a clear error to the ACCOUNTANT (vs. pretending it worked twice).
    if (tx.status !== 'PENDING')
      throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)

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
          throw apiError('FINANCE_TRANSACTION_DELETED_RESTORE_FIRST', HttpStatus.BAD_REQUEST)
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

      // Позиция 6: получатель дохода ЖДЁТ этого перехода. После коммита —
      // строка уже проверена, и уведомление не может опередить факт.
      await this.lifecycle.notifyTransactionStatusChanged(id, 'VALIDATED', null, currentUser)
    } else {
      if (!rejectionReason)
        throw apiError('FINANCE_REJECTION_REASON_REQUIRED', HttpStatus.BAD_REQUEST)
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
          throw apiError('FINANCE_TRANSACTION_DELETED_RESTORE_FIRST', HttpStatus.BAD_REQUEST)
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

      // Позиция 6: отказ без причины сотруднику бесполезен, а узнать её иначе
      // неоткуда — причина едет в данных записи, а не в её заголовке.
      await this.lifecycle.notifyTransactionStatusChanged(
        id,
        'REJECTED',
        rejectionReason,
        currentUser,
      )
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
    options: { method?: 'CRYPTO' | 'CASH'; txHash?: string | null; txDate?: string | null } = {},
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
      throw apiError('FINANCE_CRYPTO_TX_HASH_TOO_SHORT', HttpStatus.BAD_REQUEST)
    }
    const recordedTxHash = method === 'CRYPTO' ? txHashRaw : null

    const payoutTx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, payoutTxId),
    })
    if (!payoutTx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (payoutTx.type !== 'PAYOUT') {
      throw apiError('FINANCE_CONFIRM_PAYOUT_ONLY', HttpStatus.BAD_REQUEST)
    }
    // Idempotency guard. Once PAYOUT has flipped to PAID a second confirm
    // would either no-op or duplicate the PAYOUT_CONFIRMED row depending on
    // which side races; throw early so the UI can show «уже подтверждено».
    if (payoutTx.status !== 'PENDING_PAYMENT') {
      throw apiError('FINANCE_PAYOUT_NOT_PENDING_PAYMENT', HttpStatus.BAD_REQUEST)
    }
    const payoutSourceDate = (payoutTx.txDate ?? payoutTx.createdAt).toISOString().slice(0, 10)
    if ((options.txDate ?? payoutSourceDate) < payoutSourceDate) {
      throw apiError('FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION', HttpStatus.BAD_REQUEST)
    }

    const recipient = await this.db.db.query.users.findFirst({
      where: eq(users.id, recipientAdminId),
    })
    if (!recipient) throw apiError('FINANCE_RECIPIENT_ADMIN_NOT_FOUND', HttpStatus.BAD_REQUEST)
    if (recipient.role !== 'ADMIN') {
      throw apiError('FINANCE_RECIPIENT_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
    }
    if (recipient.archivedAt) {
      throw apiError('FINANCE_RECIPIENT_ADMIN_ARCHIVED', HttpStatus.BAD_REQUEST)
    }
    // task-sender-receiver-invariant (backlog A-2): defense-in-depth. Not
    // reachable today — `payoutTx.senderId` is the SENIOR/DROP who requested
    // the payout and `recipient` must resolve to an ADMIN, two structurally
    // different roles that can never share an id — but the PAYOUT_CONFIRMED
    // insert below copies `payoutTx.senderId` verbatim, so a future change to
    // either invariant would otherwise surface as an opaque DB CHECK error
    // instead of this clean 400.
    const confirmSelfPayErr = selfPayError(payoutTx.senderId, recipient.id)
    if (confirmSelfPayErr) throw zodErrorBadRequest(confirmSelfPayErr)

    // security-review PR #456 round 2 (MED-3): under impersonation, attribute
    // `validatedBy` (and the note) to the REAL admin/accountant operator, never
    // the impersonated target — same rule `adminDeleteTransaction` and
    // `validateTransaction` already apply to their own `*By` columns. This was
    // the second of the two raw-`currentUser.id` sites the review found
    // (pending-settlement.service.ts's `settleByCompany` was the first).
    const effectiveActorId = currentUser.impersonatorId ?? currentUser.id

    const now = new Date()
    const confirmationTxDate = resolveTransactionDate(options.txDate)
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
          txDate: confirmationTxDate,
          updatedAt: now,
          ...(method === 'CRYPTO' && recordedTxHash ? { txHash: recordedTxHash } : {}),
        })
        .where(and(eq(transactions.id, payoutTxId), eq(transactions.status, 'PENDING_PAYMENT')))
        .returning({ id: transactions.id })

      if (claimed.length === 0) {
        // The row was already confirmed by a concurrent call — bail out before
        // inserting a PAYOUT_CONFIRMED so no double credit occurs.
        throw apiError('FINANCE_PAYOUT_NOT_PENDING_PAYMENT', HttpStatus.BAD_REQUEST)
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
        txDate: confirmationTxDate,
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
    if (expenseReceiptErr) throw zodErrorBadRequest(expenseReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
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
      senderLabel = COMPANY_ACCOUNT_LABEL
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
      txDate: resolveTransactionDate(data.txDate),
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
        const companyBalance = await computeCompanyAccountBalanceFromLedger(dbtx ?? this.db.db)
        if (companyBalance < data.amount) {
          throw apiError('FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS', HttpStatus.BAD_REQUEST)
        }
        const [tx] = await dbtx.insert(transactions).values(values).returning()
        return tx!.id
      })
    } else {
      const [tx] = await this.db.db.insert(transactions).values(values).returning()
      txId = tx!.id
    }

    await this.lifecycle.afterTransactionCreated(txId, values, currentUser)
    return this.findOne(txId, currentUser)
  }

  // ── Create SALARY ─────────────────────────────────────────────────────────

  async createSalary(
    data: {
      receiverId: string
      amount: number
      currency?: string
      salaryMonth: string
      idempotencyKey: string
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

    if (!data.idempotencyKey) {
      throw new BadRequestException('idempotencyKey is required for manual salary creation')
    }

    // One key represents one manual salary-part intent. The public schema
    // requires it, and the DB CHECK below rejects any MANUAL SALARY write that
    // bypasses the controller without one. This read handles sequential replay;
    // the partial unique index closes the concurrent race.
    const replay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'SALARY'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (replay) return this.findOne(replay.id, currentUser)

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    // Defense-in-depth: explicit ADMIN barrier first (security-MED #222).
    // SALARY_ELIGIBLE_ROLES allow-list check follows as the general gate.
    if (receiver.role === 'ADMIN') {
      throw apiError('FINANCE_ADMIN_NO_SALARY', HttpStatus.BAD_REQUEST)
    }
    if (!(SALARY_ELIGIBLE_ROLES as ReadonlyArray<string>).includes(receiver.role)) {
      throw apiError('FINANCE_SALARY_ROLE_NOT_ELIGIBLE', HttpStatus.BAD_REQUEST)
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
      throw apiError('FINANCE_SALARY_RECEIVER_ARCHIVED', HttpStatus.BAD_REQUEST)
    }

    // task-salary-pay-flow: a manually-created salary is a NEUTRAL PENDING
    // reminder — it does NOT pick a funding source, does NOT touch the company
    // balance, and is NOT a debit. The funding source (company account vs admin
    // personal) and the actual payment currency are decided LATER, at pay time
    // (paySalary). senderId/fundingSource stay null until then; the currency is
    // the nominal of the reminder (default USD). No advisory lock / balance gate.
    const currency: 'USDT' | 'USD' | 'EUR' | 'UAH' = (data.currency ?? 'USD') as
      'USDT' | 'USD' | 'EUR' | 'UAH'

    // A SALARY transaction is one concrete salary part. Operators may record
    // several parts for the same employee/month; only the automatic monthly
    // component is idempotent (via salary_month_initializations).
    let tx: typeof transactions.$inferSelect
    try {
      const [created] = await this.db.db
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
          salaryOrigin: 'MANUAL',
          idempotencyKey: data.idempotencyKey,
          notes: data.notes ?? null,
          fundingSource: null,
          txDate: resolveTransactionDate(data.txDate),
          createdBy: currentUser.id,
        })
        .returning()
      tx = created!
    } catch (err) {
      if (uniqueViolationConstraint(err) === 'uq_transactions_salary_idempotency_key') {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'SALARY'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) return this.findOne(committed.id, currentUser)
      }
      throw err
    }

    await this.lifecycle.afterTransactionCreated(tx.id, tx, currentUser)
    return this.findOne(tx.id, currentUser)
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
      throw apiError('FINANCE_TRANSFER_SENDER_ID_REQUIRED', HttpStatus.BAD_REQUEST)
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
        throw apiError('FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
    }

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (receiver.role !== 'ADMIN')
      throw apiError('FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
    // task-sender-receiver-invariant (backlog A-2): friendly 400 BEFORE the
    // DB CHECK (ck_transactions_sender_ne_receiver) would reject the insert
    // below with an opaque constraint-violation error. Shared with every
    // other write path via `selfPayError` — one rule, not five copies.
    // fix-round 2 (COPY-M-12): no third argument — the default coded message
    // (`SENDER_RECEIVER_SAME`, translated through `zodErrorBadRequest` below)
    // replaces the literal `'Cannot transfer to yourself'` this call used to
    // pass, so this refusal reads the SAME sentence in the SAME language as
    // every other self-pay check, instead of an untranslated English literal.
    const transferSelfPayErr = selfPayError(effectiveSenderId, receiver.id)
    if (transferSelfPayErr) throw zodErrorBadRequest(transferSelfPayErr)
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
      throw apiError('FINANCE_TRANSFER_RECEIVER_ARCHIVED', HttpStatus.BAD_REQUEST)
    }

    // task-receipts-backend (#8): mandatory receipt, currency-aware (default
    // USDT → explorer-only). Defense-in-depth over Zod; validate the doc binding
    // for a non-USDT file receipt.
    const transferCurrency = data.currency ?? 'USDT'
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      transferCurrency,
    )
    if (receiptErr) throw zodErrorBadRequest(receiptErr)
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
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
        txDate: resolveTransactionDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    await this.lifecycle.afterTransactionCreated(tx!.id, tx!, currentUser)
    return this.findOne(tx!.id, currentUser)
  }

  // ── Create Payout Request ─────────────────────────────────────────────────

  /** SENIOR/DROP payout creation — delegates to PayoutRequestService. */
  createPayoutRequest(transactionIds: string[], currentUser: SessionUser, txDate?: string | null) {
    return this.payoutCreate.createPayoutRequest(transactionIds, currentUser, txDate)
  }

  // ── Pay / confirm Payout Request — delegates to PayoutSettlementService ───

  /** On-chain payout settlement — delegates to PayoutSettlementService. */
  payPayoutRequest(
    requestId: string,
    txHash: string | undefined,
    currentUser: SessionUser,
    simulateResult?: 'success' | 'error',
    txDate?: string | null,
  ) {
    return this.payoutSettle.payPayoutRequest(
      requestId,
      txHash,
      currentUser,
      simulateResult,
      txDate,
    )
  }

  /** ADMIN/ACCOUNTANT off-chain payout confirmation — delegates to PayoutSettlementService. */
  manualConfirmPayout(
    requestId: string,
    method: ManualPayoutMethod,
    currentUser: SessionUser,
    options: { note?: string | null; txHash?: string | null; txDate?: string | null } = {},
  ) {
    return this.payoutSettle.manualConfirmPayout(requestId, method, currentUser, options)
  }

  // ── Payout Requests ───────────────────────────────────────────────────────

  findPayoutRequests(currentUser: SessionUser) {
    return this.payoutRead.findPayoutRequests(currentUser)
  }

  findPayoutRequest(id: string, currentUser: SessionUser) {
    return this.payoutRead.findPayoutRequest(id, currentUser)
  }

  // ── Finance Summary (stats) — delegates to SummaryService (T-L8) ──────────

  getSummary(currentUser: SessionUser) {
    return this.summaryService.getSummary(currentUser)
  }

  getAccountantSummary(currentUser: SessionUser) {
    return this.summaryService.getAccountantSummary(currentUser)
  }

  getSeniorSummary(currentUser: SessionUser): Promise<SeniorSummaryDto> {
    return this.summaryService.getSeniorSummary(currentUser)
  }

  getIncomeComplianceOverview(
    currentUser: SessionUser,
    month?: string,
  ): Promise<IncomeComplianceOverviewDto> {
    return this.summaryService.getIncomeComplianceOverview(currentUser, month)
  }

  // ── Project Finance Settings ──────────────────────────────────────────────

  async getProjectFinanceSettings(projectId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    // SR-M-3 (security-review round 3, task-project-draft-status):
    // ACCOUNTANT must not see finance settings for a project
    // ProjectsService.assertAccess would already 404 them on directly (a
    // DRAFT/REJECTED project — ACCOUNTANT is neither ADMIN nor an invited
    // approver, see that method's own existence-oracle comment). ADMIN
    // always passes here too, mirroring assertAccess's own ADMIN exemption
    // — an admin legitimately configures finance settings before
    // confirmation (the SAME seniorSharePercentOverride field `create()`
    // already accepts on a still-DRAFT project).
    if (currentUser.role === 'ACCOUNTANT') {
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { status: true },
      })
      if (!project || project.status !== 'ACTIVE') {
        throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      }
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
    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
    // SR-M-3 — same ACCOUNTANT-only status gate as getProjectFinanceSettings
    // above (this method already fetches the full project row for the
    // existence check, so the extra query the read-only sibling needs is
    // not needed here).
    if (currentUser.role === 'ACCOUNTANT' && project.status !== 'ACTIVE') {
      throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
    }

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
      // task-salary-pay-amount: the amount ACTUALLY paid, in `currency`. When
      // omitted the row's own amount is carried over unchanged (legacy
      // behaviour — only the currency LABEL changed). Zod bounds it at the
      // boundary (positive, ≤ MAX_TRANSACTION_AMOUNT).
      paidAmount?: number | undefined
      txDate?: string | null | undefined
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
    if (!tx) throw apiError('FINANCE_TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND)
    assertTransactionWritable(tx, currentUser)
    if (tx.type !== 'SALARY') throw apiError('FINANCE_PAY_SALARY_ONLY', HttpStatus.BAD_REQUEST)
    if (tx.status !== 'PENDING')
      throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)

    // A salary payment can be entered later than it happened, but it cannot
    // predate the salary transaction itself. Keep the comparison at calendar-
    // day granularity because the UI submits a business date (YYYY-MM-DD).
    if (data.txDate) {
      const sourceDate = (tx.txDate ?? tx.createdAt).toISOString().slice(0, 10)
      if (data.txDate < sourceDate) {
        throw apiError('FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION', HttpStatus.BAD_REQUEST)
      }
    }

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
    await this.salaryService.assertSalaryReceiverNotArchived(this.db.db, tx.receiverId)

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
    if (receiptErr) throw zodErrorBadRequest(receiptErr)
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
    }

    // Resolve sender + currency from the pay-time funding choice. The AMOUNT is
    // never converted — only the currency LABEL changes.
    let senderId: string | null
    let senderLabel: string
    let currency: 'USDT' | 'USD' | 'EUR' | 'UAH'

    if (isCompanyFunded) {
      // COMPANY_ACCOUNT: money leaves the shared company USDT account. Force USDT
      // (USDT-only account), no personal sender, labelled with the COMPANY_ACCOUNT_LABEL code.
      currency = 'USDT'
      senderId = null
      senderLabel = COMPANY_ACCOUNT_LABEL
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
        throw apiError('FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
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
    if (paySalarySelfPayErr) throw zodErrorBadRequest(paySalarySelfPayErr)

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
      // task-i18n-stage4-task4: `transactionAmountError` now returns a
      // `zod.<CODE>` key (translated by `ZodExceptionFilter`/`translateZodError`
      // on the Zod-boundary path this same function backs). THIS call site is
      // the one server-side caller that never goes through Zod at all (see the
      // comment above) — without this translation, the raw key would leak into
      // the exception body verbatim instead of readable text.
      //
      // fix-round 2 (CR-M-2): routed through `zodErrorBadRequest` — the SAME
      // helper every other direct-throw call site in this file uses — instead
      // of re-implementing the `zod.<CODE>` → English-fallback lookup a third
      // time by hand. This also upgrades the body to the coded
      // `{ statusCode, code, message }` shape (was a plain string before),
      // which `extractBackendMessage` (`axios-utils.ts`, SR-M-4) now
      // recognizes and translates client-side.
      if (amountError) {
        throw zodErrorBadRequest(amountError)
      }
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

    // task-salary-pay-flow: stamp txDate = the actual payment business date.
    // When legacy callers omit it, resolveTransactionDate preserves the old "now"
    // behaviour; the UI supplies the operator-selected calendar day.
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
      txDate: resolveTransactionDate(data.txDate),
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
          throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)
        }
        const companyBalance = await computeCompanyAccountBalanceFromLedger(dbtx ?? this.db.db)
        if (companyBalance < amount) {
          throw apiError('FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS', HttpStatus.BAD_REQUEST)
        }
        const updated = await dbtx
          .update(transactions)
          .set(paidSet)
          .where(
            and(
              eq(transactions.id, id),
              // Mixed-source race: ADMIN_PERSONAL does not take the company
              // advisory lock. It can flip this same row after the in-lock
              // SELECT above but before this UPDATE. Re-assert PENDING in the
              // write itself so exactly one funding source can win.
              eq(transactions.status, 'PENDING'),
              isNull(transactions.deletedAt),
              // MED-3: archival re-asserted in the write, not only pre-read.
              this.salaryService.salaryReceiverNotArchivedFilter(),
            ),
          )
          .returning({ id: transactions.id })
        if (updated.length === 0) {
          // Zero rows now has two possible causes (a racing delete/pay, or a
          // racing archive). Name the real one instead of guessing. Read through
          // `dbtx` — the transaction still owns a connection here, and going via
          // `this.db.db` would check out a second one (round 3, LOW).
          await this.salaryService.assertSalaryReceiverNotArchived(dbtx, tx.receiverId)
          throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)
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
            this.salaryService.salaryReceiverNotArchivedFilter(),
          ),
        )
        .returning({ id: transactions.id })
      if (flipped.length !== 1) {
        // A concurrent paySalary already flipped this row — or a concurrent
        // archive of the receiver made the guard above reject it. This path runs
        // in no transaction, so the base connection is correct here.
        await this.salaryService.assertSalaryReceiverNotArchived(this.db.db, tx.receiverId)
        throw apiError('FINANCE_TRANSACTION_NOT_PENDING', HttpStatus.BAD_REQUEST)
      }
    }

    // Trigger 2: invoice auto-create for SALARY → PAID transitions. Run AFTER the
    // debit transaction commits (best-effort; must not hold the lock). Reached
    // only when THIS call performed the flip (the ADMIN_PERSONAL guard above and
    // the company-account status re-check both throw on a lost race).
    await this.lifecycle.safeAutoCreateInvoice('SALARY', id)

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
    const hrAccountantReceivers = await this.salaryService.resolveHrAccountantSalaryReceivers()

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

    const createAutomaticSalary = async (values: {
      receiverId: string
      amount: string
      projectId?: string
    }): Promise<string | null> =>
      this.db.db.transaction(async (dbtx) => {
        // Claim the automatic component independently from the salary ledger.
        // Manual parts never touch this marker, so they can coexist with cron.
        const claimed = await dbtx
          .insert(salaryMonthInitializations)
          .values({
            receiverId: values.receiverId,
            salaryMonth: month,
            initializedBy: actorId,
          })
          .onConflictDoNothing({
            target: [salaryMonthInitializations.receiverId, salaryMonthInitializations.salaryMonth],
          })
          .returning({ id: salaryMonthInitializations.id })
        if (!claimed[0]) return null

        // Before this feature salary_origin did not exist. A legacy row for the
        // receiver/month is therefore the automatic component already created.
        // Read the raw table intentionally: a soft-deleted automatic salary must
        // not be resurrected by a later cron run.
        const existingAutomatic = await dbtx.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'SALARY'),
            eq(transactions.receiverId, values.receiverId),
            eq(transactions.salaryMonth, month),
            or(isNull(transactions.salaryOrigin), eq(transactions.salaryOrigin, 'CRON')),
          ),
          columns: { id: true },
        })
        if (existingAutomatic) return null

        const [inserted] = await dbtx
          .insert(transactions)
          .values({
            type: 'SALARY',
            status: 'PENDING',
            amount: values.amount,
            currency: 'USD',
            senderId: null,
            senderLabel: 'CheekyCheeseIT',
            receiverId: values.receiverId,
            ...(values.projectId ? { projectId: values.projectId } : {}),
            salaryMonth: month,
            salaryOrigin: 'CRON',
            fundingSource: null,
            createdBy: actorId,
          })
          .returning({ id: transactions.id })
        return inserted?.id ?? null
      })

    const hrAccountantFailures: string[] = []
    for (const emp of hrAccountantReceivers) {
      try {
        const insertedId = await createAutomaticSalary({
          receiverId: emp.id,
          amount: emp.monthlySalary,
        })
        if (insertedId) {
          await this.lifecycle.afterTransactionCreated(
            insertedId,
            { type: 'SALARY', amount: emp.monthlySalary, currency: 'USD' },
            actor ?? null,
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
    const juniorReceivers = await this.salaryService.resolveJuniorSalaryReceivers()

    const juniorFailures: string[] = []
    for (const jr of juniorReceivers) {
      try {
        const insertedId = await createAutomaticSalary({
          receiverId: jr.id,
          amount: jr.monthlySalary,
          projectId: jr.projectId,
        })
        if (insertedId) {
          await this.lifecycle.afterTransactionCreated(
            insertedId,
            { type: 'SALARY', amount: jr.monthlySalary, currency: 'USD' },
            actor ?? null,
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
   * GET /api/finance/salary-month-gap — thin delegate; the ADMIN + ACCOUNTANT
   * RBAC guard lives WITH the body in `SalaryService.getSalaryMonthGapReport`.
   */
  getSalaryMonthGapReport(
    currentUser: SessionUser,
    month?: string,
  ): Promise<SalaryMonthGapReportDto> {
    return this.salaryService.getSalaryMonthGapReport(currentUser, month)
  }

  /**
   * POST /api/finance/salary-month-backfill — ADMIN only. Dozapolnenie: closes
   * this month's gap for whoever `resolveSalaryMonthGap` (== the cron's own
   * eligibility) says is missing, by re-invoking `createMonthlySalaries` for
   * the EXACT SAME month — no separate insert logic, so the idempotency
   * guarantee (initialization marker + ON CONFLICT DO NOTHING) is inherited verbatim,
   * not re-implemented. Returns the POST-backfill gap so the caller sees
   * immediately whether anything is still missing (e.g. a per-employee DB
   * error the cron's own try/catch already logged).
   */
  async backfillSalaryMonth(
    currentUser: SessionUser,
    month: string,
  ): Promise<SalaryMonthGapReportDto> {
    if (currentUser.role !== 'ADMIN') {
      throw apiError('FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    // security-review HIGH-1: pass the REAL actor — see createMonthlySalaries's
    // docblock for why this differs from the cron's unaudited "any admin" call.
    await this.createMonthlySalaries(month, currentUser)
    return this.salaryService.resolveSalaryMonthGap(month)
  }
}
