/**
 * R-2: the `PRESCAN_DIFFERENTIAL` guard actually fires.
 *
 * `prescan.differential.spec.ts` proves no real document can trip this guard — which is the
 * desired state and also the reason the guard's branch would otherwise be untested. An untested
 * fail-loud path is one that may not be loud: a typo in the comparison, an inverted condition, or
 * a `catch` that swallowed it would all leave every other spec green.
 *
 * So the scanner is replaced at its module boundary with one that miscounts, which is the only way
 * to reach the branch. ALL THREE terms of the condition are exercised — a wrong element count, a
 * wrong depth and a wrong attribute count — because `||` means any one could be dropped without
 * the others noticing.
 *
 * THE ATTRIBUTE TERM ARRIVED WITH A TRAP, worth recording because it is the general shape of how a
 * mocked boundary rots. When `attributeCount` was added to `StructureMeasurement`, these mocks
 * went on returning the old two-field object — so `prescan.attributeCount` was `undefined`,
 * `actual.attributeCount !== undefined` was true for every document, and the third term fired in
 * every test here. The suite stayed green and the two ORIGINAL terms became untested: the mutation
 * gate reported six survivors on this condition, which is exactly right. A mock that is allowed to
 * be an incomplete version of the real type tests the mock.
 *
 * Hence the `measurement()` helper below: every mock goes through it, so a field added to
 * `StructureMeasurement` is a type error here rather than a silently satisfied condition.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BoundedXmlPort } from './bounded-xml-port'
import type { StructureMeasurement } from './prescan'
import { XmlPortError } from './xml-port'

const prescanMock = vi.hoisted(() => vi.fn())
/** The real scanner, captured in the factory so the module body needs no top-level await. */
const real = vi.hoisted(() => ({ prescanStructure: null as null | ((...a: never[]) => unknown) }))

vi.mock('./prescan', async () => {
  const actual = await vi.importActual<typeof import('./prescan')>('./prescan')
  real.prescanStructure = actual.prescanStructure as unknown as (...a: never[]) => unknown
  return { ...actual, prescanStructure: prescanMock }
})

const port = new BoundedXmlPort()
const FEED = '<r><a><b/></a></r>' // 3 elements, depth 3, 0 attributes
const bytes = new TextEncoder().encode(FEED)
/** The feed's TRUE measurement, from which each test perturbs exactly one field. */
const TRUE_MEASUREMENT = { maxDepth: 3, elementCount: 3, attributeCount: 0 }

/**
 * Build a complete `StructureMeasurement`, typed, so a new field cannot be omitted here.
 *
 * `Partial<…>` spread over the true values: each test names ONLY the field it is corrupting, which
 * makes the intent of each case readable and makes "everything else is correct" the default rather
 * than something each case has to restate (and could get wrong, masking the term under test).
 */
const measurement = (
  wrong: Partial<StructureMeasurement>,
): { ok: true } & StructureMeasurement => ({
  ok: true,
  ...TRUE_MEASUREMENT,
  ...wrong,
})

beforeEach(() => {
  prescanMock.mockReset()
})

const reasonOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof XmlPortError) return error.reason
    throw error
  }
  throw new Error('expected a refusal, but the call returned')
}

describe('R-2: a scan that disagrees with the parser is a loud error', () => {
  it('POSITIVE CONTROL: the honest scan passes the guard', () => {
    // Without this, every assertion below would also hold for a port that refused everything —
    // and the guard would be indistinguishable from a blanket failure.
    prescanMock.mockImplementation((...args: never[]) => real.prescanStructure?.(...args))
    const document = port.parseDocument(bytes)
    expect(document.elementCount).toBe(3)
    expect(document.depth).toBe(3)
  })

  it('a scan that agrees on EVERY field passes — the control for the three cases below', () => {
    // Distinct from the positive control above: that one uses the real scanner, this one feeds the
    // true measurement through the mock. So a case below that fails for a reason OTHER than the
    // field it perturbs (a mock shaped wrong, say) is separated from a genuine catch.
    prescanMock.mockReturnValue(measurement({}))
    expect(port.parseDocument(bytes).elementCount).toBe(3)
  })

  it('an UNDER-counted element total raises PRESCAN_DIFFERENTIAL', () => {
    // Under-counting is the dangerous direction: it is how a document slips past the element
    // ceiling that bounds parse time and memory.
    prescanMock.mockReturnValue(measurement({ elementCount: 1 }))
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('PRESCAN_DIFFERENTIAL')
  })

  it('an OVER-counted element total raises it too', () => {
    prescanMock.mockReturnValue(measurement({ elementCount: 99 }))
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('PRESCAN_DIFFERENTIAL')
  })

  it('a wrong DEPTH raises it, with the other two counts correct', () => {
    // One term of the `||` each. With only the element-count assertion, dropping the depth
    // comparison would leave the suite green.
    prescanMock.mockReturnValue(measurement({ maxDepth: 1 }))
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('PRESCAN_DIFFERENTIAL')
  })

  it('a wrong ATTRIBUTE count raises it, with the depth and element count correct', () => {
    // The third term, and the one the wall-clock bound now rests on: a scan that under-counts
    // attributes is a scan that lets a 150 000-attribute tag past the item ceiling. Under-count
    // and over-count both, because a one-sided test leaves the comparison's direction free.
    prescanMock.mockReturnValue(measurement({ attributeCount: 7 }))
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('PRESCAN_DIFFERENTIAL')
    const withAttributes = new TextEncoder().encode('<r a="1" b="2"/>')
    prescanMock.mockReturnValue({ ok: true, maxDepth: 1, elementCount: 1, attributeCount: 0 })
    expect(reasonOf(() => port.parseDocument(withAttributes))).toBe('PRESCAN_DIFFERENTIAL')
  })

  it('the message names all three measurements, so the bug is diagnosable from a log', () => {
    prescanMock.mockReturnValue(measurement({ maxDepth: 1 }))
    let message = ''
    try {
      port.parseDocument(bytes)
    } catch (error) {
      message = (error as XmlPortError).message
    }
    expect(message).toContain('1/3/0')
    expect(message).toContain('3/3/0')
  })

  it('a refusal from the scan is reported as the BOUND it breached, not as a differential', () => {
    // The guard runs only after a successful scan. A scan that refuses must still surface its own
    // reason — otherwise a depth breach would arrive as an internal-error code.
    prescanMock.mockReturnValue({
      ok: false,
      exceeded: 'depth',
      maxDepth: 999,
      elementCount: 1,
      attributeCount: 0,
    })
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('TOO_DEEP')
  })

  it('an unterminated-start-tag refusal from the scan is reported as MALFORMED', () => {
    // The third arm of `PrescanOutcome`, added this round. Reached through the mock because the
    // port's own branch on it (`'unterminated' in prescan`) sits before the budget branches, and
    // an arm no test reaches is an arm that can be deleted without anything going red.
    prescanMock.mockReturnValue({
      ok: false,
      unterminated: 'start-tag',
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('MALFORMED')
  })
})
