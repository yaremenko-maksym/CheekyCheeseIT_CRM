import { z } from 'zod'
import {
  transactionTypeSchema,
  MAX_TRANSACTION_AMOUNT,
  type PendingObligationStatus,
} from './finance'
import { moneyFloorAndPrecisionError } from './money'
import { currencyEnumSchema, type CurrencyEnum } from './payment-requisites'
import { roundShareAmount } from '../utils/money'

/**
 * task-cascade-resolver-preview (task 2 of the paid-transaction-edit-cascade
 * decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
 * AC4 "один резолвер, две обёртки"). This module is the SINGLE description of
 * "what happens to a source income's derivatives when its amount is edited" —
 * `GET /transactions/:id/edit-preview` (this task) and the future
 * `PATCH /transactions/:id` (task 3, under a `SELECT … FOR UPDATE` lock) both
 * call `resolveEditCascade` on a snapshot built by the SAME
 * `loadCascadeSnapshot` query shape. Neither wrapper is allowed to carry its
 * own copy of this arithmetic — see the ADR section for the full argument,
 * and `roundShareAmount` (packages/shared/src/utils/money.ts) for the
 * precedent this repeats one layer up.
 *
 * Everything below is a PURE function: no DB, no network, no `Date.now()`.
 * Same input ⇒ byte-for-byte same output (AC1 of the task file).
 */

// ---------------------------------------------------------------------------
// Snapshot — the resolver's input contract.
//
// Plain TS types, not Zod: this shape never crosses an external boundary by
// itself (it is assembled server-side by `loadCascadeSnapshot` and consumed
// server-side by `resolveEditCascade`), the same convention
// `PendingSettlementService.resolveSource`'s return type already uses for an
// internal read-shape in `apps/api`. Zod schemas below start where the
// output actually crosses the wire (the `GET /edit-preview` response).
// ---------------------------------------------------------------------------

export interface CascadeSourceSnapshot {
  id: string
  /** `transactions.type` — e.g. 'ADMIN_INCOME'. */
  type: string
  /** `transactions.status` at read time. */
  status: string
  amount: number
  currency: CurrencyEnum
  /** Guard 2 (`transactions.service.ts:2947-2949`) — never edited, only read. */
  payoutRequestId: string | null
  /** ISO timestamp — one of the ingredients of `computeCascadeVersion`. */
  updatedAt: string
  /**
   * MED-1 (security-review round 1): does the row BEING EDITED already carry
   * a COUNTERPARTY-signed invoice (`invoice_signatures`)? A cascade source is
   * not always an `ADMIN_INCOME` — after guard 3 is lifted (task 3), any
   * `PAID` row is editable, including a `SALARY` payment that already has its
   * own signed invoice. AC5 §6 of the ADR: silence here is the worst option.
   */
  hasSignedInvoice: boolean
  /**
   * `transactions.original_amount` on the SOURCE row itself — non-null means
   * this row is a fact-of-payment record (`paySalary` / a currency-converted
   * settle), not our own estimate (C2 of the ADR). AC5 §5: editing `amount`
   * here would desync `exchangeRate = amount / originalAmount` without
   * anyone noticing.
   */
  originalAmount: number | null
}

export interface CascadeObligationSnapshot {
  id: string
  status: PendingObligationStatus
  /** `pending_obligations.amount` — the obligation's own figure, always in `USDT` (booked that way — see `bookCompanyObligations`). */
  amount: number
  updatedAt: string
}

export interface CascadeDerivativeSnapshot {
  id: string
  /** e.g. 'SENIOR_PENDING_PAYOUT' / 'DROP_PENDING_PAYOUT' (still open) or 'SENIOR_INCOME' / 'PAYOUT_DROP' (flipped by settle). */
  type: string
  status: string
  /** `transactions.amount` on the derivative row AS STORED TODAY. */
  amount: number
  currency: CurrencyEnum
  updatedAt: string
  /**
   * The share-percent snapshot the resolver is ALLOWED to recompute from —
   * `seniorSharePercent`/`dropSharePercent` while the row is still
   * `PENDING_PAYMENT`, or `null` once `settleByCompany` has nulled them on
   * the flip (see `settledSharePercent` below for where that value moves
   * to). Never the LIVE resolver (`resolveSeniorShare`/`resolveDropShare`) —
   * AC5 §4 forbids that unconditionally.
   */
  sharePercent: number | null
  /**
   * `transactions.settled_amount` — the monotonic "already paid" accumulator
   * written by `settleByCompany` (task 1, PR #599). `null` on a row that has
   * never gone through a settle.
   */
  settledAmount: number | null
  /** `transactions.settled_currency` — the currency `settledAmount` is denominated in. `null` alongside `settledAmount`. */
  settledCurrency: CurrencyEnum | null
  /** `transactions.settled_share_percent` — the percent snapshot taken the moment settle nulled `sharePercent` above. */
  settledSharePercent: number | null
  /** Does this row's invoice already carry a `COUNTERPARTY` signature? (`invoice_signatures`, `signer_role='COUNTERPARTY'`.) */
  hasSignedInvoice: boolean
  /** The `pending_obligations` row this derivative booked, if any (always present for a real L1/L2 derivative — nullable defensively). */
  obligation: CascadeObligationSnapshot | null
}

