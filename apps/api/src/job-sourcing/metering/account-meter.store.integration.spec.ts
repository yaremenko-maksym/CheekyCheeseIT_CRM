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
 * MEASURED (security review of PR #1119): `pnpm --filter @crm/api db:push` EXITED 0 HAVING CREATED
 * 0 TABLES when `@crm/shared` was unbuilt (drizzle-kit could not resolve it). Build it first
 * (`pnpm --filter @crm/shared build`) and CHECK THE ARTEFACT, not the exit status: for example
 * `psql ... -Atc "select count(*) from information_schema.tables where table_schema='public'"`
 * must be non-zero before this spec means anything (`assertRealDbSchema` below also refuses).
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
  /** SQL expressions for the window bounds, for the rollover cases that need a DUE reset. */
  windowStartedAtSql?: string
  resetsAtSql?: string
}

async function newMeter(opts: MeterOpts = {}): Promise<{ id: string; accountKey: string }> {
  const accountKey = opts.accountKey ?? nextAccount()
  const window = opts.window ?? 'DAY'
  const lifetime = window === 'LIFETIME'
  // The bounds are either the default "current window, not yet due" pair or caller SQL. Both are
  // fixed strings from this file, never a value, so nothing interpolated here is input. They are
  // evaluated by the DATABASE, which is the clock the store itself reads.
  const startedAt = lifetime ? 'NULL' : (opts.windowStartedAtSql ?? "now() - interval '1 minute'")
  const resetsAt = lifetime ? 'NULL' : (opts.resetsAtSql ?? "now() + interval '23 hours'")
  const { rows } = await q(
    `INSERT INTO job_account_meters
       (account_key, unit, window_kind, limit_amount, used, uncertain, window_started_at, resets_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${startedAt}, ${resetsAt}) RETURNING id`,
    [
      accountKey,
      opts.unit ?? 'REQUEST',
      window,
      opts.limit === undefined ? null : opts.limit,
      opts.used ?? 0,
      opts.uncertain ?? 0,
    ],
  )
  return { id: rows[0].id as string, accountKey }
}

