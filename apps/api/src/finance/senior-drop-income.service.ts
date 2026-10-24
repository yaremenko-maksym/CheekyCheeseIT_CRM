import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { receiptMandatoryError } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import { uniqueViolationConstraint } from '../database/pg-errors'
import { projects, transactions, users } from '../database/schema'
import { assertProjectActive } from '../projects/project-status.util'
import { TransactionLifecycleService } from './transaction-lifecycle.service'
import { resolveSeniorShare } from './senior-share-resolver'
import { resolveDropShare } from './drop-share-resolver'
import { resolveTransactionDateWithPolicy } from './transaction-date-policy'
import { findActiveTeamsForUser } from './active-teams.util'
import { assertReceiptDocumentBindable } from './receipt.util'

/**
 * Self-declared income creation: `createSeniorIncome` (SENIOR_INCOME) and
 * `createDropIncome` (DROP_INCOME). Depends on the database and the lifecycle
 * (created-notification) collaborator; never on TransactionsService. Each method
 * resolves with the `{ id }` of the created (or idempotently replayed) row; the
 * viewer-scoped read-back (`findOne`) stays on the facade, which runs it on that id
 * exactly where the former in-place `return this.findOne(...)` sat.
 */
@Injectable()
export class SeniorDropIncomeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly lifecycle: TransactionLifecycleService,
  ) {}

  // ── Create SENIOR_INCOME ─────────────────────────────────────────────────

  async createSeniorIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      // backlog 73/A-3 (security): REQUIRED client-generated UUID, mirroring
      // the ADMIN_INCOME (PR #367, MED-1) / dividend (BIZ-19, MED-2)
      // idempotency contract 1:1 — see declareUsdtProjectIncome's own comment
      // for the full rationale. The frontend generates a fresh UUID at dialog
      // OPEN and sends it on every submit within that session. A double-submit
      // (double click / network retry) with the SAME key returns the EXISTING
      // SENIOR_INCOME row instead of creating a second one — the second income
      // used to book a second company obligation for the same piece of work
      // once it reached payout validation (bookCompanyObligations).
      idempotencyKey: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'SENIOR') throw new ForbiddenException()

    // backlog 73/A-3: idempotency replay guard. Runs FIRST, right after the
    // RBAC gate above and BEFORE any RBAC-independent logic (project lookup,
    // ownership check, receipt validation) — same placement
    // declareUsdtProjectIncome uses, for the same reason: an unauthorized
    // replay still gets 403 from the role check above, never a leaked row.
    // A caller replaying a key that belongs to a DIFFERENT senior's income
    // still cannot read it — the facade's `findOne` read-back re-applies `assertTransactionReadAccess`,
    // which rejects a SENIOR who is neither the sender nor the receiver of
    // the row, so this early-SELECT does not need its own ownership filter.
    //
    // This is a plain SELECT (no lock) — the genuine concurrent race where two
    // submits both miss it is caught by the partial unique index (23505) at
    // the insert below.
    //
    // Key = INTENT (same contract as ADMIN_INCOME/dividend): replaying a key
    // with a DIFFERENT payload still returns the FIRST committed row — a
    // silent no-op, not a 409. Acceptable by design: the dialog generates a
    // fresh UUID per open, so a key/payload mismatch can only come from a
    // stale client retry, where returning the original row is the safe answer.
    const seniorIncomeReplay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'SENIOR_INCOME'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (seniorIncomeReplay) return { id: seniorIncomeReplay.id }

    // task-project-draft-status (Д2): fused fetch+status guard.
    const project = assertProjectActive(
      // Stryker disable next-line ObjectLiteral: the `where` SHAPE is unobservable
      // from this file's mocked unit specs — they stub `query.projects.findFirst`
      // to return a canned row regardless of what `where` it is called with (same
      // structural limit `income-compliance.unit.spec.ts` documents for
      // `transactions.findMany`). A gutted `{}` here would fetch an ARBITRARY
      // project instead of `data.projectId`'s — caught by this entry point's own
      // RBAC/ownership integration spec (multiple seeded projects, asserts on the
      // SPECIFIC one), not observable from a mocked unit double.
      await this.db.db.query.projects.findFirst({
        where: eq(projects.id, data.projectId),
        // Stryker disable next-line BooleanLiteral,ObjectLiteral: unobservable from a mocked unit double — this file's mocked specs stub `query.projects.findFirst` to return a canned row with `financeSettings` already populated, regardless of what `with` shape is requested; caught by this entry point's own RBAC/ownership integration spec against real Postgres, same reasoning as the `where`-shape suppression on the line above.
        with: { financeSettings: true },
      }),
    )
    if (project.seniorId !== currentUser.id) {
      throw apiError('FINANCE_INCOME_OWN_PROJECTS_ONLY', HttpStatus.FORBIDDEN)
    }
    // task-drop-share-override-and-receiver (D2). On a USDT-payment project the
    // SENIOR does NOT declare income — only an ADMIN does (via
    // declareUsdtProjectIncome), and the company books the senior share as an
    // obligation. FOP/GIG lifecycle is unchanged.
    if (project.paymentType === 'USDT') {
      throw apiError('FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!senior) throw apiError('SENIOR_NOT_FOUND', HttpStatus.NOT_FOUND)
    // task-archive-pending-modal (AC1): a NEW PENDING accrual must never be
    // minted for an archived person — `JwtAuthGuard` already rejects an
    // archived session, but its role/archived cache has a 60s TTL (see
    // jwt.guard.ts), so a request already in flight when the archive commits
    // can still reach here within that window. Same "creates a NEW
    // entitlement → refuse" rule `createSalary` / `createMonthlySalaries`
    // apply, defense-in-depth over the auth layer's TOCTOU gap.
    if (senior.archivedAt) {
      throw apiError('FINANCE_INCOME_RECEIVER_ARCHIVED', HttpStatus.FORBIDDEN)
    }

    // task-team-senior-share-override. Hierarchy resolution:
    //   project.seniorSharePercentOverride
    //     ↓  (null)
    //   exactly-one active team.seniorSharePercentOverride for this senior
    //     ↓  (null / ambiguous)
    //   users.seniorSharePercent (fallback 26)
    //
    // The legacy `projectFinanceSettings.seniorSharePercentOverride` mirror
    // is preserved for back-compat — the projects module keeps both columns
    // in sync, so consulting `projects.seniorSharePercentOverride` (which
    // the resolver does) is equivalent to the previous mirror lookup.
    const applicableTeams = await findActiveTeamsForUser(this.db.db, currentUser.id)
    const resolved = resolveSeniorShare(
      { seniorSharePercentOverride: project.seniorSharePercentOverride },
      { seniorSharePercent: senior.seniorSharePercent },
      applicableTeams,
    )

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller boundary.
    const seniorIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      data.currency,
    )
    if (seniorIncomeReceiptErr) throw zodErrorBadRequest(seniorIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
    }

    let tx: typeof transactions.$inferSelect | undefined
    try {
      ;[tx] = await this.db.db
        .insert(transactions)
        .values({
          type: 'SENIOR_INCOME',
          status: 'PENDING',
          amount: String(data.amount),
          currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
          senderId: null,
          senderLabel: project.companyName,
          receiverId: currentUser.id,
          projectId: data.projectId,
          seniorSharePercent: resolved.value,
          seniorSharePercentSource: resolved.source,
          // backlog 73/A-3: persist the key so
          // uq_transactions_senior_income_idempotency_key enforces
          // single-income-per-key as a DB-level backstop for concurrent
          // submits that slip past the early-SELECT above.
          idempotencyKey: data.idempotencyKey,
          receiptDocumentId: data.receiptDocumentId ?? null,
          receiptExternalUrl: data.receiptExternalUrl ?? null,
          notes: data.notes ?? null,
          // SR-809-H-1 / owner decision D-2: ONE server-side policy decides
          // whether this date is allowed at all. EXECUTED — an income records
          // money already received, so it may be backdated inside the window
          // but never moved into the future. Scenario 1 of the finding is a
          // SENIOR declaring a missed month late: that is now refused past the
          // window instead of silently restating a reported month.
          // No `backdateReason` is passed ON PURPOSE (security-review LOW): this
          // endpoint is self-service, so the actor is SENIOR or DROP, and neither
          // is exempt from the backdating window under D-2 — a reason could never
          // be consumed here. Same reasoning as `submitDeposit` and
          // `createPayoutRequest`: a parameter that cannot change any outcome
          // lies about what the code does.
          txDate: resolveTransactionDateWithPolicy(data.txDate, {
            role: currentUser.role,
            flow: 'EXECUTED',
          }).txDate,
          createdBy: currentUser.id,
        })
        .returning()
    } catch (err) {
      // backlog 73/A-3 race: two concurrent submits with the SAME key both
      // miss the early-SELECT (it runs outside any lock); A commits, B's
      // insert hits uq_transactions_senior_income_idempotency_key (23505).
      // Re-read the committed winner and return it — idempotent response,
      // not a 500. Match on the CONSTRAINT NAME (not a blanket
      // isUniqueViolation) so an unrelated collision on this table (e.g.
      // uq_transactions_receipt_document_id) rethrows instead of being
      // misattributed as an idempotency race (security-review PR #438
      // rationale — see pg-errors.ts's own doc comment on
      // uniqueViolationConstraint).
      if (uniqueViolationConstraint(err) === 'uq_transactions_senior_income_idempotency_key') {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'SENIOR_INCOME'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) return { id: committed.id }
      }
      throw err
    }

    await this.lifecycle.afterTransactionCreated(tx!.id, tx!, currentUser)
    return { id: tx!.id }
  }

  // ── Create DROP_INCOME (Drop role - phase 2) ─────────────────────────────
  //
  // Parallel to `createSeniorIncome` for DROP users on drop-projects. Keeps
  // the senior-income path unchanged. Validation cascade (validateTransaction
  // below) understands both types and routes DROP_INCOME through the
  // distribution branch.

  async createDropIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      // backlog 73/A-3 (security): same REQUIRED idempotency-key contract as
      // createSeniorIncome above (see its comment for the full rationale) —
      // mirrored 1:1 onto DROP_INCOME.
      idempotencyKey: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'DROP') throw new ForbiddenException()

    // backlog 73/A-3: idempotency replay guard — same placement + rationale
    // as createSeniorIncome's own guard (see its comment). The facade's `findOne` read-back
    // re-applies `assertTransactionReadAccess`, which rejects a DROP who is neither the
    // sender nor the receiver of the replayed row, so a replay of someone
    // else's key still cannot leak that row's data.
    const dropIncomeReplay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'DROP_INCOME'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (dropIncomeReplay) return { id: dropIncomeReplay.id }

    // task-project-draft-status (Д2): fused fetch+status guard.
    const project = assertProjectActive(
      // Stryker disable next-line ObjectLiteral: the `where` SHAPE is unobservable
      // from this file's mocked unit specs — they stub `query.projects.findFirst`
      // to return a canned row regardless of what `where` it is called with (same
      // structural limit `income-compliance.unit.spec.ts` documents for
      // `transactions.findMany`). A gutted `{}` here would fetch an ARBITRARY
      // project instead of `data.projectId`'s — caught by this entry point's own
      // RBAC/ownership integration spec (multiple seeded projects, asserts on the
      // SPECIFIC one), not observable from a mocked unit double.
      await this.db.db.query.projects.findFirst({
        where: eq(projects.id, data.projectId),
      }),
    )
    // The drop can only declare income on a drop-project routed through them.
    if (project.dropId !== currentUser.id) {
      throw apiError('FINANCE_NOT_YOUR_DROP_PROJECT', HttpStatus.FORBIDDEN)
    }

    // task-drop-share-override-and-receiver (D2). On a USDT-payment project the
    // DROP/SENIOR do NOT declare income — only an ADMIN does (via
    // declareUsdtProjectIncome), and the company books the drop/senior share as
    // an obligation. FOP/GIG lifecycle is unchanged.
    if (project.paymentType === 'USDT') {
      throw apiError('FINANCE_USDT_PROJECT_INCOME_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller boundary.
    const dropIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      data.currency,
    )
    if (dropIncomeReceiptErr) throw zodErrorBadRequest(dropIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
    }

    // task-drop-share-override-and-receiver (Part A). Snapshot the effective drop
    // share % (project override → drop user default → 5) so the distribution is
    // deterministic — a later change to users.dropSharePercent does not re-price
    // this income. Same resolver mapProject exposes as effectiveDropSharePercent.
    const dropUser = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    // task-archive-pending-modal (AC1): mirrors the guard in createSeniorIncome
    // — see its comment for the full TOCTOU rationale (JwtAuthGuard's 60s
    // role/archived cache).
    if (dropUser?.archivedAt) {
      throw apiError('FINANCE_INCOME_RECEIVER_ARCHIVED', HttpStatus.FORBIDDEN)
    }
    const resolvedDrop = resolveDropShare(
      { dropSharePercentOverride: project.dropSharePercentOverride },
      { dropSharePercent: dropUser?.dropSharePercent },
    )

    let tx: typeof transactions.$inferSelect | undefined
    try {
      ;[tx] = await this.db.db
        .insert(transactions)
        .values({
          type: 'DROP_INCOME',
          status: 'PENDING',
          amount: String(data.amount),
          currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
          senderId: null,
          senderLabel: project.companyName,
          receiverId: currentUser.id,
          recipientId: currentUser.id,
          projectId: data.projectId,
          dropSharePercent: resolvedDrop.value,
          dropSharePercentSource: resolvedDrop.source,
          // backlog 73/A-3: persist the key so
          // uq_transactions_drop_income_idempotency_key enforces
          // single-income-per-key as a DB-level backstop for concurrent
          // submits that slip past the early-SELECT above.
          idempotencyKey: data.idempotencyKey,
          receiptDocumentId: data.receiptDocumentId ?? null,
          receiptExternalUrl: data.receiptExternalUrl ?? null,
          notes: data.notes ?? null,
          // SR-809-H-1 / owner decision D-2: ONE server-side policy decides
          // whether this date is allowed at all. EXECUTED — an income records
          // money already received, so it may be backdated inside the window
          // but never moved into the future. Scenario 1 of the finding is a
          // SENIOR declaring a missed month late: that is now refused past the
          // window instead of silently restating a reported month.
          // No `backdateReason` is passed ON PURPOSE (security-review LOW): this
          // endpoint is self-service, so the actor is SENIOR or DROP, and neither
          // is exempt from the backdating window under D-2 — a reason could never
          // be consumed here. Same reasoning as `submitDeposit` and
          // `createPayoutRequest`: a parameter that cannot change any outcome
          // lies about what the code does.
          txDate: resolveTransactionDateWithPolicy(data.txDate, {
            role: currentUser.role,
            flow: 'EXECUTED',
          }).txDate,
          createdBy: currentUser.id,
        })
        .returning()
    } catch (err) {
      // backlog 73/A-3 race: same shape as createSeniorIncome's own catch —
      // match on the CONSTRAINT NAME so an unrelated collision on this table
      // rethrows instead of being misattributed as an idempotency race.
      if (uniqueViolationConstraint(err) === 'uq_transactions_drop_income_idempotency_key') {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'DROP_INCOME'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) return { id: committed.id }
      }
      throw err
    }

    await this.lifecycle.afterTransactionCreated(tx!.id, tx!, currentUser)
    return { id: tx!.id }
  }
}
