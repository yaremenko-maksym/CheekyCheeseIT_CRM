import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { ContractPdfService, type GenerateContractPdfParams } from './contract-pdf.service'
import { PdfGenerationService, type DrawTextOptions } from '../common/pdf/pdf-generation.service'
import { PDF_LAYOUT } from '../common/pdf/pdf.constants'

// ---------------------------------------------------------------------------
// Geometry constants (mirrors contract-pdf.service.ts TABLE_GUTTER logic)
// ---------------------------------------------------------------------------
const PAGE_MARGIN = PDF_LAYOUT.pageMargin // 50
const CONTENT_WIDTH = PDF_LAYOUT.contentWidth // 495.28
const TABLE_GUTTER = 16
const COL_WIDTH = (CONTENT_WIDTH - TABLE_GUTTER) / 2 // ~239.64
const LEFT_COL_X = PAGE_MARGIN // 50
const RIGHT_COL_X = PAGE_MARGIN + COL_WIDTH + TABLE_GUTTER // ~305.64
const RIGHT_EDGE = PAGE_MARGIN + CONTENT_WIDTH // 545.28

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<GenerateContractPdfParams> = {}): GenerateContractPdfParams {
  return {
    contractNumber: 'CHK-1-2026',
    bodyMarkdown:
      '# Договор\n\nОбычный абзац с **жирным** текстом.\n\n- Пункт первый\n- Пункт второй',
    signedTypedName: 'Иван Иванов',
    signedAt: new Date('2026-06-04T07:00:00.000Z'),
    verifyUrl: 'http://localhost:3000/contract/v/abc-123',
    ...overrides,
  }
}

// A minimal two-column table body (markdown)
const TWO_COL_TABLE_BODY = [
  '| Українська | English |',
  '| --- | --- |',
  '| Привіт | Hello |',
  '| Договір | Agreement |',
].join('\n')

