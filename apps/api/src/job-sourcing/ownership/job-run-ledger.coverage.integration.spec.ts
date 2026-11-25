import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import { cleanupStore, observation } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageSource } from '../../test/run-aging'
import {
  ABSENT_PER_RUN,
  RUN_ABSENT_REASON_PREFIX,
  enqueueRunAbsentRecords,
} from '../availability/run-absence-producer'
import { createAvailabilityReconcileSteps } from '../runtime/availability-reconcile-worker'
import { RecomputeWorker } from '../runtime/recompute-worker'
import { saveObservationPage } from '../store/source-record.store'
import { type ClaimedRun, JobRunLedger, type RunEnding } from './job-run-ledger'

/**
 * Backlog 470 / 472 — the run's coverage reaches the database, and a run that claims it saw the
 * whole inventory hands every record it did not see to the availability reconciler.
 *
 * It proves what `endRun` writes, that a failed or partial run writes nothing that could close a
 * posting, and the whole chain: the real ledger's runs and dirty rows, consumed by the real
 * reconcile worker, close a posting that left a full inventory and reopen one listed again.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.coverage.integration
 */
const TAG = randomUUID().slice(0, 8)
const NS = `t3spec-${TAG}-cov`
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Records are unique per (type, namespace, identity_key) across sources: ids carry the source id. */
const nativeOf = (s: string, id: string) => `${s}:${id}`
const keyOf = (s: string, id: string) => JSON.stringify([nativeOf(s, id)])
const shortOf = (identityKey: string) => (JSON.parse(identityKey) as string[])[0]!.split(':')[1]!

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let db: ReturnType<typeof drizzle<typeof schema>>

/** Claim a run of `s` (after the daily cadence has passed), save `ids`, end it with `ending`. */
async function runWith(s: string, ids: readonly string[], ending: RunEnding): Promise<ClaimedRun> {
  await ageSource(session.admin, s, 48 * HOUR)
  const run = await kit.claimOne(s)
  // The store takes at most 500 observations a page.
  for (let i = 0; i < ids.length; i += 500) {
    await saveObservationPage(db, handleOf(run), {
      observations: ids
        .slice(i, i + 500)
        .map((id) => observation({ namespace: NS, nativeId: nativeOf(s, id), tag: TAG })),
      checkpoint: specCheckpoint(i / 500 + 1),
    })
  }
  await ledger.finish(handleOf(run), ending)
  return run
}

async function runRow(runId: string) {
  const { rows } = await session.admin.query(
    `SELECT coverage, received, unchanged FROM job_collection_runs WHERE id = $1`,
    [runId],
  )
  return rows[0] as { coverage: string; received: number; unchanged: number }
}

/** The native ids of the records this run enqueued as absent. */
async function absentOf(runId: string): Promise<string[]> {
  const { rows } = await session.admin.query(
    `SELECT r.identity_key FROM job_dirty_work w JOIN job_source_records r ON r.id = w.entity_id
      WHERE w.entity_kind = 'SOURCE_RECORD' AND w.reason = $1 ORDER BY r.identity_key`,
    [`${RUN_ABSENT_REASON_PREFIX}${runId}`],
  )
  return rows.map((r) => shortOf(r.identity_key as string))
}

async function presentIn(runId: string): Promise<string[]> {
  const { rows } = await session.admin.query(
    `SELECT r.identity_key FROM job_run_records rr JOIN job_source_records r ON r.id = rr.source_record_id
      WHERE rr.run_id = $1 ORDER BY r.identity_key`,
    [runId],
  )
  return rows.map((r) => shortOf(r.identity_key as string))
}

const ok = (coverage: RunEnding['coverage'], present?: RunEnding['present']): RunEnding => ({
  outcome: 'SUCCEEDED',
  errorCode: null,
  coverage,
  ...(present !== undefined && { present }),
})

const MISSES_SQL = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-01_job_source_record_inventory_misses.sql',
)

