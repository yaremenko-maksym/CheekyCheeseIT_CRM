import { jobQueueListQuerySchema } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../../test/require-real-db'
import {
  BUDGET_MS,
  ENTRIES,
  type Mp13Context,
  OPPORTUNITIES,
  setupMp13Fixture,
} from './__test-helpers__/job-queue-mp13.fixture'
import { cardRow } from './queue-read-sql'
import type { JobQueueScope } from './queue-scope'

if (Boolean(process.env['CI']) && !hasDatabaseUrl()) {
  it('CI timing run has no DATABASE_URL', () => {
    expect(hasDatabaseUrl(), 'CI timing run has no DATABASE_URL').toBe(true)
  })
}

describe.skipIf(!hasDatabaseUrl())(`MP-13 timing at ${OPPORTUNITIES} opportunities`, () => {
  let ctx: Mp13Context

  beforeAll(async () => {
    ctx = await setupMp13Fixture()
  }, 300_000)

  afterAll(async () => {
    await ctx?.teardown()
  }, 300_000)

  it('publication over the whole table keeps within budget', async () => {
    const started = performance.now()
    await ctx.service.list(ctx.hr, jobQueueListQuerySchema.parse({ limit: 20 }))
    const ms = performance.now() - started
    console.log(`MP-13 publish+first-page ${OPPORTUNITIES} opportunities: ${Math.round(ms)} ms`)
    expect(ms).toBeLessThan(BUDGET_MS.publish)
    await ctx.sqlq(`ANALYZE ${ENTRIES}`)
  }, 120_000)

  it('an unselective page walks the order index within budget', async () => {
    const { page } = await ctx.listStatements({})
    const { ms } = await ctx.explain(page)
    console.log(`MP-13 page (unselective): ${ms} ms`)
    expect(ms).toBeLessThan(BUDGET_MS.page)
  })

  it('a selective tab reads within budget', async () => {
    const { rows: hits } = await ctx.sqlq(
      `SELECT e.opportunity_id FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED' ORDER BY e.order_key DESC LIMIT 3`,
      [ctx.teamId],
    )
    for (const hit of hits) {
      await ctx.sqlq(
        `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by)
         VALUES ($1, 'TEAM', $2, 'mp13', $3)`,
        [hit.opportunity_id, ctx.teamId, ctx.hr.id],
      )
    }
    await ctx.sqlq(`ANALYZE job_queue_dismissals`)
    const { page } = await ctx.listStatements({ tab: 'HIDDEN' })
    const { ms } = await ctx.explain(page)
    console.log(`MP-13 page (tab HIDDEN, 3 of 5000): ${ms} ms`)
    expect(ms).toBeLessThan(BUDGET_MS.selectivePage)
  })

  it('the count reads within budget', async () => {
    const { counts } = await ctx.listStatements({})
    const { ms } = await ctx.explain(counts)
    console.log(`MP-13 count: ${ms} ms`)
    expect(ms).toBeLessThan(BUDGET_MS.count)
  })

  it('a card reads one opportunity by key within budget', async () => {
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
    const { ms } = await ctx.explain(cardRow(scope, versions, opportunity))
    console.log(`MP-13 card row: ${ms} ms`)
    expect(ms).toBeLessThan(BUDGET_MS.card)
  })
})
