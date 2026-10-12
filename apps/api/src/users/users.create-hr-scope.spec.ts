/**
 * Unit tests for UsersController.createUser — MED (security-audit
 * authz-hardening): HR provisioning scope.
 *
 * PROBLEM: for an HR actor, POST /api/users only checked `dto.role === 'SENIOR'`
 * — every other field (seniorSharePercent, monthlySalary, salaryCurrency,
 * paymentMethod, walletUsdtErc20/Label, bankUah*, legalFullName) was forwarded
 * to UsersService.createUser() verbatim, from the raw request body. A rogue or
 * compromised HR account could provision a SENIOR with:
 *   - a Google email HR itself controls,
 *   - a self-controlled USDT wallet / bank account (redirects future payouts),
 *   - seniorSharePercent = 100 (steals the full project income),
 *   - an arbitrary legalFullName (identity spoofing on the MSA contract).
 *
 * FIX: for an HR actor every finance/PII field above is forced to the server
 * default (ignored), regardless of what the request body contains.
 * `seniorSharePercent` is the ONE exception — team/index.tsx's
 * HrCreateSeniorDialog intentionally exposes it to HR, so it is passed
 * through unchanged for HR too.
 *
 * Strategy: unit-test the CONTROLLER directly (no NestJS runtime), asserting
 * the exact argument object forwarded to `usersService.createUser`.
 */

import { describe, expect, it, vi } from 'vitest'
import { UsersController } from './users.controller'
import type { SessionUser } from '@crm/shared'

const HR_ACTOR_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'

const hrActor: SessionUser = {
  id: HR_ACTOR_ID,
  email: 'hr@test.spec',
  displayName: 'HR Actor',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
}

const adminActor: SessionUser = {
  id: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
  email: 'admin@test.spec',
  displayName: 'Admin Actor',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

/** Full, maximal payload — every finance/PII field populated with attacker-controlled values. */
const maximalSeniorPayload = {
  email: 'victim-senior@attacker-controlled.example',
  displayName: 'New Senior',
  role: 'SENIOR' as const,
  telegram: '@newsenior',
  phone: '+380001234567',
  techStack: ['TypeScript'],
  seniorSharePercent: 100,
  monthlySalary: 499999,
  salaryCurrency: 'USD' as const,
  hrIds: [HR_ACTOR_ID],
  accountantId: null,
  paymentMethod: 'USDT_ERC20' as const,
  walletUsdtErc20: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  walletUsdtLabel: 'HR-controlled wallet',
  bankUahRecipient: 'HR Self',
  bankUahIban: 'UA000000000000000000000000000',
  bankUahRnokpp: '0000000000',
  bankUahBankName: 'PrivatBank',
  legalFullName: 'Підроблений Іван Іванович',
  registrationAddress: 'м. Київ',
}

function makeController(usersService: { createUser: ReturnType<typeof vi.fn> }): UsersController {
  return new UsersController(
    usersService as never,
    { list: vi.fn() } as never,
    {} as never,
    undefined,
  )
}

describe('UsersController.createUser — MED: HR provisioning scope', () => {
  it('HR actor: finance/PII fields are stripped to server defaults, EXCEPT seniorSharePercent', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'created-uuid' })
    const controller = makeController({ createUser })

    await controller.createUser(hrActor, maximalSeniorPayload)

    expect(createUser).toHaveBeenCalledTimes(1)
    const args = createUser.mock.calls[0]![0] as Record<string, unknown>

    // Intentionally exposed to HR in the UI (team/index.tsx) — must pass through.
    expect(args['seniorSharePercent']).toBe(100)
    // Non-finance identity/contact fields are legitimate provisioning inputs — untouched.
    expect(args['email']).toBe(maximalSeniorPayload.email)
    expect(args['displayName']).toBe(maximalSeniorPayload.displayName)
    expect(args['hrIds']).toEqual([HR_ACTOR_ID])

    // Finance/PII fields must be stripped to server defaults — NOT the
    // attacker-controlled values from the request body.
    expect(args['monthlySalary']).toBeNull()
    expect(args['salaryCurrency']).toBeUndefined()
    expect(args['paymentMethod']).toBeUndefined()
    expect(args['walletUsdtErc20']).toBeNull()
    expect(args['walletUsdtLabel']).toBeNull()
    expect(args['bankUahRecipient']).toBeNull()
    expect(args['bankUahIban']).toBeNull()
    expect(args['bankUahRnokpp']).toBeNull()
    expect(args['bankUahBankName']).toBeNull()
    expect(args['legalFullName']).toBeUndefined()
  })

  it('REGRESSION: ADMIN actor sending the same payload gets every field passed through unchanged', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'created-uuid' })
    const controller = makeController({ createUser })

    await controller.createUser(adminActor, maximalSeniorPayload)

    expect(createUser).toHaveBeenCalledTimes(1)
    const args = createUser.mock.calls[0]![0] as Record<string, unknown>

    expect(args['seniorSharePercent']).toBe(100)
    expect(args['monthlySalary']).toBe(499999)
    expect(args['salaryCurrency']).toBe('USD')
    expect(args['paymentMethod']).toBe('USDT_ERC20')
    expect(args['walletUsdtErc20']).toBe(maximalSeniorPayload.walletUsdtErc20)
    expect(args['walletUsdtLabel']).toBe(maximalSeniorPayload.walletUsdtLabel)
    expect(args['legalFullName']).toBe(maximalSeniorPayload.legalFullName)
  })
})

