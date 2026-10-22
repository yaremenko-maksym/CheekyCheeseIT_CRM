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
} from '../xml'
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
