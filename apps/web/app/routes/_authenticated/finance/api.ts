import { api } from '@/lib/axios'
import { incomeComplianceOverviewSchema, type IncomeComplianceOverviewDto } from '@crm/shared'
import type {
  FinanceSummaryDto,
  TransactionDto,
  PayoutRequestDto,
  CreateAdminIncomeDto,
  CreateSeniorIncomeDto,
  CreateDropIncomeDto,
  CreateUsdtIncomeDto,
  CreateExpenseDto,
  CreateSalaryDto,
  CreateAdminTransferDto,
  ValidateTransactionDto,
  UpdateSeniorIncomeDto,
  CreatePayoutRequestDto,
  PayPayoutRequestDto,
  ManualConfirmPayoutDto,
  PaySalaryDto,
  AdminUpdateTransactionDto,
  ConfirmPayoutDto,
  BalanceDto,
  SettleObligationResponseDto,
  SettleSeniorPayoutDto,
  CompanyAccountDto,
  CompanyDepositDto,
  DepositStatusDto,
  CreateCompanyDepositDto,
  CreateDividendDto,
  UpdateWalletDto,
  UpdateRequisitesDto,
  AttachReceiptDto,
} from '@crm/shared'

export const financeApi = {
  // Transactions
  getTransactions: (params?: Record<string, string>) =>
    api.get<TransactionDto[]>('/transactions', { params }).then((r) => r.data),

  getTransaction: (id: string) =>
    api.get<TransactionDto>(`/transactions/${id}`).then((r) => r.data),

  createAdminIncome: (data: CreateAdminIncomeDto) =>
    api.post<TransactionDto>('/transactions/admin-income', data).then((r) => r.data),

  createSeniorIncome: (data: CreateSeniorIncomeDto) =>
    api.post<TransactionDto>('/transactions/senior-income', data).then((r) => r.data),

  // Drop role - phase 2. DROP user registers project income; same flow as
  // senior-income but goes to a separate endpoint that enforces the
  // `project.dropId === caller.id` invariant.
  createDropIncome: (data: CreateDropIncomeDto) =>
    api.post<TransactionDto>('/transactions/drop-income', data).then((r) => r.data),

  // task-drop-share-override-and-receiver (Surface B / D3). ADMIN-only
  // declaration of USDT project income on a USDT-payment project; the gross
  // lands on the chosen receiver (an ADMIN or the shared company pool) and the
  // company atomically books obligations to the project's senior/drop.
  declareUsdtProjectIncome: (data: CreateUsdtIncomeDto) =>
    api.post<TransactionDto>('/finance/usdt-income', data).then((r) => r.data),

  updateSeniorIncome: (id: string, data: UpdateSeniorIncomeDto) =>
    api.patch<TransactionDto>(`/transactions/senior-income/${id}`, data).then((r) => r.data),

  createExpense: (data: CreateExpenseDto) =>
    api.post<TransactionDto>('/transactions/expense', data).then((r) => r.data),

  createSalary: (data: CreateSalaryDto) =>
    api.post<TransactionDto>('/transactions/salary', data).then((r) => r.data),

  createAdminTransfer: (data: CreateAdminTransferDto) =>
    api.post<TransactionDto>('/transactions/admin-transfer', data).then((r) => r.data),

  validateTransaction: (id: string, data: ValidateTransactionDto) =>
    api.patch<TransactionDto>(`/transactions/${id}/validate`, data).then((r) => r.data),

  // Drop role - phase 3 (manual payout confirmation, spec §8.4). ADMIN /
  // ACCOUNTANT confirm that an off-platform PAYOUT actually arrived to one of
  // the admin partners. Backend atomically flips PAYOUT → PAID and inserts a
  // PAYOUT_CONFIRMED row crediting the chosen admin.
  confirmPayout: (id: string, data: ConfirmPayoutDto) =>
    api
      .post<{
        payout: TransactionDto
        confirmed: TransactionDto | null
      }>(`/transactions/${id}/confirm-payout`, data)
      .then((r) => r.data),

  paySalary: (id: string, data: PaySalaryDto) =>
    api.patch<TransactionDto>(`/transactions/${id}/pay`, data).then((r) => r.data),

  adminUpdateTransaction: (id: string, data: AdminUpdateTransactionDto) =>
    api.patch<TransactionDto>(`/transactions/${id}/admin-edit`, data).then((r) => r.data),

  // task-receipts-frontend. Generic attach/replace-receipt endpoint — used by
  // `AttachReceiptSheet` (row icon + detail-dialog entry points). RBAC/status
  // rules are enforced server-side (see `receipt-permissions.ts` for the
  // matching UI-level gate).
  attachReceipt: (id: string, data: AttachReceiptDto) =>
    api.patch<TransactionDto>(`/transactions/${id}/receipt`, data).then((r) => r.data),

  deleteTransaction: (id: string) =>
    api.delete<{ deleted: boolean }>(`/transactions/${id}`).then((r) => r.data),

  // Payout requests
  getPayoutRequests: () => api.get<PayoutRequestDto[]>('/payout-requests').then((r) => r.data),

  getPayoutRequest: (id: string) =>
    api.get<PayoutRequestDto>(`/payout-requests/${id}`).then((r) => r.data),

  createPayoutRequest: (data: CreatePayoutRequestDto) =>
    api.post<PayoutRequestDto>('/payout-requests', data).then((r) => r.data),

  payPayoutRequest: (id: string, data: PayPayoutRequestDto) =>
    api.patch<PayoutRequestDto>(`/payout-requests/${id}/pay`, data).then((r) => r.data),

  // Phase 8 v2 — manual payout confirmation (ADMIN/ACCOUNTANT). Escape hatch for
  // payouts settled OFF the on-chain happy path. The chosen `method`
  // (CASH | ADMIN_USDT | COMPANY_ACCOUNT) decides whether the company balance
  // moves — only COMPANY_ACCOUNT credits it. RBAC enforced server-side (403 for
  // SENIOR/DROP/JUNIOR/HR). NOTE: this is the NEW endpoint — distinct from
  // `confirmPayout` (drop-phase-3 admin-partner flow on /transactions/:id).
  manualConfirmPayout: (id: string, data: ManualConfirmPayoutDto) =>
    api.post<PayoutRequestDto>(`/payout-requests/${id}/manual-confirm`, data).then((r) => r.data),

  // Summary
  getSummary: () => api.get<FinanceSummaryDto>('/finance/summary').then((r) => r.data),

  // «Контроль приходов» (task-income-compliance) — ADMIN + ACCOUNTANT only.
  // Company-wide overview of which income receivers have / have not registered a
  // counted (VALIDATED|PAID) income per active project for the target month.
  // Response is Zod-validated (`.parse`) — the endpoint sits behind an RBAC gate,
  // so a non-privileged caller never reaches it (and would 403).
  getIncomeCompliance: (month?: string): Promise<IncomeComplianceOverviewDto> =>
    api
      .get('/finance/income-compliance', {
        ...(month !== undefined && { params: { month } }),
      })
      .then((r) => incomeComplianceOverviewSchema.parse(r.data)),

  // NBU exchange rate (date = YYYYMMDD, optional)
  getExchangeRate: (date?: string) =>
    api
      .get<{
        usdUah: string
        usdtUah: string
        eurUah: string
        date: string
      }>('/finance/exchange-rate', { ...(date !== undefined && { params: { date } }) })
      .then((r) => r.data),

  // Phase 4 balances (BalanceService — runs alongside legacy getSummary).
  // TOV balance endpoint removed in the refactor — see
  // task-drop-phase4-refactor-remove-tov.md AC3, AC5.
  getAdminBalance: (adminId: string, currency?: string) =>
    api
      .get<BalanceDto>(`/balances/admin/${adminId}`, {
        ...(currency !== undefined && { params: { currency } }),
      })
      .then((r) => r.data),
  getSeniorBalance: (seniorId: string, currency?: string) =>
    api
      .get<BalanceDto>(`/balances/senior/${seniorId}`, {
        ...(currency !== undefined && { params: { currency } }),
      })
      .then((r) => r.data),

  // task-senior-settle-in-tx-row. Senior IOUs from drop-projects are owed by the
  // company and paid directly from the SENIOR_PENDING_PAYOUT row in the
  // transactions list (no dedicated card). The row knows the SENIOR_PENDING_PAYOUT
  // transaction id; the backend resolves the linked pending_obligation and runs
  // the same idempotent, ADMIN/ACCOUNTANT-only settleByCompany cascade. The old
  // `listSeniorPendingSettlements` / `listCompanyPendingSettlements` /
  // `settleObligationByCompany` (obligation-id) wrappers were removed with the
  // settlement cards.
  // task-senior-settle-owner: the body now carries the pay-time funding choice
  // (mirrors paySalary) — COMPANY_ACCOUNT (default, USDT) or ADMIN_PERSONAL with
  // the paying admin + currency. The backend resolves the linked pending
  // obligation and runs the idempotent, ADMIN/ACCOUNTANT-only settle cascade.
  settleSeniorPayoutFromTransaction: (sourceTransactionId: string, data: SettleSeniorPayoutDto) =>
    api
      .post<SettleObligationResponseDto>(
        `/pending-settlements/by-source-transaction/${sourceTransactionId}/settle-company`,
        data,
      )
      .then((r) => r.data),
}

// task-company-account-frontend — Company USDT account (Phase 8). Wraps the
// #249 backend: account/balance, deposit submit + status polling, dividends,
// wallet config. RBAC is enforced server-side (403 for unauthorized callers).
export const companyAccountApi = {
  getAccount: () => api.get<CompanyAccountDto>('/company-account').then((r) => r.data),

  submitDeposit: (data: CreateCompanyDepositDto) =>
    api.post<CompanyDepositDto>('/company-account/deposits', data).then((r) => r.data),

  getDepositStatus: (id: string) =>
    api.get<DepositStatusDto>(`/company-account/deposits/${id}/status`).then((r) => r.data),

  createDividend: (data: CreateDividendDto) =>
    api
      .post<{ id: string; amount: number; receiverId: string }>('/company-account/dividends', data)
      .then((r) => r.data),

  updateWallet: (data: UpdateWalletDto) =>
    api.patch<CompanyAccountDto>('/company-account/wallet', data).then((r) => r.data),

  // ADMIN-only — company requisites markdown auto-appended to NEW contracts.
  updateRequisites: (data: UpdateRequisitesDto) =>
    api.patch<CompanyAccountDto>('/company-account/requisites', data).then((r) => r.data),
}
