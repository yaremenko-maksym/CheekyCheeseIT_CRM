/**
 * Glyph safety for the rendered resume (task-resume-template).
 *
 * THE PROBLEM. The renderer runs with `--ignore-system-fonts`, so the only
 * typeface available is the Roboto pair committed to this repo. That is what
 * makes a render reproducible on any machine — and it also means a codepoint
 * Roboto does not carry cannot be drawn at all: Typst emits `.notdef` and the
 * reader shows an empty box. A resume is free-text written by a stranger, so
 * this is not hypothetical. Salary expectations are the obvious case.
 *
 * MEASURED, NOT ASSUMED. The report that reached this branch was "Roboto has no
 * currency glyphs — hryvnia and ruble". Half of that is wrong, and the wrong
 * half matters: rendering `5000 ₴ / 100 ₽` shows a box for the HRYVNIA and a
 * perfectly good RUBLE sign. A hand-written list of "characters to replace"
 * would therefore have mangled `₽` for no reason while still missing every
 * other gap (₾, ₸, ֏, CJK, emoji...). So nothing here is hand-listed: the
 * font's own `cmap` is parsed and asked.
 *
 * WHAT IT DOES, in order:
 *   1. NFC-normalise (a decomposed `й` is two codepoints, and the combining
 *      one may be uncovered even though the composed one is not);
 *   2. replace an uncovered CURRENCY sign with its ISO code — `5000 ₴` becomes
 *      `5000 UAH`, which is what a human would have typed anyway;
 *   3. drop any other uncovered codepoint, and report it.
 *
 * Only step 2 is a list, and it applies ONLY to codepoints the font actually
 * lacks — on a font that carries `₽`, the `₽` entry never fires.
 *
 * Rendering-only. The canonical `content` in the database keeps every character
 * exactly as stored; this is applied on the way into the template.
 */
import { Logger } from '@nestjs/common'
import { loadFontBuffer } from '../common/pdf/pdf.utils'
import { normalizeExtractedText } from './resume-source.util'

const logger = new Logger('ResumeGlyphs')

/** The two faces the template uses. A glyph must exist in BOTH to be safe. */
const RESUME_FONT_FILES = ['Roboto-Regular.ttf', 'Roboto-Bold.ttf'] as const

/**
 * ISO 4217 codes for currency signs, used only where the font has no glyph.
 *
 * Deliberately spelled with a leading space-less code (`5000 UAH`) rather than
 * a symbol from another font: adding a fallback font would mean shipping and
 * licensing another binary, and mixing typefaces mid-line for one character
 * looks like a defect. A code is what the same person would write by hand.
 */
const CURRENCY_CODES: ReadonlyMap<number, string> = new Map([
  [0x20b4, 'UAH'], // ₴
  [0x20bd, 'RUB'], // ₽
  [0x20b8, 'KZT'], // ₸
  [0x20be, 'GEL'], // ₾
  [0x058f, 'AMD'], // ֏
  [0x20bc, 'AZN'], // ₼
  [0x20ba, 'TRY'], // ₺
  [0x20b9, 'INR'], // ₹
  [0x20bf, 'BTC'], // ₿
  [0x20a9, 'KRW'], // ₩
  [0x20ab, 'VND'], // ₫
  [0x20a6, 'NGN'], // ₦
  [0x20aa, 'ILS'], // ₪
  [0x20b1, 'PHP'], // ₱
  [0x20b2, 'PYG'], // ₲
  [0x20ad, 'LAK'], // ₭
  [0x20ae, 'MNT'], // ₮
  [0x20a1, 'CRC'], // ₡
  [0x20b5, 'GHS'], // ₵
  [0x20a8, 'PKR'], // ₨
  [0x20a3, 'FRF'], // ₣
  [0x20af, 'GRD'], // ₯
])

let coverageCache: Set<number> | null = null

/**
 * Codepoints drawable in EVERY resume face, read from the fonts' `cmap`.
 *
 * Intersection, not union: a heading is bold, so a character present only in
 * Roboto-Regular would still box out in a company name.
 */
export function resumeFontCoverage(): Set<number> {
  if (coverageCache) return coverageCache

  let intersection: Set<number> | null = null
  for (const file of RESUME_FONT_FILES) {
    const covered = readCmapCoverage(loadFontBuffer(file))
    if (intersection === null) {
      intersection = covered
      continue
    }
    const previous: Set<number> = intersection
    intersection = new Set<number>([...previous].filter((code) => covered.has(code)))
  }
  coverageCache = intersection ?? new Set<number>()
  return coverageCache
}

/** Test seam — the font files never change at runtime. @internal */
export function _clearGlyphCoverageCacheForTesting(): void {
  coverageCache = null
}

/**
 * Codepoints in `text` that the resume fonts cannot draw.
 *
 * Exported because it is the ASSERTION the tests make about a finished render
 * input: "nothing reaching the template is undrawable". Whitespace and the
 * newline are excluded — they have no glyph by definition.
 */
export function findUnrenderable(text: string): string[] {
  const coverage = resumeFontCoverage()
  const out: string[] = []
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)
    if (code === undefined) continue
    if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x20) continue
    if (coverage.has(code)) continue
    if (!out.includes(ch)) out.push(ch)
  }
  return out
}

/**
 * Make one string safe to typeset: NFC, currency codes, drop the rest.
 *
 * `dropped` is returned rather than logged here so the caller can report ONE
 * line per render instead of one per field.
 */
