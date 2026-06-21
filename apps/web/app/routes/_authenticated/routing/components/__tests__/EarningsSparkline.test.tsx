/**
 * EarningsSparkline.test.tsx — unit tests for the self-written SVG sparkline
 * (task-senior-stats-block, design variant C). Covers: empty data → placeholder,
 * non-empty data → svg + month labels, all-zero data → flat line still renders
 * (no crash), single point → centred.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { SeniorMonthlyEarningDto } from '@crm/shared'
import { EarningsSparkline } from '../EarningsSparkline'

const HISTORY: SeniorMonthlyEarningDto[] = [
  { month: '2026-01', amount: 100 },
  { month: '2026-02', amount: 0 },
  { month: '2026-03', amount: 250 },
  { month: '2026-04', amount: 180 },
]

describe('EarningsSparkline', () => {
  it('renders a placeholder when there is no data', () => {
    render(<EarningsSparkline data={[]} />)
    expect(screen.getByTestId('earnings-sparkline-empty')).toHaveTextContent('Нет данных за период')
    expect(screen.queryByTestId('earnings-sparkline')).not.toBeInTheDocument()
  })

  it('renders an svg + month labels for non-empty data', () => {
    render(<EarningsSparkline data={HISTORY} />)
    expect(screen.getByTestId('earnings-sparkline')).toBeInTheDocument()
    const labels = screen.getByTestId('earnings-sparkline-labels')
    expect(labels).toHaveTextContent('Янв')
    expect(labels).toHaveTextContent('Фев')
    expect(labels).toHaveTextContent('Мар')
    expect(labels).toHaveTextContent('Апр')
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
