/**
 * R-4: the seam, and an honest statement of how real it is.
 *
 * `codebase-design`'s two-adapter test: one adapter and the seam is HYPOTHETICAL; two and it is
 * demonstrated. An earlier revision of the ADR claimed this review had produced the second
 * adapter. **It had not, and the claim was withdrawn.** `fast-xml-parser` accepts an undefined
 * entity under EVERY configuration measured, with `XMLValidator.validate()` returning `true`, so
 * it fails the "malformed feed = drift" contract and cannot be the second conformant adapter
 * without additional undefined-entity detection code written by us.
 *
 * The ADR offers three ways to close this, and the task forbids building a second library adapter.
 * **Option 3 is taken, knowingly: a deliberate one-adapter seam, where an in-memory fake
 * implementing `XmlPort` is the second implementation.** That is the weaker reading of the
 * two-adapter rule and it is recorded as such rather than dressed up:
 *
 *   WHAT THIS BUYS. The contract below is expressed in terms of `XmlPort` alone — reason codes and
 *   neutral-tree shapes, never a parser message or a library node type. Writing the fake proved
 *   the interface is implementable without `@rgrove/parse-xml`, which is the property a swap needs
 *   and the property Shape A (provider calls the library directly) would not have.
 *
 *   WHAT IT DOES NOT BUY. It does not prove a real second PARSER can satisfy the contract. The
 *   fake does not parse; it returns canned trees. So "replaceable without touching 25 adapters" is
 *   **designed for and not yet demonstrated**, and the first genuine test of it will be the day an
 *   advisory lands. The cheapest way to close it properly stays option 1 of R-4 — make
 *   `fast-xml-parser` conformant by adding the undefined-entity scan — or option 2, `sax`, which
 *   already throws on both truncation and undefined entities.
 *
 * Nothing below reaches behind the interface. That is the constraint R-4 puts on how these
 * assertions are written, and it is why they would survive a replacement.
 */

import { describe, expect, it } from 'vitest'
import { douFeedBytes, fixtureBytes, REJECTED_FIXTURES, utf8 } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { DEFAULT_XML_LIMITS } from './xml-limits'
import type { XmlDocument, XmlElementNode, XmlFailureReason, XmlLimits, XmlPort } from './xml-port'
import { XmlPortError } from './xml-port'
import { collectText, findChild } from './xml-tree'

/**
 * A second implementation of `XmlPort`. Canned, not a parser.
 *
 * Its job is to answer one question — can this interface be satisfied by something that is not
 * `@rgrove/parse-xml`? — and it does so by being written against the published types only. If a
 * library node type had leaked into `XmlDocument`, this file would not compile, which is the
 * mechanical part of the claim. Anything beyond that is the limitation stated in the header.
 */
class CannedXmlPort implements XmlPort {
  constructor(private readonly responses: Map<string, XmlDocument | XmlFailureReason>) {}

  parseDocument(bytes: Uint8Array, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlDocument {
    if (bytes.byteLength > limits.maxBytes) {
      throw new XmlPortError('TOO_MANY_BYTES', 'over the byte cap')
    }
    const key = new TextDecoder().decode(bytes)
    const canned = this.responses.get(key)
    if (canned === undefined) throw new XmlPortError('MALFORMED', 'no canned response')
    if (typeof canned === 'string') throw new XmlPortError(canned, `canned ${canned}`)
    return canned
  }
}

const element = (
  localName: string,
  children: XmlElementNode[] = [],
  text = '',
): XmlElementNode => ({
  kind: 'element',
  localName,
  prefix: null,
  namespaceUri: null,
  qualifiedName: localName,
  attributes: [],
  namespaceDeclarations: {},
  children: [...children, ...(text === '' ? [] : [{ kind: 'text' as const, value: text }])],
  text,
})

const reasonOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof XmlPortError) return error.reason
    throw error
  }
  throw new Error('expected a refusal, but the call returned')
}

/**
 * The contract, run against ANY `XmlPort`.
 *
 * Takes the implementation plus a way to obtain bytes for each named case, because a canned port
 * cannot parse the real fixtures — the asymmetry is itself the limitation this spec is honest
 * about, and hiding it behind a shared fixture loader would have made the fake look like a parser.
 */