export interface CascadeSnapshot {
  source: CascadeSourceSnapshot
  derivatives: CascadeDerivativeSnapshot[]
}

/** What the ADMIN is proposing to change the source row's `amount` to. */
export interface CascadeEditPatch {
  amount: number
}

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
])
export type CascadeWarningCode = z.infer<typeof cascadeWarningCodeSchema>

export const cascadeWarningSchema = z.object({
  code: cascadeWarningCodeSchema,
  message: z.string(),
})
export type CascadeWarning = z.infer<typeof cascadeWarningSchema>

export const cascadeDerivativePlanSchema = z.object({
  id: z.string().uuid(),
  type: transactionTypeSchema,
  /** Current stored amount — `pending_obligations.amount` when an obligation exists (always USDT), else the derivative row's own `amount`. */
  oldAmount: z.number(),
  /** `roundShareAmount(newSourceAmount, sharePercent)`, or `null` when `sharePercent` is `null` (NO_SHARE_SNAPSHOT). */
  newAmount: z.number().nullable(),
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
})
export type CascadePlan = z.infer<typeof cascadePlanSchema>

// ---------------------------------------------------------------------------
// The resolver.
// ---------------------------------------------------------------------------

/**
 * The SAME float-safe equality `adminUpdateTransaction`'s BIZ-18 guard uses
 * (`apps/api/src/finance/transactions.service.ts:2970-2971`) and
 * `settleByCompany`'s post-claim TOCTOU re-check
 * (`apps/api/src/finance/pending-settlement.service.ts:870`) — DB
 * `numeric(15,6)` round-trips through a string, so two values that print
 * identically at 6 decimals ARE the same money value even when the raw
 * floats differ by an epsilon. AC4 requires this comparison be REUSED, not
 * re-described a third time — this is the shared description; the two
 * `apps/api` call sites above are untouched by this task (out of scope —
 * see the task file) but express the identical rule.
 */
export function amountsDiffer(a: number, b: number): boolean {
  return Number(a).toFixed(6) !== Number(b).toFixed(6)
}

