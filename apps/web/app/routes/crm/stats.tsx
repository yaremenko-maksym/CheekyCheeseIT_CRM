import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { PageHeader } from '@/components/crm/StickyPageHeader'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownLeft,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Clock,
  DollarSign,
  HelpCircle,
  Info,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  FinanceSummaryDto,
  IncomeComplianceOverviewDto,
  IncomeComplianceReceiverDto,
} from '@crm/shared'
import { useAuth } from '@/context/auth'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { financeApi } from './finance/api'

export const Route = createFileRoute('/crm/stats')({
  component: StatsPage,
})

// ── KPI card with tooltip ──────────────────────────────────────────────────────

function StatCard({
  title,
  hint,
  value,
  sub,
  icon,
  color = 'default',
  trend,
}: {
  title: string
  hint: string
  value: string
  sub?: string
  icon: React.ReactNode
  color?: 'default' | 'green' | 'red' | 'blue' | 'yellow' | 'purple' | 'cyan'
  trend?: { value: number; label: string }
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
    <Card>
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

// ── Partner balance card ───────────────────────────────────────────────────────

function PartnerBalancesCard({ summary }: { summary: FinanceSummaryDto }) {
  if (!summary.adminBalances.length) return null

  const sorted = [...summary.adminBalances].sort((a, b) => b.balance - a.balance)
  const [rich, poor] = [sorted[0], sorted[sorted.length - 1]]
  const debt =
    rich && poor && rich.userId !== poor.userId ? Math.abs(rich.balance - poor.balance) / 2 : 0
  const total = sorted.reduce((s, b) => s + b.balance, 0)
  const isSettled = debt <= 0.01

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm font-semibold">Балансы партнёров</CardTitle>
            <TooltipProvider delayDuration={200}>
              <UITooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/40 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-60 text-xs leading-relaxed">
                  Накопленный баланс каждого партнёра: входящие PAYOUT_ADMIN + ADMIN_INCOME минус
                  исходящие ADMIN_TRANSFER (все со статусом PAID).
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

      <CardContent className="px-4 pb-4 space-y-3">
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
    </Card>
  )
}

// ── Chart ──────────────────────────────────────────────────────────────────────

type ChartMode = 'income' | 'expenses' | 'salary' | 'profit'

const CHART_MODES: { value: ChartMode; label: string; key: string; color: string }[] = [
  { value: 'income', label: 'Приходы', key: 'Доход', color: '#22c55e' },
  { value: 'profit', label: 'Прибыль', key: 'Прибыль', color: '#06b6d4' },
  { value: 'expenses', label: 'Расходы', key: 'Расходы', color: '#f97316' },
  { value: 'salary', label: 'Зарплаты', key: 'Зарплаты', color: '#a855f7' },
]

const BAR_WIDTH = 80
const Y_AXIS_WIDTH = 56

function ChartTooltip(props: Record<string, unknown>) {
  const active = props.active as boolean | undefined
  const label = props.label as string | undefined
  const payload = props.payload as { dataKey: string; value: number; color: string }[] | undefined

  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border bg-popover/95 backdrop-blur-sm shadow-xl p-3 text-xs min-w-40">
      <p className="font-semibold text-foreground mb-2">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm shrink-0"
              style={{ background: entry.color }}
            />
            {entry.dataKey}
          </span>
          <span className="font-medium tabular-nums text-foreground">
            $
            {entry.value.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>
      ))}
    </div>
  )
}

