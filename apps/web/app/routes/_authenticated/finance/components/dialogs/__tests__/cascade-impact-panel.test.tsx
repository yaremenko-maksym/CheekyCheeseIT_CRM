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
  // UX-1: the receiver is carried by the SHARE, not inherited from the edited
  // row. CP-3 asserting this name is now a statement about the plan — on the
  // real path (`ADMIN_INCOME`) the two differ, and inheriting printed the
  // admin's name against the senior's money.
  receiverName: 'Иван Петров',
  oldAmount: 8000,
  newAmount: 10000,
  recomputedShare: 10000,
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

/** A bare 5xx with NO body — what a dev proxy returns when the upstream is down. */
function bodilessError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
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
  // task-mutation-gate follow-up (PR #613, backlog 121). `cascadePanelEngaged`
  // starts `false` — the panel is not shown just because a PAID row's dialog
  // opened, only once its amount has actually needed a plan. `PAID_TX`'s
  // amount is unchanged from mount (`renderDialog()` alone, no `typeAmount`),
  // so neither `shouldPreview` nor `liveAmountNeedsPreview` is ever true and
  // the render-time latch never fires — this is the one moment in the whole
  // suite where `cascadePanelEngaged`'s OWN initial value, not something it
  // gets set to, decides what is on screen.
  it('CP-0. the panel is not engaged on mount, before the amount has ever needed a plan', async () => {
    renderDialog()

    // Past the 400 ms debounce, same margin CP-2 uses — the dialog has had
    // every chance to mount the panel if it were going to.
    await new Promise((r) => setTimeout(r, 500))
    expect(screen.queryByTestId('cascade-impact-panel')).toBeNull()
  })

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

  it('CP-19. a 4xx is NOT «проверьте соединение» — the server answered, and is quoted', async () => {
    getEditCascadePreviewMock.mockRejectedValue(axiosError(400, 'Некорректная сумма'))
    renderDialog()
    typeAmount('25000')

    const err = await screen.findByTestId('cascade-preview-error')

    // UNCHANGED INTENT, STRENGTHENED ASSERTION. This test has always existed to
    // stop one thing: calling a refusal a connection problem, which sends the
    // operator to check their wifi over a message the server took the trouble
    // to write. That is still asserted, verbatim.
    //
    // What changed is the other half. It used to prove the point by asserting
    // NO banner at all — which, once UX-6 showed that a failed preview must not
    // look like an absent one, is the wrong way to be right: it made silence
    // the correct answer to a server that answered. So the negative assertion
    // stays and a positive one joins it — the server's own words are shown.
    expect(err.textContent).not.toContain('проверьте соединение')
    expect(err.textContent).toContain('Некорректная сумма')
  })

  it('CP-31. UX-6 — a preview that FAILED is not treated as a preview never asked for', async () => {
    // Found live, by stopping the API process: the dev proxy answers a bare 500
    // with no body. `isNetworkError` was false (a status exists), so no banner
    // rendered; `preview` was `undefined`, and `canSaveCascadeEdit(undefined)`
    // is `true` BY DESIGN (an ordinary non-cascade edit must not be blocked).
    // The two together made a FAILED preview indistinguishable from one that
    // was never requested: an empty panel and a live Save button.
    //
    // The server would still refuse the write (no token → 400), so no wrong
    // row gets stored — but the operator earns an unexplained refusal instead
    // of being told the preview did not load.
    getEditCascadePreviewMock.mockRejectedValue(bodilessError(500))
    renderDialog()
    typeAmount('25000')

    const err = await screen.findByTestId('cascade-preview-error')
    expect(err.textContent).toBeTruthy()
    expect(screen.getByTestId('cascade-preview-retry')).toBeTruthy()
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)
  })

  it('CP-32. UX-6 — a failed preview blocks Save for a CASCADE edit only, never an ordinary one', async () => {
    // The gate must key off «this edit needs a preview and the preview failed»,
    // not «no preview». An ordinary edit (row not PAID) never asks for one, and
    // blocking it would be a regression invented by the fix.
    getEditCascadePreviewMock.mockRejectedValue(bodilessError(500))
    renderDialog({ ...PAID_TX, status: 'PENDING_PAYMENT' })
    typeAmount('25000')

    await new Promise((r) => setTimeout(r, 600))
    expect(getEditCascadePreviewMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', false)
  })

  it('CP-33. a failed preview does not survive on screen once a NEW figure is being asked about', async () => {
    // Reachable, and the mutation gate found it unguarded: after a failure the
    // operator edits the amount again. For the 400 ms of the debounce the query
    // KEY has not changed yet — so `isError` is still true and its message is
    // still computed — while `previewAmountIsCurrent` has already gone false,
    // i.e. the panel is recomputing. Both conditions hold at once.
    //
    // The screen must say ONE thing: we are recomputing. Showing yesterday's
    // failure over today's question is the same «two answers to one moment»
    // defect as COPY-H-2, arrived at from the other side.
    getEditCascadePreviewMock.mockRejectedValue(bodilessError(500))
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-preview-error')

    typeAmount('90000')

    expect(screen.getByTestId('cascade-preview-loading')).toBeTruthy()
    expect(screen.queryByTestId('cascade-preview-error')).toBeNull()
  })

  it('CP-34. QA-H-2 — currency on a PAID row cannot be entered wrong, and the reason is in Russian', async () => {
    // Found by manual QA: the only refusal left in the cascade still had the
    // old shape. The operator could change the currency of a settled row,
    // click Save, and get back `Cannot change currency or salary month of a
    // settled (PAID) transaction` — English (russian-language.md), naming no
    // remedy, and only after the click. Its neighbour, the ledger-fact
    // refusal, already had both: a Russian text naming the reversing entry,
    // and a control that never lets the state be entered.
    renderDialog()

    const note = await screen.findByTestId('admin-edit-locked-currency-note')
    expect(note.textContent).toContain('сторнирующей')
    // No English left in it — the defect was the language as much as the timing.
    expect(note.textContent).not.toMatch(/[A-Za-z]{4}/)

    // Proactive, not explanatory-after-the-fact: the select is unusable, so the
    // invalid state cannot be reached and the 400 becomes unreachable too.
    const currencySelect = screen.getByRole('combobox')
    expect(currencySelect).toHaveProperty('disabled', true)
  })

  it('CP-35. QA-H-2 — an ordinary, unsettled row keeps its currency editable', async () => {
    // The lock is a property of PAID, not of this dialog. Without this, the fix
    // could disable the field for everyone and every test above would still be
    // green.
    renderDialog({ ...PAID_TX, status: 'PENDING_PAYMENT' })

    await screen.findByTestId('admin-edit-save')
    expect(screen.queryByTestId('admin-edit-locked-currency-note')).toBeNull()
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', false)
  })

  it('CP-37. QA-H-2 — a PAID salary locks its month too, for its own reason', async () => {
    // The mutation gate found this one: the salary-month half of the lock had
    // no test at all, because every other case in this file uses a non-SALARY
    // row and the field only renders for `type: 'SALARY'`. Two locked controls
    // with two unrelated reasons deserve two tests, not one that happens to
    // cover whichever branch the default fixture walks into.
    renderDialog({ ...PAID_TX, type: 'SALARY', salaryMonth: '2026-01' })

    const note = await screen.findByTestId('admin-edit-locked-salary-month-note')
    expect(note.textContent).toContain('сторнирующей')
    expect(note.textContent).not.toMatch(/[A-Za-z]{4}/)
    expect(screen.getByPlaceholderText('2025-03')).toHaveProperty('disabled', true)
  })

  it('CP-36. QA-M-1 — a failed save on ONE transaction does not greet the next one', async () => {
    // Relative of UX-2 (round 4), which cleared the leftover error when the
    // preview was refreshed but not when the dialog was handed a DIFFERENT
    // transaction. `mutation.error` outlives the switch, so opening row B right
    // after a failed save on row A showed B a red banner about A before the
    // operator touched anything. It heals on the next submit, which is exactly
    // what makes it misleading rather than merely wrong.
    adminUpdateTransactionMock.mockRejectedValue(axiosError(400, 'Некорректная сумма'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <AdminEditTransactionDialog tx={PAID_TX} onClose={() => {}} />
      </QueryClientProvider>,
    )

    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await screen.findByText('Некорректная сумма')

    rerender(
      <QueryClientProvider client={qc}>
        <AdminEditTransactionDialog
          tx={{ ...PAID_TX, id: 'other-tx', status: 'PENDING_PAYMENT' }}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )

    expect(screen.queryByText('Некорректная сумма')).toBeNull()
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

  it('CP-23. a closed dialog (no transaction at all) renders and asks nothing', async () => {
    // `AdminEditTransactionDialog` stays MOUNTED with `tx={null}` whenever the
    // list is open and nothing is being edited — which is nearly always. Every
    // access to `tx` on that path has to survive it.
    renderDialog(null as unknown as TransactionDto)

    await new Promise((r) => setTimeout(r, 500))
    expect(getEditCascadePreviewMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('cascade-impact-panel')).toBeNull()
  })

  it('CP-24. SR-H-1 — a figure changed after the preview is never saved against that preview', async () => {
    // The security probe, as a test. Type 25 000, let the plan arrive, then
    // correct to 90 000 and press Save INSIDE the 400 ms debounce window.
    //
    // Before the fix the dialog submitted 90 000 carrying the token of the
    // 25 000 plan. The token is `id` + `updatedAt` — it does NOT encode the
    // amount — so the server accepts it (nothing moved), recomputes the
    // cascade for 90 000 and applies it: shares rewritten, obligations
    // reopened, invoice voided, for a figure whose consequences the operator
    // never saw. That is the «предпросмотр == факт» invariant (ADR AC4 /
    // AC5 §11), broken on the client, not the server.
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')

    typeAmount('90000')
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await new Promise((r) => setTimeout(r, 100))

    // Stated as "no submission carries that token", not "the first one does
    // not": an unconditional assertion over ALL calls, so it cannot pass by
    // there being no call to look at.
    const submissionsClaimingTheStalePlan = adminUpdateTransactionMock.mock.calls.filter(
      ([, body]) => (body as { cascadeVersion?: string }).cascadeVersion === VERSION,
    )
    expect(submissionsClaimingTheStalePlan).toEqual([])
    // And the plan really was for a different figure — otherwise the assertion
    // above would be vacuous.
    expect(getEditCascadePreviewMock).toHaveBeenCalledTimes(1)
    expect(getEditCascadePreviewMock).toHaveBeenCalledWith(PAID_TX.id, 25000)
  })

  it('CP-25. SR-H-1 — Save is unavailable while the shown plan is not the typed figure', async () => {
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', false)

    typeAmount('90000')

    // The gate that makes CP-24 true BY CONSTRUCTION rather than by the
    // operator noticing: the moment the field and the plan disagree, the
    // button is unavailable.
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)
  })

  it('CP-26. CR-M-1 — the panel says it is recomputing during the debounce window', async () => {
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-derivative-der-1')

    typeAmount('90000')

    // Before the fix the panel kept showing the 25 000 plan for a full 400 ms
    // with nothing to mark it stale — precisely the moment a click looks
    // safest. `isFetching` alone cannot cover this: the request has not been
    // made yet.
    expect(screen.getByTestId('cascade-preview-loading')).toBeTruthy()

    // COPY-H-2 (copy-review, HIGH) — the CR-M-1 fix widened `cascadeSaveBlocked`
    // to cover this window, and the blocked-note rode along on the widening.
    // The screen then said «Пересчитываем связанные выплаты…» at the top and
    // «…по отмеченным строкам сумму не пересчитать, нужно ручное решение» at
    // the bottom AT THE SAME TIME, on every keystroke. Nothing is marked,
    // nothing needs deciding — the answer has simply not arrived yet. Those are
    // the two contradicting instructions COPY-H-1 existed to remove, so the
    // recompute window must carry the loading text alone.
    expect(screen.queryByTestId('cascade-save-blocked-note')).toBeNull()
  })

  it('CP-27. SR-H-1 — Save is unavailable while the first preview is still in flight', async () => {
    // `canSaveCascadeEdit(undefined)` is `true` by design (an ordinary
    // non-cascade edit must not be blocked), so before the fix the button was
    // live during the very first request and a click sent the amount with NO
    // `cascadeVersion` — a guaranteed 400. Fail-closed, but for the same
    // reason as CP-24, and it looks like a broken screen to the operator.
    let release: (v: unknown) => void = () => {}
    getEditCascadePreviewMock.mockImplementation(
      () => new Promise((res) => (release = res as (v: unknown) => void)),
    )
    renderDialog()
    typeAmount('25000')

    await waitFor(() => expect(getEditCascadePreviewMock).toHaveBeenCalled())
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)

    // COPY-H-2, the second of the two states the finding names: `preview` is
    // still `undefined` here, and `undefined !== false` satisfied the note's
    // own guard, so the FIRST keystroke of an ordinary, perfectly editable
    // transaction was answered with a refusal citing rows that do not exist.
    expect(screen.queryByTestId('cascade-save-blocked-note')).toBeNull()

    release(planWith([SENIOR_SHARE]))
  })

  it('CP-28. COPY-H-1 — the blocked banner is the only answer; no note contradicts it', async () => {
    getEditCascadePreviewMock.mockResolvedValue({
      editable: false,
      blockedReason: 'PAYOUT_FAMILY',
      plan: null,
      version: null,
    })
    renderDialog()
    typeAmount('25000')
    await screen.findByTestId('cascade-blocked-banner')

    // The banner says «правьте сторнирующей транзакцией» — i.e. never here.
    // A note underneath saying «устраните и сохраняйте» is the opposite
    // instruction, on a money screen, one line apart.
    expect(screen.queryByTestId('cascade-save-blocked-note')).toBeNull()
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)
  })

  it('CP-29. COPY-H-1 — the note names the reason, not a repair the operator cannot make', async () => {
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

    const note = await screen.findByTestId('cascade-save-blocked-note')

    // Every blocking condition is a property of data already written (no share
    // snapshot on a legacy row; an accumulator in another currency). «Пока не
    // устранены» promised work that does not exist — the very defect #610
    // removed from this module.
    expect(note.textContent).not.toContain('устранен')
    expect(note.textContent).toContain('ручное решение')
  })

  it('CP-30. UX-2 — refreshing a stale preview clears the failed-save error with it', async () => {
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

    // The plan is fresh again; a red «сохранение не удалось» line left over
    // from the previous attempt says the opposite, at the same time, on the
    // same screen — the same defect class as COPY-H-1.
    expect(screen.queryByText(/Данные изменились/)).toBeNull()
  })

  it('CP-38. finding 107 — Save is unavailable, and the panel explains why, in the window before the debounced preview exists', async () => {
    // The gate that makes CP-25 true is built off `shouldPreview`, which is
    // itself built off the DEBOUNCED figure — deliberately, so five
    // keystrokes fire one preview (CP-17), not five. That lag opens a window
    // on the VERY FIRST edit of a PAID row: right after the keystroke,
    // `debouncedAmount` still equals `tx.amount`, so `shouldPreview` reads
    // false — no version token exists yet, and a click there would send the
    // new amount with none. `liveAmountNeedsPreview` closes it for the
    // BUTTON synchronously, before the debounce (or React's own effect
    // scheduling) has had any chance to run.
    renderDialog()
    typeAmount('25000')

    // Synchronous — no `await`, no `findBy*`: this is the exact instant the
    // window opens.
    expect(getEditCascadePreviewMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', true)

    // COPY-H-1 (copy-review, HIGH, PR #613 round 2): a disabled button is not
    // the whole fix. The round that closed the button-side of this window
    // left it unmounted on screen — `CascadeImpactPanel` mounted on
    // `shouldPreview` alone, which is false throughout this exact window by
    // construction. "~400 ms" undersold it besides: the debounce timer
    // restarts on every keystroke, so while the operator keeps typing this
    // window does not close at all — seconds, not milliseconds, of a dark
    // button with nothing on screen saying why. The panel now mounts on the
    // SAME live rule the button's own gate uses, and shows the recompute
    // state CR-M-1 already wrote for the debounce window — no new copy, an
    // existing message reused for a window it used to miss entirely.
    expect(screen.getByTestId('cascade-impact-panel')).toBeTruthy()
    expect(screen.getByTestId('cascade-preview-loading')).toBeTruthy()
    // The server has not been asked anything yet, so there is nothing to
    // name a specific reason for — the blocked-note stays reserved for a
    // plan the server actually returned (CP-9/CP-27/CP-28).
    expect(screen.queryByTestId('cascade-save-blocked-note')).toBeNull()

    // A disabled button does not dispatch a click handler at all (real DOM
    // behaviour, honoured by jsdom) — so this is also the proof that a click
    // in this window cannot reach the server.
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    expect(adminUpdateTransactionMock).not.toHaveBeenCalled()
  })

  it('CP-39. finding 110 — a raw 500 with Nest\'s own generic body shows in Russian, not "Internal server error"', async () => {
    // `axiosError` reproduces the REAL shape a genuinely unhandled backend
    // exception arrives in — `@nestjs/core`'s `BaseExceptionFilter` fills
    // `response.data.message` with exactly this text
    // (`MESSAGES.UNKNOWN_EXCEPTION_MESSAGE`) for any exception it does not
    // recognise as an intentional `HttpException`. Before the fix this
    // reached the money screen verbatim, in English.
    getEditCascadePreviewMock.mockRejectedValue(axiosError(500, 'Internal server error'))
    renderDialog()
    typeAmount('25000')

    const err = await screen.findByTestId('cascade-preview-error')

    expect(err.textContent).not.toContain('Internal server error')
    expect(err.textContent?.toLowerCase()).toContain('нашей стороне')
  })

  it('CP-40. COPY-M-7 — the panel does not unmount through a transient empty value while erasing the old amount', () => {
    // `PAID_TX.amount` is '20000'. The FIRST edit of a PAID row pins
    // `debouncedAmount` at that original value for the whole synchronous
    // typing burst below (the debounce is a TRAILING timer and none of these
    // `fireEvent.change` calls waits for it) — so `shouldPreview` stays false
    // throughout, exactly like CP-38. What CP-40 pins is different: WITHOUT
    // the COPY-M-7 fix, `liveAmountNeedsPreview` alone drove the mount, and
    // an erase-to-empty keystroke (the most common way to retype an amount)
    // makes it false too — unmounting `CascadeImpactPanel` for one tick.
    renderDialog()

    typeAmount('2')
    const firstMount = screen.getByTestId('cascade-impact-panel')

    // The transient dip finding 107's own gate does not cover: `amount` is
    // unparseable, `debouncedAmount` still equals `tx.amount` — both
    // `shouldPreview` and `liveAmountNeedsPreview` are false at this exact
    // instant. A bare `(shouldPreview || liveAmountNeedsPreview)` mount
    // condition would unmount the panel here.
    typeAmount('')
    expect(screen.getByTestId('cascade-impact-panel')).toBe(firstMount)

    // Same DOM node continues typing the new figure.
    typeAmount('2')
    typeAmount('25')
    typeAmount('250')
    typeAmount('2500')
    typeAmount('25000')
    expect(screen.getByTestId('cascade-impact-panel')).toBe(firstMount)
  })

  it('CP-41. COPY-M-7 — the panel does not unmount when the typed figure passes back through the original amount', () => {
    // The second transient dip: continuing to type past a value that
    // momentarily spells out the ORIGINAL stored amount again (here
    // '20000', matching `PAID_TX.amount`) before moving on to a genuinely
    // different final figure.
    renderDialog()

    typeAmount('2')
    const firstMount = screen.getByTestId('cascade-impact-panel')

    typeAmount('20')
    typeAmount('200')
    typeAmount('2000')
    typeAmount('20000') // == tx.amount: both flags false for this one instant
    expect(screen.getByTestId('cascade-impact-panel')).toBe(firstMount)

    typeAmount('200000')
    expect(screen.getByTestId('cascade-impact-panel')).toBe(firstMount)
  })

  it('CP-42. COPY-M-7 — settling back on the ORIGINAL amount and stopping still shows nothing extra (no stuck skeleton)', async () => {
    // The sticky flag is intentionally NEVER un-latched mid-dialog (only a
    // row switch resets it — see `cascadePanelEngaged`'s own doc). This pins
    // that leaving `cascadePanelEngaged` engaged after the operator settles
    // back on the unchanged amount is harmless: with both `shouldPreview`
    // and `liveAmountNeedsPreview` false and the debounce SETTLED (not
    // merely pinned mid-burst), the panel renders no visible content at all.
    renderDialog()

    typeAmount('25000')
    expect(screen.getByTestId('cascade-impact-panel')).toBeTruthy()

    typeAmount('20000') // back to tx.amount, and this time we let it settle
    await new Promise((r) => setTimeout(r, 500))

    expect(screen.queryByTestId('cascade-preview-loading')).toBeNull()
    expect(screen.queryByTestId('cascade-preview-error')).toBeNull()
    expect(screen.queryByTestId('cascade-blocked-banner')).toBeNull()
    expect(screen.queryByTestId('cascade-plan-body')).toBeNull()
    // The wrapper itself may still be mounted (sticky) — asserted separately
    // from its CONTENTS, which is what an operator actually sees.
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
