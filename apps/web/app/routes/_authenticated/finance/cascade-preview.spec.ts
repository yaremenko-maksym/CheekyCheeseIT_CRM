/**
 * task-cascade-preview-ui (task 5) — the Save gate, and the row-level
 * «выплачено / осталось» split.
 *
 * WHAT THE GATE IS. Not «are there warnings» (an overpayment is a warning and
 * the server accepts it), not «is the preview editable» (a plan can be
 * editable while one derivative inside it still refuses). It is a MIRROR of the
 * three refusals of `applyEditCascade`'s Phase 1 that are actually visible in
 * the plan — verified against that method line by line, not against the design
 * spec's restatement of it:
 *
 *   1. `newAmount === null`                  — no share snapshot to recompute
 *   2. `OBLIGATION_CURRENCY_MISMATCH`        — refuses unconditionally
 *   3. `needsReconfirm && NON_USDT_CURRENCY` — refuses only on a real revert
 *
 * The other two Phase-1 refusals (`amount` ≠ `settled_amount` on a
 * company-funded row; a missing accumulator on a pre-#599 row) read raw
 * snapshot columns that the plan does not carry, so no client can predict them.
 * They surface as the server's own 400 text at submit — deliberately, and
 * G-8 pins that this gate does NOT pretend to catch them.
 *
 * WHY IT MATTERS THAT THE GATE IS NEITHER TOO WIDE NOR TOO NARROW. Too narrow
 * and the operator hits a guaranteed 400 after typing. Too wide — blocking on
 * any warning — and a legitimate correction becomes impossible to save because
 * the system warned about an overpayment it has no objection to.
 */
import { describe, expect, it } from 'vitest'

import type { CascadeDerivativePlan, CascadeEditPreviewResponse } from '@crm/shared'

import {
  canSaveCascadeEdit,
  cascadePreviewErrorMessage,
  cascadeSaveErrorMessage,
  cascadeStaleMessage,
  needsCascadePreview,
  settlementSplit,
} from './cascade-preview'

/** An axios-error-shaped fixture — only the parts `extractBackendMessage`/`getAxiosStatus` read. */
function axiosError(status: number, message?: string): unknown {
  return {
    isAxiosError: true,
    response: { status, data: message === undefined ? {} : { message } },
  }
}

/** A bare error with no `response` at all — a real network/CORS/timeout failure. */
function networkError(): unknown {
  return { isAxiosError: true }
}

function derivative(over: Partial<CascadeDerivativePlan> = {}): CascadeDerivativePlan {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'SENIOR_PENDING_PAYOUT',
    receiverName: 'Иван Петров',
    oldAmount: 8000,
    newAmount: 10000,
    recomputedShare: 10000,
    sharePercent: 40,
    currency: 'USDT',
    settledAmount: 0,
    settledCurrency: null,
    remainingToPay: 10000,
    needsReconfirm: false,
    warnings: [],
    ...over,
  }
}

function preview(over: Partial<CascadeEditPreviewResponse> = {}): CascadeEditPreviewResponse {
  return {
    editable: true,
    blockedReason: null,
    plan: {
      sourceId: '22222222-2222-4222-8222-222222222222',
      sourceAmountChanged: true,
      oldSourceAmount: 20000,
      newSourceAmount: 25000,
      sourceCurrency: 'USDT',
      derivatives: [derivative()],
      sourceWarnings: [],
    },
    version: 'src:v1:2026-08-24T00:00:00.000Z',
    ...over,
  }
}

