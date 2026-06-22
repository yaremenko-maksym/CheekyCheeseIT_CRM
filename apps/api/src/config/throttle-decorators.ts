import { Throttle } from '@nestjs/throttler'

/**
 * throttle-decorators.ts — env-aware @Throttle() helpers.
 *
 * ── Prod-safety contract ───────────────────────────────────────────────────
 *
 * These helpers read THROTTLE_RELAXED and NODE_ENV from process.env at
 * *request time* (not module init), so they reflect the runtime value of the
 * flag without DI complexity.
 *
 * SECURITY GUARDRAIL:
 *   - When NODE_ENV === 'production', THROTTLE_RELAXED is SILENTLY IGNORED.
 *     The hardened prod limits (10 / 5 req/min) are always applied in prod
 *     regardless of what the flag is set to.
 *   - In non-production (development, test) THROTTLE_RELAXED=true raises
 *     per-endpoint limits to the global ceiling (THROTTLER_LIMIT, default 100).
 *   - No env combination can lower limits BELOW the prod hardened value; the
 *     flag only *raises* limits and only *outside* production.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   // Before (hard-coded):
 *   @Throttle({ default: { limit: 10, ttl: 60_000 } })
 *
 *   // After (env-aware):
 *   @SensitiveWriteThrottle()
 *
 *   // Admin writes (5 req/min hardened):
 *   @AdminWriteThrottle()
 */

/** Returns true only when running outside production with the relaxed flag set. */
function isRelaxed(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.THROTTLE_RELAXED === 'true'
}

/**
 * Global limit ceiling — mirrors THROTTLER_LIMIT env var with the same default
 * as ThrottlerModule (100 req/min). Used as the relaxed cap.
 */
function globalLimit(): number {
  const raw = process.env.THROTTLER_LIMIT
  if (!raw) return 100
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100
}

/**
 * Global TTL — mirrors THROTTLER_TTL_MS env var with the same default as
 * ThrottlerModule (60 000 ms). Used alongside the relaxed cap.
 */
function globalTtl(): number {
  const raw = process.env.THROTTLER_TTL_MS
  if (!raw) return 60_000
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 60_000
}

/**
 * @SensitiveWriteThrottle()
 *
 * For sensitive user-facing write endpoints (POST /contracts/sign, POST /tos/accept).
 * Hardened prod limit: 10 req/min. Relaxed (non-prod + THROTTLE_RELAXED=true): global limit.
 */
export function SensitiveWriteThrottle(): MethodDecorator {
  const limit = isRelaxed() ? globalLimit() : 10
  const ttl = isRelaxed() ? globalTtl() : 60_000
  return Throttle({ default: { limit, ttl } })
}

/**
 * @AdminWriteThrottle()
 *
 * For admin write endpoints (POST /contracts/templates, POST /tos (publish)).
 * Hardened prod limit: 5 req/min. Relaxed (non-prod + THROTTLE_RELAXED=true): global limit.
 */
export function AdminWriteThrottle(): MethodDecorator {
  const limit = isRelaxed() ? globalLimit() : 5
  const ttl = isRelaxed() ? globalTtl() : 60_000
  return Throttle({ default: { limit, ttl } })
}
