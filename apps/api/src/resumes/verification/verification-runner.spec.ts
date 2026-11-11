/**
 * Unit spec of the run's orchestration (Task 14) over a recording DB double: which writes happen, in
 * which order, with which compare-and-set, and what is uploaded or deleted. The same flows on a real
 * Postgres are in verification-runner.integration.spec.ts.
 */
import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  RESUME_SECTION_ORDER,
  type ResumeContent,
  type ResumeFacts,
} from '@crm/shared'
import type { SeniorResume } from '../../database/schema'
import { WORKER_ADAPTER_TIMEOUT_MS } from '../../job-sourcing/structuring/model-extraction-wiring'
import { fakeRunDb } from '../../test/fake-run-db'
import {
  decodePdf,
  encodePdf,
  encodePng,
  skeletonLines,
  splitPages,
} from '../../test/resume-run-fakes'
import type { ResumeRenderInput } from '../resume-typst.service'
import type { EntailmentClaim, VisualReply, WriterReply, WriterTask } from './inference-clients'
import {
  CLEARED_STAGED,
  deleteStagedQuietly,
  regenerateTarget,
  stagedPdfKey,
  VERIFICATION_DEADLINE_MS,
  VERIFICATION_RUN_BUDGET_MS,
  VerificationRunner,
} from './verification-runner'

const RESUME = 'r-1'
const RUN = 'run-1'
const KEY = 'resumes/r-1/staged/run-1.pdf'
const OLD_KEY = 'resumes/r-1/staged/run-0.pdf'

const FACTS: ResumeFacts = {
  headline: 'Senior Backend Engineer',
  location: { city: 'Lisbon', country: 'Portugal' },
  workFormat: 'remote',
  skills: ['TypeScript', 'NestJS'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Tech Lead',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['TypeScript'],
      notes: ['Led the payments team', 'Thanks to Kowalska for billing'],
    },
  ],
  education: [
    { institution: 'Stanford University', degree: 'BSc Physics', startYear: 2010, endYear: 2014 },
  ],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/janedoe-unit' }],
}

const ROW = {
  id: RESUME,
  userId: 'u-1',
  facts: FACTS,
  templateName: 'classic',
  layout: { ...DEFAULT_RESUME_LAYOUT, sectionOrder: [...RESUME_SECTION_ORDER] },
  stagedEditedPaths: [],
} as unknown as SeniorResume

const USER = {
  displayName: 'Jane Doe',
  email: 'jane.doe@unit.spec',
  legalFullName: 'Jana Kowalska',
}

let world: { omitBullet: boolean; vision: VisualReply[] }
const typst = {
  render: vi.fn(async (input: ResumeRenderInput) => encodePdf(input)),
  renderPng: vi.fn(async (input: ResumeRenderInput) => [encodePng(input)]),
}
const extraction = {
  countRenderedPages: vi.fn(async () => 1),
  extractRenderedPages: vi.fn(async (pdf: Buffer) => {
    const lines = skeletonLines(decodePdf(pdf), { omitEmail: false })
    return splitPages(
      world.omitBullet ? lines.filter((l) => !l.startsWith('• Led the payments team')) : lines,
      1,
    )
  }),
}
const s3 = { upload: vi.fn(async () => {}), delete: vi.fn(async (_key: string) => {}) }
const payloads: string[] = []
const writer = {
  write: vi.fn(async (task: WriterTask, payload: string): Promise<WriterReply> => {
    payloads.push(payload)
    if (task === 'summary') return { kind: 'ok', summary: 'Backend engineer.' }
    const p = JSON.parse(payload) as { experience: { notes: string[] }[] }
    // Echoes the notes, minus a redacted one (the content gate would rightly fail it).
    const notes = (p.experience[0]?.notes ?? []).filter((n) => !n.includes('[REDACTED]'))
    return { kind: 'ok', items: [{ index: 0, bullets: notes }] }
  }),
}
const entailment = {
  score: vi.fn(async (claims: EntailmentClaim[]) => new Map(claims.map((c) => [c.id, 0.95]))),
}
const vision = {
  check: vi.fn(
    async (): Promise<VisualReply> => world.vision.shift() ?? { kind: 'ok', findings: [] },
  ),
}
let logs: string[]

