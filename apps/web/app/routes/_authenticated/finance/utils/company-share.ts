import type { TransactionDto } from '@crm/shared'
import { fmtAmount } from '../constants'

/**
 * task-company-share-cta — shared calculation/grouping helpers for the
 * company-share payout CTA strip (`CompanySharePayoutStrip`) and the
 * two-step payout modal (`CompanySharePayoutModal`).
 *
 * Both SENIOR_INCOME and DROP_INCOME rows flow through the SAME modal (see
 * design spec §9 — DROP keeps using this flow via InProgressPanel), so the
 * share-percent resolution here is generic across both income types instead
 * of assuming `seniorSharePercent` like the old `PayoutDialog.tsx` did.
 *
 * Default share fallbacks mirror the backend:
 *   - SENIOR: `users.seniorSharePercent` default is 26 (see
 *     `packages/shared/src/schemas/users.ts`).
 *   - DROP: `DEFAULT_DROP_SHARE_PERCENT` = 5
 *     (`apps/api/src/finance/drop-share-resolver.ts`). The frontend
 *     `SessionUser` does not carry `dropSharePercent`, so a DROP caller falls
 *     back to this constant when a legacy row has no per-tx snapshot.
 */

export const DEFAULT_SENIOR_SHARE_PERCENT = 26
export const DEFAULT_DROP_SHARE_PERCENT_FALLBACK = 5

/**
 * A payout_request's `transactions` array (as returned by the backend) is
 * NOT homogeneous — it includes the income rows (SENIOR_INCOME /
 * DROP_INCOME) that were bundled into it AND the PAYOUT ledger row itself
 * (project_id NULL). Any count/group derived from that array MUST filter to
 * income rows FIRST, by role-agnostic type — never assume SENIOR_INCOME only
 * (that undercounts/misses DROP payouts, the same modal's other caller) and
 * never skip the filter (the stray PAYOUT row pollutes counts — regression:
 * fidelity-review finding, project count off-by-one on every payout).
 */
export function isIncomeTransaction(
  t: Pick<TransactionDto, 'type'>,
): t is Pick<TransactionDto, 'type'> & { type: 'SENIOR_INCOME' | 'DROP_INCOME' } {
  return t.type === 'SENIOR_INCOME' || t.type === 'DROP_INCOME'
}

/**
 * task-split-payouts-and-obligations (backlog 174). A transaction genuinely
 * BUNDLED INTO this payout — money the SENIOR/DROP paid IN that financed the
 * outgoing company-share transfer. Requires BOTH the income type AND
 * `payoutRequestId` pointing at THIS payout — the second half matters
 * because `payout.transactions` (as `findPayoutRequest` returns it) also
 * carries "recovered" company-obligation rows that share the SAME income
 * type after `settleByCompany` flips them in place
 * (task-settle-payout-link-lost) but move the OPPOSITE direction of money
 * (COMPANY → recipient, not recipient → COMPANY) — see
 * `isPayoutObligationTransaction` below. `isIncomeTransaction` alone cannot
 * tell the two apart (both are SENIOR_INCOME/DROP_INCOME after the flip);
 * without the `payoutRequestId` check those recovered rows silently inflated
 * "Транзакции в выплате" with money the company OWES, not money that
 * financed the payment.
 */
export function isBundledIncomeTransaction(
  t: Pick<TransactionDto, 'type' | 'payoutRequestId'>,
  payoutId: string,
): t is Pick<TransactionDto, 'type' | 'payoutRequestId'> & {
  type: 'SENIOR_INCOME' | 'DROP_INCOME'
} {
  return isIncomeTransaction(t) && t.payoutRequestId === payoutId
}

/**
 * task-split-payouts-and-obligations (backlog 174). The mirror of
 * `isBundledIncomeTransaction` — a row `findPayoutRequest` recovered via
 * `pending_obligations.payoutRequestId` rather than the transaction's own FK
 * (which `settleByCompany` resets to null on settle, task-settle-in-place
 * ADR 2026-07-14). Represents a COMPANY → senior/drop obligation tied to
 * this payout (still owed, or already settled) — the OPPOSITE money
 * direction from the incomes above, so it renders in its own section and
 * must never fold into the same count. `payoutRequestId !== payoutId` is
 * the discriminator regardless of the row's transaction type or settle
 * status: the live `payoutRequests.transactions` relation only ever returns
 * rows whose own `payoutRequestId` equals this payout's id (the PAYOUT
 * ledger row + the bundled incomes), so anything else in the array is, by
 * construction, a recovered obligation.
 */
export function isPayoutObligationTransaction(
  t: Pick<TransactionDto, 'payoutRequestId'>,
  payoutId: string,
): boolean {
  return t.payoutRequestId !== payoutId
}

/**
 * Company-share preview formula — 1:1 copy of the calculation that lived in
 * `PayoutDialog.tsx` (§4.3 of the design spec). This is a CLIENT-SIDE preview
 * only; the authoritative amount is computed server-side at
 * `createPayoutRequest` time. Do NOT change this formula without a business
 * sign-off — it is the one place in this feature where showing the wrong
 * number (gross income instead of the payable company share) has real
 * financial-confusion consequences for the SENIOR/DROP.
 */
