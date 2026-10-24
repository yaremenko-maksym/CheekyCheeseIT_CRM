import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceFixture, sourceProvenance } from '../../../test/source-fixtures'
import { PG_INT_MAX } from '../api-json.provider'
import { UnvalidatedConfigError } from '../reporting-provider'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  currentThreadId,
  headerOf,
  hnHiringProvider,
  HN_MAX_COMMENTS,
  hasRoleSignal,
  isMultiRole,
  HN_SOURCE_STATUS,
  remoteOf,
} from './hn-hiring.provider'

/**
 * Hacker News "Who is hiring?" through its public provider. Expected values are hand-read from
 * the authentic captures in `__fixtures__/hn-hiring/` (see the provenance files) and written as
 * literals - never produced by running the mapper.
 */

const NOW = new Date('2026-10-24T03:00:00Z')
const cfg = (extra: Record<string, unknown> = {}) =>
  hnHiringProvider.parseConfig({ configVersion: 1, ...extra })

type Comment = Record<string, unknown> & { id: number; text: string | null; children: Comment[] }
type Thread = { id: number; title: string; children: Comment[] } & Record<string, unknown>
type Hit = Record<string, unknown>
type Search = { hits: Hit[] } & Record<string, unknown>

const search = () => sourceFixture('hn-hiring', 'search') as Search
const octThread = () => sourceFixture('hn-hiring', 'thread-2026-10') as Thread
const sepThread = () => sourceFixture('hn-hiring', 'thread-2026-09') as Thread
const mayThread = () => sourceFixture('hn-hiring', 'thread-2019-05') as Thread
const withChildren = (t: Thread, children: unknown[]) => ({ ...t, children })

async function walk(
  searchBody: unknown,
  threadBody: unknown | undefined,
  config = cfg(),
  now = NOW,
) {
  const responses = [{ bodyText: JSON.stringify(searchBody) }]
  if (threadBody !== undefined) responses.push({ bodyText: JSON.stringify(threadBody) })
  const f = fakeCollectionContext({ now, responses })
  const batch = await hnHiringProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof walk>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

const OCT_IDS = [
  '49922584',
  '49922609',
  '49922615',
  '49922711',
  '49923426',
  '49924849',
  '49925544',
  '49926031',
]

describe('the two-step walk', () => {
  it('searches the whoishiring stories first, then fetches the newest "Who is hiring?" thread', async () => {
    const { batch, f } = await walk(search(), octThread())
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://hn.algolia.com/api/v1/search_by_date?tags=story%2Cauthor_whoishiring&hitsPerPage=10',
      'https://hn.algolia.com/api/v1/items/49922569',
    ])
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
    expect(batch.requests.map((r) => [r.page, r.status])).toEqual([
      [1, 200],
      [2, 200],
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('picks the "Who is hiring?" thread, not its "Who wants to be hired?" twin posted the same minute', async () => {
    // Twin first, and with the larger objectID, so neither order nor magnitude can pick the answer.
    const hits = search().hits
    const twinFirst = [hits[1], hits[0], hits[2], hits[3]]
    const { f } = await walk({ ...search(), hits: twinFirst }, octThread())
    expect(f.sent[1]?.url).toBe('https://hn.algolia.com/api/v1/items/49922569')
  })

  it('picks the newest hiring thread whatever the order of the hits', async () => {
    const hits = search().hits
    const oldestFirst = [hits[2], hits[3], hits[0], hits[1]]
    const { f } = await walk({ ...search(), hits: oldestFirst }, octThread())
    expect(f.sent[1]?.url).toBe('https://hn.algolia.com/api/v1/items/49922569')
    const septemberOnly = [hits[3], hits[2]]
    const sep = await walk(
      { ...search(), hits: septemberOnly },
      sepThread(),
      cfg({ maxThreadAgeDays: 90 }),
    )
    expect(sep.f.sent[1]?.url).toBe('https://hn.algolia.com/api/v1/items/49522897')
  })

  it('ignores a hit that is not the whoishiring account, however it is titled', async () => {
    const impostor = { ...search().hits[0], author: 'someone-else', objectID: '99999999' }
    const { f } = await walk(
      { ...search(), hits: [impostor, ...search().hits.slice(2)] },
      sepThread(),
      cfg({ maxThreadAgeDays: 90 }),
    )
    expect(f.sent[1]?.url).toBe('https://hn.algolia.com/api/v1/items/49522897')
  })

  it('skips a hit that does not parse and uses the rest', async () => {
    const hits = [
      {
        objectID: '12ab',
        author: 'whoishiring',
        title: 'Ask HN: Who is hiring?',
        created_at_i: 1790866927,
      },
      7,
      null,
      ...search().hits,
    ]
    const { f } = await walk({ ...search(), hits }, octThread())
    expect(f.sent[1]?.url).toBe('https://hn.algolia.com/api/v1/items/49922569')
  })

  it('caches the two steps under their own slots', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: JSON.stringify(search()), etag: '"s"' },
        { bodyText: JSON.stringify(octThread()), etag: '"t"' },
      ],
    })
    await hnHiringProvider.collectReport(cfg(), f.ctx)
    const slots = [...f.cache.keys()].map((k) => (JSON.parse(k) as [string, string])[0]).sort()
    expect(slots).toEqual(['search', 'thread'])
  })

  it('is WINDOW coverage over the latest thread, never FULL_INVENTORY', async () => {
    const { batch } = await walk(search(), octThread())
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope).toMatchObject({
      namespace: 'hn-hiring',
      query: 'who-is-hiring-latest-thread',
      configVersion: 1,
      window: null,
    })
  })
})

