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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RESUME_DOCX_MIME, RESUME_LIMITS, RESUME_PDF_MIME } from '@crm/shared'
import { resolveAssetPath } from '../common/assets.util'
import { runSandboxed } from './sandboxed-process'
import {
  MAX_PDF_PAGES,
  inspectDocxZip,
  inspectPdfContent,
  normalizeExtractedText,
  type ResumeSourceMime,
} from './resume-source.util'

/**
 * Wall-clock deadline for one extraction, enforced with SIGKILL.
 *
 * ==========================================================================
 * IT MUST EXCEED THE COST OF THE WORST DOCUMENT THE BUDGETS PERMIT
 * ==========================================================================
 * That relationship is the point, and it is the thing nobody had checked: one
 * bound says what we ACCEPT, the other how long we allow it to TAKE, and they
 * had never been compared. Measured end to end through `extract()` on this
 * machine, three runs each:
 *
 *   densest PERMITTED document (60 000 paragraphs)   576 / 616 / 654 ms
 *   40-page academic CV                              150 / 150 / 149 ms
 *
 * AND THE MACHINE IS PART OF THE MEASUREMENT. The same document costs:
 *
 *   development laptop (Apple silicon)   ~0.65 s
 *   GitHub Actions runner                >10.3 s      — ~15x slower
 *
 * I set this to 10 s on the laptop figure alone and CI went red on five tests,
 * killing a legitimate document and telling the user it was unreadable. That is
 * the third time on this branch that a constant validated on one machine has
 * been wrong on another; production runs on a modest VPS, much closer to the
 * runner than to the laptop.
 *
 * 60 s is ~6x the SLOWEST measured cost of the worst document the budgets
 * permit. It costs nothing in API responsiveness — extraction is a detached job
 * behind a child process, nothing waits on it — and the failure it prevents is
 * the expensive one: refusing a real CV because the machine was busy.
 *
 * THE TRADE, stated because it is real: at 60 s two slots clear ~2 pathological
 * documents a minute against an intake of 10/minute, so a sustained stream of
 * worst-case uploads can queue, and a queued extraction still holds its buffer.
 * The mitigations are that this is an internal tool behind auth, the byte
 * budgets refuse genuinely abusive documents before the worker is started at
 * all, and typical documents finish in well under a second. Making the queue
 * itself bounded is tracked in task-resume-followups.
 *
 * Pinned by "the deadline exceeds the worst document the budgets permit" below,
 * which MEASURES the cost on whatever machine it runs and compares — so it
 * holds on the laptop and on the runner, and no absolute number has to be
 * guessed for a third one.
 */
export const EXTRACTION_TIMEOUT_MS = 60_000

/**
 * Kernel-side CPU backstop (`ulimit -t`) for a starved JS timer.
 *
 * Deliberately above the wall clock: it is a backstop for a timer that never
 * fires, not a second, tighter deadline. Below it, the kernel would become the
 * usual killer and the readable timeout path would be dead code.
 */
export const EXTRACTION_CPU_SECONDS = 90

/**
 * V8 heap ceiling per extraction (`--max-old-space-size`, MiB).
 *
 * Replaces an `ulimit -v` of 1 GiB, which was not a memory bound at all: it
 * capped ADDRESS SPACE, of which a do-nothing Node process reserves ~399 GB
 * against ~31 MB of real use, so the worker died of `std::bad_alloc` before
 * running a line — on 23 KB files, intermittently, for three rounds. Full
 * reasoning in `sandboxed-process.ts`.
 *
 * MEASURED, by running the worker on the worst documents the budgets permit:
 * peak heap is 171-263 MB for the densest permitted DOCX and 34 MB for a
 * 40-page academic CV — an order of magnitude under the old nominal 1 GiB, and
 * a reminder that the address-space number never described memory at all.
 *
 * 768 MiB is ~3x the worst measured. A real ceiling on real heap: exceed it and
 * V8 raises a JavaScript OOM that the worker reports as a failed extraction,
 * rather than a C++ abort that says nothing.
 */
