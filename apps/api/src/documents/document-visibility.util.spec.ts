import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentCategory, Role, SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import type { HrAccessService } from '../common/hr-access.service'

vi.mock('./document-scope.util', () => ({
  getTeammateIds: vi.fn(),
  getHrSeniorIds: vi.fn(),
}))

import { getHrSeniorIds, getTeammateIds } from './document-scope.util'
import { buildListWhere, buildVisibilityClause } from './document-visibility.util'

const dialect = new PgDialect()
const render = (q: SQL) => {
  const { sql, params } = dialect.sqlToQuery(q)
  return { sql, params }
}

const db = { db: {} } as unknown as DatabaseService
const hrAccess = {} as unknown as HrAccessService

const actor = (role: Role, id = 'u-1'): SessionUser => ({ id, role }) as unknown as SessionUser

const vis = (role: Role, category?: DocumentCategory) =>
  buildVisibilityClause(db, hrAccess, actor(role), category ? { category } : {})

async function visSql(role: Role, category?: DocumentCategory) {
  const r = await vis(role, category)
  if (r === null || r === 'NONE') return r
  return render(r)
}

const CAT = '"documents"."category"'
const OWN = '"documents"."owner_id"'

beforeEach(() => {
  vi.mocked(getTeammateIds).mockReset().mockResolvedValue(['t-1', 't-2'])
  vi.mocked(getHrSeniorIds).mockReset().mockResolvedValue(['s-1'])
})

