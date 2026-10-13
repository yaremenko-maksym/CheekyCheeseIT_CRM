import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../http/bounded-request'
import type { DecisionRequest } from '../contracts/decision'
import { createJevDecisionAdapter } from './jev.decision-adapter'

function fakeFetch(body: unknown, status = 200): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(init?.body ?? '')
    return { status, body: null, text: async () => JSON.stringify(body) }
  }
  return { fetchImpl, calls }
}

const req: DecisionRequest = {
  state: { vacancy: 'x' },
  questions: [
    {
      id: 'fit',
      kind: 'choice',
      instructions: 'Is it a fit?',
      options: [{ value: 'yes', description: 'good fit' }, { value: 'no' }],
    },
    { id: 'lvl', kind: 'score', instructions: 'Seniority', levels: ['junior', 'mid', 'senior'] },
    { id: 'rem', kind: 'noul', instructions: 'Remote?', trueLabel: 'remote', falseLabel: 'onsite' },
  ],
}

const goodAnswers = {
  fit: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 },
  lvl: {
    type: 'score',
    score: 2,
    legend: { '0': 'junior', '1': 'mid', '2': 'senior' },
    probabilities: { '2': 0.5 },
    confidence: 0.5,
  },
  rem: { type: 'noul', noul: 0.2 },
}
const envelope = (answers: unknown) => ({
  model: 'jev-latest',
  answers,
  usage: { input_tokens: 100, output_tokens: 20 },
})
const run = async (answers: unknown) => {
  const { fetchImpl } = fakeFetch(envelope(answers))
  return createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide(req)
}
const invalid = { ok: false, code: 'INVALID_OUTPUT' }

describe('createJevDecisionAdapter', () => {
  it('sends the keyed-map System One request and maps answers + usage', async () => {
    const { fetchImpl, calls } = fakeFetch(envelope(goodAnswers))
    const res = await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide(req)
    expect(res).toEqual({
      ok: true,
      answers: [
        {
          id: 'fit',
          kind: 'choice',
          value: 'yes',
          confidence: 0.9,
          probabilities: { yes: 0.9, no: 0.1 },
        },
        { id: 'lvl', kind: 'score', value: 2, confidence: 0.5 },
        { id: 'rem', kind: 'noul', value: false, probability: 0.2 },
      ],
      usage: { totalTokens: 120 },
    })
    const sent = JSON.parse(calls[0]!)
    expect(sent.model).toBe('jev-latest')
    expect(sent.state).toEqual({ vacancy: 'x' })
    expect(sent.questions).toEqual({
      fit: {
        type: 'choice',
        instructions: 'Is it a fit?',
        criteria: { yes: 'good fit', no: 'no' },
      },
      lvl: { type: 'score', instructions: 'Seniority', criteria: ['junior', 'mid', 'senior'] },
      rem: {
        type: 'noul',
        instructions: 'Remote?',
        criteria: { true: 'remote', false: 'onsite' },
      },
    })
  })

  it('omits noul criteria when both labels are absent', async () => {
    const { fetchImpl, calls } = fakeFetch(envelope({ rem: goodAnswers.rem }))
    await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide({
      state: {},
      questions: [{ id: 'rem', kind: 'noul', instructions: 'Remote?' }],
    })
    expect(JSON.parse(calls[0]!).questions.rem).toEqual({ type: 'noul', instructions: 'Remote?' })
  })

  it('rejects a choice value outside the question options', async () => {
    expect(await run({ ...goodAnswers, fit: { ...goodAnswers.fit, choice: 'maybe' } })).toEqual(
      invalid,
    )
  })

  it('rejects a score outside the levels index range', async () => {
    expect(await run({ ...goodAnswers, lvl: { ...goodAnswers.lvl, score: 3 } })).toEqual(invalid)
    expect(await run({ ...goodAnswers, lvl: { ...goodAnswers.lvl, score: -1 } })).toEqual(invalid)
  })

  it('rejects a missing, extra or type-mismatched answer', async () => {
    const { rem: _rem, ...missing } = goodAnswers
    expect(await run(missing)).toEqual(invalid)
    expect(await run({ ...goodAnswers, extra: goodAnswers.rem })).toEqual(invalid)
    expect(await run({ ...goodAnswers, rem: goodAnswers.lvl })).toEqual(invalid)
  })

  it('rejects confidence/probability outside 0..1', async () => {
    expect(await run({ ...goodAnswers, fit: { ...goodAnswers.fit, confidence: 1.5 } })).toEqual(
      invalid,
    )
    expect(await run({ ...goodAnswers, rem: { type: 'noul', noul: 1.2 } })).toEqual(invalid)
    expect(
      await run({ ...goodAnswers, fit: { ...goodAnswers.fit, probabilities: { yes: 2 } } }),
    ).toEqual(invalid)
  })

  it('rejects answers that are not a keyed map', async () => {
    expect(await run([goodAnswers.fit])).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })

  it('returns NOT_CONFIGURED for an empty apiKey without calling', async () => {
    const { fetchImpl, calls } = fakeFetch({})
    expect(await createJevDecisionAdapter({ apiKey: '', fetchImpl }).decide(req)).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
    })
    expect(calls).toHaveLength(0)
  })

  it('returns PROVIDER_ERROR before calling when state is oversized', async () => {
    const { fetchImpl, calls } = fakeFetch({})
    const res = await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide({
      ...req,
      state: { blob: 'a'.repeat(300_000) },
    })
    expect(res).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(calls).toHaveLength(0)
  })

  it('maps 429, 500 and a malformed envelope to RATE_LIMITED / PROVIDER_ERROR', async () => {
    const a = createJevDecisionAdapter({ apiKey: 'k', fetchImpl: fakeFetch({}, 429).fetchImpl })
    expect(await a.decide(req)).toEqual({ ok: false, code: 'RATE_LIMITED' })
    const b = createJevDecisionAdapter({ apiKey: 'k', fetchImpl: fakeFetch({}, 500).fetchImpl })
    expect(await b.decide(req)).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    const c = createJevDecisionAdapter({ apiKey: 'k', fetchImpl: fakeFetch({ nope: 1 }).fetchImpl })
    expect(await c.decide(req)).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })

  it('maps an abort to TIMEOUT', async () => {
    const fetchImpl: FetchLike = (_u, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const res = await createJevDecisionAdapter({ apiKey: 'k', timeoutMs: 10, fetchImpl }).decide(
      req,
    )
    expect(res).toEqual({ ok: false, code: 'TIMEOUT' })
  })
})
