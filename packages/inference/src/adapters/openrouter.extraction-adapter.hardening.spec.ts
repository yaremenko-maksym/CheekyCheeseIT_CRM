import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { FetchLike } from '../http/bounded-request'
import { createOpenRouterExtractionAdapter } from './openrouter.extraction-adapter'

const schema = z.object({ title: z.string() })

type Reply = { status: number; body: string }
const okReply = (content: string, tokens = 5): Reply => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: tokens } }),
})
const goneReply: Reply = {
  status: 404,
  body: '{"error":{"message":"No endpoints found for model dead/model"}}',
}

function fakeFetch(replies: Reply[]) {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  let i = 0
  const impl: FetchLike = async (url, init) => {
    requests.push({ url, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> })
    const reply = replies[Math.min(i++, replies.length - 1)]!
    return { status: reply.status, body: null, text: async () => reply.body }
  }
  return { impl, requests }
}

const mk = (
  over: Partial<Parameters<typeof createOpenRouterExtractionAdapter>[0]>,
  impl: FetchLike,
) =>
  createOpenRouterExtractionAdapter({
    apiKey: 'k',
    resolveModelId: () => 'a/model',
    fetchImpl: impl,
    ...over,
  })

describe('createOpenRouterExtractionAdapter hardening', () => {
  it('CR-M-6: resolveModelId throwing -> PROVIDER_ERROR', async () => {
    const { impl } = fakeFetch([okReply('{"title":"x"}')])
    const adapter = mk(
      {
        resolveModelId: () => {
          throw new Error('boom')
        },
      },
      impl,
    )
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
  })

  it('CR-M-6: onModelUnavailable rejecting -> PROVIDER_ERROR', async () => {
    const { impl } = fakeFetch([goneReply])
    const adapter = mk(
      {
        onModelUnavailable: async () => {
          throw new Error('boom')
        },
      },
      impl,
    )
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
  })

  it('CR-M-7: sums total_tokens across the corrective retry', async () => {
    const { impl } = fakeFetch([okReply('{"nope":1}', 5), okReply('{"title":"x"}', 7)])
    const res = await mk({}, impl).extract({ input: 'x', schema })
    expect(res).toEqual({ ok: true, data: { title: 'x' }, usage: { totalTokens: 12 } })
  })

  it('CR-M-7: sums across a model swap too', async () => {
    const { impl } = fakeFetch([okReply('{"nope":1}', 3), goneReply, okReply('{"title":"x"}', 4)])
    const adapter = mk({ onModelUnavailable: async () => 'b/model' }, impl)
    const res = await adapter.extract({ input: 'x', schema })
    expect(res).toEqual({ ok: true, data: { title: 'x' }, usage: { totalTokens: 7 } })
  })

  it('SR-M-5: sends provider.data_collection = deny', async () => {
    const { impl, requests } = fakeFetch([okReply('{"title":"x"}')])
    await mk({}, impl).extract({ input: 'x', schema })
    expect(requests[0]!.body.provider).toEqual({ data_collection: 'deny' })
  })

  it('LOW: does not retry when the refreshed model equals the dead one', async () => {
    const { impl, requests } = fakeFetch([goneReply])
    const adapter = mk({ onModelUnavailable: async () => 'a/model' }, impl)
    expect(await adapter.extract({ input: 'x', schema })).toEqual({
      ok: false,
      code: 'PROVIDER_ERROR',
    })
    expect(requests).toHaveLength(1)
  })

  it('LOW: caps instruction length', async () => {
    const { impl, requests } = fakeFetch([okReply('{"title":"x"}')])
    await mk({}, impl).extract({ input: 'x', schema, instruction: 'i'.repeat(100000) })
    const messages = requests[0]!.body.messages as { role: string; content: string }[]
    expect(messages.find((m) => m.role === 'system')!.content.length).toBeLessThanOrEqual(4000)
  })
})
