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
  buildBlockPicker,
  buildManualStructurer,
  buildModelExtraction,
  readExtractionWorkerEnv,
  type ModelExtractionWiring,
} from './model-extraction-wiring'
import { EXTRACTION_SYSTEM_PROMPT } from './prompt-envelope'
import { HTML_MODEL_CALLS_PER_CYCLE } from './model-budget.port'

const SECRET = 'SECRET-MARKER-0123456789abcdef-0123456789'
const URL_ = 'http://crm-extraction-worker:3100'
const ENV = {
  EXTRACTION_WORKER_URL: 'http://crm-extraction-worker:3100',
  EXTRACTION_WORKER_SECRET: SECRET,
  EXTRACTION_INPUT_CONTEXT_TOKENS: '8192',
  EXTRACTION_INPUT_MAX_ANSWER_TOKENS: '512',
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
  events: [{ type: 'CALL', code: 'PROVIDER_ERROR', latencyMs: 1 }],
  health: { modelListStale: false, failedJobs: [] },
}

const preflightReply = (readiness: string) => () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ readiness, events: [], health: { modelListStale: false, failedJobs: [] } }),
    ),
  )
const preflightOk = preflightReply('READY')

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

function fakeWorker(reply: object = REPLY, readiness = 'READY') {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = []
  const preflights: string[] = []
  const fetchImpl = vi.fn(
    (
      url: string,
      init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
    ) => {
      if (url.endsWith('/preflight')) {
        preflights.push(url)
        return preflightReply(readiness)()
      }
      calls.push({ url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? 'null') })
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
      { ...ENV, EXTRACTION_INPUT_CONTEXT_TOKENS: '1e4' },
      'EXTRACTION_INPUT_CONTEXT_TOKENS',
    ],
    [
      'a context window in hex',
      { ...ENV, EXTRACTION_INPUT_CONTEXT_TOKENS: '0x2000' },
      'EXTRACTION_INPUT_CONTEXT_TOKENS',
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
      { ...ENV, EXTRACTION_INPUT_CONTEXT_TOKENS: undefined },
      'EXTRACTION_INPUT_CONTEXT_TOKENS',
    ],
    [
      'a context window not a number',
      { ...ENV, EXTRACTION_INPUT_CONTEXT_TOKENS: '8k' },
      'EXTRACTION_INPUT_CONTEXT_TOKENS',
    ],
    [
      'no answer budget',
      { ...ENV, EXTRACTION_INPUT_MAX_ANSWER_TOKENS: '0' },
      'EXTRACTION_INPUT_MAX_ANSWER_TOKENS',
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

  it('the cycle call limit refuses the next reservation; a stale local-time limit changes nothing', async () => {
    const cycle = await ready(wired({ ...ENV, EXTRACTION_CYCLE_LOCAL_MS_LIMIT: '1' }).wiring)
    for (let i = 0; i < HTML_MODEL_CALLS_PER_CYCLE; i++)
      cycle.budget.commit(cycle.budget.reserve()!)
    expect(cycle.budget.reserve()).toBeNull()
  })

  it('a stale local-time limit sends every page: two pages, two calls', async () => {
    const w = wired({ ...ENV, EXTRACTION_CYCLE_LOCAL_MS_LIMIT: '1' })
    const cycle = await ready(w.wiring)
    await cycle.structurer.structure(request('Senior Go Engineer, Kyiv'))
    await cycle.structurer.structure(request('Middle QA Engineer, Lviv'))
    expect(w.calls).toHaveLength(2)
  })

  it('the input ceiling is the configured window under the system prompt', () => {
    const window = { contextTokens: 8192, maxAnswerTokens: 512 }
    const w = wired()
    expect(w.wiring.inputCeilingChars).toBe(
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

describe('the readiness preflight: one attempt, no backoff (H.3)', () => {
  const answering = (status: number) => () =>
    Promise.resolve(new Response('a body that stays out', { status }))

  function wired(fetchImpl: Parameters<typeof buildModelExtraction>[1]['fetchImpl']) {
    const errors: string[] = []
    const r = buildModelExtraction(ENV, {
      ...OPTS,
      log: { error: (l) => errors.push(l), warn: () => undefined },
      fetchImpl,
    })
    if (!r.ok || r.wiring === undefined) throw new Error('not wired')
    return { wiring: r.wiring, errors, fetchImpl }
  }

  it('a 401 is one attempt: unreachable, logged with its status and never its body', async () => {
    const fetchImpl = vi.fn(answering(401))
    const { wiring, errors } = wired(fetchImpl)
    expect((await wiring.prepareCycle(CYCLE)).kind).toBe('MODEL_UNREACHABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(errors).toEqual(['MODEL_PREFLIGHT_FAILED readiness=UNREACHABLE status=401'])
  })

  it('a timeout is one attempt with no status to log', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const { wiring, errors } = wired(fetchImpl)
    const cycle = wiring.prepareCycle(CYCLE)
    // The preflight bound is 10 s (CR-L-3): a 120 s advance would pass a regression to the old bound.
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await cycle).kind).toBe('MODEL_UNREACHABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(errors).toEqual(['MODEL_PREFLIGHT_FAILED readiness=UNREACHABLE status=none'])
  })

  it('NO_ROUTE is unreachable after one attempt', async () => {
    const fetchImpl = vi.fn(preflightReply('NO_ROUTE'))
    const { wiring, errors } = wired(fetchImpl)
    expect((await wiring.prepareCycle(CYCLE)).kind).toBe('MODEL_UNREACHABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(errors).toEqual(['MODEL_PREFLIGHT_FAILED readiness=NO_ROUTE'])
  })

  it("an H1 worker's { ok } reply is unreachable: version skew fails closed", async () => {
    const h1 = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            events: [],
            health: { modelListStale: false, failedJobs: [] },
          }),
        ),
      )
    const { wiring, errors } = wired(h1)
    expect((await wiring.prepareCycle(CYCLE)).kind).toBe('MODEL_UNREACHABLE')
    expect(errors).toEqual(['MODEL_PREFLIGHT_FAILED readiness=UNREACHABLE status=200'])
  })

  it('READY logs nothing and runs the model stage', async () => {
    const { wiring, errors } = wired(preflightOk)
    expect((await wiring.prepareCycle(CYCLE)).kind).toBe('READY')
    expect(errors).toEqual([])
  })

  it('LIMITS_EXHAUSTED skips the model stage with the H.2 stop and zero port calls', async () => {
    const w = fakeWorker(REPLY, 'LIMITS_EXHAUSTED')
    const r = buildModelExtraction(ENV, { ...OPTS, fetchImpl: w.fetchImpl })
    if (!r.ok || r.wiring === undefined) throw new Error('not wired')
    const cycle = await r.wiring.prepareCycle(CYCLE)
    if (cycle.kind !== 'LIMITS_EXHAUSTED') throw new Error(`expected the stop, got ${cycle.kind}`)
    for (let i = 0; i < 3; i++) {
      expect(await cycle.structurer.structure(request(`page ${i}`))).toEqual({
        kind: 'LIMITS_EXHAUSTED',
        perRecordIssues: [],
        remainingIds: ['r1'],
      })
    }
    expect(w.calls).toEqual([])
    expect(w.preflights).toHaveLength(1)
    expect(cycle.budget.snapshot()).toEqual({ committed: 0, reserved: 0, totalTokens: 0 })
  })
})

describe('the timeout and hold derive from the router call ceiling (AC3, ADR §5.5 item 4)', () => {
  it('ceiling = the 120 s hosted maximum (no local floor, 5.4c-H1); timeout adds a margin, the hold a grace', () => {
    expect(WORKER_STRUCTURER_TIMEOUT_MS).toBe(120_000 + 10_000)
    expect(WORKER_ADAPTER_TIMEOUT_MS).toBe(120_000 + 20_000)
    expect(WORKER_HOLD_MS).toBe(120_000 + 30_000)
  })

  it('the structurer gives up at its timeout, not before: the router answers first', async () => {
    const signals: AbortSignal[] = []
    const fetchImpl = (url: string, init?: { signal?: AbortSignal }) => {
      if (url.endsWith('/preflight')) return preflightOk()
      const signal = init!.signal!
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
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

describe('readExtractionWorkerEnv', () => {
  it('a valid worker with a bad input window names only the window key', () => {
    const r = buildModelExtraction({ ...ENV, EXTRACTION_INPUT_CONTEXT_TOKENS: '0' }, OPTS)
    expect(r).toEqual({ ok: false, keys: ['EXTRACTION_INPUT_CONTEXT_TOKENS'] })
  })

  it('reads the address and the secret, the trailing slash cut', () => {
    expect(
      readExtractionWorkerEnv({
        EXTRACTION_WORKER_URL: `${URL_}/`,
        EXTRACTION_WORKER_SECRET: SECRET,
      }),
    ).toEqual({ kind: 'ok', url: URL_, secret: SECRET })
  })

  it('neither key is unset, one bad key is invalid by name', () => {
    expect(readExtractionWorkerEnv({ EXTRACTION_WORKER_URL: '' })).toEqual({ kind: 'unset' })
    expect(readExtractionWorkerEnv({ EXTRACTION_WORKER_URL: URL_ })).toEqual({
      kind: 'invalid',
      keys: ['EXTRACTION_WORKER_SECRET'],
    })
  })
})

describe('buildManualStructurer — external vacancy intake (spec §D)', () => {
  const TIMEOUT = 30_000
  const WORKER_ONLY = {
    EXTRACTION_WORKER_URL: ENV.EXTRACTION_WORKER_URL,
    EXTRACTION_WORKER_SECRET: SECRET,
  }
  const twoRecords: HtmlStructurerRequest = {
    ...request('Senior Go Engineer'),
    records: [
      { id: 'r1', url: '', text: 'Senior Go Engineer' },
      { id: 'r2', url: '', text: 'Junior Go Engineer' },
    ],
  }

  it('no worker env, or an invalid one, is no structurer', () => {
    expect(buildManualStructurer({}, { timeoutMs: TIMEOUT })).toBeUndefined()
    expect(
      buildManualStructurer(
        { ...WORKER_ONLY, EXTRACTION_WORKER_URL: 'ftp://x' },
        { timeoutMs: TIMEOUT },
      ),
    ).toBeUndefined()
  })

  it('posts to the worker /extract with the bearer secret and the table version, no preflight', async () => {
    const w = fakeWorker()
    const build = buildManualStructurer(WORKER_ONLY, { timeoutMs: TIMEOUT, fetchImpl: w.fetchImpl })
    await build!().structure(request('Senior Go Engineer'))
    expect(w.preflights).toEqual([])
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]!.url).toBe('http://crm-extraction-worker:3100/extract')
    expect(w.calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect((w.calls[0]!.body as { tableVersion: unknown }).tableVersion).toBe(
      EXTRACTION_TABLE_VERSION,
    )
  })

  it('each structurer has its own one-call budget', async () => {
    const w = fakeWorker()
    const build = buildManualStructurer(WORKER_ONLY, {
      timeoutMs: TIMEOUT,
      fetchImpl: w.fetchImpl,
    })!
    await build().structure(twoRecords)
    expect(w.calls).toHaveLength(1)
    await build().structure(request('Senior Go Engineer'))
    expect(w.calls).toHaveLength(2)
  })

  it("a manual parse never spends a collection cycle's budget", async () => {
    const w = fakeWorker()
    const r = buildModelExtraction(ENV, { ...OPTS, fetchImpl: w.fetchImpl })
    if (!r.ok || r.wiring === undefined) throw new Error('not wired')
    const cycle = await ready(r.wiring)
    const build = buildManualStructurer(ENV, { timeoutMs: TIMEOUT, fetchImpl: w.fetchImpl })!
    for (let i = 0; i < 3; i++) await build().structure(request('Senior Go Engineer'))
    expect(w.calls).toHaveLength(3)
    for (let i = 0; i < HTML_MODEL_CALLS_PER_CYCLE; i++) {
      const slot = cycle.budget.reserve()
      expect(slot).not.toBeNull()
      cycle.budget.commit(slot!)
    }
    expect(cycle.budget.reserve()).toBeNull()
  })

  it('cuts the input to the hosted window when it is set, and not otherwise', async () => {
    const long = 'Go '.repeat(20_000)
    const cut = fakeWorker()
    await buildManualStructurer(ENV, { timeoutMs: TIMEOUT, fetchImpl: cut.fetchImpl })!().structure(
      request(long),
    )
    const ceiling = routerInputCeilingChars(
      { contextTokens: 8192, maxAnswerTokens: 512 },
      EXTRACTION_SYSTEM_PROMPT,
    )
    expect((cut.calls[0]!.body as { input: string }).input.length).toBeLessThanOrEqual(ceiling)
    const whole = fakeWorker()
    await buildManualStructurer(WORKER_ONLY, {
      timeoutMs: TIMEOUT,
      fetchImpl: whole.fetchImpl,
    })!().structure(request(long))
    expect((whole.calls[0]!.body as { input: string }).input.length).toBeGreaterThan(ceiling)
  })

  it('gives up at its own timeout, not before: the transport outlives it', async () => {
    const signals: AbortSignal[] = []
    const fetchImpl = (_url: string, init?: { signal?: AbortSignal }) => {
      const signal = init!.signal!
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const structurer = buildManualStructurer(WORKER_ONLY, { timeoutMs: TIMEOUT, fetchImpl })!()
    vi.useFakeTimers()
    let outcome: string | undefined
    void structurer.structure(request('Senior Go Engineer')).then((r) => {
      outcome = r.kind
    })
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBe('EXTRACTOR_FAILED')
  })
})

describe('buildBlockPicker — the bookmarklet block map (worker /pick-blocks)', () => {
  const TIMEOUT = 30_000
  const WORKER_ONLY = {
    EXTRACTION_WORKER_URL: ENV.EXTRACTION_WORKER_URL,
    EXTRACTION_WORKER_SECRET: SECRET,
  }
  const BODY = {
    url: 'https://jobs.example.com/vacancy/1',
    tabTitle: 'Go Engineer',
    blocks: [
      { t: 'Go Engineer', k: 'h1', fs: 32, fw: 700, x: 0, y: 0, w: 800, r: 'main' as const },
    ],
  }
  const PICK = { title: 0, company: null, description: [{ from: 0, to: 0 }] }
  const envelope = (result: object) => ({
    result,
    events: [],
    health: { modelListStale: false, failedJobs: [] },
  })
  const answering = (status: number, text: string) =>
    vi.fn(() => Promise.resolve(new Response(text, { status })))

  it('no worker env, or an invalid one, is no picker', () => {
    expect(buildBlockPicker({}, { timeoutMs: TIMEOUT })).toBeUndefined()
    expect(
      buildBlockPicker(
        { ...WORKER_ONLY, EXTRACTION_WORKER_URL: 'ftp://x' },
        { timeoutMs: TIMEOUT },
      ),
    ).toBeUndefined()
  })

  it('posts the body and the table version to /pick-blocks with the secret, no preflight', async () => {
    const w = fakeWorker(envelope({ ok: true, data: PICK }))
    const pick = buildBlockPicker(WORKER_ONLY, { timeoutMs: TIMEOUT, fetchImpl: w.fetchImpl })!
    expect(await pick(BODY)).toEqual({ ok: true, reply: PICK })
    expect(w.preflights).toEqual([])
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]!.url).toBe(`${URL_}/pick-blocks`)
    expect(w.calls[0]!.headers['authorization']).toBe(`Bearer ${SECRET}`)
    expect(w.calls[0]!.body).toEqual({ ...BODY, tableVersion: EXTRACTION_TABLE_VERSION })
  })

  it('the worker failure code is the reason', async () => {
    const w = fakeWorker(envelope({ ok: false, code: 'TIMEOUT' }))
    const pick = buildBlockPicker(WORKER_ONLY, { timeoutMs: TIMEOUT, fetchImpl: w.fetchImpl })!
    expect(await pick(BODY)).toEqual({ ok: false, reason: 'TIMEOUT' })
  })

  it.each([
    ['a non-JSON body', 'not json'],
    ['a word for an id', JSON.stringify(envelope({ ok: true, data: { ...PICK, title: 'first' } }))],
    ['no result', JSON.stringify({ events: [] })],
    ['an unknown failure code', JSON.stringify(envelope({ ok: false, code: 'SOMETHING' }))],
  ])('%s is INVALID_REPLY', async (_, text) => {
    const pick = buildBlockPicker(WORKER_ONLY, {
      timeoutMs: TIMEOUT,
      fetchImpl: answering(200, text),
    })!
    expect(await pick(BODY)).toEqual({ ok: false, reason: 'INVALID_REPLY' })
  })

  it('a non-2xx answer is the transport kind, never its body', async () => {
    const pick = buildBlockPicker(WORKER_ONLY, {
      timeoutMs: TIMEOUT,
      fetchImpl: answering(400, JSON.stringify(envelope({ ok: true, data: PICK }))),
    })!
    expect(await pick(BODY)).toEqual({ ok: false, reason: 'transport' })
  })

  it('the call ends at the caller timeout, as `timeout`', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
    const pick = buildBlockPicker(WORKER_ONLY, { timeoutMs: TIMEOUT, fetchImpl })!
    let outcome: unknown
    void pick(BODY).then((o) => (outcome = o))
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toEqual({ ok: false, reason: 'timeout' })
  })
})
