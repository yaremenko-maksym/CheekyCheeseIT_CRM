import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsersService } from '../users/users.service'
import { JwtAuthGuard, LEGACY_JWT_COOKIE_FALLBACK_CUTOFF } from './jwt.guard'
import { IS_PUBLIC_KEY } from './public.decorator'

// ── Test helpers ────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-secret-32-chars-minimum-xx'

function makeCtx(cookies: Record<string, string> = {}, isPublic = false): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ cookies }),
    }),
    getHandler: () => ({ isPublic }),
    getClass: () => ({ isPublic: false }),
  } as unknown as ExecutionContext
}

function makeReflector(isPublic = false): Reflector {
  return {
    getAllAndOverride: (key: unknown) => (key === IS_PUBLIC_KEY ? isPublic : undefined),
  } as unknown as Reflector
}

// ── Original tests (regression pins — must stay green) ──────────────────────

describe('JwtAuthGuard — original behavior (regression)', () => {
  const jwtService = new JwtService({ secret: TEST_SECRET })

  it('throws when no cookie present', async () => {
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(makeCtx())).rejects.toThrow(UnauthorizedException)
  })

  it('throws when token is invalid', async () => {
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(makeCtx({ jwt: 'bad.token.here' }))).rejects.toThrow(
      UnauthorizedException,
    )
  })

  it('returns true and attaches user for a valid token (no UsersService — fallback to payload role)', async () => {
    // Use a valid UUID in the payload to pass jwtPayloadSchema validation.
    const payload = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@b.com',
      role: 'ADMIN',
    }
    const token = jwtService.sign(payload)
    const request: Record<string, unknown> = { cookies: { jwt: token } }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext
    // No UsersService provided → guard sets req.user directly from payload
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect((request.user as Record<string, unknown>)['id']).toBe(
      '00000000-0000-0000-0000-000000000001',
    )
  })

  it('bypasses verification when handler is marked @Public()', async () => {
    const guard = new JwtAuthGuard(jwtService, makeReflector(true), undefined)
    // No cookie present — would normally 401. With @Public() it returns true.
    await expect(guard.canActivate(makeCtx())).resolves.toBe(true)
  })
})

// ── AC3 — algorithm allowlist + payload re-validation ───────────────────────
// jwt.verify() must reject tokens with unexpected algorithm and malformed
// payloads. These tests cover the security hardening introduced in
// fix/auth-hardening (SEC-17).

describe('JwtAuthGuard — AC3: algorithm allowlist + payload schema validation', () => {
  const jwtService = new JwtService({ secret: TEST_SECRET })

  it('rejects a token signed with none algorithm (alg confusion)', async () => {
    // Craft a token with alg:none by manipulating the header.
    // The jsonwebtoken library (used under the hood by @nestjs/jwt) throws when
    // algorithms allowlist is ['HS256'] and the token header says alg=none.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(
      JSON.stringify({
        id: '00000000-0000-0000-0000-000000000001',
        email: 'a@b.com',
        role: 'ADMIN',
      }),
    ).toString('base64url')
    const noneToken = `${header}.${body}.`

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(makeCtx({ jwt: noneToken }))).rejects.toThrow(
      UnauthorizedException,
    )
  })

  it('rejects a payload that does not match jwtPayloadSchema (missing role)', async () => {
    // Token signed correctly but payload missing role field → schema validation fails.
    const badPayload = { id: '00000000-0000-0000-0000-000000000001', email: 'a@b.com' }
    const token = jwtService.sign(badPayload)
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(makeCtx({ jwt: token }))).rejects.toThrow(UnauthorizedException)
  })

  it('rejects a payload with invalid UUID id', async () => {
    const badPayload = { id: 'not-a-uuid', email: 'a@b.com', role: 'ADMIN' }
    const token = jwtService.sign(badPayload)
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(makeCtx({ jwt: token }))).rejects.toThrow(UnauthorizedException)
  })

  it('rejects a payload with invalid email', async () => {
    const badPayload = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'not-email',
      role: 'ADMIN',
    }
    const token = jwtService.sign(badPayload)
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(makeCtx({ jwt: token }))).rejects.toThrow(UnauthorizedException)
  })

  it('accepts a fully valid HS256 token with correct schema', async () => {
    const payload = { id: '00000000-0000-0000-0000-000000000001', email: 'a@b.com', role: 'ADMIN' }
    const token = jwtService.sign(payload)
    const request: Record<string, unknown> = { cookies: { jwt: token } }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })
})

