import { randomUUID } from 'node:crypto'
import type { JobMeterUnit, JobMeterWindow } from '@crm/shared'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import {
  AccountMeterError,
  createAccountMeter,
  type AccountMeterBinding,
} from './account-meter.store'

/**
 * r5 Task 3.5a — the shared account-meter reservation store, against REAL Postgres.
 *
 * Every claim here is about counters on a locked row, and two of them (multi-worker exhaustion,
 * a retry finding its own reservation) are claims about several connections at once; a mock
 * cannot observe either. So the store is exercised through its own public functions against a
 * scratch database, and every transition is asserted by the VALUES of `used / reserved /
 * uncertain` read back with plain SQL — never by "changed", never by a count of calls.
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_meter35a \
 *     pnpm --filter @crm/api exec vitest run src/job-sourcing/metering/account-meter.store
 */

const TAG = `m35a-${randomUUID().slice(0, 8)}`

let pool: Pool
let db: NodePgDatabase<typeof schema>

const q = (text: string, params: unknown[] = []) => pool.query(text, params)

let seq = 0
const nextTag = () => {
  seq += 1
  return `${TAG}-${seq}`
}

/** A per-test account key that satisfies the account-key CHECKs (short, segmented, lowercase). */
const nextAccount = () => `${TAG}:acct-${(seq += 1)}`

async function newCycle(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [nextTag()],
  )
  return rows[0].id as string
}

interface MeterOpts {
  accountKey?: string
  unit?: JobMeterUnit
  window?: JobMeterWindow
  limit?: number | null
  used?: number
  uncertain?: number
}

