import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_EXTRACTION_INPUT_CHARS } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import { createLocalExtractionAdapter } from './local.extraction-adapter'

const schema = z.object({ title: z.string() })

type Reply = { status: number; body: string }
const okReply = (content: string, tokens = 7): Reply => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: tokens } }),
})

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

describe('createLocalExtractionAdapter', () => {
  it('works against an http loopback base and uses the configured model', async () => {
    const { impl, requests } = fakeFetch([okReply('{"title":"x"}')])
    const adapter = createLocalExtractionAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
      fetchImpl: impl,
    })
    const res = await adapter.extract({ input: 'hi', schema })
    expect(res).toEqual({ ok: true, data: { title: 'x' }, usage: { totalTokens: 7 } })
    expect(requests[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(requests[0]!.body.model).toBe('llama3')
  })

  it('sends no Authorization header without an apiKey, and Bearer with one', async () => {
    const a = fakeFetch([okReply('{"title":"x"}')])
    await createLocalExtractionAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'm',
      fetchImpl: a.impl,
    }).extract({ input: 'hi', schema })
    expect(a.requests[0]!.headers.Authorization).toBeUndefined()

    const b = fakeFetch([okReply('{"title":"x"}')])
    await createLocalExtractionAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'm',
      apiKey: 'secret',
      fetchImpl: b.impl,
    }).extract({ input: 'hi', schema })
    expect(b.requests[0]!.headers.Authorization).toBe('Bearer secret')
  })

  it('refuses plain http to a non-loopback host', async () => {
    const { impl, requests } = fakeFetch([okReply('{"title":"x"}')])
    const adapter = createLocalExtractionAdapter({
      baseUrl: 'http://example.com/v1',
      model: 'm',
      fetchImpl: impl,
    })
    expect(await adapter.extract({ input: 'hi', schema })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
    expect(requests).toHaveLength(0)
  })

  it('truncates input to MAX_EXTRACTION_INPUT_CHARS', async () => {
    const { impl, requests } = fakeFetch([okReply('{"title":"x"}')])
    const adapter = createLocalExtractionAdapter({
      baseUrl: 'http://localhost:1/v1',
      model: 'm',
      fetchImpl: impl,
    })
    await adapter.extract({ input: 'a'.repeat(MAX_EXTRACTION_INPUT_CHARS + 10), schema })
    const messages = requests[0]!.body.messages as { role: string; content: string }[]
    expect(messages.find((m) => m.role === 'user')!.content.length).toBe(MAX_EXTRACTION_INPUT_CHARS)
  })

  it('maps 429 to RATE_LIMITED and treats a 404 as plain PROVIDER_ERROR (no reactive swap)', async () => {
    const rl = fakeFetch([{ status: 429, body: '' }])
    expect(
      await createLocalExtractionAdapter({
        baseUrl: 'http://localhost:1/v1',
        model: 'm',
        fetchImpl: rl.impl,
      }).extract({ input: 'x', schema }),
    ).toEqual({ ok: false, code: 'RATE_LIMITED' })

    const nf = fakeFetch([{ status: 404, body: 'No endpoints found for model m' }])
    expect(
      await createLocalExtractionAdapter({
        baseUrl: 'http://localhost:1/v1',
        model: 'm',
        fetchImpl: nf.impl,
      }).extract({ input: 'x', schema }),
    ).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(nf.requests).toHaveLength(1)
  })

  it('returns INVALID_OUTPUT after the corrective retry fails validation', async () => {
    const { impl, requests } = fakeFetch([okReply('{"wrong":1}')])
    const adapter = createLocalExtractionAdapter({
      baseUrl: 'http://localhost:1/v1',
      model: 'm',
      fetchImpl: impl,
    })
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
    })
    expect(requests).toHaveLength(2)
  })
})
