import { ForbiddenException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { projects, teamMembers, users } from '../database/schema'
import {
  archiveTeam,
  getTeamArchiveImpact,
  unarchiveTeam,
  type TeamArchiveDeps,
} from './team-archive.util'

const dialect = new PgDialect()
const render = (cond: SQL) => dialect.sqlToQuery(cond)

const admin = { id: 'admin-1', role: 'ADMIN' } as unknown as SessionUser
const hr = { id: 'hr-1', role: 'HR' } as unknown as SessionUser

interface SelectCall {
  projection: unknown
  from: unknown
  joins: number
  where: SQL | undefined
}

/**
 * Fake db: `select(proj)` consumes the next canned row-set (in call order) and
 * returns a thenable builder recording from / innerJoin / where. `query.teams.
 * findFirst` resolves `team` and records its args.
 */
function makeDb(team: unknown, selectRows: unknown[][] = []) {
  const calls: SelectCall[] = []
  const queue = [...selectRows]
  const select = vi.fn((projection: unknown) => {
    const call: SelectCall = { projection, from: undefined, joins: 0, where: undefined }
    calls.push(call)
    const rows = queue.shift() ?? []
    const builder = {
      from: (t: unknown) => {
        call.from = t
        return builder
      },
      innerJoin: () => {
        call.joins += 1
        return builder
      },
      where: (c: SQL) => {
        call.where = c
        return builder
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    }
    return builder
  })
  const findFirst = vi.fn().mockResolvedValue(team)
  const tx = { marker: 'tx' }
  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))
  const db = { select, transaction, query: { teams: { findFirst } } }
  return { db, calls, findFirst, transaction, tx }
}

function makeDeps(team: unknown, selectRows: unknown[][] = [], impacts: unknown[] = []) {
  const m = makeDb(team, selectRows)
  const usersService = {
    archive: vi.fn().mockResolvedValue(undefined),
    unarchive: vi.fn().mockResolvedValue(undefined),
    getArchiveImpact: vi.fn(async () => impacts.shift()),
  }
  const archiveDropTeam = vi.fn().mockResolvedValue({ archivedProjects: 0, detachedSeniorId: null })
  const findOne = vi.fn().mockResolvedValue({ id: 'found' })
  const deps = {
    db: m.db,
    usersService,
    archiveDropTeam,
    findOne,
  } as unknown as TeamArchiveDeps
  return { deps, usersService, archiveDropTeam, findOne, ...m }
}

const active = (userId: string, role: string | null, leftAt: Date | null = null) => ({
  userId,
  leftAt,
  user: role === null ? null : { role },
})

