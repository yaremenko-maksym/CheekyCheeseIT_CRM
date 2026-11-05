import { describe, expect, it } from 'vitest'
import { fakeFs } from './__test-helpers__/fake-fs'
import {
  BUSY_DEAD_DAYS,
  BUSY_DEAD_REPROBE_DAYS,
  clearAuth,
  clearRetired,
  createFileRouteStatePort,
  EMPTY_ROUTE_STATE,
  isBusyDead,
  isBusyDeadReprobeDue,
  MANAGED_LIST_TARGET,
  markAuth,
  markRetired,
  markStartupRefresh,
  MAX_BUSY_DEAD_ENTRIES,
  MAX_STATE_BYTES,
  MAX_STATE_ENTRIES,
  PROMOTION_STREAK,
  setJobFailed,
  setModelRecords,
  setStaleModels,
  staleModelsOf,
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
const held = (over: object = {}) => ({ provider: 'gemini', model: MODEL, day: DAY, ...over })
const stale = (over: object = {}) => ({ provider: 'gemini', model: MODEL, ...over })
const many = <T>(entry: T, n: number): T[] => Array.from({ length: n }, () => entry)

describe('self-heal records in the route-state file (SR-M-6, SR-M-9)', () => {
  it('loads every record', async () => {
    const records = {
      probation: [probation({ aliveStreak: PROMOTION_STREAK })],
      busy: [busy({ busyDays: BUSY_DEAD_DAYS })],
      busyDead: [held()],
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

  it.each<[string, object, number]>([
    [
      'probation',
      { probation: many(probation({ aliveStreak: 0 }), MANAGED_LIST_TARGET) },
      MANAGED_LIST_TARGET,
    ],
    ['busy', { busy: many(busy({ busyDays: 0 }), MANAGED_LIST_TARGET) }, MANAGED_LIST_TARGET],
    ['busyDead', { busyDead: many(held(), MAX_BUSY_DEAD_ENTRIES) }, MAX_BUSY_DEAD_ENTRIES],
    ['modelListStale', { modelListStale: many(stale(), MAX_STATE_ENTRIES) }, MAX_STATE_ENTRIES],
  ])('accepts a zero count and exactly the entry cap in %s', async (key, record, cap) => {
    const { port, events } = await load(doc(record))
    expect(port.snapshot()[key as keyof RouteState]).toHaveLength(cap)
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
    ['too many probation entries', { probation: many(probation(), MANAGED_LIST_TARGET + 1) }],
    ['busy days above the rule', { busy: [busy({ busyDays: BUSY_DEAD_DAYS + 1 })] }],
    ['negative busy days', { busy: [busy({ busyDays: -1 })] }],
    ['fractional busy days', { busy: [busy({ busyDays: 0.5 })] }],
    ['a Groq busy record', { busy: [busy({ provider: 'groq' })] }],
    ['an invalid busy id', { busy: [busy({ model: 'https://evil.example/x' })] }],
    ['a bad busy day', { busy: [busy({ lastProbeDay: 'today' })] }],
    ['an unknown busy field', { busy: [busy({ extra: 1 })] }],
    ['too many busy entries', { busy: many(busy(), MANAGED_LIST_TARGET + 1) }],
    ['a Groq busy-dead verdict', { busyDead: [held({ provider: 'groq' })] }],
    ['an invalid busy-dead id', { busyDead: [held({ model: '../secret' })] }],
    ['a bad busy-dead day', { busyDead: [held({ day: 'today' })] }],
    ['an unknown busy-dead field', { busyDead: [held({ extra: 1 })] }],
    ['too many busy-dead verdicts', { busyDead: many(held(), MAX_BUSY_DEAD_ENTRIES + 1) }],
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

describe('the write ceiling (ADR §3.2, SR-M-2)', () => {
  // The padding stands in for any growth: the ceiling runs before anything reads the document.
  const padded =
    (pad: string) =>
    (s: RouteState): RouteState =>
      ({ ...s, pad }) as RouteState
  const fill = (bytes: number): string =>
    'x'.repeat(bytes - JSON.stringify({ ...EMPTY_ROUTE_STATE, pad: '' }).length)

  it('writes a document of exactly the ceiling', async () => {
    const { fs, port, events } = await load(undefined)
    expect(await port.update(padded(fill(MAX_STATE_BYTES)))).toBe(true)
    expect(Buffer.byteLength(fs.files.get(PATH)!)).toBe(MAX_STATE_BYTES)
    expect(events).toEqual([])
  })

  it('refuses one byte more, keeping the file and memory, and says so', async () => {
    const before = JSON.stringify(EMPTY_ROUTE_STATE)
    const { fs, port, events } = await load(before)
    const snapshot = port.snapshot()
    expect(await port.update(padded(fill(MAX_STATE_BYTES + 1)))).toBe(false)
    expect(fs.files.get(PATH)).toBe(before)
    expect(fs.tempNames).toEqual([])
    expect(port.snapshot()).toBe(snapshot)
    expect(events).toEqual([
      { type: 'STATE_WRITE_FAILED', store: 'route-state', reason: 'oversized' },
    ])
  })

  it('counts bytes, not characters', async () => {
    const { fs, port, events } = await load(undefined)
    expect(await port.update(padded('é'.repeat(MAX_STATE_BYTES / 2)))).toBe(false)
    expect(fs.files.size).toBe(0)
    expect(events).toHaveLength(1)
  })

  it('a refused change does not stop the next one', async () => {
    const { fs, port } = await load(undefined)
    await port.update(padded(fill(MAX_STATE_BYTES + 1)))
    expect(await port.update(setJobFailed('daily', true))).toBe(true)
    expect((JSON.parse(fs.files.get(PATH)!) as RouteState).failedJobs).toEqual(['daily'])
  })

  it('a maximal self-heal document stays under the ceiling and reloads clean', async () => {
    const longest = (i: number): string =>
      `gemini-${String(i).padStart(128 - 'gemini--flash'.length, '9')}-flash`
    const ids = Array.from({ length: MANAGED_LIST_TARGET }, (_, i) => longest(i))
    const { fs, port } = await load(undefined)
    await port.update(
      setModelRecords(
        ids.map((model) => ({ provider: 'gemini', model, aliveStreak: 3, lastProbeDay: DAY })),
        ids.map((model) => ({ provider: 'gemini', model, busyDays: 2, lastProbeDay: DAY })),
        Array.from({ length: MAX_BUSY_DEAD_ENTRIES }, (_, i) => ({
          provider: 'gemini',
          model: longest(i),
          day: DAY,
        })),
      ),
    )
    const text = fs.files.get(PATH)!
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_STATE_BYTES)
    const { port: reloaded, events } = await load(text)
    expect(reloaded.snapshot().probation).toHaveLength(MANAGED_LIST_TARGET)
    expect(reloaded.snapshot().busy).toHaveLength(MANAGED_LIST_TARGET)
    expect(reloaded.snapshot().busyDead).toHaveLength(MAX_BUSY_DEAD_ENTRIES)
    expect(events).toEqual([])
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

  it('setModelRecords replaces every list, capped at its own limit by dropping the oldest', () => {
    const ids = Array.from({ length: MANAGED_LIST_TARGET + 1 }, (_, i) => `gemini-${i}.0-flash`)
    const next = setModelRecords(
      ids.map((model) => ({ provider: 'gemini', model, aliveStreak: 0, lastProbeDay: DAY })),
      ids.map((model) => ({ provider: 'gemini', model, busyDays: 1, lastProbeDay: DAY })),
      Array.from({ length: MAX_BUSY_DEAD_ENTRIES + 1 }, (_, i) => ({
        provider: 'gemini',
        model: `gemini-${i}.0-flash`,
        day: DAY,
      })),
    )(EMPTY_ROUTE_STATE)
    expect(next.probation).toHaveLength(MANAGED_LIST_TARGET)
    expect(next.probation?.[0]?.model).toBe('gemini-1.0-flash')
    expect(next.busy).toHaveLength(MANAGED_LIST_TARGET)
    expect(next.busy?.[0]?.model).toBe('gemini-1.0-flash')
    expect(next.busyDead).toHaveLength(MAX_BUSY_DEAD_ENTRIES)
    expect(next.busyDead?.[0]?.model).toBe('gemini-1.0-flash')
  })

  it('isBusyDead reads the verdict of this model only', () => {
    const s = {
      ...EMPTY_ROUTE_STATE,
      busyDead: [{ provider: 'gemini' as const, model: MODEL, day: DAY }],
    }
    expect(isBusyDead(s, MODEL)).toBe(true)
    expect(isBusyDead(s, 'gemini-3.0-flash')).toBe(false)
    expect(isBusyDead(EMPTY_ROUTE_STATE, MODEL)).toBe(false)
  })

  it('a re-probe falls due on the seventh UTC day after the stamp, not before', () => {
    const s = {
      ...EMPTY_ROUTE_STATE,
      busyDead: [{ provider: 'gemini' as const, model: MODEL, day: DAY }],
    }
    expect(BUSY_DEAD_REPROBE_DAYS).toBe(7)
    expect(isBusyDeadReprobeDue(s, MODEL, DAY)).toBe(false)
    expect(isBusyDeadReprobeDue(s, MODEL, '2026-11-10')).toBe(false)
    expect(isBusyDeadReprobeDue(s, MODEL, '2026-11-11')).toBe(true)
    expect(isBusyDeadReprobeDue(s, MODEL, '2026-11-12')).toBe(true)
    expect(isBusyDeadReprobeDue(s, 'gemini-3.0-flash', '2026-11-12')).toBe(false)
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

  it('staleModelsOf reads one provider, and nothing from a state with no list', () => {
    expect(staleModelsOf(EMPTY_ROUTE_STATE, 'gemini')).toEqual([])
    const both = setStaleModels('groq', ['openai/gpt-oss-20b'])(
      setStaleModels('gemini', [MODEL])(EMPTY_ROUTE_STATE),
    )
    expect(staleModelsOf(both, 'gemini')).toEqual([MODEL])
    expect(staleModelsOf(both, 'groq')).toEqual(['openai/gpt-oss-20b'])
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
