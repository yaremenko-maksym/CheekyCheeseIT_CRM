/**
 * AC1 (PDF and DOCX both extract) + AC2 (content decides the type, not the
 * name) + the DoS bounds: page count, real archive expansion, character cap.
 *
 * Fixtures are built in-process from real bytes (see src/test/resume-fixtures)
 * so the actual parsers run — a mocked parser would prove nothing about
 * whether `unpdf`/`mammoth` were wired correctly.
 *
 * NOTE ON CONTROL CHARACTERS: every control byte in this file is written as a
 * `\u0000`-style ESCAPE, never as a literal. A literal NUL makes git classify
 * the whole file as binary, and a binary spec has no reviewable diff — which is
 * exactly how a test file stops being a review artefact.
 */
import { tmpdir } from 'node:os'
import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { RESUME_DOCX_MIME, RESUME_LIMITS, RESUME_PDF_MIME } from '@crm/shared'
import * as sandboxedProcess from './sandboxed-process'
import {
  EXTRACTION_CPU_SECONDS,
  EXTRACTION_HEAP_MB,
  MAX_CONCURRENT_EXTRACTIONS,
  ResumeFileUnreadableError,
  ResumeTextExtractionService,
} from './resume-text-extraction.service'
import {
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_DOCX_PARSED_BYTES,
  MAX_PDF_CONTENT_BYTES,
  MAX_PDF_TEXT_OPERATORS,
  MAX_PDF_PAGES,
  capExtractedText,
  countTextOperators,
  detectResumeSourceMime,
  inspectDocxZip,
  inspectPdfContent,
  normalizeExtractedText,
} from './resume-source.util'
import {
  buildDocx,
  buildDocxDeclaringNoEntries,
  buildDocxDeflated,
  buildDocxWithMedia,
  buildDocxWithRenamedBody,
  buildDocxLyingAboutSize,
  buildDocxZipBomb,
  buildEmptyPdf,
  buildPdfSharedContentStream,
  buildPdfWithFlateImage,
  buildPdfWithRawContentStream,
  repeatedBuffer,
  buildPdfWithText,
  buildAttributeBombDocx,
  buildPerCharacterFormattedDocx,
  buildWordDensityDocx,
  buildZip,
} from '../test/resume-fixtures'

/**
 * Sample the event loop every 10 ms and report the worst gap.
 *
 * The whole point of the HIGH-1 finding was that the API stops answering while
 * a parser runs, so the assertion has to be about the LOOP, not about a return
 * value. A function-level assertion is exactly what let a 33-second stall pass
 * review.
 */
function startLagMeter() {
  const SAMPLE_MS = 10
  let last = performance.now()
  let worstStall = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = now - last - SAMPLE_MS
    if (lag > worstStall) worstStall = lag
    last = now
  }, SAMPLE_MS)
  timer.unref?.()
  return {
    stop: () => {
      // MEASURE THE FINAL GAP HERE, not only inside the interval.
      //
      // The interval callback is a MACROTASK; the `await` that follows the
      // blocking work resumes in a MICROTASK. So when the pattern is
      //
      //     const meter = startLagMeter(); await blockingWork(); meter.stop()
      //
      // the loop unblocks, the continuation runs first, `stop()` clears the
      // interval — and the callback that would have observed the gap never
      // fires. The meter then reports a serene `worstStall = 0` for work that
      // froze the process for the better part of a second (measured: 0 ms
      // reported for an 796 ms test).
      //
      // Every `worstStall` assertion in this file was therefore comparing 0
      // against a ceiling and could not fail. `last` still holds the time of
      // the last callback BEFORE the block, so the gap is simply computed once
      // more here, where it is finally visible.
      const finalLag = performance.now() - last - SAMPLE_MS
      if (finalLag > worstStall) worstStall = finalLag
      clearInterval(timer)
      return { worstStall }
    },
  }
}

