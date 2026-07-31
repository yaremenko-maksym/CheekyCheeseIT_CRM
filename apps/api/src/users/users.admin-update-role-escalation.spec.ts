/**
 * Unit tests for UsersService.adminUpdateUser — MED (security-audit
 * authz-hardening): role-escalation guard bypass via PATCH /api/users/:id.
 *
 * PROBLEM: changeRole(id, role) (PATCH /:id/role) forbids promoting anyone to
 * ADMIN ("pool is fixed") and forbids moving a user to DROP (must go through
 * the dedicated POST /users/drops team-provisioning flow). adminUpdateUser
 * (PATCH /:id, the general profile-edit endpoint) accepted the exact same
 * `role` field with NEITHER guard — an ADMIN caller could send
 * `PATCH /api/users/:id {role:'ADMIN'}` to elevate an arbitrary user, or
 * `{role:'DROP'}` to move a user into DROP without ever provisioning the
 * mandatory drop-team, silently breaking the SENIOR-team-pair / DROP-team
 * invariants relied on elsewhere.
 *
 * These tests use the same mocked-DB pattern as users.change-role.spec.ts.
 * RED before the fix: adminUpdateUser performs the UPDATE unconditionally
 * for these transitions.
 */

import { ForbiddenException } from '@nestjs/common'
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
 * - `updatedUser`: returned by UPDATE ... RETURNING (inside a transaction)
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

  const db = {
    select: selectFn,
    insert: vi.fn(),
    update: updateFn,
    delete: vi.fn(),
    query: {},
  } as unknown as NodePgDatabase<typeof schema>

  // adminUpdateUser wraps the UPDATE in `this.db.db.transaction(async (tx) => …)`.
  // The mock transaction callback receives the SAME db-shaped object so
  // `tx.update(...)` resolves exactly like `db.update(...)` above.
  ;(db as unknown as { transaction: unknown }).transaction = vi.fn(
    async (cb: (tx: typeof db) => unknown) => cb(db),
  )

  return { db }
}

// ── IDs ───────────────────────────────────────────────────────────────────────

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-000000000001'
const SENIOR_ID = 'ssssssss-ssss-4sss-ssss-000000000001'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('UsersService.adminUpdateUser — MED: role-escalation guard bypass (PATCH /:id)', () => {
  it('elevating a SENIOR to ADMIN via adminUpdateUser is forbidden (mirrors changeRole)', async () => {
    const existing = makeDbUser(SENIOR_ID, 'SENIOR')
    // Without the guard the UPDATE would actually succeed and persist
    // role='ADMIN' — mock the UPDATE...RETURNING as if it were allowed to
    // run, so the assertion below proves the guard rejects BEFORE any write
    // (not that the mock happens to 404 for an unrelated reason).
    const updated = makeDbUser(SENIOR_ID, 'ADMIN')
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await expect(service.adminUpdateUser(SENIOR_ID, { role: 'ADMIN' }, ADMIN_ID)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('moving a SENIOR to DROP via adminUpdateUser is forbidden (must use POST /users/drops)', async () => {
    const existing = makeDbUser(SENIOR_ID, 'SENIOR')
    const updated = makeDbUser(SENIOR_ID, 'DROP')
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    await expect(service.adminUpdateUser(SENIOR_ID, { role: 'DROP' }, ADMIN_ID)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('REGRESSION: ADMIN self-edit round-trip with role unchanged (ADMIN -> ADMIN) still succeeds', async () => {
    const existing = makeDbUser(ADMIN_ID, 'ADMIN')
    const updated = { ...existing, displayName: 'New Name' }
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    // The edit dialog always resubmits the current role — an ADMIN editing
    // their own profile sends role:'ADMIN' unchanged. This must NOT be
    // treated as an elevation attempt (no real role change is occurring).
    const result = await service.adminUpdateUser(
      ADMIN_ID,
      { role: 'ADMIN', displayName: 'New Name' },
      ADMIN_ID,
    )
    expect(result.displayName).toBe('New Name')
  })

  it('REGRESSION: legitimate role change JUNIOR -> SENIOR via adminUpdateUser still succeeds', async () => {
    const juniorId = 'jjjjjjjj-jjjj-4jjj-jjjj-000000000001'
    const existing = makeDbUser(juniorId, 'JUNIOR')
    const updated = makeDbUser(juniorId, 'SENIOR')
    const db = makeDb({ existingUser: existing, updatedUser: updated })
    const service = makeUsersService(db)

    const result = await service.adminUpdateUser(juniorId, { role: 'SENIOR' }, ADMIN_ID)
    expect(result.role).toBe('SENIOR')
  })
})
