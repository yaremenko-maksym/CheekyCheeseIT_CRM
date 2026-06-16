import { motion } from 'framer-motion'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, Briefcase, CheckCircle2, Clock, TrendingUp, Wallet } from 'lucide-react'
import type { SalaryStatus } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/crm/finance/components/KpiCards'
import { useSeniorSummary } from '@/hooks/use-senior-summary'

/**
 * SeniorDashboard — ролевой дашборд для роли SENIOR (и ADMIN, который видит ТУ
 * ЖЕ self-scoped картину, что и синьор: эндпоинт строго привязан к currentUser.id).
 *
 * Визуально консистентен с HRDashboard / AccountantDashboard: stagger-grid
 * карточек, переиспользует KpiCard-примитив из finance/components/KpiCards. KPI:
 * активные проекты, senior-доход за период, ожидают выплаты. Плюс две панели
 * (наполнение, выбранное USER — без «команды»/«собеседований»):
 *   1. «Мои проекты»        — список own-проектов с долей % (share).
 *   2. «Статус моих выплат» — senior-доход total/за месяц + статус зарплаты.
 *
 * Сам компонент роль НЕ проверяет — родитель (crm/index.tsx) отвечает за
 * dispatch, backend дополнительно отдаёт 403 для не-SENIOR/ADMIN на data-вызове.
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

const SALARY_STATUS_LABEL: Record<SalaryStatus, string> = {
  PENDING: 'Ожидает выплаты',
  PAID: 'Выплачено',
  LOCKED: 'Заблокировано',
}

const SALARY_STATUS_COLOR: Record<SalaryStatus, 'yellow' | 'green' | 'default'> = {
  PENDING: 'yellow',
  PAID: 'green',
  LOCKED: 'default',
}

export function SeniorDashboard() {
  const navigate = useNavigate()
  const { data: summary, isLoading, isError } = useSeniorSummary()

  const goFinance = () => void navigate({ to: '/crm/finance' })

  const salary = summary?.mySalaryStatus ?? null
  const salaryValue = salary ? fmtUsd(salary.amount) : '—'
  const salarySub = salary ? SALARY_STATUS_LABEL[salary.status] : 'Нет начисления за месяц'
  const salaryColor = salary ? SALARY_STATUS_COLOR[salary.status] : 'default'

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="senior-dashboard-hub" className="space-y-6">
        {/* Page header (layout model #231 — compact fixed header + scroll content). */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Дашборд</h1>
          <p className="text-sm text-muted-foreground">Рабочий хаб синьора</p>
        </div>

        {isLoading ? (
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="senior-kpi-loading"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : isError || !summary ? (
          <Card data-testid="senior-kpi-error">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
              <p className="text-sm text-destructive">Не удалось загрузить сводку</p>
              <p className="text-xs text-muted-foreground">
                Обновите страницу или попробуйте позже
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* KPI grid — 3 cards, consistent with HR/Accountant card style. */}
            <motion.div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              variants={container}
              initial="hidden"
              animate="show"
              data-testid="senior-kpi-grid"
            >
              <motion.div variants={card} data-testid="kpi-active-projects">
                <KpiCard
                  title="Активные проекты"
                  value={String(summary.activeProjects.count)}
                  sub="Проекты, где вы синьор"
                  icon={<Briefcase className="h-5 w-5" />}
                  color="blue"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-senior-income">
                <KpiCard
                  title="Доход за месяц"
                  value={fmtUsd(summary.seniorShareIncome.thisMonth)}
                  sub={`Всего: ${fmtUsd(summary.seniorShareIncome.total)}`}
                  icon={<TrendingUp className="h-5 w-5" />}
                  color="green"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-pending-payouts">
                <KpiCard
                  title="Ожидают выплаты"
                  value={String(summary.pendingPayouts.count)}
                  sub={fmtUsd(summary.pendingPayouts.amount)}
                  icon={<Clock className="h-5 w-5" />}
                  color="yellow"
                />
              </motion.div>
            </motion.div>

            {/* Two panels: «Мои проекты» + «Статус моих выплат». */}
            <motion.div
              className="grid gap-4 lg:grid-cols-2"
              variants={container}
              initial="hidden"
              animate="show"
            >
              {/* Мои проекты — own active projects with share %. */}
              <motion.div variants={card}>
                <Card data-testid="senior-projects-panel">
                  <CardContent className="pt-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Мои проекты</p>
                      <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </div>

                    {summary.activeProjects.items.length === 0 ? (
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid="senior-projects-empty"
                      >
                        Нет активных проектов
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {summary.activeProjects.items.map((p) => (
                          <li
                            key={p.id}
                            className="flex items-center justify-between gap-2"
                            data-testid={`senior-project-row-${p.id}`}
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium leading-tight truncate">{p.name}</p>
                              <p className="text-xs text-muted-foreground leading-tight truncate">
                                {p.companyName}
                              </p>
                            </div>
                            <span
                              className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-mono text-primary"
                              data-testid={`senior-project-share-${p.id}`}
                            >
                              {p.sharePercent}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </motion.div>

              {/* Статус моих выплат — income total/this-month + salary status. */}
              <motion.div variants={card}>
                <Card data-testid="senior-payouts-panel">
                  <CardContent className="pt-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Статус моих выплат</p>
                      <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </div>

                    <div className="space-y-3">
                      <div
                        className="flex items-center justify-between"
                        data-testid="senior-salary-status"
                      >
                        <div className="flex items-center gap-2">
                          {salary?.status === 'PAID' ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" />
                          ) : (
                            <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                          )}
                          <div>
                            <p className="text-sm font-medium leading-tight">Доля за месяц</p>
                            <p
                              className={
                                'text-xs leading-tight ' +
                                (salaryColor === 'green'
                                  ? 'text-green-500'
                                  : salaryColor === 'yellow'
                                    ? 'text-yellow-500'
                                    : 'text-muted-foreground')
                              }
                            >
                              {salarySub}
                            </p>
                          </div>
                        </div>
                        <span className="text-sm font-bold tabular-nums">{salaryValue}</span>
                      </div>

                      <div
                        className="flex items-center justify-between border-t pt-3"
                        data-testid="senior-income-total"
                      >
                        <p className="text-sm text-muted-foreground">Senior-доход всего</p>
                        <span className="text-sm font-bold tabular-nums text-green-500">
                          {fmtUsd(summary.seniorShareIncome.total)}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            </motion.div>

            {/* Primary CTA — open the finance page. */}
            <motion.div variants={card} initial="hidden" animate="show">
              <Card className="border-primary/20 bg-primary/[0.03]">
                <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <Wallet className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Финансы</p>
                      <p className="text-xs text-muted-foreground">
                        {summary.pendingPayouts.count > 0
                          ? `${summary.pendingPayouts.count} выплат ожидают, доход и доли по проектам`
                          : 'Доход, доли по проектам и история транзакций'}
                      </p>
                    </div>
                  </div>
                  <Button
                    onClick={goFinance}
                    className="gap-1.5 sm:flex-none"
                    data-testid="senior-finance-cta"
                  >
                    Открыть финансы
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          </>
        )}
      </div>
    </div>
  )
}
