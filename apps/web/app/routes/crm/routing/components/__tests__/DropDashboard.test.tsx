/**
 * DropDashboard.test.tsx — unit tests for the DROP ролевой дашборд (AC2).
 *
 * Verifies:
 *   - renders 3 KPI cards (active-projects / balance / pending-incomes)
 *   - loading skeleton state
 *   - error state
 *   - «Транзакции в работе» panel with DROP_INCOME rows (PENDING/VALIDATED)
 *   - PAYOUT PENDING_PAYMENT row shows «Оплатить» button → opens PayoutDetailDialog
 *   - VALIDATED DROP_INCOME without payout → «Создать выплату» button
 *   - «Добавить приход» opens CreateTransactionDialog
 *   - crm/index.tsx routes DROP → DropDashboard (AC3)
 *
 * All hooks and dialogs are mocked so the component renders in isolation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { TransactionDto } from '@crm/shared'

// ── Mock hooks ──────────────────────────────────────────────────────────────

const useDropSummaryMock = vi.fn()
const useDropProjectsMock = vi.fn()
const getTransactionsMock = vi.fn()

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
    useDropProjects: () => useDropProjectsMock(),
  }
})

vi.mock('@/routes/crm/finance/api', () => ({
  financeApi: {
    getTransactions: () => getTransactionsMock(),
  },
}))

// Stub shared finance dialogs — they have their own tests.
const createDialogSpy = vi.fn()
const payoutDialogSpy = vi.fn()
const payoutDetailDialogSpy = vi.fn()

vi.mock('@/routes/crm/finance/components/dialogs/CreateTransactionDialog', () => ({
  CreateTransactionDialog: ({ open }: { open: boolean }) => {
    createDialogSpy(open)
    return open ? <div data-testid="mock-create-dialog" /> : null
  },
}))

vi.mock('@/routes/crm/finance/components/dialogs/PayoutDialog', () => ({
  PayoutDialog: ({ open, preselectedTxIds }: { open: boolean; preselectedTxIds?: string[] }) => {
    payoutDialogSpy(open, preselectedTxIds)
    return open ? <div data-testid="mock-payout-dialog" /> : null
  },
}))

vi.mock('@/routes/crm/finance/components/dialogs/PayoutDetailDialog', () => ({
  PayoutDetailDialog: ({ open, payoutId }: { open: boolean; payoutId: string | null }) => {
    payoutDetailDialogSpy(open, payoutId)
    return open ? <div data-testid="mock-payout-detail-dialog" /> : null
  },
}))

import { DropDashboard } from '../DropDashboard'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeDropSummary() {
  return {
    balance: 3200,
    dropSharePercent: 30,
    pendingIncomesCount: 2,
    debtToCompany: 0,
  }
}

function makeDropProjects() {
  return [
    { id: 'dp1', name: 'Drop Project Alpha', seniorName: 'Ivan' },
    { id: 'dp2', name: 'Drop Project Beta', seniorName: 'Olena' },
  ]
}

function makeTx(overrides: Partial<TransactionDto>): TransactionDto {
  return {
    id: 't1',
    type: 'DROP_INCOME',
    status: 'PENDING',
    amount: '1000',
    currency: 'USD',
    senderId: null,
    senderLabel: null,
    senderName: null,
    receiverId: 'drop-user-id',
    receiverLabel: null,
    receiverName: null,
    projectId: 'dp1',
    projectName: 'Drop Project Alpha',
    payoutRequestId: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: '2026-06-01T00:00:00.000Z',
    createdBy: 'drop-user-id',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(<DropDashboard />, { wrapper })
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  useDropSummaryMock.mockReset()
  useDropProjectsMock.mockReset()
  getTransactionsMock.mockReset()
  createDialogSpy.mockReset()
  payoutDialogSpy.mockReset()
  payoutDetailDialogSpy.mockReset()
  getTransactionsMock.mockResolvedValue([])
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DropDashboard', () => {
  it('renders loading skeletons while fetching', () => {
    useDropSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    useDropProjectsMock.mockReturnValue({ data: undefined, isLoading: true })
    renderDashboard()
    expect(screen.getByTestId('drop-kpi-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('drop-kpi-grid')).not.toBeInTheDocument()
  })

  it('renders error state on summary fetch failure', () => {
    useDropSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    useDropProjectsMock.mockReturnValue({ data: makeDropProjects(), isLoading: false })
    renderDashboard()
    expect(screen.getByTestId('drop-kpi-error')).toBeInTheDocument()
    expect(screen.getByText('Не удалось загрузить сводку')).toBeInTheDocument()
  })

  describe('KPI cards (senior-style layout)', () => {
    beforeEach(() => {
      useDropSummaryMock.mockReturnValue({
        data: makeDropSummary(),
        isLoading: false,
        isError: false,
      })
      useDropProjectsMock.mockReturnValue({ data: makeDropProjects(), isLoading: false })
    })

    it('renders 3 KPI cards in senior-style grid', () => {
      renderDashboard()
      expect(screen.getByTestId('drop-kpi-grid')).toBeInTheDocument()
      expect(screen.getByTestId('drop-kpi-active-projects')).toBeInTheDocument()
      expect(screen.getByTestId('drop-kpi-balance')).toBeInTheDocument()
      expect(screen.getByTestId('drop-kpi-pending')).toBeInTheDocument()
    })

    it('shows active-projects count from useDropProjects', () => {
      renderDashboard()
      const card = screen.getByTestId('drop-kpi-active-projects')
      expect(card).toHaveTextContent('2')
      expect(card).toHaveTextContent('Активные проекты')
    })

    it('shows balance and dropSharePercent from useDropSummary', () => {
      renderDashboard()
      const card = screen.getByTestId('drop-kpi-balance')
      expect(card).toHaveTextContent('$3,200.00')
      expect(card).toHaveTextContent('30%')
    })

    it('shows pendingIncomesCount from useDropSummary', () => {
      renderDashboard()
      const card = screen.getByTestId('drop-kpi-pending')
      expect(card).toHaveTextContent('2')
      expect(card).toHaveTextContent('Приходы в работе')
    })
  })

  describe('«Транзакции в работе» panel (InProgressPanel)', () => {
    beforeEach(() => {
      useDropSummaryMock.mockReturnValue({
        data: makeDropSummary(),
        isLoading: false,
        isError: false,
      })
      useDropProjectsMock.mockReturnValue({ data: makeDropProjects(), isLoading: false })
    })

    it('shows empty-state when no transactions', async () => {
      getTransactionsMock.mockResolvedValue([])
      renderDashboard()
      expect(await screen.findByTestId('drop-in-progress-empty')).toBeInTheDocument()
    })

    it('renders DROP_INCOME rows (PENDING/VALIDATED), excludes PAID', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'pending-1', status: 'PENDING' }),
        makeTx({ id: 'validated-1', status: 'VALIDATED' }),
        makeTx({ id: 'paid-1', status: 'PAID' }),
      ])
      renderDashboard()
      expect(await screen.findByTestId('drop-in-progress-row-pending-1')).toBeInTheDocument()
      expect(screen.getByTestId('drop-in-progress-row-validated-1')).toBeInTheDocument()
      expect(screen.queryByTestId('drop-in-progress-row-paid-1')).not.toBeInTheDocument()
    })

    it('renders «Создать выплату» on VALIDATED DROP_INCOME without payout', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'validated-1', status: 'VALIDATED', payoutRequestId: null }),
        makeTx({ id: 'validated-2', status: 'VALIDATED', payoutRequestId: 'pr-existing' }),
        makeTx({ id: 'pending-1', status: 'PENDING' }),
      ])
      renderDashboard()
      await screen.findByTestId('drop-in-progress-row-validated-1')
      // Only validated-1 (no payoutRequestId) gets the button
      expect(screen.getByTestId('drop-in-progress-payout-validated-1')).toBeInTheDocument()
      expect(screen.queryByTestId('drop-in-progress-payout-validated-2')).not.toBeInTheDocument()
      expect(screen.queryByTestId('drop-in-progress-payout-pending-1')).not.toBeInTheDocument()
    })

    it('renders PAYOUT PENDING_PAYMENT rows with «Оплатить» button (AC1 parity)', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({
          id: 'payout-1',
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          payoutRequestId: 'pr-001',
          projectName: null,
        }),
      ])
      renderDashboard()
      expect(await screen.findByTestId('drop-in-progress-row-payout-1')).toBeInTheDocument()
      expect(screen.getByTestId('drop-pay-payout-payout-1')).toBeInTheDocument()
      expect(screen.getByTestId('drop-pay-payout-payout-1')).toHaveTextContent('Оплатить')
    })

    it('«Оплатить» opens PayoutDetailDialog with correct payoutRequestId', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({
          id: 'payout-1',
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          payoutRequestId: 'pr-001',
          projectName: null,
        }),
      ])
      renderDashboard()
      const payBtn = await screen.findByTestId('drop-pay-payout-payout-1')
      fireEvent.click(payBtn)
      expect(await screen.findByTestId('mock-payout-detail-dialog')).toBeInTheDocument()
      await waitFor(() => {
        expect(payoutDetailDialogSpy).toHaveBeenCalledWith(true, 'pr-001')
      })
    })

    it('«Добавить приход» opens CreateTransactionDialog', async () => {
      getTransactionsMock.mockResolvedValue([])
      renderDashboard()
      await screen.findByTestId('drop-in-progress-empty')
      fireEvent.click(screen.getByTestId('drop-add-income'))
      expect(await screen.findByTestId('mock-create-dialog')).toBeInTheDocument()
    })

    it('«Создать выплату» batch button visible when validated incomes exist', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'v1', status: 'VALIDATED', payoutRequestId: null }),
      ])
      renderDashboard()
      expect(await screen.findByTestId('drop-create-payout-batch')).toBeInTheDocument()
    })

    it('batch «Создать выплату» opens PayoutDialog with no preselection', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'v1', status: 'VALIDATED', payoutRequestId: null }),
      ])
      renderDashboard()
      const batchBtn = await screen.findByTestId('drop-create-payout-batch')
      fireEvent.click(batchBtn)
      expect(await screen.findByTestId('mock-payout-dialog')).toBeInTheDocument()
      await waitFor(() => {
        expect(payoutDialogSpy).toHaveBeenCalledWith(true, [])
      })
    })
  })
})