describe('no current thread is a valid empty run', () => {
  const stories = (...hits: Hit[]) => ({ ...search(), hits })

  it('no hits at all', async () => {
    const { batch, f } = await walk(stories(), undefined)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(f.sent).toHaveLength(1)
  })

  it('only "Who wants to be hired?" threads (a non-vacancy thread)', async () => {
    const { batch, f } = await walk(
      stories(search().hits[1] as Hit, search().hits[3] as Hit),
      undefined,
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
    expect(f.sent).toHaveLength(1)
  })

  it('a newest hiring thread older than maxThreadAgeDays', async () => {
    // The October thread was posted at 1790866927 (2026-10-01T15:02:07Z).
    const posted = 1790866927 * 1000
    const day = 86_400_000
    const atLimit = new Date(posted + 45 * day)
    const justPast = new Date(posted + 45 * day + 1)
    const fresh = await walk(search(), octThread(), cfg(), atLimit)
    expect(fresh.f.sent).toHaveLength(2)
    const stale = await walk(search(), undefined, cfg(), justPast)
    expect(stale.f.sent).toHaveLength(1)
    expect(stale.batch.outcome).toBe('SUCCEEDED')
    expect(stale.batch.counts.raw).toBe(0)
  })

  it('maxThreadAgeDays moves that limit', async () => {
    const posted = 1790866927 * 1000
    const day = 86_400_000
    const sixtyDaysOn = new Date(posted + 60 * day)
    expect((await walk(search(), undefined, cfg(), sixtyDaysOn)).f.sent).toHaveLength(1)
    expect(
      (await walk(search(), octThread(), cfg({ maxThreadAgeDays: 90 }), sixtyDaysOn)).f.sent,
    ).toHaveLength(2)
    expect(
      (await walk(search(), undefined, cfg({ maxThreadAgeDays: 1 }), new Date(posted + 2 * day))).f
        .sent,
    ).toHaveLength(1)
  })

  it('a thread with no comments yet is also a valid empty run, after both requests', async () => {
    const { batch, f } = await walk(search(), withChildren(octThread(), []))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.raw).toBe(0)
    expect(f.sent).toHaveLength(2)
  })

  it('currentThreadId: the pure selection', () => {
    const hits = search().hits
    expect(currentThreadId(hits, NOW, 45)).toBe('49922569')
    expect(currentThreadId([], NOW, 45)).toBeNull()
    expect(currentThreadId([hits[1]], NOW, 45)).toBeNull()
  })
})

describe('the thread step refuses what is not a hiring thread (drift, not silence)', () => {
  it('a "Who wants to be hired?" thread at the thread step fails as PARSE_DRIFT with nothing kept', async () => {
    const wants = { ...octThread(), title: 'Ask HN: Who wants to be hired? (October 2026)' }
    const { batch } = await walk(search(), wants)
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
    expect(batch.requests[1]?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'envelope: the thread is not a "Who is hiring?" story',
    })
  })

  it('a thread step with no title is refused the same way', async () => {
    const { title: _t, ...untitled } = octThread()
    const { batch } = await walk(search(), untitled)
    expect(batch.requests[1]?.error?.message).toBe(
      'envelope: the thread is not a "Who is hiring?" story',
    )
  })

  it('a body that is neither a search result nor a thread is PARSE_DRIFT', async () => {
    const { batch } = await walk({ nbHits: 0 }, undefined)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'envelope: neither a search result nor a thread',
    })
  })
})

