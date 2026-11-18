import { describe, expect, it } from 'vitest'
import type { User } from '../database/schema'
import {
  assertAdminTargetEditableForRoleChange,
  assertAdminTargetEditableForUpdate,
  assertAssignableRole,
  assertAssignableRoleOnChange,
  assertSeniorOnlyRoles,
  assertSeniorRoleFloor,
  rolesChanged,
} from './role-guards.util'

type Role = User['role']

function codeOf(fn: () => void): unknown {
  try {
    fn()
  } catch (e) {
    const body = (e as { getResponse: () => unknown }).getResponse()
    return (body as { code?: string }).code
  }
  return undefined
}

describe('assertAssignableRole', () => {
  it('forbids ADMIN', () => {
    expect(codeOf(() => assertAssignableRole('ADMIN'))).toBe('ADMIN_ROLE_ASSIGNMENT_FORBIDDEN')
  })
  it('forbids DROP', () => {
    expect(codeOf(() => assertAssignableRole('DROP'))).toBe(
      'DROP_ROLE_CHANGE_VIA_DEDICATED_ENDPOINT',
    )
  })
  it.each(['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'] as Role[])('allows %s', (r) => {
    expect(() => assertAssignableRole(r)).not.toThrow()
  })
})

describe('assertAssignableRoleOnChange', () => {
  it('forbids changing to ADMIN', () => {
    expect(codeOf(() => assertAssignableRoleOnChange('ADMIN', 'JUNIOR'))).toBe(
      'ADMIN_ROLE_ASSIGNMENT_FORBIDDEN',
    )
  })
  it('forbids changing to DROP', () => {
    expect(codeOf(() => assertAssignableRoleOnChange('DROP', 'JUNIOR'))).toBe(
      'DROP_ROLE_CHANGE_VIA_DEDICATED_ENDPOINT',
    )
  })
  it('allows resubmitting the current ADMIN role', () => {
    expect(() => assertAssignableRoleOnChange('ADMIN', 'ADMIN')).not.toThrow()
  })
  it('allows resubmitting the current DROP role', () => {
    expect(() => assertAssignableRoleOnChange('DROP', 'DROP')).not.toThrow()
  })
  it('allows an undefined requested role', () => {
    expect(() => assertAssignableRoleOnChange(undefined, 'JUNIOR')).not.toThrow()
  })
  it('allows an ordinary change', () => {
    expect(() => assertAssignableRoleOnChange('SENIOR', 'JUNIOR')).not.toThrow()
  })
})

describe('assertAdminTargetEditableForRoleChange', () => {
  it('blocks another actor editing an ADMIN', () => {
    expect(
      codeOf(() => assertAdminTargetEditableForRoleChange({ id: 't', role: 'ADMIN' }, 'other')),
    ).toBe('CANNOT_EDIT_ANOTHER_ADMIN')
  })
  it('blocks an ADMIN demoting themself', () => {
    expect(
      codeOf(() => assertAdminTargetEditableForRoleChange({ id: 't', role: 'ADMIN' }, 't')),
    ).toBe('ADMIN_CANNOT_CHANGE_OWN_ROLE')
  })
  it('allows a non-ADMIN target for any actor', () => {
    expect(() =>
      assertAdminTargetEditableForRoleChange({ id: 't', role: 'JUNIOR' }, 'other'),
    ).not.toThrow()
    expect(() =>
      assertAdminTargetEditableForRoleChange({ id: 't', role: 'JUNIOR' }, 't'),
    ).not.toThrow()
  })
})

