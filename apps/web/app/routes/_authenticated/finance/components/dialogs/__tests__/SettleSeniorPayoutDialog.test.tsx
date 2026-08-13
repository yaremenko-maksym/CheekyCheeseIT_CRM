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
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// task-drop-payout-currency: fixed NBU-rate fixture — both the dialog itself
// (expectedAmount) and the inner AmountCurrencyInput fetch this same
// endpoint/cache-key, so a single mock covers both call sites.
const FAKE_RATES = { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '20260801' }
// Toggled by ONE test (rates-unavailable) to prove the amount field falls
// back to an EMPTY string, never a placeholder, when the NBU rate can't be
// loaded for a genuine cross-currency conversion. Reset in that test's own
// cleanup so it never leaks into the rest of the suite.
let exchangeRateShouldFail = false
// owner addendum (2026-08): toggled by ONE test to prove a graceful, DATED
// fallback (`rateDate` differs from the requested date) surfaces a note to
// the operator. `null` (default) → every OTHER test's plain FAKE_RATES
// response, unaffected. Reset in that test's own cleanup.
let rateDateOverride: string | null = null

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
      if (url.startsWith('/finance/exchange-rate')) {
        if (exchangeRateShouldFail) return Promise.reject(new Error('rates unavailable'))
        if (rateDateOverride && url.includes('?date='))
          return Promise.resolve({ data: { ...FAKE_RATES, rateDate: rateDateOverride } })
        return Promise.resolve({ data: FAKE_RATES })
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
import { api } from '@/lib/axios'
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
// (mirrors the company-IOU-to-a-drop row). `dropCascadeOrigin: false` (like
// an admin-USDT-declaration-booked drop IOU, post HIGH-1-round-4 backfill) —
// used to pin that the dialog is REUSED as-is for the drop mirror — only the
// recipient-facing copy adapts, and the HIGH-1 gate below does NOT engage
// for this shape.
const DROP_TX = {
  id: 'drop-pending-1',
  type: 'DROP_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '420',
  currency: 'USDT',
  receiverName: 'Drop Person',
  projectName: 'USDT Project',
  dropCascadeOrigin: false,
  createdAt: '2026-06-01T00:00:00.000Z',
} as never

// security-review PR #443 (HIGH-1 / MED-1 round 4): SAME shape as DROP_TX,
// but with `dropCascadeOrigin: true` — the marker `settleByCompany`
// authoritatively reads (NOT `payoutRequestId`, kept here too since a real
// cascade row carries both) — whose share never landed on the shared company
// account. This is the shape that must disable/block «Счёт компании».
const CASCADE_DROP_TX = {
  id: 'cascade-drop-pending-1',
  type: 'DROP_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '50',
  currency: 'USDT',
  receiverName: 'Cascade Drop Person',
  projectName: 'Drop Project',
  payoutRequestId: 'payout-req-1',
  dropCascadeOrigin: true,
  createdAt: '2026-07-27T00:00:00.000Z',
} as never

// MED-1 (round 4): a row with an UNSTAMPED marker (null — e.g. a legacy row
// older than the drop_cascade_origin column, before the HIGH-1 data
// backfill runs). The UI must treat this the SAME as a verified-cascade row
// (fail-safe) — mirrors the server's `!== false` polarity, not a truthy
// check (`null &&` would be falsy and wrongly ALLOW).
const UNSTAMPED_DROP_TX = {
  id: 'unstamped-drop-pending-1',
  type: 'DROP_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '75',
  currency: 'USDT',
  receiverName: 'Unstamped Drop Person',
  projectName: 'Drop Project',
  dropCascadeOrigin: null,
  createdAt: '2026-07-28T00:00:00.000Z',
} as never

// task-drop-payout-currency: a DROP obligation denominated in UAH — lets a
// cross-currency conversion be exercised WITHOUT driving the (Radix, not
// reliably driveable in happy-dom — see PaySalaryDialog.paid-amount.test.tsx)
// currency Select: picking «Счёт компании» (a plain button) forces
// effectiveCurrency=USDT, which is already a REAL conversion away from this
// obligation's own UAH. 4150 UAH / 41.50 = exactly 100 USDT (FAKE_RATES).
const UAH_DROP_TX = {
  id: 'uah-drop-pending-1',
  type: 'DROP_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '4150',
  currency: 'UAH',
  receiverName: 'UAH Drop Person',
  projectName: 'Drop Project',
  dropCascadeOrigin: false,
  createdAt: '2026-08-01T00:00:00.000Z',
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

  // task-remove-settle-currency: a SENIOR settle still has no amount/currency
  // field at all — a senior obligation is always denominated in USDT, so
  // there is nothing to pick. Checked both for «Счёт компании» (default) and
  // for an ADMIN partner. task-drop-payout-currency: a DROP settle is
  // different — see the next describe block.
  it('SENIOR: does not render an amount/currency field at all', async () => {
    renderDialog(TX)
    await screen.findByTestId('settle-senior-account-company')
    expect(screen.queryByTestId('settle-senior-amount-field')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    expect(screen.queryByTestId('settle-senior-amount-field')).not.toBeInTheDocument()
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
    // task-drop-payout-currency: a DROP settle now DOES send `currency` — the
    // default is the obligation's own currency (USDT here), same as the
    // «Счёт компании» force. Unlike a SENIOR settle (still omitted below).
    expect(payload.currency).toBe('USDT')
  })

  it('submitting a DROP settle shows the drop-specific success toast', async () => {
    renderDialog(DROP_TX)
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Выплата дропу проведена'))
  })

  // security-review PR #521 round 3 (LOW-2): when the response DOES carry
  // the flipped row (the real API shape — `settleMock` in the OTHER tests
  // above only stubs `{}`, which never exercises this branch at all), the
  // toast shows the ACTUALLY RECORDED amount, not just a generic "done".
  it('submitting a DROP settle shows the ACTUAL recorded amount in the success toast, when the response carries it', async () => {
    renderDialog(DROP_TX)
    settleMock.mockResolvedValueOnce({
      obligation: { status: 'PAID' },
      created: [{ amount: '420', currency: 'USDT' }],
    })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('Выплата дропу проведена:'),
      ),
    )
    const [message] = vi.mocked(toast.success).mock.calls[0] as [string]
    expect(message).toContain('420')
    expect(message).toContain('USDT')
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

  // MED-1 (round 4): `dropCascadeOrigin: null` (unstamped) must be treated
  // the SAME as a verified-cascade row — `!== false`, not a truthy check.
  it('treats an UNSTAMPED marker (dropCascadeOrigin=null) the same as a cascade obligation — disables «Счёт компании», blocks submit', async () => {
    renderDialog(UNSTAMPED_DROP_TX)
    const companyBtn = await screen.findByTestId('settle-senior-account-company')
    expect(companyBtn).toBeDisabled()

    await fillReceipt()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    expect(settleMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('settle-senior-error-account')).toBeInTheDocument()
  })
})

// task-drop-payout-currency — «Выплатить дропу» can now be settled in any of
// the four currencies (USDT/USD/UAH/EUR); the amount field stays fully
// disabled (owner decision — it only shows the server-recalculated figure).
// The currency Select is Radix (not reliably driveable in happy-dom — see
// PaySalaryDialog.paid-amount.test.tsx) — cross-currency behaviour is
// exercised the SAME way that spec establishes: via the obligation's OWN
// currency + the «Счёт компании» (plain button) USDT-force, never a
// simulated Select click.
describe('SettleSeniorPayoutDialog — drop payout currency (task-drop-payout-currency)', () => {
  beforeEach(() => {
    settleMock.mockClear()
    // Two tests below assert on api.get's OWN call history (call count /
    // which URLs) — must start from a clean slate, not accumulate calls
    // from earlier describe blocks in this file.
    vi.mocked(api.get).mockClear()
  })

  async function fillReceiptViaUrlTab(url = 'https://drive.google.com/file/uahdrop') {
    fireEvent.click(await screen.findByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), { target: { value: url } })
  }

  // AC1: the amount field exists ONLY for a DROP settle, is disabled, and the
  // currency it sits next to is a real, enabled choice (once a personal
  // account is picked — «Счёт компании» locks it to USDT, same as
  // PaySalaryDialog's `disableCurrency={isCompany}`).
  it('AC1: amount input is disabled; currency selector is enabled once a personal account is chosen', async () => {
    renderDialog(DROP_TX)
    const amountField = await screen.findByTestId('settle-senior-amount-field')
    expect(within(amountField).getByTestId('amount-currency-amount-input')).toBeDisabled()
    // Default: «Счёт компании» → currency forced/locked (disableCurrency).
    expect(within(amountField).getByRole('combobox')).toBeDisabled()

    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    // Amount stays disabled regardless of the funding source …
    expect(within(amountField).getByTestId('amount-currency-amount-input')).toBeDisabled()
    // … but the currency Select is now interactable.
    expect(within(amountField).getByRole('combobox')).not.toBeDisabled()
  })

  // AC1: a SENIOR settle never renders this field at all (unaffected).
  it('AC1: SENIOR settle renders no amount/currency field', () => {
    renderDialog(TX)
    expect(screen.queryByTestId('settle-senior-amount-field')).not.toBeInTheDocument()
  })

  // AC2 (default — no recalculation): the obligation's own currency shows the
  // obligation amount verbatim, no NBU round-trip needed.
  it('AC2: defaults to the obligation currency — shown amount equals the obligation, unconverted', async () => {
    renderDialog(DROP_TX)
    const amountField = await screen.findByTestId('settle-senior-amount-field')
    // DROP_TX: amount 420, currency USDT — «Счёт компании» is also USDT, so
    // this is the no-conversion path from BOTH angles at once.
    expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue('420.00')
  })

  // AC2 (recalculation happens): switching OFF «Счёт компании» for a
  // non-USDT obligation stops forcing USDT — the shown amount reverts to the
  // obligation's own currency/figure (UAH here), proving the field really
  // recomputes with the funding/currency context instead of a frozen value.
  it('AC2: switching account changes the effective currency and recalculates the shown amount', async () => {
    renderDialog(UAH_DROP_TX)
    const amountField = await screen.findByTestId('settle-senior-amount-field')
    // Default «Счёт компании» → forced USDT → 4150 UAH / 41.50 = 100 USDT.
    await waitFor(() =>
      expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue('100.00'),
    )

    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    // ADMIN_PERSONAL → currency reverts to the obligation's own (UAH) → the
    // obligation figure, unconverted.
    await waitFor(() =>
      expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue(
        '4150.00',
      ),
    )
  })

  // AC3 (backend cross-check lives in pending-settlement.drop-currency.spec.ts
  // and the real-DB integration spec) — the frontend half of that invariant:
  // whatever figure is SHOWN is exactly what gets SENT (no separate, silently
  // divergent amount channel — there is no amount field in the payload at
  // all, see AC5 below).
  it('AC3: the shown figure and the settle payload agree on currency (server derives the amount from it)', async () => {
    renderDialog(UAH_DROP_TX)
    const amountField = await screen.findByTestId('settle-senior-amount-field')
    await waitFor(() =>
      expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue('100.00'),
    )
    await fillReceipt('https://etherscan.io/tx/0xuahdrop')
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    // Company-funded → forced USDT, matching the shown 100.00 figure's currency.
    expect(payload.currency).toBe('USDT')
  })

  // AC4: `currency` is sent on EVERY drop settle — including the default,
  // same-currency case (DROP_TX, tested above in the "reused for
  // DROP_PENDING_PAYOUT" describe block) — never omitted the way a SENIOR
  // settle omits it.
  it('AC4/AC5: the payload carries exactly {fundingSource, currency, receipt*} — no amount, no rate, nothing else for the client to spoof', async () => {
    renderDialog(UAH_DROP_TX)
    await screen.findByTestId('settle-senior-amount-field')
    await fillReceipt('https://etherscan.io/tx/0xuahdrop2')
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    // owner addendum (2026-08): `txDate` joined the payload — the operator-
    // selected settle date (defaults to the obligation's own creation date;
    // see the date-picker tests below). Still no amount, no rate.
    expect(Object.keys(payload).sort()).toEqual(
      ['currency', 'fundingSource', 'receiptDocumentId', 'receiptExternalUrl', 'txDate'].sort(),
    )
    // No amount, no exchangeRate/rate field exists on the client at all — the
    // server computes both (pending-settlement.service.ts), never trusting
    // a client-supplied figure.
    expect(payload['amount']).toBeUndefined()
    expect(payload['exchangeRate']).toBeUndefined()
    expect(payload['rate']).toBeUndefined()
  })

  // owner addendum (2026-08): the date picker is DROP-only.
  it('date picker: does not render at all for a SENIOR settle', async () => {
    renderDialog(TX)
    await screen.findByTestId('settle-senior-account-company')
    expect(screen.queryByTestId('settle-senior-txdate')).not.toBeInTheDocument()
  })

  // owner addendum (2026-08): defaults to the obligation's own creation date
  // («по умолчанию — дата создания»), and that default is exactly what
  // lands in the settle payload untouched.
  it('date picker: for a DROP payout, defaults to the obligation creation date, and that default is what gets sent', async () => {
    renderDialog(UAH_DROP_TX) // DROP, createdAt = 2026-08-01
    const picker = await screen.findByTestId('settle-senior-txdate')
    expect(picker).toHaveTextContent('01 авг') // dd MMM (ru locale) of the default

    await fillReceipt('https://etherscan.io/tx/0xuahdrop3')
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload['txDate']).toBe('2026-08-01')
  })

  // Refined MED-2 (owner addendum): the operator sees which day's rate is
  // actually behind the preview WHEN it differs from the requested date —
  // surfaced next to the amount, before submit.
  it('shows a note when the applied rate came from a different date than requested (graceful fallback)', async () => {
    rateDateOverride = '20260731'
    renderDialog(UAH_DROP_TX) // requests 2026-08-01, gets data dated 2026-07-31
    await screen.findByTestId('settle-senior-amount-field')
    // The exact space before the applied date matters — a mutant that drops
    // it would concatenate "за" straight into "31.07.26" with no separator.
    expect(await screen.findByTestId('settle-senior-rate-date-note')).toHaveTextContent(
      'за 31.07.26',
    )
    rateDateOverride = null
  })

  it('does NOT show the note when rates.rateDate EQUALS the requested date (real, non-fallback rate)', async () => {
    // Distinct from "rateDateOverride = null" (every OTHER test's shape,
    // where rates.rateDate is entirely absent) — here it IS present but
    // matches the request exactly, the only scenario that actually
    // distinguishes `rateDateDiffers`'s own `!==` comparison from a mutant
    // that forces it (or its dates-differ operand) unconditionally true.
    rateDateOverride = '20260801' // UAH_DROP_TX's own default txDate
    renderDialog(UAH_DROP_TX)
    await screen.findByTestId('settle-senior-amount-field')
    expect(screen.queryByTestId('settle-senior-rate-date-note')).not.toBeInTheDocument()
    rateDateOverride = null
  })

  it('does NOT show the note at all for a normal rate response with no rateDate field (every non-fallback fixture in this suite)', async () => {
    renderDialog(UAH_DROP_TX)
    await screen.findByTestId('settle-senior-amount-field')
    expect(screen.queryByTestId('settle-senior-rate-date-note')).not.toBeInTheDocument()
  })

  // Receipt currency-awareness: a DROP settle in a non-USDT currency is NOT
  // explorer-only (mirrors PaySalaryDialog) — the owner can attach a bank
  // receipt file/url instead of an on-chain hash.
  it('receipt is explorer-only for USDT (default), but offers file/url once a non-USDT currency is in effect', async () => {
    renderDialog(UAH_DROP_TX)
    // Default: «Счёт компании» → USDT → explorer-only (no mode toggle).
    await screen.findByTestId('settle-senior-amount-field')
    expect(screen.queryByTestId('receipt-input-mode-file')).not.toBeInTheDocument()

    // ADMIN_PERSONAL → currency reverts to UAH (the obligation's own) → the
    // receipt is no longer explorer-only.
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    expect(await screen.findByTestId('receipt-input-mode-file')).toBeInTheDocument()
  })

  it('submits successfully in the obligation-own (UAH) currency via ADMIN_PERSONAL, with the receipt filled through the url tab', async () => {
    renderDialog(UAH_DROP_TX)
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    await fillReceiptViaUrlTab()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(settleMock).toHaveBeenCalledTimes(1))
    const [, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.fundingSource).toBe('ADMIN_PERSONAL')
    expect(payload.currency).toBe('UAH')
  })

  // Defensive: every hook in this component (useState/useEffect/useMemo/
  // useQuery) runs BEFORE the `if (!tx) return null` early return (Rules of
  // Hooks), so a tx===null render is NOT a no-op at the hook level — it is
  // the only render where `tx.currency`/`tx.amount`/`tx.id` accessed without
  // a null-guard would throw. Renders cleanly here; nothing crashes.
  it('renders nothing and does not throw when tx is null', () => {
    expect(() => renderDialog(null)).not.toThrow()
    expect(screen.queryByTestId('settle-senior-dialog')).not.toBeInTheDocument()
  })

  // AC1 corollary: the exchange-rate query is genuinely GATED on isDropPayout
  // — a SENIOR settle (which never shows the currency-conversion field) must
  // not fetch it at all.
  it('SENIOR settle never fetches /finance/exchange-rate', async () => {
    renderDialog(TX)
    await screen.findByTestId('settle-senior-account-company')
    const rateCalls = vi
      .mocked(api.get)
      .mock.calls.filter(([url]) => (url as string).startsWith('/finance/exchange-rate'))
    expect(rateCalls).toHaveLength(0)
  })

  // The dialog's own rate query and AmountCurrencyInput's internal one use
  // the IDENTICAL react-query key (calendar-day scoped) so TanStack Query
  // dedupes them into ONE network call, not two — pins the cache-sharing
  // comment above the `useQuery` call.
  //
  // DROP_TX (USDT, the default) is NOT a valid probe here: AmountCurrencyInput
  // gates its OWN internal query on `needsRate` (true only for EUR/UAH/USD),
  // so for USDT its query is disabled and there is only ever ONE fetch
  // regardless of whether the two queryKeys actually match — a wrong key on
  // the dialog's side would go undetected. UAH_DROP_TX via an ADMIN partner
  // (currency=UAH) makes BOTH queries genuinely active at once, which is the
  // only way a queryKey mismatch (→ two separate fetches) is observable.
  // owner addendum (2026-08): the dialog's own rate query is now DATE-scoped
  // (`?date=<selected date>`, defaulting to the obligation's creation date —
  // NOT today), while `AmountCurrencyInput`'s internal "≈ $X" hint always
  // fetches TODAY's rate (a separate, purely cosmetic secondary conversion —
  // see its own component). Once the selected date differs from today (the
  // common case — an obligation is rarely settled the same day it was
  // booked), the two queries genuinely no longer share a cache key, so this
  // is now 2 real fetches, not 1 — the OLD "shares ONE fetch" premise relied
  // on both sides hardcoding "today", which the date picker deliberately
  // breaks for the dialog's own (correctness-critical) query.
  it("DROP settle (non-USDT currency) fetches the dialog's own rate AT THE SELECTED DATE — separately from AmountCurrencyInput's today-only display hint", async () => {
    renderDialog(UAH_DROP_TX)
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    await waitFor(() =>
      expect(
        within(screen.getByTestId('settle-senior-amount-field')).getByTestId(
          'amount-currency-amount-input',
        ),
      ).toHaveValue('4150.00'),
    )
    const rateCalls = vi
      .mocked(api.get)
      .mock.calls.filter(([url]) => (url as string).startsWith('/finance/exchange-rate'))
      .map(([url]) => url as string)
    // The dialog's own query — scoped to the obligation's creation date
    // (UAH_DROP_TX.createdAt = 2026-08-01), the picker's default.
    expect(rateCalls).toContain('/finance/exchange-rate?date=20260801')
    // AmountCurrencyInput's own internal hint — no date param (today).
    expect(rateCalls).toContain('/finance/exchange-rate')
  })

  // The mount-sync effect is keyed on `tx?.id` so it re-runs when the SAME
  // mounted dialog instance is handed a DIFFERENT obligation (the parent
  // reuses one dialog component across rows) — proven via `rerender`, not a
  // fresh mount, so an EMPTY dependency array (which would only run once)
  // is genuinely distinguishable. Leaves «Счёт компании» BEFORE the rerender
  // (and stays off it) so `effectiveCurrency` reflects the STORED `currency`
  // state directly — with «Счёт компании» selected it would force USDT
  // regardless of whether the effect re-ran, masking the very thing under test
  // (the same pitfall the currency-reset test above works around).
  it('re-syncs the currency default when the SAME dialog instance receives a DIFFERENT tx (rerender, not remount)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <SettleSeniorPayoutDialog tx={DROP_TX as never} onClose={() => {}} />
      </QueryClientProvider>,
    )
    const amountField = await screen.findByTestId('settle-senior-amount-field')
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    await waitFor(() =>
      expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue('420.00'),
    )

    rerender(
      <QueryClientProvider client={qc}>
        <SettleSeniorPayoutDialog tx={UAH_DROP_TX as never} onClose={() => {}} />
      </QueryClientProvider>,
    )
    // «Счёт компании» was never re-selected — still ADMIN_PERSONAL, so
    // `effectiveCurrency` reads the STORED value directly. If the effect
    // re-ran (unmutated): currency → UAH_DROP_TX's own (UAH) → 4150.00,
    // unconverted. If it did NOT (mutant `[]`): currency stays the STALE
    // 'USDT' from the first tx → shows the USDT-CONVERTED figure, 100.00.
    await waitFor(() =>
      expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue(
        '4150.00',
      ),
    )
  })

  // owner addendum (2026-08): the SAME rerender pattern as above, but for
  // the date-of-record default AND its date-scoped rate query. Proves BOTH
  // that the mount-sync effect re-runs on a tx CHANGE (not just once — the
  // `[]`-deps mutant) and that the rate query is genuinely keyed per date
  // (not a static key that would silently keep serving the FIRST tx's
  // cached response for a SECOND, different date — the queryKey mutant).
  it('re-syncs the date-of-record default AND re-fetches at the NEW date when the SAME dialog instance receives a DIFFERENT tx (rerender, not remount)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <SettleSeniorPayoutDialog tx={DROP_TX as never} onClose={() => {}} />
      </QueryClientProvider>,
    )
    // DROP_TX.createdAt = 2026-06-01 — the picker's initial default.
    await waitFor(() =>
      expect(screen.getByTestId('settle-senior-txdate')).toHaveTextContent('01 июн'),
    )
    expect(
      vi.mocked(api.get).mock.calls.some(([url]) => (url as string).includes('date=20260601')),
    ).toBe(true)

    rerender(
      <QueryClientProvider client={qc}>
        <SettleSeniorPayoutDialog tx={UAH_DROP_TX as never} onClose={() => {}} />
      </QueryClientProvider>,
    )
    // UAH_DROP_TX.createdAt = 2026-08-01 — a genuinely DIFFERENT date. If the
    // mount-sync effect had empty deps (mutant), the picker would stay stuck
    // on June. If the query key were static (mutant), react-query would
    // never issue a NEW fetch for August at all.
    await waitFor(() =>
      expect(screen.getByTestId('settle-senior-txdate')).toHaveTextContent('01 авг'),
    )
    await waitFor(() =>
      expect(
        vi.mocked(api.get).mock.calls.some(([url]) => (url as string).includes('date=20260801')),
      ).toBe(true),
    )
  })

  // AC1 corollary: picking «Счёт компании» resets the STORED currency choice
  // back to the obligation's own — not just the DISPLAYED effective one.
  // Only observable by leaving company again afterwards: `effectiveCurrency`
  // forces USDT while `isCompany` is true regardless of the stored value, so
  // the reset is invisible until the NEXT switch away exposes what was
  // actually stored.
  it('picking «Счёт компании» resets the stored currency — a later switch back to a partner shows USDT, not a stale earlier pick', async () => {
    renderDialog(UAH_DROP_TX)
    const amountField = await screen.findByTestId('settle-senior-amount-field')
    // 1) Leave «Счёт компании» — stored currency is UAH (the obligation's own,
    //    set by the mount-sync effect, untouched by the company-force yet).
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-maksym-id'))
    await waitFor(() =>
      expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue(
        '4150.00',
      ),
    )
    // 2) Back to «Счёт компании» — forces USDT (display), and per
    //    selectAccount must ALSO reset the STORED currency to USDT.
    fireEvent.click(await screen.findByTestId('settle-senior-account-company'))
    await waitFor(() =>
      expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue('100.00'),
    )
    // 3) Leave again — the SELECT's own displayed text (not the amount:
    //    convertAmount's target='' fallback coincidentally still resolves to
    //    the SAME numeric figure as 'USDT', so the amount alone cannot tell
    //    a reset from a no-op here) is the only thing that actually exposes
    //    the STORED value: it must read literally "USDT" (the reset having
    //    happened in step 2), not blank/unmatched (a stale or cleared value).
    fireEvent.click(await screen.findByTestId('settle-senior-account-admin-kostya-id'))
    await waitFor(() => expect(within(amountField).getByRole('combobox')).toHaveTextContent('USDT'))
  })

  // AC2 corollary: when the rate genuinely cannot be loaded for a real
  // conversion, the field shows NOTHING (empty), never a placeholder string.
  it('shows an empty amount (not a placeholder) when the NBU rate cannot be loaded for a real cross-currency conversion', async () => {
    exchangeRateShouldFail = true
    try {
      renderDialog(UAH_DROP_TX)
      const amountField = await screen.findByTestId('settle-senior-amount-field')
      // Default «Счёт компании» forces USDT against a UAH obligation — a
      // GENUINE conversion that needs the (failing) rate.
      await waitFor(() =>
        expect(within(amountField).getByTestId('amount-currency-amount-input')).toHaveValue(''),
      )
    } finally {
      exchangeRateShouldFail = false
    }
  })
})
