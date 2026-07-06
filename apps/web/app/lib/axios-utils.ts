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
 * Extracts a user-friendly error message from an unknown error value,
 * preferring the backend's `response.data.message` over the generic
 * Axios `.message` string (e.g. "Request failed with status code 400").
 *
 * NestJS validation errors surface `.message` as a string[] (Zod field
 * errors joined with ". "). NestJS BadRequestException surfaces it as a
 * plain string. Both cases are handled.
 *
 * @example
 *   const msg = getApiErrorMessage(mutation.error)
 *   // "Зарплата для этого сотрудника за выбранный месяц уже создана"
 */
export function getApiErrorMessage(err: unknown, fallback = 'Произошла ошибка'): string {
  if (err === null || err === undefined) return fallback
  if (typeof err !== 'object') return fallback

  // Try to read response.data.message (NestJS standard error shape)
  const maybeAxios = err as Record<string, unknown>
  const response = maybeAxios['response']
  if (response !== null && typeof response === 'object') {
    const data = (response as Record<string, unknown>)['data']
    if (data !== null && typeof data === 'object') {
      const msg = (data as Record<string, unknown>)['message']
      if (typeof msg === 'string' && msg.length > 0) return msg
      if (Array.isArray(msg) && msg.length > 0) {
        return msg.map((m) => (typeof m === 'string' ? m : String(m))).join('. ')
      }
    }
  }

  // Fall back to the generic axios .message (e.g. "Network Error")
  if ('message' in maybeAxios && typeof maybeAxios['message'] === 'string') {
    return maybeAxios['message']
  }

  return fallback
}
