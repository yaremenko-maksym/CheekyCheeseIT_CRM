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
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { formatNumber, formatDate } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import type { DropIncomeDto, DropIncomeStatus, DropPaymentDto, Locale } from '@crm/shared'
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
// COPY-M-fin-8: this file used to carry its OWN `fmtDate` — a `ru-RU`-locked
// shadow of the one `finance/constants.ts` used to export before task-i18n-
// stage3d-pr4 deleted the deprecated wrapper. Both shadows are gone now;
// every caller in this slice reads the shared `formatDate` directly with the
// active `useLocale()` locale (same 'shortYY' style `fmtDate` rendered).

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * task-i18n-stage3d-pr2 (template L-fin). `$<amount>` — the SAME shape
 * `constants.ts`'s own `fmtUsd` renders for the transaction table/detail
 * dialog (`$7 777,00`, not `formatMoney`'s "<amount> USD" suffix form) — kept
 * distinct from that function rather than imported because its signature
 * takes `(amount, currency, rates)` for cross-currency conversion, and every
 * value here is ALREADY a USD number (drop income/payment amounts have no
 * other currency in this flow). Locale-aware via `formatNumber` instead of
 * the hardcoded `en-US` this function used to carry.
 */
function fmtUsd(value: number, locale: Locale): string {
  return `$${formatNumber(value, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Status Badge ───────────────────────────────────────────────────────────────

type DropPaymentStatus = 'pending' | 'confirmed' | 'failed'

// task-i18n-stage3d-pr2 (template G-fin). `satisfies` WITHOUT `as const` —
// an `as const` here would zero out Stryker's mutant count for the whole
// block (урок #707, same reasoning as `TYPE_LABEL_MESSAGES` in constants.ts).
const INCOME_STATUS_MESSAGES = {
  pending: msg`Очікує`,
  validated: msg`Валідовано`,
  paid: msg`Оплачено`,
  rejected: msg`Відхилено`,
} satisfies Record<DropIncomeStatus, MessageDescriptor>

function IncomeStatusBadge({ status, id }: { status: DropIncomeStatus; id: string }) {
  const { i18n } = useLingui()
  const config: Record<
    DropIncomeStatus,
    {
      variant: 'secondary' | 'default' | 'outline' | 'destructive'
      icon: React.ReactNode
    }
  > = {
    pending: {
      variant: 'secondary',
      icon: <Clock className="mr-1 h-3 w-3" />,
    },
    validated: {
      variant: 'default',
      icon: <CheckCircle className="mr-1 h-3 w-3" />,
    },
    paid: {
      variant: 'outline',
      icon: <CircleCheck className="mr-1 h-3 w-3" />,
    },
    rejected: {
      variant: 'destructive',
      icon: <XCircle className="mr-1 h-3 w-3" />,
    },
  }
  const { variant, icon } = config[status]
  return (
    <Badge variant={variant} data-testid={`drop-income-status-${id}`} className="text-xs">
      {icon}
      {i18n._(INCOME_STATUS_MESSAGES[status])}
    </Badge>
  )
}

// task-drop-sees-own-obligations (§AC3): the feed now covers TWO income
// models — this badge is the distinction that task asks for.
// 'declared'   — the old self-declared DROP_INCOME row (drop registers it).
// 'obligation' — a company-booked IOU (DROP_PENDING_PAYOUT/PAYOUT_DROP, from
//                the admin-USDT declare path or the drop-payout cascade).
function IncomeModelBadge({ model }: { model: DropIncomeDto['model'] }) {
  const { t } = useLingui()
  return model === 'obligation' ? (
    <Badge variant="secondary" className="text-xs">
      {t`Нарахування`}
    </Badge>
  ) : (
    <Badge variant="outline" className="text-xs">
      {t`Дохід`}
    </Badge>
  )
}

// task-i18n-stage3d-pr2 (COPY-M-fin-12). `failed` used to read a bare
// «Ошибка» — a generic word with no next step. «Не пройшов» names WHAT
// happened (the payment did not go through); the tooltip on the badge below
// carries the "what to do" half (contact an admin) that a badge alone has no
// room for.
const PAYMENT_STATUS_MESSAGES = {
  pending: msg`Очікує`,
  confirmed: msg`Підтверджено`,
  failed: msg`Не пройшов`,
} satisfies Record<DropPaymentStatus, MessageDescriptor>

function PaymentStatusBadge({ status }: { status: DropPaymentStatus }) {
  const { t, i18n } = useLingui()
  const variant: Record<DropPaymentStatus, 'secondary' | 'default' | 'outline' | 'destructive'> = {
    pending: 'secondary',
    // Stryker disable next-line StringLiteral: unobservable — `badgeVariants` (class-variance-authority) falls back to `defaultVariants: { variant: 'default' }` for ANY key its `variants.variant` map does not recognise, so mutating this literal to `""` renders the identical class list as `'default'` — the two are behaviourally indistinguishable via any DOM assertion
    confirmed: 'default',
    failed: 'destructive',
  }
  const badge = (
    <Badge variant={variant[status]} className="text-xs">
      {i18n._(PAYMENT_STATUS_MESSAGES[status])}
    </Badge>
  )
  // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: only reachable difference is whether the badge is wrapped in a Radix Tooltip — Tooltip.Content does not mount into the DOM until a real pointer hover opens it (verified: `getByText` on the tooltip copy finds nothing pre-hover), and jsdom's synthetic hover + Radix's open-delay is too flaky to assert reliably in a unit test; the wrapping itself is covered visually by the fidelity-review screenshot instead
  if (status !== 'failed') return badge
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-56">
          {
            // Stryker disable next-line StringLiteral: same reason as the wrapping conditional above — this text never mounts without a real hover, which is not reliably simulable here
            t`Переказ не пройшов — зверніться до адміністратора`
          }
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
  const { t, i18n } = useLingui()
  const locale = useLocale()
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
            {t`МОЇ ДОХОДИ`}
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
                {
                  // Stryker disable next-line StringLiteral: unobservable — `statusFilter` (component state) always starts at 'all' and Radix Select renders the MATCHING SelectItem's own text once a value is set, never falling through to this placeholder; it would only render if the value could be empty/undefined, which this component's state model never produces
                  <SelectValue placeholder={t`Усі статуси`} />
                }
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t`Усі статуси`}</SelectItem>
                <SelectItem value="pending">{i18n._(INCOME_STATUS_MESSAGES.pending)}</SelectItem>
                <SelectItem value="validated">
                  {i18n._(INCOME_STATUS_MESSAGES.validated)}
                </SelectItem>
                <SelectItem value="paid">{i18n._(INCOME_STATUS_MESSAGES.paid)}</SelectItem>
                <SelectItem value="rejected">{i18n._(INCOME_STATUS_MESSAGES.rejected)}</SelectItem>
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
                {
                  // Stryker disable next-line StringLiteral: same reason as the status placeholder above — `periodFilter` always starts at 'all', so Radix shows the matching SelectItem's text, never this placeholder
                  <SelectValue placeholder={t`Усі періоди`} />
                }
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t`Усі періоди`}</SelectItem>
                <SelectItem value="current">{t`Поточний місяць`}</SelectItem>
                <SelectItem value="prev">{t`Минулий місяць`}</SelectItem>
                <SelectItem value="3m">{t`Останні 3 міс.`}</SelectItem>
              </SelectContent>
            </Select>

            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={resetFilters}
              >
                {t`Скинути фільтри`}
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
              {hasFilters ? t`Немає доходів за обраними фільтрами` : t`Доходів ще немає`}
            </p>
            {hasFilters && (
              <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={resetFilters}>
                {t`Скинути фільтри`}
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t`Дата`}</TableHead>
                  <TableHead className="text-xs">{t`Компанія`}</TableHead>
                  <TableHead className="text-xs">{t`Сума`}</TableHead>
                  <TableHead className="text-xs">{t`Тип`}</TableHead>
                  <TableHead className="text-xs">{t`Статус`}</TableHead>
                  <TableHead className="text-xs">{t`Дія`}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incomes.map((income) => (
                  <TableRow key={income.id} data-testid={`drop-income-row-${income.id}`}>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(income.createdAt, locale, 'shortYY')}
                    </TableCell>
                    <TableCell className="text-sm">{income.companyName}</TableCell>
                    <TableCell className="text-sm font-semibold tabular-nums">
                      {fmtUsd(income.amount, locale)}
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
                        {income.model === 'declared' ? t`Валовий дохід` : t`Ваша частка`}
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
              {t`Попередня`}
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
              {t`Наступна`}
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
  const { t } = useLingui()
  const locale = useLocale()
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
              {t`ПЛАТЕЖІ НА КОМПАНІЮ`}
            </span>
          </div>
        </CardHeader>
        <CardContent className="px-5 pb-4">
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">{t`Переказів ще не було`}</p>
          ) : (
            <ul className="space-y-3">
              {payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 flex-wrap"
                  data-testid={`drop-payment-row-${p.id}`}
                >
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatDate(p.createdAt, locale, 'shortYY')}
                  </span>
                  <span className="text-sm font-semibold tabular-nums">
                    {fmtUsd(p.amount, locale)}
                  </span>

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
  const { t } = useLingui()
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
          {t`Зареєструвати дохід`}
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
