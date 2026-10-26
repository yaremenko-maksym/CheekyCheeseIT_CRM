import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specRegistry,
} from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { findDueSources } from '../scheduling/due-sources.query'
import { type FetchProfile, nextSlot } from '../scheduling/next-slot'
import { JobRunLedger } from './job-run-ledger'

/**
 * Source fetch strategy U1b (ADR docs/architecture/2026-10-25-source-fetch-strategy.md, unit U1b) —
 * the ledger writes `next_attempt_at = nextSlot(ended_at, profile, policy)` and never reads
 * `min_interval_hours`, against a REAL Postgres, AS `crm_app`. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.fetch-profile.integration
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let db: ReturnType<typeof drizzle<typeof schema>>

const BERLIN_60: FetchProfile = {
  intervalMinutes: 60,
  offIntervalMinutes: 180,
  window: {
    timeZone: 'Europe/Berlin',
    days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    from: '08:00',
    to: '19:00',
  },
}

/** The run's `ended_at`, its source's `next_attempt_at` and `manifest_id`. */
async function ending(runId: string) {
  const { rows } = await session.admin.query(
    `SELECT r.ended_at, s.next_attempt_at, s.manifest_id
       FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id WHERE r.id = $1`,
    [runId],
  )
  return rows[0] as { ended_at: Date; next_attempt_at: Date | null; manifest_id: string }
}

async function finishOnce(sourceId: string): Promise<string> {
  const run = await kit.claimOne(sourceId)
  await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
  return run.runId
}

describe.skipIf(!hasDatabaseUrl())(
  'U1b: the ledger schedules by the fetch profile, as crm_app',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      fx = new LedgerFixtures(session.admin, TAG)
      const catalog = new SpecCatalog()
      db = drizzle(session.pool, { schema })
      ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API']), catalog)
      const { rows } = await session.admin.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'U1b spec', 'ADMIN') RETURNING id`,
        [`u1b-${TAG}@example.test`],
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

    it('AC 1: a finished run of a 60-minute Berlin source is next due at nextSlot(ended_at) exactly', async () => {
      const s = await kit.reporting({}, { fetchProfile: BERLIN_60 })
      const e = await ending(await finishOnce(s))
      const expected = nextSlot(e.ended_at, BERLIN_60, {
        floorMinutes: 0,
        slowdownLevel: 0,
        staggerKey: e.manifest_id,
      })
      expect(e.next_attempt_at?.toISOString()).toBe(expected.toISOString())
      // A slot of a 60 / 180 profile is never more than 3 h ahead, and always ahead.
      const ahead = e.next_attempt_at!.getTime() - e.ended_at.getTime()
      expect(ahead).toBeGreaterThan(0)
      expect(ahead).toBeLessThanOrEqual(3 * 3_600_000)
    })

    it.each([1, 1000, null])(
      'AC 2: min_interval_hours = %s changes nothing (the column is not read)',
      async (stored) => {
        const s = await kit.reporting({ minIntervalHours: stored }, { fetchProfile: BERLIN_60 })
        const e = await ending(await finishOnce(s))
        const expected = nextSlot(e.ended_at, BERLIN_60, {
          floorMinutes: 0,
          slowdownLevel: 0,
          staggerKey: e.manifest_id,
        })
        expect(e.next_attempt_at?.toISOString()).toBe(expected.toISOString())
      },
    )

    it('the clock is read once: ended_at is the instant the slot was computed from', async () => {
      // A minute-aligned grid: the slot is the next whole minute after ended_at.
      const everyMinute: FetchProfile = {
        intervalMinutes: 1,
        offIntervalMinutes: null,
        window: null,
      }
      const s = await kit.reporting({}, { fetchProfile: everyMinute })
      const e = await ending(await finishOnce(s))
      const ended = e.ended_at.getTime()
      expect(e.next_attempt_at!.getTime()).toBe(Math.floor(ended / 60_000) * 60_000 + 60_000)
    })

    it('composition: the provider floor pushes the slot past ended_at + floor (strictest wins)', async () => {
      const s = await kit.reporting({}, { fetchProfile: BERLIN_60, floorHours: 6 })
      const e = await ending(await finishOnce(s))
      const expected = nextSlot(e.ended_at, BERLIN_60, {
        floorMinutes: 360,
        slowdownLevel: 0,
        staggerKey: e.manifest_id,
      })
      expect(e.next_attempt_at?.toISOString()).toBe(expected.toISOString())
      expect(e.next_attempt_at!.getTime() - e.ended_at.getTime()).toBeGreaterThan(6 * 3_600_000)
    })

    describe('AC 5: a source with a null profile is never due by schedule', () => {
      it('a scheduled claim refuses it NOT_SCHEDULED and moves it out of the due set', async () => {
        const s = await kit.reporting({}, { fetchProfile: null })
        // Seeded due an hour ago: the scalar pre-filter still selects it ...
        expect((await findDueSources(db, 'SCHEDULED', { onlyIds: [s] })).map((r) => r.id)).toEqual([
          s,
        ])
        const { claimed, refused } = await ledger.claimDue({
          cycleId: await kit.scheduledCycle(),
          owner: 'spec-worker',
          limit: 1,
          onlyIds: [s],
        })
        // ... but the claim never runs it.
        expect(claimed).toEqual([])
        expect(refused).toEqual([{ sourceId: s, reason: 'NOT_SCHEDULED' }])
        const row = await fx.sourceRow(s)
        expect(row.last_error_code).toBe('NOT_SCHEDULED')
        expect(row.next_in_s).toBeGreaterThan(60)
        expect(await findDueSources(db, 'SCHEDULED', { onlyIds: [s] })).toEqual([])
        expect(await ledger.countDue({ onlyIds: [s] })).toBe(0)
      })

      it('a manual run of it ends with no next attempt: NULL, which no scheduled claim selects', async () => {
        const s = await kit.reporting({}, { fetchProfile: null })
        const manual = await kit.claimManual(s)
        if (manual.kind !== 'CLAIMED') throw new Error(`setup: manual claim ${manual.reason}`)
        await ledger.finish(handleOf(manual.run), { outcome: 'SUCCEEDED', errorCode: null })
        expect((await ending(manual.run.runId)).next_attempt_at).toBeNull()
        expect(await findDueSources(db, 'SCHEDULED', { onlyIds: [s] })).toEqual([])
        expect(await kit.tryClaim(s)).toBeUndefined()
      })

      it('a failure of it still backs off, and leaves no next attempt', async () => {
        const s = await kit.reporting({}, { fetchProfile: null })
        const manual = await kit.claimManual(s)
        if (manual.kind !== 'CLAIMED') throw new Error(`setup: manual claim ${manual.reason}`)
        await ledger.finish(handleOf(manual.run), { outcome: 'FAILED', errorCode: 'UPSTREAM' })
        const row = await fx.sourceRow(s)
        expect(row.consecutive_failures).toBe(1)
        expect(row.cooldown_in_s).toBeGreaterThan(0)
        expect((await ending(manual.run.runId)).next_attempt_at).toBeNull()
      })
    })
  },
)
