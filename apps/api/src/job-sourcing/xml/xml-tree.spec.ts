/**
 * `xml-tree.ts` directly: the query surface Seam 2 and the Personio helper will live on.
 *
 * Built from hand-written neutral nodes rather than parsed documents, so the helpers' own
 * behaviour is separable from the adapter's. The port-level specs cover the integrated path; this
 * covers the cases a feed does not happen to produce — an element with no children, a text-only
 * node, a namespace selector that matches nothing, deep nesting of the iterative walks.
 */

import { describe, expect, it } from 'vitest'
import type { XmlElementNode, XmlNodeUnion } from './xml-port'
import {
  ANY_NAMESPACE,
  attributeValue,
  childElements,
  collectText,
  findChild,
  findChildren,
  isElement,
  measureTree,
} from './xml-tree'

const text = (value: string): XmlNodeUnion => ({ kind: 'text', value })

function el(
  localName: string,
  options: {
    ns?: string | null
    prefix?: string | null
    children?: XmlNodeUnion[]
    attributes?: { localName: string; ns?: string | null; value: string }[]
    decls?: Record<string, string>
  } = {},
): XmlElementNode {
  const children = options.children ?? []
  return {
    kind: 'element',
    localName,
    prefix: options.prefix ?? null,
    namespaceUri: options.ns ?? null,
    qualifiedName: options.prefix ? `${options.prefix}:${localName}` : localName,
    attributes: (options.attributes ?? []).map((attribute) => ({
      localName: attribute.localName,
      prefix: null,
      namespaceUri: attribute.ns ?? null,
      value: attribute.value,
      qualifiedName: attribute.localName,
    })),
    namespaceDeclarations: options.decls ?? {},
    children,
    text: children.reduce((acc, child) => (child.kind === 'text' ? acc + child.value : acc), ''),
  }
}

const ATOM = 'http://www.w3.org/2005/Atom'
const DC = 'http://purl.org/dc/elements/1.1/'

describe('isElement / childElements', () => {
  it('distinguishes elements from text', () => {
    expect(isElement(el('a'))).toBe(true)
    expect(isElement(text('x'))).toBe(false)
  })

  it('childElements drops text nodes and keeps order', () => {
    const node = el('r', { children: [text('a'), el('x'), text('b'), el('y')] })
    expect(childElements(node).map((child) => child.localName)).toEqual(['x', 'y'])
  })

  it('an element with only text has no child elements', () => {
    expect(childElements(el('r', { children: [text('only')] }))).toEqual([])
  })

  it('an element with no children at all yields an empty list, not undefined', () => {
    expect(childElements(el('r'))).toEqual([])
  })
})

describe('findChildren / findChild', () => {
  const parent = el('r', {
    children: [
      el('item', { ns: null }),
      el('item', { ns: ATOM }),
      el('creator', { ns: DC, prefix: 'dc' }),
      text('ignored'),
    ],
  })

  it('ANY_NAMESPACE matches on local name alone', () => {
    expect(findChildren(parent, 'item', ANY_NAMESPACE)).toHaveLength(2)
  })

  it('ANY_NAMESPACE is the default', () => {
    // Asserted against the explicit form rather than assumed, because changing the default would
    // silently change what every adapter matches.
    expect(findChildren(parent, 'item')).toEqual(findChildren(parent, 'item', ANY_NAMESPACE))
  })

  it('null matches ONLY elements genuinely in no namespace', () => {
    const found = findChildren(parent, 'item', null)
    expect(found).toHaveLength(1)
    expect(found[0]?.namespaceUri).toBeNull()
  })

  it('a URI matches that namespace whatever the prefix', () => {
    const found = findChildren(parent, 'creator', DC)
    expect(found).toHaveLength(1)
    expect(found[0]?.prefix).toBe('dc')
  })

  it('a non-matching namespace yields nothing rather than falling back to any', () => {
    expect(findChildren(parent, 'creator', ATOM)).toEqual([])
    expect(findChildren(parent, 'creator', null)).toEqual([])
  })

  it('a non-matching local name yields nothing', () => {
    expect(findChildren(parent, 'absent')).toEqual([])
  })

  it('findChild returns the FIRST match, and undefined when there is none', () => {
    expect(findChild(parent, 'item')?.namespaceUri).toBeNull()
    expect(findChild(parent, 'absent')).toBeUndefined()
  })

  it('both are direct-children only — a grandchild is not found', () => {
    // The distinction that keeps a feed-level `<link>` out of an entry's links. A descendant
    // search here would merge the two and mis-identify vacancies.
    const grandparent = el('feed', { children: [el('entry', { children: [el('deep')] })] })
    expect(findChild(grandparent, 'deep')).toBeUndefined()
    expect(findChildren(grandparent, 'deep')).toEqual([])
  })
})

describe('attributeValue', () => {
  const guid = el('guid', {
    attributes: [
      { localName: 'isPermaLink', value: 'false' },
      { localName: 'creator', ns: DC, value: 'Acme' },
    ],
  })

  it('finds an unprefixed attribute by default, because it is in NO namespace', () => {
    expect(attributeValue(guid, 'isPermaLink')).toBe('false')
  })

  it('the default is null, not ANY_NAMESPACE', () => {
    // An unprefixed attribute is in no namespace per spec, unlike an unprefixed ELEMENT. A
    // default of "any" would also answer for a same-named attribute from another vocabulary.
    expect(attributeValue(guid, 'creator')).toBeUndefined()
    expect(attributeValue(guid, 'creator', DC)).toBe('Acme')
    expect(attributeValue(guid, 'creator', ANY_NAMESPACE)).toBe('Acme')
  })

  it('an absent attribute is undefined', () => {
    expect(attributeValue(guid, 'absent')).toBeUndefined()
  })

  it('an attribute whose value is the empty string is found, not treated as absent', () => {
    // `''` and `undefined` mean different things to a feed mapper: "declared empty" versus "not
    // declared". A truthiness check inside the helper would collapse them.
    const node = el('i', { attributes: [{ localName: 'rel', value: '' }] })
    expect(attributeValue(node, 'rel')).toBe('')
    expect(attributeValue(node, 'rel')).not.toBeUndefined()
  })

  it('an element with no attributes yields undefined', () => {
    expect(attributeValue(el('bare'), 'anything')).toBeUndefined()
  })
})

