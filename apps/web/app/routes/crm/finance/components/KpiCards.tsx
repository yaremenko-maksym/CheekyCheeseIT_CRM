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
              <span className={cn('text-sm font-bold tabular-nums', ab.balance >= 0 ? 'text-green-500' : 'text-red-500')}>
                ${ab.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
