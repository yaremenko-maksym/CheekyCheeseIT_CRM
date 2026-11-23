/** External vacancy intake PR 2 — `ManualParseService`: Jev `isVacancy`, then the hosted extraction. */
import type { DecisionPort, DecisionResult, ExtractionPort, ExtractionResult } from '@crm/inference'
import type { SessionUser } from '@crm/shared'
import { ForbiddenException, HttpException, Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import { InMemoryModelBudget } from '../structuring/model-budget.port'
import { ModelStructurer } from '../structuring/model-structurer'
import {
  createManualParsePorts,
  ManualParseService,
  PARSE_TIMEOUT_MS,
  toParseResponse,
  VACANCY_QUESTION,
  type ManualParsePorts,
} from './manual-parse.service'
import { JobQueueScopeService } from './queue-scope.service'

const ADMIN = { id: 'a', role: 'ADMIN' } as SessionUser
const HR = { id: 'h', role: 'HR' } as SessionUser

const TEXT =
  'Senior React Developer at Acme Corp. You will build product features in React and TypeScript.'

const record = (over: Record<string, unknown> = {}) => ({
  externalId: null,
  title: 'Senior React Developer',
  company: 'Acme Corp',
  location: null,
  remote: null,
  employmentType: null,
  salary: null,
  description: 'You will build product features in React and TypeScript.',
  postedAt: null,
  postingUrl: null,
  applyUrl: null,
  evidence: [
    { field: 'title', quote: 'Senior React Developer' },
    { field: 'company', quote: 'Acme Corp' },
    { field: 'description', quote: 'You will build product features in React and TypeScript.' },
  ],
  uncertainty: 0.1,
  ...over,
})

const reply = (records: unknown[] = [record()]): ExtractionResult<unknown> => ({
  ok: true,
  data: { extractionVersion: 'v1', records },
})

const jev = (probability: number, over: Record<string, unknown> = {}): DecisionResult => ({
  ok: true,
  answers: [
    { id: 'vacancy', kind: 'noul', value: probability >= 0.5, probability, ...over },
  ] as never,
})

function harness(
  opts: {
    decide?: DecisionPort['decide'] | null
    extract?: ExtractionPort['extract'] | null
    scope?: 'real' | 'NONE' | 'TEAM'
    inputCeilingChars?: number
  } = {},
) {
  const decide = vi.fn(
    opts.decide === undefined ? async () => jev(0.9) : (opts.decide ?? undefined),
  )
  const extract = vi.fn(
    opts.extract === undefined ? async () => reply() : (opts.extract ?? undefined),
  )
  const ports: ManualParsePorts = {
    decision: opts.decide === null ? undefined : ({ decide } as DecisionPort),
    // The production structurer comes from `buildManualStructurer` (its own spec); here the same
    // structurer over a fake port, so the service's own branches are under test.
    structurer:
      opts.extract === null
        ? undefined
        : () =>
            new ModelStructurer({
              port: { extract } as unknown as ExtractionPort,
              budget: new InMemoryModelBudget(1),
              timeoutMs: PARSE_TIMEOUT_MS,
              ...(opts.inputCeilingChars !== undefined && {
                inputCeilingChars: opts.inputCeilingChars,
              }),
            }),
  }
  const resolve = vi.fn(async () =>
    opts.scope === 'NONE' ? { kind: 'NONE' as const } : { kind: 'TEAM' as const, teamId: 't' },
  )
  const scopes =
    opts.scope === 'real'
      ? new JobQueueScopeService()
      : ({ resolve } as unknown as JobQueueScopeService)
  const db = { marker: 'db' }
  const service = new ManualParseService({ db } as unknown as DatabaseService, scopes, ports)
  return { service, decide, extract, resolve, db }
}

const code = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HttpException)
  const ex = err as HttpException
  return { status: ex.getStatus(), body: ex.getResponse() }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ManualParseService — the role, re-checked before any model call', () => {
  it.each(['SENIOR', 'JUNIOR', 'ACCOUNTANT'])('%s is a 403 and no port is called', async (role) => {
    const h = harness({ scope: 'real' })
    await expect(h.service.parse({ id: 'x', role } as SessionUser, TEXT)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.extract).not.toHaveBeenCalled()
  })

  it('an ADMIN passes the real scope check (the studio, no query)', async () => {
    const h = harness({ scope: 'real' })
    expect((await h.service.parse(ADMIN, TEXT)).isVacancy).toBe(true)
  })

  it('the scope is resolved for the actor without a team, over the service db', async () => {
    const h = harness()
    await h.service.parse(HR, TEXT)
    expect(h.resolve).toHaveBeenCalledWith(HR, undefined, h.db)
  })

  it('an HR without an active team is a 403 and no port is called', async () => {
    const h = harness({ scope: 'NONE' })
    await expect(h.service.parse(HR, TEXT)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.extract).not.toHaveBeenCalled()
  })
})

