import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { MAX_JSON_BYTES } from '../bounded-json'
import { UnvalidatedConfigError } from '../reporting-provider'
import { arbeitnowProvider, ARBEITNOW_SOURCE_STATUS } from './arbeitnow.provider'

/**
 * Arbeitnow through its public provider. Expected values are hand-read from
 * `__fixtures__/arbeitnow/page-1.json` (authentic capture, 7 of 300 jobs; see the provenance file)
 * and written as literals - never produced by running the mapper.
 */

const NOW = new Date('2026-10-24T03:00:00Z')
const cfg = (extra: Record<string, unknown> = {}) =>
  arbeitnowProvider.parseConfig({ configVersion: 1, ...extra })

type Envelope = { data: Record<string, unknown>[] } & Record<string, unknown>
const authentic = () => sourceFixture('arbeitnow', 'page-1') as Envelope
/** The capture's page 1 carries a next-link; a single-page test needs the last page of a walk. */
const page = () => ({ ...authentic(), links: { ...(authentic().links as object), next: null } })
const jobs = () => authentic().data
const withJobs = (j: unknown[]) => ({ ...page(), data: j })

async function run(body: unknown, config = cfg(), status = 200) {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [{ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body) }],
  })
  const batch = await arbeitnowProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const bySlug = (batch: Batch, slug: string) =>
  batch.observations.find((o) => o.identity.nativeId === slug)

const FIRST = 'inside-solutions-engineer-454685'
const ZURICH = 'creative-marketing-manager-60-a-zurich-21603'
const HOMEOFFICE = 'b2b-sales-managerin-dach-markt-homeoffice-50-freelance-zurich-157831'
const GRAPHIC = 'graphic-designer-puchheim-347117'
const LILLE = 'ingenieur-commercial-it-lille-h-f-144089'
const HAGUE = 'solution-architect-remote-from-eu-the-hague-200819'

