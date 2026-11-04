import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../http/bounded-request'
import { parseJsonOrNull, sendChatCompletion, type ChatCompletionOptions } from './chat-completions'

describe('parseJsonOrNull', () => {
  it('parses JSON and turns anything else into null', () => {
    expect(parseJsonOrNull('{"a":1}')).toStrictEqual({ a: 1 })
    expect(parseJsonOrNull('not json')).toBeNull()
  })
})

type Seen = { url: string; method?: string; headers?: Record<string, string>; body: unknown }

function fake(status: number, text: string): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({
      url,
      ...(init?.method !== undefined && { method: init.method }),
      ...(init?.headers !== undefined && { headers: init.headers }),
      body: JSON.parse(init?.body ?? 'null') as unknown,
    })
    return { status, body: null, text: async () => text }
  }
  return { fetchImpl, seen }
}

const ok = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ choices: [{ message: { content: '{}' } }], ...extra })

const base: Omit<ChatCompletionOptions, 'fetchImpl'> = {
  baseUrl: 'https://router.test/v1//',
  model: 'm',
  input: 'synthetic input',
}

describe('sendChatCompletion (legacy local / openrouter call, behaviour pinned)', () => {
  it('posts JSON to <base>/chat/completions with trailing slashes collapsed', async () => {
    const { fetchImpl, seen } = fake(200, ok())
    await sendChatCompletion({ ...base, fetchImpl })
    expect(seen[0]).toMatchObject({
      url: 'https://router.test/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('sends temperature 0.1 and the deny flag only when asked', async () => {
    const plain = fake(200, ok())
    await sendChatCompletion({ ...base, fetchImpl: plain.fetchImpl })
    expect(plain.seen[0]!.body).toStrictEqual({
      model: 'm',
      messages: [
        {
          role: 'system',
          content:
            'Extract the requested data from the user input. Respond with a single JSON object only, no prose.',
        },
        { role: 'user', content: 'synthetic input' },
      ],
      temperature: 0.1,
    })
    const deny = fake(200, ok())
    await sendChatCompletion({ ...base, denyDataCollection: true, fetchImpl: deny.fetchImpl })
    expect((deny.seen[0]!.body as Record<string, unknown>).provider).toStrictEqual({
      data_collection: 'deny',
    })
  })

  it('reaches loopback HTTP only with allowLoopbackHttp', async () => {
    const url = { ...base, baseUrl: 'http://localhost:11434/v1' }
    const allowed = fake(200, ok())
    expect(
      (await sendChatCompletion({ ...url, allowLoopbackHttp: true, fetchImpl: allowed.fetchImpl }))
        .ok,
    ).toBe(true)
    const refused = fake(200, ok())
    expect(await sendChatCompletion({ ...url, fetchImpl: refused.fetchImpl })).toStrictEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
    expect(refused.seen).toHaveLength(0)
  })

  it('reports MODEL_UNAVAILABLE only when asked to detect it', async () => {
    const gone = () => fake(404, 'No endpoints found for model m')
    expect(
      await sendChatCompletion({
        ...base,
        detectModelUnavailable: true,
        fetchImpl: gone().fetchImpl,
      }),
    ).toStrictEqual({ ok: false, code: 'MODEL_UNAVAILABLE' })
    expect(await sendChatCompletion({ ...base, fetchImpl: gone().fetchImpl })).toStrictEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
  })

  it.each([
    ['non-JSON', 'nope'],
    ['no choices', JSON.stringify({ choices: [] })],
  ])('a %s 2xx is PROVIDER_ERROR', async (_n, text) => {
    expect(
      await sendChatCompletion({ ...base, fetchImpl: fake(200, text).fetchImpl }),
    ).toStrictEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
  })

  it('returns the text, with totalTokens only when reported', async () => {
    expect(
      await sendChatCompletion({ ...base, fetchImpl: fake(200, ok()).fetchImpl }),
    ).toStrictEqual({ ok: true, text: '{}' })
    const counted = fake(200, ok({ usage: { total_tokens: 3 } }))
    expect(await sendChatCompletion({ ...base, fetchImpl: counted.fetchImpl })).toStrictEqual({
      ok: true,
      text: '{}',
      totalTokens: 3,
    })
  })

  it('maps 429 to RATE_LIMITED', async () => {
    expect(await sendChatCompletion({ ...base, fetchImpl: fake(429, '').fetchImpl })).toStrictEqual(
      {
        ok: false,
        code: 'RATE_LIMITED',
      },
    )
  })
})
