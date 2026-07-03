/**
 * Unit tests for security-review findings (PR #328 BLOCK round-1).
 *
 * HIGH-1 (functional regression SEC-04): TeamsService.update was gating on
 *   *presence* of the seniorSharePercentOverride key (overrideTouched), but
 *   the controller ALWAYS sends `{ seniorSharePercentOverride }` from
 *   updateTeamSchema.parse(). HR editing name/notes gets 403 because the
 *   parsed body always carries the key (even when value equals the current
 *   stored value). Fix: gate on REAL CHANGE (before !== after).
 *
 * HIGH-2 (residual BOLA via teamless-senior): TeamsService.create allows HR
 *   as caller. HR-create of an arbitrary team is NOT an established product
 *   workflow (HR uses POST /api/users to create a senior, which auto-forms
 *   the team). Allowing HR to call POST /api/teams with an arbitrary seniorId
 *   lets HR attach a teamless-senior they have no prior relationship with →
 *   BOLA. Fix: restrict create to ADMIN-only.
 *
 * MED (role oracle): assertUserRole leaks role/existence info via error
 *   message ("Пользователь X не найден" / "Ожидалась роль Y, получено Z").
 *   An HR caller that hits create() with a victim UUID can enumerate whether
 *   the UUID exists and what role it has. Fix: generic error on non-ADMIN
 *   paths (keep detailed message only inside transactions where caller is
 *   ADMIN).
 *
 * TDD: RED tests written first, then production code patched.
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import type { SessionUser } from '@crm/shared'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsService } from './teams.service'

// ── Shared fixtures ───────────────────────────────────────────────────────────

type DbSvc = { db: NodePgDatabase<typeof schema> }

const TEAM_ID = 'cccccccc-0000-4000-aa00-000000000001'
const HR_ID = 'cccccccc-0000-4000-bb00-000000000001'
const ADMIN_ID = 'cccccccc-0000-4000-bb00-000000000002'
const SENIOR_ID = 'cccccccc-0000-4000-bb00-000000000003'

const hrUser: SessionUser = {
  id: HR_ID,
  role: 'HR',
  displayName: 'HR',
  email: 'hr@review.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

const adminUser: SessionUser = {
  id: ADMIN_ID,
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@review.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

// ── HIGH-1: update() gating ────────────────────────────────────────────────

/**
 * Builds a minimal DbSvc mock for TeamsService.update.
 *
 * `storedOverride` is what the team currently has in the DB.
 * `findFirstFn` returns a team where HR_ID is an active member.
 */
function makeUpdateDb(storedOverride: number | null = null) {
  const team = {
    id: TEAM_ID,
    name: 'Alpha Team',
    type: 'SENIOR',
    telegram: null,
    telegramChannel: null,
    notes: null,
    seniorSharePercentOverride: storedOverride,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    members: [
      {
        id: 'member-hr',
        teamId: TEAM_ID,
        userId: HR_ID,
        leftAt: null,
        joinedAt: new Date(),
        user: {
          id: HR_ID,
          role: 'HR',
          displayName: 'HR',
          email: 'hr@review.spec',
          avatarUrl: null,
          avatarDocumentId: null,
          techStack: null,
          phone: null,
          telegram: null,
        },
      },
    ],
  }

  const updatedTeam = { ...team, updatedAt: new Date() }
  const returningFn = vi.fn().mockResolvedValue([updatedTeam])
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn })
  const setFn = vi.fn().mockReturnValue({ where: whereFn })
  const updateFn = vi.fn().mockReturnValue({ set: setFn })
  const findFirstFn = vi.fn().mockResolvedValue(team)

  const dbSvc: DbSvc = {
    db: {
      query: { teams: { findFirst: findFirstFn } },
      update: updateFn,
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
    } as unknown as NodePgDatabase<typeof schema>,
  }

  return { dbSvc, setFn, findFirstFn }
}

