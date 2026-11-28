import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Role-AI spend Task 3 — `manual/2026-11-19_role_status_out_of_scope.sql` against a REAL Postgres,
 * applied after the 2026-11-17 and 2026-11-18 files into a scratch schema holding stubs of `users`
 * and `job_opportunities` with one existing row each. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run role-status-out-of-scope-ddl.integration.spec
 */
const MANUAL = join(__dirname, '..', '..', 'drizzle', 'manual')
const FILES = [
  '2026-11-17_technical_roles.sql',
  '2026-11-18_job_opportunities_role_pending_index.sql',
  '2026-11-19_role_status_out_of_scope.sql',
]
const SCHEMA = 'ddl_role_status_out_of_scope'

let pool: Pool
let client: PoolClient

async function applyFile(file: string): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(readFileSync(join(MANUAL, file), 'utf8'))
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

/** Runs `statement` in a rolled-back transaction; returns the error code, or null when accepted. */
async function attempt(statement: string): Promise<string | null> {
  await client.query('BEGIN')
  try {
    await client.query(statement)
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown'
  } finally {
    await client.query('ROLLBACK')
  }
}

describe.skipIf(!hasDatabaseUrl())('DDL: role_status OUT_OF_SCOPE', () => {
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
      `CREATE TABLE ${SCHEMA}.job_opportunities (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         last_observed_at timestamptz NOT NULL DEFAULT now())`,
    )
    await client.query(`INSERT INTO ${SCHEMA}.users DEFAULT VALUES`)
    await client.query(`INSERT INTO ${SCHEMA}.job_opportunities DEFAULT VALUES`)
    for (const file of FILES) await applyFile(file)
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

  it('accepts OUT_OF_SCOPE with no roles', async () => {
    expect(
      await attempt(
        `UPDATE job_opportunities SET role_status = 'OUT_OF_SCOPE', technical_roles = '{}'`,
      ),
    ).toBeNull()
  })

  it('still refuses an unknown status, and OUT_OF_SCOPE with roles', async () => {
    expect(await attempt(`UPDATE job_opportunities SET role_status = 'BOGUS'`)).toBe('23514')
    expect(
      await attempt(
        `UPDATE job_opportunities SET role_status = 'OUT_OF_SCOPE', technical_roles = ARRAY['BACKEND_ENGINEER']`,
      ),
    ).toBe('23514')
  })

  it('every earlier status is still accepted', async () => {
    for (const status of ['PENDING', 'UNCLEAR', 'NON_IT'])
      expect(
        await attempt(`UPDATE job_opportunities SET role_status = '${status}'`),
        status,
      ).toBeNull()
  })

  it('applying the file twice is a no-op', async () => {
    await applyFile(FILES[2] as string)
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
         JOIN pg_namespace n ON n.oid = k.connamespace
        WHERE n.nspname = $1 AND k.conname = 'ck_job_opportunities_role_status'`,
      [SCHEMA],
    )
    expect(rows).toHaveLength(1)
    expect(String(rows[0].def)).toContain(`'OUT_OF_SCOPE'::text`)
  })
})
