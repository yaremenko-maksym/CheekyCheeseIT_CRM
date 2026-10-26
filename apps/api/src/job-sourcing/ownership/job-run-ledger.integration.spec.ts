import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  openCrmAppSession,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { LedgerFixtures, SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ageRun, ageSource } from '../../test/run-aging'
import type { SourceObservation } from '../normalize/observation'
import type { ValidatedCheckpoint } from '../providers/reporting-provider'
import { type ClaimedRun, JobRunLedger } from './job-run-ledger'
import type { LedgerCatalogEntry } from './ledger-catalog'

/**
 * r5 Task 2.5 T3 — the run ledger against a REAL Postgres, AS `crm_app` (every statement under test
 * runs on the `crm_app` pool; fixtures and aging go through the migration role). Time is moved by
 * the aging helpers only (`ageRun`, `ageSource`), never by an injected clock.
 *
 * NEVER run against `crm_db` (`openCrmAppSession` refuses one):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-ledger.integration
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let fx: LedgerFixtures
let catalog: SpecCatalog
let ledger: JobRunLedger
let actor: string

const HOUR = 3_600_000
/** A readiness deadline every database clock of this suite is past. */
const PAST_DEADLINE = Date.parse('2026-01-01T00:00:00Z')

async function scheduledCycle(): Promise<string> {
  return (await ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: fx.cycleKey() })).cycleId
}

async function manualCycle(): Promise<string> {
  return (await ledger.openCycle({ trigger: 'MANUAL', triggerKey: fx.cycleKey(), actor })).cycleId
}

/** A reporting source with a catalog entry and a host policy; returns its id. */
async function reporting(seed: Parameters<LedgerFixtures['source']>[0] = {}): Promise<string> {
  const manifestId = seed.manifestId ?? fx.manifestId()
  const hostKey =
    seed.hostKey === undefined ? fx.host(`h-${randomUUID().slice(0, 6)}`) : seed.hostKey
  catalog.add(manifestId, { type: seed.type ?? 'REMOTIVE_API' })
  if (hostKey !== null) catalog.policies.set(hostKey, { rate: null, floorHours: 0 })
  return fx.source({ ...seed, manifestId, hostKey })
}

async function claimOne(sourceId: string): Promise<ClaimedRun> {
  const { claimed } = await ledger.claimDue({
    cycleId: await scheduledCycle(),
    owner: 'spec-worker',
    limit: 1,
    onlyIds: [sourceId],
  })
  const run = claimed[0]
  if (run === undefined) throw new Error(`setup: source ${sourceId} was not claimed`)
  return run
}

const handle = (r: ClaimedRun) => ({
  runId: r.runId,
  ownerToken: r.ownerToken,
  fencingEpoch: r.fencingEpoch,
})

function checkpoint(page: number): ValidatedCheckpoint {
  return {
    configVersion: 1,
    policyVersion: 1,
    adapterVersion: 'remotive_api-1',
    position: { kind: 'CURSOR', page, cursor: `c${page}` },
    completedAt: new Date('2026-10-25T00:00:00Z'),
  }
}

/** Observations carrying only what `savePage` reads: the identity. */
function observations(ids: readonly string[], namespace = `t3spec-${TAG}`): SourceObservation[] {
  return ids.map(
    (id) =>
      ({
        identity: {
          provider: 'REMOTIVE_API',
          namespace,
          nativeId: id,
          identityKey: `["${id}"]`,
          identityKind: 'NATIVE_ID',
        },
      }) as unknown as SourceObservation,
  )
}

async function rejection(p: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await p
  } catch (e) {
    return e as { code?: string }
  }
  throw new Error('expected a rejection')
}

