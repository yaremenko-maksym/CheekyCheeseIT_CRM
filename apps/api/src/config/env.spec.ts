import { describe, expect, it } from 'vitest'
import { validateEnv } from './env'

/**
 * Unit tests for validateEnv:
 *
 * Section A — CREDENTIALS_ENC_KEY fail-closed (MED-1 security, PR #178):
 *   1. placeholder prefix ("change_me…") in production → throw
 *   2. placeholder prefix in development → ok
 *   3. valid hex key in production → ok
 *
 * Section B — CORS_ORIGINS env schema (PR3b):
 *   4. CORS_ORIGINS optional — omitted → ok, field undefined
 *   5. CORS_ORIGINS provided as string → ok, stored as-is (parsing is in cors.ts)
 *
 * Section C — TRUST_PROXY boolean preprocess (PR3b):
 *   6. 'true' string → parsed as boolean true
 *   7. 'false' string → parsed as boolean false
 *   8. omitted → defaults to false
 *   9. boolean true (direct) → kept as true
 *
 * Section D — Throttler env-config (env-config PR):
 *   10. THROTTLER_TTL_MS — omitted → default 60_000
 *   11. THROTTLER_TTL_MS — provided as numeric string → coerced to number
 *   12. THROTTLER_TTL_MS — below min 1_000 → throw
 *   13. THROTTLER_LIMIT — omitted → default 100
 *   14. THROTTLER_LIMIT — provided as numeric string → coerced to number
 *   15. THROTTLE_RELAXED — omitted → default false
 *   16. THROTTLE_RELAXED — 'true' string → boolean true
 *   17. THROTTLE_RELAXED — 'false' string → boolean false
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

describe('validateEnv — CORS_ORIGINS (optional string)', () => {
  it('accepts config without CORS_ORIGINS (field becomes undefined)', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.CORS_ORIGINS).toBeUndefined()
  })

  it('accepts CORS_ORIGINS as a comma-separated string and stores it as-is', () => {
    const env = validateEnv({
      ...BASE_DEV,
      CORS_ORIGINS: 'https://app.cheekycheese.tech,https://cheekycheese.tech',
    })
    expect(env.CORS_ORIGINS).toBe('https://app.cheekycheese.tech,https://cheekycheese.tech')
  })
})

describe('validateEnv — TRUST_PROXY boolean preprocess', () => {
  it("parses string 'true' as boolean true", () => {
    const env = validateEnv({ ...BASE_DEV, TRUST_PROXY: 'true' })
    expect(env.TRUST_PROXY).toBe(true)
  })

  it("parses string 'false' as boolean false", () => {
    const env = validateEnv({ ...BASE_DEV, TRUST_PROXY: 'false' })
    expect(env.TRUST_PROXY).toBe(false)
  })

  it("parses string 'TRUE' (uppercase) as boolean true", () => {
    const env = validateEnv({ ...BASE_DEV, TRUST_PROXY: 'TRUE' })
    expect(env.TRUST_PROXY).toBe(true)
  })

  it('defaults TRUST_PROXY to false when omitted', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.TRUST_PROXY).toBe(false)
  })

  it('accepts boolean true directly (non-string env scenario)', () => {
    const env = validateEnv({ ...BASE_DEV, TRUST_PROXY: true })
    expect(env.TRUST_PROXY).toBe(true)
  })
})

describe('validateEnv — Throttler env-config (Section D)', () => {
  it('THROTTLER_TTL_MS defaults to 60_000 when omitted', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.THROTTLER_TTL_MS).toBe(60_000)
  })

  it('THROTTLER_TTL_MS coerces numeric string to number', () => {
    const env = validateEnv({ ...BASE_DEV, THROTTLER_TTL_MS: '3600000' })
    expect(env.THROTTLER_TTL_MS).toBe(3_600_000)
  })

  it('THROTTLER_TTL_MS below minimum (1_000) throws', () => {
    expect(() => validateEnv({ ...BASE_DEV, THROTTLER_TTL_MS: '500' })).toThrow()
  })

  it('THROTTLER_LIMIT defaults to 100 when omitted', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.THROTTLER_LIMIT).toBe(100)
  })

  it('THROTTLER_LIMIT coerces numeric string to number', () => {
    const env = validateEnv({ ...BASE_DEV, THROTTLER_LIMIT: '2000' })
    expect(env.THROTTLER_LIMIT).toBe(2000)
  })

  it('THROTTLE_RELAXED defaults to false when omitted', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.THROTTLE_RELAXED).toBe(false)
  })

  it("THROTTLE_RELAXED parses string 'true' as boolean true", () => {
    const env = validateEnv({ ...BASE_DEV, THROTTLE_RELAXED: 'true' })
    expect(env.THROTTLE_RELAXED).toBe(true)
  })

  it("THROTTLE_RELAXED parses string 'false' as boolean false", () => {
    const env = validateEnv({ ...BASE_DEV, THROTTLE_RELAXED: 'false' })
    expect(env.THROTTLE_RELAXED).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Section E — S3_USE_SSE + Cloudflare R2 compatibility
//   18. S3_USE_SSE omitted → defaults to false (R2-safe)
//   19. S3_USE_SSE='false' string → boolean false (R2 prod path)
//   20. S3_USE_SSE='true' string → boolean true (AWS S3 path)
//   21. R2 prod config (SSE=false, real creds, R2 endpoint) → valid
//   22. S3_FORCE_PATH_STYLE='false' string → boolean false (R2/AWS prod)
// ---------------------------------------------------------------------------

const BASE_PROD_CREDS = {
  ...BASE_DEV,
  NODE_ENV: 'production',
  AWS_ACCESS_KEY_ID: 'real-r2-access-key-id',
  AWS_SECRET_ACCESS_KEY: 'real-r2-secret-access-key',
  CREDENTIALS_ENC_KEY: VALID_HEX_KEY,
  FRONTEND_URL: 'https://app.cheekycheese.tech',
}

describe('validateEnv — S3_USE_SSE and Cloudflare R2 compatibility (Section E)', () => {
  it('S3_USE_SSE defaults to false when omitted (R2-safe default)', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.S3_USE_SSE).toBe(false)
  })

  it("S3_USE_SSE='false' string is parsed as boolean false", () => {
    const env = validateEnv({ ...BASE_DEV, S3_USE_SSE: 'false' })
    expect(env.S3_USE_SSE).toBe(false)
  })

  it("S3_USE_SSE='true' string is parsed as boolean true (AWS S3 path)", () => {
    const env = validateEnv({ ...BASE_DEV, S3_USE_SSE: 'true' })
    expect(env.S3_USE_SSE).toBe(true)
  })

  it('R2 prod config (SSE=false, real creds, R2 endpoint) passes validation', () => {
    // Cloudflare R2 does not support the SSE-S3 protocol header and encrypts
    // data at rest by default — S3_USE_SSE=false is correct and secure for R2.
    expect(() =>
      validateEnv({
        ...BASE_PROD_CREDS,
        S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
        S3_FORCE_PATH_STYLE: 'false',
        S3_USE_SSE: 'false',
      }),
    ).not.toThrow()
  })

  it('AWS S3 prod config (SSE=true, no custom endpoint) passes validation', () => {
    expect(() =>
      validateEnv({
        ...BASE_PROD_CREDS,
        S3_ENDPOINT: 'https://s3.amazonaws.com',
        S3_FORCE_PATH_STYLE: 'false',
        S3_USE_SSE: 'true',
      }),
    ).not.toThrow()
  })

  it("S3_FORCE_PATH_STYLE='false' string is parsed as boolean false (R2/AWS prod)", () => {
    const env = validateEnv({ ...BASE_DEV, S3_FORCE_PATH_STYLE: 'false' })
    expect(env.S3_FORCE_PATH_STYLE).toBe(false)
  })
})
