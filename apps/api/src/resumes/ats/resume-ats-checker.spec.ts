/**
 * ATS checker (verified-base-resume spec §5.3).
 *
 * The rule tests run on hand-written `pages` arrays shaped like what `unpdf`
 * returns for our skeleton (one string per page, `\n` at every visual line end,
 * bullets prefixed with `• `). The last block renders the real `classic`
 * template, so the shape assumed here is pinned to the real extractor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RESUME_LAYOUT, type ResumeContent, type ResumeLayoutOptions } from '@crm/shared'
import { buildEmptyPdf } from '../../test/resume-fixtures'
import { assertTypstAvailable } from '../../test/typst-availability'
import {
  ResumeFileUnreadableError,
  ResumeTextExtractionService,
} from '../resume-text-extraction.service'
import { ResumeTypstService } from '../resume-typst.service'
import { formatPeriod } from '../verification/derive-content'
import {
  ATS_MAX_BYTES,
  ATS_MAX_PAGES,
  PERIOD_PATTERN,
  checkResumeAts,
  type AtsCheckInput,
  type AtsFailureCode,
} from './resume-ats-checker'

const CONTENT: ResumeContent = {
  summary: 'Senior engineer with ten years of experience.',
  skills: ['TypeScript', 'NestJS'],
  experience: [
    {
      role: 'Tech Lead',
      company: 'Acme Corp',
      period: 'Mar 2021 – Present',
      bullets: ['Led a team of five engineers', 'Cut p95 latency by 40%'],
    },
    {
      role: 'Engineer',
      company: 'Globex',
      period: 'Jan 2018 – Feb 2021',
      bullets: ['Built the billing service'],
    },
  ],
  education: [{ institution: 'MIT', degree: 'BSc Computer Science', period: '2012 – 2016' }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/x' }],
}

/** What `unpdf` returns for CONTENT rendered with the default layout. */
const CLEAN_PAGE = [
  'Jane Doe',
  'jane@example.com',
  'Summary',
  'Senior engineer with ten years of experience.',
  'Skills',
  'TypeScript · NestJS',
  'Experience',
  'Tech Lead',
  'Acme Corp',
  'Mar 2021 – Present',
  '• Led a team of five engineers',
  '• Cut p95 latency by 40%',
  'Engineer',
  'Globex',
  'Jan 2018 – Feb 2021',
  '• Built the billing service',
  'Education',
  'MIT',
  'BSc Computer Science',
  '2012 – 2016',
  'Languages',
  'English — C1',
  'Links',
  'GitHub',
]

function input(overrides: Partial<AtsCheckInput> = {}): AtsCheckInput {
  return {
    content: CONTENT,
    layout: DEFAULT_RESUME_LAYOUT,
    displayName: 'Jane Doe',
    email: 'jane@example.com',
    pages: [CLEAN_PAGE.join('\n')],
    pdfBytes: 40_000,
    ...overrides,
  }
}

function layout(overrides: Partial<ResumeLayoutOptions>): ResumeLayoutOptions {
  return { ...DEFAULT_RESUME_LAYOUT, ...overrides }
}

/** CLEAN_PAGE with one line replaced (or removed with `null`). */
function pageWith(from: string, to: string | null): string {
  expect(CLEAN_PAGE).toContain(from)
  return CLEAN_PAGE.flatMap((line) => (line === from ? (to === null ? [] : [to]) : [line])).join(
    '\n',
  )
}

function codes(report: { failures: Array<{ code: AtsFailureCode }> }): AtsFailureCode[] {
  return report.failures.map((failure) => failure.code)
}

