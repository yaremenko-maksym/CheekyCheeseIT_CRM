/**
 * task-cascade-preview-ui (task 5) — the settle dialog stops showing a figure
 * that is not the one about to leave the account.
 *
 * THE DEFECT, precisely. `SettleSeniorPayoutDialog`'s summary card showed
 * `tx.amount` — the FULL obligation — and, for a drop settle, pre-filled the
 * amount field from `convertAmount(tx.amount, …)`. Since task 3b the server
 * pays `remainingOwed = obligation.amount − settled_amount`
 * (`pending-settlement.service.ts`), so on a PARTLY settled row the operator
 * read 8 000 and 3 000 moved. The money was always right; the screen was wrong,
 * at the one moment the operator is deciding whether to press an irreversible
 * button.
 *
 * It only became reachable because of tasks 3/3b — before them a partly settled
 * obligation could not exist, which is why this ships with them rather than
 * being an old bug nobody noticed.
 *
 * WHY A RENDER TEST AND NOT A PURE-FUNCTION ONE. The defect is not in an
 * arithmetic helper — it is in WHICH number the component chose to display.
 * A test of a new pure function would go red because the function did not
 * exist yet, which proves nothing about the screen. These assertions read the
 * rendered DOM, so they were red against the shipped component and would go red
 * again if someone re-pointed the label at `tx.amount`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TransactionDto } from '@crm/shared'

import { SettleSeniorPayoutDialog } from '../SettleSeniorPayoutDialog'

// Network-free: the dialog's own rate query and the funding picker's user list
// are irrelevant to which figure the summary card prints.
vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn(),
    patch: vi.fn(),
  },
}))

const BASE_TX = {
  id: '55555555-5555-4555-8555-555555555555',
  type: 'SENIOR_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '8000.000000',
  currency: 'USDT',
  senderId: null,
  senderLabel: 'COMPANY',
  senderName: null,
  receiverId: '66666666-6666-4666-8666-666666666666',
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

function renderDialog(tx: TransactionDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SettleSeniorPayoutDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

/** Digits only — the formatter uses a thin space as the thousands separator. */
function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, '')
}

describe('SettleSeniorPayoutDialog — the figure shown is the figure paid', () => {
  it('SR-6. opening the dialog on a DIFFERENT row recomputes the split', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const settled = {
      ...BASE_TX,
      settledAmount: '5000.000000',
      settledCurrency: 'USDT',
    } as TransactionDto
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <SettleSeniorPayoutDialog tx={settled} onClose={() => {}} />
      </QueryClientProvider>,
    )
    await screen.findByTestId('settle-senior-remaining')

    rerender(
      <QueryClientProvider client={qc}>
        <SettleSeniorPayoutDialog
          tx={{ ...BASE_TX, id: 'other', settledAmount: null } as TransactionDto}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )

    // A split memoised without `tx` in its dependencies would keep showing the
    // PREVIOUS row's «уже выплачено» over the new row's obligation — the same
    // class of lie this whole fix exists to remove, one row over.
    expect(await screen.findByText('Сумма')).toBeTruthy()
    expect(screen.queryByTestId('settle-senior-remaining')).toBeNull()
  })

  it('SR-1. a PARTLY settled obligation shows what is still owed, not the full amount', async () => {
    renderDialog({
      ...BASE_TX,
      settledAmount: '5000.000000',
      settledCurrency: 'USDT',
    } as TransactionDto)

    const remaining = await screen.findByTestId('settle-senior-remaining')

    // 8000 − 5000. Written as a literal, not as `8000 - 5000`: an expected
    // value computed the same way the code computes it cannot disagree with it.
    expect(digitsOf(remaining.textContent ?? '')).toContain('3000')
  })

  it('SR-7. with nothing left to pay, the button stops promising a payment', async () => {
    // Reached live by QA, and both review axes landed on it independently: the
    // dead end the spec feared is NOT there — the button works, the obligation
    // closes, the balance does not move. What is wrong is the promise:
    // «Отметить как оплачено» beside a transfer of zero reads as «I am about to
    // send money», and the only thing distinguishing this click from a real
    // payment is a figure three lines above it.
    renderDialog({
      ...BASE_TX,
      settledAmount: '8000.000000',
      settledCurrency: 'USDT',
    } as TransactionDto)

    const submit = await screen.findByTestId('settle-senior-submit')
    expect(submit.textContent).toContain('без доплаты')
    expect(submit.textContent).not.toContain('оплачено')
  })

  it('SR-8. with money still owed, the button still says a payment is happening', async () => {
    renderDialog({
      ...BASE_TX,
      settledAmount: '5000.000000',
      settledCurrency: 'USDT',
    } as TransactionDto)

    const submit = await screen.findByTestId('settle-senior-submit')
    expect(submit.textContent).toContain('оплачено')
  })

  it('SR-2. the full obligation is still shown — as the obligation, labelled as such', async () => {
    renderDialog({
      ...BASE_TX,
      settledAmount: '5000.000000',
      settledCurrency: 'USDT',
    } as TransactionDto)

    // Removing the total would be the opposite error: the operator loses the
    // context for the remainder. Both figures, each named.
    expect(await screen.findByText('Обязательство')).toBeTruthy()
    expect(await screen.findByText('Уже выплачено')).toBeTruthy()
    expect(await screen.findByText('К доплате сейчас')).toBeTruthy()
  })

  it('SR-5. a settle accumulated in another currency shows a dash, not a fabricated figure', async () => {
    renderDialog({
      ...BASE_TX,
      settledAmount: '2000.000000',
      settledCurrency: 'UAH',
    } as TransactionDto)

    const remaining = await screen.findByTestId('settle-senior-remaining')

    // 8 000 USDT − 2 000 UAH is not a smaller number, it is a wrong one, and
    // this is the line the operator is about to pay against.
    expect(remaining.textContent).toBe('—')
  })

  it('SR-3. the ordinary case — nothing settled — is untouched', async () => {
    renderDialog(BASE_TX)

    // The overwhelming majority of settles. One line, «Сумма», exactly as
    // before this task: a corrective fix that changed the common screen would
    // be a redesign smuggled in as a bug fix.
    expect(await screen.findByText('Сумма')).toBeTruthy()
    expect(screen.queryByTestId('settle-senior-remaining')).toBeNull()
    expect(screen.queryByText('К доплате сейчас')).toBeNull()
  })

  it('SR-4. a zero accumulator is treated as "nothing settled", not as a top-up', async () => {
    renderDialog({ ...BASE_TX, settledAmount: '0', settledCurrency: null } as TransactionDto)

    expect(await screen.findByText('Сумма')).toBeTruthy()
    expect(screen.queryByTestId('settle-senior-remaining')).toBeNull()
  })
})
