import { describe, expect, it } from 'vitest'
import { expectNoneOf, expectOnlyPublicRequests } from '../../../test/ats-b-assertions'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { readFixtureText } from '../../../test/fixture-provenance'
import { boardConfigsOf, boardVerdictOf } from './ats-config'
import { PERSONIO_LANGUAGES, personioBoardGroupSchema, personioProvider } from './personio.provider'

/**
 * Personio through its public provider, on the XML binding of Task 2.4. Expected values are
 * hand-read from the authentic captures in `__fixtures__/personio/` (see the provenance files) and
 * written as literals; none was produced by running the mapper. Hostile documents are inline
 * literals: they cannot be captures.
 */

const NOW = new Date('2026-10-24T04:00:00Z')
const PERSONIO = { name: 'Personio SE & Co. KG', evidence: 'subcompany on the only position' }

const cfg = (board = 'westwing', extra: Record<string, unknown> = {}) =>
  personioProvider.parseConfig({ configVersion: 1, board, language: 'en', ...extra })

const xml = (name: string) => readFixtureText('personio', name.includes('.') ? name : `${name}.xml`)
const position = (id: string, extra = '') =>
  `<position><id>${id}</id><subcompany>Acme GmbH</subcompany><office>Berlin</office>` +
  `<name>Role ${id}</name><jobDescriptions></jobDescriptions>${extra}</position>`
