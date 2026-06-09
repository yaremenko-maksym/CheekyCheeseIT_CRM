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
