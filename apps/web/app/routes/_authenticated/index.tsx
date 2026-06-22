import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Briefcase, CalendarClock, Clock, Users } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect } from 'react'
import type { TransactionDto } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/context/auth'
import { useAdminSummary } from '@/hooks/use-admin-summary'
import { KpiCard } from './finance/components/KpiCards'
import { ActiveTransactionsTable } from './finance/components/ActiveTransactionsTable'
import { DropDashboard } from './routing/components/DropDashboard'
import { AccountantDashboard } from './routing/components/AccountantDashboard'
import { HRDashboard } from './routing/components/HRDashboard'
import { SeniorDashboard } from './routing/components/SeniorDashboard'

/**
 * `/` — корневая страница авторизованной CRM. Единая точка входа,
 * рендерит роль-зависимый дашборд (консолидация: бывший /dashboard удалён):
 *   - DROP        → DropDashboard (платёжный хаб)
 *   - ACCOUNTANT  → AccountantDashboard (финансовый хаб + KPI валидации)
 *   - HR          → HRDashboard (рекрутинг хаб + KPI собеседований)
 *   - SENIOR      → SeniorDashboard (рабочий хаб: мои проекты + доход + выплаты)
 *   - JUNIOR      → редирект на собственный хаб /project
 *   - ADMIN       → AdminDashboard («центр действий»: 4 KPI + активные транзакции)
 *
 * `/` — fail-open в route-access (доступен всем аутентифицированным ролям, вкл.
 * DROP); per-role контент дашбордов НЕ меняется здесь — только консолидация роутинга.
 */
export const Route = createFileRoute('/_authenticated/')({
  component: CrmDashboard,
})

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] as const } },
}

function CrmDashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()

  // JUNIOR UX: JUNIOR имеет собственный хаб «Мой проект» — редиректим с корня.
  useEffect(() => {
    if (user?.role === 'JUNIOR') {
      void navigate({ to: '/project', replace: true })
    }
  }, [user?.role, navigate])
  if (user?.role === 'JUNIOR') return null

  // DROP role: платёжный хаб вместо общего дашборда.
  if (user?.role === 'DROP') {
    return <DropDashboard />
  }

  // ACCOUNTANT role: финансовый хаб-дашборд с KPI валидации (ACCOUNTANT Sprint 1).
  // Данные KPI отдаёт GET /api/finance/accountant-summary (RBAC ACCOUNTANT+ADMIN).
  if (user?.role === 'ACCOUNTANT') {
    return <AccountantDashboard />
  }

  // HR role: рекрутинг хаб-дашборд с KPI собеседований + статусом зарплаты.
  // Данные KPI отдаёт GET /api/interviews/hr-summary (RBAC HR+ADMIN).
  if (user?.role === 'HR') {
    return <HRDashboard />
  }

  // SENIOR role: рабочий хаб-дашборд (мои проекты + senior-доход + выплаты +
  // статус зарплаты). Данные отдаёт GET /api/finance/senior-summary —
  // СТРОГО self-scoped (RBAC SENIOR+ADMIN; синьор не видит данные другого синьора).
  if (user?.role === 'SENIOR') {
    return <SeniorDashboard />
  }

  // ADMIN role: «центр действий» — рабочий дашборд с реальными данными
  // (GET /api/admin/summary, RBAC ADMIN-only). 4 нейтральных KPI + таблица
  // «Активные транзакции» в стиле страницы Финансы (переиспользует TransactionRow).
  return <AdminDashboard />
}

/**
 * AdminDashboard — «центр действий» для роли ADMIN.
 *
 * 4 одинаковые нейтральные KPI-карточки (KpiCard, color="default") + панель
 * «Активные транзакции», переиспользующая финансовый TransactionRow через
 * ActiveTransactionsTable (строки выглядят идентично странице Финансы).
 *
 * Данные отдаёт GET /api/admin/summary (useAdminSummary, AdminSummary). RBAC на
 * бэкенде — ADMIN→200, иначе 403; этот компонент монтируется только для ADMIN
 * (диспетч в CrmDashboard). Клик по строке/действию ведёт на /finance, где живёт
 * полный flow выплат — дашборд не дублирует диалоги.
 */
function AdminDashboard() {
  const navigate = useNavigate()
  const { data: summary, isLoading, isError } = useAdminSummary()

  // Any row interaction routes the admin to the finance page (full payout flow).
  const goToFinance = (_tx: TransactionDto) => {
    void navigate({ to: '/finance' })
  }

  const kpis = summary?.kpis

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="admin-dashboard-hub" className="space-y-6">
        {/* KPI grid — 4 одинаковые нейтральные карточки. */}
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="admin-kpi-loading">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 w-full animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : isError || !kpis ? (
          <Card data-testid="admin-kpi-error">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
              <p className="text-sm text-destructive">Не удалось загрузить сводку</p>
              <p className="text-xs text-muted-foreground">
                Обновите страницу или попробуйте позже
              </p>
            </CardContent>
          </Card>
        ) : (
          <motion.div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            variants={container}
            initial="hidden"
            animate="show"
            data-testid="admin-kpi-grid"
          >
            <motion.div variants={item} data-testid="kpi-active-projects">
              <KpiCard
                title="Активных проектов"
                value={String(kpis.activeProjects)}
                icon={<Briefcase className="h-5 w-5" />}
                color="default"
              />
            </motion.div>
            <motion.div variants={item} data-testid="kpi-employees">
              <KpiCard
                title="Сотрудников"
                value={String(kpis.employees)}
                icon={<Users className="h-5 w-5" />}
                color="default"
              />
            </motion.div>
            <motion.div variants={item} data-testid="kpi-projects-unpaid">
              <KpiCard
                title="Проектов не оплачено в этом месяце"
                value={String(kpis.projectsUnpaidThisMonth)}
                icon={<CalendarClock className="h-5 w-5" />}
                color="default"
              />
            </motion.div>
            <motion.div variants={item} data-testid="kpi-active-interviews">
              <KpiCard
                title="Собеседований"
                value={String(kpis.activeInterviews)}
                icon={<Clock className="h-5 w-5" />}
                color="default"
              />
            </motion.div>
          </motion.div>
        )}

        {/* Активные транзакции — таблица в стиле страницы Финансы. Self-contained
            fade-up: this card is a SIBLING of the KPI grid (not a child of the
            `container` variant), so it animates with the SAME transition as `item`
            via explicit initial/animate (no reliance on parent variant propagation,
            which would never fire here and leave the table un-animated). */}
        <motion.div initial={item.hidden} animate={item.show}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Активные транзакции</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ActiveTransactionsTable
                transactions={summary?.activeTransactions ?? []}
                loading={isLoading}
                onRowClick={goToFinance}
              />
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  )
}
