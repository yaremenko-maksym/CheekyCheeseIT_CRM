/**
 * EarningsStatsBlock.tsx — unit tests for the "Цей місяць" month-label
 * suffix.
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). This file had ZERO
 * tests before this round — the full-diff scoped mutation gate follow-up
 * flagged it as a `NoCoverage` StringLiteral gap: `thisMonthKey ? \`
 * — ${monthYear(thisMonthKey, locale)}\` : ''` — nothing rendered this
 * component with a non-empty `monthlyHistory` at all.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { SeniorEarningsStatsDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { EarningsStatsBlock } from '../EarningsStatsBlock'

beforeEach(async () => {
  await loadCatalog('uk')
})

function baseStats(
  monthlyHistory: SeniorEarningsStatsDto['monthlyHistory'],
): SeniorEarningsStatsDto {
  return {
    lastMonthIncome: 0,
    monthlyHistory,
    companyIncomeProgress: { received: 1, total: 2 },
  }
}

function renderBlock(stats: SeniorEarningsStatsDto) {
  return render(
    <EarningsStatsBlock stats={stats} totalEarned={0} thisMonthEarned={0} activeProjects={[]} />,
    { wrapper: I18nTestProvider },
  )
}

describe('EarningsStatsBlock — "Цей місяць" month-label suffix (MUT-1)', () => {
  it('appends the formatted month/year when monthlyHistory has at least one entry', () => {
    renderBlock(baseStats([{ month: '2026-05', amount: 100 }]))

    // MUT-1: `thisMonthKey ? \` — ${monthYear(...)}\` : ''` — exact text
    // catches a mutant collapsing the suffix to an empty string (the
    // `<Trans>Цей місяць</Trans>` label alone would otherwise still pass a
    // substring check).
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'P' && element.textContent === 'Цей місяць — травень 2026 р.',
      ),
    ).toBeInTheDocument()
  })

  it('renders the bare "Цей місяць" label with NO suffix when monthlyHistory is empty', () => {
    renderBlock(baseStats([]))

    expect(
      screen.getByText(
        (_content, element) => element?.tagName === 'P' && element.textContent === 'Цей місяць',
      ),
    ).toBeInTheDocument()
  })

  it('uses the LAST (newest) entry of monthlyHistory, not the first', () => {
    renderBlock(
      baseStats([
        { month: '2026-01', amount: 10 },
        { month: '2026-05', amount: 20 },
      ]),
    )

    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'P' && element.textContent === 'Цей місяць — травень 2026 р.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/січень/)).not.toBeInTheDocument()
  })
})