async function newMeter(opts: MeterOpts = {}): Promise<{ id: string; accountKey: string }> {
  const accountKey = opts.accountKey ?? nextAccount()
  const window = opts.window ?? 'DAY'
  const { rows } = await q(
    `INSERT INTO job_account_meters
       (account_key, unit, window_kind, limit_amount, used, uncertain, window_started_at, resets_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      accountKey,
      opts.unit ?? 'REQUEST',
      window,
      opts.limit === undefined ? null : opts.limit,
      opts.used ?? 0,
      opts.uncertain ?? 0,
      window === 'LIFETIME' ? null : new Date(Date.now() - 60_000),
      window === 'LIFETIME' ? null : new Date(Date.now() + 23 * 3_600_000),
    ],
  )
  return { id: rows[0].id as string, accountKey }
}

/** The three counters, as numbers. The assertion every transition below is made with. */
async function counters(meterId: string) {
  const { rows } = await q(
    `SELECT used::float8 AS used, reserved::float8 AS reserved, uncertain::float8 AS uncertain
       FROM job_account_meters WHERE id = $1`,
    [meterId],
  )
  return rows[0] as { used: number; reserved: number; uncertain: number }
}

async function reservationRow(id: string) {
  const { rows } = await q(
    `SELECT status, amount::int AS amount, used_amount::int AS used_amount, sent_at, settled_at,
            reserved_at, attempt_id, meter_id
       FROM job_account_meter_reservations WHERE id = $1`,
    [id],
  )
  return rows[0] as {
    status: string
    amount: number
    used_amount: number
    sent_at: Date | null
    settled_at: Date | null
    reserved_at: Date
    attempt_id: string
    meter_id: string
  }
}

async function reservationCount(meterId: string): Promise<number> {
  const { rows } = await q(
    `SELECT count(*)::int AS n FROM job_account_meter_reservations WHERE meter_id = $1`,
    [meterId],
  )
  return rows[0].n as number
}

function binding(over: Partial<AccountMeterBinding> & { accountKey: string; cycleId: string }) {
  return {
    attemptId: nextTag(),
    runId: null,
    windows: { REQUEST: 'DAY' },
    ...over,
  } satisfies AccountMeterBinding
}

/** Resolves to the error a call rejected with; fails the test when it did not reject. */
async function rejection(p: Promise<unknown>): Promise<AccountMeterError> {
  try {
    await p
  } catch (e) {
    if (e instanceof AccountMeterError) return e
    throw e
  }
  throw new Error('expected the meter call to reject')
}

describe.skipIf(!hasDatabaseUrl())('account meter store (real Postgres)', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_account_meters', column: 'limit_amount' },
      { table: 'job_account_meter_reservations', column: 'used_amount' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 20 })
    const { rows } = await q('SELECT current_database() AS db')
    // Writing spec: refuse the live database outright (the vitest guard does too).
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    db = drizzle(pool, { schema })
  })

  afterAll(async () => {
    if (!pool) return
    // Children first: the reservation -> meter / run / cycle links are RESTRICT.
    await q(
      `DELETE FROM job_account_meter_reservations
        WHERE meter_id IN (SELECT id FROM job_account_meters WHERE account_key LIKE $1)`,
      [`${TAG}%`],
    )
    await q(`DELETE FROM job_collection_runs WHERE attempt_id LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_account_meters WHERE account_key LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_sources WHERE config->>'tag' LIKE $1`, [`${TAG}%`])
    await pool.end()
  })

  describe('the limit boundary (AC1)', () => {
    it('accepts used + reserved + uncertain + cost == limit, refuses limit + 1', async () => {
      // used 3 and uncertain 2 are already on the row; limit 10 leaves room for exactly 5.
      const m = await newMeter({ limit: 10, used: 3, uncertain: 2 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )

      const first = await meter.reserve('REQUEST', 4)
      expect(first).not.toBeNull()
      expect(await counters(m.id)).toEqual({ used: 3, reserved: 4, uncertain: 2 })

      // 3 + 4 + 2 + 1 == 10: AT the limit — accepted.
      const atLimit = await meter.reserve('REQUEST', 1)
      expect(atLimit).toEqual({ id: expect.any(String), unit: 'REQUEST', amount: 1 })
      expect(await counters(m.id)).toEqual({ used: 3, reserved: 5, uncertain: 2 })

      // 3 + 5 + 2 + 1 == 11: PAST the limit — refused with null (a COST_STOP), nothing written.
      expect(await meter.reserve('REQUEST', 1)).toBeNull()
      expect(await counters(m.id)).toEqual({ used: 3, reserved: 5, uncertain: 2 })
      expect(await reservationCount(m.id)).toBe(2)
    })

    it('a single reservation of exactly the limit is accepted; one unit more is refused', async () => {
      const past = await newMeter({ limit: 5 })
      const pastMeter = createAccountMeter(
        db,
        binding({ accountKey: past.accountKey, cycleId: await newCycle() }),
      )
      expect(await pastMeter.reserve('REQUEST', 6)).toBeNull()
      expect(await counters(past.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await reservationCount(past.id)).toBe(0)

      const at = await newMeter({ limit: 5 })
      const atMeter = createAccountMeter(
        db,
        binding({ accountKey: at.accountKey, cycleId: await newCycle() }),
      )
      expect(await atMeter.reserve('REQUEST', 5)).toEqual({
        id: expect.any(String),
        unit: 'REQUEST',
        amount: 5,
      })
      expect(await counters(at.id)).toEqual({ used: 0, reserved: 5, uncertain: 0 })
    })

    it('a zero limit refuses even the smallest reservation', async () => {
      const m = await newMeter({ limit: 0 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      expect(await meter.reserve('REQUEST', 1)).toBeNull()
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
    })

    it('a NULL limit is unlimited — the schema single meaning', async () => {
      const m = await newMeter({ limit: null })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      expect(await meter.reserve('REQUEST', 1_000_000_000_000)).not.toBeNull()
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 1_000_000_000_000, uncertain: 0 })
    })

    it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      'refuses a non-positive or non-integer amount (%s) before touching the database',
      async (amount) => {
        const m = await newMeter({ limit: null })
        const meter = createAccountMeter(
          db,
          binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
        )
        const error = await rejection(meter.reserve('REQUEST', amount))
        expect(error.code).toBe('INVALID_AMOUNT')
        expect(await reservationCount(m.id)).toBe(0)
      },
    )
  })

  describe('multi-worker exhaustion (AC2)', () => {
    it('N concurrent reservers against room for K < N: exactly K succeed', async () => {
      const N = 8
      const K = 3
      const m = await newMeter({ limit: K })
      const cycleId = await newCycle()

      // A blocker holds the meter row lock so that every reserver is provably IN FLIGHT, on its
      // own connection, waiting on the same row before any of them can proceed. Without this the
      // run could legitimately serialise in the client and prove nothing about the database.
      const blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM job_account_meters WHERE id = $1 FOR UPDATE', [m.id])

        const racing = Array.from({ length: N }, () =>
          createAccountMeter(db, binding({ accountKey: m.accountKey, cycleId })).reserve(
            'REQUEST',
            1,
          ),
        )

        // Probed on a SEPARATE autocommit connection: inside the blocker transaction
        // pg_stat_activity is a snapshot taken once, and would read 0 forever.
        // Bounded wait (5 s) until all N are blocked on a lock in this database.
        const deadline = Date.now() + 5_000
        let waiting = 0
        while (Date.now() < deadline) {
          const { rows } = await q(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query ILIKE '%job_account_meters%'`,
          )
          waiting = rows[0].n as number
          if (waiting >= N) break
          await new Promise((r) => setTimeout(r, 25))
        }
        expect(waiting).toBeGreaterThanOrEqual(N)

        await blocker.query('COMMIT')
        const results = await Promise.all(racing)

        expect(results.filter((r) => r !== null)).toHaveLength(K)
        expect(results.filter((r) => r === null)).toHaveLength(N - K)
        expect(await counters(m.id)).toEqual({ used: 0, reserved: K, uncertain: 0 })
        expect(await reservationCount(m.id)).toBe(K)
      } finally {
        blocker.release()
      }
    })

    it('concurrent reservers of unequal cost never overshoot the limit', async () => {
      // limit 10; twelve workers asking 3 each -> at most 3 fit (9), the 4th would make 12.
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          createAccountMeter(db, binding({ accountKey: m.accountKey, cycleId })).reserve(
            'REQUEST',
            3,
          ),
        ),
      )
      expect(results.filter((r) => r !== null)).toHaveLength(3)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 9, uncertain: 0 })
    })
  })

  describe('the attempt reservation is idempotent (AC3)', () => {
    it('a retry of the same attempt finds its reservation; counters unchanged', async () => {
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const attemptId = nextTag()

      const first = await createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      ).reserve('REQUEST', 2)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })

      // A new worker (a fresh binding — nothing in memory) re-runs the same attempt.
      const retried = await createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      ).reserve('REQUEST', 2)

      expect(retried).toEqual(first)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(1)
    })

    it('repeated paid requests in ONE attempt get distinct reservations', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const a = await meter.reserve('REQUEST', 2)
      const b = await meter.reserve('REQUEST', 2)
      expect(a?.id).not.toBe(b?.id)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 4, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(2)
    })

    it('concurrent paid requests on ONE binding never share a reservation', async () => {
      // Two in-flight requests of one attempt are two charges. If both computed the same request
      // ordinal, the second would "find" the first's RESERVED row and send unaccounted.
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const [a, b, c] = await Promise.all([
        meter.reserve('REQUEST', 2),
        meter.reserve('REQUEST', 2),
        meter.reserve('REQUEST', 2),
      ])
      expect(new Set([a?.id, b?.id, c?.id]).size).toBe(3)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 6, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(3)
    })

    it('a retry does NOT reuse a reservation whose request already left: it reserves anew', async () => {
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const attemptId = nextTag()
      const firstRun = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      )
      const spent = await firstRun.reserve('REQUEST', 2)
      if (spent === null) throw new Error('setup: reservation refused')
      await firstRun.reconcile(spent, 'USED')
      expect(await counters(m.id)).toEqual({ used: 2, reserved: 0, uncertain: 0 })

      const retry = await createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      ).reserve('REQUEST', 2)

      expect(retry?.id).not.toBe(spent.id)
      expect(await counters(m.id)).toEqual({ used: 2, reserved: 2, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(2)
    })

    it('a retry that asks a different amount for the same request is refused, not merged', async () => {
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const attemptId = nextTag()
      await createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      ).reserve('REQUEST', 2)
      const error = await rejection(
        createAccountMeter(db, binding({ accountKey: m.accountKey, cycleId, attemptId })).reserve(
          'REQUEST',
          3,
        ),
      )
      expect(error.code).toBe('AMOUNT_MISMATCH')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
    })
  })

  describe('SENT, timeout, UNCERTAIN, reconciliation (AC4)', () => {
    it('SENT then timeout -> UNCERTAIN, held; reconciliation converts it exactly once', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 3)
      if (r === null) throw new Error('setup: reservation refused')

      await meter.markSent(r)
      const sent = await reservationRow(r.id)
      expect(sent.status).toBe('SENT')
      expect(sent.sent_at).toBeInstanceOf(Date)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 3, uncertain: 0 })

      // The request timed out after it left: it may have been billed.
      await meter.reconcile(r, 'UNCERTAIN')
      expect((await reservationRow(r.id)).status).toBe('UNCERTAIN')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 3 })

      // Not released: an uncertain hold cannot be freed as if unsent.
      expect((await rejection(meter.reconcile(r, 'RELEASED'))).code).toBe('ILLEGAL_TRANSITION')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 3 })

      // The hold still blocks capacity: 10 - 3 = 7 left, so 8 is refused.
      expect(await meter.reserve('REQUEST', 8)).toBeNull()

      await meter.reconcile(r, 'USED')
      const used = await reservationRow(r.id)
      expect(used.status).toBe('USED')
      expect(used.used_amount).toBe(3)
      expect(used.settled_at).toBeInstanceOf(Date)
      expect(await counters(m.id)).toEqual({ used: 3, reserved: 0, uncertain: 0 })

      // Second reconcile: a no-op, proven by the counters staying exactly where they were.
      await meter.reconcile(r, 'USED')
      expect(await counters(m.id)).toEqual({ used: 3, reserved: 0, uncertain: 0 })
      expect((await reservationRow(r.id)).used_amount).toBe(3)
    })

    it('a failure in flight with no SENT mark still holds as UNCERTAIN (the loop path)', async () => {
      // The collection loop reconciles UNCERTAIN when fetch threw; the transport may never have
      // recorded SENT. The conservative direction is a hold, never a release.
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 2)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.reconcile(r, 'UNCERTAIN')
      const row = await reservationRow(r.id)
      expect(row.status).toBe('UNCERTAIN')
      expect(row.sent_at).toBeInstanceOf(Date)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 2 })
    })

    it('USED straight from RESERVED converts the reservation and stamps the send', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 4)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.reconcile(r, 'USED')
      const row = await reservationRow(r.id)
      expect(row).toMatchObject({ status: 'USED', used_amount: 4 })
      expect(row.sent_at).toBeInstanceOf(Date)
      expect(await counters(m.id)).toEqual({ used: 4, reserved: 0, uncertain: 0 })
    })

    it('markSent twice is a no-op; markSent after a release is refused', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 1)
      const released = await meter.reserve('REQUEST', 1)
      if (r === null || released === null) throw new Error('setup: reservation refused')
      await meter.markSent(r)
      const firstSentAt = (await reservationRow(r.id)).sent_at
      await meter.markSent(r)
      expect((await reservationRow(r.id)).sent_at).toEqual(firstSentAt)

      await meter.reconcile(released, 'RELEASED')
      expect((await rejection(meter.markSent(released))).code).toBe('ILLEGAL_TRANSITION')
      expect((await reservationRow(released.id)).sent_at).toBeNull()
    })

    it('a USED reservation cannot be downgraded or released afterwards', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 2)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.reconcile(r, 'USED')
      expect((await rejection(meter.reconcile(r, 'UNCERTAIN'))).code).toBe('ILLEGAL_TRANSITION')
      expect((await rejection(meter.reconcile(r, 'RELEASED'))).code).toBe('ILLEGAL_TRANSITION')
      expect(await counters(m.id)).toEqual({ used: 2, reserved: 0, uncertain: 0 })
    })
  })

  describe('release only provably unsent cost (AC5)', () => {
    it('an unsent release frees exactly the reserved amount', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const kept = await meter.reserve('REQUEST', 2)
      const freed = await meter.reserve('REQUEST', 5)
      if (kept === null || freed === null) throw new Error('setup: reservation refused')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 7, uncertain: 0 })

      await meter.reconcile(freed, 'RELEASED')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      const row = await reservationRow(freed.id)
      expect(row).toMatchObject({ status: 'RELEASED', used_amount: 0, sent_at: null })
      expect(row.settled_at).toBeInstanceOf(Date)

      // Releasing again is a no-op: the 2 still held by `kept` are not touched.
      await meter.reconcile(freed, 'RELEASED')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      // A released reservation can never turn into spend.
      expect((await rejection(meter.reconcile(freed, 'USED'))).code).toBe('ILLEGAL_TRANSITION')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
    })

    it('a release after SENT is refused and the reservation stays held', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 4)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.markSent(r)

      expect((await rejection(meter.reconcile(r, 'RELEASED'))).code).toBe('ILLEGAL_TRANSITION')
      expect((await reservationRow(r.id)).status).toBe('SENT')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 4, uncertain: 0 })
    })
  })

  describe('units never share a counter (AC6)', () => {
    it('a per-record unit and a per-request unit of one account are separate rows', async () => {
      // TheirStack-like: billed per returned record, with a separate request ceiling.
      const records = await newMeter({ unit: 'RECORD', window: 'MONTH', limit: 100 })
      const requests = await newMeter({
        accountKey: records.accountKey,
        unit: 'REQUEST',
        window: 'DAY',
        limit: 10,
      })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: records.accountKey,
          cycleId: await newCycle(),
          windows: { RECORD: 'MONTH', REQUEST: 'DAY' },
        }),
      )

      const rec = await meter.reserve('RECORD', 25)
      if (rec === null) throw new Error('setup: reservation refused')
      expect(rec).toMatchObject({ unit: 'RECORD', amount: 25 })
      expect(await counters(records.id)).toEqual({ used: 0, reserved: 25, uncertain: 0 })
      expect(await counters(requests.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })

      await meter.reconcile(rec, 'USED')
      expect(await counters(records.id)).toEqual({ used: 25, reserved: 0, uncertain: 0 })
      expect(await counters(requests.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })

      const req = await meter.reserve('REQUEST', 1)
      if (req === null) throw new Error('setup: reservation refused')
      await meter.reconcile(req, 'USED')
      expect(await counters(requests.id)).toEqual({ used: 1, reserved: 0, uncertain: 0 })
      expect(await counters(records.id)).toEqual({ used: 25, reserved: 0, uncertain: 0 })
    })

    it('a unit the binding does not meter is refused, never charged to another unit', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      expect((await rejection(meter.reserve('MODEL_CALL', 1))).code).toBe('UNIT_NOT_BOUND')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
    })

    it('a bound unit whose meter row does not exist is refused (never auto-created as unlimited)', async () => {
      const meter = createAccountMeter(
        db,
        binding({ accountKey: nextAccount(), cycleId: await newCycle() }),
      )
      expect((await rejection(meter.reserve('REQUEST', 1))).code).toBe('METER_NOT_FOUND')
    })
  })

  describe('window rollover (AC7)', () => {
    /**
     * Ends the meter's current DAY window one millisecond after its newest reservation, so that
     * everything reserved so far was taken in window W and the next operation runs in W+1. Done
     * in SQL against the stored instants, so client/server clock skew cannot blur the boundary.
     */
    async function endWindowAfterNewestReservation(meterId: string) {
      await q(
        `UPDATE job_account_meters
            SET resets_at = sub.t + interval '1 millisecond',
                window_started_at = sub.t + interval '1 millisecond' - interval '1 day'
           FROM (SELECT max(reserved_at) AS t FROM job_account_meter_reservations
                  WHERE meter_id = $1) sub
          WHERE id = $1`,
        [meterId],
      )
      await new Promise((r) => setTimeout(r, 20))
      const { rows } = await q(
        `SELECT window_started_at, resets_at FROM job_account_meters WHERE id = $1`,
        [meterId],
      )
      return rows[0] as { window_started_at: Date; resets_at: Date }
    }

    it('an outstanding reservation taken in W stays accounted to W after the reset', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )

      const outstanding = await meter.reserve('REQUEST', 2)
      const spentInW = await meter.reserve('REQUEST', 5)
      if (outstanding === null || spentInW === null) throw new Error('setup: reservation refused')
      await meter.reconcile(spentInW, 'USED')
      expect(await counters(m.id)).toEqual({ used: 5, reserved: 2, uncertain: 0 })

      const w = await endWindowAfterNewestReservation(m.id)

      // The first operation in W+1 rolls the window: W's spend leaves `used`, but W's outstanding
      // hold of 2 is still held (not dropped, not forgiven).
      const inNext = await meter.reserve('REQUEST', 1)
      if (inNext === null) throw new Error('setup: reservation refused')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 3, uncertain: 0 })
      const { rows } = await q(
        `SELECT window_started_at, resets_at FROM job_account_meters WHERE id = $1`,
        [m.id],
      )
      expect(rows[0].window_started_at).toEqual(w.resets_at)
      expect((rows[0].resets_at as Date).getTime() - w.resets_at.getTime()).toBe(86_400_000)

      // W's reservation settles AFTER the reset: its cost is W's, so it does NOT enter the new
      // window's `used`. Its own row records the spend.
      await meter.reconcile(outstanding, 'USED')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 1, uncertain: 0 })
      const settled = await reservationRow(outstanding.id)
      expect(settled).toMatchObject({ status: 'USED', used_amount: 2 })
      expect(settled.reserved_at.getTime()).toBeLessThan(w.resets_at.getTime())

      // W+1's own reservation does charge W+1.
      await meter.reconcile(inNext, 'USED')
      expect(await counters(m.id)).toEqual({ used: 1, reserved: 0, uncertain: 0 })
    })

    it('an uncertain hold from W survives the reset and is reconciled against W', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 3)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.markSent(r)
      await meter.reconcile(r, 'UNCERTAIN')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 3 })

      await endWindowAfterNewestReservation(m.id)

      // Room in W+1 is limit - held uncertainty: 7 fits exactly, 8 does not.
      expect(await meter.reserve('REQUEST', 8)).toBeNull()
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 3 })

      await meter.reconcile(r, 'USED')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({ status: 'USED', used_amount: 3 })
    })

    it('a reconcile can itself be the first operation of W+1 and still accounts to W', async () => {
      const m = await newMeter({ limit: 10, used: 4 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 2)
      if (r === null) throw new Error('setup: reservation refused')
      await endWindowAfterNewestReservation(m.id)

      await meter.reconcile(r, 'USED')
      // The reset zeroed W's 4; W's 2 was settled against W, so W+1 starts clean.
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
    })

    it('a LIFETIME meter never resets', async () => {
      const m = await newMeter({ window: 'LIFETIME', limit: 10, used: 4 })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: m.accountKey,
          cycleId: await newCycle(),
          windows: { REQUEST: 'LIFETIME' },
        }),
      )
      const r = await meter.reserve('REQUEST', 6)
      expect(r).not.toBeNull()
      expect(await counters(m.id)).toEqual({ used: 4, reserved: 6, uncertain: 0 })
    })
  })

  describe('a binding settles only its own reservations', () => {
    it("refuses to reconcile or mark another attempt's reservation", async () => {
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const owner = createAccountMeter(db, binding({ accountKey: m.accountKey, cycleId }))
      const stranger = createAccountMeter(db, binding({ accountKey: m.accountKey, cycleId }))
      const r = await owner.reserve('REQUEST', 3)
      if (r === null) throw new Error('setup: reservation refused')

      expect((await rejection(stranger.reconcile(r, 'RELEASED'))).code).toBe('FOREIGN_RESERVATION')
      expect((await rejection(stranger.markSent(r))).code).toBe('FOREIGN_RESERVATION')
      expect((await reservationRow(r.id)).status).toBe('RESERVED')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 3, uncertain: 0 })
    })

    it('refuses a reservation whose claimed unit is not its meter unit', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: m.accountKey,
          cycleId: await newCycle(),
          windows: { REQUEST: 'DAY', RECORD: 'DAY' },
        }),
      )
      const r = await meter.reserve('REQUEST', 3)
      if (r === null) throw new Error('setup: reservation refused')
      const forged = { ...r, unit: 'RECORD' as const }
      expect((await rejection(meter.reconcile(forged, 'USED'))).code).toBe('FOREIGN_RESERVATION')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 3, uncertain: 0 })
    })

    it('refuses an unknown reservation id', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const ghost = { id: randomUUID(), unit: 'REQUEST' as const, amount: 1 }
      expect((await rejection(meter.reconcile(ghost, 'USED'))).code).toBe('FOREIGN_RESERVATION')
    })

    it('the settled amount is the stored one, not the amount the caller claims', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 3)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.reconcile({ ...r, amount: 1 }, 'USED')
      expect(await counters(m.id)).toEqual({ used: 3, reserved: 0, uncertain: 0 })
    })
  })

  describe('binding to a run', () => {
    it('records the run and cycle on the reservation when bound to a run', async () => {
      const cycleId = await newCycle()
      const { rows: src } = await q(
        `INSERT INTO job_sources (type, config, config_version)
         VALUES ('DOU_RSS', jsonb_build_object('tag', $1::text), 1) RETURNING id`,
        [nextTag()],
      )
      const attemptId = nextTag()
      const { rows: run } = await q(
        `INSERT INTO job_collection_runs
           (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger,
            owner_token, lease_expires_at)
         VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED', $4, now() + interval '5 min') RETURNING id`,
        [src[0].id, cycleId, attemptId, `owner-${nextTag()}`],
      )
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId, runId: run[0].id as string }),
      )
      const r = await meter.reserve('REQUEST', 1)
      if (r === null) throw new Error('setup: reservation refused')
      const { rows } = await q(
        `SELECT run_id, cycle_id, attempt_id FROM job_account_meter_reservations WHERE id = $1`,
        [r.id],
      )
      expect(rows[0]).toEqual({
        run_id: run[0].id,
        cycle_id: cycleId,
        attempt_id: `${attemptId}#REQUEST#1`,
      })
    })
  })
})
