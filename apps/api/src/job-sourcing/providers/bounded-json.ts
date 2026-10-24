/**
 * Bounded JSON parsing for the API provider base (Task 2.3).
 *
 * The ORDER of the three bounds is the design, not an implementation detail. Each one must fire
 * before the cost it exists to prevent:
 *
 *  1. BYTES, before `JSON.parse`. Bounds allocation.
 *  2. DEPTH, also before `JSON.parse`, by a single pass over the raw text. This is the bound a
 *     post-parse walk gets wrong: a document inside the byte budget but nested four million levels
 *     deep is parsed IN FULL first (measured on Node 22 at 8 MiB: 819 ms, +264 MB RSS) and only
 *     then refused for exceeding a `maxDepth` of 64. The semantics were right and the protection
 *     was absent — `maxDepth: 64` advertised a guarantee two orders of magnitude cheaper than what
 *     actually happened, and V8 parses iteratively, so there is no stack overflow to rely on
 *     either. A pre-scan refuses it for the cost of one pass.
 *     The already-merged XML decision record requires the same of its own wrapper in the same
 *     words ("the bounds the wrapper must enforce BEFORE the parser sees the bytes, and why each
 *     cannot be left to the library"); the JSON path does not get to be the weaker of the two.
 *  3. NODES, twice. An UPPER BOUND from the same pre-parse pass (string-aware separator count,
 *     see `scanShape`) refuses a flat hostile body before the parser allocates its tree — at a
 *     10 MiB per-source cap that parse is hundreds of ms and ~300 MB (backlog 318). The exact
 *     count after parsing stays: the estimate over-counts empty containers, so it can refuse but
 *     never admit, and the walk also serves values an adapter hands in without a pre-scan.
 *
 * Fetch-time byte bounds and egress policy are Task 2.2's; what is bounded HERE is the SHAPE. The
 * byte bound is re-checked rather than trusted, because this module is also what a phase-3 adapter
 * reaches for to parse a nested payload out of a field, where nothing checked the bytes.
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

/**
 * 2 MiB, ALIGNED with `MAX_FEED_BYTES` in `rss.ts` and with R-2 of
 * `docs/architecture/2026-10-20-xml-parser-dependency-review.md`, which withdrew 8 MiB after
 * measuring it (~1.2 GB RSS, judged a container OOM risk rather than a latency nit).
 *
 * A JSON envelope gets no larger allowance than an XML one: the two carry the same job's payloads,
 * 2 MiB is already an order of magnitude over the largest page any phase-3 provider returns, and a
 * figure that differs from its neighbour with no measurement behind it is exactly what R-2
 * refused. Raising it is a measurement, not an edit.
 */
export const MAX_JSON_BYTES = 2 * 1024 * 1024

export const DEFAULT_JSON_LIMITS: JsonLimits = {
  maxBytes: MAX_JSON_BYTES,
  maxDepth: 64,
  maxNodes: 200_000,
}

export type JsonBoundFailure = 'NOT_JSON' | 'TOO_MANY_BYTES' | 'TOO_DEEP' | 'TOO_MANY_NODES'

export type BoundedJsonResult =
  { ok: true; value: unknown } | { ok: false; reason: JsonBoundFailure; detail: string }

/**
 * The nesting depth of a JSON document, read off the RAW TEXT and abandoned as soon as it passes
 * `maxDepth`.
 *
 * Brackets inside string literals are not structure, so the scan tracks the string state and the
 * escape state: `{"a":"]]]"}` is depth 2, and a scanner blind to that would UNDER-count — the
 * direction that lets a hostile payload through.
 *
 * Returns `null` when the limit is exceeded, otherwise the depth. Unbalanced brackets are not this
 * function's problem: `JSON.parse` is the authority on well-formedness, and this scan only has to
 * refuse what is too deep before the parser is reached.
 */
export function scanDepthWithin(text: string, maxDepth: number): number | null {
  const shape = scanShape(text, maxDepth, Number.POSITIVE_INFINITY)
  return shape.breach === 'depth' ? null : shape.depth
}

