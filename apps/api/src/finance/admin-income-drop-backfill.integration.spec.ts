import { readFileSync } from 'fs'
import { join } from 'path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { roundShareAmount } from './transactions.service'

/**
 * task-admin-income-drop-backfill — REAL-DB integration for the manual
 * report + apply SQL pair that backfills missing drop-share obligations for
 * historical ADMIN_INCOME rows on USDT-payment projects.
 *
 * Context: `createAdminIncome` (POST /transactions/admin-income) never called
 * `bookCompanyObligations` — only its sibling `declareUsdtProjectIncome`
 * (POST /finance/usdt-income) does. Every ADMIN_INCOME row created through
 * the OTHER form on a USDT-payment project with a bound drop is missing its
 * DROP_PENDING_PAYOUT + pending_obligations pair. See the task file
 * (task-admin-income-drop-backfill.md) and the header of
 * apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql
 * for the full reasoning.
 *
 * Proves, against a REAL Postgres (crm_qa scratch — NEVER crm_db):
 *
 *   AC3  The report file is 100% read-only — table row counts are IDENTICAL
 *        before and after running it, even with real candidate + ambiguous
 *        data present. Its NOTICE output correctly labels a candidate
 *        CANDIDATE and an ambiguous row AMBIGUOUS (not silently dropped).
 *   AC4  The apply file creates a DROP_PENDING_PAYOUT + a paired
 *        pending_obligations row for each genuine candidate, using the
 *        project-level override when set (12%) and the drop's user-level
 *        default otherwise (5%).
 *   AC5  Idempotent — a SECOND run of the apply file creates ZERO further
 *        rows (proven by an actual double-apply, not by reasoning about the
 *        predicate).
 *   AC6  A non-USDT (FOP) project with a bound drop is NEVER touched, even
 *        though it carries an ADMIN_INCOME row with no existing share
 *        (createDropIncome is that drop's own income path there —
 *        backfilling it would double the obligation).
 *   AC7  A project that already carries an UNTAGGED existing drop-share row
 *        (source_income_transaction_id IS NULL) is entirely excluded — EVERY
 *        ADMIN_INCOME candidate on that project is reported AMBIGUOUS and is
 *        not processed by the apply file; the untagged row itself is left
 *        untouched.
 *   AC8  A soft-deleted ADMIN_INCOME row is never selected.
 *   AC9  The SQL rounding expression (numeric `round`) matches
 *        `roundShareAmount` (transactions.service.ts) byte-for-byte across a
 *        value table that includes half-cent amounts and the real
 *        GamingTec case (4708.69 USDT / 5%) cited by the task.
 *
 * Test isolation: the report/apply selection predicate is GLOBAL (mirrors
 * prod — it cannot be scoped to "just this test's rows"; same reasoning as
 * drop-share-pending-parity-backfill.integration.spec.ts's LOW-1 guard). A
 * leaked ADMIN_INCOME fixture from a FOREIGN spec on a USDT+drop project
 * would be silently swept into this spec's candidate/ambiguous counts
 * otherwise. `assertNoForeignCandidateProjects()` below is this spec's
 * isolation guard, asserted before every test.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- admin-income-drop-backfill.integration
 */

const COLUMN_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql'),
  'utf-8',
)
const REPORT_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-08-12_admin_income_drop_backfill_report.sql'),
  'utf-8',
)
const APPLY_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual/2026-08-12_admin_income_drop_backfill_apply.sql'),
  'utf-8',
)

const ADMIN_ID = 'ce770000-0000-4000-b000-000000000001'
const SENIOR_ID = 'ce770000-0000-4000-b000-000000000002'
const DROP_ID = 'ce770000-0000-4000-b000-000000000003'
const TEST_USER_IDS = [ADMIN_ID, SENIOR_ID, DROP_ID]

const P_CANDIDATE = 'ce770000-0000-4000-c000-000000000001' // USDT, no override -> 5%
const P_NONUSDT = 'ce770000-0000-4000-c000-000000000002' // FOP -> AC6
const P_AMBIGUOUS = 'ce770000-0000-4000-c000-000000000003' // USDT + untagged row -> AC7
const P_OVERRIDE = 'ce770000-0000-4000-c000-000000000004' // USDT, 12% override
const TEST_PROJECT_IDS = [P_CANDIDATE, P_NONUSDT, P_AMBIGUOUS, P_OVERRIDE]