const CONTENT_TYPES_FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const RELS_FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const SMALL_DOC_XML = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>резюме</w:t></w:r></w:p></w:body></w:document>`
const service = new ResumeTextExtractionService()

/**
 * ==========================================================================
 * CAN THIS KERNEL END A CHILD BY ITS CPU RLIMIT? — ANSWERED BY RUNNING IT
 * ==========================================================================
 * One test below needs the sandbox to KILL a worker rather than let it finish,
 * and a kill needs a limit the kernel actually applies. Not every kernel
 * applies every limit: this machine (macOS) accepts `ulimit -v` and then
 * reports `unlimited`, which is why `sandboxed-process.ts` swallows rlimit
 * failures in the first place.
 *
 * So the capability is MEASURED, not inferred:
 *
 *   - NOT from `process.platform` / `os.type()` — a name is a claim about a
 *     kernel, it is settable from the environment, and it would still be a
 *     guess on the platform we have never run on. The question here is
 *     "does a limit end a child", and the cheapest honest answer is to give a
 *     child a one-second CPU budget and look at how it came back.
 *   - FAIL-CLOSED: the probe must SEE a signal exit that is not the deadline
 *     before the test is allowed to run. Anything else — completed, non-zero
 *     exit, deadline, spawn failure — reads as "no mechanism" and skips
 *     LOUDLY, with the reason on stderr.
 *
 * This cannot silently disable the test where the mechanism exists, because
 * the probe IS the mechanism: on any kernel that enforces `ulimit -t` the
 * probe is killed and the test runs. Verified to run (not skip) on Linux —
 * the platform this ships on — and on macOS, which honours `ulimit -t` even
 * though it ignores `ulimit -v`.
 *
 * THE BURNER COUNTS ITS OWN CPU, NOT THE WALL CLOCK, and the first version of
 * this probe got that wrong: it spun `while (Date.now() < start + 5_000)`, on
 * the assumption that five seconds of spinning is five seconds of CPU. It is
 * not. Sandboxed work runs at niceness 19, so on a CI runner busy with the rest
 * of this suite the burner was starved, finished its five wall-seconds having
 * spent well under the one-second budget, exited 0 — and the gate concluded the
 * kernel does not enforce `ulimit -t` and skipped the test. Which is precisely
 * the failure this gate exists to prevent, arrived at from the other side: a
 * quiet skip on the platform that HAS the mechanism (observed on CI, run
 * 31529730272). `process.cpuUsage()` is the same clock `RLIMIT_CPU` is
 * accounted against, so the burner now keeps working until it has really spent
 * the CPU — however long the machine takes to give it.
 *
 * It costs one CPU-second where the limit holds, five where it does not.
 */
const cpuRlimitProbe = await sandboxedProcess.runSandboxed({
  bin: process.execPath,
  args: [
    '-e',
    // Burns until it has SPENT five CPU-seconds — five times the budget below,
    // so a kernel that enforces the limit always kills it first — then gives up
    // by itself, so a kernel that ignores the limit ends this probe rather than
    // hanging it.
    'const spent = () => { const u = process.cpuUsage(); return u.user + u.system };' +
      'const budget = spent() + 5_000_000;' +
      'let sink = 0;' +
      'while (spent() < budget) { for (let i = 0; i < 200_000; i += 1) sink += i }' +
      'if (sink < 0) process.exitCode = 1',
  ],
  cwd: tmpdir(),
  env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
  // Wall-clock backstop only. Starvation stretches WALL time without limit, so
  // this is deliberately far from the CPU budget above: it exists so a
  // pathological environment cannot hang collection, not as a second bound.
  timeoutMs: 300_000,
  cpuSeconds: 1,
  maxStdoutBytes: 0,
  maxStderrBytes: 256,
})

/**
 * A SIGNAL exit (`code === null`) that is NOT the deadline (`timedOut`) is the
 * kernel ending the process — the same shape `runWorker` reads in production.
 * A process that ran its five seconds out and exited 0 means the limit was
 * accepted and ignored.
 */
const CPU_RLIMIT_ENFORCED = cpuRlimitProbe.code === null && !cpuRlimitProbe.timedOut

if (!CPU_RLIMIT_ENFORCED) {
  // Loud on purpose, and specific about WHICH mechanism is missing and what
  // that costs in coverage — a quiet skip is how a suite starts reporting
  // green for work it never did.
  console.warn(
    '[resume-text-extraction.spec] пропущено: эта платформа не применяет ' +
      'ограничение CPU (`ulimit -t`) — процесс с бюджетом в одну секунду ' +
      `вернулся как code=${String(cpuRlimitProbe.code)}, timedOut=${String(cpuRlimitProbe.timedOut)} ` +
      'вместо смерти от сигнала. Ветка «воркер убит, а не истёк по времени» ' +
      'здесь непроверяема; на Linux она выполняется.',
  )
}

describe('detectResumeSourceMime (AC2 — bytes decide, not the filename)', () => {
  it('detects a real PDF', async () => {
    expect(detectResumeSourceMime(await buildPdfWithText(['hi']))).toBe(RESUME_PDF_MIME)
  })

  it('detects a real DOCX', () => {
    expect(detectResumeSourceMime(buildDocx(['hi']))).toBe(RESUME_DOCX_MIME)
  })

  it('rejects an executable renamed to .pdf (the AC2 case)', () => {
    // Mach-O / ELF-style header — the filename is irrelevant, only these bytes
    // are ever consulted.
    const fakePdf = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01])
    expect(detectResumeSourceMime(fakePdf)).toBeNull()
  })

  it('rejects a text file that merely mentions %PDF later on', () => {
    expect(detectResumeSourceMime(Buffer.from('hello %PDF-1.7 world', 'utf8'))).toBeNull()
  })

  it('rejects a plain zip that is not a Word document', () => {
    const zip = buildZip([{ name: 'notes.txt', data: Buffer.from('hello') }])
    expect(detectResumeSourceMime(zip)).toBeNull()
  })

  it('rejects an empty buffer', () => {
    expect(detectResumeSourceMime(Buffer.alloc(0))).toBeNull()
  })
})

describe('inspectDocxZip (zip-bomb guard)', () => {
  it('accepts a normal DOCX and reports declared AND measured expansion', async () => {
    const info = await inspectDocxZip(buildDocx(['hello']))
    expect(info.entries).toBe(3)
    expect(info.actualUncompressedBytes).toBeGreaterThan(0)
    expect(info.actualUncompressedBytes).toBeLessThan(MAX_DOCX_UNCOMPRESSED_BYTES)
    // A truthful archive: what it claims is what it really expands to.
    expect(info.actualUncompressedBytes).toBe(info.declaredUncompressedBytes)
  })

  it('rejects an archive that DECLARES a multi-GB expansion', async () => {
    await expect(inspectDocxZip(buildDocxZipBomb())).rejects.toBeInstanceOf(RangeError)
  })

  /**
   * MED-1. The declaration is the attacker's own testimony. This archive says
   * "128 bytes" and really expands to 4 MB — measured against a 1 MB budget so
   * the test stays fast while exercising the identical code path.
   *
   * MUTATION: drop the second (inflating) pass from `inspectDocxZip` and keep
   * only the declared-size sum — this test goes red, the rest of the file stays
   * green. That asymmetry is the point: nothing else here can tell the
   * difference between a claim and a fact.
   */
  it('rejects an archive that LIES DOWNWARDS about its expansion (real size is measured)', async () => {
    const liar = buildDocxLyingAboutSize(4 * 1024 * 1024)
    expect(liar.length).toBeLessThan(64 * 1024) // tiny on disk, as promised
    await expect(inspectDocxZip(liar, 1024 * 1024, 8 * 1024 * 1024)).rejects.toThrow(
      /реальный размер/,
    )
  })

  it('accepts the same archive when the budget genuinely covers it', async () => {
    const honestlySized = buildDocxLyingAboutSize(4 * 1024 * 1024)
    // Both budgets raised: this case is about MEASUREMENT (declared 128 B vs a
    // real 4 MB), not about the production XML cap, which is asserted above.
    const info = await inspectDocxZip(honestlySized, 8 * 1024 * 1024, 8 * 1024 * 1024)
    // Measured, not believed: the directory claimed 128 bytes for that entry.
    expect(info.actualUncompressedBytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(info.declaredUncompressedBytes).toBeLessThan(1024)
  })

  it('rejects an archive whose tail record claims it holds no entries', async () => {
    await expect(inspectDocxZip(buildDocxDeclaringNoEntries())).rejects.toBeInstanceOf(RangeError)
  })

  /**
   * Budget accounting, with a fixture that actually HAS media.
   *
   * The previous version of this test used an XML-only document, so the
   * "separately" in its name was untested: flipping the classifier to count
   * everything failed nothing. Media has to be present for the split to mean
   * anything.
   */
  it('excludes media from the parse budget but still counts it as memory', async () => {
    const withMedia = buildDocxWithMedia(['резюме'], 3 * 1024 * 1024)
    const info = await inspectDocxZip(withMedia)

    // 3 MB of image sits in the archive...
    expect(info.actualUncompressedBytes).toBeGreaterThan(3 * 1024 * 1024)
    // ...and none of it is charged to the parser.
    expect(info.actualParsedBytes).toBeLessThan(64 * 1024)
    expect(info.actualUncompressedBytes - info.actualParsedBytes).toBeGreaterThanOrEqual(
      3 * 1024 * 1024,
    )
  })

  /**
   * HIGH-1, round 4. `mammoth` finds the main part through `_rels/.rels` and
   * takes any target that exists, so a by-extension budget is bypassed by
   * renaming the body. A decoy `word/document.xml` keeps detection happy.
   *
   * Measured before the fix: the guard saw 863 B, the parser read 17.3 MB,
   * 5 819 ms of continuous stall, and the upload was ACCEPTED.
   *
   * This case is kept as the historical regression; the general rule it turned
   * out to need is asserted in "the parse budget is decided by content, never by
   * name" below — because fixing this ONE name is what led straight to the next
   * bypass (`word/document.png`).
   *
   * MUTATION: make `isInertMediaContent` return `true` unconditionally (count
   * nothing), or reintroduce any filename check, and this goes red.
   */
  it('counts a renamed document body — the extension is the attacker’s choice', async () => {
    const disguised = buildDocxWithRenamedBody(Array.from({ length: 300_000 }, (_, i) => `p${i}`))
    // Still a DOCX as far as type detection is concerned.
    expect(detectResumeSourceMime(disguised)).toBe(RESUME_DOCX_MIME)
    await expect(inspectDocxZip(disguised)).rejects.toThrow(/Содержимое DOCX больше/)
  })

  it('counts an unknown extension in full rather than assuming it is inert', async () => {
    const small = buildDocxWithRenamedBody(['короткое резюме'], 'word/document.bin')
    const info = await inspectDocxZip(small)
    // Body + decoy + rels + content-types are all charged.
    expect(info.actualParsedBytes).toBe(info.actualUncompressedBytes)
  })

  /**
   * ==========================================================================
   * THE CLASS, not the three names that have been found so far.
   * ==========================================================================
   * This budget has now been bypassed twice, and both times the fix was a
   * better list of filenames:
   *
   *   `word/document.xml` counted by extension -> body moved to `.dat`
   *   `.dat` counted after inverting the rule  -> body moved to `.png`
   *
   * Both are the same defect. The guard decided from the NAME (which the
   * attacker writes) while `mammoth` decides from the `_rels/.rels` graph and
   * the bytes. A test that lists the three known names would have passed
   * before the `.png` bypass existed and will pass before the next one does.
   *
   * So the property asserted is the DECISION SIGNAL itself: identical bytes
   * must be accounted identically under every name. Any name-based exclusion —
   * old, new, or invented next month — breaks this, because it makes the count
   * a function of something other than the content.
   */
  describe('the parse budget is decided by content, never by name', () => {
    // Deliberately spanning every name-shaped trick tried so far AND the ones
    // not tried: a media extension, a font extension, upper case, no extension
    // at all, a media DIRECTORY, and a double extension.
    const DISGUISES = [
      'word/document.xml',
      'word/document.dat',
      'word/document.png',
      'word/document.JPEG',
      'word/document.woff2',
      'word/media/image1.png',
      'word/document.xml.png',
      'word/document',
    ]

    it('gives one body the same parsed-byte count under every name', async () => {
      const body = Array.from({ length: 400 }, (_, i) => `пункт резюме номер ${i}`)

      const counts: number[] = []
      for (const name of DISGUISES) {
        const doc = buildDocxWithRenamedBody(body, name)
        const info = await inspectDocxZip(doc)
        // `_rels/.rels` is itself a counted part and literally contains the
        // body's name once (`Target="..."`), so a longer name legitimately adds
        // its own length to the total. Subtracting it isolates the only thing
        // under test — what the BODY was charged — instead of blurring the
        // assertion into a tolerance that would also hide a real drift.
        counts.push(info.actualParsedBytes - name.length)
      }

      // Non-vacuity: the body is genuinely being counted, not uniformly zero.
      expect(Math.min(...counts)).toBeGreaterThan(5_000)
      // The property: nothing else about the name reaches the accounting.
      expect(new Set(counts).size).toBe(1)
    })

    it('refuses an over-budget body under every name', async () => {
      const body = Array.from({ length: 200_000 }, (_, i) => `p${i}`)
      for (const name of DISGUISES) {
        const doc = buildDocxWithRenamedBody(body, name)
        await expect(inspectDocxZip(doc), `body hidden at ${name} was accepted`).rejects.toThrow(
          /Содержимое DOCX больше/,
        )
      }
    })

    /**
     * The converse, which is what keeps the rule honest rather than merely
     * strict: a part is excluded because its BYTES are media, so a real image
     * stays excluded even when it is called `document.xml` — and, crucially, a
     * document stays counted even when it is called `image1.png`.
     *
     * Without this half, "count everything" would pass the tests above and
     * reject every real CV that carries a photo.
     */
    /**
     * The DEFLATED path, which the sibling test does not reach.
     *
     * `buildDocxWithMedia` stores its image uncompressed, so classification
     * there happens in `measureEntry`'s STORED branch — reading the magic
     * straight out of the archive. A real Word document deflates its parts, and
     * that goes through `inflateAndClassify`, which decides from the first
     * decompressed CHUNK instead. Two different code paths, one of them
     * previously untested: a classifier that worked only on stored entries
     * would have passed every test here while charging every real image in
     * every real CV to the parse budget.
     */
    it('classifies a DEFLATED image by content too, not only a stored one', async () => {
      const png = Buffer.alloc(2 * 1024 * 1024)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
      for (let i = 8; i < png.length; i += 1) png[i] = (i * 2654435761) % 251

      const deflatedMedia = buildZip([
        { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_FIXTURE, 'utf8') },
        { name: '_rels/.rels', data: Buffer.from(RELS_FIXTURE, 'utf8') },
        {
          name: 'word/document.xml',
          data: Buffer.from(SMALL_DOC_XML, 'utf8'),
          deflate: true,
        },
        // The same bytes as the stored case, but compressed — the path a real
        // .docx actually takes.
        { name: 'word/media/image1.png', data: png, deflate: true },
      ])

      const info = await inspectDocxZip(deflatedMedia)
      expect(info.actualUncompressedBytes).toBeGreaterThan(2 * 1024 * 1024)
      // Still not charged to the parser, decided from the decompressed prefix.
      expect(info.actualParsedBytes).toBeLessThan(64 * 1024)
    })

    it('excludes a real image under any name, and only a real image', async () => {
      const withPhoto = buildDocxWithMedia(['короткое резюме'], 2 * 1024 * 1024)
      const info = await inspectDocxZip(withPhoto)

      // The photo is not charged to the parse budget...
      expect(info.actualUncompressedBytes - info.actualParsedBytes).toBeGreaterThan(1024 * 1024)
      // ...and it is the BYTES that earned that, not the `.png` in its path.
      const disguisedPhoto = buildDocxWithMedia(
        ['короткое резюме'],
        2 * 1024 * 1024,
        'word/photo.xml',
      )
      const disguisedInfo = await inspectDocxZip(disguisedPhoto)
      expect(disguisedInfo.actualParsedBytes).toBe(info.actualParsedBytes)
    })
  })

  /**
   * The PDF screen runs on the main thread BY DESIGN — it decides whether
   * paying for a child process is worth it, so it can never be inside one. That
   * makes its own cost a hard requirement, and it failed that requirement
   * invisibly: `text.match(/…/g).length` MATERIALISES EVERY MATCH before
   * anything is compared, so a 32 KB PDF carrying ~10.8 million operators built
   * a ten-million-element array — 731 ms of matching, 743 ms of event-loop lag,
   * 1 450 ms over live HTTP at four uploads against a limit of two — and only
   * then refused the file. Rejected, yes; frozen first.
   *
   * The property that fixes it is BOUNDED WORK, and that is what is asserted
   * here rather than a duration. A timing test was tried first and could not be
   * made to bite: the byte cap (32 MB decoded) trips before a fixture can carry
   * ten million operators, so the expensive path was never reached and the
   * `.match()` mutation passed. A test that cannot fail is worse than none.
   *
   * MUTATION: restore `.match(...).length` and this goes red immediately — it
   * returns the true total, not the cap.
   */
  it('stops counting operators at the limit instead of collecting them all', () => {
    // Far more operators than the limit, in one stream.
    const stream = Buffer.from(' Tj'.repeat(500_000), 'latin1')

    expect(countTextOperators(stream, 80_000)).toBe(80_001)
    // The bound follows the limit rather than the input.
    expect(countTextOperators(stream, 10)).toBe(11)
    // An honest document is counted exactly.
    expect(countTextOperators(Buffer.from(' Tj Tj TJ', 'latin1'), 80_000)).toBe(3)
  })

  /**
   * ==========================================================================
   * THE COST of the PDF screen, measured — not the value it returns.
   * ==========================================================================
   * `inspectPdfContent` runs on the main thread BY DESIGN (it decides whether
   * paying for a child process is worth it), so its own cost is a hard
   * requirement. The bounded-count test above asserts the RETURN VALUE; these
   * two assert the thing that actually mattered.
   *
   * Measured here (dev machine):
   *
   *   input                                    decoded   with early exit   with `.match()`
   *   ' Tj'    x 10 000 000  (dense)            28.6 MB          ~10 ms          ~884 ms
   *   ' TjX'   x  8 000 000  (zero operators)   32.0 MB          ~70 ms           ~64 ms
   *
   * The second line is the honest part, and it corrects a claim I made earlier.
   * The early exit only fires once matches EXCEED the limit; an input with
   * FEWER matches never reaches it. So the work is
   *
   *   O( min( offset of the 80 001st match, decoded bytes ) )
   *
   * and the floor under the second term is `MAX_PDF_CONTENT_BYTES`, NOT
   * `MAX_PDF_TEXT_OPERATORS`. Boundedness rests on the SIZE cap. That constant
   * is documented as a memory ceiling, which is why its comment now also says
   * it caps CPU — raise it for memory reasons and this stall grows silently.
   */
  /**
   * FUNCTIONAL, always on: a dense stream is refused, and a stream with no
   * operators is accepted with a count of zero. No clock involved.
   *
   * The timing counterpart is opt-in below, and putting it there is not a
   * retreat — it is this file's own policy, written three screens above
   * (`RESUME_PERF`): event-loop lag inside a parallel runner is a property of
   * the machine, so always-on timing assertions are kept only where the margin
   * is four orders of magnitude. My earlier always-on ceilings had 7x locally
   * and LESS THAN 1x on CI, which is exactly the flake that policy exists to
   * prevent — and it went red on the required check, taking six unrelated tests
   * with it through memory pressure.
   */
  it('refuses a dense operator stream and accepts an operator-free one', async () => {
    // Sized to CROSS THE THRESHOLD, not to fill the cap. These are functional
    // assertions — "is it refused / is the count zero" — and a cap-sized
    // fixture buys them nothing while costing ~60 MB of buffers per worker.
    // That mattered: the 32 MB versions pushed this suite into memory pressure
    // and the extraction CHILD PROCESSES were killed ("worker exited null"),
    // failing six unrelated tests that had nothing to do with the change. The
    // size-bounded characterisation lives in the opt-in test below, where one
    // run at a time can afford it.
    const dense = buildPdfWithRawContentStream(
      repeatedBuffer(' Tj', (MAX_PDF_TEXT_OPERATORS + 1000) * 3),
    )
    await expect(inspectPdfContent(dense, 1)).rejects.toThrow(/слишком много текстовых операций/)

    // ' TjX' never matches (a delimiter must follow `Tj`), so the early exit
    // never fires and every byte is walked — the residual cost that the
    // CONTENT-SIZE cap, and only that cap, bounds.
    const sparse = buildPdfWithRawContentStream(repeatedBuffer(' TjX', 400_000))
    const info = await inspectPdfContent(sparse, 1)
    expect(info.textOperators).toBe(0)
  }, 120_000)

  /**
   * MED-1 — the enforcement the constant's comment CLAIMED and did not have.
   *
   * `MAX_PDF_CONTENT_BYTES` bounds CPU as well as memory (the sparse scan is
   * O(decoded bytes) and nothing else caps it), and its comment says so — but
   * raising it 32 MB -> 128 MB left the entire suite green, because the fixture
   * was pinned to a literal 32 MB. A comment that names a test which does not
   * actually hold the value is worse than silence: it invites exactly the
   * "memory headroom" change it warns against.
   *
   * This is that test. It does not measure anything; it refuses a silent raise
   * and points at the measurement to run first.
   */
  /**
   * THE WORKER'S MEMORY BOUND, exercised rather than merely configured.
   *
   * `EXTRACTION_ADDRESS_SPACE_KB` (`ulimit -v`, 1 GiB) had no test at all, and
   * was visible only when it misfired — which it did, for three rounds, as
   * `Extraction worker exited null: std::bad_alloc` on 23-161 KB fixtures. It
   * was never a memory bound: it capped ADDRESS SPACE, and a do-nothing Node
   * process reserves ~399 GB of that against ~31 MB of real use. On the runtime
   * where an honest document needs 512-768 MB it meant a legitimate 40-page CV
   * could fail with a message blaming the user's file for the machine's load.
   *
   * Two assertions, because the bound has two halves that fail differently:
   * the honest document must GO THROUGH, and the cap must be the kind of cap
   * that bounds real heap.
   */
  /**
   * ==========================================================================
   * WHAT ACTUALLY CONTAINS AN EXPENSIVE DOCUMENT — AND IT IS NOT A BUDGET
   * ==========================================================================
   * The test that stood here compared `MAX_DOCX_PARSED_BYTES` against
   * `EXTRACTION_TIMEOUT_MS` by measuring "the worst document the budgets
   * permit" and asserting the deadline sat above it. It failed on CI, and the
   * three previous fixes each moved one of the two constants.
   *
   * THE PREMISE WAS WRONG. There is no bounded worst case for the budgets to
   * permit. Measured through this pipeline, everything inside every budget:
   *
   *   4.18 MB, 695 731 tags (`<w:p/>`)                     1 609 ms
   *   1.33 MB,      15 tags (120 000 attributes on one)   18 310 ms
   *
   * The expensive one is 3x SMALLER and carries 15 tags, because attribute
   * handling in `@xmldom/xmldom` is quadratic per element and attributes hold
   * no `<`. A byte budget missed node count; a node budget misses attributes;
   * a parser with several superlinear paths will always have one dimension
   * more than the scalar chosen to bound it. Chasing a fourth unit would be
   * the same move that failed three times.
   *
   * So this test asserts what is actually true and actually load-bearing: the
   * SANDBOX contains work of any shape. The document below defeats every
   * acceptance budget by construction, and the two properties asserted are the
   * ones a person and an API respectively care about — the event loop stays
   * free, and the work ends with something actionable to read.
   *
   * No wall-clock ceiling anywhere in here: that instrument moved 180 ms ->
   * 1 287 ms on this machine inside one minute, which is what made the
   * previous version of this test a coin flip on a busy runner.
   */
  it('contains an expensive document no budget can see', async () => {
    // 120 000 attributes on ONE element: ~15 tags, 1.3 MB, ~18 s of parse.
    const unbudgetable = buildAttributeBombDocx(120_000)

    // Non-vacuity FIRST: prove every acceptance budget really does wave this
    // through, so the containment below is doing the work rather than a budget
    // quietly catching it (which is what made the old fixture prove nothing).
    const info = await inspectDocxZip(unbudgetable)
    expect(info.actualParsedBytes).toBeLessThan(MAX_DOCX_PARSED_BYTES)
    expect(info.actualUncompressedBytes).toBeLessThan(MAX_DOCX_UNCOMPRESSED_BYTES)

    // THE GUARANTEE: the API thread stays free while it parses. Sampling the
    // loop is the only assertion that speaks to "does the API keep answering",
    // and it is a property of isolation, not of any budget.
    const meter = startLagMeter()
    const outcome = await service
      .extract(unbudgetable, RESUME_DOCX_MIME, { timeoutMs: 2_000 })
      .then(() => 'resolved')
      .catch((e: unknown) => (e as Error).message)
    const { worstStall } = meter.stop()

    // Generous by two orders of magnitude against the 33 336 ms stall that the
    // in-process version of this parser produced — this documents a class, not
    // a budget, so it does not need to be tight to be meaningful.
    expect(worstStall).toBeLessThan(500)

    // UNCONDITIONALLY, because the outcome is not in doubt: this document needs
    // ~18 s and the deadline above is 2 s. Wrapping these in `if (outcome !==
    // 'resolved')` would have been a test that quietly asserts nothing on the
    // day the containment breaks — which is the one day it matters.
    expect(outcome).toMatch(/слишком сложный/)
    expect(outcome).not.toMatch(/Не удалось прочитать/)
  }, 180_000)

  /**
   * EVERY WAY THE SANDBOX ENDS WORK SAYS THE SAME HUMAN THING.
   *
   * The deadline is only one of its mechanisms; the CPU rlimit and the heap
   * ceiling arrive as a SIGNAL exit with empty stdout instead. That path used
   * to answer "Не удалось прочитать файл резюме" — blaming the document for
   * hitting our limit. Both paths are exercised here because they are different
   * branches, and the bug was that only one of them had been thought about.
   *
   * ==========================================================================
   * HOW PATH 2 IS REACHED, AND WHY IT IS NO LONGER A RACE AGAINST THE MACHINE
   * ==========================================================================
   * It used to feed the parser three attribute bombs and wait for the sandbox
   * to end them, on the stated ground that "three attribute bombs exhaust
   * EXTRACTION_HEAP_MB". MEASURED, THEY DO NOT — and nothing else killed them
   * either:
   *
   *   macOS, this laptop        exit 0 after 51.0 s, peak RSS 171 MB
   *   Linux container, 2 CPUs   exit 0 after 57 s
   *
   * 171 MB against a 768 MB ceiling: that document is expensive in TIME, and
   * attributes cost almost nothing in memory, so the heap cap was never within
   * reach. The CPU rlimit (90 s) sits above the deadline (60 s) by design, so
   * it could not fire first either. The only mechanism left was the 60 s
   * deadline — which meant the test asserted "this machine needs more than a
   * minute for this document". CI is slower than a minute, so it passed there;
   * this laptop needs 51 s, so it failed here, four runs out of four. The same
   * test would have started failing on CI the day the runners got faster, and
   * a green CI was reporting Path 2 as covered when what actually ran was
   * Path 1 a second time.
   *
   * So Path 2 now drives the CPU rlimit — the mechanism whose whole job is
   * killing work the timer did not — through the same kind of shortened budget
   * Path 1 already uses for the deadline. The kernel still does the killing,
   * on the real worker, with the real `runSandboxed`; only the number is
   * smaller. And a CPU-second means the same thing on every machine, which is
   * exactly what the wall clock did not.
   */
  it.skipIf(!CPU_RLIMIT_ENFORCED)(
    'says the same actionable thing however the sandbox ended the work',
    async () => {
      const bomb = buildAttributeBombDocx(60_000)

      // Path 1 — the wall-clock deadline (`timedOut`).
      await expect(service.extract(bomb, RESUME_DOCX_MIME, { timeoutMs: 50 })).rejects.toThrow(
        /слишком сложный/,
      )

      // NON-VACUITY, from the probe that gated this test: the mechanism about
      // to be used really does end a child, and it ends it as a SIGNAL exit
      // that is not the deadline — the one shape `runWorker` must map. Without
      // this, "killed" below could quietly become a second timeout again.
      expect(cpuRlimitProbe.code).toBeNull()
      expect(cpuRlimitProbe.timedOut).toBe(false)

      // Path 2 — the worker KILLED rather than timed out, which is what the
      // heap ceiling and the CPU rlimit look like from here: a signal exit with
      // empty stdout, never `timedOut`. Triggered for REAL — the kernel sends
      // the signal, against the actual extraction worker — rather than
      // simulated by stubbing the sandbox, because the branch only matters if
      // a real mechanism reaches it.
      //
      // WHICH BRANCH RAN IS OBSERVED, NOT ASSUMED. Both paths end in the same
      // sentence — that is the point of this test — so the message alone cannot
      // tell them apart, and the previous version of Path 2 spent months being
      // the deadline in disguise for exactly that reason. Only the kill branch
      // logs, so the log is the discriminator, and it is one no amount of
      // machine slowness can move. The deadline is pushed far out of the way on
      // top of that, so the CPU limit is overwhelmingly the thing that fires.
      const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      let killed: string
      // Read INSIDE the try: `mockRestore` also resets the recorded calls, so a
      // snapshot taken after it is always empty — and an empty snapshot would
      // read as "the kill branch never ran".
      let logged = ''
      try {
        killed = await service
          .extract(bomb, RESUME_DOCX_MIME, { cpuSeconds: 1, timeoutMs: 150_000 })
          .then(() => 'resolved')
          .catch((e: unknown) => (e as Error).message)
        logged = warned.mock.calls.flat().join(' ')
      } finally {
        warned.mockRestore()
      }
      expect(killed).toMatch(/слишком сложный/)
      expect(logged).toMatch(/Extraction worker killed \(code null\)/)

      // The message must not depend on the test seam: a 50 ms budget once
      // produced "не уложился в 0.05 с", which is true and useless to a user.
      await expect(service.extract(bomb, RESUME_DOCX_MIME, { timeoutMs: 50 })).rejects.not.toThrow(
        /0\.05|50 с/,
      )

      // ...and it must not start naming the CPU budget either, for the same
      // reason: "1 с" would be the seam talking, not the limit that ended a
      // real upload.
      expect(killed).not.toMatch(/1 с|Не удалось прочитать/)
    },
    180_000,
  )

  /**
   * THE PRODUCT DEFECT A TAG BUDGET WOULD HAVE SHIPPED.
   *
   * Per-character formatting — every character in its own run with its own
   * run-properties — is what a PDF-to-Word conversion routinely produces. It
   * costs 9 600 tags a page, so the 120 000-tag budget of the previous round
   * refused a THIRTEEN-page CV: measured against that exact code, twelve pages
   * (115 216 tags) was the largest it accepted. The fixture below uses twenty
   * so the guard keeps biting rather than sitting on the boundary.
   *
   * This is the regression guard: real documents of awkward shape are
   * accepted, and the only thing that may refuse a document is its SIZE.
   */
  it('accepts a per-character-formatted CV, whatever its tag count', async () => {
    const converted = buildPerCharacterFormattedDocx(20)
    const info = await inspectDocxZip(converted)

    // It really is the awkward shape, not a token fixture.
    expect(info.actualParsedBytes).toBeLessThan(MAX_DOCX_PARSED_BYTES)
    const text = await service.extract(converted, RESUME_DOCX_MIME)
    expect(text.length).toBeGreaterThan(1_000)
  }, 180_000)

  /**
   * WHAT THIS TEST DELIBERATELY NO LONGER CLAIMS, and the finding behind it.
   *
   * It used to measure a 60 000-paragraph synthetic document, because that is
   * the densest thing `MAX_DOCX_PARSED_BYTES` admits. Measured cost of that
   * shape:
   *
   *   development laptop      ~0.65 s
   *   CI runner, under load   38.5 s      — about sixty times slower
   *
   * No deadline that also protects the API can cover it, and it should not:
   * that shape is pathological, and being killed is the correct outcome for it.
   *
   * THE REAL LESSON IS THAT THE BYTE BUDGET DOES NOT BOUND PARSE COST. Cost
   * tracks the number of XML NODES; `MAX_DOCX_PARSED_BYTES` counts BYTES. Two
   * documents of identical size differ by ~60x in parse time depending on how
   * many paragraphs those bytes are cut into — so the guard admits documents
   * whose cost it cannot see. That is the same "two bounds never compared"
   * shape as the deadline itself, one level down, and a byte cap cannot be
   * tuned into fixing it; it needs a node-count bound. Recorded for
   * task-resume-followups rather than attempted here.
   *
   * Meanwhile the damage is contained by design: such a document is killed at
   * the deadline in a child process, costs one failed upload, and never touches
   * the event loop.
   */
  it('kills a paragraph-dense document rather than letting it run for ever', async () => {
    const pathological = buildDocxDeflated(Array.from({ length: 60_000 }, (_, i) => `p${i}`))
    const impatient = new ResumeTextExtractionService()

    // 50 ms stands in for "whatever the deadline is, it ends". Shorter than
    // any machine can parse this document, so the assertion is about the
    // deadline PATH, not about a duration — the real one is 60 s and this test
    // is not going to wait for it. (1 s was tried first and the laptop finished
    // the parse inside it, which would have made this pass for the wrong
    // reason on fast hardware and fail on slow.)
    const started = Date.now()
    await expect(
      impatient.extract(pathological, RESUME_DOCX_MIME, { timeoutMs: 50 }),
    ).rejects.toThrow(/слишком сложный/)
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  /**
   * TYPICAL documents must clear faster than intake. Pathological ones need not,
   * and pretending otherwise is what made this assertion wrong the first time.
   *
   * It previously compared the DEADLINE against the intake rate and concluded
   * capacity was sufficient — true only while the deadline was 10 s, and the
   * deadline had to be 60 s because the worst permitted document takes over
   * 10 s on a CI-class machine. Written that way, the assertion would have
   * pushed the deadline back down to a value that kills legitimate uploads: a
   * test enforcing the wrong side of a real trade.
   *
   * What is actually required is that ORDINARY resumes do not queue. That is a
   * property of their measured cost, not of the timeout, so it is measured.
   * The worst-case queue behaviour is a known, stated trade — see the comment
   * on EXTRACTION_TIMEOUT_MS and task-resume-followups.
   */
  it('clears an ordinary resume far faster than uploads arrive', async () => {
    const ordinary = buildWordDensityDocx(2) // a normal two-page CV

    const started = Date.now()
    await expect(service.extract(ordinary, RESUME_DOCX_MIME)).resolves.toBeTypeOf('string')
    const cost = Date.now() - started

    // Intake is throttled at 10/min (resumes.controller.ts), i.e. one every 6 s
    // per uploader. Two slots at this cost clear far more than that, so an
    // ordinary queue drains rather than grows — on whatever machine this runs.
    const perMinute = (60_000 / cost) * MAX_CONCURRENT_EXTRACTIONS
    expect(perMinute).toBeGreaterThan(10)
  }, 120_000)

  it('extracts an honest large document within the worker’s memory bound', async () => {
    // The same 40-page-at-real-Word-density document AC5 uses — the case the
    // 1 GiB address-space cap was killing.
    const academicCv = buildWordDensityDocx(40)
    const text = await service.extract(academicCv, RESUME_DOCX_MIME)
    expect(text.length).toBeGreaterThan(1000)
  }, 120_000)

  it('bounds the worker with a V8 heap cap, not with RLIMIT_AS', () => {
    // A heap cap is enforced against real usage and surfaces as a catchable JS
    // OOM; `ulimit -v` is enforced against reservations and aborts in C++.
    expect(EXTRACTION_HEAP_MB).toBeGreaterThanOrEqual(768)
    expect(`--max-old-space-size=${EXTRACTION_HEAP_MB}`).toMatch(/^--max-old-space-size=\d+$/)
  })

  it('pins MAX_PDF_CONTENT_BYTES — raising it also raises a main-thread stall', () => {
    expect(MAX_PDF_CONTENT_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024)
    // If you are here because you raised it: the scan cost grows linearly with
    // this number, on the request-serving thread. Re-run the opt-in
    // characterisation (`RESUME_PERF=1`) on a quiet machine, put the new figure
    // in the constant's comment, and only then move this bound.
  })

  /**
   * Opt-in characterisation: `RESUME_PERF=1 pnpm --filter @crm/api test
   * resume-text-extraction`. Run it on a quiet machine when changing the
   * counter or `MAX_PDF_CONTENT_BYTES`; it is not a gate.
   *
   * Recorded from an opt-in run after switching to the byte scan — the previous
   * numbers in this file were taken before the parser moved to a child process
   * and before the scan replaced the regex, and they were wrong by an order of
   * magnitude on CI hardware. That is why the always-on assertions above carry
   * no clock at all.
   */
  it.skipIf(process.env['RESUME_PERF'] !== '1')(
    'screens a cap-sized operator-free stream without a visible stall',
    async () => {
      // Sized FROM the constant, so this stays a measurement OF the cap rather
      // than of a number that once equalled it.
      const sparse = buildPdfWithRawContentStream(
        repeatedBuffer(' TjX', MAX_PDF_CONTENT_BYTES - 1_000_000),
      )

      const meter = startLagMeter()
      await inspectPdfContent(sparse, 1)
      const { worstStall } = meter.stop()

      // Generous on purpose: this documents an order of magnitude, not a budget.
      expect(worstStall).toBeLessThan(200)
    },
    120_000,
  )

  it('refuses a document whose parsable parts exceed the budget', async () => {
    const dense = buildDocxDeflated(Array.from({ length: 200_000 }, (_, i) => `p${i}`))
    await expect(inspectDocxZip(dense)).rejects.toThrow(/Содержимое DOCX больше/)
  })

  it('names the cap that was hit, so the advice is actionable', async () => {
    const dense = buildDocxDeflated(Array.from({ length: 200_000 }, (_, i) => `p${i}`))
    await expect(inspectDocxZip(dense)).rejects.toThrow(/Содержимое DOCX больше 4 MB/)
  })

  /**
   * Calibration guard. These are the counted-byte sizes measured across 14 real
   * Word documents (max 539 KB); the budget must stay clear of them by a wide
   * margin or long real CVs start bouncing, which is what a fixture-derived
   * 1 MB cap did.
   */
  it('leaves real Word documents a wide margin', async () => {
    const LARGEST_REAL_WORD_DOC_BYTES = 552_161
    expect(MAX_DOCX_PARSED_BYTES).toBeGreaterThan(LARGEST_REAL_WORD_DOC_BYTES * 5)
  })

  it('still accepts a realistic resume with room to spare', async () => {
    const realistic = buildDocxDeflated([
      'Иван Петров — синьор-разработчик',
      ...Array.from({ length: 120 }, (_, i) => `Достижение ${i}: снизил задержку сервиса на 40%.`),
    ])
    const info = await inspectDocxZip(realistic)
    expect(info.actualParsedBytes).toBeLessThan(MAX_DOCX_PARSED_BYTES / 10)
  })

  it('rejects bytes with no zip structure at all', async () => {
    await expect(inspectDocxZip(Buffer.from('not a zip at all, really'))).rejects.toBeInstanceOf(
      RangeError,
    )
  })
})

