/**
 * ResumeTextExtractionService — server-side text extraction from a resume file
 * (task-resume-base §2). Step 1 of the pipeline: bytes -> plain text. Step 2
 * (text -> structure) is ResumeAiService's job.
 *
 * Library choice (the task asked to check and justify, not to take on faith):
 *   - PDF  -> `unpdf` 1.8. It is a serverless-oriented repack of pdf.js with a
 *     REAL CommonJS build (`exports.require -> dist/index.cjs`), which this
 *     package needs (`tsconfig.module = CommonJS`). Compare: `pdf-parse` v2 is
 *     ESM-only, and `file-type` was already rejected for exactly this reason
 *     in documents/compression.service.ts. Pure JS, no native build step, so
 *     it survives the Alpine production image unchanged.
 *   - DOCX -> `mammoth` 1.12. CommonJS `main`, pure JS, and its whole purpose
 *     is "Word document -> text/HTML" so `extractRawText` is a one-liner.
 * Both were verified to load and extract under `require()` in this repo's
 * Node 20 CJS setup before being committed.
 *
 * Bounds (a resume upload must not be a DoS vector):
 *   - page cap for PDFs (`MAX_PDF_PAGES`),
 *   - uncompressed-size + entry-count cap for DOCX, read from the zip central
 *     directory BEFORE any inflate (`inspectDocxZip`) — a DOCX is a zip and a
 *     zip bomb here is a real, cheap attack,
 *   - the extracted text is capped again at prompt-build time
 *     (`RESUME_LIMITS.extractionInputChars`).
 */
import { Injectable, Logger } from '@nestjs/common'
import { RESUME_DOCX_MIME, RESUME_PDF_MIME } from '@crm/shared'
import {
  MAX_PDF_PAGES,
  inspectDocxZip,
  normalizeExtractedText,
  type ResumeSourceMime,
} from './resume-source.util'

/** Thrown for every "we cannot read this file" case — mapped to UNREADABLE_FILE. */
export class ResumeFileUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResumeFileUnreadableError'
  }
}

@Injectable()
export class ResumeTextExtractionService {
  private readonly logger = new Logger(ResumeTextExtractionService.name)

  /**
   * Extract plain text from a validated resume buffer.
   *
   * Returns normalised text, possibly EMPTY — an empty result is a legitimate
   * outcome (a scanned/image-only PDF has no text layer) and the caller turns
   * it into the actionable `NO_TEXT` state that offers pasting text instead.
   * Only genuinely broken/oversized input throws.
   */
  async extract(buffer: Buffer, mime: ResumeSourceMime): Promise<string> {
    if (mime === RESUME_PDF_MIME) return this.extractFromPdf(buffer)
    if (mime === RESUME_DOCX_MIME) return this.extractFromDocx(buffer)
    throw new ResumeFileUnreadableError('Неподдерживаемый формат файла')
  }

  private async extractFromPdf(buffer: Buffer): Promise<string> {
    // Imported lazily so a broken/absent optional parser can never take the
    // whole Nest bootstrap down — extraction is a background job, not a
    // boot-critical dependency.
    const { extractText, getDocumentProxy } = await import('unpdf')
    try {
      const proxy = await getDocumentProxy(new Uint8Array(buffer))
      if (proxy.numPages > MAX_PDF_PAGES) {
        throw new ResumeFileUnreadableError(
          `В PDF больше ${MAX_PDF_PAGES} страниц — это не похоже на резюме`,
        )
      }
      // `mergePages: true` makes `text` a single string (per-page array otherwise).
      const { text } = await extractText(proxy, { mergePages: true })
      return normalizeExtractedText(text)
    } catch (err: unknown) {
      if (err instanceof ResumeFileUnreadableError) throw err
      this.logger.warn(`PDF extraction failed: ${err instanceof Error ? err.message : 'unknown'}`)
      throw new ResumeFileUnreadableError('Не удалось прочитать PDF-файл')
    }
  }

  private async extractFromDocx(buffer: Buffer): Promise<string> {
    // Zip-bomb guard runs FIRST, on metadata only — nothing is inflated until
    // the declared uncompressed size is known to be sane.
    try {
      inspectDocxZip(buffer)
    } catch (err: unknown) {
      throw new ResumeFileUnreadableError(
        err instanceof RangeError ? err.message : 'Не удалось прочитать DOCX-файл',
      )
    }

    const mammoth = await import('mammoth')
    try {
      const result = await mammoth.extractRawText({ buffer })
      return normalizeExtractedText(result.value ?? '')
    } catch (err: unknown) {
      this.logger.warn(`DOCX extraction failed: ${err instanceof Error ? err.message : 'unknown'}`)
      throw new ResumeFileUnreadableError('Не удалось прочитать DOCX-файл')
    }
  }
}
