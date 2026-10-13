/**
 * Characterization (unit) net for the team-reconcile cluster (TeamReconcileService, extracted from UsersService):
 * `reconcileSeniorTeamTx`, `updateSeniorTeamTelegramChannelTx`,
 * `upsertTeamMemberTx`.
 *
 * Before this spec the cluster was covered only by real-Postgres integration
 * specs, which the mutation gate cannot see. This pins the CURRENT observable
 * behaviour over a recording tx-double: every statement the methods issue is
 * logged in order with its table, its payload and its WHERE clause compiled
 * to SQL + params (PgDialect), so predicate mutants (dropped `leftAt IS NULL`,
 * swapped columns, `and`->`or`) are visible.
 *
 * Harness: `TeamReconcileService` is built directly with a recording audit
 * double (its only dep). Originally written against UsersService; repointed
 * when the cluster moved into the collaborator.
 *
 * None of the three methods writes the `users` table (they write
 * `team_members` / `teams` and read `users` only via a JOIN), so the
 * user-emails writer-inventory spec is not affected.
 */
import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName, type SQL } from 'drizzle-orm'
import { TeamReconcileService } from './team-reconcile.service'

type LogEntry =
  | {
      op: 'select'
      table: string
      where: string
      params: unknown[]
      joined: boolean
      fields?: Record<string, string>
      join?: { table: string; on: string; params: unknown[] }
    }
  | { op: 'update'; table: string; set: Record<string, unknown>; where: string; params: unknown[] }
  | { op: 'insert'; table: string; values: unknown }
  | { op: 'audit'; entry: Record<string, unknown>; tx: unknown }

const dialect = new PgDialect()
const compile = (cond: SQL | undefined) => {
  if (!cond) return { sql: '', params: [] as unknown[] }
  const q = dialect.sqlToQuery(cond)
  return { sql: q.sql, params: q.params }
}

/**
 * Default role of a staff id probed by `assertTeamStaffRoles` (SR-M-1 follow-up): `hr-*` are
 * HR, `acc-*` ACCOUNTANT; `staff` overrides per id (an id mapped to `null` is archived/unknown,
 * i.e. absent from the probe result).
 */
const defaultStaffRole = (id: string): string | null =>
  id.startsWith('hr-') ? 'HR' : id.startsWith('acc-') ? 'ACCOUNTANT' : null

/**
 * Recording tx-double. `selects` is consumed FIFO, one entry per `tx.select()`. The team-staff
 * role probe (`users` select by id list) is answered out-of-band from `staff` and recorded in
 * `probes`, NOT in `log`/the FIFO, so the pre-existing positional assertions are untouched.
 */
