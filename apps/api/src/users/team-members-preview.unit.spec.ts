/**
 * Characterization net — UsersService.getTeamMembersForUser(userId, viewerRole).
 *
 * Pins the CURRENT observable behavior before the method is extracted: the
 * exact ordered sequence of drizzle queries per target role (table, join,
 * projection, compiled WHERE + bound params, via PgDialect) and the
 * viewer-role JUNIOR masking applied to whatever the queries return.
 *
 * Complements `get-team-members-drop-branch-mask.unit.spec.ts` (loose
 * `toContain` assertions against an in-memory store); this file asserts the
 * exact SQL/params, ordering, dedup, self-exclusion and the per-viewer matrix.
 *
 * Harness: `Object.create(UsersService.prototype)` + a scripted db-double that
 * answers `db.select(...)` calls strictly in call order and records each chain.
 * Real-Postgres semantics (actual joins/filters) are NOT exercised here — the
 * compiled WHERE is what proves the filter is present; the data flow between
 * queries is proven by feeding scripted rows and asserting the next query's
 * bound params.
 */
import { describe, expect, it } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { UsersService } from './users.service'

const dialect = new PgDialect()

interface RecordedQuery {
  table: string | null
  join: string | null
  /** `undefined` => `.select()` with no projection (findById). */
  fields: Record<string, string> | undefined
  sql: string
  params: unknown[]
}

function makeHarness(responses: unknown[][]) {
  const recorded: RecordedQuery[] = []
  const queue = [...responses]
  const db = {
    select: (fields?: Record<string, { name: string; table: unknown }>) => {
      const rec: RecordedQuery = {
        table: null,
        join: null,
        fields:
          fields === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(fields).map(([k, c]) => [
                  k,
                  `${getTableName(c.table as never)}.${c.name}`,
                ]),
              ),
        sql: '',
        params: [],
      }
      recorded.push(rec)
      const chain = {
        from: (t: unknown) => {
          rec.table = getTableName(t as never)
          return chain
        },
        innerJoin: (t: unknown) => {
          rec.join = getTableName(t as never)
          return chain
        },
        where: (cond: SQL) => {
          const q = dialect.sqlToQuery(cond)
          rec.sql = q.sql
          rec.params = q.params
          return chain
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (queue.length === 0) throw new Error('db-double: unexpected extra query')
          return Promise.resolve(queue.shift()).then(resolve, reject)
        },
      }
      return chain
    },
  }
  const service = Object.assign(Object.create(UsersService.prototype), {
    db: { db },
  }) as UsersService
  return { service, recorded, remaining: () => queue.length }
}

const PREVIEW_FIELDS = {
  id: 'users.id',
  displayName: 'users.display_name',
  role: 'users.role',
  avatarUrl: 'users.avatar_url',
  avatarDocumentId: 'users.avatar_document_id',
}

function preview(id: string, role: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    displayName: `name-${id}`,
    role,
    avatarUrl: null,
    avatarDocumentId: null,
    ...extra,
  }
}

function target(id: string, role: string) {
  return { id, role, displayName: `target-${id}` }
}

/** Compact per-query view used by order assertions. */
const shape = (q: RecordedQuery) => [q.table, q.join, q.fields ? Object.keys(q.fields) : null]

describe('getTeamMembersForUser — target lookup', () => {
  it('throws USER_NOT_FOUND (404) after exactly one query when the target does not exist', async () => {
    const h = makeHarness([[]])
    await expect(h.service.getTeamMembersForUser('ghost', 'ADMIN')).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: 'USER_NOT_FOUND' }),
    })
    expect(h.recorded).toHaveLength(1)
    expect(h.recorded[0]).toEqual({
      table: 'users',
      join: null,
      fields: undefined,
      sql: '"users"."id" = $1',
      params: ['ghost'],
    })
  })
})

