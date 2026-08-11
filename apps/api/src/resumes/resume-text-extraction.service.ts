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
 * ==========================================================================
 * WHAT BOUNDS WHAT — THE SANDBOX BOUNDS COST, THE BUDGETS BOUND SIZE
 * ==========================================================================
 * This list used to promise that some budget bounded parser work. None does,
 * and each attempt to name one cost a round of tuning the deadline:
 *
 *   budget keyed on BYTES        missed node count  (same bytes, 21x cost)
 *   budget keyed on NODE COUNT   missed attributes  (15 tags, 18 310 ms)
 *
 * Measured, both inside every byte budget here: 4.18 MB of `<w:p/>` is
 * 695 731 tags and 1 609 ms, while 1.33 MB carrying 120 000 attributes on ONE
 * element is 15 tags and 18 310 ms — because `@xmldom/xmldom` rescans an
 * element's attributes as each is added, so cost is quadratic in attributes,
 * and attributes contain no `<` for any tag counter to see.
 *
 * A parser with several superlinear paths always has one more dimension than
 * whatever scalar is chosen to bound it. That is the same lesson the part
 * classifier learned (extension -> any-extension -> magic bytes, see
 * `MEDIA_SIGNATURES`) and it has the same answer: isolation closes the class.
 *
 *   - THE SANDBOX IS THE GUARANTEE. `runSandboxed` gives the parse a wall-clock
 *     deadline, a CPU rlimit, a heap ceiling, niceness 19 and a concurrency
 *     limit of two. It does not care WHICH dimension made a document
 *     expensive, which is exactly why it holds where a predicate cannot.
 *     Measured: the 18 310 ms attribute bomb costs the API event loop 12 ms.
 *   - THE BUDGETS ARE A CHEAP, HONEST "NO". They bound SIZE and MEMORY, and
 *     they let an obviously hopeless upload be refused from metadata in about
 *     a millisecond with a message a person can act on — instead of occupying
 *     an extraction slot for a minute to arrive at "timed out". That is worth
 *     having. It is not a cost guarantee and must not be described as one.
 *
 * By that division:
 *   - `MAX_DOCX_PARSED_BYTES` / `MAX_DOCX_UNCOMPRESSED_BYTES` — size and real
 *     (not declared) expansion of the archive.
 *   - `MAX_PDF_PAGES` / `MAX_PDF_CONTENT_BYTES` — the PDF branch's size bounds.
 *     `MAX_PDF_TEXT_OPERATORS` is the one guard here that does track its
 *     parser's cost, because pdf.js executes operators and they are countable;
 *     it is not a counter-example, it is a different parser.
 *   - `capExtractedText` bounds CHARACTERS carried downstream, after the parse.
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
 * THIS IS THE COST BOUND. THE ACCEPTANCE BUDGETS ARE NOT.
 * ==========================================================================
 * Three rounds were spent tuning this number against "the worst document the
 * budgets permit", on the assumption that such a worst case was bounded. It
 * is not. Measured on the real pipeline, both well inside every byte budget:
 *
 *   4.18 MB, 695 731 tags (`<w:p/>`)                     1 609 ms
 *   1.33 MB,      15 tags (120 000 attributes on one)   18 310 ms
 *   the same attribute shape x3                          51 s, exit 0
 *
 * The third line used to read "killed at ~28 s" and was used as evidence that
 * the heap ceiling ends such work. RE-MEASURED, it does not: that document
 * finishes, peaking at 171 MB against a 768 MB ceiling (macOS 51.0 s; Linux
 * container, 2 CPUs, 57 s). Attributes are quadratic in TIME and nearly free in
 * MEMORY, so nothing but this deadline was ever in a position to end it — which
 * is the whole point of the entry, and it is stronger, not weaker, for being
 * the only bound that applies.
 *
 * Attribute handling in `@xmldom/xmldom` is quadratic per element and carries
 * no `<`, so neither a byte cap nor a tag cap can see it — and there is no
 * reason to believe attributes are the last such dimension. So the deadline
 * does not derive from an acceptance budget; it IS the bound, and its job is
 * to end work of ANY shape.
 *
 * WHY 60 s, then. It is sized against what a legitimate document needs, with
 * room for a slow, busy machine — not against a worst case that does not
 * exist. Real documents measure 3-45 ms of parse here; the largest synthetic
 * document any budget admits is 1.6 s; and the same document has measured
 * 182 ms here and 16 804 ms on a loaded CI runner, ~92x, because the worker
 * runs at niceness 19 and is the first thing starved. 60 s covers a real CV
 * on a machine two orders of magnitude slower than this one.
 *
 * It costs nothing in API responsiveness — extraction is a detached job behind
 * a child process, nothing waits on it, and the event-loop cost of the
 * 18 310 ms attribute bomb measured 12 ms. The failure it prevents is the
 * expensive one: refusing a real CV because the machine was busy.
 *
 * THE TRADE, stated because it is real: at 60 s two slots clear ~2 pathological
 * documents a minute against an intake of 10/minute, so a sustained stream of
 * worst-case uploads can queue, and a queued extraction still holds its buffer.
 * The mitigations are that this is an internal tool behind auth, the size
 * budgets refuse the cheapest abusive shapes before a worker is started at
 * all, and typical documents finish in well under a second. Making the queue
 * itself bounded is tracked in task-resume-followups.
 *
 * Pinned by "an expensive document no budget can see is contained by the
 * sandbox" in the spec, which uses the attribute bomb — the shape that defeats
 * every acceptance budget — and asserts the two things that actually matter:
 * the event loop stays free, and the work is ended with a message a person can
 * act on. Deliberately no absolute wall-clock ceiling: that instrument moved
 * 180 ms -> 1 287 ms on THIS machine inside one minute.
 */