// The exact payload HrCreateSeniorDialog sends: NO paymentMethod / wallet /
// legalFullName. Before `hrCreateSeniorSchema`, `createUserSchema.parse` threw
// on it for every HR request, so HR could not create a senior at all.
describe('UsersController.createUser — HR dialog payload (no requisites)', () => {
  const dialogPayload = {
    email: 'new.senior@example.com',
    displayName: 'Іван Іваненко',
    role: 'SENIOR' as const,
    telegram: '@newsenior',
    phone: '+380001234567',
    techStack: ['TypeScript'],
    seniorSharePercent: 26,
    hrIds: [HR_ACTOR_ID],
    accountantId: null,
  }

  it('HR actor: a requisite-less SENIOR payload is accepted and forwarded with requisites nulled', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'created-uuid' })
    const controller = makeController({ createUser })

    await expect(controller.createUser(hrActor, dialogPayload)).resolves.toEqual({
      id: 'created-uuid',
    })

    expect(createUser).toHaveBeenCalledTimes(1)
    expect(createUser).toHaveBeenCalledWith({
      email: 'new.senior@example.com',
      personalEmail: null,
      displayName: 'Іван Іваненко',
      role: 'SENIOR',
      telegram: '@newsenior',
      phone: '+380001234567',
      avatarUrl: null,
      techStack: ['TypeScript'],
      seniorSharePercent: 26,
      monthlySalary: null,
      hrIds: [HR_ACTOR_ID],
      accountantId: null,
      projectId: null,
      walletUsdtErc20: null,
      walletUsdtLabel: null,
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
      actorRole: 'HR',
      actorId: HR_ACTOR_ID,
    })
  })

  it('HR actor: optional fields omitted → defaults (hrIds [], accountantId null), no share key', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'created-uuid' })
    const controller = makeController({ createUser })

    await controller.createUser(hrActor, {
      email: 'a.b@example.com',
      displayName: 'Ab Cd',
      role: 'SENIOR',
    })

    const args = createUser.mock.calls[0]![0] as Record<string, unknown>
    expect(args['hrIds']).toEqual([])
    expect(args['accountantId']).toBeNull()
    expect(args['telegram']).toBeNull()
    expect(args['techStack']).toBeNull()
    expect(args).not.toHaveProperty('seniorSharePercent')
    expect(args).not.toHaveProperty('teamMode')
    expect(args).not.toHaveProperty('locale')
  })

  it('HR actor: teamMode + dropTeamId + locale are forwarded (service scopes the drop-team)', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'created-uuid' })
    const controller = makeController({ createUser })

    await controller.createUser(hrActor, {
      ...dialogPayload,
      teamMode: 'JOIN_DROP_TEAM',
      dropTeamId: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3',
      locale: 'en',
    })

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3',
        locale: 'en',
      }),
    )
  })

  it.each(['JUNIOR', 'HR', 'ACCOUNTANT', 'ADMIN', 'DROP'])(
    'HR actor: role %s → 403 HR_SENIOR_ONLY_CREATION, service never called',
    async (role) => {
      const createUser = vi.fn()
      const controller = makeController({ createUser })

      await expect(
        controller.createUser(hrActor, { ...dialogPayload, role }),
      ).rejects.toMatchObject({ status: 403 })
      expect(createUser).not.toHaveBeenCalled()
    },
  )

  it.each([null, undefined, 'a string', 42, {}])(
    'HR actor: body %j without role SENIOR → 403, service never called',
    async (body) => {
      const createUser = vi.fn()
      const controller = makeController({ createUser })

      await expect(controller.createUser(hrActor, body)).rejects.toMatchObject({ status: 403 })
      expect(createUser).not.toHaveBeenCalled()
    },
  )

  it('HR actor: a SENIOR body that fails the HR schema (bad email) is a validation error, not forwarded', async () => {
    const createUser = vi.fn()
    const controller = makeController({ createUser })

    await expect(
      controller.createUser(hrActor, { ...dialogPayload, email: 'not-an-email' }),
    ).rejects.toThrow()
    expect(createUser).not.toHaveBeenCalled()
  })

  it('ADMIN actor: a requisite-less SENIOR payload is STILL rejected by createUserSchema (unchanged)', async () => {
    const createUser = vi.fn()
    const controller = makeController({ createUser })

    await expect(controller.createUser(adminActor, dialogPayload)).rejects.toThrow()
    expect(createUser).not.toHaveBeenCalled()
  })

  it('ADMIN actor: ADMIN / DROP role creation keeps its dedicated 403s', async () => {
    const createUser = vi.fn()
    const controller = makeController({ createUser })
    const full = {
      ...maximalSeniorPayload,
      paymentMethod: 'USDT_ERC20' as const,
    }

    await expect(
      controller.createUser(adminActor, { ...full, role: 'ADMIN' }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      controller.createUser(adminActor, { ...full, role: 'DROP' }),
    ).rejects.toMatchObject({ status: 403 })
    expect(createUser).not.toHaveBeenCalled()
  })
})

