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
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

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

vi.mock('@/routes/_authenticated/finance/api', () => ({
  financeApi: {
    getTransactions: () => getTransactionsMock(),
  },
}))

// Stub shared finance dialogs — they have their own tests.
const createDialogSpy = vi.fn()
const payoutDialogSpy = vi.fn()
const payoutDetailDialogSpy = vi.fn()

vi.mock('@/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog', () => ({
  CreateTransactionDialog: ({ open }: { open: boolean }) => {
    createDialogSpy(open)
    return open ? <div data-testid="mock-create-dialog" /> : null
  },
}))

vi.mock('@/routes/_authenticated/finance/components/dialogs/CompanySharePayoutModal', () => ({
  CompanySharePayoutModal: ({
    open,
    preselectedTxIds,
  }: {
    open: boolean
    preselectedTxIds?: string[]
  }) => {
    payoutDialogSpy(open, preselectedTxIds)
    return open ? <div data-testid="mock-payout-dialog" /> : null
  },
}))

vi.mock('@/routes/_authenticated/finance/components/dialogs/PayoutDetailDialog', () => ({
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
    pendingObligationAmount: 800.48,
    pendingObligationCount: 2,
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
    txFromAddress: null,
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
  // task-i18n-stage3a (Task 1) blast-radius: `DropDashboard` renders the
  // shared `InProgressPanel`/`PendingProjectApprovalsPanel` (`routing/components/`),
  // which now call `useLingui()`/`Trans` — outside this file's own perimeter.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nTestProvider>
  )
  return render(<DropDashboard />, { wrapper })
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(async () => {
  useDropSummaryMock.mockReset()
  useDropProjectsMock.mockReset()
  getTransactionsMock.mockReset()
  createDialogSpy.mockReset()
  payoutDialogSpy.mockReset()
  payoutDetailDialogSpy.mockReset()
  getTransactionsMock.mockResolvedValue([])
  await loadCatalog('uk')
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DropDashboard', () => {
  it('renders loading skeletons while fetching', () => {
    useDropSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    useDropProjectsMock.mockReturnValue({ data: undefined, isLoading: true })
    renderDashboard()
    expect(screen.getByTestId('drop-kpi-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('drop-kpi-grid')).not.toBeInTheDocument()
    // task-drop-sees-own-obligations, security-review round 2 (mutation-gate
    // closure): the loading grid was widened from 3 to 4 skeletons when the
    // «Ожидает выплаты» KPI card was added (§AC1), but nothing counted them —
    // `Array.from({ length: 4 })` mutated to `Array.from({})` (0 skeletons)
    // and this test still passed, since it only checked the WRAPPER testid.
    expect(screen.getAllByTestId('drop-kpi-skeleton')).toHaveLength(4)
  })

  it('renders error state on summary fetch failure', () => {
    useDropSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    useDropProjectsMock.mockReturnValue({ data: makeDropProjects(), isLoading: false })
    renderDashboard()
    expect(screen.getByTestId('drop-kpi-error')).toBeInTheDocument()
    expect(screen.getByText('Не вдалося завантажити зведення')).toBeInTheDocument()
  })

  // Independent of the component's own implementation — computed straight
  // from `Intl`, the same source `format.spec.ts` uses (formatMoney is
  // `<amount> <CODE>`, not the old $-prefixed toLocaleString). jest-dom's
  // `toHaveTextContent` normalizes ALL whitespace in the rendered DOM text —
  // including uk-UA's U+00A0 grouping separator — to a plain space, so the
  // expected string is normalized the same way here.
  const ukMoney = (n: number) =>
    new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .format(n)
      .replace(/\s/g, ' ') + ' USD'

  describe('KPI cards (senior-style layout)', () => {
    beforeEach(() => {
      useDropSummaryMock.mockReturnValue({
        data: makeDropSummary(),
        isLoading: false,
        isError: false,
      })
      useDropProjectsMock.mockReturnValue({ data: makeDropProjects(), isLoading: false })
    })

    it('renders 4 KPI cards in senior-style grid', () => {
      renderDashboard()
      expect(screen.getByTestId('drop-kpi-grid')).toBeInTheDocument()
      expect(screen.getByTestId('drop-kpi-active-projects')).toBeInTheDocument()
      expect(screen.getByTestId('drop-kpi-balance')).toBeInTheDocument()
      expect(screen.getByTestId('drop-kpi-pending-obligation')).toBeInTheDocument()
      expect(screen.getByTestId('drop-kpi-pending')).toBeInTheDocument()
    })

    it('shows active-projects count from useDropProjects', () => {
      renderDashboard()
      const card = screen.getByTestId('drop-kpi-active-projects')
      expect(card).toHaveTextContent('2')
      expect(card).toHaveTextContent('Активні проєкти')
    })

    it('shows balance and dropSharePercent from useDropSummary', () => {
      renderDashboard()
      const card = screen.getByTestId('drop-kpi-balance')
      expect(card).toHaveTextContent(ukMoney(3200))
      expect(card).toHaveTextContent('30%')
    })

    // task-drop-sees-own-obligations (§AC1/§AC2): the core bug this task
    // fixes — the hub must show what the company owes, as a card SEPARATE
    // from «Мій баланс» (never summed into 3 200,00 + 800,48).
    it('shows pendingObligationAmount from useDropSummary, distinct from balance', () => {
      renderDashboard()
      const card = screen.getByTestId('drop-kpi-pending-obligation')
      expect(card).toHaveTextContent(ukMoney(800.48))
      // pendingObligationCount: 2 → uk CLDR 'few' category (2-4, not 12-14).
      expect(card).toHaveTextContent("2 зобов'язання")
      expect(card).not.toHaveTextContent(ukMoney(4000.48))
      const balanceCard = screen.getByTestId('drop-kpi-balance')
      expect(balanceCard).toHaveTextContent(ukMoney(3200))
      expect(balanceCard).not.toHaveTextContent(ukMoney(800.48))
    })

    it("shows «Немає зобов'язань» when pendingObligationCount is 0", () => {
      useDropSummaryMock.mockReturnValue({
        data: { ...makeDropSummary(), pendingObligationAmount: 0, pendingObligationCount: 0 },
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      expect(screen.getByTestId('drop-kpi-pending-obligation')).toHaveTextContent(
        "Немає зобов'язань",
      )
    })

    it('shows pendingIncomesCount from useDropSummary', () => {
      renderDashboard()
      const card = screen.getByTestId('drop-kpi-pending')
      expect(card).toHaveTextContent('2')
      expect(card).toHaveTextContent('Доходи в роботі')
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
      expect(screen.getByTestId('drop-pay-payout-payout-1')).toHaveTextContent('Оплатити')
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
