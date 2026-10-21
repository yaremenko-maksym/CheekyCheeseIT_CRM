/**
 * Namespaces in XML 1.0 (Third Edition) conformance of the port's namespace layer.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `namespaces.spec.ts`
 * --------------------------------------------------------
 * `namespaces.spec.ts` tests the three functions. This file tests the port against the
 * SPECIFICATION, end to end through `BoundedXmlPort`, and it exists because the unit tests passed
 * while six distinct departures from §3–§7 were live. Tests written against the functions as
 * implemented cannot find a rule the implementation never had.
 *
 * SO EVERY BLOCK BELOW STARTS WITH WHAT THE SPEC ADMITS, AND ONLY THEN WHAT IT FORBIDS.
 * -----------------------------------------------------------------------------------
 * This is the costly lesson of the sibling PR, and it applies with force here: a test derived
 * from a defect report inherits the report's one-sidedness. "Reject `xmlns:p=\"\"`" is satisfied
 * by a layer that rejects every `xmlns:` attribute, which would refuse every namespaced feed in
 * existence. The acceptance assertion is what makes the refusal assertion mean anything, and in
 * each block the acceptance case is the one the spec's own MAY/legal text names — `xmlns=""`,
 * `xmlns:xml` to its own URI, an `xml`-prefixed name, a reserved-looking `xmlfoo:` prefix.
 *
 * The spec text each block is derived from is quoted beside it, because the whole value of the
 * exercise is that the expected value came from there and not from the finding.
 */

import { describe, expect, it } from 'vitest'
import { BoundedXmlPort } from './bounded-xml-port'
import { XML_NAMESPACE, XMLNS_NAMESPACE } from './namespaces'
import { findChild } from './xml-tree'
import type { XmlFailureReason } from './xml-port'
import { XmlPortError } from './xml-port'

const port = new BoundedXmlPort()
const parse = (xml: string) => port.parseDocument(new TextEncoder().encode(xml))

/** The reason, or the string `'ACCEPTED'` — so an acceptance and a refusal compare the same way. */
const outcome = (xml: string): XmlFailureReason | 'ACCEPTED' => {
  try {
    parse(xml)
    return 'ACCEPTED'
  } catch (error) {
    if (error instanceof XmlPortError) return error.reason
    throw error
  }
}

describe('§5 NSC "No Prefix Undeclaring" — a prefix declaration may not be empty', () => {
  // "The attribute value in a default namespace declaration MAY be empty." (§6.2)
  it('`xmlns=""` undeclares the DEFAULT namespace, which 1.0 permits', () => {
    const doc = parse('<r xmlns="http://example.com/d"><x xmlns=""/></r>')
    expect(doc.root.namespaceUri).toBe('http://example.com/d')
    expect(findChild(doc.root, 'x')?.namespaceUri).toBeNull()
  })

  // "In a namespace declaration for a prefix (i.e., where the NSAttName is a PrefixedAttName),
  // the attribute value MUST NOT be empty." (§5)
  //
  // Undeclaring a prefix is a Namespaces 1.1 feature. We implement 1.0, so this is a refusal and
  // not a tolerance: the two versions disagree about what the document MEANS, and guessing 1.1
  // would resolve `p:x` to no namespace on a document whose author may have meant either.
  it.each([
    ['declared empty and then used', '<r xmlns:p=""><p:x/></r>'],
    ['declared empty and never used', '<r xmlns:p=""/>'],
    ['undeclared on a child after a real binding', '<r xmlns:p="http://e/x"><c xmlns:p=""/></r>'],
  ])('`xmlns:p=""` is refused — %s', (_case, xml) => {
    expect(outcome(xml)).toBe('PREFIX_UNDECLARING')
  })
})