describe('ResumeTextExtractionService.extract', () => {
  it('AC1: extracts text from a PDF', async () => {
    const pdf = await buildPdfWithText(['Ivan Petrov', 'Senior Engineer at Acme', '2019-2024'])
    const text = await service.extract(pdf, RESUME_PDF_MIME)
    expect(text).toContain('Ivan Petrov')
    expect(text).toContain('Senior Engineer at Acme')
  })

  it('AC1: extracts text from a DOCX', async () => {
    const docx = buildDocx(['Иван Петров', 'Синьор-разработчик, Acme', '2019–2024'])
    const text = await service.extract(docx, RESUME_DOCX_MIME)
    expect(text).toContain('Иван Петров')
    expect(text).toContain('Синьор-разработчик, Acme')
  })

  it('returns EMPTY text for a scanned/image-only PDF (caller turns this into NO_TEXT)', async () => {
    const text = await service.extract(await buildEmptyPdf(1), RESUME_PDF_MIME)
    expect(text.trim()).toBe('')
  })

  it('refuses a PDF with more pages than the cap', async () => {
    const huge = await buildEmptyPdf(MAX_PDF_PAGES + 1)
    await expect(service.extract(huge, RESUME_PDF_MIME)).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
  })

  it('refuses a zip-bomb DOCX before inflating anything', async () => {
    await expect(service.extract(buildDocxZipBomb(), RESUME_DOCX_MIME)).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
  })

  it('refuses a corrupt PDF with a clean error rather than crashing', async () => {
    const corrupt = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0x01, 0x02])])
    await expect(service.extract(corrupt, RESUME_PDF_MIME)).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
  })

  /**
   * HIGH-1, end to end — and measured on the PATH, not on a helper.
   *
   * The previous version of this test built a 600 000-character document and
   * asserted the returned string was capped. It passed while the endpoint was
   * still freezing for half a minute, because the character cap runs AFTER
   * `mammoth` and the attack is not made of characters: it is a million tiny
   * paragraphs, 165 KB on disk, that pass every byte/type/page gate and cost
   * 33 336 ms of uninterrupted main-thread stall inside the parser.
   *
   * So this test measures what actually hurt: event-loop stall across the real
   * extract() call.
   *
   * MUTATION: raise `MAX_DOCX_PARSED_BYTES` to `MAX_DOCX_UNCOMPRESSED_BYTES`
   * and this goes red (measured 8 876 ms stall at 24 MB of parsable parts).
   */
  it('the paragraph-bomb is refused without stalling the event loop', async () => {
    // 300 000 paragraphs: ~15 MB of XML — comfortably inside the 20 MB TOTAL
    // cap, so only the XML cap can refuse it. (The reviewer's 1 000 000-paragraph
    // file behaves the same and is refused by both; this size keeps the failure
    // mode legible when the cap is mutated away instead of hanging the runner.)
    const bomb = buildDocxDeflated(Array.from({ length: 300_000 }, (_, i) => `p${i}`))
    const meter = startLagMeter()
    await expect(service.extract(bomb, RESUME_DOCX_MIME)).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
    const { worstStall } = meter.stop()
    // Measured after the fix: 1 ms wall, 0 ms stall — the archive is refused
    // from its metadata and the 58 MB body is never inflated.
    expect(worstStall).toBeLessThan(250)
  }, 120_000)

  /**
   * What the cap buys, asserted FUNCTIONALLY: the densest document the budget
   * permits is accepted, and one step past it is refused.
   *
   * The timing counterpart lives below and is opt-in, deliberately. Event-loop
   * lag measured inside a parallel test runner is a property of the machine,
   * not of the code: the suite spreads across workers, so a document's measured
   * stall moved by 3-5x between runs on the same commit and failed roughly one
   * run in three whether the ceiling was absolute or relative to a reference.
   * A test that red-lights a third of the time teaches people to re-run the
   * suite, which is worse than no test. The security-relevant timing
   * assertions — the ones proving an attack is refused in milliseconds — stay
   * always-on above, where the margin is four orders of magnitude and no amount
   * of CPU contention can blur the verdict.
   *
   * Recorded from the opt-in run: reference ~306 ms, worst permitted ~1 076 ms.
   */
  it('accepts the densest permitted document and refuses the next step up', async () => {
    const atTheCap = buildDocxDeflated(Array.from({ length: 60_000 }, (_, i) => `p${i}`))
    await expect(service.extract(atTheCap, RESUME_DOCX_MIME)).resolves.toBeTypeOf('string')

    const overTheCap = buildDocxDeflated(Array.from({ length: 80_000 }, (_, i) => `p${i}`))
    await expect(service.extract(overTheCap, RESUME_DOCX_MIME)).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
  }, 300_000)

  /**
   * AC5 — the cap judged against REAL Word documents, in both directions and
   * with both numbers on the page.
   *
   * The point of this pair is that the two populations are separated by the
   * measurement, not by taste. A synthetic fixture spends ~60 bytes on a
   * paragraph where Word spends about a kilobyte on a bullet, so a budget
   * "calibrated" on one carries fictional headroom and starts rejecting the
   * long academic CVs it was supposed to admit. `REAL_WORD_BYTES_PER_PAGE`
   * comes from inspecting genuine .docx files (see the fixture's comment for
   * the corpus and the per-page figures).
   */
  it('AC5: a 40-page CV at real Word density passes, and the bypass bomb does not', async () => {
    // --- measurement 1: the honest document -------------------------------
    const academicCv = buildWordDensityDocx(40)
    const cv = await inspectDocxZip(academicCv)

    // It really is a 40-page document's worth of work, not a token fixture...
    expect(cv.actualParsedBytes).toBeGreaterThan(3_000_000)
    // ...and it fits, with the cap left meaningfully above it.
    expect(cv.actualParsedBytes).toBeLessThan(MAX_DOCX_PARSED_BYTES)
    await expect(service.extract(academicCv, RESUME_DOCX_MIME)).resolves.toBeTypeOf('string')

    // --- measurement 2: the attack ----------------------------------------
    // The body at a non-.xml path, with a 900-byte decoy at `word/document.xml`.
    // A by-extension budget saw the decoy and let 17 MB of parsing through.
    const bypass = buildDocxWithRenamedBody(Array.from({ length: 200_000 }, (_, i) => `p${i}`))
    expect(bypass.length).toBeLessThan(1_000_000) // small on disk, as bombs are
    await expect(inspectDocxZip(bypass)).rejects.toBeInstanceOf(RangeError)
    await expect(service.extract(bypass, RESUME_DOCX_MIME)).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
  }, 300_000)

  /**
   * Opt-in performance characterisation: `RESUME_PERF=1 pnpm --filter @crm/api
   * test resume-text-extraction`. Run it on a quiet machine when changing a
   * budget; it is not a gate, and it is not allowed to flake one.
   */
  it.skipIf(process.env['RESUME_PERF'] !== '1')(
    'keeps the worst PERMITTED document proportionate to an ordinary one',
    async () => {
      const ordinary = buildDocxDeflated(Array.from({ length: 10_000 }, (_, i) => `p${i}`))
      const atTheCap = buildDocxDeflated(Array.from({ length: 60_000 }, (_, i) => `p${i}`))

      const sample = async (doc: Buffer): Promise<number> => {
        const meter = startLagMeter()
        await service.extract(doc, RESUME_DOCX_MIME)
        return meter.stop().worstStall
      }
      const referenceRuns: number[] = []
      const worstRuns: number[] = []
      for (let run = 0; run < 3; run += 1) {
        referenceRuns.push(await sample(ordinary))
        worstRuns.push(await sample(atTheCap))
      }
      const median = (runs: number[]): number => runs.sort((a, b) => a - b)[1] as number

      expect(median(worstRuns) / median(referenceRuns)).toBeLessThan(6)
    },
    300_000,
  )

  it('never holds more than MAX_CONCURRENT_EXTRACTIONS parsers at once', async () => {
    const docx = buildDocxDeflated(Array.from({ length: 4_000 }, (_, i) => `параллельность ${i}`))
    let observedPeak = 0
    const watch = setInterval(() => {
      observedPeak = Math.max(observedPeak, service.activeExtractions)
    }, 1)
    watch.unref?.()

    const texts = await Promise.all(
      Array.from({ length: 10 }, () => service.extract(docx, RESUME_DOCX_MIME)),
    )
    clearInterval(watch)

    expect(texts).toHaveLength(10)
    expect(observedPeak).toBeGreaterThan(0)
    // A LITERAL 2, deliberately not `MAX_CONCURRENT_EXTRACTIONS`. Asserting
    // against the constant is what made the first version of this test an
    // equivalent mutant: raise the constant and the assertion raises with it,
    // so the check can never fail. The number is part of the contract, so it
    // is written out here and changing it has to be a conscious edit in two
    // places.
    expect(observedPeak).toBeLessThanOrEqual(2)
    // Everything drains: no slot is leaked on the success path.
    expect(service.activeExtractions).toBe(0)
    expect(service.queuedExtractions).toBe(0)
  }, 120_000)

  it('releases its slot when extraction throws', async () => {
    await expect(service.extract(Buffer.from('not a docx'), RESUME_DOCX_MIME)).rejects.toThrow()
    expect(service.activeExtractions).toBe(0)
    expect(service.queuedExtractions).toBe(0)
  })

  /**
   * ==========================================================================
   * THE SEAM MAY ONLY TIGHTEN THE CPU LIMIT — PINNED, NOT ASSUMED
   * ==========================================================================
   * `cpuSeconds` was added so a spec could reach the kill branch, and its note
   * said both seam values "shorten a limit the sandbox already enforces". That
   * was a true statement about the one call site, not a property of the code:
   * nothing stopped the seam from raising the ceiling or removing it.
   *
   * It reaches `ulimit -t` as a STRING in a shell, and rlimit failures are
   * swallowed by design (`sandboxed-process.ts`), so a value the shell will not
   * accept does not raise — it starts the child with NO CPU LIMIT AT ALL. The
   * one to remember is `1e21`: `String(1e21)` is `"1e+21"`, and exponent
   * notation is not a number to a shell. `NaN`, `Infinity` and `-1` land the
   * same way; `100000` is simply obeyed. Every one of them is a valid `number`,
   * so the signature refuses none of them.
   *
   * `timeoutMs` survives the same rubbish because a bad delay collapses to
   * 1 ms — it fails CLOSED. This one failed OPEN, which is the direction that
   * matters, so what the sandbox is ASKED for is asserted here for each shape
   * of rubbish. Remove the clamp in `runWorker` and every case below goes red.
   */
  describe('the CPU-budget seam may only tighten the limit, never loosen it', () => {
    /**
     * What `runWorker` actually asked the sandbox for. The spy CALLS THROUGH —
     * the extraction really runs, under the real sandbox; the argument is only
     * observed on its way past — and the outcome is deliberately ignored,
     * because the assertion is about the budget requested, not the result.
     */
    async function requestedBudget(options: { cpuSeconds?: number }): Promise<number | undefined> {
      const spy = vi.spyOn(sandboxedProcess, 'runSandboxed')
      try {
        await service.extract(buildDocx(['резюме']), RESUME_DOCX_MIME, options).catch(() => '')
        // Read BEFORE `mockRestore`, which also resets the recorded calls.
        return spy.mock.calls[0]?.[0]?.cpuSeconds
      } finally {
        spy.mockRestore()
      }
    }

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a negative budget', -1],
      ['zero', 0],
      ['a fraction', 1.5],
      ['1e21, which stringifies to "1e+21"', 1e21],
      ['a raised ceiling', 100_000],
      ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ])('%s cannot loosen the limit', async (_case, cpuSeconds) => {
      expect(await requestedBudget({ cpuSeconds })).toBe(EXTRACTION_CPU_SECONDS)
    })

    it('leaves the production ceiling in place when nothing is asked for', async () => {
      expect(await requestedBudget({})).toBe(EXTRACTION_CPU_SECONDS)
    })

    it('still lets a spec ask for LESS, which is what the seam is for', async () => {
      expect(await requestedBudget({ cpuSeconds: 1 })).toBe(1)
    })

    it('hands the shell a plain integer, never exponent notation', async () => {
      // The mechanism behind the 1e21 case, asserted as itself: whatever the
      // caller passes, what reaches `ulimit -t` must be something a shell reads
      // as a number.
      expect(String(await requestedBudget({ cpuSeconds: 1e21 }))).toMatch(/^\d+$/)
    })
  })
})

