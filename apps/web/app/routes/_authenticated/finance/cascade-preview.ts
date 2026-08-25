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
  remainingAgainstAccumulator,
  settledCurrencyMismatch,
  type CascadeEditPreviewResponse,
  type CurrencyEnum,
} from '@crm/shared'

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
