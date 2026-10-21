/**
 * Bytes → string, and the ordering that makes the `<!DOCTYPE` check reachable — r5 Task 2.4a, R-3.
 *
 * WHY THE PORT TAKES BYTES
 * ------------------------
 * Every candidate parser accepts a JS *string*, and every one of them produced mojibake on a
 * `encoding="windows-1251"` feed — because the damage happens during byte→string decoding, before
 * the parser is called. That is not a reason to reject a parser; it relocates a requirement into
 * this file. Node 22's `TextDecoder` covers it with no new dependency.
 *
 * THE ORDER, AND WHY EACH STEP IS WHERE IT IS
 * -------------------------------------------
 *   1. byte cap            — decoding is itself work proportional to the input, so the cheapest
 *                            bound goes first and is the ONLY one that can run on raw bytes.
 *   2. encoding resolution — BOM, then a UTF-16 sniff, then the XML declaration's own label.
 *   3. fatal decode        — `{ fatal: true }`, see below.
 *   4. `<!DOCTYPE` refusal — on the DECODED STRING, in `bounded-xml-port.ts`. A byte-level match
 *                            is **bypassed by any UTF-16 feed**: the bytes are
 *                            `3C 00 21 00 44 00 …`, which does not contain the ASCII `<!DOCTYPE`
 *                            at all, and the document sails past a check that looks sound.
 *   5. structural pre-scan — depth and element count, also on the decoded string.
 *   6. parse.
 *
 * `{ fatal: true }` IS LOAD-BEARING. `new TextDecoder(label)` is non-fatal by DEFAULT: the bytes
 * `61 FF 62` decode silently to `a�b`. A feed whose bytes are not valid in its own declared
 * encoding is a malformed feed, and the plan's contract is "malformed feed = drift" — so a
 * replacement character is a corrupted vacancy accepted as content. With `fatal: true` the decode
 * throws and the caller reports drift.
 */

import { XmlPortError } from './xml-port'

export interface DecodedXml {
  readonly text: string
  /** The `TextDecoder` label actually used. */
  readonly effectiveEncoding: string
  /** The label taken from the XML declaration, verbatim, or `null` if the declaration had none. */
  readonly declaredEncoding: string | null
  /** How `effectiveEncoding` was chosen. Useful in logs when a feed and its BOM disagree. */
  readonly source: 'bom' | 'utf16-sniff' | 'declaration' | 'default'
}

/** `TextDecoder` labels whose decoding is UTF-16. A BOM for these outranks any declaration. */
const UTF16_LABELS = new Set(['utf-16', 'utf-16le', 'utf-16be', 'utf16le', 'ucs-2', 'unicode'])

/**
 * How far into the document we look for the XML declaration.
 *
 * The declaration must be the first thing in the document, and XML caps nothing here, but 512
 * bytes is far more than `<?xml version="1.0" encoding="windows-1251"?>` needs. Bounded because
 * this scan runs on attacker-controlled bytes before any other bound has been applied beyond the
 * byte cap.
 */
const DECLARATION_SNIFF_BYTES = 512
/** The same window, counted in characters, for a document already decoded. */
const DECLARATION_SNIFF_CHARS = 512

interface EncodingChoice {
  label: string
  source: DecodedXml['source']
  /** Bytes to skip before decoding (a BOM, which must not reach the parser as content). */
  bomLength: number
}

/**
 * NO LENGTH GUARDS, and their absence is the point.
 *
 * Each `if` used to begin `bytes.length >= N &&`. The mutation gate reported those guards as
 * replaceable by `true` with no test noticing, and it was right for a reason worth keeping
 * visible: indexing a `Uint8Array` past its end yields `undefined`, and `undefined === 0xbf` is
 * false — so a short document already fails the byte comparison and the length check can never
 * change the answer. The guards were redundant, not merely untested, so they are gone rather than
 * suppressed. `decode.unit.spec.ts` covers the one-byte, two-byte and empty cases.
 */
function sniffBom(bytes: Uint8Array): EncodingChoice | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { label: 'utf-8', source: 'bom', bomLength: 3 }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { label: 'utf-16le', source: 'bom', bomLength: 2 }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { label: 'utf-16be', source: 'bom', bomLength: 2 }
  }
  return null
}

/**
 * UTF-16 without a BOM, recognised from the shape of the first element's `<`.
 *
 * A well-formed XML document starts with `<`, so UTF-16LE begins `3C 00` and UTF-16BE `00 3C`.
 * This matters for the DOCTYPE check specifically: a BOM-less UTF-16 feed decoded as UTF-8 would
 * be a string full of NUL characters in which neither `<!DOCTYPE` nor any element name appears,
 * so every later check would pass on garbage.
 */
function sniffUtf16WithoutBom(bytes: Uint8Array): EncodingChoice | null {
  // No `if (bytes.length < 2) return null` either — same redundancy as in `sniffBom`: a missing
  // byte reads as `undefined`, which matches neither `0x3c` nor `0x00`.
  if (bytes[0] === 0x3c && bytes[1] === 0x00) {
    return { label: 'utf-16le', source: 'utf16-sniff', bomLength: 0 }
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x3c) {
    return { label: 'utf-16be', source: 'utf16-sniff', bomLength: 0 }
  }
  return null
}

