import type { ArchivePendingTransaction } from '@crm/shared'
import { formatAmount } from '@/lib/format-amount'

/**
 * task-archive-pending-modal (AC2/AC8). Shared by every archive-confirmation
 * surface (users list, generic entity dialog, profile-page dialog) — the
 * three existing dialogs render their own role-specific cascade copy, but
 * the "here's what stays hanging" list is identical everywhere, so it lives
 * ONCE here instead of being copy-pasted three times.
 *
 * Renders nothing when there is nothing pending — callers can drop this in
 * unconditionally without an extra `length > 0` check at the call site.
 */
const TYPE_LABEL: Record<ArchivePendingTransaction['type'], string> = {
  SALARY: 'Зарплата',
  SENIOR_INCOME: 'Доход синьора (неоплаченная доля)',
  DROP_INCOME: 'Доход дропа (неоплаченная доля)',
}

function formatPeriod(tx: ArchivePendingTransaction): string {
  if (tx.salaryMonth) return tx.salaryMonth
  if (tx.txDate) return new Date(tx.txDate).toLocaleDateString('ru-RU')
  return '—'
}

export function ArchivePendingTransactionsList({
  transactions,
}: {
  transactions: ArchivePendingTransaction[] | undefined
}) {
  if (!transactions || transactions.length === 0) return null

  return (
    <div
      className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
      data-testid="archive-pending-transactions-warning"
    >
      <p className="text-sm font-medium text-destructive">
        Незакрытые PENDING-транзакции ({transactions.length}) — останутся в системе и останутся
        выплачиваемыми
      </p>
      <ul className="space-y-1.5 text-sm">
        {transactions.map((tx) => (
          <li
            key={tx.id}
            data-testid="archive-pending-transaction-row"
            className="flex items-center justify-between gap-3"
          >
            <span className="text-muted-foreground">
              {TYPE_LABEL[tx.type]} · {formatPeriod(tx)}
            </span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">
              {formatAmount(tx.amount, tx.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
