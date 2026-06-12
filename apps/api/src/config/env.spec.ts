import { describe, expect, it } from 'vitest'
import { validateEnv } from './env'

/**
 * Unit tests for validateEnv — focus on CREDENTIALS_ENC_KEY fail-closed behaviour
 * in production (MED-1 security finding from PR #178 review).
 *
 * Three cases per the task spec:
 *   1. placeholder prefix ("change_me…") in production → throw
 *   2. placeholder prefix in development → ok
 *   3. valid hex key in production → ok
 */

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
  AWS_ACCESS_KEY_ID: 'minioadmin',
  AWS_SECRET_ACCESS_KEY: 'minioadmin',
}

// Valid 64-char hex (32 bytes) — passes the min(32) check and has no placeholder prefix.
const VALID_HEX_KEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

// The placeholder that ships in .env.example for production onboarding.
const EXAMPLE_PLACEHOLDER = 'change_me_run_openssl_rand_hex_32'

describe('validateEnv — CREDENTIALS_ENC_KEY fail-closed', () => {
  it('throws in production when CREDENTIALS_ENC_KEY starts with change_me (placeholder)', () => {
    expect(() =>
      validateEnv({
        ...BASE_DEV,
        NODE_ENV: 'production',
        AWS_ACCESS_KEY_ID: 'real-access-key-id',
        AWS_SECRET_ACCESS_KEY: 'real-secret-access-key',
        CREDENTIALS_ENC_KEY: EXAMPLE_PLACEHOLDER,
      }),
    ).toThrow(/change_me/)
  })

  it('allows CREDENTIALS_ENC_KEY starting with change_me in development (convenience default)', () => {
    expect(() =>
      validateEnv({
        ...BASE_DEV,
        NODE_ENV: 'development',
        CREDENTIALS_ENC_KEY: EXAMPLE_PLACEHOLDER,
      }),
    ).not.toThrow()
  })

  it('allows a valid hex CREDENTIALS_ENC_KEY in production', () => {
    expect(() =>
      validateEnv({
        ...BASE_DEV,
        NODE_ENV: 'production',
        AWS_ACCESS_KEY_ID: 'real-access-key-id',
        AWS_SECRET_ACCESS_KEY: 'real-secret-access-key',
        CREDENTIALS_ENC_KEY: VALID_HEX_KEY,
      }),
    ).not.toThrow()
  })
})