// ── AC2 — fresh role from DB + archived user rejection ──────────────────────
// After JWT verify, guard must re-read role from DB (with cache TTL) and
// reject archived users even if their JWT is still valid.

describe('JwtAuthGuard — AC2: DB role re-hydration + archived user rejection', () => {
  const jwtService = new JwtService({ secret: TEST_SECRET })

  function makeCtxWithRequest(cookies: Record<string, string>): {
    ctx: ExecutionContext
    request: Record<string, unknown>
  } {
    const request: Record<string, unknown> = { cookies }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext
    return { ctx, request }
  }

  it('uses fresh role from DB when UsersService is provided (stale role in token overridden)', async () => {
    // Token says JUNIOR; DB says SENIOR — guard must store SENIOR in req.user.role.
    const tokenPayload = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@b.com',
      role: 'JUNIOR',
    }
    const token = jwtService.sign(tokenPayload)
    const { ctx, request } = makeCtxWithRequest({ jwt: token })

    const mockUsersService = {
      findById: vi.fn().mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000001',
        email: 'a@b.com',
        role: 'SENIOR',
        archivedAt: null,
      }),
    } as unknown as UsersService

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), mockUsersService)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    const user = request.user as Record<string, unknown>
    expect(user['role']).toBe('SENIOR')
    expect(user['id']).toBe('00000000-0000-0000-0000-000000000001')
  })

  it('throws 401 when user is archived (archivedAt set) even with valid JWT', async () => {
    const tokenPayload = {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'b@b.com',
      role: 'SENIOR',
    }
    const token = jwtService.sign(tokenPayload)
    const { ctx } = makeCtxWithRequest({ jwt: token })

    const mockUsersService = {
      findById: vi.fn().mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000002',
        email: 'b@b.com',
        role: 'SENIOR',
        archivedAt: new Date('2026-01-01'),
      }),
    } as unknown as UsersService

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), mockUsersService)
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('throws 401 when user is not found in DB (deleted after token issue)', async () => {
    const tokenPayload = {
      id: '00000000-0000-0000-0000-000000000003',
      email: 'c@b.com',
      role: 'ADMIN',
    }
    const token = jwtService.sign(tokenPayload)
    const { ctx } = makeCtxWithRequest({ jwt: token })

    const mockUsersService = {
      findById: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsersService

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), mockUsersService)
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('falls back to payload role gracefully when UsersService is absent (undefined)', async () => {
    // When no UsersService injected, guard still works using payload role.
    const payload = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@b.com',
      role: 'ADMIN',
    }
    const token = jwtService.sign(payload)
    const { ctx, request } = makeCtxWithRequest({ jwt: token })

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    const user = request.user as Record<string, unknown>
    expect(user['role']).toBe('ADMIN')
  })

  it('cache: does not call UsersService twice within cache TTL (same user, same guard instance)', async () => {
    const tokenPayload = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@b.com',
      role: 'JUNIOR',
    }
    const token = jwtService.sign(tokenPayload)

    const mockFindById = vi.fn().mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      email: 'a@b.com',
      role: 'SENIOR',
      archivedAt: null,
    })
    const mockUsersService = { findById: mockFindById } as unknown as UsersService

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), mockUsersService)

    // Two requests back-to-back with the same token.
    for (let i = 0; i < 2; i++) {
      const { ctx } = makeCtxWithRequest({ jwt: token })
      await expect(guard.canActivate(ctx)).resolves.toBe(true)
    }

    // DB should only be called once (second hit comes from in-memory cache).
    expect(mockFindById).toHaveBeenCalledTimes(1)
  })

  it('throws 401 on cache-HIT when user was archived within TTL (archivedAt in cached entry)', async () => {
    // Scenario: user is archived AFTER the first request caches their record.
    // The cache entry now has archivedAt set. A subsequent request (cache-HIT)
    // must still be rejected — not served the cached role.
    const tokenPayload = {
      id: '00000000-0000-0000-0000-000000000004',
      email: 'd@b.com',
      role: 'SENIOR',
    }
    const token = jwtService.sign(tokenPayload)

    // First request: DB returns archivedAt set (user was archived).
    const mockFindById = vi.fn().mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000004',
      email: 'd@b.com',
      role: 'SENIOR',
      archivedAt: new Date('2026-07-01'),
    })
    const mockUsersService = { findById: mockFindById } as unknown as UsersService
    const guard = new JwtAuthGuard(jwtService, makeReflector(false), mockUsersService)

    // First call — cache miss → DB hit → archivedAt stored in cache → 401.
    const { ctx: ctx1 } = makeCtxWithRequest({ jwt: token })
    await expect(guard.canActivate(ctx1)).rejects.toThrow(UnauthorizedException)

    // Second call — cache HIT (entry still within TTL) → must also 401.
    // DB should NOT be called again (the cache-HIT path handles rejection).
    const { ctx: ctx2 } = makeCtxWithRequest({ jwt: token })
    await expect(guard.canActivate(ctx2)).rejects.toThrow(UnauthorizedException)

    // Only 1 DB call — the second rejection came from the cache.
    expect(mockFindById).toHaveBeenCalledTimes(1)
  })
})

