/**
 * Unit tests — project-members.util (leaf P-L5 of the projects.service decomposition).
 *
 * Pure membership validations. Expected codes are hand-written literals.
 */
import { describe, expect, it } from 'vitest'
import {
  assertCanAddMember,
  assertCanRemoveMember,
  assertNoActiveJunior,
  type MemberRowSlice,
} from './project-members.util'

const D = new Date('2026-01-02T03:04:05.000Z')

function codeOf(fn: () => void): { code: unknown; status: number } | null {
  try {
    fn()
    return null
  } catch (e) {
    const err = e as { getStatus: () => number; getResponse: () => { code?: unknown } }
    return { code: err.getResponse().code, status: err.getStatus() }
  }
}

describe('assertCanAddMember', () => {
  it.each(['JUNIOR', 'HR', 'ACCOUNTANT'])('allows active %s', (role) => {
    expect(codeOf(() => assertCanAddMember({ archivedAt: null, role }))).toBeNull()
  })

  it.each(['ADMIN', 'SENIOR'])('rejects role %s', (role) => {
    expect(codeOf(() => assertCanAddMember({ archivedAt: null, role }))).toEqual({
      code: 'PROJECT_MEMBER_ROLE_RESTRICTED',
      status: 400,
    })
  })

  it('rejects archived user', () => {
    expect(codeOf(() => assertCanAddMember({ archivedAt: D, role: 'JUNIOR' }))).toEqual({
      code: 'ARCHIVED_USER_CANNOT_JOIN_PROJECT',
      status: 400,
    })
  })

  it('archived check wins over a restricted role', () => {
    expect(codeOf(() => assertCanAddMember({ archivedAt: D, role: 'ADMIN' }))?.code).toBe(
      'ARCHIVED_USER_CANNOT_JOIN_PROJECT',
    )
  })
})

describe('assertNoActiveJunior', () => {
  it('passes for empty members', () => {
    expect(codeOf(() => assertNoActiveJunior([]))).toBeNull()
  })

  it('passes when the only junior has left', () => {
    const m: MemberRowSlice[] = [{ leftAt: D, user: { role: 'JUNIOR' } }]
    expect(codeOf(() => assertNoActiveJunior(m))).toBeNull()
  })

  it('passes when active members are not juniors / user missing', () => {
    const m: MemberRowSlice[] = [
      { leftAt: null, user: { role: 'HR' } },
      { leftAt: null, user: null },
      { leftAt: null },
    ]
    expect(codeOf(() => assertNoActiveJunior(m))).toBeNull()
  })

  it('rejects an active junior', () => {
    const m: MemberRowSlice[] = [{ leftAt: null, user: { role: 'JUNIOR' } }]
    expect(codeOf(() => assertNoActiveJunior(m))).toEqual({
      code: 'PROJECT_HAS_ACTIVE_JUNIOR',
      status: 400,
    })
  })
})

describe('assertCanRemoveMember', () => {
  const hr = (leftAt: Date | null): MemberRowSlice => ({ leftAt, user: { role: 'HR' } })
  const acc = (leftAt: Date | null): MemberRowSlice => ({ leftAt, user: { role: 'ACCOUNTANT' } })

  it('rejects removing the last active HR', () => {
    expect(codeOf(() => assertCanRemoveMember({ role: 'HR' }, [hr(null), hr(D)]))).toEqual({
      code: 'CANNOT_REMOVE_LAST_ROLE_MEMBER',
      status: 400,
    })
  })

  it('rejects removing the last active ACCOUNTANT', () => {
    expect(codeOf(() => assertCanRemoveMember({ role: 'ACCOUNTANT' }, [acc(null)]))?.code).toBe(
      'CANNOT_REMOVE_LAST_ROLE_MEMBER',
    )
  })

  it('allows removal when a second active of the same role exists', () => {
    expect(codeOf(() => assertCanRemoveMember({ role: 'HR' }, [hr(null), hr(null)]))).toBeNull()
  })

  it('counts only the same role (other-role actives do not rescue)', () => {
    expect(
      codeOf(() => assertCanRemoveMember({ role: 'HR' }, [hr(null), acc(null), acc(null)]))?.code,
    ).toBe('CANNOT_REMOVE_LAST_ROLE_MEMBER')
  })

  it('does not guard JUNIOR or an unknown user', () => {
    const m = [{ leftAt: null, user: { role: 'JUNIOR' } }]
    expect(codeOf(() => assertCanRemoveMember({ role: 'JUNIOR' }, m))).toBeNull()
    expect(codeOf(() => assertCanRemoveMember(undefined, []))).toBeNull()
  })
})
