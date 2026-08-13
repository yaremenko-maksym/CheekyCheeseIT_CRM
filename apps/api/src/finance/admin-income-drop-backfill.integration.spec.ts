import { readFileSync } from 'fs'
import { join } from 'path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { roundShareAmount } from './transactions.service'

/**
 * task-admin-income-drop-backfill — REAL-DB integration for the manual
 * report + apply SQL pair (+ the private detail file) that backfills missing
 * drop-share obligations for historical ADMIN_INCOME rows on USDT-payment
 * projects.
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
 * Round 1 (task AC3-AC9), proven against a REAL Postgres (crm_qa scratch —
 * NEVER crm_db):
 *   AC3    Report makes ZERO writes; AC3-b — its NOTICE is aggregate-only,
 *          no PII (security-review round 2, HIGH-3 — see below); AC3-detail
 *          — the private detail file DOES print row-level identifiers and is
 *          ALSO 100% read-only.
 *   AC4    Apply creates a DROP_PENDING_PAYOUT + paired pending_obligations
 *          row (default 5%, and AC4-b — project override 12%).
 *   AC5    Idempotent — an ACTUAL second run creates ZERO further rows.
 *   AC6    Non-USDT (FOP) projects never touched.
 *   AC7    A project with an existing UNTAGGED drop-share row is entirely
 *          ambiguous, excluded from the apply file.
 *   AC8    Soft-deleted ADMIN_INCOME rows never selected.
 *   AC9    SQL rounding — EXTRACTED from the actual report/apply files (not
 *          retyped) — matches roundShareAmount byte-for-byte, including
 *          genuine `.5`-tie cases.
 *
 * Round 2 — security-review findings on PR #517 (Verdict: BLOCK, 3 HIGH + 6
 * MED), all fixed here and proven with a fixture per finding:
 *   HIGH-1  `createAdminIncomeSchema` allows USDT | USD | EUR | UAH; a
 *           project's `payment_type='USDT'` says nothing about an
 *           individual income row's CURRENCY. Fixed: `t.currency = 'USDT'`
 *           added to the selection predicate.
 *   HIGH-2  `projects.payment_type` is a LIVE snapshot — a currently-USDT
 *           project may have spent part of its history as FOP (enum landed
 *           2026-07-13, every existing project defaulted to FOP), during
 *           which the drop self-declared income directly (DROP_INCOME, no
 *           FK to any ADMIN_INCOME row). Fixed: ANY DROP_INCOME row on a
 *           project now makes it ambiguous, independent of any
 *           DROP_PENDING_PAYOUT/PAYOUT_DROP row existing at all.
 *   HIGH-3  Row-level detail (client/drop names, amounts) must never land in
 *           this PUBLIC repo's PUBLIC deploy log. Fixed: the automated
 *           report is now aggregate-only; row-level detail moved to a new,
 *           NEVER-wired-into-CI `..._detail.sql`, run manually/privately.
 *   MED-A   `NOT IN` against a subquery that CAN contain NULL (`project_id`
 *           has `ON DELETE SET NULL`) silently zeroes out EVERY candidate,
 *           project-wide. Fixed: `NOT IN` → `NOT EXISTS` everywhere, plus an
 *           explicit `project_id IS NOT NULL` filter at the source.
 *   MED-B   Apply recomputes its own target set with no upper bound, so the
 *           set the owner approved in the report could silently grow before
 *           apply runs. Fixed: both files share a literal authorship cutoff
 *           (`created_at < '2026-08-13'`).
 *   MED-E   Soft-deleting a CREATED backfill row un-links its income (the
 *           `linked` CTE required `deleted_at IS NULL` on the link itself),
 *           breaking idempotency. Fixed: the link check no longer filters on
 *           `deleted_at`.
 *   MED-F   No structural (DB-level) protection against two overlapping
 *           `apply.sql` runs. Fixed: partial unique index
 *           `uq_transactions_source_income_drop_link` — a genuine race hits
 *           23505 instead of double-booking.
 * MED-C (drop-binding is also a today's-snapshot assumption) and MED-D (this
 * file's own AC9 rewrite) are documentation/test-quality fixes, not schema
 * changes — see the SQL files' headers and the AC9 test below respectively.
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
// Deliberately NOT under drizzle/manual/ — see that file's own header for why
// (keeps it outside check-prod-ddl-wiring.py's scan, which is scoped to that
// exact directory and would otherwise demand this file be wired or excepted,
// a DevOps-owned decision this file must never be a candidate for).
const DETAIL_SQL = readFileSync(
  join(__dirname, '../../drizzle/manual-private/2026-08-12_admin_income_drop_backfill_detail.sql'),
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

// MED-B: the same literal cutoff baked into the SQL files themselves — a row
// created at or after this instant is out of this one-time backfill's scope.
const CUTOFF_ISO = '2026-08-13T00:00:00.000Z'

// Every fixture in this spec that must land BEFORE CUTOFF_ISO (i.e. every
// ADMIN_INCOME row seeded as a would-be candidate, and every project's
// start_date, neither of which this spec means to test the value of) gets
// this literal instead of relying on the wall clock. Deliberately a fixed
// past date, not "CUTOFF_ISO minus a day" or similar arithmetic — it must
// stay unambiguously before the cutoff even if a future PR moves the cutoff
// itself, and it must never accidentally equal `now()` no matter when this
// suite runs. Post-mortem: this file originally seeded these rows with
// `now()` (via `COALESCE($n::timestamptz, now())` / a bare `now()` literal),
// which happened to be before CUTOFF_ISO at authorship time and silently
// stopped being true the instant the wall clock crossed the cutoff — the
// whole suite went red at 2026-08-13T00:00 UTC with no code change. See this
// PR's body for the full incident writeup.
const SAFE_BEFORE_CUTOFF_ISO = '2020-01-01T00:00:00.000Z'

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
  opts: { deleted?: boolean; currency?: string; createdAt?: string } = {},
): Promise<void> {
  // Deliberately NOT `COALESCE($n::timestamptz, now())` — every caller that
  // omits `createdAt` (i.e. every "this should be a candidate" fixture in
  // this file) now gets a fixed pre-cutoff instant instead of the wall
  // clock, which is what silently broke this whole suite the moment `now()`
  // crossed CUTOFF_ISO. Callers that DO care about a specific instant (e.g.
  // MED-B, testing the cutoff boundary itself) still pass `createdAt`
  // explicitly and are unaffected.
  await query(
    `INSERT INTO transactions (id, type, status, amount, currency, sender_label, receiver_id, project_id, created_by, tx_date, deleted_at, created_at)
     VALUES ($1, 'ADMIN_INCOME', 'PAID', $2, $3, 'Backfill Spec Co', $4, $5, $4, $6::timestamptz, $7, $6::timestamptz)`,
    [
      id,
      amount,
      opts.currency ?? 'USDT',
      ADMIN_ID,
      projectId,
      opts.createdAt ?? SAFE_BEFORE_CUTOFF_ISO,
      opts.deleted ? new Date() : null,
    ],
  )
}

async function seedUntaggedDropShareRow(id: string, projectId: string): Promise<void> {
  await query(
    `INSERT INTO transactions (id, type, status, amount, currency, sender_label, receiver_id, recipient_id, project_id, created_by, drop_share_percent, drop_share_percent_source)
     VALUES ($1, 'DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', '25', 'USDT', 'COMPANY', $2, $2, $3, $4, 5, 'USER_DEFAULT')`,
    [id, DROP_ID, projectId, ADMIN_ID],
  )
}

/** HIGH-2 fixture: a historical, self-declared drop income (the shape
 * `createDropIncome` produces) — no FK to any ADMIN_INCOME row, exactly the
 * FOP-period artefact the ambiguity guard must now catch. */
