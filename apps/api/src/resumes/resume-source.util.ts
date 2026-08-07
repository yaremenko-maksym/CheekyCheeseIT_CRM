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
import { RESUME_DOCX_MIME, RESUME_PDF_MIME } from '@crm/shared'
import { detectMimeFromBuffer } from '../documents/compression.service'

/** Max entries we are willing to walk in a DOCX zip central directory. */
const MAX_ZIP_ENTRIES = 2000
/**
 * Max total UNCOMPRESSED size of a DOCX. A DOCX is a zip, so its on-disk size
 * says nothing about what it expands to: a few-KB "zip bomb" can decompress
 * into gigabytes and take the API process down. 60 MB is ~6x the largest
 * plausible real resume with images, and is checked BEFORE any unzipping
 * happens (from the central-directory metadata, not by decompressing).
 */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024

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
  totalUncompressedBytes: number
}

/**
 * Walk a DOCX's zip central directory and sum the declared uncompressed sizes
 * WITHOUT decompressing anything.
 *
 * Throws `RangeError` when the archive is malformed, uses ZIP64 (a resume has
 * no business being >4 GB and supporting it would only widen this parser), or
 * declares more entries than `MAX_ZIP_ENTRIES`. The caller maps that onto a
 * clean "unreadable file" failure.
 */
export function inspectDocxZip(buf: Buffer): ZipInspection {
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

  const totalEntries = readU16LE(buf, eocd + 10)
  const cdOffset = readU32LE(buf, eocd + 16)
  if (totalEntries === null || cdOffset === null) throw new RangeError('Повреждённый zip-каталог')
  if (cdOffset === ZIP64_SENTINEL) throw new RangeError('ZIP64-архивы не поддерживаются')
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new RangeError(`Слишком много файлов внутри DOCX (${totalEntries})`)
  }

  let cursor = cdOffset
  let totalUncompressedBytes = 0
  for (let i = 0; i < totalEntries; i += 1) {
    if (readU32LE(buf, cursor) !== ZIP_CENTRAL_HEADER) {
      throw new RangeError('Повреждённая запись zip-каталога')
    }
    const uncompressed = readU32LE(buf, cursor + 24)
    const nameLen = readU16LE(buf, cursor + 28)
    const extraLen = readU16LE(buf, cursor + 30)
    const commentLen = readU16LE(buf, cursor + 32)
    if (uncompressed === null || nameLen === null || extraLen === null || commentLen === null) {
      throw new RangeError('Повреждённая запись zip-каталога')
    }
    if (uncompressed === ZIP64_SENTINEL) throw new RangeError('ZIP64-архивы не поддерживаются')
    totalUncompressedBytes += uncompressed
    if (totalUncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new RangeError(
        `Распакованный DOCX больше ${Math.floor(MAX_DOCX_UNCOMPRESSED_BYTES / 1024 / 1024)} MB`,
      )
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }

  return { entries: totalEntries, totalUncompressedBytes }
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Collapse the whitespace soup PDF/DOCX extraction produces into something a
 * model can read cheaply: no NUL bytes, no runs of blank lines, no trailing
 * spaces. Fewer wasted tokens per request, and a stable input for tests.
 */
export function normalizeExtractedText(raw: string): string {
  return raw
    .split('\n')
    .map((line) =>
      Array.from(line)
        .filter((ch) => {
          const code = ch.charCodeAt(0)
          // Drop C0 controls (NUL, form feed, vertical tab, ...) but keep tab.
          return code > 0x1f || code === 0x09
        })
        .join('')
        .replace(/[\t ]+/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