export function toRenderableText(raw: string): { text: string; dropped: string[] } {
  const coverage = resumeFontCoverage()
  const dropped: string[] = []
  let out = ''

  for (const ch of raw.normalize('NFC')) {
    const code = ch.codePointAt(0)
    if (code === undefined) continue
    if (coverage.has(code) || code === 0x0a || code === 0x0d || code === 0x09) {
      out += ch
      continue
    }
    const currency = CURRENCY_CODES.get(code)
    if (currency !== undefined) {
      out += currency
      continue
    }
    if (!dropped.includes(ch)) dropped.push(ch)
  }

  // Dropping a character leaves the spaces that surrounded it, so `20 😀 EUR`
  // would typeset with a double gap. `normalizeExtractedText` already collapses
  // runs of spaces, trims lines and strips control characters — the same
  // reduction the extractor applies on the way in, reused rather than rewritten.
  return { text: normalizeExtractedText(out), dropped }
}

/**
 * Apply `toRenderableText` to every string of a JSON-shaped value.
 *
 * Structure-preserving: the template is written against a fixed shape, so keys
 * and array positions must survive untouched — only leaf strings change.
 */
export function toRenderableDeep<T>(value: T): { value: T; dropped: string[] } {
  const dropped: string[] = []

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = toRenderableText(node)
      for (const ch of result.dropped) if (!dropped.includes(ch)) dropped.push(ch)
      return result.text
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, val]) => [key, walk(val)]))
    }
    return node
  }

  return { value: walk(value) as T, dropped }
}

/** One log line per render, naming what could not be drawn. */
export function logDroppedGlyphs(context: string, dropped: string[]): void {
  if (dropped.length === 0) return
  const named = dropped
    .map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(', ')
  logger.warn(`${context}: dropped ${dropped.length} undrawable codepoint(s): ${named}`)
}

// ---------------------------------------------------------------------------
// TrueType `cmap` reading
// ---------------------------------------------------------------------------

/**
 * Every Unicode codepoint mapped by a TTF, read straight from its `cmap`.
 *
 * Two subtable formats are enough for any modern font and are the only ones
 * accepted: format 4 (BMP) and format 12 (full range). An unrecognised format
 * yields an EMPTY set on purpose — the caller then treats everything as
 * undrawable, which degrades to plain ASCII rather than to boxes.
 *
 * A parser rather than a dependency because the alternative (`fontkit`,
 * `opentype.js`) is a whole font engine pulled in to answer one question, and
 * this file must run in the API image where every megabyte is deployed.
 */
function readCmapCoverage(font: Buffer): Set<number> {
  const covered = new Set<number>()
  const cmapOffset = findTableOffset(font, 'cmap')
  if (cmapOffset === null) return covered

  const numSubtables = font.readUInt16BE(cmapOffset + 2)
  let best: { format: number; offset: number } | null = null

  for (let i = 0; i < numSubtables; i += 1) {
    const record = cmapOffset + 4 + i * 8
    if (record + 8 > font.length) break
    const platformId = font.readUInt16BE(record)
    const encodingId = font.readUInt16BE(record + 2)
    const subtableOffset = cmapOffset + font.readUInt32BE(record + 4)
    if (subtableOffset + 2 > font.length) continue

    const isUnicode =
      platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10))
    if (!isUnicode) continue

    const format = font.readUInt16BE(subtableOffset)
    // Format 12 covers astral planes; prefer it whenever a font offers both.
    if (format === 12) best = { format, offset: subtableOffset }
    else if (format === 4 && best?.format !== 12) best = { format, offset: subtableOffset }
  }

  if (!best) return covered
  if (best.format === 12) readFormat12(font, best.offset, covered)
  else readFormat4(font, best.offset, covered)
  return covered
}

function findTableOffset(font: Buffer, tag: string): number | null {
  if (font.length < 12) return null
  const numTables = font.readUInt16BE(4)
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16
    if (record + 16 > font.length) return null
    if (font.subarray(record, record + 4).toString('latin1') === tag) {
      return font.readUInt32BE(record + 8)
    }
  }
  return null
}

/** Segment-mapped BMP table. `idRangeOffset` 0 means "add idDelta". */
function readFormat4(font: Buffer, offset: number, covered: Set<number>): void {
  const segCount = font.readUInt16BE(offset + 6) / 2
  const endCodes = offset + 14
  const startCodes = endCodes + segCount * 2 + 2
  const idDeltas = startCodes + segCount * 2
  const idRangeOffsets = idDeltas + segCount * 2

  for (let seg = 0; seg < segCount; seg += 1) {
    const end = font.readUInt16BE(endCodes + seg * 2)
    const start = font.readUInt16BE(startCodes + seg * 2)
    if (start > end || start === 0xffff) continue
    const rangeOffset = font.readUInt16BE(idRangeOffsets + seg * 2)
    const delta = font.readInt16BE(idDeltas + seg * 2)

    for (let code = start; code <= end; code += 1) {
      let glyph: number
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff
      } else {
        const glyphIndexAddress = idRangeOffsets + seg * 2 + rangeOffset + (code - start) * 2
        if (glyphIndexAddress + 2 > font.length) continue
        const raw = font.readUInt16BE(glyphIndexAddress)
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff
      }
      // Glyph 0 IS `.notdef` — a mapping to it is the absence of a glyph.
      if (glyph !== 0) covered.add(code)
    }
  }
}

/** Segmented coverage across the full Unicode range. */
function readFormat12(font: Buffer, offset: number, covered: Set<number>): void {
  const groups = font.readUInt32BE(offset + 12)
  for (let i = 0; i < groups; i += 1) {
    const group = offset + 16 + i * 12
    if (group + 12 > font.length) return
    const start = font.readUInt32BE(group)
    const end = font.readUInt32BE(group + 4)
    const startGlyph = font.readUInt32BE(group + 8)
    if (startGlyph === 0) continue
    for (let code = start; code <= end; code += 1) covered.add(code)
  }
}
