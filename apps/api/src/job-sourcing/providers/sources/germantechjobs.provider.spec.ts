import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import {
  ALLOWLISTED_BYTE_CAP_SOURCES,
  DEFAULT_MAX_BYTES,
  MAX_RESPONSE_BYTES_CEILING,
} from '../../http/bounded-fetch'
import { classifyRoles } from '../../funnel/role-classifier'
import { DISPLAY_TITLE_CHARS } from '../../normalize/build-posting'
import { isNonItTitle } from './non-it-title'
import {
  GERMANTECHJOBS_ENDPOINT,
  GERMANTECHJOBS_MAX_BYTES,
  germanTechJobsProvider,
  germanTechJobsSpec,
  remoteOf,
} from './germantechjobs.provider'
/**
 * GermanTechJobs through its public provider. Expected values are hand-read from
 * `__fixtures__/germantechjobs/jobs-light.json` (a trimmed authentic capture of 2026-11-24; its
 * provenance file sits beside it) and written here as literals, never produced by the mapper.
 *
 * The six records are: one DEACTIVATED (skipped), one `remote`, one `hybrid`, three `office`.
 */
const NOW = new Date('2026-11-24T12:00:00Z')
const cfg = (extra: Record<string, unknown> = {}) =>
  germanTechJobsProvider.parseConfig({ configVersion: 1, ...extra })
const feed = () => sourceFixture('germantechjobs', 'jobs-light') as Record<string, unknown>[]

async function run(body: unknown, opts: { status?: number } = {}) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [
      {
        status: opts.status ?? 200,
        bodyText: typeof body === 'string' ? body : JSON.stringify(body),
      },
    ],
  })
  const batch = await germanTechJobsProvider.collectReport(cfg(), f.ctx)
  return { batch, f }
}

