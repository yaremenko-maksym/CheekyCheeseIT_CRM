/**
 * task-cascade-preview-ui (task 5) — the two pure decisions the cascade screens
 * make, kept out of the components so they can be tested without a DOM and so
 * the mutation gate can actually execute them.
 *
 * Everything money-EXPLAINING (why a row is blocked, why a warning fired) comes
 * from the server verbatim and is never restated here — see the design spec
 * §4.5. What lives here is only the two questions the client genuinely has to
 * answer for itself: may the operator press Save, and what does a partly-paid
 * row show about its own accumulator.
 */
import {
  amountsDiffer,
  remainingAgainstAccumulator,
  settledCurrencyMismatch,
  type CascadeEditPreviewResponse,
  type CurrencyEnum,
} from '@crm/shared'
import { extractBackendMessage, getAxiosStatus } from '@/lib/axios-utils'

/**
 * Does editing `tx`'s amount to `parsedAmount` need a cascade preview at all —
 * a PAID row whose amount genuinely changes?
 *
 * Backlog finding 107. `AdminEditTransactionDialog` used this exact rule
 * TWICE with two different inputs: once against the DEBOUNCED figure (to
 * decide whether to fetch a preview — deliberately lagged by 400 ms so five
 * keystrokes don't fire five previews) and once, here, against the LIVE
 * figure the operator is looking at right now (to decide whether Save may be
 * pressed). Written inline twice, the two copies read identically at rest and
 * only disagree in the window between a keystroke and the debounce settling —
 * which is exactly the window where they need to disagree: the debounced copy
 * says "not a cascade edit yet" while the live one already knows better.
 *
 * That window is NOT a bounded ~400 ms (an earlier round of this fix said so,
 * and PR #613 round 2 corrected it): the debounce is a TRAILING one, restarted
 * on every keystroke, so for as long as the operator keeps typing the
 * debounced copy never catches up at all — the disagreement lasts the whole
 * burst, plus the trailing 400 ms after the last keystroke, not a fixed
 * fraction of a second. One function, two call sites, makes the RULE the one
 * place that could drift; it says nothing about how long the two copies'
 * answers can differ, which is a property of the debounce, not of this
 * function.
 */
export function needsCascadePreview(
  tx: { status: string; amount: string | number } | null | undefined,
  parsedAmount: number,
): boolean {
  return (
    !!tx &&
    tx.status === 'PAID' &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    amountsDiffer(parsedAmount, Number(tx.amount))
  )
}

/**
 * May «Сохранить» be pressed?
 *
 * A MIRROR of the three refusals in `applyEditCascade`'s Phase 1 that are
 * visible in the plan — read off that method, not paraphrased from prose:
 *
 *   1. `newAmount === null`                  (no share snapshot)
 *   2. `OBLIGATION_CURRENCY_MISMATCH`        (refuses unconditionally)
 *   3. `needsReconfirm && NON_USDT_CURRENCY` (refuses only on a real revert)
 *
 * Deliberately NOT «are there warnings». `OVERPAYMENT` is a warning and the
 * server accepts it — the row simply stays PAID (AC7 of task 3) — so blocking
 * on it would make an honest downward correction impossible to save. Equally
 * deliberately not «editable === true» on its own: a plan can be editable while
 * one derivative inside it still refuses.
 *
 * Phase 1's other two refusals read raw snapshot columns (`fundingSource`, a
 * missing `settled_amount`) that the plan does not carry, so no client can
 * predict them. They arrive as the server's own 400 text at submit. That is a
 * known, deliberately-accepted gap, not an oversight — a preventive UI ban
 * cannot be built out of data the preview does not have.
 *
 * `undefined` (no preview requested — an ordinary non-cascade edit) is `true`:
 * this gate only ever ADDS a reason to refuse.
 */
