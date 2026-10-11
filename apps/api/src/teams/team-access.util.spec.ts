import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { assertAccess, isHrOfTeam } from './team-access.util'
import type { ProjectWithMembers, TeamWithMembers } from './team-mapping.util'

const PAST = new Date('2026-01-02T03:04:05.000Z')

type M = { userId: string; role: string | null; leftAt: Date | null }

function team(members: M[]): TeamWithMembers {
  return {
    id: 't1',
    members: members.map((m) => ({
      userId: m.userId,
      leftAt: m.leftAt,
      user: m.role === null ? null : { id: m.userId, role: m.role },
    })),
  } as unknown as TeamWithMembers
}

function project(seniorId: string, members: Array<{ userId: string; leftAt: Date | null }>) {
  return { seniorId, members } as unknown as ProjectWithMembers
}

function actor(id: string, role: string): SessionUser {
  return { id, role } as unknown as SessionUser
}

describe('isHrOfTeam', () => {
  it('true for an ACTIVE HR member', () => {
    expect(isHrOfTeam(team([{ userId: 'u1', role: 'HR', leftAt: null }]), 'u1')).toBe(true)
  })
  it('false when the HR membership is soft-deleted (leftAt set)', () => {
    expect(isHrOfTeam(team([{ userId: 'u1', role: 'HR', leftAt: PAST }]), 'u1')).toBe(false)
  })
  it('false when the member is not HR', () => {
    expect(isHrOfTeam(team([{ userId: 'u1', role: 'SENIOR', leftAt: null }]), 'u1')).toBe(false)
  })
  it('false for a different user id', () => {
    expect(isHrOfTeam(team([{ userId: 'u1', role: 'HR', leftAt: null }]), 'u2')).toBe(false)
  })
  it('false when the user relation is dangling (null)', () => {
    expect(isHrOfTeam(team([{ userId: 'u1', role: null, leftAt: null }]), 'u1')).toBe(false)
  })
})

describe('assertAccess', () => {
  const senior: M = { userId: 's1', role: 'SENIOR', leftAt: null }

  it.each(['ADMIN', 'ACCOUNTANT'])('%s passes without membership', (role) => {
    expect(assertAccess(team([]), actor('x', role), [])).toBeUndefined()
  })

  it('DROP: active member passes', () => {
    const t = team([{ userId: 'd1', role: 'DROP', leftAt: null }])
    expect(assertAccess(t, actor('d1', 'DROP'), [])).toBeUndefined()
  })
  it('DROP: former member (leftAt set) is forbidden', () => {
    const t = team([{ userId: 'd1', role: 'DROP', leftAt: PAST }])
    expect(() => assertAccess(t, actor('d1', 'DROP'), [])).toThrow(ForbiddenException)
  })
  it('DROP: foreign team is forbidden', () => {
    expect(() => assertAccess(team([senior]), actor('d1', 'DROP'), [])).toThrow(ForbiddenException)
  })
  it('DROP is never granted access via the JUNIOR project derivation', () => {
    const p = project('s1', [{ userId: 'd1', leftAt: null }])
    expect(() => assertAccess(team([senior]), actor('d1', 'DROP'), [p])).toThrow(ForbiddenException)
  })

  it('active member of any role passes', () => {
    const t = team([{ userId: 'h1', role: 'HR', leftAt: null }])
    expect(assertAccess(t, actor('h1', 'HR'), [])).toBeUndefined()
  })
  it('soft-deleted member is forbidden', () => {
    const t = team([{ userId: 'h1', role: 'HR', leftAt: PAST }])
    expect(() => assertAccess(t, actor('h1', 'HR'), [])).toThrow(ForbiddenException)
  })
  it('non-member non-JUNIOR is forbidden', () => {
    expect(() => assertAccess(team([senior]), actor('x', 'SENIOR'), [])).toThrow(ForbiddenException)
  })

  it('JUNIOR with an active project under the team senior passes', () => {
    const p = project('s1', [{ userId: 'j1', leftAt: null }])
    expect(assertAccess(team([senior]), actor('j1', 'JUNIOR'), [p])).toBeUndefined()
  })
  it('JUNIOR whose project membership has ended is forbidden', () => {
    const p = project('s1', [{ userId: 'j1', leftAt: PAST }])
    expect(() => assertAccess(team([senior]), actor('j1', 'JUNIOR'), [p])).toThrow(
      ForbiddenException,
    )
  })
  it('JUNIOR with a project under a DIFFERENT senior is forbidden', () => {
    const p = project('s2', [{ userId: 'j1', leftAt: null }])
    expect(() => assertAccess(team([senior]), actor('j1', 'JUNIOR'), [p])).toThrow(
      ForbiddenException,
    )
  })
  it('JUNIOR: a rotated-out senior (leftAt set) does not seed the lookup', () => {
    const t = team([{ userId: 's1', role: 'SENIOR', leftAt: PAST }])
    const p = project('s1', [{ userId: 'j1', leftAt: null }])
    expect(() => assertAccess(t, actor('j1', 'JUNIOR'), [p])).toThrow(ForbiddenException)
  })
  it('JUNIOR: the active senior is used even when a rotated-out senior is listed first', () => {
    const t = team([
      { userId: 's0', role: 'SENIOR', leftAt: PAST },
      { userId: 's1', role: 'SENIOR', leftAt: null },
    ])
    const p = project('s1', [{ userId: 'j1', leftAt: null }])
    expect(assertAccess(t, actor('j1', 'JUNIOR'), [p])).toBeUndefined()
  })
  it('JUNIOR on a team with no senior is forbidden', () => {
    const p = project('s1', [{ userId: 'j1', leftAt: null }])
    expect(() => assertAccess(team([]), actor('j1', 'JUNIOR'), [p])).toThrow(ForbiddenException)
  })
})
