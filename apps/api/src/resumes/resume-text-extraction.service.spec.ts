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
import { describe, expect, it } from 'vitest'
import { RESUME_DOCX_MIME, RESUME_LIMITS, RESUME_PDF_MIME } from '@crm/shared'
import {
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
