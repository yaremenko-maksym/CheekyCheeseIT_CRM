import { describe, expect, it } from 'vitest'
import {
  ALIVE,
  G1,
  G2,
  geminiListing,
  groqListing,
  limitedCap,
  managedDoc,
  NEW,
  NOON,
  noonOf,
  Q1,
  Q2,
  refreshWorld,
} from './__test-helpers__/refresh-world'
import {
  answer,
  countingCap,
  GEMINI,
  GROQ,
  KEY_MARKER,
  LOCAL,
  type Reply,
} from './__test-helpers__/router-harness'
import { MANAGED_LIST_TARGET } from './managed-models'
import { MIN_MANAGED_CONTEXT } from './model-picks'
import { runDailyModelRefresh } from './model-refresh'
import {
  EMPTY_ROUTE_STATE,
  markRetired,
  markSpent,
  PROMOTION_STREAK,
  providerDay,
  setStaleModels,
} from './state'

const BIG = 1_000_000
const WITH_NEW = geminiListing([
  [G1, BIG],
  [G2, BIG],
  [NEW, BIG],
])
const GEMINI_ONLY = [GEMINI, LOCAL]
const GROQ_ONLY = [GROQ, LOCAL]
const DAYS = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']

/** Runs the daily job once per listed day. */
async function runOn(w: ReturnType<typeof refreshWorld>, days: readonly string[]) {
  for (const day of days) {
    w.clock.ms = noonOf(day)
    await runDailyModelRefresh(w.deps)
  }
}
const streakOf = (w: ReturnType<typeof refreshWorld>, model: string) =>
  w.state.snapshot().probation?.find((r) => r.model === model)?.aliveStreak

describe('selection order (SR-H-1)', () => {
  it('appends a new large-context alive candidate below every existing entry', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
    const r = await runDailyModelRefresh(w.deps)
    expect(r).toEqual({
      ok: true,
      providers: [
        { provider: 'gemini', outcome: 'done' },
        { provider: 'groq', outcome: 'skipped', reason: 'UNCONFIGURED' },
      ],
    })
    expect(w.fileList('gemini')).toEqual([G1, G2, NEW])
    expect(w.chatModels()).toEqual([G1, G2, NEW])
    expect(w.ofType('MODEL_PROMOTED')).toEqual([])
    expect(w.ofType('MODEL_PROBED')).toEqual(
      [G1, G2, NEW].map((model) => ({
        type: 'MODEL_PROBED',
        provider: 'gemini',
        model,
        verdict: 'alive',
      })),
    )
  })

  it('a pinned model needs no probation record', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
    await runDailyModelRefresh(w.deps)
    expect(w.state.snapshot().probation).toEqual([
      { provider: 'gemini', model: NEW, aliveStreak: 1, lastProbeDay: '2026-11-04' },
    ])
  })

  it('caps a reported context at the route window before filtering and ranking', async () => {
    const A = 'gemini-4.0-flash'
    const B = 'gemini-5.0-flash'
    const C = 'gemini-6.0-flash'
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      // A and B tie once capped at 32 000: listing order holds, whatever B claims.
      listing: {
        gemini: geminiListing([
          [G1, BIG],
          [C, 20_000],
          [A, 64_000],
          [B, 10_000_000],
        ]),
      },
      managed: managedDoc({ gemini: [G1] }),
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, A, B, C])
    expect(w.fileList('gemini')).toEqual([G1, A, B, C])
  })

  it('a route window under the floor makes every model too small, whatever is reported', async () => {
    const w = refreshWorld({
      routes: [{ ...GEMINI, contextTokens: 15_999 }, LOCAL],
      listing: { gemini: WITH_NEW },
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, G2])
    expect(r.providers[0]).toEqual({
      provider: 'gemini',
      outcome: 'failed',
      reason: 'NOTHING_SURVIVED',
    })
  })

  it('a route window exactly at the floor still fits', async () => {
    const w = refreshWorld({
      routes: [{ ...GEMINI, contextTokens: 16_000 }, LOCAL],
      listing: { gemini: WITH_NEW },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('gemini')).toEqual([G1, G2, NEW])
  })

  it('takes a candidate reported exactly at the floor and leaves one just under it', async () => {
    const UNDER = 'gemini-4.0-flash'
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      listing: {
        gemini: geminiListing([
          [G1, BIG],
          [UNDER, 15_999],
          [NEW, 16_000],
        ]),
      },
      managed: managedDoc({ gemini: [G1] }),
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, NEW])
    expect(w.fileList('gemini')).toEqual([G1, NEW])
  })

  it('removes a current model reported under the floor', async () => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      listing: {
        gemini: geminiListing([
          [G1, BIG],
          [G2, 15_999],
        ]),
      },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('gemini')).toEqual([G1])
  })

  it('never adds a candidate that reports no context, and keeps a current one that does not', async () => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      listing: { gemini: geminiListing([[G1], [G2, BIG], [NEW]]) },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, G2])
    expect(w.fileList('gemini')).toEqual([G1, G2])
  })

  it('keeps a current model the listing does not mention while its probe is alive', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: geminiListing([[G1, BIG]]) } })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('gemini')).toEqual([G1, G2])
  })

  it('keeps the list at its target', async () => {
    const extra = Array.from({ length: 4 }, (_, i) => `gemini-${i + 4}.0-flash`)
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      listing: { gemini: geminiListing([G1, G2, ...extra].map((id) => [id, BIG] as const)) },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('gemini')).toHaveLength(MANAGED_LIST_TARGET)
    expect(w.fileList('gemini')?.slice(0, 2)).toEqual([G1, G2])
  })
})

