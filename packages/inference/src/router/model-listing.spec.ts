import { describe, expect, it } from 'vitest'
import { KEY_MARKER, scriptedFetch, type Reply } from './__test-helpers__/router-harness'
import {
  fetchModelListing,
  LISTING_MAX_ENTRIES,
  MODEL_LISTING_URLS,
  type ListedModel,
} from './model-listing'

const gemini = (models: unknown[]): Reply => ({ status: 200, body: JSON.stringify({ models }) })
const groq = (data: unknown[]): Reply => ({ status: 200, body: JSON.stringify({ data }) })
const geminiEntry = (id: string, inputTokenLimit: unknown = 1_000_000) => ({
  name: `models/${id}`,
  inputTokenLimit,
})
const groqEntry = (id: string, extra: object = {}) => ({
  id,
  context_window: 131_072,
  active: true,
  ...extra,
})

async function list(provider: 'gemini' | 'groq', reply: Reply) {
  const fake = scriptedFetch(() => reply)
  const result = await fetchModelListing({
    provider,
    apiKey: KEY_MARKER,
    timeoutMs: 5_000,
    fetchImpl: fake.fetchImpl,
  })
  return { result, sent: fake.sent }
}

async function okModels(provider: 'gemini' | 'groq', reply: Reply): Promise<ListedModel[]> {
  const { result } = await list(provider, reply)
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`)
  return result.models
}

describe('the request', () => {
  it('uses the fixed URL constants', () => {
    expect(MODEL_LISTING_URLS).toEqual({
      gemini: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      groq: 'https://api.groq.com/openai/v1/models',
    })
  })

  it('sends the Gemini key only in its header', async () => {
    const { sent } = await list('gemini', gemini([]))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(MODEL_LISTING_URLS.gemini)
    expect(sent[0]!.url).not.toContain(KEY_MARKER)
    expect(sent[0]!.headers).toEqual({ 'x-goog-api-key': KEY_MARKER })
    expect(sent[0]!.body).toEqual({})
  })

  it('sends the Groq key only in its header', async () => {
    const { sent } = await list('groq', groq([]))
    expect(sent[0]!.url).toBe(MODEL_LISTING_URLS.groq)
    expect(sent[0]!.url).not.toContain(KEY_MARKER)
    expect(sent[0]!.headers).toEqual({ Authorization: `Bearer ${KEY_MARKER}` })
    expect(sent[0]!.body).toEqual({})
  })

  it('refuses a redirect: the request says so and a thrown redirect is a plain failure', async () => {
    let redirect: unknown
    let method: unknown
    const result = await fetchModelListing({
      provider: 'groq',
      apiKey: KEY_MARKER,
      timeoutMs: 5_000,
      fetchImpl: async (_url, init) => {
        redirect = init?.redirect
        method = init?.method
        throw new TypeError('unexpected redirect')
      },
    })
    expect(method).toBe('GET')
    expect(redirect).toBe('error')
    expect(result).toEqual({ kind: 'failed', noResponse: true })
  })
})

describe('reading a listing', () => {
  it('strips the Gemini prefix and reads the context limit', async () => {
    expect(await okModels('gemini', gemini([geminiEntry('gemini-2.5-flash', 1_048_576)]))).toEqual([
      { id: 'gemini-2.5-flash', context: 1_048_576 },
    ])
  })

  it('reads the Groq id, context and active flag', async () => {
    expect(
      await okModels(
        'groq',
        groq([
          groqEntry('openai/gpt-oss-120b'),
          groqEntry('openai/gpt-oss-20b', { active: false }),
        ]),
      ),
    ).toEqual([
      { id: 'openai/gpt-oss-120b', context: 131_072, active: true },
      { id: 'openai/gpt-oss-20b', context: 131_072, active: false },
    ])
  })

  it.each([[0], [-1], [1.5], ['1000'], [null]])(
    'treats a provider context of %s as not reported, without losing the id',
    async (limit) => {
      expect(await okModels('gemini', gemini([geminiEntry('gemini-2.5-flash', limit)]))).toEqual([
        { id: 'gemini-2.5-flash', context: undefined },
      ])
      expect(
        await okModels('groq', groq([groqEntry('openai/gpt-oss-120b', { context_window: limit })])),
      ).toEqual([{ id: 'openai/gpt-oss-120b', context: undefined, active: true }])
    },
  )

  it('treats a non-boolean active as not reported', async () => {
    expect(
      await okModels('groq', groq([groqEntry('openai/gpt-oss-120b', { active: 'yes' })])),
    ).toEqual([{ id: 'openai/gpt-oss-120b', context: 131_072, active: undefined }])
  })
})

describe('hostile ids are dropped and counted (AC2)', () => {
  const HOSTILE = [
    '../../etc/passwd',
    'models/../secret',
    'https://evil.example/x',
    'gemini-2.5-flash\nX-Injected: 1',
    'gemini 2.5 flash',
    'gemini-2.5-flash\u0000',
    'gemini-2.5-фlash',
    '/gemini-2.5-flash',
    'gemini-2.5-flash:one:two',
    `gemini-2.5-${'a'.repeat(300)}`,
  ]

  it.each(HOSTILE)('drops the Gemini id %j', async (id) => {
    const { result } = await list('gemini', gemini([geminiEntry(id)]))
    expect(result).toEqual({ kind: 'ok', models: [], dropped: 1, beyondCap: 0 })
  })

  it.each(HOSTILE)('drops the Groq id %j', async (id) => {
    const { result } = await list('groq', groq([groqEntry(id)]))
    expect(result).toEqual({ kind: 'ok', models: [], dropped: 1, beyondCap: 0 })
  })

  it('drops a Gemini id outside the family', async () => {
    const { result } = await list('gemini', gemini([geminiEntry('imagen-4.0-generate')]))
    expect(result).toEqual({ kind: 'ok', models: [], dropped: 1, beyondCap: 0 })
  })

  it.each([[{}], [{ name: 7 }], ['a string'], [null]])(
    'drops a Gemini entry of the wrong shape %j',
    async (entry) => {
      const { result } = await list('gemini', gemini([entry]))
      expect(result).toEqual({ kind: 'ok', models: [], dropped: 1, beyondCap: 0 })
    },
  )

  it.each([[{}], [{ id: 7 }], ['a string'], [null]])(
    'drops a Groq entry of the wrong shape %j',
    async (entry) => {
      const { result } = await list('groq', groq([entry]))
      expect(result).toEqual({ kind: 'ok', models: [], dropped: 1, beyondCap: 0 })
    },
  )

  it('counts a repeated id, so it cannot waste a probe', async () => {
    const { result } = await list(
      'groq',
      groq([groqEntry('openai/gpt-oss-120b'), groqEntry('openai/gpt-oss-120b')]),
    )
    expect(result).toMatchObject({
      kind: 'ok',
      dropped: 1,
      models: [{ id: 'openai/gpt-oss-120b' }],
    })
  })

  it('keeps the good entries beside the hostile ones', async () => {
    const { result } = await list(
      'gemini',
      gemini([geminiEntry('../x'), geminiEntry('gemini-2.5-flash', 32_000)]),
    )
    expect(result).toEqual({
      kind: 'ok',
      models: [{ id: 'gemini-2.5-flash', context: 32_000 }],
      dropped: 1,
      beyondCap: 0,
    })
  })
})

describe('bounds', () => {
  it('reads exactly the entry cap and counts the rest', async () => {
    // Only two Groq ids are valid: fill with junk so the last slot inside the cap and the first
    // slot past it are the ones that decide.
    const many = Array.from({ length: LISTING_MAX_ENTRIES + 3 }, () => groqEntry('junk'))
    many[LISTING_MAX_ENTRIES - 1] = groqEntry('openai/gpt-oss-120b')
    many[LISTING_MAX_ENTRIES] = groqEntry('openai/gpt-oss-20b')
    const { result } = await list('groq', groq(many))
    expect(result).toEqual({
      kind: 'ok',
      models: [{ id: 'openai/gpt-oss-120b', context: 131_072, active: true }],
      dropped: LISTING_MAX_ENTRIES - 1,
      beyondCap: 3,
    })
  })

  it('counts nothing beyond the cap at exactly the cap', async () => {
    const many = Array.from({ length: LISTING_MAX_ENTRIES }, (_, i) =>
      groqEntry(`openai/gpt-oss-${i}`),
    )
    const { result } = await list('groq', groq(many))
    expect(result).toMatchObject({ kind: 'ok', beyondCap: 0 })
  })

  it('accepts a body just under the byte cap and fails one over it, unparsed', async () => {
    const pad = (bytes: number) => ' '.repeat(bytes)
    const under = await list('groq', { status: 200, body: `{"data":[]}${pad(512 * 1024 - 11)}` })
    expect(under.result.kind).toBe('ok')
    const over = await list('groq', { status: 200, body: `{"data":[]}${pad(512 * 1024 - 10)}` })
    expect(over.result).toEqual({ kind: 'failed', noResponse: false })
  })

  it('accepts an id at the length cap only to the validators, and drops one over it unread', async () => {
    const atCap = await list('groq', groq([groqEntry('a'.repeat(256))]))
    const overCap = await list('groq', groq([groqEntry('a'.repeat(257))]))
    expect(atCap.result).toMatchObject({ kind: 'ok', dropped: 1 })
    expect(overCap.result).toMatchObject({ kind: 'ok', dropped: 1 })
  })
})

describe('a failed listing', () => {
  it.each([[401], [403]])('reads %s as auth', async (status) => {
    const { result } = await list('groq', { status, body: 'no' })
    expect(result).toEqual({ kind: 'auth' })
  })

  it.each([[500], [503], [404], [400]])(
    'reads %s as failed with a response (commits the unit)',
    async (status) => {
      const { result } = await list('gemini', { status, body: 'no' })
      expect(result).toEqual({ kind: 'failed', noResponse: false })
    },
  )

  it('reads a 429 as failed with a response', async () => {
    const { result } = await list('groq', { status: 429, body: 'no' })
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })

  it('reads a connection never made as failed with no response (releases the unit)', async () => {
    const { result } = await list('groq', 'network')
    expect(result).toEqual({ kind: 'failed', noResponse: true })
  })

  it('reads a timeout as failed with a response: the unit is committed', async () => {
    const fake = scriptedFetch(() => 'hang')
    const result = await fetchModelListing({
      provider: 'groq',
      apiKey: KEY_MARKER,
      timeoutMs: 1,
      fetchImpl: fake.fetchImpl,
    })
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })

  it.each([
    ['not JSON', 'nope'],
    ['the wrong envelope', '{"models":[]}'],
    ['a non-array', '{"data":{}}'],
    ['JSON null', 'null'],
  ])('reads a Groq body of %s as failed', async (_label, body) => {
    const { result } = await list('groq', { status: 200, body })
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })

  it.each([
    ['the wrong envelope', '{"data":[]}'],
    ['a non-array', '{"models":{}}'],
  ])('reads a Gemini body of %s as failed', async (_label, body) => {
    const { result } = await list('gemini', { status: 200, body })
    expect(result).toEqual({ kind: 'failed', noResponse: false })
  })
})
