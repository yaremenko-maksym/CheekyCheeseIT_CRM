import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { describe, expect, it } from 'vitest'
import { JwtAuthGuard } from './jwt.guard'

function makeCtx(cookies: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ cookies }),
    }),
  } as unknown as ExecutionContext
}

describe('JwtAuthGuard', () => {
  const jwtService = new JwtService({ secret: 'test-secret-32-chars-minimum-xx' })

  it('throws when no cookie present', () => {
    const guard = new JwtAuthGuard(jwtService)
    expect(() => guard.canActivate(makeCtx())).toThrow(UnauthorizedException)
  })

  it('throws when token is invalid', () => {
    const guard = new JwtAuthGuard(jwtService)
    expect(() => guard.canActivate(makeCtx({ jwt: 'bad.token.here' }))).toThrow(UnauthorizedException)
  })

  it('returns true and attaches user for a valid token', () => {
    const payload = { id: 'user-1', email: 'a@b.com', role: 'ADMIN' }
    const token = jwtService.sign(payload)
    const request: Record<string, unknown> = { cookies: { jwt: token } }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext
    const guard = new JwtAuthGuard(jwtService)
    expect(guard.canActivate(ctx)).toBe(true)
    expect((request.user as Record<string, unknown>)['id']).toBe('user-1')
  })
})
