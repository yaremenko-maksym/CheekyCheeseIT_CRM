import { randomUUID } from 'node:crypto'
import type { JobMeterUnit, JobMeterWindow } from '@crm/shared'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../../../database/schema'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { assertRealDbSchema, hasDatabaseUrl } from '../../../test/require-real-db'
import { type AccountMeterBinding, createAccountMeter } from '../../metering/account-meter.store'
import { createJoobleProvider } from './jooble.provider'
import { createJSearchProvider } from './jsearch.provider'
import { createTheirStackProvider } from './theirstack.provider'

/**
 * r5 Task 3.5b - the quota adapters against the REAL shared account-meter store (Postgres).
 *
 * The adapter specs record what the loop asks of a meter; this one asserts what the meter ends up
 * HOLDING: the counters read back with plain SQL after a run, hand-counted, for each claim of the
 * task that is about money - records versus calls on different units, the worst-case reservation
 * and its reconciliation, a spent budget, a repeated paid request, an uncertain hold across a
 * window rollover, and three queries drawing on one account.
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run src/job-sourcing/providers/sources/quota-adapters.metering
 */

const TAG = `q35b-${randomUUID().slice(0, 8)}`
const NOW = new Date('2026-10-24T04:00:00Z')
const KEY = 'fake0000integration0000key0000'
const READY = { configured: true, apiKey: KEY, secrets: [KEY] } as const

let pool: Pool
let db: NodePgDatabase<typeof schema>
const q = (text: string, params: unknown[] = []) => pool.query(text, params)

let seq = 0
const nextTag = () => `${TAG}-${(seq += 1)}`
/** A per-test account key that satisfies the account-key CHECKs (short, segmented, lowercase). */
const nextAccount = () => `${TAG}:acct-${(seq += 1)}`

async function newCycle(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [nextTag()],
  )
  return rows[0].id as string
}

async function newMeter(opts: {
  accountKey: string
  unit: JobMeterUnit
  window?: JobMeterWindow
  limit?: number | null
  used?: number
}): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_account_meters
       (account_key, unit, window_kind, limit_amount, used, window_started_at, resets_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '23 hours') RETURNING id`,
    [opts.accountKey, opts.unit, opts.window ?? 'DAY', opts.limit ?? null, opts.used ?? 0],
  )
  return rows[0].id as string
}

const counters = async (meterId: string) =>
  (
    await q(
      `SELECT used::float8 AS used, reserved::float8 AS reserved, uncertain::float8 AS uncertain
         FROM job_account_meters WHERE id = $1`,
      [meterId],
    )
  ).rows[0] as { used: number; reserved: number; uncertain: number }

const reservations = async (meterId: string) =>
  (
    await q(
      `SELECT status, amount::int AS amount, used_amount::int AS used_amount, attempt_id,
              sent_at IS NOT NULL AS sent
         FROM job_account_meter_reservations WHERE meter_id = $1 ORDER BY attempt_id`,
      [meterId],
    )
  ).rows as Array<{
    status: string
    amount: number
    used_amount: number
    attempt_id: string
    sent: boolean
  }>

/** A fake-context run whose meter is the real store, bound to `accountKey` for `unit`. */
async function metered(
  accountKey: string,
  unit: JobMeterUnit,
  responses: FakeResponse[],
  attemptId = nextTag(),
) {
  const binding: AccountMeterBinding = {
    accountKey,
    windows: { [unit]: 'DAY' },
    attemptId,
    cycleId: await newCycle(),
    runId: null,
  }
  const f = fakeCollectionContext({ now: NOW, responses })
  return { f, ctx: { ...f.ctx, meter: createAccountMeter(db, binding) } }
}

const theirstackJobs = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    job_title: `Engineer ${from + i}`,
    url: `https://boards.example-ats.test/example-co/${from + i}`,
    company: 'Example Co',
    date_posted: '2026-10-21',
  }))
const theirstackBody = (n: number, from = 1): FakeResponse => ({
  bodyText: JSON.stringify({ data: theirstackJobs(n, from) }),
})
// The reading is attached (billing verified) except where SR-M-1 says otherwise.
const ts = createTheirStackProvider({ credential: READY, billingVerified: true })
const tsUnverified = createTheirStackProvider({ credential: READY })
const tsConfig = (extra: Record<string, unknown> = {}) =>
  ts.parseConfig({ configVersion: 1, limit: 25, seniority: ['senior'], ...extra })

