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

const STATE_COOKIE = 'oauth_state'
const JWT_COOKIE = 'jwt'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days in seconds

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name)
  private readonly frontendUrl: string
  private readonly isProduction: boolean

  constructor(
    private authService: AuthService,
    private usersService: UsersService,
    private jwtService: JwtService,
    private config: ConfigService<Env>,
  ) {
    this.frontendUrl = this.config.get('FRONTEND_URL', { infer: true })!
    this.isProduction = this.config.get('NODE_ENV', { infer: true }) === 'production'
  }

  @Get('google')
  @Public()
  async initiateGoogleAuth(@Res() reply: FastifyReply) {
    const state = randomBytes(16).toString('hex')
    const authUrl = this.authService.buildGoogleAuthUrl(state)

    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: 600,
      path: '/',
    })
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
    const storedState = request.cookies?.[STATE_COOKIE]
    if (!storedState || storedState !== state || !code) {
      await reply.redirect(`${this.frontendUrl}/login?error=invalid_state`, 302)
      return
    }

    reply.clearCookie(STATE_COOKIE, { path: '/' })

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

    reply.setCookie(JWT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })

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
    if (!fresh) return user
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
   * no-audit — intentional owner decision (no per-action attribution required).
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

    reply.setCookie(JWT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })

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

    reply.setCookie(JWT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })

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

    reply.setCookie(JWT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })

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
    reply.clearCookie(JWT_COOKIE, { path: '/' })
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
    reply.setCookie(JWT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })

    return { ok: true, user: jwtPayload }
  }
}
