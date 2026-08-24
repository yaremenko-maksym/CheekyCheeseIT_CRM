/**
 * task-cascade-preview-ui (task 5) — «Выплачено N · осталось M» in the list.
 *
 * A partly-paid obligation is a state the amount column cannot express on its
 * own: the row reads 8 000 while only 3 000 is still owed, and an operator
 * scanning the list for what to pay has no way to tell the two apart. The state
 * only became reachable with tasks 3/3b.
 *
 * The negative cases matter as much as the positive one: this line must be
 * ABSENT from the overwhelming majority of rows. A «Выплачено 0» under every
 * amount would be noise on the busiest screen in the product, and would claim a
 * settle that never happened.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TransactionDto } from '@crm/shared'

import { TransactionRow } from '../TransactionRow'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

const TX_ID = '77777777-7777-4777-8777-777777777777'

const BASE_TX = {
  id: TX_ID,
  type: 'SENIOR_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '8000.000000',
  currency: 'USDT',
  senderId: null,
  senderLabel: 'COMPANY',
  senderName: null,
  receiverId: '88888888-8888-4888-8888-888888888888',
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

const RATES = { usdUah: '41', usdtUah: '41', eurUah: '45', date: '2026-08-01' }

function renderRow(tx: TransactionDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <table>
        <tbody>
          <TransactionRow tx={tx} role="ADMIN" rates={RATES} currentUserId="admin-id" />
        </tbody>
      </table>
    </QueryClientProvider>,
  )
}

function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, '')
}

describe('TransactionRow — the settle accumulator in the list', () => {
  it('TR-1. a partly paid row shows both what was paid and what is left', () => {
    renderRow({
      ...BASE_TX,
      settledAmount: '5000.000000',
      settledCurrency: 'USDT',
    } as TransactionDto)

    const line = screen.getByTestId(`tx-row-settled-${TX_ID}`)

    // Both literals written out: 5 000 paid, 3 000 left of an 8 000 obligation.
    expect(digitsOf(line.textContent ?? '')).toContain('5000')
    expect(digitsOf(line.textContent ?? '')).toContain('3000')
  })

  it('TR-2. no accumulator ⇒ no line at all', () => {
    renderRow(BASE_TX)

    expect(screen.queryByTestId(`tx-row-settled-${TX_ID}`)).toBeNull()
  })

  it('TR-3. a zero accumulator ⇒ still no line', () => {
    renderRow({ ...BASE_TX, settledAmount: '0' } as TransactionDto)

    expect(screen.queryByTestId(`tx-row-settled-${TX_ID}`)).toBeNull()
  })

  it('TR-4. an overpaid row shows «осталось 0», not a negative debt', () => {
    renderRow({
      ...BASE_TX,
      amount: '3000.000000',
      settledAmount: '5000.000000',
      settledCurrency: 'USDT',
    } as TransactionDto)

    const line = screen.getByTestId(`tx-row-settled-${TX_ID}`)

    expect(line.textContent).toContain('осталось')
    expect(line.textContent).not.toContain('-')
    expect(line.textContent).not.toContain('−')
  })

  it('TR-5. money paid in another currency reports the figure but no remainder', () => {
    renderRow({
      ...BASE_TX,
      settledAmount: '2000.000000',
      settledCurrency: 'UAH',
    } as TransactionDto)

    const line = screen.getByTestId(`tx-row-settled-${TX_ID}`)

    // Subtracting UAH from USDT would produce a number that means nothing, and
    // «осталось …» is exactly the phrasing an operator would act on.
    expect(line.textContent).toContain('UAH')
    expect(line.textContent).not.toContain('осталось')
  })
})