async function seedDropIncome(projectId: string): Promise<void> {
  await query(
    `INSERT INTO transactions (type, status, amount, currency, receiver_id, recipient_id, project_id, created_by, drop_share_percent, drop_share_percent_source)
     VALUES ('DROP_INCOME', 'VALIDATED', '400', 'USDT', $1, $1, $2, $1, 5, 'USER_DEFAULT')`,
    [DROP_ID, projectId],
  )
}

async function clearFixtures(): Promise<void> {
  await query(`DELETE FROM pending_obligations WHERE creditor_user_id = $1`, [DROP_ID])
  await query(`DELETE FROM transactions WHERE project_id = ANY($1::uuid[])`, [TEST_PROJECT_IDS])
  // MED-A fixture cleanup: a corrupted untagged drop-share row deliberately
  // seeded with project_id=NULL (simulating an ON DELETE SET NULL'd project)
  // is NOT caught by the project_id-scoped delete above.
  await query(`DELETE FROM transactions WHERE receiver_id = $1 AND project_id IS NULL`, [DROP_ID])
}

describe('admin-income-drop-backfill report + apply + detail SQL (real DB)', () => {
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
    // guarantees the column + unique index exist regardless of what already
    // ran against this scratch DB.
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

    // start_date is NOT read by the report/apply predicate (only
    // transactions.created_at is, via the ADMIN_INCOME cutoff check above)
    // and is required NOT NULL by the schema with no default — it is
    // seeded from the same fixed pre-cutoff constant as everything else in
    // this file purely so nothing here reads from the wall clock, not
    // because any assertion currently depends on its value.
    await query(
      `INSERT INTO projects (id, name, company_name, domain, start_date, senior_id, drop_id, rate, currency, payment_type, drop_share_percent_override)
       VALUES
         ($1, 'AIDB Candidate', 'AIDB Candidate Co', 'ai', $8::timestamptz, $5, $6, 1000, 'USDT', 'USDT', NULL),
         ($2, 'AIDB Non-USDT', 'AIDB NonUSDT Co', 'ai', $8::timestamptz, $5, $6, 1000, 'USDT', 'FOP', NULL),
         ($3, 'AIDB Ambiguous', 'AIDB Ambiguous Co', 'ai', $8::timestamptz, $5, $6, 1000, 'USDT', 'USDT', NULL),
         ($4, 'AIDB Override', 'AIDB Override Co', 'ai', $8::timestamptz, $5, $6, 1000, 'USDT', 'USDT', $7)`,
      [
        P_CANDIDATE,
        P_NONUSDT,
        P_AMBIGUOUS,
        P_OVERRIDE,
        SENIOR_ID,
        DROP_ID,
        DROP_SHARE_OVERRIDE,
        SAFE_BEFORE_CUTOFF_ISO,
      ],
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

  it('AC3-b (security-review round 2, HIGH-3): the automated PUBLIC report NOTICE is aggregate-only — no income id, project name, or drop name ever appears in it', async () => {
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

    const joined = notices.join('\n')
    expect(joined).toMatch(/1 candidate\(s\) totalling 50\.000000 USDT/)
    expect(joined).toMatch(/1 ambiguous row\(s\)/)
    // Privacy — none of the row-level identifiers/names ever leak.
    expect(joined).not.toContain(candidateId)
    expect(joined).not.toContain(ambiguousId)
    expect(joined).not.toContain('AIDB Candidate')
    expect(joined).not.toContain('AIDB Ambiguous')
    expect(joined).not.toContain('AIDB Drop')
  })

  it('AC3-detail (security-review round 2, HIGH-3): the PRIVATE detail file DOES print row-level identifiers, agrees with the aggregate counts, and remains 100% read-only', async () => {
    if (!dbAvailable) return
    const candidateId = 'ce770000-0000-4000-d000-000000000007'
    await seedIncome(candidateId, P_CANDIDATE, '1000')
    await seedUntaggedDropShareRow('ce770000-0000-4000-d000-000000000008', P_AMBIGUOUS)
    const ambiguousId = 'ce770000-0000-4000-d000-000000000009'
    await seedIncome(ambiguousId, P_AMBIGUOUS, '2000')

    const txBefore = await countAll('transactions')
    const oblBefore = await countAll('pending_obligations')

    const notices: string[] = []
    const client = await pool!.connect()
    client.on('notice', (msg) => notices.push(msg.message ?? ''))
    await client.query(DETAIL_SQL)
    client.release()

    expect(notices.some((n) => n.startsWith('CANDIDATE') && n.includes(candidateId))).toBe(true)
    expect(notices.some((n) => n.startsWith('AMBIGUOUS') && n.includes(ambiguousId))).toBe(true)
    expect(notices.some((n) => n.includes('1 candidate(s), 1 ambiguous row(s)'))).toBe(true)

    expect(await countAll('transactions')).toBe(txBefore)
    expect(await countAll('pending_obligations')).toBe(oblBefore)
  })

  it('AC4: the apply file creates a DROP_PENDING_PAYOUT + paired pending_obligations row for a genuine candidate (USER_DEFAULT 5%)', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000010'
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
    const incomeId = 'ce770000-0000-4000-d000-000000000011'
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
    const incomeId = 'ce770000-0000-4000-d000-000000000012'
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
    const incomeId = 'ce770000-0000-4000-d000-000000000013'
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
    const untaggedId = 'ce770000-0000-4000-d000-000000000014'
    await seedUntaggedDropShareRow(untaggedId, P_AMBIGUOUS)
    const incomeId = 'ce770000-0000-4000-d000-000000000015'
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
    const incomeId = 'ce770000-0000-4000-d000-000000000016'
    await seedIncome(incomeId, P_CANDIDATE, '777', { deleted: true })

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(0)
  })

  it('AC9 (money-critical, MED-D fix): SQL rounding — EXTRACTED from the actual report/apply files, not retyped — matches roundShareAmount byte-for-byte, including genuine .5-tie cases', async () => {
    if (!dbAvailable) return
    const FORMULA_RE =
      /round\(round\(u\.amount\s*\*\s*1000000\)\s*\*\s*COALESCE\(p\.drop_share_percent_override,\s*d\.drop_share_percent,\s*5\)\s*\/\s*100\)\s*\/\s*1000000/

    const reportMatch = REPORT_SQL.match(FORMULA_RE)
    const applyMatch = APPLY_SQL.match(FORMULA_RE)
    expect(reportMatch).not.toBeNull()
    expect(applyMatch).not.toBeNull()
    // Both files must literally carry the IDENTICAL formula — an edit to one
    // without the other fails this assertion loudly instead of silently
    // letting report and apply price a share differently.
    expect(reportMatch![0].replace(/\s+/g, ' ')).toBe(applyMatch![0].replace(/\s+/g, ' '))

    const rawExpr = reportMatch![0]
    const parametrized = rawExpr
      .replace('u.amount', '$1::numeric')
      .replace('COALESCE(p.drop_share_percent_override, d.drop_share_percent, 5)', '$2::numeric')
    // If the file's column names ever drift, this regex/replace stops
    // matching and THIS assertion catches it — rather than silently running
    // a formula that never got parametrized at all.
    expect(parametrized).toContain('$1::numeric')
    expect(parametrized).toContain('$2::numeric')
    expect(parametrized).not.toContain('u.amount')
    expect(parametrized).not.toContain('drop_share_percent_override')

    const cases: Array<[number, number]> = [
      [1000, 5],
      [1000, 12],
      [4708.69, 5], // the real GamingTec case cited by the task
      [0.000001, 50], // genuine .5 tie: incomeMinor=1, 1*50/100 = 0.5 exactly
      [0.000003, 50], // genuine .5 tie at a different scale: 3*50/100 = 1.5
      [100.005, 5],
      [33.335, 26],
      [0.01, 100],
      [999999.999999, 5],
    ]
    for (const [income, percent] of cases) {
      const expected = roundShareAmount(income, percent)
      const rows = await query<{ share: string }>(
        `SELECT (${parametrized})::numeric(18, 6) AS share`,
        [income, percent],
      )
      expect(parseFloat(rows[0]!.share)).toBeCloseTo(expected, 6)
    }
  })

  it('MED-I (security-review round 3): the authorship cutoff literal is EXTRACTED from each file, not retyped, and is IDENTICAL across report.sql, apply.sql, and detail.sql', async () => {
    // MED-D pinned the rounding formula this same way (extract, don't
    // retype, compare files against each other) after AC9 was flagged for
    // hand-copying it. MED-I applies the identical technique to the OTHER
    // literal duplicated across all three files — the authorship cutoff.
    const CUTOFF_RE = /'([^']+)'::timestamptz AS cutoff/
    const reportMatch = REPORT_SQL.match(CUTOFF_RE)
    const applyMatch = APPLY_SQL.match(CUTOFF_RE)
    const detailMatch = DETAIL_SQL.match(CUTOFF_RE)
    expect(reportMatch).not.toBeNull()
    expect(applyMatch).not.toBeNull()
    expect(detailMatch).not.toBeNull()

    const [reportCutoff, applyCutoff, detailCutoff] = [
      reportMatch![1],
      applyMatch![1],
      detailMatch![1],
    ]
    // All three files must carry the LITERALLY identical cutoff — a drift in
    // any one of them (e.g. someone updates report.sql for a fresh backfill
    // run and forgets apply.sql) now fails loudly instead of silently
    // letting the report approve a different set than apply processes.
    expect(applyCutoff).toBe(reportCutoff)
    expect(detailCutoff).toBe(reportCutoff)
    // Also pin the actual value — a drift where all three files change
    // TOGETHER to something wrong would still pass the cross-file-equality
    // checks above; this catches that case too.
    expect(reportCutoff).toBe('2026-08-13 00:00:00+00')
    // Sanity: this is the SAME instant CUTOFF_ISO (used to build the MED-B
    // fixture above) represents.
    expect(new Date(`${reportCutoff.replace(' ', 'T')}:00`).toISOString()).toBe(CUTOFF_ISO)
  })

  it('HIGH-1 (security-review round 2): an ADMIN_INCOME in a DIFFERENT currency (UAH) on a USDT-payment project is NEVER treated as USDT — excluded from the apply file', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000017'
    await seedIncome(incomeId, P_CANDIDATE, '200000', { currency: 'UAH' })

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(0)
  })

  it('MED-G (security-review round 3): a non-USDT-currency row does not just vanish from the report — it is counted in its OWN "non-USDT-currency" bucket, visible in the same aggregate NOTICE', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000023'
    await seedIncome(incomeId, P_CANDIDATE, '200000', { currency: 'UAH' })

    const notices: string[] = []
    const client = await pool!.connect()
    client.on('notice', (msg) => notices.push(msg.message ?? ''))
    await client.query(REPORT_SQL)
    client.release()

    const joined = notices.join('\n')
    expect(joined).toMatch(/1 non-USDT-currency row\(s\)/)
    // Neither counted as a candidate nor as ambiguous — its own bucket only.
    expect(joined).toMatch(/0 candidate\(s\)/)
    expect(joined).toMatch(/0 ambiguous row\(s\)/)
  })

  it('MED-G-detail (security-review round 3): the private detail file ALSO surfaces the wrong-currency row by name, not just as a count', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000024'
    await seedIncome(incomeId, P_CANDIDATE, '321', { currency: 'USD' })

    const notices: string[] = []
    const client = await pool!.connect()
    client.on('notice', (msg) => notices.push(msg.message ?? ''))
    await client.query(DETAIL_SQL)
    client.release()

    expect(
      notices.some(
        (n) => n.startsWith('WRONG-CURRENCY') && n.includes(incomeId) && n.includes('USD'),
      ),
    ).toBe(true)
  })

  it('HIGH-2 (security-review round 2): a project currently USDT but carrying ANY historical DROP_INCOME row (FOP-period self-declared income) is ambiguous — even with NO DROP_PENDING_PAYOUT/PAYOUT_DROP row present at all', async () => {
    if (!dbAvailable) return
    await seedDropIncome(P_CANDIDATE)
    const incomeId = 'ce770000-0000-4000-d000-000000000018'
    await seedIncome(incomeId, P_CANDIDATE, '3000')

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(0)
  })

  it('MED-A (security-review round 2): a corrupted untagged drop-share row with a NULL project_id (ON DELETE SET NULL shape) never poisons selection for an UNRELATED project — proof by an actual run, not by reading the fixed query', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000019'
    await seedIncome(incomeId, P_CANDIDATE, '1000')
    // The exact shape a `DROP_PENDING_PAYOUT` row takes after its project is
    // hard-deleted (ON DELETE SET NULL on transactions.project_id) — still
    // untagged (source_income_transaction_id NULL), now project-less. Under
    // the pre-fix `NOT IN` predicate this alone would zero out EVERY
    // candidate in the whole database.
    await query(
      `INSERT INTO transactions (type, status, amount, currency, sender_label, receiver_id, recipient_id, project_id, created_by, drop_share_percent, drop_share_percent_source)
       VALUES ('DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', '1', 'USDT', 'COMPANY', $1, $1, NULL, $2, 5, 'USER_DEFAULT')`,
      [DROP_ID, ADMIN_ID],
    )

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(1) // the unrelated, otherwise-healthy candidate still gets processed
  })

  it('MED-B (security-review round 2): an ADMIN_INCOME created AT OR AFTER the authorship cutoff is excluded — the set the owner reviews cannot silently grow between report and apply', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000020'
    await seedIncome(incomeId, P_CANDIDATE, '500', { createdAt: CUTOFF_ISO })

    await pool!.query(APPLY_SQL)

    const created = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(created).toHaveLength(0)
  })

  it('MED-E (security-review round 2): idempotency survives soft-deletion of a previously-created backfill row — a second apply run does NOT re-create a duplicate link', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000021'
    await seedIncome(incomeId, P_CANDIDATE, '333')

    await pool!.query(APPLY_SQL)
    const firstRun = await query<{ id: string }>(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(firstRun).toHaveLength(1)

    // Simulate an admin voiding the backfilled row.
    await query(`UPDATE transactions SET deleted_at = now() WHERE id = $1`, [firstRun[0]!.id])

    await pool!.query(APPLY_SQL)
    const afterRerun = await query<{ id: string }>(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    // Still exactly ONE row for this income — the SAME (now soft-deleted)
    // one, not a fresh duplicate.
    expect(afterRerun).toHaveLength(1)
    expect(afterRerun[0]!.id).toBe(firstRun[0]!.id)
  })

  it('MED-F (security-review round 2): the DB-level partial unique index rejects a duplicate drop link for the same income — a structural race guard, not just the predicate', async () => {
    if (!dbAvailable) return
    const incomeId = 'ce770000-0000-4000-d000-000000000022'
    await seedIncome(incomeId, P_CANDIDATE, '1000')
    await pool!.query(APPLY_SQL) // creates the first, legitimate link

    // A raw second INSERT bypassing the apply script's own SELECT predicate
    // entirely — simulates a genuinely concurrent second run racing past the
    // predicate check. Must be rejected by the DB itself.
    await expect(
      query(
        `INSERT INTO transactions (type, status, amount, currency, sender_label, receiver_id, recipient_id, project_id, created_by, source_income_transaction_id)
         VALUES ('DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', '999', 'USDT', 'COMPANY', $1, $1, $2, $3, $4)`,
        [DROP_ID, P_CANDIDATE, ADMIN_ID, incomeId],
      ),
    ).rejects.toThrow(/uq_transactions_source_income_drop_link/)

    // Exactly one link survives — the legitimate one from the apply run.
    const rows = await query(
      `SELECT id FROM transactions WHERE source_income_transaction_id = $1`,
      [incomeId],
    )
    expect(rows).toHaveLength(1)
  })
})
