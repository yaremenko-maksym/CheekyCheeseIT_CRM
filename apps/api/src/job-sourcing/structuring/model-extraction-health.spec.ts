import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HtmlStructurerRequest } from './html-structurer.port'
import {
  createModelHealth,
  MODEL_HEALTH_SERVER_TIMEOUT_MS,
  MODEL_HEALTH_WRITE_TIMEOUT_MS,
  type ModelHealthStore,
  type RouteCount,
} from './model-health'
import * as wiringModule from './model-extraction-wiring'
import { buildModelExtraction } from './model-extraction-wiring'

/**
 * Preflight and the collection-side reply handler (ADR 2026-11-03 §5.3), driven through the wiring
 * with the worker's real reply payloads. The store here is a stand-in with the port's semantics; the
 * SQL behind the port is pinned by `model-health-store.integration.spec.ts`.
 */
const ENV = {
  EXTRACTION_WORKER_URL: 'http://crm-extraction-worker:3100',
  EXTRACTION_WORKER_SECRET: 'SECRET-MARKER-0123456789abcdef-0123456789',
  EXTRACTION_INPUT_CONTEXT_TOKENS: '8192',
  EXTRACTION_INPUT_MAX_ANSWER_TOKENS: '512',
}
const CYCLE_A = '00000000-0000-4000-8000-00000000000a'
const CYCLE_B = '00000000-0000-4000-8000-00000000000b'
const NO_HEALTH = { modelListStale: false, failedJobs: [] }
const FAILED = { result: { ok: false, code: 'PROVIDER_ERROR' } }

const attempt = (route: string, code: string) => ({
  type: 'ATTEMPT',
  route,
  model: 'some-model',
  code,
  inputChars: 100,
  latencyMs: 5,
})
/** The pre-5.4c-H1 floor event: an old worker image can still send it mid-deploy. */
const fell = (reasons: { route: string; code: string }[]) => ({
  type: 'FELL_TO_LOCAL',
  plan: reasons.length > 0 ? 'full-then-small' : 'small',
  reasons,
})

const request = (text = 'Senior Go Engineer, Kyiv'): HtmlStructurerRequest => ({
  aiInput: 'yes',
  policy: { onUnspecified: 'block' },
  records: [{ id: 'r1', url: 'https://jobs.example.com/vacancy/r1', text }],
  extractionVersion: 'html-v1',
})

function memoryStore() {
  const counts = new Map<string, number>()
  const flags = new Map<string, { raised: boolean; lastEmitted: string | null }>()
  const store: ModelHealthStore = {
    addRouteCounts: (rows: RouteCount[]) => {
      for (const r of rows) {
        const key = `${r.day}/${r.route}/${r.code}`
        counts.set(key, (counts.get(key) ?? 0) + r.count)
      }
      return Promise.resolve()
    },
    raiseFlag: (flag) => {
      flags.set(flag, { raised: true, lastEmitted: flags.get(flag)?.lastEmitted ?? null })
      return Promise.resolve()
    },
    clearFlag: (flag) => {
      const row = flags.get(flag)
      if (row) row.raised = false
      return Promise.resolve()
    },
    claimEmissions: (cycleId) => {
      const claimed = [...flags].filter(([, r]) => r.raised && r.lastEmitted !== cycleId)
      for (const [, r] of claimed) r.lastEmitted = cycleId
      return Promise.resolve(claimed.map(([flag]) => flag) as never[])
    },
  }
  const raised = () => [...flags].filter(([, r]) => r.raised).map(([flag]) => flag)
  return { store, counts, raised }
}

const rejecting = (message: string): ModelHealthStore => ({
  addRouteCounts: () => Promise.reject(new Error(message)),
  raiseFlag: () => Promise.reject(new Error(message)),
  clearFlag: () => Promise.reject(new Error(message)),
  claimEmissions: () => Promise.reject(new Error(message)),
})

function recordingLog() {
  const errors: string[] = []
  const warns: string[] = []
  return {
    errors,
    warns,
    log: { error: (l: string) => errors.push(l), warn: (l: string) => warns.push(l) },
  }
}

type Reply = { events?: object[]; health?: object; readiness?: string; result?: object }

/**
 * `preflight`: the answer per cycle (one attempt each, H.3), the last one repeating. `false` is an
 * unreachable worker, `true` a READY one, a string another readiness answer.
 */
