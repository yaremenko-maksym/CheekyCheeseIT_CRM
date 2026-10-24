/**
 * CR-795-H-1 / SR-866-M-1 (retro of PRs #795 and #866) — the manual prod DDL that
 * production actually runs, replayed in the order production runs it, on a database
 * that starts in the PRE-#795 shape.
 *
 * Why this spec exists
 * --------------------
 * Production does not run `drizzle-kit push`. `deploy.yml` / `deploy-stack-on-vps.sh`
 * apply `drizzle/manual/*.sql` with `psql`, and the July audit-hardening file is
 * replayed on EVERY deploy. CI builds its database with `db:push`, so before this spec
 * nothing executed the multipart-salary PREPARE/ACTIVATE pair at all, and the only
 * guard against the July file re-creating the retired
 * `uq_transactions_salary_receiver_month` was a regex over its text. A regex cannot
 * tell a gate that holds from one that is present and inert.
 *
 * What is replayed, and in which order (the deploy order, with the replays)
 *   1. July DDL        — on a pre-#795 database it legitimately creates the legacy index
 *   2. PREPARE         — marker table + backfill, KEEPS the legacy index (old API still up)
 *   3. PREPARE again   — deploys re-run it; must be a no-op
 *   4. ACTIVATE        — retires the legacy index (new API is up)
 *   5. July DDL again  — the next deploy; the transition gate must NOT bring the index back
 *
 * The database is a SCRATCH DATABASE created here (not a schema): both files address
 * `public.` explicitly (`to_regclass('public.salary_month_initializations')`), so an
 * isolated schema would test a different statement than production runs. The pre-#795
 * tables are hand-built minimal shapes (only what the files touch). The expected
 * catalog definitions are NOT written out here: they come from `public` of the
 * `DATABASE_URL` database, which CI builds with `db:push` from `schema.ts`.
 *
 * Safety: the scratch name is `crm_scratch_ddlreplay_<random>`, creation is refused if
 * `DATABASE_URL` names `crm_db`, and the database is dropped in `afterAll`.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'
import { splitSqlStatements } from './manual-sql-statements'

const MANUAL_DIR = join(import.meta.dirname, '../../drizzle/manual')
const JULY_SQL = join(MANUAL_DIR, '2026-07-04_audit_hardening_constraints.sql')
const PREPARE_SQL = join(MANUAL_DIR, '2026-10-04_multiple_salary_transactions_prepare.sql')
const ACTIVATE_SQL = join(MANUAL_DIR, '2026-10-04_multiple_salary_transactions_activate.sql')

const RETIRED_INDEX = 'uq_transactions_salary_receiver_month'
const LOOKUP_INDEX = 'idx_transactions_salary_receiver_month'
const SCRATCH_NAME = /^crm_scratch_ddlreplay_[0-9a-f]{12}$/

/** Indexes the replay must leave defined exactly as `schema.ts` (via `db:push`) declares. */
const SCHEMA_INDEXES = [
  LOOKUP_INDEX,
  'uq_transactions_salary_idempotency_key',
  'uq_transactions_dividend_idempotency_key',
  'uq_salary_month_initializations_receiver_month',
]
// The remaining July indexes filter on columns that are enums in `schema.ts` but stubbed
// as plain varchar in the scratch shape, so their `indexdef` text differs for reasons
// that are the stub's, not the SQL's. They are asserted PRESENT, not compared.
const JULY_ONLY_INDEXES = [
  'uq_pending_obligations_source_pending',
  'employee_contracts_one_per_user',
  'uq_contract_templates_active_role',
  'uq_tos_versions_active',
  'uq_interviews_created_project_id',
]
const SCHEMA_CONSTRAINTS = [
  'ck_transactions_manual_salary_idempotency_key',
  'ck_transactions_salary_origin_domain',
]

// Two legacy receivers, each holding exactly one SALARY row for one month (the
// pre-multipart unique index made that the only possible state).
const MONTH_A = '2098-01'
const MONTH_B = '2098-02'

interface Snapshot {
  retiredIndexPresent: boolean
  salaryOriginColumnPresent: boolean
  markerTableExists: boolean
  markers: number
}

