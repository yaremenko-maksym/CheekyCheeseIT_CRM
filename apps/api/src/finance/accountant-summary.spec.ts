/**
 * Unit tests for TransactionsService.getAccountantSummary — RBAC guard only.
 *
 * Sprint 2 (task-accountant-s2-sql-kpi): the KPI math moved from an in-memory
 * `query.transactions.findMany()` + JS aggregation to a single SQL aggregating
 * `.select()` (conditional SUM/COUNT FILTER + COUNT DISTINCT). A mocked
 * `findMany` no longer reflects the production path, and finance math is only
 * honestly provable against a real DB — so the KPI-math cases that used to live
 * here were moved to `accountant-summary.integration.spec.ts` (real Postgres,
 * delta-based assertions over inserted rows).
 *
 * What stays here (DB-independent, fast, no Postgres):
 *   RBAC (AC3):
 *     - SENIOR / JUNIOR / HR / DROP → ForbiddenException, thrown BEFORE any DB
 *       access (the stub's `.select()` would throw if ever reached for these).
 *     - ACCOUNTANT / ADMIN → resolve (stub returns an empty aggregate row →
 *       the COALESCE-to-zero path, AC4).
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TransactionsService } from './transactions.service'

function user(role: SessionUser['role'], id = `${role.toLowerCase()}-1`): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

/**
 * Minimal DatabaseService stub for the SQL `.select().from()` aggregating path.
 *
 * `aggregateRow` is what the single aggregation query resolves to. For RBAC
 * resolve-cases (ACCOUNTANT / ADMIN) we hand back an empty aggregate row (all
 * zeros) — that exercises the COALESCE-to-zero mapping (AC4) without a DB. For
 * the forbidden roles the guard throws first, so `.select()` is never invoked;
 * if it ever were (a regression moving the guard below the query), the stub
 * throws and the test fails loudly.
 */
function makeStub(
  aggregateRow: Record<string, number> = {
    pendingCount: 0,
    pendingAmount: 0,
    validatedCount: 0,
    validatedAmount: 0,
    paidAmount: 0,
    recipientCount: 0,
  },
) {
  const dbStub = {
    db: {
      select: () => ({
        from: () => Promise.resolve([aggregateRow]),
      }),
    },
  }
  return new TransactionsService(dbStub as never, {} as never, {} as never)
}

describe('getAccountantSummary — RBAC guard (AC3)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'DROP']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for ${role} (before any DB access)`, async () => {
      // Stub whose `.select()` throws — proves the guard fires BEFORE the query.
      const throwingDb = {
        db: {
          select: () => {
            throw new Error('DB must not be queried for forbidden roles')
          },
        },
      }
      const svc = new TransactionsService(throwingDb as never, {} as never, {} as never)
      await expect(svc.getAccountantSummary(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('resolves for ACCOUNTANT', async () => {
    const svc = makeStub()
    await expect(svc.getAccountantSummary(user('ACCOUNTANT'))).resolves.toBeDefined()
  })

  it('resolves for ADMIN', async () => {
    const svc = makeStub()
    await expect(svc.getAccountantSummary(user('ADMIN'))).resolves.toBeDefined()
  })

  it('maps an empty aggregate row to the zero-valued KPI shape (AC4)', async () => {
    const svc = makeStub()
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    expect(r).toEqual({
      pendingValidation: { count: 0, amount: 0 },
      validatedThisMonth: { count: 0, amount: 0 },
      paidThisMonth: { amount: 0 },
      recipientCount: 0,
    })
  })
})
