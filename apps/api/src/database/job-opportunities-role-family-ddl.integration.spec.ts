import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Task 6.4c (STAGED/DARK) — the staged forward DDL
 * `manual/2026-11-05_job_opportunities_role_family.sql` against a REAL Postgres.
 *
 * Applied TWICE into a scratch schema holding a stub of `job_opportunities`, one transaction each.
 * What it leaves — the nullable column and its bounded CHECK — equals what `db:push` declares in
 * `public`; the second apply changes nothing; existing rows stay NULL; it refuses a same-named
 * column of another type and a same-named CHECK of another shape.
 *
 * Runs as the MIGRATION OWNER (`session.admin`). NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-opportunities-role-family-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-05_job_opportunities_role_family.sql',
)
const SCHEMA = 'ddl_job_opportunities_role_family'
const TABLE = 'job_opportunities'
const CHECK_NAME = 'ck_job_opportunities_role_family_bounded'

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
  const { rows: columns } = await client.query(
    `SELECT column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'role_family'`,
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
  return { columns, constraints }
}

/** A fresh stub of the production table, as it is before this file. */
async function createStub(): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${SCHEMA}.${TABLE}`)
  await client.query(
    `CREATE TABLE ${SCHEMA}.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
  )
}

describe.skipIf(!hasDatabaseUrl())('Task 6.4c staged DDL: opportunity role family', () => {
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

  it('leaves exactly what db:push declares (one nullable text column, the CHECK)', async () => {
    const ours = await touchedObjects(SCHEMA)
    expect(ours.columns).toEqual([
      { column_name: 'role_family', udt_name: 'text', is_nullable: 'YES', column_default: null },
    ])
    expect(ours.constraints).toEqual([
      {
        name: CHECK_NAME,
        type: 'c',
        validated: true,
        def: "CHECK (((role_family IS NULL) OR ((role_family ~ '[^[:space:]]'::text) AND (length(role_family) <= 100))))",
      },
    ])
    expect(ours).toEqual(await touchedObjects('public'))
  })

  it('an existing row stays NULL: no backfill here', async () => {
    const { rows } = await client.query(`SELECT role_family FROM ${SCHEMA}.${TABLE}`)
    expect(rows).toEqual([{ role_family: null }])
  })

  it('the CHECK refuses a blank or an over-long role family, and admits 100 characters', async () => {
    for (const value of [`''`, `'   '`, `repeat('a', 101)`]) {
      await expect(
        client.query(`INSERT INTO ${SCHEMA}.${TABLE} (role_family) VALUES (${value})`),
      ).rejects.toThrow(/ck_job_opportunities_role_family_bounded/)
    }
    const { rowCount } = await client.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (role_family) VALUES ('SOFTWARE'), (repeat('a', 100))`,
    )
    expect(rowCount).toBe(2)
    await client.query(`DELETE FROM ${SCHEMA}.${TABLE} WHERE role_family IS NOT NULL`)
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = await touchedObjects(SCHEMA)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(before)
  })

  it('refuses to finish over a same-named CHECK of another shape', async () => {
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${CHECK_NAME}`)
    await client.query(
      `ALTER TABLE ${SCHEMA}.${TABLE} ADD CONSTRAINT ${CHECK_NAME} CHECK (length(role_family) <= 100)`,
    )
    await expect(applyFile()).rejects.toThrow(
      /CHECK ck_job_opportunities_role_family_bounded is missing/,
    )
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${CHECK_NAME}`)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })

  it('refuses to finish over a same-named column of another type', async () => {
    await createStub()
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} ADD COLUMN role_family varchar(50)`)
    await expect(applyFile()).rejects.toThrow(/column role_family is missing/)
    await createStub()
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })
})
