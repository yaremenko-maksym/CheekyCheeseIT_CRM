import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { projectMembers, projects } from '../database/schema'
import type { UsersService } from '../users/users.service'
import { ProjectArchiveService } from './project-archive.service'
import type { ProjectAuditLogService } from './project-audit-log.service'
import type { ProjectReadService } from './project-read.service'

const admin: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatar: null,
  seniorSharePercent: 26,
}
const impersonated: SessionUser = { ...admin, id: 'target-9', impersonatorId: 'real-admin' }
const hr: SessionUser = { ...admin, id: 'hr-1', role: 'HR' }

const FOUND = { sentinel: 'findOne-result' }

interface Recorded {
  selectArgs: unknown[]
  updates: { table: unknown; values: Record<string, unknown> }[]
}

/** Scriptable transaction: `select()` chains resolve the queued results in call order. */
function makeHarness(selectResults: unknown[][]) {
  const rec: Recorded = { selectArgs: [], updates: [] }
  const queue = [...selectResults]
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['from', 'innerJoin', 'where']) c[m] = () => c
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej)
    return c
  }
  const tx = {
    select: (arg?: unknown) => {
      rec.selectArgs.push(arg)
      return chain(queue.shift())
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        rec.updates.push({ table, values })
        return { where: () => Promise.resolve() }
      },
    }),
  }
  const findFirst = vi.fn()
  const dbHandle = {
    transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    query: { projects: { findFirst } },
    select: (arg?: unknown) => {
      rec.selectArgs.push(arg)
      return chain(queue.shift())
    },
  }
  const record = vi.fn().mockResolvedValue(undefined)
  const unarchivePairTx = vi.fn().mockResolvedValue(undefined)
  const findOne = vi.fn().mockResolvedValue(FOUND)
  const service = new ProjectArchiveService(
    { db: dbHandle } as unknown as DatabaseService,
    { record } as unknown as ProjectAuditLogService,
    { unarchivePairTx } as unknown as UsersService,
    { findOne } as unknown as ProjectReadService,
  )
  return { service, rec, tx, record, unarchivePairTx, findOne, findFirst }
}

describe('ProjectArchiveService.archive', () => {
  it('rejects non-ADMIN before touching the db', async () => {
    const h = makeHarness([])
    await expect(h.service.archive('p1', hr)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.rec.selectArgs).toHaveLength(0)
  })

  it('404s on a missing project and 400s on an already archived one', async () => {
    const missing = makeHarness([[]])
    await expect(missing.service.archive('p1', admin)).rejects.toMatchObject({ status: 404 })
    const archived = makeHarness([[{ id: 'p1', archivedAt: new Date() }]])
    const err: unknown = await archived.service.archive('p1', admin).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(400)
    expect(archived.rec.updates).toHaveLength(0)
  })

  it('archives, closes active junior memberships and audits each (real operator under impersonation)', async () => {
    const h = makeHarness([
      [{ id: 'p1', archivedAt: null }],
      [
        { id: 'pm-1', userId: 'j1', role: 'JUNIOR' },
        { id: 'pm-2', userId: 'j2', role: 'JUNIOR' },
      ],
    ])
    const result = await h.service.archive('p1', impersonated)

    expect(result).toBe(FOUND)
    expect(h.findOne).toHaveBeenCalledWith('p1', impersonated)
    // second select is the active-junior lookup, with the exact projection
    expect(h.rec.selectArgs[1]).toEqual({
      id: projectMembers.id,
      userId: projectMembers.userId,
      role: expect.anything(),
    })
    const [projUpdate, memberUpdate] = h.rec.updates
    expect(projUpdate?.table).toBe(projects)
    const now = projUpdate?.values.archivedAt as Date
    expect(now).toBeInstanceOf(Date)
    expect(projUpdate?.values).toEqual({ archivedAt: now, updatedAt: now })
    expect(memberUpdate?.table).toBe(projectMembers)
    expect(memberUpdate?.values).toEqual({ leftAt: now })

    expect(h.record).toHaveBeenCalledTimes(3)
    expect(h.record).toHaveBeenNthCalledWith(
      1,
      {
        actorId: 'real-admin',
        targetId: 'p1',
        action: 'project_member_removed',
        changes: { userId: { before: 'j1', after: null } },
      },
      h.tx,
    )
    expect(h.record).toHaveBeenNthCalledWith(
      2,
      {
        actorId: 'real-admin',
        targetId: 'p1',
        action: 'project_member_removed',
        changes: { userId: { before: 'j2', after: null } },
      },
      h.tx,
    )
    expect(h.record).toHaveBeenNthCalledWith(
      3,
      {
        actorId: 'real-admin',
        targetId: 'p1',
        action: 'project_archived',
        changes: { archivedAt: { before: null, after: now.toISOString() } },
      },
      h.tx,
    )
  })

  it('with no active juniors writes only the project row and the single archive audit row', async () => {
    const h = makeHarness([[{ id: 'p1', archivedAt: null }], []])
    await h.service.archive('p1', admin)
    expect(h.rec.updates).toHaveLength(1)
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'admin-1', action: 'project_archived' }),
      h.tx,
    )
  })
})

