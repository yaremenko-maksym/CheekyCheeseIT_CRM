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
    updateGoogleId: vi.fn().mockResolvedValue(undefined),
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

/**
 * Extended FastifyReply stub that ALSO records `setCookie` options (for
 * asserting `secure`) and `clearCookie` calls (for asserting logout clears
 * every legacy name), plus a no-op `redirect` so handlers using `@Res()`
 * (not `passthrough`) can run to completion without a real Fastify reply.
 */
function makeFullReply(): FastifyReply & {
  _cookies: Record<string, { value: string; opts: Record<string, unknown> }>
  _cleared: string[]
} {
  const reply = {
    _cookies: {} as Record<string, { value: string; opts: Record<string, unknown> }>,
    _cleared: [] as string[],
    setCookie(name: string, value: string, opts: Record<string, unknown>) {
      this._cookies[name] = { value, opts }
      return this
    },
    clearCookie(name: string) {
      this._cleared.push(name)
      return this
    },
    redirect: vi.fn().mockResolvedValue(undefined),
  }
  return reply as unknown as FastifyReply & {
    _cookies: Record<string, { value: string; opts: Record<string, unknown> }>
    _cleared: string[]
  }
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

/**
 * Cookie hardening — security-audit authz-hardening "плюс" finding.
 *
 * PROBLEM: the session cookie was named `jwt` with no `__Host-` prefix and
 * no `Domain` restriction. The public landing (cheekycheese.tech) and the
 * CRM (app.cheekycheese.tech) are siblings under the same registrable
 * domain, so a cookie without the `__Host-` prefix can be set/overridden
 * from a sibling subdomain (Domain-scoped cookie spoofing). `__Host-`
 * forces the browser to enforce Secure + Path=/ + no Domain attribute.
 *
 * `__Host-` requires HTTPS (Secure) — dev runs over plain http, where a
 * `secure: true` cookie is silently dropped by the browser. So the prefix
 * is used ONLY when NODE_ENV=production; every other environment keeps the
 * legacy plain name (pinned by the R1-b / dev-mode cases below — no
 * regression for local dev, CI, or existing integration specs that inject
 * a plain `jwt`-named cookie).
 */
describe('AuthController — cookie hardening (__Host- prefix, prod only)', () => {
  it('PROD: initiateGoogleAuth sets __Host-oauth_state (Secure) instead of oauth_state', async () => {
    const authService = makeAuthService()
    ;(authService.buildGoogleAuthUrl as ReturnType<typeof vi.fn>).mockReturnValue(
      'https://accounts.google.com/o/oauth2/auth?...',
    )
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()

    await controller.initiateGoogleAuth(reply)

    expect(reply._cookies['__Host-oauth_state']).toBeDefined()
    expect(reply._cookies['__Host-oauth_state']!.opts['secure']).toBe(true)
    // The legacy plain name must NOT be used in production.
    expect(reply._cookies['oauth_state']).toBeUndefined()
  })

  it('DEV regression: initiateGoogleAuth still sets plain oauth_state (not __Host-)', async () => {
    const authService = makeAuthService()
    ;(authService.buildGoogleAuthUrl as ReturnType<typeof vi.fn>).mockReturnValue(
      'https://accounts.google.com/o/oauth2/auth?...',
    )
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('development'),
    )
    const reply = makeFullReply()

    await controller.initiateGoogleAuth(reply)

    expect(reply._cookies['oauth_state']).toBeDefined()
    expect(reply._cookies['oauth_state']!.opts['secure']).toBe(false)
    expect(reply._cookies['__Host-oauth_state']).toBeUndefined()
  })

  it('PROD: googleOneTap sets __Host-jwt (Secure) instead of jwt', async () => {
    const authService = makeAuthService()
    ;(authService.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      sub: 'google-sub',
      email: TEST_USER.email,
      name: TEST_USER.displayName,
      picture: 'p',
    })
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()

    const result = await controller.googleOneTap({ credential: 'cred' }, reply)

    expect(result).toEqual({ ok: true })
    expect(reply._cookies['__Host-jwt']).toBeDefined()
    expect(reply._cookies['__Host-jwt']!.opts['secure']).toBe(true)
    expect(reply._cookies['jwt']).toBeUndefined()
  })

  it('DEV regression: googleOneTap still sets plain jwt (not __Host-)', async () => {
    const authService = makeAuthService()
    ;(authService.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      sub: 'google-sub',
      email: TEST_USER.email,
      name: TEST_USER.displayName,
      picture: 'p',
    })
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('development'),
    )
    const reply = makeFullReply()

    await controller.googleOneTap({ credential: 'cred' }, reply)

    expect(reply._cookies['jwt']).toBeDefined()
    expect(reply._cookies['jwt']!.opts['secure']).toBe(false)
    expect(reply._cookies['__Host-jwt']).toBeUndefined()
  })

  it('PROD: logout clears BOTH __Host-jwt and the legacy jwt name', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()

    await controller.logout(reply)

    expect(reply._cleared).toContain('__Host-jwt')
    expect(reply._cleared).toContain('jwt')
  })
})
