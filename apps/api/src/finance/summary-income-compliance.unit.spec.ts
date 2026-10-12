/**
 * Characterization of SummaryService.getIncomeComplianceOverview (the largest
 * cohesive cluster of summary.service.ts) ahead of its extraction.
 *
 * Complements summary.service.spec.ts / income-compliance.unit.spec.ts: those pin
 * the figures and the evidence-priority matrix; this file pins what they leave
 * open so that the extracted code reports 0 mutation survivors without any
 * Stryker directive:
 *   - the compiled soft-delete + type/status/project WHERE of the evidence read
 *     (exact SQL, not just bound params),
 *   - a date-less evidence row skips ONLY itself (a later valid row still counts),
 *   - the exact RBAC code + that the refusal happens before any DB access,
 *   - the receiver-scoped evidence key (stale / other-owner rows never leak),
 *   - role labels + exact receiver payloads and the tie-break chain of the sort.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { SummaryService } from './summary.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { compileWhere, collectParamValues } from './__test-helpers__/drizzle-where-introspection'
import { visibleProjects } from '../database/schema'

type Row = Record<string, unknown>

function user(role: SessionUser['role']): SessionUser {
  return {
    id: `${role.toLowerCase()}-1`,
    role,
    displayName: `Test ${role}`,
    email: `${role.toLowerCase()}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
    locale: 'en',
  }
}

const own = (id: string, displayName: string, role: string): Row => ({ id, displayName, role })
const proj = (id: string, seniorId: string, dropId: string | null = null): Row => ({
  id,
  name: `Proj ${id}`,
  companyName: `Co ${id}`,
  seniorId,
  dropId,
})
const inc = (
  type: string,
  status: string,
  projectId: string | null,
  receiverId: string | null,
  txDate: string | null = '2026-03-10T00:00:00Z',
  createdAt: string | null = '2026-03-10T00:00:00Z',
): Row => ({
  type,
  status,
  projectId,
  receiverId,
  txDate: txDate ? new Date(txDate) : null,
  createdAt: createdAt ? new Date(createdAt) : null,
})
const miss = (id: string, flags: { pendingValidation?: boolean; accrued?: boolean } = {}): Row => ({
  projectId: id,
  name: `Proj ${id}`,
  companyName: `Co ${id}`,
  submitted: false,
  pendingValidation: flags.pendingValidation ?? false,
  accrued: flags.accrued ?? false,
})

const MONTH = '2026-03'

function makeSvc(data: { owners?: Row[]; projects?: Row[]; txs?: Row[] } = {}) {
  const cap = {
    txWhere: undefined as unknown,
    usersWhere: undefined as unknown,
    projectsSelectArg: undefined as unknown,
    calls: [] as string[],
  }
  const db = {
    query: {
      users: {
        findMany: (args?: { where?: unknown }) => {
          cap.calls.push('users')
          cap.usersWhere = args?.where
          return Promise.resolve(data.owners ?? [])
        },
      },
      transactions: {
        findMany: (args?: { where?: unknown }) => {
          cap.calls.push('transactions')
          cap.txWhere = args?.where
          return Promise.resolve(data.txs ?? [])
        },
      },
    },
    select: (arg?: unknown) => ({
      from: (table: unknown) => {
        cap.calls.push('projects')
        if (table === visibleProjects) cap.projectsSelectArg = arg
        return Promise.resolve(table === visibleProjects ? (data.projects ?? []) : [])
      },
    }),
  }
  const svc = new SummaryService({ db } as never, {} as NbuCurrencyService)
  return { svc, cap }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('getIncomeComplianceOverview — RBAC', () => {
  it.each(['SENIOR', 'JUNIOR', 'HR', 'DROP'] as const)(
    '%s is refused with FINANCE_INCOME_COMPLIANCE_FORBIDDEN (403) before any DB access',
    async (role) => {
      const { svc, cap } = makeSvc({ projects: [proj('P1', 'S1')] })
      await expect(svc.getIncomeComplianceOverview(user(role), MONTH)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: 'FINANCE_INCOME_COMPLIANCE_FORBIDDEN' }),
      })
      expect(cap.calls).toEqual([])
    },
  )

  it.each(['ADMIN', 'ACCOUNTANT'] as const)('%s is admitted', async (role) => {
    const { svc } = makeSvc()
    await expect(svc.getIncomeComplianceOverview(user(role), MONTH)).resolves.toEqual({
      month: MONTH,
      totals: {
        expectedProjects: 0,
        submittedProjects: 0,
        laggingReceivers: 0,
        completeReceivers: 0,
        pendingProjects: 0,
        accruedProjects: 0,
      },
      receivers: [],
    })
  })
})

describe('getIncomeComplianceOverview — reads', () => {
  it('selects exactly the project columns the grouping needs from visibleProjects', async () => {
    const { svc, cap } = makeSvc({ projects: [] })
    await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(Object.keys(cap.projectsSelectArg as object).sort()).toEqual([
      'companyName',
      'dropId',
      'id',
      'name',
      'seniorId',
    ])
    expect(cap.calls).toEqual(['projects'])
  })

  it('evidence read: compiled WHERE = 6 types AND 4 statuses AND project ids AND not soft-deleted', async () => {
    const { svc, cap } = makeSvc({
      owners: [own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'S1'), proj('P2', 'S1')],
    })
    await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    const { sql, params } = compileWhere(cap.txWhere)
    expect(sql).toBe(
      '("transactions"."type" in ($1, $2, $3, $4, $5, $6) and ' +
        '"transactions"."status" in ($7, $8, $9, $10) and ' +
        '"transactions"."project_id" in ($11, $12) and ' +
        '"transactions"."deleted_at" is null)',
    )
    expect(params).toEqual([
      'SENIOR_INCOME',
      'ADMIN_INCOME',
      'DROP_INCOME',
      'SENIOR_PENDING_PAYOUT',
      'DROP_PENDING_PAYOUT',
      'PAYOUT_DROP',
      'VALIDATED',
      'PAID',
      'PENDING',
      'PENDING_PAYMENT',
      'P1',
      'P2',
    ])
  })

  it('owner read binds each distinct owner id once (senior then drop, null drop dropped)', async () => {
    const { svc, cap } = makeSvc({
      owners: [],
      projects: [proj('P1', 'S1', 'D1'), proj('P2', 'S1', null), proj('P3', 'S2', 'D1')],
    })
    await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(collectParamValues(cap.usersWhere)).toEqual(['S1', 'D1', 'S2'])
    expect(compileWhere(cap.usersWhere).sql).toBe('"users"."id" in ($1, $2, $3)')
  })
})

describe('getIncomeComplianceOverview — evidence rows', () => {
  it('requests exactly the owner and evidence columns the aggregation reads', async () => {
    let usersColumns: unknown
    let txColumns: unknown
    const db = {
      query: {
        users: {
          findMany: (a: { columns?: unknown }) => {
            usersColumns = a.columns
            return Promise.resolve([])
          },
        },
        transactions: {
          findMany: (a: { columns?: unknown }) => {
            txColumns = a.columns
            return Promise.resolve([])
          },
        },
      },
      select: () => ({ from: () => Promise.resolve([proj('P1', 'S1')]) }),
    }
    const svc = new SummaryService({ db } as never, {} as NbuCurrencyService)
    await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(usersColumns).toEqual({ id: true, displayName: true, role: true })
    expect(txColumns).toEqual({
      type: true,
      status: true,
      projectId: true,
      receiverId: true,
      txDate: true,
      createdAt: true,
    })
  })

  it('month window is [first instant, next first instant): both edges and the ms before', async () => {
    const mk = (txDate: string) =>
      makeSvc({
        owners: [own('S1', 'Sam', 'SENIOR')],
        projects: [proj('P1', 'S1')],
        txs: [inc('SENIOR_INCOME', 'PAID', 'P1', 'S1', txDate)],
      }).svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect((await mk('2026-03-01T00:00:00.000Z')).totals.submittedProjects).toBe(1)
    expect((await mk('2026-02-28T23:59:59.999Z')).totals.submittedProjects).toBe(0)
    expect((await mk('2026-03-31T23:59:59.999Z')).totals.submittedProjects).toBe(1)
    expect((await mk('2026-04-01T00:00:00.000Z')).totals.submittedProjects).toBe(0)
  })

  it.each([
    ['SENIOR', 'SENIOR_INCOME', 'VALIDATED'],
    ['SENIOR', 'SENIOR_INCOME', 'PAID'],
    ['SENIOR', 'SENIOR_INCOME', 'PENDING_PAYMENT'],
    ['DROP', 'DROP_INCOME', 'VALIDATED'],
    ['DROP', 'DROP_INCOME', 'PAID'],
    ['DROP', 'PAYOUT_DROP', 'PAID'],
    ['ADMIN', 'ADMIN_INCOME', 'VALIDATED'],
  ] as const)('%s owner: %s/%s counts as submitted', async (role, type, status) => {
    const id = 'O1'
    const { svc } = makeSvc({
      owners: [own(id, 'Owner', role)],
      projects: [role === 'DROP' ? proj('P1', 'S9', id) : proj('P1', id)],
      txs: [inc(type, status, 'P1', id)],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.receivers[0]).toMatchObject({ submitted: 1, pendingCount: 0, accruedCount: 0 })
    expect(r.receivers[0]!.missingProjects).toEqual([])
    expect(r.totals).toMatchObject({ completeReceivers: 1, laggingReceivers: 0 })
  })

  it.each([
    ['SENIOR', 'SENIOR_PENDING_PAYOUT'],
    ['DROP', 'DROP_PENDING_PAYOUT'],
    ['DROP', 'PAYOUT_DROP'],
  ] as const)('%s owner: %s of ANOTHER receiver is not evidence', async (role, type) => {
    const { svc } = makeSvc({
      owners: [own('O1', 'Owner', role)],
      projects: [role === 'DROP' ? proj('P1', 'S9', 'O1') : proj('P1', 'O1')],
      txs: [inc(type, type === 'PAYOUT_DROP' ? 'PAID' : 'PENDING_PAYMENT', 'P1', 'OTHER')],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.receivers[0]).toMatchObject({ submitted: 0, accruedCount: 0, pendingCount: 0 })
  })

  it('SENIOR_PENDING_PAYOUT booked for the senior itself is accrued; PAID obligation-type is not accrued', async () => {
    const { svc } = makeSvc({
      owners: [own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'S1'), proj('P2', 'S1')],
      txs: [
        inc('SENIOR_PENDING_PAYOUT', 'PENDING_PAYMENT', 'P1', 'S1'),
        inc('SENIOR_PENDING_PAYOUT', 'PAID', 'P2', 'S1'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.receivers[0]).toMatchObject({ submitted: 1, accruedCount: 1 })
    expect(r.receivers[0]!.missingProjects).toEqual([miss('P1', { accrued: true })])
  })

  it('a row with neither txDate nor createdAt skips only itself; later valid rows still count', async () => {
    const { svc } = makeSvc({
      owners: [own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'S1'), proj('P2', 'S1')],
      txs: [
        inc('SENIOR_INCOME', 'PAID', 'P1', 'S1', null, null),
        inc('SENIOR_INCOME', 'PAID', 'P2', 'S1'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.receivers).toEqual([
      {
        userId: 'S1',
        displayName: 'Sam',
        role: 'SENIOR',
        expected: 2,
        submitted: 1,
        pendingCount: 0,
        accruedCount: 0,
        missingProjects: [miss('P1')],
      },
    ])
  })

  it('an out-of-month row is skipped without ending the scan (continue, not break)', async () => {
    const { svc } = makeSvc({
      owners: [own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'S1'), proj('P2', 'S1')],
      txs: [
        inc('SENIOR_INCOME', 'PAID', 'P1', 'S1', '2026-02-10T00:00:00Z'),
        inc('SENIOR_INCOME', 'PAID', 'P2', 'S1'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.totals).toEqual({
      expectedProjects: 2,
      submittedProjects: 1,
      laggingReceivers: 1,
      completeReceivers: 0,
      pendingProjects: 0,
      accruedProjects: 0,
    })
  })

  it('obligation evidence is receiver-scoped: a previous owner’s row never satisfies the new owner', async () => {
    const { svc } = makeSvc({
      owners: [own('D2', 'Newdrop', 'DROP')],
      projects: [proj('P1', 'S9', 'D2')],
      txs: [
        inc('DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', 'P1', 'D1'),
        inc('PAYOUT_DROP', 'PAID', 'P1', 'D1'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ACCOUNTANT'), MONTH)
    expect(r.receivers).toEqual([
      {
        userId: 'D2',
        displayName: 'Newdrop',
        role: 'DROP',
        expected: 1,
        submitted: 0,
        pendingCount: 0,
        accruedCount: 0,
        missingProjects: [miss('P1')],
      },
    ])
  })

  it('self-declare PENDING flags pendingValidation only when nothing better exists; exact payloads + totals', async () => {
    const { svc } = makeSvc({
      owners: [own('A1', 'Ann', 'ADMIN'), own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'A1'), proj('P2', 'S1'), proj('P3', 'S1'), proj('P4', 'S1')],
      txs: [
        inc('ADMIN_INCOME', 'PENDING', 'P1', 'A1'),
        inc('SENIOR_INCOME', 'PENDING', 'P2', 'S1'),
        inc('SENIOR_PENDING_PAYOUT', 'PENDING_PAYMENT', 'P2', 'S1'),
        inc('SENIOR_PENDING_PAYOUT', 'PENDING_PAYMENT', 'P3', 'S1'),
        inc('SENIOR_INCOME', 'PENDING_PAYMENT', 'P4', 'S1'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.totals).toEqual({
      expectedProjects: 4,
      submittedProjects: 1,
      laggingReceivers: 2,
      completeReceivers: 0,
      pendingProjects: 1,
      accruedProjects: 2,
    })
    expect(r.receivers).toEqual([
      {
        userId: 'A1',
        displayName: 'Ann',
        role: 'ADMIN_SENIOR',
        expected: 1,
        submitted: 0,
        pendingCount: 1,
        accruedCount: 0,
        missingProjects: [miss('P1', { pendingValidation: true })],
      },
      {
        userId: 'S1',
        displayName: 'Sam',
        role: 'SENIOR',
        expected: 3,
        submitted: 1,
        pendingCount: 0,
        accruedCount: 2,
        missingProjects: [miss('P2', { accrued: true }), miss('P3', { accrued: true })],
      },
    ])
  })
})

describe('getIncomeComplianceOverview — sort & month', () => {
  it('equal-ratio tie: fewer submitted first regardless of insertion order', async () => {
    for (const order of [
      ['S3', 'S4'],
      ['S4', 'S3'],
    ]) {
      const projects = order.flatMap((o) =>
        o === 'S3'
          ? [proj('c1', 'S3'), proj('c2', 'S3')]
          : [proj('d1', 'S4'), proj('d2', 'S4'), proj('d3', 'S4'), proj('d4', 'S4')],
      )
      const { svc } = makeSvc({
        owners: [own('S3', 'Zed', 'SENIOR'), own('S4', 'Yan', 'SENIOR')],
        projects,
        txs: [
          inc('SENIOR_INCOME', 'PAID', 'c1', 'S3'),
          inc('SENIOR_INCOME', 'PAID', 'd1', 'S4'),
          inc('SENIOR_INCOME', 'PAID', 'd2', 'S4'),
        ],
      })
      const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
      expect(r.receivers.map((x) => x.userId)).toEqual(['S3', 'S4'])
    }
  })

  it('orders by coverage ratio, then fewer submitted, then displayName (en collation)', async () => {
    const { svc } = makeSvc({
      owners: [
        own('S1', 'bravo', 'SENIOR'),
        own('S2', 'Alpha', 'SENIOR'),
        own('S3', 'Zed', 'SENIOR'),
        own('S4', 'Yan', 'SENIOR'),
      ],
      projects: [
        proj('a1', 'S1'),
        proj('b1', 'S2'),
        proj('c1', 'S3'),
        proj('c2', 'S3'),
        proj('d1', 'S4'),
        proj('d2', 'S4'),
        proj('d3', 'S4'),
        proj('d4', 'S4'),
      ],
      txs: [
        // S1: 1/1 (ratio 1), S2: 1/1 (ratio 1) -> same ratio+submitted -> name
        inc('SENIOR_INCOME', 'PAID', 'a1', 'S1'),
        inc('SENIOR_INCOME', 'PAID', 'b1', 'S2'),
        // S3: 1/2 (0.5), S4: 2/4 (0.5) -> same ratio, S3 fewer submitted first
        inc('SENIOR_INCOME', 'PAID', 'c1', 'S3'),
        inc('SENIOR_INCOME', 'PAID', 'd1', 'S4'),
        inc('SENIOR_INCOME', 'PAID', 'd2', 'S4'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.receivers.map((x) => x.userId)).toEqual(['S3', 'S4', 'S2', 'S1'])
    expect(r.totals).toMatchObject({ laggingReceivers: 2, completeReceivers: 2 })
  })

  it('zero-pads the month key for a January/September request and defaults to the frozen UTC month', async () => {
    const { svc } = makeSvc()
    expect((await svc.getIncomeComplianceOverview(user('ADMIN'), '2026-01')).month).toBe('2026-01')
    expect((await svc.getIncomeComplianceOverview(user('ADMIN'), '2026-09')).month).toBe('2026-09')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T23:59:59.999Z'))
    expect((await svc.getIncomeComplianceOverview(user('ADMIN'))).month).toBe('2026-07')
  })
})
