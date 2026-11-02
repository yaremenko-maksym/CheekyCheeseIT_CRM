import { randomUUID } from 'node:crypto'
import { HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HrAccessService } from '../common/hr-access.service'
import { type CrmAppSession, openCrmAppSession } from '../database/__test-helpers__/crm-app-session'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../test/ledger-fixtures'
import { cleanupStore, observation } from '../test/record-store-fixtures'
import { hasDatabaseUrl } from '../test/require-real-db'
import { JobSourcingService } from './job-sourcing.service'
import { JobRunLedger } from './ownership/job-run-ledger'
import type { RunHandle } from './ownership/run-ownership'
import { JobSourceRegistry } from './registry/job-source-registry'
import { createRecomputeSteps, RecomputeWorker } from './runtime/recompute-worker'
import { saveObservationPage } from './store/source-record.store'

/**
 * SFS U10 part 3 — the per-opportunity RBAC of `openOpportunity` against a real Postgres (ADR 6a,
 * step 2). A mocked E2E cannot prove a backend guard (the #110/#157 lesson), so this exercises the
 * service scope directly: SENIOR only their own queue, HR only their teams' seniors, ADMIN any.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `u10open-${TAG}`
const NAMESPACE = `${PREFIX}-ns`
const user = (id: string, role: SessionUser['role']): SessionUser =>
  ({ id, role, email: `${id}@example.test` }) as SessionUser

/**
 * The existence-oracle contract: every refusal — out of scope OR no match — is the SAME
 * `JOB_OPPORTUNITY_NOT_FOUND` 404, so a viewer cannot tell "not mine" from "does not exist".
 */
async function expectNotFound(p: Promise<unknown>): Promise<void> {
  await p.then(
    () => {
      throw new Error('expected JOB_OPPORTUNITY_NOT_FOUND, got a result')
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(HttpException)
      const ex = e as HttpException
      expect(ex.getStatus()).toBe(404)
      expect((ex.getResponse() as { code: string }).code).toBe('JOB_OPPORTUNITY_NOT_FOUND')
    },
  )
}

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let service: JobSourcingService
let seniorMatched: string
let seniorOther: string
let admin: string
let hrIn: string
let hrOut: string
let opportunityId: string
let opportunityId2: string