/** Spread a source's runs over time (oldest first), `hoursAgo[i]` for its i-th run. */
async function spreadRuns(s: string, hoursAgo: readonly number[]): Promise<void> {
  const { rows } = await session.admin.query(
    `SELECT id FROM job_collection_runs WHERE source_id = $1 ORDER BY started_at, id`,
    [s],
  )
  expect(rows).toHaveLength(hoursAgo.length)
  for (const [i, r] of rows.entries())
    await session.admin.query(
      `UPDATE job_collection_runs
          SET started_at = started_at - make_interval(secs => $2::double precision / 1000),
              ended_at = ended_at - make_interval(secs => $2::double precision / 1000)
        WHERE id = $1`,
      [r.id, hoursAgo[i]! * HOUR],
    )
}

/** One reconcile-worker pass over exactly this spec's pending rows (dated first, see the S8d spec). */
async function reconcile(): Promise<void> {
  const { rowCount } = await session.admin.query(
    `UPDATE job_dirty_work SET created_at = '2000-01-01T00:00:00Z'::timestamptz + seq * interval '1 ms'
       FROM (SELECT id AS pid, row_number() OVER (ORDER BY created_at, id) AS seq FROM job_dirty_work
              WHERE status = 'PENDING' AND entity_kind = 'SOURCE_RECORD'
                AND entity_id IN (SELECT id FROM job_source_records WHERE namespace = $1)) p
      WHERE id = p.pid`,
    [NS],
  )
  await new RecomputeWorker(createAvailabilityReconcileSteps(db), {
    owner: `cov-${TAG}`,
    batchSize: Math.max(rowCount ?? 0, 1),
  }).runOnce()
}

async function availabilityOf(s: string, id: string): Promise<string> {
  const { rows } = await session.admin.query(
    `SELECT availability FROM job_source_records WHERE source_id = $1 AND identity_key = $2`,
    [s, keyOf(s, id)],
  )
  return String(rows[0]?.availability)
}

