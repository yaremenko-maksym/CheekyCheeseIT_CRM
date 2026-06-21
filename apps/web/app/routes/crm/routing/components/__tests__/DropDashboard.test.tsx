/**
 * DropDashboard.test.tsx — unit tests for the DROP ролевой дашборд.
 *
 * Verifies:
 *   - renders 3 KPI cards (active-projects / balance / pending-incomes)
 *   - loading skeleton state
 *   - error state
 *   - «Транзакции в работе» panel (mode='drop'):
 *       - DROP_INCOME rows (PENDING/VALIDATED) are shown; PAID excluded
 *       - VALIDATED DROP_INCOME → «Платить» button → navigates to /crm/payments/initiate/$incomeId
 *       - createPayoutRequest / batch «Создать выплату» are NOT shown (SENIOR-only → 403)
 *       - PayoutDetailDialog / «Оплатить» are NOT shown (drop settles via initiate route)
 *       - «Добавить приход» opens CreateTransactionDialog
 *   - SeniorDashboard NOT regressed: senior keeps «Создать выплату» + «Оплатить» actions
 *
 * All hooks and dialogs are mocked so the component renders in isolation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { TransactionDto } from '@crm/shared'

// ── navigate mock ────────────────────────────────────────────────────────────

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

// ── Hook mocks ───────────────────────────────────────────────────────────────

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

// Stub shared finance dialogs.
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  useDropSummaryMock.mockReset()
  useDropProjectsMock.mockReset()
  getTransactionsMock.mockReset()
  createDialogSpy.mockReset()
  payoutDialogSpy.mockReset()
  payoutDetailDialogSpy.mockReset()
  navigateMock.mockReset()
  getTransactionsMock.mockResolvedValue([])
})

// ── Tests ─────────────────────────────────────────────────────────────────────

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

  describe('«Транзакции в работе» panel (mode=drop) — settlement via payment-channel', () => {
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
      // PAID is terminal — must not appear.
      expect(screen.queryByTestId('drop-in-progress-row-paid-1')).not.toBeInTheDocument()
    })

    it('VALIDATED DROP_INCOME shows «Платить» button (payment-channel route)', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'validated-1', status: 'VALIDATED', payoutRequestId: null }),
      ])
      renderDashboard()
      await screen.findByTestId('drop-in-progress-row-validated-1')
      const payBtn = screen.getByTestId('drop-in-progress-pay-validated-1')
      expect(payBtn).toBeInTheDocument()
      expect(payBtn).toHaveTextContent('Платить')
    })

    it('«Платить» navigates to /crm/payments/initiate/$incomeId', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'validated-1', status: 'VALIDATED', payoutRequestId: null }),
      ])
      renderDashboard()
      const payBtn = await screen.findByTestId('drop-in-progress-pay-validated-1')
      fireEvent.click(payBtn)
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/crm/payments/initiate/$incomeId',
        params: { incomeId: 'validated-1' },
      })
    })

    it('PENDING DROP_INCOME does NOT have «Платить» (only VALIDATED can pay)', async () => {
      getTransactionsMock.mockResolvedValue([makeTx({ id: 'pending-1', status: 'PENDING' })])
      renderDashboard()
      await screen.findByTestId('drop-in-progress-row-pending-1')
      expect(screen.queryByTestId('drop-in-progress-pay-pending-1')).not.toBeInTheDocument()
    })

    it('does NOT render «Создать выплату» row-button for DROP (SENIOR-only endpoint)', async () => {
      // createPayoutRequest is 403 for DROP — must never appear.
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'validated-1', status: 'VALIDATED', payoutRequestId: null }),
      ])
      renderDashboard()
      await screen.findByTestId('drop-in-progress-row-validated-1')
      // Row-level «Создать выплату» testid used by senior mode must be absent.
      expect(screen.queryByTestId('drop-in-progress-payout-validated-1')).not.toBeInTheDocument()
    })

    it('does NOT render batch «Создать выплату» toolbar button for DROP', async () => {
      // Batch createPayoutRequest is 403 for DROP — button must be hidden.
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'v1', status: 'VALIDATED', payoutRequestId: null }),
      ])
      renderDashboard()
      await screen.findByTestId('drop-in-progress-row-v1')
      expect(screen.queryByTestId('drop-create-payout-batch')).not.toBeInTheDocument()
    })

    it('does NOT render «Оплатить»→PayoutDetailDialog for DROP (senior-only pay path)', async () => {
      // PAYOUT rows are not shown to drop — drop settles via initiate, not PayoutDetailDialog.
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
      // PAYOUT row should not be rendered for drop at all.
      expect(await screen.findByTestId('drop-in-progress-empty')).toBeInTheDocument()
      expect(screen.queryByTestId('drop-in-progress-row-payout-1')).not.toBeInTheDocument()
      expect(screen.queryByTestId('drop-pay-payout-payout-1')).not.toBeInTheDocument()
    })

    it('«Добавить приход» opens CreateTransactionDialog', async () => {
      getTransactionsMock.mockResolvedValue([])
      renderDashboard()
      await screen.findByTestId('drop-in-progress-empty')
      fireEvent.click(screen.getByTestId('drop-add-income'))
      expect(await screen.findByTestId('mock-create-dialog')).toBeInTheDocument()
    })
  })
})
