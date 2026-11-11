/**
 * Unit spec of stages 5 to 8 (Task 14): the layout steps, the underfill rule, the ATS revert and
 * repair loop, the placeholder copy and the vision confirmation. Typst and the extractor are the
 * fakes of `src/test/resume-run-fakes.ts`; the ATS checker is the real one.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  RESUME_SECTION_ORDER,
  type ResumeContent,
  type ResumeLayoutOptions,
} from '@crm/shared'
import {
  decodePdf,
  decodePng,
  encodePdf,
  encodePng,
  skeletonLines,
  splitPages,
} from '../../test/resume-run-fakes'
import type { ResumeRenderInput } from '../resume-typst.service'
import type { ContactContext } from './contact-scan'
import type { VisualReply } from './inference-clients'
import {
  aiPath,
  lastPageUnderfilled,
  placeholderCopy,
  renderAccepted,
  shrinkLayout,
  visualGate,
  type RenderDeps,
  type RenderPlan,
} from './render-gates'

const LAYOUT: ResumeLayoutOptions = {
  ...DEFAULT_RESUME_LAYOUT,
  sectionOrder: [...RESUME_SECTION_ORDER],
  hiddenSections: [],
  density: 'relaxed',
  fontScale: 'large',
}

const CONTENT: ResumeContent = {
  headline: 'Senior Backend Engineer',
  location: 'Lisbon, Portugal',
  workFormat: 'remote',
  summary: 'Backend engineer working with TypeScript.',
  skills: ['TypeScript', 'NestJS'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Tech Lead',
      location: null,
      period: 'Mar 2021 – Present',
      bullets: ['Led the payments team with rigour'],
    },
  ],
  education: [{ institution: 'Stanford University', degree: 'BSc Physics', period: '2010 – 2014' }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/janedoe-unit' }],
} as ResumeContent

const NOTES: ResumeContent = {
  ...CONTENT,
  summary: '',
  experience: [
    {
      ...(CONTENT.experience[0] as ResumeContent['experience'][number]),
      bullets: ['Led payments'],
    },
  ],
}

const CONTACTS: ContactContext[] = [{ fullName: 'Jane Doe', emails: ['jane.doe@unit.spec'] }]

function plan(over: Partial<RenderPlan> = {}): RenderPlan {
  return {
    displayName: 'Jane Doe',
    email: 'jane.doe@unit.spec',
    content: CONTENT,
    layout: LAYOUT,
    templateName: 'classic',
    notes: NOTES,
    fallbacks: [],
    editedPaths: [],
    ...over,
  }
}

/**
 * The render world: page count per layout, and an optional edit of the extracted lines (dropping a
 * line makes the ATS checker report its path as MISSING_TEXT).
 */
function deps(world: {
  pages?: (layout: ResumeLayoutOptions) => number
  count?: (layout: ResumeLayoutOptions) => number
  lines?: (lines: string[], input: ResumeRenderInput) => string[]
  vision?: VisualReply[]
}) {
  const pages = world.pages ?? (() => 1)
  const replies = [...(world.vision ?? [])]
  const d = {
    typst: {
      render: vi.fn(async (input: ResumeRenderInput) => encodePdf(input)),
      renderPng: vi.fn(async (input: ResumeRenderInput) => [encodePng(input)]),
    },
    extraction: {
      countRenderedPages: vi.fn(async (pdf: Buffer) =>
        (world.count ?? pages)(decodePdf(pdf).layout),
      ),
      extractRenderedPages: vi.fn(async (pdf: Buffer) => {
        const input = decodePdf(pdf)
        const lines = skeletonLines(input, { omitEmail: false })
        return splitPages(world.lines?.(lines, input) ?? lines, pages(input.layout))
      }),
    },
    vision: {
      check: vi.fn(
        async (_pngs: Buffer[]): Promise<VisualReply> =>
          replies.shift() ?? { kind: 'ok', findings: [] },
      ),
    },
    beforeModelCall: vi.fn(),
  } satisfies RenderDeps
  return d
}

