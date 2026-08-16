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
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { collectParamValues } from './__test-helpers__/drizzle-where-introspection'

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
  return makeTransactionsService({ db: dbStub as never })
}

/**
 * task-compliance-overview-pending-types (mutation-gate): `transactions.findMany`
 * above IGNORES the `where`/`columns` it is called with — it always returns
 * the canned `data.transactions` array regardless — so a mocked-row test
 * structurally cannot observe a mutation of the `inArray(transactions.type,
 * [...])` / `inArray(transactions.status, [...])` literal ARRAYS in the query
 * builder (only the query EXECUTOR is stubbed, not the query-builder —
 * `transactions` is the real imported schema table, so `where` is a real
 * Drizzle SQL AST), NOR a mutation of the `columns: {...}` selection object
 * (security-review PR #531 round 1 — `receiverId: true` is load-bearing for
 * MED-1's receiver-scoped keying; a stub that ignores it can't tell whether
 * that flag was ever flipped off). Same structural gap, same fix, as
 * `transactions.drop-self-feeds.spec.ts` (security-review PR #523 round 1
 * MED-2) — capture the REAL `where` AST (walk it with `collectParamValues`)
 * and the REAL `columns` object (a plain JS object, no AST needed) instead of
 * trusting the stub's return.
 */
