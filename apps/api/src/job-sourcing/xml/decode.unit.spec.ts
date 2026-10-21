/**
 * `decodeXml` directly: every branch of the BOM sniff, the BOM-less UTF-16 sniff, and the
 * declaration reader.
 *
 * `decode.spec.ts` drives these through the port, which is the right level for the R-3 contract but
 * only reaches the branches a feed happens to take. The encoding-detection code is a sequence of
 * byte comparisons where each branch is one `===` away from its neighbour, and a mutation testing
 * run showed most of them indistinguishable — a wrong BOM length, a swapped byte order, a
 * `>= 2` turned into `> 2` all produce plausible output on the documents the port-level specs use.
 *
 * So each branch gets an input that ONLY that branch handles, and the assertions name the three
 * things the branch decides: which label was chosen, how it was chosen (`source`), and how many
 * bytes were skipped (visible as the decoded text).
 */

import { describe, expect, it } from 'vitest'
import { encodeUtf16Le, utf8 } from '../../test/xml-corpus'
import { decodeXml } from './decode'
import { XmlPortError } from './xml-port'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const utf16be = (text: string, withBom: boolean): Uint8Array => {
  const body = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    body[i * 2] = unit >> 8
    body[i * 2 + 1] = unit & 0xff
  }
  return withBom ? concat(bytes(0xfe, 0xff), body) : body
}

