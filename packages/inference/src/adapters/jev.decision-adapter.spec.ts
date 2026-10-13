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
    { id: 'fit', kind: 'choice', options: ['yes', 'no'] },
    { id: 'lvl', kind: 'score', min: 0, max: 10 },
    { id: 'rem', kind: 'noul' },
  ],
}

describe('createJevDecisionAdapter', () => {
  it('returns validated answers on the happy path and sends the systemone request', async () => {
    const { fetchImpl, calls } = fakeFetch({
      answers: [
        { id: 'fit', value: 'yes', confidence: 0.9 },
        { id: 'lvl', value: 7, confidence: 0.5 },
        { id: 'rem', value: true, confidence: 0.2 },
      ],
    })
    const res = await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide(req)
    expect(res).toEqual({
      ok: true,
      answers: [
        { id: 'fit', value: 'yes', confidence: 0.9 },
        { id: 'lvl', value: 7, confidence: 0.5 },
        { id: 'rem', value: true, confidence: 0.2 },
      ],
    })
    const sent = JSON.parse(calls[0]!)
    expect(sent.model).toBe('jev-latest')
    expect(sent.questions).toEqual([
      { id: 'fit', type: 'choice', options: ['yes', 'no'] },
      { id: 'lvl', type: 'score', min: 0, max: 10 },
      { id: 'rem', type: 'noul' },
    ])
  })

  it('rejects an answer id that was not requested', async () => {
    const { fetchImpl } = fakeFetch({ answers: [{ id: 'other', value: 'yes', confidence: 0.9 }] })
    expect(await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide(req)).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
    })
  })

  it('rejects confidence outside 0..1', async () => {
    const { fetchImpl } = fakeFetch({ answers: [{ id: 'fit', value: 'yes', confidence: 1.5 }] })
    expect(await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide(req)).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
    })
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
