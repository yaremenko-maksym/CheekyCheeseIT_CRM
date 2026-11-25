import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import {
  FOURDAYWEEK_ENDPOINT,
  FOURDAYWEEK_MAX_PAGES_DEFAULT,
  fourDayWeekProvider,
  fourDayWeekSpec,
  remoteOf,
} from './fourdayweek.provider'
import { TECHNICAL_ROLES } from '@crm/shared'
import { roleScopeGate } from '../../funnel/role-scope-gate'
/**
 * 4 Day Week through its public provider. Expected values are hand-read from
 * `__fixtures__/fourdayweek/jobs-engineering.json` (an authentic capture of 2026-11-24, byte for
 * byte; provenance beside it) and written here as literals, never produced by the mapper.
 *
 * The five records are all `category: engineering`: four `hybrid`, one `onsite`.
 */
const NOW = new Date('2026-11-24T18:00:00Z')

const cfg = (extra: Record<string, unknown> = {}) =>
  fourDayWeekProvider.parseConfig({ configVersion: 1, ...extra })

const page = () => sourceFixture('fourdayweek', 'jobs-engineering') as Record<string, unknown>

/** One page, then a last page with `has_more: false`, when the test needs two requests. */
async function run(bodies: unknown[], opts: { config?: Record<string, unknown> } = {}) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: bodies.map((b) => ({ status: 200, bodyText: JSON.stringify(b) })),
  })
  const batch = await fourDayWeekProvider.collectReport(cfg(opts.config), f.ctx)
  return { batch, f }
}