/**
 * HIGH-2. The PDF branch had NO size guard: file size measures compressed
 * bytes, the page cap measures pages, and `extractText` pays per operator.
 * Measured on the intake path before this bound existed:
 *
 *   30 pages, 12 KB file -> accepted,  6 109 ms stall
 *   30 pages, 24 KB file -> accepted, 23 267 ms stall, 884 MB resident
 */
describe('PDF content-stream guard (HIGH-2)', () => {
  it('refuses the shared-content-stream amplification without stalling', async () => {
    // One stream, 30 pages pointing at it: 600 000 operator executions from a
    // file smaller than an email signature.
    const bomb = buildPdfSharedContentStream(30, 20_000)
    expect(bomb.length).toBeLessThan(64 * 1024)

    const meter = startLagMeter()
    await expect(service.extract(bomb, RESUME_PDF_MIME)).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
    const { worstStall } = meter.stop()
    // Measured after the fix: 5 ms wall, 0 ms stall.
    expect(worstStall).toBeLessThan(250)
  }, 120_000)

  it('charges the page multiplier, not just the byte total', async () => {
    // Same stream, one page: well inside the budget and accepted.
    const single = buildPdfSharedContentStream(1, 20_000)
    await expect(service.extract(single, RESUME_PDF_MIME)).resolves.toBeTypeOf('string')
    // The identical content shared across 30 pages is 30x the work.
    const shared = buildPdfSharedContentStream(30, 20_000)
    await expect(service.extract(shared, RESUME_PDF_MIME)).rejects.toThrow(/текстовых операций/)
  }, 120_000)

  /**
   * A byte budget was tried first and had to be abandoned: the most common
   * image encoding in real PDFs is plain `/FlateDecode` over raw samples, so
   * counting decoded bytes made 13 of 95 real files — two of them actual CVs —
   * look like 25-130 MB of content. Image XObjects must not be charged.
   *
   * MUTATION: drop the `/Subtype /Image` check from `isPdfImageStream` and this
   * goes red.
   */
  it('does not charge image XObjects', async () => {
    const withImage = buildPdfWithFlateImage(12 * 1024 * 1024)

    // Assert the ACCOUNTING, not just the outcome: a 12 MB image sits inside
    // the file, and essentially none of it may reach the content budget. An
    // end-to-end assertion passes either way while the caps are generous, which
    // is precisely how a wrong classifier survives.
    // The image decodes to 12 MB (it is compact on disk only because the test
    // samples compress well). If it were charged, contentBytes would be ~12 MB.
    const info = await inspectPdfContent(withImage, 1)
    expect(info.contentBytes).toBeLessThan(64 * 1024)

    const text = await service.extract(withImage, RESUME_PDF_MIME)
    expect(text).toContain('resume')
  }, 120_000)

  it('still extracts an ordinary PDF', async () => {
    // Latin only: the fixture embeds StandardFonts.Helvetica, which has no
    // Cyrillic glyphs (the Cyrillic path is exercised by the DOCX tests).
    const pdf = await buildPdfWithText(['Ivan Petrov', 'Senior Engineer'])
    await expect(service.extract(pdf, RESUME_PDF_MIME)).resolves.toContain('Ivan Petrov')
  })

  /**
   * Calibration guard, same discipline as the DOCX budget: the cap is set by a
   * real corpus, so the corpus's high-water mark belongs in the test. 95 real
   * PDFs (CVs, contracts, invoices, scans) topped out at 56 880 amplified
   * operators; the next busiest was 7 965.
   */
  it('leaves the busiest real PDF inside the budget', () => {
    const BUSIEST_REAL_PDF_OPERATORS = 56_880
    expect(MAX_PDF_TEXT_OPERATORS).toBeGreaterThan(BUSIEST_REAL_PDF_OPERATORS)
    // ...and stays well below the cheapest attack shape (600 000).
    expect(MAX_PDF_TEXT_OPERATORS).toBeLessThan(600_000 / 4)
  })
})

