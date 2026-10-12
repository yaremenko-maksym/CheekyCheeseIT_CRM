/**
 * Characterization (unit) net for `UsersService.adminUpdateUser`, pinned BEFORE
 * it is extracted from users.service.ts.
 *
 * `adminUpdateUser` is the `PATCH /users/:id` admin edit flow. It never calls
 * `.update(users)` itself: the users write goes through the `updateUserRow`
 * choke point (user-write.util.ts) inside ONE transaction, together with the
 * `user_emails` WORK-row sync and the SENIOR team side effects. It writes no
 * audit row of its own — `actorId` is only forwarded to the collaborators.
 *
 * Harness: `Object.assign(Object.create(UsersService.prototype), {...})`
 * (house convention). Real, un-stubbed code over the recording double:
 * `findById`/`findByEmail`, `assertEmailAvailable`, `assertAvatarDocument`,
 * `upsertWorkEmail` + `writeUserEmailOrConflict`, `updateUserRow`,
 * `buildAdminUserUpdateSet`, the role guards. Stubbed (lazy collaborators):
 * `_seniorShare` and `_teamReconcile`. Every statement is logged in order with
 * the handle it ran on (`tx` vs plain `db`); WHEREs are compiled to SQL +
 * params through PgDialect.
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

type AdminUpdateInput = Parameters<UsersService['adminUpdateUser']>[1]
type Log = Array<Record<string, unknown>>
type Row = Record<string, unknown>

const makeUser = (over: Row = {}): Row => ({
  id: 'target-1',
  role: 'JUNIOR',
  email: 'old@cc.com',
  displayName: 'Old Name',
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
  /** row returned by findByEmail(data.email) */
  byEmail?: Row
  /** user's own PERSONAL user_emails row */
  personalRow?: Row
  /** user_emails row found by the lower(email) availability probe */
  availabilityRow?: Row
  /** user's WORK user_emails row (upsertWorkEmail) */
  workRow?: Row
  /** documents row for the avatar probe */
  document?: Row
  /** row returned by UPDATE users ... RETURNING; `[]` => zero rows */
  updated?: Row[]
  /** row returned by the archived re-read after a zero-row UPDATE */
  reread?: Row
  /** error thrown by the user_emails write */
  emailWriteError?: unknown
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
          if (c.sql === '"users"."email" = $1') rows = opts.byEmail ? [opts.byEmail] : []
          else if (c.sql === '"users"."id" = $1')
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
          const table = getTableName(t)
          const entry = { op: 'update', on, table, set: values, where: c.sql, params: c.params }
          if (table === 'users') {
            return {
              returning: async () => {
                log.push(entry)
                return updatedRows.map((r) => ({ ...r }))
              },
            }
          }
          const run = async () => {
            log.push(entry)
            if (opts.emailWriteError) throw opts.emailWriteError
          }
          return { then: (res: never, rej: never) => run().then(res, rej) }
        },
      }),
    }),
    insert: (t: never) => ({
      values: (values: Row) => {
        const run = async () => {
          log.push({ op: 'insert', on, table: getTableName(t), values })
          if (opts.emailWriteError) throw opts.emailWriteError
        }
        return { then: (res: never, rej: never) => run().then(res, rej) }
      },
    }),
    query: {
      userEmails: {
        findFirst: vi.fn(async (arg: { where: SQL }) => {
          const c = compile(arg.where)
          log.push({ op: 'findFirst', on, table: 'user_emails', where: c.sql, params: c.params })
          if (c.sql.includes('lower(')) return opts.availabilityRow
          if (c.params[1] === 'PERSONAL') return opts.personalRow
          if (c.params[1] === 'WORK') return opts.workRow
          return undefined
        }),
      },
      documents: {
        findFirst: vi.fn(async (arg: { where: SQL }) => {
          const c = compile(arg.where)
          log.push({ op: 'findFirst', on, table: 'documents', where: c.sql, params: c.params })
          return opts.document
        }),
      },
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
  const reconcileSeniorTeamTx = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'reconcile', args })
  })
  const updateSeniorTeamTelegramChannelTx = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'telegram', args })
  })

  const service = Object.assign(Object.create(UsersService.prototype) as UsersService, {
    db: { db },
    _seniorShare: { proposeSeniorShareChangeInTx },
    _teamReconcile: { reconcileSeniorTeamTx, updateSeniorTeamTelegramChannelTx },
  })
  return {
    service,
    existing,
    log,
    tx,
    db,
    proposeSeniorShareChangeInTx,
    reconcileSeniorTeamTx,
    updateSeniorTeamTelegramChannelTx,
  }
}

const code = (c: string, statusCode: number) => ({
  response: expect.objectContaining({ code: c, statusCode }),
})
const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' })
const ops = (log: Log) => log.map((e) => e.op)
const userUpdate = (log: Log) => log.find((e) => e.op === 'update' && e.table === 'users')
const userUpdateSet = (log: Log) => userUpdate(log)!.set as Row
const edit = (
  h: ReturnType<typeof makeHarness>,
  data: AdminUpdateInput,
  ...rest: [actorId?: string | null]
) => h.service.adminUpdateUser('target-1', data, ...rest)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UsersService.adminUpdateUser — target lookup', () => {
  it('404 USER_NOT_FOUND when the target does not exist; only the findById select ran', async () => {
    const h = makeHarness({ existing: null })
    await expect(edit(h, { displayName: 'X' }, 'admin-1')).rejects.toMatchObject(
      code('USER_NOT_FOUND', 404),
    )
    expect(h.log).toEqual([
      {
        op: 'select',
        on: 'db',
        table: 'users',
        fields: 'all',
        where: '"users"."id" = $1',
        params: ['target-1'],
      },
    ])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })
})

