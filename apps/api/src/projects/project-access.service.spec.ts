import { ForbiddenException, HttpStatus } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectAccessService } from './project-access.service'
import type { ProjectWithRelations } from './project-map.util'

function user(role: SessionUser['role'], id = 'u-1'): SessionUser {
  return { id, role } as SessionUser
}

function project(over: Record<string, unknown> = {}): ProjectWithRelations {
  return {
    id: 'p-1',
    status: 'ACTIVE',
    seniorId: 'senior-1',
    dropId: null,
    members: [],
    ...over,
  } as unknown as ProjectWithRelations
}

/** select().from().where() -> hrTeams ; select().from().innerJoin().where() -> seniors */
function makeService(opts: { hrTeams?: string[]; seniors?: string[]; invited?: boolean } = {}) {
  const hrTeams = (opts.hrTeams ?? []).map((teamId) => ({ teamId }))
  const seniors = (opts.seniors ?? []).map((userId) => ({ userId }))
  const where = vi.fn().mockResolvedValueOnce(hrTeams).mockResolvedValueOnce(seniors)
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ where, innerJoin })
  const select = vi.fn().mockReturnValue({ from })
  const isApprover = vi.fn().mockResolvedValue(opts.invited ?? false)
  const svc = new ProjectAccessService({ db: { select } } as never, { isApprover } as never)
  return { svc, select, isApprover }
}