export interface ShapeScan {
  /** The first bound the scan crossed, in text order, or `null` when it crossed none. */
  breach: 'depth' | 'nodes' | null
  depth: number
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d

/**
 * One pass over the raw text enforcing BOTH pre-parse bounds: nesting depth and an upper bound of
 * the node count. The scan stops at the FIRST breach in text order, so a flat hostile body is
 * refused after the few hundred KB that hold `maxNodes` separators rather than after all 10 MiB
 * (measured, Node 22: ~45 ms for the full pass, so the early exit is what makes the refusal cheap).
 * The estimate only grows, so stopping early is sound. A body that breaks both bounds is named by
 * whichever it breaches first in the text; before this scan it was always `TOO_DEEP`.
 *
 * The node estimate is `1 + structural commas + container openings`, where a structural comma is
 * one OUTSIDE a string literal. The post-parse count (`countNodesWithin`) is the container plus
 * every value in it, object KEYS not counted: a non-empty container with k commas holds k + 1
 * values, so the true count is `1 + commas + non-empty containers`. Counting every opening, empty
 * or not, can only add: it OVER-counts by one per empty container (`[]`, `{}`) and is never below
 * the truth for well-formed JSON. Over-counting is the safe direction for a refusal that only has
 * to stop a hostile flat body, and the margin is tiny for honest bodies.
 *
 * The string state is what keeps the estimate honest. Job descriptions are prose full of commas;
 * counting those would refuse a 4 MiB page that has a few dozen real nodes. So commas and
 * brackets inside strings, escaped quotes and escaped backslashes included, are not structure.
 *
 * Indexed `charCodeAt` rather than `for...of`: the scan runs over up to 10 MiB, and structural
 * characters are all ASCII, which a UTF-16 code unit identifies exactly (a surrogate half is never
 * one of them).
 */
export function scanShape(text: string, maxDepth: number, maxNodes: number): ShapeScan {
  let nesting = 0
  let maxNesting = 0
  // The root, then +1 per structural comma and +1 per container opening.
  let nodeUpperBound = 1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (code === BACKSLASH) {
        escaped = true
      } else if (code === QUOTE) {
        inString = false
      }
      continue
    }
    if (code === QUOTE) {
      inString = true
    } else if (code === COMMA) {
      nodeUpperBound += 1
      if (nodeUpperBound > maxNodes) return { breach: 'nodes', depth: maxNesting + 1 }
    } else if (code === OPEN_BRACKET || code === OPEN_BRACE) {
      nesting += 1
      nodeUpperBound += 1
      maxNesting = Math.max(maxNesting, nesting)
      // A value nested under N open brackets sits at depth N + 1; a bare scalar is depth 1.
      if (maxNesting + 1 > maxDepth) return { breach: 'depth', depth: maxNesting + 1 }
      if (nodeUpperBound > maxNodes) return { breach: 'nodes', depth: maxNesting + 1 }
    } else if (code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      nesting -= 1
    }
  }

  // A scalar root has no separator or opening to trip the in-loop check, so test the final figure.
  return { breach: nodeUpperBound > maxNodes ? 'nodes' : null, depth: maxNesting + 1 }
}

/**
 * Count every node without recursion, stopping at the first breach.
 *
 * Iterative because this walk also runs over values an adapter hands in directly, where no
 * pre-scan ran — and a recursive walk over a deep value crashes the worker instead of failing one
 * subrequest.
 */
function countNodesWithin(root: unknown, maxNodes: number): number | null {
  const stack: unknown[] = [root]
  let nodes = 0

  while (stack.length > 0) {
    const value = stack.pop()
    nodes += 1
    if (nodes > maxNodes) return null

    // Arrays need no branch of their own: `Object.values` on an array yields its elements, and an
    // array is `typeof 'object'`. One path instead of two, and no unobservable branch to defend.
    if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) stack.push(child)
    }
  }

  return nodes
}

/**
 * Parse `text` as JSON, refusing anything past the limits.
 *
 * A refusal is a RETURNED result, never a thrown error: a payload that breaks a bound fails its
 * subrequest as drift, and the attempt keeps the pages it already persisted (AC3, AC4). Throwing
 * would make that the caller's problem to remember.
 */
export function parseBoundedJson(text: string, limits: JsonLimits): BoundedJsonResult {
  // No explicit encoding: utf8 is the default, and naming it adds a parameter whose only possible
  // other values Node silently falls back to utf8 for anyway (measured) — an argument that cannot
  // be wrong is an argument that cannot be tested.
  const bytes = Buffer.byteLength(text)
  if (bytes > limits.maxBytes) {
    return {
      ok: false,
      reason: 'TOO_MANY_BYTES',
      detail: `${bytes} bytes exceeds ${limits.maxBytes}`,
    }
  }

  const shape = scanShape(text, limits.maxDepth, limits.maxNodes)
  if (shape.breach === 'depth') {
    return { ok: false, reason: 'TOO_DEEP', detail: `nesting exceeds ${limits.maxDepth}` }
  }
  // Refused BEFORE `JSON.parse`: a flat body inside the byte cap and the depth limit would
  // otherwise be parsed in full (backlog 318). The post-parse count below stays as the exact check.
  if (shape.breach === 'nodes') {
    return {
      ok: false,
      reason: 'TOO_MANY_NODES',
      detail: `node count exceeds ${limits.maxNodes}`,
    }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      reason: 'NOT_JSON',
      // The parser's own message, which names the offset and a short snippet but never the whole
      // body. V8 bounds the message itself — measured at 60 characters for a 5 KB malformed
      // document, because it truncates its own snippet. No input available today makes the slice
      // fire, so no test can kill the mutant that removes it; it stays as defence against a
      // future parser that echoes more, and this note is why it has no test rather than a
      // pretend one.
      // Stryker disable next-line MethodExpression: unobservable for the reason above (measured).
      detail: error instanceof Error ? error.message.slice(0, 200) : 'unparseable',
    }
  }

  if (countNodesWithin(value, limits.maxNodes) === null) {
    return {
      ok: false,
      reason: 'TOO_MANY_NODES',
      detail: `node count exceeds ${limits.maxNodes}`,
    }
  }

  return { ok: true, value }
}