describe.skipIf(!hasDatabaseUrl())(
  'run coverage and absence work, as crm_app (backlog 470)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      fx = new LedgerFixtures(session.admin, TAG)
      const catalog = new SpecCatalog()
      db = drizzle(session.pool, { schema })
      ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
      const { rows } = await session.admin.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'cov spec', 'ADMIN') RETURNING id`,
        [`t3cov-${TAG}@example.test`],
      )
      kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
      // The staged S8c table, as the S8d worker spec applies it (idempotent DDL).
      await session.admin.query(readFileSync(MISSES_SQL, 'utf8'))
      await session.admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON job_source_record_inventory_misses TO crm_app`,
      )
    }, 120_000)

    afterAll(async () => {
      if (session === undefined) return
      try {
        await session.admin.query(
          `DELETE FROM job_source_record_inventory_misses WHERE source_record_id IN
             (SELECT id FROM job_source_records WHERE namespace = $1)`,
          [NS],
        )
        await cleanupStore(session.admin, NS, TAG)
        await fx.cleanup()
        await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
      } finally {
        await session.close()
      }
    })

    it('persists FULL_INVENTORY and enqueues exactly the records the full run did not see', async () => {
      const s = await kit.reporting()
      const first = await runWith(s, ['a', 'b', 'c'], ok('FULL_INVENTORY'))
      expect((await runRow(first.runId)).coverage).toBe('FULL_INVENTORY')
      expect(await absentOf(first.runId)).toEqual([])

      const second = await runWith(s, ['a'], ok('FULL_INVENTORY'))
      expect((await runRow(second.runId)).coverage).toBe('FULL_INVENTORY')
      expect(await absentOf(second.runId)).toEqual(['b', 'c'])
    })

    it('a listed-but-held posting is present: its run row is written and counted, so it is not absent', async () => {
      const s = await kit.reporting()
      await runWith(s, ['a', 'b', 'c'], ok('FULL_INVENTORY'))
      const run = await runWith(
        s,
        ['a'],
        ok('FULL_INVENTORY', { held: [keyOf(s, 'b')], quarantined: [keyOf(s, 'c')] }),
      )
      expect(await presentIn(run.runId)).toEqual(['a', 'b', 'c'])
      expect(await absentOf(run.runId)).toEqual([])
      // Only `held` adds to the counters (a quarantined item is already counted as refused); the
      // SUCCEEDED counter CHECK held, or the UPDATE above would have thrown.
      expect(await runRow(run.runId)).toMatchObject({ received: 2, unchanged: 2 })
    })

    it('a FAILED run is stored PARTIAL and enqueues nothing, whatever coverage it was handed', async () => {
      const s = await kit.reporting()
      await runWith(s, ['a', 'b'], ok('FULL_INVENTORY'))
      const failed = await runWith(s, ['a'], {
        outcome: 'FAILED',
        errorCode: 'TRANSIENT_NETWORK',
        coverage: 'FULL_INVENTORY',
      })
      expect((await runRow(failed.runId)).coverage).toBe('PARTIAL')
      expect(await absentOf(failed.runId)).toEqual([])
    })

    it('a SUCCEEDED run without a coverage claim, or a PARTIAL one, enqueues nothing', async () => {
      const s = await kit.reporting()
      await runWith(s, ['a', 'b'], ok('FULL_INVENTORY'))
      const unclaimed = await runWith(s, ['a'], { outcome: 'SUCCEEDED', errorCode: null })
      expect((await runRow(unclaimed.runId)).coverage).toBe('PARTIAL')
      expect(await absentOf(unclaimed.runId)).toEqual([])
      const partial = await runWith(s, ['a'], ok('PARTIAL'))
      expect(await absentOf(partial.runId)).toEqual([])
    })

    it('a WINDOW run enqueues only the records unseen for longer than the source window (3 days)', async () => {
      const s = await kit.reporting()
      await runWith(s, ['a', 'stale', 'recent'], ok('WINDOW'))
      await session.admin.query(
        `UPDATE job_source_records SET last_observed_at = now() - make_interval(secs => $2::double precision / 1000)
        WHERE source_id = $1 AND identity_key = $3`,
        [s, 4 * DAY, keyOf(s, 'stale')],
      )
      await session.admin.query(
        `UPDATE job_source_records SET last_observed_at = now() - make_interval(secs => $2::double precision / 1000)
        WHERE source_id = $1 AND identity_key = $3`,
        [s, 2 * DAY, keyOf(s, 'recent')],
      )
      const run = await runWith(s, ['a'], ok('WINDOW'))
      expect((await runRow(run.runId)).coverage).toBe('WINDOW')
      expect(await absentOf(run.runId)).toEqual(['stale'])
    })

    it('CR-M-3: a WINDOW type with a feed depth enqueues no record older than it', async () => {
      const s = await kit.reporting()
      await runWith(s, ['a', 'old'], ok('WINDOW'))
      const run = await runWith(s, ['a'], ok('WINDOW'))
      await session.admin.query(
        `UPDATE job_source_records SET last_observed_at = now() - interval '22 days',
                first_seen_at = now() - interval '30 days'
          WHERE source_id = $1 AND identity_key = $2`,
        [s, keyOf(s, 'old')],
      )
      const absence = (sourceType: 'THEIRSTACK_API' | 'REMOTIVE_API') =>
        enqueueRunAbsentRecords(db, {
          runId: run.runId,
          sourceId: s,
          sourceType,
          cycleId: null,
          outcome: 'SUCCEEDED',
          coverage: 'WINDOW',
          endedAt: new Date(),
        })
      // TheirStack lists 7 days back: a 30-day-old posting was out of reach, not gone.
      expect(await absence('THEIRSTACK_API')).toBe(0)
      // A type with no known depth (unlimited) queues the same record.
      expect(await absence('REMOTIVE_API')).toBe(1)
      expect(await absentOf(run.runId)).toEqual(['old'])
    })

    describe('the chain: real ledger runs, real reconcile worker', () => {
      it('three full runs without a posting over 24 h close it; a later held listing reopens it', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'b', 'c', 'd'], ok('FULL_INVENTORY'))
        for (let i = 0; i < 3; i += 1) await runWith(s, ['a', 'c', 'd'], ok('FULL_INVENTORY'))
        await spreadRuns(s, [40, 30, 15, 0])
        await reconcile()
        expect(await availabilityOf(s, 'b')).toBe('CLOSED')
        expect(await availabilityOf(s, 'a')).not.toBe('CLOSED')

        // Listed again but held (not re-fetched): present, and the worker reopens it (S8f).
        await runWith(
          s,
          ['a', 'c', 'd'],
          ok('FULL_INVENTORY', { held: [keyOf(s, 'b')], quarantined: [] }),
        )
        await reconcile()
        expect(await availabilityOf(s, 'b')).not.toMatch(/^(CLOSED|EXPIRED)$/)
      })

      it('WINDOW end to end: three WINDOW runs past the window expire the unseen posting, never CLOSED', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'stale'], ok('WINDOW'))
        await session.admin.query(
          `UPDATE job_source_records SET last_observed_at = now() - interval '4 days'
            WHERE source_id = $1 AND identity_key = $2`,
          [s, keyOf(s, 'stale')],
        )
        for (let i = 0; i < 3; i += 1) await runWith(s, ['a'], ok('WINDOW'))
        await reconcile()
        expect(await availabilityOf(s, 'stale')).toBe('EXPIRED')
        expect(await availabilityOf(s, 'a')).not.toMatch(/^(CLOSED|EXPIRED)$/)
      })

      it('WINDOW end to end: page-capped runs (PARTIAL) expire nothing', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'stale'], ok('WINDOW'))
        await session.admin.query(
          `UPDATE job_source_records SET last_observed_at = now() - interval '4 days'
            WHERE source_id = $1 AND identity_key = $2`,
          [s, keyOf(s, 'stale')],
        )
        // What `deriveCoverage` now reports for a capped search (CR-M-4).
        for (let i = 0; i < 3; i += 1) await runWith(s, ['a'], ok('PARTIAL'))
        await reconcile()
        expect(await availabilityOf(s, 'stale')).not.toMatch(/^(CLOSED|EXPIRED)$/)
      })

      it('a failed third run closes nothing: two full misses are not enough', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'b', 'c', 'd'], ok('FULL_INVENTORY'))
        await runWith(s, ['a', 'c', 'd'], ok('FULL_INVENTORY'))
        await runWith(s, ['a', 'c', 'd'], ok('FULL_INVENTORY'))
        await runWith(s, ['a', 'c', 'd'], {
          outcome: 'FAILED',
          errorCode: 'TRANSIENT_NETWORK',
          coverage: 'FULL_INVENTORY',
        })
        await spreadRuns(s, [40, 30, 15, 0])
        await reconcile()
        expect(await availabilityOf(s, 'b')).not.toBe('CLOSED')
      })

      it('a record still waiting on an absence row is not queued again; once drained, it is', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'b'], ok('FULL_INVENTORY'))
        const first = await runWith(s, ['a'], ok('FULL_INVENTORY'))
        const second = await runWith(s, ['a'], ok('FULL_INVENTORY'))
        expect(await absentOf(first.runId)).toEqual(['b'])
        expect(await absentOf(second.runId)).toEqual([])
        await reconcile()
        expect(await availabilityOf(s, 'b')).not.toBe('CLOSED')
        const third = await runWith(s, ['a'], ok('FULL_INVENTORY'))
        expect(await absentOf(third.runId)).toEqual(['b'])
      })

      it('SR-M-2: drained absence work is re-armed, so runs do not grow the queue per record', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'b'], ok('FULL_INVENTORY'))
        for (let i = 0; i < 4; i += 1) {
          await runWith(s, ['a'], ok('FULL_INVENTORY'))
          await reconcile()
        }
        const last = await runWith(s, ['a'], ok('FULL_INVENTORY'))
        expect(await absentOf(last.runId)).toEqual(['b'])
        const { rows } = await session.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM job_dirty_work w
             JOIN job_source_records r ON r.id = w.entity_id
            WHERE w.entity_kind = 'SOURCE_RECORD' AND r.source_id = $1
              AND starts_with(w.reason, $2)`,
          [s, RUN_ABSENT_REASON_PREFIX],
        )
        expect(rows[0]!.n).toBe(1)
      })

      it('past the per-run cap the selection rotates: the record left out first goes first next', async () => {
        const s = await kit.reporting()
        const others = Array.from(
          { length: ABSENT_PER_RUN + 1 },
          (_, i) => `x${String(i).padStart(4, '0')}`,
        )
        await runWith(s, ['a', ...others], ok('FULL_INVENTORY'))
        const first = await runWith(s, ['a'], ok('FULL_INVENTORY'))
        const queued = await absentOf(first.runId)
        expect(queued).toHaveLength(ABSENT_PER_RUN)
        const left = others.filter((id) => !queued.includes(id))
        expect(left).toHaveLength(1)
        // The worker drained them and the source sits in review: every record re-qualifies.
        const drain = () =>
          session.admin.query(
            `UPDATE job_dirty_work SET status = 'DONE', completed_at = now()
              WHERE entity_kind = 'SOURCE_RECORD' AND status = 'PENDING'
                AND entity_id IN (SELECT id FROM job_source_records WHERE source_id = $1)`,
            [s],
          )
        await drain()
        const second = await runWith(s, ['a'], ok('FULL_INVENTORY'))
        expect(await absentOf(second.runId)).toContain(left[0])
        await drain() // keep this source's 1000 rows out of the later chain tests' worker pass
      })

      it('an empty WINDOW run enqueues nothing: it could not expire anyone', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'stale'], ok('WINDOW'))
        await session.admin.query(
          `UPDATE job_source_records SET last_observed_at = now() - interval '4 days' WHERE source_id = $1`,
          [s],
        )
        const empty = await runWith(s, [], ok('WINDOW'))
        expect((await runRow(empty.runId)).received).toBe(0)
        expect(await absentOf(empty.runId)).toEqual([])
        const read = await runWith(s, ['a'], ok('WINDOW'))
        expect(await absentOf(read.runId)).toEqual(['stale'])
      })

      it('a quarantined listing of a CLOSED posting is present but does not reopen it', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'b', 'c', 'd'], ok('FULL_INVENTORY'))
        for (let i = 0; i < 3; i += 1) await runWith(s, ['a', 'c', 'd'], ok('FULL_INVENTORY'))
        await spreadRuns(s, [40, 30, 15, 0])
        await reconcile()
        expect(await availabilityOf(s, 'b')).toBe('CLOSED')

        const run = await runWith(
          s,
          ['a', 'c', 'd'],
          ok('FULL_INVENTORY', { held: [], quarantined: [keyOf(s, 'b')] }),
        )
        expect(await presentIn(run.runId)).toContain('b')
        await reconcile()
        expect(await availabilityOf(s, 'b')).toBe('CLOSED')
      })

      it('an empty full run is no miss: two real misses and an empty run close nothing', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'b', 'c', 'd'], ok('FULL_INVENTORY'))
        await runWith(s, ['a', 'c', 'd'], ok('FULL_INVENTORY'))
        await runWith(s, ['a', 'c', 'd'], ok('FULL_INVENTORY'))
        await runWith(s, [], ok('FULL_INVENTORY'))
        await spreadRuns(s, [40, 30, 15, 0])
        await reconcile()
        expect(await availabilityOf(s, 'b')).not.toBe('CLOSED')
        expect(await availabilityOf(s, 'a')).not.toBe('CLOSED')
      })

      it('a source with no healthy baseline: three empty full runs over 24 h close nothing', async () => {
        const s = await kit.reporting()
        await runWith(s, ['a', 'b'], ok('PARTIAL'))
        for (let i = 0; i < 3; i += 1) await runWith(s, [], ok('FULL_INVENTORY'))
        await spreadRuns(s, [40, 30, 15, 0])
        await reconcile()
        expect(await availabilityOf(s, 'a')).not.toBe('CLOSED')
        expect(await availabilityOf(s, 'b')).not.toBe('CLOSED')
      })
    })
  },
)