const without = (text: string) => (lines: string[]) => lines.filter((l) => !l.includes(text))
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a RunFailure')
    },
    (err: unknown) => err as { code: string; gates: unknown[] },
  )

describe('shrinkLayout', () => {
  it.each([
    ['relaxed', 'large', { density: 'normal', fontScale: 'large' }],
    ['normal', 'large', { density: 'compact', fontScale: 'large' }],
    ['compact', 'large', { density: 'compact', fontScale: 'normal' }],
    ['compact', 'normal', { density: 'compact', fontScale: 'small' }],
    ['relaxed', 'small', { density: 'normal', fontScale: 'small' }],
  ] as const)('%s / %s gets one step denser', (density, fontScale, next) => {
    expect(shrinkLayout({ ...LAYOUT, density, fontScale })).toEqual({ ...LAYOUT, ...next })
  })

  it('has nothing left at compact / small', () => {
    expect(shrinkLayout({ ...LAYOUT, density: 'compact', fontScale: 'small' })).toBeNull()
  })
})

describe('lastPageUnderfilled', () => {
  it.each([
    [[], false],
    [['a\nb'], false],
    // 1 line against an average of 4: exactly a quarter is enough
    [['a\nb\nc\nd', 'x'], false],
    [['a\nb\nc\nd\ne', 'x'], true],
    [['a\nb\nc\nd\ne', ''], true],
    // blank lines do not count, on either side
    [['a\n\n \nb\nc\nd', 'x\n\n'], false],
    [['a\nb\nc\nd\ne', 'a\nb\nc\nd\ne', 'x\ny'], false],
    [['a\nb\nc\nd\ne\nf\ng\nh\ni', 'a', 'x\ny'], false],
    [['a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl', 'a\nb\nc\nd', 'x'], true],
    // lines are counted, not characters, and trailing blank lines are not lines
    [['aa\n'.repeat(8), 'xxxxx\n\n\n\n'], true],
  ])('%j -> %s', (pages, underfilled) => {
    expect(lastPageUnderfilled(pages)).toBe(underfilled)
  })
})

describe('aiPath', () => {
  it.each([
    ['summary', 'summary'],
    ['experience[2].bullets[0]', 'experience.2.bullets'],
    ['experience[12].bullets[3]', 'experience.12.bullets'],
    ['experience[2].bullets[10]', 'experience.2.bullets'],
    ['experience[2].role', null],
    ['experience[2].period', null],
    ['xexperience[1].bullets[0]', null],
    ['experience[1].bullets[0]x', null],
    ['summary.x', null],
    ['', null],
    [undefined, null],
  ])('%s -> %s', (path, expected) => {
    expect(aiPath(path)).toBe(expected)
  })
})

