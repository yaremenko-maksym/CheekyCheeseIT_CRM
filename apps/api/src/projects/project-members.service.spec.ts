import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { compileWhere } from '../finance/__test-helpers__/drizzle-where-introspection'
import { ProjectMembersService } from './project-members.service'

const user = (role: SessionUser['role'], id = 'actor-1'): SessionUser => ({
  id,
  email: `${role}@test.spec`,
  displayName: role,
  avatarUrl: null,
  role,
  seniorSharePercent: 0,
  legalFullName: null,
  locale: 'en' as const,
})

function make(opts: { project?: unknown; target?: unknown; activeMember?: unknown } = {}) {
  const projectsFind = vi.fn().mockResolvedValue(opts.project)
  const usersFind = vi.fn().mockResolvedValue(opts.target)
  const membersFind = vi.fn().mockResolvedValue(opts.activeMember)
  const insertValues = vi.fn().mockResolvedValue(undefined)
  const tx = { insert: vi.fn().mockReturnValue({ values: insertValues }) }
  const whereUpdate = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where: whereUpdate })
  const db = {
    db: {
      query: {
        projects: { findFirst: projectsFind },
        users: { findFirst: usersFind },
        projectMembers: { findFirst: membersFind },
      },
      transaction: vi.fn(async (fn: (t: unknown) => Promise<void>) => fn(tx)),
      update: vi.fn().mockReturnValue({ set }),
    },
  }
  const access = { assertHrCanManageProject: vi.fn().mockResolvedValue(undefined) }
  const notifications = {
    emitInTx: vi.fn(async (_tx: unknown, fn: (s: unknown) => Promise<void>) => fn({})),
    createManyInTx: vi.fn().mockResolvedValue(undefined),
  }
  const svc = new ProjectMembersService(db as never, access as never, notifications as never)
  return { svc, access, notifications, insertValues, set, projectsFind, usersFind, membersFind }
}

const project = { id: 'p1', seniorId: 'sen-1', companyName: 'Acme', members: [] }

describe('ProjectMembersService authorization gate', () => {
  it.each(['SENIOR', 'JUNIOR', 'ACCOUNTANT'] as const)(
    'rejects %s before any db read (add + remove)',
    async (role) => {
      const h = make({ project })
      await expect(h.svc.addMember('p1', 'u1', user(role))).rejects.toMatchObject({ status: 403 })
      await expect(h.svc.removeMember('p1', 'u1', user(role))).rejects.toMatchObject({
        status: 403,
      })
      expect(h.projectsFind).not.toHaveBeenCalled()
    },
  )

  it('HR scope check runs with the project seniorId before the user lookup', async () => {
    const h = make({ project })
    h.access.assertHrCanManageProject.mockRejectedValue(new Error('SCOPE'))
    const hr = user('HR')
    await expect(h.svc.addMember('p1', 'u1', hr)).rejects.toThrow('SCOPE')
    expect(h.access.assertHrCanManageProject).toHaveBeenCalledWith('sen-1', hr)
    expect(h.usersFind).not.toHaveBeenCalled()
    await expect(h.svc.removeMember('p1', 'u1', hr)).rejects.toThrow('SCOPE')
  })
})

describe('ProjectMembersService.addMember', () => {
  it('404s on missing project / user', async () => {
    await expect(make().svc.addMember('p1', 'u1', user('ADMIN'))).rejects.toMatchObject({
      status: 404,
    })
    await expect(make({ project }).svc.addMember('p1', 'u1', user('ADMIN'))).rejects.toMatchObject({
      status: 404,
    })
  })

  it('inserts the membership and notifies the added user', async () => {
    const h = make({ project, target: { id: 'u1', role: 'HR', archivedAt: null } })
    await h.svc.addMember('p1', 'u1', user('ADMIN'))
    expect(h.insertValues).toHaveBeenCalledWith({ projectId: 'p1', userId: 'u1' })
    expect(h.notifications.createManyInTx).toHaveBeenCalledWith({}, [
      expect.objectContaining({
        userId: 'u1',
        type: 'PROJECT_MEMBER_ADDED',
        subjectType: 'PROJECT',
        subjectId: 'p1',
        data: { projectName: 'Acme' },
      }),
    ])
  })

  it('does not notify when the actor adds themself (impersonator id wins)', async () => {
    const h = make({ project, target: { id: 'u1', role: 'HR', archivedAt: null } })
    await h.svc.addMember('p1', 'u1', { ...user('ADMIN', 'someone'), impersonatorId: 'u1' })
    expect(h.notifications.createManyInTx).toHaveBeenCalledWith({}, [])
    await h.svc.addMember('p1', 'u1', user('ADMIN', 'u1'))
    expect(h.notifications.createManyInTx).toHaveBeenLastCalledWith({}, [])
  })
})

