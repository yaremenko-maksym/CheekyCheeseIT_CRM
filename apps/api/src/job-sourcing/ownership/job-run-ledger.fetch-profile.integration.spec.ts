import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
// The driver's own query method, captured before any spy wraps it.

const originalQuery = Client.prototype.query

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

/** The source's `next_attempt_at` and `updated_at`, as ISO strings (a rewrite moves `updated_at`). */
async function nextAndUpdated(sourceId: string) {
  const { rows } = await session.admin.query(
    `SELECT next_attempt_at, updated_at FROM job_sources WHERE id = $1`,
    [sourceId],
  )
  const r = rows[0] as { next_attempt_at: Date | null; updated_at: Date }
  return { next: r.next_attempt_at?.toISOString() ?? null, updated: r.updated_at.toISOString() }
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

    it('SPEC-L-4: finish reads the clock once, and that one value is both ended_at and the slot`s now', async () => {
      const s = await kit.reporting({}, { fetchProfile: BERLIN_60 })
      const run = await kit.claimOne(s)
      // Every statement `finish` sends, as the driver receives it.
      const sent: { text: string; values: unknown[] }[] = []
      const query = vi.spyOn(Client.prototype, 'query')
      query.mockImplementation(function (this: Client, ...args: unknown[]) {
        const [first, second] = args as [unknown, unknown]
        const text = typeof first === 'string' ? first : (first as { text: string }).text
        // `query(text, values)` or `query({ text, values })`; drizzle sends `({ text, ... }, values)`.
        const values =
          (typeof first === 'string' ? undefined : (first as { values?: unknown[] }).values) ??
          (second as unknown[] | undefined) ??
          []
        sent.push({ text, values })
        return Reflect.apply(originalQuery, this, args) as never
      })
      try {
        await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
      } finally {
        query.mockRestore()
      }
      const e = await ending(run.runId)
      const reads = sent.filter((q) => /clock_timestamp\(\)\s+AS\s+db_now/i.test(q.text))
      expect(reads).toHaveLength(1)
      const endRun = sent.find((q) => /UPDATE job_collection_runs\s+SET outcome/.test(q.text))!
      // ended_at is the value read, not a second clock_timestamp() ...
      expect(endRun.text).not.toMatch(/ended_at = clock_timestamp\(\)/)
      expect(endRun.values).toContain(e.ended_at.toISOString())
      // ... and the next attempt is nextSlot of exactly that value, written as a parameter.
      const expected = nextSlot(e.ended_at, BERLIN_60, {
        floorMinutes: 0,
        slowdownLevel: 0,
        staggerKey: e.manifest_id,
      }).toISOString()
      const account = sent.find((q) =>
        /UPDATE job_sources SET consecutive_failures = 0/.test(q.text),
      )!
      expect(account.values).toContain(expected)
      expect(e.next_attempt_at?.toISOString()).toBe(expected)
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
        // CR-M-2: one write, NULL, never a recheck.
        const first = await nextAndUpdated(s)
        expect(first.next).toBeNull()
        expect((await fx.sourceRow(s)).last_error_code).toBe('NOT_SCHEDULED')
        expect(await findDueSources(db, 'SCHEDULED', { onlyIds: [s] })).toEqual([])
        expect(await ledger.countDue({ onlyIds: [s] })).toBe(0)
        // A second scheduled claim neither selects nor rewrites it: bounded at one write.
        const again = await ledger.claimDue({
          cycleId: await kit.scheduledCycle(),
          owner: 'spec-worker',
          limit: 1,
          onlyIds: [s],
        })
        expect(again).toEqual({ claimed: [], refused: [] })
        expect(await nextAndUpdated(s)).toEqual(first)
      })

      it('CR-M-2: given a profile later, it gets its first slot from the manual run that connects it', async () => {
        const manifestId = fx.manifestId()
        const s = await kit.reporting({ manifestId }, { fetchProfile: null })
        await ledger.claimDue({
          cycleId: await kit.scheduledCycle(),
          owner: 'spec-worker',
          limit: 1,
          onlyIds: [s],
        })
        expect((await nextAndUpdated(s)).next).toBeNull()
        // The profile appears (U12 connects the type): a NULL next attempt is still not due ...
        kit.catalog.add(manifestId, { fetchProfile: BERLIN_60 })
        expect(await kit.tryClaim(s)).toBeUndefined()
        // ... until the supervised manual run's finish computes its first slot.
        const manual = await kit.claimManual(s)
        if (manual.kind !== 'CLAIMED') throw new Error(`setup: manual claim ${manual.reason}`)
        await ledger.finish(handleOf(manual.run), { outcome: 'SUCCEEDED', errorCode: null })
        const e = await ending(manual.run.runId)
        const expected = nextSlot(e.ended_at, BERLIN_60, {
          floorMinutes: 0,
          slowdownLevel: 0,
          staggerKey: manifestId,
        })
        expect(e.next_attempt_at?.toISOString()).toBe(expected.toISOString())
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
