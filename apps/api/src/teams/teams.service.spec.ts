import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import type { SessionUser } from '@crm/shared'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsService } from './teams.service'

type DrizzleDb = { db: NodePgDatabase<typeof schema> }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@cc.com',
  avatar: null,
  seniorSharePercent: 26,
}
const hrUser: SessionUser = {
  id: 'hr-1',
  role: 'HR',
  displayName: 'HR',
  email: 'hr@cc.com',
  avatar: null,
  seniorSharePercent: 26,
}
const seniorUser: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@cc.com',
  avatar: null,
  seniorSharePercent: 26,
}
const juniorUser: SessionUser = {
  id: 'junior-1',
  role: 'JUNIOR',
  displayName: 'Junior',
  email: 'junior@cc.com',
  avatar: null,
  seniorSharePercent: 26,
}
const accountantUser: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Acc',
  email: 'acc@cc.com',
  avatar: null,
  seniorSharePercent: 26,
}

const makeMember = (userId: string, role: string, leftAt: Date | null = null) => ({
  id: `m-${userId}`,
  teamId: 'team-1',
  userId,
  leftAt,
  user: {
    id: userId,
    role,
    displayName: role,
    email: `${role}@cc.com`,
    avatar: null,
    techStack: null,
  },
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

  // A `db.update(...).set(...).where(...)` chain whose `.where()` both resolves
  // (for the soft-delete UPDATE) and is `.returning()`-able (for other paths).
  const makeUpdateChain = () => {
    const whereResult = Promise.resolve([team ?? makeTeam()]) as Promise<unknown> & {
      returning: ReturnType<typeof vi.fn>
    }
    whereResult.returning = vi.fn().mockResolvedValue([team ?? makeTeam()])
    return {
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(whereResult),
      }),
    }
  }

  // The soft-delete + audit run inside db.transaction(async (tx) => …). The tx
  // handle mirrors the real Drizzle surface used in removeMember: update(...) and
  // insert(...) (insert = the audit row, via teamAuditLogService.record(tx)).
  const txInsertValues = vi.fn().mockResolvedValue([])
  const tx = {
    update: vi.fn().mockImplementation(makeUpdateChain),
    insert: vi.fn().mockReturnValue({ values: txInsertValues }),
  }
  const transactionFn = vi
    .fn()
    .mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx))

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
      update: vi.fn().mockImplementation(makeUpdateChain),
      delete: deleteFn,
      transaction: transactionFn,
      _deleteWhereFn: deleteWhereFn,
      _txAuditInsertValues: txInsertValues,
      _tx: tx,
    },
  } as unknown as DrizzleDb & {
    db: {
      _deleteWhereFn: ReturnType<typeof vi.fn>
      _txAuditInsertValues: ReturnType<typeof vi.fn>
      _tx: { update: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> }
    }
  }
}

// Wire the 3-arg TeamsService with the DB mock + a stub UsersService + a real
// TeamAuditLogService bound to the SAME db mock (so its `record` writes through
// the tx insert spy, letting tests assert the audit row was created).
function makeService(db: ReturnType<typeof makeDb>): TeamsService {
  const usersService = {} as never
  const auditLog = new TeamAuditLogService(db as never)
  return new TeamsService(db as never, usersService, auditLog)
}

// ---------------------------------------------------------------------------
// findAll — visibility / RBAC
// ---------------------------------------------------------------------------

