/**
 * Resume source-file inspection (task-resume-base §2).
 *
 * Everything here answers ONE question: "is this buffer really a resume file
 * we can safely hand to a parser?" — decided from the BYTES, never from the
 * filename extension or the client-supplied Content-Type (both are attacker
 * controlled; a `.exe` renamed to `.pdf` must be rejected, AC2).
 *
 * PDF detection reuses `detectMimeFromBuffer` from the documents module
 * (single definition of "%PDF magic"), and this file adds the DOCX/OOXML case
 * the documents whitelist has no need for — extending `detectMimeFromBuffer`
 * itself would change behaviour for every existing documents call site
 * (a DOCX would go from "unknown binary" to "accepted"), so the resume-only
 * knowledge lives resume-side.
 */
import { promisify } from 'node:util'
import { createInflateRaw, inflate } from 'node:zlib'
import { RESUME_DOCX_MIME, RESUME_PDF_MIME, RESUME_LIMITS } from '@crm/shared'
import { detectMimeFromBuffer } from '../documents/compression.service'

/** PDF `FlateDecode` is zlib-wrapped, unlike zip's raw deflate. */
const inflateAsync = promisify(inflate)

/** Max entries we are willing to walk in a DOCX zip central directory. */
const MAX_ZIP_ENTRIES = 2000
/**
 * Max total UNCOMPRESSED size of a DOCX. A DOCX is a zip, so its on-disk size
 * says nothing about what it expands to: a few-KB "zip bomb" can decompress
 * into gigabytes and take the API process down.
 *
 * Lowered from 60 MB: the upload is capped at 10 MB, so anything past this is
 * necessarily highly-compressible content, and every megabyte here is memory
 * the extractor has to hold.
 */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024

/**
 * Max total uncompressed size of the parts `mammoth` may actually parse — the
 * bound that governs CPU.
 *
 * ACCOUNTED FROM CONTENT, NOT FROM THE FILENAME — see `MEDIA_SIGNATURES` for
 * why, and for the two bypasses that were needed to learn it. Short version:
 * `mammoth` never looks at a part's name (it follows `_rels/.rels` and reads
 * whatever that points at), so any budget keyed on names disagrees with the
 * parser by construction and can be walked around by renaming one entry. A
 * part is excluded here only when its BYTES are a recognised media format.
 *
 * SIZE CALIBRATED ON 14 REAL WORD DOCUMENTS, not on a generated fixture. The
 * fixture used previously spends ~60 bytes per paragraph where real Word spends
 * ~1 KB, so the "40x headroom" it implied was fiction. Counted bytes across
 * those files: 78, 80, 80, 96, 107, 240, 288, 328, 331, 344, 353, 353, 538,
 * 539 KB. 4 MB is ~7.4x the largest real document seen, which restores room
 * for the long academic CVs a 1 MB cap rejected outright.
 *
 * Enforced DURING the bounded inflate, so an over-cap archive is refused the
 * moment the budget runs out and the remainder is never inflated at all.
 */
export const MAX_DOCX_PARSED_BYTES = 4 * 1024 * 1024

/** DEFLATE and STORED are the only methods a real DOCX ever uses. */
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATE = 8

/** Max pages we will parse out of a PDF (a resume is not a 500-page book). */
export const MAX_PDF_PAGES = 30

/**
 * Max decoded CONTENT-STREAM bytes a PDF may hold — a MEMORY bound.
 *
 * Measured across 95 real PDFs (CVs, contracts, invoices, scans) once image
 * XObjects are excluded: the largest is 8.89 MB. 32 MB is ~3.6x that.
 */
export const MAX_PDF_CONTENT_BYTES = 32 * 1024 * 1024