describe('canSaveCascadeEdit — the Save gate', () => {
  it('G-1. no preview yet ⇒ the ordinary (non-cascade) edit is not blocked', () => {
    // A VALIDATED/PENDING row never asks for a preview at all; the dialog must
    // keep behaving exactly as it did before this feature existed.
    expect(canSaveCascadeEdit(undefined)).toBe(true)
  })

  it('G-2. a clean plan saves', () => {
    expect(canSaveCascadeEdit(preview())).toBe(true)
  })

  it('G-3. editable:false blocks — the server already refused', () => {
    expect(
      canSaveCascadeEdit(
        preview({ editable: false, blockedReason: 'PAYMENT_FACT_RECORDED', plan: null }),
      ),
    ).toBe(false)
  })

  it('G-4. a derivative with no share snapshot blocks (refusal 1)', () => {
    const p = preview()
    p.plan!.derivatives = [derivative({ newAmount: null, sharePercent: null })]

    expect(canSaveCascadeEdit(p)).toBe(false)
  })

  it('G-5. OBLIGATION_CURRENCY_MISMATCH blocks unconditionally (refusal 2)', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({
        needsReconfirm: false,
        warnings: [{ code: 'OBLIGATION_CURRENCY_MISMATCH', message: 'учтено в другой валюте' }],
      }),
    ]

    expect(canSaveCascadeEdit(p)).toBe(false)
  })

  it('G-6. NON_USDT_CURRENCY blocks only when the row is actually reverting (refusal 3)', () => {
    const warnings: CascadeDerivativePlan['warnings'] = [
      { code: 'NON_USDT_CURRENCY', message: 'выплата учтена в UAH' },
    ]

    const reverting = preview()
    reverting.plan!.derivatives = [derivative({ needsReconfirm: true, warnings })]

    const notReverting = preview()
    notReverting.plan!.derivatives = [derivative({ needsReconfirm: false, warnings })]

    // Same warning, opposite verdicts — this pair is the whole point of
    // refusal 3 and the reason it cannot be simplified to "has the warning".
    expect(canSaveCascadeEdit(reverting)).toBe(false)
    expect(canSaveCascadeEdit(notReverting)).toBe(true)
  })

  it('G-6b. a reverting row with an UNRELATED warning still saves', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({
        needsReconfirm: true,
        warnings: [{ code: 'SIGNED_INVOICE', message: 'Инвойс уже подписан контрагентом' }],
      }),
    ]

    // Refusal 3 is «reverting AND the accumulator is in another currency», not
    // «reverting AND anything at all is flagged». Without this case the code
    // could ask `.some(() => true)` — blocking every warned revert — and G-6
    // would not notice, because its fixture carries the very warning it looks
    // for.
    expect(canSaveCascadeEdit(p)).toBe(true)
  })

  it('G-7. an overpayment does NOT block — the server accepts it', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({
        newAmount: 3000,
        settledAmount: 5000,
        settledCurrency: 'USDT',
        remainingToPay: 0,
        warnings: [{ code: 'OVERPAYMENT', message: 'Уже выплачено 5000 — строка остаётся PAID' }],
      }),
    ]

    // Refusing here would make an honest downward correction unsaveable, and
    // the row legitimately just stays PAID (AC7 of task 3).
    expect(canSaveCascadeEdit(p)).toBe(true)
  })

  it('G-8. needsReconfirm on its own does NOT block — reverting a share is the ordinary case', () => {
    const p = preview()
    p.plan!.derivatives = [derivative({ needsReconfirm: true, settledAmount: 4000 })]

    expect(canSaveCascadeEdit(p)).toBe(true)
  })

  it('G-9. one bad derivative among good ones blocks the whole cascade', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({ id: '33333333-3333-4333-8333-333333333333' }),
      derivative({ id: '44444444-4444-4444-8444-444444444444', newAmount: null }),
    ]

    // Phase 1 is all-or-nothing: a half-applied cascade is the defect the
    // whole decomposition exists to close.
    expect(canSaveCascadeEdit(p)).toBe(false)
  })

  it('G-10b. editable with NO plan at all does not block', () => {
    // The server never sends this shape today (`editable: true` always carries
    // a plan), which is precisely why the branch needs a test: without one the
    // guard could be deleted and nothing would notice until a contract change
    // made the shape real — and then it would throw on `plan.derivatives`
    // rather than fall through to a sane default.
    expect(canSaveCascadeEdit(preview({ plan: null }))).toBe(true)
  })

  it('G-10. an empty plan (no derivatives at all) saves', () => {
    const p = preview()
    p.plan!.derivatives = []

    expect(canSaveCascadeEdit(p)).toBe(true)
  })
})

