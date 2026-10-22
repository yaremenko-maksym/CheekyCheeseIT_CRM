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

const GENEROUS = { maxDepth: 10_000, maxElements: 1_000_000, maxItems: 1_000_000 }

describe('budget breaches abort the scan at the breach', () => {
  it('a depth breach reports depth, and the element count reached SO FAR', () => {
    const outcome = prescanStructure('<a><b><c><d/></c></b></a>', {
      maxDepth: 2,
      maxElements: 100,
      maxItems: 1_000,
    })
    // Not merely `ok: false`: the figures prove the scan stopped at `<c>` — the third element,
    // depth 3 — rather than finishing and reporting the document's true size.
    expect(outcome).toEqual({
      ok: false,
      exceeded: 'depth',
      maxDepth: 3,
      elementCount: 3,
      attributeCount: 0,
    })
  })

  it('an element breach reports the count at the breach', () => {
    const outcome = prescanStructure('<r><i/><i/><i/><i/><i/></r>', {
      maxDepth: 100,
      maxElements: 3,
      maxItems: 1_000,
    })
    expect(outcome).toEqual({
      ok: false,
      exceeded: 'elements',
      maxDepth: 2,
      elementCount: 4,
      attributeCount: 0,
    })
  })

  it('depth is checked BEFORE elements, so a deep narrow document reports depth', () => {
    // Both budgets are breached by this input. The order matters for the reason a caller sees,
    // and a swap would report TOO_MANY_ELEMENTS for a document whose problem is nesting.
    const outcome = prescanStructure('<a><b><c/></b></a>', {
      maxDepth: 1,
      maxElements: 1,
      maxItems: 1_000,
    })
    expect(outcome).toMatchObject({ ok: false, exceeded: 'depth' })
  })

  it('a document exactly AT both budgets passes', () => {
    // The other side of every assertion above. Without it they would all hold for a scan that
    // refused everything.
    const outcome = prescanStructure('<a><b/></a>', {
      maxDepth: 2,
      maxElements: 2,
      maxItems: 1_000,
    })
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 2, attributeCount: 0 })
  })

  it('a self-closing root is depth 1, count 1', () => {
    expect(prescanStructure('<r/>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('no markup at all is depth 0, count 0', () => {
    expect(prescanStructure('just text', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 0,
      elementCount: 0,
      attributeCount: 0,
    })
  })

  it('the empty string is depth 0, count 0', () => {
    expect(prescanStructure('', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 0,
      elementCount: 0,
      attributeCount: 0,
    })
  })
})

