import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Briefcase, CalendarClock, Clock, Users } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { TransactionDto } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/context/auth'
import { useAdminSummary, ADMIN_SUMMARY_QUERY_KEY } from '@/hooks/use-admin-summary'
import { useQueryClient } from '@tanstack/react-query'
import { KpiCard } from './finance/components/KpiCards'
import { ActiveTransactionsTable } from './finance/components/ActiveTransactionsTable'
import { SettleSeniorPayoutDialog } from './finance/components/dialogs/SettleSeniorPayoutDialog'
import { PaySalaryDialog } from './finance/components/dialogs/PaySalaryDialog'
import { ConfirmPayoutDialog } from '@/components/finance/ConfirmPayoutDialog'
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
 * (диспетч в CrmDashboard).
 *
 * UT-feedback (PR #280): клик по экшн-кнопке строки больше НЕ ведёт на /finance —
 * он открывает ТУ ЖЕ модалку оплаты, что и страница Финансы, прямо на дашборде, и
 * выполняет ТУ ЖЕ мутацию (диалоги переиспользуются 1:1, ничего не дублируется):
 *   - SENIOR_PENDING_PAYOUT «Выплатить»  → SettleSeniorPayoutDialog
 *   - PAYOUT «Подтвердить оплату»         → ConfirmPayoutDialog
 *   - SALARY «Выплатить»                  → PaySalaryDialog
 * Каждый диалог сам инвалидирует свои query-ключи (['transactions'],
 * ['finance-summary'], ['company-account'] …). Здесь мы дополнительно
 * инвалидируем ['admin','summary'] на закрытии диалога, чтобы строка дашборда
 * обновилась после успешной оплаты.
 */
function AdminDashboard() {
  const qc = useQueryClient()
  const { data: summary, isLoading, isError } = useAdminSummary()

  // One row-action dialog open at a time. Each holds the TransactionDto adapted
  // from the slim admin-summary row (ActiveTransactionsTable builds it). The
  // reused finance dialogs operate on tx.id / tx.payoutRequestId — both are
  // present on the adapted DTO (the backend now projects payoutRequestId).
  const [settleSeniorTx, setSettleSeniorTx] = useState<TransactionDto | null>(null)
  const [confirmPayoutTx, setConfirmPayoutTx] = useState<TransactionDto | null>(null)
  const [paySalaryTx, setPaySalaryTx] = useState<TransactionDto | null>(null)

  // After any dialog closes (incl. a successful pay), refresh the admin summary
  // so the just-settled row drops out of «Активные транзакции». The dialogs
  // already invalidate the finance query-keys; this only adds the dashboard's
  // own ['admin','summary'] key (the finance page keeps working untouched).
  const refreshSummary = () => {
    void qc.invalidateQueries({ queryKey: ADMIN_SUMMARY_QUERY_KEY })
  }

  const closeSettleSenior = () => {
    setSettleSeniorTx(null)
    refreshSummary()
  }
  const closeConfirmPayout = () => {
    setConfirmPayoutTx(null)
    refreshSummary()
  }
  const closePaySalary = () => {
    setPaySalaryTx(null)
    refreshSummary()
  }

  const kpis = summary?.kpis

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="admin-dashboard-hub" className="space-y-6">
        {/* KPI grid — 4 одинаковые нейтральные карточки. `items-stretch` + KpiCard
            `h-full` делают ВСЕ карточки одной высоты, даже если заголовок
            «Проектов не оплачено в этом месяце» переносится на 2 строки. */}
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
            className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4"
            variants={container}
            initial="hidden"
            animate="show"
            data-testid="admin-kpi-grid"
          >
            <motion.div variants={item} className="h-full" data-testid="kpi-active-projects">
              <KpiCard
                title="Активных проектов"
                value={String(kpis.activeProjects)}
                icon={<Briefcase className="h-5 w-5" />}
                color="default"
                className="h-full"
              />
            </motion.div>
            <motion.div variants={item} className="h-full" data-testid="kpi-employees">
              <KpiCard
                title="Сотрудников"
                value={String(kpis.employees)}
                icon={<Users className="h-5 w-5" />}
                color="default"
                className="h-full"
              />
            </motion.div>
            <motion.div variants={item} className="h-full" data-testid="kpi-projects-unpaid">
              <KpiCard
                title="Проектов не оплачено в этом месяце"
                value={String(kpis.projectsUnpaidThisMonth)}
                icon={<CalendarClock className="h-5 w-5" />}
                color="default"
                className="h-full"
              />
            </motion.div>
            <motion.div variants={item} className="h-full" data-testid="kpi-active-interviews">
              <KpiCard
                title="Собеседований"
                value={String(kpis.activeInterviews)}
                icon={<Clock className="h-5 w-5" />}
                color="default"
                className="h-full"
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
                onConfirmPayout={setConfirmPayoutTx}
                onSettleSeniorPayout={setSettleSeniorTx}
                onPaySalary={setPaySalaryTx}
              />
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Reused finance pay dialogs — mounted ON the dashboard so an admin
          completes the payout right here (same dialogs, same mutations, same
          receipt/txHash fields as the Финансы page; no flow duplicated). */}
      <SettleSeniorPayoutDialog tx={settleSeniorTx} onClose={closeSettleSenior} />
      <ConfirmPayoutDialog tx={confirmPayoutTx} onClose={closeConfirmPayout} />
      <PaySalaryDialog tx={paySalaryTx} onClose={closePaySalary} />
    </div>
  )
}