describe('getTeamMembersForUser — DROP target', () => {
  it('runs exactly findById -> own active memberships -> teammates, with exact SQL', async () => {
    const mates = [preview('hr-1', 'HR'), preview('acc-1', 'ACCOUNTANT')]
    const h = makeHarness([[target('d1', 'DROP')], [{ teamId: 't1' }, { teamId: 't2' }], mates])

    const out = await h.service.getTeamMembersForUser('d1', 'ADMIN')

    expect(out).toEqual(mates)
    expect(h.remaining()).toBe(0)
    expect(h.recorded).toHaveLength(3)
    expect(h.recorded[1]).toEqual({
      table: 'team_members',
      join: null,
      fields: { teamId: 'team_members.team_id' },
      sql: '("team_members"."user_id" = $1 and "team_members"."left_at" is null)',
      params: ['d1'],
    })
    expect(h.recorded[2]).toEqual({
      table: 'team_members',
      join: 'users',
      fields: PREVIEW_FIELDS,
      sql: '("team_members"."team_id" in ($1, $2) and "team_members"."left_at" is null and "users"."id" <> $3)',
      params: ['t1', 't2', 'd1'],
    })
  })

  it('zero memberships still issues the teammates query with `false` (guard removed on purpose), returns []', async () => {
    const h = makeHarness([[target('d1', 'DROP')], [], []])
    const out = await h.service.getTeamMembersForUser('d1', 'ADMIN')
    expect(out).toEqual([])
    expect(h.recorded).toHaveLength(3)
    expect(h.recorded[2]?.sql).toBe(
      '(false and "team_members"."left_at" is null and "users"."id" <> $1)',
    )
    expect(h.recorded[2]?.params).toEqual(['d1'])
  })

  it('does not dedupe or reorder the teammate rows (passthrough)', async () => {
    const a = preview('x', 'HR')
    const b = preview('y', 'ACCOUNTANT')
    const h = makeHarness([[target('d1', 'DROP')], [{ teamId: 't1' }], [b, a, b]])
    const out = await h.service.getTeamMembersForUser('d1', 'ADMIN')
    expect(out).toEqual([b, a, b])
  })
})

describe('getTeamMembersForUser — SENIOR target', () => {
  it('derives rosters from [own id]: memberships -> team ids -> team members -> projects -> juniors -> users', async () => {
    const final = [preview('hr-1', 'HR'), preview('j-1', 'JUNIOR')]
    const h = makeHarness([
      [target('s1', 'SENIOR')],
      [{ teamId: 't1' }, { teamId: 't1' }, { teamId: 't2' }], // dup team id
      [{ userId: 's1' }, { userId: 'hr-1' }, { userId: 'acc-1' }],
      [{ id: 'p1' }, { id: 'p2' }],
      [{ userId: 'j-1' }, { userId: 'hr-1' }], // hr-1 repeated -> Set dedup
      final,
    ])

    const out = await h.service.getTeamMembersForUser('s1', 'ADMIN')

    expect(out).toEqual(final)
    expect(h.remaining()).toBe(0)
    expect(h.recorded.slice(1).map(shape)).toEqual([
      ['team_members', 'users', ['teamId']],
      ['team_members', null, ['userId']],
      ['projects', null, ['id']],
      ['project_members', null, ['userId']],
      ['users', null, ['id', 'displayName', 'role', 'avatarUrl', 'avatarDocumentId']],
    ])
    // Step 2a: senior membership rows, active only, joined user must be a SENIOR.
    expect(h.recorded[1]).toEqual({
      table: 'team_members',
      join: 'users',
      fields: { teamId: 'team_members.team_id' },
      sql: '("team_members"."user_id" in ($1) and "users"."role" = $2 and "team_members"."left_at" is null)',
      params: ['s1', 'SENIOR'],
    })
    // team ids deduped, first-seen order.
    expect(h.recorded[2]).toEqual({
      table: 'team_members',
      join: null,
      fields: { userId: 'team_members.user_id' },
      sql: '("team_members"."team_id" in ($1, $2) and "team_members"."left_at" is null)',
      params: ['t1', 't2'],
    })
    // Step 3: raw seniorIds (not membership-derived), no leftAt filter on projects.
    expect(h.recorded[3]).toEqual({
      table: 'projects',
      join: null,
      fields: { id: 'projects.id' },
      sql: '"projects"."senior_id" in ($1)',
      params: ['s1'],
    })
    expect(h.recorded[4]).toEqual({
      table: 'project_members',
      join: null,
      fields: { userId: 'project_members.user_id' },
      sql: '("project_members"."project_id" in ($1, $2) and "project_members"."left_at" is null)',
      params: ['p1', 'p2'],
    })
    // Final: team members first (insertion order), then juniors, deduped, self removed.
    expect(h.recorded[5]).toEqual({
      table: 'users',
      join: null,
      fields: PREVIEW_FIELDS,
      sql: '"users"."id" in ($1, $2, $3)',
      params: ['hr-1', 'acc-1', 'j-1'],
    })
  })

  it('removes the target itself even when it only appears among project juniors', async () => {
    const h = makeHarness([
      [target('s1', 'SENIOR')],
      [{ teamId: 't1' }],
      [],
      [{ id: 'p1' }],
      [{ userId: 's1' }, { userId: 'j-1' }],
      [],
    ])
    await h.service.getTeamMembersForUser('s1', 'ADMIN')
    expect(h.recorded[5]?.params).toEqual(['j-1'])
  })

  it('no team and no projects: later queries still run with `false`, result []', async () => {
    const h = makeHarness([[target('s1', 'SENIOR')], [], [], [], [], []])
    const out = await h.service.getTeamMembersForUser('s1', 'ADMIN')
    expect(out).toEqual([])
    expect(h.recorded).toHaveLength(6)
    expect(h.recorded[2]?.sql).toBe('(false and "team_members"."left_at" is null)')
    expect(h.recorded[4]?.sql).toBe('(false and "project_members"."left_at" is null)')
    expect(h.recorded[5]?.sql).toBe('false')
    expect(h.recorded[5]?.params).toEqual([])
  })
})

