import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import {
  ALLOWLISTED_BYTE_CAP_SOURCES,
  DEFAULT_MAX_BYTES,
  MAX_RESPONSE_BYTES_CEILING,
} from '../../http/bounded-fetch'
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
})