// ── MED-1 (security-review round 2): bounded legacy-cookie fallback ───────
//
// The `__Host-jwt` / `jwt` fallback read is a session-fixation surface for
// as long as it accepts the legacy name unconditionally (a `jwt` cookie set
// from ANY sibling subdomain of the registrable domain — XSS on the
// landing, subdomain takeover, MITM on a plain-http sibling — is honored
// exactly like a real session). It must be bounded:
//   1. PRODUCTION ONLY — dev/test/CI never issue `__Host-jwt` at all, so a
//      plain `jwt` cookie there is the permanent correct name, not a
//      "legacy" one to expire (pinned by the "original behavior" describe
//      block above, which stays green with NODE_ENV left at its test-env
//      default throughout this whole file).
//   2. Even in production, only until `LEGACY_JWT_COOKIE_FALLBACK_CUTOFF`
//      (≤ COOKIE_MAX_AGE / 7 days after this fix ships — no legacy-named
//      cookie can be older than that).
describe('JwtAuthGuard — MED-1: legacy jwt-cookie fallback is bounded to production + cutoff', () => {
  const jwtService = new JwtService({ secret: TEST_SECRET })
  const originalNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    vi.useRealTimers()
  })

  function makeCtxWithRequest(cookies: Record<string, string>): ExecutionContext {
    const request: Record<string, unknown> = { cookies }
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext
  }

  it('PROD, before cutoff: legacy `jwt` cookie (no __Host-jwt) still authenticates', async () => {
    process.env.NODE_ENV = 'production'
    vi.useFakeTimers()
    vi.setSystemTime(LEGACY_JWT_COOKIE_FALLBACK_CUTOFF.getTime() - 1000)

    const payload = { id: '00000000-0000-0000-0000-000000000005', email: 'e@b.com', role: 'ADMIN' }
    const token = jwtService.sign(payload)
    const ctx = makeCtxWithRequest({ jwt: token })

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('PROD, AFTER cutoff: legacy `jwt` cookie (no __Host-jwt) is rejected — 401, not silently accepted', async () => {
    process.env.NODE_ENV = 'production'
    vi.useFakeTimers()
    vi.setSystemTime(LEGACY_JWT_COOKIE_FALLBACK_CUTOFF.getTime() + 1000)

    const payload = { id: '00000000-0000-0000-0000-000000000006', email: 'f@b.com', role: 'ADMIN' }
    const token = jwtService.sign(payload)
    const ctx = makeCtxWithRequest({ jwt: token })

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('PROD, AFTER cutoff: __Host-jwt (the real prod name) still authenticates fine', async () => {
    process.env.NODE_ENV = 'production'
    vi.useFakeTimers()
    vi.setSystemTime(LEGACY_JWT_COOKIE_FALLBACK_CUTOFF.getTime() + 1000)

    const payload = { id: '00000000-0000-0000-0000-000000000007', email: 'g@b.com', role: 'ADMIN' }
    const token = jwtService.sign(payload)
    const ctx = makeCtxWithRequest({ '__Host-jwt': token })

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('DEV/TEST, past the cutoff date: legacy `jwt` cookie STILL authenticates (not a "legacy" name outside prod)', async () => {
    process.env.NODE_ENV = 'test'
    vi.useFakeTimers()
    vi.setSystemTime(LEGACY_JWT_COOKIE_FALLBACK_CUTOFF.getTime() + 365 * 24 * 60 * 60 * 1000)

    const payload = { id: '00000000-0000-0000-0000-000000000008', email: 'h@b.com', role: 'ADMIN' }
    const token = jwtService.sign(payload)
    const ctx = makeCtxWithRequest({ jwt: token })

    const guard = new JwtAuthGuard(jwtService, makeReflector(false), undefined)
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })
})
