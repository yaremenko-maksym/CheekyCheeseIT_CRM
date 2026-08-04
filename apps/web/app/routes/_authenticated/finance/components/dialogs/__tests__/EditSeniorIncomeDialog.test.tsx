/**
 * EditSeniorIncomeDialog — MED-2 regression
 * (fix/external-receipt-rendering round 2, security-review PR #470).
 *
 * Same reasoning as AdminEditTransactionDialog: the form pre-fills the tx's
 * EXISTING receipt even when the senior is only resubmitting the amount on a
 * REJECTED row. Without this fix, resending an untouched legacy `http://`
 * receipt on every resubmit would 400 under the now-https-only write schema.
 *
 * Pins:
 * 1. Resubmitting with only the amount changed on a tx with a legacy
 *    http:// receipt succeeds — the payload omits receiptDocumentId/
 *    receiptExternalUrl entirely (undefined = "leave unchanged" server-side).
 * 2. Typing a NEW http:// value DOES include it in the payload.
 *
 * Strategy: real `@tanstack/react-query` hooks, mock `@/context/auth`
 * (mirrors CreateTransactionDialog.usdt-income.test.tsx), `@/lib/axios`
 * (projects fetch) and `../../../api` (the mutation).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'

vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: { id: 'senior-1', role: 'SENIOR', displayName: 'Senior Dev' },
    isLoading: false,
    invalidate: vi.fn(),
  }),
}))

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const updateSeniorIncomeMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    updateSeniorIncome: (...args: unknown[]) => updateSeniorIncomeMock(...args),
  },
}))

import { EditSeniorIncomeDialog } from '../EditSeniorIncomeDialog'

const LEGACY_HTTP_TX = {
  id: 'tx-legacy-http-senior',
  type: 'SENIOR_INCOME',
  status: 'REJECTED',
  amount: '500',
  currency: 'USD',
  receiptDocumentId: null,
  receiptExternalUrl: 'http://legacy-partner.example/receipt.jpg',
  notes: null,
  rejectionReason: 'Чек нечитаем',
  projectName: 'AI Platform v2',
} as unknown as TransactionDto

function renderDialog(tx: TransactionDto | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EditSeniorIncomeDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('EditSeniorIncomeDialog — MED-2: unchanged legacy http:// receipt does not block a resubmit', () => {
  beforeEach(() => {
    updateSeniorIncomeMock.mockClear()
  })

  it('resubmitting with only the amount changed succeeds — receipt fields are omitted from the payload', async () => {
    renderDialog(LEGACY_HTTP_TX)

    const amountInput = screen.getByPlaceholderText('0.00')
    fireEvent.change(amountInput, { target: { value: '600' } })
    fireEvent.click(screen.getByTestId('edit-senior-income-resubmit'))

    await waitFor(() => expect(updateSeniorIncomeMock).toHaveBeenCalledTimes(1))
    const [id, payload] = updateSeniorIncomeMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('tx-legacy-http-senior')
    expect(payload.amount).toBe(600)
    expect(payload).not.toHaveProperty('receiptDocumentId')
    expect(payload).not.toHaveProperty('receiptExternalUrl')
  })

  it('typing a NEW http:// receipt value includes it in the payload (server rejects it — schema coverage elsewhere)', async () => {
    renderDialog(LEGACY_HTTP_TX)

    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'http://still-not-https.example/new-receipt.jpg' },
    })
    fireEvent.click(screen.getByTestId('edit-senior-income-resubmit'))

    await waitFor(() => expect(updateSeniorIncomeMock).toHaveBeenCalledTimes(1))
    const [, payload] = updateSeniorIncomeMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.receiptExternalUrl).toBe('http://still-not-https.example/new-receipt.jpg')
  })
})
