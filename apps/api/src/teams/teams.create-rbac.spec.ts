/**
 * Unit tests for TeamsService.create — RBAC / role-validation / scoping
 *
 * SEC-02 (HIGH) + BIZ-09 (MED): teams.create was accepting arbitrary UUIDs as
 * seniorId / hrIds / accountantId without asserting their roles. An HR could
 * supply a victim SENIOR as `seniorId` → that SENIOR becomes a member of the
 * HR's new team → `getHrSeniorIds(hrId)` now includes the victim → HR gains
 * scoped access to the victim-senior's projects/documents (BOLA).
 *
 * These tests use the same mocked-DB pattern as teams.service.spec.ts so they
 * run without a real PostgreSQL connection (unit job in CI).
 *
 * RED tests are written first; they will FAIL until TeamsService.create is
 * patched.
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import type { SessionUser } from '@crm/shared'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsService } from './teams.service'

// ── Fixtures ─────────────────────────────────────────────────────────────────

type DrizzleDb = { db: NodePgDatabase<typeof schema> }

const adminUser: SessionUser = {
  id: 'admin-uuid-0001-0000-0000-000000000000',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

const hrUser: SessionUser = {
  id: 'hr-uuid-00000-0001-0000-0000-000000000000',
  role: 'HR',
  displayName: 'HR',
  email: 'hr@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

const seniorUser: SessionUser = {
  id: 'senior-uuid-0001-0000-0000-000000000000',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

const juniorUser: SessionUser = {
  id: 'junior-uuid-0001-0000-0000-000000000000',
  role: 'JUNIOR',
  displayName: 'Junior',
  email: 'junior@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

const accUser: SessionUser = {
  id: 'acc-uuid-00000-0001-0000-0000-000000000000',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'acc@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
  legalFullName: null,
}

/** Build a user DB row mirroring schema.users.$inferSelect */
const makeDbUser = (id: string, role: string) => ({
  id,
  role,
  displayName: role,
  email: `${id}@test.spec`,
  avatarUrl: null,
  avatarDocumentId: null,
  googleId: `g-${id}`,
  telegram: null,
  phone: null,
  techStack: null,
  seniorSharePercent: 26,
  dropSharePercent: 5,
  monthlySalary: null,
  salaryCurrency: 'USDT' as const,
  paymentMethod: null,
  walletUsdtErc20: null,
  walletUsdtLabel: null,
  bankUahRecipient: null,
  bankUahIban: null,
  bankUahRnokpp: null,
  bankUahBankName: null,
  legalFullName: null,
  adminNote: null,
  registrationAddress: null,
  usrRecord: null,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})

/** TeamMembers row with leftAt=null (active) */
const makeActiveMembership = (teamId: string, userId: string) => ({
  id: `m-${teamId}-${userId}`,
  teamId,
  userId,
  leftAt: null,
  joinedAt: new Date(),
})

/**
 * Build a mock DatabaseService whose `db.select()…from()…where()` chain
 * resolves to `rows`. Also stubs insert().values() to simulate team creation.
 *
 * `userLookups` is a map of userId → DB-row used by assertUserRole SELECT calls.
 * `activeMembers` is a list of team_members rows used by the dual-active senior check.
 */
function makeDb({
  userLookups = {} as Record<string, ReturnType<typeof makeDbUser>>,
  activeMembers = [] as ReturnType<typeof makeActiveMembership>[],
  insertedTeam = {
    id: 'new-team-id',
    name: 'Test',
    type: 'SENIOR',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Record<string, unknown>,
} = {}): DrizzleDb {
  // Track call index so each sequential .where() resolution picks the right mock.
  let selectCallIdx = 0

  const selectWhere = vi.fn().mockImplementation(() => {
    const idx = selectCallIdx++
    // The service calls select().from(users).where(eq(users.id, userId)) for each user.
    // After user lookups, it calls select().from(teamMembers).where(…) for
    // existing-senior membership check.
    // We need to know which call this is by order:
    //   calls 0..N-1 = user lookups (one per seniorId/hrId/accountantId)
    //   call N       = teamMembers lookup for dual-active senior check
    const userIds = Object.keys(userLookups)
    if (idx < userIds.length) {
      const userId = userIds[idx]
      const row = userId ? (userLookups[userId] ?? null) : null
      return Promise.resolve(row ? [row] : [])
    }
    // teamMembers check
    return Promise.resolve(activeMembers)
  })

  const insertReturningTeam = vi.fn().mockResolvedValue([insertedTeam])
  const insertReturningMembers = vi.fn().mockResolvedValue([])

  let insertCallIdx = 0
  const insertValuesFn = vi.fn().mockImplementation(() => {
    const idx = insertCallIdx++
    return {
      returning: idx === 0 ? insertReturningTeam : insertReturningMembers,
    }
  })

  const insertFn = vi.fn().mockReturnValue({ values: insertValuesFn })

  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere })
  const selectFn = vi.fn().mockReturnValue({ from: selectFrom })

  return {
    db: {
      select: selectFn,
      insert: insertFn,
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn().mockImplementation(async (fn: unknown) => {
        return (fn as (tx: unknown) => Promise<unknown>)({
          select: selectFn,
          insert: insertFn,
          update: vi.fn(),
        })
      }),
      query: { teams: { findFirst: vi.fn() } },
    } as unknown as NodePgDatabase<typeof schema>,
  }
}

