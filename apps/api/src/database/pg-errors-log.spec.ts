/**
 * Unit coverage for the LOG-LINE half of `pg-errors.ts` — `describeDbError`,
 * `dbErrorLogSuffix`, `safeErrorStack`.
 *
 * The real-driver half (does a REAL Postgres 42501 come out of a REAL handler as a
 * log line containing `42501`?) is `pg-errors-log.integration.spec.ts`. This file
 * pins the pure formatting rules with hand-built error shapes, and every expected
 * string below is a literal written out by hand, not computed with the code under
 * test.
 */
import { describe, expect, it } from 'vitest'
import { alertPattern } from './__test-helpers__/alert-patterns'
import { dbErrorLogSuffix, describeDbError, safeErrorStack, strictErrorStack } from './pg-errors'

/** What `pg` throws: a DatabaseError — `code`, `severity`, and the identifier fields. */
function pgError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Error & Record<string, unknown> {
  return Object.assign(new Error(message), { severity: 'ERROR', code, ...extra })
}

/** What drizzle-orm throws: message embeds the VALUES, `.cause` is the pg error. */
function drizzleError(
  cause: unknown,
  query: string,
  params: unknown[],
): Error & Record<string, unknown> {
  const err = Object.assign(new Error(`Failed query: ${query}\nparams: ${params.join(',')}`), {
    query,
    params,
    cause,
  })
  err.name = 'DrizzleQueryError'
  return err
}

const DENIED = pgError('42501', 'permission denied for table job_queue_actions')

