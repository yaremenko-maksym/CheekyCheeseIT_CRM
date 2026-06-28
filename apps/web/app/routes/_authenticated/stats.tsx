import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDownLeft,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Clock,
  Coins,
  DollarSign,
  HelpCircle,
  Info,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import type {
  FinanceSummaryDto,
  IncomeComplianceOverviewDto,
  IncomeComplianceReceiverDto,
} from '@crm/shared'
import { useAuth } from '@/context/auth'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { financeApi, companyAccountApi } from './finance/api'

const FinanceChart = lazy(() =>
  import('@/components/stats/FinanceChart').then((m) => ({ default: m.FinanceChart })),
)

export const Route = createFileRoute('/_authenticated/stats')({
  component: StatsPage,
})

// USDT balance formatting + short address — mirrors the (removed) CompanyAccountCard
// so the company-account KPI reads identically on /stats.
function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

// ── KPI card with tooltip ──────────────────────────────────────────────────────

function StatCard({
  title,
  hint,
  value,
  sub,
  icon,
  color = 'default',
  trend,
  testId,
}: {
  title: string
  hint: string
  value: string
  sub?: string
  icon: React.ReactNode
  color?: 'default' | 'green' | 'red' | 'blue' | 'yellow' | 'purple' | 'cyan'
  trend?: { value: number; label: string }
  testId?: string
}) {
  const colorMap: Record<string, string> = {
    default: 'text-foreground',
    green: 'text-green-500',
    red: 'text-red-500',
    blue: 'text-blue-500',
    yellow: 'text-yellow-500',
    purple: 'text-purple-500',
    cyan: 'text-cyan-500',
  }
  const bgMap: Record<string, string> = {
    default: 'bg-muted',
    green: 'bg-green-500/10',
    red: 'bg-red-500/10',
    blue: 'bg-blue-500/10',
    yellow: 'bg-yellow-500/10',
    purple: 'bg-purple-500/10',
    cyan: 'bg-cyan-500/10',
  }

  return (
    <Card {...(testId ? { 'data-testid': testId } : {})}>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground">{title}</p>
              <TooltipProvider delayDuration={200}>
                <UITooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-3 w-3 text-muted-foreground/50 cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-56 text-xs leading-relaxed">
                    {hint}
                  </TooltipContent>
                </UITooltip>
              </TooltipProvider>
            </div>
            <p className={cn('text-2xl font-bold tabular-nums', colorMap[color])}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
            {trend && (
              <div
                className={cn(
                  'flex items-center gap-1 text-xs font-medium',
                  trend.value >= 0 ? 'text-green-500' : 'text-red-500',
                )}
              >
                {trend.value >= 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {trend.value >= 0 ? '+' : ''}
                {trend.value.toFixed(1)}% {trend.label}
              </div>
            )}
          </div>
          <div className={cn('rounded-lg p-2 shrink-0', bgMap[color], colorMap[color])}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  )
}
// ── Combined Company + Partners balance card ──────────────────────────────────
// Merges CompanyAccountKpi (USDT счёт компании) and PartnerBalancesCard into
// one Card with two sections separated by a divider. Shown for both ADMIN and
// ACCOUNTANT; the partner-balances section renders only for ADMIN.

function CompanyAndPartnersCard({
  summary,
  isAdmin,
}: {
  summary: FinanceSummaryDto
  isAdmin: boolean
}) {
  const { data: account, isLoading: accountLoading } = useQuery({
    queryKey: ['company-account'],
    queryFn: companyAccountApi.getAccount,
  })

  const partnerData = isAdmin && summary.adminBalances.length > 0 ? summary : null
  const sorted = partnerData
    ? [...partnerData.adminBalances].sort((a, b) => b.balance - a.balance)
    : []
  const [rich, poor] = sorted.length >= 2 ? [sorted[0]!, sorted[sorted.length - 1]!] : [null, null]
  const debt =
    rich && poor && rich.userId !== poor.userId ? Math.abs(rich.balance - poor.balance) / 2 : 0
  const total = sorted.reduce((s, b) => s + b.balance, 0)
  const isSettled = debt <= 0.01

  return (
    <Card className="overflow-hidden flex flex-col" data-testid="stats-company-partners-card">
      {/* ── Секция 1: Счёт компании (USDT) ── */}
      <div data-testid="stats-company-account-balance">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Coins className="h-4 w-4 text-yellow-500" aria-hidden="true" />
              Счёт компании · USDT
            </CardTitle>
            <TooltipProvider delayDuration={200}>
              <UITooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/40 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-60 text-xs leading-relaxed">
                  Накопленный USDT-баланс на счёте компании — пополняется через подтверждённые
                  выплаты (метод «Счёт компании») и уменьшается выводом дивидендов.
                </TooltipContent>
              </UITooltip>
            </TooltipProvider>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {accountLoading ? (
            <div className="space-y-1.5">
              <div className="h-7 w-32 rounded-md bg-muted animate-pulse" />
              <div className="h-3.5 w-24 rounded bg-muted animate-pulse" />
            </div>
          ) : (
            <div className="space-y-0.5">
              <p className="text-2xl font-bold tabular-nums text-yellow-500">
                {account ? `${fmtUsdt(account.balance)} USDT` : '—'}
              </p>
              {account?.walletAddress && (
                <p className="text-xs text-muted-foreground font-mono">
                  {shortAddress(account.walletAddress)}
                </p>
              )}
              {!account?.walletAddress && (
                <p className="text-xs text-muted-foreground">Кошелёк не настроен</p>
              )}
            </div>
          )}
        </CardContent>
      </div>

      {/* ── Секция 2: Балансы партнёров (только ADMIN) ── */}
      {isAdmin && sorted.length > 0 && (
        <>
          <div className="h-px bg-border/60 mx-4" />
          <CardHeader className="pb-2 pt-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-semibold">Балансы партнёров</CardTitle>
                <TooltipProvider delayDuration={200}>
                  <UITooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/40 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-60 text-xs leading-relaxed">
                      Накопленный баланс каждого партнёра: входящие PAYOUT_ADMIN + ADMIN_INCOME
                      минус исходящие ADMIN_TRANSFER (все со статусом PAID).
                    </TooltipContent>
                  </UITooltip>
                </TooltipProvider>
              </div>
              <span className="text-xs text-muted-foreground">
                Итого:{' '}
                <span className="font-semibold text-foreground">
                  $
                  {total.toLocaleString('en-US', {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </span>
              </span>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3" data-testid="stats-partner-balances">
            {/* Balance bars */}
            <div className="space-y-2.5">
              {sorted.map((ab, i) => {
                const pct = total > 0 ? Math.round((ab.balance / total) * 100) : 50
                const isLeading = i === 0
                return (
                  <div key={ab.userId} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div
                          className={cn(
                            'h-2.5 w-2.5 rounded-full shrink-0',
                            isLeading ? 'bg-violet-500' : 'bg-sky-500',
                          )}
                        />
                        <span className="font-medium">{ab.displayName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{pct}%</span>
                        <span
                          className={cn(
                            'font-bold tabular-nums',
                            ab.balance >= 0 ? 'text-foreground' : 'text-red-400',
                          )}
                        >
                          $
                          {ab.balance.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          isLeading ? 'bg-violet-500' : 'bg-sky-500',
                        )}
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="h-px bg-border/60" />

            {/* Settlement block */}
            {isSettled ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-500/8 border border-emerald-500/20 px-3 py-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 shrink-0">
                  <span className="text-sm">✓</span>
                </div>
                <div>
                  <div className="text-xs font-medium text-emerald-400">Балансы выровнены</div>
                  <div className="text-[10px] text-muted-foreground">Никто никому не должен</div>
                </div>
              </div>
            ) : rich && poor ? (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-amber-500/10">
                  <Info className="h-3 w-3 text-amber-400/70 shrink-0" />
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                    Для выравнивания
                  </span>
                </div>
                <div className="px-3 py-3 flex items-center gap-3">
                  {/* Sender */}
                  <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
                    <div className="h-8 w-8 rounded-full bg-violet-500/15 flex items-center justify-center text-xs font-bold text-violet-400">
                      {rich.displayName.charAt(0)}
                    </div>
                    <span className="text-[11px] font-medium text-center leading-tight truncate w-full text-center">
                      {rich.displayName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">отправляет</span>
                  </div>
                  {/* Arrow + amount */}
                  <div className="flex flex-col items-center gap-0.5 shrink-0">
                    <span className="text-lg font-black tabular-nums text-amber-400">
                      $
                      {debt.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                    <div className="flex items-center gap-0.5 text-amber-500/60">
                      <div className="h-px w-6 bg-amber-500/40" />
                      <ArrowRight className="h-3.5 w-3.5" />
                      <div className="h-px w-6 bg-amber-500/40" />
                    </div>
                    <span className="text-[10px] text-muted-foreground">USDT</span>
                  </div>
                  {/* Receiver */}
                  <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
                    <div className="h-8 w-8 rounded-full bg-sky-500/15 flex items-center justify-center text-xs font-bold text-sky-400">
                      {poor.displayName.charAt(0)}
                    </div>
                    <span className="text-[11px] font-medium text-center leading-tight truncate w-full text-center">
                      {poor.displayName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">получает</span>
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </>
      )}
    </Card>
  )
}

// ── Computed stats helpers ─────────────────────────────────────────────────────

function computeExtraStats(summary: FinanceSummaryDto) {
  const months = summary.monthly
  if (!months.length) return null

  const lastMonth = months[months.length - 1]!
  const prevMonth = months.length >= 2 ? months[months.length - 2] : null

  const incomeTrend =
    prevMonth && prevMonth.income > 0
      ? ((lastMonth.income - prevMonth.income) / prevMonth.income) * 100
      : null

  const profitMargin = lastMonth.income > 0 ? (lastMonth.profit / lastMonth.income) * 100 : null

  const avgMonthlyIncome = months.reduce((s, m) => s + m.income, 0) / months.length
  const avgMonthlyProfit = months.reduce((s, m) => s + m.profit, 0) / months.length

  const bestMonth = [...months].sort((a, b) => b.income - a.income)[0]!

  return {
    lastMonth,
    prevMonth,
    incomeTrend,
    profitMargin,
    avgMonthlyIncome,
    avgMonthlyProfit,
    bestMonth,
  }
}

// ── Income compliance «Контроль приходов» (task-income-compliance) ────────────
//
// ADMIN + ACCOUNTANT see this on /stats: a company-wide list of income
// receivers (seniors + admin-as-senior + drops with active projects) with an
// «X/N приходов за месяц» progress bar and an expand drawer of the projects
// WITHOUT a counted (VALIDATED|PAID) income. Laggards (least coverage) on top.
// Fed by GET /api/finance/income-compliance — an RBAC-gated aggregate, so this
// section never renders for a non-privileged viewer (the whole /stats route
// is already ADMIN/ACCOUNTANT-only). NOT in the persist allow-list (financial
// data is never written to disk — the query is volatile by default).

const ROLE_LABEL: Record<IncomeComplianceReceiverDto['role'], string> = {
  SENIOR: 'Senior',
  ADMIN_SENIOR: 'Admin-Senior',
  DROP: 'Посредник',
}

function receiverInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

// Status accent per receiver coverage: complete (green) / has-pending (amber) /
// lagging-no-pending (red). Drives the left accent bar, dot and badge.
function receiverStatus(r: IncomeComplianceReceiverDto): 'complete' | 'pending' | 'lagging' {
  if (r.submitted >= r.expected) return 'complete'
  if (r.pendingCount > 0 && r.pendingCount >= r.expected - r.submitted) return 'pending'
  return 'lagging'
}

function ComplianceKpi({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub: string
  color: 'default' | 'green' | 'red' | 'amber'
}) {
  const valueColor: Record<string, string> = {
    default: 'text-foreground',
    green: 'text-green-500',
    red: 'text-red-500',
    amber: 'text-amber-500',
  }
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-bold tabular-nums mt-1', valueColor[color])}>{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  )
}

function ComplianceReceiverRow({ receiver }: { receiver: IncomeComplianceReceiverDto }) {
  const [open, setOpen] = useState(false)
  const status = receiverStatus(receiver)
  const pct =
    receiver.expected > 0 ? Math.round((receiver.submitted / receiver.expected) * 100) : 100
  const hasMissing = receiver.missingProjects.length > 0

  const accent: Record<typeof status, string> = {
    complete: 'border-l-green-500',
    pending: 'border-l-amber-500',
    lagging: 'border-l-red-500',
  }
  const dot: Record<typeof status, string> = {
    complete: 'bg-green-500',
    pending: 'bg-amber-500',
    lagging: 'bg-red-500',
  }
  const bar: Record<typeof status, string> = {
    complete: 'bg-green-500',
    pending: 'bg-amber-500',
    lagging: 'bg-red-500',
  }
  const badge =
    status === 'complete'
      ? { text: 'Все получены', cls: 'bg-green-500/10 text-green-500' }
      : receiver.pendingCount > 0
        ? {
            text:
              receiver.pendingCount === 1
                ? 'На валидации'
                : `${receiver.pendingCount} на валидации`,
            cls: 'bg-amber-500/10 text-amber-500',
          }
        : {
            text:
              receiver.submitted === 0
                ? 'Нет приходов'
                : `${receiver.expected - receiver.submitted} без прихода`,
            cls: 'bg-red-500/10 text-red-500',
          }

  return (
    <div
      className={cn('rounded-lg border border-l-2 bg-card overflow-hidden', accent[status])}
      data-testid={`compliance-row-${receiver.userId}`}
    >
      <button
        type="button"
        onClick={() => hasMissing && setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 text-left',
          hasMissing ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default',
        )}
        aria-expanded={hasMissing ? open : undefined}
        data-testid={`compliance-toggle-${receiver.userId}`}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">
          {receiverInitials(receiver.displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full shrink-0', dot[status])} />
            <span className="font-medium truncate">{receiver.displayName}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {ROLE_LABEL[receiver.role]} · {receiver.expected} актив.{' '}
            {receiver.expected === 1 ? 'проект' : 'проекта'}
          </span>
        </div>

        {/* Progress bar */}
        <div className="hidden sm:block w-32 shrink-0">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', bar[status])}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
        </div>

        <span className={cn('rounded px-2 py-0.5 text-[11px] font-medium shrink-0', badge.cls)}>
          {badge.text}
        </span>
        <span className="tabular-nums text-sm font-semibold w-10 text-right shrink-0">
          {receiver.submitted}/{receiver.expected}
        </span>
        {hasMissing ? (
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground shrink-0 transition-transform',
              open && 'rotate-180',
            )}
          />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-green-500/70 shrink-0" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasMissing && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div
              className="border-t border-border/60 px-3 py-2.5"
              data-testid={`compliance-detail-${receiver.userId}`}
            >
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Проекты без засчитанного прихода
              </p>
              <ul className="space-y-1.5">
                {receiver.missingProjects.map((p) => (
                  <li key={p.projectId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full shrink-0',
                          p.pendingValidation ? 'bg-amber-500' : 'bg-red-500',
                        )}
                      />
                      <span className="truncate font-medium">{p.name}</span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground truncate max-w-32">
                        {p.companyName}
                      </span>
                      <span
                        className={cn(
                          'text-xs font-medium',
                          p.pendingValidation ? 'text-amber-500' : 'text-red-500',
                        )}
                      >
                        {p.pendingValidation ? 'На валидации' : 'Нет прихода'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function IncomeComplianceSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['income-compliance'],
    queryFn: () => financeApi.getIncomeCompliance(),
    // Financial aggregate — avoid refetching on every window focus.
    staleTime: 60_000,
  })

  return (
    <section className="space-y-4" data-testid="income-compliance-section">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Контроль приходов
        </h2>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : isError ? (
        <p className="text-sm text-muted-foreground" data-testid="income-compliance-error">
          Не удалось загрузить данные контроля приходов.
        </p>
      ) : data ? (
        <IncomeComplianceBody data={data} />
      ) : null}
    </section>
  )
}

function IncomeComplianceBody({ data }: { data: IncomeComplianceOverviewDto }) {
  const { totals, receivers, month } = data
  const coverage =
    totals.expectedProjects > 0
      ? Math.round((totals.submittedProjects / totals.expectedProjects) * 100)
      : 100

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <ComplianceKpi
          label="Всего приходов"
          value={`${totals.submittedProjects} / ${totals.expectedProjects}`}
          sub={`${coverage}% покрытие · ${month}`}
          color="default"
        />
        <ComplianceKpi
          label="Закрыты полностью"
          value={String(totals.completeReceivers)}
          sub={totals.completeReceivers === 1 ? 'получатель' : 'получателей'}
          color="green"
        />
        <ComplianceKpi
          label="Отстают"
          value={String(totals.laggingReceivers)}
          sub={totals.laggingReceivers === 1 ? 'получатель' : 'получателей'}
          color="red"
        />
        <ComplianceKpi
          label="На валидации у бухгалтера"
          value={String(totals.pendingProjects)}
          sub={totals.pendingProjects === 1 ? 'приход' : 'приходов'}
          color="amber"
        />
      </div>

      {/* Receiver list — laggards first (already sorted by the API) */}
      {receivers.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Нет активных проектов-получателей дохода за {month}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1" data-testid="compliance-list">
          {receivers.map((r) => (
            <ComplianceReceiverRow key={r.userId} receiver={r} />
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/60">
        Засчитывается приход в статусе «валидирован» или «выплачен» за текущий месяц. Фаза 2: ручные
        исключения (пауза / отпуск) и автоматические напоминания.
      </p>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

// Exported for the role-split unit test (stats.test.tsx). The route still binds
// it via `Route.component = StatsPage` below.
export function StatsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  // ACCOUNTANT joins ADMIN as a viewer on /stats, but sees ONLY the
  // economic part (P&L: income / expenses / salaries / Net / profit + charts +
  // monthly breakdown). The employee/partner-level sections — participants
  // balances, the partner-balances settlement card, and the future
  // HR/Команда/Проекты placeholders — stay ADMIN-only (`isAdmin`). Other roles
  // are bounced to the dashboard at / (defense-in-depth over the route-access guard).
  // task-accountant-stats: economic data is the accountant's profile surface;
  // employee-level balances must never leak to ACCOUNTANT here.
  const isPrivilegedViewer = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'
  const isAdmin = user?.role === 'ADMIN'

  useEffect(() => {
    if (user && !isPrivilegedViewer) {
      void navigate({ to: '/' })
    }
  }, [user, isPrivilegedViewer, navigate])

  const { data: summary, isLoading } = useQuery({
    queryKey: ['finance-summary'],
    queryFn: financeApi.getSummary,
    enabled: isPrivilegedViewer,
  })

  if (!user || !isPrivilegedViewer) return null

  const extra = useMemo(() => (summary ? computeExtraStats(summary) : null), [summary])

  return (
    <div
      className="flex flex-col h-full"
      data-testid={isAdmin ? 'stats-page-admin' : 'stats-page-accountant'}
    >
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <div className="space-y-8">
          {/* ── Finance section (economic — ADMIN + ACCOUNTANT) ── */}
          <section className="space-y-4" data-testid="stats-finance-section">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Финансы
              </h2>
            </div>

            {isLoading ? (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 rounded-xl" />
                ))}
              </div>
            ) : summary ? (
              <>
                {/* Primary KPIs */}
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatCard
                    title="Общий доход"
                    hint="Сумма всех оплаченных транзакций типа ADMIN_INCOME и SENIOR_INCOME за всё время."
                    value={`$${summary.totalIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<TrendingUp className="h-5 w-5" />}
                    color="green"
                    {...(extra?.incomeTrend !== null && extra?.incomeTrend !== undefined
                      ? { trend: { value: extra.incomeTrend, label: 'vs пред. месяц' } }
                      : {})}
                  />
                  <StatCard
                    title="Расходы"
                    hint="Сумма всех оплаченных транзакций типа EXPENSE — операционные расходы компании."
                    value={`$${summary.totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<ArrowDownLeft className="h-5 w-5" />}
                    color="red"
                  />
                  <StatCard
                    title="Зарплаты"
                    hint="Сумма всех оплаченных зарплат (SALARY) сотрудникам компании за всё время."
                    value={`$${summary.totalSalaries.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<Users className="h-5 w-5" />}
                    color="purple"
                  />
                  <StatCard
                    title="Net balance"
                    hint="Чистый остаток: доход минус расходы и зарплаты. Положительное значение = компания в плюсе."
                    value={`$${summary.netBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<Wallet className="h-5 w-5" />}
                    color={summary.netBalance >= 0 ? 'blue' : 'red'}
                  />
                </div>

                {/* Secondary KPIs */}
                {extra && (
                  <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    <StatCard
                      title="Доход за последний месяц"
                      hint={`Выручка за ${extra.lastMonth.month}. Включает доходы всех синьоров и админов.`}
                      value={`$${extra.lastMonth.income.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<BarChart3 className="h-5 w-5" />}
                      color="green"
                      sub={extra.lastMonth.month}
                    />
                    <StatCard
                      title="Прибыль за последний месяц"
                      hint={`Чистая прибыль за ${extra.lastMonth.month}: доход минус расходы и зарплаты того месяца.`}
                      value={`$${extra.lastMonth.profit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<TrendingUp className="h-5 w-5" />}
                      color={extra.lastMonth.profit >= 0 ? 'cyan' : 'red'}
                      {...(extra.profitMargin !== null
                        ? { sub: `Маржа: ${extra.profitMargin.toFixed(1)}%` }
                        : {})}
                    />
                    <StatCard
                      title="Средний доход / мес."
                      hint="Среднемесячная выручка за всё время работы компании."
                      value={`$${extra.avgMonthlyIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<Clock className="h-5 w-5" />}
                      color="blue"
                      sub={`за ${summary.monthly.length} мес.`}
                    />
                    <StatCard
                      title="Лучший месяц"
                      hint="Месяц с наибольшей выручкой за всё время."
                      value={`$${extra.bestMonth.income.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<TrendingUp className="h-5 w-5" />}
                      color="yellow"
                      sub={extra.bestMonth.month}
                    />
                  </div>
                )}

                {/* Chart + Company & Partners balance block (combined card).
                USDT company balance (all privileged viewers) + partner balances
                (ADMIN-only) are unified in one sidebar card next to the chart.
                Chart is always lg:col-span-2. */}
                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    <Suspense fallback={<Skeleton className="h-72 w-full rounded-xl" />}>
                      <FinanceChart summary={summary} />
                    </Suspense>
                  </div>
                  <CompanyAndPartnersCard summary={summary} isAdmin={isAdmin} />
                </div>
              </>
            ) : null}
          </section>

          {/* ── Income compliance «Контроль приходов» (ADMIN + ACCOUNTANT) ──
          Company-wide tracker of which income receivers have registered a
          counted income per active project this month. Placed after the main
          financial KPIs so the key P&L numbers are seen first. */}
          <IncomeComplianceSection />

          {/* Future sections placeholder (ADMIN-only — HR/Команда/Проекты analytics
          are not part of the accountant's economic surface). */}
          {isAdmin && (
            <section className="space-y-4" data-testid="stats-placeholders-section">
              <div className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-muted-foreground/40" />
                <h2 className="text-sm font-semibold text-muted-foreground/40 uppercase tracking-wider">
                  Другие разделы
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {['HR — воронка собеседований', 'Команда — активность', 'Проекты — загрузка'].map(
                  (label) => (
                    <div
                      key={label}
                      className="rounded-xl border border-dashed border-border/50 p-6 text-center text-sm text-muted-foreground/40"
                    >
                      {label}
                    </div>
                  ),
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
