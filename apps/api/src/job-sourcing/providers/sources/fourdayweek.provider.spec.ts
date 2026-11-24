import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture } from '../../../test/source-fixtures'
import {
  FOURDAYWEEK_ENDPOINT,
  FOURDAYWEEK_MAX_PAGES_DEFAULT,
  fourDayWeekProvider,
  remoteOf,
} from './fourdayweek.provider'
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