describe('ProjectMembersService.removeMember', () => {
  it('404s when project missing or member not active', async () => {
    await expect(make().svc.removeMember('p1', 'u1', user('ADMIN'))).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      make({ project }).svc.removeMember('p1', 'u1', user('ADMIN')),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('stamps leftAt on the active membership row', async () => {
    const h = make({
      project,
      activeMember: { id: 'm1' },
      target: { id: 'u1', role: 'JUNIOR' },
    })
    await h.svc.removeMember('p1', 'u1', user('ADMIN'))
    expect(h.set).toHaveBeenCalledWith({ leftAt: expect.any(Date) })
  })
})

const whereOf = (fn: ReturnType<typeof vi.fn>, call: number) =>
  compileWhere((fn.mock.calls[call]?.[0] as { where: unknown }).where)

describe('ProjectMembersService lookups are scoped', () => {
  it('addMember scopes the user and duplicate lookups by id', async () => {
    const h = make({ project, target: { id: 'u1', role: 'HR', archivedAt: null } })
    await h.svc.addMember('p1', 'u1', user('ADMIN'))
    expect(whereOf(h.usersFind, 0).params).toEqual(['u1'])
    expect(whereOf(h.membersFind, 0).params).toEqual(expect.arrayContaining(['p1', 'u1']))
    expect(whereOf(h.membersFind, 0).sql).toMatch(/left_at.*is null/i)
  })

  it('removeMember scopes the member and user lookups by id', async () => {
    const h = make({
      project,
      activeMember: { id: 'm1' },
      target: { id: 'u1', role: 'JUNIOR' },
    })
    await h.svc.removeMember('p1', 'u1', user('ADMIN'))
    expect(whereOf(h.membersFind, 0).params).toEqual(expect.arrayContaining(['p1', 'u1']))
    expect(whereOf(h.membersFind, 0).sql).toMatch(/left_at.*is null/i)
    expect(whereOf(h.usersFind, 0).params).toEqual(['u1'])
  })
})

describe('ProjectMembersService.addMember membership rules', () => {
  const junior = { id: 'u1', role: 'JUNIOR', archivedAt: null }

  it('rejects a duplicate active membership', async () => {
    const h = make({ project, target: junior, activeMember: { id: 'm0' } })
    await expect(h.svc.addMember('p1', 'u1', user('ADMIN'))).rejects.toMatchObject({
      status: 400,
    })
    expect(h.insertValues).not.toHaveBeenCalled()
  })

  it('rejects a JUNIOR active on another project, scoping that lookup by user', async () => {
    const h = make({ project, target: junior })
    h.membersFind.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'other' })
    await expect(h.svc.addMember('p1', 'u1', user('ADMIN'))).rejects.toMatchObject({
      status: 400,
    })
    expect(h.membersFind).toHaveBeenCalledTimes(2)
    expect(whereOf(h.membersFind, 1).params).toEqual(['u1'])
    expect(whereOf(h.membersFind, 1).sql).toMatch(/left_at.*is null/i)
    expect(h.insertValues).not.toHaveBeenCalled()
  })

  it('adds a free JUNIOR', async () => {
    const h = make({ project, target: junior })
    await h.svc.addMember('p1', 'u1', user('ADMIN'))
    expect(h.membersFind).toHaveBeenCalledTimes(2)
    expect(h.insertValues).toHaveBeenCalled()
  })

  it('rejects a second JUNIOR on the project', async () => {
    const full = {
      ...project,
      members: [{ leftAt: null, user: { role: 'JUNIOR' } }],
    }
    const h = make({ project: full, target: junior })
    await expect(h.svc.addMember('p1', 'u1', user('ADMIN'))).rejects.toMatchObject({
      status: 400,
    })
    expect(h.membersFind).toHaveBeenCalledTimes(1)
  })

  it('does not apply the JUNIOR-only checks to HR', async () => {
    const full = {
      ...project,
      members: [{ leftAt: null, user: { role: 'JUNIOR' } }],
    }
    const h = make({ project: full, target: { id: 'u1', role: 'HR', archivedAt: null } })
    await h.svc.addMember('p1', 'u1', user('ADMIN'))
    expect(h.membersFind).toHaveBeenCalledTimes(1)
    expect(h.insertValues).toHaveBeenCalled()
  })
})
