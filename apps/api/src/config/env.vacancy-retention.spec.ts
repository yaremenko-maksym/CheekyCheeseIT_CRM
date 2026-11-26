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

const flag = (v?: string | boolean | number) =>
  validateEnv({ ...BASE_DEV, ...(v === undefined ? {} : { VACANCY_RETENTION_ENABLED: v }) })
    .VACANCY_RETENTION_ENABLED

describe('VACANCY_RETENTION_ENABLED (SR-M-3 kill switch)', () => {
  it('is on when absent (the owner decision ships on)', () => {
    expect(flag()).toBe(true)
  })

  it('is off for "false", in any case', () => {
    expect(flag('false')).toBe(false)
    expect(flag('FALSE')).toBe(false)
  })

  it('is on for "true", in any case', () => {
    expect(flag('true')).toBe(true)
    expect(flag('True')).toBe(true)
  })

  it('SR-M-6: refuses to boot on any other value, naming the key', () => {
    for (const v of ['0', 'off', 'yes', 'flase', ' true', '', 5, false]) {
      expect(() => flag(v), String(v)).toThrow(/VACANCY_RETENTION_ENABLED/)
    }
  })
})
