/**
 * Tailored render (plan Task 9): the lowest-relevance bullet drop, the page limit, and the visual
 * repair loop over `renderAccepted` + `visualGate`. Typst and the extractor are the run fakes.
 */
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  decodePdf,
  encodePdf,
  encodePng,
  skeletonLines,
  splitPages,
} from '../test/resume-run-fakes'
import type { ResumeRenderInput } from '../resumes/resume-typst.service'
import type { VisualReply } from '../resumes/verification/inference-clients'
import type { RenderDeps } from '../resumes/verification/render-gates'
import { assemblePrepared } from './tailored-prepare'
import {
  dropLowest,
  MAX_CONTENT_DROPS,
  MAX_VISUAL_ROUNDS,
  renderVerified,
  tailoredPageLimit,
} from './tailored-render'

type Item = ResumeContent['experience'][number]
const item = (company: string, bullets: string[]): Item => ({
  company,
  role: 'Dev',
  location: null,
  period: 'Mar 2021 – Present',
  bullets,
})
const withItems = (...items: Item[]): ResumeContent => ({
  ...EMPTY_RESUME_CONTENT,
  headline: 'Senior Backend Engineer',
  location: 'Lisbon, Portugal',
  workFormat: 'remote',
  summary: 'Backend engineer who builds APIs.',
  skills: ['Postgres', 'TypeScript'],
  experience: items,
  education: [{ institution: 'Stanford University', degree: 'BSc Physics', period: '2010 – 2014' }],
  languages: [{ name: 'English', level: 'C1' }],
})
const texts = (c: ResumeContent) => c.experience.map((i) => i.bullets)

describe('constants', () => {
  it('match the plan', () => {
    expect(MAX_CONTENT_DROPS).toBe(6)
    expect(MAX_VISUAL_ROUNDS).toBe(3)
  })

  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
  ])('tailoredPageLimit(%i) = %i', (base, limit) => {
    expect(tailoredPageLimit(base)).toBe(limit)
  })
})

describe('dropLowest', () => {
  it('removes the lowest-scored bullet, looked up by text', () => {
    const c = withItems(item('A', ['a1', 'a2']), item('B', ['b1', 'b2']))
    const out = dropLowest(
      c,
      new Map([
        ['a1', 3],
        ['a2', 1],
        ['b1', 2],
        ['b2', 3],
      ]),
    )
    expect(out && texts(out)).toEqual([['a1'], ['b1', 'b2']])
  })

  it('never drops an item’s last bullet', () => {
    const c = withItems(item('A', ['a1']), item('B', ['b1', 'b2']))
    const out = dropLowest(
      c,
      new Map([
        ['a1', 0],
        ['b1', 3],
        ['b2', 2],
      ]),
    )
    expect(out && texts(out)).toEqual([['a1'], ['b1']])
  })

  it('tie → the later item', () => {
    const c = withItems(item('A', ['a1', 'a2']), item('B', ['b1', 'b2']))
    const out = dropLowest(
      c,
      new Map([
        ['a1', 1],
        ['a2', 2],
        ['b1', 1],
        ['b2', 2],
      ]),
    )
    expect(out && texts(out)).toEqual([['a1', 'a2'], ['b2']])
  })

  it('tie inside an item → the later bullet', () => {
    const c = withItems(item('A', ['a1', 'a2', 'a3']))
    const out = dropLowest(
      c,
      new Map([
        ['a1', 1],
        ['a2', 1],
        ['a3', 2],
      ]),
    )
    expect(out && texts(out)).toEqual([['a1', 'a3']])
  })

  it('a bullet with no score ranks as relevance 0 (A1: no evidence it matters)', () => {
    const c = withItems(item('A', ['a1', 'base bullet']))
    const out = dropLowest(c, new Map([['a1', 1]]))
    expect(out && texts(out)).toEqual([['a1']])
  })

  it('three successive drops each remove the lowest remaining bullet', () => {
    const scores = new Map([
      ['x1', 3],
      ['x2', 0],
      ['x3', 2],
      ['x4', 1],
      ['x5', 3],
    ])
    let c: ResumeContent | null = withItems(item('A', ['x1', 'x2', 'x3', 'x4', 'x5']))
    const seen: string[][] = []
    for (let n = 0; n < 3; n++) {
      c = dropLowest(c as ResumeContent, scores)
      seen.push((c as ResumeContent).experience[0]?.bullets ?? [])
    }
    expect(seen).toEqual([
      ['x1', 'x3', 'x4', 'x5'],
      ['x1', 'x3', 'x5'],
      ['x1', 'x5'],
    ])
  })

  it('null when every item has one bullet left', () => {
    expect(dropLowest(withItems(item('A', ['a1']), item('B', ['b1'])), new Map())).toBeNull()
  })

  it('keeps every other field of the content', () => {
    const c = withItems(item('A', ['a1', 'a2']))
    const out = dropLowest(
      c,
      new Map([
        ['a1', 2],
        ['a2', 1],
      ]),
    )
    expect({ ...out, experience: [] }).toEqual({ ...c, experience: [] })
    expect(out?.experience[0]).toEqual({ ...c.experience[0], bullets: ['a1'] })
  })
})