export function canSaveCascadeEdit(preview: CascadeEditPreviewResponse | undefined): boolean {
  if (preview === undefined) return true
  if (!preview.editable) return false
  if (preview.plan === null) return true

  return preview.plan.derivatives.every(
    (d) =>
      d.newAmount !== null &&
      !d.warnings.some((w) => w.code === 'OBLIGATION_CURRENCY_MISMATCH') &&
      !(d.needsReconfirm && d.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')),
  )
}

/**
 * The text for a SAVE that was refused as stale (409 — the plan on screen was
 * overtaken by a concurrent change).
 *
 * COPY-M-2 (copy-review, MED, PR #613 round 2). The dialog used to hand this
 * straight to `getApiErrorMessage`, whose third priority is axios's own
 * `.message` — and by the time an `onError` handler runs anywhere in this
 * app, that property has already been overwritten by the shared interceptor
 * (`axios.ts`) to `getUserFacingErrorMessage`'s GENERAL per-status text
 * whenever the response body carried nothing usable. For 409 that text is
 * "Конфликт данных. Обновите страницу и попробуйте снова." — a full reload
 * is destructive here (it throws away the amount the operator just typed),
 * and the SAME banner already offers a non-destructive way out of the same
 * conflict, one button over: «Обновить предпросмотр».
 *
 * Reads the response body directly — via `extractBackendMessage`, reused
 * rather than duplicated — instead of trusting `err.message`, which is the
 * one place left that still holds what the SERVER actually said, if it said
 * anything. Latent today: the cascade save's own 409 handler always sends
 * `"Данные изменились с момента предпросмотра"`, so `CASCADE_STALE_FALLBACK`
 * is never actually reached in production. Guarded anyway, for the day a
 * bodiless 409 reaches this handler (a proxy timeout, a future refactor that
 * forgets the message) — and fixed HERE, in the cascade module, not in
 * `axios-utils.ts`'s general table: that table is shared by every screen in
 * the CRM, and "reload the page" is the right advice on all of them except
 * this one.
 */
const CASCADE_STALE_FALLBACK =
  'Данные изменились с момента предпросмотра — нажмите «Обновить предпросмотр»'

export function cascadeStaleMessage(err: unknown): string {
  return extractBackendMessage(err) ?? CASCADE_STALE_FALLBACK
}

/**
 * COPY-M-8 (copy-review, MED, PR #613 round 3). The shared lead-in for every
 * `cascade-preview-error` rendering, INCLUDING the network-only line the
 * caller owns (`AdminEditTransactionDialog`'s own "проверьте соединение"
 * case — see that file). One constant, not four copies of the same words,
 * for the same reason `CASCADE_STALE_FALLBACK` is a constant above: a typo
 * in one copy and not the others is how a banner starts disagreeing with
 * itself.
 *
 * Measured at 320px (the narrowest class this module supports —
 * `responsive-design.md`), not guessed: the OLD lead-in, "Не удалось
 * загрузить предпросмотр" (33 chars), does not fit `cascade-preview-error`'s
 * ~244px text column on ONE line — it splits mid-phrase, "предпросмотр"
 * itself carried onto the SECOND of the banner's three lines, so the actual
 * explanation (why it failed) never starts before line 2 ends. Measured via
 * `Range.getClientRects()` per word (not eyeballed): with THIS lead-in
 * (23 chars) the three shorter variants (403 / generic / the caller's
 * network line) drop from 3 lines to 2, and the lead-in itself — now
 * "Предпросмотр недоступен —" — stays whole on line 1 for every variant,
 * including the one long enough that its OWN tail still wraps to a third
 * line ("ошибка на нашей стороне, попробуйте позже" — unavoidable at this
 * width without shortening what it actually says, which is a different
 * finding than this one).
 */
export const CASCADE_PREVIEW_LEAD_IN = 'Предпросмотр недоступен'

/**
 * The text for a FAILED cascade-preview GET (`previewQuery.isError`) — the
 * network-only case (no status at all) is handled by the caller
 * (`AdminEditTransactionDialog`'s own "проверьте соединение" line); this is
 * for anything the server actually answered.
 *
 * COPY-M-3 (copy-review, MED, PR #613 round 2). Same shape of defect as
 * COPY-M-2, in the neighbouring banner. This used to be
 * `getUserFacingErrorMessage(previewQuery.error)` — correct in that a real
 * backend explanation still comes through it verbatim, wrong in its
 * FALLBACK: full sentences with a closing period, sometimes two of them,
 * first person plural ("Мы уже знаем о проблеме") — a different register
 * from the rest of this screen. `constants.ts`, above
 * `CASCADE_BLOCKED_REASON_MESSAGES`, states the house rule in words: one
 * sentence, no closing period, because these renderings share ONE banner and
 * a register change reads as a different system talking. The general
 * fallback breaks that rule the moment it lands in THIS banner
 * (`cascade-preview-error`) — the rule was written before this route existed
 * to reach it.
 *
 * A genuine backend message still wins first, verbatim, via
 * `extractBackendMessage` (reused, not duplicated) — only the STATUS-DERIVED
 * generic tail is replaced, and only here; `axios-utils.ts`'s table is
 * untouched and still correct for every other screen in the CRM.
 */
export function cascadePreviewErrorMessage(err: unknown): string {
  const backendMessage = extractBackendMessage(err)
  if (backendMessage !== undefined) return backendMessage

  const status = getAxiosStatus(err)
  if (status === 403) return `${CASCADE_PREVIEW_LEAD_IN} — недостаточно прав`
  if (status !== undefined && status >= 500) {
    return `${CASCADE_PREVIEW_LEAD_IN} — ошибка на нашей стороне, попробуйте позже`
  }
  return `${CASCADE_PREVIEW_LEAD_IN} — попробуйте ещё раз`
}

/**
 * The text for a FAILED cascade SAVE (`mutation.error` in
 * `AdminEditTransactionDialog`) — the red line at the bottom of the dialog,
 * under the plan.
 *
 * COPY-M-10 (copy-review, MED, PR #613 round 3), "introduced last round":
 * before this, that line read `getApiErrorMessage(mutation.error)` — the
 * project's GENERAL resolver (`axios-utils.ts`), used by every screen in the
 * CRM. A genuine backend message still agreed either way (both read
 * `response.data.message` first, verbatim, via the same
 * `extractBackendMessage`), but the FALLBACK — for a 403/5xx/network failure
 * the server said nothing usable about — did not: full sentences, closing
 * periods, first person plural, landing one paragraph below a plan written
 * in this screen's own one-clause, no-period register
 * (`cascadePreviewErrorMessage`, COPY-M-3, the previous round). Two voices,
 * one dialog, simultaneously.
 *
 * Fixed HERE, in the cascade module — NOT by editing `getApiErrorMessage` or
 * `axios-utils.ts`'s `STATUS_MESSAGES` table, which every OTHER screen in the
 * CRM also reads; narrowing this dialog's own voice must not narrow theirs.
 *
 * The one thing `getApiErrorMessage` did that a bare `extractBackendMessage`
 * read does not: fall through to a THROWN `Error`'s own `.message` — the
 * amount-validation check right above this mutation
 * (`if (isNaN(amt) || amt <= 0) throw new Error('Некорректная сумма')`) is
 * exactly that shape, and it carries no `response` at all, so
 * `extractBackendMessage` alone would silently drop it. Preserved by
 * distinguishing a genuine axios failure (`isAxiosError === true` — the same
 * flag `axios-utils.ts`'s own `isAxiosErrorShape` checks, not re-exported so
 * checked the same way here) from a plain local `Error`: only the former
 * reaches the cascade-voice status branches below; the latter's own message
 * — the whole point of throwing it — is returned as-is.
 */
export function cascadeSaveErrorMessage(err: unknown): string {
  const backendMessage = extractBackendMessage(err)
  if (backendMessage !== undefined) return backendMessage

  const isAxiosFailure =
    err !== null &&
    typeof err === 'object' &&
    (err as Record<string, unknown>)['isAxiosError'] === true

  if (!isAxiosFailure) {
    return err instanceof Error ? err.message : 'Не удалось сохранить — попробуйте ещё раз'
  }

  const status = getAxiosStatus(err)
  if (status === undefined) return 'Не удалось сохранить — проверьте соединение'
  if (status === 403) return 'Не удалось сохранить — недостаточно прав'
  if (status >= 500) return 'Не удалось сохранить — ошибка на нашей стороне, попробуйте позже'
  return 'Не удалось сохранить — попробуйте ещё раз'
}

export interface SettlementSplit {
  /** How much has actually been paid out against this row. Always > 0 here. */
  settled: number
  /** The unit `settled` is denominated in. */
  settledCurrency: CurrencyEnum
  /**
   * What is still owed, or `null` when the accumulator is in a different
   * currency than the row and the difference would be a wrong number rather
   * than an approximation (`remainingAgainstAccumulator`).
   */
  remaining: number | null
}

/**
 * What a row has to say about its own settle accumulator, or `null` when it has
 * nothing to say (never settled, or settled nothing).
 *
 * The `null` return is what keeps this off the overwhelming majority of rows:
 * «Выплачено 0 · осталось 8 000» on every untouched line would be noise on the
 * busiest screen in the product, and would also claim a settle that never
 * happened.
 *
 * A NON-zero accumulator with no recorded currency is read as the row's own
 * currency. This is a deliberate divergence from `resolveDerivative`, which
 * treats the same input as a mismatch: that function subtracts from a
 * HYPOTHETICAL recomputed share and must refuse to guess, whereas here both
 * figures belong to one stored row, and a legacy row written before the
 * currency column existed is the only way to get here at all. Refusing there
 * and reading here is the difference between "do not invent a comparison" and
 * "do not hide a figure the row already carries".
 */
export function settlementSplit(tx: {
  amount: string | number
  currency: CurrencyEnum | string
  // `| undefined` spelled out alongside the `?`: under
  // `exactOptionalPropertyTypes` an optional marker alone does NOT accept an
  // explicitly-`undefined` property, and `TransactionDto` declares these two
  // as `.nullable().optional()` — i.e. exactly that shape.
  settledAmount?: string | number | null | undefined
  settledCurrency?: CurrencyEnum | string | null | undefined
}): SettlementSplit | null {
  // ONE guard, not two. An explicit `null`/`undefined` check used to stand
  // here and the mutation gate proved it unreachable: `Number(null)` is `0`,
  // which the `<= 0` test below already rejects, and `Number(undefined)` is
  // `NaN`, which `Number.isFinite` already rejects. No input could tell the two
  // spellings apart, so the first one could be deleted without any test
  // noticing — the definition of a check that cannot go red.
  const settled = Number(tx.settledAmount)
  if (!Number.isFinite(settled) || settled <= 0) return null

  const rowCurrency = tx.currency as CurrencyEnum
  const settledCurrency = (tx.settledCurrency ?? rowCurrency) as CurrencyEnum
  const mismatch = settledCurrencyMismatch(settled, settledCurrency, rowCurrency)

  return {
    settled,
    settledCurrency,
    remaining: remainingAgainstAccumulator(Number(tx.amount), settled, mismatch),
  }
}
