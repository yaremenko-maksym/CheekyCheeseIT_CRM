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

describe('computeContentHash: golden digest (ch1 stability pin)', () => {
  // IF THIS TEST FAILS, THE CANONICAL PAYLOAD CHANGED (field order, sort order, normalization,
  // param stripping or date encoding). Digests already stored in `job_source_record_revisions`
  // would silently stop matching. Do NOT just update the literal: bump CONTENT_HASH_VERSION
  // ('ch1' -> 'ch2') so the churn is deliberate, then re-pin here under the new version.
  it('ch1 digest of one fixed input never moves without a version bump', () => {
    expect(CONTENT_HASH_VERSION).toBe('ch1')
    expect(
      computeContentHash({
        title: 'Senior Backend Engineer',
        companyName: 'Acme',
        location: 'Kyiv',
        descriptionMd: 'Build APIs.\n\nApply at https://acme.example/apply?job=5&utm_source=x',
        remote: true,
        employmentType: 'full_time',
        seniorityHint: 'Senior',
        tags: ['postgres', 'node', 'node'],
        applicationUrl: 'https://acme.example/apply?z=1&job=5&utm_campaign=y',
        dates: [
          {
            semantics: 'PUBLISHED',
            contract: 'ISO_ZONED',
            raw: '2026-10-01T00:00:00Z',
            value: new Date('2026-10-01T00:00:00Z'),
            status: 'OK',
          },
        ],
      }),
    ).toBe('e643b70c79e0b7694cc12547399bd00dcd73cb5d01b082a410158f11cdb6fea9')
  })
})

describe('computeContentHash: application URL `ref`', () => {
  it('two apply links differing only by ref hash differently (the stored link would go stale)', () => {
    expect(hash({ applicationUrl: 'https://acme.example/apply?ref=job1' })).not.toBe(
      hash({ applicationUrl: 'https://acme.example/apply?ref=job2' }),
    )
  })

  it('a `ref` inside a description link is still noise and does not move the hash', () => {
    expect(hash({ descriptionMd: 'Apply https://acme.example/a?ref=x' })).toBe(
      hash({ descriptionMd: 'Apply https://acme.example/a?ref=y' }),
    )
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

describe('stripTrackingParams: ordering, anchoring and output shape', () => {
  it('sorts remaining params by name, then by value, whatever order they arrived in', () => {
    expect(stripTrackingParams('https://a.example/p?b=2&a=1')).toBe('https://a.example/p?a=1&b=2')
    expect(stripTrackingParams('https://a.example/p?a=2&a=1')).toBe('https://a.example/p?a=1&a=2')
    expect(stripTrackingParams('https://a.example/p?a=1&a=2')).toBe('https://a.example/p?a=1&a=2')
    expect(stripTrackingParams('https://a.example/p?c=3&a=2&b=1&a=1')).toBe(
      'https://a.example/p?a=1&a=2&b=1&c=3',
    )
  })

  it('emits no "?" when every param was tracking, and none when there were none', () => {
    expect(stripTrackingParams('https://a.example/p?utm_source=x&gclid=y')).toBe(
      'https://a.example/p',
    )
    expect(stripTrackingParams('https://a.example/p')).toBe('https://a.example/p')
  })

  it('drops a tracking name only when the WHOLE name matches (anchored both ends)', () => {
    // Prefix/suffix lookalikes are real params and must survive.
    expect(
      stripTrackingParams('https://a.example/p?my_ref=1&reference=2&xutm_a=3&gclid_x=4&job=5'),
    ).toBe('https://a.example/p?gclid_x=4&job=5&my_ref=1&reference=2&xutm_a=3')
  })

  it.each([
    'utm_source',
    'UTM_Medium',
    'gclid',
    'dclid',
    'fbclid',
    'msclkid',
    'mc_cid',
    'mc_eid',
    '_ga',
    'ref',
    'ref_src',
    'referrer',
    'trk',
    'trkinfo',
    'trackingid',
    'tracking_id',
    'TrackingId',
  ])('drops the tracking param %s', (name) => {
    expect(stripTrackingParams(`https://a.example/p?${name}=1&job=5`)).toBe(
      'https://a.example/p?job=5',
    )
  })

  it('keeps `ref` on an application URL, where it can select the job; still drops utm_*', () => {
    expect(stripTrackingParams('https://a.example/apply?ref=job1&utm_source=x&job=5', true)).toBe(
      'https://a.example/apply?job=5&ref=job1',
    )
    // Only the exact name `ref` is a selector (any case); look-alike trackers stay stripped.
    expect(stripTrackingParams('https://a.example/apply?REF=job1&job=5', true)).toBe(
      'https://a.example/apply?REF=job1&job=5',
    )
    expect(
      stripTrackingParams('https://a.example/apply?ref_src=tw&referrer=x&trk=1&job=5', true),
    ).toBe('https://a.example/apply?job=5')
    expect(stripTrackingParams('https://a.example/apply?ref=job1&job=5')).toBe(
      'https://a.example/apply?job=5',
    )
  })

  it('percent-encodes names and values it keeps', () => {
    expect(stripTrackingParams('https://a.example/p?q=a%20b&x%20y=1')).toBe(
      'https://a.example/p?q=a%20b&x%20y=1',
    )
  })
})

describe('stripVolatileText: links and whitespace', () => {
  it('cleans tracking params from http AND https links inside the text, leaving the prose', () => {
    expect(
      stripVolatileText(
        'See https://a.example/p?utm_source=x&job=5 and http://b.example/q?fbclid=y&n=1 today',
      ),
    ).toBe('See https://a.example/p?job=5 and http://b.example/q?n=1')
  })

  it('collapses runs of spaces/tabs to one space, but leaves a lone tab alone', () => {
    expect(stripVolatileText('a   b')).toBe('a b')
    expect(stripVolatileText('a \t b')).toBe('a b')
    expect(stripVolatileText('a\tb')).toBe('a\tb')
  })

  it('collapses blank-line runs (including whitespace-only lines) to exactly one blank line', () => {
    expect(stripVolatileText('a\n\n\n\nb')).toBe('a\n\nb')
    expect(stripVolatileText('a\n \nb')).toBe('a\n\nb')
    expect(stripVolatileText('a \n\nb')).toBe('a\n\nb')
    expect(stripVolatileText('a\n\n b')).toBe('a\n\nb')
    // A single line break and the text between breaks are left alone.
    expect(stripVolatileText('a\nb')).toBe('a\nb')
    expect(stripVolatileText('a\nx\nb')).toBe('a\nx\nb')
  })

  it('pulls a stranded final period back against the text', () => {
    expect(stripVolatileText('Apply now .')).toBe('Apply now.')
    expect(stripVolatileText('Apply now \n.')).toBe('Apply now.')
    // Only a TRAILING stranded period: a mid-text one is not touched.
    expect(stripVolatileText('Wait . More')).toBe('Wait . More')
  })
})

describe('computeContentHash: version and date status', () => {
  it('pins the version literal: changing it is a deliberate, visible one-time churn', () => {
    expect(CONTENT_HASH_VERSION).toBe('ch1')
    expect(computeContentHash(base)).toBe(computeContentHash(base, 'ch1'))
    expect(computeContentHash(base)).not.toBe(computeContentHash(base, ''))
  })

  it('the same instant with a different status hashes differently', () => {
    const flagged = { ...base.dates[0]!, status: 'FUTURE' as const }
    expect(hash({ dates: [flagged] })).not.toBe(hash())
  })

  it('an empty application URL is not the same as none', () => {
    expect(hash({ applicationUrl: '' })).not.toBe(hash({ applicationUrl: null }))
  })
})