describe.skipIf(!hasDatabaseUrl())('openOpportunity RBAC against Postgres (U10 #3)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await session.admin.query(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: session.pool, db })
    service = new JobSourcingService(dbSvc, new HrAccessService(dbSvc), new JobSourceRegistry([]))

    const mk = async (name: string, role: SessionUser['role'], stack: string[] = []) => {
      const { rows } = await session.admin.query(
        `INSERT INTO users (email, display_name, role, tech_stack)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`u10open-${name}-${TAG}@example.test`, `U10open ${name}`, role, stack],
      )
      return rows[0].id as string
    }
    admin = await mk('admin', 'ADMIN')
    seniorMatched = await mk('sen-in', 'SENIOR', ['Go'])
    seniorOther = await mk('sen-out', 'SENIOR', ['Go'])
    hrIn = await mk('hr-in', 'HR')
    hrOut = await mk('hr-out', 'HR')

    const { rows: teamRows } = await session.admin.query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
      [`u10open-team-${TAG}`],
    )
    const teamId = teamRows[0].id as string
    // hrIn shares the team with the matched senior; hrOut and seniorOther do not.
    for (const uid of [seniorMatched, hrIn]) {
      await session.admin.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [
        teamId,
        uid,
      ])
    }

    kit = new LedgerKit(ledger, fx, catalog, admin)
    run = handleOf(await kit.claimOne(await kit.reporting({ type: 'REMOTIVE_API' })))
    const worker = new RecomputeWorker(createRecomputeSteps(db), {
      owner: `u10open-${TAG}`,
      batchSize: 50,
    })
    const form = async (nativeId: string, seq: number): Promise<string> => {
      const [saved] = await saveObservationPage(db, run, {
        observations: [observation({ namespace: NAMESPACE, nativeId, tag: TAG })],
        checkpoint: specCheckpoint(seq),
      })
      const recordId = saved?.recordId as string
      await worker.runOnce() // SOURCE_RECORD -> opportunity row
      await worker.runOnce() // OPPORTUNITY -> evaluate + install the LEAD match
      const { rows } = await session.admin.query(
        `SELECT opportunity_id FROM job_opportunity_sources WHERE source_record_id = $1 AND unlinked_at IS NULL`,
        [recordId],
      )
      return rows[0].opportunity_id as string
    }
    opportunityId = await form('open-1', 1)
    opportunityId2 = await form('open-2', 2)
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM team_members WHERE user_id = ANY($1::uuid[])`, [
        [seniorMatched, hrIn],
      ])
      await session.admin.query(`DELETE FROM teams WHERE name = $1`, [`u10open-team-${TAG}`])
      await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        [admin, seniorMatched, seniorOther, hrIn, hrOut],
      ])
    } finally {
      await session.close()
    }
  })

  it('the opportunity is a LEAD for the matched senior (fixture sanity)', async () => {
    const { rows } = await session.admin.query(
      `SELECT outcome FROM job_opportunity_matches WHERE opportunity_id = $1 AND senior_id = $2`,
      [opportunityId, seniorMatched],
    )
    expect(rows[0]?.outcome).toBe('LEAD')
  })

  it('ADMIN may open it', async () => {
    const r = await service.openOpportunity(opportunityId, user(admin, 'ADMIN'))
    expect(r).toMatchObject({ opportunityId, detailEnqueued: 0, detailPending: false })
  })

  it('the matched SENIOR may open it', async () => {
    const r = await service.openOpportunity(opportunityId, user(seniorMatched, 'SENIOR'))
    expect(r.opportunityId).toBe(opportunityId)
  })

  it('an HR who shares the team may open it', async () => {
    const r = await service.openOpportunity(opportunityId, user(hrIn, 'HR'))
    expect(r.opportunityId).toBe(opportunityId)
  })

  it('an HR who does NOT share the team gets the same 404 (no existence oracle)', async () => {
    await expectNotFound(service.openOpportunity(opportunityId, user(hrOut, 'HR')))
  })

  it('a SENIOR who is not matched gets the same 404 (no existence oracle)', async () => {
    await expectNotFound(service.openOpportunity(opportunityId, user(seniorOther, 'SENIOR')))
  })

  it('an opportunity with no LEAD/TRIAGE match is the same 404', async () => {
    await expectNotFound(service.openOpportunity(randomUUID(), user(admin, 'ADMIN')))
  })

  // SR-M-1: authorization is against the LIVE roster + the CURRENT match, never a historical one.
  it('a match left at a superseded opportunity revision does not grant visibility (stale state)', async () => {
    // Pin the match at a revision that is NOT the opportunity's current one (what a re-list leaves).
    await session.admin.query(
      `UPDATE job_opportunity_matches SET opportunity_revision = opportunity_revision + 1000
        WHERE opportunity_id = $1`,
      [opportunityId2],
    )
    // Even ADMIN sees nothing to open: the only match is now at a stale revision.
    await expectNotFound(service.openOpportunity(opportunityId2, user(admin, 'ADMIN')))
  })

  // Runs LAST: it archives the only matched senior of the main opportunity.
  it('an archived SENIOR does not leak the opportunity to an HR who shared their team', async () => {
    await session.admin.query(`UPDATE users SET archived_at = clock_timestamp() WHERE id = $1`, [
      seniorMatched,
    ])
    // hrIn still shares the (now historical) team, but the senior is no longer eligible.
    await expectNotFound(service.openOpportunity(opportunityId, user(hrIn, 'HR')))
  })
})
