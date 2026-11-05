import { describe, expect, it } from 'vitest'
import { isPromoted, MANAGED_LIST_TARGET } from './managed-models'
import {
  applyProbeDay,
  classifyModelStatus,
  effectiveContext,
  MIN_MANAGED_CONTEXT,
  nextBusy,
  nextProbation,
  pickGroqModels,
  pickLiveModels,
  type ModelFacts,
} from './model-picks'
import { BUSY_DEAD_DAYS, PROMOTION_STREAK, type BusyEntry, type ProbationEntry } from './state'

const DAY1 = '2026-11-01'
const DAY2 = '2026-11-02'
const DAY3 = '2026-11-03'

const probation = (model: string, aliveStreak: number, lastProbeDay = DAY1): ProbationEntry => ({
  provider: 'gemini',
  model,
  aliveStreak,
  lastProbeDay,
})
const busy = (model: string, busyDays: number, lastProbeDay = DAY1): BusyEntry => ({
  provider: 'gemini',
  model,
  busyDays,
  lastProbeDay,
})

describe('classifyModelStatus', () => {
  it.each([
    [200, 'alive'],
    [201, 'alive'],
    [299, 'alive'],
    [404, 'dead'],
    [429, 'transient'],
    [503, 'transient'],
    [undefined, 'unknown'],
    [199, 'unknown'],
    [300, 'unknown'],
    [400, 'unknown'],
    [500, 'unknown'],
    [502, 'unknown'],
  ])('reads status %s as %s', (status, verdict) => {
    expect(classifyModelStatus(status)).toBe(verdict)
  })
})

describe('effectiveContext: a reported context is capped to the route window', () => {
  it('never widens the route', () => {
    expect(effectiveContext(2_000_000, 32_000)).toBe(32_000)
  })
  it('keeps a smaller reported number', () => {
    expect(effectiveContext(8_000, 32_000)).toBe(8_000)
  })
})

describe('nextProbation: the streak', () => {
  it('starts a new record at one on an alive day', () => {
    expect(nextProbation(undefined, 'm', 'alive', DAY1)).toEqual(probation('m', 1, DAY1))
  })
  it('counts a later alive day', () => {
    expect(nextProbation(probation('m', 1, DAY1), 'm', 'alive', DAY2)).toEqual(
      probation('m', 2, DAY2),
    )
  })
  it('counts two probes on one day once', () => {
    const record = probation('m', 2, DAY2)
    expect(nextProbation(record, 'm', 'alive', DAY2)).toBe(record)
  })
  it('earns nothing on a day earlier than the record (a clock gone back)', () => {
    const record = probation('m', 2, DAY3)
    expect(nextProbation(record, 'm', 'alive', DAY1)).toBe(record)
  })
  it('never counts above the promotion streak', () => {
    expect(nextProbation(probation('m', PROMOTION_STREAK, DAY1), 'm', 'alive', DAY2)).toEqual(
      probation('m', PROMOTION_STREAK, DAY2),
    )
  })
  it.each(['transient', 'unknown'] as const)('resets the streak on %s', (verdict) => {
    expect(nextProbation(probation('m', 2, DAY1), 'm', verdict, DAY2)).toEqual(
      probation('m', 0, DAY2),
    )
  })
  it('starts at zero when the first probe is not alive', () => {
    expect(nextProbation(undefined, 'm', 'unknown', DAY1)).toEqual(probation('m', 0, DAY1))
  })
})

