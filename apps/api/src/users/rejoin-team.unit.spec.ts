/**
 * Characterization (unit) net for `UsersService.rejoinTeam`, pinned BEFORE it is
 * extracted from users.service.ts.
 *
 * `rejoinTeam` is the self-service rejoin primitive behind
 * `POST /users/me/rejoin-team` for a teamless SENIOR. It never writes `users`
 * and writes no audit row: it only reads `users` (findById) + `team_members`,
 * and writes `teams` / `team_members` (CREATE_NEW, one transaction) or delegates
 * to `TeamsService` (JOIN_DROP_TEAM). The caller-must-be-SENIOR RBAC gate lives
 * on the controller (403); the service re-checks defensively (400).
 *
 * Harness: `Object.assign(Object.create(UsersService.prototype), {...})` (house
 * convention). Real, un-stubbed: `findById` (-> loadUserById). Stubbed:
 * `teamsService.wasFormerMemberOfTeam` / `addSeniorToDropTeam`. Every statement
 * is logged in order with the handle it ran on (`tx` vs plain `db`); WHEREs are
 * compiled to SQL + params through PgDialect.
 */
import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName, type SQL } from 'drizzle-orm'
import { UsersService } from './users.service'
// r5 4.6 S5: the roster dirty producers are proven in job-sourcing; here they are inert.
vi.mock('../job-sourcing/dirty-producers')

const dialect = new PgDialect()
const compile = (cond: SQL | undefined) => {
  if (!cond) return { sql: '', params: [] as unknown[] }
  const q = dialect.sqlToQuery(cond)
  return { sql: q.sql, params: q.params }
}

type Input = Parameters<UsersService['rejoinTeam']>[1]
type Log = Array<Record<string, unknown>>
type Row = Record<string, unknown>

const SENIOR_ID = 'senior-1'
const NEW_TEAM_ID = 'team-new'

const makeUser = (over: Row = {}): Row => ({
  id: SENIOR_ID,
  role: 'SENIOR',
  displayName: 'Ivan Petrenko',
  ...over,
})

interface HarnessOpts {
  /** row returned by findById; `null` => not found */
  user?: Row | null
  /** active team_members row; absent => teamless */
  activeMembership?: Row
  /** wasFormerMemberOfTeam result */
  former?: boolean
  /** rows returned by INSERT teams ... RETURNING */
  insertedTeams?: Row[]
  /** error thrown by the Nth (0-based) team_members insert */
  failMemberInsertAt?: number
  /** role per staff id for the team-staff probe; `null` => archived/unknown (absent from result) */
  staff?: Record<string, string | null>
}

/** Default probe role: `hr-*` are HR, `acc-*` ACCOUNTANT; anything else is unknown. */
const defaultStaffRole = (id: string): string | null =>
  id.startsWith('hr-') ? 'HR' : id.startsWith('acc-') ? 'ACCOUNTANT' : null

function makeHarness(opts: HarnessOpts = {}) {
  const log: Log = []
  const probes: Array<{ on: string; where: string; params: unknown[]; logLen: number }> = []
  const staff = opts.staff ?? {}
  const user = 'user' in opts ? opts.user : makeUser()
  let memberInserts = 0

  const makeHandle = (on: 'tx' | 'db') => ({
    select: (fields?: unknown) => ({
      from: (t: never) => ({
        where: (cond: SQL) => {
          const c = compile(cond)
          const table = getTableName(t)
          if (fields && table === 'users') {
            // SR-M-1 team-staff role probe: answered out-of-band so the positional log is untouched.
            probes.push({ on, where: c.sql, params: c.params, logLen: log.length })
            return Promise.resolve(
              c.params
                .map((id) => ({
                  id: id as string,
                  role:
                    (id as string) in staff ? staff[id as string] : defaultStaffRole(id as string),
                }))
                .filter((r) => r.role !== null),
            )
          }
          log.push({ op: 'select', on, table, where: c.sql, params: c.params })
          const rows =
            table === 'users'
              ? user
                ? [user]
                : []
              : table === 'team_members' && opts.activeMembership
                ? [opts.activeMembership]
                : []
          return Promise.resolve(rows)
        },
      }),
    }),
    insert: (t: never) => ({
      values: (values: Row) => {
        const table = getTableName(t)
        if (table === 'teams') {
          return {
            returning: async () => {
              log.push({ op: 'insert', on, table, values })
              return opts.insertedTeams ?? [{ id: NEW_TEAM_ID, ...values }]
            },
          }
        }
        const idx = memberInserts++
        const run = async () => {
          log.push({ op: 'insert', on, table, values })
          if (opts.failMemberInsertAt === idx) throw new Error('member insert failed')
        }
        return { then: (res: never, rej: never) => run().then(res, rej) }
      },
    }),
  })

  const tx = makeHandle('tx')
  const db = {
    ...makeHandle('db'),
    transaction: vi.fn(async (fn: (t: unknown) => unknown) => {
      log.push({ op: 'tx-begin' })
      const out = await fn(tx)
      log.push({ op: 'tx-end' })
      return out
    }),
  }

  const wasFormerMemberOfTeam = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'wasFormer', args })
    return opts.former ?? true
  })
  const addSeniorToDropTeam = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'addToDrop', args })
  })

  const service = Object.assign(Object.create(UsersService.prototype) as UsersService, {
    db: { db },
    teamsService: { wasFormerMemberOfTeam, addSeniorToDropTeam },
  })
  return { service, log, probes, db, wasFormerMemberOfTeam, addSeniorToDropTeam }
}

