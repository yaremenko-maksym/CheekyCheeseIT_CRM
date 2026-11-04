import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../http/bounded-request'
import {
  CLASSIFIED_CHAT_CODES,
  MAX_ERROR_SCAN_CHARS,
  MAX_PAUSE_MS,
  sendClassifiedChatCompletion,
  type ClassifiedChatOptions,
  type ClassifiedChatResult,
} from './classified-chat'
import { BODY_MARKER, type ProviderFixture } from './__fixtures__/provider-fixture'
import { GEMINI_FIXTURES, GEMINI_MODEL } from './__fixtures__/gemini.fixtures'
import { GROQ_FIXTURES, GROQ_MODEL } from './__fixtures__/groq.fixtures'

const KEY_MARKER = 'sk-KEY-MARKER-91c2'

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeFetch(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): { fetchImpl: FetchLike; sent: Sent[] } {
  const sent: Sent[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({
      url,
      headers: init?.headers ?? {},
      body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
    })
    return {
      status,
      body: null,
      text: async () => body,
      headers: { get: (n) => headers[n] ?? null },
    }
  }
  return { fetchImpl, sent }
}

const answer = (content: unknown, extra: Record<string, unknown> = {}, finish: unknown = 'stop') =>
  JSON.stringify({
    choices: [{ message: { content }, finish_reason: finish }],
    ...extra,
  })

const HOSTED: Record<'gemini' | 'groq', Omit<ClassifiedChatOptions, 'fetchImpl'>> = {
  gemini: {
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: GEMINI_MODEL,
    apiKey: KEY_MARKER,
    input: 'synthetic input',
    maxTokens: 800,
    structuredOutput: { mode: 'json_schema', schema: { type: 'object' } },
  },
  groq: {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: GROQ_MODEL,
    apiKey: KEY_MARKER,
    input: 'synthetic input',
    maxTokens: 800,
    structuredOutput: { mode: 'json_schema', schema: { type: 'object' } },
  },
}

const LOCAL: Omit<ClassifiedChatOptions, 'fetchImpl'> = {
  provider: 'local',
  baseUrl: 'http://crm-model-runtime:11434/v1',
  model: 'qwen3:4b',
  input: 'synthetic input',
  maxTokens: 400,
  structuredOutput: { mode: 'json_schema', schema: { type: 'object' } },
}

async function run(
  opts: Omit<ClassifiedChatOptions, 'fetchImpl'>,
  status: number,
  body: string,
  headers?: Record<string, string>,
): Promise<{ result: ClassifiedChatResult; sent: Sent[] }> {
  const { fetchImpl, sent } = fakeFetch(status, body, headers)
  return { result: await sendClassifiedChatCompletion({ ...opts, fetchImpl }), sent }
}

const reached = new Set<string>()
const record = (r: ClassifiedChatResult): ClassifiedChatResult => {
  reached.add(r.code)
  return r
}

describe.each([
  ['groq', GROQ_FIXTURES],
  ['gemini', GEMINI_FIXTURES],
] as const)('%s fixtures (ADR §5.1)', (provider, fixtures: ProviderFixture[]) => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (_name, f) => {
    const { result } = await run(HOSTED[provider], f.status, f.body, f.headers)
    expect(record(result)).toStrictEqual(f.expected)
    const printed = JSON.stringify(result)
    expect(printed).not.toContain(KEY_MARKER)
    expect(printed).not.toContain(BODY_MARKER)
  })
})