describe('renderAccepted', () => {
  it('passes on the first render with the raw content (P11) and both gates ok', async () => {
    const d = deps({})
    const out = await renderAccepted(plan({ fallbacks: ['summary'] }), d)
    expect(d.typst.render).toHaveBeenCalledTimes(1)
    const input = d.typst.render.mock.calls[0]?.[0] as ResumeRenderInput
    expect(input.content).toBe(CONTENT)
    expect(input.displayName).toBe('Jane Doe')
    expect(input.email).toBe('jane.doe@unit.spec')
    expect(input.templateName).toBe('classic')
    expect(input.templateSource.length).toBeGreaterThan(0)
    expect(out.content).toBe(CONTENT)
    expect(out.layout).toBe(LAYOUT)
    expect(out.pdf).toEqual(encodePdf(input))
    expect(out.gates).toEqual([
      { gate: 'ats', ok: true, items: [] },
      { gate: 'layout', ok: true, items: [] },
    ])
    expect(out.fallbacks).toEqual(['summary'])
  })

  it('a 3-page render is repaired by density and returns the repaired buffer', async () => {
    const d = deps({ pages: (l) => (l.density === 'compact' ? 2 : 3) })
    const out = await renderAccepted(plan(), d)
    expect(d.typst.render).toHaveBeenCalledTimes(3)
    expect(out.layout).toEqual({ ...LAYOUT, density: 'compact' })
    expect(decodePdf(out.pdf).layout).toEqual({ ...LAYOUT, density: 'compact' })
  })

  it('over 30 pages is a layout failure decided by the count, without extracting', async () => {
    const d = deps({ count: (l) => (l.density === 'relaxed' ? 31 : 1) })
    const out = await renderAccepted(plan(), d)
    expect(out.layout.density).toBe('normal')
    expect(d.extraction.extractRenderedPages).toHaveBeenCalledTimes(1)
  })

  it('exactly 30 pages is not over the cap', async () => {
    const d = deps({ count: () => 30 })
    await renderAccepted(plan(), d)
    expect(d.extraction.extractRenderedPages).toHaveBeenCalledTimes(1)
  })

  it('stops after 3 repair rounds with LAYOUT_UNFIXABLE', async () => {
    const d = deps({ pages: () => 3 })
    const err = await failure(renderAccepted(plan(), d))
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(err.gates).toEqual([
      { gate: 'ats', ok: true, items: [] },
      { gate: 'layout', ok: false, items: [{ path: '', reason: 'TOO_MANY_PAGES' }] },
    ])
    expect(d.typst.render).toHaveBeenCalledTimes(4)
  })

  it('a count over 30 pages on every layout is LAYOUT_UNFIXABLE TOO_MANY_PAGES', async () => {
    const d = deps({ count: () => 31 })
    const err = await failure(renderAccepted(plan(), d))
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(err.gates).toContainEqual({
      gate: 'layout',
      ok: false,
      items: [{ path: '', reason: 'TOO_MANY_PAGES' }],
    })
    expect(d.extraction.extractRenderedPages).not.toHaveBeenCalled()
  })

  it('an underfilled last page on every layout is LAYOUT_UNFIXABLE LAST_PAGE_UNDERFILLED', async () => {
    const d = deps({})
    d.extraction.extractRenderedPages.mockImplementation(async (pdf: Buffer) => {
      const lines = skeletonLines(decodePdf(pdf), { omitEmail: false })
      return [lines.slice(0, -1).join('\n'), lines.at(-1) as string]
    })
    const err = await failure(renderAccepted(plan(), d))
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(err.gates).toContainEqual({
      gate: 'layout',
      ok: false,
      items: [{ path: '', reason: 'LAST_PAGE_UNDERFILLED' }],
    })
  })

  it('a PDF over 1 MiB is a layout failure repaired by density, not an ATS failure', async () => {
    const d = deps({})
    d.typst.render.mockImplementation(async (input: ResumeRenderInput) =>
      input.layout.density === 'relaxed'
        ? Buffer.concat([encodePdf(input), Buffer.alloc(1_100_000, 0x20)])
        : encodePdf(input),
    )
    const out = await renderAccepted(plan(), d)
    expect(out.layout.density).toBe('normal')
    expect(d.typst.render).toHaveBeenCalledTimes(2)
  })

  it('fails at once when nothing is left to shrink', async () => {
    const d = deps({ pages: () => 3 })
    const tight = { ...LAYOUT, density: 'compact', fontScale: 'small' } as const
    const err = await failure(renderAccepted(plan({ layout: tight }), d))
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(d.typst.render).toHaveBeenCalledTimes(1)
  })

  it('an underfilled last page is a layout failure', async () => {
    const d = deps({})
    // The first render: every line on page 1 but the last one, alone on page 2.
    d.extraction.extractRenderedPages.mockImplementationOnce(async (pdf: Buffer) => {
      const lines = skeletonLines(decodePdf(pdf), { omitEmail: false })
      return [lines.slice(0, -1).join('\n'), lines.at(-1) as string]
    })
    const out = await renderAccepted(plan(), d)
    expect(out.layout.density).toBe('normal')
    expect(d.typst.render).toHaveBeenCalledTimes(2)
  })

  it('an ATS failure on an AI bullet reverts it to the notes once and lists the fallback', async () => {
    const d = deps({
      lines: (lines, input) =>
        input.content.experience[0]?.bullets[0] === 'Led payments'
          ? lines
          : without('Led the payments team')(lines),
    })
    const out = await renderAccepted(plan({ fallbacks: ['summary'] }), d)
    expect(d.typst.render).toHaveBeenCalledTimes(2)
    expect(out.content.experience[0]?.bullets).toEqual(['Led payments'])
    expect(out.content.summary).toBe(CONTENT.summary)
    expect(out.fallbacks).toEqual(['summary', 'experience.0.bullets'])
  })

  it('an ATS failure on the summary reverts only the summary', async () => {
    const d = deps({
      lines: (lines, input) =>
        input.content.summary === '' ? lines : without('Backend engineer')(lines),
    })
    const out = await renderAccepted(plan(), d)
    expect(out.content.summary).toBe('')
    expect(out.content.experience).toEqual(CONTENT.experience)
    expect(out.fallbacks).toEqual(['summary'])
  })

  it('reverted and still failing is ATS_CHECK_FAILED with the ATS items', async () => {
    const d = deps({ lines: (lines) => lines.filter((l) => !l.startsWith('•')) })
    const err = await failure(renderAccepted(plan(), d))
    expect(err.code).toBe('ATS_CHECK_FAILED')
    expect(err.gates).toEqual([
      {
        gate: 'ats',
        ok: false,
        items: [{ path: 'experience[0].bullets[0]', reason: 'MISSING_TEXT' }],
      },
    ])
    expect(d.typst.render).toHaveBeenCalledTimes(2)
  })

  it('an AI failure next to a non-AI one is not reverted: ATS_CHECK_FAILED at once with both', async () => {
    const d = deps({
      lines: (lines) => without('jane.doe@unit.spec')(without('Led the payments team')(lines)),
    })
    const err = await failure(renderAccepted(plan(), d))
    expect(err.code).toBe('ATS_CHECK_FAILED')
    const [gate] = err.gates as { items: { path: string }[] }[]
    expect(gate?.items.map((i) => i.path)).toContain('experience[0].bullets[0]')
    expect(gate?.items.length).toBeGreaterThan(1)
    expect(d.typst.render).toHaveBeenCalledTimes(1)
  })

  it('the revert happens once: a second AI path failing after it is ATS_CHECK_FAILED', async () => {
    const d = deps({
      lines: (lines, input) =>
        input.content.summary !== ''
          ? without('Backend engineer')(lines)
          : without('Led the payments team')(lines),
    })
    const err = await failure(renderAccepted(plan(), d))
    expect(err.code).toBe('ATS_CHECK_FAILED')
    expect(err.gates).toEqual([
      {
        gate: 'ats',
        ok: false,
        items: [{ path: 'experience[0].bullets[0]', reason: 'MISSING_TEXT' }],
      },
    ])
    expect(d.typst.render).toHaveBeenCalledTimes(2)
  })

  it('a failing path that already holds the fallback is not reverted again', async () => {
    const d = deps({ lines: without('Led the payments team') })
    const err = await failure(renderAccepted(plan({ fallbacks: ['experience.0.bullets'] }), d))
    expect(err.code).toBe('ATS_CHECK_FAILED')
    expect(d.typst.render).toHaveBeenCalledTimes(1)
  })

  it.each([['experience.0.bullets'], ['experience.0'], ['experience.0.bullets.0']])(
    'a human-edited path (%s) is never reverted silently',
    async (edited) => {
      const d = deps({ lines: without('Led the payments team') })
      const err = await failure(renderAccepted(plan({ editedPaths: [edited] }), d))
      expect(err.code).toBe('ATS_CHECK_FAILED')
      expect(err.gates).toEqual([
        {
          gate: 'ats',
          ok: false,
          items: [{ path: 'experience.0.bullets', reason: 'HUMAN_EDITED' }],
        },
      ])
      expect(d.typst.render).toHaveBeenCalledTimes(1)
    },
  )

  it('an edit elsewhere does not block the revert', async () => {
    const d = deps({
      lines: (lines, input) =>
        input.content.experience[0]?.bullets[0] === 'Led payments'
          ? lines
          : without('Led the payments team')(lines),
    })
    const out = await renderAccepted(plan({ editedPaths: ['summary', 'experience.01'] }), d)
    expect(out.fallbacks).toEqual(['experience.0.bullets'])
  })

  it('a missing email is ATS_CHECK_FAILED at once, nothing AI-owned to revert', async () => {
    const d = deps({ lines: without('jane.doe@unit.spec') })
    const err = await failure(renderAccepted(plan(), d))
    expect(err.code).toBe('ATS_CHECK_FAILED')
    expect(d.typst.render).toHaveBeenCalledTimes(1)
  })

  it('an unreadable PDF is ATS_CHECK_FAILED UNREADABLE', async () => {
    const d = deps({})
    d.extraction.extractRenderedPages.mockRejectedValueOnce(new Error('bad pdf'))
    const err = await failure(renderAccepted(plan(), d))
    expect(err).toMatchObject({
      code: 'ATS_CHECK_FAILED',
      gates: [{ gate: 'ats', ok: false, items: [{ path: '', reason: 'UNREADABLE' }] }],
    })
  })

  it('a render error is RENDER_FAILED', async () => {
    const d = deps({})
    d.typst.render.mockRejectedValueOnce(new Error('typst'))
    const err = await failure(renderAccepted(plan(), d))
    expect(err).toMatchObject({
      code: 'RENDER_FAILED',
      gates: [{ gate: 'render', ok: false, items: [] }],
    })
  })

  it('a glyph the template cannot draw is GLYPH_CHECK_FAILED before any render', async () => {
    const d = deps({})
    const content = { ...CONTENT, summary: 'Ships fast 😀' }
    const err = await failure(renderAccepted(plan({ content }), d))
    expect(err).toMatchObject({
      code: 'GLYPH_CHECK_FAILED',
      gates: [{ gate: 'glyph', ok: false, items: [{ path: '', reason: 'DROPPED_GLYPHS' }] }],
    })
    expect(d.typst.render).not.toHaveBeenCalled()
  })
})

