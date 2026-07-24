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
