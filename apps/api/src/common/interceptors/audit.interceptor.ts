import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { from, Observable, switchMap } from 'rxjs'
import type { AuditAction, SessionUser } from '@crm/shared'
import { AuditLogService } from '../../users/audit-log.service'
import { UsersService } from '../../users/users.service'
import { AUDIT_LOG_KEY } from '../decorators/audit-log.decorator'

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name)

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
    if (!targetId) {
      // @AuditLog decorator is set but we cannot resolve a targetId — this is
      // a misconfiguration (e.g. route missing :id param). Log a warning so it
      // surfaces in dev and ops monitoring without breaking the request.
      this.logger.warn(
        `[AuditInterceptor] @AuditLog(${action}) is set on handler but targetId could not be resolved (params.id=${String(req.params.id)}, actor.id=${String(actor?.id)}). Audit skipped — check route configuration.`,
      )
      return next.handle()
    }

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

            // MED-3: audit record() is best-effort — a DB failure while writing
            // the audit row must NOT propagate to the client as a 500, because
            // the primary mutation has already been committed. We log loudly so
            // ops teams are alerted, but the HTTP response is still returned.
            //
            // п.2: if legalFullName changed, emit an additional dedicated action
            // BEFORE the generic one so the audit trail reads chronologically as
            // "legal name changed" → "profile edited".
            try {
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
            } catch (auditErr) {
              // Audit is best-effort: log loudly but don't break the response.
              this.logger.error(
                `[AuditInterceptor] Failed to persist audit record for target=${targetId} action=${action}: ${(auditErr as Error).message}`,
                (auditErr as Error).stack,
              )
            }

            return response
          })(),
        ),
      ),
    )
  }
}
