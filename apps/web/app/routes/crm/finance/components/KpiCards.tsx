import type React from 'react'
import type { FinanceSummaryDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'

export function KpiCard({
  title,
  value,
  icon,
  sub,
  color = 'default',
}: {
  title: string
  value: string
  icon: React.ReactNode
  sub?: string
  color?: 'default' | 'green' | 'red' | 'blue' | 'yellow' | 'purple'
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
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{title}</p>
            <p className={cn('text-2xl font-bold tabular-nums', colorMap[color])}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
          </div>
          <div className="rounded-lg bg-muted p-2 text-muted-foreground">{icon}</div>
        </div>
      </CardContent>
    </Card>
  )
}

export function AdminBalanceCard({ summary }: { summary: FinanceSummaryDto }) {
  if (!summary.adminBalances.length) return null
  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <p className="text-xs font-semibold text-muted-foreground">Балансы партнёров</p>
        {summary.adminBalances.map((ab) => (
          <div key={ab.userId} className="space-y-1">
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-medium">{ab.displayName}</span>
              <span
                className={cn(
                  'text-sm font-bold tabular-nums',
                  ab.balance >= 0 ? 'text-green-500' : 'text-red-500',
                )}
              >
                $
                {ab.balance.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/**
 * Drop role - phase 2. Standalone «Балансы дропов» panel — shows the
 * aggregated PAYOUT_DROP credit-minus-debit balance per DROP user. Hidden
 * entirely when the backend hasn't surfaced any DROP balances (empty array
 * = no drop-projects in the system or no validated drop payouts yet).
 */
export function DropBalanceCard({ summary }: { summary: FinanceSummaryDto }) {
  if (!summary.dropBalances.length) return null
  return (
    <Card className="border-blue-500/20 bg-blue-500/[0.03]" data-testid="drop-balances-card">
      <CardContent className="pt-5 space-y-3">
        <p className="text-xs font-semibold text-blue-400">Балансы дропов</p>
        {summary.dropBalances.map((db) => (
          <div key={db.userId} className="space-y-1">
            <div className="flex justify-between items-baseline">
              <span className="text-sm font-medium">{db.displayName}</span>
              <span
                className={cn(
                  'text-sm font-bold tabular-nums',
                  db.balance >= 0 ? 'text-green-500' : 'text-red-500',
                )}
              >
                $
                {db.balance.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