describe('mapping the authentic October 2026 thread', () => {
  it('turns the 8 top-level comments into 8 observations; the 8 nested replies are not vacancies', async () => {
    const { batch } = await walk(search(), octThread())
    expect(batch.counts).toEqual({
      raw: 8,
      normalized: 8,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(OCT_IDS)
    // 49922584 has 1 nested reply and 49924849 has 5; none became an observation.
    expect(byId(batch, '49928484')).toBeUndefined()
    expect(byId(batch, '49925406')).toBeUndefined()
  })

  it('maps every field of the first comment (hand-read)', async () => {
    const { batch } = await walk(search(), octThread())
    const o = byId(batch, '49922584')
    expect(o?.identity).toMatchObject({
      provider: 'HN_HIRING',
      namespace: 'hn-hiring',
      nativeId: '49922584',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://news.ycombinator.com/item?id=49922584')
    expect(o?.applicationUrl).toBeNull()
    expect(o?.normalized.title).toBe(
      'PrairieLearn (Remote US) — Full-Stack Software Engineer — TypeScript / Postgres / React / AI',
    )
    expect(o?.normalized.companyName).toBe('HN @mwest1066')
    expect(o?.normalized.location).toBeNull()
    expect(o?.normalized.remote).toBe(true)
    expect(o?.normalized.tags).toEqual(['employer-unverified'])
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2026-10-01T15:02:37.000Z')
    expect(o?.normalized.descriptionMd).toContain('open-source assessment platform')
    expect(o?.adapterVersion).toBe('hn-hiring-1')
  })

  it('a header without a pipe is taken whole: nothing is split into company and role', async () => {
    const { batch } = await walk(search(), octThread())
    const o = byId(batch, '49922584')
    expect(o?.normalized.companyName).not.toContain('PrairieLearn')
    expect(o?.normalized.title).toContain('Full-Stack Software Engineer')
  })

  it.each([
    [
      '49922609',
      'mcintyem',
      'Sidekick Labs | Senior SWE, R&D Engineer, Intelligence Engineer | REMOTE (US Timezones) | Full-time | $170k to $230k Base + Equity + Health',
      true,
      ['employer-unverified', 'triage:multi-role'],
    ],
    [
      '49922615',
      'eterps',
      'Open Education Applications / Neon | Senior/Lead Platform & DevOps Engineer, Senior Frontend Engineer, Senior Full-Stack Engineer | Utrecht, The Netherlands | HYBRID | DUTCH REQUIRED',
      null,
      ['employer-unverified', 'triage:multi-role'],
    ],
    [
      '49922711',
      'jaredzwick',
      'CareerJumpShip | Multiple engineering + go-to-market roles | Remote-first',
      true,
      ['employer-unverified', 'triage:multi-role'],
    ],
    [
      '49923426',
      'btesser21',
      'PDT Partners | NYC, Hybrid, 3 days in office',
      null,
      ['employer-unverified'],
    ],
    [
      '49924849',
      'anorphirith',
      'there used to be 800+ posts here :(',
      null,
      ['employer-unverified', 'triage:no-role-signal'],
    ],
    [
      '49925544',
      'kwakubiney',
      "This role always shows up here. There's no way you're not finding anyone to fill this?",
      null,
      ['employer-unverified', 'triage:no-role-signal'],
    ],
    [
      '49926031',
      'mixeden',
      "whitecircle.com/careers, we're building the most advanced AI safety infra, raised roughly $70m in total, join us",
      null,
      ['employer-unverified'],
    ],
  ])(
    'comment %s: title, poster, remote and triage tags (hand-read)',
    async (id, author, title, remote, tags) => {
      const { batch } = await walk(search(), octThread())
      const o = byId(batch, id as string)
      expect(o?.normalized.title).toBe(title)
      expect(o?.normalized.companyName).toBe(`HN @${author as string}`)
      expect(o?.normalized.remote).toBe(remote)
      expect(o?.normalized.tags).toEqual(tags)
    },
  )

  it('a header on its own line ends at the newline, not after the prose that follows', async () => {
    const { batch } = await walk(search(), octThread())
    expect(byId(batch, '49923426')?.normalized.title).toBe(
      'PDT Partners | NYC, Hybrid, 3 days in office',
    )
  })

  it('EVERY observation is tagged employer-unverified', async () => {
    const { batch } = await walk(search(), octThread())
    for (const o of batch.observations) expect(o.normalized.tags).toContain('employer-unverified')
  })
})

describe('headers by shape (September 2026 and May 2019 captures)', () => {
  /** The May 2019 story as a search hit: its real id and the real created_at_i of the thread capture. */
  const mayStories = () => ({
    ...search(),
    hits: [
      {
        ...search().hits[0],
        objectID: '19797594',
        title: 'Ask HN: Who is hiring? (May 2019)',
        created_at_i: 1556722891,
      },
    ],
  })

  it('location-first headers keep the whole header as the title and never invent a company', async () => {
    const sep = await walk(search(), sepThread(), cfg(), new Date('2026-10-05T00:00:00Z'))
    const close = byId(sep.batch, '49615973')
    expect(close?.normalized.title).toBe(
      'Remote (US) Close (https://close.com) | Senior/Staff Backend Engineer, Backend Platform | Full-time',
    )
    expect(close?.normalized.companyName).toBe('HN @veraalb')
    expect(close?.normalized.remote).toBe(true)
    expect(close?.normalized.location).toBeNull()

    const norm = byId(sep.batch, '49540382')
    expect(norm?.normalized.companyName).toBe('HN @jperaino')
    expect(
      norm?.originalFields.title.value.startsWith(
        'NYC | ONSITE (hybrid) Norm Ai, the agentic law company',
      ),
    ).toBe(true)
    expect(norm?.originalFields.title.originalLength).toBe(782)
    // ONSITE with no explicit negation is not "not remote".
    expect(norm?.normalized.remote).toBeNull()
  })

  it('remote-negated headers are false; a header that offers REMOTE is true; both words are unknown', async () => {
    const may = await walk(mayStories(), mayThread(), cfg(), new Date('2019-05-10T00:00:00Z'))
    expect(may.f.sent[1]?.url).toBe('https://hn.algolia.com/api/v1/items/19797594')
    expect(byId(may.batch, '19800045')?.normalized.remote).toBe(false)
    expect(byId(may.batch, '19815745')?.normalized.remote).toBe(false)
    expect(byId(may.batch, '19798344')?.normalized.remote).toBe(true)
    expect(byId(may.batch, '19797758')?.normalized.remote).toBeNull()
  })

  it('multi-role: "Multiple Openings" is one observation to triage, not several', async () => {
    const may = await walk(mayStories(), mayThread(), cfg(), new Date('2019-05-10T00:00:00Z'))
    const brain = byId(may.batch, '19800045')
    expect(brain?.normalized.title).toBe(
      'Brain Corporation | Multiple Openings |San Diego, CA | Onsite Only',
    )
    expect(brain?.normalized.tags).toEqual(['employer-unverified', 'triage:multi-role'])
    expect(
      may.batch.observations.filter((o) => o.normalized.tags?.includes('triage:multi-role')),
    ).toHaveLength(1)
    expect(byId(may.batch, '19815745')?.normalized.tags).toEqual(['employer-unverified'])
    expect(byId(may.batch, '19797758')?.normalized.title).toBe(
      'London, UK | TESSIAN | Sequoia-backed machine learning for Human Layer Security | On-Site | Full Time | Visa sponsorship possible | www.tessian.com',
    )
  })
})

describe('remoteOf and headerOf, case by case', () => {
  it.each([
    ['Acme | Berlin | REMOTE', true],
    ['Acme | Berlin | Remote OK | No Visa', true],
    ['Acme | REMOTE (US)', true],
    ['Acme | ONSITE', null],
    ['Acme | ONSITE or REMOTE (US)', null],
    ['Acme | On-site or remote', null],
    ['Acme | Hybrid', null],
    ['Acme | Berlin', null],
    ['Acme | no remote', false],
    ['Acme | No Remote work', false],
    ['Acme | not remote', false],
    ['Acme | non-remote', false],
    ['Acme | Remote: no', false],
    ['Acme | remote: not possible', false],
    ['Acme | Onsite Only', false],
    ['Acme | on-site only', false],
    ['Acme | only onsite', false],
    ['Acme | Remote-first', true],
    ['Acme | telecommuting', null],
  ])('%s -> %s', (header, expected) => {
    expect(remoteOf(header)).toBe(expected)
  })

  it('a remote token inside another word is not remote', () => {
    expect(remoteOf('Acme | remoted')).toBeNull()
    expect(remoteOf('Acme | onsiteable remote')).toBe(true)
  })

  it('headerOf: first paragraph or line, tags stripped, entities decoded, spaces collapsed', () => {
    expect(headerOf('A &amp; B &#x2F; C &#39;d&#39; &quot;e&quot; &lt;f&gt;<p>second')).toBe(
      `A & B / C 'd' "e" <f>`,
    )
    expect(headerOf('line one\nline two')).toBe('line one')
    expect(headerOf('x<a href="https:&#x2F;&#x2F;e.example">link</a>  y')).toBe('xlink y')
    expect(headerOf('nbsp&nbsp;here &unknown; &#0; &#x110000;')).toBe(
      'nbsp here &unknown; &#0; &#x110000;',
    )
    expect(headerOf('<P>upper')).toBe('')
    expect(headerOf('')).toBe('')
  })
})

describe('triage heuristics, at the boundary', () => {
  const tagsFor = async (header: string) => {
    const comment = { ...octThread().children[0], text: header }
    const { batch } = await walk(search(), withChildren(octThread(), [comment]))
    return batch.observations[0]?.normalized.tags
  }
  it('two role nouns make a multi-role header, one does not', async () => {
    expect(await tagsFor('Acme | Backend Engineer')).toEqual(['employer-unverified'])
    expect(await tagsFor('Acme | Backend Engineer, Data Scientist')).toEqual([
      'employer-unverified',
      'triage:multi-role',
    ])
  })
  it.each(['multiple', 'several', 'various', 'roles', 'positions', 'openings'])(
    'the word "%s" makes a multi-role header',
    async (word) => {
      expect(await tagsFor(`Acme | ${word} in Berlin`)).toContain('triage:multi-role')
    },
  )
  it('a header with a pipe or a hiring word has a role signal; prose without either has none', async () => {
    expect(await tagsFor('Acme | x')).not.toContain('triage:no-role-signal')
    expect(await tagsFor('we are hiring')).not.toContain('triage:no-role-signal')
    expect(await tagsFor('lovely weather today')).toContain('triage:no-role-signal')
  })
  it('a first line of exactly 2000 characters is kept whole; 2001 is cut at 2000 and tagged', async () => {
    const at = await tagsFor(`Acme | ${'x'.repeat(ORIGINAL_LIMITS.title - 7)}`)
    expect(at).toEqual(['employer-unverified'])
    const comment = {
      ...octThread().children[0],
      text: `Acme | ${'x'.repeat(ORIGINAL_LIMITS.title - 6)}`,
    }
    const { batch } = await walk(search(), withChildren(octThread(), [comment]))
    const o = batch.observations[0]
    expect(o?.normalized.tags).toEqual(['employer-unverified', 'triage:long-header'])
    expect(o?.originalFields.title.originalLength).toBe(ORIGINAL_LIMITS.title)
  })
})

describe('identity: the comment id, nothing else', () => {
  it('survives a changed header, a changed url and a changed poster text (an edited comment)', async () => {
    const a = await walk(search(), octThread())
    const edited = octThread().children.map((c) =>
      c.id === 49922584 ? { ...c, text: 'Renamed Co | Staff Engineer | ONSITE<p>all new text' } : c,
    )
    const b = await walk(search(), withChildren(octThread(), edited))
    const before = byId(a.batch, '49922584')
    const after = byId(b.batch, '49922584')
    expect(after?.identity.identityKey).toBe(before?.identity.identityKey)
    expect(after?.normalized.title).toBe('Renamed Co | Staff Engineer | ONSITE')
    expect(after?.contentHash).not.toBe(before?.contentHash)
    expect(after?.sourcePostingUrl).toBe('https://news.ycombinator.com/item?id=49922584')
  })

  it('two comments have two identities even though their links differ only in ?id=', async () => {
    const { batch } = await walk(search(), octThread())
    const keys = batch.observations.map((o) => o.identity.identityKey)
    expect(new Set(keys).size).toBe(8)
    expect(byId(batch, '49922609')?.sourcePostingUrl).toBe(
      'https://news.ycombinator.com/item?id=49922609',
    )
  })
})

describe('deleted and malformed comments', () => {
  const tombstone = (id: number): Comment => ({
    ...octThread().children[0],
    id,
    text: null,
    author: null,
    children: [],
  })

  it('a deleted comment (text null) is skipped before validation: not counted, not invalid', async () => {
    const children = [...octThread().children, tombstone(1), tombstone(2)]
    const { batch } = await walk(search(), withChildren(octThread(), children))
    expect(batch.counts).toEqual({
      raw: 8,
      normalized: 8,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(OCT_IDS)
  })

  it('a comment with NO text key at all is an invalid item, not a tombstone', async () => {
    const { text: _t, ...noText } = octThread().children[0] as Comment
    const { batch } = await walk(
      search(),
      withChildren(octThread(), [noText, octThread().children[1]]),
    )
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 1,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('a comment with text but a null author is an invalid item', async () => {
    const orphan = { ...octThread().children[0], author: null }
    const { batch } = await walk(search(), withChildren(octThread(), [orphan]))
    expect(batch.counts.invalid).toBe(1)
  })

  it('a comment whose first paragraph is empty is quarantined (no title), not mapped', async () => {
    const empty = { ...octThread().children[0], text: '<p>only a second paragraph' }
    const { batch } = await walk(search(), withChildren(octThread(), [empty]))
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 0,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
  })

  it('a non-comment node is an invalid item', async () => {
    const poll = { ...octThread().children[0], type: 'pollopt' }
    const { batch } = await walk(search(), withChildren(octThread(), [poll]))
    expect(batch.counts.invalid).toBe(1)
  })
})

describe('bounds, at the limit and past it', () => {
  const comment = (over: Record<string, unknown>) => ({ ...octThread().children[1], ...over })
  const invalid = async (over: Record<string, unknown>) =>
    (await walk(search(), withChildren(octThread(), [comment(over)]))).batch.counts.invalid

  it('author 100 ok / 101 invalid / empty invalid', async () => {
    expect(await invalid({ author: 'a'.repeat(100) })).toBe(0)
    expect(await invalid({ author: 'a'.repeat(101) })).toBe(1)
    expect(await invalid({ author: '' })).toBe(1)
  })
  it('text at the description retention limit is accepted, one past it is invalid', async () => {
    const pad = (n: number) =>
      `Acme | Engineer | REMOTE<p>${'x'.repeat(n - 'Acme | Engineer | REMOTE<p>'.length)}`
    expect(await invalid({ text: pad(ORIGINAL_LIMITS.description) })).toBe(0)
    expect(await invalid({ text: pad(ORIGINAL_LIMITS.description + 1) })).toBe(1)
  })
  it('id 1 and MAX_SAFE_INTEGER are valid; 0, a fraction and a string are invalid', async () => {
    expect(await invalid({ id: 1 })).toBe(0)
    expect(await invalid({ id: Number.MAX_SAFE_INTEGER })).toBe(0)
    expect(await invalid({ id: 0 })).toBe(1)
    expect(await invalid({ id: 1.5 })).toBe(1)
    expect(await invalid({ id: '12' })).toBe(1)
  })
  it('created_at: 64 characters ok / 65 invalid', async () => {
    expect(await invalid({ created_at: '1'.repeat(64) })).toBe(0)
    expect(await invalid({ created_at: '1'.repeat(65) })).toBe(1)
  })
  it(`${HN_MAX_COMMENTS} comments on the thread are accepted, one more is drift (the thread step fails)`, async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        comment({ id: i + 1, text: 'Acme | Engineer | REMOTE', children: [] }),
      )
    const ok = await walk(search(), withChildren(octThread(), many(HN_MAX_COMMENTS)))
    expect(ok.batch.counts.raw).toBe(HN_MAX_COMMENTS)
    const bad = await walk(search(), withChildren(octThread(), many(HN_MAX_COMMENTS + 1)))
    expect(bad.batch.outcome).toBe('PARTIAL')
    expect(bad.batch.observations).toEqual([])
  })
})

describe('config errors fail before any network call', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['maxThreadAgeDays 0', { maxThreadAgeDays: 0 }],
    ['maxThreadAgeDays 91', { maxThreadAgeDays: 91 }],
    ['maxThreadAgeDays 1.5', { maxThreadAgeDays: 1.5 }],
    ['a query', { query: 'x' }],
    ['a window', { window: { from: '2026-10-01', to: '2026-10-02' } }],
    ['another namespace', { namespace: 'other' }],
    ['an unknown key', { maxPages: 2 }],
    ['configVersion past the integer ceiling', { configVersion: PG_INT_MAX + 1 }],
  ]
  it.each(bad)('parseConfig refuses %s and no request is made', (_l, extra) => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{}' }] })
    expect(() => hnHiringProvider.parseConfig({ configVersion: 1, ...extra })).toThrow()
    expect(f.sent).toHaveLength(0)
  })

  it('accepts maxThreadAgeDays 1 and 90, defaults to 45, and the largest configVersion', () => {
    expect(cfg({ maxThreadAgeDays: 1 }).maxThreadAgeDays).toBe(1)
    expect(cfg({ maxThreadAgeDays: 90 }).maxThreadAgeDays).toBe(90)
    expect(cfg().maxThreadAgeDays).toBe(45)
    expect(cfg({ configVersion: PG_INT_MAX }).configVersion).toBe(PG_INT_MAX)
  })

  it('collectReport refuses a hand-built config and never fetches', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '{}' }] })
    await expect(
      hnHiringProvider.collectReport(
        { namespace: 'hn-hiring', configVersion: 1, maxThreadAgeDays: 45 } as unknown as ReturnType<
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
        hnHiringProvider.parseConfig({ configVersion: 1, ...extra })
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      return ''
    }
    expect(reason({ query: 'x' })).toContain('the thread is the scope')
    expect(reason({ window: { from: '2026-10-01', to: '2026-10-02' } })).toContain(
      'Hacker News has no date window',
    )
  })
})