describe('§3 NSC "Reserved Prefixes and Namespace Names"', () => {
  // "It MAY, but need not, be declared" — so a feed spelling out the binding it already has is
  // CORRECT, and this is the acceptance case that stops the refusals below from overreaching.
  it('`xmlns:xml` bound to its own URI is permitted, and `xml:` still resolves', () => {
    const doc = parse(`<r xmlns:xml="${XML_NAMESPACE}"><x xml:lang="uk"/></r>`.replace('\n', ''))
    const child = findChild(doc.root, 'x')
    expect(child?.attributes[0]).toMatchObject({
      localName: 'lang',
      prefix: 'xml',
      namespaceUri: XML_NAMESPACE,
    })
  })

  it('the `xml` prefix resolves without any declaration at all', () => {
    const doc = parse('<r xml:lang="en"/>')
    expect(doc.root.attributes[0]?.namespaceUri).toBe(XML_NAMESPACE)
  })

  // "All other prefixes beginning with the three-letter sequence x, m, l, in any case
  // combination, are reserved. … processors must not treat them as fatal errors."
  //
  // This is the acceptance case that pins the refusals to the TWO exact names. A layer that
  // refused prefixes by `startsWith('xml')` would satisfy every refusal in this describe block
  // and violate the spec in the other direction.
  it.each(['xmlfoo', 'XML-x', 'xmlns2', 'mliteral'])(
    'the reserved-looking prefix %s is not a fatal error',
    (prefix) => {
      const doc = parse(`<r xmlns:${prefix}="http://example.com/u"><${prefix}:a/></r>`)
      expect(findChild(doc.root, 'a')?.namespaceUri).toBe('http://example.com/u')
    },
  )

  it.each([
    // "MUST NOT be bound to any other namespace name." Silently IGNORED before: `lookup` answered
    // `xml` from its hard-coded branch before consulting the bindings, so the document said one
    // thing, the tree said another, and nothing said anything was wrong.
    ['the xml prefix rebound elsewhere', '<r xmlns:xml="http://example.com/o"><xml:x/></r>'],
    ['the xml prefix rebound, unused', '<r xmlns:xml="http://example.com/o"/>'],
    // "Other prefixes MUST NOT be bound to this namespace name."
    ['another prefix bound to the xml namespace', `<r xmlns:q="${XML_NAMESPACE}"><q:x/></r>`],
    // "it MUST NOT be declared as the default namespace."
    ['the xml namespace as the default', `<r xmlns="${XML_NAMESPACE}"/>`],
    // "The prefix xmlns … MUST NOT be declared."
    ['the xmlns prefix declared', '<r xmlns:xmlns="http://example.com/x"/>'],
    ['the xmlns prefix declared to its own URI', `<r xmlns:xmlns="${XMLNS_NAMESPACE}"/>`],
    // The same clause, read for the xmlns namespace name.
    ['another prefix bound to the xmlns namespace', `<r xmlns:q="${XMLNS_NAMESPACE}"><q:x/></r>`],
    ['the xmlns namespace as the default', `<r xmlns="${XMLNS_NAMESPACE}"/>`],
    // "Element names MUST NOT have the prefix xmlns."
    ['an element prefixed xmlns', '<r><xmlns:t>x</xmlns:t></r>'],
  ])('%s is refused', (_case, xml) => {
    expect(outcome(xml)).toBe('RESERVED_NAMESPACE')
  })
})

describe('§7 / §4 — an element or attribute name carries zero or one colon', () => {
  it('a single interior colon is the ordinary, accepted case', () => {
    const doc = parse('<r xmlns:c="http://example.com/c"><c:encoded>x</c:encoded></r>')
    expect(findChild(doc.root, 'encoded')?.namespaceUri).toBe('http://example.com/c')
  })

  it.each([
    // `Prefix ::= NCName`, and an NCName is an XML Name "minus the ':'".
    ['two colons in an element name', '<r xmlns:a="http://e/a"><a:b:c/></r>'],
    ['two colons in an attribute name', '<r xmlns:a="http://e/a" a:b:c="1"/>'],
    ['a leading colon', '<r><:x/></r>'],
    ['a trailing colon', '<r><x:/></r>'],
    // The one that was not merely tolerated but actively MISREAD: `'xmlns:'.slice(6)` is `''`,
    // which is the key `xmlns=` writes, so an attribute literally named `xmlns:` acted as a
    // DEFAULT-namespace declaration and silently put every unprefixed child in its URI.
    ['an attribute named exactly `xmlns:`', '<r xmlns:="http://example.com/d"><kid/></r>'],
    ['a declaration whose prefix has a colon', '<r xmlns:a:b="http://example.com/d"/>'],
  ])('%s is refused', (_case, xml) => {
    expect(outcome(xml)).toBe('MALFORMED_QNAME')
  })

  it('`xmlns:` does NOT become a default declaration — the regression that motivated the rule', () => {
    // Pinned as a value, not only as a refusal: if a future edition decides to tolerate the name,
    // the thing it must never do again is treat it as `xmlns=`.
    expect(outcome('<r xmlns:="http://example.com/d"><kid/></r>')).not.toBe('ACCEPTED')
    const legitimate = parse('<r xmlns="http://example.com/d"><kid/></r>')
    expect(findChild(legitimate.root, 'kid')?.namespaceUri).toBe('http://example.com/d')
  })
})

