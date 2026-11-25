import { describe, expect, it } from 'vitest'
import { validateEnv } from './env'

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

const flag = (v?: string | boolean) =>
  validateEnv({ ...BASE_DEV, ...(v === undefined ? {} : { JOB_RELEVANCE_AI_ENABLED: v }) })
    .JOB_RELEVANCE_AI_ENABLED

describe('JOB_RELEVANCE_AI_ENABLED (queue relevance PR1)', () => {
  it('defaults to false; anything but "true" is off', () => {
    expect(flag()).toBe(false)
    expect(flag('false')).toBe(false)
    expect(flag('no')).toBe(false)
    expect(flag('1')).toBe(false)
  })

  it('is on for "true" in any case', () => {
    expect(flag('true')).toBe(true)
    expect(flag('TRUE')).toBe(true)
  })

  it('takes an already-boolean value as it is', () => {
    expect(flag(true)).toBe(true)
    expect(flag(false)).toBe(false)
  })
})