function makeServiceCapturingTransactionsWhere(data: StubData = {}): {
  svc: TransactionsService
  getWhere: () => unknown
  getColumns: () => Record<string, boolean> | undefined
} {
  let capturedWhere: unknown
  let capturedColumns: Record<string, boolean> | undefined
  const dbStub = {
    db: {
      query: {
        projects: { findMany: () => Promise.resolve(data.projects ?? []) },
        users: { findMany: () => Promise.resolve(data.users ?? []) },
        transactions: {
          findMany: (args?: { where?: unknown; columns?: Record<string, boolean> }) => {
            capturedWhere = args?.where
            capturedColumns = args?.columns
            return Promise.resolve(data.transactions ?? [])
          },
        },
      },
    },
  }
  return {
    svc: makeTransactionsService({ db: dbStub as never }),
    getWhere: () => capturedWhere,
    getColumns: () => capturedColumns,
  }
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
      const svc = makeTransactionsService({ db: throwingDb as never })
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
      accruedProjects: 0,
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
      accrued: false,
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
    expect(rec.accruedCount).toBe(0)
    expect(rec.missingProjects[0]).toMatchObject({ pendingValidation: false, accrued: false })
  })

  // task-compliance-overview-pending-types (mutation-gate): a REJECTED-status
  // obligation row must NOT be treated as accrued — only PENDING_PAYMENT means
  // "booked, awaiting company payout". Kills the mutant that widens the
  // `else if (tx.status === 'PENDING_PAYMENT')` branch to always-true.
  it('REJECTED-status obligation row is ignored — not accrued, not submitted', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [baseSenior],
      transactions: [
        {
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'REJECTED',
          projectId: 'p1',
          receiverId: 'sr-1',
          txDate: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const rec = r.receivers[0]!
    expect(rec.submitted).toBe(0)
    expect(rec.accruedCount).toBe(0)
    expect(rec.pendingCount).toBe(0)
    expect(rec.missingProjects[0]).toMatchObject({
      submitted: false,
      pendingValidation: false,
      accrued: false,
    })
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

  // mutation-gate: proves the defensive `if (!complianceRole || !incomeTypes)
  // return` early-exit is neither always-on (which would wipe out the REAL
  // receiver in the SAME call, asserted below) nor a no-op (a non-receiver
  // owner really must be skipped).
  it('a project owned by a non-receiver role (JUNIOR) is silently ignored, alongside a real SENIOR receiver', async () => {
    const svc = makeService({
      projects: [
        {
          id: 'p-junior',
          name: 'Junior Project',
          companyName: 'C0',
          seniorId: 'jr-1',
          dropId: null,
        },
        { id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null },
      ],
      users: [
        { id: 'jr-1', displayName: 'Some Junior', role: 'JUNIOR' },
        { id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' },
      ],
      transactions: [{ type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p1', txDate: thisMonth }],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(r.receivers.map((x) => x.userId)).toEqual(['sr-1'])
    expect(r.receivers.find((x) => x.userId === 'jr-1')).toBeUndefined()
    const senior = r.receivers.find((x) => x.userId === 'sr-1')!
    expect(senior.submitted).toBe(1)
  })
})

// task-compliance-overview-pending-types (mutation-gate): closes the surviving
// mutants on the `inArray(transactions.type, [...])` / `inArray(transactions.
// status, [...])` literals — see `makeServiceCapturingTransactionsWhere`'s
// docstring for why the mocked-row tests above cannot observe them (and why
// `income-compliance.integration.spec.ts` can't either — Stryker excludes
// every `*.integration.spec.ts` file from mutation discovery).
describe('getIncomeComplianceOverview — DB-level type/status scope (mutation-gate)', () => {
  const oneActiveProject = {
    projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
    users: [{ id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' }],
  }

  it('WHERE clause binds exactly the 6 recognised income/obligation types — nothing more, nothing less', async () => {
    const { svc, getWhere } = makeServiceCapturingTransactionsWhere(oneActiveProject)
    await svc.getIncomeComplianceOverview(user('ADMIN'))
    const bound = collectParamValues(getWhere())
    const KNOWN_TYPES = new Set([
      'SENIOR_INCOME',
      'ADMIN_INCOME',
      'DROP_INCOME',
      'SENIOR_PENDING_PAYOUT',
      'DROP_PENDING_PAYOUT',
      'PAYOUT_DROP',
    ])
    const boundTypes = bound.filter((v): v is string => typeof v === 'string' && KNOWN_TYPES.has(v))
    expect(new Set(boundTypes)).toEqual(KNOWN_TYPES)
  })

  it('WHERE clause binds exactly the 4 recognised statuses — nothing more, nothing less', async () => {
    const { svc, getWhere } = makeServiceCapturingTransactionsWhere(oneActiveProject)
    await svc.getIncomeComplianceOverview(user('ADMIN'))
    const bound = collectParamValues(getWhere())
    const KNOWN_STATUSES = new Set(['VALIDATED', 'PAID', 'PENDING', 'PENDING_PAYMENT'])
    const boundStatuses = bound.filter(
      (v): v is string => typeof v === 'string' && KNOWN_STATUSES.has(v),
    )
    expect(new Set(boundStatuses)).toEqual(KNOWN_STATUSES)
  })

  // security-review PR #531 round 1 (MED-1): `receiverId` MUST be selected —
  // without it, `evidenceKey` cannot key the three obligation-model types by
  // person at all. A mocked-row test cannot observe this via the RETURNED rows
  // (the stub ignores `columns` and returns the canned fixture regardless), so
  // capture the actual `columns` object the query builder was called with.
  it('columns selection includes every field evidenceKey/the month-window filter needs — especially receiverId (MED-1)', async () => {
    const { svc, getColumns } = makeServiceCapturingTransactionsWhere(oneActiveProject)
    await svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(getColumns()).toEqual({
      type: true,
      status: true,
      projectId: true,
      receiverId: true,
      txDate: true,
      createdAt: true,
    })
  })
})

describe('getIncomeComplianceOverview — obligation evidence (task-compliance-overview-pending-types)', () => {
  // Reproduces the reported prod symptom: a DROP owner whose August share was
  // booked AND paid (obligation flipped in place, settle-in-place ADR) but the
  // widget only ever recognised the self-declare types. AC1 + the mutation-gate
  // requirement (AC4): remove PAYOUT_DROP from the recognised-type list and this
  // assertion fails.
  it('a SETTLED drop obligation (PAYOUT_DROP, PAID) counts as submitted — the reported false-lag regression', async () => {
    const svc = makeService({
      projects: [
        {
          id: 'gt',
          name: 'GamingTec',
          companyName: 'GamingTec LLC',
          seniorId: null,
          dropId: 'drop-1',
        },
      ],
      users: [{ id: 'drop-1', displayName: 'Sergii', role: 'DROP' }],
      transactions: [
        // bookCompanyObligations booked DROP_PENDING_PAYOUT in August; settleByCompany
        // later flipped the SAME row in place to PAYOUT_DROP/PAID — never a
        // separate DROP_INCOME row (createDropIncome rejects a USDT project).
        // receiverId set — security-review PR #531 (MED-1): PAYOUT_DROP is
        // receiver-scoped, `bookCompanyObligations` always stamps it.
        {
          type: 'PAYOUT_DROP',
          status: 'PAID',
          projectId: 'gt',
          receiverId: 'drop-1',
          txDate: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const drop = r.receivers.find((x) => x.userId === 'drop-1')!
    expect(drop.submitted).toBe(1)
    expect(drop.expected).toBe(1)
    expect(drop.missingProjects).toHaveLength(0)
    expect(drop.accruedCount).toBe(0)
    expect(r.totals.laggingReceivers).toBe(0)
    expect(r.totals.completeReceivers).toBe(1)
  })

  // AC1 (mutation-gate): remove SENIOR_PENDING_PAYOUT from the recognised-type
  // list and this fails (submitted/accruedCount both silently go to 0/0 instead
  // of 0/1, and the project would show as plain "missing" instead of "accrued").
  it('a booked-but-unpaid SENIOR obligation (SENIOR_PENDING_PAYOUT, PENDING_PAYMENT) is accrued — NOT submitted, NOT plain-missing', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [{ id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' }],
      transactions: [
        {
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          projectId: 'p1',
          receiverId: 'sr-1',
          txDate: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const senior = r.receivers.find((x) => x.userId === 'sr-1')!
    expect(senior.submitted).toBe(0)
    expect(senior.accruedCount).toBe(1)
    expect(senior.pendingCount).toBe(0)
    expect(senior.missingProjects).toHaveLength(1)
    expect(senior.missingProjects[0]).toMatchObject({
      projectId: 'p1',
      submitted: false,
      pendingValidation: false,
      accrued: true,
    })
    expect(r.totals.accruedProjects).toBe(1)
    expect(r.totals.submittedProjects).toBe(0)
  })

  // AC1 (mutation-gate): remove DROP_PENDING_PAYOUT from the recognised-type
  // list and this fails, symmetric to the SENIOR case above.
  it('a booked-but-unpaid DROP obligation (DROP_PENDING_PAYOUT, PENDING_PAYMENT) is accrued — NOT submitted, NOT plain-missing', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: null, dropId: 'drop-1' }],
      users: [{ id: 'drop-1', displayName: 'Drop One', role: 'DROP' }],
      transactions: [
        {
          type: 'DROP_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          projectId: 'p1',
          receiverId: 'drop-1',
          txDate: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const drop = r.receivers.find((x) => x.userId === 'drop-1')!
    expect(drop.submitted).toBe(0)
    expect(drop.accruedCount).toBe(1)
    expect(drop.missingProjects[0]).toMatchObject({ accrued: true, pendingValidation: false })
    expect(r.totals.accruedProjects).toBe(1)
  })

  // security-review PR #531 (MED-1): the previous version of this test class
  // did NOT catch a missing receiver-scope — a stray obligation row of the
  // SAME type on the SAME project, but for a DIFFERENT person, must NOT count
  // as evidence for the real owner. Concrete failure path this guards: a
  // project's `dropId`/`seniorId` is reassigned mid-month — without this
  // scope, the NEW owner would silently inherit the OLD owner's booked/paid
  // evidence. Parameterized over ALL THREE receiver-scoped types (mutation-
  // gate: each type STRING in `RECEIVER_SCOPED_TYPES` needs its OWN kill —
  // a test for one type alone leaves the other two's literals unobserved).
  it.each([
    ['SENIOR_PENDING_PAYOUT', 'PENDING_PAYMENT', 'SENIOR', 'seniorId'],
    ['DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', 'DROP', 'dropId'],
    ['PAYOUT_DROP', 'PAID', 'DROP', 'dropId'],
  ] as const)(
    'MED-1: a stray %s row for a DIFFERENT receiver on the SAME project is invisible to the CURRENT owner',
    async (type, status, role, ownerField) => {
      const project =
        ownerField === 'seniorId'
          ? { id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'owner-new', dropId: null }
          : { id: 'p1', name: 'P1', companyName: 'C1', seniorId: null, dropId: 'owner-new' }
      const svc = makeService({
        projects: [project],
        users: [
          { id: 'owner-new', displayName: 'New Owner', role },
          { id: 'owner-old', displayName: 'Old Owner', role },
        ],
        transactions: [
          // Booked for the OLD owner (e.g. before a reassignment) — same
          // project, same type, WRONG receiver.
          { type, status, projectId: 'p1', receiverId: 'owner-old', txDate: thisMonth },
        ],
      })
      const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
      // owner-old no longer owns p1 — never a receiver.
      expect(r.receivers.find((x) => x.userId === 'owner-old')).toBeUndefined()
      // owner-new is the CURRENT owner — must NOT inherit owner-old's evidence.
      const newOwner = r.receivers.find((x) => x.userId === 'owner-new')!
      expect(newOwner.submitted).toBe(0)
      expect(newOwner.accruedCount).toBe(0)
      expect(newOwner.missingProjects).toHaveLength(1)
      expect(newOwner.missingProjects[0]).toMatchObject({
        projectId: 'p1',
        submitted: false,
        accrued: false,
        pendingValidation: false,
      })
    },
  )

  // security-review PR #531 (MED-2): PENDING_PAYMENT is NOT exclusive to a
  // booked obligation — `createPayoutRequest` (transactions.service.ts
  // ~L3941-3944) ALSO flips an already-VALIDATED self-declare SENIOR_INCOME/
  // DROP_INCOME row to PENDING_PAYMENT for the payout-request window. That
  // income was already earned — it must count as `submitted`/received, NOT
  // `accrued` (accrued would misattribute the wait to the company, when the
  // receiver already did everything right and it is the PAYOUT flow waiting).
  it('MED-2: a VALIDATED self-declare income mid-payout-request (PENDING_PAYMENT) counts as submitted, NOT accrued', async () => {
    const svc = makeService({
      projects: [
        { id: 'p-sr', name: 'Senior Project', companyName: 'C1', seniorId: 'sr-1', dropId: null },
        { id: 'p-drop', name: 'Drop Project', companyName: 'C2', seniorId: null, dropId: 'drop-1' },
      ],
      users: [
        { id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' },
        { id: 'drop-1', displayName: 'Drop One', role: 'DROP' },
      ],
      transactions: [
        // Self-declare SENIOR_INCOME, requested for payout → PENDING_PAYMENT.
        {
          type: 'SENIOR_INCOME',
          status: 'PENDING_PAYMENT',
          projectId: 'p-sr',
          txDate: thisMonth,
        },
        // Symmetric case for DROP_INCOME.
        {
          type: 'DROP_INCOME',
          status: 'PENDING_PAYMENT',
          projectId: 'p-drop',
          txDate: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const senior = r.receivers.find((x) => x.userId === 'sr-1')!
    expect(senior.submitted).toBe(1)
    expect(senior.accruedCount).toBe(0)
    expect(senior.missingProjects).toHaveLength(0)
    const drop = r.receivers.find((x) => x.userId === 'drop-1')!
    expect(drop.submitted).toBe(1)
    expect(drop.accruedCount).toBe(0)
    expect(drop.missingProjects).toHaveLength(0)
    expect(r.totals.accruedProjects).toBe(0)
  })

  // AC2: accrued (a debt, not received money) must never be silently folded
  // into `submitted` (received) — the two numbers stay strictly separate on the
  // SAME receiver, one project each.
  it('AC2: accrued and received are distinguishable, never summed into one number', async () => {
    const svc = makeService({
      projects: [
        { id: 'p-paid', name: 'Paid Project', companyName: 'C1', seniorId: 'sr-1', dropId: null },
        {
          id: 'p-accrued',
          name: 'Accrued Project',
          companyName: 'C2',
          seniorId: 'sr-1',
          dropId: null,
        },
      ],
      users: [{ id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' }],
      transactions: [
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p-paid', txDate: thisMonth },
        {
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          projectId: 'p-accrued',
          receiverId: 'sr-1',
          txDate: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const senior = r.receivers.find((x) => x.userId === 'sr-1')!
    expect(senior.expected).toBe(2)
    // The received project counts toward `submitted`; the accrued one does NOT
    // — the accrued obligation is a debt the company still owes, not money the
    // senior already received.
    expect(senior.submitted).toBe(1)
    expect(senior.accruedCount).toBe(1)
    // `submitted` is not, e.g., 2 (accrued silently folded in) nor is
    // `accruedCount` folded into `pendingCount`.
    expect(senior.pendingCount).toBe(0)
    expect(r.totals.submittedProjects).toBe(1)
    expect(r.totals.accruedProjects).toBe(1)
  })

  it('AC3: a stray obligation row for someone who owns NO active project does not add a receiver', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'sr-1', dropId: null }],
      users: [
        { id: 'sr-1', displayName: 'Senior One', role: 'SENIOR' },
        { id: 'drop-orphan', displayName: 'Orphan Drop', role: 'DROP' },
      ],
      transactions: [
        { type: 'SENIOR_INCOME', status: 'PAID', projectId: 'p1', txDate: thisMonth },
        // A DROP_PENDING_PAYOUT row for a user who does NOT own any active
        // project (e.g. their only project got archived) — recognising the new
        // TYPE must never widen the receiver SET beyond project ownership.
        {
          type: 'DROP_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          projectId: 'p1',
          txDate: thisMonth,
        },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(r.receivers).toHaveLength(1)
    expect(r.receivers.map((x) => x.userId)).toEqual(['sr-1'])
    expect(r.receivers.map((x) => x.userId)).not.toContain('drop-orphan')
  })

  it('ADMIN owner never gets an obligation type (bookCompanyObligations skips ADMIN) — a stray SENIOR_PENDING_PAYOUT-shaped row does not leak in', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'P1', companyName: 'C1', seniorId: 'adm-1', dropId: null }],
      users: [{ id: 'adm-1', displayName: 'Admin Owner', role: 'ADMIN' }],
      transactions: [{ type: 'ADMIN_INCOME', status: 'PAID', projectId: 'p1', txDate: thisMonth }],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'))
    const admin = r.receivers.find((x) => x.userId === 'adm-1')!
    expect(admin.submitted).toBe(1)
    expect(admin.accruedCount).toBe(0)
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