describe('checkResumeAts — clean input', () => {
  it('a clean extraction passes with no failures', () => {
    expect(checkResumeAts(input())).toEqual({ ok: true, failures: [] })
  })

  it('a bullet wrapped over two lines still matches after whitespace normalisation', () => {
    const page = pageWith('• Led a team of five engineers', '• Led a team of\nfive   engineers')
    expect(checkResumeAts(input({ pages: [page] }))).toEqual({ ok: true, failures: [] })
  })

  it('compact puts the period on the role line, before the company, and still passes', () => {
    const page = pageWith('Tech Lead', 'Tech Lead Mar 2021 – Present').replace(
      'Acme Corp\nMar 2021 – Present\n',
      'Acme Corp\n',
    )
    expect(checkResumeAts(input({ pages: [page] }))).toEqual({ ok: true, failures: [] })
  })

  it('surrounding whitespace on a heading line does not stop it counting as alone', () => {
    const page = pageWith('Skills', '  Skills\t')
    expect(checkResumeAts(input({ pages: [page] })).ok).toBe(true)
  })

  it('a two-page extraction within the limit passes', () => {
    const top = CLEAN_PAGE.slice(0, 12).join('\n')
    const rest = CLEAN_PAGE.slice(12).join('\n')
    expect(checkResumeAts(input({ pages: [top, rest] }))).toEqual({ ok: true, failures: [] })
  })
})

describe('MISSING_TEXT', () => {
  it('a bullet absent from the text layer is reported with its path', () => {
    const report = checkResumeAts(input({ pages: [pageWith('• Cut p95 latency by 40%', null)] }))
    expect(report.ok).toBe(false)
    expect(report.failures).toEqual([
      {
        code: 'MISSING_TEXT',
        path: 'experience[0].bullets[1]',
        detail: 'Not found in the extracted text: "Cut p95 latency by 40%"',
      },
    ])
  })

  it.each([
    ['summary', 'Senior engineer with ten years of experience.', 'summary'],
    ['a skill', 'TypeScript · NestJS', 'skills[1]'],
    ['a role', 'Engineer', 'experience[1].role'],
    ['a company', 'Globex', 'experience[1].company'],
    ['an education institution', 'MIT', 'education[0].institution'],
    ['an education degree', 'BSc Computer Science', 'education[0].degree'],
    ['an education period', '2012 – 2016', 'education[0].period'],
    ['a language', 'English — C1', 'languages[0]'],
    ['a link label', 'GitHub', 'links[0].label'],
  ])('%s that did not extract is reported', (_name, line, path) => {
    const replacement = line === 'TypeScript · NestJS' ? 'TypeScript' : null
    const report = checkResumeAts(input({ pages: [pageWith(line, replacement)] }))
    expect(report.failures.filter((f) => f.code === 'MISSING_TEXT').map((f) => f.path)).toEqual([
      path,
    ])
  })

  it('an experience period that did not extract is reported once, as missing text', () => {
    const report = checkResumeAts(input({ pages: [pageWith('Jan 2018 – Feb 2021', null)] }))
    expect(report.failures).toEqual([
      expect.objectContaining({ code: 'MISSING_TEXT', path: 'experience[1].period' }),
    ])
  })

  it('matching is case-sensitive: verbatim text, not a fuzzy match', () => {
    const report = checkResumeAts(input({ pages: [pageWith('Globex', 'GLOBEX')] }))
    expect(report.failures).toEqual([
      expect.objectContaining({ code: 'MISSING_TEXT', path: 'experience[1].company' }),
    ])
  })

  it('a hidden section is not expected in the text', () => {
    const page = CLEAN_PAGE.slice(0, CLEAN_PAGE.indexOf('Links')).join('\n')
    const report = checkResumeAts(
      input({ pages: [page], layout: layout({ hiddenSections: ['links'] }) }),
    )
    expect(report).toEqual({ ok: true, failures: [] })
  })

  it('an empty education degree is not printed and not expected', () => {
    const content: ResumeContent = {
      ...CONTENT,
      education: [{ institution: 'MIT', degree: '', period: '2012 – 2016' }],
    }
    const report = checkResumeAts(
      input({ content, pages: [pageWith('BSc Computer Science', null)] }),
    )
    expect(report).toEqual({ ok: true, failures: [] })
  })
})