describe('describeDbError — the alert contract', () => {
  it('reads SQLSTATE and message through drizzle’s .cause wrapper', () => {
    const err = drizzleError(DENIED, 'select "id" from "job_queue_actions" where "x" = $1', ['v'])
    expect(describeDbError(err)).toBe(
      'db_error db_state=42501 db_table=- db_constraint=- db_column=- ' +
        'db_message=- ' +
        "db_statement=\"select 'id' from 'job_queue_actions' where 'x' = $1\"",
    )
  })

  it('works on a bare pg error with no drizzle wrapper (statement is "-")', () => {
    expect(describeDbError(DENIED)).toBe(
      'db_error db_state=42501 db_table=- db_constraint=- db_column=- ' +
        'db_message=- db_statement=-',
    )
  })

  it('reports table / constraint / column when the driver supplies them', () => {
    const err = pgError('23505', 'duplicate key value violates unique constraint "u_email"', {
      table: 'users',
      constraint: 'u_email',
      column: 'email',
    })
    expect(describeDbError(err)).toBe(
      'db_error db_state=23505 db_table=users db_constraint=u_email db_column=email ' +
        'db_message="duplicate key value violates unique constraint \'u_email\'" db_statement=-',
    )
  })

  it('never emits parameter values — not via message, params, or detail', () => {
    const leaky = pgError('23505', 'duplicate key value violates unique constraint "u_email"', {
      detail: 'Key (email)=(SECRET-VALUE-123) already exists.',
      where: 'SECRET-VALUE-123',
      table: 'users',
    })
    const err = drizzleError(leaky, 'insert into "users" ("email") values ($1)', [
      'SECRET-VALUE-123',
    ])
    // The premise of the test: the drizzle message DOES carry the value.
    expect(err.message).toContain('SECRET-VALUE-123')
    expect(describeDbError(err)).not.toContain('SECRET-VALUE-123')
  })

  it('omits the driver message for classes whose message embeds the value (22xxx)', () => {
    const err = pgError('22P02', 'invalid input syntax for type integer: "SECRET-VALUE-123"')
    const line = describeDbError(err) ?? ''
    expect(line).toContain('db_state=22P02')
    expect(line).toContain('db_message=-')
    expect(line).not.toContain('SECRET-VALUE-123')
  })

  it.each([
    ['08006', 'connection failure'],
    ['23502', 'null value in column "a" violates not-null constraint'],
    ['28P01', 'password authentication failed for user "crm_app"'],
    ['40P01', 'deadlock detected'],
    ['42P01', 'relation "t" does not exist'],
    ['53300', 'too many connections'],
    ['57P01', 'terminating connection due to administrator command'],
    ['58030', 'could not write'],
  ])('keeps the message for value-free class %s', (code, message) => {
    expect(describeDbError(pgError(code, message))).toContain(
      `db_message="${message.replaceAll('"', "'")}"`,
    )
  })

  it.each([['P0001'], ['XX000'], ['22003'], ['25P02'], ['0A000']])(
    'omits the message for unlisted class of %s',
    (code) => {
      expect(describeDbError(pgError(code, 'something with a value 42'))).toContain('db_message=-')
    },
  )

  it('keeps 54xxx and 55xxx messages (the two ends of the allow-list)', () => {
    expect(describeDbError(pgError('54001', 'statement too complex'))).toContain(
      'db_message="statement too complex"',
    )
    expect(describeDbError(pgError('55P03', 'could not obtain lock'))).toContain(
      'db_message="could not obtain lock"',
    )
  })

  it('reports a drizzle failure with no SQLSTATE (connection refused) as db_state=none', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    })
    const err = drizzleError(refused, 'select 1 from "t" where "a" = $1', ['SECRET-VALUE-123'])
    expect(describeDbError(err)).toBe(
      'db_error db_state=none db_table=- db_constraint=- db_column=- ' +
        'db_message="ECONNREFUSED" db_statement="select 1 from \'t\' where \'a\' = $1"',
    )
  })

  it('reports db_message=- when a SQLSTATE-less cause has no code either', () => {
    const err = drizzleError(new Error('boom SECRET-VALUE-123'), 'select 1', [])
    expect(describeDbError(err)).toBe(
      'db_error db_state=none db_table=- db_constraint=- db_column=- db_message=- db_statement="select 1"',
    )
  })

  // The alert's patterns live in ONE shared test constant (`alert-patterns.ts`, which names the
  // script that owns them). The contract is the canonical `db_privilege_denied` line; this
  // fragment is diagnostic and deliberately OUTSIDE everything that pages, so one failure is
  // one hit and not two.
  it.each([
    'permission denied for table document_access_log',
    'permission denied for schema public',
    'permission denied for sequence users_id_seq',
    'must be owner of table users',
    'must be superuser to alter replication users',
  ])(
    'a 42501 fragment (%s) is outside the alert pattern: state field renamed, message dropped',
    (message) => {
      const fragment = describeDbError(pgError('42501', message)) ?? ''

      expect(fragment).toBe(
        'db_error db_state=42501 db_table=- db_constraint=- db_column=- db_message=- db_statement=-',
      )
      expect(alertPattern().test(fragment)).toBe(false)
    },
  )

  it('a drizzle-wrapped 42501 fragment is outside the alert pattern, statement included', () => {
    const err = drizzleError(DENIED, 'delete from "document_access_log" where "created_at" < $1', [
      'x',
    ])
    expect(alertPattern().test(describeDbError(err) ?? '')).toBe(false)
  })

  it('names the SQLSTATE field db_state — `code` and `sqlstate` are the alert’s words', () => {
    expect(describeDbError(pgError('23505', 'dup'))).toContain(' db_state=23505 ')
    expect(describeDbError(pgError('23505', 'dup'))).not.toMatch(/sqlstate|code/)
  })

  it('is null for anything that is not a database error', () => {
    expect(describeDbError(new Error('boom'))).toBeNull()
    expect(describeDbError('a string')).toBeNull()
    expect(describeDbError(null)).toBeNull()
    expect(describeDbError(undefined)).toBeNull()
    expect(describeDbError({ code: '42501' })).toBeNull() // no severity: not a pg DatabaseError
  })

  it('does not mistake a Node system error for a SQLSTATE (EPERM is five uppercase chars)', () => {
    expect(
      describeDbError(Object.assign(new Error('operation not permitted'), { code: 'EPERM' })),
    ).toBeNull()
  })

  it('requires the code to be exactly five of [0-9A-Z]', () => {
    expect(describeDbError(pgError('4250', 'x'))).toBeNull()
    expect(describeDbError(pgError('425012', 'x'))).toBeNull()
    expect(describeDbError(pgError('4250a', 'x'))).toBeNull()
    expect(describeDbError(pgError('4250-', 'x'))).toBeNull()
    expect(describeDbError(pgError('a4250', 'x'))).toBeNull()
  })

  it('rejects a numeric code even though RegExp#test would coerce 42501 to "42501"', () => {
    expect(
      describeDbError(Object.assign(new Error('x'), { code: 42501, severity: 'ERROR' })),
    ).toBeNull()
  })

  it('terminates on a null cause, on an absent cause, and on a primitive cause', () => {
    expect(describeDbError(new Error('x', { cause: null }))).toBeNull()
    expect(describeDbError(new Error('x', { cause: 'a string' }))).toBeNull()
    expect(describeDbError(new Error('x', { cause: 7 }))).toBeNull()
  })

  it('reports db_message=- for a drizzle error with no cause, a null cause, or a primitive cause', () => {
    const bare = (cause: unknown): Error =>
      Object.assign(new Error('x'), { query: 'select 1', params: [], cause })
    const expected =
      'db_error db_state=none db_table=- db_constraint=- db_column=- ' +
      'db_message=- db_statement="select 1"'
    expect(describeDbError(bare(undefined))).toBe(expected)
    expect(describeDbError(bare(null))).toBe(expected)
    expect(describeDbError(bare('a string'))).toBe(expected)
  })

  it('trims leading and trailing whitespace from the statement', () => {
    expect(describeDbError(drizzleError(DENIED, '  \n select 1 \t ', []))).toContain(
      'db_statement="select 1"',
    )
  })

  it('requires severity to be a string', () => {
    expect(
      describeDbError(Object.assign(new Error('x'), { code: '42501', severity: 3 })),
    ).toBeNull()
  })

  it('finds the database error under an application wrapper', () => {
    const wrapped = new Error('purge failed', {
      cause: drizzleError(DENIED, 'delete from "t"', []),
    })
    expect(describeDbError(wrapped)).toContain('db_state=42501')
  })

  it('bounds the walk — a self-referential cause chain terminates', () => {
    const loop: { cause?: unknown } = new Error('loop')
    loop.cause = loop
    expect(describeDbError(loop)).toBeNull()
  })

  it('walks exactly 8 levels deep: the 8th node is read, the 9th is not', () => {
    const chain = (depthOfPg: number): unknown => {
      let node: unknown = pgError('42501', 'permission denied for table t')
      for (let i = 1; i < depthOfPg; i += 1) node = new Error('wrap', { cause: node })
      return node
    }
    expect(describeDbError(chain(8))).toContain('db_state=42501')
    expect(describeDbError(chain(9))).toBeNull()
  })

  it('collapses whitespace, strips control characters and truncates the statement to 200', () => {
    const query = `select\n  "a",\t"b"\u0000 from "t" where ${'x'.repeat(300)} = $1`
    const line = describeDbError(drizzleError(DENIED, query, [])) ?? ''
    const statement = /db_statement="([^"]*)"/.exec(line)?.[1] ?? ''
    expect(statement.startsWith("select 'a', 'b' from 't' where xxx")).toBe(true)
    expect(statement).toHaveLength(200)
    expect(statement.endsWith('...')).toBe(true)
    expect(line).not.toMatch(/[\n\t\u0000]/)
  })

  it('does not truncate a statement of exactly 200 characters', () => {
    const query = 'q'.repeat(200)
    expect(describeDbError(drizzleError(DENIED, query, []))).toContain(`db_statement="${query}"`)
  })

  it('does not truncate a driver message of exactly 200 characters, and truncates 201 to 200', () => {
    const exact = `r${'m'.repeat(199)}`
    expect(describeDbError(pgError('42P01', exact))).toContain(`db_message="${exact}"`)
    const long = describeDbError(pgError('42P01', `${exact}Z`)) ?? ''
    const message = /db_message="([^"]*)"/.exec(long)?.[1] ?? ''
    expect(message).toHaveLength(200)
    expect(message.endsWith('...')).toBe(true)
  })

  it('replaces characters outside [A-Za-z0-9_$.] in identifiers with "?"', () => {
    const err = pgError('23505', 'dup', { table: 'we ird"t', constraint: 'c\nx', column: 'ok_1.$' })
    const line = describeDbError(err) ?? ''
    expect(line).toContain('db_table=we?ird?t')
    expect(line).toContain('db_constraint=c?x')
    expect(line).toContain('db_column=ok_1.$')
  })

  it('treats an empty or non-string identifier as absent', () => {
    const line = describeDbError(pgError('23505', 'dup', { table: '', constraint: 7 })) ?? ''
    expect(line).toContain('db_table=- db_constraint=- db_column=-')
  })

  it('ignores a non-string or empty query on a would-be drizzle wrapper', () => {
    const notDrizzle = Object.assign(new Error('x'), { query: 5, params: [], cause: DENIED })
    expect(describeDbError(notDrizzle)).toContain('db_statement=-')
    const emptyQuery = Object.assign(new Error('x'), { query: '', params: [], cause: DENIED })
    expect(describeDbError(emptyQuery)).toContain('db_statement=-')
  })

  it('requires `params` to be an array for the drizzle shape', () => {
    const noParams = Object.assign(new Error('x'), { query: 'select 1' })
    expect(describeDbError(noParams)).toBeNull()
  })
})

