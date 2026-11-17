import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { DouRssProvider } from '../dou.provider'
import { createProductionRegistry } from '../registry/production-registry'
import { meterRow, openWorld, type World } from './__test-helpers__/runtime-harness'
import { LEDGER_CATALOG_SNAPSHOT } from './ledger-catalog.snapshot'
import { catalogFromSnapshot } from './production-catalog'

/**
 * PR #1372 round 1, item 1: the seed delta stores a keyed row as CANDIDATE (KEY_REQUIRED is never
 * stored; `manifest.drift.spec` pins that), so the ONLY thing between an ADMIN and a keyed source is
 * the live key check. This proves it holds at both doors, against a REAL Postgres as `crm_app`, with
 * the production Jooble adapter and the committed catalog entry. Nothing is sent: enable and claim
 * are refused before any request, and the "key set" case only enables.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run keyed-source-readiness.integration
 */
const TAG = randomUUID().slice(0, 8)
const JOOBLE_ENTRY = 'jooble.api.senior-developer-remote'
const production = createProductionRegistry(new DouRssProvider())

let session: CrmAppSession
let w: World

/** A disabled Jooble row as the delta leaves it: stored CANDIDATE, optionally bound to a meter. */
async function joobleSource(keySet: boolean, metered = true) {
  const entry = catalogFromSnapshot(
    LEDGER_CATALOG_SNAPSHOT,
    (t) => keySet && t === 'JOOBLE_API',
  ).entry(JOOBLE_ENTRY)
  if (entry === undefined) throw new Error(`${JOOBLE_ENTRY} is not in the committed snapshot`)
  const accountMeterId = metered
    ? await meterRow(w.admin, w.fx.accountKey(`jooble-${randomUUID().slice(0, 6)}`), {
        unit: 'REQUEST',
        window: 'DAY',
        limit: 50,
      })
    : null
  const { sourceId } = await w.source({
    type: 'JOOBLE_API',
    config: { keywords: `kr ${TAG} ${randomUUID().slice(0, 6)}`, location: 'remote' },
    accountMeterId,
    entry,
  })
  await w.admin.query(
    `UPDATE job_sources SET enabled = false, readiness = 'CANDIDATE', readiness_reason = NULL WHERE id = $1`,
    [sourceId],
  )
  return sourceId
}

describe.skipIf(!hasDatabaseUrl())(
  'a keyed source: KEY_REQUIRED is checked live (PR #1372)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      w = await openWorld(session, TAG)
      const adapter = production.get('JOOBLE_API')
      if (adapter === undefined) throw new Error('JOOBLE_API is not in the production registry')
      w.registerAdapter(adapter)
    }, 120_000)

    afterAll(async () => {
      if (session === undefined) return
      try {
        await w?.close()
      } finally {
        await session.close()
      }
    })

    it('runs on a scratch database as crm_app, never crm_db', async () => {
      const { rows } = await session.pool.query('SELECT current_database() AS db')
      expect(rows[0].db).not.toBe('crm_db')
    })

    it('without the key: enable is refused NOT_READY, though the stored readiness is CANDIDATE', async () => {
      const sourceId = await joobleSource(false)
      expect(await w.ledger.setEnabled({ sourceId, actor: w.actor, enabled: true })).toEqual({
        kind: 'REFUSED',
        reason: 'NOT_READY',
      })
      const { rows } = await w.admin.query(
        `SELECT enabled, readiness::text FROM job_sources WHERE id = $1`,
        [sourceId],
      )
      expect(rows[0]).toEqual({ enabled: false, readiness: 'CANDIDATE' })
    })

    it('without the key: a source already switched on is refused READINESS_BLOCKED at claim, on both paths', async () => {
      const sourceId = await joobleSource(false)
      await w.admin.query(`UPDATE job_sources SET enabled = true WHERE id = $1`, [sourceId])
      const due = await w.ledger.claimDue({
        cycleId: await w.cycle(),
        owner: `kr-${TAG}`,
        limit: 1,
        onlyIds: [sourceId],
      })
      expect(due).toEqual({ claimed: [], refused: [{ sourceId, reason: 'READINESS_BLOCKED' }] })
      const manual = await w.ledger.claimSource({
        cycleId: await w.manualCycle(),
        owner: `kr-${TAG}`,
        sourceId,
        actor: w.actor,
      })
      expect(manual).toEqual({ kind: 'REFUSED', reason: 'READINESS_BLOCKED' })
    })

    it('with the key set and a bound meter: enable is allowed', async () => {
      const sourceId = await joobleSource(true)
      expect(await w.ledger.setEnabled({ sourceId, actor: w.actor, enabled: true })).toMatchObject({
        kind: 'SWITCHED',
        changed: true,
      })
    })

    it('with the key set but no meter bound: enable is still refused (the deploy step binds it)', async () => {
      const sourceId = await joobleSource(true, false)
      expect(await w.ledger.setEnabled({ sourceId, actor: w.actor, enabled: true })).toEqual({
        kind: 'REFUSED',
        reason: 'NOT_READY',
      })
    })
  },
)
