import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ArchivePendingTransaction } from '@crm/shared'
import { formatDate, formatMoney } from '@crm/shared'
import { useLocale } from '@/lib/i18n'

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
const TYPE_LABEL_MESSAGES: Record<ArchivePendingTransaction['type'], MessageDescriptor> = {
  SALARY: msg`Зарплата`,
  SENIOR_INCOME: msg`Дохід сеньйора (неоплачена частка)`,
  DROP_INCOME: msg`Дохід дропа (неоплачена частка)`,
}

export function ArchivePendingTransactionsList({
  transactions,
}: {
  transactions: ArchivePendingTransaction[] | undefined
}) {
  const { i18n } = useLingui()
  const locale = useLocale()

  // COPY-M-12 (copy review round 1): `salaryMonth` used to render as the raw
  // `YYYY-MM` string while `txDate` went through `formatDate` — two rows in
  // the same list looked like they came from different systems. Both paths
  // now go through the same `formatDate(..., 'monthYear')` style this PR
  // already introduced for exactly this shape («Травень 2026» / «May 2026»).
  function formatPeriod(tx: ArchivePendingTransaction): string {
    if (tx.salaryMonth) return formatDate(new Date(`${tx.salaryMonth}-01`), locale, 'monthYear')
    if (tx.txDate) return formatDate(tx.txDate, locale)
    return '—'
  }

  if (!transactions || transactions.length === 0) return null

  return (
    <div
      className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
      data-testid="archive-pending-transactions-warning"
    >
      <p className="text-sm font-medium text-destructive">
        <Trans>
          Незакриті транзакції, що чекають виплати ({transactions.length}) — залишаться в системі і
          підлягатимуть виплаті
        </Trans>
      </p>
      <ul className="space-y-1.5 text-sm">
        {transactions.map((tx) => (
          <li
            key={tx.id}
            data-testid="archive-pending-transaction-row"
            className="flex items-center justify-between gap-3"
          >
            <span className="text-muted-foreground">
              {i18n._(TYPE_LABEL_MESSAGES[tx.type])} · {formatPeriod(tx)}
            </span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">
              {/* UX-M-2 (fix-round 2): was `formatAmount(tx.amount, tx.currency)` —
                  hardcoded ru-RU regardless of `locale`, while `formatPeriod`
                  right above it already goes through `formatDate(..., locale)`.
                  `archivePendingTransactionSchema.currency` is `z.string()` (loosely
                  typed at the schema level; the DB constrains actual values to
                  `formatMoney`'s currency union) — cast, not widen the shared helper. */}
              {formatMoney(tx.amount, tx.currency as Parameters<typeof formatMoney>[1], locale)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
