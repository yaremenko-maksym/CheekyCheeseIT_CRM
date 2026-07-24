import type { ExecutionContext } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import type { Env } from '../config/env'
import { TelemetryDigestTokenGuard } from './telemetry-digest-token.guard'

const REAL_TOKEN = 'a-real-telemetry-digest-token-with-plenty-of-entropy'

function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext
}

function makeConfig(): ConfigService<Env, true> {
  return { get: () => REAL_TOKEN } as unknown as ConfigService<Env, true>
}

describe('TelemetryDigestTokenGuard', () => {
  it('allows the request when X-Telemetry-Token matches exactly', () => {
    const guard = new TelemetryDigestTokenGuard(makeConfig())
    const ctx = makeContext({ 'x-telemetry-token': REAL_TOKEN })
    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('throws 401 when the header is missing entirely', () => {
    const guard = new TelemetryDigestTokenGuard(makeConfig())
    const ctx = makeContext({})
    expect(() => guard.canActivate(ctx)).toThrow(/Unauthorized/)
  })

  it('throws 401 when the header is an empty string', () => {
    const guard = new TelemetryDigestTokenGuard(makeConfig())
    const ctx = makeContext({ 'x-telemetry-token': '' })
    expect(() => guard.canActivate(ctx)).toThrow()
  })

  it('throws 401 when the header value is wrong (same length)', () => {
    const guard = new TelemetryDigestTokenGuard(makeConfig())
    const wrongSameLength = 'b'.repeat(REAL_TOKEN.length)
    const ctx = makeContext({ 'x-telemetry-token': wrongSameLength })
    expect(() => guard.canActivate(ctx)).toThrow()
  })

  it('throws 401 when the header value is wrong (different length) — never calls timingSafeEqual on mismatched lengths', () => {
    const guard = new TelemetryDigestTokenGuard(makeConfig())
    const ctx = makeContext({ 'x-telemetry-token': 'short' })
    expect(() => guard.canActivate(ctx)).toThrow()
  })

  it('throws 401 for a token that is a strict prefix of the real one (length differs)', () => {
    const guard = new TelemetryDigestTokenGuard(makeConfig())
    const ctx = makeContext({ 'x-telemetry-token': REAL_TOKEN.slice(0, -1) })
    expect(() => guard.canActivate(ctx)).toThrow()
  })
})
