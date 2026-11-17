import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { LedgerFixtures, LedgerKit, SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { FetchProfile } from '../scheduling/next-slot'
import { JobRunLedger } from './job-run-ledger'

/**
 * Enabling a source must arm its first scheduled slot: a seeded source has `next_attempt_at NULL`,
 * which the due predicate never selects (tick and sweep), so `setEnabled` has to set it. AS `crm_app`,
 * on a scratch database, NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.enable-slot.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOURLY: FetchProfile = { intervalMinutes: 60, offIntervalMinutes: null, window: null }

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger

const slotOf = async (id: string): Promise<string | null> => {
  const { rows } = await session.admin.query(
    `SELECT next_attempt_at::text AS s FROM job_sources WHERE id = $1`,
    [id],
  )
  return rows[0].s as string | null
}

async function claimScheduled(id: string) {
  const { cycleId } = await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: fx.cycleKey() })
  const { claimed } = await ledger.claimDue({
    cycleId,
    owner: 'spec-worker',
    limit: 5,
    onlyIds: [id],
  })
  return claimed
}

describe.skipIf(!hasDatabaseUrl())('setEnabled arms the first scheduled slot, as crm_app', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    ledger = new JobRunLedger(
      drizzle(session.pool, { schema }),
      specRegistry(['REMOTIVE_API']),
      catalog,
    )
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'enable-slot spec', 'ADMIN') RETURNING id`,
      [`enable-slot-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it('runs on a scratch database, as crm_app', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('a disabled source with a NULL slot is due right after it is enabled', async () => {
    const id = await kit.reporting(
      { enabled: false, nextAttemptSql: 'NULL' },
      { fetchProfile: HOURLY },
    )
    expect(await slotOf(id)).toBeNull()
    expect(await ledger.setEnabled({ sourceId: id, actor: kit.actor, enabled: true })).toEqual({
      kind: 'SWITCHED',
      changed: true,
      cancelledRuns: 0,
    })
    expect(await slotOf(id)).not.toBeNull()
    const claimed = await claimScheduled(id)
    expect(claimed.map((r) => r.sourceId)).toEqual([id])
  })

  it('enabling keeps an existing future slot; disabling leaves the slot alone', async () => {
    const id = await kit.reporting(
      { enabled: false, nextAttemptSql: "clock_timestamp() + interval '1 day'" },
      { fetchProfile: HOURLY },
    )
    const before = await slotOf(id)
    await ledger.setEnabled({ sourceId: id, actor: kit.actor, enabled: true })
    expect(await slotOf(id)).toBe(before)
    expect(await claimScheduled(id)).toEqual([])
    await ledger.setEnabled({ sourceId: id, actor: kit.actor, enabled: false })
    expect(await slotOf(id)).toBe(before)
  })

  it('disabling a NULL-slot source does not arm a slot', async () => {
    const id = await kit.reporting({ nextAttemptSql: 'NULL' }, { fetchProfile: HOURLY })
    await ledger.setEnabled({ sourceId: id, actor: kit.actor, enabled: false })
    expect(await slotOf(id)).toBeNull()
  })
})
