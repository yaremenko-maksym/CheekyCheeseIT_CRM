import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import type { User } from '../database/schema'
import { loadUserById } from './user-read.util'

function stubDb(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows)
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  return { db: { select } as unknown as DatabaseService['db'], select, from, where }
}

describe('loadUserById', () => {
  it('resolves the first matching row', async () => {
    const row = { id: 'u1' } as User
    const { db, select, from, where } = stubDb([row, { id: 'u2' }])
    await expect(loadUserById(db, 'u1')).resolves.toBe(row)
    expect(select).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledTimes(1)
    expect(where).toHaveBeenCalledTimes(1)
  })

  it('resolves undefined when no row matches', async () => {
    const { db } = stubDb([])
    await expect(loadUserById(db, 'missing')).resolves.toBeUndefined()
  })
})
