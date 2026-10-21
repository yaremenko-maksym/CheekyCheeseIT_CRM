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
  NamespaceScope,
  partitionAttributes,
  splitQName,
  XML_NAMESPACE,
  XMLNS_NAMESPACE,
} from './namespaces'

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

  it.each([
    // Each of these is namespace-ill-formed. Returning the name WHOLE as the local name means the
    // caller resolves it against the default namespace and gets a clean failure, rather than us
    // inventing a prefix out of a fragment and producing a confusing one.
    [':leading', ':leading'],
    ['trailing:', 'trailing:'],
    ['a:b:c', 'a:b:c'],
    [':', ':'],
  ])('%s is not a legal QName and is kept whole', (input, expected) => {
    expect(splitQName(input)).toEqual({ prefix: null, localName: expected })
  })

  it('the empty name is kept whole rather than crashing', () => {
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
    expect(root.lookup('xml')).toBe(XML_NAMESPACE)
    expect(root.lookup('xmlns')).toBe(XMLNS_NAMESPACE)
  })

  it('reserved prefixes win even against a declaration that tries to rebind them', () => {
    // XML forbids rebinding `xml`. Honouring an attempt would let a feed redefine `xml:lang`.
    const scope = NamespaceScope.root().child({ xml: 'http://evil.example/' })
    expect(scope.lookup('xml')).toBe(XML_NAMESPACE)
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
