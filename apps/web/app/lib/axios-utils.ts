import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import type { MessageDescriptor } from '@lingui/core'
import {
  API_ERROR_MESSAGES,
  apiErrorEnvelopeSchema,
  ZOD_ERROR_CODES,
  ZOD_ERROR_MESSAGES,
  type ApiErrorCode,
  type ZodErrorCode,
} from '@crm/shared'

/**
 * Extracts the HTTP status code from an unknown Axios error value.
 *
 * Axios errors carry a `.response.status` field but the catch-block type
 * is `unknown`. Rather than repeating the same verbose cast in every hook,
 * callers use this narrow utility.
 *
 * @example
 *   const status = getAxiosStatus(err)
 *   if (status === 404) return null
 */
export function getAxiosStatus(err: unknown): number | undefined {
  if (
    err !== null &&
    typeof err === 'object' &&
    'response' in err &&
    err.response !== null &&
    typeof err.response === 'object' &&
    'status' in err.response &&
    typeof (err.response as { status?: unknown }).status === 'number'
  ) {
    return (err.response as { status: number }).status
  }
  return undefined
}

/**
 * Strips the query string off a request URL/path before it's ever logged
 * anywhere (console OR telemetry) — security-review round 2, MED-2: a query
 * string can carry PII (`?email=user@example.com`) exactly like a response
 * body can, so it gets the same treatment. ONE policy, used everywhere a
 * request URL is logged (`axios.ts`'s `console.error`, telemetry's
 * `sanitizeErrorForReport`) — path + method + status is enough to debug an
 * API failure; the full URL (with params) is already in the browser's
 * Network tab for anyone who needs it.
 */
export function stripQueryString(url: string | undefined): string {
  if (url === undefined) return '?'
  const i = url.indexOf('?')
  return i === -1 ? url : url.slice(0, i)
}

/**
 * Nest's own STANDARD, generic HTTP reason phrase — what `response.data.message`
 * holds when nobody wrote an actual explanation. Two sources, both in this
 * exact wording:
 *
 * - Any `@nestjs/common` `HttpException` subclass constructed with no
 *   explicit message (`new ForbiddenException()`) defaults its message to its
 *   OWN reason phrase — `exceptions/*.exception.js`'s constructor defaults.
 * - Any exception `@nestjs/core`'s `BaseExceptionFilter` did not recognise as
 *   an `HttpException` at all (a genuinely unhandled bug) becomes exactly
 *   `'Internal server error'` — `MESSAGES.UNKNOWN_EXCEPTION_MESSAGE`.
 *
 * Compared case-insensitively: the two sources disagree on casing for the
 * same 500 ('Internal Server Error' vs 'Internal server error').
 *
 * EXPORTED (task-mutation-gate follow-up, PR #613, backlog 121) so the spec
 * can iterate the LIVE set — a set this size (~19 one-word-different string
 * literals) is exactly the shape where a handful of sampled test cases
 * leaves most entries provably untested. The mutation gate found FIVE
 * ('unauthorized' / 'method not allowed' / 'not acceptable' / 'request
 * timeout' / 'http version not supported') still readable as a literal `""`
 * with every existing test green, because that first iterating test read
 * BOTH the phrase it sent AND the phrase it checked against from this same
 * live export — a mutated literal travels with the import, so the loop only
 * proved the code agrees with itself (fixed in test/pr613-phrase-set-pinning).
 * Closing that gap needed a SECOND list in the spec — typed out by hand,
 * not derived from this export — that a mutation HERE cannot also corrupt.
 * That second list (`KNOWN_GENERIC_HTTP_REASON_PHRASES` in the spec) is
 * deliberate duplication, not slack to trim: duplication is what makes a
 * corrupted literal visible. The live-set loop stays too, for what it is
 * actually good for — catching a phrase added here later with no matching
 * row in the hand-copied list.
 */
export const GENERIC_HTTP_REASON_PHRASES = new Set([
  'bad request',
  'unauthorized',
  'forbidden',
  'not found',
  'method not allowed',
  'not acceptable',
  'request timeout',
  'conflict',
  'gone',
  'precondition failed',
  'payload too large',
  'unsupported media type',
  'misdirected',
  'unprocessable entity',
  'internal server error',
  'not implemented',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'http version not supported',
])

