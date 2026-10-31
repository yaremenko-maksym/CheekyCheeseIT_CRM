import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { DEFAULT_USER_AGENT } from '../http/bounded-fetch'
import {
  collectText,
  DEFAULT_XML_LIMITS,
  findChild,
  findChildren,
  type XmlDocument,
  type XmlFailureReason,
  type XmlPort,
  XmlPortError,
  xmlPort,
} from '../xml'
import { xmlEnvelopeFingerprint } from './envelope-fingerprint'
import { baseSourceConfigSchema } from './api-json.provider'
import { markValidated, UnvalidatedConfigError } from './reporting-provider'
import {
  collectXmlPages,
  DEFAULT_XML_SOURCE_LIMITS,
  defineXmlProvider,
  type XmlSourceSpec,
} from './xml-source.provider'

/**
 * The XML helper: the shared page loop over an XML-shaped API response that is NOT a feed. The plan
 * names Personio as its first adapter ("Personio uses an XML helper, not a JSON override"), so the
 * acceptance case is a Personio-shaped document. Synthetic: an authentic Personio response needs an
 * outbound GET to a tenant, which is pending owner authorisation.
 */

const configSchema = baseSourceConfigSchema.extend({})
type Config = z.infer<typeof configSchema>
const config = (): Config => configSchema.parse({ namespace: 'acme', configVersion: 1 })

const positionSchema = z.object({ id: z.string().min(1), name: z.string().min(1) })
type Position = z.infer<typeof positionSchema>

const text = (node: Parameters<typeof collectText>[0] | undefined): string =>
  node === undefined ? '' : collectText(node).trim()

function personioSpec(overrides: Partial<XmlSourceSpec<Config, Position>> = {}) {
  const spec: XmlSourceSpec<Config, Position> = {
    type: 'PERSONIO_ATS',
    adapterVersion: 'personio-test-1',
    configSchema,
    itemSchema: positionSchema,
    pageRequest: () => ({
      request: { url: 'https://acme.jobs.personio.de/xml?language=en' },
      cacheKey: 'acme',
    }),
    extractItems: (document: XmlDocument) => {
      if (document.root.localName !== 'workzag-jobs') {
        throw new Error(`expected <workzag-jobs>, got <${document.root.localName}>`)
      }
      return findChildren(document.root, 'position').map((position) => ({
        id: text(findChild(position, 'id')),
        name: text(findChild(position, 'name')),
      }))
    },
    nextCursor: () => null,
    nativeIdOf: (position) => position.id,
    mapItem: (position, cfg) => ({
      namespace: cfg.namespace,
      nativeId: position.id,
      url: `https://acme.jobs.personio.de/job/${position.id}`,
      title: position.name,
      companyName: 'Acme',
    }),
    scopeOf: (cfg) => ({
      namespace: cfg.namespace,
      query: null,
      configVersion: cfg.configVersion,
      window: null,
    }),
    ...overrides,
  }
  return spec
}

const PERSONIO = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position><id>1001</id><name>Backend Engineer</name></position>
  <position><id>1002</id><name>Frontend Engineer</name></position>
</workzag-jobs>`

const positions = (n: number): string =>
  `<workzag-jobs>${Array.from({ length: n }, (_, i) => `<position><id>${i + 1}</id><name>P ${i + 1}</name></position>`).join('')}</workzag-jobs>`

/** A document of EXACTLY `bytes` UTF-8 bytes. */
const documentOfBytes = (bytes: number): string => `<r>${'a'.repeat(bytes - 7)}</r>`

describe('an XML API response collects through the shared loop', () => {
  it('a Personio-shaped document is a successful full inventory', async () => {
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['1001', '1002'])
    expect(batch.counts).toEqual({
      raw: 2,
      normalized: 2,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
  })

  it('an XML document of the wrong kind is drift, reported by the adapter`s own words', async () => {
    const f = fakeCollectionContext({ responses: [{ bodyText: '<html><body/></html>' }] })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'expected <workzag-jobs>, got <html>',
    })
  })

  it('a malformed document is drift', async () => {
    const f = fakeCollectionContext({ responses: [{ bodyText: '<workzag-jobs><position>' }] })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^MALFORMED: /)
  })

  it('a DOCTYPE is refused before the parser runs, as drift', async () => {
    const f = fakeCollectionContext({
      responses: [{ bodyText: '<!DOCTYPE r [<!ENTITY x "y">]><workzag-jobs/>' }],
    })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^DOCTYPE_FORBIDDEN: /)
  })
})

