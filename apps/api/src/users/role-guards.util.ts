import { HttpStatus } from '@nestjs/common'
import { apiError } from '../common/api-error'
import type { User } from '../database/schema'

/**
 * Pure privilege-escalation guards extracted from `UsersService.changeRole`
 * and `UsersService.adminUpdateUser`. No db, no `this` — each function is a
 * predicate over its inputs that throws the same `apiError`s, in the same
 * order, as the inline blocks it replaced.
 *
 * The `changeRole` and `adminUpdateUser` variants are DELIBERATELY separate:
 * their actorId (non-null vs nullable) and role-change (unconditional vs
 * only-on-actual-change) semantics differ, so merging them would change
 * behavior.
 */

type Role = User['role']

/**
 * `changeRole` (1)+(2): the role being assigned must not be ADMIN (fixed
 * pool) or DROP (must go through POST /users/drops). Unconditional — runs
 * before the target is even loaded.
 */
export function assertAssignableRole(role: Role): void {
  // (1) ADMIN pool is fixed — elevation to ADMIN is always forbidden here.
  if (role === 'ADMIN') {
    throw apiError('ADMIN_ROLE_ASSIGNMENT_FORBIDDEN', HttpStatus.FORBIDDEN)
  }

  // (2) DROP must be created via the dedicated POST /users/drops endpoint
  // which provisions the associated drop-team atomically. Routing through
  // changeRole would leave the user without a team (broken invariant).
  if (role === 'DROP') {
    throw apiError('DROP_ROLE_CHANGE_VIA_DEDICATED_ENDPOINT', HttpStatus.FORBIDDEN)
  }
}

/**
 * `adminUpdateUser` variant of the assignable-role check: fires only on an
 * ACTUAL role change (`requestedRole !== currentRole`), so resubmitting the
 * current role (an ADMIN self-edit, editing a DROP user's other fields) is
 * unaffected.
 */
export function assertAssignableRoleOnChange(
  requestedRole: Role | undefined,
  currentRole: Role,
): void {
  // Stryker disable next-line ConditionalExpression: equivalent — an undefined requestedRole is neither 'ADMIN' nor 'DROP', so the inner checks cannot throw either way
  if (requestedRole !== undefined && requestedRole !== currentRole) {
    if (requestedRole === 'ADMIN') {
      throw apiError('ADMIN_ROLE_ASSIGNMENT_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    if (requestedRole === 'DROP') {
      throw apiError('DROP_ROLE_CHANGE_VIA_DEDICATED_ENDPOINT', HttpStatus.FORBIDDEN)
    }
  }
}

/**
 * `changeRole` (3)+(4): an ADMIN target's role can never be changed through
 * this endpoint — another actor gets CANNOT_EDIT_ANOTHER_ADMIN, the ADMIN
 * themself gets ADMIN_CANNOT_CHANGE_OWN_ROLE. `actorId` is always present.
 */
export function assertAdminTargetEditableForRoleChange(
  target: Pick<User, 'id' | 'role'>,
  actorId: string,
): void {
  // (3) Cannot change the role of any ADMIN (even to a lower role) unless
  // the actor is editing their own record — and even then self-demotion is
  // blocked by rule (4). Mirrors adminUpdateUser :410.
  if (target.role === 'ADMIN' && actorId !== target.id) {
    throw apiError('CANNOT_EDIT_ANOTHER_ADMIN', HttpStatus.FORBIDDEN)
  }

  // (4) An ADMIN cannot demote themselves via this endpoint.
  // Stryker disable next-line ConditionalExpression: equivalent — check (3) above already threw for every ADMIN target whose id differs from actorId, so actorId === target.id always holds here
  if (target.role === 'ADMIN' && actorId === target.id) {
    throw apiError('ADMIN_CANNOT_CHANGE_OWN_ROLE', HttpStatus.FORBIDDEN)
  }
}

/**
 * `adminUpdateUser` ADMIN-target protection (ut-10/11): a null `actorId`
 * (system/internal caller) skips both checks; another ADMIN cannot be edited;
 * an ADMIN editing themself cannot change their own role away from ADMIN.
 */
export function assertAdminTargetEditableForUpdate(
  target: Pick<User, 'id' | 'role'>,
  requestedRole: Role | undefined,
  actorId: string | null,
): void {
  if (target.role === 'ADMIN' && actorId !== null && target.id !== actorId) {
    throw apiError('CANNOT_EDIT_ANOTHER_ADMIN', HttpStatus.FORBIDDEN)
  }
  if (
    requestedRole !== undefined &&
    target.role === 'ADMIN' &&
    // Stryker disable next-line ConditionalExpression: equivalent — a null actorId can never equal target.id, so the next operand already rejects it
    actorId !== null &&
    // Stryker disable next-line ConditionalExpression: equivalent — the first check above already threw for every non-null actorId differing from an ADMIN target's id
    target.id === actorId &&
    requestedRole !== 'ADMIN'
  ) {
    throw apiError('ADMIN_CANNOT_CHANGE_OWN_ROLE', HttpStatus.FORBIDDEN)
  }
}
