import { motion } from 'framer-motion'
import { TrendingUp } from 'lucide-react'
import { formatAmount } from '@crm/shared'
import type { SeniorEarningsStatsDto } from '@crm/shared'
import { Card, CardContent } from '@/components/ui/card'
import { EarningsSparkline } from './EarningsSparkline'

/**
 * EarningsStatsBlock — «Статистика заработка» for the SENIOR dashboard
 * (task-senior-stats-block). Design = variant B (editorial / bento) with the
 * variant-C sparkline embedded in the hero «Всего заработано» tile.
 *
 * Tiles:
 *   1. Hero «Всего заработано · всё время» — large gold figure + sparkline of
 *      the last months + a green «+$X этот месяц» badge.
 *   2. «Прошлый месяц» — senior NET share for the previous calendar month.
 *   3. «Этот месяц» — already-earned this month + a PROGRESS BAR «X/N приходов
 *      от компаний за этот месяц» (NOT money — USER decision: no expected-money
 *      figure since the real amount depends on each company's payment method /
 *      ФОП-tax / the junior's worked days).
 *
 * All money is the senior's NET share displayed in USD (same convention as the
 * KPI cards' `fmtUsd`) — no currency conversion.
 */

const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}

const RU_MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]

/** «Май 2026» for a `YYYY-MM` key. Falls back to «—» on a malformed key. */
function ruMonthYear(monthKey: string): string {
  const [y, m] = monthKey.split('-')
  const mi = Number(m)
  if (!y || !Number.isFinite(mi) || mi < 1 || mi > 12) return '—'
  return `${RU_MONTHS[mi - 1]} ${y}`
}

interface EarningsStatsBlockProps {
  stats: SeniorEarningsStatsDto
  /** Lifetime senior-share total — reused from `seniorShareIncome.total`. */
  totalEarned: number
  /** Already earned this month — reused from `seniorShareIncome.thisMonth`. */
  thisMonthEarned: number
}

export function EarningsStatsBlock({
  stats,
  totalEarned,
  thisMonthEarned,
}: EarningsStatsBlockProps) {
  const { lastMonthIncome, monthlyHistory, companyIncomeProgress } = stats
  const { received, total } = companyIncomeProgress

  // Current/previous month keys derive from the history tail (newest = this).
  const thisMonthKey = monthlyHistory.at(-1)?.month
  const lastMonthKey = monthlyHistory.at(-2)?.month

  const progressPct = total > 0 ? Math.round((received / total) * 100) : 0

  return (
    <motion.div variants={card} initial="hidden" animate="show" className="space-y-3">
      <p
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        data-testid="earnings-stats-heading"
      >
        Статистика заработка
      </p>

      <div className="grid gap-4 lg:grid-cols-3" data-testid="earnings-stats-grid">
        {/* ── Hero «Всего заработано» + sparkline (spans 2 cols on lg). ───────── */}
        <Card
          className="lg:col-span-2 border-primary/30 bg-gradient-to-br from-primary/10 to-transparent"
          data-testid="earnings-total-tile"
        >
          <CardContent className="space-y-3 pt-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-primary/80">
              Всего заработано · всё время
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <span
                className="text-3xl font-bold tracking-tight text-primary tabular-nums sm:text-4xl"
                data-testid="earnings-total-value"
              >
                {formatAmount(totalEarned, 'USD')}
              </span>
              {thisMonthEarned > 0 && (
                <span
                  className="mb-1 rounded bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-500"
                  data-testid="earnings-total-month-badge"
                >
                  +{formatAmount(thisMonthEarned, 'USD')} этот месяц
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Senior-доля за всё время</p>
            <EarningsSparkline data={monthlyHistory} className="pt-1" />
          </CardContent>
        </Card>

        {/* ── «Прошлый месяц». ──────────────────────────────────────────────── */}
        <Card data-testid="earnings-last-month-tile">
          <CardContent className="flex h-full flex-col justify-between gap-2 pt-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Прошлый месяц
            </p>
            <span
              className="text-2xl font-bold tracking-tight tabular-nums"
              data-testid="earnings-last-month-value"
            >
              {formatAmount(lastMonthIncome, 'USD')}
            </span>
            <p className="text-xs text-muted-foreground">
              {lastMonthKey ? ruMonthYear(lastMonthKey) : '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── «Этот месяц» + arrival-progress bar (NO money expected). ────────── */}
      <Card data-testid="earnings-this-month-tile">
        <CardContent className="space-y-3 pt-5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Этот месяц{thisMonthKey ? ` — ${ruMonthYear(thisMonthKey)}` : ''}
            </p>
            <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <span
            className="text-2xl font-bold tracking-tight text-primary tabular-nums"
            data-testid="earnings-this-month-value"
          >
            {formatAmount(thisMonthEarned, 'USD')}
          </span>

          {/* Per-company arrival progress — «X/N приходов от компаний». */}
          <div className="space-y-1.5" data-testid="earnings-company-progress">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                <span
                  className="font-semibold text-foreground"
                  data-testid="earnings-progress-fraction"
                >
                  {received}/{total}
                </span>{' '}
                приходов от компаний за этот месяц
              </span>
              <span className="tabular-nums text-muted-foreground">{progressPct}%</span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={received}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-label="Приходы от компаний за этот месяц"
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${progressPct}%` }}
                data-testid="earnings-progress-bar-fill"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
