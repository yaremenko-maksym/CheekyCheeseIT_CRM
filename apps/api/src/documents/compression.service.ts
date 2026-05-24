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

export interface CompressionResult {
  buffer: Buffer
  finalMimeType: string
  sizeBytes: number
}

@Injectable()
export class CompressionService {
  private readonly logger = new Logger(CompressionService.name)

  async compress(buffer: Buffer, mimeType: string): Promise<CompressionResult> {
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
        this.logger.warn(`compress() called with unsupported mime "${mimeType}" — returning original`)
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
        } else if (finalMime === 'application/pdf') {
          processed = await this.stripPdfMetadata(processed)
        }
      }
    } catch (err) {
      // Any pipeline failure → return original. We log so ops can spot
      // recurring sharp/pdf-lib breakage but never block the upload.
      this.logger.error(
        `compression failed for mime="${mimeType}": ${(err as Error).message} — returning original`,
      )
      return {
        buffer: original,
        finalMimeType: mimeType,
        sizeBytes: original.length,
      }
    }

    // ----- Anti-bloat guard -----
    if (processed.length >= original.length) {
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

  private async compressPdf(buf: Buffer): Promise<Buffer> {
    const doc = await PDFDocument.load(buf, { updateMetadata: false })
    const out = await doc.save({ useObjectStreams: true })
    return Buffer.from(out)
  }

  private async stripPdfMetadata(buf: Buffer): Promise<Buffer> {
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