function assertPortContract(
  name: string,
  port: XmlPort,
  bytesFor: (c: 'ok' | 'malformed' | 'doctype' | 'oversize') => Uint8Array,
): void {
  describe(`XmlPort contract: ${name}`, () => {
    it('a well-formed document returns a tree with a root', () => {
      const document = port.parseDocument(bytesFor('ok'))
      expect(document.root.localName).toBe('rss')
      expect(document.elementCount).toBeGreaterThan(0)
      expect(document.depth).toBeGreaterThan(0)
    })

    it('a malformed document raises MALFORMED — never a partial tree', () => {
      expect(reasonOf(() => port.parseDocument(bytesFor('malformed')))).toBe('MALFORMED')
    })

    it('a DOCTYPE is refused with its own reason, distinct from MALFORMED', () => {
      expect(reasonOf(() => port.parseDocument(bytesFor('doctype')))).toBe('DOCTYPE_FORBIDDEN')
    })

    it('an oversized body is refused on bytes', () => {
      expect(reasonOf(() => port.parseDocument(bytesFor('oversize')))).toBe('TOO_MANY_BYTES')
    })

    it('every failure arrives as XmlPortError, so callers can branch on `reason`', () => {
      for (const kind of ['malformed', 'doctype', 'oversize'] as const) {
        let raised: unknown
        try {
          port.parseDocument(bytesFor(kind))
        } catch (error) {
          raised = error
        }
        expect(raised, kind).toBeInstanceOf(XmlPortError)
        expect(typeof (raised as XmlPortError).reason, kind).toBe('string')
      }
    })
  })
}

const REAL_OK = '<rss version="2.0"><channel><title>ok</title></channel></rss>'
const REAL_MALFORMED = '<rss version="2.0"><channel><title>unclosed'
const REAL_DOCTYPE = '<!DOCTYPE rss><rss version="2.0"><channel/></rss>'
const oversize = (): Uint8Array => utf8(`<r>${'x'.repeat(DEFAULT_XML_LIMITS.maxBytes)}</r>`)

assertPortContract('BoundedXmlPort (the real adapter)', new BoundedXmlPort(), (kind) => {
  switch (kind) {
    case 'ok':
      return utf8(REAL_OK)
    case 'malformed':
      return utf8(REAL_MALFORMED)
    case 'doctype':
      return utf8(REAL_DOCTYPE)
    case 'oversize':
      return oversize()
  }
})

assertPortContract(
  'CannedXmlPort (a second implementation, canned — see the header)',
  new CannedXmlPort(
    new Map<string, XmlDocument | XmlFailureReason>([
      [
        REAL_OK,
        {
          root: element('rss', [element('channel', [], 'ok')]),
          declaredEncoding: null,
          effectiveEncoding: 'utf-8',
          depth: 2,
          elementCount: 2,
        },
      ],
      [REAL_MALFORMED, 'MALFORMED'],
      [REAL_DOCTYPE, 'DOCTYPE_FORBIDDEN'],
    ]),
  ),
  (kind) => {
    switch (kind) {
      case 'ok':
        return utf8(REAL_OK)
      case 'malformed':
        return utf8(REAL_MALFORMED)
      case 'doctype':
        return utf8(REAL_DOCTYPE)
      case 'oversize':
        return oversize()
    }
  },
)

describe('R-4: the whole corpus, through the real port, by reason code', () => {
  it.each(REJECTED_FIXTURES)('$file is refused as $reason', ({ file, reason }) => {
    expect(reasonOf(() => new BoundedXmlPort().parseDocument(fixtureBytes(file)))).toBe(reason)
  })

  it('a valid EMPTY feed is a success, not drift', () => {
    // The distinction the plan requires and the one `fast-xml-parser` cannot make on a truncated
    // feed: "nothing to read" and "could not read" must not collapse into one outcome.
    const document = new BoundedXmlPort().parseDocument(fixtureBytes('rss-empty.xml'))
    const channel = findChild(document.root, 'channel')
    expect(channel).toBeDefined()
    expect(findChild(channel as XmlElementNode, 'item')).toBeUndefined()
    expect(collectText(channel as XmlElementNode)).toContain('No vacancies right now')
  })

  it('the authentic-grammar DOU feed parses through the port', () => {
    const document = new BoundedXmlPort().parseDocument(douFeedBytes())
    expect(document.root.localName).toBe('rss')
    expect(document.declaredEncoding).toBe('utf-8')
  })
})

describe('R-4: no parser name or node type crosses the seam', () => {
  it('the port`s result is a plain neutral tree, not a library object', () => {
    const document = new BoundedXmlPort().parseDocument(utf8(REAL_OK))
    // A library `XmlElement` is a class instance with a `type` getter and a `parent` back-pointer.
    // Ours is a plain object with `kind`. If the adapter ever returned the library tree directly,
    // these three assertions go red together — which is the leak that would make a swap expensive.
    expect(document.root.kind).toBe('element')
    expect(Object.getPrototypeOf(document.root)).toBe(Object.prototype)
    expect('parent' in document.root).toBe(false)
  })

  it('the barrel does not re-export the adapter', async () => {
    // `index.ts` is what adapters import. If the adapter leaked through it, a caller could reach
    // the parser layer and bypass every bound — so the omission is asserted, not just intended.
    const barrel = await import('./index')
    expect(Object.keys(barrel)).not.toContain('parseXmlString')
    expect(Object.keys(barrel)).not.toContain('HARDENED_PARSE_OPTIONS')
  })
})
