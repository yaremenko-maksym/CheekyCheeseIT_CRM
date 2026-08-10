/**
 * ResumeTypstService — the layout+data join (AC1, AC2, AC8) and the sandbox.
 *
 * These run the REAL binary. Mocking `spawn` here would test that we call a
 * function, which is not the claim: the claims are that the same input yields
 * the same bytes, that Cyrillic reaches the page, that the four switches change
 * the document, and that a template cannot read the disk. Every one of those is
 * a property of Typst plus our arguments, and a mock knows nothing about either.
 *
 * API responsiveness during a render (AC3) is measured separately, in
 * resume-render-responsiveness.spec.ts, because it needs an HTTP server.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  type ResumeContent,
  type ResumeLayoutOptions,
  type ResumeSectionKey,
} from '@crm/shared'
import { slowTemplate } from '../test/resume-render-fixtures'
import { assertTypstAvailable } from '../test/typst-availability'
import { findUnrenderable } from './resume-glyphs'
import {
  ResumeRenderError,
  ResumeTypstService,
  buildArgs,
  createSpawnRunner,
  loadDefaultTemplate,
  renderEnv,
  type ResumeRenderInput,
} from './resume-typst.service'

const service = new ResumeTypstService()

/** Russian + Ukrainian, the two alphabets AC2 names. */
const CONTENT: ResumeContent = {
  summary: 'Синьор-розробник з восьмирічним досвідом у TypeScript та Node.js.',
  skills: ['TypeScript', 'NestJS', 'Проєктування систем'],
  experience: [
    {
      company: 'Акме Технології',
      role: 'Технічний лідер',
      period: '2021 — наст. время',
      bullets: ["Керував командою з п'яти інженерів", 'Перевів моноліт на модулі'],
    },
  ],
  education: [{ institution: 'КПІ ім. Ігоря Сікорського', degree: 'Магістр', period: '2012–2018' }],
  languages: [{ name: 'Английский', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/example' }],
}

function input(overrides: Partial<ResumeRenderInput> = {}): ResumeRenderInput {
  return {
    displayName: 'Іван Петренко',
    content: CONTENT,
    layout: DEFAULT_RESUME_LAYOUT,
    templateSource: null,
    ...overrides,
  }
}

function layout(overrides: Partial<ResumeLayoutOptions>): ResumeLayoutOptions {
  return { ...DEFAULT_RESUME_LAYOUT, ...overrides }
}

/** A resume long enough that spacing and size decisions change the page count. */
function longContent(): ResumeContent {
  return {
    ...CONTENT,
    experience: Array.from({ length: 12 }, (_, i) => ({
      company: `Компанія ${i}`,
      role: 'Технічний лідер',
      period: '2021 — 2024',
      bullets: Array.from(
        { length: 6 },
        (_, b) => `Пункт ${b}: ${'зробив щось важливе та корисне '.repeat(3)}`,
      ),
    })),
  }
}

async function readBack(
  pdf: Buffer,
): Promise<{ text: string; pages: number; itemsOnFirstPage: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const proxy = await getDocumentProxy(new Uint8Array(pdf))
  const { text } = await extractText(proxy, { mergePages: true })
  // How much actually fits on page one — the metric that reacts to spacing and
  // type size without depending on the document landing exactly on a page
  // boundary (a page count only moves when it happens to cross one).
  const first = await proxy.getPage(1)
  const content = (await first.getTextContent()) as { items: unknown[] }
  return { text, pages: proxy.numPages, itemsOnFirstPage: content.items.length }
}

beforeAll(() => {
  assertTypstAvailable()
})

describe('AC1 — determinism', () => {
  it('renders byte-identical output for the same input', async () => {
    const a = await service.render(input())
    const b = await service.render(input())

    expect(a.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(a.length).toBeGreaterThan(1000)
    expect(a.equals(b)).toBe(true)
  }, 120_000)

  it('gives the same fingerprint to the same input and a different one to different data', () => {
    expect(service.fingerprint(input())).toBe(service.fingerprint(input()))
    expect(service.fingerprint(input())).not.toBe(
      service.fingerprint(input({ displayName: 'Инша Людина' })),
    )
  })

  /**
   * A fingerprint that ignored the template would let a redesigned default keep
   * serving everyone's cached PDF of the old one.
   */
  it('changes when the template changes, with identical data', () => {
    const custom = loadDefaultTemplate().replace('О СЕБЕ', 'ПРО МЕНЕ')
    expect(service.fingerprint(input({ templateSource: custom }))).not.toBe(
      service.fingerprint(input()),
    )
  })

  /**
   * Two inputs differing only in a character no font can draw MUST share a
   * fingerprint, because they really do render to the same bytes. Getting this
   * backwards would mean re-rendering forever and never matching the cache.
   */
  it('ignores a difference the renderer itself erases', () => {
    const withEmoji = input({ displayName: 'Іван Петренко 😀' })
    expect(service.fingerprint(withEmoji)).toBe(service.fingerprint(input()))
  })
})

describe('AC2 — Cyrillic', () => {
  it('puts Russian and Ukrainian glyphs on the page, in a real text layer', async () => {
    const { text, pages } = await readBack(await service.render(input()))

    expect(pages).toBe(1)
    // Ukrainian-specific letters (і, ї, є, apostrophe) and Russian alike.
    expect(text).toContain('Іван Петренко')
    expect(text).toContain('Синьор-розробник')
    expect(text).toContain('Технічний лідер')
    expect(text).toContain("Керував командою з п'яти інженерів")
    expect(text).toContain('Английский')
    // Headings come from the template, not the data.
    expect(text).toContain('ОПЫТ РАБОТЫ')
  }, 120_000)

  /**
   * The text layer alone does NOT prove a glyph was drawn: a `.notdef` box
   * still extracts as the original character through the ToUnicode map, and
   * Typst compiles an uncoverable character with exit code 0 and no warning.
   * The drawn-ness is proved where it can be: against the font's own cmap.
   */
  it('draws every character it typesets — nothing falls back to an empty box', async () => {
    const rich = input({
      content: { ...CONTENT, summary: `${CONTENT.summary} Ставка 5000 ₴, бонус 100 ₽.` },
    })
    const { text } = await readBack(await service.render(rich))

    expect(findUnrenderable(text)).toEqual([])
    // The hryvnia had no glyph, so it is spelled; the ruble had one, so it is not.
    expect(text).toContain('5000 UAH')
    expect(text).toContain('100 ₽')
  }, 120_000)
})

describe('AC8 — the layout switches change the result', () => {
  it('section order: reordering moves the sections in the document', async () => {
    const reordered: ResumeSectionKey[] = [
      'experience',
      'summary',
      'skills',
      'education',
      'languages',
      'links',
    ]
    const before = await readBack(await service.render(input()))
    const after = await readBack(
      await service.render(input({ layout: layout({ sectionOrder: reordered }) })),
    )

    expect(before.text.indexOf('ОПЫТ РАБОТЫ')).toBeGreaterThan(before.text.indexOf('НАВЫКИ'))
    expect(after.text.indexOf('ОПЫТ РАБОТЫ')).toBeLessThan(after.text.indexOf('НАВЫКИ'))
  }, 120_000)

  it('hidden sections: a hidden section and its heading leave the document', async () => {
    const { text } = await readBack(
      await service.render(input({ layout: layout({ hiddenSections: ['skills', 'languages'] }) })),
    )

    expect(text).not.toContain('НАВЫКИ')
    // A skill that appears ONLY in the skills list — "TypeScript" is also in
    // the summary, so asserting on it would have passed with the section still
    // fully rendered.
    expect(text).not.toContain('NestJS')
    expect(text).not.toContain('ЯЗЫКИ')
    // Everything else survives.
    expect(text).toContain('ОПЫТ РАБОТЫ')
  }, 120_000)

  it('density: a compact resume fits more onto the first page than a relaxed one', async () => {
    const long = { content: longContent() }
    const compact = await readBack(
      await service.render(input({ ...long, layout: layout({ density: 'compact' }) })),
    )
    const relaxed = await readBack(
      await service.render(input({ ...long, layout: layout({ density: 'relaxed' }) })),
    )

    expect(compact.itemsOnFirstPage).toBeGreaterThan(relaxed.itemsOnFirstPage)
  }, 180_000)

  it('font scale: large type takes more pages than small type', async () => {
    const long = { content: longContent() }
    const small = await readBack(
      await service.render(input({ ...long, layout: layout({ fontScale: 'small' }) })),
    )
    const large = await readBack(
      await service.render(input({ ...long, layout: layout({ fontScale: 'large' }) })),
    )

    expect(large.pages).toBeGreaterThan(small.pages)
  }, 180_000)

  it('a stale stored order still renders every section exactly once', async () => {
    // What a layout saved before a section existed looks like. The renderer must
    // not drop the newcomer, and must not print anything twice.
    const partial = { ...DEFAULT_RESUME_LAYOUT, sectionOrder: ['links', 'summary'] } as unknown
    const { text } = await readBack(
      await service.render(input({ layout: partial as ResumeLayoutOptions })),
    )

    for (const heading of ['О СЕБЕ', 'НАВЫКИ', 'ОПЫТ РАБОТЫ', 'ОБРАЗОВАНИЕ', 'ЯЗЫКИ', 'ССЫЛКИ']) {
      expect(text.split(heading).length - 1).toBe(1)
    }
  }, 120_000)
})

describe('untrusted content stays content', () => {
  /**
   * A resume field is written by a stranger and then rewritten by an LLM. If a
   * string were re-parsed as Typst markup, `#pagebreak()` in a job title would
   * be the mildest possible consequence.
   */
  it('typesets markup characters literally instead of executing them', async () => {
    const hostile = input({
      content: {
        ...CONTENT,
        summary: 'Обычный текст #pagebreak() *не жирный* #image("/etc/passwd") $x^2$',
      },
    })
    const { text, pages } = await readBack(await service.render(hostile))

    expect(pages).toBe(1)
    expect(text).toContain('#pagebreak()')
    expect(text).toContain('*не жирный*')
  }, 120_000)
})

describe('the sandbox', () => {
  it('refuses a template that reads outside its scratch directory', async () => {
    const escaping = '#let render(data) = [#read("/etc/hosts")]'
    await expect(service.render(input({ templateSource: escaping }))).rejects.toBeInstanceOf(
      ResumeRenderError,
    )
  }, 120_000)

  it('kills a template that outruns its deadline, and says so', async () => {
    // The REAL runner with a short deadline — the production path, not a mock.
    // A legitimately slow document rather than `while true`: Typst refuses an
    // obviously unbounded loop on its own and exits fast, which would have
    // tested its error handling instead of our SIGKILL.
    const impatient = new ResumeTypstService(createSpawnRunner(500))

    const started = Date.now()
    await expect(impatient.render(input({ templateSource: slowTemplate(4_000) }))).rejects.toThrow(
      /не уложилась/,
    )
    // Ended on the deadline, not left to finish in its own time.
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 60_000)

  it('hands the child neither the API environment nor the host fonts', () => {
    const env = renderEnv()
    expect(Object.keys(env).sort()).toEqual(['PATH', 'SOURCE_DATE_EPOCH'])
    // The secrets the API process holds must not be inherited.
    expect(env).not.toHaveProperty('DATABASE_URL')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('CLOUDFLARE_AI_TOKEN')

    const args = buildArgs('/scratch', '/scratch/out.pdf')
    expect(args).toContain('--ignore-system-fonts')
    expect(args).toContain('--ignore-embedded-fonts')
    // Reads are confined to the scratch directory.
    expect(args[args.indexOf('--root') + 1]).toBe('/scratch')
    // Determinism: a pinned creation date, single-threaded.
    expect(args[args.indexOf('--creation-timestamp') + 1]).toBe('0')
    expect(args[args.indexOf('--jobs') + 1]).toBe('1')
  })

  /**
   * The template is an ASSET, and assets only reach production if `nest-cli.json`
   * is told to copy them. Nothing else in this suite would notice: tests run
   * from `src`, so a missing entry here is invisible until the container starts
   * and every render fails on a file that is not there.
   */
  it('ships the template to dist — the build copies it, not just the fonts', async () => {
    const { readFile } = await import('node:fs/promises')
    const config = JSON.parse(
      await readFile(new URL('../../nest-cli.json', import.meta.url), 'utf8'),
    ) as { compilerOptions: { assets: Array<{ include: string }> } }

    const globs = config.compilerOptions.assets.map((asset) => asset.include)
    expect(globs).toContain('assets/typst/*.typ')
  })

  it('leaves no scratch directory behind, on success or on failure', async () => {
    const { readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const before = (await readdir(tmpdir())).filter((e) => e.startsWith('crm-resume-')).length

    await service.render(input())
    await service.render(input({ templateSource: '#let render(data) = [' })).catch(() => undefined)

    const after = (await readdir(tmpdir())).filter((e) => e.startsWith('crm-resume-')).length
    // The directory holds the whole CV in clear text; it must not survive.
    expect(after).toBe(before)
  }, 120_000)
})
