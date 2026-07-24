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
        TURNSTILE_SECRET_KEY: 'real-cloudflare-turnstile-secret',
        // task-telemetry-api: real prod values — this test predates
        // TELEMETRY_DIGEST_TOKEN/TELEMETRY_SESSION_SALT's own prod-refine
        // (Section H) and would otherwise now throw on THEIR dev defaults.
        TELEMETRY_DIGEST_TOKEN: 'real-telemetry-digest-token-not-the-dev-default-000',
        TELEMETRY_SESSION_SALT: 'real-telemetry-session-salt-not-the-dev-default-000',
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
  TURNSTILE_SECRET_KEY: 'real-cloudflare-turnstile-secret',
  // task-telemetry-api (Section H below) — real prod values so pre-existing
  // "allows ... in production" tests elsewhere in this file (which spread
  // BASE_PROD_CREDS without overriding these two) don't newly throw.
  TELEMETRY_DIGEST_TOKEN: 'real-telemetry-digest-token-not-the-dev-default-000',
  TELEMETRY_SESSION_SALT: 'real-telemetry-session-salt-not-the-dev-default-000',
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

// ---------------------------------------------------------------------------
// Section F — TURNSTILE_SECRET_KEY fail-closed (sec MED-1 / F2, task-fix-pr-390)
//   23. dev dummy "always passes" secret in production → throw
//   24. omitted in production (falls back to the dummy default) → throw
//   25. dev dummy secret in development → ok (convenience default)
//   26. a real secret in production → ok
// ---------------------------------------------------------------------------

const TURNSTILE_DEV_DUMMY = '1x0000000000000000000000000000000AA'

