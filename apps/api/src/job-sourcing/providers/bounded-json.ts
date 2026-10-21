/**
 * Bounded JSON parsing for the API provider base (Task 2.3).
 *
 * Byte bounds and egress policy are Task 2.2's, applied at fetch time; what reaches here is text
 * that already passed them. What is bounded HERE is the SHAPE: a response inside the byte budget
 * can still be `[[[[[[...` a million levels deep, and a recursive walk over it crashes the worker
 * rather than failing one subrequest. So the walk is iterative and every bound is checked.
 *
 * The byte bound is re-checked rather than trusted: this module is also the one a phase-3 adapter
 * reaches for when it parses a nested payload out of a field, where nothing checked the bytes.
 */

export interface JsonLimits {
  /** UTF-8 bytes of the document. */
  maxBytes: number
  /** Nesting depth. A scalar is depth 1; `{"a":1}` is depth 2; `{"a":{"b":1}}` is depth 3. */
  maxDepth: number
  /** Total nodes — every scalar, array and object. Bounds a huge FLAT payload, which the depth
   * bound does not see and the byte bound sees only in bytes. */
  maxNodes: number
}

export const DEFAULT_JSON_LIMITS: JsonLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 200_000,
}

export type JsonBoundFailure = 'NOT_JSON' | 'TOO_MANY_BYTES' | 'TOO_DEEP' | 'TOO_MANY_NODES'

export type BoundedJsonResult =
  { ok: true; value: unknown } | { ok: false; reason: JsonBoundFailure; detail: string }

/**
 * Measure a parsed value's depth and node count without recursion.
 *
 * Returns the FIRST bound it breaks rather than the full measurement: a payload that is both too
 * deep and too wide should report one reason, and stopping early is also what keeps the walk
 * bounded in time for a hostile payload.
 */
function measure(
  root: unknown,
  limits: JsonLimits,
): { ok: true; depth: number; nodes: number } | { ok: false; reason: JsonBoundFailure } {
  // Each frame is a value and the depth at which it sits. `depth` of the root is 1.
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }]
  let nodes = 0
  let maxSeenDepth = 0

  while (stack.length > 0) {
    // Non-null asserted by the loop condition; `pop` on a non-empty array returns a value.
    const frame = stack.pop() as { value: unknown; depth: number }
    nodes += 1
    if (nodes > limits.maxNodes) return { ok: false, reason: 'TOO_MANY_NODES' }
    if (frame.depth > limits.maxDepth) return { ok: false, reason: 'TOO_DEEP' }
    if (frame.depth > maxSeenDepth) maxSeenDepth = frame.depth

    const { value } = frame
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: frame.depth + 1 })
    } else if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) stack.push({ value: child, depth: frame.depth + 1 })
    }
  }

  return { ok: true, depth: maxSeenDepth, nodes }
}

/**
 * Parse `text` as JSON, refusing anything past the limits.
 *
 * A refusal is a RETURNED result, never a thrown error: a payload that breaks a bound fails its
 * subrequest as drift, and the attempt keeps the pages it already persisted (AC3, AC4). Throwing
 * would make that the caller's problem to remember.
 */
export function parseBoundedJson(text: string, limits: JsonLimits): BoundedJsonResult {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > limits.maxBytes) {
    return {
      ok: false,
      reason: 'TOO_MANY_BYTES',
      detail: `${bytes} bytes exceeds ${limits.maxBytes}`,
    }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      reason: 'NOT_JSON',
      // The parser's own message, which names the offset but never echoes the body.
      detail: error instanceof Error ? error.message.slice(0, 200) : 'unparseable',
    }
  }

  const measured = measure(value, limits)
  if (!measured.ok) {
    return {
      ok: false,
      reason: measured.reason,
      detail:
        measured.reason === 'TOO_DEEP'
          ? `nesting exceeds ${limits.maxDepth}`
          : `node count exceeds ${limits.maxNodes}`,
    }
  }

  return { ok: true, value }
}
