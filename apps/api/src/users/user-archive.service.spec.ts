/**
 * Unit doubles for UserArchiveService. A scripted tx double returns queued rows
 * for each `select()` in call order and records every `update()` and audit
 * `record()` call, so the exact cascade (writes + audit payloads) is pinned.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { projectMembers, projects, teamMembers, teams, users, type User } from '../database/schema'
import { UserArchiveService } from './user-archive.service'
import { markSeniorDirty } from '../job-sourcing/dirty-producers'
// r5 4.6 S5: the roster dirty producers are proven in job-sourcing; here they are inert.
vi.mock('../job-sourcing/dirty-producers')

type Row = Record<string, unknown>
type Update = { table: unknown; set: Row }

function makeTx(selects: Row[][]) {
  const queue = [...selects]
  const updates: Update[] = []
  const forCalls: string[] = []
  const tx = {
    select: vi.fn(() => {
      const rows = queue.shift() ?? []
      const chain: Record<string, unknown> = {}
      chain.from = () => chain
      chain.where = () => chain
      chain.for = (mode: string) => {
        forCalls.push(mode)
        return chain
      }
      chain.then = (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej)
      return chain
    }),
    update: vi.fn((table: unknown) => ({
      set: (set: Row) => {
        updates.push({ table, set })
        return { where: () => Promise.resolve() }
      },
    })),
  }
  return { tx, updates, forCalls }
}

function makeService(selects: Row[][], opts: { archiveDropTeam?: ReturnType<typeof vi.fn> } = {}) {
  const { tx, updates, forCalls } = makeTx(selects)
  const audit = { record: vi.fn().mockResolvedValue(undefined) }
  const teamAudit = { record: vi.fn().mockResolvedValue(undefined) }
  const projectAudit = { record: vi.fn().mockResolvedValue(undefined) }
  const teamsService = {
    archiveDropTeam:
      opts.archiveDropTeam ??
      vi.fn().mockResolvedValue({ archivedProjects: 0, detachedSeniorId: null }),
  }
  const db = { db: { transaction: (cb: (t: unknown) => unknown) => cb(tx) } }
  const svc = new UserArchiveService(
    db as never,
    teamAudit as never,
    projectAudit as never,
    audit as never,
    teamsService as never,
  )
  return { svc, tx, updates, forCalls, audit, teamAudit, projectAudit, teamsService }
}

const ISO = /^\d{4}-\d{2}-\d{2}T/
const user = (role: string, extra: Row = {}): Row => ({
  id: 'u1',
  role,
  archivedAt: null,
  ...extra,
})

describe('UserArchiveService.archive guards', () => {
  it('missing user -> USER_NOT_FOUND', async () => {
    const { svc } = makeService([[]])
    await expect(svc.archive('u1', 'a1')).rejects.toMatchObject({ status: 404 })
  })

  it('already archived -> 400', async () => {
    const { svc, updates } = makeService([[user('HR', { archivedAt: new Date() })]])
    await expect(svc.archive('u1', 'a1')).rejects.toMatchObject({ status: 400 })
    expect(updates).toHaveLength(0)
  })

  it('ADMIN cannot archive another ADMIN; self and system actor are allowed', async () => {
    const other = makeService([[user('ADMIN')]])
    await expect(other.svc.archive('u1', 'someone-else')).rejects.toMatchObject({ status: 403 })
    expect(other.updates).toHaveLength(0)

    const self = makeService([[user('ADMIN')], [user('ADMIN')]])
    await self.svc.archive('u1', 'u1')
    expect(self.updates).toHaveLength(1)

    const system = makeService([[user('ADMIN')], [user('ADMIN')]])
    await system.svc.archive('u1', null)
    expect(system.updates).toHaveLength(1)
  })

  it('a non-ADMIN target is not subject to the ADMIN guard', async () => {
    const { svc, updates } = makeService([[user('HR')], [], [user('HR')]])
    await svc.archive('u1', 'someone-else')
    expect(updates).toHaveLength(1)
  })
})

describe('UserArchiveService.archive cascade', () => {
  it('ADMIN: writes only the user row + user_archived audit', async () => {
    const { svc, updates, audit, teamAudit, projectAudit } = makeService([
      [user('ADMIN')],
      [user('ADMIN')],
    ])
    await svc.archive('u1', 'u1')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.table).toBe(users)
    expect(updates[0]!.set.archivedAt).toBeInstanceOf(Date)
    expect(audit.record).toHaveBeenCalledTimes(1)
    const [payload, txArg] = audit.record.mock.calls[0]!
    expect(payload).toMatchObject({ actorId: 'u1', targetId: 'u1', action: 'user_archived' })
    expect(payload.changes.archivedAt.before).toBeNull()
    expect(payload.changes.archivedAt.after).toMatch(ISO)
    expect(txArg).toBeDefined()
    expect(teamAudit.record).not.toHaveBeenCalled()
    expect(projectAudit.record).not.toHaveBeenCalled()
  })

  it('SENIOR: archives team + each active project; never touches memberships', async () => {
    const { svc, updates, teamAudit, projectAudit, tx } = makeService([
      [user('SENIOR')],
      [{ teamId: 't1' }],
      [{ id: 'p1' }, { id: 'p2' }],
      [user('SENIOR')],
    ])
    await svc.archive('u1', 'a1')
    expect(vi.mocked(markSeniorDirty)).toHaveBeenLastCalledWith(tx, 'u1', 'senior.archive')
    expect(updates.map((u) => u.table)).toEqual([users, teams, projects, projects])
    expect(updates[1]!.set.archivedAt).toBeInstanceOf(Date)
    expect(updates[1]!.set.updatedAt).toBeInstanceOf(Date)
    expect(updates[2]!.set.archivedAt).toBeInstanceOf(Date)
    expect(updates[2]!.set.updatedAt).toBeInstanceOf(Date)
    expect(updates.some((u) => u.table === teamMembers || u.table === projectMembers)).toBe(false)
    expect(teamAudit.record).toHaveBeenCalledTimes(1)
    const [tp, ttx] = teamAudit.record.mock.calls[0]!
    expect(tp).toMatchObject({ actorId: 'a1', targetId: 't1', action: 'team_archived' })
    expect(tp.changes.archivedAt.before).toBeNull()
    expect(tp.changes.archivedAt.after).toMatch(ISO)
    expect(ttx).toBe(tx)
    expect(projectAudit.record).toHaveBeenCalledTimes(2)
    const [pp, ptx] = projectAudit.record.mock.calls[0]!
    expect(pp).toMatchObject({ actorId: 'a1', targetId: 'p1', action: 'project_archived' })
    expect(pp.changes.archivedAt.before).toBeNull()
    expect(pp.changes.archivedAt.after).toMatch(ISO)
    expect(ptx).toBe(tx)
    expect(projectAudit.record.mock.calls[1]![0]).toMatchObject({ targetId: 'p2' })
  })

  it('SENIOR without a membership: no team write, projects still archived', async () => {
    const { svc, updates, teamAudit } = makeService([
      [user('SENIOR')],
      [],
      [{ id: 'p1' }],
      [user('SENIOR')],
    ])
    await svc.archive('u1', 'a1')
    expect(updates.map((u) => u.table)).toEqual([users, projects])
    expect(teamAudit.record).not.toHaveBeenCalled()
  })

  it('HR/ACCOUNTANT: closes team memberships and audits each removed team', async () => {
    for (const role of ['HR', 'ACCOUNTANT']) {
      const { svc, updates, teamAudit, tx } = makeService([
        [user(role)],
        [
          { id: 'm1', teamId: 't1' },
          { id: 'm2', teamId: 't2' },
        ],
        [user(role)],
      ])
      await svc.archive('u1', 'a1')
      expect(tx.select).toHaveBeenCalledWith({ id: teamMembers.id, teamId: teamMembers.teamId })
      expect(updates.map((u) => u.table)).toEqual([users, teamMembers])
      expect(updates[1]!.set.leftAt).toBeInstanceOf(Date)
      expect(teamAudit.record).toHaveBeenCalledTimes(2)
      expect(teamAudit.record.mock.calls[0]![0]).toEqual({
        actorId: 'a1',
        targetId: 't1',
        action: 'team_member_removed',
        changes: { userId: { before: 'u1', after: null }, role: { before: role, after: null } },
      })
      expect(teamAudit.record.mock.calls[1]![0]).toMatchObject({ targetId: 't2' })
    }
  })

  it('HR without memberships: no membership write, no audit', async () => {
    const { svc, updates, teamAudit } = makeService([[user('HR')], [], [user('HR')]])
    await svc.archive('u1', 'a1')
    expect(updates.map((u) => u.table)).toEqual([users])
    expect(teamAudit.record).not.toHaveBeenCalled()
  })

  it('JUNIOR: closes project memberships and audits each', async () => {
    const { svc, updates, projectAudit, teamAudit, tx } = makeService([
      [user('JUNIOR')],
      [
        { id: 'pm1', projectId: 'p1' },
        { id: 'pm2', projectId: 'p2' },
      ],
      [user('JUNIOR')],
    ])
    await svc.archive('u1', 'a1')
    expect(tx.select).toHaveBeenCalledWith({
      id: projectMembers.id,
      projectId: projectMembers.projectId,
    })
    expect(updates.map((u) => u.table)).toEqual([users, projectMembers])
    expect(updates[1]!.set.leftAt).toBeInstanceOf(Date)
    expect(projectAudit.record).toHaveBeenCalledTimes(2)
    expect(projectAudit.record.mock.calls[0]![0]).toEqual({
      actorId: 'a1',
      targetId: 'p1',
      action: 'project_member_removed',
      changes: { userId: { before: 'u1', after: null } },
    })
    expect(projectAudit.record.mock.calls[1]![0]).toMatchObject({ targetId: 'p2' })
    expect(teamAudit.record).not.toHaveBeenCalled()
  })

  it('JUNIOR without memberships: no write', async () => {
    const { svc, updates, projectAudit } = makeService([[user('JUNIOR')], [], [user('JUNIOR')]])
    await svc.archive('u1', 'a1')
    expect(updates.map((u) => u.table)).toEqual([users])
    expect(projectAudit.record).not.toHaveBeenCalled()
  })

  it('DROP: delegates to archiveDropTeam with the tx and audits team_archived', async () => {
    const { svc, teamsService, teamAudit, tx, updates } = makeService([
      [user('DROP')],
      [{ teamId: 't9' }],
      [user('DROP')],
    ])
    await svc.archive('u1', 'a1')
    expect(teamsService.archiveDropTeam).toHaveBeenCalledWith('t9', tx)
    expect(teamAudit.record).toHaveBeenCalledTimes(1)
    const [p, ptx] = teamAudit.record.mock.calls[0]!
    expect(p).toMatchObject({ actorId: 'a1', targetId: 't9', action: 'team_archived' })
    expect(p.changes.archivedAt.before).toBeNull()
    expect(p.changes.archivedAt.after).toMatch(ISO)
    expect(ptx).toBe(tx)
    expect(updates.map((u) => u.table)).toEqual([users])
  })

  it('DROP without a team: no cascade', async () => {
    const { svc, teamsService, teamAudit } = makeService([[user('DROP')], [], [user('DROP')]])
    await svc.archive('u1', 'a1')
    expect(teamsService.archiveDropTeam).not.toHaveBeenCalled()
    expect(teamAudit.record).not.toHaveBeenCalled()
  })
})

describe('UserArchiveService.unarchive / unarchivePairTx', () => {
  const archivedAt = new Date('2026-01-02T03:04:05.000Z')

  it('missing / not-archived rejections', async () => {
    await expect(makeService([[]]).svc.unarchive('u1')).rejects.toMatchObject({ status: 404 })
    await expect(makeService([[user('HR')]]).svc.unarchive('u1')).rejects.toMatchObject({
      status: 400,
    })
  })

  it('HR: clears archivedAt, audits previous value, does not touch teams', async () => {
    const { svc, updates, audit, teamAudit } = makeService([
      [user('HR', { archivedAt })],
      [user('HR')],
    ])
    await svc.unarchive('u1', 'a1')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.table).toBe(users)
    expect(updates[0]!.set.archivedAt).toBeNull()
    expect(updates[0]!.set.updatedAt).toBeInstanceOf(Date)
    expect(audit.record.mock.calls[0]![0]).toEqual({
      actorId: 'a1',
      targetId: 'u1',
      action: 'user_unarchived',
      changes: { archivedAt: { before: archivedAt.toISOString(), after: null } },
    })
    expect(teamAudit.record).not.toHaveBeenCalled()
  })

  it('SENIOR: also restores an archived team; projects stay archived', async () => {
    const teamArchivedAt = new Date('2026-01-02T03:04:06.000Z')
    const { svc, updates, teamAudit, tx } = makeService([
      [user('SENIOR', { archivedAt })],
      [{ teamId: 't1' }],
      [{ id: 't1', archivedAt: teamArchivedAt }],
      [user('SENIOR')],
    ])
    await svc.unarchive('u1', 'a1')
    expect(vi.mocked(markSeniorDirty)).toHaveBeenLastCalledWith(tx, 'u1', 'senior.unarchive')
    expect(updates.map((u) => u.table)).toEqual([users, teams])
    expect(updates[1]!.set.archivedAt).toBeNull()
    expect(updates[1]!.set.updatedAt).toBeInstanceOf(Date)
    expect(teamAudit.record).toHaveBeenCalledTimes(1)
    const [p, ptx] = teamAudit.record.mock.calls[0]!
    expect(p).toEqual({
      actorId: 'a1',
      targetId: 't1',
      action: 'team_unarchived',
      changes: { archivedAt: { before: teamArchivedAt.toISOString(), after: null } },
    })
    expect(ptx).toBe(tx)
  })

  it('SENIOR: team not archived or missing -> no team write', async () => {
    const notArchived = makeService([
      [user('SENIOR', { archivedAt })],
      [{ teamId: 't1' }],
      [{ id: 't1', archivedAt: null }],
      [user('SENIOR')],
    ])
    await notArchived.svc.unarchive('u1', 'a1')
    expect(notArchived.updates.map((u) => u.table)).toEqual([users])

    const noTeam = makeService([
      [user('SENIOR', { archivedAt })],
      [{ teamId: 't1' }],
      [],
      [user('SENIOR')],
    ])
    await noTeam.svc.unarchive('u1', 'a1')
    expect(noTeam.updates.map((u) => u.table)).toEqual([users])

    const noMembership = makeService([[user('SENIOR', { archivedAt })], [], [user('SENIOR')]])
    await noMembership.svc.unarchive('u1', 'a1')
    expect(noMembership.updates.map((u) => u.table)).toEqual([users])
  })

  it('unarchive returns the re-read user row', async () => {
    const row = user('HR', { displayName: 'fresh' })
    const { svc } = makeService([[user('HR', { archivedAt })], [row]])
    await expect(svc.unarchive('u1')).resolves.toBe(row as unknown as User)
  })
})

describe('UserArchiveService.getArchiveImpact', () => {
  const admin = { id: 'a1', role: 'ADMIN' } as SessionUser
  const PENDING = [{ id: 'tx1', type: 'SALARY', amount: '10' }]

  // select order: 1 user lookup, 2 pending warning rows, then role-specific selects.
  function makeImpact(selects: Row[][], firsts: (Row | undefined)[] = []) {
    const queue = [...selects]
    const firstQueue = [...firsts]
    const mk = (rows: Row[]) => {
      const chain: Record<string, unknown> = {}
      chain.from = () => chain
      chain.where = (w: unknown) => {
        wheres.push(w)
        return chain
      }
      chain.then = (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej)
      return chain
    }
    const wheres: unknown[] = []
    const dbInner = {
      select: vi.fn((_projection?: unknown) => mk(queue.shift() ?? [])),
      query: {
        teamMembers: { findFirst: vi.fn(async (_a: unknown) => firstQueue.shift()) },
        teams: { findFirst: vi.fn(async (_a: unknown) => firstQueue.shift()) },
      },
    }
    const svc = new UserArchiveService(
      { db: dbInner } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    return Object.assign(svc, { dbInner, wheres })
  }

  it('rejects non-ADMIN callers before reading anything', async () => {
    const svc = makeImpact([])
    await expect(
      svc.getArchiveImpact('u1', { id: 'x', role: 'SENIOR' } as SessionUser),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('unknown user -> 404', async () => {
    await expect(makeImpact([[]]).getArchiveImpact('u1', admin)).rejects.toMatchObject({
      status: 404,
    })
  })

  it('ADMIN target', async () => {
    const svc = makeImpact([[user('ADMIN')], PENDING])
    await expect(svc.getArchiveImpact('u1', admin)).resolves.toEqual({
      type: 'user',
      role: 'ADMIN',
      noDependencies: true,
      pendingTransactions: PENDING,
    })
  })

  it('HR / ACCOUNTANT: teamsCount', async () => {
    for (const role of ['HR', 'ACCOUNTANT']) {
      const svc = makeImpact([[user(role)], PENDING, [{ teamId: 't1' }, { teamId: 't2' }]])
      const probe = svc.getArchiveImpact('u1', admin)
      await expect(probe).resolves.toEqual({
        type: 'user',
        role,
        teamsCount: 2,
        pendingTransactions: PENDING,
      })
      expect(svc.dbInner.select).toHaveBeenCalledWith({ teamId: teamMembers.teamId })
    }
  })

  it('JUNIOR: projectsCount', async () => {
    const svc = makeImpact([[user('JUNIOR')], PENDING, [{ projectId: 'p1' }]])
    await expect(svc.getArchiveImpact('u1', admin)).resolves.toEqual({
      type: 'user',
      role: 'JUNIOR',
      projectsCount: 1,
      pendingTransactions: PENDING,
    })
    expect(svc.dbInner.select).toHaveBeenCalledWith({ projectId: projectMembers.projectId })
  })

  for (const role of ['SENIOR', 'DROP'] as const) {
    it(`${role}: paired counts, team name, other members, juniors`, async () => {
      const svc = makeImpact(
        [
          [user(role)],
          PENDING,
          [{ userId: 'h1' }, { userId: 'h2' }],
          [
            { id: 'p1', name: 'Alpha' },
            { id: 'p2', name: 'Beta' },
          ],
          [{ userId: 'j1' }, { userId: 'j2' }, { userId: 'j3' }],
        ],
        [{ teamId: 't1' }, { id: 't1', name: 'Team One' }],
      )
      const out = await svc.getArchiveImpact('u1', admin)
      const sel = svc.dbInner.select
      expect(sel).toHaveBeenCalledWith({ userId: teamMembers.userId })
      expect(sel).toHaveBeenCalledWith({ id: projects.id, name: projects.name })
      expect(sel).toHaveBeenCalledWith({ userId: projectMembers.userId })
      expect(svc.dbInner.query.teamMembers.findFirst).toHaveBeenCalledWith({
        where: expect.anything(),
      })
      expect(svc.dbInner.query.teams.findFirst).toHaveBeenCalledWith({
        where: expect.anything(),
      })
      const juniorsWhere = svc.wheres[svc.wheres.length - 1] as SQL
      expect(new PgDialect().sqlToQuery(juniorsWhere).params).toEqual(['p1', 'p2'])
      expect(out).toEqual({
        type: 'user',
        role,
        isPaired: true,
        teamName: 'Team One',
        projectsCount: 2,
        projectNames: ['Alpha', 'Beta'],
        juniorsAffected: 3,
        hrAccountantsOnTeam: 2,
        pendingTransactions: PENDING,
      })
    })

    it(`${role}: no team, no projects -> zeros and null team name`, async () => {
      const svc = makeImpact([[user(role)], PENDING, []], [undefined])
      const out = await svc.getArchiveImpact('u1', admin)
      // user, pending, projects only: no junior lookup for an empty project list
      expect(svc.dbInner.select).toHaveBeenCalledTimes(3)
      expect(out).toEqual({
        type: 'user',
        role,
        isPaired: true,
        teamName: null,
        projectsCount: 0,
        projectNames: [],
        juniorsAffected: 0,
        hrAccountantsOnTeam: 0,
        pendingTransactions: PENDING,
      })
    })

    it(`${role}: team row missing -> teamName null but members still counted`, async () => {
      const svc = makeImpact(
        [[user(role)], PENDING, [{ userId: 'h1' }], []],
        [{ teamId: 't1' }, undefined],
      )
      const out = await svc.getArchiveImpact('u1', admin)
      expect(out).toMatchObject({ teamName: null, hrAccountantsOnTeam: 1, juniorsAffected: 0 })
    })
  }
})

describe('UserArchiveService.archiveDrop', () => {
  const admin = { id: 'a1', role: 'ADMIN' } as SessionUser

  it('non-ADMIN actor -> 403 before any transaction', async () => {
    const { svc, tx } = makeService([])
    await expect(
      svc.archiveDrop('d1', { id: 'x', role: 'SENIOR' } as SessionUser),
    ).rejects.toMatchObject({ status: 403 })
    expect(tx.select).not.toHaveBeenCalled()
  })

  it('missing -> 404; non-DROP -> 400; already archived -> 400', async () => {
    await expect(makeService([[]]).svc.archiveDrop('d1', admin)).rejects.toMatchObject({
      status: 404,
    })
    const nonDrop = makeService([[user('HR')]])
    await expect(nonDrop.svc.archiveDrop('d1', admin)).rejects.toMatchObject({ status: 400 })
    expect(nonDrop.updates).toHaveLength(0)
    const archived = makeService([[user('DROP', { archivedAt: new Date() })]])
    await expect(archived.svc.archiveDrop('d1', admin)).rejects.toMatchObject({ status: 400 })
    expect(archived.updates).toHaveLength(0)
  })

  it('cascades via archiveDropTeam, returns its result, audits with impersonator id', async () => {
    const result = { archivedProjects: 2, detachedSeniorId: 's1' }
    const { svc, teamsService, audit, updates, tx } = makeService(
      [[user('DROP')], [{ teamId: 't1' }]],
      { archiveDropTeam: vi.fn().mockResolvedValue(result) },
    )
    const out = await svc.archiveDrop('d1', { ...admin, impersonatorId: 'imp1' } as SessionUser)
    expect(out).toBe(result)
    expect(teamsService.archiveDropTeam).toHaveBeenCalledWith('t1', tx)
    expect(updates.map((u) => u.table)).toEqual([users])
    expect(updates[0]!.set.archivedAt).toBeInstanceOf(Date)
    expect(updates[0]!.set.updatedAt).toBeInstanceOf(Date)
    const [p, ptx] = audit.record.mock.calls[0]!
    expect(p).toMatchObject({ actorId: 'imp1', targetId: 'd1', action: 'user_archived' })
    expect(p.changes.archivedAt.before).toBeNull()
    expect(p.changes.archivedAt.after).toMatch(ISO)
    expect(ptx).toBe(tx)
  })

  it('locks the drop row FOR UPDATE', async () => {
    const { svc, forCalls } = makeService([[user('DROP')], []])
    await svc.archiveDrop('d1', admin)
    expect(forCalls).toEqual(['update'])
  })

  it('no team: zero result, actor id used when not impersonating', async () => {
    const { svc, teamsService, audit } = makeService([[user('DROP')], []])
    const out = await svc.archiveDrop('d1', admin)
    expect(out).toEqual({ archivedProjects: 0, detachedSeniorId: null })
    expect(teamsService.archiveDropTeam).not.toHaveBeenCalled()
    expect(audit.record.mock.calls[0]![0]).toMatchObject({ actorId: 'a1' })
  })
})