describe('paged requests to the documented public API', () => {
  it('asks for the engineering category, page 1, at the production page size', async () => {
    // The capture says has_more: true; a last page says false, so exactly one request is sent.
    const { f } = await run([{ ...page(), has_more: false }])
    expect(f.sent).toHaveLength(1)
    const url = new URL(f.sent[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe(FOURDAYWEEK_ENDPOINT)
    expect(url.searchParams.get('category')).toBe('engineering')
    expect(url.searchParams.get('page')).toBe('1')
    expect(url.searchParams.get('limit')).toBe('25')
  })

  it('follows has_more to page 2 and stops when has_more is false', async () => {
    const last = { ...page(), has_more: false }
    const { f } = await run([page(), last], { config: { maxPages: 4 } })
    expect(f.sent).toHaveLength(2)
    expect(new URL(f.sent[1]?.url ?? '').searchParams.get('page')).toBe('2')
  })

  it('defaults to four pages, which is one hundred listings a run', () => {
    expect(FOURDAYWEEK_MAX_PAGES_DEFAULT).toBe(4)
    expect(cfg().maxPages).toBe(4)
  })
})

describe('the five engineering records', () => {
  it('keeps all five, with the nativeIds in the order the API sent them', async () => {
    const { batch } = await run([{ ...page(), has_more: false }])
    expect(batch.counts).toEqual({
      raw: 5,
      normalized: 5,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      '01a20404-8450-7dc9-a676-7b09d142efc5',
      '01a20358-e608-768b-9866-0f078d38a3e2',
      '01a20358-e132-7bd0-888d-4ec38e4c6dc4',
      '01a20355-699e-7cbb-94cd-511338cdbe75',
      '01a20354-6a5c-76a4-8f0f-641c201fc56c',
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('maps every field of the first record (hand-read)', async () => {
    const { batch } = await run([{ ...page(), has_more: false }])
    const o = batch.observations[0]
    expect(o?.identity).toMatchObject({
      provider: 'FOURDAYWEEK_API',
      namespace: 'fourdayweek',
      nativeId: '01a20404-8450-7dc9-a676-7b09d142efc5',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://4dayweek.io/job/randd-team-leader-sw-development-at-2n-telekomunikace-28330fc7',
    )
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe('R&D Team Leader - SW Development')
    expect(o?.normalized.companyName).toBe('2N Telekomunikace')
    expect(o?.normalized.location).toBe('Prague, Czechia')
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-11-22T16:08:55.000Z')
    // 8 skills and 1 tool
    expect(o?.normalized.tags).toHaveLength(9)
    expect(o?.adapterVersion).toBe('fourdayweek-1')
  })

  // KEPT ON PURPOSE: the NON_IT title rule does not call this title non-IT, so the ingestion filter
  // keeps it. The role-scope gate closes it for the HR queue (see the gate describe at the end).
  it('tolerates a record with no tools key, and one with extra keys it does not read', async () => {
    const { batch } = await run([{ ...page(), has_more: false }])
    // observations[4] has no `tools` key; its skills still come through.
    expect(batch.observations[4]?.normalized.tags.length).toBeGreaterThan(0)
    expect(batch.observations[4]?.normalized.title).toBe('Construction Manager - Tunnels')
  })
})

describe('remoteness from work_arrangement', () => {
  it('maps remote to true, onsite to false and hybrid to unknown', () => {
    expect(remoteOf('remote')).toBe(true)
    expect(remoteOf('onsite')).toBe(false)
    expect(remoteOf('hybrid')).toBeNull()
    expect(remoteOf(null)).toBeNull()
  })

  it('applies it to the capture: four hybrid records unknown, the onsite one false', async () => {
    const { batch } = await run([{ ...page(), has_more: false }])
    expect(batch.observations.slice(0, 4).map((o) => o.normalized.remote)).toEqual([
      null,
      null,
      null,
      null,
    ])
    expect(batch.observations[4]?.normalized.remote).toBe(false)
  })
})

describe('the page and item caps', () => {
  it('stops at maxPages even when every page says has_more: true', async () => {
    // Three pages requested with two responses would fail with "no fake response": the count proves the stop.
    const { batch, f } = await run([page(), page()], { config: { maxPages: 2 } })
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('WINDOW')
  })

  it('the default ceiling is four pages when has_more never ends', async () => {
    const { f } = await run([page(), page(), page(), page(), page()])
    expect(f.sent.map((r) => new URL(r.url).searchParams.get('page'))).toEqual(['1', '2', '3', '4'])
  })

  it('a page over the 25-item page size is refused as PAYLOAD_TOO_LARGE, and nothing is kept', async () => {
    const [first] = (page().data as Record<string, unknown>[]) ?? []
    const data = Array.from({ length: 26 }, (_, i) => ({ ...first, id: `over-${i}` }))
    const { batch } = await run([{ ...page(), data, has_more: false }])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.observations).toEqual([])
  })
  it('a page over the cap is refused even when every item is a NON_IT title the skip would drop', async () => {
    // The cap counts the raw items, so skipping NON_IT rows cannot shrink an over-cap page under it.
    const [first] = (page().data as Record<string, unknown>[]) ?? []
    const nonIt = 'Exclusive Mandate: Strategic Sales Director Telco'
    const data = Array.from({ length: 26 }, (_, i) => ({
      ...first,
      id: `non-it-${i}`,
      title: nonIt,
    }))
    const { batch } = await run([{ ...page(), data, has_more: false }])
    expect(batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.observations).toEqual([])
  })
})

describe('the funnel NON_IT verdict at ingestion', () => {
  it('drops a sales record from a page and keeps the five engineering ones', async () => {
    const [first] = (page().data as Record<string, unknown>[]) ?? []
    const sales = { ...first, id: 'sales-1', title: 'Strategic Sales Director' }
    const { batch } = await run([
      { ...page(), data: [...(page().data as unknown[]), sales], has_more: false },
    ])
    expect(batch.counts).toEqual({
      raw: 5,
      normalized: 5,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).not.toContain('sales-1')
  })
})

/** One listing as the API sends it, with only what a test varies overridden. */
const listing = (extra: Record<string, unknown> = {}) =>
  fourDayWeekSpec.itemSchema.parse({
    id: 'probe-1',
    title: 'Backend Engineer',
    url: 'https://4dayweek.io/job/probe-1',
    posted_at: '2026-11-22T16:08:55.000Z',
    ...extra,
  })

const mapped = (extra: Record<string, unknown> = {}) =>
  fourDayWeekSpec.mapItem(listing(extra), cfg())

describe('the spec seams the capture cannot reach', () => {
  it('scopes a clean run to the engineering category, as a WINDOW', () => {
    expect(fourDayWeekSpec.scopeOf(cfg(), NOW)).toEqual({
      namespace: 'fourdayweek',
      query: 'category:engineering',
      configVersion: 1,
      window: null,
    })
  })

  it('refuses a search query and a date window: the category is the only scope', () => {
    expect(() => cfg({ query: 'python' })).toThrow(
      '4 Day Week has no search; the category is the scope',
    )
    expect(() => cfg({ window: { from: '2026-01-01', to: '2026-02-01' } })).toThrow(
      '4 Day Week has no date window',
    )
  })

  it('asks each page with a JSON accept header, the page given and the page size', () => {
    const req = fourDayWeekSpec.pageRequest(cfg(), { page: 3, cursor: null, window: null })
    expect(req.request.headers).toEqual({ accept: 'application/json' })
    const url = new URL(req.request.url)
    expect(url.searchParams.get('page')).toBe('3')
    expect(url.searchParams.get('category')).toBe('engineering')
    expect(url.searchParams.get('limit')).toBe('25')
  })

  it('reads a null or absent has_more as false', () => {
    expect(fourDayWeekSpec.envelopeSchema.parse({ data: [], has_more: null }).has_more).toBe(false)
    expect(fourDayWeekSpec.envelopeSchema.parse({ data: [] }).has_more).toBe(false)
  })

  it('names the next page only while has_more is true and this page carried listings', () => {
    const at = (page: number) => ({ page, cursor: null, window: null })
    const more = { data: [{ id: 'a' }], has_more: true }
    expect(fourDayWeekSpec.nextCursor(more, at(1))).toBe('page:2')
    expect(fourDayWeekSpec.nextCursor(more, at(2))).toBe('page:3')
    expect(fourDayWeekSpec.nextCursor({ data: [], has_more: true }, at(1))).toBeNull()
    expect(fourDayWeekSpec.nextCursor({ data: [{ id: 'a' }], has_more: false }, at(1))).toBeNull()
  })

  it('skips only objects whose string title the funnel calls NON_IT; everything else passes', () => {
    const data = [
      null,
      'x',
      7,
      { title: 'Exclusive Mandate: Strategic Sales Director Telco' },
      { title: 'Backend Engineer' },
      { title: 7 },
      { id: 'no-title' },
    ]
    const kept = fourDayWeekSpec
      .extractItems({ data, has_more: false }, cfg())
      .filter((item) => !fourDayWeekSpec.skipItem?.(item, cfg()))
    expect(kept).toEqual([
      null,
      'x',
      7,
      { title: 'Backend Engineer' },
      { title: 7 },
      { id: 'no-title' },
    ])
  })

  it('maps a null company, location list and tool list to null or empty, never undefined', () => {
    const m = mapped({ company: null, locations: null, skills: null, tools: null })
    expect(m.companyName).toBeNull()
    expect(m.location).toBeNull()
    expect(m.tags).toEqual([])
  })

  it('keeps a company name only when the company object carries one', () => {
    expect(mapped({ company: { name: 'Acme' } }).companyName).toBe('Acme')
    expect(mapped({ company: { name: null } }).companyName).toBeNull()
  })

  it('names the first location as City, Country, using whichever part is present', () => {
    const location = (locations: Record<string, unknown>[]) => mapped({ locations }).location
    expect(location([{ city: 'Prague', country: 'Czechia' }])).toBe('Prague, Czechia')
    expect(
      location([
        { city: 'Prague', country: 'Czechia' },
        { city: 'Brno', country: 'Czechia' },
      ]),
    ).toBe('Prague, Czechia')
    expect(location([{ city: 'Prague', country: null }])).toBe('Prague')
    expect(location([{ city: null, country: 'Czechia' }])).toBe('Czechia')
    expect(location([{ city: '', country: 'Czechia' }])).toBe('Czechia')
    expect(location([{ city: null, country: null }])).toBeNull()
    expect(location([])).toBeNull()
  })

  it('lists skills then tools in the order sent, and drops unnamed or empty entries', () => {
    const m = mapped({
      skills: [{ name: 'Go' }, { name: null }, { name: '' }],
      tools: [{ name: 'Docker' }],
    })
    expect(m.tags).toEqual(['Go', 'Docker'])
  })
})

describe('the tag cap and the native identity', () => {
  it('takes the native identity from the listing id', () => {
    expect(fourDayWeekSpec.nativeIdOf(listing({ id: 'native-42' }), cfg())).toBe('native-42')
  })
})

describe('the role-scope gate keeps the open-gap record out of the HR queue', () => {
  it('marks the Construction Manager record OUT_OF_SCOPE even with every technical role reachable', async () => {
    const { batch } = await run([{ ...page(), has_more: false }])
    const o = batch.observations.find(
      (x) => x.normalized.title === 'Construction Manager - Tunnels',
    )
    expect(o).toBeDefined()
    // Broadest roster: every technical role reachable, so only the title and tags can close the gate.
    const status = roleScopeGate({
      title: o?.normalized.title ?? '',
      tags: o?.normalized.tags ?? [],
      layer1Rejected: false,
      reachable: new Set(TECHNICAL_ROLES),
    })
    expect(status).toBe('OUT_OF_SCOPE')
  })
})
