import type React from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'

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
