import { HttpException, type HttpStatus } from '@nestjs/common'
import {
  API_ERROR_FALLBACK_EN,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type ParamsFor,
} from '@crm/shared'

/**
 * Substitutes `{key}` placeholders in the English fallback template with
 * `params` — same `{token}` convention `contract-rendering.ts` uses for the
 * (unrelated) contract-body variables, kept local here rather than shared
 * since the input shape (flat string/number record, no nested lookups) is
 * simpler than that renderer needs. A missing param leaves the placeholder
 * literal (`{role}`) rather than throwing — this text never reaches an end
 * user (the client always translates via `code`, see `getApiErrorMessage`),
 * so a malformed fallback is a log-readability nuisance, not a user-facing bug.
 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params?.[key] ?? `{${key}}`))
}

/**
 * task-i18n-stage2-task5. Builds the standard error envelope
 * (`apiErrorEnvelopeSchema`, `packages/shared/src/schemas/api-errors.ts`) as
 * an `HttpException` body. `message` is always the English fallback — never
 * user-facing on its own; the client re-translates by `code` through
 * `API_ERROR_MESSAGES` (`getApiErrorMessage`, `apps/web/app/lib/axios-utils.ts`).
 *
 * The third parameter is generic over `code` (SR-M-1, PR #694 round 1):
 * `ParamsFor<C>` — see `packages/shared/src/schemas/api-errors.ts` — is
 * `never` for the seven codes that declare no params (so passing a third
 * argument at all is a compile error) and an object with EXACTLY the
 * declared keys otherwise. `...args` (a conditional tuple, not `params?`)
 * is what makes the zero-param case a compile error rather than a silently
 * accepted `{}` — see that file's doc comment for why the simpler
 * `params?: ParamsFor<C>` form does not.
 */
export function apiError<C extends ApiErrorCode>(
  code: C,
  status: HttpStatus,
  ...args: [ParamsFor<C>] extends [never] ? [] : [params: ParamsFor<C>]
): HttpException {
  const params = args[0] as Record<string, string | number> | undefined
  const body: ApiErrorEnvelope = {
    statusCode: status,
    code,
    params,
    message: interpolate(API_ERROR_FALLBACK_EN[code], params),
  }
  return new HttpException(body, status)
}
