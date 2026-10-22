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
 * WHAT CHANGED IN THE 2026-10-21 REVIEW ROUND (CR-M-4), BECAUSE THE PARAGRAPH ABOVE WAS TOO KIND
 * ---------------------------------------------------------------------------------------------
 * The review's objection was sharper than "the fake is a fake": **`CannedXmlPort` only proves
 * `CannedXmlPort`**, because a real swap does not write a second `XmlPort` at all. It keeps this
 * class's byte cap, decode, `<!DOCTYPE>` refusal, pre-scan, differential and namespace layer, and
 * replaces exactly one function — `parseXmlString` — which had **no interface**, so there was
 * nothing to implement against and nothing a test could substitute. A second implementation of the
 * outer interface was therefore answering a question nobody asks on the day of the swap.
 *
 * So the inner seam is now named (`XmlParserAdapter` in `xml-port.ts`) and injected
 * (`new BoundedXmlPort(adapter)`), and the last block of this file CROSSES it: a hand-written
 * parser that shares no code with `@rgrove/parse-xml` is put behind the real port, and every bound
 * and the whole namespace layer are shown to hold over it. That is a demonstration rather than an
 * assertion, and it is a strictly stronger claim than `CannedXmlPort` makes.
 *
 * IT IS STILL NOT THE TWO-ADAPTER TEST, and the three things a real replacement must change are
 * listed on `XmlParserAdapter` rather than here so they sit with the interface: the throughput
 * constant is measured through THIS parser, `PRESCAN_DIFFERENTIAL` compares our tokenizer against
 * THIS parser's counting, and `MALFORMED` must remain the verdict for an undefined entity with no
 * DOCTYPE — which is the clause `fast-xml-parser` fails and the reason there is no second real
 * adapter today. The toy parser below is conformant on the shapes it is given and would not
 * survive a feed; naming it a demonstration of the seam, not a candidate, is the honest reading.
 *
 * Nothing below reaches behind the interface. That is the constraint R-4 puts on how these
 * assertions are written, and it is why they would survive a replacement.
 */

import { describe, expect, it } from 'vitest'
import { douFeedBytes, fixtureBytes, REJECTED_FIXTURES, utf8 } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { NamespaceScope, partitionAttributes, resolveAttributes, splitQName } from './namespaces'
import { DEFAULT_XML_LIMITS, itemCeiling } from './xml-limits'
import type {
  XmlDocument,
  XmlElementNode,
  XmlFailureReason,
  XmlLimits,
  XmlNodeUnion,
  XmlPort,
} from './xml-port'
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

/**
 * CROSSING THE INNER SEAM — the part `CannedXmlPort` could not do (CR-M-4).
 *
 * `tinyParse` below is about forty lines, shares no code with `@rgrove/parse-xml`, and is put
 * behind the REAL `BoundedXmlPort`. So everything the port owns runs over a different parser: the
 * byte cap, the fatal decode, the `<!DOCTYPE>` refusal, the pre-scan and its item budget, the
 * pre-scan/parser differential, and the whole namespace layer including the nine spec rules.
 *
 * WHAT THIS ESTABLISHES that the canned port does not: the port's complexity is genuinely
 * parser-independent — it is not accidentally relying on `@rgrove/parse-xml`'s behaviour anywhere
 * between the bytes and the tree. The differential check is the sharpest part of that: it compares
 * our tokenizer's counts against the TREE, so a parser that counted differently would turn it red,
 * and here it stays green against a second, independent counter.
 *
 * WHAT IT STILL DOES NOT ESTABLISH, stated so nobody upgrades the claim later: `tinyParse` handles
 * elements, attributes, text and self-closing tags, and nothing else — no entities, no CDATA, no
 * comments, no processing instructions, no encoding declaration. It would not survive a real feed
 * for one item. It is a demonstration that the seam is crossable, not a candidate to cross it with.
 * The candidate list is still R-4's: `sax`, or `fast-xml-parser` plus an undefined-entity scan.
 */

/**
 * Minimal parser: elements, attributes, text, self-closing. No entities, CDATA, comments or PIs.
 *
 * Resolution happens ON OPEN, against the parent frame's scope, exactly as `parse-xml.adapter.ts`
 * does it — and that is not incidental. The first draft of this resolved on CLOSE, from
 * `NamespaceScope.root()`, so a child never inherited its parent's default namespace and
 * `<title>` inside `<feed xmlns="…Atom">` came back in no namespace. The test caught it, which is
 * the second-best outcome; the best is the observation that a replacement adapter has exactly one
 * hard part, and it is this one. The scope must be threaded DOWN while the tree is built UP.
 */
