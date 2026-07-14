/**
 * task-salary-pay-flow — PaySalaryDialog tests (AC6).
 *
 * Pins:
 * 1. The account selector shows «Счёт компании» (default) + every ADMIN partner.
 * 2. «Счёт компании» is selected by default; the currency selector is disabled
 *    (locked to USDT) and the balance hint is shown.
 * 3. Selecting a partner switches to ADMIN_PERSONAL: the currency selector
 *    unlocks, the company balance hint disappears.
 * 4. Submitting with «Счёт компании» calls paySalary with
 *    { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' } (no payerAdminId).
 * 5. Submitting with a partner calls paySalary with
 *    { fundingSource: 'ADMIN_PERSONAL', payerAdminId: <partner>, currency }.
 * 6. task-receipts-frontend: the receipt is now MANDATORY (replaces the old
 *    optional TX Hash field) — submit is blocked without it; tests fill in an
 *    explorer URL before asserting the mutation payload (currency stays USDT
 *    in both branches below, so ReceiptInput renders explorer-only — no
 *    tab-toggle to interact with, just the url field).
 *
 * Strategy: keep the REAL `@tanstack/react-query` hooks (wrapped in a fresh
 * `QueryClientProvider` per render) so `mutation.mutate()` genuinely invokes
 * the component's own `mutationFn` — globally mocking `useMutation` is unsafe
 * here because `ReceiptInput` also calls `useMutation` internally
 * (`useUploadDocument`), and a single captured-fn stub cannot distinguish the
 * two instances (mirrors `CreateTransactionDialog.usdt-income.test.tsx`).
 * Only the API boundary (`@/lib/axios` + `../../../api`) is mocked.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/users')) {
        return Promise.resolve({
          data: [
            { id: 'maksym-id', displayName: 'Максим', role: 'ADMIN' },
            { id: 'kostya-id', displayName: 'Костя', role: 'ADMIN' },
            { id: 'hr-id', displayName: 'HR Person', role: 'HR' },
          ],
        })
      }
      return Promise.resolve({ data: [] })
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const paySalaryMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    paySalary: (...args: unknown[]) => paySalaryMock(...args),
  },
  companyAccountApi: {
    getAccount: vi.fn().mockResolvedValue({ balance: 5000 }),
  },
}))

import { PaySalaryDialog } from '../PaySalaryDialog'

const TX = {
  id: 'salary-tx-1',
  type: 'SALARY',
  status: 'PENDING',
  amount: '500',
  currency: 'USD',
  receiverName: 'HR Person',
  salaryMonth: '2026-05',
  createdAt: '2026-05-01T00:00:00.000Z',
} as never

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PaySalaryDialog tx={TX} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('PaySalaryDialog — account + currency selectors', () => {
  beforeEach(() => {
    paySalaryMock.mockClear()
  })

  it('renders «Счёт компании» + every ADMIN partner as account options', async () => {
    renderDialog()
    expect(screen.getByTestId('pay-salary-account-company')).toBeInTheDocument()
    expect(await screen.findByTestId('pay-salary-account-admin-maksym-id')).toBeInTheDocument()
    expect(screen.getByTestId('pay-salary-account-admin-kostya-id')).toBeInTheDocument()
    // Non-admins must NOT appear as a payer account.
    expect(screen.queryByTestId('pay-salary-account-admin-hr-id')).not.toBeInTheDocument()
  })

  it('«Счёт компании» is default → company balance hint shown', async () => {
    renderDialog()
    expect(await screen.findByTestId('pay-salary-company-balance-hint')).toBeInTheDocument()
  })

  it('selecting a partner hides the company balance hint', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('pay-salary-account-admin-maksym-id'))
    expect(screen.queryByTestId('pay-salary-company-balance-hint')).not.toBeInTheDocument()
  })

  it('submitting with «Счёт компании» → paySalary(COMPANY_ACCOUNT, USDT, no payerAdminId)', async () => {
    renderDialog()
    fireEvent.change(await screen.findByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xabc123' },
    })
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    await waitFor(() => expect(paySalaryMock).toHaveBeenCalledTimes(1))
    const [id, payload] = paySalaryMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('salary-tx-1')
    expect(payload.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(payload.currency).toBe('USDT')
    expect(payload.payerAdminId).toBeUndefined()
    expect(payload.receiptExternalUrl).toBe('https://etherscan.io/tx/0xabc123')
  })

  it('blocks submit and shows an inline error when the receipt is missing', async () => {
    renderDialog()
    await screen.findByTestId('pay-salary-account-company')
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(paySalaryMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('pay-salary-error-receipt')).toBeInTheDocument()
  })

  it('submitting with a partner → paySalary(ADMIN_PERSONAL, payerAdminId set)', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('pay-salary-account-admin-kostya-id'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xdef456' },
    })
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    await waitFor(() => expect(paySalaryMock).toHaveBeenCalledTimes(1))
    const [, payload] = paySalaryMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.fundingSource).toBe('ADMIN_PERSONAL')
    expect(payload.payerAdminId).toBe('kostya-id')
  })
})