function makeHarness(selects: unknown[][], staff: Record<string, string | null> = {}) {
  const log: LogEntry[] = []
  const probes: Array<{ where: string; params: unknown[]; logLenAtProbe: number }> = []
  const queue = [...selects]
  const tx = {
    select: vi.fn((fieldMap?: Record<string, { name: string; table: never }>) => {
      let table = ''
      let joined = false
      let join: { table: string; on: string; params: unknown[] } | undefined
      // Projection map `{ alias: 'table.column' }` — pins what the SELECT returns.
      const fields = fieldMap
        ? Object.fromEntries(
            Object.entries(fieldMap).map(([k, c]) => [k, `${getTableName(c.table)}.${c.name}`]),
          )
        : undefined
      const chain = {
        from: (t: never) => {
          table = getTableName(t)
          return chain
        },
        innerJoin: (t: never, on: SQL) => {
          joined = true
          const c = compile(on)
          join = { table: getTableName(t), on: c.sql, params: c.params }
          return chain
        },
        where: (cond: SQL) => {
          const { sql, params } = compile(cond)
          if (table === 'users' && !joined) {
            probes.push({ where: sql, params, logLenAtProbe: log.length })
            const rows = params
              .map((id) => ({
                id: id as string,
                role:
                  (id as string) in staff ? staff[id as string] : defaultStaffRole(id as string),
              }))
              .filter((r) => r.role !== null)
            const p = Promise.resolve(rows)
            return { then: p.then.bind(p) }
          }
          log.push({ op: 'select', table, where: sql, params, joined, fields, join })
          const rows = queue.shift()
          if (rows === undefined) throw new Error('unexpected extra tx.select()')
          const p = Promise.resolve(rows)
          return { then: p.then.bind(p) }
        },
      }
      return chain
    }),
    update: vi.fn((t: never) => ({
      set: (set: Record<string, unknown>) => ({
        where: async (cond: SQL) => {
          const { sql, params } = compile(cond)
          log.push({ op: 'update', table: getTableName(t), set, where: sql, params })
        },
      }),
    })),
    insert: vi.fn((t: never) => ({
      values: async (values: unknown) => {
        log.push({ op: 'insert', table: getTableName(t), values })
      },
    })),
  }
  const record = vi.fn(async (entry: Record<string, unknown>, passedTx: unknown) => {
    log.push({ op: 'audit', entry, tx: passedTx })
  })
  const service = new TeamReconcileService({ record } as never)
  const priv = service as unknown as {
    reconcileSeniorTeamTx: (
      tx: unknown,
      seniorId: string,
      data: { hrIds?: string[]; accountantId?: string | null },
      actorId: string | null,
    ) => Promise<void>
    updateSeniorTeamTelegramChannelTx: (
      tx: unknown,
      seniorId: string,
      value: string | null,
      actorId: string | null,
    ) => Promise<void>
    upsertTeamMemberTx: (tx: unknown, teamId: string, userId: string) => Promise<void>
  }
  return { tx, log, probes, priv, record, remaining: () => queue.length }
}

const ACTIVE_WHERE_USER = '("team_members"."user_id" = $1 and "team_members"."left_at" is null)'
const MEMBER_BY_TEAM_USER = '("team_members"."team_id" = $1 and "team_members"."user_id" = $2)'
const REMOVE_WHERE =
  '("team_members"."team_id" = $1 and "team_members"."user_id" = $2 and "team_members"."left_at" is null)'
const ACTIVE_BY_TEAM = '("team_members"."team_id" = $1 and "team_members"."left_at" is null)'

describe('TeamReconcileService.upsertTeamMemberTx', () => {
  it('inserts a fresh team_members row when none exists', async () => {
    const h = makeHarness([[]])
    await h.priv.upsertTeamMemberTx(h.tx, 'team-1', 'u-1')
    expect(h.log).toEqual([
      {
        op: 'select',
        table: 'team_members',
        where: MEMBER_BY_TEAM_USER,
        params: ['team-1', 'u-1'],
        joined: false,
      },
      { op: 'insert', table: 'team_members', values: { teamId: 'team-1', userId: 'u-1' } },
    ])
  })

  it('restores a previously-left member by clearing leftAt on that row id (no insert)', async () => {
    const h = makeHarness([[{ id: 'tm-9', leftAt: new Date('2026-01-01T00:00:00Z') }]])
    await h.priv.upsertTeamMemberTx(h.tx, 'team-1', 'u-1')
    expect(h.log).toEqual([
      {
        op: 'select',
        table: 'team_members',
        where: MEMBER_BY_TEAM_USER,
        params: ['team-1', 'u-1'],
        joined: false,
      },
      {
        op: 'update',
        table: 'team_members',
        set: { leftAt: null },
        where: '"team_members"."id" = $1',
        params: ['tm-9'],
      },
    ])
    expect(h.tx.insert).not.toHaveBeenCalled()
  })

  it('is a no-op when the member is already active (leftAt null)', async () => {
    const h = makeHarness([[{ id: 'tm-9', leftAt: null }]])
    await h.priv.upsertTeamMemberTx(h.tx, 'team-1', 'u-1')
    expect(h.log).toHaveLength(1)
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.tx.insert).not.toHaveBeenCalled()
  })
})

