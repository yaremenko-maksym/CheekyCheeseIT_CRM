import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Observable, tap } from 'rxjs'
import type { AuditAction, SessionUser } from '@crm/shared'
import { AuditLogService } from '../../users/audit-log.service'
import { UsersService } from '../../users/users.service'
import { AUDIT_LOG_KEY } from '../decorators/audit-log.decorator'

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private reflector: Reflector,
    private auditLogService: AuditLogService,
    private usersService: UsersService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const action = this.reflector.get<AuditAction | undefined>(AUDIT_LOG_KEY, context.getHandler())
    if (!action) return next.handle()

    const req = context.switchToHttp().getRequest<{ user?: SessionUser; params: Record<string, string> }>()
    const actor = req.user
    const targetId = req.params.id ?? actor?.id
    if (!targetId) return next.handle()

    const before = await this.usersService.findById(targetId)

    return next.handle().pipe(
      tap(async () => {
        const after = await this.usersService.findById(targetId)
        if (!before || !after) return
        const changes = this.auditLogService.diff(
          before as unknown as Record<string, unknown>,
          after as unknown as Record<string, unknown>,
        )
        await this.auditLogService.record({
          actorId: actor?.id ?? null,
          targetId,
          action,
          changes,
        })
      }),
    )
  }
}
