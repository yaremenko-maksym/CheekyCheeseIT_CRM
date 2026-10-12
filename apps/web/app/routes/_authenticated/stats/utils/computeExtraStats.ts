import type { FinanceSummaryDto } from '@crm/shared'

// ── Computed stats helpers ─────────────────────────────────────────────────────

export function computeExtraStats(summary: FinanceSummaryDto) {
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
