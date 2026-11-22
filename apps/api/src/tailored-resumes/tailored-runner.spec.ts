/**
 * The tailored run (plan Task 10) through the real stages: analysis, generation, render and the
 * visual check run as written, against fakes at the model and renderer ports. Only the DB edge is
 * replaced — claim / stage / ownership / FAILED (`tailored-run`), the prepare read and the publish
 * write — each pinned on a real Postgres by its own integration spec.
 */
import { Logger } from '@nestjs/common'
import type { DecisionAnswer, DecisionQuestion } from '@crm/inference'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResumeRenderInput } from '../resumes/resume-typst.service'
import { RunFailure } from '../resumes/verification/content-gates'
import {
  VISUAL_PROVIDER,
  type EntailmentClaim,
  type VisualReply,
} from '../resumes/verification/inference-clients'
import {
  decodePdf,
  encodePdf,
  encodePng,
  skeletonLines,
  splitPages,
} from '../test/resume-run-fakes'
import { TAILOR_PROVIDER, type TailorReply, type TailorWireReply } from './tailor-writer.client'
import { coverLetterText } from './tailored-draft'
import { assemblePrepared, prepareTailoring } from './tailored-prepare'
import { publishRun } from './tailored-publish'
import { claimRun, failRun, ownsRun, setStage, TailoredRunFailure } from './tailored-run'
import { coverageOf, narrowOrigin, runFailureOf, TailoredRunner } from './tailored-runner'

vi.mock('./tailored-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tailored-run')>()),
  claimRun: vi.fn(),
  setStage: vi.fn(),
  ownsRun: vi.fn(),
  failRun: vi.fn(),
}))
vi.mock('./tailored-prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tailored-prepare')>()),
  prepareTailoring: vi.fn(),
}))
vi.mock('./tailored-publish', () => ({ publishRun: vi.fn() }))

const NOTES = ['Ran 40 deploys a week', 'Wrote Postgres migrations', 'Used React for dashboards']
const BASE: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  headline: 'Senior Backend Engineer',
  location: 'Lisbon, Portugal',
  workFormat: 'remote',
  summary: 'Backend engineer who builds APIs.',
  skills: ['Postgres', 'TypeScript'],
  experience: [
    { company: 'Acme', role: 'Dev', location: null, period: 'Mar 2021 – Present', bullets: NOTES },
  ],
  education: [{ institution: 'Stanford University', degree: 'BSc Physics', period: '2010 – 2014' }],
  languages: [{ name: 'English', level: 'C1' }],
}
const prepared = (content: ResumeContent = BASE) => ({
  ...assemblePrepared({
    base: {
      id: 'base-1',
      version: 3,
      content,
      templateName: 'classic',
      layout: DEFAULT_RESUME_LAYOUT,
      pdfPages: 1,
    },
    owner: {
      displayName: 'Jane Doe',
      email: 'jane@example.com',
      contacts: [{ fullName: 'Jane Doe', emails: ['jane@example.com'], telegram: null }],
    },
    opportunity: {
      title: 'Senior Engineer',
      employerName: 'Globex',
      descriptionMd: 'We use React, Postgres and Kafka.',
      tags: ['Kafka'],
    },
    now: new Date('2026-11-22T00:00:00Z'),
  }),
  opportunityRevision: 5,
})

const UNIT = ['I', 'build', 'APIs', 'with', 'TypeScript', 'at', 'Acme']
const BODY = `${Array.from({ length: 105 }, (_, i) => UNIT[i % UNIT.length]).join(' ')}.`
const REPLY: TailorReply = {
  summary: 'Backend engineer who builds APIs.',
  skills: [
    { index: 0, name: 'Postgres' },
    { index: 1, name: 'TypeScript' },
  ],
  items: [{ bullets: NOTES.map((text, i) => ({ text, sourceIndices: [i] })) }],
  coverLetter: BODY,
}
const keepAll = (q: DecisionQuestion): DecisionAnswer =>
  q.kind === 'choice'
    ? { id: q.id, kind: 'choice', value: 'keep', confidence: 1, probabilities: {} }
    : { id: q.id, kind: 'score', value: 2, confidence: 1 }