describe('needsCascadePreview — finding 107, one rule for both the debounced and the live figure', () => {
  const PAID = { status: 'PAID', amount: '20000' }

  it('N-1. a PAID row with a genuinely different amount needs a preview', () => {
    expect(needsCascadePreview(PAID, 25000)).toBe(true)
  })

  it('N-2. the SAME amount is not a cascade edit — nothing changed', () => {
    expect(needsCascadePreview(PAID, 20000)).toBe(false)
  })

  it('N-3. a non-PAID row never needs a preview, however different the amount', () => {
    expect(needsCascadePreview({ status: 'PENDING', amount: '20000' }, 25000)).toBe(false)
  })

  it('N-4. zero or negative is not an amount to preview — there is no cascade for "nothing"', () => {
    expect(needsCascadePreview(PAID, 0)).toBe(false)
    expect(needsCascadePreview(PAID, -5)).toBe(false)
  })

  it('N-5. NaN (an unparseable field) is not a cascade edit either', () => {
    expect(needsCascadePreview(PAID, NaN)).toBe(false)
  })

  it('N-6. no transaction at all (closed dialog) never needs a preview', () => {
    expect(needsCascadePreview(null, 25000)).toBe(false)
    expect(needsCascadePreview(undefined, 25000)).toBe(false)
  })
})

describe('settlementSplit — what a row shows about its own accumulator', () => {
  it('S-1. nothing settled ⇒ nothing to show', () => {
    expect(settlementSplit({ amount: '8000', currency: 'USDT', settledAmount: null })).toBeNull()
  })

  it('S-2. a zero accumulator is still nothing to show', () => {
    // A settle that moved nothing is not a state the operator needs told about,
    // and rendering «выплачено 0» on every untouched row would be noise on the
    // busiest screen in the product.
    expect(settlementSplit({ amount: '8000', currency: 'USDT', settledAmount: '0' })).toBeNull()
  })

  it('S-3. partly settled ⇒ paid and remaining, both figures', () => {
    expect(
      settlementSplit({
        amount: '8000',
        currency: 'USDT',
        settledAmount: '5000',
        settledCurrency: 'USDT',
      }),
    ).toEqual({ settled: 5000, settledCurrency: 'USDT', remaining: 3000 })
  })

  it('S-4. an omitted settledCurrency reads as the row currency, not as a mismatch', () => {
    // The column is written together with the amount, so an absent value on a
    // NON-zero accumulator only happens on a legacy row. Treating it as the
    // row's own currency keeps the subtraction meaningful for the population
    // that actually exists; the plan-level resolver is stricter because it
    // subtracts from a HYPOTHETICAL share, not from the stored figure.
    expect(settlementSplit({ amount: '8000', currency: 'USDT', settledAmount: '5000' })).toEqual({
      settled: 5000,
      settledCurrency: 'USDT',
      remaining: 3000,
    })
  })

  it('S-5. a real currency mismatch reports the paid figure but refuses a remainder', () => {
    expect(
      settlementSplit({
        amount: '50',
        currency: 'USDT',
        settledAmount: '2000',
        settledCurrency: 'UAH',
      }),
    ).toEqual({ settled: 2000, settledCurrency: 'UAH', remaining: null })
  })

  it('S-6. overpaid ⇒ remaining is 0, never negative', () => {
    expect(
      settlementSplit({
        amount: '3000',
        currency: 'USDT',
        settledAmount: '5000',
        settledCurrency: 'USDT',
      }),
    ).toEqual({ settled: 5000, settledCurrency: 'USDT', remaining: 0 })
  })
})

