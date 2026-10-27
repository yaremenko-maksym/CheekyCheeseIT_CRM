/**
 * SPEC-L-2 (PR #1093 round 1) — row-level path through the REAL finance page:
 * a PAID SALARY row settled in USDT whose nominal `originalCurrency` is USD,
 * click "Add salary part" -> the create dialog opens prefilled with USD
 * (the nominal), not USDT (the settled currency).
 *
 * Mocked at the boundaries only (auth, router, axios, financeApi); the page,
 * table, row and dialog are real.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Admin' } }),
}))

vi.mock('@tanstack/react-router', async (orig) => {
  const real = await orig<typeof import('@tanstack/react-router')>()
  return {
    ...real,
    useNavigate: () => vi.fn(),
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
    createFileRoute: () => (options: unknown) => ({
      options,
      useSearch: () => ({}),
    }),
  }
})

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const { PAID_USDT_SALARY } = vi.hoisted(() => ({
  PAID_USDT_SALARY: {
    id: 'tx-paid-usdt-salary',
    type: 'SALARY',
    status: 'PAID',
    amount: '1000',
    currency: 'USDT',
    originalCurrency: 'USD',
    receiverId: 'junior-1',
    receiverName: 'Junior User',
    salaryMonth: '2026-09',
    senderId: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    txDate: '2026-10-01',
    deletedAt: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
  } as unknown as TransactionDto,
}))

vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>()
  return {
    ...real,
    financeApi: {
      ...real.financeApi,
      getTransactions: vi.fn().mockResolvedValue([PAID_USDT_SALARY]),
    },
  }
})

import { Route } from '../index'

// The salary month is now two selects (month name + year), not a native month input.
function expectSalaryMonth(month: string, year: string) {
  expect(screen.getByTestId('create-transaction-salary-month-select')).toHaveTextContent(month)
  expect(screen.getByTestId('create-transaction-salary-year-select')).toHaveTextContent(year)
}

function renderPage() {
  const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
    .component
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Page />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

describe('finance page — "Add salary part" prefill (SPEC-L-2)', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('prefills the NOMINAL currency (USD) of a PAID USDT-settled row, not USDT', async () => {
    renderPage()
    const button = await screen.findByTestId('tx-row-add-salary-part-tx-paid-usdt-salary')
    fireEvent.click(button)

    await waitFor(() => {
      expectSalaryMonth('Вересень', '2026')
    })
    const comboTexts = screen.getAllByRole('combobox').map((el) => el.textContent?.trim())
    expect(comboTexts).toContain('USD')
    expect(comboTexts).not.toContain('USDT')
  })
})
