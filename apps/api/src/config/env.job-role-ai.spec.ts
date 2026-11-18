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
  validateEnv({ ...BASE_DEV, ...(v === undefined ? {} : { JOB_ROLE_AI_ENABLED: v }) })
    .JOB_ROLE_AI_ENABLED

describe('JOB_ROLE_AI_ENABLED (senior roles PR 3)', () => {
  it('JOB_ROLE_AI_ENABLED defaults to false and parses "true"', () => {
    expect(flag()).toBe(false)
    expect(flag('false')).toBe(false)
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

const budget = (v?: string) =>
  validateEnv({ ...BASE_DEV, ...(v === undefined ? {} : { JOB_ROLE_AI_DAILY_BUDGET: v }) })
    .JOB_ROLE_AI_DAILY_BUDGET

describe('JOB_ROLE_AI_DAILY_BUDGET (SR-M-1)', () => {
  it('defaults to 18 calls a day and parses an integer', () => {
    expect(budget()).toBe(18)
    expect(budget('30')).toBe(30)
    expect(budget('1')).toBe(1)
  })

  it('an empty or blank value means unset: the default applies (CR-M-5)', () => {
    expect(budget('')).toBe(18)
    expect(budget('   ')).toBe(18)
  })

  it('refuses zero, a negative, a fraction and a non-number', () => {
    for (const v of ['0', '-1', '1.5', '2.5', 'abc', 'many']) expect(() => budget(v)).toThrow()
  })

  it('accepts the ceiling 37 and refuses 38 (SR-L-5)', () => {
    expect(budget('37')).toBe(37)
    expect(() => budget('38')).toThrow()
  })
})
