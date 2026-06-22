import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from './env'

/**
 * ThrottlerConfigService — resolves per-endpoint @Throttle() parameters,
 * honouring the THROTTLE_RELAXED env flag in non-production environments.
 *
 * ── Why this service exists ────────────────────────────────────────────────
 *
 * Certain write routes carry strict per-endpoint limits that prevent automated
 * abuse:
 *   • POST /api/contracts/sign       — 10 req/min
 *   • POST /api/tos/accept           — 10 req/min
 *   • POST /api/contracts/templates  — 5  req/min
 *   • POST /api/tos (publish)        — 5  req/min
 *   • POST /api/users/:id/contract/ready — falls back to global
 *
 * In CI E2E suites (rbac-matrix-smoke, drop-role-end-to-end,
 * pending-settlement) each test onboards one or more DROP users, each
 * consuming 3–5 of those limited calls, within a single 60-second window.
 * Two tests × onboarding cascade = 6–10 sign/tos calls from one IP → 429.
 *
 * ── Mechanism ──────────────────────────────────────────────────────────────
 *
 * When THROTTLE_RELAXED=true AND NODE_ENV !== 'production':
 *   sensitiveWriteLimit()  returns the GLOBAL limit (THROTTLER_LIMIT, default 100)
 *   adminWriteLimit()      returns the GLOBAL limit
 *
 * When THROTTLE_RELAXED is false (default) OR NODE_ENV === 'production':
 *   sensitiveWriteLimit()  returns 10  (current prod value)
 *   adminWriteLimit()      returns 5   (current prod value)
 *
 * ── Security guardrail ─────────────────────────────────────────────────────
 *
 * THROTTLE_RELAXED is SILENTLY IGNORED in production (NODE_ENV==='production').
 * Even if an operator accidentally sets THROTTLE_RELAXED=true in their prod
 * .env, the isRelaxed() getter returns false, and all per-endpoint limits
 * remain at their hardened values. There is no way to lower prod rate-limits
 * via this flag.
 */
@Injectable()
export class ThrottlerConfigService {
  /** Prod cap for sensitive user writes (sign/tos). Hardcoded — never lowerable. */
  static readonly PROD_SENSITIVE_LIMIT = 10

  /** Prod cap for admin write operations (publish template/tos). Hardcoded. */
  static readonly PROD_ADMIN_LIMIT = 5

  /** Minimum TTL (ms) used alongside per-endpoint limits. Matches global TTL. */
  readonly ttl: number

  /** Global request cap — used as the "relaxed" ceiling in test/dev. */
  readonly globalLimit: number

  constructor(private readonly config: ConfigService<Env>) {
    this.ttl = config.get('THROTTLER_TTL_MS', { infer: true })!
    this.globalLimit = config.get('THROTTLER_LIMIT', { infer: true })!
  }

  /**
   * Returns true only when THROTTLE_RELAXED=true AND we are NOT in production.
   * This is the single authoritative check — all per-endpoint helpers call it.
   */
  isRelaxed(): boolean {
    const nodeEnv = this.config.get('NODE_ENV', { infer: true })
    if (nodeEnv === 'production') return false
    return this.config.get('THROTTLE_RELAXED', { infer: true }) === true
  }

  /**
   * Limit for sensitive user-facing write endpoints:
   *   POST /api/contracts/sign, POST /api/tos/accept.
   *
   * Relaxed → globalLimit (e.g. 100 or THROTTLER_LIMIT).
   * Strict   → 10 req/min (prod hardened value).
   */
  sensitiveWriteLimit(): number {
    return this.isRelaxed() ? this.globalLimit : ThrottlerConfigService.PROD_SENSITIVE_LIMIT
  }

  /**
   * Limit for admin write endpoints:
   *   POST /api/contracts/templates, POST /api/tos (publish).
   *
   * Relaxed → globalLimit.
   * Strict   → 5 req/min (prod hardened value).
   */
  adminWriteLimit(): number {
    return this.isRelaxed() ? this.globalLimit : ThrottlerConfigService.PROD_ADMIN_LIMIT
  }
}
