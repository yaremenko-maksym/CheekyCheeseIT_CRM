import { HttpException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { teamAuditLog } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import {
  assertUserRole,
  fetchAllProjects,
  isActiveMemberOfTeam,
  wasFormerMemberOfTeam,
  type TeamsDb,
} from './team-membership-read.util'

const dialect = new PgDialect()
const render = (cond: SQL) => dialect.sqlToQuery(cond)

/** db whose `query.teamMembers.findFirst` resolves to `row`, capturing its args. */
function memberDb(row: unknown) {
  const findFirst = vi.fn().mockResolvedValue(row)
  return { db: { query: { teamMembers: { findFirst } } } as unknown as TeamsDb, findFirst }
}

/** db whose `select().from().where().limit()` chain resolves to `rows`. */
function auditDb(rows: unknown[]) {
  const limit = vi.fn().mockReturnValue(Promise.resolve(rows))
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  return { db: { select } as unknown as TeamsDb, select, where, limit }
}

/** handle whose `select().from().where()` resolves to `rows`. */
function userHandle(rows: unknown[]) {
  const where = vi.fn().mockReturnValue(Promise.resolve(rows))
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  return { handle: { select } as unknown as TeamsDb, select }
}

describe('isActiveMemberOfTeam', () => {
  it('true when an active membership row exists', async () => {
    const { db } = memberDb({ id: 'm1' })
    expect(await isActiveMemberOfTeam(db, 't1', 'u1')).toBe(true)
  })

  it('false when no row matches', async () => {
    const { db } = memberDb(undefined)
    expect(await isActiveMemberOfTeam(db, 't1', 'u1')).toBe(false)
  })

  it('scopes to team, user and leftAt IS NULL', async () => {
    const { db, findFirst } = memberDb(undefined)
    await isActiveMemberOfTeam(db, 'team-X', 'user-Y')
    const q = render(findFirst.mock.calls[0]![0].where as SQL)
    expect(q.sql).toBe(
      '("team_members"."team_id" = $1 and "team_members"."user_id" = $2 and "team_members"."left_at" is null)',
    )
    expect(q.params).toEqual(['team-X', 'user-Y'])
  })
})

describe('wasFormerMemberOfTeam', () => {
  it('true when a positive SENIOR-removal audit row exists', async () => {
    const { db } = auditDb([{ id: 'a1' }])
    expect(await wasFormerMemberOfTeam(db, 't1', 'u1')).toBe(true)
  })

  it('false (fail-closed) when no audit row exists', async () => {
    const { db } = auditDb([])
    expect(await wasFormerMemberOfTeam(db, 't1', 'u1')).toBe(false)
  })

  it('requires team_member_removed + role.before = SENIOR for this team and user, limit 1', async () => {
    const { db, select, where, limit } = auditDb([])
    await wasFormerMemberOfTeam(db, 'team-X', 'user-Y')
    expect(select).toHaveBeenCalledWith({ id: teamAuditLog.id })
    const q = render(where.mock.calls[0]![0] as SQL)
    expect(q.sql).toBe(
      `("team_audit_log"."target_id" = $1 and "team_audit_log"."action" = $2 and "team_audit_log"."changes" -> 'userId' ->> 'before' = $3 and "team_audit_log"."changes" -> 'role' ->> 'before' = 'SENIOR')`,
    )
    expect(q.params).toEqual(['team-X', 'team_member_removed', 'user-Y'])
    expect(limit).toHaveBeenCalledWith(1)
  })
})

describe('fetchAllProjects', () => {
  it('loads every project with members and their users', async () => {
    const projects = [{ id: 'p1', members: [] }]
    const findMany = vi.fn().mockResolvedValue(projects)
    const db = { query: { projects: { findMany } } } as unknown as TeamsDb
    expect(await fetchAllProjects(db)).toBe(projects)
    expect(findMany).toHaveBeenCalledWith({ with: { members: { with: { user: true } } } })
  })
})

describe('assertUserRole', () => {
  async function bodyOf(p: Promise<unknown>) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HttpException)
    const e = err as HttpException
    expect(e.getStatus()).toBe(400)
    return e.getResponse() as { code: string; params?: Record<string, string> }
  }

  it('resolves when the user has the expected role', async () => {
    const { handle } = userHandle([{ id: 'u1', role: 'SENIOR' }])
    await expect(assertUserRole(handle, 'u1', 'SENIOR')).resolves.toBeUndefined()
  })

  it('queries the tx handle when given, never the base db', async () => {
    const base = userHandle([])
    const tx = userHandle([{ id: 'u1', role: 'HR' }])
    await assertUserRole(base.handle, 'u1', 'HR', tx.handle as unknown as DrizzleTx)
    expect(tx.select).toHaveBeenCalledTimes(1)
    expect(base.select).not.toHaveBeenCalled()
  })

  it('queries the base db when no tx is given', async () => {
    const base = userHandle([{ id: 'u1', role: 'HR' }])
    await assertUserRole(base.handle, 'u1', 'HR')
    expect(base.select).toHaveBeenCalledTimes(1)
  })

  it('USER_NOT_FOUND (400) for a missing user', async () => {
    const { handle } = userHandle([])
    const body = await bodyOf(assertUserRole(handle, 'u1', 'SENIOR'))
    expect(body.code).toBe('USER_NOT_FOUND')
  })

  it('TEAM_UNEXPECTED_USER_ROLE with expected/actual role params on a role mismatch', async () => {
    const { handle } = userHandle([{ id: 'u1', role: 'JUNIOR' }])
    const body = await bodyOf(assertUserRole(handle, 'u1', 'SENIOR'))
    expect(body.code).toBe('TEAM_UNEXPECTED_USER_ROLE')
    expect(body.params).toEqual({ expectedRole: 'SENIOR', actualRole: 'JUNIOR' })
  })

  it('genericMessage: same generic code for missing user AND wrong role (no oracle)', async () => {
    const missing = userHandle([])
    const wrong = userHandle([{ id: 'u1', role: 'JUNIOR' }])
    const a = await bodyOf(assertUserRole(missing.handle, 'u1', 'SENIOR', undefined, true))
    const b = await bodyOf(assertUserRole(wrong.handle, 'u1', 'SENIOR', undefined, true))
    expect(a.code).toBe('TEAM_USER_NOT_FOUND_OR_WRONG_ROLE')
    expect(b.code).toBe('TEAM_USER_NOT_FOUND_OR_WRONG_ROLE')
    expect(a.params).toBeUndefined()
    expect(b.params).toBeUndefined()
  })
})
