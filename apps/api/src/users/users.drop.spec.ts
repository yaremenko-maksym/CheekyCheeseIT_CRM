/**
 * Validation/RBAC tests for the DROP-role primitives introduced in Phase 1:
 *  - UsersService.createDrop — actor RBAC, hrIds floor, email collision.
 *  - UsersService.archiveDrop — actor RBAC.
 *  - UsersService.createUser — teamMode handling (rejects non-SENIOR JOIN,
 *    rejects missing dropTeamId, rejects DROP via legacy endpoint).
 *
 * These are pure validation checks that run BEFORE the service touches the
 * DB transaction layer — so a minimal stub is sufficient. The full
 * transactional cascade (archiveDropTeam, addSeniorToDropTeam, etc.) is
 * exercised against real Postgres in the db:migrate + db:seed smoke run
 * (see scripts/coder & migration 0020) and against the in-memory store in
 * `teams.drop.spec.ts`.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { UsersService } from './users.service'

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@cc.com',
  avatarUrl: null,
  seniorSharePercent: 26,
}

const seniorActor: SessionUser = { ...adminUser, id: 'sn-1', role: 'SENIOR' }
const hrActor: SessionUser = { ...adminUser, id: 'hr-1', role: 'HR' }

function makeAuditLogService() {
  return { record: vi.fn().mockResolvedValue(undefined) } as never
}

function makeService(opts: { existingEmail?: boolean } = {}) {
  const existingRow = opts.existingEmail ? [{ id: 'x' }] : []
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(existingRow)),
        }),
      }),
    }),
  }
  const teamsService = {
    createDropTeam: vi.fn(),
    archiveDropTeam: vi.fn(),
    addSeniorToDropTeam: vi.fn(),
  } as never
  return new UsersService(
    { db } as never,
    {} as never,
    makeAuditLogService(),
    makeAuditLogService(),
    makeAuditLogService(),
    teamsService,
  )
}

// ---------------------------------------------------------------------------
// createDrop
// ---------------------------------------------------------------------------

describe('UsersService.createDrop — validation/RBAC', () => {
  it('rejects HR actor with 403', async () => {
    const service = makeService()
    await expect(
      service.createDrop(
        {
          email: 'drop@cc.com',
          displayName: 'New Drop',
          paymentMethod: 'USDT_ERC20',
          walletUsdtErc20: '0x1111111111111111111111111111111111111111',
          hrIds: ['hr-1'],
          accountantId: 'acc-1',
        },
        hrActor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('rejects SENIOR actor with 403', async () => {
    const service = makeService()
    await expect(
      service.createDrop(
        {
          email: 'drop@cc.com',
          displayName: 'New Drop',
          paymentMethod: 'USDT_ERC20',
          walletUsdtErc20: '0x1111111111111111111111111111111111111111',
          hrIds: ['hr-1'],
          accountantId: 'acc-1',
        },
        seniorActor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('rejects empty hrIds with 400', async () => {
    const service = makeService()
    await expect(
      service.createDrop(
        {
          email: 'drop@cc.com',
          displayName: 'New Drop',
          paymentMethod: 'USDT_ERC20',
          walletUsdtErc20: '0x1111111111111111111111111111111111111111',
          hrIds: [],
          accountantId: 'acc-1',
        },
        adminUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects on email collision with 409', async () => {
    const service = makeService({ existingEmail: true })
    await expect(
      service.createDrop(
        {
          email: 'drop@cc.com',
          displayName: 'New Drop',
          paymentMethod: 'USDT_ERC20',
          walletUsdtErc20: '0x1111111111111111111111111111111111111111',
          hrIds: ['hr-1'],
          accountantId: 'acc-1',
        },
        adminUser,
      ),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})

// ---------------------------------------------------------------------------
// archiveDrop
// ---------------------------------------------------------------------------

describe('UsersService.archiveDrop — RBAC', () => {
  it('rejects HR actor with 403', async () => {
    const service = makeService()
    await expect(service.archiveDrop('drop-1', hrActor)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('rejects SENIOR actor with 403', async () => {
    const service = makeService()
    await expect(service.archiveDrop('drop-1', seniorActor)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })
})

// ---------------------------------------------------------------------------
// createUser — teamMode handling (Phase 1 senior-create extension)
// ---------------------------------------------------------------------------

describe('UsersService.createUser — teamMode handling', () => {
  it('rejects teamMode=JOIN_DROP_TEAM for non-SENIOR role with 400', async () => {
    const service = makeService()
    await expect(
      service.createUser({
        email: 'hr@cc.com',
        displayName: 'HR Bob',
        role: 'HR',
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: '00000000-0000-0000-0000-000000000123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects teamMode=JOIN_DROP_TEAM without dropTeamId with 400', async () => {
    const service = makeService()
    await expect(
      service.createUser({
        email: 'senior@cc.com',
        displayName: 'Senior Bob',
        role: 'SENIOR',
        teamMode: 'JOIN_DROP_TEAM',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects DROP role on legacy createUser endpoint with 400', async () => {
    const service = makeService()
    await expect(
      service.createUser({
        email: 'drop@cc.com',
        displayName: 'New Drop',
        role: 'DROP',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})
