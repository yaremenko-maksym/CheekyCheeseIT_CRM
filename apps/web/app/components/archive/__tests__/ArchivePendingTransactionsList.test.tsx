/**
 * ArchivePendingTransactionsList — unit tests.
 *
 * task-archive-pending-modal (AC2). This component had never been unit-tested
 * on its own (only exercised indirectly through the three archive dialogs it
 * is embedded in), so its own logic — the per-type Russian label, the period
 * formatter, the empty-state short-circuit — had zero dedicated coverage.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ArchivePendingTransaction } from '@crm/shared'
import { ArchivePendingTransactionsList } from '../ArchivePendingTransactionsList'

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
    const { container } = render(<ArchivePendingTransactionsList transactions={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when transactions is an empty array', () => {
    const { container } = render(<ArchivePendingTransactionsList transactions={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the warning header with the count and the destructive testid', () => {
    render(<ArchivePendingTransactionsList transactions={[salaryTx]} />)
    expect(screen.getByTestId('archive-pending-transactions-warning')).toBeInTheDocument()
    expect(screen.getByText(/Незакрытые PENDING-транзакции \(1\)/)).toBeInTheDocument()
  })

  it('renders one row per transaction, in order', () => {
    render(<ArchivePendingTransactionsList transactions={[salaryTx, seniorIncomeTx]} />)
    expect(screen.getAllByTestId('archive-pending-transaction-row')).toHaveLength(2)
  })

  it('labels SALARY as "Зарплата" and shows salaryMonth as the period', () => {
    render(<ArchivePendingTransactionsList transactions={[salaryTx]} />)
    const row = screen.getByTestId('archive-pending-transaction-row')
    expect(row).toHaveTextContent('Зарплата')
    expect(row).toHaveTextContent('2026-07')
  })

  it('labels SENIOR_INCOME as "Доход синьора (неоплаченная доля)" and formats txDate', () => {
    render(<ArchivePendingTransactionsList transactions={[seniorIncomeTx]} />)
    const row = screen.getByTestId('archive-pending-transaction-row')
    expect(row).toHaveTextContent('Доход синьора (неоплаченная доля)')
    expect(row).toHaveTextContent('15.07.2026')
  })

  it('labels DROP_INCOME as "Доход дропа (неоплаченная доля)"', () => {
    render(<ArchivePendingTransactionsList transactions={[dropIncomeTx]} />)
    const row = screen.getByTestId('archive-pending-transaction-row')
    expect(row).toHaveTextContent('Доход дропа (неоплаченная доля)')
    expect(row).toHaveTextContent('20.07.2026')
  })

  it('shows "—" for a row with neither salaryMonth nor txDate', () => {
    const bare: ArchivePendingTransaction = { ...salaryTx, salaryMonth: null, txDate: null }
    render(<ArchivePendingTransactionsList transactions={[bare]} />)
    expect(screen.getByTestId('archive-pending-transaction-row')).toHaveTextContent('—')
  })

  it('formats the amount with the currency code (formatAmount)', () => {
    render(<ArchivePendingTransactionsList transactions={[salaryTx]} />)
    expect(screen.getByTestId('archive-pending-transaction-row')).toHaveTextContent('1 500,00 USD')
  })
})
