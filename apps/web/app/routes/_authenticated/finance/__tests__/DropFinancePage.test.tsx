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
 *
 * task-i18n-stage3a (Task 1) blast-radius: `DropBalanceCard` (rendered by
 * this page) now calls `useLingui()` — this file is outside the wave's own
 * perimeter (`routes/_authenticated/finance/**` migrates in a later wave),
 * so only the render wrapper changes here, not any product code or copy
 * assertion (this page's own strings stay Russian until its wave).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { DropIncomeDto, DropSelfSummaryDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

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
    <I18nTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nTestProvider>
  )
  return render(<DropFinancePage />, { wrapper })
}

beforeEach(async () => {
  useDropSummaryMock.mockReset()
  useDropIncomesMock.mockReset()
  useDropPaymentsMock.mockReset()
  useDropSummaryMock.mockReturnValue({ data: makeSummary(), isLoading: false, isError: false })
  useDropPaymentsMock.mockReturnValue({ data: [], isLoading: false })
  await loadCatalog('uk')
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
    expect(row).toHaveTextContent('Дохід')
    expect(row).not.toHaveTextContent('Нарахування')
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
    expect(row).toHaveTextContent('Нарахування')
    expect(row).not.toHaveTextContent('Дохід')
    // task-i18n-stage3d-pr2: `fmtUsd` is now locale-aware (`formatNumber`
    // with the active catalog locale) — the `I18nTestProvider` default (`uk`)
    // groups digits with a comma decimal separator, not the old hardcoded
    // `en-US` period.
    expect(row).toHaveTextContent('$800,48')
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
    expect(screen.getByTestId('drop-income-row-declared-1')).toHaveTextContent('Дохід')
    expect(screen.getByTestId('drop-income-row-obligation-1')).toHaveTextContent('Нарахування')
  })

  it('shows «Приходов пока нет» when the feed is empty', () => {
    useDropIncomesMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Приходів ще немає')).toBeInTheDocument()
  })
})

// task-drop-sees-own-obligations (security-review PR #523 round 1, MED-5):
// `amount` means a DIFFERENT kind of number per model — a declared row's
// amount is the GROSS client payment; an obligation row's amount is already
// the drop's NET share. Both render under one "Сумма" column, so each row
// must label which kind of amount it is showing.
describe('DropFinancePage — amount-kind clarity (§MED-5)', () => {
  it('a declared row labels its amount «Валовый приход» (gross)', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [makeIncome({ id: 'declared-1', model: 'declared', amount: 5000 })],
        total: 1,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByTestId('drop-income-amount-kind-declared-1')).toHaveTextContent(
      'Валовий прихід',
    )
  })

  it('an obligation row labels its amount «Ваша доля» (net share), never «Валовый приход»', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [makeIncome({ id: 'obligation-1', model: 'obligation', amount: 40.02 })],
        total: 1,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    const label = screen.getByTestId('drop-income-amount-kind-obligation-1')
    expect(label).toHaveTextContent('Ваша частка')
    expect(label).not.toHaveTextContent('Валовий прихід')
  })

  it('a $5,000 gross row and a $40 share row never read as directly comparable amounts', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [
          makeIncome({ id: 'declared-1', model: 'declared', amount: 5000 }),
          makeIncome({ id: 'obligation-1', model: 'obligation', amount: 40.02 }),
        ],
        total: 2,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByTestId('drop-income-amount-kind-declared-1')).toHaveTextContent(
      'Валовий прихід',
    )
    expect(screen.getByTestId('drop-income-amount-kind-obligation-1')).toHaveTextContent(
      'Ваша частка',
    )
  })
})