function makeService(db: DrizzleDb): TeamsService {
  const auditLog = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as TeamAuditLogService
  return new TeamsService(db as never, {} as never, auditLog)
}

// ── AC1 Tests ────────────────────────────────────────────────────────────────

describe('TeamsService.create — AC1: role validation (SEC-02 HIGH)', () => {
  it('AC1a: throws BadRequestException when seniorId points to a non-SENIOR user', async () => {
    // ATTACK: HR passes a JUNIOR id as seniorId
    const db = makeDb({
      userLookups: {
        [juniorUser.id]: makeDbUser(juniorUser.id, 'JUNIOR'), // seniorId → JUNIOR
        [hrUser.id]: makeDbUser(hrUser.id, 'HR'),
        [accUser.id]: makeDbUser(accUser.id, 'ACCOUNTANT'),
      },
    })
    const service = makeService(db)

    await expect(
      service.create('Team X', juniorUser.id, [hrUser.id], accUser.id, adminUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('AC1b: throws BadRequestException when an hrId points to a non-HR user', async () => {
    // ATTACK: HR passes a SENIOR id inside hrIds
    const db = makeDb({
      userLookups: {
        [seniorUser.id]: makeDbUser(seniorUser.id, 'SENIOR'), // seniorId → OK
        [seniorUser.id + '-2']: makeDbUser(seniorUser.id + '-2', 'SENIOR'), // hrId → SENIOR (wrong)
        [accUser.id]: makeDbUser(accUser.id, 'ACCOUNTANT'),
      },
    })
    const service = makeService(db)

    await expect(
      service.create('Team X', seniorUser.id, [seniorUser.id + '-2'], accUser.id, adminUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('AC1c: throws BadRequestException when accountantId points to a non-ACCOUNTANT user', async () => {
    const db = makeDb({
      userLookups: {
        [seniorUser.id]: makeDbUser(seniorUser.id, 'SENIOR'),
        [hrUser.id]: makeDbUser(hrUser.id, 'HR'),
        [juniorUser.id]: makeDbUser(juniorUser.id, 'JUNIOR'), // accountantId → JUNIOR (wrong)
      },
    })
    const service = makeService(db)

    await expect(
      service.create('Team X', seniorUser.id, [hrUser.id], juniorUser.id, adminUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('AC1d: throws ForbiddenException when caller role is not ADMIN or HR', async () => {
    const db = makeDb()
    const service = makeService(db)

    await expect(
      service.create('Team X', seniorUser.id, [hrUser.id], accUser.id, seniorUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('AC1e: HR self-scoping — HR caller must be present in hrIds', async () => {
    // HR tries to create a team where they are NOT in hrIds → should be rejected
    const otherHrId = 'other-hr-0000-0000-0000-000000000099'
    const db = makeDb({
      userLookups: {
        [seniorUser.id]: makeDbUser(seniorUser.id, 'SENIOR'),
        [otherHrId]: makeDbUser(otherHrId, 'HR'), // only "other" HR in hrIds, not hrUser itself
        [accUser.id]: makeDbUser(accUser.id, 'ACCOUNTANT'),
      },
    })
    const service = makeService(db)

    await expect(
      // hrUser creates a team but does NOT include themselves in hrIds
      service.create('Team X', seniorUser.id, [otherHrId], accUser.id, hrUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('AC1f: throws BadRequestException when senior is already in an active team (dual-active prevention)', async () => {
    const db = makeDb({
      userLookups: {
        [seniorUser.id]: makeDbUser(seniorUser.id, 'SENIOR'),
        [hrUser.id]: makeDbUser(hrUser.id, 'HR'),
        [accUser.id]: makeDbUser(accUser.id, 'ACCOUNTANT'),
      },
      // teamMembers lookup returns existing active membership for the senior
      activeMembers: [makeActiveMembership('existing-team-id', seniorUser.id)],
    })
    const service = makeService(db)

    await expect(
      service.create('Team X', seniorUser.id, [hrUser.id], accUser.id, adminUser),
    ).rejects.toThrow(BadRequestException)
  })

  it('AC1g: valid create by ADMIN — all roles correct, senior not in active team', async () => {
    const db = makeDb({
      userLookups: {
        [seniorUser.id]: makeDbUser(seniorUser.id, 'SENIOR'),
        [hrUser.id]: makeDbUser(hrUser.id, 'HR'),
        [accUser.id]: makeDbUser(accUser.id, 'ACCOUNTANT'),
      },
      activeMembers: [], // senior is free
    })
    const service = makeService(db)

    await expect(
      service.create('Team X', seniorUser.id, [hrUser.id], accUser.id, adminUser),
    ).resolves.toBeDefined()
  })

  it('AC1h: valid create by HR when they include themselves in hrIds', async () => {
    const db = makeDb({
      userLookups: {
        [seniorUser.id]: makeDbUser(seniorUser.id, 'SENIOR'),
        [hrUser.id]: makeDbUser(hrUser.id, 'HR'),
        [accUser.id]: makeDbUser(accUser.id, 'ACCOUNTANT'),
      },
      activeMembers: [],
    })
    const service = makeService(db)

    // HR creates team and includes themselves
    await expect(
      service.create('Team X', seniorUser.id, [hrUser.id], accUser.id, hrUser),
    ).resolves.toBeDefined()
  })
})
