import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownLeft,
  BarChart3,
  Clock,
  DollarSign,
  HelpCircle,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

import { formatMonthLabel } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useLocale } from '@/lib/i18n'
import { Skeleton } from '@/components/ui/skeleton'
import { financeApi } from './finance/api'
import { StatCard } from './stats/components/StatCard'
import { CompanyAndPartnersCard } from './stats/components/CompanyAndPartnersCard'
import { IncomeComplianceSection } from './stats/components/IncomeComplianceSection'
import { computeExtraStats } from './stats/utils/computeExtraStats'

// Re-exported so existing importers (unit tests) keep resolving from the route module.
export { partnerShare } from './stats/components/CompanyAndPartnersCard'
export { receiverStatus } from './stats/components/IncomeComplianceSection'

/**
 * task-i18n-stage3d-pr4 (template J-fin). «за {N} мес.» — a `StatCard`
 * `sub` is a plain string prop (not JSX), so the JSX-only `<Plural>`
 * component cannot be used here (урок #700) — an ICU string + `i18n._(msg,
 * {count})` instead. `satisfies` without `as const` — see the module-level
 * doc comment on `TYPE_LABEL_MESSAGES` in `finance/constants.ts` for why.
 */
const AVG_MONTHS_SUFFIX_MESSAGE: MessageDescriptor = msg`за {count, plural, one {# місяць} few {# місяці} many {# місяців} other {# місяця}}`

const FinanceChart = lazy(() =>
  import('@/components/stats/FinanceChart').then((m) => ({ default: m.FinanceChart })),
)

export const Route = createFileRoute('/_authenticated/stats')({
  component: StatsPage,
})

// ── Main page ──────────────────────────────────────────────────────────────────

