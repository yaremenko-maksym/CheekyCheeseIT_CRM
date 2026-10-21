/**
 * The five bounds of `XmlPort`, and the measurements each one is derived from — r5 Task 2.4a, R-2.
 *
 * WHY EVERY NUMBER HERE CARRIES A MEASUREMENT
 * -------------------------------------------
 * The ADR's first attempt at these bounds was falsified: it claimed 8 MiB "keeps a worst case in
 * the low hundreds of ms" (wrong by an order of magnitude), claimed bytes were "the only lever"
 * (the ELEMENT COUNT is what time and memory actually track), and checked wall clock *after* the
 * parse returned, which bounds nothing. So the rule for this file is: a number without a
 * measurement beside it is a guess, and a guess is what was wrong last time.
 *
 * MEASURE THE WHOLE PORT, NOT THE PARSER — this correction was itself forced by a red test.
 * ---------------------------------------------------------------------------------------
 * The first version of this file derived the throughput constant from `parseXml` alone (worst
 * shape 721 elements/ms) and the ceiling test then FAILED at 1 013 ms against a 250 ms budget.
 * The constant was not slightly optimistic; it was measuring the wrong thing. What stalls the
 * event loop is `parseDocument` end to end — the UTF-8 decode, the structural pre-scan over the
 * whole string, the neutral-tree construction and `measureTree` — and that work is several times
 * the parse itself on attribute-heavy input.
 *
 * MEASURED, end to end through `BoundedXmlPort.parseDocument`, Node 22, inside vitest (so the
 * figures include the environment production will not have, which is the safe direction):
 *
 *   shape              elements     bytes     cold    cold el/ms   warm    warm el/ms
 *   bare `<i/>`          50 000    200 KB     65 ms        774     74 ms        677
 *   feed-like `<item>`   50 000    1.6 MB    162 ms        309    138 ms        361
 *   eight attributes     12 500    650 KB    169 ms         74     80 ms        156
 *   eight attributes     25 000    1.3 MB    322 ms         78    216 ms        116
 *   eight attributes     50 000    2.6 MB    495 ms        101    463 ms        108   <- worst
 *
 *   2 MiB of `<i/>`     524 286    2.0 MiB   116 ms (parse only), RSS 237 MB
 *
 * Three facts the table settles:
 *   1. End-to-end throughput varies ~10× by SHAPE at a fixed element count (74 vs 774), so a
 *      bound expressed in bytes alone cannot bound time. The worst observed is **74 elements/ms**.
 *   2. The byte cap alone does NOT subsume the element bound: 2.6 MB of attribute-heavy input is
 *      near the byte cap yet costs 495 ms, twice the budget. The element ceiling is load-bearing.
 *   3. The byte cap alone admits half a million elements and 237 MB of resident memory for a
 *      synchronous parse inside the API process — the container OOM risk, not a latency nit.
 */

import { MAX_FEED_BYTES } from '../rss'
import type { XmlLimits } from './xml-port'

/**
 * Byte cap, **the same constant the DOU scanner already uses**.
 *
 * Imported rather than re-declared on purpose: the ADR withdrew its own 8 MiB proposal partly
 * because it was 4× `rss.ts`'s cap with no stated reason, and "one number for one job" is only
 * true if there is literally one number. Re-typing `2 * 1024 * 1024` here would let the two code
 * paths drift in silence. The literal value is pinned independently by `xml-limits.spec.ts`, so
 * the import fixes identity and the spec fixes magnitude — a change to either is visible.
 *
 * Real feeds are ~200 KiB, so this is already ~10× headroom.
 */
export const MAX_XML_BYTES = MAX_FEED_BYTES

/**
 * Element-nesting cap. **Ours, deliberately not the V8 stack's.**
 *
 * The stack cliff is not a contract: the ADR measured it at 5 126 frames and a reviewer at 5 419
 * on another machine, 28 422 vs 24 999 under `--stack-size=4000`, **4 686** when called 1 000
 * frames deep (as it is inside Nest), and `--stack-size=20000` segfaults instead of throwing. A
 * bound that moves with an unrelated runtime flag — and that can SIGSEGV rather than raise — is
 * not something to inherit. 100 is ~20× the depth of any real feed (~5) and far below every
 * measured cliff, so the stack limit is unreachable through this port.
 */
