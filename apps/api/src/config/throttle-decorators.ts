import { Throttle } from '@nestjs/throttler'

/**
 * throttle-decorators.ts — env-aware @Throttle() helpers.
 *
 * ── Prod-safety contract ───────────────────────────────────────────────────
 *
 * These helpers use the Resolvable<number> form of @Throttle() — the limit
 * callback is invoked on EVERY request (not once at module init), so the
 * env variables are read at request time. This means:
 *
 *   - In production: NODE_ENV==='production' is checked per-request, and
 *     THROTTLE_RELAXED is SILENTLY IGNORED — the hardened prod limits
 *     (10 / 5 req/min) always apply.
 *   - In non-production (development, test): THROTTLE_RELAXED=true raises
 *     per-endpoint limits to the global ceiling (THROTTLER_LIMIT, default 100).
 *   - No env combination can lower limits BELOW the prod hardened value; the
 *     flag only *raises* limits and only *outside* production.
 *
 * ── Why Resolvable instead of static evaluation ────────────────────────────
 *
 * @Throttle({ default: { limit: <function>, ttl: <function> } }) calls the
 * function on each request, so the env read happens at runtime. This makes
 * the decorator testable — tests can set process.env before calling the
 * endpoint, and the decorator will pick up the new value.
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

/**
 * Returns true only when running outside production with the relaxed flag set.
 * Called per-request so env changes in tests are picked up immediately.
 */
function isRelaxed(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.THROTTLE_RELAXED === 'true'
}

/**
 * Global limit ceiling — mirrors THROTTLER_LIMIT env var with the same default
 * as ThrottlerModule (100 req/min). Used as the relaxed cap.
 * Called per-request.
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
 * Called per-request.
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
 *
 * The limit and ttl are Resolvable functions — evaluated per-request so that
 * THROTTLE_RELAXED changes in test environments are reflected immediately.
 */
export function SensitiveWriteThrottle(): MethodDecorator {
  return Throttle({
    default: {
      limit: () => (isRelaxed() ? globalLimit() : 10),
      ttl: () => (isRelaxed() ? globalTtl() : 60_000),
    },
  })
}

/**
 * @AdminWriteThrottle()
 *
 * For admin write endpoints (POST /contracts/templates, POST /tos (publish)).
 * Hardened prod limit: 5 req/min. Relaxed (non-prod + THROTTLE_RELAXED=true): global limit.
 *
 * The limit and ttl are Resolvable functions — evaluated per-request.
 */
export function AdminWriteThrottle(): MethodDecorator {
  return Throttle({
    default: {
      limit: () => (isRelaxed() ? globalLimit() : 5),
      ttl: () => (isRelaxed() ? globalTtl() : 60_000),
    },
  })
}
