import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { splitSqlStatements } from './manual-sql-statements'

/**
 * task-sources-07c — the two forward-DDL files that let an HR queue submission become exactly one
 * interview card on the submitted senior's board, against a REAL Postgres:
 *
 *   1. `manual/2026-11-19_interview_stage_submitted.sql` — `interview_stage` gains SUBMITTED,
 *      inserted BEFORE HR_SCREEN. Irreversible (Postgres has no `ALTER TYPE … DROP VALUE`), which
 *      is why it is its own file and applied FIRST.
 *   2. `manual/2026-11-19_interviews_job_opportunity.sql` — `interviews.job_opportunity_id uuid`
 *      (nullable), the FK to `job_opportunities(id)` ON DELETE SET NULL, and the PARTIAL unique
 *      index `uq_interviews_job_opportunity_senior` on `(job_opportunity_id, senior_id)`
 *      `WHERE job_opportunity_id IS NOT NULL`.
 *
 * WHY THE PARTIAL PREDICATE IS THE POINT OF THIS SPEC
 * ---------------------------------------------------
 * The index carries the whole "one card per (opportunity, senior), for the card's whole life"
 * guarantee that `senior-interview-card.ts` upserts onto — and it has to carry it WITHOUT
 * constraining the hand-made cards, which are the overwhelming majority and all have
 * `job_opportunity_id IS NULL`. A non-partial unique index would be wrong in a way no unit test
 * can see and no typecheck can catch: in Postgres NULLs do not collide in a unique index, so the
 * NULL side would keep working while the index grew to cover every interview ever created. The two
 * behavioural assertions below pin both halves — a second card for the same pair is REJECTED, and
 * two NULL-linked cards for the same senior are ACCEPTED.
 *
 * Each file is applied TWICE: the deploy re-applies every `manual/*.sql` on every deploy, forever,
 * so "re-runnable" is a hard requirement and not a nicety. A second apply that raises is a prod
 * deploy that fails on the next unrelated release.
 *
 * AC: both files apply twice without error; SUBMITTED sorts immediately before HR_SCREEN; the
 * column, FK and partial index match what `db:push` of the Drizzle schema declares; the pair is
 * unique and the NULL side is exempt. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run interviews-job-opportunity-forward-ddl.integration.spec
 */
const MANUAL = join(__dirname, '..', '..', 'drizzle', 'manual')
const ENUM_FILE = join(MANUAL, '2026-11-19_interview_stage_submitted.sql')
const COLUMN_FILE = join(MANUAL, '2026-11-19_interviews_job_opportunity.sql')
const SCHEMA = 'ddl_interviews_job_opportunity'
const TABLE = 'interviews'
const INDEX = 'uq_interviews_job_opportunity_senior'
const FK = 'fk_interviews_job_opportunity'

/**
 * `interview_stage` as it is on production BEFORE the enum file runs — the 9 shipped values, in
 * their shipped order. The file inserts SUBMITTED into this, so starting from the post-state would
 * assert nothing.
 */
const SHIPPED_STAGES = [
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
  'OFFER_RECEIVED',
  'HIRED',
  'REJECTED',
  'ARCHIVED',
] as const

/** The order `interviewStageEnum` in `schema/enums.ts` declares, i.e. what `db:push` would build. */
const EXPECTED_STAGES = ['SUBMITTED', ...SHIPPED_STAGES]

let pool: Pool
let client: PoolClient

/**
 * Applies one file as the deploy's own `psql -v ON_ERROR_STOP=1 --single-transaction` call does:
 * one BEGIN/COMMIT, with every statement sent as its OWN command inside it. The transaction is
 * what makes this file's `SET LOCAL lock_timeout` and its all-or-nothing closing check meaningful.
 */
async function applyFile(file: string): Promise<void> {
  await client.query('BEGIN')
  try {
    for (const statement of splitSqlStatements(readFileSync(file, 'utf8')))
      await client.query(statement)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

/** `interview_stage` labels in sort order, read from the catalog rather than by using a value. */
async function stageOrder(): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = 'interview_stage'
      ORDER BY e.enumsortorder`,
    [SCHEMA],
  )
  return rows.map((r: { label: string }) => String(r.label))
}

async function columnShape(): Promise<
  { type: string; nullable: string; def: string | null } | undefined
> {
  const { rows } = await client.query(
    `SELECT data_type AS type, is_nullable AS nullable, column_default AS def
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'job_opportunity_id'`,
    [SCHEMA, TABLE],
  )
  const row = rows[0]
  if (row === undefined) return undefined
  return { type: String(row.type), nullable: String(row.nullable), def: row.def }
}

async function constraintDef(name: string): Promise<string | undefined> {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = $1 AND c.conname = $2 AND c.convalidated`,
    [SCHEMA, name],
  )
  const row = rows[0]
  return row === undefined ? undefined : String(row.def)
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await client.query(
    `SELECT indexdef AS def FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
    [SCHEMA, TABLE, name],
  )
  const row = rows[0]
  return row === undefined ? undefined : String(row.def).split(`${SCHEMA}.`).join('public.')
}

/** One card, returning its id; the caller decides whether the insert was supposed to work. */
async function insertCard(opportunityId: string | null, seniorId: string): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO ${SCHEMA}.${TABLE} (senior_id, company_name, stage, job_opportunity_id)
     VALUES ($1::uuid, 'Acme', 'SUBMITTED', $2::uuid) RETURNING id`,
    [seniorId, opportunityId],
  )
  return String(rows[0].id)
}

