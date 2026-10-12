/**
 * Characterization (unit) net for `UsersService.changeSalary`, pinned BEFORE it
 * is extracted from users.service.ts.
 *
 * `changeSalary` is the `PATCH /users/:id/salary` body. Facts this net pins:
 *   - The RBAC gate (`@Roles('ADMIN')`) and the `salary_change` audit row both
 *     live on the CONTROLLER (`@Roles` / `@AuditLog`); the service method has
 *     neither, takes no actor for authorisation, and writes no audit row. So
 *     there is nothing role- or audit-shaped to assert here beyond "none".
 *   - It never calls `.update(users)` itself: the single UPDATE goes through the
 *     `updateUserRow` choke point (user-write.util.ts) — no writer-inventory key.
 *   - `seniorSharePercent` is deliberately NOT written to `users`: for a SENIOR
 *     target it is routed to `proposeSeniorShareChangeInTx` inside one
 *     transaction (together with the salary UPDATE); for any other role it is
 *     silently ignored.
 *
 * Harness: `Object.assign(Object.create(UsersService.prototype), {...})`
 * (house convention). Real, un-stubbed: `findById` (loadUserById),
 * `updateUserRow`, `changedEntitlementFields`. Stubbed: the lazy
 * `_seniorShare` collaborator. Every statement is logged in order with the
 * handle it ran on (`tx` vs plain `db`); WHEREs are compiled to SQL + params
 * through PgDialect.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName, type SQL } from 'drizzle-orm'
import { UsersService } from './users.service'

const dialect = new PgDialect()
const compile = (cond: SQL | undefined) => {
  if (!cond) return { sql: '', params: [] as unknown[] }
  const q = dialect.sqlToQuery(cond)
  return { sql: q.sql, params: q.params }
}

const FIXED_NOW = new Date('2026-03-04T05:06:07.000Z')
const ARCHIVED_AT = new Date('2026-01-31T00:00:00.000Z')

type ChangeSalaryInput = Parameters<UsersService['changeSalary']>[1]
type Log = Array<Record<string, unknown>>
type Row = Record<string, unknown>

const makeUser = (over: Row = {}): Row => ({
  id: 'target-1',
  role: 'JUNIOR',
  archivedAt: null,
  monthlySalary: '1000.00',
  salaryCurrency: 'USD',
  seniorSharePercent: 26,
  dropSharePercent: 5,
  pendingSeniorSharePercent: null,
  ...over,
})

interface HarnessOpts {
  /** row returned by findById; `null` => not found */
  existing?: Row | null
  /** row returned by UPDATE users ... RETURNING; `[]` => zero rows */
  updated?: Row[]
  /** row returned by the archived re-read after a zero-row UPDATE */
  reread?: Row
  shareResult?: { pendingSeniorSharePercent: number | null } | null
}

function makeHarness(opts: HarnessOpts = {}) {
  const log: Log = []
  const existing = 'existing' in opts ? opts.existing : makeUser()
  const updatedRows = opts.updated ?? [makeUser({ ...(existing ?? {}) })]

  const makeHandle = (on: 'tx' | 'db') => ({
    select: (fields?: unknown) => ({
      from: (t: never) => ({
        where: (cond: SQL) => {
          const c = compile(cond)
          log.push({
            op: 'select',
            on,
            table: getTableName(t),
            fields: fields === undefined ? 'all' : Object.keys(fields as object),
            where: c.sql,
            params: c.params,
          })
          let rows: Row[] = []
          if (c.sql === '"users"."id" = $1')
            rows =
              fields === undefined ? (existing ? [existing] : []) : opts.reread ? [opts.reread] : []
          return Promise.resolve(rows)
        },
      }),
    }),
    update: (t: never) => ({
      set: (values: Row) => ({
        where: (cond: SQL) => {
          const c = compile(cond)
          return {
            returning: async () => {
              log.push({
                op: 'update',
                on,
                table: getTableName(t),
                set: values,
                where: c.sql,
                params: c.params,
              })
              return updatedRows.map((r) => ({ ...r }))
            },
          }
        },
      }),
    }),
    insert: () => {
      throw new Error('changeSalary must not insert anything (no audit row in the service)')
    },
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

  const proposeSeniorShareChangeInTx = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'propose', args })
    return opts.shareResult === undefined ? null : opts.shareResult
  })

  const service = Object.assign(Object.create(UsersService.prototype) as UsersService, {
    db: { db },
    _seniorShare: { proposeSeniorShareChangeInTx },
  })
  return { service, existing, log, tx, db, proposeSeniorShareChangeInTx }
}

