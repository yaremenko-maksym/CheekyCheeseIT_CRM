import { SENIOR_SELECTABLE_ROLES, TECHNICAL_ROLES } from '@crm/shared'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Senior roles PR 2 Task 2.1 — the forward DDL `manual/2026-11-17_technical_roles.sql` against a
 * REAL Postgres, applied twice into a scratch schema holding stubs of `users` and
 * `job_opportunities` with one existing row each. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run technical-roles-forward-ddl.integration.spec
 */
const FILE = join(__dirname, '..', '..', 'drizzle', 'manual', '2026-11-17_technical_roles.sql')
const SCHEMA = 'ddl_technical_roles'

let pool: Pool
let client: PoolClient

async function applyFile(): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(readFileSync(FILE, 'utf8'))
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

/** The statement fails with a CHECK violation (23514) of `constraint`; nothing is left behind. */
async function refused(statement: string, constraint: string): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(statement)
    throw new Error(`accepted: ${statement}`)
  } catch (e) {
    const err = e as { code?: string; constraint?: string }
    expect({ code: err.code, constraint: err.constraint }).toEqual({ code: '23514', constraint })
  } finally {
    await client.query('ROLLBACK')
  }
}

async function catalog() {
  const { rows } = await client.query(
    `SELECT c.relname AS rel, k.conname AS name, pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      ORDER BY 1, 2`,
    [SCHEMA],
  )
  const { rows: columns } = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1, ordinal_position`,
    [SCHEMA],
  )
  return { constraints: rows, columns }
}

/** The quoted ids of an `<@ ARRAY[...]` CHECK, in order. */
async function checkIds(name: string): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
       JOIN pg_namespace n ON n.oid = k.connamespace
      WHERE n.nspname = $1 AND k.conname = $2`,
    [SCHEMA, name],
  )
  expect(rows).toHaveLength(1)
  return [...String(rows[0].def).matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1] as string)
}

describe.skipIf(!hasDatabaseUrl())(
  'DDL: technical roles columns + role classification cache',
  () => {
    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      client = await pool.connect()
      const { rows } = await client.query(`SELECT current_database() AS db`)
      if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client.query(`CREATE SCHEMA ${SCHEMA}`)
      await client.query(`SET search_path = ${SCHEMA}, public`)
      await client.query(
        `CREATE TABLE ${SCHEMA}.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
      )
      await client.query(
        `CREATE TABLE ${SCHEMA}.job_opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
      )
      await client.query(`INSERT INTO ${SCHEMA}.users DEFAULT VALUES`)
      await client.query(`INSERT INTO ${SCHEMA}.job_opportunities DEFAULT VALUES`)
      await applyFile()
    }, 120_000)

    afterAll(async () => {
      if (pool === undefined) return
      try {
        await client?.query(`SET search_path = public`)
        await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
        client?.release()
      } finally {
        await pool.end()
      }
    })

    it('existing rows get empty roles and a NULL status', async () => {
      expect((await client.query(`SELECT technical_roles FROM users`)).rows).toEqual([
        { technical_roles: [] },
      ])
      expect(
        (
          await client.query(
            `SELECT technical_roles, role_status, role_classifier_version FROM job_opportunities`,
          )
        ).rows,
      ).toEqual([{ technical_roles: [], role_status: null, role_classifier_version: null }])
    })

    it('applying twice is a no-op', async () => {
      const before = await catalog()
      await applyFile()
      expect(await catalog()).toEqual(before)
      expect(before.constraints.map((c) => c.name)).toEqual([
        'ck_job_opportunities_role_status',
        'ck_job_opportunities_roles_iff_status',
        'ck_job_opportunities_technical_roles_known',
        'job_opportunities_pkey',
        'ck_job_role_classifications_outcome',
        'ck_job_role_classifications_technical_roles_known',
        'job_role_classifications_pkey',
        'ck_users_technical_roles_known',
        'users_pkey',
      ])
    })

    it('users.technical_roles refuses SOFTWARE_ENGINEER and an unknown id', async () => {
      await refused(
        `UPDATE users SET technical_roles = ARRAY['SOFTWARE_ENGINEER']`,
        'ck_users_technical_roles_known',
      )
      await refused(
        `UPDATE users SET technical_roles = ARRAY['WIZARD']`,
        'ck_users_technical_roles_known',
      )
      await client.query('BEGIN')
      const ok = await client.query(
        `UPDATE users SET technical_roles = ARRAY['BACKEND_ENGINEER', 'CTO']`,
      )
      await client.query('ROLLBACK')
      expect(ok.rowCount).toBe(1)
    })

    it('job_opportunities refuses roles with status PENDING, and empty roles with status RULE', async () => {
      await refused(
        `UPDATE job_opportunities SET technical_roles = ARRAY['BACKEND_ENGINEER'], role_status = 'PENDING'`,
        'ck_job_opportunities_roles_iff_status',
      )
      await refused(
        `UPDATE job_opportunities SET technical_roles = '{}', role_status = 'RULE'`,
        'ck_job_opportunities_roles_iff_status',
      )
      await refused(
        `UPDATE job_opportunities SET role_status = 'MAYBE'`,
        'ck_job_opportunities_role_status',
      )
      await refused(
        `UPDATE job_opportunities SET technical_roles = ARRAY['WIZARD'], role_status = 'AI'`,
        'ck_job_opportunities_technical_roles_known',
      )
      await client.query('BEGIN')
      const rule = await client.query(
        `UPDATE job_opportunities SET technical_roles = ARRAY['SOFTWARE_ENGINEER'], role_status = 'RULE'`,
      )
      const nonIt = await client.query(
        `UPDATE job_opportunities SET technical_roles = '{}', role_status = 'NON_IT'`,
      )
      await client.query('ROLLBACK')
      expect([rule.rowCount, nonIt.rowCount]).toEqual([1, 1])
    })

    it("job_role_classifications refuses outcome 'MAYBE'", async () => {
      await refused(
        `INSERT INTO job_role_classifications (title_key, description_sha256, classifier_version, outcome)
       VALUES ('t', 's', 'rc.1', 'MAYBE')`,
        'ck_job_role_classifications_outcome',
      )
      await refused(
        `INSERT INTO job_role_classifications (title_key, description_sha256, classifier_version, outcome, technical_roles)
       VALUES ('t', 's', 'rc.1', 'AI', ARRAY['WIZARD'])`,
        'ck_job_role_classifications_technical_roles_known',
      )
      await client.query('BEGIN')
      const ok = await client.query(
        `INSERT INTO job_role_classifications (title_key, description_sha256, classifier_version, outcome, technical_roles)
       VALUES ('t', 's', 'rc.1', 'AI', ARRAY['CTO'])`,
      )
      await client.query('ROLLBACK')
      expect(ok.rowCount).toBe(1)
    })

    it('the GIN index exists', async () => {
      const { rows } = await client.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_job_opportunities_technical_roles'`,
        [SCHEMA],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('USING gin (technical_roles)')
    })

    it('the CHECK id lists equal SENIOR_SELECTABLE_ROLES / TECHNICAL_ROLES', async () => {
      expect(await checkIds('ck_users_technical_roles_known')).toEqual([...SENIOR_SELECTABLE_ROLES])
      expect(await checkIds('ck_job_opportunities_technical_roles_known')).toEqual([
        ...TECHNICAL_ROLES,
      ])
      expect(await checkIds('ck_job_role_classifications_technical_roles_known')).toEqual([
        ...TECHNICAL_ROLES,
      ])
    })
  },
)
