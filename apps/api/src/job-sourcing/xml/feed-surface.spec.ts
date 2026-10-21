/**
 * The functional surface Task 2.4 names, proven through `XmlPort` before Seam 2 exists.
 *
 * WHY HERE AND NOT IN THE FEED PORT
 * ---------------------------------
 * `FeedPort.parseFeed` ships with the `RssProvider` base, once Task 2.3 lands `CollectionBatch`.
 * But the plan's functional list — namespaces, CDATA, explicit encodings, RSS `guid` including
 * `isPermaLink="false"`, Atom `id` and `link` relations, `content:encoded`, multiple authors — is a
 * list of things the PORT has to make reachable. If any of them is not reachable from
 * `XmlDocument`, the feed layer cannot invent it later, and the gap would be discovered in 2.4b
 * with the seam already built. So each item is extracted here using only the published query
 * helpers, and 2.4b inherits a demonstrated surface rather than a promised one.
 *
 * NAMESPACE RESOLUTION IS THE PART THAT IS OURS
 * ---------------------------------------------
 * `@rgrove/parse-xml` does NOT resolve namespace URIs: element names keep their literal prefix
 * (`content:encoded`) and `xmlns` declarations arrive as ordinary attributes. Neither candidate
 * parser does better — `fast-xml-parser`'s only namespace feature, `removeNSPrefix`, discards the
 * information entirely. So prefix→URI mapping is wrapper work, priced into the ADR rather than
 * hidden, and the fixtures below are built to fail a prefix-matching implementation: the Atom
 * fixture binds the content module to the prefix `c`, not the conventional `content`.
 */

import { describe, expect, it } from 'vitest'
import { fixtureBytes, utf8 } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { FEED_NAMESPACES, XML_NAMESPACE } from './namespaces'
import type { XmlElementNode } from './xml-port'
import { XmlPortError } from './xml-port'
import { ANY_NAMESPACE, attributeValue, collectText, findChild, findChildren } from './xml-tree'

const port = new BoundedXmlPort()

const atomEntry = (): XmlElementNode => {
  const document = port.parseDocument(fixtureBytes('atom-namespaced.xml'))
  return findChild(document.root, 'entry', FEED_NAMESPACES.atom) as XmlElementNode
}

const rssItems = (): readonly XmlElementNode[] => {
  const document = port.parseDocument(fixtureBytes('rss-cdata-entities.xml'))
  const channel = findChild(document.root, 'channel', null) as XmlElementNode
  return findChildren(channel, 'item', null)
}

describe('namespaces are resolved to URIs, not matched by prefix', () => {
  it('a default namespace reaches the elements that inherit it', () => {
    const document = port.parseDocument(fixtureBytes('atom-namespaced.xml'))
    expect(document.root.localName).toBe('feed')
    expect(document.root.namespaceUri).toBe(FEED_NAMESPACES.atom)
    expect(document.root.prefix).toBeNull()
    // The child declares nothing and must still be in the Atom namespace.
    expect(atomEntry().namespaceUri).toBe(FEED_NAMESPACES.atom)
  })

  it('content:encoded is found by URI even though the fixture calls the prefix `c`', () => {
    // THE discriminating assertion for this file. A mapper matching the literal `content:` finds
    // nothing here; one resolving the URI finds it. Feeds are genuinely inconsistent about the
    // prefix, so this is the real-world case and not a contrived one.
    const encoded = findChild(atomEntry(), 'encoded', FEED_NAMESPACES.content)
    expect(encoded).toBeDefined()
    expect(encoded?.prefix).toBe('c')
    expect(encoded?.qualifiedName).toBe('c:encoded')
  })

  it('NEGATIVE CONTROL: the conventional prefix is genuinely absent from the MARKUP', () => {
    // Without this, the assertion above could be passing because both spellings exist in the
    // fixture. Asserted over the parsed tree rather than the raw bytes, and that is not a
    // convenience: the first version grepped the file and went red on the fixture's own
    // explanatory COMMENT, which mentions `content:encoded` in prose. A test that fails when
    // someone explains the fixture trains people to delete the explanation.
    const document = port.parseDocument(fixtureBytes('atom-namespaced.xml'))
    const names: string[] = []
    const walk = (node: XmlElementNode): void => {
      names.push(node.qualifiedName)
      for (const child of node.children) if (child.kind === 'element') walk(child)
    }
    walk(document.root)
    expect(names).not.toContain('content:encoded')
    expect(names).toContain('c:encoded')
  })

  it('a prefix declared mid-document is scoped to its own subtree', () => {
    const div = findChild(atomEntry(), 'div', 'http://www.w3.org/1999/xhtml')
    expect(div).toBeDefined()
    // Its sibling, which did not declare xhtml, is in the Atom namespace — so the scope did not
    // leak upward or sideways.
    expect(findChild(atomEntry(), 'title', FEED_NAMESPACES.atom)).toBeDefined()
  })

  it('xmlns declarations are kept OUT of `attributes` and reachable separately', () => {
    const document = port.parseDocument(fixtureBytes('atom-namespaced.xml'))
    // An adapter iterating `<feed>`'s attributes must not be handed namespace URIs as if they
    // were feed data — and an adapter that forgets to skip them would emit one as a field.
    expect(document.root.attributes).toHaveLength(0)
    expect(document.root.namespaceDeclarations).toEqual({
      '': FEED_NAMESPACES.atom,
      c: FEED_NAMESPACES.content,
    })
  })

  it('an undeclared prefix is namespace-ill-formed, with its own reason', () => {
    let raised: unknown
    try {
      port.parseDocument(utf8('<r><ghost:title>x</ghost:title></r>'))
    } catch (error) {
      raised = error
    }
    // Distinct from MALFORMED: the document IS well-formed XML, it is only namespace-ill-formed,
    // and a caller triaging feeds wants to tell those apart.
    expect((raised as XmlPortError).reason).toBe('UNDECLARED_PREFIX')
  })

  it('the reserved `xml` prefix resolves without being declared', () => {
    const document = port.parseDocument(utf8('<r xml:lang="uk"><t>x</t></r>'))
    expect(attributeValue(document.root, 'lang', XML_NAMESPACE)).toBe('uk')
  })

  it('xmlns="" puts an element back in no namespace', () => {
    const document = port.parseDocument(
      utf8(`<feed xmlns="${FEED_NAMESPACES.atom}"><bare xmlns=""><t>x</t></bare></feed>`),
    )
    const bare = findChild(document.root, 'bare', null)
    expect(bare).toBeDefined()
    expect(bare?.namespaceUri).toBeNull()
    // And the undeclaration is inherited by its child, which declares nothing of its own.
    expect(findChild(bare as XmlElementNode, 't', null)?.namespaceUri).toBeNull()
  })
})