// Pins the ADMIN (non-HR) forwarding exactly — the HR split removed its `isHrActor` ternaries,
// so every field's pass-through / null-default is asserted by full equality here.
describe('UsersController.createUser — ADMIN forwarding is exact', () => {
  const DROP_TEAM_ID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'
  const ACCOUNTANT_ID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4'
  const PROJECT_ID = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5'

  it('a maximal payload is forwarded field-for-field', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'created-uuid' })
    const controller = makeController({ createUser })

    await controller.createUser(adminActor, {
      ...maximalSeniorPayload,
      personalEmail: 'personal@example.com',
      avatarUrl: 'https://example.com/a.png',
      accountantId: ACCOUNTANT_ID,
      projectId: PROJECT_ID,
      teamMode: 'JOIN_DROP_TEAM',
      dropTeamId: DROP_TEAM_ID,
      locale: 'en',
    })

    expect(createUser).toHaveBeenCalledWith({
      email: maximalSeniorPayload.email,
      personalEmail: 'personal@example.com',
      displayName: 'New Senior',
      role: 'SENIOR',
      telegram: '@newsenior',
      phone: '+380001234567',
      avatarUrl: 'https://example.com/a.png',
      techStack: ['TypeScript'],
      seniorSharePercent: 100,
      monthlySalary: 499999,
      salaryCurrency: 'USD',
      hrIds: [HR_ACTOR_ID],
      accountantId: ACCOUNTANT_ID,
      projectId: PROJECT_ID,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: maximalSeniorPayload.walletUsdtErc20,
      walletUsdtLabel: 'HR-controlled wallet',
      bankUahRecipient: 'HR Self',
      bankUahIban: 'UA000000000000000000000000000',
      bankUahRnokpp: '0000000000',
      bankUahBankName: 'PrivatBank',
      teamMode: 'JOIN_DROP_TEAM',
      dropTeamId: DROP_TEAM_ID,
      legalFullName: 'Підроблений Іван Іванович',
      locale: 'en',
      actorRole: 'ADMIN',
      actorId: adminActor.id,
    })
  })

  it('a minimal payload gets null / empty defaults and none of the optional keys', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'created-uuid' })
    const controller = makeController({ createUser })

    await controller.createUser(adminActor, {
      email: 'min@example.com',
      displayName: 'Min Senior',
      role: 'SENIOR',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: maximalSeniorPayload.walletUsdtErc20,
      legalFullName: 'Мінімальний Сеньйор',
    })

    // toHaveBeenCalledWith ignores keys whose value is `undefined`, so absence is pinned by key.
    const sent = createUser.mock.calls[0]![0] as Record<string, unknown>
    for (const key of [
      'seniorSharePercent',
      'salaryCurrency',
      'teamMode',
      'dropTeamId',
      'locale',
    ]) {
      expect(sent).not.toHaveProperty(key)
    }
    expect(createUser).toHaveBeenCalledWith({
      email: 'min@example.com',
      personalEmail: null,
      displayName: 'Min Senior',
      role: 'SENIOR',
      telegram: null,
      phone: null,
      avatarUrl: null,
      techStack: null,
      monthlySalary: null,
      hrIds: [],
      accountantId: null,
      projectId: null,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: maximalSeniorPayload.walletUsdtErc20,
      walletUsdtLabel: null,
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
      legalFullName: 'Мінімальний Сеньйор',
      actorRole: 'ADMIN',
      actorId: adminActor.id,
    })
  })
})