describe('the BLOCKED state', () => {
  it('the provider declares itself blocked, UNCLEAR, with both facts - and every provenance agrees', () => {
    expect(HN_SOURCE_STATUS.blocked).toBe(true)
    expect(HN_SOURCE_STATUS.permission).toBe('UNCLEAR')
    expect(HN_SOURCE_STATUS.reason).toContain('forbid scraping')
    expect(HN_SOURCE_STATUS.reason).toContain('owner decision')
    for (const name of ['search', 'thread-2026-10', 'thread-2026-09', 'thread-2019-05']) {
      const p = sourceProvenance('hn-hiring', name) as { permission: string; notes: string }
      expect(p.permission).toBe(HN_SOURCE_STATUS.permission)
      expect(p.notes).toContain(
        'data mining, robots, scraping or similar data gathering or extraction methods',
      )
      expect(p.notes).toContain('public, unauthenticated, documented endpoint')
      expect(p.notes).toContain('unanswered')
    }
  })
})

describe('resuming at the thread step from a stored checkpoint', () => {
  async function firstCheckpoint() {
    const first = await walk(search(), octThread())
    const cp = first.f.saved[0]
    if (cp === undefined) throw new Error('no checkpoint after the search step')
    return cp
  }

  it('the search step saves the literal thread cursor', async () => {
    const cp = await firstCheckpoint()
    expect(cp.position).toEqual({ kind: 'CURSOR', page: 1, cursor: 'story:49922569' })
  })

  it('a stored cursor goes straight to that thread: no search request is made', async () => {
    const cp = await firstCheckpoint()
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: JSON.stringify(octThread()) }],
      stored: cp,
    })
    const batch = await hnHiringProvider.collectReport(cfg(), f.ctx)
    expect(f.sent.map((r) => r.url)).toEqual(['https://hn.algolia.com/api/v1/items/49922569'])
    expect(f.sent[0]?.headers).toEqual({ accept: 'application/json' })
    expect(batch.requests[0]?.page).toBe(2)
    expect(batch.counts.normalized).toBe(8)
  })

  it.each([
    ['an empty id', 'story:'],
    ['a non-numeric id', 'story:12ab'],
    ['a trailing path', 'story:12/../../x'],
    ['a 16-digit id', 'story:1234567890123456'],
    ['a prefix before story', 'xstory:12'],
    ['another prefix', 'thread:12'],
    ['a bare id', '49922569'],
  ])('%s is never put in a URL', async (_label, cursor) => {
    const cp = await firstCheckpoint()
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: JSON.stringify(octThread()) }],
      stored: { ...cp, position: { kind: 'CURSOR', page: 1, cursor } },
    })
    const batch = await hnHiringProvider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(0)
    expect(batch.requests[0]?.error?.message).toContain('the thread cursor is not a story id')
  })

  it('a 15-digit id is accepted', async () => {
    const cp = await firstCheckpoint()
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: JSON.stringify(octThread()) }],
      stored: { ...cp, position: { kind: 'CURSOR', page: 1, cursor: 'story:123456789012345' } },
    })
    await hnHiringProvider.collectReport(cfg(), f.ctx)
    expect(f.sent[0]?.url).toBe('https://hn.algolia.com/api/v1/items/123456789012345')
  })
})