describe('promotion only after N consecutive alive days (SR-M-9)', () => {
  it('moves up on the day the streak fills, says so once, and stays', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
    await runOn(w, DAYS.slice(0, PROMOTION_STREAK - 1))
    expect(w.fileList('gemini')).toEqual([G1, G2, NEW])
    expect(w.ofType('MODEL_PROMOTED')).toEqual([])
    await runOn(w, [DAYS[PROMOTION_STREAK - 1]!])
    expect(w.fileList('gemini')).toEqual([NEW, G1, G2])
    expect(w.ofType('MODEL_PROMOTED')).toEqual([
      { type: 'MODEL_PROMOTED', provider: 'gemini', model: NEW },
    ])
    await runOn(w, [DAYS[PROMOTION_STREAK]!])
    expect(w.fileList('gemini')).toEqual([NEW, G1, G2])
    expect(w.ofType('MODEL_PROMOTED')).toHaveLength(1)
  })

  it.each<[string, Reply]>([
    ['a transient 503', { status: 503, body: 'x' }],
    ['a transient 429', { status: 429, body: 'x' }],
    ['an unknown 500', { status: 500, body: 'x' }],
    ['no response at all', 'network'],
  ])('%s resets the streak without removing the model', async (_label, reply) => {
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
    await runOn(w, DAYS.slice(0, 2))
    expect(streakOf(w, NEW)).toBe(2)
    w.net.chat = (s) => (s.model === NEW ? reply : ALIVE)
    await runOn(w, [DAYS[2]!])
    expect(streakOf(w, NEW)).toBe(0)
    expect(w.fileList('gemini')).toEqual([G1, G2, NEW])
    w.net.chat = () => ALIVE
    await runOn(w, [DAYS[3]!])
    expect(streakOf(w, NEW)).toBe(1)
    expect(w.ofType('MODEL_PROMOTED')).toEqual([])
  })

  it('two probes on one day count once', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
    await runOn(w, [DAYS[0]!, DAYS[0]!])
    expect(streakOf(w, NEW)).toBe(1)
  })

  const lastProbedYesterday = (model: string, aliveStreak = PROMOTION_STREAK - 1) => ({
    provider: 'gemini' as const,
    model,
    aliveStreak,
    lastProbeDay: '2026-11-03',
  })

  it('says nothing for a model that filled its streak but left the list', async () => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      listing: {
        gemini: geminiListing([
          [G1, BIG],
          [NEW, MIN_MANAGED_CONTEXT - 1],
        ]),
      },
      managed: managedDoc({ gemini: [G1, NEW] }),
      state: { ...EMPTY_ROUTE_STATE, probation: [lastProbedYesterday(NEW)] },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, NEW])
    expect(w.fileList('gemini')).toEqual([G1])
    expect(w.ofType('MODEL_PROMOTED')).toEqual([])
  })

  it('a sweep stopped by AUTH keeps the record of an entry the pick would have pushed out', async () => {
    const [a, b, c, d, e, promoted, last] = [
      'gemini-4.0-flash',
      'gemini-5.0-flash',
      'gemini-6.0-flash',
      'gemini-7.0-flash',
      'gemini-8.0-flash',
      'gemini-9.0-flash',
      'gemini-10.0-flash',
    ] as const
    const current = [a, b, c, d, e]
    const record = lastProbedYesterday(e, 1)
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      // `e` is no longer listed, so only the unchanged list vouches for its record.
      listing: {
        gemini: geminiListing([a, b, c, d, promoted, last].map((id) => [id, BIG])),
      },
      managed: managedDoc({ gemini: current }),
      state: { ...EMPTY_ROUTE_STATE, probation: [record, lastProbedYesterday(promoted)] },
      hadOkCall: (_p, m) => (current as string[]).includes(m),
      chat: (s) => (s.model === last ? { status: 401, body: 'x' } : ALIVE),
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([promoted, last])
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'AUTH' })
    expect(w.state.snapshot().probation).toContainEqual(record)
    expect(w.fileList('gemini')).toEqual(current)
  })

  describe('a no-probe day leaves the streak where it was', () => {
    const before = {
      ...EMPTY_ROUTE_STATE,
      probation: [
        { provider: 'gemini' as const, model: NEW, aliveStreak: 2, lastProbeDay: '2026-11-03' },
      ],
    }
    const managed = managedDoc({ gemini: [G1, G2, NEW] })
    const start = { routes: GEMINI_ONLY, listing: { gemini: WITH_NEW }, managed, state: before }

    it('the cap refuses before the listing: no request at all', async () => {
      const w = refreshWorld({ ...start, cap: countingCap(false) })
      const r = await runDailyModelRefresh(w.deps)
      expect(w.sent).toEqual([])
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'CAP' })
      expect(w.state.snapshot().probation).toEqual(before.probation)
      expect(w.fileText()).toBe(managed)
    })

    it('the cap refuses the probe: the listing is all that goes out', async () => {
      const w = refreshWorld({ ...start, cap: limitedCap(1) })
      const r = await runDailyModelRefresh(w.deps)
      expect(w.chats()).toEqual([])
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'CAP' })
      expect(w.state.snapshot().probation).toEqual(before.probation)
      expect(w.fileText()).toBe(managed)
    })

    it('the provider is not configured', async () => {
      const w = refreshWorld({ ...start, routes: GROQ_ONLY })
      await runDailyModelRefresh(w.deps)
      expect(w.state.snapshot().probation).toEqual(before.probation)
    })

    it('an OK call since the last refresh spares the model its probe', async () => {
      const w = refreshWorld({ ...start, hadOkCall: (_p, model) => model === NEW })
      await runDailyModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G1, G2])
      expect(w.state.snapshot().probation).toEqual(before.probation)
    })

    it('a model spent today gets no probe', async () => {
      const spent = markSpent('gemini', NEW, providerDay('gemini', NOON))(before)
      const w = refreshWorld({ ...start, state: spent })
      await runDailyModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G1, G2])
      expect(w.state.snapshot().probation).toEqual(before.probation)
      expect(w.fileList('gemini')).toEqual([G1, G2, NEW])
    })

    it('a model spent another day is probed', async () => {
      const spent = markSpent('gemini', NEW, providerDay('gemini', NOON - 86_400_000))(before)
      const w = refreshWorld({ ...start, state: spent })
      await runDailyModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G1, G2, NEW])
    })

    it('an OK call of the other provider spares nothing here', async () => {
      const w = refreshWorld({ ...start, hadOkCall: (p) => p === 'groq' })
      await runDailyModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G1, G2, NEW])
    })
  })

  it('a sweep the cap cut short keeps the probe days already made and the file', async () => {
    const SECOND = 'gemini-4.0-flash'
    const managed = managedDoc({ gemini: [G1] })
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      cap: limitedCap(3),
      managed,
      listing: {
        gemini: geminiListing([
          [G1, BIG],
          [NEW, BIG],
          [SECOND, BIG],
        ]),
      },
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, NEW])
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'CAP' })
    expect(streakOf(w, NEW)).toBe(1)
    expect(w.fileText()).toBe(managed)
  })

  describe('a promotion counts only once the list moved (CR-M-1)', () => {
    const FILLING = DAYS.slice(0, PROMOTION_STREAK - 1)
    const FILL_DAY = DAYS[PROMOTION_STREAK - 1]!
    const RETRY_DAY = DAYS[PROMOTION_STREAK]!
    const LATER = 'gemini-4.0-flash'
    const onProbation = {
      ...EMPTY_ROUTE_STATE,
      probation: [
        {
          provider: 'gemini' as const,
          model: NEW,
          aliveStreak: PROMOTION_STREAK - 1,
          lastProbeDay: '2026-11-03',
        },
      ],
    }
    const withLater = geminiListing([
      [G1, BIG],
      [G2, BIG],
      [NEW, BIG],
      [LATER, BIG],
    ])
    const managed = managedDoc({ gemini: [G1, G2, NEW] })

    it('a failed write on the filling day is reported, and the next alive day retries it', async () => {
      const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
      await runOn(w, FILLING)
      const onDisk = w.fileText()
      w.fs.failAt = 'rename'
      w.clock.ms = noonOf(FILL_DAY)
      const r = await runDailyModelRefresh(w.deps)
      expect(r.ok).toBe(false)
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'WRITE' })
      expect(w.storeEvents).toContainEqual({ type: 'STATE_WRITE_FAILED', store: 'managed-list' })
      expect(w.ofType('MODEL_REFRESH_FAILED')).toEqual([
        { type: 'MODEL_REFRESH_FAILED', job: 'daily' },
      ])
      expect(w.state.snapshot().failedJobs).toEqual(['daily'])
      expect(w.ofType('MODEL_PROMOTED')).toEqual([])
      expect(w.fileText()).toBe(onDisk)
      expect(streakOf(w, NEW)).toBe(PROMOTION_STREAK - 1)

      w.fs.failAt = undefined
      await runOn(w, [RETRY_DAY])
      expect(w.fileList('gemini')).toEqual([NEW, G1, G2])
      expect(w.ofType('MODEL_PROMOTED')).toEqual([
        { type: 'MODEL_PROMOTED', provider: 'gemini', model: NEW },
      ])
      expect(streakOf(w, NEW)).toBe(PROMOTION_STREAK)
      expect(w.state.snapshot().failedJobs).toEqual([])
    })

    it('a re-run on the failed day earns nothing: the retry waits for the next probe day', async () => {
      const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
      await runOn(w, FILLING)
      w.fs.failAt = 'rename'
      await runOn(w, [FILL_DAY])
      w.fs.failAt = undefined
      await runOn(w, [FILL_DAY])
      expect(w.fileList('gemini')).toEqual([G1, G2, NEW])
      expect(w.ofType('MODEL_PROMOTED')).toEqual([])
    })

    it('a full list still takes the candidate whose filling day failed to write', async () => {
      const [x, y, z] = ['gemini-5.0-flash', 'gemini-6.0-flash', 'gemini-7.0-flash'] as const
      const full = [G1, G2, x, y, z]
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        listing: { gemini: geminiListing([...full, NEW].map((id) => [id, BIG])) },
        managed: managedDoc({ gemini: full }),
        state: {
          ...EMPTY_ROUTE_STATE,
          probation: [x, y, z].map((model) => ({
            provider: 'gemini' as const,
            model,
            aliveStreak: PROMOTION_STREAK,
            lastProbeDay: '2026-11-03',
          })),
        },
      })
      await runOn(w, FILLING)
      expect(w.fileList('gemini')).toEqual(full)
      w.fs.failAt = 'rename'
      await runOn(w, [FILL_DAY])
      w.fs.failAt = undefined
      await runOn(w, [RETRY_DAY])
      expect(w.fileList('gemini')).toEqual([NEW, G1, G2, x, y])
      expect(w.ofType('MODEL_PROMOTED')).toEqual([
        { type: 'MODEL_PROMOTED', provider: 'gemini', model: NEW },
      ])
    })

    it('a run the cap stopped after the filling probe holds the promotion back', async () => {
      const cap = limitedCap(4)
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        cap,
        managed,
        state: onProbation,
        listing: { gemini: withLater },
      })
      const r = await runDailyModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G1, G2, NEW])
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'CAP' })
      expect(streakOf(w, NEW)).toBe(PROMOTION_STREAK - 1)
      expect(w.ofType('MODEL_PROMOTED')).toEqual([])
      expect(w.fileText()).toBe(managed)

      cap.reserve = countingCap().reserve
      w.clock.ms = NOON + 86_400_000
      await runDailyModelRefresh(w.deps)
      expect(w.fileList('gemini')?.[0]).toBe(NEW)
      expect(w.ofType('MODEL_PROMOTED')).toHaveLength(1)
    })

    it('a run AUTH stopped after the filling probe holds the promotion back', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        managed,
        state: onProbation,
        listing: { gemini: withLater },
        chat: (s) => (s.model === LATER ? { status: 401, body: 'x' } : ALIVE),
      })
      const r = await runDailyModelRefresh(w.deps)
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'AUTH' })
      expect(streakOf(w, NEW)).toBe(PROMOTION_STREAK - 1)
      expect(w.ofType('MODEL_PROMOTED')).toEqual([])
      expect(w.fileText()).toBe(managed)

      w.net.chat = () => ALIVE
      w.clock.ms = NOON + 86_400_000
      await runDailyModelRefresh(w.deps)
      expect(w.fileList('gemini')?.[0]).toBe(NEW)
      expect(w.ofType('MODEL_PROMOTED')).toHaveLength(1)
    })

    /** Lets every state write through but the `nth` (1-based), which the store refuses. */
    const refusingUpdate = (w: ReturnType<typeof refreshWorld>, nth: number) => {
      let n = 0
      return {
        ...w.deps,
        state: {
          snapshot: w.state.snapshot,
          update: async (change: Parameters<typeof w.state.update>[0]) => {
            n += 1
            return n === nth ? false : w.state.update(change)
          },
        },
      }
    }

    it('a refused record write reports the provider failed, never done', async () => {
      const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
      const r = await runDailyModelRefresh(refusingUpdate(w, 1))
      expect(r.ok).toBe(false)
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'WRITE' })
      expect(w.state.snapshot().failedJobs).toEqual(['daily'])
      expect(w.ofType('MODEL_REFRESH_FAILED')).toHaveLength(1)
    })

    it('a refused clearing of the retirements reports the provider failed, never done', async () => {
      const retired = markRetired('gemini', G2, NOON)(EMPTY_ROUTE_STATE)
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        listing: { gemini: WITH_NEW },
        state: retired,
      })
      const r = await runDailyModelRefresh(refusingUpdate(w, 2))
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'WRITE' })
      expect(w.state.snapshot().providers).toEqual(retired.providers)
    })

    it('a refused clearing on Groq, which keeps no records, reports the provider failed', async () => {
      const w = refreshWorld({ routes: GROQ_ONLY })
      const r = await runDailyModelRefresh(refusingUpdate(w, 1))
      expect(r.providers[1]).toEqual({ provider: 'groq', outcome: 'failed', reason: 'WRITE' })
    })

    it('a refused record write after a moved list still says the list moved', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        managed,
        state: onProbation,
        listing: { gemini: WITH_NEW },
      })
      await runDailyModelRefresh(refusingUpdate(w, 1))
      expect(w.fileList('gemini')).toEqual([NEW, G1, G2])
      expect(w.ofType('MODEL_PROMOTED')).toHaveLength(1)
    })

    it('a promotion the pick left out of the list announces nothing', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        managed,
        state: onProbation,
        listing: {
          gemini: geminiListing([
            [G1, BIG],
            [G2, BIG],
            [NEW, MIN_MANAGED_CONTEXT - 1],
          ]),
        },
      })
      await runDailyModelRefresh(w.deps)
      expect(w.fileList('gemini')).toEqual([G1, G2])
      expect(w.ofType('MODEL_PROMOTED')).toEqual([])
    })
  })
})

