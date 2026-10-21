/**
 * `namespaces.ts` directly: QName splitting and the scope chain.
 *
 * These are exercised through the port by `feed-surface.spec.ts`, but only along the paths a feed
 * happens to take. The edge cases — a leading colon, a double colon, `xmlns=""` re-declared
 * deeper, a prefix shadowed by a descendant — are reachable from real feeds and are not reachable
 * from the fixtures, so they are tested here against the functions themselves.
 */

import { describe, expect, it } from 'vitest'
import {
  FEED_NAMESPACES,
  NamespaceScope,
  partitionAttributes,
  splitQName,
  XML_NAMESPACE,
  XMLNS_NAMESPACE,
} from './namespaces'

/**
 * The URIs as LITERALS, because they are protocol constants and not our choice.
 *
 * `expect(scope.lookup('xml')).toBe(XML_NAMESPACE)` — which is what this spec said first — is the
 * tautology the mutation gate exists to catch: it compares a value against the very constant it
 * should be pinning, so changing the constant moves the bar with it and the assertion passes for
 * any string at all. These are fixed by W3C and by the RSS/Atom specs; a feed will not follow us
 * if we mistype one, so the literal is the only thing worth asserting against.
 */
const W3C_XML = 'http://www.w3.org/XML/1998/namespace'
const W3C_XMLNS = 'http://www.w3.org/2000/xmlns/'

describe('the namespace URI constants are the ones the specs define', () => {
  it('xml and xmlns match W3C verbatim', () => {
    expect(XML_NAMESPACE).toBe(W3C_XML)
    expect(XMLNS_NAMESPACE).toBe(W3C_XMLNS)
  })

  it('the feed vocabularies match their own specs verbatim', () => {
    // One spelling shared by ~25 adapters: a typo here silently stops matching a whole vocabulary
    // rather than failing loudly, because an unmatched namespace just yields no elements.
    expect(FEED_NAMESPACES).toEqual({
      atom: 'http://www.w3.org/2005/Atom',
      content: 'http://purl.org/rss/1.0/modules/content/',
      dublinCore: 'http://purl.org/dc/elements/1.1/',
      rss1: 'http://purl.org/rss/1.0/',
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    })
  })

  it('the feed namespace table is frozen', () => {
    expect(Object.isFrozen(FEED_NAMESPACES)).toBe(true)
  })
})

describe('splitQName', () => {
  it('splits a prefixed name at its single colon', () => {
    expect(splitQName('content:encoded')).toEqual({
      prefix: 'content',
      localName: 'encoded',
    })
  })

  it('a name with no colon has no prefix', () => {
    expect(splitQName('title')).toEqual({ prefix: null, localName: 'title' })
  })

  // THE ACCEPTANCE SIDE FIRST, and from the productions rather than from the finding.
  //
  // §4 gives `QName ::= PrefixedName | UnprefixedName`, `PrefixedName ::= Prefix ':' LocalPart`,
  // with both halves `NCName` = "an XML Name minus the ':'". So the colon rule is two-sided, and
  // a test written only from the bug report ("reject a:b:c") would pin the refusals and leave the
  // acceptances to chance — including the one that matters most, that a legal name with a colon
  // in it still splits. These are the names the productions ADMIT.
  it.each([
    ['content:encoded', 'content', 'encoded'],
    // An NCName may contain `.`, `-`, `_` and digits after the first character, so these are legal
    // prefixes and legal local parts, not near-misses.
    ['dc-x.1:value_2', 'dc-x.1', 'value_2'],
    // §3 reserves every prefix starting with x/m/l but requires processors NOT to make it fatal.
    ['xmlfoo:a', 'xmlfoo', 'a'],
    ['XML-x:a', 'XML-x', 'a'],
    // `xml` itself is a perfectly good prefix to USE; only rebinding it is constrained.
    ['xml:lang', 'xml', 'lang'],
  ])('%s is a QName and splits into %s / %s', (input, prefix, localName) => {
    expect(splitQName(input)).toEqual({ prefix, localName })
  })

  // And now the refusals — the same rule read from the other side.
  it.each([
    [':leading', 'leading or trailing colon'],
    ['trailing:', 'leading or trailing colon'],
    [':', 'leading or trailing colon'],
    ['a:b:c', 'more than one colon'],
    ['a:b:', 'more than one colon'],
    [':a:b', 'leading or trailing colon'],
    ['a::b', 'more than one colon'],
  ])('%s is not a QName and is refused', (input, because) => {
    expect(() => splitQName(input)).toThrowError(
      expect.objectContaining({
        reason: 'MALFORMED_QNAME',
        message: expect.stringContaining(because),
      }),
    )
  })

  // The empty name has NO colon, so the production that refuses the names above says nothing
  // about it. It cannot arise — `@rgrove/parse-xml` enforces the XML `Name` production, which is
  // non-empty — and the point of pinning it is that this function must not be the thing that
  // crashes if that ever stops being true.
  it('the empty name has no colon and so is not refused by the colon rule', () => {
    expect(splitQName('')).toEqual({ prefix: null, localName: '' })
  })
})

