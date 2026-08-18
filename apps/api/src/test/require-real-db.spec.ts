import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasDatabaseUrl, assertRealDbSchema } from './require-real-db'

// ── Mock `pg`'s Pool so these stay real unit tests (no network I/O) ─────────
// `vi.hoisted` is required here: `vi.mock` factories are hoisted above every
// other statement in the file, so a plain `const queryMock = vi.fn()` above
// them would still run AFTER the factory and leave it capturing `undefined`.
// `vi.mock` itself is ALSO hoisted above the static import above, so the
// mocked `pg` is what `require-real-db.ts` sees — no dynamic `await import()`
// needed (and top-level `await` trips this package's `typecheck:specs`
// CommonJS target, a real gap this file should not add a new instance of).
const { queryMock, endMock } = vi.hoisted(() => ({ queryMock: vi.fn(), endMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(function (this: unknown) {
    return { query: queryMock, end: endMock }
  }),
}))

describe('hasDatabaseUrl', () => {
  const original = process.env['DATABASE_URL']

  afterEach(() => {
    if (original === undefined) delete process.env['DATABASE_URL']
    else process.env['DATABASE_URL'] = original
  })

  it('returns false when DATABASE_URL is unset', () => {
    delete process.env['DATABASE_URL']
    expect(hasDatabaseUrl()).toBe(false)
  })

  it('returns false when DATABASE_URL is the empty string (the `DATABASE_URL= git push` convention)', () => {
    process.env['DATABASE_URL'] = ''
    expect(hasDatabaseUrl()).toBe(false)
  })

  it('returns true when DATABASE_URL is a non-empty string', () => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/crm_qa'
    expect(hasDatabaseUrl()).toBe(true)
  })
})

describe('assertRealDbSchema', () => {
  beforeEach(() => {
    queryMock.mockReset()
    endMock.mockReset()
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/crm_qa'
  })

  it('resolves without throwing when every table.column is present', async () => {
    queryMock.mockResolvedValue({ rowCount: 1, rows: [{ column_name: 'project_id' }] })

    await expect(
      assertRealDbSchema([{ table: 'legends', column: 'project_id' }]),
    ).resolves.toBeUndefined()

    expect(endMock).toHaveBeenCalledTimes(1)
  })

  it('throws — not silently returns — when a column is missing (the bug this file exists to close)', async () => {
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] })

    await expect(assertRealDbSchema([{ table: 'legends', column: 'project_id' }])).rejects.toThrow(
      /legends\.project_id not found/,
    )

    // Even on the throw path the pool must still be released.
    expect(endMock).toHaveBeenCalledTimes(1)
  })

  it('stops at the FIRST missing column and does not query the rest', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // first check fails
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ column_name: 'x' }] }) // would be the 2nd

    await expect(
      assertRealDbSchema([
        { table: 'a', column: 'missing_col' },
        { table: 'b', column: 'present_col' },
      ]),
    ).rejects.toThrow(/a\.missing_col not found/)

    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT catch a connection error — it propagates as-is (fails loud, not skip)', async () => {
    const connErr = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    queryMock.mockRejectedValue(connErr)

    await expect(assertRealDbSchema([{ table: 'legends', column: 'project_id' }])).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:5432',
    )

    // `finally` must still release the pool even when the query itself threw.
    expect(endMock).toHaveBeenCalledTimes(1)
  })

  it('with an empty checks array, resolves without ever calling query', async () => {
    await expect(assertRealDbSchema([])).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
    expect(endMock).toHaveBeenCalledTimes(1)
  })
})