describe('the body is handed to the port as the text it already is', () => {
  it('a body whose declaration names windows-1251 is read as the text the fetch produced, not re-decoded', async () => {
    // The fetch seam delivers TEXT. Re-encoding it as plain UTF-8 bytes would let the port honour
    // the declaration and decode those UTF-8 bytes as windows-1251 — mojibake, silently. The
    // binding prefixes a UTF-8 byte-order mark, which outranks the declaration in the port.
    const body = `<?xml version="1.0" encoding="windows-1251"?><workzag-jobs><position><id>7</id><name>Розробник</name></position></workzag-jobs>`
    const f = fakeCollectionContext({ responses: [{ bodyText: body }] })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations[0]?.originalFields.title.value).toBe('Розробник')
  })

  it('a document of exactly maxBytes is accepted — the mark the binding adds is not charged to it', async () => {
    const f = fakeCollectionContext({ responses: [{ bodyText: documentOfBytes(64) }] })
    const spec = personioSpec({ limits: { maxBytes: 64 }, extractItems: () => [] })
    const batch = await collectXmlPages(spec, config(), f.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a document one byte past maxBytes is refused as a payload bound', async () => {
    const f = fakeCollectionContext({ responses: [{ bodyText: documentOfBytes(65) }] })
    const spec = personioSpec({ limits: { maxBytes: 64 }, extractItems: () => [] })
    const batch = await collectXmlPages(spec, config(), f.ctx)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^TOO_MANY_BYTES: /)
  })

  it('the bound counts UTF-8 BYTES, not characters', async () => {
    // 'я' is two bytes: 57 characters, 64 bytes is at the limit and 65 bytes is past it.
    const at = `<r>${'я'.repeat(28)}a</r>`
    const past = `<r>${'я'.repeat(29)}</r>`
    const spec = personioSpec({ limits: { maxBytes: 64 }, extractItems: () => [] })

    const ok = await collectXmlPages(
      spec,
      config(),
      fakeCollectionContext({ responses: [{ bodyText: at }] }).ctx,
    )
    const refused = await collectXmlPages(
      spec,
      config(),
      fakeCollectionContext({ responses: [{ bodyText: past }] }).ctx,
    )
    expect(ok.outcome).toBe('SUCCEEDED')
    expect(refused.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })
})

/**
 * A BODY THE FETCH ALREADY DECODED WRONGLY (SPEC-M-1 = SR-M-1).
 *
 * Acceptance first, from the specification — the port decodes fatally and a document whose bytes
 * are not valid in its encoding is drift — which is the contract this guard restores for a body
 * that arrives as TEXT, where the port has no bytes left to be fatal about. Then the refusal the
 * finding reproduced, and then the two cases the condition deliberately lets through.
 */
