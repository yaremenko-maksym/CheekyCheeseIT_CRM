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
 * THE UNIT IS AN **ITEM** — AN ELEMENT *OR* AN ATTRIBUTE. This is the second correction forced
 * from outside, and it is the same mistake as the first one in a different place.
 * -----------------------------------------------------------------------------------------
 * The edition below this one spent the time budget as ELEMENTS. An element and an attribute cost
 * within the same factor of each other (the tables below put them inside ~2×), so a budget that
 * counts one and not the other is not a budget: ~150 000 attributes on a SINGLE element is two
 * elements, and it slipped the bound entirely. The budget is now spent as `elements +
 * attributes`, and `prescan.ts` counts both before the parser is handed anything.
 *
 * MEASUREMENT RECORD — two machines, deliberately kept, because one machine cannot tell a stale
 * constant from a valid one and that is exactly what CR-M-3 asked for.
 * -----------------------------------------------------------------------------------------
 * (A) 2026-10-20, author's host, Node 22, end to end through `BoundedXmlPort.parseDocument`
 *     inside vitest. The el/ms column is what the superseded element-only constant was read from.
 *
 *   shape              elements    attrs    bytes    cold   cold el/ms   cold ITEMS/ms
 *   bare `<i/>`          50 000        0   200 KB    65 ms        774            769
 *   feed-like `<item>`   50 000        0   1.6 MB   162 ms        309            309   <- worst
 *   eight attributes     12 500  100 000   650 KB   169 ms         74            666
 *   eight attributes     25 000  200 000   1.3 MB   322 ms         78            699
 *   eight attributes     50 000  400 000   2.6 MB   495 ms        101            909
 *
 *   2 MiB of `<i/>`     524 286        0   2.0 MiB  116 ms (parse only), RSS 237 MB
 *
 * (B) 2026-10-21, Apple M3 (Mac15,12, 8 cores, 16 GB), macOS 27.0.1, Node v20.15.1, same harness.
 *     Taken while closing the review, which is why it exists: the row the review disagreed about.
 *
 *   shape                   elements    attrs    bytes    cold    cold ITEMS/ms
 *   bare `<i/>`               50 001        0   195 KB     51 ms       974
 *   bare `<i/>`              500 001        0  1 953 KB   311 ms      1609
 *   feed-like `<item>`        48 001        0  1 203 KB    61 ms       792   <- worst on (B)
 *   eight attributes          12 501  100 000   635 KB     62 ms      1828
 *   eight attributes          50 001  400 000  2 539 KB   208 ms      2167
 *   ONE element             +    2     150 000  1 649 KB   128 ms      1168
 *   ONE element             +    2     300 000  3 407 KB   330 ms       910
 *
 * Four facts the two tables settle:
 *   1. Expressed in ITEMS the throughput spread collapses from ~10× to ~3× on either machine
 *      (309–909 on A, 792–2167 on B). That is what makes a single item constant honest where a
 *      single element constant was not: the el/ms column spans 74…774 on the SAME machine.
 *   2. **The worst observed is 309 items/ms**, on (A), feed-like. (B) is ~2.6× faster throughout,
 *      so (A) is the host the constant is derived from — the slower of two is the safe direction.
 *   3. The attribute axis genuinely overruns once counted: 300 000 attributes on ONE element cost
 *      330 ms on the FAST machine, over a 250 ms budget, at two elements. Two independent
 *      measurements of the 150 000-attribute case — a reviewer's ~160 ms and (B)'s 128 ms —
 *      agree, and the 495 ms reported for it during review does not reproduce; it is the
 *      400 000-attribute row of table (A) that costs 495 ms. The finding stands either way: the
 *      shape is unbounded in the quantity that was being counted.
 *   4. The byte cap alone admits half a million elements and 237 MB of resident memory for a
 *      synchronous parse inside the API process — the container OOM risk, not a latency nit.
 *
 * WHAT THE BOUNDS DO *NOT* COVER — stated here rather than left to be discovered (SPEC-M-2).
 * -----------------------------------------------------------------------------------------
 * Three of the four limits are enforced before the parser runs, by a count: `maxBytes` on the
 * bytes, `maxDepth` and the item ceiling in the pre-scan. `maxWallClockMs` is **not** enforced as
 * a clock — nothing here interrupts a synchronous parse — it is converted into the item ceiling
 * and holds only for shapes whose cost tracks item count.
 *
 * Shapes whose cost is per-BYTE rather than per-item — runs of processing instructions, `&amp;`
 * entity references, comments, CDATA, plain text — carry one element and are bounded by
 * `maxBytes` alone. That residue is measured rather than asserted away, at exactly the 2 MiB cap,
 * on (B): PI run 75 ms, `&amp;` run 57 ms, comment run 37 ms, CDATA run 26 ms, plain text 5 ms.
 * The worst is ~3× inside the budget on (B) and would be ~8× faster than its own budget on a host
 * 3× slower than (A). `xml-limits.spec.ts` pins these with a loose multiple, so a change that
 * made any of them super-linear is a red test; the ADR's R-2 estimate of "near or over 250 ms at
 * 2 MiB" for the PI and `&amp;` shapes does not reproduce on either machine.
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
 * This is NOT the binding default: the wall-clock budget converts to an ITEM ceiling of 25 000
 * (`itemCeiling`), and an element is an item, so no document can reach 100 000 elements at the
 * default budget. Both bounds exist because they bound different resources and fail with
 * different reasons — a caller that raises the time budget still cannot exceed the memory cap.
 *
 * THE NUMBER IN THIS PARAGRAPH IS LOAD-BEARING AND WAS WRONG (CR-M-1). It read "a lower ceiling
 * (50 000)" while the derivation twenty lines below produced 12 500 — true when written, false
 * after the throughput constant moved, and silent about it. That is the same defect two rounds of
 * the parser ADR were spent on, so: the figure is now pinned by name in `xml-limits.spec.ts`
 * (`itemCeiling(DEFAULT_XML_LIMITS) === 25_000`), and a future edit that moves the constant
 * without touching this sentence turns the sentence red instead of stale.
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
 * END-TO-END port throughput assumed when converting the time budget into an item ceiling, where
 * an **item** is one element or one attribute.
 *
 * **100 items/ms, against a measured worst of 309** — a 3× margin over the slower of two
 * machines, taken because the production host is a shared VPS that neither table measured.
 * Deliberately pessimistic: being wrong in this direction costs headroom on a bound that still
 * leaves ~17× over a real feed (~200 items × ~7 elements ≈ 1 500 items); being wrong the other way
 * means the time budget silently does not hold, which is what both superseded editions of this
 * constant did.
 *
 * 100 × 250 ms = **25 000 items**. At the worst shape of table (A) that is ~81 ms, and it stays
 * inside 250 ms on a host three times slower than (A).
 *
 * THIS RAISES THE ELEMENT CEILING FOR ATTRIBUTE-FREE DOCUMENTS, from 12 500 to 25 000, and that
 * is the honest consequence rather than an incidental loosening. The old 12 500 came from reading
 * the eight-attribute row's ELEMENT count as the unit while ignoring the 100 000 attributes doing
 * the work — conservative by accident, via a mis-specified unit. Counting the real unit makes the
 * bound much tighter where it was blind (an attribute now costs) and drops the accidental part.
 * Both 50 000 bare elements (65 ms) and 50 000 feed-like elements (162 ms) measured inside the
 * budget on the slower machine, so 25 000 is not near any observed cliff.
 *
 * Pinned by `xml-limits.spec.ts` two ways, because the previous edition was pinned only one of
 * them and CR-M-3 is exactly that gap:
 *   - the DERIVED VALUE itself, `itemCeiling(DEFAULT_XML_LIMITS) === 25_000`, so the constant
 *     cannot drift at all without a red test. The old spec asserted only that a worst-shape
 *     document at the ceiling parsed within 4× the budget, which passed at ~169 ms and would have
 *     kept passing up to ~1 000 ms — four times the budget — so the constant had 4× of silent room.
 *   - a worst-shape document AT the ceiling, within that loose multiple, which is the sanity
 *     check that the derivation is about the right quantity. A TIGHT timing assertion is
 *     deliberately not attempted: on a shared runner it is a flake, not a gate. The exact-value
 *     assertion is what replaces it, and it cannot flake.
 */
