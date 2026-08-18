import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setup } from './integration-db-guard'

// ── Mocks — keep this a real unit test, no network I/O and no dependency on
//    the real .env.test file's contents (dotenv.config is a no-op here, so
//    process.env is exactly what each test sets, nothing more). `vi.hoisted`
//    is required: `vi.mock` factories are hoisted above every other
//    statement (including the static import above), so a plain top-level
//    `const` would still run after them, and a dynamic `await import()`
//    would trip this package's `typecheck:specs` CommonJS target — a real
//    gap this file should not add a new instance of. ────────────────────────
const { queryMock, endMock } = vi.hoisted(() => ({ queryMock: vi.fn(), endMock: vi.fn() }))
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(function (this: unknown) {
    return { query: queryMock, end: endMock }
  }),
}))
vi.mock('dotenv', () => ({ config: vi.fn() }))

const PG16 = 'PostgreSQL 16.14 on aarch64-unknown-linux-musl, compiled by gcc, 64-bit'
const PG15 = 'PostgreSQL 15.10 (Homebrew) on aarch64-apple-darwin23.6.0, compiled by Apple clang'

describe('integration-db-guard setup()', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    queryMock.mockReset()
    endMock.mockReset()
    vi.clearAllMocks()
    delete process.env['CI']
    delete process.env['DATABASE_URL']
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('CI=true no longer short-circuits (removed by task-ci-db-rename-and-dbpush-guard — CI is now crm_ci, see below) — still BLOCKED for literal crm_db', async () => {
    process.env['CI'] = 'true'
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/crm_db'

    await expect(setup()).rejects.toThrow(/must not run against crm_db/)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('throws BLOCKED for crm_db without ever opening a connection (unchanged pre-existing guard)', async () => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/crm_db'

    await expect(setup()).rejects.toThrow(/must not run against crm_db/)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('an unset DATABASE_URL warns and returns — never opens a connection (specs handle the skip)', async () => {
    // DATABASE_URL left unset by beforeEach.
    await expect(setup()).resolves.toBeUndefined()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('a reachable, correct-major-version server passes silently', async () => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5433/crm_scratch'
    queryMock.mockResolvedValue({ rows: [{ version: PG16 }] })

    await expect(setup()).resolves.toBeUndefined()
    expect(endMock).toHaveBeenCalledTimes(1)
  })

  it("CI's own throwaway database (crm_ci, task-ci-db-rename-and-dbpush-guard) passes through like any other non-crm_db name — no CI-specific carve-out needed", async () => {
    process.env['CI'] = 'true'
    process.env['DATABASE_URL'] = 'postgresql://crm_user:password@localhost:5432/crm_ci'
    queryMock.mockResolvedValue({ rows: [{ version: PG16 }] })

    await expect(setup()).resolves.toBeUndefined()
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(endMock).toHaveBeenCalledTimes(1)
  })

  it('an unreachable DATABASE_URL — the bug this file exists to close — throws loudly instead of being silently swallowed per-spec', async () => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@127.0.0.1:5599/crm_scratch'
    const connErr = new Error('connect ECONNREFUSED 127.0.0.1:5599')
    queryMock.mockRejectedValue(connErr)

    await expect(setup()).rejects.toThrow(/could not connect to DATABASE_URL/)
    await expect(setup()).rejects.toThrow(/connect ECONNREFUSED 127\.0\.0\.1:5599/)
    // `finally` releases the pool even on the connection-failure path.
    expect(endMock).toHaveBeenCalled()
  })

  it('a reachable but WRONG-major-version server (the two-Postgres-on-one-port trap) throws, naming both versions', async () => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@127.0.0.1:5432/crm_qa'
    queryMock.mockResolvedValue({ rows: [{ version: PG15 }] })

    await expect(setup()).rejects.toThrow(/WRONG Postgres/)
    await expect(setup()).rejects.toThrow(/PostgreSQL 15\.10/)
    expect(endMock).toHaveBeenCalled()
  })

  it('redacts the password in every thrown message', async () => {
    process.env['DATABASE_URL'] = 'postgresql://crm_user:supersecret@127.0.0.1:5599/crm_scratch'
    queryMock.mockRejectedValue(new Error('connect ECONNREFUSED'))

    const message: string = await setup().then(
      () => {
        throw new Error('setup() should have thrown')
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )

    expect(message).not.toContain('supersecret')
    expect(message).toContain(':***@')
  })
})