describe('headings', () => {
  it('HEADING_MISSING when a visible section has no heading line', () => {
    const report = checkResumeAts(input({ pages: [pageWith('Education', null)] }))
    expect(report.failures).toEqual([
      {
        code: 'HEADING_MISSING',
        path: 'education',
        detail: 'Heading "Education" is not alone on a line',
      },
    ])
  })

  it('HEADING_MISSING when the heading shares its line with other text', () => {
    const page = pageWith('Skills', null).replace(
      'TypeScript · NestJS',
      'Skills TypeScript · NestJS',
    )
    expect(codes(checkResumeAts(input({ pages: [page] })))).toEqual(['HEADING_MISSING'])
  })

  it('a section with nothing to print needs no heading', () => {
    const content: ResumeContent = { ...CONTENT, summary: '   ', languages: [] }
    const page = CLEAN_PAGE.filter(
      (line) =>
        ![
          'Summary',
          'Senior engineer with ten years of experience.',
          'Languages',
          'English — C1',
        ].includes(line),
    ).join('\n')
    expect(checkResumeAts(input({ content, pages: [page] }))).toEqual({ ok: true, failures: [] })
  })

  it('HEADING_ORDER when two headings appear out of the effective order', () => {
    const swapped = [...CLEAN_PAGE]
    const skills = swapped.splice(4, 2)
    swapped.splice(swapped.indexOf('Education'), 0, ...skills)
    const report = checkResumeAts(input({ pages: [swapped.join('\n')] }))
    expect(report.failures).toEqual([
      {
        code: 'HEADING_ORDER',
        detail:
          'Headings are "Summary, Experience, Skills, Education, Languages, Links", expected "Summary, Skills, Experience, Education, Languages, Links"',
      },
    ])
  })

  it('the effective order comes from the normalised layout, not the default', () => {
    const swapped = [...CLEAN_PAGE]
    const skills = swapped.splice(4, 2)
    swapped.splice(swapped.indexOf('Education'), 0, ...skills)
    const custom = layout({ sectionOrder: ['summary', 'experience', 'skills'] })
    expect(checkResumeAts(input({ layout: custom, pages: [swapped.join('\n')] }))).toEqual({
      ok: true,
      failures: [],
    })
  })

  it('HIDDEN_SECTION_PRESENT when a hidden section still prints its heading', () => {
    const report = checkResumeAts(input({ layout: layout({ hiddenSections: ['languages'] }) }))
    expect(report.failures).toEqual([
      {
        code: 'HIDDEN_SECTION_PRESENT',
        path: 'languages',
        detail: 'Hidden section "Languages" is present in the text',
      },
    ])
  })
})

describe('ITEM_ORDER', () => {
  it('a bullet printed before its own role is out of order', () => {
    const page = CLEAN_PAGE.filter((line) => line !== '• Built the billing service')
    page.splice(page.indexOf('Engineer'), 0, '• Built the billing service')
    const report = checkResumeAts(input({ pages: [page.join('\n')] }))
    expect(report.failures).toEqual([
      {
        code: 'ITEM_ORDER',
        path: 'experience[1].bullets[0]',
        detail: 'Not after the header of its own item: "Built the billing service"',
      },
    ])
  })

  it('two items interleaving (both headers, then both bullet lists) is out of order', () => {
    const page = [
      ...CLEAN_PAGE.slice(0, 10),
      'Engineer',
      'Globex',
      'Jan 2018 – Feb 2021',
      '• Led a team of five engineers',
      '• Cut p95 latency by 40%',
      '• Built the billing service',
      ...CLEAN_PAGE.slice(16),
    ]
    const report = checkResumeAts(input({ pages: [page.join('\n')] }))
    expect(report.failures.map((f) => [f.code, f.path])).toEqual([
      ['ITEM_ORDER', 'experience[1].role'],
    ])
  })

  it('the company printed after the bullets is out of order', () => {
    const page = CLEAN_PAGE.filter((line) => line !== 'Globex')
    page.splice(page.indexOf('Education'), 0, 'Globex')
    const report = checkResumeAts(input({ pages: [page.join('\n')] }))
    expect(report.failures.map((f) => [f.code, f.path])).toEqual([
      ['ITEM_ORDER', 'experience[1].bullets[0]'],
    ])
  })

  it('an item header that only occurs before the Experience heading is out of order', () => {
    const content: ResumeContent = {
      ...CONTENT,
      summary: 'Senior engineer with ten years of experience. Tech Lead.',
    }
    const page = pageWith(
      'Senior engineer with ten years of experience.',
      'Senior engineer with ten years of experience. Tech Lead.',
    ).replace('Experience\nTech Lead\n', 'Experience\n')
    const report = checkResumeAts(input({ content, pages: [page] }))
    expect(report.failures.map((f) => [f.code, f.path])).toEqual([
      ['ITEM_ORDER', 'experience[0].role'],
    ])
  })

  it('a hidden experience section is not order-checked', () => {
    const content: ResumeContent = {
      ...CONTENT,
      summary: 'Engineer at Globex. Built the billing service.',
    }
    const page = CLEAN_PAGE.slice(0, CLEAN_PAGE.indexOf('Experience'))
      .map((line) => (line.startsWith('Senior') ? content.summary : line))
      .concat(CLEAN_PAGE.slice(CLEAN_PAGE.indexOf('Education')))
    const report = checkResumeAts(
      input({
        content,
        layout: layout({ hiddenSections: ['experience'] }),
        pages: [page.join('\n')],
      }),
    )
    expect(report).toEqual({ ok: true, failures: [] })
  })
})