describe('ManualParseService — Jev decides whether it is a vacancy', () => {
  it('asks one noul question about the text', async () => {
    const h = harness()
    await h.service.parse(HR, TEXT)
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(h.decide).toHaveBeenCalledWith({
      state: { text: TEXT },
      questions: [{ id: 'vacancy', kind: 'noul', instructions: VACANCY_QUESTION }],
    })
    expect(VACANCY_QUESTION).toBe('Does this text describe one job vacancy?')
  })

  it('strips contacts from the text Jev sees', async () => {
    const h = harness()
    await h.service.parse(HR, `${TEXT} Write to jane.doe@example.com`)
    const state = h.decide.mock.calls[0]![0].state as { text: string }
    expect(state.text).not.toContain('jane.doe@example.com')
    expect(state.text).toContain('Senior React Developer')
  })

  it.each([0.49, 0.1, 0])('probability %s is no vacancy: extraction is never called', async (p) => {
    const h = harness({ decide: async () => jev(p) })
    expect(await h.service.parse(HR, TEXT)).toEqual({ isVacancy: false })
    expect(h.extract).not.toHaveBeenCalled()
  })

  it.each([0.5, 0.51, 1])('probability %s is a vacancy: extraction runs', async (p) => {
    const h = harness({ decide: async () => jev(p) })
    expect((await h.service.parse(HR, TEXT)).isVacancy).toBe(true)
    expect(h.extract).toHaveBeenCalledTimes(1)
  })

  it.each<[string, Partial<ManualParsePorts> | DecisionPort['decide'] | null]>([
    ['no Jev configured', null],
    ['Jev answers ok: false', async () => ({ ok: false, code: 'PROVIDER_ERROR' })],
    [
      'Jev throws',
      async () => {
        throw new Error('down')
      },
    ],
    ['an answer of another kind', async () => jev(0, { kind: 'score' })],
    ['an answer for another id', async () => jev(0, { id: 'other' })],
    ['no answer', async () => ({ ok: true, answers: [] })],
    [
      'two answers',
      async () => ({
        ok: true,
        answers: [
          { id: 'vacancy', kind: 'noul', value: false, probability: 0 },
          { id: 'vacancy', kind: 'noul', value: false, probability: 0 },
        ],
      }),
    ],
  ])('%s: treated as a vacancy, extraction runs (degrade, never break)', async (_, decide) => {
    const h = harness({ decide: decide as DecisionPort['decide'] | null })
    expect(await h.service.parse(HR, TEXT)).toEqual({
      isVacancy: true,
      title: 'Senior React Developer',
      companyName: 'Acme Corp',
      descriptionMd: 'You will build product features in React and TypeScript.',
    })
    expect(h.extract).toHaveBeenCalledTimes(1)
  })
})

describe('ManualParseService — the hosted extraction', () => {
  it('answers the guarded fields', async () => {
    const h = harness()
    expect(await h.service.parse(HR, TEXT)).toEqual({
      isVacancy: true,
      title: 'Senior React Developer',
      companyName: 'Acme Corp',
      descriptionMd: 'You will build product features in React and TypeScript.',
    })
  })

  it('sends the text framed as data, with the extraction schema', async () => {
    const h = harness()
    await h.service.parse(HR, TEXT)
    const req = h.extract.mock.calls[0]![0] as { input: string; instruction: string }
    expect(req.input).toContain(TEXT)
    expect(req.input).toMatch(/<<<PAGE-DATA-/)
    expect(req.instruction.length).toBeGreaterThan(0)
  })

  it('cuts the input to the configured window', async () => {
    const h = harness({ inputCeilingChars: 400 })
    await h.service.parse(HR, 'x'.repeat(5_000))
    const req = h.extract.mock.calls[0]![0] as { input: string }
    expect(req.input.length).toBeLessThanOrEqual(400)
  })

  it('a fact without a quote in the text is dropped by the guard', async () => {
    const h = harness({
      extract: async () =>
        reply([
          record({
            company: 'Globex',
            evidence: [{ field: 'title', quote: 'Senior React Developer' }],
          }),
        ]),
    })
    expect(await h.service.parse(HR, TEXT)).toEqual({
      isVacancy: true,
      title: 'Senior React Developer',
    })
  })

  it('no record: not recognized as a vacancy', async () => {
    const h = harness({ extract: async () => reply([]) })
    expect(await h.service.parse(HR, TEXT)).toEqual({ isVacancy: false })
  })

  it.each<[string, ExtractionPort['extract'] | null]>([
    ['no worker configured', null],
    [
      'the port throws',
      async () => {
        throw new Error('boom')
      },
    ],
    ['the port rejects', () => Promise.reject(new Error('boom'))],
    ['PROVIDER_ERROR', async () => ({ ok: false, code: 'PROVIDER_ERROR' })],
    ['NOT_CONFIGURED', async () => ({ ok: false, code: 'NOT_CONFIGURED' })],
    ['LIMITS_EXHAUSTED', async () => ({ ok: false, code: 'LIMITS_EXHAUSTED' })],
    ['INVALID_OUTPUT', async () => ({ ok: false, code: 'INVALID_OUTPUT' })],
    ['an unusable reply', async () => ({ ok: true, data: { nope: 1 } }) as ExtractionResult<never>],
  ])('%s: JOB_QUEUE_PARSE_UNAVAILABLE 503', async (_, extract) => {
    const h = harness({ extract })
    expect(await code(h.service.parse(HR, TEXT))).toEqual({
      status: 503,
      body: expect.objectContaining({ code: 'JOB_QUEUE_PARSE_UNAVAILABLE' }) as unknown,
    })
  })

  it('logs lengths and the outcome only, never the text', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const h = harness()
    await h.service.parse(HR, TEXT)
    expect(log).toHaveBeenCalledWith(`manual parse: chars=${TEXT.length} outcome=FILLED`)
    const noJev = harness({ decide: async () => jev(0) })
    await noJev.service.parse(HR, TEXT)
    expect(log).toHaveBeenCalledWith(`manual parse: chars=${TEXT.length} outcome=NOT_VACANCY`)
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain('Acme')
  })

  it('logs the outage outcome as a warning, never the text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const h = harness({ extract: async () => ({ ok: false, code: 'PROVIDER_ERROR' }) })
    await code(h.service.parse(HR, TEXT))
    expect(warn).toHaveBeenCalledWith(
      `manual parse: chars=${TEXT.length} outcome=UNAVAILABLE:MODEL_UNAVAILABLE`,
    )
  })

  it('logs a missing worker as NOT_CONFIGURED', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const h = harness({ extract: null })
    await code(h.service.parse(HR, TEXT))
    expect(warn).toHaveBeenCalledWith(
      `manual parse: chars=${TEXT.length} outcome=UNAVAILABLE:NOT_CONFIGURED`,
    )
  })

  it('logs a record-less reply as NO_RECORD', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const h = harness({ extract: async () => reply([]) })
    await h.service.parse(HR, TEXT)
    expect(log).toHaveBeenCalledWith(`manual parse: chars=${TEXT.length} outcome=NO_RECORD`)
  })
})

