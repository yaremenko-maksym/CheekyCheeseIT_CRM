import { describe, expect, it } from 'vitest'
import { buildNormalizedPosting, parseDateish } from './build-posting'

describe('parseDateish', () => {
  it('reads unix seconds, milliseconds, ISO strings; rejects garbage', () => {
    expect(parseDateish(1_760_000_000)?.toISOString()).toBe('2025-10-09T08:53:20.000Z')
    expect(parseDateish(1_760_000_000_000)?.toISOString()).toBe('2025-10-09T08:53:20.000Z')
    expect(parseDateish('2026-10-04T10:00:00Z')?.toISOString()).toBe('2026-10-04T10:00:00.000Z')
    expect(parseDateish('not a date')).toBeNull()
    expect(parseDateish(undefined)).toBeNull()
  })
})

describe('parseDateish boundaries', () => {
  it('null is "no date", not the epoch', () => {
    expect(parseDateish(null)).toBeNull()
  })
  it('1e12 is the first millisecond value; just below is seconds', () => {
    expect(parseDateish(1e12)?.toISOString()).toBe('2001-09-09T01:46:40.000Z')
    expect(parseDateish(1e12 - 1)?.toISOString()).toBe('+033658-09-27T01:46:39.000Z')
  })
  it('numeric strings are NOT treated as unix seconds', () => {
    expect(parseDateish('1760000000')).toBeNull()
  })
  it('passes a Date through', () => {
    const d = new Date('2026-01-02T03:04:05Z')
    expect(parseDateish(d)?.toISOString()).toBe('2026-01-02T03:04:05.000Z')
  })
})

describe('buildNormalizedPosting publishedAt typing', () => {
  const base = { url: 'https://x.test/j/1', title: 'T', companyName: 'C' }
  const at = (publishedAt: unknown) =>
    buildNormalizedPosting('REMOTEOK_API', { ...base, publishedAt } as never)!.publishedAt
  it('accepts Date, ISO string and number', () => {
    expect(at(new Date('2026-01-02T03:04:05Z'))?.toISOString()).toBe('2026-01-02T03:04:05.000Z')
    expect(at('2026-01-02T03:04:05Z')?.toISOString()).toBe('2026-01-02T03:04:05.000Z')
    expect(at(1_760_000_000)?.toISOString()).toBe('2025-10-09T08:53:20.000Z')
  })
  it('rejects booleans, objects, null (new Date(true) would be 1ms after epoch)', () => {
    expect(at(true)).toBeNull()
    expect(at({})).toBeNull()
    expect(at(null)).toBeNull()
    expect(at(undefined)).toBeNull()
  })
})

describe('safe slicing boundaries', () => {
  const title = (t: string) =>
    buildNormalizedPosting('REMOTEOK_API', {
      url: 'https://x.test/j/1',
      title: t,
      companyName: 'C',
    })!.title
  it('keeps a value of exactly the cap even if it ends in a lone high surrogate', () => {
    expect(title('a'.repeat(499) + '\uD83D')).toHaveLength(500)
  })
  it('drops a high surrogate at the cut, including both range edges', () => {
    expect(title('a'.repeat(499) + '\uD800b')).toBe('a'.repeat(499))
    expect(title('a'.repeat(499) + '\uDBFFb')).toBe('a'.repeat(499))
    expect(title('a'.repeat(499) + '\uD83Db')).toBe('a'.repeat(499))
  })
  it('keeps a non-high-surrogate at the cut', () => {
    expect(title('a'.repeat(600))).toHaveLength(500)
    expect(title('a'.repeat(499) + '\uDC00b')).toHaveLength(500)
    expect(title('a'.repeat(499) + '퟿b')).toHaveLength(500)
    expect(title('a'.repeat(499) + 'b')).toHaveLength(500)
  })
})