describe('PERIOD_FORMAT', () => {
  it('a period that is not the one date format fails, even when it extracts verbatim', () => {
    const content: ResumeContent = {
      ...CONTENT,
      experience: [
        { ...CONTENT.experience[0]!, period: '2021 — наст. время' },
        CONTENT.experience[1]!,
      ],
    }
    const page = pageWith('Mar 2021 – Present', '2021 — наст. время')
    const report = checkResumeAts(input({ content, pages: [page] }))
    expect(report.failures).toEqual([
      {
        code: 'PERIOD_FORMAT',
        path: 'experience[0].period',
        detail: 'Period "2021 — наст. время" is not in the "Mar 2021 – May 2023" format',
      },
    ])
  })

  it('an empty period is skipped: completeness owns missing dates', () => {
    const content: ResumeContent = {
      ...CONTENT,
      experience: [{ ...CONTENT.experience[0]!, period: '' }, CONTENT.experience[1]!],
    }
    const page = pageWith('Mar 2021 – Present', null)
    expect(checkResumeAts(input({ content, pages: [page] }))).toEqual({ ok: true, failures: [] })
  })
})

describe('PERIOD_PATTERN', () => {
  it.each([
    ['2021-03', '2023-05', false],
    ['2021-03', null, true],
    ['2021-03', null, false],
    ['1999-12', '2000-01', false],
    ['2024-01', '2024-10', false],
  ])('matches formatPeriod(%s, %s, %s)', (start, end, current) => {
    const formatted = formatPeriod(start, end, current)
    expect(formatted).not.toBe('')
    expect(PERIOD_PATTERN.test(formatted)).toBe(true)
  })

  it('matches every month label formatPeriod can print', () => {
    for (let month = 1; month <= 12; month += 1) {
      const key = `2020-${String(month).padStart(2, '0')}`
      expect(PERIOD_PATTERN.test(formatPeriod(key, '2021-06', false))).toBe(true)
      expect(PERIOD_PATTERN.test(formatPeriod('2019-06', key, false))).toBe(true)
    }
  })

  it.each([
    'March 2021 - May 2023',
    'Mar 2021 - May 2023',
    'Mar 2021 — May 2023',
    'Mar 2021 – May 2023 ',
    ' Mar 2021',
    'Mar 2021 – present',
    'mar 2021',
    'Mar 21',
    'Mar 2021 – Present – May 2023',
    'x Mar 2021 – May 2023',
    'Mar 2021 – May 2023 x',
    '2021',
    '',
  ])('rejects the near-miss %j', (value) => {
    expect(PERIOD_PATTERN.test(value)).toBe(false)
  })
})

