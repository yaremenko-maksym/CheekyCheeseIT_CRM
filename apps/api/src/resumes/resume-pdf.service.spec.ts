/**
 * AC8 — the resume PDF renders Cyrillic through the SHARED PdfGenerationService
 * (embedded Roboto), opens as a real PDF, and has a selectable text layer.
 * AC7 — injected content in a resume cannot break the PDF.
 *
 * The assertions read the rendered bytes back with `unpdf` (the same parser the
 * upload path uses) rather than grepping the raw stream: pdf-lib compresses
 * content streams, so a text grep would pass on a document that renders nothing
 * but boxes. Round-tripping through a parser proves the glyphs are really there
 * and really extractable.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { ResumePdfService, wrapText } from './resume-pdf.service'

const service = new ResumePdfService(new PdfGenerationService())
const AT = new Date('2026-08-07T12:00:00Z')

const FULL_CONTENT: ResumeContent = {
  summary: 'Синьор-разработчик с восьмилетним опытом в TypeScript и Node.js.',
  skills: ['TypeScript', 'NestJS', 'Проектирование систем'],
  experience: [
    {
      company: 'Акме Технологии',
      role: 'Технический лидер',
      period: '2021 — наст. время',
      bullets: ['Руководил командой из пяти инженеров', 'Перевёл монолит на модули'],
    },
  ],
  education: [{ institution: 'КПІ', degree: 'Магистр информатики', period: '2012–2018' }],
  languages: [{ name: 'Английский', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/example' }],
}

async function renderAndExtract(content: ResumeContent, displayName = 'Иван Петров') {
  const pdf = await service.generateResumePdf({ displayName, content, generatedAt: AT })
  const { extractText, getDocumentProxy } = await import('unpdf')
  const proxy = await getDocumentProxy(new Uint8Array(pdf))
  const { text } = await extractText(proxy, { mergePages: true })
  return { pdf, text, pages: proxy.numPages }
}

describe('ResumePdfService (AC8)', () => {
  it('produces a real PDF whose Cyrillic text is extractable (i.e. selectable, not boxes)', async () => {
    const { pdf, text } = await renderAndExtract(FULL_CONTENT)

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)

    expect(text).toContain('Иван Петров')
    expect(text).toContain('Синьор-разработчик')
    expect(text).toContain('Технический лидер')
    expect(text).toContain('Акме Технологии')
    expect(text).toContain('Руководил командой из пяти инженеров')
    expect(text).toContain('Магистр информатики')
    expect(text).toContain('Английский')
    expect(text).toContain('https://github.com/example')
  })

  it('renders section headings in Russian', async () => {
    const { text } = await renderAndExtract(FULL_CONTENT)
    expect(text).toContain('ОПЫТ РАБОТЫ')
    expect(text).toContain('ОБРАЗОВАНИЕ')
    expect(text).toContain('НАВЫКИ')
  })

  it('is deterministic — same input renders byte-identical output', async () => {
    const a = await service.generateResumePdf({
      displayName: 'Иван Петров',
      content: FULL_CONTENT,
      generatedAt: AT,
    })
    const b = await service.generateResumePdf({
      displayName: 'Иван Петров',
      content: FULL_CONTENT,
      generatedAt: AT,
    })
    expect(a.equals(b)).toBe(true)
  })

  it('renders an empty resume without crashing', async () => {
    const { pdf, text } = await renderAndExtract(EMPTY_RESUME_CONTENT, 'Пустой Профиль')
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(text).toContain('Пустой Профиль')
  })

  it('AC7: injected markup and long unbroken junk render as inert text without breaking the PDF', async () => {
    const hostile: ResumeContent = {
      ...EMPTY_RESUME_CONTENT,
      summary: '<script>alert(1)</script> ((( \\n %%EOF endobj',
      skills: ['A'.repeat(400)],
      links: [{ label: 'Сайт', url: `https://example.com/${'z'.repeat(400)}` }],
    }
    const { pdf, text } = await renderAndExtract(hostile)

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // Drawn literally — the PDF has no markdown/HTML pass at all.
    expect(text).toContain('<script>alert(1)</script>')
  })

  it('paginates instead of overflowing when the content is long', async () => {
    const long: ResumeContent = {
      ...EMPTY_RESUME_CONTENT,
      experience: Array.from({ length: 20 }, (_, i) => ({
        company: `Компания ${i}`,
        role: 'Разработчик',
        period: '2020–2024',
        bullets: ['Делал важные вещи в проекте', 'Ещё одна строка достижений'],
      })),
    }
    const { pages, text } = await renderAndExtract(long)
    expect(pages).toBeGreaterThan(1)
    expect(text).toContain('Компания 19')
  })
})

describe('wrapText', () => {
  it('hard-splits a single word wider than the line (untrusted input cannot overflow)', async () => {
    const { regularFont } = await new PdfGenerationService().createDocument()
    const lines = wrapText('Z'.repeat(300), regularFont, 10, 200)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(regularFont.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(200)
    }
  })

  it('wraps on word boundaries when it can', async () => {
    const { regularFont } = await new PdfGenerationService().createDocument()
    const lines = wrapText('раз два три четыре пять шесть семь восемь', regularFont, 10, 80)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ')).toContain('четыре')
  })
})