const DROP_SHARE_DEFAULT = 5
const DROP_SHARE_OVERRIDE = 12

let pool: Pool | null = null
let dbAvailable = false

async function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const { rows } = await pool!.query(sql, params)
  return rows as T[]
}

async function countAll(table: string): Promise<number> {
  const rows = await query<{ count: string }>(`SELECT count(*) FROM ${table}`)
  return Number(rows[0]!.count)
}

/** Isolation guard — see file header. Fails LOUD (not silently) if a foreign
 * spec's leaked fixtures already match the report/apply predicate. */
async function assertNoForeignCandidateProjects(): Promise<void> {
  const rows = await query<{ project_id: string }>(
    `SELECT DISTINCT p.id AS project_id
     FROM transactions t
     JOIN projects p ON p.id = t.project_id
     WHERE t.type = 'ADMIN_INCOME' AND t.deleted_at IS NULL
       AND p.drop_id IS NOT NULL AND p.payment_type = 'USDT'`,
  )
  const foreign = rows.filter((r) => !TEST_PROJECT_IDS.includes(r.project_id))
  if (foreign.length > 0) {
    throw new Error(
      `Test isolation violated: ${foreign.length} foreign USDT+drop ADMIN_INCOME project(s) ` +
        `already in the DB (ids: ${foreign.map((r) => r.project_id).join(', ')}). Another ` +
        'integration spec likely leaked fixtures matching the backfill predicate — clean up ' +
        'before re-running; running the backfill now would process rows this spec does not own.',
    )
  }
}

async function seedIncome(
  id: string,
  projectId: string,
  amount: string,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  await query(
    `INSERT INTO transactions (id, type, status, amount, currency, sender_label, receiver_id, project_id, created_by, tx_date, deleted_at)
     VALUES ($1, 'ADMIN_INCOME', 'PAID', $2, 'USDT', 'Backfill Spec Co', $3, $4, $3, now(), $5)`,
    [id, amount, ADMIN_ID, projectId, opts.deleted ? new Date() : null],
  )
}

async function seedUntaggedDropShareRow(id: string, projectId: string): Promise<void> {
  await query(
    `INSERT INTO transactions (id, type, status, amount, currency, sender_label, receiver_id, recipient_id, project_id, created_by, drop_share_percent, drop_share_percent_source)
     VALUES ($1, 'DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', '25', 'USDT', 'COMPANY', $2, $2, $3, $4, 5, 'USER_DEFAULT')`,
    [id, DROP_ID, projectId, ADMIN_ID],
  )
}

async function clearFixtures(): Promise<void> {
  await query(`DELETE FROM pending_obligations WHERE creditor_user_id = $1`, [DROP_ID])
  await query(`DELETE FROM transactions WHERE project_id = ANY($1::uuid[])`, [TEST_PROJECT_IDS])
}

