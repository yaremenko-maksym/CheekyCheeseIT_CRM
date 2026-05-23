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

interface FakeTeam {
  id: string
  name: string
  archivedAt: Date | null
  members: Array<{
    id: string
    teamId: string
    userId: string
    leftAt: Date | null
    joinedAt: Date
    user: { id: string; role: string; displayName: string; email: string; avatar: string | null; techStack: string[] | null; phone: string | null; telegram: string | null } | null
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
              then: (onF: (rows: unknown[]) => unknown) => Promise.resolve(onF(
                teamRow?.members
                  ?.filter((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
                  .map((m) => ({ userId: m.userId, id: m.userId, displayName: m.user?.displayName ?? '' })) ?? [],
              )),
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
      transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({} as never),
    },
  }
}

function buildService(opts: {
  team?: FakeTeam | undefined
  usersServiceArchive?: (id: string, actorId: string) => Promise<unknown>
  usersServiceUnarchive?: (id: string, actorId: string) => Promise<unknown>
  usersServiceImpact?: (id: string) => Promise<unknown>
} = {}) {
  const db = makeDb({ team: opts.team })
  const usersService = {
    archive: vi.fn(opts.usersServiceArchive ?? (async () => undefined)),
    unarchive: vi.fn(opts.usersServiceUnarchive ?? (async () => undefined)),
    getArchiveImpact: vi.fn(opts.usersServiceImpact ?? (async () => ({
      type: 'user',
      role: 'SENIOR',
      isPaired: true,
      projectsCount: 0,
      hrAccountantsToBeRemoved: 0,
    }))),
  }
  const service = new TeamsService(db as never, usersService as never)
  // Spy on findOne so we don't need to mock the entire chain after pair-archive.
  vi.spyOn(service, 'findOne').mockResolvedValue({ id: opts.team?.id ?? 't', name: opts.team?.name ?? 'n' } as never)
  return { service, usersService, db }
}

const seniorMember = {
  id: 'tm-senior',
  teamId: 'team-1',
  userId: 'senior-1',
  leftAt: null,
  joinedAt: new Date(),
  user: { id: 'senior-1', role: 'SENIOR', displayName: 'Senior', email: 's@x.com', avatar: null, techStack: null, phone: null, telegram: null },
}

const hrMember = {
  id: 'tm-hr',
  teamId: 'team-1',
  userId: 'hr-1',
  leftAt: null,
  joinedAt: new Date(),
  user: { id: 'hr-1', role: 'HR', displayName: 'HR', email: 'h@x.com', avatar: null, techStack: null, phone: null, telegram: null },
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
        juniorsAffected: 2,
        hrAccountantsToBeRemoved: 4,
      }),
    })
    const impact = await service.getArchiveImpact('team-1', adminUser)
    expect(impact).toMatchObject({
      type: 'team',
      isPaired: true,
      teamName: team.name,
      seniorName: 'Senior',
      projectsCount: 3,
      membersAffected: 4,
    })
  })
})