/**
 * True when `message` is NOTHING MORE than one of Nest's own generic reason
 * phrases (see `GENERIC_HTTP_REASON_PHRASES`) — text that LOOKS like a
 * backend explanation (`response.data.message` is populated) but adds
 * nothing a status code doesn't already say.
 *
 * Backlog finding 110, found live in the cascade-preview panel: a raw 500/403
 * with no custom message reached the money screen as English ("Internal
 * server error", "Forbidden") because `extractBackendMessage` trusted ANY
 * populated `data.message` as a real explanation. A genuine business message
 * — `'Некорректная сумма'`, `'Зарплата уже создана'`, the 409 cascade-stale
 * text — never matches this set (it is not one of the ~19 fixed English
 * phrases above) and passes through completely unaffected.
 */
function isGenericHttpReasonPhrase(message: string): boolean {
  return GENERIC_HTTP_REASON_PHRASES.has(message.trim().toLowerCase())
}

/**
 * Parses `err.response.data` against `apiErrorEnvelopeSchema` — the shape
 * `apiError()` (`apps/api/src/common/api-error.ts`) builds for the eight
 * codes in the registry (`packages/shared/src/schemas/api-errors.ts`).
 * `.safeParse` rather than `.parse`: an ordinary NestJS error body (no
 * `code` field, or a `code` outside the registry) is the EXPECTED shape for
 * every endpoint not yet migrated to `apiError()` — that is not a parse
 * failure to report, just "no envelope here", so callers fall through to
 * the prose-based paths below.
 */
function parseApiErrorEnvelope(err: unknown) {
  if (err === null || typeof err !== 'object') return undefined
  const data = (err as { response?: { data?: unknown } }).response?.data
  const result = apiErrorEnvelopeSchema.safeParse(data)
  return result.success ? result.data : undefined
}

/**
 * The `code` from an API error envelope, or `null` when the error carries
 * none (either not an envelope at all, or an ordinary prose-only error).
 * Lets a component branch on a STABLE machine identifier instead of
 * `.includes('some english substring')` matched against translatable prose
 * (task-i18n-stage2-task5 — see `ContractTab.tsx` / `UserDialog.tsx`, both
 * migrated off exactly that pattern by this function).
 */
export function getApiErrorCode(err: unknown): ApiErrorCode | null {
  return parseApiErrorEnvelope(err)?.code ?? null
}

/**
 * Translates one envelope code through the Lingui catalog.
 *
 * Deliberately NOT `i18n._({ ...API_ERROR_MESSAGES[code], values: params })`
 * — `lingui extract`'s babel plugin (`@lingui/babel-plugin-extract-messages`)
 * treats EVERY `i18n._(<object>)` call as a message descriptor to extract
 * from, regardless of the `/* i18n *\/` comment convention, and crashes
 * (`Cannot read properties of undefined (reading 'name')`) on a
 * `SpreadElement` property — confirmed empirically running `pnpm i18n:extract`
 * against that form. Passing the id as its OWN (non-literal) expression
 * takes the extractor's other branch instead: `getTextFromExpression` on a
 * `MemberExpression` returns `undefined` (not a string/template literal),
 * so it skips the call cleanly. The `{ id: '' }.<CODE>` entries themselves
 * are still extracted — from `api-errors.ts`'s OWN `/* i18n *\/`-marked
 * object literals, which is where they belong; this call site only ever
 * looks one up by a code already in the registry, never defines a new one.
 */
