import { ForbiddenException, HttpException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'
import { API_ERROR_MESSAGES, API_ERROR_PARAMS, type SessionUser } from '@crm/shared'

import { RolesGuard } from './roles.guard'

/**
 * Direct unit coverage of `RolesGuard.canActivate` — added because the
 * CI mutation gate (Stryker, "changed code only") found a SURVIVING mutant
 * on the refusal after backlog item 133 (security-review round
 * on PR #577): mutating the refusal text to `""` still passed every existing
 * test, because none of them asserted its CONTENT — the guard-layer specs
 * (payout-requests.roles-guard.spec.ts, transactions.summary.roles-guard
 * .spec.ts, drop-income-update.roles-guard.spec.ts) only assert
 * `statusCode === 403`.
 *
 * Since i18n stage-6B Wave 4 the refusal is the `FORBIDDEN_INSUFFICIENT_ROLE`
 * api-error code; the fix still compares against HARDCODED literals (code,
 * status, English fallback), never a constant against itself.
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

  it("user's role is NOT in the required list → 403 with the EXACT generic api-error code (kills the empty-code mutant)", () => {
    const guard = new RolesGuard(buildReflector(['ADMIN', 'ACCOUNTANT']))
    let caught: unknown
    try {
      guard.canActivate(buildContext({ required: ['ADMIN', 'ACCOUNTANT'], user: JUNIOR }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HttpException)
    expect((caught as HttpException).getStatus()).toBe(403)
    const response = (caught as HttpException).getResponse() as {
      statusCode?: number
      code?: string
      message?: string
    }
    // Hardcoded literals — NOT a shared constant compared with itself, which
    // can never fail under mutation (a mutated "" would still equal itself).
    expect(response.statusCode).toBe(403)
    expect(response.code).toBe('FORBIDDEN_INSUFFICIENT_ROLE')
    expect(response.message).toBe("You don't have permission to do this")
  })

  it('backlog item 133 (SECURITY): the refusal never reveals the required role — no params, no role name anywhere in the envelope', () => {
    // Regression guard for the ORIGINAL finding: a future edit must neither
    // reintroduce `${required.join(', ')}` into the text nor add a `params`
    // channel carrying the allow-list. Asserted on the REAL thrown envelope
    // (code + params + English fallback), for every role the guard could name.
    const guard = new RolesGuard(buildReflector(['ADMIN', 'ACCOUNTANT']))
    let caught: unknown
    try {
      guard.canActivate(buildContext({ required: ['ADMIN', 'ACCOUNTANT'], user: JUNIOR }))
    } catch (e) {
      caught = e
    }
    const response = (caught as HttpException).getResponse() as { params?: unknown }
    expect(response.params).toBeUndefined()
    const wire = JSON.stringify(response)
    const roles = ['ADMIN', 'ACCOUNTANT', 'SENIOR', 'JUNIOR', 'HR', 'DROP']
    for (const role of roles) {
      expect(wire).not.toContain(role)
    }
    // The uk catalog text (what a client with a catalog shows) is covered too.
    const uk = API_ERROR_MESSAGES.FORBIDDEN_INSUFFICIENT_ROLE.message as string
    for (const role of roles) {
      expect(uk).not.toContain(role)
    }
    expect(API_ERROR_PARAMS.FORBIDDEN_INSUFFICIENT_ROLE).toEqual([])
  })
})
