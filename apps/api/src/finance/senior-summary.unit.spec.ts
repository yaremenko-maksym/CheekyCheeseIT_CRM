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
 *   - mySalaryState mapping (4-state: NOT_CONFIGURED / NOT_CRON_ELIGIBLE /
 *     AWAITING_CREATION / EXISTS) + the DEPRECATED mySalaryStatus field
 *     derived from it (security-review MED-3, task-salary-month-gap-and-status).
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { CRON_ELIGIBLE_SALARY_ROLES } from './transactions.service'

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
        },
        payoutRequests: { findMany: () => Promise.resolve(data.payoutRequests ?? []) },
        teamMembers: { findMany: () => Promise.resolve(data.teamMembers ?? []) },
      },
      // security-review PR #456 round 2: mySalaryStatus now comes from
      // getOwnSalaryStatus, which reads the `nonDeletedTransactions` VIEW via
      // `.select().from(...).where(...).limit(1)` — not the relational-query
      // `transactions.findFirst` this stub used to provide.
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(data.salaryRow ? [data.salaryRow] : []),
          }),
        }),
      }),
    },
  }
  return makeTransactionsService({ db: dbStub as never })
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
      const svc = makeTransactionsService({ db: throwingDb as never })
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
    // task-senior-stats-block: earningsStats is part of the shape now. With no
    // income the history is an all-zero 8-month run and progress is 0/0.
    expect(r.activeProjects).toEqual({ count: 0, items: [] })
    expect(r.seniorShareIncome).toEqual({ total: 0, thisMonth: 0, currency: 'USD' })
    expect(r.pendingPayouts).toEqual({ count: 0, amount: 0 })
    // task-salary-month-gap-and-status (E-6): no `monthlySalary` on the stub
    // selfUser → NOT_CONFIGURED on the new `mySalaryState` field (not a bare
    // null — see mySalaryStateSchema). `mySalaryStatus` is the DEPRECATED
    // field kept byte-identical to the pre-E-6 shape (security-review MED-3)
    // — null whenever state !== EXISTS, exactly as before this task.
    expect(r.mySalaryState).toEqual({ state: 'NOT_CONFIGURED' })
    expect(r.mySalaryStatus).toBeNull()
    expect(r.earningsStats.lastMonthIncome).toBe(0)
    expect(r.earningsStats.monthlyHistory).toHaveLength(8)
    expect(r.earningsStats.monthlyHistory.every((p) => p.amount === 0)).toBe(true)
    expect(r.earningsStats.companyIncomeProgress).toEqual({ received: 0, total: 0 })
  })
})