describe('replacement characters in a body that does not declare UTF-8 are drift', () => {
  const declared = (encoding: string, title: string): string =>
    `<?xml version="1.0" encoding="${encoding}"?><workzag-jobs><position><id>7</id><name>${title}</name></position></workzag-jobs>`

  it('refuses a windows-1251 feed the fetch read as UTF-8, rather than storing its mojibake', async () => {
    // What a cp1251 'Розробник' looks like after a UTF-8 read: every byte undecodable, so every
    // character replaced. It parses as well-formed XML — which is why it used to be stored.
    const f = fakeCollectionContext({
      responses: [{ bodyText: declared('windows-1251', '\ufffd\ufffd\ufffd\ufffd\ufffd') }],
    })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(
      /declares "windows-1251" and arrived holding replacement characters/,
    )
  })

  it('accepts the same feed when the fetch decoded it correctly', async () => {
    // The acceptance side of the same declaration: the guard is about replacement characters, not
    // about naming a single-byte encoding.
    const f = fakeCollectionContext({
      responses: [{ bodyText: declared('windows-1251', 'Розробник') }],
    })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations[0]?.originalFields.title.value).toBe('Розробник')
  })

  it('accepts a replacement character in a document that declares UTF-8 — it may be content', async () => {
    // The stated false negative, pinned so it is a decision and not an accident: a UTF-8 document
    // carrying U+FFFD is taken at its word, because refusing it would drop a healthy feed.
    const f = fakeCollectionContext({
      responses: [{ bodyText: declared('utf-8', 'Dev \ufffd ops') }],
    })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations[0]?.originalFields.title.value).toBe('Dev \ufffd ops')
  })

  it.each(['utf-8', 'UTF-8', 'utf8'])(
    'treats %s as UTF-8, so a replacement character in it is content',
    async (label) => {
      // The declaration is compared CASE-FOLDED, and `UTF-8` is the canonical XML spelling — the
      // Personio fixture's own. Without the folding, every document that spells it the normal way
      // would be refused the moment it contained the character.
      //
      // NOT trimmed, and this comment used to say it was: round 1 deleted the `.trim()` because
      // `encoding=" UTF-8 "` is not well-formed, so the port refuses such a document before the
      // guard sees it. None of the labels in this `it.each` carries whitespace, so the claim was
      // one no case here could have contradicted — which is why both review axes found it by
      // reading rather than by a failure.
      const f = fakeCollectionContext({
        responses: [{ bodyText: declared(label, 'Dev \ufffd ops') }],
      })
      const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

      expect(batch.outcome).toBe('SUCCEEDED')
      expect(batch.observations[0]?.originalFields.title.value).toBe('Dev \ufffd ops')
    },
  )

  it('accepts a replacement character in a document that declares nothing at all', async () => {
    // The other stated false negative: with no declaration XML's default is UTF-8, and only bytes
    // could tell a declaration-less cp1251 body from a UTF-8 one that contains the character.
    const f = fakeCollectionContext({
      responses: [
        {
          bodyText:
            '<workzag-jobs><position><id>7</id><name>Dev \ufffd</name></position></workzag-jobs>',
        },
      ],
    })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
  })
})

describe('every port refusal reports under the right code', () => {
  const BOUNDS: XmlFailureReason[] = [
    'TOO_MANY_BYTES',
    'TOO_DEEP',
    'TOO_MANY_ELEMENTS',
    'TIME_BUDGET',
  ]
  const DRIFT: XmlFailureReason[] = [
    'UNSUPPORTED_ENCODING',
    'UNDECODABLE',
    'ENCODING_CONFLICT',
    'DOCTYPE_FORBIDDEN',
    'MALFORMED',
    'UNDECLARED_PREFIX',
    'MALFORMED_QNAME',
    'PREFIX_UNDECLARING',
    'RESERVED_NAMESPACE',
    'DUPLICATE_ATTRIBUTE',
  ]

  const refusingPort = (error: unknown): XmlPort => ({
    parseDocument() {
      throw error
    },
  })

  const codeFor = async (port: XmlPort) => {
    const f = fakeCollectionContext({ responses: [{ bodyText: '<x/>' }] })
    const batch = await collectXmlPages(personioSpec(), config(), f.ctx, port)
    return batch.requests.at(-1)?.error
  }

  it.each(BOUNDS)('%s is a payload bound', async (reason) => {
    expect(await codeFor(refusingPort(new XmlPortError(reason, 'over')))).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: `${reason}: over`,
    })
  })

  it.each(DRIFT)('%s is drift', async (reason) => {
    expect((await codeFor(refusingPort(new XmlPortError(reason, 'bad'))))?.code).toBe('PARSE_DRIFT')
  })

  it('a pre-scan / parser disagreement is OUR invariant, not the provider`s drift', async () => {
    expect(
      (await codeFor(refusingPort(new XmlPortError('PRESCAN_DIFFERENTIAL', 'disagree'))))?.code,
    ).toBe('ADAPTER_INVARIANT')
  })

  it('a port that throws something other than its own error broke its contract', async () => {
    expect(await codeFor(refusingPort(new TypeError('boom')))).toEqual({
      code: 'ADAPTER_INVARIANT',
      message: 'the XML port threw outside its contract: boom',
    })
    expect(await codeFor(refusingPort('a string'))).toEqual({
      code: 'ADAPTER_INVARIANT',
      message: 'the XML port threw outside its contract: a string',
    })
  })
})