describe('archiveTeam', () => {
  it('rejects a non-ADMIN before touching the db', async () => {
    const { deps, findFirst } = makeDeps(undefined)
    await expect(archiveTeam(deps, 't1', hr)).rejects.toBeInstanceOf(ForbiddenException)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('loads the team by id with members + users', async () => {
    const { deps, findFirst } = makeDeps(undefined)
    await archiveTeam(deps, 'team-X', admin).catch(() => undefined)
    const arg = findFirst.mock.calls[0]![0]
    const q = render(arg.where as SQL)
    expect(q.sql).toBe('"teams"."id" = $1')
    expect(q.params).toEqual(['team-X'])
    expect(arg.with).toEqual({ members: { with: { user: true } } })
  })

  it('404 TEAM_NOT_FOUND when the team does not exist', async () => {
    const { deps } = makeDeps(undefined)
    await expect(archiveTeam(deps, 't1', admin)).rejects.toMatchObject({
      status: 404,
      response: { code: 'TEAM_NOT_FOUND' },
    })
  })

  it('400 TEAM_ALREADY_ARCHIVED when archivedAt is set', async () => {
    const { deps, usersService } = makeDeps({ type: 'SENIOR', archivedAt: new Date(), members: [] })
    await expect(archiveTeam(deps, 't1', admin)).rejects.toMatchObject({
      status: 400,
      response: { code: 'TEAM_ALREADY_ARCHIVED' },
    })
    expect(usersService.archive).not.toHaveBeenCalled()
  })

  it('DROP team: archiveDropTeam runs inside ONE transaction, UsersService.archive is not called', async () => {
    const { deps, usersService, archiveDropTeam, transaction, tx, findOne } = makeDeps({
      type: 'DROP',
      archivedAt: null,
      members: [active('s1', 'SENIOR')],
    })
    const res = await archiveTeam(deps, 't1', admin)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(archiveDropTeam).toHaveBeenCalledWith('t1', tx)
    expect(usersService.archive).not.toHaveBeenCalled()
    expect(findOne).toHaveBeenCalledWith('t1', admin)
    expect(res).toEqual({ id: 'found' })
  })

  it('SENIOR team: archives the ACTIVE senior (skips non-seniors, detached seniors, user-less rows)', async () => {
    const { deps, usersService, archiveDropTeam, transaction, findOne } = makeDeps({
      type: 'SENIOR',
      archivedAt: null,
      members: [
        active('ghost', null),
        active('hr1', 'HR'),
        active('old-senior', 'SENIOR', new Date('2026-01-01')),
        active('cur-senior', 'SENIOR'),
      ],
    })
    const res = await archiveTeam(deps, 't1', admin)
    expect(usersService.archive).toHaveBeenCalledTimes(1)
    expect(usersService.archive).toHaveBeenCalledWith('cur-senior', 'admin-1')
    expect(archiveDropTeam).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(findOne).toHaveBeenCalledWith('t1', admin)
    expect(res).toEqual({ id: 'found' })
  })

  it('400 TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE when only detached / non-senior members exist', async () => {
    const { deps, usersService } = makeDeps({
      type: 'SENIOR',
      archivedAt: null,
      members: [active('hr1', 'HR'), active('old', 'SENIOR', new Date('2026-01-01'))],
    })
    await expect(archiveTeam(deps, 't1', admin)).rejects.toMatchObject({
      status: 400,
      response: { code: 'TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE' },
    })
    expect(usersService.archive).not.toHaveBeenCalled()
  })
})

describe('unarchiveTeam', () => {
  it('rejects a non-ADMIN before touching the db', async () => {
    const { deps, findFirst } = makeDeps(undefined)
    await expect(unarchiveTeam(deps, 't1', hr)).rejects.toBeInstanceOf(ForbiddenException)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('loads the team by id with members', async () => {
    const { deps, findFirst } = makeDeps(undefined)
    await unarchiveTeam(deps, 'team-X', admin).catch(() => undefined)
    const arg = findFirst.mock.calls[0]![0]
    const q = render(arg.where as SQL)
    expect(q.sql).toBe('"teams"."id" = $1')
    expect(q.params).toEqual(['team-X'])
    expect(arg.with).toEqual({ members: true })
  })

  it('404 TEAM_NOT_FOUND when the team does not exist', async () => {
    const { deps } = makeDeps(undefined)
    await expect(unarchiveTeam(deps, 't1', admin)).rejects.toMatchObject({
      status: 404,
      response: { code: 'TEAM_NOT_FOUND' },
    })
  })

  it('400 TEAM_NOT_ARCHIVED when the team is not archived', async () => {
    const { deps, calls } = makeDeps({ archivedAt: null })
    await expect(unarchiveTeam(deps, 't1', admin)).rejects.toMatchObject({
      status: 400,
      response: { code: 'TEAM_NOT_ARCHIVED' },
    })
    expect(calls).toHaveLength(0)
  })

  it('looks up the ACTIVE senior (leftAt IS NULL, role SENIOR) and unarchives them', async () => {
    const { deps, usersService, calls, findOne } = makeDeps({ archivedAt: new Date() }, [
      [{ userId: 'cur-senior' }],
    ])
    const res = await unarchiveTeam(deps, 'team-X', admin)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.projection).toEqual({ userId: teamMembers.userId })
    expect(calls[0]!.from).toBe(teamMembers)
    expect(calls[0]!.joins).toBe(1)
    const q = render(calls[0]!.where as SQL)
    expect(q.sql).toBe(
      '("team_members"."team_id" = $1 and "users"."role" = $2 and "team_members"."left_at" is null)',
    )
    expect(q.params).toEqual(['team-X', 'SENIOR'])
    expect(usersService.unarchive).toHaveBeenCalledWith('cur-senior', 'admin-1')
    expect(findOne).toHaveBeenCalledWith('team-X', admin)
    expect(res).toEqual({ id: 'found' })
  })

  it('404 SENIOR_NOT_FOUND when the team has no active senior', async () => {
    const { deps, usersService } = makeDeps({ archivedAt: new Date() }, [[]])
    await expect(unarchiveTeam(deps, 't1', admin)).rejects.toMatchObject({
      status: 404,
      response: { code: 'SENIOR_NOT_FOUND' },
    })
    expect(usersService.unarchive).not.toHaveBeenCalled()
  })
})

describe('getTeamArchiveImpact', () => {
  const idName = (id: string, displayName: string) => ({ id, displayName })

  it('rejects a non-ADMIN before touching the db', async () => {
    const { deps, findFirst } = makeDeps(undefined)
    await expect(getTeamArchiveImpact(deps, 't1', hr)).rejects.toBeInstanceOf(ForbiddenException)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('loads the team by id; 404 TEAM_NOT_FOUND when missing', async () => {
    const { deps, findFirst } = makeDeps(undefined)
    await expect(getTeamArchiveImpact(deps, 'team-X', admin)).rejects.toMatchObject({
      status: 404,
      response: { code: 'TEAM_NOT_FOUND' },
    })
    const q = render(findFirst.mock.calls[0]![0].where as SQL)
    expect(q.sql).toBe('"teams"."id" = $1')
    expect(q.params).toEqual(['team-X'])
  })

  describe('DROP team', () => {
    const dropTeam = { type: 'DROP', name: 'Drop-X' }
    const roleSql = (role: string) => ({
      sql: '("team_members"."team_id" = $1 and "users"."role" = $2 and "team_members"."left_at" is null)',
      params: ['team-X', role],
    })

    it('builds the full impact from drop / senior / HR / accountant / project queries', async () => {
      const { deps, usersService, calls } = makeDeps(
        dropTeam,
        [
          [idName('drop-1', 'Drop Owner')],
          [idName('sen-1', 'Sen Name')],
          [{ userId: 'h1' }, { userId: 'h2' }],
          [{ userId: 'a1' }],
          [
            { id: 'p1', name: 'Proj One' },
            { id: 'p2', name: 'Proj Two' },
          ],
        ],
        [
          {
            type: 'user',
            role: 'DROP',
            pendingTransactions: [{ id: 'tx1' }],
          },
        ],
      )
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)

      expect(res).toEqual({
        type: 'team',
        isPaired: true,
        teamName: 'Drop-X',
        seniorName: 'Sen Name',
        projectsCount: 2,
        projectNames: ['Proj One', 'Proj Two'],
        membersAffected: 3,
        teamType: 'DROP',
        dropName: 'Drop Owner',
        seniorWillBeDetached: true,
        pendingTransactions: [{ id: 'tx1' }],
      })
      expect(usersService.getArchiveImpact).toHaveBeenCalledWith('drop-1', admin)

      expect(calls).toHaveLength(5)
      const idNameProj = { id: users.id, displayName: users.displayName }
      // drop owner
      expect(calls[0]!.projection).toEqual(idNameProj)
      expect(calls[0]!.from).toBe(teamMembers)
      expect(calls[0]!.joins).toBe(1)
      expect({
        sql: render(calls[0]!.where as SQL).sql,
        params: render(calls[0]!.where as SQL).params,
      }).toEqual(roleSql('DROP'))
      // active senior
      expect(calls[1]!.projection).toEqual(idNameProj)
      expect(calls[1]!.joins).toBe(1)
      expect(render(calls[1]!.where as SQL).params).toEqual(['team-X', 'SENIOR'])
      // HR
      expect(calls[2]!.projection).toEqual({ userId: teamMembers.userId })
      expect(calls[2]!.from).toBe(teamMembers)
      expect(calls[2]!.joins).toBe(1)
      const hrQ = render(calls[2]!.where as SQL)
      expect(hrQ.sql).toBe(
        '("team_members"."team_id" = $1 and "team_members"."left_at" is null and "users"."role" = $2)',
      )
      expect(hrQ.params).toEqual(['team-X', 'HR'])
      // accountants
      expect(calls[3]!.projection).toEqual({ userId: teamMembers.userId })
      expect(calls[3]!.from).toBe(teamMembers)
      expect(calls[3]!.joins).toBe(1)
      const accQ = render(calls[3]!.where as SQL)
      expect(accQ.sql).toBe(
        '("team_members"."team_id" = $1 and "team_members"."left_at" is null and "users"."role" = $2)',
      )
      expect(accQ.params).toEqual(['team-X', 'ACCOUNTANT'])
      // drop projects
      expect(calls[4]!.projection).toEqual({ id: projects.id, name: projects.name })
      expect(calls[4]!.from).toBe(projects)
      expect(calls[4]!.joins).toBe(0)
      const pQ = render(calls[4]!.where as SQL)
      expect(pQ.sql).toBe('("projects"."drop_id" = $1 and "projects"."archived_at" is null)')
      expect(pQ.params).toEqual(['drop-1'])
    })

    it('no active drop member: empty names, no projects query, no pending forward, no senior', async () => {
      const { deps, usersService, calls } = makeDeps(dropTeam, [[], [], [], []])
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toEqual({
        type: 'team',
        isPaired: true,
        teamName: 'Drop-X',
        seniorName: '',
        projectsCount: 0,
        projectNames: [],
        membersAffected: 0,
        teamType: 'DROP',
        dropName: '',
        seniorWillBeDetached: false,
        pendingTransactions: [],
      })
      expect(calls).toHaveLength(4)
      expect(usersService.getArchiveImpact).not.toHaveBeenCalled()
    })

    it('pending transactions fall back to [] for a non-DROP user impact', async () => {
      const { deps } = makeDeps(
        dropTeam,
        [[idName('drop-1', 'D')], [], [], [], []],
        [{ type: 'user', role: 'SENIOR', pendingTransactions: [{ id: 'x' }] }],
      )
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toMatchObject({ pendingTransactions: [] })
    })

    it('pending transactions fall back to [] when the drop impact carries none', async () => {
      const { deps } = makeDeps(
        dropTeam,
        [[idName('drop-1', 'D')], [], [], [], []],
        [{ type: 'user', role: 'DROP' }],
      )
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toMatchObject({ pendingTransactions: [] })
    })

    it('pending transactions fall back to [] for a non-user impact', async () => {
      const { deps } = makeDeps(
        dropTeam,
        [[idName('drop-1', 'D')], [], [], [], []],
        [{ type: 'team', role: 'DROP', pendingTransactions: [{ id: 'x' }] }],
      )
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toMatchObject({ pendingTransactions: [] })
    })
  })

  describe('SENIOR team', () => {
    const seniorTeam = { type: 'SENIOR', name: 'Team-S' }

    it('no active senior: empty paired impact, UsersService not consulted', async () => {
      const { deps, usersService } = makeDeps(seniorTeam, [[]])
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toEqual({
        type: 'team',
        isPaired: true,
        teamName: 'Team-S',
        seniorName: '',
        projectsCount: 0,
        membersAffected: 0,
        teamType: 'SENIOR',
      })
      expect(usersService.getArchiveImpact).not.toHaveBeenCalled()
    })

    it('forwards the senior user-impact 1:1', async () => {
      const { deps, usersService, calls } = makeDeps(
        seniorTeam,
        [[idName('sen-1', 'Sen Name')]],
        [
          {
            type: 'user',
            role: 'SENIOR',
            projectsCount: 4,
            projectNames: ['A', 'B'],
            hrAccountantsOnTeam: 2,
            pendingTransactions: [{ id: 'tx9' }],
          },
        ],
      )
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toEqual({
        type: 'team',
        isPaired: true,
        teamName: 'Team-S',
        seniorName: 'Sen Name',
        projectsCount: 4,
        projectNames: ['A', 'B'],
        membersAffected: 2,
        teamType: 'SENIOR',
        pendingTransactions: [{ id: 'tx9' }],
      })
      expect(usersService.getArchiveImpact).toHaveBeenCalledWith('sen-1', admin)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.projection).toEqual({ id: users.id, displayName: users.displayName })
      expect(calls[0]!.from).toBe(teamMembers)
      expect(calls[0]!.joins).toBe(1)
      const q = render(calls[0]!.where as SQL)
      expect(q.sql).toBe(
        '("team_members"."team_id" = $1 and "users"."role" = $2 and "team_members"."left_at" is null)',
      )
      expect(q.params).toEqual(['team-X', 'SENIOR'])
    })

    it.each([
      ['a DROP user impact', { type: 'user', role: 'DROP', projectsCount: 9 }],
      ['a non-user impact', { type: 'team', role: 'SENIOR', projectsCount: 9 }],
    ])('defaults to zeros/empties for %s', async (_label, impact) => {
      const { deps } = makeDeps(seniorTeam, [[idName('sen-1', 'Sen Name')]], [impact])
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toEqual({
        type: 'team',
        isPaired: true,
        teamName: 'Team-S',
        seniorName: 'Sen Name',
        projectsCount: 0,
        projectNames: [],
        membersAffected: 0,
        teamType: 'SENIOR',
        pendingTransactions: [],
      })
    })

    it('defaults each missing SENIOR impact field independently', async () => {
      const { deps } = makeDeps(
        seniorTeam,
        [[idName('sen-1', 'S')]],
        [{ type: 'user', role: 'SENIOR' }],
      )
      const res = await getTeamArchiveImpact(deps, 'team-X', admin)
      expect(res).toMatchObject({
        projectsCount: 0,
        projectNames: [],
        membersAffected: 0,
        pendingTransactions: [],
      })
    })
  })
})
