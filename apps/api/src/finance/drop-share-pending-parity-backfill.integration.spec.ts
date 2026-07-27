import { readFileSync } from 'fs'
import { join } from 'path'
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { PendingSettlementService } from './pending-settlement.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import {
  payoutRequests,
  pendingObligations,
  projects,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-drop-share-pending-parity — REAL-DB integration for the manual backfill
 * script `apps/api/drizzle/manual/2026-07-27_drop_share_pending_parity_backfill.sql`.
 *
 * Proves, against a REAL Postgres (crm_qa scratch — NEVER crm_db):
 *
 *   AC6-a  Selection predicate hits ONLY Path-B cascade rows (type=PAYOUT_DROP,
 *          status=PAID, payout_request_id IS NOT NULL) and does NOT touch a
 *          legacy-closed row (payout_request_id IS NULL, the pre-refactor
 *          settle route) — the exact discriminator the task specifies.
 *   AC6-b  A backup row is written before conversion (recoverable rollback).
 *   AC6-c  The converted row is paired with a NEW pending_obligations row
 *          (creditor=drop, debtorType=COMPANY, status=PENDING) — without it
 *          settleByCompany could never find/close the obligation.
 *   AC6-d  Idempotent: running the script a SECOND time changes nothing
 *          (0 further conversions, 0 further obligations, no error).
 *   AC6-e  Round-trip equivalence: convert → settle via the REAL
 *          settleByCompany (receipt + funding source) → the drop's aggregate
 *          balance (getDropSelfSummary) returns to EXACTLY what it was before
 *          the backfill ran — the row is "неотличима от свежесозданной IOU".
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- drop-share-pending-parity-backfill.integration
 */

const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-07-27_drop_share_pending_parity_backfill.sql'),
  'utf-8',
)

const SENIOR: SessionUser = {
  id: 'ce550000-0000-4000-bb00-000000000001',
  email: 'dspp-senior@test.spec',
  displayName: 'DSPP Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP_A: SessionUser = {
  ...SENIOR,
  id: 'ce550000-0000-4000-bb00-000000000002',
  email: 'dspp-drop-a@test.spec',
  displayName: 'DSPP Drop A',
  role: 'DROP',
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: 'ce550000-0000-4000-bb00-000000000005',
  email: 'dspp-admin@test.spec',
  displayName: 'DSPP Admin',
  role: 'ADMIN',
  seniorSharePercent: 0,
}
const ACCOUNTANT: SessionUser = {
  ...SENIOR,
  id: 'ce550000-0000-4000-bb00-000000000006',
  email: 'dspp-accountant@test.spec',
  displayName: 'DSPP Accountant',
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
}

const TEST_OWN_USERS = [SENIOR, DROP_A, ADMIN, ACCOUNTANT]
const TEST_OWN_USER_IDS = TEST_OWN_USERS.map((u) => u.id)
const PROJECT_ID = 'ce550000-0000-4000-dd00-000000000001'

const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => Promise.resolve(),
  autoCreateForSalary: () => Promise.resolve(),
} as never
const stubDocuments = {} as never

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _pool?.end() ?? Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [TestDatabaseModule],
  providers: [
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        makeTransactionsService({
          db,
          invoicesService: stubInvoices,
          documentsService: stubDocuments,
        }),
      inject: [DatabaseService],
    },
    {
      provide: PendingSettlementService,
      useFactory: (db: DatabaseService) => new PendingSettlementService(db, stubInvoices as never),
      inject: [DatabaseService],
    },
  ],
})
class DsppTestModule {}