let adminPool: Pool
let scratchPool: Pool
let scratchName: string
let receiverA: string
let receiverB: string
/** The legacy index exactly as Postgres reports it while it exists (captured, not invented). */
let retiredIndexDef: string
const snapshots: Record<string, Snapshot> = {}

async function applyFile(file: string): Promise<void> {
  const client = await scratchPool.connect()
  try {
    // One statement per message, autocommit between them — what `psql < file` does.
    for (const statement of splitSqlStatements(readFileSync(file, 'utf8'))) {
      await client.query(statement)
    }
  } finally {
    client.release()
  }
}

async function snapshot(): Promise<Snapshot> {
  const idx = await scratchPool.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
    [RETIRED_INDEX],
  )
  const col = await scratchPool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='transactions' AND column_name='salary_origin'`,
  )
  const reg = await scratchPool.query(
    `SELECT to_regclass('public.salary_month_initializations') IS NOT NULL AS ok`,
  )
  const markerTableExists = reg.rows[0].ok as boolean
  const markers = markerTableExists
    ? ((await scratchPool.query(`SELECT count(*)::int AS c FROM salary_month_initializations`))
        .rows[0].c as number)
    : 0
  return {
    retiredIndexPresent: idx.rowCount === 1,
    salaryOriginColumnPresent: col.rowCount === 1,
    markerTableExists,
    markers,
  }
}

/** Pre-#795 shape: no salary_origin, no idempotency_key, no marker table, no lookup index. */
async function buildPreMultipartShape(enumLabels: string[]): Promise<void> {
  const labels = enumLabels.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')
  await scratchPool.query(`CREATE TYPE transaction_type AS ENUM (${labels})`)
  await scratchPool.query(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE interviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE pending_obligations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_transaction_id uuid, status varchar(20) NOT NULL DEFAULT 'PENDING');
    CREATE TABLE employee_contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid, status varchar(20) NOT NULL DEFAULT 'DRAFT');
    CREATE TABLE contract_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target_role varchar(20), is_active boolean NOT NULL DEFAULT false);
    CREATE TABLE tos_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      is_active boolean NOT NULL DEFAULT false);
    CREATE TABLE transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type transaction_type NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'PENDING',
      amount numeric(18,6) NOT NULL,
      currency varchar(8) NOT NULL DEFAULT 'USD',
      created_by uuid REFERENCES users(id),
      receiver_id uuid REFERENCES users(id),
      salary_month varchar(7),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE VIEW non_deleted_transactions AS
      SELECT * FROM transactions WHERE deleted_at IS NULL;
  `)
}

async function insertLegacySalary(receiver: string, month: string): Promise<void> {
  await scratchPool.query(
    `INSERT INTO transactions (type, amount, created_by, receiver_id, salary_month)
     VALUES ('SALARY', '500.000000', $1, $1, $2)`,
    [receiver, month],
  )
}

function urlFor(database: string): string {
  const url = new URL(process.env['DATABASE_URL']!)
  url.pathname = `/${database}`
  return url.toString()
}

// A pooled idle client terminated by `DROP DATABASE ... WITH (FORCE)` emits 'error' on its Pool;
// without a listener Node treats that as an unhandled event. Log the message only (never the URL).
const onPoolError = (err: Error): void => {
  console.warn(`[manual-ddl-replay] pool error ignored: ${err.message}`)
}

