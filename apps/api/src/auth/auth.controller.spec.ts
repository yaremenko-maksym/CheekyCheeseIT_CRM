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
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it, vi } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JwtPayload } from '@crm/shared'
import type { Env } from '../config/env'
import {
  GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE,
  INVITE_TARGET_ARCHIVED_MESSAGE,
  type UsersService,
} from '../users/users.service'
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
    getGoogleUserInfo: vi.fn(),
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

/**
 * task-user-emails-invite: `googleCallback`/`googleOneTap` look up a
 * `user_emails` ROW (`findLoginableEmailRow`) instead of the user directly
 * — see `verifyOrBindGoogleIdentity`'s doc for why (per-row Google-identity
 * binding). SR-H-6 (security-review PR #623 round 5): `devLogin` now ALSO
 * calls `findLoginableEmailRow` (not `findLoginableUserByEmail`, whose stub
 * stays here only because `UsersService`'s real shape still has the method)
 * — the JWT it mints needs `emailRow.id` for `userEmailId`, same as the
 * other two login paths. Both stubs are backed by the SAME `foundUser`.
 */
function makeUsersService(foundUser: typeof TEST_USER | null): UsersService {
  const emailRow = foundUser
    ? {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        userId: foundUser.id,
        email: foundUser.email,
        kind: 'WORK' as const,
        verifiedAt: new Date(),
        canLogin: true,
        googleId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    : undefined
  return {
    // §4.4/§5: the controller's login lookups go through
    // findLoginableUserByEmail (devLogin) / findLoginableEmailRow
    // (googleCallback, googleOneTap) — user_emails, canLogin gate — not
    // findByEmail (which still exists on the real service for
    // createUser/adminUpdateUser's users.email conflict check — unrelated
    // to these login-path tests).
    findLoginableUserByEmail: vi.fn().mockResolvedValue(foundUser),
    findLoginableEmailRow: vi.fn().mockResolvedValue(emailRow),
    findById: vi.fn().mockResolvedValue(foundUser),
    updateGoogleId: vi.fn().mockResolvedValue(undefined),
    updateEmailRowGoogleId: vi.fn().mockResolvedValue(undefined),
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
 * asserting `secure`) and `clearCookie` calls WITH their options (for
 * asserting logout's Set-Cookie deletion actually carries `secure: true` in
 * prod — security-review round 2 HIGH-1: a stub that only recorded the
 * cleared cookie NAME, not its opts, is exactly what let the missing
 * `secure` attribute on `clearCookie` slip through the first time; the real
 * bug was that `reply.clearCookie(name, {path:'/'})` (no `secure`) makes
 * @fastify/cookie emit a `__Host-*` deletion header the browser discards
 * whole — so the cookie never actually gets cleared in production).
 * `redirect` is a no-op so handlers using `@Res()` (not `passthrough`) can
 * run to completion without a real Fastify reply.
 */
function makeFullReply(): FastifyReply & {
  _cookies: Record<string, { value: string; opts: Record<string, unknown> }>
  _cleared: Record<string, Record<string, unknown>>
} {
  const reply = {
    _cookies: {} as Record<string, { value: string; opts: Record<string, unknown> }>,
    _cleared: {} as Record<string, Record<string, unknown>>,
    setCookie(name: string, value: string, opts: Record<string, unknown>) {
      this._cookies[name] = { value, opts }
      return this
    },
    clearCookie(name: string, opts: Record<string, unknown> = {}) {
      this._cleared[name] = opts
      return this
    },
    redirect: vi.fn().mockResolvedValue(undefined),
  }
  return reply as unknown as FastifyReply & {
    _cookies: Record<string, { value: string; opts: Record<string, unknown> }>
    _cleared: Record<string, Record<string, unknown>>
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

    const promise = controller.devLogin({ email: 'unknown@example.com' }, reply)
    await expect(promise).rejects.toThrow(NotFoundException)
    // mutation-gate closure: kills the StringLiteral mutant that empties the
    // template literal (`` `` ``) — the message must actually NAME the
    // email that was not found, not just be "an error occurred".
    await expect(promise).rejects.toThrow('User unknown@example.com not found in DB')
  })

  // mutation-gate closure (round 5): kills the `!emailRow || !user` →
  // `!emailRow && !user` LogicalOperator mutant. `emailRow` and `user` are
  // NOT equivalent booleans in general — `emailRow` truthy but `findById`
  // returning `undefined` is a genuine (if rare) race between the two
  // reads, and only `||` catches it. Under `&&`, `!emailRow && !user` →
  // `false && true` → `false` → the guard does not throw, and the next
  // line reads `user.id` off `undefined` — a raw TypeError instead of the
  // clean NotFoundException this endpoint is supposed to give.
  it('R1-b: throws NotFoundException (not a raw TypeError) when the row resolves but the user row is gone (race)', async () => {
    const usersService = {
      findLoginableEmailRow: vi.fn().mockResolvedValue({
        id: 'aaaaaaaa-0000-4000-8000-000000000099',
        userId: TEST_USER.id,
        email: TEST_USER.email,
        kind: 'WORK',
      }),
      findById: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsersService
    const controller = new AuthController(
      makeAuthService(),
      usersService,
      makeJwtService(),
      makeConfig('development'),
    )
    const reply = makeReply()

    await expect(controller.devLogin({ email: TEST_USER.email }, reply)).rejects.toBeInstanceOf(
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

  // SR-M-11 (security-review PR #623 round 4): belt-and-suspenders — a
  // stale invite cookie from an earlier round trip must not survive into an
  // ordinary login. The state-binding in googleCallback is the primary
  // defense (own regression test above); this is the second layer.
  it('initiateGoogleAuth clears a leftover invite cookie', async () => {
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

    expect(Object.keys(reply._cleared)).toContain('__Host-invite_token')
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

  // LOW (security-review round 3, follow-up to #436): AC3 — `issueJwtCookie`
  // clears the legacy plain `jwt` cookie on every NEW `__Host-jwt` session
  // (see its doc — this is what shrinks the MED-1 legacy-fallback window as
  // users log in), but until now nothing asserted the CLEAR itself: the
  // sibling test above only checks that `jwt` was not SET as a new cookie.
  // A regression that silently dropped the `clearCookie` call from
  // `issueJwtCookie` would have passed every existing test.
  it('PROD: googleOneTap ALSO extinguishes the legacy jwt cookie on new session issuance', async () => {
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

    await controller.googleOneTap({ credential: 'cred' }, reply)

    expect(reply._cleared['jwt']).toBeDefined()
    expect(reply._cleared['jwt']!['secure']).toBe(true)
    expect(reply._cleared['jwt']!['path']).toBe('/')
  })

  it('DEV regression: googleOneTap does NOT clear jwt (it IS the live cookie name, nothing legacy to extinguish)', async () => {
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

    expect(reply._cleared['jwt']).toBeUndefined()
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

  it('PROD: logout clears BOTH __Host-jwt and jwt WITH secure:true (HIGH-1 regression guard)', async () => {
    // security-review round 2 HIGH-1: @fastify/cookie's clearCookie(name, opts)
    // builds its Set-Cookie header ONLY from the opts passed to THIS call (the
    // plugin is registered with only `{secret}` in main.ts — no parseOptions
    // fallback). A `__Host-*` deletion response without `secure: true` gets
    // silently discarded by the browser per the cookie-prefix rules, so the
    // cookie survives and "logout" does nothing. This is the exact regression
    // the previous round's stub (name-only, no opts) could not catch.
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()

    await controller.logout(reply)

    expect(Object.keys(reply._cleared)).toContain('__Host-jwt')
    expect(Object.keys(reply._cleared)).toContain('jwt')
    // The regression: secure MUST be true on the __Host-jwt clear in prod.
    expect(reply._cleared['__Host-jwt']!['secure']).toBe(true)
    expect(reply._cleared['__Host-jwt']!['path']).toBe('/')
    // Clearing the legacy name is defense-in-depth for browsers still
    // holding a pre-hardening cookie — its own opts must be well-formed too.
    expect(reply._cleared['jwt']!['secure']).toBe(true)
  })

  it('DEV regression: logout clears jwt with secure:false (no __Host- name to clear)', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('development'),
    )
    const reply = makeFullReply()

    await controller.logout(reply)

    expect(Object.keys(reply._cleared)).toEqual(['jwt'])
    expect(reply._cleared['jwt']!['secure']).toBe(false)
  })

  it('PROD: googleCallback clears __Host-oauth_state WITH secure:true (HIGH-1 regression guard)', async () => {
    const authService = makeAuthService()
    ;(authService.exchangeGoogleCode as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: 'at',
      id_token: 'it',
      expires_in: 3600,
    })
    ;(authService.getGoogleUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'google-sub',
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
    const request = {
      cookies: { '__Host-oauth_state': 'state-value' },
    } as unknown as FastifyRequest

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(Object.keys(reply._cleared)).toContain('__Host-oauth_state')
    expect(reply._cleared['__Host-oauth_state']!['secure']).toBe(true)
  })
})

/**
 * AuthController.me — LOW (security-review round 3, follow-up to #436).
 *
 * `me()`'s `!fresh` branch (DB row gone between JwtAuthGuard's own lookup
 * and this handler's re-query) used to `return user` — the raw JwtPayload,
 * skipping `sessionUserSchema.parse()` entirely. During impersonation that
 * raw payload carries `impersonatorId` verbatim, contradicting the schema's
 * own documented invariant that `/me` never emits that key. Unreachable in
 * production traffic (see the handler's doc), but worth pinning: a future
 * refactor that touches this branch should not silently reopen the leak.
 */
describe('AuthController.me — fallback shape when DB row is gone', () => {
  it('normal path: returns full sessionUser shape (regression pin)', async () => {
    const seniorWithShare = { ...TEST_USER, seniorSharePercent: 26 }
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(seniorWithShare),
      makeJwtService(),
      makeConfig('development'),
    )

    const result = await controller.me({
      id: TEST_USER.id,
      email: TEST_USER.email,
      role: TEST_USER.role,
    })

    expect(result.id).toBe(TEST_USER.id)
    expect(result.displayName).toBe(TEST_USER.displayName)
    expect(result).not.toHaveProperty('impersonatorId')
  })

  it('!fresh fallback: shapes the response through sessionUserSchema, no raw JwtPayload leak', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(null), // findById resolves undefined/null → !fresh branch
      makeJwtService(),
      makeConfig('development'),
    )

    const jwtUser: JwtPayload = {
      id: TEST_USER.id,
      email: TEST_USER.email,
      role: TEST_USER.role,
    }

    const result = await controller.me(jwtUser)

    expect(result.id).toBe(TEST_USER.id)
    expect(result.email).toBe(TEST_USER.email)
    expect(result.role).toBe(TEST_USER.role)
    expect(result.impersonating).toBe(false)
  })

  it('!fresh fallback under impersonation: never leaks impersonatorId, only the derived boolean', async () => {
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(null),
      makeJwtService(),
      makeConfig('development'),
    )

    const adminId = '99999999-8888-7777-6666-555544443333'
    const jwtUser: JwtPayload = {
      id: TEST_USER.id,
      email: TEST_USER.email,
      role: TEST_USER.role,
      impersonatorId: adminId,
    }

    const result = await controller.me(jwtUser)

    expect(result.impersonating).toBe(true)
    // The raw JwtPayload shape (what the old `return user` branch produced)
    // carried `impersonatorId` as an own key — the schema-shaped response
    // must not.
    expect(result).not.toHaveProperty('impersonatorId')
  })
})

/**
 * task-user-emails-invite: `googleCallback`'s invite branch (task §2 —
 * "Точка приёма") and `verifyOrBindGoogleIdentity`'s per-row Google-identity
 * binding — zero prior unit coverage (mutation gate, `--changed`: 13
 * survived + 35 no-coverage mutants). The 32 real-DB integration tests
 * (auth.oauth-callback / auth.one-tap / user-email-invites) prove the
 * REAL behaviour; the gate cannot execute an `*.integration.spec.ts` file
 * at all (mutation-gate-integration-specs.md), so from the gate's point of
 * view that coverage does not exist — these unit doubles are what make it
 * exist.
 */
function makeUsersServiceWithEmailRow(
  foundUser: typeof TEST_USER | null,
  overrides: Partial<{
    kind: 'WORK' | 'PERSONAL'
    /** `user_emails.google_id` (schema.ts) — the PERSONAL-row binding. */
    emailRowGoogleId: string | null
    /** `users.google_id` — the WORK/legacy binding `verifyOrBindGoogleIdentity`
     *  still reads for a WORK row (unchanged from before this task). */
    userGoogleId: string | null
  }> = {},
): UsersService & {
  acceptPersonalEmailInvite: ReturnType<typeof vi.fn>
} {
  const userWithGoogleId = foundUser
    ? { ...foundUser, googleId: overrides.userGoogleId ?? foundUser.googleId }
    : foundUser
  const emailRow = foundUser
    ? {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        userId: foundUser.id,
        email: foundUser.email,
        kind: overrides.kind ?? 'WORK',
        verifiedAt: new Date(),
        canLogin: true,
        googleId: overrides.emailRowGoogleId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    : undefined
  return {
    findLoginableUserByEmail: vi.fn().mockResolvedValue(userWithGoogleId),
    findLoginableEmailRow: vi.fn().mockResolvedValue(emailRow),
    findById: vi.fn().mockResolvedValue(userWithGoogleId),
    updateGoogleId: vi.fn().mockResolvedValue(undefined),
    updateEmailRowGoogleId: vi.fn().mockResolvedValue(undefined),
    acceptPersonalEmailInvite: vi.fn().mockResolvedValue(undefined),
  } as unknown as UsersService & { acceptPersonalEmailInvite: ReturnType<typeof vi.fn> }
}

// SR-M-11 (security-review PR #623 round 4): the invite cookie's value is
// `${state}:${token}`, not the bare token — googleCallback only honours it
// when the embedded state matches the SAME round's `state` query param.
// This helper defaults to embedding the SAME `state` passed in (the
// overwhelming majority of call sites test the matching-state path); pass
// `cookieState` explicitly to construct a MISMATCHED cookie.
function makeInviteRequest(
  state: string,
  inviteToken?: string,
  cookieState: string = state,
): FastifyRequest {
  const cookies: Record<string, string> = { '__Host-oauth_state': state }
  if (inviteToken !== undefined) cookies['__Host-invite_token'] = `${cookieState}:${inviteToken}`
  return { cookies } as unknown as FastifyRequest
}

/** Every URL `reply.redirect(...)` was called with, in order — `makeFullReply`
 * above (reused, not duplicated) leaves `redirect` a bare mock with no
 * recorded args; these tests care about WHICH url, so this reads it back
 * off the mock's own call log instead of adding a second reply stub. */
function redirectsOf(reply: FastifyReply): string[] {
  return (reply.redirect as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => c[0] as string,
  )
}

function setupGoogleUser(authService: AuthService, email: string, sub: string): void {
  ;(authService.exchangeGoogleCode as ReturnType<typeof vi.fn>).mockResolvedValue({
    access_token: 'at',
    id_token: 'it',
    expires_in: 3600,
  })
  ;(authService.getGoogleUserInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: sub,
    email,
    name: 'X',
    picture: 'p',
  })
}

describe('AuthController.startInviteAccept — GET /auth/invite/:token (task-user-emails-invite, spec §2)', () => {
  it('well-formed token: sets state + invite cookies and redirects to the Google auth URL', async () => {
    const authService = makeAuthService()
    ;(authService.buildGoogleAuthUrl as ReturnType<typeof vi.fn>).mockReturnValue(
      'https://accounts.google.com/o/oauth2/auth?state=abc',
    )
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const validToken = 'a'.repeat(64)

    await controller.startInviteAccept(validToken, reply)

    expect(redirectsOf(reply)).toEqual(['https://accounts.google.com/o/oauth2/auth?state=abc'])
    expect(Object.keys(reply._cookies)).toContain('__Host-oauth_state')
    // SR-M-11 (security-review PR #623 round 4): the cookie carries
    // `${state}:${token}`, not the bare token — googleCallback binds the
    // invite branch to THIS round's state (see that test suite below).
    const stateValue = reply._cookies['__Host-oauth_state']?.value
    expect(reply._cookies['__Host-invite_token']?.value).toBe(`${stateValue}:${validToken}`)
    // COPY-H-3 (copy-review PR #623 round 4): forces Google's account
    // chooser on the invite round trip specifically.
    expect(authService.buildGoogleAuthUrl).toHaveBeenCalledWith(stateValue, {
      promptSelectAccount: true,
    })
  })

  it('DEV: uses the plain (non-__Host-) cookie names — INVITE_COOKIE_LEGACY / STATE_COOKIE_LEGACY', async () => {
    const authService = makeAuthService()
    ;(authService.buildGoogleAuthUrl as ReturnType<typeof vi.fn>).mockReturnValue(
      'https://accounts.google.com/o/oauth2/auth?state=abc',
    )
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('development'),
    )
    const reply = makeFullReply()
    const validToken = 'b'.repeat(64)

    await controller.startInviteAccept(validToken, reply)

    expect(Object.keys(reply._cookies)).toEqual(
      expect.arrayContaining(['oauth_state', 'invite_token']),
    )
    const stateValue = reply._cookies['oauth_state']?.value
    expect(reply._cookies['invite_token']?.value).toBe(`${stateValue}:${validToken}`)
    expect(Object.keys(reply._cookies)).not.toContain('__Host-invite_token')
  })

  it('malformed token (not 64 hex chars) → redirects to /login?error=invite_invalid, never touches Google', async () => {
    const authService = makeAuthService()
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()

    await controller.startInviteAccept('not-a-valid-token', reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_invalid'])
    expect(authService.buildGoogleAuthUrl).not.toHaveBeenCalled()
    expect(Object.keys(reply._cookies)).toHaveLength(0)
  })

  it('64 valid hex chars with extra characters AFTER them → rejected (kills the missing-$-anchor mutant)', async () => {
    const authService = makeAuthService()
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()

    await controller.startInviteAccept(`${'a'.repeat(64)}EXTRA`, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_invalid'])
    expect(authService.buildGoogleAuthUrl).not.toHaveBeenCalled()
  })

  it('64 valid hex chars with extra characters BEFORE them → rejected (kills the missing-^-anchor mutant)', async () => {
    const authService = makeAuthService()
    const controller = new AuthController(
      authService,
      makeUsersService(TEST_USER),
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()

    await controller.startInviteAccept(`EXTRA${'a'.repeat(64)}`, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_invalid'])
    expect(authService.buildGoogleAuthUrl).not.toHaveBeenCalled()
  })
})

describe('AuthController.googleCallback — invite-accept branch (task-user-emails-invite, spec §2)', () => {
  it('invite cookie present + accept succeeds → redirects to /login?invited=1, mints NO session (task §2: "Токен НЕ выдаёт сессию")', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(usersService.acceptPersonalEmailInvite).toHaveBeenCalledWith(
      'raw-token-abc',
      TEST_USER.email,
      'google-sub',
    )
    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?invited=1'])
    expect(jwtService.sign).not.toHaveBeenCalled()
    expect(Object.keys(reply._cookies)).not.toContain('__Host-jwt')
    // Invite cookie is always cleared, whether or not it turns out to be a
    // real invite round trip.
    expect(Object.keys(reply._cleared)).toContain('__Host-invite_token')
  })

  it('invite cookie present but the address does not match → redirects with the mismatch error code, no session', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, 'someone-else@example.com', 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    ;(usersService.acceptPersonalEmailInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ForbiddenException('Адрес аккаунта Google не совпадает с приглашённым адресом'),
    )
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_email_mismatch'])
    expect(jwtService.sign).not.toHaveBeenCalled()
  })

  it('invite cookie present, token already used → redirects with the invite_used error code', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    ;(usersService.acceptPersonalEmailInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ConflictException('Приглашение уже использовано'),
    )
    const controller = new AuthController(
      authService,
      usersService,
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_used'])
  })

  // LOW-1 (security-review PR #623 round 4): a ConflictException with the
  // DISTINCT google_id-collision message must map to a DIFFERENT ?error=
  // code than "already used" (invite_used above) — same exception TYPE,
  // different situation.
  it('invite cookie present, Google account already bound elsewhere → redirects with invite_account_taken (NOT invite_used)', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    ;(usersService.acceptPersonalEmailInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ConflictException(GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE),
    )
    const controller = new AuthController(
      authService,
      usersService,
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_account_taken'])
  })

  // LOW-2 (security-review PR #623 round 4): a ForbiddenException with the
  // DISTINCT archived-target message must map to account_disabled — the
  // SAME code the ordinary login path uses for a fired user, not the
  // generic mismatch message.
  it('invite cookie present, target account archived → redirects with account_disabled (NOT invite_email_mismatch)', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    ;(usersService.acceptPersonalEmailInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ForbiddenException(INVITE_TARGET_ARCHIVED_MESSAGE),
    )
    const controller = new AuthController(
      authService,
      usersService,
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=account_disabled'])
  })

  // exceptionMessage's defensive fallback (`typeof message === 'string' ?
  // message : ''`) had zero coverage — every OTHER test in this file
  // constructs exceptions with a plain string body, whose getResponse()
  // ALWAYS carries a string .message (verified empirically against
  // @nestjs/common). A non-standard object body is the one shape that
  // reaches the `''` fallback — the resulting empty string does not match
  // either sentinel, so this degrades to the generic mismatch code rather
  // than crashing or mis-mapping.
  it('a ForbiddenException with a non-standard body (no string .message) degrades to invite_email_mismatch, not a crash', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    ;(usersService.acceptPersonalEmailInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ForbiddenException({ weird: 'shape' }),
    )
    const controller = new AuthController(
      authService,
      usersService,
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_email_mismatch'])
  })

  it('invite cookie present, token expired → redirects with the invite_expired error code', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    ;(usersService.acceptPersonalEmailInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BadRequestException('Срок действия приглашения истёк'),
    )
    const controller = new AuthController(
      authService,
      usersService,
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_expired'])
  })

  it('invite cookie present, garbage/unknown token → redirects with the invite_invalid error code', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    ;(usersService.acceptPersonalEmailInvite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new NotFoundException('Приглашение недействительно'),
    )
    const controller = new AuthController(
      authService,
      usersService,
      makeJwtService(),
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value', 'raw-token-abc')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=invite_invalid'])
  })

  it('no invite cookie → normal login branch runs instead (acceptPersonalEmailInvite never called)', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value') // no invite token

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(usersService.acceptPersonalEmailInvite).not.toHaveBeenCalled()
    expect(jwtService.sign).toHaveBeenCalled()
    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/'])
  })

  // SR-M-11 (security-review PR #623 round 4): a cookie left over from an
  // EARLIER invite round (or one naively forged against a guessed token —
  // startInviteAccept never checked the token existed) must NOT hijack a
  // LATER, unrelated login. The cookie's embedded state ('old-state-value')
  // does not match THIS callback's state ('state-value') — proven by
  // falling through to the ordinary login path, exactly like "no invite
  // cookie" above, not by an invite-flavoured error.
  it('invite cookie present but its embedded state does NOT match this round — falls through to normal login, not the invite branch', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER)
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    // cookieState ('old-state-value') deliberately differs from the
    // callback's own state ('state-value') — see makeInviteRequest's doc.
    const request = makeInviteRequest('state-value', 'raw-token-abc', 'old-state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(usersService.acceptPersonalEmailInvite).not.toHaveBeenCalled()
    expect(jwtService.sign).toHaveBeenCalled()
    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/'])
    // Still cleared unconditionally, same as every other case.
    expect(Object.keys(reply._cleared)).toContain('__Host-invite_token')
  })
})

