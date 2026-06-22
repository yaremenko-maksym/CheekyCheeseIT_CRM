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
 * expects. Action handlers are optional: when omitted (admin dashboard), the row
 * shows no inline action buttons and an `onRowClick` (e.g. navigate to /finance)
 * carries the admin to the full action flow. This keeps the dashboard read-only
 * while leaving the finance page's own behaviour untouched.
 */

/**
 * Map the dashboard payment-rail currency back onto a display currency the
 * shared `fmtUsd` / `fmtAmount` helpers understand:
 *   - USDT_ERC20   → 'USDT'
 *   - BANK_UAH_FOP → 'UAH'
 */
function railToDisplayCurrency(
  currency: AdminActiveTransaction['currency'],
): TransactionDto['currency'] {
  return currency === 'BANK_UAH_FOP' ? 'UAH' : 'USDT'
}

/**
 * Adapt an `AdminActiveTransaction` into the `TransactionDto` shape consumed by
 * `TransactionRow`. Only the fields the row reads for these (active) statuses are
 * meaningful — everything else is filled with safe null/empty defaults so the
 * row renders identically without inventing data. Raw `type` / `status` strings
 * are passed straight through (they are the same DB enums the row maps to labels).
 */
function toTransactionDto(t: AdminActiveTransaction): TransactionDto {
  return {
    id: t.id,
    type: t.type as TransactionDto['type'],
    status: t.status as TransactionDto['status'],
    amount: t.amount,
    currency: railToDisplayCurrency(t.currency),
    senderId: null,
    senderLabel: t.senderLabel,
    senderName: null,
    receiverId: null,
    receiverLabel: t.receiverLabel,
    receiverName: null,
    projectId: null,
    projectName: t.projectName,
    payoutRequestId: null,
    payoutRequest: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: t.txDate,
    recipientId: null,
    createdBy: '',
    createdAt: t.txDate,
    updatedAt: t.txDate,
  }
}

type ActiveTransactionsTableProps = {
  transactions: AdminActiveTransaction[]
  loading: boolean
  /**
   * Row / action click handler. The admin dashboard passes a navigate-to-finance
   * callback so any interaction routes to the finance page where the full payout
   * flow (dialogs / mutations) lives — the dashboard never re-implements that
   * stack. Wired to BOTH the row click AND the inline «Выплатить» /
   * «Подтвердить оплату» affordances surfaced for PENDING_PAYMENT rows, so a
   * canPay row shows its action button and that button takes the admin to
   * finance to complete it. Optional — omit for a purely static table.
   */
  onRowClick?: (tx: TransactionDto) => void
  emptyMessage?: string
}

export function ActiveTransactionsTable({
  transactions,
  loading,
  onRowClick,
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
                {...(onRowClick
                  ? {
                      onClick: onRowClick,
                      // Surface the row's inline payout affordances for
                      // PENDING_PAYMENT rows and route them to the finance page
                      // (no dialogs re-implemented here). «Подтвердить оплату»
                      // (PAYOUT) and «Выплатить» (SENIOR_PENDING_PAYOUT) both go
                      // through the same navigate callback.
                      onConfirmPayout: onRowClick,
                      onSettleSeniorPayout: onRowClick,
                    }
                  : {})}
              />
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}
