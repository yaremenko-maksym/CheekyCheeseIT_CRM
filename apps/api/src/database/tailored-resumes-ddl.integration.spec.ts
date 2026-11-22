import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SQL, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { ALL_TABLE_PRIVILEGES, PRIVILEGE_CLASSES, ROLES } from './privileges/privilege-classes'
import { hasDatabaseUrl } from '../test/require-real-db'
import { assertUnderDailyCap } from '../tailored-resumes/tailored-cap'

/**
 * The forward DDL `manual/2026-11-21_tailored_resumes.sql` against a REAL Postgres (tailored-resume
 * spec §8): re-runnable, column for column, constraint for constraint and index for index what
 * `db:push` builds, class A for `crm_app`, the CHECKs and the unique pair refusing bad rows, and a
 * deleted opportunity taking its rows with it.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run tailored-resumes-ddl.integration
 */
const FILE = join(__dirname, '..', '..', 'drizzle', 'manual', '2026-11-21_tailored_resumes.sql')
const SCHEMA = 'ddl_tailored_resumes'
const TABLE = 'tailored_resumes'
const SENIOR = '7a110021-0000-4000-bb00-000000000001'
const OPP = '7a110021-0000-4000-bb00-0000000000a1'
const RUN = '7a110021-0000-4000-bb00-0000000000f1'

let session: CrmAppSession
let client: PoolClient