describe('nextBusy: consecutive 429 days', () => {
  it('starts at one', () => {
    expect(nextBusy(undefined, 'm', true, DAY1)).toEqual(busy('m', 1, DAY1))
  })
  it('counts a later busy day', () => {
    expect(nextBusy(busy('m', 1, DAY1), 'm', true, DAY2)).toEqual(busy('m', 2, DAY2))
  })
  it('counts one day once', () => {
    const record = busy('m', 1, DAY2)
    expect(nextBusy(record, 'm', true, DAY2)).toBe(record)
  })
  it('earns nothing on an earlier day', () => {
    const record = busy('m', 1, DAY3)
    expect(nextBusy(record, 'm', true, DAY1)).toBe(record)
  })
  it('never counts above the limit', () => {
    expect(nextBusy(busy('m', BUSY_DEAD_DAYS, DAY1), 'm', true, DAY2)).toEqual(
      busy('m', BUSY_DEAD_DAYS, DAY2),
    )
  })
  it('ends the run on any other answer', () => {
    expect(nextBusy(busy('m', 2, DAY1), 'm', false, DAY2)).toBeUndefined()
  })
})

describe('applyProbeDay', () => {
  const base = { pinned: ['pinned'], probation: [], busy: [], today: DAY2 }

  it('promotes on the third alive day and only on that transition', () => {
    const first = applyProbeDay({
      ...base,
      answers: [{ model: 'new', verdict: 'alive', busy429: false }],
      probation: [probation('new', PROMOTION_STREAK - 1, DAY1)],
    })
    expect(first.probation).toEqual([probation('new', PROMOTION_STREAK, DAY2)])
    expect(first.promotedNow).toEqual(new Set(['new']))

    const again = applyProbeDay({
      ...base,
      today: DAY3,
      answers: [{ model: 'new', verdict: 'alive', busy429: false }],
      probation: first.probation,
    })
    expect(again.promotedNow).toEqual(new Set())
    expect(again.probation).toEqual([probation('new', PROMOTION_STREAK, DAY3)])
  })

  it('does not promote below the streak', () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'new', verdict: 'alive', busy429: false }],
    })
    expect(r.promotedNow.size).toBe(0)
    expect(r.probation).toEqual([probation('new', 1, DAY2)])
  })

  it('reads a state with no records as empty ones', () => {
    const r = applyProbeDay({ ...base, answers: [], probation: undefined, busy: undefined })
    expect(r.probation).toEqual([])
    expect(r.busy).toEqual([])
  })

  it("counts a busy day on the model's own record, not on the first one", () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'b', verdict: 'transient', busy429: true }],
      busy: [busy('a', BUSY_DEAD_DAYS - 1), busy('b', 1)],
    })
    expect(r.busy).toEqual([busy('a', BUSY_DEAD_DAYS - 1), busy('b', 2, DAY2)])
    expect(r.verdicts.get('b')).toBe('transient')
  })

  it("counts an alive day on the model's own record, not on the first one", () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'b', verdict: 'alive', busy429: false }],
      probation: [probation('a', PROMOTION_STREAK - 1), probation('b', 0)],
    })
    expect(r.probation).toEqual([probation('a', PROMOTION_STREAK - 1), probation('b', 1, DAY2)])
    expect(r.promotedNow.size).toBe(0)
  })

  it('keeps no probation record for a pinned model', () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'pinned', verdict: 'alive', busy429: false }],
    })
    expect(r.probation).toEqual([])
    expect(r.promotedNow.size).toBe(0)
    expect(r.verdicts.get('pinned')).toBe('alive')
  })

  it('drops both records of a dead model and keeps the other models', () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'gone', verdict: 'dead', busy429: false }],
      probation: [probation('gone', 2), probation('other', 1)],
      busy: [busy('gone', 1), busy('other', 1)],
    })
    expect(r.probation).toEqual([probation('other', 1)])
    expect(r.busy).toEqual([busy('other', 1)])
    expect(r.verdicts.get('gone')).toBe('dead')
  })

  it('records a busy day and resets the streak on a transient verdict', () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'm', verdict: 'transient', busy429: true }],
      probation: [probation('m', 2)],
    })
    expect(r.busy).toEqual([busy('m', 1, DAY2)])
    expect(r.probation).toEqual([probation('m', 0, DAY2)])
    expect(r.verdicts.get('m')).toBe('transient')
  })

  it('turns the third busy day into a dead verdict and drops the records', () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'm', verdict: 'transient', busy429: true }],
      probation: [probation('m', 2)],
      busy: [busy('m', BUSY_DEAD_DAYS - 1)],
    })
    expect(r.verdicts.get('m')).toBe('dead')
    expect(r.busy).toEqual([])
    expect(r.probation).toEqual([])
  })

  it('never reads a 503 as a busy day: 503 for three days is not dead', () => {
    const r = applyProbeDay({
      ...base,
      answers: [{ model: 'm', verdict: 'transient', busy429: false }],
      busy: [busy('m', BUSY_DEAD_DAYS - 1)],
    })
    expect(r.verdicts.get('m')).toBe('transient')
    expect(r.busy).toEqual([])
  })

  it('leaves a model with no probe today unchanged (a no-probe day)', () => {
    const records = [probation('idle', 2)]
    const busyRecords = [busy('idle', 2)]
    const r = applyProbeDay({ ...base, answers: [], probation: records, busy: busyRecords })
    expect(r.probation).toEqual(records)
    expect(r.busy).toEqual(busyRecords)
    expect(r.verdicts.size).toBe(0)
  })

  it('does not mutate the records it is given', () => {
    const records = [probation('m', 1)]
    const busyRecords = [busy('m', 1)]
    applyProbeDay({
      ...base,
      answers: [{ model: 'm', verdict: 'dead', busy429: false }],
      probation: records,
      busy: busyRecords,
    })
    expect(records).toEqual([probation('m', 1)])
    expect(busyRecords).toEqual([busy('m', 1)])
  })
})

