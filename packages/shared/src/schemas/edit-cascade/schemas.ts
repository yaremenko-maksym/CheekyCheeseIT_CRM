import { z } from 'zod'
import type { FinanceInvoicesErrorCode } from '../api-errors/finance-invoices'
import { transactionTypeSchema, MAX_TRANSACTION_AMOUNT } from '../finance'
import { moneyFloorAndPrecisionError } from '../money'
import { currencyEnumSchema } from '../payment-requisites'

// ---------------------------------------------------------------------------
// Plan — the resolver's output. Crosses the wire (`GET /edit-preview`
// response), so it is Zod like every other DTO in this package.
// ---------------------------------------------------------------------------

export const cascadeWarningCodeSchema = z.enum([
  // AC5 §4 / C1 — the derivative has no share-percent snapshot to recompute
  // from (legacy row, or a settled row whose settled_share_percent is
  // missing). The plan REFUSES to guess (newAmount stays null).
  'NO_SHARE_SNAPSHOT',
  // AC5 §6 / L13 / C3 — the derivative already carries a counterparty-signed
  // invoice; a cascaded amount change would silently disagree with a
  // document the counterparty already holds.
  'SIGNED_INVOICE',
  // AC3 "Уменьшение суммы" — the new share is LESS than what has already
  // been settled. The row stays PAID (never marked for return to PENDING);
  // this is a human decision (write-off / claw-back), not an automatic one.
  'OVERPAYMENT',
  // AC3 / task 1 (PR #599) — `settledAmount` was accumulated in a currency
  // other than the SOURCE's own currency (a DROP obligation settled in
  // UAH/EUR/USD against a USDT income), so it is not directly comparable to
  // `newAmount`, which is always a share of `newSourceAmount` expressed in
  // that SAME source currency. HIGH-2-residual (security-review round 2):
  // the comparison is against the source's actual currency
  // (`CascadeDerivativePlan.currency` below), never a hardcoded `'USDT'`
  // literal — today the source is always USDT (`declareUsdtProjectIncome`),
  // but the guard that keeps it that way (BIZ-18) is exactly what task 3
  // lifts, so a literal would silently stop matching reality the moment
  // that guard changes.
  'NON_USDT_CURRENCY',
  // MED-1 (security-review round 1) — the SOURCE row (the one being edited)
  // already carries a COUNTERPARTY-signed invoice (e.g. a `SALARY` row).
  // Distinct from `SIGNED_INVOICE` above (which flags a DERIVATIVE) purely
  // by which row it is attached to on the plan (`sourceWarnings` vs a
  // derivative's own `warnings`) — same underlying concern (C3 of the ADR).
  'SOURCE_SIGNED_INVOICE',
  // MED-1 (security-review round 1) — the SOURCE row already carries
  // `originalAmount` (C2 of the ADR): it is a fact-of-payment record, and
  // editing `amount` would desync it from `exchangeRate` without anyone
  // noticing.
  'SOURCE_ORIGINAL_AMOUNT_SET',
  // task-cascade-apply (backlog 95, addendum §3.5) — the paired
  // `pending_obligations` row is denominated in a DIFFERENT currency than the
  // source income. The cascade WRITES `newAmount` (a share of the source
  // amount, in the SOURCE's currency) into `pending_obligations.amount`, so a
  // mismatch means writing a figure into a column that means something else.
  // Distinct from `NON_USDT_CURRENCY` above, which is about the `settled_amount`
  // ACCUMULATOR being in another unit (a comparison the resolver refuses to
  // make); this one is about the DESTINATION of a write. Unlike every other
  // warning here it BLOCKS application outright (task 3, AC4) — see the
  // resolver comment below for why `newAmount` is still computed anyway.
  'OBLIGATION_CURRENCY_MISMATCH',
])
export type CascadeWarningCode = z.infer<typeof cascadeWarningCodeSchema>

/**
 * A warning is a CODE plus the FACTS it is about — never a sentence. The text is
 * rendered by the client from `CASCADE_WARNING_MESSAGES`
 * (`edit-cascade-warning-registry.ts`) in the viewer's locale; `params` names are
 * pinned per code by `CASCADE_WARNING_PARAMS`. Amounts are numbers (the client
 * formats them), currencies are codes, variants are explicit flag params.
 */
export const cascadeWarningSchema = z.object({
  code: cascadeWarningCodeSchema,
  params: z.record(z.string(), z.string().or(z.number())),
})
export type CascadeWarning = z.infer<typeof cascadeWarningSchema>