describe.skipIf(!hasDatabaseUrl())('the run ledger against Postgres, as crm_app (T3)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    fx = new LedgerFixtures(session.admin, TAG)
    catalog = new SpecCatalog()
    ledger = new JobRunLedger(
      drizzle(session.pool, { schema }),
      specRegistry(['REMOTIVE_API', 'ARBEITNOW_API', 'JSEARCH_API'], ['ARBEITNOW_API']),
      catalog,
    )
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'T3 spec', 'ADMIN') RETURNING id`,
      [`t3spec-${TAG}@example.test`],
    )
    actor = rows[0].id as string
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

  describe('openCycle (SR-L-19)', () => {
    it('two replicas opening the same scheduled cycle get one row', async () => {
      const key = fx.cycleKey()
      const [a, b] = await Promise.all([
        ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key }),
        ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key }),
      ])
      expect(a.cycleId).toBe(b.cycleId)
      const { rows } = await session.admin.query(
        `SELECT count(*)::int AS n FROM job_collection_cycles WHERE trigger_key = $1`,
        [key],
      )
      expect(rows[0].n).toBe(1)
    })

    it('CR-M-1: the replica whose insert waits on the winner`s uncommitted row gets the winner`s id', async () => {
      const key = fx.cycleKey()
      const winner = await session.admin.connect()
      try {
        await winner.query('BEGIN')
        const { rows } = await winner.query(
          `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
          [key],
        )
        const loser = ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key })
        // Commit only once the loser's INSERT is parked on the winner's row.
        const deadline = Date.now() + 10_000
        for (;;) {
          const { rows: w } = await session.admin.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO job_collection_cycles%'`,
          )
          if (w[0].n > 0) break
          if (Date.now() > deadline) throw new Error('setup: the loser never waited')
          await new Promise((r) => setTimeout(r, 20))
        }
        await winner.query('COMMIT')
        expect((await loser).cycleId).toBe(rows[0].id)
      } finally {
        winner.release()
      }
    })

    it('CR-M-1: 200 rounds of 4 replicas opening one cycle never throw and leave one row', async () => {
      for (let i = 0; i < 200; i += 1) {
        const key = fx.cycleKey()
        const ids = await Promise.all(
          [0, 1, 2, 3].map(() => ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: key })),
        )
        expect(new Set(ids.map((x) => x.cycleId)).size).toBe(1)
      }
    }, 120_000)

    it('a manual cycle names its actor; a manual cycle without one is refused', async () => {
      const id = await manualCycle()
      const { rows } = await session.admin.query(
        `SELECT trigger, requested_by FROM job_collection_cycles WHERE id = $1`,
        [id],
      )
      expect(rows[0]).toEqual({ trigger: 'MANUAL', requested_by: actor })
      await expect(
        ledger.openCycle({ trigger: 'MANUAL', triggerKey: fx.cycleKey() } as never),
      ).rejects.toThrow(RangeError)
    })
  })

  describe('AC 5: the epoch', () => {
    it('the first run of a source is epoch 1, and each later run is strictly greater', async () => {
      const s = await reporting()
      const epochs: number[] = []
      for (let i = 0; i < 3; i += 1) {
        const run = await claimOne(s)
        epochs.push(run.fencingEpoch)
        await ledger.finish(handle(run), { outcome: 'SUCCEEDED', errorCode: null })
        await ageSource(session.admin, s, 25 * HOUR)
      }
      expect(epochs).toEqual([1, 2, 3])
      expect((await fx.runs(s)).map((r) => r.epoch)).toEqual([1, 2, 3])
    })
  })

  describe('AC 4 / SR-M-18: heartbeat', () => {
    it('a heartbeat with the wrong epoch or token changes nothing', async () => {
      const s = await reporting()
      const run = await claimOne(s)
      const before = await session.admin.query(
        `SELECT lease_expires_at FROM job_collection_runs WHERE id = $1`,
        [run.runId],
      )
      expect(await ledger.heartbeat({ ...handle(run), fencingEpoch: run.fencingEpoch + 1 })).toBe(
        false,
      )
      expect(await ledger.heartbeat({ ...handle(run), ownerToken: 'someone-else' })).toBe(false)
      const after = await session.admin.query(
        `SELECT lease_expires_at FROM job_collection_runs WHERE id = $1`,
        [run.runId],
      )
      expect(after.rows[0].lease_expires_at).toEqual(before.rows[0].lease_expires_at)
      expect(await ledger.heartbeat(handle(run))).toBe(true)
    })

    it('no heartbeat extends a lease past started_at + RUN_MAX_AGE', async () => {
      const s = await reporting()
      const run = await claimOne(s)
      // 1 h 58 min into a 2 h maximum: a 5 min lease would reach 2 h 3 min, so it is capped.
      await ageRun(session.admin, run.runId, 118 * 60_000, 'started_at')
      expect(await ledger.heartbeat(handle(run))).toBe(true)
      const { rows } = await session.admin.query(
        `SELECT extract(epoch FROM lease_expires_at - started_at)::float8 AS s FROM job_collection_runs WHERE id = $1`,
        [run.runId],
      )
      expect(rows[0].s).toBeCloseTo(7200, 0)
    })
  })

  describe('AC 2 / AC 8: recovery', () => {
    it('after recovery a stale savePage is refused RUN_FENCED and the successor`s pages are intact', async () => {
      const s = await reporting()
      const stale = await claimOne(s)
      await ledger.savePage(handle(stale), {
        observations: observations(['a1']),
        checkpoint: checkpoint(1),
      })
      await ageRun(session.admin, stale.runId, 10 * 60_000)
      expect(await ledger.recoverExpired()).toBeGreaterThanOrEqual(1)
      await ageSource(session.admin, s, 48 * HOUR)

      const successor = await claimOne(s)
      await ledger.savePage(handle(successor), {
        observations: observations(['b1']),
        checkpoint: checkpoint(2),
      })
      const err = await rejection(
        ledger.savePage(handle(stale), {
          observations: observations(['a2']),
          checkpoint: checkpoint(9),
        }),
      )
      expect(err.code).toBe('RUN_FENCED')
      const runs = await fx.runs(s)
      expect(runs.map((r) => [r.outcome, r.error_code])).toEqual([
        ['FAILED', 'LEASE_EXPIRED'],
        ['STARTED', null],
      ])
      expect((runs[1]!.checkpoint['position'] as { page: number }).page).toBe(2)
      expect(runs[1]!.received).toBe(1)
    })

    it('recovery settles RESERVED -> RELEASED and SENT / UNCERTAIN -> USED at the full amount', async () => {
      const acct = fx.accountKey('recover')
      const meterId = await fx.meter(acct, 100)
      const s = await reporting({ type: 'JSEARCH_API', accountMeterId: meterId })
      const run = await claimOne(s)
      const meter = ledger.meterFor(run, { REQUEST: 'DAY' })
      const r1 = (await meter.reserve('REQUEST', 3))!
      const r2 = (await meter.reserve('REQUEST', 5))!
      const r3 = (await meter.reserve('REQUEST', 7))!
      await meter.markSent(r2)
      await meter.reconcile(r3, 'UNCERTAIN')
      expect(await fx.counters(meterId)).toEqual({ used: 0, reserved: 8, uncertain: 7 })

      await ageRun(session.admin, run.runId, 10 * 60_000)
      await ledger.recoverExpired()

      expect((await fx.runs(s)).map((r) => [r.outcome, r.error_code])).toEqual([
        ['FAILED', 'LEASE_EXPIRED'],
      ])
      const settled = new Map((await fx.reservations(run.runId)).map((r) => [r.id, r]))
      expect(settled.get(r1.id)).toMatchObject({ status: 'RELEASED', used_amount: 0 })
      expect(settled.get(r2.id)).toMatchObject({ status: 'USED', used_amount: 5 })
      expect(settled.get(r3.id)).toMatchObject({ status: 'USED', used_amount: 7 })
      expect(await fx.counters(meterId)).toEqual({ used: 12, reserved: 0, uncertain: 0 })
    })

    it('finish settles the same way: no UNCERTAIN remains on a finished run', async () => {
      const meterId = await fx.meter(fx.accountKey('finish'), 100)
      const s = await reporting({ type: 'JSEARCH_API', accountMeterId: meterId })
      const run = await claimOne(s)
      const meter = ledger.meterFor(run, { REQUEST: 'DAY' })
      const r = (await meter.reserve('REQUEST', 4))!
      await meter.reconcile(r, 'UNCERTAIN')
      await ledger.finish(handle(run), { outcome: 'FAILED', errorCode: 'UPSTREAM' })
      expect((await fx.reservations(run.runId)).map((x) => x.status)).toEqual(['USED'])
      expect(await fx.counters(meterId)).toEqual({ used: 4, reserved: 0, uncertain: 0 })
    })

    it('the sweep settles an open reservation left on a terminal run', async () => {
      const meterId = await fx.meter(fx.accountKey('sweep'), 100)
      const s = await reporting({ type: 'JSEARCH_API', accountMeterId: meterId })
      const run = await claimOne(s)
      const r = (await ledger.meterFor(run, { REQUEST: 'DAY' }).reserve('REQUEST', 2))!
      await ledger.finish(handle(run), { outcome: 'SUCCEEDED', errorCode: null })
      // A reservation the settlement could not see (written behind its back), still SENT.
      await session.admin.query(
        `UPDATE job_account_meter_reservations SET status = 'SENT', settled_at = NULL, sent_at = now() WHERE id = $1`,
        [r.id],
      )
      await session.admin.query(
        `UPDATE job_account_meters SET reserved = reserved + 2 WHERE id = $1`,
        [meterId],
      )
      expect(await ledger.sweepOrphanReservations()).toBeGreaterThanOrEqual(1)
      expect((await fx.reservations(run.runId)).map((x) => x.status)).toEqual(['USED'])
      const { rows } = await session.admin.query(
        `SELECT count(*)::int AS n FROM job_account_meter_reservations res
           JOIN job_collection_runs r ON r.id = res.run_id
          WHERE r.outcome <> 'STARTED' AND res.status IN ('RESERVED', 'SENT', 'UNCERTAIN')`,
      )
      expect(rows[0].n).toBe(0)
    })
  })

  describe('AC 3: markSent against recovery', () => {
    it('ends in exactly one of {SENT settled USED, markSent refused}, 20 races', async () => {
      const meterId = await fx.meter(fx.accountKey('race'), null)
      const s = await reporting({ type: 'JSEARCH_API', accountMeterId: meterId })
      const outcomes: string[] = []
      for (let i = 0; i < 20; i += 1) {
        const run = await claimOne(s)
        const meter = ledger.meterFor(run, { REQUEST: 'DAY' })
        const r = (await meter.reserve('REQUEST', 1))!
        // The lease ends within the next ~0-40 ms, so the two really race for the run row: recovery
        // retries until the lease is gone, while markSent goes once.
        await ageRun(session.admin, run.runId, 5 * 60_000 - Math.floor(Math.random() * 40))
        const recover = async () => {
          for (let k = 0; k < 50 && (await ledger.recoverExpired()) === 0; k += 1) {
            await new Promise((done) => setTimeout(done, 5))
          }
        }
        const [sent] = await Promise.allSettled([meter.markSent(r), recover()])
        const [row] = await fx.reservations(run.runId)
        const markSent =
          sent.status === 'fulfilled' ? 'SENT' : String((sent.reason as { code?: string }).code)
        outcomes.push(`${markSent}->${row!.status}`)
        await session.admin.query(
          `UPDATE job_sources SET consecutive_failures = 0, cooldown_until = NULL, next_attempt_at = clock_timestamp() - interval '1 hour' WHERE id = $1`,
          [s],
        )
      }
      // Exactly two endings exist: a committed markSent is charged (USED), a refused one sent
      // nothing and was released. "SENT->RELEASED" -- sent and then released -- never occurs.
      expect(outcomes).toHaveLength(20)
      expect(outcomes.filter((o) => o !== 'SENT->USED' && o !== 'RUN_FENCED->RELEASED')).toEqual([])
    })
  })

  describe('AC 13 / AC 18: the claim gates refuse, by claimDue and claimSource alike', () => {
    /** Neither path claimed: no run row, and the host slot was never stamped. */
    async function noSlotConsumed(sourceId: string, hostKey: string | null): Promise<void> {
      expect(await fx.runs(sourceId)).toEqual([])
      const { rows } = await session.admin.query(
        `SELECT last_claimed_at FROM job_source_hosts WHERE host_key = $1`,
        [hostKey],
      )
      expect(rows.map((r) => r.last_claimed_at)).toEqual(rows.length === 0 ? [] : [null])
    }

    async function bothPaths(sourceId: string) {
      const due = await ledger.claimDue({
        cycleId: await scheduledCycle(),
        owner: 'spec-worker',
        limit: 1,
        onlyIds: [sourceId],
      })
      const manual = await ledger.claimSource({
        cycleId: await manualCycle(),
        owner: 'spec-worker',
        sourceId,
        actor,
      })
      return { due, manual }
    }

    it.each(['PAUSED', 'RETIRED'] as const)(
      'an enabled source in admin_state %s is never claimed',
      async (adminState) => {
        const host = fx.host(`adm-${adminState.toLowerCase()}`)
        const s = await reporting({ adminState, hostKey: host })
        const { due, manual } = await bothPaths(s)
        expect(due).toEqual({ claimed: [], refused: [] })
        expect(manual).toEqual({ kind: 'REFUSED', reason: 'NOT_ACTIVE' })
        await noSlotConsumed(s, host)
      },
    )

    const gated: [string, (id: string) => void, Parameters<LedgerFixtures['source']>[0], string][] =
      [
        [
          'an ACCEPT_RISK type with no captured evidence (NOT_ACTIVATABLE)',
          (m) =>
            catalog.add(m, {
              activationFacts: () => ({
                readiness: 'BLOCKED',
                blockerCodes: ['NO_CAPTURE'],
                payloadVerified: false,
              }),
            }),
          {},
          'NOT_ACTIVATABLE',
        ],
        [
          'a source past its readinessAt deadline (READINESS_BLOCKED)',
          // Date-dependent (SPEC-M-2): blocked only at an instant past the deadline.
          (m) =>
            catalog.add(m, {
              entryReadiness: (at) => (at.getTime() >= PAST_DEADLINE ? 'BLOCKED' : 'CANDIDATE'),
            }),
          {},
          'READINESS_BLOCKED',
        ],
        [
          'an adapter without allowedHosts (TRANSPORT_NOT_WIRED)',
          (m) => catalog.add(m, { type: 'ARBEITNOW_API' }),
          { type: 'ARBEITNOW_API' },
          'TRANSPORT_NOT_WIRED',
        ],
        [
          'a metered type with a NULL meter (METER_MISSING)',
          (m) => catalog.add(m, { type: 'JSEARCH_API', quotaDeclared: true }),
          { type: 'JSEARCH_API' },
          'METER_MISSING',
        ],
        [
          'an unresolvable manifest_id (MANIFEST_ENTRY_MISSING)',
          () => undefined,
          {},
          'MANIFEST_ENTRY_MISSING',
        ],
      ]

    it.each(gated)('refuses %s', async (_label, register, seed, reason) => {
      const manifestId = fx.manifestId()
      register(manifestId)
      const host = fx.host(`gate-${randomUUID().slice(0, 6)}`)
      catalog.policies.set(host, { rate: null, floorHours: 0 })
      const s = await fx.source({ ...seed, manifestId, hostKey: host })
      const { due, manual } = await bothPaths(s)
      expect(due).toEqual({ claimed: [], refused: [{ sourceId: s, reason }] })
      expect(manual).toEqual({ kind: 'REFUSED', reason })
      await noSlotConsumed(s, host)
      // The scheduled refusal is recorded and pushed out by the recheck (6 h), never counted.
      const row = await fx.sourceRow(s)
      expect(row.last_error_code).toBe(reason)
      expect(row.consecutive_failures).toBe(0)
      expect(row.next_in_s).toBeGreaterThan(6 * 3600 - 60)
    })

    describe('SR-L-21 (SPEC-M-2): the gates are evaluated at the DATABASE clock, not the app clock', () => {
      // Only `Date` is faked: the app clock is moved a day away from the database's, timers stay real.
      afterEach(() => {
        vi.useRealTimers()
      })

      async function dbNow(): Promise<number> {
        const { rows } = await session.admin.query(`SELECT clock_timestamp() AS t`)
        return (rows[0].t as Date).getTime()
      }

      async function gatedSource(over: Partial<LedgerCatalogEntry>): Promise<string> {
        const manifestId = fx.manifestId()
        catalog.add(manifestId, over)
        const host = fx.host(`clk-${randomUUID().slice(0, 6)}`)
        catalog.policies.set(host, { rate: null, floorHours: 0 })
        return fx.source({ manifestId, hostKey: host })
      }

      it('a readiness deadline the DB clock has passed refuses, though the app clock has not', async () => {
        const deadline = (await dbNow()) - HOUR
        const s = await gatedSource({
          entryReadiness: (at) => (at.getTime() >= deadline ? 'BLOCKED' : 'CANDIDATE'),
        })
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(deadline - 24 * HOUR)
        const { due, manual } = await bothPaths(s)
        expect(due).toEqual({
          claimed: [],
          refused: [{ sourceId: s, reason: 'READINESS_BLOCKED' }],
        })
        expect(manual).toEqual({ kind: 'REFUSED', reason: 'READINESS_BLOCKED' })
      })

      it('activation evidence still valid at the DB clock is honoured, though the app clock is past it', async () => {
        const validUntil = (await dbNow()) + HOUR
        const s = await gatedSource({
          activationFacts: (at) =>
            at.getTime() < validUntil
              ? { readiness: 'CANDIDATE', blockerCodes: [], payloadVerified: true }
              : { readiness: 'BLOCKED', blockerCodes: ['NO_CAPTURE'], payloadVerified: false },
        })
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(validUntil + 24 * HOUR)
        const manual = await ledger.claimSource({
          cycleId: await manualCycle(),
          owner: 'spec-worker',
          sourceId: s,
          actor,
        })
        expect(manual.kind).toBe('CLAIMED')
      })
    })

    it('DOU (LEGACY kind) is refused NOT_ACTIVATABLE even with a manifest id and a host key', async () => {
      const manifestId = fx.manifestId()
      catalog.add(manifestId, { type: 'DOU_RSS' })
      const host = fx.host('dou')
      catalog.policies.set(host, { rate: null, floorHours: 0 })
      const s = await fx.source({ type: 'DOU_RSS', manifestId, hostKey: host })
      const { due, manual } = await bothPaths(s)
      expect(due.refused).toEqual([{ sourceId: s, reason: 'NOT_ACTIVATABLE' }])
      expect(manual).toEqual({ kind: 'REFUSED', reason: 'NOT_ACTIVATABLE' })
      await noSlotConsumed(s, host)
    })

    it('DOU as seeded (no manifest id, NULL host key) is never even picked', async () => {
      const s = await fx.source({ type: 'DOU_RSS', manifestId: null, hostKey: null })
      const { due, manual } = await bothPaths(s)
      expect(due).toEqual({ claimed: [], refused: [] })
      expect(manual).toEqual({ kind: 'REFUSED', reason: 'NOT_ACTIVATABLE' })
    })
  })

  describe('AC 14 / SR-M-19: the queue is never blocked', () => {
    it('a refused source at the head does not block a claimable one behind it', async () => {
      const head = await fx.source({
        type: 'ARBEITNOW_API',
        manifestId: fx.manifestId(),
        nextAttemptSql: "clock_timestamp() - interval '3 hours'",
      })
      catalog.add(await fx.manifestIdOf(head), { type: 'ARBEITNOW_API' })
      const behind = await reporting({ nextAttemptSql: "clock_timestamp() - interval '1 hour'" })
      const { claimed, refused } = await ledger.claimDue({
        cycleId: await scheduledCycle(),
        owner: 'spec-worker',
        limit: 1,
        onlyIds: [head, behind],
      })
      expect(refused).toEqual([{ sourceId: head, reason: 'TRANSPORT_NOT_WIRED' }])
      expect(claimed.map((c) => c.sourceId)).toEqual([behind])
    })

    it('with 12 due sources on a busy host and one elsewhere, the other host is claimed in one call', async () => {
      const busyHost = fx.host('busy')
      const runner = await reporting({ hostKey: busyHost })
      await claimOne(runner)
      const waiting: string[] = []
      for (let i = 0; i < 12; i += 1) {
        waiting.push(
          await reporting({
            hostKey: busyHost,
            nextAttemptSql: "clock_timestamp() - interval '5 hours'",
          }),
        )
      }
      const elsewhere = await reporting({
        nextAttemptSql: "clock_timestamp() - interval '1 minute'",
      })
      const narrow = new JobRunLedger(
        drizzle(session.pool, { schema }),
        specRegistry(['REMOTIVE_API']),
        catalog,
        { maxClaimScan: 2 },
      )
      const { claimed, refused } = await narrow.claimDue({
        cycleId: await scheduledCycle(),
        owner: 'spec-worker',
        limit: 1,
        onlyIds: [...waiting, elsewhere],
      })
      expect(claimed.map((c) => c.sourceId)).toEqual([elsewhere])
      expect(refused).toEqual([])
    })
  })

  describe('AC 17 (SR-L-16): claimSource does not wait behind a held source row', () => {
    it('returns LOCK_TIMEOUT within its lock_timeout', async () => {
      const s = await reporting()
      const quick = new JobRunLedger(
        drizzle(session.pool, { schema }),
        specRegistry(['REMOTIVE_API']),
        catalog,
        { claimLockTimeoutMs: 300 },
      )
      const holder = await session.pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT 1 FROM job_sources WHERE id = $1 FOR UPDATE', [s])
        const started = Date.now()
        const result = await quick.claimSource({
          cycleId: await manualCycle(),
          owner: 'spec-worker',
          sourceId: s,
          actor,
        })
        const elapsed = Date.now() - started
        expect(result).toEqual({ kind: 'REFUSED', reason: 'LOCK_TIMEOUT' })
        expect(elapsed).toBeLessThan(2_000)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
      }
      expect(await fx.runs(s)).toEqual([])
    })
  })

  describe('SR-L-25: resetFailures', () => {
    it('clears the cap, makes the source due now, and appends one RESET_FAILURES entry', async () => {
      // A capped source as `finish` leaves it (SPEC-M-1): next attempt a cadence away, cooling down.
      const s = await reporting({
        consecutiveFailures: 3,
        nextAttemptSql: "clock_timestamp() + interval '24 hours'",
      })
      await session.admin.query(
        `UPDATE job_sources SET cooldown_until = clock_timestamp() + interval '4 hours' WHERE id = $1`,
        [s],
      )
      const before = await fx.sourceRow(s)
      expect([before.cooling, before.next_in_s > 23 * 3600]).toEqual([true, true])
      expect(await ledger.resetFailures({ sourceId: s, actor, reason: 'provider fixed' })).toBe(
        true,
      )
      const row = await fx.sourceRow(s)
      expect(row.consecutive_failures).toBe(0)
      expect(row.cooling).toBe(false)
      expect(row.next_in_s).toBeLessThanOrEqual(0)
      expect(row.admin_state_history).toEqual([
        expect.objectContaining({ kind: 'RESET_FAILURES', actor, reason: 'provider fixed' }),
      ])
      // Claimable at the next handler.
      expect((await claimOne(s)).sourceId).toBe(s)
    })

    it('a concurrent admin-state append survives the reset`s append', async () => {
      const s = await reporting({ consecutiveFailures: 3 })
      const toggler = await session.pool.connect()
      try {
        await toggler.query('BEGIN')
        await toggler.query(
          `UPDATE job_sources SET admin_state_history = admin_state_history || '[{"kind":"TOGGLE"}]'::jsonb WHERE id = $1`,
          [s],
        )
        const reset = ledger.resetFailures({ sourceId: s, actor, reason: 'concurrent' })
        await new Promise((done) => setTimeout(done, 100))
        await toggler.query('COMMIT')
        expect(await reset).toBe(true)
      } finally {
        toggler.release()
      }
      const kinds = (await fx.sourceRow(s)).admin_state_history.map(
        (e) => (e as { kind: string }).kind,
      )
      expect(kinds).toEqual(['TOGGLE', 'RESET_FAILURES'])
    })

    it('refuses an empty or over-long reason and writes nothing', async () => {
      const s = await reporting({ consecutiveFailures: 3 })
      await expect(ledger.resetFailures({ sourceId: s, actor, reason: ' ' })).rejects.toThrow(
        RangeError,
      )
      await expect(
        ledger.resetFailures({ sourceId: s, actor, reason: 'x'.repeat(501) }),
      ).rejects.toThrow(RangeError)
      expect((await fx.sourceRow(s)).consecutive_failures).toBe(3)
    })
  })
})
