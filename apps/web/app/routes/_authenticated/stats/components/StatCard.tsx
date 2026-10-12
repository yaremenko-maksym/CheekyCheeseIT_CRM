import { HelpCircle, TrendingDown, TrendingUp } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ── KPI card with tooltip ──────────────────────────────────────────────────────

export function StatCard({
  title,
  hint,
  value,
  sub,
  icon,
  color = 'default',
  trend,
  testId,
}: {
  title: string
  hint: string
  value: string
  sub?: string
  icon: React.ReactNode
  color?: 'default' | 'green' | 'red' | 'blue' | 'yellow' | 'purple' | 'cyan'
  trend?: { value: number; label: string }
  testId?: string
}) {
  const colorMap: Record<string, string> = {
    default: 'text-foreground',
    green: 'text-green-500',
    red: 'text-red-500',
    blue: 'text-blue-500',
    yellow: 'text-yellow-500',
    purple: 'text-purple-500',
    cyan: 'text-cyan-500',
  }
  const bgMap: Record<string, string> = {
    default: 'bg-muted',
    green: 'bg-green-500/10',
    red: 'bg-red-500/10',
    blue: 'bg-blue-500/10',
    yellow: 'bg-yellow-500/10',
    purple: 'bg-purple-500/10',
    cyan: 'bg-cyan-500/10',
  }

  return (
    <Card {...(testId ? { 'data-testid': testId } : {})}>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground">{title}</p>
              <TooltipProvider delayDuration={200}>
                <UITooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-56 text-xs leading-relaxed">
                    {hint}
                  </TooltipContent>
                </UITooltip>
              </TooltipProvider>
            </div>
            <p className={cn('text-2xl font-bold tabular-nums', colorMap[color])}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
            {trend && (
              <div
                className={cn(
                  'flex items-center gap-1 text-xs font-medium',
                  trend.value >= 0 ? 'text-green-500' : 'text-red-500',
                )}
              >
                {trend.value >= 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {trend.value >= 0 ? '+' : ''}
                {trend.value.toFixed(1)}% {trend.label}
              </div>
            )}
          </div>
          <div className={cn('rounded-lg p-2 shrink-0', bgMap[color], colorMap[color])}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  )
}