function translateApiError(
  code: ApiErrorCode,
  params: Record<string, string | number> | undefined,
): string {
  const descriptor = API_ERROR_MESSAGES[code]
  // `MessageOptions.message` is `message?: string` — under
  // `exactOptionalPropertyTypes`, an omitted key and an explicit `undefined`
  // are different types, so `{ message: descriptor.message }` (where
  // `descriptor.message` is `string | undefined`) does not type-check even
  // though every real registry entry sets it. Build the options object only
  // when there is something to put in it.
  // Stryker disable next-line ConditionalExpression: this ONE directive
  // silences BOTH mutants a ternary produces (forced-true, forced-false) —
  // Stryker groups by line+mutator, it cannot suppress one and not the
  // other. Reasoning per mutant, so a future reader can tell this was a
  // choice, not an oversight:
  //   - forced-true (`options` always `{ message: ... }`): survives on
  //     purpose. Reaching the `: undefined` branch needs a registry entry
  //     with no `message` — impossible through the public surface, since
  //     every `API_ERROR_MESSAGES[code]` descriptor sets one, an invariant
  //     `api-errors.spec.ts` pins for all eight codes ("every code has a
  //     message descriptor... message.length > 0"). No assertion here
  //     could distinguish this from a passing-by-construction test.
  //   - forced-false (`options` always `undefined`): NOT genuinely
  //     unobservable — verified by hand that `getApiErrorMessage` /
  //     `getUserFacingErrorMessage`'s envelope tests below fail against it
  //     (the empty-catalog `i18n.load('uk', {})` setup falls through to
  //     `id` instead of the Ukrainian text once `options.message` is gone).
  //     Suppressed only as an unavoidable side effect of sharing this line
  //     with the mutant above — the behavior stays covered by those tests,
  //     Stryker just no longer re-verifies it on every run.
  const options = descriptor.message !== undefined ? { message: descriptor.message } : undefined
  return i18n._(descriptor.id, params, options)
}

/**
 * task-i18n-stage4-task4. Runtime narrowing for a string read off the wire
 * (or off a shared validator's return value) against the registry's
 * compile-time union — mirrors `ZOD_ERROR_CODES`'s role in
 * `zod-exception.filter.ts` (server) exactly, just on the client.
 */