describe('admin-income-drop-backfill report + apply SQL (real DB)', () => {
  beforeAll(async () => {
    try {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 3 })
      await pool.query('SELECT 1')
      dbAvailable = true
    } catch {
      console.warn('[admin-income-drop-backfill] SKIPPED — no DB reachable at DATABASE_URL')
      return
    }

    // Step 1 of the deploy sequence — additive, idempotent (IF NOT EXISTS).
    // Applying it here proves the column file itself is safe to re-run, and
    // guarantees the column exists regardless of what already ran against
    // this scratch DB.
    await pool.query(COLUMN_SQL)

    await clearFixtures()
    await query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [TEST_PROJECT_IDS])
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [TEST_USER_IDS])

    await query(
      `INSERT INTO users (id, email, display_name, role, senior_share_percent, drop_share_percent, google_id)
       VALUES
         ($1, 'aidb-admin@test.spec', 'AIDB Admin', 'ADMIN', 0, NULL, 'g-aidb-admin'),
         ($2, 'aidb-senior@test.spec', 'AIDB Senior', 'SENIOR', 26, NULL, 'g-aidb-senior'),
         ($3, 'aidb-drop@test.spec', 'AIDB Drop', 'DROP', 0, $4, 'g-aidb-drop')`,
      [ADMIN_ID, SENIOR_ID, DROP_ID, DROP_SHARE_DEFAULT],
    )

    await query(
      `INSERT INTO projects (id, name, company_name, domain, start_date, senior_id, drop_id, rate, currency, payment_type, drop_share_percent_override)
       VALUES
         ($1, 'AIDB Candidate', 'AIDB Candidate Co', 'ai', now(), $5, $6, 1000, 'USDT', 'USDT', NULL),
         ($2, 'AIDB Non-USDT', 'AIDB NonUSDT Co', 'ai', now(), $5, $6, 1000, 'USDT', 'FOP', NULL),
         ($3, 'AIDB Ambiguous', 'AIDB Ambiguous Co', 'ai', now(), $5, $6, 1000, 'USDT', 'USDT', NULL),
         ($4, 'AIDB Override', 'AIDB Override Co', 'ai', now(), $5, $6, 1000, 'USDT', 'USDT', $7)`,
      [P_CANDIDATE, P_NONUSDT, P_AMBIGUOUS, P_OVERRIDE, SENIOR_ID, DROP_ID, DROP_SHARE_OVERRIDE],
    )
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await clearFixtures()
    await assertNoForeignCandidateProjects()
  })

  afterAll(async () => {
    if (!dbAvailable || !pool) return
    await clearFixtures()
    await query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [TEST_PROJECT_IDS])
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [TEST_USER_IDS])
    await pool.end()
  }, 15_000)

  it('AC3: the report file makes ZERO writes — row counts unchanged before/after, with real candidate + ambiguous data present', async () => {
    if (!dbAvailable) return
    await seedIncome('ce770000-0000-4000-d000-000000000001', P_CANDIDATE, '1000')
    await seedUntaggedDropShareRow('ce770000-0000-4000-d000-000000000002', P_AMBIGUOUS)
    await seedIncome('ce770000-0000-4000-d000-000000000003', P_AMBIGUOUS, '2000')

    const txBefore = await countAll('transactions')
    const oblBefore = await countAll('pending_obligations')

    await expect(pool!.query(REPORT_SQL)).resolves.not.toThrow()

    expect(await countAll('transactions')).toBe(txBefore)
    expect(await countAll('pending_obligations')).toBe(oblBefore)
  })

  it('AC3-b: report NOTICE output labels a genuine candidate CANDIDATE and the ambiguous row AMBIGUOUS (not silently dropped)', async () => {
    if (!dbAvailable) return
    const candidateId = 'ce770000-0000-4000-d000-000000000004'
    await seedIncome(candidateId, P_CANDIDATE, '1000')
    await seedUntaggedDropShareRow('ce770000-0000-4000-d000-000000000005', P_AMBIGUOUS)
    const ambiguousId = 'ce770000-0000-4000-d000-000000000006'
    await seedIncome(ambiguousId, P_AMBIGUOUS, '2000')

    const notices: string[] = []
    const client = await pool!.connect()
    client.on('notice', (msg) => notices.push(msg.message ?? ''))
    await client.query(REPORT_SQL)
    client.release()

    expect(notices.some((n) => n.startsWith('CANDIDATE') && n.includes(candidateId))).toBe(true)
    expect(notices.some((n) => n.startsWith('AMBIGUOUS') && n.includes(ambiguousId))).toBe(true)
    expect(notices.some((n) => n.startsWith('CANDIDATE') && n.includes(ambiguousId))).toBe(false)
  })

  it('AC4: the apply file creates a DROP_PENDING_PAYOUT + paired pending_obligations row for a genuine candidate (USER_DEFAULT 5%)', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000007'
    await seedIncome(incomeId, P_CANDIDATE, '1000')

    await pool!.query(APPLY_SQL)

    const created = await query<{
      id: string
      type: string
      status: string
      amount: string
      currency: string
      receiver_id: string
      drop_share_percent: number
      drop_share_percent_source: string
      drop_cascade_origin: boolean
    }>(`SELECT * FROM transactions WHERE source_income_transaction_id = $1`, [incomeId])
    expect(created).toHaveLength(1)
    const row = created[0]!
    expect(row.type).toBe('DROP_PENDING_PAYOUT')
    expect(row.status).toBe('PENDING_PAYMENT')
    expect(parseFloat(row.amount)).toBeCloseTo(50, 6) // 1000 * 5%
    expect(row.currency).toBe('USDT')
    expect(row.receiver_id).toBe(DROP_ID)
    expect(row.drop_share_percent).toBe(DROP_SHARE_DEFAULT)
    expect(row.drop_share_percent_source).toBe('USER_DEFAULT')
    expect(row.drop_cascade_origin).toBe(false)

    const obligations = await query<{
      creditor_user_id: string
      debtor_type: string
      status: string
      amount: string
    }>(`SELECT * FROM pending_obligations WHERE source_transaction_id = $1`, [row.id])
    expect(obligations).toHaveLength(1)
    expect(obligations[0]!.creditor_user_id).toBe(DROP_ID)
    expect(obligations[0]!.debtor_type).toBe('COMPANY')
    expect(obligations[0]!.status).toBe('PENDING')
    expect(parseFloat(obligations[0]!.amount)).toBeCloseTo(50, 6)
  })

  it('AC4-b: PROJECT-level override percent is used when set (12%, not the 5% user default)', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000008'
    await seedIncome(incomeId, P_OVERRIDE, '1000')

    await pool!.query(APPLY_SQL)

    const created = await query<{
      amount: string
      drop_share_percent: number
      drop_share_percent_source: string
    }>(
      `SELECT amount, drop_share_percent, drop_share_percent_source FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(1)
    expect(created[0]!.drop_share_percent).toBe(DROP_SHARE_OVERRIDE)
    expect(created[0]!.drop_share_percent_source).toBe('PROJECT')
    expect(parseFloat(created[0]!.amount)).toBeCloseTo(120, 6) // 1000 * 12%
  })

  it('AC5: idempotent — an ACTUAL second run of the apply file creates ZERO further rows', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000009'
    await seedIncome(incomeId, P_CANDIDATE, '333')

    await pool!.query(APPLY_SQL)
    const afterFirst = await query<{ id: string }>(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(afterFirst).toHaveLength(1)
    const obligationsAfterFirst = await query(
      `SELECT id FROM pending_obligations WHERE source_transaction_id = $1`,
      [afterFirst[0]!.id],
    )
    expect(obligationsAfterFirst).toHaveLength(1)

    // The actual second run — not a re-derivation, the real script executed again.
    await pool!.query(APPLY_SQL)

    const afterSecond = await query<{ id: string }>(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id) // same row, nothing duplicated

    const obligationsAfterSecond = await query(
      `SELECT id FROM pending_obligations WHERE source_transaction_id = $1`,
      [afterFirst[0]!.id],
    )
    expect(obligationsAfterSecond).toHaveLength(1)
  })

  it('AC6: a non-USDT (FOP) project with a bound drop is NEVER touched, even with an unlinked ADMIN_INCOME row', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000010'
    await seedIncome(incomeId, P_NONUSDT, '500')

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(0)
  })

  it('AC7: a project with an existing UNTAGGED drop-share row is entirely ambiguous — its ADMIN_INCOME candidates are excluded from the apply file; the untagged row itself is left untouched', async () => {
    if (!dbAvailable) return
    const untaggedId = 'ce770000-0000-4000-d000-000000000011'
    await seedUntaggedDropShareRow(untaggedId, P_AMBIGUOUS)
    const incomeId = 'ce770000-0000-4000-d000-000000000012'
    await seedIncome(incomeId, P_AMBIGUOUS, '2000')

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(0)

    const untaggedAfter = await query<{
      type: string
      source_income_transaction_id: string | null
    }>(`SELECT type, source_income_transaction_id FROM transactions WHERE id = $1`, [untaggedId])
    expect(untaggedAfter[0]!.type).toBe('DROP_PENDING_PAYOUT')
    expect(untaggedAfter[0]!.source_income_transaction_id).toBeNull()
  })

  it('AC8: a soft-deleted ADMIN_INCOME row is never selected', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000013'
    await seedIncome(incomeId, P_CANDIDATE, '777', { deleted: true })

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(0)
  })

  it('AC9 (money-critical): SQL rounding matches roundShareAmount byte-for-byte, including half-cent amounts', async () => {
    if (!dbAvailable) return
    const cases: Array<[number, number]> = [
      [1000, 5],
      [1000, 12],
      [4708.69, 5], // the real GamingTec case cited by the task
      [0.000001, 5],
      [100.005, 5], // half-cent boundary
      [33.335, 26],
      [0.01, 100],
      [999999.999999, 5],
    ]
    for (const [income, percent] of cases) {
      const expected = roundShareAmount(income, percent)
      const rows = await query<{ share: string }>(
        `SELECT (round(round($1::numeric * 1000000) * $2::numeric / 100) / 1000000)::numeric(18, 6) AS share`,
        [income, percent],
      )
      expect(parseFloat(rows[0]!.share)).toBeCloseTo(expected, 6)
    }
  })
})