export const cascadeDerivativePlanSchema = z.object({
  id: z.string().uuid(),
  type: transactionTypeSchema,
  /**
   * UX-1 — who this share is FOR, carried from the row itself (see
   * `CascadeDerivativeSnapshot.receiverName` for why deriving it client-side
   * was wrong). Reaches only ADMIN: the sole route onto the wire is
   * `GET /transactions/:id/edit-preview`, which is `@Roles('ADMIN')` at the
   * guard layer AND re-checks `currentUser.role !== 'ADMIN'` in the service —
   * a viewer who already sees every counterparty unmasked in `mapTx`. Pinned
   * negatively by the preview RBAC specs so widening that route goes red
   * instead of quietly carrying an identity along.
   */
  receiverName: z.string().nullable(),
  /** Current stored amount — `pending_obligations.amount` when an obligation exists (always USDT), else the derivative row's own `amount`. */
  oldAmount: z.number(),
  /**
   * What this row's `amount` WILL BE after saving — `null` when `sharePercent`
   * is `null` (NO_SHARE_SNAPSHOT). Floored at `settledAmount`, exactly as
   * `applyEditCascade` writes it, so the screen cannot describe a figure the
   * system has already decided not to store (QA-H-1).
   */
  newAmount: z.number().nullable(),
  /**
   * What the share COMES OUT TO — `roundShareAmount(newSourceAmount,
   * sharePercent)`, before the accumulator floor. Equal to `newAmount` except
   * when the recomputed share falls below what has already been paid; that gap
   * IS the overpayment, and it is what the `OVERPAYMENT` warning quotes and
   * what `applyEditCascade` journals as `CASCADE_OVERPAYMENT`. Carried rather
   * than re-derived on the write side: re-deriving is how the two descriptions
   * drifted apart in the first place (ADR AC4).
   */
  recomputedShare: z.number().nullable(),
  /** The percent this plan computed `newAmount` from — `null` alongside `newAmount`. */
  sharePercent: z.number().int().nullable(),
  /**
   * HIGH-2-residual (security-review round 2): the currency `oldAmount` AND
   * `newAmount` are both denominated in — always the SOURCE row's own
   * currency (`CascadeSourceSnapshot.currency`, threaded through
   * `resolveEditCascade` → `resolveDerivative`), never assumed. Round 1
   * left this implicit (a code comment in another package); a human reading
   * the plan could not tell what unit `newAmount` was in without it. This is
   * NOT necessarily the same currency as `settledCurrency` below — that is
   * the entire point of the `NON_USDT_CURRENCY` warning.
   */
  currency: currencyEnumSchema,
  /**
   * How much of `oldAmount` has already actually been paid out — the
   * MONOTONIC `transactions.settled_amount` accumulator (task 1, PR #599),
   * read unconditionally regardless of the obligation's CURRENT status
   * (HIGH-1, security-review round 1). `0` when the row has never gone
   * through a settle.
   */
  settledAmount: z.number(),
  /**
   * The currency `settledAmount` is denominated in — `null` alongside a
   * `settledAmount` of `0` that never went through a settle. `newAmount`
   * itself is always denominated in `currency` above (the SOURCE's own
   * currency); when this differs from that (HIGH-2-residual, round 2: a
   * comparison, never a hardcoded `'USDT'` check) the two are NOT the same
   * unit (HIGH-2, security-review round 1) — see `remainingToPay` below.
   */
  settledCurrency: currencyEnumSchema.nullable(),
  /**
   * `max(0, newAmount - settledAmount)` when `settledCurrency` matches
   * `currency` above (or there is nothing settled yet). `null` when
   * `settledCurrency` is set and does NOT match — subtracting a share from a
   * differently-denominated accumulator is not an approximation, it is a
   * wrong number (HIGH-2 / HIGH-2-residual). The `NON_USDT_CURRENCY` warning
   * carries the explanation; `settledAmount`/`settledCurrency` above carry
   * the real figure for a human to reconcile in task 5.
   */
  remainingToPay: z.number().nullable(),
  /**
   * `true` for an already-settled (`PAID`) obligation whose recomputed
   * share is STILL more than what was already paid — EXCEPT when
   * `settledCurrency` does not match `currency` above, where that comparison
   * cannot be made honestly (HIGH-2 / HIGH-2-residual) and this stays `true`
   * purely because the row IS settled and an edit on it always warrants a
   * human look, never derived from the (impossible) cross-currency
   * subtraction.
   */
  needsReconfirm: z.boolean(),
  warnings: z.array(cascadeWarningSchema),
})
export type CascadeDerivativePlan = z.infer<typeof cascadeDerivativePlanSchema>

