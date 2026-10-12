/**
 * Characterization (unit) net for the DROP cluster of UsersService:
 * `createDrop` (the only drop-specific method that still lives in
 * users.service.ts; `archiveDrop` is a one-line delegate to UserArchiveService
 * and the insert-values builder `buildDropInsertValues` is already extracted
 * to user-insert.util.ts, so both are out of scope here).
 *
 * `createDrop` is a `users` + `user_emails` WRITER and an RBAC path (ADMIN
 * only), so it is pinned BEFORE it moves. The older `users.drop.spec.ts`
 * only checks fragments (`expect.objectContaining`, `expect.anything()`); this
 * spec pins the whole observable surface over a recording double: every
 * statement in order, the exact inserted rows, the audit entries and the tx
 * handle threaded into every collaborator, WHERE clauses compiled to
 * SQL + params through PgDialect.
 *
 * Harness: `Object.assign(Object.create(UsersService.prototype), {...})`
 * (house convention); deps are `db`, `auditLogService`, `teamAuditLogService`,
 * `teamsService`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName, type SQL } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { UsersService } from './users.service'

const dialect = new PgDialect()
const compile = (cond: SQL | undefined) => {
  if (!cond) return { sql: '', params: [] as unknown[] }
  const q = dialect.sqlToQuery(cond)
  return { sql: q.sql, params: q.params }
}

const FIXED_NOW = new Date('2026-03-04T05:06:07.000Z')

type CreateDropInput = Parameters<UsersService['createDrop']>[0]

const admin: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@cc.com',
  avatarUrl: null,
  seniorSharePercent: 26,
}

interface HarnessOpts {
  existingByEmail?: unknown
  userEmailRow?: { userId: string } | undefined
  created?: Record<string, unknown> | undefined
  userEmailsInsertError?: unknown
  createDropTeamError?: unknown
}

const CREATED = {
  id: 'drop-new',
  email: 'stored-drop@cc.com',
  displayName: 'Stored Drop Name',
  role: 'DROP',
}

function makeHarness(opts: HarnessOpts = {}) {
  const log: Array<Record<string, unknown>> = []
  const created = 'created' in opts ? opts.created : CREATED

  const tx = {
    insert: vi.fn((t: never) => {
      const table = getTableName(t)
      return {
        values: (values: unknown) => {
          if (table === 'users') {
            return {
              returning: async () => {
                log.push({ op: 'insert', table, values })
                return created === undefined ? [] : [created]
              },
            }
          }
          const p = (async () => {
            log.push({ op: 'insert', table, values })
            if (opts.userEmailsInsertError) throw opts.userEmailsInsertError
          })()
          return p
        },
      }
    }),
  }

  const db = {
    select: vi.fn(() => {
      const chain = {
        from: (t: never) => {
          const table = getTableName(t)
          return {
            where: (cond: SQL) => {
              const c = compile(cond)
              log.push({ op: 'select', table, where: c.sql, params: c.params })
              const rows = opts.existingByEmail ? [opts.existingByEmail] : []
              return Promise.resolve(rows)
            },
          }
        },
      }
      return chain
    }),
    query: {
      userEmails: {
        findFirst: vi.fn(async (arg: { where: SQL }) => {
          const c = compile(arg.where)
          log.push({ op: 'findFirst', table: 'user_emails', where: c.sql, params: c.params })
          return opts.userEmailRow
        }),
      },
    },
    transaction: vi.fn(async (fn: (t: unknown) => unknown) => {
      log.push({ op: 'tx-begin' })
      return fn(tx)
    }),
  }

  const auditRecord = vi.fn(async (entry: Record<string, unknown>, passedTx: unknown) => {
    log.push({ op: 'audit', entry, tx: passedTx })
  })
  const teamAuditRecord = vi.fn(async (entry: Record<string, unknown>, passedTx: unknown) => {
    log.push({ op: 'team-audit', entry, tx: passedTx })
  })
  const createDropTeam = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'createDropTeam', args })
    if (opts.createDropTeamError) throw opts.createDropTeamError
    return { id: 'team-9', name: 'Drop Team Name' }
  })

  const service = Object.assign(Object.create(UsersService.prototype) as UsersService, {
    db: { db },
    auditLogService: { record: auditRecord },
    teamAuditLogService: { record: teamAuditRecord },
    teamsService: { createDropTeam },
  })
  return { service, log, tx, db, auditRecord, teamAuditRecord, createDropTeam }
}

const baseInput = (over: Partial<CreateDropInput> = {}): CreateDropInput => ({
  email: 'Input-Drop@CC.com',
  displayName: 'Input Drop',
  hrIds: ['hr-1'],
  ...over,
})

const insertOf = (log: Array<Record<string, unknown>>, table: string) =>
  log.find((e) => e.op === 'insert' && e.table === table)

describe('UsersService.createDrop — RBAC gate and pre-flight checks', () => {
  it.each(['SENIOR', 'HR', 'JUNIOR', 'ACCOUNTANT', 'DROP'] as const)(
    'rejects %s actor with 403 DROP_CREATE_ADMIN_ONLY before touching the db',
    async (role) => {
      const h = makeHarness()
      await expect(
        h.service.createDrop(baseInput(), { ...admin, id: 'x-1', role }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DROP_CREATE_ADMIN_ONLY', statusCode: 403 }),
      })
      expect(h.log).toEqual([])
      expect(h.db.transaction).not.toHaveBeenCalled()
    },
  )

  it('checks the role BEFORE hrIds (non-admin with empty hrIds gets 403, not 400)', async () => {
    const h = makeHarness()
    await expect(
      h.service.createDrop(baseInput({ hrIds: [] }), { ...admin, role: 'HR' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DROP_CREATE_ADMIN_ONLY', statusCode: 403 }),
    })
  })

  it('rejects an empty hrIds list with 400 HR_REQUIRED_MINIMUM_ONE before any db access', async () => {
    const h = makeHarness()
    await expect(h.service.createDrop(baseInput({ hrIds: [] }), admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'HR_REQUIRED_MINIMUM_ONE', statusCode: 400 }),
    })
    expect(h.log).toEqual([])
  })

  it('accepts exactly one HR (boundary: floor is 1, not 2)', async () => {
    const h = makeHarness()
    await expect(h.service.createDrop(baseInput({ hrIds: ['only-hr'] }), admin)).resolves.toEqual({
      user: CREATED,
      teamId: 'team-9',
    })
  })

  it('rejects a duplicate users.email with 409 USER_EMAIL_EXISTS (exact lookup, no user_emails check, no tx)', async () => {
    const h = makeHarness({ existingByEmail: { id: 'someone' } })
    await expect(h.service.createDrop(baseInput(), admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'USER_EMAIL_EXISTS', statusCode: 409 }),
    })
    expect(h.log).toEqual([
      {
        op: 'select',
        table: 'users',
        where: '"users"."email" = $1',
        // findByEmail is case-SENSITIVE on users.email (the lowered check is
        // the user_emails one below).
        params: ['Input-Drop@CC.com'],
      },
    ])
    expect(h.db.query.userEmails.findFirst).not.toHaveBeenCalled()
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('rejects an address owned by ANOTHER user in user_emails with 409 EMAIL_TAKEN_BY_ANOTHER_USER (case-folded probe, no tx)', async () => {
    const h = makeHarness({ userEmailRow: { userId: 'other-user' } })
    await expect(h.service.createDrop(baseInput(), admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EMAIL_TAKEN_BY_ANOTHER_USER', statusCode: 409 }),
    })
    expect(h.log).toEqual([
      {
        op: 'select',
        table: 'users',
        where: '"users"."email" = $1',
        params: ['Input-Drop@CC.com'],
      },
      {
        op: 'findFirst',
        table: 'user_emails',
        where: 'lower("user_emails"."email") = $1',
        params: ['input-drop@cc.com'],
      },
    ])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('treats ANY existing user_emails row as a conflict (no excludeUserId is passed)', async () => {
    // userId undefined on the stub row must NOT equal an absent excludeUserId
    // in a way that lets the row through — a row with userId matching nothing
    // still conflicts.
    const h = makeHarness({ userEmailRow: { userId: 'drop-new' } })
    await expect(h.service.createDrop(baseInput(), admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EMAIL_TAKEN_BY_ANOTHER_USER' }),
    })
  })
})

describe('UsersService.createDrop — transactional write', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('performs the full sequence in order, all writes on the SAME tx handle', async () => {
    const h = makeHarness()
    const result = await h.service.createDrop(
      baseInput({
        telegramChannel: '@drop_channel',
        accountantId: 'acc-1',
        hrIds: ['hr-1', 'hr-2'],
      }),
      admin,
    )

    expect(result).toEqual({ user: CREATED, teamId: 'team-9' })
    expect(h.log).toEqual([
      {
        op: 'select',
        table: 'users',
        where: '"users"."email" = $1',
        params: ['Input-Drop@CC.com'],
      },
      {
        op: 'findFirst',
        table: 'user_emails',
        where: 'lower("user_emails"."email") = $1',
        params: ['input-drop@cc.com'],
      },
      { op: 'tx-begin' },
      {
        op: 'insert',
        table: 'users',
        values: {
          email: 'Input-Drop@CC.com',
          displayName: 'Input Drop',
          role: 'DROP',
          telegram: null,
          phone: null,
          avatarUrl: null,
          techStack: null,
          dropSharePercent: 5,
        },
      },
      {
        op: 'insert',
        table: 'user_emails',
        values: {
          userId: 'drop-new',
          // the STORED address (created.email), not the raw input
          email: 'stored-drop@cc.com',
          kind: 'WORK',
          canLogin: true,
          verifiedAt: FIXED_NOW,
        },
      },
      {
        op: 'audit',
        entry: {
          actorId: 'admin-1',
          targetId: 'drop-new',
          action: 'profile_created',
          changes: {
            displayName: { before: null, after: 'Stored Drop Name' },
            role: { before: null, after: 'DROP' },
          },
        },
        tx: h.tx,
      },
      {
        op: 'createDropTeam',
        args: ['drop-new', ['hr-1', 'hr-2'], 'acc-1', '@drop_channel', h.tx],
      },
      {
        op: 'team-audit',
        entry: {
          actorId: 'admin-1',
          targetId: 'team-9',
          action: 'team_created',
          changes: { name: { before: null, after: 'Drop Team Name' } },
        },
        tx: h.tx,
      },
    ])
    // The user audit goes to auditLogService, the team audit to
    // teamAuditLogService (not swapped).
    expect(h.auditRecord).toHaveBeenCalledTimes(1)
    expect(h.teamAuditRecord).toHaveBeenCalledTimes(1)
  })

  it('defaults accountantId and telegramChannel to null when omitted', async () => {
    const h = makeHarness()
    await h.service.createDrop(baseInput(), admin)
    expect(h.createDropTeam).toHaveBeenCalledWith('drop-new', ['hr-1'], null, null, h.tx)
  })

  it('maps explicit null accountantId / telegramChannel to null', async () => {
    const h = makeHarness()
    await h.service.createDrop(baseInput({ accountantId: null, telegramChannel: null }), admin)
    expect(h.createDropTeam).toHaveBeenCalledWith('drop-new', ['hr-1'], null, null, h.tx)
  })

  it('persists optional profile fields verbatim and keeps an explicit dropSharePercent', async () => {
    const h = makeHarness()
    await h.service.createDrop(
      baseInput({
        telegram: '@drop',
        phone: '+380501112233',
        avatarUrl: 'https://example.com/a.png',
        techStack: ['ts', 'go'],
        dropSharePercent: 12,
      }),
      admin,
    )
    expect(insertOf(h.log, 'users')).toEqual({
      op: 'insert',
      table: 'users',
      values: {
        email: 'Input-Drop@CC.com',
        displayName: 'Input Drop',
        role: 'DROP',
        telegram: '@drop',
        phone: '+380501112233',
        avatarUrl: 'https://example.com/a.png',
        techStack: ['ts', 'go'],
        dropSharePercent: 12,
      },
    })
  })

  it('keeps dropSharePercent 0 (nullish default, not falsy default)', async () => {
    const h = makeHarness()
    await h.service.createDrop(baseInput({ dropSharePercent: 0 }), admin)
    expect((insertOf(h.log, 'users') as { values: { dropSharePercent: number } }).values).toEqual(
      expect.objectContaining({ dropSharePercent: 0 }),
    )
  })

  it('persists USDT requisites only (no bank columns) for paymentMethod USDT_ERC20', async () => {
    const h = makeHarness()
    await h.service.createDrop(
      baseInput({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0x1111111111111111111111111111111111111111',
        walletUsdtLabel: 'main',
        bankUahIban: 'UA00IGNORED',
        bankUahRecipient: 'ignored',
      }),
      admin,
    )
    expect(insertOf(h.log, 'users')).toEqual({
      op: 'insert',
      table: 'users',
      values: {
        email: 'Input-Drop@CC.com',
        displayName: 'Input Drop',
        role: 'DROP',
        telegram: null,
        phone: null,
        avatarUrl: null,
        techStack: null,
        dropSharePercent: 5,
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0x1111111111111111111111111111111111111111',
        walletUsdtLabel: 'main',
      },
    })
  })

  it('nulls missing USDT sub-fields when the method is chosen but they are absent', async () => {
    const h = makeHarness()
    await h.service.createDrop(baseInput({ paymentMethod: 'USDT_ERC20' }), admin)
    const values = (insertOf(h.log, 'users') as { values: Record<string, unknown> }).values
    expect(values.walletUsdtErc20).toBeNull()
    expect(values.walletUsdtLabel).toBeNull()
    expect(values).not.toHaveProperty('bankUahIban')
  })

  it('persists bank requisites only (no wallet columns) for paymentMethod BANK_UAH_FOP', async () => {
    const h = makeHarness()
    await h.service.createDrop(
      baseInput({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'ФОП Дропенко',
        bankUahIban: 'UA213223130000026007233566001',
        bankUahRnokpp: '1234567890',
        bankUahBankName: 'Mono',
        walletUsdtErc20: '0xIGNORED',
        walletUsdtLabel: 'ignored',
      }),
      admin,
    )
    expect(insertOf(h.log, 'users')).toEqual({
      op: 'insert',
      table: 'users',
      values: {
        email: 'Input-Drop@CC.com',
        displayName: 'Input Drop',
        role: 'DROP',
        telegram: null,
        phone: null,
        avatarUrl: null,
        techStack: null,
        dropSharePercent: 5,
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'ФОП Дропенко',
        bankUahIban: 'UA213223130000026007233566001',
        bankUahRnokpp: '1234567890',
        bankUahBankName: 'Mono',
      },
    })
  })

  it('nulls missing bank sub-fields when BANK_UAH_FOP is chosen but they are absent', async () => {
    const h = makeHarness()
    await h.service.createDrop(baseInput({ paymentMethod: 'BANK_UAH_FOP' }), admin)
    const values = (insertOf(h.log, 'users') as { values: Record<string, unknown> }).values
    expect(values.bankUahRecipient).toBeNull()
    expect(values.bankUahIban).toBeNull()
    expect(values.bankUahRnokpp).toBeNull()
    expect(values.bankUahBankName).toBeNull()
    expect(values).not.toHaveProperty('walletUsdtErc20')
  })

  it('persists no payment columns at all when paymentMethod is omitted', async () => {
    const h = makeHarness()
    await h.service.createDrop(
      baseInput({ walletUsdtErc20: '0xnope', bankUahIban: 'UAnope' }),
      admin,
    )
    const values = (insertOf(h.log, 'users') as { values: Record<string, unknown> }).values
    expect(Object.keys(values).sort()).toEqual(
      [
        'avatarUrl',
        'displayName',
        'dropSharePercent',
        'email',
        'phone',
        'role',
        'techStack',
        'telegram',
      ].sort(),
    )
  })

  it('persists trimmed contract fields; blank values are omitted', async () => {
    const h = makeHarness()
    await h.service.createDrop(
      baseInput({ legalFullName: '  Дропенко Дроп  ', registrationAddress: '   ' }),
      admin,
    )
    const values = (insertOf(h.log, 'users') as { values: Record<string, unknown> }).values
    expect(values.legalFullName).toBe('Дропенко Дроп')
    expect(values).not.toHaveProperty('registrationAddress')
  })

  it('attributes BOTH audit rows to the real operator under impersonation', async () => {
    const h = makeHarness()
    await h.service.createDrop(baseInput(), { ...admin, impersonatorId: 'real-op' })
    expect(h.auditRecord.mock.calls[0]?.[0]).toMatchObject({ actorId: 'real-op' })
    expect(h.teamAuditRecord.mock.calls[0]?.[0]).toMatchObject({ actorId: 'real-op' })
  })

  it('attributes both audit rows to actor.id when not impersonating', async () => {
    const h = makeHarness()
    await h.service.createDrop(baseInput(), { ...admin, id: 'admin-7' })
    expect(h.auditRecord.mock.calls[0]?.[0]).toMatchObject({ actorId: 'admin-7' })
    expect(h.teamAuditRecord.mock.calls[0]?.[0]).toMatchObject({ actorId: 'admin-7' })
  })

  it('throws "Failed to create drop user" when the insert returns no row, writing nothing further', async () => {
    const h = makeHarness({ created: undefined })
    await expect(h.service.createDrop(baseInput(), admin)).rejects.toThrow(
      'Failed to create drop user',
    )
    expect(insertOf(h.log, 'user_emails')).toBeUndefined()
    expect(h.auditRecord).not.toHaveBeenCalled()
    expect(h.createDropTeam).not.toHaveBeenCalled()
    expect(h.teamAuditRecord).not.toHaveBeenCalled()
  })

  it('maps a unique violation on the user_emails insert to 409 EMAIL_ALREADY_IN_USE, no audit/team after', async () => {
    const h = makeHarness({
      userEmailsInsertError: Object.assign(new Error('dup'), { code: '23505' }),
    })
    await expect(h.service.createDrop(baseInput(), admin)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EMAIL_ALREADY_IN_USE', statusCode: 409 }),
    })
    expect(h.auditRecord).not.toHaveBeenCalled()
    expect(h.createDropTeam).not.toHaveBeenCalled()
  })

  it('rethrows a non-unique user_emails insert error untouched', async () => {
    const boom = Object.assign(new Error('connection lost'), { code: '08006' })
    const h = makeHarness({ userEmailsInsertError: boom })
    await expect(h.service.createDrop(baseInput(), admin)).rejects.toBe(boom)
    expect(h.auditRecord).not.toHaveBeenCalled()
  })

  it('propagates a createDropTeam failure and does not record the team audit', async () => {
    const boom = new Error('team failed')
    const h = makeHarness({ createDropTeamError: boom })
    await expect(h.service.createDrop(baseInput(), admin)).rejects.toBe(boom)
    expect(h.teamAuditRecord).not.toHaveBeenCalled()
  })
})
