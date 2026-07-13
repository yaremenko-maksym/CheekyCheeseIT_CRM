/**
 * Security-review PR #367 (MED-1) — declareUsdtProjectIncome idempotency branch,
 * unit-level.
 *
 * Real-DB behavior (replay / race / no-double-book) is proven in
 * usdt-income-idempotency.integration.spec.ts. THESE unit tests pin the
 * control-flow contract with a mocked `db` — no Postgres needed:
 *
 *   - Replay (early-SELECT hit) returns the existing row via findOne and does
 *     NOT open a db.transaction (⇒ no insert, no bookCompanyObligations).
 *   - The RBAC gate runs BEFORE the idempotency lookup (defense-in-depth): a
 *     non-admin never reaches the replay SELECT, so a leaked row is impossible.
 *   - A cache miss (no existing row) does NOT short-circuit — the method
 *     proceeds to the normal validation path.
 *
 * The mock mirrors the drizzle surface the method touches:
 *   this.db.db.query.transactions.findFirst  — the early-SELECT.
 *   this.db.db.query.projects.findFirst      — project load (post early-SELECT).
 *   this.db.db.transaction(cb)               — the insert + obligations unit.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_RECEIVER } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const ADMIN: SessionUser = {
  id: 'admin-actor',
  role: 'ADMIN',
  displayName: 'Admin Actor',
  email: 'admin@x.com',
  avatarUrl: null,
  seniorSharePercent: 0,
}
const SENIOR: SessionUser = { ...ADMIN, id: 'senior-actor', role: 'SENIOR' }

const KEY = 'a1a2a3a4-0000-4000-8000-000000000001'
const PROJECT_ID = 'b1b2b3b4-0000-4000-8000-000000000001'

interface MockOverrides {
  existing?: { id: string; type: string; idempotencyKey: string } | undefined
}

function makeService(overrides: MockOverrides = {}) {
  const transactionSpy = vi.fn(async (_cb: (tx: unknown) => Promise<unknown>) => {
    throw new Error('db.transaction should not run on the idempotency early-return path')
  })
  const projectsFindFirst = vi.fn(async () => undefined)
  const txFindFirst = vi.fn(async () => overrides.existing ?? undefined)

  const drizzleClient = {
    transaction: transactionSpy,
    query: {
      transactions: { findFirst: txFindFirst },
      projects: { findFirst: projectsFindFirst },
    },
  }
  const db = { db: drizzleClient } as unknown
  const svc = makeTransactionsService({ db: db as never })

  // findOne is the tail return on the replay path — stub it to a sentinel so the
  // test does not need the full DTO-hydration db surface.
  vi.spyOn(svc, 'findOne').mockImplementation(
    async (id: string) => ({ id, type: 'ADMIN_INCOME' }) as never,
  )

  return { svc, transactionSpy, projectsFindFirst, txFindFirst }
}

describe('declareUsdtProjectIncome idempotency branch (unit, PR #367 MED-1)', () => {
  it('AC6: replay (existing row for the key) → returns it via findOne, NO db.transaction, NO project load', async () => {
    const { svc, transactionSpy, projectsFindFirst, txFindFirst } = makeService({
      existing: { id: 'existing-admin-income', type: 'ADMIN_INCOME', idempotencyKey: KEY },
    })

    const res = await svc.declareUsdtProjectIncome(
      {
        projectId: PROJECT_ID,
        amount: 1000,
        receiverId: COMPANY_ACCOUNT_RECEIVER,
        idempotencyKey: KEY,
      },
      ADMIN,
    )

    // Returns the EXISTING row (via the findOne stub) — not a fresh income.
    expect(res).toEqual({ id: 'existing-admin-income', type: 'ADMIN_INCOME' })
    // The early-SELECT ran exactly once...
    expect(txFindFirst).toHaveBeenCalledTimes(1)
    // ...and short-circuited: no transaction (⇒ no insert / bookCompanyObligations),
    // no project load, no share resolution.
    expect(transactionSpy).not.toHaveBeenCalled()
    expect(projectsFindFirst).not.toHaveBeenCalled()
  })

  it('AC6: RBAC gate precedes the idempotency lookup — non-admin → 403, replay SELECT never runs', async () => {
    const { svc, txFindFirst, transactionSpy } = makeService({
      existing: { id: 'existing-admin-income', type: 'ADMIN_INCOME', idempotencyKey: KEY },
    })

    await expect(
      svc.declareUsdtProjectIncome(
        {
          projectId: PROJECT_ID,
          amount: 1000,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: KEY,
        },
        SENIOR,
      ),
    ).rejects.toThrow(ForbiddenException)

    // Defense-in-depth: even WITH a matching row present, a non-admin never
    // reaches the replay SELECT — so no existing income can leak on replay.
    expect(txFindFirst).not.toHaveBeenCalled()
    expect(transactionSpy).not.toHaveBeenCalled()
  })

  it('AC6: no existing row → does NOT short-circuit; proceeds to the normal path', async () => {
    const { svc, txFindFirst, projectsFindFirst, transactionSpy } = makeService({}) // findFirst → undefined

    // projects.findFirst returns undefined → 'Project not found' on the normal
    // path — proving the miss fell through the early-SELECT rather than returning.
    await expect(
      svc.declareUsdtProjectIncome(
        {
          projectId: PROJECT_ID,
          amount: 1000,
          receiverId: COMPANY_ACCOUNT_RECEIVER,
          idempotencyKey: KEY,
        },
        ADMIN,
      ),
    ).rejects.toThrow(NotFoundException)

    expect(txFindFirst).toHaveBeenCalledTimes(1)
    expect(projectsFindFirst).toHaveBeenCalledTimes(1)
    expect(transactionSpy).not.toHaveBeenCalled()
  })
})
