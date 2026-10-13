import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MAX_EXTRACTION_INPUT_CHARS } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import { createOpenRouterExtractionAdapter } from './openrouter.extraction-adapter'

const schema = z.object({ title: z.string() })

type Reply = { status: number; body: string }
const okReply = (content: string, tokens = 5): Reply => ({
  status: 200,
  body: JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: tokens },
  }),
})
const goneReply: Reply = {
  status: 404,
  body: '{"error":{"message":"No endpoints found for model dead/model"}}',
}

function fakeFetch(replies: Reply[]) {
  const requests: {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
  }[] = []
  let i = 0
  const impl: FetchLike = async (url, init) => {
    requests.push({
      url,
      headers: init?.headers ?? {},
      body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
    })
    const reply = replies[Math.min(i++, replies.length - 1)]!
    return { status: reply.status, body: null, text: async () => reply.body }
  }
  return { impl, requests }
}

describe('createOpenRouterExtractionAdapter', () => {
  it('returns typed data and usage on a valid response', async () => {
    const { impl, requests } = fakeFetch([okReply('{"title":"x"}')])
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => 'a/model',
      fetchImpl: impl,
    })
    const res = await adapter.extract({ input: 'hello', schema })
    expect(res).toEqual({ ok: true, data: { title: 'x' }, usage: { totalTokens: 5 } })
    expect(requests[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(requests[0]!.headers.Authorization).toBe('Bearer k')
    expect(requests[0]!.body.model).toBe('a/model')
  })

  it('returns NOT_CONFIGURED when no model is resolved', async () => {
    const fetchImpl = vi.fn()
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => null,
      fetchImpl,
    })
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'NOT_CONFIGURED',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('truncates input to MAX_EXTRACTION_INPUT_CHARS', async () => {
    const { impl, requests } = fakeFetch([okReply('{"title":"x"}')])
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => 'a/model',
      fetchImpl: impl,
    })
    await adapter.extract({ input: 'a'.repeat(MAX_EXTRACTION_INPUT_CHARS + 500), schema })
    const messages = requests[0]!.body.messages as { role: string; content: string }[]
    const user = messages.find((m) => m.role === 'user')!
    expect(user.content.length).toBe(MAX_EXTRACTION_INPUT_CHARS)
  })

  it('maps 429 to RATE_LIMITED without calling onModelUnavailable', async () => {
    const { impl } = fakeFetch([{ status: 429, body: '' }])
    const onModelUnavailable = vi.fn()
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => 'a/model',
      onModelUnavailable,
      fetchImpl: impl,
    })
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
    })
    expect(onModelUnavailable).not.toHaveBeenCalled()
  })

  it('maps a timeout to TIMEOUT without calling onModelUnavailable', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const onModelUnavailable = vi.fn()
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => 'a/model',
      onModelUnavailable,
      timeoutMs: 20,
      fetchImpl: hanging,
    })
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'TIMEOUT',
    })
    expect(onModelUnavailable).not.toHaveBeenCalled()
  })

  it('maps a 500 to PROVIDER_ERROR without calling onModelUnavailable', async () => {
    const { impl } = fakeFetch([{ status: 500, body: 'boom' }])
    const onModelUnavailable = vi.fn()
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => 'a/model',
      onModelUnavailable,
      fetchImpl: impl,
    })
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
    expect(onModelUnavailable).not.toHaveBeenCalled()
  })

  it('returns PROVIDER_ERROR on a malformed envelope', async () => {
    const { impl } = fakeFetch([{ status: 200, body: '{"nope":1}' }])
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => 'a/model',
      fetchImpl: impl,
    })
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
  })

  it('returns INVALID_OUTPUT after the corrective retry fails validation', async () => {
    const { impl, requests } = fakeFetch([okReply('{"wrong":1}')])
    const adapter = createOpenRouterExtractionAdapter({
      apiKey: 'k',
      resolveModelId: () => 'a/model',
      fetchImpl: impl,
    })
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
    })
    expect(requests).toHaveLength(2)
  })

  describe('reactive model refresh', () => {
    it('retries once on the fresh model when the model is unavailable', async () => {
      const { impl, requests } = fakeFetch([goneReply, okReply('{"title":"y"}')])
      const onModelUnavailable = vi.fn(async () => 'fresh/model')
      const adapter = createOpenRouterExtractionAdapter({
        apiKey: 'k',
        resolveModelId: () => 'dead/model',
        onModelUnavailable,
        fetchImpl: impl,
      })
      const res = await adapter.extract({ input: 'x', schema })
      expect(res).toEqual({ ok: true, data: { title: 'y' }, usage: { totalTokens: 5 } })
      expect(onModelUnavailable).toHaveBeenCalledTimes(1)
      expect(onModelUnavailable).toHaveBeenCalledWith('dead/model')
      expect(requests).toHaveLength(2)
      expect(requests[0]!.body.model).toBe('dead/model')
      expect(requests[1]!.body.model).toBe('fresh/model')
    })

    it('returns PROVIDER_ERROR when no fresh model qualifies, with no loop', async () => {
      const { impl, requests } = fakeFetch([goneReply])
      const onModelUnavailable = vi.fn(async () => null)
      const adapter = createOpenRouterExtractionAdapter({
        apiKey: 'k',
        resolveModelId: () => 'dead/model',
        onModelUnavailable,
        fetchImpl: impl,
      })
      expect(await adapter.extract({ input: 'x', schema })).toEqual({
        ok: false,
        code: 'PROVIDER_ERROR',
      })
      expect(onModelUnavailable).toHaveBeenCalledTimes(1)
      expect(requests).toHaveLength(1)
    })

    it('swaps the model at most once even if the fresh model is also gone', async () => {
      const { impl, requests } = fakeFetch([goneReply]) // every call: model gone
      const onModelUnavailable = vi.fn(async () => 'fresh/model')
      const adapter = createOpenRouterExtractionAdapter({
        apiKey: 'k',
        resolveModelId: () => 'dead/model',
        onModelUnavailable,
        fetchImpl: impl,
      })
      const res = await adapter.extract({ input: 'x', schema })
      expect(res).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
      expect(onModelUnavailable).toHaveBeenCalledTimes(1)
      expect(requests).toHaveLength(2)
    })

    it('defaults to PROVIDER_ERROR when no onModelUnavailable hook is given', async () => {
      const { impl, requests } = fakeFetch([goneReply])
      const adapter = createOpenRouterExtractionAdapter({
        apiKey: 'k',
        resolveModelId: () => 'dead/model',
        fetchImpl: impl,
      })
      expect(await adapter.extract({ input: 'x', schema })).toEqual({
        ok: false,
        code: 'PROVIDER_ERROR',
      })
      expect(requests).toHaveLength(1)
    })
  })
})
