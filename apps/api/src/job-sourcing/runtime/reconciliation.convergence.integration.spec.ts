import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
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
import { claimDirtyBatch, recoverExpiredDirty } from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import { saveObservationPage } from '../store/source-record.store'
import { loadRoster } from './recompute-inputs'
import { RecomputeWorker, createRecomputeSteps } from './recompute-worker'
import { periodBucket, reconcileOnce } from './reconciliation'

/**
 * r5 Task 4.6 S4b round 3 (CR-M-2, SR-M-1): the sweep and the recompute worker converge on a real
 * Postgres, as `crm_app`. The sweep is scoped with `onlyIds` to this spec's opportunities, and the
 * worker claims only this spec's rows (they are dated in the year 2000 so they sort first), so no
 * other suite's data is touched. Fixtures are removed in `afterAll`.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `s4b3-${TAG}`
const NAMESPACE = `${PREFIX}-ns`
const PERIOD_MS = 6 * 3_600_000
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0)

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let senior: string
let team: string
let seq = 0
const oppIds: string[] = []

/** A record, resolved and evaluated to its first match; returns the opportunity id. */
async function opportunity(nativeId: string, rowless = false): Promise<string> {
  seq += 1
  const base = observation({ namespace: NAMESPACE, nativeId, version: 'v1', tag: TAG })
  // A posting no senior's stack can match: the verdict is a plain mismatch, which writes no rows.
  const obs = rowless
    ? {
        ...base,
        normalized: {
          ...base.normalized,
          title: 'Senior Zzznomatch Engineer',
          tags: ['zzznomatch'],
        },
      }
    : base
  const [saved] = await saveObservationPage(db, run, {
    observations: [obs],
    checkpoint: specCheckpoint(seq),
  })
  const recordId = saved?.recordId as string
  await runMine() // resolves the record onto an opportunity
  const o = await opportunityOf(recordId)
  oppIds.push(o)
  await runMine() // evaluates it
  return o
}

const MINE = `entity_id IN (SELECT id FROM job_source_records WHERE namespace = $1)
  OR entity_id IN (SELECT s.opportunity_id FROM job_opportunity_sources s
                     JOIN job_source_records r ON r.id = s.source_record_id WHERE r.namespace = $1)`

async function pin(): Promise<number> {
  const { rowCount } = await session.admin.query(
    `UPDATE job_dirty_work SET created_at = '2000-01-01T00:00:00Z'::timestamptz + seq * interval '1 ms'
       FROM (SELECT id AS pid, row_number() OVER (ORDER BY entity_kind DESC, created_at, id) AS seq
               FROM job_dirty_work WHERE status = 'PENDING' AND (${MINE})) p
      WHERE id = p.pid`,
    [NAMESPACE],
  )
  return rowCount ?? 0
}

/** One worker run over exactly this spec's pending rows (0 when there are none). */
async function runMine() {
  const n = await pin()
  if (n === 0) return { claimed: 0 }
  return new RecomputeWorker(createRecomputeSteps(db), {
    owner: `s4b3-${TAG}`,
    batchSize: n,
  }).runOnce()
}

async function opportunityOf(recordId: string): Promise<string> {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id FROM job_opportunity_sources WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [recordId],
  )
  return rows[0]?.opportunity_id as string
}

async function dirtyOf(o: string) {
  const { rows } = await session.admin.query(
    `SELECT id, status, reason, target_version FROM job_dirty_work
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason LIKE 'RECONCILE:%'
      ORDER BY created_at, id`,
    [o],
  )
  return rows as { id: string; status: string; reason: string; target_version: number }[]
}

async function matchVersions(o: string) {
  const { rows } = await session.admin.query(
    `SELECT senior_profile_version AS p, exclusion_version AS e FROM job_opportunity_matches
      WHERE opportunity_id = $1 AND senior_id = $2`,
    [o, senior],
  )
  return rows[0] as { p: string; e: string } | undefined
}

const sweep = (o: string, now = T0) => reconcileOnce(db, { onlyIds: [o], now: () => now })
const makeStale = (o: string) =>
  session.admin.query(
    `UPDATE job_opportunity_matches SET senior_profile_version = 'STALE' WHERE opportunity_id = $1`,
    [o],
  )

