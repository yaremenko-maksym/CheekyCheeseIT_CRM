import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common'
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