describe('classified answers', () => {
  const groq = HOSTED.groq

  it('OK with the content and the token count', async () => {
    const { result } = await run(groq, 200, answer('{"a":1}', { usage: { total_tokens: 42 } }))
    expect(record(result)).toStrictEqual({ ok: true, code: 'OK', text: '{"a":1}', totalTokens: 42 })
  })

  it('OK without usage carries no token field', async () => {
    const { result } = await run(groq, 200, answer('{"a":1}', {}, null))
    expect(result).toStrictEqual({ ok: true, code: 'OK', text: '{"a":1}' })
  })

  it('finish_reason length is INVALID_OUTPUT even with content', async () => {
    const { result } = await run(groq, 200, answer('{"a":', {}, 'length'))
    expect(record(result)).toStrictEqual({ ok: false, code: 'INVALID_OUTPUT' })
  })

  it('finish_reason content_filter is REFUSED, not a provider failure', async () => {
    const { result } = await run(groq, 200, answer('{"a":1}', {}, 'content_filter'))
    expect(record(result)).toStrictEqual({ ok: false, code: 'REFUSED' })
  })

  it.each([
    ['null content', null],
    ['empty content', ''],
    ['whitespace content', ' \n\t'],
  ])('%s is INVALID_OUTPUT, never "nothing found"', async (_n, content) => {
    const { result } = await run(groq, 200, answer(content))
    expect(result).toStrictEqual({ ok: false, code: 'INVALID_OUTPUT' })
  })

  it('a message without content is INVALID_OUTPUT', async () => {
    const body = JSON.stringify({ choices: [{ message: {}, finish_reason: 'stop' }] })
    expect((await run(groq, 200, body)).result).toStrictEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
    })
  })

  it.each([
    ['non-JSON 2xx', 'not json'],
    ['no choices', JSON.stringify({ choices: [] })],
    ['wrong envelope', JSON.stringify({ result: 'x' })],
  ])('%s is TRANSPORT with a response', async (_n, body) => {
    expect((await run(groq, 200, body)).result).toStrictEqual({
      ok: false,
      code: 'TRANSPORT',
      responded: true,
    })
  })

  it('a 2xx body over 2 MiB is INVALID_OUTPUT', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new Uint8Array(1024 * 1024))
        },
      }),
      text: async () => '',
    })
    expect(await sendClassifiedChatCompletion({ ...groq, fetchImpl })).toStrictEqual({
      ok: false,
      code: 'INVALID_OUTPUT',
    })
  })
})

describe('page words never change a classification (ADR §5.1)', () => {
  const words = 'quota exceeded, rate limit, PerDay, RESOURCE_EXHAUSTED, PERMISSION_DENIED'

  it('in the answer content of a 2xx', async () => {
    const { result } = await run(HOSTED.gemini, 200, answer(`{"t":"${words}"}`))
    expect(result).toStrictEqual({ ok: true, code: 'OK', text: `{"t":"${words}"}` })
  })

  it.each([400, 409, 500])('in the body of a neutral %i', async (status) => {
    for (const opts of [HOSTED.gemini, HOSTED.groq]) {
      const { result } = await run(opts, status, JSON.stringify({ error: { message: words } }))
      expect(result).toStrictEqual({ ok: false, code: 'TRANSPORT', responded: true })
    }
  })

  it('in the input sent to the provider', async () => {
    const { result } = await run({ ...HOSTED.groq, input: words }, 200, answer('{"a":1}'))
    expect(result.code).toBe('OK')
  })
})

