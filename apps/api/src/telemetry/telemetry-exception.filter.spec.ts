import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common'
import type { HttpAdapterHost } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'
import { isTelemetryInternalRoute, TelemetryExceptionFilter } from './telemetry-exception.filter'
import type { TelemetryErrorsService } from './telemetry-errors.service'

function makeHost(url: string, user?: { id: string; role: string }): ArgumentsHost {
  const response = {}
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url, user }),
      getResponse: () => response,
    }),
    // BaseExceptionFilter.catch() reads the response via getArgByIndex(1),
    // NOT switchToHttp().getResponse() — both must return the SAME object.
    getArgByIndex: (index: number) => (index === 1 ? response : { url, user }),
  } as unknown as ArgumentsHost
}

function makeHttpAdapterHost(): HttpAdapterHost {
  return {
    httpAdapter: {
      reply: vi.fn(),
      getRequestUrl: (req: { url: string }) => req.url,
      isHeadersSent: () => false,
    },
  } as unknown as HttpAdapterHost
}

/**
 * `TelemetryExceptionFilter` deliberately does NOT take `HttpAdapterHost` as
 * a constructor param (see that file's own doc comment — capturing it
 * eagerly at construction time froze a still-`undefined` adapter and crashed
 * every response; fixed by relying on `BaseExceptionFilter`'s own `protected
 * readonly httpAdapterHost` PROPERTY, which Nest's DI populates via property
 * injection when it constructs the instance itself).
 *
 * These are hand-constructed unit tests (`new TelemetryExceptionFilter(...)`,
 * no Nest DI container involved), so nothing performs that property
 * injection here — this helper does it manually, standing in for what Nest's
 * `Injector.loadInstance()` would do. `readonly` is TypeScript-only (not
 * enforced at runtime), so a direct assignment through an `unknown` cast is
 * the correct, minimal way to simulate it in a plain unit test.
 */
function withHttpAdapter(filter: TelemetryExceptionFilter): TelemetryExceptionFilter {
  ;(filter as unknown as { httpAdapterHost: HttpAdapterHost }).httpAdapterHost =
    makeHttpAdapterHost()
  return filter
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('isTelemetryInternalRoute', () => {
  it('matches /api/telemetry/errors', () => {
    expect(isTelemetryInternalRoute('/api/telemetry/errors')).toBe(true)
  })

  it('matches /api/telemetry/events', () => {
    expect(isTelemetryInternalRoute('/api/telemetry/events')).toBe(true)
  })

  it('matches /api/telemetry/digest?since=2026-01-01 (query string stripped)', () => {
    expect(isTelemetryInternalRoute('/api/telemetry/digest?since=2026-01-01')).toBe(true)
  })

  it('does NOT match an unrelated route', () => {
    expect(isTelemetryInternalRoute('/api/finance/transactions')).toBe(false)
  })

  it('does NOT match a route that merely CONTAINS "telemetry" mid-path', () => {
    expect(isTelemetryInternalRoute('/api/not-telemetry/foo')).toBe(false)
  })
})

describe('TelemetryExceptionFilter — recursion guard (AC4)', () => {
  it('does NOT record an error for a request to /api/telemetry/* (recursion guard)', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const host = makeHost('/api/telemetry/events')

    filter.catch(new Error('boom inside telemetry ingest'), host)
    await flushMicrotasks()

    expect(recordError).not.toHaveBeenCalled()
  })

  it('sec HIGH (review round 1): strips a query string (OAuth code/state) from the recorded route', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const host = makeHost('/api/auth/google/callback?code=secret-oauth-code&state=csrf-state-value')

    filter.catch(new Error('unexpected DB failure'), host)
    await flushMicrotasks()

    expect(recordError).toHaveBeenCalledTimes(1)
    const call = recordError.mock.calls[0]![0] as { route: string }
    expect(call.route).toBe('/api/auth/google/callback')
    expect(call.route).not.toContain('code=')
    expect(call.route).not.toContain('secret-oauth-code')
    expect(call.route).not.toContain('state=')
  })

  it('records a 5xx error for a NORMAL route', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const host = makeHost('/api/finance/transactions', { id: 'u1', role: 'SENIOR' })

    filter.catch(new Error('unexpected DB failure'), host)
    await flushMicrotasks()

    expect(recordError).toHaveBeenCalledTimes(1)
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'API',
        message: 'unexpected DB failure',
        route: '/api/finance/transactions',
        userId: 'u1',
        userRole: 'SENIOR',
      }),
    )
  })

  it('does NOT record a 4xx HttpException (only 5xx/unhandled)', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const host = makeHost('/api/finance/transactions')

    filter.catch(new HttpException('Not Found', HttpStatus.NOT_FOUND), host)
    await flushMicrotasks()

    expect(recordError).not.toHaveBeenCalled()
  })

  it('records a 500 HttpException', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const host = makeHost('/api/finance/transactions')

    filter.catch(new HttpException('Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR), host)
    await flushMicrotasks()

    expect(recordError).toHaveBeenCalledTimes(1)
  })

  it('still produces a response (via BaseExceptionFilter) even when recordError itself throws — does not break the response (AC4)', async () => {
    const recordError = vi.fn().mockRejectedValue(new Error('DB unreachable'))
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const host = makeHost('/api/finance/transactions')

    // Must not throw synchronously, and must not reject — the whole point of
    // fire-and-forget is that a failed recording never surfaces to the caller.
    expect(() => filter.catch(new Error('unexpected'), host)).not.toThrow()
    await flushMicrotasks()
  })

  it('handles a request with no authenticated user (userId/userRole undefined)', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const host = makeHost('/api/health')

    filter.catch(new Error('boom'), host)
    await flushMicrotasks()

    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined, userRole: undefined }),
    )
  })
})