describe('UsersService.adminUpdateUser — ADMIN-target protection (before any other check)', () => {
  const admin = () => makeUser({ id: 'target-1', role: 'ADMIN' })

  it('another actor editing an ADMIN -> 403 CANNOT_EDIT_ANOTHER_ADMIN, no further statements', async () => {
    const h = makeHarness({ existing: admin() })
    await expect(edit(h, { displayName: 'X' }, 'other-admin')).rejects.toMatchObject(
      code('CANNOT_EDIT_ANOTHER_ADMIN', 403),
    )
    expect(ops(h.log)).toEqual(['select'])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('the ADMIN-target guard wins over the role-escalation guard (role ADMIN by another actor)', async () => {
    const h = makeHarness({ existing: admin() })
    await expect(edit(h, { role: 'DROP' }, 'other-admin')).rejects.toMatchObject(
      code('CANNOT_EDIT_ANOTHER_ADMIN', 403),
    )
  })

  it('an ADMIN editing THEMSELF cannot change their own role -> 403 ADMIN_CANNOT_CHANGE_OWN_ROLE', async () => {
    const h = makeHarness({ existing: admin() })
    await expect(edit(h, { role: 'HR' }, 'target-1')).rejects.toMatchObject(
      code('ADMIN_CANNOT_CHANGE_OWN_ROLE', 403),
    )
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('an ADMIN self-edit resubmitting role ADMIN is allowed (set carries role ADMIN)', async () => {
    const h = makeHarness({ existing: admin() })
    await edit(h, { role: 'ADMIN', displayName: 'Me' }, 'target-1')
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      role: 'ADMIN',
      displayName: 'Me',
    })
  })

  it('an ADMIN self-edit without a role is allowed', async () => {
    const h = makeHarness({ existing: admin() })
    await expect(edit(h, { displayName: 'Me' }, 'target-1')).resolves.toBeDefined()
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, displayName: 'Me' })
  })

  it('actorId defaults to null (system caller): ADMIN target is editable, even role HR', async () => {
    const h = makeHarness({ existing: admin() })
    await edit(h, { role: 'HR' })
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, role: 'HR' })
  })

  it('explicit null actorId behaves like the default', async () => {
    const h = makeHarness({ existing: admin() })
    await expect(edit(h, { displayName: 'Z' }, null)).resolves.toBeDefined()
  })
})

describe('UsersService.adminUpdateUser — role-escalation guard (only on an ACTUAL role change)', () => {
  it('JUNIOR -> ADMIN -> 403 ADMIN_ROLE_ASSIGNMENT_FORBIDDEN, no transaction', async () => {
    const h = makeHarness()
    await expect(edit(h, { role: 'ADMIN' }, 'admin-1')).rejects.toMatchObject(
      code('ADMIN_ROLE_ASSIGNMENT_FORBIDDEN', 403),
    )
    expect(h.db.transaction).not.toHaveBeenCalled()
    expect(userUpdate(h.log)).toBeUndefined()
  })

  it('JUNIOR -> DROP -> 403 DROP_ROLE_CHANGE_VIA_DEDICATED_ENDPOINT', async () => {
    const h = makeHarness()
    await expect(edit(h, { role: 'DROP' }, 'admin-1')).rejects.toMatchObject(
      code('DROP_ROLE_CHANGE_VIA_DEDICATED_ENDPOINT', 403),
    )
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('a DROP user resubmitting role DROP is NOT blocked', async () => {
    const h = makeHarness({ existing: makeUser({ role: 'DROP' }) })
    await expect(edit(h, { role: 'DROP', phone: '1' }, 'admin-1')).resolves.toBeDefined()
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, role: 'DROP', phone: '1' })
  })

  it.each(['HR', 'SENIOR', 'JUNIOR', 'ACCOUNTANT'] as const)(
    'JUNIOR -> %s (a normal role change) is allowed',
    async (role) => {
      const h = makeHarness({ existing: makeUser({ role: role === 'JUNIOR' ? 'HR' : 'JUNIOR' }) })
      await expect(edit(h, { role }, 'admin-1')).resolves.toBeDefined()
      expect(userUpdateSet(h.log).role).toBe(role)
    },
  )

  it('no role in the body is never an escalation (DROP user, other fields only)', async () => {
    const h = makeHarness({ existing: makeUser({ role: 'DROP' }) })
    await expect(edit(h, { displayName: 'D' }, 'admin-1')).resolves.toBeDefined()
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, displayName: 'D' })
  })

  it('the guards run before the telegram-channel / email / avatar checks', async () => {
    const h = makeHarness()
    await expect(
      edit(h, { role: 'ADMIN', teamTelegramChannel: '@x', email: 'new@cc.com' }, 'admin-1'),
    ).rejects.toMatchObject(code('ADMIN_ROLE_ASSIGNMENT_FORBIDDEN', 403))
    expect(ops(h.log)).toEqual(['select'])
  })
})

