import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, CheckCircle2, Clock, Plus, TrendingUp, Wallet } from 'lucide-react'
import type { SalaryStatus, TransactionDto } from '@crm/shared'
import { formatAmount } from '@/lib/format-amount'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiCard } from '@/routes/crm/finance/components/KpiCards'
import { financeApi } from '@/routes/crm/finance/api'
import { STATUS_COLORS, STATUS_LABELS, fmtAmount, fmtDate } from '@/routes/crm/finance/constants'
import { CreateTransactionDialog } from '@/routes/crm/finance/components/dialogs/CreateTransactionDialog'
import { PayoutDialog } from '@/routes/crm/finance/components/dialogs/PayoutDialog'
import { SENIOR_SUMMARY_QUERY_KEY, useSeniorSummary } from '@/hooks/use-senior-summary'
import { EarningsStatsBlock } from './EarningsStatsBlock'

/**
 * SeniorDashboard — ролевой дашборд для роли SENIOR (и ADMIN, который видит ТУ
 * ЖЕ self-scoped картину, что и синьор: эндпоинт строго привязан к currentUser.id).
 *
 * Визуально консистентен с HRDashboard / AccountantDashboard: stagger-grid
 * карточек, переиспользует KpiCard-примитив из finance/components/KpiCards. KPI:
 * активные проекты, senior-доход за период, ожидают выплаты. Плюс панели:
 *   1. «Мои проекты»          — список own-проектов с долей % (share).
 *   2. «Статус моих выплат»   — senior-доход total/за месяц + статус зарплаты.
 *   3. «Транзакции в работе»  — его SENIOR_INCOME со статусом PENDING/VALIDATED
 *      (НЕ PAID). Тулбар «Добавить приход» (создание SENIOR_INCOME) + «Создать
 *      выплату» (батч VALIDATED-приходов в payout). Все действия self-scoped.
 *
 * Финансовые действия НЕ дублируются: переиспользуются те же finance-диалоги
 * (CreateTransactionDialog → SENIOR_INCOME-only ветка с обязательным RECEIPT;
 * PayoutDialog → createPayoutRequest), та же self-scoped лента транзакций
 * (financeApi.getTransactions — backend findAll ограничивает SENIOR его
 * собственными строками). Дашборд НЕ ведёт на /crm/finance — действия здесь.
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
 * amount, so they keep the USD display. The per-employee SALARY amount uses the
 * currency-aware `formatAmount` instead (its real currency, no conversion).
 */
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

// In-progress = the senior's own income still moving through the pipeline:
// PENDING (awaiting validation) + VALIDATED (validated, awaiting payout). PAID
// is terminal («зелёные») and is intentionally excluded.
const IN_PROGRESS_STATUSES = new Set<TransactionDto['status']>(['PENDING', 'VALIDATED'])