/**
 * SR-865-M-1 (retro review of PR #865): a drizzle query failure carries the bound
 * parameters in `message` and `stack` (`Failed query: … params: …`). On a webhook
 * ingest those parameters are the recording snapshot — a candidate's transcript —
 * and this filter used to store both verbatim in `telemetry_errors`, from where
 * the digest files issues.
 */
describe('TelemetryExceptionFilter — database errors never record parameter values', () => {
  const SECRET_VALUE = 'candidate said: my salary expectation is 9000'

  function drizzleFailure(): Error {
    const cause = Object.assign(new Error('unsupported Unicode escape sequence'), {
      severity: 'ERROR',
      code: '22P05',
    })
    const query = 'insert into "interview_recordings" ("title", "snapshot") values ($1, $2)'
    const err = Object.assign(
      new Error(`Failed query: ${query}\nparams: Weekly sync,{"text":"${SECRET_VALUE}"}`),
      { query, params: ['Weekly sync', `{"text":"${SECRET_VALUE}"}`], cause },
    )
    err.name = 'DrizzleQueryError'
    return err
  }

  it('records the SQLSTATE and statement shape, and no parameter value in message or stack', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))

    filter.catch(drizzleFailure(), makeHost('/api/interviews'))
    await flushMicrotasks()

    expect(recordError).toHaveBeenCalledTimes(1)
    const recorded = recordError.mock.calls[0]![0] as { message: string; stack?: string }
    expect(recorded.message).toBe(
      'db_error db_state=22P05 db_table=- db_constraint=- db_column=- ' +
        'db_message=- ' +
        "db_statement=\"insert into 'interview_recordings' ('title', 'snapshot') values ($1, $2)\"",
    )
    expect(JSON.stringify(recorded)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(recorded)).not.toContain('Weekly sync')
    expect(recorded.stack?.startsWith(`DrizzleQueryError: ${recorded.message}\n    at `)).toBe(true)
  })

  it('hands Nest’s own error log the redacted error, not the parameter values', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const telemetryErrors = {
      recordError: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))

    filter.catch(drizzleFailure(), makeHost('/api/interviews'))

    expect(logged).toHaveBeenCalledTimes(1)
    const [loggedError] = logged.mock.calls[0]! as [Error]
    expect(loggedError.message).toContain('db_state=22P05')
    expect(`${loggedError.message}\n${loggedError.stack}`).not.toContain(SECRET_VALUE)
    logged.mockRestore()
  })

  it('leaves a 5xx HttpException with a database cause untouched', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const exception = new HttpException('Service Unavailable', HttpStatus.SERVICE_UNAVAILABLE, {
      cause: drizzleFailure(),
    })

    filter.catch(exception, makeHost('/api/interviews'))
    await flushMicrotasks()

    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Service Unavailable', stack: exception.stack }),
    )
  })

  /**
   * SR-M-1 (fix round 1, review 5631787486): when the top-level error is NOT itself a
   * pg/drizzle error but wraps one as `cause`, `safeErrorStack` returns its stack verbatim.
   * Rebuilding from "every line after the first" then keeps the rest of a MULTI-LINE wrapper
   * message — which can embed a parameter value — in what is stored as the stack.
   */
  it('keeps only stack frames when a wrapper error embeds a multi-line value in its message', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))

    const wrapper = new Error(
      `ingest failed for recording\n${SECRET_VALUE}\nmore ${SECRET_VALUE}`,
      { cause: drizzleFailure() },
    )
    wrapper.stack = `Error: ${wrapper.message}\n    at Real.frame (/real/file.ts:9:9)`

    filter.catch(wrapper, makeHost('/api/interviews'))
    await flushMicrotasks()

    const recorded = recordError.mock.calls[0]![0] as { message: string; stack?: string }
    expect(recorded.message).toContain('db_state=22P05')
    expect(JSON.stringify(recorded)).not.toContain(SECRET_VALUE)
    expect(recorded.stack).toBe(`Error: ${recorded.message}\n    at Real.frame (/real/file.ts:9:9)`)
  })

  /**
   * Mutation gate: dropping the `^` anchor from the frame filter (`/^\s+at /` -> `/\s+at /`)
   * survived. The anchor IS the security property — without it ANY line merely CONTAINING
   * " at " is kept as a "frame", and a parameter value routinely reads
   * "... created at 2026-01-01 ...". This case fails under that mutant, and under a plain
   * `includes('at ')` too.
   */
  it('drops a message line that contains " at " mid-line — only a real frame is a frame', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))

    const midLineAt = `candidate joined at 10:00 and said ${SECRET_VALUE}`
    const wrapper = new Error('ingest failed', { cause: drizzleFailure() })
    wrapper.stack = `Error: ingest failed\n${midLineAt}\n    at Real.frame (/real/file.ts:9:9)`

    filter.catch(wrapper, makeHost('/api/interviews'))
    await flushMicrotasks()

    const recorded = recordError.mock.calls[0]![0] as { stack?: string }
    expect(recorded.stack).not.toContain('candidate joined at 10:00')
    expect(recorded.stack).not.toContain(SECRET_VALUE)
    expect(recorded.stack).toContain('at Real.frame (/real/file.ts:9:9)')
  })

  it('records a row with no frames when the error carries no stack at all', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))

    // A drizzle error whose `.stack` is absent: `safeErrorStack` returns undefined, so the
    // `?? ''` fallback is what builds the (frame-less) stack instead of throwing.
    const stackless = drizzleFailure()
    stackless.stack = undefined

    filter.catch(stackless, makeHost('/api/interviews'))
    await flushMicrotasks()

    const recorded = recordError.mock.calls[0]![0] as { message: string; stack?: string }
    expect(recorded.message).toContain('db_state=22P05')
    expect(recorded.stack).toBe(`DrizzleQueryError: ${recorded.message}`)
  })

  /**
   * The bound of the fix above, asserted so it is not mistaken for a leak later: a value that
   * itself contains an indented `at …` line is indistinguishable from a frame. `pg-errors.ts`
   * records this residual as an accepted decision (frames are what make a DB error
   * diagnosable); this pins the actual behaviour rather than an aspiration.
   */
  it('cannot distinguish a frame-shaped line embedded in a message (documented residual)', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))

    const wrapper = new Error('wrapped', { cause: drizzleFailure() })
    wrapper.stack = 'Error: wrapped\n    at looks.like.a.frame (/x/y.ts:1:1)'

    filter.catch(wrapper, makeHost('/api/interviews'))
    await flushMicrotasks()

    const recorded = recordError.mock.calls[0]![0] as { stack?: string }
    expect(recorded.stack).toContain('at looks.like.a.frame')
  })

  it('keeps message and stack unchanged for an error with no database error in it', async () => {
    const recordError = vi.fn().mockResolvedValue(undefined)
    const telemetryErrors = { recordError } as unknown as TelemetryErrorsService
    const filter = withHttpAdapter(new TelemetryExceptionFilter(telemetryErrors))
    const plain = new Error('plain failure')

    filter.catch(plain, makeHost('/api/interviews'))
    await flushMicrotasks()

    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'plain failure', stack: plain.stack }),
    )
  })
})
