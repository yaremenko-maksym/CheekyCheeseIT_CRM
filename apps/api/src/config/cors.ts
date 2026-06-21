/**
 * CORS origin allowlist builder.
 *
 * Security rules:
 *  - Dev-tunnel regexes (*.serveo.net, *.serveousercontent.com) are ONLY
 *    included in non-production environments when no explicit CORS_ORIGINS list
 *    is provided. In production they must never appear — only the explicit
 *    allowlist from CORS_ORIGINS (or the single FRONTEND_URL fallback) is used.
 *  - When CORS_ORIGINS is set (non-empty after filtering), it takes full
 *    precedence over FRONTEND_URL and no tunnel regexes are appended regardless
 *    of NODE_ENV.
 */

/** Dev-tunnel regex patterns — serveo.net and serveousercontent.com tunnels. */
const DEV_TUNNEL_REGEXES: RegExp[] = [/\.serveo\.net$/, /\.serveousercontent\.com$/]

/**
 * Parameters for CORS origin list construction.
 */
export interface ParseCorsOriginsOptions {
  /** Raw value of the CORS_ORIGINS env variable (comma-separated). May be undefined or empty. */
  corsOrigins: string | undefined
  /** Value of FRONTEND_URL env variable — used as single-origin fallback. */
  frontendUrl: string
  /** Whether the app is running in production (NODE_ENV === 'production'). */
  isProduction: boolean
}

/**
 * Builds the CORS `origin` allowlist for Fastify/NestJS `enableCors`.
 *
 * Returns an array of strings (exact match) and/or RegExp (pattern match).
 * NestJS `enableCors` accepts `(string | RegExp)[]` natively.
 *
 * Logic:
 *   1. Parse CORS_ORIGINS → trim + filter empty segments.
 *   2. If result is non-empty  → use as exact allowlist (no tunnel regexes ever).
 *   3. If result is empty/unset → fallback to [FRONTEND_URL].
 *      - In production: no tunnel regexes appended.
 *      - In development: append DEV_TUNNEL_REGEXES for serveo tunnels.
 */
export function parseCorsOrigins(options: ParseCorsOriginsOptions): (string | RegExp)[] {
  const { corsOrigins, frontendUrl, isProduction } = options

  // Parse CORS_ORIGINS: split by comma, trim, filter empty strings
  const parsedOrigins =
    corsOrigins
      ?.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0) ?? []

  if (parsedOrigins.length > 0) {
    // Explicit allowlist — use as-is, no tunnel regexes
    return parsedOrigins
  }

  // Fallback: single FRONTEND_URL
  const origins: (string | RegExp)[] = [frontendUrl]

  // Dev-tunnel regexes only in non-production
  if (!isProduction) {
    origins.push(...DEV_TUNNEL_REGEXES)
  }

  return origins
}
