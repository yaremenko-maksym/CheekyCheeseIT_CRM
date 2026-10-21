/**
 * R-2: the five bounds, each asserted AT the limit and one past it.
 *
 * A one-sided boundary test — "1 element past the cap is refused" with nothing saying the cap
 * itself is accepted — passes equally for a port that refuses everything. Every bound below is
 * therefore two assertions, and the pair is what makes the number a limit rather than a direction.
 *
 * The wall-clock bound gets a third kind of check, because it is the one the ADR found
 * unverifiable: a measured parse at exactly the derived ceiling, which fails if
 * `PARSE_ELEMENTS_PER_MS` has rotted by an order of magnitude.
 */

import { describe, expect, it } from 'vitest'
import { utf8 } from '../../test/xml-corpus'
import { MAX_FEED_BYTES } from '../rss'
import { BoundedXmlPort } from './bounded-xml-port'
import {
  DEFAULT_XML_LIMITS,
  elementCeiling,
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
  MAX_XML_WALL_CLOCK_MS,
  PARSE_ELEMENTS_PER_MS,
} from './xml-limits'
import { XmlPortError } from './xml-port'

const port = new BoundedXmlPort()

const reasonOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof XmlPortError) return error.reason
    throw error
  }
  throw new Error('expected a refusal, but the call returned')
}

describe('R-2: the byte cap is 2 MiB and is the SAME constant the DOU scanner uses', () => {
  it('the magnitude is pinned against an independent literal', () => {
    // 2 * 1024 * 1024 written out, NOT derived from the constant under test: comparing a value
    // against the very constant it should pin is the first of the three shapes the mutation gate
    // exists to catch. Raise the constant and this goes red.
    expect(MAX_XML_BYTES).toBe(2097152)
    expect(MAX_XML_WALL_CLOCK_MS).toBe(250)
    expect(MAX_XML_DEPTH).toBe(100)
    expect(MAX_XML_ELEMENTS).toBe(100000)
    expect(PARSE_ELEMENTS_PER_MS).toBe(200)
  })

  it('it IS the scanner constant, not merely equal to it today', () => {
    // The import is the mechanism; this asserts the mechanism is in place. Re-declaring the
    // literal in `xml-limits.ts` would leave the magnitude test above green and this one red.
    expect(MAX_XML_BYTES).toBe(MAX_FEED_BYTES)
  })

  it('a body exactly AT the cap is accepted', () => {
    const open = '<r><i>'
    const close = '</i></r>'
    const filler = 'x'.repeat(MAX_XML_BYTES - open.length - close.length)
    const bytes = utf8(`${open}${filler}${close}`)
    expect(bytes.byteLength).toBe(MAX_XML_BYTES)
    expect(port.parseDocument(bytes).root.localName).toBe('r')
  })

  it('a body ONE byte past the cap is refused', () => {
    const open = '<r><i>'
    const close = '</i></r>'
    const filler = 'x'.repeat(MAX_XML_BYTES - open.length - close.length + 1)
    const bytes = utf8(`${open}${filler}${close}`)
    expect(bytes.byteLength).toBe(MAX_XML_BYTES + 1)
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('TOO_MANY_BYTES')
  })

  it('the cap counts BYTES, not characters', () => {
    // A multi-byte document under the cap in characters but over it in bytes must be refused —
    // the resource being bounded is memory and decode work, both of which scale with bytes. A
    // `.length` check would pass this and is the mistake the DOU scanner makes with `xml.length`.
    const cyrillic = 'я'.repeat(MAX_XML_BYTES) // 2 bytes each in UTF-8
    const bytes = utf8(`<r>${cyrillic}</r>`)
    expect(bytes.byteLength).toBeGreaterThan(MAX_XML_BYTES)
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('TOO_MANY_BYTES')
  })
})

