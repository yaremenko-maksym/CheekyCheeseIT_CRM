// Lazy-loaded chart component — recharts is only bundled when /stats is visited.
// Do NOT import this directly; use React.lazy() in the parent (stats.tsx).
import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
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
import type { FinanceSummaryDto } from '@crm/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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

export function FinanceChart({
  summary,
  className,
}: {
  summary: FinanceSummaryDto
  className?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ChartMode>('income')

  const chartData = useMemo(
    () =>
      summary.monthly.map((m) => ({
        month: m.month,
        Доход: m.income,
        Расходы: m.expenses,
        Зарплаты: m.salaries,
        Прибыль: m.profit,
      })),
    [summary.monthly],
  )

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

  const values = useMemo(
    () => chartData.map((d) => d[effectiveMode.key as keyof typeof d] as number),
    [chartData, effectiveMode.key],
  )
  const minVal = values.length ? Math.min(...values) : 0
  const maxVal = values.length ? Math.max(...values) : 0
  const hasNegative = minVal < 0
  const yPad = (maxVal - minVal) * 0.1 || Math.abs(minVal) * 0.1 || 10
  const yDomain: [number, number] = hasNegative
    ? [Math.floor(minVal - yPad), Math.ceil(maxVal + yPad)]
    : [0, Math.ceil(maxVal + yPad)]

  return (
    <Card className={className}>
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

// Default export required for React.lazy()
export default FinanceChart
