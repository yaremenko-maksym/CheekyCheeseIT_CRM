import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openCrmAppSession,
  sqlstateOfRejection,
  type CrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { ageHostPause } from '../../test/host-pause-aging'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { buildManifest } from '../providers/manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from '../providers/manifest.adapters'
import { MANIFEST_DEFINITIONS } from '../providers/manifest.definitions'
import { hostPolicyOf } from '../providers/manifest.hosts'
import { findDueSources } from './due-sources.query'
import type { HostPolicy } from './host-policy'
import {
  type SqlExecutor,
  banTargetOf,
  claimHostSlot,
  readHostPaused,
  recordHostBan,
} from './host-state'

/**
 * Task 2.5 T8 against a REAL Postgres, AS `crm_app` (the role the API runs as): every statement
 * under test runs on the `crm_app` pool; fixtures (sources, cycles, runs) and aging go through the
 * migration role (`session.admin`), as the ADR requires. Time is moved by `ageHostPause` only.
 *
 * Scope: every row this spec writes carries the `t8spec` tag (host keys under `*.t8spec.test`,
 * manifest ids `t8.spec.*`, cycle keys `t8spec-*`) and is deleted afterwards, so it can run on a
 * shared scratch database. NEVER run it against `crm_db`: `openCrmAppSession` refuses one.
 *
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run host-state.integration
 */
const RUN = randomUUID().slice(0, 8)
const host = (name: string) => `${name}-${RUN}.t8spec.test`
const ADMIN_DB = () => session.admin
const NO_RATE: HostPolicy = { rate: null, floorHours: 0 }

let session: CrmAppSession
let app: ReturnType<typeof drizzle<typeof schema>>
let remotive: HostPolicy
const sourceIds: string[] = []
let seq = 0

async function source(hostKey: string | null, over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  seq += 1
  sourceIds.push(id)
  const row = {
    enabled: true,
    admin_state: 'ACTIVE',
    next_attempt_at_sql: "clock_timestamp() - interval '2 hours'",
    ...over,
  }
  await ADMIN_DB().query(
    `INSERT INTO job_sources (id, type, config, manifest_id, enabled, admin_state, trigger_mode,
                              next_attempt_at, consecutive_failures, host_key)
     VALUES ($1, 'REMOTIVE_API', $2::jsonb, $3, $4, $5::job_source_admin_state, 'BOTH',
             ${String(row.next_attempt_at_sql)}, 0, $6)`,
    [
      id,
      JSON.stringify({ t8spec: RUN, n: seq }),
      `t8.spec.${RUN}.s${seq}`,
      row.enabled,
      row.admin_state,
      hostKey,
    ],
  )
  return id
}

async function cycle(): Promise<string> {
  const { rows } = await ADMIN_DB().query(
    `INSERT INTO job_collection_cycles (trigger, trigger_key) VALUES ('SCHEDULED', $1) RETURNING id`,
    [`t8spec-${RUN}-${randomUUID()}`],
  )
  return rows[0].id as string
}

/** A run of `sourceId`, STARTED (holding a lease) or terminal, started `agoSql` before now. */
async function run(
  sourceId: string,
  outcome: 'STARTED' | 'SUCCEEDED',
  agoSql = "interval '1 minute'",
) {
  const started = outcome === 'STARTED'
  await ADMIN_DB().query(
    `INSERT INTO job_collection_runs
       (source_id, cycle_id, attempt_id, config_version, adapter_version, trigger, outcome,
        owner_token, lease_expires_at, ended_at, started_at, account_key)
     VALUES ($1, $2, $3, 1, 'v1', 'SCHEDULED', $4::job_collection_outcome,
             $5, CASE WHEN $6 THEN clock_timestamp() + interval '5 minutes' END,
             CASE WHEN $6 THEN NULL ELSE clock_timestamp() END,
             clock_timestamp() - ${agoSql}, '#source:' || $1::uuid::text)`,
    [
      sourceId,
      await cycle(),
      `t8spec-${randomUUID()}`,
      outcome,
      started ? `owner-${RUN}` : null,
      started,
    ],
  )
}

/** Runs `fn` with a `claimHostSlot` executor inside one READ COMMITTED transaction as crm_app. */
async function inClaimTx<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return app.transaction((tx) => fn(tx), { isolationLevel: 'read committed' })
}

