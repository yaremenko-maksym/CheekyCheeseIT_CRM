/**
 * task-receipts-frontend — CreateTransactionDialog mandatory-receipt AC for
 * ADMIN_INCOME / EXPENSE / ADMIN_TRANSFER / DIVIDEND (the 4 types besides
 * SENIOR_INCOME/DROP_INCOME/USDT_INCOME, which already had their own coverage
 * before this task — USDT_INCOME's new mandatory-receipt case is pinned in
 * `CreateTransactionDialog.usdt-income.test.tsx`).
 *
 * Pins:
 * 1. ADMIN_INCOME (legacy funding, free currency): blocks submit without a
 *    receipt; submits with a plain url receipt (non-explorer, currency=USD).
 * 2. ADMIN_INCOME + COMPANY_ACCOUNT funding: currency forced USDT →
 *    explorer-only (no tab-toggle); a non-explorer url is rejected client-side
 *    (client validation mirrors the shared `receiptMandatoryError`); an
 *    explorer url submits successfully with the receipt fields.
 * 3. EXPENSE: blocks without a receipt; submits with one.
 * 4. ADMIN_TRANSFER: blocks without a receipt; submits with one (default
 *    currency USD → non-explorer).
 * 5. DIVIDEND: ALWAYS explorer-only (no currency selector, implicit USDT) —
 *    blocks without a receipt; submits with an explorer url.
 *
 * Strategy mirrors `CreateTransactionDialog.usdt-income.test.tsx` — real
 * `@tanstack/react-query` hooks (QueryClientProvider), API boundary mocked.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Admin One' } }),
}))

const ADMIN_USERS = [
  { id: 'admin-1', displayName: 'Admin One', role: 'ADMIN' },
  { id: 'admin-2', displayName: 'Admin Two', role: 'ADMIN' },
]

// ADMIN_INCOME requires a project (owned by the calling admin, seniorId=self).
const PROJECTS = [{ id: 'proj-admin-1', name: 'Admin Project', seniorId: 'admin-1' }]

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/users')) return Promise.resolve({ data: ADMIN_USERS })
      if (url.startsWith('/projects')) return Promise.resolve({ data: PROJECTS })
      return Promise.resolve({ data: [] })
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const createAdminIncomeMock = vi.fn().mockResolvedValue({})
const createExpenseMock = vi.fn().mockResolvedValue({})
const createAdminTransferMock = vi.fn().mockResolvedValue({})
const createDividendMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    createAdminIncome: (...args: unknown[]) => createAdminIncomeMock(...args),
    createExpense: (...args: unknown[]) => createExpenseMock(...args),
    createAdminTransfer: (...args: unknown[]) => createAdminTransferMock(...args),
    createSeniorIncome: vi.fn().mockResolvedValue({}),
    createDropIncome: vi.fn().mockResolvedValue({}),
    createSalary: vi.fn().mockResolvedValue({}),
    declareUsdtProjectIncome: vi.fn().mockResolvedValue({}),
  },
  companyAccountApi: {
    getAccount: vi.fn().mockResolvedValue({ balance: 9999 }),
    createDividend: (...args: unknown[]) => createDividendMock(...args),
  },
}))

import { CreateTransactionDialog } from '../CreateTransactionDialog'

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CreateTransactionDialog open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

function clickTypeCard(testId: string) {
  fireEvent.click(screen.getByTestId(testId))
}

describe('CreateTransactionDialog — ADMIN_INCOME mandatory receipt (legacy funding)', () => {
  beforeEach(() => {
    createAdminIncomeMock.mockClear()
  })

  it('blocks submit without a receipt', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-receipt')).toBeInTheDocument()
    expect(createAdminIncomeMock).not.toHaveBeenCalled()
  })

  // task-admin-income-unified (§2): ADMIN now ALWAYS picks an explicit
  // receiver — the flat "Счёт получателя" Select replaces the old implicit
  // "always credits self" default.
  it('submits with a plain url receipt (non-explorer, currency=USD default)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('Admin Project'))
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByText('Admin One'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = createAdminIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({
      receiptExternalUrl: 'https://example.com/receipt.png',
      receiverId: 'admin-1',
    })
  })
})

// task-admin-income-unified (§2): the old `create-transaction-funding-company`
// button is gone for ADMIN (moved into the flat receiver Select — picking
// «Счёт компании» there is the new equivalent). Still explorer-only/USDT-locked.
describe('CreateTransactionDialog — ADMIN_INCOME + «Счёт компании» (explorer-only)', () => {
  beforeEach(() => {
    createAdminIncomeMock.mockClear()
  })

  it('locking currency to USDT via «Счёт компании» hides the tab-toggle (explorer-only)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    expect(screen.queryByTestId('receipt-input-mode-file')).not.toBeInTheDocument()
    expect(screen.getByTestId('receipt-input-explorer-hint')).toBeInTheDocument()
  })

  it('rejects a non-explorer url client-side when «Счёт компании» is selected', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('Admin Project'))
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/not-an-explorer.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-receipt')).toBeInTheDocument()
    expect(createAdminIncomeMock).not.toHaveBeenCalled()
  })

  it('submits when an explorer url is provided', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_income')
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByText('Admin Project'))
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://tronscan.org/#/transaction/0xabc' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminIncomeMock).toHaveBeenCalledTimes(1))
    const [payload] = createAdminIncomeMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({
      currency: 'USDT',
      receiptExternalUrl: 'https://tronscan.org/#/transaction/0xabc',
      receiverId: 'COMPANY_ACCOUNT',
    })
  })
})

describe('CreateTransactionDialog — EXPENSE mandatory receipt', () => {
  beforeEach(() => {
    createExpenseMock.mockClear()
  })

  it('blocks submit without a receipt', async () => {
    renderDialog()
    clickTypeCard('create-transaction-type-expense')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '120' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-receipt')).toBeInTheDocument()
    expect(createExpenseMock).not.toHaveBeenCalled()
  })

  it('submits with a receipt', async () => {
    renderDialog()
    clickTypeCard('create-transaction-type-expense')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '120' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/expense.pdf' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createExpenseMock).toHaveBeenCalledTimes(1))
  })
})

describe('CreateTransactionDialog — ADMIN_TRANSFER mandatory receipt', () => {
  beforeEach(() => {
    createAdminTransferMock.mockClear()
  })

  it('blocks submit without a receipt', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_transfer')
    clickTypeCard('create-transaction-type-admin_transfer')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '300' } })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-receipt')).toBeInTheDocument()
    expect(createAdminTransferMock).not.toHaveBeenCalled()
  })

  it('submits with a receipt (default currency USD → non-explorer)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-admin_transfer')
    clickTypeCard('create-transaction-type-admin_transfer')
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '300' } })
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/transfer.png' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createAdminTransferMock).toHaveBeenCalledTimes(1))
  })
})

describe('CreateTransactionDialog — DIVIDEND mandatory + ALWAYS explorer-only', () => {
  beforeEach(() => {
    createDividendMock.mockClear()
  })

  it('never renders the tab-toggle (implicit USDT, no currency selector)', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-dividend')
    clickTypeCard('create-transaction-type-dividend')
    expect(screen.queryByTestId('receipt-input-mode-file')).not.toBeInTheDocument()
    expect(screen.getByTestId('receipt-input-explorer-hint')).toBeInTheDocument()
  })

  it('blocks submit without a receipt', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-dividend')
    clickTypeCard('create-transaction-type-dividend')
    fireEvent.change(screen.getByTestId('create-transaction-dividend-amount'), {
      target: { value: '200' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-receipt')).toBeInTheDocument()
    expect(createDividendMock).not.toHaveBeenCalled()
  })

  it('submits with an explorer url receipt', async () => {
    renderDialog()
    await screen.findByTestId('create-transaction-type-dividend')
    clickTypeCard('create-transaction-type-dividend')
    fireEvent.change(screen.getByTestId('create-transaction-dividend-amount'), {
      target: { value: '200' },
    })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xdividend' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    await waitFor(() => expect(createDividendMock).toHaveBeenCalledTimes(1))
    const [payload] = createDividendMock.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ receiptExternalUrl: 'https://etherscan.io/tx/0xdividend' })
  })
})
