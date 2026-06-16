/**
 * HRDashboard.test.tsx — unit tests for the HR рекрутинг хаб (HR dashboard).
 *
 * Covers (AC4):
 *   - loading skeleton state
 *   - error state
 *   - renders 3 KPI cards: open interviews / hired this month / active projects
 *   - NO salary KPI, NO kanban CTA (removed per task-hr-dashboard-tweaks)
 *   - active projects renders correct count
 *
 * `useHrSummary` is mocked so the component renders in isolation
 * (no real query client / router needed).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { HrSummaryDto } from '@crm/shared'

const useHrSummaryMock = vi.fn()

vi.mock('@/hooks/use-hr-summary', () => ({
  useHrSummary: () => useHrSummaryMock(),
}))

import { HRDashboard } from '../HRDashboard'

function makeSummary(overrides: Partial<HrSummaryDto> = {}): HrSummaryDto {
  return {
    openInterviews: 7,
    hiredThisMonth: 2,
    activeProjects: 4,
    ...overrides,
  }
}

beforeEach(() => {
  useHrSummaryMock.mockReset()
})

describe('HRDashboard', () => {
  it('renders loading skeletons while fetching', () => {
    useHrSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    render(<HRDashboard />)
    expect(screen.getByTestId('hr-kpi-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('hr-kpi-grid')).not.toBeInTheDocument()
  })

  it('renders error state on fetch failure', () => {
    useHrSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    render(<HRDashboard />)
    expect(screen.getByTestId('hr-kpi-error')).toBeInTheDocument()
    expect(screen.getByText('Не удалось загрузить сводку')).toBeInTheDocument()
  })

  describe('KPI cards (AC1 + AC4)', () => {
    beforeEach(() => {
      useHrSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
    })

    it('renders all 3 KPI cards', () => {
      render(<HRDashboard />)
      expect(screen.getByTestId('kpi-open-interviews')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-hired-month')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-active-projects')).toBeInTheDocument()
    })

    it('does NOT render salary KPI (removed per task-hr-dashboard-tweaks)', () => {
      render(<HRDashboard />)
      expect(screen.queryByTestId('kpi-my-salary')).not.toBeInTheDocument()
      expect(screen.queryByText('Моя зарплата за месяц')).not.toBeInTheDocument()
    })

    it('does NOT render kanban CTA (removed per task-hr-dashboard-tweaks)', () => {
      render(<HRDashboard />)
      expect(screen.queryByTestId('hr-interviews-cta')).not.toBeInTheDocument()
      expect(screen.queryByText('Открыть канбан')).not.toBeInTheDocument()
    })

    it('shows open-interviews count', () => {
      render(<HRDashboard />)
      const cardEl = screen.getByTestId('kpi-open-interviews')
      expect(cardEl).toHaveTextContent('7')
      expect(cardEl).toHaveTextContent('Открытые собеседования')
    })

    it('shows hired-this-month count', () => {
      render(<HRDashboard />)
      const cardEl = screen.getByTestId('kpi-hired-month')
      expect(cardEl).toHaveTextContent('2')
      expect(cardEl).toHaveTextContent('Нанято за месяц')
    })

    it('shows active-projects count', () => {
      render(<HRDashboard />)
      const cardEl = screen.getByTestId('kpi-active-projects')
      expect(cardEl).toHaveTextContent('4')
      expect(cardEl).toHaveTextContent('Активные проекты')
    })

    it('shows active-projects = 0 when no projects', () => {
      useHrSummaryMock.mockReturnValue({
        data: makeSummary({ activeProjects: 0 }),
        isLoading: false,
        isError: false,
      })
      render(<HRDashboard />)
      const cardEl = screen.getByTestId('kpi-active-projects')
      expect(cardEl).toHaveTextContent('0')
    })
  })
})
