/**
 * Glyph coverage — asserted as a PROPERTY, not as a list of cases.
 *
 * WHY THIS FILE IS SHAPED LIKE THIS. The bug that started it was found by eye:
 * a smoke render of `5000 ₴ / 100 ₽` drew an empty box for the hryvnia and a
 * perfectly good ruble sign. The tempting fix — "replace the characters we know
 * are missing" — would have been wrong in BOTH directions: it mangles `₽`,
 * which renders fine, and it still misses `₾`, `₸`, `֏`, CJK, emoji, and
 * whatever a template author reaches for next month.
 *
 * And there is no help coming from the tool: Typst compiles a document with an
 * uncoverable character silently, exit code 0, no warning (verified against
 * 0.15.1 with `--diagnostic-format short`). If nothing here computes the
 * answer, nobody learns until a client opens the PDF.
 *
 * So the assertions below are of the form "for every character that can reach
 * the document, the font has a glyph" — including the TEMPLATE's own literals,
 * which is the half a data-only check would miss when someone adds an arrow or
 * a different dash to the layout.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { EMPTY_RESUME_CONTENT, DEFAULT_RESUME_LAYOUT } from '@crm/shared'
import { resolveAssetPath } from '../common/assets.util'
import {
  findUnrenderable,
  resumeFontCoverage,
  toRenderableDeep,
  toRenderableText,
} from './resume-glyphs'

const HRYVNIA = '₴'
const RUBLE = '₽'
const LARI = '₾'

describe('resume font coverage (measured from the cmap, not assumed)', () => {
  it('reads a real, non-trivial coverage set out of the shipped fonts', () => {
    const coverage = resumeFontCoverage()
    // Sanity floor: a cmap parser that silently returned nothing would make
    // every assertion below vacuously pass while dropping the entire alphabet.
    expect(coverage.size).toBeGreaterThan(400)
    expect(coverage.has('A'.codePointAt(0) as number)).toBe(true)
    expect(coverage.has('Ж'.codePointAt(0) as number)).toBe(true)
  })

  /**
   * The measurement that produced this whole mechanism, pinned so it cannot
   * quietly change under us. If a future font drop covers the hryvnia, this
   * test goes red and the substitution below should be reconsidered — which is
   * the correct moment to have that conversation.
   */
  it('confirms the asymmetry that made a hand-written list impossible', () => {
    const coverage = resumeFontCoverage()
    expect(coverage.has(HRYVNIA.codePointAt(0) as number)).toBe(false)
    expect(coverage.has(RUBLE.codePointAt(0) as number)).toBe(true)
  })
})

describe('the coverage check has teeth', () => {
  it('reports an uncovered character as unrenderable', () => {
    // Control for every `toEqual([])` below: the detector does find things.
    expect(findUnrenderable(`5000 ${HRYVNIA}`)).toEqual([HRYVNIA])
    expect(findUnrenderable('résumé — «цитата» · 100%')).toEqual([])
  })
})

describe('substitution', () => {
  it('turns an uncovered currency sign into its ISO code', () => {
    expect(toRenderableText(`5000 ${HRYVNIA}`).text).toBe('5000 UAH')
    expect(toRenderableText(`20 ${LARI}`).text).toBe('20 GEL')
  })

  it('leaves a covered currency sign alone', () => {
    // The reason the list is consulted only for uncovered codepoints: `₽` draws.
    expect(toRenderableText(`100 ${RUBLE}`).text).toBe(`100 ${RUBLE}`)
    expect(toRenderableText('100 €').text).toBe('100 €')
  })

  it('drops what it cannot draw or name, and reports it', () => {
    const result = toRenderableText('Иван 😀 漢字 Петров')
    expect(findUnrenderable(result.text)).toEqual([])
    expect(result.dropped).toEqual(['😀', '漢', '字'])
    // No double gap left where the characters were.
    expect(result.text).toBe('Иван Петров')
  })

  it('composes decomposed Cyrillic before judging it', () => {
    // NFD 'й' is 'и' followed by the combining breve U+0306. The mark has no
    // glyph of its own here; the composed letter does. Normalising before
    // judging is the difference between a rendered name and a name with a
    // letter silently deleted from it — and text pasted out of a PDF, or read
    // off a macOS filesystem path, arrives decomposed routinely.
    const decomposed = '\u0438\u0306ог'
    // Written as escapes on purpose: a decomposed literal is invisible in a
    // diff and an editor may silently re-compose it, which would turn this into
    // a test of nothing.
    expect(decomposed).toHaveLength(4)
    expect(resumeFontCoverage().has(0x0306)).toBe(false)

    const result = toRenderableText(decomposed)
    expect(result.text).toBe('йог')
    expect(result.dropped).toEqual([])
  })

  it('preserves structure when walking a whole resume', () => {
    const { value } = toRenderableDeep({
      displayName: `Иван ${HRYVNIA}`,
      content: {
        ...EMPTY_RESUME_CONTENT,
        skills: ['TypeScript', `Ставка 50 ${HRYVNIA}/ч`],
        experience: [
          { company: 'Акме', role: 'Лид', period: '2021', bullets: [`Бюджет 1000 ${HRYVNIA}`] },
        ],
      },
      layout: DEFAULT_RESUME_LAYOUT,
    })

    expect(value.displayName).toBe('Иван UAH')
    expect(value.content.skills).toEqual(['TypeScript', 'Ставка 50 UAH/ч'])
    expect(value.content.experience[0]?.bullets).toEqual(['Бюджет 1000 UAH'])
    // Arrays keep their length and order; keys keep their names.
    expect(Object.keys(value.content)).toEqual(Object.keys(EMPTY_RESUME_CONTENT))
  })
})