describe.skipIf(!hasDatabaseUrl())('quota adapters against the real account meter', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_account_meters', column: 'limit_amount' },
      { table: 'job_account_meter_reservations', column: 'used_amount' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 })
    const { rows } = await q('SELECT current_database() AS db')
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    db = drizzle(pool, { schema })
  })

  afterAll(async () => {
    if (!pool) return
    await q(
      `DELETE FROM job_account_meter_reservations
        WHERE meter_id IN (SELECT id FROM job_account_meters WHERE account_key LIKE $1)`,
      [`${TAG}%`],
    )
    await q(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_account_meters WHERE account_key LIKE $1`, [`${TAG}%`])
    await pool.end()
  })

  describe('TheirStack: records, not calls', () => {
    it('reserves 25 records, sends, and ends holding the 2 that came back', async () => {
      const account = nextAccount()
      const recordMeter = await newMeter({ accountKey: account, unit: 'RECORD', limit: 100 })
      const requestMeter = await newMeter({ accountKey: account, unit: 'REQUEST', limit: 100 })
      const { f, ctx } = await metered(account, 'RECORD', [theirstackBody(2)])

      const batch = await ts.collectReport(tsConfig(), ctx)

      expect(batch.outcome).toBe('SUCCEEDED')
      expect(f.sent).toHaveLength(1)
      // 2 jobs came back: 2 credits are used, the other 23 of the worst case are free again.
      expect(await counters(recordMeter)).toEqual({ used: 2, reserved: 0, uncertain: 0 })
      expect(await reservations(recordMeter)).toMatchObject([
        { status: 'USED', amount: 25, used_amount: 2, sent: true },
      ])
      // The REQUEST row of the same account is a different counter and was not touched.
      expect(await counters(requestMeter)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
      expect(await reservations(requestMeter)).toEqual([])
    })

    it('a binding that meters only REQUEST cannot charge records to it: the run fails, nothing is sent', async () => {
      const account = nextAccount()
      const requestMeter = await newMeter({ accountKey: account, unit: 'REQUEST', limit: 100 })
      const { f, ctx } = await metered(account, 'REQUEST', [theirstackBody(2)])

      await expect(ts.collectReport(tsConfig(), ctx)).rejects.toMatchObject({
        code: 'UNIT_NOT_BOUND',
      })
      expect(f.sent).toEqual([])
      expect(await counters(requestMeter)).toEqual({ used: 0, reserved: 0, uncertain: 0 })
    })

    it('the worst case is checked against the budget: 35 + 25 fits a limit of 60, not 59', async () => {
      const fits = nextAccount()
      const fitsMeter = await newMeter({ accountKey: fits, unit: 'RECORD', limit: 60, used: 35 })
      const a = await metered(fits, 'RECORD', [theirstackBody(1)])
      expect((await ts.collectReport(tsConfig(), a.ctx)).outcome).toBe('SUCCEEDED')
      expect(a.f.sent).toHaveLength(1)
      expect(await counters(fitsMeter)).toEqual({ used: 36, reserved: 0, uncertain: 0 })

      const over = nextAccount()
      const overMeter = await newMeter({ accountKey: over, unit: 'RECORD', limit: 59, used: 35 })
      const b = await metered(over, 'RECORD', [theirstackBody(1)])
      const batch = await ts.collectReport(tsConfig(), b.ctx)
      expect(batch.requests.at(-1)?.error?.code).toBe('COST_STOP')
      expect(b.f.sent).toEqual([])
      expect(await counters(overMeter)).toEqual({ used: 35, reserved: 0, uncertain: 0 })
      expect(await reservations(overMeter)).toEqual([])
    })

    it('two pages are two calls: 25 records then 3 leave 28 used and two settled reservations', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'RECORD', limit: 100 })
      const { f, ctx } = await metered(account, 'RECORD', [
        theirstackBody(25),
        theirstackBody(3, 100),
      ])

      await ts.collectReport(tsConfig({ maxPages: 2 }), ctx)

      expect(f.sent).toHaveLength(2)
      expect(await counters(meter)).toEqual({ used: 28, reserved: 0, uncertain: 0 })
      expect((await reservations(meter)).map((r) => [r.status, r.amount, r.used_amount])).toEqual([
        ['USED', 25, 25],
        ['USED', 25, 3],
      ])
    })

    it('a repeated paid request of one attempt takes a NEW reservation, not the settled one', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'RECORD', limit: 100 })
      const attempt = nextTag()
      const first = await metered(account, 'RECORD', [theirstackBody(2)], attempt)
      await ts.collectReport(tsConfig(), first.ctx)
      const second = await metered(account, 'RECORD', [theirstackBody(4, 50)], attempt)
      await ts.collectReport(tsConfig(), second.ctx)

      expect(await counters(meter)).toEqual({ used: 6, reserved: 0, uncertain: 0 })
      expect((await reservations(meter)).map((r) => [r.attempt_id, r.used_amount])).toEqual([
        [`${attempt}#RECORD#1`, 2],
        [`${attempt}#RECORD#2`, 4],
      ])
    })

    it('a timeout after the request left holds all 25 as UNCERTAIN, and the hold blocks the next run', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'RECORD', limit: 30 })
      const a = await metered(account, 'RECORD', [{ throws: new Error('timeout') }])

      const batch = await ts.collectReport(tsConfig(), a.ctx)

      expect(batch.outcome).toBe('FAILED')
      expect(await counters(meter)).toEqual({ used: 0, reserved: 0, uncertain: 25 })
      expect(await reservations(meter)).toMatchObject([{ status: 'UNCERTAIN', sent: true }])
      // 30 - 25 held = 5 left: another worst case of 25 is refused and nothing is sent.
      const b = await metered(account, 'RECORD', [theirstackBody(1)])
      const next = await ts.collectReport(tsConfig(), b.ctx)
      expect(next.requests.at(-1)?.error?.code).toBe('COST_STOP')
      expect(b.f.sent).toEqual([])
      expect(await counters(meter)).toEqual({ used: 0, reserved: 0, uncertain: 25 })
    })

    it('an uncertain hold survives the window rollover and reconciles against the window it was taken in', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'RECORD', limit: 100 })
      const attempt = nextTag()
      const a = await metered(account, 'RECORD', [{ throws: new Error('timeout') }], attempt)
      await ts.collectReport(tsConfig(), a.ctx)
      expect(await counters(meter)).toEqual({ used: 0, reserved: 0, uncertain: 25 })

      // The window ends one millisecond after the reservation was taken.
      await q(
        `UPDATE job_account_meters
            SET resets_at = sub.t + interval '1 millisecond',
                window_started_at = sub.t + interval '1 millisecond' - interval '1 day'
           FROM (SELECT max(reserved_at) AS t FROM job_account_meter_reservations
                  WHERE meter_id = $1) sub
          WHERE id = $1`,
        [meter],
      )
      await new Promise((resolve) => setTimeout(resolve, 20))

      // The next window's first run: used starts at 0, the 25 stay held, and it sends normally.
      const b = await metered(account, 'RECORD', [theirstackBody(3, 200)])
      await ts.collectReport(tsConfig(), b.ctx)
      expect(await counters(meter)).toEqual({ used: 3, reserved: 0, uncertain: 25 })

      // The provider's own log later says the timed-out call returned 4 jobs.
      const held = (
        await q(
          `SELECT id FROM job_account_meter_reservations WHERE meter_id = $1 AND status = 'UNCERTAIN'`,
          [meter],
        )
      ).rows[0].id as string
      const store = createAccountMeter(db, {
        accountKey: account,
        windows: { RECORD: 'DAY' },
        attemptId: attempt,
        cycleId: await newCycle(),
        runId: null,
      })
      await store.reconcile({ id: held, unit: 'RECORD', amount: 25 }, 'USED', 4)

      // The hold is released in full; its 4 credits belong to the OLD window, so the new one is unchanged.
      expect(await counters(meter)).toEqual({ used: 3, reserved: 0, uncertain: 0 })
    })
  })

  /**
   * SR-M-1, at a limit SEVERAL RESERVATIONS WIDE: 100 records, reserved 25 a page, so room for four.
   * (At a limit of one reservation the amplification is invisible - the window is full after the
   * first page whatever it settles at - which is why a single-reservation test cannot tell the
   * defect from its absence.) Each page returns ONE job.
   */
  describe('settling low frees budget: only a verified billing basis may do it (SR-M-1)', () => {
    const runs = async (provider: typeof ts, account: string, n: number) => {
      let sent = 0
      for (let i = 0; i < n; i += 1) {
        const { f, ctx } = await metered(account, 'RECORD', [theirstackBody(1, 1000 + i)])
        await provider.collectReport(provider.parseConfig({ configVersion: 1, limit: 25 }), ctx)
        sent += f.sent.length
      }
      return sent
    }

    it('UNVERIFIED (the default): worst case every page, so 100 records allow exactly 4 pages', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'RECORD', limit: 100 })
      const sent = await runs(tsUnverified, account, 8)
      expect(sent).toBe(4)
      expect(await counters(meter)).toEqual({ used: 100, reserved: 0, uncertain: 0 })
    })

    it('VERIFIED: the freed difference is re-reservable, so the same limit allows all 8 pages (used 8)', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'RECORD', limit: 100 })
      const sent = await runs(ts, account, 8)
      expect(sent).toBe(8)
      expect(await counters(meter)).toEqual({ used: 8, reserved: 0, uncertain: 0 })
    })
  })

  describe('JSearch: three queries, one account', () => {
    const js = createJSearchProvider({ credential: READY })
    const QUERIES = [
      'senior backend developer remote',
      'senior frontend developer remote',
      'senior ai engineer remote',
    ]
    const empty: FakeResponse = { bodyText: JSON.stringify({ status: 'OK', data: [] }) }

    it('each query is one request on the same meter row; the fourth is refused with nothing sent', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'REQUEST', limit: 3 })
      for (const query of QUERIES) {
        const { f, ctx } = await metered(account, 'REQUEST', [empty])
        const batch = await js.collectReport(js.parseConfig({ configVersion: 1, query }), ctx)
        expect(batch.outcome).toBe('SUCCEEDED')
        expect(f.sent).toHaveLength(1)
      }
      expect(await counters(meter)).toEqual({ used: 3, reserved: 0, uncertain: 0 })

      const { f, ctx } = await metered(account, 'REQUEST', [empty])
      const refused = await js.collectReport(
        js.parseConfig({ configVersion: 1, query: QUERIES[0] }),
        ctx,
      )
      expect(refused.requests.at(-1)?.error?.code).toBe('COST_STOP')
      expect(f.sent).toEqual([])
      expect(await counters(meter)).toEqual({ used: 3, reserved: 0, uncertain: 0 })
    })

    it('concurrent queries never overshoot: 6 racing runs against room for 3 send exactly 3', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'REQUEST', limit: 3 })
      const runs = await Promise.all(
        Array.from({ length: 6 }, async (_, i) => {
          const m = await metered(account, 'REQUEST', [empty])
          const config = js.parseConfig({ configVersion: 1, query: QUERIES[i % 3] })
          await js.collectReport(config, m.ctx)
          return m.f.sent.length
        }),
      )
      expect(runs.reduce((a, b) => a + b, 0)).toBe(3)
      expect(await counters(meter)).toEqual({ used: 3, reserved: 0, uncertain: 0 })
    })
  })

  describe('Jooble: the meter is a parameter', () => {
    it('a USD_MICROS agreement charges its configured amount per call', async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'USD_MICROS', limit: 10_000 })
      const jooble = createJoobleProvider({
        credential: READY,
        meter: { unit: 'USD_MICROS', amountPerRequest: 2_500 },
      })
      const { f, ctx } = await metered(account, 'USD_MICROS', [
        { bodyText: JSON.stringify({ totalCount: 0, jobs: [] }) },
      ])

      await jooble.collectReport(jooble.parseConfig({ configVersion: 1, keywords: 'rust' }), ctx)

      expect(f.sent).toHaveLength(1)
      expect(await counters(meter)).toEqual({ used: 2_500, reserved: 0, uncertain: 0 })
    })

    it("the account limit is the meter row's, not the adapter's: a 2-request account stops the third call", async () => {
      const account = nextAccount()
      const meter = await newMeter({ accountKey: account, unit: 'REQUEST', limit: 2 })
      const jooble = createJoobleProvider({ credential: READY })
      const page = (n: number): FakeResponse => ({
        bodyText: JSON.stringify({
          totalCount: 99,
          jobs: [{ title: `t${n}`, link: `https://jooble.org/desc/${n}`, id: n }],
        }),
      })
      const { f, ctx } = await metered(account, 'REQUEST', [page(1), page(2), page(3)])

      const batch = await jooble.collectReport(
        jooble.parseConfig({ configVersion: 1, keywords: 'rust', maxPages: 3 }),
        ctx,
      )

      expect(f.sent).toHaveLength(2)
      expect(batch.requests.at(-1)?.error?.code).toBe('COST_STOP')
      expect(await counters(meter)).toEqual({ used: 2, reserved: 0, uncertain: 0 })
    })
  })
})