describe.skipIf(!hasDatabaseUrl())('task-sources-07c forward DDL: the senior card link', () => {
  const OPPORTUNITY = '6f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60'
  const SENIOR = '1a2b3c4d-5e6f-4071-8a92-b3c4d5e6f701'

  beforeAll(async () => {
    // `public` is the reference side (built by db:push): the declarations these files mirror must
    // be there, or the comparison below is against nothing.
    await assertRealDbSchema([{ table: TABLE, column: 'stage' }])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)

    // The pre-state: the enum WITHOUT SUBMITTED, and the two tables reduced to the columns these
    // files touch, with the real nullability and the real `stage` DEFAULT.
    await client.query(
      `CREATE TYPE ${SCHEMA}.interview_stage AS ENUM (${SHIPPED_STAGES.map((s) => `'${s}'`).join(', ')})`,
    )
    await client.query(
      `CREATE TABLE ${SCHEMA}.job_opportunities (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
    )
    await client.query(
      `CREATE TABLE ${SCHEMA}.${TABLE} (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         senior_id uuid NOT NULL,
         company_name varchar(255) NOT NULL,
         stage ${SCHEMA}.interview_stage NOT NULL DEFAULT 'HR_SCREEN')`,
    )

    // Deploy order, and each file twice: the deploy re-applies every manual file every time.
    await applyFile(ENUM_FILE)
    await applyFile(ENUM_FILE)
    await applyFile(COLUMN_FILE)
    await applyFile(COLUMN_FILE)

    await client.query(`INSERT INTO ${SCHEMA}.job_opportunities (id) VALUES ($1::uuid)`, [
      OPPORTUNITY,
    ])
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

  it('places SUBMITTED immediately before HR_SCREEN, in the order the Drizzle enum declares', async () => {
    expect(await stageOrder()).toEqual(EXPECTED_STAGES)
  })

  it('leaves the stage DEFAULT at HR_SCREEN — a hand-made card is not a submission', async () => {
    const { rows } = await client.query(
      `SELECT column_default AS def FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = 'stage'`,
      [SCHEMA, TABLE],
    )
    expect(String(rows[0].def)).toContain(`'HR_SCREEN'`)
  })

  it('adds job_opportunity_id as a NULLABLE uuid with no default', async () => {
    // Nullable with no default is what makes the file a no-op for every existing row: there is no
    // backfill, and inventing a vacancy link for a hand-made card would be a lie.
    expect(await columnShape()).toEqual({ type: 'uuid', nullable: 'YES', def: null })
  })

  it('references job_opportunities(id) ON DELETE SET NULL, never CASCADE', async () => {
    // SET NULL, so that if an opportunity is ever deleted the senior's card — with every note on
    // it — survives and merely stops knowing which vacancy it came from.
    expect(await constraintDef(FK)).toBe(
      'FOREIGN KEY (job_opportunity_id) REFERENCES job_opportunities(id) ON DELETE SET NULL',
    )
  })

  it('builds the unique index PARTIAL on (job_opportunity_id, senior_id)', async () => {
    const def = await indexDef(INDEX)
    expect(def).toBeDefined()
    expect(def).toContain('CREATE UNIQUE INDEX')
    expect(def).toContain('(job_opportunity_id, senior_id)')
    expect(def).toContain('WHERE (job_opportunity_id IS NOT NULL)')
  })

  it('rejects a second card for the same (opportunity, senior) pair', async () => {
    const first = await insertCard(OPPORTUNITY, SENIOR)
    expect(first).toBeTruthy()
    await expect(insertCard(OPPORTUNITY, SENIOR)).rejects.toThrow(
      /uq_interviews_job_opportunity_senior/,
    )
  })

  it('accepts any number of hand-made cards for one senior — the NULL side is exempt', async () => {
    // The ordinary case on this board: `job_opportunity_id IS NULL`, outside the predicate, so the
    // index constrains nothing. If this ever starts failing, the index lost its WHERE clause.
    const other = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b'
    await expect(insertCard(null, other)).resolves.toBeTruthy()
    await expect(insertCard(null, other)).resolves.toBeTruthy()
  })
})
