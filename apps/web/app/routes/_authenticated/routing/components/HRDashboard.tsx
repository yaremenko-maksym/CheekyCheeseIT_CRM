import { motion } from 'framer-motion'
import { Briefcase, Clock, UserCheck } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/_authenticated/finance/components/KpiCards'
import { useHrSummary } from '@/hooks/use-hr-summary'

/**
 * HRDashboard — рекрутинг хаб-дашборд для роли HR (и ADMIN, который видит ту же
 * рекрутинг-область).
 *
 * Визуально консистентен с DropDashboard / AccountantDashboard: stagger-grid
 * карточек, переиспользует KpiCard-примитив из finance/components/KpiCards. KPI:
 * открытые собеседования, нанято за месяц, активные проекты (HR-scoped count).
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

export function HRDashboard() {
  const { data: summary, isLoading, isError } = useHrSummary()
  const { t } = useLingui()

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="hr-dashboard-hub" className="space-y-6">
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="hr-kpi-loading">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : isError || !summary ? (
          <Card data-testid="hr-kpi-error">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
              <p className="text-sm text-destructive">
                <Trans>Не вдалося завантажити зведення</Trans>
              </p>
              <p className="text-xs text-muted-foreground">
                <Trans>Оновіть сторінку або спробуйте пізніше</Trans>
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
                  title={t`Відкриті співбесіди`}
                  value={String(summary.openInterviews)}
                  sub={t`В активних стадіях`}
                  icon={<Clock className="h-5 w-5" />}
                  color="blue"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-hired-month">
                <KpiCard
                  title={t`Найнято за місяць`}
                  value={String(summary.hiredThisMonth)}
                  sub={t`Перейшли в «Найнято»`}
                  icon={<UserCheck className="h-5 w-5" />}
                  color="green"
                />
              </motion.div>

              <motion.div variants={card} data-testid="kpi-active-projects">
                <KpiCard
                  title={t`Активні проєкти`}
                  value={String(summary.activeProjects)}
                  sub={t`Проєкти сеньйорів команд`}
                  icon={<Briefcase className="h-5 w-5" />}
                  color="default"
                />
              </motion.div>
            </motion.div>
          </>
        )}
      </div>
    </div>
  )
}