describe('mapping the authentic capture', () => {
  it('turns the 7 jobs into 7 observations', async () => {
    const { batch } = await run(page())
    expect(batch.counts).toEqual({
      raw: 7,
      normalized: 7,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('maps every field of the first job (hand-read)', async () => {
    const { batch } = await run(page())
    const o = bySlug(batch, FIRST)
    expect(o?.identity).toMatchObject({
      provider: 'ARBEITNOW_API',
      namespace: 'arbeitnow',
      nativeId: FIRST,
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe(
      'https://www.arbeitnow.com/jobs/companies/beyondtrust/inside-solutions-engineer-454685',
    )
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe('Inside Solutions Engineer')
    expect(o?.normalized.companyName).toBe('beyondtrust')
    expect(o?.normalized.tags).toEqual(['Sales Engineering'])
    expect(o?.adapterVersion).toBe('arbeitnow-1')
  })

  it('reads created_at as Unix SECONDS: 1792799718 is 2026-10-23T23:55:18Z, not a 1970 millisecond date', async () => {
    const { batch } = await run(page())
    expect(bySlug(batch, FIRST)?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-23T23:55:18.000Z',
    )
    expect(bySlug(batch, ZURICH)?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-23T13:30:55.000Z',
    )
    expect(bySlug(batch, HAGUE)?.normalized.publishedAt?.toISOString()).toBe(
      '2026-10-23T02:31:10.000Z',
    )
    expect(bySlug(batch, FIRST)?.normalized.dates).toEqual([
      {
        semantics: 'PUBLISHED',
        contract: 'UNIX_SECONDS',
        raw: '1792799718',
        status: 'OK',
        value: new Date('2026-10-23T23:55:18.000Z'),
      },
    ])
  })

  it('keeps remote:false false - even when the title says Remote - and remote:true true', async () => {
    const { batch } = await run(page())
    expect(bySlug(batch, FIRST)?.normalized.remote).toBe(false)
    expect(bySlug(batch, ZURICH)?.normalized.remote).toBe(false)
    expect(bySlug(batch, LILLE)?.normalized.remote).toBe(false)
    expect(bySlug(batch, HOMEOFFICE)?.normalized.remote).toBe(true)
    expect(bySlug(batch, GRAPHIC)?.normalized.remote).toBe(true)
    expect(bySlug(batch, HAGUE)?.normalized.remote).toBe(true)

    // The authentic case from the full capture: title says "Full Remote", the provider flag says false.
    const contradicting = {
      ...jobs()[0],
      slug: 'security-engineer-full-remote-netherlands-46968',
      title: 'Security Engineer (Full Remote - Netherlands)',
      remote: false,
    }
    const again = await run(withJobs([contradicting]))
    expect(again.batch.observations[0]?.normalized.remote).toBe(false)
  })

  it('an ABSENT or null remote flag is unknown (null), which is not false', async () => {
    const { remote: _r, ...noFlag } = jobs()[0] as Record<string, unknown>
    for (const j of [noFlag, { ...noFlag, remote: null }]) {
      const o = (await run(withJobs([j]))).batch.observations[0]
      expect(o?.normalized.remote).toBeNull()
    }
  })

  it('an empty location is no location; a present one is kept', async () => {
    const { batch } = await run(page())
    expect(bySlug(batch, FIRST)?.normalized.location).toBeNull()
    expect(bySlug(batch, ZURICH)?.normalized.location).toBe('Zürich')
    expect(bySlug(batch, LILLE)?.normalized.location).toBe('LILLE, Hauts-de-France, France')
    expect(bySlug(batch, HAGUE)?.normalized.location).toBe('Remote job')
  })

  it('carries the provider tags and the contract words as tags, de-duplicated', async () => {
    const { batch } = await run(page())
    expect(bySlug(batch, HOMEOFFICE)?.normalized.tags).toEqual([
      'Remote',
      'Management',
      'Team Leader',
      'Unbefristeter arbeitsvertrag',
      'teamleitung',
    ])
    expect(bySlug(batch, LILLE)?.normalized.tags).toEqual(['Mid', 'fulltime permanent'])
    // 'Remote' appears in tags only once even though a job type could repeat it.
    const dup = { ...jobs()[0], tags: ['Remote'], job_types: ['Remote', 'Full time'] }
    expect((await run(withJobs([dup]))).batch.observations[0]?.normalized.tags).toEqual([
      'Remote',
      'Full time',
    ])
  })

  it('shows an entity-escaped description as text, not as literal tags; real markup is untouched', async () => {
    const { batch } = await run(page())
    const escaped = bySlug(batch, FIRST)?.normalized.descriptionMd ?? ''
    expect(escaped).toContain('BeyondTrust is a place where you can bring your purpose to life')
    expect(escaped).not.toContain('&lt;')
    expect(escaped).not.toContain('<p>')
    expect(escaped).not.toContain('\\<p\\>')
    expect(escaped).not.toContain('nbsp')
    // The provider's own real-markup footer (the link back its terms ask for) survives.
    expect(escaped).toContain('[Jobs in Germany](<https://www.arbeitnow.com>)')
    const real = bySlug(batch, ZURICH)?.normalized.descriptionMd ?? ''
    expect(real).toContain('Umsetzung der Marketingmassnahmen')
    expect(real).not.toContain('<h2>')
    // Markup that merely MENTIONS an escaped tag inside real markup is not unescaped.
    const mixed = { ...jobs()[0], description: '<p>write &lt;b&gt; in a comment</p>' }
    const o = (await run(withJobs([mixed]))).batch.observations[0]
    expect(o?.normalized.descriptionMd).toContain('write \\<b\\> in a comment')
  })

  it('identity survives a changed title, url and description', async () => {
    const a = await run(page())
    const { batch } = await run(
      withJobs([
        {
          ...jobs()[0],
          title: 'Renamed',
          url: 'https://www.arbeitnow.com/jobs/companies/beyondtrust/other',
          description: '<p>other</p>',
        },
      ]),
    )
    expect(batch.observations[0]?.identity.identityKey).toBe(
      bySlug(a.batch, FIRST)?.identity.identityKey,
    )
  })
})

describe('the byte cap is not raised and the page is not cut (the reason this source is blocked)', () => {
  const capture = (name: string) =>
    gunzipSync(
      readFileSync(join(__dirname, '__fixtures__', 'raw-captures-3.2', `${name}.raw.gz`)),
    ).toString('utf8')

  /** "Nothing kept" is four claims: no observation, all counts zero, no checkpoint, one request. */
  function expectNothingKept(batch: Batch, f: Awaited<ReturnType<typeof run>>['f']) {
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.observations).toEqual([])
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(f.saved).toEqual([])
    expect(f.sent).toHaveLength(1)
  }

  it('the authentic page 1 is 4209793 bytes - past the 2 MiB cap - and fails as PAYLOAD_TOO_LARGE with nothing kept', async () => {
    const body = capture('an-p1')
    expect(Buffer.byteLength(body)).toBe(4209793)
    expect(MAX_JSON_BYTES).toBe(2097152)
    const { batch, f } = await run(body)
    expectNothingKept(batch, f)
  })

  it('the authentic page 2 (2311796 bytes) is refused the same way', async () => {
    const body = capture('an-p2')
    expect(Buffer.byteLength(body)).toBe(2311796)
    const { batch, f } = await run(body)
    expectNothingKept(batch, f)
  })

  it('a body of exactly 2097152 bytes is read; one byte more is refused', async () => {
    const skeleton = JSON.stringify({ data: [], links: { next: null }, pad: '' })
    const fill = (bytes: number) =>
      JSON.stringify({ data: [], links: { next: null }, pad: 'x'.repeat(bytes - skeleton.length) })
    const atCap = fill(MAX_JSON_BYTES)
    expect(Buffer.byteLength(atCap)).toBe(MAX_JSON_BYTES)
    expect((await run(atCap)).batch.outcome).toBe('SUCCEEDED')
    const past = fill(MAX_JSON_BYTES + 1)
    expect(Buffer.byteLength(past)).toBe(MAX_JSON_BYTES + 1)
    expect((await run(past)).batch.requests[0]?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('declares itself blocked with the measured sizes - and the provenance agrees', () => {
    expect(ARBEITNOW_SOURCE_STATUS.blocked).toBe(true)
    expect(ARBEITNOW_SOURCE_STATUS.permission).toBe('PUBLIC_API_DOCUMENTED')
    expect(ARBEITNOW_SOURCE_STATUS.reason).toContain('4209793')
    expect(ARBEITNOW_SOURCE_STATUS.reason).toContain('2097152')
    const p = sourceProvenance('arbeitnow', 'page-1') as { permission: string; notes: string }
    expect(p.permission).toBe(ARBEITNOW_SOURCE_STATUS.permission)
    expect(p.notes).toContain('4209793')
    expect(p.notes).toContain('per_page, limit, page_size, size and perPage were tried and ignored')
    expect(p.notes).toContain('link back to Arbeitnow.com')
  })
})

describe('pagination, coverage and requests', () => {
  const pageOf = (n: number, next: string | null) => ({
    data: [{ ...jobs()[0], slug: `job-${n}`, url: `https://www.arbeitnow.com/jobs/job-${n}` }],
    links: { next },
  })

  it('walks ?page=1,2,3 and stops when links.next is null', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: JSON.stringify(pageOf(1, 'https://x/api?page=2')) },
        { bodyText: JSON.stringify(pageOf(2, 'https://x/api?page=3')) },
        { bodyText: JSON.stringify(pageOf(3, null)) },
      ],
    })
    const batch = await arbeitnowProvider.collectReport(cfg(), f.ctx)
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://www.arbeitnow.com/api/job-board-api?page=1',
      'https://www.arbeitnow.com/api/job-board-api?page=2',
      'https://www.arbeitnow.com/api/job-board-api?page=3',
    ])
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['job-1', 'job-2', 'job-3'])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('never follows the next-link as a URL: a link to another host changes nothing', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: JSON.stringify(pageOf(1, 'https://evil.example/steal?page=2')) },
        { bodyText: JSON.stringify(pageOf(2, null)) },
      ],
    })
    await arbeitnowProvider.collectReport(cfg(), f.ctx)
    expect(f.sent.map((r) => new URL(r.url).host)).toEqual([
      'www.arbeitnow.com',
      'www.arbeitnow.com',
    ])
  })

  it('an empty page ends the walk even if it still carries a next-link', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: JSON.stringify({ data: [], links: { next: 'https://x/api?page=2' } }) },
        { bodyText: JSON.stringify(pageOf(2, null)) },
      ],
    })
    const batch = await arbeitnowProvider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(1)
    expect(batch.counts.raw).toBe(0)
  })

  it('the authentic page past the end (data [], next null) is a valid, empty success', async () => {
    const { batch, f } = await run(sourceFixture('arbeitnow', 'empty-page'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
    expect(f.sent).toHaveLength(1)
  })

  it('maxPages is a ceiling: with next-links forever it stops after exactly maxPages requests', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [1, 2, 3, 4].map((n) => ({
        bodyText: JSON.stringify(pageOf(n, `https://x/api?page=${n + 1}`)),
      })),
    })
    const batch = await arbeitnowProvider.collectReport(cfg({ maxPages: 2 }), f.ctx)
    expect(f.sent).toHaveLength(2)
    expect(batch.counts.normalized).toBe(2)
    expect(batch.coverage).toBe('WINDOW')
  })

  it('a clean run is WINDOW, never FULL_INVENTORY, with the feed as its scope', async () => {
    const { batch } = await run(page())
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope).toMatchObject({
      namespace: 'arbeitnow',
      query: 'job-board-feed',
      configVersion: 1,
      window: null,
    })
  })

  it('a non-200 page fails the attempt and keeps nothing', async () => {
    const { batch } = await run('', cfg(), 503)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
  })

  it('a body without a data array is PARSE_DRIFT', async () => {
    const { batch } = await run({ jobs: [] })
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('item bounds, at the limit and past it', () => {
  const job = (over: Record<string, unknown>) => ({ ...jobs()[0], ...over })
  const invalid = async (over: Record<string, unknown>) =>
    (await run(withJobs([job(over)]))).batch.counts.invalid

  it('title 2000 ok / 2001 invalid', async () => {
    expect(await invalid({ title: 'T'.repeat(2000) })).toBe(0)
    expect(await invalid({ title: 'T'.repeat(2001) })).toBe(1)
  })
  it('company 1000 ok / 1001 invalid', async () => {
    expect(await invalid({ company_name: 'C'.repeat(1000) })).toBe(0)
    expect(await invalid({ company_name: 'C'.repeat(1001) })).toBe(1)
  })
  it('slug 500 ok / 501 invalid / empty invalid', async () => {
    expect(await invalid({ slug: 's'.repeat(500) })).toBe(0)
    expect(await invalid({ slug: 's'.repeat(501) })).toBe(1)
    expect(await invalid({ slug: '' })).toBe(1)
  })
  it('location 2000 ok / 2001 invalid', async () => {
    expect(await invalid({ location: 'L'.repeat(2000) })).toBe(0)
    expect(await invalid({ location: 'L'.repeat(2001) })).toBe(1)
  })
  it('tags: 200 ok / 201 invalid, and job_types likewise; a tag of 200 chars ok / 201 invalid', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`)
    expect(await invalid({ tags: many(200) })).toBe(0)
    expect(await invalid({ tags: many(201) })).toBe(1)
    expect(await invalid({ job_types: many(200) })).toBe(0)
    expect(await invalid({ job_types: many(201) })).toBe(1)
    expect(await invalid({ tags: ['t'.repeat(200)] })).toBe(0)
    expect(await invalid({ tags: ['t'.repeat(201)] })).toBe(1)
  })
  it('created_at: a 64-character string is accepted by the shape, 65 is invalid; a non-number is no date', async () => {
    expect(await invalid({ created_at: '1'.repeat(64) })).toBe(0)
    expect(await invalid({ created_at: '1'.repeat(65) })).toBe(1)
  })
  it('300 items on the page are accepted, 301 is drift (the page fails)', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => job({ slug: `s-${i}` }))
    expect((await run(withJobs(many(300)))).batch.counts.raw).toBe(300)
    const bad = await run(withJobs(many(301)))
    expect(bad.batch.outcome).toBe('FAILED')
    expect(bad.batch.observations).toEqual([])
  })
})

describe('missing data', () => {
  it('an empty employer is quarantined, not given a placeholder', async () => {
    const { batch } = await run(withJobs([{ ...jobs()[0], company_name: '' }, jobs()[1]]))
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([ZURICH])
  })
  it('an absent slug, url or employer key is an invalid item', async () => {
    for (const key of ['slug', 'url', 'company_name', 'title']) {
      const { [key]: _gone, ...rest } = jobs()[0] as Record<string, unknown>
      expect((await run(withJobs([rest]))).batch.counts.invalid).toBe(1)
    }
  })
  it('one malformed job is isolated; the rest are kept', async () => {
    const { batch } = await run(withJobs([jobs()[0], { slug: 7 }, jobs()[1]]))
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })
  it('a job with no date, tags, job types or description gets the empty defaults', async () => {
    const {
      created_at: _c,
      tags: _t,
      job_types: _j,
      description: _d,
      location: _l,
      ...bare
    } = jobs()[0] as Record<string, unknown>
    const o = (await run(withJobs([bare]))).batch.observations[0]
    expect(o?.normalized.dates).toEqual([])
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.normalized.tags).toEqual([])
    expect(o?.normalized.descriptionMd).toBe('')
    expect(o?.normalized.location).toBeNull()
  })
})

describe('config errors fail before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['maxPages 0', { maxPages: 0 }],
    ['maxPages 11', { maxPages: 11 }],
    ['maxPages 1.5', { maxPages: 1.5 }],
    ['a query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['another namespace', { namespace: 'other' }],
    ['an unknown key', { pageSize: 20 }],
    ['configVersion 0', { configVersion: 0 }],
    ['configVersion past the integer ceiling', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s and no request is made', (_l, extra) => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{}' }] })
    expect(() => arbeitnowProvider.parseConfig({ configVersion: 1, ...extra })).toThrow()
    expect(f.sent).toHaveLength(0)
  })

  it('refuses a missing configVersion', () => {
    expect(() => arbeitnowProvider.parseConfig({})).toThrow()
  })

  it('accepts maxPages 1 and 10, defaults to the seeded 5, and the largest configVersion', () => {
    expect(cfg({ maxPages: 1 }).maxPages).toBe(1)
    expect(cfg({ maxPages: 10 }).maxPages).toBe(10)
    expect(cfg().maxPages).toBe(5)
    expect(cfg({ configVersion: PG_INT_MAX }).configVersion).toBe(PG_INT_MAX)
  })

  it('collectReport refuses a hand-built config and never fetches', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{}' }] })
    await expect(
      arbeitnowProvider.collectReport(
        { namespace: 'arbeitnow', configVersion: 1, maxPages: 5 } as unknown as ReturnType<
          typeof cfg
        >,
        f.ctx,
      ),
    ).rejects.toBeInstanceOf(UnvalidatedConfigError)
    expect(f.sent).toHaveLength(0)
  })

  it('refusal reasons are the intended ones', () => {
    const reason = (extra: Record<string, unknown>) => {
      try {
        arbeitnowProvider.parseConfig({ configVersion: 1, ...extra })
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      return ''
    }
    expect(reason({ query: 'x' })).toContain('the feed is the scope')
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'Arbeitnow has no date window',
    )
  })
})

describe('checkpoint cursors and next-link shapes', () => {
  const one = (n: number, links?: unknown) =>
    JSON.stringify({
      data: [{ ...jobs()[0], slug: `job-${n}`, url: `https://www.arbeitnow.com/jobs/job-${n}` }],
      ...(links === undefined ? {} : { links }),
    })

  it('saves a literal cursor after each page that has a successor', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: one(1, { next: 'https://x/api?page=2' }) },
        { bodyText: one(2, { next: 'https://x/api?page=3' }) },
        { bodyText: one(3, { next: null }) },
      ],
    })
    await arbeitnowProvider.collectReport(cfg(), f.ctx)
    expect(f.saved[0]?.position).toEqual({ kind: 'CURSOR', page: 1, cursor: 'page:2' })
    expect(f.saved[1]?.position).toEqual({ kind: 'CURSOR', page: 2, cursor: 'page:3' })
  })

  it.each([
    ['no links object', undefined],
    ['an empty links object', {}],
    ['a null next', { next: null }],
    ['an empty next', { next: '' }],
  ])('%s ends the walk after one request', async (_label, links) => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: one(1, links) }, { bodyText: one(2, links) }],
    })
    const batch = await arbeitnowProvider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('SUCCEEDED')
  })
})

describe('escaped descriptions', () => {
  const descriptionOf = async (description: string) =>
    (await run(withJobs([{ ...jobs()[0], description }]))).batch.observations[0]?.normalized
      .descriptionMd

  it('a description that begins with an escaped tag is unescaped once, including a double-escaped ampersand', async () => {
    expect(await descriptionOf('&lt;p&gt;Q&amp;amp;A&lt;/p&gt;')).toBe('Q&A')
  })

  it('a description that begins with a real tag keeps its entities as written', async () => {
    expect(await descriptionOf('<p>Q&amp;amp;A and &lt;i&gt;</p>')).toBe('Q&amp;A and \\<i\\>')
  })

  it('leading whitespace before an escaped tag means it is NOT treated as escaped markup', async () => {
    expect(await descriptionOf(' &lt;p&gt;x&lt;/p&gt;')).toBe('\\<p\\>x\\</p\\>')
  })
})
