import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
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
import type { User, UserEmail } from '../database/schema'
import {
  GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE,
  INVITE_TARGET_ARCHIVED_MESSAGE,
  UsersService,
} from '../users/users.service'
import { AuthService } from './auth.service'
import { CurrentUser } from './current-user.decorator'
import { Public } from './public.decorator'
import {
  INVITE_COOKIE_HARDENED,
  INVITE_COOKIE_LEGACY,
  JWT_COOKIE_HARDENED,
  JWT_COOKIE_LEGACY,
  STATE_COOKIE_HARDENED,
  STATE_COOKIE_LEGACY,
} from './cookie-names'

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
  // task-user-emails-invite — see cookie-names.ts's doc on this pair.
  private readonly inviteCookieName: string
  private readonly inviteSetCookieOpts: SetCookieOpts
  private readonly inviteClearCookieOpts: ClearCookieOpts

  constructor(
    private authService: AuthService,
    private usersService: UsersService,
    private jwtService: JwtService,
    private config: ConfigService<Env>,
  ) {
    this.frontendUrl = this.config.get('FRONTEND_URL', { infer: true })!
    this.isProduction = this.config.get('NODE_ENV', { infer: true }) === 'production'
    this.jwtCookieName = this.isProduction ? JWT_COOKIE_HARDENED : JWT_COOKIE_LEGACY
    this.stateCookieName = this.isProduction ? STATE_COOKIE_HARDENED : STATE_COOKIE_LEGACY
    this.inviteCookieName = this.isProduction ? INVITE_COOKIE_HARDENED : INVITE_COOKIE_LEGACY
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
    // Same shape as the state cookie — see cookie-names.ts.
    this.inviteSetCookieOpts = this.stateSetCookieOpts
    this.inviteClearCookieOpts = this.stateClearCookieOpts
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
    // SR-M-11 (security-review PR #623 round 4): an invite-accept round trip
    // (below) may have left this cookie behind (its own 10-minute maxAge) —
    // clear it so an ordinary login click can never be misrouted into
    // `googleCallback`'s invite branch. The state-binding in that branch is
    // the primary defense (a normal round's `state` never matches an old
    // invite cookie's embedded state either); this is belt-and-suspenders.
    reply.clearCookie(this.inviteCookieName, this.inviteClearCookieOpts)
    await reply.redirect(authUrl, 302)
  }

  /**
   * task-user-emails-invite (spec §2, §5) — the invite email's link points
   * here directly (see PersonalEmailInviteMailerService), same pattern the
   * login page's own "Войти с Google" button already uses (a plain link
   * straight to a backend endpoint that redirects to Google — no frontend
   * page needed for this step).
   *
   * Sets the SAME OAuth-state cookie `initiateGoogleAuth` sets (CSRF
   * defense, unchanged) PLUS the invite-token cookie — `googleCallback`
   * below reads that second cookie to know this round trip is an
   * invite-accept, not a normal login. A malformed token (wrong shape —
   * `generateInviteToken` always produces 64 hex chars) is rejected here,
   * before spending a Google round trip on it; a well-formed but
   * nonexistent/expired/used one is still rejected later, in
   * `UsersService.acceptPersonalEmailInvite` — this check is cheap hygiene,
   * not the real validation.
   *
   * SR-M-11 (security-review PR #623 round 4): the invite cookie's VALUE is
   * `${state}:${token}`, not the bare token — `googleCallback` only honours
   * it when the embedded `state` matches THIS callback's `state` query
   * param. Before this, the cookie was keyed on nothing but its own
   * presence: `googleCallback` treated ANY request carrying it as an
   * invite-accept, and this endpoint set it for any syntactically valid
   * 64-hex string without checking it existed — so a link to
   * `/api/auth/invite/<any 64 hex>`, opened once, made the visitor's NEXT
   * ordinary login (within the 10-minute cookie lifetime) silently fail
   * with an invite-flavoured error instead of signing them in.
   */
  @Get('invite/:token')
  @Public()
  @AuthThrottle()
  async startInviteAccept(@Param('token') token: string, @Res() reply: FastifyReply) {
    if (!/^[0-9a-f]{64}$/.test(token)) {
      await reply.redirect(`${this.frontendUrl}/login?error=invite_invalid`, 302)
      return
    }

    const state = randomBytes(16).toString('hex')
    reply.setCookie(this.stateCookieName, state, this.stateSetCookieOpts)
    reply.setCookie(this.inviteCookieName, `${state}:${token}`, this.inviteSetCookieOpts)
    // COPY-H-3 (copy-review PR #623 round 4): force Google's account
    // chooser — see AuthService.buildGoogleAuthUrl's doc for why this is
    // invite-only.
    const authUrl = this.authService.buildGoogleAuthUrl(state, { promptSelectAccount: true })
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

    // task-user-emails-invite: read BEFORE the Google exchange (below) so
    // the branch decision does not depend on anything Google returns —
    // clear unconditionally, whether or not this turns out to be an
    // invite round trip, so a stale cookie never lingers into a later,
    // unrelated login.
    const rawInviteCookie = request.cookies?.[this.inviteCookieName]
    reply.clearCookie(this.inviteCookieName, this.inviteClearCookieOpts)
    // SR-M-11 (security-review PR #623 round 4): the cookie's value is
    // `${state}:${token}` (see startInviteAccept's doc) — only treat this
    // as an invite-accept round trip when the embedded state matches THIS
    // callback's `state` query param. A cookie left over from an earlier,
    // already-finished (or naively forged) invite round carries a
    // DIFFERENT state and is ignored here, falling through to the ordinary
    // login path below instead of hijacking it.
    const [cookieState, inviteToken] = rawInviteCookie?.split(':') ?? []
    const isInviteRound = Boolean(inviteToken) && cookieState === state

    let googleUser: { id: string; email: string; name: string; picture: string }
    try {
      const tokens = await this.authService.exchangeGoogleCode(code)
      googleUser = await this.authService.getGoogleUserInfo(tokens.access_token)
    } catch (err) {
      this.logger.error('Google OAuth callback failed', err)
      await reply.redirect(`${this.frontendUrl}/login?error=google_error`, 302)
      return
    }

    if (isInviteRound) {
      // Invite-accept branch (task §2 — "Точка приёма"). No session is
      // minted here — Google has confirmed WHO is in the browser, but that
      // is all this branch does anything with. The person still has to hit
      // the ordinary "Войти с Google" button afterwards to actually sign
      // in, same as anyone else.
      try {
        await this.usersService.acceptPersonalEmailInvite(
          // Non-null: `isInviteRound` already asserted `Boolean(inviteToken)`.
          inviteToken!,
          googleUser.email,
          googleUser.id,
        )
      } catch (err) {
        await reply.redirect(`${this.frontendUrl}/login?error=${mapInviteAcceptError(err)}`, 302)
        return
      }
      await reply.redirect(`${this.frontendUrl}/login?invited=1`, 302)
      return
    }

    // §4.4/§5: lookup goes through user_emails (findLoginableEmailRow),
    // NOT users.email directly — a personal address that exists but has not
    // been activated via invite-accept must behave exactly like "not
    // found" here, not like a valid login.
    const emailRow = await this.usersService.findLoginableEmailRow(googleUser.email)
    const user = emailRow ? await this.usersService.findById(emailRow.userId) : undefined
    if (!emailRow || !user) {
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

    if (!(await this.verifyOrBindGoogleIdentity(user, emailRow, googleUser.id, 'OAuth callback'))) {
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

  /**
   * task-user-emails-invite: Google-identity binding, scoped to whichever
   * `user_emails` ROW matched the login (see `findLoginableEmailRow`) —
   * not to the user as a whole. WORK rows bind/verify against
   * `users.googleId`, EXACTLY as before this task (three prior security-
   * review rounds covered that path; this branch is byte-for-byte the same
   * check, only moved into a shared helper). PERSONAL rows bind/verify
   * against their OWN `user_emails.google_id` instead — see that column's
   * comment in schema.ts for why one shared slot cannot serve both a
   * corporate WORK account and a personal one, which are, by construction,
   * different Google accounts.
   *
   * Threat model preserved 1:1 per row (Audit LOW #3's rationale: refuse
   * rather than silently honour a changed `sub` for an address that
   * already has one bound) — this only changes WHERE the previously-bound
   * `sub` is looked up, never whether a mismatch is rejected.
   *
   * Returns `true` on success (already matched, or bound for the first
   * time); `false` on mismatch — logs the same way the pre-existing WORK
   * check already did, callers decide how to fail (redirect vs 401).
   */
  private async verifyOrBindGoogleIdentity(
    user: User,
    emailRow: UserEmail,
    incomingGoogleId: string,
    logSuffix: string,
  ): Promise<boolean> {
    if (emailRow.kind === 'WORK') {
      if (!user.googleId) {
        await this.usersService.updateGoogleId(user.id, incomingGoogleId)
        return true
      }
      if (user.googleId !== incomingGoogleId) {
        // MED (security-review): log user.id only — never raw email (PII).
        this.logger.warn(`Google account mismatch (${logSuffix}) for user id=${user.id}`)
        return false
      }
      return true
    }

    // PERSONAL. Defensive-only null branch: `acceptPersonalEmailInvite` is
    // the sole writer of a PERSONAL row's `googleId`, and it always sets it
    // in the SAME transaction that flips `canLogin` to true — a
    // `canLogin=true` PERSONAL row with no `googleId` is a data
    // inconsistency this code should never actually reach, not a
    // legitimate first-time bind. Still bind rather than throw, mirroring
    // the WORK branch's shape, so a bug here degrades to "logged in" rather
    // than "locked out".
    if (!emailRow.googleId) {
      await this.usersService.updateEmailRowGoogleId(emailRow.id, incomingGoogleId)
      return true
    }
    if (emailRow.googleId !== incomingGoogleId) {
      this.logger.warn(
        `Google account mismatch (${logSuffix}, personal address) for user id=${user.id}`,
      )
      return false
    }
    return true
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

    // §4.4/§5 — same rationale as googleCallback above.
    const emailRow = await this.usersService.findLoginableEmailRow(googleUser.email)
    const user = emailRow ? await this.usersService.findById(emailRow.userId) : undefined
    if (!emailRow || !user) throw new UnauthorizedException('Email not authorized')

    // LOW (security-audit authz-hardening): mirrors the same check in
    // googleCallback — an archived (fired) user must never receive a
    // session, not even a 401-request's worth of DB re-hydration lag.
    if (user.archivedAt) throw new UnauthorizedException('Account disabled')

    if (!(await this.verifyOrBindGoogleIdentity(user, emailRow, googleUser.sub, 'one-tap'))) {
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

    // §4.4/§5 — same rationale as googleCallback above: dev-login stands in
    // for real OAuth login, so it must respect the same canLogin gate (an
    // E2E/dev script exercising "personal email cannot log in yet" needs
    // this path to behave identically to the real one).
    const user = await this.usersService.findLoginableUserByEmail(body.email)
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

/**
 * LOW-1/LOW-2 (security-review PR #623 round 4): `acceptPersonalEmailInvite`
 * throws two DIFFERENT situations under the SAME exception type
 * (`ForbiddenException` for "wrong Google account" vs "target archived";
 * `ConflictException` for "token already used" vs "Google account bound
 * elsewhere") — `instanceof` alone cannot tell them apart, only the
 * message can. Extracts the plain string from the `{ statusCode, message,
 * error }` shape every `new XException('msg')` call in this codebase
 * produces.
 */
function exceptionMessage(err: ForbiddenException | ConflictException): string {
  const response = err.getResponse()
  if (typeof response === 'string') return response
  const message = (response as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

/**
 * task-user-emails-invite: maps `UsersService.acceptPersonalEmailInvite`'s
 * exceptions to the `?error=` code `googleCallback`'s invite branch
 * redirects with — the login page (`login.tsx`) owns the Russian copy
 * shown for each. Kept as a free function (not a private method) since it
 * has no dependency on controller state — a pure exception → string map.
 */
function mapInviteAcceptError(err: unknown): string {
  if (err instanceof ForbiddenException) {
    // LOW-2: target account was archived (fired) after the invite was
    // issued — reuse the SAME code the ordinary login path already emits
    // for a fired user, rather than the generic mismatch message.
    return exceptionMessage(err) === INVITE_TARGET_ARCHIVED_MESSAGE
      ? 'account_disabled'
      : 'invite_email_mismatch'
  }
  if (err instanceof ConflictException) {
    // LOW-1: the confirming Google account is already bound to a DIFFERENT
    // user_emails row — this token was NOT used (used_at stays NULL, the
    // whole transaction rolled back), so calling it "used" would be false.
    return exceptionMessage(err) === GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE
      ? 'invite_account_taken'
      : 'invite_used'
  }
  if (err instanceof BadRequestException) return 'invite_expired'
  // NotFoundException and anything unexpected — same bucket as "garbage
  // link": nothing more specific to tell the visitor.
  return 'invite_invalid'
}