function resolveDerivative(
  derivative: CascadeDerivativeSnapshot,
  newSourceAmount: number,
  sourceCurrency: CurrencyEnum,
): CascadeDerivativePlan {
  const isSettled = derivative.obligation?.status === 'PAID'
  const sharePercent = isSettled ? derivative.settledSharePercent : derivative.sharePercent
  const oldAmount = derivative.obligation?.amount ?? derivative.amount
  // HIGH-1 (security-review round 1): `settled_amount` is the MONOTONIC
  // accumulator (task 1, PR #599) — read it UNCONDITIONALLY, never gated by
  // the obligation's CURRENT status. AC3 of the ADR: a cascade revert
  // (task 3, "Механика возврата производной в PENDING") flips
  // `pending_obligations.status` back to `PENDING` while leaving
  // `settled_amount` untouched (point 3: "накопитель не перезаписывается").
  // Gating on `isSettled` here made the plan report `0` for a row that was
  // already partially paid — presenting the FULL obligation for repayment
  // instead of the real difference, and silently erasing task 1's whole
  // point. Obligation status is used ONLY where the question genuinely IS
  // about status (`sharePercent` above — settle nulls the LIVE column;
  // `needsReconfirm` below) — never to decide whether money that was
  // actually paid still counts.
  const settledAmount = derivative.settledAmount ?? 0
  const settledCurrency = derivative.settledCurrency

  if (sharePercent === null) {
    return {
      id: derivative.id,
      type: derivative.type as CascadeDerivativePlan['type'],
      oldAmount,
      newAmount: null,
      sharePercent: null,
      currency: sourceCurrency,
      settledAmount,
      settledCurrency,
      remainingToPay: null,
      needsReconfirm: false,
      warnings: [
        {
          code: 'NO_SHARE_SNAPSHOT',
          message:
            'Нет снимка процента доли на этой строке — пересчитать невозможно, требуется ручное решение',
        },
      ],
    }
  }

  const newAmount = roundShareAmount(newSourceAmount, sharePercent)

  // HIGH-2 (security-review round 1) + HIGH-2-residual (round 2): `newAmount`
  // is always a share of `newSourceAmount`, expressed in the SOURCE's OWN
  // currency (`sourceCurrency`), but on a DROP-branch row `settledAmount`
  // can be denominated in the PAYMENT currency — `settleByCompany` converts
  // and stamps `settled_currency` (pending-settlement.service.ts).
  // Subtracting one from the other when they are not the same unit is not
  // an approximation, it is a wrong number — a drop obligation closed in
  // UAH puts ~2000 into the accumulator and would call almost any edit an
  // overpayment. The resolver is pure and has no exchange rate, and must
  // not invent one: when currencies disagree it refuses to manufacture
  // `remainingToPay` or an overpayment verdict from that subtraction, and
  // leaves `needsReconfirm` to the one thing that IS a genuine status
  // question (is this row currently settled at all) rather than the broken
  // comparison. The plan still hands back BOTH figures with their own
  // currencies (`settledAmount`/`settledCurrency` here, `newAmount`/
  // `oldAmount` tagged with `currency` above) plus the `NON_USDT_CURRENCY`
  // warning below, so a human in task 5 sees "выплачено 2000 UAH, новая
  // доля 50 USDT" instead of a fabricated difference.
  //
  // Round 2 fixed TWO things in this single condition, not one:
  //  1. Comparison target is `sourceCurrency` (read off the snapshot,
  //     `CascadeSourceSnapshot.currency` via `resolveEditCascade`), never a
  //     hardcoded `'USDT'` literal — today they always coincide
  //     (`declareUsdtProjectIncome` always books `currency: 'USDT'`), but
  //     that coincidence is an invariant task 3 is explicitly allowed to
  //     lift (BIZ-18), not a fact this pure function may assume.
  //  2. The `settledCurrency !== null` guard round 1 had is GONE (LOW,
  //     round 2): `null !== sourceCurrency` is `true` for every real
  //     currency, so a `settledAmount > 0` row whose currency was never
  //     recorded is now treated the same as an outright mismatch — "unknown"
  //     is not "assume it matches", the same refusal-to-guess principle
  //     `NO_SHARE_SNAPSHOT` above already applies. Unreachable today (a
  //     settle always stamps `settled_amount`/`settled_currency` together),
  //     kept correct anyway so a future write path cannot silently violate it.
  const currencyMismatch = settledAmount > 0 && settledCurrency !== sourceCurrency

  // Same MONEY_SCALE-safe rounding as roundShareAmount itself — avoids a
  // stray float tail like 199.99999999999997 in remainingToPay.
  const remainingToPay = currencyMismatch
    ? null
    : Math.max(0, Number((newAmount - settledAmount).toFixed(6)))
  // MED-A (security-review round 2): AC3 defines "переплата" purely through
  // the MONOTONIC `settledAmount` accumulator — the exact same principle
  // HIGH-1 (round 1) already established for reading that accumulator at
  // all. Gating this on `isSettled` (the obligation's CURRENT status) meant
  // a cascade revert (task 3, "Механика возврата производной в PENDING")
  // could leave a PENDING row holding a nonzero accumulator, and a further
  // edit dropping the recomputed share below it produced NO overpayment
  // warning — silently losing exactly the money HIGH-1 made visible in
  // `settledAmount` one field over. Money already paid out does not stop
  // being paid out because the row's status flipped back.
  const overpaid = !currencyMismatch && settledAmount > 0 && newAmount < settledAmount
  const needsReconfirm = currencyMismatch ? isSettled : isSettled && newAmount > settledAmount

  const warnings: CascadeWarning[] = []
  if (overpaid) {
    warnings.push({
      code: 'OVERPAYMENT',
      message: `Уже выплачено ${settledAmount} — пересчитанная доля ${newAmount} меньше выплаченного, строка остаётся оплаченной`,
    })
  }
  if (derivative.hasSignedInvoice) {
    warnings.push({
      code: 'SIGNED_INVOICE',
      message:
        'По этой строке инвойс уже подписан контрагентом — правка не отразится в подписанном документе',
    })
  }
  if (currencyMismatch) {
    warnings.push({
      code: 'NON_USDT_CURRENCY',
      message:
        settledCurrency === null
          ? `Валюта уже выплаченной суммы (${settledAmount}) не зафиксирована — сравнить с новой долей в ${sourceCurrency} нельзя`
          : `Выплата по этой строке учтена в ${settledCurrency}, а не в ${sourceCurrency} — «уже выплачено» и «новая доля» не в одной валюте`,
    })
  }

  return {
    id: derivative.id,
    type: derivative.type as CascadeDerivativePlan['type'],
    oldAmount,
    newAmount,
    sharePercent,
    currency: sourceCurrency,
    settledAmount,
    settledCurrency,
    remainingToPay,
    needsReconfirm,
    warnings,
  }
}

