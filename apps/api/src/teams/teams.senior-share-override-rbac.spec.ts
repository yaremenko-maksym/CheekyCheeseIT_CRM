/**
 * Unit tests for TeamsService.update — AC3: seniorSharePercentOverride RBAC (SEC-04 MED)
 *
 * PROBLEM: TeamsService.update allowed HR to write `seniorSharePercentOverride`
 * on any team they own. This override is snapshotted into
 * `transactions.senior_share_percent` at income-creation time, so an HR can
 * inflate/deflate the senior's financial share on every future transaction for
 * that team. ProjectsService correctly gates project-level override to ADMIN /
 * ACCOUNTANT — the same restriction must apply to the team-level override.
 *
 * These are RED-first unit tests (same mock pattern as teams.service.spec.ts).
 * They will FAIL until TeamsService.update is patched.
 *
 * Additionally: TeamsService.update should write a team_audit_log entry when
 * seniorSharePercentOverride changes.
 */

import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import type { SessionUser } from '@crm/shared'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsService } from './teams.service'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEAM_ID = 'cc000001-0000-4000-aa00-000000000001'
const HR_ID = 'cc000001-0000-4000-bb00-000000000001'
const ADMIN_ID = 'cc000001-0000-4000-bb00-000000000002'
const ACCOUNTANT_ID = 'cc000001-0000-4000-bb00-000000000003'

const hrUser: SessionUser = {
  id: HR_ID,
  role: 'HR',
  displayName: 'HR',
  email: 'hr-override@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

const adminUser: SessionUser = {
  id: ADMIN_ID,
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin-override@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

const accountantUser: SessionUser = {
  id: ACCOUNTANT_ID,
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'acc-override@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

/** A SENIOR-type team where HR_ID is an active member */
const makeTeamWithHr = (overrides: Record<string, unknown> = {}) => ({
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
        email: 'hr@test.spec',
        avatarUrl: null,
        avatarDocumentId: null,
        techStack: null,
        phone: null,
        telegram: null,
      },
    },
  ],
  ...overrides,
})

/**
 * Minimal DB mock for TeamsService.update.
 * The method calls:
 *   1. db.query.teams.findFirst(…) → returns team
 *   2. db.update(teams).set(…).where(…).returning() → returns [updatedTeam]
 */
function makeDb(teamData: ReturnType<typeof makeTeamWithHr>) {
  const updatedTeam = { ...teamData, updatedAt: new Date() }

  const returningFn = vi.fn().mockResolvedValue([updatedTeam])
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn })
  const setFn = vi.fn().mockReturnValue({ where: whereFn })
  const updateFn = vi.fn().mockReturnValue({ set: setFn })

  const findFirstFn = vi.fn().mockResolvedValue(teamData)

  // DatabaseService-shaped object: the service accesses `this.db.db.query` etc.
  // We pass the whole dbSvc object (not just the inner db) to TeamsService ctor.
  const dbSvc = {
    db: {
      query: {
        teams: { findFirst: findFirstFn },
      },
      update: updateFn,
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
    } as unknown as NodePgDatabase<typeof schema>,
  }

  return {
    dbSvc,
    // Expose mocks for assertion
    setFn,
    findFirstFn,
  }
}

function makeService(dbSvc: { db: NodePgDatabase<typeof schema> }): {
  service: TeamsService
  auditRecord: ReturnType<typeof vi.fn>
} {
  const auditRecord = vi.fn().mockResolvedValue(undefined)
  const auditLog = { record: auditRecord } as unknown as TeamAuditLogService
  // Pass the DatabaseService-shaped object (which has .db inside) as the first ctor arg.
  const service = new TeamsService(dbSvc as never, {} as never, auditLog)
  return { service, auditRecord }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TeamsService.update — AC3: seniorSharePercentOverride RBAC (SEC-04)', () => {
  it('AC3a: HR CANNOT set seniorSharePercentOverride (throws ForbiddenException)', async () => {
    const team = makeTeamWithHr()
    const { dbSvc } = makeDb(team)
    const { service } = makeService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha Team', undefined, null, hrUser, undefined, {
        seniorSharePercentOverride: 30,
      }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('AC3b: HR CANNOT clear seniorSharePercentOverride (null = intentional clear)', async () => {
    const team = makeTeamWithHr({ seniorSharePercentOverride: 30 })
    const { dbSvc } = makeDb(team)
    const { service } = makeService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha Team', undefined, null, hrUser, undefined, {
        seniorSharePercentOverride: null,
      }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('AC3c: HR CAN update other team fields (name, notes) without override', async () => {
    const team = makeTeamWithHr()
    const { dbSvc } = makeDb(team)
    const { service } = makeService(dbSvc)

    // No seniorSharePercentOverride in extra → should succeed
    await expect(
      service.update(TEAM_ID, 'New Name', undefined, 'some notes', hrUser),
    ).resolves.toBeDefined()
  })

  it('AC3d: ADMIN CAN set seniorSharePercentOverride', async () => {
    const team = makeTeamWithHr()
    const { dbSvc, setFn } = makeDb(team)
    const { service } = makeService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha Team', undefined, null, adminUser, undefined, {
        seniorSharePercentOverride: 40,
      }),
    ).resolves.toBeDefined()

    // Verify that seniorSharePercentOverride was included in the SET
    const setArg = setFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg).toHaveProperty('seniorSharePercentOverride', 40)
  })

  it('AC3e: ACCOUNTANT CAN set seniorSharePercentOverride', async () => {
    const team = makeTeamWithHr()
    const { dbSvc, setFn } = makeDb(team)
    const { service } = makeService(dbSvc)

    await expect(
      service.update(TEAM_ID, 'Alpha Team', undefined, null, accountantUser, undefined, {
        seniorSharePercentOverride: 35,
      }),
    ).resolves.toBeDefined()

    const setArg = setFn.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg).toHaveProperty('seniorSharePercentOverride', 35)
  })

  it('AC3f: ADMIN change of override is recorded in team_audit_log', async () => {
    const team = makeTeamWithHr({ seniorSharePercentOverride: null })
    const { dbSvc } = makeDb(team)
    const { service, auditRecord } = makeService(dbSvc)

    await service.update(TEAM_ID, 'Alpha Team', undefined, null, adminUser, undefined, {
      seniorSharePercentOverride: 40,
    })

    // audit record must have been called
    expect(auditRecord).toHaveBeenCalledOnce()
    const auditArg = auditRecord.mock.calls[0]?.[0] as Record<string, unknown>
    expect(auditArg).toMatchObject({
      action: 'team_updated',
      targetId: TEAM_ID,
    })
    const changes = auditArg['changes'] as Record<string, { before: unknown; after: unknown }>
    expect(changes['seniorSharePercentOverride']).toEqual({ before: null, after: 40 })
  })
})