describe.skipIf(!hasDatabaseUrl())('manual salary DDL replay on a pre-#795 database', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    adminPool.on('error', onPoolError)
    const who = await adminPool.query('SELECT current_database() AS db, version() AS v')
    if (who.rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    console.log(
      `[manual-ddl-replay] database=${who.rows[0].db} ${String(who.rows[0].v).split(',')[0]}`,
    )

    // Reference side: the enum as `db:push` created it, so the scratch type is not invented.
    const { rows: labelRows } = await adminPool.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname='public' AND t.typname='transaction_type' ORDER BY e.enumsortorder`,
    )
    if (labelRows.length === 0)
      throw new Error('public.transaction_type missing: run db:push first')

    scratchName = `crm_scratch_ddlreplay_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    if (!SCRATCH_NAME.test(scratchName)) throw new Error(`bad scratch name ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    scratchPool = new Pool({ connectionString: urlFor(scratchName) })
    scratchPool.on('error', onPoolError)
    const check = await scratchPool.query('SELECT current_database() AS db')
    if (check.rows[0].db !== scratchName) throw new Error('scratch connection landed elsewhere')

    await buildPreMultipartShape(labelRows.map((r: { enumlabel: string }) => r.enumlabel))
    const a = await scratchPool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)
    const b = await scratchPool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)
    receiverA = a.rows[0].id as string
    receiverB = b.rows[0].id as string

    // Pre-#795 production: the July DDL runs first and, with no marker table, creates the
    // legacy unique index; only then can legacy salary rows exist one-per-month.
    await applyFile(JULY_SQL)
    snapshots['afterJuly1'] = await snapshot()
    await insertLegacySalary(receiverA, MONTH_A)
    await insertLegacySalary(receiverB, MONTH_B)
    // Rows the backfill must NOT turn into markers: a SALARY row without a month,
    // and a non-SALARY row that happens to carry a month.
    await scratchPool.query(
      `INSERT INTO transactions (type, amount, created_by, receiver_id, salary_month)
       VALUES ('SALARY', '1.000000', $1, $1, NULL),
              ('DIVIDEND_TO_ADMIN', '1.000000', $1, $1, '2098-03')`,
      [receiverA],
    )

    await applyFile(PREPARE_SQL)
    snapshots['afterPrepare1'] = await snapshot()
    // PREPARE keeps the legacy index, so this is its real definition from the replay.
    const legacyDef = await scratchPool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
      [RETIRED_INDEX],
    )
    retiredIndexDef = legacyDef.rows[0].indexdef as string
    await applyFile(PREPARE_SQL)
    snapshots['afterPrepare2'] = await snapshot()
    await applyFile(ACTIVATE_SQL)
    snapshots['afterActivate'] = await snapshot()
    await applyFile(JULY_SQL)
    snapshots['afterJuly2'] = await snapshot()
  }, 120_000)

  afterAll(async () => {
    if (scratchPool !== undefined) await scratchPool.end()
    if (adminPool !== undefined) {
      if (scratchName !== undefined && SCRATCH_NAME.test(scratchName)) {
        await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
      }
      await adminPool.end()
    }
  })

  it('starts from the real pre-#795 shape (harness precondition)', () => {
    // Without these the replay would prove nothing: the legacy index must really have
    // existed, and neither the column nor the marker table may predate PREPARE.
    expect(snapshots['afterJuly1']).toMatchObject({
      retiredIndexPresent: true,
      salaryOriginColumnPresent: false,
      markerTableExists: false,
    })
  })

  it('PREPARE writes exactly one marker per legacy receiver/month', () => {
    expect(snapshots['afterPrepare1']!.markers).toBe(2)
  })

  it('PREPARE keeps the legacy index (the old API image is still serving)', () => {
    expect(snapshots['afterPrepare1']!.retiredIndexPresent).toBe(true)
  })

  it('PREPARE replayed changes nothing', () => {
    expect(snapshots['afterPrepare2']).toEqual(snapshots['afterPrepare1'])
  })

  it('every marker belongs to a legacy SALARY receiver/month, none to other rows', async () => {
    const { rows } = await scratchPool.query(
      `SELECT receiver_id, salary_month FROM salary_month_initializations ORDER BY salary_month`,
    )
    expect(rows).toEqual([
      { receiver_id: receiverA, salary_month: MONTH_A },
      { receiver_id: receiverB, salary_month: MONTH_B },
    ])
  })

  it('ACTIVATE retires the legacy index', () => {
    expect(snapshots['afterActivate']!.retiredIndexPresent).toBe(false)
  })

  it('the next deploy (July DDL replayed) does NOT re-create the retired index', async () => {
    expect(snapshots['afterJuly2']!.retiredIndexPresent).toBe(false)
    const { rows } = await scratchPool.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
      RETIRED_INDEX,
    ])
    expect(rows).toHaveLength(0)
  })

  it('the July replay leaves the marker count unchanged', () => {
    expect(snapshots['afterJuly2']!.markers).toBe(snapshots['afterPrepare1']!.markers)
  })

  it('the non_deleted_transactions view exposes salary_origin', async () => {
    const { rows } = await scratchPool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='non_deleted_transactions'
          AND column_name='salary_origin'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('a SECOND SALARY row for the same receiver/month inserts', async () => {
    const insert = (key: string | null, origin: string) =>
      scratchPool.query(
        `INSERT INTO transactions (type, amount, created_by, receiver_id, salary_month,
                                   salary_origin, idempotency_key)
         VALUES ('SALARY', '250.000000', $1, $1, $2, $3, $4)`,
        [receiverA, MONTH_A, origin, key],
      )
    await expect(insert(randomUUID(), 'MANUAL')).resolves.toBeDefined()
    await expect(insert(randomUUID(), 'MANUAL')).resolves.toBeDefined()
  })

  it('index definitions equal what schema.ts declares (db:push reference)', async () => {
    const defs = async (pool: Pool) =>
      (
        await pool.query(
          `SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname='public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
          [SCHEMA_INDEXES],
        )
      ).rows
    const expected = await defs(adminPool)
    expect(expected.map((r: { indexname: string }) => r.indexname)).toEqual(
      [...SCHEMA_INDEXES].sort(),
    )
    expect(await defs(scratchPool)).toEqual(expected)
  })

  it('the other July indexes exist after the replay', async () => {
    const { rows } = await scratchPool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [JULY_ONLY_INDEXES],
    )
    expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual(
      [...JULY_ONLY_INDEXES].sort(),
    )
  })

  it('constraint definitions equal what schema.ts declares (db:push reference)', async () => {
    const defs = async (pool: Pool) =>
      (
        await pool.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
            WHERE conrelid = 'public.transactions'::regclass AND conname = ANY($1::text[])
            ORDER BY conname`,
          [SCHEMA_CONSTRAINTS],
        )
      ).rows
    const expected = await defs(adminPool)
    expect(expected).toHaveLength(SCHEMA_CONSTRAINTS.length)
    expect(await defs(scratchPool)).toEqual(expected)
  })

  async function transactionsIndexes(): Promise<{ indexname: string; indexdef: string }[]> {
    return (
      await scratchPool.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname='public' AND tablename='transactions' ORDER BY indexname`,
      )
    ).rows
  }

  it('ACTIVATE applied a SECOND time is a no-op (it is re-run on every deploy)', async () => {
    const before = await transactionsIndexes()
    await applyFile(ACTIVATE_SQL)
    const after = await transactionsIndexes()
    expect(after).toEqual(before)
    const names = after.map((r) => r.indexname)
    expect(names).not.toContain(RETIRED_INDEX)
    expect(names).toContain(LOOKUP_INDEX)
  })

  it('ACTIVATE self-heals a retired index re-created by a restore or a bad replay', async () => {
    // A unique index over (receiver_id, salary_month) cannot be built while duplicate
    // SALARY rows exist, and the test above this one inserted two. Remove only the rows
    // added after the legacy ones (they carry an idempotency key; legacy rows do not),
    // leaving the one-per-month legacy state a restore of old data would have.
    await scratchPool.query(
      `DELETE FROM transactions
        WHERE type='SALARY' AND receiver_id=$1 AND salary_month=$2 AND idempotency_key IS NOT NULL`,
      [receiverA, MONTH_A],
    )
    await scratchPool.query(retiredIndexDef)
    expect((await transactionsIndexes()).map((r) => r.indexname)).toContain(RETIRED_INDEX)

    // Precondition with teeth: while the index is back, a second row for the same
    // receiver/month is really refused.
    const insertSecond = () =>
      scratchPool.query(
        `INSERT INTO transactions (type, amount, created_by, receiver_id, salary_month,
                                   salary_origin, idempotency_key)
         VALUES ('SALARY', '250.000000', $1, $1, $2, 'MANUAL', $3)`,
        [receiverA, MONTH_A, randomUUID()],
      )
    await expect(insertSecond()).rejects.toMatchObject({ code: '23505' })

    await applyFile(ACTIVATE_SQL)

    const names = (await transactionsIndexes()).map((r) => r.indexname)
    expect(names).not.toContain(RETIRED_INDEX)
    expect(names).toContain(LOOKUP_INDEX)
    await expect(insertSecond()).resolves.toBeDefined()
  })
})
