/**
 * `prescanStructure` directly: the budget breaches, the abort points, and the unterminated paths.
 *
 * `prescan.differential.spec.ts` proves the scanner AGREES with the parser on well-formed input,
 * which is the contract. It cannot reach the branches that only fire on input the parser rejects —
 * an unterminated comment, a close tag with no open, a budget breach mid-document — and those
 * branches are what decide whether the bound actually bounds. A mutation run found most of them
 * indistinguishable, which is the same thing said in numbers.
 *
 * Every outcome below asserts the FULL shape (`ok`, `exceeded`, and both measurements), because
 * the measurements at the abort point are the evidence that the scan stopped there rather than
 * walking the rest of a hostile document.
 */

import { describe, expect, it } from 'vitest'
import { prescanStructure } from './prescan'

const GENEROUS = { maxDepth: 10_000, maxElements: 1_000_000 }

describe('budget breaches abort the scan at the breach', () => {
  it('a depth breach reports depth, and the element count reached SO FAR', () => {
    const outcome = prescanStructure('<a><b><c><d/></c></b></a>', { maxDepth: 2, maxElements: 100 })
    // Not merely `ok: false`: the figures prove the scan stopped at `<c>` — the third element,
    // depth 3 — rather than finishing and reporting the document's true size.
    expect(outcome).toEqual({ ok: false, exceeded: 'depth', maxDepth: 3, elementCount: 3 })
  })

  it('an element breach reports the count at the breach', () => {
    const outcome = prescanStructure('<r><i/><i/><i/><i/><i/></r>', {
      maxDepth: 100,
      maxElements: 3,
    })
    expect(outcome).toEqual({ ok: false, exceeded: 'elements', maxDepth: 2, elementCount: 4 })
  })

  it('depth is checked BEFORE elements, so a deep narrow document reports depth', () => {
    // Both budgets are breached by this input. The order matters for the reason a caller sees,
    // and a swap would report TOO_MANY_ELEMENTS for a document whose problem is nesting.
    const outcome = prescanStructure('<a><b><c/></b></a>', { maxDepth: 1, maxElements: 1 })
    expect(outcome).toMatchObject({ ok: false, exceeded: 'depth' })
  })

  it('a document exactly AT both budgets passes', () => {
    // The other side of every assertion above. Without it they would all hold for a scan that
    // refused everything.
    const outcome = prescanStructure('<a><b/></a>', { maxDepth: 2, maxElements: 2 })
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 2 })
  })

  it('a self-closing root is depth 1, count 1', () => {
    expect(prescanStructure('<r/>', GENEROUS)).toEqual({ ok: true, maxDepth: 1, elementCount: 1 })
  })

  it('no markup at all is depth 0, count 0', () => {
    expect(prescanStructure('just text', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 0,
      elementCount: 0,
    })
  })

  it('the empty string is depth 0, count 0', () => {
    expect(prescanStructure('', GENEROUS)).toEqual({ ok: true, maxDepth: 0, elementCount: 0 })
  })
})

describe('unterminated constructs stop the scan instead of looping', () => {
  it.each([
    ['comment', '<r><i/><!-- never closed'],
    ['cdata', '<r><i/><![CDATA[ never closed'],
    ['processing instruction', '<r><i/><?php never closed'],
    ['markup declaration', '<r><i/><!ENTITY never closed'],
    ['start tag', '<r><i/><open'],
    ['close tag', '<r><i/></open'],
  ])('an unterminated %s ends the scan with what was counted before it', (_name, xml) => {
    const outcome = prescanStructure(xml, GENEROUS)
    // `ok: true` is correct and deliberate: the SCAN completed, it simply found nothing more. The
    // document is malformed, and saying so is the parser's job — a scan that returned `ok: false`
    // here would be reporting a budget breach that did not happen.
    expect(outcome.ok).toBe(true)
    expect(outcome.elementCount).toBeGreaterThanOrEqual(2)
  })

  it('an unterminated start tag does not count the element twice', () => {
    expect(prescanStructure('<r><open', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
    })
  })
})

