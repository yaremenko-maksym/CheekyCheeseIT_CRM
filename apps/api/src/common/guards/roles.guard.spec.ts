import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { GUARD_REFUSAL_MESSAGE, RolesGuard } from './roles.guard'

/**
 * Direct unit coverage of `RolesGuard.canActivate` — added because the
 * CI mutation gate (Stryker, "changed code only") found a SURVIVING mutant
 * on `GUARD_REFUSAL_MESSAGE` after backlog item 133 (security-review round
 * on PR #577): mutating the literal to `""` still passed every existing
 * test, because none of them asserted the message's CONTENT — the
 * guard-layer specs (payout-requests.roles-guard.spec.ts,
 * transactions.summary.roles-guard.spec.ts, drop-income-update.roles-guard
 * .spec.ts) only assert `statusCode === 403`, and
 * job-sourcing-rbac.integration.spec.ts asserts `.toContain(GUARD_REFUSAL_
 * MESSAGE)` — which is ALSO blind to this exact mutant, since `''.includes
 * ('')` is true regardless of what the constant is mutated to.
 *
 * The fix has to compare against a HARDCODED literal, not the constant
 * itself (comparing the constant to itself can never fail, mutated or not).
 */
function buildContext(opts: {
  required: string[] | undefined
  user: SessionUser | undefined
}): ExecutionContext {
  return {
    getHandler: () => ({}) as unknown,
    getClass: () => ({}) as unknown,
    switchToHttp: () => ({
      getRequest: () => ({ user: opts.user }),
    }),
  } as unknown as ExecutionContext
}

function buildReflector(required: string[] | undefined): Reflector {
  return {
    getAllAndOverride: vi.fn().mockReturnValue(required),
  } as unknown as Reflector
}

const ADMIN: SessionUser = {
  id: '11110000-0000-4000-8000-000000000001',
  email: 'admin@test.spec',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}

const JUNIOR: SessionUser = { ...ADMIN, id: '11110000-0000-4000-8000-000000000002', role: 'JUNIOR' }

describe('RolesGuard.canActivate', () => {
  it('no @Roles metadata → allow (returns true), no exception thrown', () => {
    const guard = new RolesGuard(buildReflector(undefined))
    expect(guard.canActivate(buildContext({ required: undefined, user: ADMIN }))).toBe(true)
  })

  it('empty @Roles([]) metadata → allow (same as no metadata)', () => {
    const guard = new RolesGuard(buildReflector([]))
    expect(guard.canActivate(buildContext({ required: [], user: ADMIN }))).toBe(true)
  })

  it('@Roles present, no req.user → throws a bare ForbiddenException', () => {
    const guard = new RolesGuard(buildReflector(['ADMIN']))
    expect(() => guard.canActivate(buildContext({ required: ['ADMIN'], user: undefined }))).toThrow(
      ForbiddenException,
    )
  })

  it("user's role is in the required list → allow", () => {
    const guard = new RolesGuard(buildReflector(['ADMIN', 'ACCOUNTANT']))
    expect(
      guard.canActivate(buildContext({ required: ['ADMIN', 'ACCOUNTANT'], user: ADMIN })),
    ).toBe(true)
  })

  it("user's role is NOT in the required list → throws ForbiddenException with the EXACT generic message (kills the empty-string mutant)", () => {
    const guard = new RolesGuard(buildReflector(['ADMIN', 'ACCOUNTANT']))
    let caught: unknown
    try {
      guard.canActivate(buildContext({ required: ['ADMIN', 'ACCOUNTANT'], user: JUNIOR }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ForbiddenException)
    const response = (caught as ForbiddenException).getResponse() as { message?: string }
    // Hardcoded literal — NOT `GUARD_REFUSAL_MESSAGE` itself. Comparing the
    // constant to itself can never fail under mutation (a mutated "" would
    // still equal a mutated ""), which is exactly the surviving mutant this
    // spec exists to kill.
    expect(response.message).toBe('Недостаточно прав для выполнения этого действия')
    // Belt-and-suspenders: also confirms the exported constant matches the
    // same literal, so a future edit to one without the other is caught.
    expect(GUARD_REFUSAL_MESSAGE).toBe('Недостаточно прав для выполнения этого действия')
  })

  it('backlog item 133: the message never contains a role name — genericized, not just reworded', () => {
    // Regression guard for the ORIGINAL finding (not the mutant): a future
    // edit must not reintroduce `${required.join(', ')}` into the string.
    for (const role of ['ADMIN', 'ACCOUNTANT', 'SENIOR', 'JUNIOR', 'HR', 'DROP']) {
      expect(GUARD_REFUSAL_MESSAGE).not.toContain(role)
    }
  })
})