describe('cascadeStaleMessage — COPY-M-2, the 409 conflict banner never suggests a reload', () => {
  it('SM-1. a real backend explanation wins, verbatim', () => {
    expect(cascadeStaleMessage(axiosError(409, 'Данные изменились с момента предпросмотра'))).toBe(
      'Данные изменились с момента предпросмотра',
    )
  })

  it('SM-2. no body at all ⇒ the cascade-owned fallback, never «обновите страницу»', () => {
    const message = cascadeStaleMessage(axiosError(409))

    expect(message).not.toMatch(/страниц/i)
    expect(message).toContain('Обновить предпросмотр')
  })

  it("SM-3. one of Nest's own generic reason phrases is not a real explanation either", () => {
    // `axiosError(409, 'Conflict')` reproduces a bodiless `ConflictException`
    // — Nest fills `.message` with its own reason phrase, not a business
    // explanation. Showing it verbatim would put an English word on a
    // Russian money screen — the exact shape of finding 110, one level up.
    const message = cascadeStaleMessage(axiosError(409, 'Conflict'))

    expect(message).not.toBe('Conflict')
    expect(message).toContain('Обновить предпросмотр')
  })

  it('SM-4. no `response` at all (a genuine network failure) still returns the fallback, not a throw', () => {
    expect(cascadeStaleMessage(networkError())).toContain('Обновить предпросмотр')
  })
})

describe('cascadePreviewErrorMessage — COPY-M-3, one register for the whole banner', () => {
  it('PE-1. a real backend explanation wins, verbatim, whatever the status', () => {
    expect(cascadePreviewErrorMessage(axiosError(400, 'Некорректная сумма'))).toBe(
      'Некорректная сумма',
    )
  })

  it('PE-2. 403 with no usable body reads as a permissions refusal, not a sentence with a period', () => {
    const message = cascadePreviewErrorMessage(axiosError(403))

    // COPY-M-8 (copy-review, MED, PR #613 round 3): the lead-in shortened
    // from "Не удалось загрузить предпросмотр" — measured at 320px to no
    // longer split mid-phrase across the banner's first two lines (see
    // `CASCADE_PREVIEW_LEAD_IN`'s own doc for the measurement).
    expect(message).toBe('Предпросмотр недоступен — недостаточно прав')
    expect(message.endsWith('.')).toBe(false)
  })

  it('PE-3. a 5xx with no usable body names the side of the problem, not "Мы уже знаем"', () => {
    const message = cascadePreviewErrorMessage(axiosError(500))

    expect(message).toBe('Предпросмотр недоступен — ошибка на нашей стороне, попробуйте позже')
    expect(message).not.toContain('Мы')
  })

  it("PE-4. Nest's own generic reason phrase is filtered exactly like finding 110 requires", () => {
    // The same fixture CP-39 (component level) exercises through the dialog —
    // pinned here at the pure-function level too.
    const message = cascadePreviewErrorMessage(axiosError(500, 'Internal server error'))

    expect(message).not.toContain('Internal server error')
    expect(message).toContain('нашей стороне')
  })

  it("PE-5. an unmapped status still says SOMETHING, in this screen's own voice", () => {
    const message = cascadePreviewErrorMessage(axiosError(404))

    expect(message).toBe('Предпросмотр недоступен — попробуйте ещё раз')
  })
})

