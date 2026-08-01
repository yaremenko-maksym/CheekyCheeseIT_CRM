import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { FastifyRequest } from 'fastify'
import { jwtPayloadSchema, type JwtPayload } from '@crm/shared'
import type { UsersService } from '../users/users.service'
import { IS_PUBLIC_KEY } from './public.decorator'
import { JWT_COOKIE_HARDENED, JWT_COOKIE_LEGACY } from './cookie-names'

/**
 * Globally registered (APP_GUARD in AppModule) — runs FIRST so it populates
 * `req.user` before OnboardingGuard reads it. See
 * `onboarding.guard.integration.spec.ts` for the lifecycle pin.
 *
 * Handlers / controllers tagged with `@Public()` bypass JWT verification via
 * the `Reflector` lookup of `IS_PUBLIC_KEY` (handler-level first, then
 * controller-level). Use sparingly — only for endpoints that genuinely have
 * no JWT cookie at call time (OAuth begin/callback, health probe).
 *
 * ── Security hardening (fix/auth-hardening) ─────────────────────────────────
 *
 * AC3 (SEC-17) — algorithm allowlist + payload schema validation:
 *   • `jwt.verify()` is called with `{ algorithms: ['HS256'] }` to prevent
 *     alg-confusion attacks (e.g. alg=none or RS256 → symmetric bypass).
 *   • After verify, the raw payload is re-validated through `jwtPayloadSchema`
 *     (Zod) to reject structurally invalid tokens (missing role, bad UUID, etc.).
 *
 * AC2 (SEC-06) — role revocation via DB re-hydration + in-memory cache:
 *   • After a valid + schema-conformant JWT, the guard queries UsersService to
 *     fetch the CURRENT role and archived status from the database. This makes
 *     role changes effective within the cache TTL (≤ 60 s) rather than at
 *     token expiry (7 days).
 *   • Archived users are rejected with 401 even if their JWT is still valid.
 *     The `archivedAt` flag is stored in the cache entry so that archived
 *     users are rejected on cache-HIT as well as cache-MISS, bounding the
 *     archive-revocation lag to CACHE_TTL_MS rather than infinity.
 *   • An in-memory Map<userId, {role, archivedAt, expiresAt}> cache (TTL:
 *     CACHE_TTL_MS) prevents a DB hit on every request. The cache is per-
 *     guard-instance (singleton in NestJS DI), so it is shared across all
 *     requests in the same process.
 *
 * Trade-offs (AC2):
 *   • Revocation lag = CACHE_TTL_MS (60 s). An admin who demotes or archives
 *     a user will see the enforcement kick in within 60 s — intentional design
 *     choice that avoids per-request DB overhead.
 *   • Cache is in-process only. Horizontal scaling means each pod has its own
 *     cache; worst case: revocation takes up to TTL per pod. Accepted for the
 *     current single-process deployment (Hetzner VPS, single api container).
 *   • External cache eviction (instant role propagation without TTL wait) is
 *     not implemented. For a single-container deployment TTL ≤ 60 s is
 *     acceptable; add Redis-backed eviction if horizontal scaling is required.
 *   • UsersService is injected as @Optional() to maintain backward-compat with
 *     unit tests that construct the guard directly without DI. When absent, the
 *     guard falls back to the raw JWT payload role (legacy behaviour).
 */

/** Cache TTL for DB-hydrated user records. 60 s balances freshness vs DB load. */
const CACHE_TTL_MS = 60_000

/**
 * MED-1 (security-review round 2, authz-hardening): bounds how long the
 * legacy plain `jwt` cookie is still accepted in PRODUCTION alongside the
 * hardened `__Host-jwt` name.
 *
 * Without a cutoff, the fallback below is a session-fixation surface for as
 * long as the app runs: a plain `jwt` cookie can be set from ANY sibling
 * subdomain of the registrable domain (XSS on the public landing, a taken-
 * over subdomain, MITM on a plain-http sibling — see auth.controller.ts's
 * `issueJwtCookie` doc for the full `__Host-` rationale) and this guard
 * would honor it exactly like a real session. Since the token itself is
 * signed, this cannot forge someone else's session — but it CAN plant the
 * attacker's own session into an unsuspecting victim's browser (login-CSRF
 * / session fixation), and a per-domain cookie-jar eviction from a sibling
 * origin can knock out an already-issued `__Host-jwt` and leave only the
 * planted `jwt` behind for an ALREADY-logged-in victim too.
 *
 * This constant is a FIXED calendar date, not `Date.now()` measured at
 * process boot — computing it from boot time would reset (and re-open the
 * window) on every restart, which defeats the entire point of a cutoff.
 * ≤ COOKIE_MAX_AGE (7 days, auth.controller.ts) after this fix ships to
 * prod: no legacy-named `jwt` cookie issued before this deploy can still be
 * un-expired past that date. `auth.controller.ts`'s `issueJwtCookie` also
 * actively clears the legacy name on every NEW `__Host-jwt` session, so in
 * practice the window closes even sooner, per-browser, as users log in.
 *
 * If the actual production rollout of this fix slips past the date below,
 * bump it (still ≤ 7 days from the REAL rollout date) in the same PR/commit
 * that ships the delay — do not let it go stale silently.
 *
 * Scope: PRODUCTION ONLY (gated on `process.env.NODE_ENV === 'production'`
 * below). Dev/test/CI never issue `__Host-jwt` at all (see
 * auth.controller.ts for why `__Host-` cannot work over plain http), so the
 * plain `jwt` cookie there is the permanent, correct name — not a "legacy"
 * one subject to expiry.
 *
 * BUMPED (security-review round 3, follow-up to #436, this file's own PR):
 * #436 (which introduced this cutoff) merged/deployed to prod 2026-07-31.
 * The original `2026-08-03T00:00:00Z` gave only ~2-3 days of grace from that
 * rollout — well under the ≤7-day ceiling this doc already allows — and this
 * follow-up PR (pure refactor + test coverage of the SAME cutoff, no new
 * rollout of the hardening logic itself) risked merging on/after that date,
 * which would have made the fallback fail-closed for any browser that
 * hadn't re-logged-in yet, before the full grace window had even elapsed.
 * Bumped to the full `COOKIE_MAX_AGE` (7 days) from the confirmed rollout
 * date: `2026-07-31 + 7d = 2026-08-07T00:00:00Z`.
 */
