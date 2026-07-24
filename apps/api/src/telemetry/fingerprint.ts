import { createHash } from 'node:crypto'

/**
 * fingerprint.ts — task-telemetry-api contract: "fingerprint (sha256 от
 * normalized message+top-frames+source) UNIQUE". Groups repeated occurrences
 * of the SAME error into one `telemetry_errors` row (count++/last_seen bump;
 * see `TelemetryErrorsService.recordError`).
 *
 * Deterministic given the same (source, message, stack) — identical inputs
 * ALWAYS produce the identical fingerprint (AC2: 3 identical errors → 1 row).
 */

const TOP_FRAMES_COUNT = 3

// sec MED (review round 1, both reviewers): volatile per-occurrence values
// inside a message must NOT participate in the fingerprint, or every
// occurrence of an otherwise-identical error (different UUID/id/timestamp
// each time) gets its OWN row instead of grouping into one (defeats AC2's
// whole point — count++ dedup). Order matters: UUID (most specific, dashed
// hex) first, then ISO timestamps (has its own T/:/- structure), then
// generic hex identifiers (>=8 hex chars — git SHAs, tx hashes, session
// ids), then plain 3+-digit numbers last (anything still left: ports,
// counters, amounts, ids).
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g
const HEX_ID_PATTERN = /\b[0-9a-f]{8,}\b/gi
const NUMBER_PATTERN = /\b\d{3,}\b/g

/**
 * Collapses incidental whitespace differences, THEN strips volatile
 * per-occurrence values (UUID/timestamp/hex-id/number) to placeholders —
 * see the comment above for why. Two error messages differing ONLY by a
 * UUID (e.g. "user <uuid1> not found" vs "user <uuid2> not found") produce
 * the IDENTICAL normalized string, and therefore the identical fingerprint.
 */
function normalizeMessage(message: string): string {
  return message
    .trim()
    .replace(/\s+/g, ' ')
    .replace(UUID_PATTERN, '<id>')
    .replace(ISO_TIMESTAMP_PATTERN, '<ts>')
    .replace(HEX_ID_PATTERN, '<hex>')
    .replace(NUMBER_PATTERN, '<n>')
}

/**
 * Extracts the first `TOP_FRAMES_COUNT` real stack-trace lines (lines
 * starting with `at `, i.e. NOT the leading "Error: <message>" line some
 * stacks include). Returns `''` when there is no stack at all.
 */
function topStackFrames(
  stack: string | null | undefined,
  count: number = TOP_FRAMES_COUNT,
): string {
  if (!stack) return ''
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, count)
    .join('\n')
}

export interface FingerprintInput {
  source: 'WEB' | 'API'
  message: string
  stack?: string | null | undefined
}

/** sha256(source :: normalized message :: top-3 stack frames), hex-encoded. */
export function computeFingerprint(input: FingerprintInput): string {
  const normalizedMessage = normalizeMessage(input.message)
  const frames = topStackFrames(input.stack)
  const raw = `${input.source}::${normalizedMessage}::${frames}`
  return createHash('sha256').update(raw).digest('hex')
}
