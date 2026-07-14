/**
 * task-senior-settle-owner — SettleSeniorPayoutDialog tests.
 *
 * Pins that paying a senior IOU now mirrors the SALARY pay flow (shared
 * FundingSourceFields):
 * 1. The account selector shows «Счёт компании» (default) + every ADMIN partner.
 * 2. «Счёт компании» is the default → company balance hint shown.
 * 3. Selecting a partner switches to ADMIN_PERSONAL → the company balance hint
 *    disappears (the company account is not touched).
 * 4. Submitting with «Счёт компании» calls settleSeniorPayoutFromTransaction with
 *    { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' } (no payerAdminId).
 * 5. Submitting with a partner calls it with
 *    { fundingSource: 'ADMIN_PERSONAL', payerAdminId: <partner>, currency }.
 * 6. fix/usdt-receiver-flat-select: the currency Select is narrowed to
 *    USDT/USD only (EUR/UAH options are NOT rendered) — the backend rejects
 *    closing a USDT obligation in EUR/UAH without conversion. PaySalaryDialog
 *    is unaffected — it still offers all 4 currencies (own test file).
 * 7. task-receipts-frontend: the receipt is now MANDATORY (this dialog had NO
 *    receipt/hash field before) — submit is blocked without it; tests fill in
 *    an explorer URL first (currency stays USDT throughout, so ReceiptInput
 *    renders explorer-only — no tab-toggle to interact with).
 *
 * Strategy: keep the REAL `@tanstack/react-query` hooks (wrapped in a fresh
 * `QueryClientProvider` per render) so `mutation.mutate()` genuinely invokes
 * the component's own `mutationFn` — globally mocking `useMutation` is unsafe
 * here because `ReceiptInput` also calls `useMutation` internally
 * (`useUploadDocument`), and a single captured-fn stub cannot distinguish the
 * two instances (mirrors `CreateTransactionDialog.usdt-income.test.tsx` /
 * `PaySalaryDialog.test.tsx`). Only the API boundary is mocked.
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

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const settleMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    settleSeniorPayoutFromTransaction: (...args: unknown[]) => settleMock(...args),
  },
  companyAccountApi: {
    getAccount: vi.fn().mockResolvedValue({ balance: 5000 }),
  },
}))

import { toast } from 'sonner'
import { SettleSeniorPayoutDialog } from '../SettleSeniorPayoutDialog'

const TX = {
  id: 'senior-pending-1',
  type: 'SENIOR_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '560',
  currency: 'USDT',
  receiverName: 'Senior Person',
  projectName: 'Drop Project',
  createdAt: '2026-06-01T00:00:00.000Z',
} as never

// settle-drop-btn: SAME shape as TX above, only type flips to DROP_PENDING_PAYOUT
// (mirrors the company-IOU-to-a-drop row). Used to pin that the dialog is
// REUSED as-is for the drop mirror — only the recipient-facing copy adapts.
const DROP_TX = {
  id: 'drop-pending-1',
  type: 'DROP_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '420',
  currency: 'USDT',
  receiverName: 'Drop Person',
  projectName: 'USDT Project',
  createdAt: '2026-06-01T00:00:00.000Z',
} as never

function renderDialog(tx: unknown = TX) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SettleSeniorPayoutDialog tx={tx as never} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

// task-receipts-frontend: fills the (explorer-only, since currency stays
// USDT in every test below) receipt url field so submit isn't blocked.
async function fillReceipt(url = 'https://etherscan.io/tx/0xabc123') {
  fireEvent.change(await screen.findByTestId('receipt-input-url-field'), { target: { value: url } })
}

describe('SettleSeniorPayoutDialog — account + currency selectors (salary-style)', () => {
  beforeEach(() => {
    settleMock.mockClear()
  })

  it('renders «Счёт компании» + every ADMIN partner as account options', async () => {
    renderDialog()
    expect(screen.getByTestId('settle-senior-account-company')).toBeInTheDocument()
    expect(await screen.findByTestId('settle-senior-account-admin-maksym-id')).toBeInTheDocument()
    expect(screen.getByTestId('settle-senior-account-admin-kostya-id')).toBeInTheDocument()
    // Non-admins must NOT appear as a payer account.
    expect(screen.queryByTestId('settle-senior-account-admin-hr-id')).not.toBeInTheDocument()
  })

  it('«Счёт компании» is default → company balance hint shown', async () => {
    renderDialog()
    expect(await screen.findByTestId('settle-senior-company-balance-hint')).toBeInTheDocument()
  })

  it('selecting a partner hides the company balance hint', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    expect(screen.queryByTestId('settle-senior-company-balance-hint')).not.toBeInTheDocument()
  })

  it('submitting with «Счёт компании» → settle(COMPANY_ACCOUNT, USDT, no payerAdminId)', async () => {
    renderDialog()
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [id, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('senior-pending-1')
    expect(payload.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(payload.currency).toBe('USDT')
    expect(payload.payerAdminId).toBeUndefined()
    expect(payload.receiptExternalUrl).toBe('https://etherscan.io/tx/0xabc123')
  })

  it('blocks submit and shows an inline error when the receipt is missing', async () => {
    renderDialog()
    await screen.findByTestId('settle-senior-account-company')
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    expect(settleMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('settle-senior-error-receipt')).toBeInTheDocument()
  })

  it('submitting with a partner → settle(ADMIN_PERSONAL, payerAdminId set)', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-kostya-id'))
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.fundingSource).toBe('ADMIN_PERSONAL')
    expect(payload.payerAdminId).toBe('kostya-id')
  })

  it('currency Select offers only USDT/USD — no EUR/UAH (backend contract)', async () => {
    renderDialog()
    // Switch to a partner so the currency Select is enabled/interactable, then
    // open the dropdown (Radix only mounts SelectContent while open).
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    fireEvent.click(screen.getByTestId('settle-senior-currency-trigger'))
    expect(screen.getByTestId('settle-senior-currency-USDT')).toBeInTheDocument()
    expect(screen.getByTestId('settle-senior-currency-USD')).toBeInTheDocument()
    expect(screen.queryByTestId('settle-senior-currency-EUR')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settle-senior-currency-UAH')).not.toBeInTheDocument()
  })
})

// settle-drop-btn: pins that the dialog is REUSED as-is for DROP_PENDING_PAYOUT
// rows — same funding picker + same generic settle-company mutation as the
// senior branch above, only the recipient-facing copy (title / toast) adapts.
describe('SettleSeniorPayoutDialog — reused for DROP_PENDING_PAYOUT (settle-drop-btn mirror)', () => {
  beforeEach(() => {
    settleMock.mockClear()
    vi.mocked(toast.success).mockClear()
  })

  it('shows «Выплатить синьору» title for a SENIOR_PENDING_PAYOUT tx', () => {
    renderDialog(TX)
    expect(screen.getByText('Выплатить синьору')).toBeInTheDocument()
  })

  it('shows «Выплатить дропу» title for a DROP_PENDING_PAYOUT tx', () => {
    renderDialog(DROP_TX)
    expect(screen.getByText('Выплатить дропу')).toBeInTheDocument()
    expect(screen.queryByText('Выплатить синьору')).not.toBeInTheDocument()
  })

  it('still surfaces the recipient name (drop) via the shared «Получатель» row', () => {
    renderDialog(DROP_TX)
    expect(screen.getByText('Drop Person')).toBeInTheDocument()
  })

  it('submitting a DROP_PENDING_PAYOUT settle still calls the SAME generic endpoint', async () => {
    renderDialog(DROP_TX)
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [id, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('drop-pending-1')
    expect(payload.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(payload.currency).toBe('USDT')
  })

  it('submitting a DROP settle shows the drop-specific success toast', async () => {
    renderDialog(DROP_TX)
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Выплата дропу проведена'))
  })

  it('submitting a SENIOR settle still shows the original success toast', async () => {
    renderDialog(TX)
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Выплата синьору проведена'))
  })
})
