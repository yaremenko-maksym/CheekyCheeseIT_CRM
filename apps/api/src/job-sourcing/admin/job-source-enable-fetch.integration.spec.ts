import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import type { DatabaseService } from '../../database/database.service'
import * as schema from '../../database/schema'
import {
  handleOf,
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  specRegistry,
} from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { JobRunWorker } from '../runtime/job-run-worker'
import type { FetchProfile } from '../scheduling/next-slot'
import { JobSourceAdminService } from './job-source-admin.service'

/**
 * The enable fetch against a real Postgres (CR-M-3, SR-H-1): the freshness SELECT on
 * `last_attempt_at`, one run per window however often the source is toggled, the MANUAL cycle
 * closed, and no slot armed for a null-profile source. AS `crm_app`, on a scratch database, NEVER
 * `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-source-enable-fetch.integration
 */
const TAG = randomUUID().slice(0, 8)
const HOURLY: FetchProfile = { intervalMinutes: 60, offIntervalMinutes: null, window: null }

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let service: JobSourceAdminService
let admin: SessionUser
let fetchSpy: ReturnType<typeof vi.spyOn>

/**
 * The fake worker claims through the REAL manual path; by default it leaves the run STARTED (in
 * flight), with `finishRuns` it ends it SUCCEEDED through the real `finish`.
 */
let finishRuns = false
const worker = {
  runSource: async (input: Parameters<JobRunWorker['runSource']>[0]) => {
    const claim = await ledger.claimSource({ ...input, owner: 'spec-worker' })
    if (claim.kind === 'REFUSED') return claim
    if (finishRuns) {
      await ledger.finish(handleOf(claim.run), { outcome: 'SUCCEEDED', errorCode: null })
    }
    return { kind: 'RAN' as const }
  },
} as unknown as JobRunWorker

async function toggle(id: string, enabled: boolean) {
  fetchSpy.mockClear()
  await service.setEnabled(id, { enabled }, admin)
  for (const r of fetchSpy.mock.results) await (r.value as Promise<void>)
}

const runCount = async (id: string): Promise<number> => {
  const { rows } = await session.admin.query(
    `SELECT count(*)::int AS n FROM job_collection_runs WHERE source_id = $1`,
    [id],
  )
  return rows[0].n as number
}

const enableCycles = async (id: string) => {
  const { rows } = await session.admin.query(
    `SELECT status FROM job_collection_cycles WHERE trigger_key LIKE $1`,
    [`enable-fetch:${id}:%`],
  )
  return rows.map((r) => r.status as string)
}

const sourceRow = async (id: string) => {
  const { rows } = await session.admin.query(
    `SELECT next_attempt_at, next_attempt_at > clock_timestamp() AS slot_in_future,
            last_error_code FROM job_sources WHERE id = $1`,
    [id],
  )
  return rows[0] as {
    next_attempt_at: Date | null
    slot_in_future: boolean | null
    last_error_code: string | null
  }
}

const attemptedAgo = (id: string, interval: string) =>
  session.admin.query(
    `UPDATE job_sources SET last_attempt_at = clock_timestamp() - $2::interval WHERE id = $1`,
    [id, interval],
  )