/** The `encoding="…"` label from the XML declaration of an already-DECODED document. */
function readDeclaredEncodingFromText(text: string): string | null {
  const head = text.slice(0, DECLARATION_SNIFF_CHARS)
  const declarationEnd = head.indexOf('?>')
  if (!head.startsWith('<?xml') || declarationEnd === -1) return null
  const match = /\bencoding\s*=\s*("([^"]*)"|'([^']*)')/.exec(head.slice(0, declarationEnd))
  if (match === null) return null
  return match[2] ?? match[3] ?? null
}

/**
 * The declaration read from the leading BYTES, for the case where nothing was sniffed.
 *
 * A NON-fatal UTF-8 decode, which is the one place a non-fatal decode is correct: we are reading
 * an ASCII label out of bytes whose encoding is not yet known, and every encoding XML permits for
 * a document with no BOM and no UTF-16 shape is ASCII-compatible across that prefix. Any
 * replacement characters land in bytes we then discard; the real decode is fatal.
 *
 * **This function cannot read a UTF-16 declaration, and that is why it is not the only path.** A
 * UTF-16 document's bytes are `3C 00 3F 00 78 00 …`; decoded as UTF-8 they do not begin with
 * `<?xml`, so this returns `null` and every comparison against the declaration silently becomes
 * vacuous. That is the same defect class as the byte-level `<!DOCTYPE` check R-3 is about — a
 * check whose failure looks exactly like "nothing to check" — and it is why `decodeXml` resolves
 * the encoding FAMILY first and reads the declaration from the decoded text afterwards.
 */
function readDeclaredEncodingFromBytes(bytes: Uint8Array): string | null {
  return readDeclaredEncodingFromText(
    new TextDecoder('utf-8').decode(bytes.subarray(0, DECLARATION_SNIFF_BYTES)),
  )
}

/** Normalised for comparison only — the verbatim label is what we report. */
const normalise = (label: string): string => label.trim().toLowerCase()

/**
 * Resolve the encoding, decode fatally, and report which source won.
 *
 * THE ORDER IS THE SUBSTANCE. The encoding FAMILY is resolved first, from the BOM or the UTF-16
 * byte shape, because only then is the XML declaration readable: a UTF-16 document's bytes are
 * `3C 00 3F 00 78 00 …`, and a UTF-8 read of that prefix does not begin with `<?xml`, so a
 * declaration check placed before the decode returns `null` and every comparison against it
 * becomes vacuous — indistinguishable from "this document declared nothing". That is the same
 * defect R-3 names for the byte-level `<!DOCTYPE` check, in the neighbouring step. It was caught
 * here by the conflict test failing, not by reading the code.
 *
 * BOM beats the declaration, per the XML spec. The one case worth its own reason is a UTF-16 BOM
 * against a declaration naming a single-byte encoding (or the reverse): not a precedence question
 * but a document asserting two incompatible things about itself, which decodes either way to
 * plausible-looking nonsense. Drift, not content.
 */
export function decodeXml(bytes: Uint8Array): DecodedXml {
  const sniffed = sniffBom(bytes) ?? sniffUtf16WithoutBom(bytes)
  const choice: EncodingChoice =
    sniffed ?? resolveFromDeclaration(readDeclaredEncodingFromBytes(bytes))
  const text = decodeWith(choice, bytes)
  // Read from the DECODED text in every case, so a UTF-16 document's own declaration is visible.
  const declaredEncoding = readDeclaredEncodingFromText(text)

  if (sniffed !== null && declaredEncoding !== null) {
    const sniffedIsUtf16 = UTF16_LABELS.has(normalise(sniffed.label))
    const declaredIsUtf16 = UTF16_LABELS.has(normalise(declaredEncoding))
    if (sniffedIsUtf16 !== declaredIsUtf16) {
      throw new XmlPortError(
        'ENCODING_CONFLICT',
        `byte-order mark says ${sniffed.label} but the XML declaration says ${declaredEncoding}`,
      )
    }
  }

  return {
    text,
    effectiveEncoding: choice.label,
    declaredEncoding,
    source: choice.source,
  }
}

function resolveFromDeclaration(declaredEncoding: string | null): EncodingChoice {
  return declaredEncoding !== null
    ? { label: declaredEncoding, source: 'declaration', bomLength: 0 }
    : { label: 'utf-8', source: 'default', bomLength: 0 }
}

function decodeWith(choice: EncodingChoice, bytes: Uint8Array): string {
  // `InstanceType<typeof TextDecoder>` rather than `TextDecoder`: under `@types/node` 20 the
  // global `TextDecoder` is a value, not a type. Not a cast — it asserts nothing the compiler
  // would otherwise check.
  let decoder: InstanceType<typeof TextDecoder>
  try {
    decoder = new TextDecoder(choice.label, { fatal: true })
  } catch (cause) {
    // `TextDecoder` throws `RangeError` for a label it does not know. A feed naming an encoding
    // Node cannot decode is a feed we cannot read — a distinct outcome from bytes that are
    // invalid in a known encoding, because the fix is different (add a decoder vs. drop the feed).
    throw new XmlPortError(
      'UNSUPPORTED_ENCODING',
      `unsupported XML encoding ${JSON.stringify(choice.label)}`,
      { cause },
    )
  }

  try {
    return decoder.decode(bytes.subarray(choice.bomLength))
  } catch (cause) {
    throw new XmlPortError(
      'UNDECODABLE',
      `bytes are not valid ${choice.label} (decoded with fatal: true)`,
      { cause },
    )
  }
}
