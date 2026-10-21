/**
 * R-1, parts 1-3: a POSITIVE CONTROL, an error type and message, and an internal-entity
 * capability test with the port's `<!DOCTYPE` refusal BYPASSED.
 *
 * WHY THIS FILE EXISTS AT ALL — the defect it is a fix for
 * -------------------------------------------------------
 * The ADR specified three assertions about the parser's configuration and then withdrew them,
 * because mutation testing against seven wrapper variants showed they were not falsifiable:
 *
 *   - a wrapper whose `parseDocument` ALWAYS THREW passed all three;
 *   - the XXE assertion was masked by the document's own `<!DOCTYPE` pre-reject, which fires
 *     before the parser runs — so an EXPANDING parser behind that gate passed the assertion
 *     written to detect exactly that regression;
 *   - the third read a local variable instead of the real call site (closed in
 *     `parse-xml.adapter.options.spec.ts`).
 *
 * So the checks meant to close a finding about a claim whose true and false states looked
 * identical were themselves checks whose passing and absence looked identical. This file is
 * written against the two failure modes directly: it imports the ADAPTER, not the port, so the
 * gate cannot answer for the parser; and it asserts a SUCCESS with a specific value, so a
 * blanket-throwing implementation fails.
 */

import { describe, expect, it } from 'vitest'
import { fixtureText } from '../../test/xml-corpus'
// The adapter by path, deliberately not through `./index`, which does not re-export it: this is
// the parser layer with every gate bypassed, which is the only place such an import belongs.
import { parseXmlString } from './parse-xml.adapter'
import { findChild } from './xml-tree'
import { XmlPortError } from './xml-port'

describe('R-1 positive control: the suite can tell a hardened parser from a broken one', () => {
  it('a defined entity parses to its specific value', () => {
    const document = parseXmlString(fixtureText('positive-control.xml'))
    const item = findChild(findChild(document.root, 'channel') as never, 'item')
    expect(findChild(item as never, 'title')?.text).toBe('Backend & Dev')
  })

  it('an ordinary feed yields the structure, not an empty tree', () => {
    const document = parseXmlString(fixtureText('rss-cdata-entities.xml'))
    expect(document.root.localName).toBe('rss')
    expect(document.root.children.length).toBeGreaterThan(0)
  })
})

describe('R-1 capability: the internal subset is never parsed', () => {
  /**
   * THE test. One internal general entity, no file, no URL, no recursion — nothing a DOCTYPE
   * pre-reject, a network block or a size cap could stop. An expanding parser reads "AAA" here;
   * this one cannot, because it never declared the entity.
   */
  it('an internal entity is NOT expanded — it is undefined, and that raises', () => {
    const source = fixtureText('attack-internal-entity.xml')
    // The gate the port would apply is genuinely absent from this path — asserted, so the test
    // cannot be silently re-masked by someone moving the refusal into the adapter.
    expect(source).toContain('<!DOCTYPE')

    let raised: unknown
    try {
      parseXmlString(source)
    } catch (error) {
      raised = error
    }

    expect(raised).toBeInstanceOf(XmlPortError)
    expect((raised as XmlPortError).reason).toBe('MALFORMED')
    // The parser-specific message, asserted on `cause` and NOT on the port's reason. This is the
    // one coupling in the suite that a parser swap will break, and it is isolated here on purpose
    // — the ADR is explicit that tests encoding parser messages do not survive a replacement.
    expect((raised as XmlPortError).cause).toBeInstanceOf(Error)
    expect(((raised as XmlPortError).cause as Error).message).toMatch(/entity isn't defined/i)
  })

  it('no value anywhere in the failure path contains the expanded text', () => {
    // The complement of the assertion above: "it threw" would also be true of a parser that
    // expanded the entity and then failed for an unrelated reason. This looks for "AAA" itself.
    let message = ''
    try {
      parseXmlString(fixtureText('attack-internal-entity.xml'))
    } catch (error) {
      message = `${(error as Error).message}${String((error as XmlPortError).cause)}`
    }
    expect(message).not.toContain('AAA')
  })

  it('billion laughs yields an undefined-entity error, not an expansion', () => {
    // With a hostile `resolveUndefinedEntity` the ADR measured TEN characters out of this
    // document, not an exponential blow-up, because the nested declarations were never parsed.
    // Without one it simply raises on the first reference.
    expect(() => parseXmlString(fixtureText('attack-billion-laughs.xml'))).toThrow(XmlPortError)
  })

  /**
   * THE NUANCE, PINNED SO IT CANNOT BE FLATTENED INTO "XXE IS REFUSED".
   *
   * A parameter-entity / external-DTD document with no general-entity reference in content is
   * ACCEPTED: it parses, the DTD is discarded unread, nothing is dereferenced. Inert acceptance is
   * not a vulnerability — but it means "the parser rejects DTD constructs" is false, and only
   * "the parser rejects UNDEFINED ENTITY REFERENCES" is true. This asymmetry is the reason the
   * capability test above uses an internal-entity document and not a classic XXE one.
   */
  it('a parameter-entity / external-DTD document is ACCEPTED, inertly, at the parser layer', () => {
    const document = parseXmlString(fixtureText('attack-parameter-entity.xml'))
    expect(document.root.localName).toBe('rss')
    // Nothing from the DTD reached the tree: no entity text, no system identifier.
    const serialised = JSON.stringify(document.root)
    expect(serialised).not.toContain('canary')
    expect(serialised).not.toContain('external.dtd')
  })

  it('the classic XXE documents raise at the parser layer too, for the entity reason', () => {
    // Worth asserting separately from the port's DOCTYPE refusal: it shows the gate is defence in
    // depth rather than the only thing standing between us and an entity.
    for (const file of ['attack-xxe-file.xml', 'attack-xxe-http.xml']) {
      let raised: unknown
      try {
        parseXmlString(fixtureText(file))
      } catch (error) {
        raised = error
      }
      expect((raised as XmlPortError).reason, file).toBe('MALFORMED')
      expect(((raised as XmlPortError).cause as Error).message, file).toMatch(
        /entity isn't defined/i,
      )
    }
  })
})

describe('R-1 drift gate: an undefined entity with no DOCTYPE at all', () => {
  it('&nbsp; raises rather than arriving as literal text', () => {
    // Decided by `ignoreUndefinedEntities: false` ALONE — no DOCTYPE for a gate to catch. With the
    // option flipped this parses and `<title>` reads "Backend&nbsp;Dev": a malformed feed accepted
    // as vacancy content, which is the plan's "malformed = drift" inverted.
    let raised: unknown
    try {
      parseXmlString(fixtureText('attack-undefined-entity-no-doctype.xml'))
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError).reason).toBe('MALFORMED')
  })
})
