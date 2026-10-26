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
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { kyivToday } from '@crm/shared'

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

vi.mock('@/components/ui/date-picker', () => ({
  DatePickerField: ({
    value,
    onChange,
    minDate,
    id,
    'aria-describedby': ariaDescribedBy,
    'data-testid': dataTestId,
  }: {
    value: string
    onChange: (value: string) => void
    minDate?: string
    id?: string
    'aria-describedby'?: string
    'data-testid'?: string
  }) => (
    <input
      id={id}
      type="date"
      value={value}
      min={minDate}
      aria-describedby={ariaDescribedBy}
      data-testid={dataTestId}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
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
  txDate: '2026-05-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
} as never

// task-i18n-stage3a (Task 1) blast-radius: `PaySalaryDialog` renders the
// shared `AmountCurrencyInput` (`components/ui/`), which now calls
// `useLocale()`/`useLingui()` — outside this file's own perimeter
// (`_authenticated/finance/**` migrates in a later wave).
beforeEach(async () => {
  await loadCatalog('uk')
})

type SalaryTx = Parameters<typeof PaySalaryDialog>[0]['tx']

function renderDialog(tx: SalaryTx = TX) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <PaySalaryDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
  return {
    ...view,
    rerenderDialog(nextTx: SalaryTx) {
      view.rerender(
        <QueryClientProvider client={qc}>
          <PaySalaryDialog tx={nextTx} onClose={() => {}} />
        </QueryClientProvider>,
      )
    },
  }
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
    expect(payload.txDate).toBe(kyivToday())
    expect(payload.receiptExternalUrl).toBe('https://etherscan.io/tx/0xabc123')
    // fix-round 2 (CI-5/CR-H-2): `setReceiptError(receiptErr ? ... : null)`
    // is unconditional (fixes a stale-error bug — see that call site's own
    // comment) — a mutant that always takes the truthy branch would show an
    // error here even though the receipt is valid and the mutation
    // succeeded. No test asserted the ABSENCE of the error element before.
    expect(screen.queryByTestId('pay-salary-error-receipt')).not.toBeInTheDocument()
  })

  it('blocks submit and shows an inline error when the receipt is missing', async () => {
    renderDialog()
    await screen.findByTestId('pay-salary-account-company')
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(paySalaryMock).not.toHaveBeenCalled()
    // fix-round 2 (CI-5/CR-H-2): only asserting the testid's PRESENCE leaves
    // `translateZodMessage(receiptErr) ?? receiptErr` unobserved — a mutant
    // flipping `??` to `&&` renders the raw `zod.RECEIPT_REQUIRED` key
    // instead of translated text, and this assertion alone would not notice.
    // Pin the actual translated uk text the admin sees.
    expect(screen.getByTestId('pay-salary-error-receipt')).toHaveTextContent(
      'Чек обов’язковий — додайте файл або посилання',
    )
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

  it('renders the tx createdAt date with the shortYY style ("01.05.26")', async () => {
    renderDialog()
    await screen.findByTestId('pay-salary-account-company')
    // formatDate(..., 'shortYY') → day.month.2-digit-year — exact string so
    // a mutation to the style key (silently switching formats) fails.
    expect(screen.getByText('01.05.26')).toBeInTheDocument()
  })

  it('shows a payout-date picker', async () => {
    renderDialog()
    await screen.findByTestId('pay-salary-account-company')
    const date = screen.getByTestId('pay-salary-txdate')
    expect(date).toBeInTheDocument()
    expect(date).toHaveAttribute('min', '2026-05-01')
    expect(date).toHaveAttribute('aria-describedby', 'pay-salary-date-helper')
    expect(screen.getByText(/Найраніша доступна дата/).textContent).toBe(
      'Найраніша доступна дата — 01.05.2026.',
    )
  })

  // Backlog 338, QA-LOW-1: for a legacy NULL-`txDate` row the date CELL, the
  // hint, the picker `min` and the server floor are ONE day — the KYIV day of
  // `createdAt` (`transactionBusinessDay`). The server rejects anything earlier
  // with FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION, so a client day that disagrees
  // either hides a valid date or offers a refused one (QA-MED-1 of #1146).
  // Runs under the default, Kyiv and Los Angeles projects; every literal below
  // holds in all three.
  describe('NULL txDate: cell, hint, picker min and default are the Kyiv day of createdAt', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'))
    })
    afterEach(() => vi.useRealTimers())

    const renderNull = (createdAt: string) =>
      renderDialog({
        ...(TX as object),
        id: `null-${createdAt}`,
        txDate: null,
        createdAt,
      } as SalaryTx)

    it('created 2026-10-20 05:00Z: every surface names 20 Oct; the default is Kyiv today', async () => {
      renderNull('2026-10-20T05:00:00.000Z')
      await screen.findByTestId('pay-salary-account-company')
      const picker = screen.getByTestId('pay-salary-txdate')
      expect(screen.getByText('20.10.26')).toBeInTheDocument()
      expect(picker).toHaveAttribute('min', '2026-10-20')
      expect(screen.getByText(/Найраніша доступна дата/).textContent).toBe(
        'Найраніша доступна дата — 20.10.2026.',
      )
      // item (d): max(Kyiv today, floor) as an exact literal.
      expect(picker).toHaveValue('2026-10-22')
    })

    it('created 21:30Z (already the next day in Kyiv): every surface names 21 Oct', async () => {
      renderNull('2026-10-20T21:30:00.000Z')
      await screen.findByTestId('pay-salary-account-company')
      expect(screen.getByText('21.10.26')).toBeInTheDocument()
      expect(screen.getByTestId('pay-salary-txdate')).toHaveAttribute('min', '2026-10-21')
      expect(screen.getByText(/Найраніша доступна дата/).textContent).toBe(
        'Найраніша доступна дата — 21.10.2026.',
      )
    })

    // item (b): the default is max(Kyiv today, Kyiv source day). With Kyiv
    // today = 20 Oct and the row created on Kyiv 21 Oct (UTC 20 Oct), a UTC
    // source key would give 20 Oct — a date the server refuses.
    it('item (b): the default is the Kyiv source day when it is ahead of Kyiv today', async () => {
      vi.setSystemTime(new Date('2026-10-20T20:30:00.000Z')) // Kyiv 23:30 on 20 Oct
      renderNull('2026-10-20T21:30:00.000Z') // Kyiv 00:30 on 21 Oct
      await screen.findByTestId('pay-salary-account-company')
      expect(screen.getByTestId('pay-salary-txdate')).toHaveValue('2026-10-21')
    })

    it('paying with the picker minimum submits exactly that day', async () => {
      renderNull('2026-10-20T21:30:00.000Z')
      const picker = await screen.findByTestId('pay-salary-txdate')
      fireEvent.change(picker, { target: { value: picker.getAttribute('min') } })
      fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
        target: { value: 'https://etherscan.io/tx/0xmin' },
      })
      fireEvent.click(screen.getByTestId('pay-salary-submit'))
      await waitFor(() => expect(paySalaryMock).toHaveBeenCalledTimes(1))
      expect(paySalaryMock.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ txDate: '2026-10-21' }),
      )
    })

    // item (e): an unparseable createdAt no longer throws a RangeError.
    it('item (e): an unparseable createdAt renders a fallback instead of crashing', async () => {
      renderNull('not-a-date')
      await screen.findByTestId('pay-salary-account-company')
      expect(screen.getByTestId('pay-salary-txdate')).not.toHaveAttribute('min')
      expect(screen.queryByText(/Найраніша доступна дата/)).toBeNull()
      expect(screen.getByTestId('pay-salary-txdate')).toHaveValue('2026-10-22')
    })
  })

  it('prefers txDate over createdAt and clamps a future salary payment date', async () => {
    renderDialog({
      ...(TX as object),
      id: 'future-salary',
      txDate: '2099-04-05T00:00:00.000Z',
      createdAt: '2098-01-01T00:00:00.000Z',
    } as typeof TX)
    const date = await screen.findByTestId('pay-salary-txdate')
    await waitFor(() => expect(date).toHaveValue('2099-04-05'))
    expect(date).toHaveAttribute('min', '2099-04-05')
  })

  it('recomputes the payment date when the salary transaction changes without remounting', async () => {
    const first = {
      ...(TX as object),
      id: 'salary-first',
      txDate: '2099-04-05T00:00:00.000Z',
    } as typeof TX
    const second = {
      ...(TX as object),
      id: 'salary-second',
      txDate: '2099-05-06T00:00:00.000Z',
    } as typeof TX
    const view = renderDialog(first)
    await waitFor(() => expect(screen.getByTestId('pay-salary-txdate')).toHaveValue('2099-04-05'))
    view.rerenderDialog(second)
    await waitFor(() => expect(screen.getByTestId('pay-salary-txdate')).toHaveValue('2099-05-06'))
  })

  it('renders nothing when no salary transaction is selected', () => {
    const { container } = renderDialog(null)
    expect(container).toBeEmptyDOMElement()
  })

  it('submits the operator-selected salary payment date', async () => {
    renderDialog()
    fireEvent.change(await screen.findByTestId('pay-salary-txdate'), {
      target: { value: '2026-06-15' },
    })
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xcustomdate' },
    })
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    await waitFor(() => expect(paySalaryMock).toHaveBeenCalledTimes(1))
    expect(paySalaryMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ txDate: '2026-06-15' }),
    )
  })
})
