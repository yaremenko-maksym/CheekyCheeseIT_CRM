import { HttpStatus } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { projects, users } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { bookCompanyObligations } from './company-obligations.util'
import { computeDropDistribution } from './drop-distribution.util'
import { resolveDropShare } from './drop-share-resolver'
import { resolveSeniorShareSnapshot } from './senior-share-snapshot.util'

// Drop-project branch of PayoutSettlementService.applyPayoutPaidCascade,
// extracted VERBATIM (pure move). It runs INSIDE the caller's existing
// `db.transaction` — `dbtx` is that transaction; no new transaction is opened.

/** Linked income row shape the cascade re-fetches (only the fields read here). */
export interface PaidIncomeTx {
  id: string
  projectId: string | null
  type: string
  dropSharePercent: number | null
  dropSharePercentSource: string | null
}

/**
 * Drop role - phase 2 (AC3). Resolve whether the linked SENIOR_INCOMEs
 * belong to a drop-project. Senior-projects (project.dropId === null)
 * keep the legacy 50/50 split untouched — this is the regression-safe
 * path (nothing is written). Drop-projects book the senior + drop
 * pending IOUs via `bookCompanyObligations`.
 *
 * `db` is the BASE connection (needed by `resolveSeniorShareSnapshot`, which
 * reads committed team memberships); `dbtx` is the caller's open transaction.
 */