describe('capExtractedText (HIGH-1 — the bound that runs BEFORE normalisation)', () => {
  it('leaves normal text untouched', () => {
    expect(capExtractedText('короткое резюме')).toBe('короткое резюме')
  })

  /**
   * MUTATION: make `capExtractedText` return `raw` unchanged (i.e. restore the
   * old "cap only when the prompt is built" behaviour) and this goes red.
   */
  it('truncates anything longer than extractionRawChars', () => {
    const monstrous = 'x'.repeat(RESUME_LIMITS.extractionRawChars + 5_000)
    expect(capExtractedText(monstrous)).toHaveLength(RESUME_LIMITS.extractionRawChars)
  })

  it('is cheap on input the old code choked on', () => {
    // 5 MB — a fraction of the 50 MiB a real 52 KB DOCX produced, and already
    // enough to freeze the loop for seconds if normalisation saw it first.
    const huge = 'y'.repeat(5_000_000)
    const started = Date.now()
    const text = normalizeExtractedText(capExtractedText(huge))
    expect(text.length).toBe(RESUME_LIMITS.extractionRawChars)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('normalizeExtractedText', () => {
  it('collapses whitespace runs and blank-line soup', () => {
    expect(normalizeExtractedText('a   b\n\n\n\nc  \n  ')).toBe('a b\n\nc')
  })

  it('strips NUL and other C0 controls but keeps tabs as spacing', () => {
    expect(normalizeExtractedText('a\u0000b\tc')).toBe('ab c')
  })

  it('strips the rest of the C0 range too (form feed, vertical tab, escape)', () => {
    expect(normalizeExtractedText('a\u000Bb\u000Cc\u001Bd')).toBe('abcd')
  })
})
