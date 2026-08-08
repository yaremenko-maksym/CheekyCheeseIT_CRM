/**
 * task-salary-pay-amount — PaySalaryDialog: converted amount + custom paid sum.
 *
 * Pins (AC1 / AC2 / AC5):
 *   1. A salary owed in one currency and settled in another shows the amount
 *      DUE in the payment currency, derived from the NBU rate, and prefills the
 *      editable field with it.
 *   2. The field is editable and what the ADMIN typed is what gets sent as
 *      `paidAmount` — a manual figure is never overwritten by a later re-render
 *      (rates arriving, account switching).
 *   3. A deviation beyond the shared threshold WARNS but does NOT block: the
 *      mutation still fires with the entered amount. Both sides of the
 *      threshold are asserted, because a guard that always fires is as useless
 *      as one that never does.
 *   4. An unusable amount (zero / above the BIZ-13 ceiling) DOES block — that
 *      is validity, not plausibility.
 *
 * Strategy mirrors the sibling PaySalaryDialog.test.tsx: keep the REAL
 * react-query hooks, mock only the API boundary. The currency Select is Radix
 * (not driveable in this environment), so cross-currency cases are set up via
 * the transaction's own currency + the COMPANY_ACCOUNT default (USDT-forced)
 * rather than by clicking the picker.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const RATES = { usdUah: '41.50', usdtUah: '41.50', eurUah: '45.00', date: '20260805' }

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/users')) {
        return Promise.resolve({
          data: [{ id: 'maksym-id', displayName: 'Максим', role: 'ADMIN' }],
        })
      }
      if (url.includes('/finance/exchange-rate')) return Promise.resolve({ data: RATES })
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

/** Salary owed in UAH; the default funding source (company account) pays USDT. */
const TX_UAH = {
  id: 'salary-tx-uah',
  type: 'SALARY',
  status: 'PENDING',
  amount: '30000',
  currency: 'UAH',
  receiverName: 'HR Person',
  salaryMonth: '2026-08',
  createdAt: '2026-08-01T00:00:00.000Z',
} as never

/** Salary owed in USD — settled in USDT, which is a 1:1 relabel, not a conversion. */
const TX_USD = {
  ...(TX_UAH as object),
  id: 'salary-tx-usd',
  amount: '500',
  currency: 'USD',
} as never

// 30 000 UAH ÷ 41.50 = 722.891566… → the field is prefilled to 2 decimals.
const EXPECTED_USDT = '722.89'

function renderDialog(tx: unknown = TX_UAH) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PaySalaryDialog tx={tx as never} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

/**
 * The amount <input> inside the shared AmountCurrencyInput.
 *
 * Queried structurally rather than by role ON PURPOSE: the shared component's
 * input `type` is being changed number→text in PR #481 (mobile keyboards),
 * which flips its ARIA role spinbutton↔textbox. This dialog must not care —
 * it does not own that decision.
 */
function amountInput(): HTMLInputElement {
  const field = screen.getByTestId('pay-salary-amount-field')
  // `within(...)` rather than `field.querySelector('input')` (task-lint-teeth).
  // Both roles are tried so this keeps the role-agnosticism the comment above
  // asks for: type=number exposes `spinbutton`, type=text exposes `textbox`,
  // and this dialog must not care which PR #481 settles on.
  const input = within(field).queryByRole('spinbutton') ?? within(field).queryByRole('textbox')
  if (!input) throw new Error('amount input not found inside pay-salary-amount-field')
  return input as HTMLInputElement
}

async function fillReceipt() {
  fireEvent.change(await screen.findByTestId('receipt-input-url-field'), {
    target: { value: 'https://etherscan.io/tx/0xabc123' },
  })
}

async function lastPayload(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(paySalaryMock).toHaveBeenCalledTimes(1))
  const [, payload] = paySalaryMock.mock.calls[0] as [string, Record<string, unknown>]
  return payload
}

describe('PaySalaryDialog — converted amount (AC1)', () => {
  beforeEach(() => paySalaryMock.mockClear())

  it('shows the obligation in its own currency AND the amount due in the payment currency', async () => {
    renderDialog()
    // The obligation stays visible, untouched, in the currency it was created in.
    expect(await screen.findByTestId('pay-salary-obligation')).toHaveTextContent('30')
    expect(screen.getByTestId('pay-salary-obligation')).toHaveTextContent('UAH')

    // …and the converted figure due in USDT is spelled out.
    const expected = await screen.findByTestId('pay-salary-expected-amount')
    expect(expected).toHaveTextContent('722,89')
    expect(expected).toHaveTextContent('USDT')
  })

  it('prefills the editable amount with the rate-derived figure', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
  })

  it('shows the applied rate (delegated to the shared AmountCurrencyInput hint)', async () => {
    renderDialog()
    // The USDT peg line is what the shared input renders for a USDT payment —
    // proof the conversion hint is wired, not re-implemented here.
    expect(await screen.findByText('1 USDT = 1 USD')).toBeInTheDocument()
  })

  it('omits the conversion row when paying a USD obligation in USDT (1:1 relabel)', async () => {
    renderDialog(TX_USD)
    await waitFor(() => expect(amountInput().value).toBe('500.00'))
    expect(screen.queryByTestId('pay-salary-expected-amount')).not.toBeInTheDocument()
  })
})