export async function applyDropProjectPayout(
  dbtx: DrizzleTx,
  db: DatabaseService['db'],
  req: { incomeAmount: string },
  paidIncomeTxs: PaidIncomeTx[],
  currentUser: SessionUser,
  requestId: string,
  paymentTxDate: Date | undefined,
): Promise<void> {
  // The payout_request groups SENIOR_INCOMEs by senior; in the current
  // model all of them target the same senior, but they may span multiple
  // projects. We treat the FIRST linked SENIOR_INCOME's project as the
  // "primary" project for drop-vs-senior routing. The standing UX is "a
  // payout = one project" — see PayoutDetailDialog header — so this
  // assumption matches what the SENIOR sees.
  const primaryProjectId = paidIncomeTxs[0]?.projectId ?? null
  const primaryProject = primaryProjectId
    ? await dbtx.query.projects.findFirst({
        where: eq(projects.id, primaryProjectId),
      })
    : null

  const dropUser = primaryProject?.dropId
    ? await dbtx.query.users.findFirst({
        where: eq(users.id, primaryProject.dropId),
      })
    : null

  if (dropUser && primaryProject) {
    // Drop-project branch.
    //
    // Distribution is computed on the GROSS income, not on `payable`.
    // `payable` is `income * (1 - dropShare/100)` here (validateTransaction
    // recorded this when flipping DROP_INCOME→VALIDATED on a drop-project),
    // and represents what the drop transfers off-platform — the residual
    // for partners after the drop keeps their slice. In the senior-project
    // path the same `payable` field means something different (income *
    // (1 - seniorShare/100)) — context is the project, not the column.
    //
    // The SENIOR share is computed on GROSS, not on payable, so we read
    // the senior from the project (not from `req.seniorId` — that field
    // points at the wallet owner, which is the DROP in this flow).
    const senior = primaryProject.seniorId
      ? await dbtx.query.users.findFirst({
          where: eq(users.id, primaryProject.seniorId),
        })
      : null
    if (!senior) throw apiError('FINANCE_SENIOR_NOT_FOUND_ON_DROP_PROJECT', HttpStatus.NOT_FOUND)

    // task-team-senior-share-override. Resolve the senior share WITH its
    // source (PROJECT / TEAM / USER_DEFAULT) so the SENIOR_PENDING_PAYOUT
    // + obligation carry the same snapshot the money trail used — keeps the
    // source badge consistent across the ledger. This reads team
    // memberships on the base connection (committed data), safe mid-txn.
    const seniorShareSnapshot = await resolveSeniorShareSnapshot(
      db,
      { seniorSharePercentOverride: primaryProject.seniorSharePercentOverride },
      { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
    )

    const income = parseFloat(req.incomeAmount)
    // task-drop-share-override-and-receiver (Part A). Drop share for the
    // distribution comes from the per-income snapshot (deterministic —
    // matches what was stamped on the DROP_INCOME), falling back to the
    // override-aware resolver for legacy rows created before the snapshot
    // column existed. The "one payout = one project" rule for DROP callers
    // guarantees a single project/override applies to the whole batch.
    //
    // task-drop-share-pending-parity: kept as a {value, source} pair (not a
    // bare number) — this is the EXACT shape bookCompanyObligations' `drop`
    // param expects (identical to declareUsdtProjectIncome's dropSnapshot),
    // so the booked DROP_PENDING_PAYOUT carries the same source badge a
    // fresh admin-USDT IOU would.
    const dropShareSnapshot: { value: number; source: 'PROJECT' | 'USER_DEFAULT' } =
      // Stryker disable next-line OptionalChaining: equivalent — this branch is only entered when primaryProject exists, which requires paidIncomeTxs[0]?.projectId to be truthy, so paidIncomeTxs[0] is always defined here.
      paidIncomeTxs[0]?.dropSharePercent != null
        ? {
            value: paidIncomeTxs[0].dropSharePercent,
            source:
              paidIncomeTxs[0].dropSharePercentSource === 'PROJECT' ? 'PROJECT' : 'USER_DEFAULT',
          }
        : resolveDropShare(
            { dropSharePercentOverride: primaryProject.dropSharePercentOverride },
            { dropSharePercent: dropUser.dropSharePercent },
          )
    // computeDropDistribution is PURE (no DB) — safe inside the txn. Kept
    // here ONLY for its "senior% + drop% > 100" guard (unchanged
    // regression); the actual share AMOUNTS below now come from
    // bookCompanyObligations (roundShareAmount on the SAME snapshot), so
    // both stay pinned to identical numbers — see roundShareAmount's own
    // docstring ("shared by computeDropDistribution ... and
    // bookCompanyObligations ... so both price shares identically").
    computeDropDistribution(
      income,
      // Stryker disable next-line ObjectLiteral: equivalent — computeDropDistribution never reads its second parameter (named `_project`), so its contents are unobservable.
      { id: primaryProject.id, dropId: primaryProject.dropId },
      { id: dropUser.id, dropSharePercent: dropShareSnapshot.value },
      { id: senior.id, seniorSharePercent: seniorShareSnapshot.value },
    )

    // task-drop-share-pending-parity: the drop's slice is NO LONGER a
    // direct PAID PAYOUT_DROP insert (that bypassed the owner's
    // "pending until confirmed with a receipt + sender account" rule —
    // see the task doc). It now goes through the SAME
    // bookCompanyObligations() call as the senior share (and as
    // declareUsdtProjectIncome's admin-USDT path): a DROP_PENDING_PAYOUT
    // (PENDING_PAYMENT) + a paired pending_obligations row (creditor=drop,
    // debtorType=COMPANY). An ADMIN/ACCOUNTANT later closes it via the
    // EXISTING settleByCompany (mandatory receipt + funding-source choice),
    // which flips this SAME row to PAYOUT_DROP/PAID in place — byte-shape
    // identical to a freshly-booked admin-USDT drop IOU (task doc §2/§3).
    //
    // Senior IOU is skipped when the senior is an ADMIN (never owed via a
    // company IOU — task-drop-share-override-and-receiver D4); drop IOU has
    // no such skip (a drop is never an ADMIN — RBAC-distinct role).
    await bookCompanyObligations(dbtx, {
      incomeAmount: income,
      projectId: primaryProject.id,
      companyName: primaryProject.companyName,
      createdBy: currentUser.id,
      payoutRequestId: requestId,
      txDate: paymentTxDate,
      senior: { id: senior.id, role: senior.role, shareSnapshot: seniorShareSnapshot },
      drop: { id: dropUser.id, shareSnapshot: dropShareSnapshot },
      notePrefix: 'Drop payout',
    })
  }
  // Senior-project branch: nothing else to write. The PAYOUT row (flipped
  // PAID + fundingSource credit marker in the caller) is the entire settlement —
  // no partner-split rows.
}