function runner(results: unknown[][]) {
  const db = fakeRunDb(results)
  const r = new VerificationRunner(
    db.service,
    s3 as never,
    typst as never,
    extraction as never,
    writer as never,
    vision as never,
    entailment as never,
  )
  return { run: () => r.run(RESUME, RUN), log: db.log }
}

/** Claim, owner and the user's extra email: the reads every run that gets going makes first. */
const START = [[ROW], [USER], [{ email: 'jana.home@unit.spec' }]]

beforeEach(() => {
  vi.clearAllMocks()
  world = { omitBullet: false, vision: [] }
  payloads.length = 0
  logs = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      logs.push(String(message))
    })
  }
})
afterEach(() => vi.restoreAllMocks())

describe('constants', () => {
  it('budget is 20 minutes; the deadline adds one model call and a minute', () => {
    expect(VERIFICATION_RUN_BUDGET_MS).toBe(1_200_000)
    expect(VERIFICATION_DEADLINE_MS - WORKER_ADAPTER_TIMEOUT_MS).toBe(1_260_000)
    expect(stagedPdfKey('a', 'b')).toBe('resumes/a/staged/b.pdf')
    expect(CLEARED_STAGED).toEqual({
      stagedContent: null,
      stagedLayout: null,
      stagedTemplateName: null,
      stagedPdfS3Key: null,
      stagedEditedPaths: [],
    })
  })
})

describe('deleteStagedQuietly', () => {
  it('skips a null key and logs a failed delete by key only', async () => {
    const logger = new Logger('t')
    await deleteStagedQuietly(s3, logger, null)
    expect(s3.delete).not.toHaveBeenCalled()
    s3.delete.mockRejectedValueOnce(new Error('s3 down'))
    await expect(deleteStagedQuietly(s3, logger, KEY)).resolves.toBeUndefined()
    expect(logs).toEqual([`Staged resume PDF not deleted: ${KEY}`])
  })
})

describe('regenerateTarget', () => {
  it('reads summary and a whole bullet list, multi-digit index included', () => {
    expect(regenerateTarget('summary')).toBe('summary')
    expect(regenerateTarget('experience.0.bullets')).toBe(0)
    expect(regenerateTarget('experience.10.bullets')).toBe(10)
  })

  it('refuses null, one bullet, and anything around the exact shape', () => {
    for (const path of [
      null,
      'null',
      'experience.0.bullets.1',
      'xexperience.0.bullets',
      'experience.0.bulletsx',
      'experience.a.bullets',
      'experience..bullets',
    ]) {
      expect(regenerateTarget(path)).toBeNull()
    }
  })
})

