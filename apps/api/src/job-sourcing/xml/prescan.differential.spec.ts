/**
 * R-2: the pre-scan agrees with the real parser. Measured, on documents built to make it disagree.
 *
 * WHY THIS IS THE LOAD-BEARING SPEC FOR THE BOUNDS
 * -----------------------------------------------
 * R-2 names the risk exactly: "any disagreement between that scan and the real parser (`<` / `>`
 * inside attributes, comments, CDATA, PIs) is a **parser-differential** surface". A scanner that
 * under-counts does not fail loudly — it silently raises the element ceiling for the one document
 * shaped to exploit it, which is the only document that matters. So the bound's correctness is not
 * a property of `prescan.ts` being carefully written; it is a property of these two numbers being
 * equal, on inputs chosen adversarially.
 *
 * THE NEGATIVE CONTROL IS NOT OPTIONAL HERE. Every document below is also run through a NAIVE
 * counter — the regex-ish `count of '<'` that a reasonable person would write first — and the
 * suite asserts that the naive count is WRONG on each one. Without that, "the scanner agrees with
 * the parser" would pass equally for a corpus of documents on which any scanner agrees, i.e. for a
 * test that checks nothing. The naive-disagreement assertion is what proves these inputs
 * discriminate.
 */

import { describe, expect, it } from 'vitest'
import { douFeedBytes, fixtureText, utf8, WELL_FORMED_FIXTURES } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { parseXmlString } from './parse-xml.adapter'
import { prescanStructure } from './prescan'
import { DEFAULT_XML_LIMITS } from './xml-limits'
import { measureTree } from './xml-tree'

/** A budget nothing in this spec can exceed, so the scan always runs to completion. */
const GENEROUS = { maxDepth: 10_000, maxElements: 1_000_000 }

/** What a first attempt at counting looks like: every `<` that begins a name. */
const naiveElementCount = (xml: string): number => (xml.match(/<[A-Za-z_:]/g) ?? []).length

/**
 * What a first attempt at DEPTH looks like: the same walk as the real scanner, but ending a start
 * tag at the first `>` without tracking quotes.
 *
 * Separate from the count because the two fail on DIFFERENT documents, and a negative control that
 * named only one of them would understate what the scanner has to get right. `>` is perfectly
 * legal inside an attribute value, so `<a href="a>b"/>` ends at the LAST `>` — a scanner taking
 * the first one never sees the `/` and believes the element opened a level it never closes.
 */
function naiveDepth(xml: string): number {
  let depth = 0
  let maxDepth = 0
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    const gt = xml.indexOf('>', lt)
    if (gt === -1) break
    const name = xml[lt + 1]
    if (name === '/') {
      depth = Math.max(0, depth - 1)
    } else if (name !== undefined && /[A-Za-z_:]/.test(name)) {
      depth += 1
      if (depth > maxDepth) maxDepth = depth
      if (xml[gt - 1] === '/') depth -= 1
    }
    i = gt + 1
  }
  return maxDepth
}

interface Trap {
  name: string
  xml: string
  /** Element count the PARSER produces. Stated as a literal, counted by hand. */
  elements: number
  depth: number
}

/**
 * Documents whose markup-looking text is NOT markup. Each `elements` figure is counted by hand
 * from the document, not read back from either implementation — an expected value derived from the
 * code under test is the tautology the mutation gate exists to catch.
 */
const TRAPS: readonly Trap[] = [
  {
    // NOT `<` inside the attribute: a literal `<` in an attribute value is a well-formedness
    // ERROR in XML, so the first version of this trap was not a document at all and the parser
    // rightly refused it. `>` is legal there, and is the half that matters for the scanner.
    name: '`>` inside an attribute value does not end the tag',
    xml: '<r><a href="a>b"/><c/></r>',
    elements: 3, // <r>, <a>, <c>
    depth: 2,
  },
  {
    name: '`<item>` inside CDATA is literal text',
    xml: '<r><d><![CDATA[<item><item><item>]]></d></r>',
    elements: 2, // <r>, <d> — and nothing from the CDATA
    depth: 2,
  },
  {
    name: '`<item>` inside a comment is not an element',
    xml: '<r><!-- <item><item> --><d/></r>',
    elements: 2, // <r>, <d>
    depth: 2,
  },
  {
    name: '`<item>` inside a processing instruction is not an element',
    xml: '<r><?php echo "<item><item>"; ?><d/></r>',
    elements: 2, // <r>, <d>
    depth: 2,
  },
  {
    name: 'a bare `<` in text is not an element',
    xml: '<r><t>3 &lt; 5 and x &lt;y</t></r>',
    elements: 2,
    depth: 2,
  },
  {
    name: 'self-closing tags do not open a level',
    xml: '<r><a/><b/><c/></r>',
    elements: 4,
    depth: 2,
  },
  {
    name: 'a self-closing tag with a `/` inside an attribute still closes itself',
    xml: '<r><a href="https://x/y/"/><b/></r>',
    elements: 3,
    depth: 2,
  },
  {
    name: 'an element name that merely starts like another',
    xml: '<items><item>a</item><itemize>b</itemize></items>',
    elements: 3,
    depth: 2,
  },
  {
    name: 'the XML declaration is not an element',
    xml: '<?xml version="1.0" encoding="utf-8"?><r><d/></r>',
    elements: 2,
    depth: 2,
  },
  {
    name: 'nesting and siblings interleaved',
    xml: '<r><a><b><c/></b></a><d><e/></d></r>',
    elements: 6, // r, a, b, c, d, e
    depth: 4, // r > a > b > c
  },
]

