/**
 * DropFinancePage.test.tsx — unit tests for the drop finance cabinet's incomes
 * table (task-drop-sees-own-obligations §AC3).
 *
 * Covers:
 *   - a 'declared' (DROP_INCOME) row shows the «Приход» badge
 *   - an 'obligation' (DROP_PENDING_PAYOUT/PAYOUT_DROP) row shows the
 *     «Начисление» badge — the "понятное различение" the task requires so a
 *     drop can tell the two income models apart at a glance
 *   - both models render together in one table, side by side
 *
 * Hooks and the create-dialog are mocked so the component renders in
 * isolation (mirrors DropDashboard.test.tsx's pattern).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { DropIncomeDto, DropSelfSummaryDto } from '@crm/shared'

const useDropSummaryMock = vi.fn()
const useDropIncomesMock = vi.fn()
const useDropPaymentsMock = vi.fn()

vi.mock('@/hooks/use-drop-summary', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-drop-summary')>(
    '@/hooks/use-drop-summary',
  )
  return {
    ...actual,
    useDropSummary: () => useDropSummaryMock(),
  }
})

vi.mock('@/hooks/use-drop-incomes', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-drop-incomes')>(
    '@/hooks/use-drop-incomes',
  )
  return {
    ...actual,
    useDropIncomes: () => useDropIncomesMock(),
    useDropPayments: () => useDropPaymentsMock(),
  }
})

vi.mock('@/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog', () => ({
  CreateTransactionDialog: () => null,
}))

import { DropFinancePage } from '../components/DropFinancePage'

function makeSummary(): DropSelfSummaryDto {
  return {
    balance: 120.75,
    dropSharePercent: 5,
    pendingIncomesCount: 1,
    debtToCompany: 0,
    pendingObligationAmount: 300.48,
    pendingObligationCount: 1,
  }
}

function makeIncome(overrides: Partial<DropIncomeDto>): DropIncomeDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    companyName: 'TechCorp',
    amount: 1000,
    currency: 'USDT',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'pending',
    model: 'declared',
    ...overrides,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(<DropFinancePage />, { wrapper })
}

beforeEach(() => {
  useDropSummaryMock.mockReset()
  useDropIncomesMock.mockReset()
  useDropPaymentsMock.mockReset()
  useDropSummaryMock.mockReturnValue({ data: makeSummary(), isLoading: false, isError: false })
  useDropPaymentsMock.mockReturnValue({ data: [], isLoading: false })
})

describe('DropFinancePage — incomes table model discriminator (§AC3)', () => {
  it('a declared DROP_INCOME row shows the «Приход» badge', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [makeIncome({ id: 'declared-1', model: 'declared' })],
        total: 1,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    const row = screen.getByTestId('drop-income-row-declared-1')
    expect(row).toHaveTextContent('Приход')
    expect(row).not.toHaveTextContent('Начисление')
  })

  it('an obligation row (company-booked IOU) shows the «Начисление» badge', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [
          makeIncome({
            id: 'obligation-1',
            model: 'obligation',
            companyName: 'GamingTec',
            amount: 800.48,
            status: 'pending',
          }),
        ],
        total: 1,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    const row = screen.getByTestId('drop-income-row-obligation-1')
    expect(row).toHaveTextContent('Начисление')
    expect(row).not.toHaveTextContent('Приход')
    expect(row).toHaveTextContent('$800.48')
  })

  it('BOTH models render together in the same table, each with its own badge', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [
          makeIncome({ id: 'declared-1', model: 'declared' }),
          makeIncome({ id: 'obligation-1', model: 'obligation', status: 'paid' }),
        ],
        total: 2,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByTestId('drop-income-row-declared-1')).toHaveTextContent('Приход')
    expect(screen.getByTestId('drop-income-row-obligation-1')).toHaveTextContent('Начисление')
  })

  it('shows «Приходов пока нет» when the feed is empty', () => {
    useDropIncomesMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Приходов пока нет')).toBeInTheDocument()
  })
})