describe('UsersService.adminUpdateUser — teamTelegramChannel is SENIOR-only', () => {
  it('non-SENIOR effective role + channel -> 400 TELEGRAM_CHANNEL_SENIOR_ONLY, before email checks', async () => {
    const h = makeHarness()
    await expect(
      edit(h, { teamTelegramChannel: '@team', email: 'new@cc.com' }, 'admin-1'),
    ).rejects.toMatchObject(code('TELEGRAM_CHANNEL_SENIOR_ONLY', 400))
    expect(ops(h.log)).toEqual(['select'])
  })

  it('a null channel on a non-SENIOR is still rejected (presence, not truthiness)', async () => {
    const h = makeHarness()
    await expect(edit(h, { teamTelegramChannel: null }, 'admin-1')).rejects.toMatchObject(
      code('TELEGRAM_CHANNEL_SENIOR_ONLY', 400),
    )
  })

  it('effective role comes from the BODY: JUNIOR promoted to SENIOR in the same PATCH may set it', async () => {
    const h = makeHarness({ updated: [makeUser({ role: 'SENIOR' })] })
    await expect(
      edit(h, { role: 'SENIOR', teamTelegramChannel: '@team' }, 'admin-1'),
    ).resolves.toBeDefined()
  })

  it('a SENIOR demoted to JUNIOR in the same PATCH may NOT set it', async () => {
    const h = makeHarness({ existing: makeUser({ role: 'SENIOR' }) })
    await expect(
      edit(h, { role: 'JUNIOR', teamTelegramChannel: '@team' }, 'admin-1'),
    ).rejects.toMatchObject(code('TELEGRAM_CHANNEL_SENIOR_ONLY', 400))
  })

  it('a SENIOR with no role in the body may set it', async () => {
    const h = makeHarness({
      existing: makeUser({ role: 'SENIOR' }),
      updated: [makeUser({ role: 'SENIOR' })],
    })
    await expect(edit(h, { teamTelegramChannel: '@team' }, 'admin-1')).resolves.toBeDefined()
  })
})

describe('UsersService.adminUpdateUser — email change checks', () => {
  it('unchanged email (same as existing) runs NO email probes and NO WORK-row sync', async () => {
    const h = makeHarness()
    await edit(h, { email: 'old@cc.com', displayName: 'N' }, 'admin-1')
    expect(h.log.some((e) => e.table === 'user_emails')).toBe(false)
    expect(h.log.filter((e) => e.op === 'select' && e.params)).toHaveLength(1)
    // the users SET still carries the (unchanged) email
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      email: 'old@cc.com',
      displayName: 'N',
    })
  })

  it('no email in the body: no email probes', async () => {
    const h = makeHarness()
    await edit(h, { displayName: 'N' }, 'admin-1')
    expect(ops(h.log)).toEqual(['select', 'tx-begin', 'update', 'tx-end'])
  })

  it('409 USER_EMAIL_EXISTS when findByEmail returns ANOTHER user; nothing after the probe', async () => {
    const h = makeHarness({ byEmail: makeUser({ id: 'someone-else', email: 'new@cc.com' }) })
    await expect(edit(h, { email: 'new@cc.com' }, 'admin-1')).rejects.toMatchObject(
      code('USER_EMAIL_EXISTS', 409),
    )
    expect(h.log[1]).toEqual({
      op: 'select',
      on: 'db',
      table: 'users',
      fields: 'all',
      where: '"users"."email" = $1',
      params: ['new@cc.com'],
    })
    expect(h.log).toHaveLength(2)
  })

  it('a findByEmail hit on the SAME user id is not a conflict (continues to the PERSONAL check)', async () => {
    const h = makeHarness({ byEmail: makeUser({ id: 'target-1' }) })
    await edit(h, { email: 'new@cc.com' }, 'admin-1')
    expect(h.log.some((e) => e.op === 'findFirst' && e.table === 'user_emails')).toBe(true)
  })

  it('400 WORK_EMAIL_MUST_DIFFER_FROM_PERSONAL when the new email equals own PERSONAL (case-insensitive)', async () => {
    const h = makeHarness({ personalRow: { email: 'Mixed@CC.com' } })
    await expect(edit(h, { email: 'mixed@cc.COM' }, 'admin-1')).rejects.toMatchObject(
      code('WORK_EMAIL_MUST_DIFFER_FROM_PERSONAL', 400),
    )
    expect(h.log[2]).toEqual({
      op: 'findFirst',
      on: 'db',
      table: 'user_emails',
      where: '("user_emails"."user_id" = $1 and "user_emails"."kind" = $2)',
      params: ['target-1', 'PERSONAL'],
    })
    expect(h.log).toHaveLength(3)
  })

  it('a PERSONAL row with a DIFFERENT address does not block', async () => {
    const h = makeHarness({ personalRow: { email: 'other@cc.com' } })
    await expect(edit(h, { email: 'new@cc.com' }, 'admin-1')).resolves.toBeDefined()
  })

  it('409 EMAIL_TAKEN_BY_ANOTHER_USER when the lower(email) probe finds a stranger row; probe excludes own id', async () => {
    const h = makeHarness({ availabilityRow: { userId: 'stranger' } })
    await expect(edit(h, { email: 'New@CC.com' }, 'admin-1')).rejects.toMatchObject(
      code('EMAIL_TAKEN_BY_ANOTHER_USER', 409),
    )
    expect(h.log[3]).toEqual({
      op: 'findFirst',
      on: 'db',
      table: 'user_emails',
      where: 'lower("user_emails"."email") = $1',
      params: ['new@cc.com'],
    })
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('the availability probe passing through an OWN row (same user) does not throw', async () => {
    const h = makeHarness({ availabilityRow: { userId: 'target-1' } })
    await expect(edit(h, { email: 'new@cc.com' }, 'admin-1')).resolves.toBeDefined()
  })

  it('email checks run on plain db (not tx), in order: byEmail, PERSONAL, availability', async () => {
    const h = makeHarness()
    await edit(h, { email: 'new@cc.com' }, 'admin-1')
    expect(h.log.slice(0, 4).map((e) => [e.op, e.on, e.table])).toEqual([
      ['select', 'db', 'users'],
      ['select', 'db', 'users'],
      ['findFirst', 'db', 'user_emails'],
      ['findFirst', 'db', 'user_emails'],
    ])
  })
})

