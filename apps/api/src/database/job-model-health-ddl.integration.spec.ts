import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { ALL_TABLE_PRIVILEGES, PRIVILEGE_CLASSES, ROLES } from './privileges/privilege-classes'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * The forward DDL `manual/2026-11-06_job_model_health.sql` against a REAL Postgres
 * (ADR §5.3, task 5.4c-4): re-runnable, column for column and CHECK for CHECK what `db:push` builds,
 * class A for `crm_app`, and page text refused by the constraint. Three starting states: fresh, a
 * table from before cloudflare, and one from main before H2 (5.4c-H2 widens both CHECKs in place).
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-model-health-ddl.integration
 */
const FILE = join(__dirname, '..', '..', 'drizzle', 'manual', '2026-11-06_job_model_health.sql')
const SCHEMA = 'ddl_job_model_health'
const COUNTERS = 'job_model_route_daily'
const FLAGS = 'job_model_health_flags'

let session: CrmAppSession
let client: PoolClient

async function applyInto(c: PoolClient, searchPath: string): Promise<void> {
  await c.query('BEGIN')
  try {
    await c.query(`SET LOCAL search_path = ${searchPath}`)
    await c.query(readFileSync(FILE, 'utf8'))
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  }
}

async function catalogOf(schema: string, table: string) {
  const { rows: columns } = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  )
  // Primary keys too: the upsert and the flag's uniqueness rest on them.
  const { rows: constraints } = await client.query(
    `SELECT k.conname AS name, k.contype AS kind, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND k.contype IN ('c', 'p')
      ORDER BY k.conname`,
    [schema, table],
  )
  return { columns, constraints }
}

const sqlstate = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run()
    return undefined
  } catch (e) {
    return (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code
  }
}

