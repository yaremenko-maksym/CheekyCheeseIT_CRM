import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import {
  impersonateSchema,
  jwtPayloadSchema,
  sessionUserSchema,
  type JwtPayload,
} from '@crm/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import type { Env } from '../config/env'
import { AdminWriteThrottle, AuthThrottle, RelaxableThrottle } from '../config/throttle-decorators'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { UsersService } from '../users/users.service'
import { AuthService } from './auth.service'
import { CurrentUser } from './current-user.decorator'
import { Public } from './public.decorator'

// Plain (legacy) cookie names — used as the pre-hardening name AND, in
// non-production environments, as the live name (see comment below on why
// `__Host-` cannot be used outside prod).
const STATE_COOKIE_LEGACY = 'oauth_state'
const JWT_COOKIE_LEGACY = 'jwt'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days in seconds

interface SetCookieOpts {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  maxAge: number
  path: '/'
}
interface ClearCookieOpts {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: '/'
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name)
  private readonly frontendUrl: string
  private readonly isProduction: boolean
  // Cookie hardening (security-audit authz-hardening, "плюс" finding): the
  // `__Host-` prefix makes the browser itself enforce Secure + Path=/ + no
  // Domain attribute on this cookie — a session cookie with `Domain` set
  // (or none, relying on default-domain matching) is shared with any
  // subdomain of the registrable domain, which matters here because the
  // public landing (cheekycheese.tech) and the CRM (app.cheekycheese.tech)
  // are siblings under the same registrable domain. `__Host-` closes that
  // sharing/spoofing surface at the browser level.
  //
  // `__Host-` REQUIRES the Secure attribute, which requires HTTPS — dev runs
  // over plain http://localhost, where a `secure: true` cookie would simply
  // never be stored by the browser (silent login failure, not a security
  // trade-off worth making for local dev). So the prefixed name is used
  // ONLY in production; every other environment (dev, test, CI) keeps the
  // legacy plain name, matching `secure: this.isProduction` below 1:1.
  private readonly jwtCookieName: string
  private readonly stateCookieName: string
  // security-review round 2 (HIGH-1 regression fix): `clearCookie(name, opts)`
  // in @fastify/cookie builds its Set-Cookie header ONLY from the opts passed
  // to that call (+ the plugin's `parseOptions`, which main.ts does not set —
  // it registers `cookie` with only `{ secret }`). A `__Host-*` deletion
  // response therefore needs `secure: true` on the CLEAR call too, or the
  // browser silently drops the entire Set-Cookie header per the `__Host-`
  // prefix rules — the cookie survives and "logout" becomes cosmetic. Both
  // this options object and `jwtSetCookieOpts` below are built ONCE in the
  // constructor (from the same `isProduction`) instead of being repeated
  // ad-hoc at each call site, so a future edit to one attribute cannot drift
  // between set/clear the way the original bug did.
  private readonly jwtSetCookieOpts: SetCookieOpts
  private readonly jwtClearCookieOpts: ClearCookieOpts
  private readonly stateSetCookieOpts: SetCookieOpts
  private readonly stateClearCookieOpts: ClearCookieOpts

  constructor(
    private authService: AuthService,
    private usersService: UsersService,
    private jwtService: JwtService,
    private config: ConfigService<Env>,
  ) {
    this.frontendUrl = this.config.get('FRONTEND_URL', { infer: true })!
    this.isProduction = this.config.get('NODE_ENV', { infer: true }) === 'production'
    this.jwtCookieName = this.isProduction ? '__Host-jwt' : JWT_COOKIE_LEGACY
    this.stateCookieName = this.isProduction ? '__Host-oauth_state' : STATE_COOKIE_LEGACY
    this.jwtSetCookieOpts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    }
    this.jwtClearCookieOpts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      path: '/',
    }
    this.stateSetCookieOpts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: 600,
      path: '/',
    }
    this.stateClearCookieOpts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      path: '/',
    }
  }

  /**
   * Sets the JWT session cookie under the current name (`__Host-jwt` in
   * prod, plain `jwt` elsewhere) and, in production, ALSO clears the legacy
   * plain `jwt` name in the same response.
   *
   * MED-1 (security-review round 2): the legacy-name fallback read in
   * jwt.guard.ts is a session-fixation surface for as long as a browser can
   * still be holding a pre-hardening `jwt` cookie. Actively clearing it
   * every time we mint a NEW `__Host-jwt` session means the window shrinks
   * on its own as users authenticate — combined with the hard cutoff date in
   * jwt.guard.ts (`LEGACY_JWT_COOKIE_FALLBACK_CUTOFF`), the fallback cannot
   * stay open indefinitely for any single browser, only for the bounded
   * period before that browser's next login.
   */
  private issueJwtCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(this.jwtCookieName, token, this.jwtSetCookieOpts)
    if (this.jwtCookieName !== JWT_COOKIE_LEGACY) {
      reply.clearCookie(JWT_COOKIE_LEGACY, this.jwtClearCookieOpts)
    }
  }

  @Get('google')
  @Public()
  async initiateGoogleAuth(@Res() reply: FastifyReply) {
    const state = randomBytes(16).toString('hex')
    const authUrl = this.authService.buildGoogleAuthUrl(state)

    reply.setCookie(this.stateCookieName, state, this.stateSetCookieOpts)
    await reply.redirect(authUrl, 302)
  }

  @Get('google/callback')
  @Public()
  @AuthThrottle()
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const storedState = request.cookies?.[this.stateCookieName]
    if (!storedState || storedState !== state || !code) {
      await reply.redirect(`${this.frontendUrl}/login?error=invalid_state`, 302)
      return
    }

    // HIGH-1 fix (security-review round 2): full opts, not just `{path:'/'}` —
    // see `issueJwtCookie` doc for why a `__Host-*` deletion needs `secure`.
    reply.clearCookie(this.stateCookieName, this.stateClearCookieOpts)

    let googleUser: { id: string; email: string; name: string; picture: string }
    try {
      const tokens = await this.authService.exchangeGoogleCode(code)
      googleUser = await this.authService.getGoogleUserInfo(tokens.access_token)
    } catch (err) {
      this.logger.error('Google OAuth callback failed', err)
      await reply.redirect(`${this.frontendUrl}/login?error=google_error`, 302)
      return
    }

    const user = await this.usersService.findByEmail(googleUser.email)
    if (!user) {
      await reply.redirect(`${this.frontendUrl}/login?error=unauthorized`, 302)
      return
    }

    // LOW (security-audit authz-hardening): an archived (fired) user was
    // handed a full 7-day session here — only the NEXT request's
    // JwtAuthGuard (DB re-hydration, up to CACHE_TTL_MS stale) rejected them.
    // Reject at issuance so a fired user never gets a session at all.
    if (user.archivedAt) {
      await reply.redirect(`${this.frontendUrl}/login?error=account_disabled`, 302)
      return
    }

    if (!user.googleId) {
      await this.usersService.updateGoogleId(user.id, googleUser.id)
    } else if (user.googleId !== googleUser.id) {
      // Audit LOW #3: the email is already bound to a DIFFERENT Google `sub`.
      // Refuse rather than silently honouring the existing binding — protects
      // against account-takeover via email reuse / re-issued Google accounts.
      // MED (security-review): log user.id only — never raw email (PII).
      this.logger.warn(`Google account mismatch (OAuth callback) for user id=${user.id}`)
      await reply.redirect(`${this.frontendUrl}/login?error=account_mismatch`, 302)
      return
    }

    // MED #2: JWT cookie stores only minimal identity (no PII).
    // Full SessionUser (incl. legalFullName) is re-hydrated via GET /me.
    const jwtPayload = jwtPayloadSchema.parse({ id: user.id, email: user.email, role: user.role })
    const token = this.jwtService.sign(jwtPayload)

    this.issueJwtCookie(reply, token)

    await reply.redirect(`${this.frontendUrl}/`, 302)
  }

  // `/me` requires auth (no @Public) — caller is the global JwtAuthGuard now.
  // MED #2: The decoded JWT payload only contains {id, email, role} — full
  // SessionUser (incl. legalFullName, displayName, avatarUrl) is always
  // re-hydrated from the DB here so the frontend receives fresh PII without
  // an explicit re-login after profile edits.
  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    const fresh = await this.usersService.findById(user.id)
    if (!fresh) {
      // LOW (security-review round 3, follow-up to #436): unreachable in
      // production traffic — JwtAuthGuard already re-hydrates the user from
      // the DB (rejecting with 401 if the row is gone) before this handler
      // ever runs; the only recipient of this branch is the user's own
      // browser. Still, shape the fallback through `sessionUserSchema` like
      // the normal path below instead of returning the raw `JwtPayload` —
      // the raw shape skips `sessionUserSchema.parse()` entirely and would
      // leak `impersonatorId` verbatim during impersonation, contradicting
      // that field's own doc (`packages/shared/src/schemas/auth.ts`), which
      // states `/me` never emits that key, only the derived `impersonating`
      // boolean.
      return sessionUserSchema.parse({
        id: user.id,
        email: user.email,
        displayName: user.email,
        avatarUrl: null,
        avatarDocumentId: null,
        role: user.role,
        seniorSharePercent: 0,
        legalFullName: null,
        impersonating: Boolean(user.impersonatorId),
      })
    }
    return sessionUserSchema.parse({
      id: fresh.id,
      email: fresh.email,
      displayName: fresh.displayName,
      avatarUrl: fresh.avatarUrl ?? null,
      avatarDocumentId: fresh.avatarDocumentId ?? null,
      role: fresh.role,
      seniorSharePercent: fresh.seniorSharePercent,
      legalFullName: fresh.legalFullName ?? null,
      // Derived: true when the JWT has impersonatorId set (admin is acting as another user).
      impersonating: Boolean(user.impersonatorId),
    })
  }

  /**
   * POST /api/auth/impersonate
   *
   * ADMIN-only. Issues a new JWT cookie where `id`/`email`/`role` belong to
   * the target user, and `impersonatorId` contains the calling admin's userId.
   * This allows the admin to act as the target user across the CRM.
   *
   * Security invariants enforced:
   *  - Only ADMIN can call this (RolesGuard + @Roles).
   *  - Target must not be ADMIN (no impersonating admins).
   *  - Target must not be the caller themselves.
   *  - No nesting: if the current JWT already has `impersonatorId`, reject.
   *
   * Starting/stopping impersonation itself is not written as its own audit
   * event (an earlier, still-current owner decision — no dedicated
   * "impersonation started/stopped" row). That is distinct from ACTIONS
   * taken while impersonating: `AuditInterceptor` now attributes those to
   * the real operator (`actorId = impersonatorId ?? id`) with an
   * `__impersonation` marker — see its own doc (security-review round 2,
   * authz-hardening) — rather than silently recording them against the
   * impersonated target. That per-action correction is intentionally
   * minimal (interceptor-level only, not threaded into every service-layer
   * audit writer) per the same owner decision against heavier machinery.
   * list excludes admins — enforced here; frontend filters UI list accordingly.
   */
  @Post('impersonate')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @AdminWriteThrottle()
  @HttpCode(HttpStatus.OK)
  async impersonate(
    @Body() body: unknown,
    @CurrentUser() currentUser: JwtPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { userId } = impersonateSchema.parse(body)

    // Block nested impersonation — the current token already represents someone else.
    if (currentUser.impersonatorId) {
      throw new ForbiddenException('Нельзя применить имперсонацию во время другой имперсонации')
    }

    const target = await this.usersService.findById(userId)
    if (!target) throw new NotFoundException('Пользователь не найден')

    // Cannot impersonate self — checked before the ADMIN-role guard so that
    // self-impersonation by an ADMIN yields 400 (not 403).
    if (target.id === currentUser.id) {
      throw new BadRequestException('Нельзя войти как самого себя')
    }

    // ADMIN → cannot impersonate another ADMIN.
    if (target.role === 'ADMIN') {
      throw new ForbiddenException('Нельзя войти как другой администратор')
    }

    const jwtPayload = jwtPayloadSchema.parse({
      id: target.id,
      email: target.email,
      role: target.role,
      impersonatorId: currentUser.id,
    })
    const token = this.jwtService.sign(jwtPayload)

    this.issueJwtCookie(reply, token)

    return { ok: true }
  }

  /**
   * POST /api/auth/stop-impersonating
   *
   * Requires a valid JWT (global JwtAuthGuard) — NOT @Roles('ADMIN') because
   * the current role in the token belongs to the impersonated target, not the
   * original admin.
   *
   * Restores the original admin session by signing a new JWT with the admin's
   * own identity (fetched from DB by `impersonatorId` in the current token).
   *
   * Security invariant: restores ONLY the admin whose id is in `impersonatorId`
   * of the caller's token — never an arbitrary user.
   */
  @Post('stop-impersonating')
  @RelaxableThrottle(20)
  @HttpCode(HttpStatus.OK)
  async stopImpersonating(
    @CurrentUser() currentUser: JwtPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!currentUser.impersonatorId) {
      throw new BadRequestException('Нет активной имперсонации')
    }

    const admin = await this.usersService.findById(currentUser.impersonatorId)
    if (!admin || admin.role !== 'ADMIN') {
      // Safety check: if the original admin was demoted or deleted, reject.
      throw new UnauthorizedException('Исходный администратор недоступен')
    }

    const jwtPayload = jwtPayloadSchema.parse({
      id: admin.id,
      email: admin.email,
      role: admin.role,
      // No impersonatorId — restoring clean admin session.
    })
    const token = this.jwtService.sign(jwtPayload)

    this.issueJwtCookie(reply, token)

    return { ok: true }
  }

  @Post('google/one-tap')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  async googleOneTap(
    @Body() body: { credential: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    let googleUser: { sub: string; email: string; name: string; picture: string }
    try {
      googleUser = await this.authService.verifyGoogleIdToken(body.credential)
    } catch {
      throw new UnauthorizedException('Invalid Google credential')
    }

    const user = await this.usersService.findByEmail(googleUser.email)
    if (!user) throw new UnauthorizedException('Email not authorized')

    // LOW (security-audit authz-hardening): mirrors the same check in
    // googleCallback — an archived (fired) user must never receive a
    // session, not even a 401-request's worth of DB re-hydration lag.
    if (user.archivedAt) throw new UnauthorizedException('Account disabled')

    if (!user.googleId) {
      await this.usersService.updateGoogleId(user.id, googleUser.sub)
    } else if (user.googleId !== googleUser.sub) {
      // Audit LOW #3: incoming Google `sub` differs from the one already bound
      // to this email — reject instead of ignoring the mismatch.
      // MED (security-review): log user.id only — never raw email (PII).
      this.logger.warn(`Google account mismatch (one-tap) for user id=${user.id}`)
      throw new UnauthorizedException('Google account mismatch')
    }

    // MED #2: JWT cookie stores only minimal identity (no PII).
    const jwtPayload = jwtPayloadSchema.parse({ id: user.id, email: user.email, role: user.role })
    const token = this.jwtService.sign(jwtPayload)

    this.issueJwtCookie(reply, token)

    return { ok: true }
  }

  // LOW (security-audit authz-hardening): was `@Get('logout') @Public()` —
  // a plain `<img src="…/api/auth/logout">` on ANY third-party page forces a
  // logout of the current session (cross-site GET carries cookies by
  // default). POST is not a full CSRF fix on its own, but it defeats the
  // trivial <img>/<link>/background-fetch GET vector; the frontend already
  // calls this via axios (use-logout.ts), not a browser navigation, so a
  // method-only change is fully backward compatible with the real client.
  @Post('logout')
  @Public()
  async logout(@Res() reply: FastifyReply) {
    // Cookie hardening: clear BOTH the current name and the legacy plain
    // name unconditionally — a user whose browser still holds a
    // pre-hardening `jwt` cookie (issued before this deploy) must still be
    // fully logged out. Clearing a cookie that was never set is a no-op.
    //
    // HIGH-1 fix (security-review round 2): MUST use `jwtClearCookieOpts`
    // (full opts incl. `secure`), not a bare `{path:'/'}` — see
    // `issueJwtCookie`'s doc for why a bare clear silently no-ops on
    // `__Host-jwt` in production (the browser drops any `__Host-*`
    // Set-Cookie header that lacks `Secure`, so the "deletion" response
    // itself gets discarded and the cookie survives).
    reply.clearCookie(this.jwtCookieName, this.jwtClearCookieOpts)
    if (this.jwtCookieName !== JWT_COOKIE_LEGACY) {
      reply.clearCookie(JWT_COOKIE_LEGACY, this.jwtClearCookieOpts)
    }
    await reply.redirect(`${this.frontendUrl}/login`, 302)
  }

  // DEV ONLY — быстрый вход по email без Google OAuth
  @Post('dev-login')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  async devLogin(@Body() body: { email: string }, @Res({ passthrough: true }) reply: FastifyReply) {
    if (this.isProduction) throw new UnauthorizedException('Not available in production')

    const user = await this.usersService.findByEmail(body.email)
    if (!user) throw new NotFoundException(`User ${body.email} not found in DB`)

    // MED #2: JWT cookie stores only minimal identity (no PII).
    const jwtPayload = jwtPayloadSchema.parse({ id: user.id, email: user.email, role: user.role })
    const token = this.jwtService.sign(jwtPayload)
    // devLogin can only reach this line when `this.isProduction === false`
    // (checked above), so `issueJwtCookie`'s `secure: this.isProduction`
    // evaluates identically to the previous hardcoded `secure: false` here.
    this.issueJwtCookie(reply, token)

    return { ok: true, user: jwtPayload }
  }
}
