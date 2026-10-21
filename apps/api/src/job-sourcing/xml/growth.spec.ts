/**
 * R-5: ReDoS and super-linear growth, measured against THIS wrapper, not the ADR's probe.
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

/** Best-of-N: the minimum is the least noisy estimator of cost on a machine with other tenants. */
function bestMs(run: () => void, attempts = 3): number {
  let best = Infinity
  for (let i = 0; i < attempts; i += 1) {
    const started = process.hrtime.bigint()
    run()
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    if (elapsed < best) best = elapsed
  }
  return best
}

/**
 * The smallest large-size timing from which an exponent means anything.
 *
 * Below this, the measurement is dominated by fixed cost — allocating the input string, setting up
 * the decoder — and the ratio describes that overhead rather than the shape's growth. The first
 * version of this suite instead clamped tiny timings to a floor and asserted the exponent stayed
 * ABOVE 0.5, which made the cheapest shape ('long adjacent text runs') fail at 0.23 for a reason
 * that was not a defect: fixed overhead legitimately dominates a cheap shape.
 */
const MEASURABLE_MS = 1

/**
 * Fit an exponent across a size range: `t ∝ n^k`, so `k = log(t2/t1) / log(n2/n1)`.
 *
 * Linear is 1, quadratic is 2, catastrophic backtracking does not finish.
 *
 * Refuses to fit an unmeasurable pair rather than returning a number computed from noise. That is
 * the difference between a gate and a decoration: a silently-clamped fit always produces a value
 * below the threshold, so the assertion would pass for every shape including a quadratic one that
 * happened to be fast at these sizes.
 */
function growthExponent(
  build: (n: number) => string,
  run: (xml: string) => void,
  // Sizes are a parameter because the right range depends on the shape's cost: the well-formed
  // shapes are measurable at 8 000 units, while a rejection refused on the construct itself needs
  // 8x that before it clears the floor at all.
  { small, large }: { small: number; large: number } = { small: 8_000, large: 32_000 },
): number {
  const t1 = bestMs(() => run(build(small)))
  const t2 = bestMs(() => run(build(large)))
  if (t2 < MEASURABLE_MS) {
    throw new Error(
      `shape is too cheap to fit an exponent: ${t2.toFixed(3)} ms at n=${large}. ` +
        `Raise the size rather than relaxing the threshold — a fit below ${MEASURABLE_MS} ms ` +
        `measures fixed overhead, not growth.`,
    )
  }
  return Math.log(t2 / Math.max(t1, 1e-3)) / Math.log(large / small)
}

const WELL_FORMED = GROWTH_SHAPES.filter((shape) => shape.wellFormed)
/** Refused on the construct itself, at near-constant cost. */
const FLAT_REJECT = GROWTH_SHAPES.filter((shape) => shape.rejection === 'flat')
/** Parses normally and fails late, so the rejection costs a parse. */
const LATE_REJECT = GROWTH_SHAPES.filter((shape) => shape.rejection === 'after-parsing')

/** 1 MB of input: `n` units x ~4 characters each. */
const ONE_MEGABYTE_UNITS = 262_144

describe('R-5: growth is at worst mildly super-linear, through the whole port', () => {
  it.each(WELL_FORMED)('$name grows no worse than quadratically', ({ build }) => {
    const exponent = growthExponent(build, (xml) => {
      port.parseDocument(utf8(xml), UNBOUNDED)
    })
    expect(exponent).toBeLessThan(2.0)
  })

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
   * Only two of the four unterminated shapes are measurable, and the other two are excluded for a
   * reason that is the DESIRED direction rather than a gap: the unterminated comment and CDATA are
   * refused in ~0.30 ms at 1 MB. No fit over that is meaningful — the ratio would describe string
   * allocation — and no absolute ceiling over it would discriminate. Inventing an assertion for
   * them would be decoration, so there is none, and this comment is the record of that decision.
   */
  const MEASURABLE_REJECTS = [
    // The ReDoS archetype and the worst of the group: 0.43 ms at 32 KB, 1.6 ms at 128 KB, 21 ms
    // at 512 KB, 40 ms at 1 MB — exponent ~1.3, the same class the ADR measured at worst 1.36
    // and attributed to allocation and GC rather than backtracking. Bounded at roughly 80 ms by
    // the 2 MiB byte cap, which is a second reason that cap is load-bearing.
    'unterminated processing instruction',
    'unterminated attribute value',
  ]

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

  it.each(MEASURABLE_REJECTS)('%s rejects sub-quadratically', (name) => {
    const shape = FLAT_REJECT.find((candidate) => candidate.name === name)
    expect(shape, `${name} must stay in the corpus under this name`).toBeDefined()
    const exponent = growthExponent(
      shape?.build as (n: number) => string,
      (xml) => {
        try {
          port.parseDocument(utf8(xml), UNBOUNDED)
        } catch {
          /* the refusal is the point; its COST is what is measured */
        }
      },
      { small: 65_536, large: ONE_MEGABYTE_UNITS },
    )
    expect(exponent).toBeLessThan(2.0)
  })

  it.each(LATE_REJECT)(
    '$name fails late, so its cost is a parse and grows with it',
    ({ build }) => {
      // 262 144 elements then a mismatched close tag costs 186 ms — linear-in-elements work, not a
      // pathology, and the first version of this suite wrongly held it to the flat-rejection
      // ceiling. What matters is that the growth is not quadratic.
      const exponent = growthExponent(build, (xml) => {
        try {
          port.parseDocument(utf8(xml), UNBOUNDED)
        } catch {
          /* measured */
        }
      })
      expect(exponent).toBeLessThan(2.0)
    },
  )

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

  it('a thousand attributes on ONE element costs about what a thousand spread out does', () => {
    // The non-duplicate version of the same advisory shape: many attributes on a single element,
    // where a naive implementation does a linear scan of the existing attributes per insertion
    // and so is quadratic in the count.
    //
    // A RATIO against the same total attribute count spread one-per-element, not an absolute
    // ceiling — a single element cannot be doubled in size without changing the shape, so the
    // comparison has to be against a different arrangement of the same work. Quadratic insertion
    // would make the concentrated case ~1 000x the spread one; the threshold is 25x, which is
    // enormous slack for allocation differences and still three orders of magnitude clear of the
    // failure. Load cancels because both halves run here, together.
    const count = 1_000
    const concentrated = `<r><i ${Array.from({ length: count }, (_, i) => `a${i}="${i}"`).join(' ')}/></r>`
    const spread = `<r>${Array.from({ length: count }, (_, i) => `<i a${i}="${i}"/>`).join('')}</r>`

    const tConcentrated = bestMs(() => {
      port.parseDocument(utf8(concentrated), UNBOUNDED)
    })
    const tSpread = bestMs(() => {
      port.parseDocument(utf8(spread), UNBOUNDED)
    })

    // POSITIVE CONTROL inline: both documents really parse, and to the shapes intended — so the
    // ratio is of two parses rather than of two early exits.
    expect(port.parseDocument(utf8(concentrated), UNBOUNDED).elementCount).toBe(2)
    expect(port.parseDocument(utf8(spread), UNBOUNDED).elementCount).toBe(count + 1)

    expect(tConcentrated).toBeLessThan(Math.max(tSpread, 0.05) * 25)
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
