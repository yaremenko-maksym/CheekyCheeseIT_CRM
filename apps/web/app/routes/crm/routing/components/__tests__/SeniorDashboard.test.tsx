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

  describe('«Статус моих выплат» panel (salary currency)', () => {
    it('shows salary in its OWN currency (UAH, no $-hardcode) + PENDING status', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary(),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      const status = screen.getByTestId('senior-salary-status')
      // ru-RU thin-space grouping + currency suffix — NOT «$50,000.00».
      expect(status).toHaveTextContent('UAH')
      expect(status).toHaveTextContent('50')
      expect(status).not.toHaveTextContent('$')
      expect(status).toHaveTextContent('Ожидает выплаты')
      const total = screen.getByTestId('senior-income-total')
      expect(total).toHaveTextContent('$5,500.00')
    })

    it('shows a USD salary in USD (no conversion)', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: { amount: 2000, currency: 'USD', status: 'PAID' } }),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      const status = screen.getByTestId('senior-salary-status')
      expect(status).toHaveTextContent('USD')
      expect(status).toHaveTextContent('Выплачено')
    })

    it('shows «Нет начисления» when no salary row exists', () => {
      useSeniorSummaryMock.mockReturnValue({
        data: makeSummary({ mySalaryStatus: null }),
        isLoading: false,
        isError: false,
      })
      renderDashboard()
      const status = screen.getByTestId('senior-salary-status')
      expect(status).toHaveTextContent('—')
      expect(status).toHaveTextContent('Нет начисления за месяц')
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
  })
})
