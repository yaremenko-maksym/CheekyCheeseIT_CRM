/**
 * R-5: ReDoS and super-linear growth, measured against THIS wrapper, not the ADR's probe.
 *
 * SPLIT 2026-10-23: the stopwatch assertions (growth exponents, the 25x attribute ratio) moved to
 * `growth.timing.spec.ts`, a dedicated CI job. What remains here is deterministic (refusal
 * outcomes, positive controls, stack depth) and gates every push. The prose below describes the
 * ORIGINAL design and still explains the thresholds, which did not change.
 *
 * WHY THIS CLASS AND NOT ANOTHER
 * ------------------------------
 * It **dominates the real advisory record for XML parsers**. `@xmldom/xmldom`'s 2026 batch is
 * quadratic parsing, quadratic memory, quadratic attribute deduplication and a processing-
 * instruction ReDoS — and not one of those is an entity or XXE issue. The ADR's original corpus
 * never ran this class at all; it was added late, as a probe of the parser alone, over ten shapes.
 *
 * WHAT IS DIFFERENT HERE. The ADR measured `parseXml`. This measures `BoundedXmlPort.parseDocument`
 * — the parse PLUS the decode, the structural pre-scan and the tree walk. That matters because
 * the pre-scan is OUR code over attacker-controlled input, so any quadratic behaviour we
 * introduced would be invisible to a measurement of the library. The wall-clock constant was
 * already wrong by ~4x for exactly this reason (see `xml-limits.ts`), which is the strongest
 * available argument for measuring the whole port.
 *
 * EVERY ASSERTION HERE IS A RATIO, AND THAT WAS FORCED BY MEASUREMENT
 * ------------------------------------------------------------------
 * The first version used absolute millisecond ceilings. Under the mutation gate — which runs this
 * suite in four concurrent test runners, repeatedly — the unterminated-attribute shape took
 * **368 ms against a solo measurement of 2.35 ms**, a ~150x load factor, and stopped the gate
 * before a single mutant was applied. An absolute ceiling wide enough to survive that is too wide
 * to discriminate, so there are none left in this file.
 *
 * A ratio cancels machine speed and load: both measurements are taken in the same process, close
 * together, so a uniformly slower runner affects numerator and denominator alike. The exponent
 * threshold is 2.0 against a measured worst of ~1.3 — wide deliberately, because what is being
 * guarded against is quadratic (exponent 2) or catastrophic (unbounded), not a 20% regression.
 *
 * What a passing run would look like if the thing it checks were absent: a parser with
 * catastrophic backtracking on any of these shapes produces an exponent well above 2 — in
 * practice it does not finish at all, and the suite times out rather than passing quietly.
 */

import { describe, expect, it } from 'vitest'
import { GROWTH_SHAPES, utf8 } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { DEFAULT_XML_LIMITS } from './xml-limits'
import { XmlPortError } from './xml-port'

const port = new BoundedXmlPort()

/** Bounds lifted so a shape's own size, not a refusal, is what is being measured. */
const UNBOUNDED = {
  ...DEFAULT_XML_LIMITS,
  maxBytes: 64 * 1024 * 1024,
  maxElements: 10_000_000,
  maxWallClockMs: 10_000_000,
  maxDepth: 10_000,
}

const WELL_FORMED = GROWTH_SHAPES.filter((shape) => shape.wellFormed)
/** Refused on the construct itself, at near-constant cost. */
const FLAT_REJECT = GROWTH_SHAPES.filter((shape) => shape.rejection === 'flat')
/** Parses normally and fails late, so the rejection costs a parse. */
const LATE_REJECT = GROWTH_SHAPES.filter((shape) => shape.rejection === 'after-parsing')

/** 1 MB of input: `n` units x ~4 characters each. */
const ONE_MEGABYTE_UNITS = 262_144

