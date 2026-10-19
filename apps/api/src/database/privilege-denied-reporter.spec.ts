import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ALERT_CONTRACT_PATTERN, ALERT_PATTERN } from './__test-helpers__/alert-patterns'
import { DatabaseModule } from './database.module'
import {
  PrivilegeDeniedReporter,
  installPrivilegeDeniedReporter,
  privilegeDeniedLine,
} from './privilege-denied-reporter'

describe('DatabaseModule wiring', () => {
  // vitest cannot resolve constructor parameters by type, so a provider that is written but
  // never registered would pass every other test here. This pins the registration itself.
  it('registers the privilege-denied reporter next to DatabaseService', () => {
    const providers = Reflect.getMetadata('providers', DatabaseModule) as unknown[]
    expect(providers).toContain(PrivilegeDeniedReporter)
  })
})

describe('PrivilegeDeniedReporter lifecycle', () => {
  it('installs on the pool drizzle exposes as $client, at application bootstrap', () => {
    const pool = { query: vi.fn(), connect: vi.fn() }
    const original = pool.query
    const reporter = new PrivilegeDeniedReporter({ db: { $client: pool } } as never)

    reporter.onApplicationBootstrap()

    expect(pool.query).not.toBe(original) // wrapped
  })

  // The alert anchors on `[DatabasePrivilege] db_privilege_denied sqlstate=42501` and drops
  // records below its level threshold — so the REAL text Nest writes is what is pinned here,
  // not a spy on Logger.prototype: level ERROR, bracketed context directly before the token.
  it('writes `ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 …` in Nest’s real text output', async () => {
    const written: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      const pool = { query: vi.fn(() => Promise.reject(denied())), connect: vi.fn() }
      new PrivilegeDeniedReporter({ db: { $client: pool } } as never).onApplicationBootstrap()

      await (pool.query as () => Promise<unknown>)().catch(() => undefined)
    } finally {
      stderr.mockRestore()
    }

    const text = written.join('').replace(/\u001b\[[0-9;]*m/g, '')
    expect(text).toMatch(
      /ERROR \[DatabasePrivilege\] db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool/,
    )
    expect(text).toMatch(/\[DatabasePrivilege\] db_privilege_denied sqlstate=42501/)
  })

  it('logs the canonical line at ERROR through a Logger whose context is DatabasePrivilege', async () => {
    const seen: { message: unknown; context: unknown }[] = []
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(function (
      this: Logger,
      message: unknown,
    ) {
      seen.push({ message, context: (this as unknown as { context?: unknown }).context })
    })
    try {
      const pool = {
        query: vi.fn(() => Promise.reject(denied())),
        connect: vi.fn(),
      }
      new PrivilegeDeniedReporter({ db: { $client: pool } } as never).onApplicationBootstrap()

      await (pool.query as () => Promise<unknown>)().catch(() => undefined)

      expect(seen).toEqual([
        {
          message: 'db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool',
          context: 'DatabasePrivilege',
        },
      ])
    } finally {
      errorSpy.mockRestore()
    }
  })
})

/** What `pg` throws for a statement the role is not granted. */
function denied(message = 'permission denied for table document_access_log', extra = {}) {
  return Object.assign(new Error(message), { severity: 'ERROR', code: '42501', ...extra })
}

/** What drizzle throws around it. */
function drizzleWrapped(cause: unknown, params: unknown[] = []): Error {
  return Object.assign(new Error(`Failed query: select 1\nparams: ${params.join(',')}`), {
    query: 'select 1',
    params,
    cause,
  })
}