describe('RSS guid is opaque identity', () => {
  it('isPermaLink="false" is readable, and the value is NOT treated as a URL', () => {
    const guid = findChild(rssItems()[0] as XmlElementNode, 'guid', null)
    expect(guid?.text).toBe('opaque-id-001')
    expect(attributeValue(guid as XmlElementNode, 'isPermaLink')).toBe('false')
  })

  it('isPermaLink="true" is a distinct, readable value — not an absent attribute', () => {
    // Both sides, because a helper returning `undefined` for everything would satisfy the first
    // assertion alone, and the feed layer has to distinguish three states: true, false, absent.
    const guid = findChild(rssItems()[1] as XmlElementNode, 'guid', null)
    expect(attributeValue(guid as XmlElementNode, 'isPermaLink')).toBe('true')
    expect(guid?.text).toBe('https://example.com/jobs/2')
  })

  it('the GUID/URL mismatch case survives the port intact', () => {
    // The plan names this explicitly: guid identity and `<link>` can disagree, and the port must
    // not reconcile them. Both values come through verbatim for the feed layer to decide about.
    const item = rssItems()[0] as XmlElementNode
    expect(findChild(item, 'guid', null)?.text).toBe('opaque-id-001')
    expect(findChild(item, 'link', null)?.text).toBe('https://example.com/jobs/1?utm_source=feed')
  })

  it('an unprefixed attribute is in NO namespace even beside prefixed vocabularies', () => {
    // `attributeValue` defaults to `null` for this reason. Asked for "any namespace" it would
    // also answer for a `dc:isPermaLink` from an unrelated vocabulary.
    const guid = findChild(rssItems()[0] as XmlElementNode, 'guid', null) as XmlElementNode
    expect(guid.attributes[0]?.namespaceUri).toBeNull()
    expect(attributeValue(guid, 'isPermaLink', FEED_NAMESPACES.dublinCore)).toBeUndefined()
  })
})

describe('Atom id and link relations', () => {
  it('the entry id is preserved verbatim', () => {
    expect(findChild(atomEntry(), 'id', FEED_NAMESPACES.atom)?.text).toBe(
      'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a',
    )
  })

  it('every link is reachable with its rel, including the one with no rel at all', () => {
    const links = findChildren(atomEntry(), 'link', FEED_NAMESPACES.atom)
    expect(
      links.map((link) => [attributeValue(link, 'rel'), attributeValue(link, 'href')]),
    ).toEqual([
      ['alternate', 'https://example.com/job/1'],
      ['related', 'https://example.com/company/acme'],
      // Atom defaults a missing rel to "alternate", but that is FEED semantics and belongs to
      // Seam 2. The port reports absence as absence rather than inventing the default here.
      [undefined, 'https://example.com/job/1/apply'],
    ])
  })

  it('the feed-level self link is not confused with the entry-level links', () => {
    const document = port.parseDocument(fixtureBytes('atom-namespaced.xml'))
    // `findChildren` is direct children only — so a feed-level `<link>` must not appear among the
    // entry's. A helper that searched descendants would merge the two and mis-identify vacancies.
    const feedLinks = findChildren(document.root, 'link', FEED_NAMESPACES.atom)
    expect(feedLinks.map((link) => attributeValue(link, 'rel'))).toEqual(['self'])
  })
})

