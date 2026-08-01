/**
 * CompressionService — server-side file compression for documents uploads.
 *
 * Two-pass strategy (see pm-brief.md "Compression policy"):
 *
 *   Pass 1 (always):
 *     image/jpeg  → sharp .rotate().resize(2048).jpeg({quality:85, mozjpeg, progressive})
 *     image/heic  → heic-convert → JPEG → sharp pass-1 (final mime image/jpeg)
 *     image/png   → no alpha → JPEG (huge win); with alpha → .png({compressionLevel:9, palette:true})
 *     image/webp  → .webp({quality:80}) re-encode
 *     application/pdf → PDFDocument.load(...).save({useObjectStreams:true})
 *
 *   Pass 2 (only if pass-1 result > PASS2_THRESHOLD_BYTES):
 *     JPEG (any image converted to jpeg) → resize 1600 max-side, quality 75
 *     PDF → strip metadata fields
 *
 *   Anti-bloat: if final size > original, return original buffer + original
 *   mime — sharp/pdf-lib occasionally inflate tiny optimized files.
 *
 * Why we do compression on the BACKEND (not in the browser):
 *   - consistent behavior across clients (mobile / desktop / different sharps)
 *   - lets us reject ridiculous uploads BEFORE they hit S3
 *   - one shared library (sharp) vs N clientside polyfills
 *   - lets us thumbnail in the same pass
 *
 * makeThumbnail() lives here too. Currently only image inputs produce a
 * thumbnail; PDFs return null (UI shows a generic icon). Thumbnails are
 * stored alongside the main object under `<key>-thumb.jpg`.
 */
import { Injectable, Logger } from '@nestjs/common'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'
import heicConvert from 'heic-convert'

/**
 * Pass-2 trigger threshold. Any pass-1 result larger than this triggers the
 * aggressive resize/quality reduction. 5 MB picked so a typical phone-camera
 * JPEG (3–6 MB raw) still gets the aggressive pass and lands well under the
 * 10 MB hard cap.
 */
const PASS2_THRESHOLD_BYTES = 5 * 1024 * 1024

/**
 * task-file-storage-hardening §5: PDF metadata stripping was ONLY wired into
 * pass 2 (`stripPdfMetadata`), which only fires when pass-1 output exceeds
 * `PASS2_THRESHOLD_BYTES` (5 MB). Resumes are hard-capped at 5 MB
 * (`RESUME_MAX_BYTES` in applications.service.ts) BEFORE they ever reach this
 * service, and a pdf-lib re-save does not shrink an already-small PDF below
 * its own size — so pass 2 essentially never fired for a resume and the
 * "we sanitize PDFs" claim was false in practice. Metadata (author/title/etc,
 * often auto-filled by Word/Google Docs with the applicant's real name and
 * software fingerprint) survived untouched into R2. Fix: metadata stripping
 * now runs unconditionally in pass 1 for EVERY PDF, regardless of size — see
 * `compressPdf()` below (merged what used to be two separate functions).
 */

export interface CompressionResult {
  buffer: Buffer
  finalMimeType: string
  sizeBytes: number
}

/**
 * Thrown by CompressionService.compress() when the pipeline fails for a
 * known/whitelisted MIME type (corrupt image, malformed PDF, etc.).
 * DocumentsService catches this and converts it to a 415 UnsupportedMediaType.
 */
export class CompressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompressionError'
  }
}

/**
 * Detect the actual MIME type of a buffer by inspecting its magic bytes.
 *
 * Why not `file-type` npm package: it is ESM-only since v17 and this codebase
 * compiles to CommonJS (tsconfig `"module": "CommonJS"`). We support exactly
 * the five types in DOCUMENT_MIME_WHITELIST, so a small inline detector is
 * simpler and has zero extra dependencies.
 *
 * Returns the detected MIME string, or null when the signature is unknown
 * (caller treats null as "unrecognized binary").
 */
export function detectMimeFromBuffer(buf: Buffer): string | null {
  // Need at least 12 bytes for HEIC/AVIF detection
  if (buf.length < 4) return null

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'

  // WebP: RIFF????WEBP (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP")
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return 'image/webp'

  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
    return 'application/pdf'

  // HEIC / HEIF: ftyp box at offset 4 (bytes 4-7), brand at 8-11.
  // Common brands: heic, heix, hevc, hevx, mif1, msf1, avif.
  // The ftyp box major-brand starts at byte 8 and is 4 ASCII chars.
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const brand = buf.subarray(8, 12).toString('ascii')
    if (/^(heic|heix|hevc|hevx|mif1|msf1|avif)/.test(brand)) return 'image/heic'
  }

  return null
}

