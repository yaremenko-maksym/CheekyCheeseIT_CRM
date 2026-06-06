import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { from, Observable, switchMap } from 'rxjs'
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

    const req = context
      .switchToHttp()
      .getRequest<{ user?: SessionUser; params: Record<string, string> }>()
    const actor = req.user
    const targetId = req.params.id ?? actor?.id
    if (!targetId) return next.handle()

    const before = await this.usersService.findById(targetId)

    return next.handle().pipe(
      switchMap((response) =>
        from(
          (async () => {
            const after = await this.usersService.findById(targetId)
            if (!before || !after) return response
            const changes = this.auditLogService.diff(
              before as unknown as Record<string, unknown>,
              after as unknown as Record<string, unknown>,
            )

            // Guard: do nothing when there are no field changes at all.
            // This must live in the interceptor (not delegated to record())
            // because record() is mocked in tests and its internal early-return
            // is bypassed by the spy.
            if (Object.keys(changes).length === 0) return response

            // п.2: if legalFullName changed, emit an additional dedicated action
            // BEFORE the generic one so the audit trail reads chronologically as
            // "legal name changed" → "profile edited".
            if ('legalFullName' in changes) {
              const legalNameChanges = { legalFullName: changes['legalFullName']! }
              await this.auditLogService.record({
                actorId: actor?.id ?? null,
                targetId,
                action: 'legal_name_change',
                changes: legalNameChanges,
              })
            }

            await this.auditLogService.record({
              actorId: actor?.id ?? null,
              targetId,
              action,
              changes,
            })

            return response
          })(),
        ),
      ),
    )
  }
}