describe('unterminated constructs stop the scan instead of looping', () => {
  it.each([
    ['comment', '<r><i/><!-- never closed'],
    ['cdata', '<r><i/><![CDATA[ never closed'],
    ['processing instruction', '<r><i/><?php never closed'],
    ['markup declaration', '<r><i/><!ENTITY never closed'],
    ['close tag', '<r><i/></open'],
  ])('an unterminated %s ends the scan with what was counted before it', (_name, xml) => {
    const outcome = prescanStructure(xml, GENEROUS)
    // `ok: true` is correct and deliberate FOR THESE FIVE: the SCAN completed, it simply found
    // nothing more, and the document's malformedness is the parser's verdict to give. It is also
    // measured rather than assumed — each of these shapes costs ~1 ms in `parseXml` at 2 MiB
    // before it comes back `MALFORMED`, so there is no cost leaking through the `break`.
    //
    // THE START TAG IS NOT IN THIS LIST ANY MORE, and it used to be. Its `break` cost 147 ms of
    // parse on a 1.6 MiB tag and discarded the attribute count on the way, so it had its own
    // refusal and its own pair of tests below.
    expect(outcome.ok).toBe(true)
    expect(outcome.elementCount).toBeGreaterThanOrEqual(2)
  })

  it('an unterminated START tag is the one that is refused, not merely ended', () => {
    expect(prescanStructure('<r><i/><open', GENEROUS)).toMatchObject({
      ok: false,
      unterminated: 'start-tag',
      elementCount: 3,
    })
  })

  /**
   * DEGENERATE constructs, where the terminator overlaps the opener.
   *
   * These pin the START OFFSET of each skip, which the happy-path tests cannot: for an ordinary
   * `<?pi?>` a search beginning one character earlier finds the same `?>`, so the offset looks
   * equivalent. It is not. In `<?>` the `?` is BOTH the opener and the first character of a
   * would-be `?>`, so a search starting at or before it matches a terminator that does not
   * exist — the construct is unterminated and must end the scan, and a scan that resumed instead
   * would go on to count the elements after it.
   *
   * I had written these off as equivalent mutants and was about to suppress them. They are not.
   */
  it('`<?>` is an unterminated PI — its `?` is not also its terminator', () => {
    expect(prescanStructure('<?><r/>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 0,
      elementCount: 0,
      attributeCount: 0,
    })
  })

  it('`<!-->` is an unterminated comment — its `--` is not also its terminator', () => {
    expect(prescanStructure('<!--><r/>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 0,
      elementCount: 0,
      attributeCount: 0,
    })
  })

  it('a PI whose content contains `<?` resumes PAST its terminator, not before it', () => {
    // Pins `skipPast`'s RETURN offset (`at + marker.length`), which the ordinary cases cannot:
    // resuming a couple of characters early normally lands before the same next `<`. Here the two
    // characters before the terminator are themselves `<?`, so resuming early re-reads them as a
    // second processing instruction — which is then unterminated, ends the scan, and reports zero
    // elements for a document that has one.
    //
    // `<?a<?>` : the `?>` at index 4 is the terminator; indices 3-4 are `<?`.
    expect(prescanStructure('<?a<?><r/>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('POSITIVE CONTROL: the well-formed versions of both DO skip and keep scanning', () => {
    // Without this pair, the two assertions above would hold for a scan that gave up on every
    // `<?` or `<!--` whatsoever.
    expect(prescanStructure('<?pi?><r/>', GENEROUS)).toMatchObject({
      elementCount: 1,
      attributeCount: 0,
    })
    expect(prescanStructure('<!--c--><r/>', GENEROUS)).toMatchObject({
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('an unterminated start tag does not count the element twice', () => {
    // Still the original point — `<open` is counted once, not once for the name and once for a
    // `>` that never arrives — but read off a refusal now rather than an `ok`. See the
    // `unterminated` pair further down for why the `ok` was the defect and not the design.
    expect(prescanStructure('<r><open', GENEROUS)).toEqual({
      ok: false,
      unterminated: 'start-tag',
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })
})

describe('depth accounting', () => {
  it('an unbalanced close tag does not drive depth negative', () => {
    // Without the `Math.max(0, …)` the counter would go to -1 and the following element would be
    // measured at depth 0, under-reporting the nesting of everything after it.
    const outcome = prescanStructure('</stray><a><b/></a>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 2, attributeCount: 0 })
  })

  it('many stray close tags still leave the following depth correct', () => {
    const outcome = prescanStructure('</a></b></c><r><i><j/></i></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 3, elementCount: 3, attributeCount: 0 })
  })

  it('maxDepth is the deepest branch, not the last one', () => {
    const outcome = prescanStructure('<r><a><b><c/></b></a><d/></r>', GENEROUS)
    // r, a, b, c, d = 5 elements; deepest branch r > a > b > c = 4.
    expect(outcome).toEqual({ ok: true, maxDepth: 4, elementCount: 5, attributeCount: 0 })
  })

  it('a self-closing tag whose attribute value ends in `/` still closes itself', () => {
    // `endOfStartTag` reports `selfClosing` from the character before the REAL `>`. A URL ending
    // in a slash inside the attribute is the shape that trips a naive check.
    const outcome = prescanStructure('<r><a href="https://x/y/"/><b/></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 1 })
  })

  it('a `>` inside an attribute value does not end the tag', () => {
    const outcome = prescanStructure('<r><a href="a>b"/><c/></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 1 })
  })

  it('single quotes delimit an attribute value as well as double', () => {
    // The quote tracking accepts both; handling only `"` would mis-read every feed that uses `'`.
    const outcome = prescanStructure("<r><a href='a>b'/><c/></r>", GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 1 })
  })

  it('an apostrophe inside a double-quoted value does not open a quote', () => {
    // The `quote !== null` branch has to IGNORE the other quote character while inside a string.
    // Treating this `'` as an opener would leave the scanner "inside a quote" for the rest of the
    // document, so the `>` of every later tag would be skipped and depth would run away.
    const outcome = prescanStructure(`<r><a t="it's > fine"/><c/></r>`, GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 1 })
  })

  it('a double quote inside a single-quoted value does not open a quote', () => {
    const outcome = prescanStructure(`<r><a t='say "hi" > x'/><c/></r>`, GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 1 })
  })

  it('two attributes each with a `>` both close their quotes', () => {
    // Proves the quote is RESET on the closing delimiter rather than latched: with a one-way
    // latch, the second attribute's `>` would be treated as inside a string.
    const outcome = prescanStructure('<r><a p="x>y" q="z>w"/><c/></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 2 })
  })

  it('an element immediately after a processing instruction is still counted', () => {
    // The offset `skipPast` resumes at: resuming inside `?>` would leave the scanner positioned
    // so that the following element is still found, but resuming too far would skip it.
    expect(prescanStructure('<?pi?><r/>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('an element immediately after a CDATA section is still counted', () => {
    // r, d, e = 3 elements; the CDATA is not one. Depth 2 — d and e are siblings.
    const outcome = prescanStructure('<r><d><![CDATA[x]]></d><e/></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 0 })
  })

  it('an element immediately after a comment is still counted', () => {
    expect(prescanStructure('<r><!--c--><d/></r>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('an element immediately after a doctype is still counted', () => {
    expect(prescanStructure('<!DOCTYPE r><r><d/></r>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a close tag with an attribute-like `>` after it does not lose the next element', () => {
    const outcome = prescanStructure('<r><a></a><b/></r>', GENEROUS)
    expect(outcome).toEqual({ ok: true, maxDepth: 2, elementCount: 3, attributeCount: 0 })
  })
})

describe('name-start recognition', () => {
  it('a `<` followed by a digit or punctuation is not an element', () => {
    // XML names cannot start with a digit. Counting `<3` as an element would let text inflate the
    // count and trip the ceiling on an innocent feed.
    expect(prescanStructure('<r><t>3 <4 <5</t></r>', GENEROUS)).toMatchObject({
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('an underscore and a colon are legal name starts', () => {
    expect(prescanStructure('<_r><:odd/></_r>', GENEROUS)).toMatchObject({
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a non-ASCII name start is recognised', () => {
    // Element names may be Unicode, and a feed in Ukrainian may well use them. A scan that only
    // accepted ASCII would under-count.
    expect(prescanStructure('<документ><і/></документ>', GENEROUS)).toMatchObject({
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a trailing bare `<` at end of input terminates the scan cleanly', () => {
    expect(prescanStructure('<r/><', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })
})

describe('the markup-declaration skipper', () => {
  it('a doctype with an internal subset is skipped whole', () => {
    // The `[` / `]` tracking: without it the scan would stop at the first `>` inside the subset
    // and then read the subset's own `<!ENTITY>` lines as elements.
    const xml = '<!DOCTYPE r [<!ENTITY a "AAA"><!ELEMENT r (#PCDATA)>]><r><i/></r>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a `>` inside a double-quoted declaration value does not end it', () => {
    const xml = '<!DOCTYPE r SYSTEM "a>b"><r><i/></r>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a `>` inside a SINGLE-quoted declaration value does not end it', () => {
    const xml = "<!DOCTYPE r SYSTEM 'a>b'><r><i/></r>"
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('an apostrophe inside a double-quoted declaration value is not a delimiter', () => {
    const xml = `<!DOCTYPE r SYSTEM "it's > here"><r><i/></r>`
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  /**
   * The three tests below all hide an ELEMENT inside the construct being skipped.
   *
   * That is what makes them discriminating, and it took a mutation run to see why the earlier
   * versions did not: a declaration that terminates early still lands the scanner in a position
   * where `indexOf('<')` finds the next real element, so element-free subsets give the same answer
   * whether the subset was tracked or not. Only a `<` INSIDE the skipped region can be
   * mis-counted — and a feed that wants the pre-scan to disagree with the parser would put one
   * there, so this is the threat model rather than a contrivance.
   */
  it('an element hidden inside the DTD subset is NOT counted', () => {
    // Without `inSubset`, the `>` after `(#PCDATA)` ends the declaration, the scan resumes, and
    // `<fake/>` is counted — a pre-scan reporting 2 elements where the parser sees 1.
    const xml = '<!DOCTYPE r [<!ELEMENT fake (#PCDATA)> <fake/>]><r/>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('an element hidden inside a QUOTED declaration value is NOT counted', () => {
    // Without the quote tracking, the `>` inside the system identifier ends the declaration and
    // `<fake/>` is counted.
    const xml = '<!DOCTYPE r SYSTEM "a><fake/>b"><r/>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('an element hidden inside a SINGLE-quoted declaration value is NOT counted', () => {
    const xml = "<!DOCTYPE r SYSTEM 'a><fake/>b'><r/>"
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('an element hidden inside a COMMENT is NOT counted', () => {
    expect(prescanStructure('<r><!-- <fake/> --><d/></r>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('an element hidden inside a processing instruction is NOT counted', () => {
    expect(prescanStructure('<r><?pi <fake/> ?><d/></r>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('the `]` must clear the subset, or the declaration never terminates', () => {
    // The complement: if `]` did not clear `inSubset`, no later `>` would end the declaration,
    // `endOfMarkupDeclaration` would return -1, the scan would break, and the document's real
    // elements would be reported as ZERO — a bound that passes everything.
    const xml = '<!DOCTYPE r [<!ELEMENT a (#PCDATA)>]><r/><s/>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a subset closed and then REOPENED is tracked both times', () => {
    // `inSubset` must be set false on `]` and true again on a later `[`. A latch either way would
    // make one of the two `>` characters terminate the declaration early.
    const xml = '<!DOCTYPE r [<!ELEMENT a (#PCDATA)>] [<!ELEMENT b (#PCDATA)>]><r><i/></r>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('an element after the doctype`s subset is counted, not swallowed', () => {
    // The `]` must clear `inSubset` so the following `>` DOES terminate. Without that the scan
    // would run to end of input and count nothing at all.
    const xml = '<!DOCTYPE r [<!ENTITY a "x">]><r><i/><j/></r>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 3,
      attributeCount: 0,
    })
  })

  it('a plain doctype is skipped', () => {
    expect(prescanStructure('<!DOCTYPE r><r/>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 0,
    })
  })

  it('a comment containing `--` inside is skipped to its real end', () => {
    expect(prescanStructure('<r><!-- a - b --><i/></r>', GENEROUS)).toMatchObject({
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a CDATA section whose content contains `]>` is skipped to its REAL terminator', () => {
    // This is what makes the dedicated CDATA branch load-bearing rather than redundant, and it
    // took a mutation run to notice the question. Delete that branch and a CDATA section still
    // falls through to `endOfMarkupDeclaration`, which usually consumes it identically — the
    // `[` of `[CDATA[` opens its bracket tracking and the `]]` closes it, so the terminating `>`
    // lands at the same index. The exception is content carrying `]>`: the `]` clears the bracket
    // state and the `>` then terminates the declaration EARLY, mid-section — after which the
    // `<fake/>` inside the CDATA is counted as a real element and the pre-scan disagrees with the
    // parser by exactly one. Which is the differential this whole file exists to prevent.
    const xml = '<r><d><![CDATA[]><fake/>]]></d></r>'
    expect(prescanStructure(xml, GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('a CDATA section containing `]]` before its terminator is skipped correctly', () => {
    expect(prescanStructure('<r><d><![CDATA[a]] b]]></d></r>', GENEROUS)).toMatchObject({
      elementCount: 2,
      attributeCount: 0,
    })
  })
})

/**
 * The attribute count, which the wall-clock bound now rests on.
 *
 * WRITTEN FROM THE PRODUCTION, NOT FROM THE FINDING. The finding was "150 000 attributes on one
 * element slips the budget", and a test derived from it would assert one refusal and prove nothing
 * about the counter — a counter that returned a huge constant would pass it. XML 1.0 §3.1 gives
 * `Attribute ::= Name Eq AttValue` with `AttValue` always quoted and `Eq ::= S? '=' S?`, so within
 * a start tag each attribute contributes exactly one `=` outside quotes and nothing else can.
 * These cases are the ways that claim could be false: an `=` inside a value, an `=` in a construct
 * that is not a start tag, odd spacing, and the declaration attributes this scan cannot tell apart
 * from the rest.
 */
describe('the attribute count is the count of `=` outside quotes, exactly', () => {
  const manyAttributes = (n: number) => Array.from({ length: n }, (_, k) => `a${k}="v"`).join(' ')

  it.each([
    ['no attributes', '<r/>', 0],
    ['one', '<r a="1"/>', 1],
    ['several, across elements', '<r a="1" b="2"><c d="3"/></r>', 3],
    // `Eq ::= S? '=' S?` — the spacing is explicitly optional on both sides.
    ['spaces around the equals', '<r a = "1"/>', 1],
    ['a newline around the equals', '<r a\n=\n"1"/>', 1],
    // The value is `AttValue`, always delimited, so an `=` inside it is data.
    ['an equals inside a value', '<r a="x=y=z"/>', 1],
    ['an equals inside a single-quoted value', "<r a='x=y'/>", 1],
    ['the other quote char inside a value', `<r a="it's=fine"/>`, 1],
    // Constructs that are not start tags are routed away before the counter ever sees them.
    ['the XML declaration', '<?xml version="1.0" encoding="UTF-8"?><r/>', 0],
    ['a processing instruction', '<?pi a="1"?><r/>', 0],
    ['a comment containing an equals', '<r><!-- a="1" --></r>', 0],
    ['CDATA containing a start tag', '<r><![CDATA[<i a="1"/>]]></r>', 0],
    ['text containing an equals', '<r>a=1</r>', 0],
    ['an end tag after an attribute', '<r a="1"></r>', 1],
    // `xmlns` declarations ARE attributes syntactically, and this scan knows nothing of
    // namespaces, so it counts them. `measureTree` adds them back on the other side.
    ['an xmlns declaration', '<r xmlns="http://e/d"/>', 1],
    ['a prefixed declaration plus a real attribute', '<r xmlns:p="http://e/p" a="1"/>', 2],
    // The shape SR-M-2 named, in miniature: two elements, a great many attributes.
    ['500 attributes on ONE element', `<r><i ${manyAttributes(500)}/></r>`, 500],
  ])('%s', (_case, text, expected) => {
    expect(prescanStructure(text, GENEROUS).attributeCount).toBe(expected)
  })

  // THIS PAIR REPLACES A TEST THAT ASSERTED THE DEFECT AS IF IT WERE THE DESIGN.
  //
  // The test here before read "an unterminated start tag contributes no attribute count", expected
  // `ok: true, attributeCount: 0`, and explained that not counting a tag the tree will never
  // contain avoids a false differential. Every clause of that was true, and the conclusion was
  // wrong: the scan returned `ok`, so the document went PAST the item budget to the parser with
  // its 150 000 attributes measured as zero — 147 ms of parse on a 1.6 MiB tag, measured. A test
  // written to explain a `break` will always agree with the `break`.
  //
  // The acceptance side comes first and is the half that keeps the refusal honest: a TERMINATED
  // tag with the same attributes must still be measured and still pass, or the fix is a wall.
  it('a TERMINATED start tag is measured, whatever its attributes do', () => {
    expect(prescanStructure('<r><i a="1" b="2"/></r>', GENEROUS)).toEqual({
      ok: true,
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 2,
    })
    // At the item budget exactly: 2 elements + 3 attributes = 5 items, and it passes.
    expect(
      prescanStructure('<r><i a="1" b="2" c="3"/></r>', { ...GENEROUS, maxItems: 5 }),
    ).toMatchObject({ ok: true, attributeCount: 3 })
  })

  it('an UNTERMINATED start tag is refused rather than measured and passed on', () => {
    // `unterminated`, not `exceeded`: nothing was exceeded, the scan has no answer. The partial
    // count is still reported, because an operator reading the log wants to know how far it got.
    expect(prescanStructure('<r><i a="1"', GENEROUS)).toEqual({
      ok: false,
      unterminated: 'start-tag',
      maxDepth: 2,
      elementCount: 2,
      attributeCount: 0,
    })
  })

  it('the refusal does not depend on the budget — a generous budget refuses it too', () => {
    // The distinction that matters: this is not a bound being hit, it is a document that cannot be
    // measured. A reader who raises every limit must still get the refusal.
    expect(
      prescanStructure(`<r><i ${manyAttributes(300)}`, {
        maxDepth: Number.MAX_SAFE_INTEGER,
        maxElements: Number.MAX_SAFE_INTEGER,
        maxItems: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ ok: false, unterminated: 'start-tag' })
  })

  it('the ITEM budget counts elements and attributes together, and aborts at the breach', () => {
    // Acceptance side: exactly at the budget passes. 1 element + 4 attributes = 5 items.
    expect(prescanStructure('<r a="1" b="2" c="3" d="4"/>', { ...GENEROUS, maxItems: 5 })).toEqual({
      ok: true,
      maxDepth: 1,
      elementCount: 1,
      attributeCount: 4,
    })
    // One item more is refused, and `exceeded` is `items` rather than `elements`: the two bounds
    // are on different quantities and a caller needs to know which one to raise.
    expect(
      prescanStructure('<r a="1" b="2" c="3" d="4" e="5"/>', { ...GENEROUS, maxItems: 5 }),
    ).toEqual({ ok: false, exceeded: 'items', maxDepth: 1, elementCount: 1, attributeCount: 5 })
  })

  it('attributes alone breach the item budget with the element count far below its cap', () => {
    // The hole, stated as a test: `maxElements` is generous and untouched, and the document is
    // refused anyway. Under the element-only budget this document was two elements and passed.
    expect(
      prescanStructure(`<r><i ${manyAttributes(200)}/></r>`, {
        maxDepth: 100,
        maxElements: 100_000,
        maxItems: 50,
      }),
    ).toMatchObject({ ok: false, exceeded: 'items' })
  })
})
