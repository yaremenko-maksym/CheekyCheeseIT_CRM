import type { DecisionAnswer, DecisionQuestion } from '@crm/inference'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { tailorBodySchema, type TailorBody } from '../extraction-worker/link-contract'
import type { ContactContext } from '../resumes/verification/contact-scan'
import type { EntailmentClaim, EntailmentScores } from '../resumes/verification/inference-clients'
import { TAILOR_PROVIDER, type TailorReply, type TailorWireReply } from './tailor-writer.client'
import type { Analysis } from './tailored-analysis'
import { bulletPath, COVER_GREETING } from './tailored-draft'
import { generateVerified, MAX_GENERATION_CALLS, type GenerateDeps } from './tailored-generate'
import { assemblePrepared, type PreparedRun } from './tailored-prepare'
import { REVIEW_REWRITE_REASON } from './tailored-review'
import { TailoredRunFailure } from './tailored-run'

const contacts: ContactContext[] = [
  { fullName: 'Jane Doe', emails: ['jane@example.com'], telegram: null },
]
const CONTACT = /jane@example\.com|Jane Doe/
const NOTES = ['Used React for dashboards', 'Ran 40 deploys a week', 'Wrote Postgres migrations']
const base: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Backend engineer who builds APIs.',
  skills: ['Postgres', 'TypeScript'],
  experience: [{ company: 'Acme', role: 'Dev', period: '2020 - 2022', bullets: NOTES }],
}
const prepare = (content: ResumeContent = base): PreparedRun =>
  assemblePrepared({
    base: {
      id: 'r1',
      version: 1,
      content,
      templateName: 'classic',
      layout: DEFAULT_RESUME_LAYOUT,
      pdfPages: 1,
    },
    owner: {
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      phone: null,
      telegram: null,
      contacts,
    },
    opportunity: {
      title: 'Senior Engineer',
      employerName: 'Globex',
      descriptionMd: 'We use React, Kubernetes and Kafka.',
      tags: [],
    },
    now: new Date('2026-11-22T00:00:00Z'),
  })
const prepared = prepare()
const analysis: Analysis = {
  injectionSuspected: false,
  requirements: [
    { name: 'React', bucket: 'existing' },
    { name: 'Kafka', bucket: 'gap' },
  ],
}

const UNIT = ['I', 'build', 'APIs', 'with', 'TypeScript', 'at', 'Acme']
const words = (n: number) => Array.from({ length: n }, (_, i) => UNIT[i % UNIT.length]).join(' ')
/** A grounded sentence of `n` words. */
const ok = (n: number) => `${words(n)}.`
/** A sentence of `n` words the fact gate refuses (Kafka is only in the posting). */
const kafka = (n: number) => `${words(n - 1)} Kafka.`
const cover = (...sentences: string[]) => sentences.join(' ')

const BULLETS = [
  { text: NOTES[0] as string, sourceIndices: [0] },
  { text: NOTES[1] as string, sourceIndices: [1] },
]
const reply = (over: Partial<TailorReply> = {}): TailorReply => ({
  summary: 'Backend engineer who builds APIs.',
  skills: [
    { index: 0, name: 'Postgres' },
    { index: 1, name: 'TypeScript' },
  ],
  items: [{ bullets: BULLETS }],
  coverLetter: ok(105),
  ...over,
})
const withBullets = (...bullets: { text: string; sourceIndices: number[] }[]) =>
  reply({ items: [{ bullets }] })
const LED = withBullets({ text: 'Led React dashboards', sourceIndices: [0] }, BULLETS[1]!)
const notLed = (c: EntailmentClaim) => !c.text.startsWith('Led')

type Reply = TailorReply | Extract<TailorWireReply, { kind: 'unavailable' }>
const keepAll = (q: DecisionQuestion): DecisionAnswer =>
  q.kind === 'choice'
    ? { id: q.id, kind: 'choice', value: 'keep', confidence: 1, probabilities: {} }
    : { id: q.id, kind: 'score', value: q.id === 'fit' ? 3 : 2, confidence: 1 }

/**
 * A run's model ports: `replies[n]` is the n-th writer reply (the last one repeats); every body is
 * checked against the worker's schema and for the senior's contacts; `order` records each budget
 * check and each model call.
 */
