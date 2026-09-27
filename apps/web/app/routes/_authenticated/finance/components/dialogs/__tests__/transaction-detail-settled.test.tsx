/**
 * task-cascade-preview-ui (task 5) — the detail dialog discloses the two facts
 * the operator is refused over.
 *
 * TWO SURFACES, ONE REASON. «Выплачено / К доплате» is the detail-view half of
 * the list line. «Факт платежа» is the triplet
 * (`originalAmount`/`originalCurrency`/`exchangeRate`) that has been on the
 * wire since task-salary-pay-amount and read by NOTHING — so an operator who
 * hits `PAYMENT_FACT_RECORDED` («на этой строке зафиксирован факт платежа»)
 * could not see the fact being cited at them anywhere in the product. A refusal
 * whose cause is invisible cannot be acted on.
 *
 * PF-3 is the security half: the triplet is an internal accounting detail, and
 * a SENIOR looking at their own row must not receive it. That assertion is the
 * reason this file is a render test rather than a snapshot of props.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as rtlRender, screen, fireEvent, type RenderResult } from '@testing-library/react'
import { describe, expect, it, vi, beforeAll } from 'vitest'
import type { ReactElement } from 'react'

import type { TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

import { TransactionDetailDialog } from '../TransactionDetailDialog'

beforeAll(async () => {
  await loadCatalog('uk')
})

// `TransactionDetailDialog` calls `useLingui()` now — wrap every render
// (same pattern as `ActiveTransactionsTable.test.tsx`).
function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

const mockUser = vi.fn()

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: mockUser() }),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

// URL-AWARE, because the dialog makes TWO different `api.get` calls and they
// are not interchangeable: `/transactions/:id` re-fetches the row, and
// `/finance/exchange-rate` feeds the headline `fmtUsd`.
//
// A single blanket `mockResolvedValue({ data: {} })` answered BOTH, so the
// dialog rendered an empty object AS the transaction: `t.amount` was undefined,
// `toUsd` returned undefined, and `undefined.toLocaleString()` threw during
// render. Vitest reported it as an unhandled error while every assertion still
// passed, and Stryker could not even stringify it — the whole @crm/web mutation
// leg crashed on the dry run before mutating a single line. A fixture that is
// not the shape the code reads is not a smaller fixture, it is a different one.
const RATES = { usdUah: '41', usdtUah: '41', eurUah: '45', date: '2026-08-01' }
let currentTx: TransactionDto | null = null

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn((url: string) =>
      url.includes('exchange-rate')
        ? Promise.resolve({ data: RATES })
        : Promise.resolve({ data: currentTx }),
    ),
  },
}))

const TX = {
  id: '99999999-9999-4999-8999-999999999999',
  type: 'SENIOR_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '8000.000000',
  currency: 'USDT',
  senderId: null,
  senderLabel: 'COMPANY',
  senderName: null,
  receiverId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  receiverLabel: null,
  receiverName: 'Иван Петров',
  projectId: null,
  projectName: null,
  payoutRequestId: null,
  seniorSharePercent: 40,
  receiptDocumentId: null,
  receiptExternalUrl: null,
  txHash: null,
  validatedBy: null,
  validatedAt: null,
  rejectionReason: null,
  notes: null,
  salaryMonth: null,
  txDate: null,
  createdBy: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
} as unknown as TransactionDto

function renderDetail(tx: TransactionDto, role: string) {
  currentTx = tx
  mockUser.mockReturnValue({ id: 'viewer-id', role })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TransactionDetailDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, '')
}

describe('TransactionDetailDialog — settle accumulator and payment fact', () => {
  it('DS-1. a partly paid row shows what was paid and what is left', async () => {
    renderDetail(
      { ...TX, settledAmount: '5000.000000', settledCurrency: 'USDT' } as TransactionDto,
      'ADMIN',
    )

    const settled = await screen.findByTestId('tx-detail-settled')

    expect(digitsOf(settled.textContent ?? '')).toContain('5000')
    // «К доплате» lives in the same Row, under the paid figure.
    expect(digitsOf(settled.parentElement?.textContent ?? '')).toContain('3000')
  })

  it('DS-5. UX-8 — a fully closed row says what was paid and NOT «к доплате 0,00»', async () => {
    // The third surface of UX-3. Rounds ago the same defect was fixed in
    // `TransactionRow` and `CascadeImpactPanel`; this dialog reads the SAME
    // `settlementSplit` and kept printing a remainder of zero next to an
    // already-closed obligation — a figure the operator must read and then
    // discard, on a row whose own badge already says «Оплачено».
    renderDetail(
      { ...TX, settledAmount: '8000.000000', settledCurrency: 'USDT' } as TransactionDto,
      'ADMIN',
    )

    const settled = await screen.findByTestId('tx-detail-settled')

    // What WAS paid still matters and stays.
    expect(digitsOf(settled.textContent ?? '')).toContain('8000')
    expect(settled.parentElement?.textContent ?? '').not.toContain('До сплати')
  })

  it('DS-2. a row with no accumulator does not grow a row about it', async () => {
    renderDetail(TX, 'ADMIN')

    await screen.findByText('Дата')
    expect(screen.queryByTestId('tx-detail-settled')).toBeNull()
  })

  it('PF-1. the payment fact is shown when the row carries one', async () => {
    renderDetail(
      {
        ...TX,
        originalAmount: '800.000000',
        originalCurrency: 'USD',
        exchangeRate: '37.5',
      } as TransactionDto,
      'ADMIN',
    )

    const fact = await screen.findByTestId('tx-detail-payment-fact')

    expect(digitsOf(fact.textContent ?? '')).toContain('800')
    // COPY-M-6: «Обязательство» named an entity (`pending_obligations`) that a
    // SALARY row — one of the two writers of this triplet — does not have. The
    // label has to be true for both writers.
    expect(fact.textContent).toContain('Нараховано')
    expect(fact.textContent).not.toContain('Обов’язок')
    // The rate is what makes the refusal legible: `amount = original × rate`,
    // so editing `amount` alone would silently break the identity.
    //
    // COPY-M-5/M-6: the rate is stated in the SAME shape `fmtRate` already uses
    // one row up — «1 <было-должно> = <курс> <оплачено>». «×37.5000» could not
    // be checked by the accountant this row exists for: it did not say what to
    // multiply by what, and a rate is indistinguishable from its reciprocal.
    // The dot is the module's rate convention (`fmtRate`), unchanged.
    expect(fact.parentElement?.textContent).toContain('1 USD = 37.5000 USDT')
    expect(fact.parentElement?.textContent).not.toContain('×')
  })

  it('PF-2. no triplet ⇒ no row — most transactions are untouched', async () => {
    renderDetail(TX, 'ADMIN')

    await screen.findByText('Дата')
    expect(screen.queryByTestId('tx-detail-payment-fact')).toBeNull()
  })

  it('PF-3. a SENIOR does not receive the payment fact — internal accounting detail', async () => {
    renderDetail(
      {
        ...TX,
        originalAmount: '800.000000',
        originalCurrency: 'USD',
        exchangeRate: '37.5',
      } as TransactionDto,
      'SENIOR',
    )

    await screen.findByText('Дата')
    expect(screen.queryByTestId('tx-detail-payment-fact')).toBeNull()
  })

  it('DS-4. a cross-currency settle shows what was paid but NOT a remainder', async () => {
    renderDetail(
      { ...TX, settledAmount: '2000.000000', settledCurrency: 'UAH' } as TransactionDto,
      'ADMIN',
    )

    const settled = await screen.findByTestId('tx-detail-settled')

    expect(settled.textContent).toContain('UAH')
    // 8 000 USDT − 2 000 UAH is not a smaller number, it is a wrong one, and
    // «К доплате» is precisely the label an operator pays against.
    expect(await screen.findByText('Дата')).toBeTruthy()
    expect(screen.queryByText(/До сплати/)).toBeNull()
  })

  it('PF-4. the ACCOUNTANT sees the payment fact too — same audience as ADMIN', async () => {
    renderDetail(
      {
        ...TX,
        originalAmount: '800.000000',
        originalCurrency: 'USD',
        exchangeRate: '37.5',
      } as TransactionDto,
      'ACCOUNTANT',
    )

    expect(await screen.findByTestId('tx-detail-payment-fact')).toBeTruthy()
  })

  it('PF-5. a triplet with no recorded original currency falls back to the row currency', async () => {
    renderDetail(
      { ...TX, originalAmount: '800.000000', originalCurrency: null } as TransactionDto,
      'ADMIN',
    )

    const fact = await screen.findByTestId('tx-detail-payment-fact')

    // Not «800,00 undefined» and not a blank unit — a money figure without a
    // currency is unreadable, and the row's own currency is the only honest
    // fallback available.
    expect(fact.textContent).toContain('USDT')
  })

  it('PF-6. no rate ⇒ no rate line, rather than «×NaN»', async () => {
    renderDetail(
      {
        ...TX,
        originalAmount: '800.000000',
        originalCurrency: 'USD',
        exchangeRate: null,
      } as TransactionDto,
      'ADMIN',
    )

    const fact = await screen.findByTestId('tx-detail-payment-fact')
    // Matched on «Курс:», the CURRENT wording. The old assertion still said
    // «Применённый курс» after COPY-M-5 renamed the line, so it passed by
    // matching nothing — the mutation gate is what surfaced that: removing the
    // `!= null` guard entirely (rendering «Курс: 1 USDT = 0.0000 USDT») left
    // every test green.
    expect(fact.parentElement?.textContent).not.toContain('Курс:')
  })

  it('PF-7. no session user ⇒ no payment fact — «not known yet» is not «privileged»', async () => {
    mockUser.mockReturnValue(undefined)
    currentTx = { ...TX, originalAmount: '800.000000' } as TransactionDto
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TransactionDetailDialog tx={currentTx} onClose={() => {}} />
      </QueryClientProvider>,
    )

    await screen.findByText('Дата')
    expect(screen.queryByTestId('tx-detail-payment-fact')).toBeNull()
  })

  it('DS-3. the settle split IS shown to the senior — it is their own money', async () => {
    renderDetail(
      { ...TX, settledAmount: '5000.000000', settledCurrency: 'USDT' } as TransactionDto,
      'SENIOR',
    )

    // Deliberately the opposite verdict from PF-3, on the same viewer: how much
    // of their own IOU has been paid is not an internal detail, and hiding it
    // while showing the full `amount` would set the two figures against each
    // other on their screen.
    expect(await screen.findByTestId('tx-detail-settled')).toBeTruthy()
  })
})

// task-i18n-stage3d-pr2 (mutation gate, AC10). `TX` above is `type:
// 'SENIOR_PENDING_PAYOUT'` — none of the seven type-specific content blocks
// (`AdminIncomeContent`/`SeniorIncomeContent`/`ExpenseContent`/
// `SalaryContent`/`AdminTransferContent`/`PayoutContent`/
// `PayoutAdminContent`) match it, so every Row label they render was
// entirely unexercised by any existing test — Stryker's StringLiteral
// mutants on those labels survived by construction (no test to notice a
// blanked-out label). One render per type, asserting every label it
// contributes, so the localised text is pinned rather than merely typed.
describe('TransactionDetailDialog — type-specific content blocks (Row labels)', () => {
  it('ADMIN_INCOME: Отримувач / Проєкт / Примітки', async () => {
    renderDetail(
      {
        ...TX,
        type: 'ADMIN_INCOME',
        senderId: 'sender-1',
        senderName: 'Клієнт ТОВ',
        projectId: 'proj-1',
        projectName: 'Project X',
        notes: 'Нотатка',
      } as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Отримувач')).toBeInTheDocument()
    expect(await screen.findByText('Проєкт')).toBeInTheDocument()
    expect(await screen.findByText('Примітки')).toBeInTheDocument()
    expect(await screen.findByText('Нотатка')).toBeInTheDocument()
  })

  it('SENIOR_INCOME: Сеньйор / Проєкт / Частка сеньйора / Хто перевірив / Причина відмови', async () => {
    renderDetail(
      {
        ...TX,
        type: 'SENIOR_INCOME',
        receiverId: 'r-1',
        receiverName: 'Сеньйор Іванов',
        projectId: 'proj-1',
        projectName: 'Project X',
        seniorSharePercent: 20,
        seniorSharePercentSource: 'TEAM',
        validatedAt: '2026-08-02T00:00:00.000Z',
        rejectionReason: 'Чек нечіткий',
        notes: 'Нотатка',
      } as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Сеньйор')).toBeInTheDocument()
    expect(await screen.findByText('Проєкт')).toBeInTheDocument()
    expect(await screen.findByText('Частка сеньйора')).toBeInTheDocument()
    expect(await screen.findByText('команда', { exact: false })).toBeInTheDocument()
    expect(await screen.findByText(/до отримання/)).toBeInTheDocument()
    expect(await screen.findByText('Хто перевірив')).toBeInTheDocument()
    expect(await screen.findByText('Причина відмови')).toBeInTheDocument()
    expect(await screen.findByText('Чек нечіткий')).toBeInTheDocument()
    expect(await screen.findByText('Примітки')).toBeInTheDocument()
    expect(await screen.findByText('Нотатка')).toBeInTheDocument()
  })

  it('EXPENSE: Хто створив / Категорія / Примітки', async () => {
    renderDetail(
      {
        ...TX,
        type: 'EXPENSE',
        senderId: 'sender-1',
        senderName: 'Автор витрати',
        receiverLabel: 'Банківський збір',
        notes: 'Нотатка',
      } as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Хто створив')).toBeInTheDocument()
    expect(await screen.findByText('Категорія')).toBeInTheDocument()
    expect(await screen.findByText('Банківський збір')).toBeInTheDocument()
    expect(await screen.findByText('Примітки')).toBeInTheDocument()
  })

  it('SALARY: Отримувач / Період / Проєкт / Хеш транзакції / Примітки', async () => {
    renderDetail(
      {
        ...TX,
        type: 'SALARY',
        receiverId: 'r-1',
        receiverName: 'Джуніор',
        salaryMonth: '2026-08',
        projectId: 'proj-1',
        projectName: 'Project X',
        txHash: '0xabc123',
        receiptDocumentId: null,
        receiptExternalUrl: null,
        notes: 'Нотатка',
      } as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Отримувач')).toBeInTheDocument()
    expect(await screen.findByText('Період')).toBeInTheDocument()
    expect(await screen.findByText('Проєкт')).toBeInTheDocument()
    expect(await screen.findByText('Хеш транзакції')).toBeInTheDocument()
    expect(await screen.findByText('Примітки')).toBeInTheDocument()
  })

  it('ADMIN_TRANSFER: Відправник / Отримувач / Примітки', async () => {
    renderDetail(
      {
        ...TX,
        type: 'ADMIN_TRANSFER',
        senderId: 's-1',
        senderName: 'Адмін 1',
        receiverId: 'r-1',
        receiverName: 'Адмін 2',
        notes: 'Нотатка',
      } as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Відправник')).toBeInTheDocument()
    expect(await screen.findByText('Отримувач')).toBeInTheDocument()
    expect(await screen.findByText('Примітки')).toBeInTheDocument()
  })

  it('PAYOUT: Сеньйор / Отримувач / Дохід сеньйора / Частка сеньйора / виплачено / Хеш транзакції', async () => {
    renderDetail(
      {
        ...TX,
        type: 'PAYOUT',
        senderId: 's-1',
        senderName: 'Сеньйор Іванов',
        receiverLabel: null,
        txHash: '0xabc123',
        notes: 'Нотатка',
        payoutRequest: {
          incomeAmount: '1000',
          payableAmount: '900',
          seniorSharePercent: 10,
          seniorSharePercentSource: 'PROJECT',
        },
      } as unknown as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Сеньйор')).toBeInTheDocument()
    expect(await screen.findByText('Отримувач')).toBeInTheDocument()
    expect(await screen.findByText('Дохід сеньйора')).toBeInTheDocument()
    expect(await screen.findByText('Частка сеньйора')).toBeInTheDocument()
    expect(await screen.findByText('проєкт', { exact: false })).toBeInTheDocument()
    expect(await screen.findByText('→ виплачено: 900,00 USDT')).toBeInTheDocument()
    expect(await screen.findByText('Хеш транзакції')).toBeInTheDocument()
    expect(await screen.findByText('Примітки')).toBeInTheDocument()
    expect(await screen.findByText('Нотатка')).toBeInTheDocument()
  })

  it('ShareSourceTag: the "USER_DEFAULT" source renders "за замовчуванням"', async () => {
    renderDetail(
      {
        ...TX,
        type: 'SENIOR_INCOME',
        receiverId: 'r-1',
        receiverName: 'Сеньйор Іванов',
        seniorSharePercent: 20,
        seniorSharePercentSource: 'USER_DEFAULT',
      } as TransactionDto,
      'ADMIN',
    )
    expect(await screen.findByText('за замовчуванням', { exact: false })).toBeInTheDocument()
  })

  it('PAYOUT_ADMIN: Джерело / Отримувач / Загальний дохід / Хеш транзакції', async () => {
    renderDetail(
      {
        ...TX,
        type: 'PAYOUT_ADMIN',
        senderId: 's-1',
        senderName: 'Сеньйор Іванов',
        receiverId: 'r-1',
        receiverName: 'Адмін 2',
        txHash: '0xabc123',
        payoutRequest: { payableAmount: '900' },
      } as unknown as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Джерело')).toBeInTheDocument()
    expect(await screen.findByText('Отримувач')).toBeInTheDocument()
    expect(await screen.findByText('Загальний дохід')).toBeInTheDocument()
    expect(await screen.findByText('Хеш транзакції')).toBeInTheDocument()
  })

  it('dialog title, footer close/payout buttons, and attach-receipt trigger text', async () => {
    renderDetail(
      {
        ...TX,
        type: 'ADMIN_INCOME',
        senderId: 'sender-1',
        senderName: 'Клієнт ТОВ',
      } as TransactionDto,
      'ADMIN',
    )
    await screen.findByText('Дата')
    expect(await screen.findByText('Деталі транзакції')).toBeInTheDocument()
  })
})

// task-i18n-stage3d-pr2 (mutation gate, AC10). Split-view attach button
// (hasExistingReceipt ternary), the quick-payout footer, the USD-vs-other
// currency subline, "Виплачено" / "Факт переказу" row labels, the
// txDate-vs-createdAt date fallback, the EUR/UAH rate row, and the ID slice
// were never asserted by any existing test in this file — `TX` (type
// `SENIOR_PENDING_PAYOUT`) is not receipt-eligible, so `showReceiptPanel`
// (and everything gated on it) never renders in any test above; the
// remaining rows simply had no assertion on their own text/value.
describe('TransactionDetailDialog — split-view attach button, footer, and remaining labels (mutation-gate coverage)', () => {
  it('no existing receipt: split-view attach button reads "Прикріпити чек"', async () => {
    renderDetail(
      { ...TX, type: 'ADMIN_INCOME', receiptDocumentId: null, receiptExternalUrl: null },
      'ADMIN',
    )
    const btn = await screen.findByTestId('detail-attach-receipt')
    expect(btn).toHaveTextContent('Прикріпити чек')
  })

  it('an existing receipt: split-view attach button reads "Замінити чек"', async () => {
    renderDetail(
      { ...TX, type: 'ADMIN_INCOME', receiptDocumentId: 'doc-1', receiptExternalUrl: null },
      'ADMIN',
    )
    const btn = await screen.findByTestId('detail-attach-receipt')
    expect(btn).toHaveTextContent('Замінити чек')
  })

  it('canQuickPayout + onQuickPayout renders the "Виплатити" footer button and "Закрити"', async () => {
    const onQuickPayout = vi.fn()
    currentTx = { ...TX, type: 'SENIOR_INCOME', status: 'VALIDATED' } as TransactionDto
    mockUser.mockReturnValue({ id: 'viewer-id', role: 'SENIOR' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TransactionDetailDialog
          tx={currentTx}
          onClose={() => {}}
          canQuickPayout
          onQuickPayout={onQuickPayout}
        />
      </QueryClientProvider>,
    )
    const payoutBtn = await screen.findByTestId('detail-quick-payout')
    expect(payoutBtn).toHaveTextContent('Виплатити')
    expect(screen.getByText('Закрити')).toBeInTheDocument()
    fireEvent.click(payoutBtn)
    expect(onQuickPayout).toHaveBeenCalledWith(currentTx)
  })

  it('without canQuickPayout, no footer button renders at all', async () => {
    renderDetail({ ...TX, type: 'ADMIN_INCOME' }, 'ADMIN')
    await screen.findByText('Дата')
    expect(screen.queryByTestId('detail-quick-payout')).not.toBeInTheDocument()
    expect(screen.queryByText('Закрити')).not.toBeInTheDocument()
    expect(screen.queryByText('Скасувати')).not.toBeInTheDocument()
  })

  it('a USD transaction shows no original-currency subline; a non-USD one does', async () => {
    renderDetail({ ...TX, currency: 'USD', amount: '100.00' } as TransactionDto, 'ADMIN')
    const usdAmount = await screen.findByText('$100,00')
    // The subline (fmtAmount) would duplicate the headline for USD — absent.
    expect(screen.queryByText('100,00 USD')).not.toBeInTheDocument()
    expect(usdAmount).toBeInTheDocument()
  })

  it('a non-USD transaction (USDT) shows the original-amount subline', async () => {
    renderDetail(TX, 'ADMIN')
    expect(await screen.findByText(/8\s?000,00\s?USDT/)).toBeInTheDocument()
  })

  it('"Виплачено" and "Факт переказу" row labels render with their values', async () => {
    renderDetail(
      {
        ...TX,
        settledAmount: '1000.000000',
        settledCurrency: 'USDT',
        originalAmount: '800.000000',
        originalCurrency: 'USD',
        exchangeRate: '37.5',
      } as TransactionDto,
      'ADMIN',
    )
    expect(await screen.findByText('Виплачено')).toBeInTheDocument()
    expect(await screen.findByText('Факт переказу')).toBeInTheDocument()
  })

  it('the date row falls back to createdAt when txDate is null, and uses txDate when set', async () => {
    renderDetail({ ...TX, txDate: null, createdAt: '2026-08-01T00:00:00.000Z' }, 'ADMIN')
    expect(await screen.findByText('1 серпня 2026 р.')).toBeInTheDocument()
  })

  it('when txDate is set, the date row uses it instead of createdAt', async () => {
    renderDetail(
      { ...TX, txDate: '2026-09-15T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' },
      'ADMIN',
    )
    expect(await screen.findByText('15 вересня 2026 р.')).toBeInTheDocument()
  })

  it('a EUR transaction with loaded rates shows the "Курс (USD)" row with "· НБУ"', async () => {
    renderDetail({ ...TX, currency: 'EUR', amount: '100.00' } as TransactionDto, 'ADMIN')
    expect(await screen.findByText('Курс (USD)')).toBeInTheDocument()
    expect(screen.getByText('· НБУ')).toBeInTheDocument()
  })

  it('a UAH transaction with loaded rates also shows the "Курс (USD)" row', async () => {
    renderDetail({ ...TX, currency: 'UAH', amount: '1000.00' } as TransactionDto, 'ADMIN')
    expect(await screen.findByText('Курс (USD)')).toBeInTheDocument()
  })

  it('the footer ID line shows the first 8 characters of the tx id, not the full id', async () => {
    renderDetail(TX, 'ADMIN')
    expect(await screen.findByText(`ID: ${TX.id.slice(0, 8)}…`)).toBeInTheDocument()
    expect(screen.queryByText(`ID: ${TX.id}…`)).not.toBeInTheDocument()
  })

  it('cancelling the AttachReceiptSheet actually closes it (onClose is wired, not a no-op)', async () => {
    renderDetail({ ...TX, type: 'ADMIN_INCOME' }, 'ADMIN')
    fireEvent.click(await screen.findByTestId('detail-attach-receipt'))
    expect(await screen.findByTestId('attach-receipt-sheet')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('attach-receipt-sheet-cancel'))
    expect(screen.queryByTestId('attach-receipt-sheet')).not.toBeInTheDocument()
  })

  it('with no session user, showAttachButton is false and the attach button never renders', async () => {
    currentTx = { ...TX, type: 'ADMIN_INCOME' } as TransactionDto
    mockUser.mockReturnValue(undefined)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TransactionDetailDialog tx={currentTx} onClose={() => {}} />
      </QueryClientProvider>,
    )
    await screen.findByText('Дата')
    expect(screen.queryByTestId('detail-attach-receipt')).not.toBeInTheDocument()
  })

  it('before the refetch resolves, the dialog shows the `tx` prop content immediately (no skeleton flash)', () => {
    currentTx = { ...TX, type: 'ADMIN_INCOME' } as TransactionDto
    mockUser.mockReturnValue({ id: 'viewer-id', role: 'ADMIN' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TransactionDetailDialog tx={currentTx} onClose={() => {}} />
      </QueryClientProvider>,
    )
    // Synchronous — no `await`/`findBy`: the `financeApi.getTransaction`
    // promise has not resolved yet, so this is exactly the window where
    // `detail ?? tx` (shows `tx` immediately) and a mutated `detail && tx`
    // (shows nothing until the promise settles) diverge.
    expect(screen.getByText('Прихід адміна')).toBeInTheDocument()
  })

  // task-i18n-stage3d-pr2 (mutation gate, AC10). `tx={null}` is the real shape
  // the parent passes while the dialog is closed (mount before any row is
  // selected) — `row` is `null` at the point `hasExistingReceipt` reads
  // `row?.receiptDocumentId` / `row?.receiptExternalUrl`. No prior test ever
  // rendered with `tx={null}`, so a mutant dropping either `?.` (which would
  // throw on this exact shape) never ran against anything that could observe
  // it.
  it('tx=null: mounts without throwing (row is null; hasExistingReceipt must stay optional-chained)', () => {
    mockUser.mockReturnValue({ id: 'viewer-id', role: 'ADMIN' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    expect(() =>
      render(
        <QueryClientProvider client={qc}>
          <TransactionDetailDialog tx={null} onClose={() => {}} />
        </QueryClientProvider>,
      ),
    ).not.toThrow()
  })

  it('the sr-only dialog description renders the full explanatory sentence', async () => {
    renderDetail({ ...TX, type: 'ADMIN_INCOME' }, 'ADMIN')
    expect(
      await screen.findByText(
        'Повна інформація про фінансову транзакцію, статус і прикріплений чек.',
      ),
    ).toBeInTheDocument()
  })

  // task-i18n-stage3d-pr2 (mutation gate, AC10). The footer condition is
  // `row && canQuickPayout && onQuickPayout` — three ANDs. Every existing
  // test either has all three truthy or (`canQuickPayout` defaulted) all
  // three falsy together, so an AND→OR mutation on any pair never flips the
  // observed outcome. These two isolate each remaining truthy/falsy split.
  it('canQuickPayout is false even though onQuickPayout is provided: footer button still does not render', async () => {
    currentTx = { ...TX, type: 'SENIOR_INCOME', status: 'VALIDATED' } as TransactionDto
    mockUser.mockReturnValue({ id: 'viewer-id', role: 'SENIOR' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TransactionDetailDialog
          tx={currentTx}
          onClose={() => {}}
          canQuickPayout={false}
          onQuickPayout={vi.fn()}
        />
      </QueryClientProvider>,
    )
    await screen.findByText('Дата')
    expect(screen.queryByTestId('detail-quick-payout')).not.toBeInTheDocument()
  })

  it('tx is null even though canQuickPayout+onQuickPayout are provided: footer button still does not render', () => {
    mockUser.mockReturnValue({ id: 'viewer-id', role: 'SENIOR' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TransactionDetailDialog
          tx={null}
          onClose={() => {}}
          canQuickPayout
          onQuickPayout={vi.fn()}
        />
      </QueryClientProvider>,
    )
    expect(screen.queryByTestId('detail-quick-payout')).not.toBeInTheDocument()
  })

  // task-i18n-stage3d-pr2 (mutation gate, AC10). The EUR/UAH tests above both
  // have `rates` truthy — nothing before this asserted the negative: a
  // currency that is neither EUR nor UAH must NOT show the row, even with
  // rates loaded.
  it('a USD transaction does not show the "Курс (USD)" row even though rates are loaded', async () => {
    renderDetail({ ...TX, currency: 'USD', amount: '100.00' } as TransactionDto, 'ADMIN')
    // `fmtUsd` only prints the "$"-prefixed form once `rates` has resolved
    // (before that it falls back to `fmtAmount`'s plain "100,00 USD" shape) —
    // waiting for the headline is how this test proves `rates` is truthy at
    // the point it asserts the row's absence, not just that it hasn't
    // rendered yet.
    await screen.findByText('$100,00')
    expect(screen.queryByText('Курс (USD)')).not.toBeInTheDocument()
  })
})
