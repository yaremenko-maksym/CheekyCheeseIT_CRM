import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Phase 6 T0 (STAGED/DARK) — the staged forward DDL
 * `manual-staged/2026-11-04_job_queue_submissions_per_senior.sql` against a REAL Postgres.
 *
 * AC 2 (idempotent, equals db:push): the file is applied TWICE into a scratch schema holding a
 * stub of `job_queue_assignments` as production has it (the shipped studio-wide
 * UNIQUE(opportunity_id), no `senior_id`), one transaction each. What it leaves — the column, the
 * FK, the per-senior UNIQUE, the absence of the old UNIQUE — equals what `db:push` declares in
 * `public`; the second apply changes nothing; it refuses a non-empty unmigrated table and a
 * same-named UNIQUE of another shape.
 *
 * AC 3 (the invariant) is pinned on the db:push `public` table by
 * `job-queue-store.integration.spec.ts` (two seniors coexist, the same senior twice is refused).
 *
 * Runs as the MIGRATION OWNER (`session.admin`). NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-queue-submissions-per-senior-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-04_job_queue_submissions_per_senior.sql',
)
const SCHEMA = 'ddl_job_queue_submissions_per_senior'
const TABLE = 'job_queue_assignments'
const OLD_UNIQUE = 'uq_job_queue_assignments_opportunity'
const NEW_UNIQUE = 'uq_job_queue_assignments_opportunity_senior'
const FK = 'fk_job_queue_assignments_senior'

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
  const { rows: column } = await client.query(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'senior_id'`,
    [schema, TABLE],
  )
  const { rows: constraints } = await client.query(
    `SELECT k.conname AS name, k.contype AS type, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND k.conname = ANY($3::text[])
      ORDER BY k.conname`,
    [schema, TABLE, [OLD_UNIQUE, NEW_UNIQUE, FK]],
  )
  return { column, constraints }
}

/** A fresh stub of the production table, as it is before this file. */
async function createStub(): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${SCHEMA}.${TABLE}`)
  await client.query(
    `CREATE TABLE ${SCHEMA}.${TABLE} (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       opportunity_id uuid NOT NULL,
       CONSTRAINT ${OLD_UNIQUE} UNIQUE (opportunity_id))`,
  )
}

describe.skipIf(!hasDatabaseUrl())('Phase 6 T0 staged DDL: per-senior submissions', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    client = await session.admin.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    // `users` (the FK target) resolves from `public`, as on production.
    await client.query(`SET search_path = ${SCHEMA}, public`)
    await createStub()
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

  it('AC 2: leaves exactly what db:push declares (column, FK, per-senior UNIQUE; no studio-wide UNIQUE)', async () => {
    const ours = await touchedObjects(SCHEMA)
    expect(ours.column).toEqual([{ data_type: 'uuid', is_nullable: 'NO', column_default: null }])
    expect(ours.constraints).toEqual([
      {
        name: FK,
        type: 'f',
        validated: true,
        def: 'FOREIGN KEY (senior_id) REFERENCES users(id) ON DELETE RESTRICT',
      },
      { name: NEW_UNIQUE, type: 'u', validated: true, def: 'UNIQUE (opportunity_id, senior_id)' },
    ])
    expect(ours).toEqual(await touchedObjects('public'))
  })

  it('AC 2: the second apply succeeds and changes nothing', async () => {
    const before = await touchedObjects(SCHEMA)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(before)
  })

  it('AC 2: refuses a non-empty unmigrated table instead of inventing a senior', async () => {
    await createStub()
    await client.query(`INSERT INTO ${SCHEMA}.${TABLE} (opportunity_id) VALUES (gen_random_uuid())`)
    await expect(applyFile()).rejects.toThrow(/job_queue_assignments is not empty/)
    // Rolled back whole: the stub is untouched.
    expect((await touchedObjects(SCHEMA)).constraints.map((c) => c.name)).toEqual([OLD_UNIQUE])
    await client.query(`DELETE FROM ${SCHEMA}.${TABLE}`)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })

  it('AC 2: refuses to finish over a same-named UNIQUE of another shape', async () => {
    // The existence guard skips the ADD when the NAME exists; only the closing check sees the shape.
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${NEW_UNIQUE}`)
    await client.query(
      `ALTER TABLE ${SCHEMA}.${TABLE} ADD CONSTRAINT ${NEW_UNIQUE} UNIQUE (opportunity_id)`,
    )
    await expect(applyFile()).rejects.toThrow(
      /uq_job_queue_assignments_opportunity_senior is missing/,
    )
    await client.query(`ALTER TABLE ${SCHEMA}.${TABLE} DROP CONSTRAINT ${NEW_UNIQUE}`)
    await applyFile()
    expect(await touchedObjects(SCHEMA)).toEqual(await touchedObjects('public'))
  })

  it('AC 3 (on the migrated stub): two seniors coexist on one opportunity, the same senior twice is refused', async () => {
    await client.query('BEGIN')
    try {
      // Two throwaway seniors, rolled back with everything else.
      const { rows } = await client.query(
        `INSERT INTO public.users (email, display_name, role)
         SELECT 't0-ddl-' || g || '-' || gen_random_uuid() || '@test.spec', 't0 senior', 'SENIOR'
           FROM generate_series(1, 2) g RETURNING id`,
      )
      const [a, b] = rows.map((r) => String(r.id))
      const insert = `INSERT INTO ${SCHEMA}.${TABLE} (opportunity_id, senior_id)
                      VALUES ('00000000-0000-4000-8000-000000000001', $1)`
      await client.query(insert, [a])
      await client.query(insert, [b])
      await expect(client.query(insert, [a])).rejects.toMatchObject({
        code: '23505',
        constraint: NEW_UNIQUE,
      })
    } finally {
      await client.query('ROLLBACK')
    }
  })
})
