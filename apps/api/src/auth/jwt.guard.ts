import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { FastifyRequest } from 'fastify'
import { IS_PUBLIC_KEY } from './public.decorator'

/**
 * Globally registered (APP_GUARD in AppModule) — runs FIRST so it populates
 * `req.user` before OnboardingGuard reads it. See
 * `onboarding.guard.integration.spec.ts` for the lifecycle pin.
 *
 * Handlers / controllers tagged with `@Public()` bypass JWT verification via
 * the `Reflector` lookup of `IS_PUBLIC_KEY` (handler-level first, then
 * controller-level). Use sparingly — only for endpoints that genuinely have
 * no JWT cookie at call time (OAuth begin/callback, health probe).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (isPublic) return true

    const request = ctx.switchToHttp().getRequest<FastifyRequest>()
    const token = request.cookies?.['jwt']
    if (!token) throw new UnauthorizedException()
    try {
      const payload = this.jwt.verify(token)
      ;(request as FastifyRequest & { user: unknown }).user = payload
      return true
    } catch {
      throw new UnauthorizedException()
    }
  }
}
