/**
 * Unit tests for TransactionsService.getIncomeComplianceOverview — RBAC guard +
 * the pure X/N compliance aggregation (counted = VALIDATED|PAID this month,
 * pending-only badge, laggards-first sort, receiver grouping by income type).
 *
 * The aggregation is deterministic JS over rows the service reads via the
 * Drizzle relational-query API (`db.query.<entity>.findMany`), so it is honestly
 * unit-testable with a hand-rolled stub that returns canned rows — no Postgres
 * needed. The end-to-end 403 / 200 guarantees against a REAL request + real RBAC
 * guards + real crm_qa live in `income-compliance.integration.spec.ts`.
 *
 * What stays here (DB-independent, fast):
 *   - RBAC (AC4): SENIOR / JUNIOR / HR / DROP → ForbiddenException BEFORE any DB
 *     access; ADMIN / ACCOUNTANT → resolve.
 *   - X/N math (AC1/AC2): submitted = projects with a VALIDATED|PAID income this
 *     month; PENDING-only → pendingValidation flag, NOT submitted; REJECTED
 *     ignored; ADMIN_INCOME (PAID) counts; cross-month rows ignored.
 *   - Only active projects in N (AC3) — the stub only returns active projects
 *     (service filters archivedAt IS NULL at the DB layer).
 *   - Receiver grouping: SENIOR_INCOME for seniorId-SENIOR, ADMIN_INCOME for
 *     seniorId-ADMIN, DROP_INCOME for dropId; one project can feed two receivers.
 *   - Laggards-first sort.
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
  users?: AnyRow[]
  transactions?: AnyRow[]
}

/**
 * Minimal DatabaseService stub for the relational-query path used by
 * getIncomeComplianceOverview: projects.findMany (active projects),
 * users.findMany (owners), transactions.findMany (income rows for the month).
 */
function makeService(data: StubData = {}): TransactionsService {
  const dbStub = {
    db: {
      query: {
        projects: { findMany: () => Promise.resolve(data.projects ?? []) },
        users: { findMany: () => Promise.resolve(data.users ?? []) },
        transactions: { findMany: () => Promise.resolve(data.transactions ?? []) },
      },
    },
  }
  return new TransactionsService(dbStub as never, {} as never, {} as never)
}

const now = new Date()
const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
const thisMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

describe('getIncomeComplianceOverview — RBAC guard (AC4)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'DROP']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for ${role} (before any DB access)`, async () => {
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
      await expect(svc.getIncomeComplianceOverview(user(role))).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })
  }

  it('resolves for ADMIN', async () => {
    const svc = makeService()
    await expect(svc.getIncomeComplianceOverview(user('ADMIN'))).resolves.toBeDefined()
  })

  it('resolves for ACCOUNTANT', async () => {
    const svc = makeService()
    await expect(svc.getIncomeComplianceOverview(user('ACCOUNTANT'))).resolves.toBeDefined()
  })
})

describe('getIncomeComplianceOverview — empty state', () => {
  it('returns zeroed totals + empty receivers when no active projects', async () => {
    const svc = makeService({ projects: [] })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(r.month).toBe(thisMonthKey)
    expect(r.totals).toEqual({
      expectedProjects: 0,
      submittedProjects: 0,
      laggingReceivers: 0,
      completeReceivers: 0,
      pendingProjects: 0,
    })
    expect(r.receivers).toEqual([])
  })
})

