import { routerInputCeilingChars } from '@crm/inference'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTRACTION_TABLE_VERSION } from '../../extraction-worker/link-contract'
import type { HtmlStructurerRequest } from './html-structurer.port'
import { ModelStructurer } from './model-structurer'
import {
  MODEL_EXTRACTION_ENV_KEYS,
  WORKER_ADAPTER_TIMEOUT_MS,
  WORKER_HOLD_MS,
  WORKER_STRUCTURER_TIMEOUT_MS,
  buildModelExtraction,
  type ModelExtractionWiring,
} from './model-extraction-wiring'
import { EXTRACTION_SYSTEM_PROMPT } from './prompt-envelope'
import { smallDoseFor } from './small-dose-table'

const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const ENV = {
  EXTRACTION_WORKER_URL: 'http://crm-extraction-worker:3100',
  EXTRACTION_WORKER_SECRET: SECRET,
  EXTRACTION_LOCAL_CONTEXT_TOKENS: '8192',
  EXTRACTION_LOCAL_MAX_ANSWER_TOKENS: '512',
}

/** Records every key read, so a test proves which env the collection side touches. */
function recording(env: Record<string, string | undefined>) {
  const read = new Set<string>()
  const proxy = new Proxy(env, {
    get(target, key) {
      if (typeof key === 'string') read.add(key)
      return target[key as string]
    },
  })
  return { proxy, read }
}

const request = (text: string): HtmlStructurerRequest => ({
  aiInput: 'yes',
  policy: { onUnspecified: 'block' },
  records: [{ id: 'r1', url: 'https://jobs.example.com/vacancy/r1', text }],
  extractionVersion: 'html-v1',
})

const REPLY = {
  result: { ok: false, code: 'PROVIDER_ERROR' },
  events: [{ type: 'FELL_TO_LOCAL' }],
  health: { modelListStale: false, failedJobs: [] },
}

const PREFLIGHT_OK = {
  ok: true,
  events: [],
  health: { modelListStale: false, failedJobs: [] },
}
const preflightOk = () => Promise.resolve(new Response(JSON.stringify(PREFLIGHT_OK)))

/** The handler has its own spec; here it only has to be present and quiet. */
const OPTS = {
  store: {
    addRouteCounts: () => Promise.resolve(),
    raiseFlag: () => Promise.resolve(),
    clearFlag: () => Promise.resolve(),
    claimEmissions: () => Promise.resolve([]),
  },
  log: { error: () => undefined, warn: () => undefined },
}

const CYCLE = 'cycle-1'

async function ready(wiring: ModelExtractionWiring) {
  const cycle = await wiring.prepareCycle(CYCLE)
  if (cycle.kind !== 'READY') throw new Error('the fake worker is reachable')
  return cycle
}

function fakeWorker(reply: object = REPLY) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = []
  const preflights: string[] = []
  const fetchImpl = vi.fn(
    (
      url: string,
      init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
    ) => {
      if (url.endsWith('/preflight')) {
        preflights.push(url)
        return preflightOk()
      }
      calls.push({ url, headers: init.headers ?? {}, body: JSON.parse(init.body ?? 'null') })
      return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }))
    },
  )
  return { calls, preflights, fetchImpl }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('buildModelExtraction — unset means no model (AC2)', () => {
  it('no worker URL and no secret: no wiring, and only its own keys are read', () => {
    const { proxy, read } = recording({
      GEMINI_API_KEY: 'G',
      GROQ_API_KEY: 'Q',
      ROUTER_LOCAL_MODEL_URL: 'http://crm-model-runtime:11434',
      LOCAL_MODEL_KEY: 'L',
    })
    expect(buildModelExtraction(proxy, OPTS)).toEqual({
      ok: true,
      wiring: undefined,
    })
    expect(
      [...read].every((k) => (MODEL_EXTRACTION_ENV_KEYS as readonly string[]).includes(k)),
    ).toBe(true)
  })

  it('a full config reads its own keys only, never a hosted key or the router URL (AC1)', () => {
    const { proxy, read } = recording({ ...ENV, GEMINI_API_KEY: 'G', GROQ_API_KEY: 'Q' })
    expect(buildModelExtraction(proxy, OPTS).ok).toBe(true)
    expect([...read].sort()).toEqual([...MODEL_EXTRACTION_ENV_KEYS].sort())
  })
})

