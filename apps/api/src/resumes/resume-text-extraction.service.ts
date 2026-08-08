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
 * Bounds (a resume upload must not be a DoS vector) — all THREE are needed,
 * because each one measures a different thing and the file that hurt us
 * measured small on the other two:
 *   - page cap for PDFs (`MAX_PDF_PAGES`) — bounds the pages,
 *   - real (not declared) uncompressed-size + entry-count cap for DOCX,
 *     established by `inspectDocxZip` before `mammoth` sees the buffer,
 *   - CHARACTER cap on the extractor's output (`capExtractedText`), applied
 *     BEFORE normalisation. Nothing above bounds characters: a legitimate
 *     52 KB DOCX that passes every size gate still yields 50 MiB of text, and
 *     one per-character pass over that freezes the whole API for seconds.
 */
import { Injectable, Logger } from '@nestjs/common'
import { RESUME_DOCX_MIME, RESUME_PDF_MIME } from '@crm/shared'
import {
  MAX_PDF_PAGES,
  capExtractedText,
  inspectDocxZip,
  normalizeExtractedText,
  type ResumeSourceMime,
} from './resume-source.util'

/**
 * How many extractions may run at once, process-wide.
 *
 * Extraction is CPU- and memory-hungry (a PDF parse is synchronous JS) and the
 * upload endpoint lets ten requests a minute through per address. Without a
 * gate, ten simultaneous uploads mean ten parsers competing for one thread and
 * ten peak buffers at once; with it, the work is bounded and the rest simply
 * wait their turn in QUEUED — which is exactly the state the UI already
 * renders honestly.
 */
export const MAX_CONCURRENT_EXTRACTIONS = 2

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

  private running = 0
  private readonly waiting: Array<() => void> = []

  /**
   * Extract plain text from a validated resume buffer.
   *
   * Returns normalised text, possibly EMPTY — an empty result is a legitimate
   * outcome (a scanned/image-only PDF has no text layer) and the caller turns
   * it into the actionable `NO_TEXT` state that offers pasting text instead.
   * Only genuinely broken/oversized input throws.
   */
  async extract(buffer: Buffer, mime: ResumeSourceMime): Promise<string> {
    if (mime !== RESUME_PDF_MIME && mime !== RESUME_DOCX_MIME) {
      throw new ResumeFileUnreadableError('Неподдерживаемый формат файла')
    }
    await this.acquireSlot()
    try {
      return mime === RESUME_PDF_MIME
        ? await this.extractFromPdf(buffer)
        : await this.extractFromDocx(buffer)
    } finally {
      this.releaseSlot()
    }
  }

  /** Concurrency gate — see `MAX_CONCURRENT_EXTRACTIONS`. */
  private acquireSlot(): Promise<void> {
    if (this.running < MAX_CONCURRENT_EXTRACTIONS) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  private releaseSlot(): void {
    this.running -= 1
    this.waiting.shift()?.()
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
      // Cap FIRST, normalise second — a page-capped PDF can still carry tens of
      // millions of characters, and normalisation is the per-character pass.
      return normalizeExtractedText(capExtractedText(text))
    } catch (err: unknown) {
      if (err instanceof ResumeFileUnreadableError) throw err
      this.logger.warn(`PDF extraction failed: ${err instanceof Error ? err.message : 'unknown'}`)
      throw new ResumeFileUnreadableError('Не удалось прочитать PDF-файл')
    }
  }

  private async extractFromDocx(buffer: Buffer): Promise<string> {
    // Zip-bomb guard runs FIRST and establishes the REAL expanded size (bounded
    // inflate on the thread pool) — `mammoth` is never handed a buffer whose
    // true size is still unknown.
    try {
      await inspectDocxZip(buffer)
    } catch (err: unknown) {
      throw new ResumeFileUnreadableError(
        err instanceof RangeError ? err.message : 'Не удалось прочитать DOCX-файл',
      )
    }

    const mammoth = await import('mammoth')
    try {
      const result = await mammoth.extractRawText({ buffer })
      // Cap FIRST, normalise second — see `capExtractedText`. A 52 KB DOCX
      // within every size bound still yields 50 MiB of text.
      return normalizeExtractedText(capExtractedText(result.value ?? ''))
    } catch (err: unknown) {
      this.logger.warn(`DOCX extraction failed: ${err instanceof Error ? err.message : 'unknown'}`)
      throw new ResumeFileUnreadableError('Не удалось прочитать DOCX-файл')
    }
  }
}
