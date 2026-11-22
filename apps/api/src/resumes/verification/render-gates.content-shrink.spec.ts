/**
 * The optional page limit and content shrink of `renderAccepted` (tailored-resume plan Task 9):
 * once the layout knobs are spent, `shrinkContent` runs up to `maxContentDrops` times. The page
 * count of the fake depends on the rendered bullets, so a drop can make the PDF fit.
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
  encodePdf,
  encodePng,
  skeletonLines,
  splitPages,
} from '../../test/resume-run-fakes'
import type { ResumeRenderInput } from '../resume-typst.service'
import { renderAccepted, type RenderDeps, type RenderPlan } from './render-gates'

const SPENT: ResumeLayoutOptions = {
  ...DEFAULT_RESUME_LAYOUT,
  sectionOrder: [...RESUME_SECTION_ORDER],
  hiddenSections: [],
  density: 'compact',
  fontScale: 'small',
}

const bullets = (n: number) =>
  Array.from({ length: n }, (_, i) => `Shipped release number ${i + 1}`)

const content = (n: number): ResumeContent =>
  ({
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
        bullets: bullets(n),
      },
    ],
    education: [
      { institution: 'Stanford University', degree: 'BSc Physics', period: '2010 – 2014' },
    ],
    languages: [{ name: 'English', level: 'C1' }],
    links: [{ label: 'GitHub', url: 'https://github.com/janedoe-unit' }],
  }) as ResumeContent

const bulletCount = (c: ResumeContent) => c.experience.reduce((n, i) => n + i.bullets.length, 0)
/** Drops the last bullet; the item keeps one. */
const dropLast = (c: ResumeContent): ResumeContent | null => {
  const item = c.experience[0] as ResumeContent['experience'][number]
  if (item.bullets.length <= 1) return null
  return { ...c, experience: [{ ...item, bullets: item.bullets.slice(0, -1) }] }
}

function plan(over: Partial<RenderPlan> = {}): RenderPlan {
  return {
    displayName: 'Jane Doe',
    email: 'jane.doe@unit.spec',
    content: content(4),
    layout: SPENT,
    templateName: 'classic',
    notes: content(4),
    fallbacks: [],
    editedPaths: [],
    ...over,
  }
}

/** One page while the content has at most `fit` bullets, one page more per extra bullet. */
function deps(pagesOf: (input: ResumeRenderInput) => number) {
  return {
    typst: {
      render: vi.fn(async (input: ResumeRenderInput) => encodePdf(input)),
      renderPng: vi.fn(async (input: ResumeRenderInput) => [encodePng(input)]),
    },
    extraction: {
      countRenderedPages: vi.fn(async (pdf: Buffer) => pagesOf(decodePdf(pdf))),
      extractRenderedPages: vi.fn(async (pdf: Buffer) => {
        const input = decodePdf(pdf)
        // Even pages, so the underfill rule never decides these cases.
        const lines = skeletonLines(input, { omitEmail: false })
        return splitPages(lines, 1)
      }),
    },
    vision: { check: vi.fn() },
    beforeModelCall: vi.fn(),
  } satisfies RenderDeps
}

const overBy = (fit: number) => (input: ResumeRenderInput) =>
  1 + Math.max(0, bulletCount(input.content) - fit)

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a RunFailure')
    },
    (err: unknown) => err as { code: string },
  )

