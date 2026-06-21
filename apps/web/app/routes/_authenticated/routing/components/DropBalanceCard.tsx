import { ArrowDownCircle, Clock, Percent, Wallet } from 'lucide-react'
import type { DropSelfSummaryDto } from '@crm/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface DropBalanceCardProps {
  summary: DropSelfSummaryDto | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  /** compact — хаб /routing; full — финансы /finance */
  variant?: 'compact' | 'full'
}

function fmtUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function DropBalanceCard({
  summary,
  isLoading,
  isError,
  onRetry,
  variant = 'compact',
}: DropBalanceCardProps) {
  if (isLoading) {
    return <Skeleton className="h-32 w-full rounded-lg" />
  }

  if (isError || !summary) {
    return (
      <Card className="border-border/40 bg-card" data-testid="drop-balance-card">
        <CardContent className="flex flex-col items-center justify-center gap-2 py-8">
          <p className="text-xs text-destructive">Ошибка загрузки баланса</p>
          <Button variant="ghost" size="sm" onClick={onRetry} aria-label="Повторить загрузку">
            Повторить
          </Button>
        </CardContent>
      </Card>
    )
  }

  const { balance, dropSharePercent, pendingIncomesCount, debtToCompany } = summary
  const hasDebt = debtToCompany > 0

  return (
    <TooltipProvider>
      <Card
        className="border-border/40 bg-card"
        data-testid="drop-balance-card"
        aria-label="Мой баланс"
      >
        <CardHeader className="pb-2 pt-4 px-5">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              МОЙ БАЛАНС
            </span>
          </div>
        </CardHeader>

        <CardContent className="px-5 pb-4 space-y-3">
          {/* Main balance figure */}
          <div>
            <p
              className="text-3xl font-bold tabular-nums text-foreground"
              data-testid="drop-balance-amount"
            >
              {fmtUsd(balance)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Накопленная доля</p>
          </div>

          <Separator />

          {/* Metrics row */}
          <div className="flex items-center justify-between gap-2">
            {/* Ставка */}
            <div className="flex flex-col items-center gap-0.5 flex-1">
              <div className="flex items-center gap-1">
                <Percent className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                <span
                  className="text-sm font-semibold tabular-nums"
                  data-testid="drop-balance-share-percent"
                >
                  {dropSharePercent}%
                </span>
              </div>
              <span className="text-xs text-muted-foreground">Ставка</span>
            </div>

            <Separator orientation="vertical" className="h-8" />

            {/* В работе */}
            <div className="flex flex-col items-center gap-0.5 flex-1">
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                <span
                  className="text-sm font-semibold tabular-nums"
                  data-testid="drop-balance-pending-count"
                >
                  {pendingIncomesCount}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">В работе</span>
            </div>

            <Separator orientation="vertical" className="h-8" />

            {/* Долг компании */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex flex-col items-center gap-0.5 flex-1 cursor-default">
                  <div className="flex items-center gap-1">
                    <ArrowDownCircle className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                    <span
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        hasDebt ? 'text-destructive' : 'text-muted-foreground',
                      )}
                      data-testid="drop-balance-debt"
                    >
                      {fmtUsd(debtToCompany)}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">Долг компании</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Доля синьора, которую компания должна выплатить вам
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Full variant: last income row */}
          {variant === 'full' && (
            <>
              <Separator />
              <p className="text-xs text-muted-foreground">
                Расширенная информация доступна в таблице приходов ниже
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  )
}
