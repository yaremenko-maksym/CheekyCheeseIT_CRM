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
      { id: 'j-busy', role: 'JUNIOR', name: 'a', technicalRoles: [] },
      { id: 'j-free', role: 'JUNIOR', name: 'b', technicalRoles: [] },
      { id: 's-busy', role: 'SENIOR', name: 'c', technicalRoles: [] },
      { id: 'a-1', role: 'ADMIN', name: 'd', technicalRoles: [] },
    ]
    expect(withActiveProjectFlag(rows, busy)).toEqual([
      { id: 'j-busy', role: 'JUNIOR', name: 'a', technicalRoles: [], hasActiveProject: true },
      { id: 'j-free', role: 'JUNIOR', name: 'b', technicalRoles: [], hasActiveProject: false },
      { id: 's-busy', role: 'SENIOR', name: 'c', technicalRoles: [], hasActiveProject: false },
      { id: 'a-1', role: 'ADMIN', name: 'd', technicalRoles: [], hasActiveProject: false },
    ])
  })

  it('returns an empty array for no rows', () => {
    expect(withActiveProjectFlag([], busy)).toEqual([])
  })

  // SR-L-3: the list payload is a read path of `technicalRoles`, so it gates on the row's role
  // exactly as `buildProfileView` and `team-mapping.util.ts` do. The demoting write already clears
  // the column (`updateUserRow`), so this pins the second layer: a non-SENIOR row whose column was
  // never cleared (written before that rule, or by a path that bypasses the writer) still leaves with `[]`.
  it('drops a stale non-empty roles column from every non-SENIOR row', () => {
    const rows = [
      { id: 'ex-senior', role: 'JUNIOR', technicalRoles: ['BACKEND_ENGINEER', 'QA_ENGINEER'] },
      { id: 'hr-1', role: 'HR', technicalRoles: ['CTO'] },
    ]
    expect(withActiveProjectFlag(rows, busy).map((u) => u.technicalRoles)).toEqual([[], []])
  })

  it('keeps the roles of a SENIOR row', () => {
    const rows = [{ id: 's-1', role: 'SENIOR', technicalRoles: ['BACKEND_ENGINEER'] }]
    expect(withActiveProjectFlag(rows, busy)[0]?.technicalRoles).toEqual(['BACKEND_ENGINEER'])
  })
})
