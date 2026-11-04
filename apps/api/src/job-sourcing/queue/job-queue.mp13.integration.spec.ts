import { randomUUID } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import { jobQueueListQuerySchema, type SessionUser } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../config/env'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { loadRoster, MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import { JobQueueService } from './job-queue.service'
import { GENERATION_POLICY } from './queue-generation'
import { cardRow } from './queue-read-sql'
import type { JobQueueScope } from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * r5 MP-13: `EXPLAIN ANALYZE` of the queue's list, count and card at projected volume, with the cost of
 * publication. Every timing is logged as an `MP-13` line, so a CI log is the measurement record.
 *
 * THE SIZE IS AN ASSUMPTION. The plan's MP-07 row is a formula (records/day x revision rate x text
 * size), and no MP-07 measurement exists yet. 50 000 opportunities stands for 500 new ones a day over
 * the 90-day retention window, and two live matches and one source each. Replace it when MP-07 reports.
 *
 * THE BUDGETS ARE ASSUMPTIONS TOO: the plan names none. They are deliberately loose for a shared CI
 * runner. What pins the design is the plan shape: which index reads the generation, and how many of
 * its entries a page actually touches.
 */
const OPPORTUNITIES = 50_000
const FILLER_GENERATIONS = 4
const SENIORS = 20
const BUDGET_MS = { publish: 60_000, page: 1_000, selectivePage: 5_000, count: 5_000, card: 1_000 }

const ORDER_INDEX = 'uq_job_queue_generation_entries_order'
const ENTRY_INDEXES = [ORDER_INDEX, 'pk_job_queue_generation_entries']
const ENTRIES = 'job_queue_generation_entries'

const TAG = `mp13${randomUUID().slice(0, 8)}`
const SECRET = 'integration-secret-integration-secret'
const config = { get: () => SECRET } as unknown as ConfigService<Env, true>

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Actual Rows': number
  'Actual Loops': number
  Plans?: PlanNode[]
}
const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)]

let session: CrmAppSession
let service: JobQueueService
let scopes: JobQueueScopeService
let teamId = ''
let hr: SessionUser
const sqlq = (text: string, params: unknown[] = []) => session.admin.query(text, params)

async function explain(statement: SQL) {
  const { rows } = await session.databaseService.db.execute(
    sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
  )
  const [doc] = (rows[0] as Record<string, unknown>)['QUERY PLAN'] as [
    { Plan: PlanNode; 'Execution Time': number },
  ]
  return { nodes: nodesOf(doc.Plan), ms: doc['Execution Time'] }
}

/**
 * How a plan read the generation's entries: the plain or bitmap index nodes on the entries table's two
 * generation-leading indexes, with the rows they produced. A Seq Scan leaves this empty.
 */
const entryIndexReads = (nodes: readonly PlanNode[]) =>
  nodes.filter((n) => ENTRY_INDEXES.includes(n['Index Name'] ?? ''))
const rowsRead = (reads: readonly PlanNode[]) =>
  reads.reduce((sum, n) => sum + n['Actual Rows'] * n['Actual Loops'], 0)

/** The statements of the next list read, as they ran: generation lookup, counts, page. */
async function listStatements(over: Record<string, unknown>) {
  const db = session.databaseService.db
  const transaction = db.transaction.bind(db)
  const statements: SQL[] = []
  vi.spyOn(db, 'transaction').mockImplementationOnce((run, cfg) =>
    transaction(async (tx) => {
      const execute = tx.execute.bind(tx)
      vi.spyOn(tx, 'execute').mockImplementation(((query: SQL) => {
        statements.push(query)
        return execute(query)
      }) as never)
      return run(tx)
    }, cfg),
  )
  const res = await service.list(hr, jobQueueListQuerySchema.parse({ limit: 20, ...over }))
  vi.restoreAllMocks()
  return { res, counts: statements[1] as SQL, page: statements[2] as SQL }
}

