import type React from 'react'
import type { FinanceSummaryDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

/**
 * ru-RU plural helper for «N дроп / N дропа / N дропов».
 * Follows standard Russian declension rules:
 *   1, 21, 31… → «дроп»
 *   2-4, 22-24… → «дропа»
 *   5-20, 25-30… → «дропов»
 */
function pluralizeDrops(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'дропов'
  if (mod10 === 1) return 'дроп'
  if (mod10 >= 2 && mod10 <= 4) return 'дропа'
  return 'дропов'
}

export function KpiCard({
  title,
  value,
  icon,
  sub,
  color = 'default',
  className,
}: {
  title: string
  value: string
  icon: React.ReactNode
  sub?: string
  color?: 'default' | 'green' | 'red' | 'blue' | 'yellow' | 'purple'
  /**
   * Optional extra classes on the root Card. The ADMIN dashboard passes
   * `h-full` so a KPI whose title wraps to two lines («Проектов не оплачено в
   * этом месяце») stays the SAME height as its single-line siblings in an
   * `items-stretch` grid — the value/sub block is pinned to the bottom via the
   * flex column below, so the row reads as one even row of cards.
   */
  className?: string
}) {
  const colorMap = {
    default: 'text-foreground',
    green: 'text-green-500',
    red: 'text-red-500',
    blue: 'text-blue-500',
    yellow: 'text-yellow-500',
    purple: 'text-purple-500',
  }
  return (
    <Card className={cn('flex flex-col', className)}>
      {/* flex-1 lets the content stretch to the card height; the value row sits
          below a wrapping title without changing the card's overall height. */}
      <CardContent className="flex flex-1 items-start justify-between pt-5">
        <div className="flex flex-1 flex-col gap-1">
          <p className="text-xs text-muted-foreground">{title}</p>
          {/* mt-auto pins the value to the bottom so single- and two-line
              titles produce visually aligned value baselines across the row. */}
          <p className={cn('mt-auto text-2xl font-bold tabular-nums', colorMap[color])}>{value}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div className="ml-3 shrink-0 rounded-lg bg-muted p-2 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  )
}

/**
 * Drop role - phase 2. Standalone «Балансы дропов» panel — redesigned in
 * feat/drop-balances-panel: avatar-initial + full name + share% badge +
 * pending badge + balance with status colour + «нет выплат» empty-state.
 */
export function DropBalanceCard({ summary }: { summary: FinanceSummaryDto }) {
  if (!summary.dropBalances?.length) return null
  return (
    <Card className="border-blue-500/20 bg-blue-500/[0.03]" data-testid="drop-balances-card">
      <CardContent className="pt-5 space-y-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-blue-400">Балансы дропов</p>
          <span
            className="text-[10px] font-mono text-muted-foreground"
            data-testid="drop-balances-count"
          >
            {summary.dropBalances.length} {pluralizeDrops(summary.dropBalances.length)}
          </span>
        </div>

        {/* Rows */}
        {summary.dropBalances.map((db, idx) => {
          const initial = db.displayName.charAt(0).toUpperCase()
          const hasBalance = db.balance !== 0
          const balanceColor =
            db.balance > 0
              ? 'text-green-500'
              : db.balance < 0
                ? 'text-red-500'
                : 'text-muted-foreground'

          return (
            <div key={db.userId} data-testid={`drop-balance-row-${db.userId}`}>
              {idx > 0 && <Separator className="my-2.5" />}
              <div className="flex items-center justify-between gap-2">
                {/* Left: avatar + name block */}
                <div className="flex items-center gap-2 min-w-0">
                  {/* Avatar-initial */}
                  <div
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
                  >
                    {initial}
                  </div>
                  {/* Name + sub-label */}
                  <div className="min-w-0">
                    <p
                      className="text-sm font-medium leading-tight"
                      data-testid={`drop-balance-name-${db.userId}`}
                    >
                      {db.displayName}
                    </p>
                    {!hasBalance && (
                      <p className="text-[10px] text-muted-foreground leading-tight">нет выплат</p>
                    )}
                  </div>
                </div>

                {/* Right: badges + amount */}
                <div className="flex items-center gap-2 shrink-0">
                  {/* Share % badge — dropSharePercent is always a number (backend
                      applies DEFAULT_DROP_SHARE_PERCENT fallback, schema non-nullable). */}
                  <span
                    className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-mono text-primary"
                    data-testid={`drop-balance-share-${db.userId}`}
                  >
                    {db.dropSharePercent}%
                  </span>

                  {/* Pending count badge */}
                  {db.pendingCount > 0 && (
                    <span
                      className="rounded border border-amber-500/20 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-mono text-amber-400"
                      data-testid={`drop-balance-pending-${db.userId}`}
                    >
                      {db.pendingCount} ожидают
                    </span>
                  )}

                  {/* Balance amount */}
                  <div className="text-right">
                    <span
                      className={cn('text-sm font-bold tabular-nums', balanceColor)}
                      data-testid={`drop-balance-amount-${db.userId}`}
                    >
                      {hasBalance
                        ? db.balance.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        : '—'}
                    </span>
                    {hasBalance && (
                      <p className="text-[10px] text-muted-foreground leading-tight">USDT</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