describe('getTeamMembersForUser — JUNIOR target', () => {
  it('resolves seniors from the junior’s ACTIVE project memberships (deduped), then proceeds as for a senior', async () => {
    const h = makeHarness([
      [target('j1', 'JUNIOR')],
      [{ seniorId: 'sA' }, { seniorId: 'sB' }, { seniorId: 'sA' }],
      [{ teamId: 't1' }],
      [{ userId: 'sA' }, { userId: 'hr-1' }],
      [{ id: 'p1' }],
      [{ userId: 'j1' }, { userId: 'j2' }],
      [preview('sA', 'SENIOR')],
    ])

    const out = await h.service.getTeamMembersForUser('j1', 'ADMIN')

    expect(out).toEqual([preview('sA', 'SENIOR')])
    expect(h.recorded).toHaveLength(7)
    expect(h.recorded[1]).toEqual({
      table: 'project_members',
      join: 'projects',
      fields: { seniorId: 'projects.senior_id' },
      sql: '("project_members"."user_id" = $1 and "project_members"."left_at" is null)',
      params: ['j1'],
    })
    expect(h.recorded[2]?.params).toEqual(['sA', 'sB', 'SENIOR'])
    expect(h.recorded[4]?.params).toEqual(['sA', 'sB'])
    // junior target excludes self from the final roster
    expect(h.recorded[6]?.params).toEqual(['sA', 'hr-1', 'j2'])
  })
})

describe.each(['HR', 'ACCOUNTANT'] as const)('getTeamMembersForUser — %s target', (role) => {
  it('walks own active teams -> SENIORs of those teams (active) -> same pipeline', async () => {
    const h = makeHarness([
      [target('u1', role)],
      [{ teamId: 't1' }, { teamId: 't2' }],
      [{ userId: 'sA' }, { userId: 'sA' }, { userId: 'sB' }],
      [{ teamId: 't9' }],
      [{ userId: 'sA' }],
      [],
      [],
      [preview('sA', 'SENIOR')],
    ])

    const out = await h.service.getTeamMembersForUser('u1', 'ADMIN')

    expect(out).toEqual([preview('sA', 'SENIOR')])
    expect(h.recorded).toHaveLength(8)
    expect(h.recorded[1]).toEqual({
      table: 'team_members',
      join: null,
      fields: { teamId: 'team_members.team_id' },
      sql: '("team_members"."user_id" = $1 and "team_members"."left_at" is null)',
      params: ['u1'],
    })
    expect(h.recorded[2]).toEqual({
      table: 'team_members',
      join: 'users',
      fields: { userId: 'team_members.user_id' },
      sql: '("team_members"."team_id" in ($1, $2) and "users"."role" = $3 and "team_members"."left_at" is null)',
      params: ['t1', 't2', 'SENIOR'],
    })
    // seniors deduped before Step 2
    expect(h.recorded[3]?.params).toEqual(['sA', 'sB', 'SENIOR'])
    expect(h.recorded[5]?.params).toEqual(['sA', 'sB'])
  })

  it('no own memberships: query with `false`, and the rest of the pipeline still runs', async () => {
    const h = makeHarness([[target('u1', role)], [], [], [], [], [], [], []])
    const out = await h.service.getTeamMembersForUser('u1', 'ADMIN')
    expect(out).toEqual([])
    expect(h.recorded).toHaveLength(8)
    expect(h.recorded[2]?.sql).toBe(
      '(false and "users"."role" = $1 and "team_members"."left_at" is null)',
    )
    expect(h.recorded[2]?.params).toEqual(['SENIOR'])
  })
})