describe('Groq additions', () => {
  it('adds the largest-context family model, never probing or promoting it', async () => {
    const w = refreshWorld({
      routes: [{ ...GROQ, models: [Q2] }, LOCAL],
      listing: {
        groq: groqListing([
          [Q2, 131_072],
          [Q1, 262_144],
        ]),
      },
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(r.ok).toBe(true)
    expect(w.fileList('groq')).toEqual([Q2, Q1])
    expect(w.chats()).toEqual([])
    expect(w.ofType('MODEL_PROMOTED')).toEqual([])
    expect(w.state.snapshot().probation).toBeUndefined()
  })

  it('removes a current model the listing marks inactive', async () => {
    const w = refreshWorld({
      routes: GROQ_ONLY,
      listing: {
        groq: groqListing([
          [Q1, 131_072, false],
          [Q2, 131_072],
        ]),
      },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('groq')).toEqual([Q2])
  })

  it('applies the route window to a Groq entry too', async () => {
    const w = refreshWorld({
      routes: [{ ...GROQ, contextTokens: 15_999 }, LOCAL],
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(r.providers[1]).toEqual({
      provider: 'groq',
      outcome: 'failed',
      reason: 'NOTHING_SURVIVED',
    })
  })
})

describe('what a probe proves', () => {
  it.each<[string, Reply]>([
    ['a 404 naming the model', { status: 404, body: `{"error":{"message":"${G2} not found"}}` }],
    ['a bare 404', { status: 404, body: 'x' }],
    ['a 2xx served by a successor', answer({ ok: true }, { model: 'gemini-2.6-flash' })],
  ])('%s removes the model', async (_label, reply) => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      chat: (s) => (s.model === G2 ? reply : ALIVE),
    })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('gemini')).toEqual([G1])
    expect(w.ofType('MODEL_PROBED')[1]).toEqual({
      type: 'MODEL_PROBED',
      provider: 'gemini',
      model: G2,
      verdict: 'dead',
    })
  })

  it('a dead model loses its probation record', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: WITH_NEW } })
    await runOn(w, [DAYS[0]!])
    w.net.chat = (s) => (s.model === NEW ? { status: 404, body: 'x' } : ALIVE)
    await runOn(w, [DAYS[1]!])
    expect(w.fileList('gemini')).toEqual([G1, G2])
    expect(w.state.snapshot().probation).toEqual([])
  })

  const busy: Reply = { status: 429, body: '{"error":{"code":429}}' }

  it('three consecutive busy days remove a model; two do not', async () => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      chat: (s) => (s.model === G2 ? busy : ALIVE),
    })
    await runOn(w, DAYS.slice(0, 2))
    expect(w.fileList('gemini')).toEqual([G1, G2])
    expect(w.state.snapshot().busy?.[0]?.busyDays).toBe(2)
    await runOn(w, [DAYS[2]!])
    expect(w.fileList('gemini')).toEqual([G1])
    expect(w.state.snapshot().busy).toEqual([])
    expect(w.state.snapshot().busyDead).toEqual([
      { provider: 'gemini', model: G2, day: '2026-11-06' },
    ])
  })

  describe('a busy-dead verdict persists (CR-H-1)', () => {
    /** Consecutive UTC days from 2026-11-04. */
    const daysFrom = (start: number, count: number): string[] =>
      Array.from({ length: count }, (_, i) =>
        new Date(Date.UTC(2026, 10, 4 + start + i)).toISOString().slice(0, 10),
      )
    /** Runs one day at a time and collects the file's list after each. */
    const listsOver = async (w: ReturnType<typeof refreshWorld>, days: readonly string[]) => {
      const lists: string[][] = []
      for (const day of days) {
        await runOn(w, [day])
        lists.push(w.fileList('gemini') as string[])
      }
      return lists
    }

    it('a model busy every day leaves once and does not flap back, past day 10', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        chat: (s) => (s.model === G2 ? busy : ALIVE),
      })
      const lists = await listsOver(w, daysFrom(0, 12))
      expect(lists.slice(0, 2)).toEqual([
        [G1, G2],
        [G1, G2],
      ])
      for (const list of lists.slice(2)) expect(list).toEqual([G1])
      expect(await w.deps.managedModels('gemini', GEMINI.models)).toEqual([G1])
    })

    it('a held model is not probed inside the 7 days, and is on day 7', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        chat: (s) => (s.model === G2 ? busy : ALIVE),
      })
      await runOn(w, daysFrom(0, 3))
      const before = w.chatModels().filter((m) => m === G2).length
      await runOn(w, daysFrom(3, 6))
      expect(w.chatModels().filter((m) => m === G2)).toHaveLength(before)
      await runOn(w, daysFrom(9, 1))
      expect(w.chatModels().filter((m) => m === G2)).toHaveLength(before + 1)
    })

    it('a re-probe still busy restamps the verdict: the next one is 7 days on', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        chat: (s) => (s.model === G2 ? busy : ALIVE),
      })
      await runOn(w, daysFrom(0, 10))
      const before = w.chatModels().filter((m) => m === G2).length
      expect(w.state.snapshot().busyDead).toEqual([
        { provider: 'gemini', model: G2, day: daysFrom(9, 1)[0] },
      ])
      expect(w.fileList('gemini')).toEqual([G1])
      await runOn(w, daysFrom(10, 6))
      expect(w.chatModels().filter((m) => m === G2)).toHaveLength(before)
      await runOn(w, daysFrom(16, 1))
      expect(w.chatModels().filter((m) => m === G2)).toHaveLength(before + 1)
    })

    it('a held candidate recovers on a non-busy alive re-probe, below the existing entries', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        listing: { gemini: WITH_NEW },
        chat: (s) => (s.model === NEW ? busy : ALIVE),
      })
      await runOn(w, daysFrom(0, 3))
      expect(w.fileList('gemini')).toEqual([G1, G2])
      expect(w.state.snapshot().busyDead?.map((r) => r.model)).toEqual([NEW])
      w.net.chat = () => ALIVE
      await runOn(w, daysFrom(3, 6))
      expect(w.fileList('gemini')).toEqual([G1, G2])
      await runOn(w, daysFrom(9, 1))
      expect(w.fileList('gemini')).toEqual([G1, G2, NEW])
      expect(w.state.snapshot().busyDead).toEqual([])
      expect(w.state.snapshot().probation).toEqual([
        { provider: 'gemini', model: NEW, aliveStreak: 0, lastProbeDay: daysFrom(9, 1)[0] },
      ])
    })

    it('a held pinned model recovers with no probation record', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        chat: (s) => (s.model === G2 ? busy : ALIVE),
      })
      await runOn(w, daysFrom(0, 3))
      w.net.chat = () => ALIVE
      await runOn(w, daysFrom(3, 7))
      expect(w.fileList('gemini')).toEqual([G1, G2])
      expect(w.state.snapshot().busyDead).toEqual([])
      expect(w.state.snapshot().probation).toEqual([])
    })

    it('a held candidate gives its slot to the next eligible one on a full list', async () => {
      const full = ['gemini-5.0-flash', 'gemini-6.0-flash', 'gemini-7.0-flash', G1, G2]
      const held = 'gemini-9.0-pro'
      const listed = geminiListing([
        ...full.map((id): [string, number] => [id, BIG]),
        [held, BIG],
        [NEW, BIG],
      ])
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        listing: { gemini: listed },
        managed: managedDoc({ gemini: full }),
        chat: (s) => (s.model === held ? busy : ALIVE),
      })
      await runOn(w, daysFrom(0, 3))
      expect(w.state.snapshot().busyDead?.map((r) => r.model)).toEqual([held])
      const before = w.chatModels().length
      await runOn(w, daysFrom(3, 1))
      expect(w.chatModels().slice(before)).toEqual([...full, NEW])
    })

    it('a held re-probe waits behind every other candidate', async () => {
      const full = ['gemini-5.0-flash', 'gemini-6.0-flash', 'gemini-7.0-flash', G1, G2]
      const held = 'gemini-9.0-pro'
      const listed = geminiListing([
        ...full.map((id): [string, number] => [id, BIG]),
        [held, BIG],
        [NEW, BIG],
      ])
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        listing: { gemini: listed },
        managed: managedDoc({ gemini: full }),
        state: {
          ...EMPTY_ROUTE_STATE,
          busyDead: [{ provider: 'gemini', model: held, day: '2026-10-01' }],
        },
      })
      await runOn(w, [DAYS[0]!])
      // The reader serves pinned ids first, so this is the probe order of `full`.
      expect(w.chatModels()).toEqual([G1, G2, ...full.slice(0, 3), NEW])
      expect(w.state.snapshot().busyDead?.map((r) => r.day)).toEqual(['2026-10-01'])
    })

    it('a delisted model loses its verdict', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        listing: { gemini: WITH_NEW },
        state: {
          ...EMPTY_ROUTE_STATE,
          busyDead: [{ provider: 'gemini', model: 'gemini-9.0-pro', day: DAYS[0]! }],
        },
      })
      await runOn(w, [DAYS[0]!])
      expect(w.state.snapshot().busyDead).toEqual([])
    })

    it('a verdict reached on a run the cap stopped still persists', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        chat: (s) => (s.model === G1 ? busy : ALIVE),
        // One unit for the listing, one for G1's probe; the next probe is refused.
        cap: limitedCap(2),
        state: {
          ...EMPTY_ROUTE_STATE,
          busy: [{ provider: 'gemini', model: G1, busyDays: 2, lastProbeDay: '2026-11-03' }],
        },
      })
      await runOn(w, [DAYS[0]!])
      expect(w.chatModels()).toEqual([G1])
      expect(w.state.snapshot().busyDead?.map((r) => r.model)).toEqual([G1])
    })
  })

  it('an answer other than a busy 429 ends the run of busy days', async () => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      chat: (s) => (s.model === G2 ? busy : ALIVE),
    })
    await runOn(w, DAYS.slice(0, 2))
    w.net.chat = () => ALIVE
    await runOn(w, [DAYS[2]!])
    expect(w.state.snapshot().busy).toEqual([])
    w.net.chat = (s) => (s.model === G2 ? busy : ALIVE)
    await runOn(w, DAYS.slice(3, 5))
    expect(w.fileList('gemini')).toEqual([G1, G2])
  })

  it.each<[string, Reply]>([
    ['503', { status: 503, body: 'x' }],
    [
      'a per-day 429',
      {
        status: 429,
        body: JSON.stringify({
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GenerateRequestsPerDay' }],
              },
            ],
          },
        }),
      },
    ],
  ])('three days of %s are not the three-day rule', async (_label, reply) => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      chat: (s) => (s.model === G2 ? reply : ALIVE),
    })
    await runOn(w, DAYS.slice(0, 3))
    expect(w.fileList('gemini')).toEqual([G1, G2])
    expect(w.state.snapshot().busy).toEqual([])
  })

  it('keeps records of listed or kept models and forgets the rest', async () => {
    const GONE = 'gemini-9.0-flash'
    const LISTED = 'gemini-8.0-flash'
    const record = (model: string) => ({
      provider: 'gemini' as const,
      model,
      aliveStreak: 1,
      lastProbeDay: '2026-11-01',
    })
    const busyRecord = (model: string) => ({
      provider: 'gemini' as const,
      model,
      busyDays: 1,
      lastProbeDay: '2026-11-01',
    })
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: {
        ...EMPTY_ROUTE_STATE,
        probation: [record(GONE), record(LISTED)],
        busy: [busyRecord(GONE), busyRecord(LISTED)],
      },
      hadOkCall: () => true,
      listing: {
        gemini: geminiListing([
          [G1, BIG],
          [LISTED, 100],
        ]),
      },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.state.snapshot().probation).toEqual([record(LISTED)])
    expect(w.state.snapshot().busy).toEqual([busyRecord(LISTED)])
  })

  it('at the record cap, the records of list entries outlive those of mere candidates', async () => {
    const [a, b, c, d, e, f] = [4, 5, 6, 7, 8, 9].map((n) => `gemini-${n}.0-flash`) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const record = (model: string) => ({
      provider: 'gemini' as const,
      model,
      aliveStreak: 1,
      lastProbeDay: '2026-11-01',
    })
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      managed: managedDoc({ gemini: [G1, G2, a, b, c] }),
      state: { ...EMPTY_ROUTE_STATE, probation: [a, b, c, d, e].map(record) },
      // Only `f` is probed, so it lands behind every older record.
      hadOkCall: (_p, m) => m !== f,
      listing: { gemini: geminiListing([G1, G2, a, b, c, d, e, f].map((id) => [id, BIG])) },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('gemini')).toEqual([G1, G2, a, b, c])
    expect(w.state.snapshot().probation?.map((r) => r.model)).toEqual([e, f, a, b, c])
  })
})

