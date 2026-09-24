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
import { render as rtlRender, screen, fireEvent, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { AccountantSummaryDto, TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

// task-i18n-stage3a (Task 1) blast-radius: `AccountantDashboard` now calls
// `useLingui()`/`useLocale()` directly. Shadowing `render` wraps every call
// site with `I18nTestProvider` in one place.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

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
vi.mock('@/routes/_authenticated/finance/components/dialogs/ValidateDialog', () => ({
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

vi.mock('@/routes/_authenticated/finance/api', () => ({
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

beforeEach(async () => {
  useAccountantSummaryMock.mockReset()
  useQueryMock.mockReset()
  // Default: transactions query returns empty list
  useQueryMock.mockReturnValue({ data: [] })
  await loadCatalog('uk')
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
    expect(screen.getByText('Не вдалося завантажити фінансове зведення')).toBeInTheDocument()
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

    // Independent of the component's own implementation — computed straight
    // from `Intl`, the same source `format.spec.ts` uses (formatMoney is
    // `<amount> <CODE>`, not the old $-prefixed toLocaleString). jest-dom's
    // `toHaveTextContent` normalizes ALL whitespace in the rendered DOM text
    // — including uk-UA's U+00A0 grouping separator — to a plain space, so
    // the expected string is normalized the same way here.
    const ukMoney = (n: number) =>
      new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        .format(n)
        .replace(/\s/g, ' ') + ' USD'

    it('shows pending validation count and amount', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-pending-validation')
      expect(card).toHaveTextContent('4')
      expect(card).toHaveTextContent(ukMoney(15000))
      expect(card).toHaveTextContent('Очікують валідації')
    })

    it('shows validated-this-month count and amount', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-validated-month')
      expect(card).toHaveTextContent('1')
      expect(card).toHaveTextContent(ukMoney(1000))
      expect(card).toHaveTextContent('Валідовано за місяць')
    })

    it('shows paid-this-month amount', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-paid-month')
      expect(card).toHaveTextContent(ukMoney(0))
      expect(card).toHaveTextContent('Виплачено за місяць')
    })

    it('shows recipient count', () => {
      render(<AccountantDashboard />)
      const card = screen.getByTestId('kpi-recipient-count')
      expect(card).toHaveTextContent('3')
      expect(card).toHaveTextContent('Отримувачів')
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
        'Перевірити доходи (4)',
      )
    })

    // Mutation gate (ConditionalExpression, AccountantDashboard.tsx's
    // `pendingValidation.count > 0 ? <Plural> : <Trans>` branch) — the
    // TRUE branch (count > 0) had no assertion on its own rendered text;
    // only the count=0 branch below did.
    it('shows the pluralized «N доходи чекають на вашу перевірку» sub-label when pending > 0', () => {
      useAccountantSummaryMock.mockReturnValue({
        data: makeSummary({ pendingValidation: { count: 4, amount: 15000 } }),
        isLoading: false,
        isError: false,
      })
      render(<AccountantDashboard />)
      // uk CLDR 'few' for N=4 (n%10 in 2-4, n%100 not 12-14).
      expect(screen.getByText('4 доходи чекають на вашу перевірку')).toBeInTheDocument()
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
      expect(screen.getByText('Немає доходів, що очікують валідації')).toBeInTheDocument()
      expect(screen.getByTestId('accountant-validate-cta')).toBeDisabled()
    })
  })
})
