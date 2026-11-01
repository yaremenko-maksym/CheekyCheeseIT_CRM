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
  type SourceSeed,
  handleOf,
  specRegistry,
} from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun } from '../../test/run-aging'
import { type ClaimedRun, JobRunLedger, type RunEnding } from './job-run-ledger'
import { JobSourceRunBusyError, LEGACY_RUN_ADAPTER_VERSION } from './legacy-run-claim'
import { RunFencedError } from './run-ownership'

/**
 * r5 Task 4.6 S6c — `claimLegacyRun` and the run-row-only LEGACY ending against a REAL Postgres, AS
 * `crm_app` (fixtures and aging go through the migration role).
 *
 * NEVER run against `crm_db` (`openCrmAppSession` refuses one):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run legacy-run-claim.integration
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let ledger: JobRunLedger
let actor: string

/** DOU as production seeds it: LEGACY, no manifest id, no host key. */
const dou = (seed: SourceSeed = {}) =>
  fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null, ...seed })

/** EVERY column of the source row, as the database renders it. */
async function sourceSnapshot(id: string): Promise<Record<string, unknown>> {
  const { rows } = await session.admin.query(
    `SELECT to_jsonb(s) AS row FROM job_sources s WHERE id = $1`,
    [id],
  )
  return rows[0].row as Record<string, unknown>
}

async function runRow(runId: string) {
  const { rows } = await session.admin.query(
    `SELECT outcome, error_code, error_message, adapter_version, account_key, trigger,
            fencing_epoch::int AS epoch, request_count, bytes_read::int AS bytes_read,
            ended_at IS NOT NULL AS ended
       FROM job_collection_runs WHERE id = $1`,
    [runId],
  )
  return rows[0] as Record<string, unknown>
}

async function runCount(sourceId: string): Promise<number> {
  const { rows } = await session.admin.query(
    `SELECT count(*)::int AS n FROM job_collection_runs WHERE source_id = $1`,
    [sourceId],
  )
  return rows[0].n as number
}

async function claimManual(sourceId: string) {
  return ledger.claimLegacyRun({
    cycleId: await kit.manualCycle(),
    owner: 'dou-bridge',
    sourceId,
    actor,
  })
}

async function claimed(sourceId: string): Promise<ClaimedRun> {
  const c = await claimManual(sourceId)
  if (c.kind !== 'CLAIMED') throw new Error(`setup: ${sourceId} was refused ${c.reason}`)
  return c.run
}

const METRICS = {
  requestCount: 1,
  bytesRead: 2048,
  lastHttpStatus: 200,
  envelopeFingerprint: null,
  validatorsSeen: false,
  nextValidators: null,
} as const

