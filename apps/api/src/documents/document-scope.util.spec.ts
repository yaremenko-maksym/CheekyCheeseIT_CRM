import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import type { HrAccessService } from '../common/hr-access.service'
import { getHrSeniorIds, getTeammateIds } from './document-scope.util'

const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

interface Call {
  join: boolean
  where: { sql: string; params: unknown[] }
}

/** db double: each select() consumes the next queued result; records the rendered WHERE. */
function makeDb(results: unknown[][]) {
  const calls: Call[] = []
  const queue = [...results]
  const select = vi.fn(() => {
    let join = false
    const chain = {
      from: () => chain,
      innerJoin: () => {
        join = true
        return chain
      },
      where: (w: SQL) => {
        calls.push({ join, where: render(w) })
        return Promise.resolve(queue.shift() ?? [])
      },
    }
    return chain
  })
  return { db: { db: { select } } as unknown as DatabaseService, calls, select }
}

function hrAccessWith(peers: { userId: string; role: 'SENIOR' | 'HR' | 'JUNIOR' }[]) {
  const getActiveTeamPeers = vi.fn(async () => peers)
  return { svc: { getActiveTeamPeers } as unknown as HrAccessService, getActiveTeamPeers }
}

describe('getHrSeniorIds', () => {
  it('returns [] and skips the senior query when the HR has no active team', async () => {
    const { db, calls } = makeDb([[]])
    expect(await getHrSeniorIds(db, 'hr-1')).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('scopes the HR team lookup to userId + leftAt IS NULL', async () => {
    const { db, calls } = makeDb([[]])
    await getHrSeniorIds(db, 'hr-1')
    expect(calls[0]!.join).toBe(false)
    expect(calls[0]!.where.sql).toContain('"team_members"."user_id" = $1')
    expect(calls[0]!.where.sql).toContain('"team_members"."left_at" is null')
    expect(calls[0]!.where.sql).toContain(' and ')
    expect(calls[0]!.where.params).toEqual(['hr-1'])
  })

  it('returns senior ids from the shared active teams, filtered by role SENIOR + leftAt IS NULL', async () => {
    const { db, calls } = makeDb([
      [{ teamId: 't-1' }, { teamId: 't-2' }],
      [{ userId: 's-1' }, { userId: 's-2' }],
    ])
    expect(await getHrSeniorIds(db, 'hr-1')).toEqual(['s-1', 's-2'])
    expect(calls).toHaveLength(2)
    expect(calls[1]!.join).toBe(true)
    expect(calls[1]!.where.sql).toContain('"team_members"."team_id" in ($1, $2)')
    expect(calls[1]!.where.sql).toContain('"users"."role" = $3')
    expect(calls[1]!.where.sql).toContain('"team_members"."left_at" is null')
    expect(calls[1]!.where.params).toEqual(['t-1', 't-2', 'SENIOR'])
  })

  it('returns [] when teams exist but hold no seniors', async () => {
    const { db } = makeDb([[{ teamId: 't-1' }], []])
    expect(await getHrSeniorIds(db, 'hr-1')).toEqual([])
  })
})

describe('getTeammateIds', () => {
  it('SENIOR with no peers and no projects: only the actor', async () => {
    const { db, calls } = makeDb([[]])
    const { svc, getActiveTeamPeers } = hrAccessWith([])
    expect(await getTeammateIds(db, svc, 'sr-1', 'SENIOR')).toEqual(['sr-1'])
    expect(getActiveTeamPeers).toHaveBeenCalledWith('sr-1')
    // SENIOR is its own seniorId -> project lookup runs once, no member lookup
    expect(calls).toHaveLength(1)
    expect(calls[0]!.where.params).toEqual(['sr-1'])
  })

  it('HR with no peers: only the actor, no db queries at all', async () => {
    const { db, select } = makeDb([])
    const { svc } = hrAccessWith([])
    expect(await getTeammateIds(db, svc, 'hr-1', 'HR')).toEqual(['hr-1'])
    expect(select).not.toHaveBeenCalled()
  })

  it('HR with only non-SENIOR peers: peers added, project roster NOT expanded', async () => {
    const { db, select } = makeDb([])
    const { svc } = hrAccessWith([
      { userId: 'hr-2', role: 'HR' },
      { userId: 'j-9', role: 'JUNIOR' },
    ])
    const ids = await getTeammateIds(db, svc, 'hr-1', 'HR')
    expect(ids.sort()).toEqual(['hr-1', 'hr-2', 'j-9'])
    expect(select).not.toHaveBeenCalled()
  })

  it('HR: only SENIOR peers seed the project lookup, and their juniors are added', async () => {
    const { db, calls } = makeDb([
      [{ id: 'p-1' }, { id: 'p-2' }],
      [{ userId: 'j-1' }, { userId: 'j-2' }],
    ])
    const { svc } = hrAccessWith([
      { userId: 'sr-1', role: 'SENIOR' },
      { userId: 'hr-2', role: 'HR' },
    ])
    const ids = await getTeammateIds(db, svc, 'hr-1', 'HR')
    expect(ids.sort()).toEqual(['hr-1', 'hr-2', 'j-1', 'j-2', 'sr-1'])
    expect(calls).toHaveLength(2)
    // project lookup bound to the SENIOR peer only (not the HR peer / the HR actor)
    expect(calls[0]!.where.params).toEqual(['sr-1'])
    // member lookup: those projects, active members only
    expect(calls[1]!.where.params).toEqual(['p-1', 'p-2'])
    expect(calls[1]!.where.sql).toContain('"project_members"."left_at" is null')
    expect(calls[1]!.where.sql).toContain('"project_members"."project_id" in ($1, $2)')
  })

  it('SENIOR actor: uses itself as the senior (ignores peer roles) and expands its project juniors', async () => {
    const { db, calls } = makeDb([[{ id: 'p-1' }], [{ userId: 'j-1' }]])
    const { svc } = hrAccessWith([{ userId: 'sr-2', role: 'SENIOR' }])
    const ids = await getTeammateIds(db, svc, 'sr-1', 'SENIOR')
    expect(ids.sort()).toEqual(['j-1', 'sr-1', 'sr-2'])
    expect(calls[0]!.where.params).toEqual(['sr-1'])
  })

  it('no member lookup when the seniors own no visible projects', async () => {
    const { db, calls } = makeDb([[]])
    const { svc } = hrAccessWith([{ userId: 'sr-1', role: 'SENIOR' }])
    expect(await getTeammateIds(db, svc, 'hr-1', 'HR')).toEqual(['hr-1', 'sr-1'])
    expect(calls).toHaveLength(1)
  })

  it('de-duplicates ids (junior that is also a peer)', async () => {
    const { db } = makeDb([[{ id: 'p-1' }], [{ userId: 'j-1' }]])
    const { svc } = hrAccessWith([
      { userId: 'sr-1', role: 'SENIOR' },
      { userId: 'j-1', role: 'JUNIOR' },
    ])
    const ids = await getTeammateIds(db, svc, 'hr-1', 'HR')
    expect(ids.filter((i) => i === 'j-1')).toHaveLength(1)
  })
})
