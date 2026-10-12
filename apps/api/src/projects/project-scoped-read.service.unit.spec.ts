/**
 * Unit tests — ProjectScopedReadService.getHrContact (moved out of ProjectsService).
 * The DB is a stub; expected values are hand-written literals.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectScopedReadService } from './project-scoped-read.service'

const NULLS = { displayName: null, telegram: null, phone: null, avatarUrl: null }

function user(role: SessionUser['role'], id = 'u-1'): SessionUser {
  return { id, role } as SessionUser
}

type Opts = {
  project?: unknown
  membership?: unknown
  hrRow?: unknown
  hrShares?: boolean
}

function makeSvc(o: Opts) {
  const hrSharesActiveTeamWith = vi.fn().mockResolvedValue(o.hrShares ?? false)
  const limit = vi.fn(() => ({
    then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(o.hrRow ? [o.hrRow] : [])),
  }))
  const db = {
    db: {
      query: {
        projects: { findFirst: () => Promise.resolve(o.project) },
        teamMembers: { findFirst: () => Promise.resolve(o.membership) },
      },
      select: () => ({
        from: () => ({ innerJoin: () => ({ where: () => ({ limit }) }) }),
      }),
    },
  }
  const svc = new ProjectScopedReadService(db as never, { hrSharesActiveTeamWith } as never)
  return { svc, hrSharesActiveTeamWith, limit }
}

const project = (over: Record<string, unknown> = {}) => ({
  id: 'p-1',
  seniorId: 's-1',
  members: [{ userId: 'j-1', leftAt: null }],
  ...over,
})

describe('getHrContact — access', () => {
  it('404 PROJECT_NOT_FOUND when the project is missing', async () => {
    const { svc } = makeSvc({ project: undefined })
    await expect(svc.getHrContact('p-1', user('ADMIN'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_NOT_FOUND', statusCode: 404 }),
    })
  })

  it.each(['SENIOR', 'ACCOUNTANT', 'DROP'] as const)('403 for %s', async (role) => {
    const { svc } = makeSvc({ project: project() })
    await expect(svc.getHrContact('p-1', user(role))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_HR_CONTACT_ACCESS', statusCode: 403 }),
    })
  })

  it('403 for a JUNIOR who is not a member', async () => {
    const { svc } = makeSvc({ project: project() })
    await expect(svc.getHrContact('p-1', user('JUNIOR', 'other'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_HR_CONTACT_ACCESS' }),
    })
  })

  it('403 for a JUNIOR who left the project', async () => {
    const { svc } = makeSvc({
      project: project({ members: [{ userId: 'j-1', leftAt: new Date() }] }),
    })
    await expect(svc.getHrContact('p-1', user('JUNIOR', 'j-1'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_HR_CONTACT_ACCESS' }),
    })
  })

  it('403 for an HR outside the senior team, and the check uses (hrId, seniorId)', async () => {
    const { svc, hrSharesActiveTeamWith } = makeSvc({ project: project(), hrShares: false })
    await expect(svc.getHrContact('p-1', user('HR', 'hr-1'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_HR_CONTACT_ACCESS' }),
    })
    expect(hrSharesActiveTeamWith).toHaveBeenCalledWith('hr-1', 's-1')
  })

  it('HR on a project without a senior is denied without consulting the team check', async () => {
    const { svc, hrSharesActiveTeamWith } = makeSvc({
      project: project({ seniorId: null }),
      hrShares: true,
    })
    await expect(svc.getHrContact('p-1', user('HR'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_HR_CONTACT_ACCESS' }),
    })
    expect(hrSharesActiveTeamWith).not.toHaveBeenCalled()
  })

  it('non-HR roles never hit the team check', async () => {
    const { svc, hrSharesActiveTeamWith } = makeSvc({ project: project(), membership: undefined })
    await svc.getHrContact('p-1', user('ADMIN'))
    expect(hrSharesActiveTeamWith).not.toHaveBeenCalled()
  })
})

describe('getHrContact — result', () => {
  it('ADMIN on a senior-less project gets all-null fields', async () => {
    const { svc } = makeSvc({ project: project({ seniorId: null }) })
    await expect(svc.getHrContact('p-1', user('ADMIN'))).resolves.toEqual(NULLS)
  })

  it('all-null when the senior has no active team membership', async () => {
    const { svc } = makeSvc({ project: project(), membership: undefined })
    await expect(svc.getHrContact('p-1', user('ADMIN'))).resolves.toEqual(NULLS)
  })

  it('all-null when the team has no HR', async () => {
    const { svc } = makeSvc({ project: project(), membership: { teamId: 't-1' }, hrRow: undefined })
    await expect(svc.getHrContact('p-1', user('ADMIN'))).resolves.toEqual(NULLS)
  })

  it('returns the HR allowlist for an active junior member', async () => {
    const { svc, limit } = makeSvc({
      project: project(),
      membership: { teamId: 't-1' },
      hrRow: { displayName: 'Hanna', telegram: '@hanna', phone: '+380', avatarUrl: 'a.png' },
    })
    await expect(svc.getHrContact('p-1', user('JUNIOR', 'j-1'))).resolves.toEqual({
      displayName: 'Hanna',
      telegram: '@hanna',
      phone: '+380',
      avatarUrl: 'a.png',
    })
    expect(limit).toHaveBeenCalledWith(1)
  })

  it('maps null columns of the HR row to null', async () => {
    const { svc } = makeSvc({
      project: project(),
      membership: { teamId: 't-1' },
      hrRow: { displayName: 'Hanna', telegram: null, phone: null, avatarUrl: null },
      hrShares: true,
    })
    await expect(svc.getHrContact('p-1', user('HR'))).resolves.toEqual({
      ...NULLS,
      displayName: 'Hanna',
    })
  })
})
