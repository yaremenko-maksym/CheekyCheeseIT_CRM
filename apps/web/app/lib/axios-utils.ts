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
 * Extracts a user-friendly error message from an unknown error value.
 *
 * Priority (highest first):
 * 1. `response.data.errors[]` — ZodExceptionFilter shape:
 *    `{ statusCode, message: "Validation failed", errors: [{ path, message }] }`
 *    path is already a dot-joined string from the filter, but we also accept
 *    array paths defensively. Multiple errors joined with "; ".
 * 2. `response.data.message` — NestJS BadRequestException string or string[].
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

  const maybeAxios = err as Record<string, unknown>
  const response = maybeAxios['response']
  if (response !== null && typeof response === 'object') {
    const data = (response as Record<string, unknown>)['data']
    if (data !== null && typeof data === 'object') {
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
      if (typeof msg === 'string' && msg.length > 0) return msg
      if (Array.isArray(msg) && msg.length > 0) {
        return msg.map((m) => (typeof m === 'string' ? m : String(m))).join('. ')
      }
    }
  }

  // Priority 3: generic axios .message (e.g. "Network Error").
  if ('message' in maybeAxios && typeof maybeAxios['message'] === 'string') {
    return maybeAxios['message']
  }

  return fallback
}
