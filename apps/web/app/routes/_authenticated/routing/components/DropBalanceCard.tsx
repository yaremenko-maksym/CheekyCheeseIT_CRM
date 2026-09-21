import { ArrowDownCircle, Clock, Percent, Wallet } from 'lucide-react'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { DropSelfSummaryDto } from '@crm/shared'
import { formatMoney } from '@crm/shared'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
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

export function DropBalanceCard({
  summary,
  isLoading,
  isError,
  onRetry,
  variant = 'compact',
}: DropBalanceCardProps) {
  const { t } = useLingui()
  const locale = useLocale()
  const fmtUsd = (value: number) => formatMoney(value, 'USD', locale)

  if (isLoading) {
    return <Skeleton className="h-32 w-full rounded-lg" />
  }

  if (isError || !summary) {
    return (
      <Card className="border-border/40 bg-card" data-testid="drop-balance-card">
        <CardContent className="flex flex-col items-center justify-center gap-2 py-8">
          <p className="text-xs text-destructive">
            <Trans>Помилка завантаження балансу</Trans>
          </p>
          <Button variant="ghost" size="sm" onClick={onRetry} aria-label={t`Повторити спробу`}>
            <Trans>Повторити</Trans>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const {
    balance,
    dropSharePercent,
    pendingIncomesCount,
    debtToCompany,
    pendingObligationAmount,
    pendingObligationCount,
  } = summary
  const hasDebt = debtToCompany > 0
  const hasPendingObligation = pendingObligationAmount > 0

  return (
    <TooltipProvider>
      <Card
        className="border-border/40 bg-card"
        data-testid="drop-balance-card"
        aria-label={t`Мій баланс`}
      >
        <CardHeader className="pb-2 pt-4 px-5">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Trans>Мій баланс</Trans>
            </span>
          </div>
        </CardHeader>

        <CardContent className="px-5 pb-4 space-y-3">
          {/* task-drop-sees-own-obligations (§AC1/§AC2): "выплачено" и "ожидает
              выплаты" — два РАЗНЫХ числа, показанные раздельно, никогда не
              суммируются в одну цифру. Mobile-first: стек в столбик на <640px
              (grid-cols-1), side-by-side с sm: */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p
                className="text-3xl font-bold tabular-nums text-foreground"
                data-testid="drop-balance-amount"
              >
                {fmtUsd(balance)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                <Trans>Виплачено</Trans>
              </p>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="cursor-default">
                  <p
                    className={cn(
                      'text-3xl font-bold tabular-nums',
                      hasPendingObligation ? 'text-amber-500' : 'text-foreground',
                    )}
                    data-testid="drop-balance-pending-obligation"
                  >
                    {fmtUsd(pendingObligationAmount)}
                  </p>
                  <p
                    className="text-xs text-muted-foreground mt-0.5"
                    data-testid="drop-balance-pending-obligation-count"
                  >
                    <Trans>Очікує виплати</Trans>
                    {pendingObligationCount > 0 ? (
                      <>
                        {' · '}
                        <Plural
                          value={pendingObligationCount}
                          one="# зобов’язання"
                          few="# зобов’язання"
                          many="# зобов’язань"
                          other="# зобов’язання"
                        />
                      </>
                    ) : null}
                  </p>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <Trans>
                  Компанія вже нарахувала вам цю суму, але ще не перерахувала — окремо від
                  «Виплачено» вище
                </Trans>
              </TooltipContent>
            </Tooltip>
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
              <span className="text-xs text-muted-foreground">
                <Trans>Частка</Trans>
              </span>
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
              <span className="text-xs text-muted-foreground">
                <Trans>У роботі</Trans>
              </span>
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
                  <span className="text-xs text-muted-foreground">
                    <Trans>Ви маєте сплатити компанії</Trans>
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <Trans>Підтверджені доходи, які ви ще не перерахували</Trans>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Full variant: last income row */}
          {variant === 'full' && (
            <>
              <Separator />
              <p className="text-xs text-muted-foreground">
                <Trans>Розширена інформація доступна в таблиці доходів нижче</Trans>
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  )
}
