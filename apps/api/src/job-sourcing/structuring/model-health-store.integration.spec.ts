import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { createDrizzleModelHealthStore } from './model-health-store'

/**
 * The §5.3 store as `crm_app` on a pushed schema: what the handler's port promises and only SQL can
 * prove. The upsert sums, a raised flag keeps its first `raised_at`, and a cycle's emission survives
 * a restart (a second store instance).
 *
 * NEVER `crm_db` (`openCrmAppSession` refuses one):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run model-health-store.integration
 */
const { jobModelHealthFlags: flags, jobModelRouteDaily: counters } = schema
// `last_emitted_cycle_id` is a uuid column.
const CYCLE_1 = '00000000-0000-4000-8000-000000000001'
const CYCLE_2 = '00000000-0000-4000-8000-000000000002'

describe.skipIf(!hasDatabaseUrl())('createDrizzleModelHealthStore', () => {
  let session: CrmAppSession
  let db: ReturnType<typeof drizzle<typeof schema>>
  let store: ReturnType<typeof createDrizzleModelHealthStore>

  const rowOf = async (flag: schema.ModelHealthFlag) => {
    const [row] = await db.select().from(flags).where(eq(flags.flag, flag))
    return row!
  }

  beforeAll(async () => {
    session = await openCrmAppSession()
    db = drizzle(session.pool, { schema })
    store = createDrizzleModelHealthStore(db)
  }, 120_000)

  beforeEach(async () => {
    await session.admin.query('DELETE FROM job_model_route_daily WHERE true')
    await session.admin.query('DELETE FROM job_model_health_flags WHERE true')
  })

  afterAll(async () => {
    if (session === undefined) return
    await session.admin.query('DELETE FROM job_model_route_daily WHERE true')
    await session.admin.query('DELETE FROM job_model_health_flags WHERE true')
    await session.close()
  })

  it('counts for one day, route and code add up; another code or day is its own row', async () => {
    const day = '2026-11-06'
    await store.addRouteCounts([{ day, route: 'local', code: 'FELL_TO_LOCAL', count: 2 }])
    await store.addRouteCounts([
      { day, route: 'local', code: 'FELL_TO_LOCAL', count: 3 },
      { day, route: 'groq', code: 'OK', count: 1 },
      { day: '2026-11-07', route: 'local', code: 'FELL_TO_LOCAL', count: 7 },
    ])
    const rows = await db.select().from(counters)
    expect(rows.map((r) => [r.day, r.route, r.code, r.count]).sort()).toEqual([
      ['2026-11-06', 'groq', 'OK', 1],
      ['2026-11-06', 'local', 'FELL_TO_LOCAL', 5],
      ['2026-11-07', 'local', 'FELL_TO_LOCAL', 7],
    ])
  })

  it('a flag still raised keeps its first raised_at; after a clear, raising starts over', async () => {
    await store.raiseFlag('MODEL_UNREACHABLE')
    const first = await rowOf('MODEL_UNREACHABLE')
    expect(first.clearedAt).toBeNull()

    await store.raiseFlag('MODEL_UNREACHABLE')
    expect((await rowOf('MODEL_UNREACHABLE')).raisedAt).toEqual(first.raisedAt)

    await store.clearFlag('MODEL_UNREACHABLE')
    const cleared = await rowOf('MODEL_UNREACHABLE')
    expect(cleared.clearedAt).not.toBeNull()

    await store.clearFlag('MODEL_UNREACHABLE')
    expect((await rowOf('MODEL_UNREACHABLE')).clearedAt).toEqual(cleared.clearedAt)

    await store.raiseFlag('MODEL_UNREACHABLE')
    const again = await rowOf('MODEL_UNREACHABLE')
    expect(again.clearedAt).toBeNull()
    expect(again.raisedAt.getTime()).toBeGreaterThanOrEqual(first.raisedAt.getTime())
  })

  it('clearing a flag never raised writes no row', async () => {
    await store.clearFlag('HOSTED_ROUTES_DEAD')
    expect(await db.select().from(flags)).toEqual([])
  })

  it('a raised flag is claimed once per cycle, also across a restart; the next cycle claims it again', async () => {
    await store.raiseFlag('HOSTED_ROUTES_DEAD')
    expect(await store.claimEmissions(CYCLE_1)).toEqual(['HOSTED_ROUTES_DEAD'])
    expect(await store.claimEmissions(CYCLE_1)).toEqual([])

    const restarted = createDrizzleModelHealthStore(db)
    expect(await restarted.claimEmissions(CYCLE_1)).toEqual([])
    expect(await restarted.claimEmissions(CYCLE_2)).toEqual(['HOSTED_ROUTES_DEAD'])
  })

  it('a cleared flag is not claimed', async () => {
    await store.raiseFlag('HOSTED_ROUTES_DEAD')
    await store.clearFlag('HOSTED_ROUTES_DEAD')
    expect(await store.claimEmissions(CYCLE_1)).toEqual([])
  })
})