describe('BOM detection', () => {
  it('a UTF-8 BOM is recognised and its three bytes are skipped', () => {
    const decoded = decodeXml(concat(bytes(0xef, 0xbb, 0xbf), utf8('<r/>')))
    expect(decoded.effectiveEncoding).toBe('utf-8')
    expect(decoded.source).toBe('bom')
    // The text proves the LENGTH: a bomLength of 2 would leave a stray byte and the string would
    // start with U+FFFD rather than `<`.
    expect(decoded.text).toBe('<r/>')
  })

  it('a UTF-16LE BOM is recognised and its two bytes are skipped', () => {
    const decoded = decodeXml(encodeUtf16Le('<r/>'))
    expect(decoded.effectiveEncoding).toBe('utf-16le')
    expect(decoded.source).toBe('bom')
    expect(decoded.text).toBe('<r/>')
  })

  it('a UTF-16BE BOM is recognised — byte order is not assumed', () => {
    // The branch most at risk: FE FF and FF FE differ only in order, and a document decoded with
    // the wrong one yields CJK-looking garbage rather than an error.
    const decoded = decodeXml(utf16be('<r/>', true))
    expect(decoded.effectiveEncoding).toBe('utf-16be')
    expect(decoded.source).toBe('bom')
    expect(decoded.text).toBe('<r/>')
  })

  it('a two-byte prefix that is NOT a BOM is left alone', () => {
    const decoded = decodeXml(utf8('<r/>'))
    expect(decoded.source).toBe('default')
    expect(decoded.text).toBe('<r/>')
  })

  it('an incomplete UTF-8 BOM is not treated as one', () => {
    // `EF BB` without `BF`. A length check of `>= 2` instead of `>= 3` would read `bytes[2]` as
    // undefined, fail the comparison, and fall through — but a careless rewrite could match.
    expect(() => decodeXml(concat(bytes(0xef, 0xbb), utf8('<r/>')))).toThrow(XmlPortError)
  })

  /**
   * NEAR-MISS BOMs — one byte wrong in each position.
   *
   * These exist because a mutation run showed the BOM conditions were **not** pinned by the
   * happy-path tests: replacing `bytes[1] === 0xbb` with `true` survived, since no input had
   * `EF ?? BF` with a wrong middle byte. A three-byte comparison needs three near-misses to be
   * tested, not one correct BOM — the correct BOM proves the whole condition can be true, and
   * each near-miss proves one conjunct is load-bearing.
   *
   * Each sequence below is still VALID UTF-8 — `EF`/`EE` plus two continuation bytes is an
   * ordinary three-byte character — so the distinguishing outcome is not an error but the TEXT:
   * a BOM is consumed and leaves `<r/>`, while a non-BOM decodes to one extra leading character.
   * Asserting a throw here was simply wrong about these bytes, and the test said so.
   */
  it.each([
    ['wrong first byte', [0xee, 0xbb, 0xbf]],
    ['wrong second byte', [0xef, 0xbc, 0xbf]],
    ['wrong third byte', [0xef, 0xbb, 0xbe]],
  ])('a UTF-8 BOM with the %s is not consumed as a BOM', (_name, prefix) => {
    const decoded = decodeXml(concat(bytes(...prefix), utf8('<r/>')))
    expect(decoded.source).toBe('default')
    // Five characters, not four: the three bytes became one character of content rather than
    // being skipped. If any conjunct of the BOM test were dropped, this would be `<r/>`.
    expect(decoded.text).toHaveLength(5)
    expect(decoded.text.endsWith('<r/>')).toBe(true)
    expect(decoded.text).not.toBe('<r/>')
  })

  /**
   * THE BOM TRUTH TABLE — every near-miss, as a table, because the near-misses I wrote by hand
   * were incomplete in a way I could not see by reading.
   *
   * A mutation run reported `(bytes.length >= 2 || bytes[0] === 0xff) && bytes[1] === 0xfe` as
   * surviving. Applying it by hand confirmed it: all 319 tests passed. The gap was precise — every
   * near-miss I had written varied the SECOND byte (`FF FD`, `FE FD`), and none varied the FIRST
   * while keeping the second correct. So `bytes[0] === 0xff` was never load-bearing.
   *
   * A three-byte comparison has three conjuncts and two length boundaries; the only way to be sure
   * each one matters is to enumerate. Hence a table rather than prose.
   */
  const ROOT = utf8('<r/>')

  it.each([
    // Split from the UTF-8 row rather than guarded by an `if` inside one test: a conditional
    // `expect` is a test that may assert nothing, and eslint's `vitest/no-conditional-expect`
    // said so. These two rows cannot assert the TEXT, because ASCII bytes after a UTF-16 BOM
    // decode as UTF-16 to CJK — the label is what the branch decides, so the label is what is
    // asserted.
    [[0xff, 0xfe], 'utf-16le'],
    [[0xfe, 0xff], 'utf-16be'],
  ] as const)('%s is a BOM selecting %s', (prefix, label) => {
    const decoded = decodeXml(concat(bytes(...prefix), ROOT))
    expect(decoded.effectiveEncoding).toBe(label)
    expect(decoded.source).toBe('bom')
  })

  it('EF BB BF is a BOM selecting utf-8, and the remainder is the document', () => {
    const decoded = decodeXml(concat(bytes(0xef, 0xbb, 0xbf), ROOT))
    expect(decoded.effectiveEncoding).toBe('utf-8')
    expect(decoded.source).toBe('bom')
    expect(decoded.text).toBe('<r/>')
  })

  it.each([
    ['3C FE — second byte right, FIRST byte wrong, must not be UTF-16LE', [0x3c, 0xfe]],
    ['3C FF — second byte right, FIRST byte wrong, must not be UTF-16BE', [0x3c, 0xff]],
  ])('%s', (_name, prefix) => {
    // These two are the inputs the hand-written near-misses lacked. `FE` and `FF` are never valid
    // UTF-8, so "consumed as a BOM" and "decoded as content" are cleanly distinguishable: as a
    // BOM the remainder would decode; as content the decode fails.
    let raised: unknown
    try {
      decodeXml(concat(bytes(...prefix), ROOT))
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError | undefined)?.reason).toBe('UNDECODABLE')
  })

  it('a two-byte document `3C 00` IS sniffed — the length guard is `< 2`, not `<= 2`', () => {
    // The other length boundary. With `bytes.length <= 2` the sniff would bail on a document of
    // exactly two bytes and read it as UTF-8, yielding `<\u0000` instead of `<`.
    const decoded = decodeXml(bytes(0x3c, 0x00))
    expect(decoded.effectiveEncoding).toBe('utf-16le')
    expect(decoded.source).toBe('utf16-sniff')
    expect(decoded.text).toBe('<')
  })

  it('FF followed by something other than FE is not a UTF-16LE BOM', () => {
    // `FF FD` — the first byte of the LE BOM with the wrong second. `FF` is never valid UTF-8, so
    // consuming it as a BOM versus decoding it as content are distinguishable outcomes.
    let raised: unknown
    try {
      decodeXml(concat(bytes(0xff, 0xfd), utf8('<r/>')))
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError | undefined)?.reason).toBe('UNDECODABLE')
  })

  it('FE followed by something other than FF is not a UTF-16BE BOM', () => {
    let raised: unknown
    try {
      decodeXml(concat(bytes(0xfe, 0xfd), utf8('<r/>')))
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError | undefined)?.reason).toBe('UNDECODABLE')
  })

  it('the two UTF-16 BOMs are not interchangeable', () => {
    // `FF FE` and `FE FF` both pass a byte-order-agnostic check, and both decode *something*.
    // Asserting the labels differ is what makes the two branches distinguishable.
    expect(decodeXml(encodeUtf16Le('<r/>')).effectiveEncoding).toBe('utf-16le')
    expect(decodeXml(utf16be('<r/>', true)).effectiveEncoding).toBe('utf-16be')
  })

  it.each([
    ['FF FE (LE)', [0xff, 0xfe], 'utf-16le'],
    ['FE FF (BE)', [0xfe, 0xff], 'utf-16be'],
  ] as const)(
    'a two-byte document that is exactly the %s BOM is recognised at the length boundary',
    (_name, prefix, label) => {
      const decoded = decodeXml(bytes(...prefix))
      expect(decoded.text).toBe('')
      expect(decoded.effectiveEncoding).toBe(label)
      expect(decoded.source).toBe('bom')
    },
  )

  it('a three-byte document that is exactly the UTF-8 BOM is recognised AS a BOM', () => {
    const decoded = decodeXml(bytes(0xef, 0xbb, 0xbf))
    expect(decoded.text).toBe('')
    // `source`, not just the label — and that is the whole point of this assertion.
    //
    // Node's UTF-8 `TextDecoder` STRIPS a leading BOM by itself (measured: decoding `EF BB BF`
    // yields `""`, not `"﻿"`), so the text and the label are identical whether our own
    // sniff consumed those three bytes or never ran. That made the `>= 3` length boundary
    // invisible: mutating it to `> 3` left all 337 tests passing. What the branch uniquely
    // decides is the reported PROVENANCE — whether the document announced its encoding or we
    // assumed it — so that is what has to be asserted.
    expect(decoded.source).toBe('bom')
  })

  it('the UTF-8 BOM branch is not redundant with TextDecoder: provenance differs', () => {
    // The pair that shows `source` carries real information: identical text and label, different
    // provenance. A caller reconciling a feed's declared encoding against the effective one needs
    // to know which it is looking at.
    expect(decodeXml(concat(bytes(0xef, 0xbb, 0xbf), utf8('<r/>'))).source).toBe('bom')
    expect(decodeXml(utf8('<r/>')).source).toBe('default')
  })

  it('a one-byte document cannot be a BOM, and the length guards hold', () => {
    // Both sniffs guard on length before indexing. `decodeXml` DECODES; it does not validate
    // XML — so a lone `<` is a successful decode of one character, and the thing being asserted
    // is that neither sniff fired and nothing read past the end. (That `decodeXml` does not
    // reject malformed XML is the parser's job, and asserting a throw here was simply wrong
    // about this function's contract.)
    const decoded = decodeXml(bytes(0x3c))
    expect(decoded.text).toBe('<')
    expect(decoded.source).toBe('default')
    expect(decoded.effectiveEncoding).toBe('utf-8')
  })

  it('an empty document decodes to the empty string rather than throwing in the sniff', () => {
    expect(decodeXml(new Uint8Array(0)).text).toBe('')
  })
})

