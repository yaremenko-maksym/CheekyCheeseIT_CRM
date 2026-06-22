import { Throttle } from '@nestjs/throttler'

/**
 * throttle-decorators.ts — env-aware @Throttle() helpers.
 *
 * ── Single source of truth for throttler limits ─────────────────────────────
 *
 * This file is the SOLE implementation of per-endpoint throttler limits and
 * the THROTTLE_RELAXED guardrail.  There is no other class, service, or module
 * that duplicates this logic.  All per-endpoint @Throttle() overrides in every
 * controller MUST use the decorator factories exported here — never inline
 * hard-coded numbers.
 *
 * ── Why certain routes carry strict per-endpoint limits ─────────────────────
 *
 * The following write routes are sensitive to automated abuse:
 *   • POST /api/contracts/sign              — SENSITIVE_WRITE_LIMIT req/min
 *   • POST /api/tos/accept                  — SENSITIVE_WRITE_LIMIT req/min
 *   • POST /api/contracts/templates         — ADMIN_WRITE_LIMIT req/min
 *   • POST /api/tos (publish)               — ADMIN_WRITE_LIMIT req/min
 *   • PATCH /api/company-account/wallet     — WALLET_UPDATE_LIMIT req/min  (M2: rare admin op)
 *   • POST  /api/company-account/deposits   — DEPOSIT_LIMIT req/min        (M2: money-write)
 *   • POST  /api/company-account/dividends  — DIVIDEND_LIMIT req/min       (M2: rare money-out op)
 *   • POST /api/users/:id/contract/ready    — falls back to global
 *
 * In CI E2E suites (rbac-matrix-smoke, drop-role-end-to-end,
 * pending-settlement) each test onboards one or more DROP users, each
 * consuming 3–5 of those limited calls, within a single 60-second window.
 * Two tests × onboarding cascade = 6–10 sign/tos calls from one IP → 429.
 *
 * ── Prod-safety contract ───────────────────────────────────────────────────
 *
 * These helpers use the Resolvable<number> form of @Throttle() — the limit
 * callback is invoked on EVERY request (not once at module init), so the
 * env variables are read at request time. This means:
 *
 *   - In production: NODE_ENV==='production' is checked per-request, and
 *     THROTTLE_RELAXED is SILENTLY IGNORED — the hardened prod limits
 *     always apply.
 *   - In non-production (development, test): THROTTLE_RELAXED=true raises
 *     per-endpoint limits to the global ceiling (THROTTLER_LIMIT, default
 *     GLOBAL_LIMIT_DEFAULT).
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
 * ── Why process.env (not ConfigService) ───────────────────────────────────
 *
 * Decorator factories are static — they execute at class decoration time
 * (module init), not inside the DI container.  The Resolvable callbacks ARE
 * called at request time, but they are plain functions, not methods of an
 * injectable class.  DI is therefore unavailable here.  Reading process.env
 * directly is the only viable approach for Resolvable throttle callbacks.
 * Note: any non-'production' value for NODE_ENV (including undefined) falls
 * through to the relaxed check — this is intentional fail-safe behaviour
 * (strict prod limits apply only when we're certain we're in production).
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   // Before (hard-coded, NOT env-aware):
 *   @Throttle({ default: { limit: 10, ttl: 60_000 } })
 *
 *   // After (env-aware, DRY — all via RelaxableThrottle):
 *   @SensitiveWriteThrottle()       // SENSITIVE_WRITE_LIMIT prod cap
 *   @AdminWriteThrottle()           // ADMIN_WRITE_LIMIT prod cap
 *   @RelaxableThrottle(5)           // custom prod cap, same guardrail
 */

// ── Prod-hardened limits (named constants — never magic numbers) ─────────────

/** Prod cap for sensitive user writes (sign / tos accept). Hardcoded — never lowerable via env. */
export const SENSITIVE_WRITE_LIMIT = 10

/** Prod cap for admin write operations (publish template / tos). Hardcoded — never lowerable via env. */
export const ADMIN_WRITE_LIMIT = 5

/**
 * Prod cap for wallet address update (PATCH /company-account/wallet).
 * M2: rare admin op — tighten vs global 100/min. Never lowerable via env.
 */
export const WALLET_UPDATE_LIMIT = 5

/**
 * Prod cap for company deposit submissions (POST /company-account/deposits).
 * M2: money-write op — tighten vs global 100/min. Never lowerable via env.
 */
export const DEPOSIT_LIMIT = 12

