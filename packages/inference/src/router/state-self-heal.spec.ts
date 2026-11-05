import { describe, expect, it } from 'vitest'
import { fakeFs } from './__test-helpers__/fake-fs'
import {
  BUSY_DEAD_DAYS,
  clearAuth,
  clearRetired,
  createFileRouteStatePort,
  EMPTY_ROUTE_STATE,
  markAuth,
  markRetired,
  markStartupRefresh,
  MAX_STATE_ENTRIES,
  PROMOTION_STREAK,
  setJobFailed,
  setModelRecords,
  setStaleModels,
  type RouteState,
  type StateEvent,
} from './state'

const PATH = '/data/route-state.json'
const NOON = Date.parse('2026-11-04T12:00:00Z')
const MODEL = 'gemini-2.5-flash'
const DAY = '2026-11-04'

const doc = (s: object) => JSON.stringify({ ...EMPTY_ROUTE_STATE, ...s })

async function load(text: string | undefined) {
  const fs = fakeFs(text === undefined ? {} : { [PATH]: text })
  const events: StateEvent[] = []
  const port = await createFileRouteStatePort({
    path: PATH,
    fs,
    now: () => NOON,
    onEvent: (e) => events.push(e),
  })
  return { fs, port, events }
}

const probation = (over: object = {}) => ({
  provider: 'gemini',
  model: MODEL,
  aliveStreak: 1,
  lastProbeDay: DAY,
  ...over,
})
const busy = (over: object = {}) => ({
  provider: 'gemini',
  model: MODEL,
  busyDays: 1,
  lastProbeDay: DAY,
  ...over,
})
const stale = (over: object = {}) => ({ provider: 'gemini', model: MODEL, ...over })
const many = <T>(entry: T, n: number): T[] => Array.from({ length: n }, () => entry)

describe('self-heal records in the route-state file (SR-M-6, SR-M-9)', () => {
  it('loads every record', async () => {
    const records = {
      probation: [probation({ aliveStreak: PROMOTION_STREAK })],
      busy: [busy({ busyDays: BUSY_DEAD_DAYS })],
      modelListStale: [stale()],
      failedJobs: ['daily', 'chain'],
      providers: [
        { provider: 'groq', auth: true, lastStartupRefreshAt: '2026-11-04T11:00:00.000Z' },
      ],
    }
    const { port, events } = await load(doc(records))
    expect(port.snapshot()).toEqual({ ...EMPTY_ROUTE_STATE, ...records })
    expect(events).toEqual([])
  })

  it.each<[string, object]>([
    ['probation', { probation: many(probation({ aliveStreak: 0 }), MAX_STATE_ENTRIES) }],
    ['busy', { busy: many(busy({ busyDays: 0 }), MAX_STATE_ENTRIES) }],
    ['modelListStale', { modelListStale: many(stale(), MAX_STATE_ENTRIES) }],
  ])('accepts a zero count and exactly the entry cap in %s', async (key, record) => {
    const { port, events } = await load(doc(record))
    expect(port.snapshot()[key as keyof RouteState]).toHaveLength(MAX_STATE_ENTRIES)
    expect(events).toEqual([])
  })

  it('leaves the optional records absent on a file without them', async () => {
    const { port } = await load(doc({}))
    expect(Object.keys(port.snapshot()).sort()).toEqual([
      'providers',
      'retired',
      'spent',
      'version',
    ])
  })

  it.each<[string, object]>([
    ['a streak above N', { probation: [probation({ aliveStreak: PROMOTION_STREAK + 1 })] }],
    ['a negative streak', { probation: [probation({ aliveStreak: -1 })] }],
    ['a fractional streak', { probation: [probation({ aliveStreak: 1.5 })] }],
    ['a Groq probation record', { probation: [probation({ provider: 'groq' })] }],
    ['a provider outside the allowlist', { probation: [probation({ provider: 'openrouter' })] }],
    ['an invalid probation id', { probation: [probation({ model: '../secret' })] }],
    ['a bad probe day', { probation: [probation({ lastProbeDay: 'today' })] }],
    ['an unknown probation field', { probation: [probation({ promoted: true })] }],
    ['too many probation entries', { probation: many(probation(), MAX_STATE_ENTRIES + 1) }],
    ['busy days above the rule', { busy: [busy({ busyDays: BUSY_DEAD_DAYS + 1 })] }],
    ['negative busy days', { busy: [busy({ busyDays: -1 })] }],
    ['fractional busy days', { busy: [busy({ busyDays: 0.5 })] }],
    ['a Groq busy record', { busy: [busy({ provider: 'groq' })] }],
    ['an invalid busy id', { busy: [busy({ model: 'https://evil.example/x' })] }],
    ['a bad busy day', { busy: [busy({ lastProbeDay: 'today' })] }],
    ['an unknown busy field', { busy: [busy({ extra: 1 })] }],
    ['too many busy entries', { busy: many(busy(), MAX_STATE_ENTRIES + 1) }],
    ['a stale provider outside the allowlist', { modelListStale: [stale({ provider: 'x' })] }],
    ['an invalid stale id', { modelListStale: [stale({ model: 'gemini 2.5' })] }],
    ['an unknown stale field', { modelListStale: [stale({ extra: 1 })] }],
    ['too many stale entries', { modelListStale: many(stale(), MAX_STATE_ENTRIES + 1) }],
    ['an unknown job', { failedJobs: ['weekly'] }],
    ['too many failed jobs', { failedJobs: ['daily', 'chain', 'daily'] }],
    [
      'a bad refresh stamp',
      { providers: [{ provider: 'groq', auth: true, lastStartupRefreshAt: 'soon' }] },
    ],
  ])('rejects the whole file on %s', async (_label, bad) => {
    const { port, events } = await load(doc({ ...bad, spent: [] }))
    expect(port.snapshot()).toEqual(EMPTY_ROUTE_STATE)
    expect(events).toEqual([{ type: 'STATE_RESET', store: 'route-state', reason: 'invalid' }])
  })

  it('keeps the records across a write, and two concurrent changes both survive', async () => {
    const { fs, port } = await load(doc({ probation: [probation()] }))
    await Promise.all([port.update(markAuth('groq')), port.update(setJobFailed('daily', true))])
    const written = JSON.parse(fs.files.get(PATH)!) as RouteState
    expect(written.probation).toEqual([probation()])
    expect(written.failedJobs).toEqual(['daily'])
    expect(written.providers).toEqual([{ provider: 'groq', auth: true }])
    expect(fs.modes.get(fs.tempNames[0]!)).toBe(0o600)
    expect(fs.modes.get(fs.tempNames[1]!)).toBe(0o600)
  })

  it('a write interrupted between temp file and rename leaves the previous file', async () => {
    const before = doc({ probation: [probation()] })
    const { fs, port } = await load(before)
    fs.failAt = 'rename'
    expect(await port.update(setJobFailed('chain', true))).toBe(false)
    expect(fs.files.get(PATH)).toBe(before)
    const reloaded = await createFileRouteStatePort({
      path: PATH,
      fs,
      now: () => NOON,
      onEvent: () => undefined,
    })
    expect(reloaded.snapshot().probation).toEqual([probation()])
  })
})