describe('UsersService.adminUpdateUser — WORK-row sync (upsertWorkEmail) on an email change', () => {
  it('updates the existing WORK row inside the tx, with the email from the RETURNED user row', async () => {
    const h = makeHarness({
      workRow: { id: 'we-1' },
      updated: [makeUser({ email: 'returned@cc.com' })],
    })
    await edit(h, { email: 'new@cc.com' }, 'admin-1')
    const idx = ops(h.log).indexOf('tx-begin')
    expect(h.log.slice(idx)).toEqual([
      { op: 'tx-begin' },
      expect.objectContaining({ op: 'update', on: 'tx', table: 'users' }),
      {
        op: 'findFirst',
        on: 'tx',
        table: 'user_emails',
        where: '("user_emails"."user_id" = $1 and "user_emails"."kind" = $2)',
        params: ['target-1', 'WORK'],
      },
      {
        op: 'update',
        on: 'tx',
        table: 'user_emails',
        set: { email: 'returned@cc.com', updatedAt: FIXED_NOW },
        where: '"user_emails"."id" = $1',
        params: ['we-1'],
      },
      { op: 'tx-end' },
    ])
  })

  it('inserts a WORK row (canLogin, verified now) when none exists; userId from the returned row', async () => {
    const h = makeHarness({ updated: [makeUser({ id: 'returned-id', email: 'returned@cc.com' })] })
    await edit(h, { email: 'new@cc.com' }, 'admin-1')
    expect(h.log.find((e) => e.op === 'insert')).toEqual({
      op: 'insert',
      on: 'tx',
      table: 'user_emails',
      values: {
        userId: 'returned-id',
        email: 'returned@cc.com',
        kind: 'WORK',
        canLogin: true,
        verifiedAt: FIXED_NOW,
      },
    })
  })

  it('a unique violation on the WORK write -> 409 EMAIL_ALREADY_IN_USE', async () => {
    const h = makeHarness({ workRow: { id: 'we-1' }, emailWriteError: uniqueViolation() })
    await expect(edit(h, { email: 'new@cc.com' }, 'admin-1')).rejects.toMatchObject(
      code('EMAIL_ALREADY_IN_USE', 409),
    )
  })

  it('any other WORK write error is rethrown untouched', async () => {
    const boom = new Error('boom')
    const h = makeHarness({ emailWriteError: boom })
    await expect(edit(h, { email: 'new@cc.com' }, 'admin-1')).rejects.toBe(boom)
  })

  it('the sync happens AFTER the users write and BEFORE the SENIOR side effects', async () => {
    const h = makeHarness({
      existing: makeUser({ role: 'SENIOR' }),
      updated: [makeUser({ role: 'SENIOR' })],
    })
    await edit(h, { email: 'new@cc.com', hrIds: ['hr-1'], teamTelegramChannel: '@t' }, 'admin-1')
    const seq = h.log
      .filter((e) => e.on === 'tx' || ['reconcile', 'telegram'].includes(e.op as string))
      .map((e) => `${e.op}:${e.table ?? ''}`)
    expect(seq).toEqual([
      'update:users',
      'findFirst:user_emails',
      'insert:user_emails',
      'reconcile:',
      'telegram:',
    ])
  })
})

