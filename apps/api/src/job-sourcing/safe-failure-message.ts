import { sanitizeAndTruncate, stripControlChars } from '../telemetry/sanitize'

/**
 * Turns a thrown value into something safe to put in an API RESPONSE —
 * security-review round 5.
 *
 * `collectAll` used to copy `err.message` verbatim into `failures[].message`,
 * which broke in two ways at once:
 *
 *  1. **It broke the very report it was supposed to deliver.** The wire schema
 *     caps the field at 1000 chars, and the response is `.parse()`d on the way
 *     OUT. A long message therefore turned the partial-success path into a
 *     `400 Validation failed` — the admin lost BOTH the failure report and the
 *     successful sources' results, precisely when something was already wrong.
 *  2. **It leaked database internals.** A Drizzle/pg failure message carries
 *     the ENTIRE statement plus its bound parameters (`Failed query: insert
 *     into "job_postings" … params: …`). ADMIN-only is not a reason to ship
 *     table shapes and row values to a browser.
 *
 * Two rules, in this order:
 *
 *  - **Recognisably a database error → replaced, not trimmed.** Trimming a
 *     query to 300 chars still ships 300 chars of schema. The operator gets a
 *     stable sentence; the full error is already in the server log (both
 *     `collectAll` and the cron log it with its stack).
 *  - **Anything else → sanitized, then truncated** via the shared
 *     `sanitizeAndTruncate` (Bearer/cookie/password redaction happens BEFORE
 *     the cut, so a secret straddling the boundary cannot survive as a
 *     fragment). This keeps our own actionable messages — "returned 0 usable
 *     postings", "category … is not allow-listed" — completely intact.
 *
 * The cap is deliberately far below the schema's 1000: a limit that sits ON the
 * schema boundary turns any future off-by-one into the same 400.
 */

/** Hard cap for a failure message on the wire — 1/3 of the schema's limit. */
export const MAX_FAILURE_MESSAGE_CHARS = 300

/**
 * Markers that mean "this text is a database error carrying a statement".
 * Drizzle prefixes with `Failed query:`; node-postgres messages quote the
 * relation/column and often the statement itself.
 */
const SQL_MARKERS =
  /(failed query|\binsert\s+into\b|\bselect\b[\s\S]*\bfrom\b|\bupdate\b[\s\S]*\bset\b|\bdelete\s+from\b|\bvalues\s*\(|\bparams:|\bconstraint\b|\brelation\b)/i

/** What an operator sees instead of a statement dump. */
export const DATABASE_FAILURE_MESSAGE =
  'Ошибка базы данных при сборе вакансий — подробности в журнале сервера'

export function toSafeFailureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Control chars first: a multi-line pg error must not smuggle fake lines into
  // a log or a future table renderer (same rule as the telemetry pipeline).
  const flattened = stripControlChars(raw).replace(/\s+/g, ' ').trim()

  if (flattened.length === 0) return 'Неизвестная ошибка сбора'
  if (SQL_MARKERS.test(flattened)) return DATABASE_FAILURE_MESSAGE

  return sanitizeAndTruncate(flattened, MAX_FAILURE_MESSAGE_CHARS)
}
