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
  MAX_PDF_TEXT_OPERATORS,
  MAX_PDF_PAGES,
  capExtractedText,
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
  buildPdfWithText,
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
      clearInterval(timer)
      return { worstStall }
    },
  }
}

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
   * MUTATION: make `isInertMedia` return `true` for everything (i.e. count
   * nothing) or restore the by-extension rule, and this goes red.
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
