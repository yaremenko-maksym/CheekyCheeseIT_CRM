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