describe('never wipe (SR-M-6)', () => {
  const managed = managedDoc({ gemini: [G1, G2], groq: [Q1, Q2] })
  const failures: [string, Reply][] = [
    ['a 500', { status: 500, body: 'x' }],
    ['a 401', { status: 401, body: 'x' }],
    ['a dropped connection', 'network'],
    ['a garbage body', { status: 200, body: 'nope' }],
  ]

  it.each(failures)(
    'a listing failing with %s leaves the file byte-identical',
    async (_l, reply) => {
      const w = refreshWorld({ managed, listing: { gemini: reply, groq: reply } })
      const r = await runDailyModelRefresh(w.deps)
      expect(w.fileText()).toBe(managed)
      expect(w.chats()).toEqual([])
      expect(r.ok).toBe(false)
    },
  )

  it.each(failures)('a failed listing with %s creates no file either', async (_l, reply) => {
    const w = refreshWorld({ listing: { gemini: reply, groq: reply } })
    await runDailyModelRefresh(w.deps)
    expect(w.fileText()).toBeUndefined()
  })

  it('reads a 401 as AUTH and any other listing failure as LISTING', async () => {
    const w = refreshWorld({
      listing: { gemini: { status: 401, body: 'x' }, groq: { status: 500, body: 'x' } },
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(r.providers).toEqual([
      { provider: 'gemini', outcome: 'failed', reason: 'AUTH' },
      { provider: 'groq', outcome: 'failed', reason: 'LISTING' },
    ])
  })

  it('AUTH on a probe stops the sweep and leaves the file byte-identical', async () => {
    const w = refreshWorld({
      managed,
      routes: GEMINI_ONLY,
      chat: (s) => (s.model === G1 ? ALIVE : { status: 401, body: 'x' }),
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, G2])
    expect(w.fileText()).toBe(managed)
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'AUTH' })
    expect(w.ofType('MODEL_PROBED')).toHaveLength(1)
  })

  it('every model dead: nothing survives and the file stays byte-identical', async () => {
    const w = refreshWorld({
      managed,
      routes: GEMINI_ONLY,
      chat: () => ({ status: 404, body: 'x' }),
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(r.providers[0]).toEqual({
      provider: 'gemini',
      outcome: 'failed',
      reason: 'NOTHING_SURVIVED',
    })
    expect(w.fileText()).toBe(managed)
  })

  it('an empty Groq listing: nothing survives and the file stays byte-identical', async () => {
    const w = refreshWorld({ managed, routes: GROQ_ONLY, listing: { groq: groqListing([]) } })
    const r = await runDailyModelRefresh(w.deps)
    expect(r.providers[1]).toEqual({
      provider: 'groq',
      outcome: 'failed',
      reason: 'NOTHING_SURVIVED',
    })
    expect(w.fileText()).toBe(managed)
  })

  it('a failed write is reported and the previous file stays', async () => {
    const w = refreshWorld({ managed, routes: GROQ_ONLY })
    w.fs.failAt = 'rename'
    const r = await runDailyModelRefresh(w.deps)
    expect(r.providers[1]).toEqual({ provider: 'groq', outcome: 'failed', reason: 'WRITE' })
    expect(w.fileText()).toBe(managed)
  })

  it('an invalid file reads as the pinned fallback and a refresh replaces it', async () => {
    const w = refreshWorld({ managed: '{', routes: GROQ_ONLY })
    await runDailyModelRefresh(w.deps)
    expect(w.fileList('groq')).toEqual([Q1, Q2])
  })
})

describe('per-provider reset (SR-M-5)', () => {
  const bothRetired = markRetired(
    'groq',
    Q1,
    NOON,
  )(markRetired('gemini', G1, NOON)(EMPTY_ROUTE_STATE))
  const retiredProviders = (w: ReturnType<typeof refreshWorld>) =>
    w.state.snapshot().retired.map((e) => e.provider)

  it('Gemini failing does not stop Groq clearing its own retirements', async () => {
    const w = refreshWorld({
      state: bothRetired,
      listing: { gemini: { status: 500, body: 'x' } },
    })
    const r = await runDailyModelRefresh(w.deps)
    expect(retiredProviders(w)).toEqual(['gemini'])
    expect(r.ok).toBe(false)
  })

  it('Groq failing leaves its retirements and Gemini clears its own', async () => {
    const w = refreshWorld({
      state: bothRetired,
      listing: { groq: { status: 500, body: 'x' } },
    })
    await runDailyModelRefresh(w.deps)
    expect(retiredProviders(w)).toEqual(['groq'])
  })

  it('an exception in one provider stops neither the next nor the report', async () => {
    const w = refreshWorld({ state: bothRetired })
    const read = w.deps.managedModels
    w.deps.managedModels = async (p, fallback) => {
      if (p === 'gemini') throw new Error('boom')
      return read(p, fallback)
    }
    const r = await runDailyModelRefresh(w.deps)
    expect(r).toEqual({
      ok: false,
      providers: [
        { provider: 'gemini', outcome: 'failed', reason: 'INTERNAL' },
        { provider: 'groq', outcome: 'done' },
      ],
    })
    expect(retiredProviders(w)).toEqual(['gemini'])
  })

  it('an unconfigured provider is skipped, not failed', async () => {
    const w = refreshWorld({ routes: GROQ_ONLY })
    const r = await runDailyModelRefresh(w.deps)
    expect(r.ok).toBe(true)
    expect(w.ofType('MODEL_REFRESH_FAILED')).toEqual([])
    expect(w.state.snapshot().failedJobs).toEqual([])
  })

  it('a key that reached the job empty is skipped with no request', async () => {
    const w = refreshWorld()
    w.deps.config = {
      ...w.deps.config,
      routes: w.deps.config.routes.map((r) => (r.provider === 'gemini' ? { ...r, apiKey: '' } : r)),
    }
    const r = await runDailyModelRefresh(w.deps)
    expect(r.providers[0]).toEqual({
      provider: 'gemini',
      outcome: 'skipped',
      reason: 'UNCONFIGURED',
    })
    expect(w.sent.map((s) => s.host)).toEqual(['api.groq.com'])
  })

  it('reports each provider and the failed job, and records it durably', async () => {
    const w = refreshWorld({ listing: { gemini: { status: 500, body: 'x' } } })
    await runDailyModelRefresh(w.deps)
    expect(w.ofType('MODEL_REFRESH_PROVIDER')).toEqual([
      {
        type: 'MODEL_REFRESH_PROVIDER',
        job: 'daily',
        provider: 'gemini',
        outcome: 'failed',
        reason: 'LISTING',
      },
      { type: 'MODEL_REFRESH_PROVIDER', job: 'daily', provider: 'groq', outcome: 'done' },
    ])
    expect(w.ofType('MODEL_REFRESH_FAILED')).toEqual([
      { type: 'MODEL_REFRESH_FAILED', job: 'daily' },
    ])
    expect(w.state.snapshot().failedJobs).toEqual(['daily'])
  })

  it('a clean run clears the durable failure', async () => {
    const w = refreshWorld({ listing: { gemini: { status: 500, body: 'x' } } })
    await runDailyModelRefresh(w.deps)
    w.net.listing.gemini = WITH_NEW
    const r = await runDailyModelRefresh(w.deps)
    expect(r.ok).toBe(true)
    expect(w.state.snapshot().failedJobs).toEqual([])
    expect(w.ofType('MODEL_REFRESH_FAILED')).toHaveLength(1)
  })

  it('MODEL_LIST_STALE clears when a refresh removes every entry it named', async () => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: setStaleModels('gemini', [G2])(EMPTY_ROUTE_STATE),
      chat: (s) => (s.model === G2 ? { status: 404, body: 'x' } : ALIVE),
    })
    await runDailyModelRefresh(w.deps)
    expect(w.state.snapshot().modelListStale).toEqual([])
  })

  it('a stale entry the refresh kept still warns, and the other provider is untouched', async () => {
    const stale = setStaleModels('groq', [Q1])(
      setStaleModels('gemini', [G1, G2])(EMPTY_ROUTE_STATE),
    )
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: stale,
      chat: (s) => (s.model === G2 ? { status: 404, body: 'x' } : ALIVE),
    })
    await runDailyModelRefresh(w.deps)
    expect(w.state.snapshot().modelListStale).toEqual([
      { provider: 'groq', model: Q1 },
      { provider: 'gemini', model: G1 },
    ])
  })

  it('a failed refresh leaves the stale warning', async () => {
    const stale = setStaleModels('gemini', [G1])(EMPTY_ROUTE_STATE)
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: stale,
      listing: { gemini: { status: 500, body: 'x' } },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.state.snapshot().modelListStale).toEqual(stale.modelListStale)
  })
})