describe('buildVisibilityClause', () => {
  it('ADMIN: no visibility predicate at all, no scope lookups', async () => {
    expect(await vis('ADMIN')).toBeNull()
    expect(getTeammateIds).not.toHaveBeenCalled()
  })

  it('JUNIOR, no category: RESUME/SCAN self + AVATAR self + INVOICE self, in that order', async () => {
    const r = await visSql('JUNIOR')
    expect(r).toEqual({
      sql:
        `((${CAT} = $1 and ${OWN} = $2) or (${CAT} = $3 and ${OWN} = $4) or ` +
        `(${CAT} = $5 and ${OWN} = $6) or (${CAT} = $7 and ${OWN} = $8))`,
      params: ['RESUME', 'u-1', 'SCAN', 'u-1', 'AVATAR', 'u-1', 'INVOICE', 'u-1'],
    })
    expect(getTeammateIds).not.toHaveBeenCalled()
  })

  it('JUNIOR: CONTRACT / RECEIPT / LOGO are invisible', async () => {
    expect(await vis('JUNIOR', 'CONTRACT')).toBe('NONE')
    expect(await vis('JUNIOR', 'RECEIPT')).toBe('NONE')
    expect(await vis('JUNIOR', 'LOGO')).toBe('NONE')
  })

  it('JUNIOR: RESUME and SCAN are self-only', async () => {
    expect(await visSql('JUNIOR', 'RESUME')).toEqual({
      sql: `(${CAT} = $1 and ${OWN} = $2)`,
      params: ['RESUME', 'u-1'],
    })
    expect(await visSql('JUNIOR', 'SCAN')).toEqual({
      sql: `(${CAT} = $1 and ${OWN} = $2)`,
      params: ['SCAN', 'u-1'],
    })
  })

  it.each(['SENIOR', 'HR'] as const)(
    '%s: RESUME and SCAN are scoped to teammate ids',
    async (role) => {
      expect(await visSql(role, 'RESUME')).toEqual({
        sql: `(${CAT} = $1 and ${OWN} in ($2, $3))`,
        params: ['RESUME', 't-1', 't-2'],
      })
      expect(await visSql(role, 'SCAN')).toEqual({
        sql: `(${CAT} = $1 and ${OWN} in ($2, $3))`,
        params: ['SCAN', 't-1', 't-2'],
      })
      expect(getTeammateIds).toHaveBeenCalledWith(db, hrAccess, 'u-1', role)
    },
  )

  it('SENIOR, no category: resolves teammates once and orders RESUME, SCAN, CONTRACT, RECEIPT, AVATAR, LOGO, INVOICE', async () => {
    const r = await visSql('SENIOR')
    expect(getTeammateIds).toHaveBeenCalledTimes(1)
    expect(r).toEqual({
      sql:
        `((${CAT} = $1 and ${OWN} in ($2, $3)) or (${CAT} = $4 and ${OWN} in ($5, $6)) or ` +
        `(${CAT} = $7 and ${OWN} = $8) or (${CAT} = $9 and ${OWN} = $10) or ` +
        `(${CAT} = $11 and ${OWN} = $12) or ${CAT} = $13 or (${CAT} = $14 and ${OWN} = $15))`,
      params: [
        'RESUME',
        't-1',
        't-2',
        'SCAN',
        't-1',
        't-2',
        'CONTRACT',
        'u-1',
        'RECEIPT',
        'u-1',
        'AVATAR',
        'u-1',
        'LOGO',
        'INVOICE',
        'u-1',
      ],
    })
  })

  it('SENIOR: CONTRACT, RECEIPT, INVOICE own; LOGO all', async () => {
    for (const c of ['CONTRACT', 'RECEIPT', 'INVOICE'] as const) {
      expect(await visSql('SENIOR', c)).toEqual({
        sql: `(${CAT} = $1 and ${OWN} = $2)`,
        params: [c, 'u-1'],
      })
    }
    expect(await visSql('SENIOR', 'LOGO')).toEqual({ sql: `${CAT} = $1`, params: ['LOGO'] })
  })

  it('SENIOR/HR with an empty teammate set stay scoped (match nothing), never fall back to self, for RESUME', async () => {
    vi.mocked(getTeammateIds).mockResolvedValue([])
    const r = await vis('SENIOR', 'RESUME')
    // An empty array is truthy -> scoped branch, NOT the self fallback.
    expect(r).not.toBe('NONE')
    expect(render(r as SQL)).toEqual({ sql: `(${CAT} = $1 and false)`, params: ['RESUME'] })
  })

  it('HR CONTRACT: scoped to seniors of HR teams', async () => {
    expect(await visSql('HR', 'CONTRACT')).toEqual({
      sql: `(${CAT} = $1 and ${OWN} in ($2))`,
      params: ['CONTRACT', 's-1'],
    })
    expect(getHrSeniorIds).toHaveBeenCalledWith(db, 'u-1')
  })

  it('HR CONTRACT: no seniors -> NONE', async () => {
    vi.mocked(getHrSeniorIds).mockResolvedValue([])
    expect(await vis('HR', 'CONTRACT')).toBe('NONE')
  })

  it('HR: RECEIPT none; LOGO all; INVOICE / AVATAR own', async () => {
    expect(await vis('HR', 'RECEIPT')).toBe('NONE')
    expect(await visSql('HR', 'LOGO')).toEqual({ sql: `${CAT} = $1`, params: ['LOGO'] })
    expect(await visSql('HR', 'INVOICE')).toEqual({
      sql: `(${CAT} = $1 and ${OWN} = $2)`,
      params: ['INVOICE', 'u-1'],
    })
    expect(await visSql('HR', 'AVATAR')).toEqual({
      sql: `(${CAT} = $1 and ${OWN} = $2)`,
      params: ['AVATAR', 'u-1'],
    })
  })

  it('HR does not resolve senior ids for non-CONTRACT categories', async () => {
    await vis('HR', 'RESUME')
    await vis('HR', 'LOGO')
    expect(getHrSeniorIds).not.toHaveBeenCalled()
  })

  it('ACCOUNTANT: SCAN, RECEIPT, INVOICE unconditional; AVATAR own; RESUME/CONTRACT/LOGO none', async () => {
    expect(await visSql('ACCOUNTANT', 'SCAN')).toEqual({ sql: `${CAT} = $1`, params: ['SCAN'] })
    expect(await visSql('ACCOUNTANT', 'RECEIPT')).toEqual({
      sql: `${CAT} = $1`,
      params: ['RECEIPT'],
    })
    expect(await visSql('ACCOUNTANT', 'INVOICE')).toEqual({
      sql: `${CAT} = $1`,
      params: ['INVOICE'],
    })
    expect(await visSql('ACCOUNTANT', 'AVATAR')).toEqual({
      sql: `(${CAT} = $1 and ${OWN} = $2)`,
      params: ['AVATAR', 'u-1'],
    })
    expect(await vis('ACCOUNTANT', 'RESUME')).toBe('NONE')
    expect(await vis('ACCOUNTANT', 'CONTRACT')).toBe('NONE')
    expect(await vis('ACCOUNTANT', 'LOGO')).toBe('NONE')
    expect(getTeammateIds).not.toHaveBeenCalled()
  })

  it('ACCOUNTANT, no category: SCAN, RECEIPT, AVATAR, INVOICE in order', async () => {
    expect(await visSql('ACCOUNTANT')).toEqual({
      sql: `(${CAT} = $1 or ${CAT} = $2 or (${CAT} = $3 and ${OWN} = $4) or ${CAT} = $5)`,
      params: ['SCAN', 'RECEIPT', 'AVATAR', 'u-1', 'INVOICE'],
    })
  })

  it('DROP: RESUME/SCAN/CONTRACT self, AVATAR self, INVOICE self; RECEIPT/LOGO none', async () => {
    for (const c of ['RESUME', 'SCAN', 'CONTRACT', 'AVATAR', 'INVOICE'] as const) {
      expect(await visSql('DROP', c)).toEqual({
        sql: `(${CAT} = $1 and ${OWN} = $2)`,
        params: [c, 'u-1'],
      })
    }
    expect(await vis('DROP', 'RECEIPT')).toBe('NONE')
    expect(await vis('DROP', 'LOGO')).toBe('NONE')
    expect(getTeammateIds).not.toHaveBeenCalled()
  })

  it('DROP, no category: RESUME, SCAN, CONTRACT, AVATAR, INVOICE in order', async () => {
    expect(await visSql('DROP')).toEqual({
      sql:
        `((${CAT} = $1 and ${OWN} = $2) or (${CAT} = $3 and ${OWN} = $4) or ` +
        `(${CAT} = $5 and ${OWN} = $6) or (${CAT} = $7 and ${OWN} = $8) or ` +
        `(${CAT} = $9 and ${OWN} = $10))`,
      params: [
        'RESUME',
        'u-1',
        'SCAN',
        'u-1',
        'CONTRACT',
        'u-1',
        'AVATAR',
        'u-1',
        'INVOICE',
        'u-1',
      ],
    })
  })

  it('uses the actor id (not a constant) in every self predicate', async () => {
    const r = await buildVisibilityClause(db, hrAccess, actor('JUNIOR', 'zzz'), {
      category: 'AVATAR',
    })
    expect(render(r as SQL).params).toEqual(['AVATAR', 'zzz'])
  })
})

