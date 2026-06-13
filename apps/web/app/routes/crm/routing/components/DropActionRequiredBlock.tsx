import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, CheckCircle } from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { DropIncomeDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface DropActionRequiredBlockProps {
  validatedIncomes: DropIncomeDto[] | undefined
  isLoading: boolean
}

function fmtUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

const MAX_VISIBLE = 3

export function DropActionRequiredBlock({
  validatedIncomes,
  isLoading,
}: DropActionRequiredBlockProps) {
  const navigate = useNavigate()

  if (isLoading) {
    return <Skeleton className="h-28 w-full rounded-lg" />
  }

  const incomes = validatedIncomes ?? []
  const hasAction = incomes.length > 0
  const visible = incomes.slice(0, MAX_VISIBLE)
  const extra = incomes.length - MAX_VISIBLE

  return (
    <Card
      className="border-border/40 bg-card"
      data-testid="drop-action-block"
      aria-label="Требует действия"
    >
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-center gap-2">
          {hasAction ? (
            <AlertCircle className="h-4 w-4 text-primary" aria-hidden="true" />
          ) : (
            <CheckCircle className="h-4 w-4 text-green-500" aria-hidden="true" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {hasAction ? 'ТРЕБУЕТ ДЕЙСТВИЯ' : 'ВСЁ ОПЛАЧЕНО'}
          </span>
          {hasAction && (
            <Badge variant="default" className="ml-auto text-xs">
              {incomes.length} {incomes.length === 1 ? 'приход' : 'приходов'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="px-5 pb-4 space-y-3">
        {hasAction ? (
          <>
            {/* Validated income list */}
            <ul className="space-y-1">
              <AnimatePresence initial={false}>
                {visible.map((income) => (
                  <motion.li
                    key={income.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-2 py-1"
                    data-testid="drop-action-income-item"
                  >
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {fmtUsd(income.amount)}
                    </span>
                    <span className="text-xs text-muted-foreground truncate flex-1">
                      {income.companyName}
                      {' · '}
                      {fmtDate(income.createdAt)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 min-w-[60px] shrink-0 rounded-md"
                      aria-label={`Оплатить приход от ${income.companyName}`}
                      data-testid={`drop-action-pay-btn-${income.id}`}
                      onClick={() =>
                        void navigate({
                          to: '/crm/payments/initiate/$incomeId',
                          params: { incomeId: income.id },
                        })
                      }
                    >
                      Платить
                    </Button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>

            {/* +N more link */}
            {extra > 0 && (
              <Link
                to="/crm/finance"
                search={{ status: 'validated' } as Record<string, string>}
                className="text-xs text-primary hover:underline"
                data-testid="drop-action-more-link"
              >
                +{extra} ещё
              </Link>
            )}

            {/* Pay all CTA */}
            <Button
              variant="default"
              className="w-full"
              data-testid="drop-action-pay-all-btn"
              onClick={() =>
                void navigate({
                  to: '/crm/payments/initiate/$incomeId',
                  params: { incomeId: incomes[0]!.id },
                })
              }
            >
              Платить компании
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Нет приходов, требующих оплаты</p>
        )}
      </CardContent>
    </Card>
  )
}