const code = (c: string, statusCode: number) => ({
  response: expect.objectContaining({ code: c, statusCode }),
})
const ops = (log: Log) => log.map((e) => e.op)
const userUpdate = (log: Log) => log.find((e) => e.op === 'update' && e.table === 'users')
const userUpdateSet = (log: Log) => userUpdate(log)!.set as Row
const run = (
  h: ReturnType<typeof makeHarness>,
  data: ChangeSalaryInput,
  ...rest: [actorId?: string]
) => h.service.changeSalary('target-1', data, ...rest)

const GUARDED_WHERE = '("users"."id" = $1 and "users"."archived_at" is null)'
const PLAIN_WHERE = '"users"."id" = $1'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UsersService.changeSalary — target lookup', () => {
  it('404 USER_NOT_FOUND when the target does not exist; only the findById select ran', async () => {
    const h = makeHarness({ existing: null })
    await expect(run(h, { monthlySalary: 10 })).rejects.toMatchObject(code('USER_NOT_FOUND', 404))
    expect(h.log).toEqual([
      {
        op: 'select',
        on: 'db',
        table: 'users',
        fields: 'all',
        where: PLAIN_WHERE,
        params: ['target-1'],
      },
    ])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })
})

describe('UsersService.changeSalary — the exact SET', () => {
  it('monthlySalary only: stringified, plus updatedAt; no currency key', async () => {
    const h = makeHarness()
    const out = await run(h, { monthlySalary: 2500 })
    expect(ops(h.log)).toEqual(['select', 'update'])
    expect(userUpdate(h.log)).toEqual({
      op: 'update',
      on: 'db',
      table: 'users',
      set: { updatedAt: FIXED_NOW, monthlySalary: '2500' },
      where: GUARDED_WHERE,
      params: ['target-1'],
    })
    // the returned value is exactly the UPDATE ... RETURNING row
    expect(out).toEqual(makeUser())
  })

  it('a fractional salary is stringified verbatim', async () => {
    const h = makeHarness()
    await run(h, { monthlySalary: 1234.5 })
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, monthlySalary: '1234.5' })
  })

  it('0 is a real salary: kept as "0", NOT collapsed to null', async () => {
    const h = makeHarness()
    await run(h, { monthlySalary: 0 })
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, monthlySalary: '0' })
  })

  it('null clears the salary: key present with value null', async () => {
    const h = makeHarness()
    await run(h, { monthlySalary: null })
    const set = userUpdateSet(h.log)
    expect(set).toEqual({ updatedAt: FIXED_NOW, monthlySalary: null })
    expect('monthlySalary' in set).toBe(true)
  })

  it('salaryCurrency only: written verbatim, no monthlySalary key', async () => {
    const h = makeHarness()
    await run(h, { salaryCurrency: 'EUR' })
    expect(userUpdate(h.log)).toEqual({
      op: 'update',
      on: 'db',
      table: 'users',
      set: { updatedAt: FIXED_NOW, salaryCurrency: 'EUR' },
      where: GUARDED_WHERE,
      params: ['target-1'],
    })
  })

  it('salary and currency together are both written', async () => {
    const h = makeHarness()
    await run(h, { monthlySalary: 3000, salaryCurrency: 'UAH' })
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      monthlySalary: '3000',
      salaryCurrency: 'UAH',
    })
  })

  it('an empty payload writes only updatedAt, and attaches no archival predicate', async () => {
    const h = makeHarness()
    await run(h, {})
    expect(userUpdate(h.log)).toEqual({
      op: 'update',
      on: 'db',
      table: 'users',
      set: { updatedAt: FIXED_NOW },
      where: PLAIN_WHERE,
      params: ['target-1'],
    })
  })

  it('writes no audit row and touches no table but users', async () => {
    const h = makeHarness()
    await run(h, { monthlySalary: 2500, salaryCurrency: 'EUR' }, 'admin-1')
    expect(h.log.filter((e) => e.table !== 'users')).toEqual([])
  })
})

describe('UsersService.changeSalary — updateUserRow WHERE (archival predicate)', () => {
  it('adds `archived_at is null` when the salary actually changes', async () => {
    const h = makeHarness({ existing: makeUser({ monthlySalary: '1000.00' }) })
    await run(h, { monthlySalary: 1000.5 })
    expect(userUpdate(h.log)!.where).toBe(GUARDED_WHERE)
  })

  it('adds `archived_at is null` when only the currency changes', async () => {
    const h = makeHarness({ existing: makeUser({ salaryCurrency: 'USD' }) })
    await run(h, { salaryCurrency: 'EUR' })
    expect(userUpdate(h.log)!.where).toBe(GUARDED_WHERE)
  })

  it('re-submitting the SAME salary (numeric vs "1000.00") is not a change: plain WHERE', async () => {
    const h = makeHarness({ existing: makeUser({ monthlySalary: '1000.00' }) })
    await run(h, { monthlySalary: 1000 })
    expect(userUpdate(h.log)!.where).toBe(PLAIN_WHERE)
  })

  it('re-submitting the SAME currency is not a change: plain WHERE', async () => {
    const h = makeHarness({ existing: makeUser({ salaryCurrency: 'USD' }) })
    await run(h, { salaryCurrency: 'USD' })
    expect(userUpdate(h.log)!.where).toBe(PLAIN_WHERE)
  })
})