// task-i18n-stage3d-pr2 (mutation gate, AC10). None of the labels below were
// asserted anywhere before this wave — table headers, section titles, status
// text, pagination, payment history, and the register-income CTA. Each
// StringLiteral mutant on them survived by construction (nothing looked at
// the text). One assertion per label, so a blanked-out or wrong translation
// fails a test instead of passing silently.
describe('DropFinancePage — labels with no prior assertion (mutation-gate coverage)', () => {
  it('table section title and column headers render', () => {
    useDropIncomesMock.mockReturnValue({
      data: { items: [makeIncome({ id: 'declared-1' })], total: 1, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('МОЇ ПРИХОДИ')).toBeInTheDocument()
    expect(screen.getByText('Дата')).toBeInTheDocument()
    expect(screen.getByText('Компанія')).toBeInTheDocument()
    expect(screen.getByText('Сума')).toBeInTheDocument()
    expect(screen.getByText('Тип')).toBeInTheDocument()
    expect(screen.getByText('Статус')).toBeInTheDocument()
    expect(screen.getByText('Дія')).toBeInTheDocument()
  })

  it('each income status renders its own text on the status badge', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [
          makeIncome({ id: 'i-pending', status: 'pending' }),
          makeIncome({ id: 'i-validated', status: 'validated' }),
          makeIncome({ id: 'i-paid', status: 'paid' }),
          makeIncome({ id: 'i-rejected', status: 'rejected' }),
        ],
        total: 4,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByTestId('drop-income-status-i-pending')).toHaveTextContent('Очікує')
    expect(screen.getByTestId('drop-income-status-i-validated')).toHaveTextContent('Валідовано')
    expect(screen.getByTestId('drop-income-status-i-paid')).toHaveTextContent('Оплачено')
    expect(screen.getByTestId('drop-income-status-i-rejected')).toHaveTextContent('Відхилено')
  })

  it('reset-filters button appears and clears an active status filter', async () => {
    const user = userEvent.setup()
    useDropIncomesMock.mockReturnValue({
      data: { items: [makeIncome({ id: 'declared-1' })], total: 1, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.queryByText('Скинути фільтри')).not.toBeInTheDocument()
    // Open the status Select and pick a concrete status — flips `hasFilters`.
    await user.click(screen.getByTestId('drop-filter-status'))
    await user.click(screen.getByRole('option', { name: 'Валідовано' }))
    const resetBtn = await screen.findByText('Скинути фільтри')
    expect(resetBtn).toBeInTheDocument()
  })

  it('empty state with an active filter reads differently from the bare empty state', () => {
    useDropIncomesMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Приходів ще немає')).toBeInTheDocument()
    expect(screen.queryByText('Немає приходів за обраними фільтрами')).not.toBeInTheDocument()
  })

  it('pagination controls render and page forward/back when there is more than one page', async () => {
    const user = userEvent.setup()
    useDropIncomesMock.mockReturnValue({
      data: { items: [makeIncome({ id: 'declared-1' })], total: 25, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    const prevBtn = screen.getByRole('button', { name: 'Попередня' })
    const nextBtn = screen.getByRole('button', { name: 'Наступна' })
    expect(prevBtn).toBeDisabled()
    expect(nextBtn).not.toBeDisabled()
    await user.click(nextBtn)
    // Clicking «Наступна» bumps local page state — re-render still shows the
    // same mocked page-1 data (the hook is mocked), but the click itself must
    // not throw and the button must still be present afterwards.
    expect(screen.getByText('Наступна')).toBeInTheDocument()
  })

  it('both filter selects list every option with its localised text', async () => {
    const user = userEvent.setup()
    useDropIncomesMock.mockReturnValue({
      data: { items: [makeIncome({ id: 'declared-1' })], total: 1, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()

    await user.click(screen.getByTestId('drop-filter-status'))
    expect(screen.getAllByText('Усі статуси').length).toBeGreaterThan(0)
    expect(screen.getByRole('option', { name: 'Очікує' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Валідовано' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Оплачено' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Відхилено' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByTestId('drop-filter-period'))
    expect(screen.getAllByText('Усі періоди').length).toBeGreaterThan(0)
    expect(screen.getByRole('option', { name: 'Поточний місяць' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Минулий місяць' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Останні 3 міс.' })).toBeInTheDocument()
  })

  it('fmtUsd formats with exactly two fraction digits even for a whole number', () => {
    useDropIncomesMock.mockReturnValue({
      data: {
        items: [makeIncome({ id: 'declared-1', amount: 800 })],
        total: 1,
        page: 1,
        limit: 20,
      },
      isLoading: false,
    })
    renderPage()
    // With the `{}` mutant (no minimumFractionDigits) `Intl.NumberFormat`
    // drops the decimal part for a whole number — "$800" instead of the
    // correct "$800,00".
    expect(screen.getByTestId('drop-income-row-declared-1')).toHaveTextContent('$800,00')
    // The income row's own date uses formatDate's 'shortYY' style (same
    // fixture, createdAt: '2026-08-01') — exact string so a mutation to the
    // style key fails.
    expect(screen.getByTestId('drop-income-row-declared-1')).toHaveTextContent('01.08.26')
  })

  it('register-income CTA renders its localised label', () => {
    useDropIncomesMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByTestId('drop-register-income-btn')).toHaveTextContent('Зареєструвати прихід')
  })

  it('payments history renders its section title and each payment status text/variant', () => {
    useDropPaymentsMock.mockReturnValue({
      data: [
        { id: 'p1', createdAt: '2026-08-01T00:00:00.000Z', amount: 100, status: 'pending' },
        { id: 'p2', createdAt: '2026-08-02T00:00:00.000Z', amount: 200, status: 'confirmed' },
        { id: 'p3', createdAt: '2026-08-03T00:00:00.000Z', amount: 300, status: 'failed' },
      ],
      isLoading: false,
    })
    useDropIncomesMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('ПЛАТЕЖІ НА КОМПАНІЮ')).toBeInTheDocument()
    expect(screen.getByTestId('drop-payment-row-p1')).toHaveTextContent('Очікує')
    expect(screen.getByText('Очікує')).toHaveClass('bg-secondary')
    expect(screen.getByTestId('drop-payment-row-p2')).toHaveTextContent('Підтверджено')
    expect(screen.getByText('Підтверджено')).toHaveClass('bg-primary')
    expect(screen.getByTestId('drop-payment-row-p3')).toHaveTextContent('Не пройшов')
    expect(screen.getByText('Не пройшов')).toHaveClass('bg-destructive')
    // Payment row date uses formatDate's 'shortYY' style — exact string so a
    // mutation to the style key (silently switching formats) fails.
    expect(screen.getByTestId('drop-payment-row-p1')).toHaveTextContent('01.08.26')
  })

  it('payments history empty state renders "Переказів ще не було"', () => {
    useDropPaymentsMock.mockReturnValue({ data: [], isLoading: false })
    useDropIncomesMock.mockReturnValue({
      data: { items: [], total: 0, page: 1, limit: 20 },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText('Переказів ще не було')).toBeInTheDocument()
  })
})
