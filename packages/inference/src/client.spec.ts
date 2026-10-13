import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InferenceClient } from './client'
import type { FetchLike } from './http/bounded-request'

function jsonFetch(body: unknown): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url)
    return { status: 200, body: null, text: async () => JSON.stringify(body) }
  }
  return { fetchImpl, urls }
}

const noul = { state: {}, questions: [{ id: 'n', kind: 'noul' as const }] }
const extractReq = { input: 'x', schema: z.object({ a: z.number() }) }
const chat = (content: string) => ({ choices: [{ message: { content } }] })

describe('InferenceClient', () => {
  it('returns NOT_CONFIGURED for decision when Jev is absent', async () => {
    const c = new InferenceClient({})
    expect(await c.decision.decide(noul)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('returns NOT_CONFIGURED for extraction when nothing is configured', async () => {
    const c = new InferenceClient({})
    expect(await c.extraction.extract(extractReq)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('returns NOT_CONFIGURED when the selected provider block is absent', async () => {
    const c = new InferenceClient({ extraction: { provider: 'local' } })
    expect(await c.extraction.extract(extractReq)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('routes decision to Jev when configured', async () => {
    const { fetchImpl, urls } = jsonFetch({ answers: [{ id: 'n', value: true, confidence: 0.4 }] })
    const c = new InferenceClient({ decision: { jev: { apiKey: 'k' } } }, { fetchImpl })
    expect(await c.decision.decide(noul)).toEqual({
      ok: true,
      answers: [{ id: 'n', value: true, confidence: 0.4 }],
    })
    expect(urls[0]).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('routes extraction to the local provider when configured', async () => {
    const { fetchImpl, urls } = jsonFetch(chat('{"a":1}'))
    const c = new InferenceClient(
      {
        extraction: {
          provider: 'local',
          local: { baseUrl: 'http://localhost:8080/v1', model: 'm' },
        },
      },
      { fetchImpl },
    )
    expect(await c.extraction.extract(extractReq)).toEqual({ ok: true, data: { a: 1 } })
    expect(urls[0]).toBe('http://localhost:8080/v1/chat/completions')
  })

  it('OpenRouter extraction is NOT_CONFIGURED until a model id resolver is wired', async () => {
    const { fetchImpl, urls } = jsonFetch(chat('{"a":1}'))
    const cfg = {
      extraction: {
        provider: 'openrouter' as const,
        openrouter: {
          apiKey: 'k',
          guardrails: { maxPromptPriceUsdPerMTok: 1, minContextTokens: 16000 },
        },
      },
    }
    const bare = new InferenceClient(cfg, { fetchImpl })
    expect(await bare.extraction.extract(extractReq)).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(urls).toHaveLength(0)

    const wired = new InferenceClient(cfg, { fetchImpl, resolveOpenRouterModelId: () => 'a/b' })
    expect(await wired.extraction.extract(extractReq)).toEqual({ ok: true, data: { a: 1 } })
    expect(urls[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
  })
})
