import { useMemo } from 'react'
import { Coins } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { buildAmountLabel, buildPreviewRows, pluralizeProjects } from '../utils/company-share'

/**
 * CompanySharePayoutStrip — quiet yellow-accent CTA strip surfacing
 * validated-but-unpaid company-share income (task-company-share-cta, design
 * spec §4). Rendered above the KPI grid on `SeniorDashboard` and above the
 * transactions table on `/finance` (SENIOR only — see task boundaries §"Только
 * SENIOR").
 *
 * Presentational — receives the already-loaded `['transactions']` array from
 * the caller (both mount sites already query it) instead of fetching its own
 * copy. Returns `null` whenever there is nothing outstanding: zero rows, or
 * the transactions query hasn't resolved yet (avoids an empty→filled flash).
 */
export function CompanySharePayoutStrip({
  transactions,
  isLoading,
  currentUserId,
  userSeniorSharePercent,
  onOpen,
}: {
  transactions: TransactionDto[]
  isLoading: boolean
  currentUserId: string
  userSeniorSharePercent: number | undefined
  onOpen: () => void
}) {
  const outstanding = useMemo(
    () =>
      transactions.filter(
        (t) =>
          t.type === 'SENIOR_INCOME' &&
          t.status === 'VALIDATED' &&
          !t.payoutRequestId &&
          t.receiverId === currentUserId,
      ),
    [transactions, currentUserId],
  )

  const { projectsCount, amountLabel, isMixedCurrency } = useMemo(() => {
    const rows = buildPreviewRows(outstanding, userSeniorSharePercent)
    const byCurrency = new Map<string, number>()
    for (const row of rows) {
      byCurrency.set(row.tx.currency, (byCurrency.get(row.tx.currency) ?? 0) + row.payable)
    }
    const projectIds = new Set(outstanding.map((t) => t.projectId ?? 'unassigned'))
    return {
      projectsCount: projectIds.size,
      amountLabel: buildAmountLabel(byCurrency),
      isMixedCurrency: byCurrency.size > 1,
    }
  }, [outstanding, userSeniorSharePercent])

  if (isLoading || outstanding.length === 0) return null

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="company-share-cta-strip"
      className="flex w-full min-h-11 flex-wrap items-center gap-3 rounded-lg border border-primary/25 bg-primary/8 px-4 py-3 text-left transition-colors hover:bg-primary/12"
    >
      <span className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Coins className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Доля CheekyCheeseIT к оплате</span>
          <Badge
            variant="outline"
            className="rounded-full border-orange-500/30 bg-orange-500/15 text-orange-400"
          >
            {projectsCount} {pluralizeProjects(projectsCount)}
          </Badge>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {isMixedCurrency
            ? 'Несколько валют — точная сумма в модалке'
            : 'По проверенным приходам, ещё не включённым в заявку на выплату'}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3 max-[479px]:w-full">
        <span
          className="text-[17px] font-bold tabular-nums text-primary"
          data-testid="company-share-cta-amount"
        >
          {amountLabel}
        </span>
        <span className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground max-[479px]:flex-1">
          Оплатить
        </span>
      </span>
    </button>
  )
}
