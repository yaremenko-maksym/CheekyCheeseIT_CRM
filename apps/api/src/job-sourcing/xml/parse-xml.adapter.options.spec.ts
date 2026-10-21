/**
 * R-1, part 4: pin the options object ACTUALLY HANDED TO `parseXml`.
 *
 * The ADR's own third assertion inspected a LOCAL VARIABLE holding the options, which left two
 * regressions green: a resolver injected at the call site, and a narrow HTML-entity resolver added
 * later to "fix" `&nbsp;` in feeds. Both change what the parser receives without changing the
 * constant anyone was asserting on. So this spec mocks the library and reads the second argument
 * of the real call.
 *
 * What its passing would look like if the thing it checks were absent: if `HARDENED_PARSE_OPTIONS`
 * were not passed at all, `received` would be `undefined` and every assertion below would throw.
 * If a `resolveUndefinedEntity` were added anywhere between here and the parser, the key-set
 * assertion goes red. That is the falsifiability the removed assertions lacked.
 *
 * The mock DELEGATES to the real parser, so the adapter's tree walk still runs on a real
 * `XmlDocument` and the port's pre-scan reconciliation still holds. A mock returning a canned tree
 * would make the last test below vacuous — the port would raise `PRESCAN_DIFFERENTIAL` instead of
 * reaching the assertion.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { xmlPort } from './bounded-xml-port'
import { HARDENED_OPTION_KEYS, HARDENED_PARSE_OPTIONS, parseXmlString } from './parse-xml.adapter'

const parseXmlMock = vi.hoisted(() => vi.fn())
/** The real `parseXml`, captured inside the factory so the module body needs no top-level await. */
const real = vi.hoisted(() => ({ parseXml: null as null | ((...args: never[]) => unknown) }))

vi.mock('@rgrove/parse-xml', async () => {
  // Only `parseXml` is replaced. The node classes stay real, because the adapter does
  // `instanceof` against them — mocking those too would make its tree walk untestable and every
  // assertion here vacuous.
  const actual = await vi.importActual<typeof import('@rgrove/parse-xml')>('@rgrove/parse-xml')
  real.parseXml = actual.parseXml as unknown as (...args: never[]) => unknown
  return { ...actual, parseXml: parseXmlMock }
})

const FEED = '<rss version="2.0"><channel><item><title>ok</title></item></channel></rss>'

beforeEach(() => {
  parseXmlMock.mockReset()
  parseXmlMock.mockImplementation((...args: never[]) => real.parseXml?.(...args))
})

/** The options the parser was handed on the most recent call. */
function receivedOptions(): Record<string, unknown> {
  expect(parseXmlMock).toHaveBeenCalled()
  const call = parseXmlMock.mock.calls.at(-1) as unknown[]
  // Deliberately NOT `?? {}`: a default-substitution here is one of the three shapes the
  // mutation gate exists to catch — it would turn "no options were passed" into a pass.
  const options = call[1]
  expect(options, 'parseXml was called without an options argument').toBeDefined()
  return options as Record<string, unknown>
}

describe('R-1: the options reaching the real call site', () => {
  it('ignoreUndefinedEntities is false at the call site — the drift gate', () => {
    parseXmlString(FEED)
    expect(receivedOptions().ignoreUndefinedEntities).toBe(false)
  })

  it('resolveUndefinedEntity is NOT among the keys passed — the security gate', () => {
    parseXmlString(FEED)
    const options = receivedOptions()
    // `in`, not `=== undefined`: supplying the key with an undefined value is a different diff
    // from not supplying it, and only one of the two is what the ADR pinned.
    expect('resolveUndefinedEntity' in options).toBe(false)
  })

  it('no unexpected keys reach the parser', () => {
    parseXmlString(FEED)
    expect(Object.keys(receivedOptions()).sort()).toEqual([...HARDENED_OPTION_KEYS])
  })

  it('every option the library offers is set explicitly, none left to a default', () => {
    // The library's full surface, read from its shipped `ParserOptions` type. An option absent
    // here and absent from ours is an option whose default we are silently inheriting — which is
    // the thing that breaks the day the library changes that default.
    const librarySurface = [
      'ignoreUndefinedEntities',
      'includeOffsets',
      'preserveCdata',
      'preserveComments',
      'preserveDocumentType',
      'preserveXmlDeclaration',
      'resolveUndefinedEntity',
      'sortAttributes',
    ]
    const deliberatelyOmitted = ['resolveUndefinedEntity']
    expect([...HARDENED_OPTION_KEYS, ...deliberatelyOmitted].sort()).toEqual(librarySurface)
  })

  it('each pinned option arrives with its pinned value, not merely its key', () => {
    parseXmlString(FEED)
    expect(receivedOptions()).toEqual({
      ignoreUndefinedEntities: false,
      preserveCdata: false,
      preserveComments: false,
      preserveDocumentType: false,
      preserveXmlDeclaration: true,
      sortAttributes: false,
      includeOffsets: false,
    })
  })

  it('the frozen option object cannot be mutated into an unsafe one', () => {
    const mutate = (): void => {
      Object.assign(HARDENED_PARSE_OPTIONS, { ignoreUndefinedEntities: true })
    }
    expect(mutate).toThrow(TypeError)
    expect(HARDENED_PARSE_OPTIONS.ignoreUndefinedEntities).toBe(false)
  })

  it('the port reaches the parser through the adapter, not around it', () => {
    // If the port ever grew its own `parseXml` import, this mock would not intercept it and the
    // call count would be zero — i.e. the "one importer" property is asserted, not assumed.
    xmlPort.parseDocument(new TextEncoder().encode(FEED))
    expect(parseXmlMock).toHaveBeenCalledTimes(1)
    expect(receivedOptions().ignoreUndefinedEntities).toBe(false)
  })
})