function FinanceChart({ summary }: { summary: FinanceSummaryDto }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ChartMode>('income')

  const chartData = summary.monthly.map((m) => ({
    month: m.month,
    Доход: m.income,
    Расходы: m.expenses,
    Зарплаты: m.salaries,
    Прибыль: m.profit,
  }))

  const effectiveMode = CHART_MODES.find((m) => m.value === mode) ?? CHART_MODES[0]!
  const total = chartData.length
  const chartWidth = Math.max(total * BAR_WIDTH, 300)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [total])

  const handleWheel = useCallback((e: WheelEvent) => {
    const el = scrollRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    e.preventDefault()
    e.stopPropagation()
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    el.scrollLeft += delta
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const el = scrollRef.current
    if (!el) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      el.scrollLeft += BAR_WIDTH
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      el.scrollLeft -= BAR_WIDTH
    }
    if (e.key === 'Home') {
      e.preventDefault()
      el.scrollLeft = 0
    }
    if (e.key === 'End') {
      e.preventDefault()
      el.scrollLeft = el.scrollWidth
    }
  }, [])

  const dragRef = useRef<{ startX: number; scrollLeft: number } | null>(null)
  const handleMouseDown = (e: React.MouseEvent) => {
    const el = scrollRef.current
    if (!el) return
    dragRef.current = { startX: e.clientX, scrollLeft: el.scrollLeft }
    el.style.cursor = 'grabbing'
    el.style.userSelect = 'none'
  }
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragRef.current
    const el = scrollRef.current
    if (!drag || !el) return
    el.scrollLeft = drag.scrollLeft + (drag.startX - e.clientX)
  }, [])
  const handleMouseUp = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    dragRef.current = null
    el.style.cursor = ''
    el.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const values = chartData.map((d) => d[effectiveMode.key as keyof typeof d] as number)
  const minVal = values.length ? Math.min(...values) : 0
  const maxVal = values.length ? Math.max(...values) : 0
  const hasNegative = minVal < 0
  const yPad = (maxVal - minVal) * 0.1 || Math.abs(minVal) * 0.1 || 10
  const yDomain: [number, number] = hasNegative
    ? [Math.floor(minVal - yPad), Math.ceil(maxVal + yPad)]
    : [0, Math.ceil(maxVal + yPad)]

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ background: effectiveMode.color }}
            />
            Динамика по месяцам
          </CardTitle>
          <Select value={effectiveMode.value} onValueChange={(v) => setMode(v as ChartMode)}>
            <SelectTrigger className="h-7 text-xs w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHART_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value} className="text-xs">
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="pb-3 px-3">
        {/* Fixed YAxis + scrollable bars side by side */}
        <div className="flex">
          {/* Static Y axis */}
          <div style={{ width: Y_AXIS_WIDTH, flexShrink: 0 }}>
            <ResponsiveContainer width={Y_AXIS_WIDTH} height={280}>
              <BarChart data={chartData} margin={{ top: 8, right: 0, bottom: 4, left: 0 }}>
                <YAxis
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                  }
                  width={Y_AXIS_WIDTH}
                  domain={yDomain}
                />
                <Bar dataKey={effectiveMode.key} fill="transparent" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Scrollable bars area — hidden scrollbar */}
          <div
            ref={scrollRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onMouseDown={handleMouseDown}
            className="flex-1 overflow-x-auto outline-none cursor-grab select-none"
            style={{
              touchAction: 'pan-x',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
          >
            <style>{`.finance-chart-scroll::-webkit-scrollbar { display: none; }`}</style>
            <div style={{ minWidth: chartWidth }}>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={chartData}
                  margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                  barCategoryGap="20%"
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    tickLine={false}
                    axisLine={{ stroke: '#334155' }}
                    height={28}
                  />
                  <YAxis domain={yDomain} hide />
                  {hasNegative && <ReferenceLine y={0} stroke="#334155" strokeWidth={1.5} />}
                  <Tooltip
                    cursor={false}
                    content={(props) => <ChartTooltip {...(props as Record<string, unknown>)} />}
                  />
                  <Bar
                    dataKey={effectiveMode.key}
                    fill={effectiveMode.color}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={32}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </CardContent>
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
// ADMIN + ACCOUNTANT see this on /crm/stats: a company-wide list of income
// receivers (seniors + admin-as-senior + drops with active projects) with an
// «X/N приходов за месяц» progress bar and an expand drawer of the projects
// WITHOUT a counted (VALIDATED|PAID) income. Laggards (least coverage) on top.
// Fed by GET /api/finance/income-compliance — an RBAC-gated aggregate, so this
// section never renders for a non-privileged viewer (the whole /crm/stats route
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

      {open && hasMissing && (
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
      )}
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
        <div className="space-y-2" data-testid="compliance-list">
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

  // ACCOUNTANT joins ADMIN as a viewer on /crm/stats, but sees ONLY the
  // economic part (P&L: income / expenses / salaries / Net / profit + charts +
  // monthly breakdown). The employee/partner-level sections — participants
  // balances, the partner-balances settlement card, and the future
  // HR/Команда/Проекты placeholders — stay ADMIN-only (`isAdmin`). Other roles
  // are bounced to the dashboard at /crm (defense-in-depth over the route-access guard).
  // task-accountant-stats: economic data is the accountant's profile surface;
  // employee-level balances must never leak to ACCOUNTANT here.
  const isPrivilegedViewer = user?.role === 'ADMIN' || user?.role === 'ACCOUNTANT'
  const isAdmin = user?.role === 'ADMIN'

  useEffect(() => {
    if (user && !isPrivilegedViewer) {
      void navigate({ to: '/crm' })
    }
  }, [user, isPrivilegedViewer, navigate])

  const { data: summary, isLoading } = useQuery({
    queryKey: ['finance-summary'],
    queryFn: financeApi.getSummary,
    enabled: isPrivilegedViewer,
  })

  if (!user || !isPrivilegedViewer) return null

  const extra = summary ? computeExtraStats(summary) : null

  return (
    <div
      className="flex flex-col h-full"
      data-testid={isAdmin ? 'stats-page-admin' : 'stats-page-accountant'}
    >
      <PageHeader>
        <div className="flex items-center justify-between">
          <div />
        </div>
      </PageHeader>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <div className="space-y-8">
          {/* ── Income compliance «Контроль приходов» (ADMIN + ACCOUNTANT) ──
          Company-wide tracker of which income receivers have registered a
          counted income per active project this month. The whole /crm/stats
          route is already ADMIN/ACCOUNTANT-only, so this needs no extra gate. */}
          <IncomeComplianceSection />

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

                {/* Chart + Partner balances.
                Partner-balances card is employee/partner-level → ADMIN-only.
                For ACCOUNTANT the chart spans the full width. */}
                <div className="grid gap-4 lg:grid-cols-3">
                  <div className={isAdmin ? 'lg:col-span-2' : 'lg:col-span-3'}>
                    <FinanceChart summary={summary} />
                  </div>
                  {isAdmin && <PartnerBalancesCard summary={summary} />}
                </div>
              </>
            ) : null}
          </section>

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
