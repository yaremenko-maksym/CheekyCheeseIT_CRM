import { motion } from 'framer-motion'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, CheckCircle2, Clock, KanbanSquare, UserCheck, Wallet } from 'lucide-react'
import type { SalaryStatus } from '@crm/shared'
import { formatAmount } from '@/lib/format-amount'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/crm/finance/components/KpiCards'
import { useHrSummary } from '@/hooks/use-hr-summary'

/**
 * HRDashboard — рекрутинг хаб-дашборд для роли HR (и ADMIN, который видит ту же
 * рекрутинг-область).
 *
 * Визуально консистентен с DropDashboard / AccountantDashboard: stagger-grid
 * карточек, переиспользует KpiCard-примитив из finance/components/KpiCards. KPI:
 * открытые собеседования, нанято за месяц, статус своей зарплаты. Главный CTA
 * ведёт на канбан собеседований (/crm/interviews).
 *
 * Сам компонент роль НЕ проверяет — родитель (dashboard.tsx) отвечает за guard,
 * backend дополнительно отдаёт 403 для не-HR/ADMIN на data-вызове.
 */

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
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

export function HRDashboard() {
  const navigate = useNavigate()
  const { data: summary, isLoading, isError } = useHrSummary()

  const goInterviews = () => void navigate({ to: '/crm/interviews' })

  const salary = summary?.mySalaryStatus ?? null
  // Salary-currency fix (task-senior-dashboard-enhance): render the salary in
  // its OWN currency (e.g. «50 000,00 UAH») via the shared currency-aware
  // `formatAmount` — NOT the old hard-coded `$`. No conversion is performed.
  const salaryValue = salary ? formatAmount(salary.amount, salary.currency) : '—'
  const salarySub = salary ? SALARY_STATUS_LABEL[salary.status] : 'Нет начисления за месяц'
  const salaryColor = salary ? SALARY_STATUS_COLOR[salary.status] : 'default'

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="hr-dashboard-hub" className="space-y-6">
        {/* Page header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Дашборд</h1>
          <p className="text-sm text-muted-foreground">Рекрутинг хаб HR-менеджера</p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="hr-kpi-loading">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : isError || !summary ? (
          <Card data-testid="hr-kpi-error">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
              <p className="text-sm text-destructive">Не удалось загрузить сводку</p>
              <p className="text-xs text-muted-foreground">
                Обновите страницу или попробуйте позже
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* KPI grid — 3 cards, consistent with Drop/Accountant card style. */}
            <motion.div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              variants={container}
              initial="hidden"
              animate="show"
              data-testid="hr-kpi-grid"
            >
              <motion.div variants={card} data-testid="kpi-open-interviews">
                <KpiCard
                  title="Открытые собеседования"
                  value={String(summary.openInterviews)}
                  sub="В активных стадиях"
                  icon={<Clock className="h-5 w-5" />}
                  color="blue"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-hired-month">
                <KpiCard
                  title="Нанято за месяц"
                  value={String(summary.hiredThisMonth)}
                  sub="Перешли в «Нанят»"
                  icon={<UserCheck className="h-5 w-5" />}
                  color="green"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-my-salary">
                <KpiCard
                  title="Моя зарплата за месяц"
                  value={salaryValue}
                  sub={salarySub}
                  icon={
                    salary?.status === 'PAID' ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : (
                      <Wallet className="h-5 w-5" />
                    )
                  }
                  color={salaryColor}
                />
              </motion.div>
            </motion.div>

            {/* Primary CTA — open the interviews kanban board. */}
            <motion.div variants={card} initial="hidden" animate="show">
              <Card className="border-primary/20 bg-primary/[0.03]">
                <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <KanbanSquare className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Доска собеседований</p>
                      <p className="text-xs text-muted-foreground">
                        {summary.openInterviews > 0
                          ? `${summary.openInterviews} активных собеседований на вашей доске`
                          : 'Нет активных собеседований'}
                      </p>
                    </div>
                  </div>
                  <Button
                    onClick={goInterviews}
                    className="gap-1.5 sm:flex-none"
                    data-testid="hr-interviews-cta"
                  >
                    Открыть канбан
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