describe('BOM-less UTF-16 detection, from the shape of the leading `<`', () => {
  it('`3C 00` is recognised as UTF-16LE with nothing skipped', () => {
    const decoded = decodeXml(encodeUtf16Le('<r/>', { bom: false }))
    expect(decoded.effectiveEncoding).toBe('utf-16le')
    expect(decoded.source).toBe('utf16-sniff')
    // bomLength must be 0 here: skipping two bytes would eat the `<` and leave `r/>`.
    expect(decoded.text).toBe('<r/>')
  })

  it('`00 3C` is recognised as UTF-16BE with nothing skipped', () => {
    const decoded = decodeXml(utf16be('<r/>', false))
    expect(decoded.effectiveEncoding).toBe('utf-16be')
    expect(decoded.source).toBe('utf16-sniff')
    expect(decoded.text).toBe('<r/>')
  })

  it('a document not starting with `<` is not sniffed as UTF-16', () => {
    // Leading whitespace before the root is legal XML but means the sniff cannot fire; the
    // document must then be read as UTF-8 rather than guessed at.
    const decoded = decodeXml(utf8(' <r/>'))
    expect(decoded.effectiveEncoding).toBe('utf-8')
    expect(decoded.source).toBe('default')
  })

  it('`3C 01` is NOT UTF-16LE — the second byte must be NUL', () => {
    // Near-miss for the LE branch: `<` followed by a non-NUL. Without the second conjunct this
    // would be read as UTF-16LE and the whole document would decode to CJK-looking garbage
    // instead of being read as UTF-8 text.
    const decoded = decodeXml(concat(bytes(0x3c, 0x01), utf8('rest')))
    expect(decoded.effectiveEncoding).toBe('utf-8')
    expect(decoded.source).toBe('default')
  })

  it('`01 3C` is NOT UTF-16BE — the first byte must be NUL', () => {
    const decoded = decodeXml(concat(bytes(0x01, 0x3c), utf8('rest')))
    expect(decoded.effectiveEncoding).toBe('utf-8')
    expect(decoded.source).toBe('default')
  })

  it('`00 00` is neither — both sniffs require a `<` in one position', () => {
    // A document of NULs must not be claimed by either branch. It is invalid UTF-8? No — NUL is
    // valid UTF-8, so this decodes, and the assertion is that it was not MIS-labelled.
    const decoded = decodeXml(bytes(0x00, 0x00, 0x00))
    expect(decoded.effectiveEncoding).toBe('utf-8')
    expect(decoded.source).toBe('default')
  })

  it('a single byte `3C` cannot satisfy either sniff', () => {
    expect(decodeXml(bytes(0x3c)).source).toBe('default')
  })
})