describe('placeholderCopy', () => {
  it('replaces the name, email and links and redacts contacts in every other string', () => {
    const content: ResumeContent = {
      ...CONTENT,
      experience: [
        {
          ...(CONTENT.experience[0] as ResumeContent['experience'][number]),
          company: 'Jane Doe Consulting',
          role: 'Lead, call +44 20 7946 0958',
        },
      ],
    }
    const copy = placeholderCopy(content, CONTACTS)
    expect(copy.displayName).toBe('Firstname Lastname')
    expect(copy.email).toBe('name@example.com')
    expect(copy.content.links).toEqual([{ label: 'Link', url: 'https://example.com' }])
    expect(copy.content.experience[0]?.company).toBe('[REDACTED] Consulting')
    expect(copy.content.experience[0]?.role).toBe('Lead, call [REDACTED]')
    expect(copy.content.education).toEqual(CONTENT.education)
    expect(copy.content.summary).toBe(CONTENT.summary)
    expect(content.experience[0]?.company).toBe('Jane Doe Consulting')
  })
})

describe('visualGate', () => {
  const accepted = { content: CONTENT, layout: LAYOUT }
  const finding = (check: string, page: number) => ({ check, page, detail: 'model text' })

  it('renders the placeholder copy and passes on no findings with one call', async () => {
    const d = deps({})
    const gate = await visualGate(accepted, 'classic', CONTACTS, d)
    expect(gate).toEqual({ gate: 'visual', ok: true, items: [] })
    expect(d.vision.check).toHaveBeenCalledTimes(1)
    expect(d.beforeModelCall).toHaveBeenCalledTimes(1)
    const png = d.vision.check.mock.calls[0]?.[0][0] as Buffer
    const sent = decodePng(png)
    expect(sent.displayName).toBe('Firstname Lastname')
    expect(sent.email).toBe('name@example.com')
    expect(sent.layout).toEqual(LAYOUT)
    expect(sent.templateName).toBe('classic')
    expect(sent.templateSource.length).toBeGreaterThan(0)
    expect(JSON.stringify(sent)).not.toContain('janedoe-unit')
  })

  it('a finding the second call confirms (same check and page) fails the run', async () => {
    const d = deps({
      vision: [
        { kind: 'ok', findings: [finding('overflow', 0), finding('overlap', 1)] },
        { kind: 'ok', findings: [finding('overflow', 0), finding('overlap', 0)] },
      ],
    } as never)
    const err = await failure(visualGate(accepted, 'classic', CONTACTS, d))
    expect(err).toEqual(
      expect.objectContaining({
        code: 'VISUAL_CHECK_FAILED',
        gates: [{ gate: 'visual', ok: false, items: [{ path: 'pages.0', reason: 'overflow' }] }],
      }),
    )
    expect(d.beforeModelCall).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(err.gates)).not.toContain('model text')
  })

  it('an unconfirmed finding does not fail', async () => {
    const d = deps({
      vision: [
        { kind: 'ok', findings: [finding('overflow', 0)] },
        { kind: 'ok', findings: [finding('overflow', 1), finding('ragged', 0)] },
      ],
    } as never)
    expect(await visualGate(accepted, 'classic', CONTACTS, d)).toEqual({
      gate: 'visual',
      ok: true,
      items: [],
    })
    expect(d.vision.check).toHaveBeenCalledTimes(2)
  })

  it('when the confirming call cannot run, the first findings count → VISUAL_CHECK_FAILED', async () => {
    const d = deps({
      vision: [
        { kind: 'ok', findings: [finding('ragged', 1)] },
        { kind: 'unavailable', reason: 'TIMEOUT' },
      ],
    } as never)
    const err = await failure(visualGate(accepted, 'classic', CONTACTS, d))
    expect(err).toMatchObject({
      code: 'VISUAL_CHECK_FAILED',
      gates: [{ gate: 'visual', ok: false, items: [{ path: 'pages.1', reason: 'ragged' }] }],
    })
    expect(d.vision.check).toHaveBeenCalledTimes(2)
  })

  it('vision unavailable on the first call is VISUAL_CHECK_UNAVAILABLE', async () => {
    const d = deps({ vision: [{ kind: 'unavailable', reason: 'TIMEOUT' }] } as never)
    const err = await failure(visualGate(accepted, 'classic', CONTACTS, d))
    expect(err).toMatchObject({
      code: 'VISUAL_CHECK_UNAVAILABLE',
      gates: [{ gate: 'visual', ok: false, items: [] }],
    })
    expect(d.vision.check).toHaveBeenCalledTimes(1)
  })

  it('a PNG render error is RENDER_FAILED and no model call', async () => {
    const d = deps({})
    d.typst.renderPng.mockRejectedValueOnce(new Error('typst'))
    const err = await failure(visualGate(accepted, 'classic', CONTACTS, d))
    expect(err).toMatchObject({
      code: 'RENDER_FAILED',
      gates: [{ gate: 'visual', ok: false, items: [] }],
    })
    expect(d.vision.check).not.toHaveBeenCalled()
  })

  it('the budget check stops the run before the vision call', async () => {
    const d = deps({})
    d.beforeModelCall.mockImplementation(() => {
      throw new Error('STALLED')
    })
    await expect(visualGate(accepted, 'classic', CONTACTS, d)).rejects.toThrow('STALLED')
    expect(d.vision.check).not.toHaveBeenCalled()
  })
})
