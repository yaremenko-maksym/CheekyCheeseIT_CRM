/**
 * R-5 (timing half): growth exponents of the XML port, measured with a stopwatch.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * These assertions compare wall-clock times (an exponent fitted to two timings, and a ratio of two
 * timings). A ratio cancels machine SPEED but not machine CONTENTION: the two halves are not
 * measured at the same instant, so a burst of load between them moves the numerator and not the
 * denominator. Measured 2026-10-23: `unterminated processing instruction` fitted 2.229 / 2.203 /
 * 2.20 on three runs in a row at load average ~100, with none of the code under test changed, and
 * 25 of 25 solo runs passed. Run inside the shared unit suite, a spec like that blocks pushes for
 * reasons that have nothing to do with the diff, and teaches people to re-run red until green.
 *
 * So the stopwatch moved, and the guarantee did not. This file keeps EVERY threshold it had
 * (25x for the attribute ratio) except the exponent ceiling, which was RE-DERIVED (see below). It is excluded from
 * the default `vitest run` (see `TIMING_SPECS` in `apps/api/vitest.config.mts`) and runs in the
 * dedicated `Timing specs` CI job, alone on its runner, where a single miss is a signal.
 *
 *   TIMING_SPECS=1 pnpm --filter @crm/api exec vitest run
 *
 * The non-timing half of the same guarantee - every unterminated construct is REFUSED, at 4 KB and
 * at 1 MB, and the well-formed shapes really do parse - stays in `growth.spec.ts` and gates every
 * push.
 */

import { describe, expect, it } from 'vitest'
import { GROWTH_SHAPES, utf8 } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { DEFAULT_XML_LIMITS } from './xml-limits'

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
 * Ceiling for a fitted exponent, DERIVED from measurement (2026-10-24, Node v22.23.1, load 25-32).
 *
 * The old ceiling was 2.0 over a 4x size range. That could not discriminate: a pure quadratic fits
 * at most 2.0 and any linear component pulls the fit BELOW it, so the assertion failed only on
 * noise (correct code read 2.2 under load) and would have missed a mild quadratic. The fit now
 * spans a 64x range, where noise averages out and a quadratic term dominates:
 *
 *   correct code, 64x range, 6 runs per shape: 0.72 - 1.72 across all 12 shapes
 *                                              (worst: unterminated PI 1.72, cdata-dense 1.58,
 *                                              sibling elements 1.55; PI min 1.38)
 *   correct code, old 4x range:                0.28 - 2.78 (PI 2.78, cdata-dense 2.30)
 *   PI scan made quadratic (search every 8 chars, 3 runs): 4x: 1.33-2.27, 16x: 2.13-2.48,
 *                                              64x: 1.93-2.06
 *
 * 1.8 sits 0.08 above the worst correct reading and 0.13 below the best mutant reading at 64x.
 * A quadratic with a larger linear share (e.g. a search every 64 chars) still fits under it; this
 * detects a clearly quadratic scan, which is the advisory class, not every super-linear drift.
 */
const EXPONENT_CEILING = 1.8

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
  { small, large }: { small: number; large: number } = { small: 500, large: 32_000 },
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

describe('R-5: growth exponents (timing)', () => {
  // Well-formed shapes grow no worse than quadratically.
  it.each(WELL_FORMED)('$name grows no worse than quadratically', ({ build }) => {
    const exponent = growthExponent(build, (xml) => {
      port.parseDocument(utf8(xml), UNBOUNDED)
    })
    expect(exponent).toBeLessThan(EXPONENT_CEILING)
  })

  // The two unterminated shapes whose refusal cost is measurable (the others are refused in
  // ~0.3 ms at 1 MB, where no fit means anything).
  const MEASURABLE_REJECTS = [
    // The ReDoS archetype and the worst of the group: 0.43 ms at 32 KB, 1.6 ms at 128 KB, 21 ms
    // at 512 KB, 40 ms at 1 MB — exponent ~1.3, the same class the ADR measured at worst 1.36
    // and attributed to allocation and GC rather than backtracking. Bounded at roughly 80 ms by
    // the 2 MiB byte cap, which is a second reason that cap is load-bearing.
    'unterminated processing instruction',
    'unterminated attribute value',
  ]

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
      { small: 4_096, large: ONE_MEGABYTE_UNITS },
    )
    expect(exponent).toBeLessThan(EXPONENT_CEILING)
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
      expect(exponent).toBeLessThan(EXPONENT_CEILING)
    },
  )

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
})