describe('R-2: the pre-scan matches the parser on documents built to break it', () => {
  it.each(TRAPS)('$name', ({ xml, elements, depth }) => {
    const scanned = prescanStructure(xml, GENEROUS)
    const parsed = measureTree(parseXmlString(xml).root)

    // Three-way: both implementations against the hand-counted literal. Asserting only
    // scan === parse would be satisfied by two implementations that are wrong together.
    expect(parsed.elementCount, 'parser vs hand count').toBe(elements)
    expect(parsed.maxDepth, 'parser depth vs hand count').toBe(depth)
    expect(scanned.ok && scanned.elementCount, 'scan vs hand count').toBe(elements)
    expect(scanned.ok && scanned.maxDepth, 'scan depth vs hand count').toBe(depth)
  })

  it('NEGATIVE CONTROL: a naive COUNTER is wrong on the text-that-looks-like-markup traps', () => {
    // Proves the corpus discriminates. If the obvious implementation got everything right, the
    // suite above would be decoration — it would pass for any scanner at all.
    const fooled = TRAPS.filter((trap) => naiveElementCount(trap.xml) !== trap.elements).map(
      (trap) => trap.name,
    )
    expect(fooled).toEqual([
      '`<item>` inside CDATA is literal text',
      '`<item>` inside a comment is not an element',
      '`<item>` inside a processing instruction is not an element',
    ])
  })

  it('NEGATIVE CONTROL: a naive DEPTH scan is wrong on an OVERLAPPING but different set', () => {
    // Measured, not predicted — the first version of this assertion guessed the url-slash trap
    // would fool it and it does not (there is no `>` inside that attribute, so the first `>` IS
    // the tag end and the `/` before it is seen). Both measures are asserted because a scanner
    // can be right about how many elements exist and wrong about how deeply they nest, and the
    // element ceiling and the depth bound are enforced separately.
    const fooled = TRAPS.filter((trap) => naiveDepth(trap.xml) !== trap.depth).map(
      (trap) => trap.name,
    )
    expect(fooled).toEqual([
      '`>` inside an attribute value does not end the tag',
      '`<item>` inside CDATA is literal text',
      '`<item>` inside a comment is not an element',
      '`<item>` inside a processing instruction is not an element',
    ])
    // The one document that fools the depth scan but NOT the counter — i.e. proof the two
    // measures are independent and the overlap is not total.
    expect(fooled).toContain('`>` inside an attribute value does not end the tag')
    expect(naiveElementCount('<r><a href="a>b"/><c/></r>')).toBe(3)
  })

  it('the traps that fool NEITHER naive version are the over-correction guards', () => {
    // Stated explicitly so the corpus is not later "improved" by deleting them: a scanner that
    // skipped aggressively enough to handle CDATA and quoting could start missing ordinary
    // elements, and these are the documents that would catch it.
    const safe = TRAPS.filter(
      (trap) =>
        naiveElementCount(trap.xml) === trap.elements && naiveDepth(trap.xml) === trap.depth,
    )
    expect(safe.length).toBeGreaterThanOrEqual(4)
  })

  it('agrees with the parser on every well-formed fixture in the corpus', () => {
    for (const file of WELL_FORMED_FIXTURES) {
      const xml = fixtureText(file)
      const scanned = prescanStructure(xml, GENEROUS)
      const parsed = measureTree(parseXmlString(xml).root)
      expect(scanned.ok, file).toBe(true)
      expect(scanned.ok && scanned.elementCount, file).toBe(parsed.elementCount)
      expect(scanned.ok && scanned.maxDepth, file).toBe(parsed.maxDepth)
    }
  })

  it('agrees on the authentic-grammar DOU feed, comments and escaped HTML included', () => {
    // The one document in the corpus whose field grammar came from a live feed. It carries XML
    // comments between items and heavily entity-escaped HTML in `<description>`, which is where a
    // scanner mishandling `&lt;p&gt;` — markup-looking text that is genuinely text — diverges.
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(douFeedBytes())
    const scanned = prescanStructure(xml, GENEROUS)
    const parsed = measureTree(parseXmlString(xml).root)
    expect(scanned.ok && scanned.elementCount).toBe(parsed.elementCount)
    expect(scanned.ok && scanned.maxDepth).toBe(parsed.maxDepth)
    // Not a bare equality: pin that the document is substantial, so the assertion above is not
    // "0 === 0" should the fixture ever be emptied.
    expect(parsed.elementCount).toBeGreaterThan(20)
  })
})

describe('R-2: the port reports the parsed tree, not the scan', () => {
  it('depth and count come back as the hand-counted figures', () => {
    const document = new BoundedXmlPort().parseDocument(
      utf8('<r><a><b><c/></b></a><d><e/></d></r>'),
      DEFAULT_XML_LIMITS,
    )
    expect(document.elementCount).toBe(6)
    expect(document.depth).toBe(4)
  })
})