describe('ProjectAccessService.getHrSeniorIds', () => {
  it('returns [] without a second query when HR has no active team', async () => {
    const { svc, select } = makeService({ hrTeams: [] })
    expect(await svc.getHrSeniorIds('hr-1')).toEqual([])
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('returns the senior ids of the HR teams', async () => {
    const { svc, select } = makeService({ hrTeams: ['t-1'], seniors: ['s-1', 's-2'] })
    expect(await svc.getHrSeniorIds('hr-1')).toEqual(['s-1', 's-2'])
    expect(select).toHaveBeenCalledTimes(2)
    expect(select).toHaveBeenNthCalledWith(1, { teamId: expect.anything() })
    expect(select).toHaveBeenNthCalledWith(2, { userId: expect.anything() })
  })
})

describe('ProjectAccessService.assertHrCanManageProject', () => {
  it('is a no-op for non-HR roles without touching the db', async () => {
    for (const role of ['ADMIN', 'ACCOUNTANT', 'SENIOR', 'JUNIOR', 'DROP'] as const) {
      const { svc, select } = makeService()
      await expect(svc.assertHrCanManageProject(null, user(role))).resolves.toBeUndefined()
      expect(select).not.toHaveBeenCalled()
    }
  })

  it('403 PROJECT_NOT_IN_YOUR_TEAMS for HR when the project has no senior', async () => {
    const { svc, select } = makeService()
    await expect(svc.assertHrCanManageProject(null, user('HR'))).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
    expect(select).not.toHaveBeenCalled()
  })

  it('403 for HR whose teams do not contain the senior', async () => {
    const { svc } = makeService({ hrTeams: ['t-1'], seniors: ['other'] })
    await expect(svc.assertHrCanManageProject('senior-1', user('HR'))).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
  })

  it('passes for HR whose team contains the senior', async () => {
    const { svc } = makeService({ hrTeams: ['t-1'], seniors: ['senior-1'] })
    await expect(svc.assertHrCanManageProject('senior-1', user('HR'))).resolves.toBeUndefined()
  })
})

describe('ProjectAccessService.assertAccess — non-ACTIVE (existence-oracle 404)', () => {
  for (const status of ['DRAFT', 'REJECTED']) {
    for (const role of ['ACCOUNTANT', 'SENIOR', 'HR', 'JUNIOR', 'DROP'] as const) {
      it(`${status}: uninvited ${role} gets 404, not 403`, async () => {
        const { svc, isApprover } = makeService({ invited: false })
        const err = await svc
          .assertAccess(project({ status, seniorId: 'u-1', dropId: 'u-1' }), user(role))
          .catch((e: unknown) => e)
        expect(err).toMatchObject({ status: HttpStatus.NOT_FOUND })
        expect(err).not.toBeInstanceOf(ForbiddenException)
        expect(isApprover).toHaveBeenCalledWith('PROJECT', 'p-1', 'u-1')
      })
    }
  }

  it('ADMIN passes without an approver lookup', async () => {
    const { svc, isApprover } = makeService()
    await expect(
      svc.assertAccess(project({ status: 'DRAFT' }), user('ADMIN')),
    ).resolves.toBeUndefined()
    expect(isApprover).not.toHaveBeenCalled()
  })

  it('an invited approver passes', async () => {
    const { svc } = makeService({ invited: true })
    await expect(
      svc.assertAccess(project({ status: 'REJECTED' }), user('SENIOR')),
    ).resolves.toBeUndefined()
  })
})

describe('ProjectAccessService.assertAccess — ACTIVE role matrix', () => {
  it('ADMIN and ACCOUNTANT pass', async () => {
    const { svc } = makeService()
    await expect(svc.assertAccess(project(), user('ADMIN'))).resolves.toBeUndefined()
    await expect(svc.assertAccess(project(), user('ACCOUNTANT'))).resolves.toBeUndefined()
  })

  it('SENIOR passes only for own project, otherwise 403', async () => {
    const { svc } = makeService()
    await expect(
      svc.assertAccess(project({ seniorId: 'u-1' }), user('SENIOR')),
    ).resolves.toBeUndefined()
    await expect(svc.assertAccess(project(), user('SENIOR'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('HR passes when the project senior is in HR scope, else 403', async () => {
    const ok = makeService({ hrTeams: ['t'], seniors: ['senior-1'] })
    await expect(ok.svc.assertAccess(project(), user('HR'))).resolves.toBeUndefined()
    const no = makeService({ hrTeams: ['t'], seniors: ['x'] })
    await expect(no.svc.assertAccess(project(), user('HR'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('HR gets 403 on a senior-less project even if scope is non-empty', async () => {
    const { svc } = makeService({ hrTeams: ['t'], seniors: ['senior-1'] })
    await expect(svc.assertAccess(project({ seniorId: null }), user('HR'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('JUNIOR passes only as an active member', async () => {
    const { svc } = makeService()
    const active = project({ members: [{ userId: 'u-1', leftAt: null }] })
    const left = project({ members: [{ userId: 'u-1', leftAt: new Date() }] })
    const other = project({ members: [{ userId: 'u-2', leftAt: null }] })
    await expect(svc.assertAccess(active, user('JUNIOR'))).resolves.toBeUndefined()
    await expect(svc.assertAccess(left, user('JUNIOR'))).rejects.toBeInstanceOf(ForbiddenException)
    await expect(svc.assertAccess(other, user('JUNIOR'))).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('DROP passes only for own drop project', async () => {
    const { svc } = makeService()
    await expect(
      svc.assertAccess(project({ dropId: 'u-1' }), user('DROP')),
    ).resolves.toBeUndefined()
    await expect(svc.assertAccess(project({ dropId: 'u-2' }), user('DROP'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })
})

describe('ProjectAccessService.assertAccess — no cross-role leakage', () => {
  const trap = (over: Record<string, unknown>) =>
    project({
      seniorId: 'u-1',
      dropId: 'u-1',
      members: [{ userId: 'u-1', leftAt: null }],
      ...over,
    })

  it('a non-owner SENIOR is not let in by HR scope, junior membership or drop ownership', async () => {
    const { svc } = makeService({ hrTeams: ['t'], seniors: ['senior-1'] })
    await expect(
      svc.assertAccess(trap({ seniorId: 'senior-1' }), user('SENIOR')),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('HR is not let in by being the senior, a member or the drop of the project', async () => {
    const { svc } = makeService({ hrTeams: ['t'], seniors: ['x'] })
    await expect(svc.assertAccess(trap({}), user('HR'))).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('a non-member JUNIOR is not let in by seniorId, HR scope or dropId', async () => {
    const { svc } = makeService({ hrTeams: ['t'], seniors: ['u-1'] })
    await expect(
      svc.assertAccess(trap({ members: [{ userId: 'u-2', leftAt: null }] }), user('JUNIOR')),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('a DROP user is not let in by seniorId, HR scope or membership of another drop project', async () => {
    const { svc } = makeService({ hrTeams: ['t'], seniors: ['u-1'] })
    await expect(svc.assertAccess(trap({ dropId: 'other' }), user('DROP'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('JUNIOR passes when active among several members', async () => {
    const { svc } = makeService()
    const many = project({
      members: [
        { userId: 'u-1', leftAt: null },
        { userId: 'u-2', leftAt: null },
      ],
    })
    await expect(svc.assertAccess(many, user('JUNIOR'))).resolves.toBeUndefined()
  })
})