describe('VerificationRunner.run', () => {
  it('happy path: claims, stages under a CAS, uploads the passing buffer, deletes the old object', async () => {
    const { run, log } = runner([...START, [{ key: OLD_KEY }], [{ id: RESUME }]])
    await run()

    expect(log.map((q) => [q.op, q.locked, q.inTransaction])).toEqual([
      ['update', false, false],
      ['select', false, false],
      ['select', false, false],
      ['select', true, true],
      ['update', false, true],
    ])
    const [claim, , , , stage] = log
    expect(claim?.set).toEqual({
      verificationStatus: 'CHECKING',
      verificationStartedAt: expect.any(Date),
    })
    expect(claim?.where?.params).toEqual([RESUME, RUN, 'QUEUED'])
    expect(log.map((q) => q.columns)).toEqual([
      undefined,
      ['displayName', 'email', 'legalFullName'],
      ['email'],
      ['key'],
      ['id'],
    ])
    expect(stage?.where?.params).toEqual([RESUME, RUN, 'CHECKING'])
    expect(stage?.where?.sql).toContain('"version" = "senior_resumes"."verification_base_version"')
    expect(stage?.set).toMatchObject({
      stagedPdfS3Key: KEY,
      stagedTemplateName: 'classic',
      stagedEditedPaths: [],
      verificationStatus: 'AWAITING_CONFIRM',
      verificationErrorCode: null,
    })
    const report = stage?.set?.verificationReport as { gates: { gate: string; ok: boolean }[] }
    expect(report.gates.map((g) => [g.gate, g.ok])).toEqual([
      ['content', true],
      ['ats', true],
      ['layout', true],
      ['visual', true],
    ])
    expect(s3.upload).toHaveBeenCalledWith(KEY, expect.any(Buffer), 'application/pdf', 'RESUME')
    const uploaded = (s3.upload.mock.calls[0] as unknown as [string, Buffer])[1]
    // The upload is the buffer of the last render, the one that passed.
    expect(uploaded).toEqual(await (typst.render.mock.results.at(-1)?.value as Promise<Buffer>))
    expect(decodePdf(uploaded).content.summary).toBe('Backend engineer.')
    expect(s3.delete.mock.calls).toEqual([[OLD_KEY]])
  })

  it('redacts the legal name too: one contact context per distinct name', async () => {
    const { run } = runner([...START, [{ key: null }], [{ id: RESUME }]])
    await run()
    expect(payloads.join('\n')).not.toContain('Kowalska')
    expect(payloads.join('\n')).toContain('Thanks to [REDACTED] for billing')
  })

  it('every owner email, primary and extra, is redacted, even one the generic pattern misses', async () => {
    const notes = [
      'Mail jane@corp.x for billing',
      'Mail jana@home.y for ops',
      'Led the payments team',
    ]
    const item = FACTS.experience[0] as ResumeFacts['experience'][number]
    const row = { ...ROW, facts: { ...FACTS, experience: [{ ...item, notes }] } }
    const { run } = runner([
      [row],
      [{ ...USER, email: 'jane@corp.x' }],
      [{ email: 'jana@home.y' }],
      [{ key: null }],
      [{ id: RESUME }],
    ])
    await run()
    const sent = payloads.join('\n')
    expect(sent).toContain('Mail [REDACTED] for billing')
    expect(sent).toContain('Mail [REDACTED] for ops')
    expect(sent).not.toContain('corp.x')
    expect(sent).not.toContain('home.y')
  })

  it('a legal name equal to the display name or empty adds no context', async () => {
    for (const legalFullName of [null, '  ', 'Jane Doe']) {
      const { run, log } = runner([
        [ROW],
        [{ ...USER, legalFullName }],
        [],
        [{ key: null }],
        [{ id: RESUME }],
      ])
      await run()
      expect(log.at(-1)?.set?.verificationStatus).toBe('AWAITING_CONFIRM')
    }
    expect(payloads.join('\n')).toContain('Thanks to Kowalska for billing')
  })

  it('a lost stage CAS deletes its own upload and nothing else', async () => {
    const { run } = runner([...START, [{ key: OLD_KEY }], []])
    await run()
    expect(s3.upload).toHaveBeenCalledTimes(1)
    expect(s3.delete.mock.calls).toEqual([[KEY]])
    expect(logs.some((l) => l.includes('superseded'))).toBe(true)
  })

  it('a won CAS over the same key, or over no key, deletes nothing', async () => {
    await runner([...START, [{ key: KEY }], [{ id: RESUME }]]).run()
    await runner([...START, [], [{ id: RESUME }]]).run()
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('a claim that misses (another run owns the row) does nothing', async () => {
    const { run, log } = runner([[]])
    await run()
    expect(log).toHaveLength(1)
    expect(writer.write).not.toHaveBeenCalled()
    expect(s3.upload).not.toHaveBeenCalled()
  })

  it('writer unavailable: FAILED WRITER_UNAVAILABLE under a run-id CAS, old object deleted', async () => {
    writer.write.mockResolvedValueOnce({ kind: 'unavailable', reason: 'TIMEOUT' } as WriterReply)
    const { run, log } = runner([...START, [{ key: OLD_KEY }], [{ id: RESUME }]])
    await run()
    const [lock, fail] = log.slice(3)
    expect([lock?.op, lock?.locked, lock?.inTransaction]).toEqual(['select', true, true])
    expect(fail?.inTransaction).toBe(true)
    expect(fail?.where?.params).toEqual([RESUME, RUN])
    expect(fail?.set).toEqual({
      verificationStatus: 'FAILED',
      verificationErrorCode: 'WRITER_UNAVAILABLE',
      verificationReport: { gates: [], fallbacks: [] },
      verificationRunId: null,
      verificationKind: null,
      verificationTargetPath: null,
      verificationBaseVersion: null,
      ...CLEARED_STAGED,
    })
    expect([lock?.columns, fail?.columns]).toEqual([['key'], ['id']])
    expect(s3.upload).not.toHaveBeenCalled()
    expect(s3.delete.mock.calls).toEqual([[OLD_KEY]])
    expect(logs).toContain(`Verification run ${RUN} of resume ${RESUME} failed: WRITER_UNAVAILABLE`)
  })

  it('a lost FAILED CAS deletes nothing', async () => {
    writer.write.mockResolvedValueOnce({ kind: 'unavailable', reason: 'TIMEOUT' } as WriterReply)
    await runner([...START, [{ key: OLD_KEY }], []]).run()
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('a won FAILED CAS over a row whose lock read found nothing deletes nothing', async () => {
    writer.write.mockResolvedValueOnce({ kind: 'unavailable', reason: 'TIMEOUT' } as WriterReply)
    const { run, log } = runner([...START, [], [{ id: RESUME }]])
    await run()
    expect(log).toHaveLength(5)
    expect(log.at(-1)?.set?.verificationStatus).toBe('FAILED')
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['facts that do not parse', [[{ ...ROW, facts: { headline: 1 } }]]],
    ['a missing owner', [[ROW], []]],
  ])('%s fail INCOMPLETE before any model call', async (_label, start) => {
    const { run, log } = runner([...start, [{ key: null }], [{ id: RESUME }]])
    await run()
    expect(log.at(-1)?.set?.verificationErrorCode).toBe('INCOMPLETE')
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('the report keeps the content gate and the failing stage, with the fallbacks', async () => {
    world.omitBullet = true
    const { run, log } = runner([...START, [{ key: null }], [{ id: RESUME }]])
    // The bullet is missing from every render, so the revert to the notes cannot fix it.
    await run()
    expect(log.at(-1)?.set).toMatchObject({
      verificationErrorCode: 'ATS_CHECK_FAILED',
      verificationReport: {
        gates: [
          { gate: 'content', ok: true, items: [] },
          {
            gate: 'ats',
            ok: false,
            items: [{ path: 'experience[0].bullets[0]', reason: 'MISSING_TEXT' }],
          },
        ],
        fallbacks: [],
      },
    })
    expect(typst.render).toHaveBeenCalledTimes(2)
  })

  it('a human-edited path from staged_edited_paths fails ATS_CHECK_FAILED naming it', async () => {
    world.omitBullet = true
    const row = {
      ...ROW,
      stagedEditedPaths: [
        { path: 'experience.0.bullets', userId: 'a14e0000-0000-4000-8000-0000000000b2' },
      ],
    }
    const { run, log } = runner([[row], [USER], [], [{ key: null }], [{ id: RESUME }]])
    await run()
    const report = log.at(-1)?.set?.verificationReport as { gates: unknown[] }
    expect(report.gates.at(-1)).toEqual({
      gate: 'ats',
      ok: false,
      items: [{ path: 'experience.0.bullets', reason: 'HUMAN_EDITED' }],
    })
    expect(typst.render).toHaveBeenCalledTimes(1)
  })

  it('a visual failure keeps the gates of every earlier stage', async () => {
    const finding = { check: 'overflow', page: 0, detail: 'x' }
    world.vision = [
      { kind: 'ok', findings: [finding] },
      { kind: 'ok', findings: [finding] },
    ] as VisualReply[]
    const { run, log } = runner([...START, [{ key: null }], [{ id: RESUME }]])
    await run()
    const report = log.at(-1)?.set?.verificationReport as { gates: { gate: string }[] }
    expect(report.gates.map((g) => g.gate)).toEqual(['content', 'ats', 'layout', 'visual'])
    expect(log.at(-1)?.set?.verificationErrorCode).toBe('VISUAL_CHECK_FAILED')
  })

  it('past the budget the next model call ends the run STALLED; at the budget it goes on', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    writer.write.mockImplementationOnce(async () => {
      now = 1_000 + VERIFICATION_RUN_BUDGET_MS
      return { kind: 'ok', summary: 'Backend engineer.' }
    })
    const ok = runner([...START, [{ key: null }], [{ id: RESUME }]])
    await ok.run()
    expect(ok.log.at(-1)?.set?.verificationStatus).toBe('AWAITING_CONFIRM')

    now = 1_000
    writer.write.mockImplementationOnce(async () => {
      now = 1_001 + VERIFICATION_RUN_BUDGET_MS
      return { kind: 'ok', summary: 'Backend engineer.' }
    })
    const late = runner([...START, [{ key: null }], [{ id: RESUME }]])
    await late.run()
    expect(late.log.at(-1)?.set?.verificationErrorCode).toBe('STALLED')
  })

  it('an unexpected error ends the run STALLED and deletes the derived key', async () => {
    s3.upload.mockRejectedValueOnce(new Error('s3 down'))
    const { run, log } = runner([...START, [{ key: null }], [{ id: RESUME }]])
    await expect(run()).resolves.toBeUndefined()
    expect(log.at(-1)?.set).toMatchObject({
      verificationStatus: 'FAILED',
      verificationErrorCode: 'STALLED',
      verificationReport: { gates: [], fallbacks: [] },
    })
    expect(s3.delete.mock.calls).toEqual([[KEY]])
    expect(logs).toContain(`Verification run ${RUN} of resume ${RESUME} crashed (Error)`)
  })

  it('when even the FAILED write throws, run still resolves and cleans up', async () => {
    s3.upload.mockRejectedValueOnce('not an error')
    const broken = new VerificationRunner(
      {
        db: {
          ...fakeRunDb([...START]).service.db,
          transaction: async () => {
            throw new Error('db down')
          },
        },
      } as never,
      s3 as never,
      typst as never,
      extraction as never,
      writer as never,
      vision as never,
      entailment as never,
    )
    await expect(broken.run(RESUME, RUN)).resolves.toBeUndefined()
    expect(logs).toContain(`Verification run ${RUN} of resume ${RESUME} crashed (unknown)`)
    expect(logs).toContain(`Verification run ${RUN} of resume ${RESUME}: FAILED not written`)
    expect(s3.delete.mock.calls).toEqual([[KEY]])
  })

  it('logs carry ids, codes and keys only: never a name, an email or model text', async () => {
    writer.write.mockResolvedValueOnce({ kind: 'unavailable', reason: 'TIMEOUT' } as WriterReply)
    await runner([...START, [{ key: OLD_KEY }], []]).run()
    s3.upload.mockRejectedValueOnce(new Error('Jane Doe jane.doe@unit.spec'))
    await runner([...START, [{ key: null }], [{ id: RESUME }]]).run()
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) {
      for (const banned of ['Jane', 'Kowalska', 'unit.spec', 'Backend engineer']) {
        expect(line).not.toContain(banned)
      }
    }
  })
})

describe('VerificationRunner.run — staged kinds (Task 15)', () => {
  const EDITOR = 'a15e0000-0000-4000-8000-0000000000b1'
  const PREVIOUS = {
    gates: [
      {
        gate: 'content',
        ok: false,
        items: [
          { path: 'summary', reason: 'UNSUPPORTED' },
          { path: 'experience.0.bullets', reason: 'UNSUPPORTED' },
        ],
      },
    ],
    fallbacks: ['summary', 'experience.0.bullets'],
  }

  /** The staged content a full run produced, so a staged run starts from a real stage 9 result. */
  async function stagedContent(): Promise<ResumeContent> {
    const { run, log } = runner([...START, [{ key: null }], [{ id: RESUME }]])
    await run()
    vi.clearAllMocks()
    return log.at(-1)?.set?.['stagedContent'] as ResumeContent
  }

  async function stagedRun(over: Partial<SeniorResume>) {
    const staged = await stagedContent()
    const row = {
      ...ROW,
      layout: { ...ROW.layout, hiddenSections: ['languages'] },
      stagedLayout: { ...ROW.layout, hiddenSections: [] },
      stagedTemplateName: 'modern',
      stagedContent: { ...staged, summary: 'Hand written summary.' },
      stagedEditedPaths: [{ path: 'summary', userId: EDITOR }],
      verificationReport: PREVIOUS,
      ...over,
    } as unknown as SeniorResume
    const { run, log } = runner([[row], [USER], [], [{ key: OLD_KEY }], [{ id: RESUME }]])
    await run()
    const stage = log.at(-1)
    const uploaded = s3.upload.mock.calls[0] as unknown as [string, Buffer] | undefined
    return { staged, stage, set: stage?.set ?? {}, rendered: uploaded && decodePdf(uploaded[1]) }
  }

  it('staged-edit: no writer and no entailment, the staged look, every edit kept', async () => {
    const { set, rendered } = await stagedRun({
      verificationKind: 'staged-edit',
      verificationTargetPath: 'summary',
    })
    expect(writer.write).not.toHaveBeenCalled()
    expect(entailment.score).not.toHaveBeenCalled()
    expect(set['verificationStatus']).toBe('AWAITING_CONFIRM')
    expect((set['stagedContent'] as ResumeContent).summary).toBe('Hand written summary.')
    expect('stagedEditedPaths' in set).toBe(false)
    expect(set['stagedTemplateName']).toBe('modern')
    expect(rendered?.templateName).toBe('modern')
    expect(rendered?.layout.hiddenSections).toEqual([])
    const report = set['verificationReport'] as typeof PREVIOUS
    // the person replaced the summary: its finding and fallback go, the item's stay
    expect(report.gates[0]).toEqual({
      gate: 'content',
      ok: false,
      items: [{ path: 'experience.0.bullets', reason: 'UNSUPPORTED' }],
    })
    expect(report.fallbacks).toEqual(['experience.0.bullets'])
  })

  it('staged-edit of one bullet keeps every earlier finding: the item path was not rewritten', async () => {
    const { set } = await stagedRun({
      verificationKind: 'staged-edit',
      verificationTargetPath: 'experience.0.bullets.0',
    })
    const report = set['verificationReport'] as typeof PREVIOUS
    expect(report.gates[0]).toEqual(PREVIOUS.gates[0])
    expect(report.fallbacks).toEqual(PREVIOUS.fallbacks)
  })

  it('no earlier report, or one whose first gate is not content: nothing is carried', async () => {
    for (const verificationReport of [
      null,
      {
        gates: [
          { gate: 'ats', ok: false, items: [{ path: 'summary', reason: 'MISSING' }] },
          { gate: 'content', ok: true, items: [] },
        ],
        fallbacks: [],
      },
    ]) {
      const { set } = await stagedRun({
        verificationKind: 'staged-edit',
        verificationTargetPath: 'experience.0.bullets.0',
        verificationReport: verificationReport as never,
      })
      const report = set['verificationReport'] as typeof PREVIOUS
      expect(report.gates[0]).toEqual({ gate: 'content', ok: true, items: [] })
      expect(report.fallbacks).toEqual([])
    }
  })

  it('item summary: writes the summary only, keeps the bullets, drops that path from the report', async () => {
    const { staged, set } = await stagedRun({
      verificationKind: 'item',
      verificationTargetPath: 'summary',
    })
    expect(writer.write.mock.calls.map((c) => c[0])).toEqual(['summary'])
    const content = set['stagedContent'] as ResumeContent
    expect(content.summary).toBe('Backend engineer.')
    expect(content.experience).toEqual(staged.experience)
    const report = set['verificationReport'] as typeof PREVIOUS
    expect(report.gates[0]).toEqual({
      gate: 'content',
      ok: false,
      items: [{ path: 'experience.0.bullets', reason: 'UNSUPPORTED' }],
    })
    expect(report.fallbacks).not.toContain('summary')
    expect(report.fallbacks).toContain('experience.0.bullets')
  })

  it('item bullets: with every earlier finding under that path gone, the content gate passes', async () => {
    const { set } = await stagedRun({
      verificationKind: 'item',
      verificationTargetPath: 'experience.0.bullets',
      verificationReport: {
        gates: [
          { gate: 'content', ok: false, items: [{ path: 'experience.0.bullets', reason: 'X' }] },
        ],
        fallbacks: ['experience.0.bullets'],
      } as never,
    })
    expect(writer.write.mock.calls.map((c) => c[0])).toEqual(['bullets'])
    const report = set['verificationReport'] as typeof PREVIOUS
    expect(report.gates[0]).toEqual({ gate: 'content', ok: true, items: [] })
    expect(report.fallbacks).not.toContain('experience.0.bullets')
    expect((set['stagedContent'] as ResumeContent).summary).toBe('Hand written summary.')
  })

  it('a staged kind without valid staged content, or an item without a target, fails INCOMPLETE', async () => {
    for (const over of [
      { verificationKind: 'staged-edit', stagedContent: null },
      { verificationKind: 'item', verificationTargetPath: 'experience.0.bullets.0' },
      { verificationKind: 'item', verificationTargetPath: null },
    ] as Partial<SeniorResume>[]) {
      const { stage } = await stagedRun(over)
      expect(stage?.set?.['verificationErrorCode']).toBe('INCOMPLETE')
      expect(writer.write).not.toHaveBeenCalled()
    }
  })
})
