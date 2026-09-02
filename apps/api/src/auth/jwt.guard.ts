import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { FastifyRequest } from 'fastify'
import { jwtPayloadSchema, type JwtPayload } from '@crm/shared'
import { UsersService } from '../users/users.service'
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
 * SR-H-6 (security-review PR #623 round 5) — per-row revocation via
 * `JwtPayload.userEmailId`:
 *   • AC2 above re-hydrates the USER's role/archived status, but never
 *     re-checked the specific `user_emails` row (WORK or PERSONAL) that
 *     unlocked the login — an already-open session survived a
 *     `changePersonalEmail` revocation of that exact row untouched, for
 *     the rest of its 7-day cookie.
 *   • `resolveCurrentUser` now also re-checks that row (when the token
 *     carries one — see `JwtPayload.userEmailId`'s own doc) in a SEPARATE
 *     `userEmailCache`, same `CACHE_TTL_MS` bound as AC2's role/archived
 *     cache.
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
 *
 * ── How UsersService is injected (do NOT "simplify" this) ───────────────────
 *
 * The `usersService` parameter carries an EXPLICIT DI token
 * (`@Inject(forwardRef(() => UsersService))`) instead of relying on the token
 * TypeScript emits into `design:paramtypes`. That is deliberate: this guard
 * previously declared the dependency in a shape whose emitted token was a bare
 * `Object`, so the container could not resolve it and every DI-built instance
 * silently received `undefined` — i.e. the DB re-hydration below (AC2) never
 * ran in the compiled application, and roles came straight from the token.
 *
 * Two independent declaration details break that emission, and BOTH were
 * present here:
 *   1. `import type { UsersService }` — a type-only import erases the runtime
 *      class, so the emitted token degrades (to `Function`/`Object`).
 *   2. `usersService: UsersService | undefined` — an explicit union with
 *      `undefined` emits `Object`, even with a value import. The optional-
 *      parameter form (`usersService?: UsersService`) does NOT have this
 *      problem, which is why it is used below.
 * The value import + optional-parameter form + explicit `@Inject` token are
 * three overlapping defences; keep all three.
 *
 * `forwardRef` is required because the module graph is circular
 * (jwt.guard → users.service → users.module → auth.module → jwt.guard); the
 * arrow is evaluated at resolution time, not at decoration time. Same pattern
 * as `OnboardingGuard` (see onboarding.guard.ts).
 *
 * `@Optional()` only keeps DIRECT construction (`new JwtAuthGuard(jwt, refl)`)
 * working for unit tests. It is NOT a licence for the application to run
 * without the service: `assertJwtAuthGuardsWired()` (jwt-guard-wiring.ts) is
 * called during bootstrap and refuses to start the process if any DI-built
 * instance lacks it — see that file for why a test cannot cover this.
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

/**
 * SR-H-6 (security-review PR #623 round 5): cached verdict for a SPECIFIC
 * `user_emails` row (`JwtPayload.userEmailId` — see that field's own doc
 * for the full rationale). Kept in its OWN map, keyed by `userEmailId`
 * (globally unique) rather than folded into `CachedUser` above (keyed by
 * `userId`) — one user can hold concurrent sessions opened through
 * DIFFERENT rows (WORK on one device, a just-accepted PERSONAL on
 * another), and a `userId`-keyed cache would let one session's
 * freshly-fetched verdict silently answer for the other's.
 */
interface CachedUserEmail {
  canLogin: boolean
  expiresAt: number
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  /** Short-lived in-memory cache: userId → { role, archivedAt, expiresAt } */
  private readonly userCache = new Map<string, CachedUser>()
  /** SR-H-6: short-lived in-memory cache: userEmailId → { canLogin, expiresAt } */
  private readonly userEmailCache = new Map<string, CachedUserEmail>()

  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
    // Explicit token — never rely on `design:paramtypes` here. See the class
    // doc block ("How UsersService is injected") before changing this line.
    @Optional()
    @Inject(forwardRef(() => UsersService))
    private usersService?: UsersService,
  ) {}

  /**
   * Bootstrap-time wiring probe used by `assertJwtAuthGuardsWired()`.
   *
   * Exposed as a method (rather than making `usersService` public) so the
   * assertion can inspect a DI-built instance without widening the guard's
   * public surface. Checks for the actual method the request path calls, not
   * merely truthiness, so a mis-wired token that resolves to some unrelated
   * provider is caught too.
   */
  isRoleRevocationWired(): boolean {
    return typeof this.usersService?.findById === 'function'
  }

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
   * The `!this.usersService` branch below is reachable ONLY from direct
   * construction (`new JwtAuthGuard(jwt, reflector)` in unit/integration
   * specs). In the running application it is unreachable by construction:
   * `assertJwtAuthGuardsWired()` runs during bootstrap and aborts the process
   * if any DI-built guard lacks the service, so the app cannot serve a single
   * request while that branch is live.
   */
  private async resolveCurrentUser(jwtUser: JwtPayload): Promise<JwtPayload> {
    if (!this.usersService) {
      // Direct-construction path only — see the doc block above. Not a
      // production code path; the bootstrap assertion guarantees that.
      return jwtUser
    }

    // SR-H-6 (security-review PR #623 round 5): re-check the SPECIFIC
    // `user_emails` row this session was opened through — see
    // `JwtPayload.userEmailId`'s own doc (`@crm/shared`) for the full
    // rationale and `CachedUserEmail`'s doc above for why this is a
    // SEPARATE cache from `userCache` below. `undefined` here skips this
    // check entirely (governed by the archived-check below alone,
    // unchanged) — see that same doc for the exact, EXHAUSTIVE enumeration
    // of the three cases this covers (SR-M-15, round 6: an earlier version
    // of this comment named only "admin-minted (impersonate /
    // stop-impersonating)", which undercounted — a pre-deployment token
    // also lands here, and is closed by its OWN `exp` claim, not by this
    // guard). Do not re-add a two-case summary here; it drifts from the
    // schema doc exactly the way this one did.
    if (jwtUser.userEmailId) {
      const cachedEmail = this.userEmailCache.get(jwtUser.userEmailId)
      let canLogin: boolean
      if (cachedEmail && cachedEmail.expiresAt > Date.now()) {
        canLogin = cachedEmail.canLogin
      } else {
        const emailRow = await this.usersService.findUserEmailById(jwtUser.userEmailId)
        canLogin = emailRow?.canLogin === true
        this.userEmailCache.set(jwtUser.userEmailId, {
          canLogin,
          expiresAt: Date.now() + CACHE_TTL_MS,
        })
      }
      if (!canLogin) {
        throw new UnauthorizedException()
      }
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
