import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../http/bounded-request'
import { decisionRequestSchema, type DecisionRequest } from '../contracts/decision'
import { createJevDecisionAdapter } from './jev.decision-adapter'

type Sent = { headers: Record<string, string>; body: string }

function fakeFetch(answers: unknown): { fetchImpl: FetchLike; sent: Sent[] } {
  const sent: Sent[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    sent.push({ headers: init?.headers ?? {}, body: init?.body ?? '' })
    return { status: 200, body: null, text: async () => JSON.stringify({ answers }) }
  }
  return { fetchImpl, sent }
}

const noul = { id: 'q', kind: 'noul', instructions: 'Is it broken?' } as const

describe('jev decision adapter — image assets', () => {
  it('a request without assets sends the same body as before and no images header', async () => {
    const { fetchImpl, sent } = fakeFetch({ q: { type: 'noul', noul: 0.1 } })
    await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide({
      state: { a: 1 },
      questions: [noul],
    })
    expect(sent[0]?.body).toBe(
      '{"state":{"a":1},"model":"jev-latest","questions":{"q":{"type":"noul","instructions":"Is it broken?"}}}',
    )
    expect(sent[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
    })
  })

  it('an empty assets map is the same as none', async () => {
    const { fetchImpl, sent } = fakeFetch({ q: { type: 'noul', noul: 0.1 } })
    await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide({
      state: 'x',
      questions: [noul],
      assets: {},
    })
    expect(sent[0]?.body).not.toContain('assets')
    expect(sent[0]?.headers).not.toHaveProperty('TypeSafe-Danger-Zone-Images')
  })

  it('image assets go top-level in the wire shape, with the images header', async () => {
    const { fetchImpl, sent } = fakeFetch({ q: { type: 'noul', noul: 0.9 } })
    const r = await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide({
      state: 'img-1',
      questions: [noul],
      assets: { 'img-1': { type: 'image', format: 'png', dataBase64: 'iVBORw0K' } },
    })
    expect(r).toEqual({
      ok: true,
      answers: [{ id: 'q', kind: 'noul', value: true, probability: 0.9 }],
    })
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
      state: 'img-1',
      model: 'jev-latest',
      questions: { q: { type: 'noul', instructions: 'Is it broken?' } },
      assets: { 'img-1': { type: 'image', format: 'png', data_base64: 'iVBORw0K' } },
    })
    expect(sent[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
      'TypeSafe-Danger-Zone-Images': 'true',
    })
  })

  it('the request schema keeps assets and refuses a non-image or empty one', () => {
    const base: DecisionRequest = { state: 'a', questions: [noul] }
    const ok = decisionRequestSchema.parse({
      ...base,
      assets: { a: { type: 'image', format: 'jpeg', dataBase64: 'AA==' } },
    })
    expect(ok.assets).toEqual({ a: { type: 'image', format: 'jpeg', dataBase64: 'AA==' } })
    const png = { type: 'image', format: 'png', dataBase64: 'AA==' } as const
    expect(decisionRequestSchema.parse({ ...base, assets: { a: png } }).assets).toEqual({ a: png })
    const bad = [
      { a: { type: 'video', format: 'png', dataBase64: 'AA==' } },
      { a: { type: 'image', format: 'gif', dataBase64: 'AA==' } },
      { a: { type: 'image', format: 'png', dataBase64: '' } },
      { '': { type: 'image', format: 'png', dataBase64: 'AA==' } },
    ]
    for (const assets of bad) {
      expect(decisionRequestSchema.safeParse({ ...base, assets }).success).toBe(false)
    }
  })
})

describe('jev decision adapter — long context', () => {
  it('longContext: true sends the long-context header and leaves the body as before', async () => {
    const { fetchImpl, sent } = fakeFetch({ q: { type: 'noul', noul: 0.1 } })
    await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide({
      state: { a: 1 },
      questions: [noul],
      longContext: true,
    })
    expect(sent[0]?.body).toBe(
      '{"state":{"a":1},"model":"jev-latest","questions":{"q":{"type":"noul","instructions":"Is it broken?"}}}',
    )
    expect(sent[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
      'TypeSafe-Danger-Zone-Long-Context': 'true',
    })
  })

  it('longContext: false sends no long-context header', async () => {
    const { fetchImpl, sent } = fakeFetch({ q: { type: 'noul', noul: 0.1 } })
    await createJevDecisionAdapter({ apiKey: 'k', fetchImpl }).decide({
      state: 'x',
      questions: [noul],
      longContext: false,
    })
    expect(sent[0]?.headers).not.toHaveProperty('TypeSafe-Danger-Zone-Long-Context')
  })

  it('the request schema keeps longContext and refuses a non-boolean', () => {
    const base: DecisionRequest = { state: 'a', questions: [noul] }
    expect(decisionRequestSchema.parse({ ...base, longContext: true }).longContext).toBe(true)
    expect(decisionRequestSchema.safeParse({ ...base, longContext: 'true' }).success).toBe(false)
  })
})