describe('honest user agent, no browser impersonation', () => {
  it('replaces an adapter`s user agent and drops browser client hints, keeping its other headers', async () => {
    const spec = personioSpec({
      pageRequest: () => ({
        request: {
          url: 'https://acme.jobs.personio.de/xml',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/130.0',
            'Sec-CH-UA': '"Chromium";v="130"',
            'sec-fetch-mode': 'navigate',
            accept: 'application/xml',
          },
        },
      }),
    })
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    await collectXmlPages(spec, config(), f.ctx)

    expect(f.sent[0]?.headers).toEqual({
      accept: 'application/xml',
      'user-agent': DEFAULT_USER_AGENT,
    })
  })

  /**
   * THE HEADER POLICY IS AN ALLOWLIST (SR-M-2 = CR-M-4).
   *
   * Acceptance first: the headers an adapter is allowed to set arrive as written. Then the
   * refusals — one case per header the old denylist kept, because "everything else is kept" is
   * exactly the claim that let them through.
   */
  it('passes the headers an adapter is allowed to set', async () => {
    const spec = personioSpec({
      pageRequest: () => ({
        request: {
          url: 'https://acme.jobs.personio.de/xml',
          headers: {
            accept: 'application/xml',
            'accept-language': 'uk,en;q=0.9',
            authorization: 'Bearer tenant-token',
            from: 'cheeky@cheekycheese.tech',
          },
        },
      }),
    })
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    await collectXmlPages(spec, config(), f.ctx)

    expect(f.sent[0]?.headers).toEqual({
      accept: 'application/xml',
      'accept-language': 'uk,en;q=0.9',
      authorization: 'Bearer tenant-token',
      from: 'cheeky@cheekycheese.tech',
      'user-agent': DEFAULT_USER_AGENT,
    })
  })

  it.each([
    ['referer', 'https://www.google.com/'],
    ['origin', 'https://weworkremotely.com'],
    ['cookie', 'session=abc123'],
    ['x-forwarded-for', '203.0.113.7'],
    ['x-device-user-agent', 'Mozilla/5.0 (iPhone) Safari/605'],
    ['x-requested-with', 'XMLHttpRequest'],
  ])('drops %s, which the old denylist let through', async (name, value) => {
    const spec = personioSpec({
      pageRequest: () => ({
        request: { url: 'https://acme.jobs.personio.de/xml', headers: { [name]: value } },
      }),
    })
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    await collectXmlPages(spec, config(), f.ctx)

    expect(f.sent[0]?.headers).toEqual({ 'user-agent': DEFAULT_USER_AGENT })
  })

  /**
   * TWO SPELLINGS OF ONE HEADER, PINNED (LOW, round 2).
   *
   * HTTP has no header letter case, so `Accept` and `accept` were never two headers — they are one
   * header an adapter wrote twice. The last spelling wins, which is what `Object.assign`, the
   * object spread and every fetch `Headers` do, and the only outcome an adapter author can
   * predict. It was already the behaviour and was untested, so it was indistinguishable from an
   * accident; this is the case that makes a change to it fail rather than pass quietly.
   */
  it('lets the last spelling of a twice-written header win', async () => {
    const spec = personioSpec({
      pageRequest: () => ({
        request: {
          url: 'https://acme.jobs.personio.de/xml',
          headers: { Accept: 'application/xml', accept: 'application/rss+xml' },
        },
      }),
    })
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    await collectXmlPages(spec, config(), f.ctx)

    expect(f.sent[0]?.headers).toEqual({
      accept: 'application/rss+xml',
      'user-agent': DEFAULT_USER_AGENT,
    })
  })

  it('sends the honest user agent when the adapter set no headers at all', async () => {
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    await collectXmlPages(personioSpec(), config(), f.ctx)

    expect(f.sent[0]?.headers).toEqual({ 'user-agent': DEFAULT_USER_AGENT })
  })
})

