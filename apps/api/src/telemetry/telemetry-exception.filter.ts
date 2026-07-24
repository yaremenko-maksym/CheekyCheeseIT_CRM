import { ArgumentsHost, Catch, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'
import type { SessionUser } from '@crm/shared'
import { TelemetryErrorsService } from './telemetry-errors.service'

/**
 * TelemetryExceptionFilter — task-telemetry-api contract: "Глобальный
 * exception-catcher API-ошибок: Nest-фильтр/интерсептор на 5xx и unhandled
 * → прямой upsert (source=API, endpoint как route, userId из request если
 * есть). ЖЁСТКИЙ guard от рекурсии: ошибки внутри telemetry-модуля НЕ
 * трекаются (флаг/маркер пути); сбой записи никогда не влияет на ответ
 * клиенту."
 *
 * Extends `BaseExceptionFilter` (Nest's own default filter) instead of
 * building a custom response shape — `super.catch()` reproduces the EXACT
 * SAME response body every OTHER exception in the app already gets
 * (HttpException status/message, or 500 for unknown errors). Only the SIDE
 * EFFECT (recording to `telemetry_errors`) is new; the HTTP contract for
 * every existing endpoint is untouched (AC4: "не ломает ответ").
 *
 * Registration order matters (NestJS docs, "Catch everything": a catch-all
 * filter combined with a type-specific one must be registered FIRST so the
 * specific one still wins for its type) — see `main.ts`, registered BEFORE
 * `ZodExceptionFilter`.
 *
 * Recursion guard (AC4): requests to `/api/telemetry/*` are NEVER recorded
 * here, by URL prefix — this is the ONE thing that would otherwise create a
 * feedback loop (a bug in the ingest/digest endpoints themselves generating
 * telemetry_errors rows about telemetry itself).
 */
@Injectable()
@Catch()
export class TelemetryExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(TelemetryExceptionFilter.name)

  constructor(
    httpAdapterHost: HttpAdapterHost,
    private readonly telemetryErrors: TelemetryErrorsService,
  ) {
    super(httpAdapterHost.httpAdapter)
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // Fire-and-forget — recording must NEVER delay or break the real
    // response, which `super.catch()` below produces exactly as before.
    this.recordIfEligible(exception, host).catch((err: unknown) => {
      this.logger.error(
        `telemetry error recording failed (swallowed, does not affect the response): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
    super.catch(exception, host)
  }

  private async recordIfEligible(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp()
    const request = ctx.getRequest<FastifyRequest & { user?: SessionUser }>()
    const url = request.url ?? ''

    if (isTelemetryInternalRoute(url)) return

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
    if (status < 500) return

    const message = exception instanceof Error ? exception.message : String(exception)
    const stack = exception instanceof Error ? exception.stack : undefined

    await this.telemetryErrors.recordError({
      source: 'API',
      message,
      stack,
      route: url,
      userId: request.user?.id,
      userRole: request.user?.role,
    })
  }
}

/** Recursion guard (AC4) — exported for direct unit testing. */
export function isTelemetryInternalRoute(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  return path.startsWith('/api/telemetry')
}