function tinyParse(text: string): { root: XmlElementNode; declaredEncoding: string | null } {
  interface Frame {
    qualifiedName: string
    scope: NamespaceScope
    declarations: Record<string, string>
    attributes: XmlElementNode['attributes']
    name: { prefix: string | null; localName: string; namespaceUri: string | null }
    children: XmlNodeUnion[]
  }
  const stack: Frame[] = []
  let root: XmlElementNode | null = null
  let at = 0

  const fail = (why: string): never => {
    throw new XmlPortError('MALFORMED', `tinyParse: ${why}`)
  }

  // `partitionAttributes` / `resolveAttributes` / `NamespaceScope` are the PORT's rules, not the
  // parser's, so a replacement adapter is supposed to call them rather than reimplement them —
  // which is the argument for having moved attribute resolution out of `parse-xml.adapter.ts` and
  // into `namespaces.ts` this round. Every namespace assertion in the block below is therefore
  // testing shared code reached through a different parser, which is the useful thing to test.
  const open = (qualifiedName: string, raw: Record<string, string>): Frame => {
    const parentScope = stack[stack.length - 1]?.scope ?? NamespaceScope.root()
    const { declarations, rest } = partitionAttributes(raw)
    const scope = parentScope.child(declarations)
    const { prefix, localName } = splitQName(qualifiedName)
    const namespaceUri = scope.lookup(prefix ?? '')
    if (namespaceUri === undefined) {
      throw new XmlPortError('UNDECLARED_PREFIX', `tinyParse: prefix ${String(prefix)} undeclared`)
    }
    return {
      qualifiedName,
      scope,
      declarations,
      attributes: resolveAttributes(rest, scope, qualifiedName),
      name: { prefix, localName, namespaceUri },
      children: [],
    }
  }

  const close = (frame: Frame): XmlElementNode => {
    const node: XmlElementNode = {
      kind: 'element',
      localName: frame.name.localName,
      prefix: frame.name.prefix,
      namespaceUri: frame.name.namespaceUri,
      qualifiedName: frame.qualifiedName,
      attributes: frame.attributes,
      namespaceDeclarations: frame.declarations,
      children: frame.children,
      text: frame.children.reduce((acc, c) => (c.kind === 'text' ? acc + c.value : acc), ''),
    }
    const parent = stack[stack.length - 1]
    if (parent === undefined) root = node
    else parent.children.push(node)
    return node
  }

  while (at < text.length) {
    const lt = text.indexOf('<', at)
    if (lt === -1) break
    if (lt > at) {
      const value = text.slice(at, lt)
      const parent = stack[stack.length - 1]
      if (parent !== undefined && value.length > 0) parent.children.push({ kind: 'text', value })
    }
    const gt = text.indexOf('>', lt)
    if (gt === -1) fail('unterminated tag')
    const inner = text.slice(lt + 1, gt)
    at = gt + 1

    if (inner.startsWith('/')) {
      const frame = stack.pop()
      if (frame === undefined) fail('close tag with nothing open')
      if ((frame as Frame).qualifiedName !== inner.slice(1).trim()) fail('mismatched close tag')
      close(frame as Frame)
      continue
    }

    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const [name, ...attributeParts] = body.trim().split(/\s+(?=[^\s=]+\s*=)/)
    const raw: Record<string, string> = {}
    for (const part of attributeParts) {
      const eq = part.indexOf('=')
      if (eq === -1) fail('attribute without a value')
      raw[part.slice(0, eq).trim()] = part
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
    }
    const frame = open(name as string, raw)
    if (selfClosing) {
      close(frame)
    } else {
      stack.push(frame)
    }
  }

  if (stack.length > 0) fail('unclosed element')
  // A real `throw` rather than `fail(...)`: `root` is assigned inside the `close` closure, so
  // TypeScript does not carry the never-return narrowing of a helper across it and the old
  // `root as XmlElementNode` was a cast FROM `null` — which `tsconfig.spec.json` rejected and
  // `apps/api`'s own `tsc` never sees, because it does not typecheck spec files. Worth the two
  // extra lines: a cast that the compiler says cannot be right is not a cast worth keeping.
  if (root === null) throw new XmlPortError('MALFORMED', 'tinyParse: no root element')
  return { root, declaredEncoding: null }
}

