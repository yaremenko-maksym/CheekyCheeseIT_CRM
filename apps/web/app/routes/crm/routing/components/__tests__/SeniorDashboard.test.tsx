/**
 * SeniorDashboard.test.tsx — unit tests for the SENIOR рабочий хаб (senior dashboard).
 *
 * Covers (AC1 / AC4):
 *   - loading skeleton state
 *   - error state
 *   - renders 3 KPI cards (active projects / income this month / pending payouts)
 *   - «Мои проекты» panel: rows with share %, empty-state
 *   - «Статус моих выплат» panel: salary status + total income
 *   - CTA navigates to /crm/finance
 *   - salary status variants (PENDING / PAID / null → «Нет начисления»)
 *
 * `useSeniorSummary` and `useNavigate` are mocked so the component renders in
 * isolation. Mirrors the proven HRDashboard.test.tsx / AccountantDashboard.test.tsx
 * pattern.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { SeniorSummaryDto } from '@crm/shared'

const navigateMock = vi.fn()
const useSeniorSummaryMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('@/hooks/use-senior-summary', () => ({
  useSeniorSummary: () => useSeniorSummaryMock(),
}))

import { SeniorDashboard } from '../SeniorDashboard'

function makeSummary(overrides: Partial<SeniorSummaryDto> = {}): SeniorSummaryDto {
  return {
    activeProjects: {
      count: 2,
      items: [
        { id: 'p1', name: 'Acme Migration', companyName: 'Acme Corp', sharePercent: 40 },
        { id: 'p2', name: 'Globex Platform', companyName: 'Globex', sharePercent: 26 },
      ],
    },
    seniorShareIncome: { total: 5500, thisMonth: 1200, currency: 'USD' },
    pendingPayouts: { count: 3, amount: 2400 },
    mySalaryStatus: { amount: 1500, status: 'PENDING' },
    ...overrides,
  }
}

beforeEach(() => {
  navigateMock.mockReset()
  useSeniorSummaryMock.mockReset()
})

describe('SeniorDashboard', () => {
  it('renders loading skeletons while fetching', () => {
    useSeniorSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    render(<SeniorDashboard />)
    expect(screen.getByTestId('senior-kpi-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('senior-kpi-grid')).not.toBeInTheDocument()
  })

  it('renders error state on fetch failure', () => {
    useSeniorSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    render(<SeniorDashboard />)
    expect(screen.getByTestId('senior-kpi-error')).toBeInTheDocument()
    expect(screen.getByText('Не удалось загрузить сводку')).toBeInTheDocument()
  })

  describe('KPI cards (AC1)', () => {
    beforeEach(() => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
    })

    it('renders all 3 KPI cards', () => {
      render(<SeniorDashboard />)
      expect(screen.getByTestId('kpi-active-projects')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-senior-income')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-pending-payouts')).toBeInTheDocument()
    })

    it('shows active-projects count', () => {
      render(<SeniorDashboard />)
      const cardEl = screen.getByTestId('kpi-active-projects')
      expect(cardEl).toHaveTextContent('2')
      expect(cardEl).toHaveTextContent('Активные проекты')
    })

    it('shows income this month + total sub-label', () => {
      render(<SeniorDashboard />)
      const cardEl = screen.getByTestId('kpi-senior-income')
      expect(cardEl).toHaveTextContent('$1,200.00')
      expect(cardEl).toHaveTextContent('Всего: $5,500.00')
    })

    it('shows pending-payouts count + amount', () => {
      render(<SeniorDashboard />)
      const cardEl = screen.getByTestId('kpi-pending-payouts')
      expect(cardEl).toHaveTextContent('3')
      expect(cardEl).toHaveTextContent('$2,400.00')
    })
  })

  describe('«Мои проекты» panel', () => {
    it('renders each own project with its share %', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      render(<SeniorDashboard />)
      const p1 = screen.getByTestId('senior-project-row-p1')
      expect(p1).toHaveTextContent('Acme Migration')
      expect(p1).toHaveTextContent('Acme Corp')
      expect(screen.getByTestId('senior-project-share-p1')).toHaveTextContent('40%')
      expect(screen.getByTestId('senior-project-share-p2')).toHaveTextContent('26%')
    })

    it('shows empty-state when no active projects', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary({ activeProjects: { count: 0, items: [] } }),
        isLoading: false,
        isError: false,
      })
      render(<SeniorDashboard />)
      expect(screen.getByTestId('senior-projects-empty')).toHaveTextContent('Нет активных проектов')
    })
  })

  describe('«Статус моих выплат» panel', () => {
    it('shows salary amount + PENDING status and total income', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      render(<SeniorDashboard />)
      const status = screen.getByTestId('senior-salary-status')
      expect(status).toHaveTextContent('$1,500.00')
      expect(status).toHaveTextContent('Ожидает выплаты')
      const total = screen.getByTestId('senior-income-total')
      expect(total).toHaveTextContent('$5,500.00')
    })

    it('shows PAID salary status', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: { amount: 2000, status: 'PAID' } }),
        isLoading: false,
        isError: false,
      })
      render(<SeniorDashboard />)
      const status = screen.getByTestId('senior-salary-status')
      expect(status).toHaveTextContent('$2,000.00')
      expect(status).toHaveTextContent('Выплачено')
    })

    it('shows «Нет начисления» when no salary row exists', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: null }),
        isLoading: false,
        isError: false,
      })
      render(<SeniorDashboard />)
      const status = screen.getByTestId('senior-salary-status')
      expect(status).toHaveTextContent('—')
      expect(status).toHaveTextContent('Нет начисления за месяц')
    })
  })

  describe('CTA — finance', () => {
    it('navigates to /crm/finance on click', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      render(<SeniorDashboard />)
      fireEvent.click(screen.getByTestId('senior-finance-cta'))
      expect(navigateMock).toHaveBeenCalledWith({ to: '/crm/finance' })
    })
  })
})
