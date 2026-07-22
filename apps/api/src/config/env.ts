import { z } from 'zod'

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    API_PORT: z.coerce.number().default(3001),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_CALLBACK_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    SESSION_SECRET: z.string().min(32),
    // AES-256-GCM key for project credential passwords (at-rest encryption).
    // ≥32 chars of entropy; derived to exactly 32 bytes via SHA-256 in
    // CredentialsCryptoService. Generate: `openssl rand -hex 32`.
    // The dev default below is convenience-only — production safety is enforced
    // via refine() (NODE_ENV=production + dev default → throw).
    CREDENTIALS_ENC_KEY: z
      .string()
      .min(32)
      .default('dev-only-credentials-key-change-in-production-0000'),
    // Default — для локального dev (Vite на :3000). В production должен быть задан
    // явно через env (см. refine ниже — пустой default + NODE_ENV=production → ошибка).
    FRONTEND_URL: z.string().min(1).default('http://localhost:3000'),

    // CORS_ORIGINS: comma-separated list of exact allowed origins for CORS.
    // E.g. "https://app.cheekycheese.tech,https://cheekycheese.tech"
    // If unset, falls back to [FRONTEND_URL]. Dev-tunnel regexes (serveo.net)
    // are appended automatically in non-production when this is unset.
    // See parseCorsOrigins() in config/cors.ts for full allowlist build logic.
    CORS_ORIGINS: z.string().optional(),

    // TRUST_PROXY: when true, Fastify trusts X-Forwarded-* headers from the
    // reverse proxy (nginx). Required behind nginx TLS-termination so that
    // rate-limiters and logs see the real client IP (X-Forwarded-For) and
    // the correct protocol (X-Forwarded-Proto). Set to "true" in production.
    TRUST_PROXY: z
      .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
      .default(false),

    // ── Rate-limiting (NestJS ThrottlerModule) ────────────────────────────────
    //
    // THROTTLER_TTL_MS: sliding window length in milliseconds for the global
    //   ThrottlerGuard. Default = 60 000 ms (1 minute) — production value.
    //   Increase in CI/test to widen the window (e.g. 3 600 000 = 1 hour).
    //
    // THROTTLER_LIMIT: maximum request count per IP within THROTTLER_TTL_MS.
    //   Default = 100 — production value.  Increase in CI/test (e.g. 2 000).
    //
    // THROTTLE_RELAXED: when "true" AND NODE_ENV !== "production", per-endpoint
    //   @Throttle() overrides on sensitive write routes (POST /contracts/sign,
    //   POST /tos/accept, POST /contracts/templates, POST /tos,
    //   POST /users/:id/contract/ready) are lifted to match the global limit,
    //   preventing 429 during E2E test suites that onboard many DROP users in
    //   a single 60-second window.
    //
    //   SECURITY GUARDRAIL: THROTTLE_RELAXED is silently ignored when
    //   NODE_ENV === "production" — ThrottlerConfigService enforces this.
    //   Prod operators cannot accidentally weaken rate limits via this flag.
    //   Default = false (strict per-endpoint limits active everywhere).
    THROTTLER_TTL_MS: z.coerce.number().int().min(1_000).default(60_000),
    THROTTLER_LIMIT: z.coerce.number().int().min(1).default(100),
    THROTTLE_RELAXED: z
      .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
      .default(false),

    // S3 / MinIO / Cloudflare R2 (PHASE 6 — Documents).
    // Dev defaults point to local MinIO.
    // AWS_* defaults to 'minioadmin' for local convenience; production safety
    // enforced via refine() below (NODE_ENV=production + minioadmin → throw).
    //
    // Provider matrix:
    //   MinIO (dev)          — endpoint=http://localhost:9000, force-path-style=true,  SSE=false
    //   AWS S3 (prod)        — endpoint omit (AWS default),   force-path-style=false, SSE=true
    //   Cloudflare R2 (prod) — endpoint=https://<id>.r2.cloudflarestorage.com,
    //                          force-path-style=false, SSE=false
    //                          R2 encrypts all data at rest by default (AES-256 managed by
    //                          Cloudflare) without a client-side ServerSideEncryption header —
    //                          setting SSE=false with R2 is correct and does NOT reduce security.
    //
    // Prod: see docs/runbooks/s3-storage.md.
    S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
    // S3_FORCE_PATH_STYLE: true for local MinIO (path-style URLs like
    // http://localhost:9000/bucket/key). AWS S3 and Cloudflare R2 use
    // virtual-hosted style (bucket.host/key) → set to false in prod.
    S3_FORCE_PATH_STYLE: z
      .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
      .default(true),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('crm-documents'),
    // S3_USE_SSE: controls whether PutObject carries the SSE-S3 (AES256) header.
    //   true  — AWS S3: enables server-side encryption via SDK header (free tier).
    //   false — MinIO (dev): MinIO returns `NotImplemented: KMS not configured`
    //           when AES256 is requested without a KMS backend.
    //         — Cloudflare R2 (prod): R2 does not support the SSE-S3 protocol
    //           header and returns an error when it is present. R2 encrypts data
    //           at rest by default, so omitting this header is correct for R2.
    // Default false — safe for both dev/MinIO and R2 prod. Set true only for AWS S3.
    S3_USE_SSE: z
      .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
      .default(false),
    AWS_ACCESS_KEY_ID: z.string().min(1).default('minioadmin'),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).default('minioadmin'),

    // task-vacancies-api: Cloudflare Turnstile secret used to verify the
    // public vacancy-apply endpoint. Default is Cloudflare's documented
    // "always passes" test secret — safe for dev/CI, never for production
    // (TurnstileService logs an error if it detects this default in prod;
    // see EtherscanService for the same pattern with ETHERSCAN_API_KEY).
    TURNSTILE_SECRET_KEY: z.string().min(1).default('1x0000000000000000000000000000000AA'),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.AWS_ACCESS_KEY_ID !== 'minioadmin', {
    message:
      'AWS_ACCESS_KEY_ID must be overridden in production (minioadmin default is for dev/MinIO only)',
    path: ['AWS_ACCESS_KEY_ID'],
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.AWS_SECRET_ACCESS_KEY !== 'minioadmin', {
    message:
      'AWS_SECRET_ACCESS_KEY must be overridden in production (minioadmin default is for dev/MinIO only)',
    path: ['AWS_SECRET_ACCESS_KEY'],
  })
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.CREDENTIALS_ENC_KEY !== 'dev-only-credentials-key-change-in-production-0000',
    {
      message:
        'CREDENTIALS_ENC_KEY must be overridden in production (the dev default leaks all credential passwords). Generate: openssl rand -hex 32',
      path: ['CREDENTIALS_ENC_KEY'],
    },
  )
  .refine(
    (env) => env.NODE_ENV !== 'production' || !env.CREDENTIALS_ENC_KEY.startsWith('change_me'),
    {
      message:
        'CREDENTIALS_ENC_KEY must not use the placeholder value in production (change_me_* prefix detected). Generate: openssl rand -hex 32',
      path: ['CREDENTIALS_ENC_KEY'],
    },
  )

export type Env = z.infer<typeof envSchema>

// Note: FRONTEND_URL default 'http://localhost:3000' допустим только в dev/test.
// В production требуется явное значение env — иначе callback Google OAuth уйдёт на
// localhost вместо реального домена. Reach the refine via validateEnv (raw config).
export function validateEnv(config: Record<string, unknown>): Env {
  if (config.NODE_ENV === 'production' && !config.FRONTEND_URL) {
    throw new Error(
      'Invalid environment variables:\n  FRONTEND_URL: required in production (no default allowed)',
    )
  }
  const result = envSchema.safeParse(config)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment variables:\n${issues}`)
  }
  return result.data
}
