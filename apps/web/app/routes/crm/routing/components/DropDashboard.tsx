import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Clock, Wallet } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/crm/finance/components/KpiCards'
import { financeApi } from '@/routes/crm/finance/api'
import { useDropSummary, DROP_SUMMARY_QUERY_KEY } from '@/hooks/use-drop-summary'
import { useDropProjects } from '@/hooks/use-drop-incomes'
import { InProgressPanel } from './InProgressPanel'

/**
 * DropDashboard — ролевой дашборд для роли DROP.
 *
 * Senior-style layout: KPI grid + «Транзакции в работе» (InProgressPanel mode='drop').
 *
 * KPI:
 *   - Активные проекты   → useDropProjects() → count
 *   - Мой баланс (доля)  → useDropSummary() → balance (USDT)
 *   - Приходы в работе   → useDropSummary() → pendingIncomesCount
 *
 * «Транзакции в работе» (mode='drop'):
 *   - DROP_INCOME PENDING/VALIDATED — self-scoped через getTransactions()
 *   - VALIDATED DROP_INCOME → кнопка «Платить» → /crm/payments/initiate/$incomeId
 *     (payment-channel: создаёт SENIOR_PENDING_PAYOUT + pending_obligations).
 *   - PAYOUT строки НЕ показываются дропу: drop не вызывает payPayoutRequest
 *     (это senior-only API) — их payment-channel закрывает сам.
 *   - «Создать выплату» (createPayoutRequest) и batch-кнопка НЕ показываются:
 *     SENIOR-only endpoint → 403 для DROP.
 *
 * ВАЖНО: НЕ вызывает useSeniorSummary (вернёт 403 для DROP).
 *
 * Сам компонент роль НЕ проверяет — родитель (crm/index.tsx) отвечает за guard.
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

// DROP_INCOME in progress: PENDING (awaiting validation) or VALIDATED (awaiting payment).
const IN_PROGRESS_INCOME_STATUSES = new Set<TransactionDto['status']>(['PENDING', 'VALIDATED'])

export function DropDashboard() {
  const qc = useQueryClient()

  const { data: summary, isLoading: summaryLoading, isError: summaryError } = useDropSummary()
  const { data: projects, isLoading: projectsLoading } = useDropProjects()

  // Self-scoped transactions — backend restricts DROP to rows where
  // senderId/receiverId === currentUser.id. Returns DROP_INCOME + PAYOUT rows.
  // NOT in persist allow-list → never written to disk.
  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => financeApi.getTransactions(),
    staleTime: 30_000,
  })

  // DROP_INCOME rows in the pipeline. Newest first.
  const incomeTxs = useMemo(
    () =>
      transactions
        .filter((t) => t.type === 'DROP_INCOME' && IN_PROGRESS_INCOME_STATUSES.has(t.status))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [transactions],
  )

  // VALIDATED DROP_INCOME rows without a payoutRequestId. Passed as validatedIncomes
  // to InProgressPanel but the batch «Создать выплату» button is hidden in mode='drop'
  // (createPayoutRequest is SENIOR-only → 403). Kept for API shape completeness.
  const validatedIncomes = useMemo(
    () => incomeTxs.filter((t) => t.status === 'VALIDATED' && !t.payoutRequestId),
    [incomeTxs],
  )

  function handleRefresh() {
    void qc.invalidateQueries({ queryKey: ['transactions'] })
    void qc.invalidateQueries({ queryKey: ['payout-requests'] })
    void qc.invalidateQueries({ queryKey: DROP_SUMMARY_QUERY_KEY })
  }

  const isLoading = summaryLoading || projectsLoading
  const isError = summaryError

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
      <div data-testid="drop-dashboard-hub" className="space-y-6">
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="drop-kpi-loading">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : isError || !summary ? (
          <Card data-testid="drop-kpi-error">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
              <p className="text-sm text-destructive">Не удалось загрузить сводку</p>
              <p className="text-xs text-muted-foreground">
                Обновите страницу или попробуйте позже
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* KPI grid — 3 cards, consistent with SeniorDashboard/HR/Accountant style. */}
            <motion.div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              variants={container}
              initial="hidden"
              animate="show"
              data-testid="drop-kpi-grid"
            >
              <motion.div variants={card} data-testid="drop-kpi-active-projects">
                <KpiCard
                  title="Активные проекты"
                  value={String(projects?.length ?? 0)}
                  sub="Проекты, где вы дроп"
                  icon={<Briefcase className="h-5 w-5" />}
                  color="blue"
                />
              </motion.div>

              <motion.div variants={card} data-testid="drop-kpi-balance">
                <KpiCard
                  title="Мой баланс (доля)"
                  value={fmtUsd(summary.balance)}
                  sub={`Ставка: ${summary.dropSharePercent}%`}
                  icon={<Wallet className="h-5 w-5" />}
                  color="green"
                />
              </motion.div>

              <motion.div variants={card} data-testid="drop-kpi-pending">
                <KpiCard
                  title="Приходы в работе"
                  value={String(summary.pendingIncomesCount)}
                  sub="Ожидают валидации"
                  icon={<Clock className="h-5 w-5" />}
                  color="yellow"
                />
              </motion.div>
            </motion.div>

            {/* «Транзакции в работе» — DROP_INCOME (PENDING/VALIDATED).
                mode='drop': VALIDATED rows get «Платить»→initiate (payment-channel);
                createPayoutRequest / PayoutDetailDialog are SENIOR-only and hidden. */}
            <InProgressPanel
              mode="drop"
              incomeTxs={incomeTxs}
              payoutTxs={[]}
              validatedIncomes={validatedIncomes}
              onRefresh={handleRefresh}
              testIdPrefix="drop"
            />
          </>
        )}
      </div>
    </div>
  )
}
