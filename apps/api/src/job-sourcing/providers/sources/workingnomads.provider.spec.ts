import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { UnvalidatedConfigError } from '../reporting-provider'
import {
  matchesCategory,
  tagsOf,
  WORKINGNOMADS_ENDPOINT,
  WORKINGNOMADS_SOURCE_STATUS,
  workingNomadsProvider,
  workingNomadsSpec,
} from './workingnomads.provider'

/**
 * Working Nomads through its public provider. Expected values are hand-read from
 * `__fixtures__/workingnomads/exposed-jobs.json` (an authentic capture of 2026-11-19, permitted by
 * the owner's 2026-11-16 decision; see its provenance file) and written here as literals, never
 * produced by running the mapper.
 *
 * The feed carries SIX records in the fixture: two `Development` (what the seeded config asks for)
 * and one each of four other categories, so the client-side filter is exercised on both sides.
 */
const NOW = new Date('2026-11-19T12:00:00Z')
/** The config the production seed row carries, byte for byte. */
const SEEDED = { categories: ['development'] }
const cfg = (extra: Record<string, unknown> = {}) =>
  workingNomadsProvider.parseConfig({ configVersion: 1, ...SEEDED, ...extra })
const feed = () => sourceFixture('workingnomads', 'exposed-jobs') as Record<string, unknown>[]

async function run(
  body: unknown,
  opts: { status?: number; config?: Record<string, unknown> } = {},
) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [
      {
        status: opts.status ?? 200,
        bodyText: typeof body === 'string' ? body : JSON.stringify(body),
      },
    ],
  })
  const batch = await workingNomadsProvider.collectReport(cfg(opts.config), f.ctx)
  return { batch, f }
}

describe('the category filter is client-side, because the endpoint takes no parameter', () => {
  it('sends ONE unparameterised GET and never a category in the URL', async () => {
    const { f } = await run(feed())
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.url).toBe(WORKINGNOMADS_ENDPOINT)
    expect(f.sent[0]?.url).not.toContain('development')
  })

  it('keeps the two Development records out of the six and discards the other four', async () => {
    const { batch } = await run(feed())
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['2007847', '2019516'])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('matches Title Case against the lower-case config: the seeded value matches nothing otherwise', () => {
    expect(matchesCategory('Development', ['development'])).toBe(true)
    expect(matchesCategory('development', ['Development'])).toBe(true)
    expect(matchesCategory(' Development ', ['development'])).toBe(true)
    expect(matchesCategory('Marketing', ['development'])).toBe(false)
    expect(matchesCategory('Dev', ['development'])).toBe(false)
    // Not a string: a record whose category is a number or absent is not a match by accident.
    expect(matchesCategory(undefined, ['development'])).toBe(false)
    expect(matchesCategory(7, ['development'])).toBe(false)
  })

  it('a config naming another category keeps that one instead', async () => {
    const { batch } = await run(feed(), { config: { categories: ['marketing'] } })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['2027058'])
  })

  it('a config naming two categories keeps both', async () => {
    const { batch } = await run(feed(), { config: { categories: ['development', 'education'] } })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      '2007847',
      '2019516',
      '1977929',
    ])
  })
})

describe('mapping the authentic capture', () => {
  it('maps every field of the first Development record (hand-read from the capture)', async () => {
    const { batch } = await run(feed())
    const o = batch.observations[0]
    expect(o?.identity).toMatchObject({
      provider: 'WORKINGNOMADS_API',
      namespace: 'workingnomads',
      nativeId: '2007847',
      identityKind: 'NATIVE_ID',
    })
    // The URL policy drops the trailing slash; the identity above keeps the id it carried.
    expect(o?.sourcePostingUrl).toBe('https://www.workingnomads.com/job/go/2007847')
    // The payload carries no application URL of its own: the posting URL is the only address.
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe('Data Analyst (No Experience Required)')
    expect(o?.normalized.companyName).toBe('Peroptyx')
    expect(o?.normalized.location).toBe('Canada')
    // A remote-only board by the site's definition; the free-text location is not the verdict.
    expect(o?.normalized.remote).toBe(true)
    // `tags` arrives as ONE comma-separated string.
    expect(o?.normalized.tags).toEqual(['data analyst', 'english'])
    expect(o?.adapterVersion).toBe('workingnomads-1')
  })

  it('reads the offset-bearing pub_date as the published instant, not a bare date', async () => {
    const { batch } = await run(feed())
    expect(batch.observations[0]?.normalized.publishedAt?.toISOString()).toBe(
      '2026-11-09T12:35:52.000Z',
    )
  })

  it('splits a multi-tag string and keeps a long free-text location as it came', async () => {
    const { batch } = await run(feed())
    const o = batch.observations[1]
    expect(o?.normalized.tags).toEqual(['qa', 'tech', 'mobile', 'testing'])
    expect(o?.normalized.location).toBe(
      'Switzerland, Belgium, Luxembourg, Sweden, Denmark, Norway, Finland, Saudi Arabia and Israel',
    )
  })

  it('a record whose url is not the /job/go/<id>/ shape is keyed by its URL, not by a made-up id', async () => {
    const odd = { ...feed()[0], url: 'https://www.workingnomads.com/jobs' }
    const { batch } = await run([odd])
    expect(batch.counts.raw).toBe(1)
    expect(batch.counts.normalized).toBe(1)
    const o = batch.observations[0]
    expect(o?.identity.identityKind).not.toBe('NATIVE_ID')
    expect(o?.identity.nativeId).toBeNull()
  })
})

