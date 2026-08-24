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
 * NOT HERE, AND WHY (design spec §11, last edge case). The spec asks for a hint
 * when the typed amount is below `settled_amount` on a NON-cascade edit, because
 * the server silently floors the write (`floorAmountAtAccumulator`). That state
 * is unreachable through THIS dialog: `EDITABLE_TYPES` admits
 * ADMIN_INCOME / SENIOR_INCOME / EXPENSE / SALARY / ADMIN_TRANSFER, while every
 * row that can carry an accumulator while NOT being PAID is a
 * `*_PENDING_PAYOUT` — the cascade revert sets `type: revertedType, status:
 * 'PENDING_PAYMENT'` — and the dialog answers those with «Транзакцию нельзя
 * редактировать» before rendering a field at all. Two tests were written for it
 * and went red on a missing INPUT, not a missing hint, which is what surfaced
 * this. UI for a state nobody can reach is worse than no UI: it has to be read
 * and maintained forever without ever running.
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

/**
 * A rejection shaped like a real axios failure — an `Error` SUBCLASS carrying
 * `response`, which is what axios actually throws.
 *
 * Not cosmetic: rejecting with a bare object literal makes Stryker's runner
 * crash on its own `String(err)` during the dry run («Cannot convert object to
 * primitive value»), so the whole mutation gate reports nothing for this
 * package. Measured — the gate went from a full report to a crash the moment
 * these fixtures were added, and back when they became Errors.
 */
function axiosError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    isAxiosError: true,
    response: { status, data: { message } },
  })
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
    adminUpdateTransactionMock.mockRejectedValue(
      axiosError(409, 'Данные изменились с момента предпросмотра'),
    )
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
    adminUpdateTransactionMock.mockRejectedValue(
      axiosError(409, 'Данные изменились с момента предпросмотра'),
    )
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
    getEditCascadePreviewMock.mockRejectedValue(
      Object.assign(new Error('Network Error'), { isAxiosError: true }),
    )
    renderDialog()
    typeAmount('25000')

    const err = await screen.findByTestId('cascade-preview-error')

    expect(err.textContent).toContain('проверьте соединение')
    expect(screen.getByTestId('cascade-preview-retry')).toBeTruthy()
  })

  it('CP-16. a zero amount asks nothing — there is no cascade for "nothing"', async () => {
    renderDialog()
    typeAmount('0')

    await new Promise((r) => setTimeout(r, 500))
    expect(getEditCascadePreviewMock).not.toHaveBeenCalled()
  })

  it('CP-17. fast typing produces ONE request, for the figure that was settled on', async () => {
    renderDialog()
    typeAmount('2')
    typeAmount('25')
    typeAmount('25000')

    await waitFor(() => expect(getEditCascadePreviewMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 300))
    // Without the debounce cleanup, every intermediate figure would fire its
    // own preview — three plans computed for two numbers nobody meant.
    expect(getEditCascadePreviewMock).toHaveBeenCalledTimes(1)
    expect(getEditCascadePreviewMock).toHaveBeenCalledWith(PAID_TX.id, 25000)
  })

  it('CP-18. a second, different amount is a second question — not the first answer again', async () => {
    renderDialog()
    typeAmount('25000')
    await waitFor(() => expect(getEditCascadePreviewMock).toHaveBeenCalledTimes(1))

    typeAmount('30000')

    // If the two amounts shared one cache entry, the panel would answer the
    // second question with the first plan and the operator would save a figure
    // computed for a different number.
    await waitFor(() => expect(getEditCascadePreviewMock).toHaveBeenCalledTimes(2))
    expect(getEditCascadePreviewMock).toHaveBeenLastCalledWith(PAID_TX.id, 30000)
  })

  it('CP-19. a 4xx is NOT «проверьте соединение» — the server answered', async () => {
    getEditCascadePreviewMock.mockRejectedValue(axiosError(400, 'Некорректная сумма'))
    renderDialog()
    typeAmount('25000')

    await new Promise((r) => setTimeout(r, 600))
    // Calling a refusal a connection problem sends the operator to check their
    // wifi over a message the server took the trouble to write.
    expect(screen.queryByTestId('cascade-preview-error')).toBeNull()
  })

  it('CP-20. a 400 on save is shown as itself, not as a stale preview', async () => {
    adminUpdateTransactionMock.mockRejectedValue(
      axiosError(400, 'Нет снимка процента доли по производной строке'),
    )
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')

    fireEvent.click(screen.getByTestId('admin-edit-save'))

    await waitFor(() =>
      expect(screen.getByText('Нет снимка процента доли по производной строке')).toBeTruthy(),
    )
    // «Обновить предпросмотр» would be useless advice here: re-fetching the
    // plan changes nothing about a refusal that is not about staleness.
    expect(screen.queryByTestId('cascade-stale-banner')).toBeNull()
  })

  it('CP-21. an empty plan leaves the dialog its normal width — no table to fit', async () => {
    getEditCascadePreviewMock.mockResolvedValue(planWith([]))
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-preview-empty')

    expect(screen.getByRole('dialog').className).toContain('sm:max-w-md')
  })

  it('CP-22. a plan with rows widens the dialog — measured, not assumed', async () => {
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')

    // The five-column table forces ~750 px of content and overflowed the
    // default `sm:max-w-md` at every breakpoint — found by measuring
    // `scrollWidth` in a real Chromium at 768 px, not by looking at it.
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-3xl')
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