/**
 * Max text-showing OPERATORS a PDF may ask `extractText` to execute — the CPU
 * bound, and the only metric here that tracks the cost.
 *
 * The PDF branch had no size guard at all: `RESUME_SOURCE_MAX_BYTES` measures
 * compressed bytes and `MAX_PDF_PAGES` measures pages, while `extractText` pays
 * per operator. Measured on the real intake path:
 *
 *   pages  file    verdict    worst continuous stall
 *     30    12 KB  accepted     6 109 ms
 *     30    24 KB  accepted    23 267 ms   (884 MB resident)
 *
 * 24 KB is a four-hundredth of the permitted 10 MB.
 *
 * BYTES WOULD NOT HAVE WORKED, and trying them first is what produced this
 * number honestly: decoded content bytes do not separate the two populations at
 * all. The attack decodes to 0.8 MB while real image-heavy documents reach
 * 8.9 MB, so any byte threshold either passes the attack or rejects real CVs.
 * Operator counts separate them by an order of magnitude:
 *
 *   population                     amplified operators   worst stall
 *   95 real PDFs (max)                        56 880        749 ms
 *   attack, 20k ops x 30 pages                600 000      6 109 ms
 *   attack, 60k ops x 30 pages              1 800 000     23 267 ms
 *
 * 80 000 is 1.4x the busiest real document (itself a lone outlier — the next
 * highest is 7 965) and 7.5x below the cheapest attack. The tightness is
 * deliberate and the ceiling is set by the real corpus, not by taste: an
 * adversarial shape at the busiest real document's own operator count already
 * costs 1 412 ms, so accepting all 95 real files means tolerating roughly that.
 * Measured at the cap: 1 894 ms. Removing that residual needs extraction off
 * the main thread, which is tracked separately.
 *
 * AMPLIFICATION: `/Contents` may point every page at the SAME stream, so N
 * pages cost N executions of it. The bound charges `pages x busiest stream` as
 * well as the plain total; for an ordinary document the two nearly agree, and
 * for the shared-stream trick they diverge by exactly the amplification factor.
 */
export const MAX_PDF_TEXT_OPERATORS = 80_000

/**
 * Stream filters whose payload is image data: handed to an image codec, never
 * walked as content operators.
 *
 * NOT sufficient on its own, and finding that out cost a second measurement
 * pass: the single most common image encoding in a real PDF is plain
 * `/FlateDecode` over raw samples, which is indistinguishable from a content
 * stream by filter alone. Counting those made 13 of 95 real files — including
 * two actual CVs — look like 25-130 MB of "content" and get rejected, while the
 * genuine attack measured 0.8 MB. The authoritative marker is the XObject
 * subtype, so `isPdfImageStream` checks that first.
 */
const PDF_IMAGE_FILTERS = ['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']

/**
 * True when the stream dictionary describes an image XObject rather than
 * something `extractText` walks. `/Subtype /Image` is the definitive signal;
 * the filter list catches image data that arrives without it.
 */
function isPdfImageStream(dict: string): boolean {
  if (/\/Subtype\s*\/Image/.test(dict)) return true
  return PDF_IMAGE_FILTERS.some((f) => dict.includes(f))
}

export type ResumeSourceMime = typeof RESUME_PDF_MIME | typeof RESUME_DOCX_MIME

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------

const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP_CENTRAL_HEADER = 0x02014b50
const ZIP_EOCD = 0x06054b50
const ZIP64_SENTINEL = 0xffffffff

function readU32LE(buf: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 4 > buf.length) return null
  return buf.readUInt32LE(offset)
}

function readU16LE(buf: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 2 > buf.length) return null
  return buf.readUInt16LE(offset)
}

/**
 * True when the buffer starts with a zip local-file header AND carries an
 * OOXML word-processing part. Zip stores entry names UNCOMPRESSED inside each
 * local header, so `word/document.xml` is literally present in the bytes of
 * every real .docx — which is enough to tell a Word document apart from an
 * arbitrary .zip (or a .xlsx / .pptx) without unzipping anything.
 */
function looksLikeDocx(buf: Buffer): boolean {
  if (readU32LE(buf, 0) !== ZIP_LOCAL_HEADER) return false
  return buf.includes('word/document.xml', 0, 'latin1')
}

/**
 * Detect the real type of an uploaded resume from its content.
 * Returns `null` for anything that is not a PDF or a DOCX — the caller turns
 * that into a 415, regardless of what the filename or Content-Type claimed.
 */