describe('CONTACT_NOT_IN_BODY', () => {
  it('the name missing from page 1 before the first heading fails', () => {
    const report = checkResumeAts(input({ pages: [pageWith('Jane Doe', null)] }))
    expect(report.failures).toEqual([
      {
        code: 'CONTACT_NOT_IN_BODY',
        path: 'displayName',
        detail: 'Name is not on page 1 before the first heading',
      },
    ])
  })

  it('the email only after the first heading fails', () => {
    const page = pageWith('jane@example.com', null).replace(
      'Skills\n',
      'Skills\njane@example.com\n',
    )
    const report = checkResumeAts(input({ pages: [page] }))
    expect(report.failures).toEqual([
      {
        code: 'CONTACT_NOT_IN_BODY',
        path: 'email',
        detail: 'Email is not on page 1 before the first heading',
      },
    ])
  })

  it('the contact block on page 2 only fails', () => {
    const page = CLEAN_PAGE.slice(2).join('\n')
    const report = checkResumeAts(input({ pages: [page, 'Jane Doe\njane@example.com'] }))
    expect(report.failures.map((f) => [f.code, f.path])).toEqual([
      ['CONTACT_NOT_IN_BODY', 'displayName'],
      ['CONTACT_NOT_IN_BODY', 'email'],
    ])
  })

  it('a name on the same line as the email still counts', () => {
    const page = pageWith('Jane Doe', null).replace('jane@example.com', 'Jane Doe jane@example.com')
    expect(checkResumeAts(input({ pages: [page] })).ok).toBe(true)
  })

  it('an empty name and email are not printed, so they are not required', () => {
    const page = CLEAN_PAGE.slice(2).join('\n')
    expect(checkResumeAts(input({ displayName: ' ', email: '', pages: [page] }))).toEqual({
      ok: true,
      failures: [],
    })
  })

  it('with no heading at all the whole of page 1 is the body', () => {
    const empty: ResumeContent = {
      summary: '',
      skills: [],
      experience: [],
      education: [],
      languages: [],
      links: [],
    }
    const report = checkResumeAts(input({ content: empty, pages: ['Jane Doe\njane@example.com'] }))
    expect(report).toEqual({ ok: true, failures: [] })
  })
})

describe('glyph checks', () => {
  it('REPLACEMENT_CHAR on U+FFFD anywhere in the text', () => {
    const report = checkResumeAts(input({ pages: [CLEAN_PAGE.join('\n'), 'note �'] }))
    expect(report.failures).toEqual([
      {
        code: 'REPLACEMENT_CHAR',
        path: 'pages[1]',
        detail: 'U+FFFD (replacement character) in the text',
      },
    ])
  })

  it.each([
    ['ﬀ', 'U+FB00'],
    ['ﬁ', 'U+FB01'],
    ['ﬆ', 'U+FB06'],
  ])('LIGATURE on %s', (char, label) => {
    const report = checkResumeAts(input({ pages: [`${CLEAN_PAGE.join('\n')}\nef${char}cient`] }))
    expect(report.failures).toEqual([
      { code: 'LIGATURE', path: 'pages[0]', detail: `Ligature code point ${label} in the text` },
    ])
  })

  it.each(['﫿', '﬇'])('no LIGATURE on the neighbour %j', (char) => {
    const report = checkResumeAts(input({ pages: [`${CLEAN_PAGE.join('\n')}\n${char}`] }))
    expect(report).toEqual({ ok: true, failures: [] })
  })

  it.each(['E X P E R I E N C E', 'e x p e r i e n c e', 'É x p é r i e n c e', 'S k i l'])(
    'LETTER_SPACED on %j',
    (line) => {
      const report = checkResumeAts(input({ pages: [`${CLEAN_PAGE.join('\n')}\n${line}`] }))
      expect(report.failures).toEqual([
        { code: 'LETTER_SPACED', path: 'pages[0]', detail: `Letter-spaced text: "${line}"` },
      ])
    },
  )

  it.each(['A B testing', 'S k iX', 'A B C', '1 2 3 4', 'éA B C D'])(
    'no LETTER_SPACED on %j',
    (line) => {
      const report = checkResumeAts(input({ pages: [`${CLEAN_PAGE.join('\n')}\n${line}`] }))
      expect(report).toEqual({ ok: true, failures: [] })
    },
  )
})

