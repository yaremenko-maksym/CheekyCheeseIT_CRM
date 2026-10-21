/**
 * The shared conformance corpus. Every spec in this directory reads it, so a document added
 * once is exercised by the bounds suite, the differential suite and the growth suite alike.
 *
 * **Why a module and not twenty more `.xml` files.** The R-5 growth shapes are PARAMETRIC — the
 * same shape at three sizes, which is the only way to measure a growth exponent — and committing
 * three sizes of ten shapes would be thirty files that cannot be re-measured at a different scale.
 * The hand-written documents, whose exact bytes are the point, stay files.
 *
 * Under the two-adapter test this corpus is what makes the seam defensible with ONE library
 * adapter: it runs against the `XmlPort` interface, so the in-memory fake in
 * `xml-port.conformance.spec.ts` is a second implementation of the contract. That is option 3 of
 * R-4, taken knowingly — a `fast-xml-parser` adapter cannot satisfy the drift contract under any
 * configuration the ADR measured, so building one would produce a second adapter that FAILS the
 * corpus rather than a demonstrated seam.
 *
 * **Why it lives in `src/test/` and not beside the port.** `src/test/**` is excluded from the
 * mutation gate (`scripts/devops/mutation-gate.mjs`), and that is correct for this file rather
 * than convenient: its generators exist to BUILD inputs, so their mutants are mostly
 * covered-but-unkillable — a mutated `Math.floor(n / 50)` still produces a valid document and no
 * assertion about the port changes. Leaving it under `src/job-sourcing/` would have added
 * survivors that say nothing about whether the port is tested, which is the opposite of what the
 * gate is for. It sits beside `resume-fixtures.ts`, the same kind of thing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES = join(__dirname, '..', 'job-sourcing', 'xml', '__fixtures__')
/** The DOU sample lives with the legacy scanner's fixtures, where it is already golden-pinned. */
const LEGACY_FIXTURES = join(__dirname, '..', 'job-sourcing', '__fixtures__')

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** The authentic-grammar DOU feed, read from the fixture the golden specs already pin. */
export function douFeedBytes(): Uint8Array {
  return new Uint8Array(readFileSync(join(LEGACY_FIXTURES, 'dou-feed.golden.xml')))
}

export function douGolden(): { rawItems: Record<string, string>[] } {
  return JSON.parse(readFileSync(join(LEGACY_FIXTURES, 'dou-feed.golden.expected.json'), 'utf8'))
}

/**
 * Documents that must PARSE, and which therefore also exercise the pre-scan differential.
 *
 * `attack-*` files are absent from this list because the port refuses them; the differential spec
 * covers those separately by driving the adapter directly, since a document the port never parses
 * still has to be counted correctly by a scanner that runs before the refusal in other orderings.
 */
export const WELL_FORMED_FIXTURES: readonly string[] = [
  'atom-namespaced.xml',
  'rss-cdata-entities.xml',
  'rss-empty.xml',
  'boards-synthetic.xml',
  'positive-control.xml',
]

/** Documents the port must REJECT, with the reason each one is rejected FOR. */
export const REJECTED_FIXTURES: readonly { file: string; reason: string }[] = [
  { file: 'rss-broken-envelope.xml', reason: 'MALFORMED' },
  { file: 'attack-xxe-file.xml', reason: 'DOCTYPE_FORBIDDEN' },
  { file: 'attack-xxe-http.xml', reason: 'DOCTYPE_FORBIDDEN' },
  { file: 'attack-billion-laughs.xml', reason: 'DOCTYPE_FORBIDDEN' },
  { file: 'attack-internal-entity.xml', reason: 'DOCTYPE_FORBIDDEN' },
  { file: 'attack-parameter-entity.xml', reason: 'DOCTYPE_FORBIDDEN' },
  { file: 'attack-undefined-entity-no-doctype.xml', reason: 'MALFORMED' },
]

/**
 * R-5 growth shapes.
 *
 * The ten shapes the ADR measured, as functions of a size parameter so an exponent can be fitted.
 * This class — quadratic parsing, quadratic memory, attribute deduplication, PI-grammar ReDoS —
 * **dominates the real advisory record for XML parsers** (it is the whole of xmldom's 2026 batch),
 * and the ADR's original corpus never ran it at all.
 *
 * The last four are the unterminated constructs. They must be REJECTED, not merely parsed fast:
 * the shape behind xmldom's PI ReDoS advisory is an unterminated processing instruction, and a
 * parser that scans to the end of input looking for a terminator is the one that is quadratic.
 */