/** Seconds from the database clock to the host's `paused_until` (NULL when never paused). */
async function pauseSeconds(hostKey: string): Promise<number | null> {
  const { rows } = await ADMIN_DB().query(
    `SELECT extract(epoch FROM paused_until - clock_timestamp())::float8 AS s FROM job_source_hosts WHERE host_key = $1`,
    [hostKey],
  )
  return rows[0] === undefined || rows[0].s === null ? null : Number(rows[0].s)
}

async function hostRow(hostKey: string) {
  const { rows } = await ADMIN_DB().query(
    `SELECT paused_until, pause_reason, pause_source_id, last_claimed_at FROM job_source_hosts WHERE host_key = $1`,
    [hostKey],
  )
  return rows[0] as
    | {
        paused_until: Date | null
        pause_reason: string | null
        pause_source_id: string | null
        last_claimed_at: Date | null
      }
    | undefined
}

const ban = (hostKey: string, sourceId: string, retryAfter?: string, floorHours = 0) =>
  recordHostBan(app, { hostKey, reason: 'HTTP_429', sourceId, retryAfter, floorHours })

const due = async (trigger: 'SCHEDULED' | 'MANUAL', ids: string[]) =>
  (await findDueSources(app, trigger, { onlyIds: ids })).map((r) => r.id).sort()

const DAY = 24 * 3600