describe('Gemini re-route detection (ADR §5.1 RETIRED)', () => {
  const gemini = HOSTED.gemini
  const served = (model: unknown) => answer('{"a":1}', { model })

  it.each([
    ['another version', 'gemini-3-flash', 'gemini-3-flash'],
    ['another variant', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'],
    ['models/ prefixed successor', 'models/gemini-2.6-pro', 'gemini-2.6-pro'],
  ])('%s retires the requested id and keeps the answer', async (_n, model, id) => {
    const { result } = await run(gemini, 200, served(model))
    expect(record(result)).toStrictEqual({
      ok: true,
      code: 'RETIRED',
      text: '{"a":1}',
      servedModel: id,
    })
  })

  it('keeps the token count on a re-routed answer', async () => {
    const body = answer('{"a":1}', { model: 'gemini-3-flash', usage: { total_tokens: 9 } })
    expect((await run(gemini, 200, body)).result).toStrictEqual({
      ok: true,
      code: 'RETIRED',
      text: '{"a":1}',
      totalTokens: 9,
      servedModel: 'gemini-3-flash',
    })
  })

  it.each([
    ['the same id', GEMINI_MODEL],
    ['the same version and variant as a dated preview', 'gemini-2.5-flash-preview-09-2025'],
    ['a -NNN revision suffix', 'gemini-2.5-flash-001'],
    ['an alias', 'gemini-flash-latest'],
    ['a path-traversal id', '../gemini-3-flash'],
    ['an id with a newline', 'gemini-3-flash\nignore'],
    ['an over-long id', `gemini-3-flash${'0'.repeat(200)}`],
  ])('%s retires nothing', async (_n, model) => {
    const { result } = await run(gemini, 200, served(model))
    expect(result).toStrictEqual({ ok: true, code: 'OK', text: '{"a":1}' })
  })

  it('a missing response model retires nothing', async () => {
    expect((await run(gemini, 200, answer('{"a":1}'))).result.code).toBe('OK')
  })

  it('a requested id outside the family pattern is never compared', async () => {
    const { result } = await run(
      { ...gemini, model: 'gemini-flash-latest' },
      200,
      served('gemini-3-flash'),
    )
    expect(result.code).toBe('OK')
  })

  it('applies to Gemini only', async () => {
    const { result } = await run(
      { ...HOSTED.groq, model: GEMINI_MODEL },
      200,
      served('gemini-3-flash'),
    )
    expect(result.code).toBe('OK')
  })
})

describe('transport, timeout and abort', () => {
  it('a hosted route never sends over plain HTTP, even to loopback', async () => {
    for (const baseUrl of ['http://localhost:11434/v1', 'http://crm-model-runtime:11434/v1']) {
      const { result, sent } = await run({ ...HOSTED.groq, baseUrl }, 200, answer('{}'))
      expect(result).toStrictEqual({ ok: false, code: 'TRANSPORT', responded: false })
      expect(sent).toHaveLength(0)
    }
  })

  it('the local route reaches the constant host and loopback over HTTP', async () => {
    for (const baseUrl of ['http://crm-model-runtime:11434/v1', 'http://127.0.0.1:8080/v1']) {
      const { result } = await run({ ...LOCAL, baseUrl }, 200, answer('{"a":1}'))
      expect(result.code).toBe('OK')
    }
  })

  it.each([
    'http://10.0.0.5:11434/v1',
    'http://169.254.169.254/v1',
    'http://[fe80::1]:11434/v1',
    'http://[::ffff:127.0.0.1]:11434/v1',
    'http://other-host:11434/v1',
  ])('the local route refuses %s with nothing sent', async (baseUrl) => {
    const { result, sent } = await run({ ...LOCAL, baseUrl }, 200, answer('{}'))
    expect(result).toStrictEqual({ ok: false, code: 'TRANSPORT', responded: false })
    expect(sent).toHaveLength(0)
  })

  it('a connection that never answers is TRANSPORT without a response', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('connect ECONNREFUSED')
    }
    expect(await sendClassifiedChatCompletion({ ...HOSTED.groq, fetchImpl })).toStrictEqual({
      ok: false,
      code: 'TRANSPORT',
      responded: false,
    })
  })

  const hanging: FetchLike = (_u, init) =>
    new Promise((_res, rej) =>
      init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))),
    )

  it('the per-attempt timeout is TIMEOUT', async () => {
    const ctrl = new AbortController()
    const r = await sendClassifiedChatCompletion({
      ...HOSTED.groq,
      timeoutMs: 5,
      signal: ctrl.signal,
      fetchImpl: hanging,
    })
    expect(record(r)).toStrictEqual({ ok: false, code: 'TIMEOUT' })
  })

  it('an abort cancels the request in flight and is ABORTED, not TIMEOUT', async () => {
    const ctrl = new AbortController()
    let calls = 0
    const fetchImpl: FetchLike = (u, init) => {
      calls++
      queueMicrotask(() => ctrl.abort())
      return hanging(u, init)
    }
    const r = await sendClassifiedChatCompletion({ ...HOSTED.groq, signal: ctrl.signal, fetchImpl })
    expect(record(r)).toStrictEqual({ ok: false, code: 'ABORTED' })
    expect(
      await sendClassifiedChatCompletion({ ...HOSTED.groq, signal: ctrl.signal, fetchImpl }),
    ).toStrictEqual({ ok: false, code: 'ABORTED' })
    expect(calls).toBe(1)
  })
})