describe('UsersService.adminUpdateUser — avatarDocumentId', () => {
  const doc = (over: Row = {}) => ({
    id: 'doc-1',
    category: 'AVATAR',
    ownerId: 'target-1',
    deletedAt: null,
    ...over,
  })

  it('absent key: no documents probe, no avatarDocumentId in the SET', async () => {
    const h = makeHarness()
    await edit(h, { displayName: 'N' }, 'admin-1')
    expect(h.log.some((e) => e.table === 'documents')).toBe(false)
    expect('avatarDocumentId' in userUpdateSet(h.log)).toBe(false)
  })

  it('null clears the avatar document without a probe', async () => {
    const h = makeHarness()
    await edit(h, { avatarDocumentId: null }, 'admin-1')
    expect(h.log.some((e) => e.table === 'documents')).toBe(false)
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, avatarDocumentId: null })
  })

  it('a present-but-undefined key clears it too (`in` check, not !== undefined)', async () => {
    const h = makeHarness()
    await edit(h, { avatarDocumentId: undefined }, 'admin-1')
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, avatarDocumentId: null })
  })

  it('a valid AVATAR owned by the TARGET (not the actor) is accepted; probe is by document id', async () => {
    const h = makeHarness({ document: doc() })
    await edit(h, { avatarDocumentId: 'doc-1' }, 'admin-1')
    expect(h.log[1]).toEqual({
      op: 'findFirst',
      on: 'db',
      table: 'documents',
      where: '"documents"."id" = $1',
      params: ['doc-1'],
    })
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, avatarDocumentId: 'doc-1' })
  })

  it.each([
    ['AVATAR_DOCUMENT_NOT_FOUND', undefined],
    ['AVATAR_DOCUMENT_WRONG_CATEGORY', doc({ category: 'CONTRACT' })],
    ['AVATAR_DOCUMENT_WRONG_OWNER', doc({ ownerId: 'admin-1' })],
    ['AVATAR_DOCUMENT_DELETED', doc({ deletedAt: new Date() })],
  ])('400 %s, no transaction opened', async (errCode, document) => {
    const h = makeHarness({ document })
    await expect(edit(h, { avatarDocumentId: 'doc-1' }, 'admin-1')).rejects.toMatchObject(
      code(errCode, 400),
    )
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('the avatar check runs after the email checks', async () => {
    const h = makeHarness({ document: doc() })
    await edit(h, { email: 'new@cc.com', avatarDocumentId: 'doc-1' }, 'admin-1')
    const tables = h.log.filter((e) => e.op === 'findFirst').map((e) => e.table)
    expect(tables).toEqual(['user_emails', 'user_emails', 'documents', 'user_emails'])
  })
})

describe('UsersService.adminUpdateUser — exact users SET per field group', () => {
  it('plain profile fields + role', async () => {
    const h = makeHarness({ existing: makeUser({ role: 'HR' }) })
    await edit(
      h,
      {
        displayName: 'New',
        role: 'JUNIOR',
        telegram: '@t',
        phone: '+1',
        avatarUrl: 'http://a',
        techStack: ['ts'],
      },
      'admin-1',
    )
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      displayName: 'New',
      role: 'JUNIOR',
      telegram: '@t',
      phone: '+1',
      avatarUrl: 'http://a',
      techStack: ['ts'],
    })
  })

  it('explicit nulls/undefined for nullable contact fields are written as null', async () => {
    const h = makeHarness()
    await edit(h, { telegram: null, phone: undefined, avatarUrl: null, techStack: null }, 'a')
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      telegram: null,
      phone: null,
      avatarUrl: null,
      techStack: null,
    })
  })

  it('salary: number -> string, null clears, currency passes through', async () => {
    const h = makeHarness({ existing: makeUser({ monthlySalary: null, salaryCurrency: 'EUR' }) })
    await edit(h, { monthlySalary: 1234.5, salaryCurrency: 'UAH' }, 'a')
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      monthlySalary: '1234.5',
      salaryCurrency: 'UAH',
    })
    const h2 = makeHarness()
    await edit(h2, { monthlySalary: null }, 'a')
    expect(userUpdateSet(h2.log)).toEqual({ updatedAt: FIXED_NOW, monthlySalary: null })
  })

  it('dropSharePercent is written only for an effective DROP role', async () => {
    const drop = makeHarness({ existing: makeUser({ role: 'DROP' }) })
    await edit(drop, { dropSharePercent: 8 }, 'a')
    expect(userUpdateSet(drop.log)).toEqual({ updatedAt: FIXED_NOW, dropSharePercent: 8 })
    const junior = makeHarness()
    await edit(junior, { dropSharePercent: 8, displayName: 'x' }, 'a')
    expect(userUpdateSet(junior.log)).toEqual({ updatedAt: FIXED_NOW, displayName: 'x' })
  })

  it('legalFullName is trimmed (blank -> null); registrationAddress trimmed/nullable', async () => {
    const h = makeHarness()
    await edit(h, { legalFullName: '  Іваненко Іван  ', registrationAddress: '  addr ' }, 'a')
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      legalFullName: 'Іваненко Іван',
      registrationAddress: 'addr',
    })
    const h2 = makeHarness()
    await edit(h2, { legalFullName: '   ', registrationAddress: null }, 'a')
    expect(userUpdateSet(h2.log)).toEqual({
      updatedAt: FIXED_NOW,
      legalFullName: null,
      registrationAddress: null,
    })
  })

  it('switching to USDT_ERC20 writes the wallet fields and clears the whole bank branch', async () => {
    const h = makeHarness()
    await edit(
      h,
      { paymentMethod: 'USDT_ERC20', walletUsdtErc20: '0xabc', walletUsdtLabel: 'main' },
      'a',
    )
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xabc',
      walletUsdtLabel: 'main',
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
    })
  })

  it('switching to BANK_UAH_FOP writes the bank fields and clears the wallet branch', async () => {
    const h = makeHarness()
    await edit(
      h,
      {
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'FOP',
        bankUahIban: 'UA12',
        bankUahRnokpp: '123',
        bankUahBankName: 'Mono',
        walletUsdtErc20: '0xignored',
      },
      'a',
    )
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'FOP',
      bankUahIban: 'UA12',
      bankUahRnokpp: '123',
      bankUahBankName: 'Mono',
      walletUsdtErc20: null,
      walletUsdtLabel: null,
    })
  })

  it('no method switch: individual requisite fields patch in place, null on undefined', async () => {
    const h = makeHarness()
    await edit(h, { walletUsdtErc20: '0x1', bankUahIban: undefined }, 'a')
    expect(userUpdateSet(h.log)).toEqual({
      updatedAt: FIXED_NOW,
      walletUsdtErc20: '0x1',
      bankUahIban: null,
    })
  })

  it('seniorSharePercent is NEVER written to the users SET (routed to the pending-share flow)', async () => {
    const h = makeHarness({
      existing: makeUser({ role: 'SENIOR' }),
      updated: [makeUser({ role: 'SENIOR' })],
    })
    await edit(h, { seniorSharePercent: 30, displayName: 'x' }, 'admin-1')
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW, displayName: 'x' })
  })

  it('hrIds / accountantId / teamTelegramChannel are never part of the users SET', async () => {
    const h = makeHarness({
      existing: makeUser({ role: 'SENIOR' }),
      updated: [makeUser({ role: 'SENIOR' })],
    })
    await edit(h, { hrIds: ['h'], accountantId: 'acc', teamTelegramChannel: '@t' }, 'a')
    expect(userUpdateSet(h.log)).toEqual({ updatedAt: FIXED_NOW })
  })
})