export function detectResumeSourceMime(buf: Buffer): ResumeSourceMime | null {
  if (detectMimeFromBuffer(buf) === RESUME_PDF_MIME) return RESUME_PDF_MIME
  if (looksLikeDocx(buf)) return RESUME_DOCX_MIME
  return null
}

// ---------------------------------------------------------------------------
// Zip-bomb guard
// ---------------------------------------------------------------------------

export interface ZipInspection {
  entries: number
  /** What the central directory CLAIMS the archive expands to. Untrusted. */
  declaredUncompressedBytes: number
  /** What it ACTUALLY expands to, measured by inflating under a hard budget. */
  actualUncompressedBytes: number
  /** Of that, how much the parser may actually read (everything but media). */
  actualParsedBytes: number
}

interface ZipEntryHeader {
  name: string
  method: number
  declaredUncompressedSize: number
  localHeaderOffset: number
}

/**
 * How many leading bytes of a decompressed part are inspected to decide what it
 * is. Every magic number below fits in far less; 32 is slack.
 */
const MAGIC_PREFIX_BYTES = 32

/**
 * Byte signatures of formats `extractRawText` hands to a codec, never to a
 * parser: raster images, audio/video, embedded fonts.
 *
 * ============================================================================
 * WHY SIGNATURES AND NOT FILENAMES — the third time this bug was found
 * ============================================================================
 * The parse budget has now been bypassed three times, and re-reading the three
 * is the only way to see that the list was never the problem:
 *
 *   1. the budget counted `.xml`/`.rels` BY EXTENSION -> body moved to
 *      `word/document.dat`, budget saw 863 B, parser chewed 17.3 MB;
 *   2. inverted to "count everything except media, BY EXTENSION" -> body moved
 *      to `word/document.png`, budget saw 533 B, parser chewed 16-18 MB
 *      (2.6-3.0 s of continuous main-thread stall from a 49-55 KB upload);
 *   3. — there is no third, because the two above are the SAME BUG. Both
 *      allow-list and deny-list were keyed on the filename, and `mammoth`
 *      does not look at filenames at all: it resolves the document part
 *      through the `_rels/.rels` relationship graph and reads whatever that
 *      points at (`docx-reader.js` `findPartPath` -> `validTargets[0]`).
 *
 * THE DEFECT WAS NEVER THE CONTENTS OF THE LIST. It was that the guard decided
 * on one signal (the name, which the attacker writes) while the parser decided
 * on another (the reference graph, plus the bytes). While those two disagree,
 * a bypass exists to be found, whatever names the list holds — and the next
 * name is free to invent.
 *
 * So the signal is changed rather than the list. A part is excluded from the
 * parse budget only when ITS BYTES are a recognised media format, which closes
 * the class by an argument that does not mention names at all:
 *
 *   - to be EXCLUDED, a part must open with media magic;
 *   - to COST PARSE TIME, a part must be well-formed XML `mammoth` can read;
 *   - no byte sequence is both. `\x89PNG` is not a document, and a document is
 *     not a PNG.
 *
 * Anything unrecognised COUNTS — the polarity that matters, since an invented
 * format is exactly what an attacker reaches for. This is also the rule the top
 * of this file already stated for the upload itself ("decided from the BYTES,
 * never from the filename extension"); `isInertMedia` was the one place that
 * quietly did the opposite.
 *
 * Real documents are unaffected: their images really are images, so they are
 * still excluded (the 8 MB-of-images document still counts ~331 KB), and every
 * XML part was already being counted before.
 */