describe.skipIf(!hasDatabaseUrl())(
  'host-level state against Postgres, as crm_app (Task 2.5 T8)',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      app = drizzle(session.pool, { schema })
      const manifest = buildManifest({
        definitions: MANIFEST_DEFINITIONS,
        adapters: MANIFEST_VALIDATION_ADAPTERS,
        fixtureRoot: FIXTURE_ROOT,
      })
      remotive = hostPolicyOf(manifest, 'remotive.com')!
    }, 120_000)

    it('uses the manifest`s real Remotive policy', () => {
      expect(remotive).toEqual({ rate: { perMinute: 2, perDay: 4 }, floorHours: 6 })
    })

    afterAll(async () => {
      if (session === undefined) return
      try {
        await ADMIN_DB().query(
          `DELETE FROM job_collection_runs WHERE source_id = ANY($1::uuid[])`,
          [sourceIds],
        )
        await ADMIN_DB().query(`DELETE FROM job_collection_cycles WHERE trigger_key LIKE $1`, [
          `t8spec-${RUN}-%`,
        ])
        await ADMIN_DB().query(`DELETE FROM job_sources WHERE id = ANY($1::uuid[])`, [sourceIds])
        await ADMIN_DB().query(`DELETE FROM job_source_hosts WHERE host_key LIKE $1`, [
          `%-${RUN}.t8spec.test`,
        ])
      } finally {
        await session.close()
      }
    })

    it('runs on a scratch database, as crm_app', async () => {
      const identity = await session.identity()
      expect([identity.currentUser, identity.isSuperuser, identity.ownedRelations]).toEqual([
        'crm_app',
        false,
        0,
      ])
      const { rows } = await session.pool.query('SELECT current_database() AS db')
      expect(rows[0].db).not.toBe('crm_db')
    })

    describe('AC 6: privileges', () => {
      it('crm_app holds exactly the class A privileges on job_source_hosts, and owns nothing', async () => {
        const { rows } = await ADMIN_DB().query(
          `SELECT p AS privilege, has_table_privilege('crm_app', 'public.job_source_hosts', p) AS held
           FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`,
        )
        expect(Object.fromEntries(rows.map((r) => [r.privilege, r.held]))).toEqual({
          SELECT: true,
          INSERT: true,
          UPDATE: true,
          DELETE: true,
          TRUNCATE: false,
          REFERENCES: false,
          TRIGGER: false,
        })
        const owned = await ADMIN_DB().query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
          WHERE r.rolname = 'crm_app'`,
        )
        expect(owned.rows[0].n).toBe(0)
      })

      it('the shipped catalog check passes on this database', async () => {
        const check = readFileSync(
          join(
            __dirname,
            '..',
            '..',
            '..',
            'drizzle',
            'manual',
            '2026-10-18_db_privileges_check.sql',
          ),
          'utf8',
        )
        await expect(ADMIN_DB().query(check)).resolves.toBeDefined()
      })

      it('positive control: the claim really runs as crm_app — withdraw UPDATE and the stamp fails with 42501', async () => {
        const key = host('priv')
        const state = await session.withPrivilegeWithdrawn('UPDATE', 'job_source_hosts', () =>
          sqlstateOfRejection(() => inClaimTx((tx) => claimHostSlot(tx, key, NO_RATE))),
        )
        expect(state).toBe('42501')
        expect(await inClaimTx((tx) => claimHostSlot(tx, key, NO_RATE))).toEqual({ granted: true })
      })
    })

    describe('AC 1, 2, 8: the host term of the due predicate', () => {
      it('AC 1: a seeded pause excludes every source on the host until paused_until, and only those', async () => {
        const key = host('ac1')
        const a = await source(key)
        const b = await source(key)
        const other = await source(host('ac1-other'))
        const ids = [a, b, other]
        expect(await due('SCHEDULED', ids)).toEqual([a, b, other].sort())
        expect(await ban(key, a)).toEqual({ applied: true })
        expect(await due('SCHEDULED', ids)).toEqual([other])
        expect(await due('MANUAL', ids)).toEqual([other])
        const paused = await readHostPaused(app, ids)
        expect([paused.get(a), paused.get(b), paused.get(other)]).toEqual([true, true, false])
        // One minute before expiry it still excludes; past expiry it does not.
        await ageHostPause(ADMIN_DB(), key, DAY * 1000 - 60_000)
        expect(await due('SCHEDULED', ids)).toEqual([other])
        await ageHostPause(ADMIN_DB(), key, 120_000)
        expect(await due('SCHEDULED', ids)).toEqual([a, b, other].sort())
      })

      it('AC 2: an ADMIN enabled toggle during the pause leaves the source excluded and the pause intact', async () => {
        const key = host('ac2')
        const a = await source(key)
        await ban(key, a)
        const before = await hostRow(key)
        await session.pool.query(`UPDATE job_sources SET enabled = false WHERE id = $1`, [a])
        await session.pool.query(`UPDATE job_sources SET enabled = true WHERE id = $1`, [a])
        expect(await due('SCHEDULED', [a])).toEqual([])
        expect(await due('MANUAL', [a])).toEqual([])
        expect(await hostRow(key)).toEqual(before)
      })

      it('AC 8: a NULL host key is never matched, and claimHostSlot refuses it without an exception', async () => {
        const a = await source(null)
        expect(await due('SCHEDULED', [a])).toEqual([])
        expect(await due('MANUAL', [a])).toEqual([])
        expect((await readHostPaused(app, [a])).get(a)).toBe(true)
        await expect(inClaimTx((tx) => claimHostSlot(tx, null, NO_RATE))).resolves.toEqual({
          granted: false,
          reason: 'HOST_KEY_MISSING',
          opensAt: null,
        })
        // A row with no host row and no pause is open: the term is the NULL test, not a missing row.
        const open = await source(host('ac8-open'))
        expect(await due('SCHEDULED', [open])).toEqual([open])
      })
    })

    describe('AC 3, 4: request rates', () => {
      it('AC 3: three Remotive sources get at most 2 slots in one minute, and a slot again after the gap', async () => {
        const key = host('ac3')
        const granted: boolean[] = []
        for (let i = 0; i < 3; i += 1) {
          await source(key)
          granted.push((await inClaimTx((tx) => claimHostSlot(tx, key, remotive))).granted)
        }
        expect(granted).toEqual([true, false, false])
        const refused = await inClaimTx((tx) => claimHostSlot(tx, key, remotive))
        expect(refused).toMatchObject({ granted: false, reason: 'HOST_RATE_GAP' })
        // 30 s after the first claim: the second slot of the minute.
        await ageHostPause(ADMIN_DB(), key, 30_001, 'last_claimed_at')
        expect(await inClaimTx((tx) => claimHostSlot(tx, key, remotive))).toEqual({ granted: true })
        expect(await inClaimTx((tx) => claimHostSlot(tx, key, remotive))).toMatchObject({
          reason: 'HOST_RATE_GAP',
        })
      })

      it('AC 4: a fifth Remotive slot inside 24 h is refused, counted from seeded started_at rows', async () => {
        const key = host('ac4')
        const a = await source(key)
        const b = await source(key)
        await run(a, 'SUCCEEDED', "interval '23 hours'")
        await run(b, 'SUCCEEDED', "interval '10 hours'")
        await run(a, 'SUCCEEDED', "interval '5 hours'")
        // Outside the window: not counted.
        await run(b, 'SUCCEEDED', "interval '25 hours'")
        expect(await inClaimTx((tx) => claimHostSlot(tx, key, remotive))).toEqual({ granted: true })
        await run(b, 'SUCCEEDED', "interval '1 minute'")
        await ageHostPause(ADMIN_DB(), key, 61_000, 'last_claimed_at')
        const slot = await inClaimTx((tx) => claimHostSlot(tx, key, remotive))
        expect(slot).toMatchObject({ granted: false, reason: 'HOST_DAILY_CAP' })
        // It opens when the oldest counted claim (23 h ago) leaves the window: in about an hour.
        const opensAt = (slot as { opensAt: Date }).opensAt
        const { rows } = await ADMIN_DB().query(
          `SELECT extract(epoch FROM $1::timestamptz - clock_timestamp())::float8 AS s`,
          [opensAt],
        )
        expect(Number(rows[0].s)).toBeGreaterThan(3500)
        expect(Number(rows[0].s)).toBeLessThan(3700)
      })
    })

    describe('AC 9, 10, 11: the claim under concurrency', () => {
      it('AC 10: a seeded STARTED run on the host refuses HOST_BUSY; one on another host does not', async () => {
        const key = host('ac10')
        const a = await source(key)
        await source(key)
        const elsewhere = await source(host('ac10-other'))
        await run(elsewhere, 'STARTED')
        expect(await inClaimTx((tx) => claimHostSlot(tx, key, NO_RATE))).toEqual({ granted: true })
        await run(a, 'STARTED')
        expect(await inClaimTx((tx) => claimHostSlot(tx, key, NO_RATE))).toEqual({
          granted: false,
          reason: 'HOST_BUSY',
          opensAt: null,
        })
      })

      async function connection(): Promise<{ client: PoolClient; exec: SqlExecutor }> {
        const client = await session.pool.connect()
        return { client, exec: drizzle(client) as unknown as SqlExecutor }
      }

      async function waitingOnLock(pid: number): Promise<boolean> {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const { rows } = await ADMIN_DB().query(
            `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
            [pid],
          )
          if (rows[0]?.wait_event_type === 'Lock') return true
          await new Promise((r) => setTimeout(r, 50))
        }
        return false
      }

      it('AC 9: two concurrent claims on a missing host row serialize at the INSERT and leave one row', async () => {
        const key = host('ac9')
        const one = await connection()
        const two = await connection()
        try {
          await one.client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          expect(await claimHostSlot(one.exec, key, NO_RATE)).toEqual({ granted: true })
          await two.client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          const pid = (await two.client.query('SELECT pg_backend_pid() AS pid')).rows[0]
            .pid as number
          let settled = false
          const second = claimHostSlot(two.exec, key, NO_RATE).finally(() => {
            settled = true
          })
          // The second waits on the first's uncommitted row: blocked on a lock, not finished.
          expect(await waitingOnLock(pid)).toBe(true)
          expect(settled).toBe(false)
          await one.client.query('COMMIT')
          expect(await second).toEqual({ granted: true })
          await two.client.query('COMMIT')
          const { rows } = await ADMIN_DB().query(
            `SELECT count(*)::int AS n FROM job_source_hosts WHERE host_key = $1`,
            [key],
          )
          expect(rows[0].n).toBe(1)
        } finally {
          await one.client.query('ROLLBACK').catch(() => undefined)
          await two.client.query('ROLLBACK').catch(() => undefined)
          one.client.release()
          two.client.release()
        }
      })

      it('AC 9 with a rate: the serialized second claimer sees the first one`s stamp and is refused', async () => {
        const key = host('ac9-rate')
        const one = await connection()
        const two = await connection()
        try {
          await one.client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          expect(await claimHostSlot(one.exec, key, remotive)).toEqual({ granted: true })
          await two.client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          const second = claimHostSlot(two.exec, key, remotive)
          await one.client.query('COMMIT')
          expect(await second).toMatchObject({ granted: false, reason: 'HOST_RATE_GAP' })
          await two.client.query('COMMIT')
        } finally {
          await one.client.query('ROLLBACK').catch(() => undefined)
          await two.client.query('ROLLBACK').catch(() => undefined)
          one.client.release()
          two.client.release()
        }
      })

      it('AC 11: a pause committed after a claimer`s due SELECT and before its claimHostSlot refuses the claim', async () => {
        const key = host('ac11')
        const a = await source(key)
        const claimer = await connection()
        try {
          await claimer.client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          const seen = await findDueSources(drizzle(claimer.client, { schema }), 'SCHEDULED', {
            onlyIds: [a],
          })
          expect(seen.map((r) => r.id)).toEqual([a])
          // Another connection commits a ban in between.
          expect(await ban(key, a)).toEqual({ applied: true })
          expect(await claimHostSlot(claimer.exec, key, NO_RATE)).toMatchObject({
            granted: false,
            reason: 'HOST_PAUSED',
          })
        } finally {
          await claimer.client.query('ROLLBACK')
          claimer.client.release()
        }
      })
    })

    describe('AC 12, SR-M-21, SR-L-20, SR-M-24: recordHostBan', () => {
      it('AC 12: a ban sets at least 24 h', async () => {
        const key = host('ac12-min')
        expect(await ban(key, await source(key))).toEqual({ applied: true })
        const s = await pauseSeconds(key)
        expect(s).toBeGreaterThan(DAY - 60)
        expect(s).toBeLessThan(DAY + 60)
        expect(await hostRow(key)).toMatchObject({ pause_reason: 'HTTP_429' })
      })

      it('SR-M-21: a 429 with Retry-After 7200 still pauses at least 24 h (the larger value wins)', async () => {
        const key = host('srm21')
        await ban(key, await source(key), '7200')
        expect(await pauseSeconds(key)).toBeGreaterThan(DAY - 60)
      })

      it('AC 12: a longer valid Retry-After is honoured, and capped at 30 days', async () => {
        const three = host('ac12-3d')
        await ban(three, await source(three), String(3 * DAY))
        expect(await pauseSeconds(three)).toBeGreaterThan(3 * DAY - 60)
        expect(await pauseSeconds(three)).toBeLessThan(3 * DAY + 60)
        const forty = host('ac12-40d')
        await ban(forty, await source(forty), String(40 * DAY))
        expect(await pauseSeconds(forty)).toBeGreaterThan(30 * DAY - 60)
        expect(await pauseSeconds(forty)).toBeLessThan(30 * DAY + 60)
      })

      it('AC 12: a malformed or negative Retry-After is ignored (24 h); a longer floor wins over a day', async () => {
        for (const [name, retry] of [
          ['neg', '-7200'],
          ['bad', 'soon'],
          ['frac', '7200.5'],
        ] as const) {
          const key = host(`ac12-${name}`)
          await ban(key, await source(key), retry)
          const s = await pauseSeconds(key)
          expect(s, retry).toBeGreaterThan(DAY - 60)
          expect(s, retry).toBeLessThan(DAY + 60)
        }
        const floor = host('ac12-floor')
        await recordHostBan(app, {
          hostKey: floor,
          reason: 'HTTP_403',
          sourceId: await source(floor),
          floorHours: 48,
        })
        expect(await pauseSeconds(floor)).toBeGreaterThan(2 * DAY - 60)
      })

      it('AC 12: never shortens a pause, and a same-source repeat within its pause is a no-op', async () => {
        const key = host('ac12-mono')
        const a = await source(key)
        const b = await source(key)
        await ban(key, a, String(3 * DAY))
        const long = await hostRow(key)
        // Another source's shorter ban does not shorten it, nor take it over.
        expect(await ban(key, b)).toEqual({ applied: true })
        expect(await hostRow(key)).toEqual(long)
        // The pause's own source cannot extend it while it runs.
        expect(await ban(key, a, String(10 * DAY))).toEqual({ applied: false })
        expect(await hostRow(key)).toEqual(long)
        // Another source CAN extend it, and then owns the longer pause.
        expect(await ban(key, b, String(5 * DAY))).toEqual({ applied: true })
        expect((await hostRow(key))?.pause_source_id).toBe(b)
        expect(await pauseSeconds(key)).toBeGreaterThan(5 * DAY - 60)
        // After the pause has expired, the same source bans again.
        await ageHostPause(ADMIN_DB(), key, 6 * DAY * 1000)
        expect(await ban(key, b)).toEqual({ applied: true })
        expect(await pauseSeconds(key)).toBeGreaterThan(DAY - 60)
      })

      it('SEC-AUTO-1: the worst Retry-After still records the ban, at the 30-day cap; a far-past one at 24 h', async () => {
        const worst = host('sec-worst')
        expect(await ban(worst, await source(worst), 'Fri, 31 Dec 9999 23:59:59 GMT')).toEqual({
          applied: true,
        })
        expect(await pauseSeconds(worst)).toBeGreaterThan(30 * DAY - 60)
        expect(await pauseSeconds(worst)).toBeLessThan(30 * DAY + 60)
        const past = host('sec-past')
        await ban(past, await source(past), 'Mon, 01 Jan 1900 00:00:00 GMT')
        expect(await pauseSeconds(past)).toBeGreaterThan(DAY - 60)
        expect(await pauseSeconds(past)).toBeLessThan(DAY + 60)
        // Ignored inputs (a 5-digit year, a signed ISO year, an unbounded delay) record a 24 h ban.
        for (const [name, retry] of [
          ['sec-y10k', 'Sat, 01 Jan 10000 00:00:00 GMT'],
          ['sec-iso', '+010000-01-01T00:00:00.000Z'],
          ['sec-inf', 'Infinity'],
          // SR-H-1: the header that once parsed to an invalid Date and threw before any SQL.
          ['srh1-invalid', 'Invalid Date'],
          ['srh1-foo', 'Mon, 32 Foo 2026'],
        ] as const) {
          const key = host(name)
          expect(await ban(key, await source(key), retry), retry).toEqual({ applied: true })
          expect(await pauseSeconds(key), retry).toBeLessThan(DAY + 60)
          expect(await pauseSeconds(key), retry).toBeGreaterThan(DAY - 60)
        }
      })

      it('SEC-AUTO-1 control: the instant the guards refuse is one Postgres cannot cast', async () => {
        // What a year-10000 date would have reached the SQL as, had the parser passed it through.
        const state = await sqlstateOfRejection(() =>
          session.pool.query(`SELECT $1::timestamptz`, [
            new Date('+010000-01-01T00:00:00Z').toISOString(),
          ]),
        )
        expect(state).not.toBeNull()
      })

      it('SR-L-20: an HTTP-date three days ahead yields paused_until equal to that date', async () => {
        const key = host('srl20')
        const { rows } = await ADMIN_DB().query(
          `SELECT to_char(t AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS "GMT"') AS header, t
           FROM (SELECT date_trunc('second', clock_timestamp() + interval '3 days') AS t) x`,
        )
        await ban(key, await source(key), rows[0].header as string)
        const row = await hostRow(key)
        expect(row?.paused_until?.toISOString()).toBe((rows[0].t as Date).toISOString())
      })

      it('SR-M-21: a ban write that fails (42501 forced) leaves nothing, and the retry pauses the host', async () => {
        const key = host('srm21-retry')
        const a = await source(key)
        const state = await session.withPrivilegeWithdrawn('INSERT', 'job_source_hosts', () =>
          sqlstateOfRejection(() => ban(key, a)),
        )
        expect(state).toBe('42501')
        expect(await hostRow(key)).toBeUndefined()
        expect(await ban(key, a)).toEqual({ applied: true })
        expect(await pauseSeconds(key)).toBeGreaterThan(DAY - 60)
        // `finish`'s second call (HOST_BAN_UNRECORDED) is then a safe no-op.
        expect(await ban(key, a)).toEqual({ applied: false })
      })

      // SR-M-24, T8's half only: the decision, and the host-wide effect of a HOST ban. "A 403 on a
      // SOURCE-scoped tenant writes no row and the sibling stays claimable" needs T7's wrapper
      // (the caller that honours `banTargetOf`), so it is T7's test and is not claimed here.
      it('SR-M-24 (T8 half): a scoped 403 targets the SOURCE, a 429 the HOST, and a host ban pauses the sibling tenant', async () => {
        const key = host('srm24')
        await source(key)
        const sibling = await source(key)
        expect(banTargetOf('SOURCE', 403)).toBe('SOURCE')
        expect(banTargetOf('SOURCE', 429)).toBe('HOST')
        await ban(key, sibling)
        expect(await inClaimTx((tx) => claimHostSlot(tx, key, NO_RATE))).toMatchObject({
          granted: false,
          reason: 'HOST_PAUSED',
        })
      })
    })
  },
)
