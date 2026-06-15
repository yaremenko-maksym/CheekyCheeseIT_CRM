/**
 * HRDashboard.test.tsx — unit tests for the HR рекрутинг хаб (HR dashboard).
 *
 * Covers (AC4):
 *   - loading skeleton state
 *   - error state
 *   - renders 3 KPI cards with correct values (open interviews / hired / salary)
 *   - CTA navigates to /crm/interviews
 *   - salary status variants (PENDING / PAID / null → «Нет начисления»)
 *
 * `useHrSummary` and `useNavigate` are mocked so the component renders in
 * isolation (no real query client / router needed). Mirrors the proven
 * AccountantDashboard.test.tsx pattern.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { HrSummaryDto } from '@crm/shared'

const navigateMock = vi.fn()
const useHrSummaryMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('@/hooks/use-hr-summary', () => ({
  useHrSummary: () => useHrSummaryMock(),
}))

import { HRDashboard } from '../HRDashboard'

function makeSummary(overrides: Partial<HrSummaryDto> = {}): HrSummaryDto {
  return {
    openInterviews: 7,
    hiredThisMonth: 2,
    mySalaryStatus: { amount: 1500, status: 'PENDING' },
    ...overrides,
  }
}

beforeEach(() => {
  navigateMock.mockReset()
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

  describe('KPI cards (AC4)', () => {
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
      expect(screen.getByTestId('kpi-my-salary')).toBeInTheDocument()
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

    it('shows salary amount and PENDING status label', () => {
      render(<HRDashboard />)
      const cardEl = screen.getByTestId('kpi-my-salary')
      expect(cardEl).toHaveTextContent('$1,500.00')
      expect(cardEl).toHaveTextContent('Ожидает выплаты')
    })
  })

  describe('salary status variants', () => {
    it('shows PAID label and amount', () => {
      useHrSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: { amount: 2000, status: 'PAID' } }),
        isLoading: false,
        isError: false,
      })
      render(<HRDashboard />)
      const cardEl = screen.getByTestId('kpi-my-salary')
      expect(cardEl).toHaveTextContent('$2,000.00')
      expect(cardEl).toHaveTextContent('Выплачено')
    })

    it('shows «Нет начисления» when no salary row exists', () => {
      useHrSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: null }),
        isLoading: false,
        isError: false,
      })
      render(<HRDashboard />)
      const cardEl = screen.getByTestId('kpi-my-salary')
      expect(cardEl).toHaveTextContent('—')
      expect(cardEl).toHaveTextContent('Нет начисления за месяц')
    })
  })

  describe('CTA — interviews kanban', () => {
    it('navigates to /crm/interviews on click', () => {
      useHrSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      render(<HRDashboard />)
      fireEvent.click(screen.getByTestId('hr-interviews-cta'))
      expect(navigateMock).toHaveBeenCalledWith({ to: '/crm/interviews' })
    })

    it('shows active-interviews sub-label when openInterviews > 0', () => {
      useHrSummaryMock.mockReturnValue({
        data: makeSummary({ openInterviews: 5 }),
        isLoading: false,
        isError: false,
      })
      render(<HRDashboard />)
      expect(screen.getByText('5 активных собеседований на вашей доске')).toBeInTheDocument()
    })

    it('shows «нет активных» sub-label when openInterviews = 0', () => {
      useHrSummaryMock.mockReturnValue({
        data: makeSummary({ openInterviews: 0 }),
        isLoading: false,
        isError: false,
      })
      render(<HRDashboard />)
      expect(screen.getByText('Нет активных собеседований')).toBeInTheDocument()
    })
  })
})
