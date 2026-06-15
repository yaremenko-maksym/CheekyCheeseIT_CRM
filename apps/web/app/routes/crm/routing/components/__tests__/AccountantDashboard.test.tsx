/**
 * AccountantDashboard.test.tsx — unit tests for the ACCOUNTANT финансовый хаб
 * (ACCOUNTANT Sprint 1 + finance-validation-ux AC2/AC3).
 *
 * Covers:
 *   - loading skeleton state
 *   - error state
 *   - renders 4 KPI cards with correct values (pending / validated / paid / recipients)
 *   - CTA opens ValidateDialog queue (NOT navigate) when pending > 0
 *   - CTA is disabled / shows «нет приходов» sub-label when pending = 0
 *
 * `useAccountantSummary` and `useQuery` / `financeApi` are mocked so the
 * component renders in isolation (no real QueryClient / router needed).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AccountantSummaryDto, TransactionDto } from '@crm/shared'

const useAccountantSummaryMock = vi.fn()
const useQueryMock = vi.fn()

vi.mock('@/hooks/use-accountant-summary', () => ({
  useAccountantSummary: () => useAccountantSummaryMock(),
}))

// Mock @tanstack/react-query — useQuery used for transactions list
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: (...args: unknown[]) => useQueryMock(...args),
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  }
})

// ValidateDialog is a heavy component with its own queries; mock it to a
// lightweight sentinel so CTA tests stay focused on AccountantDashboard logic.
vi.mock('@/routes/crm/finance/components/dialogs/ValidateDialog', () => ({
  ValidateDialog: ({
    tx,
    onClose,
  }: {
    tx: { id: string } | null
    onClose: () => void
    queue: unknown[]
    onAdvance: (tx: unknown) => void
  }) =>
    tx ? (
      <div data-testid="validate-dialog-mock">
        <button onClick={onClose}>close</button>
      </div>
    ) : null,
}))

vi.mock('@/routes/crm/finance/api', () => ({
  financeApi: {
    getTransactions: vi.fn().mockResolvedValue([]),
  },
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

function makePendingTx(id: string): TransactionDto {
  return {
    id,
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: 1000,
    currency: 'USD',
    createdAt: new Date().toISOString(),
    senderName: null,
    projectName: null,
    notes: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    recipientId: 'user-1',
    rejectionReason: null,
  } as unknown as TransactionDto
}

beforeEach(() => {
  useAccountantSummaryMock.mockReset()
  useQueryMock.mockReset()
  // Default: transactions query returns empty list
  useQueryMock.mockReturnValue({ data: [] })
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

  describe('KPI cards', () => {
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

  describe('CTA — validate pending (AC2/AC3)', () => {
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

    it('opens ValidateDialog on CTA click when pending transactions exist (AC3)', () => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      // transactions query returns 2 pending items
      useQueryMock.mockReturnValue({
        data: [makePendingTx('tx-1'), makePendingTx('tx-2')],
      })
      render(<AccountantDashboard />)
      fireEvent.click(screen.getByTestId('accountant-validate-cta'))
      expect(screen.getByTestId('validate-dialog-mock')).toBeInTheDocument()
    })

    it('does NOT open ValidateDialog when transactions list is empty', () => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary({ pendingValidation: { count: 4, amount: 15000 } }),
        isLoading: false,
        isError: false,
      })
      // transactions query returns empty (edge: summary says 4 but transactions not loaded yet)
      useQueryMock.mockReturnValue({ data: [] })
      render(<AccountantDashboard />)
      fireEvent.click(screen.getByTestId('accountant-validate-cta'))
      expect(screen.queryByTestId('validate-dialog-mock')).not.toBeInTheDocument()
    })

    it('reflects «нет приходов» sub-label when pending = 0', () => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary({ pendingValidation: { count: 0, amount: 0 } }),
        isLoading: false,
        isError: false,
      })
      render(<AccountantDashboard />)
      expect(screen.getByText('Нет приходов, ожидающих валидации')).toBeInTheDocument()
      expect(screen.getByTestId('accountant-validate-cta')).toBeDisabled()
    })
  })
})