function makeUpdateService(dbSvc: DbSvc) {
  const auditRecord = vi.fn().mockResolvedValue(undefined)
  const auditLog = { record: auditRecord } as unknown as TeamAuditLogService
  return {
    service: new TeamsService(dbSvc as never, {} as never, auditLog),
    auditRecord,
  }
}

describe('TeamsService.update — HIGH-1: override gate on REAL CHANGE not key presence', () => {
  it('H1a: HR editing name/notes sends seniorSharePercentOverride:null (same as stored null) → 200, no 403', async () => {
    // This is the regression: storedOverride=null, sent null (unchanged) → MUST succeed
    const { dbSvc } = makeUpdateDb(null)
    const { service } = makeUpdateService(dbSvc)

    // Controller always sends extra: { seniorSharePercentOverride: undefined|null }
    // Zod optional().nullable() → undefined when key absent, null when explicitly null
    await expect(
      service.update(
        TEAM_ID,
        'New Name',
        undefined,
        'some notes',
        hrUser,
        undefined,
        { seniorSharePercentOverride: undefined }, // key present, value = no change intended
      ),
    ).resolves.toBeDefined()
  })

  it('H1b: HR sends seniorSharePercentOverride:null same as stored null → 200 (no-op override)', async () => {
    const { dbSvc } = makeUpdateDb(null)
    const { service } = makeUpdateService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha', undefined, null, hrUser, undefined, {
        seniorSharePercentOverride: null, // null → null, no actual change
      }),
    ).resolves.toBeDefined()
  })

  it('H1c: HR sends seniorSharePercentOverride:30 when stored is 30 → 200 (value unchanged)', async () => {
    const { dbSvc } = makeUpdateDb(30)
    const { service } = makeUpdateService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha', undefined, null, hrUser, undefined, {
        seniorSharePercentOverride: 30, // same value, no real change
      }),
    ).resolves.toBeDefined()
  })

  it('H1d: HR sends seniorSharePercentOverride:40 when stored is null → 403 (REAL change, HR forbidden)', async () => {
    const { dbSvc } = makeUpdateDb(null)
    const { service } = makeUpdateService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha', undefined, null, hrUser, undefined, {
        seniorSharePercentOverride: 40, // null → 40, real change
      }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('H1e: HR sends seniorSharePercentOverride:null when stored is 30 → 403 (REAL change: clear override)', async () => {
    const { dbSvc } = makeUpdateDb(30)
    const { service } = makeUpdateService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha', undefined, null, hrUser, undefined, {
        seniorSharePercentOverride: null, // 30 → null, real change
      }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('H1f: ADMIN can change override from null to 40 → 200 + audit log entry', async () => {
    const { dbSvc, setFn } = makeUpdateDb(null)
    const { service, auditRecord } = makeUpdateService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha', undefined, null, adminUser, undefined, {
        seniorSharePercentOverride: 40,
      }),
    ).resolves.toBeDefined()

    const setArg = setFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg).toHaveProperty('seniorSharePercentOverride', 40)
    expect(auditRecord).toHaveBeenCalledOnce()
  })
})

// ── HIGH-2: create() ADMIN-only ────────────────────────────────────────────

/**
 * Minimal DB mock for create(). Needs to return user-role lookups + empty
 * active-membership rows. Uses sequential SELECT call counting via a counter.
 */
function makeCreateDb(userRoles: Record<string, string>) {
  let selectCallIndex = 0

  const whereFn = vi.fn().mockImplementation(() => {
    const callIdx = selectCallIndex++
    // After role-lookup calls, return [] for active-membership check
    const keys = Object.keys(userRoles)
    if (callIdx < keys.length) {
      const userId = keys[callIdx]
      const role = userRoles[userId]
      return Promise.resolve(role !== null ? [{ id: userId, role }] : [])
    }
    return Promise.resolve([]) // empty → no existing active membership
  })

  const fromFn = vi.fn().mockReturnValue({ where: whereFn })
  const selectFn = vi.fn().mockReturnValue({ from: fromFn })

  const insertReturning = vi.fn().mockResolvedValue([{ id: TEAM_ID, name: 'T', type: 'SENIOR' }])
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning })
  const insertFn = vi.fn().mockReturnValue({ values: insertValues })

  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const fakeTx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: TEAM_ID, name: 'T', type: 'SENIOR' }]),
        }),
      }),
    }
    return cb(fakeTx)
  })

  const dbSvc: DbSvc = {
    db: {
      select: selectFn,
      insert: insertFn,
      update: vi.fn(),
      delete: vi.fn(),
      query: {},
      transaction: txFn,
    } as unknown as NodePgDatabase<typeof schema>,
  }

  return { dbSvc }
}