describe('TeamsService.findAll', () => {
  it('ADMIN sees all teams', async () => {
    const teams = [makeTeam({ id: 'team-1' }), makeTeam({ id: 'team-2', hrId: 'hr-2' })]
    const service = makeService(makeDb({ teamList: teams }))
    const result = await service.findAll(adminUser)
    expect(result).toHaveLength(2)
  })

  it('HR sees only their own teams', async () => {
    const teams = [
      makeTeam({ id: 'team-1', hrId: 'hr-1', members: [makeMember('hr-1', 'HR')] }),
      makeTeam({ id: 'team-2', hrId: 'hr-99', members: [makeMember('hr-99', 'HR')] }),
    ]
    const service = makeService(makeDb({ teamList: teams }))
    const result = await service.findAll(hrUser)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('team-1')
  })

  it('SENIOR sees teams where they are a static member', async () => {
    const teams = [
      makeTeam({ id: 'team-1', members: [makeMember('senior-1', 'SENIOR')] }),
      makeTeam({ id: 'team-2', members: [] }),
    ]
    const service = makeService(makeDb({ teamList: teams }))
    const result = await service.findAll(seniorUser)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('team-1')
  })

  it('ACCOUNTANT sees all teams', async () => {
    const teams = [makeTeam({ id: 'team-1' }), makeTeam({ id: 'team-2' })]
    const service = makeService(makeDb({ teamList: teams }))
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
    const service = makeService(makeDb({ team }))
    const result = await service.update('team-1', 'Renamed', null, null, adminUser)
    expect(result).toBeDefined()
  })

  it('HR can rename their own team', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const service = makeService(makeDb({ team }))
    const result = await service.update('team-1', 'Renamed', null, null, hrUser)
    expect(result).toBeDefined()
  })

  it("HR cannot rename another HR's team", async () => {
    const team = makeTeam({ members: [makeMember('hr-99', 'HR')] })
    const service = makeService(makeDb({ team }))
    await expect(service.update('team-1', 'Renamed', null, null, hrUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('SENIOR cannot rename a team', async () => {
    const service = makeService(makeDb({ team: makeTeam() }))
    await expect(service.update('team-1', 'Renamed', null, null, seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws NotFoundException when team not found', async () => {
    const db = makeDb({ team: undefined })
    const service = makeService(db)
    await expect(service.update('ghost', 'X', null, null, adminUser)).rejects.toThrow(
      NotFoundException,
    )
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
    const service = makeService(db)
    await expect(service.addMember('team-1', 'senior-1', adminUser)).resolves.toBeUndefined()
  })

  it('SENIOR cannot add a member', async () => {
    const service = makeService(makeDb({ team: makeTeam() }))
    await expect(service.addMember('team-1', 'user-x', seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("HR cannot add to another HR's team", async () => {
    const team = makeTeam({ members: [makeMember('hr-99', 'HR')] })
    const service = makeService(makeDb({ team, user: juniorUser }))
    await expect(service.addMember('team-1', 'junior-1', hrUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws BadRequestException when adding ADMIN as member', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const db = makeDb({ team, user: adminUser })
    const service = makeService(db)
    await expect(service.addMember('team-1', 'admin-1', adminUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('throws BadRequestException when user is an ACTIVE member', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const db = makeDb({ team, user: juniorUser, existingMember: makeMember('junior-1', 'JUNIOR') })
    const service = makeService(db)
    await expect(service.addMember('team-1', 'junior-1', adminUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('reactivates a soft-deleted member instead of inserting a duplicate (re-add works)', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    // Previously removed member: a soft-deleted row (leftAt != null) survives.
    const softDeleted = makeMember('junior-1', 'JUNIOR', new Date('2024-01-01'))
    const db = makeDb({ team, user: juniorUser, existingMember: softDeleted })
    const service = makeService(db)
    await expect(service.addMember('team-1', 'junior-1', adminUser)).resolves.toBeUndefined()
    // Re-add reactivates the existing row (leftAt -> null) — no fresh insert.
    expect(db.db.update).toHaveBeenCalled()
    expect(db.db.insert).not.toHaveBeenCalled()
  })

  it('throws NotFoundException for unknown user', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const db = makeDb({ team, user: undefined })
    const service = makeService(db)
    await expect(service.addMember('team-1', 'ghost', adminUser)).rejects.toThrow(NotFoundException)
  })

  it('throws NotFoundException when team not found', async () => {
    const db = makeDb({ team: undefined })
    const service = makeService(db)
    await expect(service.addMember('ghost-team', 'user-x', adminUser)).rejects.toThrow(
      NotFoundException,
    )
  })
})

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

describe('TeamsService.removeMember', () => {
  it('JUNIOR cannot remove a member', async () => {
    const service = makeService(makeDb({ team: makeTeam() }))
    await expect(service.removeMember('team-1', 'user-x', juniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('ADMIN can remove an HR member when there are at least two HRs', async () => {
    const team = makeTeam({
      members: [makeMember('hr-1', 'HR'), makeMember('hr-2', 'HR')],
    })
    const service = makeService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'hr-1', adminUser)).resolves.toBeUndefined()
  })

  it('soft-deletes (UPDATE leftAt) — no physical DELETE — and records an audit row', async () => {
    const team = makeTeam({
      members: [makeMember('hr-1', 'HR'), makeMember('hr-2', 'HR')],
    })
    const db = makeDb({ team })
    const service = makeService(db)
    await service.removeMember('team-1', 'hr-1', adminUser)
    // Soft-delete: the membership is UPDATEd inside a transaction, never DELETEd.
    expect(db.db.transaction).toHaveBeenCalled()
    expect(db.db._tx.update).toHaveBeenCalled()
    expect(db.db.delete).not.toHaveBeenCalled()
    // Audit row inserted in the same transaction (team_member_removed).
    expect(db.db._txAuditInsertValues).toHaveBeenCalledTimes(1)
    const auditRow = db.db._txAuditInsertValues.mock.calls[0]![0] as {
      action: string
      targetId: string
      actorId: string
    }
    expect(auditRow.action).toBe('team_member_removed')
    expect(auditRow.targetId).toBe('team-1')
    expect(auditRow.actorId).toBe('admin-1')
  })

  it('does not match a SOFT-DELETED member (already-removed row is not removable again)', async () => {
    // A previously-removed HR leaves a soft-deleted row; it must not be "found"
    // as an active member, so a second removeMember returns 404.
    const team = makeTeam({
      members: [makeMember('hr-1', 'HR'), makeMember('hr-2', 'HR', new Date('2024-01-01'))],
    })
    const service = makeService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'hr-2', adminUser)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('counts only ACTIVE members for the last-HR guard (soft-deleted HR ignored)', async () => {
    // hr-2 is soft-deleted, so hr-1 is the last ACTIVE HR — removing it must 400.
    const team = makeTeam({
      members: [makeMember('hr-1', 'HR'), makeMember('hr-2', 'HR', new Date('2024-01-01'))],
    })
    const service = makeService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'hr-1', adminUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('throws BadRequestException when removing the last HR', async () => {
    const team = makeTeam({ members: [makeMember('hr-1', 'HR')] })
    const service = makeService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'hr-1', adminUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('throws BadRequestException when removing the SENIOR (must delete team instead)', async () => {
    const team = makeTeam({ members: [makeMember('senior-1', 'SENIOR')] })
    const service = makeService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'senior-1', adminUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('throws BadRequestException when removing the last ACCOUNTANT', async () => {
    const team = makeTeam({ members: [makeMember('acc-1', 'ACCOUNTANT')] })
    const service = makeService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'acc-1', adminUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('throws NotFoundException when member not in team', async () => {
    const team = makeTeam({ members: [] })
    const service = makeService(makeDb({ team }))
    await expect(service.removeMember('team-1', 'nobody', adminUser)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('throws NotFoundException when team not found', async () => {
    const db = makeDb({ team: undefined })
    const service = makeService(db)
    await expect(service.removeMember('ghost-team', 'user-x', adminUser)).rejects.toThrow(
      NotFoundException,
    )
  })
})

// ---------------------------------------------------------------------------
// mapTeam — JUNIOR viewer: contacts of SENIOR/DROP masked (RBAC A01 2026-06-10)
//
// When viewer is JUNIOR, email/phone/telegram of SENIOR and DROP members
// must be null in the returned team shape. displayName and avatarUrl are
// never masked (persona display).
// HR/ACCOUNTANT members' contacts are NOT masked even for JUNIOR viewer.
// ---------------------------------------------------------------------------

const makeMemberWithContacts = (
  userId: string,
  role: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `m-${userId}`,
  teamId: 'team-1',
  userId,
  leftAt: null,
  joinedAt: new Date(),
  user: {
    id: userId,
    role,
    displayName: `${role} ${userId}`,
    email: `${userId}@secret.com`,
    phone: '+380991234567',
    telegram: `@${userId}`,
    avatarUrl: null,
    avatarDocumentId: null,
    techStack: null,
    ...extra,
  },
})

describe('TeamsService.mapTeam — JUNIOR viewer: SENIOR/DROP contacts masked', () => {
  /**
   * Active project shared between junior-1 and senior-1.
   * Required so that assertAccess() passes for JUNIOR viewer — the access
   * gate checks p.members.some(m => m.userId === junior.id && m.leftAt === null).
   * joinedAt is a Date so pm.joinedAt.toISOString() inside mapTeam works.
   */
  const juniorActiveProject = {
    id: 'proj-1',
    seniorId: 'senior-1',
    dropId: null,
    archivedAt: null,
    members: [
      {
        id: 'pm-1',
        userId: 'junior-1',
        projectId: 'proj-1',
        leftAt: null,
        joinedAt: new Date(),
        user: { id: 'junior-1', role: 'JUNIOR', displayName: 'Junior', email: 'j@cc.com' },
      },
    ],
  }

  it('JUNIOR viewer → SENIOR member email is null', async () => {
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const team = makeTeam({
      type: 'SENIOR',
      seniorSharePercentOverride: null,
      archivedAt: null,
      telegram: null,
      telegramChannel: null,
      notes: null,
      members: [seniorMember],
    })
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const seniorInResult = result.members.find((m: { userId: string }) => m.userId === 'senior-1')
    expect(seniorInResult).toBeDefined()
    expect((seniorInResult as Record<string, unknown>).email).toBeNull()
  })

  it('JUNIOR viewer → SENIOR member phone is null', async () => {
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const team = makeTeam({
      type: 'SENIOR',
      seniorSharePercentOverride: null,
      archivedAt: null,
      telegram: null,
      telegramChannel: null,
      notes: null,
      members: [seniorMember],
    })
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const seniorInResult = result.members.find((m: { userId: string }) => m.userId === 'senior-1')
    expect(seniorInResult).toBeDefined()
    expect((seniorInResult as Record<string, unknown>).phone).toBeNull()
  })

  it('JUNIOR viewer → SENIOR member telegram is null', async () => {
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const team = makeTeam({
      type: 'SENIOR',
      seniorSharePercentOverride: null,
      archivedAt: null,
      telegram: null,
      telegramChannel: null,
      notes: null,
      members: [seniorMember],
    })
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const seniorInResult = result.members.find((m: { userId: string }) => m.userId === 'senior-1')
    expect(seniorInResult).toBeDefined()
    expect((seniorInResult as Record<string, unknown>).telegram).toBeNull()
  })

  it('JUNIOR viewer → SENIOR displayName is present (never masked)', async () => {
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const team = makeTeam({
      type: 'SENIOR',
      seniorSharePercentOverride: null,
      archivedAt: null,
      telegram: null,
      telegramChannel: null,
      notes: null,
      members: [seniorMember],
    })
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const seniorInResult = result.members.find((m: { userId: string }) => m.userId === 'senior-1')
    expect(seniorInResult).toBeDefined()
    expect((seniorInResult as Record<string, unknown>).displayName).toBe('SENIOR senior-1')
  })

  it('HR viewer → SENIOR contacts visible (not masked for HR)', async () => {
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const hrMember = makeMemberWithContacts('hr-1', 'HR')
    const team = makeTeam({
      type: 'SENIOR',
      seniorSharePercentOverride: null,
      archivedAt: null,
      telegram: null,
      telegramChannel: null,
      notes: null,
      members: [seniorMember, hrMember],
    })
    // HR is a static team member → assertAccess passes via team.members check
    const db = makeDb({ team, teamList: [team], projectList: [] })
    const service = makeService(db)

    const result = await service.findOne('team-1', hrUser)
    const seniorInResult = result.members.find((m: { userId: string }) => m.userId === 'senior-1')
    expect(seniorInResult).toBeDefined()
    expect((seniorInResult as Record<string, unknown>).email).toBe('senior-1@secret.com')
    expect((seniorInResult as Record<string, unknown>).phone).toBe('+380991234567')
    expect((seniorInResult as Record<string, unknown>).telegram).toBe('@senior-1')
  })

  it('JUNIOR viewer → HR member contacts visible (HR is not a legend-subject)', async () => {
    // JUNIOR sees the team because they have an active project with this senior
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const hrMember = makeMemberWithContacts('hr-1', 'HR')
    const team = makeTeam({
      type: 'SENIOR',
      seniorSharePercentOverride: null,
      archivedAt: null,
      telegram: null,
      telegramChannel: null,
      notes: null,
      members: [seniorMember, hrMember],
    })
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const hrInResult = result.members.find((m: { userId: string }) => m.userId === 'hr-1')
    // HR contacts should remain visible to JUNIOR (HR is not a legend-subject)
    expect(hrInResult).toBeDefined()
    expect((hrInResult as Record<string, unknown>).email).toBe('hr-1@secret.com')
    // SENIOR contacts must still be null
    const seniorInResult = result.members.find((m: { userId: string }) => m.userId === 'senior-1')
    expect(seniorInResult).toBeDefined()
    expect((seniorInResult as Record<string, unknown>).email).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// mapDropTeam — JUNIOR viewer: SENIOR/DROP contacts masked (RBAC A01 2026-06-10)
//
// Drop-teams render via mapDropTeam (team.type === 'DROP'). A JUNIOR can reach a
// drop-team through assertAccess when the team's SENIOR member is the senior of
// one of the junior's active projects. The legend-persona boundary must hold here
// too: real contacts of SENIOR/DROP members are masked; displayName/HR contacts
// are not.
// ────────────────────────────────────────────────────────────────────────────
describe('TeamsService.mapDropTeam — JUNIOR viewer: SENIOR/DROP contacts masked', () => {
  // Active project linking junior-1 → senior-1, so a JUNIOR passes assertAccess
  // (which finds the drop-team's SENIOR member).
  const juniorActiveProject = {
    id: 'proj-d1',
    seniorId: 'senior-1',
    dropId: null,
    archivedAt: null,
    members: [
      {
        id: 'pm-d1',
        userId: 'junior-1',
        projectId: 'proj-d1',
        leftAt: null,
        joinedAt: new Date(),
        user: { id: 'junior-1', role: 'JUNIOR', displayName: 'Junior', email: 'j@cc.com' },
      },
    ],
  }

  const makeDropTeamWith = (members: unknown[]) =>
    makeTeam({
      type: 'DROP',
      seniorSharePercentOverride: null,
      archivedAt: null,
      telegram: null,
      telegramChannel: null,
      notes: null,
      members,
    })

  it('JUNIOR viewer → DROP member contacts (email/phone/telegram) are null', async () => {
    const dropMember = makeMemberWithContacts('drop-1', 'DROP')
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const team = makeDropTeamWith([dropMember, seniorMember])
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const dropInResult = result.members.find((m: { userId: string }) => m.userId === 'drop-1')
    expect(dropInResult).toBeDefined()
    expect((dropInResult as Record<string, unknown>).email).toBeNull()
    expect((dropInResult as Record<string, unknown>).phone).toBeNull()
    expect((dropInResult as Record<string, unknown>).telegram).toBeNull()
  })

  it('JUNIOR viewer → SENIOR member (in drop-team) contacts are null', async () => {
    const dropMember = makeMemberWithContacts('drop-1', 'DROP')
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const team = makeDropTeamWith([dropMember, seniorMember])
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const seniorInResult = result.members.find((m: { userId: string }) => m.userId === 'senior-1')
    expect(seniorInResult).toBeDefined()
    expect((seniorInResult as Record<string, unknown>).email).toBeNull()
  })

  it('JUNIOR viewer → DROP displayName present (persona display, never masked)', async () => {
    const dropMember = makeMemberWithContacts('drop-1', 'DROP')
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const team = makeDropTeamWith([dropMember, seniorMember])
    const db = makeDb({ team, teamList: [team], projectList: [juniorActiveProject] })
    const service = makeService(db)

    const result = await service.findOne('team-1', juniorUser)
    const dropInResult = result.members.find((m: { userId: string }) => m.userId === 'drop-1')
    expect((dropInResult as Record<string, unknown>).displayName).toBe('DROP drop-1')
  })

  it('HR viewer → DROP contacts visible (not masked for HR)', async () => {
    const dropMember = makeMemberWithContacts('drop-1', 'DROP')
    const seniorMember = makeMemberWithContacts('senior-1', 'SENIOR')
    const hrMember = makeMemberWithContacts('hr-1', 'HR')
    const team = makeDropTeamWith([dropMember, seniorMember, hrMember])
    const db = makeDb({ team, teamList: [team], projectList: [] })
    const service = makeService(db)

    const result = await service.findOne('team-1', hrUser)
    const dropInResult = result.members.find((m: { userId: string }) => m.userId === 'drop-1')
    expect((dropInResult as Record<string, unknown>).email).toBe('drop-1@secret.com')
  })
})
