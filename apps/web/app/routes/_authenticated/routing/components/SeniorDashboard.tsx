import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Clock, TrendingUp } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/_authenticated/finance/components/KpiCards'
import { financeApi } from '@/routes/_authenticated/finance/api'
import { CompanySharePayoutStrip } from '@/routes/_authenticated/finance/components/CompanySharePayoutStrip'
import { CompanySharePayoutModal } from '@/routes/_authenticated/finance/components/dialogs/CompanySharePayoutModal'
import { SENIOR_SUMMARY_QUERY_KEY, useSeniorSummary } from '@/hooks/use-senior-summary'
import { EarningsStatsBlock } from './EarningsStatsBlock'
import { InProgressPanel } from './InProgressPanel'
import { PendingProjectApprovalsPanel } from './PendingProjectApprovalsPanel'

/**
 * SeniorDashboard — ролевой дашборд для роли SENIOR (и ADMIN, который видит ТУ
 * ЖЕ self-scoped картину, что и синьор: эндпоинт строго привязан к currentUser.id).
 *
 * Визуально консистентен с HRDashboard / AccountantDashboard: stagger-grid
 * карточек, переиспользует KpiCard-примитив из finance/components/KpiCards. KPI:
 * активные проекты, senior-доход за период, ожидают выплаты. Плюс блоки:
 *   1. EarningsStatsBlock — hero «Всего заработано» + sparkline + список проектов
 *      + «Этот месяц» с progress bar приходов от компаний.
 *   2. InProgressPanel — «Транзакции в работе»: SENIOR_INCOME (PENDING/VALIDATED)
 *      + PAYOUT (PENDING_PAYMENT) с кнопками «Создать выплату» / «Оплатить».
 *      Общий компонент, переиспользуется DropDashboard'ом.
 *
 * §3 refactor: убраны шапка «Дашборд», панель «Статус моих выплат» и дублирующая
 * панель «Мои проекты» — список проектов теперь внутри EarningsStatsBlock.
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

/**
 * USD-only formatter for the aggregated senior-SHARE income figures. Those are
 * a cross-project sum the backend reports as `currency: 'USD'` (see
 * seniorSummarySchema.seniorShareIncome) — they are NOT a single transaction's
 * amount, so they keep the USD display.
 */
function fmtUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// Income in-progress statuses: PENDING (awaiting validation) + VALIDATED
// (validated, awaiting payout). PAID is terminal and intentionally excluded.
const IN_PROGRESS_INCOME_STATUSES = new Set<TransactionDto['status']>(['PENDING', 'VALIDATED'])

export function SeniorDashboard() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const { data: summary, isLoading, isError } = useSeniorSummary()

  // Self-scoped transactions feed — reuses the SAME query key the finance page
  // uses (['transactions']). The backend `findAll` restricts a SENIOR to rows
  // where they are sender/receiver, so this can never surface another senior's
  // transactions. NOT in the persist allow-list → never written to disk.
  const { data: transactions = [], isLoading: txLoading } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => financeApi.getTransactions(),
    staleTime: 30_000,
  })

  // task-company-share-cta. Owned here (not inside InProgressPanel) so the
  // SAME modal instance serves BOTH the CTA strip and InProgressPanel's
  // toolbar/row triggers — see design spec §5 "one mounted Dialog".
  const [payoutModalOpen, setPayoutModalOpen] = useState(false)
  const [payoutPreselect, setPayoutPreselect] = useState<string[]>([])

  function openPayout(ids: string[]) {
    setPayoutPreselect(ids)
    setPayoutModalOpen(true)
  }

  // Income rows in the pipeline: own SENIOR_INCOME with PENDING or VALIDATED.
  // PAID is terminal («зелёные») and intentionally excluded. Newest first.
  const incomeTxs = useMemo(
    () =>
      transactions
        .filter((t) => t.type === 'SENIOR_INCOME' && IN_PROGRESS_INCOME_STATUSES.has(t.status))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [transactions],
  )

  // AC1: PAYOUT rows in PENDING_PAYMENT — senior needs to submit txHash.
  // Backend self-scopes: returns only rows where senderId === currentUser.id for SENIOR.
  const payoutTxs = useMemo(
    () =>
      transactions
        .filter((t) => t.type === 'PAYOUT' && t.status === 'PENDING_PAYMENT')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [transactions],
  )

  // VALIDATED rows (not already attached to a payout) are the ones eligible to
  // be batched into a new payout request — same gate as the finance page.
  const validatedSeniorIncomes = useMemo(
    () => incomeTxs.filter((t) => t.status === 'VALIDATED' && !t.payoutRequestId),
    [incomeTxs],
  )

  function handleRefresh() {
    void qc.invalidateQueries({ queryKey: ['transactions'] })
    void qc.invalidateQueries({ queryKey: ['payout-requests'] })
    void qc.invalidateQueries({ queryKey: SENIOR_SUMMARY_QUERY_KEY })
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="senior-dashboard-hub" className="space-y-6">
        {/* task-company-share-cta. Самый верх — перед KPI-гридом (design spec
            §4.2): «заметный призыв» первым делом видит синьор с непогашенным
            долгом. Не зависит от summary isLoading/isError — своя проверка. */}
        <CompanySharePayoutStrip
          transactions={transactions}
          isLoading={txLoading}
          currentUserId={user?.id ?? ''}
          userSeniorSharePercent={user?.seniorSharePercent}
          onOpen={() => openPayout([])}
        />
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

            {/* task-project-status-filter-ui, §Что сделать item 3. SENIOR
                already has the ProjectRow card on /projects — mounted here
                too for symmetry with DropDashboard ("кнопка в записи
                согласования — для всех"). Self-hides when nothing pending. */}
            <PendingProjectApprovalsPanel />

            {/* Earnings stats: hero «Всего» + sparkline + список проектов +
                «Этот месяц» progress bar. «Прошлый месяц» убран (§3). */}
            <EarningsStatsBlock
              stats={summary.earningsStats}
              totalEarned={summary.seniorShareIncome.total}
              thisMonthEarned={summary.seniorShareIncome.thisMonth}
              activeProjects={summary.activeProjects.items}
            />

            {/* «Транзакции в работе» — SENIOR_INCOME (PENDING/VALIDATED) + PAYOUT
                (PENDING_PAYMENT). Shared InProgressPanel component (also used by
                DropDashboard). «Оплатить» → PayoutDetailDialog. */}
            <InProgressPanel
              incomeTxs={incomeTxs}
              payoutTxs={payoutTxs}
              validatedIncomes={validatedSeniorIncomes}
              onRefresh={handleRefresh}
              testIdPrefix="senior"
              onOpenPayout={openPayout}
            />
          </>
        )}
      </div>

      <CompanySharePayoutModal
        open={payoutModalOpen}
        onClose={() => {
          setPayoutModalOpen(false)
          handleRefresh()
        }}
        validatedTxs={validatedSeniorIncomes}
        preselectedTxIds={payoutPreselect}
      />
    </div>
  )
}
