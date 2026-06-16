import { useState } from 'react'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CheckCircle2, Clock, Send, Users, Wallet } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/crm/finance/components/KpiCards'
import { ValidateDialog } from '@/routes/crm/finance/components/dialogs/ValidateDialog'
import { financeApi } from '@/routes/crm/finance/api'
import { useAccountantSummary } from '@/hooks/use-accountant-summary'

/**
 * AccountantDashboard — финансовый хаб-дашборд для роли ACCOUNTANT (и ADMIN,
 * который видит ту же финансовую область).
 *
 * Визуально консистентен с DropDashboard: stagger-grid карточек, переиспользует
 * KpiCard-примитив из finance/components/KpiCards. KPI: ожидают валидации,
 * валидировано за месяц, выплачено за месяц, получателей.
 *
 * CTA «Валидировать ожидающие (N)» открывает модалку-очередь ValidateDialog
 * (AC2/AC3) — вместо навигации на /crm/finance?status=PENDING.
 *
 * Сам компонент роль НЕ проверяет — родитель (dashboard.tsx) отвечает за guard,
 * backend дополнительно отдаёт 403 для не-ACCOUNTANT/ADMIN на data-вызове.
 */

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

function fmtUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function AccountantDashboard() {
  const { data: summary, isLoading, isError } = useAccountantSummary()

  // AC3: для открытия ValidateDialog из CTA нужны реальные pending-транзакции.
  // Загружаем их lazily (enabled только когда компонент смонтирован для ACCOUNTANT/ADMIN).
  const { data: transactions = [] } = useQuery<TransactionDto[]>({
    queryKey: ['transactions'],
    queryFn: () => financeApi.getTransactions(),
    staleTime: 30_000,
  })

  // Очередь validatable транзакций — SENIOR_INCOME/DROP_INCOME PENDING.
  const validateQueue = transactions.filter(
    (t) => (t.type === 'SENIOR_INCOME' || t.type === 'DROP_INCOME') && t.status === 'PENDING',
  )

  // ValidateDialog state — модалка-очередь.
  const [validateTx, setValidateTx] = useState<TransactionDto | null>(null)

  const openValidateQueue = () => {
    const first = validateQueue[0]
    if (first) {
      setValidateTx(first)
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="accountant-dashboard-hub" className="space-y-6">
        {/* Page header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Дашборд</h1>
          <p className="text-sm text-muted-foreground">Финансовый хаб бухгалтера</p>
        </div>

        {isLoading ? (
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            data-testid="accountant-kpi-loading"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : isError || !summary ? (
          <Card data-testid="accountant-kpi-error">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
              <p className="text-sm text-destructive">Не удалось загрузить финансовую сводку</p>
              <p className="text-xs text-muted-foreground">
                Обновите страницу или попробуйте позже
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* KPI grid — 4 cards, consistent with DropDashboard card style. */}
            <motion.div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
              variants={container}
              initial="hidden"
              animate="show"
              data-testid="accountant-kpi-grid"
            >
              <motion.div variants={card} data-testid="kpi-pending-validation">
                <KpiCard
                  title="Ожидают валидации"
                  value={String(summary.pendingValidation.count)}
                  sub={fmtUsd(summary.pendingValidation.amount)}
                  icon={<Clock className="h-5 w-5" />}
                  color="yellow"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-validated-month">
                <KpiCard
                  title="Валидировано за месяц"
                  value={String(summary.validatedThisMonth.count)}
                  sub={fmtUsd(summary.validatedThisMonth.amount)}
                  icon={<CheckCircle2 className="h-5 w-5" />}
                  color="green"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-paid-month">
                <KpiCard
                  title="Выплачено за месяц"
                  value={fmtUsd(summary.paidThisMonth.amount)}
                  icon={<Send className="h-5 w-5" />}
                  color="blue"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-recipient-count">
                <KpiCard
                  title="Получателей"
                  value={String(summary.recipientCount)}
                  icon={<Users className="h-5 w-5" />}
                  color="purple"
                />
              </motion.div>
            </motion.div>

            {/* Primary CTA — opens ValidateDialog queue (AC3). */}
            <motion.div variants={card} initial="hidden" animate="show">
              <Card className="border-primary/20 bg-primary/[0.03]">
                <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <Wallet className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Валидация выплат</p>
                      <p className="text-xs text-muted-foreground">
                        {summary.pendingValidation.count > 0
                          ? `${summary.pendingValidation.count} приходов ждут вашей проверки`
                          : 'Нет приходов, ожидающих валидации'}
                      </p>
                    </div>
                  </div>
                  <Button
                    onClick={openValidateQueue}
                    disabled={summary.pendingValidation.count === 0}
                    className="gap-1.5 sm:flex-none"
                    data-testid="accountant-validate-cta"
                  >
                    Валидировать ожидающие ({summary.pendingValidation.count})
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          </>
        )}
      </div>

      {/* ValidateDialog — очередь валидации (AC2, AC3) */}
      <ValidateDialog
        tx={validateTx}
        queue={validateQueue}
        onClose={() => setValidateTx(null)}
        onAdvance={(nextTx) => setValidateTx(nextTx)}
      />
    </div>
  )
}