describe.skipIf(!hasDatabaseUrl())('enable fetch on a real database, as crm_app', () => {
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
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'enable-fetch spec', 'ADMIN') RETURNING id`,
      [`enable-fetch-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
    admin = { id: kit.actor, role: 'ADMIN' } as unknown as SessionUser
    service = new JobSourceAdminService(
      { db: drizzle(session.pool, { schema }) } as unknown as DatabaseService,
      ledger,
      worker,
    )
    fetchSpy = vi.spyOn(service as unknown as { fetchIfStale: () => Promise<void> }, 'fetchIfStale')
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM job_collection_cycles WHERE requested_by = $1`, [
        kit.actor,
      ])
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      vi.restoreAllMocks()
      await session.close()
    }
  })

  it('runs on a scratch database, as crm_app', async () => {
    const identity = await session.identity()
    expect([identity.currentUser, identity.isSuperuser]).toEqual(['crm_app', false])
    const { rows } = await session.pool.query('SELECT current_database() AS db')
    expect(rows[0].db).not.toBe('crm_db')
  })

  it('an attempt 10 min ago on an hourly profile is fresh: no cycle, no run', async () => {
    const id = await kit.reporting(
      { enabled: false, triggerMode: 'SCHEDULED' },
      { fetchProfile: HOURLY },
    )
    await attemptedAgo(id, '10 minutes')
    await toggle(id, true)
    expect(await enableCycles(id)).toEqual([])
    expect(await runCount(id)).toBe(0)
  })

  it('an attempt 2 h ago on an hourly profile is stale: one run, its MANUAL cycle closed', async () => {
    const id = await kit.reporting(
      { enabled: false, triggerMode: 'SCHEDULED' },
      { fetchProfile: HOURLY },
    )
    await attemptedAgo(id, '2 hours')
    await toggle(id, true)
    expect(await runCount(id)).toBe(1)
    expect(await enableCycles(id)).toEqual(['CLOSED'])
  })

  it('a stale BOTH source is fetched the same way: one run', async () => {
    const id = await kit.reporting(
      { enabled: false, triggerMode: 'BOTH' },
      { fetchProfile: HOURLY },
    )
    await attemptedAgo(id, '2 hours')
    await toggle(id, true)
    expect(await runCount(id)).toBe(1)
    expect(await enableCycles(id)).toEqual(['CLOSED'])
  })

  it('a human "run now" on the same SCHEDULED source is still refused TRIGGER_MODE', async () => {
    const id = await kit.reporting(
      { enabled: true, triggerMode: 'SCHEDULED' },
      { fetchProfile: HOURLY },
    )
    expect(await kit.claimManual(id)).toEqual({ kind: 'REFUSED', reason: 'TRIGGER_MODE' })
    expect(await runCount(id)).toBe(0)
  })

  it('enable -> disable -> enable inside the window starts exactly ONE run; no tick double fetch', async () => {
    const id = await kit.reporting(
      { enabled: false, triggerMode: 'SCHEDULED', nextAttemptSql: 'NULL' },
      { fetchProfile: HOURLY },
    )
    await toggle(id, true)
    expect(await runCount(id)).toBe(1)
    // The tick while the immediate run is in flight: not picked, and no error code written.
    const { cycleId } = await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: fx.cycleKey() })
    const { claimed } = await ledger.claimDue({ cycleId, owner: 'w', limit: 5, onlyIds: [id] })
    expect(claimed).toEqual([])
    expect((await sourceRow(id)).last_error_code).toBeNull()

    await toggle(id, false)
    await toggle(id, true)
    expect(await runCount(id)).toBe(1)
    expect(await enableCycles(id)).toEqual(['CLOSED'])
    // The re-enable moved the armed slot past the last attempt's window, so the tick does not fetch.
    expect(await kit.tryClaim(id)).toBeUndefined()
    expect((await sourceRow(id)).slot_in_future).toBe(true)
  })

  it('a finished immediate run advances the armed slot: the next tick does not fetch again', async () => {
    const id = await kit.reporting(
      { enabled: false, triggerMode: 'SCHEDULED', nextAttemptSql: 'NULL' },
      { fetchProfile: HOURLY },
    )
    finishRuns = true
    try {
      await toggle(id, true)
    } finally {
      finishRuns = false
    }
    const { rows } = await session.admin.query(
      `SELECT outcome FROM job_collection_runs WHERE source_id = $1`,
      [id],
    )
    expect(rows.map((r) => r.outcome)).toEqual(['SUCCEEDED'])
    expect((await sourceRow(id)).slot_in_future).toBe(true)
    expect(await kit.tryClaim(id)).toBeUndefined()
  })

  it('a null-profile source is not armed by enable (no NOT_SCHEDULED on the next tick)', async () => {
    const id = await kit.reporting(
      { enabled: false, triggerMode: 'SCHEDULED', nextAttemptSql: 'NULL' },
      { fetchProfile: null },
    )
    await attemptedAgo(id, '1 hour') // fresh for the 24 h window: no immediate fetch here
    await toggle(id, true)
    const row = await sourceRow(id)
    expect(row.next_attempt_at).toBeNull()
    expect(await kit.tryClaim(id)).toBeUndefined()
    expect((await sourceRow(id)).last_error_code).toBeNull()
    expect(await runCount(id)).toBe(0)
  })

  it('a never-attempted null-profile source still gets the immediate fetch', async () => {
    const id = await kit.reporting(
      { enabled: false, triggerMode: 'SCHEDULED', nextAttemptSql: 'NULL' },
      { fetchProfile: null },
    )
    await toggle(id, true)
    expect(await enableCycles(id)).toEqual(['CLOSED'])
    expect(await runCount(id)).toBe(1)
  })
})
