import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { resolveArchivedFilter, withActiveProjectFlag } from './users-list.util'

const dialect = new PgDialect()
const render = (f: ReturnType<typeof resolveArchivedFilter>) =>
  f ? dialect.sqlToQuery(f).sql : undefined

describe('resolveArchivedFilter', () => {
  it("returns undefined for 'all'", () => {
    expect(resolveArchivedFilter({ archived: 'all' })).toBeUndefined()
  })

  it('returns IS NOT NULL for archived=true', () => {
    expect(render(resolveArchivedFilter({ archived: true }))).toBe(
      '"users"."archived_at" is not null',
    )
  })

  it('returns IS NULL for archived=false', () => {
    expect(render(resolveArchivedFilter({ archived: false }))).toBe('"users"."archived_at" is null')
  })

  it('returns IS NULL when archived is omitted', () => {
    expect(render(resolveArchivedFilter({}))).toBe('"users"."archived_at" is null')
  })
})

describe('withActiveProjectFlag', () => {
  const busy = new Set(['j-busy', 's-busy'])

  it('flags only JUNIOR rows that are in the busy set', () => {
    const rows = [
      { id: 'j-busy', role: 'JUNIOR', name: 'a' },
      { id: 'j-free', role: 'JUNIOR', name: 'b' },
      { id: 's-busy', role: 'SENIOR', name: 'c' },
      { id: 'a-1', role: 'ADMIN', name: 'd' },
    ]
    expect(withActiveProjectFlag(rows, busy)).toEqual([
      { id: 'j-busy', role: 'JUNIOR', name: 'a', hasActiveProject: true },
      { id: 'j-free', role: 'JUNIOR', name: 'b', hasActiveProject: false },
      { id: 's-busy', role: 'SENIOR', name: 'c', hasActiveProject: false },
      { id: 'a-1', role: 'ADMIN', name: 'd', hasActiveProject: false },
    ])
  })

  it('returns an empty array for no rows', () => {
    expect(withActiveProjectFlag([], busy)).toEqual([])
  })
})