describe('R-5: growth is at worst mildly super-linear, through the whole port', () => {
  // The exponent assertions for these shapes: `growth.timing.spec.ts`.
  it('POSITIVE CONTROL: the well-formed shapes really do parse at both sizes', () => {
    // The guard the (wrong) lower bound was reaching for: "the exponent is below 2" would also
    // hold if the port were refusing these documents and we were timing the refusal. This asserts
    // a real tree comes back at both measured sizes, which is the only thing that rules that out.
    for (const shape of WELL_FORMED) {
      for (const n of [8_000, 32_000]) {
        const document = port.parseDocument(utf8(shape.build(n)), UNBOUNDED)
        expect(document.elementCount, `${shape.name} @ ${n}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('R-5: unterminated constructs are rejected without scanning to the end', () => {
  // The shape behind xmldom's PI ReDoS advisory. A parser that scans to end-of-input looking for a
  // terminator is the one that is quadratic; one that gives up at the first impossibility is not.
  it.each([...FLAT_REJECT, ...LATE_REJECT])('$name is refused as MALFORMED', ({ build }) => {
    let raised: unknown
    try {
      port.parseDocument(utf8(build(4_000)), UNBOUNDED)
    } catch (error) {
      raised = error
    }
    expect(raised).toBeInstanceOf(XmlPortError)
    expect((raised as XmlPortError).reason).toBe('MALFORMED')
  })

  it.each(FLAT_REJECT)(
    '$name is STILL refused at 1 MB — no size-dependent behaviour',
    ({ build }) => {
      // Deterministic, no timing: the thing that would actually be alarming is a construct that is
      // refused when small and accepted when large. Asserting the OUTCOME at 1 MB catches that, and
      // unlike a stopwatch it cannot be flaked by a loaded runner.
      let raised: unknown
      try {
        port.parseDocument(utf8(build(ONE_MEGABYTE_UNITS)), UNBOUNDED)
      } catch (error) {
        raised = error
      }
      expect((raised as XmlPortError | undefined)?.reason).toBe('MALFORMED')
    },
  )

  /**
   * The growth EXPONENTS of these shapes are timing assertions and live in `growth.timing.spec.ts`
   * (a dedicated CI job, alone on its runner); this file keeps the deterministic half, which gates
   * every push. Only two of the four unterminated shapes are measurable, and the other two are excluded for a
   * reason that is the DESIRED direction rather than a gap: the unterminated comment and CDATA are
   * refused in ~0.30 ms at 1 MB. No fit over that is meaningful — the ratio would describe string
   * allocation — and no absolute ceiling over it would discriminate. Inventing an assertion for
   * them would be decoration, so there is none, and this comment is the record of that decision.
   */
  it('the measurable rejection shapes are the two expected ones', () => {
    // Named, so that a shape becoming newly expensive (or newly free) changes this list and says
    // so, instead of silently dropping out of the fit below.
    expect(FLAT_REJECT.map((shape) => shape.name)).toEqual([
      'unterminated processing instruction',
      'unterminated comment',
      'unterminated cdata',
      'unterminated attribute value',
    ])
  })

  it('POSITIVE CONTROL: the 1 MB inputs are genuinely refused, not short-circuited', () => {
    // Without this, "rejection is fast" would also hold for a port that returned early for an
    // unrelated reason — the byte cap, say, which `UNBOUNDED` lifts precisely so that it cannot
    // be what is being measured.
    for (const shape of FLAT_REJECT) {
      let raised: unknown
      try {
        port.parseDocument(utf8(shape.build(ONE_MEGABYTE_UNITS)), UNBOUNDED)
      } catch (error) {
        raised = error
      }
      expect((raised as XmlPortError | undefined)?.reason, shape.name).toBe('MALFORMED')
    }
  })
})

describe('R-5: the shapes from the advisory record that are not growth-shaped', () => {
  it('an attribute name repeated on one element is rejected, not deduplicated quadratically', () => {
    // xmldom carried a quadratic ATTRIBUTE DEDUPLICATION advisory. The cheap answer is to refuse
    // a duplicate rather than reconcile it, and XML well-formedness already requires that — so
    // this asserts the parser takes the cheap answer instead of doing the expensive thing.
    let raised: unknown
    try {
      port.parseDocument(utf8('<r><i a="1" a="2"/></r>'), UNBOUNDED)
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError).reason).toBe('MALFORMED')
  })

  it('deep-but-bounded nesting does not blow the stack through the tree walk', () => {
    // Our own walks (the adapter's tree build, `measureTree`, `collectText`) are iterative for
    // this reason. At the port's real depth bound this is routine; the assertion is that it is
    // routine rather than a RangeError.
    const depth = DEFAULT_XML_LIMITS.maxDepth
    const document = port.parseDocument(
      utf8(`${'<a>'.repeat(depth)}x${'</a>'.repeat(depth)}`),
      DEFAULT_XML_LIMITS,
    )
    expect(document.depth).toBe(depth)
  })
})
