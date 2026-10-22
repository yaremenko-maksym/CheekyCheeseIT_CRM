import { describe, expect, it } from 'vitest'
import type { User } from '../database/schema'
import {
  assertAdminTargetEditableForRoleChange,
  assertAdminTargetEditableForUpdate,
  assertAssignableRole,
  assertAssignableRoleOnChange,
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
