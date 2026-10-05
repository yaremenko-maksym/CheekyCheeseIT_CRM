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
})