export const cascadePlanSchema = z.object({
  sourceId: z.string().uuid(),
  /** Whether the proposed amount actually differs from what is stored — the SAME rule as `transactions.service.ts`'s BIZ-18 `amountChanged` (see `amountsDiffer` below). `false` ⇒ `derivatives` is always `[]` ("нет каскада, а не нулевое обязательство" — AC3). */
  sourceAmountChanged: z.boolean(),
  oldSourceAmount: z.number(),
  newSourceAmount: z.number(),
  /**
   * HIGH-2-residual (security-review round 2): the currency `oldSourceAmount`
   * and `newSourceAmount` are denominated in — same rationale as
   * `cascadeDerivativePlanSchema.currency`, at the source-row level.
   */
  sourceCurrency: currencyEnumSchema,
  derivatives: z.array(cascadeDerivativePlanSchema),
  /**
   * MED-1 (security-review round 1) — warnings about the SOURCE row itself
   * (the one being edited), independent of the proposed new amount: it
   * already has a signed invoice, or it already carries `originalAmount`.
   * Present even when `sourceAmountChanged` is `false` — these are static
   * facts about the row, not about the proposed edit.
   */
  sourceWarnings: z.array(cascadeWarningSchema),
  /**
   * task-paid-salary-amount-edit — what happens to the payment fact of an
   * edited PAID salary. Non-null only for a `SALARY` whose `amount` actually
   * moves and which carries `originalAmount`.
   *
   * `recomputed: true` — `newOriginalAmount` is the obligation at the RECORDED
   * rate (`exchangeRate`, unchanged); the write stores exactly this figure.
   * `recomputed: false` — no rate was recorded, the obligation stays as it was
   * and the row stops agreeing with itself (owner decision 2, 2026-09-25); the
   * screen says so instead of quoting a figure.
   *
   * Optional on the wire so a plan built before this field existed still parses.
   */
  sourcePaymentFact: z
    .object({
      originalCurrency: currencyEnumSchema.nullable(),
      exchangeRate: z.string().nullable(),
      oldOriginalAmount: z.number(),
      newOriginalAmount: z.number(),
      recomputed: z.boolean(),
    })
    .nullable()
    .optional(),
})
export type CascadePlan = z.infer<typeof cascadePlanSchema>

// ---------------------------------------------------------------------------
// `GET /transactions/:id/edit-preview` — request/response contract.
// ---------------------------------------------------------------------------

/**
 * Query string: `?amount=<proposed new source amount>`. Same floor/ceiling as
 * a real edit (`adminUpdateTransactionSchema.amount`) — this is a hand-typed
 * figure from the same edit form, just not committed yet. Reuses
 * `moneyFloorAndPrecisionError` directly (not the `withMoneyFloor` helper,
 * whose `T extends z.ZodNumber` generic does not accept a
 * `z.coerce.number()` chain) — same validation, same message, just wired via
 * `.superRefine` the way `withMoneyFloor` itself does internally.
 */
export const cascadeEditPreviewQuerySchema = z.object({
  amount: z.coerce
    .number()
    .positive()
    .max(MAX_TRANSACTION_AMOUNT)
    .superRefine((v, ctx) => {
      const message = moneyFloorAndPrecisionError(v)
      if (message) ctx.addIssue({ code: 'custom', message })
    }),
})
export type CascadeEditPreviewQuery = z.infer<typeof cascadeEditPreviewQuerySchema>

/**
 * task-cascade-apply (task 3, AC13 / addendum §1.12) — the four reasons a
 * PAID row's `amount` is NOT our own record to correct.
 *
 * The rule, stated once: editing `amount` is allowed when `amount` is OUR OWN
 * record of a value that could have been entered wrongly, and forbidden when
 * the number has a SECOND CARRIER that the edit does not move — because then
 * the edit does not correct a record, it sets two of the system's records
 * against each other.
 */
export const cascadeLedgerFactReasonSchema = z.enum([
  /** `original_amount` — `exchange_rate = amount / original_amount` sits beside it. */
  'PAYMENT_FACT_RECORDED',
  /** `settled_amount` — the accumulator of what has actually been paid out. */
  'SETTLED_AMOUNT_RECORDED',
  /** A `pending_obligations` row this transaction closed (either epoch's key). */
  'CLOSES_OBLIGATION',
  /** `COMPANY_DEPOSIT` — the figure was observed on-chain (C4 of the ADR). */
  'ONCHAIN_DEPOSIT',
  /**
   * task-paid-salary-amount-edit (CR-M-1 / COPY-M-5) — NOT a pinned row: a
   * paid salary IS editable, only not to THIS figure, because the obligation
   * it gives at the recorded rate falls outside the storable range. Its own
   * reason so the operator is told «перевірте суму», not sent to a reversing
   * transaction for what is a typo.
   */
  'SALARY_OBLIGATION_OUT_OF_RANGE',
])
export type CascadeLedgerFactReason = z.infer<typeof cascadeLedgerFactReasonSchema>

