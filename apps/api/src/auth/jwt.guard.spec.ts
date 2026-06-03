import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { describe, expect, it } from 'vitest'
import { JwtAuthGuard } from './jwt.guard'
import { IS_PUBLIC_KEY } from './public.decorator'

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

describe('JwtAuthGuard', () => {
  const jwtService = new JwtService({ secret: 'test-secret-32-chars-minimum-xx' })

  it('throws when no cookie present', () => {
    const guard = new JwtAuthGuard(jwtService, makeReflector(false))
    expect(() => guard.canActivate(makeCtx())).toThrow(UnauthorizedException)
  })

  it('throws when token is invalid', () => {
    const guard = new JwtAuthGuard(jwtService, makeReflector(false))
    expect(() => guard.canActivate(makeCtx({ jwt: 'bad.token.here' }))).toThrow(
      UnauthorizedException,
    )
  })

  it('returns true and attaches user for a valid token', () => {
    const payload = { id: 'user-1', email: 'a@b.com', role: 'ADMIN' }
    const token = jwtService.sign(payload)
    const request: Record<string, unknown> = { cookies: { jwt: token } }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext
    const guard = new JwtAuthGuard(jwtService, makeReflector(false))
    expect(guard.canActivate(ctx)).toBe(true)
    expect((request.user as Record<string, unknown>)['id']).toBe('user-1')
  })

  it('bypasses verification when handler is marked @Public()', () => {
    const guard = new JwtAuthGuard(jwtService, makeReflector(true))
    // No cookie present — would normally 401. With @Public() it returns true.
    expect(guard.canActivate(makeCtx())).toBe(true)
  })
})