describe.skipIf(!hasDatabaseUrl())(
  'forward DDL: job_model_route_daily, job_model_health_flags',
  () => {
    beforeAll(async () => {
      session = await openCrmAppSession()
      client = await session.admin.connect()
      const { rows } = await client.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await applyInto(client, SCHEMA)
    }, 120_000)

    afterAll(async () => {
      if (session === undefined) return
      try {
        await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
        await client?.query(`DELETE FROM ${COUNTERS} WHERE true`).catch(() => undefined)
        await client?.query(`DELETE FROM ${FLAGS} WHERE true`).catch(() => undefined)
        client?.release()
      } finally {
        await session.close()
      }
    })

    it.each([
      [COUNTERS, ['day', 'route', 'code', 'count']],
      [FLAGS, ['flag', 'raised_at', 'cleared_at', 'last_emitted_cycle_id']],
    ])('%s has the columns db:push declares, same type/null/default', async (table, names) => {
      const scratch = await catalogOf(SCHEMA, table)
      expect(scratch.columns).toEqual((await catalogOf('public', table)).columns)
      expect(scratch.columns.map((c) => c['name'])).toEqual(names)
    })

    it.each([COUNTERS, FLAGS])(
      '%s has the CHECKs and primary key db:push declares, definition for definition',
      async (table) => {
        const scratch = await catalogOf(SCHEMA, table)
        expect(scratch.constraints).toEqual((await catalogOf('public', table)).constraints)
        expect(scratch.constraints.length).toBeGreaterThan(1)
      },
    )

    it('the second apply succeeds and changes nothing (re-runnable)', async () => {
      const before = [await catalogOf(SCHEMA, COUNTERS), await catalogOf(SCHEMA, FLAGS)]
      await applyInto(client, SCHEMA)
      expect([await catalogOf(SCHEMA, COUNTERS), await catalogOf(SCHEMA, FLAGS)]).toEqual(before)
    })

    // The two states a deployed table can be in before H2 (fresh is the beforeAll above).
    it.each([
      ['pre-cloudflare', `'gemini', 'groq', 'local'`],
      ['main today (cloudflare, before H2)', `'gemini', 'groq', 'cloudflare', 'local'`],
    ])(
      'widens a %s table in place: rows kept, new values in, unknown values out (amendments 2026-11-17)',
      async (_state, oldRoutes) => {
        const OLD = `${SCHEMA}_old`
        await client.query(`DROP SCHEMA IF EXISTS ${OLD} CASCADE`)
        await client.query(`CREATE SCHEMA ${OLD}`)
        try {
          await client.query(`CREATE TABLE ${OLD}.${COUNTERS} (
            "day" date NOT NULL, "route" text NOT NULL, "code" text NOT NULL, "count" integer NOT NULL,
            CONSTRAINT "job_model_route_daily_day_route_code_pk" PRIMARY KEY ("day", "route", "code"),
            CONSTRAINT "ck_job_model_route_daily_route" CHECK ("route" IN (${oldRoutes})),
            CONSTRAINT "ck_job_model_route_daily_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
            CONSTRAINT "ck_job_model_route_daily_count_positive" CHECK ("count" > 0))`)
          await client.query(`CREATE TABLE ${OLD}.${FLAGS} (
            "flag" text PRIMARY KEY NOT NULL,
            "raised_at" timestamp with time zone DEFAULT now() NOT NULL,
            "cleared_at" timestamp with time zone,
            "last_emitted_cycle_id" uuid,
            CONSTRAINT "ck_job_model_health_flags_flag" CHECK ("flag" IN ('MODEL_UNREACHABLE',
              'HOSTED_ROUTES_DEAD', 'MODEL_LIST_STALE', 'FAILED_JOB_DAILY', 'FAILED_JOB_CHAIN')))`)
          // A historic floor row: `local` stays on the route list so it stays valid.
          await client.query(`INSERT INTO ${OLD}.${COUNTERS} VALUES
            ('2026-11-06', 'groq', 'OK', 3), ('2026-11-06', 'local', 'FELL_TO_LOCAL', 2)`)
          await client.query(`INSERT INTO ${OLD}.${FLAGS} (flag) VALUES ('MODEL_UNREACHABLE')`)
          await applyInto(client, OLD)
          const widened = [await catalogOf(OLD, COUNTERS), await catalogOf(OLD, FLAGS)]
          expect(widened).toEqual([
            await catalogOf('public', COUNTERS),
            await catalogOf('public', FLAGS),
          ])

          const count = (route: string) =>
            client.query(`INSERT INTO ${OLD}.${COUNTERS} VALUES ('2026-11-07', $1, 'CAP', 1)`, [
              route,
            ])
          const flag = (name: string) =>
            client.query(`INSERT INTO ${OLD}.${FLAGS} (flag) VALUES ($1)`, [name])
          await count('openrouter')
          await count('cloudflare')
          await flag('MODEL_LIMITS_EXHAUSTED')
          expect(await sqlstate(() => count('mistral'))).toBe('23514')
          expect(await sqlstate(() => flag('MODEL_LIMITS_REACHED'))).toBe('23514')

          const { rows } = await client.query(
            `SELECT route, code, count FROM ${OLD}.${COUNTERS} ORDER BY route, code`,
          )
          expect(rows).toEqual([
            { route: 'cloudflare', code: 'CAP', count: 1 },
            { route: 'groq', code: 'OK', count: 3 },
            { route: 'local', code: 'FELL_TO_LOCAL', count: 2 },
            { route: 'openrouter', code: 'CAP', count: 1 },
          ])
          const flags = await client.query(`SELECT flag FROM ${OLD}.${FLAGS} ORDER BY flag`)
          expect(flags.rows.map((r) => r['flag'])).toEqual([
            'MODEL_LIMITS_EXHAUSTED',
            'MODEL_UNREACHABLE',
          ])

          await applyInto(client, OLD)
          expect([await catalogOf(OLD, COUNTERS), await catalogOf(OLD, FLAGS)]).toEqual(widened)
        } finally {
          await client.query(`DROP SCHEMA IF EXISTS ${OLD} CASCADE`)
        }
      },
    )

    it.each([COUNTERS, FLAGS])(
      '%s is class A: the shipped grants give crm_app exactly the class privileges',
      async (table) => {
        expect(PRIVILEGE_CLASSES.A).toContain(table)
        const { rows } = await session.admin.query(
          `SELECT p FROM unnest($3::text[]) p WHERE has_table_privilege($1, 'public.' || $2, p)`,
          [ROLES.app, table, ALL_TABLE_PRIVILEGES],
        )
        expect(rows.map((r) => r['p']).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      },
    )

    it('as crm_app a counter row inserts; page text in a code or a route is refused', async () => {
      const insert = (route: string, code: string) =>
        session.pool.query(
          `INSERT INTO ${COUNTERS} (day, route, code, count) VALUES ('2026-11-06', $1, $2, 1)`,
          [route, code],
        )
      await expect(insert('groq', 'SPENT_DAY')).resolves.toBeDefined()
      await expect(insert('openrouter', 'CAP')).resolves.toBeDefined()
      // A historic floor row, from before 5.4c-H1: still valid.
      await expect(insert('local', 'FELL_TO_LOCAL')).resolves.toBeDefined()
      expect(await sqlstate(() => insert('groq', 'Senior Go Engineer, Kyiv'))).toBe('23514')
      expect(await sqlstate(() => insert('Senior Go Engineer', 'OK'))).toBe('23514')
      const { rows } = await session.pool.query(`SELECT current_user AS u`)
      expect(rows[0].u).toBe(ROLES.app)
    })

    it('as crm_app a flag on the list inserts; anything else is refused', async () => {
      const insert = (flag: string) =>
        session.pool.query(`INSERT INTO ${FLAGS} (flag) VALUES ($1)`, [flag])
      await expect(insert('MODEL_UNREACHABLE')).resolves.toBeDefined()
      await expect(insert('MODEL_LIMITS_EXHAUSTED')).resolves.toBeDefined()
      expect(await sqlstate(() => insert('NOT_A_FLAG'))).toBe('23514')
    })
  },
)
