/**
 * R-3: the DOCTYPE check runs on the DECODED STRING, and `TextDecoder` is fatal.
 *
 * Both halves were found by review rather than by design, and both have the same shape: a check
 * that looks correct and stops nothing.
 *
 *   - a byte-level `<!DOCTYPE` match is BYPASSED by a UTF-16 feed, whose bytes are
 *     `3C 00 21 00 44 00 …` and contain no ASCII `<!DOCTYPE` to find;
 *   - `new TextDecoder(label)` is NON-FATAL by default, so `61 FF 62` decodes silently to
 *     `a�b` — a corrupted vacancy accepted as content, where the plan requires drift.
 *
 * The UTF-16 test below is written so that it would FAIL against a byte-level check: it is the
 * same document in two encodings, and both must be refused for the same reason.
 */

import { describe, expect, it } from 'vitest'
import { encodeUtf16Le, encodeWindows1251, fixtureText, utf8 } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { decodeXml } from './decode'
import { collectText, findChild } from './xml-tree'
import { XmlPortError } from './xml-port'

const port = new BoundedXmlPort()

const reasonOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof XmlPortError) return error.reason
    throw error
  }
  throw new Error('expected a refusal, but the call returned')
}

describe('R-3: the DOCTYPE refusal survives the encoding', () => {
  const doctypeDocument = '<!DOCTYPE r [<!ENTITY a "AAA">]><r>hello</r>'

  it('is refused as UTF-8', () => {
    expect(reasonOf(() => port.parseDocument(utf8(doctypeDocument)))).toBe('DOCTYPE_FORBIDDEN')
  })

  it('is refused as UTF-16LE with a BOM — the case a byte-level check misses', () => {
    const bytes = encodeUtf16Le(doctypeDocument)
    // The premise, asserted rather than assumed: the ASCII needle is genuinely not in the bytes.
    const asBytes = Array.from(bytes)
      .map((b) => String.fromCharCode(b))
      .join('')
    expect(asBytes).not.toContain('<!DOCTYPE')

    expect(reasonOf(() => port.parseDocument(bytes))).toBe('DOCTYPE_FORBIDDEN')
  })

  it('is refused as UTF-16LE WITHOUT a BOM, recognised from the leading `<`', () => {
    const bytes = encodeUtf16Le(doctypeDocument, { bom: false })
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('DOCTYPE_FORBIDDEN')
  })

  it('is refused in lower case', () => {
    expect(reasonOf(() => port.parseDocument(utf8('<!doctype r><r>x</r>')))).toBe(
      'DOCTYPE_FORBIDDEN',
    )
  })

  it('POSITIVE CONTROL: a UTF-16LE document WITHOUT a doctype parses, with its text intact', () => {
    // Without this, every assertion above would also pass for a port that refused all UTF-16.
    const document = port.parseDocument(encodeUtf16Le('<r><title>Привіт</title></r>'))
    expect(findChild(document.root, 'title')?.text).toBe('Привіт')
    expect(document.effectiveEncoding).toBe('utf-16le')
  })

  it('the literal inside CDATA is still refused — and that is deliberate', () => {
    // A conservative false positive, recorded as a decision rather than left to be discovered: a
    // feed mentioning the doctype markup in a vacancy description is refused. No job board does
    // this, and the alternative — a check that understands CDATA — is a second parser of the
    // construct the real parser already parses, i.e. a differential surface for no benefit.
    expect(
      reasonOf(() => port.parseDocument(utf8('<r><d><![CDATA[say <!DOCTYPE x>]]></d></r>'))),
    ).toBe('DOCTYPE_FORBIDDEN')
  })

  it('the literal inside an XML COMMENT is refused too — measured, not predicted', () => {
    // The same conservative reach, one construct further, and it is in this suite because it bit:
    // `attack-undefined-entity-no-doctype.xml` carried the literal in its own explanatory comment
    // and was refused as DOCTYPE_FORBIDDEN where MALFORMED was the whole point of the fixture.
    // Pinned here so the reach is a known property of the check rather than a trap for the next
    // person writing a fixture.
    expect(reasonOf(() => port.parseDocument(utf8('<r><!-- <!DOCTYPE x> --><d/></r>')))).toBe(
      'DOCTYPE_FORBIDDEN',
    )
  })
})