const feed = (...positions: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<workzag-jobs>\n${positions.join('\n')}\n</workzag-jobs>`

async function run(
  body: string,
  config = cfg(),
  status = 200,
  headers: Record<string, string> = {},
) {
  const f = fakeCollectionContext({ now: NOW, responses: [{ status, headers, bodyText: body }] })
  const batch = await personioProvider.collectReport(config, f.ctx)
  return { batch, f }
}
type Batch = Awaited<ReturnType<typeof run>>['batch']
const byId = (batch: Batch, id: string) =>
  batch.observations.find((o) => o.identity.nativeId === id)

describe('the request (public, one address, language and host variant in config)', () => {
  it('asks the XML feed of the company with the configured language, once', async () => {
    const { f } = await run(xml('westwing-en'))
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.url).toBe('https://westwing.jobs.personio.de/xml?language=en')
    expect(f.sent[0]?.headers).toMatchObject({ accept: 'application/xml' })
  })

  it.each([
    ['de', 'en', 'https://westwing.jobs.personio.de/xml?language=en'],
    ['com', 'en', 'https://westwing.jobs.personio.com/xml?language=en'],
    ['de', 'de', 'https://westwing.jobs.personio.de/xml?language=de'],
    ['com', 'pt', 'https://westwing.jobs.personio.com/xml?language=pt'],
  ])('host variant .%s with language %s asks %s', async (tld, language, url) => {
    const { f } = await run(feed(), cfg('westwing', { tld, language }))
    expect(f.sent[0]?.url).toBe(url)
  })

  it('defaults to the .de host', async () => {
    const { f } = await run(feed())
    expect(new URL(f.sent[0]?.url ?? '').host).toBe('westwing.jobs.personio.de')
  })

  it('never builds an authorised, token-bearing or foreign request (AC1), whatever the answer', async () => {
    for (const [body, status] of [
      [xml('westwing-en'), 200],
      [feed(), 200],
      [xml('tenant-not-found.txt'), 404],
      ['', 403],
      ['', 429],
    ] as const) {
      const { f } = await run(body, cfg(), status)
      expectOnlyPublicRequests(f.sent, /^westwing\.jobs\.personio\.de$/, ['accept', 'user-agent'])
    }
  })

  it('is the PERSONIO_ATS provider', () => {
    expect(personioProvider.type).toBe('PERSONIO_ATS')
  })
})

describe('the config (language and host are closed sets; namespace carries neither)', () => {
  it('lists the seven documented languages', () => {
    expect([...PERSONIO_LANGUAGES]).toEqual(['de', 'en', 'fr', 'es', 'nl', 'it', 'pt'])
  })

  it("requires a language: no default is chosen on the config author's behalf", () => {
    expect(() => personioProvider.parseConfig({ configVersion: 1, board: 'westwing' })).toThrow()
  })

  it.each(['xx', 'EN', 'en-GB', '', 'en&x=1', 'en\n', ' en'])('refuses language %j', (language) => {
    expect(() => cfg('westwing', { language })).toThrow()
  })

  it.each(['org', 'DE', 'de/evil', 'de.evil.example', '', 'de:443', 'com#'])(
    'refuses tld %j',
    (tld) => {
      expect(() => cfg('westwing', { tld })).toThrow()
    },
  )

  it('refuses a host, URL or token key: they are unknown keys', () => {
    for (const extra of [
      { host: 'evil.example' },
      { baseUrl: 'https://evil.example' },
      { token: 'x' },
    ]) {
      expect(() => cfg('westwing', extra)).toThrow()
    }
  })

  it('the namespace is the company alone: another language or host is the same vacancies', () => {
    const namespaces = [
      cfg('westwing').namespace,
      cfg('westwing', { language: 'de' }).namespace,
      cfg('westwing', { tld: 'com' }).namespace,
    ]
    expect(namespaces).toEqual(['personio:westwing', 'personio:westwing', 'personio:westwing'])
  })

  it('a group lists one company once: the same company under another host or language is a duplicate', () => {
    const entry = (extra: Record<string, unknown>) => ({
      board: 'westwing',
      language: 'en',
      ...extra,
    })
    expect(
      personioBoardGroupSchema.safeParse({
        configVersion: 1,
        boards: [entry({}), entry({ tld: 'com' })],
      }).success,
    ).toBe(false)
    expect(
      personioBoardGroupSchema.safeParse({
        configVersion: 1,
        boards: [entry({}), entry({ language: 'de' })],
      }).success,
    ).toBe(false)
    expect(
      personioBoardGroupSchema.safeParse({
        configVersion: 1,
        boards: [entry({}), entry({ board: 'personio' })],
      }).success,
    ).toBe(true)
  })

  it('a group entry carries its language to the config', () => {
    const group = personioBoardGroupSchema.parse({
      configVersion: 3,
      boards: [{ board: 'westwing', language: 'de', tld: 'com' }],
    })
    expect(boardConfigsOf(group)).toEqual([
      {
        configVersion: 3,
        board: 'westwing',
        region: 'global',
        employer: null,
        language: 'de',
        tld: 'com',
      },
    ])
  })
})

describe('the personio capture (1 position, stored as received)', () => {
  const personio = () => run(xml('personio-en'), cfg('personio'))

  it('turns it into one observation, a complete inventory', async () => {
    const { batch } = await personio()
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 1,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.scope).toEqual({
      namespace: 'personio:personio',
      query: null,
      configVersion: 1,
      window: null,
    })
  })

  it('maps every field (hand-read from the capture)', async () => {
    const { batch } = await personio()
    const o = byId(batch, '1834171')
    expect(o?.identity).toMatchObject({
      provider: 'PERSONIO_ATS',
      namespace: 'personio:personio',
      nativeId: '1834171',
      identityKind: 'NATIVE_ID',
    })
    expect(o?.sourcePostingUrl).toBe('https://personio.jobs.personio.de/job/1834171')
    expect(o?.normalized.title).toBe('Staff Software Engineer, Data Platform')
    expect(o?.normalized.companyName).toBe('Personio SE & Co. KG')
    expect(o?.normalized.location).toBe('Munich; Berlin')
    expect(o?.normalized.employmentType).toBe('permanent')
    expect(o?.normalized.seniorityHint).toBe('experienced')
    expect(o?.normalized.tags).toEqual(['Product and Tech', 'Engineering'])
    expect(o?.normalized.remote ?? null).toBeNull()
    expect(o?.normalized.publishedAt?.toISOString()).toBe('2024-11-13T14:10:41.000Z')
    expect(o?.adapterVersion).toBe('personio-1')
  })

  it('decodes entities once: &amp; in the legal entity, &#039; in a heading', async () => {
    const { batch } = await personio()
    const o = byId(batch, '1834171')
    expect(o?.normalized.companyName).toBe('Personio SE & Co. KG')
    const md = o?.normalized.descriptionMd ?? ''
    expect(md).toContain("The Role: How you'll make an impact at Personio")
    expect(md).toContain("Role Responsibilities: What you'll do")
    expect(md).not.toContain('&#039;')
    expect(md).not.toContain('&amp;')
  })

  it('the body starts with the first description heading, then its CDATA text', async () => {
    const { batch } = await personio()
    const md = byId(batch, '1834171')?.normalized.descriptionMd ?? ''
    expect(md.indexOf("The Role: How you'll make an impact")).toBeLessThan(
      md.indexOf('This position is hybrid'),
    )
    expect(md).toContain('This position is hybrid based in either Dublin or Munich locations')
  })

  it('the employer evidence is the fallback when a position names no legal entity', async () => {
    const body = feed(position('7').replace('<subcompany>Acme GmbH</subcompany>', ''))
    const { batch } = await run(body, cfg('personio', { employer: PERSONIO }))
    expect(batch.observations[0]?.normalized.companyName).toBe('Personio SE & Co. KG')
    const none = await run(body, cfg('personio'))
    expect(none.batch.observations).toEqual([])
    expect(none.batch.counts.quarantined).toBe(1)
  })
})

describe('the Westwing captures (5 positions in English, 2 in German)', () => {
  const english = () => run(xml('westwing-en'))
  const german = () => run(xml('westwing-de'), cfg('westwing', { language: 'de' }))

  it('turns the 5 positions into 5 observations', async () => {
    const { batch } = await english()
    expect(batch.counts).toEqual({
      raw: 5,
      normalized: 5,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([
      '2630474',
      '2703051',
      '2435528',
      '1968758',
      '2702093',
    ])
  })

  it('maps the legal entity per position, not per company', async () => {
    const { batch } = await english()
    expect(batch.observations.map((o) => o.normalized.companyName)).toEqual([
      'Westwing Group SE',
      'Westwing Group SE',
      'Westwing Sp. z o.o',
      'Westwing Stores GmbH',
      'Westwing Sp. z o.o',
    ])
  })

  it('keywords become tags after the department and category; a position without any has just those', async () => {
    const { batch } = await english()
    expect(byId(batch, '2630474')?.normalized.tags).toEqual([
      'Technology',
      'Leadership',
      'Team Lead',
      'Mobile',
      'iOS',
      'Android',
    ])
    expect(byId(batch, '2702093')?.normalized.tags).toEqual(['Operations', 'Experienced'])
  })

  it('trims a keyword ("werkstudent ") and decodes &amp; in another', async () => {
    const { batch } = await english()
    expect(byId(batch, '1968758')?.normalized.tags).toEqual([
      'Retail_New Sales Channels',
      'Interns/Working Students',
      'werkstudent',
      'verkauf',
      'hamburg',
      'westwing',
      'store',
      'home & living',
    ])
  })

  it("employment type and seniority are the feed's words", async () => {
    const { batch } = await english()
    expect(
      batch.observations.map((o) => [o.normalized.employmentType, o.normalized.seniorityHint]),
    ).toEqual([
      ['permanent', 'experienced'],
      ['fixed_term', 'experienced'],
      ['freelance', 'entry-level'],
      ['working_student', 'student'],
      ['permanent', 'experienced'],
    ])
  })

  it('a position with no additional offices has its single office', async () => {
    const { batch } = await english()
    expect(byId(batch, '2435528')?.normalized.location).toBe('Warsaw Office')
  })

  it('LANGUAGE: the German document is the same vacancies, by the same ids, with no description text', async () => {
    const en = await english()
    const de = await german()
    expect(de.f.sent[0]?.url).toBe('https://westwing.jobs.personio.de/xml?language=de')
    expect(de.batch.observations.map((o) => o.identity.nativeId)).toEqual(['2630474', '2702093'])
    expect(de.batch.observations.map((o) => o.identity.identityKey)).toEqual([
      byId(en.batch, '2630474')?.identity.identityKey,
      byId(en.batch, '2702093')?.identity.identityKey,
    ])
    expect(de.batch.observations.map((o) => o.normalized.descriptionMd ?? '')).toEqual(['', ''])
    expect(byId(de.batch, '2630474')?.sourcePostingUrl).toBe(
      'https://westwing.jobs.personio.de/job/2630474',
    )
  })

  it('HOST VARIANT: the .com host builds .com posting URLs and the same identities', async () => {
    const de = await english()
    const com = await run(xml('westwing-en'), cfg('westwing', { tld: 'com' }))
    expect(byId(com.batch, '2630474')?.sourcePostingUrl).toBe(
      'https://westwing.jobs.personio.com/job/2630474',
    )
    expect(com.batch.observations.map((o) => o.identity.identityKey)).toEqual(
      de.batch.observations.map((o) => o.identity.identityKey),
    )
  })
})

describe("the document (entities, DOCTYPE and XXE are the port's refusals)", () => {
  const doctype = (subset: string, body = '&x;') =>
    `<?xml version="1.0"?>\n<!DOCTYPE workzag-jobs [${subset}]>\n<workzag-jobs><position><id>1</id><name>${body}</name></position></workzag-jobs>`

  it.each([
    ['an external entity (XXE)', doctype('<!ENTITY x SYSTEM "file:///etc/passwd">')],
    ['an external entity over the network', doctype('<!ENTITY x SYSTEM "http://evil.example/p">')],
    ['an internal entity', doctype('<!ENTITY x "AAAA">')],
    [
      'entity expansion (a billion-laughs shape)',
      doctype(
        '<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">',
        '&c;',
      ),
    ],
  ])('refuses %s as drift, stores nothing and requests nothing else', async (_label, body) => {
    const { batch, f } = await run(body)
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expectNoneOf(batch, ['root:', 'evil.example', 'aaaaaaaaaa'])
  })

  it('an entity that is not defined is malformed, not an empty string', async () => {
    const { batch } = await run(feed(position('1').replace('Role 1', 'A &nbsp; B')))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a document whose root is not the feed is drift, naming what it found', async () => {
    const { batch } = await run('<?xml version="1.0"?><html><body>Maintenance</body></html>')
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toContain('<html>')
  })

  it('an HTML page is not XML', async () => {
    const { batch } = await run(xml('tenant-not-found.txt'))
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })
})

describe('empty, missing and isolated', () => {
  it('a feed with no positions is a valid empty inventory', async () => {
    const { batch } = await run(feed())
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.counts).toEqual({
      raw: 0,
      normalized: 0,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('a company with no feed (not found or switched off) answers 404 and is a BOARD problem', async () => {
    const { batch } = await run(
      xml('tenant-not-found.txt'),
      cfg('cheeky-nonexistent-tenant-0001'),
      404,
    )
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[404, 'UPSTREAM']])
    expect(boardVerdictOf(batch)).toBe('BOARD_NOT_FOUND')
  })

  it('403 and 429 are problems of the source, not of the board', async () => {
    for (const [status, code] of [
      [403, 'ACCESS_POLICY'],
      [429, 'RATE_LIMIT'],
    ] as const) {
      const { batch } = await run('', cfg(), status)
      expect(batch.requests.map((r) => r.error?.code)).toEqual([code])
      expect(boardVerdictOf(batch)).toBe('SOURCE_FAILED')
    }
  })

  it('error reports carry the status and never the response body or headers (AC2, by value)', async () => {
    const secret = 'pk_live_55c0aa13d2'
    const { batch } = await run(`<error>${secret}</error>`, cfg(), 403, {
      'set-cookie': `session=${secret}`,
    })
    expect(batch.requests.map((r) => r.error?.message)).toEqual(['provider answered HTTP 403'])
    expectNoneOf(batch, [secret, 'session='])
  })

  it('a redirect is not followed', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { status: 302, headers: { location: 'https://evil.example/' } },
        { status: 200, bodyText: feed() },
      ],
    })
    const batch = await personioProvider.collectReport(cfg(), f.ctx)
    expect(f.sent).toHaveLength(1)
    expect(batch.requests.map((r) => [r.status, r.error?.code])).toEqual([[302, 'UPSTREAM']])
  })

  it('a position with no id, a non-numeric id or an empty name is isolated; its neighbour is kept', async () => {
    const noId = position('1').replace('<id>1</id>', '')
    const body = feed(noId, position('abc'), position('3').replace('Role 3', ''), position('4'))
    const { batch } = await run(body)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 4,
      normalized: 1,
      invalid: 3,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['4'])
  })

  it('a position id is accepted at 18 digits and refused at 19 (it becomes a URL path segment)', async () => {
    const ok = '123456789012345678'
    const { batch } = await run(feed(position(ok), position(`${ok}9`)))
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([ok])
    expect(batch.counts.invalid).toBe(1)
  })

  it('a position id cannot steer the posting URL', async () => {
    const { batch } = await run(feed(position('1/../../x'), position('1?x=1'), position('1#')))
    expect(batch.observations).toEqual([])
    expect(batch.counts.invalid).toBe(3)
  })

  it('a heading is text, never markup', async () => {
    const body = feed(
      position('9').replace(
        '<jobDescriptions></jobDescriptions>',
        '<jobDescriptions><jobDescription><name>A &lt;script&gt;x&lt;/script&gt; B</name><value><![CDATA[<p>Body</p>]]></value></jobDescription></jobDescriptions>',
      ),
    )
    const { batch } = await run(body)
    const md = batch.observations[0]?.normalized.descriptionMd ?? ''
    expect(md).toContain('Body')
    expect(md).toContain('\\<script\\>x\\</script\\>')
  })

  it('a creation date that is not a date is kept raw and flagged', async () => {
    const { batch } = await run(feed(position('1', '<createdAt>yesterday</createdAt>')))
    const o = batch.observations[0]
    expect(o?.normalized.publishedAt).toBeNull()
    expect(o?.evidence).toContainEqual({
      field: 'date.PUBLISHED',
      kind: 'DATE_UNCERTAIN',
      detail: 'INVALID',
    })
  })
})