describe('getTeamMembersForUser — ADMIN target', () => {
  it('derives nothing: seniorIds stays [] and Step 2/3 + final query run against `false`', async () => {
    const h = makeHarness([[target('a1', 'ADMIN')], [], [], [], [], []])
    const out = await h.service.getTeamMembersForUser('a1', 'ADMIN')
    expect(out).toEqual([])
    expect(h.recorded).toHaveLength(6)
    expect(h.recorded[1]?.sql).toBe(
      '(false and "users"."role" = $1 and "team_members"."left_at" is null)',
    )
    expect(h.recorded[1]?.params).toEqual(['SENIOR'])
    expect(h.recorded[3]?.sql).toBe('false')
    expect(h.recorded[3]?.params).toEqual([])
  })
})

describe('getTeamMembersForUser — viewer-role masking (RBAC core)', () => {
  const rows = [
    preview('hr-1', 'HR', { avatarUrl: 'https://a/hr.png', avatarDocumentId: 'doc-1' }),
    preview('j-1', 'JUNIOR'),
    preview('s-2', 'SENIOR'),
    preview('acc-1', 'ACCOUNTANT'),
    preview('j-2', 'JUNIOR'),
  ]

  it('SENIOR viewer: every JUNIOR row is stripped (non-DROP target), others keep order and full shape', async () => {
    const h = makeHarness([[target('s1', 'SENIOR')], [], [], [], [], rows])
    const out = await h.service.getTeamMembersForUser('s1', 'SENIOR')
    expect(out).toEqual([rows[0], rows[2], rows[3]])
    expect(out[0]).toEqual({
      id: 'hr-1',
      displayName: 'name-hr-1',
      role: 'HR',
      avatarUrl: 'https://a/hr.png',
      avatarDocumentId: 'doc-1',
    })
  })

  it('SENIOR viewer: JUNIOR rows stripped on the DROP branch too', async () => {
    const h = makeHarness([[target('d1', 'DROP')], [{ teamId: 't1' }], rows])
    const out = await h.service.getTeamMembersForUser('d1', 'SENIOR')
    expect(out.map((r) => r.id)).toEqual(['hr-1', 's-2', 'acc-1'])
  })

  it('SENIOR viewer on a JUNIOR target: junior peers are masked', async () => {
    const h = makeHarness([[target('j1', 'JUNIOR')], [{ seniorId: 'sA' }], [], [], [], [], rows])
    const out = await h.service.getTeamMembersForUser('j1', 'SENIOR')
    expect(out.map((r) => r.id)).toEqual(['hr-1', 's-2', 'acc-1'])
  })

  it.each(['ADMIN', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const)(
    '%s viewer: roster is returned unfiltered (JUNIOR rows kept, same order)',
    async (viewer) => {
      const h = makeHarness([[target('s1', 'SENIOR')], [], [], [], [], rows])
      const out = await h.service.getTeamMembersForUser('s1', viewer)
      expect(out).toEqual(rows)
      expect(out.map((r) => r.id)).toEqual(['hr-1', 'j-1', 's-2', 'acc-1', 'j-2'])
    },
  )

  it.each(['ADMIN', 'HR', 'ACCOUNTANT', 'JUNIOR', 'DROP'] as const)(
    '%s viewer on a DROP target: unfiltered passthrough',
    async (viewer) => {
      const h = makeHarness([[target('d1', 'DROP')], [{ teamId: 't1' }], rows])
      const out = await h.service.getTeamMembersForUser('d1', viewer)
      expect(out).toEqual(rows)
    },
  )

  it('masking never mutates scripted input and an all-JUNIOR roster becomes [] for SENIOR', async () => {
    const onlyJuniors = [preview('j-1', 'JUNIOR'), preview('j-2', 'JUNIOR')]
    const h = makeHarness([[target('s1', 'SENIOR')], [], [], [], [], onlyJuniors])
    const out = await h.service.getTeamMembersForUser('s1', 'SENIOR')
    expect(out).toEqual([])
    expect(onlyJuniors).toHaveLength(2)
  })
})
