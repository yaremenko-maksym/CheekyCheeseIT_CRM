import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { SqlExecutor } from '../scheduling/host-state'
import { MATCH_RULE_VERSION, loadRoster } from './recompute-inputs'
import { reconcileOnce } from './reconciliation'

/**
 * r5 Task 4.6 S4b: the reconciliation sweep against a real Postgres, as `crm_app`.
 *
 * ISOLATION: the sweep scans EVERY opportunity, so each case runs inside a transaction that is
 * rolled back; the dirty rows it enqueues for other suites' opportunities never persist. Assertions
 * look only at this spec's own opportunities. Fixtures are committed and removed in `afterAll`.
 */
const TAG = randomUUID().slice(0, 8)
const ROLLBACK = new Error('rollback')

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>
let senior: string
let team: string
const mine: Record<'fresh' | 'stale' | 'none' | 'old', string> = {
  fresh: '',
  stale: '',
  none: '',
  old: '',
}

async function opportunity(label: string, firstSeen = 'now()'): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities (title, title_key, first_seen_at)
     VALUES ($1, $1, ${firstSeen}) RETURNING id`,
    [`s4b-${TAG}-${label}`],
  )
  return rows[0].id as string
}

async function match(opportunityId: string, profile: string, exclusion: string): Promise<void> {
  await session.admin.query(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version,
        rule_version, outcome)
     VALUES ($1, $2, 1, $3, $4, $5, 'LEAD')`,
    [opportunityId, senior, profile, exclusion, MATCH_RULE_VERSION],
  )
}

/** Run `body` in a transaction and roll it back; return what the body returned. */
async function rolledBack<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  let out: T | undefined
  await db
    .transaction(async (tx) => {
      out = await body(tx)
      throw ROLLBACK
    })
    .catch((e: unknown) => {
      if (e !== ROLLBACK) throw e
    })
  return out as T
}

async function myDirty(tx: SqlExecutor): Promise<{ entity_id: string; target_version: number }[]> {
  const ids = Object.values(mine)
  const { rows } = await tx.execute(
    sql`SELECT entity_id::text, target_version FROM job_dirty_work
         WHERE entity_kind = 'OPPORTUNITY'
           AND entity_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
         ORDER BY entity_id`,
  )
  return rows as { entity_id: string; target_version: number }[]
}

describe.skipIf(!hasDatabaseUrl())('match reconciliation against Postgres (Task 4.6 S4b)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows: cur } = await session.admin.query(`SELECT current_database() AS db`)
    if (cur[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
    const { rows: seniors } = await session.admin.query(
      `INSERT INTO users (email, display_name, role, tech_stack)
       VALUES ($1, 'S4b spec senior', 'SENIOR', ARRAY['Go']) RETURNING id`,
      [`s4b-senior-${TAG}@example.test`],
    )
    senior = seniors[0].id as string
    const { rows: teams } = await session.admin.query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
      [`s4b-team-${TAG}`],
    )
    team = teams[0].id as string
    await session.admin.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [
      team,
      senior,
    ])
    const live = (await loadRoster(db)).versions.get(senior)
    if (live === undefined) throw new Error('the spec senior is not in the roster')
    mine.fresh = await opportunity('fresh')
    mine.stale = await opportunity('stale')
    mine.none = await opportunity('none')
    mine.old = await opportunity('old', `now() - interval '40 days'`)
    await match(mine.fresh, live.profile, live.exclusion)
    await match(mine.stale, 'OLD-PROFILE', live.exclusion)
    await match(mine.old, live.profile, 'OLD-EXCLUSION')
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [
        Object.values(mine).filter(Boolean),
      ])
      await session.admin.query(`DELETE FROM team_members WHERE team_id = $1`, [team])
      await session.admin.query(`DELETE FROM teams WHERE id = $1`, [team])
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [senior])
    } finally {
      await session.close()
    }
  })

  it('AC1+AC2: enqueues stale, row-less and 40-day-old stale opportunities once; not fresh ones', async () => {
    const dirty = await rolledBack(async (tx) => {
      const report = await reconcileOnce(tx)
      expect(report.scanned).toBeGreaterThanOrEqual(4)
      expect(report.cursor).toBeNull()
      return myDirty(tx)
    })
    expect(dirty.map((d) => d.entity_id).sort()).toEqual([mine.stale, mine.none, mine.old].sort())
    expect(dirty.map((d) => Number(d.target_version))).toEqual([1, 1, 1])
  })

  it('AC3: a second sweep while the rows are pending enqueues nothing', async () => {
    const [first, second, count] = await rolledBack(async (tx) => {
      const a = await reconcileOnce(tx)
      const b = await reconcileOnce(tx)
      return [a, b, (await myDirty(tx)).length] as const
    })
    expect(first.enqueued).toBeGreaterThanOrEqual(3)
    expect(second.enqueued).toBe(0)
    expect(second.stale).toBe(first.stale)
    expect(count).toBe(3)
  })

  it('AC4: with a page size of 2 every stale opportunity is still enqueued, across pages', async () => {
    const [report, dirty] = await rolledBack(async (tx) => {
      const r = await reconcileOnce(tx, { pageSize: 2 })
      return [r, await myDirty(tx)] as const
    })
    expect(report.pages).toBeGreaterThan(1)
    expect(dirty).toHaveLength(3)
  })

  it('a bounded sweep returns a cursor and resuming from it covers the rest', async () => {
    const dirty = await rolledBack(async (tx) => {
      let cursor: string | null = null
      let guard = 0
      do {
        const r = await reconcileOnce(tx, { pageSize: 2, maxPages: 1, cursor })
        cursor = r.cursor
        guard += 1
      } while (cursor !== null && guard < 10_000)
      return myDirty(tx)
    })
    expect(dirty).toHaveLength(3)
  })
})