/**
 * QA-H-2 (manual QA, HIGH) — the two fields a PAID row locks, and why, as
 * api-error CODES (text: `api-errors/finance-invoices.ts`, uk/en).
 *
 * These live here, beside the ledger-fact family, for the reason that family
 * lives here: the SERVER raises them as a 400 and the CLIENT shows them
 * proactively, and a text duplicated across that boundary drifts — so both
 * resolve the SAME catalog entry by code. Each names the CARRIER of the
 * refusal, then the remedy, one sentence, no closing period.
 *
 * COPY-L-5: the currency text explains itself with a fact about the CURRENCY
 * («платіж уже пройшов у цій валюті»), not about the amount — a reader standing
 * at the currency selector was being handed an argument about the neighbouring
 * field. COPY-L-6: one remedy («виправляйте сторнувальною транзакцією») across
 * the family, not two verbs.
 */
export const PAID_ROW_LOCKED_FIELD_ERROR_CODES = {
  /** One PAID non-USDT company-shaped row halts every payout in the system (`assertNoOffCurrencyCompanyRows`). */
  CURRENCY: 'FINANCE_PAID_ROW_CURRENCY_LOCKED',
  /** Keys historical monthly salary aggregates and invoice/reporting context. */
  SALARY_MONTH: 'FINANCE_PAID_ROW_SALARY_MONTH_LOCKED',
} as const satisfies Record<'CURRENCY' | 'SALARY_MONTH', FinanceInvoicesErrorCode>

/**
 * The operator-facing refusal for each ledger-fact reason, as an api-error
 * CODE. The write path's 400 (`apiError(code)`) and the preview's blocked banner
 * (`translateApiError(code)`) are two renderings of ONE catalog entry, so the
 * screen and the refusal cannot drift. Each one names the CARRIER, not merely
 * «не можна» — the operator has to know what the amount is pinned to before
 * they can decide what to do instead.
 *
 * i18n: these were Russian `@crm/shared` string constants
 * (`CASCADE_LEDGER_FACT_MESSAGES`); a text that crosses the server/client
 * boundary is a code + catalog, never a literal. (`PAYMENT_FACT_RECORDED` had
 * already moved: its old text sent the operator to a «документ об оплате» the
 * system does not have.)
 */
export const CASCADE_LEDGER_FACT_ERROR_CODES = {
  PAYMENT_FACT_RECORDED: 'FINANCE_PAYMENT_FACT_AMOUNT_LOCKED',
  // CR-M-1 — «перевірте суму», never a reversing transaction: the salary is
  // editable, only not to this figure.
  SALARY_OBLIGATION_OUT_OF_RANGE: 'FINANCE_SALARY_OBLIGATION_OUT_OF_RANGE',
  // COPY-M-3 (copy-review): these two used to open with the SAME four words
  // while describing different facts — the first has an accumulator of actual
  // transfers behind it, the second IS the closing transaction. «Розрахунок»
  // is the glossary name for a settle (`CONTEXT.md`), so the second names a
  // carrier instead of restating its own label.
  SETTLED_AMOUNT_RECORDED: 'FINANCE_SETTLED_AMOUNT_LOCKED',
  CLOSES_OBLIGATION: 'FINANCE_CLOSING_ROW_AMOUNT_LOCKED',
  ONCHAIN_DEPOSIT: 'FINANCE_ONCHAIN_DEPOSIT_AMOUNT_LOCKED',
} as const satisfies Record<CascadeLedgerFactReason, FinanceInvoicesErrorCode>

/**
 * Why editing is blocked outright.
 *
 * The first two mirror guards 1 and 2 of `adminUpdateTransaction`. The four
 * after them are AC13's ledger-fact refusals (CR-M-1): before they were listed
 * here the preview answered `editable: true` for rows the write refuses, which
 * is exactly the preview-vs-fact divergence the "one resolver, two wrappers"
 * shape exists to prevent — and which would have surfaced as an edit form whose
 * save cannot succeed the moment task 5 renders one.
 *
 * Guard 3 (BIZ-18, the PAID amount lock) is deliberately NOT one of these: this
 * endpoint exists to preview what removing it would do (task 3), so it never
 * blocks on it.
 */
export const cascadeEditPreviewBlockedReasonSchema = z.enum([
  'PAYOUT_FAMILY',
  'LINKED_TO_PAYOUT_REQUEST',
  ...cascadeLedgerFactReasonSchema.options,
])
export type CascadeEditPreviewBlockedReason = z.infer<typeof cascadeEditPreviewBlockedReasonSchema>

export const cascadeEditPreviewResponseSchema = z.object({
  editable: z.boolean(),
  blockedReason: cascadeEditPreviewBlockedReasonSchema.nullable(),
  plan: cascadePlanSchema.nullable(),
  version: z.string().nullable(),
})
export type CascadeEditPreviewResponse = z.infer<typeof cascadeEditPreviewResponseSchema>