const BASE = withItems(item('Acme', ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']))
const prepared = (pdfPages = 1) =>
  assemblePrepared({
    base: {
      id: 'r1',
      version: 1,
      content: BASE,
      templateName: 'classic',
      layout: { ...DEFAULT_RESUME_LAYOUT, density: 'compact', fontScale: 'small' },
      pdfPages,
    },
    owner: {
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      contacts: [{ fullName: 'Jane Doe', emails: ['jane@example.com'], telegram: null }],
    },
    opportunity: {
      title: 'Senior Engineer',
      employerName: 'Globex',
      descriptionMd: 'Go',
      tags: [],
    },
    now: new Date('2026-11-22T00:00:00Z'),
  })
const SCORES = new Map([
  ['b1', 3],
  ['b2', 0],
  ['b3', 2],
  ['b4', 1],
  ['b5', 3],
  ['b6', 2],
])
const bulletCount = (c: ResumeContent) => c.experience.reduce((n, i) => n + i.bullets.length, 0)
const finding = (check: string, page: number) => ({ check, page, detail: 'model text' })
const confirmed = (check: string): VisualReply[] => [
  { kind: 'ok', findings: [finding(check, 0)] },
  { kind: 'ok', findings: [finding(check, 0)] },
]

function deps(world: { pages?: (input: ResumeRenderInput) => number; vision?: VisualReply[] }) {
  const replies = [...(world.vision ?? [])]
  const pages = world.pages ?? (() => 1)
  return {
    typst: {
      render: vi.fn(async (input: ResumeRenderInput) => encodePdf(input)),
      renderPng: vi.fn(async (input: ResumeRenderInput) => [encodePng(input)]),
    },
    extraction: {
      countRenderedPages: vi.fn(async (pdf: Buffer) => pages(decodePdf(pdf))),
      extractRenderedPages: vi.fn(async (pdf: Buffer) =>
        splitPages(skeletonLines(decodePdf(pdf), { omitEmail: false }), 1),
      ),
    },
    vision: {
      check: vi.fn(
        async (_p: Buffer[]): Promise<VisualReply> =>
          replies.shift() ?? { kind: 'ok', findings: [] },
      ),
    },
    beforeModelCall: vi.fn(async () => undefined),
  } satisfies RenderDeps
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a failure')
    },
    (err: unknown) => err as { code: string; gates: { gate: string; items: unknown[] }[] },
  )

describe('renderVerified', () => {
  it('passes the base page limit: a 1-page base drops bullets until one page', async () => {
    const d = deps({ pages: (i) => (bulletCount(i.content) > 4 ? 2 : 1) })
    const { accepted, visual } = await renderVerified(BASE, prepared(1), SCORES, d)
    expect(accepted.content.experience[0]?.bullets).toEqual(['b1', 'b3', 'b5', 'b6'])
    expect(visual.ok).toBe(true)
  })

  it('a 3-page base allows 2 pages', async () => {
    const d = deps({ pages: () => 2 })
    const { accepted } = await renderVerified(BASE, prepared(3), SCORES, d)
    expect(bulletCount(accepted.content)).toBe(6)
  })

  it('one confirmed finding → one bullet dropped, re-rendered, passes', async () => {
    const d = deps({ vision: confirmed('overflow') })
    const { accepted, visual } = await renderVerified(BASE, prepared(), SCORES, d)
    expect(accepted.content.experience[0]?.bullets).toEqual(['b1', 'b3', 'b4', 'b5', 'b6'])
    expect(visual).toEqual({ gate: 'visual', ok: true, items: [] })
    expect(d.typst.render).toHaveBeenCalledTimes(2)
  })

  it('the next round starts from the accepted content: a drop is never undone', async () => {
    const d = deps({ vision: [...confirmed('overflow'), ...confirmed('overflow')] })
    const { accepted } = await renderVerified(BASE, prepared(), SCORES, d)
    expect(accepted.content.experience[0]?.bullets).toEqual(['b1', 'b3', 'b5', 'b6'])
  })

  it('3 confirmed findings → passes on the 4th check', async () => {
    const d = deps({ vision: [...confirmed('a'), ...confirmed('b'), ...confirmed('c')] })
    const { visual } = await renderVerified(BASE, prepared(), SCORES, d)
    expect(visual.ok).toBe(true)
  })

  it('… 4th confirmed finding → LAYOUT_UNFIXABLE carrying the visual items; vision calls ≤ 8', async () => {
    const d = deps({
      vision: [...confirmed('a'), ...confirmed('b'), ...confirmed('c'), ...confirmed('ragged')],
    })
    const err = await failure(renderVerified(BASE, prepared(), SCORES, d))
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(err.gates).toEqual([
      { gate: 'visual', ok: false, items: [{ path: 'pages.0', reason: 'ragged' }] },
    ])
    expect(d.vision.check).toHaveBeenCalledTimes(8)
  })

  it('a confirmed finding with nothing left to drop → LAYOUT_UNFIXABLE', async () => {
    const one = withItems(item('Acme', ['b1']))
    const d = deps({ vision: confirmed('overflow') })
    const err = await failure(renderVerified(one, prepared(), SCORES, d))
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(d.typst.render).toHaveBeenCalledTimes(1)
  })

  it('… VISUAL_CHECK_UNAVAILABLE → thrown, no drop', async () => {
    const d = deps({ vision: [{ kind: 'unavailable', reason: 'TIMEOUT' }] })
    const err = await failure(renderVerified(BASE, prepared(), SCORES, d))
    expect(err.code).toBe('VISUAL_CHECK_UNAVAILABLE')
    expect(d.typst.render).toHaveBeenCalledTimes(1)
  })

  it('a layout failure passes through unchanged', async () => {
    const d = deps({ pages: () => 3 })
    const err = await failure(renderVerified(BASE, prepared(3), SCORES, d))
    expect(err.code).toBe('LAYOUT_UNFIXABLE')
    expect(err.gates.map((g) => g.gate)).toEqual(['ats', 'layout'])
    expect(d.vision.check).not.toHaveBeenCalled()
  })

  it('the VISUAL_CHECK hook runs before every vision check, after its render', async () => {
    const d = deps({ vision: confirmed('overflow') })
    const order: string[] = []
    d.typst.render.mockImplementation(async (input: ResumeRenderInput) => {
      order.push('render')
      return encodePdf(input)
    })
    d.vision.check.mockImplementation(async () => {
      order.push('vision')
      return { kind: 'ok', findings: [] }
    })
    d.vision.check.mockImplementationOnce(async () => {
      order.push('vision')
      return confirmed('overflow')[0] as VisualReply
    })
    d.vision.check.mockImplementationOnce(async () => {
      order.push('vision')
      return confirmed('overflow')[1] as VisualReply
    })
    const onVisual = vi.fn(async () => {
      order.push('stage')
    })
    await renderVerified(BASE, prepared(), SCORES, d, onVisual)
    expect(order).toEqual(['render', 'stage', 'vision', 'vision', 'render', 'stage', 'vision'])
  })

  it('renders with the base template, layout and the owner’s name', async () => {
    const d = deps({})
    await renderVerified(BASE, prepared(), SCORES, d)
    const input = d.typst.render.mock.calls[0]?.[0] as ResumeRenderInput
    expect(input).toMatchObject({
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      templateName: 'classic',
      layout: { density: 'compact', fontScale: 'small' },
    })
  })
})
