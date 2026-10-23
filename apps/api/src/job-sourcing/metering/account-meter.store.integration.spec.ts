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
    `SELECT used::int AS used, reserved::int AS reserved, uncertain::int AS uncertain
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

        // Bounded wait (5 s) until all N are blocked on a lock in this database.
        const deadline = Date.now() + 5_000
        let waiting = 0
        while (Date.now() < deadline) {
          const { rows } = await blocker.query(
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

  // CASES-BELOW
})
