/**
 * SR-795-M-1 / SR-795-L-3 (task-retro-salary-ledger-integrity) — the DDL half,
 * executed rather than regex-matched.
 *
 * `2026-10-04_multiple_salary_transactions_prepare.sql` is replayed on EVERY
 * deploy (see its header and `scripts/devops/deploy-stack-on-vps.sh`), and this
 * task changes two things inside it:
 *
 *   - the marker backfill, which used to adopt only legacy/CRON salary months,
 *     now adopts a MANUAL part's month too (owner decision D-3). Without that,
 *     every manual part created BEFORE this fix keeps its month markerless and
 *     the next cron run still mints the second payable salary the finding is
 *     about — the fix would be true only for new data;
 *   - `ck_transactions_salary_origin_domain`, which is what actually refuses an
 *     out-of-domain `salary_origin`. `.$type<SalaryOrigin>()` constrains
 *     TypeScript; only the constraint constrains Postgres, and `drizzle-kit
 *     push` is not what production runs.
 *
 * A regex over the file text cannot tell a CHECK that refuses from one that is
 * present and inert, nor an INSERT…SELECT that adopts a row from one whose
 * predicate quietly excludes it. So the file is applied here, twice, and then
 * driven: replay is what the deploy does, so a second pass that is anything but
 * a no-op is itself the defect (AC2).
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { splitSqlStatements } from './manual-sql-statements'

const PREPARE_SQL = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-10-04_multiple_salary_transactions_prepare.sql',
)

const DOMAIN_CHECK = 'ck_transactions_salary_origin_domain'
const MANUAL_MONTH = '2098-07'
const ADJUSTED_MONTH = '2098-08'

let pool: Pool
let createdBy: string
const createdTxIds: string[] = []

async function q(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] }> {
  const res = await pool.query(sql, params)
  return { rows: res.rows as Record<string, unknown>[] }
}

async function applyPrepare(): Promise<void> {
  const sql = readFileSync(PREPARE_SQL, 'utf8')
  for (const statement of splitSqlStatements(sql)) {
    await pool.query(statement)
  }
}

async function insertSalary(month: string, origin: string | null): Promise<string> {
  const id = randomUUID()
  await q(
    `INSERT INTO transactions (id, type, status, amount, currency, created_by,
                               receiver_id, salary_month, salary_origin, idempotency_key,
                               created_at, updated_at)
     VALUES ($1, 'SALARY', 'PENDING', '500.000000', 'USD', $2,
             $2, $3, $4, $5, now(), now())`,
    [id, createdBy, month, origin, origin === 'MANUAL' ? randomUUID() : null],
  )
  createdTxIds.push(id)
  return id
}

async function markerCount(month: string): Promise<number> {
  const { rows } = await q(
    `SELECT count(*)::int AS c FROM salary_month_initializations
      WHERE receiver_id = $1 AND salary_month = $2`,
    [createdBy, month],
  )
  return rows[0]!['c'] as number
}

describe.skipIf(!hasDatabaseUrl())('multipart salary prepare DDL (real DB)', () => {
  beforeAll(async () => {
    await assertRealDbSchema([{ table: 'transactions', column: 'salary_origin' }])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q('SELECT current_database() AS db, version() AS v')
    if (rows[0]!['db'] === 'crm_db') throw new Error('refusing to run against the live crm_db')
    // A writing spec states which database it writes to: two PostgreSQL
    // instances answer on 5432 on the dev machine.
    console.log(`[SR-795-M-1] database=${rows[0]!['db']} ${String(rows[0]!['v']).split(',')[0]}`)

    const { rows: actors } = await q(`SELECT id FROM users LIMIT 1`)
    const actor = actors[0]?.['id']
    if (actor === undefined) throw new Error('no seeded user to own the rows')
    createdBy = actor as string

    // Pre-fix shape of the data this migration has to repair: a manual part
    // whose month nobody ever claimed.
    await q(
      `DELETE FROM salary_month_initializations
        WHERE receiver_id = $1 AND salary_month = ANY($2::varchar[])`,
      [createdBy, [MANUAL_MONTH, ADJUSTED_MONTH]],
    )
    await insertSalary(MANUAL_MONTH, 'MANUAL')
    await insertSalary(ADJUSTED_MONTH, 'ADJUSTED')

    await applyPrepare()
    await applyPrepare()
  }, 60_000)

  afterAll(async () => {
    if (pool === undefined) return
    if (createdTxIds.length > 0) {
      await q(`DELETE FROM transactions WHERE id = ANY($1::uuid[])`, [createdTxIds])
    }
    if (createdBy !== undefined) {
      await q(
        `DELETE FROM salary_month_initializations
          WHERE receiver_id = $1 AND salary_month = ANY($2::varchar[])`,
        [createdBy, [MANUAL_MONTH, ADJUSTED_MONTH]],
      )
    }
    await pool.end()
  })

  it('adopts a pre-existing MANUAL part’s month as initialized (D-3 transition)', async () => {
    expect(await markerCount(MANUAL_MONTH)).toBe(1)
  })

  it('does NOT let an ADJUSTED row claim a month', async () => {
    // An ADJUSTED row exists because another row already owned its month; a
    // replay must not hand it a slot it lost.
    expect(await markerCount(ADJUSTED_MONTH)).toBe(0)
  })

  it('a further replay changes nothing (the deploy replays this file every release)', async () => {
    const { rows: before } = await q(`SELECT count(*)::int AS c FROM salary_month_initializations`)
    await applyPrepare()
    const { rows: after } = await q(`SELECT count(*)::int AS c FROM salary_month_initializations`)
    expect(after[0]!['c']).toBe(before[0]!['c'])
  }, 60_000)

  it('installs the salary_origin domain CHECK as VALIDATED, and it refuses', async () => {
    const { rows } = await q(
      `SELECT convalidated FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'transactions'::regclass`,
      [DOMAIN_CHECK],
    )
    expect(rows[0]?.['convalidated']).toBe(true)

    await expect(insertSalary(MANUAL_MONTH, 'Manual')).rejects.toMatchObject({
      code: '23514',
      constraint: DOMAIN_CHECK,
    })
  })

  it('accepts every member of the domain, and NULL', async () => {
    // A CHECK that refused a legal value would be just as wrong, and the
    // refusal above cannot tell the two apart on its own.
    for (const origin of ['MANUAL', 'CRON', 'ADJUSTED', null]) {
      await expect(insertSalary('2098-09', origin)).resolves.toMatch(/^[0-9a-f-]{36}$/)
    }
  })
})