describe('buildListWhere', () => {
  const list = async (role: Role, filters: Parameters<typeof buildListWhere>[3]) => {
    const r = await buildListWhere(db, hrAccess, actor(role), filters)
    return r === 'NONE' ? r : render(r)
  }

  it('ADMIN default: not deleted + public category set, no visibility clause', async () => {
    expect(await list('ADMIN', {})).toEqual({
      sql: `("documents"."deleted_at" is null and ${CAT} in ($1, $2, $3, $4, $5))`,
      params: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
    })
  })

  it('ADMIN includeDeleted drops the soft-delete filter', async () => {
    expect(await list('ADMIN', { includeDeleted: true })).toEqual({
      sql: `${CAT} in ($1, $2, $3, $4, $5)`,
      params: ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'],
    })
  })

  it('non-ADMIN includeDeleted is ignored (soft-delete filter stays)', async () => {
    const r = await list('JUNIOR', { includeDeleted: true, category: 'RESUME' })
    expect(r).not.toBe('NONE')
    expect((r as { sql: string }).sql).toContain('"documents"."deleted_at" is null')
  })

  it('ADMIN explicit category (internal allowed) + project + owner filters, in order', async () => {
    expect(await list('ADMIN', { category: 'AVATAR', projectId: 'p-1', ownerId: 'o-1' })).toEqual({
      sql:
        `("documents"."deleted_at" is null and "documents"."project_id" = $1 and ` +
        `${CAT} = $2 and ${OWN} = $3)`,
      params: ['p-1', 'AVATAR', 'o-1'],
    })
  })

  it('returns NONE when visibility is NONE', async () => {
    expect(await list('JUNIOR', { category: 'CONTRACT' })).toBe('NONE')
  })

  it('non-ADMIN: visibility clause sits between category and owner filters', async () => {
    expect(await list('JUNIOR', { category: 'RESUME', ownerId: 'o-1' })).toEqual({
      sql:
        `("documents"."deleted_at" is null and ${CAT} = $1 and ` +
        `(${CAT} = $2 and ${OWN} = $3) and ${OWN} = $4)`,
      params: ['RESUME', 'RESUME', 'u-1', 'o-1'],
    })
  })

  it('default (no category) list excludes AVATAR/LOGO from the category set for non-ADMIN', async () => {
    const r = (await list('ACCOUNTANT', {})) as { sql: string; params: unknown[] }
    expect(r.params.slice(0, 5)).toEqual(['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE'])
  })
})
