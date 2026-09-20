import { i18n } from '@lingui/core'
import { API_ERROR_MESSAGES, apiErrorEnvelopeSchema, type ApiErrorCode } from '@crm/shared'
import { ROLE_LABELS } from '@/components/ui/role-select'

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
 * Maps a `role` param through `ROLE_LABELS` (`role-select.tsx`) before it
 * reaches the catalog — COPY-H-1, PR #694 round 2. Without this, a raw enum
 * token (`SENIOR`) lands verbatim inside translated prose ("для ролі
 * SENIOR"), which reads as a bug next to `/admin/contracts`'s own toast
 * ("Шаблон для ролі Синьор опубліковано") built from the same map. Any
 * OTHER param key passes through untouched — `role` is the only one any
 * registered code declares today (`API_ERROR_PARAMS`).
 *
 * `ROLE_LABELS` is Ukrainian-only (no locale-aware catalog entries yet —
 * see `api-errors.ts`'s doc comment), so this is a known interim: once
 * stage 3 turns `ROLE_LABELS` into per-locale descriptors, this lookup
 * localizes for free without a call-site change here.
 *
 * EXPORTED (mutation-gate finding, PR #694 round 2) so the "no `role` key at
 * all" branch has a seam a test can observe directly: through
 * `translateApiError`'s rendered STRING, skipping the early return is
 * unobservable — the object this function returns gains a stray
 * `role: undefined` own key either way, and no catalog message interpolates
 * an unused key into its text. The extra key itself is the only thing that
 * differs, so the test asserts on `Object.keys(...)`, not on translated text.
 */
export function applyRoleLabel(
  params: Record<string, string | number> | undefined,
): Record<string, string | number> | undefined {
  if (params === undefined || typeof params['role'] !== 'string') return params
  const role = params['role']
  return { ...params, role: ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role }
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
  return i18n._(descriptor.id, applyRoleLabel(params), options)
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
  // Filter emits: errors: [{ path: string, message: string }]
  // path is already dot-joined on the server, but accept arrays defensively.
  if (Array.isArray(d['errors']) && d['errors'].length > 0) {
    const parts = (d['errors'] as unknown[])
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => {
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
export function getApiErrorMessage(err: unknown, fallback = 'Произошла ошибка'): string {
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

const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  400: 'Некорректный запрос. Проверьте введённые данные и попробуйте снова.',
  401: 'Нужно войти в систему заново.',
  403: 'Недостаточно прав для этого действия.',
  404: 'Запрашиваемые данные не найдены.',
  409: 'Конфликт данных. Обновите страницу и попробуйте снова.',
  413: 'Файл слишком большой.',
  415: 'Формат файла не поддерживается.',
  429: 'Слишком много запросов подряд. Подождите немного и повторите попытку.',
}

const SERVER_ERROR_MESSAGE =
  'Ошибка на нашей стороне. Мы уже знаем о проблеме — попробуйте немного позже.'
const GENERIC_HTTP_FALLBACK = 'Не удалось выполнить запрос. Попробуйте ещё раз.'
const NETWORK_ERROR_MESSAGE =
  'Нет связи с сервером. Проверьте подключение к интернету и попробуйте снова.'
const UNKNOWN_ERROR_FALLBACK = 'Произошла ошибка. Попробуйте ещё раз.'

function messageForStatus(status: number): string {
  const known = STATUS_MESSAGES[status]
  if (known !== undefined) return known
  if (status >= 500) return SERVER_ERROR_MESSAGE
  return GENERIC_HTTP_FALLBACK
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
 * `extractBackendMessage`) → our own Russian text for the HTTP status code
 * → "no connection to the server" when the request never got a response at
 * all (offline, DNS, CORS, timeout) → a generic fallback for anything else.
 *
 * Deliberately NEVER returns axios's own generated `.message` (e.g.
 * "Request failed with status code 415", "Network Error") — that string is
 * English, technical, and meaningless to a non-technical user (see
 * `russian-language.md`). We don't invent a specific reason we don't
 * actually know (task fix/api-error-messages §3) — codes without a known
 * canned message get the honest, generic `GENERIC_HTTP_FALLBACK` /
 * `SERVER_ERROR_MESSAGE`, never a guessed cause.
 *
 * This is the single place that computes the user-facing text — called from
 * `axios.ts`'s response interceptor so every consumer that reads `err.message`
 * downstream (dozens of `toast.error(...${e.message})` call sites across the
 * app) gets it for free.
 *
 * @example
 *   getUserFacingErrorMessage({ response: { status: 415 } })
 *   // "Формат файла не поддерживается."
 *   getUserFacingErrorMessage({ isAxiosError: true, message: 'Network Error' })
 *   // "Нет связи с сервером. Проверьте подключение к интернету и попробуйте снова."
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

  if (isAxiosErrorShape(err)) return NETWORK_ERROR_MESSAGE

  return UNKNOWN_ERROR_FALLBACK
}
