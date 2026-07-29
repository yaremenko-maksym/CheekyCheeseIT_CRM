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

/**
 * task-drop-share-pending-parity — REAL-DB integration for the manual
 * schema/backfill script
 * `apps/api/drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql`
 * (security-review PR #443, round 5 MED-2: this file was previously verified
 * only by a one-off manual `psql` run, not by any spec).
 *
 * Proves, against a REAL Postgres (crm_qa scratch — NEVER crm_db):
 *
 *   MARKER-a  A DROP_PENDING_PAYOUT row created BEFORE the rollout-window
 *             cutoff, with an unstamped (NULL) marker, is backfilled to
 *             `false` — the file's STEP 2.
 *   MARKER-b  A DROP_PENDING_PAYOUT row created AFTER the cutoff, with an
 *             unstamped marker, is LEFT UNTOUCHED (stays NULL) — the
 *             `created_at` bound (security-review PR #443, round 5 MED-1)
 *             that makes it safe to leave this file wired in `deploy.yml`
 *             permanently: a future insert path that forgets to stamp the
 *             column must stay blocked, not be silently patched to `false`
 *             on the next deploy.
 *   MARKER-c  Idempotent: re-applying the file a second time changes
 *             nothing further (0 additional rows touched).
 *   MARKER-d  The column converges to nullable / no default regardless of
 *             which prior shape it had (covers the round-4 LOW self-healing
 *             ALTER COLUMN statements from the SAME automated run this file
 *             is applied in, not just a one-off manual check).
 *
 * Isolation (mirrors the SAME concern already closed for the pending-parity
 * backfill spec, security-review PR #443 round 4 LOW-1): STEP 2's UPDATE
 * predicate is GLOBAL across `transactions` (type + NULL marker + date), and
 * `crm_qa` is a SHARED scratch DB other specs also write
 * DROP_PENDING_PAYOUT rows to (e.g. senior-settle-owner.integration.spec.ts's
 * seedPendingDropIou, which also leaves the marker unstamped). A leaked
 * foreign fixture would be silently swept up by the SAME UPDATE this spec
 * exercises. `assertNoForeignUnstampedRows()` below fails LOUD before every
 * test that applies the marker file, scoped to this spec's own
 * `TEST_OWN_USER_IDS` — same pattern as
 * `drop-share-pending-parity-backfill.integration.spec.ts`.
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

// Straddles the rollout-window cutoff hard-coded in the marker file's STEP 2
// (`created_at < TIMESTAMP '2026-08-10'`). Not imported — this is a manual
// SQL file, not a TS module — so a drift between the two literals is a
// visible, deliberate edit (this file's own name), not silent.
const BEFORE_CUTOFF = new Date('2025-01-01T00:00:00.000Z')
const AFTER_CUTOFF = new Date('2026-09-01T00:00:00.000Z')

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

@Module({ imports: [TestDatabaseModule] })
class MarkerTestModule {}

describe('drop_cascade_origin marker migration (real DB)', () => {
  let dbSvc: DatabaseService

  async function clearOwnRows() {
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_OWN_USER_IDS))
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
        console.warn('[drop-cascade-origin-marker] SKIPPED — drop_cascade_origin column not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[drop-cascade-origin-marker] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
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
    if (!dbAvailable) return
    await clearOwnRows()
    await assertNoForeignUnstampedRows()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearOwnRows()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  it('MARKER-a/b: backfills an unstamped row created BEFORE the cutoff to false; leaves one created AFTER the cutoff untouched (NULL)', async () => {
    if (!dbAvailable) return
    const { txId: preId } = await seedUnstampedRow(BEFORE_CUTOFF)
    const { txId: postId } = await seedUnstampedRow(AFTER_CUTOFF)

    await applyMarkerFile()

    const pre = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, preId) })
    const post = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, postId) })

    expect(pre!.dropCascadeOrigin).toBe(false)
    // MED-1 (round 5): a row created AFTER the cutoff must NEVER be silently
    // patched — this is what makes leaving the file wired forever safe.
    expect(post!.dropCascadeOrigin).toBeNull()
  })

  it('MARKER-c: idempotent — a second application changes nothing further', async () => {
    if (!dbAvailable) return
    const { txId: preId } = await seedUnstampedRow(BEFORE_CUTOFF)
    await applyMarkerFile()

    const afterFirst = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, preId),
    })
    expect(afterFirst!.dropCascadeOrigin).toBe(false)

    await applyMarkerFile()

    const afterSecond = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, preId),
    })
    expect(afterSecond!.dropCascadeOrigin).toBe(false)
    expect(afterSecond!.updatedAt).toEqual(afterFirst!.updatedAt) // untouched — not re-written
  })

  it('MARKER-d: the column converges to nullable / no default', async () => {
    if (!dbAvailable) return
    await applyMarkerFile()
    const shape = await columnShape()
    expect(shape.isNullable).toBe('YES')
    expect(shape.columnDefault).toBeNull()
  })
})
