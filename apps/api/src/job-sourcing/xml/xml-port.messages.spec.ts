/**
 * Every refusal message, asserted — because a `reason` alone is not diagnosable.
 *
 * WHY THESE ARE WORTH ASSERTING AND NOT JUST SUPPRESSING
 * -----------------------------------------------------
 * `reason` is the branch a caller takes; the message is what a human reads in a log when a feed
 * stops collecting at 3 a.m. "XML body is 2097153 bytes, over the 2097152 byte cap" and "" are
 * both valid `TOO_MANY_BYTES` refusals and only one of them ends the investigation. So the numbers
 * in these messages are part of the contract, and a mutation that empties them is a real
 * regression rather than noise.
 *
 * Asserted on CONTENT, not on the whole string: each test names the facts the message must carry
 * — the offending value and the limit — and stays indifferent to wording. Pinning the exact
 * sentence would make every rewording a red test, which trains people to stop improving messages.
 */

import { describe, expect, it } from 'vitest'
import { encodeUtf16Le, encodeWindows1251, utf8 } from '../../test/xml-corpus'
import { BoundedXmlPort } from './bounded-xml-port'
import { DEFAULT_XML_LIMITS, MAX_XML_BYTES, MAX_XML_DEPTH } from './xml-limits'
import { XmlPortError } from './xml-port'

const port = new BoundedXmlPort()

function refusal(run: () => unknown): XmlPortError {
  try {
    run()
  } catch (error) {
    if (error instanceof XmlPortError) return error
    throw error
  }
  throw new Error('expected a refusal, but the call returned')
}

