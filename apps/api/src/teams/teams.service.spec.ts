import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import type { SessionUser } from '@crm/shared'
import { TeamsService } from './teams.service'

type DrizzleDb = { db: NodePgDatabase<typeof schema> }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminUser: SessionUser = { id: 'admin-1', role: 'ADMIN', displayName: 'Admin', email: 'admin@cc.com', avatar: null }
const hrUser: SessionUser = { id: 'hr-1', role: 'HR', displayName: 'HR', email: 'hr@cc.com', avatar: null }
const seniorUser: SessionUser = { id: 'senior-1', role: 'SENIOR', displayName: 'Senior', email: 'senior@cc.com', avatar: null }
const juniorUser: SessionUser = { id: 'junior-1', role: 'JUNIOR', displayName: 'Junior', email: 'junior@cc.com', avatar: null }
const accountantUser: SessionUser = { id: 'acc-1', role: 'ACCOUNTANT', displayName: 'Acc', email: 'acc@cc.com', avatar: null }

const makeMember = (userId: string, role: string) => ({
  id: `m-${userId}`,
  teamId: 'team-1',
  userId,
  user: { id: userId, role, displayName: role, email: `${role}@cc.com`, avatar: null, techStack: null },
})

const makeTeam = (overrides: Record<string, unknown> = {}) => ({
  id: 'team-1',
  name: 'Team Alpha',
  hrId: 'hr-1',
  members: [] as ReturnType<typeof makeMember>[],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

function makeDb({
  teamList = [] as ReturnType<typeof makeTeam>[],
  team = undefined as ReturnType<typeof makeTeam> | undefined,
  user = undefined as typeof hrUser | undefined,
  existingMember = undefined as ReturnType<typeof makeMember> | undefined,
  projectList = [] as unknown[],
} = {}) {
  const deleteFn = vi.fn()
  const deleteWhereFn = vi.fn().mockResolvedValue([])
  deleteFn.mockReturnValue({ where: deleteWhereFn })

  return {
    db: {
      query: {
        teams: {
          findMany: vi.fn().mockResolvedValue(teamList),
          findFirst: vi.fn().mockResolvedValue(team),
        },
        users: {
          findFirst: vi.fn().mockResolvedValue(user),
        },
        teamMembers: {
          findFirst: vi.fn().mockResolvedValue(existingMember),
        },
        projects: {
          findMany: vi.fn().mockResolvedValue(projectList),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([team ?? makeTeam()]),
          }),
        }),
      }),
      delete: deleteFn,
      _deleteWhereFn: deleteWhereFn,
    },
  } as unknown as DrizzleDb & { db: { _deleteWhereFn: ReturnType<typeof vi.fn> } }
}

// ---------------------------------------------------------------------------
// findAll — visibility / RBAC
// ---------------------------------------------------------------------------

