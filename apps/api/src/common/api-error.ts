import { HttpException, type HttpStatus } from '@nestjs/common'
import { setupI18n } from '@lingui/core'
import { compileMessage } from '@lingui/message-utils/compileMessage'
import {
  API_ERROR_FALLBACK_EN,
  API_ERROR_MESSAGES,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type ParamsFor,
} from '@crm/shared'

/**
 * Renders the English fallback template for the HTTP envelope's `message`
 * field (and for the server log line, wherever a caller logs it) — through
 * the SAME ICU MessageFormat engine (`@lingui/core`'s `i18n._`) the client
 * uses to translate by `code` (`translateApiError`,
 * `apps/web/app/lib/axios-utils.ts`), instead of a hand-rolled `{token}`
 * regex.
 *
 * SR-M-1 (PR #702 fix-round 1): the previous regex-based `interpolate` was
 * written when `ParamsFor<C>` was `never` for every registered code (PR #694
 * round 3) and stayed suppressed behind that assumption long after task-
 * i18n-stage4-task3 gave five codes real params — it was NEVER able to see
 * a comma-bearing `{token, select, ...}` declaration at all (`\{(\w+)\}`
 * cannot match past the comma), so a refusal with `DOCUMENT_UPLOAD_
 * CATEGORY_FORBIDDEN` / `DOCUMENT_UPLOAD_SELF_ONLY` / `CONTRACT_ALREADY_
 * STATUS_CANNOT_REVERT` / `TEAM_UNEXPECTED_USER_ROLE` params shipped the raw
 * ICU template verbatim, syntax and all, in the HTTP body's `message` field
 * — for every client without a catalog and in every server log line.
 * `i18n._` parses the same ICU grammar the `uk` catalog uses, so this
 * fallback renders exactly the way a client WITH a catalog would render the
 * `en` locale for the same code+params.
 *
 * One `setupI18n` instance per call rather than a module-level singleton —
 * this runs on every refused request; an empty in-memory `messages` object
 * (no catalog file I/O, unlike `createI18n` in
 * `packages/shared/src/i18n/catalog.ts`) is cheap to construct, and this
 * mirrors that function's own "one instance per request" rule for the same
 * reason (no shared mutable i18n state across concurrent requests).
 *
 * SR-M-1 (PR #704 fix-round 1): `@lingui/core`'s `I18n` constructor only
 * self-registers `compileMessage` as the message compiler when
 * `process.env.NODE_ENV !== 'production'` (`dist/index.cjs`) — a dev/test
 * convenience, not something this call site can rely on, since the prod API
 * runs with `NODE_ENV=production`. Without a compiler, `i18n._()` cannot
 * parse the raw ICU fallback template at all: it returns it VERBATIM
 * (`"Row {rowId}: …"`, braces and all) and logs a multi-line
 * `console.warn('Uncompiled message detected! …')` on every single
 * `apiError()` call, params or not — on prod this silently undid the
 * `interpolate`→`@lingui/core` rewrite above for every refusal. Registering
 * the compiler explicitly on every instance (constant, imported once at
 * module scope, not re-required per call) makes rendering identical in
 * dev/test and prod.
 */
function interpolate(code: ApiErrorCode, params?: Record<string, string | number>): string {
  const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
  i18n.setMessagesCompiler(compileMessage)
  // `API_ERROR_MESSAGES[code].id` (a member expression), not a template
  // literal built from `code` — `lingui extract`'s babel plugin tries to
  // statically resolve the id argument of every `i18n._()` call and warns
  // ("Could not extract from template literal with expressions") on a
  // template literal it cannot fully resolve; a member expression is the
  // form `translateApiError` (`apps/web/app/lib/axios-utils.ts`) already
  // uses for the identical reason, documented there.
  return i18n._(API_ERROR_MESSAGES[code].id, params, { message: API_ERROR_FALLBACK_EN[code] })
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
 * otherwise — kept as a conditional tuple (not `params?`) rather than
 * simplified away, since that is what makes the zero-param case a compile
 * error instead of a silently accepted `{}`; see that file's doc comment
 * for why the simpler `params?: ParamsFor<C>` form does not. task-i18n-
 * stage4-task3 (PR #702) gave five codes real params for the first time
 * since PR #694 round 3 removed the last one — `interpolate` above renders
 * them through `@lingui/core` accordingly (SR-M-1, PR #702 fix-round 1).
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
    message: interpolate(code, params),
  }
  return new HttpException(body, status)
}