describe('UsersService.adminUpdateUser — updateUserRow choke point (archived refusal + WHERE)', () => {
  it('no entitlement change: UPDATE ... WHERE id only (no archived predicate), on tx', async () => {
    const h = makeHarness()
    await edit(h, { displayName: 'N', phone: '1' }, 'admin-1')
    expect(userUpdate(h.log)).toEqual({
      op: 'update',
      on: 'tx',
      table: 'users',
      set: { updatedAt: FIXED_NOW, displayName: 'N', phone: '1' },
      where: '"users"."id" = $1',
      params: ['target-1'],
    })
  })

  it('role change: the UPDATE gains `archived_at is null`', async () => {
    const h = makeHarness()
    await edit(h, { role: 'HR' }, 'admin-1')
    const u = userUpdate(h.log)!
    expect(u.where).toBe('("users"."id" = $1 and "users"."archived_at" is null)')
    expect(u.params).toEqual(['target-1'])
  })

  it('salary change gains the predicate; resubmitting the SAME salary (numeric compare) does not', async () => {
    const changed = makeHarness()
    await edit(changed, { monthlySalary: 2000 }, 'a')
    expect(userUpdate(changed.log)!.where).toContain('archived_at')
    const same = makeHarness()
    await edit(same, { monthlySalary: 1000 }, 'a')
    expect(userUpdate(same.log)!.where).toBe('"users"."id" = $1')
  })

  it('currency change gains the predicate', async () => {
    const h = makeHarness()
    await edit(h, { salaryCurrency: 'EUR' }, 'a')
    expect(userUpdate(h.log)!.where).toContain('archived_at')
  })

  it('archived target + actual role change -> 400 ENTITLEMENT_TARGET_ARCHIVED, UPDATE never issued', async () => {
    const h = makeHarness({ existing: makeUser({ archivedAt: new Date() }) })
    await expect(edit(h, { role: 'HR' }, 'admin-1')).rejects.toMatchObject(
      code('ENTITLEMENT_TARGET_ARCHIVED', 400),
    )
    expect(userUpdate(h.log)).toBeUndefined()
    expect(ops(h.log)).toEqual(['select', 'tx-begin'])
  })

  it('archived target + salary change -> 400 ENTITLEMENT_TARGET_ARCHIVED', async () => {
    const h = makeHarness({ existing: makeUser({ archivedAt: new Date() }) })
    await expect(edit(h, { monthlySalary: 5 }, 'admin-1')).rejects.toMatchObject(
      code('ENTITLEMENT_TARGET_ARCHIVED', 400),
    )
  })

  it('archived target: requisites-only edit is allowed (settlement path), plain WHERE', async () => {
    const h = makeHarness({ existing: makeUser({ archivedAt: new Date() }) })
    await edit(h, { bankUahIban: 'UA99' }, 'admin-1')
    expect(userUpdate(h.log)!.where).toBe('"users"."id" = $1')
  })

  it('archived target: resubmitting the SAME role and salary is allowed', async () => {
    const h = makeHarness({ existing: makeUser({ archivedAt: new Date(), role: 'HR' }) })
    await expect(
      edit(h, { role: 'HR', monthlySalary: 1000, salaryCurrency: 'USD' }, 'admin-1'),
    ).resolves.toBeDefined()
    expect(userUpdate(h.log)!.where).toBe('"users"."id" = $1')
  })

  it('zero rows returned, no entitlement change -> 404 USER_NOT_FOUND, no re-read', async () => {
    const h = makeHarness({ updated: [] })
    await expect(edit(h, { displayName: 'x' }, 'a')).rejects.toMatchObject(
      code('USER_NOT_FOUND', 404),
    )
    expect(h.log.some((e) => e.op === 'select' && e.on === 'tx')).toBe(false)
  })

  it('zero rows with an entitlement change + row archived meanwhile -> 400 (re-read on tx, archivedAt only)', async () => {
    const h = makeHarness({ updated: [], reread: { archivedAt: new Date() } })
    await expect(edit(h, { role: 'HR' }, 'a')).rejects.toMatchObject(
      code('ENTITLEMENT_TARGET_ARCHIVED', 400),
    )
    expect(h.log.find((e) => e.op === 'select' && e.on === 'tx')).toEqual({
      op: 'select',
      on: 'tx',
      table: 'users',
      fields: ['archivedAt'],
      where: '"users"."id" = $1',
      params: ['target-1'],
    })
  })

  it('zero rows with an entitlement change + row not archived -> 404 USER_NOT_FOUND', async () => {
    const h = makeHarness({ updated: [], reread: { archivedAt: null } })
    await expect(edit(h, { role: 'HR' }, 'a')).rejects.toMatchObject(code('USER_NOT_FOUND', 404))
  })

  it('returns the row produced by the UPDATE ... RETURNING', async () => {
    const h = makeHarness({ updated: [makeUser({ displayName: 'From DB' })] })
    const out = await edit(h, { displayName: 'ignored' }, 'a')
    expect(out).toMatchObject({ id: 'target-1', displayName: 'From DB' })
  })

  it('exactly one transaction wraps everything; all writes use the tx handle', async () => {
    const h = makeHarness({
      existing: makeUser({ role: 'SENIOR' }),
      updated: [makeUser({ role: 'SENIOR' })],
    })
    await edit(h, { email: 'n@cc.com', hrIds: ['h'], teamTelegramChannel: '@t' }, 'a')
    expect(h.db.transaction).toHaveBeenCalledTimes(1)
    const writes = h.log.filter((e) => e.op === 'update' || e.op === 'insert')
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every((e) => e.on === 'tx')).toBe(true)
    const [txArg] = h.reconcileSeniorTeamTx.mock.calls[0]!
    expect(txArg).toBe(h.tx)
  })
})

