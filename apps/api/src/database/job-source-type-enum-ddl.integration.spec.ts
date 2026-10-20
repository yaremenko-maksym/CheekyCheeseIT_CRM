/**
 * The REAL Postgres `job_source_type` enum carries the 31 members of
 * `jobSourceTypeSchema`, in that order (r5 reconciliation R11-M-10).
 *
 * Why this spec exists
 * --------------------
 * The 31-member order was defended on two sides and neither of them is Postgres:
 *   * `jobSourceTypeSchema.options` is pinned against a literal list
 *     (`packages/shared/src/schemas/job-sourcing.spec.ts`);
 *   * `jobSourceTypeEnum.enumValues` is pinned against zod, order-sensitively
 *     (`job-queue-schema.spec.ts`, `job-opportunities-schema.spec.ts`).
 * But `jobSourceTypeEnum` is a TypeScript DECLARATION. The real type is created and
 * grown by hand-written DDL — `drizzle/manual/2026-08-07_job_sourcing.sql` creates it
 * with one member, `2026-10-05_vacancy_sourcing_schema.sql` appends thirty more with
 * `ALTER TYPE … ADD VALUE` — and production is migrated with those files, not with
 * drizzle-kit. Nothing compared the files to either pinned side, so reordering,
 * renaming or dropping an `ADD VALUE` passed typecheck, the unit suite and the
 * `db:push` CI job, and would have been discovered as a wrong enum on production.
 *
 * Order, not just membership: `enumsortorder` is what `ORDER BY` on an enum column
 * uses, so the queue's ordering by `source_type` and any `<`/`>` on it change meaning
 * when the append order does. Membership alone would not catch that.
 *
 * How it is verified
 * ------------------
 * By EXECUTION, the way `user-locale-migration` and `notification-email-migrations`
 * do it: the statements that create and extend the type are taken from the manual
 * files and applied to an ISOLATED SCHEMA of a scratch database, then the resulting
 * order is read from `pg_enum`. An isolated schema because `public` of any migrated
 * database already HAS the type, so `CREATE TYPE` there would create nothing and
 * prove nothing — and because `ADD VALUE IF NOT EXISTS` against the existing type
 * would silently pass whatever the file said.
 *
 * `n.nspname = SCHEMA` in the query is load-bearing for the same reason: without it
 * the query would find the same-named type in `public` and pass even if nothing in
 * this schema had been applied at all.
 *
 * WHICH statements, and why that is not circular
 * ---------------------------------------------
 * The selector takes every statement in `drizzle/manual/**` that mentions
 * `job_source_type` and is a `CREATE TYPE` / `ALTER TYPE` — which covers the
 * `DO $$ … CREATE TYPE … EXCEPTION` guard, a plain `ADD VALUE`, and the forms this
 * repo does not use yet (`ADD VALUE … BEFORE/AFTER`, `RENAME VALUE`), because the
 * statement text is applied verbatim rather than interpreted. The EXPECTED side is
 * `jobSourceTypeSchema.options`, which comes from the shared package and is pinned
 * against its own literal list, so nothing here is derived from the files under test:
 * a statement missing from the SQL shrinks the candidate side only, and fails.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { jobSourceTypeSchema } from '@crm/shared'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { splitSqlStatements } from './manual-sql-statements'
import { hasDatabaseUrl } from '../test/require-real-db'

const MANUAL_DIR = join(__dirname, '..', '..', 'drizzle', 'manual')
const SCHEMA = 'ddl_job_source_type_enum'
const TYPE_NAME = 'job_source_type'

/** Statement-level `CREATE TYPE job_source_type` / `ALTER TYPE job_source_type …`. */
const TOUCHES_TYPE = new RegExp(`\\b(create|alter)\\s+type\\s+(public\\.)?${TYPE_NAME}\\b`, 'i')

let pool: Pool

/**
 * Every statement that creates or extends the type, in apply order: files by name
 * (which is their chronological order — they are date-prefixed, and `deploy.yml`
 * applies them sorted), statements by position within a file.
 */
function typeStatements(): { file: string; sql: string }[] {
  return readdirSync(MANUAL_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .flatMap((file) =>
      splitSqlStatements(readFileSync(join(MANUAL_DIR, file), 'utf8'))
        .filter((sql) => TOUCHES_TYPE.test(sql))
        .map((sql) => ({ file, sql })),
    )
}

describe.skipIf(!hasDatabaseUrl())(`${TYPE_NAME} in Postgres matches jobSourceTypeSchema`, () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.query(`CREATE SCHEMA ${SCHEMA}`)
    const client = await pool.connect()
    try {
      // The isolated schema ALONE on the search_path: with `public` on it, the
      // unqualified `CREATE TYPE` would still create here, but `ALTER TYPE` would
      // resolve to whichever copy came first — and on a migrated database that is
      // the one in `public`, which this spec must not touch.
      await client.query(`SET search_path TO ${SCHEMA}`)
      for (const { file, sql } of typeStatements()) {
        try {
          await client.query(sql)
        } catch (cause) {
          throw new Error(`${file}: ${(cause as Error).message}\n${sql}`, { cause })
        }
      }
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  it('the manual DDL does carry statements for this type', () => {
    // Guards the selector itself: a regex that matched nothing would leave the
    // schema empty and make every assertion below vacuous in a confusing way.
    const statements = typeStatements()
    expect(statements.length).toBeGreaterThan(0)
    expect(statements.some(({ sql }) => /create\s+type/i.test(sql))).toBe(true)
  })

  it('carries exactly the 31 zod members, in the zod order', async () => {
    const labels = await pool.query(
      `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = $1 AND n.nspname = $2
        ORDER BY e.enumsortorder`,
      [TYPE_NAME, SCHEMA],
    )
    expect(labels.rows.map((r: { enumlabel: string }) => r.enumlabel)).toEqual([
      ...jobSourceTypeSchema.options,
    ])
  })

  it('applying the same statements again changes nothing (deploy re-runs every file)', async () => {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${SCHEMA}`)
      for (const { sql } of typeStatements()) await client.query(sql)
    } finally {
      client.release()
    }
    const labels = await pool.query(
      `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = $1 AND n.nspname = $2
        ORDER BY e.enumsortorder`,
      [TYPE_NAME, SCHEMA],
    )
    expect(labels.rows.map((r: { enumlabel: string }) => r.enumlabel)).toEqual([
      ...jobSourceTypeSchema.options,
    ])
  })
})
