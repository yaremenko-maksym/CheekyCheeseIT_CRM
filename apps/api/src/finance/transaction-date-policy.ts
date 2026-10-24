import { HttpStatus } from '@nestjs/common'
import { kyivDayOf } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { resolveTransactionDate } from './transaction-date.util'

/**
 * SR-809-H-1 = CR-809-M-3 — the ONE server-side policy for an operator-chosen
 * transaction business date.
 *
 * Before this, `transactionBusinessDateSchema` asked only "is this a real
 * calendar day", and `resolveTransactionDate` persisted whatever it was handed.
 * Every writer therefore accepted every date: a SENIOR could declare an income
 * into an already-reported month (`getIncomeComplianceOverview` buckets on
 * `txDate ?? createdAt`, so the project silently reads as "received" for that
 * month), or forward-date the PAYOUT row whose date `invoice-creation.service`
 * stamps onto the invoice — a legal document — with no check against the
 * on-chain transfer time the flow had already verified.
 *
 * Owner decision D-2 (RESOLVED 2026-10-22). Three of its four clauses are
 * implemented here; the fourth is NOT implemented anywhere yet:
 *   - future dates only for PENDING/planned rows — implemented;
 *   - SENIOR/DROP may backdate at most 31 days — implemented;
 *   - ADMIN/ACCOUNTANT may go beyond 31 days only with a mandatory reason,
 *     which is written to the audit log — implemented;
 *   - on-chain-verified flows take the date from the block timestamp —
 *     **NOT implemented**. `submitDeposit` and the payout cascade both pass the
 *     CLIENT's date to this function and persist what it returns. They are
 *     bounded by the rules above, which is strictly better than the unbounded
 *     value #809 shipped, but a bounded client value is still a client value:
 *     on a verified transfer it can misstate the real on-chain settlement day,
 *     and that day is printed on an invoice. See the on-chain section below.
 *
 * ── WHY HERE AND NOT IN THE ZOD SCHEMA ──────────────────────────────────────
 * Two of the three rules depend on the CALLER (which role) and on the FLOW
 * (does this row record something that already happened, or something planned).
 * A Zod schema sees neither, so it cannot express them. What the schema CAN
 * own is the role- and flow-independent part — a real calendar day inside the
 * sane year window — and it still does (`transactionBusinessDateSchema`,
 * re-checked by `parseTransactionBusinessDate` so the two cannot drift).
 *
 * ── WHY THE BUSINESS DAY IS THE KYIV DAY ────────────────────────────────────
 * `kyivDayOf` is the same single definition the date pickers, the NBU rate day
 * and the settle bound already use. Deciding this window on the UTC day instead
 * would reject a date the operator's own picker had just offered them, for the
 * two-to-three hours a day the two calendars disagree (SR-809-L-1). The instant
 * is injected rather than read from `Date.now()` so the window boundary is
 * testable without faking global time.
 */

/**
 * ⚠ THIS POLICY IS NOT YET UNIVERSAL. Read this before assuming a transaction's
 * business date is bounded.
 *
 * Adding a writer? Call this function. Four existing writers still call the
 * unguarded `resolveTransactionDate` directly, so their dates are bounded by
 * nothing but the shared calendar/year schema:
 *
 *   - `transaction-entry.service.ts` — `createExpense`, `createSalary`,
 *     `createAdminTransfer`
 *   - `salary-payment.service.ts`    — `paySalary`
 *
 * Why they are not wired yet (a seam problem, not a design one): both specs mock
 * the `transaction-date.util` MODULE (`vi.mock('./transaction-date.util')`), so
 * moving the seam to this module means rewriting them — including replacing
 * time-relative fixtures with pinned clocks. `createSalary` is additionally the
 * only `PLANNED` flow in the codebase and needs its own future-date case.
 * Tracked as a follow-up task; do not infer from this module's existence that
 * every writer is covered.
 *
 * Covered today (9 call sites): `createSeniorIncome`, `createDropIncome`,
 * `createAdminIncome`, `declareUsdtProjectIncome`, `createPayoutRequest`,
 * `confirmPayout`, `applyPayoutPaidCascade` (both `payPayoutRequest` and
 * `manualConfirmPayout`), `submitDeposit`, `createDividend`.
 *
 * ── THE ONE WRITER THAT DELIBERATELY DOES NOT CALL THIS (CR-M-4) ────────────
 * `PendingSettlementService.settleByCompany` is a 14th writer of
 * `transactions.tx_date` and does NOT route through this function, because its
 * rule is a different rule: a settlement is bounded RELATIVE TO THE ROW IT
 * SETTLES (`sourceDate <= selected <= max(kyivToday(), sourceDate)`), which
 * needs the source row this function never sees. Collapsing the two would mean
 * passing row context into a role/flow policy, or losing the row-relative lower
 * bound — so it keeps its own bound, deliberately.
 *
 * What it does NOT keep is its own copy of the arithmetic: the upper bound is
 * `latestSettleBusinessDay` in `@crm/shared`, called by both the service and the
 * picker's `maxDate`. It was hand-written in both until CR-M-4, which is the
 * duplicated-predicate defect (CR-795-M-7) reappearing inside the change meant
 * to end it.
 *
 * Its residual gap is narrower than the four above: it has no backdating window
 * and no audit reason, so an ADMIN/ACCOUNTANT can date a settlement anywhere
 * between the source day and today without stating why.
 *
 * ── THE ON-CHAIN CLAUSE OF D-2 IS NOT MET ───────────────────────────────────
 * D-2 says an on-chain-verified flow should take its date FROM the verified
 * block timestamp, not merely have a client-supplied date bounded.
 * `payPayoutRequest` and `submitDeposit` are BOUNDED here but still persist the
 * client's value: `DepositVerification` exposes no timestamp and the Etherscan
 * adapter makes no `eth_getBlockByNumber` call. The bound is the floor, not the
 * finished article.
 */

