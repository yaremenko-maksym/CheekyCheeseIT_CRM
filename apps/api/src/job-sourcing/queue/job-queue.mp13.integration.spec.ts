import { jobQueueListQuerySchema } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../../test/require-real-db'
import {
  ENTRIES,
  entryIndexReads,
  type Mp13Context,
  OPPORTUNITIES,
  ORDER_INDEX,
  rowsRead,
  setupMp13Fixture,
} from '../../test/job-queue-mp13.fixture'
import { cardRow } from './queue-read-sql'
import type { JobQueueScope } from './queue-scope'

/**
 * r5 MP-13: `EXPLAIN ANALYZE` of the queue's list, count and card at projected volume, with the cost of
 * publication. Every timing is logged as an `MP-13` line, so a CI log is the measurement record.
 *
 * THE SIZE IS AN ASSUMPTION. The plan's MP-07 row is a formula (records/day x revision rate x text
 * size), and no MP-07 measurement exists yet. 50 000 opportunities stands for 500 new ones a day over
 * the 90-day retention window, and two live matches and one source each. Replace it when MP-07 reports.
 *
 * What pins the design is the plan shape: which index reads the generation, and how many of
 * its entries a page actually touches.
 */
describe.skipIf(!hasDatabaseUrl())(`MP-13 at ${OPPORTUNITIES} opportunities`, () => {
  let ctx: Mp13Context

  beforeAll(async () => {
    ctx = await setupMp13Fixture()
  }, 300_000)

  afterAll(async () => {
    await ctx?.teardown()
  }, 300_000)

  it('publication over the whole table keeps the top of the order, within budget, and says it is capped', async () => {
    const res = await ctx.service.list(ctx.hr, jobQueueListQuerySchema.parse({ limit: 20 }))
    const { rows } = await ctx.sqlq(
      `SELECT count(*)::int AS n, max(e.order_key) AS last
         FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED'`,
      [ctx.teamId],
    )
    expect(rows[0]).toEqual({ n: 5000, last: 4999 })
    expect(res.generation?.capped).toBe(true)
    expect(res.items).toHaveLength(20)
    await ctx.sqlq(`ANALYZE ${ENTRIES}`)
  }, 120_000)

  it('an unselective page walks the order index and stops at limit + 1', async () => {
    const { res, page } = await ctx.listStatements({})
    expect(res.items).toHaveLength(20)
    const { nodes } = await ctx.explain(page)
    const reads = nodes.filter((n) => n['Index Name'] === ORDER_INDEX)
    expect(reads).toHaveLength(1)
    expect(reads[0]?.['Relation Name']).toBe(ENTRIES)
    expect(rowsRead(reads)).toBe(21)
  })

  it('a selective tab must read the whole generation, through its index, within budget', async () => {
    const { rows: hits } = await ctx.sqlq(
      `SELECT e.opportunity_id FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED' ORDER BY e.order_key DESC LIMIT 3`,
      [ctx.teamId],
    )
    expect(hits).toHaveLength(3)
    for (const hit of hits) {
      await ctx.sqlq(
        `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by)
         VALUES ($1, 'TEAM', $2, 'mp13', $3)`,
        [hit.opportunity_id, ctx.teamId, ctx.hr.id],
      )
    }
    await ctx.sqlq(`ANALYZE job_queue_dismissals`)
    const { res, page } = await ctx.listStatements({ tab: 'HIDDEN' })
    expect(res.items).toHaveLength(3)
    expect(res.counts.HIDDEN).toBe(3)
    const { nodes } = await ctx.explain(page)
    expect(rowsRead(entryIndexReads(nodes))).toBe(5000)
  })

  it('the count reads every entry of the generation, through its index, within budget', async () => {
    const { res, counts } = await ctx.listStatements({})
    expect(res.counts).toEqual({ NEW: 4997, SUBMITTED: 0, HIDDEN: 3 })
    const { nodes } = await ctx.explain(counts)
    expect(rowsRead(entryIndexReads(nodes))).toBeGreaterThanOrEqual(5000)
  })

  it('a card reads one opportunity by key, within budget', async () => {
    const scope: JobQueueScope = await ctx.scopes.resolve(
      ctx.hr,
      ctx.teamId,
      ctx.session.databaseService.db,
    )
    const versions = await ctx.scopes.liveVersions(scope, ctx.session.databaseService.db)
    const { rows } = await ctx.sqlq(
      `SELECT e.opportunity_id FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED' AND e.order_key = 0`,
      [ctx.teamId],
    )
    const opportunity = rows[0].opportunity_id as string
    const { nodes } = await ctx.explain(cardRow(scope, versions, opportunity))
    const scans = nodes.filter((n) => n['Relation Name'] === 'job_opportunities')
    expect(scans.length).toBeGreaterThan(0)
    expect(scans.map((n) => n['Node Type'])).not.toContain('Seq Scan')
    const card = await ctx.service.card(ctx.hr, opportunity)
    expect(card.opportunityId).toBe(opportunity)
  })
})
