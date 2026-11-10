import type { DecisionPort, DecisionRequest, DecisionResult } from '@crm/inference'
import type { ConfigService } from '@nestjs/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../config/env'
import {
  ENTAILMENT_QUESTION,
  ENTAILMENT_THRESHOLD,
  ResumeEntailmentClient,
  ResumeWriterClient,
  scoreEntailment,
  VisualCheckClient,
} from './inference-clients'
import { WORKER_ADAPTER_TIMEOUT_MS } from '../../job-sourcing/structuring/model-extraction-wiring'

const URL_ = 'http://crm-extraction-worker:3100'
const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

type Call = { url: string; init: { headers?: Record<string, string>; body?: string } }

function stubFetch(reply: unknown, status = 200): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init: Call['init']) => {
    calls.push({ url, init })
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
    return Promise.resolve(new Response(text, { status }))
  })
  return calls
}

function workerEnv(): void {
  vi.stubEnv('EXTRACTION_WORKER_URL', URL_)
  vi.stubEnv('EXTRACTION_WORKER_SECRET', SECRET)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('ResumeWriterClient', () => {
  it('an unset worker URL is unavailable, never a throw, and sends nothing', async () => {
    vi.stubEnv('EXTRACTION_WORKER_URL', '')
    vi.stubEnv('EXTRACTION_WORKER_SECRET', '')
    const calls = stubFetch({ kind: 'ok', summary: 'x' })
    await expect(new ResumeWriterClient().write('summary', '{}', [])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
    })
    expect(calls).toHaveLength(0)
  })

  it('an invalid worker env is unavailable too', async () => {
    vi.stubEnv('EXTRACTION_WORKER_URL', URL_)
    vi.stubEnv('EXTRACTION_WORKER_SECRET', '')
    stubFetch({ kind: 'ok', summary: 'x' })
    await expect(new ResumeWriterClient().write('summary', '{}', [])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
    })
  })

  it('posts the body to /resume-write with the shared secret and returns the summary', async () => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', summary: 'A summary.' })
    const r = await new ResumeWriterClient().write('summary', '{"a":1}', ['fix x'])
    expect(r).toEqual({ kind: 'ok', summary: 'A summary.' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${URL_}/resume-write`)
    expect(calls[0]?.init.headers?.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      task: 'summary',
      payload: '{"a":1}',
      feedback: ['fix x'],
    })
  })

  it('returns the bullets for a bullets task', async () => {
    workerEnv()
    const items = [{ index: 0, bullets: ['Did a thing.'] }]
    stubFetch({ kind: 'ok', items })
    await expect(new ResumeWriterClient().write('bullets', '{}', [])).resolves.toEqual({
      kind: 'ok',
      items,
    })
  })

  it('passes the worker unavailable reason through', async () => {
    workerEnv()
    stubFetch({ kind: 'unavailable', reason: 'TIMEOUT' })
    await expect(new ResumeWriterClient().write('summary', '{}', [])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'TIMEOUT',
    })
  })

  it.each([
    ['a reply of the other task', { kind: 'ok', items: [] }, 'summary'],
    ['a summary reply to a bullets task', { kind: 'ok', summary: 'x' }, 'bullets'],
    ['an extra key', { kind: 'ok', summary: 'x', extra: 1 }, 'summary'],
    ['an empty summary', { kind: 'ok', summary: '' }, 'summary'],
    ['an unknown reason', { kind: 'unavailable', reason: 'SOMETHING' }, 'summary'],
    ['not JSON', 'not json', 'summary'],
  ] as const)('%s is INVALID_OUTPUT', async (_n, reply, task) => {
    workerEnv()
    stubFetch(reply)
    await expect(new ResumeWriterClient().write(task, '{}', [])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_OUTPUT',
    })
  })

  it('a non-2xx is PROVIDER_ERROR', async () => {
    workerEnv()
    stubFetch({ error: 'BAD_REQUEST' }, 400)
    await expect(new ResumeWriterClient().write('summary', '{}', [])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
    })
  })

  it('a network error is PROVIDER_ERROR, never a throw', async () => {
    workerEnv()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    await expect(new ResumeWriterClient().write('summary', '{}', [])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
    })
  })

  it.each([
    ['a non-object payload', '[1]', []],
    ['a feedback line with a line break', '{}', ['a\nb']],
  ])('%s is refused before sending', async (_n, payload, feedback) => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', summary: 'x' })
    await expect(new ResumeWriterClient().write('summary', payload, feedback)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_INPUT',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('VisualCheckClient', () => {
  it('an unset worker env is unavailable', async () => {
    const calls = stubFetch({ kind: 'ok', findings: [] })
    await expect(new VisualCheckClient().check([PNG])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
    })
    expect(calls).toHaveLength(0)
  })

  it('posts base64 pages to /visual-check and returns the findings', async () => {
    workerEnv()
    const findings = [{ check: 'overflow', page: 1, text: 'Text runs past the margin.' }]
    const calls = stubFetch({ kind: 'ok', findings })
    await expect(new VisualCheckClient().check([PNG, PNG])).resolves.toEqual({
      kind: 'ok',
      findings,
    })
    expect(calls[0]?.url).toBe(`${URL_}/visual-check`)
    expect(calls[0]?.init.headers?.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      pages: [PNG.toString('base64'), PNG.toString('base64')],
    })
  })

  it.each([
    ['no page', []],
    ['three pages', [PNG, PNG, PNG]],
    ['a page that is not a PNG', [Buffer.from('GIF89a-not-a-png')]],
    [
      'a page over 1 500 000 bytes',
      [Buffer.concat([PNG, Buffer.alloc(1_500_000 - PNG.length + 1)])],
    ],
  ])('%s is refused before sending', async (_n, pages) => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', findings: [] })
    await expect(new VisualCheckClient().check(pages)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_INPUT',
    })
    expect(calls).toHaveLength(0)
  })

  it('a page of exactly 1 500 000 bytes is sent', async () => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', findings: [] })
    const page = Buffer.concat([PNG, Buffer.alloc(1_500_000 - PNG.length)])
    await expect(new VisualCheckClient().check([page])).resolves.toEqual({
      kind: 'ok',
      findings: [],
    })
    expect(calls).toHaveLength(1)
  })

  it.each([
    [
      'a finding on a page not sent',
      { kind: 'ok', findings: [{ check: 'overflow', page: 1, text: 'x' }] },
    ],
    ['an unknown check', { kind: 'ok', findings: [{ check: 'ugly', page: 0, text: 'x' }] }],
    ['no findings key', { kind: 'ok' }],
  ])('%s is INVALID_OUTPUT', async (_n, reply) => {
    workerEnv()
    stubFetch(reply)
    await expect(new VisualCheckClient().check([PNG])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_OUTPUT',
    })
  })

  it('a timeout is TIMEOUT', async () => {
    workerEnv()
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) =>
          init.signal.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    )
    const r = new VisualCheckClient().check([PNG])
    await vi.advanceTimersByTimeAsync(WORKER_ADAPTER_TIMEOUT_MS)
    await expect(r).resolves.toEqual({ kind: 'unavailable', reason: 'TIMEOUT' })
    vi.useRealTimers()
  })

  it('a worker unavailable reply passes through', async () => {
    workerEnv()
    stubFetch({ kind: 'unavailable', reason: 'NOT_CONFIGURED' })
    await expect(new VisualCheckClient().check([PNG])).resolves.toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
    })
  })
})

type Claim = { id: string; text: string; sources: string[] }
const claims = (n: number): Claim[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `claim ${i}`, sources: [`src ${i}`] }))

/** A fake Jev: answers every question with `answer(id)`, records each request. */
function fakePort(
  answer: (id: string) => { value: boolean; probability: number } = () => ({
    value: true,
    probability: 0.9,
  }),
): DecisionPort & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = []
  return {
    requests,
    decide: (req) => {
      requests.push(req)
      const result: DecisionResult = {
        ok: true,
        answers: req.questions.map((q) => ({ id: q.id, kind: 'noul', ...answer(q.id) })),
      }
      return Promise.resolve(result)
    },
  }
}

describe('scoreEntailment', () => {
  it('120 claims go in 3 Jev requests of at most 50 questions', async () => {
    const port = fakePort()
    const r = await scoreEntailment(port, claims(120))
    expect(port.requests.map((q) => q.questions.length)).toEqual([50, 50, 20])
    expect(r).toBeInstanceOf(Map)
    expect((r as Map<string, number>).size).toBe(120)
  })

  it('each question is a noul with the fixed question text, the claim and its sources in the state', async () => {
    const port = fakePort()
    await scoreEntailment(port, [{ id: 'a', text: 'Led X.', sources: ['Helped X.', 'Y.'] }])
    const req = port.requests[0]
    const q = req?.questions[0]
    expect(q?.kind).toBe('noul')
    expect(q?.id).toBe('a')
    expect(q?.instructions.startsWith(ENTAILMENT_QUESTION)).toBe(true)
    expect(ENTAILMENT_QUESTION).toBe(
      'Is this statement fully supported by these source statements? Inflated ownership verbs count as unsupported.',
    )
    expect(req?.state).toEqual({ a: { statement: 'Led X.', sources: ['Helped X.', 'Y.'] } })
  })

  it('the threshold is 0.8', () => {
    expect(ENTAILMENT_THRESHOLD).toBe(0.8)
  })

  it.each([
    [{ value: true, probability: 0.9 }, 0.9, true],
    [{ value: true, probability: 0.8 }, 0.8, true],
    [{ value: true, probability: 0.79 }, 0.79, false],
    [{ value: false, probability: 0.9 }, 0.1, false],
    [{ value: false, probability: 0.6 }, 0.4, false],
    // The adapter's own noul reading: value false means probability < 0.5, so it never scores high.
    [{ value: false, probability: 0.1 }, 0.1, false],
  ])('noul %o scores %d (supported: %s)', async (answer, score, supported) => {
    const r = (await scoreEntailment(
      fakePort(() => answer),
      claims(1),
    )) as Map<string, number>
    expect(r.get('c0')).toBeCloseTo(score, 10)
    expect((r.get('c0') ?? 0) >= ENTAILMENT_THRESHOLD).toBe(supported)
  })

  it('no claims is an empty map, no request', async () => {
    const port = fakePort()
    await expect(scoreEntailment(port, [])).resolves.toEqual(new Map())
    expect(port.requests).toHaveLength(0)
  })

  it('a duplicate claim id is unavailable and sends nothing', async () => {
    const port = fakePort()
    const dup = [...claims(2), { id: 'c0', text: 'again', sources: [] }]
    await expect(scoreEntailment(port, dup)).resolves.toBe('unavailable')
    expect(port.requests).toHaveLength(0)
  })

  it('an id Jev does not accept is unavailable and sends nothing', async () => {
    const port = fakePort()
    await expect(scoreEntailment(port, [{ id: '', text: 't', sources: [] }])).resolves.toBe(
      'unavailable',
    )
    expect(port.requests).toHaveLength(0)
  })

  it('a reply that omits a question id is unavailable for the whole call', async () => {
    const port: DecisionPort = {
      decide: (req) =>
        Promise.resolve({
          ok: true,
          answers: req.questions
            .slice(1)
            .map((q) => ({ id: q.id, kind: 'noul' as const, value: true, probability: 1 })),
        }),
    }
    await expect(scoreEntailment(port, claims(3))).resolves.toBe('unavailable')
  })

  it('a reply with an extra question id is unavailable', async () => {
    const port: DecisionPort = {
      decide: (req) =>
        Promise.resolve({
          ok: true,
          answers: [...req.questions.map((q) => q.id), 'ghost'].map((id) => ({
            id,
            kind: 'noul' as const,
            value: true,
            probability: 1,
          })),
        }),
    }
    await expect(scoreEntailment(port, claims(2))).resolves.toBe('unavailable')
  })

  it('a reply that answers one id twice instead of another is unavailable', async () => {
    const port: DecisionPort = {
      decide: () =>
        Promise.resolve({
          ok: true,
          answers: ['c0', 'c0'].map((id) => ({
            id,
            kind: 'noul' as const,
            value: true,
            probability: 1,
          })),
        }),
    }
    await expect(scoreEntailment(port, claims(2))).resolves.toBe('unavailable')
  })

  it('a non-noul answer is unavailable', async () => {
    const port: DecisionPort = {
      decide: (req) =>
        Promise.resolve({
          ok: true,
          answers: req.questions.map((q) => ({
            id: q.id,
            kind: 'score' as const,
            value: 1,
            confidence: 1,
          })),
        }),
    }
    await expect(scoreEntailment(port, claims(1))).resolves.toBe('unavailable')
  })

  it('one failed chunk makes the whole call unavailable', async () => {
    let n = 0
    const ok = fakePort()
    const port: DecisionPort = {
      decide: (req) =>
        ++n === 2 ? Promise.resolve({ ok: false, code: 'TIMEOUT' }) : ok.decide(req),
    }
    await expect(scoreEntailment(port, claims(120))).resolves.toBe('unavailable')
  })

  it('a throwing port is unavailable, never a throw', async () => {
    const port: DecisionPort = { decide: () => Promise.reject(new Error('boom')) }
    await expect(scoreEntailment(port, claims(1))).resolves.toBe('unavailable')
  })
})

const config = (key: string | undefined) =>
  ({ get: () => key }) as unknown as ConfigService<Env, true>

describe('ResumeEntailmentClient', () => {
  it('a missing JEV_API_KEY is unavailable and sends nothing', async () => {
    const calls = stubFetch({})
    await expect(new ResumeEntailmentClient(config(undefined)).score(claims(1))).resolves.toBe(
      'unavailable',
    )
    expect(calls).toHaveLength(0)
  })

  it('with a key it asks Jev, and its noul reply is scored', async () => {
    const calls = stubFetch({ answers: { c0: { type: 'noul', noul: 0.95 } } })
    const r = await new ResumeEntailmentClient(config('jev-key')).score(claims(1))
    expect(r).toEqual(new Map([['c0', 0.95]]))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/v1/systemone')
  })
})
