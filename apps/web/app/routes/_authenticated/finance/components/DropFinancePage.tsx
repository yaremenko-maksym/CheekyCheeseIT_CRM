/**
 * Drop finance cabinet — rendered when `user.role === 'DROP'` in finance/index.tsx.
 *
 * Layout:
 *   1. DropBalanceSummaryCard  (DropBalanceCard variant="full")
 *   2. DropIncomesTable        (paginated, status/period filters, action on validated)
 *   3. DropPaymentsHistory     (outgoing payments drop→company)
 *
 * All data from drop-namespaced hooks (NOT persisted to IndexedDB).
 * See design spec docs/design/drop-role-ux.md §4.
 */
import { useState } from 'react'
import { ArrowUpRight, CheckCircle, CircleCheck, Clock, Plus, XCircle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { DropIncomeDto, DropIncomeStatus, DropPaymentDto } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDropSummary, DROP_SUMMARY_QUERY_KEY } from '@/hooks/use-drop-summary'
import { useDropIncomes, useDropPayments } from '@/hooks/use-drop-incomes'
import { DropBalanceCard } from '@/routes/_authenticated/routing/components/DropBalanceCard'
import { CreateTransactionDialog } from './dialogs/CreateTransactionDialog'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

// ── Status Badge ───────────────────────────────────────────────────────────────

type DropPaymentStatus = 'pending' | 'confirmed' | 'failed'

function IncomeStatusBadge({ status, id }: { status: DropIncomeStatus; id: string }) {
  const config: Record<
    DropIncomeStatus,
    {
      variant: 'secondary' | 'default' | 'outline' | 'destructive'
      icon: React.ReactNode
      label: string
    }
  > = {
    pending: {
      variant: 'secondary',
      icon: <Clock className="mr-1 h-3 w-3" />,
      label: 'Ожидает',
    },
    validated: {
      variant: 'default',
      icon: <CheckCircle className="mr-1 h-3 w-3" />,
      label: 'Валидирован',
    },
    paid: {
      variant: 'outline',
      icon: <CircleCheck className="mr-1 h-3 w-3" />,
      label: 'Оплачен',
    },
    rejected: {
      variant: 'destructive',
      icon: <XCircle className="mr-1 h-3 w-3" />,
      label: 'Отклонён',
    },
  }
  const { variant, icon, label } = config[status]
  return (
    <Badge variant={variant} data-testid={`drop-income-status-${id}`} className="text-xs">
      {icon}
      {label}
    </Badge>
  )
}

// task-drop-sees-own-obligations (§AC3): the feed now covers TWO income
// models — this badge is the "понятное различение" the task asks for.
// 'declared'   — the old self-declared DROP_INCOME row (drop registers it).
// 'obligation' — a company-booked IOU (DROP_PENDING_PAYOUT/PAYOUT_DROP, from
//                the admin-USDT declare path or the drop-payout cascade).
function IncomeModelBadge({ model }: { model: DropIncomeDto['model'] }) {
  return model === 'obligation' ? (
    <Badge variant="secondary" className="text-xs">
      Начисление
    </Badge>
  ) : (
    <Badge variant="outline" className="text-xs">
      Приход
    </Badge>
  )
}

function PaymentStatusBadge({ status }: { status: DropPaymentStatus }) {
  const config: Record<
    DropPaymentStatus,
    { variant: 'secondary' | 'default' | 'outline' | 'destructive'; label: string }
  > = {
    pending: { variant: 'secondary', label: 'Ожидает' },
    confirmed: { variant: 'default', label: 'Подтверждён' },
    failed: { variant: 'destructive', label: 'Ошибка' },
  }
  const { variant, label } = config[status]
  return (
    <Badge variant={variant} className="text-xs">
      {label}
    </Badge>
  )
}

// ── Period filter helper ───────────────────────────────────────────────────────

type Period = 'all' | 'current' | 'prev' | '3m'

function periodToDates(period: Period): { from?: string; to?: string } {
  const now = new Date()
  if (period === 'all') return {}

  if (period === 'current') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1)
    return { from: from.toISOString().slice(0, 10) }
  }
  if (period === 'prev') {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const to = new Date(now.getFullYear(), now.getMonth(), 0)
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
  }
  // 3m
  const from = new Date(now)
  from.setMonth(from.getMonth() - 3)
  return { from: from.toISOString().slice(0, 10) }
}

// ── DropIncomesTable ───────────────────────────────────────────────────────────