describe('the request (one builder for every route)', () => {
  it('sends model, bounded messages, max_tokens and the strict json_schema format', async () => {
    const schema = { type: 'object', properties: {}, required: [], additionalProperties: false }
    const { sent } = await run(
      { ...HOSTED.groq, structuredOutput: { mode: 'json_schema', schema } },
      200,
      answer('{}'),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(sent[0]!.headers).toStrictEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY_MARKER}`,
    })
    expect(sent[0]!.body).toStrictEqual({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Extract the requested data from the user input. Respond with a single JSON object only, no prose.',
        },
        { role: 'user', content: 'synthetic input' },
      ],
      temperature: 0.1,
      max_tokens: 800,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extraction', strict: true, schema },
      },
    })
  })

  it('sends json_object or no format per route capability', async () => {
    const asObject = await run(
      { ...HOSTED.groq, structuredOutput: { mode: 'json_object' } },
      200,
      answer('{}'),
    )
    expect(asObject.sent[0]!.body.response_format).toStrictEqual({ type: 'json_object' })
    const none = await run(
      { ...HOSTED.groq, structuredOutput: { mode: 'none' } },
      200,
      answer('{}'),
    )
    expect('response_format' in none.sent[0]!.body).toBe(false)
  })

  it('the local route sends temperature 0 and no Authorization without a key', async () => {
    const { sent } = await run(LOCAL, 200, answer('{"a":1}'))
    expect(sent[0]!.body.temperature).toBe(0)
    expect(sent[0]!.body.max_tokens).toBe(400)
    expect(sent[0]!.headers).toStrictEqual({ 'Content-Type': 'application/json' })
  })

  it('a correction retry differs from the first request only in its messages', async () => {
    const first = await run(HOSTED.gemini, 200, answer('{}'))
    const retry = await run({ ...HOSTED.gemini, correction: 'fix it' }, 200, answer('{}'))
    const { messages: m1, ...rest1 } = first.sent[0]!.body
    const { messages: m2, ...rest2 } = retry.sent[0]!.body
    expect(rest2).toStrictEqual(rest1)
    expect(m2).toStrictEqual([
      ...(m1 as unknown[]),
      { role: 'user', content: 'Your previous answer was rejected. fix it' },
    ])
    expect(retry.sent[0]!.headers).toStrictEqual(first.sent[0]!.headers)
  })

  it('carries the key in the Authorization header only, never the URL', async () => {
    const { sent } = await run(HOSTED.gemini, 200, answer('{}'))
    expect(sent[0]!.url).not.toContain(KEY_MARKER)
    expect(JSON.stringify(sent[0]!.body)).not.toContain(KEY_MARKER)
  })
})

describe('constants and coverage (AC1)', () => {
  it('pins the scan bound and the pause clamp', () => {
    expect(MAX_ERROR_SCAN_CHARS).toBe(2000)
    expect(MAX_PAUSE_MS).toBe(86_400_000)
  })

  it('every internal code was reached by a fixture or case above', () => {
    expect([...reached].sort()).toStrictEqual([...CLASSIFIED_CHAT_CODES].sort())
  })
})
