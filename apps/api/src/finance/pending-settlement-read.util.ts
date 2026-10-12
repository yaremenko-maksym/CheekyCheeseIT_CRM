/**
 * Read helpers for PendingSettlementService (giant decomposition, L3).
 *
 * Pure READS taking an explicit `db`. `loadObligation` and `resolveSource` are
 * deliberately PRE-TRANSACTION reads (called by `settleByCompany` OUTSIDE its
 * `db.transaction`): their TOCTOU story rests on the
 * `uq_pending_obligations_source_pending` partial index, the
 * `status='PENDING_PAYMENT'` flip guard and the accumulator
 * `IS NOT DISTINCT FROM` re-assert inside the transaction. Callers MUST keep
 * them pre-transaction — passing a transaction handle here would change that.
 */
import { HttpStatus } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PendingSettlementItemDto } from '@crm/shared'
import { apiError } from '../common/api-error'
import * as schema from '../database/schema'
import { pendingObligations, projects, transactions, users } from '../database/schema'

type Db = NodePgDatabase<typeof schema>

export async function loadObligation(db: Db, obligationId: string) {
  const row = await db.query.pendingObligations.findFirst({
    where: eq(pendingObligations.id, obligationId),
  })
  if (!row) throw apiError('FINANCE_OBLIGATION_NOT_FOUND', HttpStatus.NOT_FOUND)
  return row
}

/**
 * Walk source transaction → projectId so the SENIOR_INCOME row keeps the
 * project pointer for audit. Failures are non-fatal: a missing source or
 * missing project just yields `null`.
 *
 * security-review PR #443 (HIGH-1 / MED-B): also returns the source row's
 * `dropCascadeOrigin` — the deterministic, FK-independent cascade-vs-
 * declaration discriminator `settleByCompany` uses below to refuse a
 * COMPANY_ACCOUNT-funded settle on a cascade-originated drop obligation
 * (see the HIGH-1 guard for why, and the MED-B note on why this reads the
 * dedicated marker column rather than `payoutRequestId`).
 */
