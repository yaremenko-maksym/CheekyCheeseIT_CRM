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
 */
const GENERIC_HTTP_REASON_PHRASES = new Set([
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
  const backendMessage = extractBackendMessage(err)
  if (backendMessage !== undefined) return backendMessage

  const status = getAxiosStatus(err)
  if (status !== undefined) return messageForStatus(status)

  if (isAxiosErrorShape(err)) return NETWORK_ERROR_MESSAGE

  return UNKNOWN_ERROR_FALLBACK
}
