import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_RECEIVER, extractOnChainTxHash, receiptMandatoryError } from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import { isUniqueViolation } from '../database/pg-errors'
import { projects, transactions, users } from '../database/schema'
import { assertProjectActive } from '../projects/project-status.util'
import { bookCompanyObligations } from './company-obligations.util'
import { resolveDropShare } from './drop-share-resolver'
import { consumeTxHash, settlementConsumesTransfer } from './onchain-tx'
import { OnChainClaimService } from './onchain-claim.service'
import { assertReceiptDocumentBindable } from './receipt.util'
import { resolveSeniorShareSnapshot } from './senior-share-snapshot.util'
import { resolveTransactionDate } from './transaction-date.util'
import { TransactionLifecycleService } from './transaction-lifecycle.service'

/**
 * Admin income recording: the ADMIN_INCOME write paths (`createAdminIncome` for
 * FOP/GIG projects, `declareUsdtProjectIncome` for USDT-payment projects) with
 * their RBAC gates, on-chain hash claim, idempotency and company-obligation
 * booking. Depends on the database, the on-chain claim registry and the
 * transaction lifecycle; never on TransactionsService. Both methods return the
 * created (or replayed) row id; the facade performs the viewer-scoped read-back.
 */
@Injectable()
export class AdminIncomeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly onChainClaim: OnChainClaimService,
    private readonly lifecycle: TransactionLifecycleService,
  ) {}

  async createAdminIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
      // task-admin-income-unified: REPLACES the old `fundingSource` toggle.
      // Same contract as `declareUsdtProjectIncome`'s `receiverId` — an active
      // ADMIN's uuid credits THAT admin personally; the COMPANY_ACCOUNT_RECEIVER
      // sentinel credits the shared pool. Absent → legacy default (see below).
      // ACCOUNTANT sending an explicit value here is a contract violation, not
      // a routing preference — rejected outright (see the RBAC block below).
      receiverId?: string | undefined
    },
    currentUser: SessionUser,
  ) {
    // task-accountant-create-transaction. ACCOUNTANT has create-parity with
    // ADMIN for ADMIN_INCOME — but ONLY as a recorder. Eligibility (which
    // PROJECT a caller may declare income for) is unchanged by
    // task-admin-income-unified:
    //   - ADMIN caller: project must be their own (seniorId === self).
    //   - ACCOUNTANT caller: may register on ANY admin-owned project (the
    //     project's senior must be an ADMIN). The accountant is the recorder
    //     (createdBy), never the recipient — enforced below, independent of
    //     project eligibility.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT')
      throw new ForbiddenException()

    // task-project-draft-status (Д2): fused fetch+status guard — a DRAFT or
    // REJECTED project must never accrue income. See project-status.util.ts's
    // own doc for why this is one call, not a fetch followed by a separate
    // check.
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

    let projectOwnerId: string
    if (currentUser.role === 'ADMIN') {
      if (project.seniorId !== currentUser.id) {
        throw apiError('FINANCE_INCOME_OWN_PROJECTS_ONLY', HttpStatus.FORBIDDEN)
      }
      projectOwnerId = currentUser.id
    } else {
      // ACCOUNTANT: the project must belong to an ADMIN (ADMIN_INCOME is income
      // owned by an admin partner).
      const owner = await this.db.db.query.users.findFirst({
        where: eq(users.id, project.seniorId),
      })
      if (!owner || owner.role !== 'ADMIN') {
        throw apiError('FINANCE_ADMIN_INCOME_PROJECT_MUST_BE_ADMIN_OWNED', HttpStatus.FORBIDDEN)
      }
      projectOwnerId = owner.id
    }

    // task-admin-income-unified (§2, owner decision 2026-08-12). WHO gets
    // credited is now a SEPARATE choice from project eligibility above — but
    // picking a SPECIFIC admin is ADMIN-only. The ACCOUNTANT has never been a
    // router of funds (the server has always hard-credited the project's
    // admin owner for this role); the web dialog's selector reflects that by
    // only ever offering "project owner" (no receiverId) or "company account"
    // (the sentinel — not a specific-admin choice, still allowed for this
    // role, same capability the old `fundingSource` toggle already had). A
    // payload naming a SPECIFIC admin disagrees with the UI's constraint and
    // is rejected, not silently coerced.
    if (
      currentUser.role === 'ACCOUNTANT' &&
      data.receiverId !== undefined &&
      data.receiverId !== COMPANY_ACCOUNT_RECEIVER
    ) {
      throw apiError('FINANCE_ADMIN_INCOME_RECEIVER_FIXED_FOR_ACCOUNTANT', HttpStatus.FORBIDDEN)
    }

    let receiverId: string
    let fundingSource: 'COMPANY_ACCOUNT' | null
    if (data.receiverId === undefined) {
      // Legacy default — unchanged behaviour: credit the project's owner.
      receiverId = projectOwnerId
      fundingSource = null
    } else if (data.receiverId === COMPANY_ACCOUNT_RECEIVER) {
      // Mirrors declareUsdtProjectIncome: the CALLER becomes the nominal
      // receiverId (audit trail — who recorded it), fundingSource marks the
      // ACTUAL destination (the shared pool, not that person's balance).
      receiverId = currentUser.id
      fundingSource = 'COMPANY_ACCOUNT'
    } else {
      // ADMIN caller only (the ACCOUNTANT branch above already threw). Same
      // "active ADMIN" validation declareUsdtProjectIncome already applies.
      const receiver = await this.db.db.query.users.findFirst({
        where: eq(users.id, data.receiverId),
      })
      if (!receiver || receiver.role !== 'ADMIN' || receiver.archivedAt) {
        throw apiError('FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN', HttpStatus.BAD_REQUEST)
      }
      receiverId = receiver.id
      fundingSource = null
    }

    // task-admin-income-unified (was task-admin-income-payment-type-guard —
    // the owner rewrote the task 2026-08-12 mid-implementation from "add a
    // check" to "remove the choice that needed checking": the web dialog no
    // longer offers a separate USDT form the caller could pick wrong, it
    // decides `createAdminIncome` vs `declareUsdtProjectIncome` itself from
    // `project.paymentType`). This throw is what remains of the original
    // fix — AC4's invariant, now enforced as defense-in-depth: the UI cannot
    // reach this branch for a USDT project (it always routes to
    // `declareUsdtProjectIncome` instead), but nothing stops a direct API
    // call from trying, and a USDT-payment project books obligations to its
    // senior/drop ONLY through `declareUsdtProjectIncome`
    // (`bookCompanyObligations` runs inside THAT transaction; this path never
    // calls it) — that gap is exactly what happened in prod (GamingTec,
    // 4708.69 USDT, no drop share). Gated on `project.paymentType`, not on
    // `data.currency`/`receiverId` — a FOP/GIG project routed into the
    // company-account pool (currency forced to USDT for THIS transaction) is
    // unaffected; only a project whose OWN payment type is USDT is rejected.
    if (project.paymentType === 'USDT') {
      throw apiError('FINANCE_USDT_PROJECT_WRONG_INCOME_ROUTE', HttpStatus.BAD_REQUEST)
    }

    // task-receipts-backend (review round 1, MED-2): defense-in-depth mandatory-
    // receipt re-check on the service, not only in Zod at the controller
    // boundary. Effective currency = USDT for a company-account income (USDT-only
    // pool) → explorer-only; else the supplied currency → file/url.
    const adminIncomeReceiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      fundingSource === 'COMPANY_ACCOUNT' ? 'USDT' : data.currency,
    )
    if (adminIncomeReceiptErr) throw zodErrorBadRequest(adminIncomeReceiptErr)

    // HIGH-1: validate receipt ownership + category before writing FK
    if (data.receiptDocumentId) {
      await assertReceiptDocumentBindable(this.db.db, data.receiptDocumentId, currentUser)
    }

    // task-salary-company-account (routing preserved, resolution moved above).
    // When COMPANY_ACCOUNT the income is directed into the shared company pool
    // — currency forced to USDT and funding_source persisted. The company
    // balance formula counts ADMIN_INCOME(COMPANY_ACCOUNT) PAID as a (+)
    // credit; getSummary EXCLUDES these rows from the receiver's personal
    // balance (the money went to the pool, not to a person).
    const isCompanyFunded = fundingSource === 'COMPANY_ACCOUNT'
    const currency = (isCompanyFunded ? 'USDT' : data.currency) as 'USDT' | 'USD' | 'EUR' | 'UAH'

    // ── SECURITY (security-review PR #438, HIGH-3): the SECOND ADMIN_INCOME
    // writer. This path credits the company account with exactly the same
    // ledger predicate as `declareUsdtProjectIncome`
    // (type=ADMIN_INCOME, status=PAID, currency=USDT,
    // fundingSource=COMPANY_ACCOUNT) but did not claim the on-chain hash, so
    // the registry covered one of two writers. An honestly registered client
    // inflow of 5 000 USDT left the transfer unclaimed, and any SENIOR/DROP
    // could read that hash off the public explorer and submit it as a deposit —
    // recipient, currency and confirmations all check out, a deposit declares
    // no amount, the sender is not a gate — crediting the pool a second time.
    //
    // The receipt is MANDATORY and explorer-only for a company-funded income,
    // so the hash is physically available: extract it, record it, claim it in
    // the SAME transaction as the credit.
    // LOW (round 3): RECORD the hash whenever the receipt carries one — both
    // writers now follow the same rule, and attribution is useful even on a
    // personal income. CLAIMING is the separate decision below
    // (`settlementConsumesTransfer`): recording ≠ spending.
    const onChainTxHash = extractOnChainTxHash(data.receiptExternalUrl)

    let tx: typeof transactions.$inferSelect
    try {
      tx = await this.db.db.transaction(async (dbtx) => {
        const [inserted] = await dbtx
          .insert(transactions)
          .values({
            type: 'ADMIN_INCOME',
            status: 'PAID',
            amount: String(data.amount),
            currency,
            senderId: null,
            senderLabel: project.companyName,
            receiverId,
            projectId: data.projectId,
            receiptDocumentId: data.receiptDocumentId ?? null,
            receiptExternalUrl: data.receiptExternalUrl ?? null,
            txHash: onChainTxHash,
            notes: data.notes ?? null,
            fundingSource,
            txDate: resolveTransactionDate(data.txDate),
            createdBy: currentUser.id,
          })
          .returning()

        if (settlementConsumesTransfer({ kind: 'ADMIN_INCOME', fundingSource })) {
          const claim = await consumeTxHash(dbtx, {
            txHash: data.receiptExternalUrl ?? '',
            purpose: 'ADMIN_INCOME',
            referenceId: inserted!.id,
            consumedByUserId: currentUser.id,
          })
          // MED-1: an unclaimable receipt on a CREDITING path must be visible.
          if (!claim.claimed) {
            await this.onChainClaim.recordUnclaimedCredit(dbtx, {
              path: 'createAdminIncome',
              transactionId: inserted!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
          // MED-J: spending a transfer an ADMIN had released is legitimate but
          // must be reconstructable — record the second half of the pair.
          if (claim.reclaimedAfterRelease) {
            await this.onChainClaim.recordReclaimAfterRelease(dbtx, {
              path: 'createAdminIncome',
              txHash: data.receiptExternalUrl ?? '',
              referenceId: inserted!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }

        return inserted!
      })
    } catch (err) {
      // The only unique index this transaction can violate is
      // `uq_consumed_tx_hashes_tx_hash` — the receipt points at a transfer that
      // already settled something else. Clean 400, never a 500.
      if (isUniqueViolation(err)) {
        throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
      }
      throw err
    }

    await this.lifecycle.afterTransactionCreated(tx.id, tx, currentUser)
    return { id: tx.id }
  }

  /**
   * task-drop-share-override-and-receiver (D3). An ADMIN declares USDT project
   * income on a USDT-payment project. The gross amount lands on the chosen
   * receiver (an ADMIN's personal balance, or the shared company USDT pool); the
   * company then books obligations to the project's senior (unless the senior is
   * an ADMIN) and drop (if bound). The income row itself is an ADMIN_INCOME
   * (adopt-before-extend — identical money semantics), created immediately PAID.
   *
   * Income row + both obligation blocks commit in ONE db.transaction so an
   * income can never exist without its obligations (anti-BIZ-02).
   *
   * RBAC: ADMIN only (Q4 — ACCOUNTANT may NOT declare, enforced by the controller
   * @Roles and re-checked here).
   */
  async declareUsdtProjectIncome(
    data: {
      projectId: string
      amount: number
      receiverId: string
      // Security-review PR #367 (MED-1): client-generated UUID, REQUIRED (Zod
      // enforces it in createUsdtIncomeSchema). Mirrors the dividend BIZ-19
      // (MED-2) idempotency contract 1:1 — see the early-SELECT / 23505 catch
      // below and uq_transactions_admin_income_idempotency_key.
      idempotencyKey: string
      // task-receipts-backend (#4): receipt is MANDATORY and (USDT income)
      // explorer-only. Zod enforces this at the controller; re-checked below for
      // defense-in-depth.
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    // PR #367 (MED-1): idempotency replay guard. A double-submit (double click /
    // network retry) carries the SAME key — return the EXISTING ADMIN_INCOME row
    // WITHOUT re-declaring income or re-booking company obligations. The RBAC gate
    // runs FIRST (defense-in-depth): a non-admin replaying a key still gets 403,
    // never a leaked row. This is a plain SELECT (no lock) — the genuine
    // concurrent race where two submits both miss it is caught by the partial
    // unique index (23505) at the tail of this method.
    //
    // Key = INTENT (same contract as dividend BIZ-19): replaying a key with a
    // DIFFERENT payload (amount/project/receiver) still returns the FIRST
    // committed row — a silent no-op, not a 409; the new payload is ignored.
    // Acceptable by design: the endpoint is ADMIN-only and the dialog generates
    // a fresh UUID per open, so a key/payload mismatch can only come from a
    // stale client retry, where returning the original row is the safe answer.
    const replay = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'ADMIN_INCOME'),
        eq(transactions.idempotencyKey, data.idempotencyKey),
      ),
    })
    if (replay) return { id: replay.id }

    // task-receipts-backend (#4) defense-in-depth: re-validate the mandatory
    // receipt (USDT → explorer-only) on the service, not only in Zod. Runs AFTER
    // the idempotency short-circuit so a genuine retry still returns the existing
    // row; a NEW declaration must carry a valid explorer link. A file receipt is
    // rejected for USDT before it can be bound.
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: data.receiptDocumentId, receiptExternalUrl: data.receiptExternalUrl },
      'USDT',
    )
    if (receiptErr) throw zodErrorBadRequest(receiptErr)

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
    // Gate: this flow is ONLY for USDT-payment projects (D2). FOP/GIG income is
    // declared by the SENIOR/DROP themselves via createSeniorIncome/DropIncome.
    if (project.paymentType !== 'USDT') {
      throw apiError('FINANCE_USDT_INCOME_PROJECT_TYPE_MISMATCH', HttpStatus.BAD_REQUEST)
    }

    // Resolve the receiver: the COMPANY_ACCOUNT marker credits the shared USDT
    // pool (fundingSource=COMPANY_ACCOUNT, receiverId=caller, excluded from the
    // caller's personal balance in getSummary — mirror of createAdminIncome);
    // otherwise the receiver must be an active ADMIN whose personal balance is
    // credited (fundingSource=null).
    const toCompanyPool = data.receiverId === COMPANY_ACCOUNT_RECEIVER
    let receiverId: string
    let fundingSource: 'COMPANY_ACCOUNT' | null
    if (toCompanyPool) {
      receiverId = currentUser.id
      fundingSource = 'COMPANY_ACCOUNT'
    } else {
      const receiver = await this.db.db.query.users.findFirst({
        where: eq(users.id, data.receiverId),
      })
      if (!receiver || receiver.role !== 'ADMIN' || receiver.archivedAt) {
        throw apiError('FINANCE_INCOME_RECEIVER_MUST_BE_ACTIVE_ADMIN', HttpStatus.BAD_REQUEST)
      }
      receiverId = receiver.id
      fundingSource = null
    }

    // Load senior + drop and resolve their effective shares BEFORE opening the
    // transaction (resolveSeniorShareSnapshot reads team memberships on the base
    // connection — committed data, safe pre-txn). Snapshots are stamped onto the
    // IOU rows so the obligation is deterministic.
    const senior = project.seniorId
      ? await this.db.db.query.users.findFirst({ where: eq(users.id, project.seniorId) })
      : null
    const drop = project.dropId
      ? await this.db.db.query.users.findFirst({ where: eq(users.id, project.dropId) })
      : null

    const seniorSnapshot = senior
      ? await resolveSeniorShareSnapshot(
          this.db.db,
          { seniorSharePercentOverride: project.seniorSharePercentOverride },
          { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
        )
      : null
    const dropSnapshot = drop
      ? resolveDropShare(
          { dropSharePercentOverride: project.dropSharePercentOverride },
          { dropSharePercent: drop.dropSharePercent },
        )
      : null

    let txId: string
    try {
      txId = await this.db.db.transaction(async (dbtx) => {
        const [tx] = await dbtx
          .insert(transactions)
          .values({
            type: 'ADMIN_INCOME',
            status: 'PAID',
            amount: String(data.amount),
            currency: 'USDT',
            senderId: null,
            senderLabel: project.companyName,
            receiverId,
            projectId: data.projectId,
            fundingSource,
            // PR #367 (MED-1): persist the key so uq_transactions_admin_income_
            // idempotency_key enforces single-income-per-key as a DB-level backstop
            // for concurrent submits that slip past the early-SELECT above.
            idempotencyKey: data.idempotencyKey,
            // task-receipts-backend (#4): explorer link (USDT). USDT is
            // explorer-only, so receiptDocumentId is always null here.
            receiptDocumentId: data.receiptDocumentId ?? null,
            receiptExternalUrl: data.receiptExternalUrl ?? null,
            // The explorer link is the on-chain evidence for this income; record
            // the hash it points at (MED-1) so the row is attributable and the
            // registry claim below has a visible counterpart on the ledger.
            txHash: extractOnChainTxHash(data.receiptExternalUrl) ?? null,
            notes: data.notes ?? null,
            txDate: resolveTransactionDate(data.txDate),
            createdBy: currentUser.id,
          })
          .returning()

        // ── MED-1 (security-review PR #438): ADMIN_INCOME is the THIRD term
        // `computeCompanyAccountBalanceFromLedger` credits (alongside
        // COMPANY_DEPOSIT and PAYOUT/COMPANY_ACCOUNT), so leaving it outside the
        // consumed-hash registry kept the "one on-chain transfer settles exactly
        // one thing" invariant non-global: the same transfer could be declared
        // as admin income AND settle a payout / credit a deposit. The receipt is
        // MANDATORY and explorer-only for USDT income, so its link carries the
        // hash — claim it here, inside the same transaction as the credit.
        //
        // A no-op when the link carries no hash (nothing on-chain to consume);
        // a collision surfaces as 23505 → the catch below turns it into a clean
        // 400 rather than a 500.
        //
        // HIGH-3 (round 2): the claim is tied to the CREDITING condition, not
        // to the row type — `settlementConsumesTransfer`. A personal admin
        // declaration (fundingSource null) never touches the company balance
        // and references a transfer to that admin's OWN wallet, so burning its
        // hash would block that transfer's real payer for nothing.
        if (settlementConsumesTransfer({ kind: 'ADMIN_INCOME', fundingSource })) {
          const claim = await consumeTxHash(dbtx, {
            txHash: data.receiptExternalUrl ?? '',
            purpose: 'ADMIN_INCOME',
            referenceId: tx!.id,
            consumedByUserId: currentUser.id,
          })
          if (!claim.claimed) {
            await this.onChainClaim.recordUnclaimedCredit(dbtx, {
              path: 'declareUsdtProjectIncome',
              transactionId: tx!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
          if (claim.reclaimedAfterRelease) {
            await this.onChainClaim.recordReclaimAfterRelease(dbtx, {
              path: 'declareUsdtProjectIncome',
              txHash: data.receiptExternalUrl ?? '',
              referenceId: tx!.id,
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }

        await bookCompanyObligations(dbtx, {
          incomeAmount: data.amount,
          projectId: data.projectId,
          companyName: project.companyName,
          createdBy: currentUser.id,
          txDate: tx!.txDate ?? tx!.createdAt,
          // task-admin-income-drop-backfill: this row's own id — the ONE call
          // site that always knows its source income (it just inserted it, in
          // this same db transaction). Lets a future query answer "does this
          // income already have a booked share?" without guessing by
          // project+amount+time.
          incomeTransactionId: tx!.id,
          senior:
            senior && seniorSnapshot
              ? { id: senior.id, role: senior.role, shareSnapshot: seniorSnapshot }
              : null,
          drop: drop && dropSnapshot ? { id: drop.id, shareSnapshot: dropSnapshot } : null,
          notePrefix: 'USDT income',
        })

        return tx!.id
      })
    } catch (err) {
      // PR #367 (MED-1 race): two concurrent submits with the SAME key both miss
      // the early-SELECT (it runs outside any lock); A commits, B's insert hits
      // uq_transactions_admin_income_idempotency_key (23505). Drizzle rolls the
      // whole transaction back — NO partial income and NO orphan obligations —
      // then rethrows. Re-read the committed winner on a FRESH connection (the
      // aborted dbtx is unusable) and return it: idempotent response, not a 500.
      if (isUniqueViolation(err)) {
        const committed = await this.db.db.query.transactions.findFirst({
          where: and(
            eq(transactions.type, 'ADMIN_INCOME'),
            eq(transactions.idempotencyKey, data.idempotencyKey),
          ),
        })
        if (committed) return { id: committed.id }
        // MED-1: no row for this key ⇒ the 23505 came from the OTHER unique
        // index in this transaction — `uq_consumed_tx_hashes_tx_hash`, i.e. the
        // receipt link points at a transfer already settled elsewhere (a payout
        // or a deposit). Clean 400, never a 500.
        throw apiError('FINANCE_TX_HASH_ALREADY_CONSUMED', HttpStatus.BAD_REQUEST)
      }
      throw err
    }

    return { id: txId }
  }
}