describe('defaults', () => {
  it('the XML bounds default to the port`s own', () => {
    expect(DEFAULT_XML_SOURCE_LIMITS).toEqual({
      ...DEFAULT_XML_LIMITS,
      maxPages: 10,
      maxItemsPerPage: 500,
    })
  })

  it('500 items on a page is accepted and 501 is refused', async () => {
    const at = await collectXmlPages(
      personioSpec(),
      config(),
      fakeCollectionContext({ responses: [{ bodyText: positions(500) }] }).ctx,
    )
    const past = await collectXmlPages(
      personioSpec(),
      config(),
      fakeCollectionContext({ responses: [{ bodyText: positions(501) }] }).ctx,
    )
    expect(at.observations).toHaveLength(500)
    expect(past.requests.at(-1)?.error?.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('stops at 10 pages per attempt', async () => {
    const spec = personioSpec({
      nextCursor: (_document, at) => `c${at.page}`,
      extractItems: () => [],
    })
    const f = fakeCollectionContext({
      responses: Array.from({ length: 11 }, () => ({ bodyText: '<workzag-jobs/>' })),
    })
    const batch = await collectXmlPages(spec, config(), f.ctx)

    expect(f.sent).toHaveLength(10)
    expect(batch.requests.at(-1)?.error?.code).toBe('PAGE_CAP')
  })
})

describe('defineXmlProvider', () => {
  it('validates the config it is given, and refuses one it never validated', async () => {
    const provider = defineXmlProvider(personioSpec())
    expect(provider.type).toBe('PERSONIO_ATS')
    expect(() => provider.parseConfig({ configVersion: 0 })).toThrow()

    const parsed = provider.parseConfig({ namespace: 'acme', configVersion: 1 })
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    await expect(provider.collectReport(parsed, f.ctx)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
    })

    const unvalidated = { namespace: 'acme', configVersion: 1, query: null, window: null }
    await expect(
      provider.collectReport(unvalidated as ReturnType<typeof provider.parseConfig>, f.ctx),
    ).rejects.toThrow(UnvalidatedConfigError)
  })

  it('collects through the port it was given', async () => {
    const port: XmlPort = {
      parseDocument() {
        throw new XmlPortError('MALFORMED', 'from the injected port')
      },
    }
    const provider = defineXmlProvider(personioSpec(), port)
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    const batch = await provider.collectReport(
      markValidated(configSchema.parse({ namespace: 'acme', configVersion: 1 })),
      f.ctx,
    )
    expect(batch.requests.at(-1)?.error?.message).toBe('MALFORMED: from the injected port')
  })
})

describe('U2: an XML page`s envelope fingerprint reaches the context', () => {
  it('is the fingerprint of the document`s element and attribute names', async () => {
    const f = fakeCollectionContext({ responses: [{ bodyText: PERSONIO }] })
    const seen: string[] = []
    f.ctx.observeEnvelope = (fp) => {
      seen.push(fp)
    }
    await collectXmlPages(personioSpec(), config(), f.ctx)
    const root = xmlPort.parseDocument(new TextEncoder().encode(PERSONIO)).root
    expect(seen).toEqual([xmlEnvelopeFingerprint(root)])
  })
})