describe('the declaration reader', () => {
  it('reads a double-quoted label', () => {
    expect(decodeXml(utf8('<?xml version="1.0" encoding="utf-8"?><r/>')).declaredEncoding).toBe(
      'utf-8',
    )
  })

  it('reads a single-quoted label', () => {
    // The second alternative of the regex. Both quote styles are legal and feeds use both.
    expect(decodeXml(utf8("<?xml version='1.0' encoding='utf-8'?><r/>")).declaredEncoding).toBe(
      'utf-8',
    )
  })

  it('tolerates whitespace around the equals sign', () => {
    expect(decodeXml(utf8('<?xml version="1.0" encoding = "utf-8"?><r/>')).declaredEncoding).toBe(
      'utf-8',
    )
  })

  it('a declaration with no encoding yields null, not an empty string', () => {
    // `null` means "the document did not say"; `''` would be a label we then tried to decode with.
    expect(decodeXml(utf8('<?xml version="1.0"?><r/>')).declaredEncoding).toBeNull()
  })

  it('a document with no declaration at all yields null', () => {
    expect(decodeXml(utf8('<r/>')).declaredEncoding).toBeNull()
  })

  it('an unterminated declaration yields null rather than scanning the document', () => {
    // No `?>`. Without the `declarationEnd === -1` guard the regex would run over the whole
    // 512-character window and could match an `encoding=` that is element content.
    expect(decodeXml(utf8('<?xml version="1.0" encoding="utf-8"')).declaredEncoding).toBeNull()
  })

  it('an `encoding=` attribute in CONTENT is not mistaken for the declaration', () => {
    // The startsWith guard. A feed carrying `encoding="koi8-r"` as element data must not change
    // how the document is decoded.
    const decoded = decodeXml(utf8('<r><cfg encoding="koi8-r"/></r>'))
    expect(decoded.declaredEncoding).toBeNull()
    expect(decoded.effectiveEncoding).toBe('utf-8')
  })

  it('an `encoding` pseudo-attribute on a NON-xml processing instruction is not the declaration', () => {
    // The `startsWith('<?xml')` guard, and the one input that pins it: the document contains a
    // `?>` and an `encoding="…"` before it, so only the prefix check can rule it out. With the
    // literal emptied — `startsWith('')` is always true — this would be read as a declaration of
    // `koi8-r` and the whole feed would be decoded with the wrong charset.
    const decoded = decodeXml(utf8('<?pi encoding="koi8-r"?><r/>'))
    expect(decoded.declaredEncoding).toBeNull()
    expect(decoded.effectiveEncoding).toBe('utf-8')
  })

  it('`encoding` as part of a longer attribute name is not matched', () => {
    // The `\b` in the regex. `xencoding="koi8-r"` is not an encoding declaration.
    const decoded = decodeXml(utf8('<?xml version="1.0" xencoding="koi8-r"?><r/>'))
    expect(decoded.declaredEncoding).toBeNull()
  })

  it('a declaration beyond the sniff window is not read', () => {
    // Bounded on purpose: this scan runs on attacker-controlled bytes before any bound but the
    // byte cap. A document that padded its declaration past 512 characters would be read as
    // UTF-8, which is the safe direction.
    const padding = ' '.repeat(600)
    const decoded = decodeXml(utf8(`<?xml version="1.0"${padding} encoding="utf-8"?><r/>`))
    expect(decoded.declaredEncoding).toBeNull()
  })
})

