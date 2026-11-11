import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resumeVerificationStatusEnum, seniorResumes } from './schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Verified base resume (Task 13) — the staged forward DDL
 * `manual-staged/2026-11-11_senior_resumes_verification.sql` against a REAL Postgres.
 *
 * Applied TWICE into a scratch schema holding a stub of `senior_resumes` with one existing row
 * (`users` resolves to `public` through the search path), one transaction each. The columns, the
 * enum and the FK it leaves are compared with the DRIZZLE declaration (`getTableConfig`), not with
 * `public`, so the check does not depend on how the scratch database itself was built.
 *
 * Runs as the DATABASE_URL owner on a plain pool: the file adds columns to an existing relation and
 * no grant, so the crm_app session the class specs open is not needed. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run senior-resumes-verification-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-11_senior_resumes_verification.sql',
)
const SCHEMA = 'ddl_senior_resumes_verification'
const TABLE = 'senior_resumes'

const config = getTableConfig(seniorResumes)
/** The columns this file adds: every Drizzle column the stub (an id only) lacks. */
const ADDED = config.columns.filter((c) =>
  [
    'facts',
    'verification_status',
    'verification_run_id',
    'verification_kind',
    'verification_target_path',
    'verification_base_version',
    'verification_queued_at',
    'verification_started_at',
    'verification_error_code',
    'verification_report',
    'verified_version',
    'verified_at',
    'verified_by_user_id',
    'staged_content',
    'staged_layout',
    'staged_template_name',
    'staged_pdf_s3_key',
    'staged_edited_paths',
  ].includes(c.name),
)

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

/** Every object the file leaves on the stub, read from the catalog. */
async function touchedObjects() {
  const { rows: columns } = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 1 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [SCHEMA, TABLE],
  )
  const { rows: constraints } = await client.query(
    `SELECT k.conname AS name, k.convalidated AS validated, pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND k.contype = 'f'`,
    [SCHEMA, TABLE],
  )
  const { rows: labels } = await client.query(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = 'resume_verification_status'
      ORDER BY e.enumsortorder`,
    [SCHEMA],
  )
  return { columns, constraints, labels: labels.map((r) => r['label'] as string) }
}

describe.skipIf(!hasDatabaseUrl())('staged DDL: senior_resumes verification columns', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)
    await client.query(
      `CREATE TABLE ${SCHEMA}.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
    )
    await client.query(`INSERT INTO ${SCHEMA}.${TABLE} DEFAULT VALUES`)
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

  it('adds the 18 columns Drizzle declares, same type and nullability', async () => {
    const { columns } = await touchedObjects()
    expect(ADDED).toHaveLength(18)
    expect(columns.map((c) => [c['name'], c['type'], c['not_null']])).toEqual(
      ADDED.map((c) => [c.name, c.getSQLType(), c.notNull]),
    )
  })

  it('defaults: every row starts DRAFT with no edited paths', async () => {
    const { columns } = await touchedObjects()
    const defaults = columns.filter((c) => c['default_expr'] !== null)
    expect(defaults.map((c) => [c['name'], c['default_expr']])).toEqual([
      ['verification_status', `'DRAFT'::resume_verification_status`],
      ['staged_edited_paths', `'[]'::jsonb`],
    ])
    const { rows } = await client.query(
      `SELECT facts, verification_status, staged_edited_paths FROM ${SCHEMA}.${TABLE}`,
    )
    expect(rows).toEqual([{ facts: null, verification_status: 'DRAFT', staged_edited_paths: [] }])
  })

  it('creates the enum with the Drizzle labels, in order', async () => {
    expect((await touchedObjects()).labels).toEqual(resumeVerificationStatusEnum.enumValues)
  })

  it('adds the verified-by FK under the Drizzle name, ON DELETE SET NULL', async () => {
    const verifiedBy = config.foreignKeys.find((k) =>
      k.reference().columns.some((c) => c.name === 'verified_by_user_id'),
    )
    expect(verifiedBy).toBeDefined()
    expect((await touchedObjects()).constraints).toEqual([
      {
        name: verifiedBy?.getName(),
        validated: true,
        def: 'FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL',
      },
    ])
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = await touchedObjects()
    await applyFile()
    expect(await touchedObjects()).toEqual(before)
  })
})
