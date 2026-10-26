import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { ageHostPause } from '../../test/host-pause-aging'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import { cleanupStore, observation } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import { decideCheckpoint } from '../providers/reporting-provider'
import { recordHostBan } from '../scheduling/host-state'
import { saveObservationPage } from '../store/source-record.store'
import { type ClaimedRun, JobRunLedger } from './job-run-ledger'

/**
 * r5 Task 2.5 T3 — failure accounting, host behaviour, crash resume and the infinite-loop
 * regression, against a REAL Postgres AS `crm_app`, with a local fixture HTTP server whose request
 * counts are the assertion for AC 10 and AC 12. Time is moved only by `ageRun` / `ageSource` /
 * `ageHostPause`.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.accounting.integration
 */
const TAG = randomUUID().slice(0, 8)
const NS = `t3spec-${TAG}-acct`
/** Valid observations of `ids` in NS (the record store validates what it writes). */
const observed = (ids: readonly string[], provider: JobSourceType = 'REMOTIVE_API') =>
  ids.map((nativeId) => observation({ namespace: NS, nativeId, provider, tag: TAG }))
const HOUR = 3_600_000

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let db: ReturnType<typeof drizzle<typeof schema>>

// ---------------------------------------------------------------------------
// The fixture server: GET /<source>/p/<n> answers 200 and counts the request.
// ---------------------------------------------------------------------------

let server: Server
let base: string
const hits = new Map<string, number>()

const hitsOf = (sourceId: string) =>
  [...hits.entries()]
    .filter(([k]) => k.startsWith(`${sourceId}/`))
    .map(([k, n]) => [Number(k.split('/p/')[1]), n] as const)
    .sort((a, b) => a[0] - b[0])

const totalHits = (sourceId: string) => hitsOf(sourceId).reduce((n, [, c]) => n + c, 0)

/**
 * A minimal collection loop over the ledger, standing in for T7's worker: it resumes from the
 * checkpoint the claim chose, fetches one page per request, and persists each page before going
 * on. `stopAfter` crashes (no finish) after that page; `failAt` ends FAILED with `failCode` when
 * that page is reached, before fetching it.
 */
async function collect(
  run: ClaimedRun,
  opts: {
    pages: number
    stopAfter?: number
    failAt?: number
    failCode?: 'PARSE_DRIFT' | 'TRANSIENT_NETWORK' | 'CURSOR_CYCLE'
    endAfterOne?: 'CURSOR_CYCLE'
  },
): Promise<'CRASHED' | 'ENDED'> {
  const decision = decideCheckpoint(run.checkpoint, {
    configVersion: 1,
    policyVersion: 1,
    adapterVersion: 'remotive_api-1',
  })
  let page = decision.kind === 'RESUME' ? decision.from.position.page + 1 : 1
  for (; page <= opts.pages; page += 1) {
    if (opts.failAt === page) {
      await ledger.finish(handleOf(run), {
        outcome: 'FAILED',
        errorCode: opts.failCode ?? 'PARSE_DRIFT',
      })
      return 'ENDED'
    }
    const res = await fetch(`${base}/${run.sourceId}/p/${page}`)
    expect(res.status).toBe(200)
    await saveObservationPage(db, handleOf(run), {
      observations: observed([`${run.sourceId}-${page}`]),
      checkpoint: specCheckpoint(page),
    })
    if (opts.stopAfter === page) return 'CRASHED'
    if (opts.endAfterOne !== undefined) {
      await ledger.finish(handleOf(run), { outcome: 'FAILED', errorCode: opts.endAfterOne })
      return 'ENDED'
    }
  }
  await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
  return 'ENDED'
}

/** Expire a crashed run's lease and recover it, then let the source's cadence and backoff pass. */
async function crashRecover(run: ClaimedRun): Promise<void> {
  await ageRun(session.admin, run.runId, 10 * 60_000)
  expect(await ledger.recoverExpired()).toBeGreaterThanOrEqual(1)
  await ageSource(session.admin, run.sourceId, 48 * HOUR)
}