/**
 * MED-1 (security-review round 1) — warnings about the SOURCE row itself
 * (the row `GET /edit-preview` was called ON), independent of the proposed
 * new amount. AC5 §5/§6 of the ADR: a `PAID` row that is NOT an
 * `ADMIN_INCOME` (a `SALARY` payment, notably) can itself already carry
 * `originalAmount` or a counterparty-signed invoice — the same two "snapshot
 * by design" concerns (C2/C3) the derivative-level warnings already cover,
 * just on the row being edited rather than on what it produced.
 */
function resolveSourceWarnings(source: CascadeSourceSnapshot): CascadeWarning[] {
  const warnings: CascadeWarning[] = []
  if (source.originalAmount !== null) {
    warnings.push({
      code: 'SOURCE_ORIGINAL_AMOUNT_SET',
      message: `На этой строке уже зафиксирован факт платежа (originalAmount = ${source.originalAmount}) — правка суммы разойдётся с курсом и фактическим платежом, исправляйте документ об оплате`,
    })
  }
  if (source.hasSignedInvoice) {
    warnings.push({
      code: 'SOURCE_SIGNED_INVOICE',
      message:
        'По этой строке уже есть инвойс, подписанный контрагентом — правка суммы не отразится в подписанном документе',
    })
  }
  return warnings
}

/**
 * `resolveEditCascade(snapshot, patch) -> CascadePlan` — the resolver itself.
 * See the module doc for why it must stay pure and why both `GET
 * /edit-preview` and the future `PATCH` are required to call THIS function
 * on a snapshot shaped by `loadCascadeSnapshot`, never re-derive the
 * arithmetic locally.
 *
 * `sourceAmountChanged === false` (patch equals the stored amount, AC4/AC3
 * idempotency point 1) always yields an EMPTY `derivatives` list — "дельта
 * == 0 трактуется как отсутствие каскада, а не нулевое обязательство".
 * `sourceWarnings` is populated in BOTH branches — it describes the row as
 * it stands today, not the proposed edit.
 */
export function resolveEditCascade(
  snapshot: CascadeSnapshot,
  patch: CascadeEditPatch,
): CascadePlan {
  const { source, derivatives } = snapshot
  const sourceAmountChanged = amountsDiffer(patch.amount, source.amount)
  const sourceWarnings = resolveSourceWarnings(source)

  if (!sourceAmountChanged) {
    return {
      sourceId: source.id,
      sourceAmountChanged: false,
      oldSourceAmount: source.amount,
      newSourceAmount: source.amount,
      sourceCurrency: source.currency,
      derivatives: [],
      sourceWarnings,
    }
  }

  return {
    sourceId: source.id,
    sourceAmountChanged: true,
    oldSourceAmount: source.amount,
    newSourceAmount: patch.amount,
    sourceCurrency: source.currency,
    derivatives: derivatives.map((d) => resolveDerivative(d, patch.amount, source.currency)),
    sourceWarnings,
  }
}

/**
 * Deterministic, comparable "version" of a cascade snapshot — the
 * optimistic-locking token `GET /edit-preview` hands back (AC5 of the task
 * file). The future `PATCH` (task 3) re-derives this SAME string from a
 * freshly `SELECT … FOR UPDATE`-locked read and refuses to apply the plan on
 * a mismatch ("отказ с просьбой обновить предпросмотр, а не молчаливый
 * пересчёт" — ADR AC4). Built purely from ids + `updatedAt` timestamps
 * already on the snapshot: no hashing needed, string equality is enough, and
 * it works identically in Node and the browser (`@crm/shared` runs in both).
 */
export function computeCascadeVersion(snapshot: CascadeSnapshot): string {
  const derivativeParts = snapshot.derivatives
    .map(
      (d) =>
        `${d.id}:${d.updatedAt}:${d.obligation ? `${d.obligation.id}:${d.obligation.updatedAt}` : '-'}`,
    )
    .sort()
  return [`src:${snapshot.source.id}:${snapshot.source.updatedAt}`, ...derivativeParts].join('|')
}

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

/** Why editing is blocked outright — mirrors guards 1 and 2 of `adminUpdateTransaction` (`transactions.service.ts:2944-2949`). Guard 3 (BIZ-18, the PAID amount lock) is deliberately NOT one of these: this endpoint exists to preview what removing it would do (task 3), so it never blocks on it. */
export const cascadeEditPreviewBlockedReasonSchema = z.enum([
  'PAYOUT_FAMILY',
  'LINKED_TO_PAYOUT_REQUEST',
])
export type CascadeEditPreviewBlockedReason = z.infer<typeof cascadeEditPreviewBlockedReasonSchema>

export const cascadeEditPreviewResponseSchema = z.object({
  editable: z.boolean(),
  blockedReason: cascadeEditPreviewBlockedReasonSchema.nullable(),
  plan: cascadePlanSchema.nullable(),
  version: z.string().nullable(),
})
export type CascadeEditPreviewResponse = z.infer<typeof cascadeEditPreviewResponseSchema>
