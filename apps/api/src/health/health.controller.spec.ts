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
import { describe, expect, it, vi } from 'vitest'
import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'
import { HealthController } from './health.controller'

// `vi.fn()`, not a plain arrow function that ignores its 2nd argument: a
// stub that never looks at what it was called WITH cannot tell `{ infer:
// true }` apart from `{}` or `{ infer: false }` — both read exactly the same
// override map either way, so a mutant swapping that options object was
// invisible to this suite until the assertions on `.mock.calls` below were
// added (task-mutation-gate-mechanical AC4's whole point: a "reads right"
// test and a "calls right" test catch different mutants).
function makeConfig(overrides: Partial<Record<'GIT_COMMIT' | 'BUILD_TIME', string>>) {
  const get = vi.fn((key: string) => (overrides as Record<string, string | undefined>)[key])
  return { get } as unknown as ConfigService<Env> & { get: typeof get }
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

  // `{ infer: true }` is NestJS's documented way of saying "resolve this
  // key's type from the Env schema, don't treat the 2nd argument as a
  // default value" (see @nestjs/config's ConfigService.get — an options
  // object without `infer: true` is read as a plain default value instead).
  // R1-a/b/d above only check the RETURN of a stub that ignores its
  // arguments, so `{ infer: true }` silently becoming `{}` or `{ infer:
  // false }` changed nothing they could see. This asserts the call shape
  // itself, on the real `ConfigService<Env>` contract.
  it('R1-e: calls config.get with the exact key + { infer: true } options NestJS expects', () => {
    const config = makeConfig({ GIT_COMMIT: 'abc1234', BUILD_TIME: '2026-08-25T00:00:00Z' })
    const controller = new HealthController(config)

    controller.check()

    expect(config.get).toHaveBeenCalledWith('GIT_COMMIT', { infer: true })
    expect(config.get).toHaveBeenCalledWith('BUILD_TIME', { infer: true })
  })
})