describe('depth accounting', () => {
  it('an unbalanced close tag does not drive depth negative', () => {
    // Without the `Math.max(0, …)` the counter would go to -1 and the following element would be
    // measured at depth 0, under-reporting the nesting of everything after it.
    const outcome = prescanStructure('</stray><a><b/></a>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 2 })
  })

  it('many stray close tags still leave the following depth correct', () => {
    const outcome = prescanStructure('</a></b></c><r><i><j/></i></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 3, elementCount: 3 })
  })

  it('maxDepth is the deepest branch, not the last one', () => {
    const outcome = prescanStructure('<r><a><b><c/></b></a><d/></r>', GENEROUS)
    // r, a, b, c, d = 5 elements; deepest branch r > a > b > c = 4.
    expect(outcome).toEqual({ ok: true, maxDepth: 4, elementCount: 5 })
  })

  it('a self-closing tag whose attribute value ends in `/` still closes itself', () => {
    // `endOfStartTag` reports `selfClosing` from the character before the REAL `>`. A URL ending
    // in a slash inside the attribute is the shape that trips a naive check.
    const outcome = prescanStructure('<r><a href="https://x/y/"/><b/></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3 })
  })

  it('a `>` inside an attribute value does not end the tag', () => {
    const outcome = prescanStructure('<r><a href="a>b"/><c/></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3 })
  })

  it('single quotes delimit an attribute value as well as double', () => {
    // The quote tracking accepts both; handling only `"` would mis-read every feed that uses `'`.
    const outcome = prescanStructure("<r><a href='a>b'/><c/></r>", GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3 })
  })
})

describe('name-start recognition', () => {
  it('a `<` followed by a digit or punctuation is not an element', () => {
    // XML names cannot start with a digit. Counting `<3` as an element would let text inflate the
    // count and trip the ceiling on an innocent feed.
    expect(prescanStructure('<r><t>3 <4 <5</t></r>', GENEROUS)).toMatchObject({
      elementCount: 2,
    })
  })

  it('an underscore and a colon are legal name starts', () => {
    expect(prescanStructure('<_r><:odd/></_r>', GENEROUS)).toMatchObject({ elementCount: 2 })
  })

  it('a non-ASCII name start is recognised', () => {
    // Element names may be Unicode, and a feed in Ukrainian may well use them. A scan that only
    // accepted ASCII would under-count.
    expect(prescanStructure('<документ><і/></документ>', GENEROUS)).toMatchObject({
      elementCount: 2,
    })
  })

  it('a trailing bare `<` at end of input terminates the scan cleanly', () => {
    expect(prescanStructure('<r/><', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
    })
  })
})

describe('the markup-declaration skipper', () => {
  it('a doctype with an internal subset is skipped whole', () => {
    // The `[` / `]` tracking: without it the scan would stop at the first `>` inside the subset
    // and then read the subset's own `<!ENTITY>` lines as elements.
    const xml = '<!DOCTYPE r [<!ENTITY a "AAA"><!ELEMENT r (#PCDATA)>]><r><i/></r>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({ ok: true, maxDepth: 2, elementCount: 2 })
  })

  it('a `>` inside a quoted declaration value does not end it', () => {
    const xml = '<!DOCTYPE r SYSTEM "a>b"><r><i/></r>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({ ok: true, maxDepth: 2, elementCount: 2 })
  })

  it('a plain doctype is skipped', () => {
    expect(prescanStructure('<!DOCTYPE r><r/>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
    })
  })

  it('a comment containing `--` inside is skipped to its real end', () => {
    expect(prescanStructure('<r><!-- a - b --><i/></r>', GENEROUS)).toMatchObject({
      elementCount: 2,
    })
  })

  it('a CDATA section containing `]]` before its terminator is skipped correctly', () => {
    expect(prescanStructure('<r><d><![CDATA[a]] b]]></d></r>', GENEROUS)).toMatchObject({
      elementCount: 2,
    })
  })
})