describe('R-2: nesting depth is OUR bound, never the V8 stack cliff', () => {
  const nested = (depth: number): Uint8Array =>
    utf8(`${'<a>'.repeat(depth)}x${'</a>'.repeat(depth)}`)

  it('a document exactly AT the depth limit is accepted', () => {
    const document = port.parseDocument(nested(MAX_XML_DEPTH))
    expect(document.depth).toBe(MAX_XML_DEPTH)
  })

  it('one level deeper is refused', () => {
    expect(reasonOf(() => port.parseDocument(nested(MAX_XML_DEPTH + 1)))).toBe('TOO_DEEP')
  })

  it('the stack cliff is unreachable through the port', () => {
    // The point of the bound: two machines measured the cliff at 5 126 vs 5 419 frames by
    // default, and `--stack-size=20000` SEGFAULTS rather than throwing. A 6 000-deep document
    // must come back as our refusal, with a reason, not as a RangeError or a crash.
    expect(reasonOf(() => port.parseDocument(nested(6000)))).toBe('TOO_DEEP')
  })

  it('depth is measured in ELEMENTS, so self-closing siblings do not accumulate', () => {
    // A scan that forgot to decrement on `/>` would report depth 500 here and refuse a document
    // that is two levels deep.
    const document = port.parseDocument(utf8(`<r>${'<i/>'.repeat(500)}</r>`))
    expect(document.depth).toBe(2)
  })
})

describe('R-2: the element ceiling, and which bound set it', () => {
  it('at the defaults the TIME budget binds, not the element cap', () => {
    const { ceiling, boundBy } = elementCeiling(DEFAULT_XML_LIMITS)
    expect(ceiling).toBe(50000)
    expect(boundBy).toBe('time')
  })

  it('a larger time budget hands the bound back to the element cap', () => {
    const { ceiling, boundBy } = elementCeiling({
      ...DEFAULT_XML_LIMITS,
      maxWallClockMs: 10_000,
    })
    expect(ceiling).toBe(MAX_XML_ELEMENTS)
    expect(boundBy).toBe('elements')
  })

  it('a document exactly AT the ceiling is accepted', () => {
    const { ceiling } = elementCeiling(DEFAULT_XML_LIMITS)
    // `ceiling - 1` siblings plus the root = exactly `ceiling` elements.
    const document = port.parseDocument(utf8(`<r>${'<i/>'.repeat(ceiling - 1)}</r>`))
    expect(document.elementCount).toBe(ceiling)
  })

  it('one element past the ceiling is refused, with the reason naming the time budget', () => {
    const { ceiling } = elementCeiling(DEFAULT_XML_LIMITS)
    expect(reasonOf(() => port.parseDocument(utf8(`<r>${'<i/>'.repeat(ceiling)}</r>`)))).toBe(
      'TIME_BUDGET',
    )
  })

  it('the element cap reports its own reason when IT is the binding bound', () => {
    // Distinguishable reasons are the point: "too big to parse in the time we allow" and "too big
    // to hold" have different fixes and different people raising them.
    const limits = { ...DEFAULT_XML_LIMITS, maxWallClockMs: 10_000, maxElements: 20 }
    expect(reasonOf(() => port.parseDocument(utf8(`<r>${'<i/>'.repeat(25)}</r>`), limits))).toBe(
      'TOO_MANY_ELEMENTS',
    )
  })
})

describe('R-2: the wall-clock bound is real, and the throughput constant cannot rot silently', () => {
  it('a parse at exactly the derived ceiling lands inside the budget', () => {
    const { ceiling } = elementCeiling(DEFAULT_XML_LIMITS)
    // The eight-attribute shape, which measured the WORST throughput of the ten shapes probed
    // (721 elements/ms against 6 756 for bare elements) — so this is the slow case, not a
    // flattering one.
    const bytes = utf8(
      `<r>${'<i a="1" b="2" c="3" d="4" e="5" f="6" g="7" h="8"/>'.repeat(ceiling - 1)}</r>`,
    )
    const started = process.hrtime.bigint()
    port.parseDocument(bytes, { ...DEFAULT_XML_LIMITS, maxBytes: bytes.byteLength })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    // 4x the budget, deliberately loose. WHAT THIS PROVES: `PARSE_ELEMENTS_PER_MS` is the right
    // ORDER OF MAGNITUDE, so a ceiling derived from it cannot admit a multi-second parse. WHAT IT
    // DOES NOT PROVE: the 3.6x safety margin over the measured worst case — that would need a
    // tight bound, and a tight timing assertion on a shared CI runner is a flake, not a gate.
    expect(elapsedMs).toBeLessThan(MAX_XML_WALL_CLOCK_MS * 4)
  })

  it('the conversion is floor, not round — a budget never buys more than it affords', () => {
    const { ceiling } = elementCeiling({
      ...DEFAULT_XML_LIMITS,
      maxWallClockMs: 1.7,
      maxElements: Number.MAX_SAFE_INTEGER,
    })
    expect(ceiling).toBe(340)
  })
})