function makeCreateService(dbSvc: DbSvc) {
  const auditLog = { record: vi.fn() } as unknown as TeamAuditLogService
  return new TeamsService(dbSvc as never, {} as never, auditLog)
}

describe('TeamsService.create — HIGH-2: ADMIN-only (HR removed from create gate)', () => {
  it('H2a: HR caller → ForbiddenException regardless of other args', async () => {
    const { dbSvc } = makeCreateDb({ [SENIOR_ID]: 'SENIOR' })
    const service = makeCreateService(dbSvc)

    await expect(service.create('My Team', SENIOR_ID, [HR_ID], null, hrUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('H2b: ADMIN caller with valid args → resolves (no 403)', async () => {
    const roles: Record<string, string> = {
      [SENIOR_ID]: 'SENIOR',
      [HR_ID]: 'HR',
    }
    const { dbSvc } = makeCreateDb(roles)
    const service = makeCreateService(dbSvc)

    await expect(
      service.create('My Team', SENIOR_ID, [HR_ID], null, adminUser),
    ).resolves.toBeDefined()
  })
})

// ── MED: assertUserRole oracle on non-ADMIN paths ─────────────────────────

/**
 * When HR calls create() with an unknown UUID, the error must not reveal
 * whether the UUID exists or what role it has. Instead it must be a generic
 * ForbiddenException (since HR is blocked at the role gate before reaching
 * assertUserRole, after HIGH-2 fix).
 *
 * For the ADMIN path, detailed errors are acceptable (ADMIN is trusted).
 * This test verifies the HR gate fires BEFORE any DB lookup that could leak info.
 */
describe('TeamsService.create — MED: no role oracle leakage to non-ADMIN callers', () => {
  it('MED-a: HR caller gets ForbiddenException before any user DB lookup', async () => {
    const selectFn = vi.fn()
    const dbSvc: DbSvc = {
      db: {
        select: selectFn,
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        query: {},
        transaction: vi.fn(),
      } as unknown as NodePgDatabase<typeof schema>,
    }
    const service = makeCreateService(dbSvc)

    await expect(service.create('T', SENIOR_ID, [HR_ID], null, hrUser)).rejects.toThrow(
      ForbiddenException,
    )

    // CRITICAL: no DB select must have been called (no oracle)
    expect(selectFn).not.toHaveBeenCalled()
  })
})

// ── SEC-02 addMember vector: HR cannot attach arbitrary SENIOR ────────────

/**
 * Builds a minimal DbSvc mock for TeamsService.addMember.
 *
 * `teamHasSenior` controls whether the team already has an active SENIOR.
 * `targetUserRole` is the role of the userId being added.
 */
function makeAddMemberDb(opts: {
  callerIsHrOfTeam?: boolean
  targetUserRole: string
  teamHasSenior?: boolean
}) {
  const { callerIsHrOfTeam = true, targetUserRole, teamHasSenior = false } = opts

  const MEMBER_ID = 'cccccccc-0000-4000-cc00-000000000099'

  const hrMember = callerIsHrOfTeam
    ? [
        {
          id: 'member-hr',
          teamId: TEAM_ID,
          userId: HR_ID,
          leftAt: null,
          joinedAt: new Date(),
          user: { id: HR_ID, role: 'HR', displayName: 'HR', email: 'hr@x', avatarUrl: null },
        },
      ]
    : []

  const seniorMember = teamHasSenior
    ? [
        {
          id: 'member-senior',
          teamId: TEAM_ID,
          userId: SENIOR_ID,
          leftAt: null,
          joinedAt: new Date(),
          user: {
            id: SENIOR_ID,
            role: 'SENIOR',
            displayName: 'Sr',
            email: 'sr@x',
            avatarUrl: null,
          },
        },
      ]
    : []

  const team = {
    id: TEAM_ID,
    name: 'Alpha Team',
    type: 'SENIOR',
    telegram: null,
    telegramChannel: null,
    notes: null,
    seniorSharePercentOverride: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    members: [...hrMember, ...seniorMember],
  }

  const targetUser = {
    id: MEMBER_ID,
    role: targetUserRole,
    displayName: 'Target',
    email: 'target@x',
    avatarUrl: null,
    avatarDocumentId: null,
    techStack: null,
    phone: null,
    telegram: null,
  }

  // findFirst: first call = team, second call = target user, third = existing member check
  let findFirstCallCount = 0
  const findFirstFn = vi.fn().mockImplementation(() => {
    const n = findFirstCallCount++
    if (n === 0) return Promise.resolve(team)
    if (n === 1) return Promise.resolve(targetUser)
    return Promise.resolve(undefined) // no existing member
  })

  const insertValues = vi.fn().mockResolvedValue(undefined)
  const insertFn = vi.fn().mockReturnValue({ values: insertValues })

  const dbSvc: DbSvc = {
    db: {
      query: {
        teams: { findFirst: findFirstFn },
        users: { findFirst: findFirstFn },
        teamMembers: { findFirst: findFirstFn },
        // fetchAllProjects is called when target user is JUNIOR
        projects: { findMany: vi.fn().mockResolvedValue([]) },
      },
      insert: insertFn,
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn(),
    } as unknown as NodePgDatabase<typeof schema>,
  }

  return { dbSvc }
}

function makeAddMemberService(dbSvc: DbSvc) {
  const auditLog = { record: vi.fn() } as unknown as TeamAuditLogService
  return new TeamsService(dbSvc as never, {} as never, auditLog)
}

describe('TeamsService.addMember — SEC-02 HIGH: HR cannot attach arbitrary SENIOR', () => {
  it('AM-a: HR caller adding a SENIOR → ForbiddenException', async () => {
    const { dbSvc } = makeAddMemberDb({ targetUserRole: 'SENIOR' })
    const service = makeAddMemberService(dbSvc)

    await expect(service.addMember(TEAM_ID, 'target-user-id', hrUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('AM-b: ADMIN caller adding a SENIOR to a team with no existing SENIOR → resolves', async () => {
    const { dbSvc } = makeAddMemberDb({ targetUserRole: 'SENIOR', teamHasSenior: false })
    const service = makeAddMemberService(dbSvc)

    await expect(service.addMember(TEAM_ID, 'target-user-id', adminUser)).resolves.toBeUndefined()
  })

  it('AM-c: HR caller adding a JUNIOR → resolves (HR recruiting workflow not broken)', async () => {
    const { dbSvc } = makeAddMemberDb({ targetUserRole: 'JUNIOR' })
    const service = makeAddMemberService(dbSvc)

    await expect(service.addMember(TEAM_ID, 'target-user-id', hrUser)).resolves.toBeUndefined()
  })

  it('AM-d: HR caller adding an HR member → resolves', async () => {
    const { dbSvc } = makeAddMemberDb({ targetUserRole: 'HR' })
    const service = makeAddMemberService(dbSvc)

    await expect(service.addMember(TEAM_ID, 'target-user-id', hrUser)).resolves.toBeUndefined()
  })

  it('AM-e: ADMIN adding a second SENIOR to a team that already has one → BadRequestException', async () => {
    const { dbSvc } = makeAddMemberDb({ targetUserRole: 'SENIOR', teamHasSenior: true })
    const service = makeAddMemberService(dbSvc)

    await expect(service.addMember(TEAM_ID, 'target-user-id', adminUser)).rejects.toThrow(
      BadRequestException,
    )
  })
})