/** Owner decision D-2: how far back a non-privileged role may date a row. */
export const BACKDATE_LIMIT_DAYS = 31

const MS_PER_DAY = 86_400_000

type ActorRole = SessionUser['role']

/**
 * The roles that may date a row beyond the backdating window, and only with a
 * recorded reason. An ALLOWLIST, not a denylist: a role added to the enum later
 * is capped by default rather than silently exempt (the denylist-vs-allowlist
 * trap this repo has already paid for once in junior project masking).
 */
const BACKDATE_EXEMPT_ROLES: ReadonlySet<ActorRole> = new Set<ActorRole>(['ADMIN', 'ACCOUNTANT'])

/**
 * Does this row record something that ALREADY happened, or something planned?
 *
 * `EXECUTED` — a payment, a confirmation, a received income, a deposit, a
 * dividend. Its date cannot be in the future: the event is in the past by
 * construction.
 * `PLANNED` — a PENDING/planned row (a salary scheduled ahead). A future date
 * is the point of it.
 */
export type TransactionDateFlow = 'EXECUTED' | 'PLANNED'

export type TransactionDatePolicy = {
  role: ActorRole
  flow: TransactionDateFlow
  /**
   * Required only to justify dating a row beyond the backdating window, and
   * only for a privileged role. Returned (trimmed) when it was actually
   * consumed, so the call site writes it to the audit log.
   */
  backdateReason?: string | null | undefined
  now?: Date | undefined
}

export type ResolvedTransactionDate = {
  txDate: Date
  /**
   * Non-null ONLY when the policy required and consumed a reason — i.e. this
   * row was dated outside the ordinary window by a privileged role. The audit
   * line therefore means "an out-of-window backdate, justified thus", not
   * merely "a reason field happened to be filled in".
   */
  backdateReason: string | null
}

export function resolveTransactionDateWithPolicy(
  rawTxDate: string | null | undefined,
  policy: TransactionDatePolicy,
): ResolvedTransactionDate {
  const now = policy.now ?? new Date()

  // No chosen date: the row is stamped with the real current instant, exactly as
  // before this policy existed. There is nothing for a window to bound, and the
  // legacy callers that never send a date keep working byte-for-byte.
  if (!rawTxDate) return { txDate: now, backdateReason: null }

  // Parses strictly and enforces the calendar + year window, as a 400.
  const txDate = resolveTransactionDate(rawTxDate, now)

  const today = kyivDayOf(now)

  // Both comparisons are plain `YYYY-MM-DD` string ordering, which is exactly
  // calendar ordering for this format — no timezone arithmetic once we already
  // hold two day keys resolved against the same calendar.
  if (rawTxDate > today && policy.flow === 'EXECUTED') {
    throw apiError('FINANCE_TX_DATE_IN_FUTURE', HttpStatus.BAD_REQUEST)
  }

  // Anchored at NOON, not midnight, deliberately: subtracting whole days from a
  // midnight instant lands within an hour of the day boundary, so a DST shift in
  // the subtracted span can resolve to the neighbouring Kyiv day and move the
  // window edge by one. Noon leaves ~12 hours of slack, which no DST transition
  // approaches. `kyivDayOf` then reads the day off the shifted instant through
  // the IANA database, so the edge is a real calendar day either way.
  const oldestAllowed = kyivDayOf(
    new Date(Date.parse(`${today}T12:00:00.000Z`) - BACKDATE_LIMIT_DAYS * MS_PER_DAY),
  )
  // Inclusive: the oldest day IN the window is allowed.
  if (rawTxDate >= oldestAllowed) return { txDate, backdateReason: null }

  if (!BACKDATE_EXEMPT_ROLES.has(policy.role)) {
    throw apiError('FINANCE_TX_DATE_TOO_OLD', HttpStatus.BAD_REQUEST)
  }

  const reason = policy.backdateReason?.trim()
  if (!reason) {
    throw apiError('FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED', HttpStatus.BAD_REQUEST)
  }

  return { txDate, backdateReason: reason }
}
