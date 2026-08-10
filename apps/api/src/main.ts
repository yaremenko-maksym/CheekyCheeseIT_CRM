import 'reflect-metadata'
import { ModulesContainer, NestFactory } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { AppModule } from './app.module'
import { ZodExceptionFilter } from './zod-exception.filter'
import { parseCorsOrigins } from './config/cors'
import { registerCspReportContentTypeParser } from './csp-reports/csp-report-content-type-parser'
import { assertJwtAuthGuardsWired } from './auth/jwt-guard-wiring'
import { TelemetryExceptionFilter } from './telemetry/telemetry-exception.filter'

async function bootstrap() {
  const isProd = process.env['NODE_ENV'] === 'production'
  const trustProxy = process.env['TRUST_PROXY'] === 'true'

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: process.env['NODE_ENV'] !== 'test',
      // When behind nginx TLS-termination, trust X-Forwarded-For/X-Forwarded-Proto
      // so rate-limiters and logs see the real client IP and protocol.
      // Set TRUST_PROXY=true in production (reverse-proxy deployment).
      trustProxy,
    }),
  )

  // Authorization wiring gate — runs before ANY middleware/route is set up, so
  // a container that cannot enforce role/archive revocation never reaches
  // `listen()`. Throws (→ non-zero exit, no traffic served) rather than warns:
  // the failure it guards against is silent by nature and can only be observed
  // in the compiled artifact. See auth/jwt-guard-wiring.ts.
  assertJwtAuthGuardsWired(app.get(ModulesContainer))

  await app.register(helmet, {
    // In development CSP is disabled for easier debugging (hot-reload, devtools).
    // In production an explicit policy is applied:
    //   script-src 'self'          — no inline scripts, no CDN
    //   frame-src 'self' blob:     — allow blob: for PDF viewer iframe
    //   img-src 'self' data:       — allow inline data: images (avatars, logos)
    //   font-src 'self'            — self-hosted fonts only
    //   connect-src 'self'         — XHR/fetch to same origin only
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            // CSP: img-src allows https: because DocumentImage (<img src={presignedR2Url}>)
            // fetches presigned R2/S3 thumbnails and full-res previews directly as <img>,
            // not via fetch(). Narrowing to a specific R2 hostname is fragile (env-specific
            // endpoint, changes per deployment). All other directives remain tightly scoped.
            imgSrc: ["'self'", 'data:', 'https:', 'https://api.dicebear.com'],
            fontSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameSrc: ["'self'", 'blob:'],
            objectSrc: ["'self'", 'blob:'],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"], // clickjacking defense (#100 MED-1)
            formAction: ["'self'"], // restrict form submissions to same origin (#100 LOW-1)
          },
        }
      : false,
  })

  await app.register(cookie, {
    secret: process.env['SESSION_SECRET'] ?? '',
  })

  // Multipart uploads for /api/documents. Hard cap = 10 MB (DOCUMENT_MAX_BYTES
  // from @crm/shared); the controller also re-checks via Zod to surface a
  // clean 413 message instead of Fastify's generic 413.
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB
      files: 1,
    },
  })

  // task-csp-reports-and-flip: browser CSP violation reports arrive as
  // application/csp-report or application/reports+json — Fastify has no
  // built-in parser for either (see that file's own doc comment for the
  // 32 KB per-route body limit rationale).
  registerCspReportContentTypeParser(app)

  // Build CORS origin allowlist from env:
  //  - CORS_ORIGINS set → use as exact multi-origin allowlist (no dev-tunnel regexes)
  //  - CORS_ORIGINS unset → fallback to [FRONTEND_URL]
  //  - In non-production without CORS_ORIGINS → also append serveo.net dev-tunnel regexes
  const corsOrigins = parseCorsOrigins({
    corsOrigins: process.env['CORS_ORIGINS'],
    frontendUrl: process.env['FRONTEND_URL'] ?? 'http://localhost:3000',
    isProduction: isProd,
  })

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })

  // task-telemetry-api: TelemetryExceptionFilter (catch-all, 5xx/unhandled →
  // telemetry_errors) MUST be registered FIRST when combined with a
  // type-specific filter, so ZodExceptionFilter still wins for ZodError —
  // see that Nest docs section "Catch everything" / TelemetryExceptionFilter's
  // own doc comment. Resolved via `app.get()` (not `new`) so its
  // TelemetryErrorsService dependency is the real DI-wired instance.
  app.useGlobalFilters(app.get(TelemetryExceptionFilter), new ZodExceptionFilter())
  app.setGlobalPrefix('api')
  app.enableShutdownHooks()

  const port = process.env['API_PORT'] ?? 3001
  await app.listen(port, '0.0.0.0')
}

bootstrap()
