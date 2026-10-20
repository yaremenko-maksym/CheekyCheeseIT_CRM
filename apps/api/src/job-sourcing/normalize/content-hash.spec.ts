import { describe, expect, it } from 'vitest'
import {
  CONTENT_HASH_VERSION,
  computeContentHash,
  type HashableFields,
  stripTrackingParams,
  stripVolatileText,
} from './content-hash'

const base: HashableFields = {
  title: 'Senior Backend Engineer',
  companyName: 'Acme',
  location: 'Kyiv',
  descriptionMd: 'Build APIs.\n\nApply at https://acme.example/apply?job=5',
  remote: true,
  employmentType: 'full_time',
  seniorityHint: 'Senior',
  tags: ['node', 'postgres'],
  applicationUrl: 'https://acme.example/apply?job=5',
  dates: [
    {
      semantics: 'PUBLISHED',
      contract: 'ISO_ZONED',
      raw: '2026-10-01T00:00:00Z',
      value: new Date('2026-10-01T00:00:00Z'),
      status: 'OK',
    },
  ],
}
const hash = (over: Partial<HashableFields> = {}) => computeContentHash({ ...base, ...over })

describe('computeContentHash: fields that must NOT move the hash', () => {
  const same: Array<[string, Partial<HashableFields>]> = [
    [
      'a relative-age phrase in the description',
      { descriptionMd: `${base.descriptionMd}\n\nPosted 3 days ago` },
    ],
    [
      'a different relative-age phrase',
      { descriptionMd: `${base.descriptionMd}\n\nPosted 5 days ago` },
    ],
    [
      'tracking tokens on a link inside the description',
      {
        descriptionMd:
          'Build APIs.\n\nApply at https://acme.example/apply?utm_source=feed&job=5&gclid=abc',
      },
    ],
    [
      'tracking tokens on the application URL',
      { applicationUrl: 'https://acme.example/apply?job=5&utm_campaign=x&fbclid=y' },
    ],
    ['tag order', { tags: ['postgres', 'node'] }],
    [
      'an UPDATED date (boards bump it on every refresh)',
      {
        dates: [
          ...base.dates,
          {
            semantics: 'UPDATED',
            contract: 'ISO_ZONED',
            raw: '2026-10-19T00:00:00Z',
            value: new Date('2026-10-19T00:00:00Z'),
            status: 'OK',
          },
        ],
      },
    ],
    [
      'the raw text of a date (only the parsed instant counts)',
      { dates: [{ ...base.dates[0]!, raw: '2026-10-01T03:00:00+03:00' }] },
    ],
  ]

  it.each(same)('same hash: %s', (_name, over) => {
    expect(hash(over)).toBe(hash())
  })
})

describe('computeContentHash: Unicode', () => {
  it('composed and decomposed spellings of the same text hash identically; different text does not', () => {
    const composed = { title: 'Caf\u00e9 Engineer', tags: ['caf\u00e9'], location: 'Z\u00fcrich' }
    const decomposed = {
      title: 'Cafe\u0301 Engineer',
      tags: ['cafe\u0301'],
      location: 'Zu\u0308rich',
    }
    expect(hash(decomposed)).toBe(hash(composed))
    expect(hash({ ...composed, tags: ['cafe'] })).not.toBe(hash(composed))
  })
})

describe('computeContentHash: fields that MUST move the hash', () => {
  // Without this half, "stays the same" is satisfied by a hash of a constant.
  const different: Array<[string, Partial<HashableFields>]> = [
    ['title', { title: 'Staff Backend Engineer' }],
    ['company', { companyName: 'Acme Ltd' }],
    ['location', { location: 'Lviv' }],
    ['null location', { location: null }],
    ['description body', { descriptionMd: 'Build APIs and own on-call.' }],
    ['remote flag', { remote: false }],
    ['unknown remote flag', { remote: null }],
    ['employment type', { employmentType: 'contract' }],
    ['seniority', { seniorityHint: 'Lead' }],
    ['tag set', { tags: ['node', 'postgres', 'redis'] }],
    ['a non-tracking application param', { applicationUrl: 'https://acme.example/apply?job=6' }],
    ['the application path', { applicationUrl: 'https://acme.example/careers?job=5' }],
    ['no application URL', { applicationUrl: null }],
    [
      'the PUBLISHED instant',
      { dates: [{ ...base.dates[0]!, value: new Date('2026-10-02T00:00:00Z') }] },
    ],
    [
      'an EXPIRY date appearing',
      {
        dates: [
          ...base.dates,
          {
            semantics: 'EXPIRY',
            contract: 'ISO_ZONED',
            raw: '2026-12-01T00:00:00Z',
            value: new Date('2026-12-01T00:00:00Z'),
            status: 'OK',
          },
        ],
      },
    ],
    ['a number that only looks like an age', { descriptionMd: 'Build APIs. 5 days of leave.' }],
  ]

  it.each(different)('different hash: %s', (_name, over) => {
    expect(hash(over)).not.toBe(hash())
  })

  it('a date that failed to parse (value null) differs from a good one', () => {
    expect(hash({ dates: [{ ...base.dates[0]!, value: null, status: 'INVALID' }] })).not.toBe(
      hash(),
    )
  })

  it('the hash version is part of the payload', () => {
    expect(computeContentHash(base, 'ch-next')).not.toBe(
      computeContentHash(base, CONTENT_HASH_VERSION),
    )
  })

  it('is 64 lowercase hex chars and stable across calls', () => {
    expect(hash()).toMatch(/^[0-9a-f]{64}$/)
    expect(hash()).toBe(hash())
  })
})

describe('stripVolatileText', () => {
  it('removes relative-age phrases and nothing else', () => {
    expect(stripVolatileText('Posted 3 days ago. Offer: 3 days of leave.')).toBe(
      'Offer: 3 days of leave.',
    )
    expect(stripVolatileText('updated an hour ago')).toBe('')
    expect(stripVolatileText('Posted yesterday')).toBe('')
  })
})

describe('stripTrackingParams', () => {
  it('drops tracking params and keeps identity-bearing ones, in a stable order', () => {
    expect(stripTrackingParams('https://a.example/p?utm_source=x&job=5&b=2&gclid=z#frag')).toBe(
      'https://a.example/p?b=2&job=5',
    )
  })
  it('leaves a non-URL string alone', () => {
    expect(stripTrackingParams('not a url')).toBe('not a url')
  })
})
