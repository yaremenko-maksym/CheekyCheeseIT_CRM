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
 *    { fundingSource: 'COMPANY_ACCOUNT' } (no payerAdminId, no currency).
 * 5. Submitting with a partner calls it with
 *    { fundingSource: 'ADMIN_PERSONAL', payerAdminId: <partner> } (no currency).
 * 6. task-remove-settle-currency: the currency Select is NOT rendered at all —
 *    a settle obligation is always denominated in USDT, so there is nothing to
 *    pick (see pending-settlement.service.ts). PaySalaryDialog is unaffected —
 *    it still offers a currency Select (own test file).
 * 7. task-receipts-frontend: the receipt is now MANDATORY (this dialog had NO
 *    receipt/hash field before) — submit is blocked without it; tests fill in
 *    an explorer URL first (settle is always effectively USDT, so ReceiptInput
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
// (mirrors the company-IOU-to-a-drop row). `payoutRequestId` is absent (like
// an admin-USDT-declaration-booked drop IOU) — used to pin that the dialog is
// REUSED as-is for the drop mirror — only the recipient-facing copy adapts,
// and the HIGH-1 gate below does NOT engage for this shape.
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

// security-review PR #443 (HIGH-1): SAME shape as DROP_TX, but with
// `payoutRequestId` set — the deterministic marker of a CASCADE-originated
// drop obligation (task-drop-share-pending-parity), whose share never landed
// on the shared company account. This is the shape that must disable/block
// «Счёт компании».
const CASCADE_DROP_TX = {
  id: 'cascade-drop-pending-1',
  type: 'DROP_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '50',
  currency: 'USDT',
  receiverName: 'Cascade Drop Person',
  projectName: 'Drop Project',
  payoutRequestId: 'payout-req-1',
  createdAt: '2026-07-27T00:00:00.000Z',
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

  it('submitting with «Счёт компании» → settle(COMPANY_ACCOUNT, no payerAdminId, no currency)', async () => {
    renderDialog()
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [id, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('senior-pending-1')
    expect(payload.fundingSource).toBe('COMPANY_ACCOUNT')
    // task-remove-settle-currency: the payload never carries a currency field —
    // the backend defaults it to the obligation's own currency (USDT).
    expect(payload.currency).toBeUndefined()
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

  it('submitting with a partner → settle(ADMIN_PERSONAL, payerAdminId set, no currency)', async () => {
    renderDialog()
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-kostya-id'))
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.fundingSource).toBe('ADMIN_PERSONAL')
    expect(payload.payerAdminId).toBe('kostya-id')
    expect(payload.currency).toBeUndefined()
  })

  // task-remove-settle-currency: the currency Select is gone entirely — a
  // settle obligation is always denominated in USDT, so there is nothing to
  // pick. Checked both for «Счёт компании» (default) and for an ADMIN partner
  // (previously the only branch where the Select was enabled/interactable).
  it('does not render a currency Select at all', async () => {
    renderDialog()
    await screen.findByTestId('settle-senior-account-company')
    expect(screen.queryByTestId('settle-senior-currency-trigger')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    expect(screen.queryByTestId('settle-senior-currency-trigger')).not.toBeInTheDocument()
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
    expect(payload.currency).toBeUndefined()
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

// security-review PR #443 (HIGH-1): a cascade-originated drop obligation
// (payoutRequestId != null) must never settle from «Счёт компании» — that
// money never landed on the shared company pool. Pins the UI mirror of the
// server-side settleByCompany guard (pending-settlement.service.ts).
describe('SettleSeniorPayoutDialog — HIGH-1 guard: cascade-originated drop obligation', () => {
  beforeEach(() => {
    settleMock.mockClear()
  })

  it('disables «Счёт компании» and shows the reason for a cascade drop obligation', async () => {
    renderDialog(CASCADE_DROP_TX)
    const companyBtn = await screen.findByTestId('settle-senior-account-company')
    expect(companyBtn).toBeDisabled()
    expect(screen.getByTestId('settle-senior-company-disabled-reason')).toHaveTextContent(
      /доля дропа из этой выплаты не проходила через счёт компании/i,
    )
  })

  it('does NOT disable «Счёт компании» for a non-cascade drop obligation (admin-USDT origin)', async () => {
    renderDialog(DROP_TX)
    const companyBtn = await screen.findByTestId('settle-senior-account-company')
    expect(companyBtn).not.toBeDisabled()
  })

  it('does not default to «Счёт компании» for a cascade drop obligation — no company balance hint on open', async () => {
    renderDialog(CASCADE_DROP_TX)
    await screen.findByTestId('settle-senior-account-company')
    expect(screen.queryByTestId('settle-senior-company-balance-hint')).not.toBeInTheDocument()
  })

  it('blocks submit with an inline error while no admin partner is picked yet (even with a valid receipt)', async () => {
    renderDialog(CASCADE_DROP_TX)
    await screen.findByTestId('settle-senior-account-company')
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    expect(settleMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('settle-senior-error-account')).toBeInTheDocument()
  })

  it('clicking the disabled «Счёт компании» button does nothing — still blocked on submit', async () => {
    renderDialog(CASCADE_DROP_TX)
    const companyBtn = await screen.findByTestId('settle-senior-account-company')
    fireEvent.click(companyBtn)
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    expect(settleMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('settle-senior-error-account')).toBeInTheDocument()
  })

  it('selecting an admin partner clears the block and settles ADMIN_PERSONAL', async () => {
    renderDialog(CASCADE_DROP_TX)
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [id, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('cascade-drop-pending-1')
    expect(payload.fundingSource).toBe('ADMIN_PERSONAL')
    expect(payload.payerAdminId).toBe('maksym-id')
    expect(screen.queryByTestId('settle-senior-error-account')).not.toBeInTheDocument()
  })
})