function harness(o: {
  replies: Reply[] | ((n: number) => Reply)
  supports?: (c: EntailmentClaim) => boolean
  answer?: (q: DecisionQuestion) => DecisionAnswer
}) {
  const bodies: TailorBody[] = []
  const claims: EntailmentClaim[] = []
  const questions: DecisionQuestion[][] = []
  const order: string[] = []
  const tailor = vi.fn(async (body: TailorBody): Promise<TailorWireReply> => {
    order.push('writer')
    expect(tailorBodySchema.safeParse(body).success).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(CONTACT)
    bodies.push(body)
    const n = bodies.length - 1
    const r =
      typeof o.replies === 'function' ? o.replies(n) : ((o.replies[n] ?? o.replies.at(-1)) as Reply)
    return 'kind' in r ? r : { kind: 'ok', ...r }
  })
  const score = vi.fn(async (cs: EntailmentClaim[]): Promise<EntailmentScores> => {
    order.push('entailment')
    claims.push(...cs)
    return new Map(cs.map((c) => [c.id, (o.supports ?? (() => true))(c) ? 1 : 0]))
  })
  const decide = vi.fn(async (_state: Record<string, unknown>, qs: readonly DecisionQuestion[]) => {
    order.push('decision')
    questions.push([...qs])
    return new Map(qs.map((q) => [q.id, (o.answer ?? keepAll)(q)]))
  })
  const beforeModelCall = vi.fn(async () => {
    order.push('budget')
  })
  const deps: GenerateDeps = {
    writer: { tailor },
    decision: { decide },
    entailment: { score },
    beforeModelCall,
  }
  return { deps, tailor, bodies, claims, questions, order, beforeModelCall }
}

const ref = (item: number, bullet: number) => ({ item, bullet, path: bulletPath(item, bullet) })
const fail = (p: Promise<unknown>) => p.catch((err: unknown) => err)

