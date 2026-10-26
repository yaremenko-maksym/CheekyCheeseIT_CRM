import { describe, expect, it } from 'vitest'
import { validateEnv } from './env'

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

const flag = (v?: string) =>
  validateEnv({ ...BASE_DEV, ...(v === undefined ? {} : { JOB_MATCH_RECONCILIATION_ENABLED: v }) })
    .JOB_MATCH_RECONCILIATION_ENABLED

describe('JOB_MATCH_RECONCILIATION_ENABLED (r5 Task 4.6 S4b)', () => {
  it('is off unless explicitly enabled', () => {
    expect(flag()).toBe(false)
    expect(flag('false')).toBe(false)
    expect(flag('1')).toBe(false)
  })

  it('is on for "true" in any case', () => {
    expect(flag('true')).toBe(true)
    expect(flag('TRUE')).toBe(true)
  })
})