// task-senior-stats-block — pure month-math + arrival-progress unit coverage.
describe('getSeniorSummary — earningsStats month math (AC4)', () => {
  const monthKey = (d: Date): string =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  const thisKey = monthKey(now)
  const lastKey = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))

  it('lastMonthIncome sums ONLY shares dated in the previous calendar month', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      paidIncome: [
        // this month: 1000 * 0.40 = 400 → NOT in lastMonth
        {
          amount: '1000',
          seniorSharePercent: 40,
          txDate: thisMonth,
          createdAt: thisMonth,
          projectId: 'p1',
        },
        // last month: 500 * 0.30 = 150 → lastMonthIncome
        {
          amount: '500',
          seniorSharePercent: 30,
          txDate: lastMonth,
          createdAt: lastMonth,
          projectId: 'p2',
        },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.earningsStats.lastMonthIncome).toBeCloseTo(150, 6)
  })

  it('monthlyHistory is an 8-month contiguous run, newest=this, prev=last', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      paidIncome: [
        {
          amount: '1000',
          seniorSharePercent: 40,
          txDate: thisMonth,
          createdAt: thisMonth,
          projectId: 'p1',
        },
        {
          amount: '500',
          seniorSharePercent: 30,
          txDate: lastMonth,
          createdAt: lastMonth,
          projectId: 'p2',
        },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    const hist = r.earningsStats.monthlyHistory
    expect(hist).toHaveLength(8)
    expect(hist[hist.length - 1]!.month).toBe(thisKey)
    expect(hist[hist.length - 1]!.amount).toBeCloseTo(400, 6)
    expect(hist[hist.length - 2]!.month).toBe(lastKey)
    expect(hist[hist.length - 2]!.amount).toBeCloseTo(150, 6)
    // strictly increasing month keys (no gaps / no dupes)
    for (let i = 1; i < hist.length; i++) {
      expect(hist[i]!.month > hist[i - 1]!.month).toBe(true)
    }
  })

  it('companyIncomeProgress: received counts ONLY active projects with income THIS month', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      projects: [
        { id: 'p1', name: 'A', companyName: 'Acme', seniorSharePercentOverride: null },
        { id: 'p2', name: 'B', companyName: 'Globex', seniorSharePercentOverride: null },
        { id: 'p3', name: 'C', companyName: 'Initech', seniorSharePercentOverride: null },
      ],
      paidIncome: [
        // p1 got income THIS month → counts
        {
          amount: '100',
          seniorSharePercent: 26,
          txDate: thisMonth,
          createdAt: thisMonth,
          projectId: 'p1',
        },
        // p2 only got income LAST month → does NOT count toward received
        {
          amount: '100',
          seniorSharePercent: 26,
          txDate: lastMonth,
          createdAt: lastMonth,
          projectId: 'p2',
        },
        // p3 has no income at all
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.earningsStats.companyIncomeProgress.total).toBe(3)
    expect(r.earningsStats.companyIncomeProgress.received).toBe(1)
  })

  it('received never exceeds total: income on a now-archived/non-active project is ignored', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      // Only p1 is an active project, but income exists on a stale id `p-old`.
      projects: [{ id: 'p1', name: 'A', companyName: 'Acme', seniorSharePercentOverride: null }],
      paidIncome: [
        {
          amount: '100',
          seniorSharePercent: 26,
          txDate: thisMonth,
          createdAt: thisMonth,
          projectId: 'p1',
        },
        {
          amount: '100',
          seniorSharePercent: 26,
          txDate: thisMonth,
          createdAt: thisMonth,
          projectId: 'p-old',
        },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.earningsStats.companyIncomeProgress.total).toBe(1)
    expect(r.earningsStats.companyIncomeProgress.received).toBe(1)
    expect(r.earningsStats.companyIncomeProgress.received).toBeLessThanOrEqual(
      r.earningsStats.companyIncomeProgress.total,
    )
  })

  it('multiple incomes from the SAME project this month count the project ONCE', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      projects: [
        { id: 'p1', name: 'A', companyName: 'Acme', seniorSharePercentOverride: null },
        { id: 'p2', name: 'B', companyName: 'Globex', seniorSharePercentOverride: null },
      ],
      paidIncome: [
        {
          amount: '100',
          seniorSharePercent: 26,
          txDate: thisMonth,
          createdAt: thisMonth,
          projectId: 'p1',
        },
        {
          amount: '200',
          seniorSharePercent: 26,
          txDate: thisMonth,
          createdAt: thisMonth,
          projectId: 'p1',
        },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.earningsStats.companyIncomeProgress.received).toBe(1)
    expect(r.earningsStats.companyIncomeProgress.total).toBe(2)
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

describe('getSeniorSummary — mySalaryState / mySalaryStatus mapping', () => {
  it('maps a current-month SALARY row to EXISTS on mySalaryState, and the legacy shape on mySalaryStatus', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      salaryRow: { amount: '1500', status: 'PENDING', currency: 'USD' },
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.mySalaryState).toEqual({
      state: 'EXISTS',
      amount: 1500,
      status: 'PENDING',
      currency: 'USD',
    })
    // security-review MED-3: the DEPRECATED field is DERIVED from the SAME
    // EXISTS row, not a second independent computation.
    expect(r.mySalaryStatus).toEqual({ amount: 1500, status: 'PENDING', currency: 'USD' })
  })

  it('maps an invalid salary status to NOT_CONFIGURED when monthlySalary is unset (defensive)', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26 },
      salaryRow: { amount: '1500', status: 'REJECTED' },
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.mySalaryState).toEqual({ state: 'NOT_CONFIGURED' })
    expect(r.mySalaryStatus).toBeNull()
  })

  // task-salary-month-gap-and-status security-review MED-3: `getSeniorSummary`
  // is reached ONLY by SENIOR/ADMIN (the RBAC gate at the top of the method),
  // and the monthly cron NEVER processes either role (only HR/ACCOUNTANT/
  // JUNIOR are cron-eligible — see CRON_ELIGIBLE_SALARY_ROLES). A SENIOR with
  // `monthlySalary` configured and no row yet must NOT read as
  // AWAITING_CREATION (that would falsely imply an automatic accrual is
  // coming) — it reads as NOT_CRON_ELIGIBLE, the same distinction E-5 already
  // draws for the gap report's own population.
  it('maps "monthlySalary configured, no row yet" to NOT_CRON_ELIGIBLE for a SENIOR — the cron will never fill this in on its own', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26, monthlySalary: '2000' },
      salaryRow: undefined,
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.mySalaryState).toEqual({ state: 'NOT_CRON_ELIGIBLE' })
    expect(r.mySalaryStatus).toBeNull()
  })

  // mutation-gate: `selfUser` genuinely CAN be undefined here (the `users`
  // row lookup by `selfId` has no guarantee of a hit) — `Boolean(selfUser?.
  // monthlySalary)` must not throw when it's missing entirely. Without this
  // test, `selfUser?.monthlySalary` → `selfUser.monthlySalary` survived: every
  // other fixture always supplies a `selfUser` object, so nothing exercised
  // the `undefined` branch the `?.` guards.
  it('does not throw when selfUser is undefined (users lookup miss) — resolves to NOT_CONFIGURED', async () => {
    const svc = makeService({ selfUser: undefined, salaryRow: undefined })
    await expect(svc.getSeniorSummary(user('SENIOR'))).resolves.toBeDefined()
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.mySalaryState).toEqual({ state: 'NOT_CONFIGURED' })
    expect(r.mySalaryStatus).toBeNull()
  })

  it('an ADMIN caller (debugging as themselves) is also never cron-eligible', async () => {
    const svc = makeService({
      selfUser: { seniorSharePercent: 26, monthlySalary: '5000' },
      salaryRow: undefined,
    })
    const r = await svc.getSeniorSummary(user('ADMIN'))
    expect(r.mySalaryState).toEqual({ state: 'NOT_CRON_ELIGIBLE' })
  })
})