describe('TeamReconcileService.updateSeniorTeamTelegramChannelTx', () => {
  it('resolves the team via the senior ACTIVE membership, then updates channel + writes team_updated audit', async () => {
    const h = makeHarness([[{ teamId: 'team-1' }], [{ id: 'team-1', telegramChannel: '@old' }]])
    vi.useFakeTimers()
    const frozen = new Date('2026-06-01T12:00:00.000Z')
    vi.setSystemTime(frozen)
    try {
      await h.priv.updateSeniorTeamTelegramChannelTx(h.tx, 'sn-1', '@new', 'admin-1')
    } finally {
      vi.useRealTimers()
    }

    expect(h.log).toHaveLength(4)
    expect(h.log[0]).toEqual({
      op: 'select',
      table: 'team_members',
      where: ACTIVE_WHERE_USER,
      params: ['sn-1'],
      joined: false,
    })
    expect(h.log[1]).toEqual({
      op: 'select',
      table: 'teams',
      where: '"teams"."id" = $1',
      params: ['team-1'],
      joined: false,
    })
    const upd = h.log[2] as Extract<LogEntry, { op: 'update' }>
    expect(upd.table).toBe('teams')
    expect(upd.where).toBe('"teams"."id" = $1')
    expect(upd.params).toEqual(['team-1'])
    expect(Object.keys(upd.set).sort()).toEqual(['telegramChannel', 'updatedAt'])
    expect(upd.set.telegramChannel).toBe('@new')
    expect(upd.set.updatedAt).toEqual(frozen)
    expect(h.log[3]).toEqual({
      op: 'audit',
      entry: {
        actorId: 'admin-1',
        targetId: 'team-1',
        action: 'team_updated',
        changes: { telegramChannel: { before: '@old', after: '@new' } },
      },
      tx: h.tx,
    })
  })

  it('clears the channel (undefined-ish -> null) and audits before/after with null', async () => {
    const h = makeHarness([[{ teamId: 'team-1' }], [{ id: 'team-1', telegramChannel: '@old' }]])
    await h.priv.updateSeniorTeamTelegramChannelTx(h.tx, 'sn-1', null, null)
    const upd = h.log[2] as Extract<LogEntry, { op: 'update' }>
    expect(upd.set.telegramChannel).toBeNull()
    expect((h.log[3] as Extract<LogEntry, { op: 'audit' }>).entry).toEqual({
      actorId: null,
      targetId: 'team-1',
      action: 'team_updated',
      changes: { telegramChannel: { before: '@old', after: null } },
    })
  })

  it('treats a null stored channel as previous=null and records before:null', async () => {
    const h = makeHarness([[{ teamId: 'team-1' }], [{ id: 'team-1', telegramChannel: null }]])
    await h.priv.updateSeniorTeamTelegramChannelTx(h.tx, 'sn-1', '@x', 'a')
    expect((h.log[3] as Extract<LogEntry, { op: 'audit' }>).entry.changes).toEqual({
      telegramChannel: { before: null, after: '@x' },
    })
  })

  it('is a no-op (no update, no audit) when the value is unchanged', async () => {
    const h = makeHarness([[{ teamId: 'team-1' }], [{ id: 'team-1', telegramChannel: '@same' }]])
    await h.priv.updateSeniorTeamTelegramChannelTx(h.tx, 'sn-1', '@same', 'a')
    expect(h.log).toHaveLength(2)
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })

  it('is a no-op when null is requested and the stored channel is already null', async () => {
    const h = makeHarness([[{ teamId: 'team-1' }], [{ id: 'team-1', telegramChannel: null }]])
    await h.priv.updateSeniorTeamTelegramChannelTx(h.tx, 'sn-1', null, 'a')
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })

  it('returns silently (single select) when the senior has no active membership', async () => {
    const h = makeHarness([[]])
    await h.priv.updateSeniorTeamTelegramChannelTx(h.tx, 'sn-1', '@x', 'a')
    expect(h.log).toHaveLength(1)
    expect(h.remaining()).toBe(0)
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })

  it('returns silently when the membership points at a missing team row', async () => {
    const h = makeHarness([[{ teamId: 'team-1' }], []])
    await h.priv.updateSeniorTeamTelegramChannelTx(h.tx, 'sn-1', '@x', 'a')
    expect(h.log).toHaveLength(2)
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })
})