/**
 * Prod cap for dividend creation (POST /company-account/dividends).
 * M2: rare money-out op — tighten vs global 100/min. Never lowerable via env.
 */
export const DIVIDEND_LIMIT = 5

/** Default global request cap when THROTTLER_LIMIT is unset. Mirrors ThrottlerModule default in app.module.ts. */
export const GLOBAL_LIMIT_DEFAULT = 100

/** Default sliding-window TTL (ms) when THROTTLER_TTL_MS is unset. Mirrors ThrottlerModule default in app.module.ts. */
export const GLOBAL_TTL_DEFAULT_MS = 60_000

// ── Private helpers (called per-request via Resolvable) ─────────────────────

/**
 * Returns true only when running outside production with the relaxed flag set.
 * Called per-request so env changes in tests are picked up immediately.
 *
 * SECURITY GUARDRAIL: returns false unconditionally when NODE_ENV==='production'.
 * This is the SINGLE authoritative relax-check — ALL throttle factories in this
 * file delegate here.  There is no other implementation of this logic in the
 * codebase.
 */
function isRelaxed(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.THROTTLE_RELAXED === 'true'
}

/**
 * Global limit ceiling — mirrors THROTTLER_LIMIT env var with the same default
 * as ThrottlerModule (GLOBAL_LIMIT_DEFAULT req/min). Used as the relaxed cap.
 * Called per-request.
 */
function globalLimit(): number {
  const raw = process.env.THROTTLER_LIMIT
  if (!raw) return GLOBAL_LIMIT_DEFAULT
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GLOBAL_LIMIT_DEFAULT
}

/**
 * Global TTL — mirrors THROTTLER_TTL_MS env var with the same default as
 * ThrottlerModule (GLOBAL_TTL_DEFAULT_MS). Used alongside the relaxed cap.
 * Called per-request.
 */
function globalTtl(): number {
  const raw = process.env.THROTTLER_TTL_MS
  if (!raw) return GLOBAL_TTL_DEFAULT_MS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : GLOBAL_TTL_DEFAULT_MS
}

// ── Exported decorator factories ────────────────────────────────────────────

/**
 * @RelaxableThrottle(prodLimit, ttlMs?)
 *
 * Parametric env-aware throttle factory — the single shared mechanism behind
 * all per-endpoint limit decorators.  Apply directly when neither
 * SensitiveWriteThrottle nor AdminWriteThrottle captures the semantic.
 *
 * Prod-safety contract (same as all other factories in this file):
 *   - prodLimit is ALWAYS applied when NODE_ENV==='production', regardless of
 *     THROTTLE_RELAXED.
 *   - Outside production with THROTTLE_RELAXED=true: limit is raised to
 *     globalLimit() (THROTTLER_LIMIT env var, default GLOBAL_LIMIT_DEFAULT).
 *   - No env combination can lower the limit below prodLimit.
 *
 * @param prodLimit  Hard cap that applies unconditionally in production.
 * @param ttlMs      Sliding-window duration in ms (default: GLOBAL_TTL_DEFAULT_MS = 60_000).
 */
export function RelaxableThrottle(prodLimit: number, ttlMs: number = GLOBAL_TTL_DEFAULT_MS): MethodDecorator {
  return Throttle({
    default: {
      limit: () => (isRelaxed() ? globalLimit() : prodLimit),
      ttl: () => (isRelaxed() ? globalTtl() : ttlMs),
    },
  })
}

/**
 * @SensitiveWriteThrottle()
 *
 * For sensitive user-facing write endpoints (POST /contracts/sign, POST /tos/accept).
 * Hardened prod limit: SENSITIVE_WRITE_LIMIT req/min. Relaxed (non-prod + THROTTLE_RELAXED=true): global limit.
 *
 * Implemented via RelaxableThrottle — single source for the relax guardrail.
 */
export function SensitiveWriteThrottle(): MethodDecorator {
  return RelaxableThrottle(SENSITIVE_WRITE_LIMIT)
}

/**
 * @AdminWriteThrottle()
 *
 * For admin write endpoints (POST /contracts/templates, POST /tos (publish)).
 * Hardened prod limit: ADMIN_WRITE_LIMIT req/min. Relaxed (non-prod + THROTTLE_RELAXED=true): global limit.
 *
 * Implemented via RelaxableThrottle — single source for the relax guardrail.
 */
export function AdminWriteThrottle(): MethodDecorator {
  return RelaxableThrottle(ADMIN_WRITE_LIMIT)
}
