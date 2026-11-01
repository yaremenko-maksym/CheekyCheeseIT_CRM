import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { users } from '../../database/schema'
import { activeAdminIds } from './active-admins'

const dialect = new PgDialect()

describe('activeAdminIds', () => {
  it('selects the id column of users with role ADMIN that are not archived, and returns the ids', async () => {
    let condition: SQL | undefined
    const select = vi.fn(() => ({
      from: () => ({
        where: async (c: SQL) => {
          condition = c
          return [{ id: 'a' }, { id: 'b' }]
        },
      }),
    }))
    const ids = await activeAdminIds({ select } as never)

    expect(ids).toEqual(['a', 'b'])
    expect(select).toHaveBeenCalledWith({ id: users.id })
    const q = dialect.sqlToQuery(condition!)
    expect(q.sql).toBe('("users"."role" = $1 and "users"."archived_at" is null)')
    expect(q.params).toEqual(['ADMIN'])
  })
})
