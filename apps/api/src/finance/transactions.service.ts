import { Injectable, forwardRef, Inject, Optional } from '@nestjs/common'

import { desc, isNull } from 'drizzle-orm'
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
import { DatabaseService } from '../database/database.service'
import { transactions } from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { NbuCurrencyService } from './nbu-currency.service'
import { EtherscanService } from './etherscan.service'
import { TransactionLifecycleService } from './transaction-lifecycle.service'
import { DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'
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
import { ProjectFinanceSettingsService } from './project-finance-settings.service'
import { PayoutConfirmationService } from './payout-confirmation.service'
import { SeniorDropIncomeService } from './senior-drop-income.service'
import { IncomeReceiptService } from './income-receipt.service'
import { resolveSeniorShareSnapshot } from './senior-share-snapshot.util'
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

  private readonly projectFinanceSettings: ProjectFinanceSettingsService

  private readonly payoutConfirmation: PayoutConfirmationService

  private readonly seniorDropIncome: SeniorDropIncomeService

  private readonly incomeReceipt: IncomeReceiptService

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
    // Project finance settings (role-gated read + upsert of share overrides). Optional
    // trailing arg, same fallback rationale.
    @Optional() projectFinanceSettings?: ProjectFinanceSettingsService,
    // Income validate / reject + manual payout confirmation. Optional trailing arg,
    // same fallback rationale.
    @Optional() payoutConfirmation?: PayoutConfirmationService,
    // Self-declared SENIOR_INCOME / DROP_INCOME creation. Optional trailing arg,
    // same fallback rationale.
    @Optional() seniorDropIncome?: SeniorDropIncomeService,
    // Income receipt cluster (resubmit REJECTED income, attach/replace receipt).
    // Optional trailing arg, same fallback rationale.
    @Optional() incomeReceipt?: IncomeReceiptService,
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
    this.projectFinanceSettings = projectFinanceSettings ?? new ProjectFinanceSettingsService(db)
    this.payoutConfirmation = payoutConfirmation ?? new PayoutConfirmationService(db, lifecycle)
    this.seniorDropIncome = seniorDropIncome ?? new SeniorDropIncomeService(db, lifecycle)
    this.incomeReceipt =
      incomeReceipt ?? new IncomeReceiptService(db, this.documentsService, this.onChainClaim)
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

  // ── Create SENIOR_INCOME / DROP_INCOME ───────────────────────────────────
  //
  // Logic lives in SeniorDropIncomeService; the facade keeps the public
  // signatures and runs the viewer-scoped `findOne` read-back on the id the
  // collaborator returns (created row or idempotent replay).

  async createSeniorIncome(
    data: Parameters<SeniorDropIncomeService['createSeniorIncome']>[0],
    currentUser: SessionUser,
  ) {
    const { id } = await this.seniorDropIncome.createSeniorIncome(data, currentUser)
    return this.findOne(id, currentUser)
  }

  async createDropIncome(
    data: Parameters<SeniorDropIncomeService['createDropIncome']>[0],
    currentUser: SessionUser,
  ) {
    const { id } = await this.seniorDropIncome.createDropIncome(data, currentUser)
    return this.findOne(id, currentUser)
  }

  // ── Income receipt cluster ───────────────────────────────────────────────
  //
  // Logic lives in IncomeReceiptService; the facade keeps the public signatures
  // and runs the viewer-scoped `findOne` read-back once the collaborator's
  // write has committed.

  async updateSeniorIncome(
    id: string,
    data: Parameters<IncomeReceiptService['updateSeniorIncome']>[1],
    currentUser: SessionUser,
  ) {
    await this.incomeReceipt.updateSeniorIncome(id, data, currentUser)
    return this.findOne(id, currentUser)
  }

  async updateDropIncome(
    id: string,
    data: Parameters<IncomeReceiptService['updateDropIncome']>[1],
    currentUser: SessionUser,
  ) {
    await this.incomeReceipt.updateDropIncome(id, data, currentUser)
    return this.findOne(id, currentUser)
  }

  async attachOrReplaceReceipt(
    id: string,
    data: Parameters<IncomeReceiptService['attachOrReplaceReceipt']>[1],
    currentUser: SessionUser,
  ) {
    await this.incomeReceipt.attachOrReplaceReceipt(id, data, currentUser)
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

  // ── Validate / Reject income + manual payout confirmation — delegate to PayoutConfirmationService ──
  // The collaborator commits the write; the viewer-scoped read-back stays here.

  /** Validate / reject a PENDING SENIOR_INCOME or DROP_INCOME. */
  async validateTransaction(
    id: string,
    action: 'validate' | 'reject',
    rejectionReason: string | null | undefined,
    currentUser: SessionUser,
  ) {
    await this.payoutConfirmation.validateTransaction(id, action, rejectionReason, currentUser)
    return this.findOne(id, currentUser)
  }

  /** ACCOUNTANT/ADMIN confirms a PAYOUT landed on an admin partner off-platform. */
  confirmPayout(
    payoutTxId: string,
    recipientAdminId: string,
    currentUser: SessionUser,
    options: { method?: 'CRYPTO' | 'CASH'; txHash?: string | null; txDate?: string | null } = {},
  ) {
    return this.payoutConfirmation.confirmPayout(
      payoutTxId,
      recipientAdminId,
      currentUser,
      options,
      (txId) => this.findOne(txId, currentUser),
    )
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

  // ── Project Finance Settings — delegates to ProjectFinanceSettingsService ──

  getProjectFinanceSettings(projectId: string, currentUser: SessionUser) {
    return this.projectFinanceSettings.getProjectFinanceSettings(projectId, currentUser)
  }

  upsertProjectFinanceSettings(
    projectId: string,
    data: Parameters<ProjectFinanceSettingsService['upsertProjectFinanceSettings']>[1],
    currentUser: SessionUser,
  ) {
    return this.projectFinanceSettings.upsertProjectFinanceSettings(projectId, data, currentUser)
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
