import { api } from '@/lib/axios'
import type {
  FinanceSummaryDto,
  TransactionDto,
  PayoutRequestDto,
  CreateAdminIncomeDto,
  CreateSeniorIncomeDto,
  CreateDropIncomeDto,
  CreateExpenseDto,
  CreateSalaryDto,
  CreateAdminTransferDto,
  ValidateTransactionDto,
  UpdateSeniorIncomeDto,
  CreatePayoutRequestDto,
  PayPayoutRequestDto,
  PaySalaryDto,
  AdminUpdateTransactionDto,
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

  paySalary: (id: string, data: PaySalaryDto) =>
    api.patch<TransactionDto>(`/transactions/${id}/pay`, data).then((r) => r.data),

  adminUpdateTransaction: (id: string, data: AdminUpdateTransactionDto) =>
    api.patch<TransactionDto>(`/transactions/${id}/admin-edit`, data).then((r) => r.data),

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

  // Summary
  getSummary: () => api.get<FinanceSummaryDto>('/finance/summary').then((r) => r.data),

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
}