function DropIncomesTable() {
  const [statusFilter, setStatusFilter] = useState<DropIncomeStatus | 'all'>('all')
  const [periodFilter, setPeriodFilter] = useState<Period>('all')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 20

  const dates = periodToDates(periodFilter)
  const resolvedStatus = statusFilter === 'all' ? undefined : statusFilter
  const { data, isLoading } = useDropIncomes({
    ...(resolvedStatus !== undefined ? { status: resolvedStatus } : {}),
    page,
    limit: PAGE_SIZE,
    ...dates,
  })

  const hasFilters = statusFilter !== 'all' || periodFilter !== 'all'

  function resetFilters() {
    setStatusFilter('all')
    setPeriodFilter('all')
    setPage(1)
  }

  const incomes: DropIncomeDto[] = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <Card className="border-border/40 bg-card" data-testid="drop-incomes-table">
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            МОИ ПРИХОДЫ
          </span>

          {/* Filters */}
          <div className="flex gap-2 flex-wrap">
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as DropIncomeStatus | 'all')
                setPage(1)
              }}
            >
              <SelectTrigger
                className="h-8 text-xs w-auto min-w-32"
                data-testid="drop-filter-status"
              >
                <SelectValue placeholder="Все статусы" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все статусы</SelectItem>
                <SelectItem value="pending">Ожидает</SelectItem>
                <SelectItem value="validated">Валидирован</SelectItem>
                <SelectItem value="paid">Оплачен</SelectItem>
                <SelectItem value="rejected">Отклонён</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={periodFilter}
              onValueChange={(v) => {
                setPeriodFilter(v as Period)
                setPage(1)
              }}
            >
              <SelectTrigger
                className="h-8 text-xs w-auto min-w-36"
                data-testid="drop-filter-period"
              >
                <SelectValue placeholder="Все периоды" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все периоды</SelectItem>
                <SelectItem value="current">Текущий месяц</SelectItem>
                <SelectItem value="prev">Прошлый месяц</SelectItem>
                <SelectItem value="3m">Последние 3 мес.</SelectItem>
              </SelectContent>
            </Select>

            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={resetFilters}
              >
                Сбросить фильтры
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-0 pb-4">
        {isLoading ? (
          <div className="px-5 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : incomes.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              {hasFilters ? 'Нет приходов по выбранным фильтрам.' : 'Приходов пока нет'}
            </p>
            {hasFilters && (
              <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={resetFilters}>
                Сбросить фильтры
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Дата</TableHead>
                  <TableHead className="text-xs">Компания</TableHead>
                  <TableHead className="text-xs">Сумма</TableHead>
                  <TableHead className="text-xs">Тип</TableHead>
                  <TableHead className="text-xs">Статус</TableHead>
                  <TableHead className="text-xs">Действие</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incomes.map((income) => (
                  <TableRow key={income.id} data-testid={`drop-income-row-${income.id}`}>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {fmtDate(income.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">{income.companyName}</TableCell>
                    <TableCell className="text-sm font-semibold tabular-nums">
                      {fmtUsd(income.amount)}
                      {/* task-drop-sees-own-obligations (security-review PR #523
                          round 1, MED-5): `amount` means TWO DIFFERENT things
                          depending on `model` — a declared row's amount is the
                          GROSS client payment (before the drop's share is split
                          out); an obligation row's amount is already the drop's
                          NET SHARE the company calculated and booked. Showing
                          both under one "Сумма" header without this label would
                          let a drop compare a $5,000 gross row against a $40
                          share row as if they were the same kind of number. */}
                      <span
                        className="block text-[10px] font-normal text-muted-foreground"
                        data-testid={`drop-income-amount-kind-${income.id}`}
                      >
                        {income.model === 'declared' ? 'Валовый приход' : 'Ваша доля'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <IncomeModelBadge model={income.model} />
                    </TableCell>
                    <TableCell>
                      <IncomeStatusBadge status={income.status} id={income.id} />
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-2 px-5 pt-3">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Предыдущая
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Следующая
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── DropPaymentsHistory ────────────────────────────────────────────────────────

function DropPaymentsHistory({
  payments,
  isLoading,
}: {
  payments: DropPaymentDto[] | undefined
  isLoading: boolean
}) {
  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="drop-payments-history-skeleton">
        <Skeleton className="h-8 w-40 rounded" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (!payments) return null

  return (
    <TooltipProvider>
      <Card className="border-border/40 bg-card" data-testid="drop-payments-history">
        <CardHeader className="pb-2 pt-4 px-5">
          <div className="flex items-center gap-2">
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              ПЛАТЕЖИ КОМПАНИИ
            </span>
          </div>
        </CardHeader>
        <CardContent className="px-5 pb-4">
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">Нет истории платежей</p>
          ) : (
            <ul className="space-y-3">
              {payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 flex-wrap"
                  data-testid={`drop-payment-row-${p.id}`}
                >
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtDate(p.createdAt)}
                  </span>
                  <span className="text-sm font-semibold tabular-nums">{fmtUsd(p.amount)}</span>

                  {p.txHash ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-mono text-xs text-muted-foreground truncate max-w-[120px] cursor-default">
                          {p.txHash}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="font-mono text-xs">
                        {p.txHash}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}

                  <PaymentStatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  )
}

// ── DropFinancePage (main export) ──────────────────────────────────────────────

export function DropFinancePage() {
  const qc = useQueryClient()
  const { data: summary, isLoading: summaryLoading, isError: summaryError } = useDropSummary()
  const { data: payments, isLoading: paymentsLoading } = useDropPayments()
  // task-drop-phase3-frontend: canonical «Зарегистрировать приход» action.
  // This ghost button mirrors DropQuickActions on /routing — a contextual
  // shortcut for when the DROP is already on the finance page.
  const [showCreate, setShowCreate] = useState(false)

  return (
    <div className="space-y-6" data-testid="drop-finance-page">
      {/* Page header */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCreate(true)}
          data-testid="drop-register-income-btn"
        >
          <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
          Зарегистрировать приход
        </Button>
      </div>
      <CreateTransactionDialog open={showCreate} onClose={() => setShowCreate(false)} />

      {/* Balance summary (variant=full) */}
      <DropBalanceCard
        summary={summary}
        isLoading={summaryLoading}
        isError={summaryError}
        onRetry={() => void qc.invalidateQueries({ queryKey: DROP_SUMMARY_QUERY_KEY })}
        variant="full"
      />

      {/* Incomes table with filters + pagination */}
      <DropIncomesTable />

      {/* Payments history */}
      <DropPaymentsHistory payments={payments} isLoading={paymentsLoading} />
    </div>
  )
}