describe('AuthController.googleCallback — normal login, no matching row (kills the !emailRow||!user survivors)', () => {
  it('no loginable row for this email → redirects unauthorized, mints no session', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, 'nobody@example.com', 'google-sub')
    const usersService = makeUsersServiceWithEmailRow(null) // findLoginableEmailRow -> undefined
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=unauthorized'])
    expect(jwtService.sign).not.toHaveBeenCalled()
  })

  it('emailRow found but the user row is GONE (race between the two lookups) → still redirects unauthorized (kills the || → && mutant)', async () => {
    // Deliberately NOT built via makeUsersServiceWithEmailRow — that helper
    // ties findById's result to the SAME foundUser the emailRow is derived
    // from, which can never produce "row found, user gone" (the exact case
    // the `||` in `!emailRow || !user` covers that `&&` would not: under
    // `&&`, a truthy emailRow with an undefined user would skip the
    // unauthorized redirect and crash instead on `user.archivedAt`).
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub')
    const usersService = {
      findLoginableEmailRow: vi.fn().mockResolvedValue({
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        userId: TEST_USER.id,
        email: TEST_USER.email,
        kind: 'WORK',
        canLogin: true,
        googleId: null,
      }),
      findById: vi.fn().mockResolvedValue(undefined),
      updateGoogleId: vi.fn().mockResolvedValue(undefined),
      updateEmailRowGoogleId: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsersService
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=unauthorized'])
    expect(jwtService.sign).not.toHaveBeenCalled()
  })
})

