/**
 * R-2: the `PRESCAN_DIFFERENTIAL` guard actually fires.
 *
 * `prescan.differential.spec.ts` proves no real document can trip this guard — which is the
 * desired state and also the reason the guard's branch would otherwise be untested. An untested
 * fail-loud path is one that may not be loud: a typo in the comparison, an inverted condition, or
 * a `catch` that swallowed it would all leave every other spec green.
 *
 * So the scanner is replaced at its module boundary with one that miscounts, which is the only way
 * to reach the branch. Both halves of the condition are exercised — a wrong element count and a
 * wrong depth — because `||` means either could be dropped without the other noticing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BoundedXmlPort } from './bounded-xml-port'
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
const FEED = '<r><a><b/></a></r>' // 3 elements, depth 3
const bytes = new TextEncoder().encode(FEED)

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

  it('an UNDER-counted element total raises PRESCAN_DIFFERENTIAL', () => {
    // Under-counting is the dangerous direction: it is how a document slips past the element
    // ceiling that bounds parse time and memory.
    prescanMock.mockReturnValue({ ok: true, maxDepth: 3, elementCount: 1 })
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('PRESCAN_DIFFERENTIAL')
  })

  it('an OVER-counted element total raises it too', () => {
    prescanMock.mockReturnValue({ ok: true, maxDepth: 3, elementCount: 99 })
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('PRESCAN_DIFFERENTIAL')
  })

  it('a wrong DEPTH raises it, with the element count correct', () => {
    // The other half of the `||`. With only the element-count assertion, dropping the depth
    // comparison would leave the suite green.
    prescanMock.mockReturnValue({ ok: true, maxDepth: 1, elementCount: 3 })
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('PRESCAN_DIFFERENTIAL')
  })

  it('the message names both measurements, so the bug is diagnosable from a log', () => {
    prescanMock.mockReturnValue({ ok: true, maxDepth: 1, elementCount: 3 })
    let message = ''
    try {
      port.parseDocument(bytes)
    } catch (error) {
      message = (error as XmlPortError).message
    }
    expect(message).toContain('1/3')
    expect(message).toContain('3/3')
  })

  it('a refusal from the scan is reported as the BOUND it breached, not as a differential', () => {
    // The guard runs only after a successful scan. A scan that refuses must still surface its own
    // reason — otherwise a depth breach would arrive as an internal-error code.
    prescanMock.mockReturnValue({ ok: false, exceeded: 'depth', maxDepth: 999, elementCount: 1 })
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('TOO_DEEP')
  })
})
