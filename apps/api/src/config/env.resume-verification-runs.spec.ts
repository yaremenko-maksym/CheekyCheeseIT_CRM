import { describe, expect, it } from 'vitest'
import { DEFAULT_RESUME_VERIFICATION_MAX_CONCURRENT_RUNS, validateEnv } from './env'

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

const capOf = (v?: string) =>
  validateEnv({
    ...BASE_DEV,
    ...(v === undefined ? {} : { RESUME_VERIFICATION_MAX_CONCURRENT_RUNS: v }),
  }).RESUME_VERIFICATION_MAX_CONCURRENT_RUNS

describe('RESUME_VERIFICATION_MAX_CONCURRENT_RUNS (backlog 436)', () => {
  it('defaults to 3', () => {
    expect(DEFAULT_RESUME_VERIFICATION_MAX_CONCURRENT_RUNS).toBe(3)
    expect(capOf()).toBe(3)
  })

  it('accepts a positive integer', () => {
    expect(capOf('1')).toBe(1)
    expect(capOf('12')).toBe(12)
  })

  it('refuses to boot on zero, a negative, a fraction or a word', () => {
    expect(() => capOf('0')).toThrow()
    expect(() => capOf('-2')).toThrow()
    expect(() => capOf('2.5')).toThrow()
    expect(() => capOf('many')).toThrow()
  })

  it('a blank value is the default, not 0', () => {
    expect(capOf('')).toBe(3)
    expect(capOf('  ')).toBe(3)
  })
})
