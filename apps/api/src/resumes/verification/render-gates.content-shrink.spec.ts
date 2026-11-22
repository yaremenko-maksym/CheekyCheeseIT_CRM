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
})

function decodeLast(d: ReturnType<typeof deps>): ResumeRenderInput {
  const calls = d.typst.render.mock.calls
  return calls[calls.length - 1]?.[0] as ResumeRenderInput
}
