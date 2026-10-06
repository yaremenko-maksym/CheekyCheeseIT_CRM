import { HttpStatus } from '@nestjs/common'

import { MONEY_SCALE, roundShareAmount } from '@crm/shared'
import { apiError } from '../common/api-error'
import { convertToBase, type BalanceCurrency } from './balance.service'
import { DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'
import type { ExchangeRateResult } from './nbu-currency.service'

// Pure drop-distribution math extracted VERBATIM from TransactionsService
// (giant-decomposition leaf T-L2). No DB, no side effects, no logging.

/**
 * Default senior share percent when no per-user override is set (DB default 26).
 * Single source of truth — used in computeDropDistribution, getSeniorSummary,
 * and getSummary to avoid scattering the literal `26` across the service.
 * Re-exported from transactions.service.ts for existing importers.
 */
export const DEFAULT_SENIOR_SHARE_PERCENT = 26

/**
 * Distribute a drop-project's incoming amount across senior, drop, and the
 * two admin partners. Spec §8.1 example for income $1000, senior 26%,
 * drop 5%:
 *   senior: 260, drop: 50, partners: [345, 345].
 *
 * Inputs:
 *   - income — gross amount that landed on the DROP from the client.
 *   - project — drop-project row (must have `dropId !== null` — caller
 *     verifies before invoking). Reserved for future per-project overrides.
 *   - drop — DROP user row (read `dropSharePercent`, default 5).
 *   - senior — SENIOR user row (read `seniorSharePercent`, default 26).
 *
 * Errors:
 *   - Throws `BadRequestException` if senior + drop percents exceed 100.
 *     This is a deliberate guard — the spec keeps both shares additive
 *     against the gross, so >100% is a configuration bug, not a math one.
 *
 * Returns a pure JS object — no DB writes. The caller threads the result
 * into `db.transaction(...)` and inserts one transaction per share.
 */
export function computeDropDistribution(
  income: number,
  _project: { id: string; dropId: string | null },
  drop: { id: string; dropSharePercent: number | null },
  senior: { id: string; seniorSharePercent: number | null },
): {
  seniorShare: { amount: number; percent: number }
  dropShare: { amount: number; percent: number }
} {
  const seniorPercent = senior.seniorSharePercent ?? DEFAULT_SENIOR_SHARE_PERCENT
  const dropPercent = drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT

  if (seniorPercent + dropPercent > 100) {
    throw apiError('FINANCE_SHARES_SUM_EXCEEDS_100', HttpStatus.BAD_REQUEST)
  }

  // Decimal-safe share math (see roundShareAmount) — scale to integer minor
  // units, round once, divide back. Shared with bookCompanyObligations so the
  // admin-USDT obligation amounts match this drop-payout path exactly.
  const seniorAmount = roundShareAmount(income, seniorPercent)
  const dropAmount = roundShareAmount(income, dropPercent)

  // task-drop-payout-company-account: `partnerShares` (the old 50/50
  // remainder split into PAYOUT_ADMIN) is removed. The remainder
  // (income − senior − drop) now stays on the COMPANY account (credited via
  // the PAYOUT row's fundingSource marker); admin income is a deliberate
  // manual DIVIDEND_TO_ADMIN flow, not an auto split. Only the senior and
  // drop slices are returned.
  return {
    seniorShare: { amount: seniorAmount, percent: seniorPercent },
    dropShare: { amount: dropAmount, percent: dropPercent },
  }
}

/**
 * Per-DROP financial aggregate — single source of truth shared by the
 * admin/accountant `getSummary` (full list of every drop) and the
 * self-only `getDropSelfSummary` (one drop). Pure function over already
 * fetched transaction rows — no DB round-trips, no RBAC (callers gate).
 *
 * Drop role - phase 1 (task-drop-1-backend). Extracted from the inline
 * `dropBalances.map(...)` in `getSummary` WITHOUT changing its semantics:
 *   - `balance`             — Σ PAYOUT_DROP received − sent (the slice the
 *                             drop keeps), scaled-integer to avoid float drift.
 *   - `dropSharePercent`    — `drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT`.
 *   - `pendingCount`        — DROP_INCOME rows with `receiverId = drop.id` in
 *                             PENDING|VALIDATED status (the «N ожидают» badge).
 *
 * NEW fields (additive, only consumed by the drop self-summary; the admin
 * summary maps them away so its DTO/tests are unaffected):
 *   - `debtToCompany`       — what the drop still owes the company for
 *                             VALIDATED-but-unsettled incomes.
 *   - `pendingObligationAmount` / `pendingObligationCount` —
 *                             task-drop-sees-own-obligations. The REVERSE
 *                             direction: what the COMPANY owes THIS drop,
 *                             booked but not yet paid out.
 *
 * debtToCompany formula (derived from the DROP_INCOME → company lifecycle,
 * see `validateTransaction` + `PaymentChannelService`):
 *   At DROP_INCOME validation a placeholder PAYOUT row is booked with
 *   `senderId = drop.id`, `status = 'PENDING_PAYMENT'`,
 *   `amount = income × (1 − dropSharePercent/100)`. The drop pays the company
 *   via crypto/cash confirm, which flips that PAYOUT row → 'PAID'. Therefore
 *   the outstanding company debt is exactly the sum of the drop's PAYOUT
 *   rows still in 'PENDING_PAYMENT'. This reads the BOOKED payable directly
 *   (rather than recomputing share math), so it stays correct even if a
 *   future income carries a per-row share override.
 *
 * pendingObligationAmount formula (task-drop-sees-own-obligations — see
 * `bookCompanyObligations`): the admin-USDT declare path and the drop-payout
 * cascade both book a DROP_PENDING_PAYOUT row (`receiverId = drop.id`,
 * `status = 'PENDING_PAYMENT'`) the moment the company recognizes the
 * drop's share is owed. `settleByCompany` (pending-settlement.service.ts)
 * later flips that SAME row IN PLACE to `PAYOUT_DROP`/`PAID` — never a
 * second row — so the outstanding pending-obligation total is exactly the
 * sum of the drop's DROP_PENDING_PAYOUT rows still in 'PENDING_PAYMENT'.
 * Deliberately NOT added into `balance` (§AC2 — accrued ≠ paid).
 */
export function computeDropAggregate(
  drop: { id: string; displayName: string; dropSharePercent: number | null },
  allTxs: Array<{
    type: string
    status: string
    amount: string
    // Audit 2026-06-28 (#4): the row currency is required so the balance is
    // aggregated in a single base. Optional for older callers/stubs that pass
    // USD/USDT-only ledgers; absent → treated as USD (identity). The admin
    // summary + drop self-summary now always pass it.
    currency?: string
    senderId: string | null
    receiverId: string | null
  }>,
  // NBU rate snapshot for the cross-currency → USD conversion. Optional so a
  // single-currency (prod USDT/USD) caller can omit it; convertToBase short-
  // circuits USD/USDT to identity, so omitting rates only affects EUR/UAH rows.
  rates?: ExchangeRateResult,
): {
  userId: string
  displayName: string
  balance: number
  dropSharePercent: number
  pendingCount: number
  debtToCompany: number
  pendingObligationAmount: number
  pendingObligationCount: number
} {
  const paid = allTxs.filter((tx) => tx.status === 'PAID')

  // Audit 2026-06-28 (#4): convert each amount to base (USD) BEFORE scaling so a
  // mixed-currency drop ledger sums coherently. USD/USDT → byte-exact identity.
  //
  // security-review PR #521 round 3 (MED-B): a DROP settle's `amount` is
  // ALWAYS re-converted at the CURRENT rate on every read here — uniformly
  // with every other reader (`getTotalEarned`, `adminBalances.sent` in this
  // same file). An earlier revision pinned a currency-converted settle to
  // its booked `original_amount`/`original_currency` snapshot (USDT) so an
  // already-closed obligation would not drift as NBU rates moved. Per the
  // owner's explicit decision ("везде по сегодняшнему курсу"), that pinning
  // is reverted: the SAME transaction must read as the SAME number
  // everywhere in the app, and every OTHER balance reader already
  // reconverts at today's rate — pinning only this one path made it the
  // odd one out, not the correct one. `original_amount`/`original_currency`
  // stay on the schema as a fact record of what was actually paid (see
  // settleByCompany) — just no longer consulted by aggregation.
  const baseAmount = (tx: { amount: string; currency?: string }): number =>
    rates
      ? convertToBase(
          parseFloat(tx.amount),
          (tx.currency ?? 'USD') as BalanceCurrency,
          'USD',
          rates,
        )
      : parseFloat(tx.amount)

  const receivedScaled = paid
    .filter((tx) => tx.receiverId === drop.id && tx.type === 'PAYOUT_DROP')
    .reduce((sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE), 0)
  const sentScaled = paid
    .filter((tx) => tx.senderId === drop.id && tx.type === 'PAYOUT_DROP')
    .reduce((sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE), 0)

  // pendingCount: DROP_INCOME rows for this drop still awaiting validation.
  // createDropIncome sets receiverId = drop.id (drop is the recipient),
  // senderId = null (external client). HIGH#2 fix: match on receiverId.
  const pendingCount = allTxs.filter(
    (tx) =>
      tx.type === 'DROP_INCOME' &&
      tx.receiverId === drop.id &&
      (tx.status === 'PENDING' || tx.status === 'VALIDATED'),
  ).length

  // debtToCompany: placeholder PAYOUT rows booked at validation that the
  // company-payment step has not yet flipped to PAID. senderId = drop.id.
  const debtScaled = allTxs
    .filter(
      (tx) => tx.type === 'PAYOUT' && tx.senderId === drop.id && tx.status === 'PENDING_PAYMENT',
    )
    .reduce((sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE), 0)

  // task-drop-sees-own-obligations: pendingObligationAmount — DROP_PENDING_PAYOUT
  // rows booked FOR this drop (receiverId = drop.id) that the company has not
  // yet settled (settleByCompany flips the SAME row to PAYOUT_DROP/PAID — see
  // this method's docstring). This is the reverse leg of debtToCompany above.
  const pendingObligationRows = allTxs.filter(
    (tx) =>
      tx.type === 'DROP_PENDING_PAYOUT' &&
      tx.receiverId === drop.id &&
      tx.status === 'PENDING_PAYMENT',
  )
  const pendingObligationScaled = pendingObligationRows.reduce(
    (sum, tx) => sum + Math.round(baseAmount(tx) * MONEY_SCALE),
    0,
  )

  return {
    userId: drop.id,
    displayName: drop.displayName,
    balance: (receivedScaled - sentScaled) / MONEY_SCALE,
    dropSharePercent: drop.dropSharePercent ?? DEFAULT_DROP_SHARE_PERCENT,
    pendingCount,
    debtToCompany: debtScaled / MONEY_SCALE,
    pendingObligationAmount: pendingObligationScaled / MONEY_SCALE,
    pendingObligationCount: pendingObligationRows.length,
  }
}
