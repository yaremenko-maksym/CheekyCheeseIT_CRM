/**
 * Direct unit tests for SalaryService (T-L6): the db-only salary collaborator
 * extracted from TransactionsService. The flows through TransactionsService
 * stay covered by pay-salary* / salary-month-gap* / salary-archived-receiver*;
 * this file pins the extracted seams directly, with expected values taken from
 * literal rosters (never recomputed by the code under test).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { DatabaseService } from '../database/database.service'
import { SalaryService } from './salary.service'

type Row = Record<string, unknown>

function sessionUser(role: SessionUser['role']): SessionUser {
  return {
    id: `${role.toLowerCase()}-1`,
    role,
    displayName: `Test ${role}`,
    email: `${role.toLowerCase()}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

function makeService(opts: {
  employees?: Row[]
  members?: Row[]
  markerReceiverIds?: string[]
  automaticReceiverIds?: string[]
}) {
  // First select() is the marker read, the second the automatic-rows read
  // (Promise.all order in resolveSalaryMonthGap).
  let call = 0
  const select = vi.fn(() => {
    const ids = call++ === 0 ? opts.markerReceiverIds : opts.automaticReceiverIds
    return {
      from: () => ({
        where: () => Promise.resolve((ids ?? []).map((receiverId) => ({ receiverId }))),
      }),
    }
  })
  const db = {
    db: {
      query: {
        users: { findMany: vi.fn(async () => opts.employees ?? []) },
        projectMembers: { findMany: vi.fn(async () => opts.members ?? []) },
      },
      select,
    },
  } as unknown as DatabaseService
  return { svc: new SalaryService(db), db, select }
}

describe('SalaryService.resolveHrAccountantSalaryReceivers', () => {
  it('returns only employees with a monthlySalary, mapped to the receiver shape', async () => {
    const { svc } = makeService({
      employees: [
        { id: 'hr-1', email: 'hr@x.io', displayName: 'Hana', role: 'HR', monthlySalary: '1000.00' },
        {
          id: 'ac-1',
          email: 'ac@x.io',
          displayName: 'Ada',
          role: 'ACCOUNTANT',
          monthlySalary: '1500.00',
        },
        { id: 'hr-2', email: 'nosal@x.io', displayName: 'Nina', role: 'HR', monthlySalary: null },
      ],
    })
    expect(await svc.resolveHrAccountantSalaryReceivers()).toEqual([
      { id: 'hr-1', email: 'hr@x.io', displayName: 'Hana', role: 'HR', monthlySalary: '1000.00' },
      {
        id: 'ac-1',
        email: 'ac@x.io',
        displayName: 'Ada',
        role: 'ACCOUNTANT',
        monthlySalary: '1500.00',
      },
    ])
  })
})

describe('SalaryService.resolveJuniorSalaryReceivers', () => {
  const junior = (over: Row = {}) => ({
    id: 'jr-1',
    email: 'jr@x.io',
    displayName: 'Jun',
    role: 'JUNIOR',
    archivedAt: null,
    monthlySalary: '300.00',
    ...over,
  })
  const project = (over: Row = {}) => ({
    id: 'p-1',
    name: 'Alpha',
    status: 'ACTIVE',
    financeSettings: null,
    ...over,
  })

  it('maps an active junior; a project override beats the user default', async () => {
    const { svc } = makeService({
      members: [
        {
          user: junior(),
          project: project({ financeSettings: { juniorSalaryOverride: '450.00' } }),
        },
      ],
    })
    expect(await svc.resolveJuniorSalaryReceivers()).toEqual([
      {
        id: 'jr-1',
        email: 'jr@x.io',
        displayName: 'Jun',
        monthlySalary: '450.00',
        projectId: 'p-1',
        projectName: 'Alpha',
      },
    ])
  })

  it('skips archived, non-junior, non-ACTIVE-project, salary-less and orphan memberships', async () => {
    const { svc } = makeService({
      members: [
        { user: junior({ archivedAt: new Date() }), project: project() },
        { user: junior({ id: 'sr-1', role: 'SENIOR' }), project: project() },
        { user: junior({ id: 'jr-2' }), project: project({ status: 'DRAFT' }) },
        { user: junior({ id: 'jr-3', monthlySalary: null }), project: project() },
        { user: null, project: project() },
        { user: junior({ id: 'jr-4' }), project: null },
      ],
    })
    expect(await svc.resolveJuniorSalaryReceivers()).toEqual([])
  })

  it('counts a junior on two projects once — the first membership wins', async () => {
    const { svc } = makeService({
      members: [
        { user: junior(), project: project() },
        { user: junior(), project: project({ id: 'p-2', name: 'Beta' }) },
      ],
    })
    const out = await svc.resolveJuniorSalaryReceivers()
    expect(out.map((r) => r.projectId)).toEqual(['p-1'])
  })
})

describe('SalaryService.assertSalaryReceiverNotArchived', () => {
  const dbWith = (user: Row | undefined) =>
    ({ query: { users: { findFirst: vi.fn(async () => user) } } }) as never

  it('does not touch the db for a null receiver', async () => {
    const { svc } = makeService({})
    const db = dbWith(undefined)
    await expect(svc.assertSalaryReceiverNotArchived(db, null)).resolves.toBeUndefined()
    expect(
      (db as never as { query: { users: { findFirst: unknown } } }).query.users.findFirst,
    ).not.toHaveBeenCalled()
  })

  it('rejects an archived receiver with the stable error code', async () => {
    const { svc } = makeService({})
    await expect(
      svc.assertSalaryReceiverNotArchived(dbWith({ id: 'u', archivedAt: new Date() }), 'u'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED' }),
      status: 400,
    })
  })

  it('passes for an active receiver and for a missing one', async () => {
    const { svc } = makeService({})
    await expect(
      svc.assertSalaryReceiverNotArchived(dbWith({ id: 'u', archivedAt: null }), 'u'),
    ).resolves.toBeUndefined()
    await expect(
      svc.assertSalaryReceiverNotArchived(dbWith(undefined), 'u'),
    ).resolves.toBeUndefined()
  })
})

describe('SalaryService.salaryReceiverNotArchivedFilter', () => {
  it('compiles to a NOT EXISTS correlated sub-select on archived users', () => {
    const { svc } = makeService({})
    const { sql } = new PgDialect().sqlToQuery(svc.salaryReceiverNotArchivedFilter())
    expect(sql).toMatch(/not exists \(select "id" from "users" where/i)
    expect(sql).toContain('"users"."id" = "transactions"."receiver_id"')
    expect(sql).toContain('"users"."archived_at" is not null')
  })
})

describe('SalaryService.resolveSalaryMonthGap', () => {
  it('returns an empty report without reading evidence when nobody is expected', async () => {
    const { svc, select } = makeService({})
    expect(await svc.resolveSalaryMonthGap('2026-09')).toEqual({ month: '2026-09', missing: [] })
    expect(select).not.toHaveBeenCalled()
  })

  it('reports expected receivers minus those with a marker or an automatic row', async () => {
    const { svc } = makeService({
      employees: [
        { id: 'hr-1', email: 'a', displayName: 'A', role: 'HR', monthlySalary: '100.00' },
        { id: 'hr-2', email: 'b', displayName: 'B', role: 'HR', monthlySalary: '200.50' },
        { id: 'ac-1', email: 'c', displayName: 'C', role: 'ACCOUNTANT', monthlySalary: '300.00' },
      ],
      members: [
        {
          user: {
            id: 'jr-1',
            email: 'd',
            displayName: 'D',
            role: 'JUNIOR',
            archivedAt: null,
            monthlySalary: '50.00',
          },
          project: { id: 'p-1', name: 'Alpha', status: 'ACTIVE', financeSettings: null },
        },
      ],
      markerReceiverIds: ['hr-1'],
      automaticReceiverIds: ['ac-1'],
    })
    expect(await svc.resolveSalaryMonthGap('2026-09')).toEqual({
      month: '2026-09',
      missing: [
        {
          userId: 'hr-2',
          displayName: 'B',
          role: 'HR',
          expectedAmount: 200.5,
          projectId: null,
          projectName: null,
        },
        {
          userId: 'jr-1',
          displayName: 'D',
          role: 'JUNIOR',
          expectedAmount: 50,
          projectId: 'p-1',
          projectName: 'Alpha',
        },
      ],
    })
  })
})

describe('SalaryService.getSalaryMonthGapReport — RBAC guard', () => {
  it.each(['SENIOR', 'JUNIOR', 'HR', 'DROP'] as const)(
    'refuses %s before any db access',
    async (role) => {
      const { svc, db } = makeService({})
      await expect(svc.getSalaryMonthGapReport(sessionUser(role), '2026-09')).rejects.toMatchObject(
        {
          status: 403,
          response: expect.objectContaining({ code: 'FINANCE_SALARY_MONTH_GAP_FORBIDDEN' }),
        },
      )
      expect(db.db.query.users.findMany).not.toHaveBeenCalled()
    },
  )

  it.each(['ADMIN', 'ACCOUNTANT'] as const)('lets %s read the requested month', async (role) => {
    const { svc } = makeService({})
    expect(await svc.getSalaryMonthGapReport(sessionUser(role), '2026-08')).toEqual({
      month: '2026-08',
      missing: [],
    })
  })

  it('defaults to the previous calendar month for a fixed clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
    try {
      const { svc } = makeService({})
      const report = await svc.getSalaryMonthGapReport(sessionUser('ADMIN'))
      expect(report.month).toBe('2026-09')
    } finally {
      vi.useRealTimers()
    }
  })
})
