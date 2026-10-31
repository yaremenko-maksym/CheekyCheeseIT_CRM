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

const bridge = (v?: string | boolean) =>
  parse('JOB_QUEUE_BRIDGE_ENABLED', v).JOB_QUEUE_BRIDGE_ENABLED

describe('JOB_QUEUE_BRIDGE_ENABLED (r5 Task 4.6 S6a)', () => {
  it('is off when absent', () => {
    expect(bridge()).toBe(false)
  })

  it('is off for "false" and for any non-"true" string (garbage fails closed to OFF)', () => {
    expect(bridge('false')).toBe(false)
    expect(bridge('1')).toBe(false)
    expect(bridge('garbage')).toBe(false)
    expect(bridge('')).toBe(false)
  })

  it('is on for "true" in any case', () => {
    expect(bridge('true')).toBe(true)
    expect(bridge('TRUE')).toBe(true)
  })

  it('takes an already-boolean value as it is', () => {
    expect(bridge(true)).toBe(true)
    expect(bridge(false)).toBe(false)
  })

  it('refuses to boot on a non-boolean, non-string value, exactly as the reconciliation flag does', () => {
    expect(() => parse('JOB_QUEUE_BRIDGE_ENABLED', 5)).toThrow()
    expect(() => parse('JOB_MATCH_RECONCILIATION_ENABLED', 5)).toThrow()
  })

  it('is independent of the reconciliation flag', () => {
    const env = validateEnv({ ...BASE_DEV, JOB_MATCH_RECONCILIATION_ENABLED: 'true' })
    expect(env.JOB_QUEUE_BRIDGE_ENABLED).toBe(false)
  })
})
