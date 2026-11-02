/**
 * AdminEditTransactionDialog — follow-ups of #1213:
 * double-submit guard (QA-LOW-1), guarded preview retry (SR-L-note), single
 * reason-required message (COPY-LOW-1), 44px sibling inputs (UX-L-2) and the
 * locked-date state (UX-M-2).
 */
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
const getEditCascadePreviewMock = vi.fn()
vi.mock('../../../api', () => ({
  financeApi: {
    adminUpdateTransaction: (...args: unknown[]) => adminUpdateTransactionMock(...args),
    getEditCascadePreview: (...args: unknown[]) => getEditCascadePreviewMock(...args),
  },
}))

vi.mock('@/components/ui/date-picker', () => ({
  DatePickerField: ({
    value,
    onChange,
    disabled,
    'data-testid': dataTestId,
  }: {
    value: string
    onChange: (value: string) => void
    disabled?: boolean
    'data-testid'?: string
  }) => (
    <input
      type="date"
      value={value}
      disabled={disabled}
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
  getEditCascadePreviewMock.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
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

const refusal = (code: string) =>
  Object.assign(new Error('x'), {
    response: { status: 400, data: { statusCode: 400, code, message: 'm' } },
  })

describe('AdminEditTransactionDialog — follow-ups', () => {
  // QA-LOW-1 — two clicks in one tick (a script, a double-tap) never see the
  // disabled button: React has not re-rendered between them.
  it('sends exactly one PATCH for two synchronous clicks', async () => {
    adminUpdateTransactionMock.mockReturnValue(new Promise(() => {}))
    renderDialog(TX)
    const save = screen.getByTestId('admin-edit-save')
    act(() => {
      save.click()
      save.click()
      save.click()
    })
    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1)
  })

  it('allows a new save after the first one failed', async () => {
    adminUpdateTransactionMock.mockRejectedValueOnce(refusal('FORBIDDEN'))
    adminUpdateTransactionMock.mockReturnValue(new Promise(() => {}))
    renderDialog(TX)
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(2))
  })

  // SR-L-note — retrying the preview must never reset a save that is in flight.
  it('does not reset a pending save when the preview is retried', async () => {
    const PAID = { ...TX, status: 'PAID', currency: 'USDT', amount: '20000' } as TransactionDto
    const plan = {
      editable: true,
      blockedReason: null,
      plan: {
        sourceId: PAID.id,
        sourceAmountChanged: true,
        oldSourceAmount: 20000,
        newSourceAmount: 25000,
        sourceCurrency: 'USDT',
        derivatives: [],
        sourceWarnings: [],
      },
      version: 'v1',
    }
    getEditCascadePreviewMock.mockResolvedValueOnce(plan)
    adminUpdateTransactionMock.mockReturnValue(new Promise(() => {}))
    renderDialog(PAID)
    const amount = screen.getByTestId('amount-currency-amount-input')
    fireEvent.change(amount, { target: { value: '25000' } })
    await waitFor(() => expect(getEditCascadePreviewMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('admin-edit-save')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await waitFor(() => expect(screen.getByTestId('admin-edit-save')).toBeDisabled())

    getEditCascadePreviewMock.mockRejectedValueOnce(
      Object.assign(new Error('down'), { isAxiosError: true, response: { status: 500 } }),
    )
    getEditCascadePreviewMock.mockResolvedValue({ ...plan, version: 'v2' })
    fireEvent.change(amount, { target: { value: '30000' } })
    fireEvent.click(await screen.findByTestId('cascade-preview-retry'))
    await waitFor(() => expect(getEditCascadePreviewMock).toHaveBeenCalledTimes(3))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByTestId('admin-edit-save')).toBeDisabled()
  })

  // COPY-LOW-1 — one message, inline, announced; no second copy in a banner.
  it('shows the reason-required message once, inline, as the only alert', async () => {
    adminUpdateTransactionMock.mockRejectedValueOnce(
      refusal('FINANCE_TX_DATE_EDIT_REASON_REQUIRED'),
    )
    renderDialog(TX)
    fireEvent.change(screen.getByTestId('admin-edit-tx-date'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    const inline = await screen.findByTestId('admin-edit-tx-date-reason-error')
    expect(inline).toHaveAttribute('role', 'alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByText(inline.textContent ?? 'missing', { selector: 'div' })).toBeNull()
  })

  // UX-L-2 — touch targets of the sibling inputs below `sm`.
  it('gives amount, category and salary-month inputs a 44px touch height below sm', () => {
    const { unmount } = renderDialog({ ...TX, type: 'EXPENSE' } as TransactionDto)
    for (const el of [
      screen.getByTestId('amount-currency-amount-input'),
      screen.getByTestId('admin-edit-expense-category-input'),
    ]) {
      expect(el).toHaveClass('min-h-[44px]', 'sm:min-h-0')
    }
    unmount()
    renderDialog({ ...TX, type: 'SALARY', salaryMonth: '2026-10' } as TransactionDto)
    expect(screen.getByPlaceholderText('2025-03')).toHaveClass('min-h-[44px]', 'sm:min-h-0')
  })

  // UX-M-2 — the date of on-chain / company-funded / settled rows is not editable.
  it('disables the date and explains why when the row date is locked', async () => {
    adminUpdateTransactionMock.mockResolvedValue({})
    renderDialog({ ...TX, isDateLocked: true } as TransactionDto)
    expect(screen.getByTestId('admin-edit-tx-date')).toBeDisabled()
    expect(screen.getByTestId('admin-edit-tx-date-locked-note')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('amount-currency-amount-input'), {
      target: { value: '510' },
    })
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1))
    const payload = adminUpdateTransactionMock.mock.calls[0]![1] as Record<string, unknown>
    expect(payload).not.toHaveProperty('txDate')
    expect(payload).not.toHaveProperty('backdateReason')
  })

  it('leaves the date editable with no note on an unlocked row', () => {
    renderDialog({ ...TX, isDateLocked: false } as TransactionDto)
    expect(screen.getByTestId('admin-edit-tx-date')).not.toBeDisabled()
    expect(screen.queryByTestId('admin-edit-tx-date-locked-note')).toBeNull()
  })
})
