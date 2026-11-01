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

const parse = (name: string, v?: string | boolean | number) =>
  validateEnv({ ...BASE_DEV, ...(v === undefined ? {} : { [name]: v }) })

const flag = (v?: string | boolean) =>
  parse('JOB_AVAILABILITY_RECONCILE_ENABLED', v).JOB_AVAILABILITY_RECONCILE_ENABLED

describe('JOB_AVAILABILITY_RECONCILE_ENABLED (r5 Task 4.6 S8d)', () => {
  it('is off when absent (ships dark)', () => {
    expect(flag()).toBe(false)
  })

  it('is off for "false" and any non-"true" string (garbage fails closed to OFF)', () => {
    expect(flag('false')).toBe(false)
    expect(flag('1')).toBe(false)
    expect(flag('garbage')).toBe(false)
    expect(flag('')).toBe(false)
  })

  it('is on for "true" in any case', () => {
    expect(flag('true')).toBe(true)
    expect(flag('TRUE')).toBe(true)
  })

  it('takes an already-boolean value as it is', () => {
    expect(flag(true)).toBe(true)
    expect(flag(false)).toBe(false)
  })

  it('refuses to boot on a non-boolean, non-string value', () => {
    expect(() => parse('JOB_AVAILABILITY_RECONCILE_ENABLED', 5)).toThrow()
  })

  it('is distinct from the match reconciliation flag', () => {
    const env = validateEnv({ ...BASE_DEV, JOB_MATCH_RECONCILIATION_ENABLED: 'true' })
    expect(env.JOB_AVAILABILITY_RECONCILE_ENABLED).toBe(false)
  })
})
