import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { FetchLike } from '../http/bounded-request'
import { createLocalExtractionAdapter } from './local.extraction-adapter'

const schema = z.object({ title: z.string() })

function fakeFetch() {
  let calls = 0
  const impl: FetchLike = async () => {
    calls++
    return {
      status: 200,
      body: null,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"title":"x"}' } }] }),
    }
  }
  return { impl, calls: () => calls }
}

describe('createLocalExtractionAdapter loopback requirement', () => {
  it.each(['http://api.example.com/v1', 'https://api.example.com/v1', 'not a url'])(
    'rejects non-loopback base %s without calling fetch',
    async (baseUrl) => {
      const { impl, calls } = fakeFetch()
      const adapter = createLocalExtractionAdapter({ baseUrl, model: 'm', fetchImpl: impl })
      expect(await adapter.extract({ input: 'x', schema })).toEqual({
        ok: false,
        code: 'PROVIDER_ERROR',
      })
      expect(calls()).toBe(0)
    },
  )

  it.each(['http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1', 'http://localhost/v1'])(
    'accepts loopback base %s',
    async (baseUrl) => {
      const { impl } = fakeFetch()
      const adapter = createLocalExtractionAdapter({ baseUrl, model: 'm', fetchImpl: impl })
      expect((await adapter.extract({ input: 'x', schema })).ok).toBe(true)
    },
  )
})
