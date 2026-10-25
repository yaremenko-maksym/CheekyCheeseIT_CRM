import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JOB_COLLECTION_WINDOW_MS,
  JOB_COLLECTION_WINDOW_CEILING_MS,
  validateEnv,
} from './env'

// The minimum a development boot needs (mirrors BASE_DEV in env.spec.ts).
const BASE_DEV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/crm',
  REDIS_URL: 'redis://localhost:6379',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/auth/google/callback',
  JWT_SECRET: 'jwt-secret-at-least-32-chars-000000',
  SESSION_SECRET: 'session-secret-at-least-32-chars-0',
  FRONTEND_URL: 'http://localhost:3000',
  AWS_ACCESS_KEY_ID: 'crmdevaccesskey',
  AWS_SECRET_ACCESS_KEY: 'crmdevsecretkey',
}

const windowOf = (v?: string) =>
  validateEnv({ ...BASE_DEV, ...(v === undefined ? {} : { JOB_COLLECTION_WINDOW_MS: v }) })
    .JOB_COLLECTION_WINDOW_MS

describe('JOB_COLLECTION_WINDOW_MS (r5 Task 2.5 T5, a config value with a ceiling)', () => {
  it('defaults to one hour, and the ceiling is two hours (02:30 ends before 05:00)', () => {
    expect(DEFAULT_JOB_COLLECTION_WINDOW_MS).toBe(3_600_000)
    expect(JOB_COLLECTION_WINDOW_CEILING_MS).toBe(7_200_000)
    expect(windowOf()).toBe(3_600_000)
  })

  it('accepts a value from one second to the ceiling', () => {
    expect(windowOf('1000')).toBe(1_000)
    expect(windowOf('7200000')).toBe(7_200_000)
  })

  it('refuses to boot above the ceiling, below one second, or on a non-integer', () => {
    expect(() => windowOf('7200001')).toThrow()
    expect(() => windowOf('999')).toThrow()
    expect(() => windowOf('1500.5')).toThrow()
    expect(() => windowOf('soon')).toThrow()
  })

  it('a blank value is the default, not 0', () => {
    expect(windowOf('')).toBe(3_600_000)
    expect(windowOf('  ')).toBe(3_600_000)
  })
})
