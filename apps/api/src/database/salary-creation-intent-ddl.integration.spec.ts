/**
 * SR-M-1 (PR #868 fix round 1). The immutability of `transactions.salary_creation_intent`
 * was asserted only by a REGEX over the DDL text, and `drizzle-kit push` installs no
 * trigger — so the guarantee the replay comparison leans on executed on no database in
 * any run. A text match cannot tell a trigger that fires from one that is syntactically
 * present and semantically inert.
 *
 * So this file APPLIES `drizzle/manual/2026-10-10_salary_creation_intent.sql` to the real
 * scratch database, exactly as `psql < file` would, and then drives the trigger:
 *   - changing the column is refused (that is the invariant);
 *   - an UPDATE that leaves it alone still works (a trigger that refused every update
 *     would break ordinary edits, and a text match would not notice);
 *   - the `non_deleted_transactions` view carries the new column, which is the other half
 *     of the file — PostgreSQL freezes a `SELECT *` column list at CREATE time, so
 *     appending a physical column without refreshing the view leaves it invisible.
 * The file is applied TWICE: idempotency is what the deploy replays on every release.
 *
 * The trigger is left installed. It is what production has, it only fires on
 * `UPDATE OF salary_creation_intent`, and it refuses only when the value actually
 * changes — no other spec in the suite touches that column.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import { splitSqlStatements } from './manual-sql-statements'

const INTENT_SQL = join(
  import.meta.dirname,
  '../../drizzle/manual/2026-10-10_salary_creation_intent.sql',
)

const TRIGGER = 'trg_transactions_salary_creation_intent_immutable'

let pool: Pool
let txId: string

async function q(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] }> {
  const res = await pool.query(sql, params)
  return { rows: res.rows as Record<string, unknown>[] }
}

async function applyFile(file: string): Promise<void> {
  const sql = readFileSync(file, 'utf8')
  for (const statement of splitSqlStatements(sql)) {
    await pool.query(statement)
  }
}

const INTENT = {
  version: 1,
  operation: 'MANUAL_SALARY_CREATE',
  receiverId: 'e7b1c2d3-4455-4667-8899-aabbccddeeff',
  amount: '1500.000000',
  currency: 'USD',
  salaryMonth: '2099-09',
  notes: null,
  txDate: 'AUTO',
}

describe.skipIf(!hasDatabaseUrl())('salary_creation_intent manual DDL (real DB)', () => {
  beforeAll(async () => {
    await assertRealDbSchema([{ table: 'transactions', column: 'salary_creation_intent' }])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q('SELECT current_database() AS db, version() AS v')
    if (rows[0]!['db'] === 'crm_db') throw new Error('refusing to run against the live crm_db')
    // A writing spec states which database it writes to: two PostgreSQL instances
    // answer on 5432 on the dev machine.
    console.log(`[SR-M-1] database=${rows[0]!['db']} ${String(rows[0]!['v']).split(',')[0]}`)

    // Applied twice: the deploy replays this file on every release, so a second pass
    // that is anything but a no-op is itself the defect.
    await applyFile(INTENT_SQL)
    await applyFile(INTENT_SQL)

    const { rows: actors } = await q(`SELECT id FROM users LIMIT 1`)
    const createdBy = actors[0]?.['id']
    if (createdBy === undefined) throw new Error('no seeded user to own the row')

    txId = randomUUID()
    await q(
      `INSERT INTO transactions (id, type, status, amount, currency, created_by,
                                 salary_month, salary_origin, idempotency_key,
                                 salary_creation_intent, created_at, updated_at)
       VALUES ($1, 'SALARY', 'PENDING', '1500.000000', 'USD', $2,
               '2099-09', 'MANUAL', $3, $4::jsonb, now(), now())`,
      [txId, createdBy, randomUUID(), JSON.stringify(INTENT)],
    )
  })

  afterAll(async () => {
    if (pool !== undefined) {
      if (txId !== undefined) await q(`DELETE FROM transactions WHERE id = $1`, [txId])
      await pool.end()
    }
  })

  it('installs the immutability trigger as enabled (not merely present in the file text)', async () => {
    const { rows } = await q(
      `SELECT t.tgenabled::text AS enabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'transactions' AND t.tgname = $1`,
      [TRIGGER],
    )
    // 'O' = enabled for origin-and-local writes, i.e. it fires for ordinary statements.
    expect(rows[0]?.['enabled']).toBe('O')
  })

  it('refuses an UPDATE that changes the stored intent', async () => {
    const changed = { ...INTENT, amount: '1499.000000' }
    const attempt = q(`UPDATE transactions SET salary_creation_intent = $2::jsonb WHERE id = $1`, [
      txId,
      JSON.stringify(changed),
    ])
    await expect(attempt).rejects.toMatchObject({
      // The DDL raises with ERRCODE = 'check_violation'.
      code: '23514',
      message: expect.stringContaining('salary_creation_intent is immutable'),
    })

    // And the stored value is untouched, which is the point of the refusal.
    const { rows } = await q(
      `SELECT salary_creation_intent AS intent FROM transactions WHERE id = $1`,
      [txId],
    )
    expect(rows[0]?.['intent']).toEqual(INTENT)
  })

  it('refuses setting the intent back to NULL', async () => {
    const attempt = q(`UPDATE transactions SET salary_creation_intent = NULL WHERE id = $1`, [txId])
    await expect(attempt).rejects.toMatchObject({ code: '23514' })
  })

  it('still allows an UPDATE that leaves the intent alone', async () => {
    // A trigger that refused every update would break every ordinary edit, and the
    // regex guard this spec replaces could not tell the two apart.
    await q(`UPDATE transactions SET notes = $2 WHERE id = $1`, [txId, 'ordinary edit'])
    const { rows } = await q(`SELECT notes FROM transactions WHERE id = $1`, [txId])
    expect(rows[0]?.['notes']).toBe('ordinary edit')
  })

  it('allows writing the SAME intent again (IS DISTINCT FROM, not a blanket refusal)', async () => {
    await q(`UPDATE transactions SET salary_creation_intent = $2::jsonb WHERE id = $1`, [
      txId,
      JSON.stringify(INTENT),
    ])
    const { rows } = await q(
      `SELECT salary_creation_intent AS intent FROM transactions WHERE id = $1`,
      [txId],
    )
    expect(rows[0]?.['intent']).toEqual(INTENT)
  })

  it('exposes the column through the refreshed non_deleted_transactions view', async () => {
    const { rows } = await q(
      `SELECT salary_creation_intent AS intent FROM non_deleted_transactions WHERE id = $1`,
      [txId],
    )
    expect(rows[0]?.['intent']).toEqual(INTENT)
  })
})
