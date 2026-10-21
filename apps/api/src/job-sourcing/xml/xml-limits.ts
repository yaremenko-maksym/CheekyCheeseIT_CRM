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
 * MEASURED HERE, against `@rgrove/parse-xml@5.0.0`, Node 22, warm, best-of-5, on the dev machine:
 *
 *   shape                     elements    bytes      best      elements/ms
 *   bare `<i/>`                100 001    400 KB    14.8 ms         6 756
 *   `<i a="1"/>`               100 001    1.0 MB    28.6 ms         3 499
 *   feed-like `<item>` group    99 998    3.3 MB    58.5 ms         1 708
 *   nesting depth 100          100 001    700 KB    40.2 ms         2 486
 *   text-heavy                 100 001    3.7 MB    50.0 ms         2 000
 *   eight attributes each      100 001    5.2 MB   138.7 ms           721   <- worst
 *
 *   2 MiB of `<i/>`            524 286    2.0 MiB  116 ms, RSS 237 MB  (what the byte cap alone allows)
 *
 * Two facts the table settles:
 *   1. Throughput varies ~9× by SHAPE at a fixed element count, so a bound expressed in bytes
 *      alone cannot bound time. The worst observed is 721 elements/ms.
 *   2. The byte cap alone still admits half a million elements and 237 MB of resident memory for
 *      a synchronous parse inside the API process — which is the event-loop stall and the
 *      container OOM risk, not a latency nit. Hence a separate element bound.
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
 * Parse throughput assumed when converting the time budget into an element ceiling.
 *
 * **200, against a measured worst of 721** (the eight-attribute shape above) — a 3.6× margin for
 * a loaded CI runner or a slower production host. Deliberately pessimistic: being wrong in this
 * direction costs headroom on a bound that already has 30×; being wrong the other way means the
 * time budget silently does not hold.
 *
 * Pinned by `xml-limits.spec.ts`, which parses a document at exactly the derived ceiling and
 * fails if the real parse exceeds the budget by more than 4× — so the constant cannot rot by an
 * order of magnitude without a red test. What that check does NOT prove is the 3.6× margin
 * itself; it proves the constant is the right order of magnitude.
 */
export const PARSE_ELEMENTS_PER_MS = 200

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
 * At the defaults that is `min(100 000, 50 000)` = 50 000, so the time budget binds and
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