describe('label normalisation for the conflict check', () => {
  it.each(['utf-16', 'UTF-16', ' utf-16 ', 'utf-16le', 'UTF-16BE', 'ucs-2', 'unicode', 'utf16le'])(
    'a UTF-16 BOM against a declared %s is NOT a conflict',
    (label) => {
      // Every member of the UTF-16 label set, in mixed case and with padding, so neither the set's
      // contents nor the trim/lowercase can be dropped without a red test.
      const decoded = decodeXml(encodeUtf16Le(`<?xml version="1.0" encoding="${label}"?><r/>`))
      expect(decoded.effectiveEncoding).toBe('utf-16le')
      expect(decoded.declaredEncoding).toBe(label)
    },
  )

  it.each(['windows-1251', 'utf-8', 'koi8-r', 'iso-8859-1'])(
    'a UTF-16 BOM against a declared %s IS a conflict',
    (label) => {
      let raised: unknown
      try {
        decodeXml(encodeUtf16Le(`<?xml version="1.0" encoding="${label}"?><r/>`))
      } catch (error) {
        raised = error
      }
      expect((raised as XmlPortError).reason).toBe('ENCODING_CONFLICT')
    },
  )

  it('the reverse direction conflicts too: a UTF-8 BOM against a declared UTF-16', () => {
    // The comparison is `sniffedIsUtf16 !== declaredIsUtf16`, so dropping either side of the
    // inequality would leave one direction undetected.
    let raised: unknown
    try {
      decodeXml(
        concat(bytes(0xef, 0xbb, 0xbf), utf8('<?xml version="1.0" encoding="utf-16"?><r/>')),
      )
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError).reason).toBe('ENCODING_CONFLICT')
  })

  it('a declaration with NO BOM is used as-is, never conflict-checked', () => {
    // There is nothing to conflict with. A check that fired here would reject every ordinary
    // single-byte-encoded feed.
    const decoded = decodeXml(utf8('<?xml version="1.0" encoding="utf-8"?><r/>'))
    expect(decoded.source).toBe('declaration')
    expect(decoded.effectiveEncoding).toBe('utf-8')
  })
})

describe('the decode itself', () => {
  it('an unknown label is UNSUPPORTED_ENCODING and keeps the RangeError as cause', () => {
    let raised: unknown
    try {
      decodeXml(utf8('<?xml version="1.0" encoding="not-a-charset"?><r/>'))
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError).reason).toBe('UNSUPPORTED_ENCODING')
    expect((raised as XmlPortError).cause).toBeInstanceOf(RangeError)
  })

  it('invalid bytes are UNDECODABLE, and the cause is the decoder`s own error', () => {
    let raised: unknown
    try {
      decodeXml(bytes(0x3c, 0x72, 0x3e, 0xff, 0x3c, 0x2f, 0x72, 0x3e))
    } catch (error) {
      raised = error
    }
    expect((raised as XmlPortError).reason).toBe('UNDECODABLE')
    expect((raised as XmlPortError).cause).toBeInstanceOf(TypeError)
  })

  it('source is `default` only when nothing was sniffed and nothing declared', () => {
    // All four values of `source` are asserted somewhere in this file; this pins the one that is
    // the fallback, so a mutation collapsing the others onto it is visible.
    expect(decodeXml(utf8('<r/>')).source).toBe('default')
    expect(decodeXml(encodeUtf16Le('<r/>')).source).toBe('bom')
    expect(decodeXml(encodeUtf16Le('<r/>', { bom: false })).source).toBe('utf16-sniff')
    expect(decodeXml(utf8('<?xml version="1.0" encoding="utf-8"?><r/>')).source).toBe('declaration')
  })
})