describe('dbErrorLogSuffix', () => {
  it('is a leading space plus the fragment for a database error', () => {
    expect(dbErrorLogSuffix(DENIED)).toBe(` ${describeDbError(DENIED)}`)
    expect(dbErrorLogSuffix(DENIED).startsWith(' db_error db_state=42501')).toBe(true)
  })

  it('is the empty string otherwise', () => {
    expect(dbErrorLogSuffix(new Error('boom'))).toBe('')
    expect(dbErrorLogSuffix('x')).toBe('')
  })
})

describe('safeErrorStack', () => {
  it('drops a drizzle error’s message (which embeds the values) and keeps the frames', () => {
    const err = drizzleError(DENIED, 'select 1 where a = $1', ['SECRET-VALUE-123'])
    err.stack = [
      'DrizzleQueryError: Failed query: select 1 where a = $1',
      'params: SECRET-VALUE-123',
      '    at PgPreparedQuery.queryWithCache (/x/pg-core/session.js:1:1)',
      '    at async Cron.handle (/x/cron.ts:2:2)',
    ].join('\n')
    expect(safeErrorStack(err)).toBe(
      [
        'DrizzleQueryError',
        '    at PgPreparedQuery.queryWithCache (/x/pg-core/session.js:1:1)',
        '    at async Cron.handle (/x/cron.ts:2:2)',
      ].join('\n'),
    )
  })

  it('also drops a bare pg error’s message, which can carry a value', () => {
    const err = pgError('22P02', 'invalid input syntax for type integer: "SECRET-VALUE-123"')
    err.stack = `Error: invalid input syntax for type integer: "SECRET-VALUE-123"\n    at Parser.parse (/x/pg.js:1:1)`
    const stack = safeErrorStack(err) ?? ''
    expect(stack).toBe('Error\n    at Parser.parse (/x/pg.js:1:1)')
    expect(stack).not.toContain('SECRET-VALUE-123')
  })

  it('keeps only real frames: a message line that merely contains " at " is dropped', () => {
    // The frame filter is anchored at the start of the line. Unanchored, the parameter
    // line below would pass it and the value would reach the log.
    const err = drizzleError(DENIED, 'select 1 where a = $1', ['meet me at noon'])
    err.stack = [
      'DrizzleQueryError: Failed query: select 1 where a = $1',
      'params: meet me at noon',
      '    at Handler.run (/x/handler.ts:1:1)',
    ].join('\n')
    expect(safeErrorStack(err)).toBe('DrizzleQueryError\n    at Handler.run (/x/handler.ts:1:1)')
  })

  // CR-H-1: a bound value that itself contains a newline followed by an indented "at " sits
  // INSIDE drizzle's message, and a per-line frame filter mistakes it for a frame. The header
  // (`name: message`) is therefore removed as a whole before any line is looked at.
  it.each([
    ['four spaces', 'x\n    at LEAK (f:1:1)'],
    ['two spaces', 'x\n  at LEAK'],
    ['a tab', 'x\n\tat LEAK'],
    ['several injected lines', 'x\n    at LEAK1 (f:1:1)\n    at LEAK2 (g:2:2)\nparams: LEAK3'],
  ])('keeps no part of a multi-line bound value that looks like a frame (%s)', (_name, value) => {
    const err = drizzleError(DENIED, 'select 1 where a = $1', [value])
    err.stack = `${err.name}: ${err.message}\n    at Handler.run (/x/handler.ts:1:1)`

    const stack = safeErrorStack(err) ?? ''

    expect(stack).toBe('DrizzleQueryError\n    at Handler.run (/x/handler.ts:1:1)')
    expect(stack).not.toContain('LEAK')
  })

  it('applies the same header removal to a bare driver error whose message carries the value', () => {
    const err = pgError('22P02', 'invalid input syntax for type integer: "x\n    at LEAK (f:1:1)"')
    err.stack = `${err.name}: ${err.message}\n    at Parser.parse (/x/pg.js:1:1)`

    expect(safeErrorStack(err)).toBe('Error\n    at Parser.parse (/x/pg.js:1:1)')
  })

  it('keeps only lines that are frames: a non-frame line after the header that contains " at " is dropped', () => {
    const err = drizzleError(DENIED, 'select 1', [])
    err.stack = `${err.name}: ${err.message}\n    at Handler.run (/x/handler.ts:1:1)\nnote: meet me at noon`

    expect(safeErrorStack(err)).toBe('DrizzleQueryError\n    at Handler.run (/x/handler.ts:1:1)')
  })

  // SR-M-1: V8 builds the header lazily. If `.stack` was read and `.message` is shortened
  // afterwards, the shortened header is a PREFIX of the frozen stack, so a bare startsWith
  // passes — and the remainder still holds the parameters. The remainder must therefore be
  // empty or begin with a frame.
  it.each([
    ['at the params line', 'Failed query: select 1 where a = $1'],
    ['before the query', 'Failed query: select'],
    ['to nothing', ''],
  ])('fails closed when .message is shortened after .stack was read (%s)', (_name, shortened) => {
    const err = drizzleError(DENIED, 'select 1 where a = $1', ['x\n    at LEAK (f:1:1)'])
    err.stack = `${err.name}: ${err.message}\n    at Handler.run (/x/handler.ts:1:1)`
    err.message = shortened

    const stack = safeErrorStack(err) ?? ''

    expect(stack).toBe('DrizzleQueryError')
    expect(stack).not.toContain('LEAK')
  })

  it('accepts a stack whose remainder after the header is empty, or starts with a frame', () => {
    const noFrames = drizzleError(DENIED, 'select 1', [])
    noFrames.stack = `${noFrames.name}: ${noFrames.message}`
    expect(safeErrorStack(noFrames)).toBe('DrizzleQueryError')

    const withFrame = drizzleError(DENIED, 'select 1', [])
    withFrame.stack = `${withFrame.name}: ${withFrame.message}\n    at Handler.run (/x/handler.ts:1:1)`
    expect(safeErrorStack(withFrame)).toBe(
      'DrizzleQueryError\n    at Handler.run (/x/handler.ts:1:1)',
    )
  })

  it('fails closed: a stack that does not start with its own `name: message` header yields just the name', () => {
    const err = drizzleError(DENIED, 'select 1 where a = $1', ['x\n    at LEAK (f:1:1)'])
    // Longer than the header it should have had, so that code which fell through and sliced
    // anyway would still find the frame lines below and keep them.
    err.stack = `${'rewritten by something else '.repeat(8)}\n    at LEAK (f:1:1)\n    at Handler.run (/x/handler.ts:1:1)`

    expect(safeErrorStack(err)).toBe('DrizzleQueryError')
  })

  it('returns the original stack for an error that is not itself a database error', () => {
    const err = new Error('boom', { cause: DENIED })
    err.stack = 'Error: boom\n    at x (/x.ts:1:1)'
    expect(safeErrorStack(err)).toBe('Error: boom\n    at x (/x.ts:1:1)')
  })

  it('returns String(value) for a non-Error, as the handlers always did', () => {
    expect(safeErrorStack('plain')).toBe('plain')
    expect(safeErrorStack(42)).toBe('42')
    expect(safeErrorStack(null)).toBe('null')
  })

  it('returns undefined for an Error with no stack, as err.stack always did', () => {
    const err = new Error('x')
    err.stack = undefined
    expect(safeErrorStack(err)).toBeUndefined()
  })

  it('returns just the name when a database error has no frames', () => {
    const err = drizzleError(DENIED, 'select 1', [])
    err.stack = 'DrizzleQueryError: Failed query: select 1\nparams: '
    expect(safeErrorStack(err)).toBe('DrizzleQueryError')
  })

  it('returns undefined for a database error with no stack at all', () => {
    const err = drizzleError(DENIED, 'select 1', [])
    err.stack = undefined
    expect(safeErrorStack(err)).toBeUndefined()
  })
})

