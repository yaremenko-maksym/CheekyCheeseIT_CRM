import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { personioProvider, personioSpec } from './personio.provider'
import { recruiteeProvider, recruiteeSpec } from './recruitee.provider'
import { workableProvider, workableSpec } from './workable.provider'

/**
 * Edges the main specs of the four ATS B adapters do not reach: exact kinds, the shape of a cache
 * slot, whitespace in the feed, every combination of an optional part being there or not. Inputs
 * are built here and every expected value is a literal next to its input.
 */

const NOW = new Date('2026-10-24T04:00:00Z')

describe("the cache slot names the request, so a 304 cannot replay another request's body", () => {
  const slotOf = async (
    provider: {
      collectReport: (c: never, x: never) => Promise<unknown>
      parseConfig: (r: unknown) => unknown
    },
    config: unknown,
    body: string,
  ) => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 200, bodyText: body, etag: '"v1"' }],
    })
    await provider.collectReport(provider.parseConfig(config) as never, f.ctx as never)
    return [...f.cache.keys()].map((k) => (JSON.parse(k) as string[])[0])
  }

  it('workable asks for the account, recruitee for the offers, personio for the xml', async () => {
    expect(
      await slotOf(workableProvider, { configVersion: 1, board: 'acme' }, '{"name":"A","jobs":[]}'),
    ).toEqual(['account'])
    expect(
      await slotOf(recruiteeProvider, { configVersion: 1, board: 'acme' }, '{"offers":[]}'),
    ).toEqual(['offers'])
    expect(
      await slotOf(
        personioProvider,
        { configVersion: 1, board: 'acme', language: 'en' },
        '<workzag-jobs></workzag-jobs>',
      ),
    ).toEqual(['xml'])
  })

  it('the same request on a different company or language is a different cache entry', async () => {
    const keyOf = async (config: Record<string, unknown>) => {
      const f = fakeCollectionContext({
        now: NOW,
        responses: [{ status: 200, bodyText: '<workzag-jobs></workzag-jobs>', etag: '"v1"' }],
      })
      await personioProvider.collectReport(personioProvider.parseConfig(config), f.ctx)
      return [...f.cache.keys()][0]
    }
    const base = { configVersion: 1, board: 'acme', language: 'en' }
    const keys = [
      await keyOf(base),
      await keyOf({ ...base, board: 'other' }),
      await keyOf({ ...base, language: 'de' }),
      await keyOf({ ...base, tld: 'com' }),
    ]
    expect(new Set(keys).size).toBe(4)
  })
})

describe('nativeIdOf is the same field mapItem keys identity on', () => {
  it('workable: the shortcode', () => {
    const config = workableProvider.parseConfig({ configVersion: 1, board: 'acme' })
    const item = workableSpec.itemSchema.parse({
      shortcode: '0123456789',
      title: 'T',
      url: 'https://apply.workable.com/j/0123456789',
    })
    expect(workableSpec.nativeIdOf(item, config)).toBe('0123456789')
    expect(workableSpec.mapItem(item, config).nativeId).toBe('0123456789')
  })

  it('recruitee: the numeric id as text', () => {
    const config = recruiteeProvider.parseConfig({ configVersion: 1, board: 'acme' })
    const item = recruiteeSpec.itemSchema.parse({
      id: 2783543,
      title: 'T',
      careers_url: 'https://x.example.test/o/t',
    })
    expect(recruiteeSpec.nativeIdOf(item, config)).toBe('2783543')
    expect(recruiteeSpec.mapItem(item, config).nativeId).toBe('2783543')
  })

  it('personio: the position id', () => {
    const config = personioProvider.parseConfig({ configVersion: 1, board: 'acme', language: 'en' })
    const item = personioSpec.itemSchema.parse({
      id: '1834171',
      name: 'T',
      additionalOffices: [],
      descriptions: [],
    })
    expect(personioSpec.nativeIdOf(item, config)).toBe('1834171')
    expect(personioSpec.mapItem(item, config).nativeId).toBe('1834171')
  })
})

