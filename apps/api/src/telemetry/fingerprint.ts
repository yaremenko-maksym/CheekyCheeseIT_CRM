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

/** Collapses incidental whitespace differences (trailing newline, double space) without touching content. */
function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ')
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
