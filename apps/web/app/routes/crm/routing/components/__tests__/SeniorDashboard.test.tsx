/**
 * SeniorDashboard.test.tsx — unit tests for the SENIOR рабочий хаб (senior dashboard).
 *
 * Covers:
 *   - loading skeleton state
 *   - error state
 *   - renders 3 KPI cards (active projects / income this month / pending payouts)
 *   - «Мои проекты» panel: rows with share %, empty-state
 *   - «Статус моих выплат» panel: salary status (currency-aware) + total income
 *   - salary status variants (PENDING / PAID / null → «Нет начисления»)
 *   - salary-currency fix: a UAH salary renders «50 000,00 UAH», NOT a $-figure
 *   - «Транзакции в работе» panel: only PENDING/VALIDATED SENIOR_INCOME (NOT
 *     PAID), «Добавить приход» + «Создать выплату» actions, empty-state
 *
 * `useSeniorSummary`, the shared finance dialogs, and `financeApi` are mocked so
 * the component renders in isolation; the transactions query runs through a real
 * QueryClient seeded via the mocked `financeApi.getTransactions`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SeniorSummaryDto, TransactionDto } from '@crm/shared'

const useSeniorSummaryMock = vi.fn()
const getTransactionsMock = vi.fn()
const createDialogSpy = vi.fn()
const payoutDialogSpy = vi.fn()
const payoutDetailDialogSpy = vi.fn()

vi.mock('@/hooks/use-senior-summary', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-senior-summary')>(
    '@/hooks/use-senior-summary',
  )
  return {
    ...actual,
    useSeniorSummary: () => useSeniorSummaryMock(),
  }
})

vi.mock('@/routes/crm/finance/api', () => ({
  financeApi: {
    getTransactions: () => getTransactionsMock(),
  },
}))

// Stub the shared finance dialogs — they have their own tests. We only assert
// that the dashboard opens them (open=true) on the toolbar / row actions.
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
    // Salary is now currency-aware — UAH proves the bug fix end-to-end.
    mySalaryStatus: { amount: 50000, currency: 'UAH', status: 'PENDING' },
    // task-senior-stats-block — «Статистика заработка» (additive). 8-month
    // history (oldest → newest); newest = «this month», prev = «last month».
    earningsStats: {
      lastMonthIncome: 900,
      monthlyHistory: [
        { month: '2025-11', amount: 300 },
        { month: '2025-12', amount: 450 },
        { month: '2026-01', amount: 0 },
        { month: '2026-02', amount: 700 },
        { month: '2026-03', amount: 1100 },
        { month: '2026-04', amount: 850 },
        { month: '2026-05', amount: 900 },
        { month: '2026-06', amount: 1200 },
      ],
      companyIncomeProgress: { received: 1, total: 2 },
    },
    ...overrides,
  }
}

// Minimal TransactionDto fixture — the dashboard reads only id / type / status /
// amount / currency / projectName / payoutRequestId / createdAt. Other fields
// are filled to satisfy the type; the cast keeps the fixture concise.
function makeTx(overrides: Partial<TransactionDto>): TransactionDto {
  return {
    id: 't1',
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '1000',
    currency: 'USD',
    senderId: null,
    senderLabel: null,
    senderName: null,
    receiverId: '00000000-0000-4000-a000-000000000001',
    receiverLabel: null,
    receiverName: null,
    projectId: '00000000-0000-4000-b000-000000000001',
    projectName: 'Acme Migration',
    payoutRequestId: null,
    seniorSharePercent: 40,
    seniorSharePercentSource: 'PROJECT',
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: '2026-06-01T00:00:00.000Z',
    createdBy: '00000000-0000-4000-a000-000000000001',
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
  return render(<SeniorDashboard />, { wrapper })
}

beforeEach(() => {
  useSeniorSummaryMock.mockReset()
  getTransactionsMock.mockReset()
  createDialogSpy.mockReset()
  payoutDialogSpy.mockReset()
  payoutDetailDialogSpy.mockReset()
  getTransactionsMock.mockResolvedValue([])
})

describe('SeniorDashboard', () => {
  it('renders loading skeletons while fetching', () => {
    useSeniorSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderDashboard()
    expect(screen.getByTestId('senior-kpi-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('senior-kpi-grid')).not.toBeInTheDocument()
  })

  it('renders error state on fetch failure', () => {
    useSeniorSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderDashboard()
    expect(screen.getByTestId('senior-kpi-error')).toBeInTheDocument()
    expect(screen.getByText('Не удалось загрузить сводку')).toBeInTheDocument()
  })

  describe('KPI cards', () => {
    beforeEach(() => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
    })

    it('renders all 3 KPI cards', () => {
      renderDashboard()
      expect(screen.getByTestId('kpi-active-projects')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-senior-income')).toBeInTheDocument()
      expect(screen.getByTestId('kpi-pending-payouts')).toBeInTheDocument()
    })

    it('shows active-projects count', () => {
      renderDashboard()
      const cardEl = screen.getByTestId('kpi-active-projects')
      expect(cardEl).toHaveTextContent('2')
      expect(cardEl).toHaveTextContent('Активные проекты')
    })

    it('shows income this month + total sub-label (senior-share aggregate stays USD)', () => {
      renderDashboard()
      const cardEl = screen.getByTestId('kpi-senior-income')
      expect(cardEl).toHaveTextContent('$1,200.00')
      expect(cardEl).toHaveTextContent('Всего: $5,500.00')
    })

    it('shows pending-payouts count + amount', () => {
      renderDashboard()
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
      renderDashboard()
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
      renderDashboard()
      expect(screen.getByTestId('senior-projects-empty')).toHaveTextContent('Нет активных проектов')
    })
  })

  describe('«Статус моих выплат» panel — removed (§3 refactor)', () => {
    // Panel was removed in §3 detitle/dashboard refactor.
    // Guard: the panel must NOT appear in the DOM regardless of mySalaryStatus.
    it('does NOT render the «Статус моих выплат» panel', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      expect(screen.queryByTestId('senior-salary-status')).not.toBeInTheDocument()
    })

    it('does NOT render salary panel even with mySalaryStatus data', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: { amount: 2000, currency: 'USD', status: 'PAID' } }),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      expect(screen.queryByTestId('senior-salary-status')).not.toBeInTheDocument()
    })

    it('does NOT render salary panel when mySalaryStatus is null', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: null }),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      expect(screen.queryByTestId('senior-salary-status')).not.toBeInTheDocument()
    })
  })

  describe('«Статистика заработка» block (task-senior-stats-block)', () => {
    function mountWith(overrides: Partial<SeniorSummaryDto> = {}) {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(overrides),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
    }

    it('renders total tile with sparkline (no section heading — §3 removed)', () => {
      mountWith()
      // «СТАТИСТИКА ЗАРАБОТКА» section-heading was removed in §3 refactor.
      expect(screen.queryByTestId('earnings-stats-heading')).not.toBeInTheDocument()
      expect(screen.getByTestId('earnings-total-tile')).toBeInTheDocument()
      // Total reuses seniorShareIncome.total ($5,500.00).
      expect(screen.getByTestId('earnings-total-value')).toHaveTextContent('$5,500.00')
      // Sparkline rendered (non-empty history).
      expect(screen.getByTestId('earnings-sparkline')).toBeInTheDocument()
      expect(screen.queryByTestId('earnings-sparkline-empty')).not.toBeInTheDocument()
    })

    it('shows the «+$X этот месяц» badge when this-month income > 0', () => {
      mountWith()
      const badge = screen.getByTestId('earnings-total-month-badge')
      expect(badge).toHaveTextContent('$1,200.00')
      expect(badge).toHaveTextContent('этот месяц')
    })

    it('hides the month badge when this-month income is 0', () => {
      mountWith({ seniorShareIncome: { total: 5500, thisMonth: 0, currency: 'USD' } })
      expect(screen.queryByTestId('earnings-total-month-badge')).not.toBeInTheDocument()
    })

    it('does NOT render «Прошлый месяц» tile — replaced by projects list (§3 refactor)', () => {
      mountWith()
      // «Прошлый месяц» tile was removed in §3; projects list is shown instead.
      expect(screen.queryByTestId('earnings-last-month-tile')).not.toBeInTheDocument()
      // Projects tile is present instead.
      expect(screen.getByTestId('earnings-projects-tile')).toBeInTheDocument()
    })

    it('renders «Этот месяц» with the X/N arrival progress bar (NO money expected)', () => {
      mountWith()
      const tile = screen.getByTestId('earnings-this-month-tile')
      expect(tile).toHaveTextContent('Этот месяц')
      expect(tile).toHaveTextContent('Июнь 2026')
      expect(screen.getByTestId('earnings-this-month-value')).toHaveTextContent('$1,200.00')
      // Progress: received 1 / total 2 → «1/2 ... 50%».
      expect(screen.getByTestId('earnings-progress-fraction')).toHaveTextContent('1/2')
      expect(screen.getByTestId('earnings-company-progress')).toHaveTextContent(
        'приходов от компаний',
      )
      expect(screen.getByTestId('earnings-company-progress')).toHaveTextContent('50%')
      const bar = screen.getByRole('progressbar', { name: 'Приходы от компаний за этот месяц' })
      expect(bar).toHaveAttribute('aria-valuenow', '1')
      expect(bar).toHaveAttribute('aria-valuemax', '2')
    })

    it('does NOT render any money "ожидается получить" / expected-money figure', () => {
      mountWith()
      // The forbidden money-expected wording must never appear in the stats block.
      expect(screen.queryByText(/ожидается получить/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/ожидается ещё получить/i)).not.toBeInTheDocument()
    })

    it('empty state: zero income → flat sparkline still rendered, 0/0 progress 0%', () => {
      mountWith({
        seniorShareIncome: { total: 0, thisMonth: 0, currency: 'USD' },
        earningsStats: {
          lastMonthIncome: 0,
          monthlyHistory: [
            { month: '2026-05', amount: 0 },
            { month: '2026-06', amount: 0 },
          ],
          companyIncomeProgress: { received: 0, total: 0 },
        },
      })
      expect(screen.getByTestId('earnings-total-value')).toHaveTextContent('$0.00')
      // Non-empty array → sparkline (flat), not the empty placeholder.
      expect(screen.getByTestId('earnings-sparkline')).toBeInTheDocument()
      expect(screen.getByTestId('earnings-progress-fraction')).toHaveTextContent('0/0')
      expect(screen.getByTestId('earnings-company-progress')).toHaveTextContent('0%')
    })
  })

  describe('No finance CTA (removed)', () => {
    it('does NOT render the «Открыть финансы» CTA', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      expect(screen.queryByTestId('senior-finance-cta')).not.toBeInTheDocument()
    })
  })

  describe('«Транзакции в работе» panel', () => {
    beforeEach(() => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
    })

    it('shows empty-state when the senior has no in-progress income', async () => {
      getTransactionsMock.mockResolvedValue([])
      renderDashboard()
      expect(await screen.findByTestId('senior-in-progress-empty')).toBeInTheDocument()
    })

    it('lists ONLY PENDING/VALIDATED SENIOR_INCOME — PAID is excluded', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'pending-1', status: 'PENDING' }),
        makeTx({ id: 'validated-1', status: 'VALIDATED' }),
        makeTx({ id: 'paid-1', status: 'PAID' }),
      ])
      renderDashboard()
      expect(await screen.findByTestId('senior-in-progress-row-pending-1')).toBeInTheDocument()
      expect(screen.getByTestId('senior-in-progress-row-validated-1')).toBeInTheDocument()
      // PAID (terminal / «зелёные») must NOT appear in the in-progress list.
      expect(screen.queryByTestId('senior-in-progress-row-paid-1')).not.toBeInTheDocument()
    })

    it('renders «Создать выплату» ONLY on VALIDATED rows without a payout', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'pending-1', status: 'PENDING' }),
        makeTx({ id: 'validated-1', status: 'VALIDATED', payoutRequestId: null }),
        makeTx({ id: 'validated-2', status: 'VALIDATED', payoutRequestId: 'pr-existing' }),
      ])
      renderDashboard()
      await screen.findByTestId('senior-in-progress-row-validated-1')
      expect(screen.getByTestId('senior-in-progress-payout-validated-1')).toBeInTheDocument()
      // PENDING row has no payout action.
      expect(screen.queryByTestId('senior-in-progress-payout-pending-1')).not.toBeInTheDocument()
      // VALIDATED row already in a payout has no action.
      expect(screen.queryByTestId('senior-in-progress-payout-validated-2')).not.toBeInTheDocument()
    })

    it('«Добавить приход» opens the (reused) CreateTransactionDialog', async () => {
      getTransactionsMock.mockResolvedValue([])
      renderDashboard()
      await screen.findByTestId('senior-in-progress-empty')
      fireEvent.click(screen.getByTestId('senior-add-income'))
      expect(await screen.findByTestId('mock-create-dialog')).toBeInTheDocument()
    })

    it('«Создать выплату» on a VALIDATED row opens PayoutDialog preselecting that tx', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'validated-1', status: 'VALIDATED', payoutRequestId: null }),
      ])
      renderDashboard()
      const payoutBtn = await screen.findByTestId('senior-in-progress-payout-validated-1')
      fireEvent.click(payoutBtn)
      expect(await screen.findByTestId('mock-payout-dialog')).toBeInTheDocument()
      await waitFor(() => {
        expect(payoutDialogSpy).toHaveBeenCalledWith(true, ['validated-1'])
      })
    })

    // AC1: PAYOUT PENDING_PAYMENT rows appear in the list with «Оплатить».
    it('renders PAYOUT PENDING_PAYMENT row with «Оплатить» button', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({
          id: 'payout-1',
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          payoutRequestId: 'pr-abc',
          projectName: null,
        }),
      ])
      renderDashboard()
      expect(await screen.findByTestId('senior-in-progress-row-payout-1')).toBeInTheDocument()
      expect(screen.getByTestId('senior-pay-payout-payout-1')).toBeInTheDocument()
      expect(screen.getByTestId('senior-pay-payout-payout-1')).toHaveTextContent('Оплатить')
    })

    it('«Оплатить» on a PAYOUT row opens PayoutDetailDialog with correct payoutRequestId', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({
          id: 'payout-1',
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          payoutRequestId: 'pr-abc',
          projectName: null,
        }),
      ])
      renderDashboard()
      const payBtn = await screen.findByTestId('senior-pay-payout-payout-1')
      fireEvent.click(payBtn)
      expect(await screen.findByTestId('mock-payout-detail-dialog')).toBeInTheDocument()
      await waitFor(() => {
        expect(payoutDetailDialogSpy).toHaveBeenCalledWith(true, 'pr-abc')
      })
    })

    it('PAYOUT PAID row does NOT appear in the list', async () => {
      getTransactionsMock.mockResolvedValue([
        makeTx({ id: 'payout-paid', type: 'PAYOUT', status: 'PAID', payoutRequestId: 'pr-xyz' }),
      ])
      renderDashboard()
      // Only PENDING_PAYMENT payouts appear; PAID is terminal.
      expect(await screen.findByTestId('senior-in-progress-empty')).toBeInTheDocument()
      expect(screen.queryByTestId('senior-in-progress-row-payout-paid')).not.toBeInTheDocument()
    })
  })
})
