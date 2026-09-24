/**
 * routes/_authenticated/index.tsx — unit tests for `AdminDashboard`
 * («центр действий» — the ADMIN-role dashboard rendered at `/`).
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). This file had
 * ZERO tests before this round — the fix-round-1 mutation-gate follow-up
 * flagged it in "Remaining gap, itemized" (0 survived / 6 no-coverage on
 * a scoped `mutation:changed` run) as pre-existing debt from Steps 1-7.
 * Covers only what this round's diff actually touches: the two error-state
 * strings, the four KPI card titles, and the "Активні транзакції" heading —
 * NOT the full component (role-dispatch in `CrmDashboard`, the reused
 * finance dialogs, `ActiveTransactionsTable`'s own row rendering — those
 * have their own dedicated test files / are out of this diff's scope).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AdminSummary } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

function render(ui: ReactElement, options?: RenderOptions) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <I18nTestProvider>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </I18nTestProvider>
    ),
    ...options,
  })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

const useAdminSummaryMock = vi.fn()

vi.mock('@/hooks/use-admin-summary', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-admin-summary')>(
    '@/hooks/use-admin-summary',
  )
  return {
    ...actual,
    useAdminSummary: () => useAdminSummaryMock(),
  }
})

// The three reused finance dialogs and the transactions table each have
// their own dedicated test files — stub them so this file exercises only
// AdminDashboard's own render logic (isLoading / isError / KPI grid).
vi.mock('../finance/components/ActiveTransactionsTable', () => ({
  ActiveTransactionsTable: () => <div data-testid="mock-active-transactions-table" />,
}))
vi.mock('../finance/components/dialogs/SettleSeniorPayoutDialog', () => ({
  SettleSeniorPayoutDialog: () => null,
}))
vi.mock('../finance/components/dialogs/PaySalaryDialog', () => ({
  PaySalaryDialog: () => null,
}))
vi.mock('@/components/finance/ConfirmPayoutDialog', () => ({
  ConfirmPayoutDialog: () => null,
}))

import { Route } from '../index'

// `createFileRoute(...)({ component })` — the component itself isn't
// exported by name, only reachable via `Route.options.component`.
const CrmDashboard = Route.options.component!

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { role: 'ADMIN' } }),
}))

function makeSummary(overrides: Partial<AdminSummary> = {}): AdminSummary {
  return {
    kpis: {
      activeProjects: 5,
      employees: 12,
      projectsUnpaidThisMonth: 2,
      activeInterviews: 3,
    },
    activeTransactions: [],
    ...overrides,
  }
}

describe('AdminDashboard (routes/_authenticated/index.tsx)', () => {
  it('renders loading skeletons while fetching', () => {
    useAdminSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    render(<CrmDashboard />)
    expect(screen.getByTestId('admin-kpi-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-kpi-grid')).not.toBeInTheDocument()
  })

  it('renders the error state with both catalog strings', () => {
    useAdminSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    render(<CrmDashboard />)
    const errorCard = screen.getByTestId('admin-kpi-error')
    expect(errorCard).toHaveTextContent('Не вдалося завантажити зведення')
    expect(errorCard).toHaveTextContent('Оновіть сторінку або спробуйте пізніше')
  })

  it('renders all 4 KPI card titles + values from useAdminSummary', () => {
    useAdminSummaryMock.mockReturnValue({
      data: makeSummary(),
      isLoading: false,
      isError: false,
    })
    render(<CrmDashboard />)

    const activeProjects = screen.getByTestId('kpi-active-projects')
    expect(activeProjects).toHaveTextContent('Активних проєктів')
    expect(activeProjects).toHaveTextContent('5')

    const employees = screen.getByTestId('kpi-employees')
    expect(employees).toHaveTextContent('Співробітників')
    expect(employees).toHaveTextContent('12')

    const unpaid = screen.getByTestId('kpi-projects-unpaid')
    expect(unpaid).toHaveTextContent('Проєктів не оплачено цього місяця')
    expect(unpaid).toHaveTextContent('2')

    const interviews = screen.getByTestId('kpi-active-interviews')
    expect(interviews).toHaveTextContent('Співбесід')
    expect(interviews).toHaveTextContent('3')
  })

  it('renders the "Активні транзакції" heading and the transactions table', () => {
    useAdminSummaryMock.mockReturnValue({
      data: makeSummary(),
      isLoading: false,
      isError: false,
    })
    render(<CrmDashboard />)
    expect(screen.getByText('Активні транзакції')).toBeInTheDocument()
    expect(screen.getByTestId('mock-active-transactions-table')).toBeInTheDocument()
  })
})
