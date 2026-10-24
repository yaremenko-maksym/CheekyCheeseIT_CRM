/**
 * SR-795-M-1 / owner decision D-3 — the existing-parts panel is wired into the
 * create dialog for SALARY and for nothing else.
 *
 * The mutation gate reported the `type === 'SALARY' &&` guard mutable to
 * `true`, to `false`, to `!==` and to `||`, with every test still passing
 * (CR-H-2): the panel's own spec renders the component directly, so nothing
 * tested the condition that decides whether the dialog renders it at all.
 * `true` would query `/finance/salary-parts` on every transaction type with a
 * receiver that is not a salaried employee; `false` would silently restore the
 * blindness this task exists to remove.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Admin' } }),
}))

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const getSalaryPartsMock = vi.fn()
vi.mock('../../../api', async (orig) => {
  const real = await orig<typeof import('../../../api')>()
  return {
    ...real,
    financeApi: {
      ...real.financeApi,
      getSalaryParts: (...args: unknown[]) => getSalaryPartsMock(...args),
      getTransactions: vi.fn().mockResolvedValue([]),
    },
  }
})

import { CreateTransactionDialog } from '../CreateTransactionDialog'

const RECEIVER = '11111111-1111-4111-8111-111111111111'

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CreateTransactionDialog
        open
        onClose={() => {}}
        salaryPrefill={{ receiverId: RECEIVER, salaryMonth: '2026-09', currency: 'USD' }}
      />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

beforeEach(async () => {
  await loadCatalog('uk')
  getSalaryPartsMock.mockReset()
  getSalaryPartsMock.mockResolvedValue({
    receiverId: RECEIVER,
    month: '2026-09',
    parts: [
      {
        id: '22222222-2222-4222-8222-000000000001',
        amount: 1500,
        currency: 'USD',
        status: 'PENDING',
        salaryOrigin: 'MANUAL',
        txDate: null,
        notes: null,
      },
    ],
  })
})

describe('CreateTransactionDialog — existing salary parts (SR-795-M-1)', () => {
  it('shows the panel when the type is SALARY', async () => {
    renderDialog()

    // The prefill opens the dialog on SALARY with the receiver and month set.
    expect(
      await screen.findByTestId('create-transaction-existing-salary-parts'),
    ).toBeInTheDocument()
    expect(getSalaryPartsMock).toHaveBeenCalledWith(RECEIVER, '2026-09')
  })

  it('drops the panel — and stops asking — when the type switches away from SALARY', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-existing-salary-parts')
    getSalaryPartsMock.mockClear()

    fireEvent.click(screen.getByTestId('create-transaction-type-expense'))

    await waitFor(() =>
      expect(screen.queryByTestId('create-transaction-existing-salary-parts')).toBeNull(),
    )
    // An EXPENSE has no salary month and its receiver is a category, so asking
    // at all would be a request the server answers with 400.
    expect(getSalaryPartsMock).not.toHaveBeenCalled()
  })
})