interface Counters {
  used: number
  reserved: number
  uncertain: number
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

/**
 * True when `d` is midnight UTC on the final day of its own month. Written from the calendar
 * (day 0 of the next month is the last day of this one) rather than with the helper under test.
 */
function isUtcMonthEndMidnight(d: Date): boolean {
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  return (
    d.getUTCDate() === lastDay &&
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  )
}

const monthsBetweenUtc = (from: Date, to: Date) =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())

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
      // Far more than any real limit, and still accepted, because there is no limit to compare
      // against. The amount stays under the per-unit sanity ceiling below, which is a separate
      // guard: "no published limit" is not "no bound on a single cost estimate".
      expect(await meter.reserve('REQUEST', 10_000)).not.toBeNull()
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 10_000, uncertain: 0 })
    })

    /**
     * SR-M-2, as the security review measured it (ADV-6): against a NULL-limit meter the only
     * amount validation was `Number.isSafeInteger && > 0`, so `Number.MAX_SAFE_INTEGER` was
     * accepted and the row came to read `reserved = 9007199254740991`. On a USD_MICROS meter that
     * is nine billion dollars of held spend from one bad cost estimate — silent, and unreachable
     * for correction, since the counters are read back as JS numbers and a second such
     * reservation leaves the representable range before the bigint column objects.
     *
     * This is the probe re-run end to end: it must now refuse, and the row must not move.
     */
    it('an unlimited meter still refuses MAX_SAFE_INTEGER, and the counters do not move', async () => {
      const m = await newMeter({ limit: null, unit: 'USD_MICROS' })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: m.accountKey,
          cycleId: await newCycle(),
          windows: { USD_MICROS: 'DAY' },
        }),
      )
      const error = await rejection(meter.reserve('USD_MICROS', Number.MAX_SAFE_INTEGER))
      expect(error.code).toBe('INVALID_AMOUNT')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(0)

      // The bound itself, on the same unlimited meter: at the ceiling accepted, one past refused.
      expect(await meter.reserve('USD_MICROS', 1_000_000_000)).not.toBeNull()
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 1_000_000_000, uncertain: 0 })
      expect((await rejection(meter.reserve('USD_MICROS', 1_000_000_001))).code).toBe(
        'INVALID_AMOUNT',
      )
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 1_000_000_000, uncertain: 0 })
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

    /**
     * CR-H-1 — the replay walk, pinned for EVERY first state rather than only for `USED`.
     *
     * The invariant in the module header is: a key whose request already left (SENT / UNCERTAIN /
     * USED) or was released is SKIPPED, and only a still-RESERVED key is handed back. Before this
     * block only the `USED` case was covered, so three mutations of the condition survived the
     * whole suite — `status !== 'USED'`, and adding `SENT` or `UNCERTAIN` to the reuse branch.
     * Each of those hands a retry a reservation whose request already left, so the retry sends a
     * SECOND paid request against a single hold: one charge, two real requests.
     *
     * Every case asserts the post-state counter VALUES, not that the call succeeded: a retry that
     * returned a fresh id while silently leaving the counters wrong would pass an id-only check.
     */
    interface DepartedCase {
      state: 'SENT' | 'UNCERTAIN' | 'RELEASED' | 'USED'
      settle: (
        meter: ReturnType<typeof createAccountMeter>,
        reservation: { id: string; unit: JobMeterUnit; amount: number },
      ) => Promise<void>
      /** Counters after the FIRST reservation reached that state. */
      after: Counters
      /** Counters after the retry — hand-written per state, not derived from `after`. */
      afterRetry: Counters
    }

    const departed: DepartedCase[] = [
      {
        state: 'SENT',
        // The hold stays in `reserved` (the request left but has not settled): 2 held + 2 new.
        settle: (m, r) => m.markSent(r),
        after: { used: 0, reserved: 2, uncertain: 0 },
        afterRetry: { used: 0, reserved: 4, uncertain: 0 },
      },
      {
        state: 'UNCERTAIN',
        settle: (m, r) => m.reconcile(r, 'UNCERTAIN'),
        after: { used: 0, reserved: 0, uncertain: 2 },
        afterRetry: { used: 0, reserved: 2, uncertain: 2 },
      },
      {
        state: 'RELEASED',
        settle: (m, r) => m.reconcile(r, 'RELEASED'),
        after: { used: 0, reserved: 0, uncertain: 0 },
        afterRetry: { used: 0, reserved: 2, uncertain: 0 },
      },
      {
        state: 'USED',
        settle: (m, r) => m.reconcile(r, 'USED'),
        after: { used: 2, reserved: 0, uncertain: 0 },
        afterRetry: { used: 2, reserved: 2, uncertain: 0 },
      },
    ]

    it.each(departed)(
      'a retry does NOT reuse a reservation left in $state: it reserves anew',
      async ({ state, settle, after, afterRetry }) => {
        const m = await newMeter({ limit: 10 })
        const cycleId = await newCycle()
        const attemptId = nextTag()
        const firstRun = createAccountMeter(
          db,
          binding({ accountKey: m.accountKey, cycleId, attemptId }),
        )
        const first = await firstRun.reserve('REQUEST', 2)
        if (first === null) throw new Error('setup: reservation refused')
        await settle(firstRun, first)
        expect(await reservationRow(first.id)).toMatchObject({ status: state })
        expect(await counters(m.id)).toEqual(after)

        // A fresh binding of the SAME attempt — a retry with nothing in memory.
        const retry = await createAccountMeter(
          db,
          binding({ accountKey: m.accountKey, cycleId, attemptId }),
        ).reserve('REQUEST', 2)

        expect(retry).not.toBeNull()
        expect(retry?.id).not.toBe(first.id)
        expect(await counters(m.id)).toEqual(afterRetry)
        expect(await reservationCount(m.id)).toBe(2)
        // The departed reservation is untouched by the retry — it keeps its own state and cost.
        expect(await reservationRow(first.id)).toMatchObject({ status: state, amount: 2 })
      },
    )

    /**
     * SR-H-1 — A CHARACTERISATION TEST OF THE UNENFORCED PRECONDITION, not an endorsement of it.
     *
     * The store's reuse rule reads a RESERVED row as "the request never left". That is only true
     * if the executor which took the row is gone, and the store has no evidence of that. This
     * case reproduces the security review's ADV-3 probe: two LIVE bindings carrying one
     * `attemptId` (separate objects = separate processes, so the per-process `nextOrdinal` map
     * does not separate them) receive ONE reservation between them, and when both really send,
     * the account pays twice and the meter records once.
     *
     * It is asserted rather than described because a comment stating a hazard is not a
     * measurement: anyone who later makes the store distinguish two executors will see THIS test
     * fail, which is the signal to delete it and assert the fix. Until then it is the honest
     * statement of what the store does, and the reason the docblock carries the precondition "at
     * most one live executor per attemptId" as a CALLER obligation.
     *
     * The repository cannot fix it inside this file today: the distinguishing fact would have to
     * arrive through `CollectionContext.run`, which carries no owner token, and whose
     * `fencingEpoch` is never written by any code here (schema default 1, lease recovery of plan
     * Task 2.5 unimplemented) — so folding the epoch into the reservation key separates nothing.
     * Owned by BACKLOG-followups 308.
     */
    it('TWO live executors of one attempt SHARE a reservation — the precondition, measured', async () => {
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const attemptId = nextTag()
      const workerA = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      )
      const workerB = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      )

      const a = await workerA.reserve('REQUEST', 2)
      const b = await workerB.reserve('REQUEST', 2)
      if (a === null || b === null) throw new Error('setup: reservation refused')

      // One hold between the two of them, for what will be two real requests.
      expect(b.id).toBe(a.id)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(1)

      // Both send for real and both settle. The second settle is a SILENT no-op, so worker B
      // believes it was charged.
      await workerA.reconcile(a, 'USED')
      await workerB.reconcile(b, 'USED')

      // 4 units left the account; 2 are on the meter. This is the overspend direction.
      expect(await counters(m.id)).toEqual({ used: 2, reserved: 0, uncertain: 0 })
      expect(await reservationRow(a.id)).toMatchObject({ status: 'USED', used_amount: 2 })
    })

    /**
     * R2-CR-M-3 — the ordinal must advance on the REUSE branch too, not only after a fresh
     * reservation. Setting it to `ordinal` instead of `ordinal + 1` there survived every test:
     * `repeated paid requests in ONE attempt get distinct reservations` starts from a fresh
     * binding, so the reuse branch never runs before its second request.
     *
     * What the mutant costs: a retry binding reuses the reservation it inherited (correct), and
     * then its SECOND paid request replays from the same ordinal, finds that same row still
     * RESERVED, and is handed it again. Two paid requests against one hold — the SR-H-1 outcome
     * reached by a different route, except that this one needs no second executor and is entirely
     * inside this file.
     */
    it('after a reuse, the SAME binding second paid request still gets its own reservation', async () => {
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const attemptId = nextTag()

      const first = await createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      ).reserve('REQUEST', 2)
      if (first === null) throw new Error('setup: reservation refused')

      // The retry binding: it reuses what the first executor left behind ...
      const retry = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      )
      const reused = await retry.reserve('REQUEST', 2)
      expect(reused).toEqual(first)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(1)

      // ... and its NEXT paid request is a second charge, so it must hold its own cost.
      const second = await retry.reserve('REQUEST', 2)
      expect(second).not.toBeNull()
      expect(second?.id).not.toBe(first.id)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 4, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(2)

      // A third, to pin that the ordinal keeps advancing rather than alternating.
      const third = await retry.reserve('REQUEST', 2)
      expect(new Set([first.id, second?.id, third?.id]).size).toBe(3)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 6, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(3)
    })

    it('the positive control: a still-RESERVED key IS reused and nothing moves', async () => {
      const m = await newMeter({ limit: 10 })
      const cycleId = await newCycle()
      const attemptId = nextTag()
      const first = await createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      ).reserve('REQUEST', 2)
      if (first === null) throw new Error('setup: reservation refused')

      const retry = await createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId, attemptId }),
      ).reserve('REQUEST', 2)

      expect(retry).toEqual(first)
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      expect(await reservationCount(m.id)).toBe(1)
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
      // Both amounts, in the message: this refusal crashes a retry whose cost estimate changed
      // (a varying page size will do it), and the only way to tell WHICH two numbers disagreed
      // is this sentence. Written out rather than built from the inputs.
      expect(error.message).toBe('a retry asked 3 for a request reserved at 2')
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

    /**
     * M11, reported as a surviving mutant by the code review and not covered by any case:
     * settling writes `sent_at` as `row.sentAt ?? now()`, and replacing that with a plain `now()`
     * left every suite green. The instant a request LEFT is provenance — it is what a later
     * reconciliation against a provider's own log is matched on — so a settle must not overwrite
     * it with the settle time. Asserted by the VALUE of the timestamp, not by its presence, since
     * presence is exactly what the mutant preserves.
     */
    it('settling preserves the original send instant, it does not restamp it', async () => {
      const m = await newMeter({ limit: 10 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey: m.accountKey, cycleId: await newCycle() }),
      )
      const r = await meter.reserve('REQUEST', 4)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.markSent(r)
      const sentAt = (await reservationRow(r.id)).sent_at
      expect(sentAt).toBeInstanceOf(Date)

      // A measurable gap, so "preserved" and "restamped" cannot be the same instant.
      await new Promise((resolve) => setTimeout(resolve, 50))
      await meter.reconcile(r, 'USED')

      const settled = await reservationRow(r.id)
      expect(settled.sent_at).toEqual(sentAt)
      expect(settled.settled_at).toBeInstanceOf(Date)
      expect(settled.settled_at!.getTime()).toBeGreaterThan(sentAt!.getTime())
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
      const toUncertain = await rejection(meter.reconcile(r, 'UNCERTAIN'))
      const toReleased = await rejection(meter.reconcile(r, 'RELEASED'))
      expect(toUncertain.code).toBe('ILLEGAL_TRANSITION')
      expect(toReleased.code).toBe('ILLEGAL_TRANSITION')
      /**
       * The MESSAGE, not only the code. This is the refusal an operator meets while money is
       * stuck on a reservation that will not settle, and the only thing that tells them which
       * transition was refused is this sentence — so both states have to be in it. The literal
       * survived the mutation gate because no case read it. Written out here rather than built
       * from the inputs, so a message that stops naming the states fails.
       */
      expect(toUncertain.message).toBe('a USED reservation cannot become UNCERTAIN')
      expect(toReleased.message).toBe('a USED reservation cannot become RELEASED')
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

    /**
     * CR-M-3 — the meter key is (account, unit, WINDOW), and until this case every test had
     * exactly one row per (account, unit), so dropping `eq(window)` from either lookup left the
     * whole suite green. A daily-plus-monthly cap on one unit is the normal shape of a paid
     * quota; with the predicate gone the store locks whichever row Postgres returns first and
     * charges the wrong counter — the account's monthly spend lands on the daily cap or the
     * reverse, and the cap that was not charged over-admits.
     */
    it('charges the bound window only: DAY, MONTH and LIFETIME rows of ONE unit do not mix', async () => {
      const accountKey = nextAccount()
      const day = await newMeter({ accountKey, unit: 'REQUEST', window: 'DAY', limit: 10 })
      const month = await newMeter({ accountKey, unit: 'REQUEST', window: 'MONTH', limit: 100 })
      const lifetime = await newMeter({
        accountKey,
        unit: 'REQUEST',
        window: 'LIFETIME',
        limit: 1_000,
      })
      expect(new Set([day.id, month.id, lifetime.id]).size).toBe(3)

      const meter = createAccountMeter(
        db,
        binding({ accountKey, cycleId: await newCycle(), windows: { REQUEST: 'MONTH' } }),
      )
      const r = await meter.reserve('REQUEST', 7)
      if (r === null) throw new Error('setup: reservation refused')

      // Only the MONTH row moved, by the exact amount.
      expect(await counters(month.id)).toEqual({ used: 0, reserved: 7, uncertain: 0 })
      expect(await counters(day.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await counters(lifetime.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({ meter_id: month.id })

      // Settlement follows the same key: the reservation converts on MONTH and nowhere else.
      await meter.reconcile(r, 'USED')
      expect(await counters(month.id)).toEqual({ used: 7, reserved: 0, uncertain: 0 })
      expect(await counters(day.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await counters(lifetime.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
    })

    /**
     * The other direction of the same key: the DAY cap of the same unit is the one that refuses
     * when it is the bound one, even though the MONTH row has plenty of room.
     */
    it('a binding bound to DAY is refused by the DAY limit while MONTH still has room', async () => {
      const accountKey = nextAccount()
      const day = await newMeter({ accountKey, unit: 'REQUEST', window: 'DAY', limit: 3 })
      const month = await newMeter({ accountKey, unit: 'REQUEST', window: 'MONTH', limit: 100 })
      const meter = createAccountMeter(
        db,
        binding({ accountKey, cycleId: await newCycle(), windows: { REQUEST: 'DAY' } }),
      )
      expect(await meter.reserve('REQUEST', 3)).not.toBeNull()
      expect(await meter.reserve('REQUEST', 1)).toBeNull()
      expect(await counters(day.id)).toEqual({ used: 0, reserved: 3, uncertain: 0 })
      expect(await counters(month.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
    })

    it('a bound unit whose meter row does not exist is refused (never auto-created as unlimited)', async () => {
      const meter = createAccountMeter(
        db,
        binding({ accountKey: nextAccount(), cycleId: await newCycle() }),
      )
      const error = await rejection(meter.reserve('REQUEST', 1))
      expect(error.code).toBe('METER_NOT_FOUND')
      // The message names all three parts of the meter key, because a missing row is a
      // CONFIGURATION error and the reader has to know which of the three to go and create.
      expect(error.message).toBe('no meter row exists for this account, unit and window')
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

    /**
     * CR-M-2 — a MONTH row through the database. Every rollover case above uses a DAY window, so
     * the monthly arithmetic reached Postgres in no test at all: the `window_kind = 'MONTH'`
     * branch of `rollWindow` was exercised only as a pure function.
     *
     * The meter is anchored on the last day of the PREVIOUS month, which is the anchor shape that
     * cannot survive February as a day number, and the one CR-M-1 is about. Bounds are derived in
     * SQL from the database clock, so the case is not pinned to a particular calendar date; what
     * it asserts is the PROPERTY that used to break — the window the store lands on is a
     * month-end window containing `now`, not a window that drifted earlier into the month.
     */
    it('a MONTH window rolls to the next month-end window, keeping outstanding holds', async () => {
      const monthEndOfPreviousMonth =
        "(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 day') AT TIME ZONE 'UTC'"
      const m = await newMeter({
        unit: 'REQUEST',
        window: 'MONTH',
        limit: 100,
        used: 40,
        windowStartedAtSql: `(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month' - interval '1 day') AT TIME ZONE 'UTC'`,
        resetsAtSql: monthEndOfPreviousMonth,
      })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: m.accountKey,
          cycleId: await newCycle(),
          windows: { REQUEST: 'MONTH' },
        }),
      )

      // A reservation taken BEFORE the roll would belong to the old window; the reset is due, so
      // this very call rolls it. `used` from the old window goes, the new hold is the new one's.
      const held = await meter.reserve('REQUEST', 6)
      if (held === null) throw new Error('setup: reservation refused')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 6, uncertain: 0 })

      const { rows } = await q(
        `SELECT window_started_at, resets_at, now() AS db_now FROM job_account_meters WHERE id = $1`,
        [m.id],
      )
      const {
        window_started_at: start,
        resets_at: reset,
        db_now: dbNow,
      } = rows[0] as {
        window_started_at: Date
        resets_at: Date
        db_now: Date
      }

      // The window contains now: it has started, and it has not expired.
      expect(start.getTime()).toBeLessThanOrEqual(dbNow.getTime())
      expect(reset.getTime()).toBeGreaterThan(dbNow.getTime())
      // Both bounds are month ends at midnight UTC — the anchor was NOT lost to a 28th.
      expect(isUtcMonthEndMidnight(start)).toBe(true)
      expect(isUtcMonthEndMidnight(reset)).toBe(true)
      // ... and they are one calendar month apart.
      expect(monthsBetweenUtc(start, reset)).toBe(1)

      // The hold taken in the new window settles into the new window's `used`.
      await meter.reconcile(held, 'USED')
      expect(await counters(m.id)).toEqual({ used: 6, reserved: 0, uncertain: 0 })
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

    /**
     * R2-CR-M-4 / R3-SR-M-1 — CROSS-ACCOUNT settlement. The shipped code is correct and
     * `accountKey` in the meter lookup of `lockOwned` is the ONLY predicate that refuses this;
     * drop it and both cases below pass. So this pins behaviour rather than changing it.
     *
     * Why the round-1 ownership proof missed it: `lockOwned` carries a SECOND ownership
     * predicate, `starts_with(attempt_id, '<attemptId>#<unit>#')`. A naive cross-account probe is
     * refused by THAT one and proves nothing about accounts, which is how seven crafted attempt
     * ids could all be refused while this stayed untested. Two conditions are therefore
     * load-bearing in the setup, and the case is worthless without either:
     *
     *   1. both accounts share ONE `attemptId`, same unit, same window — the schema permits it
     *      (meters are unique on (account_key, unit, window_kind), reservations on
     *      (meter_id, attempt_id)), and it is the only arrangement that leaves `accountKey` as
     *      the deciding predicate;
     *   2. the foreign reservation is still RESERVED — aim at a settled row and the refusal comes
     *      from the exactly-once state guard as ILLEGAL_TRANSITION, not from ownership.
     *
     * And the thrown error is NOT the assertion: under the mutant the call SUCCEEDS, so what is
     * read is the victim's three counters by value, before and after.
     *
     * Not hypothetical. The production trigger is ACCOUNT FAILOVER: retrying one attempt against
     * a second credential for the same source puts one `attemptId` on two accounts. It is
     * unreachable today only because `createAccountMeter` has no production caller, and it
     * becomes load-bearing the moment a source has a second account.
     */
    it("refuses to settle ANOTHER ACCOUNT's reservation as USED, and charges nobody", async () => {
      const cycleId = await newCycle()
      const attemptId = nextTag() // ONE attempt id, deliberately shared by both accounts
      const a = await newMeter({ limit: 10 })
      const b = await newMeter({ limit: 10 })
      expect(a.accountKey).not.toBe(b.accountKey)

      const onA = createAccountMeter(db, binding({ accountKey: a.accountKey, cycleId, attemptId }))
      const onB = createAccountMeter(db, binding({ accountKey: b.accountKey, cycleId, attemptId }))
      const mine = await onA.reserve('REQUEST', 2)
      const theirs = await onB.reserve('REQUEST', 7)
      if (mine === null || theirs === null) throw new Error('setup: reservation refused')
      expect(await counters(a.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      expect(await counters(b.id)).toEqual({ used: 0, reserved: 7, uncertain: 0 })

      // A, holding a reservation of its own under the same attempt id, aims at B's.
      expect((await rejection(onA.reconcile(theirs, 'USED'))).code).toBe('FOREIGN_RESERVATION')

      // Neither row moved. Under the mutant B reads { used: 7, reserved: 0, uncertain: 0 }.
      expect(await counters(b.id)).toEqual({ used: 0, reserved: 7, uncertain: 0 })
      expect(await counters(a.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })
      expect(await reservationRow(theirs.id)).toMatchObject({ status: 'RESERVED', amount: 7 })
    })

    /**
     * The RELEASED direction, which is the one with money in it: releasing another account's hold
     * defeats the victim's capacity guard outright. Measured by the security reviewer with the
     * filter removed — B, limit 10, holding 9 of its own, had its hold zeroed by A and could then
     * reserve 9 again, so up to 18 units could be in flight against a limit of 10 on a paid
     * third-party quota.
     */
    it("refuses to RELEASE another account's hold, so the victim capacity guard still holds", async () => {
      const cycleId = await newCycle()
      const attemptId = nextTag()
      const a = await newMeter({ limit: 10 })
      const b = await newMeter({ limit: 10 })

      const onA = createAccountMeter(db, binding({ accountKey: a.accountKey, cycleId, attemptId }))
      const onB = createAccountMeter(db, binding({ accountKey: b.accountKey, cycleId, attemptId }))
      if ((await onA.reserve('REQUEST', 2)) === null) throw new Error('setup: refused')
      const theirs = await onB.reserve('REQUEST', 9)
      if (theirs === null) throw new Error('setup: reservation refused')
      expect(await counters(b.id)).toEqual({ used: 0, reserved: 9, uncertain: 0 })

      // B is at its limit: its own next request is a cost stop, not an error.
      expect(await onB.reserve('REQUEST', 2)).toBeNull()

      expect((await rejection(onA.reconcile(theirs, 'RELEASED'))).code).toBe('FOREIGN_RESERVATION')
      expect(await counters(b.id)).toEqual({ used: 0, reserved: 9, uncertain: 0 })
      expect(await counters(a.id)).toEqual({ used: 0, reserved: 2, uncertain: 0 })

      // The guard is still a guard: with the hold intact, B's next request is refused again.
      // Under the mutant B's counters are all zero here and this reserve of 9 is GRANTED.
      expect(await onB.reserve('REQUEST', 9)).toBeNull()
      expect(await counters(b.id)).toEqual({ used: 0, reserved: 9, uncertain: 0 })
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

  /**
   * Task 3.5b, inherited item 2: `reconcile` settles at the cost actually INCURRED, bounded by the
   * reservation. The first use is TheirStack (credits per returned record): a 50-record worst case
   * that returned 7 records must leave `used = 7`, not 50. Every figure below is hand-counted and
   * asserted as a counter VALUE read back with plain SQL.
   */
  describe('settling at the cost actually incurred (3.5b)', () => {
    async function recordMeter(limit: number | null = 100) {
      const m = await newMeter({ unit: 'RECORD', limit })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: m.accountKey,
          cycleId: await newCycle(),
          windows: { RECORD: 'DAY' },
        }),
      )
      return { m, meter }
    }

    it('converts only the incurred cost and frees the rest of the reservation', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.markSent(r)

      await meter.reconcile(r, 'USED', 7)

      expect(await counters(m.id)).toEqual({ used: 7, reserved: 0, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({
        status: 'USED',
        amount: 50,
        used_amount: 7,
      })
      // The 43 unused records are capacity again: 100 - 7 = 93 fits exactly, 94 does not.
      expect(await meter.reserve('RECORD', 94)).toBeNull()
      expect(await meter.reserve('RECORD', 93)).not.toBeNull()
    })

    it('the smallest cost is 1: a USED reservation cannot record nothing', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')

      // 0 is refused (the table's `used_settled` CHECK would reject the row) and the reservation
      // is untouched; 1 is the floor and is accepted.
      const refusal = await rejection(meter.reconcile(r, 'USED', 0))
      expect(refusal.code).toBe('INVALID_AMOUNT')
      expect(refusal.message).toBe('the incurred cost must be a whole number of units, at least 1')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 50, uncertain: 0 })

      await meter.reconcile(r, 'USED', 1)
      expect(await counters(m.id)).toEqual({ used: 1, reserved: 0, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({ status: 'USED', used_amount: 1 })
    })

    it('AT the reservation (50 of 50) converts all of it', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')

      await meter.reconcile(r, 'USED', 50)

      expect(await counters(m.id)).toEqual({ used: 50, reserved: 0, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({ status: 'USED', used_amount: 50 })
    })

    it('PAST the reservation (51 of 50) is refused, nothing moves, and a correct settle still works', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')

      const refusal = await rejection(meter.reconcile(r, 'USED', 51))

      expect(refusal.code).toBe('AMOUNT_MISMATCH')
      expect(refusal.message).toBe('the incurred cost 51 exceeds the reserved 50')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 50, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({ status: 'RESERVED', used_amount: 0 })

      await meter.reconcile(r, 'USED', 50)
      expect(await counters(m.id)).toEqual({ used: 50, reserved: 0, uncertain: 0 })
    })

    it('exactly once: repeating the same settlement is a no-op', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')

      await meter.reconcile(r, 'USED', 7)
      await meter.reconcile(r, 'USED', 7)

      expect(await counters(m.id)).toEqual({ used: 7, reserved: 0, uncertain: 0 })
      expect((await reservationRow(r.id)).used_amount).toBe(7)
    })

    it('exactly once: a second settlement that DISAGREES is refused, the first stands', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.reconcile(r, 'USED', 7)

      const lower = await rejection(meter.reconcile(r, 'USED', 3))
      const higher = await rejection(meter.reconcile(r, 'USED', 50))

      expect(lower.code).toBe('AMOUNT_MISMATCH')
      expect(lower.message).toBe('the reservation already settled at 7, not 3')
      expect(higher.code).toBe('AMOUNT_MISMATCH')
      expect(await counters(m.id)).toEqual({ used: 7, reserved: 0, uncertain: 0 })
      expect((await reservationRow(r.id)).used_amount).toBe(7)
    })

    it('exactly once: a later settle that reports no amount does not re-charge the worst case', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.reconcile(r, 'USED', 7)

      await meter.reconcile(r, 'USED')

      expect(await counters(m.id)).toEqual({ used: 7, reserved: 0, uncertain: 0 })
    })

    it('exactly once under concurrency: N simultaneous settlements convert the cost once', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => meter.reconcile(r, 'USED', 7)),
      )

      expect(results.every((x) => x.status === 'fulfilled')).toBe(true)
      expect(await counters(m.id)).toEqual({ used: 7, reserved: 0, uncertain: 0 })
    })

    it('an uncertain hold reconciles at the incurred cost and frees the whole hold', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.markSent(r)
      await meter.reconcile(r, 'UNCERTAIN')
      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 50 })

      await meter.reconcile(r, 'USED', 12)

      expect(await counters(m.id)).toEqual({ used: 12, reserved: 0, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({ status: 'USED', used_amount: 12 })
    })

    it('PAST the reservation is refused from an uncertain hold too, and the hold stays', async () => {
      const { m, meter } = await recordMeter(100)
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')
      await meter.reconcile(r, 'UNCERTAIN')

      expect((await rejection(meter.reconcile(r, 'USED', 51))).code).toBe('AMOUNT_MISMATCH')

      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 50 })
    })

    it.each(['UNCERTAIN', 'RELEASED'] as const)(
      'refuses an incurred cost on a %s settlement: there is no known cost to report',
      async (resolution) => {
        const { m, meter } = await recordMeter(100)
        const r = await meter.reserve('RECORD', 50)
        if (r === null) throw new Error('setup: reservation refused')

        const refusal = await rejection(meter.reconcile(r, resolution, 7))

        expect(refusal.code).toBe('INVALID_AMOUNT')
        expect(refusal.message).toBe(
          `an incurred cost belongs to a USED settlement, not ${resolution}`,
        )
        expect(await counters(m.id)).toEqual({ used: 0, reserved: 50, uncertain: 0 })
      },
    )

    it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      'refuses the incurred cost %s before touching the meter',
      async (bad) => {
        const { m, meter } = await recordMeter(100)
        const r = await meter.reserve('RECORD', 50)
        if (r === null) throw new Error('setup: reservation refused')

        const refusal = await rejection(meter.reconcile(r, 'USED', bad))

        expect(refusal.code).toBe('INVALID_AMOUNT')
        expect(await counters(m.id)).toEqual({ used: 0, reserved: 50, uncertain: 0 })
      },
    )

    it('a reservation taken in W and settled in W+1 frees its hold but charges W+1 nothing', async () => {
      const m = await newMeter({ unit: 'RECORD', window: 'DAY', limit: 100 })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: m.accountKey,
          cycleId: await newCycle(),
          windows: { RECORD: 'DAY' },
        }),
      )
      const r = await meter.reserve('RECORD', 50)
      if (r === null) throw new Error('setup: reservation refused')
      await q(
        `UPDATE job_account_meters
            SET resets_at = sub.t + interval '1 millisecond',
                window_started_at = sub.t + interval '1 millisecond' - interval '1 day'
           FROM (SELECT max(reserved_at) AS t FROM job_account_meter_reservations
                  WHERE meter_id = $1) sub
          WHERE id = $1`,
        [m.id],
      )
      await new Promise((resolve) => setTimeout(resolve, 20))

      await meter.reconcile(r, 'USED', 7)

      expect(await counters(m.id)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await reservationRow(r.id)).toMatchObject({ status: 'USED', used_amount: 7 })
    })

    it('a USD_MICROS meter records the money actually billed, not the worst case', async () => {
      const m = await newMeter({ unit: 'USD_MICROS', limit: 10_000_000 })
      const meter = createAccountMeter(
        db,
        binding({
          accountKey: m.accountKey,
          cycleId: await newCycle(),
          windows: { USD_MICROS: 'DAY' },
        }),
      )
      const r = await meter.reserve('USD_MICROS', 5_000_000)
      if (r === null) throw new Error('setup: reservation refused')

      await meter.reconcile(r, 'USED', 1_234_567)

      expect(await counters(m.id)).toEqual({ used: 1_234_567, reserved: 0, uncertain: 0 })
      expect((await reservationRow(r.id)).used_amount).toBe(1_234_567)
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
            owner_token, lease_expires_at, account_key)
         VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED', $4, now() + interval '5 min', '#source:' || $1::uuid::text) RETURNING id`,
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