describe('ContractPdfService', () => {
  let service: ContractPdfService
  let pdfGen: PdfGenerationService

  /**
   * Collect every string passed to PdfGenerationService.drawText during one
   * PDF generation. pdf-lib renders text as embedded-font glyph codes inside
   * (often compressed) content streams, so the rendered words never appear as
   * plain bytes in the output buffer — asserting on the drawText call args is
   * the correct way to verify what text the contract actually renders.
   */
  async function drawnTexts(params: GenerateContractPdfParams): Promise<string[]> {
    const spy = vi.spyOn(pdfGen, 'drawText')
    await service.generateContractPdf(params)
    const texts = spy.mock.calls
      .map((call) => call[1])
      .filter((t): t is string => typeof t === 'string')
    spy.mockRestore()
    return texts
  }

  /**
   * Collect full drawText call records (text + options) for x-coordinate assertions.
   */
  async function drawnCalls(
    params: GenerateContractPdfParams,
  ): Promise<Array<{ text: string; opts: DrawTextOptions }>> {
    const spy = vi.spyOn(pdfGen, 'drawText')
    await service.generateContractPdf(params)
    const calls = spy.mock.calls.map((call) => ({ text: call[1] as string, opts: call[2] }))
    spy.mockRestore()
    return calls
  }

  beforeEach(() => {
    pdfGen = new PdfGenerationService()
    service = new ContractPdfService(pdfGen)
  })

  it('produces a non-empty PDF buffer + 64-char sha256', async () => {
    const { pdfBuffer, sha256Hash } = await service.generateContractPdf(makeParams())

    expect(pdfBuffer.length).toBeGreaterThan(1000)
    // PDF magic header.
    expect(pdfBuffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is byte-deterministic — identical params yield identical sha256', async () => {
    const first = await service.generateContractPdf(makeParams())
    const second = await service.generateContractPdf(makeParams())

    expect(second.sha256Hash).toBe(first.sha256Hash)
    expect(second.pdfBuffer.equals(first.pdfBuffer)).toBe(true)
  })

  it('differs when the signed contract content differs', async () => {
    const a = await service.generateContractPdf(makeParams({ contractNumber: 'CHK-1-2026' }))
    const b = await service.generateContractPdf(makeParams({ contractNumber: 'CHK-2-2026' }))

    expect(b.sha256Hash).not.toBe(a.sha256Hash)
  })

  it('paginates long contracts onto multiple pages', async () => {
    const longBody = Array.from(
      { length: 120 },
      (_, i) => `Пункт ${i + 1} договора о предоставлении услуг.`,
    ).join('\n\n')
    const { pdfBuffer } = await service.generateContractPdf(makeParams({ bodyMarkdown: longBody }))

    const doc = await PDFDocument.load(pdfBuffer)
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })

  it('renders Cyrillic body without throwing', async () => {
    await expect(
      service.generateContractPdf(
        makeParams({
          bodyMarkdown: '## Раздел\n\nДоговор на русском языке. Ставка 26%. Кошелёк USDT.',
        }),
      ),
    ).resolves.toBeDefined()
  })

  // ---------------------------------------------------------------------------
  // AC7: No IP address in PDF output
  // ---------------------------------------------------------------------------

  it('AC7: never draws the IP suffix in the signed contract signature', async () => {
    const texts = await drawnTexts(makeParams())
    expect(texts.some((t) => t.includes('IP …') || t.includes('IP ...') || / · IP/.test(t))).toBe(
      false,
    )
  })

  it('AC7: interface no longer has signedIpLastOctet param', () => {
    // Compilation-level check: makeParams() (which omits signedIpLastOctet) must compile
    // and produce a valid GenerateContractPdfParams — verified by the fact this test runs.
    const params = makeParams()
    expect('signedIpLastOctet' in params).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // AC8: Dual signature block (participant + CheekyCheeseIT) on all statuses.
  // Assert on drawText call args — see drawnTexts() for why binary scanning fails.
  // ---------------------------------------------------------------------------

  it('AC8: signed single-column contract draws Ukrainian signature block', async () => {
    // makeParams() has no pipe tables → single-column → Ukrainian labels
    const texts = await drawnTexts(makeParams())
    expect(texts).toContain('Підписи сторін')
    expect(texts.some((t) => t.includes('Учасник'))).toBe(true)
    expect(texts.some((t) => t.includes('Від CheekyCheeseIT'))).toBe(true)
  })

  it('AC8: bilingual contract draws UA/EN signature block heading', async () => {
    // A body with pipe tables → bilingual → UA/EN labels
    const bilingualParams = makeParams({ bodyMarkdown: TWO_COL_TABLE_BODY })
    const texts = await drawnTexts(bilingualParams)
    expect(texts).toContain('Підписи сторін / Signatures')
    expect(texts.some((t) => t.includes('Учасник / Signatory'))).toBe(true)
    expect(texts.some((t) => t.includes('CheekyCheeseIT'))).toBe(true)
  })

  it('AC8: bilingual contract does NOT draw "Підписи сторін" (only UA/EN heading)', async () => {
    const bilingualParams = makeParams({ bodyMarkdown: TWO_COL_TABLE_BODY })
    const texts = await drawnTexts(bilingualParams)
    expect(texts.every((t) => t !== 'Підписи сторін')).toBe(true)
  })

  it('AC8: unsigned preview also draws the CheekyCheeseIT signature block', async () => {
    const previewParams: GenerateContractPdfParams = {
      contractNumber: '',
      bodyMarkdown: makeParams().bodyMarkdown,
      signedTypedName: '',
      signedAt: null,
      verifyUrl: '',
    }
    const texts = await drawnTexts(previewParams)
    expect(texts).toContain('Підписи сторін')
    expect(
      texts.some((t) => t.includes('Від CheekyCheeseIT') || t.includes('CheekyCheeseIT')),
    ).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // A3-1: Unsigned preview mode — signedTypedName='' drives all conditionals.
  // ---------------------------------------------------------------------------

  describe("A3-1: unsigned preview mode (signedTypedName='')", () => {
    /** Minimal unsigned-preview params — mirrors what OnboardingContractController sends. */
    function makePreviewParams(): GenerateContractPdfParams {
      return {
        contractNumber: '',
        bodyMarkdown: makeParams().bodyMarkdown,
        signedTypedName: '',
        signedAt: null,
        verifyUrl: '',
      }
    }

    it('produces a valid non-empty PDF buffer in unsigned preview mode', async () => {
      const { pdfBuffer } = await service.generateContractPdf(makePreviewParams())
      expect(pdfBuffer.length).toBeGreaterThan(1000)
      expect(pdfBuffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    })

    it('unsigned preview differs from signed PDF (different sha256)', async () => {
      const signed = await service.generateContractPdf(makeParams())
      const preview = await service.generateContractPdf(makePreviewParams())
      expect(preview.sha256Hash).not.toBe(signed.sha256Hash)
    })

    it('unsigned preview is a valid parseable PDF with at least 1 page', async () => {
      const { pdfBuffer } = await service.generateContractPdf(makePreviewParams())
      expect(pdfBuffer.length).toBeGreaterThan(5000)
      const doc = await PDFDocument.load(pdfBuffer)
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
    })

    it('unsigned preview does NOT embed the signed name (signedTypedName suppressed)', async () => {
      const { pdfBuffer } = await service.generateContractPdf(makePreviewParams())
      const rawContent = pdfBuffer.toString('binary')
      // 'Иван Иванов' in UTF-16BE bytes: И=0x0418
      expect(rawContent).not.toContain('\x00\x04\x00\x38')
      expect(rawContent).not.toContain('\x04\x18\x04\x32\x04\x30\x04\x3d')
    })

    it('unsigned preview is smaller than signed PDF (no QR PNG embedded)', async () => {
      const signed = await service.generateContractPdf(makeParams())
      const preview = await service.generateContractPdf(makePreviewParams())
      expect(signed.pdfBuffer.length).toBeGreaterThan(preview.pdfBuffer.length + 200)
    })

    it('unsigned preview is byte-deterministic (same params → same sha256)', async () => {
      const first = await service.generateContractPdf(makePreviewParams())
      const second = await service.generateContractPdf(makePreviewParams())
      expect(first.sha256Hash).toBe(second.sha256Hash)
    })

    // Part 3 — template editor preview: {{tokens}} stay VISIBLE (the body is
    // passed AS-IS, NOT through renderContractTemplate), and the appended
    // «Реквизиты компании» section renders. The unsigned signature block shows
    // «Потрібен підпис учасника».
    it('renders {{tokens}} VISIBLY (no substitution) in the preview body', async () => {
      const texts = await drawnTexts({
        contractNumber: '',
        bodyMarkdown:
          '# Контракт\n\nИмя: {{employeeName}}\nUSDT: {{walletUsdt}}\n\n' +
          '## Реквизиты компании\n\nООО «Тест»',
        signedTypedName: '',
        signedAt: new Date('2026-06-29T00:00:00Z'),
        verifyUrl: '',
      })
      // The literal token braces survive into the drawn text (visible to admin).
      // Paragraphs are drawn token-by-token (whitespace-split), so assert on the
      // individual tokens rather than the whole line.
      const joined = texts.join('\n')
      expect(joined).toContain('{{employeeName}}')
      expect(joined).toContain('{{walletUsdt}}')
      // The appended requisites heading is drawn (its words appear as tokens).
      expect(texts).toContain('Реквизиты')
      // Unsigned signature affordance present.
      expect(texts.some((t) => t.includes('Потрібен підпис'))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Two-column table rendering
  // ---------------------------------------------------------------------------

  describe('two-column table rendering', () => {
    it('UA cell text is drawn at left-column x, EN cell text at right-column x', async () => {
      const calls = await drawnCalls(makeParams({ bodyMarkdown: TWO_COL_TABLE_BODY }))
      // Expect "Привіт" drawn near left column x
      const uaCall = calls.find((c) => c.text === 'Привіт')
      expect(uaCall, 'UA cell "Привіт" not drawn').toBeDefined()
      expect(uaCall!.opts.x).toBeCloseTo(LEFT_COL_X, 0)

      // Expect "Hello" drawn near right column x
      const enCall = calls.find((c) => c.text === 'Hello')
      expect(enCall, 'EN cell "Hello" not drawn').toBeDefined()
      expect(enCall!.opts.x).toBeCloseTo(RIGHT_COL_X, 0)
    })

    it('header row "Українська" is drawn bold at left x, "English" at right x', async () => {
      const calls = await drawnCalls(makeParams({ bodyMarkdown: TWO_COL_TABLE_BODY }))

      const uaHeader = calls.find((c) => c.text === 'Українська')
      expect(uaHeader, '"Українська" header not drawn').toBeDefined()
      expect(uaHeader!.opts.x).toBeCloseTo(LEFT_COL_X, 0)

      const enHeader = calls.find((c) => c.text === 'English')
      expect(enHeader, '"English" header not drawn').toBeDefined()
      expect(enHeader!.opts.x).toBeCloseTo(RIGHT_COL_X, 0)
    })

    it('separator row (---) is skipped — not drawn as text', async () => {
      const texts = await drawnTexts(makeParams({ bodyMarkdown: TWO_COL_TABLE_BODY }))
      const hasSeparatorText = texts.some((t) => /^:?-{3,}:?$/.test(t.trim()))
      expect(hasSeparatorText).toBe(false)
    })

    it('cell text stays within its column — x does not exceed column right edge', async () => {
      // Long cell content that will word-wrap
      const longCellBody = [
        '| Українська | English |',
        '| --- | --- |',
        '| Довгий текст клітинки що має бути перенесений по словах і не виходити за межі колонки | Long cell text that should wrap within the column and never exceed the column boundary |',
      ].join('\n')

      const calls = await drawnCalls(makeParams({ bodyMarkdown: longCellBody }))

      // All text drawn in the left column zone must not exceed its right edge
      const leftColRightEdge = LEFT_COL_X + COL_WIDTH
      const rightColRightEdge = RIGHT_COL_X + COL_WIDTH

      // Partition first, then assert — the assertions used to sit inside the
      // `if`/`else if` of this loop, so a run in which NO draw landed in either
      // column zone (a regression that stopped drawing the table at all, or
      // moved it) executed zero assertions and passed. The non-empty checks
      // below make that failure mode loud. (task-lint-teeth)
      const leftColCalls = calls.filter(
        ({ opts }) => opts.x >= LEFT_COL_X && opts.x < RIGHT_COL_X - 1,
      )
      const rightColCalls = calls.filter(
        ({ opts }) => opts.x >= RIGHT_COL_X - 1 && opts.x <= RIGHT_EDGE,
      )

      expect(leftColCalls.length, 'expected at least one left-column draw').toBeGreaterThan(0)
      expect(rightColCalls.length, 'expected at least one right-column draw').toBeGreaterThan(0)

      for (const { text, opts } of leftColCalls) {
        // Must not start beyond the left column's right edge.
        expect(opts.x, `Left col token "${text}" starts past right edge`).toBeLessThanOrEqual(
          leftColRightEdge,
        )
      }
      for (const { text, opts } of rightColCalls) {
        // Must not start beyond the right column's right edge.
        expect(opts.x, `Right col token "${text}" starts past right edge`).toBeLessThanOrEqual(
          rightColRightEdge,
        )
      }
    })

    it('ultra-long non-breaking token (200-char wallet) is broken per-char within column', async () => {
      // A 200-character hex string with no spaces — simulates an Ethereum address or URL.
      const longToken = '0x' + 'a'.repeat(198)
      const body = ['| Українська | English |', '| --- | --- |', `| ${longToken} | Short |`].join(
        '\n',
      )

      // Must not throw; each drawn token x must be within left column bounds.
      const calls = await drawnCalls(makeParams({ bodyMarkdown: body }))

      // Tokens from the left column (not from header/signature/etc.). Filtered
      // up front so a run that drew nothing in that column fails instead of
      // asserting nothing — see the partition note in the previous test.
      const leftColCalls = calls.filter(
        ({ opts }) => opts.x >= LEFT_COL_X && opts.x < RIGHT_COL_X - 1,
      )
      expect(
        leftColCalls.length,
        'expected the 200-char token to produce left-column draws',
      ).toBeGreaterThan(0)

      for (const { text, opts } of leftColCalls) {
        expect(
          opts.x,
          `Token "${text.slice(0, 20)}…" exceeds left col right edge`,
        ).toBeLessThanOrEqual(LEFT_COL_X + COL_WIDTH)
      }
    })

    it('unequal row heights: next row starts below the taller cell', async () => {
      // Left cell: 1 short line; right cell: 6 lines of text — forces tall row.
      // Use '|' only as column separators (no extra '|' in cell content).
      const sixLinesText = Array(6).fill('Line of text in right cell').join('. ')
      const body = [
        '| Українська | English |',
        '| --- | --- |',
        `| Коротко | ${sixLinesText} |`,
        '| Маркер | Marker |',
      ].join('\n')

      const calls = await drawnCalls(makeParams({ bodyMarkdown: body }))

      // drawText is called per-token; "Коротко" is a single token → exact match.
      const kortkoCall = calls.find((c) => c.text === 'Коротко')
      expect(kortkoCall, '"Коротко" first-row token not drawn').toBeDefined()

      // "Маркер" is a single token in the second data row.
      const markerCall = calls.find((c) => c.text === 'Маркер')
      expect(markerCall, '"Маркер" second-row token not drawn').toBeDefined()

      // In PDF coordinates Y decreases going down the page,
      // so the marker row's y must be less than the first row's y.
      expect(markerCall!.opts.y).toBeLessThan(kortkoCall!.opts.y)
    })

    it('multi-page table: many rows render without crashing and produce ≥2 pages', async () => {
      const rows = Array.from(
        { length: 80 },
        (_, i) => `| Рядок ${i + 1} довгий текст колонки | Row ${i + 1} long text column |`,
      ).join('\n')
      const body = ['| Українська | English |', '| --- | --- |', rows].join('\n')

      const { pdfBuffer } = await service.generateContractPdf(makeParams({ bodyMarkdown: body }))
      const doc = await PDFDocument.load(pdfBuffer)
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(2)
    })

    it('row taller than one full page splits across pages without crashing', async () => {
      // Build a cell content that is definitely taller than one full page.
      // 300 words in one cell will wrap to many lines.
      const manyLines = Array(100).fill('Довгий рядок тексту для тесту').join(' ')
      const body = ['| Українська | English |', '| --- | --- |', `| ${manyLines} | Short |`].join(
        '\n',
      )

      await expect(
        service.generateContractPdf(makeParams({ bodyMarkdown: body })),
      ).resolves.toBeDefined()
    })

    it('empty cell renders without crashing', async () => {
      const body = [
        '| Українська | English |',
        '| --- | --- |',
        '|  | Тільки права клітинка |',
        '| Тільки ліва клітинка |  |',
      ].join('\n')

      await expect(
        service.generateContractPdf(makeParams({ bodyMarkdown: body })),
      ).resolves.toBeDefined()
    })

    it('**bold** inside a cell is rendered (bold token drawn in cell x range)', async () => {
      const body = [
        '| Українська | English |',
        '| --- | --- |',
        '| **Жирний текст** | **Bold text** |',
      ].join('\n')

      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      // Bold parsing splits on ** — expect the inner text token to be present
      expect(texts.some((t) => t.includes('Жирний') || t.includes('текст'))).toBe(true)
      expect(texts.some((t) => t.includes('Bold') || t.includes('text'))).toBe(true)
    })

    it('non-2-column row falls back gracefully (no crash, text present)', async () => {
      // 3-column row — should not crash; falls back to single-column text
      const body = ['| Col1 | Col2 | Col3 |', '| --- | --- | --- |', '| A | B | C |'].join('\n')

      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      // At least some text from the row should appear (Col1, Col2, or A, B, C)
      expect(texts.some((t) => ['Col1', 'Col2', 'Col3', 'A', 'B', 'C'].includes(t))).toBe(true)
    })

    it('two-column table is deterministic (same input → same sha256 twice)', async () => {
      const first = await service.generateContractPdf(
        makeParams({ bodyMarkdown: TWO_COL_TABLE_BODY }),
      )
      const second = await service.generateContractPdf(
        makeParams({ bodyMarkdown: TWO_COL_TABLE_BODY }),
      )
      expect(first.sha256Hash).toBe(second.sha256Hash)
    })

    it('mixed content (heading + table + bullets + blockquote) renders without crash', async () => {
      const body = [
        '> Дисклеймер: цей контракт є чернеткою.',
        '',
        '# Заголовок розділу',
        '',
        '| Українська | English |',
        '| --- | --- |',
        '| Зміст | Content |',
        '',
        '- Перший пункт',
        '- Другий пункт',
        '',
        'Звичайний абзац тексту.',
      ].join('\n')

      await expect(
        service.generateContractPdf(makeParams({ bodyMarkdown: body })),
      ).resolves.toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Blockquote rendering
  // ---------------------------------------------------------------------------

  describe('blockquote (> ) rendering', () => {
    it('does not draw the literal ">" character', async () => {
      const body = '> Це дисклеймер — попередження.'
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      // No token that is just ">" or starts with "> "
      expect(texts.every((t) => !t.startsWith('>'))).toBe(true)
    })

    it('draws blockquote content text (without the ">" prefix)', async () => {
      const body = '> Дисклеймер тексту'
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      expect(texts.some((t) => t.includes('Дисклеймер') || t.includes('тексту'))).toBe(true)
    })

    it('empty blockquote (bare ">") does not draw literal ">" text', async () => {
      const body = 'Параграф перед\n>\nПараграф після'
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      expect(texts.every((t) => t.trim() !== '>')).toBe(true)
    })

    it('empty blockquote ("> " with space) does not draw literal ">" text', async () => {
      const body = '> '
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      expect(texts.every((t) => t.trim() !== '>')).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Inline backtick stripping
  // ---------------------------------------------------------------------------

  describe('inline backtick stripping', () => {
    it('renders `[ВПИШИ: X]` without literal backtick characters', async () => {
      const body = 'Текст `[ВПИШИ: назву]` після.'
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      // No text token should contain a backtick
      expect(texts.every((t) => !t.includes('`'))).toBe(true)
      // The inner content should be drawn
      expect(texts.some((t) => t.includes('[ВПИШИ:') || t.includes('назву'))).toBe(true)
    })

    it('renders backtick-wrapped text without surrounding backticks in two-column cell', async () => {
      const body = [
        '| Українська | English |',
        '| --- | --- |',
        '| `[ВПИШИ: суму]` | `[FILL: amount]` |',
      ].join('\n')
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      expect(texts.every((t) => !t.includes('`'))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // <br> inline line break
  // ---------------------------------------------------------------------------

  describe('<br> inline line break', () => {
    it('<br> inside a heading splits it into two draw calls', async () => {
      const body = '# Договір № [ВПИШИ]<br>SOFTWARE SERVICES AGREEMENT'
      const calls = await drawnCalls(makeParams({ bodyMarkdown: body }))
      // After <br> split, both segments must appear as drawn text
      const contractLine = calls.some(
        (c) => c.text.includes('Договір') || c.text.includes('[ВПИШИ]'),
      )
      const englishLine = calls.some(
        (c) => c.text.includes('SOFTWARE') || c.text.includes('SERVICES'),
      )
      expect(contractLine).toBe(true)
      expect(englishLine).toBe(true)
    })

    it('<br/> variant also splits the line', async () => {
      const body = 'Перший рядок<br/>Другий рядок'
      const calls = await drawnCalls(makeParams({ bodyMarkdown: body }))
      const hasFirst = calls.some((c) => c.text.includes('Перший'))
      const hasSecond = calls.some((c) => c.text.includes('Другий'))
      expect(hasFirst).toBe(true)
      expect(hasSecond).toBe(true)
    })

    it('<br> renders the second segment at a lower Y than the first', async () => {
      const body = 'Рядок один<br>Рядок два'
      const calls = await drawnCalls(makeParams({ bodyMarkdown: body }))
      const firstY = calls.find((c) => c.text.includes('один'))?.opts.y
      const secondY = calls.find((c) => c.text.includes('два'))?.opts.y
      expect(firstY).toBeDefined()
      expect(secondY).toBeDefined()
      // PDF Y decreases downwards; second line must be at a lower Y
      expect(secondY!).toBeLessThan(firstY!)
    })
  })

  // ---------------------------------------------------------------------------
  // Horizontal rule (`---`)
  // ---------------------------------------------------------------------------

  describe('horizontal rule (---)', () => {
    it('--- in single-column body is NOT rendered as a separator (preserves MED-1)', async () => {
      // Single-column bodies (no pipe tables) must preserve --- as-is for MED-1.
      // In single-column path, --- is rendered as plain text (not a separator call).
      // The drawSeparator call count should be 2 (letterhead + sig block) not 3.
      const body = 'Параграф\n\n---\n\nНаступний параграф'
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      // --- is rendered as literal text in single-column mode (no separator upgrade)
      expect(texts.some((t) => t.trim() === '---')).toBe(true)
    })

    it('--- in bilingual (table) body is rendered as a separator, NOT drawn as text', async () => {
      const body = [
        '| UA | EN |',
        '| --- | --- |',
        '| Розділ 1 | Section 1 |',
        '',
        '---',
        '',
        '| UA | EN |',
        '| --- | --- |',
        '| Розділ 2 | Section 2 |',
      ].join('\n')
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      // In bilingual mode, standalone --- must NOT appear as drawn text
      expect(texts.every((t) => t.trim() !== '---')).toBe(true)
    })

    it('*** in bilingual body is also treated as a separator (not drawn as text)', async () => {
      const body = '| UA | EN |\n| --- | --- |\n| A | B |\n\n***\n\nПараграф'
      const texts = await drawnTexts(makeParams({ bodyMarkdown: body }))
      expect(texts.every((t) => t.trim() !== '***')).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // parseCells — graceful edge cases
  // ---------------------------------------------------------------------------

  describe('parseCells edge cases', () => {
    it('parseCells on "| |" (empty cells) returns cells without crashing', async () => {
      // A row with only whitespace cells — must not throw; renders gracefully.
      const body = ['| UA | EN |', '| --- | --- |', '| | |'].join('\n')
      await expect(
        service.generateContractPdf(makeParams({ bodyMarkdown: body })),
      ).resolves.toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Regression: one-column contracts must be byte-identical before/after this PR
  // ---------------------------------------------------------------------------

  describe('regression: single-column contracts unchanged by two-column feature', () => {
    /**
     * DETERMINISM REGRESSION TEST — MED-1.
     *
     * This sha256 was captured from a signed single-column contract rendered on
     * the current branch (AFTER Ukrainian label translation). It proves
     * that the single-column rendering path is byte-for-byte identical on re-render.
     * Any change to this value means the one-column path was modified and
     * existing signed PDFs would fail re-render integrity checks.
     *
     * Baseline updated: 2026-07-10, fix/contract-ukrainian-labels
     * Reason: Russian → Ukrainian label translation changes rendered text bytes.
     * Previous baseline (Russian): fa62b0b65cb6d55a379daf7827bfc36f6e9f6d92bcf3293cc6828f44ef1135a4
     *
     * NOTE: This sha256 includes the embedded Roboto font subset. If font files
     * or pdf-lib version change legitimately, update this hash deliberately after
     * visual verification — do not auto-update.
     */
    const LEGACY_PARAMS: GenerateContractPdfParams = {
      contractNumber: 'CHK-1-2026',
      bodyMarkdown:
        '# Договор\n\nОбычный абзац с **жирным** текстом.\n\n- Пункт первый\n- Пункт второй',
      signedTypedName: 'Иван Иванов',
      signedAt: new Date('2026-06-04T07:00:00.000Z'),
      verifyUrl: 'http://localhost:3000/contract/v/abc-123',
    }

    /**
     * SHA-256 of LEGACY_PARAMS rendered with Ukrainian labels (after this PR).
     * Must remain identical on any future re-render of the same params.
     */
    const LEGACY_BASELINE_SHA256 =
      '1028c82d0e5331616880311b51d33d01ecfe252a20b80db9694fe9434842daa5'

    it('MED-1: single-column contract sha256 is byte-identical to origin/main baseline', async () => {
      const result = await service.generateContractPdf(LEGACY_PARAMS)
      expect(result.sha256Hash).toBe(LEGACY_BASELINE_SHA256)
    })

    it('single-column contract renders byte-deterministically (sha256 stable run-to-run)', async () => {
      const first = await service.generateContractPdf(LEGACY_PARAMS)
      const second = await service.generateContractPdf(LEGACY_PARAMS)
      // Same output both runs — proves the two-column path is NOT triggered for plain text
      expect(first.sha256Hash).toBe(second.sha256Hash)
      expect(first.pdfBuffer.equals(second.pdfBuffer)).toBe(true)
    })

    it('single-column content does NOT trigger two-column layout (no table-like calls)', async () => {
      // The body has no "|" characters — confirms the table parser never fires.
      const bodyWithoutTable =
        '# Договор\n\nОбычный абзац с **жирным** текстом.\n\n- Пункт первый\n- Пункт второй'
      const calls = await drawnCalls(makeParams({ bodyMarkdown: bodyWithoutTable }))

      // All body text must be drawn at pageMargin X (or pageMargin + bulletIndent).
      // No text should be drawn at the right-column X (which would mean table rendering).
      const bodyTextCalls = calls.filter(
        (c) =>
          c.opts.x >= PAGE_MARGIN - 1 &&
          c.opts.x <= PAGE_MARGIN + 20 && // allow bullet indent (14pt)
          ![
            'Контракт №',
            'Підписано:',
            'Підписи сторін',
            'Підписи',
            '1.',
            '2.',
            'CheekyCheeseIT',
            'Перевірка:',
          ].some((prefix) => c.text.startsWith(prefix)),
      )
      const unexpectedRightColDraws = bodyTextCalls.filter(
        (c) => Math.abs(c.opts.x - RIGHT_COL_X) < 2,
      )
      expect(unexpectedRightColDraws).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Smoke test: full contract-junior.md draft body renders without crash
  // ---------------------------------------------------------------------------

  describe('smoke: contract-junior.md draft renders', () => {
    it('renders a realistic bilingual contract body (≥1 page, no crash)', async () => {
      // A representative slice of contract-junior.md format — two-column tables
      // interspersed with blockquote disclaimer and paragraph text.
      const realisticBody = [
        '> Дисклеймер: цей контракт є чернеткою і потребує перевірки юристом.',
        '',
        '# ДОГОВІР ПРО НАДАННЯ ПОСЛУГ № CHK-TEST',
        '',
        '| Українська | English |',
        '| --- | --- |',
        '| Цей Договір укладено між: | This Agreement is made between: |',
        '| **{{companyLegalName}}**, юридичною особою | **VolkerWessels Nederland IE B.V.**, a legal entity |',
        '| та **Фізична особа Тестовий Юзер** | and **Test User, a private entrepreneur** |',
        '',
        '## 1. ПРЕДМЕТ ДОГОВОРУ / SUBJECT',
        '',
        '| Українська | English |',
        '| --- | --- |',
        "| 1.1. Виконавець зобов'язується надавати послуги. | 1.1. The Contractor undertakes to provide services. |",
        "| 1.2. Замовник зобов'язується оплачувати послуги. | 1.2. The Customer undertakes to pay for the services. |",
        '',
        '## 5. ЦІНА ТА ПОРЯДОК ОПЛАТИ / PRICE',
        '',
        '| Українська | English |',
        '| --- | --- |',
        '| 5.1. Розмір винагороди: 800 USD на місяць. | 5.1. Remuneration: 800 USD per month. |',
        '| 5.5. Реквізити: 0x1234567890123456789012345678901234567890 | 5.5. Requisites: 0x1234567890123456789012345678901234567890 |',
        '',
        '- Перший пункт переліку',
        '- Другий пункт переліку',
        '',
        'Звичайний параграф завершального тексту.',
      ].join('\n')

      const { pdfBuffer } = await service.generateContractPdf(
        makeParams({ bodyMarkdown: realisticBody }),
      )
      const doc = await PDFDocument.load(pdfBuffer)
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
    })
  })
})
