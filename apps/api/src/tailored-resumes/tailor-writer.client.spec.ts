import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_EXTRACTION_INPUT_CHARS as MAX_WORKER_INPUT_CHARS } from '@crm/inference'
import {
  tailorBodySchema,
  tailorWorkerInput,
  type TailorBody,
} from '../extraction-worker/link-contract'
import { writingPayloadFixture } from '../test/writing-payload-fixture'
import { TAILOR_PROVIDER, TailorWriterClient } from './tailor-writer.client'

const URL_ = 'http://crm-extraction-worker:3100'
const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'

const BODY: TailorBody = {
  payload: JSON.stringify(writingPayloadFixture()),
  posting: {
    title: 'Senior Backend Engineer',
    text: 'We build payments.',
    requirements: { existing: ['TypeScript'], supported: [] },
  },
  feedback: ['fix x'],
}
const REPLY = {
  summary: 'A summary.',
  skills: [{ index: 0, name: 'TypeScript' }],
  items: [{ bullets: [{ text: 'Built the API', sourceIndices: [0] }] }],
  coverLetter: 'I build backend services.',
}

type Call = { url: string; init: { headers?: Record<string, string>; body?: string } }

function stubFetch(reply: unknown, status = 200): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init: Call['init']) => {
    calls.push({ url, init })
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
    return Promise.resolve(new Response(text, { status }))
  })
  return calls
}

function workerEnv(): void {
  vi.stubEnv('EXTRACTION_WORKER_URL', URL_)
  vi.stubEnv('EXTRACTION_WORKER_SECRET', SECRET)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('TailorWriterClient', () => {
  it('names its provider for the run-failure origin', () => {
    expect(TAILOR_PROVIDER).toBe('extraction-worker:/resume-tailor')
  })

  it('an unset worker is unavailable, never a throw, and sends nothing', async () => {
    vi.stubEnv('EXTRACTION_WORKER_URL', '')
    vi.stubEnv('EXTRACTION_WORKER_SECRET', '')
    const calls = stubFetch({ kind: 'ok', ...REPLY })
    await expect(new TailorWriterClient().tailor(BODY)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
      transport: 'unset',
    })
    expect(calls).toHaveLength(0)
  })

  it('posts the body unchanged to /resume-tailor with the secret and returns the reply', async () => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', ...REPLY })
    await expect(new TailorWriterClient().tailor(BODY)).resolves.toEqual({ kind: 'ok', ...REPLY })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${URL_}/resume-tailor`)
    expect(calls[0]?.init.headers?.authorization).toBe(`Bearer ${SECRET}`)
    expect(calls[0]?.init.body).toBe(JSON.stringify(BODY))
  })

  it('a body the worker would refuse is INVALID_INPUT and never sent', async () => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', ...REPLY })
    const bad = { ...BODY, payload: JSON.stringify({ ...writingPayloadFixture(), email: 'a@b.c' }) }
    await expect(new TailorWriterClient().tailor(bad)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_INPUT',
    })
    expect(calls).toHaveLength(0)
  })

  it('a body whose worker input is over the cap is INVALID_INPUT and never sent', async () => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', ...REPLY })
    const fixture = writingPayloadFixture()
    const empty = { ...BODY, payload: JSON.stringify({ ...fixture, headline: '' }) }
    const at = (n: number): TailorBody => ({
      ...BODY,
      payload: JSON.stringify({
        ...fixture,
        headline: 'x'.repeat(n - tailorWorkerInput(empty).length),
      }),
    })
    const over = at(MAX_WORKER_INPUT_CHARS + 1)
    expect(tailorBodySchema.safeParse(over).success).toBe(true)
    await expect(new TailorWriterClient().tailor(over)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_INPUT',
    })
    expect(calls).toHaveLength(0)
    await expect(new TailorWriterClient().tailor(at(MAX_WORKER_INPUT_CHARS))).resolves.toEqual({
      kind: 'ok',
      ...REPLY,
    })
    expect(calls).toHaveLength(1)
  })

  it('passes the worker unavailable reply through', async () => {
    workerEnv()
    stubFetch({ kind: 'unavailable', reason: 'LIMITS_EXHAUSTED' })
    await expect(new TailorWriterClient().tailor(BODY)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'LIMITS_EXHAUSTED',
    })
  })

  it.each([
    ['a reply without coverLetter', { kind: 'ok', ...REPLY, coverLetter: undefined }],
    ['a reply with an extra key', { kind: 'ok', ...REPLY, extra: 'x' }],
    ['a reply with an invented kind', { kind: 'maybe', ...REPLY }],
    ['a non-JSON reply', 'not json'],
  ])('%s → unavailable INVALID_OUTPUT', async (_name, reply) => {
    workerEnv()
    stubFetch(reply)
    await expect(new TailorWriterClient().tailor(BODY)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_OUTPUT',
      transport: 'reply',
    })
  })

  it('a 400 from the worker is PROVIDER_ERROR with its status', async () => {
    workerEnv()
    stubFetch({ error: 'BAD_REQUEST' }, 400)
    await expect(new TailorWriterClient().tailor(BODY)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
      status: 400,
    })
  })
})