describe('renderAccepted — page limit and content shrink', () => {
  it('without maxPages / shrinkContent: two pages are accepted as today', async () => {
    const d = deps(() => 2)
    const accepted = await renderAccepted(plan(), d)
    expect(bulletCount(accepted.content)).toBe(4)
    expect(d.typst.render).toHaveBeenCalledTimes(1)
  })

  it('without shrinkContent: maxPages 1 and two pages at spent knobs → LAYOUT_UNFIXABLE', async () => {
    const err = await failure(
      renderAccepted(
        plan({ maxPages: 1 }),
        deps(() => 2),
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
  })

  it('maxPages equal to the page count passes; one over fails', async () => {
    await expect(
      renderAccepted(
        plan({ maxPages: 2 }),
        deps(() => 2),
      ),
    ).resolves.toBeDefined()
    const err = await failure(
      renderAccepted(
        plan({ maxPages: 2 }),
        deps(() => 3),
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
  })

  it('maxPages 1 renders 2 pages → shrinkContent called only after shrinkLayout returns null', async () => {
    const d = deps(overBy(3))
    const shrink = vi.fn((c: ResumeContent) => {
      // compact / normal → compact / small is the one knob step left; then nothing.
      expect(d.typst.render).toHaveBeenCalledTimes(2)
      expect(decodeLast(d).layout.fontScale).toBe('small')
      return dropLast(c)
    })
    const accepted = await renderAccepted(
      plan({
        layout: { ...SPENT, fontScale: 'normal' },
        maxPages: 1,
        shrinkContent: shrink,
        maxContentDrops: 6,
      }),
      d,
    )
    expect(shrink).toHaveBeenCalledTimes(1)
    expect(bulletCount(accepted.content)).toBe(3)
  })

  it('the 3 layout rounds spent with a knob left → shrinkContent runs', async () => {
    const d = deps(overBy(3))
    const shrink = vi.fn(dropLast)
    const accepted = await renderAccepted(
      plan({
        layout: { ...SPENT, density: 'relaxed', fontScale: 'large' },
        maxPages: 1,
        shrinkContent: shrink,
        maxContentDrops: 6,
      }),
      d,
    )
    expect(shrink).toHaveBeenCalledTimes(1)
    // relaxed → normal → compact → compact/normal: 4 renders, the 5th after the drop.
    expect(d.typst.render).toHaveBeenCalledTimes(5)
    expect(accepted.layout.fontScale).toBe('normal')
  })

  it('overflow by 3 bullets after the knobs are spent → 3 drops → accepted', async () => {
    const shrink = vi.fn(dropLast)
    const accepted = await renderAccepted(
      plan({ content: content(6), maxPages: 1, shrinkContent: shrink, maxContentDrops: 6 }),
      deps(overBy(3)),
    )
    expect(shrink).toHaveBeenCalledTimes(3)
    expect(bulletCount(accepted.content)).toBe(3)
  })

  it('needs 7 drops with maxContentDrops 6 → LAYOUT_UNFIXABLE', async () => {
    const shrink = vi.fn(dropLast)
    const err = await failure(
      renderAccepted(
        plan({ content: content(8), maxPages: 1, shrinkContent: shrink, maxContentDrops: 6 }),
        deps(overBy(1)),
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(shrink).toHaveBeenCalledTimes(6)
  })

  it('exactly maxContentDrops drops → accepted', async () => {
    const accepted = await renderAccepted(
      plan({ content: content(8), maxPages: 1, shrinkContent: dropLast, maxContentDrops: 6 }),
      deps(overBy(2)),
    )
    expect(bulletCount(accepted.content)).toBe(2)
  })

  it('shrinkContent returning null → LAYOUT_UNFIXABLE', async () => {
    const shrink = vi.fn(() => null)
    const err = await failure(
      renderAccepted(
        plan({ maxPages: 1, shrinkContent: shrink, maxContentDrops: 6 }),
        deps(() => 2),
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(shrink).toHaveBeenCalledTimes(1)
  })

  it('shrinkContent without maxContentDrops never runs', async () => {
    const shrink = vi.fn(dropLast)
    const err = await failure(
      renderAccepted(
        plan({ maxPages: 1, shrinkContent: shrink }),
        deps(() => 2),
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(shrink).not.toHaveBeenCalled()
  })

  it('maxContentDrops without shrinkContent → LAYOUT_UNFIXABLE, not a TypeError', async () => {
    const err = await failure(
      renderAccepted(
        plan({ maxPages: 1, maxContentDrops: 6 }),
        deps(() => 2),
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
  })

  it('a maxPages above MAX_PDF_PAGES is capped at MAX_PDF_PAGES (31 pages fail)', async () => {
    const err = await failure(
      renderAccepted(
        plan({ maxPages: 31 }),
        deps(() => 31),
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    await expect(
      renderAccepted(
        plan({ maxPages: 31 }),
        deps(() => 30),
      ),
    ).resolves.toBeDefined()
  })

  it('an ATS revert gives back the drops it undid: the restored item gets the budget again', async () => {
    const base = content(8)
    const notes = {
      ...base,
      experience: base.experience.map((item) => ({
        ...item,
        bullets: item.bullets.map((_, i) => `Base release number ${i + 1}`),
      })),
    } as ResumeContent
    const d = deps(overBy(4))
    // The AI bullet 'Shipped release number 1' never reaches the text layer: an ATS failure.
    d.extraction.extractRenderedPages.mockImplementation(async (pdf: Buffer) => {
      const lines = skeletonLines(decodePdf(pdf), { omitEmail: false })
      return splitPages(
        lines.filter((l) => !l.includes('Shipped release number 1')),
        1,
      )
    })
    const shrink = vi.fn(dropLast)
    const accepted = await renderAccepted(
      plan({ content: base, notes, maxPages: 1, shrinkContent: shrink, maxContentDrops: 6 }),
      d,
    )
    expect(shrink).toHaveBeenCalledTimes(8)
    expect(accepted.content.experience[0]?.bullets).toEqual(
      [1, 2, 3, 4].map((i) => `Base release number ${i}`),
    )
    expect(accepted.fallbacks).toEqual(['experience.0.bullets'])
  })

  it('an ATS revert of one item keeps the drops of another item counted', async () => {
    const one = content(3).experience[0] as ResumeContent['experience'][number]
    const item = (prefix: string, n: number) => ({
      ...one,
      bullets: Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`),
    })
    const ai = { ...content(3), experience: [item('Alpha bullet', 3), item('Beta bullet', 3)] }
    const notes = { ...ai, experience: [item('Base bullet', 4), item('Beta bullet', 3)] }
    // Drops the last bullet of the second item while it has two, then of the first.
    const shrink = vi.fn((c: ResumeContent): ResumeContent | null => {
      const k = (c.experience[1]?.bullets.length ?? 0) > 1 ? 1 : 0
      const target = c.experience[k] as ResumeContent['experience'][number]
      if (target.bullets.length <= 1) return null
      return {
        ...c,
        experience: c.experience.map((e, i) =>
          i === k ? { ...e, bullets: e.bullets.slice(0, -1) } : e,
        ),
      }
    })
    const d = deps(overBy(4))
    d.extraction.extractRenderedPages.mockImplementation(async (pdf: Buffer) => {
      const lines = skeletonLines(decodePdf(pdf), { omitEmail: false })
      return splitPages(
        lines.filter((l) => !l.includes('Alpha bullet 1')),
        1,
      )
    })
    // Two drops in the second item fit; the revert of the first adds one bullet back over the
    // limit, and the budget of 2 is still spent by the second item's drops.
    const err = await failure(
      renderAccepted(
        plan({ content: ai, notes, maxPages: 1, shrinkContent: shrink, maxContentDrops: 2 }),
        d,
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(shrink).toHaveBeenCalledTimes(2)
  })

  it('an ATS revert of the summary keeps the bullet drops counted', async () => {
    // The reverted (empty) summary costs one bullet of room: one more drop, past the budget.
    const d = deps(
      (input) =>
        1 + Math.max(0, bulletCount(input.content) + (input.content.summary === '' ? 1 : 0) - 2),
    )
    d.extraction.extractRenderedPages.mockImplementation(async (pdf: Buffer) => {
      const input = decodePdf(pdf)
      const lines = skeletonLines(input, { omitEmail: false })
      return splitPages(
        input.content.summary === '' ? lines : lines.filter((l) => !l.includes('Backend engineer')),
        1,
      )
    })
    const shrink = vi.fn(dropLast)
    const err = await failure(
      renderAccepted(
        plan({
          content: content(8),
          notes: { ...content(8), summary: '' },
          maxPages: 1,
          shrinkContent: shrink,
          maxContentDrops: 6,
        }),
        d,
      ),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(shrink).toHaveBeenCalledTimes(6)
  })

  it('the layout stops after 3 rounds: a 4th knob step that would fit is never taken', async () => {
    const d = deps((input) => (input.layout.fontScale === 'small' ? 1 : 31))
    const err = await failure(
      renderAccepted(plan({ layout: { ...SPENT, density: 'relaxed', fontScale: 'large' } }), d),
    )
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(d.typst.render).toHaveBeenCalledTimes(4)
  })
})

function decodeLast(d: ReturnType<typeof deps>): ResumeRenderInput {
  const calls = d.typst.render.mock.calls
  return calls[calls.length - 1]?.[0] as ResumeRenderInput
}