describe('content:encoded, CDATA and multiple authors', () => {
  it('CDATA arrives as text with its markup inert', () => {
    const encoded = findChild(atomEntry(), 'encoded', FEED_NAMESPACES.content) as XmlElementNode
    expect(encoded.text).toBe('<p>Senior <b>Dev</b></p>')
    // Inert means TEXT, not structure: the `<b>` inside must not have become an element.
    expect(encoded.children.every((child) => child.kind === 'text')).toBe(true)
  })

  it('both authors are present, in document order', () => {
    const authors = findChildren(atomEntry(), 'author', FEED_NAMESPACES.atom)
    expect(authors.map((author) => findChild(author, 'name', FEED_NAMESPACES.atom)?.text)).toEqual([
      'Hiring Bot',
      'Jane Recruiter',
    ])
  })

  it('the five predefined entities are decoded', () => {
    const items = rssItems()
    expect(findChild(items[0] as XmlElementNode, 'title', null)?.text).toBe(
      'Backend Dev <Node> & Postgres',
    )
    expect(findChild(items[1] as XmlElementNode, 'description', null)?.text).toBe(
      'Plain "quoted" text with an apostrophe\'s entity',
    )
  })

  it('CDATA markup inside a description stays text there too', () => {
    const description = findChild(rssItems()[0] as XmlElementNode, 'description', null)
    expect(description?.text).toBe('<p>Build <b>APIs</b></p>')
  })

  it('`text` is direct children only; `collectText` is the deep reading', () => {
    // Both exist because both are wanted, and conflating them is a silent bug: an `<item>`'s own
    // text should be whitespace, not a run-together of every field it contains.
    const item = rssItems()[0] as XmlElementNode
    expect(item.text.trim()).toBe('')
    expect(collectText(item)).toContain('Backend Dev <Node> & Postgres')
    expect(collectText(item)).toContain('opaque-id-001')
  })

  it('a repeated element the spec calls singular yields the first, not an error', () => {
    // A sloppy feed must not fail a whole collection. `findChildren` is there for callers that
    // care that there is exactly one.
    const document = port.parseDocument(utf8('<r><t>first</t><t>second</t></r>'))
    expect(findChild(document.root, 't')?.text).toBe('first')
    expect(findChildren(document.root, 't')).toHaveLength(2)
  })

  it('ANY_NAMESPACE matches across vocabularies; a URI does not', () => {
    const item = rssItems()[0] as XmlElementNode
    // `dc:creator` is in the Dublin Core namespace. Searching "any" finds it; searching the
    // no-namespace RSS vocabulary must not.
    expect(findChild(item, 'creator', ANY_NAMESPACE)?.text).toBe('Acme')
    expect(findChild(item, 'creator', null)).toBeUndefined()
    expect(findChild(item, 'creator', FEED_NAMESPACES.dublinCore)?.text).toBe('Acme')
  })
})

describe('the partial-group and updated-description shapes 2.4b will need', () => {
  it('a group whose one member lacks a link still yields the other member intact', () => {
    // The plan's "partial group": one bad member must not void the rest. The port's job is to
    // deliver both faithfully; isolating the bad one is Seam 2's.
    const document = port.parseDocument(fixtureBytes('boards-synthetic.xml'))
    const channel = findChild(document.root, 'channel', null) as XmlElementNode
    const group = findChild(channel, 'group', null) as XmlElementNode
    const members = findChildren(group, 'item', null)
    expect(members).toHaveLength(2)
    expect(findChild(members[0] as XmlElementNode, 'link', null)?.text).toBe(
      'https://example.org/jobs/rust-1',
    )
    expect(findChild(members[1] as XmlElementNode, 'link', null)).toBeUndefined()
  })

  it('the same native id twice with different descriptions comes through as two items', () => {
    // The "updated descriptions" case. Collapsing them is an identity decision, which belongs to
    // the observation seam — so the port must NOT deduplicate.
    const document = port.parseDocument(fixtureBytes('boards-synthetic.xml'))
    const channel = findChild(document.root, 'channel', null) as XmlElementNode
    const group = findChild(channel, 'group', null) as XmlElementNode
    const standalone = findChildren(channel, 'item', null)
    const first = findChildren(group, 'item', null)[0] as XmlElementNode
    expect(findChild(first, 'guid', null)?.text).toBe('rust-1')
    expect(findChild(standalone[0] as XmlElementNode, 'guid', null)?.text).toBe('rust-1')
    expect(
      findChild(standalone[0] as XmlElementNode, 'encoded', FEED_NAMESPACES.content)?.text,
    ).toContain('Postgres')
    expect(findChild(first, 'encoded', FEED_NAMESPACES.content)?.text).not.toContain('Postgres')
  })
})
