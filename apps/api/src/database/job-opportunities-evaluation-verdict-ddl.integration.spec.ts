import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * SR-M-2 (STAGED/DARK) — the staged forward DDL
 * `manual-staged/2026-11-04_job_opportunities_evaluation_verdict.sql` against a REAL Postgres.
 *
 * Applied TWICE into a scratch schema holding a stub of `job_opportunities`, one transaction each.
 * What it leaves — the enum, the two nullable columns, the pair CHECK — equals what `db:push`
 * declares in `public`; the second apply changes nothing; existing rows stay NULL; it refuses a
 * same-named column of another type and a same-named CHECK of another shape.
 *
 * Runs as the MIGRATION OWNER (`session.admin`). NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-opportunities-evaluation-verdict-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-04_job_opportunities_evaluation_verdict.sql',
)
const SCHEMA = 'ddl_job_opportunities_evaluation'
const TABLE = 'job_opportunities'
const CHECK_NAME = 'ck_job_opportunities_evaluation_pair'

let session: CrmAppSession
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

/** The objects this file touches, read from one schema. */
async function touchedObjects(schema: string) {
  const { rows: labels } = await client.query(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = 'job_opportunity_verdict'
      ORDER BY e.enumsortorder`,
    [schema],
  )
  const { rows: columns } = await client.query(
    `SELECT column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
        AND column_name IN ('evaluated_revision', 'evaluation_verdict')
      ORDER BY column_name`,
    [schema, TABLE],
  )
  const { rows: constraints } = await client.query(
    `SELECT k.conname AS name, k.contype AS type, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND k.conname = $3`,
    [schema, TABLE, CHECK_NAME],
  )
  return { labels, columns, constraints }
}

/** A fresh stub of the production table, as it is before this file. */
async function createStub(): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${SCHEMA}.${TABLE}`)
  await client.query(
    `CREATE TABLE ${SCHEMA}.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
  )
}

describe.skipIf(!hasDatabaseUrl())('SR-M-2 staged DDL: opportunity evaluation record', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    client = await session.admin.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)
    await createStub()
    await client.query(`INSERT INTO ${SCHEMA}.${TABLE} DEFAULT VALUES`)
    await applyFile()
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await client?.query(`SET search_path = public`)
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      client?.release()
    } finally {
      await session.close()
    }
  })

  it('leaves exactly what db:push declares (enum, two nullable columns, the pair CHECK)', async () => {
    const ours = await touchedObjects(SCHEMA)
    expect(ours.labels).toEqual([{ label: 'OPEN' }, { label: 'EXCLUDED' }])
    expect(ours.columns).toEqual([
      {
        column_name: 'evaluated_revision',
        udt_name: 'int4',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'evaluation_verdict',
        udt_name: 'job_opportunity_verdict',
        is_nullable: 'YES',
        column_default: null,
      },
    ])
    expect(ours.constraints).toEqual([
      {
        name: CHECK_NAME,
        type: 'c',
        validated: true,
        def: 'CHECK (((evaluated_revision IS NULL) = (evaluation_verdict IS NULL)))',
      },
    ])
    expect(ours).toEqual(await touchedObjects('public'))
  })

  it('an existing row stays NULL: no backfill', async () => {
    const { rows } = await client.query(
      `SELECT evaluated_revision, evaluation_verdict FROM ${SCHEMA}.${TABLE}`,
    )
    expect(rows).toEqual([{ evaluated_revision: null, evaluation_verdict: null }])
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = await touchedObjects(SCHEMA)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(before)
  })

  it('refuses to finish over a same-named CHECK of another shape', async () => {
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${CHECK_NAME}`)
    await client.query(
      `ALTER TABLE ${SCHEMA}.${TABLE} ADD CONSTRAINT ${CHECK_NAME} CHECK (evaluated_revision > 0)`,
    )
    await expect(applyFile()).rejects.toThrow(
      /CHECK ck_job_opportunities_evaluation_pair is missing/,
    )
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${CHECK_NAME}`)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })

  it('refuses to finish over a same-named column of another type', async () => {
    await createStub()
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} ADD COLUMN evaluated_revision bigint`)
    await expect(applyFile()).rejects.toThrow(/column evaluated_revision is missing/)
    await createStub()
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })

  it('refuses to finish over a same-named enum with other labels', async () => {
    await createStub()
    await client.query(`DROP TYPE ${SCHEMA}.job_opportunity_verdict`)
    await client.query(`CREATE TYPE ${SCHEMA}.job_opportunity_verdict AS ENUM ('OPEN')`)
    await expect(applyFile()).rejects.toThrow(/enum job_opportunity_verdict is not exactly/)
    await client.query(`DROP TYPE ${SCHEMA}.job_opportunity_verdict`)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })
})