export interface CompanySharePreviewRow {
  tx: TransactionDto
  sharePercent: number
  isApproximate: boolean
  /** Amount the SENIOR/DROP keeps (their share). */
  ownShare: number
  /** Amount payable to CheekyCheeseIT (the company share) — NOT gross income. */
  payable: number
}

/**
 * Resolves the effective share % for a single income row. Prefers the
 * immutable per-transaction snapshot (`seniorSharePercent` for SENIOR_INCOME,
 * `dropSharePercent` for DROP_INCOME); falls back to the caller-supplied
 * default (current user's `seniorSharePercent`, or the DROP constant) for
 * legacy rows that pre-date the snapshot column.
 */
export function resolveSharePercent(
  tx: Pick<TransactionDto, 'type' | 'seniorSharePercent' | 'dropSharePercent'>,
  userSeniorSharePercent: number | undefined,
): { sharePercent: number; isApproximate: boolean } {
  const snapshot = tx.seniorSharePercent ?? tx.dropSharePercent ?? null
  if (snapshot !== null) return { sharePercent: snapshot, isApproximate: false }
  const fallback =
    tx.type === 'DROP_INCOME'
      ? DEFAULT_DROP_SHARE_PERCENT_FALLBACK
      : (userSeniorSharePercent ?? DEFAULT_SENIOR_SHARE_PERCENT)
  return { sharePercent: fallback, isApproximate: true }
}

export function buildPreviewRows(
  txs: TransactionDto[],
  userSeniorSharePercent: number | undefined,
): CompanySharePreviewRow[] {
  return txs.map((tx) => {
    const { sharePercent, isApproximate } = resolveSharePercent(tx, userSeniorSharePercent)
    const amount = parseFloat(tx.amount)
    return {
      tx,
      sharePercent,
      isApproximate,
      ownShare: amount * (sharePercent / 100),
      payable: amount * (1 - sharePercent / 100),
    }
  })
}

/** Sum of `payable` across a set of preview rows — the "к оплате" total. */
export function sumPayable(rows: CompanySharePreviewRow[]): number {
  return rows.reduce((sum, r) => sum + r.payable, 0)
}

// ---------------------------------------------------------------------------
// Project grouping (modal step 1 — §6.1 of the design spec)
// ---------------------------------------------------------------------------

export interface ProjectIncomeGroup {
  projectId: string
  projectName: string
  incomes: TransactionDto[]
}

/**
 * Groups incomes by project, newest-first (ordered by the most recent
 * income's date within each project) — matches the rest of the app's
 * newest-first convention.
 */
export function groupByProject(txs: TransactionDto[]): ProjectIncomeGroup[] {
  const map = new Map<string, ProjectIncomeGroup>()
  for (const tx of txs) {
    const projectId = tx.projectId ?? 'unassigned'
    const projectName = tx.projectName ?? '—'
    const existing = map.get(projectId)
    if (existing) existing.incomes.push(tx)
    else map.set(projectId, { projectId, projectName, incomes: [tx] })
  }
  return [...map.values()].sort((a, b) => {
    const newest = (g: ProjectIncomeGroup) =>
      Math.max(...g.incomes.map((t) => new Date(t.txDate ?? t.createdAt).getTime()))
    return newest(b) - newest(a)
  })
}

// ---------------------------------------------------------------------------
// Banner amount label (§4.5 — single currency vs mixed-currency edge case)
// ---------------------------------------------------------------------------

/**
 * ru-RU plural helper for «N проект / N проекта / N проектов» — same
 * declension pattern as `pluralizeDrops` in `KpiCards.tsx`.
 */
export function pluralizeProjects(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'проектов'
  if (mod10 === 1) return 'проект'
  if (mod10 >= 2 && mod10 <= 4) return 'проекта'
  return 'проектов'
}

/**
 * ru-RU plural helper for «N приход / N прихода / N приходов» — same
 * declension pattern as `pluralizeProjects` above. Used by the step-2
 * summary line («№a1b2c3 · 2 проекта, 4 прихода», fidelity-review finding #2).
 */
export function pluralizeIncomes(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return 'приходов'
  if (mod10 === 1) return 'приход'
  if (mod10 >= 2 && mod10 <= 4) return 'прихода'
  return 'приходов'
}

/**
 * Builds the banner's amount label. Single currency → simple formatted
 * amount. 2-3 currencies → joined per-currency breakdown («820 USDT + 300
 * EUR»). 4+ currencies → a fixed, non-overwhelming placeholder pointing the
 * user at the modal for the exact breakdown (design spec §4.5).
 */
export function buildAmountLabel(byCurrency: Map<string, number>): string {
  const entries = [...byCurrency.entries()]
  if (entries.length === 0) return fmtAmount(0, 'USDT')
  if (entries.length === 1) {
    const [currency, sum] = entries[0]!
    return fmtAmount(sum, currency)
  }
  if (entries.length <= 3) {
    return entries.map(([currency, sum]) => fmtAmount(sum, currency)).join(' + ')
  }
  return '3+ валюты — точная сумма в модалке'
}