function setUp(
  opts: {
    preflight?: (boolean | string | Reply)[]
    /** One reply for every call, or one per call with the last repeating. */
    extract?: Reply | Reply[]
    store?: ModelHealthStore
    log?: ReturnType<typeof recordingLog>['log']
    env?: Record<string, string | undefined>
  } = {},
) {
  const preflights = opts.preflight ?? [true]
  let preflightCalls = 0
  let extractCalls = 0
  const memory = memoryStore()
  const logs = recordingLog()
  const fetchImpl = (url: string) => {
    if (url.endsWith('/extract')) {
      const replies = [opts.extract ?? {}].flat()
      const extract = replies[Math.min(extractCalls, replies.length - 1)]
      extractCalls += 1
      const body = { events: [], health: NO_HEALTH, ...FAILED, ...extract }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }
    const answer = preflights[Math.min(preflightCalls, preflights.length - 1)]!
    preflightCalls += 1
    if (answer === false) return Promise.reject(new Error('connection refused'))
    const reply = answer === true ? {} : typeof answer === 'string' ? { readiness: answer } : answer
    const body = { readiness: 'READY', events: [], health: NO_HEALTH, ...reply }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }
  const store = opts.store ?? memory.store
  const log = opts.log ?? logs.log
  const r = buildModelExtraction(opts.env ?? ENV, {
    store,
    log,
    fetchImpl,
  })
  if (!r.ok || r.wiring === undefined) throw new Error('not wired')
  return {
    wiring: r.wiring,
    ...memory,
    ...logs,
    preflightCalls: () => preflightCalls,
    extractCalls: () => extractCalls,
  }
}

/** One cycle with one model call on it, then its finish. */
async function runCycle(s: ReturnType<typeof setUp>, cycleId = CYCLE_A) {
  const cycle = await s.wiring.prepareCycle(cycleId)
  if (cycle.kind !== 'READY') throw new Error('not ready')
  const result = await cycle.structurer.structure(request())
  await cycle.finish()
  return result
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the readiness preflight: one attempt, no backoff (H.3)', () => {
  it('the backoff is gone with the multi-attempt loop', () => {
    expect(wiringModule).not.toHaveProperty('PREFLIGHT_BACKOFF_MS')
  })

  it('an unreachable worker is tried once: MODEL_UNREACHABLE, retried by the next cycle', async () => {
    const s = setUp({ preflight: [false] })
    expect((await s.wiring.prepareCycle(CYCLE_A)).kind).toBe('MODEL_UNREACHABLE')
    expect(s.preflightCalls()).toBe(1)
  })

  it('READY on the one attempt runs the model stage', async () => {
    const s = setUp()
    expect((await s.wiring.prepareCycle(CYCLE_A)).kind).toBe('READY')
    expect(s.preflightCalls()).toBe(1)
  })

  it('NO_ROUTE is MODEL_UNREACHABLE: the worker or its routes', async () => {
    const s = setUp({ preflight: ['NO_ROUTE'] })
    expect(await s.wiring.prepareCycle(CYCLE_A)).toEqual({ kind: 'MODEL_UNREACHABLE' })
    expect(s.raised()).toEqual(['MODEL_UNREACHABLE'])
  })

  it("an H1 worker's { ok } reply is not reached", async () => {
    const s = setUp({ preflight: [{ ok: true, readiness: undefined } as Reply] })
    expect((await s.wiring.prepareCycle(CYCLE_A)).kind).toBe('MODEL_UNREACHABLE')
    expect(s.preflightCalls()).toBe(1)
  })
})

describe('prepareCycle is the only way to a structurer (AC3, AC4)', () => {
  it('the wiring has no forCycle, and READY and LIMITS_EXHAUSTED carry a structurer', async () => {
    const s = setUp({ preflight: [true, 'LIMITS_EXHAUSTED'] })
    expect(Object.keys(s.wiring).sort()).toEqual(['inputCeilingChars', 'prepareCycle'])
    const ready = await s.wiring.prepareCycle(CYCLE_A)
    expect(Object.keys(ready).sort()).toEqual(['budget', 'finish', 'kind', 'structurer'])
    const limited = await s.wiring.prepareCycle(CYCLE_B)
    expect(limited.kind).toBe('LIMITS_EXHAUSTED')
    expect(Object.keys(limited).sort()).toEqual(['budget', 'finish', 'kind', 'structurer'])
  })

  it('an unreachable worker: no model call, the flag raised, nothing to mark a record with', async () => {
    const s = setUp({ preflight: [false] })
    expect(await s.wiring.prepareCycle(CYCLE_A)).toEqual({ kind: 'MODEL_UNREACHABLE' })
    expect(s.extractCalls()).toBe(0)
    expect(s.raised()).toEqual(['MODEL_UNREACHABLE'])
  })

  it('it answers with a value, never a throw, so the deterministic stages run', async () => {
    const s = setUp({ preflight: [false], store: rejecting('down') })
    await expect(s.wiring.prepareCycle(CYCLE_A)).resolves.toEqual({ kind: 'MODEL_UNREACHABLE' })
  })
})

