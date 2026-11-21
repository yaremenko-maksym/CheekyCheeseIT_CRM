import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAILORED_RESUME_DAILY_TEAM_CAP,
  DEFAULT_TAILORED_RESUME_MAX_CONCURRENT_RUNS,
  validateEnv,
} from './env'

// The minimum a development boot needs (mirrors BASE_DEV in env.spec.ts).
const BASE_DEV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/crm',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/auth/google/callback',
  JWT_SECRET: 'jwt-secret-at-least-32-chars-000000',
  SESSION_SECRET: 'session-secret-at-least-32-chars-0',
  FRONTEND_URL: 'http://localhost:3000',
  AWS_ACCESS_KEY_ID: 'crmdevaccesskey',
  AWS_SECRET_ACCESS_KEY: 'crmdevsecretkey',
}

const envWith = (extra: Record<string, unknown>) => validateEnv({ ...BASE_DEV, ...extra })

describe('TAILORED_RESUME_ENABLED (tailored-resume D11)', () => {
  it('is false when unset: the feature ships inert', () => {
    expect(envWith({}).TAILORED_RESUME_ENABLED).toBe(false)
  })

  it("is true only for 'true', in any case", () => {
    expect(envWith({ TAILORED_RESUME_ENABLED: 'true' }).TAILORED_RESUME_ENABLED).toBe(true)
    expect(envWith({ TAILORED_RESUME_ENABLED: 'TRUE' }).TAILORED_RESUME_ENABLED).toBe(true)
    expect(envWith({ TAILORED_RESUME_ENABLED: 'false' }).TAILORED_RESUME_ENABLED).toBe(false)
    expect(envWith({ TAILORED_RESUME_ENABLED: '1' }).TAILORED_RESUME_ENABLED).toBe(false)
  })

  it('a config already holding a boolean passes it through', () => {
    expect(envWith({ TAILORED_RESUME_ENABLED: true }).TAILORED_RESUME_ENABLED).toBe(true)
    expect(envWith({ TAILORED_RESUME_ENABLED: false }).TAILORED_RESUME_ENABLED).toBe(false)
  })
})

describe('TAILORED_RESUME_MAX_CONCURRENT_RUNS', () => {
  const runsOf = (v?: string) =>
    envWith(v === undefined ? {} : { TAILORED_RESUME_MAX_CONCURRENT_RUNS: v })
      .TAILORED_RESUME_MAX_CONCURRENT_RUNS

  it('defaults to 2', () => {
    expect(DEFAULT_TAILORED_RESUME_MAX_CONCURRENT_RUNS).toBe(2)
    expect(runsOf()).toBe(2)
  })

  it('accepts a positive integer', () => {
    expect(runsOf('1')).toBe(1)
    expect(runsOf('7')).toBe(7)
  })

  it('refuses to boot on zero, a negative, a fraction or a word', () => {
    expect(() => runsOf('0')).toThrow()
    expect(() => runsOf('-1')).toThrow()
    expect(() => runsOf('1.5')).toThrow()
    expect(() => runsOf('many')).toThrow()
  })

  it('a blank value is the default, not 0', () => {
    expect(runsOf('')).toBe(2)
    expect(runsOf('  ')).toBe(2)
  })
})

describe('TAILORED_RESUME_DAILY_TEAM_CAP', () => {
  const capOf = (v?: string) =>
    envWith(v === undefined ? {} : { TAILORED_RESUME_DAILY_TEAM_CAP: v })
      .TAILORED_RESUME_DAILY_TEAM_CAP

  it('defaults to 50', () => {
    expect(DEFAULT_TAILORED_RESUME_DAILY_TEAM_CAP).toBe(50)
    expect(capOf()).toBe(50)
  })

  it('accepts a positive integer', () => {
    expect(capOf('1')).toBe(1)
    expect(capOf('120')).toBe(120)
  })

  it('refuses to boot on zero, a negative, a fraction or a word', () => {
    expect(() => capOf('0')).toThrow()
    expect(() => capOf('-5')).toThrow()
    expect(() => capOf('2.5')).toThrow()
    expect(() => capOf('lots')).toThrow()
  })

  it('a blank value is the default, not 0', () => {
    expect(capOf('')).toBe(50)
    expect(capOf('  ')).toBe(50)
  })
})