const MEDIA_SIGNATURES: ReadonlyArray<{ format: string; magic: readonly number[] }> = [
  { format: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', magic: [0xff, 0xd8, 0xff] },
  { format: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { format: 'bmp', magic: [0x42, 0x4d] },
  { format: 'tiff-le', magic: [0x49, 0x49, 0x2a, 0x00] },
  { format: 'tiff-be', magic: [0x4d, 0x4d, 0x00, 0x2a] },
  // EMF: an ENHMETAHEADER whose iType is 1. WMF: the placeable-metafile key.
  { format: 'emf', magic: [0x01, 0x00, 0x00, 0x00] },
  { format: 'wmf', magic: [0xd7, 0xcd, 0xc6, 0x9a] },
  { format: 'wmf-plain', magic: [0x01, 0x00, 0x09, 0x00] },
  { format: 'ico', magic: [0x00, 0x00, 0x01, 0x00] },
  { format: 'mp3-id3', magic: [0x49, 0x44, 0x33] },
  { format: 'ttf', magic: [0x00, 0x01, 0x00, 0x00] },
  { format: 'otf', magic: [0x4f, 0x54, 0x54, 0x4f] },
  { format: 'ttc', magic: [0x74, 0x74, 0x63, 0x66] },
  { format: 'woff', magic: [0x77, 0x4f, 0x46, 0x46] },
  { format: 'woff2', magic: [0x77, 0x4f, 0x46, 0x32] },
]

/** Container formats that carry their marker a few bytes in, not at offset 0. */
const CONTAINER_SIGNATURES: ReadonlyArray<{
  format: string
  offset: number
  ascii: string
}> = [
  { format: 'riff', offset: 0, ascii: 'RIFF' }, // WAV / AVI / WEBP
  { format: 'mp4', offset: 4, ascii: 'ftyp' }, // MP4 / M4A / MOV / HEIC
]

/**
 * True only when these bytes are a media payload — i.e. a part that costs
 * memory but no parse time.
 *
 * Takes BYTES, not a name, and that signature change is the whole fix. An empty
 * or unreadably short part returns false (counts), because "too small to
 * identify" must never mean "assumed harmless".
 */
export function isInertMediaContent(head: Buffer): boolean {
  if (head.length < 2) return false

  for (const { magic } of MEDIA_SIGNATURES) {
    if (head.length < magic.length) continue
    if (magic.every((byte, i) => head[i] === byte)) return true
  }
  for (const { offset, ascii } of CONTAINER_SIGNATURES) {
    if (head.length < offset + ascii.length) continue
    if (head.subarray(offset, offset + ascii.length).toString('latin1') === ascii) return true
  }
  return false
}

/**
 * Walk a DOCX's zip central directory and establish — as a FACT, not as a
 * claim — that the archive expands to no more than `maxUncompressedBytes`.
 *
 * Two passes, cheap one first:
 *   1. Read the central directory and sum the DECLARED uncompressed sizes.
 *      This costs nothing and rejects the naive bomb immediately.
 *   2. Actually inflate every entry with `maxOutputLength` set to the REMAINING
 *      budget, so zlib aborts with ERR_BUFFER_TOO_LARGE the moment the real
 *      output exceeds it.
 *
 * Pass 2 exists because pass 1 asks the attacker how big their attack is. A
 * central directory that declares 100 bytes while shipping a stream that
 * expands to 300 MB sails straight through a declaration-only guard; the only
 * thing that caught it before was `mammoth`'s own internal check, AFTER it had
 * already inflated the whole thing into memory. Here nothing is handed to
 * `mammoth` until the real size is known, and the inflate is bounded and runs
 * on the thread pool (`inflateAndClassify`), so neither memory nor the event
 * loop is at the archive's mercy.
 *
 * The entry COUNT is likewise not taken on faith: the directory is walked by
 * signature and the walked count must match the declared one — declaring zero
 * entries used to switch the accounting off entirely.
 *
 * Throws `RangeError` for every malformed / oversized / ZIP64 case; the caller
 * maps that onto a clean "unreadable file" failure.
 */
export async function inspectDocxZip(
  buf: Buffer,
  maxUncompressedBytes: number = MAX_DOCX_UNCOMPRESSED_BYTES,
  maxParsedBytes: number = MAX_DOCX_PARSED_BYTES,
): Promise<ZipInspection> {
  const { headers, declaredUncompressedBytes } = readCentralDirectory(buf, maxUncompressedBytes)

  let actualUncompressedBytes = 0
  let actualParsedBytes = 0
  for (const header of headers) {
    // Both budgets go in and the entry is classified FROM ITS OWN BYTES as it
    // decompresses, so neither the decision nor the ceiling can be moved by
    // renaming the entry (see MEDIA_SIGNATURES). Decompression still stops the
    // moment whichever budget applies is spent — the classification happens on
    // the first chunk, long before the last one.
    const { size, counted } = await measureEntry(buf, header, {
      totalRemaining: maxUncompressedBytes - actualUncompressedBytes,
      parsedRemaining: maxParsedBytes - actualParsedBytes,
      maxUncompressedBytes,
      maxParsedBytes,
    })
    actualUncompressedBytes += size
    if (counted) actualParsedBytes += size
  }

  return {
    entries: headers.length,
    declaredUncompressedBytes,
    actualUncompressedBytes,
    actualParsedBytes,
  }
}

/** Pass 1 — parse the central directory, trusting nothing but the signatures. */
function readCentralDirectory(
  buf: Buffer,
  maxUncompressedBytes: number,
): { headers: ZipEntryHeader[]; declaredUncompressedBytes: number } {
  // The End Of Central Directory record sits at the tail, possibly followed by
  // a comment of up to 64 KiB — scan backwards for its signature.
  const minEocd = 22
  if (buf.length < minEocd) throw new RangeError('DOCX слишком мал для zip-архива')
  const scanFloor = Math.max(0, buf.length - minEocd - 0xffff)
  let eocd = -1
  for (let i = buf.length - minEocd; i >= scanFloor; i -= 1) {
    if (readU32LE(buf, i) === ZIP_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new RangeError('В DOCX не найдена структура zip-архива')

  const declaredEntries = readU16LE(buf, eocd + 10)
  const cdOffset = readU32LE(buf, eocd + 16)
  if (declaredEntries === null || cdOffset === null)
    throw new RangeError('Повреждённый zip-каталог')
  if (cdOffset === ZIP64_SENTINEL) throw new RangeError('ZIP64-архивы не поддерживаются')
  if (declaredEntries > MAX_ZIP_ENTRIES) {
    throw new RangeError(`Слишком много файлов внутри DOCX (${declaredEntries})`)
  }

  const headers: ZipEntryHeader[] = []
  let declaredUncompressedBytes = 0
  let cursor = cdOffset

  // Walk by SIGNATURE, not by the declared count — see the doc comment.
  while (readU32LE(buf, cursor) === ZIP_CENTRAL_HEADER) {
    if (headers.length >= MAX_ZIP_ENTRIES) {
      throw new RangeError(`Слишком много файлов внутри DOCX (>${MAX_ZIP_ENTRIES})`)
    }
    const method = readU16LE(buf, cursor + 10)
    const uncompressed = readU32LE(buf, cursor + 24)
    const nameLen = readU16LE(buf, cursor + 28)
    const extraLen = readU16LE(buf, cursor + 30)
    const commentLen = readU16LE(buf, cursor + 32)
    const localHeaderOffset = readU32LE(buf, cursor + 42)
    if (
      method === null ||
      uncompressed === null ||
      nameLen === null ||
      extraLen === null ||
      commentLen === null ||
      localHeaderOffset === null
    ) {
      throw new RangeError('Повреждённая запись zip-каталога')
    }
    if (uncompressed === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new RangeError('ZIP64-архивы не поддерживаются')
    }

    declaredUncompressedBytes += uncompressed
    if (declaredUncompressedBytes > maxUncompressedBytes) {
      throw new RangeError(
        `Распакованный DOCX больше ${Math.floor(maxUncompressedBytes / 1024 / 1024)} MB`,
      )
    }

    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    headers.push({ name, method, declaredUncompressedSize: uncompressed, localHeaderOffset })
    cursor += 46 + nameLen + extraLen + commentLen
  }

  if (headers.length === 0) throw new RangeError('В DOCX нет ни одной записи zip-каталога')
  if (headers.length !== declaredEntries) {
    // A mismatch means the tail record and the directory disagree — either
    // corruption or a deliberate attempt to hide entries from the accounting.
    throw new RangeError('Оглавление zip-архива не совпадает с его содержимым')
  }

  return { headers, declaredUncompressedBytes }
}

/**
 * Pass 2 — the real size of ONE entry, never exceeding `budget` bytes.
 *
 * The compressed data is sliced from its local-header offset to the END of the
 * buffer rather than to the declared compressed size: that field is attacker
 * controlled too, and zlib stops cleanly at the end of the deflate stream and
 * ignores whatever follows it (verified against Node 20's `inflateRaw`).
 */
interface EntryBudgets {
  totalRemaining: number
  parsedRemaining: number
  maxUncompressedBytes: number
  maxParsedBytes: number
}

async function measureEntry(
  buf: Buffer,
  header: ZipEntryHeader,
  budgets: EntryBudgets,
): Promise<{ size: number; counted: boolean }> {
  const nameLen = readU16LE(buf, header.localHeaderOffset + 26)
  const extraLen = readU16LE(buf, header.localHeaderOffset + 28)
  if (
    readU32LE(buf, header.localHeaderOffset) !== ZIP_LOCAL_HEADER ||
    nameLen === null ||
    extraLen === null
  ) {
    throw new RangeError('Повреждённый заголовок файла внутри DOCX')
  }
  const dataStart = header.localHeaderOffset + 30 + nameLen + extraLen
  if (dataStart > buf.length) throw new RangeError('Повреждённый заголовок файла внутри DOCX')

  if (header.method === ZIP_METHOD_STORED) {
    // Nothing to inflate: a stored entry cannot be bigger than the file that
    // carries it, so its real size is its declared one bounded by the bytes
    // physically present.
    const available = buf.length - dataStart
    const size = Math.min(header.declaredUncompressedSize, available)
    const counted = !isInertMediaContent(buf.subarray(dataStart, dataStart + MAGIC_PREFIX_BYTES))
    if (size > budgets.totalRemaining) throw new RangeError(tooBig(budgets.maxUncompressedBytes))
    if (counted && size > budgets.parsedRemaining)
      throw new RangeError(tooBig(budgets.maxParsedBytes))
    return { size, counted }
  }

  if (header.method !== ZIP_METHOD_DEFLATE) {
    throw new RangeError(`Неподдерживаемый метод сжатия внутри DOCX (${header.method})`)
  }
  if (budgets.totalRemaining <= 0) throw new RangeError(tooBig(budgets.maxUncompressedBytes))

  return inflateAndClassify(buf.subarray(dataStart), budgets)
}

/**
 * Decompress one entry on the thread pool, deciding WHAT IT IS from its first
 * bytes and stopping as soon as the budget that applies to it is spent.
 *
 * Streamed rather than `inflateRaw(..., { maxOutputLength })` because the
 * one-shot form forces a choice before anything is known: pass the parse budget
 * and a legitimate 8 MB image is refused; pass the total budget and a hidden
 * 17 MB body is fully decompressed before anyone looks at it. Reading chunk by
 * chunk means the classification lands on the FIRST chunk and the correct
 * ceiling applies to every chunk after it — the early abort survives the move
 * from names to content.
 *
 * The compressed data is sliced to the END of the buffer rather than to the
 * declared compressed size: that field is attacker controlled too, and zlib
 * stops cleanly at the end of the deflate stream and ignores what follows.
 */
function inflateAndClassify(
  compressed: Buffer,
  budgets: EntryBudgets,
): Promise<{ size: number; counted: boolean }> {
  return new Promise((resolve, reject) => {
    const stream = createInflateRaw()
    let size = 0
    let head = Buffer.alloc(0)
    // `null` = not decided yet. Anything unrecognised ends up `true` (counted).
    let counted: boolean | null = null
    let settled = false

    const finish = (err: RangeError | null, value?: { size: number; counted: boolean }): void => {
      if (settled) return
      settled = true
      stream.destroy()
      if (err) reject(err)
      else resolve(value as { size: number; counted: boolean })
    }

    stream.on('data', (chunk: Buffer) => {
      if (head.length < MAGIC_PREFIX_BYTES) {
        head = Buffer.concat([head, chunk]).subarray(0, MAGIC_PREFIX_BYTES)
        counted = !isInertMediaContent(head)
      }
      size += chunk.length
      if (size > budgets.totalRemaining) {
        finish(new RangeError(tooBig(budgets.maxUncompressedBytes)))
        return
      }
      if (counted !== false && size > budgets.parsedRemaining) {
        finish(new RangeError(tooBig(budgets.maxParsedBytes)))
      }
    })

    stream.on('error', () => finish(new RangeError('Не удалось распаковать содержимое DOCX')))
    // A zero-length part never emits `data`, so it is classified here: counted,
    // because "nothing to identify" must not read as "known to be harmless".
    stream.on('end', () => finish(null, { size, counted: counted ?? true }))

    stream.end(compressed)
  })
}

/**
 * Name the cap that was actually hit. The XML cap and the total cap are very
 * different numbers, and "DOCX is too big" pointing at the wrong one would
 * send someone shrinking images when the problem is the document body.
 */
function tooBig(cap: number): string {
  const isParsedCap = cap === MAX_DOCX_PARSED_BYTES
  const mb = Math.max(1, Math.floor(cap / 1024 / 1024))
  return isParsedCap
    ? `Содержимое DOCX больше ${mb} MB (реальный размер, а не заявленный) — это не похоже на резюме`
    : `Распакованный DOCX больше ${mb} MB (реальный размер, а не заявленный)`
}

// ---------------------------------------------------------------------------
// PDF content-stream guard
// ---------------------------------------------------------------------------

export interface PdfInspection {
  streams: number
  /** Decoded bytes of everything that is not image data (memory). */
  contentBytes: number
  /** Text-showing operators across all content streams. */
  textOperators: number
  /** The busiest single stream — the unit the page count multiplies. */
  largestStreamOperators: number
  /** `pages x largestStreamOperators` — the upper bound on parser work. */
  amplifiedOperators: number
}

/**
 * Establish, before `extractText` runs, that a PDF cannot demand more content
 * parsing than `maxContentBytes`.
 *
 * Deliberately a byte scan rather than a PDF parser: writing an object/xref
 * parser to defend a parser is how you end up with two parsers to defend. Each
 * `stream ... endstream` span is decoded under the remaining budget, so a
 * document over the cap is refused while most of it is still compressed.
 *
 * Image streams are skipped (see `PDF_IMAGE_FILTERS`); a stream that does not
 * inflate is charged its raw length, because an uncompressed content stream is
 * content the parser will still walk.
 *
 * `pages` comes from pdf.js itself (`getDocumentProxy`, which reads the xref and
 * catalogue but no content), so the amplification factor is a fact rather than
 * a guess from a regex — object streams would hide page dictionaries from any
 * byte scan.
 */
export async function inspectPdfContent(
  buf: Buffer,
  pages: number,
  maxContentBytes: number = MAX_PDF_CONTENT_BYTES,
  maxTextOperators: number = MAX_PDF_TEXT_OPERATORS,
): Promise<PdfInspection> {
  let contentBytes = 0
  let textOperators = 0
  let largestStreamOperators = 0
  let streams = 0
  let cursor = 0

  for (;;) {
    const start = buf.indexOf('stream', cursor, 'latin1')
    if (start < 0) break
    // Skip the `endstream` keyword, which also contains "stream".
    if (start >= 3 && buf.subarray(start - 3, start).toString('latin1') === 'end') {
      cursor = start + 6
      continue
    }
    const end = buf.indexOf('endstream', start, 'latin1')
    if (end < 0) break

    // The stream dictionary sits immediately before the keyword.
    const dict = buf.subarray(Math.max(0, start - 512), start).toString('latin1')
    let dataStart = start + 'stream'.length
    if (buf[dataStart] === 0x0d) dataStart += 1
    if (buf[dataStart] === 0x0a) dataStart += 1

    cursor = end + 'endstream'.length
    streams += 1

    if (isPdfImageStream(dict)) continue

    const raw = buf.subarray(dataStart, end)
    const remaining = maxContentBytes - contentBytes
    if (remaining <= 0) throw new RangeError(pdfTooBig(maxContentBytes))

    let decodedBuf: Buffer
    if (dict.includes('FlateDecode')) {
      try {
        decodedBuf = await inflateAsync(raw, { maxOutputLength: remaining })
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code
        if (code === 'ERR_BUFFER_TOO_LARGE') throw new RangeError(pdfTooBig(maxContentBytes))
        // Not really Flate (or truncated): charge what is physically there.
        decodedBuf = raw
      }
    } else {
      decodedBuf = raw
    }
    const decoded = decodedBuf.length

    contentBytes += decoded
    if (contentBytes > maxContentBytes) throw new RangeError(pdfTooBig(maxContentBytes))

    const ops = countTextOperators(decodedBuf)
    textOperators += ops
    if (ops > largestStreamOperators) largestStreamOperators = ops
    if (textOperators > maxTextOperators) throw new RangeError(pdfTooBusy(maxTextOperators))
  }

  // N pages sharing one stream cost N executions of it.
  const amplifiedOperators = Math.max(1, pages) * largestStreamOperators
  if (amplifiedOperators > maxTextOperators) throw new RangeError(pdfTooBusy(maxTextOperators))

  return { streams, contentBytes, textOperators, largestStreamOperators, amplifiedOperators }
}

/**
 * Count text-showing operators (`Tj`, `TJ`, `'`, `"`) in a decoded stream.
 *
 * A byte scan, not a tokeniser: the point is to bound the parser, and building
 * a PDF tokeniser to protect a PDF tokeniser only doubles the attack surface.
 * It can over-count when those letter pairs appear inside a string literal,
 * which is the safe direction for a guard — it can refuse a little early, never
 * a little late.
 */
function countTextOperators(decoded: Buffer): number {
  const text = decoded.toString('latin1')
  return (text.match(/(?:^|[\s\]>)])(?:Tj|TJ|'|")(?=[\s/[<(]|$)/g) ?? []).length
}

function pdfTooBig(cap: number): string {
  return `Содержимое PDF больше ${Math.floor(cap / 1024 / 1024)} MB после распаковки — это не похоже на резюме`
}

function pdfTooBusy(cap: number): string {
  return `В PDF слишком много текстовых операций (предел ${cap}) — это не похоже на резюме`
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Truncate raw extractor output to the one size this system is willing to hold
 * in memory (`RESUME_LIMITS.extractionRawChars`).
 *
 * MUST run BEFORE `normalizeExtractedText`, and that ordering is the whole
 * point of this function existing separately. An honest 52 KB DOCX expands to
 * 50 MiB of characters; normalising 50 MiB blocks the event loop for seconds,
 * and the upload endpoint allows ten of those a minute. Truncating first turns
 * that into a bounded ~200 KB pass. The old code capped the text only when the
 * model prompt was built — i.e. after the expensive part had already run.
 */
export function capExtractedText(raw: string): string {
  return raw.length <= RESUME_LIMITS.extractionRawChars
    ? raw
    : raw.slice(0, RESUME_LIMITS.extractionRawChars)
}

/**
 * Collapse the whitespace soup PDF/DOCX extraction produces into something a
 * model can read cheaply: no NUL bytes, no runs of blank lines, no trailing
 * spaces. Fewer wasted tokens per request, and a stable input for tests.
 *
 * Written as native regex passes rather than a per-codepoint JS loop: at the
 * bounded size above either would do, but the regex engine does the work in
 * one native pass instead of allocating an array per line.
 */
export function normalizeExtractedText(raw: string): string {
  return raw
    .split('\n')
    .map((line) =>
      line
        // C0 controls (NUL, form feed, vertical tab, ...) — but keep tab (\x09).
        .replace(/[\x00-\x08\x0B-\x1F]/g, '')
        .replace(/[\t ]+/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