describe('size limits', () => {
  it('constants are the spec values', () => {
    expect(ATS_MAX_PAGES).toBe(2)
    expect(ATS_MAX_BYTES).toBe(1_048_576)
  })

  it('TOO_MANY_PAGES above two pages', () => {
    const report = checkResumeAts(input({ pages: [CLEAN_PAGE.join('\n'), '', ''] }))
    expect(report.failures).toEqual([{ code: 'TOO_MANY_PAGES', detail: '3 pages, the limit is 2' }])
  })

  it('TOO_LARGE above 1 MiB, and exactly 1 MiB passes', () => {
    expect(checkResumeAts(input({ pdfBytes: 1_048_576 })).ok).toBe(true)
    expect(checkResumeAts(input({ pdfBytes: 1_048_577 })).failures).toEqual([
      { code: 'TOO_LARGE', detail: '1048577 bytes, the limit is 1048576' },
    ])
  })

  it('an empty extraction (no text layer) fails every visible string, not silently', () => {
    const report = checkResumeAts(input({ pages: [''] }))
    expect(report.ok).toBe(false)
    expect(codes(report)).toContain('MISSING_TEXT')
    expect(codes(report)).toContain('HEADING_MISSING')
    expect(codes(report)).toContain('CONTACT_NOT_IN_BODY')
  })

  it('no pages at all is a failure, not a pass', () => {
    const report = checkResumeAts(input({ pages: [] }))
    expect(report.ok).toBe(false)
    expect(codes(report)).toContain('CONTACT_NOT_IN_BODY')
  })
})

describe('on a real render', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'resume-ats-spec-'))
  const typst = new ResumeTypstService(undefined, scratch)
  const extraction = new ResumeTextExtractionService()

  beforeAll(() => {
    assertTypstAvailable()
  })
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const FULL: ResumeContent = {
    ...CONTENT,
    summary:
      'Senior engineer with ten years of experience building distributed systems and leading teams across several time zones, which is long enough to wrap.',
    experience: [
      {
        ...CONTENT.experience[0]!,
        bullets: [
          'Led a team of five engineers through the migration of a monolith into modules, a bullet long enough to wrap onto a second line',
          'Cut p95 latency by 40%',
        ],
      },
      CONTENT.experience[1]!,
    ],
  }

  async function renderClassic(): Promise<Buffer> {
    return typst.render({
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      content: FULL,
      layout: DEFAULT_RESUME_LAYOUT,
      templateName: 'classic',
      templateSource: null,
    })
  }

  it('extractRenderedPages keeps heading on its own line', async () => {
    const pages = await extraction.extractRenderedPages(await renderClassic())
    expect(pages).toHaveLength(1)
    const lines = pages[0]!.split('\n')
    for (const heading of ['Summary', 'Skills', 'Experience', 'Education', 'Languages', 'Links']) {
      expect(lines).toContain(heading)
    }
    expect(lines.slice(0, 2)).toEqual(['Jane Doe', 'jane@example.com'])
  }, 60_000)

  it('the full classic render passes the ATS check end to end', async () => {
    const pdf = await renderClassic()
    const pages = await extraction.extractRenderedPages(pdf)
    const report = checkResumeAts({
      content: FULL,
      layout: DEFAULT_RESUME_LAYOUT,
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      pages,
      pdfBytes: pdf.length,
    })
    expect(report).toEqual({ ok: true, failures: [] })
  }, 60_000)

  it('extractRenderedPages returns one string per page', async () => {
    const pages = await extraction.extractRenderedPages(await buildEmptyPdf(3))
    expect(pages).toEqual(['', '', ''])
  }, 60_000)

  it('extractRenderedPages keeps the extraction page limit', async () => {
    await expect(extraction.extractRenderedPages(await buildEmptyPdf(31))).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
  }, 60_000)

  it('extractRenderedPages refuses bytes that are not a PDF', async () => {
    await expect(extraction.extractRenderedPages(Buffer.from('not a pdf'))).rejects.toBeInstanceOf(
      ResumeFileUnreadableError,
    )
  }, 60_000)
})