export const GROWTH_SHAPES: readonly {
  name: string
  /** Builds a document whose cost scales with `n`. Builders emit ~4 characters per unit. */
  build: (n: number) => string
  /** Whether a well-formed document results. Unterminated constructs do not. */
  wellFormed: boolean
  /**
   * For a REJECTED shape, where the cost of the rejection comes from — measured, because the two
   * need different assertions and conflating them produced a wrong test:
   *
   * - `'flat'` — refused on the construct itself, near-constant cost. An unterminated comment is
   *   refused in 0.06 ms whether it is 128 KB or 1 MB.
   * - `'after-parsing'` — the document parses normally and fails LATE, so the cost is the parse.
   *   `<r><i/>…</wrong>` with 262 144 elements costs 186 ms, and that is linear-in-elements work,
   *   not a pathology. An absolute "rejection must be fast" ceiling is simply the wrong
   *   instrument for it.
   */
  rejection?: 'flat' | 'after-parsing'
}[] = [
  {
    name: 'many distinct attributes',
    build: (n) => `<r>${Array.from({ length: n }, (_, i) => `<i a${i}="${i}"/>`).join('')}</r>`,
    wellFormed: true,
  },
  {
    name: 'repeated identical attribute names',
    build: (n) => `<r>${'<i a="1" b="2" a2="3" b2="4"/>'.repeat(n)}</r>`,
    wellFormed: true,
  },
  { name: 'many sibling elements', build: (n) => `<r>${'<i/>'.repeat(n)}</r>`, wellFormed: true },
  {
    name: 'long adjacent text runs',
    build: (n) => `<r>${'a &amp; b '.repeat(n)}</r>`,
    wellFormed: true,
  },
  {
    name: 'deeply nested but within bounds',
    build: (n) => {
      const groups = Math.max(1, Math.floor(n / 50))
      return `<r>${`${'<a>'.repeat(50)}${'</a>'.repeat(50)}`.repeat(groups)}</r>`
    },
    wellFormed: true,
  },
  {
    name: 'entity-dense text',
    build: (n) => `<r>${'&amp;&lt;&gt;&quot;&apos;'.repeat(n)}</r>`,
    wellFormed: true,
  },
  {
    name: 'cdata-dense',
    build: (n) => `<r>${'<i><![CDATA[<b>x</b>]]></i>'.repeat(n)}</r>`,
    wellFormed: true,
  },
  {
    name: 'late mismatched close tag',
    build: (n) => `<r>${'<i/>'.repeat(n)}</wrong>`,
    wellFormed: false,
    rejection: 'after-parsing',
  },
  {
    // The worst of the rejection shapes, and the one that justified measuring them separately:
    // 0.43 ms at 32 KB, 1.6 ms at 128 KB, 21 ms at 512 KB, 40 ms at 1 MB — exponent ~1.3 across
    // that range. Mildly super-linear, inside the parser, consistent with the ADR's worst case of
    // 1.36 being node-allocation and GC cost rather than backtracking. Bounded at ~80 ms by the
    // 2 MiB byte cap, which is a second reason that cap is load-bearing.
    name: 'unterminated processing instruction',
    build: (n) => `<?${'x'.repeat(n * 4)}`,
    wellFormed: false,
    rejection: 'flat',
  },
  {
    name: 'unterminated comment',
    build: (n) => `<!--${'x'.repeat(n * 4)}`,
    wellFormed: false,
    rejection: 'flat',
  },
  {
    name: 'unterminated cdata',
    build: (n) => `<r><![CDATA[${'x'.repeat(n * 4)}`,
    wellFormed: false,
    rejection: 'flat',
  },
  {
    name: 'unterminated attribute value',
    build: (n) => `<r a="${'x'.repeat(n * 4)}`,
    wellFormed: false,
    rejection: 'flat',
  },
]

/**
 * Encode a string to `windows-1251`, enough of it for the encoding tests.
 *
 * Node ships a windows-1251 DECODER (`TextDecoder`) but no encoder, and the whole point of the
 * encoding case is to hand the port bytes that are NOT UTF-8. Committing a binary fixture would
 * work too, but a mis-set `.gitattributes` or an editor's "fix encoding" turns it into UTF-8 and
 * the test then passes for the wrong reason — silently, which is the failure mode this task is
 * about. Building the bytes in code makes the mapping visible and verifiable.
 *
 * Mapping: ASCII is identity; `А`–`я` (U+0410…U+044F) are contiguous at 0xC0…0xFF.
 */
export function encodeWindows1251(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) as number
    if (code < 0x80) {
      out[i] = code
    } else if (code >= 0x410 && code <= 0x44f) {
      out[i] = 0xc0 + (code - 0x410)
    } else {
      throw new Error(`encodeWindows1251: U+${code.toString(16)} is outside the supported subset`)
    }
  }
  return out
}

/** `text` as UTF-16LE bytes, with the BOM unless suppressed. */
export function encodeUtf16Le(text: string, options: { bom: boolean } = { bom: true }): Uint8Array {
  const body = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    body[i * 2] = unit & 0xff
    body[i * 2 + 1] = unit >> 8
  }
  if (!options.bom) return body
  const withBom = new Uint8Array(body.length + 2)
  withBom[0] = 0xff
  withBom[1] = 0xfe
  withBom.set(body, 2)
  return withBom
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