describe('TeamReconcileService.reconcileSeniorTeamTx', () => {
  const membership = [{ teamId: 'team-1' }]
  const actives = (rows: Array<{ userId: string; id: string; role: string }>) => rows

  const removedAudit = (actor: string | null, userId: string, role: string) => ({
    op: 'audit',
    entry: {
      actorId: actor,
      targetId: 'team-1',
      action: 'team_member_removed',
      changes: { userId: { before: userId, after: null }, role: { before: role, after: null } },
    },
  })
  const addedAudit = (actor: string | null, userId: string, role: string) => ({
    op: 'audit',
    entry: {
      actorId: actor,
      targetId: 'team-1',
      action: 'team_member_added',
      changes: { userId: { before: null, after: userId }, role: { before: null, after: role } },
    },
  })

  it('returns without touching anything when the senior has no active membership', async () => {
    const h = makeHarness([[]])
    await h.priv.reconcileSeniorTeamTx(
      h.tx,
      'sn-1',
      { hrIds: ['hr-1'], accountantId: 'acc-1' },
      'a',
    )
    expect(h.log).toEqual([
      {
        op: 'select',
        table: 'team_members',
        where: ACTIVE_WHERE_USER,
        params: ['sn-1'],
        joined: false,
      },
    ])
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.tx.insert).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })

  it('loads active members of the resolved team via a users JOIN and does nothing when both fields are undefined', async () => {
    const h = makeHarness([membership, actives([{ userId: 'hr-1', id: 'tm-1', role: 'HR' }])])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', {}, 'a')
    expect(h.log).toEqual([
      {
        op: 'select',
        table: 'team_members',
        where: ACTIVE_WHERE_USER,
        params: ['sn-1'],
        joined: false,
      },
      {
        op: 'select',
        table: 'team_members',
        where: ACTIVE_BY_TEAM,
        params: ['team-1'],
        joined: true,
        fields: {
          userId: 'team_members.user_id',
          id: 'team_members.id',
          role: 'users.role',
        },
        join: { table: 'users', on: '"users"."id" = "team_members"."user_id"', params: [] },
      },
    ])
    expect(h.record).not.toHaveBeenCalled()
  })

  it('hrIds: removes HRs absent from the desired set (leftAt=now, active-only predicate) and audits each', async () => {
    const h = makeHarness([
      membership,
      actives([
        { userId: 'hr-1', id: 'tm-1', role: 'HR' },
        { userId: 'hr-2', id: 'tm-2', role: 'HR' },
        { userId: 'acc-1', id: 'tm-3', role: 'ACCOUNTANT' },
        { userId: 'sn-1', id: 'tm-4', role: 'SENIOR' },
      ]),
    ])
    const before = Date.now()
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: ['hr-2'] }, 'admin-1')
    const after = Date.now()

    expect(h.log).toHaveLength(4)
    const upd = h.log[2] as Extract<LogEntry, { op: 'update' }>
    expect(upd.table).toBe('team_members')
    expect(upd.where).toBe(REMOVE_WHERE)
    expect(upd.params).toEqual(['team-1', 'hr-1'])
    expect(Object.keys(upd.set)).toEqual(['leftAt'])
    const leftAt = upd.set.leftAt as Date
    expect(leftAt).toBeInstanceOf(Date)
    expect(leftAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(leftAt.getTime()).toBeLessThanOrEqual(after)
    expect(h.log[3]).toEqual({ ...removedAudit('admin-1', 'hr-1', 'HR'), tx: h.tx })
    expect(h.tx.insert).not.toHaveBeenCalled()
  })

  it('hrIds: only HR-role members count as current (ACCOUNTANT/SENIOR are never removed by hrIds)', async () => {
    const h = makeHarness([
      membership,
      actives([
        { userId: 'acc-1', id: 'tm-3', role: 'ACCOUNTANT' },
        { userId: 'sn-1', id: 'tm-4', role: 'SENIOR' },
      ]),
    ])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: [] }, 'a')
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })

  it('hrIds: adds a brand-new HR via upsert (select by team+user, insert) then audits team_member_added', async () => {
    const h = makeHarness([membership, actives([]), []])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: ['hr-9'] }, 'admin-1')
    expect(h.log.slice(2)).toEqual([
      {
        op: 'select',
        table: 'team_members',
        where: MEMBER_BY_TEAM_USER,
        params: ['team-1', 'hr-9'],
        joined: false,
      },
      { op: 'insert', table: 'team_members', values: { teamId: 'team-1', userId: 'hr-9' } },
      { ...addedAudit('admin-1', 'hr-9', 'HR'), tx: h.tx },
    ])
  })

  it('hrIds: re-joining a previously-left HR clears leftAt on the existing row (no duplicate insert) and still audits added', async () => {
    const h = makeHarness([
      membership,
      actives([]),
      [{ id: 'tm-old', leftAt: new Date('2026-02-02T00:00:00Z') }],
    ])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: ['hr-9'] }, 'admin-1')
    expect(h.log.slice(3)).toEqual([
      {
        op: 'update',
        table: 'team_members',
        set: { leftAt: null },
        where: '"team_members"."id" = $1',
        params: ['tm-old'],
      },
      { ...addedAudit('admin-1', 'hr-9', 'HR'), tx: h.tx },
    ])
    expect(h.tx.insert).not.toHaveBeenCalled()
  })

  it('hrIds: kept HRs produce no writes; mixed diff removes before adds, in input order', async () => {
    const h = makeHarness([
      membership,
      actives([
        { userId: 'hr-keep', id: 'tm-1', role: 'HR' },
        { userId: 'hr-a', id: 'tm-2', role: 'HR' },
        { userId: 'hr-b', id: 'tm-3', role: 'HR' },
      ]),
      [],
      [],
    ])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: ['hr-keep', 'hr-n1', 'hr-n2'] }, 'x')
    const writes = h.log.slice(2).map((e) => {
      if (e.op === 'update') return `update:${String(e.params[1])}`
      if (e.op === 'insert') return `insert:${String((e.values as { userId: string }).userId)}`
      if (e.op === 'audit')
        return `audit:${String(e.entry.action)}:${JSON.stringify(e.entry.changes)}`
      return 'select'
    })
    expect(writes).toEqual([
      'update:hr-a',
      `audit:team_member_removed:${JSON.stringify({ userId: { before: 'hr-a', after: null }, role: { before: 'HR', after: null } })}`,
      'update:hr-b',
      `audit:team_member_removed:${JSON.stringify({ userId: { before: 'hr-b', after: null }, role: { before: 'HR', after: null } })}`,
      'select',
      'insert:hr-n1',
      `audit:team_member_added:${JSON.stringify({ userId: { before: null, after: 'hr-n1' }, role: { before: null, after: 'HR' } })}`,
      'select',
      'insert:hr-n2',
      `audit:team_member_added:${JSON.stringify({ userId: { before: null, after: 'hr-n2' }, role: { before: null, after: 'HR' } })}`,
    ])
  })

  it('hrIds: duplicate ids in the input are de-duplicated (one add)', async () => {
    const h = makeHarness([membership, actives([]), []])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: ['hr-9', 'hr-9'] }, 'a')
    expect(h.tx.insert).toHaveBeenCalledTimes(1)
    expect(h.record).toHaveBeenCalledTimes(1)
  })

  it('accountantId: swapping accountant removes the old (audit role ACCOUNTANT) then adds the new', async () => {
    const h = makeHarness([
      membership,
      actives([{ userId: 'acc-old', id: 'tm-3', role: 'ACCOUNTANT' }]),
      [],
    ])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: 'acc-new' }, 'admin-1')
    const upd = h.log[2] as Extract<LogEntry, { op: 'update' }>
    expect(upd.where).toBe(REMOVE_WHERE)
    expect(upd.params).toEqual(['team-1', 'acc-old'])
    expect(upd.set.leftAt).toBeInstanceOf(Date)
    expect(h.log[3]).toEqual({ ...removedAudit('admin-1', 'acc-old', 'ACCOUNTANT'), tx: h.tx })
    expect(h.log.slice(4)).toEqual([
      {
        op: 'select',
        table: 'team_members',
        where: MEMBER_BY_TEAM_USER,
        params: ['team-1', 'acc-new'],
        joined: false,
      },
      { op: 'insert', table: 'team_members', values: { teamId: 'team-1', userId: 'acc-new' } },
      { ...addedAudit('admin-1', 'acc-new', 'ACCOUNTANT'), tx: h.tx },
    ])
  })

  it('accountantId: null removes the current accountant and adds nobody', async () => {
    const h = makeHarness([
      membership,
      actives([{ userId: 'acc-old', id: 'tm-3', role: 'ACCOUNTANT' }]),
    ])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: null }, null)
    expect(h.log).toHaveLength(4)
    expect(h.log[3]).toEqual({ ...removedAudit(null, 'acc-old', 'ACCOUNTANT'), tx: h.tx })
    expect(h.tx.insert).not.toHaveBeenCalled()
  })

  it('accountantId: assigning when none is current only adds (no removal)', async () => {
    const h = makeHarness([membership, actives([]), []])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: 'acc-new' }, 'a')
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.log.slice(2).map((e) => e.op)).toEqual(['select', 'insert', 'audit'])
  })

  it('accountantId: null when none is current is a no-op', async () => {
    const h = makeHarness([membership, actives([])])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: null }, 'a')
    expect(h.log).toHaveLength(2)
    expect(h.record).not.toHaveBeenCalled()
  })

  it('accountantId: same accountant as current is a no-op (no remove/add churn)', async () => {
    const h = makeHarness([
      membership,
      actives([{ userId: 'acc-1', id: 'tm-3', role: 'ACCOUNTANT' }]),
    ])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: 'acc-1' }, 'a')
    expect(h.log).toHaveLength(2)
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })

  it('accountantId: re-joining a previously-left accountant restores the row via upsert', async () => {
    const h = makeHarness([
      membership,
      actives([]),
      [{ id: 'tm-old', leftAt: new Date('2026-03-03T00:00:00Z') }],
    ])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: 'acc-1' }, 'a')
    expect(h.log[3]).toEqual({
      op: 'update',
      table: 'team_members',
      set: { leftAt: null },
      where: '"team_members"."id" = $1',
      params: ['tm-old'],
    })
    expect(h.tx.insert).not.toHaveBeenCalled()
    expect(h.log[4]).toEqual({ ...addedAudit('a', 'acc-1', 'ACCOUNTANT'), tx: h.tx })
  })

  it('hrIds are processed before accountantId when both are given, sharing one `now` for leftAt', async () => {
    const h = makeHarness([
      membership,
      actives([
        { userId: 'hr-1', id: 'tm-1', role: 'HR' },
        { userId: 'acc-1', id: 'tm-3', role: 'ACCOUNTANT' },
      ]),
    ])
    // Frozen clock that ticks forward before every UPDATE: a `new Date()` taken
    // inside the loop would observe a later instant than the single `now`.
    vi.useFakeTimers()
    const frozen = new Date('2026-06-01T12:00:00.000Z')
    vi.setSystemTime(frozen)
    const realUpdate = h.tx.update
    h.tx.update = vi.fn((t: never) => {
      vi.advanceTimersByTime(7)
      return realUpdate(t)
    })
    try {
      await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: [], accountantId: null }, 'a')
    } finally {
      vi.useRealTimers()
    }
    const updates = h.log.filter((e): e is Extract<LogEntry, { op: 'update' }> => e.op === 'update')
    expect(updates.map((u) => u.params[1])).toEqual(['hr-1', 'acc-1'])
    expect(updates[0]!.set.leftAt).toEqual(frozen)
    expect(updates[1]!.set.leftAt).toEqual(frozen)
    expect(
      h.record.mock.calls.map(
        (c) => (c[0] as { changes: { role: { before: string } } }).changes.role.before,
      ),
    ).toEqual(['HR', 'ACCOUNTANT'])
    // every audit row is written on the SAME tx handle
    for (const c of h.record.mock.calls) expect(c[1]).toBe(h.tx)
  })
})

