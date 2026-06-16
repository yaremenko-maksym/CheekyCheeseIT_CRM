/**
 * Unit tests for TransactionsService.getSeniorSummary — RBAC guard + the pure
 * aggregation math (senior-share computation, salary-status mapping).
 *
 * The KPI math here is deterministic JS over rows the service reads via the
 * Drizzle relational-query API (`db.query.<entity>.findMany/findFirst`), so it
 * is honestly unit-testable with a hand-rolled stub that returns canned rows —
 * no Postgres needed. The end-to-end self-scoping / 403 guarantees against a
 * REAL request + real RBAC guards live in `senior-summary.integration.spec.ts`
 * (real Fastify + JwtAuthGuard + RolesGuard + real crm_qa).
 *
 * What stays here (DB-independent, fast):
 *   - RBAC (AC2): JUNIOR / HR / ACCOUNTANT / DROP → ForbiddenException, thrown
 *     BEFORE any DB access; SENIOR / ADMIN → resolve.
 *   - Senior-share math (AC1): seniorShareIncome = Σ amount * sharePercent/100
 *     over PAID SENIOR_INCOME, split total vs this-month by txDate ?? createdAt.
 *   - pendingPayouts = Σ payableAmount of own PENDING payout_requests.
 *   - activeProjects share% resolution (project override wins; else user default).
 *   - mySalaryStatus mapping (valid status → {amount,status}; none → null).
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

type AnyRow = Record<string, unknown>

interface StubData {
  projects?: AnyRow[]
  selfUser?: AnyRow | undefined
  paidIncome?: AnyRow[]
  payoutRequests?: AnyRow[]
  salaryRow?: AnyRow | undefined
  teamMembers?: AnyRow[]
}

/**
 * Minimal DatabaseService stub for the relational-query path used by
 * getSeniorSummary. Each `query.<entity>` exposes findMany/findFirst returning
 * the canned rows. `teamMembers.findMany` feeds findActiveTeamsForUser (we keep
 * it empty so the share resolver falls through to project-override / default).
 */
function makeService(data: StubData = {}): TransactionsService {
  const dbStub = {
    db: {
      query: {
        projects: { findMany: () => Promise.resolve(data.projects ?? []) },
        users: { findFirst: () => Promise.resolve(data.selfUser) },
        transactions: {
          findMany: () => Promise.resolve(data.paidIncome ?? []),
          findFirst: () => Promise.resolve(data.salaryRow),
        },
        payoutRequests: { findMany: () => Promise.resolve(data.payoutRequests ?? []) },
        teamMembers: { findMany: () => Promise.resolve(data.teamMembers ?? []) },
      },
    },
  }
  return new TransactionsService(dbStub as never, {} as never, {} as never)
}

const now = new Date()
const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))

describe('getSeniorSummary — RBAC guard (AC2)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for ${role} (before any DB access)`, async () => {
      // Stub whose query access throws — proves the guard fires BEFORE any read.
      const throwingDb = {
        db: {
          query: {
            projects: {
              findMany: () => {
                throw new Error('DB must not be queried for forbidden roles')
              },
            },
          },
        },
      }
      const svc = new TransactionsService(throwingDb as never, {} as never, {} as never)
      await expect(svc.getSeniorSummary(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('resolves for SENIOR', async () => {
    const svc = makeService({ selfUser: { seniorSharePercent: 26 } })
    await expect(svc.getSeniorSummary(user('SENIOR'))).resolves.toBeDefined()
  })

  it('resolves for ADMIN', async () => {
    const svc = makeService({ selfUser: { seniorSharePercent: 26 } })
    await expect(svc.getSeniorSummary(user('ADMIN'))).resolves.toBeDefined()
  })
})

describe('getSeniorSummary — empty state maps to zero KPI', () => {
  it('returns zeroed shape when the senior has nothing', async () => {
    const svc = makeService({ selfUser: { seniorSharePercent: 26 } })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r).toEqual({
      activeProjects: { count: 0, items: [] },
      seniorShareIncome: { total: 0, thisMonth: 0, currency: 'USD' },
      pendingPayouts: { count: 0, amount: 0 },
      mySalaryStatus: null,
    })
  })
})

describe('getSeniorSummary — senior-share income math (AC1)', () => {
  it('sums amount * seniorSharePercent/100 over PAID SENIOR_INCOME (total + this month)', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      paidIncome: [
        // share snapshot 30% this month: 1000 * 0.30 = 300
        { amount: '1000', seniorSharePercent: 30, txDate: thisMonth, createdAt: thisMonth },
        // share snapshot 25% last month: 800 * 0.25 = 200 (total only)
        { amount: '800', seniorSharePercent: 25, txDate: lastMonth, createdAt: lastMonth },
        // null snapshot → falls back to user default 26%: 500 * 0.26 = 130 this month
        { amount: '500', seniorSharePercent: null, txDate: thisMonth, createdAt: thisMonth },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    // total = 300 + 200 + 130 = 630
    expect(r.seniorShareIncome.total).toBeCloseTo(630, 6)
    // this month = 300 + 130 = 430
    expect(r.seniorShareIncome.thisMonth).toBeCloseTo(430, 6)
    expect(r.seniorShareIncome.currency).toBe('USD')
  })

  it('uses createdAt for the month window when txDate is null', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 50 },
      paidIncome: [{ amount: '200', seniorSharePercent: 50, txDate: null, createdAt: thisMonth }],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.seniorShareIncome.total).toBeCloseTo(100, 6)
    expect(r.seniorShareIncome.thisMonth).toBeCloseTo(100, 6)
  })

  it('ignores non-finite amounts defensively', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      paidIncome: [{ amount: 'not-a-number', seniorSharePercent: 26, createdAt: thisMonth }],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.seniorShareIncome.total).toBe(0)
  })
})

describe('getSeniorSummary — pendingPayouts (AC1)', () => {
  it('counts own PENDING payout_requests and sums payableAmount', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      payoutRequests: [
        { payableAmount: '740' },
        { payableAmount: '260.5' },
        { payableAmount: 'bogus' }, // non-finite → skipped from sum but still counted as a row
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.pendingPayouts.count).toBe(3)
    expect(r.pendingPayouts.amount).toBeCloseTo(1000.5, 6)
  })
})

describe('getSeniorSummary — activeProjects share% resolution (AC1)', () => {
  it('project override wins; else falls back to user default', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      projects: [
        { id: 'p1', name: 'Proj One', companyName: 'Acme', seniorSharePercentOverride: 40 },
        { id: 'p2', name: 'Proj Two', companyName: 'Globex', seniorSharePercentOverride: null },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.activeProjects.count).toBe(2)
    expect(r.activeProjects.items[0]).toEqual({
      id: 'p1',
      name: 'Proj One',
      companyName: 'Acme',
      sharePercent: 40,
    })
    expect(r.activeProjects.items[1]!.sharePercent).toBe(26)
  })
})

describe('getSeniorSummary — mySalaryStatus mapping', () => {
  it('maps a current-month SALARY row to {amount,status}', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      salaryRow: { amount: '1500', status: 'PENDING' },
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.mySalaryStatus).toEqual({ amount: 1500, status: 'PENDING' })
  })

  it('maps an invalid salary status to null (defensive)', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      salaryRow: { amount: '1500', status: 'REJECTED' },
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.mySalaryStatus).toBeNull()
  })
})