describe('ProjectArchiveService.unarchive', () => {
  const archivedAt = new Date('2026-01-02T03:04:05.000Z')
  const project = { id: 'p1', seniorId: 's1', archivedAt }
  const senior = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    displayName: 'Sen',
    archivedAt: null,
    ...over,
  })

  it('rejects non-ADMIN, missing and not-archived projects', async () => {
    await expect(makeHarness([]).service.unarchive('p1', hr)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(makeHarness([[]]).service.unarchive('p1', admin)).rejects.toMatchObject({
      status: 404,
    })
    const notArchived = makeHarness([[{ ...project, archivedAt: null }]])
    const err: unknown = await notArchived.service.unarchive('p1', admin).catch((e: unknown) => e)
    expect((err as HttpException).getStatus()).toBe(400)
  })

  it('unarchives a clean project (no cascade), restoring nothing else, auditing with before=previous', async () => {
    const h = makeHarness([
      [project],
      [senior()],
      [{ teamId: 't1' }],
      [{ id: 't1', name: 'Team', archivedAt: null }],
    ])
    const result = await h.service.unarchive('p1', impersonated)

    expect(result).toBe(FOUND)
    expect(h.unarchivePairTx).not.toHaveBeenCalled()
    expect(h.rec.updates).toHaveLength(1)
    expect(h.rec.updates[0]?.table).toBe(projects)
    expect(h.rec.updates[0]?.values).toEqual({ archivedAt: null, updatedAt: expect.any(Date) })
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.record).toHaveBeenCalledWith(
      {
        actorId: 'real-admin',
        targetId: 'p1',
        action: 'project_unarchived',
        changes: { archivedAt: { before: archivedAt.toISOString(), after: null } },
      },
      h.tx,
    )
  })

  it('actor is the session user when not impersonating', async () => {
    const h = makeHarness([[project], [senior()], [], []])
    await h.service.unarchive('p1', admin)
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-1' }), h.tx)
  })

  it('409s with the archived senior listed when cascade is not requested', async () => {
    const h = makeHarness([[project], [senior({ archivedAt: new Date() })], [], []])
    const err: unknown = await h.service.unarchive('p1', admin).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictException)
    expect((err as ConflictException).getResponse()).toEqual({
      requiresCascade: true,
      entities: [{ type: 'user', id: 's1', name: 'Sen' }],
    })
    expect(h.rec.updates).toHaveLength(0)
    expect(h.record).not.toHaveBeenCalled()
  })

  it('409 lists senior then archived team, with exact entity shape', async () => {
    const h = makeHarness([
      [project],
      [senior({ archivedAt: new Date() })],
      [{ teamId: 't1' }],
      [{ id: 't1', name: 'Team', archivedAt: new Date() }],
    ])
    const err: unknown = await h.service.unarchive('p1', admin).catch((e: unknown) => e)
    expect((err as ConflictException).getResponse()).toEqual({
      requiresCascade: true,
      entities: [
        { type: 'user', id: 's1', name: 'Sen' },
        { type: 'team', id: 't1', name: 'Team' },
      ],
    })
  })

  it('409s on an archived team alone (senior active)', async () => {
    const h = makeHarness([
      [project],
      [senior()],
      [{ teamId: 't1' }],
      [{ id: 't1', name: 'Team', archivedAt: new Date() }],
    ])
    const err: unknown = await h.service.unarchive('p1', admin).catch((e: unknown) => e)
    expect((err as ConflictException).getResponse()).toEqual({
      requiresCascade: true,
      entities: [{ type: 'team', id: 't1', name: 'Team' }],
    })
  })

  it('cascade with archived senior pair-unarchives inside the same tx, attributed to the real operator', async () => {
    const h = makeHarness([
      [project],
      [senior({ archivedAt: new Date() })],
      [{ teamId: 't1' }],
      [{ id: 't1', name: 'Team', archivedAt: new Date() }],
    ])
    await h.service.unarchive('p1', impersonated, true)
    expect(h.unarchivePairTx).toHaveBeenCalledTimes(1)
    expect(h.unarchivePairTx).toHaveBeenCalledWith(h.tx, 's1', 'real-admin')
    expect(h.rec.updates).toHaveLength(1)
    expect(h.record).toHaveBeenCalledTimes(1)
  })

  it('cascade=true with an active senior does not pair-unarchive (archived team only)', async () => {
    const h = makeHarness([
      [project],
      [senior()],
      [{ teamId: 't1' }],
      [{ id: 't1', name: 'Team', archivedAt: new Date() }],
    ])
    await h.service.unarchive('p1', admin, true)
    expect(h.unarchivePairTx).not.toHaveBeenCalled()
    expect(h.rec.updates).toHaveLength(1)
  })

  it('tolerates a project whose senior row is gone (cascade requested)', async () => {
    const h = makeHarness([[project], []])
    await expect(h.service.unarchive('p1', admin, true)).resolves.toBe(FOUND)
    expect(h.unarchivePairTx).not.toHaveBeenCalled()
    // no membership/team lookup without a senior: only project + senior selects ran
    expect(h.rec.selectArgs).toHaveLength(2)
  })

  it('tolerates a senior with no team membership', async () => {
    const h = makeHarness([[project], [senior()], []])
    await expect(h.service.unarchive('p1', admin)).resolves.toBe(FOUND)
    expect(h.rec.selectArgs).toHaveLength(3)
  })

  it('tolerates a membership whose team row is missing', async () => {
    const h = makeHarness([[project], [senior()], [{ teamId: 't1' }], []])
    await expect(h.service.unarchive('p1', admin)).resolves.toBe(FOUND)
    expect(h.rec.selectArgs).toHaveLength(4)
  })
})

describe('ProjectArchiveService.getArchiveImpact', () => {
  it('rejects non-ADMIN', async () => {
    const h = makeHarness([])
    await expect(h.service.getArchiveImpact('p1', hr)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.findFirst).not.toHaveBeenCalled()
  })

  it('404s when the project is missing', async () => {
    const h = makeHarness([])
    h.findFirst.mockResolvedValue(undefined)
    await expect(h.service.getArchiveImpact('p1', admin)).rejects.toMatchObject({ status: 404 })
  })

  it('counts only the active juniors returned for the project', async () => {
    const h = makeHarness([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]])
    h.findFirst.mockResolvedValue({ id: 'p1' })
    await expect(h.service.getArchiveImpact('p1', admin)).resolves.toEqual({
      type: 'project',
      activeMembersCount: 3,
    })
    expect(h.findFirst).toHaveBeenCalledWith({ where: expect.anything() })
    expect(h.rec.selectArgs[0]).toEqual({ id: projectMembers.id })
  })
})