describe('Recruitee: every optional part being there or not', () => {
  const offer = (extra: Record<string, unknown> = {}) => ({
    id: 1,
    title: 'T',
    careers_url: 'https://jobs.example.test/o/1',
    company_name: 'Acme',
    ...extra,
  })
  async function observe(extra: Record<string, unknown>) {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: JSON.stringify({ offers: [offer(extra)] }) }],
    })
    const batch = await recruiteeProvider.collectReport(
      recruiteeProvider.parseConfig({ configVersion: 1, board: 'acme' }),
      f.ctx,
    )
    return batch.observations[0]
  }

  it.each([
    [
      'two places with a part missing each',
      { location: 'Fallback', locations: [{ city: 'Paris' }, { country: 'Spain' }] },
      'Paris; Spain',
    ],
    [
      'the same place twice',
      {
        location: 'Fallback',
        locations: [
          { city: 'Paris', country: 'FR' },
          { city: 'Paris', country: 'FR' },
        ],
      },
      'Paris, FR',
    ],
    [
      'places that say nothing fall back to the location string',
      { location: 'Fallback X', locations: [{}, { city: '  ' }] },
      'Fallback X',
    ],
    [
      'one place is the location string, not the parts',
      {
        location: 'Amsterdam, Noord-Holland, Netherlands',
        locations: [{ city: 'Amsterdam', country: 'Netherlands' }],
      },
      'Amsterdam, Noord-Holland, Netherlands',
    ],
    ['no places, a location string', { location: 'Only string' }, 'Only string'],
    ['nothing at all', {}, null],
    ['a blank location string', { location: '   ' }, null],
  ])('location: %s', async (_label, extra, expected) => {
    expect((await observe(extra))?.normalized.location ?? null).toBe(expected)
  })

  it.each([
    ['both', { description: '<p>D</p>', requirements: '<p>R</p>' }, 'D\n\nR'],
    ['only the description', { description: '<p>D</p>' }, 'D'],
    ['only the requirements', { requirements: '<p>R</p>' }, 'R'],
    ['neither', {}, ''],
    ['nulls', { description: null, requirements: null }, ''],
  ])('description: %s', async (_label, extra, expected) => {
    expect((await observe(extra))?.normalized.descriptionMd ?? '').toBe(expected)
  })

  it('tags: none when there is no department and no tags key; strings only from a mixed list', async () => {
    expect((await observe({}))?.normalized.tags).toEqual([])
    expect((await observe({ tags: null }))?.normalized.tags).toEqual([])
    const mixed = await observe({ department: ' Ops ', tags: [1, { a: 1 }, 'x', '  ', null, 'y'] })
    expect(mixed?.normalized.tags).toEqual(['Ops', 'x', 'y'])
  })
})

describe('Personio: whitespace, absent parts and headings', () => {
  const wrap = (inner: string) => `<?xml version="1.0"?>\n<workzag-jobs>${inner}</workzag-jobs>`
  async function observe(inner: string) {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: wrap(inner) }] })
    const batch = await personioProvider.collectReport(
      personioProvider.parseConfig({ configVersion: 1, board: 'acme', language: 'en' }),
      f.ctx,
    )
    return batch
  }
  const pos = (inner: string) =>
    `<position><id>1</id><subcompany>Acme</subcompany><name>T</name>${inner}</position>`

  it('text is trimmed: ids, names, offices, categories', async () => {
    const batch = await observe(
      `<position><id>\n 5 \n</id><subcompany> Acme GmbH </subcompany><name>\n  Role  \n</name><office> Berlin </office><additionalOffices><office>\n Munich\n</office><office> Berlin </office></additionalOffices><department> Ops </department><recruitingCategory> Cat </recruitingCategory><employmentType> permanent </employmentType><seniority> senior </seniority><keywords> a , b </keywords><createdAt> 2026-05-11T13:18:11+00:00 </createdAt></position>`,
    )
    const o = batch.observations[0]
    expect(o?.identity.nativeId).toBe('5')
    expect(o?.normalized.title).toBe('Role')
    expect(o?.normalized.companyName).toBe('Acme GmbH')
    expect(o?.normalized.location).toBe('Berlin; Munich')
    expect(o?.normalized.tags).toEqual(['Ops', 'Cat', 'a', 'b'])
    expect(o?.normalized.employmentType).toBe('permanent')
    expect(o?.normalized.seniorityHint).toBe('senior')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-05-11T13:18:11.000Z')
  })

  it('a position with no office has no location; one with a blank office likewise', async () => {
    expect((await observe(pos(''))).observations[0]?.normalized.location ?? null).toBeNull()
    expect(
      (await observe(pos('<office>  </office>'))).observations[0]?.normalized.location ?? null,
    ).toBeNull()
  })

  it('a position with no jobDescriptions element is still a vacancy with no description', async () => {
    const batch = await observe(pos(''))
    expect(batch.counts.normalized).toBe(1)
    expect(batch.observations[0]?.normalized.descriptionMd ?? '').toBe('')
  })

  it('a description without a value is its heading; one without a name is just its value', async () => {
    const headingOnly = await observe(
      pos(
        '<jobDescriptions><jobDescription><name>Only heading</name></jobDescription></jobDescriptions>',
      ),
    )
    expect(headingOnly.observations[0]?.normalized.descriptionMd).toBe('### Only heading')
    const valueOnly = await observe(
      pos(
        '<jobDescriptions><jobDescription><value><![CDATA[<p>Body</p>]]></value></jobDescription></jobDescriptions>',
      ),
    )
    expect(valueOnly.observations[0]?.normalized.descriptionMd).toBe('Body')
  })

  it('a heading is escaped text: & < > and quotes arrive as the characters they are', async () => {
    const batch = await observe(
      pos(
        '<jobDescriptions><jobDescription><name>A &amp; B &lt;i&gt; C &quot;D&quot;</name><value><![CDATA[<p>x</p>]]></value></jobDescription></jobDescriptions>',
      ),
    )
    const md = batch.observations[0]?.normalized.descriptionMd ?? ''
    expect(md).toContain('A & B')
    expect(md).toContain('\\<i\\>')
    expect(md).toContain('C "D"')
    expect(md).not.toContain('&amp;')
    expect(md).not.toContain('&quot;')
  })

  it('several descriptions keep their order, each under its own heading', async () => {
    const batch = await observe(
      pos(
        '<jobDescriptions><jobDescription><name>One</name><value><![CDATA[<p>a</p>]]></value></jobDescription><jobDescription><name>Two</name><value><![CDATA[<p>b</p>]]></value></jobDescription></jobDescriptions>',
      ),
    )
    expect(batch.observations[0]?.normalized.descriptionMd).toBe('### One\n\na\n\n### Two\n\nb')
  })
})