describe('privilegeDeniedLine — the alert contract', () => {
  it('is the canonical line for a bare driver 42501 (what a pool-level wrapper sees)', () => {
    expect(privilegeDeniedLine(denied(), 'pool')).toBe(
      'db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool',
    )
  })

  it('is the same line when drizzle has wrapped it (the error is on .cause)', () => {
    expect(privilegeDeniedLine(drizzleWrapped(denied()), 'client')).toBe(
      'db_privilege_denied sqlstate=42501 table=document_access_log ctx=client',
    )
  })

  it('takes the table from the driver’s own field when it supplies one', () => {
    expect(privilegeDeniedLine(denied('permission denied', { table: 'users' }), 'pool')).toBe(
      'db_privilege_denied sqlstate=42501 table=users ctx=pool',
    )
  })

  it('reads a view the same way as a table', () => {
    expect(privilegeDeniedLine(denied('permission denied for view visible_projects'), 'pool')).toBe(
      'db_privilege_denied sqlstate=42501 table=visible_projects ctx=pool',
    )
  })

  it.each([
    'permission denied for schema public',
    'permission denied for sequence users_id_seq',
    'must be owner of table users',
    'permission denied to create role',
  ])('still reports a 42501 that names no table (%s), with table=-', (message) => {
    expect(privilegeDeniedLine(denied(message), 'pool')).toBe(
      'db_privilege_denied sqlstate=42501 table=unknown ctx=pool',
    )
  })

  it('does not take a table out of the middle of a message', () => {
    expect(privilegeDeniedLine(denied('xx permission denied for table users'), 'pool')).toBe(
      'db_privilege_denied sqlstate=42501 table=unknown ctx=pool',
    )
  })

  it('sanitises the identifier to [A-Za-z0-9_$.]', () => {
    expect(privilegeDeniedLine(denied('permission denied', { table: 'we ird"t' }), 'pool')).toBe(
      'db_privilege_denied sqlstate=42501 table=we?ird?t ctx=pool',
    )
  })

  it('is null for every other SQLSTATE, and for non-database errors', () => {
    const other = Object.assign(new Error('x'), { severity: 'ERROR', code: '23505' })
    expect(privilegeDeniedLine(other, 'pool')).toBeNull()
    expect(privilegeDeniedLine(new Error('permission denied for table users'), 'pool')).toBeNull()
    expect(privilegeDeniedLine(null, 'pool')).toBeNull()
  })

  // The alert's patterns come from ONE shared test constant (`alert-patterns.ts`, which names
  // the script that owns them), so renaming a token here or there fails a test instead of
  // silently un-wiring the alert. The canonical line must match the CONTRACT pattern, on the
  // exact logger output shape too.
  it('is matched by the alert’s contract pattern, as logged by Nest', () => {
    const logged = `ERROR [DatabasePrivilege] ${privilegeDeniedLine(denied(), 'pool')}`
    expect(logged).toBe(
      'ERROR [DatabasePrivilege] db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool',
    )
    expect(ALERT_CONTRACT_PATTERN.test(logged)).toBe(true)
    expect(ALERT_PATTERN.test(logged)).toBe(true)
  })

  it('the shared alert constants are what the alert is: case-insensitive, contract needs the token', () => {
    expect(ALERT_PATTERN.test('Permission Denied for table x')).toBe(true)
    expect(ALERT_PATTERN.test('MUST BE OWNER of table x')).toBe(true)
    // A bare SQLSTATE is not a hit (the alert dropped that branch), nor is the old fragment field.
    expect(ALERT_PATTERN.test('sqlstate=42501')).toBe(false)
    expect(ALERT_PATTERN.test('code: 42501')).toBe(false)
    expect(ALERT_CONTRACT_PATTERN.test('db_sqlstate=42501')).toBe(false)
    expect(ALERT_CONTRACT_PATTERN.test('db_privilege_denied sqlstate=42501 table=x ctx=pool')).toBe(
      true,
    )
    expect(ALERT_CONTRACT_PATTERN.test('db_privilege_denied table=x ctx=pool')).toBe(false)
    // "The token first, the rest in any order": sqlstate may come last, many characters later.
    const reordered = 'db_privilege_denied table=document_access_log ctx=pool sqlstate=42501'
    expect(ALERT_CONTRACT_PATTERN.test(reordered)).toBe(true)
    expect(ALERT_PATTERN.test(reordered)).toBe(true)
  })

  it('never carries a statement, a parameter value, detail or where', () => {
    const leaky = denied('permission denied for table document_access_log', {
      detail: 'Key (x)=(SECRET-VALUE-123)',
      where: 'SECRET-VALUE-123',
    })
    const line = privilegeDeniedLine(drizzleWrapped(leaky, ['SECRET-VALUE-123']), 'pool') ?? ''
    expect(line).not.toContain('SECRET-VALUE-123')
    expect(line).not.toContain('select')
  })
})