describe('buildNormalizedPosting limits', () => {
  const ok = { url: 'https://x.test/j/1', title: 'T', companyName: 'C' }
  it('caps companyNameNormalized at 255 even when normalization expands the name', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', {
      ...ok,
      companyName: 'ﬃ'.repeat(200), // NFKD: 1 ligature -> 'ffi' (3 chars)
    })!
    expect(p.companyNameNormalized).toHaveLength(255)
  })
  it('html description is cut at 4x the cap BEFORE conversion, not earlier', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', {
      ...ok,
      description: '<p>' + 'word '.repeat(10_000) + '</p>', // ~50k chars raw, < 80k headroom
    })!
    expect(p.descriptionMd.length).toBeGreaterThan(19_000)
  })
})

describe('buildNormalizedPosting', () => {
  const ok = {
    url: 'https://x.test/j/1?utm=1',
    title: ' Senior Dev ',
    companyName: ' Acme GmbH ',
    description: '<p>Hi <b>there</b></p>',
  }
  it('normalizes a valid raw posting', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', ok)!
    expect(p.url).toBe('https://x.test/j/1')
    expect(p.externalId).toBe('https://x.test/j/1')
    expect(p.title).toBe('Senior Dev')
    expect(p.companyName).toBe('Acme GmbH')
    expect(p.descriptionMd).toContain('Hi')
    expect(p.descriptionMd).not.toContain('<p>')
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
  it('skips non-https, titleless and companyless entries', () => {
    expect(buildNormalizedPosting('REMOTEOK_API', { ...ok, url: 'http://x.test/j' })).toBeNull()
    expect(buildNormalizedPosting('REMOTEOK_API', { ...ok, url: 'javascript:alert(1)' })).toBeNull()
    expect(buildNormalizedPosting('REMOTEOK_API', { ...ok, title: '  ' })).toBeNull()
    expect(buildNormalizedPosting('REMOTEOK_API', { ...ok, companyName: '' })).toBeNull()
  })
  it('strips NUL bytes everywhere and caps lengths', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', {
      ...ok,
      title: 'A\u0000B'.padEnd(900, 'x'),
      companyName: 'C\u0000'.padEnd(400, 'y'),
      location: 'L\u0000'.padEnd(700, 'z'),
    })!
    expect(p.title).not.toContain('\u0000')
    expect(p.title.length).toBeLessThanOrEqual(500)
    expect(p.companyName.length).toBeLessThanOrEqual(255)
    expect(p.location!.length).toBeLessThanOrEqual(500)
    expect(p.location).not.toContain('\u0000')
  })
  it('blank location becomes null', () => {
    expect(buildNormalizedPosting('REMOTEOK_API', { ...ok, location: '  ' })!.location).toBeNull()
  })
  it('text kind skips HTML conversion', () => {
    const p = buildNormalizedPosting('HN_HIRING', {
      ...ok,
      description: 'a < b && c\u0000',
      descriptionKind: 'text',
    })!
    expect(p.descriptionMd).toBe('a < b && c')
  })
  it('carries structured hints and bounded tags', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', {
      ...ok,
      remote: true,
      employmentType: 'full_time',
      seniorityHint: 'Senior',
      tags: Array.from({ length: 80 }, (_, i) => `t${i}`),
    })!
    expect(p.remote).toBe(true)
    expect(p.employmentType).toBe('full_time')
    expect(p.seniorityHint).toBe('Senior')
    expect(p.tags).toHaveLength(50)
  })
  it('caps tag length and drops empty tags', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', {
      ...ok,
      tags: ['x'.repeat(100), '  ', 'ok'],
    })!
    expect(p.tags).toEqual(['x'.repeat(60), 'ok'])
  })
  it('keepQueryParams is honoured (HN ?id=)', () => {
    const p = buildNormalizedPosting('HN_HIRING', {
      ...ok,
      url: 'https://news.ycombinator.com/item?id=42&utm=1',
      keepQueryParams: ['id'],
    })!
    expect(p.url).toBe('https://news.ycombinator.com/item?id=42')
  })
  it('same url, different source -> different fingerprint', () => {
    expect(buildNormalizedPosting('REMOTEOK_API', ok)!.fingerprint).not.toBe(
      buildNormalizedPosting('REMOTIVE_API', ok)!.fingerprint,
    )
  })

  it('drops (does not truncate) a canonical url longer than 2048 chars', () => {
    expect(
      buildNormalizedPosting('REMOTEOK_API', { ...ok, url: `https://x.test/${'a'.repeat(2100)}` }),
    ).toBeNull()
    const edge = `https://x.test/${'a'.repeat(2048 - 'https://x.test/'.length)}`
    expect(buildNormalizedPosting('REMOTEOK_API', { ...ok, url: edge })!.url).toBe(edge)
  })

  it('never throws on non-string garbage from raw JSON', () => {
    const bad = (over: Record<string, unknown>) =>
      buildNormalizedPosting('REMOTEOK_API', { ...ok, ...over } as never)
    expect(bad({ title: 123 })).toBeNull()
    expect(bad({ companyName: { a: 1 } })).toBeNull()
    expect(bad({ url: 42 })).toBeNull()
    expect(bad({ tags: 'x' })!.tags).toEqual([])
    expect(bad({ tags: ['a', 1, null, { x: 1 }, 'b'] })!.tags).toEqual(['a', 'b'])
    expect(bad({ description: 99 })!.descriptionMd).toBe('')
    expect(bad({ location: ['x'] })!.location).toBeNull()
    expect(bad({ employmentType: 5, seniorityHint: {} })).toMatchObject({
      employmentType: null,
      seniorityHint: null,
    })
    expect(bad({ remote: 'yes' })!.remote).toBeNull()
    expect(bad({ publishedAt: {} })!.publishedAt).toBeNull()
  })

  it('text kind neutralizes markdown images, links and autolinks', () => {
    const p = buildNormalizedPosting('HN_HIRING', {
      ...ok,
      description: 'x ![](https://evil/p.png) [a](https://evil) <https://evil> <b>y</b>',
      descriptionKind: 'text',
    })!
    expect(p.descriptionMd).not.toMatch(/(^|[^\\])\[/)
    expect(p.descriptionMd).not.toMatch(/(^|[^\\])</)
    expect(p.descriptionMd).toContain('!\\[\\]')
  })

  it('text kind: a leading backslash cannot cancel our escaping (SR-H-2)', () => {
    const md = (description: string) =>
      buildNormalizedPosting('HN_HIRING', { ...ok, description, descriptionKind: 'text' })!
        .descriptionMd
    // Input `\` becomes a literal `\\`, and the next char keeps OUR escaping backslash.
    expect(md('\\<https://evil>')).toBe('\\\\\\<https://evil>') // \<https://evil> -> \\\<https://evil>
    expect(md('\\[a\\](https://evil)')).toBe('\\\\\\[a\\\\\\](https://evil)')
    expect(md('\\![](https://evil)')).toBe('\\\\!\\[\\](https://evil)')
    expect(md('a \\ b')).toBe('a \\\\ b') // plain text with a backslash stays intact (escaped once)
  })

  it('text kind trims', () => {
    const p = buildNormalizedPosting('HN_HIRING', {
      ...ok,
      description: '  hi \n',
      descriptionKind: 'text',
    })!
    expect(p.descriptionMd).toBe('hi')
  })

  it('cuts huge raw description before processing', () => {
    const huge = '<p>' + 'word '.repeat(2_000_000) + '</p>'
    const p = buildNormalizedPosting('REMOTEOK_API', { ...ok, description: huge })!
    // htmlToMarkdown appends a one-char ellipsis when it truncates
    expect(p.descriptionMd.length).toBeLessThanOrEqual(20_001)
    const t = buildNormalizedPosting('HN_HIRING', {
      ...ok,
      description: '['.repeat(500_000),
      descriptionKind: 'text',
    })!
    expect(t.descriptionMd.length).toBeLessThanOrEqual(20_000)
  })

  it('strips bidi controls from title/company', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', {
      ...ok,
      title: 'Dev\u202Egnp.exe',
      companyName: '\u2066Acme\u2069\u200F',
    })!
    expect(p.title).toBe('Devgnp.exe')
    expect(p.companyName).toBe('Acme')
  })

  it('slices surrogate-safe (no lone high surrogate at the cut)', () => {
    const p = buildNormalizedPosting('REMOTEOK_API', {
      ...ok,
      title: 'a'.repeat(499) + '\u{1F600}',
    })!
    expect(p.title).toBe('a'.repeat(499))
  })
})
