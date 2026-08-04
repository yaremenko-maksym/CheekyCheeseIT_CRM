/**
 * AdminEditTransactionDialog — MED-2 regression
 * (fix/external-receipt-rendering round 2, security-review PR #470).
 *
 * The form pre-fills the tx's EXISTING receipt into `ReceiptInput` even when
 * the admin is only editing amount/notes. The write schema tightened to
 * https-only for `receiptExternalUrl` (round 1) — without this fix, resending
 * an untouched legacy `http://` value on every save would 400 an edit the
 * admin never asked to make.
 *
 * Pins:
 * 1. Editing only the amount on a tx with a legacy http:// receipt succeeds —
 *    the payload omits receiptDocumentId/receiptExternalUrl entirely
 *    (undefined = "leave unchanged" server-side).
 * 2. Explicitly typing a NEW http:// value DOES include it in the payload —
 *    the tightening still applies to anything actually entered (the 400
 *    itself is server-side, covered by finance.receipts.spec.ts).
 *
 * Strategy: real `@tanstack/react-query` hooks, mock only the API boundary
 * (`@/lib/axios` for the exchange-rate fetch + `../../../api` for the
 * mutation) — mirrors PaySalaryDialog.test.tsx.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const adminUpdateTransactionMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    adminUpdateTransaction: (...args: unknown[]) => adminUpdateTransactionMock(...args),
  },
}))

import { AdminEditTransactionDialog } from '../AdminEditTransactionDialog'

const LEGACY_HTTP_TX = {
  id: 'tx-legacy-http',
  type: 'ADMIN_INCOME',
  status: 'PENDING',
  amount: '500',
  currency: 'USD',
  receiptDocumentId: null,
  receiptExternalUrl: 'http://legacy-partner.example/receipt.jpg',
  notes: null,
  receiverLabel: null,
  salaryMonth: null,
  payoutRequestId: null,
} as unknown as TransactionDto

function renderDialog(tx: TransactionDto | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AdminEditTransactionDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('AdminEditTransactionDialog — MED-2: unchanged legacy http:// receipt does not block an edit', () => {
  beforeEach(() => {
    adminUpdateTransactionMock.mockClear()
  })

  it('editing only the amount succeeds — receipt fields are omitted from the payload', async () => {
    renderDialog(LEGACY_HTTP_TX)

    const amountInput = screen.getByPlaceholderText('0.00')
    fireEvent.change(amountInput, { target: { value: '600' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1))
    const [id, payload] = adminUpdateTransactionMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(id).toBe('tx-legacy-http')
    expect(payload.amount).toBe(600)
    expect(payload).not.toHaveProperty('receiptDocumentId')
    expect(payload).not.toHaveProperty('receiptExternalUrl')
  })

  it('typing a NEW http:// receipt value includes it in the payload (server rejects it — schema coverage elsewhere)', async () => {
    renderDialog(LEGACY_HTTP_TX)

    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'http://still-not-https.example/new-receipt.jpg' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1))
    const [, payload] = adminUpdateTransactionMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(payload.receiptExternalUrl).toBe('http://still-not-https.example/new-receipt.jpg')
  })
})
