/**
 * R-2: the five bounds, each asserted AT the limit and one past it.
 *
 * A one-sided boundary test — "1 element past the cap is refused" with nothing saying the cap
 * itself is accepted — passes equally for a port that refuses everything. Every bound below is
 * therefore two assertions, and the pair is what makes the number a limit rather than a direction.
 *
 * The wall-clock bound gets two further kinds of check, because it is the one the ADR found
 * unverifiable and the one review found under-pinned:
 *
 *   - the DERIVED VALUE, asserted exactly (`itemCeiling(DEFAULT_XML_LIMITS) === 25_000`). The
 *     previous edition pinned the throughput constant only through a timing assertion with a 4×
 *     slack, which passed at ~169 ms and would have kept passing to ~1 000 ms — so the constant
 *     had 4× of silent room to drift (CR-M-3). An exact assertion on the derived number has none,
 *     and cannot flake.
 *   - a measured parse at exactly the derived ceiling, in the WORST-MEASURED shape, kept as the
 *     sanity check that the derivation is about the right quantity at all.
 *
 * And the residue the bounds do NOT cover is measured rather than argued about: per-byte-dominated
 * shapes at exactly the byte cap, in the last describe block (SPEC-M-2).
 */

import { describe, expect, it } from 'vitest'
import { utf8 } from '../../test/xml-corpus'
import { MAX_FEED_BYTES } from '../rss'
import { BoundedXmlPort } from './bounded-xml-port'
import {
  DEFAULT_XML_LIMITS,
  itemCeiling,
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
  MAX_XML_WALL_CLOCK_MS,
  PARSE_ITEMS_PER_MS,
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
    expect(PARSE_ITEMS_PER_MS).toBe(100)
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

describe('R-2: the item ceiling the wall-clock budget converts into', () => {
  // CR-M-3, THE WHOLE POINT OF THIS FIRST ASSERTION. The derived value is pinned EXACTLY, by
  // name, against a literal. The previous edition pinned the throughput constant only through the
  // timing assertion further down, whose 4× slack meant the constant could move four-fold before
  // anything went red — it measured ~169 ms against a ~1 000 ms trip wire. A constant with a 4×
  // silent range is not pinned; it is observed. This line has no range.
  it('at the defaults the ceiling is exactly 25 000 items', () => {
    expect(itemCeiling(DEFAULT_XML_LIMITS)).toBe(25000)
  })

  it('the ceiling is the budget times the throughput constant, for any budget', () => {
    // Two further points on the line, so the assertion above cannot be satisfied by a function
    // that returns 25 000 regardless — which is exactly how a one-point pin rots into decoration.
    expect(itemCeiling({ ...DEFAULT_XML_LIMITS, maxWallClockMs: 1 })).toBe(100)
    expect(itemCeiling({ ...DEFAULT_XML_LIMITS, maxWallClockMs: 1000 })).toBe(100000)
  })

  it('the ceiling does NOT depend on the element cap', () => {
    // It used to: the function returned `min(maxElements, fromTime)` with a `boundBy` tag saying
    // which won. The two caps are now on different quantities — `maxElements` bounds memory in
    // elements, this bounds time in items — so mixing them would be a category error, and the
    // pre-scan reports which bound it hit instead of the ceiling being tagged with a guess.
    expect(itemCeiling({ ...DEFAULT_XML_LIMITS, maxElements: 1 })).toBe(25000)
    expect(itemCeiling({ ...DEFAULT_XML_LIMITS, maxElements: Number.MAX_SAFE_INTEGER })).toBe(25000)
  })

  it('the conversion is floor, not round — a budget never buys more than it affords', () => {
    // 1.795 x 100 = 179.5, so floor gives 179 and round would give 180. A budget of 1.79
    // (= 179 exactly) would NOT discriminate between the two and the assertion would be decoration.
    expect(itemCeiling({ ...DEFAULT_XML_LIMITS, maxWallClockMs: 1.795 })).toBe(179)
  })

  it('a document exactly AT the ceiling is accepted', () => {
    const ceiling = itemCeiling(DEFAULT_XML_LIMITS)
    // `ceiling - 1` attribute-free siblings plus the root = exactly `ceiling` items.
    const document = port.parseDocument(utf8(`<r>${'<i/>'.repeat(ceiling - 1)}</r>`))
    expect(document.elementCount).toBe(ceiling)
  })

  it('one item past the ceiling is refused, with the reason naming the time budget', () => {
    const ceiling = itemCeiling(DEFAULT_XML_LIMITS)
    expect(reasonOf(() => port.parseDocument(utf8(`<r>${'<i/>'.repeat(ceiling)}</r>`)))).toBe(
      'TIME_BUDGET',
    )
  })

  it('an ATTRIBUTE past the ceiling is refused the same way an element is', () => {
    // SR-M-2. The acceptance side first and from the budget's own arithmetic: one element plus
    // `ceiling - 1` attributes is exactly `ceiling` items and must pass, because a bound that
    // refuses at its own limit is not the limit it claims.
    const ceiling = itemCeiling(DEFAULT_XML_LIMITS)
    const attributes = (n: number) => Array.from({ length: n }, (_, k) => `a${k}="v"`).join(' ')
    expect(port.parseDocument(utf8(`<i ${attributes(ceiling - 1)}/>`)).elementCount).toBe(1)
    expect(reasonOf(() => port.parseDocument(utf8(`<i ${attributes(ceiling)}/>`)))).toBe(
      'TIME_BUDGET',
    )
  })

  it('the shape that slipped the bound entirely is now refused — TWO elements, many attributes', () => {
    // The finding as reported: ~150 000 attributes carried by a single element. Under the
    // element-only budget this document was two elements and every bound passed it. The element
    // cap here is left at its generous default to make the point that nothing else catches it.
    const attributes = Array.from({ length: 150_000 }, (_, k) => `a${k}="v"`).join(' ')
    expect(reasonOf(() => port.parseDocument(utf8(`<r><i ${attributes}/></r>`)))).toBe(
      'TIME_BUDGET',
    )
  })

  it('an UNTERMINATED tag cannot carry attributes past the bound', () => {
    // The path that skipped the bound: the pre-scan used to return `ok` for this document with
    // `attributeCount: 0`, so 150 000 attributes reached `parseXml` unmeasured and cost 147 ms
    // before it answered `MALFORMED`. Both forms are refused now; the terminated one on the
    // budget, the unterminated one as the malformed document it is, and neither is parsed.
    const attributes = Array.from({ length: 150_000 }, (_, k) => `a${k}="v"`).join(' ')
    expect(reasonOf(() => port.parseDocument(utf8(`<r><i ${attributes}/></r>`)))).toBe(
      'TIME_BUDGET',
    )
    expect(reasonOf(() => port.parseDocument(utf8(`<r><i ${attributes}`)))).toBe('MALFORMED')
  })

  it('a well-formed document with attributes under the bound is still accepted', () => {
    // The acceptance side of BOTH refusals above. Without it they are satisfied by a port that
    // refuses every document carrying an attribute at all, which is the failure mode a test
    // derived from a defect report walks straight into.
    const attributes = Array.from({ length: 100 }, (_, k) => `a${k}="v"`).join(' ')
    const document = port.parseDocument(utf8(`<r><i ${attributes}/></r>`))
    expect(document.root.children).toHaveLength(1)
    expect(document.elementCount).toBe(2)
  })

  it('the element cap reports its OWN reason, distinct from the time budget', () => {
    // Distinguishable reasons are the point: "too big to parse in the time we allow" and "too big
    // to hold" have different fixes and different people raising them. The time budget is raised
    // here so that the element cap is the bound that bites.
    const limits = { ...DEFAULT_XML_LIMITS, maxWallClockMs: 10_000, maxElements: 20 }
    expect(reasonOf(() => port.parseDocument(utf8(`<r>${'<i/>'.repeat(25)}</r>`), limits))).toBe(
      'TOO_MANY_ELEMENTS',
    )
  })

  it('a real-feed-sized document is nowhere near any of these bounds', () => {
    // The other end of the pair: every assertion above is a refusal or a boundary, and a file of
    // nothing but refusals cannot tell a bound from a wall. ~200 items x ~7 elements is the shape
    // `xml-limits.ts` says the headroom is measured against.
    const item = '<item><title>t</title><link>l</link><guid>g</guid><pubDate>d</pubDate></item>'
    const document = port.parseDocument(utf8(`<rss><channel>${item.repeat(200)}</channel></rss>`))
    expect(document.elementCount).toBeLessThan(itemCeiling(DEFAULT_XML_LIMITS) / 10)
  })
})

describe('R-2: the wall-clock bound is real, and the throughput constant cannot rot silently', () => {
  it('a parse at exactly the derived ceiling lands inside the budget', () => {
    const ceiling = itemCeiling(DEFAULT_XML_LIMITS)
    // The FEED-LIKE shape, which is the worst items/ms measured on BOTH machines in the table in
    // `xml-limits.ts` (309 on the author's host, 792 on an M3) — the slow case, not a flattering
    // one. The eight-attribute shape this test used to build is, expressed in items, more than
    // twice as FAST, so it was the flattering one once the unit was corrected.
    const element = '<title>Senior Engineer</title>'
    const bytes = utf8(`<r>${element.repeat(ceiling - 1)}</r>`)
    const started = process.hrtime.bigint()
    port.parseDocument(bytes, { ...DEFAULT_XML_LIMITS, maxBytes: bytes.byteLength })
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    // 4x the budget, deliberately loose, and NO LONGER THE ONLY PIN on the constant — the exact
    // assertion on `itemCeiling` above is. What this adds: the derivation is about the right
    // QUANTITY, so a ceiling derived from it cannot admit a multi-second parse. And it is not
    // decoration — the first version of the constant was derived from `parseXml` alone rather than
    // the whole port, and this exact assertion failed at 1 013 ms, which is how that was found. A
    // TIGHT bound is still deliberately not attempted: on a shared CI runner it is a flake.
    expect(elapsedMs).toBeLessThan(MAX_XML_WALL_CLOCK_MS * 4)
  })
})

/**
 * SPEC-M-2: the residue, measured instead of claimed away.
 *
 * The PR body used to say all four bounds are enforced. Three are, by a count taken before the
 * parser runs. `maxWallClockMs` is converted into the item ceiling, and that conversion holds only
 * for shapes whose cost tracks item count. Shapes whose cost is per-BYTE — runs of processing
 * instructions, entity references, comments, CDATA, plain text — carry ONE element and no
 * attributes, so the item ceiling says nothing about them and `maxBytes` is the only bound they
 * meet. That is the narrowed claim, and these are the assertions that make the narrowed claim
 * testable rather than a disclaimer: each shape is built at EXACTLY the byte cap, which is the
 * worst input `maxBytes` admits, and must still complete.
 *
 * The multiple is loose for the usual reason (a timing assertion on a shared runner), so what this
 * gates is a change that made any of these super-linear — which is the failure mode that would
 * make the byte cap stop being a bound. The ADR's R-2 estimate of "near or over 250 ms at 2 MiB"
 * for the PI and `&amp;` shapes does not reproduce: measured on an M3 at the cap, PI 75 ms,
 * `&amp;` 57 ms, comment 37 ms, CDATA 26 ms, plain text 5 ms.
 */
describe('R-2: per-byte-dominated shapes are bounded by the byte cap alone, and that suffices', () => {
  const atCap = (unit: string): Uint8Array => {
    const open = '<r>'
    const close = '</r>'
    const room = MAX_XML_BYTES - open.length - close.length
    const body = unit.repeat(Math.floor(room / unit.length))
    const bytes = utf8(`${open}${body}${close}`)
    // Within one unit of the cap, and never over it — otherwise the test would be measuring
    // `TOO_MANY_BYTES` rather than the parse.
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_XML_BYTES)
    expect(bytes.byteLength).toBeGreaterThan(MAX_XML_BYTES - unit.length - 8)
    return bytes
  }

  it.each([
    ['processing instructions', '<?pi?>'],
    ['entity references', '&amp;'],
    ['comments', '<!--xx-->'],
    ['CDATA sections', '<![CDATA[xx]]>'],
    ['plain text', 'x'],
  ])('a 2 MiB run of %s carries one element and parses inside a loose multiple', (_case, unit) => {
    const bytes = atCap(unit)
    const started = process.hrtime.bigint()
    const document = port.parseDocument(bytes)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    // One element, zero attributes: this is WHY the item ceiling cannot bound these shapes, and
    // asserting it is what keeps the narrowed claim honest rather than merely written down.
    expect(document.elementCount).toBe(1)
    expect(elapsedMs).toBeLessThan(MAX_XML_WALL_CLOCK_MS * 4)
  })

  it('one byte past the cap, the same shapes are refused on bytes', () => {
    // The bound that IS doing the work here, asserted rather than assumed.
    const unit = '<?pi?>'
    const body = unit.repeat(Math.ceil(MAX_XML_BYTES / unit.length))
    expect(reasonOf(() => port.parseDocument(utf8(`<r>${body}</r>`)))).toBe('TOO_MANY_BYTES')
  })
})
