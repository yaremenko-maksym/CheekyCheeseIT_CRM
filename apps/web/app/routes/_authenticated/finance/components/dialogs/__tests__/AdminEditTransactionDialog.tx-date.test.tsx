/**
 * AdminEditTransactionDialog — business date.
 *
 * The form is pre-filled with the stored day and always sends full state, so
 * the payload carries `txDate` (and the reason) ONLY when the day was changed —
 * otherwise a legacy row older than the backdating window would be pushed
 * through the server's date policy on a notes-only edit.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
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

vi.mock('@/components/ui/date-picker', () => ({
  DatePickerField: ({
    value,
    onChange,
    'data-testid': dataTestId,
  }: {
    value: string
    onChange: (value: string) => void
    'data-testid'?: string
  }) => (
    <input
      type="date"
      value={value}
      data-testid={dataTestId}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

import { AdminEditTransactionDialog } from '../AdminEditTransactionDialog'

const TX = {
  id: 'tx-date-1',
  type: 'ADMIN_INCOME',
  status: 'PENDING',
  amount: '500',
  currency: 'USD',
  receiptDocumentId: null,
  receiptExternalUrl: null,
  notes: null,
  receiverLabel: null,
  salaryMonth: null,
  payoutRequestId: null,
  txDate: '2026-10-20T00:00:00.000Z',
  createdAt: '2026-10-20T08:00:00.000Z',
} as unknown as TransactionDto

beforeEach(async () => {
  await loadCatalog('uk')
  adminUpdateTransactionMock.mockClear()
})

function renderDialog(tx: TransactionDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AdminEditTransactionDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

async function savedPayload(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByTestId('admin-edit-save'))
  await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1))
  return adminUpdateTransactionMock.mock.calls[0]![1] as Record<string, unknown>
}

describe('AdminEditTransactionDialog — business date', () => {
  it('pre-fills the stored day and hides the reason', () => {
    renderDialog(TX)
    expect(screen.getByTestId('admin-edit-tx-date')).toHaveValue('2026-10-20')
    expect(screen.queryByTestId('admin-edit-tx-date-reason')).toBeNull()
  })

  it('re-pre-fills when another transaction is opened', () => {
    const { rerender } = renderDialog(TX)
    const qc = new QueryClient()
    rerender(
      <QueryClientProvider client={qc}>
        <AdminEditTransactionDialog
          tx={{ ...TX, id: 'tx-2', txDate: '2026-09-03T00:00:00.000Z' } as TransactionDto}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('admin-edit-tx-date')).toHaveValue('2026-09-03')
  })

  it('omits txDate and the reason when the day is untouched', async () => {
    renderDialog(TX)
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '510' } })
    const payload = await savedPayload()
    expect(payload).not.toHaveProperty('txDate')
    expect(payload).not.toHaveProperty('backdateReason')
  })

  it('sends the changed day without a reason when none was typed', async () => {
    renderDialog(TX)
    fireEvent.change(screen.getByTestId('admin-edit-tx-date'), { target: { value: '2026-10-25' } })
    const payload = await savedPayload()
    expect(payload.txDate).toBe('2026-10-25')
    expect(payload).not.toHaveProperty('backdateReason')
  })

  it('sends the changed day with the trimmed reason', async () => {
    renderDialog(TX)
    fireEvent.change(screen.getByTestId('admin-edit-tx-date'), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByTestId('admin-edit-tx-date-reason-input'), {
      target: { value: '  late bank statement ' },
    })
    const payload = await savedPayload()
    expect(payload.txDate).toBe('2026-08-01')
    expect(payload.backdateReason).toBe('late bank statement')
  })
})