describe('drop-share-pending-parity backfill script (real DB)', () => {
  let svc: TransactionsService
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  async function clearLedger() {
    await dbSvc.db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.receiverId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_OWN_USER_IDS))
  }

  /** Seed a historical Path-B row: a direct PAYOUT_DROP/PAID insert carrying a
   * real payout_request_id — exactly what `applyPayoutPaidCascade` used to
   * write before this task's code fix. */
  async function seedPathBRow(amount: string): Promise<{ txId: string; payoutRequestId: string }> {
    const [pr] = await dbSvc.db
      .insert(payoutRequests)
      .values({
        seniorId: DROP_A.id,
        incomeAmount: amount,
        payableAmount: amount,
        contractAddress: '0x' + 'f'.repeat(40),
        status: 'PAID',
      })
      .returning()
    const [tx] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount,
        currency: 'USDT',
        senderId: null,
        senderLabel: 'COMPANY',
        receiverId: DROP_A.id,
        recipientId: DROP_A.id,
        projectId: PROJECT_ID,
        payoutRequestId: pr!.id,
        txHash: '0x' + 'a'.repeat(64),
        createdBy: DROP_A.id,
      })
      .returning()
    return { txId: tx!.id, payoutRequestId: pr!.id }
  }

  /** Seed a LEGACY-closed row: a PAYOUT_DROP/PAID row with NO payout_request_id
   * (the pre-refactor settle-company route reset it to null on close) and NO
   * receipt — same "no chek" shape as a Path-B row, but MUST be left alone. */
  async function seedLegacyClosedRow(amount: string): Promise<{ txId: string }> {
    const [tx] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount,
        currency: 'USDT',
        senderId: null,
        senderLabel: 'COMPANY',
        receiverId: DROP_A.id,
        recipientId: DROP_A.id,
        projectId: PROJECT_ID,
        payoutRequestId: null,
        createdBy: ADMIN.id,
      })
      .returning()
    return { txId: tx!.id }
  }

  async function runBackfill(): Promise<void> {
    await _pool!.query(MIGRATION_SQL)
  }

  async function dropBalance(): Promise<number> {
    return (await svc.getDropSelfSummary(DROP_A)).balance
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='pending_obligations' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[drop-share-pending-parity-backfill] SKIPPED — pending_obligations not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[drop-share-pending-parity-backfill] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [DsppTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await db.delete(projects).where(eq(projects.id, PROJECT_ID))
    await clearLedger()
    await db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    await db
      .insert(users)
      .values(
        TEST_OWN_USERS.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.seniorSharePercent,
          ...(u.role === 'DROP' ? { dropSharePercent: 5 } : {}),
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        name: 'DSPP Drop Project',
        companyName: 'DSPP DropCorp',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: DROP_A.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    // Cleanup any backup/session temp artefacts from a PRIOR test run against
    // this same scratch DB so the backup-table assertions below start clean.
    await _pool!
      .query(
        `DELETE FROM _drop_share_pending_parity_backup_20260727 WHERE receiver_id = ANY($1::uuid[])`,
      )
      .catch(() => undefined)
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await clearLedger()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearLedger()
      await dbSvc.db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  it('AC6-a/b/c: converts ONLY the Path-B row (payout_request_id set); leaves the legacy-closed row (payout_request_id NULL) untouched; backs up + books the paired obligation', async () => {
    if (!dbAvailable) return
    const { txId: pathBId, payoutRequestId } = await seedPathBRow('50')
    const { txId: legacyId } = await seedLegacyClosedRow('999')

    await runBackfill()

    // Path-B row: converted.
    const pathBAfter = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, pathBId),
    })
    expect(pathBAfter!.type).toBe('DROP_PENDING_PAYOUT')
    expect(pathBAfter!.status).toBe('PENDING_PAYMENT')
    expect(pathBAfter!.payoutRequestId).toBe(payoutRequestId) // untouched by this script

    // Legacy-closed row (no payout_request_id — pre-refactor settle route):
    // MUST be left exactly as it was (still PAYOUT_DROP/PAID, no obligation).
    const legacyAfter = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, legacyId),
    })
    expect(legacyAfter!.type).toBe('PAYOUT_DROP')
    expect(legacyAfter!.status).toBe('PAID')
    const legacyObligation = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, legacyId),
    })
    expect(legacyObligation).toBeUndefined()

    // Paired pending_obligations row for the converted Path-B row.
    const obligation = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, pathBId),
    })
    expect(obligation).toBeTruthy()
    expect(obligation!.creditorUserId).toBe(DROP_A.id)
    expect(obligation!.debtorType).toBe('COMPANY')
    expect(obligation!.status).toBe('PENDING')
    expect(parseFloat(obligation!.amount)).toBeCloseTo(50, 6)
    expect(obligation!.currency).toBe('USDT')

    // Backup row exists with the ORIGINAL (pre-conversion) state.
    const backupRows = await _pool!.query(
      `SELECT id, type, status FROM _drop_share_pending_parity_backup_20260727 WHERE id = $1`,
      [pathBId],
    )
    expect(backupRows.rowCount).toBe(1)
    expect(backupRows.rows[0].type).toBe('PAYOUT_DROP')
    expect(backupRows.rows[0].status).toBe('PAID')
    // Backup must NOT contain the legacy-closed row (never selected).
    const legacyBackup = await _pool!.query(
      `SELECT id FROM _drop_share_pending_parity_backup_20260727 WHERE id = $1`,
      [legacyId],
    )
    expect(legacyBackup.rowCount).toBe(0)
  })

  it('AC6-d: idempotent — running the backfill a SECOND time changes nothing', async () => {
    if (!dbAvailable) return
    const { txId: pathBId } = await seedPathBRow('75')
    await runBackfill()

    const obligationsBefore = await dbSvc.db
      .select({ id: pendingObligations.id })
      .from(pendingObligations)
      .where(eq(pendingObligations.sourceTransactionId, pathBId))
    expect(obligationsBefore).toHaveLength(1)

    // Second run — must be a no-op (predicate no longer matches the converted row).
    await runBackfill()

    const rowAfterSecondRun = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, pathBId),
    })
    expect(rowAfterSecondRun!.type).toBe('DROP_PENDING_PAYOUT')
    expect(rowAfterSecondRun!.status).toBe('PENDING_PAYMENT')

    const obligationsAfter = await dbSvc.db
      .select({ id: pendingObligations.id })
      .from(pendingObligations)
      .where(eq(pendingObligations.sourceTransactionId, pathBId))
    // Still exactly one — no duplicate obligation booked.
    expect(obligationsAfter).toHaveLength(1)
    expect(obligationsAfter[0]!.id).toBe(obligationsBefore[0]!.id)
  })

  it('AC6-e: round-trip equivalence — convert then settle via settleByCompany restores the EXACT pre-backfill drop balance', async () => {
    if (!dbAvailable) return
    const before = await dropBalance()
    const { txId: pathBId } = await seedPathBRow('120')

    // Baseline: the historical PAYOUT_DROP/PAID row already counts as received.
    const baseline = await dropBalance()
    expect(baseline - before).toBeCloseTo(120, 6)

    await runBackfill()

    // AC3-style: the drop's balance temporarily DROPS by the converted amount
    // — it is pending confirmation again, not yet credited.
    const afterBackfill = await dropBalance()
    expect(afterBackfill).toBeCloseTo(baseline - 120, 6)
    expect(afterBackfill).toBeCloseTo(before, 6)

    // Close it the ORDINARY way — the SAME settleByCompany real admin/accountant
    // path uses, with a mandatory receipt + funding source.
    const obligation = await dbSvc.db.query.pendingObligations.findFirst({
      where: and(
        eq(pendingObligations.sourceTransactionId, pathBId),
        eq(pendingObligations.status, 'PENDING'),
      ),
    })
    expect(obligation).toBeTruthy()
    const settled = await settleSvc.settleByCompany(obligation!.id, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      receiptExternalUrl: 'https://etherscan.io/tx/0xdsppbackfillroundtrip01',
    })
    expect(settled.obligation.status).toBe('PAID')
    const payoutDrop = settled.created.find((c) => c.type === 'PAYOUT_DROP')
    expect(payoutDrop).toBeTruthy()
    expect(payoutDrop!.id).toBe(pathBId) // in-place flip — same row, no phantom.

    // Balance is back to EXACTLY the baseline — the round-trip is lossless.
    const afterSettle = await dropBalance()
    expect(afterSettle).toBeCloseTo(baseline, 6)
  })

  it('AC6-verify: fail-loud when a target cannot get its paired obligation (receiver_id corrupted to NULL) — RAISE EXCEPTION rolls back the WHOLE conversion, including unrelated targets in the same run', async () => {
    if (!dbAvailable) return
    // A normal target (would convert cleanly) alongside a CORRUPTED target
    // (receiver_id forced to NULL — step 2c's INSERT guard "tgt.receiver_id
    // IS NOT NULL" then skips it, so it can never get a paired obligation).
    // targets=2, converted=2 (2b's UPDATE does not filter on receiver_id), but
    // obligations=1 — the mismatch the fail-loud assert exists to catch.
    const { txId: goodId } = await seedPathBRow('10')
    const { txId: corruptId } = await seedPathBRow('20')
    await dbSvc.db
      .update(transactions)
      .set({ receiverId: null, recipientId: null })
      .where(eq(transactions.id, corruptId))

    await expect(runBackfill()).rejects.toThrow(/drop-share-pending-parity verify failed/)

    // Real Postgres ROLLBACK (not a mock) — the whole transaction aborts, so
    // NEITHER row was converted, not even the otherwise-healthy one.
    const goodAfter = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, goodId),
    })
    const corruptAfter = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, corruptId),
    })
    expect(goodAfter!.type).toBe('PAYOUT_DROP')
    expect(goodAfter!.status).toBe('PAID')
    expect(corruptAfter!.type).toBe('PAYOUT_DROP')
    expect(corruptAfter!.status).toBe('PAID')

    // No obligations booked for either — the aborted transaction undid 2c too.
    const obligations = await dbSvc.db
      .select({ id: pendingObligations.id })
      .from(pendingObligations)
      .where(inArray(pendingObligations.sourceTransactionId, [goodId, corruptId]))
    expect(obligations).toHaveLength(0)
  })
})
