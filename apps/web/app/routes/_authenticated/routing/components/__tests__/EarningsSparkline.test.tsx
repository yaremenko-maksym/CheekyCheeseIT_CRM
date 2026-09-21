/**
 * EarningsSparkline.test.tsx — unit tests for the self-written SVG sparkline
 * (task-senior-stats-block, design variant C). Covers: empty data → placeholder,
 * non-empty data → svg + month labels, all-zero data → flat line still renders
 * (no crash), single point → centred.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { SeniorMonthlyEarningDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { EarningsSparkline } from '../EarningsSparkline'

// task-i18n-stage3a (Task 1) blast-radius: `EarningsSparkline` now calls
// `useLingui()`/`useLocale()` directly. Shadowing `render` wraps every call
// site with `I18nTestProvider` in one place.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

const HISTORY: SeniorMonthlyEarningDto[] = [
  { month: '2026-01', amount: 100 },
  { month: '2026-02', amount: 0 },
  { month: '2026-03', amount: 250 },
  { month: '2026-04', amount: 180 },
]

describe('EarningsSparkline', () => {
  it('renders a placeholder when there is no data', () => {
    render(<EarningsSparkline data={[]} />)
    expect(screen.getByTestId('earnings-sparkline-empty')).toHaveTextContent(
      'Заробітку за останні місяці ще немає',
    )
    expect(screen.queryByTestId('earnings-sparkline')).not.toBeInTheDocument()
  })

  it('renders an svg + month labels for non-empty data', () => {
    render(<EarningsSparkline data={HISTORY} />)
    const svg = screen.getByTestId('earnings-sparkline').querySelector('svg')
    // Mutation gate (StringLiteral): the aria-label had no assertion.
    expect(svg).toHaveAttribute('aria-label', 'Історія заробітку по місяцях')
    const labels = screen.getByTestId('earnings-sparkline-labels')
    // Independent of `formatDate`'s own implementation — computed straight
    // from `Intl`, the same source-of-truth `format.spec.ts` uses, not by
    // re-deriving the value the same way the component does.
    const ukMonthFmt = new Intl.DateTimeFormat('uk-UA', { month: 'short', timeZone: 'UTC' })
    expect(labels).toHaveTextContent(ukMonthFmt.format(new Date(Date.UTC(2026, 0, 1))))
    expect(labels).toHaveTextContent(ukMonthFmt.format(new Date(Date.UTC(2026, 1, 1))))
    expect(labels).toHaveTextContent(ukMonthFmt.format(new Date(Date.UTC(2026, 2, 1))))
    expect(labels).toHaveTextContent(ukMonthFmt.format(new Date(Date.UTC(2026, 3, 1))))
    // The polyline carries 4 points (one per month).
    const polyline = document.querySelector('polyline')
    expect(polyline).not.toBeNull()
    expect(polyline!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(4)
  })

  it('omits labels when showLabels=false', () => {
    render(<EarningsSparkline data={HISTORY} showLabels={false} />)
    expect(screen.getByTestId('earnings-sparkline')).toBeInTheDocument()
    expect(screen.queryByTestId('earnings-sparkline-labels')).not.toBeInTheDocument()
  })

  it('renders a flat line (no area fill) when every amount is zero', () => {
    render(
      <EarningsSparkline
        data={[
          { month: '2026-05', amount: 0 },
          { month: '2026-06', amount: 0 },
        ]}
      />,
    )
    expect(screen.getByTestId('earnings-sparkline')).toBeInTheDocument()
    // No area path when max <= 0 (avoids a misleading filled shape).
    expect(document.querySelector('path')).toBeNull()
    expect(document.querySelector('polyline')).not.toBeNull()
  })

  it('centres a single data point without crashing', () => {
    render(<EarningsSparkline data={[{ month: '2026-06', amount: 500 }]} />)
    const polyline = document.querySelector('polyline')
    expect(polyline).not.toBeNull()
    expect(polyline!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(1)
  })

  // Mutation gate (monthLabel's malformed-key guard): nothing previously
  // exercised the `!Number.isFinite(y) || !Number.isFinite(m) || m < 1 ||
  // m > 12` branch — every mutant on that line survived with no test
  // reaching it at all.
  it('renders an empty label for a malformed month key, not a crash', () => {
    render(<EarningsSparkline data={[{ month: 'not-a-month', amount: 100 }]} />)
    const labels = screen.getByTestId('earnings-sparkline-labels')
    expect(labels.textContent).toBe('')
  })

  it('renders an empty label when the month number is out of range (13)', () => {
    render(<EarningsSparkline data={[{ month: '2026-13', amount: 100 }]} />)
    const labels = screen.getByTestId('earnings-sparkline-labels')
    expect(labels.textContent).toBe('')
  })

  // Mutation gate: distinguishes `||` from `&&` between the two
  // `!Number.isFinite(...)` checks — needs a key where EXACTLY ONE of
  // year/month is non-finite (the two tests above have both-true or
  // both-false, which cannot tell `||` and `&&` apart here).
  it('renders an empty label when only the month segment is non-numeric (valid year)', () => {
    render(<EarningsSparkline data={[{ month: '2026-abc', amount: 100 }]} />)
    const labels = screen.getByTestId('earnings-sparkline-labels')
    expect(labels.textContent).toBe('')
  })

  // Mutation gate: distinguishes `m < 1` from `false` — needs a key where
  // the month is BELOW range (0) with an otherwise-valid year, which no
  // other test exercises.
  it('renders an empty label when the month number is out of range (0)', () => {
    render(<EarningsSparkline data={[{ month: '2026-00', amount: 100 }]} />)
    const labels = screen.getByTestId('earnings-sparkline-labels')
    expect(labels.textContent).toBe('')
  })

  // Mutation gate: distinguishes `m > 12` from `m >= 12` — needs the exact
  // boundary value 12 (December), which must NOT trigger the guard.
  it('renders a normal label for the boundary month 12 (December)', () => {
    render(<EarningsSparkline data={[{ month: '2026-12', amount: 100 }]} />)
    const labels = screen.getByTestId('earnings-sparkline-labels')
    const ukMonthFmt = new Intl.DateTimeFormat('uk-UA', { month: 'short', timeZone: 'UTC' })
    expect(labels).toHaveTextContent(ukMonthFmt.format(new Date(Date.UTC(2026, 11, 1))))
  })
})