describe('validateEnv — TURNSTILE_SECRET_KEY fail-closed (Section F)', () => {
  it('throws in production when TURNSTILE_SECRET_KEY is the dev dummy "always passes" secret', () => {
    expect(() =>
      validateEnv({
        ...BASE_PROD_CREDS,
        TURNSTILE_SECRET_KEY: TURNSTILE_DEV_DUMMY,
      }),
    ).toThrow(/TURNSTILE_SECRET_KEY/)
  })

  it('throws in production when TURNSTILE_SECRET_KEY is omitted (falls back to the dummy default)', () => {
    const { TURNSTILE_SECRET_KEY: _omit, ...withoutTurnstile } = BASE_PROD_CREDS as Record<
      string,
      unknown
    >
    expect(() => validateEnv(withoutTurnstile)).toThrow(/TURNSTILE_SECRET_KEY/)
  })

  it('allows the dev dummy secret in development (convenience default)', () => {
    expect(() =>
      validateEnv({
        ...BASE_DEV,
        TURNSTILE_SECRET_KEY: TURNSTILE_DEV_DUMMY,
      }),
    ).not.toThrow()
  })

  it('allows a real TURNSTILE_SECRET_KEY in production', () => {
    expect(() => validateEnv({ ...BASE_PROD_CREDS })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Section H — task-telemetry-api: TELEMETRY_DIGEST_TOKEN / TELEMETRY_SESSION_SALT
// fail-closed (same refine()-guarded-default pattern as TURNSTILE_SECRET_KEY,
// Section F above)
//   32. dev default TELEMETRY_DIGEST_TOKEN in production → throw
//   33. TELEMETRY_DIGEST_TOKEN omitted in production (falls back to the dev
//       default) → throw
//   34. dev default TELEMETRY_DIGEST_TOKEN in development → ok
//   35. dev default TELEMETRY_SESSION_SALT in production → throw
//   36. TELEMETRY_SESSION_SALT omitted in production (falls back to the dev
//       default) → throw
//   37. dev default TELEMETRY_SESSION_SALT in development → ok
//   38. both real values in production → ok
// ---------------------------------------------------------------------------

const TELEMETRY_DIGEST_TOKEN_DEV_DEFAULT =
  'dev-only-telemetry-digest-token-change-in-production-0000'
const TELEMETRY_SESSION_SALT_DEV_DEFAULT =
  'dev-only-telemetry-session-salt-change-in-production-0000'

describe('validateEnv — TELEMETRY_DIGEST_TOKEN / TELEMETRY_SESSION_SALT fail-closed (Section H)', () => {
  it('throws in production when TELEMETRY_DIGEST_TOKEN is the dev default', () => {
    expect(() =>
      validateEnv({
        ...BASE_PROD_CREDS,
        TELEMETRY_DIGEST_TOKEN: TELEMETRY_DIGEST_TOKEN_DEV_DEFAULT,
      }),
    ).toThrow(/TELEMETRY_DIGEST_TOKEN/)
  })

  it('throws in production when TELEMETRY_DIGEST_TOKEN is omitted (falls back to the dev default)', () => {
    const { TELEMETRY_DIGEST_TOKEN: _omit, ...rest } = BASE_PROD_CREDS as Record<string, unknown>
    expect(() => validateEnv(rest)).toThrow(/TELEMETRY_DIGEST_TOKEN/)
  })

  it('allows the dev default TELEMETRY_DIGEST_TOKEN in development', () => {
    expect(() =>
      validateEnv({ ...BASE_DEV, TELEMETRY_DIGEST_TOKEN: TELEMETRY_DIGEST_TOKEN_DEV_DEFAULT }),
    ).not.toThrow()
  })

  it('throws in production when TELEMETRY_SESSION_SALT is the dev default', () => {
    expect(() =>
      validateEnv({
        ...BASE_PROD_CREDS,
        TELEMETRY_SESSION_SALT: TELEMETRY_SESSION_SALT_DEV_DEFAULT,
      }),
    ).toThrow(/TELEMETRY_SESSION_SALT/)
  })

  it('throws in production when TELEMETRY_SESSION_SALT is omitted (falls back to the dev default)', () => {
    const { TELEMETRY_SESSION_SALT: _omit, ...rest } = BASE_PROD_CREDS as Record<string, unknown>
    expect(() => validateEnv(rest)).toThrow(/TELEMETRY_SESSION_SALT/)
  })

  it('allows the dev default TELEMETRY_SESSION_SALT in development', () => {
    expect(() =>
      validateEnv({ ...BASE_DEV, TELEMETRY_SESSION_SALT: TELEMETRY_SESSION_SALT_DEV_DEFAULT }),
    ).not.toThrow()
  })

  it('allows real TELEMETRY_DIGEST_TOKEN + TELEMETRY_SESSION_SALT values in production', () => {
    expect(() => validateEnv({ ...BASE_PROD_CREDS })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Section G — task-google-indexing-api: GOOGLE_INDEXING_SA_* (optional,
// AC2 no-op) + PUBLIC_LANDING_ORIGIN (defaulted)
//   27. both GOOGLE_INDEXING_SA_* omitted → ok, both undefined
//   28. both provided → stored as-is
//   29. PUBLIC_LANDING_ORIGIN omitted → defaults to the prod landing domain
//   30. PUBLIC_LANDING_ORIGIN provided → overrides the default
//   31. PUBLIC_LANDING_ORIGIN — not a valid URL → throw
// ---------------------------------------------------------------------------

describe('validateEnv — Google Indexing API env (Section G)', () => {
  it('GOOGLE_INDEXING_SA_EMAIL / GOOGLE_INDEXING_SA_KEY_B64 default to undefined when omitted', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.GOOGLE_INDEXING_SA_EMAIL).toBeUndefined()
    expect(env.GOOGLE_INDEXING_SA_KEY_B64).toBeUndefined()
  })

  it('accepts both GOOGLE_INDEXING_SA_* when provided', () => {
    const env = validateEnv({
      ...BASE_DEV,
      GOOGLE_INDEXING_SA_EMAIL: 'sa@my-project.iam.gserviceaccount.com',
      GOOGLE_INDEXING_SA_KEY_B64: 'ZmFrZS1wZW0tYmFzZTY0',
    })
    expect(env.GOOGLE_INDEXING_SA_EMAIL).toBe('sa@my-project.iam.gserviceaccount.com')
    expect(env.GOOGLE_INDEXING_SA_KEY_B64).toBe('ZmFrZS1wZW0tYmFzZTY0')
  })

  it('PUBLIC_LANDING_ORIGIN defaults to https://cheekycheese.tech when omitted', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.PUBLIC_LANDING_ORIGIN).toBe('https://cheekycheese.tech')
  })

  it('PUBLIC_LANDING_ORIGIN can be overridden (e.g. a staging deploy)', () => {
    const env = validateEnv({
      ...BASE_DEV,
      PUBLIC_LANDING_ORIGIN: 'https://staging.cheekycheese.tech',
    })
    expect(env.PUBLIC_LANDING_ORIGIN).toBe('https://staging.cheekycheese.tech')
  })

  it('PUBLIC_LANDING_ORIGIN — an invalid URL throws', () => {
    expect(() => validateEnv({ ...BASE_DEV, PUBLIC_LANDING_ORIGIN: 'not-a-url' })).toThrow()
  })
})
