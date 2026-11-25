import { randomUUID } from 'node:crypto'
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
import { RUN_ABSENT_REASON_PREFIX } from '../availability/run-absence-producer'
import { saveObservationPage } from '../store/source-record.store'
import { type ClaimedRun, JobRunLedger, type RunEnding } from './job-run-ledger'

/**
 * Backlog 470 / 472 — the run's coverage reaches the database, and a run that claims it saw the
 * whole inventory hands every record it did not see to the availability reconciler.
 *
 * The reconciler's side (three absent FULL_INVENTORY runs over 24 h close a record) is pinned by
 * `availability-reconcile-worker.integration.spec.ts` AC1; this spec proves the producer end: what
 * `endRun` writes, and that a failed or partial run writes nothing that could close a posting.
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
  if (ids.length > 0) {
    await saveObservationPage(db, handleOf(run), {
      observations: ids.map((id) =>
        observation({ namespace: NS, nativeId: nativeOf(s, id), tag: TAG }),
      ),
      checkpoint: specCheckpoint(1),
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
    }, 120_000)

    afterAll(async () => {
      if (session === undefined) return
      try {
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
  },
)
