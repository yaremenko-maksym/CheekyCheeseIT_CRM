/**
 * The ATS suite (verified-base-resume spec §7). Run with `pnpm --filter @crm/api test:ats`;
 * the default `test` run excludes `*.ats.spec.ts` (vitest.config.mts).
 *
 * Every catalog template × every synthetic fixture is rendered by the real Typst
 * binary and read back by the real extraction worker, then:
 *   - passes `checkResumeAts` (the §5.3 gate);
 *   - reads back to the same headings, items and skills on every template (A3);
 *   - extracts exactly the committed golden text (`ATS_UPDATE_GOLDEN=1` rewrites them);
 * and two deliberately broken templates prove the checker sees what it claims to.
 *
 * `ATS_MATRIX_OUT=<dir>` also writes every matrix PDF there as `<template>.<fixture>.pdf`,
 * for the external parser oracle (CI).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  RESUME_TEMPLATE_NAMES,
  normalizeResumeLayout,
  type ResumeContent,
  type ResumeTemplateName,
} from '@crm/shared'
import { assertTypstAvailable } from '../../../test/typst-availability'
import { toRenderableDeep, type GlyphFontSet } from '../../resume-glyphs'
import { ResumeTextExtractionService } from '../../resume-text-extraction.service'
import { ResumeTypstService } from '../../resume-typst.service'
import { checkResumeAts, type AtsReport } from '../resume-ats-checker'
import { ATS_FIXTURES, type AtsFixture } from './fixtures'
import { parseExtracted, type ParsedResume } from './parse-extracted'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const GOLDEN_DIR = join(HERE, 'golden')
const UPDATE_GOLDEN = process.env['ATS_UPDATE_GOLDEN'] === '1'
const MATRIX_OUT = process.env['ATS_MATRIX_OUT']
/**
 * Fixtures the equivalence check does not read back.
 * shortcut: parseExtracted cannot split a wrapped role from a wrapped company, so `long-names-wrapped`
 * is checked by the matrix and the goldens only; upgrade when the extraction exposes font runs.
 */
const EQUIVALENCE_SKIP = new Set(['long-names-wrapped'])
/** Between pages in a golden file. */
const PAGE_BREAK = '\n\f\n'

const scratch = mkdtempSync(join(tmpdir(), 'resume-ats-suite-'))
const typst = new ResumeTypstService(undefined, scratch)
const extraction = new ResumeTextExtractionService()

interface Rendered {
  pdf: Buffer
  pages: string[]
}

const PAIRS = RESUME_TEMPLATE_NAMES.flatMap((template) =>
  ATS_FIXTURES.map((fixture) => ({ template, fixture, key: `${template}.${fixture.name}` })),
)
const rendered = new Map<string, Rendered>()

/** What the renderer typeset: the checker compares against this, not the stored text. */
function renderable(content: ResumeContent, fontSet: GlyphFontSet): ResumeContent {
  return toRenderableDeep(content, fontSet).value
}

async function renderAndExtract(
  fixture: AtsFixture,
  templateName: ResumeTemplateName,
  templateSource: string | null,
): Promise<Rendered> {
  const pdf = await typst.render({
    displayName: fixture.displayName,
    email: fixture.email,
    content: fixture.content,
    layout: DEFAULT_RESUME_LAYOUT,
    templateName,
    templateSource,
  })
  return { pdf, pages: await extraction.extractRenderedPages(pdf) }
}

function check(fixture: AtsFixture, fontSet: GlyphFontSet, result: Rendered): AtsReport {
  return checkResumeAts({
    content: renderable(fixture.content, fontSet),
    layout: DEFAULT_RESUME_LAYOUT,
    displayName: fixture.displayName,
    email: fixture.email,
    pages: result.pages,
    pdfBytes: result.pdf.length,
  })
}

function get(key: string): Rendered {
  const result = rendered.get(key)
  if (!result) throw new Error(`No render for ${key}`)
  return result
}