describe('pickLiveModels (SR-H-1 order)', () => {
  const pick = (
    args: Partial<Parameters<typeof pickLiveModels>[0]> & {
      facts?: ReadonlyMap<string, ModelFacts>
    },
  ) =>
    pickLiveModels({
      current: [],
      candidates: [],
      facts: new Map(),
      promotedNow: new Set(),
      minContext: MIN_MANAGED_CONTEXT,
      ...args,
    })
  const alive = (context = 32_000): ModelFacts => ({ verdict: 'alive', context })

  it('puts a new alive candidate below every existing entry', () => {
    expect(
      pick({
        current: ['old-small', 'old-big'],
        candidates: ['new-huge'],
        facts: new Map([
          ['old-small', { verdict: 'transient', context: 16_000 }],
          ['old-big', alive()],
          ['new-huge', alive(1_000_000)],
        ]),
      }),
    ).toEqual(['old-small', 'old-big', 'new-huge'])
  })

  it('does not add a candidate with no facts at all', () => {
    expect(pick({ candidates: ['never-seen'] })).toEqual([])
  })

  it('removes a dead model', () => {
    expect(pick({ current: ['a', 'b'], facts: new Map([['a', { verdict: 'dead' }]]) })).toEqual([
      'b',
    ])
  })

  it('removes a model under the context floor', () => {
    expect(
      pick({
        current: ['small', 'big'],
        facts: new Map([
          ['small', { context: MIN_MANAGED_CONTEXT - 1 }],
          ['big', { context: MIN_MANAGED_CONTEXT }],
        ]),
      }),
    ).toEqual(['big'])
  })

  it('keeps a current model the listing and probes said nothing about', () => {
    expect(pick({ current: ['silent'] })).toEqual(['silent'])
  })

  it('never adds an unprobed candidate', () => {
    expect(
      pick({ candidates: ['unprobed'], facts: new Map([['unprobed', { context: 32_000 }]]) }),
    ).toEqual([])
  })

  it('never adds a dead or too-small candidate', () => {
    expect(
      pick({
        candidates: ['dead', 'small'],
        facts: new Map<string, ModelFacts>([
          ['dead', { verdict: 'dead', context: 32_000 }],
          ['small', { verdict: 'alive', context: MIN_MANAGED_CONTEXT - 1 }],
        ]),
      }),
    ).toEqual([])
  })

  it('does not add a candidate already in the list a second time', () => {
    expect(pick({ current: ['a'], candidates: ['a'], facts: new Map([['a', alive()]]) })).toEqual([
      'a',
    ])
  })

  it('orders candidates by status, then by context', () => {
    expect(
      pick({
        candidates: ['unknown-big', 'transient-big', 'alive-small', 'alive-big'],
        facts: new Map<string, ModelFacts>([
          ['unknown-big', { verdict: 'unknown', context: 900_000 }],
          ['transient-big', { verdict: 'transient', context: 900_000 }],
          ['alive-small', { verdict: 'alive', context: 20_000 }],
          ['alive-big', { verdict: 'alive', context: 40_000 }],
        ]),
      }),
    ).toEqual(['alive-big', 'alive-small', 'transient-big', 'unknown-big'])
  })

  it('sorts a candidate with no reported context last among equals', () => {
    expect(
      pick({
        candidates: ['none', 'some'],
        facts: new Map<string, ModelFacts>([
          ['none', { verdict: 'alive' }],
          ['some', { verdict: 'alive', context: 20_000 }],
        ]),
      }),
    ).toEqual(['some', 'none'])
    expect(
      pick({
        candidates: ['some', 'none'],
        facts: new Map<string, ModelFacts>([
          ['none', { verdict: 'alive' }],
          ['some', { verdict: 'alive', context: 20_000 }],
        ]),
      }),
    ).toEqual(['some', 'none'])
  })

  it('moves only a model promoted now above the older entries', () => {
    expect(
      pick({
        current: ['old', 'promoted', 'probation'],
        promotedNow: new Set(['promoted']),
      }),
    ).toEqual(['promoted', 'old', 'probation'])
  })

  it('caps the result at the list target', () => {
    const current = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(pick({ current })).toEqual(current.slice(0, MANAGED_LIST_TARGET))
  })

  it('applies the cap after the promoted move, so a promoted entry past the cap survives', () => {
    const current = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(pick({ current, promotedNow: new Set(['f']) })).toEqual(['f', 'a', 'b', 'c', 'd'])
  })

  it('does not reorder the list it is given', () => {
    const current = ['a', 'b']
    pick({ current, promotedNow: new Set(['b']) })
    expect(current).toEqual(['a', 'b'])
  })
})

