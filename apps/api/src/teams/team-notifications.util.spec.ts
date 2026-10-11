import type { SessionUser } from '@crm/shared'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import type { TeamWithMembers } from './team-mapping.util'
import { buildTeamMemberAddedNotifications } from './team-notifications.util'

const PAST = new Date('2026-01-02T03:04:05.000Z')

function members(
  rows: Array<{ userId: string; role: string | null; leftAt?: Date | null }>,
): TeamWithMembers['members'] {
  return rows.map((r) => ({
    userId: r.userId,
    leftAt: r.leftAt ?? null,
    user: r.role === null ? null : { id: r.userId, role: r.role },
  })) as unknown as TeamWithMembers['members']
}

function build(over: {
  addedUserId?: string
  addedUserRole: string
  members: TeamWithMembers['members']
  currentUser?: Partial<SessionUser>
}) {
  return buildTeamMemberAddedNotifications({
    teamId: 'T',
    teamName: 'Team A',
    addedUserId: over.addedUserId ?? 'new',
    addedUserRole: over.addedUserRole,
    addedUserName: 'New Person',
    members: over.members,
    currentUser: { id: 'actor', role: 'ADMIN', ...over.currentUser } as SessionUser,
  })
}

const told = (out: ReturnType<typeof build>) =>
  out.filter((n) => n.type === 'TEAM_NEW_MEMBER').map((n) => n.userId)

describe('buildTeamMemberAddedNotifications', () => {
  it('notifies the added user and an existing member with exact payloads', () => {
    const out = build({
      addedUserRole: 'HR',
      members: members([{ userId: 'm1', role: 'SENIOR' }]),
    })
    expect(out).toEqual([
      {
        userId: 'new',
        type: 'TEAM_MEMBER_ADDED',
        title: NOTIFICATION_TITLES.TEAM_MEMBER_ADDED,
        subjectType: 'TEAM',
        subjectId: 'T',
        data: { teamName: 'Team A' },
      },
      {
        userId: 'm1',
        type: 'TEAM_NEW_MEMBER',
        title: NOTIFICATION_TITLES.TEAM_NEW_MEMBER,
        subjectType: 'TEAM',
        subjectId: 'T',
        secondaryId: 'new',
        data: { teamName: 'Team A', memberName: 'New Person' },
      },
    ])
  })

  it('does not notify the actor about their own action (added user == actor)', () => {
    const out = build({
      addedUserId: 'actor',
      addedUserRole: 'HR',
      members: members([{ userId: 'm1', role: 'HR' }]),
    })
    expect(out.map((n) => n.type)).toEqual(['TEAM_NEW_MEMBER'])
  })

  it('under impersonation the REAL operator is the actor', () => {
    const out = build({
      addedUserRole: 'HR',
      members: members([
        { userId: 'op', role: 'HR' },
        { userId: 'actor', role: 'HR' },
      ]),
      currentUser: { id: 'actor', impersonatorId: 'op' },
    })
    expect(told(out)).toEqual(['actor'])
  })

  it('skips soft-deleted members, the added user and the actor', () => {
    const out = build({
      addedUserRole: 'HR',
      members: members([
        { userId: 'gone', role: 'HR', leftAt: PAST },
        { userId: 'new', role: 'HR' },
        { userId: 'actor', role: 'HR' },
        { userId: 'keep', role: 'HR' },
      ]),
    })
    expect(told(out)).toEqual(['keep'])
  })

  it('a JUNIOR added: SENIOR and JUNIOR members are NOT told, others are', () => {
    const out = build({
      addedUserRole: 'JUNIOR',
      members: members([
        { userId: 's', role: 'SENIOR' },
        { userId: 'j', role: 'JUNIOR' },
        { userId: 'h', role: 'HR' },
        { userId: 'a', role: 'ADMIN' },
      ]),
    })
    expect(told(out)).toEqual(['h', 'a'])
  })

  it('a JUNIOR added: a member with a dangling user (role unknown) is treated as JUNIOR and skipped', () => {
    const out = build({
      addedUserRole: 'JUNIOR',
      members: members([{ userId: 'x', role: null }]),
    })
    expect(told(out)).toEqual([])
  })

  it('a non-JUNIOR added: SENIOR, JUNIOR and dangling-user members ARE told', () => {
    const out = build({
      addedUserRole: 'SENIOR',
      members: members([
        { userId: 's', role: 'SENIOR' },
        { userId: 'j', role: 'JUNIOR' },
        { userId: 'x', role: null },
      ]),
    })
    expect(told(out)).toEqual(['s', 'j', 'x'])
  })
})