async function applyInto(c: PoolClient): Promise<void> {
  await c.query('BEGIN')
  try {
    // `public` after the scratch schema: the FKs name `users`, `job_opportunities` and
    // `senior_resumes`, which live only in public
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
  // The definition without its schema prefix, so the scratch copy compares with public's.
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
    return (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code
  }
}

describe.skipIf(!hasDatabaseUrl())('manual DDL: tailored_resumes', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    client = await session.admin.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await applyInto(client)
    await client.query(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'DDL Senior', 'SENIOR')
       ON CONFLICT (id) DO NOTHING`,
      [SENIOR, 'ddl-tailored-resumes@test.spec'],
    )
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client?.query(`DELETE FROM job_opportunities WHERE id = $1`, [OPP]).catch(() => 0)
      await client?.query(`DELETE FROM users WHERE id = $1`, [SENIOR]).catch(() => undefined)
      client?.release()
    } finally {
      await session.close()
    }
  })

  it('has the columns db:push declares, same type/null/default', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.columns).toEqual((await catalogOf('public')).columns)
    expect(scratch.columns.map((c) => c['name'])).toEqual([
      'id',
      'job_opportunity_id',
      'senior_user_id',
      'base_resume_id',
      'base_version',
      'opportunity_revision',
      'content',
      'cover_letter',
      'layout',
      'template_name',
      'verification',
      'run_status',
      'run_id',
      'run_base_version',
      'run_stage',
      'run_queued_at',
      'run_started_at',
      'run_error_code',
      'run_requested_by_user_id',
      'pdf_status',
      'pdf_render_id',
      'pdf_render_started_at',
      'pdf_render_error',
      'pdf_s3_key',
      'pdf_fingerprint',
      'generated_by_user_id',
      'edited_by_user_id',
      'generated_at',
      'edited_at',
      'created_at',
      'updated_at',
    ])
  })

  it('has the keys, FKs and CHECKs db:push declares, definition for definition', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.constraints).toEqual((await catalogOf('public')).constraints)
    expect(scratch.constraints.map((c) => c['name'])).toEqual([
      'ck_tailored_resumes_active_run_id',
      'ck_tailored_resumes_content_cover_letter',
      'ck_tailored_resumes_pdf_status',
      'ck_tailored_resumes_run_status',
      'tailored_resumes_base_resume_id_senior_resumes_id_fk',
      'tailored_resumes_edited_by_user_id_users_id_fk',
      'tailored_resumes_generated_by_user_id_users_id_fk',
      'tailored_resumes_job_opportunity_id_job_opportunities_id_fk',
      'tailored_resumes_pkey',
      'tailored_resumes_run_requested_by_user_id_users_id_fk',
      'tailored_resumes_senior_user_id_users_id_fk',
      'uq_tailored_resumes_opportunity_senior',
    ])
  })

  it('has the indexes db:push declares, the three sweep indexes partial', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.indexes).toEqual((await catalogOf('public')).indexes)
    expect(scratch.indexes.map((i) => i['name'])).toEqual([
      'idx_tailored_resumes_active_render',
      'idx_tailored_resumes_active_run',
      'idx_tailored_resumes_pdf_key',
      'tailored_resumes_pkey',
      'uq_tailored_resumes_opportunity_senior',
    ])
    const def = (name: string) => scratch.indexes.find((i) => i['name'] === name)?.['def']
    expect(def('idx_tailored_resumes_active_run')).toContain(
      `(run_status) WHERE (run_status = ANY (ARRAY['QUEUED'::text, 'RUNNING'`,
    )
    expect(def('idx_tailored_resumes_active_render')).toContain(
      `(pdf_status) WHERE (pdf_status = ANY (ARRAY['QUEUED'::text, 'RUNNING'`,
    )
    expect(def('idx_tailored_resumes_pdf_key')).toContain(
      '(pdf_s3_key) WHERE (pdf_s3_key IS NOT NULL)',
    )
  })

  it('the run sweep and the orphan lookup are answered by the partial indexes, not a table scan', async () => {
    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL search_path = ${SCHEMA}`)
      await client.query('SET LOCAL enable_seqscan = off')
      const plan = async (q: string) =>
        (await client.query(`EXPLAIN ${q}`)).rows.map((r) => r['QUERY PLAN']).join('\n')
      const sweep = await plan(
        `SELECT id FROM tailored_resumes WHERE run_status IN ('QUEUED', 'RUNNING') OR pdf_status = 'RUNNING'`,
      )
      expect(sweep).toContain('idx_tailored_resumes_active_run')
      expect(sweep).toContain('idx_tailored_resumes_active_render')
      const orphans = await plan(
        `SELECT pdf_s3_key FROM tailored_resumes WHERE pdf_s3_key IN ('tailored-resumes/a/run-1.pdf', 'tailored-resumes/b/run-2.pdf')`,
      )
      expect(orphans).toContain('idx_tailored_resumes_pdf_key')
    } finally {
      await client.query('ROLLBACK')
    }
  })

  it('J: the daily-cap count is answered by user_audit_log_action_created_at_idx, not a scan', async () => {
    // The real query of `assertUnderDailyCap`, each statement it sends prefixed with EXPLAIN.
    const db = drizzle(client)
    const plans: string[] = []
    const explain = {
      execute: async (q: SQL) => {
        const { rows } = await db.execute(sql`EXPLAIN ${q}`)
        plans.push(rows.map((r) => String(r['QUERY PLAN'])).join('\n'))
        return { rows: [] }
      },
    }
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL enable_seqscan = off')
      await assertUnderDailyCap(explain, 'cap-explain-team', 50, new Date('2026-11-22T10:00:00Z'))
    } finally {
      await client.query('ROLLBACK')
    }
    expect(plans).toHaveLength(1)
    expect(plans[0]).toContain('user_audit_log_action_created_at_idx')
    expect(plans[0]).not.toContain('Seq Scan')
  })

  it('the second apply succeeds and changes nothing (re-runnable)', async () => {
    const before = await catalogOf(SCHEMA)
    await applyInto(client)
    expect(await catalogOf(SCHEMA)).toEqual(before)
  })

  it('is class A: the shipped grants give crm_app exactly the class privileges', async () => {
    expect(PRIVILEGE_CLASSES.A).toContain(TABLE)
    const { rows } = await session.admin.query(
      `SELECT p FROM unnest($3::text[]) p WHERE has_table_privilege($1, 'public.' || $2, p)`,
      [ROLES.app, TABLE, ALL_TABLE_PRIVILEGES],
    )
    expect(rows.map((r) => r['p']).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  })

  describe('as crm_app', () => {
    const insert = (cols: Record<string, unknown>) => {
      const all = { job_opportunity_id: OPP, senior_user_id: SENIOR, ...cols }
      const names = Object.keys(all)
      return session.pool.query(
        `INSERT INTO ${TABLE} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(all),
      )
    }
    const clear = () =>
      session.pool.query(`DELETE FROM ${TABLE} WHERE job_opportunity_id = $1`, [OPP])

    beforeAll(async () => {
      await client.query(
        `INSERT INTO job_opportunities (id, title, title_key) VALUES ($1, 'DDL role', 'ddl role')
         ON CONFLICT (id) DO NOTHING`,
        [OPP],
      )
    })

    it('runs as crm_app; a minimal row defaults pdf_status to IDLE', async () => {
      await clear()
      const { rows: who } = await session.pool.query(`SELECT current_user AS u`)
      expect(who[0].u).toBe(ROLES.app)
      await insert({})
      const { rows } = await session.pool.query(
        `SELECT pdf_status, run_status, content FROM ${TABLE} WHERE job_opportunity_id = $1`,
        [OPP],
      )
      expect(rows).toEqual([{ pdf_status: 'IDLE', run_status: null, content: null }])
    })

    it('refuses an unknown run status and an unknown pdf status', async () => {
      await clear()
      expect(await sqlstate(() => insert({ run_status: 'DONE', run_id: RUN }))).toBe('23514')
      expect(await sqlstate(() => insert({ pdf_status: 'X' }))).toBe('23514')
    })

    it('an active run needs its run id; a finished one does not', async () => {
      await clear()
      expect(await sqlstate(() => insert({ run_status: 'QUEUED' }))).toBe('23514')
      expect(await sqlstate(() => insert({ run_status: 'RUNNING' }))).toBe('23514')
      await expect(insert({ run_status: 'FAILED' })).resolves.toBeDefined()
      await clear()
      await expect(insert({ run_status: 'QUEUED', run_id: RUN })).resolves.toBeDefined()
    })

    it('content and cover letter go together', async () => {
      await clear()
      expect(await sqlstate(() => insert({ content: '{}' }))).toBe('23514')
      expect(await sqlstate(() => insert({ cover_letter: 'Dear Hiring Team,' }))).toBe('23514')
      await expect(
        insert({ content: '{}', cover_letter: 'Dear Hiring Team,' }),
      ).resolves.toBeDefined()
    })

    it('the (opportunity, senior) pair is unique', async () => {
      await clear()
      await insert({})
      expect(await sqlstate(() => insert({}))).toBe('23505')
    })

    it('deleting the opportunity cascades the row', async () => {
      await clear()
      await insert({})
      await client.query(`DELETE FROM job_opportunities WHERE id = $1`, [OPP])
      const { rows } = await session.pool.query(
        `SELECT count(*)::int AS n FROM ${TABLE} WHERE senior_user_id = $1`,
        [SENIOR],
      )
      expect(rows[0].n).toBe(0)
    })
  })
})