describe('isPromoted (the reader rule)', () => {
  it('is true for a pinned model with no record', () => {
    expect(isPromoted('p', ['p'], [])).toBe(true)
  })
  it('is true for a record of a full streak', () => {
    expect(isPromoted('m', [], [probation('m', PROMOTION_STREAK)])).toBe(true)
  })
  it('is false for a record below the streak', () => {
    expect(isPromoted('m', [], [probation('m', PROMOTION_STREAK - 1)])).toBe(false)
  })
  it('is false for an entry absent from pinned with no record', () => {
    expect(isPromoted('m', ['p'], [probation('other', PROMOTION_STREAK)])).toBe(false)
  })
  it('is false for a state with no records', () => {
    expect(isPromoted('m', ['p'], undefined)).toBe(false)
  })
})

describe('pickGroqModels (SR-H-1)', () => {
  const pick = (args: Partial<Parameters<typeof pickGroqModels>[0]>) =>
    pickGroqModels({
      current: [],
      listing: [],
      routeWindow: 32_000,
      minContext: MIN_MANAGED_CONTEXT,
      ...args,
    })
  const live = (id: string, context = 32_000) => ({ id, context, active: true })

  it('keeps current ids still listed and active, in order', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-b', 'openai/gpt-oss-a'],
        listing: [live('openai/gpt-oss-a'), live('openai/gpt-oss-b')],
      }),
    ).toEqual(['openai/gpt-oss-b', 'openai/gpt-oss-a'])
  })

  it('removes an id no longer listed', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a', 'openai/gpt-oss-gone'],
        listing: [live('openai/gpt-oss-a')],
      }),
    ).toEqual(['openai/gpt-oss-a'])
  })

  it.each([[false], [undefined]])('removes a listed id whose active is %s', (active) => {
    expect(
      pick({
        current: ['openai/gpt-oss-a'],
        listing: [{ id: 'openai/gpt-oss-a', context: 32_000, active }],
      }),
    ).toEqual([])
  })

  it('removes an id under the floor, and keeps a current one with no reported context', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a', 'openai/gpt-oss-b'],
        listing: [
          live('openai/gpt-oss-a', MIN_MANAGED_CONTEXT - 1),
          { id: 'openai/gpt-oss-b', active: true },
        ],
      }),
    ).toEqual(['openai/gpt-oss-b'])
  })

  it('removes a current id with no reported context once the route window is under the floor', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a'],
        listing: [{ id: 'openai/gpt-oss-a', active: true }],
        routeWindow: MIN_MANAGED_CONTEXT - 1,
      }),
    ).toEqual([])
  })

  it('removes an inactive current id with no reported context', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a'],
        listing: [{ id: 'openai/gpt-oss-a', active: false }],
      }),
    ).toEqual([])
  })

  it('never adds an id with no reported context', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a'],
        listing: [live('openai/gpt-oss-a'), { id: 'openai/gpt-oss-120b', active: true }],
      }),
    ).toEqual(['openai/gpt-oss-a'])
  })

  it('keeps an id exactly at the floor', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a'],
        listing: [live('openai/gpt-oss-a', MIN_MANAGED_CONTEXT)],
      }),
    ).toEqual(['openai/gpt-oss-a'])
  })

  it('caps a reported context to the route window before the floor check', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a'],
        listing: [live('openai/gpt-oss-a', 2_000_000)],
        routeWindow: MIN_MANAGED_CONTEXT - 1,
      }),
    ).toEqual([])
  })

  it('adds at most one new id: the largest context inside the family, at the tail', () => {
    expect(
      pick({
        current: ['openai/gpt-oss-a'],
        listing: [
          live('openai/gpt-oss-a'),
          live('openai/gpt-oss-20b', 40_000),
          live('openai/gpt-oss-120b', 90_000),
          live('openai/gpt-oss-8b', 20_000),
        ],
      }),
    ).toEqual(['openai/gpt-oss-a', 'openai/gpt-oss-120b'])
  })

  it('never adds an id outside the checked-in family, whatever its context', () => {
    expect(pick({ listing: [live('meta-llama/llama-99', 9_000_000)] })).toEqual([])
  })

  it('keeps a current id outside the family: the family limits additions only', () => {
    expect(
      pick({ current: ['meta-llama/llama-99'], listing: [live('meta-llama/llama-99')] }),
    ).toEqual(['meta-llama/llama-99'])
  })

  it('does not add an inactive or too-small family id', () => {
    expect(
      pick({
        listing: [
          { id: 'openai/gpt-oss-a', context: 32_000, active: false },
          live('openai/gpt-oss-b', MIN_MANAGED_CONTEXT - 1),
        ],
      }),
    ).toEqual([])
  })

  it('caps the result at the list target', () => {
    const current = ['a', 'b', 'c', 'd', 'e'].map((x) => `openai/gpt-oss-${x}`)
    expect(
      pick({ current, listing: [...current.map((id) => live(id)), live('openai/gpt-oss-120b')] }),
    ).toEqual(current)
    expect(MANAGED_LIST_TARGET).toBe(current.length)
  })

  it.each<[string, string[]]>([
    ['first', ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']],
    ['last', ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']],
  ])('adds the largest context wherever the listing puts it (%s)', (_label, order) => {
    const context = (id: string) => (id === 'openai/gpt-oss-120b' ? 32_000 : 16_000)
    const listing = order.map((id) => live(id, context(id)))
    expect(pick({ current: [], listing })).toEqual(['openai/gpt-oss-120b'])
  })
})
