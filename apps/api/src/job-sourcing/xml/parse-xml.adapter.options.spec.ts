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
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const parseXmlMock = vi.hoisted(() => vi.fn())

vi.mock('@rgrove/parse-xml', async () => {
  // The real module supplies the node classes the adapter does `instanceof` against; only
  // `parseXml` itself is replaced. Mocking the classes too would make the adapter's tree walk
  // untestable and the assertions below vacuous.
  const actual = await vi.importActual<typeof import('@rgrove/parse-xml')>('@rgrove/parse-xml')
  return { ...actual, parseXml: parseXmlMock }
})

const { HARDENED_OPTION_KEYS, HARDENED_PARSE_OPTIONS, parseXmlString } =
  await import('./parse-xml.adapter')
const { xmlPort } = await import('./bounded-xml-port')
const actualLib = await vi.importActual<typeof import('@rgrove/parse-xml')>('@rgrove/parse-xml')

/** The real parser's output, so the adapter's tree walk still runs on something real. */
const realParse = (xml: string): unknown => actualLib.parseXml(xml, HARDENED_PARSE_OPTIONS)

const FEED = '<rss version="2.0"><channel><item><title>ok</title></item></channel></rss>'

beforeEach(() => {
  parseXmlMock.mockReset()
  parseXmlMock.mockImplementation((xml: string) => realParse(xml))
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
