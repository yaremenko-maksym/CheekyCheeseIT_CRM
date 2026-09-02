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
      // task-user-emails-invite: inviteMailer is the 4th constructor
      // param now (transactionsService — @Optional() — moved to 5th).
      // Not exercised by any test in this describe block.
      undefined,
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
    // security-review PR #541 follow-up (HIGH): viewer.role is now threaded
    // through so getTeamMembersForUser can mask JUNIOR identity from a
    // SENIOR viewer — assert the SECOND argument too, not just the target id.
    expect(usersService.getTeamMembersForUser).toHaveBeenCalledWith(target.id, viewer.role)
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

// ---------------------------------------------------------------------------
// createUser — personalEmail forwarding (§4.4, task-user-emails-dual-login)
//
// Mirrors the SAME HR-narrowing posture already applied to legalFullName /
// wallet*/bankUah* just above this field in the controller: an HR actor's
// provisioning surface is deliberately narrow (seniorSharePercent only),
// so personalEmail — PII the invite flow will email — is forced server-
// side regardless of what the request body contains.
// ---------------------------------------------------------------------------

describe('UsersController.createUser — personalEmail (§4.4)', () => {
  function makeCreateUserController(): {
    controller: UsersController
    usersService: { createUser: ReturnType<typeof vi.fn> }
  } {
    const usersService = { createUser: vi.fn().mockResolvedValue({ id: 'new-user' }) }
    const controller = new UsersController(
      usersService as never,
      { list: vi.fn() } as never,
      {} as never,
      undefined,
      undefined,
    )
    return { controller, usersService }
  }

  const seniorBody = {
    email: 'senior@test.com',
    personalEmail: 'personal@test.com',
    displayName: 'Senior Person',
    role: 'SENIOR',
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0xAbCd1234567890aBcDeF1234567890AbCdEf1234',
    legalFullName: 'Іваненко Іван Іванович',
  }

  it('ADMIN actor: personalEmail passes through to UsersService.createUser', async () => {
    const { controller, usersService } = makeCreateUserController()
    const admin = makeUser({ id: 'admin-1', role: 'ADMIN' })

    await controller.createUser(session(admin), seniorBody)

    expect(usersService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ personalEmail: 'personal@test.com' }),
    )
  })

  it('HR actor: personalEmail is forced to null regardless of the request body', async () => {
    const { controller, usersService } = makeCreateUserController()
    const hr = makeUser({ id: 'hr-1', role: 'HR' })

    await controller.createUser(session(hr), seniorBody)

    expect(usersService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ personalEmail: null }),
    )
  })

  it('ADMIN actor: omitted personalEmail forwards null (not undefined)', async () => {
    const { controller, usersService } = makeCreateUserController()
    const admin = makeUser({ id: 'admin-1', role: 'ADMIN' })
    const { personalEmail: _omit, ...bodyWithoutPersonalEmail } = seniorBody

    await controller.createUser(session(admin), bodyWithoutPersonalEmail)

    expect(usersService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ personalEmail: null }),
    )
  })
})

// ---------------------------------------------------------------------------
// task-user-emails-invite (spec §5): POST /users/:id/personal-email/resend-invite
// ---------------------------------------------------------------------------

describe('UsersController.resendPersonalEmailInvite', () => {
  function makeResendController(): {
    controller: UsersController
    usersService: { resendPersonalEmailInvite: ReturnType<typeof vi.fn> }
    inviteMailer: { sendInvite: ReturnType<typeof vi.fn> }
  } {
    const usersService = {
      resendPersonalEmailInvite: vi.fn().mockResolvedValue({
        rawToken: 'raw-token-value',
        email: 'ivan.personal@gmail.com',
        displayName: 'Ivan Petrov',
      }),
    }
    const inviteMailer = { sendInvite: vi.fn().mockResolvedValue(undefined) }
    const controller = new UsersController(
      usersService as never,
      { list: vi.fn() } as never,
      {} as never,
      inviteMailer as never,
      undefined,
    )
    return { controller, usersService, inviteMailer }
  }

  it('regenerates the token via UsersService then hands it straight to the mailer', async () => {
    const { controller, usersService, inviteMailer } = makeResendController()

    const result = await controller.resendPersonalEmailInvite('user-id-1')

    expect(usersService.resendPersonalEmailInvite).toHaveBeenCalledWith('user-id-1')
    expect(inviteMailer.sendInvite).toHaveBeenCalledWith({
      to: 'ivan.personal@gmail.com',
      displayName: 'Ivan Petrov',
      rawToken: 'raw-token-value',
    })
    expect(result).toEqual({ ok: true })
  })

  it('propagates UsersService.resendPersonalEmailInvite rejections without calling the mailer', async () => {
    const { controller, usersService, inviteMailer } = makeResendController()
    usersService.resendPersonalEmailInvite.mockRejectedValue(new ForbiddenException('nope'))

    await expect(controller.resendPersonalEmailInvite('user-id-1')).rejects.toThrow(
      ForbiddenException,
    )
    expect(inviteMailer.sendInvite).not.toHaveBeenCalled()
  })
})
