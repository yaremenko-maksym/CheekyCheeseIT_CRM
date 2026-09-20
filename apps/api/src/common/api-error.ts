import { HttpException, type HttpStatus } from '@nestjs/common'
import { API_ERROR_FALLBACK_EN, type ApiErrorCode, type ApiErrorEnvelope } from '@crm/shared'

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
 */
export function apiError(
  code: ApiErrorCode,
  status: HttpStatus,
  params?: Record<string, string | number>,
): HttpException {
  const body: ApiErrorEnvelope = {
    statusCode: status,
    code,
    params,
    message: interpolate(API_ERROR_FALLBACK_EN[code], params),
  }
  return new HttpException(body, status)
}
