import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Clock, HandCoins, Wallet } from 'lucide-react'
import type { TransactionDto } from '@crm/shared'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/_authenticated/finance/components/KpiCards'
import { financeApi } from '@/routes/_authenticated/finance/api'
import { CompanySharePayoutModal } from '@/routes/_authenticated/finance/components/dialogs/CompanySharePayoutModal'
import { useDropSummary, DROP_SUMMARY_QUERY_KEY } from '@/hooks/use-drop-summary'
import { useDropProjects } from '@/hooks/use-drop-incomes'
import { InProgressPanel } from './InProgressPanel'
import { PendingProjectApprovalsPanel } from './PendingProjectApprovalsPanel'

/**
 * DropDashboard — ролевой дашборд для роли DROP.
 *
 * AC2: визуально и функционально как у SeniorDashboard: те же разделы (KPI,
 * «Транзакции в работе» с приходами + выплатами + кнопками), но на данных дропа.
 * Переиспользует InProgressPanel (общий с SeniorDashboard), КPI из KpiCard.
 *
 * KPI:
 *   - Активные проекты   → useDropProjects() → count
 *   - Мой баланс (доля)  → useDropSummary() → balance (USDT, уже выплачено)
 *   - Ожидает выплаты    → useDropSummary() → pendingObligationAmount
 *     (task-drop-sees-own-obligations — начислено компанией, но ещё не
 *     переведено; отдельная карточка, НИКОГДА не складывается с балансом)
 *   - Приходы в работе   → useDropSummary() → pendingIncomesCount
 *
 * «Транзакции в работе»:
 *   - DROP_INCOME (PENDING/VALIDATED) — self-scoped через getTransactions()
 *   - PAYOUT (PENDING_PAYMENT) — свои выплаты, кнопка «Оплатить» → PayoutDetailDialog
 *
 * ВАЖНО: НЕ вызывает useSeniorSummary (вернёт 403 для DROP). Использует только
 * drop-специфичные эндпоинты.
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

  // PAYOUT rows in PENDING_PAYMENT — drop needs to submit txHash via PayoutDetailDialog.
  // Backend self-scopes: returns only rows where senderId === currentUser.id for DROP.
  const payoutTxs = useMemo(
    () =>
      transactions
        .filter((t) => t.type === 'PAYOUT' && t.status === 'PENDING_PAYMENT')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [transactions],
  )

  // VALIDATED DROP_INCOME rows without a payoutRequestId — eligible for a new payout.
  const validatedIncomes = useMemo(
    () => incomeTxs.filter((t) => t.status === 'VALIDATED' && !t.payoutRequestId),
    [incomeTxs],
  )

  // task-company-share-cta. §9: DROP keeps its existing «Создать выплату»
  // entry points working through `CompanySharePayoutModal` — the CTA strip
  // is explicitly NOT added here (owner scoped the banner to SENIOR only).
  const [payoutModalOpen, setPayoutModalOpen] = useState(false)
  const [payoutPreselect, setPayoutPreselect] = useState<string[]>([])

  function openPayout(ids: string[]) {
    setPayoutPreselect(ids)
    setPayoutModalOpen(true)
  }

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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="drop-kpi-loading">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-28 w-full rounded-lg"
                data-testid="drop-kpi-skeleton"
              />
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
            {/* KPI grid — 4 cards, consistent with SeniorDashboard/HR/Accountant style.
                task-drop-sees-own-obligations: added «Ожидает выплаты» so the hub — the
                first screen a drop lands on — never shows a misleadingly empty balance
                while a company-booked obligation is sitting unpaid (§AC1). Kept as a
                SEPARATE card from «Мой баланс», never folded into its number (§AC2). */}
            <motion.div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
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

              <motion.div variants={card} data-testid="drop-kpi-pending-obligation">
                <KpiCard
                  title="Ожидает выплаты"
                  value={fmtUsd(summary.pendingObligationAmount)}
                  sub={
                    summary.pendingObligationCount > 0
                      ? `Начислений: ${summary.pendingObligationCount}`
                      : 'Нет начислений'
                  }
                  icon={<HandCoins className="h-5 w-5" />}
                  color="red"
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

            {/* task-project-status-filter-ui, §Что сделать item 3. DROP has
                no route access to /projects — this is the ONLY surface
                where a drop-project awaiting their confirmation is
                reachable at all. Self-hides when there's nothing pending. */}
            <PendingProjectApprovalsPanel />

            {/* «Транзакции в работе» — DROP_INCOME (PENDING/VALIDATED) + PAYOUT
                (PENDING_PAYMENT). Shared InProgressPanel (same as SeniorDashboard). */}
            <InProgressPanel
              incomeTxs={incomeTxs}
              payoutTxs={payoutTxs}
              validatedIncomes={validatedIncomes}
              onRefresh={handleRefresh}
              testIdPrefix="drop"
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
        validatedTxs={validatedIncomes}
        preselectedTxIds={payoutPreselect}
      />
    </div>
  )
}
