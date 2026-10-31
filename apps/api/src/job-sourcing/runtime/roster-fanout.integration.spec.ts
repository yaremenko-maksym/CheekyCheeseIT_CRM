import { randomUUID } from 'node:crypto'
import { normalizeCompanyName } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { ApprovalsService } from '../../approvals/approvals.service'
import { DatabaseService } from '../../database/database.service'
import * as schema from '../../database/schema'
import { makeNotificationsStub } from '../../notifications/__test-helpers__/notifications-stub'
import { ProjectInterviewSeedService } from '../../projects/project-interview-seed.service'
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
import {
  markExclusionDirty,
  markProjectClientDirty,
  markSeniorDirty,
  markUserEditDirty,
} from '../dirty-producers'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import { saveObservationPage } from '../store/source-record.store'
import { claimDirtyBatch } from '../ownership/dirty-work.store'
import { RecomputeWorker, createRecomputeSteps } from './recompute-worker'

/**
 * r5 Task 4.6 S5 — roster-side producers end to end on a real Postgres, as `crm_app`:
 * write (with its producer, in one transaction) -> dirty row -> worker fan-out -> OPPORTUNITY
 * recompute -> stored matches. The fan-out is scoped to this spec's opportunities (`onlyIds`)
 * and the worker claims only this spec's rows (dated in the year 2000 so they sort first), so no
 * other suite's data is touched. Fixtures are removed in `afterAll`.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `s5-${TAG}`
const NAMESPACE = `${PREFIX}-ns`

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let team: string
let seq = 0
const oppIds: string[] = []
const users: string[] = []
const exclusions: string[] = []
const projects: string[] = []

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A record, resolved and evaluated to its first matches; returns the opportunity id. */
async function opportunity(nativeId: string): Promise<string> {
  seq += 1
  const obs = observation({ namespace: NAMESPACE, nativeId, version: 'v1', tag: TAG })
  const [saved] = await saveObservationPage(db, run, {
    observations: [obs],
    checkpoint: specCheckpoint(seq),
  })
  const { rows } = await session.admin.query(
    `SELECT opportunity_id FROM job_opportunity_sources WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [saved?.recordId],
  )
  await drain() // resolves the record onto an opportunity, then evaluates it
  const again = await session.admin.query(
    `SELECT opportunity_id FROM job_opportunity_sources WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [saved?.recordId],
  )
  const o = String((rows[0] ?? again.rows[0])?.opportunity_id)
  oppIds.push(o)
  return o
}

const MINE = `entity_id = ANY($2::uuid[])
  OR entity_id IN (SELECT id FROM job_source_records WHERE namespace = $1)
  OR entity_id IN (SELECT s.opportunity_id FROM job_opportunity_sources s
                     JOIN job_source_records r ON r.id = s.source_record_id WHERE r.namespace = $1)`
const mineParams = () => [NAMESPACE, [...users, ...exclusions, ...projects]]

/** Date this spec's pending rows in 2000 so a claim of exactly that many takes only them. */
async function pin(): Promise<number> {
  const { rowCount } = await session.admin.query(
    `UPDATE job_dirty_work SET created_at = '2000-01-01T00:00:00Z'::timestamptz + seq * interval '1 ms'
       FROM (SELECT id AS pid, row_number() OVER (ORDER BY created_at, id) AS seq
               FROM job_dirty_work WHERE status = 'PENDING' AND (${MINE})) p
      WHERE id = p.pid`,
    mineParams(),
  )
  return rowCount ?? 0
}