export const EXTRACTION_TIMEOUT_MS = 60_000

/**
 * Kernel-side CPU backstop (`ulimit -t`) for a starved JS timer.
 *
 * Deliberately above the wall clock: it is a backstop for a timer that never
 * fires, not a second, tighter deadline. Below it, the kernel would become the
 * usual killer and the readable timeout path would be dead code.
 *
 * Which is exactly why the spec INVERTS the two through `extract`'s seam: a
 * one-second CPU budget makes the kernel the killer on purpose, and that is the
 * only cheap way to reach the "killed, not timed out" branch with the mechanism
 * that really does the killing in production.
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
 *   - it does NOT reduce main-thread work, and it never did. This used to
 *     credit `MAX_DOCX_XML_BYTES`, a constant that does not exist under that
 *     name or any other — the thing that actually took the parse off this
 *     thread is the child process, which cut the worst continuous stall from
 *     33 336 ms to 12 ms even for a document no budget can measure.
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

/**
 * What the user is told when the SANDBOX ended the work, by whichever of its
 * mechanisms got there first.
 *
 * One string for all of them on purpose. From the person's side the deadline,
 * the CPU rlimit and the heap ceiling are the same event — "we gave up on this
 * document" — and it is not their business which of our limits fired. What
 * they need is that it is about complexity rather than corruption, and that
 * there is a way forward, which is why the paste-the-text route is in the
 * sentence. The specific limit goes to the log, where it can be acted on.
 *
 * Deliberately does NOT name a number of seconds: that made the message a
 * function of a test seam (`timeoutMs`), so a spec exercising the path with a
 * 300 ms budget produced "не уложился в 0.3 с" — true, and nonsense to a user.
 */
