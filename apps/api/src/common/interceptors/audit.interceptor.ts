import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { from, Observable, switchMap } from 'rxjs'
import type { AuditAction, AuditChange, JwtPayload } from '@crm/shared'
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

    // MED (security-audit authz-hardening): `req.user` here is the JWT
    // payload JwtAuthGuard populates (see jwt.guard.ts) — under impersonation
    // its `id` is the TARGET being impersonated and `impersonatorId` is the
    // REAL admin operator.
    //
    // LOW (security-review round 3, follow-up to #436): the comment used to
    // say `SessionUser` doesn't carry `impersonatorId` at all — that stopped
    // being true in #436, which added an optional `impersonatorId` field to
    // `sessionUserSchema` (see its doc in `@crm/shared`) so service methods
    // that only have a `SessionUser` in scope (not this interceptor's raw
    // `JwtPayload`) can do the same `impersonatorId ?? id` correction. The
    // `/me` HTTP response still never emits that key — only the derived
    // `impersonating` boolean the frontend reads — so the observable
    // behaviour this comment originally described (the field never reaches
    // the browser) is unchanged; only the in-process type carried it.
    const req = context
      .switchToHttp()
      .getRequest<{ user?: JwtPayload; params: Record<string, string> }>()
    const actor = req.user
    // Owner decision: no full per-action attribution machinery — just the
    // correct actor + a lightweight flag on the row (see below).
    const effectiveActorId = actor?.impersonatorId ?? actor?.id ?? null
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

            // Guard: do nothing when there are no field changes at all. This
            // check runs on the REAL field diff, before the impersonation
            // flag (below) is added, so an impersonated no-op edit still
            // skips the audit write exactly like a normal one.
            // This must live in the interceptor (not delegated to record())
            // because record() is mocked in tests and its internal early-return
            // is bypassed by the spy.
            if (Object.keys(changes).length === 0) return response

            // MED (security-audit authz-hardening): under impersonation, tag
            // the row so it is distinguishable from a real self-edit by the
            // target — the corrected actorId above already identifies WHO
            // did it; this is just the "was it impersonation" marker. Added
            // to `changes` (no schema migration) since `changes` is already a
            // free-form JSONB diff map — `__impersonation` cannot collide
            // with a real column name.
            const changesToRecord: Record<string, AuditChange> = actor?.impersonatorId
              ? { ...changes, __impersonation: { before: null, after: true } }
              : changes

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
                const legalNameChanges: Record<string, AuditChange> = actor?.impersonatorId
                  ? {
                      legalFullName: changes['legalFullName']!,
                      __impersonation: { before: null, after: true },
                    }
                  : { legalFullName: changes['legalFullName']! }
                await this.auditLogService.record({
                  actorId: effectiveActorId,
                  targetId,
                  action: 'legal_name_change',
                  changes: legalNameChanges,
                })
              }

              await this.auditLogService.record({
                actorId: effectiveActorId,
                targetId,
                action,
                changes: changesToRecord,
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