/** Worker runs over this spec's rows until none is pending; the summed report. */
async function drain(pageSize?: number) {
  const total = { passes: 0, claimed: 0, done: 0, deferred: 0, failed: 0, retried: 0, errors: [''] }
  total.errors = []
  for (let i = 0; i < 20; i += 1) {
    const n = await pin()
    if (n === 0) return total
    const r = await new RecomputeWorker(
      createRecomputeSteps(db, { onlyIds: oppIds, ...(pageSize ? { pageSize } : {}) }),
      { owner: PREFIX, batchSize: n },
    ).runOnce()
    total.passes += 1
    total.claimed += r.claimed
    total.done += r.done
    total.deferred += r.deferred
    total.failed += r.failed
    total.retried += r.retried
    // The FAILED / retried rows' codes, so a failing assertion names its cause.
    const { rows } = await session.admin.query(
      `SELECT entity_kind || ':' || last_error_code AS e FROM job_dirty_work
        WHERE last_error_code IS NOT NULL AND status IN ('FAILED', 'PENDING') AND (${MINE})`,
      mineParams(),
    )
    total.errors.push(...rows.map((x) => String(x.e)))
  }
  throw new Error('the spec queue did not drain in 20 passes')
}

/** `senior -> outcome` of an opportunity's stored matches. */
async function matches(o: string): Promise<Record<string, string>> {
  const { rows } = await session.admin.query(
    `SELECT senior_id, outcome FROM job_opportunity_matches WHERE opportunity_id = $1`,
    [o],
  )
  return Object.fromEntries(rows.map((r) => [String(r.senior_id), String(r.outcome)]))
}

