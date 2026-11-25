import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRIVILEGE_CLASSES } from './privileges/privilege-classes'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * The forward DDL `manual/2026-11-24_job_opportunity_relevance.sql` against a REAL Postgres (queue
 * relevance PR1): re-runnable, column for column, constraint for constraint and index for index
 * what `db:push` builds, the CHECKs refusing bad rows, and a deleted opportunity or user taking
 * its rows with it. The file is applied into a scratch schema; its FKs reach `public`.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-opportunity-relevance-forward-ddl.integration
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-24_job_opportunity_relevance.sql',
)
const SCHEMA = 'ddl_job_opportunity_relevance'
const TABLE = 'job_opportunity_relevance'
const SENIOR = '7a110024-0000-4000-bb00-000000000001'
const OPP = '7a110024-0000-4000-bb00-0000000000a1'

let pool: Pool
let client: PoolClient

async function applyInto(c: PoolClient): Promise<void> {
  await c.query('BEGIN')
  try {
    // `public` after the scratch schema: the FKs name `users` and `job_opportunities`.
    await c.query(`SET LOCAL search_path = ${SCHEMA}, public`)
    await c.query(readFileSync(FILE, 'utf8'))
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  }
}

async function catalogOf(schema: string) {
  const { rows: columns } = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, TABLE],
  )
  const { rows: constraints } = await client.query(
    `SELECT k.conname AS name, k.contype AS kind, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY k.conname`,
    [schema, TABLE],
  )
  const { rows: indexes } = await client.query(
    `SELECT indexname AS name, replace(indexdef, ' ON ' || schemaname || '.', ' ON ') AS def
       FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
    [schema, TABLE],
  )
  return { columns, constraints, indexes }
}

const sqlstate = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run()
    return undefined
  } catch (e) {
    return (e as { code?: string }).code
  }
}

const insert = (cols: Record<string, unknown>) => {
  const all = {
    opportunity_id: OPP,
    senior_id: SENIOR,
    grader_version: 'rel.1',
    title_key: 'ddl role',
    opportunity_roles: ['BACKEND_ENGINEER'],
    senior_profile_version: 'p1',
    status: 'GRADED',
    fit: 0.5,
    ...cols,
  }
  const names = Object.keys(all)
  return client.query(
    `INSERT INTO ${SCHEMA}.${TABLE} (${names.join(', ')})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(all),
  )
}
const clear = () => client.query(`DELETE FROM ${SCHEMA}.${TABLE}`)
const count = async () =>
  Number((await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.${TABLE}`)).rows[0].n)
const seedParents = async () => {
  await client.query(
    `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'DDL Senior', 'SENIOR')
     ON CONFLICT (id) DO NOTHING`,
    [SENIOR, 'ddl-job-opportunity-relevance@test.spec'],
  )
  await client.query(
    `INSERT INTO job_opportunities (id, title, title_key) VALUES ($1, 'DDL role', 'ddl role')
     ON CONFLICT (id) DO NOTHING`,
    [OPP],
  )
}

describe.skipIf(!hasDatabaseUrl())('manual DDL: job_opportunity_relevance', () => {
  beforeAll(async () => {
    // `public` is the reference side (built by db:push from this checkout).
    await assertRealDbSchema([{ table: TABLE, column: 'fit' }])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await applyInto(client)
    await seedParents()
  }, 120_000)

  afterAll(async () => {
    if (pool === undefined) return
    try {
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client?.query(`DELETE FROM job_opportunities WHERE id = $1`, [OPP])
      await client?.query(`DELETE FROM users WHERE id = $1`, [SENIOR])
      client?.release()
    } finally {
      await pool.end()
    }
  })

  it('matches the Drizzle schema: columns, type, nullability and default', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.columns).toEqual((await catalogOf('public')).columns)
    expect(scratch.columns.map((c) => [c['name'], c['not_null']])).toEqual([
      ['opportunity_id', true],
      ['senior_id', true],
      ['grader_version', true],
      ['title_key', true],
      ['description_sha256', false],
      ['opportunity_roles', true],
      ['senior_profile_version', true],
      ['status', true],
      ['fit', false],
      ['attempts', true],
      ['next_attempt_at', false],
      ['updated_at', true],
    ])
  })

  it('matches the Drizzle schema: keys, FKs and CHECKs, definition for definition', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.constraints).toEqual((await catalogOf('public')).constraints)
    expect(scratch.constraints.map((c) => c['name'])).toEqual([
      'ck_job_opportunity_relevance_fit',
      'ck_job_opportunity_relevance_roles',
      'ck_job_opportunity_relevance_status',
      'job_opportunity_relevance_opportunity_id_job_opportunities_id_f',
      'job_opportunity_relevance_pkey',
      'job_opportunity_relevance_senior_id_users_id_fk',
    ])
  })

  it('matches the Drizzle schema: indexes', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.indexes).toEqual((await catalogOf('public')).indexes)
    expect(scratch.indexes.map((i) => i['name'])).toEqual([
      'idx_job_opportunity_relevance_senior',
      'job_opportunity_relevance_pkey',
    ])
  })

  it('applies twice without error and changes nothing (re-runnable)', async () => {
    const before = await catalogOf(SCHEMA)
    await applyInto(client)
    expect(await catalogOf(SCHEMA)).toEqual(before)
  })

  it('is class A, like job_role_classifications', () => {
    expect(PRIVILEGE_CLASSES.A).toContain(TABLE)
  })

  it('accepts a GRADED row with a fit in [0, 1] and a FAILED row without one', async () => {
    await clear()
    await expect(insert({ fit: 0 })).resolves.toBeDefined()
    await clear()
    await expect(insert({ fit: 1 })).resolves.toBeDefined()
    await clear()
    await expect(insert({ status: 'FAILED', fit: null, attempts: 1 })).resolves.toBeDefined()
    expect(await count()).toBe(1)
  })

  it('rejects GRADED without fit', async () => {
    await clear()
    expect(await sqlstate(() => insert({ fit: null }))).toBe('23514')
  })

  it('rejects fit 1.01 and -0.01', async () => {
    await clear()
    expect(await sqlstate(() => insert({ fit: 1.01 }))).toBe('23514')
    expect(await sqlstate(() => insert({ fit: -0.01 }))).toBe('23514')
  })

  it('rejects FAILED with fit', async () => {
    await clear()
    expect(await sqlstate(() => insert({ status: 'FAILED', fit: 0.5 }))).toBe('23514')
  })

  it('rejects an unknown status and an unknown role in opportunity_roles', async () => {
    await clear()
    expect(await sqlstate(() => insert({ status: 'PENDING' }))).toBe('23514')
    expect(await sqlstate(() => insert({ opportunity_roles: ['WIZARD'] }))).toBe('23514')
  })

  it('the (opportunity, senior) pair is the primary key', async () => {
    await clear()
    await insert({})
    expect(await sqlstate(() => insert({}))).toBe('23505')
  })

  it('cascades on opportunity delete and on user delete', async () => {
    await clear()
    await insert({})
    expect(await count()).toBe(1)
    await client.query(`DELETE FROM job_opportunities WHERE id = $1`, [OPP])
    expect(await count()).toBe(0)
    await seedParents()
    await insert({})
    expect(await count()).toBe(1)
    await client.query(`DELETE FROM users WHERE id = $1`, [SENIOR])
    expect(await count()).toBe(0)
    await seedParents()
  })
})