type World = {
  reply?: TailorReply | Extract<TailorWireReply, { kind: 'unavailable' }>
  pages?: (input: ResumeRenderInput) => number
  vision?: VisualReply[]
}

function ports(w: World = {}) {
  const replies = [...(w.vision ?? [])]
  const pages = w.pages ?? (() => 1)
  const order: string[] = []
  const writer = {
    tailor: vi.fn(async (): Promise<TailorWireReply> => {
      order.push('writer')
      const r = w.reply ?? REPLY
      return 'kind' in r ? r : { kind: 'ok', ...r }
    }),
  }
  const decision = {
    decide: vi.fn(async (_s: Record<string, unknown>, qs: readonly DecisionQuestion[]) => {
      order.push('decision')
      return new Map(qs.map((q) => [q.id, keepAll(q)]))
    }),
  }
  const entailment = {
    score: vi.fn(async (cs: EntailmentClaim[]) => {
      order.push('entailment')
      return new Map(cs.map((c) => [c.id, 1]))
    }),
  }
  const typst = {
    render: vi.fn(async (input: ResumeRenderInput) => encodePdf(input)),
    renderPng: vi.fn(async (input: ResumeRenderInput) => [encodePng(input)]),
  }
  const extraction = {
    countRenderedPages: vi.fn(async (pdf: Buffer) => pages(decodePdf(pdf))),
    extractRenderedPages: vi.fn(async (pdf: Buffer) =>
      splitPages(skeletonLines(decodePdf(pdf), { omitEmail: false }), 1),
    ),
  }
  const vision = {
    check: vi.fn(async (): Promise<VisualReply> => {
      order.push('vision')
      return replies.shift() ?? { kind: 'ok', findings: [] }
    }),
  }
  const s3 = { upload: vi.fn(), delete: vi.fn(), getObject: vi.fn() }
  const db = { db: { tag: 'root' } }
  const runner = (cap = 2) =>
    new TailoredRunner(
      db as never,
      s3 as never,
      typst as never,
      extraction as never,
      vision as never,
      entailment as never,
      writer as never,
      decision as never,
      { get: vi.fn(() => cap) } as never,
    )
  return { writer, decision, entailment, typst, extraction, vision, s3, db, order, runner }
}

const ROW = {
  id: 'row-1',
  runId: 'run-1',
  jobOpportunityId: 'opp-1',
  seniorUserId: 'senior-1',
  runBaseVersion: 3,
}
const stages = () => vi.mocked(setStage).mock.calls.map((c) => c[3])

