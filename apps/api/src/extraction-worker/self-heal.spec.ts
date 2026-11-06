import type { ModelRefreshDeps, ModelRefreshResult, RouterEvent } from '@crm/inference'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAIN_CHECK_INTERVAL_MS, DAILY_REFRESH_INTERVAL_MS, scheduleSelfHeal } from './self-heal'

const DONE: ModelRefreshResult = { ok: true, providers: [] }
const CONFIG = {
  policyVersion: 'p1',
  hostedBudgetMs: 5000,
  floorBudgetMs: 60_000,
  routes: [
    {
      provider: 'local',
      baseUrl: 'http://crm-model-runtime:11434',
      model: 'qwen2.5:3b',
      contextTokens: 8192,
      structuredOutput: 'json_schema',
      timeoutMs: 1000,
      maxAnswerTokens: 512,
    },
  ],
}

const attempt = (route: 'gemini' | 'groq' | 'local', model: string, code = 'OK'): RouterEvent =>
  ({ type: 'ATTEMPT', route, model, code, inputChars: 1, latencyMs: 1 }) as RouterEvent

function world(config: unknown = CONFIG, throwing?: string) {
  const seen: { job: string; deps: ModelRefreshDeps }[] = []
  const job = (name: string) =>
    vi.fn((deps: ModelRefreshDeps) => {
      seen.push({ job: name, deps })
      return name === throwing ? Promise.reject(new Error('KEY-MARKER')) : Promise.resolve(DONE)
    })
  const jobs = { startup: job('startup'), daily: job('daily'), chain: job('chain') }
  const log = vi.fn()
  const heal = scheduleSelfHeal({
    config,
    state: {} as ModelRefreshDeps['state'],
    ownCap: {} as ModelRefreshDeps['ownCap'],
    managedModels: () => Promise.resolve([]),
    writeManagedList: () => Promise.resolve(false),
    log,
    now: () => 0,
    jobs,
  })
  return { heal, jobs, seen, log }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('scheduleSelfHeal — the worker owns the §3.4 timers', () => {
  it('a day and a week', () => {
    expect(DAILY_REFRESH_INTERVAL_MS).toBe(86_400_000)
    expect(CHAIN_CHECK_INTERVAL_MS).toBe(7 * 86_400_000)
  })

  it('runs the start-up refresh at once with the state, own cap and the OK ledger', () => {
    const w = world()
    expect(w.jobs.startup).toHaveBeenCalledTimes(1)
    expect(w.jobs.daily).not.toHaveBeenCalled()
    expect(w.jobs.chain).not.toHaveBeenCalled()
    const deps = w.seen[0]!.deps
    expect(deps.config.policyVersion).toBe('p1')
    expect(typeof deps.hadOkCall).toBe('function')
    w.heal.stop()
  })

  it('runs the daily refresh each day and the chain check each week', async () => {
    const w = world()
    await vi.advanceTimersByTimeAsync(DAILY_REFRESH_INTERVAL_MS - 1)
    expect(w.jobs.daily).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(w.jobs.daily).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHAIN_CHECK_INTERVAL_MS - DAILY_REFRESH_INTERVAL_MS)
    expect(w.jobs.daily).toHaveBeenCalledTimes(7)
    expect(w.jobs.chain).toHaveBeenCalledTimes(1)
    w.heal.stop()
  })

  it('hadOkCall is true only for a hosted OK attempt since the last daily refresh', async () => {
    const w = world()
    const had = w.seen[0]!.deps.hadOkCall!
    w.heal.record(attempt('groq', 'openai/gpt-oss-20b'))
    w.heal.record(attempt('gemini', 'gemini-2.5-flash', 'BUSY'))
    w.heal.record(attempt('local', 'gemini-2.5-flash'))
    w.heal.record({ type: 'CONFIG_REFUSED' })
    expect(had('groq', 'openai/gpt-oss-20b')).toBe(true)
    expect(had('gemini', 'openai/gpt-oss-20b')).toBe(false)
    expect(had('gemini', 'gemini-2.5-flash')).toBe(false)
    await vi.advanceTimersByTimeAsync(DAILY_REFRESH_INTERVAL_MS)
    // The daily run saw the ledger, then it starts empty for the next day.
    expect(w.seen.find((s) => s.job === 'daily')!.deps.hadOkCall).toBe(had)
    expect(had('groq', 'openai/gpt-oss-20b')).toBe(false)
    w.heal.stop()
  })

  it('a failed run before the clear keeps the ledger: no OK call is forgotten', async () => {
    const w = world()
    w.jobs.daily.mockImplementationOnce(() => Promise.reject(new Error('KEY-MARKER')))
    w.heal.record(attempt('groq', 'openai/gpt-oss-20b'))
    await vi.advanceTimersByTimeAsync(DAILY_REFRESH_INTERVAL_MS)
    expect(w.seen[0]!.deps.hadOkCall!('groq', 'openai/gpt-oss-20b')).toBe(true)
    expect(w.log).toHaveBeenCalledWith({
      event: 'REFRESH',
      type: 'MODEL_REFRESH_FAILED',
      job: 'daily',
    })
    expect(JSON.stringify(w.log.mock.calls)).not.toContain('KEY-MARKER')
    w.heal.stop()
  })

  it.each(['startup', 'chain'] as const)('a thrown %s run is one fixed line', async (job) => {
    const w = world(CONFIG, job)
    await vi.advanceTimersByTimeAsync(job === 'chain' ? CHAIN_CHECK_INTERVAL_MS : 0)
    expect(w.log).toHaveBeenCalledWith({ event: 'REFRESH', type: 'MODEL_REFRESH_FAILED', job })
    expect(JSON.stringify(w.log.mock.calls)).not.toContain('KEY-MARKER')
    w.heal.stop()
  })

  it('job events are logged as REFRESH lines', () => {
    const w = world()
    w.seen[0]!.deps.onEvent({ type: 'MODEL_REFRESH_FAILED', job: 'startup' })
    expect(w.log).toHaveBeenCalledWith({
      event: 'REFRESH',
      type: 'MODEL_REFRESH_FAILED',
      job: 'startup',
    })
    w.heal.stop()
  })

  it('stop clears both timers', async () => {
    const w = world()
    w.heal.stop()
    await vi.advanceTimersByTimeAsync(CHAIN_CHECK_INTERVAL_MS)
    expect(w.jobs.daily).not.toHaveBeenCalled()
    expect(w.jobs.chain).not.toHaveBeenCalled()
  })

  it('a config the router refuses schedules nothing; the ledger still records', async () => {
    const w = world({ routes: [] })
    await vi.advanceTimersByTimeAsync(CHAIN_CHECK_INTERVAL_MS)
    expect(w.jobs.startup).not.toHaveBeenCalled()
    expect(w.jobs.daily).not.toHaveBeenCalled()
    expect(w.jobs.chain).not.toHaveBeenCalled()
    expect(() => w.heal.record(attempt('groq', 'm'))).not.toThrow()
    w.heal.stop()
  })
})
