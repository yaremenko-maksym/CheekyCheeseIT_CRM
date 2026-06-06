import { describe, expect, it, beforeEach, vi } from 'vitest'
import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { UsersController } from './users.controller'
import type { User } from '../database/schema'

/**
 * Unit tests focused on the RBAC guard added to GET /users/:id/team
 * (CRITICAL #2 from PR #28 reviewer findings).
 *
 * The endpoint must reject viewers whose ViewPermissions do not include the
 * 'team' tab — without this guard a JUNIOR could read any other user's team
 * roster via direct API call, bypassing UI hiding.
 */

const makeUser = (overrides: Partial<User>): User =>
  ({
    id: overrides.id ?? '00000000-0000-0000-0000-000000000000',
    email: 'a@b.c',
    displayName: 'X',
    avatar: null,
    role: 'JUNIOR',
    googleId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    seniorSharePercent: 26,
    monthlySalary: null,
    archivedAt: null,
    adminNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as User

const session = (u: User): SessionUser => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  avatar: u.avatar ?? null,
})

describe('UsersController.getUserTeam — RBAC guard', () => {
  let controller: UsersController
  let usersService: {
    findById: ReturnType<typeof vi.fn>
    getTeamMembersForUser: ReturnType<typeof vi.fn>
  }
  let accessService: { getViewPermissions: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    usersService = {
      findById: vi.fn(),
      getTeamMembersForUser: vi.fn().mockResolvedValue([{ id: 'm1', displayName: 'Mate' }]),
    }
    accessService = { getViewPermissions: vi.fn() }
    controller = new UsersController(
      usersService as never,
      { list: vi.fn() } as never,
      accessService as never,
      undefined,
    )
  })

  it('JUNIOR viewing another JUNIOR with no shared project → 403', async () => {
    const viewer = makeUser({ id: 'jr-a', role: 'JUNIOR' })
    const target = makeUser({ id: 'jr-b', role: 'JUNIOR' })
    usersService.findById.mockImplementation((id: string) =>
      Promise.resolve(id === viewer.id ? viewer : target),
    )
    accessService.getViewPermissions.mockResolvedValue({ tabs: [], actions: [], fields: {} })

    await expect(controller.getUserTeam(target.id, session(viewer))).rejects.toThrow(
      ForbiddenException,
    )
    expect(usersService.getTeamMembersForUser).not.toHaveBeenCalled()
  })

  it('JUNIOR viewing JUNIOR in shared project → 200 + members list', async () => {
    const viewer = makeUser({ id: 'jr-a', role: 'JUNIOR' })
    const target = makeUser({ id: 'jr-b', role: 'JUNIOR' })
    usersService.findById.mockImplementation((id: string) =>
      Promise.resolve(id === viewer.id ? viewer : target),
    )
    // Note: real isSharedProject is consulted inside getViewPermissions. We
    // shortcut by stubbing the access service result for SENIOR-on-shared
    // path (same shape as for JUNIORs sharing a project under one senior).
    accessService.getViewPermissions.mockResolvedValue({
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: {},
    })

    const result = await controller.getUserTeam(target.id, session(viewer))
    expect(result).toEqual([{ id: 'm1', displayName: 'Mate' }])
    expect(usersService.getTeamMembersForUser).toHaveBeenCalledWith(target.id)
  })

  it("HR viewing JUNIOR from own senior's team → 200", async () => {
    const viewer = makeUser({ id: 'hr-1', role: 'HR' })
    const target = makeUser({ id: 'jr-1', role: 'JUNIOR' })
    usersService.findById.mockImplementation((id: string) =>
      Promise.resolve(id === viewer.id ? viewer : target),
    )
    accessService.getViewPermissions.mockResolvedValue({
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: {},
    })

    const result = await controller.getUserTeam(target.id, session(viewer))
    expect(result).toEqual([{ id: 'm1', displayName: 'Mate' }])
  })

  it('HR viewing JUNIOR outside their teams → 403', async () => {
    const viewer = makeUser({ id: 'hr-1', role: 'HR' })
    const target = makeUser({ id: 'jr-2', role: 'JUNIOR' })
    usersService.findById.mockImplementation((id: string) =>
      Promise.resolve(id === viewer.id ? viewer : target),
    )
    accessService.getViewPermissions.mockResolvedValue({ tabs: [], actions: [], fields: {} })

    await expect(controller.getUserTeam(target.id, session(viewer))).rejects.toThrow(
      ForbiddenException,
    )
    expect(usersService.getTeamMembersForUser).not.toHaveBeenCalled()
  })

  it('ADMIN viewing any user → 200', async () => {
    const viewer = makeUser({ id: 'admin', role: 'ADMIN' })
    const target = makeUser({ id: 'jr-x', role: 'JUNIOR' })
    usersService.findById.mockImplementation((id: string) =>
      Promise.resolve(id === viewer.id ? viewer : target),
    )
    accessService.getViewPermissions.mockResolvedValue({
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
      actions: [],
      fields: {},
    })

    const result = await controller.getUserTeam(target.id, session(viewer))
    expect(result).toEqual([{ id: 'm1', displayName: 'Mate' }])
  })

  it('missing viewer or target user → 403 (no leak)', async () => {
    const viewer = makeUser({ id: 'jr', role: 'JUNIOR' })
    // viewer exists, target does not
    usersService.findById.mockImplementation((id: string) =>
      Promise.resolve(id === viewer.id ? viewer : undefined),
    )
    await expect(controller.getUserTeam('ghost-id', session(viewer))).rejects.toThrow(
      ForbiddenException,
    )
    expect(accessService.getViewPermissions).not.toHaveBeenCalled()
  })
})
