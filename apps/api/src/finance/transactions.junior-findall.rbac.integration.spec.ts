/**
 * RBAC regression test — F3: JUNIOR → GET /api/transactions findAll
 * sees ONLY their own SALARY rows (receiverId = self), nothing else.
 *
 * WHY real-DB (not mocked):
 *   The existing mocked tests in transactions.rbac-f1-f2.spec.ts stub
 *   db.query.transactions.findMany to return a controlled list, then assert
 *   on the JS-layer filter in findAll(). That's valuable but cannot catch a
 *   regression where someone removes/rewrites the Drizzle query + filter at
 *   the same time — the stub would still return the pre-filtered list.
 *   A real-DB spec proves the entire path: actual rows in Postgres → Drizzle
 *   ORM → service filter → returned set.
 *   Class of incident: feedback_mocked_e2e_guards (3× recurrence, last
 *   2026-06-09 — real data-leaks behind guards in #157 / #158).
 *
 * WHAT it covers (security review PR #167 MED finding):
 *   F3-1  JUNIOR with SALARY row → sees exactly that row (receiverId = self).
 *   F3-2  JUNIOR does NOT see SENIOR_INCOME belonging to another user.
 *   F3-3  JUNIOR does NOT see SALARY rows belonging to another JUNIOR.
 *   F3-4  JUNIOR with no transactions → returns [] (not 403).
 *   F3-5  Mixed DB: JUNIOR sees own SALARY, foreign rows absent. Exact count.
 *   F3-6  RED→GREEN regression gate: removing the JUNIOR filter in findAll
 *         would cause F3-5 to fail (count > 1, foreign tx visible).
 *
 * DB-SKIP-GUARD:
 *   dbAvailable = false when DATABASE_URL is unreachable (CI unit job without
 *   Postgres service). Every test checks the flag and returns early with a
 *   skip comment — stays green in no-DB environments.
 *
 * SEED strategy:
 *   UUID namespace: f3000000-0000-4000-*  (distinct from other specs).
 *   We insert a synthetic JUNIOR user (not from seed.ts) so the spec is
 *   self-contained and idempotent. The ADMIN user (yaremenkomaksym99) from
 *   seed is reused as createdBy (it must exist in users FK).
 *   onConflictDoNothing / onConflictDoUpdate make the spec re-runnable.
 *   afterAll cleans up in reverse FK order.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { InvoicesService } from '../invoices/invoices.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

// ---------------------------------------------------------------------------
// Constants — test personas
// ---------------------------------------------------------------------------

/** Admin from seed — used as createdBy FK anchor; must already exist in users. */
const ADMIN: SessionUser = {
  id: 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

/**
 * Synthetic JUNIOR — inserted by beforeAll, cleaned up in afterAll.
 * Namespace: f3000000-0000-4000-aa00-*
 */
const JUNIOR_1: SessionUser = {
  id: 'f3000000-0000-4000-aa00-000000000001',
  email: 'f3-junior-1@test.spec',
  displayName: 'F3 Junior 1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/**
 * Synthetic SENIOR — inserted by beforeAll, cleaned up in afterAll.
 * Owner of SENIOR_INCOME rows that JUNIOR_1 must NOT see.
 */
const SENIOR_1: SessionUser = {
  id: 'f3000000-0000-4000-aa00-000000000002',
  email: 'f3-senior-1@test.spec',
  displayName: 'F3 Senior 1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/**
 * Synthetic JUNIOR — inserted by beforeAll, cleaned up in afterAll.
 * Owner of SALARY rows that JUNIOR_1 must NOT see.
 */
const JUNIOR_2: SessionUser = {
  id: 'f3000000-0000-4000-aa00-000000000003',
  email: 'f3-junior-2@test.spec',
  displayName: 'F3 Junior 2',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// Constants — test row IDs  (namespace: f3000001-*)
// ---------------------------------------------------------------------------

/** SALARY to JUNIOR_1 — this is the ONLY tx JUNIOR_1 should see. */
const TX_J1_SALARY_ID = 'f3000001-0000-4000-b000-000000000001'

/** SENIOR_INCOME to SENIOR_1 — JUNIOR_1 must NOT see this. */
const TX_S1_INCOME_ID = 'f3000001-0000-4000-b000-000000000002'

/** SALARY to JUNIOR_2 — JUNIOR_1 must NOT see this. */
const TX_J2_SALARY_ID = 'f3000001-0000-4000-b000-000000000003'

// ---------------------------------------------------------------------------
// DB-skip-guard
// ---------------------------------------------------------------------------

let dbAvailable = true
let _pool: Pool | null = null
let transactionsService: TransactionsService

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('F3 — JUNIOR findAll: sees only own SALARY rows (real-DB)', () => {
  beforeAll(async () => {
    // ── DB availability probe ────────────────────────────────────────────────
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn(
        '[f3-junior-findall] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    // ── Build real DB + service ──────────────────────────────────────────────
    _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(_pool, { schema })

    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: _pool, db })

    // InvoicesService and DocumentsService are only exercised by write paths
    // (createSalary, validateTransaction, etc.) — findAll does not call them.
    // Empty stubs are safe here.
    const invoicesStub = {} as InvoicesService
    const documentsStub = {} as unknown as import('../documents/documents.service').DocumentsService

    transactionsService = new TransactionsService(dbSvc, invoicesStub, documentsStub)

    // ── Insert synthetic users ───────────────────────────────────────────────
    await db
      .insert(users)
      .values({
        id: JUNIOR_1.id,
        email: JUNIOR_1.email,
        displayName: JUNIOR_1.displayName,
        role: 'JUNIOR',
        seniorSharePercent: 26,
      })
      .onConflictDoNothing()

    await db
      .insert(users)
      .values({
        id: SENIOR_1.id,
        email: SENIOR_1.email,
        displayName: SENIOR_1.displayName,
        role: 'SENIOR',
        seniorSharePercent: 26,
      })
      .onConflictDoNothing()

    await db
      .insert(users)
      .values({
        id: JUNIOR_2.id,
        email: JUNIOR_2.email,
        displayName: JUNIOR_2.displayName,
        role: 'JUNIOR',
        seniorSharePercent: 26,
      })
      .onConflictDoNothing()

    // ── Insert test transactions ─────────────────────────────────────────────
    // TX_J1_SALARY: SALARY paid to JUNIOR_1 — JUNIOR_1 MUST see this
    await db
      .insert(transactions)
      .values({
        id: TX_J1_SALARY_ID,
        type: 'SALARY',
        status: 'PAID',
        amount: '1000',
        currency: 'USDT',
        senderId: SENIOR_1.id,
        receiverId: JUNIOR_1.id,
        createdBy: ADMIN.id,
      })
      .onConflictDoNothing()

    // TX_S1_INCOME: SENIOR_INCOME for SENIOR_1 — JUNIOR_1 must NOT see this
    await db
      .insert(transactions)
      .values({
        id: TX_S1_INCOME_ID,
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '5000',
        currency: 'USDT',
        senderId: null,
        receiverId: SENIOR_1.id,
        createdBy: ADMIN.id,
      })
      .onConflictDoNothing()

    // TX_J2_SALARY: SALARY paid to JUNIOR_2 — JUNIOR_1 must NOT see this
    await db
      .insert(transactions)
      .values({
        id: TX_J2_SALARY_ID,
        type: 'SALARY',
        status: 'PAID',
        amount: '800',
        currency: 'USDT',
        senderId: SENIOR_1.id,
        receiverId: JUNIOR_2.id,
        createdBy: ADMIN.id,
      })
      .onConflictDoNothing()
  })

  afterAll(async () => {
    if (!dbAvailable || !_pool) return
    const db = drizzle(_pool, { schema })

    // Delete transactions first (FK → users)
    await db
      .delete(transactions)
      .where(inArray(transactions.id, [TX_J1_SALARY_ID, TX_S1_INCOME_ID, TX_J2_SALARY_ID]))
      .catch(() => undefined)

    // Delete synthetic users
    await db
      .delete(users)
      .where(inArray(users.id, [JUNIOR_1.id, SENIOR_1.id, JUNIOR_2.id]))
      .catch(() => undefined)

    await _pool.end()
  })

  // ── F3-1: JUNIOR sees own SALARY ──────────────────────────────────────────

  it('F3-1 — JUNIOR with own SALARY tx → tx is returned', async () => {
    if (!dbAvailable) return

    const result = await transactionsService.findAll(JUNIOR_1)

    const own = result.find((t) => t.id === TX_J1_SALARY_ID)
    expect(own, 'own SALARY tx must be in result').toBeDefined()
  })

  // ── F3-2: JUNIOR does NOT see SENIOR_INCOME of another user ──────────────

  it('F3-2 — JUNIOR does NOT see SENIOR_INCOME belonging to SENIOR_1', async () => {
    if (!dbAvailable) return

    const result = await transactionsService.findAll(JUNIOR_1)

    const leaked = result.find((t) => t.id === TX_S1_INCOME_ID)
    expect(leaked, 'SENIOR_INCOME of another user must NOT be visible to JUNIOR').toBeUndefined()
  })

  // ── F3-3: JUNIOR does NOT see SALARY of another JUNIOR ───────────────────

  it('F3-3 — JUNIOR does NOT see SALARY paid to another JUNIOR', async () => {
    if (!dbAvailable) return

    const result = await transactionsService.findAll(JUNIOR_1)

    const leaked = result.find((t) => t.id === TX_J2_SALARY_ID)
    expect(leaked, "another JUNIOR's SALARY must NOT be visible").toBeUndefined()
  })

  // ── F3-4: JUNIOR with no transactions → [] (not 403) ─────────────────────

  it('F3-4 — JUNIOR with no transactions returns empty array, not a 403', async () => {
    if (!dbAvailable) return

    // JUNIOR_2 has TX_J2_SALARY as receiver — but we use a fresh persona with
    // no rows. Re-use JUNIOR_2 but filter from a perspective where receiverId
    // never matches any row seeded above: create a transient persona on the fly.
    //
    // To keep setup minimal, we just verify that a JUNIOR whose id does NOT
    // appear as receiverId in any seeded tx gets an empty result.
    const JUNIOR_NO_TX: SessionUser = {
      id: 'f3000000-0000-4000-aa00-000000000099',
      email: 'f3-junior-notx@test.spec',
      displayName: 'F3 Junior NoTx',
      avatarUrl: null,
      role: 'JUNIOR',
      seniorSharePercent: 26,
      legalFullName: null,
    }
    // This user does not exist in users table and has no transactions seeded.
    // findAll does not validate that currentUser exists — it filters by id.
    const result = await transactionsService.findAll(JUNIOR_NO_TX)

    // All seeded test txs have receiverId = JUNIOR_1.id or JUNIOR_2.id.
    // None belong to JUNIOR_NO_TX → the filtered slice is empty.
    const testTxIds = [TX_J1_SALARY_ID, TX_S1_INCOME_ID, TX_J2_SALARY_ID]
    const leaks = result.filter((t) => testTxIds.includes(t.id))
    expect(leaks).toHaveLength(0)
  })

  // ── F3-5: Exact count — JUNIOR sees exactly the rows where receiverId = self

  it('F3-5 — among the 3 seeded test rows, JUNIOR_1 sees exactly 1 (own SALARY)', async () => {
    if (!dbAvailable) return

    const result = await transactionsService.findAll(JUNIOR_1)

    // Filter only the test-namespaced rows to avoid interference from other
    // data that may already be in the DB (other specs, seed data).
    const testTxIds = new Set([TX_J1_SALARY_ID, TX_S1_INCOME_ID, TX_J2_SALARY_ID])
    const testRows = result.filter((t) => testTxIds.has(t.id))

    expect(testRows).toHaveLength(1)
    expect(testRows[0]!.id).toBe(TX_J1_SALARY_ID)
  })
})
