/** AdminEditTransactionDialog — failed-save banner and reason-field a11y (QA-MED-1). */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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

const adminUpdateTransactionMock = vi.fn()
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
  adminUpdateTransactionMock.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})

const refusal = (code: string) =>
  Object.assign(new Error('x'), {
    response: { status: 400, data: { statusCode: 400, code, message: 'm' } },
  })

async function saveBackdated(code: string) {
  adminUpdateTransactionMock.mockRejectedValueOnce(refusal(code))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AdminEditTransactionDialog tx={TX} onClose={() => {}} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
  fireEvent.change(screen.getByTestId('admin-edit-tx-date'), { target: { value: '2026-08-01' } })
  fireEvent.click(screen.getByTestId('admin-edit-save'))
  return screen.findByRole('alert')
}

describe('AdminEditTransactionDialog — failed-save feedback', () => {
  it('announces the banner and scrolls it into view', async () => {
    await saveBackdated('FORBIDDEN')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'nearest' }),
    )
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).not.toHaveAttribute(
      'aria-invalid',
    )
    expect(screen.queryByTestId('admin-edit-tx-date-reason-error')).toBeNull()
  })

  it('marks and focuses the reason field when the reason is required', async () => {
    const alert = await saveBackdated('FINANCE_TX_DATE_EDIT_REASON_REQUIRED')
    const input = screen.getByTestId('admin-edit-tx-date-reason-input')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const inline = screen.getByTestId('admin-edit-tx-date-reason-error')
    expect(alert.textContent).toBeTruthy()
    expect(alert).toBe(inline) // the inline message is the only alert
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(input).toHaveAttribute('aria-describedby', inline.id)
    expect(input).toHaveClass('border-destructive')
    await waitFor(() => expect(input).toHaveFocus())
  })

  it('clears the banner and the invalid mark when the reason is edited', async () => {
    await saveBackdated('FINANCE_TX_DATE_EDIT_REASON_REQUIRED')
    const input = screen.getByTestId('admin-edit-tx-date-reason-input')
    fireEvent.change(input, { target: { value: 'bank statement' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  // CR-M-7 — typing in the reason field mid-save must not reset the mutation
  // (isPending -> false would re-enable Save and allow a duplicate PATCH).
  it('keeps Save disabled and does not re-submit while a save is pending', async () => {
    let resolveSave: (value: unknown) => void = () => {}
    adminUpdateTransactionMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AdminEditTransactionDialog tx={TX} onClose={() => {}} />
      </QueryClientProvider>,
      { wrapper: I18nTestProvider },
    )
    fireEvent.change(screen.getByTestId('admin-edit-tx-date'), { target: { value: '2026-08-01' } })
    const save = screen.getByTestId('admin-edit-save')
    fireEvent.click(save)
    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(save).toBeDisabled())

    fireEvent.change(screen.getByTestId('admin-edit-tx-date-reason-input'), {
      target: { value: 'typing while saving' },
    })
    // react-query batches observer notifications onto a later tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1)
    resolveSave({})
  })
})