describe('TeamsService.findAll', () => {
  it('ADMIN sees all teams', async () => {
    const teams = [makeTeam({ id: 'team-1' }), makeTeam({ id: 'team-2', hrId: 'hr-2' })]
    const service = new TeamsService(makeDb({ teamList: teams }))
    const result = await service.findAll(adminUser)
    expect(result).toHaveLength(2)
  })

  it('HR sees only their own teams', async () => {
    const teams = [
      makeTeam({ id: 'team-1', hrId: 'hr-1', members: [makeMember('hr-1', 'HR')] }),
      makeTeam({ id: 'team-2', hrId: 'hr-99', members: [makeMember('hr-99', 'HR')] }),
    ]
    const service = new TeamsService(makeDb({ teamList: teams }))
    const result = await service.findAll(hrUser)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('team-1')
  })

  it('SENIOR sees teams where they are a static member', async () => {
    const teams = [
      makeTeam({ id: 'team-1', members: [makeMember('senior-1', 'SENIOR')] }),
      makeTeam({ id: 'team-2', members: [] }),
    ]
    const service = new TeamsService(makeDb({ teamList: teams }))
    const result = await service.findAll(seniorUser)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('team-1')
  })

  it('ACCOUNTANT sees all teams', async () => {
    const teams = [makeTeam({ id: 'team-1' }), makeTeam({ id: 'team-2' })]
    const service = new TeamsService(makeDb({ teamList: teams }))
    const result = await service.findAll(accountantUser)
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// update (rename)
// ---------------------------------------------------------------------------

describe('TeamsService.update', () => {
  it('ADMIN can rename any team', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const service = new TeamsService(makeDb({ team }))
    const result = await service.update('team-1', 'Renamed', null, null, adminUser)
    expect(result).toBeDefined()
  })

  it('HR can rename their own team', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const service = new TeamsService(makeDb({ team }))
    const result = await service.update('team-1', 'Renamed', null, null, hrUser)
    expect(result).toBeDefined()
  })

  it('HR cannot rename another HR\'s team', async () => {
    const team = makeTeam({ members: [makeMember('hr-99', 'HR')] })
    const service = new TeamsService(makeDb({ team }))
    await expect(service.update('team-1', 'Renamed', null, null, hrUser)).rejects.toThrow(ForbiddenException)
  })

  it('SENIOR cannot rename a team', async () => {
    const service = new TeamsService(makeDb({ team: makeTeam() }))
    await expect(service.update('team-1', 'Renamed', null, null, seniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('throws NotFoundException when team not found', async () => {
    const db = makeDb({ team: undefined })
    const service = new TeamsService(db)
    await expect(service.update('ghost', 'X', null, null, adminUser)).rejects.toThrow(NotFoundException)
  })
})

// NOTE: `TeamsService.remove` hard-delete has been removed (use `archive` for
// soft archive). The corresponding test block has been removed alongside the
// dead method. Archive cascade behaviour is tested in `teams.archive.spec.ts`.

// ---------------------------------------------------------------------------
// addMember
// ---------------------------------------------------------------------------

describe('TeamsService.addMember', () => {
  it('ADMIN can add a member', async () => {
    const team = makeTeam()
    const db = makeDb({ team, user: seniorUser })
    const service = new TeamsService(db)
    await expect(service.addMember('team-1', 'senior-1', adminUser)).resolves.toBeUndefined()
  })

  it('SENIOR cannot add a member', async () => {
    const service = new TeamsService(makeDb({ team: makeTeam() }))
    await expect(service.addMember('team-1', 'user-x', seniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('HR cannot add to another HR\'s team', async () => {
    const team = makeTeam({ members: [makeMember('hr-99', 'HR')] })
    const service = new TeamsService(makeDb({ team, user: juniorUser }))
    await expect(service.addMember('team-1', 'junior-1', hrUser)).rejects.toThrow(ForbiddenException)
  })

  it('throws BadRequestException when adding ADMIN as member', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const db = makeDb({ team, user: adminUser })
    const service = new TeamsService(db)
    await expect(service.addMember('team-1', 'admin-1', adminUser)).rejects.toThrow(BadRequestException)
  })

  it('throws BadRequestException when user already a member', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const db = makeDb({ team, user: juniorUser, existingMember: makeMember('junior-1', 'JUNIOR') })
    const service = new TeamsService(db)
    await expect(service.addMember('team-1', 'junior-1', adminUser)).rejects.toThrow(BadRequestException)
  })

  it('throws NotFoundException for unknown user', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const db = makeDb({ team, user: undefined })
    const service = new TeamsService(db)
    await expect(service.addMember('team-1', 'ghost', adminUser)).rejects.toThrow(NotFoundException)
  })

  it('throws NotFoundException when team not found', async () => {
    const db = makeDb({ team: undefined })
    const service = new TeamsService(db)
    await expect(service.addMember('ghost-team', 'user-x', adminUser)).rejects.toThrow(NotFoundException)
  })
})

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

describe('TeamsService.removeMember', () => {
  it('JUNIOR cannot remove a member', async () => {
    const service = new TeamsService(makeDb({ team: makeTeam() }))
    await expect(service.removeMember('team-1', 'user-x', juniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('ADMIN can remove an HR member when there are at least two HRs', async () => {
    const team = makeTeam({
      members: [makeMember('hr-1', 'HR'), makeMember('hr-2', 'HR')],
    })
    const service = new TeamsService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'hr-1', adminUser)).resolves.toBeUndefined()
  })

  it('throws BadRequestException when removing the last HR', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const service = new TeamsService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'hr-1', adminUser)).rejects.toThrow(BadRequestException)
  })

  it('throws BadRequestException when removing the SENIOR (must delete team instead)', async () => {
    const team = makeTeam({ members: [makeMember('senior-1', 'SENIOR')] })
    const service = new TeamsService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'senior-1', adminUser)).rejects.toThrow(BadRequestException)
  })

  it('throws BadRequestException when removing the last ACCOUNTANT', async () => {
    const team = makeTeam({ members: [makeMember('acc-1', 'ACCOUNTANT')] })
    const service = new TeamsService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'acc-1', adminUser)).rejects.toThrow(BadRequestException)
  })

  it('throws NotFoundException when member not in team', async () => {
    const team = makeTeam({ members: [] })
    const service = new TeamsService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'nobody', adminUser)).rejects.toThrow(NotFoundException)
  })

  it('throws NotFoundException when team not found', async () => {
    const db = makeDb({ team: undefined })
    const service = new TeamsService(db)
    await expect(service.removeMember('ghost-team', 'user-x', adminUser)).rejects.toThrow(NotFoundException)
  })
})