describe('self-heal state changes', () => {
  it('clearAuth lifts only the named provider, and only the bit', () => {
    const s = markAuth('gemini')(markAuth('groq')(EMPTY_ROUTE_STATE))
    expect(clearAuth('groq')(s).providers).toEqual([
      { provider: 'gemini', auth: true },
      { provider: 'groq', auth: false },
    ])
  })

  it('clearRetired removes only the named provider', () => {
    const s = markRetired(
      'groq',
      'openai/gpt-oss-20b',
      NOON,
    )(markRetired('gemini', MODEL, NOON)(EMPTY_ROUTE_STATE))
    expect(clearRetired('groq')(s).retired.map((e) => e.provider)).toEqual(['gemini'])
  })

  it('markStartupRefresh stamps the provider at the given instant', () => {
    expect(markStartupRefresh('groq', NOON)(EMPTY_ROUTE_STATE).providers).toEqual([
      { provider: 'groq', auth: false, lastStartupRefreshAt: '2026-11-04T12:00:00.000Z' },
    ])
  })

  it('setModelRecords replaces both lists, capped by dropping the oldest', () => {
    const ids = Array.from({ length: MAX_STATE_ENTRIES + 1 }, (_, i) => `gemini-${i}.0-flash`)
    const next = setModelRecords(
      ids.map((model) => ({ provider: 'gemini', model, aliveStreak: 0, lastProbeDay: DAY })),
      ids.map((model) => ({ provider: 'gemini', model, busyDays: 1, lastProbeDay: DAY })),
    )(EMPTY_ROUTE_STATE)
    expect(next.probation).toHaveLength(MAX_STATE_ENTRIES)
    expect(next.probation?.[0]?.model).toBe('gemini-1.0-flash')
    expect(next.busy).toHaveLength(MAX_STATE_ENTRIES)
    expect(next.busy?.[0]?.model).toBe('gemini-1.0-flash')
  })

  it('setStaleModels replaces one provider and keeps the other', () => {
    const s = setStaleModels('gemini', [MODEL])(EMPTY_ROUTE_STATE)
    const both = setStaleModels('groq', ['openai/gpt-oss-20b'])(s)
    expect(both.modelListStale).toEqual([
      { provider: 'gemini', model: MODEL },
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
    ])
    expect(setStaleModels('gemini', [])(both).modelListStale).toEqual([
      { provider: 'groq', model: 'openai/gpt-oss-20b' },
    ])
  })

  it('setStaleModels caps the list by dropping the oldest', () => {
    const ids = Array.from({ length: MAX_STATE_ENTRIES + 1 }, (_, i) => `gemini-${i}.0-flash`)
    const next = setStaleModels('gemini', ids)(EMPTY_ROUTE_STATE)
    expect(next.modelListStale).toHaveLength(MAX_STATE_ENTRIES)
    expect(next.modelListStale?.[0]?.model).toBe('gemini-1.0-flash')
  })

  it('setJobFailed sets once and clears only its own job', () => {
    const daily = setJobFailed('daily', true)(EMPTY_ROUTE_STATE)
    expect(daily.failedJobs).toEqual(['daily'])
    const twice = setJobFailed('daily', true)(daily)
    expect(twice.failedJobs).toEqual(['daily'])
    const both = setJobFailed('chain', true)(twice)
    expect(setJobFailed('daily', false)(both).failedJobs).toEqual(['chain'])
    expect(setJobFailed('chain', false)(EMPTY_ROUTE_STATE).failedJobs).toEqual([])
  })
})