// Exported for the role-split unit test (stats.test.tsx). The route still binds
// it via `Route.component = StatsPage` below.
export function StatsPage() {
  const { t } = useLingui()
  const locale = useLocale()
  const { user } = useAuth()
  const navigate = useNavigate()

  // ACCOUNTANT joins ADMIN as a viewer on /stats, but sees ONLY the
  // economic part (P&L: income / expenses / salaries / Net / profit + charts +
  // monthly breakdown). The employee/partner-level sections — participants
  // balances, the partner-balances settlement card, and the future
  // HR/Команда/Проекты placeholders — are hidden from ACCOUNTANT only HERE,
  // client-side, via `isAdmin`. Other roles are bounced to the dashboard at /
  // (defense-in-depth over the route-access guard).
  // task-accountant-stats: economic data is the accountant's profile surface.
  // There is no server-side prohibition backing that gate: since 2026-08-17
  // `canSeeAdminBalances` in `TransactionsService.getSummary` is unconditionally
  // `true` for both ADMIN and ACCOUNTANT — access to `adminBalances` was
  // deliberately extended to ACCOUNTANT (owner decision; SEC-3 in #551, MED-1
  // in #560). The `summary` fetched below (`enabled: isPrivilegedViewer`)
  // already carries `adminBalances` for ACCOUNTANT too; `isAdmin` here is the
  // ONLY thing keeping it off the ACCOUNTANT's screen. Do not remove it, and
  // do not assume the server would catch you if you did.
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

  // Every hook must run on every render regardless of the early return below
  // (Rules of Hooks) — `summary` is still `undefined` pre-fetch or for a
  // non-privileged viewer, which `computeExtraStats`'s ternary already covers.
  const extra = useMemo(() => (summary ? computeExtraStats(summary) : null), [summary])

  if (!user || !isPrivilegedViewer) return null

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
                <Trans>Фінанси</Trans>
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
                    title={t`Загальний дохід`}
                    hint={t`Сума всіх оплачених надходжень та доходу сеньйорів і адмінів за весь час.`}
                    value={`$${summary.totalIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<TrendingUp className="h-5 w-5" />}
                    color="green"
                    {...(extra?.incomeTrend !== null && extra?.incomeTrend !== undefined
                      ? { trend: { value: extra.incomeTrend, label: t`vs попер. місяць` } }
                      : {})}
                  />
                  <StatCard
                    title={t`Витрати`}
                    hint={t`Сума всіх оплачених операційних витрат компанії.`}
                    value={`$${summary.totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<ArrowDownLeft className="h-5 w-5" />}
                    color="red"
                  />
                  <StatCard
                    title={t`Зарплати`}
                    hint={t`Сума всіх виплачених зарплат співробітникам компанії за весь час.`}
                    value={`$${summary.totalSalaries.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<Users className="h-5 w-5" />}
                    color="purple"
                  />
                  <StatCard
                    title={t`Чистий баланс`}
                    hint={t`Чистий залишок: дохід мінус витрати та зарплати. Додатне значення = компанія в плюсі.`}
                    value={`$${summary.netBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    icon={<Wallet className="h-5 w-5" />}
                    color={summary.netBalance >= 0 ? 'blue' : 'red'}
                  />
                </div>

                {/* Secondary KPIs */}
                {extra && (
                  <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    <StatCard
                      title={t`Дохід за останній місяць`}
                      hint={t`Виручка за ${formatMonthLabel(extra.lastMonth.month, locale)}. Включає доходи всіх сеньйорів і адмінів.`}
                      value={`$${extra.lastMonth.income.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<BarChart3 className="h-5 w-5" />}
                      color="green"
                      sub={formatMonthLabel(extra.lastMonth.month, locale)}
                    />
                    <StatCard
                      title={t`Прибуток за останній місяць`}
                      hint={t`Чистий прибуток за ${formatMonthLabel(extra.lastMonth.month, locale)}: дохід мінус витрати та зарплати того місяця.`}
                      value={`$${extra.lastMonth.profit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<TrendingUp className="h-5 w-5" />}
                      color={extra.lastMonth.profit >= 0 ? 'cyan' : 'red'}
                      {...(extra.profitMargin !== null
                        ? { sub: t`Маржа: ${extra.profitMargin.toFixed(1)}%` }
                        : {})}
                    />
                    <StatCard
                      title={t`Середній дохід / міс.`}
                      hint={t`Середньомісячна виручка за весь час роботи компанії.`}
                      value={`$${extra.avgMonthlyIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<Clock className="h-5 w-5" />}
                      color="blue"
                      sub={i18n._(AVG_MONTHS_SUFFIX_MESSAGE.id, { count: summary.monthly.length })}
                    />
                    <StatCard
                      title={t`Найкращий місяць`}
                      hint={t`Місяць із найбільшою виручкою за весь час.`}
                      value={`$${extra.bestMonth.income.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      icon={<TrendingUp className="h-5 w-5" />}
                      color="yellow"
                      sub={formatMonthLabel(extra.bestMonth.month, locale)}
                    />
                  </div>
                )}

                {/* Chart + Company & Partners balance block (combined card).
                USDT company balance (all privileged viewers) + partner balances
                (ADMIN-only) are unified in one sidebar card next to the chart.
                Chart is always lg:col-span-2. */}
                <div className="grid items-stretch gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2 h-full">
                    <Suspense fallback={<Skeleton className="h-72 w-full rounded-xl" />}>
                      <FinanceChart summary={summary} className="h-full" />
                    </Suspense>
                  </div>
                  <div className="h-full">
                    <CompanyAndPartnersCard summary={summary} isAdmin={isAdmin} />
                  </div>
                </div>
              </>
            ) : null}
          </section>

          {/* ── Income compliance «Контроль приходів» (ADMIN + ACCOUNTANT) ──
          Company-wide tracker of which income receivers have registered a
          counted income per active project this month. Placed after the main
          financial KPIs so the key P&L numbers are seen first. */}
          <IncomeComplianceSection />

          {/* Future sections placeholder (ADMIN-only — HR/Команда/Проєкти analytics
          are not part of the accountant's economic surface). */}
          {isAdmin && (
            <section className="space-y-4" data-testid="stats-placeholders-section">
              <div className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-muted-foreground/40" />
                <h2 className="text-sm font-semibold text-muted-foreground/40 uppercase tracking-wider">
                  <Trans>Інші розділи</Trans>
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(
                  [
                    t`HR — воронка співбесід`,
                    t`Команда — активність`,
                    t`Проєкти — завантаженість`,
                  ] as const
                ).map((label) => (
                  <div
                    key={label}
                    className="rounded-xl border border-dashed border-border/50 p-6 text-center text-sm text-muted-foreground/40"
                  >
                    {label}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
