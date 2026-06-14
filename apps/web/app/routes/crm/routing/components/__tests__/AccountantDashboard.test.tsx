/**
 * AccountantDashboard.test.tsx — unit tests for the ACCOUNTANT финансовый хаб
 * (ACCOUNTANT Sprint 1).
 *
 * Covers (AC4 / AC5):
 *   - loading skeleton state
 *   - error state
 *   - renders 4 KPI cards with correct values (pending / validated / paid / recipients)
 *   - CTA shows the pending count and navigates to /crm/finance?status=PENDING
 *   - CTA sub-label reflects pending=0 vs pending>0
 *
 * `useAccountantSummary` and `useNavigate` are mocked so the component renders
 * in isolation (no real query client / router needed).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AccountantSummaryDto } from '@crm/shared'

const navigateMock = vi.fn()
const useAccountantSummaryMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('@/hooks/use-accountant-summary', () => ({
  useAccountantSummary: () => useAccountantSummaryMock(),
}))

import { AccountantDashboard } from '../AccountantDashboard'

function makeSummary(overrides: Partial<AccountantSummaryDto> = {}): AccountantSummaryDto {
  return {
    pendingValidation: { count: 4, amount: 15000 },
    validatedThisMonth: { count: 1, amount: 1000 },
    paidThisMonth: { amount: 0 },
    recipientCount: 3,
    ...overrides,
  }
}

beforeEach(() => {
  navigateMock.mockReset()
  useAccountantSummaryMock.mockReset()
})

describe('AccountantDashboard', () => {
  it('renders loading skeletons while fetching', () => {
    useAccountantSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    render(<AccountantDashboard />)
    expect(screen.getByTestId('accountant-kpi-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('accountant-kpi-grid')).not.toBeInTheDocument()
  })

  it('renders error state on fetch failure', () => {
    useAccountantSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    render(<AccountantDashboard />)
    expect(screen.getByTestId('accountant-kpi-error')).toBeInTheDocument()
    expect(screen.getByText('Не удалось загрузить финансовую сводку')).toBeInTheDocument()
  })

  describe('KPI cards (AC4)', () => {
    beforeEach(() => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
    })

    it('renders all 4 KPI cards', () => {
      render(<AccountantDashboard />)
      expect(screen.getByTestId('kpi-pending-validation')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-validated-month')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-paid-month')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-recipient-count')).toBeInTheDocument()
    })

    it('shows pending validation count and amount', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-pending-validation')
      expect(card).toHaveTextContent('4')
      expect(card).toHaveTextContent('$15,000.00')
      expect(card).toHaveTextContent('Ожидают валидации')
    })

    it('shows validated-this-month count and amount', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-validated-month')
      expect(card).toHaveTextContent('1')
      expect(card).toHaveTextContent('$1,000.00')
      expect(card).toHaveTextContent('Валидировано за месяц')
    })

    it('shows paid-this-month amount', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-paid-month')
      expect(card).toHaveTextContent('$0.00')
      expect(card).toHaveTextContent('Выплачено за месяц')
    })

    it('shows recipient count', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-recipient-count')
      expect(card).toHaveTextContent('3')
      expect(card).toHaveTextContent('Получателей')
    })
  })

  describe('CTA — validate pending (AC5)', () => {
    it('shows the pending count in the CTA label', () => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary({ pendingValidation: { count: 4, amount: 15000 } }),
        isLoading: false,
        isError: false,
      })
      render(<AccountantDashboard />)
      expect(screen.getByTestId('accountant-validate-cta')).toHaveTextContent(
        'Валидировать ожидающие (4)',
      )
    })

    it('navigates to /crm/finance with status=PENDING on click', () => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      render(<AccountantDashboard />)
      fireEvent.click(screen.getByTestId('accountant-validate-cta'))
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/crm/finance',
        search: { status: 'PENDING' },
      })
    })

    it('reflects «нет приходов» sub-label when pending = 0', () => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary({ pendingValidation: { count: 0, amount: 0 } }),
        isLoading: false,
        isError: false,
      })
      render(<AccountantDashboard />)
      expect(screen.getByText('Нет приходов, ожидающих валидации')).toBeInTheDocument()
      expect(screen.getByTestId('accountant-validate-cta')).toHaveTextContent(
        'Валидировать ожидающие (0)',
      )
    })
  })
})