describe.skipIf(!hasDatabaseUrl())(
  'reconciliation converges against Postgres (S4b round 3)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession({ appPoolMax: 4 })
      const { rows: cur } = await session.admin.query(`SELECT current_database() AS db`)
      if (cur[0].db === 'crm_db') throw new Error('refusing the live database')
      fx = new LedgerFixtures(session.admin, TAG)
      const catalog = new SpecCatalog()
      db = drizzle(session.pool, { schema })
      const ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
      const { rows: admins } = await session.admin.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'S4b3 spec admin', 'ADMIN') RETURNING id`,
        [`s4b3-admin-${TAG}@example.test`],
      )
      kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
      run = handleOf(await kit.claimOne(await kit.reporting({ type: 'REMOTIVE_API' })))
      const { rows: seniors } = await session.admin.query(
        `INSERT INTO users (email, display_name, role, tech_stack)
       VALUES ($1, 'S4b3 spec senior', 'SENIOR', ARRAY['Go']) RETURNING id`,
        [`s4b3-senior-${TAG}@example.test`],
      )
      senior = seniors[0].id as string
      const { rows: teams } = await session.admin.query(
        `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
        [`s4b3-team-${TAG}`],
      )
      team = teams[0].id as string
      await session.admin.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [
        team,
        senior,
      ])
    })

    afterAll(async () => {
      if (session === undefined) return
      try {
        await session.admin.query(
          `DELETE FROM job_queue_assignments WHERE assignee_id = $1 OR assignee_id = $2`,
          [kit.actor, senior],
        )
        await session.admin.query(`DELETE FROM job_exclusion_filters WHERE senior_id = $1`, [
          senior,
        ])
        await cleanupStore(session.admin, PREFIX, TAG)
        await fx.cleanup()
        await session.admin.query(`DELETE FROM team_members WHERE team_id = $1`, [team])
        await session.admin.query(`DELETE FROM teams WHERE id = $1`, [team])
        await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          [kit.actor, senior],
        ])
      } finally {
        await session.close()
      }
    })

    it('CR-M-2: sweep -> worker -> sweep again enqueues nothing', async () => {
      const o = await opportunity('converge')
      expect(await matchVersions(o)).toBeDefined()
      expect(await sweep(o)).toMatchObject({ scanned: 1, stale: 0, enqueued: 0 })

      await makeStale(o)
      expect(await sweep(o)).toMatchObject({ scanned: 1, stale: 1, enqueued: 1, skipped: 0 })
      expect(await sweep(o)).toMatchObject({ stale: 1, enqueued: 0, skipped: 1 }) // in flight

      expect(await runMine()).toMatchObject({ claimed: 1, done: 1, failed: 0 })
      const live = (await loadRoster(db)).versions.get(senior)
      expect(await matchVersions(o)).toEqual({ p: live?.profile, e: live?.exclusion })
      expect(await sweep(o)).toMatchObject({ scanned: 1, stale: 0, enqueued: 0, skipped: 0 })
    }, 60_000)

    it('CR-M-5: a genuinely row-less verdict converges: the worker writes the DONE row, the next sweeps enqueue nothing', async () => {
      const o = await opportunity('zero-rows', true)
      const none = () =>
        session.admin.query(`SELECT 1 FROM job_opportunity_matches WHERE opportunity_id = $1`, [o])
      // Evaluated by the worker (opportunity() ran it) and it wrote no rows for anyone.
      expect((await none()).rowCount).toBe(0)
      expect((await dirtyOf(o)).length).toBe(0) // no sweep row yet

      expect(await sweep(o)).toMatchObject({ stale: 1, enqueued: 1, skipped: 0 })
      expect(await runMine()).toMatchObject({ claimed: 1, done: 1, failed: 0 })
      expect((await none()).rowCount).toBe(0) // still row-less after the recompute
      const rows = await dirtyOf(o)
      expect(rows.map((r) => r.status)).toEqual(['DONE']) // produced by the worker, not inserted here
      const { rows: done } = await session.admin.query(
        `SELECT completed_at, claim_owner, last_error_code FROM job_dirty_work WHERE id = $1`,
        [rows[0]?.id],
      )
      expect(done[0].completed_at).not.toBeNull()
      expect(done[0].last_error_code).toBeNull()

      expect(await sweep(o)).toMatchObject({ stale: 1, enqueued: 0, skipped: 1, gaveUp: 0 })
      expect(await sweep(o, T0 + 5 * PERIOD_MS)).toMatchObject({
        stale: 1,
        enqueued: 0,
        skipped: 1,
      })
      expect((await dirtyOf(o)).length).toBe(1)
    }, 60_000)

    it('CR-M-4 / SR-M-3: an always-failing opportunity is retried up to the cap, then no more; a new revision resets it', async () => {
      const o = await opportunity('poison')
      await makeStale(o)
      const failPending = () =>
        session.admin.query(
          `UPDATE job_dirty_work SET status = 'FAILED', retry_count = 5, completed_at = now(),
                last_error_code = 'RECOMPUTE_ERROR', claim_owner = NULL, lease_expires_at = NULL
          WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND status = 'PENDING'`,
          [o],
        )
      const enqueuedPerPeriod: number[] = []
      const gaveUpPerPeriod: number[] = []
      let lastGaveUpIds: readonly string[] = []
      for (let k = 0; k < 5; k += 1) {
        const r = await sweep(o, T0 + k * PERIOD_MS)
        enqueuedPerPeriod.push(r.enqueued)
        gaveUpPerPeriod.push(r.gaveUp)
        lastGaveUpIds = r.gaveUpIds
        await failPending()
      }
      expect(enqueuedPerPeriod).toEqual([1, 1, 1, 0, 0])
      expect(gaveUpPerPeriod).toEqual([0, 0, 0, 1, 1])
      expect(lastGaveUpIds).toEqual([o])
      const rows = await dirtyOf(o)
      expect(rows).toHaveLength(3)
      expect(rows.every((r) => r.status === 'FAILED')).toBe(true)

      // A new revision is a new target_version: the lineage starts again.
      await session.admin.query(
        `UPDATE job_opportunities SET revision = revision + 1 WHERE id = $1`,
        [o],
      )
      expect(await sweep(o, T0 + 5 * PERIOD_MS)).toMatchObject({ enqueued: 1, gaveUp: 0 })
    }, 60_000)

    it('SR-M-1 (a): a CLAIMED row with an expired lease is recovered, then recomputed', async () => {
      const o = await opportunity('expired-lease')
      await makeStale(o)
      await sweep(o)
      await pin()
      const claimed = await claimDirtyBatch(db, { owner: `crashed-${TAG}`, batchSize: 1 })
      expect(claimed.map((c) => c.entityId)).toEqual([o])
      // Held under a live lease: the sweep leaves it alone.
      expect(await sweep(o)).toMatchObject({ stale: 1, enqueued: 0, skipped: 1 })
      await session.admin.query(
        `UPDATE job_dirty_work SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
        [claimed[0]?.id],
      )
      expect(await recoverExpiredDirty(db, { batchSize: 1000 })).toMatchObject({ requeued: 1 })
      expect(await runMine()).toMatchObject({ claimed: 1, done: 1 })
      expect(await sweep(o)).toMatchObject({ stale: 0 })
    }, 60_000)

    it('SR-M-1 (b): a FAILED row is re-enqueued under the next period key and converges', async () => {
      const o = await opportunity('failed-retry')
      await makeStale(o)
      await sweep(o)
      const [first] = await dirtyOf(o)
      const failRow = (id: string) =>
        session.admin.query(
          `UPDATE job_dirty_work SET status = 'FAILED', retry_count = 5, completed_at = now(),
                claim_owner = NULL, lease_expires_at = NULL WHERE id = $1`,
          [id],
        )
      await failRow(first?.id as string)
      // The same reason would be a no-op on the non-partial unique key; the period key is not.
      expect(await sweep(o)).toMatchObject({ stale: 1, enqueued: 1 })
      const rows = await dirtyOf(o)
      expect(rows.map((r) => r.status)).toEqual(['FAILED', 'PENDING'])
      expect(rows[1]?.reason).toBe(`${first?.reason}:${periodBucket(T0)}`)
      // Within the same period nothing more is enqueued.
      expect(await sweep(o)).toMatchObject({ enqueued: 0, skipped: 1 })

      await failRow(rows[1]?.id as string)
      expect(await sweep(o)).toMatchObject({ enqueued: 0 }) // same period, key already used
      expect(await sweep(o, T0 + PERIOD_MS)).toMatchObject({ enqueued: 1 }) // next period, fresh key
      expect(await runMine()).toMatchObject({ claimed: 1, done: 1 })
      expect(await sweep(o, T0 + PERIOD_MS)).toMatchObject({ stale: 0, enqueued: 0 })
    }, 60_000)
  },
)
