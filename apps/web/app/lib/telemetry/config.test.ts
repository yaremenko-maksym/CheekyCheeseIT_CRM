import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentAppVersion, isTelemetryEnabled } from './config'

describe('isTelemetryEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is disabled when VITE_TELEMETRY is unset (dev/E2E default)', () => {
    vi.stubEnv('VITE_TELEMETRY', undefined as unknown as string)
    expect(isTelemetryEnabled()).toBe(false)
  })

  it('is disabled when VITE_TELEMETRY=off (explicit dev/E2E value)', () => {
    vi.stubEnv('VITE_TELEMETRY', 'off')
    expect(isTelemetryEnabled()).toBe(false)
  })

  it('is disabled for any value other than the exact string "on" (default-DENY)', () => {
    vi.stubEnv('VITE_TELEMETRY', 'true')
    expect(isTelemetryEnabled()).toBe(false)
    vi.stubEnv('VITE_TELEMETRY', 'ON')
    expect(isTelemetryEnabled()).toBe(false)
  })

  it('is enabled ONLY when VITE_TELEMETRY is exactly "on" (prod build)', () => {
    vi.stubEnv('VITE_TELEMETRY', 'on')
    expect(isTelemetryEnabled()).toBe(true)
  })
})

/**
 * Hotfix regression coverage (prod-smoke, PR #415 follow-up): the ACTUAL bug
 * — `import.meta.env['VITE_TELEMETRY']` (bracket) never being folded to a
 * literal by Vite's static build-time replacement — is NOT reproducible in
 * this vitest/happy-dom environment (`import.meta.env` is a real runtime
 * object here, so bracket and dot access are equivalent; `vi.stubEnv` patches
 * that object directly regardless of which access form the source uses).
 * That's exactly why the hotfix's PRIMARY proof is a real `vite build` +
 * `grep dist/assets` (see PR body), not a unit test. What IS unit-testable
 * here is the `[telemetry] enabled` sentinel's own logic (fires once when
 * enabled, never when disabled) — a regression on THAT would silently break
 * the grep-based build verification for any future config.ts change.
 */
describe('isTelemetryEnabled — "[telemetry] enabled" sentinel (hotfix)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('logs the sentinel via console.debug the first time it is enabled', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_TELEMETRY', 'on')
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const fresh = await import('./config')
    fresh.isTelemetryEnabled()
    expect(debugSpy).toHaveBeenCalledWith('[telemetry] enabled')
    debugSpy.mockRestore()
  })

  it('never logs the sentinel while disabled', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_TELEMETRY', 'off')
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const fresh = await import('./config')
    fresh.isTelemetryEnabled()
    fresh.isTelemetryEnabled()
    expect(debugSpy).not.toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('logs the sentinel only ONCE across repeated calls (no console-spam per event)', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_TELEMETRY', 'on')
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const fresh = await import('./config')
    fresh.isTelemetryEnabled()
    fresh.isTelemetryEnabled()
    fresh.isTelemetryEnabled()
    expect(debugSpy).toHaveBeenCalledOnce()
    debugSpy.mockRestore()
  })
})

describe('currentAppVersion', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns undefined when VITE_BUILD_VERSION is not set', () => {
    vi.stubEnv('VITE_BUILD_VERSION', undefined as unknown as string)
    expect(currentAppVersion()).toBeUndefined()
  })

  it('returns the build version when set', () => {
    vi.stubEnv('VITE_BUILD_VERSION', 'b-abc123')
    expect(currentAppVersion()).toBe('b-abc123')
  })
})
