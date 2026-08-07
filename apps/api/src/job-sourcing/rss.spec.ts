import { describe, expect, it } from 'vitest'
import { MAX_FEED_BYTES, MAX_ITEMS, decodeXmlEntities, parseRssItems } from './rss'

const feed = (items: string) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>` +
  `<title>Channel title that must NOT be read as an item</title>` +
  `<link>https://jobs.dou.ua/vacancies/</link>${items}</channel></rss>`

describe('parseRssItems', () => {
  it('extracts the five item fields from a DOU-shaped feed', () => {
    const items = parseRssItems(
      feed(
        '<item><title>Senior Engineer (JS) в EPAM, Київ</title>' +
          '<link>https://jobs.dou.ua/companies/epam-systems/vacancies/356562/?utm_source=jobsrss</link>' +
          '<guid isPermaLink="false">https://jobs.dou.ua/companies/epam-systems/vacancies/356562/?1786092518</guid>' +
          '<pubDate>Fri, 07 Aug 2026 11:48:38 +0300</pubDate>' +
          '<description>&lt;p&gt;We are hiring&lt;/p&gt;</description></item>',
      ),
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      title: 'Senior Engineer (JS) в EPAM, Київ',
      link: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562/?utm_source=jobsrss',
      guid: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562/?1786092518',
      pubDate: 'Fri, 07 Aug 2026 11:48:38 +0300',
      description: '<p>We are hiring</p>',
    })
  })

  it('does not read the CHANNEL title as an item', () => {
    const items = parseRssItems(feed('<item><title>Real item</title></item>'))
    expect(items.map((i) => i.title)).toEqual(['Real item'])
  })

  it('handles CDATA without decoding entities inside it', () => {
    const items = parseRssItems(
      feed(
        '<item><title><![CDATA[R&D Lead & more]]></title><description><![CDATA[<p>x</p>]]></description></item>',
      ),
    )
    expect(items[0]?.title).toBe('R&D Lead & more')
    expect(items[0]?.description).toBe('<p>x</p>')
  })

  it('parses several items', () => {
    const items = parseRssItems(
      feed('<item><title>One</title></item><item><title>Two</title></item>'),
    )
    expect(items.map((i) => i.title)).toEqual(['One', 'Two'])
  })

  it('tolerates missing fields instead of throwing', () => {
    const items = parseRssItems(feed('<item><title>Only a title</title></item>'))
    expect(items[0]).toEqual({
      title: 'Only a title',
      link: '',
      guid: '',
      pubDate: '',
      description: '',
    })
  })

  it('returns [] for garbage, empty and non-RSS input', () => {
    expect(parseRssItems('')).toEqual([])
    expect(parseRssItems('not xml at all')).toEqual([])
    expect(parseRssItems('<html><body>404</body></html>')).toEqual([])
    expect(parseRssItems('<rss><channel><item><title>unterminated')).toEqual([])
  })

  it('does not mistake <items> or <itemFoo> for <item>', () => {
    expect(parseRssItems('<channel><items><title>nope</title></items></channel>')).toEqual([])
  })

  it('handles a self-closing description', () => {
    const items = parseRssItems(feed('<item><title>T</title><description/></item>'))
    expect(items[0]?.description).toBe('')
  })

  it('caps the number of items taken from one feed', () => {
    const many = '<item><title>x</title></item>'.repeat(MAX_ITEMS + 50)
    expect(parseRssItems(feed(many))).toHaveLength(MAX_ITEMS)
  })

  it('refuses an over-sized feed body', () => {
    expect(() => parseRssItems('x'.repeat(MAX_FEED_BYTES + 1))).toThrow(/too large/)
  })
})

describe('decodeXmlEntities — hostile input', () => {
  it('decodes the fixed entity set and numeric references', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`,
    )
    expect(decodeXmlEntities('&#75;&#x438;')).toBe('Kи')
  })

  it('does NOT resolve a custom entity a hostile DTD might declare', () => {
    // The XXE / billion-laughs class: there is no code path that resolves an
    // externally declared entity, so it stays literal text.
    expect(decodeXmlEntities('&xxe; &lol9;')).toBe('&xxe; &lol9;')
  })

  it('ignores an out-of-range numeric reference instead of throwing', () => {
    expect(decodeXmlEntities('&#999999999999;')).toBe('&#999999999999;')
    expect(decodeXmlEntities('&#0;')).toBe('&#0;')
  })

  it('ignores a DOCTYPE/ENTITY declaration in a parsed feed', () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<rss><channel><item><title>&xxe;</title></item></channel></rss>'
    const items = parseRssItems(xml)
    expect(items[0]?.title).toBe('&xxe;')
  })
})
