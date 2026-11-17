import { describe, expect, it } from 'vitest'
import { KEY_MARKER, scriptedFetch, type Reply } from './__test-helpers__/router-harness'
import { fetchModelListing, LISTING_MAX_ENTRIES, MODEL_LISTING_URLS } from './model-listing'

/** The OpenRouter catalogue as the router reads it (ADR §3.5 check 2). Fixtures only, `:free` ids. */
const FREE = { prompt: '0', completion: '0', request: '0', image: '0' }
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  context_length: 131_072,
  pricing: FREE,
  supported_parameters: ['structured_outputs', 'response_format'],
  ...over,
})
const catalogue = (data: unknown[]): Reply => ({ status: 200, body: JSON.stringify({ data }) })
const M1 = 'meta-llama/llama-3.3-70b-instruct:free'
const M2 = 'qwen/qwen3-235b-a22b:free'

async function list(reply: Reply) {
  const fake = scriptedFetch(() => reply)
  const result = await fetchModelListing({
    provider: 'openrouter',
    apiKey: KEY_MARKER,
    timeoutMs: 5_000,
    fetchImpl: fake.fetchImpl,
  })
  return { result, sent: fake.sent }
}

describe('the OpenRouter listing request', () => {
  it('goes to openrouter.ai with the key only in its header', async () => {
    const { sent } = await list(catalogue([]))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(MODEL_LISTING_URLS.openrouter)
    expect(sent[0]!.host).toBe('openrouter.ai')
    expect(sent[0]!.url).not.toContain(KEY_MARKER)
    expect(sent[0]!.headers).toEqual({ Authorization: `Bearer ${KEY_MARKER}` })
  })
})

describe('the OpenRouter listing filter', () => {
  it('keeps a free, schema-capable `:free` model as active, with its context', async () => {
    const { result } = await list(catalogue([entry(M1)]))
    expect(result).toEqual({
      kind: 'ok',
      models: [{ id: M1, context: 131_072, active: true }],
      dropped: 0,
      beyondCap: 0,
    })
  })

  it.each([
    ['a price above 0', entry(M1, { pricing: { ...FREE, completion: '0.0000001' } })],
    ['no pricing', entry(M1, { pricing: undefined })],
    ['empty pricing', entry(M1, { pricing: {} })],
    ['a null price', entry(M1, { pricing: { ...FREE, prompt: null } })],
    ['no structured_outputs', entry(M1, { supported_parameters: ['response_format'] })],
    ['no supported_parameters', entry(M1, { supported_parameters: undefined })],
    ['a bad `:free` id', entry('Not An Id:free')],
  ])('drops and counts %s', async (_l, e) => {
    const { result } = await list(catalogue([e, entry(M2)]))
    expect(result).toEqual({
      kind: 'ok',
      models: [{ id: M2, context: 131_072, active: true }],
      dropped: 1,
      beyondCap: 0,
    })
  })

  it('a garbage context is unknown, not a drop: the pick bounds it by the route window', async () => {
    const { result } = await list(catalogue([entry(M1, { context_length: 0 })]))
    expect(result).toMatchObject({
      kind: 'ok',
      models: [{ id: M1, context: undefined }],
      dropped: 0,
    })
  })

  it('never counts a paid entry: only `:free` ids reach the filter', async () => {
    const paid = entry('meta-llama/llama-3.3-70b-instruct', { pricing: { prompt: '0.0000001' } })
    const { result } = await list(catalogue([paid, { id: 7 }, null, entry(M1)]))
    expect(result).toEqual({
      kind: 'ok',
      models: [{ id: M1, context: 131_072, active: true }],
      dropped: 0,
      beyondCap: 0,
    })
  })

  it('a paid majority cannot push a free model past the entry cap', async () => {
    const paid = Array.from({ length: LISTING_MAX_ENTRIES + 5 }, (_, i) =>
      entry(`vendor/paid-${i}`, { pricing: { prompt: '1' } }),
    )
    const { result } = await list(catalogue([...paid, entry(M1)]))
    expect(result).toMatchObject({ kind: 'ok', models: [{ id: M1 }], beyondCap: 0 })
  })

  it('a wrong envelope is a failed listing', async () => {
    const { result } = await list({ status: 200, body: JSON.stringify({ models: [entry(M1)] }) })
    expect(result.kind).not.toBe('ok')
  })
})

describe('the OpenRouter listing byte cap (8 MiB)', () => {
  const pad = (bytes: number) => ' '.repeat(bytes)
  const CAP = 8 * 1024 * 1024
  it('accepts a body just under the cap and fails one over it', async () => {
    const under = await list({ status: 200, body: `{"data":[]}${pad(CAP - 11)}` })
    expect(under.result.kind).toBe('ok')
    const over = await list({ status: 200, body: `{"data":[]}${pad(CAP - 10)}` })
    expect(over.result).toEqual({ kind: 'failed', noResponse: false })
  })

  it('the cap is OpenRouter’s own: a Groq body of the same size fails', async () => {
    const fake = scriptedFetch(() => ({ status: 200, body: `{"data":[]}${pad(CAP - 11)}` }))
    const result = await fetchModelListing({
      provider: 'groq',
      apiKey: KEY_MARKER,
      timeoutMs: 5_000,
      fetchImpl: fake.fetchImpl,
    })
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })
})