describe('UsersService.adminUpdateUser — base-share change (pending-share flow)', () => {
  const senior = () => ({
    existing: makeUser({ role: 'SENIOR' }),
    updated: [makeUser({ role: 'SENIOR' })],
  })

  it('SENIOR + seniorSharePercent: proposes in the SAME tx after the users write, with existing row and actorId', async () => {
    const h = makeHarness({
      existing: makeUser({ role: 'SENIOR', seniorSharePercent: 26 }),
      updated: [makeUser({ role: 'SENIOR', seniorSharePercent: 99 })],
      shareResult: { pendingSeniorSharePercent: 31 },
    })
    const out = await edit(h, { seniorSharePercent: 31 }, 'admin-1')
    expect(ops(h.log)).toEqual(['select', 'tx-begin', 'update', 'propose', 'tx-end'])
    expect(h.proposeSeniorShareChangeInTx).toHaveBeenCalledWith(h.tx, h.existing, 31, 'admin-1')
    // the PRE-update snapshot (findById row), not the UPDATE ... RETURNING row
    expect(h.proposeSeniorShareChangeInTx.mock.calls[0]![1]).toBe(h.existing)
    expect(out.pendingSeniorSharePercent).toBe(31)
  })

  it('0 is a real request (presence, not truthiness)', async () => {
    const h = makeHarness({ ...senior(), shareResult: { pendingSeniorSharePercent: 0 } })
    const out = await edit(h, { seniorSharePercent: 0 }, 'admin-1')
    expect(h.proposeSeniorShareChangeInTx).toHaveBeenCalledTimes(1)
    expect(out.pendingSeniorSharePercent).toBe(0)
  })

  it('a null result (no-op) leaves the returned row untouched', async () => {
    const h = makeHarness({ ...senior(), shareResult: null })
    const out = await edit(h, { seniorSharePercent: 26 }, 'admin-1')
    expect(out.pendingSeniorSharePercent).toBeNull()
  })

  it('a cancel outcome (pending null) is patched onto the response', async () => {
    const h = makeHarness({
      existing: makeUser({ role: 'SENIOR', pendingSeniorSharePercent: 40 }),
      updated: [makeUser({ role: 'SENIOR', pendingSeniorSharePercent: 40 })],
      shareResult: { pendingSeniorSharePercent: null },
    })
    const out = await edit(h, { seniorSharePercent: 26 }, 'admin-1')
    expect(out.pendingSeniorSharePercent).toBeNull()
  })

  it('no seniorSharePercent in the body: propose is not called', async () => {
    const h = makeHarness(senior())
    await edit(h, { displayName: 'x' }, 'admin-1')
    expect(h.proposeSeniorShareChangeInTx).not.toHaveBeenCalled()
  })

  it('non-SENIOR effective role: the request is ignored (propose not called)', async () => {
    const h = makeHarness()
    await edit(h, { seniorSharePercent: 30 }, 'admin-1')
    expect(h.proposeSeniorShareChangeInTx).not.toHaveBeenCalled()
  })

  it('effective role from the body: JUNIOR -> SENIOR in the same PATCH proposes', async () => {
    const h = makeHarness({ updated: [makeUser({ role: 'SENIOR' })] })
    await edit(h, { role: 'SENIOR', seniorSharePercent: 30 }, 'admin-1')
    expect(h.proposeSeniorShareChangeInTx).toHaveBeenCalledTimes(1)
  })

  it('SENIOR demoted in the same PATCH: share request is ignored', async () => {
    const h = makeHarness({ existing: makeUser({ role: 'SENIOR' }) })
    await edit(h, { role: 'HR', seniorSharePercent: 30 }, 'admin-1')
    expect(h.proposeSeniorShareChangeInTx).not.toHaveBeenCalled()
  })

  it('null actorId -> 400 SHARE_CHANGE_REQUESTER_REQUIRED AFTER the users write (tx aborts), nothing later', async () => {
    const h = makeHarness(senior())
    await expect(edit(h, { seniorSharePercent: 30, hrIds: ['h'] })).rejects.toMatchObject(
      code('SHARE_CHANGE_REQUESTER_REQUIRED', 400),
    )
    expect(ops(h.log)).toEqual(['select', 'tx-begin', 'update'])
    expect(h.proposeSeniorShareChangeInTx).not.toHaveBeenCalled()
    expect(h.reconcileSeniorTeamTx).not.toHaveBeenCalled()
  })
})

