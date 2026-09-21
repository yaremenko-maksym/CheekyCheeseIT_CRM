/**
 * ArchivePendingTransactionsList — unit tests.
 *
 * task-archive-pending-modal (AC2). This component had never been unit-tested
 * on its own (only exercised indirectly through the three archive dialogs it
 * is embedded in), so its own logic — the per-type label, the period
 * formatter, the empty-state short-circuit — had zero dedicated coverage.
 *
 * task-i18n-stage3a (Task 1), Step 6: per-type labels and the period
 * formatter (`formatDate`, `@crm/shared`) both now go through the active
 * catalog/locale — every render below needs `I18nTestProvider` +
 * `loadCatalog('uk')` (SPEC-H-1).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import type { ArchivePendingTransaction } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ArchivePendingTransactionsList } from '../ArchivePendingTransactionsList'

beforeEach(async () => {
  await loadCatalog('uk')
})

function renderList(transactions: ArchivePendingTransaction[] | undefined) {
  return render(<ArchivePendingTransactionsList transactions={transactions} />, {
    wrapper: I18nTestProvider,
  })
}

const salaryTx: ArchivePendingTransaction = {
  id: 'a0000000-0000-4000-8000-000000000001',
  type: 'SALARY',
  salaryMonth: '2026-07',
  txDate: null,
  amount: '1500.00',
  currency: 'USD',
}

const seniorIncomeTx: ArchivePendingTransaction = {
  id: 'a0000000-0000-4000-8000-000000000002',
  type: 'SENIOR_INCOME',
  salaryMonth: null,
  txDate: new Date('2026-07-15T00:00:00.000Z'),
  amount: '4000.00',
  currency: 'USD',
}

const dropIncomeTx: ArchivePendingTransaction = {
  id: 'a0000000-0000-4000-8000-000000000003',
  type: 'DROP_INCOME',
  salaryMonth: null,
  txDate: new Date('2026-07-20T00:00:00.000Z'),
  amount: '300.00',
  currency: 'USDT',
}

describe('ArchivePendingTransactionsList', () => {
  it('renders nothing when transactions is undefined', () => {
    const { container } = renderList(undefined)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when transactions is an empty array', () => {
    const { container } = renderList([])
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the warning header with the count and the destructive testid', () => {
    renderList([salaryTx])
    expect(screen.getByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
    // COPY-M-7 (copy review round 1): the internal "PENDING" status enum no
    // longer leaks into the user-facing header text.
    expect(screen.getByText(/Незакриті транзакції, що чекають виплати \(1\)/)).toBeInTheDocument()
  })

  it('renders one row per transaction, in order', () => {
    renderList([salaryTx, seniorIncomeTx])
    expect(screen.getAllByTestId('archive-pending-transaction-row')).toHaveLength(2)
  })

  it('labels SALARY as "Зарплата" and shows salaryMonth formatted via formatDate (monthYear), not the raw "YYYY-MM" string', () => {
    // COPY-M-12: both period sources now go through the same formatter — a
    // raw "2026-07" would mean the fix regressed back to two date formats
    // in one list.
    renderList([salaryTx])
    const row = screen.getByTestId('archive-pending-transaction-row')
    expect(row).toHaveTextContent('Зарплата')
    expect(row).toHaveTextContent('липень 2026')
    expect(row).not.toHaveTextContent('2026-07')
  })

  it('labels SENIOR_INCOME as "Дохід сеньйора (неоплачена частка)" and formats txDate', () => {
    renderList([seniorIncomeTx])
    const row = screen.getByTestId('archive-pending-transaction-row')
    expect(row).toHaveTextContent('Дохід сеньйора (неоплачена частка)')
    expect(row).toHaveTextContent('15.07.2026')
  })

  it('labels DROP_INCOME as "Дохід дропа (неоплачена частка)"', () => {
    renderList([dropIncomeTx])
    const row = screen.getByTestId('archive-pending-transaction-row')
    expect(row).toHaveTextContent('Дохід дропа (неоплачена частка)')
    expect(row).toHaveTextContent('20.07.2026')
  })

  it('shows "—" for a row with neither salaryMonth nor txDate', () => {
    const bare: ArchivePendingTransaction = { ...salaryTx, salaryMonth: null, txDate: null }
    renderList([bare])
    expect(screen.getByTestId('archive-pending-transaction-row')).toHaveTextContent('—')
  })

  it('formats the amount via formatMoney at the uk locale (comma decimal separator)', () => {
    renderList([salaryTx])
    expect(screen.getByTestId('archive-pending-transaction-row')).toHaveTextContent('1 500,00 USD')
  })

  // UX-M-2 (fix-round 2): was `formatAmount(tx.amount, tx.currency)` — hardcoded
  // ru-RU (comma decimal) regardless of the active locale, while `formatPeriod`
  // right above it already went through `formatDate(..., locale)`. Pins the
  // en locale (period decimal separator) to prove the amount now follows
  // `locale` too, not a fixed ru-RU format.
  it('formats the amount via formatMoney at the en locale (period decimal separator)', async () => {
    await loadCatalog('en')
    renderList([salaryTx])
    const row = screen.getByTestId('archive-pending-transaction-row')
    expect(row).toHaveTextContent('1,500.00 USD')
    expect(row).not.toHaveTextContent('1 500,00')
  })
})
