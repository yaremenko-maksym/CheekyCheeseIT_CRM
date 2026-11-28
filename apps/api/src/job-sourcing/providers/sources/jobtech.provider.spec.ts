import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import {
  JOBTECH_ENDPOINT,
  JOBTECH_MAX_PAGES_DEFAULT,
  jobTechProvider,
  jobTechSpec,
} from './jobtech.provider'
/**
 * JobTech (Arbetsförmedlingen) through its public provider. Expected values are hand-read from
 * `__fixtures__/jobtech/jobs-data-it.json` (a capture of 2026-11-24, contacts removed; provenance
 * beside it) and written here as literals, never produced by the mapper.
 *
 * The two hits: 31774488 (four contacts were removed from it) and 31774452 (its description carried
 * an e-mail address, now redacted).
 */
const NOW = new Date('2026-11-24T18:00:00Z')

const cfg = (extra: Record<string, unknown> = {}) =>
  jobTechProvider.parseConfig({ configVersion: 1, ...extra })

const page = () => sourceFixture('jobtech', 'jobs-data-it') as Record<string, unknown>

/** The fixture with a total that ends the paging after this one page. */
const lastPage = () => ({ ...page(), total: { value: 2 } })

async function run(bodies: unknown[], opts: { config?: Record<string, unknown> } = {}) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: bodies.map((b) => ({ status: 200, bodyText: JSON.stringify(b) })),
  })
  const batch = await jobTechProvider.collectReport(cfg(opts.config), f.ctx)
  return { batch, f }
}

describe('paged requests to the public search API', () => {
  it('asks for the Data/IT occupation field, newest first, fifty a page, from offset zero', async () => {
    const { f } = await run([lastPage()])
    expect(f.sent).toHaveLength(1)
    const url = new URL(f.sent[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe(JOBTECH_ENDPOINT)
    expect(url.searchParams.get('occupation-field')).toBe('apaJ_2ja_LuF')
    expect(url.searchParams.get('sort')).toBe('pubdate-desc')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.get('offset')).toBe('0')
  })

  it('follows the total to the next page, offset fifty, and stops at the configured maxPages', async () => {
    const { f } = await run([page(), page()], { config: { maxPages: 2 } })
    expect(f.sent).toHaveLength(2)
    expect(new URL(f.sent[1]?.url ?? '').searchParams.get('offset')).toBe('50')
  })

  it('stops when the total says there is nothing after this page', async () => {
    const { f } = await run([lastPage()], { config: { maxPages: 4 } })
    expect(f.sent).toHaveLength(1)
  })

  it('defaults to four pages, which is two hundred ads a run', () => {
    expect(JOBTECH_MAX_PAGES_DEFAULT).toBe(4)
    expect(cfg().maxPages).toBe(4)
  })
})

describe('the two fixture ads', () => {
  it('keeps both, with the nativeIds in the order the API sent them', async () => {
    const { batch } = await run([lastPage()])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['31774488', '31774452'])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('maps every field of the first ad (hand-read)', async () => {
    const { batch } = await run([lastPage()])
    const o = batch.observations[0]
    expect(o?.identity).toMatchObject({
      provider: 'JOBTECH_API',
      namespace: 'jobtech',
      nativeId: '31774488',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://arbetsformedlingen.se/platsbanken/annonser/31774488')
    expect(o?.applicationUrl).toBe(
      'https://employ.kontek.se/spa/public/apply?guidAssignment=f34638ae-f44d-46e7-a831-6af6f5e49dd5&publishCode=PB&TK=622d739a-5436-45aa-8cac-d7f1b478bd0e',
    )
    expect(o?.normalized.title).toBe('IT-supporttekniker')
    expect(o?.normalized.companyName).toBe('REGIONMUSEET I SKÅNE/ LANDSANTIKVARIEN I SKÅNE')
    expect(o?.normalized.location).toBe('Kristianstad')
    expect(o?.adapterVersion).toBe('jobtech-1')
  })

  it('reads the location from the municipality when the city is absent', async () => {
    const { batch } = await run([lastPage()])
    expect(batch.observations[1]?.normalized.location).toBe('Oskarshamn')
  })

  it('keeps remoteness unknown and tags empty, since the API names neither', async () => {
    const { batch } = await run([lastPage()])
    for (const o of batch.observations) {
      expect(o.normalized.remote).toBeNull()
      expect(o.normalized.tags).toEqual([])
    }
  })

  it('keeps a publication_date with no zone raw and reports it MISSING_ZONE, with no publishedAt', async () => {
    const { batch } = await run([lastPage()])
    // The zone gap costs the date, never the ad: both fixture ads are kept.
    expect(batch.counts).toMatchObject({ raw: 2, normalized: 2 })
    const o = batch.observations[0]
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'ISO_ZONED',
        raw: '2026-11-24T18:20:01',
        status: 'MISSING_ZONE',
        value: null,
      },
    ])
    expect(o?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'MISSING_ZONE',
    })
  })

  it('carries no e-mail address in the description text', async () => {
    const { batch } = await run([lastPage()])
    for (const o of batch.observations) {
      expect(o.normalized.descriptionMd ?? '').not.toMatch(/@/)
    }
  })
})