describe('assertAdminTargetEditableForUpdate', () => {
  const admin = { id: 't', role: 'ADMIN' as Role }
  it('blocks another actor editing an ADMIN (regardless of requested role)', () => {
    expect(codeOf(() => assertAdminTargetEditableForUpdate(admin, undefined, 'other'))).toBe(
      'CANNOT_EDIT_ANOTHER_ADMIN',
    )
  })
  it('skips both checks for a null actor', () => {
    expect(() => assertAdminTargetEditableForUpdate(admin, 'JUNIOR', null)).not.toThrow()
  })
  it('blocks an ADMIN changing their own role away from ADMIN', () => {
    expect(codeOf(() => assertAdminTargetEditableForUpdate(admin, 'JUNIOR', 't'))).toBe(
      'ADMIN_CANNOT_CHANGE_OWN_ROLE',
    )
  })
  it('allows an ADMIN self-edit keeping ADMIN or omitting role', () => {
    expect(() => assertAdminTargetEditableForUpdate(admin, 'ADMIN', 't')).not.toThrow()
    expect(() => assertAdminTargetEditableForUpdate(admin, undefined, 't')).not.toThrow()
  })
  it('allows editing a non-ADMIN target', () => {
    const j = { id: 't', role: 'JUNIOR' as Role }
    expect(() => assertAdminTargetEditableForUpdate(j, 'SENIOR', 'other')).not.toThrow()
    expect(() => assertAdminTargetEditableForUpdate(j, 'SENIOR', 't')).not.toThrow()
  })
})

describe('assertSeniorRoleFloor', () => {
  it('refuses a SENIOR with no roles (null or []) with SENIOR_MIN_ROLES (400)', () => {
    for (const roles of [null, []]) {
      expect(codeOf(() => assertSeniorRoleFloor('SENIOR', roles))).toBe('SENIOR_MIN_ROLES')
    }
    expect(() => assertSeniorRoleFloor('SENIOR', [])).toThrow(
      expect.objectContaining({ status: 400 }),
    )
  })

  it('accepts a SENIOR with one role, whatever the stack', () => {
    expect(() => assertSeniorRoleFloor('SENIOR', ['BACKEND_ENGINEER'])).not.toThrow()
  })

  it('ignores every other role', () => {
    for (const role of ['ADMIN', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as Role[]) {
      expect(() => assertSeniorRoleFloor(role, null)).not.toThrow()
      expect(() => assertSeniorRoleFloor(role, [])).not.toThrow()
    }
  })
})

describe('assertSeniorOnlyRoles', () => {
  it.each<Role>(['ADMIN', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])(
    'refuses roles for a %s with 400 TECHNICAL_ROLES_SENIOR_ONLY',
    (role) => {
      expect(codeOf(() => assertSeniorOnlyRoles(role, ['BACKEND_ENGINEER']))).toBe(
        'TECHNICAL_ROLES_SENIOR_ONLY',
      )
      expect(() => assertSeniorOnlyRoles(role, ['BACKEND_ENGINEER'])).toThrow(
        expect.objectContaining({ status: 400 }),
      )
    },
  )

  it('lets a SENIOR set roles, and every role pass with absent or empty roles', () => {
    expect(() => assertSeniorOnlyRoles('SENIOR', ['BACKEND_ENGINEER'])).not.toThrow()
    expect(() => assertSeniorOnlyRoles('JUNIOR', undefined)).not.toThrow()
    expect(() => assertSeniorOnlyRoles('JUNIOR', [])).not.toThrow()
  })
})

describe('rolesChanged', () => {
  it('is false when absent or resubmitted in any order', () => {
    expect(rolesChanged(undefined, ['A'])).toBe(false)
    expect(rolesChanged(['B', 'A'], ['A', 'B'])).toBe(false)
    expect(rolesChanged(['A', 'B'], ['B', 'A'])).toBe(false)
    expect(rolesChanged([], [])).toBe(false)
  })

  it('is true on a difference in length or value', () => {
    expect(rolesChanged(['A'], ['A', 'B'])).toBe(true)
    expect(rolesChanged(['A', 'B'], ['A'])).toBe(true)
    expect(rolesChanged(['A', 'C'], ['A', 'B'])).toBe(true)
    expect(rolesChanged([], ['A'])).toBe(true)
  })
})
