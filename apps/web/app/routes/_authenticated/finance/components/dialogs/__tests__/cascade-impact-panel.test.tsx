/**
 * task-cascade-preview-ui (task 5) — the loop this whole task exists to close.
 *
 * The server-side cascade shipped across #598–#608 and was unreachable from the
 * interface: the client never called `GET :id/edit-preview` and never sent
 * `cascadeVersion` back, so EVERY edit of a paid amount was refused with
 * «Правка не сохранена…». The owner hit that refusal for real. These tests pin
 * the three halves of the fix that no other spec can see:
 *
 *   CP-1/CP-2  the preview is requested — and ONLY when the edit really is a
 *              cascade edit (a PAID row whose amount actually changed)
 *   CP-6       the token the operator's plan carries is sent back with the save
 *   CP-7/CP-8  «показанное == применённое»: a 409 refuses IN PLACE rather than
 *              silently recomputing behind the operator's back
 *
 * CP-7 is the one worth reading twice. A client that quietly re-fetched and
 * re-submitted on 409 would save a plan the operator never saw — which is
 * precisely the divergence the version token exists to prevent, reintroduced on
 * the client side.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CascadeEditPreviewResponse, TransactionDto } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const adminUpdateTransactionMock = vi.fn().mockResolvedValue({})
const getEditCascadePreviewMock = vi.fn()

vi.mock('../../../api', () => ({
  financeApi: {
    adminUpdateTransaction: (...args: unknown[]) => adminUpdateTransactionMock(...args),
    getEditCascadePreview: (...args: unknown[]) => getEditCascadePreviewMock(...args),
  },
}))

import { AdminEditTransactionDialog } from '../AdminEditTransactionDialog'

const PAID_TX = {
  id: 'tx-paid-1',
  type: 'ADMIN_INCOME',
  status: 'PAID',
  amount: '20000',
  currency: 'USDT',
  receiptDocumentId: null,
  receiptExternalUrl: null,
  notes: null,
  receiverLabel: null,
  receiverName: 'Иван Петров',
  salaryMonth: null,
  payoutRequestId: null,
} as unknown as TransactionDto

const VERSION = 'src:v7:2026-08-24T00:00:00.000Z'

function planWith(
  derivatives: CascadeEditPreviewResponse['plan'] extends null
    ? never
    : NonNullable<CascadeEditPreviewResponse['plan']>['derivatives'],
): CascadeEditPreviewResponse {
  return {
    editable: true,
    blockedReason: null,
    plan: {
      sourceId: PAID_TX.id,
      sourceAmountChanged: true,
      oldSourceAmount: 20000,
      newSourceAmount: 25000,
      sourceCurrency: 'USDT',
      derivatives,
      sourceWarnings: [],
    },
    version: VERSION,
  }
}

const SENIOR_SHARE = {
  id: 'der-1',
  type: 'SENIOR_PENDING_PAYOUT' as const,
  oldAmount: 8000,
  newAmount: 10000,
  sharePercent: 40,
  currency: 'USDT' as const,
  settledAmount: 5000,
  settledCurrency: 'USDT' as const,
  remainingToPay: 5000,
  needsReconfirm: true,
  warnings: [],
}

function renderDialog(tx: TransactionDto = PAID_TX) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AdminEditTransactionDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

function typeAmount(value: string) {
  // The shared `AmountCurrencyInput`'s own testid — the same handle the
  // existing dialog specs use. Its `<Label>` is not associated with the input
  // (pre-existing, module-wide), so `getByLabelText` finds the label and no
  // control; noted rather than fixed here, as retro-fitting `htmlFor` across
  // every финансовый диалог is a separate change with its own blast radius.
  const input = screen.getByTestId('amount-currency-amount-input')
  fireEvent.change(input, { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  getEditCascadePreviewMock.mockResolvedValue(planWith([SENIOR_SHARE]))
  adminUpdateTransactionMock.mockResolvedValue({})
})

describe('cascade preview — the client half of the loop', () => {
  it('CP-1. typing a different amount on a PAID row asks the server what it would cascade to', async () => {
    renderDialog()
    typeAmount('25000')

    await waitFor(() => expect(getEditCascadePreviewMock).toHaveBeenCalled())
    expect(getEditCascadePreviewMock).toHaveBeenCalledWith(PAID_TX.id, 25000)
  })

  it('CP-2. retyping the SAME amount asks nothing — no change is not a cascade', async () => {
    renderDialog()
    typeAmount('20000')

    // 500 ms is past the 400 ms debounce: if a request were coming, it would
    // have gone by now. Asserting "not called" without waiting past the
    // debounce would pass even if the guard were removed.
    await new Promise((r) => setTimeout(r, 500))
    expect(getEditCascadePreviewMock).not.toHaveBeenCalled()
  })

  it('CP-3. the plan is rendered — receiver, both figures, and what was paid', async () => {
    renderDialog()
    typeAmount('25000')

    const row = await screen.findByTestId('cascade-derivative-der-1')

    expect(row.textContent).toContain('Синьору Иван Петров')
    const digits = (row.textContent ?? '').replace(/[^\d]/g, '')
    expect(digits).toContain('8000') // было
    expect(digits).toContain('10000') // стало
    expect(digits).toContain('5000') // уже выплачено
  })

  it('CP-4. a row that will go back to «ожидание выплаты» says so', async () => {
    renderDialog()
    typeAmount('25000')

    expect(await screen.findByTestId('cascade-derivative-reconfirm-der-1')).toBeTruthy()
  })

  it('CP-5. a blocked row shows the server sentence and disables Save', async () => {
    getEditCascadePreviewMock.mockResolvedValue({
      editable: false,
      blockedReason: 'PAYMENT_FACT_RECORDED',
      plan: null,
      version: null,
    })
    renderDialog()
    typeAmount('25000')

    const banner = await screen.findByTestId('cascade-blocked-banner')

    // Verbatim from `CASCADE_LEDGER_FACT_MESSAGES` — the same sentence the
    // write path's 400 body carries, not a friendlier client paraphrase.
    expect(banner.textContent).toContain('зафиксирован факт платежа')
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)
  })

  it('CP-6. saving sends back the version of the plan that was shown', async () => {
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')

    fireEvent.click(screen.getByTestId('admin-edit-save'))

    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalled())
    const payload = adminUpdateTransactionMock.mock.calls[0]?.[1] as { cascadeVersion?: string }
    // Without this the server refuses every paid-amount edit — which is the
    // exact defect this task closes.
    expect(payload.cascadeVersion).toBe(VERSION)
  })

  it('CP-7. a 409 refuses in place — nothing is re-submitted behind the operator', async () => {
    adminUpdateTransactionMock.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Данные изменились с момента предпросмотра' } },
    })
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')

    fireEvent.click(screen.getByTestId('admin-edit-save'))

    const stale = await screen.findByTestId('cascade-stale-banner')
    expect(stale.textContent).toContain('Данные изменились с момента предпросмотра')
    // Exactly one attempt: a silent retry would apply a plan nobody saw.
    expect(adminUpdateTransactionMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)
  })

  it('CP-8. a stale plan offers exactly one way forward — re-request the preview', async () => {
    adminUpdateTransactionMock.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: 'Данные изменились с момента предпросмотра' } },
    })
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await screen.findByTestId('cascade-stale-banner')

    fireEvent.click(screen.getByTestId('cascade-refresh-preview'))

    await waitFor(() => expect(screen.queryByTestId('cascade-stale-banner')).toBeNull())
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', false)
  })

  it('CP-9. a derivative with no share snapshot blocks Save and says why, next to the button', async () => {
    getEditCascadePreviewMock.mockResolvedValue(
      planWith([
        {
          ...SENIOR_SHARE,
          newAmount: null,
          sharePercent: null,
          remainingToPay: null,
          needsReconfirm: false,
          warnings: [{ code: 'NO_SHARE_SNAPSHOT', message: 'Нет снимка процента доли' }],
        },
      ]),
    )
    renderDialog()
    typeAmount('25000')

    await screen.findByTestId('cascade-derivative-warning-der-1-NO_SHARE_SNAPSHOT')

    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)
    // WCAG 2.2 SC 1.4.13 — the reason is readable without hovering anything.
    expect(screen.getByTestId('cascade-save-blocked-note')).toBeTruthy()
  })

  it('CP-10. an overpayment warns but does NOT block — the server accepts it', async () => {
    getEditCascadePreviewMock.mockResolvedValue(
      planWith([
        {
          ...SENIOR_SHARE,
          newAmount: 3000,
          remainingToPay: 0,
          needsReconfirm: false,
          warnings: [{ code: 'OVERPAYMENT', message: 'Уже выплачено 5000 — строка остаётся PAID' }],
        },
      ]),
    )
    renderDialog()
    typeAmount('25000')

    await screen.findByTestId('cascade-derivative-warning-der-1-OVERPAYMENT')

    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', false)
    expect(screen.queryByTestId('cascade-save-blocked-note')).toBeNull()
  })

  it('CP-11. an edit with no derivatives says so instead of showing an empty table', async () => {
    getEditCascadePreviewMock.mockResolvedValue(planWith([]))
    renderDialog()
    typeAmount('25000')

    expect(await screen.findByTestId('cascade-preview-empty')).toBeTruthy()
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', false)
  })

  it('CP-12. a connection failure is named as one, with a retry — not left as «пересчитываем…»', async () => {
    getEditCascadePreviewMock.mockRejectedValue({ isAxiosError: true, message: 'Network Error' })
    renderDialog()
    typeAmount('25000')

    const err = await screen.findByTestId('cascade-preview-error')

    expect(err.textContent).toContain('проверьте соединение')
    expect(screen.getByTestId('cascade-preview-retry')).toBeTruthy()
  })

  it('CP-13. a non-PAID row behaves exactly as before — no preview, no panel', async () => {
    renderDialog({ ...PAID_TX, status: 'PENDING' } as TransactionDto)
    typeAmount('25000')

    await new Promise((r) => setTimeout(r, 500))
    expect(getEditCascadePreviewMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('cascade-impact-panel')).toBeNull()
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', false)
  })
})
