/**
 * SR-M-2 pin (security-review #990). Owner decision: "HR may set the senior
 * share 0..100 at CREATION, afterwards only ADMIN may change it."
 *
 * The creation half is pinned in create-user.team-staff.unit.spec.ts /
 * users.create-hr-scope.spec.ts / packages/shared users.spec.ts. This file pins
 * the OTHER half: every post-creation writer of a user's share is unreachable
 * for an HR caller. Evaluated with the REAL `RolesGuard` reading the REAL
 * `@Roles` metadata of the REAL `UsersController` handlers (not a mocked guard),
 * plus the real service-level ADMIN gate on the one share writer that carries no
 * `@Roles` (cancel).
 *
 * Approve / reject carry no `@Roles` by design: they act only on a proposal
 * addressed to the caller as its subject, so an HR caller (never the subject of
 * a share proposal about another user) gets 404 from `ApprovalsService`;
 * that HTTP-level behavior is covered by
 * senior-share-guard-stack.controller.integration.spec.ts.
 */
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { SessionUser } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { RolesGuard } from '../common/guards/roles.guard'
import { SeniorShareChangeService } from './senior-share-change.service'
import { UsersController } from './users.controller'

const session = (role: SessionUser['role']): SessionUser => ({
  id: 'u-1',
  email: `${role.toLowerCase()}@test.spec`,
  displayName: role,
  avatarUrl: null,
  role,
  seniorSharePercent: 0,
})

const contextFor = (handler: () => unknown, user: SessionUser) =>
  ({
    getHandler: () => handler,
    getClass: () => UsersController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext

const guard = new RolesGuard(new Reflector())
const proto = UsersController.prototype

// Writers of `users.seniorSharePercent` after creation:
//   PATCH /users/:id (adminUpdateUser), PATCH /users/:id/salary (changeSalary).
// changeRole is included: it can move a user out of / into SENIOR.
const ADMIN_ONLY_WRITERS = [
  ['PATCH /users/:id', proto.updateUser],
  ['PATCH /users/:id/salary', proto.changeSalary],
  ['PATCH /users/:id/role', proto.changeRole],
] as const

describe('SR-M-2 pin — HR cannot change a senior share after creation', () => {
  it.each(ADMIN_ONLY_WRITERS)('%s: HR is refused by the real RolesGuard', (_route, handler) => {
    expect(() => guard.canActivate(contextFor(handler, session('HR')))).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'FORBIDDEN_INSUFFICIENT_ROLE', statusCode: 403 }),
      }),
    )
  })

  it.each(ADMIN_ONLY_WRITERS)('%s: ADMIN is let through', (_route, handler) => {
    expect(guard.canActivate(contextFor(handler, session('ADMIN')))).toBe(true)
  })

  it('POST /users/:id/senior-share/cancel: HR is refused by the service ADMIN gate (SHARE_CANCEL_ADMIN_ONLY)', async () => {
    const service = Object.create(SeniorShareChangeService.prototype) as SeniorShareChangeService
    await expect(service.cancelSeniorShareChange('u-2', session('HR'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SHARE_CANCEL_ADMIN_ONLY', statusCode: 403 }),
    })
  })
})