export function SeniorDashboard() {
  const qc = useQueryClient()
  const { data: summary, isLoading, isError } = useSeniorSummary()

  // Self-scoped transactions feed — reuses the SAME query key the finance page
  // uses (['transactions']). The backend `findAll` restricts a SENIOR to rows
  // where they are sender/receiver, so this can never surface another senior's
  // transactions. NOT in the persist allow-list → never written to disk.
  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => financeApi.getTransactions(),
    staleTime: 30_000,
  })

  // AC3: «в работе» — own SENIOR_INCOME with status PENDING or VALIDATED (NOT
  // PAID). Newest first.
  const inProgress = useMemo(
    () =>
      transactions
        .filter((t) => t.type === 'SENIOR_INCOME' && IN_PROGRESS_STATUSES.has(t.status))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [transactions],
  )

  // VALIDATED rows (not already attached to a payout) are the ones eligible to
  // be batched into a new payout request — same gate as the finance page.
  const validatedSeniorIncomes = useMemo(
    () => inProgress.filter((t) => t.status === 'VALIDATED' && !t.payoutRequestId),
    [inProgress],
  )

  const [showCreate, setShowCreate] = useState(false)
  const [payoutOpen, setPayoutOpen] = useState(false)
  const [payoutPreselect, setPayoutPreselect] = useState<string[]>([])

  // The shared finance dialogs already invalidate ['transactions'] /
  // ['finance-summary'] / ['payout-requests'] on success — that auto-refreshes
  // the in-progress list. The senior-summary KPI («ожидают выплаты») reads a
  // separate key, so refresh it too when a dialog closes (cheap, idempotent).
  function refreshSeniorKpi() {
    void qc.invalidateQueries({ queryKey: SENIOR_SUMMARY_QUERY_KEY })
  }

  function openPayoutForTx(txId: string) {
    setPayoutPreselect([txId])
    setPayoutOpen(true)
  }

  function openPayoutBatch() {
    setPayoutPreselect([])
    setPayoutOpen(true)
  }

  const salary = summary?.mySalaryStatus ?? null
  // Salary-currency fix: render the salary in its OWN currency (e.g. «50 000,00
  // UAH») via the shared currency-aware `formatAmount` — NOT the old hard-coded
  // `$`. No conversion is performed.
  const salaryValue = salary ? formatAmount(salary.amount, salary.currency) : '—'
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

            {/* «Статистика заработка» — earnings stats (task-senior-stats-block):
                hero «Всего» + sparkline, «Прошлый месяц», «Этот месяц» with the
                per-company arrival progress bar (NO money "expected" figure). */}
            <EarningsStatsBlock
              stats={summary.earningsStats}
              totalEarned={summary.seniorShareIncome.total}
              thisMonthEarned={summary.seniorShareIncome.thisMonth}
            />

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

            {/* «Транзакции в работе» — own SENIOR_INCOME PENDING/VALIDATED, with
                inline finance actions (add income / create payout). */}
            <motion.div variants={card} initial="hidden" animate="show">
              <Card data-testid="senior-in-progress-panel">
                <CardContent className="pt-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">Транзакции в работе</p>
                      <p className="text-xs text-muted-foreground">
                        Приходы на валидации и ожидающие выплаты
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {validatedSeniorIncomes.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={openPayoutBatch}
                          data-testid="senior-create-payout-batch"
                        >
                          <Wallet className="h-4 w-4" aria-hidden="true" />
                          Создать выплату
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowCreate(true)}
                        data-testid="senior-add-income"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Добавить приход
                      </Button>
                    </div>
                  </div>

                  {inProgress.length === 0 ? (
                    <p
                      className="text-xs text-muted-foreground py-2"
                      data-testid="senior-in-progress-empty"
                    >
                      Нет транзакций в работе. Добавьте приход, чтобы начать.
                    </p>
                  ) : (
                    <ul className="space-y-2" data-testid="senior-in-progress-list">
                      {inProgress.map((t) => (
                        <li
                          key={t.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                          data-testid={`senior-in-progress-row-${t.id}`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium leading-tight truncate">
                              {t.projectName ?? '—'}
                            </p>
                            <p className="text-xs text-muted-foreground leading-tight">
                              {fmtDate(t.createdAt)}
                            </p>
                          </div>
                          <span className="text-sm font-medium tabular-nums shrink-0">
                            {fmtAmount(t.amount, t.currency)}
                          </span>
                          <Badge
                            variant="outline"
                            className={`shrink-0 text-[11px] ${STATUS_COLORS[t.status]}`}
                            data-testid={`senior-in-progress-status-${t.id}`}
                          >
                            {STATUS_LABELS[t.status]}
                          </Badge>
                          {t.status === 'VALIDATED' && !t.payoutRequestId && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0 gap-1.5"
                              onClick={() => openPayoutForTx(t.id)}
                              data-testid={`senior-in-progress-payout-${t.id}`}
                            >
                              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                              Создать выплату
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </>
        )}
      </div>

      {/* Reused finance dialogs — NOT duplicated. CreateTransactionDialog renders
          the SENIOR_INCOME-only flow for a SENIOR (mandatory RECEIPT preserved);
          PayoutDialog batches VALIDATED SENIOR_INCOME into a payout request. */}
      <CreateTransactionDialog
        open={showCreate}
        onClose={() => {
          setShowCreate(false)
          refreshSeniorKpi()
        }}
      />
      <PayoutDialog
        open={payoutOpen}
        onClose={() => {
          setPayoutOpen(false)
          refreshSeniorKpi()
        }}
        validatedTxs={validatedSeniorIncomes}
        preselectedTxIds={payoutPreselect}
      />
    </div>
  )
}