export const MAX_XML_DEPTH = 100

/**
 * Structural cap on the element count, bounding MEMORY.
 *
 * Derived from the 2 MiB measurement above: 524 286 elements cost 237 MB RSS, so ~0.45 KB of
 * resident memory per element. 100 000 elements is therefore ~45 MB — survivable in a container
 * alongside the rest of the API. Real feeds carry ~200 items × ~7 elements ≈ 1 500.
 *
 * This is NOT the binding default: the wall-clock budget below converts to a lower ceiling
 * (50 000). Both exist because they bound different resources and fail with different reasons —
 * a caller that raises the time budget still cannot exceed the memory cap.
 */
export const MAX_XML_ELEMENTS = 100_000

/**
 * Wall-clock budget for one parse, in ms.
 *
 * 250 ms: the parse is synchronous inside the API process, so this is time the event loop that
 * also serves the CRM is not available. A quarter-second stall per feed fetch is tolerable on a
 * background cron path; a 3-second one (what 8 MiB measured) is not.
 */
export const MAX_XML_WALL_CLOCK_MS = 250

/**
 * END-TO-END port throughput assumed when converting the time budget into an element ceiling.
 *
 * **50, against a measured worst of 74** (eight attributes per element, cold) — a 1.5× margin for
 * a loaded CI runner or a slower production host. Deliberately pessimistic: being wrong in this
 * direction costs headroom on a bound that still has ~8× over a real feed; being wrong the other
 * way means the time budget silently does not hold, which is what the first edition of this
 * constant did.
 *
 * 50 × 250 ms = 12 500 elements. At the worst measured shape that is 169 ms, inside the budget.
 *
 * Pinned by `xml-limits.spec.ts`, which parses a document of the WORST shape at exactly the
 * derived ceiling and fails if it exceeds the budget by more than 4×. What that proves: the
 * constant is the right order of magnitude, so a ceiling derived from it cannot admit a
 * multi-second parse. What it does NOT prove: the 1.5× safety margin — that needs a tight
 * assertion, and a tight timing assertion on a shared runner is a flake rather than a gate.
 */
export const PARSE_ELEMENTS_PER_MS = 50

export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxBytes: MAX_XML_BYTES,
  maxDepth: MAX_XML_DEPTH,
  maxElements: MAX_XML_ELEMENTS,
  maxWallClockMs: MAX_XML_WALL_CLOCK_MS,
})

/**
 * The element count the pre-scan actually enforces, and which of the two bounds set it.
 *
 * THIS IS HOW THE WALL-CLOCK BOUND IS REAL. A deadline checked around a synchronous `parseXml`
 * call is evaluated only once the parse has returned, so it reports a budget overrun instead of
 * preventing one — the ADR's exact finding. The genuine alternatives are a `worker_threads`
 * parse with `terminate()` on a timer, or making time moot by bounding the work that consumes it.
 *
 * We take the second, because the measurement says parse time tracks the element count (±9× by
 * shape, absorbed by the conservative throughput constant) and because a worker per feed costs a
 * thread, a structured-clone of the tree and a second failure mode, for a 250 ms budget. The
 * budget is therefore SPENT AS ELEMENTS, before the parser is handed anything:
 *
 *     ceiling = min(maxElements, floor(maxWallClockMs × PARSE_ELEMENTS_PER_MS))
 *
 * At the defaults that is `min(100 000, 12 500)` = 12 500, so the time budget binds and
 * `boundBy` is `'time'`. `worker_threads` stays the escape hatch if a hard mid-parse deadline is
 * ever required — as does `sax`, the streaming runner-up, which can check a deadline inside its
 * handlers.
 */
export function elementCeiling(limits: XmlLimits): {
  ceiling: number
  boundBy: 'elements' | 'time'
} {
  const fromTime = Math.floor(limits.maxWallClockMs * PARSE_ELEMENTS_PER_MS)
  return fromTime < limits.maxElements
    ? { ceiling: fromTime, boundBy: 'time' }
    : { ceiling: limits.maxElements, boundBy: 'elements' }
}
