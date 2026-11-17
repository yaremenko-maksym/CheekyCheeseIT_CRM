import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { DouRssProvider } from '../dou.provider'
import { __resetThrottleForTests } from '../http/bounded-fetch'
import { AVAILABILITY_REASON_PREFIX } from '../ownership/dirty-work.store'
import {
  type FixtureServer,
  type World,
  openWorld,
  routeFetchTo,
  runRow,
  startFixtureServer,
} from '../runtime/__test-helpers__/runtime-harness'
import { RecomputeWorker, createRecomputeSteps } from '../runtime/recompute-worker'
import { createProductionRegistry } from './production-registry'
import { REPORTING_WIRING } from './reporting-wiring'

/**
 * From "ADMIN enables" to stored rows, with the adapter the PRODUCTION registry builds (its real
 * provider, version and pinned hosts), against a REAL Postgres as `crm_app` and a LOCAL fixture
 * server (no request leaves the machine):
 *
 *   enable (`JobRunLedger.setEnabled`) -> claim + run (`JobRunWorker.runDue`, the cron's window)
 *   -> `job_source_records` + `job_dirty_work` -> recompute (`RecomputeWorker.runOnce`, the
 *   reconciliation cron's drain) -> `job_opportunities`.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run production-registry.integration
 */
const TAG = randomUUID().slice(0, 8)
const ARBEITNOW_HOST = 'www.arbeitnow.com'

let session: CrmAppSession
let w: World
let fixture: FixtureServer
let restoreFetch: () => void

const production = createProductionRegistry(new DouRssProvider())

function arbeitnowPage(ids: readonly string[]) {
  return {
    data: ids.map((id) => ({
      slug: `preg-${TAG}-${id}`,
      url: `https://www.arbeitnow.com/jobs/preg-${TAG}-${id}`,
      title: `Engineer ${id}`,
      company_name: `Acme ${TAG}`,
      description: '<p>Build things.</p>',
      remote: true,
      location: 'Berlin',
      tags: [],
      job_types: [],
      created_at: 1_761_000_000,
    })),
    links: { next: null },
  }
}

/** A source created disabled, as the ADMIN finds it before the switch. */
async function disabledSource(config: Record<string, unknown>, blocked = false) {
  const s = await w.source({
    type: 'ARBEITNOW_API',
    config,
    ...(blocked
      ? {
          entry: {
            activationFacts: () => ({
              readiness: 'BLOCKED' as const,
              blockerCodes: ['OWNER_DECISION_REQUIRED'],
              payloadVerified: true,
            }),
            entryReadiness: () => 'BLOCKED' as const,
          },
        }
      : {}),
  })
  await w.admin.query(`UPDATE job_sources SET enabled = false WHERE id = $1`, [s.sourceId])
  return s
}

describe.skipIf(!hasDatabaseUrl())('production registry: enable -> run -> stored rows', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    w = await openWorld(session, TAG)
    // The adapter exactly as production builds it, not a spec-wired copy.
    const adapter = production.get('ARBEITNOW_API')
    if (adapter === undefined) throw new Error('ARBEITNOW_API is not in the production registry')
    w.registerAdapter(adapter)
    fixture = await startFixtureServer()
    restoreFetch = routeFetchTo(fixture)
  }, 120_000)

  afterAll(async () => {
    restoreFetch?.()
    await fixture?.close()
    if (session === undefined) return
    try {
      // `cleanupStore`'s order, keyed by identity (Arbeitnow's namespace is the global '').
      const records = `SELECT id FROM job_source_records WHERE identity_key LIKE $1`
      const key = `%preg-${TAG}-%`
      const { rows } = await session.admin.query(
        `SELECT DISTINCT opportunity_id AS id FROM job_opportunity_sources WHERE source_record_id IN (${records})`,
        [key],
      )
      const opportunities = rows.map((r) => r.id as string)
      await session.admin.query(
        `DELETE FROM job_dirty_work WHERE entity_id IN (${records}) OR entity_id = ANY($2::uuid[])`,
        [key, opportunities],
      )
      await session.admin.query(
        `DELETE FROM job_opportunity_sources WHERE source_record_id IN (${records})`,
        [key],
      )
      await session.admin.query(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [
        opportunities,
      ])
      await session.admin.query(
        `DELETE FROM job_source_record_revisions WHERE source_record_id IN (${records})`,
        [key],
      )
      await session.admin.query(`DELETE FROM job_source_records WHERE identity_key LIKE $1`, [key])
    } finally {
      // The world (its sources, cycles, actor) goes even if the record cleanup threw.
      try {
        await w?.close()
      } finally {
        await session.close()
      }
    }
  })

  beforeEach(() => {
    __resetThrottleForTests()
  })

  afterEach(() => {
    fixture.requests.length = 0
  })

  it('runs on a scratch database as crm_app, never crm_db', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('a BLOCKED source stays refused even though its adapter is registered', async () => {
    const { sourceId } = await disabledSource({ maxPages: 7 }, true)
    expect(await w.ledger.setEnabled({ sourceId, actor: w.actor, enabled: true })).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_READY',
    })
  })

  it('a CANDIDATE source is enabled, claimed, run on its pinned host, and lands as opportunities', async () => {
    const { sourceId } = await disabledSource({ maxPages: 1 })
    expect(await w.ledger.setEnabled({ sourceId, actor: w.actor, enabled: true })).toMatchObject({
      kind: 'SWITCHED',
      changed: true,
    })

    fixture.answer = () => ({ body: arbeitnowPage(['a1', 'a2']) })
    const [report] = await w.worker().runDue({ cycleId: await w.cycle(), onlyIds: [sourceId] })
    expect(report).toMatchObject({ outcome: 'SUCCEEDED', errorCode: null, finished: true })
    // The transport reached the wiring's host and nothing else.
    expect(REPORTING_WIRING.ARBEITNOW_API?.allowedHosts).toEqual([ARBEITNOW_HOST])
    expect(fixture.requests.map((r) => r.host)).toEqual([ARBEITNOW_HOST])
    expect(await runRow(w.admin, report!.runId)).toMatchObject({
      outcome: 'SUCCEEDED',
      received: 2,
    })

    const records = await w.admin.query(
      `SELECT id FROM job_source_records WHERE source_type = 'ARBEITNOW_API' AND identity_key LIKE $1`,
      [`%preg-${TAG}-%`],
    )
    expect(records.rowCount).toBe(2)
    const recordIds = records.rows.map((r) => r.id as string)

    // Put this spec's match-partition rows first, then drain exactly that many (other specs share
    // the table; the availability partition is the other consumer's).
    const pinned = await w.admin.query(
      `UPDATE job_dirty_work SET created_at = '2000-01-01T00:00:00Z'::timestamptz
        WHERE status = 'PENDING' AND entity_id = ANY($1::uuid[])
          AND NOT starts_with(reason, $2)`,
      [recordIds, AVAILABILITY_REASON_PREFIX],
    )
    expect(pinned.rowCount).toBeGreaterThanOrEqual(2)
    await new RecomputeWorker(createRecomputeSteps(w.db as never), {
      owner: `preg-spec-${TAG}`,
      batchSize: pinned.rowCount!,
    }).runOnce()

    const opportunities = await w.admin.query(
      `SELECT DISTINCT o.id FROM job_opportunities o
         JOIN job_opportunity_sources s ON s.opportunity_id = o.id AND s.unlinked_at IS NULL
        WHERE s.source_record_id = ANY($1::uuid[])`,
      [recordIds],
    )
    expect(opportunities.rowCount).toBe(2)
  })
})
