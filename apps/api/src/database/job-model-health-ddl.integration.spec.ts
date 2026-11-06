import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { ALL_TABLE_PRIVILEGES, PRIVILEGE_CLASSES, ROLES } from './privileges/privilege-classes'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * The staged forward DDL `manual-staged/2026-11-06_job_model_health.sql` against a REAL Postgres
 * (ADR §5.3, task 5.4c-4): re-runnable, column for column and CHECK for CHECK what `db:push` builds,
 * class A for `crm_app`, and page text refused by the constraint.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-model-health-ddl.integration
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-06_job_model_health.sql',
)
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
  'staged DDL: job_model_route_daily, job_model_health_flags',
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
      await expect(insert('local', 'FELL_TO_LOCAL')).resolves.toBeDefined()
      expect(await sqlstate(() => insert('local', 'Senior Go Engineer, Kyiv'))).toBe('23514')
      expect(await sqlstate(() => insert('Senior Go Engineer', 'OK'))).toBe('23514')
      const { rows } = await session.pool.query(`SELECT current_user AS u`)
      expect(rows[0].u).toBe(ROLES.app)
    })

    it('as crm_app a flag on the list inserts; anything else is refused', async () => {
      const insert = (flag: string) =>
        session.pool.query(`INSERT INTO ${FLAGS} (flag) VALUES ($1)`, [flag])
      await expect(insert('MODEL_UNREACHABLE')).resolves.toBeDefined()
      expect(await sqlstate(() => insert('NOT_A_FLAG'))).toBe('23514')
    })
  },
)
