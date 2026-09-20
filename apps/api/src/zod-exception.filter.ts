import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { ZOD_ERROR_CODES, ZOD_ERROR_FALLBACK_EN, type ZodErrorCode } from '@crm/shared'

/**
 * task-i18n-stage4-task4. A migrated schema's `message` is the stable key
 * `'zod.<CODE>'` (see `zod-errors.ts`'s module doc for why — Zod v4 carries
 * only a single `message: string`, no separate code field). A not-yet-
 * migrated schema's `message` is still ordinary prose. This is the ONE place
 * that tells the two apart, so `errors[]` below can build the right shape
 * for each: `{ path, code, params?, message }` (message = the English
 * fallback, for a client without a catalog — same contract as
 * `API_ERROR_FALLBACK_EN`/`apiError()`) for a migrated issue, `{ path,
 * message }` (unchanged) for a legacy one.
 */
function isZodErrorCode(value: string): value is ZodErrorCode {
  return (ZOD_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Finance-critical route prefixes that should return a generic error body for
 * non-ADMIN callers (LOW info-disclosure finding: ZodError field-paths may leak
 * internal schema structure on financial mutation endpoints).
 *
 * ADMIN callers always receive full field-path detail regardless of route
 * (they need it for debugging and operator tooling).
 */
const FINANCE_CRITICAL_PREFIXES = [
  '/api/transactions',
  '/api/payout-requests',
  '/api/finance',
  '/api/company-account',
  '/api/pending-settlements',
  '/api/pending-obligations',
  '/api/balances',
]

@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()
    const request = ctx.getRequest<FastifyRequest & { user?: { role?: string } }>()

    const userRole: string | undefined = request.user?.role
    const routeUrl: string = request.url ?? ''

    // For finance-critical routes called by non-ADMIN users, return a generic
    // message without field-path detail. This prevents leaking internal schema
    // paths (e.g. constraint names, nested field structure) to unprivileged callers.
    // ADMIN callers always receive full Zod detail for operability.
    const isFinanceCritical = FINANCE_CRITICAL_PREFIXES.some((prefix) =>
      routeUrl.startsWith(prefix),
    )
    const isAdmin = userRole === 'ADMIN'

    if (isFinanceCritical && !isAdmin) {
      reply.status(HttpStatus.BAD_REQUEST).send({
        statusCode: 400,
        message: 'Invalid request body',
      })
      return
    }

    // User-facing forms (non-finance routes, or ADMIN on any route) receive
    // detailed field-level error messages for UX.
    reply.status(HttpStatus.BAD_REQUEST).send({
      statusCode: 400,
      message: 'Validation failed',
      errors: exception.issues.map((i) => {
        const rawCode = i.message.startsWith('zod.') ? i.message.slice('zod.'.length) : null
        if (rawCode !== null && isZodErrorCode(rawCode)) {
          return {
            path: i.path.join('.'),
            code: rawCode,
            message: ZOD_ERROR_FALLBACK_EN[rawCode],
          }
        }
        return { path: i.path.join('.'), message: i.message }
      }),
    })
  }
}
