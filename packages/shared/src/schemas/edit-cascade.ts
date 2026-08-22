import { z } from 'zod'
import {
  transactionTypeSchema,
  MAX_TRANSACTION_AMOUNT,
  type PendingObligationStatus,
} from './finance'
import { moneyFloorAndPrecisionError } from './money'
import type { CurrencyEnum } from './payment-requisites'
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
  // AC3 / MED-1 (PR #599) — `settledAmount` was accumulated in a currency
  // other than USDT (a DROP obligation settled in UAH/EUR/USD), so it is not
  // directly comparable to `newAmount`, which is always a USDT share of the
  // USDT income.
  'NON_USDT_CURRENCY',
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
  /** How much of `oldAmount` has already actually been paid out. `0` for a still-`PENDING` obligation. */
  settledAmount: z.number(),
  /** `max(0, newAmount - settledAmount)`, or `null` when `newAmount` is `null`. */
  remainingToPay: z.number().nullable(),
  /** `true` only for an already-settled (`PAID`) obligation whose recomputed share is STILL more than what was already paid. */
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
  derivatives: z.array(cascadeDerivativePlanSchema),
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
): CascadeDerivativePlan {
  const isSettled = derivative.obligation?.status === 'PAID'
  const sharePercent = isSettled ? derivative.settledSharePercent : derivative.sharePercent
  const oldAmount = derivative.obligation?.amount ?? derivative.amount
  const settledAmount = isSettled ? (derivative.settledAmount ?? 0) : 0

  if (sharePercent === null) {
    return {
      id: derivative.id,
      type: derivative.type as CascadeDerivativePlan['type'],
      oldAmount,
      newAmount: null,
      sharePercent: null,
      settledAmount,
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
  // Same MONEY_SCALE-safe rounding as roundShareAmount itself — avoids a
  // stray float tail like 199.99999999999997 in remainingToPay.
  const remainingToPay = Math.max(0, Number((newAmount - settledAmount).toFixed(6)))
  const overpaid = isSettled && newAmount < settledAmount
  const needsReconfirm = isSettled && newAmount > settledAmount

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
  if (isSettled && derivative.settledCurrency && derivative.settledCurrency !== 'USDT') {
    warnings.push({
      code: 'NON_USDT_CURRENCY',
      message: `Выплата по этой строке учтена в ${derivative.settledCurrency}, а не в USDT — «уже выплачено» и «новая доля» не в одной валюте`,
    })
  }

  return {
    id: derivative.id,
    type: derivative.type as CascadeDerivativePlan['type'],
    oldAmount,
    newAmount,
    sharePercent,
    settledAmount,
    remainingToPay,
    needsReconfirm,
    warnings,
  }
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
 */
export function resolveEditCascade(
  snapshot: CascadeSnapshot,
  patch: CascadeEditPatch,
): CascadePlan {
  const { source, derivatives } = snapshot
  const sourceAmountChanged = amountsDiffer(patch.amount, source.amount)

  if (!sourceAmountChanged) {
    return {
      sourceId: source.id,
      sourceAmountChanged: false,
      oldSourceAmount: source.amount,
      newSourceAmount: source.amount,
      derivatives: [],
    }
  }

  return {
    sourceId: source.id,
    sourceAmountChanged: true,
    oldSourceAmount: source.amount,
    newSourceAmount: patch.amount,
    derivatives: derivatives.map((d) => resolveDerivative(d, patch.amount)),
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
