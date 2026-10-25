import { COMPANY_ACCOUNT_LABEL, roundShareAmount } from '@crm/shared'
import { pendingObligations, transactions } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { resolveTransactionDate } from './transaction-date.util'

/**
 * task-drop-share-override-and-receiver (D4). Book the company's obligations to
 * the project's senior and/or drop after project income lands somewhere other
 * than their own balance (admin-declared USDT income, or the senior slice of a
 * drop payout). Each obligation is a visible PENDING_PAYMENT IOU row PLUS a
 * pending_obligations row (creditor=<senior|drop>, debtorType='COMPANY',
 * sourceTransactionId=IOU), later closed via settleByCompany.
 *
 * Shared by BOTH the drop-payout cascade (task-drop-share-pending-parity:
 * since PR #443, BOTH the senior AND the drop IOU are booked here — the
 * drop's own slice is no longer paid directly via an instant PAYOUT_DROP)
 * and declareUsdtProjectIncome (both IOUs), so the IOU row shape never
 * drifts between the two booking paths.
 *
 *   - Senior IOU: booked only when a senior is supplied AND `senior.role !==
 *     'ADMIN'` (an admin partner is never owed via a company IOU).
 *   - Drop IOU:   booked only when a drop is supplied (project.dropId != null).
 *
 * Amounts are gross × effective share, rounded via `roundShareAmount` so they
 * match `computeDropDistribution` exactly. MUST run inside the caller's
 * `db.transaction` (dbtx) so income + obligations commit atomically
 * (anti-BIZ-02: never an income row without its obligations).
 */
export async function bookCompanyObligations(
  dbtx: DrizzleTx,
  params: {
    incomeAmount: number
    projectId: string
    // task-drop-sees-own-obligations (security-review PR #523 round 1,
    // MED-4). `projects.companyName` AT BOOKING TIME — both callers
    // already have the project row loaded (they need `dropId`/`seniorId`
    // off it), so this is a pass-through, not an extra query. Stamped onto
    // `companyNameSnapshot` below so a later project rename can never
    // rewrite what a senior/drop reads as the history of money already
    // booked under the old name (see that column's doc in schema.ts).
    companyName: string
    createdBy: string
    payoutRequestId?: string | null
    txDate?: Date | undefined
    // task-admin-income-drop-backfill: the income transaction this booking
    // was caused by, when the caller knows it — see the column comment on
    // `transactions.sourceIncomeTransactionId` in schema.ts for the full
    // reasoning (declareUsdtProjectIncome always passes it; the payout
    // cascade deliberately does not — no single source income to name).
    incomeTransactionId?: string | null
    senior?: {
      id: string
      role: string
      shareSnapshot: { value: number; source: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' }
    } | null
    drop?: {
      id: string
      shareSnapshot: { value: number; source: 'PROJECT' | 'USER_DEFAULT' }
    } | null
    notePrefix?: string
  },
): Promise<{ seniorAmount: number | null; dropAmount: number | null }> {
  const { incomeAmount, projectId, companyName, createdBy, payoutRequestId, senior, drop } = params
  const incomeTransactionId = params.incomeTransactionId ?? null
  const notePrefix = params.notePrefix ?? 'Company owes'
  // SR-H-1 (PR #1158): never leave tx_date NULL. Without a caller date, the IOU is dated with
  // the Kyiv business day of now, the same fallback every other transaction writer uses.
  const txDate = params.txDate ?? resolveTransactionDate(null)
  let seniorAmount: number | null = null
  let dropAmount: number | null = null

  // Senior IOU — never for an ADMIN partner.
  if (senior && senior.role !== 'ADMIN') {
    seniorAmount = roundShareAmount(incomeAmount, senior.shareSnapshot.value)
    const [pendingRow] = await dbtx
      .insert(transactions)
      .values({
        type: 'SENIOR_PENDING_PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: String(seniorAmount),
        currency: 'USDT',
        senderLabel: COMPANY_ACCOUNT_LABEL,
        receiverId: senior.id,
        recipientId: senior.id,
        projectId,
        payoutRequestId: payoutRequestId ?? null,
        seniorSharePercent: senior.shareSnapshot.value,
        seniorSharePercentSource: senior.shareSnapshot.source,
        notes: `${notePrefix} — senior IOU (debtor=COMPANY)`,
        createdBy,
        sourceIncomeTransactionId: incomeTransactionId,
        companyNameSnapshot: companyName,
        txDate,
      })
      .returning()
    if (pendingRow) {
      await dbtx.insert(pendingObligations).values({
        creditorUserId: senior.id,
        debtorType: 'COMPANY',
        debtorUserId: null,
        sourceTransactionId: pendingRow.id,
        amount: String(seniorAmount),
        currency: 'USDT',
        status: 'PENDING',
        // task-settle-payout-link-lost (backlog 74/B-1): same payoutRequestId
        // the source IOU row gets — this column SURVIVES settleByCompany's
        // reset of `transactions.payoutRequestId` on the flip (see the column
        // comment in schema.ts), so a payout's detail read can still resolve
        // this obligation after it is settled.
        payoutRequestId: payoutRequestId ?? null,
      })
    }
  }

  // Drop IOU — only when the project has a drop bound.
  if (drop) {
    dropAmount = roundShareAmount(incomeAmount, drop.shareSnapshot.value)
    const [pendingRow] = await dbtx
      .insert(transactions)
      .values({
        type: 'DROP_PENDING_PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: String(dropAmount),
        currency: 'USDT',
        senderLabel: COMPANY_ACCOUNT_LABEL,
        receiverId: drop.id,
        recipientId: drop.id,
        projectId,
        payoutRequestId: payoutRequestId ?? null,
        // security-review PR #443 (MED-B): a positive, permanent origin
        // marker — true ⟺ this call came from the drop-payout cascade
        // (applyPayoutPaidCascade passes payoutRequestId; the admin-USDT
        // declaration path, declareUsdtProjectIncome, never does). Captured
        // HERE from the caller's intent, not derived later from
        // payoutRequestId's live FK value — see the column comment in
        // schema.ts for why that distinction matters (ON DELETE SET NULL).
        dropCascadeOrigin: payoutRequestId != null,
        dropSharePercent: drop.shareSnapshot.value,
        dropSharePercentSource: drop.shareSnapshot.source,
        notes: `${notePrefix} — drop IOU (debtor=COMPANY)`,
        createdBy,
        sourceIncomeTransactionId: incomeTransactionId,
        companyNameSnapshot: companyName,
        txDate,
      })
      .returning()
    if (pendingRow) {
      await dbtx.insert(pendingObligations).values({
        creditorUserId: drop.id,
        debtorType: 'COMPANY',
        debtorUserId: null,
        sourceTransactionId: pendingRow.id,
        amount: String(dropAmount),
        currency: 'USDT',
        status: 'PENDING',
        // task-settle-payout-link-lost: see the matching comment on the
        // senior branch above — same reasoning, same source value.
        payoutRequestId: payoutRequestId ?? null,
      })
    }
  }

  return { seniorAmount, dropAmount }
}
