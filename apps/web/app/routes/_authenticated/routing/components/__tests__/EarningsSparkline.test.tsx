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
      'Немає даних за період',
    )
    expect(screen.queryByTestId('earnings-sparkline')).not.toBeInTheDocument()
  })

  it('renders an svg + month labels for non-empty data', () => {
    render(<EarningsSparkline data={HISTORY} />)
    expect(screen.getByTestId('earnings-sparkline')).toBeInTheDocument()
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
})