describe('PaySalaryDialog — custom paid amount (AC2)', () => {
  beforeEach(() => paySalaryMock.mockClear())

  it('sends the prefilled amount as paidAmount when left untouched', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    const payload = await lastPayload()
    expect(payload.paidAmount).toBe(722.89)
    expect(payload.currency).toBe('USDT')
  })

  it('sends the ADMIN’s own figure, and never overwrites it afterwards', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))

    fireEvent.change(amountInput(), { target: { value: '700' } })
    // A re-render triggered by other state (receipt) must not restore the
    // suggestion over what the ADMIN typed.
    await fillReceipt()
    expect(amountInput().value).toBe('700')

    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect((await lastPayload()).paidAmount).toBe(700)
  })

  it('accepts a comma as the decimal separator (parsing delegated to the shared input)', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    // The dialog contains NO parser of its own: the comma is normalised by
    // AmountCurrencyInput (`normalizeDecimalInput`, PR #481), so this asserts
    // the wiring — «700,5» must mean 700.5, never 7005.
    fireEvent.change(amountInput(), { target: { value: '700,5' } })
    expect(amountInput().value).toBe('700.5')
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect((await lastPayload()).paidAmount).toBe(700.5)
  })

  it('refuses to guess an ambiguous «1,000» instead of silently paying 1', async () => {
    // The shared normaliser deliberately leaves «1,000» as raw text (1000? 1.0?).
    // `parseFloat` would have truncated it to 1 — a thousand-fold underpayment
    // that closes the obligation in full. It must be rejected, not guessed.
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '1,000' } })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(await screen.findByTestId('pay-salary-amount-error')).toBeInTheDocument()
    expect(paySalaryMock).not.toHaveBeenCalled()
  })

  it('can restore the suggestion after a manual edit', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '700' } })
    fireEvent.click(screen.getByTestId('pay-salary-reset-amount'))
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
  })
})

describe('PaySalaryDialog — deviation warning (AC5)', () => {
  beforeEach(() => paySalaryMock.mockClear())

  it('stays silent within tolerance (a plausible bank rate)', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    // ~2.4% off the NBU-derived figure — an ordinary spread.
    fireEvent.change(amountInput(), { target: { value: '740' } })
    expect(screen.queryByTestId('pay-salary-amount-warning')).not.toBeInTheDocument()
  })

  it('warns on an order-of-magnitude slip — and still lets the payment through', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '72' } })

    const warning = await screen.findByTestId('pay-salary-amount-warning')
    expect(warning).toHaveTextContent('90%')

    // NOT a block: the submit button is enabled and the mutation fires with the
    // entered amount (the owner may know something we do not).
    expect(screen.getByTestId('pay-salary-submit')).not.toBeDisabled()
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect((await lastPayload()).paidAmount).toBe(72)
  })
})

describe('PaySalaryDialog — amount validity (blocks, unlike the warning)', () => {
  beforeEach(() => paySalaryMock.mockClear())

  it('blocks a zero amount', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '0' } })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(await screen.findByTestId('pay-salary-amount-error')).toBeInTheDocument()
    expect(paySalaryMock).not.toHaveBeenCalled()
  })

  // security-review PR #485 (MED-1): an amount the numeric(18,6) column would
  // round to 0.000000 must never reach the server — it would close the
  // obligation in full with a payment recorded as ZERO.
  it('blocks an amount too small to be stored (would be written as 0.000000)', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '0.0000001' } })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(await screen.findByTestId('pay-salary-amount-error')).toHaveTextContent('слишком мала')
    expect(paySalaryMock).not.toHaveBeenCalled()
  })

  it('accepts exactly the smallest storable amount (other side of the same boundary)', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '0.000001' } })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect((await lastPayload()).paidAmount).toBe(0.000001)
  })

  it('blocks more decimals than the column keeps, rather than rounding silently', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '100.1234567' } })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(await screen.findByTestId('pay-salary-amount-error')).toHaveTextContent(
      'знаков после запятой',
    )
    expect(paySalaryMock).not.toHaveBeenCalled()
  })

  it('blocks an amount above the BIZ-13 ceiling', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '500001' } })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(await screen.findByTestId('pay-salary-amount-error')).toBeInTheDocument()
    expect(paySalaryMock).not.toHaveBeenCalled()
  })

  it('surfaces the amount AND receipt errors together, neither gating the other', async () => {
    // Regression guard: an earlier version checked the amount first and
    // returned, so the receipt error could only ever appear once the amount
    // happened to be valid — making one required field's feedback depend on
    // another field's async prefill (and on the E2E timing that pins it).
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('pay-salary-submit'))

    expect(await screen.findByTestId('pay-salary-amount-error')).toBeInTheDocument()
    expect(screen.getByTestId('pay-salary-error-receipt')).toBeInTheDocument()
    expect(paySalaryMock).not.toHaveBeenCalled()
  })

  it('blocks an empty amount', async () => {
    renderDialog()
    await waitFor(() => expect(amountInput().value).toBe(EXPECTED_USDT))
    fireEvent.change(amountInput(), { target: { value: '' } })
    await fillReceipt()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(await screen.findByTestId('pay-salary-amount-error')).toBeInTheDocument()
    expect(paySalaryMock).not.toHaveBeenCalled()
  })
})
