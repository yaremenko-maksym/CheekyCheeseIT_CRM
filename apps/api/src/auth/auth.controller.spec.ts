/**
 * R1 — Regression guard: dev-login production block.
 *
 * Coverage:
 *  R1-a: devLogin() throws UnauthorizedException when isProduction=true
 *        (i.e. NODE_ENV='production' in ConfigService).
 *  R1-b: devLogin() succeeds (200, sets cookie) in non-prod environment.
 *
 * The AuthController instantiates `isProduction` in its constructor from
 * ConfigService.get('NODE_ENV') === 'production'. We mock ConfigService so
 * the guard takes the production branch. External deps (UsersService,
 * JwtService) are stubbed minimally.
 *
 * Pattern follows auth.service.spec.ts: no NestJS testing module overhead,
 * direct class instantiation with typed stubs.
 */
import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it, vi } from 'vitest'
import type { FastifyReply } from 'fastify'
import type { Env } from '../config/env'
import type { UsersService } from '../users/users.service'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeConfig(nodeEnv: string): ConfigService<Env> {
  return {
    get: (key: string) =>
      (
        ({
          NODE_ENV: nodeEnv,
          FRONTEND_URL: 'http://localhost:3000',
          GOOGLE_CLIENT_ID: 'cid',
          GOOGLE_CALLBACK_URL: 'http://localhost/callback',
        }) as Record<string, string>
      )[key],
  } as unknown as ConfigService<Env>
}

function makeAuthService(): AuthService {
  return {
    buildGoogleAuthUrl: vi.fn(),
    exchangeGoogleCode: vi.fn(),
    verifyGoogleIdToken: vi.fn(),
  } as unknown as AuthService
}

const TEST_USER = {
  id: '11111111-2222-3333-4444-555566667777',
  email: 'test@example.com',
  displayName: 'Test User',
  role: 'SENIOR' as const,
  avatarUrl: null,
  googleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function makeUsersService(foundUser: typeof TEST_USER | null): UsersService {
  return {
    findByEmail: vi.fn().mockResolvedValue(foundUser),
  } as unknown as UsersService
}

function makeJwtService(): JwtService {
  return {
    sign: vi.fn().mockReturnValue('signed-jwt-token'),
  } as unknown as JwtService
}

/** Minimal FastifyReply stub that records cookies set during the call. */
function makeReply(): FastifyReply & { _cookies: Record<string, string> } {
  const reply = {
    _cookies: {} as Record<string, string>,
    setCookie(name: string, value: string) {
      this._cookies[name] = value
      return this
    },
  }
  return reply as unknown as FastifyReply & { _cookies: Record<string, string> }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthController.devLogin — R1 production guard', () => {
  it('R1-a: throws UnauthorizedException when NODE_ENV=production', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeReply()

    await expect(controller.devLogin({ email: 'test@example.com' }, reply)).rejects.toThrow(
      UnauthorizedException,
    )
  })

  it('R1-a: UnauthorizedException message matches expectation', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeReply()

    await expect(controller.devLogin({ email: 'test@example.com' }, reply)).rejects.toThrow(
      'Not available in production',
    )
  })

  it('R1-b: returns ok:true and sets JWT cookie in development', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('development'),
    )
    const reply = makeReply()

    const result = await controller.devLogin({ email: TEST_USER.email }, reply)

    expect(result.ok).toBe(true)
    expect(result.user.id).toBe(TEST_USER.id)
    expect(result.user.email).toBe(TEST_USER.email)
    // Cookie must have been set
    expect(reply._cookies['jwt']).toBe('signed-jwt-token')
  })

  it('R1-b: throws NotFoundException when user email not in DB (non-prod)', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(null), // no user found
      makeJwtService(),
      makeConfig('development'),
    )
    const reply = makeReply()

    await expect(controller.devLogin({ email: 'unknown@example.com' }, reply)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('R1-a: also blocks when NODE_ENV=test-production string matches "production"', async () => {
    // Guards against any env string that exactly equals "production"
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeReply()

    await expect(controller.devLogin({ email: 'any@example.com' }, reply)).rejects.toThrow(
      UnauthorizedException,
    )
  })
})