describe('toParseResponse', () => {
  it('trims every field and drops a blank or null one', () => {
    expect(toParseResponse({ title: '  T  ', company: '   ', description: null })).toEqual({
      isVacancy: true,
      title: 'T',
    })
  })

  it('caps each field at the response maximum', () => {
    const r = toParseResponse({
      title: 'a'.repeat(600),
      company: 'b'.repeat(300),
      description: 'c'.repeat(60_000),
    })
    expect(r.title).toHaveLength(500)
    expect(r.companyName).toHaveLength(255)
    expect(r.descriptionMd).toHaveLength(50_000)
  })

  it('trims after the cut, so a cut never ends in a space', () => {
    expect(
      toParseResponse({ title: `${'a'.repeat(499)} b`, company: null, description: null }),
    ).toEqual({
      isVacancy: true,
      title: 'a'.repeat(499),
    })
  })
})

describe('createManualParsePorts', () => {
  const SECRET = 'k3Y9fQ2mZ8wP4xL7vR1tN6bH5cJ0dAeGsUoIyTqWnMrKjXhV'
  const WORKER = {
    EXTRACTION_WORKER_URL: 'http://crm-extraction-worker:3100',
    EXTRACTION_WORKER_SECRET: SECRET,
  }
  const config = (key: string | undefined) =>
    ({ get: (name: string) => (name === 'JEV_API_KEY' ? key : 'other') }) as never

  it('no key and no worker env: no port at all', () => {
    expect(createManualParsePorts(config(undefined), {})).toEqual({
      decision: undefined,
      structurer: undefined,
    })
    expect(createManualParsePorts(undefined, {}).decision).toBeUndefined()
  })

  it('a Jev key gives the decision port; a worker env gives a structurer', () => {
    const ports = createManualParsePorts(config('k'), WORKER)
    expect(typeof ports.decision?.decide).toBe('function')
    expect(ports.structurer?.()).toBeInstanceOf(ModelStructurer)
  })

  it('an invalid worker env is no extraction port', () => {
    expect(
      createManualParsePorts(config('k'), { ...WORKER, EXTRACTION_WORKER_URL: 'ftp://x' })
        .structurer,
    ).toBeUndefined()
  })

  it('the Jev port asks with the configured key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }))
    const ports = createManualParsePorts(config('jev-key-1'), {}, fetchImpl as never)
    const res = await ports.decision!.decide({
      state: { text: 'x' },
      questions: [{ id: 'vacancy', kind: 'noul', instructions: VACANCY_QUESTION }],
    })
    expect(res.ok).toBe(false)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.stringify(init.headers)).toContain('Bearer jev-key-1')
  })

  it('the structurer posts to the worker /extract with the shared secret, in 30 s', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }))
    const ports = createManualParsePorts(config(undefined), WORKER, fetchImpl as never)
    const service = new ManualParseService(
      { db: {} } as unknown as DatabaseService,
      { resolve: async () => ({ kind: 'STUDIO' }) } as unknown as JobQueueScopeService,
      ports,
    )
    expect(await code(service.parse(ADMIN, TEXT))).toMatchObject({ status: 503 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://crm-extraction-worker:3100/extract')
    expect(JSON.stringify(init.headers)).toContain(SECRET)
  })
})