function isZodErrorCode(value: string): value is ZodErrorCode {
  return (ZOD_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Translates one `ZOD_ERROR_MESSAGES` code through the Lingui catalog — same
 * pattern as `translateApiError` above (`options` built conditionally per
 * `exactOptionalPropertyTypes`; the non-object-literal `i18n._` call shape so
 * `lingui extract`'s babel plugin does not choke on this call site — see
 * `translateApiError`'s own comment for why).
 */
function translateZodError(code: ZodErrorCode): string {
  const descriptor = ZOD_ERROR_MESSAGES[code]
  // Same ternary, same exactOptionalPropertyTypes reason, same two-mutant
  // split as `translateApiError`'s own options object above — see that
  // function's comment for the full reasoning per mutant (forced-true:
  // unobservable, every `ZOD_ERROR_MESSAGES[code]` descriptor sets `message`,
  // pinned by `zod-errors.spec.ts`'s "every code has a message descriptor"
  // invariant; forced-false: genuinely observable, breaks the empty-catalog
  // fallback this file's own tests rely on).
  // Stryker disable next-line ConditionalExpression: this ONE directive silences both mutants a ternary produces — see translateApiError's identical comment above for the per-mutant reasoning
  const options = descriptor.message !== undefined ? { message: descriptor.message } : undefined
  return i18n._(descriptor.id, undefined, options)
}

/**
 * Translates a KNOWN registry code straight through the catalog — for a
 * caller that already has a literal `ZodErrorCode` in hand (typically a
 * fallback for a `translateZodMessage` that CAN be `undefined`, e.g.
 * `toast.error(translateZodMessage(x) ?? translateZodCode('VALIDATION_FAILED_FORM'))`).
 * Unlike `translateZodMessage`, the result is never `undefined` — the code
 * is a compile-time-checked member of `ZodErrorCode`, not a runtime-unknown
 * string, so there is no "not one of ours" branch to fall through (fix-round
 * 1, COPY-M-8/SR-M-1 — replaces the plain-Russian-literal fallbacks these
 * `toast.error` calls used to carry).
 */
export function translateZodCode(code: ZodErrorCode): string {
  return translateZodError(code)
}

/**
 * Translates a RAW Zod issue message for direct display, covering both
 * shapes that message can arrive in:
 *  - read off a FAILED backend response body (`extractBackendMessage`'s
 *    Priority 1, below);
 *  - returned DIRECTLY by a `@crm/shared` validator called CLIENT-SIDE for
 *    live, pre-submit validation — e.g. `transactionAmountError` in
 *    `PaySalaryDialog` — same `'zod.<CODE>'` convention, no HTTP round-trip
 *    involved at all, so `extractBackendMessage`'s envelope-parsing path
 *    never sees it.
 *
 * A message that is NOT one of our codes (an ordinary Zod built-in message,
 * or a not-yet-migrated schema's literal) passes through unchanged — the
 * SAME "migrated code vs. legacy prose" branch `ZodExceptionFilter` applies
 * server-side, kept in agreement on both sides by reading the same prefix
 * convention. Exported so every form that calls a shared validator directly
 * (not only ones that go through an HTTP response) gets translated text
 * instead of a raw `zod.<CODE>` string.
 *
 * Returns `undefined` (not `null`) for a null/undefined/absent input —
 * matches the field-validator return convention every caller of this
 * function actually needs (`@tanstack/react-form`'s `validators.onBlur`
 * requires `string | undefined`, never `null`). A caller that itself needs
 * `null` for "no error" (e.g. `transactionAmountError`'s own convention in
 * `PaySalaryDialog`) is unaffected — `??` treats `undefined` exactly like
 * `null`, and every render site already coerces with `?? undefined` besides.
 */
export function translateZodMessage(message: string | null | undefined): string | undefined {
  if (message === null || message === undefined) return undefined
  if (!message.startsWith('zod.')) return message
  const code = message.slice('zod.'.length)
  return isZodErrorCode(code) ? translateZodError(code) : message
}

/**
 * Extracts a message the BACKEND explicitly put in the response body, or
 * `undefined` if the body carried nothing usable — nothing usable now also
 * covers Nest's own generic reason phrase (finding 110, see
 * `isGenericHttpReasonPhrase`), which explains nothing beyond the status
 * code and is English besides. Shared by `getApiErrorMessage` (below — falls
 * through to axios's own generic `.message` when this returns nothing) and
 * `getUserFacingErrorMessage` (falls through to a status-code-derived
 * Russian message instead — see its doc for why raw `.message` is never
 * shown to the user). Fixed HERE rather than in either caller, or in a
 * component: both functions — and every screen that calls them, including
 * ones written after this fix — inherit the correction for free.
 *
 * Priority (highest first):
 * 1. `response.data.errors[]` — ZodExceptionFilter shape:
 *    `{ statusCode, message: "Validation failed", errors: [{ path, message }] }`
 *    path is already a dot-joined string from the filter, but we also accept
 *    array paths defensively. Multiple errors joined with "; ".
 * 1.5. `response.data.code` (fix-round 2, SR-M-4/COPY-H-4) — a `zodErrorBadRequest`
 *    direct-throw envelope's TOP-LEVEL code (`{ statusCode, code, message }`,
 *    no `errors[]` wrapper): translated through the SAME `ZOD_ERROR_MESSAGES`
 *    registry as the `errors[]` branch above, one code at a time.
 * 2. `response.data.message` — NestJS exception string or string[], UNLESS it
 *    is nothing more than one of Nest's own generic reason phrases (checked
 *    against the message text alone, not cross-referenced with the status —
 *    the phrase itself is already unambiguous, whatever status it rides on).
 *
 * EXPORTED (COPY-M-2/COPY-M-3, PR #613 round 2) for one more reuse besides the
 * two above: a screen that needs to show a REAL backend explanation verbatim
 * but wants its OWN fallback for the "backend said nothing usable" case,
 * instead of the general per-status table `getUserFacingErrorMessage` falls
 * back to (see `cascade-preview.ts`'s `cascadeStaleMessage` /
 * `cascadePreviewErrorMessage`). Exporting this one function, rather than
 * copying its body, keeps the "what counts as a real backend message" rule in
 * exactly one place — the same reasoning `needsCascadePreview`'s own doc
 * gives for not inlining that rule twice.
 */
export function extractBackendMessage(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined

  const response = (err as Record<string, unknown>)['response']
  if (response === null || typeof response !== 'object') return undefined
  const data = (response as Record<string, unknown>)['data']
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>

  // Priority 1: ZodExceptionFilter errors array → field-level details.
  // Filter emits, per issue: `{ path, code, params?, message }` for a
  // MIGRATED schema's issue (task-i18n-stage4-task4 — `code` translated
  // through the catalog, `message` the English fallback for a client
  // without one) or `{ path, message }` for a not-yet-migrated one (as
  // before this task). path is already dot-joined on the server, but accept
  // arrays defensively.
  if (Array.isArray(d['errors']) && d['errors'].length > 0) {
    const parts = (d['errors'] as unknown[])
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => {
        // fix-round 1 (COPY-M-9): a MIGRATED issue (`code` present) already
        // names its field in the translated text itself — prepending the raw
        // API field name (`walletUsdtErc20: …`) on top is both redundant and,
        // unlike the translated text, untranslated. The `path:` prefix is
        // kept ONLY for a legacy issue (`message` with no `code`), where the
        // field name is the only positional context the reader has.
        const rawCode = e['code']
        // fix-round 3 (SR-L-2): this ONE directive silences all THREE
        // ConditionalExpression mutants Stryker generates on this line —
        // Stryker groups by line+mutator, it cannot suppress one and not
        // the others. Reasoning per mutant (confirmed by actually running
        // the gate with the directive removed, not just reasoned about):
        //   - whole-condition forced-true (every issue treated as a valid
        //     code): genuinely observable — KILLED, this round, by "falls
        //     back to the message field when code is present but unknown"
        //     below, which throws through `translateZodError`'s registry
        //     lookup on a code with no entry. Suppressed only as an
        //     unavoidable side effect of sharing the line with the
        //     survivor below — coverage stays real, Stryker just no
        //     longer re-verifies it every run.
        //   - whole-condition forced-false (branch body never runs): also
        //     KILLED, same test — falls through to the path-prefixed raw
        //     message instead of the translated text. Same caveat.
        //   - left-operand-only forced-true (`typeof rawCode === 'string'`
        //     replaced by `true`, `isZodErrorCode(rawCode)` still runs):
        //     genuinely unobservable. `isZodErrorCode` is `.includes()` —
        //     SameValueZero comparison against `ZOD_ERROR_CODES` — which
        //     safely returns `false` for ANY non-string input (never
        //     throws, never coerces), exactly like the `typeof` guard it's
        //     paired with would have short-circuited to. No assertion can
        //     tell "checked the type first" from "skipped the check, let
        //     `.includes()` reject it anyway" apart.
        // Stryker disable next-line ConditionalExpression: left-operand-only forced-true is unobservable — isZodErrorCode's .includes() rejects any non-string anyway; the sibling whole-condition mutants this line also silences are killed by the 'NOT_A_REAL_CODE' fallback tests above
        if (typeof rawCode === 'string' && isZodErrorCode(rawCode)) {
          return translateZodError(rawCode)
        }
        const rawPath = e['path']
        const pathStr = Array.isArray(rawPath)
          ? rawPath.map((p) => String(p)).join('.')
          : typeof rawPath === 'string'
            ? rawPath
            : ''
        const msgStr = typeof e['message'] === 'string' ? e['message'] : ''
        return pathStr ? `${pathStr}: ${msgStr}` : msgStr
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('; ')
  }

  // Priority 1.5 (fix-round 2, SR-M-4/COPY-H-4): a direct-throw envelope
  // built by `zodErrorBadRequest` (`apps/api/src/common/zod-error-exception.ts`)
  // — `{ statusCode, code: 'RECEIPT_REQUIRED', message: <english fallback> }`
  // at the TOP level, not wrapped inside `errors[]`. These calls happen
  // BEFORE Zod's own `.parse()` boundary (a server-method defense-in-depth
  // re-check, not a schema issue), so `ZodExceptionFilter` never builds its
  // usual per-issue array for them, AND `apiErrorEnvelopeSchema`'s `code`
  // enum (`API_ERROR_CODES`, a DIFFERENT registry from `ZOD_ERROR_CODES`)
  // never matches `code`, so `parseApiErrorEnvelope` in the caller can't
  // catch this body either — without this branch, Priority 2 below would
  // return the envelope's raw English `message` fallback verbatim, in
  // Ukrainian/English UI. Same `code`-over-`errors[]` shape as the branch
  // above, just for a code that isn't wrapped in an array.
  const rawTopCode = d['code']
  // fix-round 3 (SR-L-2): same reasoning as the `errors[]` branch's
  // identical guard above — this ONE directive silences all THREE
  // ConditionalExpression mutants Stryker generates on this line (whole-
  // condition forced-true/forced-false, both KILLED this round by "falls
  // through to response.data.message when the top-level code is not one
  // of ours" below; left-operand-only forced-true, genuinely unobservable
  // — `isZodErrorCode`'s `.includes()` safely returns `false` for any
  // non-string value, so skipping the `typeof` check changes nothing).
  // Stryker disable next-line ConditionalExpression: left-operand-only forced-true is unobservable — isZodErrorCode's .includes() rejects any non-string anyway; the two whole-condition mutants this line also silences are killed by the top-level 'NOT_A_REAL_CODE' fallback test above
  if (typeof rawTopCode === 'string' && isZodErrorCode(rawTopCode)) {
    return translateZodError(rawTopCode)
  }

  // Priority 2: standard NestJS message field (string or string[]).
  const msg = d['message']
  if (typeof msg === 'string' && msg.length > 0) {
    return isGenericHttpReasonPhrase(msg) ? undefined : msg
  }
  if (Array.isArray(msg) && msg.length > 0) {
    return msg.map((m) => (typeof m === 'string' ? m : String(m))).join('. ')
  }

  return undefined
}

/**
 * Extracts a user-friendly error message from an unknown error value.
 *
 * Priority (highest first):
 * 1-2. `extractBackendMessage` (see above — errors[] then response.data.message).
 * 3. `err.message` — generic Axios message (e.g. "Request failed with status code 400").
 * 4. `fallback` string.
 *
 * @example
 *   getApiErrorMessage(err)
 *   // "Зарплата для этого сотрудника за выбранный месяц уже создана"
 *   // "salaryMonth: Format YYYY-MM"
 */
export function getApiErrorMessage(
  err: unknown,
  fallback = i18n._(UNKNOWN_ERROR_FALLBACK),
): string {
  if (err === null || err === undefined) return fallback
  if (typeof err !== 'object') return fallback

  // Priority 0 (task-i18n-stage2-task5): a response body matching the API
  // error envelope translates by `code`, through the Lingui catalog — this
  // runs BEFORE `extractBackendMessage`'s own priority 1-2 (which would
  // otherwise return the envelope's English `message` fallback verbatim,
  // untranslated). Every endpoint not yet migrated to `apiError()` has no
  // envelope here and falls through unaffected.
  const envelope = parseApiErrorEnvelope(err)
  if (envelope) {
    return translateApiError(envelope.code, envelope.params)
  }

  const backendMessage = extractBackendMessage(err)
  if (backendMessage !== undefined) return backendMessage

  // Priority 3: generic axios .message (e.g. "Network Error"). Note: once
  // `api.interceptors.response` (axios.ts) runs, this is ALREADY the
  // humanized text from `getUserFacingErrorMessage` below — this branch only
  // sees the raw technical string for errors that never went through that
  // interceptor (e.g. hand-built objects in tests).
  const maybeAxios = err as Record<string, unknown>
  if ('message' in maybeAxios && typeof maybeAxios['message'] === 'string') {
    return maybeAxios['message']
  }

  return fallback
}

const STATUS_MESSAGES: Readonly<Record<number, MessageDescriptor>> = {
  400: msg`Некоректний запит. Перевірте введені дані і спробуйте знову.`,
  401: msg`Потрібно увійти в систему знову.`,
  403: msg`Недостатньо прав для цієї дії.`,
  404: msg`Запитувані дані не знайдено.`,
  409: msg`Конфлікт даних. Оновіть сторінку і спробуйте знову.`,
  413: msg`Файл занадто великий.`,
  415: msg`Формат файлу не підтримується.`,
  // Канон 429 — тот же текст, что TosPdfPreview.tsx (Task 1, Step 5,
  // COPY-M-core-16) — grep там сверяет, что тексты не разошлись.
  429: msg`Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз`,
}

const SERVER_ERROR_MESSAGE = msg`Помилка на нашій стороні. Ми вже знаємо про проблему — спробуйте трохи пізніше.`
const GENERIC_HTTP_FALLBACK = msg`Не вдалося виконати запит. Спробуйте ще раз.`
const NETWORK_ERROR_MESSAGE = msg`Немає зв’язку із сервером. Перевірте підключення до інтернету і спробуйте знову.`
// COPY-L-core-22: было ДВА разных текста последнего рубежа
// (getApiErrorMessage's default param 'Произошла ошибка' vs
// UNKNOWN_ERROR_FALLBACK 'Произошла ошибка. Попробуйте ещё раз.') —
// один и тот же текст в обоих местах теперь.
const UNKNOWN_ERROR_FALLBACK = msg`Сталася помилка. Спробуйте ще раз.`

function messageForStatus(status: number): string {
  const known = STATUS_MESSAGES[status]
  if (known !== undefined) return i18n._(known)
  if (status >= 500) return i18n._(SERVER_ERROR_MESSAGE)
  return i18n._(GENERIC_HTTP_FALLBACK)
}

/** True for anything axios itself threw (HTTP error OR network/timeout/cancel). */
function isAxiosErrorShape(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as Record<string, unknown>)['isAxiosError'] === true
  )
}

/**
 * Resolves the message to SHOW THE USER for an API/network failure.
 *
 * Priority: backend-supplied message (validation details, business rules —
 * `extractBackendMessage`) → our own translated text for the HTTP status code
 * → "no connection to the server" when the request never got a response at
 * all (offline, DNS, CORS, timeout) → a generic fallback for anything else.
 *
 * Deliberately NEVER returns axios's own generated `.message` (e.g.
 * "Request failed with status code 415", "Network Error") — that string is
 * English, technical, and meaningless to a non-technical user (see
 * `russian-language.md`'s successor rule — CRM product language is uk/en).
 * We don't invent a specific reason we don't actually know (task
 * fix/api-error-messages §3) — codes without a known canned message get the
 * honest, generic `GENERIC_HTTP_FALLBACK` / `SERVER_ERROR_MESSAGE`, never a
 * guessed cause.
 *
 * This is the single place that computes the user-facing text — called from
 * `axios.ts`'s response interceptor so every consumer that reads `err.message`
 * downstream (dozens of `toast.error(...${e.message})` call sites across the
 * app) gets it for free.
 *
 * @example
 *   getUserFacingErrorMessage({ response: { status: 415 } })
 *   // "Формат файлу не підтримується."
 *   getUserFacingErrorMessage({ isAxiosError: true, message: 'Network Error' })
 *   // "Немає зв’язку із сервером. Перевірте підключення до інтернету і спробуйте знову."
 */
export function getUserFacingErrorMessage(err: unknown): string {
  // Priority 0 (task-i18n-stage2-task5): same envelope-by-code translation
  // as `getApiErrorMessage` above — this function feeds `err.message` via
  // the global axios interceptor (`axios.ts`), so every `toast.error(e.message)`
  // call site in the app reads it, not just callers of `getApiErrorMessage`
  // directly. Without this, the eight-code envelope's English fallback
  // (`apiError()`'s `message` field) would surface verbatim in toasts for
  // the seven endpoints already migrated — English text where the rest of
  // the app is Ukrainian, the exact regression `russian-language.md`'s
  // successor rule (CRM product language is uk/en) exists to prevent.
  const envelope = parseApiErrorEnvelope(err)
  if (envelope) {
    return translateApiError(envelope.code, envelope.params)
  }

  const backendMessage = extractBackendMessage(err)
  if (backendMessage !== undefined) return backendMessage

  const status = getAxiosStatus(err)
  if (status !== undefined) return messageForStatus(status)

  if (isAxiosErrorShape(err)) return i18n._(NETWORK_ERROR_MESSAGE)

  return i18n._(UNKNOWN_ERROR_FALLBACK)
}