// Mutation gate (PR #623 round 4): this whole describe block had ZERO prior
// coverage — only the success path (`PROD: googleOneTap sets __Host-jwt…`)
// was ever tested. Mirrors the equivalent `googleCallback` describe above.
describe('AuthController.googleOneTap — failure paths (no prior test coverage)', () => {
  function makeOneTapUsersService(opts: {
    emailRow?: { id: string; userId: string; canLogin: boolean; googleId: string | null }
    user?: {
      id: string
      email: string
      role: string
      archivedAt: Date | null
      googleId: string | null
    }
  }): UsersService {
    return {
      findLoginableEmailRow: vi.fn().mockResolvedValue(opts.emailRow),
      findById: vi.fn().mockResolvedValue(opts.user),
      updateGoogleId: vi.fn().mockResolvedValue(undefined),
      updateEmailRowGoogleId: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsersService
  }

  it('no loginable row for this email → UnauthorizedException("Email not authorized"), no session', async () => {
    const authService = makeAuthService()
    ;(authService.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      sub: 'google-sub',
      email: 'nobody@example.com',
      name: 'X',
      picture: 'p',
    })
    const usersService = makeOneTapUsersService({ emailRow: undefined, user: undefined })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()

    const promise = controller.googleOneTap({ credential: 'cred' }, reply)
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(promise).rejects.toThrow('Email not authorized')
    expect(jwtService.sign).not.toHaveBeenCalled()
  })

  it('emailRow found but the user row is GONE → still UnauthorizedException (kills the || → && mutant)', async () => {
    // Same reasoning as the parallel googleCallback test above: under `&&`
    // a truthy emailRow with an undefined user would skip straight to
    // `user.archivedAt` and crash instead of rejecting cleanly.
    const authService = makeAuthService()
    ;(authService.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      sub: 'google-sub',
      email: TEST_USER.email,
      name: TEST_USER.displayName,
      picture: 'p',
    })
    const usersService = makeOneTapUsersService({
      emailRow: { id: 'row-1', userId: TEST_USER.id, canLogin: true, googleId: null },
      user: undefined,
    })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()

    const promise = controller.googleOneTap({ credential: 'cred' }, reply)
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(promise).rejects.toThrow('Email not authorized')
    expect(jwtService.sign).not.toHaveBeenCalled()
  })

  it('archived (fired) user → UnauthorizedException("Account disabled"), no session', async () => {
    const authService = makeAuthService()
    ;(authService.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      sub: 'google-sub',
      email: TEST_USER.email,
      name: TEST_USER.displayName,
      picture: 'p',
    })
    const usersService = makeOneTapUsersService({
      emailRow: { id: 'row-1', userId: TEST_USER.id, canLogin: true, googleId: null },
      user: { ...TEST_USER, archivedAt: new Date(), googleId: null },
    })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()

    const promise = controller.googleOneTap({ credential: 'cred' }, reply)
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(promise).rejects.toThrow('Account disabled')
    expect(jwtService.sign).not.toHaveBeenCalled()
  })

  it('googleId already bound to a DIFFERENT sub → Google account mismatch, no session, logs the "one-tap" reason (kills the verifyOrBindGoogleIdentity ConditionalExpression + StringLiteral mutants on this call)', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const authService = makeAuthService()
    ;(authService.verifyGoogleIdToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      sub: 'google-sub-new',
      email: TEST_USER.email,
      name: TEST_USER.displayName,
      picture: 'p',
    })
    // `makeOneTapUsersService`'s emailRow has no `kind` field, so
    // `verifyOrBindGoogleIdentity` falls into its PERSONAL branch (`kind ===
    // 'WORK'` is false) — the mismatch is on `emailRow.googleId`, not
    // `user.googleId`, and the logged reason gains the `, personal address`
    // suffix that branch always appends.
    const usersService = makeOneTapUsersService({
      emailRow: { id: 'row-1', userId: TEST_USER.id, canLogin: true, googleId: 'google-sub-old' },
      user: { ...TEST_USER, archivedAt: null, googleId: null },
    })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()

    const promise = controller.googleOneTap({ credential: 'cred' }, reply)
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(promise).rejects.toThrow('Google account mismatch')
    expect(jwtService.sign).not.toHaveBeenCalled()
    expect(usersService.updateEmailRowGoogleId).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Google account mismatch (one-tap, personal address) for user id=${TEST_USER.id}`,
      ),
    )
    warnSpy.mockRestore()
  })
})

describe('verifyOrBindGoogleIdentity (via googleCallback) — WORK branch, byte-for-byte the pre-existing check', () => {
  it('WORK row, no googleId bound yet → binds via updateGoogleId, mints a session', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub-work')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER, { kind: 'WORK' })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(usersService.updateGoogleId).toHaveBeenCalledWith(TEST_USER.id, 'google-sub-work')
    expect(usersService.updateEmailRowGoogleId).not.toHaveBeenCalled()
    expect(jwtService.sign).toHaveBeenCalled()
    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/'])
  })

  it('WORK row, googleId already bound to a DIFFERENT sub → account_mismatch, no session, no rebind, logs the reason', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub-new')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER, {
      kind: 'WORK',
      userGoogleId: 'google-sub-old',
    })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=account_mismatch'])
    expect(usersService.updateGoogleId).not.toHaveBeenCalled()
    expect(jwtService.sign).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Google account mismatch (OAuth callback) for user id=${TEST_USER.id}`,
      ),
    )
    warnSpy.mockRestore()
  })

  it('WORK row, googleId already bound to the SAME sub → mints a session, no rebind write', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub-same')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER, {
      kind: 'WORK',
      userGoogleId: 'google-sub-same',
    })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(usersService.updateGoogleId).not.toHaveBeenCalled()
    expect(jwtService.sign).toHaveBeenCalled()
    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/'])
  })
})