describe('UsersService.changeSalary — archived target', () => {
  const archived = () => makeUser({ archivedAt: ARCHIVED_AT })

  it('refuses a salary change with ENTITLEMENT_TARGET_ARCHIVED (400) before any UPDATE', async () => {
    const h = makeHarness({ existing: archived() })
    await expect(run(h, { monthlySalary: 9000 })).rejects.toMatchObject(
      code('ENTITLEMENT_TARGET_ARCHIVED', 400),
    )
    expect(ops(h.log)).toEqual(['select'])
  })

  it('refuses a currency change too', async () => {
    const h = makeHarness({ existing: archived() })
    await expect(run(h, { salaryCurrency: 'EUR' })).rejects.toMatchObject(
      code('ENTITLEMENT_TARGET_ARCHIVED', 400),
    )
    expect(ops(h.log)).toEqual(['select'])
  })

  it('refuses clearing the salary (null is a change)', async () => {
    const h = makeHarness({ existing: archived() })
    await expect(run(h, { monthlySalary: null })).rejects.toMatchObject(
      code('ENTITLEMENT_TARGET_ARCHIVED', 400),
    )
  })

  it('lets an unchanged resubmit through (not an entitlement change): plain WHERE', async () => {
    const h = makeHarness({ existing: archived() })
    await run(h, { monthlySalary: 1000, salaryCurrency: 'USD' })
    expect(userUpdate(h.log)).toEqual({
      op: 'update',
      on: 'db',
      table: 'users',
      set: { updatedAt: FIXED_NOW, monthlySalary: '1000', salaryCurrency: 'USD' },
      where: PLAIN_WHERE,
      params: ['target-1'],
    })
  })
})

describe('UsersService.changeSalary — zero-row UPDATE', () => {
  it('stale snapshot (archived after the read): re-reads archivedAt and reports ENTITLEMENT_TARGET_ARCHIVED', async () => {
    const h = makeHarness({ updated: [], reread: { archivedAt: ARCHIVED_AT } })
    await expect(run(h, { monthlySalary: 2500 })).rejects.toMatchObject(
      code('ENTITLEMENT_TARGET_ARCHIVED', 400),
    )
    expect(ops(h.log)).toEqual(['select', 'update', 'select'])
    expect(h.log[2]).toEqual({
      op: 'select',
      on: 'db',
      table: 'users',
      fields: ['archivedAt'],
      where: PLAIN_WHERE,
      params: ['target-1'],
    })
  })

  it('row vanished after the read: re-read finds nothing -> 404 USER_NOT_FOUND', async () => {
    const h = makeHarness({ updated: [] })
    await expect(run(h, { monthlySalary: 2500 })).rejects.toMatchObject(code('USER_NOT_FOUND', 404))
    expect(ops(h.log)).toEqual(['select', 'update', 'select'])
  })

  it('re-read finds a live (non-archived) row -> still 404 USER_NOT_FOUND', async () => {
    const h = makeHarness({ updated: [], reread: { archivedAt: null } })
    await expect(run(h, { monthlySalary: 2500 })).rejects.toMatchObject(code('USER_NOT_FOUND', 404))
  })

  it('no entitlement change + zero rows: 404 with NO re-read', async () => {
    const h = makeHarness({ updated: [], reread: { archivedAt: ARCHIVED_AT } })
    await expect(run(h, {})).rejects.toMatchObject(code('USER_NOT_FOUND', 404))
    expect(ops(h.log)).toEqual(['select', 'update'])
  })
})