type Sink = ReturnType<typeof vi.fn<(line: string) => void>>

function fakePool(query: (...a: unknown[]) => unknown, client?: { query: unknown }) {
  return {
    query: vi.fn(query),
    connect: vi.fn((...a: unknown[]) =>
      typeof a[0] === 'function' ? 'connect-callback-result' : Promise.resolve(client),
    ),
  }
}

describe('installPrivilegeDeniedReporter — wraps the pool without changing what it returns', () => {
  it('reports a 42501 from pool.query once, ctx=pool, and the caller still sees the SAME rejection', async () => {
    const err = denied()
    const sink: Sink = vi.fn()
    const pool = fakePool(() => Promise.reject(err))
    installPrivilegeDeniedReporter(pool as never, sink)

    await expect((pool.query as (...a: unknown[]) => Promise<unknown>)('select 1')).rejects.toBe(
      err,
    )

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(
      'db_privilege_denied sqlstate=42501 table=document_access_log ctx=pool',
    )
  })

  it('passes its arguments and `this` through to the original query', async () => {
    const sink: Sink = vi.fn()
    const original = vi.fn(function (this: unknown) {
      return Promise.resolve(this)
    })
    const pool = { query: original, connect: vi.fn() }
    installPrivilegeDeniedReporter(pool as never, sink)

    const result = await (pool.query as (...a: unknown[]) => Promise<unknown>)('select $1', [1])

    expect(original).toHaveBeenCalledWith('select $1', [1])
    expect(result).toBe(pool)
  })

  it('says nothing for a success, and returns the original result', async () => {
    const sink: Sink = vi.fn()
    const pool = fakePool(() => Promise.resolve({ rows: [1] }))
    installPrivilegeDeniedReporter(pool as never, sink)

    await expect(
      (pool.query as (...a: unknown[]) => Promise<unknown>)('select 1'),
    ).resolves.toEqual({ rows: [1] })
    expect(sink).not.toHaveBeenCalled()
  })

  it('says nothing for a rejection that is not a 42501', async () => {
    const sink: Sink = vi.fn()
    const other = Object.assign(new Error('boom'), { severity: 'ERROR', code: '23505' })
    const pool = fakePool(() => Promise.reject(other))
    installPrivilegeDeniedReporter(pool as never, sink)

    await expect((pool.query as (...a: unknown[]) => Promise<unknown>)('select 1')).rejects.toBe(
      other,
    )
    expect(sink).not.toHaveBeenCalled()
  })

  it('returns a non-promise result (a Submittable, or a callback-style call) untouched', () => {
    const sink: Sink = vi.fn()
    const submittable = { submit: () => undefined }
    const pool = fakePool(() => submittable)
    installPrivilegeDeniedReporter(pool as never, sink)

    expect((pool.query as (...a: unknown[]) => unknown)('select 1', () => undefined)).toBe(
      submittable,
    )
    expect(sink).not.toHaveBeenCalled()
  })

  it.each([[undefined], [null], ['text'], [42]])(
    'returns a %s result untouched, without reading .then off it',
    (value) => {
      const sink: Sink = vi.fn()
      const pool = fakePool(() => value)
      installPrivilegeDeniedReporter(pool as never, sink)

      expect((pool.query as (...a: unknown[]) => unknown)('select 1')).toBe(value)
      expect(sink).not.toHaveBeenCalled()
    },
  )

  it('a throwing sink cannot change the caller’s rejection or leak an unhandled one', async () => {
    const err = denied()
    const sink: Sink = vi.fn(() => {
      throw new Error('logger is broken')
    })
    const pool = fakePool(() => Promise.reject(err))
    installPrivilegeDeniedReporter(pool as never, sink)

    await expect((pool.query as (...a: unknown[]) => Promise<unknown>)('select 1')).rejects.toBe(
      err,
    )
    await new Promise((resolve) => setImmediate(resolve)) // an unhandled rejection would fail the run here
  })

  it('reports a 42501 on a checked-out client (a transaction) with ctx=client', async () => {
    const err = denied()
    const sink: Sink = vi.fn()
    const client = { query: vi.fn(() => Promise.reject(err)) }
    const pool = fakePool(() => Promise.resolve(), client)
    installPrivilegeDeniedReporter(pool as never, sink)

    const checkedOut = (await (pool.connect as () => Promise<typeof client>)()) as typeof client
    await expect(
      (checkedOut.query as (...a: unknown[]) => Promise<unknown>)('select 1'),
    ).rejects.toBe(err)

    expect(checkedOut).toBe(client)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(
      'db_privilege_denied sqlstate=42501 table=document_access_log ctx=client',
    )
  })

  it('patches a pooled client once even when it is checked out again', async () => {
    const err = denied()
    const sink: Sink = vi.fn()
    const client = { query: vi.fn(() => Promise.reject(err)) }
    const pool = fakePool(() => Promise.resolve(), client)
    installPrivilegeDeniedReporter(pool as never, sink)

    await (pool.connect as () => Promise<unknown>)()
    const again = (await (pool.connect as () => Promise<typeof client>)()) as typeof client
    await expect((again.query as (...a: unknown[]) => Promise<unknown>)('select 1')).rejects.toBe(
      err,
    )

    expect(sink).toHaveBeenCalledTimes(1) // not once per wrapping layer
  })

  // CR-M-2: a role without CONNECT is refused by pool.connect() itself — which is where ALL of
  // drizzle's transaction() starts — and that rejection never reaches a patched client.
  it('reports a 42501 raised by connect() itself, ctx=client, and the caller sees the SAME rejection', async () => {
    const err = denied('permission denied for database crm_db')
    const sink: Sink = vi.fn()
    const pool = { query: vi.fn(), connect: vi.fn(() => Promise.reject(err)) }
    installPrivilegeDeniedReporter(pool as never, sink)

    await expect((pool.connect as () => Promise<unknown>)()).rejects.toBe(err)

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith('db_privilege_denied sqlstate=42501 table=unknown ctx=client')
  })

  it('says nothing for a connect() that fails for another reason', async () => {
    const other = Object.assign(new Error('password authentication failed'), {
      severity: 'FATAL',
      code: '28P01',
    })
    const sink: Sink = vi.fn()
    const pool = { query: vi.fn(), connect: vi.fn(() => Promise.reject(other)) }
    installPrivilegeDeniedReporter(pool as never, sink)

    await expect((pool.connect as () => Promise<unknown>)()).rejects.toBe(other)

    expect(sink).not.toHaveBeenCalled()
  })

  it('a throwing sink cannot change a connect() rejection either', async () => {
    const err = denied()
    const sink: Sink = vi.fn(() => {
      throw new Error('logger is broken')
    })
    const pool = { query: vi.fn(), connect: vi.fn(() => Promise.reject(err)) }
    installPrivilegeDeniedReporter(pool as never, sink)

    await expect((pool.connect as () => Promise<unknown>)()).rejects.toBe(err)
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('leaves connect(callback) alone', () => {
    const sink: Sink = vi.fn()
    const pool = fakePool(() => Promise.resolve())
    installPrivilegeDeniedReporter(pool as never, sink)

    expect((pool.connect as (...a: unknown[]) => unknown)(() => undefined)).toBe(
      'connect-callback-result',
    )
  })

  it('installing twice on one pool reports each failure once', async () => {
    const sink: Sink = vi.fn()
    const pool = fakePool(() => Promise.reject(denied()))
    installPrivilegeDeniedReporter(pool as never, sink)
    installPrivilegeDeniedReporter(pool as never, sink)

    await (pool.query as (...a: unknown[]) => Promise<unknown>)('select 1').catch(() => undefined)

    expect(sink).toHaveBeenCalledTimes(1)
  })
})