describe('Workable: one location per entry', () => {
  async function observe(job: Record<string, unknown>) {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        {
          bodyText: JSON.stringify({
            name: 'Acme',
            jobs: [
              {
                shortcode: 'AAAAAAAAAA',
                title: 'T',
                url: 'https://apply.workable.com/j/AAAAAAAAAA',
                ...job,
              },
            ],
          }),
        },
      ],
    })
    const batch = await workableProvider.collectReport(
      workableProvider.parseConfig({
        configVersion: 1,
        board: 'acme',
        employer: { name: 'Acme', evidence: 'x' },
      }),
      f.ctx,
    )
    return batch.observations[0]
  }

  it.each([
    [
      'a full place',
      { locations: [{ city: 'Lyon', region: 'Rhône', country: 'France' }] },
      'Lyon, Rhône, France',
    ],
    [
      'a place missing its city',
      { locations: [{ region: 'Rhône', country: 'France' }] },
      'Rhône, France',
    ],
    [
      'the same place twice',
      { locations: [{ country: 'France' }, { country: 'France' }] },
      'France',
    ],
    [
      'places that say nothing fall back to the top-level fields',
      { locations: [{}, { city: ' ' }], city: 'Nice', country: 'France' },
      'Nice, France',
    ],
    [
      'the top-level fields alone',
      { city: 'Nice', state: 'PACA', country: 'France' },
      'Nice, PACA, France',
    ],
  ])('%s', async (_label, job, expected) => {
    expect((await observe(job))?.normalized.location).toBe(expected)
  })

  it('a job with no department and no function has no tags; a repeated word is one tag', async () => {
    expect((await observe({}))?.normalized.tags).toEqual([])
    expect((await observe({ department: 'Ops', function: 'Ops' }))?.normalized.tags).toEqual([
      'Ops',
    ])
    expect((await observe({ department: 'Ops', function: 'Eng' }))?.normalized.tags).toEqual([
      'Ops',
      'Eng',
    ])
  })

  it('an envelope name that differs only in case or spacing still matches the evidence', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: '{"name":" aCmE  Corp ","jobs":[]}' }],
    })
    const batch = await workableProvider.collectReport(
      workableProvider.parseConfig({
        configVersion: 1,
        board: 'acme',
        employer: { name: 'Acme Corp', evidence: 'x' },
      }),
      f.ctx,
    )
    expect(batch.outcome).toBe('SUCCEEDED')
  })
})