describe('generateVerified: first draft', () => {
  it('a faithful first draft: one writer call, the draft merged, every bullet scored once', async () => {
    const h = harness({ replies: [reply()] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(1)
    expect(h.bodies[0]?.feedback).toEqual([])
    expect(g.content).toEqual({
      ...base,
      experience: [{ ...base.experience[0], bullets: NOTES.slice(0, 2) }],
    })
    expect(g.coverBody).toBe(ok(105))
    expect(g.verification).toEqual({
      gates: [{ gate: 'content', ok: true, items: [] }],
      revertedPaths: [],
      keptFromBase: 0,
      gaps: ['Kafka'],
      injectionSuspected: false,
      postingPartial: false,
      postingTruncated: false,
    })
    expect(g.relevance).toEqual(
      new Map([
        [NOTES[0], 2],
        [NOTES[1], 2],
      ]),
    )
    expect(g.fit).toBe(3)
    expect(g.changedBullets).toEqual([])
    expect(h.questions).toHaveLength(1)
  })

  it('a base item with no bullets converges: its reply bullet is ignored, the item stays empty (CR-H-1)', async () => {
    const empty = { company: 'Initech', role: 'Lead', period: '2018 - 2020', bullets: [] }
    const content: ResumeContent = { ...base, experience: [...base.experience, empty] }
    const run = prepare(content)
    const h = harness({
      replies: [
        reply({
          items: [{ bullets: BULLETS }, { bullets: [{ text: 'Invented', sourceIndices: [0] }] }],
        }),
      ],
    })
    const g = await generateVerified(run, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(1)
    expect(g.content.experience).toEqual([
      { ...base.experience[0], bullets: NOTES.slice(0, 2) },
      empty,
    ])
    expect(g.verification.gates).toEqual([{ gate: 'content', ok: true, items: [] }])
  })

  it('the run budget is checked before every writer, reviewer and entailment call', async () => {
    const h = harness({ replies: [LED], supports: notLed })
    await generateVerified(prepared, analysis, h.deps)
    const unchecked = h.order.filter((call, k) => call !== 'budget' && h.order[k - 1] !== 'budget')
    expect(unchecked).toEqual([])
    expect(h.order.filter((c) => c === 'entailment').length).toBeGreaterThan(0)
    expect(h.order.filter((c) => c === 'writer')).toHaveLength(3)
    expect(h.order.filter((c) => c === 'decision')).toHaveLength(2)
  })

  it('the CHECKING hook runs once, after the first valid draft and before the reviewer', async () => {
    const h = harness({ replies: [LED], supports: notLed })
    const onChecking = vi.fn(async () => {
      h.order.push('checking')
    })
    await generateVerified(prepared, analysis, { ...h.deps, onChecking })
    expect(onChecking).toHaveBeenCalledTimes(1)
    const at = h.order.indexOf('checking')
    expect(h.order.slice(0, at)).toEqual(['budget', 'writer'])
    expect(h.order.indexOf('decision')).toBeGreaterThan(at)
  })

  it('a budget failure stops the run before the writer is called', async () => {
    const h = harness({ replies: [reply()] })
    const stalled = new TailoredRunFailure('STALLED')
    h.beforeModelCall.mockRejectedValueOnce(stalled)
    await expect(generateVerified(prepared, analysis, h.deps)).rejects.toBe(stalled)
    expect(h.tailor).not.toHaveBeenCalled()
  })

  it('greeting and closing are not sent to any gate', async () => {
    const h = harness({ replies: [reply()] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(JSON.stringify(h.claims)).not.toMatch(new RegExp(`${COVER_GREETING}|Kind regards`))
    expect(h.claims.some((c) => c.text === ok(105))).toBe(true)
    expect(g.coverBody).not.toContain(COVER_GREETING)
  })

  it('a body over the worker cap even with no feedback fails fast: no budget check, no writer call', async () => {
    const huge = { ...base.experience[0]!, bullets: ['y'.repeat(60_000)] }
    const h = harness({ replies: [reply()] })
    const e = await fail(
      generateVerified(prepare({ ...base, experience: [huge] }), analysis, h.deps),
    )
    expect(e).toBeInstanceOf(TailoredRunFailure)
    expect(e).toMatchObject({
      code: 'WRITER_UNAVAILABLE',
      origin: { provider: TAILOR_PROVIDER, reason: 'INVALID_INPUT' },
    })
    expect(h.beforeModelCall).not.toHaveBeenCalled()
    expect(h.tailor).not.toHaveBeenCalled()
  })

  it('writer LIMITS_EXHAUSTED → RunFailure LIMITS_EXHAUSTED', async () => {
    const h = harness({ replies: [{ kind: 'unavailable', reason: 'LIMITS_EXHAUSTED' }] })
    const e = await fail(generateVerified(prepared, analysis, h.deps))
    expect(e).toBeInstanceOf(TailoredRunFailure)
    expect(e).toMatchObject({
      code: 'LIMITS_EXHAUSTED',
      origin: { provider: TAILOR_PROVIDER, reason: 'LIMITS_EXHAUSTED' },
    })
    expect((e as TailoredRunFailure).gates).toEqual([])
  })

  it('any other unavailable → WRITER_UNAVAILABLE with its reason and status', async () => {
    const h = harness({ replies: [{ kind: 'unavailable', reason: 'PROVIDER_ERROR', status: 503 }] })
    await expect(generateVerified(prepared, analysis, h.deps)).rejects.toMatchObject({
      code: 'WRITER_UNAVAILABLE',
      origin: { provider: TAILOR_PROVIDER, reason: 'PROVIDER_ERROR', status: 503 },
    })
  })

  it('an invalid reply is retried once with the validation feedback', async () => {
    const h = harness({ replies: [reply({ items: [] }), reply()] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(2)
    expect(h.bodies[1]?.feedback).toEqual([
      'Return exactly 1 experience items, one per item in FACTS, in order.',
    ])
    expect(g.verification.gates[0]?.ok).toBe(true)
  })

  it('invalid twice → WRITER_UNAVAILABLE / INVALID_OUTPUT', async () => {
    const h = harness({ replies: [reply({ items: [] })] })
    const e = await fail(generateVerified(prepared, analysis, h.deps))
    expect(e).toBeInstanceOf(TailoredRunFailure)
    expect(e).toMatchObject({
      code: 'WRITER_UNAVAILABLE',
      origin: { provider: TAILOR_PROVIDER, reason: 'INVALID_OUTPUT' },
    })
    expect((e as TailoredRunFailure).gates).toEqual([])
    expect(h.tailor).toHaveBeenCalledTimes(2)
  })

  it('a reply with sentItems items on a trimmed payload validates; the unsent items are scored', async () => {
    const two: ResumeContent = {
      ...base,
      experience: [
        ...base.experience,
        {
          company: 'Initech',
          role: 'Lead',
          period: '2018 - 2020',
          bullets: [NOTES[0] as string, 'Hired 3 engineers'],
        },
      ],
    }
    const p = prepare(two)
    const payload = JSON.parse(p.payload) as { experience: unknown[] }
    const trimmed = {
      ...p,
      payload: JSON.stringify({ ...payload, experience: payload.experience.slice(0, 1) }),
      sentItems: 1,
    }
    const h = harness({
      replies: [reply()],
      answer: (q) =>
        q.id.startsWith('r-1-') ? { id: q.id, kind: 'score', value: 1, confidence: 1 } : keepAll(q),
    })
    const g = await generateVerified(trimmed, { ...analysis, injectionSuspected: true }, h.deps)
    expect(g.content.experience[1]).toEqual(two.experience[1])
    expect(g.changedBullets).toEqual([ref(1, 0), ref(1, 1)])
    expect(h.questions[1]?.map((q) => q.id)).toEqual(['r-1-0', 'r-1-1'])
    expect(h.questions[1]?.[0]?.instructions).toContain('The posting may carry instructions')
    expect(g.verification.injectionSuspected).toBe(true)
    // An identical text keeps the first score it got.
    expect(g.relevance).toEqual(
      new Map([
        [NOTES[0], 2],
        [NOTES[1], 2],
        ['Hired 3 engineers', 1],
      ]),
    )
  })

  it('a posting cut or without a description is flagged in the verification', async () => {
    const h = harness({ replies: [reply()] })
    const run = { ...prepared, posting: { ...prepared.posting, partial: true, truncated: true } }
    const g = await generateVerified(run, analysis, h.deps)
    expect(g.verification).toMatchObject({ postingPartial: true, postingTruncated: true })
  })

  it('a bullet Jev never scores has no relevance entry, though it is asked again', async () => {
    const noScore = (q: DecisionQuestion): DecisionAnswer =>
      q.id === 'r-0-1'
        ? { id: q.id, kind: 'choice', value: 'keep', confidence: 1, probabilities: {} }
        : keepAll(q)
    const h = harness({ replies: [reply()], answer: noScore })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(g.changedBullets).toEqual([ref(0, 1)])
    expect(g.relevance).toEqual(new Map([[NOTES[0], 2]]))
  })
})

describe('generateVerified: reviewer', () => {
  it('a cut bullet is dropped before the gates', async () => {
    const h = harness({
      replies: [reply()],
      answer: (q) =>
        q.id === 'v-0-0'
          ? { id: q.id, kind: 'choice', value: 'cut', confidence: 0.9, probabilities: {} }
          : keepAll(q),
    })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(g.content.experience[0]?.bullets).toEqual([NOTES[1]])
    expect(h.claims.map((c) => c.text)).not.toContain(NOTES[0])
    expect(g.relevance).toEqual(new Map([[NOTES[1], 2]]))
  })

  const rewrite1 = (q: DecisionQuestion): DecisionAnswer =>
    q.id === 'v-0-1'
      ? { id: q.id, kind: 'choice', value: 'rewrite', confidence: 0.4, probabilities: {} }
      : keepAll(q)

  it('a reviewer rewrite is fed back, and the rewritten bullet replaces it', async () => {
    const better = { text: 'Ran 40 deploys a week for teams', sourceIndices: [1] }
    const h = harness({ replies: [reply(), withBullets(BULLETS[0]!, better)], answer: rewrite1 })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual([
      `Experience item 1, bullet 2 (sourceIndices 1): ${REVIEW_REWRITE_REASON}.`,
    ])
    expect(g.content.experience[0]?.bullets).toEqual([NOTES[0], better.text])
    expect(g.changedBullets).toEqual([ref(0, 1)])
    expect(g.verification).toMatchObject({ revertedPaths: [], gates: [{ ok: true, items: [] }] })
  })

  it('a rewrite the writer never answers keeps the previous text, never a revert', async () => {
    const h = harness({ replies: [reply(), withBullets(BULLETS[0]!)], answer: rewrite1 })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(MAX_GENERATION_CALLS - 1)
    expect(g.content.experience[0]?.bullets).toEqual(NOTES.slice(0, 2))
    expect(g.verification).toMatchObject({ revertedPaths: [], keptFromBase: 0 })
  })

  it('a rewrite that fails the gates keeps the previous text, never a revert', async () => {
    const worse = { text: 'Led 40 deploys a week', sourceIndices: [1] }
    const h = harness({
      replies: [reply(), withBullets(BULLETS[0]!, worse)],
      answer: rewrite1,
      supports: notLed,
    })
    const g = await generateVerified(prepared, analysis, h.deps)
    // The failed rewrite leaves pending: no further writer call is spent on it.
    expect(h.tailor).toHaveBeenCalledTimes(2)
    expect(g.content.experience[0]?.bullets).toEqual(NOTES.slice(0, 2))
    expect(g.verification).toMatchObject({
      revertedPaths: [],
      keptFromBase: 0,
      gates: [{ gate: 'content', ok: true, items: [] }],
    })
    expect(g.changedBullets).toEqual([])
  })
})

describe('generateVerified: repair and revert', () => {
  it('"used" reworded to "led" fails entailment → after 2 repairs the bullet is its source bullets', async () => {
    const h = harness({ replies: [LED], supports: notLed })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(3)
    expect(h.bodies[1]?.feedback).toEqual([
      'Experience item 1, bullet 1 (sourceIndices 0): FACTS do not support it.',
    ])
    expect(g.content.experience[0]?.bullets).toEqual(NOTES.slice(0, 2))
    // The gate reads the returned content: the base bullet it holds now passes.
    expect(g.verification).toMatchObject({
      gates: [{ gate: 'content', ok: true, items: [] }],
      revertedPaths: ['experience.0.bullets.0'],
      keptFromBase: 1,
    })
    expect(g.changedBullets).toEqual([ref(0, 0)])
    expect(h.questions[1]?.map((q) => q.id)).toEqual(['r-0-0'])
  })

  it('a repair that fixes the bullet keeps the new text and scores it again', async () => {
    const h = harness({ replies: [LED, reply()], supports: notLed })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(2)
    expect(g.content.experience[0]?.bullets).toEqual(NOTES.slice(0, 2))
    expect(g.verification).toMatchObject({ revertedPaths: [], gates: [{ ok: true, items: [] }] })
    expect(g.changedBullets).toEqual([ref(0, 0)])
  })

  it('a reverted bullet with two sources becomes both base bullets; the paths are the returned ones (CR-M-1)', async () => {
    const h = harness({
      replies: [
        withBullets(
          { text: 'Led React dashboards and 40 deploys', sourceIndices: [1, 0] },
          { text: 'Led Postgres migrations', sourceIndices: [2] },
        ),
      ],
      supports: notLed,
    })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual([
      'Experience item 1, bullet 1 (sourceIndices 1, 0): FACTS do not support it.',
      'Experience item 1, bullet 2 (sourceIndices 2): FACTS do not support it.',
    ])
    expect(g.content.experience[0]?.bullets).toEqual([NOTES[1], NOTES[0], NOTES[2]])
    // The second draft bullet is the third returned one: every path names the returned content.
    expect(g.verification).toMatchObject({
      revertedPaths: ['experience.0.bullets.0', 'experience.0.bullets.1', 'experience.0.bullets.2'],
      keptFromBase: 3,
      gates: [{ gate: 'content', ok: true, items: [] }],
    })
    expect(g.changedBullets).toEqual([ref(0, 0), ref(0, 1), ref(0, 2)])
  })

  it.each([
    ['a subset', [1]],
    ['an overlapping set', [1, 2]],
  ])(
    'a reply bullet with %s of the failing bullet sourceIndices is not its repair',
    async (_, sourceIndices) => {
      const first = withBullets({
        text: 'Led React dashboards and 40 deploys',
        sourceIndices: [0, 1],
      })
      const other = withBullets({ text: 'Ran 40 deploys a week', sourceIndices })
      const h = harness({ replies: [first, other], supports: notLed })
      const g = await generateVerified(prepared, analysis, h.deps)
      expect(h.claims.map((c) => c.text)).not.toContain('Ran 40 deploys a week')
      expect(g.content.experience[0]?.bullets).toEqual(NOTES.slice(0, 2))
    },
  )

  it('an invalid repair reply feeds its problems into the next repair', async () => {
    const h = harness({ replies: [LED, reply({ items: [] }), reply()], supports: notLed })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.bodies[2]?.feedback).toEqual([
      'Return exactly 1 experience items, one per item in FACTS, in order.',
      'Experience item 1, bullet 1 (sourceIndices 0): FACTS do not support it.',
    ])
    expect(g.verification.revertedPaths).toEqual([])
  })

  it('two invalid repair replies in a row fail the run', async () => {
    const h = harness({ replies: [LED, reply({ items: [] })], supports: notLed })
    await expect(generateVerified(prepared, analysis, h.deps)).rejects.toMatchObject({
      code: 'WRITER_UNAVAILABLE',
      origin: { reason: 'INVALID_OUTPUT' },
    })
  })

  it('an ungrounded summary sentence is fed back, then the summary falls back to the base', async () => {
    const h = harness({ replies: [reply({ summary: 'Backend engineer at Globex.' })] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual([
      'Summary sentence 1: it states things that are not in FACTS: Globex.',
    ])
    expect(g.content.summary).toBe(base.summary)
    expect(g.verification).toMatchObject({ revertedPaths: ['summary'], keptFromBase: 1 })
  })

  it('an empty summary is fed back as empty and replaced by the repair', async () => {
    const repaired = 'Backend engineer who builds TypeScript APIs.'
    const h = harness({ replies: [reply({ summary: '   ' }), reply({ summary: repaired })] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual(['Summary: it is empty.'])
    expect(g.content.summary).toBe(repaired)
    expect(g.verification.revertedPaths).toEqual([])
  })

  it('skills the repair fixes are the repaired skills, never the base', async () => {
    const own: ResumeContent = { ...base, skills: ['Jane Doe Toolkit', 'TypeScript'] }
    const h = harness({
      replies: [
        reply({ skills: [{ index: 0, name: 'Jane Doe Toolkit' }] }),
        reply({ skills: [{ index: 1, name: 'TypeScript' }] }),
      ],
    })
    const g = await generateVerified(prepare(own), analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(2)
    expect(g.content.skills).toEqual(['TypeScript'])
    expect(g.verification.revertedPaths).toEqual([])
  })

  it('a bullet both failing a gate and marked for rewrite is reverted when no repair fixes it', async () => {
    const h = harness({
      replies: [LED],
      supports: notLed,
      answer: (q) =>
        q.id === 'v-0-0'
          ? { id: q.id, kind: 'choice', value: 'rewrite', confidence: 0.4, probabilities: {} }
          : keepAll(q),
    })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual([
      'Experience item 1, bullet 1 (sourceIndices 0): FACTS do not support it.',
      `Experience item 1, bullet 1 (sourceIndices 0): ${REVIEW_REWRITE_REASON}.`,
    ])
    expect(g.content.experience[0]?.bullets).toEqual(NOTES.slice(0, 2))
    expect(g.verification.revertedPaths).toEqual(['experience.0.bullets.0'])
  })

  it('a valid repair clears the earlier invalid feedback: an invalid last repair ends the loop', async () => {
    const h = harness({ replies: [LED, LED, reply({ items: [] })], supports: notLed })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(3)
    expect(h.bodies[2]?.feedback).toEqual([
      'Experience item 1, bullet 1 (sourceIndices 0): FACTS do not support it.',
    ])
    expect(g.verification.revertedPaths).toEqual(['experience.0.bullets.0'])
  })

  it('item and bullet numbers past 9 are read whole in the feedback and the repair', async () => {
    const notes = Array.from({ length: 11 }, (_, k) =>
      k === 10 ? NOTES[0] : `Ran ${k + 1} deploys`,
    )
    const job = { company: 'Acme', role: 'Dev', period: '2020 - 2022' }
    const many: ResumeContent = {
      ...base,
      experience: Array.from({ length: 11 }, (_, i) => ({
        ...job,
        bullets: i === 10 ? notes : [NOTES[1] as string],
      })),
    }
    const items = (last: string) =>
      Array.from({ length: 11 }, (_, i) => ({
        bullets:
          i === 10
            ? notes.map((text, k) => ({ text: k === 10 ? last : text, sourceIndices: [k] }))
            : [{ text: NOTES[1] as string, sourceIndices: [0] }],
      }))
    const h = harness({
      replies: [
        reply({ items: items('Led React dashboards') }),
        reply({ items: items(NOTES[0]!) }),
      ],
      supports: notLed,
    })
    const g = await generateVerified(prepare(many), analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual([
      'Experience item 11, bullet 11 (sourceIndices 10): FACTS do not support it.',
    ])
    expect(g.content.experience[10]?.bullets).toEqual(notes)
    expect(g.verification.revertedPaths).toEqual([])
  })

  it('a skill with a contact is fed back, then the skills fall back to the base', async () => {
    const own: ResumeContent = { ...base, skills: ['Jane Doe Toolkit', 'TypeScript'] }
    const h = harness({ replies: [reply({ skills: [{ index: 0, name: 'Jane Doe Toolkit' }] })] })
    const g = await generateVerified(prepare(own), analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual([
      'Skills: it contains a name, an email address, a phone number or a handle.',
    ])
    expect(g.content.skills).toEqual(own.skills)
    expect(g.verification.revertedPaths).toEqual(['skills'])
  })
})

describe('generateVerified: cover letter', () => {
  it('cover loses 1 of 5 sentences → the sentence is removed, no regeneration', async () => {
    const letter = cover(ok(26), ok(26), kafka(10), ok(26), ok(26))
    const h = harness({ replies: [reply({ coverLetter: letter })] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(3)
    expect(h.bodies[1]?.feedback).toEqual([
      'Cover letter sentence 3: it states things that are not in FACTS: Kafka.',
    ])
    expect(g.coverBody).toBe(cover(ok(26), ok(26), ok(26), ok(26)))
    expect(g.verification).toMatchObject({
      gates: [{ gate: 'content', ok: true, items: [] }],
      revertedPaths: [],
    })
  })

  it('cover loses 3 of 5 sentences → one regeneration, still failing → COVER_LETTER_UNGROUNDED', async () => {
    const letter = cover(kafka(5), kafka(5), kafka(5), ok(55), ok(55))
    const h = harness({ replies: [reply({ coverLetter: letter })] })
    const e = await fail(generateVerified(prepared, analysis, h.deps))
    expect(e).toBeInstanceOf(TailoredRunFailure)
    expect(e).toMatchObject({
      code: 'COVER_LETTER_UNGROUNDED',
      gates: [{ gate: 'content', ok: false }],
    })
    // writer calls never exceed 4; 2 spent repairs still leave the cover regeneration
    expect(h.tailor).toHaveBeenCalledTimes(MAX_GENERATION_CALLS)
    expect(MAX_GENERATION_CALLS).toBe(4)
  })

  it('a regenerated letter that passes is the cover letter, cleaned', async () => {
    const letter = cover(kafka(5), kafka(5), kafka(5), ok(55), ok(55))
    const h = harness({
      replies: (n) => reply({ coverLetter: n < 3 ? letter : ok(105).replace(' ', '  \n ') }),
    })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(4)
    expect(h.bodies[3]?.feedback).toContain(
      'Cover letter sentence 1: it states things that are not in FACTS: Kafka.',
    )
    expect(g.coverBody).toBe(ok(105))
    // The regenerated letter passed: no stale failure of the first letter is reported.
    expect(g.verification.gates).toEqual([{ gate: 'content', ok: true, items: [] }])
  })

  it('cover loses exactly half its sentences with 100+ words left → removed, no regeneration', async () => {
    const h = harness({
      replies: [reply({ coverLetter: cover(ok(55), kafka(5), ok(55), kafka(5)) })],
    })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(3)
    expect(g.coverBody).toBe(cover(ok(55), ok(55)))
  })

  it('a letter of exactly 100 words after the removal is kept', async () => {
    const h = harness({ replies: [reply({ coverLetter: cover(ok(50), ok(50), kafka(10)) })] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(3)
    expect(g.coverBody).toBe(cover(ok(50), ok(50)))
  })

  it('a letter under 100 words after the removal is regenerated', async () => {
    const letter = cover(ok(30), ok(30), ok(30), kafka(10))
    const h = harness({ replies: (n) => reply({ coverLetter: n < 3 ? letter : ok(105) }) })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(4)
    expect(g.coverBody).toBe(ok(105))
  })

  it('cover length 99 words → feedback, then the letter is regenerated', async () => {
    const h = harness({ replies: (n) => reply({ coverLetter: n < 3 ? ok(99) : ok(100) }) })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.bodies[1]?.feedback).toEqual([
      'Cover letter: the letter body must be 100 to 220 words.',
    ])
    expect(h.tailor).toHaveBeenCalledTimes(4)
    expect(g.coverBody).toBe(ok(100))
  })

  it('a letter the repair fixes is never regenerated', async () => {
    const h = harness({ replies: [reply({ coverLetter: ok(99) }), reply()] })
    const g = await generateVerified(prepared, analysis, h.deps)
    expect(h.tailor).toHaveBeenCalledTimes(2)
    expect(g.coverBody).toBe(ok(105))
  })
})
