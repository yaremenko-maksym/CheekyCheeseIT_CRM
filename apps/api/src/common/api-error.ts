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
 *
 * COPY-M-6 (PR #694 round 3) removed `role`, the last `{token}` in any
 * `API_ERROR_FALLBACK_EN` entry (`CONTRACT_TEMPLATE_MISSING`'s) — every
 * template in the registry is now token-free, and `ParamsFor<C>` (SR-M-1)
 * is `never` for all eight codes, so no typed call site can pass a `params`
 * for this to substitute either. The regex/callback below is unreachable
 * through the public surface today; suppressed rather than deleted because
 * `interpolate` itself stays (stage 3 will give some code params again, and
 * this is where that substitution runs) — reinstate a test against whichever
 * code that is.
 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  // Stryker disable next-line ArrowFunction,Regex: unreachable today — see the
  // paragraph above. No template has a `{token}` and no typed call site can
  // pass `params`, so this substitution never runs against production input.
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
 * `never` for a code that declares no params (so passing a third argument
 * at all is a compile error) and an object with EXACTLY the declared keys
 * otherwise. All eight registered codes declare no params today (COPY-M-6,
 * PR #694 round 3 removed the last one), so `...args` is empty everywhere
 * right now — kept as a conditional tuple (not `params?`) rather than
 * simplified away, since that is what makes the zero-param case a compile
 * error instead of a silently accepted `{}`; see that file's doc comment
 * for why the simpler `params?: ParamsFor<C>` form does not.
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