describe('MODEL_UNREACHABLE clears only when a later preflight reaches the worker (AC5)', () => {
  it('a year passing does not clear it; a later reached preflight does', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T10:00:00Z') })
    const s = setUp({ preflight: [false, false, true] })
    await s.wiring.prepareCycle(CYCLE_A)
    expect(s.raised()).toEqual(['MODEL_UNREACHABLE'])

    vi.setSystemTime(new Date('2027-11-06T10:00:00Z'))
    await s.wiring.prepareCycle(CYCLE_B)
    expect(s.raised()).toEqual(['MODEL_UNREACHABLE'])

    expect((await s.wiring.prepareCycle(CYCLE_B)).kind).toBe('READY')
    expect(s.raised()).toEqual([])
  })

  it('a LIMITS_EXHAUSTED answer reached the worker: it clears MODEL_UNREACHABLE', async () => {
    const s = setUp({ preflight: [false, 'LIMITS_EXHAUSTED'] })
    await s.wiring.prepareCycle(CYCLE_A)
    await s.wiring.prepareCycle(CYCLE_B)
    expect(s.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
  })

  it('an extract reply alone never clears it', async () => {
    const s = setUp({ preflight: [false, true] })
    await s.wiring.prepareCycle(CYCLE_A)
    const cycle = await s.wiring.prepareCycle(CYCLE_B)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await s.store.raiseFlag('MODEL_UNREACHABLE')
    await cycle.structurer.structure(request())
    await cycle.finish()
    expect(s.raised()).toEqual(['MODEL_UNREACHABLE'])
  })
})

