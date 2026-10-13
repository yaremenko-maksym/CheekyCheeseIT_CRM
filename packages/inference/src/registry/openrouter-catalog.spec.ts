import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../http/bounded-request'
import { fetchOpenRouterCatalog } from './openrouter-catalog'

function fakeFetch(
  status: number,
  body: unknown,
  capture?: { url?: string; auth?: string },
): FetchLike {
  return async (url, init) => {
    if (capture) {
      capture.url = url
      capture.auth = init?.headers?.Authorization ?? ''
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, body: null, text: async () => text }
  }
}

describe('fetchOpenRouterCatalog', () => {
  it('maps the catalog to OpenRouterModel with price per MTok', async () => {
    const capture: { url?: string; auth?: string } = {}
    const r = await fetchOpenRouterCatalog({
      apiKey: 'k',
      fetchImpl: fakeFetch(
        200,
        { data: [{ id: 'x/y', context_length: 32000, pricing: { prompt: '0.0000002' } }] },
        capture,
      ),
    })
    const models = r.ok ? r.models : []
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('x/y')
    expect(models[0]?.contextTokens).toBe(32000)
    expect(models[0]?.promptPriceUsdPerMTok).toBeCloseTo(0.2, 9)
    expect(capture.url).toBe('https://openrouter.ai/api/v1/models')
    expect(capture.auth).toBe('Bearer k')
  })
  it('429 -> RATE_LIMITED', async () =>
    expect(await fetchOpenRouterCatalog({ fetchImpl: fakeFetch(429, '') })).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
    }))
  it('malformed body -> PROVIDER_ERROR', async () => {
    expect(await fetchOpenRouterCatalog({ fetchImpl: fakeFetch(200, { nope: 1 }) })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
    expect(await fetchOpenRouterCatalog({ fetchImpl: fakeFetch(200, 'not json') })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
  })
  it('5xx -> PROVIDER_ERROR', async () =>
    expect(await fetchOpenRouterCatalog({ fetchImpl: fakeFetch(503, 'x') })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    }))
  it('timeout -> TIMEOUT', async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('a'))))
    expect(await fetchOpenRouterCatalog({ fetchImpl: hang, timeoutMs: 10 })).toEqual({
      ok: false,
      code: 'TIMEOUT',
    })
  })
  it('skips models with an invalid price instead of failing the whole catalog', async () => {
    const r = await fetchOpenRouterCatalog({
      fetchImpl: fakeFetch(200, {
        data: [
          { id: 'good/m', context_length: 8000, pricing: { prompt: '0.000001' } },
          { id: 'neg/m', context_length: 8000, pricing: { prompt: '-1' } },
          { id: 'nan/m', context_length: 8000, pricing: { prompt: 'free' } },
        ],
      }),
    })
    expect(r.ok && r.models.map((m) => m.id)).toEqual(['good/m'])
  })
})

describe('fetchOpenRouterCatalog hardening', () => {
  const good = { id: 'g/ok', context_length: 32000, pricing: { prompt: '0.0000002' } }
  const ids = async (data: unknown[], baseUrl?: string) => {
    const r = await fetchOpenRouterCatalog({
      ...(baseUrl !== undefined && { baseUrl }),
      fetchImpl: fakeFetch(200, { data }),
    })
    return r.ok ? r.models.map((m) => m.id) : 'ERR'
  }
  it('drops empty / whitespace / non-numeric / negative prices instead of treating them as free', async () => {
    const mk = (id: string, prompt: unknown) => ({
      id,
      context_length: 32000,
      pricing: { prompt },
    })
    expect(
      await ids([
        mk('e/empty', ''),
        mk('e/space', '   '),
        mk('e/abc', 'abc'),
        mk('e/neg', '-1'),
        mk('e/nan', 'NaN'),
        mk('e/inf', 'Infinity'),
        good,
      ]),
    ).toEqual(['g/ok'])
  })
  it('keeps a legitimately free model (0)', async () => {
    expect(await ids([{ ...good, id: 'f/free', pricing: { prompt: '0' } }])).toEqual(['f/free'])
  })
  it('drops a single malformed entry but keeps the rest', async () => {
    expect(
      await ids([
        good,
        { id: 'b/nopricing', context_length: 32000 },
        { id: 'b/noctx', pricing: { prompt: '0.1' } },
        { id: 5, context_length: 1, pricing: { prompt: '0.1' } },
        { id: 'b/badtype', context_length: 'x', pricing: { prompt: {} } },
        null,
        { ...good, id: 'g/ok2' },
      ]),
    ).toEqual(['g/ok', 'g/ok2'])
  })
  it('fails only when data itself is not an array', async () => {
    expect(await ids([])).toEqual([])
  })
  it('strips a trailing slash from a provided baseUrl', async () => {
    const capture: { url?: string } = {}
    await fetchOpenRouterCatalog({
      baseUrl: 'https://proxy.test/api/v1//',
      fetchImpl: fakeFetch(200, { data: [] }, capture),
    })
    expect(capture.url).toBe('https://proxy.test/api/v1/models')
  })
})
