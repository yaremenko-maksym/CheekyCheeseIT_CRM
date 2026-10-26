/**
 * QA-LOW-2: the salary month is now two selects, but the create-transaction request
 * must still carry `salaryMonth` as a plain 'YYYY-MM' string, exactly as the native
 * month input used to. Real react-query + dialog; only the API boundary is mocked.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Tester' } }),
}))

const USERS = [
  { id: 'admin-1', displayName: 'Admin One', role: 'ADMIN' },
  { id: 'junior-1', displayName: 'Junior One', role: 'JUNIOR' },
]

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/users')) return Promise.resolve({ data: USERS })
      return Promise.resolve({ data: [] })
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ trackFeatureClick: vi.fn() }))

const createSalary = vi.fn().mockResolvedValue({ id: 'tx-1' })
vi.mock('../../../api', () => ({
  financeApi: {
    createSalary: (...a: unknown[]) => createSalary(...a),
    getSalaryParts: vi.fn().mockResolvedValue({ parts: [] }),
  },
  companyAccountApi: { getAccount: vi.fn().mockResolvedValue({ balance: 100 }) },
}))

import { CreateTransactionDialog } from '../CreateTransactionDialog'

beforeEach(async () => {
  await loadCatalog('uk')
  createSalary.mockClear()
  // default month = previous calendar month; pin "now" so the picked month differs from it
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CreateTransactionDialog — salary month payload', () => {
  it('submits the month chosen in the picker as salaryMonth "YYYY-MM"', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nTestProvider>
        <QueryClientProvider client={qc}>
          <CreateTransactionDialog open onClose={() => {}} />
        </QueryClientProvider>
      </I18nTestProvider>,
    )
    fireEvent.click(await screen.findByTestId('create-transaction-type-salary'))
    fireEvent.click(screen.getByTestId('create-transaction-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: /Junior One/ }))
    fireEvent.change(screen.getByTestId('amount-currency-amount-input'), {
      target: { value: '500' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-salary-month-select'))
    fireEvent.click(await screen.findByTestId('salary-month-option-03'))
    fireEvent.click(screen.getByTestId('create-transaction-submit'))

    await waitFor(() => expect(createSalary).toHaveBeenCalledTimes(1))
    expect(createSalary.mock.calls[0][0]).toMatchObject({
      receiverId: 'junior-1',
      salaryMonth: '2026-03',
    })
  })
})