describe('buildModelExtraction — an empty value is an unset value (AC10)', () => {
  it.each([
    ['both empty', { EXTRACTION_WORKER_URL: '', EXTRACTION_WORKER_SECRET: '' }],
    ['the URL empty, the secret unset', { EXTRACTION_WORKER_URL: '' }],
    ['the secret empty, the URL unset', { EXTRACTION_WORKER_SECRET: '' }],
  ])('%s: no model', (_name, env) => {
    expect(buildModelExtraction(env, OPTS)).toEqual({ ok: true, wiring: undefined })
  })

  it.each([
    [
      'the URL set, the secret empty',
      { ...ENV, EXTRACTION_WORKER_SECRET: '' },
      'EXTRACTION_WORKER_SECRET',
    ],
    [
      'the secret set, the URL empty',
      { ...ENV, EXTRACTION_WORKER_URL: '' },
      'EXTRACTION_WORKER_URL',
    ],
  ])('%s: a refusal naming the empty key', (_name, env, key) => {
    const r = buildModelExtraction(env, OPTS)
    expect(r).toEqual({ ok: false, keys: [key] })
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
})

describe('buildModelExtraction — a trailing slash in the worker URL (AC11)', () => {
  it.each([
    ['one slash', 'http://crm-extraction-worker:3100/'],
    ['two slashes', 'http://crm-extraction-worker:3100//'],
  ])('%s: the requests go to /preflight and /extract', async (_name, url) => {
    const w = fakeWorker()
    const r = buildModelExtraction(
      { ...ENV, EXTRACTION_WORKER_URL: url },
      { ...OPTS, fetchImpl: w.fetchImpl },
    )
    if (!r.ok || r.wiring === undefined) throw new Error('not wired')
    const cycle = await ready(r.wiring)
    await cycle.structurer.structure(request('Senior Go Engineer, Kyiv'))
    expect(w.preflights).toEqual(['http://crm-extraction-worker:3100/preflight'])
    expect(w.calls.map((c) => c.url)).toEqual(['http://crm-extraction-worker:3100/extract'])
  })
})

describe('buildModelExtraction — a partial or bad config is refused by key, never by value', () => {
  it.each([
    [
      'the URL alone',
      { EXTRACTION_WORKER_URL: ENV.EXTRACTION_WORKER_URL },
      'EXTRACTION_WORKER_SECRET',
    ],
    ['the secret alone', { EXTRACTION_WORKER_SECRET: SECRET }, 'EXTRACTION_WORKER_URL'],
    [
      'a non-http URL',
      { ...ENV, EXTRACTION_WORKER_URL: 'ftp://crm-extraction-worker' },
      'EXTRACTION_WORKER_URL',
    ],
    [
      'a scheme ending in http',
      { ...ENV, EXTRACTION_WORKER_URL: 'xhttp://crm-extraction-worker' },
      'EXTRACTION_WORKER_URL',
    ],
    [
      'a scheme starting with http',
      { ...ENV, EXTRACTION_WORKER_URL: 'httpx://crm-extraction-worker' },
      'EXTRACTION_WORKER_URL',
    ],
    [
      'credentials in the URL',
      { ...ENV, EXTRACTION_WORKER_URL: 'http://u:p@crm-extraction-worker' },
      'EXTRACTION_WORKER_URL',
    ],
    [
      'a user in the URL',
      { ...ENV, EXTRACTION_WORKER_URL: 'http://u@crm-extraction-worker' },
      'EXTRACTION_WORKER_URL',
    ],
    [
      'a password in the URL',
      { ...ENV, EXTRACTION_WORKER_URL: 'http://:p@crm-extraction-worker' },
      'EXTRACTION_WORKER_URL',
    ],
    [
      'a context window in exponent form',
      { ...ENV, EXTRACTION_LOCAL_CONTEXT_TOKENS: '1e4' },
      'EXTRACTION_LOCAL_CONTEXT_TOKENS',
    ],
    [
      'a context window in hex',
      { ...ENV, EXTRACTION_LOCAL_CONTEXT_TOKENS: '0x2000' },
      'EXTRACTION_LOCAL_CONTEXT_TOKENS',
    ],
    [
      'a short secret',
      { ...ENV, EXTRACTION_WORKER_SECRET: 'abcdefgh' },
      'EXTRACTION_WORKER_SECRET',
    ],
    [
      'a one-letter secret',
      { ...ENV, EXTRACTION_WORKER_SECRET: 's'.repeat(64) },
      'EXTRACTION_WORKER_SECRET',
    ],
    [
      'no context window',
      { ...ENV, EXTRACTION_LOCAL_CONTEXT_TOKENS: undefined },
      'EXTRACTION_LOCAL_CONTEXT_TOKENS',
    ],
    [
      'a context window not a number',
      { ...ENV, EXTRACTION_LOCAL_CONTEXT_TOKENS: '8k' },
      'EXTRACTION_LOCAL_CONTEXT_TOKENS',
    ],
    [
      'no answer budget',
      { ...ENV, EXTRACTION_LOCAL_MAX_ANSWER_TOKENS: '0' },
      'EXTRACTION_LOCAL_MAX_ANSWER_TOKENS',
    ],
    [
      'a negative local limit',
      { ...ENV, EXTRACTION_CYCLE_LOCAL_MS_LIMIT: '-1' },
      'EXTRACTION_CYCLE_LOCAL_MS_LIMIT',
    ],
  ])('%s', (_name, env, key) => {
    const r = buildModelExtraction(env, OPTS)
    expect(r).toEqual({ ok: false, keys: expect.arrayContaining([key]) as unknown })
    for (const value of ['abcdefgh', 'u:p', 'ftp:', '8k', SECRET]) {
      expect(JSON.stringify(r)).not.toContain(value)
    }
  })
})

describe('buildModelExtraction — the collection side talks to the worker only (AC2, AC5)', () => {
  const wired = (env: Record<string, string | undefined> = ENV, reply?: object) => {
    const worker = fakeWorker(reply)
    const r = buildModelExtraction(env, { ...OPTS, fetchImpl: worker.fetchImpl })
    if (!r.ok || r.wiring === undefined) throw new Error('not wired')
    return { wiring: r.wiring, ...worker }
  }

  it('each cycle gets a ModelStructurer over the worker adapter: input and version, bearer secret', async () => {
    const w = wired()
    const cycle = await ready(w.wiring)
    expect(cycle.structurer).toBeInstanceOf(ModelStructurer)
    await cycle.structurer.structure(request('Senior Go Engineer, Kyiv'))
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]!.url).toBe('http://crm-extraction-worker:3100/extract')
    expect(w.calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`)
    const body = w.calls[0]!.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['input', 'tableVersion'])
    expect(body.tableVersion).toBe(EXTRACTION_TABLE_VERSION)
  })

  it('a fresh budget per cycle: the call limit of one cycle does not carry over', async () => {
    const w = wired()
    const first = await ready(w.wiring)
    expect(first.budget).not.toBe((await ready(w.wiring)).budget)
  })

  it('the local-time limit refuses the next reservation once spent; unset is unlimited', async () => {
    const limited = await ready(wired({ ...ENV, EXTRACTION_CYCLE_LOCAL_MS_LIMIT: '1000' }).wiring)
    const r1 = limited.budget.reserve()!
    limited.budget.commit(r1, { localMs: 1000 })
    expect(limited.budget.reserve()).toBeNull()

    const open = await ready(wired().wiring)
    const r2 = open.budget.reserve()!
    open.budget.commit(r2, { localMs: 10_000_000 })
    expect(open.budget.reserve()).not.toBeNull()
  })

  it('the worker-reported local time reaches the limit: the next page sends no call (SPEC-M-1)', async () => {
    const spent = {
      ...REPLY,
      result: { ok: false, code: 'PROVIDER_ERROR', usage: { localMs: 1000 } },
    }
    const limited = wired({ ...ENV, EXTRACTION_CYCLE_LOCAL_MS_LIMIT: '1000' }, spent)
    const cycle = await ready(limited.wiring)
    await cycle.structurer.structure(request('Senior Go Engineer, Kyiv'))
    await cycle.structurer.structure(request('Middle QA Engineer, Lviv'))
    expect(limited.calls).toHaveLength(1)

    const open = wired(ENV, spent)
    const openCycle = await ready(open.wiring)
    await openCycle.structurer.structure(request('Senior Go Engineer, Kyiv'))
    await openCycle.structurer.structure(request('Middle QA Engineer, Lviv'))
    expect(open.calls).toHaveLength(2)
  })

  it('the input ceiling is the configured window with the small-dose table (third argument)', () => {
    const window = { contextTokens: 8192, maxAnswerTokens: 512 }
    const groups = smallDoseFor().groups
    const w = wired()
    expect(w.wiring.inputCeilingChars).toBe(
      routerInputCeilingChars(window, EXTRACTION_SYSTEM_PROMPT, groups),
    )
    expect(w.wiring.inputCeilingChars).toBeLessThan(
      routerInputCeilingChars(window, EXTRACTION_SYSTEM_PROMPT),
    )
  })

  it('the page is cut to that ceiling before it is sent', async () => {
    const w = wired()
    const cycle = await ready(w.wiring)
    await cycle.structurer.structure(request('a'.repeat(200_000)))
    const sent = (w.calls[0]!.body as { input: string }).input
    expect(sent.length).toBeLessThanOrEqual(w.wiring.inputCeilingChars)
    expect(sent.length).toBeGreaterThan(w.wiring.inputCeilingChars / 2)
  })
})

describe('the timeout and hold derive from the router call ceiling (AC3, ADR §5.5 item 4)', () => {
  it('ceiling = 120 s hosted + 6 × 300 s floor maxima; timeout adds a margin, the hold a grace', () => {
    expect(WORKER_STRUCTURER_TIMEOUT_MS).toBe(1_920_000 + 10_000)
    expect(WORKER_ADAPTER_TIMEOUT_MS).toBe(1_920_000 + 20_000)
    expect(WORKER_HOLD_MS).toBe(1_920_000 + 30_000)
  })

  it('the structurer gives up at its timeout, not before: the router answers first', async () => {
    const signals: AbortSignal[] = []
    const fetchImpl = (url: string, init: { signal?: AbortSignal }) => {
      if (url.endsWith('/preflight')) return preflightOk()
      signals.push(init.signal!)
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const r = buildModelExtraction(ENV, { ...OPTS, fetchImpl })
    if (!r.ok || r.wiring === undefined) throw new Error('not wired')
    const { structurer } = await ready(r.wiring)
    vi.useFakeTimers()
    let settled = false
    void structurer.structure(request('Senior Go Engineer')).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(WORKER_STRUCTURER_TIMEOUT_MS - 1)
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  })

  it('an abandoned call that never settles holds the route until the hold ends', async () => {
    let fetches = 0
    const fetchImpl = (url: string) => {
      if (url.endsWith('/preflight')) return preflightOk()
      fetches += 1
      return new Promise<Response>(() => undefined)
    }
    const r = buildModelExtraction(ENV, { ...OPTS, fetchImpl })
    if (!r.ok || r.wiring === undefined) throw new Error('not wired')
    const { structurer } = await ready(r.wiring)
    vi.useFakeTimers()
    void structurer.structure(request('first'))
    await vi.advanceTimersByTimeAsync(0)
    void structurer.structure(request('second'))
    await vi.advanceTimersByTimeAsync(WORKER_HOLD_MS - 1)
    expect(fetches).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetches).toBe(2)
  })
})
