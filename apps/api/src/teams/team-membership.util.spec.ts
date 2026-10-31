import { ForbiddenException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { teamMembers } from '../database/schema'
import { markSeniorDirty } from '../job-sourcing/dirty-producers'
import { addTeamMember, removeTeamMember, type TeamMembershipDeps } from './team-membership.util'
// r5 4.6 S5: the roster dirty producers are proven in job-sourcing; here they are inert.
vi.mock('../job-sourcing/dirty-producers')

const dialect = new PgDialect()
const render = (cond: SQL) => dialect.sqlToQuery(cond)

const admin = { id: 'admin-1', role: 'ADMIN' } as unknown as SessionUser
const hr = { id: 'hr-1', role: 'HR' } as unknown as SessionUser
const senior = { id: 'sen-1', role: 'SENIOR' } as unknown as SessionUser
const WITH = { members: { with: { user: true } } }

interface M {
  userId: string
  role: string | null
  leftAt?: Date | null
  id?: string
}
const LEFT = new Date('2026-01-02T03:04:05.000Z')

function team(rows: M[], name = 'Team A') {
  return {
    id: 'T1',
    name,
    members: rows.map((r) => ({
      id: r.id ?? `row-${r.userId}`,
      userId: r.userId,
      leftAt: r.leftAt ?? null,
      user: r.role === null ? null : { id: r.userId, role: r.role },
    })),
  }
}

function makeDeps(opts: {
  team?: unknown
  user?: unknown
  existing?: unknown
  projects?: unknown[]
}) {
  const teamsFind = vi.fn().mockResolvedValue(opts.team)
  const usersFind = vi.fn().mockResolvedValue(opts.user)
  const membersFind = vi.fn().mockResolvedValue(opts.existing)
  const updates: Array<{ table: unknown; set: unknown; where: SQL }> = []
  const inserts: Array<{ table: unknown; values: unknown }> = []
  const tx = {
    marker: 'tx',
    update: (table: unknown) => ({
      set: (set: unknown) => ({
        where: async (where: SQL) => {
          updates.push({ table, set, where })
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        inserts.push({ table, values })
      },
    }),
  }
  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))
  const sp = { marker: 'sp' }
  const emitInTx = vi.fn(async (_tx: unknown, cb: (s: unknown) => Promise<void>) => cb(sp))
  const createManyInTx = vi.fn().mockResolvedValue(undefined)
  const record = vi.fn().mockResolvedValue(undefined)
  const fetchAllProjects = vi.fn().mockResolvedValue(opts.projects ?? [])
  const deps = {
    db: {
      query: {
        teams: { findFirst: teamsFind },
        users: { findFirst: usersFind },
        teamMembers: { findFirst: membersFind },
      },
      transaction,
    },
    teamAuditLogService: { record },
    notifications: { emitInTx, createManyInTx },
    fetchAllProjects,
  } as unknown as TeamMembershipDeps
  return {
    deps,
    teamsFind,
    usersFind,
    membersFind,
    updates,
    inserts,
    transaction,
    tx,
    sp,
    emitInTx,
    createManyInTx,
    record,
    fetchAllProjects,
  }
}

const refusal = (status: number, code: string) => ({ status, response: { code } })

describe('addTeamMember', () => {
  it('rejects a non-ADMIN/HR caller before touching the db', async () => {
    const m = makeDeps({})
    await expect(addTeamMember(m.deps, 'T1', 'u1', senior)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(m.teamsFind).not.toHaveBeenCalled()
  })

  it('404 TEAM_NOT_FOUND, looking the team up by id with members+user', async () => {
    const m = makeDeps({ team: undefined })
    await expect(addTeamMember(m.deps, 'T-X', 'u1', admin)).rejects.toMatchObject(
      refusal(404, 'TEAM_NOT_FOUND'),
    )
    const arg = m.teamsFind.mock.calls[0]![0] as { where: SQL; with: unknown }
    const q = render(arg.where)
    expect(q.sql).toBe('"teams"."id" = $1')
    expect(q.params).toEqual(['T-X'])
    expect(arg.with).toEqual(WITH)
  })

  it('403 for an HR who is not an active HR of the team (removed HR cannot re-add self)', async () => {
    const m = makeDeps({
      team: team([{ userId: 'hr-1', role: 'HR', leftAt: LEFT }]),
      user: { role: 'JUNIOR' },
    })
    await expect(addTeamMember(m.deps, 'T1', 'u1', hr)).rejects.toBeInstanceOf(ForbiddenException)
    expect(m.usersFind).not.toHaveBeenCalled()
  })

  it('404 USER_NOT_FOUND, looking the user up by id', async () => {
    const m = makeDeps({ team: team([{ userId: 'hr-1', role: 'HR' }]), user: undefined })
    await expect(addTeamMember(m.deps, 'T1', 'u-X', hr)).rejects.toMatchObject(
      refusal(404, 'USER_NOT_FOUND'),
    )
    const q = render((m.usersFind.mock.calls[0]![0] as { where: SQL }).where)
    expect(q.sql).toBe('"users"."id" = $1')
    expect(q.params).toEqual(['u-X'])
  })

  it('400 TEAM_ADMIN_CANNOT_BE_MEMBER', async () => {
    const m = makeDeps({ team: team([]), user: { role: 'ADMIN' } })
    await expect(addTeamMember(m.deps, 'T1', 'u1', admin)).rejects.toMatchObject(
      refusal(400, 'TEAM_ADMIN_CANNOT_BE_MEMBER'),
    )
  })

  it('403 TEAM_ADD_SENIOR_ADMIN_ONLY when HR adds a SENIOR', async () => {
    const m = makeDeps({
      team: team([{ userId: 'hr-1', role: 'HR' }]),
      user: { role: 'SENIOR' },
    })
    await expect(addTeamMember(m.deps, 'T1', 'u1', hr)).rejects.toMatchObject(
      refusal(403, 'TEAM_ADD_SENIOR_ADMIN_ONLY'),
    )
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('400 TEAM_ALREADY_HAS_SENIOR when an ACTIVE senior exists (user-less rows tolerated)', async () => {
    const m = makeDeps({
      team: team([
        { userId: 'ghost', role: null },
        { userId: 's0', role: 'SENIOR' },
      ]),
      user: { role: 'SENIOR' },
    })
    await expect(addTeamMember(m.deps, 'T1', 'u1', admin)).rejects.toMatchObject(
      refusal(400, 'TEAM_ALREADY_HAS_SENIOR'),
    )
  })

  it('a rotated-out (left) senior does not block adding a new senior', async () => {
    const m = makeDeps({
      team: team([{ userId: 's0', role: 'SENIOR', leftAt: LEFT }]),
      user: { role: 'SENIOR', displayName: 'New S' },
    })
    await addTeamMember(m.deps, 'T1', 'u1', admin)
    expect(m.inserts).toHaveLength(1)
  })

  it('a non-SENIOR add is not blocked by an existing senior', async () => {
    const m = makeDeps({
      team: team([{ userId: 's0', role: 'SENIOR' }]),
      user: { role: 'HR', displayName: 'H' },
    })
    await addTeamMember(m.deps, 'T1', 'u1', admin)
    expect(m.inserts).toHaveLength(1)
  })

  it('400 JUNIOR_ALREADY_ON_ANOTHER_PROJECT when the junior has an active project row', async () => {
    const m = makeDeps({
      team: team([]),
      user: { role: 'JUNIOR' },
      projects: [
        { members: [{ userId: 'other', leftAt: null }] },
        {
          members: [
            { userId: 'u1', leftAt: LEFT },
            { userId: 'u1', leftAt: null },
          ],
        },
      ],
    })
    await expect(addTeamMember(m.deps, 'T1', 'u1', admin)).rejects.toMatchObject(
      refusal(400, 'JUNIOR_ALREADY_ON_ANOTHER_PROJECT'),
    )
  })

  it('a junior whose only project rows are left, or belong to someone else, may be added', async () => {
    const m = makeDeps({
      team: team([]),
      user: { role: 'JUNIOR', displayName: 'J' },
      projects: [
        { members: [{ userId: 'u1', leftAt: LEFT }] },
        { members: [{ userId: 'other', leftAt: null }] },
        { members: [] },
      ],
    })
    await addTeamMember(m.deps, 'T1', 'u1', admin)
    expect(m.fetchAllProjects).toHaveBeenCalledTimes(1)
    expect(m.inserts).toHaveLength(1)
  })

  it('does not load projects for a non-JUNIOR user', async () => {
    const m = makeDeps({ team: team([]), user: { role: 'ACCOUNTANT', displayName: 'A' } })
    await addTeamMember(m.deps, 'T1', 'u1', admin)
    expect(m.fetchAllProjects).not.toHaveBeenCalled()
  })

  it('400 TEAM_USER_ALREADY_MEMBER for an ACTIVE duplicate, looked up by team+user', async () => {
    const m = makeDeps({
      team: team([]),
      user: { role: 'HR' },
      existing: { id: 'r1', leftAt: null },
    })
    await expect(addTeamMember(m.deps, 'T-1', 'u-2', admin)).rejects.toMatchObject(
      refusal(400, 'TEAM_USER_ALREADY_MEMBER'),
    )
    const q = render((m.membersFind.mock.calls[0]![0] as { where: SQL }).where)
    expect(q.sql).toBe('("team_members"."team_id" = $1 and "team_members"."user_id" = $2)')
    expect(q.params).toEqual(['T-1', 'u-2'])
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('reactivates a soft-deleted row (leftAt -> null) in a transaction with the notification, no insert', async () => {
    const m = makeDeps({
      team: team([{ userId: 'x', role: 'HR' }], 'Alpha'),
      user: { role: 'HR', displayName: 'Back Again' },
      existing: { id: 'row-9', leftAt: LEFT },
    })
    await expect(addTeamMember(m.deps, 'T1', 'u1', admin)).resolves.toBeUndefined()
    expect(m.inserts).toHaveLength(0)
    expect(m.updates).toHaveLength(1)
    expect(m.updates[0]!.table).toBe(teamMembers)
    expect(m.updates[0]!.set).toEqual({ leftAt: null })
    const q = render(m.updates[0]!.where)
    expect(q.sql).toBe('"team_members"."id" = $1')
    expect(q.params).toEqual(['row-9'])
    // r5 4.6 S5: the reactivation marks the roster dirty on the same transaction handle.
    expect(vi.mocked(markSeniorDirty).mock.calls.at(-1)).toEqual([m.tx, 'u1', 'senior.team'])
    expect(m.emitInTx).toHaveBeenCalledTimes(1)
    expect(m.emitInTx.mock.calls[0]![0]).toBe(m.tx)
    expect(m.createManyInTx).toHaveBeenCalledTimes(1)
    expect(m.createManyInTx.mock.calls[0]![0]).toBe(m.sp)
    expect(m.createManyInTx.mock.calls[0]![1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'TEAM_MEMBER_ADDED' })]),
    )
  })

  it('inserts a fresh membership row inside the same transaction as the notification', async () => {
    const m = makeDeps({
      team: team([]),
      user: { role: 'HR', displayName: 'Newbie' },
      existing: undefined,
    })
    await addTeamMember(m.deps, 'T9', 'u7', admin)
    expect(m.transaction).toHaveBeenCalledTimes(1)
    expect(m.updates).toHaveLength(0)
    expect(m.inserts).toEqual([{ table: teamMembers, values: { teamId: 'T9', userId: 'u7' } }])
    expect(m.emitInTx.mock.calls[0]![0]).toBe(m.tx)
    // r5 4.6 S5: the roster dirty row is enqueued on the SAME transaction handle as the insert.
    expect(vi.mocked(markSeniorDirty).mock.calls.at(-1)).toEqual([m.tx, 'u7', 'senior.team'])
  })
})

describe('removeTeamMember', () => {
  it('rejects a non-ADMIN/HR caller before touching the db', async () => {
    const m = makeDeps({})
    await expect(removeTeamMember(m.deps, 'T1', 'u1', senior)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(m.teamsFind).not.toHaveBeenCalled()
  })

  it('404 TEAM_NOT_FOUND, looking the team up by id with members+user', async () => {
    const m = makeDeps({ team: undefined })
    await expect(removeTeamMember(m.deps, 'T-X', 'u1', admin)).rejects.toMatchObject(
      refusal(404, 'TEAM_NOT_FOUND'),
    )
    const arg = m.teamsFind.mock.calls[0]![0] as { where: SQL; with: unknown }
    const q = render(arg.where)
    expect(q.sql).toBe('"teams"."id" = $1')
    expect(q.params).toEqual(['T-X'])
    expect(arg.with).toEqual(WITH)
  })

  it('403 for an HR who is not an active HR of the team', async () => {
    const m = makeDeps({ team: team([{ userId: 'jr', role: 'JUNIOR' }]) })
    await expect(removeTeamMember(m.deps, 'T1', 'jr', hr)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('404 TEAM_MEMBER_NOT_FOUND for a non-member and for an already-removed member', async () => {
    const m = makeDeps({ team: team([{ userId: 'gone', role: 'JUNIOR', leftAt: LEFT }]) })
    await expect(removeTeamMember(m.deps, 'T1', 'gone', admin)).rejects.toMatchObject(
      refusal(404, 'TEAM_MEMBER_NOT_FOUND'),
    )
    await expect(removeTeamMember(m.deps, 'T1', 'nobody', admin)).rejects.toMatchObject(
      refusal(404, 'TEAM_MEMBER_NOT_FOUND'),
    )
  })

  it('400 TEAM_CANNOT_REMOVE_SENIOR', async () => {
    const m = makeDeps({ team: team([{ userId: 's0', role: 'SENIOR' }]) })
    await expect(removeTeamMember(m.deps, 'T1', 's0', admin)).rejects.toMatchObject(
      refusal(400, 'TEAM_CANNOT_REMOVE_SENIOR'),
    )
  })

  it('400 HR_REQUIRED_MINIMUM_ONE when the last ACTIVE HR is removed (other roles / left HRs do not count)', async () => {
    const m = makeDeps({
      team: team([
        { userId: 'h1', role: 'HR' },
        { userId: 'h-left', role: 'HR', leftAt: LEFT },
        { userId: 'a1', role: 'ACCOUNTANT' },
        { userId: 'j1', role: 'JUNIOR' },
        { userId: 'ghost', role: null },
      ]),
    })
    await expect(removeTeamMember(m.deps, 'T1', 'h1', admin)).rejects.toMatchObject(
      refusal(400, 'HR_REQUIRED_MINIMUM_ONE'),
    )
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('removes an HR when a second ACTIVE HR remains (user-less rows tolerated)', async () => {
    const m = makeDeps({
      team: team([
        { userId: 'h1', role: 'HR' },
        { userId: 'h2', role: 'HR' },
        { userId: 'ghost', role: null },
      ]),
    })
    await removeTeamMember(m.deps, 'T1', 'h1', admin)
    expect(m.updates).toHaveLength(1)
  })

  it('400 TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE when the last ACTIVE accountant is removed (other roles / left accountants do not count)', async () => {
    const m = makeDeps({
      team: team([
        { userId: 'a1', role: 'ACCOUNTANT' },
        { userId: 'a-left', role: 'ACCOUNTANT', leftAt: LEFT },
        { userId: 'h1', role: 'HR' },
        { userId: 'h2', role: 'HR' },
        { userId: 'ghost', role: null },
      ]),
    })
    await expect(removeTeamMember(m.deps, 'T1', 'a1', admin)).rejects.toMatchObject(
      refusal(400, 'TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE'),
    )
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('removes an accountant when a second ACTIVE accountant remains (user-less rows tolerated)', async () => {
    const m = makeDeps({
      team: team([
        { userId: 'a1', role: 'ACCOUNTANT' },
        { userId: 'a2', role: 'ACCOUNTANT' },
        { userId: 'ghost', role: null },
      ]),
    })
    await removeTeamMember(m.deps, 'T1', 'a1', admin)
    expect(m.updates).toHaveLength(1)
  })

  it('soft-deletes the active row and writes the audit row in the SAME tx (real operator under impersonation)', async () => {
    const m = makeDeps({
      team: team([
        { userId: 'h1', role: 'HR' },
        { userId: 'j1', role: 'JUNIOR' },
      ]),
    })
    const impersonated = {
      id: 'imp-as',
      role: 'ADMIN',
      impersonatorId: 'real-op',
    } as unknown as SessionUser
    await removeTeamMember(m.deps, 'T-5', 'j1', impersonated)

    expect(m.updates).toHaveLength(1)
    expect(m.updates[0]!.table).toBe(teamMembers)
    const set = m.updates[0]!.set as { leftAt: Date }
    expect(Object.keys(set)).toEqual(['leftAt'])
    expect(set.leftAt).toBeInstanceOf(Date)
    const q = render(m.updates[0]!.where)
    expect(q.sql).toBe(
      '("team_members"."team_id" = $1 and "team_members"."user_id" = $2 and "team_members"."left_at" is null)',
    )
    expect(q.params).toEqual(['T-5', 'j1'])

    expect(m.record).toHaveBeenCalledTimes(1)
    expect(m.record.mock.calls[0]![0]).toEqual({
      actorId: 'real-op',
      targetId: 'T-5',
      action: 'team_member_removed',
      changes: {
        userId: { before: 'j1', after: null },
        role: { before: 'JUNIOR', after: null },
      },
    })
    expect(m.record.mock.calls[0]![1]).toBe(m.tx)
  })

  it('audit role is null for a member row with no joined user; actor is the caller when not impersonating', async () => {
    const m = makeDeps({ team: team([{ userId: 'ghost', role: null }]) })
    await removeTeamMember(m.deps, 'T1', 'ghost', admin)
    expect(m.record.mock.calls[0]![0]).toEqual({
      actorId: 'admin-1',
      targetId: 'T1',
      action: 'team_member_removed',
      changes: {
        userId: { before: 'ghost', after: null },
        role: { before: null, after: null },
      },
    })
  })
})
