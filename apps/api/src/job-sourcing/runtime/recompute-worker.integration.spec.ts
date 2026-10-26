import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
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
import { type ClaimedDirtyWork, enqueueDirty } from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import { saveObservationPage } from '../store/source-record.store'
import { MATCH_RULE_VERSION } from './recompute-inputs'
import { type RecomputeSteps, RecomputeWorker, createRecomputeSteps } from './recompute-worker'

/**
 * r5 Task 4.6 S4a — the recompute worker against a real Postgres, as `crm_app`.
 *
 * ISOLATION: the queue is shared. Before every run the spec's own PENDING rows are dated in the
 * year 2000 (they sort ahead of any real row) and the worker claims exactly that many; a wrapper
 * around `claim` asserts every claimed row is the spec's. Cleanup removes the spec's records,
 * opportunities (their matches cascade), dirty work, users and team.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `s4a-${TAG}`
const NAMESPACE = `${PREFIX}-ns`

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let senior: string
let team: string
let seq = 0

async function record(nativeId: string, version = 'v1'): Promise<string> {
  seq += 1
  const [saved] = await saveObservationPage(db, run, {
    observations: [observation({ namespace: NAMESPACE, nativeId, version, tag: TAG })],
    checkpoint: specCheckpoint(seq),
  })
  return saved?.recordId as string
}

/** The spec's entities: its records and the opportunities they are linked to. */
const MINE = `entity_id IN (SELECT id FROM job_source_records WHERE namespace = $1)
  OR entity_id IN (SELECT s.opportunity_id FROM job_opportunity_sources s
                     JOIN job_source_records r ON r.id = s.source_record_id WHERE r.namespace = $1)`

/** Date the spec's PENDING rows in 2000 (oldest first) and return how many there are. */
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

async function work(kind?: string) {
  const { rows } = await session.admin.query(
    `SELECT id, entity_kind, entity_id, target_version, status, retry_count, last_error_code
       FROM job_dirty_work WHERE (${MINE}) ${kind ? `AND entity_kind = '${kind}'` : ''}
      ORDER BY created_at, id`,
    [NAMESPACE],
  )
  return rows as {
    id: string
    entity_kind: string
    entity_id: string
    target_version: number
    status: string
    retry_count: number
    last_error_code: string | null
  }[]
}

async function opportunityOf(recordId: string): Promise<string> {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id FROM job_opportunity_sources WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [recordId],
  )
  return rows[0]?.opportunity_id as string
}

async function matchOf(opportunityId: string) {
  const { rows } = await session.admin.query(
    `SELECT outcome, opportunity_revision, rule_version, senior_profile_version, exclusion_version, evidence
       FROM job_opportunity_matches WHERE opportunity_id = $1 AND senior_id = $2`,
    [opportunityId, senior],
  )
  return rows[0] as
    | {
        outcome: string
        opportunity_revision: number
        rule_version: string
        senior_profile_version: string
        exclusion_version: string
        evidence: Record<string, unknown>
      }
    | undefined
}

/** The real steps, with `claim` checked to hand out the spec's rows only. */
function mySteps(wrap: (c: ClaimedDirtyWork[]) => Promise<void> = async () => {}): RecomputeSteps {
  const real = createRecomputeSteps(db)
  return {
    ...real,
    async claim(owner, batchSize) {
      const claimed = await real.claim(owner, batchSize)
      const ids = new Set((await work()).map((w) => w.id))
      for (const c of claimed) expect(ids.has(c.id)).toBe(true)
      await wrap(claimed)
      return claimed
    },
  }
}

/** One worker run over exactly the spec's pending rows. */
async function runMine(steps: RecomputeSteps = mySteps()) {
  const n = await pin()
  expect(n).toBeGreaterThan(0)
  return new RecomputeWorker(steps, { owner: `s4a-spec-${TAG}`, batchSize: n }).runOnce()
}

/** Finish whatever earlier tests left pending, so the next run claims only its own rows. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3 && (await work()).some((w) => w.status === 'PENDING'); round += 1)
    await runMine()
}

/** Never return a pooled client with a transaction open. */
async function releaseRolledBack(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
    client.release()
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)))
  }
}

