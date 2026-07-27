import { AnimatePresence } from 'framer-motion'
import type { AdminActiveTransaction, TransactionDto } from '@crm/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { TransactionRow } from './TransactionRow'

/**
 * ActiveTransactionsTable — the «Активные транзакции» panel body shared between
 * the finance-style listing and the ADMIN dashboard. It REUSES the exact finance
 * `TransactionRow` (same TypeBadge / StatusBadge / FromTo / amount / date markup)
 * and the same `<table>/<thead>` column set as the finance page, so dashboard
 * rows look pixel-identical to finance rows — no duplicated row markup.
 *
 * It accepts the SLIM `AdminActiveTransaction` shape from GET /api/admin/summary
 * and adapts each item into the `TransactionDto` contract `TransactionRow`
 * expects.
 *
 * UT-feedback (PR #280): the inline action buttons now open the SAME finance pay
 * dialogs ON the dashboard (the parent mounts SettleSeniorPayoutDialog /
 * ConfirmPayoutDialog / PaySalaryDialog and passes their open-handlers here),
 * instead of routing to /finance. The handlers receive the adapted
 * `TransactionDto` (incl. `id` + `payoutRequestId`) the dialogs operate on. All
 * handlers are optional — omit them for a purely read-only table.
 */

/**
 * Adapt an `AdminActiveTransaction` into the `TransactionDto` shape consumed by
 * `TransactionRow`. Only the fields the row reads for these (active) statuses are
 * meaningful — everything else is filled with safe null/empty defaults so the
 * row renders identically without inventing data. `type` / `status` / `currency`
 * already share the SAME finance Zod enums (`transactionType` / `transactionStatus`
 * / `currencyEnum`), so they assign straight through with no cast — and the real
 * transaction currency is shown identically to the Финансы page.
 */
function toTransactionDto(t: AdminActiveTransaction): TransactionDto {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    amount: t.amount,
    currency: t.currency,
    // Pass the real party ids + resolved names straight through so the shared
    // `FromTo` renders a clickable participant (e.g. SENIOR_PENDING_PAYOUT /
    // DROP_INCOME) instead of «—», identical to the Финансы page.
    senderId: t.senderId,
    senderLabel: t.senderLabel,
    senderName: t.senderName,
    receiverId: t.receiverId,
    receiverLabel: t.receiverLabel,
    receiverName: t.receiverName,
    projectId: t.projectId,
    projectName: t.projectName,
    // Carried through from the summary projection so ConfirmPayoutDialog's
    // COMPANY_ACCOUNT branch (which confirms off the payout REQUEST id, not the
    // tx id) works identically to the Финансы page when opened on the dashboard.
    payoutRequestId: t.payoutRequestId,
    payoutRequest: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    txFromAddress: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: t.txDate,
    recipientId: null,
    // `TransactionDto.createdBy` (and `validatedBy` above) are nullable
    // identity-masked audit UUIDs (security review PR #384/#385) — NEITHER is
    // part of the slim `AdminActiveTransaction` payload and `TransactionRow`
    // never reads them for these read-only dashboard rows. `validatedBy` is set
    // to null above; `createdBy` uses a nil-UUID placeholder — a valid
    // uuid-shaped value (unlike empty string which fails uuid format); the row
    // never renders or routes on createdBy so the value is opaque.
    createdBy: '00000000-0000-0000-0000-000000000000',
    createdAt: t.txDate,
    updatedAt: t.txDate,
  }
}

type ActiveTransactionsTableProps = {
  transactions: AdminActiveTransaction[]
  loading: boolean
  /**
   * Optional row-body click handler (opens a detail view). The admin dashboard
   * no longer passes this — interactions happen through the explicit action
   * buttons below — but it's kept for any read-only consumer that wants a
   * row-click affordance.
   */
  onRowClick?: (tx: TransactionDto) => void
  /**
   * «Подтвердить оплату» on a PAYOUT row (PENDING_PAYMENT). The dashboard opens
   * the reused ConfirmPayoutDialog with this tx.
   */
  onConfirmPayout?: (tx: TransactionDto) => void
  /**
   * «Выплатить» on a SENIOR_PENDING_PAYOUT row (PENDING_PAYMENT). The dashboard
   * opens the reused SettleSeniorPayoutDialog with this tx.
   */
  onSettleSeniorPayout?: (tx: TransactionDto) => void
  /**
   * «Выплатить» on a SALARY row (PENDING). The dashboard opens the reused
   * PaySalaryDialog with this tx.
   */
  onPaySalary?: (tx: TransactionDto) => void
  emptyMessage?: string
}

export function ActiveTransactionsTable({
  transactions,
  loading,
  onRowClick,
  onConfirmPayout,
  onSettleSeniorPayout,
  onPaySalary,
  emptyMessage = 'Нет активных транзакций',
}: ActiveTransactionsTableProps) {
  if (loading) {
    return (
      <div className="p-6 space-y-3" data-testid="admin-active-tx-loading">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    )
  }

  if (transactions.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-1 py-12 text-center"
        data-testid="admin-active-tx-empty"
      >
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  const rows = transactions.map(toTransactionDto)

  return (
    <div className="overflow-x-auto" data-testid="admin-active-tx-table">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="py-3 px-4 text-left font-medium">Тип</th>
            <th className="py-3 px-4 text-left font-medium">Участник / Проект</th>
            <th className="py-3 px-4 text-left font-medium">Сумма</th>
            <th className="py-3 px-4 text-left font-medium">Дата</th>
            <th className="py-3 px-4 text-left font-medium">Статус</th>
            <th className="py-3 px-4 text-left font-medium">Действия</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence mode="popLayout" initial={false}>
            {rows.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                role="ADMIN"
                rates={undefined}
                {...(onRowClick ? { onClick: onRowClick } : {})}
                {...(onConfirmPayout ? { onConfirmPayout } : {})}
                {...(onSettleSeniorPayout ? { onSettleSeniorPayout } : {})}
                {...(onPaySalary ? { onPaySalary } : {})}
              />
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}