/**
 * THE PROPERTY, in the two places a character can enter the document.
 */
describe('every character that can reach the PDF has a glyph', () => {
  it('holds for any data, however hostile', () => {
    // A deliberately awful spread: currencies, CJK, emoji, RTL, combining
    // marks, control characters, astral codepoints.
    const nasty =
      `${HRYVNIA}${RUBLE}${LARI}€$£¥₸֏₹ 漢字 😀🏳️‍🌈 مرحبا שלום ` +
      'й é \u0000\u0007 𝕳𝖊𝖑𝖑𝖔 ⇒ → ﹪ ％ ‰ ± × ÷ … — – „“ «» ✓ ✗'

    const { value } = toRenderableDeep({
      displayName: nasty,
      content: {
        summary: nasty,
        skills: [nasty],
        experience: [{ company: nasty, role: nasty, period: nasty, bullets: [nasty] }],
        education: [{ institution: nasty, degree: nasty, period: nasty }],
        languages: [{ name: nasty, level: nasty }],
        links: [{ label: nasty, url: 'https://example.com' }],
      },
      layout: DEFAULT_RESUME_LAYOUT,
    })

    expect(findUnrenderable(JSON.stringify(value))).toEqual([])
  })

  /**
   * The half a data-only check misses.
   *
   * Section headings, the ` · ` separator and the ` — ` between a language and
   * its level are written in the TEMPLATE, not in the database, so no amount of
   * sanitising the data protects them. This is the guard the coordinator asked
   * for in as many words: add an arrow, a different dash or a fullwidth percent
   * sign to the layout and this goes red in CI, not in a client's inbox.
   */
  it('holds for EVERY character in the shipped template, however it is written', () => {
    const source = readFileSync(resolveAssetPath('typst/default-resume.typ'), 'utf8')

    // THE WHOLE FILE, not its quoted strings.
    //
    // The previous version scanned `"..."` literals only, and that is the same
    // defect as the file-intake bug it was written to avoid: the check covered
    // ONE way of writing a character while Typst accepts several. Content mode
    // is the obvious other one — `list(marker: [→])` puts an arrow on every
    // bullet of every resume, produces zero Typst warnings, and passed eleven
    // green assertions while the PDF grew an empty box per line.
    //
    // Scanning the entire source cannot miss a form, because every character
    // that reaches the page is somewhere in this file. It is deliberately
    // STRICTER than necessary — a character used only in a comment is flagged
    // too — and that is the right trade: the cost is rewriting `→` as `->` in
    // a comment, and the alternative is enumerating Typst's syntax forever.
    const offenders = findUnrenderable(source)

    expect(offenders).toEqual([])
  })

  /**
   * Glyphs the TYPESETTER introduces that appear nowhere in the source.
   *
   * `list()` draws its own marker, so `•` reaches the page without being
   * written down. Enumerated rather than derived — and this time the claim is
   * accurate: overriding the marker (`list(marker: [→])`) writes the character
   * INTO the file, where the whole-file scan above sees it. The earlier
   * comment asserted the same thing about a literal-only scan, which was
   * simply false; content mode never entered a quoted string.
   */
  it('holds for the markers the typesetter adds by itself', () => {
    expect(findUnrenderable('•')).toEqual([])
  })

  /**
   * KNOWN LIMIT — personal templates are NOT covered by any of the above.
   *
   * The scan reads the template shipped in this repo. A senior's own template
   * lives in `senior_resumes.template_source`, is authored by the designer, and
   * never passes through here — so an arrow or an em dash in a personal layout
   * boxes out with no test, no Typst warning (it compiles happily, exit 0) and
   * no signal until someone opens the PDF.
   *
   * Not closable yet in any honest way: no code path writes that column, so
   * there is nothing to scan and nothing to regress against. It is recorded as
   * a test rather than a comment so that whoever adds the write path meets this
   * paragraph — the check they need is `findUnrenderable(templateSource)` at
   * the moment a template is SAVED, which is the only place the source exists
   * and the only moment a human can still fix it.
   */
  it('does not yet cover a senior’s own template — recorded, not silently missing', () => {
    // The guarantee the shipped template gets...
    const shipped = readFileSync(resolveAssetPath('typst/default-resume.typ'), 'utf8')
    expect(findUnrenderable(shipped)).toEqual([])

    // ...is exactly what a personal template would need and does not have. This
    // is the check that belongs on the (not yet existing) save path.
    const personalTemplateWithAnArrow = '#let render(data) = [→ #data.displayName]'
    expect(findUnrenderable(personalTemplateWithAnArrow)).toEqual(['→'])
  })
})