export async function resolveSource(
  db: Db,
  sourceTransactionId: string,
): Promise<{
  project: { id: string; name: string } | null
  sourceType: string | null
  // Nullable — `null` means "unstamped" and the HIGH-1/MED-B guard above
  // treats that as unknown-origin (BLOCK), same as `true`. Only an
  // explicit `false` means "verified non-cascade, safe".
  sourceDropCascadeOrigin: boolean | null
  // task-settled-amount-snapshot: the row's CURRENT share-percent snapshot,
  // read BEFORE settleByCompany nulls it on the flip (see the
  // `settledSharePercent` write below and the column comment on
  // `transactions.settledSharePercent` in schema.ts). A row is either a
  // senior or a drop IOU, never both — exactly one of the two is non-null.
  sourceSeniorSharePercent: number | null
  sourceDropSharePercent: number | null
  // task-settled-amount-snapshot (MED-1, security-review round 1, PR #599):
  // the row's CURRENT settled_currency, read so the flip below can refuse
  // a settle whose currency does not match what is ALREADY accumulated —
  // summing FACT amounts recorded in different currencies under one column
  // would silently misrepresent the total.
  sourceSettledCurrency: string | null
  /**
   * task-cascade-apply (task 3, AC10): the row's CURRENT accumulator.
   *
   * PR #599 deliberately stopped reading it, because the increment is
   * DB-native (`coalesce(current, 0) + delta`) and needed no pre-transaction
   * value. Task 3 needs it again for a different question — not "what to add"
   * but "how much is STILL owed" (`obligation.amount − already paid`), which
   * only a cascade revert can make non-trivial. The DB-native increment is
   * UNCHANGED; the value read here is used for the remainder arithmetic and
   * re-asserted in the flip's WHERE, so a concurrent settle in between
   * matches zero rows instead of over-paying.
   */
  sourceSettledAmount: string | null
  /**
   * task-cascade-apply (task 3, AC14 / addendum §1.13, security-review
   * SR-H-2): the row's CURRENT `funding_source`, read so a top-up can be
   * refused when it would come out of a different pot than the payment
   * already recorded on this row.
   */
  sourceFundingSource: string | null
  /**
   * task-cascade-apply (task 3, AC14 / security-review SR-M-5): WHO paid.
   *
   * `funding_source` alone answers "which pot", and inside `ADMIN_PERSONAL`
   * that is the same NULL for every partner — so the pot comparison cannot
   * tell two admins apart. The flip overwrites `sender_id`, and
   * `adminBalances.sent` sums the row's whole `amount` under whoever holds
   * it, so a top-up by a different partner silently moves the first
   * partner's payment onto the second. The label rides along so the refusal
   * can NAME them rather than say "someone else".
   */
  sourceSenderId: string | null
  sourceSenderLabel: string | null
  sourceTxDate: Date | null
  sourceCreatedAt: Date | null
}> {
  const source = await db.query.transactions.findFirst({
    where: eq(transactions.id, sourceTransactionId),
  })
  if (!source)
    // Stryker disable next-line ObjectLiteral: `sourceTransactionId` is a
    // NOT NULL FK with ON DELETE RESTRICT (schema.ts, pendingObligations
    // .sourceTransactionId) — this branch is unreachable through any real
    // write path; kept purely as defense-in-depth. Every field this object
    // returns is immediately destructured and treated identically whether
    // it is explicit `null` or JS's own `undefined` (the mutant's `{}`):
    // `sourceType === 'DROP_PENDING_PAYOUT'`, `!== false` checks, `? :`
    // ternaries and the `sourceSettledCurrency && sourceSettledCurrency !==
    // currency` guard above all give the SAME result for `undefined` as
    // for `null`. No assertion on the shape of THIS unreachable branch's
    // return value can be anything but tautological — the settle-aborts-
    // safely behaviour it feeds into is already pinned by 'defense-in-
    // depth: source transaction row missing entirely aborts the settle
    // safely' in pending-settlement.spec.ts.
    return {
      project: null,
      sourceType: null,
      sourceDropCascadeOrigin: null,
      sourceSeniorSharePercent: null,
      sourceDropSharePercent: null,
      sourceSettledCurrency: null,
      sourceSettledAmount: null,
      sourceFundingSource: null,
      sourceSenderId: null,
      sourceSenderLabel: null,
      sourceTxDate: null,
      sourceCreatedAt: null,
    }
  const project = source.projectId
    ? await db.query.projects.findFirst({ where: eq(projects.id, source.projectId) })
    : null
  return {
    project: project ? { id: project.id, name: project.name } : null,
    sourceType: source.type,
    sourceDropCascadeOrigin: source.dropCascadeOrigin,
    sourceSeniorSharePercent: source.seniorSharePercent,
    sourceDropSharePercent: source.dropSharePercent,
    sourceSettledCurrency: source.settledCurrency,
    sourceSettledAmount: source.settledAmount,
    sourceFundingSource: source.fundingSource,
    sourceSenderId: source.senderId,
    sourceSenderLabel: source.senderLabel,
    sourceTxDate: source.txDate,
    sourceCreatedAt: source.createdAt,
  }
}

/**
 * Denormalise obligation rows with creditor / debtor / project names so the
 * UI cards render without follow-up requests.
 */
export async function denormalise(
  db: Db,
  rows: Array<{
    id: string
    creditorUserId: string
    debtorType: 'DROP' | 'TOV' | 'ADMIN' | 'COMPANY'
    debtorUserId: string | null
    sourceTransactionId: string
    amount: string
    currency: string
    createdAt: Date
  }>,
): Promise<PendingSettlementItemDto[]> {
  const result: PendingSettlementItemDto[] = []
  for (const row of rows) {
    const [senior, debtor, source] = await Promise.all([
      db.query.users.findFirst({ where: eq(users.id, row.creditorUserId) }),
      row.debtorUserId
        ? db.query.users.findFirst({ where: eq(users.id, row.debtorUserId) })
        : Promise.resolve(undefined),
      db.query.transactions.findFirst({
        where: eq(transactions.id, row.sourceTransactionId),
      }),
    ])
    const project = source?.projectId
      ? await db.query.projects.findFirst({ where: eq(projects.id, source.projectId) })
      : undefined

    result.push({
      obligationId: row.id,
      sourceTransactionId: row.sourceTransactionId,
      debtorType: row.debtorType,
      debtorUserId: row.debtorUserId,
      debtorName: debtor?.displayName ?? null,
      seniorId: row.creditorUserId,
      seniorName: senior?.displayName ?? '—',
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      amount: row.amount,
      currency: row.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
      createdAt: row.createdAt.toISOString(),
    })
  }
  return result
}