describe('R-3: decoding is fatal, so malformed bytes are drift', () => {
  it('invalid UTF-8 raises instead of yielding a replacement character', () => {
    // `61 FF 62` — the reviewer's own case. Non-fatally this is `a�b`.
    const bytes = new Uint8Array([...utf8('<r><t>'), 0x61, 0xff, 0x62, ...utf8('</t></r>')])
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('UNDECODABLE')
  })

  it('POSITIVE CONTROL: the same shape with valid bytes parses to the exact text', () => {
    const bytes = utf8('<r><t>a-b</t></r>')
    expect(findChild(port.parseDocument(bytes).root, 't')?.text).toBe('a-b')
  })

  it('no decode anywhere produces U+FFFD from the corpus', () => {
    // A blanket statement over the committed documents: if any fixture silently degraded, the
    // replacement character would be the evidence.
    for (const file of ['atom-namespaced.xml', 'rss-cdata-entities.xml', 'rss-empty.xml']) {
      const document = port.parseDocument(utf8(fixtureText(file)))
      expect(collectText(document.root), file).not.toContain('�')
    }
  })
})

describe('R-3: explicit non-UTF-8 encoding declarations', () => {
  it('a windows-1251 feed decodes to the right characters, not mojibake', () => {
    // Every parser measured produced mojibake here, because they all take a STRING and the damage
    // happens before them. This is the requirement that relocated into the port.
    const declaration = '<?xml version="1.0" encoding="windows-1251"?>'
    const bytes = new Uint8Array([
      ...utf8(declaration),
      ...utf8('<r><title>'),
      ...encodeWindows1251('Программист'),
      ...utf8('</title></r>'),
    ])
    const document = port.parseDocument(bytes)
    expect(findChild(document.root, 'title')?.text).toBe('Программист')
    expect(document.declaredEncoding).toBe('windows-1251')
    expect(document.effectiveEncoding).toBe('windows-1251')
  })

  it('NEGATIVE CONTROL: the same bytes read as UTF-8 would NOT yield that text', () => {
    // Proves the previous test measures the transcoding rather than passing by accident: these
    // bytes are not valid UTF-8 at all, so a port that ignored the declaration would refuse them.
    const bytes = new Uint8Array([
      ...utf8('<r><title>'),
      ...encodeWindows1251('Программист'),
      ...utf8('</title></r>'),
    ])
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('UNDECODABLE')
  })

  it('an encoding Node cannot decode is refused as unsupported, not as malformed', () => {
    const bytes = utf8('<?xml version="1.0" encoding="x-not-a-real-charset"?><r>x</r>')
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('UNSUPPORTED_ENCODING')
  })

  it('a UTF-8 BOM is stripped rather than handed to the parser as content', () => {
    // A BOM left in place is a character before the `<?xml`, which is not well-formed — so a port
    // that forgot to skip it would report MALFORMED on a perfectly ordinary feed.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<r><t>ok</t></r>')])
    const document = port.parseDocument(bytes)
    expect(findChild(document.root, 't')?.text).toBe('ok')
    expect(document.effectiveEncoding).toBe('utf-8')
  })

  it('a BOM that contradicts the declaration is drift, not a precedence puzzle', () => {
    const bytes = encodeUtf16Le('<?xml version="1.0" encoding="windows-1251"?><r>x</r>')
    expect(reasonOf(() => port.parseDocument(bytes))).toBe('ENCODING_CONFLICT')
  })

  it('a BOM agreeing with the declaration is accepted', () => {
    // The other side of the conflict check: without this, refusing ALL BOM+declaration documents
    // would pass the test above.
    const bytes = encodeUtf16Le('<?xml version="1.0" encoding="utf-16"?><r><t>ok</t></r>')
    expect(findChild(port.parseDocument(bytes).root, 't')?.text).toBe('ok')
  })

  it('no declaration and no BOM defaults to UTF-8', () => {
    const decoded = decodeXml(utf8('<r>Привіт</r>'))
    expect(decoded.source).toBe('default')
    expect(decoded.declaredEncoding).toBeNull()
    expect(decoded.text).toBe('<r>Привіт</r>')
  })
})