describe('one plain GET of the light listing feed', () => {
  it('sends ONE request to the jobsLight endpoint and nothing else', async () => {
    const { f } = await run(feed())
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.url).toBe(GERMANTECHJOBS_ENDPOINT)
    expect(GERMANTECHJOBS_ENDPOINT).toBe('https://germantechjobs.de/api/jobsLight')
    // The declared cap is the one the transport enforces, not just a constant nobody reads.
    expect(f.sent[0]?.maxBytes).toBe(GERMANTECHJOBS_MAX_BYTES)
  })

  it('skips the deactivated record and the non-IT sales record, keeps the four IT ones', async () => {
    const { batch } = await run(feed())
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 4,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      '6a7b8d40225a25660fac6cf3',
      '6aa7c7179bc0a0fe1c815718',
      '6aa248e00f4a157b69cde6de',
      '6a4640a3742cb6a626e795c0',
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('drops a title the funnel classifies NON_IT, and keeps every title it does not', () => {
    expect(isNonItTitle('Exclusive Mandate: Strategic Sales Director Telco')).toBe(true)
    expect(isNonItTitle('Senior Software Engineer (m/w/d) – Schwerpunkt LLM – pricenxt')).toBe(
      false,
    )
    expect(isNonItTitle('ServiceNow Solution Architect (w/m/d) - Munich')).toBe(false)
  })
})

describe('mapping the authentic capture', () => {
  it('maps every field of the first live record, the remote one (hand-read)', async () => {
    const { batch } = await run(feed())
    const o = batch.observations[0]
    expect(o?.identity).toMatchObject({
      provider: 'GERMANTECHJOBS_API',
      namespace: 'germantechjobs',
      nativeId: '6a7b8d40225a25660fac6cf3',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://germantechjobs.de/jobs/KI-Group-Senior-Software-Engineer-mwd--Schwerpunkt-LLM--pricenxt',
    )
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe(
      'Senior Software Engineer (m/w/d) – Schwerpunkt LLM – pricenxt',
    )
    expect(o?.normalized.companyName).toBe('KI Group')
    expect(o?.normalized.location).toBe('Bad Homburg')
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.tags).toHaveLength(11)
    // `filterTags`, not `techCategory`: the category is not a tag.
    expect(o?.normalized.tags).toContain('LLM')
    expect(o?.adapterVersion).toBe('germantechjobs-1')
  })

  it('reads the offset-bearing activeFrom as the published instant', async () => {
    const { batch } = await run(feed())
    // 2026-11-14T00:00:00.000+01:00
    expect(batch.observations[0]?.normalized.publishedAt?.toISOString()).toBe(
      '2026-11-13T23:00:00.000Z',
    )
    // 2026-11-24T17:30:49.230+00:00 (an office record)
    expect(batch.observations[2]?.normalized.publishedAt?.toISOString()).toBe(
      '2026-11-24T17:30:49.230Z',
    )
  })

  it('maps workplace to remoteness: remote is true, office is false', async () => {
    const { batch } = await run(feed())
    expect(batch.observations[0]?.normalized.remote).toBe(true)
    expect(batch.observations[1]?.normalized.remote).toBe(false)
    expect(batch.observations[2]?.normalized.remote).toBe(false)
    expect(batch.observations[3]?.normalized.remote).toBe(false)
  })

  it('a hybrid or absent workplace is unknown (null), neither remote nor on-site', () => {
    // The only hybrid record in the capture is the non-IT sales one, so the rule is pinned on the mapper.
    expect(remoteOf('hybrid')).toBeNull()
    expect(remoteOf(null)).toBeNull()
  })

  it('carries no description: the light feed has none, so none is invented', async () => {
    const { batch } = await run(feed())
    expect(batch.observations[0]?.normalized.description ?? null).toBeNull()
  })
})

describe('the declared byte cap and item cap', () => {
  it('declares 4 MiB: above the 2 MiB default, under the shared 10 MiB ceiling, with no allowlist entry', () => {
    expect(GERMANTECHJOBS_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(GERMANTECHJOBS_MAX_BYTES).toBeGreaterThan(DEFAULT_MAX_BYTES)
    expect(GERMANTECHJOBS_MAX_BYTES).toBeLessThanOrEqual(MAX_RESPONSE_BYTES_CEILING)
    expect(ALLOWLISTED_BYTE_CAP_SOURCES.GERMANTECHJOBS_API).toBeUndefined()
    expect(germanTechJobsSpec.type).toBe('GERMANTECHJOBS_API')
  })

  it('a body of exactly the 4 MiB cap is read; one byte more is PAYLOAD_TOO_LARGE with nothing kept', async () => {
    // Trailing whitespace is valid JSON, so the padded body is the same feed at an exact size.
    const base = JSON.stringify(feed())
    const at = base + ' '.repeat(GERMANTECHJOBS_MAX_BYTES - Buffer.byteLength(base))
    expect(Buffer.byteLength(at)).toBe(GERMANTECHJOBS_MAX_BYTES)
    expect((await run(at)).batch.outcome).toBe('SUCCEEDED')

    const past = `${at} `
    const { batch, f } = await run(past)
    expect(f.pageBytes).toEqual([GERMANTECHJOBS_MAX_BYTES + 1])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.observations).toEqual([])
  })

  it('a feed over the 5000-record item cap is refused as PAYLOAD_TOO_LARGE, not cut to 5000', async () => {
    // Refused before mapping: the framework never truncates, so no record of an over-cap page is kept.
    const many = Array.from({ length: 5001 }, (_, i) => ({
      _id: `cap${i}`,
      jobUrl: `cap-${i}`,
      name: 'Backend Engineer',
      activeFrom: '2026-11-14T00:00:00.000+01:00',
    }))
    const { batch } = await run(many)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.observations).toEqual([])
  })
  it('a feed over the cap is refused even when every record is a NON_IT title the skip would drop', async () => {
    // The cap counts the raw records, so skipping NON_IT rows cannot shrink an over-cap feed under it.
    const many = Array.from({ length: 5001 }, (_, i) => ({
      _id: `non-it${i}`,
      jobUrl: `non-it-${i}`,
      name: 'Exclusive Mandate: Strategic Sales Director Telco',
      activeFrom: '2026-11-14T00:00:00.000+01:00',
    }))
    const { batch } = await run(many)
    expect(batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.observations).toEqual([])
  })
})

/** One listing as the feed sends it, with only what a test varies overridden. */
const listing = (extra: Record<string, unknown> = {}) =>
  germanTechJobsSpec.itemSchema.parse({
    _id: 'gtj-probe',
    jobUrl: 'probe-slug',
    name: 'Backend Engineer',
    activeFrom: '2026-11-14T00:00:00.000+01:00',
    ...extra,
  })