describe.skipIf(!hasDatabaseUrl())(`MP-13 at ${OPPORTUNITIES} opportunities`, () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await sqlq(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    scopes = new JobQueueScopeService()
    service = new JobQueueService(session.databaseService, scopes, config)

    const team = await sqlq(`INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`, [
      `${TAG}-team`,
    ])
    teamId = team.rows[0].id as string
    const hrRow = await sqlq(
      `INSERT INTO users (email, display_name, role, tech_stack)
       VALUES ($1, $2, 'HR', ARRAY['Go']) RETURNING id`,
      [`${TAG}-hr@example.test`, `${TAG} hr`],
    )
    hr = { id: hrRow.rows[0].id, role: 'HR', email: 'hr@example.test' } as SessionUser
    await sqlq(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, hr.id])
    const seniors = await sqlq(
      `WITH made AS (
         INSERT INTO users (email, display_name, role, tech_stack)
         SELECT $1 || '-s' || g || '@example.test', $1 || ' s' || g, 'SENIOR', ARRAY['Go']
           FROM generate_series(1, $2::int) g RETURNING id),
       joined AS (INSERT INTO team_members (team_id, user_id) SELECT $3::uuid, id FROM made)
       SELECT id FROM made`,
      [TAG, SENIORS, teamId],
    )
    const live = (await loadRoster(session.databaseService.db)).versions
    const roster = seniors.rows.map((r: { id: string }, pos: number) => {
      const v = live.get(r.id)
      if (v === undefined) throw new Error('a seeded senior has no live version')
      return { senior_id: r.id, profile: v.profile, exclusion: v.exclusion, pos }
    })

    await sqlq(
      `INSERT INTO job_opportunities (title, title_key, first_seen_at)
       SELECT $1 || ' opp ' || g, $1 || '-opp-' || g, now() - g * interval '1 minute'
         FROM generate_series(1, $2::int) g`,
      [TAG, OPPORTUNITIES],
    )
    await sqlq(
      `WITH r AS (
         INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
         SELECT 'GREENHOUSE_ATS', $1 || '-ns', 'NATIVE_ID', o.id::text, 'https://jobs.example.test/' || o.id
           FROM job_opportunities o WHERE o.title LIKE $1 || ' opp %' RETURNING id, identity_key)
       INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
       SELECT r.id, r.identity_key::uuid, 'r1' FROM r`,
      [TAG],
    )
    await sqlq(
      `INSERT INTO job_opportunity_matches
         (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
          exclusion_version, rule_version, outcome, evidence)
       SELECT o.id, s.senior_id, o.revision, s.profile, s.exclusion, $3::text, 'LEAD',
              jsonb_build_object('score', o.ord % 1000, 'reasons', '[]'::jsonb)
         FROM (SELECT id, revision, row_number() OVER (ORDER BY id) AS ord
                 FROM job_opportunities WHERE title LIKE $1 || ' opp %') o
         JOIN jsonb_to_recordset($2::jsonb)
              AS s(senior_id uuid, profile text, exclusion text, pos int)
           ON s.pos = o.ord % ${SENIORS} OR s.pos = (o.ord + 1) % ${SENIORS}`,
      [TAG, JSON.stringify(roster), MATCH_RULE_VERSION],
    )
    // Other scopes' generations share the entries table, as they will in production.
    for (let i = 0; i < FILLER_GENERATIONS; i += 1) {
      // Two statements: the entries trigger must see the BUILDING parent already in place.
      const filler = await sqlq(
        `WITH t AS (INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id)
         INSERT INTO job_queue_generations
           (scope_kind, team_id, policy_signature, rule_version, evaluated_at, expires_at)
         SELECT 'TEAM', t.id, 'filler', 'filler', now(), now() + interval '1 hour' FROM t
         RETURNING id`,
        [`${TAG}-filler-${i}`],
      )
      await sqlq(
        `INSERT INTO job_queue_generation_entries
           (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
         SELECT $1::uuid, o.id, 1, (row_number() OVER (ORDER BY o.id) - 1)::int, o.first_seen_at, o.revision
           FROM (SELECT id, first_seen_at, revision FROM job_opportunities
                  WHERE title LIKE $2 || ' opp %' ORDER BY id LIMIT $3::int) o`,
        [filler.rows[0].id, TAG, GENERATION_POLICY.maxEntries],
      )
    }
    await sqlq(`ANALYZE job_opportunities`)
    await sqlq(`ANALYZE job_opportunity_matches`)
    await sqlq(`ANALYZE job_opportunity_sources`)
    await sqlq(`ANALYZE job_source_records`)
  }, 300_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      const teams = `SELECT id FROM teams WHERE name LIKE $1`
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE status <> 'INVALIDATED' AND team_id IN (${teams})`,
        [`${TAG}%`],
      )
      await sqlq(`DELETE FROM job_queue_generations WHERE team_id IN (${teams})`, [`${TAG}%`])
      const opps = `SELECT id FROM job_opportunities WHERE title LIKE $1`
      await sqlq(`DELETE FROM job_opportunity_sources WHERE opportunity_id IN (${opps})`, [
        `${TAG}%`,
      ])
      await sqlq(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_source_records WHERE namespace = $1`, [`${TAG}-ns`])
      await sqlq(`DELETE FROM team_members WHERE team_id IN (${teams})`, [`${TAG}%`])
      await sqlq(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    } finally {
      await session.close()
    }
  }, 300_000)

  it('publication over the whole table keeps the top of the order, within budget, and says it is capped', async () => {
    const started = performance.now()
    const res = await service.list(hr, jobQueueListQuerySchema.parse({ limit: 20 }))
    const ms = performance.now() - started
    console.log(`MP-13 publish+first-page ${OPPORTUNITIES} opportunities: ${Math.round(ms)} ms`)
    const { rows } = await sqlq(
      `SELECT count(*)::int AS n, max(e.order_key) AS last
         FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED'`,
      [teamId],
    )
    expect(rows[0]).toEqual({ n: 5000, last: 4999 })
    expect(res.generation?.capped).toBe(true)
    expect(res.items).toHaveLength(20)
    expect(ms).toBeLessThan(BUDGET_MS.publish)
    await sqlq(`ANALYZE ${ENTRIES}`)
  }, 120_000)

  it('an unselective page walks the order index and stops at limit + 1', async () => {
    const { res, page } = await listStatements({})
    expect(res.items).toHaveLength(20)
    const { nodes, ms } = await explain(page)
    console.log(`MP-13 page (unselective): ${ms} ms`)
    const reads = nodes.filter((n) => n['Index Name'] === ORDER_INDEX)
    expect(reads).toHaveLength(1)
    expect(reads[0]?.['Relation Name']).toBe(ENTRIES)
    expect(rowsRead(reads)).toBe(21)
    expect(ms).toBeLessThan(BUDGET_MS.page)
  })

  it('a selective tab must read the whole generation, through its index, within budget', async () => {
    const { rows: hits } = await sqlq(
      `SELECT e.opportunity_id FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED' ORDER BY e.order_key DESC LIMIT 3`,
      [teamId],
    )
    expect(hits).toHaveLength(3)
    for (const hit of hits) {
      await sqlq(
        `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by)
         VALUES ($1, 'TEAM', $2, 'mp13', $3)`,
        [hit.opportunity_id, teamId, hr.id],
      )
    }
    await sqlq(`ANALYZE job_queue_dismissals`)
    const { res, page } = await listStatements({ tab: 'HIDDEN' })
    expect(res.items).toHaveLength(3)
    expect(res.counts.HIDDEN).toBe(3)
    const { nodes, ms } = await explain(page)
    console.log(`MP-13 page (tab HIDDEN, 3 of 5000): ${ms} ms`)
    expect(rowsRead(entryIndexReads(nodes))).toBe(5000)
    expect(ms).toBeLessThan(BUDGET_MS.selectivePage)
  })

  it('the count reads every entry of the generation, through its index, within budget', async () => {
    const { res, counts } = await listStatements({})
    expect(res.counts).toEqual({ NEW: 4997, SUBMITTED: 0, HIDDEN: 3 })
    const { nodes, ms } = await explain(counts)
    console.log(`MP-13 count: ${ms} ms`)
    expect(rowsRead(entryIndexReads(nodes))).toBeGreaterThanOrEqual(5000)
    expect(ms).toBeLessThan(BUDGET_MS.count)
  })

  it('a card reads one opportunity by key, within budget', async () => {
    const scope: JobQueueScope = await scopes.resolve(hr, teamId, session.databaseService.db)
    const versions = await scopes.liveVersions(scope, session.databaseService.db)
    const { rows } = await sqlq(
      `SELECT e.opportunity_id FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED' AND e.order_key = 0`,
      [teamId],
    )
    const opportunity = rows[0].opportunity_id as string
    const { nodes, ms } = await explain(cardRow(scope, versions, opportunity))
    console.log(`MP-13 card row: ${ms} ms`)
    const scans = nodes.filter((n) => n['Relation Name'] === 'job_opportunities')
    expect(scans.length).toBeGreaterThan(0)
    expect(scans.map((n) => n['Node Type'])).not.toContain('Seq Scan')
    expect(ms).toBeLessThan(BUDGET_MS.card)
    const card = await service.card(hr, opportunity)
    expect(card.opportunityId).toBe(opportunity)
  })
})