beforeEach(() => {
  vi.mocked(claimRun).mockResolvedValue(ROW as never)
  vi.mocked(setStage).mockResolvedValue(true)
  vi.mocked(ownsRun).mockResolvedValue(true)
  vi.mocked(failRun).mockResolvedValue(true)
  vi.mocked(prepareTailoring).mockResolvedValue(prepared())
  vi.mocked(publishRun).mockResolvedValue('PUBLISHED')
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

const published = () => vi.mocked(publishRun).mock.calls[0]?.[1]
const failedWith = () => vi.mocked(failRun).mock.calls.map((c) => [c[3], c[4]])

describe('TailoredRunner.run', () => {
  it('run walks the six stages in order, then publishes', async () => {
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(claimRun).toHaveBeenCalledWith(p.db.db, 'row-1', 'run-1')
    expect(stages()).toEqual([
      'FETCHING_POSTING',
      'ANALYSING',
      'TAILORING',
      'CHECKING',
      'RENDERING',
      'VISUAL_CHECK',
    ])
    expect(vi.mocked(setStage).mock.calls.every((c) => c[0] === p.db.db && c[2] === 'run-1')).toBe(
      true,
    )
    expect(prepareTailoring).toHaveBeenCalledWith(expect.objectContaining({ db: p.db, s3: p.s3 }), {
      rowId: 'row-1',
      runId: 'run-1',
      opportunityId: 'opp-1',
      seniorId: 'senior-1',
      runBaseVersion: 3,
    })
    expect(publishRun).toHaveBeenCalledTimes(1)
    expect(failRun).not.toHaveBeenCalled()
  })

  it('publishes the accepted render with its run, base and posting revision', async () => {
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    const [deps] = vi.mocked(publishRun).mock.calls[0] ?? []
    expect(deps).toMatchObject({ db: p.db.db, s3: p.s3 })
    expect(deps?.now()).toBeInstanceOf(Date)
    expect(published()).toMatchObject({ rowId: 'row-1', runId: 'run-1', runBaseVersion: 3 })
    expect(published()?.result).toMatchObject({
      baseResumeId: 'base-1',
      baseVersion: 3,
      opportunityRevision: 5,
      templateName: 'classic',
    })
    expect(published()?.result.accepted.content.experience[0]?.bullets).toEqual(NOTES)
  })

  it('C6: the published cover letter is greeting + gated body + closing with the display name', async () => {
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(published()?.result.coverLetter).toBe(
      `Dear Hiring Team,\n\n${BODY}\n\nI would be glad to walk you through this experience on a call.\n\nKind regards,\nJane Doe`,
    )
  })

  it('the verification lists every gate, the coverage and the three providers used', async () => {
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    const v = published()?.result.verification
    expect(v?.routes).toEqual([TAILOR_PROVIDER, 'jev', VISUAL_PROVIDER])
    expect(v?.gates.map((g) => g.gate)).toEqual(['content', 'ats', 'layout', 'visual'])
    expect(v?.coverage).toEqual({ matched: ['PostgreSQL', 'React'], total: 2 })
    expect(v?.gaps).toEqual(['Kafka'])
  })

  it('coverage is computed after layout drops: a dropped bullet’s only mention leaves matched', async () => {
    const bullets = (i: ResumeRenderInput) => i.content.experience[0]?.bullets.length ?? 0
    const p = ports({ pages: (i) => (bullets(i) > 2 ? 2 : 1) })
    await p.runner().run('row-1', 'run-1')
    expect(published()?.result.accepted.content.experience[0]?.bullets).toEqual(NOTES.slice(0, 2))
    expect(published()?.result.verification.coverage).toEqual({ matched: ['PostgreSQL'], total: 2 })
  })

  it('a VBR RunFailure GLYPH_CHECK_FAILED from renderAccepted → FAILED GLYPH_CHECK_FAILED', async () => {
    const glyph = { ...BASE, education: [{ ...BASE.education[0]!, degree: 'BSc Physics 😀' }] }
    vi.mocked(prepareTailoring).mockResolvedValue(prepared(glyph))
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(failedWith()).toEqual([['GLYPH_CHECK_FAILED', null]])
    expect(vi.mocked(failRun).mock.calls[0]?.slice(0, 3)).toEqual([
      { db: p.db.db, s3: p.s3, logger: expect.any(Logger) },
      'row-1',
      'run-1',
    ])
    expect(p.typst.render).not.toHaveBeenCalled()
    expect(publishRun).not.toHaveBeenCalled()
    expect(Logger.prototype.error).not.toHaveBeenCalled()
  })

  it('writer LIMITS_EXHAUSTED → FAILED LIMITS_EXHAUSTED, published columns untouched', async () => {
    const p = ports({ reply: { kind: 'unavailable', reason: 'LIMITS_EXHAUSTED' } })
    await p.runner().run('row-1', 'run-1')
    expect(failedWith()).toEqual([
      ['LIMITS_EXHAUSTED', { provider: TAILOR_PROVIDER, reason: 'LIMITS_EXHAUSTED' }],
    ])
    expect(publishRun).not.toHaveBeenCalled()
    expect(p.typst.render).not.toHaveBeenCalled()
    expect(Logger.prototype.error).not.toHaveBeenCalled()
  })

  it('a VBR code the tailored run lacks → INTERNAL_ERROR without a crash line', async () => {
    vi.mocked(prepareTailoring).mockRejectedValue(new RunFailure('INCOMPLETE'))
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(failedWith()).toEqual([['INTERNAL_ERROR', null]])
    expect(Logger.prototype.error).not.toHaveBeenCalled()
  })

  it('a thrown non-Error is logged as unknown', async () => {
    vi.mocked(prepareTailoring).mockRejectedValue('raw text')
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(vi.mocked(Logger.prototype.error).mock.calls.map((c) => String(c[0]))).toEqual([
      'Tailored run run-1 of row row-1 crashed (unknown)',
    ])
  })

  it('a suspected injection is logged with this run and row', async () => {
    const p = ports()
    p.decision.decide.mockImplementationOnce(
      async () =>
        new Map([['injection', { id: 'injection', kind: 'noul', value: true, probability: 0.9 }]]),
    )
    await p.runner().run('row-1', 'run-1')
    const warned = vi.mocked(Logger.prototype.warn).mock.calls.map((c) => String(c[0]))
    expect(warned).toContain(
      JSON.stringify({ event: 'TAILORED_INJECTION_SUSPECTED', rowId: 'row-1', runId: 'run-1' }),
    )
  })

  it('setStage false → no further write, no model call', async () => {
    vi.mocked(setStage).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(stages()).toEqual(['FETCHING_POSTING', 'ANALYSING'])
    expect(p.order).toEqual([])
    expect(failRun).not.toHaveBeenCalled()
    expect(publishRun).not.toHaveBeenCalled()
  })

  it.each(['CHECKING', 'VISUAL_CHECK'])(
    'a lost %s stage write stops the run quietly',
    async (lost) => {
      vi.mocked(setStage).mockImplementation(async (_db, _r, _id, stage) => stage !== lost)
      const p = ports()
      await p.runner().run('row-1', 'run-1')
      expect(stages().at(-1)).toBe(lost)
      expect(failRun).not.toHaveBeenCalled()
      expect(publishRun).not.toHaveBeenCalled()
    },
  )

  it('a run that cannot be claimed does nothing', async () => {
    vi.mocked(claimRun).mockResolvedValue(null)
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(setStage).not.toHaveBeenCalled()
    expect(failRun).not.toHaveBeenCalled()
  })

  it('beforeModelCall throws RunLost after the sweep changed run_id', async () => {
    vi.mocked(ownsRun).mockResolvedValue(false)
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(ownsRun).toHaveBeenCalledWith(p.db.db, 'row-1', 'run-1')
    expect(p.writer.tailor).not.toHaveBeenCalled()
    expect(failRun).not.toHaveBeenCalled()
    expect(publishRun).not.toHaveBeenCalled()
  })

  it('the render stage checks ownership before its vision calls', async () => {
    const p = ports()
    vi.mocked(ownsRun).mockImplementation(async () => p.typst.render.mock.calls.length === 0)
    await p.runner().run('row-1', 'run-1')
    expect(p.vision.check).not.toHaveBeenCalled()
    expect(failRun).not.toHaveBeenCalled()
  })

  it('unexpected TypeError → FAILED INTERNAL_ERROR, log carries "TypeError" and no message', async () => {
    vi.mocked(prepareTailoring).mockRejectedValue(new TypeError('Jane Doe jane@example.com'))
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(failedWith()).toEqual([['INTERNAL_ERROR', null]])
    const logged = vi.mocked(Logger.prototype.error).mock.calls.map((c) => String(c[0]))
    expect(logged).toEqual(['Tailored run run-1 of row row-1 crashed (TypeError)'])
  })

  it('a FAILED write that rejects is logged and the run still resolves', async () => {
    vi.mocked(prepareTailoring).mockRejectedValue(new TailoredRunFailure('BASE_CHANGED'))
    vi.mocked(failRun).mockRejectedValue(new Error('db down'))
    const p = ports()
    await expect(p.runner().run('row-1', 'run-1')).resolves.toBeUndefined()
    expect(vi.mocked(Logger.prototype.error).mock.calls.map((c) => String(c[0]))).toEqual([
      'Tailored run run-1 of row row-1: FAILED not written',
    ])
  })

  it('a row with no base version is an internal error, never a guess', async () => {
    vi.mocked(claimRun).mockResolvedValue({ ...ROW, runBaseVersion: null } as never)
    const p = ports()
    await p.runner().run('row-1', 'run-1')
    expect(prepareTailoring).not.toHaveBeenCalled()
    expect(failedWith()).toEqual([['INTERNAL_ERROR', null]])
  })
})

describe('TailoredRunner slots', () => {
  it('third enqueue with cap 2 waits and is in waitingRunIds until it starts', async () => {
    const gates: (() => void)[] = []
    vi.mocked(claimRun).mockImplementation(
      () =>
        new Promise((resolve) => {
          gates.push(() => resolve(null))
        }),
    )
    const p = ports()
    const r = p.runner(2)
    r.enqueue('row-1', 'run-1')
    r.enqueue('row-2', 'run-2')
    r.enqueue('row-3', 'run-3')
    await vi.waitFor(() => expect(claimRun).toHaveBeenCalledTimes(2))
    expect([...r.waitingRunIds()]).toEqual(['run-3'])
    gates[0]?.()
    await vi.waitFor(() => expect(claimRun).toHaveBeenCalledTimes(3))
    expect(vi.mocked(claimRun).mock.calls[2]?.slice(1)).toEqual(['row-3', 'run-3'])
    expect(r.waitingRunIds().size).toBe(0)
  })

  const blockClaims = () => {
    const gates: (() => void)[] = []
    vi.mocked(claimRun).mockImplementation(
      () =>
        new Promise((resolve) => {
          gates.push(() => resolve(null))
        }),
    )
    return gates
  }

  it('the configured cap holds: with 1, the second run waits', async () => {
    blockClaims()
    const r = ports().runner(1)
    r.enqueue('row-1', 'run-1')
    r.enqueue('row-2', 'run-2')
    await vi.waitFor(() => expect(claimRun).toHaveBeenCalledTimes(1))
    expect([...r.waitingRunIds()]).toEqual(['run-2'])
  })

  it('no config → the default cap of 2', async () => {
    blockClaims()
    const p = ports()
    const r = new TailoredRunner(
      p.db as never,
      p.s3 as never,
      p.typst as never,
      p.extraction as never,
      p.vision as never,
      p.entailment as never,
      p.writer as never,
      p.decision as never,
    )
    r.enqueue('row-1', 'run-1')
    r.enqueue('row-2', 'run-2')
    r.enqueue('row-3', 'run-3')
    await vi.waitFor(() => expect(claimRun).toHaveBeenCalledTimes(2))
    expect([...r.waitingRunIds()]).toEqual(['run-3'])
  })

  it('the slot count comes from TAILORED_RESUME_MAX_CONCURRENT_RUNS', () => {
    const p = ports()
    const config = { get: vi.fn(() => 2) }
    new TailoredRunner(
      p.db as never,
      p.s3 as never,
      p.typst as never,
      p.extraction as never,
      p.vision as never,
      p.entailment as never,
      p.writer as never,
      p.decision as never,
      config as never,
    )
    expect(config.get).toHaveBeenCalledWith('TAILORED_RESUME_MAX_CONCURRENT_RUNS', { infer: true })
  })
})

describe('runFailureOf', () => {
  it('a tailored failure keeps its code and origin', () => {
    const origin = { provider: 'p', reason: 'TIMEOUT' as const }
    expect(runFailureOf(new TailoredRunFailure('WRITER_UNAVAILABLE', [], origin))).toEqual({
      code: 'WRITER_UNAVAILABLE',
      origin,
    })
  })

  it('a VBR failure maps its code; a verified-base-only code is INTERNAL_ERROR', () => {
    expect(runFailureOf(new RunFailure('LAYOUT_UNFIXABLE'))).toEqual({
      code: 'LAYOUT_UNFIXABLE',
      origin: null,
    })
    expect(runFailureOf(new RunFailure('INCOMPLETE')).code).toBe('INTERNAL_ERROR')
  })

  it('anything else is INTERNAL_ERROR with no origin', () => {
    expect(runFailureOf(new TypeError('x'))).toEqual({ code: 'INTERNAL_ERROR', origin: null })
  })
})

describe('narrowOrigin', () => {
  it.each([
    [{ provider: VISUAL_PROVIDER, reason: 'TIMEOUT' }, 'TIMEOUT'],
    [{ provider: VISUAL_PROVIDER, reason: 'RATE_LIMITED:fetch failed' }, 'RATE_LIMITED'],
    [{ provider: VISUAL_PROVIDER, reason: 'INVALID_INPUT' }, 'INVALID_INPUT'],
    [{ provider: VISUAL_PROVIDER, reason: 'jane@example.com leaked text' }, 'PROVIDER_ERROR'],
  ])('%o → reason %s, never the free text', (origin, reason) => {
    expect(narrowOrigin({ ...origin, status: 503 })).toEqual({
      provider: VISUAL_PROVIDER,
      reason,
      status: 503,
    })
  })

  it('null stays null', () => {
    expect(narrowOrigin(null)).toBeNull()
  })
})

describe('coverageOf', () => {
  const content = (over: Partial<ResumeContent>): ResumeContent => ({ ...BASE, ...over })
  const reqs = [
    { name: 'React', bucket: 'supported' as const },
    { name: 'Postgres', bucket: 'existing' as const },
    { name: 'Kafka', bucket: 'gap' as const },
  ]

  it('of the existing / supported requirements, those mentioned in summary, skills or bullets', () => {
    expect(coverageOf(BASE, reqs)).toEqual({ matched: ['React', 'Postgres'], total: 2 })
  })

  it('a mention in the summary alone counts', () => {
    const c = content({
      skills: [],
      summary: 'Builds React apps.',
      experience: [{ ...BASE.experience[0]!, bullets: ['Shipped'] }],
    })
    expect(coverageOf(c, reqs)).toEqual({ matched: ['React'], total: 2 })
  })

  it('a mention in the skills alone counts', () => {
    const c = content({
      summary: 'Engineer.',
      skills: ['Postgres'],
      experience: [{ ...BASE.experience[0]!, bullets: ['Shipped'] }],
    })
    expect(coverageOf(c, reqs)).toEqual({ matched: ['Postgres'], total: 2 })
  })

  it('gap requirements are never in matched, even when mentioned', () => {
    const c = content({ summary: 'Kafka and React.' })
    expect(coverageOf(c, reqs).matched).not.toContain('Kafka')
    expect(coverageOf(c, reqs).total).toBe(2)
  })

  it('no requirements → nothing matched of zero', () => {
    expect(coverageOf(BASE, [])).toEqual({ matched: [], total: 0 })
  })
})

describe('coverLetterText', () => {
  it('greeting, body, closing: three paragraphs', () => {
    expect(coverLetterText('Body.', 'Jane Doe')).toBe(
      'Dear Hiring Team,\n\nBody.\n\nI would be glad to walk you through this experience on a call.\n\nKind regards,\nJane Doe',
    )
  })
})