describe.skipIf(!hasDatabaseUrl())('recompute worker against Postgres (Task 4.6 S4a)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
    const { rows: admins } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'S4a spec admin', 'ADMIN') RETURNING id`,
      [`s4a-admin-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
    run = handleOf(await kit.claimOne(await kit.reporting({ type: 'REMOTIVE_API' })))
    const { rows: seniors } = await session.admin.query(
      `INSERT INTO users (email, display_name, role, tech_stack)
       VALUES ($1, 'S4a spec senior', 'SENIOR', ARRAY['Go']) RETURNING id`,
      [`s4a-senior-${TAG}@example.test`],
    )
    senior = seniors[0].id as string
    const { rows: teams } = await session.admin.query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
      [`s4a-team-${TAG}`],
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

  it('AC 1 + 5: claim -> resolve (persisted, opportunity row pending) -> evaluate -> install', async () => {
    const r = await record('happy')
    const first = await runMine()
    expect(first).toMatchObject({ claimed: 1, done: 1, deferred: 0, retried: 0, failed: 0 })
    // Persisted before any evaluation: the link exists, the opportunity row waits, no match yet.
    const o = await opportunityOf(r)
    expect(o).toBeDefined()
    expect((await work('OPPORTUNITY')).map((w) => [w.entity_id, w.status])).toEqual([
      [o, 'PENDING'],
    ])
    expect(await matchOf(o)).toBeUndefined()

    const second = await runMine()
    expect(second).toMatchObject({ claimed: 1, done: 1, failed: 0 })
    const m = await matchOf(o)
    expect(m).toMatchObject({
      outcome: 'LEAD',
      opportunity_revision: 1,
      rule_version: MATCH_RULE_VERSION,
    })
    expect(m?.senior_profile_version).toMatch(/^[0-9a-f]{32}$/)
    expect(m?.exclusion_version).toMatch(/^[0-9a-f]{32}$/)
    expect((await work()).every((w) => w.status === 'DONE')).toBe(true)
  })

  it('AC 2: a stale opportunity row installs nothing and is DEFERRED / VERSION_STALE', async () => {
    const r = await record('stale')
    await runMine()
    const o = await opportunityOf(r)
    // The opportunity moves on before its row is processed.
    await session.admin.query(
      `UPDATE job_opportunities SET revision = revision + 1 WHERE id = $1`,
      [o],
    )
    await runMine()
    expect(await matchOf(o)).toBeUndefined()
    const [row] = (await work('OPPORTUNITY')).filter((w) => w.entity_id === o)
    expect(row).toMatchObject({ status: 'DEFERRED', last_error_code: 'VERSION_STALE' })
  })

  it('AC 2: output of an older revision never overwrites a newer one', async () => {
    const r = await record('newer')
    await runMine()
    const o = await opportunityOf(r)
    await session.admin.query(
      `INSERT INTO job_opportunity_matches
         (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version, rule_version, outcome)
       VALUES ($1, $2, 99, 'p', 'e', 'r', 'EXCLUDED')`,
      [o, senior],
    )
    await runMine()
    expect(await matchOf(o)).toMatchObject({ opportunity_revision: 99, outcome: 'EXCLUDED' })
  })

  it('AC 3: an infrastructure failure is RETRY, does not stop the batch, and FAILED once spent', async () => {
    const blocked = await record('blocked')
    const fine = await record('fine')
    await session.admin.query(
      `UPDATE job_dirty_work SET retry_count = 4 WHERE entity_id = $1 AND status = 'PENDING'`,
      [blocked],
    )
    const holder = await session.admin.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT 1 FROM job_source_records WHERE id = $1 FOR UPDATE`, [blocked])
      const report = await runMine()
      expect(report).toMatchObject({ claimed: 2, done: 1, failed: 1 })
    } finally {
      await releaseRolledBack(holder)
    }
    const rows = await work('SOURCE_RECORD')
    expect(rows.find((w) => w.entity_id === fine)?.status).toBe('DONE')
    expect(rows.find((w) => w.entity_id === blocked)).toMatchObject({
      status: 'FAILED',
      retry_count: 5,
      last_error_code: 'LOCK_CONTENTION',
    })
    expect(await opportunityOf(blocked)).toBeUndefined()
  }, 60_000)

  it('AC 4: a handle whose lease expired writes nothing', async () => {
    await settle()
    const r = await record('fenced')
    const expire = async (claimed: ClaimedDirtyWork[]) => {
      await session.admin.query(
        `UPDATE job_dirty_work SET lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE id = ANY($1::uuid[])`,
        [claimed.map((c) => c.id)],
      )
    }
    const report = await runMine(mySteps(expire))
    expect(report).toMatchObject({ claimed: 1, fenced: 1, done: 0, retried: 0, failed: 0 })
    // The resolution rolled back with the refused completion: no link, row still CLAIMED.
    expect(await opportunityOf(r)).toBeUndefined()
    const [row] = (await work('SOURCE_RECORD')).filter((w) => w.entity_id === r)
    expect(row?.status).toBe('CLAIMED')
  })

  it('AC 7: an active, claimed opportunity first seen 60 days ago is recomputed', async () => {
    const r = await record('old')
    await runMine()
    const o = await opportunityOf(r)
    await runMine()
    await session.admin.query(
      `UPDATE job_opportunities
          SET first_seen_at = now() - interval '60 days', created_at = now() - interval '60 days',
              availability = 'OPEN', revision = revision + 1
        WHERE id = $1`,
      [o],
    )
    await session.admin.query(
      `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, assignee_id) VALUES ($1, 'STUDIO', $2)`,
      [o, kit.actor],
    )
    await enqueueDirty(db, 'OPPORTUNITY', o, 2, 'S4A_SPEC')
    const report = await runMine()
    expect(report).toMatchObject({ claimed: 1, done: 1 })
    expect(await matchOf(o)).toMatchObject({ outcome: 'LEAD', opportunity_revision: 2 })
  })
})
