import { randomUUID } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import { jobQueueListQuerySchema, type SessionUser } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { vi } from 'vitest'
import type { Env } from '../config/env'
import { type CrmAppSession, openCrmAppSession } from '../database/__test-helpers__/crm-app-session'
import { loadRoster, MATCH_RULE_VERSION } from '../job-sourcing/runtime/recompute-inputs'
import { JobQueueService } from '../job-sourcing/queue/job-queue.service'
import { GENERATION_POLICY } from '../job-sourcing/queue/queue-generation'
import { JobQueueScopeService } from '../job-sourcing/queue/queue-scope.service'

export const OPPORTUNITIES = 50_000
export const FILLER_GENERATIONS = 4
export const SENIORS = 20
export const BUDGET_MS = {
  publish: 60_000,
  page: 1_000,
  selectivePage: 5_000,
  count: 5_000,
  card: 1_000,
}

export const ORDER_INDEX = 'uq_job_queue_generation_entries_order'
export const ENTRY_INDEXES = [ORDER_INDEX, 'pk_job_queue_generation_entries']
export const ENTRIES = 'job_queue_generation_entries'

const SECRET = 'integration-secret-integration-secret'
const config = { get: () => SECRET } as unknown as ConfigService<Env, true>

export interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Actual Rows': number
  'Actual Loops': number
  'Actual Total Time'?: number
  Plans?: PlanNode[]
}

export const nodesOf = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(nodesOf),
]

export const entryIndexReads = (nodes: readonly PlanNode[]) =>
  nodes.filter((n) => ENTRY_INDEXES.includes(n['Index Name'] ?? ''))

export const rowsRead = (reads: readonly PlanNode[]) =>
  reads.reduce((sum, n) => sum + n['Actual Rows'] * n['Actual Loops'], 0)

export interface Mp13Context {
  session: CrmAppSession
  service: JobQueueService
  scopes: JobQueueScopeService
  teamId: string
  hr: SessionUser
  sqlq: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  explain: (statement: SQL) => Promise<{ nodes: PlanNode[]; ms: number }>
  listStatements: (over: Record<string, unknown>) => Promise<{
    res: Awaited<ReturnType<JobQueueService['list']>>
    counts: SQL
    page: SQL
  }>
  teardown: () => Promise<void>
}

export async function setupMp13Fixture(): Promise<Mp13Context> {
  const session = await openCrmAppSession({ appPoolMax: 4 })
  const sqlq = (text: string, params: unknown[] = []) => session.admin.query(text, params)
  const probe = await sqlq(`SELECT current_database() AS db`)
  if (probe.rows[0].db === 'crm_db') {
    await session.close()
    throw new Error('refusing the live database')
  }

  const TAG = `mp13${randomUUID().slice(0, 8)}`

  async function teardown() {
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
      await sqlq(`DELETE FROM job_queue_dismissals WHERE reason = 'mp13'`)
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
  }

  try {
    const scopes = new JobQueueScopeService()
    const service = new JobQueueService(session.databaseService, scopes, config)

    const team = await sqlq(`INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`, [
      `${TAG}-team`,
    ])
    const teamId = team.rows[0].id as string

    const hrRow = await sqlq(
      `INSERT INTO users (email, display_name, role, tech_stack)
     VALUES ($1, $2, 'HR', ARRAY['Go']) RETURNING id`,
      [`${TAG}-hr@example.test`, `${TAG} hr`],
    )
    const hr = { id: hrRow.rows[0].id, role: 'HR', email: 'hr@example.test' } as SessionUser
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

    for (let i = 0; i < FILLER_GENERATIONS; i += 1) {
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

    async function explain(statement: SQL) {
      const { rows } = await session.databaseService.db.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
      )
      const [doc] = (rows[0] as Record<string, unknown>)['QUERY PLAN'] as [
        {
          Plan: PlanNode
          'Execution Time': number
          'Planning Time'?: number
          JIT?: {
            Functions?: number
            Timing?: {
              Total?: number
              [key: string]: unknown
            }
            [key: string]: unknown
          }
        },
      ]
      const nodes = nodesOf(doc.Plan)
      const jitStr = doc.JIT
        ? `JIT Functions=${doc.JIT.Functions ?? '?'} Timing.Total=${doc.JIT.Timing?.Total ?? '?'} ms`
        : 'JIT none'
      const topNodes = [...nodes]
        .filter((n) => typeof n['Actual Total Time'] === 'number')
        .sort((a, b) => (b['Actual Total Time'] ?? 0) - (a['Actual Total Time'] ?? 0))
        .slice(0, 3)
        .map(
          (n) =>
            `${n['Node Type']} / ${n['Index Name'] ?? 'none'} / ${n['Relation Name'] ?? 'none'} / ${n['Actual Total Time']} / ${n['Actual Rows']} / ${n['Actual Loops']}`,
        )
        .join(' | ')
      console.log(
        `[explain] Execution Time: ${doc['Execution Time']} ms, Planning Time: ${doc['Planning Time'] ?? 'none'} ms, ${jitStr}, top nodes: [${topNodes}]`,
      )
      return { nodes, ms: doc['Execution Time'] }
    }

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

    return {
      session,
      service,
      scopes,
      teamId,
      hr,
      sqlq,
      explain,
      listStatements,
      teardown,
    }
  } catch (err) {
    await teardown()
    throw err
  }
}
