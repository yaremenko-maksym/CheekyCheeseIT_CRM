import {
  Body,
  Controller,
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
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { jwtPayloadSchema, sessionUserSchema, type JwtPayload } from '@crm/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import type { Env } from '../config/env'
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

    if (!user.googleId) {
      await this.usersService.updateGoogleId(user.id, googleUser.id)
    } else if (user.googleId !== googleUser.id) {
      // Audit LOW #3: the email is already bound to a DIFFERENT Google `sub`.
      // Refuse rather than silently honouring the existing binding — protects
      // against account-takeover via email reuse / re-issued Google accounts.
      this.logger.warn(`Google account mismatch for ${user.email}`)
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
    })
  }

  @Post('google/one-tap')
  @Public()
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

    if (!user.googleId) {
      await this.usersService.updateGoogleId(user.id, googleUser.sub)
    } else if (user.googleId !== googleUser.sub) {
      // Audit LOW #3: incoming Google `sub` differs from the one already bound
      // to this email — reject instead of ignoring the mismatch.
      this.logger.warn(`Google account mismatch (one-tap) for ${user.email}`)
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

  @Get('logout')
  @Public()
  async logout(@Res() reply: FastifyReply) {
    reply.clearCookie(JWT_COOKIE, { path: '/' })
    await reply.redirect(`${this.frontendUrl}/login`, 302)
  }

  // DEV ONLY — быстрый вход по email без Google OAuth
  @Post('dev-login')
  @Public()
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