describe('the spec seams the capture cannot reach', () => {
  it('scopes a clean run to the jobs-light feed, as a WINDOW', () => {
    expect(germanTechJobsSpec.scopeOf(cfg(), NOW)).toEqual({
      namespace: 'germantechjobs',
      query: 'jobs-light',
      configVersion: 1,
      window: null,
    })
  })

  it('refuses a search parameter and a date window: the feed has neither', () => {
    expect(() => cfg({ query: 'python' })).toThrow('GermanTechJobs has no search parameter')
    expect(() => cfg({ window: { from: '2026-01-01', to: '2026-02-01' } })).toThrow(
      'GermanTechJobs has no date window',
    )
  })

  it('sends the one GET with a JSON accept header, under the feed cache key', () => {
    const req = germanTechJobsSpec.pageRequest(cfg(), { page: 1, cursor: null, window: null })
    expect(req.request).toEqual({
      url: GERMANTECHJOBS_ENDPOINT,
      headers: { accept: 'application/json' },
    })
    expect(req.cacheKey).toBe('feed')
  })

  it('drops non-record elements, a deactivated listing and a NON_IT title; keeps the rest', () => {
    const data = [
      null,
      'x',
      7,
      { _id: 'a', name: 'Backend Engineer', deactivatedOn: '2026-11-20' },
      { _id: 'b', name: 'Backend Engineer', deactivatedOn: null },
      { _id: 'c', name: 'Exclusive Mandate: Strategic Sales Director Telco' },
      { _id: 'd', name: 7 },
      { _id: 'e' },
    ]
    const kept = germanTechJobsSpec
      .extractItems(data, cfg())
      .filter((item) => !germanTechJobsSpec.skipItem?.(item, cfg()))
    expect(kept).toEqual([
      { _id: 'b', name: 'Backend Engineer', deactivatedOn: null },
      { _id: 'd', name: 7 },
      { _id: 'e' },
    ])
  })
  it('ingests a cap-filling page of 1,900 slow-shape titles and classifies each on its display prefix', async () => {
    // 1,900 records of 2,000-char titles fill the 4 MiB cap. Even records carry the SR-H-2 filler:
    // its 500-char display prefix ends in spaces, so it is NON_IT exactly as the funnel would call it,
    // and dropped. Odd records carry an engineer noun before the space run: kept, then classified as
    // the funnel does. The stopwatch half (this page against an ordinary one) runs alone in
    // `germantechjobs.provider.timing.spec.ts`: inside the parallel suite a ratio cannot tell the
    // fixed code from the old. Pinned here deterministically, what makes the page cheap: every
    // classified title is at most DISPLAY_TITLE_CHARS long, and `role-classifier.spec.ts` pins that
    // the classifier is linear in the title length.
    const srH2 = `архітектор проєктувальн${' '.repeat(2_000 - 24)}x`
    const engineer = `інженер ${' '.repeat(2_000 - 9)}x`
    const body = JSON.stringify(
      Array.from({ length: 1_900 }, (_, i) => ({
        _id: `filler-${i}`,
        jobUrl: `filler-${i}`,
        name: i % 2 === 0 ? srH2 : engineer,
        company: 'Probe GmbH',
        activeFrom: '2026-11-14T00:00:00.000+01:00',
      })),
    )
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(GERMANTECHJOBS_MAX_BYTES)

    const { batch } = await run(body)
    const titles = batch.observations.map((o) => o.normalized.title)

    expect(batch.counts).toMatchObject({ raw: 950, normalized: 950 })
    expect(Math.max(...titles.map((t) => t.length))).toBe(DISPLAY_TITLE_CHARS)
    expect(new Set(titles.map((title) => classifyRoles({ title, tags: [] }).kind))).toEqual(
      new Set(['UNCLASSIFIED']),
    )
  })

  it('takes the native identity from _id, never from the slug', () => {
    expect(germanTechJobsSpec.nativeIdOf(listing(), cfg())).toBe('gtj-probe')
  })

  it('rejects a slug with characters outside the URL-safe set, and an empty one', () => {
    expect(
      germanTechJobsSpec.itemSchema.safeParse({ ...listing(), jobUrl: 'has space' }).success,
    ).toBe(false)
    expect(germanTechJobsSpec.itemSchema.safeParse({ ...listing(), jobUrl: '' }).success).toBe(
      false,
    )
    expect(
      germanTechJobsSpec.itemSchema.safeParse({ ...listing(), jobUrl: 'Ok-Slug-1' }).success,
    ).toBe(true)
  })
})