const code = (c: string, statusCode: number) => ({
  response: expect.objectContaining({ code: c, statusCode }),
})
const ops = (log: Log) => log.map((e) => e.op)
const rejoin = (h: ReturnType<typeof makeHarness>, data: Input) =>
  h.service.rejoinTeam(SENIOR_ID, data)

const USER_SELECT = {
  op: 'select',
  on: 'db',
  table: 'users',
  where: '"users"."id" = $1',
  params: [SENIOR_ID],
}
const MEMBERSHIP_SELECT = {
  op: 'select',
  on: 'db',
  table: 'team_members',
  where: '("team_members"."user_id" = $1 and "team_members"."left_at" is null)',
  params: [SENIOR_ID],
}

describe('UsersService.rejoinTeam — caller gates', () => {
  it('404 USER_NOT_FOUND when the caller row is missing; only the users select ran', async () => {
    const h = makeHarness({ user: null })
    await expect(rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1'] })).rejects.toMatchObject(
      code('USER_NOT_FOUND', 404),
    )
    expect(h.log).toEqual([USER_SELECT])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it.each(['ADMIN', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])(
    '400 REJOIN_TEAM_SENIOR_ONLY for role %s; membership is never probed',
    async (role) => {
      const h = makeHarness({ user: makeUser({ role }) })
      await expect(rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1'] })).rejects.toMatchObject(
        code('REJOIN_TEAM_SENIOR_ONLY', 400),
      )
      expect(h.log).toEqual([USER_SELECT])
      expect(h.db.transaction).not.toHaveBeenCalled()
      expect(h.addSeniorToDropTeam).not.toHaveBeenCalled()
    },
  )

  it('400 ALREADY_HAS_ACTIVE_TEAM when an active (left_at IS NULL) membership exists', async () => {
    const h = makeHarness({ activeMembership: { teamId: 'team-old', userId: SENIOR_ID } })
    await expect(rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1'] })).rejects.toMatchObject(
      code('ALREADY_HAS_ACTIVE_TEAM', 400),
    )
    expect(h.log).toEqual([USER_SELECT, MEMBERSHIP_SELECT])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('ALREADY_HAS_ACTIVE_TEAM wins over JOIN_DROP_TEAM validation (checked before the mode)', async () => {
    const h = makeHarness({ activeMembership: { teamId: 'team-old', userId: SENIOR_ID } })
    await expect(
      rejoin(h, { teamMode: 'JOIN_DROP_TEAM', dropTeamId: 'drop-1' }),
    ).rejects.toMatchObject(code('ALREADY_HAS_ACTIVE_TEAM', 400))
    expect(h.wasFormerMemberOfTeam).not.toHaveBeenCalled()
    expect(h.addSeniorToDropTeam).not.toHaveBeenCalled()
  })
})

describe('UsersService.rejoinTeam — JOIN_DROP_TEAM', () => {
  it.each([undefined, ''])(
    '400 DROP_TEAM_ID_REQUIRED when dropTeamId is %j; no former-member probe',
    async (dropTeamId) => {
      const h = makeHarness()
      const data: Input =
        dropTeamId === undefined
          ? { teamMode: 'JOIN_DROP_TEAM' }
          : { teamMode: 'JOIN_DROP_TEAM', dropTeamId }
      await expect(rejoin(h, data)).rejects.toMatchObject(code('DROP_TEAM_ID_REQUIRED', 400))
      expect(h.log).toEqual([USER_SELECT, MEMBERSHIP_SELECT])
      expect(h.wasFormerMemberOfTeam).not.toHaveBeenCalled()
    },
  )

  it('403 REJOIN_TEAM_MUST_BE_FORMER_MEMBER when the senior never belonged to the drop-team', async () => {
    const h = makeHarness({ former: false })
    await expect(
      rejoin(h, { teamMode: 'JOIN_DROP_TEAM', dropTeamId: 'drop-1' }),
    ).rejects.toMatchObject(code('REJOIN_TEAM_MUST_BE_FORMER_MEMBER', 403))
    expect(h.log).toEqual([
      USER_SELECT,
      MEMBERSHIP_SELECT,
      { op: 'wasFormer', args: ['drop-1', SENIOR_ID] },
    ])
    expect(h.addSeniorToDropTeam).not.toHaveBeenCalled()
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('former member: attaches via addSeniorToDropTeam(dropTeamId, seniorId) and returns the drop-team id', async () => {
    const h = makeHarness({ former: true })
    await expect(
      rejoin(h, { teamMode: 'JOIN_DROP_TEAM', dropTeamId: 'drop-1', hrIds: ['hr-ignored'] }),
    ).resolves.toEqual({ teamId: 'drop-1' })
    // exact order: caller select, membership probe, scope check, then the attach
    expect(h.log).toEqual([
      USER_SELECT,
      MEMBERSHIP_SELECT,
      { op: 'wasFormer', args: ['drop-1', SENIOR_ID] },
      { op: 'addToDrop', args: ['drop-1', SENIOR_ID] },
    ])
    // no direct teams/team_members write and no transaction on this path
    expect(h.db.transaction).not.toHaveBeenCalled()
    expect(ops(h.log)).not.toContain('insert')
  })

  it('propagates a failure of addSeniorToDropTeam (no swallowing)', async () => {
    const h = makeHarness({ former: true })
    h.addSeniorToDropTeam.mockRejectedValueOnce(new Error('drop team full'))
    await expect(rejoin(h, { teamMode: 'JOIN_DROP_TEAM', dropTeamId: 'drop-1' })).rejects.toThrow(
      'drop team full',
    )
  })
})

describe('UsersService.rejoinTeam — CREATE_NEW', () => {
  it.each([undefined, []])(
    '400 HR_REQUIRED_MINIMUM_ONE when hrIds is %j; no transaction opened',
    async (hrIds) => {
      const h = makeHarness()
      const data: Input =
        hrIds === undefined ? { teamMode: 'CREATE_NEW' } : { teamMode: 'CREATE_NEW', hrIds }
      await expect(rejoin(h, data)).rejects.toMatchObject(code('HR_REQUIRED_MINIMUM_ONE', 400))
      expect(h.log).toEqual([USER_SELECT, MEMBERSHIP_SELECT])
      expect(h.db.transaction).not.toHaveBeenCalled()
    },
  )

  it('creates the team then inserts senior, HRs (in order), accountant — all on ONE tx, exact payloads', async () => {
    const h = makeHarness()
    await expect(
      rejoin(h, {
        teamMode: 'CREATE_NEW',
        hrIds: ['hr-1', 'hr-2'],
        accountantId: 'acc-1',
        // must be ignored on this path
        dropTeamId: 'drop-ignored',
      }),
    ).resolves.toEqual({ teamId: NEW_TEAM_ID })
    expect(h.log).toEqual([
      USER_SELECT,
      MEMBERSHIP_SELECT,
      { op: 'tx-begin' },
      { op: 'insert', on: 'tx', table: 'teams', values: { name: 'Команда Ivan Petrenko' } },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        values: { teamId: NEW_TEAM_ID, userId: SENIOR_ID },
      },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        values: { teamId: NEW_TEAM_ID, userId: 'hr-1' },
      },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        values: { teamId: NEW_TEAM_ID, userId: 'hr-2' },
      },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        values: { teamId: NEW_TEAM_ID, userId: 'acc-1' },
      },
      { op: 'tx-end' },
    ])
    expect(h.db.transaction).toHaveBeenCalledTimes(1)
    // the drop-team collaborators are never touched on CREATE_NEW
    expect(h.wasFormerMemberOfTeam).not.toHaveBeenCalled()
    expect(h.addSeniorToDropTeam).not.toHaveBeenCalled()
  })

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['empty string', ''],
  ])('accountantId %s => no accountant membership row', async (_label, accountantId) => {
    const h = makeHarness()
    const data: Input =
      accountantId === undefined
        ? { teamMode: 'CREATE_NEW', hrIds: ['hr-1'] }
        : { teamMode: 'CREATE_NEW', hrIds: ['hr-1'], accountantId }
    await expect(rejoin(h, data)).resolves.toEqual({ teamId: NEW_TEAM_ID })
    const memberRows = h.log.filter((e) => e.op === 'insert' && e.table === 'team_members')
    expect(memberRows.map((e) => (e.values as Row).userId)).toEqual([SENIOR_ID, 'hr-1'])
  })

  it('team name uses the caller displayName of the loaded user row', async () => {
    const h = makeHarness({ user: makeUser({ displayName: 'Olena K' }) })
    await rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1'] })
    const teamInsert = h.log.find((e) => e.op === 'insert' && e.table === 'teams')
    expect(teamInsert?.values).toEqual({ name: 'Команда Olena K' })
  })

  it('throws "Failed to create senior team" and writes no members when the teams insert returns no row', async () => {
    const h = makeHarness({ insertedTeams: [] })
    await expect(rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1'] })).rejects.toThrow(
      'Failed to create senior team',
    )
    expect(h.log.filter((e) => e.table === 'team_members' && e.op === 'insert')).toEqual([])
    // tx-end is never logged: the callback rejected inside the transaction
    expect(ops(h.log)).toEqual(['select', 'select', 'tx-begin', 'insert'])
  })

  it('a failing member insert rejects the whole call and stops further inserts (tx rollback is the db’s job)', async () => {
    const h = makeHarness({ failMemberInsertAt: 1 })
    await expect(
      rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1', 'hr-2'], accountantId: 'acc-1' }),
    ).rejects.toThrow('member insert failed')
    const memberRows = h.log.filter((e) => e.op === 'insert' && e.table === 'team_members')
    // senior ok, hr-1 failed => hr-2 / accountant never attempted; no tx-end
    expect(memberRows.map((e) => (e.values as Row).userId)).toEqual([SENIOR_ID, 'hr-1'])
    expect(ops(h.log)).not.toContain('tx-end')
  })
})

