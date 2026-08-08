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
 * Bounds (a resume upload must not be a DoS vector). Each measures a DIFFERENT
 * thing, and the file that hurt us measured small on all the others — which is
 * the whole lesson here, so they are listed by what they actually bound:
 *
 *   - `MAX_DOCX_XML_BYTES` bounds PARSER WORK, and is the one that matters.
 *     `mammoth.extractRawText` runs on the main thread, before any downstream
 *     cap can apply, and its cost tracks the size of the XML parts. A 165 KB
 *     file of a million tiny paragraphs passed the byte, type and page gates
 *     and stalled the event loop for 33 336 ms continuously. Capping the XML
 *     refuses it from metadata in ~1 ms and holds the worst PERMITTED document
 *     to 363 ms. Both numbers are asserted in the spec by measuring loop lag.
 *   - `MAX_DOCX_UNCOMPRESSED_BYTES` bounds MEMORY (real size, not declared).
 *   - `MAX_PDF_PAGES` bounds pages for the PDF branch.
 *   - `capExtractedText` bounds CHARACTERS carried downstream, applied before
 *     normalisation. Necessary but NOT sufficient on its own: it runs after the
 *     parser, so it cannot help with parser cost — the mistake this file made
 *     in the previous round.
 *   - `MAX_CONCURRENT_EXTRACTIONS` bounds simultaneous peak memory (only).
 */
import { Injectable, Logger } from '@nestjs/common'
import { RESUME_DOCX_MIME, RESUME_PDF_MIME } from '@crm/shared'
import {
  MAX_PDF_PAGES,
  capExtractedText,
  inspectDocxZip,
  inspectPdfContent,
  normalizeExtractedText,
  type ResumeSourceMime,
} from './resume-source.util'

/**
 * How many extractions may hold parser state at once, process-wide.
 *
 * BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT BUY, because the first version
 * of this constant was untestable and therefore worthless:
 *
 *   - it does NOT reduce main-thread work. Serialising CPU-bound parses moves
 *     the same milliseconds around; the bound that actually cut them is
 *     `MAX_DOCX_XML_BYTES` (33 336 ms -> 363 ms worst continuous stall).
 *   - it DOES bound peak MEMORY. Each in-flight extraction can hold up to
 *     `MAX_DOCX_UNCOMPRESSED_BYTES` of inflated parts plus the parser's own
 *     structures, and the upload endpoint admits ten requests a minute. Two at
 *     a time is a bounded working set; ten is ten times the peak for no gain,
 *     since one thread executes them serially anyway.
 *
 * Observable through `activeExtractions` so the limit is a tested fact rather
 * than a comforting constant — swap the 2 for a large number and the
 * concurrency test fails.
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

  /** In-flight extractions right now — the gate's only observable effect. */
  get activeExtractions(): number {
    return this.running
  }

  /** Extractions admitted but waiting for a slot. */
  get queuedExtractions(): number {
    return this.waiting.length
  }

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
      // `getDocumentProxy` reads the xref and catalogue only — no content
      // streams — so the page count is available before anything expensive.
      const proxy = await getDocumentProxy(new Uint8Array(buffer))
      if (proxy.numPages > MAX_PDF_PAGES) {
        throw new ResumeFileUnreadableError(
          `В PDF больше ${MAX_PDF_PAGES} страниц — это не похоже на резюме`,
        )
      }
      // The DOCX branch had a size guard and the PDF branch had none, which is
      // how a 24 KB file bought 23 267 ms of stall: page count and compressed
      // size both measure something other than the operators `extractText`
      // walks. The real page count feeds the amplification factor, because
      // every page may point at the same content stream.
      try {
        await inspectPdfContent(buffer, proxy.numPages)
      } catch (err: unknown) {
        throw new ResumeFileUnreadableError(
          err instanceof RangeError ? err.message : 'Не удалось прочитать PDF-файл',
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