describe('UsersService.adminUpdateUser — SENIOR team composition + team telegram channel', () => {
  const senior = (extra: Row = {}) => ({
    existing: makeUser({ role: 'SENIOR', ...extra }),
    updated: [makeUser({ role: 'SENIOR', ...extra })],
  })

  it('hrIds only: reconcile gets { hrIds, accountantId: undefined } + returned id + actorId', async () => {
    const h = makeHarness(senior())
    await edit(h, { hrIds: ['hr-1', 'hr-2'] }, 'admin-1')
    expect(h.reconcileSeniorTeamTx).toHaveBeenCalledWith(
      h.tx,
      'target-1',
      { hrIds: ['hr-1', 'hr-2'], accountantId: undefined },
      'admin-1',
    )
    expect(h.updateSeniorTeamTelegramChannelTx).not.toHaveBeenCalled()
  })

  it('empty hrIds still reconciles (clears the team HRs)', async () => {
    const h = makeHarness(senior())
    await edit(h, { hrIds: [] }, 'admin-1')
    expect(h.reconcileSeniorTeamTx).toHaveBeenCalledWith(
      h.tx,
      'target-1',
      { hrIds: [], accountantId: undefined },
      'admin-1',
    )
  })

  it('accountantId null (explicit clear) triggers reconcile with { hrIds: undefined, accountantId: null }', async () => {
    const h = makeHarness(senior())
    await edit(h, { accountantId: null }, 'admin-1')
    expect(h.reconcileSeniorTeamTx).toHaveBeenCalledWith(
      h.tx,
      'target-1',
      { hrIds: undefined, accountantId: null },
      'admin-1',
    )
  })

  it('neither hrIds nor accountantId: no reconcile', async () => {
    const h = makeHarness(senior())
    await edit(h, { displayName: 'x' }, 'admin-1')
    expect(h.reconcileSeniorTeamTx).not.toHaveBeenCalled()
  })

  it('non-SENIOR returned role: no reconcile, no channel propagation', async () => {
    const h = makeHarness()
    await edit(h, { hrIds: ['h'], accountantId: 'a' }, 'admin-1')
    expect(h.reconcileSeniorTeamTx).not.toHaveBeenCalled()
    expect(h.updateSeniorTeamTelegramChannelTx).not.toHaveBeenCalled()
  })

  it('decision uses the RETURNED row role (u.role), not the request', async () => {
    // promoted JUNIOR -> SENIOR in the body, DB row comes back SENIOR
    const promoted = makeHarness({ updated: [makeUser({ role: 'SENIOR' })] })
    await edit(promoted, { role: 'SENIOR', hrIds: ['h'] }, 'admin-1')
    expect(promoted.reconcileSeniorTeamTx).toHaveBeenCalledTimes(1)
    // demoted SENIOR -> JUNIOR: returned JUNIOR, so no reconcile even though existing was SENIOR
    const demoted = makeHarness({
      existing: makeUser({ role: 'SENIOR' }),
      updated: [makeUser({ role: 'JUNIOR' })],
    })
    await edit(demoted, { role: 'JUNIOR', hrIds: ['h'] }, 'admin-1')
    expect(demoted.reconcileSeniorTeamTx).not.toHaveBeenCalled()
  })

  it('teamTelegramChannel: propagated (string, then explicit null) with returned id + actorId', async () => {
    const h = makeHarness(senior())
    await edit(h, { teamTelegramChannel: '@team' }, 'admin-1')
    expect(h.updateSeniorTeamTelegramChannelTx).toHaveBeenCalledWith(
      h.tx,
      'target-1',
      '@team',
      'admin-1',
    )
    expect(h.reconcileSeniorTeamTx).not.toHaveBeenCalled()
    const h2 = makeHarness(senior())
    await edit(h2, { teamTelegramChannel: null }, 'admin-1')
    expect(h2.updateSeniorTeamTelegramChannelTx).toHaveBeenCalledWith(
      h2.tx,
      'target-1',
      null,
      'admin-1',
    )
  })

  it('reconcile runs before the channel propagation, both after the users write', async () => {
    const h = makeHarness(senior())
    await edit(h, { hrIds: ['h'], accountantId: 'acc', teamTelegramChannel: '@t' }, 'admin-1')
    expect(ops(h.log)).toEqual(['select', 'tx-begin', 'update', 'reconcile', 'telegram', 'tx-end'])
  })

  it('actorId is forwarded as null when omitted (system caller)', async () => {
    const h = makeHarness(senior())
    await edit(h, { hrIds: ['h'], teamTelegramChannel: '@t' })
    expect(h.reconcileSeniorTeamTx.mock.calls[0]![3]).toBeNull()
    expect(h.updateSeniorTeamTelegramChannelTx.mock.calls[0]![3]).toBeNull()
  })
})