const TOO_COMPLEX_MESSAGE =
  'Документ слишком сложный для автоматической обработки. Вставьте текст резюме вручную.'

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
  async extract(
    buffer: Buffer,
    mime: ResumeSourceMime,
    // Test seam ONLY — production never passes either of these.
    //
    // BOTH ARE BUDGETS, NOT BEHAVIOUR. Each one shortens a limit the sandbox
    // already enforces so a spec can reach its consequence in a second instead
    // of waiting the real 60 s / 90 s; the deadline still fires from the same
    // timer and the CPU limit is still applied and enforced by the kernel. What
    // a spec must never do is FAKE the outcome — a stubbed `runSandboxed`
    // returning `{ code: null }` would exercise this file's `if` and prove
    // nothing about whether any limit can end real work.
    //
    // "SHORTENS" IS HELD BY CODE, NOT BY CONVENTION — see the clamp in
    // `runWorker`. Said here as a promise it was for one review round, and a
    // caller could have raised the CPU ceiling or, with a value no shell reads
    // as a number, removed it altogether.
    //
    // `cpuSeconds` exists because it is the only one of the sandbox's three
    // mechanisms that can be driven to a KILL cheaply and on any machine: the
    // deadline is wall-clock (`timeoutMs` covers it), and the heap ceiling
    // needs a document shaped to exhaust 768 MB, which this suite has been
    // burned by before (see the fixture-size note in the spec). A CPU-second
    // is a CPU-second on fast and slow hardware alike.
    options: { timeoutMs?: number; cpuSeconds?: number } = {},
  ): Promise<string> {
    if (mime !== RESUME_PDF_MIME && mime !== RESUME_DOCX_MIME) {
      throw new ResumeFileUnreadableError('Неподдерживаемый формат файла')
    }
    await this.acquireSlot()
    try {
      return mime === RESUME_PDF_MIME
        ? await this.extractFromPdf(buffer, options.timeoutMs, options.cpuSeconds)
        : await this.extractFromDocx(buffer, options.timeoutMs, options.cpuSeconds)
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

  private async extractFromPdf(
    buffer: Buffer,
    timeoutMs?: number,
    cpuSeconds?: number,
  ): Promise<string> {
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
      return normalizeExtractedText(
        await this.runWorker(buffer, RESUME_PDF_MIME, timeoutMs, cpuSeconds),
      )
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
  private async runWorker(
    buffer: Buffer,
    mime: ResumeSourceMime,
    timeoutMs: number = EXTRACTION_TIMEOUT_MS,
    cpuSeconds: number = EXTRACTION_CPU_SECONDS,
  ): Promise<string> {
    // ── THE SEAM MAY ONLY TIGHTEN THE LIMIT, NEVER LOOSEN IT ──────────────
    //
    // `cpuSeconds` reaches `ulimit -t` as a STRING in a shell, and a shell
    // rejects most of what a `number` can hold. `sandboxed-process.ts` sends
    // rlimit failures to /dev/null on purpose (a dev machine refusing a limit
    // must not fail the work), so a value the shell will not take does not
    // raise here — it silently starts the child with NO CPU LIMIT AT ALL:
    //
    //   NaN, Infinity, -1        `ulimit` refuses them        -> no limit
    //   1e21                     `String(1e21)` is "1e+21"    -> no limit
    //   100000, MAX_SAFE_INTEGER accepted verbatim            -> limit raised
    //
    // Every one of those is a valid `number`, so the signature stops none of
    // them. `timeoutMs` survives the same rubbish because a bad delay collapses
    // to 1 ms — it fails CLOSED. This one failed OPEN, which is the direction
    // that matters, so the production ceiling is applied here rather than
    // trusted to the caller: a test may ask for LESS CPU, never for more, and
    // anything that is not a positive integer is not an answer.
    const budget =
      Number.isInteger(cpuSeconds) && cpuSeconds > 0
        ? Math.min(cpuSeconds, EXTRACTION_CPU_SECONDS)
        : EXTRACTION_CPU_SECONDS

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
        timeoutMs,
        // No `addressSpaceKb`: RLIMIT_AS is meaningless for a V8 process and
        // was killing this worker. Memory is bounded by the heap cap above,
        // CPU by the kernel backstop below.
        cpuSeconds: budget,
        // Generous slack over the character cap: UTF-8 Cyrillic is two bytes a
        // character and the JSON envelope escapes some of them.
        maxStdoutBytes: RESUME_LIMITS.extractionRawChars * 8,
        maxStderrBytes: 4096,
      })

      if (result.timedOut) {
        throw new ResumeFileUnreadableError(TOO_COMPLEX_MESSAGE)
      }
      // EVERY WAY THE SANDBOX ENDS WORK MUST SAY THE SAME HUMAN THING.
      //
      // The deadline is only one of them: the CPU rlimit (`ulimit -t`) and the
      // V8 heap ceiling also kill the worker, and they arrive here as a signal
      // exit with empty stdout, not as `timedOut`. That path used to answer
      // "Не удалось прочитать файл резюме" — blaming the user's document for
      // hitting OUR limit, after making them wait ~28 s for it. Measured: the
      // three-element attribute bomb takes exactly this path.
      //
      // A SIGNAL exit (`code === null`) means something killed it, which is the
      // sandbox doing its job. A non-zero EXIT CODE means the worker itself
      // refused the file, which really is about the file.
      if (result.code === null || result.stdout === '') {
        this.logger.warn(
          `Extraction worker killed (code ${String(result.code)}): ${result.stderr.slice(0, 500)}`,
        )
        throw new ResumeFileUnreadableError(TOO_COMPLEX_MESSAGE)
      }
      if (result.code !== 0) {
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
   *
   * SAID PLAINLY, SO NO BUDGET COMMENT CAN BE READ AS DENYING IT: a part whose
   * first bytes look like media is charged to NO budget here. Eight bytes of
   * PNG header in front of a document body makes 14 MB of attribute bomb count
   * as 635 bytes and 9 tags. That is not a hole to be patched with a better
   * signature list — the previous three attempts were exactly that — it is the
   * reason the guarantee lives in the sandbox and not in the accounting.
   */
  private async extractFromDocx(
    buffer: Buffer,
    timeoutMs?: number,
    cpuSeconds?: number,
  ): Promise<string> {
    try {
      await inspectDocxZip(buffer)
    } catch (err: unknown) {
      throw new ResumeFileUnreadableError(
        err instanceof RangeError ? err.message : 'Не удалось прочитать DOCX-файл',
      )
    }

    try {
      return normalizeExtractedText(
        await this.runWorker(buffer, RESUME_DOCX_MIME, timeoutMs, cpuSeconds),
      )
    } catch (err: unknown) {
      if (err instanceof ResumeFileUnreadableError) throw err
      this.logger.warn(`DOCX extraction failed: ${err instanceof Error ? err.message : 'unknown'}`)
      throw new ResumeFileUnreadableError('Не удалось прочитать DOCX-файл')
    }
  }
}
