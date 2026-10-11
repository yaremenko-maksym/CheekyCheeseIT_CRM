import {
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  forwardRef,
  Inject,
  Optional,
} from '@nestjs/common'

import { and, desc, eq, isNull } from 'drizzle-orm'
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
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  projectFinanceSettings,
  payoutRequests,
  projects,
  transactions,
  transactionAuditLog,
  users,
} from '../database/schema'
import { assertProjectActive } from '../projects/project-status.util'
import type { DrizzleTx } from '../database/types'
import { uniqueViolationConstraint } from '../database/pg-errors'
import { consumeTxHash } from './onchain-tx'
import { InvoicesService } from '../invoices/invoices.service'
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
import { TransactionEntryService } from './transaction-entry.service'
import { SalaryPaymentService } from './salary-payment.service'
import { AdminEditService } from './admin-edit.service'
import { resolveTransactionDate } from './transaction-date.util'
import { findActiveTeamsForUser } from './active-teams.util'
import { resolveSeniorShareSnapshot } from './senior-share-snapshot.util'
import { assertReceiptDocumentBindable } from './receipt.util'
import { receiptMandatoryError, selfPayError } from '@crm/shared'
// task-admin-income-unified: MONEY_SCALE/roundShareAmount moved to @crm/shared
// so the web pre-submit obligation-preview banner and this service compute the
// exact same rounded share amount — see the module doc in packages/shared.
import { roundShareAmount } from '@crm/shared'
// Re-exported for backward compatibility: pre-move call sites (e.g.
// admin-income-drop-backfill.integration.spec.ts, task-admin-income-drop-backfill,
// merged independently of this move) still import `roundShareAmount` from this
// file's old local-export surface — same binding as the @crm/shared import
// above, not a second implementation.
export { roundShareAmount }
import { assertTransactionWritable } from './transaction-visibility.util'
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

  private readonly entry: TransactionEntryService

  private readonly salaryPay: SalaryPaymentService

  private readonly adminEdit: AdminEditService

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
    // Manual entry (createExpense / createSalary / createAdminTransfer). Optional
    // trailing arg, same fallback rationale.
    @Optional() entry?: TransactionEntryService,
    // Salary pay / monthly accrual / month backfill. Optional trailing arg, same
    // fallback rationale.
    @Optional() salaryPay?: SalaryPaymentService,
    // ADMIN transaction edit (BIZ-18 guards, edit cascade, receipt-hash transitions,
    // invoice repair). Optional trailing arg, same fallback rationale.
    @Optional() adminEdit?: AdminEditService,
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
    this.entry = entry ?? new TransactionEntryService(db, lifecycle)
    this.salaryPay = salaryPay ?? new SalaryPaymentService(db, salaryService, lifecycle)
    this.adminEdit =
      adminEdit ??
      new AdminEditService(db, this.onChainClaim, this.editCascade, this.invoicesService)
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
    data: Parameters<AdminEditService['adminUpdateTransaction']>[1],
    currentUser: SessionUser,
  ) {
    const { id: editedId, invoiceReissueIncomplete } = await this.adminEdit.adminUpdateTransaction(
      id,
      data,
      currentUser,
    )
    const updatedDto = await this.findOne(editedId, currentUser)
    return invoiceReissueIncomplete ? { ...updatedDto, invoiceReissueIncomplete } : updatedDto
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

  // ── Create EXPENSE / SALARY / ADMIN_TRANSFER — delegates to TransactionEntryService ──

  /** Manual EXPENSE entry — delegates to TransactionEntryService, then reads back. */
  async createExpense(
    data: Parameters<TransactionEntryService['createExpense']>[0],
    currentUser: SessionUser,
  ) {
    const { id } = await this.entry.createExpense(data, currentUser)
    return this.findOne(id, currentUser)
  }

  /** Manual SALARY entry — delegates to TransactionEntryService, then reads back. */
  async createSalary(
    data: Parameters<TransactionEntryService['createSalary']>[0],
    currentUser: SessionUser,
  ) {
    const { id } = await this.entry.createSalary(data, currentUser)
    return this.findOne(id, currentUser)
  }

  /** Partner ADMIN_TRANSFER entry — delegates to TransactionEntryService, then reads back. */
  async createAdminTransfer(
    data: Parameters<TransactionEntryService['createAdminTransfer']>[0],
    currentUser: SessionUser,
  ) {
    const { id } = await this.entry.createAdminTransfer(data, currentUser)
    return this.findOne(id, currentUser)
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

  // ── Salary pay / accrual / backfill — delegates to SalaryPaymentService ───

  /** Manual salary payment — delegates to SalaryPaymentService, then reads back. */
  async paySalary(
    id: string,
    data: Parameters<SalaryPaymentService['paySalary']>[1],
    currentUser: SessionUser,
  ) {
    const { id: paidId } = await this.salaryPay.paySalary(id, data, currentUser)
    return this.findOne(paidId, currentUser)
  }

  /** Monthly salary accrual (also called by the salary cron) — delegates to SalaryPaymentService. */
  createMonthlySalaries(month: string, actor?: SessionUser) {
    return this.salaryPay.createMonthlySalaries(month, actor)
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

  /** POST /api/finance/salary-month-backfill — delegates to SalaryPaymentService. */
  backfillSalaryMonth(currentUser: SessionUser, month: string): Promise<SalaryMonthGapReportDto> {
    return this.salaryPay.backfillSalaryMonth(currentUser, month)
  }
}
