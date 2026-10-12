/**
 * Recording-double harness for `UsersService.createUser` specs (see
 * create-user.unit.spec.ts for the full description). Shared by the
 * characterization spec and the team-staff (SR-M-1) spec.
 */
import { expect, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getTableName, type SQL } from 'drizzle-orm'
import { UsersService } from '../users/users.service'

export const dialect = new PgDialect()
export const compile = (cond: SQL | undefined) => {
  if (!cond) return { sql: '', params: [] as unknown[] }
  const q = dialect.sqlToQuery(cond)
  return { sql: q.sql, params: q.params }
}

export type CreateUserInput = Parameters<UsersService['createUser']>[0]
export type Log = Array<Record<string, unknown>>

export interface HarnessOpts {
  existingByEmail?: unknown
  /** keyed by lower-cased address -> existing user_emails row */
  userEmailRows?: Record<string, { userId: string }>
  created?: Record<string, unknown> | undefined
  workInsertError?: unknown
  personalInsertError?: unknown
  personalRows?: Array<{ id: string }>
  teamInsertRows?: Array<{ id: string }>
  isMember?: boolean
  /** id -> users.role for the team-staff role probe (`users.id IN (...)`) */
  staffRoles?: Record<string, string>
  txReturnsEmpty?: boolean
}

export const CREATED = {
  id: 'user-new',
  email: 'stored@cc.com',
  displayName: 'Stored Name',
  role: 'JUNIOR',
}

export function makeHarness(opts: HarnessOpts = {}) {
  const log: Log = []
  const created = 'created' in opts ? opts.created : CREATED
  const personalRows = opts.personalRows ?? [{ id: 'pe-1' }]
  const teamRows = opts.teamInsertRows ?? [{ id: 'team-new' }]

  const makeInsert = (on: 'tx' | 'db') => (t: never) => {
    const table = getTableName(t)
    return {
      values: (values: unknown) => {
        if (table === 'users') {
          return {
            returning: async () => {
              log.push({ op: 'insert', on, table, values })
              return created === undefined ? [] : [created]
            },
          }
        }
        if (table === 'teams') {
          return {
            returning: async () => {
              log.push({ op: 'insert', on, table, values })
              return teamRows
            },
          }
        }
        const run = async (returning: boolean) => {
          log.push({ op: 'insert', on, table, values, returning })
          const v = values as { kind?: string }
          if (table === 'user_emails' && v.kind === 'WORK' && opts.workInsertError)
            throw opts.workInsertError
          if (table === 'user_emails' && v.kind === 'PERSONAL' && opts.personalInsertError)
            throw opts.personalInsertError
          return returning ? personalRows : undefined
        }
        return {
          returning: () => run(true),
          // plain `await insert().values()` (no returning)
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            run(false).then(res, rej),
        }
      },
    }
  }

  const tx = { insert: vi.fn(makeInsert('tx')) }

  const db = {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: (t: never) => ({
        where: (cond: SQL) => {
          const c = compile(cond)
          log.push({ op: 'select', table: getTableName(t), where: c.sql, params: c.params })
          if (c.sql.includes(' in (')) {
            const roles = opts.staffRoles ?? {}
            return Promise.resolve(
              c.params
                .filter((id) => String(id) in roles)
                // Row keys follow the caller's projection, like the real driver: a
                // `.select({})` returns empty rows.
                .map((id) => ({
                  ...(projection && 'id' in projection && { id }),
                  ...(projection && 'role' in projection && { role: roles[String(id)] }),
                })),
            )
          }
          return Promise.resolve(opts.existingByEmail ? [opts.existingByEmail] : [])
        },
      }),
    })),
    insert: vi.fn(makeInsert('db')),
    query: {
      userEmails: {
        findFirst: vi.fn(async (arg: { where: SQL }) => {
          const c = compile(arg.where)
          log.push({ op: 'findFirst', table: 'user_emails', where: c.sql, params: c.params })
          return opts.userEmailRows?.[String(c.params[0])]
        }),
      },
    },
    transaction: vi.fn(async (fn: (t: unknown) => unknown) => {
      log.push({ op: 'tx-begin' })
      const out = await fn(tx)
      log.push({ op: 'tx-end' })
      return opts.txReturnsEmpty ? [] : out
    }),
  }

  const auditRecord = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'audit', args })
  })
  const sendInvite = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'sendInvite', args })
  })
  const issuePersonalEmailInviteTx = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'issueInvite', args })
    return 'raw-token-1'
  })
  const isActiveMemberOfTeam = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'isActiveMemberOfTeam', args })
    return opts.isMember ?? true
  })
  const addSeniorToDropTeam = vi.fn(async (...args: unknown[]) => {
    log.push({ op: 'addSeniorToDropTeam', args })
  })

  const service = Object.assign(Object.create(UsersService.prototype) as UsersService, {
    db: { db },
    auditLogService: { record: auditRecord },
    teamsService: { isActiveMemberOfTeam, addSeniorToDropTeam },
    inviteMailer: { sendInvite },
    _invites: { issuePersonalEmailInviteTx },
  })
  return {
    service,
    log,
    tx,
    db,
    auditRecord,
    sendInvite,
    issuePersonalEmailInviteTx,
    isActiveMemberOfTeam,
    addSeniorToDropTeam,
  }
}

export const baseInput = (over: Partial<CreateUserInput> = {}): CreateUserInput => ({
  email: 'Input@CC.com',
  displayName: 'Input Name',
  role: 'JUNIOR',
  actorRole: 'ADMIN',
  actorId: 'admin-1',
  ...over,
})

export const inserts = (log: Log, table: string) =>
  log.filter((e) => e.op === 'insert' && e.table === table)
export const usersInsertValues = (log: Log) =>
  inserts(log, 'users')[0]!.values as Record<string, unknown>
export const code = (c: string, statusCode: number) => ({
  response: expect.objectContaining({ code: c, statusCode }),
})
export const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' })