describe('UsersService.changeSalary — seniorSharePercent routing', () => {
  const senior = () => makeUser({ role: 'SENIOR' })

  it('SENIOR + share + actor: ONE tx = [users UPDATE on tx, propose]; db select happens before', async () => {
    const h = makeHarness({ existing: senior() })
    await run(h, { monthlySalary: 2500, seniorSharePercent: 80 }, 'admin-1')
    expect(ops(h.log)).toEqual(['select', 'tx-begin', 'update', 'propose', 'tx-end'])
    expect(h.log[0]).toMatchObject({ on: 'db' })
    expect(userUpdate(h.log)).toEqual({
      op: 'update',
      on: 'tx',
      table: 'users',
      // the share is NEVER written to users
      set: { updatedAt: FIXED_NOW, monthlySalary: '2500' },
      where: GUARDED_WHERE,
      params: ['target-1'],
    })
    expect(h.proposeSeniorShareChangeInTx).toHaveBeenCalledTimes(1)
    const args = h.proposeSeniorShareChangeInTx.mock.calls[0]!
    expect(args[0]).toBe(h.tx)
    expect(args[1]).toBe(h.existing)
    expect(args[2]).toBe(80)
    expect(args[3]).toBe('admin-1')
    expect(args).toHaveLength(4)
  })

  it('share 0 is a real request (not "absent"): still proposed', async () => {
    const h = makeHarness({ existing: senior() })
    await run(h, { seniorSharePercent: 0 }, 'admin-1')
    expect(h.proposeSeniorShareChangeInTx.mock.calls[0]![2]).toBe(0)
  })

  it('the propose result overrides pendingSeniorSharePercent on the returned row', async () => {
    const h = makeHarness({
      existing: senior(),
      updated: [makeUser({ role: 'SENIOR', pendingSeniorSharePercent: null })],
      shareResult: { pendingSeniorSharePercent: 80 },
    })
    const out = await run(h, { seniorSharePercent: 80 }, 'admin-1')
    expect(out.pendingSeniorSharePercent).toBe(80)
  })

  it('a null propose result leaves the returned row untouched', async () => {
    const h = makeHarness({
      existing: senior(),
      updated: [makeUser({ role: 'SENIOR', pendingSeniorSharePercent: 55 })],
      shareResult: null,
    })
    const out = await run(h, { seniorSharePercent: 80 }, 'admin-1')
    expect(out.pendingSeniorSharePercent).toBe(55)
  })

  it('a propose result that CANCELS (pending=null) still overwrites a stale pending value', async () => {
    const h = makeHarness({
      existing: senior(),
      updated: [makeUser({ role: 'SENIOR', pendingSeniorSharePercent: 55 })],
      shareResult: { pendingSeniorSharePercent: null },
    })
    const out = await run(h, { seniorSharePercent: 26 }, 'admin-1')
    expect(out.pendingSeniorSharePercent).toBeNull()
  })

  it('SENIOR + share but NO actor: 400 SHARE_CHANGE_REQUESTER_REQUIRED, nothing written, no tx', async () => {
    const h = makeHarness({ existing: senior() })
    await expect(run(h, { seniorSharePercent: 80 })).rejects.toMatchObject(
      code('SHARE_CHANGE_REQUESTER_REQUIRED', 400),
    )
    expect(ops(h.log)).toEqual(['select'])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('an empty-string actor is treated as missing', async () => {
    const h = makeHarness({ existing: senior() })
    await expect(run(h, { seniorSharePercent: 80 }, '')).rejects.toMatchObject(
      code('SHARE_CHANGE_REQUESTER_REQUIRED', 400),
    )
  })

  it('SENIOR without a share: plain single UPDATE on db, no tx, no propose (actor irrelevant)', async () => {
    const h = makeHarness({ existing: senior() })
    await run(h, { monthlySalary: 2500 }, 'admin-1')
    expect(ops(h.log)).toEqual(['select', 'update'])
    expect(userUpdate(h.log)).toMatchObject({ on: 'db' })
    expect(h.db.transaction).not.toHaveBeenCalled()
    expect(h.proposeSeniorShareChangeInTx).not.toHaveBeenCalled()
  })

  it.each(['JUNIOR', 'DROP', 'HR', 'ACCOUNTANT', 'ADMIN'])(
    'SR-L-5: %s target + share is IGNORED (no 400 without actor, no tx, no propose, not in SET)',
    async (role) => {
      const h = makeHarness({ existing: makeUser({ role }) })
      await run(h, { monthlySalary: 2500, seniorSharePercent: 80 })
      expect(ops(h.log)).toEqual(['select', 'update'])
      expect(userUpdate(h.log)).toMatchObject({
        on: 'db',
        set: { updatedAt: FIXED_NOW, monthlySalary: '2500' },
      })
      expect(h.db.transaction).not.toHaveBeenCalled()
      expect(h.proposeSeniorShareChangeInTx).not.toHaveBeenCalled()
    },
  )

  it('archived SENIOR + share + actor: the salary change is refused before the propose runs', async () => {
    const h = makeHarness({ existing: makeUser({ role: 'SENIOR', archivedAt: ARCHIVED_AT }) })
    await expect(
      run(h, { monthlySalary: 9000, seniorSharePercent: 80 }, 'admin-1'),
    ).rejects.toMatchObject(code('ENTITLEMENT_TARGET_ARCHIVED', 400))
    expect(ops(h.log)).toEqual(['select', 'tx-begin'])
    expect(h.proposeSeniorShareChangeInTx).not.toHaveBeenCalled()
  })
})
