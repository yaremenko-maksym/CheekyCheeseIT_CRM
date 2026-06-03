import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { SessionUser } from '@crm/shared'
import { OnboardingService } from '../onboarding/onboarding.service'

/**
 * Onboarding Phase 6A — global guard enforcing MSA sign + ToS acceptance.
 *
 * Order: registered via `APP_GUARD` in `AppModule`. Runs alongside the
 * per-controller `JwtAuthGuard` (Nest evaluates global guards in the order
 * they are registered; we treat unauthenticated requests as bypass so the
 * downstream `JwtAuthGuard` produces the 401, not us).
 *
 * Bypass paths (path-prefix match against URL stripped of query string):
 *   - `/api/auth/*` (login flow, /me, logout, dev-login — JwtAuthGuard
 *      already handles auth for /me, dev-login is dev-only)
 *   - `/api/onboarding/status` (fetched by the redirect gate)
 *   - `/api/tos/current` (rendered in the wizard)
 *   - `/api/tos/accept` (the exit door for ToS)
 *   - `/api/contracts/templates/current/<role>` (rendered in the wizard)
 *   - `/api/contracts/sign` (the exit door for MSA)
 *
 * ADMIN: bypass entirely.
 * Non-admin: `OnboardingService.getStatus` decides; missing → `ForbiddenException`
 * payload `{error:'ONBOARDING_REQUIRED', missing:string[]}` consumed by the
 * frontend redirect gate.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  private readonly bypassPrefixes = [
    '/api/auth/',
    '/api/onboarding/status',
    '/api/tos/current',
    '/api/tos/accept',
    '/api/contracts/templates/current/',
    '/api/contracts/sign',
  ]

  constructor(
    @Inject(forwardRef(() => OnboardingService))
    private readonly onboarding: OnboardingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: SessionUser }>()
    const rawUrl = (request.url as string | undefined) ?? ''
    // `String#split('?')[0]` always returns a string. The `!` resolves
    // `noUncheckedIndexedAccess` since TS can't prove the non-empty guarantee.
    const path = rawUrl.split('?')[0]!

    if (this.isBypass(path)) return true

    // JwtAuthGuard handles 401 for missing `req.user`. We let unauthenticated
    // requests through so the auth-level guard produces the canonical error.
    const user = request.user
    if (!user) return true

    if (user.role === 'ADMIN') return true

    const status = await this.onboarding.getStatus(user.id, user.role)
    const missing: string[] = []
    if (status.requiresContract) missing.push('contract')
    if (status.requiresTos) missing.push('tos')

    if (missing.length > 0) {
      throw new ForbiddenException({ error: 'ONBOARDING_REQUIRED', missing })
    }
    return true
  }

  private isBypass(path: string): boolean {
    return this.bypassPrefixes.some((prefix) => path.startsWith(prefix))
  }
}