/** One ad as the API sends it, with only what a test varies overridden. */
const ad = (extra: Record<string, unknown> = {}) =>
  jobTechSpec.itemSchema.parse({
    id: 'probe-1',
    headline: 'Backend Engineer',
    webpage_url: 'https://arbetsformedlingen.se/platsbanken/annonser/probe-1',
    publication_date: '2026-11-24T18:20:01+01:00',
    ...extra,
  })

const mapped = (extra: Record<string, unknown> = {}) => jobTechSpec.mapItem(ad(extra), cfg())

describe('the spec seams the capture cannot reach', () => {
  it('scopes a clean run to the Data/IT occupation field, as a WINDOW', () => {
    expect(jobTechSpec.scopeOf(cfg(), NOW)).toEqual({
      namespace: 'jobtech',
      query: 'occupation-field:apaJ_2ja_LuF',
      configVersion: 1,
      window: null,
    })
  })

  it('refuses a search query and a date window: the occupation field is the only scope', () => {
    expect(() => cfg({ query: 'python' })).toThrow(
      'JobTech has no search here; the occupation field is the scope',
    )
    expect(() => cfg({ window: { from: '2026-01-01', to: '2026-02-01' } })).toThrow(
      'JobTech has no date window here',
    )
  })

  it('asks each page with a JSON accept header and an offset of (page - 1) times the page size', () => {
    const req = jobTechSpec.pageRequest(cfg(), { page: 3, cursor: null, window: null })
    expect(req.request.headers).toEqual({ accept: 'application/json' })
    expect(new URL(req.request.url).searchParams.get('offset')).toBe('100')
  })

  it('names the next page only while the total is above the offset reached', () => {
    const at = (page: number) => ({ page, cursor: null, window: null })
    const hit = { id: 'a' }
    expect(jobTechSpec.nextCursor({ total: { value: 51 }, hits: [hit] }, at(1))).toBe('page:2')
    expect(jobTechSpec.nextCursor({ total: { value: 101 }, hits: [hit] }, at(2))).toBe('page:3')
    // A total equal to the offset reached means nothing follows.
    expect(jobTechSpec.nextCursor({ total: { value: 50 }, hits: [hit] }, at(1))).toBeNull()
    expect(jobTechSpec.nextCursor({ total: { value: 100 }, hits: [hit] }, at(2))).toBeNull()
    // An empty page ends the paging even when the total says more exists.
    expect(jobTechSpec.nextCursor({ total: { value: 500 }, hits: [] }, at(1))).toBeNull()
  })

  it('takes the native identity from the ad id', () => {
    expect(jobTechSpec.nativeIdOf(ad({ id: '31774488' }), cfg())).toBe('31774488')
  })

  it('reads the description text, and null when the description or its text is absent', () => {
    expect(mapped({ description: { text: 'Build things' } }).description).toBe('Build things')
    expect(mapped({ description: { text: null } }).description).toBeNull()
    expect(mapped({ description: null }).description).toBeNull()
    expect(mapped().description).toBeNull()
  })

  it('reads the employer name, and null when there is no employer', () => {
    expect(mapped({ employer: { name: 'Acme AB' } }).companyName).toBe('Acme AB')
    expect(mapped({ employer: { name: null } }).companyName).toBeNull()
    expect(mapped({ employer: null }).companyName).toBeNull()
  })

  it('prefers the stated city to the municipality, and falls back to the municipality alone', () => {
    const place = (workplace_address: Record<string, unknown> | null) =>
      mapped({ workplace_address }).location
    expect(place({ city: 'Kristianstad', municipality: 'Oskarshamn' })).toBe('Kristianstad')
    expect(place({ city: null, municipality: 'Oskarshamn' })).toBe('Oskarshamn')
    expect(place({ city: null, municipality: null })).toBeNull()
    expect(place(null)).toBeNull()
  })

  it('reads the application URL, and null when the ad names none', () => {
    const apply = 'https://employ.example.se/apply?ref=1'
    expect(mapped({ application_details: { url: apply } }).applicationUrl).toBe(apply)
    expect(mapped({ application_details: { url: null } }).applicationUrl).toBeNull()
    expect(mapped({ application_details: null }).applicationUrl).toBeNull()
  })
})