describe('thread selection, strictly', () => {
  const hit = (over: Record<string, unknown>) => ({ ...search().hits[0], ...over })
  const idOf = (hits: unknown[]) => currentThreadId(hits, NOW, 45)

  it('only objectIDs of 1 to 15 digits count', () => {
    expect(idOf([hit({ objectID: 'ab49922569' })])).toBeNull()
    expect(idOf([hit({ objectID: '49922569ab' })])).toBeNull()
    expect(idOf([hit({ objectID: '1234567890123456' })])).toBeNull()
    expect(idOf([hit({ objectID: '' })])).toBeNull()
    expect(idOf([hit({ objectID: '123456789012345' })])).toBe('123456789012345')
  })

  it('the title must START with "Ask HN: Who is hiring?"', () => {
    expect(idOf([hit({ title: 'Re: Ask HN: Who is hiring? (October 2026)' })])).toBeNull()
    expect(idOf([hit({ title: 'Ask HN: Who is hiring (October 2026)' })])).toBeNull()
    expect(idOf([hit({ title: 'ask hn: who is hiring? (october 2026)' })])).toBe('49922569')
  })

  it('on a tie in time the first listed hit wins', () => {
    const a = hit({ objectID: '111', created_at_i: 1790866927 })
    const b = hit({ objectID: '222', created_at_i: 1790866927 })
    expect(idOf([a, b])).toBe('111')
    expect(idOf([b, a])).toBe('222')
  })

  it('the thread title must start with the same words, and a null title is refused', async () => {
    for (const title of ['Re: Ask HN: Who is hiring? (October 2026)', null]) {
      const { batch } = await walk(search(), { ...octThread(), title })
      expect(batch.requests[1]?.error?.message).toBe(
        'envelope: the thread is not a "Who is hiring?" story',
      )
    }
  })

  it('the thread step carries the accept header', async () => {
    const { f } = await walk(search(), octThread())
    expect(f.sent[1]?.headers).toEqual({ accept: 'application/json' })
  })

  it('declares the provider type', () => {
    expect(hnHiringProvider.type).toBe('HN_HIRING')
  })
})