describe('verifyOrBindGoogleIdentity (via googleCallback) — PERSONAL branch (task-user-emails-invite)', () => {
  it('PERSONAL row, no googleId bound yet → binds via updateEmailRowGoogleId (NOT updateGoogleId), mints a session', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub-personal')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER, { kind: 'PERSONAL' })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(usersService.updateEmailRowGoogleId).toHaveBeenCalledWith(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'google-sub-personal',
    )
    expect(usersService.updateGoogleId).not.toHaveBeenCalled()
    expect(jwtService.sign).toHaveBeenCalled()
    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/'])
  })

  it('PERSONAL row, googleId already bound to a DIFFERENT sub → account_mismatch, no session, logs the reason — proves the two kinds bind INDEPENDENTLY (this is not users.googleId)', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub-new-personal')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER, {
      kind: 'PERSONAL',
      emailRowGoogleId: 'google-sub-old-personal',
    })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/login?error=account_mismatch'])
    expect(usersService.updateEmailRowGoogleId).not.toHaveBeenCalled()
    expect(jwtService.sign).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Google account mismatch (OAuth callback, personal address) for user id=${TEST_USER.id}`,
      ),
    )
    warnSpy.mockRestore()
  })

  it('PERSONAL row, googleId already bound to the SAME sub → mints a session, no rebind write (distinguishes the real `!==` check from an always-true mutant)', async () => {
    const authService = makeAuthService()
    setupGoogleUser(authService, TEST_USER.email, 'google-sub-personal-same')
    const usersService = makeUsersServiceWithEmailRow(TEST_USER, {
      kind: 'PERSONAL',
      emailRowGoogleId: 'google-sub-personal-same',
    })
    const jwtService = makeJwtService()
    const controller = new AuthController(
      authService,
      usersService,
      jwtService,
      makeConfig('production'),
    )
    const reply = makeFullReply()
    const request = makeInviteRequest('state-value')

    await controller.googleCallback('code', 'state-value', request, reply)

    expect(usersService.updateEmailRowGoogleId).not.toHaveBeenCalled()
    expect(jwtService.sign).toHaveBeenCalled()
    expect(redirectsOf(reply)).toEqual(['http://localhost:3000/'])
  })
})

/**
 * SR-M-13 (security-review PR #623 round 6) — impersonation round-trip
 * `userEmailId` binding.
 *
 * Unit-level (not just the real-DB `auth.impersonation.integration.spec.ts`)
 * because the mutation gate only runs the unit suite — see
 * `mutation-gate-integration-specs.md`: a `NoCoverage` finding here would be
 * REAL, not a heuristic false-positive, since nothing else exercises the
 * conditional-spread / field-copy logic added to `impersonate` /
 * `stopImpersonating` at the unit level.
 *
 * Reviewer's controlled reproduction (round 5→6): same admin, same
 * personal-email revocation, ONE impersonate→stop-impersonating round trip
 * in between — before this fix, `stopImpersonating` always minted
 * `userEmailId: undefined` regardless of what the admin's session carried,
 * so the revocation silently stopped applying to that session forever.
 */
describe('AuthController.impersonate / stopImpersonating — SR-M-13 (round-trip userEmailId binding)', () => {
  const ADMIN_USER = {
    ...TEST_USER,
    id: 'aaaaaaaa-0000-4000-8000-0000000000a1',
    email: 'admin-sr-m-13@test.spec',
    role: 'ADMIN' as const,
  }
  const TARGET_USER = {
    ...TEST_USER,
    id: 'aaaaaaaa-0000-4000-8000-0000000000a2',
    email: 'target-sr-m-13@test.spec',
    role: 'JUNIOR' as const,
  }
  const ADMIN_USER_EMAIL_ID = 'bbbbbbbb-0000-4000-8000-0000000000b1'

  function signedPayload(jwtService: JwtService): Record<string, unknown> {
    return vi.mocked(jwtService.sign).mock.calls[0]![0] as Record<string, unknown>
  }

  it("impersonate: admin session WITH userEmailId → carried into impersonatorUserEmailId, NOT into the target token's own userEmailId", async () => {
    const jwtService = makeJwtService()
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TARGET_USER),
      jwtService,
      makeConfig('development'),
    )
    const currentUser: JwtPayload = {
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      role: 'ADMIN',
      userEmailId: ADMIN_USER_EMAIL_ID,
    }

    await controller.impersonate({ userId: TARGET_USER.id }, currentUser, makeReply())

    const payload = signedPayload(jwtService)
    expect(payload['id']).toBe(TARGET_USER.id)
    expect(payload['impersonatorId']).toBe(ADMIN_USER.id)
    expect(payload['impersonatorUserEmailId']).toBe(ADMIN_USER_EMAIL_ID)
    // The impersonation-target token has no `user_emails` row of its own —
    // see `jwtPayloadSchema`'s doc, case 1.
    expect(payload['userEmailId']).toBeUndefined()
  })

  it('impersonate: admin session WITHOUT userEmailId → impersonatorUserEmailId stays undefined (does not fabricate a binding)', async () => {
    const jwtService = makeJwtService()
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(TARGET_USER),
      jwtService,
      makeConfig('development'),
    )
    const currentUser: JwtPayload = {
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      role: 'ADMIN',
      // No userEmailId — e.g. a pre-deployment admin session (see
      // `jwtPayloadSchema`'s doc, case 3).
    }

    await controller.impersonate({ userId: TARGET_USER.id }, currentUser, makeReply())

    const payload = signedPayload(jwtService)
    expect(payload['impersonatorUserEmailId']).toBeUndefined()
  })

  it("stopImpersonating: impersonatorUserEmailId present → restored onto the reinstated admin session's userEmailId", async () => {
    const jwtService = makeJwtService()
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(ADMIN_USER),
      jwtService,
      makeConfig('development'),
    )
    const currentUser: JwtPayload = {
      id: TARGET_USER.id,
      email: TARGET_USER.email,
      role: TARGET_USER.role,
      impersonatorId: ADMIN_USER.id,
      impersonatorUserEmailId: ADMIN_USER_EMAIL_ID,
    }

    await controller.stopImpersonating(currentUser, makeReply())

    const payload = signedPayload(jwtService)
    expect(payload['id']).toBe(ADMIN_USER.id)
    expect(payload['userEmailId']).toBe(ADMIN_USER_EMAIL_ID)
    expect(payload['impersonatorId']).toBeUndefined()
  })

  it('stopImpersonating: no impersonatorUserEmailId on the impersonation token → restored session has no userEmailId either', async () => {
    const jwtService = makeJwtService()
    const controller = new AuthController(
      makeAuthService(),
      makeUsersService(ADMIN_USER),
      jwtService,
      makeConfig('development'),
    )
    const currentUser: JwtPayload = {
      id: TARGET_USER.id,
      email: TARGET_USER.email,
      role: TARGET_USER.role,
      impersonatorId: ADMIN_USER.id,
      // No impersonatorUserEmailId — the admin's own session had none to
      // carry (round-trip has nothing to restore, not a regression).
    }

    await controller.stopImpersonating(currentUser, makeReply())

    const payload = signedPayload(jwtService)
    expect(payload['userEmailId']).toBeUndefined()
  })
})
