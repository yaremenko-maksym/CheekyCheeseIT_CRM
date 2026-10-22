import { describe, expect, it } from 'vitest'
import { fixtureBytes, utf8 } from '../../test/xml-corpus'
import { xmlPort } from '../xml'
import { readFeed } from './read-feed'

/**
 * Seam 2 — feed semantics over the neutral tree. Every expectation below is taken from the format
 * specifications (RSS 2.0, RSS 1.0, RFC 4287 Atom) or read off the fixture by hand, never computed
 * the way `readFeed` computes it.
 *
 * Acceptance first — what a well-formed feed yields — then the refusals: a document that is XML but
 * not a feed is DRIFT, and a feed with no items is a valid empty feed, not drift.
 */

const unwrap = (result: ReturnType<typeof readFeed>) => {
  if (!result.ok) throw new Error(`expected a feed, got drift: ${result.reason}`)
  return result.feed
}
const feedOf = (xml: string) => unwrap(readFeed(xmlPort.parseDocument(utf8(xml))))
const fixture = (name: string) => unwrap(readFeed(xmlPort.parseDocument(fixtureBytes(name))))

describe('RSS 2.0', () => {
  it('reads every field of an item, entities decoded and CDATA unwrapped', () => {
    const feed = fixture('rss-cdata-entities.xml')

    expect(feed.format).toBe('RSS_2')
    expect(feed.title).toBe('Example & Co jobs')
    expect(feed.entries).toHaveLength(2)
    expect(feed.entries[0]).toEqual({
      guid: 'opaque-id-001',
      link: 'https://example.com/jobs/1?utm_source=feed',
      title: 'Backend Dev <Node> & Postgres',
      summary: '<p>Build <b>APIs</b></p>',
      content: null,
      authors: ['Acme'],
      categories: [],
      dates: [
        { raw: 'Fri, 07 Aug 2026 11:48:38 +0300', contract: 'RFC_2822', semantics: 'PUBLISHED' },
      ],
    })
  })

  it('keeps a permalink guid verbatim — it is identity, not the link', () => {
    const entry = fixture('rss-cdata-entities.xml').entries[1]

    // The guid and the link differ by a query string; neither is derived from the other.
    expect(entry?.guid).toBe('https://example.com/jobs/2')
    expect(entry?.link).toBe('https://example.com/jobs/2?utm_source=feed')
  })

  it('uses a permalink guid as the link when the item has no <link>', () => {
    const feed = feedOf(
      '<rss version="2.0"><channel><item><title>T</title><guid>https://example.com/j/9</guid></item></channel></rss>',
    )
    expect(feed.entries[0]?.link).toBe('https://example.com/j/9')
  })

  it('treats an explicit isPermaLink="true" like the default', () => {
    const feed = feedOf(
      '<rss version="2.0"><channel><item><guid isPermaLink="true">https://example.com/j/9</guid></item></channel></rss>',
    )
    expect(feed.entries[0]?.link).toBe('https://example.com/j/9')
  })

  it('never uses an isPermaLink="false" guid as a link, however much it looks like one', () => {
    const feed = feedOf(
      '<rss version="2.0"><channel><item><title>T</title><guid isPermaLink="false">https://example.com/j/9</guid></item></channel></rss>',
    )
    expect(feed.entries[0]?.guid).toBe('https://example.com/j/9')
    expect(feed.entries[0]?.link).toBeNull()
  })

  it('reads content:encoded by namespace URI, whatever the prefix', () => {
    const feed = fixture('boards-synthetic.xml')
    expect(feed.entries[0]?.content).toBe('<p>Rust, tokio, <i>async</i></p>')
  })

  it('finds items inside a container element, in document order', () => {
    const feed = fixture('boards-synthetic.xml')
    expect(feed.entries.map((entry) => entry.guid)).toEqual(['rust-1', 'broken-2', 'rust-1'])
    // The partial group: the member with no link is still an entry, with its link absent.
    expect(feed.entries[1]?.link).toBeNull()
  })

  it('does not look for items inside an item', () => {
    const feed = feedOf(
      '<rss version="2.0"><channel><item><guid>a</guid><item><guid>b</guid></item></item></channel></rss>',
    )
    expect(feed.entries.map((entry) => entry.guid)).toEqual(['a'])
  })

  it('collects every author and category, both RSS author and dc:creator', () => {
    const feed =
      feedOf(`<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item>
      <author>jobs@example.com (Jobs)</author><dc:creator>Acme</dc:creator><dc:creator>Beta</dc:creator>
      <category>Rust</category><category> Remote </category>
    </item></channel></rss>`)
    expect(feed.entries[0]?.authors).toEqual(['jobs@example.com (Jobs)', 'Acme', 'Beta'])
    expect(feed.entries[0]?.categories).toEqual(['Rust', 'Remote'])
  })

  it('reads a dc:date as an ISO date', () => {
    const feed = feedOf(
      '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><dc:date>2026-10-01T09:00:00Z</dc:date></item></channel></rss>',
    )
    expect(feed.entries[0]?.dates).toEqual([
      { raw: '2026-10-01T09:00:00Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
    ])
  })

  it('trims fields and turns a blank one into null rather than an empty string', () => {
    const feed = feedOf(
      '<rss version="2.0"><channel><title>  </title><item><title>  Dev  </title><guid isPermaLink="false">  g-1  </guid><link> </link><description></description><pubDate> </pubDate><author> </author><category/></item></channel></rss>',
    )
    expect(feed.title).toBeNull()
    expect(feed.entries[0]).toEqual({
      guid: 'g-1',
      link: null,
      title: 'Dev',
      summary: null,
      content: null,
      authors: [],
      categories: [],
      dates: [],
    })
  })

  it('a well-formed channel with no items is a valid EMPTY feed, not drift', () => {
    const feed = fixture('rss-empty.xml')
    expect(feed.format).toBe('RSS_2')
    expect(feed.entries).toEqual([])
  })

  it('ignores RSS element names that arrive in a foreign namespace', () => {
    const feed = feedOf(
      '<rss version="2.0" xmlns:x="urn:x"><channel><x:item><guid>a</guid></x:item><item><x:title>No</x:title><guid>b</guid></item></channel></rss>',
    )
    expect(feed.entries.map((entry) => entry.guid)).toEqual(['b'])
    expect(feed.entries[0]?.title).toBeNull()
  })
})

describe('Atom (RFC 4287)', () => {
  it('reads id as the guid, the alternate link, every author and namespaced content', () => {
    const feed = fixture('atom-namespaced.xml')

    expect(feed.format).toBe('ATOM')
    expect(feed.title).toBe('Example Jobs')
    expect(feed.entries).toHaveLength(1)
    expect(feed.entries[0]).toMatchObject({
      guid: 'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a',
      // rel="alternate", not rel="related" and not the later rel-less link.
      link: 'https://example.com/job/1',
      title: 'Senior Platform Engineer',
      authors: ['Hiring Bot', 'Jane Recruiter'],
      content: '<p>Senior <b>Dev</b></p>',
    })
  })

  it('treats a link with no rel as the alternate link (RFC 4287 §4.2.7.2)', () => {
    const feed = feedOf(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>e</id><link rel="self" href="https://example.com/self"/><link href="https://example.com/j/1"/></entry></feed>',
    )
    expect(feed.entries[0]?.link).toBe('https://example.com/j/1')
  })

  it('has no link when the only links are not alternates', () => {
    const feed = feedOf(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>e</id><link rel="related" href="https://example.com/c"/></entry></feed>',
    )
    expect(feed.entries[0]?.link).toBeNull()
  })

  it('reads atom:content, atom:summary, categories by term, and both dates', () => {
    const feed = feedOf(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>e</id>
      <summary>Short</summary><content type="html">&lt;p&gt;Long&lt;/p&gt;</content>
      <category term="rust"/><category term=" "/>
      <published>2026-10-01T09:00:00Z</published><updated>2026-10-02T09:00:00Z</updated>
    </entry></feed>`)
    expect(feed.entries[0]).toMatchObject({
      summary: 'Short',
      content: '<p>Long</p>',
      categories: ['rust'],
      dates: [
        { raw: '2026-10-01T09:00:00Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
        { raw: '2026-10-02T09:00:00Z', contract: 'ISO_ZONED', semantics: 'UPDATED' },
      ],
    })
  })

  it('an Atom feed with no entries is a valid empty feed', () => {
    const feed = feedOf('<feed xmlns="http://www.w3.org/2005/Atom"><title>None</title></feed>')
    expect(feed).toEqual({ format: 'ATOM', title: 'None', entries: [] })
  })
})

describe('RSS 1.0 (RDF)', () => {
  const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://example.com/"><title>RDF jobs</title></channel>
    <item rdf:about="https://example.com/j/1"><title>One</title><link>https://example.com/j/1?ref=rss</link><dc:date>2026-10-01T09:00:00Z</dc:date></item>
  </rdf:RDF>`

  it('reads items as children of the root, rdf:about as the guid', () => {
    const feed = feedOf(rdf)
    expect(feed.format).toBe('RSS_1')
    expect(feed.title).toBe('RDF jobs')
    expect(feed.entries).toEqual([
      {
        guid: 'https://example.com/j/1',
        link: 'https://example.com/j/1?ref=rss',
        title: 'One',
        summary: null,
        content: null,
        authors: [],
        categories: [],
        dates: [{ raw: '2026-10-01T09:00:00Z', contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
      },
    ])
  })
})

describe('a document that is XML but not a feed is drift', () => {
  it('names the root it refused, by expanded name', () => {
    expect(readFeed(xmlPort.parseDocument(utf8('<html xmlns="urn:h"/>')))).toEqual({
      ok: false,
      reason: 'the document root {urn:h}html is not RSS 2.0, RSS 1.0 or Atom',
    })
    expect(readFeed(xmlPort.parseDocument(utf8('<html/>')))).toEqual({
      ok: false,
      reason: 'the document root {}html is not RSS 2.0, RSS 1.0 or Atom',
    })
  })

  it('names the missing channel', () => {
    expect(readFeed(xmlPort.parseDocument(utf8('<rss/>')))).toEqual({
      ok: false,
      reason: 'an <rss> document with no <channel>',
    })
    expect(
      readFeed(
        xmlPort.parseDocument(
          utf8('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>'),
        ),
      ),
    ).toEqual({ ok: false, reason: 'an rdf:RDF document with no RSS 1.0 <channel>' })
  })

  it.each([
    ['an HTML page', '<html><body>Blocked</body></html>'],
    ['an RSS root with no channel', '<rss version="2.0"><item><guid>a</guid></item></rss>'],
    ['an RSS root in a namespace', '<rss xmlns="urn:not-rss"><channel/></rss>'],
    ['a feed root outside the Atom namespace', '<feed><entry><id>a</id></entry></feed>'],
    [
      'an RDF root with no RSS 1.0 channel',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>',
    ],
    ['an RDF-named root outside the RDF namespace', '<RDF><channel/></RDF>'],
  ])('%s', (_label, xml) => {
    const result = readFeed(xmlPort.parseDocument(utf8(xml)))
    expect(result.ok).toBe(false)
  })
})