describe('coverage and the loop', () => {
  it('a clean run is a WINDOW over the latest feed, never a full inventory', async () => {
    const { batch } = await run(feed())
    expect(batch.scope.query).toBe('latest-feed')
    expect(batch.coverage).toBe('WINDOW')
  })

  it('asks for ONE page: the response has no page, count or cursor field to follow', async () => {
    const { f } = await run(feed())
    expect(f.sent).toHaveLength(1)
  })

  it('refuses a config that was never validated', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '[]' }] })
    await expect(
      workingNomadsProvider.collectReport(
        { namespace: 'workingnomads', configVersion: 1, categories: ['development'] } as never,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toHaveLength(0)
  })
})

describe('parseConfig', () => {
  it('accepts the seeded production config and defaults the namespace', () => {
    expect(cfg()).toMatchObject({
      namespace: 'workingnomads',
      categories: ['development'],
      query: null,
      window: null,
    })
  })

  it.each([
    ['no category at all', { categories: [] }],
    ['a category that is not a string', { categories: [7] }],
    ['an unknown key', { nope: 1 }],
    ['a search query, which the endpoint has no parameter for', { query: 'senior' }],
    ['a date window, which the endpoint has no parameter for', { window: { from: NOW, to: NOW } }],
  ])('refuses %s', (_label, extra) => {
    expect(() => cfg(extra)).toThrow()
  })
})

describe('the recorded evidence', () => {
  it('the status is unblocked by the owner decision, and the permission still says UNCLEAR', () => {
    expect(WORKINGNOMADS_SOURCE_STATUS.blocked).toBe(false)
    expect(WORKINGNOMADS_SOURCE_STATUS.permission).toBe('UNCLEAR')
    // The reason cites the decision, which is the only thing that lifts an UNCLEAR permission.
    expect(WORKINGNOMADS_SOURCE_STATUS.reason).toContain('2026-11-16')
    expect(WORKINGNOMADS_SOURCE_STATUS.reason).toContain('ACCEPT_RISK')
  })

  it('both committed fixtures say UNCLEAR: the capture did not upgrade the permission', () => {
    for (const name of ['terms.html', 'exposed-jobs']) {
      const p = sourceProvenance('workingnomads', name) as { permission: string }
      expect(p.permission).toBe('UNCLEAR')
    }
  })

  it('the capture provenance records the measurements the adapter is built on', () => {
    const p = sourceProvenance('workingnomads', 'exposed-jobs') as { notes: string; url: string }
    expect(p.url).toBe(WORKINGNOMADS_ENDPOINT)
    expect(p.notes).toContain('CLIENT-SIDE')
    expect(p.notes).toContain('comma-separated')
  })
})

/**
 * The boundaries the mutation gate found unguarded (CR-H-2). Each case is a value the adapter's own
 * contract comment claims to handle, asserted on behaviour rather than on shape.
 */
const RECORD = {
  url: 'https://www.workingnomads.com/job/go/900001/',
  title: 'Senior Engineer',
  company_name: 'Acme',
  category_name: 'Development',
  location: 'Anywhere in the world',
  description: 'A role.',
  tags: 'typescript,remote',
  pub_date: '2026-11-18T07:35:52-05:00',
}
const one = async (extra: Record<string, unknown>) => {
  const { batch } = await run([{ ...RECORD, ...extra }])
  return batch.observations[0]
}