beforeAll(async () => {
  assertTypstAvailable()
  if (MATRIX_OUT) mkdirSync(MATRIX_OUT, { recursive: true })
  // The service's own semaphore bounds the concurrency.
  await Promise.all(
    PAIRS.map(async ({ template, fixture, key }) => {
      const result = await renderAndExtract(fixture, template, null)
      rendered.set(key, result)
      if (MATRIX_OUT) writeFileSync(join(MATRIX_OUT, `${key}.pdf`), result.pdf)
    }),
  )
}, 600_000)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('ATS matrix', () => {
  it.each(PAIRS)('$key passes checkResumeAts', ({ template, fixture, key }) => {
    expect(check(fixture, template, get(key))).toEqual({ ok: true, failures: [] })
  })

  it('parsed field set is identical across templates', () => {
    const layout = normalizeResumeLayout(DEFAULT_RESUME_LAYOUT)
    for (const fixture of ATS_FIXTURES) {
      if (EQUIVALENCE_SKIP.has(fixture.name)) continue
      for (const template of RESUME_TEMPLATE_NAMES) {
        // The independent expectation: what the fixture says should be readable, in this template's glyphs.
        const content = renderable(fixture.content, template)
        const expected: ParsedResume = {
          headings: layout.sectionOrder
            .filter((key) => (key === 'summary' ? content.summary !== '' : content[key].length > 0))
            .map((key) => key.charAt(0).toUpperCase() + key.slice(1)),
          items: content.experience.map(({ role, company, period }) => ({ role, company, period })),
          skills: content.skills,
        }
        const parsed = parseExtracted(get(`${template}.${fixture.name}`).pages)
        expect(parsed, `${template}.${fixture.name}`).toEqual(expected)
      }
    }
  })

  it('extracted text equals golden', () => {
    if (UPDATE_GOLDEN) mkdirSync(GOLDEN_DIR, { recursive: true })
    const mismatches: string[] = []
    for (const { key } of PAIRS) {
      const text = get(key).pages.join(PAGE_BREAK) + '\n'
      const file = join(GOLDEN_DIR, `${key}.txt`)
      if (UPDATE_GOLDEN) writeFileSync(file, text, 'utf8')
      else if (!existsSync(file))
        mismatches.push(`${key}: no golden (run with ATS_UPDATE_GOLDEN=1)`)
      else if (readFileSync(file, 'utf8') !== text) mismatches.push(`${key}: differs from golden`)
    }
    // A golden with no pair is a renamed or removed fixture whose file was left behind.
    const keys = new Set(PAIRS.map(({ key }) => `${key}.txt`))
    for (const file of readdirSync(GOLDEN_DIR)) {
      if (file.endsWith('.txt') && !keys.has(file))
        mismatches.push(`${file}: orphan golden, delete it`)
    }
    expect(mismatches).toEqual([])
  })
})

describe('negative controls', () => {
  const career = ATS_FIXTURES.find((fixture) => fixture.name === 'career-15y')!
  const codes = (report: AtsReport) => report.failures.map((failure) => failure.code)

  async function checkNegative(file: string): Promise<AtsReport> {
    const source = readFileSync(join(HERE, 'negative', file), 'utf8')
    return check(career, 'personal', await renderAndExtract(career, 'classic', source))
  }

  it("the negative controls' shared skeleton without a defect passes", async () => {
    expect(await checkNegative('clean.typ')).toEqual({ ok: true, failures: [] })
  }, 60_000)

  it('two-column negative control fails with ITEM_ORDER or MISSING_TEXT', async () => {
    const report = await checkNegative('two-column.typ')
    expect(report.ok).toBe(false)
    // The defect is in the experience section, so the failure must name an experience field.
    const inExperience = report.failures.filter(
      ({ code, path }) =>
        (code === 'ITEM_ORDER' || code === 'MISSING_TEXT') && path?.startsWith('experience['),
    )
    expect(inExperience).not.toEqual([])
  }, 60_000)

  it('letter-spaced negative control fails with LETTER_SPACED', async () => {
    const report = await checkNegative('letter-spaced.typ')
    expect(report.ok).toBe(false)
    expect(codes(report)).toContain('LETTER_SPACED')
  }, 60_000)
})
