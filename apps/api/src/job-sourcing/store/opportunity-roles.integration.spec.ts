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
import { classifyRoles, ROLE_CLASSIFIER_VERSION } from '../funnel/role-classifier'
import { AVAILABILITY_REASON_PREFIX, enqueueDirty } from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import {
  type RecomputeSteps,
  RecomputeWorker,
  createRecomputeSteps,
} from '../runtime/recompute-worker'
import { resolveRecordsTx } from './canonical.store'
import { writeOpportunityRoles } from './opportunity-roles'
import { saveObservationPage } from './source-record.store'

/**
 * Senior roles PR 2, Task 2.3 — vacancy roles at ingest and the lazy backfill, against a real
 * Postgres as `crm_app`. The worker is driven exactly like `recompute-worker.integration.spec.ts`:
 * the spec's PENDING rows are dated in 2000 and the worker claims exactly that many, each claim
 * checked to be the spec's own.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `roles2-${TAG}`
const NAMESPACE = `${PREFIX}-ns`
const RULE_TITLE = 'Senior Backend Engineer'
const OPEN_TITLE = 'Wizard of Things'

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let db: ReturnType<typeof drizzle<typeof schema>>
let run: RunHandle
let senior: string
let team: string
let seq = 0

async function record(nativeId: string, title: string): Promise<string> {
  seq += 1
  const [saved] = await saveObservationPage(db, run, {
    observations: [observation({ namespace: NAMESPACE, nativeId, title, tag: TAG })],
    checkpoint: specCheckpoint(seq),
  })
  return saved?.recordId as string
}

const MINE = `(entity_id IN (SELECT id FROM job_source_records WHERE namespace = $1)
  OR entity_id IN (SELECT s.opportunity_id FROM job_opportunity_sources s
                     JOIN job_source_records r ON r.id = s.source_record_id WHERE r.namespace = $1))
  AND NOT starts_with(reason, '${AVAILABILITY_REASON_PREFIX}')`

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

async function mineIds(): Promise<Set<string>> {
  const { rows } = await session.admin.query(`SELECT id FROM job_dirty_work WHERE ${MINE}`, [
    NAMESPACE,
  ])
  return new Set(rows.map((r) => r.id as string))
}

function mySteps(): RecomputeSteps {
  const real = createRecomputeSteps(db)
  return {
    ...real,
    async claim(owner, batchSize) {
      const claimed = await real.claim(owner, batchSize)
      const ids = await mineIds()
      for (const c of claimed) expect(ids.has(c.id)).toBe(true)
      return claimed
    },
  }
}

async function runMine() {
  const n = await pin()
  expect(n).toBeGreaterThan(0)
  return new RecomputeWorker(mySteps(), { owner: `roles2-spec-${TAG}`, batchSize: n }).runOnce()
}

async function opportunityOf(recordId: string): Promise<string> {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id FROM job_opportunity_sources WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [recordId],
  )
  return rows[0]?.opportunity_id as string
}

async function rolesOf(id: string) {
  const { rows } = await session.admin.query(
    `SELECT technical_roles, role_status, role_classifier_version, revision, updated_at,
            title_key, description_sha256
       FROM job_opportunities WHERE id = $1`,
    [id],
  )
  return rows[0] as {
    technical_roles: string[]
    role_status: string | null
    role_classifier_version: string | null
    revision: number
    updated_at: Date
    title_key: string
    description_sha256: string | null
  }
}

async function matchOf(id: string) {
  const { rows } = await session.admin.query(
    `SELECT outcome, opportunity_revision, evidence FROM job_opportunity_matches
      WHERE opportunity_id = $1 AND senior_id = $2`,
    [id, senior],
  )
  return rows[0] as
    { outcome: string; opportunity_revision: number; evidence: Record<string, unknown> } | undefined
}

/** A record through the worker to a stored, evaluated opportunity: resolve, then evaluate. */
async function ingested(nativeId: string, title: string): Promise<string> {
  const r = await record(nativeId, title)
  await runMine()
  const o = await opportunityOf(r)
  expect(o).toBeDefined()
  await runMine()
  return o
}

