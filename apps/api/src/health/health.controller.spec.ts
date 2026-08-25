/**
 * backlog 113 — GET /api/health build fingerprint.
 *
 * Coverage:
 *  R1-a: GIT_COMMIT/BUILD_TIME set (Docker image build) → both echoed
 *        verbatim in the response.
 *  R1-b: GIT_COMMIT/BUILD_TIME unset (local `pnpm dev` / any non-Docker
 *        boot) → both report the literal string 'unknown', never '' and
 *        never a fabricated value.
 *
 * Pattern follows auth.controller.spec.ts: no NestJS testing module
 * overhead, direct class instantiation with a typed ConfigService stub.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { HealthController } from './health.controller'

function makeConfig(
  overrides: Partial<Record<'GIT_COMMIT' | 'BUILD_TIME', string>>,
): ConfigService<Env> {
  return {
    get: (key: string) => (overrides as Record<string, string | undefined>)[key],
  } as unknown as ConfigService<Env>
}

describe('HealthController', () => {
  it('R1-a: echoes commit + build time verbatim when the build set them', () => {
    const controller = new HealthController(
      makeConfig({ GIT_COMMIT: 'abc1234', BUILD_TIME: '2026-08-25T00:00:00Z' }),
    )

    const result = controller.check()

    expect(result.status).toBe('ok')
    expect(result.commit).toBe('abc1234')
    expect(result.buildTime).toBe('2026-08-25T00:00:00Z')
  })

  it('R1-b: reports the literal "unknown" — never "" — when unset (local boot)', () => {
    const controller = new HealthController(makeConfig({}))

    const result = controller.check()

    expect(result.status).toBe('ok')
    expect(result.commit).toBe('unknown')
    expect(result.commit).not.toBe('')
    expect(result.buildTime).toBe('unknown')
    expect(result.buildTime).not.toBe('')
  })

  // Regression, found by actually building+booting the API image with
  // neither --build-arg supplied: ConfigService.get() falls back to raw
  // process.env when its validated value is undefined, and the Dockerfile's
  // `ARG GIT_COMMIT=` default bakes an EMPTY STRING into process.env, not an
  // absent key — so a real container returned `"commit":""` before this was
  // fixed to `||` (see health.controller.ts's own doc for the mechanism).
  // The stub below reproduces exactly what ConfigService.get() returns in
  // that scenario: an empty string, not undefined.
  it('R1-d: an EMPTY string from ConfigService (unset Docker build-arg) also reports "unknown"', () => {
    const controller = new HealthController(makeConfig({ GIT_COMMIT: '', BUILD_TIME: '' }))

    const result = controller.check()

    expect(result.commit).toBe('unknown')
    expect(result.buildTime).toBe('unknown')
  })

  it('R1-c: timestamp is a fresh, well-formed ISO string on every call', () => {
    const controller = new HealthController(makeConfig({}))

    const result = controller.check()

    expect(() => new Date(result.timestamp).toISOString()).not.toThrow()
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp)
  })
})