export const PARSE_ITEMS_PER_MS = 100

export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxBytes: MAX_XML_BYTES,
  maxDepth: MAX_XML_DEPTH,
  maxElements: MAX_XML_ELEMENTS,
  maxWallClockMs: MAX_XML_WALL_CLOCK_MS,
})

/**
 * The item count the pre-scan enforces on the wall-clock budget's behalf.
 *
 * THIS IS HOW THE WALL-CLOCK BOUND IS REAL. A deadline checked around a synchronous `parseXml`
 * call is evaluated only once the parse has returned, so it reports a budget overrun instead of
 * preventing one — the ADR's exact finding. The genuine alternatives are a `worker_threads`
 * parse with `terminate()` on a timer, or making time moot by bounding the work that consumes it.
 *
 * We take the second, because the measurement says parse time tracks the item count (±3× by
 * shape, absorbed by the conservative throughput constant) and because a worker per feed costs a
 * thread, a structured-clone of the tree and a second failure mode, for a 250 ms budget. The
 * budget is therefore SPENT AS ITEMS, before the parser is handed anything:
 *
 *     maxItems = floor(maxWallClockMs × PARSE_ITEMS_PER_MS)      // 25 000 at the defaults
 *
 * `worker_threads` stays the escape hatch if a hard mid-parse deadline is ever required — as does
 * `sax`, the streaming runner-up, which can check a deadline inside its handlers.
 *
 * NO `min` AND NO `boundBy`, which the previous edition had and which are gone rather than
 * suppressed. They existed to pick between two caps on ONE quantity; the two caps are now on
 * DIFFERENT quantities — `maxElements` bounds memory in elements, this bounds time in items — so
 * the pre-scan checks both and reports which one it hit (`exceeded: 'elements' | 'items'`). The
 * reason code is then read off that, instead of being inferred from which cap was smaller. Three
 * mutants lived on the comparison and the two-field return; deleting the construct deletes them.
 */
export function itemCeiling(limits: XmlLimits): number {
  return Math.floor(limits.maxWallClockMs * PARSE_ITEMS_PER_MS)
}
