/**
 * Tests for ProjectsService archive/unarchive + effectiveTeam computed view.
 * Project archive is INDEPENDENT (doesn't touch senior/team) but unarchive
 * requires a paired cascade if senior/team are archived (returns 409 by default,
 * proceeds with ?cascade=true).
 *
 * Spec: docs/specs/2026-05-21-users-archive-refactor-design.md §5.2 + §6.3
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectsService } from './projects.service'

const adminUser: SessionUser = { id: 'admin-1', role: 'ADMIN', displayName: 'Admin', email: 'a@x.com', avatar: null, seniorSharePercent: 26 }
const hrUser: SessionUser = { id: 'hr-1', role: 'HR', displayName: 'HR', email: 'h@x.com', avatar: null, seniorSharePercent: 26 }

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  const colName = (col: unknown): string => {
    if (col && typeof col === 'object') {
      const c = col as { name?: string }
      if (typeof c.name === 'string') return c.name
    }
    return String(col)
  }
  const toJsKey = (sqlName: string): string => sqlName.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase())
  const resolveKey = (col: unknown): string => toJsKey(colName(col))
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] === val,
    }),
    ne: (col: unknown, val: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] !== val,
    }),
    isNull: (col: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] == null,
    }),
    isNotNull: (col: unknown) => ({
      __predicate: (row: Record<string, unknown>) => row[resolveKey(col)] != null,
    }),
    inArray: (col: unknown, vals: unknown[]) => ({
      __predicate: (row: Record<string, unknown>) => vals.includes(row[resolveKey(col)]),
    }),
    and: (...exprs: Array<{ __predicate: (r: Record<string, unknown>) => boolean }>) => ({
      __predicate: (row: Record<string, unknown>) => exprs.every((e) => e.__predicate(row)),
    }),
  }
})

import {
  projectMembers as projectMembersTable,
  projects as projectsTable,
  teamMembers as teamMembersTable,
  teams as teamsTable,
  users as usersTable,
} from '../database/schema'

interface ProjectFixture {
  id: string
  name: string
  seniorId: string
  archivedAt: Date | null
  senior: { id: string; displayName: string; role: string; archivedAt?: Date | null; email?: string; avatar?: string | null } | null
  members: Array<{
    id: string
    projectId: string
    userId: string
    leftAt: Date | null
    joinedAt: Date
    user: { id: string; role: string; displayName: string; email: string; avatar: string | null } | null
  }>
}

interface Store {
  users: Array<Record<string, unknown>>
  teams: Array<Record<string, unknown>>
  teamMembers: Array<Record<string, unknown>>
  projects: Array<ProjectFixture>
  projectMembers: Array<Record<string, unknown>>
}

function emptyStore(): Store {
  return { users: [], teams: [], teamMembers: [], projects: [], projectMembers: [] }
}

function makeDb(store: Store) {
  const tableMap = new Map<unknown, keyof Store>([
    [usersTable, 'users'],
    [teamsTable, 'teams'],
    [teamMembersTable, 'teamMembers'],
    [projectsTable, 'projects'],
    [projectMembersTable, 'projectMembers'],
  ])
  const toPredicate = (expr: unknown): ((row: Record<string, unknown>) => boolean) => {
    if (expr && typeof expr === 'object' && '__predicate' in expr) {
      return (expr as { __predicate: (r: Record<string, unknown>) => boolean }).__predicate
    }
    return () => true
  }
  const selectChain = (table: unknown) => {
    const tableKey = tableMap.get(table)
    return {
      from: (t: unknown) => selectChain(t),
      where: (expr: unknown) => {
        const pred = toPredicate(expr)
        const rows = tableKey ? (store[tableKey] as Array<Record<string, unknown>>).filter(pred) : []
        const thenable = {
          then: (onF: (v: unknown[]) => unknown) => Promise.resolve(onF(rows)),
          orderBy: () => thenable,
          limit: () => thenable,
          offset: () => thenable,
          innerJoin: () => thenable,
        }
        return thenable
      },
      innerJoin: (_otherTable: unknown, _onExpr: unknown) => {
        return {
          where: (expr: unknown) => {
            const pred = toPredicate(expr)
            // For simplicity we only join project_members + users; pre-merge rows.
            if (tableKey === 'projectMembers') {
              const joined = store.projectMembers.map((m) => ({
                ...m,
                role: (store.users.find((u) => u.id === m['userId'])?.role) ?? null,
              })) as Array<Record<string, unknown>>
              const rows = joined.filter(pred)
              const thenable = {
                then: (onF: (v: unknown[]) => unknown) => Promise.resolve(onF(rows)),
                orderBy: () => thenable,
                limit: () => thenable,
                offset: () => thenable,
                innerJoin: () => thenable,
              }
              return thenable
            }
            if (tableKey === 'teamMembers') {
              const joined = store.teamMembers.map((m) => ({
                ...m,
                role: (store.users.find((u) => u.id === m['userId'])?.role) ?? null,
                displayName: (store.users.find((u) => u.id === m['userId'])?.displayName) ?? '',
              })) as Array<Record<string, unknown>>
              const rows = joined.filter(pred)
              const thenable = {
                then: (onF: (v: unknown[]) => unknown) => Promise.resolve(onF(rows)),
                orderBy: () => thenable,
                limit: () => thenable,
                offset: () => thenable,
              }
              return thenable
            }
            return { then: (onF: (v: unknown[]) => unknown) => Promise.resolve(onF([])) }
          },
        }
      },
    }
  }

  const buildUpdate = (table: unknown) => {
    const tableKey = tableMap.get(table) ?? null
    return {
      set: (values: Record<string, unknown>) => ({
        where: (expr: unknown) => {
          const pred = toPredicate(expr)
          if (tableKey) {
            for (const row of (store[tableKey] as Array<Record<string, unknown>>)) {
              if (pred(row)) Object.assign(row, values)
            }
          }
          return Promise.resolve()
        },
      }),
    }
  }

  return {
    db: {
      select: (_proj?: unknown) => ({
        from: (table: unknown) => selectChain(table),
      }),
      insert: vi.fn(),
      update: buildUpdate,
      delete: vi.fn(),
      query: {
        projects: {
          findFirst: (opts: { where?: unknown }) => {
            const pred = toPredicate(opts?.where)
            return Promise.resolve(store.projects.find(pred))
          },
          findMany: (opts?: { where?: unknown }) => Promise.resolve(store.projects.filter(toPredicate(opts?.where))),
        },
        users: {
          findFirst: (opts: { where?: unknown }) => Promise.resolve(store.users.find(toPredicate(opts?.where))),
        },
        teams: {
          findFirst: (opts: { where?: unknown }) => Promise.resolve(store.teams.find(toPredicate(opts?.where))),
        },
        teamMembers: {
          findFirst: (opts: { where?: unknown }) => Promise.resolve(store.teamMembers.find(toPredicate(opts?.where))),
        },
        projectMembers: {
          findFirst: (opts: { where?: unknown }) => Promise.resolve(store.projectMembers.find(toPredicate(opts?.where))),
        },
      },
      transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        // Build a tx that targets the same store (transactional semantics not needed for assertions).
        return fn({
          select: (_proj?: unknown) => ({ from: (table: unknown) => selectChain(table) }),
          update: buildUpdate,
        } as never)
      },
    },
  }
}

function buildService(store: Store, opts: { usersServiceUnarchive?: (tx: unknown, id: string, actorId: string) => Promise<unknown> } = {}) {
  const projectAuditLogService = {
    record: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ entries: [], total: 0 })),
  }
  // ProjectsService now calls `usersService.unarchivePairTx(tx, id, actorId)`
  // (NOT the public `unarchive`) so the project unarchive and the senior/team
  // unarchive share the same outer transaction. We stub `unarchivePairTx`
  // accordingly; `unarchive` is kept as a no-op spy in case any legacy test
  // assertions reference it.
  const usersService = {
    unarchive: vi.fn(async () => undefined),
    unarchivePairTx: vi.fn(opts.usersServiceUnarchive ?? (async () => undefined)),
  }
  const db = makeDb(store)
  const service = new ProjectsService(db as never, projectAuditLogService as never, usersService as never)
  // Stub findOne so we don't reconstruct the full mapProject chain after archive.
  vi.spyOn(service, 'findOne').mockImplementation(async (id: string) => {
    const p = store.projects.find((p) => p.id === id)
    return p ? ({ id: p.id, name: p.name, archivedAt: p.archivedAt?.toISOString() ?? null } as never) : (undefined as never)
  })
  return { service, projectAuditLogService, usersService }
}

function seedActiveSeniorTeamProject(store: Store) {
  store.users.push({ id: 'senior-1', role: 'SENIOR', displayName: 'Senior', email: 's@x.com', avatar: null, archivedAt: null })
  store.users.push({ id: 'junior-1', role: 'JUNIOR', displayName: 'Junior', email: 'j@x.com', avatar: null, archivedAt: null })
  store.teams.push({ id: 'team-1', name: 'T', archivedAt: null })
  store.teamMembers.push({ id: 'tm-s', teamId: 'team-1', userId: 'senior-1', leftAt: null, joinedAt: new Date() })
  const startDate = new Date('2026-01-01')
  store.projects.push({
    id: 'proj-1',
    name: 'Project',
    seniorId: 'senior-1',
    archivedAt: null,
    senior: { id: 'senior-1', displayName: 'Senior', role: 'SENIOR', archivedAt: null, email: 's@x.com', avatar: null },
    members: [],
    // Cast through unknown to satisfy ProjectFixture which doesn't declare startDate/companyName.
  } as ProjectFixture & { startDate: Date; companyName: string; domain: string; createdAt: Date; updatedAt: Date; currency: string; rate: number })
  // Augment the row with required fields the service reads via mapProject.
  Object.assign(store.projects[store.projects.length - 1] as unknown as Record<string, unknown>, {
    startDate,
    companyName: 'C',
    domain: 'Other',
    createdAt: startDate,
    updatedAt: startDate,
    currency: 'USDT',
    rate: 100,
    logoDocumentId: null,
    logoExternalUrl: null,
    techStack: null,
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
  })
  store.projectMembers.push({
    id: 'pm-1', projectId: 'proj-1', userId: 'junior-1', leftAt: null, joinedAt: new Date(),
  })
}

// ---------------------------------------------------------------------------
// archive — independent (doesn't touch senior/team)
// ---------------------------------------------------------------------------

describe('ProjectsService.archive', () => {
  it('sets archivedAt + leftAt for active JUNIORs; does NOT touch senior/team', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    const { service, projectAuditLogService } = buildService(store)

    await service.archive('proj-1', adminUser)

    expect(store.projects[0]?.archivedAt).toBeInstanceOf(Date)
    expect((store.projectMembers[0] as { leftAt: Date | null }).leftAt).toBeInstanceOf(Date)
    // Senior + team stay untouched.
    expect((store.users[0] as { archivedAt: Date | null }).archivedAt).toBeNull()
    expect((store.teams[0] as { archivedAt: Date | null }).archivedAt).toBeNull()
    // Audit log written.
    const calls = projectAuditLogService.record.mock.calls.map((c) => (c[0] as { action: string }).action)
    expect(calls).toContain('project_archived')
    expect(calls).toContain('project_member_removed')
  })

  it('throws ForbiddenException for non-ADMIN', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    const { service } = buildService(store)
    await expect(service.archive('proj-1', hrUser)).rejects.toThrow(ForbiddenException)
  })

  it('throws NotFoundException for missing project', async () => {
    const store = emptyStore()
    const { service } = buildService(store)
    await expect(service.archive('ghost', adminUser)).rejects.toThrow(NotFoundException)
  })

  it('throws BadRequestException if already archived', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    ;(store.projects[0] as ProjectFixture).archivedAt = new Date()
    const { service } = buildService(store)
    await expect(service.archive('proj-1', adminUser)).rejects.toThrow(BadRequestException)
  })
})

// ---------------------------------------------------------------------------
// unarchive — cascade flow
// ---------------------------------------------------------------------------

describe('ProjectsService.unarchive', () => {
  it('unarchives project without cascade when senior+team are active', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    ;(store.projects[0] as ProjectFixture).archivedAt = new Date()
    const { service, projectAuditLogService } = buildService(store)

    await service.unarchive('proj-1', adminUser, false)

    expect((store.projects[0] as ProjectFixture).archivedAt).toBeNull()
    // project_members.leftAt is NOT restored.
    const calls = projectAuditLogService.record.mock.calls.map((c) => (c[0] as { action: string }).action)
    expect(calls).toContain('project_unarchived')
  })

  it('returns 409 ConflictException with requiresCascade when senior is archived', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    ;(store.projects[0] as ProjectFixture).archivedAt = new Date()
    ;(store.users[0] as { archivedAt: Date | null }).archivedAt = new Date()
    const { service } = buildService(store)

    let captured: unknown
    try {
      await service.unarchive('proj-1', adminUser, false)
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(ConflictException)
    const response = (captured as ConflictException).getResponse() as { requiresCascade: boolean; entities: Array<{ type: string; id: string; name: string }> }
    expect(response.requiresCascade).toBe(true)
    expect(response.entities.find((e) => e.type === 'user')?.id).toBe('senior-1')
  })

  it('with cascade=true: calls usersService.unarchivePairTx (same tx) and unarchives project', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    ;(store.projects[0] as ProjectFixture).archivedAt = new Date()
    ;(store.users[0] as { archivedAt: Date | null }).archivedAt = new Date()
    ;(store.teams[0] as { archivedAt: Date | null }).archivedAt = new Date()
    const { service, usersService } = buildService(store, {
      usersServiceUnarchive: async (_tx: unknown, id: string) => {
        // Simulate paired unarchive: clear senior + team archivedAt.
        const u = store.users.find((u) => u.id === id)
        if (u) (u as { archivedAt: Date | null }).archivedAt = null
        const t = store.teams[0]
        if (t) (t as { archivedAt: Date | null }).archivedAt = null
        return undefined
      },
    })

    await service.unarchive('proj-1', adminUser, true)

    // Assertion: pair-unarchive flows through unarchivePairTx (the tx-aware
    // helper), NOT the public unarchive() that would open a nested tx.
    expect(usersService.unarchivePairTx).toHaveBeenCalled()
    const [txArg, idArg, actorArg] = usersService.unarchivePairTx.mock.calls[0]!
    expect(idArg).toBe('senior-1')
    expect(actorArg).toBe(adminUser.id)
    expect(txArg).toBeDefined()  // a tx handle from the outer transaction
    expect(usersService.unarchive).not.toHaveBeenCalled()
    expect((store.projects[0] as ProjectFixture).archivedAt).toBeNull()
    expect((store.users[0] as { archivedAt: Date | null }).archivedAt).toBeNull()
    expect((store.teams[0] as { archivedAt: Date | null }).archivedAt).toBeNull()
  })

  it('throws NotFoundException for missing project', async () => {
    const store = emptyStore()
    const { service } = buildService(store)
    await expect(service.unarchive('ghost', adminUser, false)).rejects.toThrow(NotFoundException)
  })

  it('throws BadRequestException when project is not archived', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    const { service } = buildService(store)
    await expect(service.unarchive('proj-1', adminUser, false)).rejects.toThrow(BadRequestException)
  })

  it('throws ForbiddenException for non-ADMIN', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    ;(store.projects[0] as ProjectFixture).archivedAt = new Date()
    const { service } = buildService(store)
    await expect(service.unarchive('proj-1', hrUser, false)).rejects.toThrow(ForbiddenException)
  })
})

// ---------------------------------------------------------------------------
// getArchiveImpact
// ---------------------------------------------------------------------------

describe('ProjectsService.getArchiveImpact', () => {
  it('returns activeMembersCount for active JUNIORs', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    const { service } = buildService(store)
    const impact = await service.getArchiveImpact('proj-1', adminUser)
    expect(impact).toMatchObject({ type: 'project', activeMembersCount: 1 })
  })

  it('throws ForbiddenException for non-ADMIN', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    const { service } = buildService(store)
    await expect(service.getArchiveImpact('proj-1', hrUser)).rejects.toThrow(ForbiddenException)
  })
})

// ---------------------------------------------------------------------------
// effectiveTeam dynamism — verify changes in senior's team_members reflect
// in the project's effectiveTeam without requiring a snapshot restore.
// ---------------------------------------------------------------------------

describe('ProjectsService.findOne — effectiveTeam dynamism', () => {
  it('reflects current senior team_members (HR additions visible without snapshot restore)', async () => {
    const store = emptyStore()
    seedActiveSeniorTeamProject(store)
    store.users.push(
      { id: 'hr-old', role: 'HR', displayName: 'Old HR', email: 'o@x.com', avatar: null, archivedAt: null },
      { id: 'hr-new', role: 'HR', displayName: 'New HR', email: 'n@x.com', avatar: null, archivedAt: null },
      { id: 'acc-1', role: 'ACCOUNTANT', displayName: 'Acc', email: 'a@x.com', avatar: null, archivedAt: null },
    )
    store.teamMembers.push(
      // Senior was already added
      { id: 'tm-old', teamId: 'team-1', userId: 'hr-old', leftAt: new Date(), joinedAt: new Date() },
      { id: 'tm-new', teamId: 'team-1', userId: 'hr-new', leftAt: null, joinedAt: new Date() },
      { id: 'tm-acc', teamId: 'team-1', userId: 'acc-1', leftAt: null, joinedAt: new Date() },
    )

    // Reset findOne stub so we test the real impl.
    const projectAuditLogService = {
      record: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ entries: [], total: 0 })),
    }
    const usersService = { unarchive: vi.fn() }
    const db = makeDb(store)
    const service = new ProjectsService(db as never, projectAuditLogService as never, usersService as never)

    const result = await service.findOne('proj-1', adminUser)
    // Old HR is filtered out (leftAt set); new HR is present.
    expect((result as { effectiveTeam: { hrs: Array<{ userId: string }> } }).effectiveTeam.hrs.map((h) => h.userId)).toEqual(['hr-new'])
    expect((result as { effectiveTeam: { accountants: Array<{ userId: string }> } }).effectiveTeam.accountants.map((a) => a.userId)).toEqual(['acc-1'])
    expect((result as { effectiveTeam: { senior: { id: string } | null } }).effectiveTeam.senior?.id).toBe('senior-1')
  })
})

// ---------------------------------------------------------------------------
// findAll — per-role RBAC matrix for active vs archived views.
// Round 5 design: ADMIN + ACCOUNTANT see everything, HR sees their seniors'
// projects, SENIOR sees own, JUNIOR sees projects they were a member of.
// Same matrix applies to active and archived sub-views — the only difference
// is the `archivedAt IS NULL` vs `IS NOT NULL` filter applied to the result.
// ---------------------------------------------------------------------------

describe('ProjectsService.findAll — RBAC matrix', () => {
  function seedMultiProject(store: Store) {
    // Two seniors with one project each + one archived project for senior-1.
    store.users.push(
      { id: 'admin-1', role: 'ADMIN', displayName: 'Admin', email: 'a@x.com', avatar: null, archivedAt: null },
      { id: 'acc-1', role: 'ACCOUNTANT', displayName: 'Acc', email: 'ac@x.com', avatar: null, archivedAt: null },
      { id: 'senior-1', role: 'SENIOR', displayName: 'Senior 1', email: 's1@x.com', avatar: null, archivedAt: null },
      { id: 'senior-2', role: 'SENIOR', displayName: 'Senior 2', email: 's2@x.com', avatar: null, archivedAt: null },
      { id: 'hr-1', role: 'HR', displayName: 'HR', email: 'hr@x.com', avatar: null, archivedAt: null },
      { id: 'junior-1', role: 'JUNIOR', displayName: 'Jr', email: 'j@x.com', avatar: null, archivedAt: null },
    )
    store.teams.push({ id: 'team-1', name: 'T1', archivedAt: null })
    store.teamMembers.push(
      { id: 'tm-s1', teamId: 'team-1', userId: 'senior-1', leftAt: null, joinedAt: new Date() },
      { id: 'tm-hr', teamId: 'team-1', userId: 'hr-1', leftAt: null, joinedAt: new Date() },
    )
    const baseProj = {
      companyName: 'C', domain: 'Other', startDate: new Date('2026-01-01'),
      currency: 'USDT', rate: 100, logoDocumentId: null, logoExternalUrl: null, techStack: null,
      teamSize: null, benefits: null, paymentType: null, salaryReview: null,
      corpTech: null, notesGeneral: null, createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    }
    store.projects.push({
      id: 'p-s1-active', name: 'P1', seniorId: 'senior-1', archivedAt: null,
      senior: { id: 'senior-1', displayName: 'Senior 1', role: 'SENIOR', archivedAt: null, email: 's1@x.com', avatar: null },
      members: [],
      ...baseProj,
    } as never)
    store.projects.push({
      id: 'p-s1-archived', name: 'P-arc', seniorId: 'senior-1', archivedAt: new Date('2026-04-01'),
      senior: { id: 'senior-1', displayName: 'Senior 1', role: 'SENIOR', archivedAt: null, email: 's1@x.com', avatar: null },
      members: [],
      ...baseProj,
    } as never)
    store.projects.push({
      id: 'p-s2-active', name: 'P2', seniorId: 'senior-2', archivedAt: null,
      senior: { id: 'senior-2', displayName: 'Senior 2', role: 'SENIOR', archivedAt: null, email: 's2@x.com', avatar: null },
      members: [
        { id: 'pm-j', projectId: 'p-s2-active', userId: 'junior-1', leftAt: null, joinedAt: new Date(),
          user: { id: 'junior-1', role: 'JUNIOR', displayName: 'Jr', email: 'j@x.com', avatar: null } },
      ],
      ...baseProj,
    } as never)
  }

  const sessionFor = (id: string, role: SessionUser['role']): SessionUser => ({
    id, role, displayName: id, email: `${id}@x.com`, avatar: null, seniorSharePercent: 26,
  })

  it('ADMIN sees all active projects', async () => {
    const store = emptyStore()
    seedMultiProject(store)
    const { service } = buildService(store)
    vi.restoreAllMocks()
    const result = await service.findAll(sessionFor('admin-1', 'ADMIN'), { archived: false })
    expect(result.map((p) => p.id).sort()).toEqual(['p-s1-active', 'p-s2-active'])
  })

  it('ACCOUNTANT sees all archived projects', async () => {
    const store = emptyStore()
    seedMultiProject(store)
    const { service } = buildService(store)
    vi.restoreAllMocks()
    const result = await service.findAll(sessionFor('acc-1', 'ACCOUNTANT'), { archived: true })
    expect(result.map((p) => p.id)).toEqual(['p-s1-archived'])
  })

  it('SENIOR sees only own projects (active)', async () => {
    const store = emptyStore()
    seedMultiProject(store)
    const { service } = buildService(store)
    vi.restoreAllMocks()
    const result = await service.findAll(sessionFor('senior-1', 'SENIOR'), { archived: false })
    expect(result.map((p) => p.id)).toEqual(['p-s1-active'])
  })

  it('HR sees projects of their senior (active)', async () => {
    const store = emptyStore()
    seedMultiProject(store)
    const { service } = buildService(store)
    vi.restoreAllMocks()
    const result = await service.findAll(sessionFor('hr-1', 'HR'), { archived: false })
    expect(result.map((p) => p.id)).toEqual(['p-s1-active'])
  })

  it('JUNIOR sees only projects where active member', async () => {
    const store = emptyStore()
    seedMultiProject(store)
    const { service } = buildService(store)
    vi.restoreAllMocks()
    const result = await service.findAll(sessionFor('junior-1', 'JUNIOR'), { archived: false })
    expect(result.map((p) => p.id)).toEqual(['p-s2-active'])
  })
})
