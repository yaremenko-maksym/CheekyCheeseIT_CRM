import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import { JOBTECH_ENDPOINT, JOBTECH_MAX_PAGES_DEFAULT, jobTechProvider } from './jobtech.provider'
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