export const EXTRACTION_HEAP_MB = 768

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
    const { getDocumentProxy } = await import('unpdf')
    try {
      // `getDocumentProxy` reads the xref and catalogue only — no content
      // streams — so the page count is available before anything expensive.
      const proxy = await getDocumentProxy(new Uint8Array(buffer))
      if (proxy.numPages > MAX_PDF_PAGES) {
        throw new ResumeFileUnreadableError(
          `В PDF больше ${MAX_PDF_PAGES} страниц — это не похоже на резюме`,
        )
      }
      // Still worth refusing an obviously abusive document before paying to
      // start a process for it — but this is now an efficiency check, not the
      // thing standing between a crafted file and an unavailable API. The
      // actual parse happens in the worker.
      try {
        await inspectPdfContent(buffer, proxy.numPages)
      } catch (err: unknown) {
        throw new ResumeFileUnreadableError(
          err instanceof RangeError ? err.message : 'Не удалось прочитать PDF-файл',
        )
      }
      return normalizeExtractedText(await this.runWorker(buffer, RESUME_PDF_MIME))
    } catch (err: unknown) {
      if (err instanceof ResumeFileUnreadableError) throw err
      this.logger.warn(`PDF extraction failed: ${err instanceof Error ? err.message : 'unknown'}`)
      throw new ResumeFileUnreadableError('Не удалось прочитать PDF-файл')
    }
  }

  /**
   * Run the parser in a child process under the sandbox.
   *
   * The buffer goes through a temp FILE rather than stdin or argv: it is up to
   * 10 MB of someone's personal data, argv has a hard OS limit, and a file is
   * the one channel whose size neither side has to negotiate. It is removed on
   * every path, including the timeout.
   *
   * The worker caps the text before it crosses the pipe, so the API process
   * never holds the 50 MiB an honest 52 KB DOCX can expand into.
   */
  private async runWorker(buffer: Buffer, mime: ResumeSourceMime): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'crm-extract-'))
    const filePath = join(dir, 'source')
    try {
      await writeFile(filePath, buffer)
      const result = await runSandboxed({
        // `process.execPath` — the SAME node that runs the API, so the worker
        // cannot be redirected by a PATH entry.
        bin: process.execPath,
        args: [
          // The heap cap goes to NODE, before the script — this is the bound
          // that actually limits memory for a V8 process (see EXTRACTION_HEAP_MB).
          `--max-old-space-size=${EXTRACTION_HEAP_MB}`,
          resolveAssetPath('workers/resume-extract.cjs'),
          filePath,
          mime,
          String(RESUME_LIMITS.extractionRawChars),
        ],
        cwd: dir,
        // Only what node needs to start. The database URL, the S3 credentials
        // and the Workers AI token have no business inside a document parser
        // driven by an uploaded file.
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        timeoutMs: EXTRACTION_TIMEOUT_MS,
        // No `addressSpaceKb`: RLIMIT_AS is meaningless for a V8 process and
        // was killing this worker. Memory is bounded by the heap cap above,
        // CPU by the kernel backstop below.
        cpuSeconds: EXTRACTION_CPU_SECONDS,
        // Generous slack over the character cap: UTF-8 Cyrillic is two bytes a
        // character and the JSON envelope escapes some of them.
        maxStdoutBytes: RESUME_LIMITS.extractionRawChars * 8,
        maxStderrBytes: 4096,
      })

      if (result.timedOut) {
        throw new ResumeFileUnreadableError(
          `Разбор файла не уложился в ${EXTRACTION_TIMEOUT_MS / 1000} с — вероятно, документ слишком сложный. Вставьте текст резюме вручную.`,
        )
      }
      if (result.code !== 0 || result.stdout === '') {
        this.logger.warn(
          `Extraction worker exited ${String(result.code)}: ${result.stderr.slice(0, 500)}`,
        )
        throw new ResumeFileUnreadableError('Не удалось прочитать файл резюме')
      }

      const parsed = JSON.parse(result.stdout) as { ok: boolean; text?: string; error?: string }
      if (!parsed.ok || typeof parsed.text !== 'string') {
        this.logger.warn(`Extraction worker reported: ${parsed.error ?? 'unknown'}`)
        throw new ResumeFileUnreadableError('Не удалось прочитать файл резюме')
      }
      return parsed.text
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * DOCX -> text.
   *
   * The zip inspection still runs first, and it is still worth running: it
   * refuses obvious rubbish in about a millisecond and its inflate happens on
   * the thread pool. What it is NO LONGER doing is standing between a crafted
   * file and an unavailable API — three bypasses established that it cannot,
   * because every version of it had to predict what `mammoth` would accept, and
   * `mammoth` parses through an error-tolerant XML reader that will happily
   * skip eight bytes of PNG header and read the document behind it.
   *
   * `mammoth` therefore runs in the worker. If it decides to parse 19.5 MB
   * hidden behind a media signature, it does that in a process with a deadline,
   * a memory ceiling and niceness 19 — where it costs a failed upload rather
   * than an unavailable API.
   */
  private async extractFromDocx(buffer: Buffer): Promise<string> {
    try {
      await inspectDocxZip(buffer)
    } catch (err: unknown) {
      throw new ResumeFileUnreadableError(
        err instanceof RangeError ? err.message : 'Не удалось прочитать DOCX-файл',
      )
    }

    try {
      return normalizeExtractedText(await this.runWorker(buffer, RESUME_DOCX_MIME))
    } catch (err: unknown) {
      if (err instanceof ResumeFileUnreadableError) throw err
      this.logger.warn(`DOCX extraction failed: ${err instanceof Error ? err.message : 'unknown'}`)
      throw new ResumeFileUnreadableError('Не удалось прочитать DOCX-файл')
    }
  }
}
