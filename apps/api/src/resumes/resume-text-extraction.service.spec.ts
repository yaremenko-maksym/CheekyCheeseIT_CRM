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
  MAX_DOCX_XML_BYTES,
  MAX_PDF_PAGES,
  capExtractedText,
  detectResumeSourceMime,
  inspectDocxZip,
  normalizeExtractedText,
} from './resume-source.util'
import {
  buildDocx,
  buildDocxDeclaringNoEntries,
  buildDocxDeflated,
  buildDocxLyingAboutSize,
  buildDocxZipBomb,
  buildEmptyPdf,
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
   * The XML parts are what `mammoth` parses, and parse time tracks their size.
   * Media does not: images are inert for text extraction, so charging them
   * against the same budget would reject legitimate illustrated CVs while
   * doing nothing about the attack, which is pure markup.
   */
  it('accounts for XML separately from media', async () => {
    const info = await inspectDocxZip(buildDocx(['hello']))
    expect(info.actualXmlBytes).toBeGreaterThan(0)
    // This fixture is XML-only, so the two totals coincide.
    expect(info.actualXmlBytes).toBe(info.actualUncompressedBytes)
    expect(info.actualXmlBytes).toBeLessThan(MAX_DOCX_XML_BYTES)
  })

  it('refuses a document whose XML alone exceeds the XML budget', async () => {
    const dense = buildDocxDeflated(Array.from({ length: 40_000 }, (_, i) => `p${i}`))
    await expect(inspectDocxZip(dense)).rejects.toThrow(/Текстовая часть/)
  })

  it('names the cap that was hit, so the advice is actionable', async () => {
    const dense = buildDocxDeflated(Array.from({ length: 40_000 }, (_, i) => `p${i}`))
    // "shrink the text", not "shrink the images".
    await expect(inspectDocxZip(dense)).rejects.toThrow(/Текстовая часть DOCX больше 1 MB/)
  })

  it('still accepts a realistic resume with room to spare', async () => {
    const realistic = buildDocxDeflated([
      'Иван Петров — синьор-разработчик',
      ...Array.from({ length: 120 }, (_, i) => `Достижение ${i}: снизил задержку сервиса на 40%.`),
    ])
    const info = await inspectDocxZip(realistic)
    // Measured at ~24 KB — the 1 MB budget is ~40x a dense real CV.
    expect(info.actualXmlBytes).toBeLessThan(MAX_DOCX_XML_BYTES / 10)
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
   * MUTATION: raise `MAX_DOCX_XML_BYTES` to `MAX_DOCX_UNCOMPRESSED_BYTES` and
   * this goes red (measured 8 876 ms stall at 24 MB of XML).
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
   * The worst input that still gets THROUGH the cap. This is the number the
   * cap actually buys, and it belongs in a test so it cannot regress quietly.
   */
  it('keeps the worst PERMITTED document under a bounded stall', async () => {
    const dense = buildDocxDeflated(Array.from({ length: 15_000 }, (_, i) => `p${i}`))
    const meter = startLagMeter()
    await service.extract(dense, RESUME_DOCX_MIME)
    const { worstStall } = meter.stop()
    // Measured: 363 ms (was 33 336 ms for the unbounded case).
    expect(worstStall).toBeLessThan(2_000)
  }, 120_000)

  it('does not truncate a resume of realistic length', async () => {
    const docx = buildDocx(['Иван Петров', 'x'.repeat(5_000)])
    const text = await service.extract(docx, RESUME_DOCX_MIME)
    expect(text).toContain('Иван Петров')
    expect(text.length).toBeGreaterThan(5_000)
  })

  /**
   * The concurrency gate used to be an equivalent mutant: replacing 2 with a
   * million failed nothing, because the old test only checked that ten
   * extractions all returned. Assert the LIMIT itself.
   *
   * MUTATION: raise `MAX_CONCURRENT_EXTRACTIONS` and this goes red.
   */
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