describe('MODEL_LIMITS_EXHAUSTED (H.2, H.3)', () => {
  const LIMITS = { result: { ok: false, code: 'LIMITS_EXHAUSTED' } }
  // The adapter parses the data again with the caller's schema: an empty answer passes it.
  const OK = { result: { ok: true, data: { extractionVersion: 'html-v1', records: [] } } }
  /** The H.2 stop: the record stays owed, with no cause. */
  const OWED = { kind: 'LIMITS_EXHAUSTED', perRecordIssues: [], remainingIds: ['r1'] }
  const flagLines = (warns: string[]) => warns.filter((l) => l.startsWith('MODEL_HEALTH_FLAG '))

  it('a LIMITS_EXHAUSTED readiness raises it and skips the model stage with zero calls', async () => {
    const s = setUp({ preflight: ['LIMITS_EXHAUSTED'] })
    const cycle = await s.wiring.prepareCycle(CYCLE_A)
    if (cycle.kind !== 'LIMITS_EXHAUSTED') throw new Error('expected the stop')
    expect(await cycle.structurer.structure(request())).toEqual(OWED)
    await cycle.finish()
    expect(s.extractCalls()).toBe(0)
    expect(s.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
  })

  it('the stop mid-cycle raises it, and no later record of the cycle calls the worker', async () => {
    const s = setUp({ extract: LIMITS })
    const cycle = await s.wiring.prepareCycle(CYCLE_A)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await cycle.structurer.structure(request())
    await cycle.structurer.structure(request('another page'))
    await cycle.finish()
    expect(s.extractCalls()).toBe(1)
    expect(s.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
  })

  it('emitted once per cycle, at warn level, never as an error', async () => {
    const s = setUp({ preflight: ['LIMITS_EXHAUSTED'] })
    for (const id of [CYCLE_A, CYCLE_B]) {
      const cycle = await s.wiring.prepareCycle(id)
      if (cycle.kind !== 'LIMITS_EXHAUSTED') throw new Error('expected the stop')
      await cycle.structurer.structure(request())
      await cycle.finish()
    }
    expect(flagLines(s.warns)).toEqual([
      'MODEL_HEALTH_FLAG flag=MODEL_LIMITS_EXHAUSTED',
      'MODEL_HEALTH_FLAG flag=MODEL_LIMITS_EXHAUSTED',
    ])
    expect(s.errors).toEqual([])
  })

  it('a stop raised at finish is emitted in that same cycle', async () => {
    const s = setUp({ extract: LIMITS })
    await runCycle(s)
    expect(flagLines(s.warns)).toEqual(['MODEL_HEALTH_FLAG flag=MODEL_LIMITS_EXHAUSTED'])
  })

  it('cleared by READY readiness in a later cycle', async () => {
    const s = setUp({ preflight: ['LIMITS_EXHAUSTED', true] })
    await s.wiring.prepareCycle(CYCLE_A)
    expect(s.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
    await s.wiring.prepareCycle(CYCLE_B)
    expect(s.raised()).toEqual([])
  })

  it('cleared by the first successful call', async () => {
    const s = setUp({ extract: OK })
    const cycle = await s.wiring.prepareCycle(CYCLE_B)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await s.store.raiseFlag('MODEL_LIMITS_EXHAUSTED')
    await cycle.structurer.structure(request())
    await cycle.finish()
    expect(s.raised()).toEqual([])
  })

  it('a success before the stop in one cycle leaves it raised: the stop is the last word', async () => {
    const s = setUp({ extract: [OK, LIMITS] })
    const cycle = await s.wiring.prepareCycle(CYCLE_A)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await cycle.structurer.structure(request())
    await cycle.structurer.structure(request('another page'))
    await cycle.finish()
    expect(s.extractCalls()).toBe(2)
    expect(s.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
  })

  it('a failed call that is not the stop leaves it as it was', async () => {
    const s = setUp()
    const cycle = await s.wiring.prepareCycle(CYCLE_B)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await s.store.raiseFlag('MODEL_LIMITS_EXHAUSTED')
    await cycle.structurer.structure(request())
    await cycle.finish()
    expect(s.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
  })

  it('NO_ROUTE or an unreachable worker says nothing of limits: it stays raised', async () => {
    const memory = memoryStore()
    const at = (answer: boolean | string) => setUp({ preflight: [answer], store: memory.store })
    await at('LIMITS_EXHAUSTED').wiring.prepareCycle(CYCLE_A)
    await at('NO_ROUTE').wiring.prepareCycle(CYCLE_B)
    await at(false).wiring.prepareCycle(CYCLE_B)
    expect(memory.raised().sort()).toEqual(['MODEL_LIMITS_EXHAUSTED', 'MODEL_UNREACHABLE'])
  })

  it.each<[string, object[]]>([
    [
      'every route spent in the call',
      [attempt('gemini', 'SPENT_DAY'), attempt('groq', 'SPENT_DAY')],
    ],
    ['the own cap refused on both', [attempt('gemini', 'CAP'), attempt('groq', 'CAP')]],
    [
      'a 402 on one, spent on the other',
      [attempt('gemini', 'CREDIT'), attempt('groq', 'SPENT_DAY')],
    ],
    [
      'a provider that disabled itself for CREDIT',
      [
        attempt('gemini', 'CREDIT'),
        { type: 'PROVIDER_DISABLED', route: 'gemini', code: 'CREDIT' },
        attempt('groq', 'CAP'),
      ],
    ],
    [
      "the router's EXHAUSTED event beside the attempts",
      [
        attempt('groq', 'SPENT_DAY'),
        {
          type: 'EXHAUSTED',
          reasons: [
            { route: 'gemini', code: 'CREDIT' },
            { route: 'groq', code: 'SPENT_DAY' },
          ],
        },
      ],
    ],
  ])('one cause raises one flag: %s gives MODEL_LIMITS_EXHAUSTED only', async (_l, events) => {
    const s = setUp({ extract: { ...LIMITS, events } })
    await runCycle(s)
    expect(s.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
    expect(s.counts.size).toBeGreaterThan(0)
  })

  it('a dead key is HOSTED_ROUTES_DEAD only, never MODEL_LIMITS_EXHAUSTED', async () => {
    const s = setUp({
      extract: {
        events: [
          attempt('gemini', 'AUTH'),
          { type: 'PROVIDER_DISABLED', route: 'gemini', code: 'AUTH' },
        ],
      },
    })
    await runCycle(s)
    expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
  })

  it('one call never raises both: SPENT_DAY beside a RETIRED 404 is transient (R1); the next call, retired in state, is the limit', async () => {
    // What the router sends for that shape: the call ends PROVIDER_ERROR, not the H.2 stop.
    const retiredCall = {
      ...FAILED,
      events: [
        attempt('groq', 'SPENT_DAY'),
        attempt('groq', 'RETIRED'),
        { type: 'RETIRED', route: 'groq', model: 'openai/gpt-oss-20b' },
        {
          type: 'EXHAUSTED',
          reasons: [
            { route: 'groq', code: 'SPENT_DAY' },
            { route: 'groq', code: 'RETIRED' },
          ],
        },
      ],
    }
    const first = setUp({ extract: retiredCall })
    await runCycle(first)
    expect(first.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
    const next = setUp({
      extract: {
        result: { ok: false, code: 'LIMITS_EXHAUSTED' },
        events: [{ type: 'EXHAUSTED', reasons: [{ route: 'groq', code: 'SPENT_DAY' }] }],
      },
    })
    await runCycle(next)
    expect(next.raised()).toEqual(['MODEL_LIMITS_EXHAUSTED'])
  })

  it('a limit beside a busy route is transient: HOSTED_ROUTES_DEAD by the busy one only', async () => {
    const s = setUp({
      extract: { events: [attempt('gemini', 'BUSY'), attempt('groq', 'SPENT_DAY')] },
    })
    await runCycle(s)
    expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
  })
})

describe('the counter (AC7, AC8: SR-M-3 from PR #1275)', () => {
  it('a hosted attempt in a real reply reaches the counter store', async () => {
    const s = setUp({ extract: { events: [attempt('gemini', 'BUSY')] } })
    await runCycle(s)
    expect([...s.counts.entries()].map(([k, v]) => [k.slice(11), v])).toEqual([['gemini/BUSY', 1]])
  })

  it('the day is the Kyiv day: 22:30 UTC on the 6th is already the 7th', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T22:30:00Z') })
    const s = setUp({ extract: { events: [attempt('groq', 'BUSY')] } })
    await runCycle(s)
    expect([...s.counts.keys()]).toEqual(['2026-11-07/groq/BUSY'])
  })

  it('a cycle with nothing to count writes no counts', async () => {
    const memory = memoryStore()
    const addRouteCounts = vi.spyOn(memory.store, 'addRouteCounts')
    await runCycle(setUp({ store: memory.store }))
    expect(addRouteCounts).not.toHaveBeenCalled()
  })

  it('an event of any other type is neither counted nor refused', async () => {
    const s = setUp({
      extract: { events: [{ type: 'CALL', code: 'OK', latencyMs: 1 }] },
    })
    await runCycle(s)
    expect(s.counts.size).toBe(0)
    expect(s.errors).toEqual([])
  })

  it('a code the router never sends is refused, even in the DB format, so it stores nothing', async () => {
    const s = setUp({ extract: { events: [attempt('groq', 'JOHN_DOE_380671234567')] } })
    await runCycle(s)
    expect(s.counts.size).toBe(0)
    expect(s.errors).toEqual(['MODEL_REPLY_EVENT_REFUSED type=ATTEMPT'])
  })

  it('a code only the router itself decides is on the closed list too', async () => {
    const s = setUp({ extract: { events: [attempt('groq', 'CAP')] } })
    await runCycle(s)
    expect([...s.counts.keys()].map((k) => k.slice(11))).toEqual(['groq/CAP'])
    expect(s.errors).toEqual([])
  })

  it('each hosted attempt code counts, per route and per code, summed over the cycle', async () => {
    const s = setUp({
      extract: {
        events: [
          attempt('gemini', 'BUSY'),
          attempt('gemini', 'BUSY'),
          attempt('groq', 'SPENT_DAY'),
        ],
      },
    })
    await runCycle(s)
    expect([...s.counts.entries()].map(([k, v]) => [k.slice(11), v])).toEqual([
      ['gemini/BUSY', 2],
      ['groq/SPENT_DAY', 1],
    ])
  })

  it('a stale local attempt is not counted: the route left with 5.4c-H1', async () => {
    const s = setUp({ extract: { events: [attempt('local', 'OK')] } })
    await runCycle(s)
    expect(s.counts.size).toBe(0)
  })

  it('the events of a preflight reply are not counted', async () => {
    const s = setUp({ preflight: [{ events: [attempt('groq', 'BUSY')] }] })
    const cycle = await s.wiring.prepareCycle(CYCLE_A)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await cycle.finish()
    expect(s.counts.size).toBe(0)
  })

  it('a bad route or code is refused with no value echoed, and nothing else in the reply is lost', async () => {
    const s = setUp({
      extract: {
        events: [
          attempt('gemini', 'Senior Go Engineer at PAGE-TEXT-MARKER'),
          attempt('PAGE-TEXT-MARKER', 'BUSY'),
          attempt('groq', 'BUSY'),
        ],
      },
    })
    await runCycle(s)
    expect([...s.counts.keys()].map((k) => k.slice(11))).toEqual(['groq/BUSY'])
    expect(s.errors).toEqual([
      'MODEL_REPLY_EVENT_REFUSED type=ATTEMPT',
      'MODEL_REPLY_EVENT_REFUSED type=ATTEMPT',
    ])
  })

  it('a second finish counts nothing twice', async () => {
    const s = setUp({ extract: { events: [attempt('groq', 'BUSY')] } })
    const cycle = await s.wiring.prepareCycle(CYCLE_A)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await cycle.structurer.structure(request())
    await cycle.finish()
    await cycle.finish()
    expect([...s.counts.values()]).toEqual([1])
  })
})

describe('HOSTED_ROUTES_DEAD (AC7, ADR §5.3 (b))', () => {
  const dead = { events: [attempt('gemini', 'BUSY'), attempt('groq', 'BUSY')] }

  it('raised when a hosted route was tried and none answered OK', async () => {
    const s = setUp({ extract: dead })
    await runCycle(s)
    expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
  })

  it('raised by one hosted failure code alone', async () => {
    const s = setUp({ extract: { events: [attempt('gemini', 'BUSY')] } })
    await runCycle(s)
    expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
  })

  describe('an EXHAUSTED event is never counted; its reasons are evidence as H.2 narrows them', () => {
    const exhausted = (reasons: unknown) => ({
      extract: { events: [{ type: 'EXHAUSTED', reasons }] },
    })

    it.each<[string, unknown]>([
      ['a transient reason', [{ route: 'gemini', code: 'BUSY' }]],
      ['an AUTH skip (a key the state already disabled)', [{ route: 'groq', code: 'AUTH' }]],
      ['a NO_MODEL skip', [{ route: 'cloudflare', code: 'NO_MODEL' }]],
      [
        'a limit beside a dead one',
        [
          { route: 'gemini', code: 'CAP' },
          { route: 'groq', code: 'AUTH' },
        ],
      ],
      ['a malformed reason', [{ route: 'mistral', code: 'CAP' }]],
      ['a reason that is not an object', ['CAP']],
      ['a non-array reasons', 'CAP'],
      // A malformed event must never hide a dead route (SR-L-1).
      ['an empty list', []],
      ['absent reasons', undefined],
      ['a failed own-cap state write (BUDGET, R2)', [{ route: 'groq', code: 'BUDGET' }]],
    ])('%s is HOSTED_ROUTES_DEAD evidence', async (_label, reasons) => {
      const s = setUp(exhausted(reasons))
      await runCycle(s)
      expect(s.counts.size).toBe(0)
      expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
      expect(s.errors).toEqual([])
    })

    it.each<[string, unknown]>([
      ['CAP', [{ route: 'gemini', code: 'CAP' }]],
      ['SPENT_DAY', [{ route: 'groq', code: 'SPENT_DAY' }]],
      ['CREDIT', [{ route: 'cloudflare', code: 'CREDIT' }]],
      ['a FIT skip (the route was asked nothing)', [{ route: 'gemini', code: 'FIT' }]],
    ])('%s is no HOSTED_ROUTES_DEAD evidence', async (_label, reasons) => {
      const s = setUp(exhausted(reasons))
      await runCycle(s)
      expect(s.counts.size).toBe(0)
      expect(s.raised()).toEqual([])
      expect(s.errors).toEqual([])
    })
  })

  it('a FELL_TO_LOCAL left in a reply by an old worker is neither counted nor evidence', async () => {
    const s = setUp({ extract: { events: [fell([{ route: 'gemini', code: 'BUSY' }])] } })
    await runCycle(s)
    expect(s.counts.size).toBe(0)
    expect(s.raised()).toEqual([])
    expect(s.errors).toEqual([])
  })

  describe('a hosted model that moved answers with RETIRED', () => {
    const retired = (extra: object = {}) => ({
      type: 'RETIRED',
      route: 'gemini',
      model: 'old-model',
      ...extra,
    })
    const answered = {
      events: [attempt('gemini', 'RETIRED'), retired({ servedModel: 'new-model' })],
    }

    it('a 2xx that names the served model is a hosted answer: not raised', async () => {
      const s = setUp({ extract: answered })
      await runCycle(s)
      expect(s.raised()).toEqual([])
    })

    it('a 2xx that names the served model clears it', async () => {
      const memory = memoryStore()
      await runCycle(setUp({ extract: dead, store: memory.store }))
      await runCycle(setUp({ extract: answered, store: memory.store }), CYCLE_B)
      expect(memory.raised()).toEqual([])
    })

    it('the 404 shape alone raises it, and is no refusal', async () => {
      const s = setUp({ extract: { events: [attempt('gemini', 'RETIRED'), retired()] } })
      await runCycle(s)
      expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
      expect(s.errors).toEqual([])
    })

    it.each([
      ['an empty served model', { servedModel: '' }],
      ['a route that is not hosted', { route: 'local', servedModel: 'new-model' }],
    ])('%s is no answer', async (_name, extra) => {
      const s = setUp({ extract: { events: [attempt('gemini', 'RETIRED'), retired(extra)] } })
      await runCycle(s)
      expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
    })
  })

  it('raised when a provider disabled itself', async () => {
    const s = setUp({
      extract: { events: [{ type: 'PROVIDER_DISABLED', route: 'gemini', code: 'AUTH' }] },
    })
    await runCycle(s)
    expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
  })

  it('not raised by a cycle that made no model call', async () => {
    const s = setUp()
    const cycle = await s.wiring.prepareCycle(CYCLE_A)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await cycle.finish()
    expect(s.raised()).toEqual([])
  })

  it('not raised by an aborted call: ABORTED says nothing of the route (ADR §5.5)', async () => {
    const s = setUp({ extract: { events: [attempt('gemini', 'ABORTED')] } })
    await runCycle(s)
    expect(s.raised()).toEqual([])
    expect(s.counts.size).toBe(1)
  })

  it('one hosted OK in the cycle keeps it down, whatever failed around it', async () => {
    const s = setUp({ extract: { events: [attempt('gemini', 'BUSY'), attempt('groq', 'OK')] } })
    await runCycle(s)
    expect(s.raised()).toEqual([])
  })

  it('a local OK does not count as a hosted one', async () => {
    const s = setUp({
      extract: { events: [attempt('gemini', 'BUSY'), attempt('local', 'OK')] },
    })
    await runCycle(s)
    expect(s.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
  })

  it('cleared by the first hosted OK of a later cycle', async () => {
    const memory = memoryStore()
    await runCycle(setUp({ extract: dead, store: memory.store }))
    expect(memory.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
    await runCycle(
      setUp({ extract: { events: [attempt('groq', 'OK')] }, store: memory.store }),
      CYCLE_B,
    )
    expect(memory.raised()).toEqual([])
  })

  it('a later cycle with no evidence leaves it raised', async () => {
    const memory = memoryStore()
    await runCycle(setUp({ extract: dead, store: memory.store }))
    await runCycle(setUp({ store: memory.store }), CYCLE_B)
    expect(memory.raised()).toEqual(['HOSTED_ROUTES_DEAD'])
  })
})

describe('re-emission while raised (AC7, ADR §5.3 (c))', () => {
  const emitted = (warns: string[]) => warns.filter((l) => l.startsWith('MODEL_HEALTH_FLAG '))

  it('a flag is emitted once in a cycle, then again in the next one', async () => {
    const s = setUp({ preflight: [false] })
    await s.wiring.prepareCycle(CYCLE_A)
    expect(emitted(s.warns)).toEqual(['MODEL_HEALTH_FLAG flag=MODEL_UNREACHABLE'])
    await s.wiring.prepareCycle(CYCLE_B)
    expect(emitted(s.warns)).toHaveLength(2)
  })

  it('a flag raised at finish is emitted in that same cycle, and only once', async () => {
    const s = setUp({ extract: { events: [attempt('gemini', 'BUSY')] } })
    const cycle = await s.wiring.prepareCycle(CYCLE_A)
    if (cycle.kind !== 'READY') throw new Error('not ready')
    await cycle.structurer.structure(request())
    await cycle.finish()
    await cycle.finish()
    expect(emitted(s.warns)).toEqual(['MODEL_HEALTH_FLAG flag=HOSTED_ROUTES_DEAD'])
  })

  it('a restart does not re-emit for the same cycle', async () => {
    const memory = memoryStore()
    const before = setUp({ preflight: [false], store: memory.store })
    await before.wiring.prepareCycle(CYCLE_A)
    const after = setUp({ preflight: [false], store: memory.store })
    await after.wiring.prepareCycle(CYCLE_A)
    expect(emitted(before.warns)).toHaveLength(1)
    expect(emitted(after.warns)).toHaveLength(0)
  })

  it('a cleared flag is not emitted', async () => {
    const memory = memoryStore()
    await setUp({ preflight: [false], store: memory.store }).wiring.prepareCycle(CYCLE_A)
    const after = setUp({ store: memory.store })
    await after.wiring.prepareCycle(CYCLE_B)
    expect(emitted(after.warns)).toEqual([])
  })

  it('a failed claim emits nothing', async () => {
    const s = setUp({ preflight: [false], store: rejecting('down') })
    await s.wiring.prepareCycle(CYCLE_A)
    expect(emitted(s.warns)).toEqual([])
  })
})

describe('PROVIDER_DISABLED is loud once per process (AC7)', () => {
  const disabled = { type: 'PROVIDER_DISABLED', route: 'gemini', code: 'AUTH' }

  it('one line over two cycles, naming route and code only', async () => {
    const s = setUp({ extract: { events: [disabled] } })
    await runCycle(s, CYCLE_A)
    await runCycle(s, CYCLE_B)
    expect(s.errors).toEqual(['MODEL_PROVIDER_DISABLED route=gemini code=AUTH'])
  })

  it('another route or another code has its own line', async () => {
    const s = setUp({
      extract: {
        events: [
          disabled,
          { type: 'PROVIDER_DISABLED', route: 'groq', code: 'AUTH' },
          { type: 'PROVIDER_DISABLED', route: 'gemini', code: 'CREDIT' },
        ],
      },
    })
    await runCycle(s)
    expect(s.errors).toEqual([
      'MODEL_PROVIDER_DISABLED route=gemini code=AUTH',
      'MODEL_PROVIDER_DISABLED route=groq code=AUTH',
      'MODEL_PROVIDER_DISABLED route=gemini code=CREDIT',
    ])
  })

  it('a route or code outside the fixed list is refused, not printed', async () => {
    const s = setUp({
      extract: {
        events: [{ type: 'PROVIDER_DISABLED', route: 'gemini', code: 'PAGE-TEXT-MARKER' }],
      },
    })
    await runCycle(s)
    expect(s.errors).toEqual(['MODEL_REPLY_EVENT_REFUSED type=PROVIDER_DISABLED'])
  })
})

describe("the reply's health codes are flags, raised while present (AC7)", () => {
  const STALE = { modelListStale: true, failedJobs: ['daily', 'chain'] }

  it('a preflight reply carrying them raises each', async () => {
    const s = setUp({ preflight: [{ health: STALE }] })
    await s.wiring.prepareCycle(CYCLE_A)
    expect(s.raised().sort()).toEqual(['FAILED_JOB_CHAIN', 'FAILED_JOB_DAILY', 'MODEL_LIST_STALE'])
  })

  it('a reply that no longer carries one clears it, and only it', async () => {
    const s = setUp({
      preflight: [{ health: STALE }],
      extract: { health: { modelListStale: false, failedJobs: ['chain'] } },
    })
    await runCycle(s)
    expect(s.raised()).toEqual(['FAILED_JOB_CHAIN'])
  })

  it('no reply at all changes nothing: an unreachable worker has not said it recovered', async () => {
    const memory = memoryStore()
    await setUp({ preflight: [{ health: STALE }], store: memory.store }).wiring.prepareCycle(
      CYCLE_A,
    )
    await setUp({ preflight: [false], store: memory.store }).wiring.prepareCycle(CYCLE_B)
    expect(memory.raised().sort()).toEqual([
      'FAILED_JOB_CHAIN',
      'FAILED_JOB_DAILY',
      'MODEL_LIST_STALE',
      'MODEL_UNREACHABLE',
    ])
  })
})

describe('a failed health write never changes an extraction result (AC9)', () => {
  const reply = {
    events: [attempt('gemini', 'BUSY')],
    health: { modelListStale: true, failedJobs: [] },
  }

  it('the same result, finish resolves, and error lines carry codes only', async () => {
    const healthy = await runCycle(setUp({ extract: reply }))
    const s = setUp({ extract: reply, store: rejecting('PAGE-TEXT-MARKER in a driver error') })
    expect(await runCycle(s)).toEqual(healthy)
    expect([...new Set(s.errors)].sort()).toEqual([
      'MODEL_HEALTH_WRITE_FAILED op=ADD_ROUTE_COUNTS',
      'MODEL_HEALTH_WRITE_FAILED op=CLAIM_EMISSIONS',
      'MODEL_HEALTH_WRITE_FAILED op=CLEAR_FLAG',
      'MODEL_HEALTH_WRITE_FAILED op=RAISE_FLAG',
    ])
  })

  it('one failing write does not stop the next one', async () => {
    const memory = memoryStore()
    const store: ModelHealthStore = {
      ...memory.store,
      addRouteCounts: () => Promise.reject(new Error('down')),
    }
    await runCycle(setUp({ extract: reply, store }))
    expect(memory.raised().sort()).toEqual(['HOSTED_ROUTES_DEAD', 'MODEL_LIST_STALE'])
  })

  it('a synchronous throw from the store is handled the same way', async () => {
    const store: ModelHealthStore = {
      ...memoryStore().store,
      claimEmissions: () => {
        throw new Error('sync')
      },
    }
    const s = setUp({ store })
    await expect(s.wiring.prepareCycle(CYCLE_A)).resolves.toMatchObject({ kind: 'READY' })
    expect(s.errors).toEqual(['MODEL_HEALTH_WRITE_FAILED op=CLAIM_EMISSIONS'])
  })

  it('a write that never settles is bounded at 5 s, logged, and finish still resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const never = () => new Promise<never>(() => undefined)
    const logs = recordingLog()
    const store: ModelHealthStore = {
      addRouteCounts: never,
      raiseFlag: never,
      clearFlag: never,
      claimEmissions: never,
    }
    const cycle = createModelHealth({ store, log: logs.log }).beginCycle(CYCLE_A)
    cycle.onReply({ events: [attempt('groq', 'BUSY')], health: NO_HEALTH })
    const finished = cycle.finish()

    expect(MODEL_HEALTH_WRITE_TIMEOUT_MS).toBe(5_000)
    expect(MODEL_HEALTH_SERVER_TIMEOUT_MS).toBe(3_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(logs.errors).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(logs.errors).toEqual(['MODEL_HEALTH_WRITE_FAILED op=ADD_ROUTE_COUNTS'])

    await vi.advanceTimersByTimeAsync(5 * 5_000)
    await expect(finished).resolves.toBeUndefined()
    expect(logs.errors.at(-1)).toBe('MODEL_HEALTH_WRITE_FAILED op=CLAIM_EMISSIONS')
    expect(vi.getTimerCount()).toBe(0)
  })
})
