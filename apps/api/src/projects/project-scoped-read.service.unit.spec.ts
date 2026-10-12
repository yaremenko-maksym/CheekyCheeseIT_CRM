/**
 * Unit tests — ProjectScopedReadService.getHrContact (moved out of ProjectsService).
 * The DB is a stub; expected values are hand-written literals.
 */
import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
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

const paramsOf = (where: unknown) =>
  new PgDialect().sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0]).params

function makeSvc(o: Opts) {
  const hrSharesActiveTeamWith = vi.fn().mockResolvedValue(o.hrShares ?? false)
  const limit = vi.fn(() => ({
    then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb(o.hrRow ? [o.hrRow] : [])),
  }))
  const selectCols: unknown[] = []
  const hrWhere: unknown[] = []
  const membershipArgs: unknown[] = []
  const db = {
    db: {
      query: {
        projects: { findFirst: () => Promise.resolve(o.project) },
        teamMembers: {
          findFirst: (arg: unknown) => {
            membershipArgs.push(arg)
            return Promise.resolve(o.membership)
          },
        },
      },
      select: (cols: unknown) => {
        selectCols.push(cols)
        return {
          from: () => ({
            innerJoin: () => ({
              where: (w: unknown) => {
                hrWhere.push(w)
                return { limit }
              },
            }),
          }),
        }
      },
    },
  }
  const svc = new ProjectScopedReadService(db as never, { hrSharesActiveTeamWith } as never)
  return { svc, hrSharesActiveTeamWith, limit, selectCols, hrWhere, membershipArgs }
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

  it.each(['SENIOR', 'ACCOUNTANT', 'DROP'] as const)(
    '403 for %s, even as a listed member',
    async (role) => {
      const { svc } = makeSvc({ project: project() })
      await expect(svc.getHrContact('p-1', user(role, 'j-1'))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'NO_HR_CONTACT_ACCESS', statusCode: 403 }),
      })
    },
  )

  it('403 for a JUNIOR who is not a member', async () => {
    const { svc } = makeSvc({ project: project() })
    await expect(svc.getHrContact('p-1', user('JUNIOR', 'other'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_HR_CONTACT_ACCESS' }),
    })
  })

  it('allows an active JUNIOR among several members', async () => {
    const { svc } = makeSvc({
      project: project({
        members: [
          { userId: 'x', leftAt: null },
          { userId: 'j-1', leftAt: null },
        ],
      }),
      membership: { teamId: 't-1' },
      hrRow: { displayName: 'H', telegram: null, phone: null, avatarUrl: null },
    })
    await expect(svc.getHrContact('p-1', user('JUNIOR', 'j-1'))).resolves.toMatchObject({
      displayName: 'H',
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
  it('ADMIN on a senior-less project gets all-null fields without querying teams', async () => {
    const { svc, membershipArgs } = makeSvc({
      project: project({ seniorId: null }),
      membership: { teamId: 't-1' },
      hrRow: { displayName: 'H', telegram: 'tg', phone: 'ph', avatarUrl: 'av' },
    })
    await expect(svc.getHrContact('p-1', user('ADMIN'))).resolves.toEqual(NULLS)
    expect(membershipArgs).toHaveLength(0)
  })

  it('no active membership: all-null and the HR lookup is not run', async () => {
    const { svc, selectCols } = makeSvc({
      project: project(),
      membership: undefined,
      hrRow: { displayName: 'H', telegram: 'tg', phone: 'ph', avatarUrl: 'av' },
    })
    await expect(svc.getHrContact('p-1', user('ADMIN'))).resolves.toEqual(NULLS)
    expect(selectCols).toHaveLength(0)
  })

  it('queries the senior membership and the team HR with the expected filters', async () => {
    const { svc, selectCols, hrWhere, membershipArgs } = makeSvc({
      project: project(),
      membership: { teamId: 't-9' },
      hrRow: { displayName: 'H', telegram: null, phone: null, avatarUrl: null },
    })
    await svc.getHrContact('p-1', user('ADMIN'))
    expect(paramsOf((membershipArgs[0] as { where: unknown }).where)).toEqual(['s-1'])
    expect(Object.keys(selectCols[0] as object).sort()).toEqual([
      'avatarUrl',
      'displayName',
      'phone',
      'telegram',
    ])
    expect(paramsOf(hrWhere[0])).toEqual(['t-9', 'HR'])
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

describe('findDropOwnProjects — income query shape', () => {
  it('counts only the caller DROP_INCOME rows from the non-deleted view', async () => {
    const selectCols: unknown[] = []
    const wheres: unknown[] = []
    const db = {
      db: {
        query: { projects: { findMany: () => Promise.resolve([]) } },
        select: (cols: unknown) => {
          selectCols.push(cols)
          return {
            from: () => ({
              where: (w: unknown) => {
                wheres.push(w)
                return Promise.resolve([])
              },
            }),
          }
        },
      },
    }
    const svc = new ProjectScopedReadService(db as never, {} as never)
    await svc.findDropOwnProjects(user('DROP', 'drop-1'))
    expect(Object.keys(selectCols[0] as object)).toEqual(['projectId'])
    expect(paramsOf(wheres[0])).toEqual(['DROP_INCOME', 'drop-1'])
  })
})