describe.skipIf(!hasDatabaseUrl())('the LEGACY claim against Postgres, as crm_app (S6c)', () => {
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
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'S6c spec', 'ADMIN') RETURNING id`,
      [`s6cspec-${TAG}@example.test`],
    )
    actor = rows[0].id as string
    kit = new LedgerKit(ledger, fx, catalog, actor)
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [actor])
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

  describe('AC 1: the claim paths stay disjoint by kind', () => {
    it('a LEGACY source is claimed: a STARTED run with the DOU version and the #source key', async () => {
      const s = await dou()
      const run = await claimed(s)
      expect(run).toMatchObject({ sourceId: s, sourceType: 'DOU_RSS', accountKey: `#source:${s}` })
      expect(run.fencingEpoch).toBe(1)
      expect(await runRow(run.runId)).toMatchObject({
        outcome: 'STARTED',
        adapter_version: LEGACY_RUN_ADAPTER_VERSION,
        account_key: `#source:${s}`,
        trigger: 'MANUAL',
        epoch: 1,
        ended: false,
      })
      await ledger.finish(handleOf(run), { outcome: 'SUCCEEDED', errorCode: null })
    })

    it('a scheduled cycle claims a LEGACY source too, with no actor', async () => {
      const s = await dou()
      const c = await ledger.claimLegacyRun({
        cycleId: await kit.scheduledCycle(),
        owner: 'dou-bridge',
        sourceId: s,
      })
      if (c.kind !== 'CLAIMED') throw new Error(`refused ${c.reason}`)
      expect((await runRow(c.run.runId))['trigger']).toBe('SCHEDULED')
      await ledger.finish(handleOf(c.run), { outcome: 'SUCCEEDED', errorCode: null })
    })

    it('a REPORTING source is refused by claimLegacyRun and gets no run', async () => {
      const s = await kit.reporting()
      const before = await sourceSnapshot(s)
      expect(await claimManual(s)).toEqual({ kind: 'REFUSED', reason: 'NOT_ACTIVATABLE' })
      expect(await runCount(s)).toBe(0)
      expect(await sourceSnapshot(s)).toEqual(before)
    })

    it('a LEGACY source is still refused by claimSource and never claimed by claimDue', async () => {
      const s = await dou()
      expect(await kit.claimManual(s)).toEqual({ kind: 'REFUSED', reason: 'NOT_ACTIVATABLE' })
      expect(await kit.tryClaim(s)).toBeUndefined()
      expect(await runCount(s)).toBe(0)
    })

    it('a disabled source, or one whose trigger mode does not take the cycle`s, is refused and untouched', async () => {
      const off = await dou({ enabled: false })
      const scheduledOnly = await dou({ triggerMode: 'SCHEDULED' })
      const before = [await sourceSnapshot(off), await sourceSnapshot(scheduledOnly)]
      expect(await claimManual(off)).toEqual({ kind: 'REFUSED', reason: 'DISABLED' })
      expect(await claimManual(scheduledOnly)).toEqual({ kind: 'REFUSED', reason: 'TRIGGER_MODE' })
      expect([await sourceSnapshot(off), await sourceSnapshot(scheduledOnly)]).toEqual(before)
      expect((await runCount(off)) + (await runCount(scheduledOnly))).toBe(0)
    })
  })

  describe('AC 2: single flight', () => {
    it('a second claim while one runs is the typed busy stop, and it writes nothing', async () => {
      const s = await dou()
      const first = await claimed(s)
      const before = await sourceSnapshot(s)
      const error = await claimManual(s).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(JobSourceRunBusyError)
      expect((error as JobSourceRunBusyError).budgetExhausted).toBe(false)
      expect(await runCount(s)).toBe(1)
      expect(await sourceSnapshot(s)).toEqual(before)
      await ledger.finish(handleOf(first), { outcome: 'SUCCEEDED', errorCode: null })
    })

    it('two concurrent claims: exactly one run, the other busy', async () => {
      const s = await dou()
      const [a, b] = await Promise.allSettled([claimManual(s), claimManual(s)])
      const won = [a, b].filter((r) => r.status === 'fulfilled' && r.value.kind === 'CLAIMED')
      const busy = [a, b].filter(
        (r) => r.status === 'rejected' && r.reason instanceof JobSourceRunBusyError,
      )
      expect([won.length, busy.length]).toEqual([1, 1])
      expect(await runCount(s)).toBe(1)
      const w = won[0] as PromiseFulfilledResult<{ kind: 'CLAIMED'; run: ClaimedRun }>
      await ledger.finish(handleOf(w.value.run), { outcome: 'SUCCEEDED', errorCode: null })
    })
  })

  describe('AC 3 / AC 5: the run-row-only ending', () => {
    const endings: [string, RunEnding][] = [
      [
        'FAILED / UPSTREAM',
        { outcome: 'FAILED', errorCode: 'UPSTREAM', errorMessage: 'feed down' },
      ],
      ['FAILED / PARSE_DRIFT', { outcome: 'FAILED', errorCode: 'PARSE_DRIFT' }],
      ['PARTIAL / COST_STOP', { outcome: 'PARTIAL', errorCode: 'COST_STOP' }],
      ['CANCELLED / CANCELLED', { outcome: 'CANCELLED', errorCode: 'CANCELLED' }],
      ['SUCCEEDED', { outcome: 'SUCCEEDED', errorCode: null }],
    ]

    it.each(endings)(
      'finish %s leaves every job_sources column unchanged and records the ending on the run row',
      async (_label, ending) => {
        const s = await dou({ consecutiveFailures: 2 })
        const run = await claimed(s)
        const before = await sourceSnapshot(s)
        await ledger.finish(handleOf(run), { ...ending, metrics: METRICS })
        expect(await sourceSnapshot(s)).toEqual(before)
        expect(before['consecutive_failures']).toBe(2)
        expect(await runRow(run.runId)).toMatchObject({
          outcome: ending.outcome,
          error_code: ending.errorCode,
          error_message: ending.errorMessage ?? null,
          request_count: 1,
          bytes_read: 2048,
          ended: true,
        })
      },
    )

    it('recoverExpired ends an expired LEGACY run FAILED / LEASE_EXPIRED on the run row only', async () => {
      const s = await dou()
      const run = await claimed(s)
      const before = await sourceSnapshot(s)
      await ageRun(session.admin, run.runId, 10 * 60_000)
      expect(await ledger.recoverExpired()).toBeGreaterThanOrEqual(1)
      expect(await sourceSnapshot(s)).toEqual(before)
      expect(await runRow(run.runId)).toMatchObject({
        outcome: 'FAILED',
        error_code: 'LEASE_EXPIRED',
        ended: true,
      })
    })

    it('no failure cap: four failures in a row and DOU is still claimable (SR-M-17)', async () => {
      const s = await dou()
      for (let i = 0; i < 4; i += 1) {
        const run = await claimed(s)
        await ledger.finish(handleOf(run), { outcome: 'FAILED', errorCode: 'UPSTREAM' })
      }
      const fifth = await claimed(s)
      expect(fifth.fencingEpoch).toBe(5)
      const row = await sourceSnapshot(s)
      expect([row['consecutive_failures'], row['cooldown_until'], row['last_error_code']]).toEqual([
        0,
        null,
        null,
      ])
      await ledger.finish(handleOf(fifth), { outcome: 'SUCCEEDED', errorCode: null })
    })
  })

  describe('AC 4: epoch, lease and fencing as for a reporting run', () => {
    it('after recovery the stale run cannot finish or heartbeat; its successor can', async () => {
      const s = await dou()
      const stale = await claimed(s)
      expect(await ledger.heartbeat(handleOf(stale))).toBe(true)
      await ageRun(session.admin, stale.runId, 10 * 60_000)
      expect(await ledger.recoverExpired()).toBeGreaterThanOrEqual(1)
      const successor = await claimed(s)
      expect(successor.fencingEpoch).toBe(stale.fencingEpoch + 1)
      await expect(
        ledger.finish(handleOf(stale), { outcome: 'SUCCEEDED', errorCode: null }),
      ).rejects.toBeInstanceOf(RunFencedError)
      expect(await ledger.heartbeat(handleOf(stale))).toBe(false)
      expect(await ledger.heartbeat(handleOf(successor))).toBe(true)
      await ledger.finish(handleOf(successor), { outcome: 'SUCCEEDED', errorCode: null })
      expect((await runRow(stale.runId))['error_code']).toBe('LEASE_EXPIRED')
      expect((await runRow(successor.runId))['outcome']).toBe('SUCCEEDED')
    })

    it('a wrong owner token or a stale epoch cannot finish a live run', async () => {
      const s = await dou()
      const run = await claimed(s)
      const h = handleOf(run)
      await expect(
        ledger.finish(
          { ...h, ownerToken: `${h.ownerToken}x` },
          { outcome: 'SUCCEEDED', errorCode: null },
        ),
      ).rejects.toBeInstanceOf(RunFencedError)
      await expect(
        ledger.finish(
          { ...h, fencingEpoch: h.fencingEpoch - 1 },
          { outcome: 'SUCCEEDED', errorCode: null },
        ),
      ).rejects.toBeInstanceOf(RunFencedError)
      expect((await runRow(run.runId))['outcome']).toBe('STARTED')
      await ledger.finish(h, { outcome: 'SUCCEEDED', errorCode: null })
    })
  })
})
