import { HttpStatus } from '@nestjs/common'
import { isNull, sql, type SQL } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { transactions } from '../database/schema'
import { isTxDateLocked } from './finance-predicates.util'
import {
  resolveTransactionDateWithPolicy,
  type ResolvedTransactionDate,
} from './transaction-date-policy'
import { sourceBusinessDay } from './transaction-date.util'

/**
 * The business-date part of `AdminEditService.adminUpdateTransaction`, moved out
 * of the service (CR-M-5) so the date rules read in one place.
 */
export type AdminEditTxDate = {
  /** The stored Kyiv business day, or `null` when the request sent no date. */
  storedBusinessDay: string | null
  /** Only a day that differs from the stored one is a change. */
  changed: boolean
  /** The policy's answer for a changed day; `undefined` when nothing moves. */
  decision: ResolvedTransactionDate | undefined
}

/**
 * The business date moves ONLY `tx_date` — no amount, rate, accumulator or
 * cascade. Change-based like the money guards: the form re-sends the stored day
 * on every save, and a legacy row older than the backdating window must still
 * accept a notes-only edit. Only a day that differs reaches the policy.
 */
export function resolveAdminEditTxDate(
  tx: typeof transactions.$inferSelect,
  data: { txDate?: string | null | undefined; backdateReason?: string | null | undefined },
  role: SessionUser['role'],
): AdminEditTxDate {
  const storedBusinessDay = data.txDate ? sourceBusinessDay(tx) : null
  const changed = !!data.txDate && data.txDate !== storedBusinessDay
  // SR-M-2 / SR-M-3 (owner decision, 2026-11-01): a date is NOT movable on a
  // row whose day is a fact someone else holds. An on-chain-verified
  // payment (claimed `tx_hash`) and a company-account row would drift away
  // from the real transfer day (the block-timestamp clause of D-2 is still
  // unimplemented), and a row that already carries settlements could end up
  // dated AFTER the payments made against it.
  // The predicate is shared with `mapTx`'s `isDateLocked` so the two cannot drift.
  if (changed && isTxDateLocked(tx)) {
    throw apiError('FINANCE_TX_DATE_LOCKED_ROW', HttpStatus.BAD_REQUEST)
  }
  // A scheduled salary is the one PLANNED row; everything else records
  // something that already happened and so cannot be future-dated.
  const decision = changed
    ? resolveTransactionDateWithPolicy(data.txDate, {
        role,
        // Stryker disable next-line StringLiteral: equivalent mutant — `resolveTransactionDateWithPolicy` compares the flow only against 'EXECUTED', so any other string behaves as PLANNED; the PLANNED/EXECUTED split itself is pinned by the PENDING-salary and PAID-salary cases
        flow: tx.type === 'SALARY' && tx.status === 'PENDING' ? 'PLANNED' : 'EXECUTED',
        backdateReason: data.backdateReason,
        // COPY-M-2/M-3: this screen HAS the reason field, so the refusal names it.
        reasonRequiredCode: 'FINANCE_TX_DATE_EDIT_REASON_REQUIRED',
      })
    : undefined
  return { storedBusinessDay, changed, decision }
}

/**
 * SR-M-4: the stored-row lock above cannot see a hash that THIS request claims
 * (a receipt URL set in the same save). Such a request is refused the same way.
 */
export function assertTxDateNotClaimedInRequest(
  txDate: AdminEditTxDate,
  claimHash: string | null,
): void {
  if (txDate.changed && claimHash) {
    throw apiError('FINANCE_TX_DATE_LOCKED_ROW', HttpStatus.BAD_REQUEST)
  }
}

/**
 * SR-M-4 (LOW part): re-assert, in the UPDATE itself, the two lock facts the
 * decision was made on, so a claim or a company-funding that lands between the
 * read and the write cannot be overwritten with a moved day. (`settled_amount`
 * is already bound by the service's own snapshot predicate.)
 */
export function txDateSnapshotPredicates(txDate: AdminEditTxDate): SQL[] {
  return txDate.decision
    ? [
        isNull(transactions.txHash),
        sql`${transactions.fundingSource} IS DISTINCT FROM ${'COMPANY_ACCOUNT'}`,
      ]
    : []
}