describe('strictErrorStack', () => {
  // `nameAndFrames` guards `err.stack === undefined`, but that guard is UNREACHABLE from
  // `safeErrorStack`: it returns `err.stack` (a plain Error) or `undefined` (a pg/drizzle
  // node) BEFORE calling it. Only `strictErrorStack` can reach it, so it is pinned here.
  const stackless = (message: string): Error => {
    const e = new Error(message)
    Object.defineProperty(e, 'stack', { value: undefined })
    return e
  }

  it('gives a real Error its name and frames, never its message (not the NonError branch)', () => {
    const err = new Error('SECRET-VALUE-123')
    err.stack = 'Error: SECRET-VALUE-123\n    at Handler.run (/x/handler.ts:1:1)'
    expect(strictErrorStack(err)).toBe('Error\n    at Handler.run (/x/handler.ts:1:1)')
    expect(strictErrorStack(err)).not.toContain('SECRET-VALUE-123')
    expect(strictErrorStack(err)).not.toContain('NonError')
  })

  it('returns just the name for an Error whose stack is undefined, without the message', () => {
    expect(strictErrorStack(stackless('SECRET-VALUE-123'))).toBe('Error')
  })

  it('returns just the name for a stackless Error even when its message looks like a frame', () => {
    // With no stack there is nothing to slice: the result must be the bare name.
    expect(strictErrorStack(stackless('\n    at LEAK (f:1:1)'))).toBe('Error')
  })

  it('reports a non-Error by its type alone', () => {
    expect(strictErrorStack('SECRET-VALUE-123')).toBe('NonError(string)')
    expect(strictErrorStack({ message: 'x' })).toBe('NonError(object)')
  })

  it('safeErrorStack agrees: a stackless pg/drizzle node is undefined, never reaching the guard', () => {
    const err = drizzleError(DENIED, 'select 1', [])
    Object.defineProperty(err, 'stack', { value: undefined })
    expect(safeErrorStack(err)).toBeUndefined()
    expect(strictErrorStack(err)).toBe('DrizzleQueryError')
  })
})