describe('UsersService.rejoinTeam — CREATE_NEW team-staff role invariant (SR-M-1 follow-up)', () => {
  const nothingWritten = (h: ReturnType<typeof makeHarness>) => {
    expect(h.db.transaction).not.toHaveBeenCalled()
    expect(ops(h.log)).not.toContain('insert')
  }

  it.each([
    ['an ADMIN', { 'adm-1': 'ADMIN' }],
    ['an ACCOUNTANT', { 'acc-9': 'ACCOUNTANT' }],
    ['a SENIOR', { 'sen-2': 'SENIOR' }],
    ['an archived/unknown user', { 'ghost-1': null }],
  ])('rejects %s in hrIds -> 400 TEAM_HR_MEMBER_MUST_BE_HR, nothing written', async (_n, staff) => {
    const bad = Object.keys(staff)[0]!
    const h = makeHarness({ staff })
    await expect(rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1', bad] })).rejects.toMatchObject(
      code('TEAM_HR_MEMBER_MUST_BE_HR', 400),
    )
    nothingWritten(h)
  })

  it('rejects the caller themselves as their own HR (a SENIOR is not an HR)', async () => {
    const h = makeHarness({ staff: { [SENIOR_ID]: 'SENIOR' } })
    await expect(rejoin(h, { teamMode: 'CREATE_NEW', hrIds: [SENIOR_ID] })).rejects.toMatchObject(
      code('TEAM_HR_MEMBER_MUST_BE_HR', 400),
    )
    nothingWritten(h)
  })

  it.each([
    ['an HR', { 'hr-9': 'HR' }],
    ['an ADMIN', { 'adm-1': 'ADMIN' }],
    ['an archived/unknown user', { 'ghost-1': null }],
  ])(
    'rejects %s as accountantId -> 400 TEAM_ACCOUNTANT_MUST_BE_ACCOUNTANT, nothing written',
    async (_n, staff) => {
      const bad = Object.keys(staff)[0]!
      const h = makeHarness({ staff })
      await expect(
        rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1'], accountantId: bad }),
      ).rejects.toMatchObject(code('TEAM_ACCOUNTANT_MUST_BE_ACCOUNTANT', 400))
      nothingWritten(h)
    },
  )

  it('valid HRs + ACCOUNTANT: ONE probe (non-archived ids, de-duplicated) before the transaction, team created with them', async () => {
    const h = makeHarness()
    await expect(
      rejoin(h, { teamMode: 'CREATE_NEW', hrIds: ['hr-1', 'hr-1', 'hr-2'], accountantId: 'acc-1' }),
    ).resolves.toEqual({ teamId: NEW_TEAM_ID })
    expect(h.probes).toEqual([
      {
        on: 'db',
        where: '("users"."id" in ($1, $2, $3) and "users"."archived_at" is null)',
        params: ['hr-1', 'hr-2', 'acc-1'],
        // after the caller select + membership probe, before tx-begin / any insert
        logLen: 2,
      },
    ])
  })

  it('the role probe is not run for JOIN_DROP_TEAM (hrIds are ignored there)', async () => {
    const h = makeHarness({ former: true, staff: { 'adm-1': 'ADMIN' } })
    await expect(
      rejoin(h, { teamMode: 'JOIN_DROP_TEAM', dropTeamId: 'drop-1', hrIds: ['adm-1'] }),
    ).resolves.toEqual({ teamId: 'drop-1' })
    expect(h.probes).toEqual([])
  })
})