describe('children that are not objects', () => {
  it('a null or primitive child is an invalid item, never a crash', async () => {
    const tombstone = { ...octThread().children[0], id: 5, text: null, author: null, children: [] }
    const children = [null, 7, 'x', tombstone, octThread().children[1]]
    const { batch } = await walk(search(), withChildren(octThread(), children))
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 1,
      invalid: 3,
      quarantined: 0,
      discarded: 0,
    })
  })
})

describe('headerOf: numeric entities and spacing', () => {
  it('decodes decimal, lower-case hex and upper-case hex references, and the apostrophe name', () => {
    expect(headerOf('&#65;&#x42;&#X43;')).toBe('ABC')
    expect(headerOf('it&apos;s')).toBe("it's")
    expect(headerOf('x&#x10FFFF;y')).toBe('x\u{10FFFF}y')
    expect(headerOf('&#x1;')).toBe('\u0001')
  })
  it('trims both ends and collapses inner runs of whitespace', () => {
    expect(headerOf('  a \t b  ')).toBe('a b')
    expect(headerOf('&nbsp;a&nbsp;')).toBe('a')
  })
})

describe('triage vocabulary, word by word', () => {
  const NOUNS = [
    'engineer',
    'developer',
    'designer',
    'manager',
    'analyst',
    'scientist',
    'architect',
    'lead',
    'specialist',
    'recruiter',
    'consultant',
  ]
  it.each(NOUNS)('two "%s"s make a multi-role header, singular or plural; one does not', (noun) => {
    expect(isMultiRole(`${noun}, ${noun}`)).toBe(true)
    expect(isMultiRole(`${noun}s, ${noun}s`)).toBe(true)
    expect(isMultiRole(noun)).toBe(false)
    expect(isMultiRole(`${noun}s`)).toBe(false)
  })
  it('a noun inside another word is not a role noun', () => {
    expect(isMultiRole('engineering, leading')).toBe(false)
  })

  const SIGNALS = [
    'hiring',
    'engineer',
    'engineers',
    'developer',
    'developers',
    'designer',
    'designers',
    'remote',
    'onsite',
    'on-site',
    'hybrid',
    'full time',
    'full-time',
    'fulltime',
    'part time',
    'part-time',
    'parttime',
    'contract',
    'intern',
    'interns',
    'internship',
    'internships',
    'apply',
    'join',
    'career',
    'careers',
    'job',
    'jobs',
  ]
  it.each(SIGNALS)('"%s" is a hiring word', (word) => {
    expect(hasRoleSignal(word)).toBe(true)
    expect(hasRoleSignal(`we say ${word} here`)).toBe(true)
  })
  it('a word merely containing one is not a hiring word, and prose has none', () => {
    expect(hasRoleSignal('contracted')).toBe(false)
    expect(hasRoleSignal('remotely')).toBe(false)
    expect(hasRoleSignal('lovely weather')).toBe(false)
    expect(hasRoleSignal('a | b')).toBe(true)
  })
})