describe('own-cap units (§5.1)', () => {
  it.each<[string, Reply, number]>([
    ['a dropped connection releases', 'network', 1],
    ['a 401 releases', { status: 401, body: 'x' }, 1],
    ['a 500 commits', { status: 500, body: 'x' }, 0],
    ['a good listing commits', groqListing([[Q1, 131_072]]), 0],
  ])('a listing: %s', async (_label, reply, released) => {
    const cap = countingCap()
    const w = refreshWorld({ cap, routes: GROQ_ONLY, listing: { groq: reply } })
    await runDailyModelRefresh(w.deps)
    expect(cap.reserved).toEqual(['groq'])
    expect(cap.released).toHaveLength(released)
    expect(cap.limits).toEqual([{ requestsPerDay: 1000 }])
  })

  it.each<[string, Reply, number, number]>([
    ['an alive answer commits and adds its tokens', ALIVE, 0, 10],
    [
      'a re-route commits and adds its tokens',
      answer({ ok: true }, { model: 'gemini-2.6-flash' }),
      0,
      10,
    ],
    ['a dropped connection releases', 'network', 1, 0],
    ['a 401 releases', { status: 401, body: 'x' }, 1, 0],
    [
      'a 404 naming the model releases',
      { status: 404, body: `{"error":{"message":"${G1}"}}` },
      1,
      0,
    ],
    ['a 429 commits', { status: 429, body: 'x' }, 0, 0],
    [
      'an answer without a usage block commits and adds nothing',
      {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        }),
      },
      0,
      0,
    ],
  ])('a probe: %s', async (_label, reply, released, tokens) => {
    const cap = countingCap()
    const w = refreshWorld({
      cap,
      routes: [{ ...GEMINI, models: [G1] }, LOCAL],
      listing: { gemini: geminiListing([[G1, BIG]]) },
      chat: () => reply,
    })
    await runDailyModelRefresh(w.deps)
    expect(cap.reserved).toEqual(['gemini', 'gemini'])
    expect(cap.released).toHaveLength(released)
    expect(cap.tokens).toBe(tokens)
  })
})

describe('the key', () => {
  it('goes to the provider in the headers only', async () => {
    const w = refreshWorld()
    await runDailyModelRefresh(w.deps)
    for (const s of w.sent) {
      expect(s.url).not.toContain(KEY_MARKER)
      expect(JSON.stringify(s.body)).not.toContain(KEY_MARKER)
    }
  })
})
