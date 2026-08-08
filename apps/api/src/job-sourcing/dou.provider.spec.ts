import { describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_CATEGORIES,
  DouRssProvider,
  buildDouFeedUrl,
  companyFromDouUrl,
  parseDouTitle,
  stripUnstorableChars,
} from './dou.provider'
import { canonicalizePostingUrl, computePostingFingerprint } from './job-source.provider'
import { MAX_FEED_BYTES, parseRssItems } from './rss'

const provider = new DouRssProvider()

/** A feed body shaped exactly like the live one (verbatim field grammar). */
function douFeed(
  entries: Array<{ title: string; link: string; guid?: string; description?: string }>,
): string {
  const items = entries
    .map(
      (e) =>
        `<item><title>${e.title}</title><link>${e.link}</link>` +
        `<guid isPermaLink="false">${e.guid ?? e.link}</guid>` +
        `<pubDate>Fri, 07 Aug 2026 11:48:38 +0300</pubDate>` +
        `<description>${e.description ?? '&lt;p&gt;desc&lt;/p&gt;'}</description></item>`,
    )
    .join('')
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`
}

describe('buildDouFeedUrl — SSRF surface', () => {
  it('uses the hardcoded feed URL when no category is configured', () => {
    expect(buildDouFeedUrl({})).toBe('https://jobs.dou.ua/vacancies/feeds/')
  })

  it('appends an allow-listed category', () => {
    expect(buildDouFeedUrl({ category: 'JavaScript' })).toBe(
      'https://jobs.dou.ua/vacancies/feeds/?category=JavaScript',
    )
  })

  it('rejects a category that is not allow-listed (no arbitrary query)', () => {
    expect(() => buildDouFeedUrl({ category: 'JavaScript&foo=bar' })).toThrow(/not allow-listed/)
    expect(() => buildDouFeedUrl({ category: '../../admin' })).toThrow(/not allow-listed/)
  })

  it('rejects a non-string category', () => {
    expect(() => buildDouFeedUrl({ category: { evil: true } })).toThrow(/must be a string/)
  })

  it('cannot be pointed at another host by config', () => {
    // There is no code path where config supplies a host — proven by the fact
    // that every produced URL starts with the constant base.
    for (const category of ALLOWED_CATEGORIES) {
      expect(buildDouFeedUrl({ category })).toMatch(/^https:\/\/jobs\.dou\.ua\/vacancies\/feeds\//)
    }
  })
})

describe('parseDouTitle', () => {
  it('splits position / company / locations', () => {
    expect(
      parseDouTitle(
        'Senior Software Test Automation Engineer (JS) в EPAM, Київ, Харків, віддалено',
      ),
    ).toEqual({
      title: 'Senior Software Test Automation Engineer (JS)',
      companyName: 'EPAM',
      location: 'Київ, Харків, віддалено',
    })
  })

  it('keeps a legal suffix attached to the company (Wetelo, Inc.)', () => {
    expect(
      parseDouTitle('Middle JavaScript Full Stack Developer (Node + React) в Wetelo, Inc., Луцьк'),
    ).toEqual({
      title: 'Middle JavaScript Full Stack Developer (Node + React)',
      companyName: 'Wetelo, Inc.',
      location: 'Луцьк',
    })
  })

  it('keeps a parenthesised company sub-name and a salary segment', () => {
    expect(
      parseDouTitle(
        'JS Fullstack Developer (Jun+) в Advanced Software Development (ASD Team), $1100–1300, віддалено',
      ),
    ).toEqual({
      title: 'JS Fullstack Developer (Jun+)',
      companyName: 'Advanced Software Development (ASD Team)',
      location: '$1100–1300, віддалено',
    })
  })

  it('splits on the LAST « в », so a preposition inside the position is safe', () => {
    expect(parseDouTitle('Менеджер з продажу в IT в EPAM, Київ')).toEqual({
      title: 'Менеджер з продажу в IT',
      companyName: 'EPAM',
      location: 'Київ',
    })
  })

  it('handles a company with no location', () => {
    expect(parseDouTitle('Backend Developer в Globex')).toEqual({
      title: 'Backend Developer',
      companyName: 'Globex',
      location: null,
    })
  })

  it('returns an empty company when the title has no « в » separator', () => {
    expect(parseDouTitle('Just a plain title')).toEqual({
      title: 'Just a plain title',
      companyName: '',
      location: null,
    })
  })
})

describe('companyFromDouUrl — fallback', () => {
  it('derives the company from the /companies/<slug>/ path', () => {
    expect(companyFromDouUrl('https://jobs.dou.ua/companies/epam-systems/vacancies/356562')).toBe(
      'epam systems',
    )
  })

  it('returns empty when the path has no company segment', () => {
    expect(companyFromDouUrl('https://jobs.dou.ua/vacancies/356562')).toBe('')
  })
})

describe('canonicalizePostingUrl — the dedupe spine (AC1)', () => {
  it('strips the timestamp query DOU puts on every guid', () => {
    expect(
      canonicalizePostingUrl('https://jobs.dou.ua/companies/epam/vacancies/356562/?1786092518'),
    ).toBe('https://jobs.dou.ua/companies/epam/vacancies/356562')
  })

  it('strips utm parameters, fragments and the trailing slash', () => {
    const a = canonicalizePostingUrl(
      'https://jobs.dou.ua/companies/epam/vacancies/356562/?utm_source=jobsrss#top',
    )
    const b = canonicalizePostingUrl('https://jobs.dou.ua/companies/epam/vacancies/356562')
    expect(a).toBe(b)
  })

  it('lowercases the host', () => {
    expect(canonicalizePostingUrl('https://JOBS.DOU.UA/x/1')).toBe('https://jobs.dou.ua/x/1')
  })

  it('rejects javascript:, data: and http: URLs', () => {
    expect(canonicalizePostingUrl('javascript:alert(1)')).toBeNull()
    expect(canonicalizePostingUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(canonicalizePostingUrl('http://jobs.dou.ua/x/1')).toBeNull()
    expect(canonicalizePostingUrl('not a url')).toBeNull()
    expect(canonicalizePostingUrl(null)).toBeNull()
  })
})

describe('computePostingFingerprint', () => {
  it('is stable for the same canonical url', () => {
    const a = computePostingFingerprint('DOU_RSS', 'https://jobs.dou.ua/x/1')
    const b = computePostingFingerprint('DOU_RSS', 'https://jobs.dou.ua/x/1')
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })

  it('differs for different postings', () => {
    expect(computePostingFingerprint('DOU_RSS', 'https://jobs.dou.ua/x/1')).not.toBe(
      computePostingFingerprint('DOU_RSS', 'https://jobs.dou.ua/x/2'),
    )
  })
})

describe('stripUnstorableChars (MED-2)', () => {
  it('removes NUL bytes and leaves everything else alone', () => {
    expect(stripUnstorableChars('a\u0000b')).toBe('ab')
    expect(stripUnstorableChars('\u0000\u0000')).toBe('')
    expect(stripUnstorableChars('Київ — EPAM, $1100–1300')).toBe('Київ — EPAM, $1100–1300')
  })
})

describe('fetchFeed size cap (MED-1)', () => {
  /** Streams `total` bytes in 64 KiB chunks, counting what was actually pulled. */
  function streamingResponse(total: number, onPull: (sent: number) => void): Response {
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close()
          return
        }
        const size = Math.min(64 * 1024, total - sent)
        sent += size
        onPull(sent)
        controller.enqueue(new Uint8Array(size))
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
  }

  it('aborts mid-download instead of buffering a huge body first', async () => {
    let pulled = 0
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(streamingResponse(MAX_FEED_BYTES * 8, (s) => (pulled = s)))

    await expect(new DouRssProvider().collect({})).rejects.toThrow(/too large/)

    // The point of the fix: we stopped early. A `response.text()` implementation
    // would have pulled all 16 MiB before any check ran.
    //
    // Tolerance is TWO chunks, not one: a ReadableStream keeps one chunk queued
    // ahead of the reader (measured — the overshoot is exactly 2 × 64 KiB), so
    // demanding a tighter bound would be asserting against stream backpressure
    // rather than against our own check.
    expect(pulled).toBeLessThanOrEqual(MAX_FEED_BYTES + 2 * 64 * 1024)
    // …and, the part that actually matters, nowhere near the full body.
    expect(pulled).toBeLessThan(MAX_FEED_BYTES * 2)
    fetchMock.mockRestore()
  })

  it('rejects up front when content-length already exceeds the cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(MAX_FEED_BYTES + 1) },
      }),
    )

    await expect(new DouRssProvider().collect({})).rejects.toThrow(/content-length/)
    fetchMock.mockRestore()
  })

  it('accepts a normal-sized feed', async () => {
    const body = douFeed([
      { title: 'Dev в EPAM, Київ', link: 'https://jobs.dou.ua/companies/epam/vacancies/1/' },
    ])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200 }))

    const postings = await new DouRssProvider().collect({})
    expect(postings).toHaveLength(1)
    expect(postings[0]?.companyName).toBe('EPAM')
    fetchMock.mockRestore()
  })

  it('throws on a non-200 response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 503, statusText: 'Service Unavailable' }))

    await expect(new DouRssProvider().collect({})).rejects.toThrow(/503/)
    fetchMock.mockRestore()
  })
})

describe('DouRssProvider.normalize', () => {
  it('normalizes a realistic feed entry end to end', () => {
    const xml = douFeed([
      {
        title: 'Senior Frontend Engineer в EPAM, Київ, віддалено',
        link: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562/?utm_source=jobsrss',
        guid: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562/?1786092518',
        description: '&lt;p&gt;We are &lt;strong&gt;hiring&lt;/strong&gt;&lt;/p&gt;',
      },
    ])
    const [posting] = provider.normalize(parseRssItems(xml))

    expect(posting).toMatchObject({
      sourceType: 'DOU_RSS',
      url: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562',
      externalId: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562',
      title: 'Senior Frontend Engineer',
      companyName: 'EPAM',
      companyNameNormalized: 'epam',
      location: 'Київ, віддалено',
      descriptionMd: 'We are **hiring**',
    })
    expect(posting?.publishedAt).toBeInstanceOf(Date)
  })

  it('gives the SAME fingerprint on a re-fetch whose guid timestamp changed (AC1)', () => {
    const first = provider.normalize(
      parseRssItems(
        douFeed([
          {
            title: 'Dev в EPAM, Київ',
            link: 'https://jobs.dou.ua/companies/epam/vacancies/1/?utm_source=jobsrss',
            guid: 'https://jobs.dou.ua/companies/epam/vacancies/1/?1111111111',
          },
        ]),
      ),
    )
    const second = provider.normalize(
      parseRssItems(
        douFeed([
          {
            title: 'Dev в EPAM, Київ',
            link: 'https://jobs.dou.ua/companies/epam/vacancies/1/?utm_source=jobsrss',
            guid: 'https://jobs.dou.ua/companies/epam/vacancies/1/?9999999999',
          },
        ]),
      ),
    )
    expect(second[0]?.fingerprint).toBe(first[0]?.fingerprint)
  })

  it('falls back to the URL slug when the title has no company', () => {
    const [posting] = provider.normalize(
      parseRssItems(
        douFeed([
          {
            title: 'Plain title with no separator',
            link: 'https://jobs.dou.ua/companies/soft-serve/vacancies/9/',
          },
        ]),
      ),
    )
    expect(posting?.companyName).toBe('soft serve')
    expect(posting?.companyNameNormalized).toBe('soft serve')
  })

  it('skips an entry with a non-https link instead of failing the batch', () => {
    const postings = provider.normalize(
      parseRssItems(
        douFeed([
          { title: 'Evil в Hacker', link: 'javascript:alert(1)', guid: 'javascript:alert(1)' },
          { title: 'Good в EPAM, Київ', link: 'https://jobs.dou.ua/companies/epam/vacancies/2/' },
        ]),
      ),
    )
    expect(postings).toHaveLength(1)
    expect(postings[0]?.companyName).toBe('EPAM')
  })

  it('skips an entry with neither a title nor a company', () => {
    expect(
      provider.normalize(
        parseRssItems(douFeed([{ title: '', link: 'https://jobs.dou.ua/vacancies/7/' }])),
      ),
    ).toEqual([])
  })

  it('stores the description as markdown with no HTML', () => {
    const [posting] = provider.normalize(
      parseRssItems(
        douFeed([
          {
            title: 'Dev в EPAM, Київ',
            link: 'https://jobs.dou.ua/companies/epam/vacancies/3/',
            description: '&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;Real text&lt;/p&gt;',
          },
        ]),
      ),
    )
    expect(posting?.descriptionMd).toContain('Real text')
    expect(posting?.descriptionMd).not.toContain('alert')
  })
})