@Injectable()
export class CompressionService {
  private readonly logger = new Logger(CompressionService.name)

  async compress(
    buffer: Buffer,
    mimeType: string,
    opts: { neverFallbackToOriginal?: boolean } = {},
  ): Promise<CompressionResult> {
    const original = buffer
    let processed: Buffer = original
    let finalMime = mimeType

    try {
      // ----- Pass 1 (always) -----
      if (mimeType === 'image/jpeg') {
        processed = await this.compressJpeg(original, { quality: 85, maxSide: 2048 })
        finalMime = 'image/jpeg'
      } else if (mimeType === 'image/heic') {
        const jpegBuf = await this.heicToJpeg(original)
        processed = await this.compressJpeg(jpegBuf, { quality: 85, maxSide: 2048 })
        finalMime = 'image/jpeg'
      } else if (mimeType === 'image/png') {
        const hasAlpha = await this.pngHasAlpha(original)
        if (!hasAlpha) {
          // No alpha → JPEG is dramatically smaller for photos
          processed = await sharp(original)
            .rotate()
            .resize({ width: 2048, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85, mozjpeg: true, progressive: true })
            .toBuffer()
          finalMime = 'image/jpeg'
        } else {
          processed = await sharp(original)
            .rotate()
            .resize({ width: 2048, fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9, palette: true })
            .toBuffer()
          finalMime = 'image/png'
        }
      } else if (mimeType === 'image/webp') {
        processed = await sharp(original)
          .rotate()
          .resize({ width: 2048, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer()
        finalMime = 'image/webp'
      } else if (mimeType === 'application/pdf') {
        processed = await this.compressPdf(original)
        finalMime = 'application/pdf'
      } else {
        // Unknown MIME — pass through. The DocumentsService MIME whitelist
        // should already have rejected it; this branch is defensive.
        this.logger.warn(
          `compress() called with unsupported mime "${mimeType}" — returning original`,
        )
        return {
          buffer: original,
          finalMimeType: mimeType,
          sizeBytes: original.length,
        }
      }

      // ----- Pass 2 (aggressive if still > threshold) -----
      if (processed.length > PASS2_THRESHOLD_BYTES) {
        if (finalMime === 'image/jpeg') {
          processed = await this.compressJpeg(processed, { quality: 75, maxSide: 1600 })
        } else if (finalMime === 'image/png') {
          processed = await sharp(processed)
            .rotate()
            .resize({ width: 1600, fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9, palette: true, quality: 70 })
            .toBuffer()
        } else if (finalMime === 'image/webp') {
          processed = await sharp(processed)
            .rotate()
            .resize({ width: 1600, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 65 })
            .toBuffer()
        }
        // No PDF branch here: `compressPdf()` (pass 1, above) already strips
        // metadata + re-saves with object streams for EVERY PDF regardless of
        // size — see the PASS2_THRESHOLD_BYTES comment. A second pass would
        // just re-run the identical operation for no benefit.
      }
    } catch (err) {
      // Compression pipeline failure for a known/validated MIME type.
      // Re-throw so the caller (DocumentsService) can surface a 415 instead of
      // silently storing corrupted/unprocessed content under the declared MIME.
      // The only way we reach here is with a MIME that passed the whitelist
      // check — so the buffer was claimed to be a valid image/PDF but
      // sharp/pdf-lib/heic-convert rejected it (corrupt file, misidentified
      // magic bytes, etc.).
      this.logger.error(
        `compression failed for mime="${mimeType}": ${(err as Error).message} — rejecting upload`,
      )
      throw new CompressionError(
        `Не удалось обработать файл типа "${mimeType}": ${(err as Error).message}`,
      )
    }

    // ----- Anti-bloat guard -----
    if (processed.length >= original.length) {
      if (opts.neverFallbackToOriginal) {
        // task-file-storage-hardening §5: for the ONE call site that submits
        // publicly / anonymously (ApplicationsService.apply()), `original` is
        // exactly the untouched bytes the applicant sent. Falling back to it
        // here silently undoes the pass-1 PDF metadata strip above — pdf-lib's
        // `useObjectStreams` re-save is occasionally a handful of bytes
        // LARGER than an already-compact input PDF, so this guard used to
        // trigger routinely and store the unsanitized file it exists to
        // protect against. A sanitized file that's a few bytes bigger is a
        // strictly better trade than a byte-identical copy of whatever an
        // anonymous submitter uploaded.
        return {
          buffer: processed,
          finalMimeType: finalMime,
          sizeBytes: processed.length,
        }
      }
      return {
        buffer: original,
        finalMimeType: mimeType,
        sizeBytes: original.length,
      }
    }

    return {
      buffer: processed,
      finalMimeType: finalMime,
      sizeBytes: processed.length,
    }
  }

  /**
   * Generate a 256x256 JPEG thumbnail (~10 KB). Returns null for non-image
   * inputs — the documents UI falls back to a PDF/file icon in that case.
   */
  async makeThumbnail(buffer: Buffer, mimeType: string): Promise<Buffer | null> {
    if (!this.isImageMime(mimeType)) return null
    try {
      let source = buffer
      if (mimeType === 'image/heic') {
        source = await this.heicToJpeg(buffer)
      }
      return await sharp(source)
        .rotate()
        .resize({ width: 256, height: 256, fit: 'cover' })
        .jpeg({ quality: 70 })
        .toBuffer()
    } catch (err) {
      this.logger.warn(
        `thumbnail generation failed for mime="${mimeType}": ${(err as Error).message}`,
      )
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async compressJpeg(
    buf: Buffer,
    opts: { quality: number; maxSide: number },
  ): Promise<Buffer> {
    return sharp(buf)
      .rotate() // Honour EXIF orientation — phone photos are otherwise sideways
      .resize({ width: opts.maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: opts.quality, mozjpeg: true, progressive: true })
      .toBuffer()
  }

  private async pngHasAlpha(buf: Buffer): Promise<boolean> {
    const meta = await sharp(buf).metadata()
    // sharp's `hasAlpha` is the most reliable check across PNG variants
    return Boolean(meta.hasAlpha)
  }

  private async heicToJpeg(buf: Buffer): Promise<Buffer> {
    // heic-convert returns an ArrayBuffer/Uint8Array; normalize to Buffer
    const result = await heicConvert({
      buffer: buf as unknown as ArrayBufferLike,
      format: 'JPEG',
      quality: 0.9,
    })
    return Buffer.from(result)
  }

  /**
   * Pass-1, unconditional: re-save through pdf-lib (useObjectStreams) AND
   * strip metadata fields that commonly carry PII (author = the applicant's
   * real name from Word/Google Docs export, producer/creator = software
   * fingerprint). Previously metadata-stripping lived in a separate
   * `stripPdfMetadata()` only reachable from pass 2 — see the
   * PASS2_THRESHOLD_BYTES comment for why that never fired for resumes.
   * Merging the two into one always-run step closes that gap for every PDF
   * category, not just resumes.
   *
   * Residual risk (task-file-storage-hardening §5, documented per the task's
   * own instruction rather than silently left out): pdf-lib has no supported
   * API to strip active content — an `/OpenAction` triggered on open,
   * embedded `/JavaScript`, or embedded file attachments. Hand-editing the
   * low-level PDF object graph to remove those is unsupported territory for
   * this library and risks silently corrupting legitimate PDFs (broken
   * xref/trailer) for an antivirus-class problem this task explicitly does
   * NOT take on ("Антивирус в этой задаче не заводим — отдельное решение
   * владельца"). Left as a known remainder, not attempted here.
   */
  private async compressPdf(buf: Buffer): Promise<Buffer> {
    const doc = await PDFDocument.load(buf, { updateMetadata: false })
    // Strip common metadata fields. These are no-ops if already empty.
    doc.setTitle('')
    doc.setAuthor('')
    doc.setSubject('')
    doc.setKeywords([])
    doc.setProducer('')
    doc.setCreator('')
    const out = await doc.save({ useObjectStreams: true })
    return Buffer.from(out)
  }

  private isImageMime(mime: string): boolean {
    return mime.startsWith('image/')
  }
}
