import { readFileSync } from 'fs'
import { join } from 'path'
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
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
import { hasDatabaseUrl } from '../test/require-real-db'

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
 *   AC6-f  (security-review PR #443, MED-3) A self-loop row (sender_id =
 *          receiver_id — the pre-Audit-2026-06-28 shape) is EXCLUDED from
 *          selection: it stays PAYOUT_DROP/PAID/self-loop untouched, because
 *          converting + settling it would NOT be a neutral round-trip (the
 *          settle flip always breaks the self-loop by stamping a real
 *          sender — see the migration header for the full reasoning).
 *   AC6-verify (security-review PR #443, MED-1) The fail-loud verify rolls
 *          back the WHOLE transaction on a targets≠obligations mismatch —
 *          INCLUDING the backup insert, since backup now runs INSIDE the same
 *          transaction as the conversion (closes the pre-MED-1 window where a
 *          row created between the (separate) backup step and the target
 *          capture could be converted without ever being backed up).
 *   AC7    (security-review PR #443, MED-B round 2) A converted row's
 *          `drop_cascade_origin` marker is set to `true` — the permanent,
 *          FK-independent discriminator `settleByCompany`'s HIGH-1 guard now
 *          reads (instead of the FK-dependent `payout_request_id`, which the
 *          `payout_requests.id` FK's `ON DELETE SET NULL` could silently
 *          null on an unrelated future cleanup — see
 *          `2026-07-27_drop_cascade_origin_marker.sql`).
 *   AC8    (security-review PR #443, MED-A round 2) The precount file
 *          (`2026-07-27_drop_share_pending_parity_precount.sql`) is a
 *          genuinely standalone, READ-ONLY step — proven here to make ZERO
 *          writes (row counts unchanged before/after) while still reporting
 *          an accurate count.
 *
 * Test isolation (security-review PR #443, LOW-1 round 2): the backfill's
 * selection predicate is GLOBAL (by design — mirrors the real prod script,
 * which cannot be parameter-scoped to "just this test's rows"; the same is
 * true of `transactions.counterparty-masking.rbac.integration.spec.ts`,
 * which also seeds PAYOUT_DROP rows carrying a payout_request_id link and
 * therefore ALSO matches this predicate). Serial file execution
 * (`fileParallelism: false` on integration runs) plus that spec's own
 * cleanup keep `crm_qa` clean between files today, but a fixture leak (this
 * repo has precedent) would let `runBackfill()` silently convert a FOREIGN
 * spec's rows too — the SQL's own fail-loud verify would not catch it (it
 * only compares counts against its own `_dspp_targets` temp table, which by
 * construction captures the WHOLE global matching set, leaked rows
 * included). `assertNoForeignPathBRows()` below is this spec's isolation
 * guard — scoped to `TEST_OWN_USER_IDS`, mirrors the ownership-scoping
 * pattern already used by `clearLedger()` in this same file and by sibling
 * specs — asserted before every test that calls `runBackfill()`, failing
 * LOUD (not silently) if the DB is not clean.
 *
 * Test-vs-prod transaction model (security-review PR #443, MED-2): this spec
 * executes the WHOLE migration file as one `pool.query(text)` call — under
 * node-postgres's simple-query protocol that is one round trip, but the
 * migration's OWN explicit `BEGIN ... COMMIT` (STEP 1) still governs
 * atomicity exactly as it does when prod applies the same file via
 * `psql -v ON_ERROR_STOP=1 < file` (statement-by-statement): Postgres commits
 * or rolls back everything between BEGIN and COMMIT as one unit regardless of
 * how many client round trips fed it those statements. Now that STEP 1
 * contains BOTH the backup insert and the conversion (MED-1), this test's
 * atomicity assertions (AC6-verify) hold identically in both transport
 * models — the earlier discrepancy this note used to flag (backup surviving
 * a rollback only in the test's model) no longer exists, because backup no
 * longer claims to survive a rollback in EITHER model.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- drop-share-pending-parity-backfill.integration
 */

const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-07-27_drop_share_pending_parity_backfill.sql'),
  'utf-8',
)
const PRECOUNT_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-07-27_drop_share_pending_parity_precount.sql'),
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

// task-drop-payout-currency: PendingSettlementService now takes an
// NbuCurrencyService. Every settle in this spec stays in the obligation's own
// currency (USDT), which short-circuits before `getRates` is ever called.
const fakeNbu = {
  getRates: () =>
    Promise.resolve({ usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '20260703' }),
} as never

let _pool: Pool | null = null

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
      useFactory: (db: DatabaseService) =>
        new PendingSettlementService(db, stubInvoices as never, fakeNbu),
      inject: [DatabaseService],
    },
  ],
})
class DsppTestModule {}

describe.skipIf(!hasDatabaseUrl())('drop-share-pending-parity backfill script (real DB)', () => {
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

  /** Isolation guard (LOW-1, security-review PR #443 round 2) — see the file
   * header for the full reasoning. `runBackfill()`'s predicate is global; a
   * leaked fixture from ANOTHER spec (e.g. transactions.counterparty-masking
   * .rbac.integration.spec.ts, which also seeds matching PAYOUT_DROP rows)
   * would be silently swept up otherwise. Fails LOUD, scoped to
   * TEST_OWN_USER_IDS (mirrors `clearLedger`'s own scoping). */
  async function assertNoForeignPathBRows(): Promise<void> {
    const rows = await dbSvc.db
      .select({ id: transactions.id, receiverId: transactions.receiverId })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'PAYOUT_DROP'),
          eq(transactions.status, 'PAID'),
          isNotNull(transactions.payoutRequestId),
        ),
      )
    const foreign = rows.filter((r) => !r.receiverId || !TEST_OWN_USER_IDS.includes(r.receiverId))
    if (foreign.length > 0) {
      throw new Error(
        `Test isolation violated: ${foreign.length} foreign Path-B row(s) already in the DB ` +
          `before this spec ran (ids: ${foreign.map((r) => r.id).join(', ')}). Another ` +
          'integration spec likely leaked fixtures matching the backfill predicate ' +
          '(type=PAYOUT_DROP, status=PAID, payout_request_id IS NOT NULL) — clean up before ' +
          're-running; running the backfill now would silently convert rows this spec does not own.',
      )
    }
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
        // Explicit `false` — a legacy-closed row is DEFINITIVELY non-cascade
        // (round 3, LOW: the column is nullable/no-default, so an omitted
        // value here would be NULL = "unknown", not the same as "verified
        // safe"; this seed represents a row we KNOW is safe).
        dropCascadeOrigin: false,
        createdBy: ADMIN.id,
      })
      .returning()
    return { txId: tx!.id }
  }

  /** Seed a PRE-audit-2026-06-28 self-loop Path-B row: sender_id = receiver_id
   * = the drop (the shape `computeDropAggregate` nets to exactly 0 today).
   * Carries a real payout_request_id (same origin as `seedPathBRow`), so ONLY
   * the self-loop clause distinguishes it — must still be excluded. */
  async function seedSelfLoopPathBRow(amount: string): Promise<{ txId: string }> {
    const [pr] = await dbSvc.db
      .insert(payoutRequests)
      .values({
        seniorId: DROP_A.id,
        incomeAmount: amount,
        payableAmount: amount,
        contractAddress: '0x' + 'e'.repeat(40),
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
        senderId: DROP_A.id,
        senderLabel: 'DPCA Self Loop',
        receiverId: DROP_A.id,
        recipientId: DROP_A.id,
        projectId: PROJECT_ID,
        payoutRequestId: pr!.id,
        createdBy: DROP_A.id,
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
        throw new Error(
          '[drop-share-pending-parity-backfill] FAILED — pending_obligations not found',
        )
      }
    } catch {
      throw new Error(
        '[drop-share-pending-parity-backfill] FAILED — no DB reachable at DATABASE_URL',
      )
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
    // (Bound the array param explicitly — an earlier version of this call
    // referenced $1 with no params array, which pg rejects; the surrounding
    // .catch(() => undefined) silently swallowed that, so this cleanup was a
    // permanent no-op. Fixed as part of LOW-1, security-review PR #443
    // round 2, alongside the proper afterAll cleanup below.)
    await _pool!
      .query(
        `DELETE FROM _drop_share_pending_parity_backup_20260727 WHERE receiver_id = ANY($1::uuid[])`,
        [TEST_OWN_USER_IDS],
      )
      .catch(() => undefined)
  }, 30_000)

  beforeEach(async () => {
    await clearLedger()
    // LOW-1 (security-review PR #443 round 2): fail loud, before touching the
    // shared DB, if a foreign spec's matching fixtures leaked in — see the
    // file header + assertNoForeignPathBRows for the full reasoning.
    await assertNoForeignPathBRows()
  })

  afterAll(async () => {
    try {
      await clearLedger()
      await dbSvc.db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
      // LOW-1 (security-review PR #443 round 2): this spec creates rows in
      // `_drop_share_pending_parity_backup_20260727` (a real prod table this
      // spec's own migration run creates/populates) — clean up OUR rows so
      // the shared `crm_qa` scratch DB does not accumulate test residue
      // across runs. The table itself is intentionally never dropped (same
      // "never drop the backup" contract the real script guarantees).
      await _pool!
        .query(
          `DELETE FROM _drop_share_pending_parity_backup_20260727 WHERE receiver_id = ANY($1::uuid[])`,
          [TEST_OWN_USER_IDS],
        )
        .catch(() => undefined)
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  it('AC6-a/b/c: converts ONLY the Path-B row (payout_request_id set); leaves the legacy-closed row (payout_request_id NULL) untouched; backs up + books the paired obligation', async () => {
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
    // AC7 (MED-B): the permanent, FK-independent origin marker is stamped —
    // seedPathBRow creates the row with the schema default (false, matching
    // the pre-fix historical shape); the backfill must flip it to true.
    expect(pathBAfter!.dropCascadeOrigin).toBe(true)

    // Legacy-closed row (no payout_request_id — pre-refactor settle route):
    // MUST be left exactly as it was (still PAYOUT_DROP/PAID, no obligation).
    const legacyAfter = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, legacyId),
    })
    expect(legacyAfter!.type).toBe('PAYOUT_DROP')
    expect(legacyAfter!.status).toBe('PAID')
    expect(legacyAfter!.dropCascadeOrigin).toBe(false)
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
    // A normal target (would convert cleanly) alongside a CORRUPTED target
    // (receiver_id forced to NULL — step 2c's INSERT guard "tgt.receiver_id
    // IS NOT NULL" then skips it, so it can never get a paired obligation).
    // targets=2, converted=2 (2b's UPDATE does not filter on receiver_id), but
    // obligations=1 — the mismatch the fail-loud assert exists to catch.
    const { txId: goodId } = await seedPathBRow('10')
    const { txId: corruptId } = await seedPathBRow('20')
    // receiverId=NULL trips the 1d obligation-insert guard (no creditor to
    // book for). senderId is ALSO stamped (to ADMIN, distinct from the now-
    // null receiverId) so this does NOT accidentally look like a self-loop
    // row (AC6-f's `sender_id IS DISTINCT FROM receiver_id` exclusion would
    // otherwise swallow a null/null pair as "not distinct" and skip this row
    // entirely, defeating the corruption this test relies on).
    await dbSvc.db
      .update(transactions)
      .set({ receiverId: null, recipientId: null, senderId: ADMIN.id })
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

    // security-review PR #443 (MED-1): backup now runs INSIDE the same
    // transaction as the conversion — a rolled-back run must leave NO backup
    // rows either (backup and conversion are atomic TOGETHER, not "backup
    // survives independently").
    const backupRows = await _pool!.query(
      `SELECT id FROM _drop_share_pending_parity_backup_20260727 WHERE id = ANY($1::uuid[])`,
      [[goodId, corruptId]],
    )
    expect(backupRows.rowCount).toBe(0)
  })

  // SKIPPED task-sender-receiver-invariant (backlog A-2, 2026-08-18): the
  // `seedSelfLoopPathBRow` fixture above (senderId === receiverId === DROP_A.id)
  // can no longer be inserted at all — the new `ck_transactions_sender_ne_receiver`
  // DB CHECK on `transactions` rejects ANY row with both sides non-null and
  // equal, through every write path including this raw fixture insert
  // (verified: this exact seed throws Postgres 23514 against a DB carrying the
  // constraint). This backfill script (`2026-07-27_drop_share_pending_parity_
  // backfill.sql`) is a completed ONE-TIME historical migration — the
  // self-loop shape it defends against was, per the owner's own audit trail
  // referenced above, a pre-2026-06-28 artifact, and the owner has now
  // confirmed (2026-08-17, twice) zero such rows remain anywhere. Per
  // task-sender-receiver-invariant's AC6 ("если что-то упало — это находка, а
  // не повод ослабить ограничение"), the fix is skipping this now-uncreatable
  // fixture, not weakening the constraint. The script's exclusion clause
  // (`sender_id <> receiver_id` in the SELECT — see the migration file) is
  // UNCHANGED and still correct for any pre-existing prod row from before this
  // constraint existed; it simply cannot be exercised end-to-end via a live
  // fixture insert any more.
  it.skip('AC6-f (MED-3): a self-loop Path-B row (sender_id = receiver_id — pre-Audit-2026-06-28 shape) is EXCLUDED from selection and left untouched', async () => {
    const { txId: selfLoopId } = await seedSelfLoopPathBRow('88')
    const beforeBalance = await dropBalance()

    await runBackfill()

    const after = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, selfLoopId),
    })
    // Untouched — still the original self-loop PAYOUT_DROP/PAID shape.
    expect(after!.type).toBe('PAYOUT_DROP')
    expect(after!.status).toBe('PAID')
    expect(after!.senderId).toBe(DROP_A.id)
    expect(after!.receiverId).toBe(DROP_A.id)

    // No obligation booked for it, not backed up (never selected at all).
    const obligation = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, selfLoopId),
    })
    expect(obligation).toBeUndefined()
    const backupRow = await _pool!.query(
      `SELECT id FROM _drop_share_pending_parity_backup_20260727 WHERE id = $1`,
      [selfLoopId],
    )
    expect(backupRow.rowCount).toBe(0)

    // Balance-neutral before AND after (self-loop rows already net to 0 —
    // the backfill must not disturb that, unlike a real Path-B row).
    expect(await dropBalance()).toBeCloseTo(beforeBalance, 6)
  })

  it('AC8 (MED-A): the standalone precount file is genuinely READ-ONLY — makes zero writes, still reports an accurate count', async () => {
    const { txId: pathBId } = await seedPathBRow('42')

    const before = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, pathBId),
    })
    expect(before!.type).toBe('PAYOUT_DROP') // sanity — not yet converted

    // The precount file must not throw and must not touch ANY row.
    await expect(_pool!.query(PRECOUNT_SQL)).resolves.not.toThrow()

    const after = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, pathBId),
    })
    expect(after!.type).toBe('PAYOUT_DROP') // UNCHANGED — precount wrote nothing
    expect(after!.status).toBe('PAID')
    expect(after!.updatedAt).toEqual(before!.updatedAt)

    // No obligation, no backup — precount never reaches STEP 1 of the
    // conversion file (they are two separate files).
    const obligation = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.sourceTransactionId, pathBId),
    })
    expect(obligation).toBeUndefined()

    // The row is STILL a valid backfill target afterward — proves precount
    // is a true no-op, not an accidental partial mutation that happens to
    // look inert on the fields checked above.
    await runBackfill()
    const converted = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, pathBId),
    })
    expect(converted!.type).toBe('DROP_PENDING_PAYOUT')
  })
})