describe('getIncomeComplianceOverview — counted criterion (AC2)', () => {
  // One SENIOR owning 3 projects: p1 VALIDATED (counted), p2 PAID (counted),
  // p3 PENDING-only (NOT counted, pendingValidation badge).
  const baseSenior = { id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' }
  const projects = [
    { id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null },
    { id: 'p2', name: 'P2', companyName: 'C2', seniorId: 'sr-1', dropId: null },
    { id: 'p3', name: 'P3', companyName: 'C3', seniorId: 'sr-1', dropId: null },
  ]

  it('VALIDATED and PAID count; PENDING does not (but flags pendingValidation)', async () => {
    const svc = makeService({
      projects,
      users: [baseSenior],
      transactions: [
        { type: 'SENIOR_INCOME', status: 'VALIDATED', projectId: 'p1', txDate: thisMonth },
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p2', txDate: thisMonth },
        { type: 'SENIOR_INCOME', status: 'PENDING', projectId: 'p3', txDate: thisMonth },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(r.receivers).toHaveLength(1)
    const rec = r.receivers[0]!
    expect(rec.expected).toBe(3)
    expect(rec.submitted).toBe(2)
    expect(rec.pendingCount).toBe(1)
    expect(rec.missingProjects).toHaveLength(1)
    expect(rec.missingProjects[0]).toMatchObject({
      projectId: 'p3',
      submitted: false,
      pendingValidation: true,
    })
    expect(r.totals).toMatchObject({
      expectedProjects: 3,
      submittedProjects: 2,
      pendingProjects: 1,
      laggingReceivers: 1,
      completeReceivers: 0,
    })
  })

  it('REJECTED income is ignored (project counts as missing, not pending)', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [baseSenior],
      transactions: [
        { type: 'SENIOR_INCOME', status: 'REJECTED', projectId: 'p1', txDate: thisMonth },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const rec = r.receivers[0]!
    expect(rec.submitted).toBe(0)
    expect(rec.pendingCount).toBe(0)
    expect(rec.missingProjects[0]).toMatchObject({ pendingValidation: false })
  })

  it('income dated in another month does not count toward the target month', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [baseSenior],
      transactions: [{ type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p1', txDate: lastMonth }],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(r.receivers[0]!.submitted).toBe(0)
  })

  it('falls back to createdAt when txDate is null', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [baseSenior],
      transactions: [
        {
          type: 'SENIOR_INCOME',
          status: 'PAID',
          projectId: 'p1',
          txDate: null,
          createdAt: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(r.receivers[0]!.submitted).toBe(1)
  })

  it('multiple counted incomes on the SAME project count the project ONCE', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [baseSenior],
      transactions: [
        { type: 'SENIOR_INCOME', status: 'VALIDATED', projectId: 'p1', txDate: thisMonth },
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p1', txDate: thisMonth },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const rec = r.receivers[0]!
    expect(rec.expected).toBe(1)
    expect(rec.submitted).toBe(1)
  })
})

describe('getIncomeComplianceOverview — receiver grouping by income type', () => {
  it('ADMIN-as-senior is matched against ADMIN_INCOME (role label ADMIN_SENIOR)', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'adm-1', dropId: null }],
      users: [{ id: 'adm-1', displayName: 'Admin Owner', role: 'ADMIN' }],
      transactions: [
        // ADMIN_INCOME is written PAID immediately → counts.
        { type: 'ADMIN_INCOME', status: 'PAID', projectId: 'p1', txDate: thisMonth },
        // A SENIOR_INCOME on the same project must NOT count for an admin owner.
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p1', txDate: thisMonth },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const rec = r.receivers[0]!
    expect(rec.role).toBe('ADMIN_SENIOR')
    expect(rec.submitted).toBe(1)
  })

  it('a drop project feeds the DROP owner via DROP_INCOME, AND the senior owner via SENIOR_INCOME', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: 'drop-1' }],
      users: [
        { id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' },
        { id: 'drop-1', displayName: 'Drop One', role: 'DROP' },
      ],
      transactions: [
        { type: 'DROP_INCOME', status: 'VALIDATED', projectId: 'p1', txDate: thisMonth },
        // No SENIOR_INCOME → the senior owner is missing it.
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const senior = r.receivers.find((x) => x.userId === 'sr-1')!
    const drop = r.receivers.find((x) => x.userId === 'drop-1')!
    expect(senior.role).toBe('SENIOR')
    expect(senior.submitted).toBe(0) // no SENIOR_INCOME this month
    expect(drop.role).toBe('DROP')
    expect(drop.submitted).toBe(1) // DROP_INCOME validated
  })
})

describe('getIncomeComplianceOverview — laggards-first sort', () => {
  it('orders receivers by ascending coverage ratio (worst on top)', async () => {
    const svc = makeService({
      projects: [
        // sr-complete: 1/1
        { id: 'pa', name: 'PA', companyName: 'CA', seniorId: 'sr-complete', dropId: null },
        // sr-half: 1/2
        { id: 'pb', name: 'PB', companyName: 'CB', seniorId: 'sr-half', dropId: null },
        { id: 'pc', name: 'PC', companyName: 'CC', seniorId: 'sr-half', dropId: null },
        // sr-zero: 0/1
        { id: 'pd', name: 'PD', companyName: 'CD', seniorId: 'sr-zero', dropId: null },
      ],
      users: [
        { id: 'sr-complete', displayName: 'Complete', role: 'SENIOR' },
        { id: 'sr-half', displayName: 'Half', role: 'SENIOR' },
        { id: 'sr-zero', displayName: 'Zero', role: 'SENIOR' },
      ],
      transactions: [
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'pa', txDate: thisMonth },
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'pb', txDate: thisMonth },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ACCOUNTANT'))
    expect(r.receivers.map((x) => x.userId)).toEqual(['sr-zero', 'sr-half', 'sr-complete'])
    expect(r.totals).toMatchObject({
      expectedProjects: 4,
      submittedProjects: 2,
      laggingReceivers: 2,
      completeReceivers: 1,
    })
  })
})

describe('getIncomeComplianceOverview — explicit month param', () => {
  it('honours ?month=YYYY-MM (last month) and echoes the resolved key', async () => {
    const lastMonthKey = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, '0')}`
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [{ id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' }],
      transactions: [
        // dated last month → counts ONLY when the target month is last month.
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p1', txDate: lastMonth },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), lastMonthKey)
    expect(r.month).toBe(lastMonthKey)
    expect(r.receivers[0]!.submitted).toBe(1)
  })
})