describe('refusal messages carry the offending value AND the limit', () => {
  it('TOO_MANY_BYTES names both sizes', () => {
    const bytes = utf8(`<r>${'x'.repeat(MAX_XML_BYTES)}</r>`)
    const error = refusal(() => port.parseDocument(bytes))
    expect(error.reason).toBe('TOO_MANY_BYTES')
    expect(error.message).toContain(String(bytes.byteLength))
    expect(error.message).toContain(String(MAX_XML_BYTES))
  })

  it('TOO_DEEP names the limit and the depth reached', () => {
    const error = refusal(() =>
      port.parseDocument(
        utf8(`${'<a>'.repeat(MAX_XML_DEPTH + 1)}x${'</a>'.repeat(MAX_XML_DEPTH + 1)}`),
      ),
    )
    expect(error.reason).toBe('TOO_DEEP')
    expect(error.message).toContain(String(MAX_XML_DEPTH))
    expect(error.message).toContain(String(MAX_XML_DEPTH + 1))
  })

  it('TIME_BUDGET names the ceiling and the budget it came from', () => {
    const error = refusal(() => port.parseDocument(utf8(`<r>${'<i/>'.repeat(12_500)}</r>`)))
    expect(error.reason).toBe('TIME_BUDGET')
    // Both numbers: the ceiling alone would not tell a reader WHY 12 500, which is the one thing
    // they need to decide whether to raise the budget or reduce the feed.
    expect(error.message).toContain('12500')
    expect(error.message).toContain(String(DEFAULT_XML_LIMITS.maxWallClockMs))
  })

  it('TOO_MANY_ELEMENTS names the element cap', () => {
    const limits = { ...DEFAULT_XML_LIMITS, maxWallClockMs: 10_000, maxElements: 20 }
    const error = refusal(() => port.parseDocument(utf8(`<r>${'<i/>'.repeat(25)}</r>`), limits))
    expect(error.reason).toBe('TOO_MANY_ELEMENTS')
    expect(error.message).toContain('20')
  })

  it('DOCTYPE_FORBIDDEN says what was found and that it was refused', () => {
    const error = refusal(() => port.parseDocument(utf8('<!DOCTYPE r><r/>')))
    expect(error.reason).toBe('DOCTYPE_FORBIDDEN')
    expect(error.message).toMatch(/DOCTYPE/i)
    expect(error.message).toMatch(/refus/i)
  })

  it('UNSUPPORTED_ENCODING quotes the label it could not use', () => {
    const error = refusal(() =>
      port.parseDocument(utf8('<?xml version="1.0" encoding="x-nope"?><r/>')),
    )
    expect(error.reason).toBe('UNSUPPORTED_ENCODING')
    expect(error.message).toContain('x-nope')
    // And the cause is preserved, so the underlying RangeError is in the log too.
    expect(error.cause).toBeInstanceOf(RangeError)
  })

  it('UNDECODABLE names the encoding it decoded with and that it was fatal', () => {
    const bytes = new Uint8Array([...utf8('<r><t>'), 0x61, 0xff, 0x62, ...utf8('</t></r>')])
    const error = refusal(() => port.parseDocument(bytes))
    expect(error.reason).toBe('UNDECODABLE')
    expect(error.message).toContain('utf-8')
    expect(error.message).toContain('fatal')
  })

  it('ENCODING_CONFLICT names BOTH claims the document made about itself', () => {
    const error = refusal(() =>
      port.parseDocument(encodeUtf16Le('<?xml version="1.0" encoding="windows-1251"?><r/>')),
    )
    expect(error.reason).toBe('ENCODING_CONFLICT')
    expect(error.message).toContain('utf-16le')
    expect(error.message).toContain('windows-1251')
  })

  it('MALFORMED carries the parser`s own explanation through', () => {
    const error = refusal(() => port.parseDocument(utf8('<r><t>unclosed')))
    expect(error.reason).toBe('MALFORMED')
    expect(error.message).toMatch(/not well-formed/i)
    // The parser-specific part, which is why `cause` exists: the reason is portable, the detail
    // is not, and throwing the detail away would make a malformed feed undiagnosable.
    expect(error.message.length).toBeGreaterThan('XML is not well-formed: '.length)
    expect(error.cause).toBeInstanceOf(Error)

    // The cause's MESSAGE, not its `String()` form. `String(err)` yields "XmlError: …", which
    // leaks the parser's class name into a message the seam exists to keep parser-neutral — and
    // it is also what distinguishes the real `cause instanceof Error ? cause.message : String(…)`
    // from both of its mutations (always-String, and a body that returns nothing at all).
    expect(error.message).toContain((error.cause as Error).message)
    expect(error.message).not.toContain('XmlError')
    expect(error.message).not.toContain('undefined')
  })

  it('UNDECLARED_PREFIX names the element and the prefix', () => {
    const error = refusal(() => port.parseDocument(utf8('<r><ghost:t>x</ghost:t></r>')))
    expect(error.reason).toBe('UNDECLARED_PREFIX')
    expect(error.message).toContain('ghost')
    expect(error.message).toContain('ghost:t')
  })

  it('UNDECLARED_PREFIX on an ATTRIBUTE names the attribute and its owner', () => {
    // A separate code path from the element case, and the owner element is the part that makes it
    // findable in a 200-item feed.
    const error = refusal(() => port.parseDocument(utf8('<r><t ghost:a="1">x</t></r>')))
    expect(error.reason).toBe('UNDECLARED_PREFIX')
    expect(error.message).toContain('ghost:a')
    expect(error.message).toContain('t')
  })

  it('every refusal is named XmlPortError, so it is recognisable in a stack trace', () => {
    expect(refusal(() => port.parseDocument(utf8('<r>'))).name).toBe('XmlPortError')
  })

  it('no refusal message is empty', () => {
    // The blanket version of the above: a mutation that empties any one message is caught by its
    // own test, and this catches one added later without a test.
    const cases: (() => unknown)[] = [
      () => port.parseDocument(utf8(`<r>${'x'.repeat(MAX_XML_BYTES)}</r>`)),
      () => port.parseDocument(utf8('<!DOCTYPE r><r/>')),
      () => port.parseDocument(utf8('<r><t>unclosed')),
      () => port.parseDocument(utf8('<r><ghost:t/></r>')),
      () => port.parseDocument(utf8('<?xml version="1.0" encoding="x-nope"?><r/>')),
      () => port.parseDocument(encodeUtf16Le('<?xml version="1.0" encoding="koi8-r"?><r/>')),
      () => port.parseDocument(new Uint8Array([...utf8('<r>'), 0xff, ...utf8('</r>')])),
      () => port.parseDocument(utf8(`${'<a>'.repeat(200)}x${'</a>'.repeat(200)}`)),
      () => port.parseDocument(utf8(`<r>${'<i/>'.repeat(12_500)}</r>`)),
    ]
    for (const [index, run] of cases.entries()) {
      expect(refusal(run).message.length, `case ${index}`).toBeGreaterThan(10)
    }
  })
})

describe('a successful parse reports what it actually did', () => {
  it('declaredEncoding and effectiveEncoding are both populated and can differ', () => {
    const bytes = new Uint8Array([
      ...utf8('<?xml version="1.0" encoding="windows-1251"?><r><t>'),
      ...encodeWindows1251('Да'),
      ...utf8('</t></r>'),
    ])
    const document = port.parseDocument(bytes)
    expect(document.declaredEncoding).toBe('windows-1251')
    expect(document.effectiveEncoding).toBe('windows-1251')
  })

  it('declaredEncoding is null when the document declares nothing', () => {
    // Distinct from 'utf-8': "declared UTF-8" and "declared nothing, so we assumed UTF-8" are
    // different facts, and only one of them is the feed's own claim.
    const document = port.parseDocument(utf8('<r><t>x</t></r>'))
    expect(document.declaredEncoding).toBeNull()
    expect(document.effectiveEncoding).toBe('utf-8')
  })

  it('depth and elementCount are the real figures, not placeholders', () => {
    const document = port.parseDocument(utf8('<r><a><b/></a><c/></r>'))
    expect(document).toMatchObject({ depth: 3, elementCount: 4 })
  })
})
