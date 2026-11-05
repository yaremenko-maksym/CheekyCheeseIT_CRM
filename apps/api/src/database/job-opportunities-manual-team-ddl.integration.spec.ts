import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Phase 6 (STAGED/DARK) — the staged forward DDL
 * `manual-staged/2026-11-05_job_opportunities_manual_team.sql` against a REAL Postgres.
 *
 * Applied TWICE into a scratch schema holding a stub of `job_opportunities` (`teams` resolves to
 * `public` through the search path), one transaction each. What it leaves — the nullable column and
 * its FK — equals what `db:push` declares in `public`; the second apply changes nothing; existing
 * rows stay NULL; it refuses a same-named column of another type and a same-named FK of another
 * shape.
 *
 * Runs as the MIGRATION OWNER (`session.admin`). NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-opportunities-manual-team-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-05_job_opportunities_manual_team.sql',
)
const SCHEMA = 'ddl_job_opportunities_manual_team'
const TABLE = 'job_opportunities'
const FK_NAME = 'fk_job_opportunities_manual_team'

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
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'manual_team_id'`,
    [schema, TABLE],
  )
  const { rows: constraints } = await client.query(
    `SELECT k.conname AS name, k.contype AS type, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND k.conname = $3`,
    [schema, TABLE, FK_NAME],
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

describe.skipIf(!hasDatabaseUrl())('Phase 6 staged DDL: manual card owner team', () => {
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

  it('leaves exactly what db:push declares (one nullable uuid column, the RESTRICT FK to teams)', async () => {
    const ours = await touchedObjects(SCHEMA)
    expect(ours.columns).toEqual([
      { column_name: 'manual_team_id', udt_name: 'uuid', is_nullable: 'YES', column_default: null },
    ])
    expect(ours.constraints).toEqual([
      {
        name: FK_NAME,
        type: 'f',
        validated: true,
        def: 'FOREIGN KEY (manual_team_id) REFERENCES teams(id) ON DELETE RESTRICT',
      },
    ])
    expect(ours).toEqual(await touchedObjects('public'))
  })

  it('an existing row stays NULL: no backfill here', async () => {
    const { rows } = await client.query(`SELECT manual_team_id FROM ${SCHEMA}.${TABLE}`)
    expect(rows).toEqual([{ manual_team_id: null }])
  })

  it('the FK refuses a team that does not exist', async () => {
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (manual_team_id) VALUES ('00000000-0000-4000-8000-000000000000')`,
      ),
    ).rejects.toThrow(/fk_job_opportunities_manual_team/)
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = await touchedObjects(SCHEMA)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(before)
  })

  it('refuses to finish over a same-named FK of another shape', async () => {
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${FK_NAME}`)
    await client.query(
      `ALTER TABLE ${SCHEMA}.${TABLE} ADD CONSTRAINT ${FK_NAME}
         FOREIGN KEY (manual_team_id) REFERENCES teams(id) ON DELETE CASCADE`,
    )
    await expect(applyFile()).rejects.toThrow(/FK fk_job_opportunities_manual_team is missing/)
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${FK_NAME}`)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })

  it('refuses to finish over a same-named column of another type', async () => {
    await createStub()
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} ADD COLUMN manual_team_id text`)
    // Postgres itself refuses the FK over a text column (incompatible key types) before the closing
    // check runs; either refusal rolls the whole apply back.
    await expect(applyFile()).rejects.toThrow(
      /fk_job_opportunities_manual_team|column manual_team_id is missing/,
    )
    await createStub()
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })
})
