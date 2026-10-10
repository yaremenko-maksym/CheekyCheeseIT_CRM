/**
 * Unit tests — `ProjectsService.computeEffectiveTeam` query wiring (leaf P-L3).
 *
 * The pure assembly is covered in `project-team.util.spec.ts`; this file pins what stays in the
 * service: WHICH team_members rows are loaded and handed to `buildEffectiveTeam`.
 */
import { describe, expect, it, vi } from 'vitest'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'

const SENIOR = {
  id: 'sen1',
  role: 'SENIOR',
  displayName: 'Sen',
  email: 'sen@x.test',
  avatarUrl: null,
  avatarDocumentId: null,
}

function harness(opts: { membership: { teamId: string } | null; rows: unknown[] }) {
  const findFirst = vi.fn(async (_arg: unknown) => opts.membership)
  const select = vi.fn((_fields: unknown) => ({
    from: () => ({
      innerJoin: () => ({ where: async (_w: unknown) => opts.rows }),
    }),
  }))
  const db = { db: { query: { teamMembers: { findFirst } }, select } }
  const service = new ProjectsService(
    db as never,
    {} as never,
    {} as never,
    new HrAccessService(db as never),
    {} as never,
    makeNotificationsStub(),
  )
  const compute = (project: unknown, role: string) =>
    (
      service as unknown as {
        computeEffectiveTeam: (
          p: unknown,
          r: string,
        ) => Promise<{
          hrs: { id: string }[]
          accountants: { id: string }[]
        }>
      }
    ).computeEffectiveTeam(project, role)
  return { compute, findFirst, select, service }
}

const row = (id: string, role: string) => ({
  id,
  userId: `u-${id}`,
  displayName: id,
  email: `${id}@x.test`,
  avatarUrl: null,
  avatarDocumentId: null,
  role,
})

describe('computeEffectiveTeam — team_members query wiring', () => {
  it('no senior -> no queries, empty hrs/accountants', async () => {
    const h = harness({ membership: { teamId: 't1' }, rows: [row('h1', 'HR')] })
    const t = await h.compute({ senior: null, members: [], drop: null }, 'ADMIN')
    expect(t.hrs).toEqual([])
    expect(t.accountants).toEqual([])
    expect(h.findFirst).not.toHaveBeenCalled()
    expect(h.select).not.toHaveBeenCalled()
  })

  it('senior without active membership -> empty hrs/accountants, rows never selected', async () => {
    const h = harness({ membership: null, rows: [row('h1', 'HR')] })
    const t = await h.compute({ senior: SENIOR, members: [], drop: null }, 'ADMIN')
    expect(t.hrs).toEqual([])
    expect(t.accountants).toEqual([])
    expect(h.findFirst).toHaveBeenCalledTimes(1)
    expect(h.select).not.toHaveBeenCalled()
  })

  it('loadSeniorTeamRows: no active membership -> exactly [] without selecting rows', async () => {
    const h = harness({ membership: null, rows: [row('h1', 'HR')] })
    const rows = await (
      h.service as unknown as { loadSeniorTeamRows: (id: string) => Promise<unknown[]> }
    ).loadSeniorTeamRows('sen1')
    expect(rows).toEqual([])
    expect(h.select).not.toHaveBeenCalled()
  })

  it('senior with membership -> membership lookup is filtered and rows feed hrs/accountants', async () => {
    const h = harness({
      membership: { teamId: 't1' },
      rows: [row('h1', 'HR'), row('a1', 'ACCOUNTANT')],
    })
    const t = await h.compute({ senior: SENIOR, members: [], drop: null }, 'ADMIN')
    expect(t.hrs.map((r) => r.id)).toEqual(['h1'])
    expect(t.accountants.map((r) => r.id)).toEqual(['a1'])
    const arg = h.findFirst.mock.calls[0][0] as { where?: unknown }
    expect(arg.where).toBeDefined()
    expect(Object.keys(h.select.mock.calls[0][0] as object).sort()).toEqual([
      'avatarDocumentId',
      'avatarUrl',
      'displayName',
      'email',
      'id',
      'role',
      'userId',
    ])
  })
})
