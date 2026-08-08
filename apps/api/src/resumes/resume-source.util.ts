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
import { inflateRaw } from 'node:zlib'
import { RESUME_DOCX_MIME, RESUME_PDF_MIME, RESUME_LIMITS } from '@crm/shared'
import { detectMimeFromBuffer } from '../documents/compression.service'

/** Async (thread-pool) inflate — never block the event loop on a bomb. */
const inflateRawAsync = promisify(inflateRaw)

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
 * Max total uncompressed size of the XML PARTS — the bound that actually
 * governs CPU, and the one this file was missing.
 *
 * Measured on the real path, not guessed. Parser cost tracks XML size almost
 * linearly, and the shape that hurts is many tiny paragraphs, not many
 * characters (which is why a character cap downstream did nothing):
 *
 *   XML size   paragraphs   mammoth worst continuous stall
 *    1.5 MB        26 214       866 ms
 *    3.0 MB        52 428     1 166 ms
 *    6.0 MB       104 857     1 847 ms
 *   12.1 MB       209 715     4 433 ms
 *   24.3 MB       419 430     8 876 ms
 *   58.1 MB     1 000 000    33 336 ms   <- 165 KB on disk, passed every gate
 *
 * A real resume of 120 dense bullets is 24 KB of XML. 1 MB is ~40x that and
 * still roomy for a formatting-heavy Word export.
 *
 * Enforced DURING the bounded inflate, so an archive over the cap is rejected
 * the moment the budget runs out: the 58 MB case above costs tens of
 * milliseconds because the remaining 57 MB is never inflated at all.
 *
 * Media is deliberately excluded — `extractRawText` does not parse images, so
 * they cost memory (bounded above) but not parse time.
 */
export const MAX_DOCX_XML_BYTES = 1024 * 1024

/** DEFLATE and STORED are the only methods a real DOCX ever uses. */
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATE = 8

/** Max pages we will parse out of a PDF (a resume is not a 500-page book). */
export const MAX_PDF_PAGES = 30

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
  /** Of that, how much is XML — the part `mammoth` actually parses. */
  actualXmlBytes: number
}

interface ZipEntryHeader {
  name: string
  method: number
  declaredUncompressedSize: number
  localHeaderOffset: number
}

/**
 * True for the parts `mammoth` parses as XML (document, styles, numbering,
 * relationships, content types). Images and fonts are inert for text
 * extraction, so they are charged against memory but not against parse time.
 */
function isXmlPart(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.xml') || lower.endsWith('.rels')
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
 * on the thread pool (`inflateRawAsync`), so neither memory nor the event loop
 * is at the archive's mercy.
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
  maxXmlBytes: number = MAX_DOCX_XML_BYTES,
): Promise<ZipInspection> {
  const { headers, declaredUncompressedBytes } = readCentralDirectory(buf, maxUncompressedBytes)

  let actualUncompressedBytes = 0
  let actualXmlBytes = 0
  for (const header of headers) {
    const xml = isXmlPart(header.name)
    // An XML part gets the SMALLER of the two remaining budgets, so zlib stops
    // the moment either is spent — the 58 MB attack dies a few dozen
    // milliseconds in, with 57 MB of it never inflated.
    const budget = xml
      ? Math.min(maxUncompressedBytes - actualUncompressedBytes, maxXmlBytes - actualXmlBytes)
      : maxUncompressedBytes - actualUncompressedBytes
    const size = await measureEntry(buf, header, budget, xml ? maxXmlBytes : maxUncompressedBytes)
    actualUncompressedBytes += size
    if (xml) actualXmlBytes += size
  }

  return {
    entries: headers.length,
    declaredUncompressedBytes,
    actualUncompressedBytes,
    actualXmlBytes,
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
async function measureEntry(
  buf: Buffer,
  header: ZipEntryHeader,
  budget: number,
  reportedCap: number,
): Promise<number> {
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
    if (size > budget) throw new RangeError(tooBig(reportedCap))
    return size
  }

  if (header.method !== ZIP_METHOD_DEFLATE) {
    throw new RangeError(`Неподдерживаемый метод сжатия внутри DOCX (${header.method})`)
  }

  // `maxOutputLength: 0` is treated as "no limit" by zlib, so a spent budget
  // has to be refused before the call rather than passed into it.
  if (budget <= 0) throw new RangeError(tooBig(reportedCap))

  try {
    const inflated = await inflateRawAsync(buf.subarray(dataStart), { maxOutputLength: budget })
    return inflated.length
  } catch (err: unknown) {
    // zlib signals "output exceeded maxOutputLength" with an ERR_BUFFER_TOO_LARGE
    // error that IS itself a RangeError — so the CODE has to be inspected before
    // any `instanceof RangeError` branch, or the bomb reports itself as a
    // generic Node buffer message instead of our bounded-size failure.
    const code = (err as { code?: string } | null)?.code
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new RangeError(tooBig(reportedCap))
    throw new RangeError('Не удалось распаковать содержимое DOCX')
  }
}

/**
 * Name the cap that was actually hit. The XML cap and the total cap are very
 * different numbers, and "DOCX is too big" pointing at the wrong one would
 * send someone shrinking images when the problem is the document body.
 */
function tooBig(cap: number): string {
  const isXmlCap = cap === MAX_DOCX_XML_BYTES
  const mb = Math.max(1, Math.floor(cap / 1024 / 1024))
  return isXmlCap
    ? `Текстовая часть DOCX больше ${mb} MB (реальный размер, а не заявленный) — это не похоже на резюме`
    : `Распакованный DOCX больше ${mb} MB (реальный размер, а не заявленный)`
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