describe('the real port over a parser that is not @rgrove/parse-xml', () => {
  const swapped = new BoundedXmlPort(tinyParse)

  it('POSITIVE CONTROL: the toy parser really is being used, not silently bypassed', () => {
    // Without this, every assertion below could be passing because the default adapter was still
    // in place — which would make the whole block decoration. A document only `tinyParse` refuses
    // (it has no CDATA support) and the real parser accepts is the cheapest discriminator.
    expect(() => swapped.parseDocument(utf8('<r><![CDATA[x]]></r>'))).toThrow(/tinyParse|MALFORMED/)
    expect(new BoundedXmlPort().parseDocument(utf8('<r><![CDATA[x]]></r>')).root.text).toBe('x')
  })

  it('parses a namespaced document and resolves prefixes to URIs', () => {
    const document = swapped.parseDocument(
      utf8('<feed xmlns="http://www.w3.org/2005/Atom"><title>Hi</title></feed>'),
    )
    expect(document.root.localName).toBe('feed')
    expect(document.root.namespaceUri).toBe('http://www.w3.org/2005/Atom')
    expect(findChild(document.root, 'title')?.namespaceUri).toBe('http://www.w3.org/2005/Atom')
    expect(collectText(document.root)).toBe('Hi')
  })

  it('the byte cap holds over the swapped parser', () => {
    const bytes = utf8(`<r>${'x'.repeat(DEFAULT_XML_LIMITS.maxBytes)}</r>`)
    expect(reasonOfSwap(() => swapped.parseDocument(bytes))).toBe('TOO_MANY_BYTES')
  })

  it('the DOCTYPE refusal holds over the swapped parser', () => {
    expect(reasonOfSwap(() => swapped.parseDocument(utf8('<!DOCTYPE r><r/>')))).toBe(
      'DOCTYPE_FORBIDDEN',
    )
  })

  it('the depth and item bounds hold over the swapped parser', () => {
    const deep = `${'<a>'.repeat(200)}x${'</a>'.repeat(200)}`
    expect(reasonOfSwap(() => swapped.parseDocument(utf8(deep)))).toBe('TOO_DEEP')
    const wide = `<r>${'<i/>'.repeat(itemCeiling(DEFAULT_XML_LIMITS))}</r>`
    expect(reasonOfSwap(() => swapped.parseDocument(utf8(wide)))).toBe('TIME_BUDGET')
    const attributes = Array.from({ length: 30_000 }, (_, k) => `a${k}="v"`).join(' ')
    expect(reasonOfSwap(() => swapped.parseDocument(utf8(`<r ${attributes}/>`)))).toBe(
      'TIME_BUDGET',
    )
  })

  it('the namespace rules hold over the swapped parser', () => {
    // The nine spec departures closed this round, over a different parser. This is the clearest
    // evidence that they live in the namespace layer and not in the parse-xml adapter.
    expect(reasonOfSwap(() => swapped.parseDocument(utf8('<r xmlns:p=""/>')))).toBe(
      'PREFIX_UNDECLARING',
    )
    expect(reasonOfSwap(() => swapped.parseDocument(utf8('<r xmlns:xml="http://e/o"/>')))).toBe(
      'RESERVED_NAMESPACE',
    )
    expect(reasonOfSwap(() => swapped.parseDocument(utf8('<r a:b:c="1"/>')))).toBe(
      'MALFORMED_QNAME',
    )
    expect(reasonOfSwap(() => swapped.parseDocument(utf8('<constructor:a/>')))).toBe(
      'UNDECLARED_PREFIX',
    )
    expect(
      reasonOfSwap(() =>
        swapped.parseDocument(
          utf8('<r xmlns:a="http://e/u" xmlns:b="http://e/u" a:x="1" b:x="2"/>'),
        ),
      ),
    ).toBe('DUPLICATE_ATTRIBUTE')
  })

  it('the pre-scan differential holds — two independent counters agree', () => {
    // The sharpest assertion in the block. Our tokenizer counts elements and attributes; so does
    // `tinyParse`, by completely different means. `PRESCAN_DIFFERENTIAL` fires if they disagree,
    // so a green result here is two independent implementations reaching the same measurement.
    const document = swapped.parseDocument(
      utf8('<r xmlns:p="http://e/p" a="1"><i b="2" c="3"/><j><k/></j></r>'),
    )
    // r, i, j, k = 4. Counted by hand from the document rather than copied from a run — the first
    // draft of this line said 5, and a wrong literal here would have been "fixed" by reading the
    // output, which is how an assertion stops being independent of the code it checks.
    expect(document.elementCount).toBe(4)
    expect(document.depth).toBe(3)
  })
})

function reasonOfSwap(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof XmlPortError) return error.reason
    throw error
  }
  throw new Error('expected a refusal, but the call returned')
}