describe.skipIf(!hasDatabaseUrl())(
  'run ledger accounting against Postgres, as crm_app (T3)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      fx = new LedgerFixtures(session.admin, TAG)
      const catalog = new SpecCatalog()
      db = drizzle(session.pool, { schema })
      ledger = new JobRunLedger(db, specRegistry(['REMOTIVE_API', 'JSEARCH_API']), catalog)
      const { rows } = await session.admin.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'T3 spec', 'ADMIN') RETURNING id`,
        [`t3acct-${TAG}@example.test`],
      )
      kit = new LedgerKit(ledger, fx, catalog, rows[0].id as string)
      server = createServer((req, res) => {
        const key = (req.url ?? '').slice(1)
        hits.set(key, (hits.get(key) ?? 0) + 1)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }, 120_000)

    afterAll(async () => {
      await new Promise((done) => server?.close(done))
      if (session === undefined) return
      try {
        await cleanupStore(session.admin, NS, TAG)
        await fx.cleanup()
        await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
      } finally {
        await session.close()
      }
    })

    describe('AC 10 / AC 11: crash resume', () => {
      it('a run that crashes after page k is followed by one starting at k + 1; pages 1..k are fetched once', async () => {
        const s = await kit.reporting()
        const first = await kit.claimOne(s)
        expect(first.checkpoint).toBeNull()
        expect(await collect(first, { pages: 5, stopAfter: 3 })).toBe('CRASHED')
        await crashRecover(first)
        const second = await kit.claimOne(s)
        expect(await collect(second, { pages: 5 })).toBe('ENDED')
        expect(hitsOf(s)).toEqual([
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
          [5, 1],
        ])
        expect((await fx.runs(s)).map((r) => r.outcome)).toEqual(['FAILED', 'SUCCEEDED'])
      })

      it('a successor that fails before its first page keeps the inherited checkpoint (SR-M-15)', async () => {
        const s = await kit.reporting()
        const first = await kit.claimOne(s)
        await collect(first, { pages: 5, stopAfter: 2 })
        await crashRecover(first)
        const second = await kit.claimOne(s)
        await collect(second, { pages: 5, failAt: 3, failCode: 'TRANSIENT_NETWORK' })
        const runs = await fx.runs(s)
        expect((runs[1]!.checkpoint['position'] as { page: number }).page).toBe(2)
        await ageSource(session.admin, s, 48 * HOUR)
        const third = await kit.claimOne(s)
        await collect(third, { pages: 5 })
        expect(hitsOf(s)).toEqual([
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
          [5, 1],
        ])
      })
    })

    describe('AC 12 (SR-H-4): the infinite-loop regression', () => {
      it('a provider ending every run CURSOR_CYCLE after one page is capped after 3 runs', async () => {
        const s = await kit.reporting()
        for (let i = 0; i < 3; i += 1) {
          const run = await kit.claimOne(s)
          await collect(run, { pages: 5, endAfterOne: 'CURSOR_CYCLE' })
          // Never re-claimed before its cadence.
          expect(await kit.tryClaim(s)).toBeUndefined()
          await ageSource(session.admin, s, 48 * HOUR)
        }
        expect((await fx.sourceRow(s)).consecutive_failures).toBe(3)
        expect(await kit.tryClaim(s)).toBeUndefined()
        // CURSOR_CYCLE restarts fresh every time: page 1, three times, and nothing else.
        expect(hitsOf(s)).toEqual([[1, 3]])
      })

      it('a provider whose page 2 is PARSE_DRIFT is capped after 3 runs, within 3 runs of requests', async () => {
        const s = await kit.reporting()
        for (let i = 0; i < 3; i += 1) {
          const run = await kit.claimOne(s)
          await collect(run, { pages: 5, failAt: 2, failCode: 'PARSE_DRIFT' })
          await ageSource(session.admin, s, 48 * HOUR)
        }
        expect((await fx.sourceRow(s)).consecutive_failures).toBe(3)
        expect(await kit.tryClaim(s)).toBeUndefined()
        expect(totalHits(s)).toBeLessThanOrEqual(3)
      })
    })

    describe('AC 15: failure accounting, row by row', () => {
      it('a source whose own requests get 403 (ACCESS_POLICY) reaches the cap after 3 runs', async () => {
        const s = await kit.reporting()
        for (let i = 0; i < 3; i += 1) {
          const run = await kit.claimOne(s)
          await ledger.finish(handleOf(run), { outcome: 'FAILED', errorCode: 'ACCESS_POLICY' })
          await ageSource(session.admin, s, 48 * HOUR)
        }
        const row = await fx.sourceRow(s)
        expect([row.consecutive_failures, row.last_error_code]).toEqual([3, 'ACCESS_POLICY'])
        expect(await kit.tryClaim(s)).toBeUndefined()
        expect(await kit.claimManual(s)).toEqual({ kind: 'REFUSED', reason: 'FAILURE_CAP' })
      })

      it('a failure backs off, and claimSource is refused inside the cooldown', async () => {
        const s = await kit.reporting()
        const run = await kit.claimOne(s)
        await ledger.finish(handleOf(run), { outcome: 'FAILED', errorCode: 'UPSTREAM' })
        const row = await fx.sourceRow(s)
        expect(row.consecutive_failures).toBe(1)
        // The first backoff is the base, one hour; the cadence is the entry's 24 h.
        expect(row.cooldown_in_s).toBeGreaterThan(3600 - 60)
        expect(row.cooldown_in_s).toBeLessThanOrEqual(3600)
        expect(row.next_in_s).toBeGreaterThan(24 * 3600 - 60)
        expect(await kit.claimManual(s)).toEqual({ kind: 'REFUSED', reason: 'COOLING_DOWN' })
      })

      it.each([
        ['PARTIAL', 'PAGE_CAP'],
        ['PARTIAL', 'DEADLINE'],
        ['PARTIAL', 'COST_STOP'],
        ['CANCELLED', 'CANCELLED'],
      ] as const)(
        '%s / %s with a page persisted leaves the counter unchanged',
        async (outcome, code) => {
          const s = await kit.reporting({ consecutiveFailures: 1 })
          const run = await kit.claimOne(s)
          await saveObservationPage(db, handleOf(run), {
            observations: observed([`${s}-x`]),
            checkpoint: specCheckpoint(1),
          })
          await ledger.finish(handleOf(run), { outcome, errorCode: code })
          const row = await fx.sourceRow(s)
          expect(row.consecutive_failures).toBe(1)
          expect(row.next_in_s).toBeGreaterThan(24 * 3600 - 60)
        },
      )

      it.each(['DEADLINE', 'PAGE_CAP'] as const)(
        'SR-M-22: PARTIAL / %s with ZERO pages persisted counts, and caps in 3 runs',
        async (code) => {
          const s = await kit.reporting()
          for (let i = 0; i < 3; i += 1) {
            const run = await kit.claimOne(s)
            // SR-M-1: a heartbeat, and any other bookkeeping write that moves the run's
            // `updated_at`, is not a page. Only what `savePage` writes may say "a page was saved".
            expect(await ledger.heartbeat(handleOf(run))).toBe(true)
            await session.admin.query(
              `UPDATE job_collection_runs SET updated_at = clock_timestamp() + interval '1 second' WHERE id = $1`,
              [run.runId],
            )
            await ledger.finish(handleOf(run), { outcome: 'PARTIAL', errorCode: code })
            await ageSource(session.admin, s, 48 * HOUR)
          }
          expect((await fx.sourceRow(s)).consecutive_failures).toBe(3)
          expect(await kit.tryClaim(s)).toBeUndefined()
        },
      )

      it('SR-M-1: an inherited checkpoint is not a page; a successor that saves none counts', async () => {
        const s = await kit.reporting()
        const first = await kit.claimOne(s)
        await saveObservationPage(db, handleOf(first), {
          observations: observed([`${s}-1`]),
          checkpoint: specCheckpoint(1),
        })
        await ledger.finish(handleOf(first), { outcome: 'PARTIAL', errorCode: 'DEADLINE' })
        expect((await fx.sourceRow(s)).consecutive_failures).toBe(0)
        await ageSource(session.admin, s, 48 * HOUR)
        const second = await kit.claimOne(s)
        expect(second.checkpoint).not.toBeNull()
        await ledger.finish(handleOf(second), { outcome: 'PARTIAL', errorCode: 'DEADLINE' })
        expect((await fx.sourceRow(s)).consecutive_failures).toBe(1)
      })

      it('SR-M-1: a page with no observations that moves the checkpoint is a page', async () => {
        const s = await kit.reporting({ consecutiveFailures: 1 })
        const run = await kit.claimOne(s)
        await saveObservationPage(db, handleOf(run), {
          observations: [],
          checkpoint: specCheckpoint(1),
        })
        await ledger.finish(handleOf(run), { outcome: 'PARTIAL', errorCode: 'PAGE_CAP' })
        expect((await fx.sourceRow(s)).consecutive_failures).toBe(1)
      })

      it('SR-L-18: three LEASE_EXPIRED endings cap a source, with the reason recorded', async () => {
        const s = await kit.reporting()
        for (let i = 0; i < 3; i += 1) {
          await crashRecover(await kit.claimOne(s))
        }
        const row = await fx.sourceRow(s)
        expect([row.consecutive_failures, row.last_error_code]).toEqual([3, 'LEASE_EXPIRED'])
      })

      it('COST_STOP waits for the meter reset when it is later than the cadence', async () => {
        const meterId = await fx.meter(fx.accountKey('cost'), 100)
        const s = await kit.reporting(
          { type: 'JSEARCH_API', accountMeterId: meterId, minIntervalHours: 1 },
          { quotaDeclared: true },
        )
        const run = await kit.claimOne(s)
        await ledger.finish(handleOf(run), { outcome: 'PARTIAL', errorCode: 'COST_STOP' })
        // The meter resets in ~23 h; the cadence is 1 h.
        expect((await fx.sourceRow(s)).next_in_s).toBeGreaterThan(22 * 3600)
      })

      it('SUCCEEDED resets the counter and clears the cooldown', async () => {
        const s = await kit.reporting({ consecutiveFailures: 2 })
        await session.admin.query(
          `UPDATE job_sources SET cooldown_until = clock_timestamp() - interval '1 minute' WHERE id = $1`,
          [s],
        )
        const run = await kit.claimOne(s)
        await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
        const row = await fx.sourceRow(s)
        expect([row.consecutive_failures, row.cooldown_in_s, row.succeeded_once]).toEqual([
          0,
          null,
          true,
        ])
      })

      it('a fenced executor cannot finish', async () => {
        const s = await kit.reporting()
        const run = await kit.claimOne(s)
        const err = await ledger
          .finish(
            { ...handleOf(run), fencingEpoch: run.fencingEpoch + 1 },
            {
              outcome: 'SUCCEEDED',
              errorCode: null,
            },
          )
          .catch((e: { code?: string }) => e)
        expect((err as { code?: string }).code).toBe('RUN_FENCED')
        expect((await fx.runs(s)).map((r) => r.outcome)).toEqual(['STARTED'])
      })
    })

    describe('SR-L-23: the account-level bound', () => {
      it('two sources on one paid account spend at most 3 x page x 2 before both are capped', async () => {
        const PAGE = 2
        const acct = fx.accountKey('bound')
        const meterId = await fx.meter(acct, null)
        const sources = [
          await kit.reporting(
            { type: 'JSEARCH_API', accountMeterId: meterId },
            { quotaDeclared: true },
          ),
          await kit.reporting(
            { type: 'JSEARCH_API', accountMeterId: meterId },
            { quotaDeclared: true },
          ),
        ]
        for (let round = 0; round < 6; round += 1) {
          for (const s of sources) {
            const run = await kit.tryClaim(s)
            if (run === undefined) continue
            const meter = ledger.meterFor(run, { REQUEST: 'DAY' })
            const r = (await meter.reserve('REQUEST', PAGE))!
            await meter.markSent(r)
            await meter.reconcile(r, 'USED')
            await ledger.finish(handleOf(run), { outcome: 'FAILED', errorCode: 'UPSTREAM' })
          }
          for (const s of sources) await ageSource(session.admin, s, 48 * HOUR)
        }
        expect(await fx.counters(meterId)).toEqual({
          used: 3 * PAGE * 2,
          reserved: 0,
          uncertain: 0,
        })
        for (const s of sources) expect((await fx.sourceRow(s)).consecutive_failures).toBe(3)
      })
    })

    describe('AC 16: host behaviour, end to end', () => {
      it('a ban written by the transport makes the sibling refused by claimDue and claimSource', async () => {
        const host = fx.host('banned')
        const a = await kit.reporting({ hostKey: host })
        const b = await kit.reporting({ hostKey: host })
        const run = await kit.claimOne(a)
        // T7's transport wrapper writes the ban at the refusal (403), then the run ends.
        await recordHostBan(drizzle(session.pool, { schema }), {
          hostKey: host,
          reason: 'HTTP_403',
          sourceId: a,
          floorHours: 0,
        })
        await ledger.finish(handleOf(run), { outcome: 'FAILED', errorCode: 'ACCESS_POLICY' })
        expect(await kit.tryClaim(b)).toBeUndefined()
        expect(await kit.claimManual(b)).toEqual({ kind: 'REFUSED', reason: 'HOST_PAUSED' })
        await ageHostPause(session.admin, host, 25 * HOUR)
        expect((await kit.claimOne(b)).sourceId).toBe(b)
      })

      it('a second source on a busy host is refused HOST_BUSY, and claimed after the run ends', async () => {
        const host = fx.host('busy2')
        const a = await kit.reporting({ hostKey: host })
        const b = await kit.reporting({ hostKey: host })
        const run = await kit.claimOne(a)
        expect(await kit.claimManual(b)).toEqual({ kind: 'REFUSED', reason: 'HOST_BUSY' })
        expect(await kit.tryClaim(b)).toBeUndefined()
        await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
        expect((await kit.claimOne(b)).sourceId).toBe(b)
      })

      it('a recovered run followed by a new claim counts twice in the host`s 24 h count', async () => {
        const host = fx.host('daily')
        const s = await kit.reporting(
          { hostKey: host },
          {},
          {
            rate: { perMinute: 60, perDay: 2 },
            floorHours: 0,
          },
        )
        await crashRecover(await kit.claimOne(s))
        await ageHostPause(session.admin, host, 2 * 60_000, 'last_claimed_at')
        await crashRecover(await kit.claimOne(s))
        await ageHostPause(session.admin, host, 2 * 60_000, 'last_claimed_at')
        await session.admin.query(
          `UPDATE job_sources SET consecutive_failures = 0, cooldown_until = NULL WHERE id = $1`,
          [s],
        )
        const { rows } = await session.admin.query(
          `SELECT count(*)::int AS n FROM job_collection_runs r JOIN job_sources s ON s.id = r.source_id
          WHERE s.host_key = $1 AND r.started_at > clock_timestamp() - interval '24 hours'`,
          [host],
        )
        expect(rows[0].n).toBe(2)
        const third = await ledger.claimDue({
          cycleId: await kit.scheduledCycle(),
          owner: 'spec-worker',
          limit: 1,
          onlyIds: [s],
        })
        expect(third).toEqual({ claimed: [], refused: [{ sourceId: s, reason: 'HOST_DAILY_CAP' }] })
      })
    })
  },
)