// security-review round 3 (mutation gate on origin/main): CRON_ELIGIBLE_SALARY_ROLES's
// only current runtime call site is getSeniorSummary above, whose RBAC guard
// restricts callers to SENIOR/ADMIN — NEITHER of which is ever a member of
// this set, so `.has(currentUser.role)` is FALSE for every real caller no
// matter what the set actually contains. Emptying it, or blanking any one
// of its 3 literals, changed nothing the tests above could observe (all 4
// mutants survived). Pinned directly here instead — the exact membership
// the const's own docblock claims ("mirrors exactly what
// resolveHrAccountantSalaryReceivers / resolveJuniorSalaryReceivers
// target").
describe('CRON_ELIGIBLE_SALARY_ROLES — exact membership (pinned directly, not through a caller)', () => {
  it('contains exactly HR, ACCOUNTANT, JUNIOR — the roles createMonthlySalaries actually accrues to', () => {
    expect([...CRON_ELIGIBLE_SALARY_ROLES].sort()).toEqual(['ACCOUNTANT', 'HR', 'JUNIOR'])
  })

  it('does NOT contain SENIOR, DROP, or ADMIN — they can only ever get a MANUALLY created salary', () => {
    expect(CRON_ELIGIBLE_SALARY_ROLES.has('SENIOR')).toBe(false)
    expect(CRON_ELIGIBLE_SALARY_ROLES.has('DROP')).toBe(false)
    expect(CRON_ELIGIBLE_SALARY_ROLES.has('ADMIN')).toBe(false)
  })
})