describe.skipIf(!hasDatabaseUrl())(
  'opportunity roles against Postgres (roles PR 2, Task 2.3)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession({ appPoolMax: 4 })
      const { rows } = await session.admin.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      fx = new LedgerFixtures(session.admin, TAG)
      const catalog = new SpecCatalog()
      db = drizzle(session.pool, { schema })
      const ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
      const { rows: admins } = await session.admin.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'Roles2 spec admin', 'ADMIN') RETURNING id`,
        [`roles2-admin-${TAG}@example.test`],
      )
      kit = new LedgerKit(ledger, fx, catalog, admins[0].id as string)
      run = handleOf(await kit.claimOne(await kit.reporting({ type: 'REMOTIVE_API' })))
      const { rows: seniors } = await session.admin.query(
        // Matching is role-based (senior roles PR 4): BACKEND_ENGINEER is what the rule classifier
        // reads out of `RULE_TITLE` (asserted below), so this senior covers that vacancy role.
        `INSERT INTO users (email, display_name, role, tech_stack, technical_roles)
       VALUES ($1, 'Roles2 spec senior', 'SENIOR', ARRAY['Go'], ARRAY['BACKEND_ENGINEER'])
       RETURNING id`,
        [`roles2-senior-${TAG}@example.test`],
      )
      senior = seniors[0].id as string
      const { rows: teams } = await session.admin.query(
        `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
        [`roles2-team-${TAG}`],
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
        await session.admin.query(`DELETE FROM job_role_classifications WHERE title_key = $1`, [
          OPEN_TITLE.toLowerCase(),
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

    it('createOpportunity stores roles, status and classifier version', async () => {
      const ruled = await ingested('create-rule', RULE_TITLE)
      expect(await rolesOf(ruled)).toMatchObject({
        technical_roles: ['BACKEND_ENGINEER'],
        role_status: 'RULE',
        role_classifier_version: ROLE_CLASSIFIER_VERSION,
        revision: 1,
      })
      // Precondition: the fixture's tags do not let the rule classifier name a role for this title.
      expect(classifyRoles({ title: OPEN_TITLE, tags: ['go'] }).kind).toBe('UNCLASSIFIED')
      const open = await ingested('create-open', OPEN_TITLE)
      expect(await rolesOf(open)).toMatchObject({
        technical_roles: [],
        role_status: 'PENDING',
        role_classifier_version: ROLE_CLASSIFIER_VERSION,
      })
    })

    it('refreshOpportunity with an unchanged title keeps an AI answer and does not bump revision', async () => {
      const r = await record('refresh-ai', OPEN_TITLE)
      await runMine()
      const o = await opportunityOf(r)
      const before = await rolesOf(o)
      expect(before.role_status).toBe('PENDING')
      // The AI pass (PR 3) answered after ingest. A cache row for the same key now says otherwise,
      // so a re-derivation would be visible: the AI answer must survive because nothing moved.
      await session.admin.query(
        `UPDATE job_opportunities SET technical_roles = ARRAY['DATA_ENGINEER'], role_status = 'AI'
        WHERE id = $1`,
        [o],
      )
      await session.admin.query(
        `INSERT INTO job_role_classifications
         (title_key, description_sha256, classifier_version, outcome)
       VALUES ($1, $2, $3, 'UNCLEAR')`,
        [before.title_key, before.description_sha256, ROLE_CLASSIFIER_VERSION],
      )
      const [outcome] = await resolveRecordsTx(db, [r])
      expect(outcome).toMatchObject({ kind: 'KEEP', opportunityId: o })
      const after = await rolesOf(o)
      expect(after).toMatchObject({
        technical_roles: ['DATA_ENGINEER'],
        role_status: 'AI',
        revision: before.revision,
      })
      expect(after.updated_at).toEqual(before.updated_at)
    })

    it('a reclassification-only write never changes revision', async () => {
      const o = await ingested('reclassify', RULE_TITLE)
      const before = await rolesOf(o)
      await db.transaction((tx) =>
        writeOpportunityRoles(tx, o, {
          status: 'AI',
          roles: ['DEVOPS_ENGINEER'],
          classifierVersion: ROLE_CLASSIFIER_VERSION,
        }),
      )
      const after = await rolesOf(o)
      expect(after).toMatchObject({
        technical_roles: ['DEVOPS_ENGINEER'],
        role_status: 'AI',
        revision: before.revision,
      })
      expect(after.updated_at).toEqual(before.updated_at)
    })

    it('recompute backfills a NULL role_status row under the lock and leaves revision unchanged', async () => {
      const o = await ingested('backfill', RULE_TITLE)
      // A row written before this PR: no classifier version decided it.
      await session.admin.query(
        `UPDATE job_opportunities
          SET technical_roles = '{}', role_status = NULL, role_classifier_version = NULL
        WHERE id = $1`,
        [o],
      )
      const before = await rolesOf(o)
      await enqueueDirty(db, 'OPPORTUNITY', o, before.revision, 'ROLES2_SPEC_BACKFILL')
      expect(await runMine()).toMatchObject({ claimed: 1, done: 1, failed: 0 })
      const after = await rolesOf(o)
      expect(after).toMatchObject({
        technical_roles: ['BACKEND_ENGINEER'],
        role_status: 'RULE',
        role_classifier_version: ROLE_CLASSIFIER_VERSION,
        revision: before.revision,
      })
      expect(after.updated_at).toEqual(before.updated_at)
    })

    it('recompute does not backfill a row whose work is stale (no lock-free write)', async () => {
      const o = await ingested('stale', RULE_TITLE)
      const { revision } = await rolesOf(o)
      // The opportunity moved on past the work's target revision; its roles are unset.
      await session.admin.query(
        `UPDATE job_opportunities
          SET technical_roles = '{}', role_status = NULL, role_classifier_version = NULL,
              revision = revision + 1
        WHERE id = $1`,
        [o],
      )
      await enqueueDirty(db, 'OPPORTUNITY', o, revision, 'ROLES2_SPEC_STALE')
      await runMine()
      expect(await rolesOf(o)).toMatchObject({ role_status: null, role_classifier_version: null })
    })

    /**
     * Senior roles PR 4 replaces the stack-keyword match with a role match, so the PR-2 assertion
     * "evaluation output is unchanged" is now false BY DESIGN: the same three role columns this
     * spec writes are what the evaluator reads. The senior holds BACKEND_ENGINEER, so the
     * rule-classified vacancy is a LEAD; moving the vacancy to a role they do not hold turns the
     * same senior into a per-senior `ROLE_MISMATCH` exclusion.
     */
    it('the vacancy roles decide the match (senior roles PR 4)', async () => {
      const o = await ingested('evaluation', RULE_TITLE)
      expect(await matchOf(o)).toMatchObject({ outcome: 'LEAD' })
      // A vacancy role the senior does not hold, written at the CURRENT classifier version so the
      // lazy backfill does not re-derive it away.
      await session.admin.query(
        `UPDATE job_opportunities SET technical_roles = ARRAY['QA_ENGINEER'], role_status = 'RULE'
        WHERE id = $1`,
        [o],
      )
      const { revision } = await rolesOf(o)
      await enqueueDirty(db, 'OPPORTUNITY', o, revision, 'ROLES2_SPEC_EVALUATION')
      expect(await runMine()).toMatchObject({ claimed: 1, done: 1, failed: 0 })
      expect(await matchOf(o)).toMatchObject({
        outcome: 'EXCLUDED',
        evidence: {
          stage: 'CLASSIFICATION',
          reasons: [{ code: 'ROLE_MISMATCH', evidence: ['vacancy=QA_ENGINEER'] }],
        },
      })
    })
  },
)
