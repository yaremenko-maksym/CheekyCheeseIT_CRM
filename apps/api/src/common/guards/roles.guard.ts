import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { SessionUser } from '@crm/shared'
import { ROLES_KEY } from '../decorators/roles.decorator'
import { apiError } from '../api-error'

/**
 * backlog item 133 — decided (not left to default): a rejected caller used to
 * get `Доступ только для ролей: ADMIN, ACCOUNTANT`, handing an
 * unauthenticated-for-this-route caller the EXACT allow-list for a route it
 * just proved it cannot use. Genericized on purpose everywhere this guard is
 * used (single call site — this is the ONLY place the message is built, so
 * there is no second copy to forget).
 *
 * i18n stage-6B Wave 4: the refusal is now the `FORBIDDEN_INSUFFICIENT_ROLE`
 * api-error code. SECURITY INVARIANT (kept): the code declares NO `params` and
 * its catalog text (uk + en) names no role, so neither the envelope nor the
 * client-translated text can reveal the required role. `roles.guard.spec.ts`
 * pins this on the real thrown envelope.
 *
 * Still carries a `message` field (the English fallback) deliberately:
 * `OnboardingGuard` throws a structured body with no `message` field at all
 * (`{ error: 'ONBOARDING_REQUIRED', missing }` — see onboarding.guard.ts). A
 * caller that gets a `message` field back went through a role gate, not the
 * onboarding gate — that discriminator (used by
 * apps/e2e/tests/drop-backend-rbac-api.spec.ts) survives losing the role
 * list.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required || required.length === 0) return true
    const req = context.switchToHttp().getRequest<{ user?: SessionUser }>()
    if (!req.user) throw new ForbiddenException()
    if (!required.includes(req.user.role)) {
      throw apiError('FORBIDDEN_INSUFFICIENT_ROLE', HttpStatus.FORBIDDEN)
    }
    return true
  }
}