describe('§6.3 NSC "Attributes Unique" — no element has two attributes with one expanded name', () => {
  it('two prefixes bound to DIFFERENT URIs give two distinct attributes', () => {
    const doc = parse(
      '<r xmlns:a="http://example.com/u" xmlns:b="http://example.com/v" a:x="1" b:x="2"/>',
    )
    expect(doc.root.attributes.map((a) => [a.namespaceUri, a.localName, a.value])).toEqual([
      ['http://example.com/u', 'x', '1'],
      ['http://example.com/v', 'x', '2'],
    ])
  })

  it('the same local name in no namespace and in a namespace are distinct', () => {
    const doc = parse('<r xmlns:a="http://example.com/u" x="1" a:x="2"/>')
    expect(doc.root.attributes.map((a) => [a.namespaceUri, a.localName])).toEqual([
      [null, 'x'],
      ['http://example.com/u', 'x'],
    ])
  })

  // "This constraint is equivalent to requiring that no element have two attributes with the same
  // expanded name." Two prefixes, one URI: literally distinct names, one attribute.
  it.each([
    [
      'two prefixes bound to one URI',
      '<r xmlns:a="http://e/u" xmlns:b="http://e/u" a:x="1" b:x="2"/>',
    ],
    [
      'a prefix and the xml prefix on the XML namespace is NOT possible, so: nested redeclaration',
      '<r xmlns:a="http://e/u"><c xmlns:b="http://e/u" a:x="1" b:x="2"/></r>',
    ],
  ])('%s is refused', (_case, xml) => {
    expect(outcome(xml)).toBe('DUPLICATE_ATTRIBUTE')
  })
})

describe('a prefix is attacker-chosen text, not an object key', () => {
  // The acceptance side first, and it is not a formality: before the fix, declaring a prefix
  // named `__proto__` wrote the map's PROTOTYPE instead of a key, so this legal document lost its
  // declaration outright and the element resolved to `Object.prototype`.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'a prefix named %s resolves to the URI the document declared for it',
    (prefix) => {
      const doc = parse(`<r xmlns:${prefix}="http://example.com/u"><${prefix}:a b="1"/></r>`)
      const child = findChild(doc.root, 'a')
      expect(child?.namespaceUri).toBe('http://example.com/u')
      expect(doc.root.namespaceDeclarations[prefix]).toBe('http://example.com/u')
    },
  )

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'an UNdeclared prefix named %s is undeclared, on an element and on an attribute',
    (prefix) => {
      expect(outcome(`<r><${prefix}:a/></r>`)).toBe('UNDECLARED_PREFIX')
      expect(outcome(`<r ${prefix}:a="1"/>`)).toBe('UNDECLARED_PREFIX')
    },
  )

  // The type, asserted at runtime because the compiler was told a lie it could not catch:
  // `namespaceUri` is declared `string | null` and held `function Object(){}`. ~25 adapters
  // inherit that field, so a lie here is 25 lies.
  it('`namespaceUri` is a string or null for every node, never an inherited member', () => {
    const doc = parse(
      '<r xmlns:constructor="http://example.com/u"><constructor:a toString:b="1" xmlns:toString="http://example.com/v"/></r>',
    )
    const child = findChild(doc.root, 'a')
    expect(typeof child?.namespaceUri).toBe('string')
    const attributes = child?.attributes ?? []
    expect(attributes).not.toHaveLength(0)
    for (const attribute of attributes) {
      const uri: unknown = attribute.namespaceUri
      expect(uri === null || typeof uri === 'string').toBe(true)
    }
  })

  it('the declarations map has no prototype, so no lookup can fall through to one', () => {
    const doc = parse('<r xmlns:p="http://example.com/u"/>')
    expect(Object.getPrototypeOf(doc.root.namespaceDeclarations)).toBeNull()
  })
})
