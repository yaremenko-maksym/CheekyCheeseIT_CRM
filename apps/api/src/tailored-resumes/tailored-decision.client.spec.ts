import type { ConfigService } from '@nestjs/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../config/env'
import { TailoredDecisionClient } from './tailored-decision.client'

type Call = { url: string; init: { headers?: Record<string, string>; body?: string } }

function stubFetch(reply: unknown): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init: Call['init']) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }))
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const config = (key: string | undefined) =>
  ({ get: (k: string) => (k === 'JEV_API_KEY' ? key : 'wrong-key') }) as unknown as ConfigService<
    Env,
    true
  >

const question = { id: 'q0', kind: 'noul' as const, instructions: 'Is it?' }

describe('TailoredDecisionClient', () => {
  it('a missing JEV_API_KEY is unavailable NOT_CONFIGURED and sends nothing', async () => {
    const calls = stubFetch({})
    await expect(
      new TailoredDecisionClient(config(undefined)).decide({}, [question]),
    ).resolves.toEqual({ kind: 'unavailable', cause: 'NOT_CONFIGURED' })
    expect(calls).toHaveLength(0)
  })

  it('with a key it asks Jev once per chunk and returns the answers by id', async () => {
    const calls = stubFetch({ answers: { q0: { type: 'noul', noul: 0.75 } } })
    const r = await new TailoredDecisionClient(config('jev-key')).decide({ s: 1 }, [question])
    expect(r instanceof Map && r.get('q0')).toEqual({
      id: 'q0',
      kind: 'noul',
      value: true,
      probability: 0.75,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.headers?.Authorization).toBe('Bearer jev-key')
  })
})
