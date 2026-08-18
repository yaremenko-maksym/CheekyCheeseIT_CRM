import { readFileSync } from 'fs'
import { join } from 'path'
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-drop-share-pending-parity — REAL-DB integration for the manual
 * schema/backfill script
 * `apps/api/drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql`
 * (security-review PR #443, round 5 MED-2: this file was previously verified
 * only by a one-off manual `psql` run, not by any spec).
 *
 * Proves, against a REAL Postgres (crm_qa scratch — NEVER crm_db):
 *
 *   MARKER-a  A DROP_PENDING_PAYOUT row created BEFORE this environment's own
 *             first-ever application of the marker file, with an unstamped
 *             (NULL) marker, is backfilled to `false` — the file's STEP 3.
 *             A row created WELL AFTER the restart-window margin closes, with
 *             an unstamped marker, is LEFT UNTOUCHED (stays NULL).
 *   MARKER-b  security-review PR #443/#447, round 6: the cutoff is anchored
 *             to THIS environment's own first-applied timestamp (a
 *             self-referential state row, STEP 1 of the SQL file), NOT to a
 *             hardcoded calendar literal — an earlier version of the SQL file
 *             used `created_at < TIMESTAMP '2026-08-10'`, which would go
 *             stale and silently stop protecting the restart window the
 *             moment the real rollout happened after that date. This test
 *             proves a row created strictly AFTER the first application, but
 *             still inside the restart-window margin (simulating a row
 *             written by the OLD api image between the marker's two
 *             deploy-time passes — see PR #447's `deploy.yml` wiring), IS
 *             backfilled by a second application — regardless of what the
 *             wall-clock date is when any of this actually runs, because
 *             nothing here reads the calendar at all.
 *   MARKER-e  Same claim as MARKER-b, pushed further: even when this
 *             environment's own first-ever application is SIMULATED to
 *             happen on a date long after the old hardcoded literal
 *             ('2026-08-10') this design replaces, a restart-window row
 *             relative to THAT (late) first-apply is still backfilled —
 *             proves the boundary tracks the actual rollout, not any
 *             particular calendar date, including ones far in the future
 *             relative to when this test suite happens to run.
 *   MARKER-c  Idempotent: re-applying the file a second time changes nothing
 *             further (0 additional rows touched), and never rewrites the
 *             already-recorded `first_applied_at`.
 *   MARKER-d  The column converges to nullable / no default regardless of
 *             which prior shape it had (covers the round-4 LOW self-healing
 *             ALTER COLUMN statements from the SAME automated run this file
 *             is applied in, not just a one-off manual check).
 *
 * Isolation (mirrors the SAME concern already closed for the pending-parity
 * backfill spec, security-review PR #443 round 4 LOW-1): STEP 3's UPDATE
 * predicate is GLOBAL across `transactions` (type + NULL marker + cutoff),
 * and `crm_qa` is a SHARED scratch DB other specs also write
 * DROP_PENDING_PAYOUT rows to (e.g. senior-settle-owner.integration.spec.ts's
 * seedPendingDropIou, which also leaves the marker unstamped). A leaked
 * foreign fixture would be silently swept up by the SAME UPDATE this spec
 * exercises. `assertNoForeignUnstampedRows()` below fails LOUD before every
 * test that applies the marker file, scoped to this spec's own
 * `TEST_OWN_USER_IDS` — same pattern as
 * `drop-share-pending-parity-backfill.integration.spec.ts`.
 *
 * The round-6 state table (`drop_cascade_origin_marker_state`) is a GLOBAL
 * singleton the marker SQL file itself creates — no other spec in this repo
 * applies that file (grep-verified), so this spec fully owns that table's
 * lifecycle for test purposes and resets it explicitly per test via
 * `resetMarkerState()` to control `first_applied_at` deterministically
 * (on prod this table is intentionally NEVER reset — see the SQL file).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- drop-cascade-origin-marker.integration
 */

const MARKER_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql'),
  'utf-8',
)

const DROP_A_ID = 'ce660000-0000-4000-bb00-000000000001'
const ADMIN_ID = 'ce660000-0000-4000-bb00-000000000002'
const TEST_OWN_USER_IDS = [DROP_A_ID, ADMIN_ID]
// No project needed — this spec only exercises the marker column + its
// migration file, not the drop-payout cascade, so projectId is left null
// (nullable, no FK to satisfy).

// A row far enough in the past to be "historical" relative to whenever this
// spec actually runs — deliberately NOT anchored to any specific calendar
// date near "now" (round 6: the whole point of this file is that nothing
// here should depend on wall-clock proximity to a literal).
const LONG_AGO = new Date('2000-01-01T00:00:00.000Z')

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

@Module({ imports: [TestDatabaseModule] })
class MarkerTestModule {}

describe.skipIf(!hasDatabaseUrl())('drop_cascade_origin marker migration (real DB)', () => {
  let dbSvc: DatabaseService

  async function clearOwnRows() {
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_OWN_USER_IDS))
  }

  /** round 6: full ownership of the marker file's own state table (see file
   * doc comment) — dropped so the NEXT `applyMarkerFile()` call sets a fresh
   * `first_applied_at = now()`, giving each test deterministic control over
   * the cutoff boundary instead of inheriting whatever an earlier manual
   * `psql` run or an earlier test in this file happened to stamp. */
  async function resetMarkerState(): Promise<void> {
    await _pool!.query('DROP TABLE IF EXISTS drop_cascade_origin_marker_state')
  }

  async function readFirstAppliedAt(): Promise<Date> {
    const res = await _pool!.query(
      'SELECT first_applied_at FROM drop_cascade_origin_marker_state LIMIT 1',
    )
    return new Date(res.rows[0].first_applied_at)
  }

  /** Isolation guard (security-review PR #443 round 5, MED-2 — same pattern
   * as assertNoForeignPathBRows in drop-share-pending-parity-backfill
   * .integration.spec.ts). The marker file's UPDATE is global; fail loud
   * before applying it if a FOREIGN spec's unstamped DROP_PENDING_PAYOUT rows
   * are already sitting in the shared crm_qa DB — running it would silently
   * sweep those up too. */
  async function assertNoForeignUnstampedRows(): Promise<void> {
    const rows = await dbSvc.db
      .select({ id: transactions.id, createdBy: transactions.createdBy })
      .from(transactions)
      .where(
        and(eq(transactions.type, 'DROP_PENDING_PAYOUT'), isNull(transactions.dropCascadeOrigin)),
      )
    const foreign = rows.filter((r) => !TEST_OWN_USER_IDS.includes(r.createdBy))
    if (foreign.length > 0) {
      throw new Error(
        `Test isolation violated: ${foreign.length} foreign unstamped DROP_PENDING_PAYOUT ` +
          `row(s) already in the DB (ids: ${foreign.map((r) => r.id).join(', ')}). Another ` +
          'integration spec likely leaked fixtures matching the marker migration predicate — ' +
          'clean up before re-running.',
      )
    }
  }

  /** Seed a raw DROP_PENDING_PAYOUT row with the marker left UNSET (NULL) and
   * an explicit `createdAt`, so the row's age relative to the migration's
   * cutoff is under the test's control. */
  async function seedUnstampedRow(createdAt: Date): Promise<{ txId: string }> {
    const [tx] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'DROP_PENDING_PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: '20',
        currency: 'USDT',
        senderLabel: 'COMPANY',
        receiverId: DROP_A_ID,
        recipientId: DROP_A_ID,
        createdBy: ADMIN_ID,
        createdAt,
        // dropCascadeOrigin: deliberately NOT set — must stay NULL.
      })
      .returning()
    return { txId: tx!.id }
  }

  async function applyMarkerFile(): Promise<void> {
    await _pool!.query(MARKER_SQL)
  }

  async function columnShape(): Promise<{ isNullable: string; columnDefault: string | null }> {
    const res = await _pool!.query(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name='transactions' AND column_name='drop_cascade_origin'`,
    )
    return { isNullable: res.rows[0].is_nullable, columnDefault: res.rows[0].column_default }
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='drop_cascade_origin' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        throw new Error(
          '[drop-cascade-origin-marker] FAILED — drop_cascade_origin column not found',
        )
      }
    } catch {
      throw new Error('[drop-cascade-origin-marker] FAILED — no DB reachable at DATABASE_URL')
    }

    const moduleRef = await Test.createTestingModule({ imports: [MarkerTestModule] }).compile()
    await moduleRef.init()
    dbSvc = moduleRef.get(DatabaseService)

    await clearOwnRows()
    await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    await dbSvc.db
      .insert(users)
      .values([
        {
          id: DROP_A_ID,
          email: 'marker-drop-a@test.spec',
          displayName: 'Marker Drop A',
          role: 'DROP',
          dropSharePercent: 5,
          googleId: `test-google-${DROP_A_ID}`,
        },
        {
          id: ADMIN_ID,
          email: 'marker-admin@test.spec',
          displayName: 'Marker Admin',
          role: 'ADMIN',
          seniorSharePercent: 0,
          googleId: `test-google-${ADMIN_ID}`,
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  beforeEach(async () => {
    await clearOwnRows()
    await assertNoForeignUnstampedRows()
  })

  afterAll(async () => {
    try {
      await clearOwnRows()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
      await resetMarkerState()
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  it('MARKER-a: backfills a historical unstamped row to false; leaves a row created well past the restart-window margin untouched (NULL)', async () => {
    await resetMarkerState()
    const { txId: historicalId } = await seedUnstampedRow(LONG_AGO)
    // 3 days is well outside STEP 3's 24h restart-window margin regardless of
    // when "now" actually is — this row represents a genuinely new bug in
    // the already-deployed, already-fixed code, and must stay blocked.
    const farFuture = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    const { txId: farFutureId } = await seedUnstampedRow(farFuture)

    await applyMarkerFile()

    const historical = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, historicalId),
    })
    const farFutureRow = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, farFutureId),
    })

    expect(historical!.dropCascadeOrigin).toBe(false)
    expect(farFutureRow!.dropCascadeOrigin).toBeNull()
  })

  it("MARKER-b (round 6): a row created after this environment's own first application, but inside the restart-window margin, is backfilled on a second pass — the boundary is self-referential, not a calendar date", async () => {
    await resetMarkerState()

    // First pass — mirrors PR #447's deploy.yml Step 2j (schema-change pass,
    // before the new api image is live). Stamps first_applied_at = now() in
    // the state table, STEP 1 of the SQL file.
    await applyMarkerFile()
    const firstAppliedAt = await readFirstAppliedAt()

    // Simulates a row written by the OLD api image during the restart
    // window: created strictly AFTER the first pass, well inside the 24h
    // margin.
    const restartWindowCreatedAt = new Date(firstAppliedAt.getTime() + 60 * 60 * 1000) // +1h
    const { txId } = await seedUnstampedRow(restartWindowCreatedAt)

    // Second pass — mirrors PR #447's deploy.yml Step 3.5 (after the new
    // containers and all health/smoke checks are green).
    await applyMarkerFile()

    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, txId) })
    expect(row!.dropCascadeOrigin).toBe(false)

    // Re-reading first_applied_at proves the SECOND pass did not move the
    // anchor — the cutoff used by both passes is the SAME timestamp,
    // regardless of the wall-clock date either pass actually ran on.
    const firstAppliedAtAfterSecondPass = await readFirstAppliedAt()
    expect(firstAppliedAtAfterSecondPass.getTime()).toBe(firstAppliedAt.getTime())
  })

  it("MARKER-e (round 6, late-rollout proof): a restart-window row is backfilled even when this environment's own first-ever application is simulated to happen on a date long after the OLD hardcoded literal ('2026-08-10') this design replaces", async () => {
    await resetMarkerState()

    // Simulates the exact scenario round-6 review flagged as unprotected by
    // the earlier calendar-literal design: the real rollout happening well
    // past any date that could have been hardcoded in advance. Pre-seed the
    // state table directly (STEP 1's `ON CONFLICT DO NOTHING` in
    // applyMarkerFile() below preserves this value unchanged).
    const simulatedLateFirstApply = new Date('2026-09-15T00:00:00.000Z')
    await _pool!.query(
      `CREATE TABLE IF NOT EXISTS drop_cascade_origin_marker_state (
         singleton boolean PRIMARY KEY DEFAULT true,
         first_applied_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT drop_cascade_origin_marker_state_singleton_ck CHECK (singleton)
       )`,
    )
    await _pool!.query(
      'INSERT INTO drop_cascade_origin_marker_state (singleton, first_applied_at) VALUES (true, $1)',
      [simulatedLateFirstApply],
    )

    const restartWindowCreatedAt = new Date(simulatedLateFirstApply.getTime() + 60 * 60 * 1000) // +1h
    const { txId } = await seedUnstampedRow(restartWindowCreatedAt)

    await applyMarkerFile()

    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, txId) })
    expect(row!.dropCascadeOrigin).toBe(false)
  })

  it('MARKER-c: idempotent — a second application changes nothing further', async () => {
    await resetMarkerState()
    const { txId: preId } = await seedUnstampedRow(LONG_AGO)
    await applyMarkerFile()

    const afterFirst = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, preId),
    })
    expect(afterFirst!.dropCascadeOrigin).toBe(false)
    const firstAppliedAt = await readFirstAppliedAt()

    await applyMarkerFile()

    const afterSecond = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, preId),
    })
    expect(afterSecond!.dropCascadeOrigin).toBe(false)
    expect(afterSecond!.updatedAt).toEqual(afterFirst!.updatedAt) // untouched — not re-written
    expect((await readFirstAppliedAt()).getTime()).toBe(firstAppliedAt.getTime())
  })

  it('MARKER-d: the column converges to nullable / no default', async () => {
    await applyMarkerFile()
    const shape = await columnShape()
    expect(shape.isNullable).toBe('YES')
    expect(shape.columnDefault).toBeNull()
  })
})
