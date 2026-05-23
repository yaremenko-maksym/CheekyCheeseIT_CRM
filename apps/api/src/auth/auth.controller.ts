import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { sessionUserSchema } from '@crm/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import type { Env } from '../config/env'
import { UsersService } from '../users/users.service'
import { AuthService } from './auth.service'
import { CurrentUser } from './current-user.decorator'
import { JwtAuthGuard } from './jwt.guard'

const STATE_COOKIE = 'oauth_state'
const JWT_COOKIE = 'jwt'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days in seconds

@Controller('auth')
export class AuthController {
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
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const storedState = request.cookies?.[STATE_COOKIE]
    if (!storedState || storedState !== state || !code) {
      await reply.redirect(`${this.frontendUrl}/crm/login?error=invalid_state`, 302)
      return
    }

    reply.clearCookie(STATE_COOKIE, { path: '/' })

    let googleUser: { id: string; email: string; name: string; picture: string }
    try {
      const tokens = await this.authService.exchangeGoogleCode(code)
      googleUser = await this.authService.getGoogleUserInfo(tokens.access_token)
    } catch {
      await reply.redirect(`${this.frontendUrl}/crm/login?error=google_error`, 302)
      return
    }

    const user = await this.usersService.findByEmail(googleUser.email)
    if (!user) {
      await reply.redirect(`${this.frontendUrl}/crm/login?error=unauthorized`, 302)
      return
    }

    if (!user.googleId) {
      await this.usersService.updateGoogleId(user.id, googleUser.id)
    }

    const payload = sessionUserSchema.parse({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar ?? null,
      role: user.role,
      seniorSharePercent: user.seniorSharePercent,
    })

    const token = this.jwtService.sign(payload)

    reply.setCookie(JWT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProduction,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })

    await reply.redirect(`${this.frontendUrl}/crm`, 302)
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: ReturnType<typeof sessionUserSchema.parse>) {
    // Re-hydrate latest displayName / avatar / avatarOverride from DB so global header
    // reflects edits without a re-login. Role is taken from DB too (audit-friendly).
    const fresh = await this.usersService.findById(user.id)
    if (!fresh) return user
    return sessionUserSchema.parse({
      id: fresh.id,
      email: fresh.email,
      displayName: fresh.displayName,
      avatar: fresh.avatar ?? null,
      avatarOverride: fresh.avatarOverride ?? null,
      role: fresh.role,
      seniorSharePercent: fresh.seniorSharePercent,
    })
  }

  @Post('google/one-tap')
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
    }

    const payload = sessionUserSchema.parse({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar ?? null,
      role: user.role,
      seniorSharePercent: user.seniorSharePercent,
    })

    const token = this.jwtService.sign(payload)

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
  async logout(@Res() reply: FastifyReply) {
    reply.clearCookie(JWT_COOKIE, { path: '/' })
    await reply.redirect(`${this.frontendUrl}/crm/login`, 302)
  }

  // DEV ONLY — быстрый вход по email без Google OAuth
  @Post('dev-login')
  @HttpCode(HttpStatus.OK)
  async devLogin(
    @Body() body: { email: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (this.isProduction) throw new UnauthorizedException('Not available in production')

    const user = await this.usersService.findByEmail(body.email)
    if (!user) throw new NotFoundException(`User ${body.email} not found in DB`)

    const payload = sessionUserSchema.parse({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar ?? null,
      role: user.role,
      seniorSharePercent: user.seniorSharePercent,
    })

    const token = this.jwtService.sign(payload)
    reply.setCookie(JWT_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })

    return { ok: true, user: payload }
  }
}
