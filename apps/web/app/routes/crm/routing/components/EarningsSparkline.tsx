import { useId, useMemo } from 'react'
import type { SeniorMonthlyEarningDto } from '@crm/shared'

/**
 * EarningsSparkline — self-contained SVG sparkline for the SENIOR dashboard
 * «Всего заработано» tile (task-senior-stats-block, design variant C). NO chart
 * library: a single polyline + a gradient area fill under it, with short month
 * labels on the x-axis (no numeric y-axis — it is a sparkline, not a full
 * chart). Styled with the CRM gold accent (`--primary` via `text-primary` /
 * `currentColor`) so it inherits the theme in both dark and light modes.
 *
 * Empty / all-zero history degrades gracefully to a flat baseline so the tile
 * never renders a broken or misleading shape.
 */

const VIEW_W = 240
const VIEW_H = 56
const PAD_X = 4
const PAD_TOP = 6
const PAD_BOTTOM = 6

/** Short Russian month label for a `YYYY-MM` key (1-based month). */
const MONTH_ABBR = [
  'Янв',
  'Фев',
  'Мар',
  'Апр',
  'Май',
  'Июн',
  'Июл',
  'Авг',
  'Сен',
  'Окт',
  'Ноя',
  'Дек',
]

function monthLabel(monthKey: string): string {
  const parts = monthKey.split('-')
  const m = Number(parts[1])
  return Number.isFinite(m) && m >= 1 && m <= 12 ? MONTH_ABBR[m - 1]! : ''
}

interface EarningsSparklineProps {
  data: ReadonlyArray<SeniorMonthlyEarningDto>
  /** Show the month labels under the line (default true). */
  showLabels?: boolean
  className?: string
}

export function EarningsSparkline({ data, showLabels = true, className }: EarningsSparklineProps) {
  const gradientId = useId()

  const { linePoints, areaPath, hasShape } = useMemo(() => {
    const n = data.length
    if (n === 0) {
      return { linePoints: '', areaPath: '', hasShape: false }
    }

    const amounts = data.map((d) => (Number.isFinite(d.amount) ? d.amount : 0))
    const max = Math.max(...amounts, 0)
    const innerW = VIEW_W - PAD_X * 2
    const innerH = VIEW_H - PAD_TOP - PAD_BOTTOM

    // x positions evenly across the inner width (single point → centred).
    const xAt = (i: number): number => (n === 1 ? VIEW_W / 2 : PAD_X + (innerW * i) / (n - 1))
    // y inverted (SVG origin top-left); flat baseline when max === 0.
    const yAt = (v: number): number =>
      max <= 0 ? VIEW_H - PAD_BOTTOM : PAD_TOP + innerH * (1 - v / max)

    const coords = amounts.map((v, i) => ({ x: xAt(i), y: yAt(v) }))
    const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ')

    // Closed area path under the line for the gradient fill.
    const first = coords[0]!
    const last = coords[coords.length - 1]!
    const area =
      `M ${first.x.toFixed(2)},${(VIEW_H - PAD_BOTTOM).toFixed(2)} ` +
      coords.map((c) => `L ${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ') +
      ` L ${last.x.toFixed(2)},${(VIEW_H - PAD_BOTTOM).toFixed(2)} Z`

    return { linePoints: line, areaPath: area, hasShape: max > 0 }
  }, [data])

  if (data.length === 0) {
    return (
      <div
        className={'text-[11px] text-muted-foreground ' + (className ?? '')}
        data-testid="earnings-sparkline-empty"
      >
        Нет данных за период
      </div>
    )
  }

  return (
    <div className={className} data-testid="earnings-sparkline">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-14 w-full text-primary"
        role="img"
        aria-label="История заработка по месяцам"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {hasShape && <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />}
        <polyline
          points={linePoints}
          fill="none"
          stroke="currentColor"
          strokeWidth={hasShape ? 2 : 1}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={hasShape ? 1 : 0.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {showLabels && (
        <div
          className="mt-1 flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground"
          data-testid="earnings-sparkline-labels"
        >
          {data.map((d) => (
            <span key={d.month}>{monthLabel(d.month)}</span>
          ))}
        </div>
      )}
    </div>
  )
}
