import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyRolesBodySchema,
  classifyRolesInput,
  MAX_CLASSIFY_TITLE_CHARS,
} from '../../extraction-worker/link-contract'
import { MAX_WORKER_INPUT_CHARS } from '../../extraction-worker/schema'
import { WORKER_ADAPTER_TIMEOUT_MS } from '../structuring/model-extraction-wiring'
import { classifyRolesRequest, RoleClassifierClient } from './role-classifier.client'

const URL_ = 'http://crm-extraction-worker:3100'
const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const INPUT = { title: 'Wizard of Things', description: 'Builds things.', categories: ['misc'] }

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
  vi.useRealTimers()
})

describe('RoleClassifierClient', () => {
  it('env unset -> { reason: NOT_CONFIGURED, transport: unset }, no network call', async () => {
    vi.stubEnv('EXTRACTION_WORKER_URL', '')
    vi.stubEnv('EXTRACTION_WORKER_SECRET', '')
    const calls = stubFetch({ kind: 'ok', roles: [], confidence: 1 })
    await expect(new RoleClassifierClient().classify(INPUT)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
      transport: 'unset',
    })
    expect(calls).toHaveLength(0)
  })

  it('posts the vacancy to /classify-roles with the secret and returns enum roles', async () => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', roles: ['BACKEND_ENGINEER'], confidence: 0.75 })
    await expect(new RoleClassifierClient().classify(INPUT)).resolves.toEqual({
      kind: 'ok',
      roles: ['BACKEND_ENGINEER'],
      confidence: 0.75,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${URL_}/classify-roles`)
    expect(calls[0]?.init.headers?.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual(INPUT)
  })

  it('passes a worker-coded unavailable reason through', async () => {
    workerEnv()
    stubFetch({ kind: 'unavailable', reason: 'RATE_LIMITED' })
    await expect(new RoleClassifierClient().classify(INPUT)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'RATE_LIMITED',
    })
  })

  it('timeout -> TIMEOUT', async () => {
    workerEnv()
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { signal: AbortSignal }): Promise<never> =>
        new Promise((_res, rej) =>
          init.signal.addEventListener('abort', () => rej(new Error('x'))),
        ),
    )
    vi.useFakeTimers()
    const pending = new RoleClassifierClient().classify(INPUT)
    await vi.advanceTimersByTimeAsync(WORKER_ADAPTER_TIMEOUT_MS)
    await expect(pending).resolves.toEqual({
      kind: 'unavailable',
      reason: 'TIMEOUT',
      transport: 'timeout',
    })
  })

  it('non-2xx -> PROVIDER_ERROR with status', async () => {
    workerEnv()
    stubFetch({ error: 'BAD_REQUEST' }, 400)
    await expect(new RoleClassifierClient().classify(INPUT)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
      status: 400,
      transport: 'http',
    })
  })

  it('non-JSON -> INVALID_OUTPUT', async () => {
    workerEnv()
    stubFetch('not json')
    await expect(new RoleClassifierClient().classify(INPUT)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_OUTPUT',
      transport: 'reply',
    })
  })

  it.each([
    ['an unknown role id', { kind: 'ok', roles: ['WIZARD'], confidence: 0.9 }],
    ['5 roles', { kind: 'ok', roles: Array(5).fill('BACKEND_ENGINEER'), confidence: 0.9 }],
    ['a confidence over 1', { kind: 'ok', roles: ['BACKEND_ENGINEER'], confidence: 1.5 }],
    ['an extra key', { kind: 'ok', roles: [], confidence: 0.5, text: 'x' }],
  ])('a reply with %s -> INVALID_OUTPUT, never a partial list', async (_label, reply) => {
    workerEnv()
    stubFetch(reply)
    await expect(new RoleClassifierClient().classify(INPUT)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_OUTPUT',
      transport: 'reply',
    })
  })

  it('an empty title is INVALID_INPUT and sends nothing', async () => {
    workerEnv()
    const calls = stubFetch({ kind: 'ok', roles: [], confidence: 1 })
    await expect(new RoleClassifierClient().classify({ ...INPUT, title: '' })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INVALID_INPUT',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('classifyRolesRequest — the body always passes the worker schema', () => {
  it('cuts description to fit the cap', () => {
    const body = classifyRolesRequest({ ...INPUT, description: 'x'.repeat(MAX_WORKER_INPUT_CHARS) })
    if (body === null) throw new Error('expected a body')
    expect(classifyRolesInput(body)).toHaveLength(MAX_WORKER_INPUT_CHARS)
    expect(body.description).toMatch(/^x+$/)
    expect(classifyRolesBodySchema.safeParse(body).success).toBe(true)
  })

  it('cuts by the serialised length: escaped characters count as JSON writes them', () => {
    const body = classifyRolesRequest({ ...INPUT, description: '"'.repeat(MAX_WORKER_INPUT_CHARS) })
    if (body === null) throw new Error('expected a body')
    expect(classifyRolesInput(body).length).toBeLessThanOrEqual(MAX_WORKER_INPUT_CHARS)
    expect(classifyRolesInput(body).length).toBeGreaterThan(MAX_WORKER_INPUT_CHARS - 2)
  })

  it('a body that fits is sent whole', () => {
    expect(classifyRolesRequest(INPUT)).toEqual(INPUT)
  })

  it('clamps the title and the categories to the worker limits', () => {
    const body = classifyRolesRequest({
      title: 't'.repeat(MAX_CLASSIFY_TITLE_CHARS + 50),
      description: '',
      categories: Array.from({ length: 30 }, () => 'c'.repeat(150)),
    })
    if (body === null) throw new Error('expected a body')
    expect(body.title).toHaveLength(MAX_CLASSIFY_TITLE_CHARS)
    expect(body.categories).toHaveLength(20)
    expect(body.categories.every((c) => c.length === 100)).toBe(true)
    expect(classifyRolesBodySchema.safeParse(body).success).toBe(true)
  })

  it('strips contacts from every field before sending (no personal data)', () => {
    const body = classifyRolesRequest({
      title: 'Engineer, write to hr.person@example.com',
      description: 'Call +380 67 123 4567 or hr.person@example.com',
      categories: ['hr.person@example.com'],
    })
    expect(JSON.stringify(body)).not.toContain('hr.person@example.com')
    expect(JSON.stringify(body)).not.toContain('123 4567')
  })
})
