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
 * HOW A GROWTH ASSERTION AVOIDS BEING A FLAKE
 * -------------------------------------------
 * Absolute timings on a shared CI runner are noise. The exponent is not: doubling the input and
 * comparing is a RATIO, so a uniformly slower machine cancels out. The threshold is 2.0 against a
 * measured worst of ~1.4, which is wide — deliberately, because the failure being guarded against
 * is quadratic (exponent 2) or catastrophic (unbounded), not a 20% regression. A tighter threshold
 * would catch nothing extra and go red on a loaded runner.
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
function growthExponent(build: (n: number) => string, run: (xml: string) => void): number {
  const small = 8_000
  const large = 32_000
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

  it.each(FLAT_REJECT)('$name is refused in bounded time at 1 MB', ({ build }) => {
    // NOT an exponent fit, and the reason is measurement rather than preference: three of these
    // four are refused in ~0.07 ms at 128 KB, so the fit correctly refused to run — at that scale
    // the ratio describes string allocation, not parsing. The right instrument for a near-flat
    // cost is an absolute ceiling at a size where backtracking could not hide.
    //
    // 150 ms against a measured worst of 40 ms (the unterminated PI; the other three are under
    // 0.5 ms at this size). A parser that backtracked over 1 MB would be in the seconds, three
    // orders of magnitude away, so the margin costs nothing in discriminating power while
    // surviving a loaded runner.
    const elapsed = bestMs(() => {
      try {
        port.parseDocument(utf8(build(ONE_MEGABYTE_UNITS)), UNBOUNDED)
      } catch {
        /* the refusal is the point; its COST is what is measured */
      }
    })
    expect(elapsed).toBeLessThan(150)
  })

  it('the unterminated PI is the worst of them, and is still only mildly super-linear', () => {
    // Called out by name because it is the one shape where the cost is NOT flat: 0.43 ms at
    // 32 KB, 1.6 ms at 128 KB, 21 ms at 512 KB, 40 ms at 1 MB. That is an exponent near 1.3 —
    // the same class the ADR measured at worst 1.36 and attributed to node allocation and GC,
    // not backtracking. It is bounded at roughly 80 ms by the 2 MiB byte cap, which is a second
    // reason that cap is load-bearing rather than belt-and-braces.
    const shape = FLAT_REJECT.find((s) => s.name === 'unterminated processing instruction')
    expect(shape, 'the PI shape must stay in the corpus under this name').toBeDefined()
    const exponent = growthExponent(shape?.build as (n: number) => string, (xml) => {
      try {
        port.parseDocument(utf8(xml), UNBOUNDED)
      } catch {
        /* measured */
      }
    })
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

  it('a thousand distinct attributes on ONE element stays fast', () => {
    // The non-duplicate version of the same advisory shape: many attributes on a single element,
    // where a naive implementation does a linear scan per insertion.
    const attributes = Array.from({ length: 1_000 }, (_, i) => `a${i}="${i}"`).join(' ')
    const elapsed = bestMs(() => {
      port.parseDocument(utf8(`<r><i ${attributes}/></r>`), UNBOUNDED)
    })
    // Absolute, and generous, because the alternative here is not a ratio: a single element
    // cannot be doubled in size without changing the shape. 1 000 attributes is ~10 KB.
    expect(elapsed).toBeLessThan(250)
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