describe('NamespaceScope', () => {
  it('a root scope resolves nothing but the reserved prefixes', () => {
    const root = NamespaceScope.root()
    expect(root.lookup('anything')).toBeUndefined()
    // The default namespace is "no namespace" rather than "undeclared" — those must not be
    // conflated, because one is legal and the other is an error.
    expect(root.lookup('')).toBeNull()
  })

  it('the reserved prefixes resolve without ever being declared', () => {
    const root = NamespaceScope.root()
    expect(root.lookup('xml')).toBe(W3C_XML)
    expect(root.lookup('xmlns')).toBe(W3C_XMLNS)
  })

  it('reserved prefixes win even against a declaration that tries to rebind them', () => {
    // XML forbids rebinding `xml`. Honouring an attempt would let a feed redefine `xml:lang`.
    const scope = NamespaceScope.root().child({ xml: 'http://evil.example/' })
    expect(scope.lookup('xml')).toBe(W3C_XML)
    expect(scope.lookup('xmlns')).toBe(W3C_XMLNS)
  })

  it('xmlns is reserved separately from xml — they are different URIs', () => {
    // Two branches, one line apart. Asserting only one would let the other be deleted.
    const root = NamespaceScope.root()
    expect(root.lookup('xml')).not.toBe(root.lookup('xmlns'))
  })

  it('a declaration is visible to descendants', () => {
    const scope = NamespaceScope.root().child({ c: 'urn:content' })
    expect(scope.lookup('c')).toBe('urn:content')
    expect(scope.child({}).lookup('c')).toBe('urn:content')
    expect(scope.child({ other: 'urn:other' }).lookup('c')).toBe('urn:content')
  })

  it('a descendant shadows an ancestor binding, and the ancestor keeps its own', () => {
    const outer = NamespaceScope.root().child({ p: 'urn:outer' })
    const inner = outer.child({ p: 'urn:inner' })
    expect(inner.lookup('p')).toBe('urn:inner')
    // The ancestor is immutable — the whole reason the chain is built this way, so leaving an
    // element restores the parent's bindings with no pop and no chance of a sibling inheriting
    // a cousin's prefix.
    expect(outer.lookup('p')).toBe('urn:outer')
  })

  it('child() with no declarations returns the same scope, not a new link', () => {
    // This is what keeps the chain one link per DECLARING ancestor rather than one per element,
    // which is why `lookup` can recurse safely. Asserted by identity, so the optimisation cannot
    // be removed without a red test.
    const scope = NamespaceScope.root().child({ p: 'urn:p' })
    expect(scope.child({})).toBe(scope)
  })

  it('an empty URI means "undeclared": bound to no namespace, not unresolvable', () => {
    const scope = NamespaceScope.root().child({ '': 'urn:default' }).child({ '': '' })
    expect(scope.lookup('')).toBeNull()
  })

  it('a default namespace undeclared deeper does not affect the ancestor', () => {
    const outer = NamespaceScope.root().child({ '': 'urn:default' })
    expect(outer.lookup('')).toBe('urn:default')
    expect(outer.child({ '': '' }).lookup('')).toBeNull()
  })

  it('an undeclared non-empty prefix is undefined, never null', () => {
    // The distinction the port turns into `UNDECLARED_PREFIX`. Collapsing it to `null` would make
    // a typo'd prefix silently mean "no namespace" and the element would be mis-matched rather
    // than rejected.
    const scope = NamespaceScope.root().child({ p: 'urn:p' })
    expect(scope.lookup('q')).toBeUndefined()
    expect(scope.lookup('q')).not.toBeNull()
  })
})

describe('partitionAttributes', () => {
  it('separates default and prefixed declarations from ordinary attributes', () => {
    const { declarations, rest } = partitionAttributes({
      xmlns: 'urn:default',
      'xmlns:c': 'urn:content',
      href: 'https://example.com',
      'dc:creator': 'Acme',
    })
    expect(declarations).toEqual({ '': 'urn:default', c: 'urn:content' })
    expect(rest).toEqual([
      ['href', 'https://example.com'],
      ['dc:creator', 'Acme'],
    ])
  })

  it('an attribute merely starting with xmlns is NOT a declaration', () => {
    // `xmlnsfoo` is an ordinary attribute name. A `startsWith('xmlns')` check without the colon
    // would eat it, and the attribute would vanish from the tree rather than being wrong loudly.
    const { declarations, rest } = partitionAttributes({ xmlnsfoo: 'x' })
    expect(declarations).toEqual({})
    expect(rest).toEqual([['xmlnsfoo', 'x']])
  })

  it('no attributes yields no declarations and no rest', () => {
    expect(partitionAttributes({})).toEqual({ declarations: {}, rest: [] })
  })

  it('an xmlns declaration with an empty value is kept, because undeclaring is meaningful', () => {
    expect(partitionAttributes({ xmlns: '' }).declarations).toEqual({ '': '' })
  })

  it('attribute order is preserved, so a mapper can prefer the first of a repeated name', () => {
    const { rest } = partitionAttributes({ a: '1', b: '2', c: '3' })
    expect(rest.map(([name]) => name)).toEqual(['a', 'b', 'c'])
  })
})