describe('the identity regex reads only the job/go/<id> shape', () => {
  it.each([
    ['https://www.workingnomads.com/job/go/900001/', '900001'],
    ['https://www.workingnomads.com/job/go/900001', '900001'],
    ['https://www.workingnomads.com/job/go/900001/apply', null],
    ['https://www.workingnomads.com/job/go/abc/', null],
    ['https://www.workingnomads.com/jobs/900001/', null],
    ['https://www.workingnomads.com/job/go/', null],
  ])('%s is keyed by %s', async (url, nativeId) => {
    const o = await one({ url })
    // `nativeIdOf` and `mapItem` read the same regex, so the identity is one answer, not two:
    // the id when the shape matches, and the URL fallback when it does not.
    expect(o?.identity.nativeId).toBe(nativeId)
    expect(o?.identity.identityKind).toBe(nativeId === null ? 'URL_FALLBACK' : 'NATIVE_ID')
  })
})

describe('the category match ignores surrounding space as well as case', () => {
  it('matches a padded category name against a padded config value', () => {
    expect(matchesCategory('  Development  ', [' development '])).toBe(true)
    expect(matchesCategory('Development', ['development'])).toBe(true)
  })

  it('does not match a different category, padded or not', () => {
    expect(matchesCategory('  Marketing  ', [' development '])).toBe(false)
  })

  it('a category name that is not a string is not a match', () => {
    expect(matchesCategory(7, ['development'])).toBe(false)
    expect(matchesCategory(null, ['development'])).toBe(false)
  })
})

describe('the client-side filter drops what cannot carry a category', () => {
  it('keeps the one real record out of a feed of non-objects and strangers', async () => {
    const { batch } = await run([
      null,
      'a string',
      42,
      { title: 'no category here', url: RECORD.url, pub_date: RECORD.pub_date },
      RECORD,
    ])
    expect(batch.counts.raw).toBe(1)
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['900001'])
  })
})

describe('tags: one comma-separated string, trimmed and bounded', () => {
  it('trims each tag and drops the empty ones', async () => {
    expect((await one({ tags: ' a , ,b,  ' }))?.normalized.tags).toEqual(['a', 'b'])
  })

  it('a null tags field is no tags, not a tag', async () => {
    expect((await one({ tags: null }))?.normalized.tags).toEqual([])
  })

  // The two bounds below are asserted on `tagsOf` directly: the display caps in
  // `buildNormalizedPosting` (50 tags of 60 characters) are stricter, so they cut first and a run of
  // the provider cannot tell these bounds from those.
  it('keeps a tag of exactly the original limit and drops one character longer', () => {
    const atLimit = 'x'.repeat(ORIGINAL_LIMITS.tag)
    const overLimit = 'y'.repeat(ORIGINAL_LIMITS.tag + 1)
    expect(tagsOf(`${atLimit},${overLimit}`)).toEqual([atLimit])
  })

  it('keeps at most the original tag count', () => {
    const many = Array.from({ length: ORIGINAL_LIMITS.tags + 5 }, (_, i) => `t${i}`)
    const got = tagsOf(many.join(','))
    expect(got).toHaveLength(ORIGINAL_LIMITS.tags)
    expect(got[ORIGINAL_LIMITS.tags - 1]).toBe(`t${ORIGINAL_LIMITS.tags - 1}`)
  })

  it('an empty string is no tags', () => {
    expect(tagsOf('')).toEqual([])
    expect(tagsOf(null)).toEqual([])
  })
})

describe('the request and the loop bounds are the ones the capture measured', () => {
  it('asks for JSON explicitly', async () => {
    const { f } = await run(feed())
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
  })

  it('bounds the loop at one page of at most 500 records', () => {
    expect(workingNomadsSpec.limits).toEqual({ maxPages: 1, maxItemsPerPage: 500 })
  })

  it('names the one feed it caches', () => {
    expect(workingNomadsSpec.pageRequest({} as never, {} as never)).toEqual({
      request: { url: WORKINGNOMADS_ENDPOINT, headers: { accept: 'application/json' } },
      cacheKey: 'feed',
    })
  })
})

describe('the config refuses the two parameters this endpoint does not have', () => {
  it('refuses a search query, and says why', () => {
    expect(() => cfg({ query: 'react' })).toThrow('Working Nomads has no search parameter')
  })

  it('refuses a date window, and says why', () => {
    expect(() => cfg({ window: { from: '2026-11-01', to: '2026-11-19' } })).toThrow(
      'Working Nomads has no date window',
    )
  })
})