describe('cascadeSaveErrorMessage — COPY-M-10, the red line matches the plan above it', () => {
  it('SE-1. a real backend explanation wins, verbatim, whatever the status', () => {
    expect(cascadeSaveErrorMessage(axiosError(400, 'Некорректная сумма для этой строки'))).toBe(
      'Некорректная сумма для этой строки',
    )
  })

  it('SE-2. a plain client-thrown Error (the amount-validation check) keeps its OWN message', () => {
    // `AdminEditTransactionDialog`'s mutation throws `new Error('Некорректная
    // сумма')` before any request is sent — no `.response`, and critically no
    // `isAxiosError` either. It must not be mistaken for a network failure.
    expect(cascadeSaveErrorMessage(new Error('Некорректная сумма'))).toBe('Некорректная сумма')
  })

  it('SE-3. an axios network failure (no response at all) speaks the CASCADE voice, not the general one', () => {
    const message = cascadeSaveErrorMessage(networkError())

    expect(message).toBe('Не удалось сохранить — проверьте соединение')
    // The general resolver's fallback for this case is «Нет связи с
    // сервером. Проверьте подключение к интернету и попробуйте снова.» —
    // full sentence, closing period. This must not be that.
    expect(message.endsWith('.')).toBe(false)
  })

  it('SE-4. 403 with no usable body reads in the cascade voice, not "Недостаточно прав для этого действия."', () => {
    const message = cascadeSaveErrorMessage(axiosError(403))

    expect(message).toBe('Не удалось сохранить — недостаточно прав')
    expect(message.endsWith('.')).toBe(false)
  })

  it('SE-5. a 5xx with no usable body names the side of the problem, cascade voice', () => {
    const message = cascadeSaveErrorMessage(axiosError(500))

    expect(message).toBe('Не удалось сохранить — ошибка на нашей стороне, попробуйте позже')
    expect(message).not.toContain('Мы')
  })

  it("SE-6. Nest's own generic reason phrase is filtered exactly like finding 110 requires", () => {
    const message = cascadeSaveErrorMessage(axiosError(500, 'Internal server error'))

    expect(message).not.toContain('Internal server error')
    expect(message).toContain('нашей стороне')
  })

  it("SE-7. an unmapped status still says SOMETHING, in this screen's own voice", () => {
    expect(cascadeSaveErrorMessage(axiosError(404))).toBe(
      'Не удалось сохранить — попробуйте ещё раз',
    )
  })

  it('SE-8. a 429 whose backend message is the SAME text the general resolver would show is still returned verbatim', () => {
    // COPY-H-6 fixed the SERVER to hand back a real (Russian) explanation for
    // a throttled request instead of nothing — so `extractBackendMessage`
    // now wins here too, same as everywhere else. This is not a regression
    // of COPY-M-10: a genuine backend message has always taken priority over
    // either fallback voice, in both resolvers.
    const message = cascadeSaveErrorMessage(
      axiosError(429, 'Слишком много запросов подряд. Подождите немного и повторите попытку.'),
    )

    expect(message).toBe('Слишком много запросов подряд. Подождите немного и повторите попытку.')
  })

  // task-mutation-gate follow-up (PR #613, backlog 121). `isAxiosFailure`
  // reads `err['isAxiosError']` after checking `err !== null && typeof err
  // === 'object'` — both halves of that check are load-bearing, but for
  // different reasons, and each needs its OWN fixture to prove it:
  it('SE-9. `err === null` falls to the plain fallback, not a throw — `err !== null` is load-bearing', () => {
    // `typeof null === 'object'` is JS's own famous quirk — without the
    // `err !== null` half, `isAxiosFailure` would still reach
    // `(err as Record<string, unknown>)['isAxiosError']` for a `null` err,
    // which THROWS (reading a property off `null`), not merely misreads.
    expect(cascadeSaveErrorMessage(null)).toBe('Не удалось сохранить — попробуйте ещё раз')
  })

  it("SE-10. a non-object value carrying its own `isAxiosError` is NOT read as an axios failure — `typeof err === 'object'` is load-bearing", () => {
    // `err: unknown` accepts anything a caller can construct — including a
    // FUNCTION with arbitrary own properties attached. A function is the one
    // JS-native shape that is neither `null` nor `typeof 'object'` (so it
    // passes the first half of the guard and fails the second) yet CAN still
    // carry a property the way a real axios error does. Proves the `typeof
    // === 'object'` half is doing real work: without it, this would read the
    // attached `.response.status` and answer with the axios-shaped 500
    // branch instead of falling through to the plain fallback below.
    const fakeAxiosShapedFunction = Object.assign(() => {}, {
      isAxiosError: true,
      response: { status: 500 },
    })

    expect(cascadeSaveErrorMessage(fakeAxiosShapedFunction)).toBe(
      'Не удалось сохранить — попробуйте ещё раз',
    )
  })
})
