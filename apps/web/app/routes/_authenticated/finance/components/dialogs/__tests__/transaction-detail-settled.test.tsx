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
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TransactionDto } from '@crm/shared'

import { TransactionDetailDialog } from '../TransactionDetailDialog'

const mockUser = vi.fn()

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: mockUser() }),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: {} }) },
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
    // The rate is what makes the refusal legible: `amount = original × rate`,
    // so editing `amount` alone would silently break the identity.
    //
    // A DOT, not the comma the amounts beside it use. That is deliberate and
    // pre-existing: `fmtRate` renders the «Курс (USD)» line of this very dialog
    // as `1 USD = 41.00 UAH`. This assertion originally expected `37,5000` and
    // went red — the code was following the neighbouring rate convention and
    // the expectation was the thing that was wrong. Keeping the dot means the
    // two rate lines in one dialog read the same way.
    expect(fact.parentElement?.textContent).toContain('37.5000')
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