export const LEGACY_JWT_COOKIE_FALLBACK_CUTOFF = new Date('2026-08-07T00:00:00Z')

interface CachedUser {
  role: JwtPayload['role']
  /** Snapshot of archivedAt at last DB query — non-null means the user is archived. */
  archivedAt: Date | null
  expiresAt: number
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  /** Short-lived in-memory cache: userId → { role, archivedAt, expiresAt } */
  private readonly userCache = new Map<string, CachedUser>()

  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
    @Optional() private usersService: UsersService | undefined,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (isPublic) return true

    const request = ctx.switchToHttp().getRequest<FastifyRequest>()
    // Cookie hardening (security-audit authz-hardening): production issues
    // `__Host-jwt` (browser-enforced Secure + Path=/ + no Domain — closes
    // the landing/CRM sibling-subdomain cookie-sharing surface). Every other
    // environment still issues the plain `jwt` name (see auth.controller.ts
    // for why `__Host-` cannot work over plain http://localhost).
    //
    // MED-1 (security-review round 2): the legacy-name fallback is now
    // BOUNDED — see `LEGACY_JWT_COOKIE_FALLBACK_CUTOFF`'s doc for the full
    // rationale. `process.env.NODE_ENV` is read directly here (same pattern
    // as throttle-decorators.ts) rather than via injected ConfigService, to
    // avoid widening this guard's constructor signature — it is constructed
    // directly (no DI) across ~20 test files.
    const hostToken = request.cookies?.[JWT_COOKIE_HARDENED]
    const legacyToken = request.cookies?.[JWT_COOKIE_LEGACY]
    const isProduction = process.env.NODE_ENV === 'production'
    const legacyFallbackAllowed =
      !isProduction || Date.now() < LEGACY_JWT_COOKIE_FALLBACK_CUTOFF.getTime()
    const token = hostToken ?? (legacyFallbackAllowed ? legacyToken : undefined)
    if (!token) throw new UnauthorizedException()

    // ── AC3: verify with explicit algorithm allowlist ────────────────────
    let rawPayload: unknown
    try {
      rawPayload = this.jwt.verify(token, { algorithms: ['HS256'] })
    } catch {
      throw new UnauthorizedException()
    }

    // ── AC3: re-validate payload shape through Zod schema ───────────────
    const parsed = jwtPayloadSchema.safeParse(rawPayload)
    if (!parsed.success) throw new UnauthorizedException()
    const jwtUser = parsed.data

    // ── AC2: re-hydrate role + active status from DB (with cache) ───────
    const resolvedUser = await this.resolveCurrentUser(jwtUser)

    ;(request as FastifyRequest & { user: JwtPayload }).user = resolvedUser
    return true
  }

  /**
   * Returns a JwtPayload with the CURRENT role from DB.
   * Caches the result (including archivedAt) for CACHE_TTL_MS to avoid
   * per-request DB queries. Archived users are rejected on both cache-HIT
   * and cache-MISS — the archivedAt flag is stored in the cache entry so
   * revocation-by-archive takes effect within TTL, not only on cache expiry.
   *
   * Falls back to the JWT payload role when UsersService is not injected
   * (e.g. unit tests that construct the guard without full DI).
   */
  private async resolveCurrentUser(jwtUser: JwtPayload): Promise<JwtPayload> {
    if (!this.usersService) {
      // No DI service available (legacy unit-test path) — return payload as-is.
      return jwtUser
    }

    // Check in-memory cache first.
    const cached = this.userCache.get(jwtUser.id)
    if (cached && cached.expiresAt > Date.now()) {
      // Cache hit — still check archivedAt so archive-revocation works within TTL.
      if (cached.archivedAt) {
        throw new UnauthorizedException()
      }
      return { ...jwtUser, role: cached.role }
    }

    // Cache miss or expired — query DB.
    const dbUser = await this.usersService.findById(jwtUser.id)

    if (!dbUser) {
      // User was deleted after token was issued.
      throw new UnauthorizedException()
    }

    // Populate cache with fresh role AND archivedAt so the cache-HIT path
    // can enforce archive-revocation without a second DB round-trip.
    this.userCache.set(jwtUser.id, {
      role: dbUser.role as JwtPayload['role'],
      archivedAt: dbUser.archivedAt ?? null,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })

    if (dbUser.archivedAt) {
      // User was archived — revoke session immediately.
      throw new UnauthorizedException()
    }

    return { ...jwtUser, role: dbUser.role as JwtPayload['role'] }
  }
}