async function senior(name: string, inTeam: boolean): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO users (email, display_name, role, tech_stack)
     VALUES ($1, $2, 'SENIOR', ARRAY['Go']) RETURNING id`,
    [`${PREFIX}-${name}@example.test`, `S5 spec ${name}`],
  )
  const id = String(rows[0].id)
  users.push(id)
  if (inTeam)
    await session.admin.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [
      team,
      id,
    ])
  return id
}

/** One write and its producer in one `crm_app` transaction (what each hooked service does). */
const write = <T>(work: (tx: Tx) => Promise<T>) => db.transaction(work)

async function dirtyCount(entityId: string): Promise<number> {
  const { rows } = await session.admin.query(
    `SELECT count(*)::int AS n FROM job_dirty_work WHERE entity_id = $1`,
    [entityId],
  )
  return Number(rows[0].n)
}

/** The outcomes of `ids` only: other suites' seniors may share the roster. */
const of = (m: Record<string, string>, ...ids: string[]) =>
  Object.fromEntries(ids.filter((id) => id in m).map((id) => [id, m[id]]))

describe.skipIf(!hasDatabaseUrl())('roster-side producers converge (r5 Task 4.6 S5)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows: cur } = await session.admin.query(`SELECT current_database() AS db`)
    if (cur[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
    const { rows: admins } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'S5 spec admin', 'ADMIN') RETURNING id`,
      [`${PREFIX}-admin@example.test`],
    )
    users.push(String(admins[0].id))
    kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
    run = handleOf(await kit.claimOne(await kit.reporting({ type: 'REMOTIVE_API' })))
    const { rows: teams } = await session.admin.query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
      [`${PREFIX}-team`],
    )
    team = String(teams[0].id)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_dirty_work WHERE ${MINE}`, mineParams())
      await session.admin.query(
        `DELETE FROM job_queue_assignments WHERE assignee_id = ANY($1::uuid[])`,
        [users],
      )
      await session.admin.query(`DELETE FROM job_exclusion_filters WHERE id = ANY($1::uuid[])`, [
        exclusions,
      ])
      await session.admin.query(`DELETE FROM approvals WHERE subject_id = ANY($1::uuid[])`, [
        projects,
      ])
      await session.admin.query(`DELETE FROM project_members WHERE project_id = ANY($1::uuid[])`, [
        projects,
      ])
      await session.admin.query(`DELETE FROM project_audit_log WHERE target_id = ANY($1::uuid[])`, [
        projects,
      ])
      await session.admin.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projects])
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM team_members WHERE team_id = $1`, [team])
      await session.admin.query(`DELETE FROM teams WHERE id = $1`, [team])
      await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users])
    } finally {
      await session.close()
    }
  })

  it('AC 4: roster join, stack edit, exclusion, team change and archive each converge', async () => {
    const a = await senior('a', true)
    const o = await opportunity('converge')
    expect(of(await matches(o), a)).toEqual({ [a]: 'LEAD' })

    // ROSTER JOIN (the S4b known gap): the opportunity already has a row for `a`, none for `b`.
    const b = await senior('b', false)
    await write(async (tx) => {
      await tx.execute(sql`INSERT INTO team_members (team_id, user_id) VALUES (${team}, ${b})`)
      expect(await markSeniorDirty(tx, b, 'senior.team')).toBe(true)
    })
    const joined = await drain()
    expect([joined.failed, joined.errors]).toEqual([0, []])
    expect(joined.claimed).toBeGreaterThanOrEqual(2) // the SENIOR row, then the OPPORTUNITY row
    expect(of(await matches(o), a, b)).toEqual({ [a]: 'LEAD', [b]: 'LEAD' })

    // STACK EDIT: `b` no longer knows Go -> no match row for `b`.
    await write(async (tx) => {
      await tx.execute(sql`UPDATE users SET tech_stack = ARRAY['Cobol'] WHERE id = ${b}`)
      expect(
        await markUserEditDirty(
          tx,
          b,
          { role: 'SENIOR', techStack: ['Go'] },
          { techStack: ['Cobol'] },
        ),
      ).toBe(true)
    })
    await drain()
    expect(of(await matches(o), a, b)).toEqual({ [a]: 'LEAD' })

    // EXCLUSION: `a` shuts the employer out -> `a` is EXCLUDED.
    const excl = await write(async (tx) => {
      const { rows } = await tx.execute(
        sql`INSERT INTO job_exclusion_filters (senior_id, kind, value, normalized_value, created_by)
            VALUES (${a}, 'COMPANY', 'Acme', ${normalizeCompanyName('Acme')}, ${a}) RETURNING id`,
      )
      const id = String(rows[0]?.['id'])
      await markExclusionDirty(tx, id, 'exclusion.create')
      return id
    })
    exclusions.push(excl)
    await drain()
    expect(of(await matches(o), a)).toEqual({ [a]: 'EXCLUDED' })

    // EXCLUSION DELETE: the row is gone, its dirty row still fans out -> LEAD again.
    await write(async (tx) => {
      await tx.execute(sql`DELETE FROM job_exclusion_filters WHERE id = ${excl}`)
      await markExclusionDirty(tx, excl, 'exclusion.delete')
    })
    await drain()
    expect(of(await matches(o), a)).toEqual({ [a]: 'LEAD' })

    // TEAM CHANGE: `a` leaves the team -> off the roster -> no row.
    await write(async (tx) => {
      await tx.execute(sql`UPDATE team_members SET left_at = now() WHERE user_id = ${a}`)
      await markSeniorDirty(tx, a, 'senior.team')
    })
    await drain()
    expect(of(await matches(o), a)).toEqual({})

    // ARCHIVE: `c` joins, then is archived -> its row goes away.
    const c = await senior('c', true)
    await write((tx) => markSeniorDirty(tx, c, 'senior.team'))
    await drain()
    expect(of(await matches(o), c)).toEqual({ [c]: 'LEAD' })
    await write(async (tx) => {
      await tx.execute(sql`UPDATE users SET archived_at = now() WHERE id = ${c}`)
      await markSeniorDirty(tx, c, 'senior.archive')
    })
    await drain()
    expect(of(await matches(o), c)).toEqual({})
  }, 120_000)

  it('AC 4: a project of the senior with the employer as its client excludes them', async () => {
    const d = await senior('d', true)
    const o = oppIds[0]!
    await write((tx) => markSeniorDirty(tx, d, 'senior.team'))
    await drain()
    expect(of(await matches(o), d)).toEqual({ [d]: 'LEAD' })
    const p = await write(async (tx) => {
      const { rows } = await tx.execute(
        sql`INSERT INTO projects (name, company_name, domain, start_date, senior_id, rate)
            VALUES (${`${PREFIX}-project`}, 'Acme', 'ai', now(), ${d}, 1) RETURNING id`,
      )
      const id = String(rows[0]?.['id'])
      await markProjectClientDirty(tx, id, 'project.create')
      return id
    })
    projects.push(p)
    await drain()
    expect(of(await matches(o), d)).toEqual({ [d]: 'EXCLUDED' })
  }, 120_000)

  it('CR-H-1: a HIRED interview project for the employer excludes its senior (real seed service)', async () => {
    const h = await senior('h', true)
    const o = oppIds[0]!
    await write((tx) => markSeniorDirty(tx, h, 'senior.team'))
    await drain()
    expect(of(await matches(o), h)).toEqual({ [h]: 'LEAD' })
    const dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
      pool: session.pool,
      db,
    })
    const seed = new ProjectInterviewSeedService(
      dbSvc,
      new ApprovalsService(dbSvc, makeNotificationsStub()),
      makeNotificationsStub() as never,
    )
    const interview = {
      id: randomUUID(),
      seniorId: h,
      hrId: null,
      companyName: 'Acme',
      stage: 'HIRED',
      notesDomain: 'ai',
      senior: null,
    } as unknown as Parameters<ProjectInterviewSeedService['createFromInterview']>[0]
    const actor = { id: users[0]!, role: 'ADMIN' } as never
    const project = await db.transaction((tx) => seed.createFromInterview(interview, actor, tx))
    projects.push(project!.id)
    await drain()
    expect(of(await matches(o), h)).toEqual({ [h]: 'EXCLUDED' })
  }, 120_000)

  it('SR-M-2: scope is ACTIVE + CLAIMED; N saves between worker runs leave one pending row each', async () => {
    const closed = await opportunity('closed')
    const claimed = await opportunity('claimed-closed')
    await session.admin.query(
      `UPDATE job_opportunities SET availability = 'CLOSED' WHERE id = ANY($1::uuid[])`,
      [[closed, claimed]],
    )
    await session.admin.query(
      `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, assignee_id)
       VALUES ($1, 'STUDIO', $2)`,
      [claimed, users[0]],
    )
    const g = await senior('g', true)
    // Three save -> fan-out cycles; the OPPORTUNITY rows they enqueue stay PENDING in between.
    const steps = createRecomputeSteps(db, { onlyIds: oppIds })
    const fanOutOnly = {
      ...steps,
      claim: (owner: string, n: number) =>
        claimDirtyBatch(db, { owner, batchSize: n, kinds: ['SENIOR'] }),
    }
    for (let i = 0; i < 3; i += 1) {
      await write((tx) => markSeniorDirty(tx, g, 'senior.team'))
      await pin()
      const r = await new RecomputeWorker(fanOutOnly, { owner: PREFIX, batchSize: 1 }).runOnce()
      expect([r.claimed, r.done, r.failed]).toEqual([1, 1, 0])
    }
    const pending = await session.admin.query(
      `SELECT entity_id, count(*)::int AS n FROM job_dirty_work
        WHERE entity_kind = 'OPPORTUNITY' AND status = 'PENDING' AND entity_id = ANY($1::uuid[])
        GROUP BY entity_id`,
      [oppIds],
    )
    const byOpp = Object.fromEntries(pending.rows.map((r) => [String(r.entity_id), Number(r.n)]))
    expect(byOpp[closed]).toBeUndefined() // CLOSED and unclaimed: out of scope
    expect(byOpp[claimed]).toBe(1) // CLOSED but claimed: in scope
    for (const o of oppIds.filter((x) => x !== closed)) expect(byOpp[o]).toBe(1)
    await drain()
    expect(of(await matches(oppIds[0]!), g)).toEqual({ [g]: 'LEAD' })
  }, 120_000)

  it('AC 1: a rolled-back write leaves neither the write nor a dirty row, per producer', async () => {
    const e = await senior('e', false)
    const fail = (work: (tx: Tx) => Promise<unknown>) =>
      expect(
        write(async (tx) => {
          await work(tx)
          throw new Error('rolled back')
        }),
      ).rejects.toThrow('rolled back')
    await fail(async (tx) => {
      await tx.execute(sql`INSERT INTO team_members (team_id, user_id) VALUES (${team}, ${e})`)
      expect(await markSeniorDirty(tx, e, 'senior.team')).toBe(true)
    })
    await fail(async (tx) => {
      await tx.execute(sql`UPDATE users SET role = 'HR' WHERE id = ${e}`)
      expect(await markUserEditDirty(tx, e, { role: 'SENIOR' }, { role: 'HR' })).toBe(true)
    })
    const ghost = randomUUID()
    await fail((tx) => markExclusionDirty(tx, ghost, 'exclusion.create'))
    await fail((tx) => markProjectClientDirty(tx, ghost, 'project.create'))
    expect(await dirtyCount(e)).toBe(0)
    expect(await dirtyCount(ghost)).toBe(0)
    const { rows } = await session.admin.query(
      `SELECT (SELECT role FROM users WHERE id = $1) AS role,
              (SELECT count(*)::int FROM team_members WHERE user_id = $1) AS teams`,
      [e],
    )
    expect(rows[0]).toEqual({ role: 'SENIOR', teams: 0 })
  })

  it('AC 5: fan-out pages are bounded, resumable and idempotent', async () => {
    const o2 = await opportunity('paged')
    const f = await senior('f', true)
    await write((tx) => markSeniorDirty(tx, f, 'senior.team'))
    // Page size 1 over this spec's opportunities: the pass continues instead of finishing at once.
    const r = await drain(1)
    expect([r.failed, r.errors]).toEqual([0, []])
    const { rows } = await session.admin.query(
      `SELECT reason, status, target_version::int AS v FROM job_dirty_work
        WHERE entity_kind = 'SENIOR' AND entity_id = $1 ORDER BY created_at, id`,
      [f],
    )
    // The producer row and one continuation per full page, all at version 1, all DONE.
    // In-scope opportunities only (ACTIVE or CLAIMED; an earlier case closed one, unclaimed).
    const { rows: scoped } = await session.admin.query(
      `SELECT o.id::text AS id FROM job_opportunities o
        WHERE o.id = ANY($1::uuid[])
          AND (o.availability IN ('OPEN', 'UNKNOWN')
               OR EXISTS (SELECT 1 FROM job_queue_assignments a
                           WHERE a.opportunity_id = o.id AND a.state = 'TAKEN'))`,
      [oppIds],
    )
    const inScope = scoped.map((x) => String(x.id))
    expect(inScope.length).toBeGreaterThan(1)
    expect(rows.length).toBe(inScope.length + 1)
    expect(rows.every((x) => x.v === 1 && x.status === 'DONE')).toBe(true)
    // Every in-scope opportunity was recomputed for `f` (LEAD when open; EXCLUDED when closed but claimed).
    for (const o of inScope) expect(Object.keys(of(await matches(o), f))).toEqual([f])
    expect(oppIds).toContain(o2)
    // Idempotent: one root never enqueues the same OPPORTUNITY row twice.
    const { rows: dup } = await session.admin.query(
      `SELECT entity_id FROM job_dirty_work
        WHERE entity_kind = 'OPPORTUNITY' AND reason LIKE 'fanout:%' AND entity_id = ANY($1::uuid[])
        GROUP BY entity_id, target_version, reason HAVING count(*) > 1`,
      [oppIds],
    )
    expect(dup).toEqual([])
  }, 120_000)
})