describe('TeamReconcileService.reconcileSeniorTeamTx — SR-M-1 team-staff role invariant', () => {
  const membership = [{ teamId: 'team-1' }]
  const code = (c: string) => ({ response: { code: c }, status: 400 })
  const nothingWritten = (h: ReturnType<typeof makeHarness>) => {
    expect(h.tx.update).not.toHaveBeenCalled()
    expect(h.tx.insert).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  }

  it.each([
    ['a non-HR user', { 'user-x': 'ADMIN' }],
    ['an archived/unknown user', { 'user-x': null }],
  ])(
    'rejects %s in hrIds with 400 TEAM_HR_MEMBER_MUST_BE_HR, nothing written',
    async (_n, staff) => {
      // hr-1 would be REMOVED (absent from desired) — it must not be removed when the add is rejected.
      const h = makeHarness(
        [membership, [{ userId: 'hr-1', id: 'tm-1', role: 'HR' }]],
        staff as Record<string, string | null>,
      )
      await expect(
        h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { hrIds: ['user-x'] }, 'admin-1'),
      ).rejects.toMatchObject(code('TEAM_HR_MEMBER_MUST_BE_HR'))
      nothingWritten(h)
    },
  )

  it.each([
    ['a non-ACCOUNTANT user', { 'user-x': 'HR' }],
    ['an archived/unknown user', { 'user-x': null }],
  ])(
    'rejects %s as accountantId with 400 TEAM_ACCOUNTANT_MUST_BE_ACCOUNTANT, nothing written',
    async (_n, staff) => {
      const h = makeHarness([membership, []], staff as Record<string, string | null>)
      await expect(
        h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: 'user-x' }, 'admin-1'),
      ).rejects.toMatchObject(code('TEAM_ACCOUNTANT_MUST_BE_ACCOUNTANT'))
      nothingWritten(h)
    },
  )

  it('probes ONLY the newly enrolled ids, once, before the first write; valid staff succeed', async () => {
    const h = makeHarness([
      membership,
      [
        { userId: 'hr-keep', id: 'tm-1', role: 'HR' },
        { userId: 'hr-old', id: 'tm-2', role: 'HR' },
        { userId: 'acc-old', id: 'tm-3', role: 'ACCOUNTANT' },
      ],
      [],
      [],
    ])
    await h.priv.reconcileSeniorTeamTx(
      h.tx,
      'sn-1',
      { hrIds: ['hr-keep', 'hr-new'], accountantId: 'acc-new' },
      'admin-1',
    )
    expect(h.probes).toEqual([
      {
        where: '("users"."id" in ($1, $2) and "users"."archived_at" is null)',
        params: ['hr-new', 'acc-new'],
        logLenAtProbe: 2,
      },
    ])
    expect(h.log.filter((e) => e.op === 'insert')).toHaveLength(2)
  })

  it('already-active HRs and an unchanged accountant are not re-probed (archived incumbents do not block edits)', async () => {
    const h = makeHarness(
      [
        membership,
        [
          { userId: 'hr-1', id: 'tm-1', role: 'HR' },
          { userId: 'acc-1', id: 'tm-2', role: 'ACCOUNTANT' },
        ],
      ],
      { 'hr-1': null, 'acc-1': null },
    )
    await h.priv.reconcileSeniorTeamTx(
      h.tx,
      'sn-1',
      { hrIds: ['hr-1'], accountantId: 'acc-1' },
      'admin-1',
    )
    expect(h.probes).toEqual([])
    nothingWritten(h)
  })

  it('clearing the accountant (null) needs no role check', async () => {
    const h = makeHarness([membership, [{ userId: 'acc-1', id: 'tm-3', role: 'ACCOUNTANT' }]])
    await h.priv.reconcileSeniorTeamTx(h.tx, 'sn-1', { accountantId: null }, 'admin-1')
    expect(h.probes).toEqual([])
    expect(h.tx.update).toHaveBeenCalledTimes(1)
  })
})
