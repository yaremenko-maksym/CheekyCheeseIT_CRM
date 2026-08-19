/**
 * Tests for TeamsService archive/unarchive delegation.
 * TeamsService.archive(teamId) delegates pair-cascade to UsersService.archive(team.seniorId).
 *
 * Spec: docs/specs/2026-05-21-users-archive-refactor-design.md §5 + §6.3
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TeamsService } from './teams.service'
import {
  projects as projectsTable,
  teamMembers as teamMembersTable,
  teams as teamsTable,
  users as usersTable,
} from '../database/schema'

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  seniorSharePercent: 26,
}
const hrUser: SessionUser = {
  id: 'hr-1',
  role: 'HR',
  displayName: 'HR',
  email: 'h@x.com',
  avatarUrl: null,
  seniorSharePercent: 26,
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  const colName = (col: unknown): string => {
    if (col && typeof col === 'object') {
      const c = col as { name?: string }
      if (typeof c.name === 'string') return c.name
    }
    return String(col)
  }
  const toJsKey = (sqlName: string): string =>
    sqlName.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase())
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

interface FakeTeam {
  id: string
  name: string
  // Drop-archive round 2: `type` discriminator drives `archive()` dispatch
  // and `getArchiveImpact()` shape. Defaults to 'SENIOR' in helpers below
  // to preserve the original archive flow assertions.
  type?: 'SENIOR' | 'DROP'
  archivedAt: Date | null
  members: Array<{
    id: string
    teamId: string
    userId: string
    leftAt: Date | null
    joinedAt: Date
    user: {
      id: string
      role: string
      displayName: string
      email: string
      avatar: string | null
      techStack: string[] | null
      phone: string | null
      telegram: string | null
    } | null
  }>
  createdAt: Date
  updatedAt: Date
}

function makeDb(opts: { team?: FakeTeam | undefined; teamList?: FakeTeam[] } = {}) {
  const teamRow = opts.team
  return {
    db: {
      query: {
        teams: {
          findFirst: vi.fn(async () => teamRow),
          findMany: vi.fn(async () => opts.teamList ?? []),
        },
        teamMembers: {},
        projects: { findMany: vi.fn(async () => []) },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              then: (onF: (rows: unknown[]) => unknown) =>
                Promise.resolve(
                  onF(
                    teamRow?.members
                      ?.filter((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
                      .map((m) => ({
                        userId: m.userId,
                        id: m.userId,
                        displayName: m.user?.displayName ?? '',
                      })) ?? [],
                  ),
                ),
            })),
          })),
          where: vi.fn(() => ({
            then: (onF: (rows: unknown[]) => unknown) => Promise.resolve(onF([])),
          })),
        })),
      })),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({} as never),
    },
  }
}

// review round on #455: `TeamsService`'s real constructor takes THREE
// arguments (db, usersService, teamAuditLogService) — this file used to
// construct it with only two, so every test here ran against a shape that
// cannot exist in production (a live `TeamsService` always has all three).
// `archive`/`unarchive`/`getArchiveImpact` themselves never call
// `teamAuditLogService.record` (only `update`/`removeMember`/
// `archiveDropTeam`/`rotateSenior` do), so the omission never crashed these
// specific tests — but the NEXT test added to this file that DOES reach one
// of those paths would explode on `undefined.record(...)`, not on a
// meaningful assertion. A real `vi.fn()`-backed stub (matching how `db` and
// `usersService` are already stubbed below) closes that gap instead of just
// hiding it: any future call is now observable and inert, not a crash.
function makeTeamAuditLogService() {
  return { record: vi.fn(async () => undefined), diff: vi.fn(() => ({})), list: vi.fn() }
}

function buildService(
  opts: {
    team?: FakeTeam | undefined
    usersServiceArchive?: (id: string, actorId: string) => Promise<unknown>
    usersServiceUnarchive?: (id: string, actorId: string) => Promise<unknown>
    usersServiceImpact?: (id: string) => Promise<unknown>
  } = {},
) {
  const db = makeDb({ team: opts.team })
  const usersService = {
    archive: vi.fn(opts.usersServiceArchive ?? (async () => undefined)),
    unarchive: vi.fn(opts.usersServiceUnarchive ?? (async () => undefined)),
    getArchiveImpact: vi.fn(
      opts.usersServiceImpact ??
        (async () => ({
          type: 'user',
          role: 'SENIOR',
          isPaired: true,
          projectsCount: 0,
          hrAccountantsToBeRemoved: 0,
        })),
    ),
  }
  const service = new TeamsService(
    db as never,
    usersService as never,
    makeTeamAuditLogService() as never,
  )
  // Spy on findOne so we don't need to mock the entire chain after pair-archive.
  vi.spyOn(service, 'findOne').mockResolvedValue({
    id: opts.team?.id ?? 't',
    name: opts.team?.name ?? 'n',
  } as never)
  return { service, usersService, db }
}

const seniorMember = {
  id: 'tm-senior',
  teamId: 'team-1',
  userId: 'senior-1',
  leftAt: null,
  joinedAt: new Date(),
  user: {
    id: 'senior-1',
    role: 'SENIOR',
    displayName: 'Senior',
    email: 's@x.com',
    avatar: null,
    techStack: null,
    phone: null,
    telegram: null,
  },
}

const hrMember = {
  id: 'tm-hr',
  teamId: 'team-1',
  userId: 'hr-1',
  leftAt: null,
  joinedAt: new Date(),
  user: {
    id: 'hr-1',
    role: 'HR',
    displayName: 'HR',
    email: 'h@x.com',
    avatar: null,
    techStack: null,
    phone: null,
    telegram: null,
  },
}

function makeActiveTeam(): FakeTeam {
  return {
    id: 'team-1',
    name: 'Команда X',
    archivedAt: null,
    members: [seniorMember, hrMember],
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeArchivedTeam(): FakeTeam {
  return { ...makeActiveTeam(), archivedAt: new Date() }
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

describe('TeamsService.archive', () => {
  it('delegates to UsersService.archive(team.seniorId, actorId)', async () => {
    const team = makeActiveTeam()
    const { service, usersService } = buildService({ team })
    await service.archive('team-1', adminUser)
    expect(usersService.archive).toHaveBeenCalledWith('senior-1', adminUser.id)
  })

  it('throws ForbiddenException for non-ADMIN', async () => {
    const team = makeActiveTeam()
    const { service } = buildService({ team })
    await expect(service.archive('team-1', hrUser)).rejects.toThrow(ForbiddenException)
  })

  it('throws NotFoundException for missing team', async () => {
    const { service } = buildService({ team: undefined })
    await expect(service.archive('ghost', adminUser)).rejects.toThrow(NotFoundException)
  })

  it('throws BadRequestException if already archived', async () => {
    const team = makeArchivedTeam()
    const { service } = buildService({ team })
    await expect(service.archive('team-1', adminUser)).rejects.toThrow(BadRequestException)
  })

  // Drop-archive round 2 (B1+B5): archive() dispatches by team.type.
  // For 'DROP' it delegates to archiveDropTeam (NOT UsersService.archive,
  // which is the senior-team pair-cascade primitive).
  it('routes type=DROP archive through archiveDropTeam (no UsersService.archive call)', async () => {
    const team: FakeTeam = { ...makeActiveTeam(), type: 'DROP' }
    const { service, usersService } = buildService({ team })
    // Stub the DROP primitive — we only care that the dispatch picked it.
    const archiveDropTeamSpy = vi
      .spyOn(service, 'archiveDropTeam')
      .mockResolvedValue({ archivedProjects: 0, detachedSeniorId: null })
    await service.archive('team-1', adminUser)
    // task-archive-pending-modal (AC10): archiveDropTeam is now called WITH a
    // `tx` — the call is wrapped in `db.transaction()` so a mid-cascade
    // failure rolls back instead of leaving partial state. The fake
    // `db.transaction` above hands the callback `{}` as the tx object.
    expect(archiveDropTeamSpy).toHaveBeenCalledWith('team-1', {})
    expect(usersService.archive).not.toHaveBeenCalled()
  })

  // task-archive-pending-modal (AC10). Before this fix, `archive()` called
  // `archiveDropTeam(teamId)` with NO `tx` — every write inside it ran as its
  // own separate statement against `this.db.db`, so a failure partway through
  // (e.g. archiving the 2nd of 2 drop-projects) left the 1st project archived
  // and nothing else. This test forces exactly that failure through the REAL
  // `archive()` → `db.transaction()` → `archiveDropTeam(teamId, tx)` path,
  // against a snapshot/rollback-capable fake store (same technique as
  // `users.archive.spec.ts`'s SENIOR rollback test), and asserts the store is
  // back to its PRE-archive shape — not "the write we happened to check".
  // task-archive-pending-modal (round 2, security MED-3). The original
  // version of this fixture handed `db.transaction()`'s callback `db`
  // ITSELF as the `tx` argument — so a regression where `archiveDropTeam`
  // silently fell through to `this.db.db` (its OWN fallback,
  // `const handle = tx ?? this.db.db`) instead of the tx it was actually
  // given would have been byte-for-byte indistinguishable from correct
  // usage: same object either way. Security review measured this by name
  // ("The tx handle IS `db` itself here").
  //
  // Fixed by building TWO distinct handle objects that share the same
  // underlying `store` but are otherwise unrelated JS objects — exactly
  // like a real Postgres pool connection (`this.db.db`) vs a transaction
  // client (`tx`) are two different objects during an open transaction.
  // `baseDb` (what the service is CONSTRUCTED with) throws loudly the
  // moment anything calls `select`/`update` on it — the only legitimate
  // base-handle call in this call path is the ONE pre-transaction
  // `query.teams.findFirst` read `TeamsService.archive` does before ever
  // opening the transaction. Every read/write `archiveDropTeam` itself
  // performs MUST go through the `txHandle` passed into the callback; if a
  // future edit swaps even one call back to `this.db.db`, that call now
  // hits the throwing base and the test fails with a diagnostic message
  // instead of silently passing.
  function buildAtomicityFixture(opts: { throwOnNthProjectUpdate?: number }) {
    const dropId = 'drop-1'
    const teamId = 'team-drop-1'
    const store = {
      teams: [
        { id: teamId, type: 'DROP', archivedAt: null as Date | null, name: 'Drop Team' },
      ] as Array<{ id: string; type: string; archivedAt: Date | null; name: string }>,
      teamMembers: [
        { id: 'tm-drop', teamId, userId: dropId, role: 'DROP', leftAt: null as Date | null },
      ] as Array<{ id: string; teamId: string; userId: string; role: string; leftAt: Date | null }>,
      users: [{ id: dropId, role: 'DROP', archivedAt: null as Date | null }] as Array<{
        id: string
        role: string
        archivedAt: Date | null
      }>,
      projects: [
        { id: 'proj-1', dropId, archivedAt: null as Date | null },
        { id: 'proj-2', dropId, archivedAt: null as Date | null },
      ] as Array<{ id: string; dropId: string; archivedAt: Date | null }>,
    }

    type Store = typeof store
    const snapshot = (): Store => JSON.parse(JSON.stringify(store)) as Store
    const restore = (snap: Store) => {
      store.teams = snap.teams
      store.teamMembers = snap.teamMembers
      store.users = snap.users
      store.projects = snap.projects
    }

    // Minimal chainable query/update builder over the plain-object store —
    // enough surface for archiveDropTeam's own calls (select/innerJoin/where,
    // update/set/where). WHERE expressions arrive as `{ __predicate }` (this
    // file's top-level `vi.mock('drizzle-orm', ...)` — same convention as
    // `users.archive.spec.ts`). Optionally forces a throw on the Nth
    // projects UPDATE (i.e. partway through the drop-projects loop).
    type Pred = { __predicate: (row: Record<string, unknown>) => boolean }
    const asPredicate = (expr: unknown): ((row: Record<string, unknown>) => boolean) =>
      expr && typeof expr === 'object' && '__predicate' in expr
        ? (expr as Pred).__predicate
        : () => true

    // `.from(teams)` / `.update(projects)` etc. hand the REAL imported table
    // OBJECT, not a string — resolve it to a store key by reference, same
    // technique `users.archive.spec.ts`'s `tableMap` uses.
    const tableMap = new Map<unknown, keyof Store>([
      [teamsTable, 'teams'],
      [teamMembersTable, 'teamMembers'],
      [usersTable, 'users'],
      [projectsTable, 'projects'],
    ])
    const resolveTable = (table: unknown): keyof Store => {
      const key = tableMap.get(table)
      if (!key) throw new Error('[AC10 fake db] unmapped table in select/update')
      return key
    }

    let projectUpdateCount = 0
    function selectChain(table: unknown, expr: unknown) {
      const rows = (store[resolveTable(table)] as Array<Record<string, unknown>>).filter(
        asPredicate(expr),
      )
      const thenable: {
        then: (onF: (v: unknown[]) => unknown) => Promise<unknown>
        for: () => typeof thenable
      } = {
        then: (onF: (v: unknown[]) => unknown) => Promise.resolve(onF(rows)),
        // security-review PR #584 round 2 (MED-4): archiveDropTeam's own
        // team-row read now locks with `.for('update')` — no-op here (chain
        // shape only, this fake has no real transaction isolation).
        for: () => thenable,
      }
      return thenable
    }

    // The correct handle — everything archiveDropTeam does must route here.
    const txHandle = {
      select: () => ({
        from: (table: unknown) => ({
          where: (expr: unknown) => selectChain(table, expr),
          innerJoin: () => ({
            where: (expr: unknown) => selectChain(table, expr),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (expr: unknown) => {
            const key = resolveTable(table)
            if (key === 'projects') {
              projectUpdateCount += 1
              if (projectUpdateCount === opts.throwOnNthProjectUpdate) {
                throw new Error(`Simulated failure archiving drop-project #${projectUpdateCount}`)
              }
            }
            const pred = asPredicate(expr)
            for (const row of store[key] as Array<Record<string, unknown>>) {
              if (pred(row)) Object.assign(row, values)
            }
            return Promise.resolve()
          },
        }),
      }),
    }

    const BYPASS_MESSAGE =
      '[AC10 fake db] a read/write reached this.db.db directly instead of the tx handed to the ' +
      'transaction callback — archiveDropTeam bypassed the transaction boundary'
    const baseDb = {
      // The ONE legitimate base-handle call in this path: `TeamsService.archive`
      // reads the team via `db.query.teams.findFirst` BEFORE it ever opens the
      // transaction — that read is genuinely outside the atomic operation.
      query: {
        teams: {
          findFirst: () => Promise.resolve(store.teams.find((t) => t.id === teamId) as unknown),
        },
      },
      select: (): never => {
        throw new Error(BYPASS_MESSAGE)
      },
      update: (): never => {
        throw new Error(BYPASS_MESSAGE)
      },
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const snap = snapshot()
        try {
          return await fn(txHandle)
        } catch (err) {
          restore(snap)
          throw err
        }
      },
    }

    return { db: baseDb, store, teamId, dropId }
  }

  it('AC10: interrupting the DROP cascade mid-way leaves NOTHING changed (atomic)', async () => {
    const { db, store, teamId, dropId } = buildAtomicityFixture({ throwOnNthProjectUpdate: 2 })
    const usersService = { archive: vi.fn(), unarchive: vi.fn(), getArchiveImpact: vi.fn() }
    const service = new TeamsService(
      { db } as never,
      usersService as never,
      makeTeamAuditLogService() as never,
    )

    await expect(service.archive(teamId, adminUser)).rejects.toThrow(
      'Simulated failure archiving drop-project #2',
    )

    // Nothing moved: team, drop user, and BOTH projects (including the first
    // one, which the un-transactional code used to leave archived).
    expect(store.teams.find((t) => t.id === teamId)?.archivedAt).toBeNull()
    expect(store.users.find((u) => u.id === dropId)?.archivedAt).toBeNull()
    expect(store.projects.find((p) => p.id === 'proj-1')?.archivedAt).toBeNull()
    expect(store.projects.find((p) => p.id === 'proj-2')?.archivedAt).toBeNull()
  })

  // task-archive-pending-modal (round 2, security MED-3). Companion to the
  // interruption test above: that one only exercises archiveDropTeam's
  // reads plus the FIRST successful project write before it throws — the
  // drop-user update and the final team update, which come AFTER the
  // projects loop, are never reached there. This test runs the cascade to
  // completion (no interruption) against the SAME throwing-base fixture, so
  // EVERY read/write the method performs — not just the ones before an
  // interruption point — is proven to route through `tx`, not `this.db.db`.
  it('AC10: the full DROP cascade completes with every read/write routed through tx', async () => {
    const { db, store, teamId, dropId } = buildAtomicityFixture({})
    const usersService = { archive: vi.fn(), unarchive: vi.fn(), getArchiveImpact: vi.fn() }
    const service = new TeamsService(
      { db } as never,
      usersService as never,
      makeTeamAuditLogService() as never,
    )

    // `findOne` runs after the transaction commits — stub it directly so this
    // test stays scoped to the atomicity question, not team-shape mapping.
    vi.spyOn(service, 'findOne').mockResolvedValue({ id: teamId } as never)

    // Resolves cleanly — had ANY step fallen through to `this.db.db`, the
    // throwing base handle would have rejected this with BYPASS_MESSAGE
    // instead.
    await expect(service.archive(teamId, adminUser)).resolves.toBeDefined()

    expect(store.teams.find((t) => t.id === teamId)?.archivedAt).toBeInstanceOf(Date)
    expect(store.users.find((u) => u.id === dropId)?.archivedAt).toBeInstanceOf(Date)
    expect(store.projects.find((p) => p.id === 'proj-1')?.archivedAt).toBeInstanceOf(Date)
    expect(store.projects.find((p) => p.id === 'proj-2')?.archivedAt).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// unarchive
// ---------------------------------------------------------------------------

describe('TeamsService.unarchive', () => {
  it('delegates to UsersService.unarchive(team.seniorId, actorId)', async () => {
    const team = makeArchivedTeam()
    const { service, usersService } = buildService({ team })
    await service.unarchive('team-1', adminUser)
    expect(usersService.unarchive).toHaveBeenCalledWith('senior-1', adminUser.id)
  })

  it('throws NotFoundException when team not found', async () => {
    const { service } = buildService({ team: undefined })
    await expect(service.unarchive('ghost', adminUser)).rejects.toThrow(NotFoundException)
  })

  it('throws BadRequestException when team is not archived', async () => {
    const team = makeActiveTeam()
    const { service } = buildService({ team })
    await expect(service.unarchive('team-1', adminUser)).rejects.toThrow(BadRequestException)
  })
})

// ---------------------------------------------------------------------------
// getArchiveImpact — translates user impact into team-shape
// ---------------------------------------------------------------------------

describe('TeamsService.getArchiveImpact', () => {
  it('translates SENIOR pair impact into team shape', async () => {
    const team = makeActiveTeam()
    const { service } = buildService({
      team,
      usersServiceImpact: async () => ({
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        teamName: team.name,
        projectsCount: 3,
        projectNames: ['P1', 'P2', 'P3'],
        juniorsAffected: 2,
        hrAccountantsToBeRemoved: 4,
        pendingTransactions: [{ id: 'tx-9', type: 'SALARY' }],
      }),
    })
    const impact = await service.getArchiveImpact('team-1', adminUser)
    expect(impact).toMatchObject({
      type: 'team',
      isPaired: true,
      teamName: team.name,
      seniorName: 'Senior',
      projectsCount: 3,
      // task-archive-pending-modal (AC2/AC8): forwarded 1:1 from the
      // senior's own user-impact.
      projectNames: ['P1', 'P2', 'P3'],
      pendingTransactions: [{ id: 'tx-9', type: 'SALARY' }],
      membersAffected: 4,
      // Drop-archive round 2 (B2): senior-team responses now carry an
      // explicit teamType discriminator. Frontend keys on this to render
      // the SENIOR vs DROP confirmation copy.
      teamType: 'SENIOR',
    })
  })

  // task-archive-pending-modal (AC2). Same defensive union-narrowing as the
  // DROP branch's own test: if `UsersService.getArchiveImpact` ever answered
  // with a shape that is NOT `type:'user', role:'SENIOR'`, `seniorImpact`
  // resolves to `null` — projectNames/pendingTransactions must fall back to
  // `[]` instead of throwing on the optional chain.
  it('SENIOR branch: projectNames/pendingTransactions default to [] when seniorImpact is null', async () => {
    const team = makeActiveTeam()
    const { service } = buildService({
      team,
      usersServiceImpact: async () => ({ type: 'user', role: 'JUNIOR', projectsCount: 0 }),
    })
    const impact = await service.getArchiveImpact('team-1', adminUser)
    expect(impact).toMatchObject({
      type: 'team',
      teamType: 'SENIOR',
      projectNames: [],
      pendingTransactions: [],
    })
  })

  // Drop-archive round 2 (B2+B5): DROP teams return drop-specific fields.
  // Verifies the dispatch + chain stubs by overriding the db chain to
  // return the appropriate rows per role lookup. The lookup order in the
  // service is: drop → senior → HR → ACCOUNTANT → projects. We answer
  // each chained `.then` with the right row set.
  it('returns teamType=DROP + dropName + seniorWillBeDetached for drop-team', async () => {
    // Custom db builder — the production service runs several .select chains
    // against `users`+`team_members`+`projects`. We sequence them via a tiny
    // queue keyed by call order: 1) drop lookup, 2) senior lookup, 3) HR
    // count, 4) ACCOUNTANT count, 5) drop-projects.
    const dropTeam: FakeTeam = {
      id: 'team-drop-1',
      name: 'Drop Team',
      type: 'DROP',
      archivedAt: null,
      members: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const queue: unknown[][] = [
      [{ id: 'drop-1', displayName: 'Дроп Иван' }], // drop lookup
      [{ id: 'senior-9', displayName: 'Отцепляющийся Синьор' }], // senior lookup
      [{ userId: 'hr-1' }, { userId: 'hr-2' }], // HR count
      [{ userId: 'acc-1' }], // ACCOUNTANT count
      [
        { id: 'proj-1', name: 'Drop Proj 1' },
        { id: 'proj-2', name: 'Drop Proj 2' },
        { id: 'proj-3', name: 'Drop Proj 3' },
      ], // drop-projects
    ]
    const db = {
      query: {
        teams: {
          findFirst: vi.fn(async () => dropTeam),
          findMany: vi.fn(async () => [] as unknown[]),
        },
        teamMembers: {},
        projects: { findMany: vi.fn(async () => [] as unknown[]) },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              then: (onF: (rows: unknown[]) => unknown) =>
                Promise.resolve(onF((queue.shift() ?? []) as unknown[])),
            })),
          })),
          where: vi.fn(() => ({
            then: (onF: (rows: unknown[]) => unknown) =>
              Promise.resolve(onF((queue.shift() ?? []) as unknown[])),
          })),
        })),
      })),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({} as never),
    }
    const usersService = {
      archive: vi.fn(),
      unarchive: vi.fn(),
      // task-archive-pending-modal (AC2): getArchiveImpact('team') now also
      // forwards the drop's own pending transactions via ONE extra call to
      // UsersService.getArchiveImpact(dropId).
      getArchiveImpact: vi.fn().mockResolvedValue({
        type: 'user',
        role: 'DROP',
        pendingTransactions: [{ id: 'tx-1', type: 'DROP_INCOME' }],
      }),
    }
    const service = new TeamsService(
      { db } as never,
      usersService as never,
      makeTeamAuditLogService() as never,
    )
    const impact = await service.getArchiveImpact('team-drop-1', adminUser)
    expect(impact).toMatchObject({
      type: 'team',
      isPaired: true,
      teamName: 'Drop Team',
      teamType: 'DROP',
      dropName: 'Дроп Иван',
      // Senior is informational — gets detached, not archived.
      seniorName: 'Отцепляющийся Синьор',
      // Forwarded 1:1 from UsersService.getArchiveImpact(dropId).
      pendingTransactions: [{ id: 'tx-1', type: 'DROP_INCOME' }],
      // task-archive-pending-modal (AC8): named, not just counted.
      projectNames: ['Drop Proj 1', 'Drop Proj 2', 'Drop Proj 3'],
      seniorWillBeDetached: true,
      projectsCount: 3,
      membersAffected: 3, // 2 HR + 1 ACCOUNTANT
    })
    expect(usersService.getArchiveImpact).toHaveBeenCalledWith('drop-1', adminUser)
    // The `.select({...})` projection actually asked for `name` — not just
    // `id` — so `projectNames` above is drawn from a real column, not a
    // coincidence of the fake ignoring the projection.
    const projectSelectCall = (db.select as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown> | undefined
        return arg && 'name' in arg
      },
    )
    expect(projectSelectCall).toBeDefined()
    expect(Object.keys(projectSelectCall![0] as Record<string, unknown>).sort()).toEqual([
      'id',
      'name',
    ])
  })

  // task-archive-pending-modal (AC2). The `i.type === 'user' && i.role ===
  // 'DROP'` guard exists because `UsersService.getArchiveImpact` is a union
  // return type — this pins the DEFENSIVE side: an unexpected shape (would
  // only happen if UsersService's own dispatch changed under us) must not
  // crash the team-impact call, just yield no pending list. All THREE
  // ways a mocked shape can fail to match are exercised separately —
  // neither half of the `&&` alone is enough to prove the other half is
  // load-bearing (mutating either operand to `true` must still flip the
  // result on at least one fixture).
  it.each([
    [
      'both wrong (type AND role mismatch)',
      { type: 'team', pendingTransactions: [{ id: 'wrong' }] },
    ],
    [
      'type wrong, role right',
      { type: 'team', role: 'DROP', pendingTransactions: [{ id: 'wrong' }] },
    ],
    [
      'type right, role wrong',
      { type: 'user', role: 'SENIOR', pendingTransactions: [{ id: 'wrong' }] },
    ],
  ])('DROP branch: pendingTransactions defaults to [] — %s', async (_label, mockedUserImpact) => {
    const dropTeam: FakeTeam = {
      id: 'team-drop-2',
      name: 'Drop Team 2',
      type: 'DROP',
      archivedAt: null,
      members: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const queue: unknown[][] = [
      [{ id: 'drop-2', displayName: 'Дроп Two' }], // drop lookup
      [], // no senior
      [], // no HR
      [], // no ACCOUNTANT
      [], // no drop-projects
    ]
    const db = {
      query: {
        teams: { findFirst: vi.fn(async () => dropTeam), findMany: vi.fn(async () => []) },
        teamMembers: {},
        projects: { findMany: vi.fn(async () => []) },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              then: (onF: (rows: unknown[]) => unknown) =>
                Promise.resolve(onF((queue.shift() ?? []) as unknown[])),
            })),
          })),
          where: vi.fn(() => ({
            then: (onF: (rows: unknown[]) => unknown) =>
              Promise.resolve(onF((queue.shift() ?? []) as unknown[])),
          })),
        })),
      })),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({} as never),
    }
    const usersService = {
      archive: vi.fn(),
      unarchive: vi.fn(),
      getArchiveImpact: vi.fn().mockResolvedValue(mockedUserImpact),
    }
    const service = new TeamsService(
      { db } as never,
      usersService as never,
      makeTeamAuditLogService() as never,
    )
    const impact = await service.getArchiveImpact('team-drop-2', adminUser)
    expect(impact).toMatchObject({ type: 'team', teamType: 'DROP', pendingTransactions: [] })
  })
})
