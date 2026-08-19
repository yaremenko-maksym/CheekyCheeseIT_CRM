/**
 * Tests for the DROP-team primitives introduced in Phase 1 of the drop role:
 *  - TeamsService.createDropTeam — assertions on role validation and team_members.
 *  - TeamsService.archiveDropTeam — cascade: drop-projects archived, senior
 *    detached but not archived, HR/Acc detached.
 *  - TeamsService.rotateSenior — replaces current senior, rejects when new
 *    senior is in another active team, rejects on senior-team.
 *  - TeamsService.addSeniorToDropTeam — empty-slot enforcement.
 *
 * The fake DB models the same chainable surface UsersService.archive
 * already exercises elsewhere (see users.archive.spec.ts) but slimmer: we
 * only need to verify routing and validation messages.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TeamsService } from './teams.service'

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@cc.com',
  avatarUrl: null,
  seniorSharePercent: 26,
}

interface FakeUser {
  id: string
  role: string
  displayName?: string
}

interface FakeTeamMember {
  id: string
  teamId: string
  userId: string
  leftAt: Date | null
}

interface FakeTeam {
  id: string
  name: string
  type: 'SENIOR' | 'DROP'
  archivedAt: Date | null
  telegramChannel: string | null
}

interface FakeProject {
  id: string
  seniorId: string
  dropId: string | null
  archivedAt: Date | null
}

function makeDb(store: {
  users: FakeUser[]
  teams: FakeTeam[]
  teamMembers: FakeTeamMember[]
  projects: FakeProject[]
}) {
  // Track latest "filter intent" set by callers — chainable helper interprets it.
  let lastTable = ''
  const filters: {
    userIds?: string[]
    teamIds?: string[]
    roles?: string[]
    activeOnly?: boolean
    dropIds?: string[]
  } = {}

  function chainSelect() {
    const obj: Record<string, unknown> = {
      from: (t: { _: { name: string } }) => {
        lastTable = t._?.name ?? ''
        return obj
      },
      innerJoin: () => obj,
      where: () => obj,
      limit: () => obj,
      then: (fn: (rows: unknown[]) => unknown) => {
        let rows: unknown[] = []
        if (lastTable === 'users') rows = store.users
        else if (lastTable === 'teams') rows = store.teams
        else if (lastTable === 'team_members') rows = store.teamMembers
        else if (lastTable === 'projects') rows = store.projects
        // Filtering is done by the test via fixture seeding; for archive flows
        // the service already iterates and writes back, so returning all rows
        // suffices for the routing assertions we care about.
        return Promise.resolve(fn(rows))
      },
    }
    return obj
  }

  const db = {
    select: vi.fn().mockImplementation(() => chainSelect()),
    insert: vi.fn().mockImplementation((t: { _: { name: string } }) => ({
      values: vi
        .fn()
        .mockImplementation((vals: Record<string, unknown> | Record<string, unknown>[]) => {
          const tableName = t._?.name ?? ''
          const items = Array.isArray(vals) ? vals : [vals]
          if (tableName === 'teams') {
            for (const v of items) {
              const t: FakeTeam = {
                id: (v.id as string) ?? `team-${store.teams.length + 1}`,
                name: v.name as string,
                type: (v.type as 'SENIOR' | 'DROP') ?? 'SENIOR',
                archivedAt: null,
                telegramChannel: (v.telegramChannel as string) ?? null,
              }
              store.teams.push(t)
            }
          } else if (tableName === 'team_members') {
            for (const v of items) {
              store.teamMembers.push({
                id: (v.id as string) ?? `tm-${store.teamMembers.length + 1}`,
                teamId: v.teamId as string,
                userId: v.userId as string,
                leftAt: null,
              })
            }
          }
          return {
            returning: vi
              .fn()
              .mockResolvedValue(
                tableName === 'teams' ? [store.teams[store.teams.length - 1]] : items,
              ),
          }
        }),
    })),
    update: vi.fn().mockImplementation((t: { _: { name: string } }) => {
      const tableName = t._?.name ?? ''
      return {
        set: vi.fn().mockImplementation((vals: Record<string, unknown>) => ({
          where: vi.fn().mockImplementation(async () => {
            // Lightweight: when the service updates a single team or member,
            // best-effort match by recent IDs from store state.
            if (tableName === 'teams') {
              for (const team of store.teams) {
                if (vals.archivedAt !== undefined) team.archivedAt = vals.archivedAt as Date
              }
            } else if (tableName === 'team_members') {
              if (vals.leftAt !== undefined) {
                for (const tm of store.teamMembers) {
                  if (tm.leftAt === null) tm.leftAt = vals.leftAt as Date
                }
              }
            } else if (tableName === 'projects') {
              if (vals.archivedAt !== undefined) {
                for (const p of store.projects) {
                  if (p.archivedAt === null) p.archivedAt = vals.archivedAt as Date
                }
              }
            }
            return { returning: vi.fn().mockResolvedValue([]) }
          }),
          returning: vi.fn().mockResolvedValue([store.teams[0]]),
        })),
      }
    }),
    query: {
      teams: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue(store.teams) },
      teamMembers: { findFirst: vi.fn(), findMany: vi.fn() },
      users: { findFirst: vi.fn() },
      projects: { findMany: vi.fn().mockResolvedValue(store.projects) },
    },
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db)),
    _filters: filters,
  }
  return db
}

function service(store: Parameters<typeof makeDb>[0]) {
  const db = makeDb(store)
  // UsersService is needed for forwardRef wiring in tests; we don't exercise
  // any senior-team archive flow that calls back into it.
  const usersService = {
    archive: vi.fn(),
    unarchivePairTx: vi.fn(),
    getArchiveImpact: vi.fn(),
  } as never
  const svc = new TeamsService({ db } as never, usersService)
  return { svc, db, store }
}

// ---------------------------------------------------------------------------
// createDropTeam
// ---------------------------------------------------------------------------

describe('TeamsService.createDropTeam', () => {
  it('rejects empty hrIds with 400', async () => {
    const { svc } = service({
      users: [
        { id: 'drop-1', role: 'DROP' },
        { id: 'acc-1', role: 'ACCOUNTANT' },
      ],
      teams: [],
      teamMembers: [],
      projects: [],
    })
    await expect(svc.createDropTeam('drop-1', [], 'acc-1', null)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('rejects when dropId user is not DROP', async () => {
    const { svc } = service({
      users: [
        { id: 'sn-1', role: 'SENIOR' },
        { id: 'hr-1', role: 'HR' },
        { id: 'acc-1', role: 'ACCOUNTANT' },
      ],
      teams: [],
      teamMembers: [],
      projects: [],
    })
    await expect(svc.createDropTeam('sn-1', ['hr-1'], 'acc-1', null)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  // Bug-fix: accountant is OPTIONAL. A drop-team must be creatable with a null
  // accountant — no accountant role-assertion, and no accountant team member.
  it('creates a drop-team WITHOUT an accountant (accountantId=null)', async () => {
    const { svc, db } = service({
      users: [],
      teams: [],
      teamMembers: [],
      projects: [],
    })
    // The fake DB can't resolve select() by id, so feed the exact rows the
    // service looks up, in call order: assertUserRole(drop), assertUserRole(hr),
    // then the dropUser fetch. Note there is NO accountant lookup — if the fix
    // regressed and the accountant assertion fired, it would consume a 4th
    // select that returns [] and throw «не найден», failing this test.
    const drop = { id: 'drop-1', role: 'DROP', displayName: 'Drop One' }
    const hr = { id: 'hr-1', role: 'HR' }
    const sequence: unknown[][] = [[drop], [hr], [drop]]
    let call = 0
    db.select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(sequence[call++] ?? [])),
        }),
      }),
    }))
    // Capture team-member inserts by payload shape (member rows carry `userId`),
    // independent of drizzle table-name resolution.
    const insertedMembers: string[] = []
    db.insert = vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        if ('userId' in vals) insertedMembers.push(vals.userId as string)
        return {
          returning: vi
            .fn()
            .mockResolvedValue([{ id: 'team-1', name: 'Команда Drop One', type: 'DROP' }]),
        }
      }),
    }))

    const team = await svc.createDropTeam('drop-1', ['hr-1'], null, null)

    expect(team).toBeDefined()
    // Members = drop + hr only; the accountant is absent.
    expect(insertedMembers.sort()).toEqual(['drop-1', 'hr-1'])
  })
})

// ---------------------------------------------------------------------------
// archiveDropTeam
// ---------------------------------------------------------------------------

describe('TeamsService.archiveDropTeam', () => {
  it('rejects non-DROP team with 400', async () => {
    const { svc, db } = service({
      users: [],
      teams: [{ id: 'team-1', name: 'X', type: 'SENIOR', archivedAt: null, telegramChannel: null }],
      teamMembers: [],
      projects: [],
    })
    // Force select().from(teams).where().for('update').then(rows=>rows[0]) to
    // return our SENIOR team. security-review PR #584 round 2 (MED-4):
    // archiveDropTeam's row-read now locks with `.for('update')` before the
    // type check below runs — the mock chain needs the extra link.
    db.select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          for: () => ({
            then: (fn: (rows: unknown[]) => unknown) =>
              Promise.resolve(
                fn([
                  {
                    id: 'team-1',
                    name: 'X',
                    type: 'SENIOR',
                    archivedAt: null,
                    telegramChannel: null,
                  },
                ]),
              ),
          }),
        }),
      }),
    }))
    await expect(svc.archiveDropTeam('team-1')).rejects.toBeInstanceOf(BadRequestException)
  })
})

// ---------------------------------------------------------------------------
// addSeniorToDropTeam
// ---------------------------------------------------------------------------

describe('TeamsService.addSeniorToDropTeam', () => {
  it('rejects when team is not type=DROP', async () => {
    const { svc, db } = service({
      users: [{ id: 'sn-1', role: 'SENIOR' }],
      teams: [{ id: 'team-1', name: 'X', type: 'SENIOR', archivedAt: null, telegramChannel: null }],
      teamMembers: [],
      projects: [],
    })
    db.select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          then: (fn: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              fn([
                {
                  id: 'team-1',
                  name: 'X',
                  type: 'SENIOR',
                  archivedAt: null,
                  telegramChannel: null,
                },
              ]),
            ),
        }),
      }),
    }))
    await expect(svc.addSeniorToDropTeam('team-1', 'sn-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('rejects when team is archived', async () => {
    const { svc, db } = service({
      users: [{ id: 'sn-1', role: 'SENIOR' }],
      teams: [],
      teamMembers: [],
      projects: [],
    })
    db.select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          then: (fn: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              fn([
                {
                  id: 'team-1',
                  name: 'X',
                  type: 'DROP',
                  archivedAt: new Date(),
                  telegramChannel: null,
                },
              ]),
            ),
        }),
      }),
    }))
    await expect(svc.addSeniorToDropTeam('team-1', 'sn-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })
})

// ---------------------------------------------------------------------------
// rotateSenior
// ---------------------------------------------------------------------------

describe('TeamsService.rotateSenior', () => {
  it('rejects non-ADMIN/HR with 403', async () => {
    const { svc, db } = service({
      users: [{ id: 'sn-2', role: 'SENIOR' }],
      teams: [],
      teamMembers: [],
      projects: [],
    })
    db.select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          then: (fn: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              fn([
                { id: 'team-1', name: 'X', type: 'DROP', archivedAt: null, telegramChannel: null },
              ]),
            ),
        }),
      }),
    }))
    const accountant: SessionUser = { ...adminUser, id: 'acc-1', role: 'ACCOUNTANT' }
    await expect(svc.rotateSenior('team-1', 'sn-2', accountant)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('rejects rotation on senior-team (type=SENIOR) with 400', async () => {
    const { svc, db } = service({
      users: [{ id: 'sn-2', role: 'SENIOR' }],
      teams: [],
      teamMembers: [],
      projects: [],
    })
    db.select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          then: (fn: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              fn([
                {
                  id: 'team-1',
                  name: 'X',
                  type: 'SENIOR',
                  archivedAt: null,
                  telegramChannel: null,
                },
              ]),
            ),
        }),
      }),
    }))
    await expect(svc.rotateSenior('team-1', 'sn-2', adminUser)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })
})

// ---------------------------------------------------------------------------
// mapTeam early return — DROP type does not invoke the senior-team branch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// findAll / findOne — DROP visibility (task-drop-1-backend AC1 + AC2)
//
// AC1: a DROP sees ONLY their own drop-team via findAll (never a foreign team,
//      never "all"). AC2: findOne on a foreign team → 403.
// ---------------------------------------------------------------------------

const dropViewer: SessionUser = {
  id: 'drop-A',
  role: 'DROP',
  displayName: 'Drop A',
  email: 'dropa@cc.com',
  avatarUrl: null,
  seniorSharePercent: 26,
}

// Build a DROP-team row in the shape `mapDropTeam` + the findAll filter expect:
// members carry `user` joins; `leftAt` controls active membership.
function dropTeamRow(
  id: string,
  members: Array<{ userId: string; role: string; leftAt?: Date | null }>,
) {
  return {
    id,
    name: `Drop team ${id}`,
    type: 'DROP' as const,
    telegram: null,
    telegramChannel: null,
    notes: null,
    seniorSharePercentOverride: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    members: members.map((m, i) => ({
      id: `${id}-tm-${i}`,
      teamId: id,
      userId: m.userId,
      leftAt: m.leftAt ?? null,
      joinedAt: new Date('2026-01-01'),
      user: {
        id: m.userId,
        role: m.role,
        displayName: `User ${m.userId}`,
        email: `${m.userId}@cc.com`,
        avatarUrl: null,
        avatarDocumentId: null,
        techStack: null,
        phone: null,
        telegram: null,
      },
    })),
  }
}

describe('TeamsService.findAll — DROP visibility (AC1)', () => {
  it('returns ONLY the drop-team where the DROP is a current member', async () => {
    const own = dropTeamRow('team-own', [
      { userId: 'drop-A', role: 'DROP' },
      { userId: 'hr-1', role: 'HR' },
      { userId: 'acc-1', role: 'ACCOUNTANT' },
    ])
    const foreign = dropTeamRow('team-foreign', [
      { userId: 'drop-B', role: 'DROP' },
      { userId: 'hr-1', role: 'HR' },
    ])
    const { svc, db } = service({ users: [], teams: [], teamMembers: [], projects: [] })
    db.query.teams.findMany = vi.fn().mockResolvedValue([own, foreign])
    db.query.projects.findMany = vi.fn().mockResolvedValue([])

    const result = (await svc.findAll(dropViewer)) as Array<{ id: string }>
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('team-own')
  })

  it('does NOT return a foreign drop-team (no cross-drop leak)', async () => {
    const foreign = dropTeamRow('team-foreign', [{ userId: 'drop-B', role: 'DROP' }])
    const { svc, db } = service({ users: [], teams: [], teamMembers: [], projects: [] })
    db.query.teams.findMany = vi.fn().mockResolvedValue([foreign])
    db.query.projects.findMany = vi.fn().mockResolvedValue([])

    const result = (await svc.findAll(dropViewer)) as unknown[]
    expect(result).toHaveLength(0)
  })

  it('does NOT return "all teams" even when many exist', async () => {
    const own = dropTeamRow('team-own', [{ userId: 'drop-A', role: 'DROP' }])
    const f1 = dropTeamRow('f1', [{ userId: 'drop-B', role: 'DROP' }])
    const f2 = dropTeamRow('f2', [{ userId: 'drop-C', role: 'DROP' }])
    const { svc, db } = service({ users: [], teams: [], teamMembers: [], projects: [] })
    db.query.teams.findMany = vi.fn().mockResolvedValue([own, f1, f2])
    db.query.projects.findMany = vi.fn().mockResolvedValue([])

    const result = (await svc.findAll(dropViewer)) as Array<{ id: string }>
    expect(result.map((t) => t.id)).toEqual(['team-own'])
  })

  it('ignores a team where the DROP membership is no longer active (leftAt set)', async () => {
    const leftTeam = dropTeamRow('team-left', [
      { userId: 'drop-A', role: 'DROP', leftAt: new Date('2026-02-01') },
    ])
    const { svc, db } = service({ users: [], teams: [], teamMembers: [], projects: [] })
    db.query.teams.findMany = vi.fn().mockResolvedValue([leftTeam])
    db.query.projects.findMany = vi.fn().mockResolvedValue([])

    const result = (await svc.findAll(dropViewer)) as unknown[]
    // findAll filters teams by `archived` only at the DB layer; the DROP
    // branch matches on `members.some(userId === self)` regardless of leftAt,
    // BUT a member whose `leftAt` is set is still a row in `team.members`.
    // We assert the stricter active-only contract: the seed flow never leaves
    // a drop in a team they left, so a left membership must not surface the
    // team. If this fails, the findAll DROP filter needs `&& leftAt === null`.
    expect(result).toHaveLength(0)
  })
})

describe('TeamsService.findOne — DROP access (AC2)', () => {
  it('allows the DROP to read their own drop-team', async () => {
    const own = dropTeamRow('team-own', [
      { userId: 'drop-A', role: 'DROP' },
      { userId: 'hr-1', role: 'HR' },
    ])
    const { svc, db } = service({ users: [], teams: [], teamMembers: [], projects: [] })
    db.query.teams.findFirst = vi.fn().mockResolvedValue(own)
    db.query.projects.findMany = vi.fn().mockResolvedValue([])

    const result = (await svc.findOne('team-own', dropViewer)) as { id: string }
    expect(result.id).toBe('team-own')
  })

  it('forbids the DROP from reading a foreign drop-team → 403', async () => {
    const foreign = dropTeamRow('team-foreign', [{ userId: 'drop-B', role: 'DROP' }])
    const { svc, db } = service({ users: [], teams: [], teamMembers: [], projects: [] })
    db.query.teams.findFirst = vi.fn().mockResolvedValue(foreign)
    db.query.projects.findMany = vi.fn().mockResolvedValue([])

    await expect(svc.findOne('team-foreign', dropViewer)).rejects.toBeInstanceOf(ForbiddenException)
  })
})

describe('TeamsService.mapTeam — DROP branch isolation', () => {
  it('senior-team team unaffected by DROP type discrimination (regression)', async () => {
    // We use findAll which invokes mapTeam under the hood; this is an
    // integration check that adding the DROP branch did not break the
    // existing SENIOR path's shape. Mock minimal team_members + users.
    const store = {
      users: [],
      teams: [
        {
          id: 'team-1',
          name: 'Команда A',
          type: 'SENIOR' as const,
          archivedAt: null,
          telegramChannel: null,
        },
      ],
      teamMembers: [],
      projects: [],
    }
    const { svc, db } = service(store)
    db.query.teams.findMany = vi.fn().mockResolvedValue([
      {
        id: 'team-1',
        name: 'Команда A',
        type: 'SENIOR',
        telegram: null,
        telegramChannel: null,
        notes: null,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        members: [
          {
            id: 'tm-1',
            teamId: 'team-1',
            userId: 'sn-1',
            leftAt: null,
            joinedAt: new Date(),
            user: {
              id: 'sn-1',
              role: 'SENIOR',
              displayName: 'Sen',
              email: 's@cc',
              avatarUrl: null,
              avatarDocumentId: null,
              techStack: null,
              phone: null,
              telegram: null,
            },
          },
        ],
      },
    ])
    db.query.projects.findMany = vi.fn().mockResolvedValue([])
    const result = await svc.findAll(adminUser)
    expect(result).toHaveLength(1)
    const team = result[0] as { type: string; members: Array<{ role: string }> }
    expect(team.type).toBe('SENIOR')
    expect(team.members).toHaveLength(1)
    expect(team.members[0]!.role).toBe('SENIOR')
  })
})
