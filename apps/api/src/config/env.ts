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

    // task-google-indexing-api: Google Indexing API service-account credentials
    // used to push near-instant PUBLISHED/CLOSED notifications for vacancy
    // JobPosting pages (Google Jobs freshness). BOTH optional and left unset
    // in dev/CI on purpose — GoogleIndexingService detects the gap at
    // construction and runs in a no-op mode with a single boot warning
    // (never blocks vacancy publish/close). See apps/api/.env.example for the
    // provisioning runbook pointer.
    GOOGLE_INDEXING_SA_EMAIL: z.string().optional(),
    // Base64-encoded PEM private key for the same service account (RS256 JWT
    // signing, see GoogleIndexingService). Decoded once at construction time
    // — never logged.
    GOOGLE_INDEXING_SA_KEY_B64: z.string().optional(),

    // Origin used to build the public vacancy URL sent to the Google
    // Indexing API: `<origin>/careers/<slug>/` — trailing slash required,
    // matches how apps/landing canonicalizes the careers route. Defaults to
    // the production landing domain; override only for non-standard deploys.
    PUBLIC_LANDING_ORIGIN: z.string().url().default('https://cheekycheese.tech'),

    // task-telemetry-api: shared secret checked against the `X-Telemetry-Token`
    // header on GET /api/telemetry/digest (constant-time compare — see
    // TelemetryDigestTokenGuard). Consumed hourly/weekly by
    // .github/workflows/telemetry-digest.yml. Same refine()-guarded-default
    // pattern as TURNSTILE_SECRET_KEY: safe dev/CI default, hard-blocked in
    // production. Generate: `openssl rand -hex 32`.
    TELEMETRY_DIGEST_TOKEN: z
      .string()
      .min(32)
      .default('dev-only-telemetry-digest-token-change-in-production-0000'),
    // task-telemetry-api: secret input to the daily salt used to derive
    // `telemetry_events.session_hash` (sha256(userId + sha256(secret + UTC
    // date))) — see apps/api/src/telemetry/session-hash.ts. Never persisted,
    // never exposed to the client. Same dev-default + prod-refine pattern.
    // Generate: `openssl rand -hex 32`.
    TELEMETRY_SESSION_SALT: z
      .string()
      .min(32)
      .default('dev-only-telemetry-session-salt-change-in-production-0000'),

    // task-landing-contact-and-hiring-strip: Resend HTTP API key for the
    // public "Start a project" contact form (POST /api/public/contact).
    // Deliberately OPTIONAL with NO default (unlike TURNSTILE_SECRET_KEY /
    // TELEMETRY_*) — the owner does not have a real key yet. Left unset,
    // `ResendMailerService` boots fine (one warning log) and
    // `ContactController` responds 503 with the `CONTACT_PUBLIC_EMAIL`
    // fallback instead of ever attempting to send. See that service's module
    // doc for the full contract.
    RESEND_API_KEY: z.string().min(1).optional(),
    // "From" address Resend sends contact-form emails as. Must be a verified
    // sender/domain in the Resend account (provisioning is a devops task, see
    // apps/api/.env.example).
    CONTACT_FROM_EMAIL: z.email().default('site@cheekycheese.tech'),
    // Visible fallback address shown to visitors (landing UI + the 502/503
    // error copy below) when the form itself is unavailable or fails.
    CONTACT_PUBLIC_EMAIL: z.email().default('hr@cheekycheese.tech'),

    // task-resume-base: Cloudflare Workers AI credentials used ONCE per resume
    // upload to turn extracted text into structured content. Same
    // deliberately-OPTIONAL-with-no-default pattern as RESEND_API_KEY: left
    // unset (dev/CI, and any deploy where the secrets are absent) the API boots
    // fine, `ResumeAiService` logs one warning and reports
    // `AI_NOT_CONFIGURED`, and the resume form stays fully usable by hand —
    // never a boot failure, never a silent live call in tests.
    // Both secrets already exist in GitHub and are wired into
    // .github/workflows/deploy.yml (PR #494).
    CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
    CLOUDFLARE_AI_TOKEN: z.string().min(1).optional(),
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
  // sec MED-1 / F2: TurnstileService previously only LOGGED an error when the
  // dev "always passes" default reached production — the app still booted
  // and the public vacancy-apply endpoint accepted ANY token (fail-open).
  // Mirrors the AWS_ACCESS_KEY_ID refine() above — fail-fast boot instead.
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.TURNSTILE_SECRET_KEY !== '1x0000000000000000000000000000000AA',
    {
      message:
        'TURNSTILE_SECRET_KEY must be overridden in production (the default is Cloudflare\'s "always passes" test secret — leaving it set disables anti-bot protection on the public vacancy-apply endpoint)',
      path: ['TURNSTILE_SECRET_KEY'],
    },
  )
  // task-telemetry-api: the dev default is public (checked into this file) —
  // leaving it in production would let anyone read the digest endpoint
  // (error stacks + userId/role context) with no real auth.
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.TELEMETRY_DIGEST_TOKEN !== 'dev-only-telemetry-digest-token-change-in-production-0000',
    {
      message:
        'TELEMETRY_DIGEST_TOKEN must be overridden in production (the dev default is public — leaving it set lets anyone read GET /api/telemetry/digest). Generate: openssl rand -hex 32',
      path: ['TELEMETRY_DIGEST_TOKEN'],
    },
  )
  // task-telemetry-api: the dev default is public — leaving it in production
  // would let anyone reconstruct a real user's daily session_hash (defeats
  // the whole point of hashing instead of storing the raw userId).
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.TELEMETRY_SESSION_SALT !== 'dev-only-telemetry-session-salt-change-in-production-0000',
    {
      message:
        'TELEMETRY_SESSION_SALT must be overridden in production (the dev default is public — leaving it set defeats session_hash privacy). Generate: openssl rand -hex 32',
      path: ['TELEMETRY_SESSION_SALT'],
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