describe('collectText', () => {
  it('concatenates descendant text in document order', () => {
    const node = el('r', {
      children: [
        text('a'),
        el('b', { children: [text('B1'), el('c', { children: [text('C')] }), text('B2')] }),
        text('d'),
      ],
    })
    // Order is the substance: a stack-based walk that forgot to reverse its pushes would produce
    // 'adB2CB1' or similar, which still "contains" every fragment.
    expect(collectText(node)).toBe('aB1CB2d')
  })

  it('an element with no text yields the empty string', () => {
    expect(collectText(el('r', { children: [el('a'), el('b')] }))).toBe('')
  })

  it('a leaf with no children yields the empty string', () => {
    expect(collectText(el('r'))).toBe('')
  })

  it('direct `text` and deep `collectText` genuinely differ', () => {
    // Both exist because both are wanted; this is the assertion that they are not the same thing.
    const node = el('item', { children: [text(' '), el('title', { children: [text('T')] })] })
    expect(node.text).toBe(' ')
    expect(collectText(node)).toBe(' T')
  })

  it('survives nesting far deeper than the port allows, so the walk is not recursive', () => {
    let deep = el('leaf', { children: [text('x')] })
    for (let i = 0; i < 20_000; i += 1) deep = el('a', { children: [deep] })
    expect(collectText(deep)).toBe('x')
  })
})

describe('measureTree', () => {
  it('a single element is depth 1, count 1', () => {
    expect(measureTree(el('r'))).toEqual({ maxDepth: 1, elementCount: 1, attributeCount: 0 })
  })

  it('counts every element and reports the DEEPEST branch, not the last', () => {
    // `<r>` with a deep first branch and a shallow second: a walk that overwrote rather than
    // maximised would report 2.
    const node = el('r', {
      children: [el('a', { children: [el('b', { children: [el('c')] })] }), el('d')],
    })
    expect(measureTree(node)).toEqual({ maxDepth: 4, elementCount: 5, attributeCount: 0 })
  })

  it('two branches of EQUAL depth report that depth once, not twice', () => {
    // The `depth > maxDepth` comparison: with `>=` the result is identical, so only an input
    // where a later branch TIES the current maximum can distinguish them... and it cannot, by
    // value. What this test does pin is that a tie does not inflate the answer — which is the
    // behaviour a reader cares about, and the reason the operator is not arbitrary.
    const node = el('r', {
      children: [el('a', { children: [el('a1')] }), el('b', { children: [el('b1')] })],
    })
    expect(measureTree(node)).toEqual({ maxDepth: 3, elementCount: 5, attributeCount: 0 })
  })

  it('a shallower branch AFTER the deepest does not lower the maximum', () => {
    // The direction that is genuinely observable: without the comparison at all, the last
    // branch's depth would win and this would report 2.
    const node = el('r', {
      children: [el('deep', { children: [el('x', { children: [el('y')] })] }), el('shallow')],
    })
    expect(measureTree(node).maxDepth).toBe(4)
  })

  it('text nodes are not counted as elements', () => {
    const node = el('r', { children: [text('a'), el('x'), text('b')] })
    expect(measureTree(node)).toEqual({ maxDepth: 2, elementCount: 2, attributeCount: 0 })
  })

  it('survives nesting far deeper than the port allows', () => {
    let deep = el('leaf')
    for (let i = 0; i < 20_000; i += 1) deep = el('a', { children: [deep] })
    expect(measureTree(deep)).toEqual({ maxDepth: 20_001, elementCount: 20_001, attributeCount: 0 })
  })

  // The attribute total exists to be COMPARED against the pre-scan, so what it must get right is
  // the one thing the two sides disagree about by construction: the pre-scan is a tokenizer and
  // counts an `xmlns` attribute as the attribute it syntactically is, while this tree files
  // declarations onto `namespaceDeclarations` and out of `attributes`. If `measureTree` counted
  // only `attributes`, every namespaced feed in existence — which is every real feed — would
  // raise `PRESCAN_DIFFERENTIAL`. So these cases are about the REUNION, not about counting.
  it('counts attributes across the whole tree', () => {
    const node = el('r', {
      attributes: [{ localName: 'a', value: '1' }],
      children: [
        el('b', {
          attributes: [
            { localName: 'c', value: '2' },
            { localName: 'd', value: '3' },
          ],
        }),
        el('e'),
      ],
    })
    expect(measureTree(node)).toEqual({ maxDepth: 2, elementCount: 3, attributeCount: 3 })
  })

  it('adds namespace declarations back to the attribute total', () => {
    const node = el('r', {
      attributes: [{ localName: 'a', value: '1' }],
      decls: { '': 'http://e/d', p: 'http://e/p' },
    })
    expect(measureTree(node).attributeCount).toBe(3)
  })

  it('an element with neither attributes nor declarations contributes nothing', () => {
    expect(measureTree(el('r', { children: [el('x'), text('t')] })).attributeCount).toBe(0)
  })
})
