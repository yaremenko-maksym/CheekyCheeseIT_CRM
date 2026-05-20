import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { SessionUser } from '@crm/shared'
import { ROLES_KEY } from '../decorators/roles.decorator'

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
      throw new ForbiddenException(`Доступ только для ролей: ${required.join(', ')}`)
    }
    return true
  }
}
