/**
 * Unit tests for UsersService.changeRole — SEC-03 (MED)
 *
 * PROBLEM: changeRole(id, role) did a blind UPDATE with no guards:
 *   1. Allowed elevating anyone to ADMIN   (fixed pool should be immutable).
 *   2. Allowed changing another ADMIN's role (forbidden by adminUpdateUser invariant).
 *   3. Allowed self-demotion by an ADMIN.
 *   4. Did not route 'DROP' role changes through createDrop.
 *
 * These tests use the same mocked-DB pattern as users.service.spec.ts.
 *
 * RED tests are written first; they FAIL until UsersService.changeRole is
 * patched to accept actorId and enforce the rules above.
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../database/schema'
import type { AuditLogService } from './audit-log.service'
import type { UsersAccessService } from './users-access.service'
import { UsersService } from './users.service'

// ── Helpers ───────────────────────────────────────────────────────────────────

type DrizzleDb = { db: NodePgDatabase<typeof schema> }

const makeAccessService = (): UsersAccessService => ({}) as unknown as UsersAccessService
const makeAuditLogService = (): AuditLogService =>
  ({ record: vi.fn().mockResolvedValue(undefined) }) as unknown as AuditLogService
const makeTosService = () =>
  ({ getLatestAcceptanceForUser: vi.fn().mockResolvedValue(null) }) as never

const makeUsersService = (db: DrizzleDb): UsersService =>
  new UsersService(
    db as never,
    makeAccessService() as never,
    makeAuditLogService() as never,
    makeTosService(),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // task-pending-share fix-round-1 (CR-H-1): working stub, see the
    // sibling comment in archived-entitlement.realdb.integration.spec.ts.
    { getStatus: async () => 'NONE' as const } as never,
  )

/** Full user DB row */
const makeDbUser = (id: string, role: string) => ({
  id,
  role,
  email: `${id}@test.spec`,
  displayName: role,
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
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
})

/**
 * Build a mock DB where:
 * - `existingUser`: returned by findById(targetId) — SELECT ... WHERE id = :id
 * - `updatedUser`: returned by UPDATE ... RETURNING
 */
function makeDb({
  existingUser,
  updatedUser,
}: {
  existingUser: ReturnType<typeof makeDbUser> | null
  updatedUser?: ReturnType<typeof makeDbUser>
}): DrizzleDb {
  const whereSelectFn = vi.fn().mockResolvedValue(existingUser ? [existingUser] : [])
  const fromFn = vi.fn().mockReturnValue({ where: whereSelectFn })
  const selectFn = vi.fn().mockReturnValue({ from: fromFn })

  const whereUpdateFn = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(updatedUser ? [updatedUser] : []),
  })
  const setFn = vi.fn().mockReturnValue({ where: whereUpdateFn })
  const updateFn = vi.fn().mockReturnValue({ set: setFn })

  return {
    db: {
      select: selectFn,
      insert: vi.fn(),
      update: updateFn,
      delete: vi.fn(),
      query: {},
    } as unknown as NodePgDatabase<typeof schema>,
  }
}

// ── IDs ───────────────────────────────────────────────────────────────────────

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-000000000001'
const ADMIN2_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-000000000002'
const SENIOR_ID = 'ssssssss-ssss-4sss-ssss-000000000001'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('UsersService.changeRole — SEC-03: privilege escalation guard', () => {
  it('AC2a: throws ForbiddenException when dto.role === ADMIN (fixed pool)', async () => {
    const existing = makeDbUser(SENIOR_ID, 'SENIOR')
    const db = makeDb({ existingUser: existing })
    const service = makeUsersService(db)

    // Any actor trying to promote anyone to ADMIN must be rejected.
    await expect(service.changeRole(SENIOR_ID, 'ADMIN', ADMIN_ID)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('AC2b: throws ForbiddenException when changing another ADMIN role', async () => {
    const existing = makeDbUser(ADMIN2_ID, 'ADMIN')
    const db = makeDb({ existingUser: existing })
    const service = makeUsersService(db)

    // ADMIN_ID tries to change ADMIN2_ID role → must be rejected.
    await expect(service.changeRole(ADMIN2_ID, 'SENIOR', ADMIN_ID)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('AC2c: throws ForbiddenException when ADMIN tries to demote themselves', async () => {
    const existing = makeDbUser(ADMIN_ID, 'ADMIN')
    const db = makeDb({ existingUser: existing })
    const service = makeUsersService(db)

    // ADMIN tries to change own role → self-demotion → rejected.
    await expect(service.changeRole(ADMIN_ID, 'SENIOR', ADMIN_ID)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('AC2d: throws ForbiddenException when dto.role === DROP (route through createDrop)', async () => {
    const existing = makeDbUser(SENIOR_ID, 'SENIOR')
    const db = makeDb({ existingUser: existing })
    const service = makeUsersService(db)

    await expect(service.changeRole(SENIOR_ID, 'DROP', ADMIN_ID)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('AC2e: throws NotFoundException when target user does not exist', async () => {
    const db = makeDb({ existingUser: null })
    const service = makeUsersService(db)

    await expect(service.changeRole('non-existent-uuid', 'SENIOR', ADMIN_ID)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('AC2f: successful role change SENIOR → HR by ADMIN (valid path)', async () => {
    const existing = makeDbUser(SENIOR_ID, 'SENIOR')
    const updated = makeDbUser(SENIOR_ID, 'HR')
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.changeRole(SENIOR_ID, 'HR', ADMIN_ID)
    expect(result.role).toBe('HR')
  })

  it('AC2g: successful role change JUNIOR → SENIOR by ADMIN (valid path)', async () => {
    const juniorId = 'jjjjjjjj-jjjj-4jjj-jjjj-000000000001'
    const existing = makeDbUser(juniorId, 'JUNIOR')
    const updated = makeDbUser(juniorId, 'SENIOR')
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.changeRole(juniorId, 'SENIOR', ADMIN_ID)
    expect(result.role).toBe('SENIOR')
  })
})
