/**
 * Real-DB integration test — UsersService.getSalaryMeta (AC4 gap-fill)
 *
 * WHY this exists (feedback_mocked_e2e_guards lesson, lessons.md 2026-06-09):
 *   salary-meta.integration.spec.ts proves routing/auth with a sentinel
 *   controller but uses NO real DB. This spec uses real UsersService +
 *   real PostgreSQL to verify the actual service logic:
 *
 *   AC4a: user with monthlySalary set → returned in getSalaryMeta
 *   AC4b: user_audit_log has monthlySalary change → changedAt = that entry's created_at
 *   AC4c: no audit log entry → changedAt = null
 *   AC4d: self-only: getSalaryMeta(A) never returns B's salary data
 *
 * SEED: inserts isolated test rows in beforeAll, deletes in afterAll.
 * IDs namespaced sm2- (salary-meta-realdb) — no collision with other specs.
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED). A DATABASE_URL that IS set but unreachable
 * throws in beforeAll (reports FAILED) — neither case can look like
 * "passed" with zero assertions.
 */

import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, and } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { UsersService } from './users.service'
import { users, userAuditLog } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ---------------------------------------------------------------------------
// Test IDs — stable namespace sm2-
// ---------------------------------------------------------------------------
const U_WITH_SALARY_ID = '53100001-0000-4000-aa00-000000000001'
const U_WITH_SALARY_EMAIL = 'sm2-junior-salary@test.spec'
const U_NO_AUDIT_ID = '53100001-0000-4000-aa00-000000000002'
const U_NO_AUDIT_EMAIL = 'sm2-junior-noaudit@test.spec'
const U_OTHER_ID = '53100001-0000-4000-aa00-000000000003'
const U_OTHER_EMAIL = 'sm2-junior-other@test.spec'

const AUDIT_SALARY_CHANGE_ID = '53100001-0000-4000-cc00-000000000010'

const TEST_USER_IDS = [U_WITH_SALARY_ID, U_NO_AUDIT_ID, U_OTHER_ID]
// Date for salary change — fixed for deterministic assertions
const SALARY_CHANGE_DATE = new Date('2026-01-15T10:00:00.000Z')

// ---------------------------------------------------------------------------
// DB availability flag
// ---------------------------------------------------------------------------
let _pool: Pool | null = null
let usersSvc: UsersService

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe.skipIf(!hasDatabaseUrl())('UsersService.getSalaryMeta — real DB (AC4)', () => {
  beforeAll(async () => {
    // DB availability probe
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      throw new Error(
        '[salary-meta-realdb] FAILED — no DB at DATABASE_URL (expected in CI unit job)',
      )
    }

    // Build UsersService directly
    // UsersService has many deps but getSalaryMeta only needs DatabaseService.
    // We pass the real DatabaseService and stubs for the rest.
    _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(_pool, { schema })
    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: _pool, db })

    // UsersService constructor: (db, teamAudit, teamsSvc, projectAudit, tos, auditLog, accessSvc)
    // getSalaryMeta only uses this.db — pass stubs for others
    usersSvc = new (UsersService as new (...args: unknown[]) => UsersService)(
      dbSvc,
      {} /* TeamAuditLogService stub */,
      {} /* TeamsService stub */,
      {} /* ProjectAuditLogService stub */,
      {} /* TosService stub */,
      {} /* AuditLogService stub */,
      {} /* UsersAccessService stub */,
    )

    // Seed users
    await db
      .insert(users)
      .values([
        {
          id: U_WITH_SALARY_ID,
          email: U_WITH_SALARY_EMAIL,
          displayName: 'SM2 Junior With Salary',
          role: 'JUNIOR',
          googleId: `test-google-${U_WITH_SALARY_ID}`,
          monthlySalary: '3500',
          salaryCurrency: 'USDT',
        },
        {
          id: U_NO_AUDIT_ID,
          email: U_NO_AUDIT_EMAIL,
          displayName: 'SM2 Junior No Audit',
          role: 'JUNIOR',
          googleId: `test-google-${U_NO_AUDIT_ID}`,
          monthlySalary: '2000',
          salaryCurrency: 'USD',
        },
        {
          id: U_OTHER_ID,
          email: U_OTHER_EMAIL,
          displayName: 'SM2 Junior Other',
          role: 'JUNIOR',
          googleId: `test-google-${U_OTHER_ID}`,
          monthlySalary: '9999',
          salaryCurrency: 'USD',
        },
      ])
      .onConflictDoNothing()

    // Seed audit log entry for U_WITH_SALARY: monthlySalary change
    await db
      .insert(userAuditLog)
      .values([
        {
          id: AUDIT_SALARY_CHANGE_ID,
          actorId: U_WITH_SALARY_ID,
          targetId: U_WITH_SALARY_ID,
          action: 'profile_updated',
          changes: {
            monthlySalary: { before: '3000', after: '3500' },
          },
          createdAt: SALARY_CHANGE_DATE,
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!_pool)
      throw new Error(
        '[require-real-db] _pool not initialized — beforeAll should have thrown already',
      )
    try {
      const db = drizzle(_pool, { schema })
      // Delete audit log entries first (FK → users)
      await db.delete(userAuditLog).where(eq(userAuditLog.id, AUDIT_SALARY_CHANGE_ID))
      for (const id of TEST_USER_IDS) {
        await db.delete(users).where(eq(users.id, id))
      }
    } finally {
      await _pool.end()
    }
  }, 30_000)

  it('AC4a: user with monthlySalary → getSalaryMeta returns correct salary and currency', async () => {
    const result = await usersSvc.getSalaryMeta(U_WITH_SALARY_ID)
    // DB returns numeric as string; compare via parseFloat to handle '3500' vs '3500.00'
    expect(parseFloat(result.monthlySalary!)).toBe(3500)
    expect(result.salaryCurrency).toBe('USDT')
  })

  it('AC4b: user_audit_log has monthlySalary change → changedAt equals that entry created_at', async () => {
    const result = await usersSvc.getSalaryMeta(U_WITH_SALARY_ID)
    expect(result.changedAt).not.toBeNull()
    // changedAt is ISO string — should match our seeded date
    expect(result.changedAt).toBe(SALARY_CHANGE_DATE.toISOString())
  })

  it('AC4c: no monthlySalary audit log entry → changedAt is null', async () => {
    const result = await usersSvc.getSalaryMeta(U_NO_AUDIT_ID)
    expect(parseFloat(result.monthlySalary!)).toBe(2000)
    expect(result.changedAt).toBeNull()
  })

  it('AC4d: self-only — getSalaryMeta(A) returns A data, never B data', async () => {
    const resultA = await usersSvc.getSalaryMeta(U_WITH_SALARY_ID)
    const resultOther = await usersSvc.getSalaryMeta(U_OTHER_ID)
    // A has monthlySalary=3500, OTHER has 9999 — must not cross
    expect(parseFloat(resultA.monthlySalary!)).toBe(3500)
    expect(parseFloat(resultOther.monthlySalary!)).toBe(9999)
    expect(parseFloat(resultA.monthlySalary!)).not.toBe(parseFloat(resultOther.monthlySalary!))
  })

  it('AC4e: user with no row in DB → getSalaryMeta returns all nulls', async () => {
    const result = await usersSvc.getSalaryMeta('00000000-0000-4000-a000-000000000000')
    expect(result.monthlySalary).toBeNull()
    expect(result.salaryCurrency).toBeNull()
    expect(result.changedAt).toBeNull()
  })
})
